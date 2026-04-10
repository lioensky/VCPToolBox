@echo off
echo ==========================================
echo   vcp-installer Release Build
echo ==========================================
echo.
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" x64
if errorlevel 1 (
    echo [ERROR] Failed to load MSVC environment
    pause
    exit /b 1
)
echo.
echo [VCP] MSVC environment loaded. Building...
echo.
cd /d "E:\VCP\vcp-installer"
cargo build --release
echo.
if errorlevel 1 (
    echo [ERROR] Build failed!
) else (
    echo [OK] Build succeeded!
    echo Output: E:\VCP\vcp-installer\target\release\vcp-installer.exe
)
pause