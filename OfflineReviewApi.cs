using System.Text.Json;
using System.Text.RegularExpressions;
using System.Security.Cryptography;

// Analysis is read-only; show edits live separately. No legacy upgrades or Hue output.
internal static partial class OfflineReviewApi
{
    [GeneratedRegex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex ProjectIdPattern();
    [GeneratedRegex("^[0-9a-f]{32}$", RegexOptions.CultureInvariant)]
    private static partial Regex RevisionIdPattern();

    public static void MapOfflineReview(this WebApplication app, string dataDirectory)
    {
        var root = Path.Combine(dataDirectory, "offline-projects");
        app.MapGet("/api/offline-review/projects/{id}/analyses/{revision}/show", (string id, string revision, HttpResponse response) =>
        {
            response.Headers.CacheControl = "no-store";
            return ShowResult(root, id, revision, null);
        });
        app.MapPut("/api/offline-review/projects/{id}/analyses/{revision}/show", async (string id, string revision, HttpRequest request) =>
        {
            if (!request.HasJsonContentType()) return Results.BadRequest(new { message = "JSON 요청이 필요합니다." });
            // Reject cross-site browser writes even though this is a local-only controller.
            if (request.Headers.TryGetValue("Origin", out var origin) && origin != $"{request.Scheme}://{request.Host}")
                return Results.StatusCode(403);
            try
            {
                using var reader = new StreamReader(request.Body);
                var chars = new char[16385]; var length = await reader.ReadBlockAsync(chars.AsMemory());
                if (length > 16384) return Results.BadRequest(new { message = "연출 요청이 너무 큽니다." });
                var edit = JsonSerializer.Deserialize<ShowEdit>(new string(chars, 0, length), new JsonSerializerOptions(JsonSerializerDefaults.Web));
                return edit is null ? Results.BadRequest(new { message = "연출 데이터가 없습니다." }) : ShowResult(root, id, revision, edit);
            }
            catch (JsonException) { return Results.BadRequest(new { message = "연출 데이터 형식이 잘못되었습니다." }); }
        });
        app.MapGet("/api/offline-review/projects", () =>
        {
            var projects = new List<object>();
            if (!SafeDirectory(root)) return Results.Ok(projects);
            foreach (var project in Directory.EnumerateDirectories(root))
            {
                var id = Path.GetFileName(project);
                if (!ProjectIdPattern().IsMatch(id) || !SafeDirectory(project)) continue;
                try
                {
                    using var manifest = ReadJson(Path.Combine(project, "manifest.json"), 1024 * 1024);
                    var m = manifest.RootElement;
                    if (m.GetProperty("kind").GetString() != "offline-audio-project" ||
                        m.GetProperty("sourceHash").GetString() != id || !SafeFile(Path.Combine(project, "playback.wav"))) continue;
                    var revisions = new List<object>();
                    var analyses = Path.Combine(project, "analyses");
                    if (!SafeDirectory(analyses)) continue;
                    foreach (var revision in Directory.EnumerateDirectories(analyses).OrderByDescending(Directory.GetCreationTimeUtc))
                    {
                        var revisionId = Path.GetFileName(revision);
                        if (!RevisionIdPattern().IsMatch(revisionId) || !SafeDirectory(revision)) continue;
                        try
                        {
                            using var summary = ReadJson(Path.Combine(revision, "summary.json"), 1024 * 1024);
                            if (!SafeFile(Path.Combine(revision, "analysis.json")) ||
                                summary.RootElement.GetProperty("analysisId").GetString() != revisionId) continue;
                            revisions.Add(new { analysisId = revisionId, createdAt = Directory.GetCreationTimeUtc(revision),
                                candidates = summary.RootElement.GetProperty("candidates").Clone() });
                        }
                        catch (Exception ex) when (IsDataError(ex)) { /* Ignore unfinished/corrupt experiments. */ }
                    }
                    if (revisions.Count > 0) projects.Add(new { projectId = id,
                        title = DisplayTitle(dataDirectory, m.GetProperty("sourceFileName").GetString() ?? id), durationSec = m.GetProperty("durationSec").GetDouble(), revisions });
                }
                catch (Exception ex) when (IsDataError(ex)) { }
            }
            return Results.Ok(projects);
        });

        app.MapGet("/api/offline-review/projects/{id}/analyses/{revision}", (string id, string revision, HttpResponse response) =>
        {
            var project = ProjectPath(root, id);
            if (project is null || !RevisionIdPattern().IsMatch(revision)) return Results.NotFound();
            var analyses = Path.Combine(project, "analyses");
            var folder = Path.Combine(analyses, revision);
            if (!SafeDirectory(analyses) || !SafeDirectory(folder)) return Results.NotFound();
            try
            {
                using var manifest = ReadJson(Path.Combine(project, "manifest.json"), 1024 * 1024);
                using var doc = ReadJson(Path.Combine(folder, "analysis.json"), 64 * 1024 * 1024);
                var a = doc.RootElement;
                if (a.GetProperty("schemaVersion").GetInt32() != 1 || a.GetProperty("kind").GetString() != "offline-analysis" ||
                    a.GetProperty("analysisId").GetString() != revision || a.GetProperty("sourceHash").GetString() != id ||
                    a.GetProperty("playbackHash").GetString() != manifest.RootElement.GetProperty("playbackHash").GetString())
                    return Results.BadRequest(new { message = "분석과 공통 음원의 식별 정보가 다릅니다." });
                var features = a.GetProperty("features");
                if (!AudioMatches(project, manifest.RootElement.GetProperty("playbackHash").GetString()))
                    return Results.Conflict(new { message = "공통 음원이 분석 이후 변경되었습니다. 원본을 확인하세요." });
                response.Headers.CacheControl = "no-store";
                return Results.Ok(new { analysisId = revision, durationSec = a.GetProperty("durationSec").GetDouble(),
                    createdAt = a.GetProperty("createdAt").GetString(), playbackHash = a.GetProperty("playbackHash").GetString(),
                    candidates = a.GetProperty("candidates").Clone(),
                    waveform = new { timesSec = features.GetProperty("timesSec").Clone(),
                        rms = features.GetProperty("rms").Clone(), peak = features.GetProperty("peak").Clone(),
                        lowPower = features.GetProperty("lowPower").Clone(), midPower = features.GetProperty("midPower").Clone(),
                        highPower = features.GetProperty("highPower").Clone(), onsetStrength = features.GetProperty("onsetStrength").Clone() },
                    warnings = a.GetProperty("warnings").Clone() });
            }
            catch (Exception ex) when (IsDataError(ex))
            { return Results.BadRequest(new { message = "분석 파일이 없거나 손상되어 읽을 수 없습니다. 재분석 전 원본을 확인하세요." }); }
        });

        app.MapGet("/api/offline-review/projects/{id}/audio", (string id) =>
        {
            var project = ProjectPath(root, id);
            var audio = project is null ? null : Path.Combine(project, "playback.wav");
            if (audio is null || !SafeFile(audio)) return Results.NotFound();
            try
            {
                using var manifest = ReadJson(Path.Combine(project!, "manifest.json"), 1024 * 1024);
                if (!AudioMatches(project!, manifest.RootElement.GetProperty("playbackHash").GetString()))
                    return Results.Conflict(new { message = "공통 음원이 분석 이후 변경되었습니다." });
                return Results.File(audio, "audio/wav", enableRangeProcessing: true);
            }
            catch (Exception ex) when (IsDataError(ex)) { return Results.NotFound(); }
        });
    }

    private static IResult ShowResult(string root, string id, string revision, ShowEdit? edit)
    {
        var project = ProjectPath(root, id);
        if (project is null || !RevisionIdPattern().IsMatch(revision)) return Results.NotFound();
        var analyses = Path.Combine(project, "analyses");
        var folder = Path.Combine(analyses, revision);
        if (!SafeDirectory(analyses) || !SafeDirectory(folder) || !SafeFile(Path.Combine(folder, "summary.json"))) return Results.NotFound();
        try
        {
            using var manifest = ReadJson(Path.Combine(project, "manifest.json"), 1024 * 1024);
            using var analysis = ReadJson(Path.Combine(folder, "analysis.json"), 64 * 1024 * 1024);
            var a = analysis.RootElement; var m = manifest.RootElement;
            var hash = m.GetProperty("playbackHash").GetString()!;
            if (a.GetProperty("schemaVersion").GetInt32() != 1 || a.GetProperty("kind").GetString() != "offline-analysis" ||
                m.GetProperty("kind").GetString() != "offline-audio-project" || m.GetProperty("sourceHash").GetString() != id ||
                a.GetProperty("analysisId").GetString() != revision || a.GetProperty("sourceHash").GetString() != id ||
                a.GetProperty("playbackHash").GetString() != hash) return Results.Conflict(new { message = "분석과 음원의 식별 정보가 다릅니다." });
            var duration = a.GetProperty("durationSec").GetDouble();
            return Results.Ok(edit is null ? OfflineShowStore.Read(project, revision, hash, duration)
                : OfflineShowStore.Save(project, revision, hash, duration, edit));
        }
        catch (ShowConflictException) { return Results.Conflict(new { message = "다른 화면에서 먼저 저장했습니다. 저장본 불러오기 후 다시 편집하세요." }); }
        catch (ArgumentException ex) { return Results.BadRequest(new { message = ex.Message }); }
        catch (Exception ex) when (IsDataError(ex)) { return Results.BadRequest(new { message = "연출 데이터를 읽거나 저장하지 못했습니다. 기존 저장본은 덮어쓰지 않았습니다." }); }
    }

    private static string? ProjectPath(string root, string id)
    {
        if (!ProjectIdPattern().IsMatch(id) || !SafeDirectory(root)) return null;
        var path = Path.Combine(root, id);
        return SafeDirectory(path) ? path : null;
    }
    private static string DisplayTitle(string dataDirectory, string sourceName)
    {
        // Legacy metadata supplies only the display name, never analysis or an upgrade/write.
        var legacyId = Path.GetFileNameWithoutExtension(sourceName);
        var tracks = Path.Combine(dataDirectory, "tracks");
        if (!RevisionIdPattern().IsMatch(legacyId) || !SafeDirectory(tracks)) return sourceName;
        try
        {
            using var metadata = ReadJson(Path.Combine(tracks, legacyId + ".json"), 16 * 1024 * 1024);
            return metadata.RootElement.GetProperty("fileName").GetString() ?? sourceName;
        }
        catch (Exception ex) when (IsDataError(ex)) { return sourceName; }
    }
    private static bool SafeDirectory(string path) => Directory.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) == 0;
    private static bool SafeFile(string path) => File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) == 0;
    private static bool AudioMatches(string project, string? expected)
    {
        var path = Path.Combine(project, "playback.wav");
        if (expected is null || !SafeFile(path)) return false;
        using var stream = File.OpenRead(path);
        return string.Equals(Convert.ToHexString(SHA256.HashData(stream)), expected, StringComparison.OrdinalIgnoreCase);
    }
    private static JsonDocument ReadJson(string path, long limit)
    {
        if (!SafeFile(path) || new FileInfo(path).Length > limit) throw new IOException("Invalid review asset");
        using var stream = File.OpenRead(path);
        return JsonDocument.Parse(stream);
    }
    private static bool IsDataError(Exception ex) => ex is IOException or UnauthorizedAccessException or JsonException or KeyNotFoundException or InvalidOperationException or FormatException;
}
