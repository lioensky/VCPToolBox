use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use futures_util::StreamExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use crate::app::ProgressEvent;
use crate::mirrors::MirrorConfig;

/// Install arguments: --quiet no GUI, --norestart prevents system restart prompt
/// Workloads: VCTools includes VC++ compiler + Windows SDK
const INSTALL_ARGS: &[&str] = &[
    "--wait",
    "--quiet",
    "--norestart",
    "--add", "Microsoft.VisualStudio.Workload.VCTools",
    "--includeRecommended",
];

/// Total timeout for the entire MSVC install operation (30 minutes).
/// vs_BuildTools.exe + component download + install can legitimately take a long
/// time on slow connections, but anything beyond 30 min is almost certainly stuck.
const MSVC_TOTAL_TIMEOUT_SECS: u64 = 1800;

/// Activity timeout: if no output for this many seconds, consider the process hung.
/// vs_BuildTools.exe is very quiet during component downloads (can go 2-3 min silent
/// between progress updates). 180 seconds is safe.
const MSVC_ACTIVITY_TIMEOUT_SECS: u64 = 180;

/// Maximum retry attempts for the entire install (winget or direct download).
const MSVC_MAX_RETRIES: u32 = 3;

/// Check if winget is available
fn is_winget_available() -> bool {
    std::process::Command::new("winget")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Verify MSVC Build Tools is actually installed (vswhere check).
/// Returns Ok(version_string) if found, Err if not detected.
/// This is the post-install verification step to catch silent install failures.
pub fn verify_msvc_installed() -> Result<String> {
    let program_files_x86 = std::env::var("ProgramFiles(x86)")
        .unwrap_or_else(|_| r"C:\Program Files (x86)".to_string());
    let vswhere_path = Path::new(&program_files_x86)
        .join("Microsoft Visual Studio")
        .join("Installer")
        .join("vswhere.exe");

    if !vswhere_path.exists() {
        bail!("vswhere.exe not found at {}", vswhere_path.display());
    }

    let output = Command::new(&vswhere_path)
        .args([
            "-latest",
            "-products", "*",
            "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
            "-property", "displayName",
            "-utf8",
        ])
        .output()
        .context("Failed to run vswhere.exe")?;

    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if name.is_empty() {
        bail!("MSVC Build Tools not detected after install (vswhere returned empty)");
    }

    Ok(name)
}

/// Wait for child process with:
/// 1. Heartbeat log every heartbeat_secs (visibility)
/// 2. Activity watchdog: kill if no output for activity_timeout_secs (2GB download hang)
/// 3. Total timeout: kill if running longer than total_timeout_secs (30 min safety)
///
/// The activity timestamp is shared with the reader tasks via `activity_marker`.
async fn wait_with_heartbeat(
    mut child: tokio::process::Child,
    tx: &mpsc::Sender<ProgressEvent>,
    task_name: &str,
    heartbeat_secs: u64,
    activity_timeout_secs: u64,
    total_timeout_secs: u64,
    activity_marker: Arc<AtomicU64>,
) -> Result<std::process::ExitStatus> {
    use std::time::{Duration, Instant};

    let start = Instant::now();

    loop {
        tokio::select! {
            result = child.wait() => {
                return result.context("Waiting for process failed");
            }
            _ = tokio::time::sleep(Duration::from_secs(heartbeat_secs)) => {
                let now = Instant::now();

                // Total timeout check (hard kill at 30 min)
                if now.duration_since(start) >= Duration::from_secs(total_timeout_secs) {
                    let _ = child.kill().await;
                    bail!(
                        "{} total timeout exceeded ({}s), killing process",
                        task_name, total_timeout_secs
                    );
                }

                // Activity timeout check (hung detection)
                let last_activity_secs = activity_marker.load(Ordering::Relaxed);
                let now_secs = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                if last_activity_secs > 0
                    && now_secs.saturating_sub(last_activity_secs) >= activity_timeout_secs
                {
                    let _ = child.kill().await;
                    bail!(
                        "{} activity timeout exceeded (no output for {}s), killing process",
                        task_name, activity_timeout_secs
                    );
                }

                let elapsed = now.duration_since(start).as_secs();
                let mins = elapsed / 60;
                let secs = elapsed % 60;
                let msg = if mins > 0 {
                    format!("  Waiting {} ... {}m{}s", task_name, mins, secs)
                } else {
                    format!("  Waiting {} ... {}s", task_name, secs)
                };
                crate::log_router::send_log_event(&tx, msg).await;
            }
        }
    }
}

/// Wait for child process with realtime output reading + activity/total timeout watchdog.
///
/// Spawns reader tasks that log lines as they arrive and update a shared activity
/// timestamp. The main loop enforces activity timeout (no output = network blackhole)
/// and total timeout (30 min safety).
async fn wait_with_realtime_output(
    mut child: tokio::process::Child,
    tx: &mpsc::Sender<ProgressEvent>,
    task_name: &str,
    heartbeat_secs: u64,
    activity_timeout_secs: u64,
    total_timeout_secs: u64,
) -> Result<std::process::ExitStatus> {
    use std::time::{Duration, Instant};

    let start = Instant::now();
    // Shared activity marker (unix secs). Reader tasks update it; main loop reads it.
    // Initialize to now so the watchdog has a baseline.
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let activity_marker = Arc::new(AtomicU64::new(now_secs));

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let tx_out = tx.clone();
    let marker_out = activity_marker.clone();
    let stdout_task = tokio::spawn(async move {
        if let Some(out) = stdout {
            let reader = BufReader::new(out);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                // Update activity on every read
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                marker_out.store(now, Ordering::Relaxed);

                let trimmed = line.trim().to_string();
                if !trimmed.is_empty() {
                    let _ = crate::log_router::send_log_event(
                        &tx_out,
                        format!("  [winget] {}", trimmed),
                    )
                    .await;
                }
            }
        }
    });

    let tx_err = tx.clone();
    let marker_err = activity_marker.clone();
    let stderr_task = tokio::spawn(async move {
        if let Some(err) = stderr {
            let reader = BufReader::new(err);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                marker_err.store(now, Ordering::Relaxed);

                let trimmed = line.trim().to_string();
                if !trimmed.is_empty() {
                    let _ = crate::log_router::send_log_event(
                        &tx_err,
                        format!("  [winget] {}", trimmed),
                    )
                    .await;
                }
            }
        }
    });

    // Main loop: select on child exit or heartbeat/timeout check.
    loop {
        tokio::select! {
            result = child.wait() => {
                // Process ended. Wait for readers to drain remaining buffered output.
                let _ = stdout_task.await;
                let _ = stderr_task.await;
                return result.context("Waiting for process failed");
            }
            _ = tokio::time::sleep(Duration::from_secs(heartbeat_secs)) => {
                let now = Instant::now();

                // Total timeout (hard kill at 30 min)
                if now.duration_since(start) >= Duration::from_secs(total_timeout_secs) {
                    let _ = child.kill().await;
                    stdout_task.abort();
                    stderr_task.abort();
                    bail!(
                        "{} total timeout exceeded ({}s), killing process",
                        task_name, total_timeout_secs
                    );
                }

                // Activity timeout (no output for too long = hung)
                let last_activity_secs = activity_marker.load(Ordering::Relaxed);
                let now_secs = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                if last_activity_secs > 0
                    && now_secs.saturating_sub(last_activity_secs) >= activity_timeout_secs
                {
                    let _ = child.kill().await;
                    stdout_task.abort();
                    stderr_task.abort();
                    bail!(
                        "{} activity timeout exceeded (no output for {}s), killing process",
                        task_name, activity_timeout_secs
                    );
                }

                let elapsed = now.duration_since(start).as_secs();
                let mins = elapsed / 60;
                let secs = elapsed % 60;
                let msg = if mins > 0 {
                    format!("  Waiting {} ... {}m{}s", task_name, mins, secs)
                } else {
                    format!("  Waiting {} ... {}s", task_name, secs)
                };
                crate::log_router::send_log_event(&tx, msg).await;
            }
        }
    }
}

/// Install VS Build Tools via winget
async fn install_via_winget(
    tx: &mpsc::Sender<ProgressEvent>,
) -> Result<()> {
    crate::log_router::send_log_event(&tx,
        "  winget detected, installing VS Build Tools via winget...".to_string(),
    ).await;

    crate::log_router::send_log_event(&tx,
        "  NOTE: About 1-2 GB download, expect 5-15 minutes. Be patient.".to_string(),
    ).await;

    crate::log_router::send_log_event(&tx,
        "  Downloading Microsoft.VisualStudio.2022.BuildTools...".to_string(),
    ).await;

    let child = tokio::process::Command::new("winget")
        .args([
            "install",
            "Microsoft.VisualStudio.2022.BuildTools",
            "--override", "--wait --quiet --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended",
            "--accept-source-agreements",
            "--accept-package-agreements",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("Failed to start winget")?;

    let status = wait_with_realtime_output(
        child, tx, "MSVC install", 15,
        MSVC_ACTIVITY_TIMEOUT_SECS,
        MSVC_TOTAL_TIMEOUT_SECS,
    ).await?;

    if status.success() {
        Ok(())
    } else {
        bail!("winget install failed, exit code: {:?}", status.code())
    }
}

/// Download vs_BuildTools.exe with streaming + mirror fallback (URLs from config)
async fn download_vs_buildtools_exe(
    tx: &mpsc::Sender<ProgressEvent>,
    exe_path: &Path,
    mirror_config: &MirrorConfig,
) -> Result<()> {
    tokio::fs::create_dir_all(exe_path.parent().unwrap()).await
        .context("Failed to create DL_runtimes directory")?;

    // No hard timeout here — hangs are caught by the install-step activity watchdog.
    // The download itself can be slow but we'll detect stalls via vs_BuildTools.exe output.
    let client = reqwest::Client::builder()
        .build()
        .context("Failed to create HTTP client")?;

    let urls: Vec<String> = mirror_config.msvc.iter().map(|e| e.url.clone()).collect();

    for (i, url) in urls.iter().enumerate() {
        if i > 0 {
            crate::log_router::send_log_event(&tx, format!(
                "  Retrying with mirror: {}",
                url
            )).await;
        }

        crate::log_router::send_log_event(&tx, format!(
            "  Downloading vs_BuildTools.exe from: {}",
            url
        )).await;

        match stream_download(&client, url, exe_path, tx).await {
            Ok(_) => {
                let size = tokio::fs::metadata(exe_path).await?.len();
                crate::log_router::send_log_event(&tx, format!(
                    "  Download complete: {:.1} MB, saved to DL_runtimes",
                    size as f64 / (1024.0 * 1024.0)
                )).await;
                return Ok(());
            }
            Err(e) => {
                // Clean partial file
                let _ = tokio::fs::remove_file(exe_path).await;
                crate::log_router::send_log_event(&tx, format!(
                    "  Download failed: {}",
                    e
                )).await;
            }
        }
    }

    bail!("Failed to download vs_BuildTools.exe from all configured URLs")
}

/// Stream download with progress reporting
async fn stream_download(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    tx: &mpsc::Sender<ProgressEvent>,
) -> Result<()> {
    let mut file = tokio::fs::File::create(dest).await
        .with_context(|| format!("Failed to create file: {}", dest.display()))?;

    let mut downloaded: u64 = 0;
    let mut last_report = std::time::Instant::now();

    let response = client.get(url).send().await
        .with_context(|| format!("Request failed: {}", url))?;

    if !response.status().is_success() {
        bail!("Download failed: HTTP {}", response.status());
    }

    let total = response.content_length().unwrap_or(0);
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.with_context(|| format!("Read stream failed: {}", url))?;

        file.write_all(&chunk).await
            .with_context(|| format!("Write failed: {}", dest.display()))?;

        downloaded += chunk.len() as u64;

        // Report at most once per second
        if last_report.elapsed().as_secs() >= 1 {
            if total > 0 {
                let pct = (downloaded as f64 / total as f64) * 100.0;
                crate::log_router::send_log_event(&tx, format!(
                    "  Download: {:.1}% ({:.1}/{:.1} MB)",
                    pct,
                    downloaded as f64 / (1024.0 * 1024.0),
                    total as f64 / (1024.0 * 1024.0)
                )).await;
            } else {
                crate::log_router::send_log_event(&tx, format!(
                    "  Download: {:.1} MB",
                    downloaded as f64 / (1024.0 * 1024.0)
                )).await;
            }
            last_report = std::time::Instant::now();
        }
    }

    file.flush().await
        .with_context(|| format!("Flush failed: {}", dest.display()))?;

    Ok(())
}

/// Install VS Build Tools via direct download
async fn install_via_direct_download(
    tx: &mpsc::Sender<ProgressEvent>,
    _install_path: &Path,
    mirror_config: &MirrorConfig,
) -> Result<()> {
    crate::log_router::send_log_event(&tx,
        "  winget not available (or failed), using vs_BuildTools.exe...".to_string(),
    ).await;

    let dl_runtimes_dir = crate::mirrors::get_exe_dir().join("DL_runtimes");
    let exe_path = dl_runtimes_dir.join("vs_BuildTools.exe");

    if exe_path.exists() {
        let size = tokio::fs::metadata(&exe_path).await?.len();
        crate::log_router::send_log_event(&tx, format!(
            "  Cached vs_BuildTools.exe found ({:.1} MB), reusing",
            size as f64 / (1024.0 * 1024.0)
        )).await;
    } else {
        download_vs_buildtools_exe(tx, &exe_path, mirror_config).await?;
    }

    crate::log_router::send_log_event(&tx,
        "  NOTE: About 1-2 GB download, expect 5-15 minutes. Be patient.".to_string(),
    ).await;

    crate::log_router::send_log_event(&tx,
        "  Installing VS Build Tools (downloading components in background)...".to_string(),
    ).await;

    // Shared activity marker for the watchdog (vs_BuildTools.exe is mostly quiet).
    // It prints occasional progress lines; we treat any output as activity.
    let activity_marker = Arc::new(AtomicU64::new(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    ));

    // Collect proxy env vars from current process and pass to installer
    let mut cmd = tokio::process::Command::new(&exe_path);
    cmd.args(INSTALL_ARGS);

    for (key, _) in std::env::vars() {
        let lower = key.to_lowercase();
        if lower.contains("proxy") {
            if let Ok(val) = std::env::var(&key) {
                cmd.env(&key, val);
            }
        }
    }

    let child = cmd.spawn().context("Failed to start vs_BuildTools.exe")?;

    let status = wait_with_heartbeat(
        child, tx, "MSVC install", 15,
        MSVC_ACTIVITY_TIMEOUT_SECS,
        MSVC_TOTAL_TIMEOUT_SECS,
        activity_marker,
    ).await?;

    if status.success() {
        Ok(())
    } else {
        bail!("vs_BuildTools.exe install failed, exit code: {:?}", status.code())
    }
}

/// Install MSVC Build Tools (main entry)
///
/// Strategy:
/// 1. Try winget first
/// 2. If winget unavailable or fails, fallback to direct download vs_BuildTools.exe
/// 3. After install, verify with vswhere
/// 4. Retry up to MSVC_MAX_RETRIES times on failure
///
/// Install failure BLOCKS the overall flow (returns Err) since native modules
/// cannot be compiled without MSVC.
pub async fn install_msvc_build_tools(
    tx: &mpsc::Sender<ProgressEvent>,
    install_path: &Path,
    mirror_config: &MirrorConfig,
) -> Result<()> {
    let mut last_error = String::new();

    for attempt in 1..=MSVC_MAX_RETRIES {
        if attempt > 1 {
            crate::log_router::send_log_event(&tx, format!(
                "  MSVC install attempt {}/{}, retrying...",
                attempt, MSVC_MAX_RETRIES
            )).await;
        }

        let result = if is_winget_available() {
            match install_via_winget(tx).await {
                Ok(()) => Ok(()),
                Err(e) => {
                    crate::log_router::send_log_event(&tx, format!(
                        "  winget failed: {}", e
                    )).await;
                    crate::log_router::send_log_event(&tx,
                        "  Falling back to direct download...".to_string(),
                    ).await;
                    // Fallback to direct download on same attempt
                    install_via_direct_download(tx, install_path, mirror_config).await
                        .map_err(|de| {
                            anyhow::anyhow!("winget: {}; direct: {}", e, de)
                        })
                }
            }
        } else {
            install_via_direct_download(tx, install_path, mirror_config).await
        };

        match &result {
            Ok(()) => {
                // Post-install verification with vswhere
                crate::log_router::send_log_event(&tx,
                    "  Verifying MSVC installation with vswhere...".to_string(),
                ).await;

                match verify_msvc_installed() {
                    Ok(version) => {
                        crate::log_router::send_log_event(&tx,
                            format!("  MSVC verified: {}", version),
                        ).await;
                        crate::log_router::send_log_event(&tx,
                            "VS Build Tools installed successfully".to_string(),
                        ).await;
                        return Ok(());
                    }
                    Err(e) => {
                        last_error = format!("verification failed: {}", e);
                        crate::log_router::send_log_event(&tx, format!(
                            "  MSVC verification FAILED: {}", e
                        )).await;
                    }
                }
            }
            Err(e) => {
                last_error = e.to_string();
                crate::log_router::send_log_event(&tx, format!(
                    "  MSVC install error: {}", e
                )).await;
            }
        }
    }

    // All retries exhausted
    bail!(
        "MSVC Build Tools install failed after {} attempts: {}. \
         Native modules (better-sqlite3, node-pty, hnswlib-node) cannot be compiled without it.",
        MSVC_MAX_RETRIES, last_error
    )
}
