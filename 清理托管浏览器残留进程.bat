@echo off
setlocal
cd /d "%~dp0"

title VCP Managed Chrome Cleanup

echo ============================================================
echo  VCP Managed Chrome - Safe Process Cleanup
echo ============================================================
echo.
echo This tool only targets Chrome/Edge/Chromium processes whose
echo --user-data-dir exactly matches the VCP managed Profile.
echo Other browser profiles will not be targeted.
echo.
echo The matching processes will be listed before termination.
echo Type uppercase YES when prompted to confirm.
echo.

where powershell.exe >nul 2>nul
if errorlevel 1 (
    echo [ERROR] powershell.exe was not found.
    echo.
    pause
    exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "scripts\cleanup_managed_browser.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
    echo [DONE] Cleanup completed.
) else if "%EXIT_CODE%"=="2" (
    echo [CANCELLED] Cleanup was cancelled.
) else (
    echo [ERROR] Cleanup exit code: %EXIT_CODE%
)
echo.
pause
exit /b %EXIT_CODE%