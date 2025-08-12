@echo off
echo Updating Cherry-Var-Reborn using Git...

REM Navigate to the script's directory
cd /d "%~dp0"

REM Pull latest changes from Git
echo Pulling latest changes...
git pull

echo Git update complete.