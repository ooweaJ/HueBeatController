"""Explicit installation-time download; analysis itself never downloads models."""
from pathlib import Path
import urllib.request
import uuid

from store import sha256

MODEL_URL = 'https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final0.ckpt'
# SHA-256 of the official final0 download verified for this comparison on 2026-09-16.
MODEL_SHA256 = '8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331'
DEFAULT_MODEL = Path(__file__).resolve().parents[2] / 'tmp' / 'offline-models' / 'final0.ckpt'


def check_model(path):
    path = Path(path)
    if not path.is_file() or sha256(path) != MODEL_SHA256:
        raise ValueError('Missing or mismatched Beat This final0. Run setup-offline-analysis.ps1; no automatic fallback.')


def main():
    if DEFAULT_MODEL.exists():
        check_model(DEFAULT_MODEL)
        print('Verified local final0:', MODEL_SHA256)
        return
    DEFAULT_MODEL.parent.mkdir(parents=True, exist_ok=True)
    pending = DEFAULT_MODEL.with_suffix('.' + uuid.uuid4().hex + '.pending')
    with urllib.request.urlopen(MODEL_URL, timeout=60) as response, pending.open('xb') as output:
        count = 0
        while block := response.read(1024 * 1024):
            count += len(block)
            if count > 150 * 1024 ** 2:
                raise ValueError('Unexpected model size')
            output.write(block)
    check_model(pending)
    pending.rename(DEFAULT_MODEL)
    print('Prepared local final0:', MODEL_SHA256)


if __name__ == '__main__':
    main()
