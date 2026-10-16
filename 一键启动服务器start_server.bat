@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo   VCPToolBox - Starting Services via PM2
echo ============================================
echo.
echo Working directory: %CD%
echo.

REM ============================================================================
REM [WARNING] DO NOT run this script directly on this machine.
REM
REM This script calls the bare command `pm2` (see "call pm2 ..." below), but this
REM machine has NO pm2 reachable through the persistent PATH. A fresh cmd.exe
REM reports: "INFO: Could not find files for the given pattern(s)." for `where pm2`.
REM pm2 only exists as F:\VCP\runtimes\node\pm2.cmd and
REM F:\VCP\VCPToolBox\node_modules\.bin\pm2.cmd, and neither directory is on PATH.
REM Every `call pm2` below therefore fails, and nothing gets started.
REM
REM This script also deliberately does NOT prepend runtimes\node to PATH (see the
REM interpreter note below), so fixing pm2 alone would still be unsafe unless the
REM interpreter argument is kept.
REM
REM USE ONE OF THESE INSTEAD:
REM   1) F:\VCP\VCP.bat              <- normal entry point (sets PATH, pins interpreter)
REM   2) F:\VCP\runtimes\node\pm2.cmd start ecosystem.config.js
REM      (run from F:\VCP\VCPToolBox with PATH including F:\VCP\runtimes\node)
REM
REM Kept as-is intentionally for reference. See the interpreter pinning below.
REM ============================================================================
echo [WARNING] This script relies on a bare `pm2` that is NOT on PATH on this
echo [WARNING] machine, so it cannot start the services by itself. Use
echo [WARNING] F:\VCP\VCP.bat instead. Continuing anyway in 5 seconds...
ping -n 6 127.0.0.1 >nul
echo.

REM Increase libuv worker pool before PM2 starts Node processes.
REM This must be set before node.exe starts; setting it inside JS is usually too late.
set UV_THREADPOOL_SIZE=64
echo [Runtime] UV_THREADPOOL_SIZE=%UV_THREADPOOL_SIZE%
echo [Runtime] Enlarged Node.js libuv worker pool to reduce native async task starvation.
echo [Runtime] If CPU contention is too high, try 32; if native tasks still stall, try 128 temporarily.
echo.

REM Pin the Node interpreter explicitly. This script does NOT prepend runtimes\node to PATH,
REM so pm2's default interpreter "node" would resolve to whatever Node happens to be first on
REM PATH. A different Node major makes native modules (better-sqlite3) fail with
REM ERR_DLOPEN_FAILED (NODE_MODULE_VERSION mismatch) and the server crash-loops.
set "VCP_NODE=%~dp0..\runtimes\node\node.exe"
if not exist "%VCP_NODE%" (
    echo [ERROR] Portable Node runtime not found: %VCP_NODE%
    echo [ERROR] Refusing to start, because pm2 would fall back to an arbitrary Node from PATH.
    pause
    exit /b 1
)
echo [Runtime] Node interpreter pinned to: %VCP_NODE%
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
call pm2 start server.js --name "vcp-main" --interpreter "%VCP_NODE%" --kill-timeout 15000

echo.
echo Waiting 8 seconds for main service to initialize...
ping -n 9 127.0.0.1 >nul

REM 3. Start Admin Panel
echo [2/2] Starting Admin Panel (vcp-admin)...
REM Keep PM2 memory restart limits disabled for both processes while diagnosing
REM legitimate maintenance/build memory peaks and unexpected overlapping restarts.
call pm2 start adminServer.js --name "vcp-admin" --interpreter "%VCP_NODE%" --kill-timeout 5000

echo.
echo ============================================
echo   All services started!
echo ============================================
echo.
call pm2 list
echo.
pause
