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

/// 生成 start-backend.bat
pub fn generate_start_backend_bat(
    install_dir: &Path,
) -> Result<()> {
    let content = "@echo off\r\n\
setlocal\r\n\
chcp 65001 >nul\r\n\
echo ==========================================\r\n\
echo   VCP 后端服务启动器\r\n\
echo ==========================================\r\n\
echo.\r\n\
set \"PATH=%~dp0runtimes\\node;%~dp0runtimes\\git\\cmd;%~dp0runtimes\\python;%~dp0runtimes\\python\\Scripts;%PATH%\"\r\n\
cd /d \"%~dp0VCPToolBox\"\r\n\
if not exist \"server.js\" (\r\n\
    echo [VCP] 未找到 server.js，请确认 VCPToolBox 已正确安装。\r\n\
    pause\r\n\
    exit /b 1\r\n\
)\r\n\
echo [VCP] 正在启动后端服务...\r\n\
echo [VCP] 按 Ctrl+C 可停止服务\r\n\
echo.\r\n\
node server.js\r\n\
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
echo   VCP 前端客户端启动器\r\n\
echo ==========================================\r\n\
echo.\r\n\
set \"PATH=%~dp0runtimes\\node;%~dp0runtimes\\git\\cmd;%~dp0runtimes\\python;%~dp0runtimes\\python\\Scripts;%PATH%\"\r\n\
cd /d \"%~dp0VCPChat\"\r\n\
if not exist \"package.json\" (\r\n\
    echo [VCP] 未找到 package.json，请确认 VCPChat 已正确安装。\r\n\
    pause\r\n\
    exit /b 1\r\n\
)\r\n\
echo [VCP] 正在启动前端客户端...\r\n\
echo.\r\n\
call npm start\r\n\
pause\r\n";

    let script_path = install_dir.join("start-frontend.bat");
    fs::write(&script_path, content)
        .with_context(|| format!("写入启动脚本失败: {}", script_path.display()))?;

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