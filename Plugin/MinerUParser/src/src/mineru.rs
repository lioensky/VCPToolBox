//! MinerU v4 API 客户端：签名 URL → OSS 直传 → 轮询 → 下载 ZIP 四拍流程。

use crate::error::{classify_code, AppError};
use crate::protocol::{BatchApiResponse, ExtractTaskResponse};
use serde_json::json;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

const BASE_URL: &str = "https://mineru.net";
/// 网络层瞬态错误最多重试 3 次（1s/2s/4s 指数退避）。
const RETRY_DELAYS_SECS: [u64; 3] = [1, 2, 4];

pub struct MineruClient {
    token: String,
    agent: ureq::Agent,
    poll_interval: Duration,
}

pub struct UploadOptions {
    pub file_name: String,
    pub is_ocr: bool,
    pub model_version: String,
    pub language: String,
    pub enable_formula: bool,
    pub enable_table: bool,
}

pub enum PollOutcome {
    /// 解析完成，携带 full_zip_url（临时链接，必须当轮下载）。
    Done(String),
    /// 轮询等待超限，未失败；凭 batch_id 续查。
    Timeout,
    /// 云端解析失败，携带 err_msg。
    Failed(String),
}

impl MineruClient {
    pub fn new(token: String) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(60))
            .build();
        MineruClient {
            token,
            agent,
            poll_interval: Duration::from_secs(3),
        }
    }

    /// 指数退避执行一次请求；仅网络层（连接/超时/TLS）错误重试，
    /// HTTP 状态码与业务 code 错误不在此层重试。
    fn with_retry<F>(&self, mut f: F) -> Result<ureq::Response, AppError>
    where
        F: FnMut() -> Result<ureq::Response, ureq::Error>,
    {
        let mut last: Option<ureq::Error> = None;
        for delay in RETRY_DELAYS_SECS.iter() {
            match f() {
                Ok(resp) => return Ok(resp),
                // HTTP 状态错误不代表瞬态故障，交由调用方按 body/状态码判定
                Err(ureq::Error::Status(_, resp)) => return Ok(resp),
                Err(e) => {
                    last = Some(e);
                    thread::sleep(Duration::from_secs(*delay));
                }
            }
        }
        Err(AppError::retry(format!(
            "网络请求失败（已重试 3 次）: {}",
            last.map(|e| e.to_string()).unwrap_or_default()
        )))
    }

    /// 第一拍：申请签名上传 URL。返回 (batch_id, signed_url)。
    pub fn request_upload(&self, opts: &UploadOptions) -> Result<(String, String), AppError> {
        let body = json!({
            "files": [ { "name": opts.file_name, "is_ocr": opts.is_ocr } ],
            "model_version": opts.model_version,
            "language": opts.language,
            "enable_formula": opts.enable_formula,
            "enable_table": opts.enable_table
        });

        let resp = self.with_retry(|| {
            self.agent
                .post(&format!("{}/api/v4/file-urls/batch", BASE_URL))
                .set("Authorization", &format!("Bearer {}", self.token))
                .send_json(body.clone())
        })?;

        let parsed: BatchApiResponse = serde_json::from_reader(resp.into_reader())
            .map_err(|e| AppError::fix(format!("申请上传 URL 响应解析失败: {}", e)))?;
        check_api_code(&parsed)?;

        let data = parsed
            .data
            .ok_or_else(|| AppError::fix("申请上传 URL 响应缺少 data 字段"))?;
        let batch_id = data
            .batch_id
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::fix("申请上传 URL 响应缺少 batch_id"))?;
        // V1 单文件契约：file_urls 必须恰好 1 个
        if data.file_urls.len() != 1 {
            return Err(AppError::fix(format!(
                "申请上传 URL 响应的 file_urls 数量异常（期望 1，收到 {}）",
                data.file_urls.len()
            )));
        }
        Ok((batch_id, data.file_urls[0].clone()))
    }

    /// 第二拍：二进制直传 OSS。不设置 Content-Type（官方要求，设了破坏签名）。
    pub fn upload_file(&self, file_path: &Path, signed_url: &str) -> Result<(), AppError> {
        let bytes = fs::read(file_path)
            .map_err(|e| AppError::fix(format!("读取 PDF 失败 {}: {}", file_path.display(), e)))?;

        // send_bytes 自带 Content-Length 且不设 Content-Type；
        // 不能用 chunked 流式（OSS 签名 PUT 不支持），也不能用 send_json/send_string
        let resp = self.with_retry(|| {
            self.agent
                .put(signed_url)
                .send_bytes(&bytes)
        })?;

        if !(200..300).contains(&resp.status()) {
            return Err(AppError::fix(format!(
                "OSS 直传失败: HTTP {}",
                resp.status()
            )));
        }
        Ok(())
    }

    /// 第三拍：轮询批次结果。on_state 在每次状态/进度变化时回调（用于落盘 state.json）。
    pub fn poll_batch<F>(
        &self,
        batch_id: &str,
        file_name: &str,
        max_wait: Duration,
        mut on_state: F,
    ) -> Result<PollOutcome, AppError>
    where
        F: FnMut(&str, Option<(u64, u64)>, bool),
    {
        let url = format!(
            "{}/api/v4/extract-results/batch/{}",
            BASE_URL, batch_id
        );
        let deadline = std::time::Instant::now() + max_wait;
        let mut last_state = String::new();
        let mut last_progress: Option<(u64, u64)> = None;

        loop {
            if std::time::Instant::now() >= deadline {
                return Ok(PollOutcome::Timeout);
            }

            let resp = self.with_retry(|| {
                self.agent
                    .get(&url)
                    .set("Authorization", &format!("Bearer {}", self.token))
                    .call()
            })?;

            let parsed: BatchApiResponse = serde_json::from_reader(resp.into_reader())
                .map_err(|e| AppError::fix(format!("轮询响应解析失败: {}", e)))?;
            check_api_code(&parsed)?;

            let items = parsed
                .data
                .map(|d| d.extract_result)
                .unwrap_or_default();
            let item = match_target(&items, file_name);
            let item = match item {
                Some(i) => i,
                None => {
                    // 目标条目尚未出现，视作 waiting-file
                    if last_state != "waiting-file" {
                        on_state("waiting-file", None, true);
                        last_state = "waiting-file".to_string();
                    }
                    thread::sleep(self.poll_interval);
                    continue;
                }
            };

            let state = item.state.clone().unwrap_or_default();
            let progress = item.extract_progress.as_ref().map(|p| {
                (p.extracted_pages.unwrap_or(0), p.total_pages.unwrap_or(0))
            });

            match state.as_str() {
                "done" => {
                    on_state("done", progress, state != last_state);
                    let zip_url = item
                        .full_zip_url
                        .clone()
                        .filter(|s| !s.is_empty())
                        .ok_or_else(|| AppError::fix("done 状态但缺少 full_zip_url"))?;
                    return Ok(PollOutcome::Done(zip_url));
                }
                "failed" => {
                    on_state("failed", progress, true);
                    return Ok(PollOutcome::Failed(
                        item.err_msg
                            .clone()
                            .unwrap_or_else(|| "云端解析失败（未返回 err_msg）".to_string()),
                    ));
                }
                _ => {
                    let changed = state != last_state || progress != last_progress;
                    on_state(&state, progress, changed);
                    last_state = state;
                    last_progress = progress;
                }
            }

            if std::time::Instant::now() >= deadline {
                return Ok(PollOutcome::Timeout);
            }
            thread::sleep(self.poll_interval);
        }
    }

    /// URL 提交（POST /api/v4/extract/task）。返回 task_id。
    pub fn request_extract_task(&self, url: &str, opts: &UploadOptions) -> Result<String, AppError> {
        let body = json!({
            "url": url,
            "is_ocr": opts.is_ocr,
            "model_version": opts.model_version,
            "language": opts.language,
            "enable_formula": opts.enable_formula,
            "enable_table": opts.enable_table
        });
        let resp = self.with_retry(|| {
            self.agent
                .post(&format!("{}/api/v4/extract/task", BASE_URL))
                .set("Authorization", &format!("Bearer {}", self.token))
                .send_json(body.clone())
        })?;
        let parsed: ExtractTaskResponse = serde_json::from_reader(resp.into_reader())
            .map_err(|e| AppError::fix(format!("URL 任务响应解析失败: {}", e)))?;
        check_task_code(&parsed)?;
        parsed
            .data
            .and_then(|d| d.task_id)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::fix("URL 任务响应缺少 task_id"))
    }

    /// URL 任务轮询（端点与 batch 不同：GET /api/v4/extract/task/{task_id}，data 为单对象）。
    pub fn poll_task<F>(
        &self,
        task_id: &str,
        max_wait: Duration,
        mut on_state: F,
    ) -> Result<PollOutcome, AppError>
    where
        F: FnMut(&str, Option<(u64, u64)>, bool),
    {
        let url = format!("{}/api/v4/extract/task/{}", BASE_URL, task_id);
        let deadline = std::time::Instant::now() + max_wait;
        let mut last_state = String::new();
        let mut last_progress: Option<(u64, u64)> = None;

        loop {
            if std::time::Instant::now() >= deadline {
                return Ok(PollOutcome::Timeout);
            }
            let resp = self.with_retry(|| {
                self.agent
                    .get(&url)
                    .set("Authorization", &format!("Bearer {}", self.token))
                    .call()
            })?;
            let parsed: ExtractTaskResponse = serde_json::from_reader(resp.into_reader())
                .map_err(|e| AppError::fix(format!("URL 任务轮询响应解析失败: {}", e)))?;
            check_task_code(&parsed)?;

            let data = match parsed.data {
                Some(d) => d,
                None => {
                    if last_state != "waiting" {
                        on_state("waiting", None, true);
                        last_state = "waiting".to_string();
                    }
                    thread::sleep(self.poll_interval);
                    continue;
                }
            };
            let state = data.state.clone().unwrap_or_default();
            let progress = data
                .extract_progress
                .as_ref()
                .map(|p| (p.extracted_pages.unwrap_or(0), p.total_pages.unwrap_or(0)));

            match state.as_str() {
                "done" => {
                    on_state("done", progress, true);
                    let zip_url = data
                        .full_zip_url
                        .clone()
                        .filter(|s| !s.is_empty())
                        .ok_or_else(|| AppError::fix("done 状态但缺少 full_zip_url"))?;
                    return Ok(PollOutcome::Done(zip_url));
                }
                "failed" => {
                    on_state("failed", progress, true);
                    return Ok(PollOutcome::Failed(
                        data.err_msg
                            .clone()
                            .unwrap_or_else(|| "云端解析失败（未返回 err_msg）".to_string()),
                    ));
                }
                other => {
                    let changed = other != last_state || progress != last_progress;
                    on_state(other, progress, changed);
                    last_state = other.to_string();
                    last_progress = progress;
                }
            }

            if std::time::Instant::now() >= deadline {
                return Ok(PollOutcome::Timeout);
            }
            thread::sleep(self.poll_interval);
        }
    }

    /// 第四拍：流式下载产物 ZIP 到 dest.downloading 临时文件，完成后原子 rename。
    /// 整个操作（连接 + 读取 + 落盘）级重试：中途断流也从头再来，不残留半成品。
    pub fn download_zip(&self, zip_url: &str, dest: &Path) -> Result<(), AppError> {
        let tmp: PathBuf = dest.with_extension("zip.downloading");
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| AppError::fix(format!("创建下载目录失败: {}", e)))?;
        }

        let mut last_err: Option<String> = None;
        for delay in RETRY_DELAYS_SECS.iter() {
            match self.download_zip_once(zip_url, &tmp) {
                Ok(()) => {
                    fs::rename(&tmp, dest)
                        .map_err(|e| AppError::fix(format!("下载文件落盘失败: {}", e)))?;
                    return Ok(());
                }
                Err(e) => {
                    let _ = fs::remove_file(&tmp);
                    last_err = Some(e.message().to_string());
                    thread::sleep(Duration::from_secs(*delay));
                }
            }
        }
        Err(AppError::retry(format!(
            "下载产物失败（已重试 3 次）: {}",
            last_err.unwrap_or_default()
        )))
    }

    fn download_zip_once(&self, zip_url: &str, tmp: &Path) -> Result<(), AppError> {
        let resp = self.with_retry(|| self.agent.get(zip_url).call())?;
        if !(200..300).contains(&resp.status()) {
            return Err(AppError::retry(format!(
                "下载产物失败: HTTP {}",
                resp.status()
            )));
        }

        let mut reader = resp.into_reader();
        let mut file = File::create(tmp)
            .map_err(|e| AppError::fix(format!("创建临时下载文件失败: {}", e)))?;
        let mut buffer = vec![0u8; 1024 * 1024];
        loop {
            let n = reader
                .read(&mut buffer)
                .map_err(|e| AppError::retry(format!("下载流读取失败: {}", e)))?;
            if n == 0 {
                break;
            }
            file.write_all(&buffer[..n])
                .map_err(|e| AppError::fix(format!("写入下载文件失败: {}", e)))?;
        }
        Ok(())
    }
}

/// 单文件批次内匹配目标条目：唯一条目直接采用；多条时按 file_name 匹配。
fn match_target<'a>(
    items: &'a [crate::protocol::ExtractItem],
    file_name: &str,
) -> Option<&'a crate::protocol::ExtractItem> {
    if items.len() == 1 {
        return items.first();
    }
    items
        .iter()
        .find(|i| i.file_name.as_deref() == Some(file_name))
}

/// 业务 code != 0：按错误码策略表构造 AppError，附带 trace_id 便于追溯。
fn check_api_code(parsed: &BatchApiResponse) -> Result<(), AppError> {
    if parsed.is_ok() {
        return Ok(());
    }
    let code = parsed.code_string();
    let info = classify_code(&code);
    let mut msg = format!(
        "MinerU API 错误 {}: {}",
        code,
        parsed.msg.clone().unwrap_or_default()
    );
    // 已知错误码附加处置建议；未知码也提示默认策略
    msg.push_str(&format!("（{}）", info.description));
    if let Some(trace) = parsed.trace() {
        msg.push_str(&format!("（trace_id: {}）", trace));
    }
    match info.policy {
        crate::error::ErrorPolicy::Fix => Err(AppError::fix(msg)),
        crate::error::ErrorPolicy::Retry => Err(AppError::retry(msg)),
        crate::error::ErrorPolicy::Fatal => Err(AppError::fatal(msg)),
    }
}

/// URL 任务信封的同一套错误码映射。
fn check_task_code(parsed: &ExtractTaskResponse) -> Result<(), AppError> {
    if parsed.is_ok() {
        return Ok(());
    }
    let code = parsed.code_string();
    let info = classify_code(&code);
    let mut msg = format!(
        "MinerU API 错误 {}: {}",
        code,
        parsed.msg.clone().unwrap_or_default()
    );
    msg.push_str(&format!("（{}）", info.description));
    if let Some(trace) = parsed.trace() {
        msg.push_str(&format!("（trace_id: {}）", trace));
    }
    match info.policy {
        crate::error::ErrorPolicy::Fix => Err(AppError::fix(msg)),
        crate::error::ErrorPolicy::Retry => Err(AppError::retry(msg)),
        crate::error::ErrorPolicy::Fatal => Err(AppError::fatal(msg)),
    }
}
