"""Read-only integration checks against a running localhost server with comparison data."""
import json
import urllib.error
import urllib.request

BASE = 'http://127.0.0.1:5188'


def read(path):
    with urllib.request.urlopen(BASE + path, timeout=20) as response:
        return json.load(response)


projects = read('/api/offline-review/projects')
assert projects, 'This smoke test requires at least one completed private comparison'
project = projects[0]
revision = project['revisions'][0]['analysisId']
assert len(project['projectId']) == 64 and len(revision) == 32
path = '/api/offline-review/projects/' + project['projectId']
analysis = read(path + '/analyses/' + revision)
assert analysis['analysisId'] == revision
assert len(analysis['waveform']['timesSec']) == len(analysis['waveform']['rms'])
assert 'environment' not in analysis and 'sourceHash' not in analysis
assert analysis['candidates']['librosa']['status'] == 'complete'
show = read(path + '/analyses/' + revision + '/show')
assert show['schemaVersion'] == 1 and show['analysisId'] == revision
assert show['playbackHash'] == analysis['playbackHash'] and show['version'] >= 0
assert isinstance(show['sections'], list)
request = urllib.request.Request(BASE + path + '/audio', headers={'Range': 'bytes=0-43'})
with urllib.request.urlopen(request, timeout=20) as response:
    assert response.status == 206
    assert response.headers['Content-Type'].startswith('audio/wav')
    assert response.read(4) == b'RIFF'
for suffix in ['/api/offline-review/projects/not-a-hash/audio', path + '/analyses/not-a-revision', path + '/analyses/' + revision + '.pending']:
    try:
        urllib.request.urlopen(BASE + suffix, timeout=20)
        raise AssertionError('Invalid identifiers should be rejected')
    except urllib.error.HTTPError as error:
        assert error.code == 404
print('PASS: completed project/revision listing, selective result, range audio, invalid/pending ID rejection')
