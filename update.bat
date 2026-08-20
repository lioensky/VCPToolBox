@echo off
setlocal EnableExtensions
chcp 65001 >nul
title VCPToolBox Global Updater

REM Always run from the repository root where this script is located.
cd /d "%~dp0" || goto :fail_directory

echo ============================================================
echo              VCPToolBox Global Updater
echo ============================================================
echo.

call :check_command git "Git"
if errorlevel 1 goto :fail
call :check_command node "Node.js"
if errorlevel 1 goto :fail
call :check_command npm "npm"
if errorlevel 1 goto :fail
call :check_command cargo "Rust Cargo"
if errorlevel 1 goto :fail
call :check_command rustc "Rust compiler"
if errorlevel 1 goto :fail

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
    echo [ERROR] This script is not running inside a Git repository.
    goto :fail
)

echo [1/6] Pulling latest source code with fast-forward only...
git pull --ff-only
if errorlevel 1 (
    echo [ERROR] Git pull failed.
    echo         Resolve local changes, branch divergence, or network issues first.
    goto :fail
)
echo [OK] Source code updated.
echo.

echo [2/6] Installing/updating root Node.js dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo [ERROR] Root npm install failed.
    goto :fail
)
echo [OK] Root Node.js dependencies updated.
echo.

echo [3/6] Installing/updating Vexus build dependencies...
pushd "rust-vexus-lite"
if errorlevel 1 (
    echo [ERROR] Directory not found: rust-vexus-lite
    goto :fail
)
call npm install --no-audit --no-fund
if errorlevel 1 (
    popd
    echo [ERROR] Vexus npm install failed.
    goto :fail
)
popd
echo [OK] Vexus build dependencies updated.
echo.

echo [4/6] Building Rust Vexus vector database module...
pushd "rust-vexus-lite"
if errorlevel 1 (
    echo [ERROR] Directory not found: rust-vexus-lite
    goto :fail
)
call npm run build
if errorlevel 1 (
    popd
    echo [ERROR] Vexus build failed.
    goto :fail
)
popd
echo [OK] Rust Vexus module built.
echo.

echo [5/6] Building DailyNoteSearcher Rust module...
call npm run build:daily-note-searcher
if errorlevel 1 (
    echo [ERROR] DailyNoteSearcher build failed.
    goto :fail
)
echo [OK] DailyNoteSearcher built and deployed.
echo.

echo [6/6] Building CodeSearcher Rust module...
call npm run build:code-searcher
if errorlevel 1 (
    echo [ERROR] CodeSearcher build failed.
    goto :fail
)
echo [OK] CodeSearcher built and deployed.
echo.

echo ============================================================
echo [SUCCESS] VCPToolBox update completed successfully.
echo ============================================================
goto :success

:check_command
where %~1 >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Required command not found: %~2 ^(%~1^)
    echo         Install it and ensure it is available in PATH.
    exit /b 1
)
echo [OK] Found %~2.
exit /b 0

:fail_directory
echo [ERROR] Unable to enter the script directory: %~dp0

:fail
echo.
echo ============================================================
echo [FAILED] Update stopped. Review the error message above.
echo ============================================================
if /I not "%~1"=="--no-pause" pause
exit /b 1

:success
if /I not "%~1"=="--no-pause" pause
exit /b 0