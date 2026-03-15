@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM ===== Click-safe relaunch: force a persistent cmd window =====
if /I not "%~1"=="__KEEP__" (
    start "JapaneseHelper Installer" cmd /k ""%~f0" __KEEP__ %*"
    exit /b 0
)
shift

chcp 65001 >nul
title JapaneseHelper Installer (Persistent)

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "ROOT_DIR=%%~fI"
set "PS1=%SCRIPT_DIR%install_plugin_requirements.ps1"
set "MODE=%~1"
set "DOCKER_CID=%~2"
set "PYTHON_EXE=%~3"

if "%MODE%"=="" set "MODE=menu"
if "%PYTHON_EXE%"=="" set "PYTHON_EXE=python"

set "LOG_DIR=%ROOT_DIR%\logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>nul

set "BOOT_LOG=%LOG_DIR%\bootstrap_latest.log"
set "LOG_FILE=%LOG_DIR%\install_latest.log"
set "DB_LOG=%LOG_DIR%\database_latest.log"

(
    echo [BOOT] %DATE% %TIME%
    echo [BOOT] Script=%~f0
    echo [BOOT] Mode=%MODE%
    echo [BOOT] DockerCID=%DOCKER_CID%
    echo [BOOT] PythonExe=%PYTHON_EXE%
) > "%BOOT_LOG%" 2>&1

if not exist "%PS1%" (
    echo [ERROR] Missing PowerShell script: "%PS1%"
    echo [ERROR] Missing PowerShell script: "%PS1%" >> "%BOOT_LOG%"
    goto :finish
)

if /I "%MODE%"=="menu" goto :menu
if /I "%MODE%"=="auto" goto :run
if /I "%MODE%"=="host" goto :run
if /I "%MODE%"=="docker" goto :run
set "MODE=menu"
goto :menu

:menu
echo.
echo ============ JapaneseHelper Installer (No-MeCab) ============
echo [1] auto (prefer docker, fallback host)
echo [2] host (install on host python)
echo [3] docker (install in running container)
echo [4] exit
echo.
set /p PICK=Choose 1/2/3/4: 

if "%PICK%"=="1" set "MODE=auto" & goto :run
if "%PICK%"=="2" set "MODE=host" & goto :run
if "%PICK%"=="3" set "MODE=docker" & goto :run
if "%PICK%"=="4" goto :finish
echo Invalid input.
goto :menu

:run
echo ===== START %DATE% %TIME% ===== > "%LOG_FILE%"
echo MODE=%MODE% >> "%LOG_FILE%"
echo DOCKER_CID=%DOCKER_CID% >> "%LOG_FILE%"
echo PYTHON_EXE=%PYTHON_EXE% >> "%LOG_FILE%"
echo PROFILE=NoMeCab >> "%LOG_FILE%"

if /I "%MODE%"=="docker" (
    if not "%DOCKER_CID%"=="" (
        powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Mode docker -DockerContainerId "%DOCKER_CID%" -PythonExe "%PYTHON_EXE%" -UseTsinghuaMirror -BreakSystemPackages -UpgradePip -NoMeCab -PreferBinary -RunQuickCheck >> "%LOG_FILE%" 2>&1
    ) else (
        powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Mode docker -PythonExe "%PYTHON_EXE%" -UseTsinghuaMirror -BreakSystemPackages -UpgradePip -NoMeCab -PreferBinary -RunQuickCheck >> "%LOG_FILE%" 2>&1
    )
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Mode %MODE% -PythonExe "%PYTHON_EXE%" -UseTsinghuaMirror -BreakSystemPackages -UpgradePip -NoMeCab -PreferBinary -RunQuickCheck >> "%LOG_FILE%" 2>&1
)

set "RC=%ERRORLEVEL%"
echo ===== END RC=%RC% %DATE% %TIME% ===== >> "%LOG_FILE%"

echo.
echo ---------- INSTALL LOG BEGIN ----------
type "%LOG_FILE%"
echo ---------- INSTALL LOG END ------------

if "%RC%"=="0" (
    echo [OK] Dependencies installed successfully.
    echo.
    echo [Step 2/2] Building database...
    echo.
    
    set "PYTHONUTF8=1"
    set "PYTHONIOENCODING=utf-8"
    "%PYTHON_EXE%" -X utf8 "%SCRIPT_DIR%setup_database.py" > "%DB_LOG%" 2>&1
    set "DB_RC=!ERRORLEVEL!"
    
    if "!DB_RC!"=="0" (
        echo [OK] Database built successfully!
        echo.
        echo ---------- DATABASE LOG BEGIN ----------
        type "%DB_LOG%"
        echo ---------- DATABASE LOG END ------------
    ) else (
        echo [ERROR] Database build failed. RC=!DB_RC!
        echo.
        echo ---------- DATABASE LOG BEGIN ----------
        type "%DB_LOG%"
        echo ---------- DATABASE LOG END ------------
        echo.
        echo [INFO] You can retry database setup later by running:
        echo [INFO]   python -X utf8 setup_database.py
    )
) else (
    echo [ERROR] Dependency installation failed. RC=%RC%
)

:finish
echo.
echo [INFO] BOOT_LOG     : "%BOOT_LOG%"
echo [INFO] INSTALL_LOG  : "%LOG_FILE%"
echo [INFO] DATABASE_LOG : "%DB_LOG%"
echo.
echo [INFO] Optional: To add Wadoku dictionary support, run:
echo [INFO]   .\scripts\setup_wadoku.bat
echo.
echo [INFO] You can close this window safely.