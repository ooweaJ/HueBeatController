using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;

// One bounded local worker. Analysis revisions and show edits remain separate.
internal static class OfflineAnalysisApi
{
    private sealed record Job(string Id, string Status, string Message, string? ProjectId = null, string? AnalysisId = null);

    public static void MapOfflineAnalysis(this WebApplication app)
    {
        var root = app.Environment.ContentRootPath;
        var python = Path.Combine(root, "tmp", "offline-analysis-venv", "Scripts", "python.exe");
        var model = Path.Combine(root, "tmp", "offline-models", "final0.ckpt");
        var jobs = new ConcurrentDictionary<string, Job>();
        var gate = new SemaphoreSlim(1, 1);
        var logger = app.Logger;

        app.MapGet("/api/offline-analysis/jobs/{id}", (string id, HttpResponse response) =>
        {
            response.Headers.CacheControl = "no-store";
            return jobs.TryGetValue(id, out var job) ? Results.Ok(job) : Results.NotFound();
        });
        app.MapPost("/api/offline-analysis/jobs", async (HttpRequest request) =>
        {
            if (request.Headers.TryGetValue("Origin", out var origin) && origin != $"{request.Scheme}://{request.Host}")
                return Results.StatusCode(403);
            if (!request.HasFormContentType) return Results.BadRequest(new { message = "음원 파일이 필요합니다." });
            if (!File.Exists(python) || !File.Exists(model))
                return Results.Json(new { message = "분석 환경이 없습니다. setup-offline-analysis.ps1을 먼저 실행하세요." }, statusCode: 503);
            if (!await gate.WaitAsync(0)) return Results.Conflict(new { message = "다른 음원을 분석 중입니다. 완료 후 다시 시도하세요." });
            string? upload = null;
            var launched = false;
            try
            {
                var form = await request.ReadFormAsync(request.HttpContext.RequestAborted);
                var file = form.Files.GetFile("audio");
                var extension = Path.GetExtension(file?.FileName ?? "").ToLowerInvariant();
                if (file is null || file.Length == 0 || file.Length > 512L * 1024 * 1024 ||
                    (extension != ".wav" && extension != ".mp3"))
                    return Results.BadRequest(new { message = "512MB 이하의 WAV 또는 MP3 음원을 선택하세요. 최대 길이는 10분입니다." });
                var id = Guid.NewGuid().ToString("N");
                upload = Path.Combine(root, "tmp", "offline-uploads", id);
                Directory.CreateDirectory(upload);
                var source = Path.Combine(upload, "source" + extension);
                await using (var stream = new FileStream(source, FileMode.CreateNew))
                    await file.CopyToAsync(stream, request.HttpContext.RequestAborted);
                var title = Path.GetFileName(file.FileName.Replace('\\', '/'));
                if (title.Length > 240) title = title[..240];
                // Retain a bounded number of completed jobs for browser polling.
                if (jobs.Count >= 32)
                    foreach (var old in jobs.Where(p => p.Value.Status != "running").Take(jobs.Count - 31)) jobs.TryRemove(old.Key, out _);
                var job = new Job(id, "running", "박자·마디 첫 박자와 소리 시작을 분석 중입니다. 최대 15분이 걸릴 수 있습니다.");
                jobs[id] = job;
                var folder = upload;
                _ = Task.Run(async () =>
                {
                    try
                    {
                        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(app.Lifetime.ApplicationStopping);
                        timeout.CancelAfter(TimeSpan.FromMinutes(15));
                        var report = Path.Combine(folder, "result.json");
                        var start = new ProcessStartInfo(python) { WorkingDirectory = root, UseShellExecute = false,
                            CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
                        foreach (var argument in new[] { Path.Combine(root, "tools", "offline", "run.py"), "analyze", source,
                            "--title", title, "--result-file", report }) start.ArgumentList.Add(argument);
                        start.Environment["PYTHONIOENCODING"] = "utf-8";
                        using var process = Process.Start(start) ?? throw new IOException("Could not start analysis worker");
                        var stdout = process.StandardOutput.ReadToEndAsync();
                        var stderr = process.StandardError.ReadToEndAsync();
                        try { await process.WaitForExitAsync(timeout.Token); }
                        finally
                        {
                            if (!process.HasExited) { process.Kill(entireProcessTree: true); await process.WaitForExitAsync(); }
                            await Task.WhenAll(stdout, stderr);
                        }
                        if (process.ExitCode != 0)
                        {
                            jobs[id] = job with { Status = "failed", Message = "분석에 실패했습니다. WAV/MP3 형식·10분 이하 길이와 분석 환경을 확인하세요. 기존 분석과 악보는 유지됩니다." };
                            LogFailure(logger, id, await stderr);
                            return;
                        }
                        using var result = JsonDocument.Parse(await File.ReadAllTextAsync(report));
                        var projectId = result.RootElement.GetProperty("projectId").GetString()!;
                        var analysisId = result.RootElement.GetProperty("analysisId").GetString()!;
                        if (!Regex.IsMatch(projectId, "\\A[0-9a-f]{64}\\z") || !Regex.IsMatch(analysisId, "\\A[0-9a-f]{32}\\z"))
                            throw new IOException("Invalid analysis worker result");
                        jobs[id] = job with { Status = "complete", Message = "박자·마디 첫 박자 분석을 저장했습니다.", ProjectId = projectId, AnalysisId = analysisId };
                    }
                    catch (OperationCanceledException)
                    { jobs[id] = job with { Status = "failed", Message = "분석 시간 초과 또는 서버 종료로 중지됐습니다. 기존 분석과 악보는 유지됩니다." }; }
                    catch (Exception ex)
                    {
                        jobs[id] = job with { Status = "failed", Message = "분석 작업을 완료하지 못했습니다. 서버 로그와 분석 환경을 확인하세요." };
                        LogFailure(logger, id, ex.Message, ex);
                    }
                    finally { Cleanup(folder); gate.Release(); }
                });
                launched = true;
                return Results.Accepted($"/api/offline-analysis/jobs/{id}", job);
            }
            catch (InvalidDataException) { return Results.BadRequest(new { message = "업로드 형식이나 크기가 올바르지 않습니다." }); }
            finally { if (!launched) { if (upload is not null) Cleanup(upload); gate.Release(); } }
        });
    }

    private static void LogFailure(ILogger logger, string id, string detail, Exception? exception = null)
    {
        try { logger.LogWarning(exception, "Offline analysis {Job} failed: {Detail}", id, detail); }
        // Restricted Windows accounts may not write EventLog. The job must still
        // reach a terminal state and release the worker slot if a logger fails.
        catch (AggregateException) { }
    }

    private static void Cleanup(string folder)
    {
        // Only files created by this job, never recursive deletion of user data.
        foreach (var name in new[] { "source.wav", "source.mp3", "result.json" })
            try { File.Delete(Path.Combine(folder, name)); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        try { Directory.Delete(folder, recursive: false); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}
