using System.Diagnostics;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace HueBeatKiosk;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new KioskForm());
    }
}

internal sealed class KioskForm : Form
{
    private const int ExitHotkey = 0x4842;
    private static readonly Uri Page = new("http://127.0.0.1:5188/piano/");
    private readonly WebView2 browser = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(17, 17, 39) };
    private readonly Label status = new() { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter,
        ForeColor = Color.White, BackColor = Color.FromArgb(17, 17, 39), Text = "피아노를 준비하고 있습니다…", Font = new Font("Malgun Gothic", 18) };
    private readonly CancellationTokenSource lifetime = new();
    private Process? ownedServer;
    private bool canClose, registered;

    public KioskForm()
    {
        Text = "HueBeat 피아노"; FormBorderStyle = FormBorderStyle.None; ControlBox = false;
        StartPosition = FormStartPosition.Manual; Bounds = Screen.FromPoint(Cursor.Position).Bounds;
        WindowState = FormWindowState.Maximized; TopMost = true; KeyPreview = true;
        Controls.Add(browser); Controls.Add(status);
        Shown += async (_, _) =>
        {
            try { await StartAsync(); }
            catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
            catch (Exception e) { if (!IsDisposed) status.Text = $"피아노를 시작하지 못했습니다.\n{e.Message}\n\n종료: Ctrl+Shift+Q"; }
        };
    }

    private async Task<bool> ServerReady(HttpClient client)
    {
        try
        {
            using var response = await client.GetAsync(new Uri(Page, "/api/piano/config"), lifetime.Token);
            if (!response.IsSuccessStatusCode) return false;
            using var data = JsonDocument.Parse(await response.Content.ReadAsStringAsync(lifetime.Token));
            return data.RootElement.TryGetProperty("enabled", out _) && data.RootElement.TryGetProperty("sound", out _);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException) { return false; }
    }

    private async Task StartAsync()
    {
        var baseBrightness = 0;
        var optionsPath = Path.Combine(AppContext.BaseDirectory, "kiosk-settings.json");
        if (File.Exists(optionsPath))
        {
            using var options = JsonDocument.Parse(await File.ReadAllTextAsync(optionsPath, lifetime.Token));
            if (options.RootElement.ValueKind != JsonValueKind.Object)
                throw new InvalidOperationException("kiosk-settings.json 설정 형식을 확인하세요.");
            if (options.RootElement.TryGetProperty("pianoBaseBrightnessPercent", out var brightness)
                && (brightness.ValueKind != JsonValueKind.Number || !brightness.TryGetInt32(out baseBrightness)
                    || baseBrightness is < 0 or > 100))
                throw new InvalidOperationException("kiosk-settings.json의 pianoBaseBrightnessPercent는 0~100 정수여야 합니다.");
        }
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        if (!await ServerReady(http))
        {
            try
            {
                using var occupied = await http.GetAsync(new Uri(Page, "/"), lifetime.Token);
                throw new InvalidOperationException("5188 포트를 다른 서버가 사용 중입니다. 해당 서버를 확인하세요.");
            }
            catch (HttpRequestException) { }
            catch (TaskCanceledException) when (!lifetime.IsCancellationRequested) { throw new InvalidOperationException("5188 포트의 서버 응답을 확인하세요."); }
            var executable = Path.Combine(AppContext.BaseDirectory, "server", "HueBeatController.exe");
            if (!File.Exists(executable)) throw new FileNotFoundException("배포 ZIP 전체를 압축 해제하세요. server 폴더가 필요합니다.");
            ownedServer = Process.Start(new ProcessStartInfo(executable)
            {
                WorkingDirectory = Path.GetDirectoryName(executable), UseShellExecute = false,
                CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden
            }) ?? throw new InvalidOperationException("내부 서버를 시작하지 못했습니다.");
            var ready = false;
            for (var i = 0; i < 60; i++)
            {
                if (ownedServer.HasExited) throw new InvalidOperationException("내부 서버가 종료되었습니다. 포트와 배포 폴더를 확인하세요.");
                if (await ServerReady(http)) { ready = true; break; }
                await Task.Delay(250, lifetime.Token);
            }
            if (!ready) throw new InvalidOperationException("내부 서버 시작 시간이 초과되었습니다.");
        }
        var profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "HueBeatKiosk", "WebView2");
        var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: profile);
        lifetime.Token.ThrowIfCancellationRequested();
        await browser.EnsureCoreWebView2Async(environment);
        var core = browser.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreHostObjectsAllowed = false;
        core.Settings.IsPinchZoomEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.Settings.IsSwipeNavigationEnabled = false;
        browser.ZoomFactor = 1;
        browser.ZoomFactorChanged += (_, _) => { if (browser.ZoomFactor != 1) browser.ZoomFactor = 1; };
        // Runs before page scripts, including when an existing local server serves an older page.
        await core.AddScriptToExecuteOnDocumentCreatedAsync(
            "window.__HUEBEAT_PIANO_BASE_BRIGHTNESS__ = " + JsonSerializer.Serialize(baseBrightness) + ";\n" + """
            window.__HUEBEAT_KIOSK__ = true;
            const lockKioskDocument = () => {
                if (document.documentElement) {
                    document.documentElement.dataset.kiosk = 'true';
                    document.documentElement.style.touchAction = 'none';
                    document.documentElement.style.overscrollBehavior = 'none';
                }
                document.getElementById('fullscreen')?.setAttribute('hidden', '');
            };
            new MutationObserver(lockKioskDocument).observe(document, {childList: true, subtree: true});
            lockKioskDocument();
            """);
        core.NewWindowRequested += (_, e) => e.Handled = true;
        core.DownloadStarting += (_, e) => e.Cancel = true;
        core.NavigationStarting += (_, e) => { if (!string.Equals(e.Uri, Page.AbsoluteUri, StringComparison.OrdinalIgnoreCase)) e.Cancel = true; };
        core.NavigationCompleted += (_, e) =>
        {
            status.Visible = !e.IsSuccess;
            if (!e.IsSuccess) status.Text = "피아노 화면을 열지 못했습니다.\n서버 연결을 확인한 뒤 다시 실행하세요.\n종료: Ctrl+Shift+Q";
        };
        browser.Source = Page;
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e); registered = RegisterHotKey(Handle, ExitHotkey, 0x0002 | 0x0004, (uint)Keys.Q);
    }
    protected override void OnHandleDestroyed(EventArgs e)
    {
        if (registered) UnregisterHotKey(Handle, ExitHotkey); base.OnHandleDestroyed(e);
    }
    protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
    {
        if (keyData == (Keys.Control | Keys.Shift | Keys.Q)) { OperatorExit(); return true; }
        if (keyData is Keys.F11 or Keys.Escape) return true;
        return base.ProcessCmdKey(ref msg, keyData);
    }
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == 0x0312 && m.WParam.ToInt32() == ExitHotkey) { OperatorExit(); return; }
        base.WndProc(ref m);
    }
    private void OperatorExit() { canClose = true; Close(); }
    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!canClose && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; return; }
        lifetime.Cancel(); base.OnFormClosing(e);
    }
    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        browser.Dispose();
        try { if (ownedServer is { HasExited: false }) ownedServer.Kill(entireProcessTree: true); }
        catch (InvalidOperationException) { }
        ownedServer?.Dispose(); lifetime.Dispose(); base.OnFormClosed(e);
    }
    [DllImport("user32.dll", SetLastError = true)] private static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool UnregisterHotKey(IntPtr window, int id);
}
