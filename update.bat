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

REM Discard local tracked modifications in AdminPanel-Vue/dist before pulling
git checkout -- AdminPanel-Vue/dist >nul 2>&1
echo [1/8] Pulling latest source code with fast-forward only...
git pull --ff-only
if errorlevel 1 (
    echo [ERROR] Git pull failed.
    echo         Resolve local changes, branch divergence, or network issues first.
    goto :fail
)
echo [OK] Source code updated.
echo.

echo [2/8] Installing/updating root Node.js dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 (
    echo [ERROR] Root npm install failed.
    goto :fail
)
echo [OK] Root Node.js dependencies updated.
echo.

echo [3/8] Installing/updating Vexus build dependencies...
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

echo [4/8] Building Rust Vexus vector database module...
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

echo [5/8] Building DailyNoteSearcher Rust module...
call npm run build:daily-note-searcher
if errorlevel 1 (
    echo [ERROR] DailyNoteSearcher build failed.
    goto :fail
)
echo [OK] DailyNoteSearcher built and deployed.
echo.

echo [6/8] Building CodeSearcher Rust module...
call npm run build:code-searcher
if errorlevel 1 (
    echo [ERROR] CodeSearcher build failed.
    goto :fail
)
echo [OK] CodeSearcher built and deployed.
echo.

echo [7/8] Verifying and building AdminPanel-Vue frontend...
call npm run ensure:admin
if errorlevel 1 (
    echo [ERROR] AdminPanel-Vue ensure/build failed.
    goto :fail
)
echo [OK] AdminPanel-Vue frontend verified.
echo.

echo [8/8] Checking config.env against config.env.example...
node -e "const fs=require('fs');if(!fs.existsSync('config.env.example')){console.log('[SKIP] config.env.example not found.');}else if(!fs.existsSync('config.env')){console.log('[WARN] config.env not found. Please copy config.env.example to config.env.');}else{const parse=p=>new Set((fs.readFileSync(p,'utf8').match(/^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/gm)||[]).map(s=>s.split('=')[0].trim()));const ex=parse('config.env.example'),cur=parse('config.env');const miss=[...ex].filter(k=>!cur.has(k));if(miss.length){console.log('[WARN] Keys in config.env.example but missing from your config.env ('+miss.length+'):');console.log('       '+miss.join(', '));console.log('       (Tip only: review config.env.example and sync needed keys manually.)');}else{console.log('[OK] config.env contains all active keys from config.env.example.');}}"
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