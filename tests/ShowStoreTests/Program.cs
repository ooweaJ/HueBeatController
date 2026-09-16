using System.Security.Cryptography;

var directory = Path.Combine(Path.GetTempPath(), "hue-show-tests-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(directory);
var analysisId = new string('a', 32); var hash = new string('b', 64);
void Check(bool condition) { if (!condition) throw new Exception("Show store assertion failed"); }
void Throws<T>(Action action) where T : Exception
{
    try { action(); } catch (T) { return; }
    throw new Exception("Expected " + typeof(T).Name);
}
try
{
    var original = Path.Combine(directory, "analysis.json"); File.WriteAllText(original, "original analysis");
    var digest = SHA256.HashData(File.ReadAllBytes(original));
    Check(OfflineShowStore.Read(directory, analysisId, hash, 100).Version == 0);
    var one = OfflineShowStore.Save(directory, analysisId, hash, 100, new(0, [new(20,30), new(5,10)]));
    Check(one.Version == 1 && one.Sections[0].Start == 5);
    var loaded = OfflineShowStore.Read(directory, analysisId, hash, 100);
    Check(loaded.Version == 1 && loaded.Sections.SequenceEqual(one.Sections));
    Throws<ShowConflictException>(() => OfflineShowStore.Save(directory, analysisId, hash, 100, new(0, [])));
    foreach (var sections in new ShowSection[][] { [new(-1,10)], [new(1,101)], [new(2,2)],
        [new(double.NaN,10)], [new(1,4),new(3,5)], [null!], Enumerable.Repeat(new ShowSection(1,2),21).ToArray() })
        Throws<ArgumentException>(() => OfflineShowStore.Save(directory, analysisId, hash, 100, new(1, sections)));
    var two = OfflineShowStore.Save(directory, analysisId, hash, 100, new(1, []));
    Check(two.Version == 2 && two.Sections.Length == 0);
    Check(File.Exists(Path.Combine(directory, "shows", analysisId, "00000001.json")));
    Check(OfflineShowStore.Read(directory, new string('c',32), hash, 100).Version == 0);
    Throws<IOException>(() => OfflineShowStore.Read(directory, analysisId, new string('c',64), 100));
    Throws<ArgumentException>(() => OfflineShowStore.Read(directory, "../bad", hash, 100));
    // Simultaneous saves from the same base must produce one winner, never overwrite.
    int wins = 0, conflicts = 0;
    Parallel.For(0, 8, _ => {
        try { OfflineShowStore.Save(directory, analysisId, hash, 100, new(2, [new(1,2)])); Interlocked.Increment(ref wins); }
        catch (ShowConflictException) { Interlocked.Increment(ref conflicts); }
    });
    Check(wins == 1 && conflicts == 7);
    var current = Path.Combine(directory, "shows", analysisId, "00000003.json");
    File.WriteAllText(current, "broken");
    Throws<System.Text.Json.JsonException>(() => OfflineShowStore.Save(directory, analysisId, hash, 100, new(3, [])));
    Check(File.ReadAllText(current) == "broken");
    Check(SHA256.HashData(File.ReadAllBytes(original)).SequenceEqual(digest));
    Console.WriteLine("PASS: save/reload, immutable revisions, validation, conflict, concurrent writers, analysis isolation, corrupt-data protection");
}
finally
{
    // This exact GUID directory was created above for these tests; never user data.
    Directory.Delete(directory, recursive: true);
}
