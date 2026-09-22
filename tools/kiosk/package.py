"""Rebuild the kiosk host and patch visitor assets into a NEW ZIP, using the base's exact runtime.

Usage: python tools/kiosk/package.py --base-zip .build/HueBeatKiosk-....zip
Requires the .NET 10 Windows Desktop SDK; no NuGet packages are downloaded.
Never runs the kiosk, server, or device output. Never copies local data/settings.
"""
import argparse
import hashlib
import json
import subprocess
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--base-zip', type=Path, required=True)
parser.add_argument('--piano-base-brightness', type=int, choices=range(101), default=0, metavar='0..100')
parser.add_argument('--output', type=Path, default=ROOT / 'distribution/kiosk/HueBeatKiosk.zip')
args = parser.parse_args()
source = args.base_zip.resolve()
output = args.output.resolve()
name = 'HueBeatKiosk'
assets = ['piano/index.html', 'piano/visitor.css', 'piano/visitor.js']
(ROOT / 'tmp').mkdir(exist_ok=True)
with zipfile.ZipFile(source) as base, tempfile.TemporaryDirectory(prefix='kiosk-package-', dir=ROOT / 'tmp') as staging:
    roots = {PurePosixPath(n).parts[0] for n in base.namelist()}
    if len(roots) != 1:
        raise ValueError('Expected one distribution folder in the base ZIP')
    prefix = roots.pop() + '/'
    stage = Path(staging)
    refs = stage / 'refs'; refs.mkdir()
    for dll in ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll']:
        (refs / dll).write_bytes(base.read(prefix + dll))
    subprocess.run(['dotnet', 'build', str(ROOT / 'tools/kiosk/HueBeatKiosk.csproj'), '-c', 'Release',
                    '--ignore-failed-sources', '-p:NuGetAudit=false', '-p:RestoreSources=',
                    '-p:WebView2ReferenceDir=' + str(refs), '-o', str(stage / 'host')], check=True, cwd=ROOT)
    replacements = {
        'HueBeatKiosk.dll': (stage / 'host/HueBeatKiosk.dll').read_bytes(),
        'HueBeatKiosk.pdb': (stage / 'host/HueBeatKiosk.pdb').read_bytes(),
        **{'server/wwwroot/' + asset: (ROOT / 'wwwroot' / asset).read_bytes() for asset in assets},
        'kiosk-settings.json': (json.dumps({'pianoBaseBrightnessPercent': args.piano_base_brightness}, indent=2) + '\n').encode('utf-8'),
        'README.md': (ROOT / 'distribution/kiosk/README.md').read_bytes(),
    }
    # Keep the original self-contained .deps.json, runtimeconfig and apphost; the assembly name is unchanged.
    removed = {path + ext for path in replacements for ext in ['.br', '.gz']}
    output.parent.mkdir(parents=True, exist_ok=True)
    archive = stage / 'HueBeatKiosk.zip'
    with zipfile.ZipFile(archive, 'x', zipfile.ZIP_DEFLATED, compresslevel=6) as patched:
        for entry in base.infolist():
            relative = entry.filename.removeprefix(prefix)
            parts = PurePosixPath(relative).parts
            if '..' in parts or relative.startswith('/') or '\\' in relative:
                raise ValueError('Invalid archive path')
            if not relative or entry.is_dir() or 'data' in parts or relative in removed or relative in replacements or relative in {'kiosk-patch.json', 'TOUCH-UPDATE.txt'}:
                continue
            patched.writestr(name + '/' + relative, base.read(entry))
        for relative, content in replacements.items():
            patched.writestr(name + '/' + relative, content)
        manifest = {'baseSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                    'updated': {key: hashlib.sha256(value).hexdigest() for key, value in replacements.items()},
                    'operatorExit': 'Ctrl+Shift+Q', 'windowsGesturesChanged': False,
                    'pianoBaseBrightnessPercent': args.piano_base_brightness}
        patched.writestr(name + '/kiosk-patch.json', json.dumps(manifest, indent=2))
        patched.writestr(name + '/TOUCH-UPDATE.txt',
                        'Extract the entire ZIP into a NEW folder and run HueBeatKiosk.exe.\n'
                        'Pinch zoom, browser zoom and swipe navigation are disabled.\n'
                        'The fullscreen button is hidden in the kiosk host; exit with Ctrl+Shift+Q.\n'
                        'Windows system touch gestures are not changed.\n'
                        f'Piano base brightness: {args.piano_base_brightness}%. Pressed notes reach 100%.\n'
                        'Edit pianoBaseBrightnessPercent (0..100) in kiosk-settings.json beside the EXE and restart to change it.\n'
                        'Stop other kiosk/server processes before comparing versions; use only one version at a time.\n'
                        '60 seconds without playing returns to the welcome screen and restarts ambient art.\n'
                        'Local device settings are not included. Retain your existing server/data separately.\n')
    with zipfile.ZipFile(archive) as verify:
        if verify.testzip() is not None:
            raise ValueError('Archive verification failed')
        for relative, content in replacements.items():
            assert verify.read(name + '/' + relative) == content
        assert not any('data' in PurePosixPath(n).parts or n.lower().endswith(('.wav', '.mp3')) for n in verify.namelist())
    base.close()
    archive.replace(output)
    print(json.dumps({'output': str(output), 'bytes': output.stat().st_size,
                      'sha256': hashlib.sha256(output.read_bytes()).hexdigest()}, indent=2))
