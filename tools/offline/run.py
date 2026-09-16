"""Bounded worker launcher. Ctrl+C/timeout stops only this analysis child, not the server."""
import subprocess
import sys
import time
from pathlib import Path

import psutil


def main():
    child = subprocess.Popen([sys.executable, str(Path(__file__).with_name('analyze.py')), *sys.argv[1:]])
    started = time.monotonic()
    process = psutil.Process(child.pid)
    try:
        while child.poll() is None:
            if time.monotonic() - started > 900:
                raise RuntimeError('Analysis exceeded 15 minutes; pending results were not published')
            try:
                if process.memory_info().rss > 4 * 1024 ** 3:
                    raise RuntimeError('Analysis exceeded 4 GiB worker memory; pending results were not published')
            except psutil.NoSuchProcess:
                break
            time.sleep(.2)
        return child.wait()
    finally:
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=10)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('Cancelled. Existing revisions and legacy data are unchanged.', file=sys.stderr)
        sys.exit(130)
