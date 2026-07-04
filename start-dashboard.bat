@echo off
setlocal

cd /d "%~dp0"

set "HOST=127.0.0.1"
set "PORT=8768"
set "URL=http://%HOST%:%PORT%/"

where python >nul 2>nul
if %errorlevel%==0 (
  set "PYTHON=python"
) else (
  where py >nul 2>nul
  if %errorlevel%==0 (
    set "PYTHON=py"
  ) else (
    echo Python was not found. Install Python or add it to PATH, then try again.
    echo.
    pause
    exit /b 1
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue) { exit 1 }"
if errorlevel 1 (
  echo Port %PORT% is already in use.
  echo If the dashboard is already running, open %URL%
  echo.
  pause
  exit /b 1
)

echo Starting Asset Monitor at %URL%
echo Press Ctrl+C in this window to stop the server.
echo.

start "" powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "Start-Sleep -Milliseconds 800; Start-Process '%URL%'"
%PYTHON% -m http.server %PORT% --bind %HOST%

echo.
pause
