use std::{
    io::ErrorKind,
    path::PathBuf,
    time::Duration,
};

use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use reqwest::{
    header::{ACCEPT, CONTENT_RANGE, RANGE, USER_AGENT},
    Client, StatusCode,
};
use serde::{de::DeserializeOwned, Deserialize};
use tokio::{
    fs,
    io::AsyncWriteExt,
    sync::mpsc,
    time::sleep,
};

use crate::app::ProgressEvent;

const USER_AGENT_VALUE: &str = "vcp-installer/1.0";
const DEFAULT_DOWNLOAD_RETRIES: usize = 3;
const METADATA_RETRIES: usize = 3;
const PROGRESS_REPORT_CHUNK_BYTES: u64 = 64 * 1024;
const HTTP_TIMEOUT_SECS: u64 = 300;
const CONNECT_TIMEOUT_SECS: u64 = 30;

/// 下载配置
#[derive(Debug, Clone)]
pub struct DownloadConfig {
    /// 下载URL
    pub url: String,
    /// 保存到的本地路径
    pub dest: PathBuf,
    /// 对应的安装步骤索引（用于进度回报）
    pub step_index: usize,
    /// 是否尝试断点续传
    pub resume: bool,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Deserialize)]
struct NodeVersion {
    version: String,
    lts: serde_json::Value,
}

/// 下载单个文件：默认最多重试3次
pub async fn download_file(
    config: DownloadConfig,
    progress_tx: mpsc::Sender<ProgressEvent>,
) -> Result<PathBuf> {
    download_with_retry(config, progress_tx, DEFAULT_DOWNLOAD_RETRIES).await
}

/// 带重试的下载
pub async fn download_with_retry(
    config: DownloadConfig,
    progress_tx: mpsc::Sender<ProgressEvent>,
    max_retries: usize,
) -> Result<PathBuf> {
    let client = build_http_client()?;

    let _ = progress_tx
        .send(ProgressEvent::Log(format!("开始下载: {}", config.url)))
        .await;

    let mut last_error: Option<anyhow::Error> = None;

    for attempt in 0..=max_retries {
        if attempt > 0 {
            let _ = progress_tx
                .send(ProgressEvent::Log(format!(
                    "下载重试 ({}/{}): {}",
                    attempt, max_retries, config.url
                )))
                .await;

            sleep(Duration::from_secs(retry_delay_secs(attempt))).await;
        }

        let attempt_config = DownloadConfig {
            url: config.url.clone(),
            dest: config.dest.clone(),
            step_index: config.step_index,
            resume: config.resume || attempt > 0,
        };

        match download_once(&client, &attempt_config, &progress_tx).await {
            Ok(path) => return Ok(path),
            Err(err) => last_error = Some(err),
        }
    }

    let final_error = last_error.unwrap_or_else(|| anyhow!("下载失败，已用尽重试次数"));

    let _ = progress_tx
        .send(ProgressEvent::StepFailed {
            step_index: config.step_index,
            error: final_error.to_string(),
        })
        .await;

    Err(final_error)
}

/// 从 GitHub API 获取 latest release 中匹配的 asset 下载地址
pub async fn get_github_release_url(
    repo: &str,
    asset_pattern: &str,
) -> Result<(String, String)> {
    let url = format!("https://api.github.com/repos/{repo}/releases/latest");
    let response: GithubRelease = request_json_with_retry(&url, true).await?;

    for asset in &response.assets {
        if asset_matches(&asset.name, asset_pattern) {
            return Ok((
                asset.browser_download_url.clone(),
                response.tag_name.clone(),
            ));
        }
    }

    bail!(
        "在 {} 的最新 release 中未找到匹配 '{}' 的文件",
        repo,
        asset_pattern
    )
}

/// 获取 Node.js 最新 LTS 版本号
pub async fn get_nodejs_lts_version() -> Result<String> {
    let versions: Vec<NodeVersion> =
        request_json_with_retry("https://nodejs.org/dist/index.json", false).await?;

    for version in versions {
        if version.lts.is_string() {
            return Ok(version.version);
        }
    }

    bail!("无法获取 Node.js LTS 版本")
}

/// 将 GitHub URL 替换为镜像 URL
pub fn apply_mirror(url: &str, mirror_prefix: &str) -> String {
    const GITHUB_PREFIX: &str = "https://github.com/";

    let mirror_prefix = mirror_prefix.trim();
    if mirror_prefix.is_empty() || mirror_prefix == GITHUB_PREFIX {
        return url.to_string();
    }

    if let Some(rest) = url.strip_prefix(GITHUB_PREFIX) {
        let mut prefix = mirror_prefix.to_string();
        if !prefix.ends_with('/') {
            prefix.push('/');
        }
        format!("{prefix}{rest}")
    } else {
        url.to_string()
    }
}

fn build_http_client() -> Result<Client> {
    Ok(Client::builder()
        .user_agent(USER_AGENT_VALUE)
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .build()?)
}

async fn download_once(
    client: &Client,
    config: &DownloadConfig,
    progress_tx: &mpsc::Sender<ProgressEvent>,
) -> Result<PathBuf> {
    if let Some(parent) = config.dest.parent() {
        fs::create_dir_all(parent)
            .await
            .with_context(|| format!("创建下载目录失败: {}", parent.display()))?;
    }

    let existing_size = if config.resume {
        match fs::metadata(&config.dest).await {
            Ok(metadata) => metadata.len(),
            Err(err) if err.kind() == ErrorKind::NotFound => 0,
            Err(err) => return Err(err).with_context(|| format!("读取文件元数据失败: {}", config.dest.display())),
        }
    } else {
        0
    };

    let mut request = client.get(&config.url);
    if existing_size > 0 {
        request = request.header(RANGE, format!("bytes={existing_size}-"));
    }

    let response = request
        .send()
        .await
        .with_context(|| format!("发送下载请求失败: {}", config.url))?;

    let status = response.status();

    if status == StatusCode::RANGE_NOT_SATISFIABLE && existing_size > 0 {
        let _ = progress_tx
            .send(ProgressEvent::Log(format!(
                "检测到本地文件可能已完整下载，跳过续传: {}",
                config.dest.display()
            )))
            .await;

        let _ = progress_tx
            .send(ProgressEvent::DownloadProgress {
                step_index: config.step_index,
                downloaded: existing_size,
                total: existing_size,
            })
            .await;

        return Ok(config.dest.clone());
    }

    if !status.is_success() && status != StatusCode::PARTIAL_CONTENT {
        bail!("下载失败: HTTP {}", status);
    }

    let headers = response.headers().clone();
    let content_length = response.content_length();

    let append_mode = existing_size > 0 && status == StatusCode::PARTIAL_CONTENT;
    if existing_size > 0 && !append_mode {
        let _ = progress_tx
            .send(ProgressEvent::Log(
                "服务器不支持断点续传，已从头重新下载".to_string(),
            ))
            .await;
    }

    let mut file = if append_mode {
        fs::OpenOptions::new()
            .append(true)
            .open(&config.dest)
            .await
            .with_context(|| format!("打开续传文件失败: {}", config.dest.display()))?
    } else {
        fs::File::create(&config.dest)
            .await
            .with_context(|| format!("创建下载文件失败: {}", config.dest.display()))?
    };

    let mut downloaded = if append_mode { existing_size } else { 0 };

    let total_size = if append_mode {
        parse_total_size_from_content_range(&headers)
            .unwrap_or(existing_size + content_length.unwrap_or(0))
    } else {
        content_length.unwrap_or(0)
    };

    let mut stream = response.bytes_stream();
    let mut next_report_at = if downloaded == 0 {
        PROGRESS_REPORT_CHUNK_BYTES
    } else {
        ((downloaded / PROGRESS_REPORT_CHUNK_BYTES) + 1) * PROGRESS_REPORT_CHUNK_BYTES
    };

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.with_context(|| format!("读取下载流失败: {}", config.url))?;

        file.write_all(&chunk)
            .await
            .with_context(|| format!("写入下载文件失败: {}", config.dest.display()))?;

        downloaded += chunk.len() as u64;

        if downloaded >= next_report_at {
            let _ = progress_tx
                .send(ProgressEvent::DownloadProgress {
                    step_index: config.step_index,
                    downloaded,
                    total: total_size,
                })
                .await;

            while downloaded >= next_report_at {
                next_report_at += PROGRESS_REPORT_CHUNK_BYTES;
            }
        }
    }

    file.flush()
        .await
        .with_context(|| format!("刷新下载文件失败: {}", config.dest.display()))?;

    let final_total = if total_size == 0 { downloaded } else { total_size };

    let _ = progress_tx
        .send(ProgressEvent::DownloadProgress {
            step_index: config.step_index,
            downloaded,
            total: final_total,
        })
        .await;

    Ok(config.dest.clone())
}

async fn request_json_with_retry<T>(url: &str, github_api: bool) -> Result<T>
where
    T: DeserializeOwned,
{
    let client = build_http_client()?;
    let mut last_error: Option<anyhow::Error> = None;

    for attempt in 0..=METADATA_RETRIES {
        if attempt > 0 {
            sleep(Duration::from_secs(retry_delay_secs(attempt))).await;
        }

        let mut request = client.get(url).header(USER_AGENT, USER_AGENT_VALUE);
        if github_api {
            request = request.header(ACCEPT, "application/vnd.github+json");
        }

        match request.send().await {
            Ok(response) => match response.error_for_status() {
                Ok(ok_response) => match ok_response.json::<T>().await {
                    Ok(json) => return Ok(json),
                    Err(err) => last_error = Some(err.into()),
                },
                Err(err) => last_error = Some(err.into()),
            },
            Err(err) => last_error = Some(err.into()),
        }
    }

    let err = last_error.unwrap_or_else(|| anyhow!("请求失败: {url}"));
    Err(err).with_context(|| format!("请求 JSON 失败: {url}"))
}

fn parse_total_size_from_content_range(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get(CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.rsplit('/').next())
        .and_then(|value| value.parse::<u64>().ok())
}

fn asset_matches(name: &str, pattern: &str) -> bool {
    let name = name.to_ascii_lowercase();
    let parts: Vec<String> = pattern
        .split_whitespace()
        .map(|s| s.to_ascii_lowercase())
        .collect();

    if parts.is_empty() {
        return true;
    }

    parts.iter().all(|part| name.contains(part))
}

fn retry_delay_secs(attempt: usize) -> u64 {
    2 * attempt as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_path(name: &str) -> PathBuf {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();

        std::env::temp_dir().join(format!("vcp-installer-{name}-{ts}"))
    }

    #[test]
    fn test_apply_mirror() {
        let url = "https://github.com/lioensky/VCPToolBox/archive/refs/heads/main.zip";
        let mirrored = apply_mirror(url, "https://ghfast.top/https://github.com/");
        assert_eq!(
            mirrored,
            "https://ghfast.top/https://github.com/lioensky/VCPToolBox/archive/refs/heads/main.zip"
        );
    }

    #[test]
    fn test_asset_matches() {
        assert!(super::asset_matches(
            "PortableGit-2.51.0-64-bit.7z.exe",
            "PortableGit"
        ));
        assert!(super::asset_matches(
            "PortableGit-2.51.0-64-bit.7z.exe",
            "PortableGit 64-bit.7z.exe"
        ));
        assert!(!super::asset_matches(
            "node-v20.11.0-win-x64.zip",
            "PortableGit"
        ));
    }

    #[tokio::test]
    #[ignore = "需要外网"]
    async fn test_download_small_file() {
        let (tx, _rx) = tokio::sync::mpsc::channel(32);
        let dest = unique_temp_path("download-test.txt");

        let config = DownloadConfig {
            url: "https://raw.githubusercontent.com/lioensky/VCPToolBox/main/README.md"
                .to_string(),
            dest: dest.clone(),
            step_index: 0,
            resume: false,
        };

        let result = download_file(config, tx).await;
        assert!(result.is_ok());
        assert!(dest.exists());

        let metadata = tokio::fs::metadata(&dest).await.unwrap();
        assert!(metadata.len() > 0);

        let _ = tokio::fs::remove_file(&dest).await;
    }

    #[tokio::test]
    #[ignore = "需要外网"]
    async fn test_get_nodejs_lts_version() {
        let version = get_nodejs_lts_version().await.unwrap();
        assert!(version.starts_with('v'));
    }
}