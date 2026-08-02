@echo off
setlocal
cd /d "%~dp0"

title VCP Managed Chrome Setup

echo ============================================================
echo  VCP Managed Chrome - Interactive Setup Mode
echo ============================================================
echo.
echo This launcher opens the production managed Chrome profile
echo in headed, visible, non-minimized mode.
echo.
echo IMPORTANT:
echo - Close the server-managed Chrome instance before continuing.
echo - Never run two Chrome processes with the same managed profile.
echo - Close the entire browser normally after changing settings.
echo.
pause

where node.exe >nul 2>nul
if errorlevel 1 (
    echo.
    echo [ERROR] node.exe was not found in PATH.
    echo Install Node.js or add node.exe to PATH, then retry.
    echo.
    pause
    exit /b 1
)

node.exe "scripts\open_managed_browser_setup.js"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
    echo [DONE] The managed browser setup session has ended.
) else (
    echo [ERROR] Launcher exit code: %EXIT_CODE%
)
echo.
pause
exit /b %EXIT_CODE%