"""Isolated settings/API checks. Starts no Hue stream and never uses user settings."""
import json
import os
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DLL = Path(os.environ.get('HUE_PIANO_TEST_DLL', ROOT / 'bin/Debug/net10.0/HueBeatController.dll'))
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    PORT = sock.getsockname()[1]
BASE = f'http://127.0.0.1:{PORT}'


def request(path, method='GET', body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data, {'Content-Type': 'application/json'}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def launch(folder):
    Path(folder, 'wwwroot').mkdir(exist_ok=True)
    child = subprocess.Popen(['dotnet', str(DLL),
                              '--contentRoot', folder, '--urls', BASE, '--Logging:EventLog:LogLevel:Default', 'None'], cwd=ROOT,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    for _ in range(20):
        if child.poll() is not None:
            raise RuntimeError('Isolated server failed to start (another server may own UDP 21325)')
        try:
            if request('/api/piano/config')[0] == 200:
                return child
        except (OSError, urllib.error.URLError):
            time.sleep(.1)
    child.terminate()
    raise RuntimeError('Isolated server startup timed out')


with tempfile.TemporaryDirectory(prefix='hue-piano-test-', dir=os.environ.get('HUE_PIANO_TEST_TEMP_ROOT')) as folder:
    child = launch(folder)
    try:
        assert request('/api/piano/config')[1] == {'enabled': False, 'sound': True, 'volume': 50, 'active': False}
        assert request('/api/piano/session', 'POST', {})[0] == 409
        a, b = 'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002'
        settings = {'enabled': False, 'sound': False, 'volume': 70, 'assignments': [{'lightId': a, 'note': 3}, {'lightId': b, 'note': 3}], 'configurationIds': {}}
        assert request('/api/piano/settings', 'PUT', settings)[0] == 200
        assert request('/api/piano/settings')[1] == settings
        legacy = {key: value for key, value in settings.items() if key != 'volume'}
        assert request('/api/piano/settings', 'PUT', legacy)[0] == 200
        assert request('/api/piano/settings')[1]['volume'] == 50
        assert request('/api/piano/settings', 'PUT', settings)[0] == 200
        controller = {'groups': {'music': [{'lightIds': [b]}, {'lightIds': [a]}]}}
        assert request('/api/controller-settings', 'PUT', controller)[0] == 200
        assert request('/api/piano/settings')[1] == settings
        assert request('/api/controller-settings')[1]['settings'] == controller
        for assignments in [[{'lightId': a, 'note': 8}], [{'lightId': a, 'note': 0}, {'lightId': a.upper(), 'note': 1}], [None]]:
            assert request('/api/piano/settings', 'PUT', {**settings, 'assignments': assignments})[0] == 400
        for volume in [-1, 101]:
            assert request('/api/piano/settings', 'PUT', {**settings, 'volume': volume})[0] == 400
        assert request('/api/piano/settings')[1] == settings
        assert request('/api/piano/frame', 'POST', {'token': 'old', 'levels': [0] * 8})[0] == 409
        assert request('/api/piano/stop', 'POST', {'token': 'old'})[0] == 200
        assert request('/api/piano/config')[1]['active'] is False
        child.terminate(); child.wait(timeout=10)
        child = launch(folder)
        assert request('/api/piano/settings')[1] == settings
        assert 'assignments' not in request('/api/piano/config')[1]
        print('PASS: isolated mapping persistence, duplicate/range validation, music independence, stale-token rejection and restart')
    finally:
        child.terminate()
        child.wait(timeout=10)
