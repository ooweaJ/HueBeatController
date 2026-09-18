using System.Net;
using System.Net.Http.Json;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http.Features;
using HueApi.ColorConverters;
using HueApi.Entertainment;
using HueApi.Entertainment.Extensions;
using HueApi.Entertainment.Models;
using HueApi.Extensions;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://127.0.0.1:5188");
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 512L * 1024 * 1024);
builder.Services.Configure<FormOptions>(options => options.MultipartBodyLengthLimit = 512L * 1024 * 1024);
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    options.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
});

var app = builder.Build();
app.UseDefaultFiles();
app.UseStaticFiles();

var dataDirectory = Path.Combine(app.Environment.ContentRootPath, "data");
var settingsPath = Path.Combine(dataDirectory, "hue-settings.json");
var controllerSettingsPath = Path.Combine(dataDirectory, "controller-settings.json");
var tracksDirectory = Path.Combine(dataDirectory, "tracks");
Directory.CreateDirectory(dataDirectory);
Directory.CreateDirectory(tracksDirectory);
app.MapOfflineReview(dataDirectory);
var settingsGate = new SemaphoreSlim(1, 1);
var controllerSettingsGate = new SemaphoreSlim(1, 1);
var tracksGate = new SemaphoreSlim(1, 1);
var lightTransferGate = new SemaphoreSlim(1, 1);
var lightBridgeIndex = new System.Collections.Concurrent.ConcurrentDictionary<string, int>(StringComparer.OrdinalIgnoreCase);
var storageJsonOptions = new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true };

async Task<HueSettings> LoadSettingsAsync()
{
    await settingsGate.WaitAsync();
    try
    {
        if (!File.Exists(settingsPath)) return new HueSettings();
        await using var stream = File.OpenRead(settingsPath);
        return await JsonSerializer.DeserializeAsync<HueSettings>(stream) ?? new HueSettings();
    }
    finally { settingsGate.Release(); }
}

async Task SaveSettingsAsync(HueSettings settings)
{
    await settingsGate.WaitAsync();
    try
    {
        await using var stream = File.Create(settingsPath);
        await JsonSerializer.SerializeAsync(stream, settings, new JsonSerializerOptions { WriteIndented = true });
    }
    finally { settingsGate.Release(); }
}

async Task<List<SavedTrack>> LoadSavedTracksUnsafeAsync()
{
    var tracks = new List<SavedTrack>();
    foreach (var metadataPath in Directory.EnumerateFiles(tracksDirectory, "*.json", SearchOption.TopDirectoryOnly))
    {
        try
        {
            await using var stream = File.OpenRead(metadataPath);
            var track = await JsonSerializer.DeserializeAsync<SavedTrack>(stream, storageJsonOptions);
            if (track is not null && Guid.TryParse(track.Id, out _)
                && File.Exists(Path.Combine(tracksDirectory, track.StoredFileName)))
                tracks.Add(track);
        }
        catch (Exception ex) when (ex is IOException or JsonException) { }
    }
    return tracks.OrderByDescending(track => track.CreatedAt).ToList();
}

static string AudioContentType(string extension) => extension.ToLowerInvariant() switch
{
    ".wav" => "audio/wav",
    ".mp3" => "audio/mpeg",
    ".m4a" => "audio/mp4",
    ".aac" => "audio/aac",
    ".ogg" => "audio/ogg",
    ".flac" => "audio/flac",
    ".webm" => "audio/webm",
    _ => "application/octet-stream"
};

async Task<HueBridgeSettings> LoadBridgeSettingsAsync(int bridgeIndex)
    => (await LoadSettingsAsync()).GetBridge(bridgeIndex);

var entertainmentSessions = new Dictionary<int, EntertainmentSessionManager>
{
    [1] = new EntertainmentSessionManager(() => LoadBridgeSettingsAsync(1), 1),
    [2] = new EntertainmentSessionManager(() => LoadBridgeSettingsAsync(2), 2)
};
var requiredEntertainmentBridges = new System.Collections.Concurrent.ConcurrentDictionary<int, byte>();
var ledFx = new LedFxBridge(app.Environment.ContentRootPath);
app.Lifetime.ApplicationStopping.Register(ledFx.Dispose);
app.MapGet("/api/ledfx/status", () => ledFx.Status());
app.MapGet("/api/ledfx/frame", () => ledFx.Frame());
app.MapPost("/api/ledfx/start", async () =>
{
    try { await ledFx.Start(); return Results.Ok(new { message = "LedFx 시작 요청 완료" }); }
    catch (Exception ex) { return Results.BadRequest(new { message = ex.Message }); }
});
app.MapPost("/api/ledfx/configure", async (LedFxConfigureRequest request) =>
{
    try { return Results.Ok(await ledFx.Configure(request.Pairs, request.Effect, request.Client)); }
    catch (Exception ex) { return Results.BadRequest(new { message = ex.Message }); }
});
app.MapPost("/api/ledfx/clear", async () =>
{
    try { await ledFx.Clear(); return Results.Ok(); }
    catch (Exception ex) { return Results.BadRequest(new { message = ex.Message }); }
});
var groupedAllGate = new SemaphoreSlim(1, 1);
string? groupedAllBridgeIp = null;
string? groupedAllResourceId = null;
HashSet<string> groupedAllLightIds = [];
var musicGroupGate = new SemaphoreSlim(1, 1);
string? musicGroupBridgeIp = null;
Dictionary<string, string> musicGroupIdBySignature = [];
var musicSceneGate = new SemaphoreSlim(1, 1);
string? musicSceneBridgeIp = null;
string? musicSceneSignature = null;
List<string> musicSceneIds = [];

async Task<(string? ResourceId, HashSet<string> LightIds)> LoadGroupedAllAsync(HueSettings settings, HttpClient client)
{
    await groupedAllGate.WaitAsync();
    try
    {
        if (groupedAllBridgeIp == settings.BridgeIp && !string.IsNullOrWhiteSpace(groupedAllResourceId))
            return (groupedAllResourceId, new HashSet<string>(groupedAllLightIds));

        var groupedRequest = client.GetAsync("/clip/v2/resource/grouped_light");
        var lightRequest = client.GetAsync("/clip/v2/resource/light");
        await Task.WhenAll(groupedRequest, lightRequest);
        if (!groupedRequest.Result.IsSuccessStatusCode || !lightRequest.Result.IsSuccessStatusCode)
            return (null, []);

        var groupedRoot = await groupedRequest.Result.Content.ReadFromJsonAsync<JsonElement>();
        var lightRoot = await lightRequest.Result.Content.ReadFromJsonAsync<JsonElement>();
        groupedAllResourceId = groupedRoot.GetProperty("data").EnumerateArray()
            .Where(item => item.TryGetProperty("owner", out var owner)
                && owner.TryGetProperty("rtype", out var type)
                && type.GetString() == "bridge_home")
            .Select(item => item.TryGetProperty("id", out var id) ? id.GetString() : null)
            .FirstOrDefault(id => !string.IsNullOrWhiteSpace(id));
        groupedAllLightIds = lightRoot.GetProperty("data").EnumerateArray()
            .Select(item => item.TryGetProperty("id", out var lightId) ? lightId.GetString() : null)
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Select(id => id!)
            .ToHashSet();
        groupedAllBridgeIp = settings.BridgeIp;
        return (groupedAllResourceId, new HashSet<string>(groupedAllLightIds));
    }
    finally { groupedAllGate.Release(); }
}

async Task<List<(LightCommand Command, string GroupId)>> PrepareMusicGroupsAsync(
    HueSettings settings, HttpClient client, IReadOnlyList<LightCommand> commands)
{
    await musicGroupGate.WaitAsync();
    try
    {
        if (musicGroupBridgeIp != settings.BridgeIp)
        {
            musicGroupBridgeIp = settings.BridgeIp;
            musicGroupIdBySignature.Clear();
        }

        var requested = commands.Select((command, index) =>
        {
            var groupKey = string.IsNullOrWhiteSpace(command.GroupKey) ? $"group-{index + 1}" : command.GroupKey;
            var shortKey = new string(groupKey.Where(char.IsLetterOrDigit).Take(12).ToArray());
            if (string.IsNullOrWhiteSpace(shortKey)) shortKey = $"G{index + 1}";
            var groupName = $"HueBeat-{shortKey}";
            var lightIds = command.LightIds.Distinct().OrderBy(id => id).ToArray();
            return new { Command = command, GroupName = groupName, LightIds = lightIds, Signature = $"{groupName}:{string.Join(',', lightIds)}" };
        }).ToArray();
        if (requested.All(item => musicGroupIdBySignature.ContainsKey(item.Signature)))
            return requested.Select(item => (item.Command, musicGroupIdBySignature[item.Signature])).ToList();

        var zonesRequest = client.GetAsync("/clip/v2/resource/zone");
        var groupedRequest = client.GetAsync("/clip/v2/resource/grouped_light");
        await Task.WhenAll(zonesRequest, groupedRequest);
        if (!zonesRequest.Result.IsSuccessStatusCode || !groupedRequest.Result.IsSuccessStatusCode)
            throw new InvalidOperationException("Bridge의 Zone 그룹 정보를 가져오지 못했습니다.");
        var zonesRoot = await zonesRequest.Result.Content.ReadFromJsonAsync<JsonElement>();
        var groupedRoot = await groupedRequest.Result.Content.ReadFromJsonAsync<JsonElement>();
        var zones = zonesRoot.GetProperty("data").EnumerateArray().Select(zone => new
        {
            Id = zone.GetProperty("id").GetString()!,
            Name = zone.TryGetProperty("metadata", out var metadata) && metadata.TryGetProperty("name", out var name) ? name.GetString() ?? "" : "",
            Lights = zone.TryGetProperty("children", out var children)
                ? children.EnumerateArray().Where(child => child.TryGetProperty("rtype", out var type) && type.GetString() == "light")
                    .Select(child => child.GetProperty("rid").GetString()!).OrderBy(id => id).ToArray()
                : []
        }).ToList();
        var groupedByZone = groupedRoot.GetProperty("data").EnumerateArray()
            .Where(group => group.TryGetProperty("owner", out var owner)
                && owner.TryGetProperty("rtype", out var type) && type.GetString() == "zone")
            .ToDictionary(group => group.GetProperty("owner").GetProperty("rid").GetString()!, group => group.GetProperty("id").GetString()!);
        var prepared = new List<(LightCommand Command, string GroupId)>();

        foreach (var item in requested)
        {
            if (musicGroupIdBySignature.TryGetValue(item.Signature, out var cachedGroupId))
            {
                prepared.Add((item.Command, cachedGroupId));
                continue;
            }

            var zone = zones.FirstOrDefault(candidate => candidate.Name == item.GroupName)
                ?? zones.FirstOrDefault(candidate => candidate.Name.StartsWith("HueBeat-", StringComparison.Ordinal)
                    && candidate.Lights.SequenceEqual(item.LightIds));
            string? zoneId = zone?.Id;
            var children = item.LightIds.Select(id => new { rid = id, rtype = "light" }).ToArray();
            if (zone is not null && (zone.Name != item.GroupName || !zone.Lights.SequenceEqual(item.LightIds)))
            {
                using var updateResponse = await client.PutAsJsonAsync($"/clip/v2/resource/zone/{Uri.EscapeDataString(zone.Id)}",
                    new { children, metadata = new { name = item.GroupName, archetype = "other" } });
                var updateRoot = await updateResponse.Content.ReadFromJsonAsync<JsonElement>();
                if (!updateResponse.IsSuccessStatusCode || updateRoot.GetProperty("errors").GetArrayLength() > 0)
                    throw new InvalidOperationException($"{item.GroupName} Zone 구성을 갱신하지 못했습니다.");
            }
            if (string.IsNullOrWhiteSpace(zoneId))
            {
                using var createResponse = await client.PostAsJsonAsync("/clip/v2/resource/zone",
                    new { children, metadata = new { name = item.GroupName, archetype = "other" } });
                var createRoot = await createResponse.Content.ReadFromJsonAsync<JsonElement>();
                if (!createResponse.IsSuccessStatusCode || createRoot.GetProperty("errors").GetArrayLength() > 0
                    || createRoot.GetProperty("data").GetArrayLength() == 0)
                    throw new InvalidOperationException($"{item.GroupName} Zone을 Bridge에 만들지 못했습니다.");
                zoneId = createRoot.GetProperty("data")[0].GetProperty("rid").GetString();
            }

            if (string.IsNullOrWhiteSpace(zoneId)) throw new InvalidOperationException($"{item.GroupName} Zone ID가 없습니다.");
            if (!groupedByZone.TryGetValue(zoneId, out var groupId))
            {
                for (var attempt = 0; attempt < 4 && string.IsNullOrWhiteSpace(groupId); attempt++)
                {
                    await Task.Delay(80 * (attempt + 1));
                    var refreshResponse = await client.GetAsync("/clip/v2/resource/grouped_light");
                    var refreshRoot = await refreshResponse.Content.ReadFromJsonAsync<JsonElement>();
                    groupId = refreshRoot.GetProperty("data").EnumerateArray()
                        .Where(group => group.TryGetProperty("owner", out var owner) && owner.GetProperty("rid").GetString() == zoneId)
                        .Select(group => group.GetProperty("id").GetString()).FirstOrDefault();
                }
            }
            if (string.IsNullOrWhiteSpace(groupId)) throw new InvalidOperationException($"{item.GroupName}의 grouped_light를 찾지 못했습니다.");
            musicGroupIdBySignature[item.Signature] = groupId;
            prepared.Add((item.Command, groupId));
        }

        return prepared;
    }
    finally { musicGroupGate.Release(); }
}

async Task<List<string>> PrepareMusicScenesAsync(
    HueSettings settings, HttpClient client, IReadOnlyList<ControlRequest> frames)
{
    await musicSceneGate.WaitAsync();
    try
    {
        if (frames.Count == 0 || frames.Any(frame => frame.Commands.Count == 0))
            throw new InvalidOperationException("Scene으로 준비할 색상 프레임이 없습니다.");

        if (musicSceneBridgeIp != settings.BridgeIp)
        {
            musicSceneBridgeIp = settings.BridgeIp;
            musicSceneSignature = null;
            musicSceneIds = [];
        }

        var allLightIds = frames.SelectMany(frame => frame.Commands)
            .SelectMany(command => command.LightIds).Distinct().OrderBy(id => id).ToArray();
        if (allLightIds.Length == 0)
            throw new InvalidOperationException("Scene에 포함할 전구가 없습니다.");

        var signature = string.Join("|", frames.Select(frame => string.Join(";", frame.Commands.Select(command =>
            $"{command.GroupKey}:{string.Join(',', command.LightIds.Distinct().OrderBy(id => id))}:{command.HexColor}:{command.Brightness:F2}:{command.On}"))));
        if (musicSceneSignature == signature && musicSceneIds.Count == frames.Count)
            return [.. musicSceneIds];

        using var zonesResponse = await client.GetAsync("/clip/v2/resource/zone");
        var zonesRoot = await zonesResponse.Content.ReadFromJsonAsync<JsonElement>();
        if (!zonesResponse.IsSuccessStatusCode || zonesRoot.GetProperty("errors").GetArrayLength() > 0)
            throw new InvalidOperationException("Bridge의 Zone 정보를 가져오지 못했습니다.");

        var zone = zonesRoot.GetProperty("data").EnumerateArray()
            .Where(item => item.TryGetProperty("metadata", out var metadata)
                && metadata.TryGetProperty("name", out var name) && name.GetString() == "HueBeat-Show")
            .Select(item => new
            {
                Id = item.GetProperty("id").GetString()!,
                Lights = item.TryGetProperty("children", out var children)
                    ? children.EnumerateArray().Where(child => child.GetProperty("rtype").GetString() == "light")
                        .Select(child => child.GetProperty("rid").GetString()!).OrderBy(id => id).ToArray()
                    : []
            }).FirstOrDefault();

        var zoneChildren = allLightIds.Select(id => new { rid = id, rtype = "light" }).ToArray();
        string? zoneId = zone?.Id;
        if (zone is not null && !zone.Lights.SequenceEqual(allLightIds))
        {
            using var updateZoneResponse = await client.PutAsJsonAsync($"/clip/v2/resource/zone/{Uri.EscapeDataString(zone.Id)}",
                new { children = zoneChildren, metadata = new { name = "HueBeat-Show", archetype = "other" } });
            var updateZoneRoot = await updateZoneResponse.Content.ReadFromJsonAsync<JsonElement>();
            if (!updateZoneResponse.IsSuccessStatusCode || updateZoneRoot.GetProperty("errors").GetArrayLength() > 0)
                throw new InvalidOperationException("HueBeat-Show Zone 구성을 갱신하지 못했습니다.");
        }
        if (string.IsNullOrWhiteSpace(zoneId))
        {
            using var createZoneResponse = await client.PostAsJsonAsync("/clip/v2/resource/zone",
                new { children = zoneChildren, metadata = new { name = "HueBeat-Show", archetype = "other" } });
            var createZoneRoot = await createZoneResponse.Content.ReadFromJsonAsync<JsonElement>();
            if (!createZoneResponse.IsSuccessStatusCode || createZoneRoot.GetProperty("errors").GetArrayLength() > 0
                || createZoneRoot.GetProperty("data").GetArrayLength() == 0)
                throw new InvalidOperationException("HueBeat-Show Zone을 만들지 못했습니다.");
            zoneId = createZoneRoot.GetProperty("data")[0].GetProperty("rid").GetString();
        }
        if (string.IsNullOrWhiteSpace(zoneId))
            throw new InvalidOperationException("HueBeat-Show Zone ID가 없습니다.");

        using var scenesResponse = await client.GetAsync("/clip/v2/resource/scene");
        var scenesRoot = await scenesResponse.Content.ReadFromJsonAsync<JsonElement>();
        if (!scenesResponse.IsSuccessStatusCode || scenesRoot.GetProperty("errors").GetArrayLength() > 0)
            throw new InvalidOperationException("Bridge의 Scene 정보를 가져오지 못했습니다.");
        var existingScenes = scenesRoot.GetProperty("data").EnumerateArray()
            .Where(item => item.TryGetProperty("metadata", out var metadata)
                && metadata.TryGetProperty("name", out var name) && name.GetString()!.StartsWith("HueBeat-", StringComparison.Ordinal))
            .Select(item => new
            {
                Id = item.GetProperty("id").GetString()!,
                Name = item.GetProperty("metadata").GetProperty("name").GetString()!,
                GroupId = item.TryGetProperty("group", out var group) ? group.GetProperty("rid").GetString() : null
            }).ToArray();

        var preparedSceneIds = new List<string>();
        for (var index = 0; index < frames.Count; index++)
        {
            var frame = frames[index];
            var sceneName = $"HueBeat-{index + 1:00}";
            var actions = frame.Commands.SelectMany(command => command.LightIds.Distinct().Select(lightId =>
            {
                var state = new Dictionary<string, object>
                {
                    ["on"] = new { on = command.On ?? true },
                    ["dimming"] = new { brightness = Math.Clamp(command.Brightness, 0.1, 100) }
                };
                if (!string.IsNullOrWhiteSpace(command.HexColor))
                {
                    var (x, y) = ColorConverter.HexToXy(command.HexColor);
                    state["color"] = new { xy = new { x, y } };
                }
                return new { target = new { rid = lightId, rtype = "light" }, action = state };
            })).ToArray();

            var existing = existingScenes.FirstOrDefault(scene => scene.Name == sceneName && scene.GroupId == zoneId);
            string? sceneId = existing?.Id;
            if (existing is not null)
            {
                using var updateSceneResponse = await client.PutAsJsonAsync($"/clip/v2/resource/scene/{Uri.EscapeDataString(existing.Id)}",
                    new { actions, metadata = new { name = sceneName } });
                var updateSceneRoot = await updateSceneResponse.Content.ReadFromJsonAsync<JsonElement>();
                if (!updateSceneResponse.IsSuccessStatusCode || updateSceneRoot.GetProperty("errors").GetArrayLength() > 0)
                    throw new InvalidOperationException($"{sceneName} Scene을 갱신하지 못했습니다.");
            }
            else
            {
                using var createSceneResponse = await client.PostAsJsonAsync("/clip/v2/resource/scene",
                    new { actions, metadata = new { name = sceneName }, group = new { rid = zoneId, rtype = "zone" } });
                var createSceneRoot = await createSceneResponse.Content.ReadFromJsonAsync<JsonElement>();
                if (!createSceneResponse.IsSuccessStatusCode || createSceneRoot.GetProperty("errors").GetArrayLength() > 0
                    || createSceneRoot.GetProperty("data").GetArrayLength() == 0)
                    throw new InvalidOperationException($"{sceneName} Scene을 만들지 못했습니다.");
                sceneId = createSceneRoot.GetProperty("data")[0].GetProperty("rid").GetString();
            }
            if (string.IsNullOrWhiteSpace(sceneId))
                throw new InvalidOperationException($"{sceneName} Scene ID가 없습니다.");
            preparedSceneIds.Add(sceneId);
        }

        musicSceneSignature = signature;
        musicSceneIds = preparedSceneIds;
        return [.. musicSceneIds];
    }
    finally { musicSceneGate.Release(); }
}

static bool IsAllowedBridgeAddress(string input, out string normalized)
{
    normalized = input.Trim();
    if (!IPAddress.TryParse(normalized, out var address)) return false;
    if (IPAddress.IsLoopback(address)) return false;
    var bytes = address.GetAddressBytes();
    if (address.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork) return false;
    return bytes[0] == 10
        || (bytes[0] == 172 && bytes[1] is >= 16 and <= 31)
        || (bytes[0] == 192 && bytes[1] == 168)
        || (bytes[0] == 169 && bytes[1] == 254);
}

static HttpClient CreateBridgeClient(string bridgeIp, string? applicationKey = null, TimeSpan? timeout = null)
{
    var handler = new HttpClientHandler
    {
        ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator
    };
    var client = new HttpClient(handler)
    {
        BaseAddress = new Uri($"https://{bridgeIp}"),
        Timeout = timeout ?? TimeSpan.FromSeconds(5)
    };
    if (!string.IsNullOrWhiteSpace(applicationKey)) client.DefaultRequestHeaders.Add("hue-application-key", applicationKey);
    return client;
}

static string? HueV1Error(JsonElement response)
{
    if (response.ValueKind != JsonValueKind.Array) return "Bridge 응답 형식이 올바르지 않습니다.";
    foreach (var item in response.EnumerateArray())
    {
        if (item.TryGetProperty("error", out var error)
            && error.TryGetProperty("description", out var description))
            return description.GetString() ?? "알 수 없는 Bridge 오류";
    }
    return null;
}

async Task<BridgeStatus> ReadBridgeStatusAsync(int bridgeIndex, HueBridgeSettings bridge)
{
    var paired = bridge.IsPaired;
    var online = false;
    if (paired)
    {
        try
        {
            using var client = CreateBridgeClient(bridge.BridgeIp!, bridge.ApplicationKey);
            var response = await client.GetAsync("/clip/v2/resource/bridge");
            online = response.IsSuccessStatusCode;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException) { }
    }
    return new BridgeStatus(bridgeIndex, bridge.BridgeIp, paired, online);
}

async Task<List<HueLightInfo>> ReadBridgeLightsAsync(int bridgeIndex, HueBridgeSettings bridge)
{
    if (!bridge.IsPaired) return [];
    using var client = CreateBridgeClient(bridge.BridgeIp!, bridge.ApplicationKey);
    var lightRequest = client.GetAsync("/clip/v2/resource/light");
    var deviceRequest = client.GetAsync("/clip/v2/resource/device");
    var connectivityRequest = client.GetAsync("/clip/v2/resource/zigbee_connectivity");
    await Task.WhenAll(lightRequest, deviceRequest, connectivityRequest);
    var response = await lightRequest;
    response.EnsureSuccessStatusCode();
    var root = await response.Content.ReadFromJsonAsync<JsonElement>();

    var nameByDevice = new Dictionary<string, string>();
    var deviceResponse = await deviceRequest;
    if (deviceResponse.IsSuccessStatusCode)
    {
        var deviceRoot = await deviceResponse.Content.ReadFromJsonAsync<JsonElement>();
        foreach (var item in deviceRoot.GetProperty("data").EnumerateArray())
        {
            if (!item.TryGetProperty("id", out var id)
                || !item.TryGetProperty("metadata", out var metadata)
                || !metadata.TryGetProperty("name", out var name)) continue;
            var deviceId = id.GetString();
            var deviceName = name.GetString();
            if (!string.IsNullOrWhiteSpace(deviceId) && !string.IsNullOrWhiteSpace(deviceName))
                nameByDevice[deviceId] = deviceName;
        }
    }

    var connectivityByDevice = new Dictionary<string, string>();
    var connectivityResponse = await connectivityRequest;
    if (connectivityResponse.IsSuccessStatusCode)
    {
        var connectivityRoot = await connectivityResponse.Content.ReadFromJsonAsync<JsonElement>();
        foreach (var item in connectivityRoot.GetProperty("data").EnumerateArray())
        {
            if (!item.TryGetProperty("owner", out var owner) || !owner.TryGetProperty("rid", out var rid)
                || !item.TryGetProperty("status", out var status)) continue;
            var deviceId = rid.GetString();
            if (!string.IsNullOrWhiteSpace(deviceId)) connectivityByDevice[deviceId] = status.GetString() ?? "unknown";
        }
    }

    return root.GetProperty("data").EnumerateArray().Select(light => new HueLightInfo(
        light.GetProperty("id").GetString() ?? "",
        light.TryGetProperty("owner", out var nameOwner)
            && nameOwner.TryGetProperty("rid", out var nameOwnerRid)
            && nameByDevice.TryGetValue(nameOwnerRid.GetString() ?? "", out var deviceName)
                ? deviceName
                : light.TryGetProperty("metadata", out var metadata) && metadata.TryGetProperty("name", out var name)
                    ? name.GetString() ?? "Hue 조명"
                    : "Hue 조명",
        light.TryGetProperty("on", out var on) && on.TryGetProperty("on", out var onValue) && onValue.GetBoolean(),
        light.TryGetProperty("dimming", out var dimming) && dimming.TryGetProperty("brightness", out var brightness) ? brightness.GetDouble() : 100,
        light.TryGetProperty("color", out _),
        light.TryGetProperty("owner", out var lightOwner)
            && lightOwner.TryGetProperty("rid", out var ownerRid)
            && connectivityByDevice.TryGetValue(ownerRid.GetString() ?? "", out var status)
                ? status
                : "unknown",
        bridgeIndex,
        $"Bridge {bridgeIndex}"
    )).Where(light => !string.IsNullOrWhiteSpace(light.Id)).ToList();
}

async Task<Dictionary<string, HueLegacyLight>> ReadLegacyLightsAsync(HttpClient client, HueBridgeSettings bridge)
{
    using var response = await client.GetAsync($"/api/{Uri.EscapeDataString(bridge.ApplicationKey!)}/lights");
    response.EnsureSuccessStatusCode();
    var root = await response.Content.ReadFromJsonAsync<JsonElement>();
    if (root.ValueKind != JsonValueKind.Object) throw new JsonException("Bridge 전구 목록 형식이 올바르지 않습니다.");
    return root.EnumerateObject().ToDictionary(
        item => item.Name,
        item => new HueLegacyLight(
            item.Value.TryGetProperty("name", out var name) ? name.GetString() ?? "Hue 조명" : "Hue 조명",
            item.Value.TryGetProperty("uniqueid", out var uniqueId) ? uniqueId.GetString() : null),
        StringComparer.OrdinalIgnoreCase);
}

async Task<string?> ResolveV2LightIdAsync(HttpClient client, string legacyLightId)
{
    for (var attempt = 0; attempt < 15; attempt++)
    {
        using var response = await client.GetAsync("/clip/v2/resource/light");
        if (response.IsSuccessStatusCode)
        {
            var root = await response.Content.ReadFromJsonAsync<JsonElement>();
            if (root.TryGetProperty("data", out var data))
            {
                var expected = $"/lights/{legacyLightId}";
                foreach (var light in data.EnumerateArray())
                    if (light.TryGetProperty("id_v1", out var idV1)
                        && string.Equals(idV1.GetString(), expected, StringComparison.OrdinalIgnoreCase)
                        && light.TryGetProperty("id", out var id))
                        return id.GetString();
            }
        }
        await Task.Delay(500);
    }
    return null;
}

async Task<List<LightControlResult>> SendControlCommandsAsync(HueBridgeSettings bridge, IReadOnlyList<LightCommand> commands)
{
    using var client = CreateBridgeClient(bridge.BridgeIp!, bridge.ApplicationKey);
    var distinctIdsByCommand = commands
        .Select(command => (Command: command, LightIds: command.LightIds.Distinct(StringComparer.OrdinalIgnoreCase).ToArray()))
        .Where(item => item.LightIds.Length > 0)
        .ToArray();
    var work = new List<(LightCommand Command, string LightId)>();
    var longestGroup = distinctIdsByCommand.Length == 0 ? 0 : distinctIdsByCommand.Max(item => item.LightIds.Length);
    for (var lightIndex = 0; lightIndex < longestGroup; lightIndex++)
        foreach (var item in distinctIdsByCommand)
            if (lightIndex < item.LightIds.Length) work.Add((item.Command, item.LightIds[lightIndex]));

    using var sendSlots = new SemaphoreSlim(4);
    var jobs = work.Select(async item =>
    {
        await sendSlots.WaitAsync();
        try
        {
            var command = item.Command;
            var body = new Dictionary<string, object>
            {
                ["on"] = new { on = command.On ?? true },
                ["dimming"] = new { brightness = Math.Clamp(command.Brightness, 0.1, 100) },
                ["dynamics"] = new { duration = Math.Clamp(command.TransitionMs, 0, 60000) }
            };
            if (!string.IsNullOrWhiteSpace(command.HexColor))
            {
                var (x, y) = ColorConverter.HexToXy(command.HexColor);
                body["color"] = new { xy = new { x, y } };
            }
            var status = 0;
            for (var attempt = 0; attempt < 4; attempt++)
            {
                using var response = await client.PutAsJsonAsync($"/clip/v2/resource/light/{Uri.EscapeDataString(item.LightId)}", body);
                status = (int)response.StatusCode;
                if (status != StatusCodes.Status429TooManyRequests)
                    return new LightControlResult(item.LightId, response.IsSuccessStatusCode, status);
                await Task.Delay(70 * (attempt + 1));
            }
            return new LightControlResult(item.LightId, false, status);
        }
        finally { sendSlots.Release(); }
    });
    return [.. await Task.WhenAll(jobs)];
}

app.MapGet("/api/status", async () =>
{
    var settings = await LoadSettingsAsync();
    var bridges = await Task.WhenAll(Enumerable.Range(1, 2)
        .Select(index => ReadBridgeStatusAsync(index, settings.GetBridge(index))));
    var primary = bridges[0];
    return Results.Ok(new
    {
        primary.BridgeIp,
        primary.Paired,
        BridgeOnline = primary.Online,
        Bridges = bridges
    });
});

app.MapGet("/api/controller-settings", async () =>
{
    await controllerSettingsGate.WaitAsync();
    try
    {
        if (!File.Exists(controllerSettingsPath)) return Results.Ok(new { exists = false });
        await using var stream = File.OpenRead(controllerSettingsPath);
        using var document = await JsonDocument.ParseAsync(stream);
        return Results.Ok(new { exists = true, settings = document.RootElement.Clone() });
    }
    catch (JsonException)
    {
        return Results.BadRequest(new { message = "저장된 제어 설정 파일을 읽지 못했습니다." });
    }
    finally { controllerSettingsGate.Release(); }
});

app.MapPut("/api/controller-settings", async (JsonElement settings) =>
{
    if (settings.ValueKind != JsonValueKind.Object)
        return Results.BadRequest(new { message = "올바른 제어 설정 형식이 아닙니다." });
    var json = JsonSerializer.Serialize(settings, new JsonSerializerOptions { WriteIndented = true });
    if (json.Length > 1_000_000)
        return Results.BadRequest(new { message = "제어 설정 데이터가 너무 큽니다." });

    await controllerSettingsGate.WaitAsync();
    try
    {
        var temporaryPath = controllerSettingsPath + ".tmp";
        await File.WriteAllTextAsync(temporaryPath, json);
        File.Move(temporaryPath, controllerSettingsPath, true);
        return Results.Ok(new { message = "제어 설정을 파일에 저장했습니다." });
    }
    finally { controllerSettingsGate.Release(); }
});

app.MapGet("/api/tracks", async () =>
{
    await tracksGate.WaitAsync();
    try { return Results.Ok(await LoadSavedTracksUnsafeAsync()); }
    finally { tracksGate.Release(); }
});

app.MapPut("/api/tracks/{id}/analysis", async (string id, JsonElement analysis) =>
{
    if (!Guid.TryParseExact(id, "N", out _) || analysis.ValueKind != JsonValueKind.Object
        || !analysis.TryGetProperty("duration", out var duration) || duration.GetDouble() <= 0
        || !analysis.TryGetProperty("beatTimes", out var cues) || cues.ValueKind != JsonValueKind.Array)
        return Results.BadRequest(new { message = "올바른 음악 분석 데이터가 아닙니다." });
    var analysisJson = JsonSerializer.Serialize(analysis);
    if (analysisJson.Length > 10_000_000)
        return Results.BadRequest(new { message = "음악 분석 데이터가 너무 큽니다." });

    await tracksGate.WaitAsync();
    try
    {
        var metadataPath = Path.Combine(tracksDirectory, id + ".json");
        if (!File.Exists(metadataPath)) return Results.NotFound();
        SavedTrack? track;
        await using (var stream = File.OpenRead(metadataPath))
            track = await JsonSerializer.DeserializeAsync<SavedTrack>(stream, storageJsonOptions);
        if (track is null) return Results.NotFound();
        var updated = track with { Analysis = analysis.Clone() };
        var temporaryPath = metadataPath + ".tmp";
        await File.WriteAllTextAsync(temporaryPath, JsonSerializer.Serialize(updated, storageJsonOptions));
        File.Move(temporaryPath, metadataPath, true);
        return Results.Ok(updated);
    }
    finally { tracksGate.Release(); }
});

app.MapPost("/api/tracks", async (HttpRequest request) =>
{
    if (!request.HasFormContentType)
        return Results.BadRequest(new { message = "음원 파일과 분석 데이터를 함께 보내야 합니다." });

    IFormCollection form;
    try { form = await request.ReadFormAsync(); }
    catch (Exception ex) when (ex is InvalidDataException or BadHttpRequestException)
    {
        return Results.BadRequest(new { message = "음원 업로드 데이터를 읽지 못했습니다." });
    }

    var audio = form.Files.GetFile("audio");
    var analysisJson = form["analysis"].ToString();
    if (audio is null || audio.Length == 0)
        return Results.BadRequest(new { message = "저장할 음원 파일이 없습니다." });
    if (audio.Length > 500L * 1024 * 1024)
        return Results.BadRequest(new { message = "음원 파일은 최대 500MB까지 저장할 수 있습니다." });
    if (analysisJson.Length > 10_000_000)
        return Results.BadRequest(new { message = "음악 분석 데이터가 너무 큽니다." });

    var extension = Path.GetExtension(audio.FileName).ToLowerInvariant();
    var allowedExtensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        { ".wav", ".mp3", ".m4a", ".aac", ".ogg", ".flac", ".webm" };
    if (!allowedExtensions.Contains(extension))
        return Results.BadRequest(new { message = "WAV, MP3, M4A, AAC, OGG, FLAC 또는 WEBM 음원을 사용하세요." });

    JsonElement analysis;
    try
    {
        using var document = JsonDocument.Parse(analysisJson, new JsonDocumentOptions { MaxDepth = 32 });
        if (document.RootElement.ValueKind != JsonValueKind.Object
            || !document.RootElement.TryGetProperty("duration", out var duration)
            || duration.GetDouble() <= 0
            || !document.RootElement.TryGetProperty("beatTimes", out var cues)
            || cues.ValueKind != JsonValueKind.Array)
            return Results.BadRequest(new { message = "완료된 음악 분석 데이터가 아닙니다." });
        analysis = document.RootElement.Clone();
    }
    catch (Exception ex) when (ex is JsonException or InvalidOperationException or FormatException)
    {
        return Results.BadRequest(new { message = "음악 분석 데이터 형식이 올바르지 않습니다." });
    }

    var id = Guid.NewGuid().ToString("N");
    var storedFileName = id + extension;
    var audioPath = Path.Combine(tracksDirectory, storedFileName);
    var metadataPath = Path.Combine(tracksDirectory, id + ".json");
    var audioTemporaryPath = audioPath + ".upload";
    var metadataTemporaryPath = metadataPath + ".tmp";
    var displayName = Path.GetFileName(audio.FileName);
    if (displayName.Length > 180) displayName = displayName[..180];
    var track = new SavedTrack(id, displayName, storedFileName, audio.Length, DateTimeOffset.Now, analysis);

    await tracksGate.WaitAsync();
    try
    {
        await using (var output = File.Create(audioTemporaryPath))
            await audio.CopyToAsync(output);
        await File.WriteAllTextAsync(metadataTemporaryPath, JsonSerializer.Serialize(track, storageJsonOptions));
        File.Move(audioTemporaryPath, audioPath, true);
        File.Move(metadataTemporaryPath, metadataPath, true);
        return Results.Ok(track);
    }
    catch (IOException)
    {
        if (File.Exists(audioTemporaryPath)) File.Delete(audioTemporaryPath);
        if (File.Exists(metadataTemporaryPath)) File.Delete(metadataTemporaryPath);
        return Results.Json(new { message = "음원 라이브러리에 파일을 저장하지 못했습니다." }, statusCode: 500);
    }
    finally { tracksGate.Release(); }
});

app.MapGet("/api/tracks/{id}/audio", async (string id) =>
{
    if (!Guid.TryParseExact(id, "N", out _)) return Results.NotFound();
    await tracksGate.WaitAsync();
    try
    {
        var tracks = await LoadSavedTracksUnsafeAsync();
        var track = tracks.FirstOrDefault(item => item.Id == id);
        if (track is null) return Results.NotFound();
        var audioPath = Path.Combine(tracksDirectory, track.StoredFileName);
        return Results.File(audioPath, AudioContentType(Path.GetExtension(audioPath)), enableRangeProcessing: true);
    }
    finally { tracksGate.Release(); }
});

app.MapDelete("/api/tracks/{id}", async (string id) =>
{
    if (!Guid.TryParseExact(id, "N", out _)) return Results.NotFound();
    await tracksGate.WaitAsync();
    try
    {
        var metadataPath = Path.Combine(tracksDirectory, id + ".json");
        if (!File.Exists(metadataPath)) return Results.NotFound();
        SavedTrack? track;
        await using (var stream = File.OpenRead(metadataPath))
            track = await JsonSerializer.DeserializeAsync<SavedTrack>(stream, storageJsonOptions);
        if (track is not null)
        {
            var audioPath = Path.Combine(tracksDirectory, Path.GetFileName(track.StoredFileName));
            if (File.Exists(audioPath)) File.Delete(audioPath);
        }
        File.Delete(metadataPath);
        return Results.Ok(new { message = "재생목록에서 음원을 삭제했습니다." });
    }
    finally { tracksGate.Release(); }
});

app.MapPost("/api/pair", async (PairRequest request) =>
{
    if (request.BridgeIndex is < 1 or > 2)
        return Results.BadRequest(new { message = "Bridge 번호는 1 또는 2여야 합니다." });
    if (!IsAllowedBridgeAddress(request.BridgeIp, out var bridgeIp))
        return Results.BadRequest(new { message = "192.168.x.x와 같은 로컬 Bridge IPv4 주소를 입력하세요." });

    try
    {
        using var client = CreateBridgeClient(bridgeIp);
        var response = await client.PostAsJsonAsync("/api", new { devicetype = "hue_beat_controller#pc", generateclientkey = true });
        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        if (json.ValueKind != JsonValueKind.Array || json.GetArrayLength() == 0)
            return Results.BadRequest(new { message = "Bridge가 예상하지 못한 응답을 반환했습니다." });

        var first = json[0];
        if (first.TryGetProperty("error", out var error))
        {
            var description = error.TryGetProperty("description", out var d) ? d.GetString() : "인증 실패";
            return Results.BadRequest(new { message = description });
        }

        var success = first.GetProperty("success");
        var key = success.GetProperty("username").GetString();
        var clientKey = success.TryGetProperty("clientkey", out var ck) ? ck.GetString() : null;
        if (string.IsNullOrWhiteSpace(key)) return Results.BadRequest(new { message = "인증키를 받지 못했습니다." });

        await entertainmentSessions[request.BridgeIndex].StopAsync();
        requiredEntertainmentBridges.TryRemove(request.BridgeIndex, out _);
        var settings = await LoadSettingsAsync();
        settings.SetBridge(request.BridgeIndex, new HueBridgeSettings(bridgeIp, key, clientKey));
        await SaveSettingsAsync(settings);
        foreach (var known in lightBridgeIndex.Where(item => item.Value == request.BridgeIndex).Select(item => item.Key).ToArray())
            lightBridgeIndex.TryRemove(known, out _);
        return Results.Ok(new { message = $"Bridge {request.BridgeIndex} 인증이 완료되었습니다.", bridgeIp, request.BridgeIndex });
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
    {
        return Results.BadRequest(new { message = "Bridge에 연결하지 못했습니다. IP와 LAN 연결을 확인하세요." });
    }
});

app.MapGet("/api/lights", async () =>
{
    var settings = await LoadSettingsAsync();
    var configured = settings.ConfiguredBridges().ToArray();
    if (configured.Length == 0) return Results.BadRequest(new { message = "먼저 Bridge를 인증하세요." });
    var successful = new List<HueLightInfo>();
    var failed = new List<int>();
    foreach (var item in configured)
    {
        try { successful.AddRange(await ReadBridgeLightsAsync(item.Index, item.Bridge)); }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        { failed.Add(item.Index); }
    }
    if (successful.Count == 0 && failed.Count > 0)
        return Results.BadRequest(new { message = "Bridge에서 전구 목록을 가져오지 못했습니다." });
    foreach (var light in successful) lightBridgeIndex[light.Id] = light.BridgeIndex;
    return Results.Ok(successful);
});

app.MapPost("/api/lights/{lightId}/transfer", async (string lightId, TransferLightRequest request) =>
{
    if (!Guid.TryParse(lightId, out _))
        return Results.BadRequest(new { message = "올바른 전구 ID가 아닙니다." });
    if (request.SourceBridgeIndex is < 1 or > 2 || request.TargetBridgeIndex is < 1 or > 2
        || request.SourceBridgeIndex == request.TargetBridgeIndex)
        return Results.BadRequest(new { message = "서로 다른 출발·대상 Bridge를 선택하세요." });

    await lightTransferGate.WaitAsync();
    try
    {
        var allSettings = await LoadSettingsAsync();
        var source = allSettings.GetBridge(request.SourceBridgeIndex);
        var target = allSettings.GetBridge(request.TargetBridgeIndex);
        if (!source.IsPaired || !target.IsPaired)
            return Results.BadRequest(new { message = "전구를 이동하려면 두 Bridge가 모두 인증되어 있어야 합니다." });

        var sourceLights = await ReadBridgeLightsAsync(request.SourceBridgeIndex, source);
        var selected = sourceLights.FirstOrDefault(light => string.Equals(light.Id, lightId, StringComparison.OrdinalIgnoreCase));
        if (selected is null)
            return Results.BadRequest(new { message = $"Bridge {request.SourceBridgeIndex}에서 전구를 찾지 못했습니다." });
        if (!string.Equals(selected.Connectivity, "connected", StringComparison.OrdinalIgnoreCase))
            return Results.BadRequest(new { message = "연결된 전구만 안전하게 이동할 수 있습니다. 전원을 켜고 연결 상태를 새로고침하세요." });

        requiredEntertainmentBridges.Clear();
        await Task.WhenAll(entertainmentSessions.Values.Select(session => session.StopAsync()));

        using var sourceClient = CreateBridgeClient(source.BridgeIp!, source.ApplicationKey, TimeSpan.FromSeconds(10));
        using var targetClient = CreateBridgeClient(target.BridgeIp!, target.ApplicationKey, TimeSpan.FromSeconds(10));
        using var sourceResourceResponse = await sourceClient.GetAsync($"/clip/v2/resource/light/{Uri.EscapeDataString(lightId)}");
        if (!sourceResourceResponse.IsSuccessStatusCode)
            return Results.BadRequest(new { message = "출발 Bridge에서 전구 세부 정보를 읽지 못했습니다." });
        var sourceResource = await sourceResourceResponse.Content.ReadFromJsonAsync<JsonElement>();
        if (!sourceResource.TryGetProperty("data", out var sourceData) || sourceData.GetArrayLength() == 0
            || !sourceData[0].TryGetProperty("id_v1", out var idV1))
            return Results.BadRequest(new { message = "전구의 기존 Bridge 식별자를 찾지 못했습니다." });
        var legacyPath = idV1.GetString() ?? "";
        var legacyId = legacyPath.Split('/', StringSplitOptions.RemoveEmptyEntries).LastOrDefault();
        if (string.IsNullOrWhiteSpace(legacyId))
            return Results.BadRequest(new { message = "전구의 기존 Bridge 번호를 확인하지 못했습니다." });

        var sourceLegacyLights = await ReadLegacyLightsAsync(sourceClient, source);
        if (!sourceLegacyLights.TryGetValue(legacyId, out var sourceLegacy))
            return Results.BadRequest(new { message = "출발 Bridge의 전구 정보를 확인하지 못했습니다." });
        var targetBefore = await ReadLegacyLightsAsync(targetClient, target);

        using var deleteResponse = await sourceClient.DeleteAsync(
            $"/api/{Uri.EscapeDataString(source.ApplicationKey!)}/lights/{Uri.EscapeDataString(legacyId)}");
        var deleteRoot = await deleteResponse.Content.ReadFromJsonAsync<JsonElement>();
        var deleteError = HueV1Error(deleteRoot);
        if (!deleteResponse.IsSuccessStatusCode || deleteError is not null)
            return Results.BadRequest(new { message = deleteError ?? "출발 Bridge가 전구 해제를 거부했습니다." });

        lightBridgeIndex.TryRemove(lightId, out _);
        using var searchResponse = await targetClient.PostAsJsonAsync(
            $"/api/{Uri.EscapeDataString(target.ApplicationKey!)}/lights", new { });
        var searchRoot = await searchResponse.Content.ReadFromJsonAsync<JsonElement>();
        var searchError = HueV1Error(searchRoot);
        if (!searchResponse.IsSuccessStatusCode || searchError is not null)
            return Results.Json(new
            {
                message = $"Bridge {request.SourceBridgeIndex} 해제는 완료됐지만 Bridge {request.TargetBridgeIndex} 검색을 시작하지 못했습니다. Hue 앱 또는 시리얼 번호로 대상 Bridge에 등록하세요. {searchError}"
            }, statusCode: StatusCodes.Status502BadGateway);

        string? targetLegacyId = null;
        for (var attempt = 0; attempt < 35 && targetLegacyId is null; attempt++)
        {
            await Task.Delay(2000);
            var targetNow = await ReadLegacyLightsAsync(targetClient, target);
            targetLegacyId = targetNow.FirstOrDefault(item =>
                !targetBefore.ContainsKey(item.Key)
                && (!string.IsNullOrWhiteSpace(sourceLegacy.UniqueId)
                    ? string.Equals(item.Value.UniqueId, sourceLegacy.UniqueId, StringComparison.OrdinalIgnoreCase)
                    : true)).Key;
        }
        if (string.IsNullOrWhiteSpace(targetLegacyId))
            return Results.Json(new
            {
                message = $"Bridge {request.SourceBridgeIndex}에서 해제했지만 Bridge {request.TargetBridgeIndex}가 70초 안에 전구를 찾지 못했습니다. 전구 시리얼 번호로 대상 Bridge에 등록하세요.",
                sourceRemoved = true
            }, statusCode: StatusCodes.Status504GatewayTimeout);

        using (var renameResponse = await targetClient.PutAsJsonAsync(
            $"/api/{Uri.EscapeDataString(target.ApplicationKey!)}/lights/{Uri.EscapeDataString(targetLegacyId)}",
            new { name = sourceLegacy.Name }))
        {
            // 이름 복원 실패는 전구 이동 자체를 실패시키지 않습니다.
        }

        var newLightId = await ResolveV2LightIdAsync(targetClient, targetLegacyId);
        if (!string.IsNullOrWhiteSpace(newLightId)) lightBridgeIndex[newLightId] = request.TargetBridgeIndex;
        return Results.Ok(new
        {
            message = $"'{sourceLegacy.Name}' 전구를 Bridge {request.SourceBridgeIndex}에서 Bridge {request.TargetBridgeIndex}(으)로 이동했습니다.",
            oldLightId = lightId,
            newLightId,
            sourceBridgeIndex = request.SourceBridgeIndex,
            targetBridgeIndex = request.TargetBridgeIndex
        });
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
    {
        return Results.BadRequest(new { message = $"전구 이동 중 Bridge 통신이 중단됐습니다: {ex.Message}" });
    }
    finally { lightTransferGate.Release(); }
});

app.MapPost("/api/lights/transfer-batch", async (TransferLightsRequest request) =>
{
    var requestedIds = (request.LightIds ?? []).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
    if (requestedIds.Length is < 1 or > 20 || requestedIds.Any(id => !Guid.TryParse(id, out _)))
        return Results.BadRequest(new { message = "한 번에 이동할 올바른 전구를 1~20개 선택하세요." });
    if (request.SourceBridgeIndex is < 1 or > 2 || request.TargetBridgeIndex is < 1 or > 2
        || request.SourceBridgeIndex == request.TargetBridgeIndex)
        return Results.BadRequest(new { message = "서로 다른 출발·대상 Bridge를 선택하세요." });

    await lightTransferGate.WaitAsync();
    try
    {
        var allSettings = await LoadSettingsAsync();
        var source = allSettings.GetBridge(request.SourceBridgeIndex);
        var target = allSettings.GetBridge(request.TargetBridgeIndex);
        if (!source.IsPaired || !target.IsPaired)
            return Results.BadRequest(new { message = "일괄 이동에는 두 Bridge가 모두 인증되어 있어야 합니다." });

        var sourceLights = await ReadBridgeLightsAsync(request.SourceBridgeIndex, source);
        var selected = requestedIds.Select(id => sourceLights.FirstOrDefault(light =>
            string.Equals(light.Id, id, StringComparison.OrdinalIgnoreCase))).ToArray();
        if (selected.Any(light => light is null))
            return Results.BadRequest(new { message = $"Bridge {request.SourceBridgeIndex}에 없는 전구가 선택되었습니다. 목록을 새로고침하세요." });
        if (selected.Any(light => !string.Equals(light!.Connectivity, "connected", StringComparison.OrdinalIgnoreCase)))
            return Results.BadRequest(new { message = "연결된 전구만 일괄 이동할 수 있습니다. 선택 전구의 전원을 모두 켜세요." });

        requiredEntertainmentBridges.Clear();
        await Task.WhenAll(entertainmentSessions.Values.Select(session => session.StopAsync()));

        using var sourceClient = CreateBridgeClient(source.BridgeIp!, source.ApplicationKey, TimeSpan.FromSeconds(10));
        using var targetClient = CreateBridgeClient(target.BridgeIp!, target.ApplicationKey, TimeSpan.FromSeconds(10));
        var sourceLegacyLights = await ReadLegacyLightsAsync(sourceClient, source);
        var targetBefore = await ReadLegacyLightsAsync(targetClient, target);
        var prepared = new List<TransferCandidate>();

        foreach (var light in selected.Select(item => item!))
        {
            using var resourceResponse = await sourceClient.GetAsync($"/clip/v2/resource/light/{Uri.EscapeDataString(light.Id)}");
            if (!resourceResponse.IsSuccessStatusCode)
                return Results.BadRequest(new { message = $"'{light.Name}' 전구의 이동 정보를 읽지 못했습니다. 아직 전구를 해제하지 않았습니다." });
            var resourceRoot = await resourceResponse.Content.ReadFromJsonAsync<JsonElement>();
            if (!resourceRoot.TryGetProperty("data", out var data) || data.GetArrayLength() == 0
                || !data[0].TryGetProperty("id_v1", out var idV1))
                return Results.BadRequest(new { message = $"'{light.Name}' 전구의 기존 Bridge 번호를 찾지 못했습니다. 아직 전구를 해제하지 않았습니다." });
            var legacyId = (idV1.GetString() ?? "").Split('/', StringSplitOptions.RemoveEmptyEntries).LastOrDefault();
            if (string.IsNullOrWhiteSpace(legacyId) || !sourceLegacyLights.TryGetValue(legacyId, out var legacy))
                return Results.BadRequest(new { message = $"'{light.Name}' 전구의 기존 정보를 확인하지 못했습니다. 아직 전구를 해제하지 않았습니다." });
            prepared.Add(new TransferCandidate(light.Id, legacyId, legacy.Name, legacy.UniqueId));
        }

        var removed = new List<TransferCandidate>();
        var failed = new List<object>();
        foreach (var item in prepared)
        {
            using var deleteResponse = await sourceClient.DeleteAsync(
                $"/api/{Uri.EscapeDataString(source.ApplicationKey!)}/lights/{Uri.EscapeDataString(item.LegacyId)}");
            var deleteRoot = await deleteResponse.Content.ReadFromJsonAsync<JsonElement>();
            var deleteError = HueV1Error(deleteRoot);
            if (!deleteResponse.IsSuccessStatusCode || deleteError is not null)
            {
                failed.Add(new { oldLightId = item.OldLightId, name = item.Name, reason = deleteError ?? "출발 Bridge 해제 실패" });
                continue;
            }
            removed.Add(item);
            lightBridgeIndex.TryRemove(item.OldLightId, out _);
        }
        if (removed.Count == 0)
            return Results.BadRequest(new { message = "선택한 전구를 출발 Bridge에서 해제하지 못했습니다.", failed });

        using var searchResponse = await targetClient.PostAsJsonAsync(
            $"/api/{Uri.EscapeDataString(target.ApplicationKey!)}/lights", new { });
        var searchRoot = await searchResponse.Content.ReadFromJsonAsync<JsonElement>();
        var searchError = HueV1Error(searchRoot);
        if (!searchResponse.IsSuccessStatusCode || searchError is not null)
            return Results.Json(new
            {
                message = $"{removed.Count}개 전구 해제는 완료됐지만 Bridge {request.TargetBridgeIndex} 검색을 시작하지 못했습니다. Hue 앱에서 대상 Bridge 검색을 실행하세요. {searchError}",
                sourceRemoved = removed.Select(item => new { oldLightId = item.OldLightId, item.Name }),
                failed
            }, statusCode: StatusCodes.Status502BadGateway);

        var foundLegacyByOldId = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var attempt = 0; attempt < 35 && foundLegacyByOldId.Count < removed.Count; attempt++)
        {
            await Task.Delay(2000);
            var targetNow = await ReadLegacyLightsAsync(targetClient, target);
            foreach (var item in removed.Where(candidate => !foundLegacyByOldId.ContainsKey(candidate.OldLightId)))
            {
                var match = targetNow.FirstOrDefault(candidate =>
                    !targetBefore.ContainsKey(candidate.Key)
                    && !foundLegacyByOldId.Values.Contains(candidate.Key, StringComparer.OrdinalIgnoreCase)
                    && !string.IsNullOrWhiteSpace(item.UniqueId)
                    && string.Equals(candidate.Value.UniqueId, item.UniqueId, StringComparison.OrdinalIgnoreCase));
                if (!string.IsNullOrWhiteSpace(match.Key)) foundLegacyByOldId[item.OldLightId] = match.Key;
            }
        }

        var moved = new List<object>();
        var missing = new List<object>();
        foreach (var item in removed)
        {
            if (!foundLegacyByOldId.TryGetValue(item.OldLightId, out var targetLegacyId))
            {
                missing.Add(new { oldLightId = item.OldLightId, item.Name, reason = "대상 Bridge가 70초 안에 발견하지 못함" });
                continue;
            }

            using (var renameResponse = await targetClient.PutAsJsonAsync(
                $"/api/{Uri.EscapeDataString(target.ApplicationKey!)}/lights/{Uri.EscapeDataString(targetLegacyId)}",
                new { name = item.Name })) { }
            var newLightId = await ResolveV2LightIdAsync(targetClient, targetLegacyId);
            if (!string.IsNullOrWhiteSpace(newLightId)) lightBridgeIndex[newLightId] = request.TargetBridgeIndex;
            moved.Add(new { oldLightId = item.OldLightId, newLightId, item.Name });
        }

        var incomplete = failed.Count + missing.Count;
        return Results.Ok(new
        {
            message = incomplete == 0
                ? $"전구 {moved.Count}개를 Bridge {request.TargetBridgeIndex}(으)로 한 번에 이동했습니다."
                : $"전구 {moved.Count}개 이동 완료 · {incomplete}개 확인 필요",
            moved,
            failed,
            missing,
            sourceBridgeIndex = request.SourceBridgeIndex,
            targetBridgeIndex = request.TargetBridgeIndex
        });
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
    {
        return Results.BadRequest(new { message = $"전구 일괄 이동 중 Bridge 통신이 중단됐습니다: {ex.Message}" });
    }
    finally { lightTransferGate.Release(); }
});

app.MapPost("/api/lights/{lightId}/identify", async (string lightId, IdentifyLightRequest request) =>
{
    if (!Guid.TryParse(lightId, out _))
        return Results.BadRequest(new { message = "올바른 전구 ID가 아닙니다." });
    if (request.BridgeIndex is < 1 or > 2)
        return Results.BadRequest(new { message = "Bridge 번호는 1 또는 2여야 합니다." });

    var settings = (await LoadSettingsAsync()).GetBridge(request.BridgeIndex);
    if (!settings.IsPaired)
        return Results.BadRequest(new { message = "먼저 Bridge를 인증하세요." });

    try
    {
        var bridgeLights = await ReadBridgeLightsAsync(request.BridgeIndex, settings);
        var selected = bridgeLights.FirstOrDefault(light =>
            string.Equals(light.Id, lightId, StringComparison.OrdinalIgnoreCase));
        if (selected is null)
            return Results.BadRequest(new { message = $"Bridge {request.BridgeIndex}에서 전구를 찾지 못했습니다." });
        if (!string.Equals(selected.Connectivity, "connected", StringComparison.OrdinalIgnoreCase))
            return Results.BadRequest(new { message = "연결된 전구만 식별할 수 있습니다. 전원을 켜고 새로고침하세요." });

        using var client = CreateBridgeClient(settings.BridgeIp!, settings.ApplicationKey);
        using var response = await client.PutAsJsonAsync(
            $"/clip/v2/resource/light/{Uri.EscapeDataString(lightId)}",
            new { alert = new { action = "breathe" } });
        var root = await response.Content.ReadFromJsonAsync<JsonElement>();
        if (!response.IsSuccessStatusCode
            || (root.TryGetProperty("errors", out var errors) && errors.GetArrayLength() > 0))
        {
            var description = root.TryGetProperty("errors", out errors) && errors.GetArrayLength() > 0
                && errors[0].TryGetProperty("description", out var errorDescription)
                    ? errorDescription.GetString()
                    : null;
            return Results.BadRequest(new { message = description ?? "Bridge가 전구 식별 점멸을 거부했습니다." });
        }

        return Results.Ok(new
        {
            message = $"'{selected.Name}' 전구에 식별 점멸을 보냈습니다.",
            lightId,
            bridgeIndex = request.BridgeIndex
        });
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
    {
        return Results.BadRequest(new { message = "전구 식별 중 Bridge 연결이 끊겼습니다." });
    }
});

app.MapPut("/api/lights/{lightId}/name", async (string lightId, RenameLightRequest request) =>
{
    var name = request.Name?.Trim() ?? "";
    if (!Guid.TryParse(lightId, out _))
        return Results.BadRequest(new { message = "올바른 전구 ID가 아닙니다." });
    if (name.Length is < 1 or > 32)
        return Results.BadRequest(new { message = "전구 이름은 1~32자로 입력하세요." });

    if (request.BridgeIndex is < 1 or > 2)
        return Results.BadRequest(new { message = "Bridge 번호는 1 또는 2여야 합니다." });
    var settings = (await LoadSettingsAsync()).GetBridge(request.BridgeIndex);
    if (!settings.IsPaired)
        return Results.BadRequest(new { message = "먼저 Bridge를 인증하세요." });

    try
    {
        using var client = CreateBridgeClient(settings.BridgeIp!, settings.ApplicationKey);
        var lightResponse = await client.GetAsync($"/clip/v2/resource/light/{Uri.EscapeDataString(lightId)}");
        if (!lightResponse.IsSuccessStatusCode)
            return Results.BadRequest(new { message = "Bridge에서 전구 정보를 찾지 못했습니다." });

        var lightRoot = await lightResponse.Content.ReadFromJsonAsync<JsonElement>();
        if (!lightRoot.TryGetProperty("data", out var lightData) || lightData.GetArrayLength() == 0)
            return Results.BadRequest(new { message = "Bridge에서 전구 정보를 찾지 못했습니다." });
        var light = lightData[0];
        if (!light.TryGetProperty("owner", out var owner) || !owner.TryGetProperty("rid", out var ownerRid))
            return Results.BadRequest(new { message = "전구가 속한 장치 정보를 찾지 못했습니다." });
        var deviceId = ownerRid.GetString();
        if (string.IsNullOrWhiteSpace(deviceId))
            return Results.BadRequest(new { message = "전구가 속한 장치 ID가 없습니다." });

        var metadata = new Dictionary<string, object> { ["name"] = name };
        var deviceResponse = await client.GetAsync($"/clip/v2/resource/device/{Uri.EscapeDataString(deviceId)}");
        if (deviceResponse.IsSuccessStatusCode)
        {
            var deviceRoot = await deviceResponse.Content.ReadFromJsonAsync<JsonElement>();
            if (deviceRoot.TryGetProperty("data", out var deviceData) && deviceData.GetArrayLength() > 0
                && deviceData[0].TryGetProperty("metadata", out var currentMetadata)
                && currentMetadata.TryGetProperty("archetype", out var archetype)
                && !string.IsNullOrWhiteSpace(archetype.GetString()))
                metadata["archetype"] = archetype.GetString()!;
        }

        var renameResponse = await client.PutAsJsonAsync(
            $"/clip/v2/resource/device/{Uri.EscapeDataString(deviceId)}",
            new Dictionary<string, object> { ["metadata"] = metadata });
        var renameRoot = await renameResponse.Content.ReadFromJsonAsync<JsonElement>();
        if (!renameResponse.IsSuccessStatusCode
            || (renameRoot.TryGetProperty("errors", out var errors) && errors.GetArrayLength() > 0))
        {
            var description = renameRoot.TryGetProperty("errors", out errors) && errors.GetArrayLength() > 0
                && errors[0].TryGetProperty("description", out var errorDescription)
                    ? errorDescription.GetString()
                    : null;
            return Results.BadRequest(new { message = description ?? "Bridge가 전구 이름 변경을 거부했습니다." });
        }

        return Results.Ok(new { message = $"전구 이름을 '{name}'(으)로 변경했습니다.", lightId, name });
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
    {
        return Results.BadRequest(new { message = "전구 이름 변경 중 Bridge 연결이 끊겼습니다." });
    }
});

app.MapPost("/api/control", async (ControlRequest request) =>
{
    var settings = await LoadSettingsAsync();
    var configured = settings.ConfiguredBridges().ToArray();
    if (configured.Length == 0) return Results.BadRequest(new { message = "먼저 Bridge를 인증하세요." });
    if (request.Commands.Count == 0) return Results.BadRequest(new { message = "제어할 전구가 없습니다." });
    try
    {
        var requestedIds = request.Commands.SelectMany(command => command.LightIds).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        if (requestedIds.Any(id => !lightBridgeIndex.ContainsKey(id)))
        {
            foreach (var item in configured)
                foreach (var light in await ReadBridgeLightsAsync(item.Index, item.Bridge))
                    lightBridgeIndex[light.Id] = item.Index;
        }
        var tasks = configured.Select(item =>
        {
            var bridgeCommands = request.Commands.Select(command => command with
            {
                LightIds = command.LightIds.Where(id => lightBridgeIndex.TryGetValue(id, out var index) && index == item.Index).ToList()
            }).Where(command => command.LightIds.Count > 0).ToArray();
            return bridgeCommands.Length == 0
                ? Task.FromResult(new List<LightControlResult>())
                : SendControlCommandsAsync(item.Bridge, bridgeCommands);
        });
        var results = (await Task.WhenAll(tasks)).SelectMany(result => result).ToArray();
        var unresolved = requestedIds.Where(id => !lightBridgeIndex.ContainsKey(id)).ToArray();
        var failed = results.Where(result => !result.Success).ToArray();
        if (failed.Length == 0 && unresolved.Length == 0)
            return Results.Ok(new { Updated = results.Length, Bridges = configured.Select(item => item.Index).ToArray() });
        return Results.Json(new
        {
            message = $"{requestedIds.Length}개 중 {failed.Length + unresolved.Length}개 전구 제어에 실패했습니다.",
            Updated = results.Length - failed.Length,
            Failed = failed,
            Unresolved = unresolved
        }, statusCode: 502);
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
    {
        return Results.BadRequest(new { message = "조명 명령 전송 중 Bridge 연결이 끊겼습니다." });
    }
});

app.MapPost("/api/control/grouped-all", async (GroupedLightCommand request) =>
{
    var settings = await LoadSettingsAsync();
    if (string.IsNullOrWhiteSpace(settings.BridgeIp) || string.IsNullOrWhiteSpace(settings.ApplicationKey))
        return Results.BadRequest(new { message = "먼저 Bridge를 인증하세요." });

    try
    {
        using var client = CreateBridgeClient(settings.BridgeIp, settings.ApplicationKey);
        var grouped = await LoadGroupedAllAsync(settings, client);
        var requestedIds = request.LightIds.Distinct().ToHashSet();
        if (string.IsNullOrWhiteSpace(grouped.ResourceId) || requestedIds.Count == 0 || !requestedIds.SetEquals(grouped.LightIds))
            return Results.BadRequest(new { message = "전체 동시 명령은 Bridge의 모든 전구가 음악 그룹에 포함된 경우에만 사용할 수 있습니다." });

        var body = new Dictionary<string, object>
        {
            ["on"] = new { on = request.On ?? true },
            ["dimming"] = new { brightness = Math.Clamp(request.Brightness, 0.1, 100) },
            ["dynamics"] = new { duration = Math.Clamp(request.TransitionMs, 0, 60000) }
        };
        if (!string.IsNullOrWhiteSpace(request.HexColor))
        {
            var (x, y) = ColorConverter.HexToXy(request.HexColor);
            body["color"] = new { xy = new { x, y } };
        }

        using var response = await client.PutAsJsonAsync($"/clip/v2/resource/grouped_light/{Uri.EscapeDataString(grouped.ResourceId)}", body);
        if (!response.IsSuccessStatusCode)
            return Results.Json(new { message = $"Bridge 전체 그룹 명령에 실패했습니다. ({(int)response.StatusCode})" }, statusCode: 502);
        return Results.Ok(new { Updated = requestedIds.Count, Grouped = true });
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
    {
        return Results.BadRequest(new { message = "전체 그룹 명령 중 Bridge 연결이 끊겼습니다." });
    }
});

app.MapPost("/api/control/grouped-music", async (ControlRequest request) =>
{
    var settings = await LoadSettingsAsync();
    if (string.IsNullOrWhiteSpace(settings.BridgeIp) || string.IsNullOrWhiteSpace(settings.ApplicationKey))
        return Results.BadRequest(new { message = "먼저 Bridge를 인증하세요." });
    if (request.Commands.Count == 0)
        return Results.BadRequest(new { message = "제어할 음악 그룹이 없습니다." });

    try
    {
        using var client = CreateBridgeClient(settings.BridgeIp, settings.ApplicationKey);
        var prepared = await PrepareMusicGroupsAsync(settings, client, request.Commands);
        var jobs = prepared.Select(async item =>
        {
            var command = item.Command;
            var body = new Dictionary<string, object>
            {
                ["on"] = new { on = command.On ?? true },
                ["dimming"] = new { brightness = Math.Clamp(command.Brightness, 0.1, 100) },
                ["dynamics"] = new { duration = Math.Clamp(command.TransitionMs, 0, 60000) }
            };
            if (!string.IsNullOrWhiteSpace(command.HexColor))
            {
                var (x, y) = ColorConverter.HexToXy(command.HexColor);
                body["color"] = new { xy = new { x, y } };
            }

            using var response = await client.PutAsJsonAsync($"/clip/v2/resource/grouped_light/{Uri.EscapeDataString(item.GroupId)}", body);
            var responseBody = await response.Content.ReadFromJsonAsync<JsonElement>();
            var hasError = responseBody.TryGetProperty("errors", out var errors) && errors.GetArrayLength() > 0;
            return new { GroupId = item.GroupId, Success = response.IsSuccessStatusCode && !hasError, Status = (int)response.StatusCode };
        });

        var results = await Task.WhenAll(jobs);
        var failed = results.Where(result => !result.Success).ToArray();
        if (failed.Length > 0)
            return Results.Json(new { message = $"{results.Length}개 중 {failed.Length}개 음악 그룹 제어에 실패했습니다.", Failed = failed }, statusCode: 502);
        return Results.Ok(new { Updated = request.Commands.Sum(command => command.LightIds.Distinct().Count()), Groups = results.Length, Grouped = true });
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { message = ex.Message });
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
    {
        return Results.BadRequest(new { message = "음악 그룹 명령 중 Bridge 연결이 끊겼습니다." });
    }
});

app.MapPost("/api/control/grouped-music/prepare", async (ControlRequest request) =>
{
    var settings = await LoadSettingsAsync();
    if (string.IsNullOrWhiteSpace(settings.BridgeIp) || string.IsNullOrWhiteSpace(settings.ApplicationKey))
        return Results.BadRequest(new { message = "먼저 Bridge를 인증하세요." });
    if (request.Commands.Count == 0)
        return Results.BadRequest(new { message = "준비할 음악 그룹이 없습니다." });

    try
    {
        using var client = CreateBridgeClient(settings.BridgeIp, settings.ApplicationKey);
        var prepared = await PrepareMusicGroupsAsync(settings, client, request.Commands);
        return Results.Ok(new { Groups = prepared.Count, Lights = request.Commands.Sum(command => command.LightIds.Distinct().Count()) });
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { message = ex.Message });
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
    {
        return Results.BadRequest(new { message = "음악 그룹 준비 중 Bridge 연결이 끊겼습니다." });
    }
});

app.MapPost("/api/control/music-scenes/prepare", async (MusicScenePrepareRequest request) =>
{
    var settings = await LoadSettingsAsync();
    if (string.IsNullOrWhiteSpace(settings.BridgeIp) || string.IsNullOrWhiteSpace(settings.ApplicationKey))
        return Results.BadRequest(new { message = "먼저 Bridge를 인증하세요." });
    if (request.Frames.Count == 0)
        return Results.BadRequest(new { message = "준비할 Scene 프레임이 없습니다." });

    try
    {
        // Creating/updating a Hue Scene can take noticeably longer than a normal
        // light or scene-recall command. This timeout is used only during the
        // one-time preparation step; playback retains the short control timeout.
        using var client = CreateBridgeClient(settings.BridgeIp, settings.ApplicationKey, TimeSpan.FromSeconds(60));
        var sceneIds = await PrepareMusicScenesAsync(settings, client, request.Frames);
        var lights = request.Frames.SelectMany(frame => frame.Commands).SelectMany(command => command.LightIds).Distinct().Count();
        return Results.Ok(new { Scenes = sceneIds.Count, Lights = lights, SceneIds = sceneIds });
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { message = ex.Message });
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
    {
        return Results.BadRequest(new { message = "음악 Scene 준비 중 Bridge 연결이 끊겼습니다." });
    }
});

app.MapPost("/api/control/music-scenes/recall", async (MusicSceneRecallRequest request) =>
{
    var settings = await LoadSettingsAsync();
    if (string.IsNullOrWhiteSpace(settings.BridgeIp) || string.IsNullOrWhiteSpace(settings.ApplicationKey))
        return Results.BadRequest(new { message = "먼저 Bridge를 인증하세요." });

    string? sceneId;
    await musicSceneGate.WaitAsync();
    try
    {
        sceneId = request.SceneIndex >= 0 && request.SceneIndex < musicSceneIds.Count
            ? musicSceneIds[request.SceneIndex]
            : null;
    }
    finally { musicSceneGate.Release(); }
    if (string.IsNullOrWhiteSpace(sceneId))
        return Results.BadRequest(new { message = "음악 Scene이 준비되지 않았습니다. 연출을 다시 시작하세요." });

    try
    {
        using var client = CreateBridgeClient(settings.BridgeIp, settings.ApplicationKey);
        using var response = await client.PutAsJsonAsync($"/clip/v2/resource/scene/{Uri.EscapeDataString(sceneId)}",
            new { recall = new { action = "active", duration = Math.Clamp(request.TransitionMs, 0, 60000) } });
        var root = await response.Content.ReadFromJsonAsync<JsonElement>();
        var hasError = root.TryGetProperty("errors", out var errors) && errors.GetArrayLength() > 0;
        if (!response.IsSuccessStatusCode || hasError)
            return Results.Json(new { message = $"음악 Scene 호출에 실패했습니다. ({(int)response.StatusCode})" }, statusCode: 502);
        return Results.Ok(new { Scene = request.SceneIndex + 1, Updated = true, CommonCommand = true });
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
    {
        return Results.BadRequest(new { message = "음악 Scene 호출 중 Bridge 연결이 끊겼습니다." });
    }
});

app.MapGet("/api/entertainment/configurations", async (int? bridgeIndex) =>
{
    var index = bridgeIndex ?? 1;
    if (!entertainmentSessions.TryGetValue(index, out var session))
        return Results.BadRequest(new { message = "Bridge 번호는 1 또는 2여야 합니다." });
    try
    {
        var configurations = await session.GetConfigurationsAsync();
        return Results.Ok(configurations);
    }
    catch (InvalidOperationException ex) { return Results.BadRequest(new { message = ex.Message }); }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
    {
        return Results.BadRequest(new { message = $"Entertainment 영역을 Bridge에서 가져오지 못했습니다: {ex.Message}" });
    }
});

app.MapPost("/api/entertainment/configurations/sync", async (EntertainmentConfigurationSyncRequest request) =>
{
    var name = request.Name?.Trim() ?? "";
    var lightIds = request.LightIds?.Distinct(StringComparer.OrdinalIgnoreCase).ToArray() ?? [];
    if (name.Length is < 1 or > 32)
        return Results.BadRequest(new { message = "Entertainment 영역 이름은 1~32자로 입력하세요." });
    if (lightIds.Length is < 1 or > 10 || lightIds.Any(id => !Guid.TryParse(id, out _)))
        return Results.BadRequest(new { message = "Entertainment 영역에는 올바른 컬러 전구를 1~10개까지 등록할 수 있습니다." });
    if (!entertainmentSessions.TryGetValue(request.BridgeIndex, out var entertainment))
        return Results.BadRequest(new { message = "Bridge 번호는 1 또는 2여야 합니다." });

    var settings = (await LoadSettingsAsync()).GetBridge(request.BridgeIndex);
    if (!settings.IsPaired) return Results.BadRequest(new { message = $"먼저 Bridge {request.BridgeIndex}을 인증하세요." });

    try
    {
        await entertainment.StopAsync();
        using var client = CreateBridgeClient(settings.BridgeIp!, settings.ApplicationKey);
        var lightsResponse = await client.GetAsync("/clip/v2/resource/light");
        var lightsRoot = await lightsResponse.Content.ReadFromJsonAsync<JsonElement>();
        if (!lightsResponse.IsSuccessStatusCode || !lightsRoot.TryGetProperty("data", out var lightData))
            return Results.BadRequest(new { message = "Bridge에서 Entertainment 전구 정보를 가져오지 못했습니다." });

        var legacyByV2 = lightData.EnumerateArray()
            .Where(light => light.TryGetProperty("id", out _) && light.TryGetProperty("id_v1", out _))
            .Select(light => new { Id = light.GetProperty("id").GetString() ?? "", IdV1 = light.GetProperty("id_v1").GetString() ?? "" })
            .Where(light => light.IdV1.StartsWith("/lights/", StringComparison.OrdinalIgnoreCase))
            .ToDictionary(light => light.Id, light => light.IdV1[8..], StringComparer.OrdinalIgnoreCase);
        var missingLights = lightIds.Where(id => !legacyByV2.ContainsKey(id)).ToArray();
        if (missingLights.Length > 0)
            return Results.BadRequest(new { message = $"Bridge에서 {missingLights.Length}개 전구의 등록 ID를 찾지 못했습니다. 전구 목록을 새로고침하세요." });
        var legacyLightIds = lightIds.Select(id => legacyByV2[id]).ToArray();

        HttpResponseMessage response;
        var encodedKey = Uri.EscapeDataString(settings.ApplicationKey!);
        if (request.ConfigurationId.HasValue)
        {
            var configurationResponse = await client.GetAsync($"/clip/v2/resource/entertainment_configuration/{request.ConfigurationId.Value}");
            var configurationRoot = await configurationResponse.Content.ReadFromJsonAsync<JsonElement>();
            if (!configurationResponse.IsSuccessStatusCode
                || !configurationRoot.TryGetProperty("data", out var configurationData)
                || configurationData.GetArrayLength() == 0
                || !configurationData[0].TryGetProperty("id_v1", out var idV1Element)
                || string.IsNullOrWhiteSpace(idV1Element.GetString())
                || !idV1Element.GetString()!.StartsWith("/groups/", StringComparison.OrdinalIgnoreCase))
                return Results.BadRequest(new { message = "선택한 Entertainment 영역의 Bridge 그룹 ID를 찾지 못했습니다." });
            var groupId = idV1Element.GetString()![8..];
            response = await client.PutAsJsonAsync($"/api/{encodedKey}/groups/{Uri.EscapeDataString(groupId)}", new { name, lights = legacyLightIds });
        }
        else
        {
            response = await client.PostAsJsonAsync($"/api/{encodedKey}/groups", new { name, type = "Entertainment", lights = legacyLightIds, @class = "TV" });
        }

        using (response)
        {
            var result = await response.Content.ReadFromJsonAsync<JsonElement>();
            var bridgeError = HueV1Error(result);
            if (!response.IsSuccessStatusCode || bridgeError is not null)
                return Results.BadRequest(new { message = $"Entertainment 영역을 저장하지 못했습니다: {bridgeError ?? response.StatusCode.ToString()}" });
        }

        return Results.Ok(new
        {
            request.ConfigurationId,
            request.BridgeIndex,
            Name = name,
            LightCount = lightIds.Length,
            Message = request.ConfigurationId.HasValue
                ? $"Bridge {request.BridgeIndex}의 '{name}' 영역을 전구 {lightIds.Length}개로 갱신했습니다."
                : $"Bridge {request.BridgeIndex}에 '{name}' 영역을 전구 {lightIds.Length}개로 등록했습니다."
        });
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
    {
        return Results.BadRequest(new { message = $"Entertainment 영역 저장 중 Bridge 통신에 실패했습니다: {ex.Message}" });
    }
});

app.MapGet("/api/entertainment/status", () => Results.Ok(new
{
    Active = requiredEntertainmentBridges.Count > 0
        && requiredEntertainmentBridges.Keys.All(index => entertainmentSessions[index].IsActive),
    Bridges = entertainmentSessions.Select(item => new { BridgeIndex = item.Key, Status = item.Value.GetStatus() }).ToArray()
}));

app.MapPost("/api/entertainment/start", async (EntertainmentStartRequest request) =>
{
    try
    {
        var selections = request.Bridges?.Count > 0
            ? request.Bridges
            : request.ConfigurationId.HasValue
                ? [new EntertainmentBridgeSelection(1, request.ConfigurationId.Value)]
                : [];
        if (selections.Count == 0) return Results.BadRequest(new { message = "연결할 Entertainment 영역을 선택하세요." });
        if (selections.Any(selection => !entertainmentSessions.ContainsKey(selection.BridgeIndex))
            || selections.GroupBy(selection => selection.BridgeIndex).Any(group => group.Count() > 1))
            return Results.BadRequest(new { message = "Bridge별 Entertainment 영역을 하나씩 선택하세요." });
        requiredEntertainmentBridges.Clear();
        await Task.WhenAll(entertainmentSessions.Values.Select(session => session.StopAsync()));
        try
        {
            var results = await Task.WhenAll(selections.Select(selection =>
                entertainmentSessions[selection.BridgeIndex].StartAsync(selection.ConfigurationId)));
            foreach (var selection in selections) requiredEntertainmentBridges[selection.BridgeIndex] = 0;
            return Results.Ok(new
            {
                Message = results.Length == 1
                    ? $"Bridge {results[0].BridgeIndex} Entertainment 스트리밍을 시작했습니다."
                    : $"Bridge {results.Length}대의 Entertainment 스트리밍을 동시에 시작했습니다.",
                ActiveBridges = results.Length,
                ChannelCount = results.Sum(result => result.ChannelCount),
                Bridges = results
            });
        }
        catch
        {
            requiredEntertainmentBridges.Clear();
            await Task.WhenAll(entertainmentSessions.Values.Select(session => session.StopAsync()));
            throw;
        }
    }
    catch (InvalidOperationException ex) { return Results.BadRequest(new { message = ex.Message }); }
    catch (Exception ex)
    {
        return Results.BadRequest(new { message = $"Entertainment 스트림 연결 실패: {ex.Message}" });
    }
});

app.MapPost("/api/entertainment/frame", async (EntertainmentFrameRequest request) =>
{
    try
    {
        var expected = requiredEntertainmentBridges.Keys.OrderBy(index => index).ToArray();
        if (expected.Length == 0) throw new InvalidOperationException("먼저 Entertainment 영역을 연결하세요.");
        var disconnected = expected.Where(index => !entertainmentSessions[index].IsActive).ToArray();
        if (disconnected.Length > 0)
        {
            requiredEntertainmentBridges.Clear();
            await Task.WhenAll(entertainmentSessions.Values.Select(session => session.StopAsync()));
            throw new InvalidOperationException($"Bridge {string.Join(", ", disconnected)} Entertainment 스트림이 끊겼습니다. 두 Bridge를 다시 연결하세요.");
        }
        var active = expected.Select(index => entertainmentSessions[index]).ToArray();
        var ahead = Math.Clamp(request.ScheduleAheadMs, 0, 250);
        var target = ahead > 0
            ? Stopwatch.GetTimestamp() + (long)(ahead / 1000.0 * Stopwatch.Frequency)
            : (long?)null;
        var results = await Task.WhenAll(active.Select(session => session.SendFrameAsync(request.Commands, ahead, target)));
        var updated = results.Sum(result => result.UpdatedChannels);
        if (updated == 0) throw new InvalidOperationException("A/B 그룹 전구가 선택한 Entertainment 영역에 포함되어 있지 않습니다.");
        var ignored = results.Select(result => result.IgnoredLightIds.AsEnumerable())
            .Aggregate((left, right) => left.Intersect(right, StringComparer.OrdinalIgnoreCase))
            .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        return Results.Ok(new
        {
            UpdatedChannels = updated,
            IgnoredLightIds = ignored,
            Scheduled = ahead > 0,
            ScheduleAheadMs = ahead,
            Bridges = results
        });
    }
    catch (InvalidOperationException ex) { return Results.BadRequest(new { message = ex.Message }); }
});

app.MapPost("/api/entertainment/stop", async () =>
{
    requiredEntertainmentBridges.Clear();
    await Task.WhenAll(entertainmentSessions.Values.Select(session => session.StopAsync()));
    return Results.Ok(new { message = "모든 Bridge의 Entertainment 스트림을 종료했습니다." });
});

app.Lifetime.ApplicationStopping.Register(() =>
    Task.WhenAll(entertainmentSessions.Values.Select(session => session.StopAsync())).GetAwaiter().GetResult());

app.MapFallbackToFile("index.html");
app.Run();

record PairRequest(string BridgeIp, int BridgeIndex = 1);
record TransferLightRequest(int SourceBridgeIndex, int TargetBridgeIndex);
record TransferLightsRequest(List<string>? LightIds, int SourceBridgeIndex, int TargetBridgeIndex);
record TransferCandidate(string OldLightId, string LegacyId, string Name, string? UniqueId);
record IdentifyLightRequest(int BridgeIndex = 1);
record ControlRequest(List<LightCommand> Commands);
record MusicScenePrepareRequest(List<ControlRequest> Frames);
record MusicSceneRecallRequest(int SceneIndex, int TransitionMs = 0);
record RenameLightRequest(string? Name, int BridgeIndex = 1);
record LightCommand(List<string> LightIds, string? HexColor, double Brightness = 100, int TransitionMs = 80, bool? On = true, string? GroupKey = null);
record GroupedLightCommand(List<string> LightIds, string? HexColor, double Brightness = 100, int TransitionMs = 0, bool? On = true);
record EntertainmentBridgeSelection(int BridgeIndex, Guid ConfigurationId);
record EntertainmentStartRequest(Guid? ConfigurationId, List<EntertainmentBridgeSelection>? Bridges);
record EntertainmentFrameRequest(List<LightCommand> Commands, int ScheduleAheadMs = 0);
record EntertainmentConfigurationSyncRequest(Guid? ConfigurationId, string? Name, List<string>? LightIds, int BridgeIndex = 1);
record SavedTrack(string Id, string FileName, string StoredFileName, long Size, DateTimeOffset CreatedAt, JsonElement Analysis);
record HueBridgeSettings(string? BridgeIp = null, string? ApplicationKey = null, string? ClientKey = null)
{
    [JsonIgnore] public bool IsPaired => !string.IsNullOrWhiteSpace(BridgeIp) && !string.IsNullOrWhiteSpace(ApplicationKey);
}
record BridgeStatus(int BridgeIndex, string? BridgeIp, bool Paired, bool Online);
record HueLightInfo(string Id, string Name, bool On, double Brightness, bool ColorCapable, string Connectivity, int BridgeIndex, string BridgeName);
record HueLegacyLight(string Name, string? UniqueId);
record LightControlResult(string LightId, bool Success, int Status);
record EntertainmentStartResult(int BridgeIndex, Guid ConfigurationId, string ConfigurationName, int ChannelCount, int MappedLights);
record EntertainmentFrameResult(int BridgeIndex, int UpdatedChannels, string[] IgnoredLightIds, bool Scheduled, long FrameId, int ScheduleAheadMs);

sealed class HueSettings
{
    public string? BridgeIp { get; set; }
    public string? ApplicationKey { get; set; }
    public string? ClientKey { get; set; }
    public string? Bridge2Ip { get; set; }
    public string? ApplicationKey2 { get; set; }
    public string? ClientKey2 { get; set; }

    public HueBridgeSettings GetBridge(int bridgeIndex) => bridgeIndex switch
    {
        1 => new(BridgeIp, ApplicationKey, ClientKey),
        2 => new(Bridge2Ip, ApplicationKey2, ClientKey2),
        _ => throw new ArgumentOutOfRangeException(nameof(bridgeIndex))
    };

    public void SetBridge(int bridgeIndex, HueBridgeSettings bridge)
    {
        if (bridgeIndex == 1) (BridgeIp, ApplicationKey, ClientKey) = (bridge.BridgeIp, bridge.ApplicationKey, bridge.ClientKey);
        else if (bridgeIndex == 2) (Bridge2Ip, ApplicationKey2, ClientKey2) = (bridge.BridgeIp, bridge.ApplicationKey, bridge.ClientKey);
        else throw new ArgumentOutOfRangeException(nameof(bridgeIndex));
    }

    public IEnumerable<(int Index, HueBridgeSettings Bridge)> ConfiguredBridges()
    {
        for (var index = 1; index <= 2; index++)
        {
            var bridge = GetBridge(index);
            if (bridge.IsPaired) yield return (index, bridge);
        }
    }
}

sealed class EntertainmentSessionManager
{
    private readonly Func<Task<HueBridgeSettings>> _loadSettings;
    private readonly int _bridgeIndex;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly object _streamSync = new();
    private StreamingHueClient? _client;
    private StreamingGroup? _group;
    private EntertainmentLayer? _layer;
    private CancellationTokenSource? _updateCancellation;
    private Task? _updateTask;
    private Guid? _configurationId;
    private string? _configurationName;
    private Dictionary<Guid, HashSet<Guid>> _lightToEntertainmentServiceIds = [];
    private string? _streamError;
    private ScheduledEntertainmentFrame? _pendingFrame;
    private long _nextFrameId;
    private long _lastAppliedFrameId;

    public EntertainmentSessionManager(Func<Task<HueBridgeSettings>> loadSettings, int bridgeIndex)
        => (_loadSettings, _bridgeIndex) = (loadSettings, bridgeIndex);

    public bool IsActive => _client is not null && _configurationId.HasValue && _updateTask is { IsCompleted: false };

    public object GetStatus() => new
    {
        Active = _client is not null && _configurationId.HasValue && _updateTask is { IsCompleted: false },
        ConfigurationId = _configurationId,
        ConfigurationName = _configurationName,
        ChannelCount = _layer?.Count ?? 0,
        Error = _streamError,
        PendingFrameId = _pendingFrame?.Id,
        LastAppliedFrameId = _lastAppliedFrameId
    };

    public async Task<object[]> GetConfigurationsAsync()
    {
        var settings = await GetEntertainmentSettingsAsync();
        using var client = new StreamingHueClient(settings.BridgeIp!, settings.ApplicationKey!, settings.ClientKey!);
        var response = await client.LocalHueApi.EntertainmentConfiguration.GetAllAsync();
        if (response.HasErrors) throw new InvalidOperationException("Bridge가 Entertainment 영역 조회를 거부했습니다.");

        var lightsResponse = await client.LocalHueApi.Light.GetAllAsync();
        var entertainmentResponse = await client.LocalHueApi.Entertainment.GetAllAsync();
        if (lightsResponse.HasErrors || entertainmentResponse.HasErrors)
            throw new InvalidOperationException("Entertainment 영역의 전구 구성을 가져오지 못했습니다.");
        var lightByDevice = lightsResponse.Data
            .Where(light => light.Owner is not null)
            .GroupBy(light => light.Owner!.Rid)
            .ToDictionary(group => group.Key, group => group.First().Id);
        var lightByEntertainmentService = entertainmentResponse.Data
            .Where(service => service.Owner is not null && lightByDevice.ContainsKey(service.Owner.Rid))
            .ToDictionary(service => service.Id, service => lightByDevice[service.Owner!.Rid]);

        return response.Data.Select(configuration => (object)new
        {
            BridgeIndex = _bridgeIndex,
            configuration.Id,
            Name = string.IsNullOrWhiteSpace(configuration.Metadata?.Name) ? "이름 없는 Entertainment 영역" : configuration.Metadata.Name,
            ChannelCount = configuration.Channels?.Count ?? 0,
            Status = configuration.Status.ToString(),
            LightIds = configuration.Channels?
                .SelectMany(channel => channel.Members ?? [])
                .Where(member => member.Service is not null && lightByEntertainmentService.ContainsKey(member.Service.Rid))
                .Select(member => lightByEntertainmentService[member.Service!.Rid])
                .Distinct()
                .ToArray() ?? [],
            Channels = configuration.Channels?.Select(channel => new
            {
                channel.ChannelId,
                LightIds = channel.Members?.Where(member => member.Service is not null).Select(member => member.Service!.Rid).Distinct().ToArray() ?? []
            }).ToArray() ?? []
        }).ToArray();
    }

    public async Task<EntertainmentStartResult> StartAsync(Guid configurationId)
    {
        await _gate.WaitAsync();
        try
        {
            await StopCoreAsync();
            var settings = await GetEntertainmentSettingsAsync();
            var client = new StreamingHueClient(settings.BridgeIp!, settings.ApplicationKey!, settings.ClientKey!);
            try
            {
                var response = await client.LocalHueApi.EntertainmentConfiguration.GetAllAsync();
                var configuration = response.Data.FirstOrDefault(item => item.Id == configurationId)
                    ?? throw new InvalidOperationException("선택한 Entertainment 영역을 Bridge에서 찾지 못했습니다.");
                if (configuration.Channels is null || configuration.Channels.Count == 0)
                    throw new InvalidOperationException("선택한 Entertainment 영역에 컬러 조명이 없습니다.");

                var group = new StreamingGroup(configuration.Channels);
                var layer = group.GetNewLayer(true);
                var lightsResponse = await client.LocalHueApi.Light.GetAllAsync();
                var entertainmentResponse = await client.LocalHueApi.Entertainment.GetAllAsync();
                if (lightsResponse.HasErrors || entertainmentResponse.HasErrors)
                    throw new InvalidOperationException("전구와 Entertainment 서비스 ID 매핑을 가져오지 못했습니다.");
                var entertainmentByOwner = entertainmentResponse.Data
                    .Where(service => service.Owner is not null)
                    .GroupBy(service => service.Owner!.Rid)
                    .ToDictionary(grouping => grouping.Key, grouping => grouping.Select(service => service.Id).ToHashSet());
                var lightToServices = lightsResponse.Data
                    .Where(light => light.Owner is not null && entertainmentByOwner.ContainsKey(light.Owner.Rid))
                    .ToDictionary(light => light.Id, light => entertainmentByOwner[light.Owner!.Rid]);
                await client.ConnectAsync(configuration.Id);
                var cancellation = new CancellationTokenSource();

                _client = client;
                _group = group;
                _layer = layer;
                _updateCancellation = cancellation;
                _configurationId = configuration.Id;
                _configurationName = configuration.Metadata?.Name ?? "Entertainment 영역";
                _lightToEntertainmentServiceIds = lightToServices;
                _streamError = null;
                _updateTask = RunStreamLoopAsync(client, group, cancellation.Token);
                return new EntertainmentStartResult(_bridgeIndex, configuration.Id, _configurationName, layer.Count, lightToServices.Count);
            }
            catch
            {
                client.Dispose();
                throw;
            }
        }
        finally { _gate.Release(); }
    }

    public async Task<EntertainmentFrameResult> SendFrameAsync(List<LightCommand> commands, int scheduleAheadMs = 0, long? targetTimestamp = null)
    {
        await _gate.WaitAsync();
        try
        {
            if (_client is null || _layer is null || _configurationId is null)
                throw new InvalidOperationException("먼저 Entertainment 영역을 연결하세요.");
            if (commands.Count == 0) throw new InvalidOperationException("전송할 색상 프레임이 없습니다.");

            if (_updateTask is { IsCompleted: true })
                throw new InvalidOperationException($"Entertainment 스트림이 끊겼습니다. 다시 연결하세요. {_streamError}".Trim());

            var safeAheadMs = Math.Clamp(scheduleAheadMs, 0, 250);
            lock (_streamSync)
            {
                var prepared = PrepareFrame(commands);
                if (safeAheadMs > 0)
                {
                    var frameId = ++_nextFrameId;
                    _pendingFrame = new ScheduledEntertainmentFrame(
                        frameId,
                        targetTimestamp ?? Stopwatch.GetTimestamp() + (long)(safeAheadMs / 1000.0 * Stopwatch.Frequency),
                        prepared);
                    return new EntertainmentFrameResult(_bridgeIndex, prepared.UpdatedChannels.Count,
                        prepared.IgnoredLightIds, true, frameId, safeAheadMs);
                }

                ApplyPreparedFrame(prepared);
                _client.ManualUpdate(_group!, onlySendDirtyStates: false);
                _lastAppliedFrameId = ++_nextFrameId;
                return new EntertainmentFrameResult(_bridgeIndex, prepared.UpdatedChannels.Count,
                    prepared.IgnoredLightIds, false, _lastAppliedFrameId, 0);
            }
        }
        finally { _gate.Release(); }
    }

    public async Task StopAsync()
    {
        await _gate.WaitAsync();
        try { await StopCoreAsync(); }
        finally { _gate.Release(); }
    }

    private async Task StopCoreAsync()
    {
        var client = _client;
        var configurationId = _configurationId;
        _updateCancellation?.Cancel();
        if (_updateTask is not null)
        {
            try { await _updateTask.WaitAsync(TimeSpan.FromSeconds(2)); }
            catch { }
        }
        if (client is not null && configurationId.HasValue)
        {
            try { await client.LocalHueApi.SetStreamingAsync(configurationId.Value, false); }
            catch { }
            try { client.Dispose(); }
            catch (ObjectDisposedException) { }
        }
        _client = null;
        _group = null;
        _layer = null;
        _updateCancellation?.Dispose();
        _updateCancellation = null;
        _updateTask = null;
        _configurationId = null;
        _configurationName = null;
        _lightToEntertainmentServiceIds = [];
        _streamError = null;
        _pendingFrame = null;
        _nextFrameId = 0;
        _lastAppliedFrameId = 0;
    }

    private async Task RunStreamLoopAsync(StreamingHueClient client, StreamingGroup group, CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                lock (_streamSync)
                {
                    if (_pendingFrame is { } pending && Stopwatch.GetTimestamp() >= pending.TargetTimestamp)
                    {
                        ApplyPreparedFrame(pending.Frame);
                        _lastAppliedFrameId = pending.Id;
                        _pendingFrame = null;
                    }
                    client.ManualUpdate(group, onlySendDirtyStates: false);
                }
                await Task.Delay(20, cancellationToken);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
        catch (Exception ex) { _streamError = ex.Message; }
    }

    private PreparedEntertainmentFrame PrepareFrame(List<LightCommand> commands)
    {
        var channelStates = new Dictionary<byte, PreparedChannelState>();
        var ignoredLightIds = new HashSet<string>();
        foreach (var command in commands)
        {
            var requestedIds = command.LightIds.Distinct()
                .Select(id => Guid.TryParse(id, out var parsed) ? parsed : Guid.Empty)
                .Where(id => id != Guid.Empty)
                .ToHashSet();
            var requestedServiceIds = requestedIds
                .Where(_lightToEntertainmentServiceIds.ContainsKey)
                .SelectMany(id => _lightToEntertainmentServiceIds[id])
                .ToHashSet();
            var matchedLightIds = new HashSet<Guid>();
            var color = new RGBColor(command.On == false ? "000000" : (command.HexColor ?? "FFFFFF").TrimStart('#'));
            var brightness = command.On == false ? 0 : Math.Clamp(command.Brightness / 100.0, 0, 1);
            var transition = TimeSpan.FromMilliseconds(Math.Clamp(command.TransitionMs, 0, 1000));

            foreach (var light in _layer!.Where(light => light.DeviceIds.Any(requestedServiceIds.Contains)))
            {
                channelStates[light.Id] = new PreparedChannelState(light, color, brightness, transition);
                foreach (var requestedLightId in requestedIds.Where(id =>
                    _lightToEntertainmentServiceIds.TryGetValue(id, out var serviceIds) && serviceIds.Overlaps(light.DeviceIds)))
                    matchedLightIds.Add(requestedLightId);
            }
            foreach (var id in requestedIds.Except(matchedLightIds)) ignoredLightIds.Add(id.ToString());
        }
        return new PreparedEntertainmentFrame(channelStates, ignoredLightIds.ToArray());
    }

    private static void ApplyPreparedFrame(PreparedEntertainmentFrame frame)
    {
        foreach (var state in frame.ChannelStates.Values)
            state.Light.SetState(CancellationToken.None, state.Color, state.Brightness, state.Transition);
    }

    private sealed record PreparedChannelState(EntertainmentLight Light, RGBColor Color, double Brightness, TimeSpan Transition);
    private sealed record PreparedEntertainmentFrame(Dictionary<byte, PreparedChannelState> ChannelStates, string[] IgnoredLightIds)
    {
        public ICollection<byte> UpdatedChannels => ChannelStates.Keys;
    }
    private sealed record ScheduledEntertainmentFrame(long Id, long TargetTimestamp, PreparedEntertainmentFrame Frame);

    private async Task<HueBridgeSettings> GetEntertainmentSettingsAsync()
    {
        var settings = await _loadSettings();
        if (!settings.IsPaired)
            throw new InvalidOperationException("먼저 Bridge를 인증하세요.");
        if (string.IsNullOrWhiteSpace(settings.ClientKey))
            throw new InvalidOperationException("Entertainment client key가 없습니다. Bridge 중앙 버튼을 누르고 다시 인증하세요.");
        return settings;
    }
}

static class ColorConverter
{
    public static (double X, double Y) HexToXy(string hex)
    {
        hex = hex.Trim().TrimStart('#');
        if (hex.Length != 6 || !int.TryParse(hex, System.Globalization.NumberStyles.HexNumber, null, out var rgb))
            throw new ArgumentException("색상은 #RRGGBB 형식이어야 합니다.");

        var r = ((rgb >> 16) & 0xff) / 255.0;
        var g = ((rgb >> 8) & 0xff) / 255.0;
        var b = (rgb & 0xff) / 255.0;
        r = r > 0.04045 ? Math.Pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
        g = g > 0.04045 ? Math.Pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
        b = b > 0.04045 ? Math.Pow((b + 0.055) / 1.055, 2.4) : b / 12.92;

        var xValue = r * 0.664511 + g * 0.154324 + b * 0.162028;
        var yValue = r * 0.283881 + g * 0.668433 + b * 0.047685;
        var zValue = r * 0.000088 + g * 0.072310 + b * 0.986039;
        var sum = xValue + yValue + zValue;
        return sum <= 0.000001 ? (0.3227, 0.3290) : (Math.Round(xValue / sum, 4), Math.Round(yValue / sum, 4));
    }
}
