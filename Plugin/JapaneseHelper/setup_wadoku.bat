@echo off
chcp 65001 >nul
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
set "PYTHON_EXE=python"

echo ============================================================
echo JapaneseHelper Wadoku Dictionary Auto-Install Tool
echo ============================================================
echo.
echo This script will automatically:
echo   1. Download Wadoku Japanese-German dictionary data (~200MB)
echo   2. Parse XML and import to database
echo   3. Create indexes for query optimization
echo.
echo Prerequisites:
echo   - .\scripts\install_plugin_requirements.bat has been run
echo   - Database initialized (JMdict + KANJIDIC2)
echo.
echo Estimated time: 5-10 minutes (depends on network speed)
echo.
echo ============================================================
echo.
echo Press any key to start installation, or close window to cancel...
pause >nul

echo.
echo [Starting Installation]
echo.

"%PYTHON_EXE%" "%SCRIPT_DIR%setup_wadoku.py"

set "RC=%ERRORLEVEL%"

echo.
echo ============================================================
if "%RC%"=="0" (
    echo [Success] Wadoku dictionary installation completed!
    echo.
    echo You can now use the full Japanese-German dictionary features.
) else (
    echo [Failed] Wadoku dictionary installation failed, error code: %RC%
    echo.
    echo Possible causes:
    echo   1. Network connection issue, unable to download file
    echo   2. Database file does not exist (please run main install script first)
    echo   3. Insufficient disk space
    echo.
    echo Solutions:
    echo   1. Check network connection and retry
    echo   2. Manually download wadoku.xml and place in data/wadoku-xml/ directory
    echo   3. Set environment variable WADOKU_DOWNLOAD_URL to specify mirror address
)
echo ============================================================

echo.
echo Press any key to exit...
pause >nul