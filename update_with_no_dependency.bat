@echo off
echo Updating Cherry-Var-Reborn using Git...

REM Navigate to the script's directory
cd /d "%~dp0"

REM Discard local tracked modifications in AdminPanel-Vue/dist before pulling
git checkout -- AdminPanel-Vue/dist >nul 2>&1

REM Pull latest changes from Git
echo Pulling latest changes...
git pull

echo Verifying AdminPanel-Vue frontend...
call npm run ensure:admin

echo Git update complete.