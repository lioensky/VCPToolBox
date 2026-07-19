@echo off
setlocal EnableExtensions
chcp 65001 >nul
title TagMemo Unified Geometry Probe V2

set "ROOT=%~dp0"
set "PROBE=%ROOT%scripts\tagmemo_unified_geometry_probe.js"
set "CONFIG=%ROOT%rag_params.json"
set "REPORT_DIR=%ROOT%开发日志"

if "%~1"=="" (
    if defined KNOWLEDGEBASE_STORE_PATH (
        set "DB=%KNOWLEDGEBASE_STORE_PATH%\knowledge_base.sqlite"
    ) else (
        set "DB=%ROOT%VectorStore\knowledge_base.sqlite"
    )
) else (
    set "DB=%~f1"
)

echo.
echo ============================================================
echo  TagMemo 统一几何构型只读探针 V2
echo ============================================================
echo  数据库: %DB%
echo  配置:   %CONFIG%
echo  报告:   %REPORT_DIR%
echo.
echo  本脚本只读访问 SQLite，不会初始化 KnowledgeBaseManager，
echo  不会修改数据库、WAL、配置或 TagMemo 派生资产。
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 Node.js。请安装 Node.js 或将 node.exe 加入 PATH。
    goto :failed
)

if not exist "%PROBE%" (
    echo [错误] 探针脚本不存在: %PROBE%
    goto :failed
)

if not exist "%CONFIG%" (
    echo [错误] 配置文件不存在: %CONFIG%
    goto :failed
)

if not exist "%DB%" (
    echo [错误] 数据库不存在: %DB%
    echo.
    echo 可将数据库路径作为第一个参数传入:
    echo   "%~nx0" "D:\VCP\VectorStore\knowledge_base.sqlite"
    goto :failed
)

if not exist "%REPORT_DIR%" mkdir "%REPORT_DIR%"
if errorlevel 1 (
    echo [错误] 无法创建报告目录: %REPORT_DIR%
    goto :failed
)

for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "STAMP=%%I"
if not defined STAMP set "STAMP=manual"

set "MD_REPORT=%REPORT_DIR%\tagmemo_unified_geometry_v2_%STAMP%.md"
set "JSON_REPORT=%REPORT_DIR%\tagmemo_unified_geometry_v2_%STAMP%.json"

echo [开始] 正在读取数据库并执行 V2 数学探针。
echo [修正] 去源域、Top-k 域、平均并列秩、同泛函曲线二乘二对照。
echo [提示] 大型知识库可能需要数分钟，请勿关闭窗口。
echo.

node "%PROBE%" --db "%DB%" --config "%CONFIG%" --probes 12 --max-files 20000 --max-nodes 6000 --curve-files 1500 --steps 80 --domain-mass 0.80 --md "%MD_REPORT%" --json "%JSON_REPORT%"

if errorlevel 1 (
    echo.
    echo [失败] 探针未完成。请保留上方错误信息。
    goto :failed
)

echo.
echo ============================================================
echo  测试完成
echo ============================================================
echo  Markdown 报告:
echo  %MD_REPORT%
echo.
echo  JSON 原始数据:
echo  %JSON_REPORT%
echo ============================================================
echo.
echo 请将 Markdown 报告发回分析；如需复核数值，可同时附上 JSON。
echo.
pause
exit /b 0

:failed
echo.
echo 测试未完成。
echo.
pause
exit /b 1