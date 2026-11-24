@echo off
rem Run Viewer (Windows): double-click. Options: run.bat --port 8771 --no-browser
cd /d "%~dp0"
set PYTHONUTF8=1
if not exist ".venv\Scripts\python.exe" (
  echo first start: preparing this laptop ^(install.ps1^) ...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" || (pause & exit /b 1)
)
where ffmpeg >nul 2>nul || echo note: ffmpeg not found - the camera tile will not work ^(install.bat offers to install it^)
".venv\Scripts\python.exe" -X utf8 server.py %*
if errorlevel 1 pause
