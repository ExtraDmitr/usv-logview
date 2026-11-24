@echo off
rem usv-logview quick install (Windows): double-click, or run "install.bat -Minimal" / "-Yes" / "-Fresh" / "-Check"
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
pause
