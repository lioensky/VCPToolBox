@echo off
echo Updating Cherry-Var-Reborn using Git...

REM Navigate to the script's directory
cd /d "%~dp0"

REM Pull latest changes from Git
echo Pulling latest changes...
git pull

REM Install/update Python dependencies
echo Installing/updating Python dependencies for SciCalculator...
cd Plugin\SciCalculator
pip install -r requirements.txt
cd ..\..
echo Installing/updating Python dependencies for VideoGenerator...
cd Plugin\VideoGenerator
pip install -r requirements.txt
cd ..\..

REM Install/update Node.js dependencies
echo Installing/updating dependencies...
npm install

echo Git update complete.