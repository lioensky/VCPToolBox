//! GitHub 镜像站真实下载测试
//!
//! 使用 VCPToolBox 源码 tar.gz（~175MB）验证站点可用性，
//! 直接测试实际安装文件的下载能力。

use anyhow::{Context, Result};
use futures_util::stream::TryStreamExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::fs::{self, File};
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, Semaphore};

use super::config::MirrorEntry;
use crate::app::ProgressEvent;

/// Phase0 项目存在性检查结果
#[derive(Debug, Clone)]
pub struct ProjectExistsResult {
    pub entry: MirrorEntry,
    pub exists: bool,
    pub http_code: u16,
    pub elapsed_secs: f64,
}

/// 向进度通道发送日志
async fn send_log(tx: &mpsc::Sender<ProgressEvent>, msg: impl Into<String>) {
    let _ = crate::log_router::send_log_event(&tx, msg.into()).await;
}

/// Phase0: 项目存在性预校验
///
/// 对 GitHub Official + [github] 镜像站列表，验证目标项目是否存在。
/// - 200/403 = 存在（通过）
/// - 404 = 不存在（过滤）
/// - 超时 = 不可达（过滤）
///
/// 返回通过校验的站点列表（含官方），供 Phase1 使用。
pub async fn phase0_check_project_exists(
    mirrors: &[MirrorEntry],
    owner: &str,
    repo: &str,
    progress_tx: &mpsc::Sender<ProgressEvent>,
) -> Vec<MirrorEntry> {
    const TIMEOUT_SECS: u64 = 10;
    const MAX_CONCURRENT: usize = 5;

    // 构建候选列表：GitHub Official + [github] 镜像站
    let mut all_candidates: Vec<MirrorEntry> = Vec::new();
    all_candidates.push(MirrorEntry::new(
        "GitHub Official",
        "https://github.com/",
    ));
    all_candidates.extend(mirrors.iter().cloned());

    send_log(
        progress_tx,
        format!("[SITE-TEST] Phase0: 项目存在性预校验 ({}/{})...", owner, repo),
    )
    .await;

    let sem = Arc::new(Semaphore::new(MAX_CONCURRENT));
    let tx = progress_tx.clone();
    let mut handles = Vec::new();

    for entry in &all_candidates {
        let sem = sem.clone();
        let entry_clone = entry.clone();
        let tx = tx.clone();
        let owner = owner.to_string();
        let repo = repo.to_string();

        let handle = tokio::spawn(async move {
            let _permit = sem.acquire().await.expect("semaphore closed");
            check_project_on_mirror(&entry_clone, &owner, &repo, TIMEOUT_SECS, &tx).await
        });
        handles.push(handle);
    }

    let mut results: Vec<ProjectExistsResult> = Vec::new();
    for handle in handles {
        match handle.await {
            Ok(r) => results.push(r),
            Err(e) => {
                send_log(&tx, format!("[WARN] Phase0 测试任务异常: {}", e)).await;
            }
        }
    }

    // 输出结果
    let pass_count = results.iter().filter(|r| r.exists).count();
    send_log(
        progress_tx,
        format!(
            "[SITE-TEST] Phase0 完成: {}/{} 个站点支持该项目",
            pass_count,
            results.len()
        ),
    )
    .await;

    for r in &results {
        let status = if r.exists { "[OK]" } else { "[FAIL]" };
        send_log(
            progress_tx,
            format!(
                "[SITE-TEST]   {} {} -> HTTP {} ({:.1}s)",
                status, r.entry.name, r.http_code, r.elapsed_secs
            ),
        )
        .await;
    }

    // 返回通过校验的站点（含官方）
    results
        .into_iter()
        .filter(|r| r.exists)
        .map(|r| r.entry)
        .collect()
}

async fn check_project_on_mirror(
    entry: &MirrorEntry,
    owner: &str,
    repo: &str,
    timeout_secs: u64,
    progress_tx: &mpsc::Sender<ProgressEvent>,
) -> ProjectExistsResult {
    let start = std::time::Instant::now();
    let url = apply_mirror_to_url(
        &format!("https://github.com/{}/{}", owner, repo),
        &entry.url,
    );

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        check_url_exists(&url),
    )
    .await;

    let elapsed = start.elapsed().as_secs_f64();

    match result {
        Ok(Ok((http_code, exists))) => ProjectExistsResult {
            entry: entry.clone(),
            exists,
            http_code,
            elapsed_secs: elapsed,
        },
        Ok(Err(_)) => ProjectExistsResult {
            entry: entry.clone(),
            exists: false,
            http_code: 0,
            elapsed_secs: elapsed,
        },
        Err(_) => ProjectExistsResult {
            entry: entry.clone(),
            exists: false,
            http_code: 0,
            elapsed_secs: elapsed,
        },
    }
}

/// 检查 URL 是否存在（只读 HTTP 状态码，不下载 body）
/// 返回 (http_code, exists)
async fn check_url_exists(url: &str) -> Result<(u16, bool)> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("vcp-installer/1.0")
        .build()?;

    let resp = client.head(url).send().await?;
    let code = resp.status().as_u16();

    // 200/403 = 项目存在；404 = 不存在；其他视为不存在
    let exists = code == 200 || code == 403;
    Ok((code, exists))
}

/// Phase 1 快速测试结果（用于排序筛选）
#[derive(Debug, Clone)]
pub struct QuickTestResult {
    pub entry: MirrorEntry,
    pub reachable: bool,
    pub elapsed_secs: f64,
    pub downloaded_bytes: u64,
}

/// 单个站点完整测试结果（Phase 2）
#[derive(Debug, Clone)]
pub struct SiteTestResult {
    pub entry: MirrorEntry,
    pub success: bool,
    pub elapsed_secs: f64,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    /// 测试文件临时存放路径（成功时保留，失败时已清理）
    pub temp_file: Option<PathBuf>,
}

/// 分阶段站点测试：
/// - Phase 1: 快速连通测试（全部候选，10 秒超时，初步筛选）
/// - Phase 2: 完整下载测试（前 6 个，完整验证）
///
/// - mirrors: 候选站点列表（来自 Phase0 结果，含官方 + 镜像）
/// - cache_dir: DL_runtimes 目录（最终缓存位置）
/// - max_concurrent: Phase 2 最大并发数（默认 3）
/// - full_timeout_secs: Phase 2 单站点完整超时时间（默认 300 秒）
/// - progress_tx: TUI 进度通道，日志通过此通道发送（避免刷屏）
///
/// 返回：(可用的站点列表, 缓存文件路径)
pub async fn test_sites_by_download(
    mirrors: &[MirrorEntry],
    cache_dir: &Path,
    max_concurrent: usize,
    full_timeout_secs: u64,
    progress_tx: mpsc::Sender<ProgressEvent>,
) -> Result<(Vec<SiteTestResult>, Option<PathBuf>)> {
    // 使用 VCPToolBox main 分支源码 tar.gz 作为测试文件
    // 缓存文件名与 archive_ops.rs 一致，测试完成后可直接复用
    const TEST_URL: &str = "https://github.com/lioensky/VCPToolBox/archive/refs/heads/main.tar.gz";
    let test_url = TEST_URL;
    let file_name = "VCPToolBox.tar.gz";

    send_log(
        &progress_tx,
        "[SITE-TEST] 使用测试文件: VCPToolBox 源码 tar.gz (~175MB)",
    )
    .await;

    // mirrors 来自 Phase0 结果（已含 GitHub Official），直接使用
    let all_candidates = mirrors.to_vec();

    send_log(
        &progress_tx,
        format!(
            "[SITE-TEST] 共 {} 个候选（Phase0 通过）",
            all_candidates.len()
        ),
    )
    .await;

    // ====== Phase 1: 快速连通测试（全部候选）======
    send_log(
        &progress_tx,
        format!(
            "[SITE-TEST] Phase 1: 快速连通测试（全部 {} 个站点）...",
            all_candidates.len()
        ),
    )
    .await;

    let quick_results = quick_test_all(&all_candidates, &test_url, &progress_tx).await;

    // 按速度排序（downloaded_bytes / elapsed_secs），不可达排后面
    let mut sortable: Vec<_> = quick_results.into_iter().collect();
    sortable.sort_by(|a, b| {
        match (a.reachable, b.reachable) {
            (true, true) => {
                // 按下载速度排序（bytes per second）
                let speed_a = a.downloaded_bytes as f64 / a.elapsed_secs.max(0.001);
                let speed_b = b.downloaded_bytes as f64 / b.elapsed_secs.max(0.001);
                speed_b.partial_cmp(&speed_a).unwrap_or(std::cmp::Ordering::Equal)
            }
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            (false, false) => std::cmp::Ordering::Equal,
        }
    });

    // 统计 Phase 1 结果
    let reachable_count = sortable.iter().filter(|r| r.reachable).count();
    send_log(
        &progress_tx,
        format!(
            "[SITE-TEST] Phase 1 完成: {}/{} 可达",
            reachable_count,
            sortable.len()
        ),
    )
    .await;

    if reachable_count == 0 {
        send_log(&progress_tx, "[SITE-TEST] 所有站点均不可达，测试终止").await;
        return Ok((Vec::new(), None));
    }

    // 打印 Phase 1 Top 结果
    for (i, r) in sortable.iter().take(5).enumerate() {
        let speed = if r.elapsed_secs > 0.001 {
            r.downloaded_bytes as f64 / r.elapsed_secs / 1_048_576.0
        } else {
            0.0
        };
        send_log(
            &progress_tx,
            format!("[SITE-TEST]   {}. {} - {:.1}MB/s", i + 1, r.entry.name, speed),
        )
        .await;
    }

    // ====== Phase 2: 完整下载测试（前 6 个候选）======
    let phase2_count = reachable_count.min(6);
    send_log(
        &progress_tx,
        format!(
            "[SITE-TEST] Phase 2: 完整下载测试（前 {} 个候选）...",
            phase2_count
        ),
    )
    .await;

    let phase2_candidates: Vec<_> = sortable
        .into_iter()
        .filter(|r| r.reachable)
        .take(phase2_count)
        .map(|r| r.entry)
        .collect();

    let (full_results, cached_file) = full_test_candidates(
        &phase2_candidates,
        &test_url,
        cache_dir,
        &file_name,
        max_concurrent,
        full_timeout_secs,
        &progress_tx,
    )
    .await;

    // 最终按成功率 + 速度排序
    let mut final_results: Vec<SiteTestResult> = full_results;
    final_results.sort_by(|a, b| {
        match (a.success, b.success) {
            (true, true) => a
                .elapsed_secs
                .partial_cmp(&b.elapsed_secs)
                .unwrap_or(std::cmp::Ordering::Equal),
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            (false, false) => std::cmp::Ordering::Equal,
        }
    });

    Ok((final_results, cached_file))
}

// ====== Phase 1: 快速连通测试 ======

async fn quick_test_all(
    entries: &[MirrorEntry],
    base_url: &str,
    progress_tx: &mpsc::Sender<ProgressEvent>,
) -> Vec<QuickTestResult> {
    // Phase 1: 短超时 + 高并发，快速判断连通性
    const TIMEOUT_SECS: u64 = 10;
    const MAX_CONCURRENT: usize = 5;
    const MAX_BYTES: u64 = 10_485_760; // 10MB

    let sem = Arc::new(Semaphore::new(MAX_CONCURRENT));
    let tx = progress_tx.clone();
    let mut handles = Vec::new();

    for entry in entries {
        let sem = sem.clone();
        let url = apply_mirror_to_url(base_url, &entry.url);
        let entry_clone = entry.clone();
        let tx = tx.clone();

        let handle = tokio::spawn(async move {
            let _permit = sem.acquire().await.expect("semaphore closed");
            quick_download_test(&entry_clone, &url, TIMEOUT_SECS, MAX_BYTES, &tx).await
        });
        handles.push(handle);
    }

    let mut results = Vec::new();
    for handle in handles {
        match handle.await {
            Ok(r) => results.push(r),
            Err(e) => {
                send_log(&tx, format!("[WARN] Phase 1 测试任务异常: {}", e)).await;
            }
        }
    }
    results
}

async fn quick_download_test(
    entry: &MirrorEntry,
    url: &str,
    timeout_secs: u64,
    max_bytes: u64,
    progress_tx: &mpsc::Sender<ProgressEvent>,
) -> QuickTestResult {
    let start = std::time::Instant::now();

    send_log(
        progress_tx,
        format!(
            "[SITE-TEST] Phase 1 测试: {} ({})",
            entry.name,
            url.chars().take(60).collect::<String>()
        ),
    )
    .await;

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        quick_download(url, max_bytes),
    )
    .await;

    let elapsed = start.elapsed().as_secs_f64();

    match result {
        Ok(Ok(bytes)) => {
            let reachable = bytes > 100_000; // 至少 100KB 才算可达
            if reachable {
                send_log(
                    progress_tx,
                    format!(
                        "[SITE-TEST] [OK] {} 可达（{}s, {}MB）",
                        entry.name, elapsed as i64, bytes / 1_048_576
                    ),
                )
                .await;
            } else {
                send_log(
                    progress_tx,
                    format!(
                        "[SITE-TEST] [FAIL] {} 响应异常（{}s, {}KB）",
                        entry.name, elapsed as i64, bytes / 1_024
                    ),
                )
                .await;
            }
            QuickTestResult {
                entry: entry.clone(),
                reachable,
                elapsed_secs: elapsed,
                downloaded_bytes: bytes,
            }
        }
        Ok(Err(e)) => {
            send_log(
                progress_tx,
                format!(
                    "[SITE-TEST] [FAIL] {} 请求失败（{}s）: {}",
                    entry.name, elapsed as i64, e
                ),
            )
            .await;
            QuickTestResult {
                entry: entry.clone(),
                reachable: false,
                elapsed_secs: elapsed,
                downloaded_bytes: 0,
            }
        }
        Err(_) => {
            send_log(
                progress_tx,
                format!(
                    "[SITE-TEST] [FAIL] {} 超时（{}s）",
                    entry.name, elapsed as i64
                ),
            )
            .await;
            QuickTestResult {
                entry: entry.clone(),
                reachable: false,
                elapsed_secs: elapsed,
                downloaded_bytes: 0,
            }
        }
    }
}

async fn quick_download(url: &str, max_bytes: u64) -> Result<u64> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("vcp-installer/1.0")
        .build()?;

    let resp = client.get(url).send().await?;
    if !resp.status().is_success() && !resp.status().is_redirection() {
        anyhow::bail!("HTTP {} for {}", resp.status(), url);
    }

    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;

    while let Some(chunk) = stream.try_next().await? {
        downloaded += chunk.len() as u64;
        if downloaded >= max_bytes {
            break;
        }
    }

    Ok(downloaded)
}

// ====== Phase 2: 完整下载测试 ======

async fn full_test_candidates(
    entries: &[MirrorEntry],
    base_url: &str,
    cache_dir: &Path,
    file_name: &str,
    max_concurrent: usize,
    timeout_secs: u64,
    progress_tx: &mpsc::Sender<ProgressEvent>,
) -> (Vec<SiteTestResult>, Option<PathBuf>) {
    let temp_dir = cache_dir.join(".site_test");
    let _ = fs::create_dir_all(&temp_dir).await;

    let tasks: Vec<_> = entries
        .iter()
        .map(|entry| {
            let test_url_for_mirror = apply_mirror_to_url(base_url, &entry.url);
            let temp_path = temp_dir.join(format!("{}.tmp", entry.name));
            (entry.clone(), test_url_for_mirror, temp_path)
        })
        .collect();

    let sem = Arc::new(Semaphore::new(max_concurrent));
    let tx = progress_tx.clone();
    let mut handles = Vec::new();

    for (entry, url, temp_path) in tasks {
        let sem = sem.clone();
        let tx = tx.clone();
        let handle = tokio::spawn(async move {
            let _permit = sem.acquire().await.expect("semaphore closed");
            download_and_test(&entry, &url, &temp_path, timeout_secs, &tx).await
        });
        handles.push(handle);
    }

    let mut results: Vec<SiteTestResult> = Vec::new();
    let mut best_file: Option<PathBuf> = None;

    for handle in handles {
        match handle.await {
            Ok(result) => {
                if result.success {
                    if let Some(ref tf) = result.temp_file {
                        best_file = best_file.or_else(|| Some(tf.clone()));
                    }
                }
                results.push(result);
            }
            Err(e) => {
                send_log(&tx, format!("[WARN] Phase 2 测试任务异常: {}", e)).await;
            }
        }
    }

    // 清理：保留 best_file，删除其他所有临时文件
    if let Some(ref path) = best_file {
        let final_cache = cache_dir.join(file_name);
        if let Err(e) = fs::rename(path, &final_cache).await {
            send_log(
                progress_tx,
                format!("[WARN] 重命名缓存文件失败: {}，尝试拷贝", e),
            )
            .await;
            if let Err(e2) = fs::copy(path, &final_cache).await {
                send_log(
                    progress_tx,
                    format!("[ERROR] 缓存文件拷贝也失败: {}", e2),
                )
                .await;
                cleanup_dir(&temp_dir).await;
                return (results, None);
            }
        }
        send_log(
            progress_tx,
            format!(
                "[SITE-TEST] Phase 2 缓存文件已保存到 DL_runtimes: {} ({}MB)",
                file_name,
                fs::metadata(&final_cache)
                    .await
                    .map(|m| m.len() / 1_048_576)
                    .unwrap_or(0)
            ),
        )
        .await;
    }

    cleanup_dir(&temp_dir).await;
    (results, best_file)
}

async fn download_and_test(
    entry: &MirrorEntry,
    url: &str,
    temp_path: &Path,
    timeout_secs: u64,
    progress_tx: &mpsc::Sender<ProgressEvent>,
) -> SiteTestResult {
    let start = std::time::Instant::now();

    send_log(
        progress_tx,
        format!("[SITE-TEST] 开始测试: {} ({})", entry.name, url),
    )
    .await;

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        download_file(url, temp_path),
    )
    .await;

    let elapsed = start.elapsed().as_secs_f64();
    let downloaded_bytes = fs::metadata(temp_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);

    match result {
        Ok(Ok((total_bytes, true))) => {
            if total_bytes > 0 {
                send_log(
                    progress_tx,
                    format!(
                        "[SITE-TEST] [OK] {} 成功（{}s, {}MB）",
                        entry.name, elapsed as i64, downloaded_bytes / 1_048_576
                    ),
                )
                .await;
                SiteTestResult {
                    entry: entry.clone(),
                    success: true,
                    elapsed_secs: elapsed,
                    downloaded_bytes: total_bytes,
                    total_bytes,
                    temp_file: Some(temp_path.to_path_buf()),
                }
            } else {
                send_log(
                    progress_tx,
                    format!(
                        "[SITE-TEST] [FAIL] {} 空文件（{}s）",
                        entry.name, elapsed as i64
                    ),
                )
                .await;
                let _ = fs::remove_file(temp_path).await;
                SiteTestResult {
                    entry: entry.clone(),
                    success: false,
                    elapsed_secs: elapsed,
                    downloaded_bytes: 0,
                    total_bytes: 0,
                    temp_file: None,
                }
            }
        }
        Ok(Ok((total_bytes, false))) => {
            // 下载完成但不完整（content_length 不匹配）
            send_log(
                progress_tx,
                format!(
                    "[SITE-TEST] [FAIL] {} 不完整（{}s, {}MB/{}MB）",
                    entry.name,
                    elapsed as i64,
                    downloaded_bytes / 1_048_576,
                    total_bytes / 1_048_576
                ),
            )
            .await;
            let _ = fs::remove_file(temp_path).await;
            SiteTestResult {
                entry: entry.clone(),
                success: false,
                elapsed_secs: elapsed,
                downloaded_bytes,
                total_bytes: 0,
                temp_file: None,
            }
        }
        Ok(Err(e)) => {
            send_log(
                progress_tx,
                format!(
                    "[SITE-TEST] [FAIL] {} 失败（{}s, {}MB）: {}",
                    entry.name,
                    elapsed as i64,
                    downloaded_bytes / 1_048_576,
                    e
                ),
            )
            .await;
            let _ = fs::remove_file(temp_path).await;
            SiteTestResult {
                entry: entry.clone(),
                success: false,
                elapsed_secs: elapsed,
                downloaded_bytes,
                total_bytes: 0,
                temp_file: None,
            }
        }
        Err(_) => {
            send_log(
                progress_tx,
                format!(
                    "[SITE-TEST] [FAIL] {} 超时（{}s, {}MB）",
                    entry.name, elapsed as i64, downloaded_bytes / 1_048_576
                ),
            )
            .await;
            let _ = fs::remove_file(temp_path).await;
            SiteTestResult {
                entry: entry.clone(),
                success: false,
                elapsed_secs: elapsed,
                downloaded_bytes,
                total_bytes: 0,
                temp_file: None,
            }
        }
    }
}

async fn download_file(url: &str, dest: &Path) -> Result<(u64, bool)> {
    // Phase 2: 完整下载 VCPToolBox tar.gz (~175MB)，HTTP 层超时 300 秒
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .user_agent("vcp-installer/1.0")
            .build()?;

    let resp = client.get(url).send().await?;
    if !resp.status().is_success() && !resp.status().is_redirection() {
        anyhow::bail!("HTTP {} for {}", resp.status(), url);
    }

    let content_length = resp.content_length();
    let mut stream = resp.bytes_stream();
    let mut file = File::create(dest).await?;
    let mut downloaded: u64 = 0;

    while let Some(chunk) = stream.try_next().await? {
        file.write_all(&chunk).await?;
        downloaded += chunk.len() as u64;
    }

    // 校验完整性
    let complete = match content_length {
        Some(expected) => downloaded == expected,
        None => true, // 没有 Content-Length，无法校验
    };

    Ok((downloaded, complete))
}

async fn cleanup_dir(dir: &Path) {
    if let Ok(mut entries) = fs::read_dir(dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let _ = fs::remove_file(entry.path()).await;
        }
    }
    let _ = fs::remove_dir(dir).await;
}

fn apply_mirror_to_url(base_url: &str, mirror_url: &str) -> String {
    const GITHUB_PREFIX: &str = "https://github.com/";

    // mirror_url 已经包含了 "https://github.com/"（如 vcp-mirrors.ini 中的配置）
    // 需要去掉 base_url 的 github.com/ 前缀，避免重复拼接
    if mirror_url.contains(GITHUB_PREFIX) && base_url.starts_with(GITHUB_PREFIX) {
        let path = base_url.strip_prefix(GITHUB_PREFIX).unwrap_or(base_url);
        format!("{}{}", mirror_url, path)
    } else if base_url.starts_with(GITHUB_PREFIX) {
        // 备用：mirror_url 不含 github.com/，直接拼接
        let prefix = if mirror_url.ends_with('/') {
            mirror_url.to_string()
        } else {
            format!("{}/", mirror_url)
        };
        format!("{}{}", prefix, base_url)
    } else {
        base_url.to_string()
    }
}

fn extract_filename(url: &str) -> String {
    url.split('/')
        .last()
        .unwrap_or("download")
        .to_string()
}
