@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
start /min "" npx pm2 start server.js --name vcp-toolbox-local
pause