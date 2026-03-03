@echo off
setlocal EnableExtensions

REM ===== Click-safe relaunch: force a persistent cmd window =====
if /I not "%~1"=="__KEEP__" (
  start "JapaneseHelper Installer" cmd /k ""%~f0" __KEEP__ %*"
  exit /b 0
)

shift
chcp 65001 >nul
title JapaneseHelper Installer (Persistent)

set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%install_plugin_requirements.ps1"
set "MODE=%~1"
set "DOCKER_CID=%~2"
set "PYTHON_EXE=%~3"

if "%MODE%"=="" set "MODE=menu"
if "%PYTHON_EXE%"=="" set "PYTHON_EXE=python"

set "LOG_DIR=%SCRIPT_DIR%logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>nul
set "BOOT_LOG=%LOG_DIR%\bootstrap_latest.log"
set "LOG_FILE=%LOG_DIR%\install_latest.log"

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
echo ============ JapaneseHelper Installer ============
echo [1] auto   (prefer docker, fallback host)
echo [2] host   (install on host python)
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

if /I "%MODE%"=="docker" (
  if not "%DOCKER_CID%"=="" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Mode docker -DockerContainerId "%DOCKER_CID%" -PythonExe "%PYTHON_EXE%" -UseTsinghuaMirror -BreakSystemPackages -UpgradePip >> "%LOG_FILE%" 2>&1
  ) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Mode docker -PythonExe "%PYTHON_EXE%" -UseTsinghuaMirror -BreakSystemPackages -UpgradePip >> "%LOG_FILE%" 2>&1
  )
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Mode %MODE% -PythonExe "%PYTHON_EXE%" -UseTsinghuaMirror -BreakSystemPackages -UpgradePip >> "%LOG_FILE%" 2>&1
)

set "RC=%ERRORLEVEL%"
echo ===== END RC=%RC% %DATE% %TIME% ===== >> "%LOG_FILE%"

echo.
echo ---------- INSTALL LOG BEGIN ----------
type "%LOG_FILE%"
echo ---------- INSTALL LOG END ------------

if "%RC%"=="0" (
  echo [OK] Install finished.
) else (
  echo [ERROR] Install failed. RC=%RC%
)

:finish
echo.
echo [INFO] BOOT_LOG : "%BOOT_LOG%"
echo [INFO] INSTALL_LOG: "%LOG_FILE%"
echo [INFO] You can close this window safely.