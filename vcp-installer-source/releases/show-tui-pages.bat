@echo off
rem UI Preview - TUI 页面预览（不触发真实安装）
cd /d "%~dp0"
if not exist "vcp-installer.exe" (
    echo [ERROR] vcp-installer.exe not found in %~dp0
    pause
    exit /b 1
)
vcp-installer.exe --ui-preview
