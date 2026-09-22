using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;

// Operator settings are independent of music settings. Visitors send only eight note levels.
internal sealed class PianoApi
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private static readonly string[] Colors = ["#ff3030", "#ff8800", "#ffdc00", "#20d35b", "#1688ff", "#3730b8", "#a53bff", "#ff3030"];
    private readonly Dictionary<int, EntertainmentSessionManager> sessions;
    private readonly ConcurrentDictionary<int, byte> required;
    private readonly SemaphoreSlim gate;
    private readonly Func<int, Task<List<HueLightInfo>>> readLights;
    private readonly string path;
    private string? token;
    private long lastFrame;
    private PianoSettings? current;
    private string[] areaLights = [];
    public bool HasSession => token is not null;

    internal PianoApi(WebApplication app, string directory, Dictionary<int, EntertainmentSessionManager> sessions,
        ConcurrentDictionary<int, byte> required, SemaphoreSlim gate, Func<int, Task<List<HueLightInfo>>> readLights)
    {
        (this.sessions, this.required, this.gate, this.readLights) = (sessions, required, gate, readLights);
        path = Path.Combine(directory, "piano-settings.json");
        app.MapGet("/api/piano/settings", () => Locked(async () => Results.Ok(await Load())));
        app.MapPut("/api/piano/settings", (PianoSettings settings) => Locked(async () =>
        {
            Validate(settings);
            var temporary = path + ".tmp";
            await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(settings, Json));
            File.Move(temporary, path, true);
            if (HasSession) await StopOwned();
            return Results.Ok(settings);
        }));
        app.MapGet("/api/piano/config", () => Locked(async () =>
        {
            var settings = await Load();
            return Results.Ok(new { settings.Enabled, settings.Sound, settings.Volume, Active = HasSession });
        }));
        app.MapPost("/api/piano/session", () => Locked(Start));
        app.MapPost("/api/piano/frame", (PianoFrame frame) => Locked(async () =>
        {
            if (token is null || frame.Token != token) return Results.Conflict(new { message = "연주 연결이 종료되었습니다. 다시 시작해 주세요." });
            if (frame.Levels is null || frame.Levels.Length != 8 || frame.Levels.Any(v => !double.IsFinite(v) || v < 0 || v > 1))
                return Results.BadRequest(new { message = "올바른 음계 밝기가 필요합니다." });
            lastFrame = Stopwatch.GetTimestamp();
            try { await Send(frame.Levels); }
            catch { await StopOwned(); throw; }
            return Results.Ok(new { ok = true });
        }));
        app.MapPost("/api/piano/stop", (PianoStop request) => Locked(async () =>
        {
            if (token is not null && request.Token == token) await StopOwned();
            return Results.Ok(new { ok = true });
        }));
        app.MapPost("/api/piano/operator-stop", () => Locked(async () =>
        {
            if (HasSession) await StopOwned();
            return Results.Ok(new { message = "피아노 연주 연결을 종료했습니다." });
        }));
        _ = Watchdog(app.Lifetime.ApplicationStopping);
    }

    private async Task<IResult> Locked(Func<Task<IResult>> action)
    {
        await gate.WaitAsync();
        try { return await action(); }
        catch (Exception e) when (e is InvalidOperationException or IOException or JsonException or HttpRequestException or TaskCanceledException)
        { return Results.BadRequest(new { message = e.Message }); }
        finally { gate.Release(); }
    }
    private async Task<PianoSettings> Load()
    {
        if (!File.Exists(path)) return new(false, true, [], new());
        return JsonSerializer.Deserialize<PianoSettings>(await File.ReadAllTextAsync(path), Json)
            ?? throw new InvalidOperationException("피아노 설정을 읽지 못했습니다.");
    }
    private static void Validate(PianoSettings value)
    {
        if (value.Assignments is null || value.Assignments.Count > 20 || value.ConfigurationIds is null
            || value.Assignments.Any(a => a is null || !Guid.TryParse(a.LightId, out _) || a.Note < 0 || a.Note > 7)
            || value.Assignments.Select(a => a.LightId).Distinct(StringComparer.OrdinalIgnoreCase).Count() != value.Assignments.Count
            || value.ConfigurationIds.Any(p => p.Key is not (1 or 2) || !Guid.TryParse(p.Value, out _)))
            throw new InvalidOperationException("전구별 음계와 Bridge 영역 설정을 확인하세요.");
        if (value.Volume is < 0 or > 100) throw new InvalidOperationException("피아노 음량은 0~100%로 지정하세요.");
        if (value.Enabled && value.Assignments.Count == 0) throw new InvalidOperationException("실제 출력에 사용할 전구의 음계를 먼저 지정하세요.");
        if (value.Enabled && value.ConfigurationIds.Count == 0) throw new InvalidOperationException("실제 출력에 사용할 Entertainment 영역을 선택하세요.");
    }
    private async Task<IResult> Start()
    {
        var settings = await Load(); Validate(settings);
        if (!settings.Enabled) return Results.Conflict(new { message = "지금은 화면과 소리로 연주할 수 있어요.", previewOnly = true });
        if (HasSession || sessions.Values.Any(s => s.IsActive))
            return Results.Conflict(new { message = "다른 연주가 진행 중이에요. 잠시 후 다시 시작해 주세요." });
        var allLights = new List<HueLightInfo>();
        foreach (var bridge in settings.ConfigurationIds.Keys) allLights.AddRange(await readLights(bridge));
        // Keep mappings for unselected Bridges in the saved settings, but do not require them for this session.
        var activeAssignments = settings.Assignments
            .Select(a => (Assignment: a, Light: allLights.FirstOrDefault(l => string.Equals(l.Id, a.LightId, StringComparison.OrdinalIgnoreCase))))
            .Where(item => item.Light is not null).ToArray();
        if (activeAssignments.Length == 0)
            throw new InvalidOperationException("선택한 Bridge 영역에서 음계가 지정된 전구를 찾지 못했습니다. 운영 설정을 확인하세요.");
        var assigned = activeAssignments.Select(item => item.Light!).ToArray();
        if (assigned.Any(l => !l.ColorCapable || l.Connectivity is not ("connected" or "unknown")))
            throw new InvalidOperationException("지정된 컬러 전구의 연결을 확인하세요.");
        var bridges = new List<EntertainmentBridgeSelection>(); var area = new List<string>();
        foreach (var bridge in assigned.Select(l => l.BridgeIndex).Distinct())
        {
            if (!settings.ConfigurationIds.TryGetValue(bridge, out var id)) throw new InvalidOperationException($"Bridge {bridge} 영역을 선택하세요.");
            var available = JsonSerializer.Deserialize<List<PianoArea>>(JsonSerializer.Serialize(await sessions[bridge].GetConfigurationsAsync(), Json), Json)!;
            var config = available.FirstOrDefault(c => c.Id == Guid.Parse(id));
            if (config is null || config.LightIds.Length is < 1 or > 10 || config.ChannelCount > 10
                || assigned.Where(l => l.BridgeIndex == bridge).Any(l => !config.LightIds.Contains(l.Id, StringComparer.OrdinalIgnoreCase)))
                throw new InvalidOperationException($"Bridge {bridge} 영역에 지정한 전구를 모두 포함하세요. 영역당 최대 10개입니다.");
            area.AddRange(config.LightIds); bridges.Add(new(bridge, config.Id));
        }
        try
        {
            required.Clear();
            await Task.WhenAll(sessions.Values.Select(s => s.StopAsync()));
            await Task.WhenAll(bridges.Select(b => sessions[b.BridgeIndex].StartAsync(b.ConfigurationId)));
            foreach (var bridge in bridges) required[bridge.BridgeIndex] = 0;
            current = settings with { Assignments = activeAssignments.Select(item => item.Assignment).ToList() };
            areaLights = area.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            token = Guid.NewGuid().ToString("N"); lastFrame = Stopwatch.GetTimestamp();
            await Send(new double[8]);
            return Results.Ok(new { token, settings.Sound, settings.Volume });
        }
        catch { await StopOwned(force: true); throw; }
    }
    private async Task Send(double[] levels)
    {
        if (required.IsEmpty || required.Keys.Any(i => !sessions[i].IsActive)) throw new InvalidOperationException("전구 연결이 끊겼습니다.");
        var mapping = current!.Assignments.ToDictionary(a => a.LightId, a => a.Note, StringComparer.OrdinalIgnoreCase);
        var commands = areaLights.Select(id =>
        {
            var assigned = mapping.TryGetValue(id, out var note);
            var brightness = assigned ? (int)Math.Round(levels[note] * 100) : 0;
            return new LightCommand([id], assigned ? Colors[note] : null, brightness, 0, brightness > 0);
        }).ToList();
        var results = await Task.WhenAll(required.Keys.Select(i => sessions[i].SendFrameAsync(commands, expireAfterMs: 1000)));
        if (results.Sum(r => r.UpdatedChannels) == 0 || results.Select(r => r.IgnoredLightIds.AsEnumerable())
            .Aggregate((a, b) => a.Intersect(b, StringComparer.OrdinalIgnoreCase)).Any())
            throw new InvalidOperationException("영역에서 전구를 제어하지 못했습니다.");
    }
    internal void ForgetSession() { token = null; current = null; areaLights = []; }
    private async Task StopOwned(bool force = false)
    {
        if (!HasSession && !force) return;
        try { if (current is not null) await Send(new double[8]); } catch { /* Individual stream expiry also clears stale light. */ }
        ForgetSession(); required.Clear();
        await Task.WhenAll(sessions.Values.Select(s => s.StopAsync()));
    }
    private async Task Watchdog(CancellationToken cancellation)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(500));
        try
        {
            while (await timer.WaitForNextTickAsync(cancellation))
            {
                await gate.WaitAsync(cancellation);
                try { if (HasSession && Stopwatch.GetElapsedTime(lastFrame).TotalSeconds > 2) await StopOwned(); }
                finally { gate.Release(); }
            }
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
    }
}
internal sealed record PianoSettings(bool Enabled, bool Sound, List<PianoAssignment> Assignments, Dictionary<int, string> ConfigurationIds)
{
    public int Volume { get; init; } = 50;
}
internal sealed record PianoAssignment(string LightId, int Note);
internal sealed record PianoFrame(string? Token, double[]? Levels);
internal sealed record PianoStop(string? Token);
internal sealed record PianoArea(Guid Id, string[] LightIds, int ChannelCount);
