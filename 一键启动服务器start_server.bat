@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo   VCPToolBox - Starting Services via PM2
echo ============================================
echo.
echo Working directory: %CD%
echo.

REM Increase libuv worker pool before PM2 starts Node processes.
REM This must be set before node.exe starts; setting it inside JS is usually too late.
set UV_THREADPOOL_SIZE=64
echo [Runtime] UV_THREADPOOL_SIZE=%UV_THREADPOOL_SIZE%
echo [Runtime] Enlarged Node.js libuv worker pool to reduce native async task starvation.
echo [Runtime] If CPU contention is too high, try 32; if native tasks still stall, try 128 temporarily.
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
REM --kill-timeout 15000: Give 15s to save vector DB indices.
REM Do NOT set --max-memory-restart here. Global Tag index staging, Pairwise assets,
REM EPA/IR and TagMemo rebuilds have legitimate temporary memory peaks above 1500 MB.
REM A low PM2 RSS limit can restart the main process in the middle of a maintenance
REM transaction and overlap two cold-start index recoveries against the same SQLite.
call pm2 start server.js --name "vcp-main" --watch false --kill-timeout 15000

echo.
echo Waiting 8 seconds for main service to initialize...
ping -n 9 127.0.0.1 >nul

REM 3. Start Admin Panel
echo [2/2] Starting Admin Panel (vcp-admin)...
REM Keep PM2 memory restart limits disabled for both processes while diagnosing
REM legitimate maintenance/build memory peaks and unexpected overlapping restarts.
call pm2 start adminServer.js --name "vcp-admin" --watch false --kill-timeout 5000

echo.
echo ============================================
echo   All services started!
echo ============================================
echo.
call pm2 list
echo.
pause
