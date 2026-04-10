use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use tokio::sync::mpsc;

use crate::app::{GithubMirror, InstallConfig, ProgressEvent};
use crate::installer::downloader;

/// 基于 VCPToolBox 的 config.env.example 生成 config.env
pub fn generate_config_env(
    project_dir: &Path,
    config: &InstallConfig,
) -> Result<()> {
    let example_path = project_dir.join("config.env.example");
    let target_path = project_dir.join("config.env");

    if !project_dir.exists() {
        bail!("项目目录不存在: {}", project_dir.display());
    }

    // 如果已有 config.env，先备份再覆盖
    if target_path.exists() {
        let backup_dir = project_dir
            .parent()
            .unwrap_or(project_dir)
            .join("config-backup");

        fs::create_dir_all(&backup_dir)
            .with_context(|| format!("创建配置备份目录失败: {}", backup_dir.display()))?;

        let backup_path = backup_dir.join(format!(
            "config.env.{}.bak",
            chrono_like_timestamp()
        ));

        fs::copy(&target_path, &backup_path).with_context(|| {
            format!(
                "备份现有 config.env 失败: {} -> {}",
                target_path.display(),
                backup_path.display()
            )
        })?;
    }

    let content = if example_path.exists() {
        let original = fs::read_to_string(&example_path)
            .with_context(|| format!("读取模板失败: {}", example_path.display()))?;

        let content = replace_env_value(&original, "API_ENDPOINT", &sanitize_env_value(&config.api_endpoint));
        let content = replace_env_value(&content, "API_KEY", &sanitize_env_value(&config.api_key));
        let content = replace_env_value(&content, "ADMIN_PASSWORD", &sanitize_env_value(&config.admin_password));
        let content = replace_env_value(&content, "TOOL_AUTH_CODE", &sanitize_env_value(&config.tool_auth_code));
        let content = replace_env_value(&content, "PORT", &config.server_port.to_string());

        content
    } else {
        format!(
            "# VCP 配置文件 - 由安装器自动生成\n\
             API_ENDPOINT={}\n\
             API_KEY={}\n\
             ADMIN_PASSWORD={}\n\
             TOOL_AUTH_CODE={}\n\
             PORT={}\n",
            sanitize_env_value(&config.api_endpoint),
            sanitize_env_value(&config.api_key),
            sanitize_env_value(&config.admin_password),
            sanitize_env_value(&config.tool_auth_code),
            config.server_port,
        )
    };

    fs::write(&target_path, content)
        .with_context(|| format!("写入 config.env 失败: {}", target_path.display()))?;

    Ok(())
}

/// 生成 start-backend.bat（安装根目录版本，PM2 双进程）
pub fn generate_start_backend_bat(
    install_dir: &Path,
) -> Result<()> {
    // bat不能包含中文（Rust写UTF-8，cmd用GBK读取会乱码）
    // pm2必须加CALL（bat调.cmd不加CALL控制流一去不返）
    let content = "@echo off\r\n\
setlocal\r\n\
chcp 65001 >nul\r\n\
echo ==========================================\r\n\
echo   VCP Backend Launcher (PM2)\r\n\
echo ==========================================\r\n\
echo.\r\n\
set \"PATH=%~dp0runtimes\\node;%~dp0runtimes\\git\\cmd;%~dp0runtimes\\python;%~dp0runtimes\\python\\Scripts;%PATH%\"\r\n\
cd /d \"%~dp0VCPToolBox\"\r\n\
if not exist \"server.js\" (\r\n\
    echo [VCP] server.js not found. Please check VCPToolBox installation.\r\n\
    pause\r\n\
    exit /b 1\r\n\
)\r\n\
echo [VCP] Cleaning old processes...\r\n\
CALL pm2 delete vcp-main 2>nul\r\n\
CALL pm2 delete vcp-admin 2>nul\r\n\
CALL pm2 delete server 2>nul\r\n\
echo.\r\n\
echo [VCP] Starting main service (vcp-main)...\r\n\
CALL pm2 start server.js --name \"vcp-main\" --no-autorestart --max-memory-restart 1500M --kill-timeout 15000\r\n\
echo [VCP] Waiting for initialization (8s)...\r\n\
ping -n 9 127.0.0.1 >nul\r\n\
echo.\r\n\
echo [VCP] Starting admin panel (vcp-admin)...\r\n\
CALL pm2 start adminServer.js --name \"vcp-admin\" --no-autorestart --max-memory-restart 512M --kill-timeout 5000\r\n\
echo.\r\n\
echo ==========================================\r\n\
echo   VCP Backend Started\r\n\
echo ==========================================\r\n\
echo.\r\n\
CALL pm2 list\r\n\
echo.\r\n\
echo Commands:\r\n\
echo   pm2 list              View process status\r\n\
echo   pm2 logs              View realtime logs\r\n\
echo   pm2 restart vcp-main  Restart main service\r\n\
echo   pm2 stop all          Stop all services\r\n\
echo.\r\n\
pause\r\n";

    let script_path = install_dir.join("start-backend.bat");
    fs::write(&script_path, content)
        .with_context(|| format!("写入启动脚本失败: {}", script_path.display()))?;

    Ok(())
}

/// 生成 start-frontend.bat
pub fn generate_start_frontend_bat(
    install_dir: &Path,
) -> Result<()> {
    let content = "@echo off\r\n\
setlocal\r\n\
chcp 65001 >nul\r\n\
echo ==========================================\r\n\
echo   VCP Frontend Launcher\r\n\
echo ==========================================\r\n\
echo.\r\n\
set \"PATH=%~dp0runtimes\\node;%~dp0runtimes\\git\\cmd;%~dp0runtimes\\python;%~dp0runtimes\\python\\Scripts;%PATH%\"\r\n\
cd /d \"%~dp0VCPChat\"\r\n\
if not exist \"package.json\" (\r\n\
    echo [VCP] package.json not found. Please check VCPChat installation.\r\n\
    pause\r\n\
    exit /b 1\r\n\
)\r\n\
echo [VCP] Starting frontend client...\r\n\
echo.\r\n\
call npm start\r\n\
pause\r\n";

    let script_path = install_dir.join("start-frontend.bat");
    fs::write(&script_path, content)
        .with_context(|| format!("写入启动脚本失败: {}", script_path.display()))?;

    Ok(())
}

/// 生成项目内部启动脚本（覆盖仓库自带的bat，注入portable PATH）
pub fn generate_inner_start_bat(
    install_dir: &Path,
) -> Result<()> {
    let toolbox_dir = install_dir.join("VCPToolBox");
    let chat_dir = install_dir.join("VCPChat");

    // start_server.bat — VCPToolBox内部，PM2双进程 + 向上一级找runtimes
    let content = "@echo off\r\n\
setlocal\r\n\
chcp 65001 >nul\r\n\
echo ==========================================\r\n\
echo   VCP Backend Launcher (PM2)\r\n\
echo ==========================================\r\n\
echo.\r\n\
set \"PATH=%~dp0..\\runtimes\\node;%~dp0..\\runtimes\\git\\cmd;%~dp0..\\runtimes\\python;%~dp0..\\runtimes\\python\\Scripts;%PATH%\"\r\n\
cd /d \"%~dp0\"\r\n\
if not exist \"server.js\" (\r\n\
    echo [VCP] server.js not found. Please check VCPToolBox installation.\r\n\
    pause\r\n\
    exit /b 1\r\n\
)\r\n\
echo [VCP] Cleaning old processes...\r\n\
CALL pm2 delete vcp-main 2>nul\r\n\
CALL pm2 delete vcp-admin 2>nul\r\n\
CALL pm2 delete server 2>nul\r\n\
echo.\r\n\
echo [VCP] Starting main service (vcp-main)...\r\n\
CALL pm2 start server.js --name \"vcp-main\" --no-autorestart --max-memory-restart 1500M --kill-timeout 15000\r\n\
echo [VCP] Waiting for initialization (8s)...\r\n\
ping -n 9 127.0.0.1 >nul\r\n\
echo.\r\n\
echo [VCP] Starting admin panel (vcp-admin)...\r\n\
CALL pm2 start adminServer.js --name \"vcp-admin\" --no-autorestart --max-memory-restart 512M --kill-timeout 5000\r\n\
echo.\r\n\
echo ==========================================\r\n\
echo   VCP Backend Started\r\n\
echo ==========================================\r\n\
echo.\r\n\
CALL pm2 list\r\n\
echo.\r\n\
echo Commands:\r\n\
echo   pm2 list              View process status\r\n\
echo   pm2 logs              View realtime logs\r\n\
echo   pm2 restart vcp-main  Restart main service\r\n\
echo   pm2 stop all          Stop all services\r\n\
echo.\r\n\
pause\r\n";

    if toolbox_dir.exists() {
        let script_path = toolbox_dir.join("start_server.bat");
        fs::write(&script_path, content)
            .with_context(|| format!("写入启动脚本失败: {}", script_path.display()))?;
    }

    // start.bat — VCPChat内部
    let chat_content = "@echo off\r\n\
setlocal\r\n\
chcp 65001 >nul\r\n\
set \"PATH=%~dp0..\\runtimes\\node;%~dp0..\\runtimes\\git\\cmd;%~dp0..\\runtimes\\python;%~dp0..\\runtimes\\python\\Scripts;%PATH%\"\r\n\
cd /d \"%~dp0\"\r\n\
echo [VCP] Starting VCPChat Desktop...\r\n\
START \"\" \"NativeSplash.exe\"\r\n\
call npm start\r\n\
pause\r\n";

    if chat_dir.exists() {
        let script_path = chat_dir.join("start.bat");
        fs::write(&script_path, chat_content)
            .with_context(|| format!("写入启动脚本失败: {}", script_path.display()))?;
    }

    // start-all.bat — VCPChat root, launches VChat + Desktop
    if chat_dir.exists() {
        let start_all_content = "@echo off\r\n\
setlocal\r\n\
chcp 65001 >nul\r\n\
echo ==========================================\r\n\
echo   VCP Start All (VChat + Desktop)\r\n\
echo ==========================================\r\n\
echo.\r\n\
set \"PATH=%~dp0..\\runtimes\\node;%~dp0..\\runtimes\\git\\cmd;%~dp0..\\runtimes\\python;%~dp0..\\runtimes\\python\\Scripts;%PATH%\"\r\n\
cd /d \"%~dp0\"\r\n\
if exist \"NativeSplash.exe\" (\r\n\
    echo [VCP] Launching splash screen...\r\n\
    START \"\" \"NativeSplash.exe\"\r\n\
)\r\n\
echo [VCP] Starting VChat main window...\r\n\
START \"\" /MIN cmd /c \"cd /d \"%~dp0\" && npx electron .\"\r\n\
echo [VCP] Waiting for VChat ready signal...\r\n\
set /a waited=0\r\n\
:WAIT_LOOP\r\n\
if exist \".vcp_ready\" goto READY\r\n\
if %waited% GEQ 60 goto TIMEOUT\r\n\
ping -n 2 127.0.0.1 >nul\r\n\
set /a waited+=1\r\n\
echo [VCP] Waiting... %waited%/60s\r\n\
goto WAIT_LOOP\r\n\
:READY\r\n\
echo [VCP] VChat is ready!\r\n\
del \".vcp_ready\" >nul 2>nul\r\n\
ping -n 3 127.0.0.1 >nul\r\n\
echo [VCP] Starting Desktop widget...\r\n\
START \"\" /MIN cmd /c \"cd /d \"%~dp0\" && npx electron . --desktop-only\"\r\n\
echo [VCP] All services started!\r\n\
goto END\r\n\
:TIMEOUT\r\n\
echo [VCP] Warning: VChat ready signal timeout (60s). Desktop widget not started.\r\n\
goto END\r\n\
:END\r\n\
echo.\r\n\
pause\r\n";

        let script_path = chat_dir.join("start-all.bat");
        fs::write(&script_path, start_all_content)
            .with_context(|| format!("写入启动脚本失败: {}", script_path.display()))?;
    }

    // VCPChat VBS scripts — inject portable PATH via WshShell.Environment
    if chat_dir.exists() {
        // PATH injection snippet (reused in all vbs)
        // Uses .vbs's own path to find ..\runtimes relative to VCPChat
        let vbs_path_inject = r#"Set WshShell = CreateObject("WScript.Shell")
Set WshEnv = WshShell.Environment("Process")
projectPath = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
runtimesBase = projectPath & "\..\runtimes"
WshEnv("PATH") = runtimesBase & "\node;" & runtimesBase & "\git\cmd;" & runtimesBase & "\python;" & runtimesBase & "\python\Scripts;" & WshEnv("PATH")
WshShell.CurrentDirectory = projectPath
"#;

        // start-vchat.vbs (replaces 启动Vchat.vbs)
        let vchat_vbs = format!(r#"{}
WshShell.Run "cmd /c START """" ""NativeSplash.exe"" && npx electron .", 0, False
"#, vbs_path_inject);

        fs::write(chat_dir.join("start-vchat.vbs"), &vchat_vbs)
            .with_context(|| "写入 start-vchat.vbs 失败")?;

        // start-desktop.vbs
        let desktop_vbs = format!(r#"{}
WshShell.Run "cmd /c npx electron . --desktop-only", 0, False
"#, vbs_path_inject);

        fs::write(chat_dir.join("start-desktop.vbs"), &desktop_vbs)
            .with_context(|| "写入 start-desktop.vbs 失败")?;

        // start-rag-observer.vbs
        let rag_vbs = format!(r#"{}
WshShell.Run "cmd /c npx electron . --rag-observer-only", 0, False
"#, vbs_path_inject);

        fs::write(chat_dir.join("start-rag-observer.vbs"), &rag_vbs)
            .with_context(|| "写入 start-rag-observer.vbs 失败")?;

        // start-all.vbs (replaces 启动全部.vbs)
        let all_vbs = format!(r#"{}
' Launch main VCPChat window with splash
WshShell.Run "cmd /c START """" ""NativeSplash.exe"" && npx electron .", 0, False

' Wait for .vcp_ready signal (max 60s)
Set fso = CreateObject("Scripting.FileSystemObject")
readyFile = projectPath & "\.vcp_ready"
waited = 0
Do While Not fso.FileExists(readyFile) And waited < 60
    WScript.Sleep 1000
    waited = waited + 1
Loop

If fso.FileExists(readyFile) Then
    fso.DeleteFile readyFile, True
    WScript.Sleep 1000
    ' Launch desktop widget
    WshShell.Run "cmd /c npx electron . --desktop-only", 0, False
End If
"#, vbs_path_inject);

        fs::write(chat_dir.join("start-all.vbs"), &all_vbs)
            .with_context(|| "写入 start-all.vbs 失败")?;
    }

    Ok(())
}

/// 下载 NewAPI exe
pub async fn download_newapi(
    install_dir: &Path,
    mirror: &GithubMirror,
    step_index: usize,
    progress_tx: mpsc::Sender<ProgressEvent>,
) -> Result<()> {
    let (url, version) = downloader::get_github_release_url(
        "QuantumNous/new-api",
        "new-api",
    )
    .await
    .context("查询 NewAPI 最新版本失败")?;

    let lower = url.to_ascii_lowercase();
    if !lower.ends_with(".exe") || lower.contains("setup") {
        bail!("获取到的 NewAPI 资产不是期望的裸 exe: {}", url);
    }

    let _ = progress_tx
        .send(ProgressEvent::Log(format!("发现 NewAPI 版本: {}", version)))
        .await;

    let mirror_prefix = mirror.prefix();
    let mirrored_url = downloader::apply_mirror(&url, &mirror_prefix);

    downloader::download_with_retry(
        downloader::DownloadConfig {
            url: mirrored_url,
            dest: install_dir.join("new-api.exe"),
            step_index,
            resume: false,
        },
        progress_tx,
        3,
    )
    .await
    .context("下载 NewAPI 失败")?;

    Ok(())
}

fn replace_env_value(content: &str, key: &str, value: &str) -> String {
    let mut result = String::new();
    let mut replaced = false;

    for line in content.lines() {
        let trimmed = line.trim_start();
        let is_target = trimmed.starts_with(&format!("{key}="))
            || trimmed.starts_with(&format!("#{key}="))
            || trimmed.starts_with(&format!("# {key}="));

        if is_target {
            if !replaced {
                result.push_str(&format!("{key}={value}\n"));
                replaced = true;
            }
            continue;
        }

        result.push_str(line);
        result.push('\n');
    }

    if !replaced {
        result.push_str(&format!("{key}={value}\n"));
    }

    result
}

fn sanitize_env_value(value: &str) -> String {
    value.replace('\r', "").replace('\n', "")
}

fn chrono_like_timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    secs.to_string()
}