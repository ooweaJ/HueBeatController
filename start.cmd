@echo off
setlocal
title Hue Beat Controller Server
cd /d "%~dp0"

set "HUE_SERVER_PID="
for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr /r /c:":5188 .*LISTENING"') do set "HUE_SERVER_PID=%%P"

if defined HUE_SERVER_PID (
  echo Hue Beat Controller is already running. PID: %HUE_SERVER_PID%
  echo Opening http://127.0.0.1:5188
  start "" "http://127.0.0.1:5188"
  echo.
  pause
  exit /b 0
)

echo Starting Hue Beat Controller...
echo Keep this window open while controlling the lights.
echo Press Ctrl+C to stop the server.
echo.
start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:5188'"
dotnet run --no-launch-profile

echo.
echo The server stopped or failed to start. Review the message above.
pause
