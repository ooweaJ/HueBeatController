param([switch]$SkipModel)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$envPath = Join-Path $PSScriptRoot 'tmp\offline-analysis-venv'
$pythonPath = Join-Path $envPath 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) {
    python -c "import sys; assert sys.version_info[:2] == (3, 12), 'Use Python 3.12 for the tested analysis environment'"
    if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.12 and add it to PATH.' }
    python -m venv $envPath
    if ($LASTEXITCODE -ne 0) { throw 'Could not create isolated analysis environment.' }
}
& $pythonPath -c "import sys; assert sys.version_info[:2] == (3, 12), 'Use Python 3.12 for this locked environment'"
if ($LASTEXITCODE -ne 0) { throw 'Existing analysis environment uses the wrong Python version.' }
& $pythonPath -m pip install 'torch==2.8.0' 'torchaudio==2.8.0' --index-url https://download.pytorch.org/whl/cpu
if ($LASTEXITCODE -ne 0) { throw 'CPU PyTorch installation failed.' }
& $pythonPath -m pip install -r tools/offline/requirements-win-py312.lock.txt
if ($LASTEXITCODE -ne 0) { throw 'Analysis dependencies could not be installed.' }
& $pythonPath -m pip check
if ($LASTEXITCODE -ne 0) { throw 'Analysis dependency check failed.' }
if (-not $SkipModel) {
    & $pythonPath tools/offline/prepare_model.py
    if ($LASTEXITCODE -ne 0) { throw 'Model preparation failed. No analysis fallback was enabled.' }
}
Write-Host 'Offline analysis environment ready. Existing LedFx and Hue settings were not changed.'
