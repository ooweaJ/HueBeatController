using System.Text.Json;
using System.Text.RegularExpressions;

// Versioned show edits only; analysis files are never written by this store.
internal sealed record ShowSection(double Start, double End);
internal sealed record ShowEdit(int BaseVersion, ShowSection[] Sections);
internal sealed record OfflineShow(int SchemaVersion, string AnalysisId, string PlaybackHash,
    int Version, ShowSection[] Sections);
internal sealed class ShowConflictException : Exception;
internal static partial class OfflineShowStore
{
    private static readonly object Gate = new();
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    [GeneratedRegex("^[0-9]{8}\\.json$", RegexOptions.CultureInvariant)]
    private static partial Regex SnapshotName();

    public static ShowSection[] Validate(ShowSection[]? sections, double duration)
    {
        if (sections is null || sections.Length > 20 || !double.IsFinite(duration) || duration <= 0)
            throw new ArgumentException("클라이맥스 구간은 최대 20개입니다.");
        var sorted = sections.OrderBy(s => s?.Start ?? double.NaN).ToArray();
        double previousEnd = -1;
        foreach (var section in sorted)
        {
            if (section is null || !double.IsFinite(section.Start) || !double.IsFinite(section.End) ||
                section.Start < 0 || section.End > duration || section.End - section.Start < .1 || section.Start < previousEnd)
                throw new ArgumentException("구간은 곡 범위 안에서 0.1초 이상이어야 하며 서로 겹칠 수 없습니다.");
            previousEnd = section.End;
        }
        return sorted;
    }
    private static void CheckDirectory(string path)
    {
        if (File.Exists(path) || (Directory.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0))
            throw new IOException("안전하지 않은 연출 저장 경로입니다.");
    }
    private static string Folder(string project, string analysisId)
    {
        if (!Regex.IsMatch(analysisId, "\\A[0-9a-f]{32}\\z")) throw new ArgumentException("잘못된 분석 ID입니다.");
        CheckDirectory(project);
        var parent = Path.Combine(project, "shows"); CheckDirectory(parent);
        var folder = Path.Combine(parent, analysisId); CheckDirectory(folder);
        return folder;
    }
    public static OfflineShow Read(string project, string analysisId, string playbackHash, double duration)
    {
        var folder = Folder(project, analysisId);
        var latest = Directory.Exists(folder) ? Directory.EnumerateFiles(folder)
            .Where(p => SnapshotName().IsMatch(Path.GetFileName(p))).OrderByDescending(p => p, StringComparer.Ordinal).FirstOrDefault() : null;
        if (latest is null) return new(1, analysisId, playbackHash, 0, []);
        if ((File.GetAttributes(latest) & FileAttributes.ReparsePoint) != 0 || new FileInfo(latest).Length > 65536)
            throw new IOException("연출 저장 파일을 읽을 수 없습니다.");
        var show = JsonSerializer.Deserialize<OfflineShow>(File.ReadAllText(latest), Json) ?? throw new IOException("빈 연출 파일입니다.");
        if (show.SchemaVersion != 1 || show.AnalysisId != analysisId || show.PlaybackHash != playbackHash ||
            show.Version != int.Parse(Path.GetFileNameWithoutExtension(latest)))
            throw new IOException("연출과 분석의 식별 정보가 다릅니다.");
        return show with { Sections = Validate(show.Sections, duration) };
    }
    public static OfflineShow Save(string project, string analysisId, string playbackHash, double duration, ShowEdit edit)
    {
        var sections = Validate(edit.Sections, duration);
        lock (Gate)
        {
            var previous = Read(project, analysisId, playbackHash, duration);
            if (edit.BaseVersion != previous.Version) throw new ShowConflictException();
            if (previous.Version >= 99999999) throw new IOException("연출 버전 한도를 초과했습니다.");
            var result = new OfflineShow(1, analysisId, playbackHash, previous.Version + 1, sections);
            var folder = Folder(project, analysisId); Directory.CreateDirectory(folder);
            var target = Path.Combine(folder, $"{result.Version:D8}.json");
            var temporary = Path.Combine(folder, $"pending-{Guid.NewGuid():N}.json");
            try
            {
                using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    JsonSerializer.Serialize(file, result, Json); file.Flush(flushToDisk: true);
                }
                try { File.Move(temporary, target, overwrite: false); }
                catch (IOException) when (File.Exists(target)) { throw new ShowConflictException(); }
                return result;
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
    }
}
