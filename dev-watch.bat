@echo off
setlocal
cd /d "%~dp0"

echo [Hermes AI] Watching for changes... (Ctrl+C to stop)
echo [Hermes AI] After saving files, run dev-install.bat to install.
echo.
call npm run dev
