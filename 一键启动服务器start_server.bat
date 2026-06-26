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

REM 2. Run Bootstrap for Port Safety & Start via Ecosystem
echo [Port Check] Running Bootstrap to ensure port safety...
call node bootstrap.js
echo.

REM (PM2 is now started by bootstrap.js, so we just show the list)
call pm2 list
echo.
pause
