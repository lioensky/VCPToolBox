@echo off
chcp 65001 >nul 2>&1
title ComfyCloudGen Setup

echo.
echo  ╔══════════════════════════════════════════╗
echo  ║   ComfyCloudGen - 一键认证脚本           ║
echo  ║   自动提取 Comfy Cloud Firebase 凭证      ║
echo  ╚══════════════════════════════════════════╝
echo.
echo  [信息] 即将启动 Edge 浏览器，请在浏览器中完成 Google 登录。
echo  [信息] 登录成功后凭证将自动写入 config.env。
echo.

REM 检查 Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [错误] 未检测到 Node.js，请先安装 Node.js。
    echo  [下载] https://nodejs.org/
    pause
    exit /b 1
)

REM 检查 config.env.example
if not exist "%~dp0config.env" (
    if exist "%~dp0config.env.example" (
        echo  [信息] 未发现 config.env，正在从 config.env.example 创建...
        copy "%~dp0config.env.example" "%~dp0config.env" >nul
        echo  [完成] config.env 已创建。
        echo.
    )
)

REM 运行认证脚本
node "%~dp0setup.js"

echo.
if %errorlevel% equ 0 (
    echo  [成功] 认证完成！现在可以通过 VCP 使用 ComfyCloudGen 了。
) else (
    echo  [失败] 认证过程出现错误，请查看上方日志。
)

echo.
pause