@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo   VCPToolBox - Starting Services via PM2
echo ============================================
echo.
echo Working directory: %CD%
echo.

REM 0. Check if AdminPanel-Vue frontend is built
if not exist "AdminPanel-Vue\dist\index.html" (
    echo [Build] AdminPanel-Vue frontend not found, building...
    if exist "AdminPanel-Vue\package.json" (
        pushd AdminPanel-Vue
        call npm install
        call npm run build
        popd
        if exist "AdminPanel-Vue\dist\index.html" (
            echo [Build] AdminPanel-Vue build successful.
        ) else (
            echo [Build] WARNING: AdminPanel-Vue build may have failed. Admin panel may not work.
        )
    ) else (
        echo [Build] WARNING: AdminPanel-Vue/package.json not found. Skipping build.
    )
) else (
    echo [Build] AdminPanel-Vue frontend found, skipping build.
)
echo.

REM 1. Cleanup old processes to ensure a clean start
echo [Cleanup] Removing existing PM2 processes...
call pm2 delete vcp-main 2>nul
call pm2 delete vcp-admin 2>nul
call pm2 delete server 2>nul

echo.
REM 2. Start Main Service
echo [1/2] Starting Main chat service (vcp-main)...
REM --kill-timeout 15000: Give 15s to save vector DB indices
call pm2 start server.js --name "vcp-main" --watch false --max-memory-restart 1500M --kill-timeout 15000

echo.
echo Waiting 8 seconds for main service to initialize...
ping -n 9 127.0.0.1 >nul

REM 3. Start Admin Panel
echo [2/2] Starting Admin Panel (vcp-admin)...
call pm2 start adminServer.js --name "vcp-admin" --watch false --max-memory-restart 512M --kill-timeout 5000

echo.
echo ============================================
echo   All services started!
echo ============================================
echo.
call pm2 list
echo.
pause
