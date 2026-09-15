using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Net.Http.Json;
using System.Text.Json;

// Protocol adapter only. Music analysis and effects run in unmodified LedFx.
sealed class LedFxBridge : IDisposable
{
    private readonly HttpClient http = new() { BaseAddress = new Uri("http://127.0.0.1:8888"), Timeout = TimeSpan.FromSeconds(15) };
    private readonly CancellationTokenSource cancellation = new();
    private readonly SemaphoreSlim gate = new(1);
    private readonly UdpClient receiver;
    private readonly string root;
    private Process? child;
    private RgbSnapshot latest = new(0, 0, []);
    public LedFxBridge(string root)
    {
        this.root = root;
        receiver = new UdpClient(new IPEndPoint(IPAddress.Loopback, 21325));
        _ = Receive();
    }
    private async Task Receive()
    {
        try
        {
            while (!cancellation.IsCancellationRequested)
            {
                var packet = await receiver.ReceiveAsync(cancellation.Token);
                var bytes = packet.Buffer;
                // WLED DRGB: [2, timeout, R,G,B, ...]. Only a full 1..5-pair frame.
                if (bytes.Length < 5 || bytes.Length > 17 || bytes[0] != 2 || (bytes.Length - 2) % 3 != 0) continue;
                var previous = Volatile.Read(ref latest);
                Volatile.Write(ref latest, new RgbSnapshot(previous.Sequence + 1, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), bytes[2..].Select(b => (int)b).ToArray()));
            }
        }
        catch (OperationCanceledException) { }
        catch (ObjectDisposedException) { }
    }
    public object Frame()
    {
        var frame = Volatile.Read(ref latest);
        return new { frame.Sequence, frame.Timestamp, frame.Rgb, stale = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - frame.Timestamp > 1000 };
    }
    public async Task<object> Status()
    {
        try
        {
            using var response = await http.GetAsync("/api/info");
            return new { available = response.IsSuccessStatusCode, installed = File.Exists(PythonPath), udpPort = 21325 };
        }
        catch (HttpRequestException) { return new { available = false, installed = File.Exists(PythonPath), udpPort = 21325 }; }
        catch (TaskCanceledException) { return new { available = false, installed = File.Exists(PythonPath), udpPort = 21325 }; }
    }
    private string PythonPath => Path.Combine(root, "tmp", "ledfx-venv", "Scripts", "python.exe");
    public async Task Start()
    {
        await gate.WaitAsync();
        try
        {
            try { using var response = await http.GetAsync("/api/info"); if (response.IsSuccessStatusCode) return; } catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException) { }
            if (!File.Exists(PythonPath)) throw new InvalidOperationException("먼저 setup-ledfx.ps1을 실행해 LedFx를 설치하세요.");
            if (child is { HasExited: false }) return;
            var start = new ProcessStartInfo(PythonPath) { WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden };
            foreach (var arg in new[] { "-m", "ledfx", "--offline", "--no-tray", "--host", "127.0.0.1", "--port", "8888", "--config", Path.Combine(root, "data", "ledfx-engine") }) start.ArgumentList.Add(arg);
            child = Process.Start(start) ?? throw new InvalidOperationException("LedFx를 시작하지 못했습니다.");
        }
        finally { gate.Release(); }
    }
    private async Task<JsonElement> Request(HttpMethod method, string path, object? body = null)
    {
        using var request = new HttpRequestMessage(method, path);
        if (body is not null) request.Content = JsonContent.Create(body);
        using var response = await http.SendAsync(request);
        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        if (!response.IsSuccessStatusCode || (json.TryGetProperty("status", out var status) && status.GetString() == "failed"))
            throw new InvalidOperationException($"LedFx 요청 실패 ({(int)response.StatusCode}): {json}");
        return json;
    }
    public async Task<object> Configure(int pairs, string effect, string client)
    {
        if (pairs is < 1 or > 5 || !new[] { "energy", "bar", "power" }.Contains(effect) || client != "HueBeat-Web")
            throw new InvalidOperationException("지원하지 않는 LedFx 설정입니다.");
        await gate.WaitAsync();
        try
        {
            var devices = await Request(HttpMethod.Get, "/api/devices");
            var id = $"huebeat-{pairs}";
            // Clear only our previous experimental output virtuals.
            foreach (var device in devices.GetProperty("devices").EnumerateObject())
                if (Enumerable.Range(1, 5).Any(n => device.Name == $"huebeat-{n}") && device.Name != id)
                {
                    await Request(HttpMethod.Delete, $"/api/virtuals/{device.Name}/effects");
                    // LedFx disallows duplicate IP/port even for inactive devices.
                    await Request(HttpMethod.Delete, $"/api/devices/{device.Name}");
                }
            if (!devices.GetProperty("devices").TryGetProperty(id, out _))
                await Request(HttpMethod.Post, "/api/devices", new { type = "udp", config = new { name = $"HueBeat-{pairs}", ip_address = "127.0.0.1", pixel_count = pairs, port = 21325, udp_packet_type = "DRGB", minimise_traffic = false, refresh_rate = 30 } });
            JsonElement audio;
            try { audio = await Request(HttpMethod.Get, "/api/audio/devices"); }
            catch (InvalidOperationException ex) when (ex.Message.Contains("tuple index out of range"))
            {
                // Upstream 87583f9 default-device lookup indexes the physical list
                // with a web-device index on output-only PCs. Select the first web
                // index via the official config API; do not patch audio analysis.
                var probe = new ProcessStartInfo(PythonPath) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true };
                probe.ArgumentList.Add("-c");
                probe.ArgumentList.Add("import sounddevice; print(len(sounddevice.query_devices()))");
                using var process = Process.Start(probe) ?? throw new InvalidOperationException("오디오 장치 조회 실패");
                var output = await process.StandardOutput.ReadToEndAsync();
                await process.WaitForExitAsync();
                if (!int.TryParse(output.Trim(), out var webIndex)) throw new InvalidOperationException("웹 오디오 장치 번호를 확인하지 못했습니다.");
                await Request(HttpMethod.Put, "/api/config", new { audio = new { audio_device = webIndex } });
                audio = await Request(HttpMethod.Get, "/api/audio/devices");
            }
            var input = audio.GetProperty("devices").EnumerateObject().FirstOrDefault(p => p.Value.GetString() == $"WEB AUDIO: {client}");
            if (input.Name is null) throw new InvalidOperationException("웹 오디오 등록을 기다린 뒤 다시 연결하세요.");
            // Select web input in persistent config BEFORE an effect creates audio.
            await Request(HttpMethod.Put, "/api/config", new { audio = new { audio_device = int.Parse(input.Name) } });
            await Request(HttpMethod.Post, $"/api/virtuals/{id}/effects", new { type = effect, config = new { } });
            await Request(HttpMethod.Put, "/api/audio/devices", new { audio_device = int.Parse(input.Name) });
            return new { id, effect, pairs };
        }
        finally { gate.Release(); }
    }
    public async Task Clear()
    {
        await gate.WaitAsync();
        try
        {
            var devices = await Request(HttpMethod.Get, "/api/devices");
            foreach (var device in devices.GetProperty("devices").EnumerateObject())
                if (device.Name.StartsWith("huebeat-"))
                    await Request(HttpMethod.Delete, $"/api/virtuals/{device.Name}/effects");
            Volatile.Write(ref latest, new RgbSnapshot(0, 0, []));
        }
        finally { gate.Release(); }
    }
    public void Dispose()
    {
        cancellation.Cancel(); receiver.Dispose(); http.Dispose();
        if (child is { HasExited: false }) child.Kill(entireProcessTree: true);
        child?.Dispose();
    }
    private sealed record RgbSnapshot(long Sequence, long Timestamp, int[] Rgb);
}
record LedFxConfigureRequest(int Pairs, string Effect, string Client);
