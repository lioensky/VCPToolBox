@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

REM ComfyUI工作流转换工具 - Windows批处理版本
REM 方便没有前端的用户使用

echo =====================================
echo   ComfyUI 工作流模板转换工具
echo =====================================
echo.

REM 检查Python是否安装
python --version >nul 2>&1
if errorlevel 1 (
    echo 错误: 未找到Python，请先安装Python 3.6+
    pause
    exit /b 1
)

REM 检查是否有参数
if "%1"=="" goto :show_menu

REM 直接执行命令
python "%~dp0workflow_template_processor.py" %*
goto :end

:show_menu
echo 请选择操作:
echo 1. 转换工作流为模板
echo 2. 验证模板
echo 3. 分析工作流结构
echo 4. 退出
echo.
echo 注意: 模板填充功能请使用主程序 ComfyUIGen.js
echo.
set /p choice=请输入选择 (1-4): 

if "%choice%"=="1" goto :convert
if "%choice%"=="2" goto :validate
if "%choice%"=="3" goto :analyze
if "%choice%"=="4" goto :end

echo 无效选择，请重新输入
echo.
goto :show_menu

:convert
echo.
echo === 转换工作流为模板 ===
set /p input_file=请输入原始工作流文件路径: 
set /p output_file=请输入输出模板文件路径: 

if "%input_file%"=="" (
    echo 错误: 请提供输入文件路径
    goto :convert
)
if "%output_file%"=="" (
    echo 错误: 请提供输出文件路径
    goto :convert
)

echo.
python "%~dp0workflow_template_processor.py" convert "%input_file%" "%output_file%"
echo.
pause
goto :show_menu

:validate
echo.
echo === 验证模板 ===
set /p template_file=请输入模板文件路径: 

if "%template_file%"=="" (
    echo 错误: 请提供模板文件路径
    goto :validate
)

echo.
python "%~dp0workflow_template_processor.py" validate "%template_file%"
echo.
pause
goto :show_menu

:analyze
echo.
echo === 分析工作流结构 ===
set /p workflow_file=请输入工作流文件路径: 

if "%workflow_file%"=="" (
    echo 错误: 请提供工作流文件路径
    goto :analyze
)

echo.
python "%~dp0workflow_template_processor.py" analyze "%workflow_file%"
echo.
pause
goto :show_menu

:end
echo 再见！