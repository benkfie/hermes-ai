@echo off
setlocal
cd /d "%~dp0"

echo [Hermes AI] Building...
call npm run build
if errorlevel 1 (
    echo [Hermes AI] Build FAILED!
    pause
    exit /b 1
)

echo [Hermes AI] Packaging VSIX...
call npx @vscode/vsce package --no-dependencies 2>nul
if errorlevel 1 (
    echo [Hermes AI] Package FAILED!
    pause
    exit /b 1
)

echo [Hermes AI] Installing to Antigravity IDE...
call "antigravity-ide.cmd" --install-extension="%~dp0hermes-ai-1.0.0.vsix" 2>&1

echo.
echo [Hermes AI] Done! In Antigravity IDE press:
echo   Ctrl+Shift+P then type "Reload Window" and hit Enter
echo.
pause
