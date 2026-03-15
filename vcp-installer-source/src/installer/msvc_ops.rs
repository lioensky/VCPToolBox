use std::path::Path;

use anyhow::{Context, Result, bail};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;

use crate::app::ProgressEvent;

/// vs_BuildTools.exe 官方下载地址
const VS_BUILDTOOLS_URL: &str = "https://aka.ms/vs/17/release/vs_BuildTools.exe";

/// 安装参数：--passive 显示GUI进度（比 --quiet 友好）
/// 工作负载：VCTools 包含 VC++ 编译器 + Windows SDK
const INSTALL_ARGS: &str = "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --add Microsoft.VisualStudio.Component.VC.ATLMFC.Spectre --add Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre --includeRecommended";

/// 检测 winget 是否可用
fn is_winget_available() -> bool {
    std::process::Command::new("winget")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// 等待子进程完成，期间每15秒发送心跳日志（用于无stdout输出的场景）
async fn wait_with_heartbeat(
    mut child: tokio::process::Child,
    tx: &mpsc::Sender<ProgressEvent>,
    task_name: &str,
) -> Result<std::process::ExitStatus> {
    let mut elapsed = 0u64;
    loop {
        tokio::select! {
            result = child.wait() => {
                return result.context("等待进程失败");
            }
            _ = tokio::time::sleep(std::time::Duration::from_secs(15)) => {
                elapsed += 15;
                let mins = elapsed / 60;
                let secs = elapsed % 60;
                let msg = if mins > 0 {
                    format!("  {} 已等待 {}分{}秒...", task_name, mins, secs)
                } else {
                    format!("  {} 已等待 {}秒...", task_name, secs)
                };
                tx.send(ProgressEvent::Log(msg)).await.ok();
            }
        }
    }
}

/// 等待子进程完成，同时逐行读取 stdout/stderr 实时推送到 TUI，并保留心跳兜底
async fn wait_with_realtime_output(
    mut child: tokio::process::Child,
    tx: &mpsc::Sender<ProgressEvent>,
    task_name: &str,
) -> Result<std::process::ExitStatus> {
    // 取出 stdout/stderr
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let tx_out = tx.clone();
    let tx_err = tx.clone();
    let tx_hb = tx.clone();
    let task_name_hb = task_name.to_string();

    // spawn stdout 逐行读取
    let stdout_task = tokio::spawn(async move {
        if let Some(out) = stdout {
            let reader = BufReader::new(out);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim().to_string();
                if !trimmed.is_empty() {
                    tx_out.send(ProgressEvent::Log(format!("  [winget] {}", trimmed))).await.ok();
                }
            }
        }
    });

    // spawn stderr 逐行读取
    let stderr_task = tokio::spawn(async move {
        if let Some(err) = stderr {
            let reader = BufReader::new(err);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim().to_string();
                if !trimmed.is_empty() {
                    tx_err.send(ProgressEvent::Log(format!("  [winget] {}", trimmed))).await.ok();
                }
            }
        }
    });

    // spawn 心跳兜底（winget可能长时间无输出）
    let heartbeat_task = tokio::spawn(async move {
        let mut elapsed = 0u64;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            elapsed += 30;
            let mins = elapsed / 60;
            let secs = elapsed % 60;
            let msg = if mins > 0 {
                format!("  {} 已运行 {}分{}秒...", task_name_hb, mins, secs)
            } else {
                format!("  {} 已运行 {}秒...", task_name_hb, secs)
            };
            tx_hb.send(ProgressEvent::Log(msg)).await.ok();
        }
    });

    // 等待子进程结束
    let status = child.wait().await.context("等待进程失败")?;

    // 等 stdout/stderr 读完
    let _ = stdout_task.await;
    let _ = stderr_task.await;

    // 终止心跳
    heartbeat_task.abort();

    Ok(status)
}

/// 通过 winget 安装 VS Build Tools
async fn install_via_winget(
    tx: &mpsc::Sender<ProgressEvent>,
) -> Result<()> {
    tx.send(ProgressEvent::Log(
        "  检测到 winget，使用 winget 安装 VS Build Tools...".to_string(),
    )).await.ok();

    tx.send(ProgressEvent::Log(
        "  这需要下载约 1-2GB，可能需要较长时间，请耐心等待...".to_string(),
    )).await.ok();

    let child = tokio::process::Command::new("winget")
        .args([
            "install",
            "Microsoft.VisualStudio.2022.BuildTools",
            "--override", INSTALL_ARGS,
            "--accept-source-agreements",
            "--accept-package-agreements",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("启动 winget 失败")?;

    // 使用实时输出 + 心跳
    let status = wait_with_realtime_output(child, tx, "MSVC 安装").await?;

    if status.success() {
        Ok(())
    } else {
        bail!("winget 安装 VS Build Tools 失败，退出码: {:?}", status.code())
    }
}

/// 直接下载 vs_BuildTools.exe 并运行安装
async fn install_via_direct_download(
    tx: &mpsc::Sender<ProgressEvent>,
    install_path: &Path,
) -> Result<()> {
    tx.send(ProgressEvent::Log(
        "  winget 不可用，将直接下载 vs_BuildTools.exe 安装...".to_string(),
    )).await.ok();

    // 下载 vs_BuildTools.exe
    let downloads_dir = install_path.join("runtimes").join("downloads");
    tokio::fs::create_dir_all(&downloads_dir).await
        .context("创建下载目录失败")?;

    let exe_path = downloads_dir.join("vs_BuildTools.exe");

    tx.send(ProgressEvent::Log(
        "  正在下载 vs_BuildTools.exe（约 1.4MB）...".to_string(),
    )).await.ok();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .context("创建 HTTP 客户端失败")?;

    let resp = client.get(VS_BUILDTOOLS_URL)
        .send()
        .await
        .context("下载 vs_BuildTools.exe 失败")?;

    if !resp.status().is_success() {
        bail!("下载 vs_BuildTools.exe 失败，HTTP {}", resp.status());
    }

    let bytes = resp.bytes().await.context("读取下载内容失败")?;
    tokio::fs::write(&exe_path, &bytes).await.context("保存 vs_BuildTools.exe 失败")?;

    tx.send(ProgressEvent::Log(
        format!("  vs_BuildTools.exe 下载完成 ({:.1} KB)", bytes.len() as f64 / 1024.0),
    )).await.ok();

    // 运行安装（--passive 显示 GUI 进度窗口）
    tx.send(ProgressEvent::Log(
        "  正在安装 VS Build Tools（将弹出安装进度窗口）...".to_string(),
    )).await.ok();

    tx.send(ProgressEvent::Log(
        "  这需要下载约 1-2GB 组件，可能需要较长时间，请耐心等待...".to_string(),
    )).await.ok();

    let child = tokio::process::Command::new(&exe_path)
        .args(INSTALL_ARGS.split_whitespace())
        .spawn()
        .context("启动 vs_BuildTools.exe 失败")?;

    // 直接下载路径用 --passive 弹GUI，只需心跳兜底
    let status = wait_with_heartbeat(child, tx, "MSVC 安装").await?;

    // 清理下载的安装文件
    let _ = tokio::fs::remove_file(&exe_path).await;
    let _ = tokio::fs::remove_dir(&downloads_dir).await;

    if status.success() {
        Ok(())
    } else {
        bail!("vs_BuildTools.exe 安装失败，退出码: {:?}", status.code())
    }
}

/// 安装 MSVC Build Tools（主入口）
///
/// 策略：winget 优先，不可用时降级为直接下载 vs_BuildTools.exe
/// 安装失败不阻断整体流程
pub async fn install_msvc_build_tools(
    tx: &mpsc::Sender<ProgressEvent>,
    install_path: &Path,
) -> Result<()> {
    let result = if is_winget_available() {
        install_via_winget(tx).await
    } else {
        install_via_direct_download(tx, install_path).await
    };

    match &result {
        Ok(()) => {
            tx.send(ProgressEvent::Log(
                "✅ VS Build Tools 安装完成".to_string(),
            )).await.ok();
        }
        Err(e) => {
            tx.send(ProgressEvent::Log(
                format!("⚠ VS Build Tools 安装失败: {}", e),
            )).await.ok();
            tx.send(ProgressEvent::Log(
                "  npm install 将继续执行，但原生模块可能编译失败".to_string(),
            )).await.ok();
        }
    }

    result
}