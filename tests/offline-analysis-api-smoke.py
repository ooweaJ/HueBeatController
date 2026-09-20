"""Integration check with the real local model and generated audio; never calls Hue.

Run the server, then: tmp/offline-analysis-venv/Scripts/python.exe tests/offline-analysis-api-smoke.py
Pass --keep to retain generated audio for visual inspection. No existing project is edited.
"""
import hashlib
import io
import json
from pathlib import Path
import shutil
import sys
import time
import urllib.error
import urllib.request
import uuid

import numpy as np
import soundfile as sf

BASE = 'http://127.0.0.1:5188'


def request(path, payload=None, method=None, headers=None, expected=200):
    req = urllib.request.Request(BASE + path, data=payload, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            code, raw = response.status, response.read()
    except urllib.error.HTTPError as error:
        code, raw = error.code, error.read()
    assert code == expected, (code, raw[:500])
    return json.loads(raw) if raw else None


def upload(audio, name='generated-rhythm.wav', expected=202, origin=None):
    boundary = 'huebeat-' + uuid.uuid4().hex
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="audio"; filename="{name}"\r\n'
            'Content-Type: audio/wav\r\n\r\n').encode() + audio + f'\r\n--{boundary}--\r\n'.encode()
    headers = {'Content-Type': 'multipart/form-data; boundary=' + boundary}
    if origin:
        headers['Origin'] = origin
    return request('/api/offline-analysis/jobs', body, headers=headers, expected=expected)


def wait(job):
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        result = request('/api/offline-analysis/jobs/' + job['id'])
        if result['status'] != 'running':
            return result
        time.sleep(.5)
    raise AssertionError('Test worker exceeded three minutes')


rate = 22050
rng = np.random.default_rng()
audio = np.zeros(rate * 16, dtype=np.float32)
for index, start in enumerate(np.arange(.2, 15.8, .5)):
    t = np.arange(int(rate * .18)) / rate
    pulse = .5 * np.sin(2 * np.pi * (65 if index % 4 == 0 else 110) * t) * np.exp(-t * 35)
    pulse += rng.normal(0, .03, len(t)) * np.exp(-t * 55)
    offset = round(start * rate)
    audio[offset:offset + len(t)] += pulse
buffer = io.BytesIO()
sf.write(buffer, audio, rate, format='WAV', subtype='PCM_16')
source = buffer.getvalue()
project_id = hashlib.sha256(source).hexdigest()
repo = Path(__file__).resolve().parents[1]
assert not (repo / 'data' / 'offline-projects' / project_id).exists(), 'Must use a new test project'

upload(source, origin='https://example.invalid', expected=403)
upload(source, name='unsupported.txt', expected=400)
first = upload(source)
upload(source, expected=409)
first = wait(first)
assert first['status'] == 'complete', first
assert first['projectId'] == project_id
base = '/api/offline-review/projects/' + project_id + '/analyses/'
analysis = request(base + first['analysisId'])
assert analysis['rhythm']['source'] == 'beat-this'
assert analysis['rhythm']['status'] == 'complete'
assert len(analysis['rhythm']['beatsSec']) > 0
assert len(analysis['rhythm']['downbeatsSec']) > 0
assert analysis['rhythm']['beatsSec'] == analysis['candidates']['beat-this']['beatsSec']
assert analysis['rhythm']['downbeatsSec'] == analysis['candidates']['beat-this']['downbeatsSec']
assert analysis['rhythm']['onsetsSec'] == analysis['candidates']['librosa']['onsetsSec']
show_url = base + first['analysisId'] + '/show'
edit = {'baseVersion': 0, 'sections': [{'start': 2, 'end': 4}]}
saved = request(show_url, json.dumps(edit).encode(), method='PUT', headers={'Content-Type': 'application/json'})
second = wait(upload(source))
assert second['status'] == 'complete', second
assert second['projectId'] == first['projectId'] and second['analysisId'] != first['analysisId']
assert request(show_url) == saved, 'Reanalysis overwrote a manual show'
repeated = request(base + second['analysisId'])
assert repeated['rhythm'] == analysis['rhythm'], 'Same audio/settings changed rhythm results'
assert request(base + second['analysisId'] + '/show')['version'] == 0
broken = wait(upload(b'not an audio file'))
assert broken['status'] == 'failed', broken
print('PASS: real model upload, canonical beat/downbeat output, repeatability, preserved show revision, invalid audio and concurrent-job rejection')
if '--keep' in sys.argv:
    print(BASE + '/analysis-review.html?project=' + project_id + '&revision=' + second['analysisId'])
else:
    parent = (repo / 'data' / 'offline-projects').resolve()
    generated = (parent / project_id).resolve()
    assert generated.parent == parent and generated.name == project_id
    shutil.rmtree(generated)  # This exact hash was verified absent before the test.
