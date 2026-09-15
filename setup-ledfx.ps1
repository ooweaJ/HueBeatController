$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$pythonPath = Join-Path $PSScriptRoot 'tmp\ledfx-venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) {
    python -c "import sys; assert (3, 12) <= sys.version_info[:2] < (3, 14), 'Python 3.12 or 3.13 required'"
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.12 또는 3.13을 PATH에 설정하세요.' }
    python -m venv (Join-Path $PSScriptRoot 'tmp\ledfx-venv')
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.12 또는 3.13을 설치한 뒤 다시 실행하세요.' }
}
& $pythonPath -m pip install 'LedFx @ git+https://github.com/LedFx/LedFx.git@87583f9638fbd749bc0953f35334d8d5140c882f'
if ($LASTEXITCODE -ne 0) { throw 'LedFx 설치 실패. 위 오류를 확인하세요.' }
& $pythonPath -m pip check
if ($LASTEXITCODE -ne 0) { throw 'LedFx 의존성 충돌을 확인하세요.' }
Write-Host '설치 완료. 컨트롤러에서 LedFx 원본 엔진 실험 패널의 엔진 연결을 누르세요.'
