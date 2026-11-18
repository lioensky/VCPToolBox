@echo off
setlocal
cd /d "%~dp0"

title VCP Managed Chrome Setup

echo ============================================================
echo  VCP Managed Chrome - Interactive Setup Mode
echo ============================================================
echo.
echo This launcher asks the running VCP server to open its managed
echo Chrome through the HumanTool / ChromeBridge open_chrome path.
echo.
echo IMPORTANT:
echo - Start the VCP server before continuing.
echo - The VCP server remains the sole owner of the Chrome process.
echo - This window may be closed after the server accepts the request.
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
    echo [DONE] The VCP server accepted the managed browser setup request.
) else (
    echo [ERROR] Launcher exit code: %EXIT_CODE%
)
echo.
pause
exit /b %EXIT_CODE%