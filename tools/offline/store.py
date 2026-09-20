"""Private, append-only experiment storage. Never calls the legacy HTTP API."""
import hashlib
import json
import math
import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path


def now():
    return datetime.now(timezone.utc).isoformat()


def sha256(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def write_new_json(path, value):
    """Exclusive creation in a private staging directory; never overwrites a revision."""
    text = json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2)
    with Path(path).open('x', encoding='utf-8') as stream:
        stream.write(text + '\n')
        stream.flush()
        os.fsync(stream.fileno())


def legacy_files(repo):
    data = Path(repo).resolve() / 'data'
    paths = list(data.glob('*.json')) + list((data / 'tracks').glob('*'))
    paths += [data / 'ledfx-engine' / 'config.json']
    for path in sorted(p for p in paths if p.is_file()):
        if path.is_symlink() or not path.resolve().is_relative_to(data):
            raise ValueError('Legacy links outside data are not supported')
        yield path


def snapshot(repo):
    """Copy settings and all saved tracks, excluding mutable logs and derived projects."""
    repo = Path(repo).resolve()
    parent = repo / 'data' / 'offline-backups'
    parent.mkdir(parents=True, exist_ok=True)
    sid = uuid.uuid4().hex
    stage = parent / (sid + '.pending')
    stage.mkdir()
    files = []
    for source in legacy_files(repo):
        relative = source.relative_to(repo / 'data').as_posix()
        before = sha256(source)
        target = stage / 'files' / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        if sha256(target) != before or sha256(source) != before:
            raise RuntimeError('Legacy data changed during snapshot; pending backup is not valid')
        files.append({'path': relative, 'sha256': before, 'bytes': source.stat().st_size})
    write_new_json(stage / 'manifest.json', {'schemaVersion': 1, 'createdAt': now(), 'files': files})
    final = parent / sid
    stage.rename(final)
    return final


def verify_snapshot(repo, backup):
    repo, backup = Path(repo).resolve(), Path(backup).resolve()
    manifest = read_json(backup / 'manifest.json')
    changed = []
    expected = {row['path'] for row in manifest['files']}
    changed.extend(p.relative_to(repo / 'data').as_posix() for p in legacy_files(repo)
                   if p.relative_to(repo / 'data').as_posix() not in expected)
    for row in manifest['files']:
        relative = Path(row['path'])
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('Invalid snapshot path')
        original = repo / 'data' / relative
        copied = backup / 'files' / relative
        if not original.is_file() or sha256(original) != row['sha256']:
            changed.append(row['path'])
        if not copied.is_file() or sha256(copied) != row['sha256']:
            raise ValueError('Backup integrity failure: ' + row['path'])
    return changed


def validate_times(values, duration):
    previous = -1.0
    for value in values:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError('Event time must be numeric seconds')
        if not math.isfinite(value) or not 0 <= value < duration or value <= previous:
            raise ValueError('Event times must be finite, strictly ordered, unique and within audio')
        previous = value


def validate_analysis(value):
    if value.get('schemaVersion') != 1 or value.get('kind') != 'offline-analysis':
        raise ValueError('Not a version 1 offline analysis')
    duration = value['durationSec']
    if not isinstance(duration, (float, int)) or not math.isfinite(duration) or duration <= 0:
        raise ValueError('Invalid duration')
    for name in ('sourceHash', 'playbackHash'):
        if len(value[name]) != 64 or any(c not in '0123456789abcdef' for c in value[name]):
            raise ValueError('Invalid audio hash')
    for candidate in value['candidates'].values():
        if candidate['status'] not in ('complete', 'not-run'):
            raise ValueError('Incomplete candidate cannot be committed')
        for name in ('onsetsSec', 'beatsSec', 'downbeatsSec'):
            validate_times(candidate.get(name, []), duration)
    features = value['features']
    rhythm = value.get('rhythm')
    if rhythm is not None:
        model = value['candidates']['beat-this']
        if rhythm['source'] != 'beat-this' or rhythm['status'] != model['status'] or rhythm['timeOriginSec'] != 0:
            raise ValueError('Invalid canonical rhythm source or time origin')
        for key in ('beatsSec', 'downbeatsSec'):
            if rhythm[key] != model.get(key, []):
                raise ValueError('Rhythm must preserve model timestamps without a synthesized grid')
        if rhythm['onsetsSec'] != value['candidates']['librosa']['onsetsSec']:
            raise ValueError('Rhythm onset timestamps differ from the onset extractor')
    validate_times(features['timesSec'], duration)
    size = len(features['timesSec'])
    for key, values in features.items():
        if key == 'timesSec':
            continue
        if len(values) != size or any(not math.isfinite(x) or x < 0 for x in values):
            raise ValueError('Feature shape/range mismatch: ' + key)
    # These are observations, not a generated/approved lighting score.
    if 'lightingEvents' in value or 'beatTimes' in value:
        raise ValueError('Do not mix legacy lighting events with analysis')
