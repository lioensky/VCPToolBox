@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo   VCPToolBox - Starting Services via PM2
echo ============================================
echo.
echo Working directory: %CD%
echo.

REM 1. 彻底清理旧的进程记录（确保干净启动）
echo [Cleanup] Removing existing PM2 processes to ensure clean environment...
call pm2 delete vcp-main 2>nul
call pm2 delete vcp-admin 2>nul
call pm2 delete server 2>nul

REM可选：强杀可能残留的孤儿子进程（如果需要更彻底的清理可以取消下面两行的注释）
REM taskkill /f /im node.exe /fi "WINDOWTITLE eq vcp-main" 2>nul
REM taskkill /f /im python.exe /fi "MEMUSAGE gt 50000" 2>nul

echo.
REM 2. 启动主服务
echo [1/2] Starting Main chat service (vcp-main)...
REM --kill-timeout 15000: 给主进程 15 秒宽限时间保存向量数据库索引
call pm2 start server.js --name "vcp-main" --watch false --max-memory-restart 1500M --kill-timeout 15000

echo.
echo Waiting 8 seconds for main service to initialize database and plugins...
ping -n 9 127.0.0.1 >nul

REM 3. 启动管理员面板
echo [2/2] Starting Independent Admin Panel (vcp-admin)...
REM --kill-timeout 5000: 管理面板相对较轻量，5秒宽限足够
call pm2 start adminServer.js --name "vcp-admin" --watch false --max-memory-restart 512M --kill-timeout 5000

echo.
echo ============================================
echo   All services started!
echo ============================================
echo.
call pm2 list
echo.
echo Useful Commands:
echo   pm2 logs vcp-main     - View main service logs
echo   pm2 restart vcp-main  - Graceful restart main service
echo   pm2 stop all          - Stop everything gracefully
echo.
pause