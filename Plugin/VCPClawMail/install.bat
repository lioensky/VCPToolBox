@echo off
setlocal
cd /d "%~dp0"
echo [VCPClawMail] Installing plugin-local dependencies...
npm install
if errorlevel 1 (
  echo [VCPClawMail] npm install failed.
  exit /b 1
)
echo [VCPClawMail] Done.
endlocal