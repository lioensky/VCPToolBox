@echo off
cd /d "%~dp0"
echo ============================================
echo   VCPToolBox - Starting Services via PM2
echo ============================================
echo.
echo Working directory: %CD%
echo.

REM 清理已停止的旧残留进程（不会影响正在运行的进程）
call pm2 delete server 2>nul

REM 启动或重启主服务
echo [1/2] Main chat service (server.js)...
call pm2 describe vcp-main >nul 2>&1
if errorlevel 1 (
    echo     Starting new vcp-main process...
    call pm2 start server.js --name "vcp-main" --watch false --max-memory-restart 1G
) else (
    echo     vcp-main already exists, restarting...
    call pm2 restart vcp-main --update-env
)

echo.
echo Waiting 8 seconds for main service to initialize...
ping -n 9 127.0.0.1 >nul

REM 启动或重启管理面板
echo [2/2] Admin panel service (adminServer.js)...
call pm2 describe vcp-admin >nul 2>&1
if errorlevel 1 (
    echo     Starting new vcp-admin process...
    call pm2 start adminServer.js --name "vcp-admin" --watch false --max-memory-restart 512M
) else (
    echo     vcp-admin already exists, restarting...
    call pm2 restart vcp-admin --update-env
)

echo.
echo ============================================
echo   All services started!
echo ============================================
echo.
call pm2 list
echo.
echo Commands:
echo   pm2 logs              - View all logs
echo   pm2 logs vcp-main     - View main service logs
echo   pm2 logs vcp-admin    - View admin panel logs
echo   pm2 restart vcp-main  - Restart main service only
echo   pm2 restart vcp-admin - Restart admin panel only
echo   pm2 stop all          - Stop all services
echo.
pause