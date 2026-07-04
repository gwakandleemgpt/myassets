@echo off
setlocal

cd /d "%~dp0"
node tools\catalog-ui.mjs %*

echo.
pause
