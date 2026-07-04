@echo off
setlocal

cd /d "%~dp0"
node tools\import-paste.mjs %*

echo.
pause
