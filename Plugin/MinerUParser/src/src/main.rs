//! MinerUParser 入口：stdin 解析 → 命令路由 → stdout 单次 JSON 输出。

mod assets;
mod dedupe;
mod error;
mod library;
mod locate;
mod mineru;
mod outline;
mod pdfops;
mod protocol;
mod quality;
mod read;
mod state;
mod zip_safe;

use assets::{file_url_of, ChunkInput, UrlContext};
use error::AppError;
use mineru::{MineruClient, PollOutcome, UploadOptions};
use protocol::Request;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use state::{ChunkState, IndexDoc, PersistentState};
use std::env;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 单文件上限（与 MinerU 云端一致）。
const MAX_FILE_SIZE: u64 = 200 * 1024 * 1024;
/// 单命令轮询上限（秒）；manifest 总超时 30 分钟，留 5 分钟供下载与分片收尾。
/// 大书（如 1000+ 页）仍可能需要多次 query 续查，状态机支持。
const MAX_POLL_SECS: u64 = 1500;
/// 卡片图片清单最多展示的条数，避免大书卡片本身撑爆上下文。
const CARD_IMAGE_PREVIEW_LIMIT: usize = 40;

enum CommandOutput {
    /// 仅文本卡片。
    Card(String),
    /// 多模态 content parts（文本 + base64 图片）。
    Parts {
        parts: Vec<protocol::ContentPart>,
        data: Option<Value>,
    },
    /// 超时续查卡片：文本 + 结构化 data（paper_id/batch_id）。
    Timeout { text: String, data: Value },
    /// 库查询卡片：文本 + 结构化论文记录（供 Agent / 前端二次消费）。
    CardData { text: String, data: Value },
}

/// parse/batch 共用的解析结果。
enum ParseResult {
    Done { index: IndexDoc, cached: bool },
    Timeout { paper_id: String, batch_id: String, chunk_desc: String },
}

fn main() {
    let mut buffer = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut buffer) {
        protocol::print_error(format!("读取 stdin 失败: {}", e));
        return;
    }

    let request: Request = match serde_json::from_str(&buffer) {
        Ok(r) => r,
        Err(e) => {
            protocol::print_error(format!("参数解析失败: {}", e));
            return;
        }
    };

    let result = match dispatch(&request) {
        Ok(out) => match out {
            CommandOutput::Card(text) => Ok(protocol::SuccessPayload {
                parts: vec![protocol::ContentPart::text(text)],
                data: None,
            }),
            CommandOutput::Parts { parts, data } => {
                Ok(protocol::SuccessPayload { parts, data })
            }
            CommandOutput::Timeout { text, data } => Ok(protocol::SuccessPayload {
                parts: vec![protocol::ContentPart::text(text)],
                data: Some(data),
            }),
            CommandOutput::CardData { text, data } => Ok(protocol::SuccessPayload {
                parts: vec![protocol::ContentPart::text(text)],
                data: Some(data),
            }),
        },
        Err(err) => Err(err),
    };

    match result {
        Ok(payload) => protocol::print_payload(payload),
        Err(err) => {
            let token = env::var("MINERU_TOKEN").unwrap_or_default();
            protocol::print_error(error::sanitize_message(err.message(), &token));
        }
    }
}

fn dispatch(request: &Request) -> Result<CommandOutput, AppError> {
    match request.command.as_str() {
        "parse" => cmd_parse(request),
        "query" => cmd_query(request),
        "status" => cmd_status(request),
        "list" => cmd_list(request),
        "info" | "detail" | "paper" => cmd_info(request),
        "batch" => cmd_batch(request),
        "migrate" | "organize" => cmd_migrate(request),
        "locate" => cmd_locate(request),
        "read" => read::cmd_read(request),
        "preflight" | "precheck" | "dedupe_check" => dedupe::cmd_preflight(request),
        "duplicates" | "dedupe" | "dupes" => dedupe::cmd_duplicates(request),
        other => Err(AppError::fix(format!(
            "未知命令: {}。支持的命令: parse / query / status / list / info / batch / migrate / locate / read / preflight / duplicates。",
            other
        ))),
    }
}

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------

pub(crate) fn project_base() -> PathBuf {
    env::var("PROJECT_BASE_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// 按 paper_id 定位资产目录：兼容 `paper_xxx` 与 `标题__paper_xxx` 两种命名。
fn file_dir_of(paper_id: &str) -> PathBuf {
    library::resolve_file_dir(paper_id)
}

fn image_dir_of(paper_id: &str) -> PathBuf {
    library::resolve_image_dir(paper_id)
}

fn poll_timeout() -> Duration {
    let secs = env::var("POLL_TIMEOUT_SEC")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(MAX_POLL_SECS)
        .min(MAX_POLL_SECS);
    Duration::from_secs(secs.max(1))
}

fn require_token() -> Result<String, AppError> {
    let token = env::var("MINERU_TOKEN").unwrap_or_default();
    if token.trim().is_empty() {
        return Err(AppError::fix(
            "未配置 MINERU_TOKEN：请在 Plugin/MinerUParser/config.env 中填入从 https://mineru.net 获取的 API Token 后重启服务。",
        ));
    }
    Ok(token)
}

fn sha256_file(path: &Path) -> Result<String, AppError> {
    let mut file =
        File::open(path).map_err(|e| AppError::fix(format!("打开文件失败 {}: {}", path.display(), e)))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|e| AppError::fix(format!("读取文件失败: {}", e)))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn sha256_text(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    hex::encode(hasher.finalize())
}

fn paper_id_from_hex(hex: &str) -> String {
    format!("paper_{}", &hex[..16])
}

/// 千分位格式化。
fn fmt_num(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    let bytes = s.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 && (bytes.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(*b as char);
    }
    out
}

/// 单次批量任务的文件数上限（目录展开后）。
const MAX_BATCH_FILES: usize = 20;
/// 批量命令默认并发数。
const DEFAULT_WORKERS: usize = 3;
/// 并发上限（避免 MinerU 限流与本地 IO 争抢）。
const MAX_WORKERS: usize = 5;

fn is_url(source: &str) -> bool {
    source.starts_with("http://") || source.starts_with("https://")
}

fn worker_count(request: &Request) -> usize {
    request
        .workers
        .map(|n| n as usize)
        .or_else(|| {
            env::var("BATCH_WORKERS")
                .ok()
                .and_then(|v| v.trim().parse::<usize>().ok())
        })
        .unwrap_or(DEFAULT_WORKERS)
        .clamp(1, MAX_WORKERS)
}

/// 固定大小的并发执行器：保持输入顺序返回结果。
fn run_concurrent<T, R, F>(items: &[T], workers: usize, f: F) -> Vec<R>
where
    T: Sync,
    R: Send,
    F: Fn(&T) -> R + Sync,
{
    if items.len() <= 1 || workers <= 1 {
        return items.iter().map(|item| f(item)).collect();
    }
    let workers = workers.min(items.len());
    let next = std::sync::atomic::AtomicUsize::new(0);
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::scope(|scope| {
        for _ in 0..workers {
            let tx = tx.clone();
            let next = &next;
            let f = &f;
            scope.spawn(move || loop {
                let index = next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if index >= items.len() {
                    break;
                }
                if tx.send((index, f(&items[index]))).is_err() {
                    break;
                }
            });
        }
        drop(tx);
        let mut results: Vec<(usize, R)> = rx.iter().collect();
        results.sort_by_key(|(index, _)| *index);
        results.into_iter().map(|(_, value)| value).collect()
    })
}

/// 把 file_paths 中的目录递归展开为 PDF 文件列表，去重并限制总数。
fn expand_sources(request: &Request, sources: &[String]) -> Result<Vec<String>, AppError> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    let mut truncated = false;
    for source in sources {
        let source = source.trim();
        if source.is_empty() {
            continue;
        }
        if is_url(source) {
            if seen.insert(source.to_lowercase()) {
                out.push(source.to_string());
            }
            continue;
        }
        let path = Path::new(source);
        if path.is_dir() {
            let remaining = MAX_BATCH_FILES.saturating_sub(out.len());
            let (pdfs, cut) = library::collect_pdfs(path, request.recursive, remaining)?;
            truncated = truncated || cut;
            for pdf in pdfs {
                let text = pdf.to_string_lossy().to_string();
                if seen.insert(text.to_lowercase()) {
                    out.push(text);
                }
            }
        } else if seen.insert(source.to_lowercase()) {
            out.push(source.to_string());
        }
    }
    if truncated || out.len() > MAX_BATCH_FILES {
        return Err(AppError::fix(format!(
            "目录展开后超过单次 {} 个文件上限。请一次传入更具体的子目录，或分批提交。",
            MAX_BATCH_FILES
        )));
    }
    Ok(out)
}

/// 卡片末尾附带的论文库感知摘要。
fn library_block() -> String {
    format!("\n---\n{}", library::compact_summary())
}

/// 论文记录 → 结构化 data（不重复放大纲/图片等大字段）。
fn record_json(record: &library::PaperRecord, detail: bool) -> Value {
    let mut value = json!({
        "paper_id": record.paper_id.as_str(),
        "title": record.title_or_id(),
        "status": record.group.as_str(),
        "state": record.raw_state.as_deref(),
        "pages": record.pages,
        "text_chars": record.text_chars,
        "image_count": record.image_count,
        "table_count": record.table_count,
        "formula_count": record.formula_count,
        "asset_dir": record.asset_dir.as_str(),
        "source_path": record.source_path.as_deref(),
        "source_dir": record.source_dir.as_deref(),
        "batch_id": record.batch_id.as_deref(),
        "progress": record.progress.map(|(extracted, total)| json!({
            "extracted_pages": extracted,
            "total_pages": total,
        })),
        "chunks": record.chunks_done.map(|(done, total)| json!({
            "done": done,
            "total": total,
        })),
        "updated_at": record.updated_at.as_str(),
        "error": record.error.as_deref(),
        "legacy_dir": record.legacy_dir,
    });
    if detail {
        if let Some(index) = &record.index {
            value["md_path"] = json!(index.md_path.as_str());
            value["render_url"] = json!(index.render_url.as_str());
            value["outline"] = json!(index
                .outline
                .iter()
                .take(30)
                .collect::<Vec<_>>());
            value["images"] = json!(index
                .images
                .iter()
                .take(12)
                .map(|img| json!({
                    "rel": img.rel.as_str(),
                    "url": img.url.as_str(),
                    "caption": img.caption.as_deref(),
                    "page_idx": img.page_idx,
                }))
                .collect::<Vec<_>>());
            value["errors"] = json!(&index.errors);
            value["warnings"] = json!(&index.warnings);
        }
    }
    value
}

fn status_counts_json(records: &[library::PaperRecord]) -> Value {
    let count = |group: &str| records.iter().filter(|r| r.group == group).count();
    json!({
        "total": records.len(),
        "indexed": count("indexed"),
        "running": count("running"),
        "timeout": count("timeout"),
        "failed": count("failed"),
        "unknown": count("unknown"),
    })
}

/// 已索引 → 缓存卡片；进行中 → 提示 query 续查。
fn early_return(file_dir: &Path, paper_id: &str) -> Option<Result<ParseResult, AppError>> {
    if let Some(index) = state::load_index(file_dir) {
        if index.paper_id == paper_id {
            return Some(Ok(ParseResult::Done { index, cached: true }));
        }
    }
    if let Some(st) = state::load_state(file_dir) {
        if is_intermediate(&st.state) {
            let batch = if !st.batch_id.is_empty() {
                st.batch_id.clone()
            } else {
                st.chunks
                    .iter()
                    .find(|c| !c.batch_id.is_empty())
                    .map(|c| c.batch_id.clone())
                    .unwrap_or_default()
            };
            if !batch.is_empty() {
                return Some(Ok(ParseResult::Timeout {
                    paper_id: st.paper_id.clone(),
                    batch_id: batch,
                    chunk_desc: String::new(),
                }));
            }
        }
    }
    None
}

fn is_intermediate(state: &str) -> bool {
    matches!(
        state,
        state::STATE_UPLOADING
            | state::STATE_RUNNING
            | state::STATE_DOWNLOADING
            | state::STATE_EXTRACTING
            | state::STATE_TIMEOUT
            | "waiting-file"
            | "pending"
    )
}

fn upload_options(request: &Request, file_name: &str) -> UploadOptions {
    UploadOptions {
        file_name: file_name.to_string(),
        is_ocr: request.is_ocr,
        model_version: request.effective_model_version(),
        language: request.effective_language(),
        enable_formula: request.enable_formula,
        enable_table: request.enable_table,
    }
}

// ---------------------------------------------------------------------------
// parse：完整解析（本地文件 / 公开 URL / >200 页自动分片）
// ---------------------------------------------------------------------------

fn cmd_parse(request: &Request) -> Result<CommandOutput, AppError> {
    // 兼容：parse 也接受 file_paths/urls，多输入时自动转入批量汇总。
    if request
        .file_paths
        .as_ref()
        .map(|v| !v.is_empty())
        .unwrap_or(false)
        || request
            .urls
            .as_ref()
            .map(|v| !v.is_empty())
            .unwrap_or(false)
    {
        return cmd_batch(request);
    }
    match run_parse(request)? {
        ParseResult::Done { index, cached } => {
            let mut text = render_card(&index, cached);
            text.push_str(&library_block());
            Ok(CommandOutput::Card(text))
        }
        ParseResult::Timeout { paper_id, batch_id, chunk_desc } => {
            let mut out = render_timeout(
                &paper_id, &batch_id, &chunk_desc, poll_timeout().as_secs(), None,
            );
            if let CommandOutput::Timeout { text, .. } = &mut out {
                text.push_str(&library_block());
            }
            Ok(out)
        }
    }
}

fn run_parse(request: &Request) -> Result<ParseResult, AppError> {
    // URL 模式
    if let Some(url) = request.url.as_deref() {
        if request.file_path.is_some() {
            return Err(AppError::fix("file_path 与 url 不能同时提供，请二选一。"));
        }
        return parse_by_url(request, url);
    }

    // 文件模式
    let file_path = request
        .file_path
        .as_deref()
        .ok_or_else(|| AppError::fix("parse 命令缺少必需参数 file_path（PDF 绝对路径）或 url（公开 URL）。"))?;
    let path = Path::new(file_path);
    let meta = fs::metadata(path)
        .map_err(|e| AppError::fix(format!("文件不存在或无法访问 {}: {}", file_path, e)))?;
    if !meta.is_file() {
        return Err(AppError::fix(format!("file_path 不是普通文件: {}", file_path)));
    }
    if meta.len() > MAX_FILE_SIZE {
        return Err(AppError::fix(format!(
            "文件 {} 为 {}MB，超过 200MB 上限",
            file_path,
            meta.len() / (1024 * 1024)
        )));
    }
    request.validate_model_version().map_err(AppError::fix)?;

    let paper_id = paper_id_from_hex(&sha256_file(path)?);
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("document.pdf")
        .to_string();
    let file_dir = file_dir_of(&paper_id);
    if let Some(early) = early_return(&file_dir, &paper_id) {
        return early;
    }

    let pages = pdfops::page_count(path)?;
    if pages > pdfops::CHUNK_PAGE_LIMIT {
        parse_file_split(request, path, &paper_id, pages, &file_name)
    } else {
        parse_file_single(request, path, &paper_id, &file_name)
    }
}

/// ≤200 页：单批上传 → 轮询 → 下载 → 落盘。
fn parse_file_single(
    request: &Request,
    path: &Path,
    paper_id: &str,
    file_name: &str,
) -> Result<ParseResult, AppError> {
    let file_dir = file_dir_of(paper_id);
    let token = require_token()?;
    let client = MineruClient::new(token);

    fs::create_dir_all(&file_dir)
        .map_err(|e| AppError::fix(format!("创建资产目录失败: {}", e)))?;
    let mut st = PersistentState::new(paper_id, file_name);
    st.is_ocr = request.is_ocr;
    st.language = request.effective_language();
    st.model_version = request.effective_model_version();
    st.source_path = Some(path.to_string_lossy().to_string());
    st.source_dir = path.parent().map(|p| p.to_string_lossy().to_string());
    st.title_override = request.title.clone();
    state::save_state(&file_dir, &mut st)?;

    let opts = upload_options(request, file_name);
    let (batch_id, signed_url) = client.request_upload(&opts)?;
    st.batch_id = batch_id;
    st.state = state::STATE_RUNNING.to_string();
    state::save_state(&file_dir, &mut st)?;
    client.upload_file(path, &signed_url)?;

    finish_single(&client, &mut st, &file_dir, poll_timeout(), PollKind::Batch)
}

/// >200 页：切分 → 逐片上传/轮询/下载/解压 → 合并落盘。
fn parse_file_split(
    request: &Request,
    path: &Path,
    paper_id: &str,
    pages: u64,
    file_name: &str,
) -> Result<ParseResult, AppError> {
    let file_dir = file_dir_of(paper_id);
    let token = require_token()?;
    let client = MineruClient::new(token);

    fs::create_dir_all(&file_dir)
        .map_err(|e| AppError::fix(format!("创建资产目录失败: {}", e)))?;
    let chunks_dir = file_dir.join(".chunks");
    let chunk_files = pdfops::split_pdf(path, &chunks_dir, pdfops::CHUNK_PAGE_LIMIT)
        .map_err(|e| AppError::fatal(format!("分片失败: {}", e.message())))?;

    let mut st = PersistentState::new(paper_id, file_name);
    st.split_pages = Some(pages);
    st.chunk_size = Some(pdfops::CHUNK_PAGE_LIMIT);
    st.source_path = Some(path.to_string_lossy().to_string());
    st.source_dir = path.parent().map(|p| p.to_string_lossy().to_string());
    st.title_override = request.title.clone();
    st.chunks = chunk_files
        .iter()
        .map(|c| ChunkState {
            index: c.index,
            start_page: c.start_page,
            end_page: c.end_page,
            batch_id: String::new(),
            state: "pending".to_string(),
            err_msg: None,
            extracted: None,
            total: None,
        })
        .collect();
    st.is_ocr = request.is_ocr;
    st.language = request.effective_language();
    st.model_version = request.effective_model_version();
    st.state = state::STATE_RUNNING.to_string();
    state::save_state(&file_dir, &mut st)?;

    process_split_chunks(&client, &mut st, &file_dir, poll_timeout())
}

/// 公开 URL：extract/task 提交 → 专用端点轮询 → 下载 → 落盘。
fn parse_by_url(request: &Request, url: &str) -> Result<ParseResult, AppError> {
    let paper_id = paper_id_from_hex(&sha256_text(url));
    let file_name = url
        .rsplit('/')
        .next()
        .map(|s| s.split('?').next().unwrap_or(s))
        .filter(|s| !s.is_empty())
        .unwrap_or("url.pdf")
        .to_string();
    let file_dir = file_dir_of(&paper_id);
    if let Some(early) = early_return(&file_dir, &paper_id) {
        return early;
    }

    let token = require_token()?;
    let client = MineruClient::new(token);
    fs::create_dir_all(&file_dir)
        .map_err(|e| AppError::fix(format!("创建资产目录失败: {}", e)))?;
    let mut st = PersistentState::new(&paper_id, &file_name);
    st.is_ocr = request.is_ocr;
    st.language = request.effective_language();
    st.model_version = request.effective_model_version();
    st.source_path = Some(url.to_string());
    st.source_dir = Some("url".to_string());
    st.title_override = request.title.clone();
    st.state = state::STATE_RUNNING.to_string();
    state::save_state(&file_dir, &mut st)?;

    let task_id = client.request_extract_task(url, &upload_options(request, &file_name))?;
    st.batch_id = task_id;
    state::save_state(&file_dir, &mut st)?;

    finish_single(&client, &mut st, &file_dir, poll_timeout(), PollKind::Task)
}

enum PollKind {
    Batch,
    Task,
}

/// 单批/URL 任务共用收尾：轮询 → 下载 → 解压 → 落盘 → 质检 → index → 卡片。
fn finish_single(
    client: &MineruClient,
    st: &mut PersistentState,
    file_dir: &Path,
    timeout: Duration,
    kind: PollKind,
) -> Result<ParseResult, AppError> {
    let cell = std::cell::RefCell::new(st.clone());
    let outcome = {
        let on_state = |state: &str, progress: Option<(u64, u64)>, changed: bool| {
            let mut cur = cell.borrow_mut();
            cur.state = state.to_string();
            if let Some((extracted, total)) = progress {
                cur.last_progress = Some(state::ProgressInfo {
                    extracted_pages: extracted,
                    total_pages: total,
                });
            }
            if changed {
                let _ = state::save_state(file_dir, &mut cur);
            }
        };
        match kind {
            PollKind::Batch => client.poll_batch(
                &st.batch_id,
                &st.file_name,
                timeout,
                on_state,
            )?,
            PollKind::Task => client.poll_task(&st.batch_id, timeout, on_state)?,
        }
    };
    *st = cell.into_inner();

    match outcome {
        PollOutcome::Timeout => {
            st.state = state::STATE_TIMEOUT.to_string();
            state::save_state(file_dir, st)?;
            Ok(ParseResult::Timeout {
                paper_id: st.paper_id.clone(),
                batch_id: st.batch_id.clone(),
                chunk_desc: String::new(),
            })
        }
        PollOutcome::Failed(msg) => {
            st.state = state::STATE_FAILED.to_string();
            st.err_msg = Some(msg.clone());
            state::save_state(file_dir, st)?;
            Err(AppError::fatal(format!(
                "云端解析失败: {}（paper_id: {}，batch_id: {}）",
                msg, st.paper_id, st.batch_id
            )))
        }
        PollOutcome::Done(zip_url) => {
            st.state = state::STATE_DOWNLOADING.to_string();
            state::save_state(file_dir, st)?;
            client.download_zip(&zip_url, &file_dir.join("source.zip"))?;

            st.state = state::STATE_EXTRACTING.to_string();
            state::save_state(file_dir, st)?;
            let work_dir = file_dir.join(".work");
            let _ = fs::remove_dir_all(&work_dir);
            zip_safe::safe_extract_zip(&file_dir.join("source.zip"), &work_dir)?;

            let specs = vec![(work_dir, 0u64, 0u64)];
            let index = finalize(st, file_dir, &specs)?;
            Ok(ParseResult::Done { index, cached: false })
        }
    }
}

/// 分片模式：逐片 上传（如需）→ 轮询 → 下载 → 解压；全部完成后合并。
fn process_split_chunks(
    client: &MineruClient,
    st: &mut PersistentState,
    file_dir: &Path,
    timeout: Duration,
) -> Result<ParseResult, AppError> {
    let total_chunks = st.chunks.len();
    for i in 0..total_chunks {
        if st.chunks[i].state == "done" {
            continue;
        }

        // 上传缺失的分片（query 续查时可能未上传过）
        if st.chunks[i].batch_id.is_empty() {
            let pdf = file_dir
                .join(".chunks")
                .join(format!("part_{}.pdf", i + 1));
            if !pdf.is_file() {
                return Err(AppError::fix(format!(
                    "分片文件缺失：{}（如已删除请重新 parse）",
                    pdf.display()
                )));
            }
            let chunk_name = format!("part_{}.pdf", i + 1);
            let opts = UploadOptions {
                file_name: chunk_name.clone(),
                is_ocr: st.is_ocr,
                model_version: st.model_version.clone(),
                language: st.language.clone(),
                enable_formula: true,
                enable_table: true,
            };
            let (batch_id, signed_url) = client.request_upload(&opts)?;
            st.chunks[i].batch_id = batch_id;
            st.chunks[i].state = state::STATE_RUNNING.to_string();
            state::save_state(file_dir, st)?;
            client.upload_file(&pdf, &signed_url)?;
        }

        // 轮询该分片
        let chunk_name = format!("part_{}.pdf", i + 1);
        let cell = std::cell::RefCell::new(st.clone());
        let batch_id = st.chunks[i].batch_id.clone();
        let outcome = client.poll_batch(&batch_id, &chunk_name, timeout, |state, progress, changed| {
            let mut cur = cell.borrow_mut();
            cur.chunks[i].state = state.to_string();
            if let Some((extracted, total)) = progress {
                cur.chunks[i].extracted = Some(extracted);
                cur.chunks[i].total = Some(total);
                cur.last_progress = Some(state::ProgressInfo {
                    extracted_pages: extracted,
                    total_pages: total,
                });
            }
            if changed {
                let _ = state::save_state(file_dir, &mut cur);
            }
        })?;
        *st = cell.into_inner();

        match outcome {
            PollOutcome::Timeout => {
                st.state = state::STATE_TIMEOUT.to_string();
                state::save_state(file_dir, st)?;
                return Ok(ParseResult::Timeout {
                    paper_id: st.paper_id.clone(),
                    batch_id: st.chunks[i].batch_id.clone(),
                    chunk_desc: format!("分片 {}/{}", i + 1, total_chunks),
                });
            }
            PollOutcome::Failed(msg) => {
                st.chunks[i].state = state::STATE_FAILED.to_string();
                st.chunks[i].err_msg = Some(msg.clone());
                st.state = state::STATE_FAILED.to_string();
                st.err_msg = Some(format!("{}: {}", chunk_name, msg));
                state::save_state(file_dir, st)?;
                return Err(AppError::fatal(format!(
                    "云端解析失败（{}，分片 {}/{}）: {}（paper_id: {}）",
                    chunk_name,
                    i + 1,
                    total_chunks,
                    msg,
                    st.paper_id
                )));
            }
            PollOutcome::Done(zip_url) => {
                st.chunks[i].state = state::STATE_DOWNLOADING.to_string();
                state::save_state(file_dir, st)?;
                let zip_name = format!("source.part{}.zip", i + 1);
                client.download_zip(&zip_url, &file_dir.join(&zip_name))?;

                let work_dir = file_dir.join(format!(".work_part{}", i + 1));
                let _ = fs::remove_dir_all(&work_dir);
                zip_safe::safe_extract_zip(&file_dir.join(&zip_name), &work_dir)?;
                st.chunks[i].state = "done".to_string();
                st.state = state::STATE_EXTRACTING.to_string();
                state::save_state(file_dir, st)?;
            }
        }
    }

    // 全部分片完成 → 合并落盘
    let specs: Vec<(PathBuf, u64, u64)> = st
        .chunks
        .iter()
        .map(|c| {
            (
                file_dir.join(format!(".work_part{}", c.index + 1)),
                c.start_page,
                c.end_page,
            )
        })
        .collect();
    let index = finalize(st, file_dir, &specs)?;
    Ok(ParseResult::Done { index, cached: false })
}

/// 在正式落盘前推导标题（显式 title > 首个 content_list 标题 > 文件名去扩展名）。
fn preview_title(st: &PersistentState, chunks: &[ChunkInput]) -> String {
    if let Some(title) = st
        .title_override
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        return title.to_string();
    }
    for chunk in chunks {
        let Some(text) = chunk.scan.content_list_text.as_deref() else {
            continue;
        };
        let stats = outline::analyze(text);
        if let Some(node) = stats
            .outline
            .iter()
            .find(|n| n.level == 1)
            .or_else(|| stats.outline.first())
        {
            let title = node.text.trim();
            if !title.is_empty() {
                return title.to_string();
            }
        }
    }
    Path::new(&st.file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&st.file_name)
        .to_string()
}

struct Relocated {
    file_dir: PathBuf,
    leaf: String,
    warning: Option<String>,
}

/// 把进行中的 `paper_xxx` 目录改名为 `标题__paper_xxx`；失败时回退旧目录，不阻断解析。
fn relocate_for_finalize_in(base: &Path, paper_id: &str, old_dir: &Path, title: &str) -> Relocated {
    let root = base.join("file").join("mineru");
    let image_root = base.join("image").join("mineru");
    let old_leaf = library::asset_dir_name(old_dir);
    for version in 1..=50 {
        let leaf = library::versioned_leaf(title, paper_id, version);
        let new_dir = root.join(&leaf);
        if new_dir == old_dir {
            return Relocated {
                file_dir: old_dir.to_path_buf(),
                leaf,
                warning: None,
            };
        }
        if new_dir.exists() {
            continue;
        }
        match fs::rename(old_dir, &new_dir) {
            Ok(()) => {
                let old_image = image_root.join(&old_leaf);
                let new_image = image_root.join(&leaf);
                if old_image.is_dir() && old_image != new_image && !new_image.exists() {
                    let _ = fs::rename(&old_image, &new_image);
                }
                return Relocated {
                    file_dir: new_dir,
                    leaf,
                    warning: None,
                };
            }
            Err(e) => {
                return Relocated {
                    file_dir: old_dir.to_path_buf(),
                    leaf: old_leaf.clone(),
                    warning: Some(format!(
                        "资产目录未能改为标题名（{}），已保留 {}。",
                        e, old_leaf
                    )),
                };
            }
        }
    }
    Relocated {
        file_dir: old_dir.to_path_buf(),
        leaf: old_leaf,
        warning: Some("同名标题目录过多，已保留 paper_id 目录名。".to_string()),
    }
}

/// 合并落盘 + 质检 + index + 状态收尾（单文件与分片共用）。
fn finalize(
    st: &mut PersistentState,
    file_dir: &Path,
    specs: &[(PathBuf, u64, u64)],
) -> Result<IndexDoc, AppError> {
    finalize_in(&project_base(), st, file_dir, specs)
}

fn finalize_in(
    base: &Path,
    st: &mut PersistentState,
    file_dir: &Path,
    specs: &[(PathBuf, u64, u64)],
) -> Result<IndexDoc, AppError> {
    let urls = UrlContext::from_env();
    let paper_id = st.paper_id.clone();
    let file_name = st.file_name.clone();
    let chunks: Vec<ChunkInput> = specs
        .iter()
        .map(|(dir, start, end)| -> Result<ChunkInput, AppError> {
            Ok(ChunkInput {
                scan: assets::scan_chunk(dir)?,
                start_page: *start,
                end_page: *end,
                single: specs.len() == 1,
            })
        })
        .collect::<Result<_, _>>()?;

    // 先推导标题并把工作目录改为可读名称，再生成带正确 URL 的资产。
    let title_hint = preview_title(st, &chunks);
    let relocated = relocate_for_finalize_in(base, &paper_id, file_dir, &title_hint);
    let asset_dir = relocated.leaf.clone();
    let file_dir = relocated.file_dir;
    // 分片 specs 路径来自旧目录；改目录后按相对后缀重新拼接。
    let specs_remapped: Vec<(PathBuf, u64, u64)> = specs
        .iter()
        .map(|(path, start, end)| {
            let tail = path
                .strip_prefix(&file_dir)
                .map(Path::to_path_buf)
                .unwrap_or_else(|_| {
                    path.file_name()
                        .map(|name| file_dir.join(name))
                        .unwrap_or_else(|| path.clone())
                });
            (tail, *start, *end)
        })
        .collect();
    let chunks: Vec<ChunkInput> = specs_remapped
        .iter()
        .map(|(dir, start, end)| -> Result<ChunkInput, AppError> {
            Ok(ChunkInput {
                scan: assets::scan_chunk(dir)?,
                start_page: *start,
                end_page: *end,
                single: specs_remapped.len() == 1,
            })
        })
        .collect::<Result<_, _>>()?;

    let outcome = assets::build_assets_from_chunks(chunks, base, &asset_dir, &urls)?;

    let page_number_ratio = if outcome.stats.text_blocks > 0 {
        outcome.stats.page_number_blocks as f64 / outcome.stats.text_blocks as f64
    } else {
        0.0
    };
    let report = quality::check(&quality::QualityInput {
        has_md: true,
        has_content_list: outcome.content_list_text.is_some(),
        content_list_parse_ok: !outcome.stats.parse_failed,
        content_list_empty: outcome.stats.empty,
        text_chars: outcome.stats.text_chars,
        negative_page_idx: outcome.stats.negative_page_idx,
        has_layout: outcome.has_layout,
        heading_count: outcome.stats.outline.len(),
        page_regressions: outcome.stats.page_regressions,
        missing_image_refs: outcome.missing_refs,
        tables_without_body: outcome.stats.tables_without_body,
        equations_without_latex: outcome.stats.equations_without_latex,
        page_number_ratio,
    });

    let derived = outline::derive_title(&outcome.stats, &file_name);
    let title = st
        .title_override
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            if derived != file_name {
                derived
            } else {
                title_hint
            }
        });
    let mut warnings = report.warnings.clone();
    if let Some(warning) = &relocated.warning {
        warnings.push(warning.clone());
    }
    let index = IndexDoc {
        paper_id: paper_id.clone(),
        title,
        file_name: file_name.clone(),
        asset_dir: Some(asset_dir.clone()),
        source_path: st.source_path.clone(),
        source_dir: st.source_dir.clone(),
        batch_id: (!st.batch_id.is_empty()).then(|| st.batch_id.clone()),
        pages: outcome.stats.total_pages,
        text_chars: outcome.stats.text_chars,
        image_count: outcome.stats.image_count,
        table_count: outcome.stats.table_count,
        formula_count: outcome.stats.formula_count,
        md_path: file_url_of(&file_dir.join("full.md")),
        render_url: urls.file_url(&asset_dir, "full.render.md"),
        outline: outcome.stats.outline.clone(),
        images: outcome.images.clone(),
        errors: report.errors.clone(),
        warnings,
        created_at: state::now_iso(),
    };
    state::save_index(&file_dir, &index)?;

    st.state = state::STATE_INDEXED.to_string();
    st.err_msg = None;
    st.asset_dir = Some(asset_dir);
    state::save_state(&file_dir, st)?;

    // 清理临时工作目录与分片 PDF（source.zip / source.partN.zip 已留档）
    let _ = fs::remove_dir_all(file_dir.join(".work"));
    for i in 0..specs_remapped.len() {
        let _ = fs::remove_dir_all(file_dir.join(format!(".work_part{}", i + 1)));
    }
    let _ = fs::remove_dir_all(file_dir.join(".chunks"));

    Ok(index)
}

// ---------------------------------------------------------------------------
// query：断点续查（单批 / URL 任务 / 分片）
// ---------------------------------------------------------------------------

const MAX_QUERY_PAPERS: usize = 10;

struct QueryTarget {
    paper_id: String,
    batch_id: Option<String>,
}

enum QueryItem {
    Done(IndexDoc, bool),
    Timeout {
        paper_id: String,
        batch_id: String,
        chunk_desc: String,
        progress: Option<(u64, u64)>,
    },
    Already(IndexDoc),
    Failed {
        paper_id: String,
        title: String,
        error: String,
    },
}

fn paper_title_of(paper_id: &str) -> String {
    library::load_record(paper_id)
        .map(|r| r.title_or_id())
        .unwrap_or_else(|| paper_id.to_string())
}

fn collect_query_targets(request: &Request) -> Result<Vec<QueryTarget>, AppError> {
    let mut refs: Vec<String> = request.paper_ids.clone().unwrap_or_default();
    if let Some(id) = &request.paper_id {
        refs.push(id.clone());
    }
    let mut batch_ids = request.batch_ids.clone().unwrap_or_default();
    if batch_ids.is_empty() {
        if let Some(batch) = &request.batch_id {
            batch_ids.push(batch.clone());
        }
    }
    let all = request.all
        || refs
            .iter()
            .any(|r| r.eq_ignore_ascii_case("all") || r == "*");

    let mut targets: Vec<QueryTarget> = Vec::new();
    if all {
        let mut records = library::scan_light();
        library::sort_records(&mut records, "recent");
        for record in records
            .into_iter()
            .filter(|r| r.group != "indexed" && r.batch_id.is_some())
        {
            targets.push(QueryTarget {
                paper_id: record.paper_id,
                batch_id: record.batch_id,
            });
        }
    }
    for (index, reference) in refs.iter().enumerate() {
        if reference.eq_ignore_ascii_case("all") || reference == "*" {
            continue;
        }
        let paper_id = library::resolve_paper_ref(reference)?;
        targets.push(QueryTarget {
            paper_id,
            batch_id: batch_ids.get(index).cloned(),
        });
    }
    // 只给 batch_ids 时，按本地 state 反查论文。
    if targets.is_empty() {
        for batch in &batch_ids {
            if let Some(record) = library::find_by_batch(batch) {
                targets.push(QueryTarget {
                    paper_id: record.paper_id,
                    batch_id: Some(batch.clone()),
                });
            }
        }
    }
    if targets.is_empty() {
        return Err(AppError::fix(if all {
            "当前没有未完成、且带 batch_id 的论文可续查；可用 status 查看全部论文状态。"
        } else {
            "query 缺少续查目标。请提供 paper_id / paper_ids（支持标题或 all=true），或 batch_id / batch_ids。可先用 status 查看所有论文进度。"
        }));
    }
    let mut seen = std::collections::BTreeSet::new();
    targets.retain(|t| seen.insert(t.paper_id.clone()));
    if targets.len() > MAX_QUERY_PAPERS {
        return Err(AppError::fix(format!(
            "单次 query 最多续查 {} 篇，收到 {} 篇。请分批提交，或先用 status 查看进度。",
            MAX_QUERY_PAPERS,
            targets.len()
        )));
    }
    Ok(targets)
}

fn run_query_one(_request: &Request, target: &QueryTarget, token: Option<&str>) -> QueryItem {
    let paper_id = target.paper_id.clone();
    let file_dir = file_dir_of(&paper_id);
    if let Some(index) = state::load_index(&file_dir) {
        if index.paper_id == paper_id {
            return QueryItem::Already(index);
        }
    }
    let mut st = match state::load_state(&file_dir) {
        Some(st) => st,
        None => {
            return QueryItem::Failed {
                title: paper_title_of(&paper_id),
                error: format!(
                    "未找到本地状态记录。{}",
                    library::missing_paper_hint(&paper_id)
                ),
                paper_id,
            }
        }
    };
    let batch_id = target.batch_id.clone().or_else(|| {
        if !st.batch_id.is_empty() {
            Some(st.batch_id.clone())
        } else {
            st.chunks
                .iter()
                .find(|c| !c.batch_id.is_empty() && c.state != "done")
                .or_else(|| st.chunks.iter().find(|c| !c.batch_id.is_empty()))
                .map(|c| c.batch_id.clone())
        }
    });
    let token = match token {
        Some(token) => token,
        None => {
            return QueryItem::Failed {
                title: paper_title_of(&paper_id),
                paper_id,
                error: "未配置 MINERU_TOKEN：请在 Plugin/MinerUParser/config.env 中填入 Token。"
                    .to_string(),
            }
        }
    };
    let client = MineruClient::new(token.to_string());
    let title = paper_title_of(&paper_id);
    let outcome = if !st.chunks.is_empty() {
        st.state = state::STATE_RUNNING.to_string();
        if let Err(e) = state::save_state(&file_dir, &mut st) {
            return QueryItem::Failed { paper_id, title, error: e.message().to_string() };
        }
        process_split_chunks(&client, &mut st, &file_dir, poll_timeout())
    } else {
        let Some(batch_id) = batch_id else {
            return QueryItem::Failed {
                paper_id,
                title,
                error: "缺少 batch_id，无法续查。请用 status 确认本地状态，或重新 parse。".to_string(),
            };
        };
        st.batch_id = batch_id;
        st.state = state::STATE_RUNNING.to_string();
        if let Err(e) = state::save_state(&file_dir, &mut st) {
            return QueryItem::Failed { paper_id, title, error: e.message().to_string() };
        }
        let kind = if st.source_path.as_deref().map(is_url).unwrap_or(false) {
            PollKind::Task
        } else {
            PollKind::Batch
        };
        finish_single(&client, &mut st, &file_dir, poll_timeout(), kind)
    };
    match outcome {
        Ok(ParseResult::Done { index, cached }) => QueryItem::Done(index, cached),
        Ok(ParseResult::Timeout { paper_id, batch_id, chunk_desc }) => QueryItem::Timeout {
            paper_id,
            batch_id,
            chunk_desc,
            progress: st
                .last_progress
                .as_ref()
                .map(|p| (p.extracted_pages, p.total_pages)),
        },
        Err(e) => QueryItem::Failed { paper_id, title, error: e.message().to_string() },
    }
}

fn cmd_query(request: &Request) -> Result<CommandOutput, AppError> {
    let targets = collect_query_targets(request)?;
    let token = require_token().ok();
    let workers = worker_count(request);
    let items: Vec<QueryItem> = if targets.len() == 1 {
        vec![run_query_one(request, &targets[0], token.as_deref())]
    } else {
        run_concurrent(&targets, workers, |target| {
            run_query_one(request, target, token.as_deref())
        })
    };

    if targets.len() == 1 {
        return match items.into_iter().next().unwrap() {
            QueryItem::Done(index, cached) => {
                let mut text = render_card(&index, cached);
                text.push_str(&library_block());
                Ok(CommandOutput::Card(text))
            }
            QueryItem::Already(index) => {
                let mut text = render_card(&index, true);
                text.push_str(&library_block());
                Ok(CommandOutput::Card(text))
            }
            QueryItem::Timeout { paper_id, batch_id, chunk_desc, progress } => {
                let progress = progress.map(|(extracted_pages, total_pages)| state::ProgressInfo {
                    extracted_pages,
                    total_pages,
                });
                let mut out = render_timeout(
                    &paper_id,
                    &batch_id,
                    &chunk_desc,
                    poll_timeout().as_secs(),
                    progress.as_ref(),
                );
                if let CommandOutput::Timeout { text, .. } = &mut out {
                    text.push_str(&library_block());
                }
                Ok(out)
            }
            QueryItem::Failed { error, .. } => Err(AppError::fix(error)),
        };
    }

    let mut done = 0usize;
    let mut pending = 0usize;
    let mut already = 0usize;
    let mut failed = 0usize;
    let mut rows = String::new();
    for item in items {
        match item {
            QueryItem::Done(index, _) => {
                done += 1;
                rows.push_str(&format!(
                    "| `{}` | {} | ✅ 已完成 | {} 页 · {} 图 | - |\n",
                    index.paper_id,
                    library::truncate_chars(&index.title, 42),
                    index.pages,
                    index.image_count
                ));
            }
            QueryItem::Already(index) => {
                already += 1;
                rows.push_str(&format!(
                    "| `{}` | {} | ✅ 早已完成 | {} 页 · {} 图 | `read` 可读 |\n",
                    index.paper_id,
                    library::truncate_chars(&index.title, 42),
                    index.pages,
                    index.image_count
                ));
            }
            QueryItem::Timeout { paper_id, batch_id, chunk_desc, progress } => {
                pending += 1;
                let progress_text = progress
                    .map(|(a, b)| format!("{}/{} 页", a, b))
                    .unwrap_or_else(|| "-".to_string());
                rows.push_str(&format!(
                    "| `{}` | {} | ⏳ 待续查 | {} {} | `query paper_id={}` |\n",
                    paper_id,
                    library::truncate_chars(&paper_title_of(&paper_id), 42),
                    progress_text,
                    chunk_desc,
                    paper_id
                ));
                let _ = batch_id;
            }
            QueryItem::Failed { paper_id, title, error } => {
                failed += 1;
                rows.push_str(&format!(
                    "| `{}` | {} | ❌ 失败 | {} | - |\n",
                    paper_id,
                    library::truncate_chars(&title, 42),
                    library::truncate_chars(&error, 80)
                ));
            }
        }
    }
    let mut out = format!(
        "## 🔄 批量续查：{} 篇（✅ 新完成 {} ｜ ✅ 已有 {} ｜ ⏳ 待续查 {} ｜ ❌ 失败 {}）\n\n",
        done + already + pending + failed,
        done,
        already,
        pending,
        failed
    );
    out.push_str("| paper_id | 标题 | 状态 | 页数 / 进度 | 下一步 |\n|---|---|---|---|---|\n");
    out.push_str(&rows);
    if pending > 0 {
        out.push_str("\n可再次执行 `query paper_ids=...`（或用 `query all=true` 续查全部未完成论文）；`status` 可查看实时进度。\n");
    }
    out.push_str(&library_block());
    Ok(CommandOutput::Card(out))
}

// ---------------------------------------------------------------------------
// batch：批量导入
// ---------------------------------------------------------------------------

fn cmd_batch(request: &Request) -> Result<CommandOutput, AppError> {
    let mut raw: Vec<String> = Vec::new();
    if let Some(path) = &request.file_path {
        raw.push(path.clone());
    }
    raw.extend(request.file_paths.clone().unwrap_or_default());
    if let Some(url) = &request.url {
        raw.push(url.clone());
    }
    raw.extend(request.urls.clone().unwrap_or_default());
    if raw.is_empty() {
        return Err(AppError::fix(
            "batch 命令缺少必需参数 file_paths（本地路径/目录数组或逗号/换行分隔）或 urls（公开 URL）。",
        ));
    }
    let sources = expand_sources(request, &raw)?;
    if sources.is_empty() {
        return Err(AppError::fix(
            "目录中没有找到 PDF 文件。请检查路径，或直接传入 .pdf 文件。",
        ));
    }

    let workers = worker_count(request);
    let results: Vec<Result<ParseResult, AppError>> = run_concurrent(&sources, workers, |source| {
        let mut sub = request.clone();
        sub.file_paths = None;
        sub.urls = None;
        sub.file_path = None;
        sub.url = None;
        if is_url(source) {
            sub.url = Some(source.clone());
        } else {
            sub.file_path = Some(source.clone());
        }
        run_parse(&sub)
    });

    let mut ok = 0usize;
    let mut pending = 0usize;
    let mut failed = 0usize;
    let mut cached = 0usize;
    let mut rows = String::new();
    for (source, result) in sources.iter().zip(results) {
        match result {
            Ok(ParseResult::Done { index, cached: is_cached }) => {
                ok += 1;
                if is_cached {
                    cached += 1;
                }
                let asset = index
                    .asset_dir
                    .clone()
                    .unwrap_or_else(|| index.paper_id.clone());
                rows.push_str(&format!(
                    "| `{}` | {} | {} | {} | {} | {} |\n",
                    index.paper_id,
                    library::truncate_chars(&index.title, 42),
                    if is_cached { "♻️ 缓存" } else { "✅ 新解析" },
                    index.pages,
                    index.image_count,
                    library::leaf_preview(&asset, 46),
                ));
            }
            Ok(ParseResult::Timeout { paper_id, batch_id, chunk_desc }) => {
                pending += 1;
                rows.push_str(&format!(
                    "| `{}` | {} | ⏳ 待续查 {} | - | - | `query paper_id={}` |\n",
                    paper_id,
                    library::truncate_chars(&paper_title_of(&paper_id), 42),
                    chunk_desc,
                    paper_id,
                ));
                let _ = batch_id;
            }
            Err(e) => {
                failed += 1;
                rows.push_str(&format!(
                    "| - | {} | ❌ {} | - | - | - |\n",
                    library::truncate_chars(source, 52),
                    library::truncate_chars(e.message(), 64),
                ));
            }
        }
    }

    let mut out = format!(
        "## 📥 批量解析：{} 个任务（✅ 新解析 {} ｜ ♻️ 缓存 {} ｜ ⏳ 待续查 {} ｜ ❌ 失败 {}，并发 {}）\n\n",
        sources.len(),
        ok.saturating_sub(cached),
        cached,
        pending,
        failed,
        workers
    );
    out.push_str("| paper_id | 标题 | 状态 | 页数 | 图片 | 资产目录 / 下一步 |\n|---|---|---|---|---|---|\n");
    out.push_str(&rows);
    if pending > 0 {
        out.push_str("\n用 `query paper_ids=...` 或 `query all=true` 同时续查多篇；`status` 查看实时进度。\n");
    }
    if ok > 0 {
        out.push_str("已完成论文可用 `info paper_id=...` 查看大纲/图片，用 `read` 读取正文。\n");
    }
    out.push_str(&library_block());
    Ok(CommandOutput::Card(out))
}

// ---------------------------------------------------------------------------
// locate：关键词 → 段落秒级定位
// ---------------------------------------------------------------------------

fn cmd_locate(request: &Request) -> Result<CommandOutput, AppError> {
    locate::cmd_locate(request)
}

// ---------------------------------------------------------------------------
// list：本地资产清单
// ---------------------------------------------------------------------------

fn cmd_list(request: &Request) -> Result<CommandOutput, AppError> {
    let all_records = library::scan(true);
    if all_records.is_empty() {
        return Ok(CommandOutput::Card(
            "## 📚 论文库\n\n本地还没有已解析论文。\n\n- 解析单篇：`parse file_path=\"D:/papers/a.pdf\"`\n- 批量导入：`batch file_paths=\"D:/papers\"`（目录会递归展开 PDF）".to_string(),
        ));
    }
    let filters = library::normalize_status_filter(request.status.as_deref())?;
    let mut records: Vec<library::PaperRecord> = all_records
        .iter()
        .filter(|r| library::matches_status(&r.group, filters.as_deref()))
        .filter(|r| {
            request
                .query
                .as_deref()
                .map(|q| library::query_match(r, q))
                .unwrap_or(true)
        })
        .cloned()
        .collect();
    library::sort_records(&mut records, request.sort.as_deref().unwrap_or("recent"));
    let matched = records.len();
    let limit = request.limit.unwrap_or(20).clamp(1, 100) as usize;
    records.truncate(limit);

    let mut out = format!(
        "## 📚 论文库：{}\n\n- 资产根目录：`{}`\n",
        library::counts_text(&all_records),
        project_base().join("file").join("mineru").display()
    );
    if let Some(query) = &request.query {
        out.push_str(&format!("- 关键词：`{}`（匹配 {} 篇）\n", query, matched));
    }
    if matched > limit {
        out.push_str(&format!(
            "- 仅显示前 {} 篇（匹配 {} 篇），可用 query/status/limit 缩小范围\n",
            limit, matched
        ));
    }
    if records.is_empty() {
        out.push_str("\n没有匹配的论文。可去掉 status/query，或用 `status` 查看全部进度。\n");
        return Ok(CommandOutput::CardData {
            text: out,
            data: json!({
                "command": "list",
                "counts": status_counts_json(&all_records),
                "matched": 0,
                "papers": [],
            }),
        });
    }
    out.push_str("\n| paper_id | 标题 | 状态 | 页数 | 图片 | 资产目录 | 更新 |\n|---|---|---|---|---|---|---|\n");
    for record in &records {
        let pages = record
            .pages
            .map(|p| p.to_string())
            .unwrap_or_else(|| "-".to_string());
        let images = record
            .image_count
            .map(|p| p.to_string())
            .unwrap_or_else(|| "-".to_string());
        let asset = if record.legacy_dir {
            format!("{}（旧）", record.asset_dir)
        } else {
            record.asset_dir.clone()
        };
        out.push_str(&format!(
            "| `{}` | {} | {} | {} | {} | {} | {} |\n",
            record.paper_id,
            library::truncate_chars(&record.title_or_id(), 46),
            record.status_text(),
            pages,
            images,
            library::leaf_preview(&asset, 46),
            library::truncate_chars(&record.updated_at, 20)
        ));
    }
    out.push_str(
        "\n- 读正文：`read paper_id=... lines=100-160 / section=... / find=...`\n\
         - 读图：`read paper_id=... page=4 / images=3,5`\n\
         - 定位：`locate paper_id=... keyword=...`\n\
         - 详情：`info paper_id=...`；进度：`status`；续查：`query paper_id=...`\n\
         - 旧目录（paper_id 命名）可执行 `migrate` 预演、`migrate apply=true` 改为标题名\n",
    );
    let papers: Vec<Value> = records.iter().map(|r| record_json(r, false)).collect();
    Ok(CommandOutput::CardData {
        text: out,
        data: json!({
            "command": "list",
            "counts": status_counts_json(&all_records),
            "matched": matched,
            "showing": records.len(),
            "papers": papers,
        }),
    })
}

// ---------------------------------------------------------------------------
// status：一次查看多篇进度（不访问云端）
// ---------------------------------------------------------------------------

fn select_records(
    request: &Request,
    mut records: Vec<library::PaperRecord>,
) -> Result<Vec<library::PaperRecord>, AppError> {
    let mut refs: Vec<String> = request.paper_ids.clone().unwrap_or_default();
    if let Some(id) = &request.paper_id {
        refs.push(id.clone());
    }
    let all = request.all
        || refs.is_empty()
        || refs
            .iter()
            .any(|r| r.eq_ignore_ascii_case("all") || r == "*");
    if !all {
        let mut wanted = std::collections::BTreeSet::new();
        for reference in &refs {
            wanted.insert(library::resolve_paper_ref(reference)?);
        }
        records.retain(|r| wanted.contains(&r.paper_id));
    }
    Ok(records)
}

fn cmd_status(request: &Request) -> Result<CommandOutput, AppError> {
    let all_records = library::scan(true);
    if all_records.is_empty() {
        return Ok(CommandOutput::Card(format!(
            "## 📊 论文进度\n\n本地还没有论文。用 `batch file_paths=\"D:/papers\"` 批量导入，或 `parse file_path=...` 解析单篇。\n\n{}",
            library::compact_summary()
        )));
    }
    let filters = library::normalize_status_filter(request.status.as_deref())?;
    let all_total = all_records.len();
    let counts = library::counts_text(&all_records);
    let counts_json = status_counts_json(&all_records);
    let mut records = select_records(request, all_records)?;
    records.retain(|r| library::matches_status(&r.group, filters.as_deref()));
    library::sort_records(&mut records, request.sort.as_deref().unwrap_or("recent"));
    let limit = request.limit.unwrap_or(50).clamp(1, 200) as usize;
    let total = records.len();
    records.truncate(limit);

    let mut out = format!(
        "## 📊 论文进度：{}\n\n- 资产根目录：`{}`\n",
        counts,
        project_base().join("file").join("mineru").display()
    );
    if filters.is_some() || total != all_total {
        out.push_str(&format!("- 当前筛选：{} 篇\n", total));
    }
    if total > limit {
        out.push_str(&format!("- 仅显示最近 {} 篇（共 {} 篇）\n", limit, total));
    }
    out.push_str("\n| paper_id | 标题 | 状态 | 进度 | 批次 / 下一步 | 更新 |\n|---|---|---|---|---|---|\n");
    for record in &records {
        let next = if record.group == "indexed" {
            "`read` / `info`".to_string()
        } else if record.group == "failed" {
            library::truncate_chars(record.error.as_deref().unwrap_or("需重新 parse"), 40)
        } else if let Some(batch) = &record.batch_id {
            format!(
                "`query paper_id={}`（batch {}）",
                record.paper_id,
                library::truncate_chars(batch, 16)
            )
        } else {
            "需重新 parse".to_string()
        };
        out.push_str(&format!(
            "| `{}` | {} | {} | {} | {} | {} |\n",
            record.paper_id,
            library::truncate_chars(&record.title_or_id(), 42),
            record.status_text(),
            record.progress_text(),
            next,
            library::truncate_chars(&record.updated_at, 20)
        ));
    }
    out.push_str("\n- 同时续查多篇：`query paper_ids=paper_a,paper_b` 或 `query all=true`。\n");
    out.push_str("- 查看单篇详情：`info paper_id=...`。\n");
    let papers: Vec<Value> = records.iter().map(|r| record_json(r, false)).collect();
    Ok(CommandOutput::CardData {
        text: out,
        data: json!({
            "command": "status",
            "counts": counts_json,
            "matched": total,
            "showing": records.len(),
            "papers": papers,
        }),
    })
}

// ---------------------------------------------------------------------------
// info：单篇 / 多篇详情
// ---------------------------------------------------------------------------

fn cmd_info(request: &Request) -> Result<CommandOutput, AppError> {
    let mut refs: Vec<String> = request.paper_ids.clone().unwrap_or_default();
    if let Some(id) = &request.paper_id {
        refs.push(id.clone());
    }
    if refs.is_empty() {
        // 无目标时退化为论文库概览，方便 Agent 先感知再选择。
        return cmd_list(request);
    }
    if refs.len() > 5 {
        return Err(AppError::fix(
            "单次 info 最多查询 5 篇；可分批提交或用 list 概览。",
        ));
    }
    let mut ids = Vec::new();
    for reference in &refs {
        ids.push(library::resolve_paper_ref(reference)?);
    }
    ids.dedup();

    if ids.len() > 1 {
        let mut out = format!("## 📄 论文详情：{} 篇\n\n", ids.len());
        out.push_str("| paper_id | 标题 | 状态 | 资产目录 | 页数 | 图片 |\n|---|---|---|---|---|---|\n");
        let mut papers = Vec::new();
        for id in &ids {
            if let Some(record) = library::load_record(id) {
                out.push_str(&format!(
                    "| `{}` | {} | {} | {} | {} | {} |\n",
                    record.paper_id,
                    library::truncate_chars(&record.title_or_id(), 42),
                    record.status_text(),
                    library::truncate_chars(&record.asset_dir, 42),
                    record.pages.map(|p| p.to_string()).unwrap_or_else(|| "-".into()),
                    record
                        .image_count
                        .map(|p| p.to_string())
                        .unwrap_or_else(|| "-".into())
                ));
                papers.push(record_json(&record, false));
            }
        }
        out.push_str("\n逐篇大纲/图片请用 `info paper_id=...` 单独查询。\n");
        return Ok(CommandOutput::CardData {
            text: out,
            data: json!({ "command": "info", "papers": papers }),
        });
    }

    let paper_id = ids.remove(0);
    let record = library::load_record(&paper_id).ok_or_else(|| {
        AppError::fix(format!(
            "未找到论文 {}。\n{}",
            paper_id,
            library::missing_paper_hint(&paper_id)
        ))
    })?;
    let mut out = format!("## 📄 论文详情：{}\n\n", record.title_or_id());
    out.push_str(&format!("- **paper_id**：`{}`\n", record.paper_id));
    out.push_str(&format!("- **状态**：{}\n", record.status_text()));
    out.push_str(&format!(
        "- **资产目录**：`file/mineru/{}`\n",
        record.asset_dir
    ));
    if let Some(source) = &record.source_path {
        out.push_str(&format!("- **源文件**：`{}`\n", source));
    }
    if let Some(dir) = &record.source_dir {
        out.push_str(&format!("- **源目录**：`{}`\n", dir));
    }
    out.push_str(&format!("- **进度**：{}\n", record.progress_text()));
    if let Some(batch) = &record.batch_id {
        out.push_str(&format!("- **batch_id**：`{}`\n", batch));
    }
    if let Some(index) = &record.index {
        out.push_str(&format!(
            "- **规模**：{} 页 ｜ {} 字符 ｜ {} 图 ｜ {} 表 ｜ {} 公式\n",
            index.pages,
            fmt_num(index.text_chars),
            index.image_count,
            index.table_count,
            index.formula_count
        ));
        out.push_str(&format!(
            "- **md 路径**：{}（`read` 按需读取）\n",
            index.md_path
        ));
        out.push_str(&format!("- **渲染版**：{}\n", index.render_url));

        out.push_str("\n### 目录大纲（前 25 条）\n");
        if index.outline.is_empty() {
            out.push_str("（未识别到标题层级）\n");
        } else {
            for line in render_outline(&index.outline).into_iter().take(25) {
                out.push_str(&line);
                out.push('\n');
            }
            if index.outline.len() > 25 {
                out.push_str(&format!("… 其余 {} 条未展开\n", index.outline.len() - 25));
            }
        }
        out.push_str("\n### 图片（前 12 张）\n");
        if index.images.is_empty() {
            out.push_str("（无图片）\n");
        } else {
            for (i, img) in index.images.iter().take(12).enumerate() {
                let label = img
                    .caption
                    .clone()
                    .unwrap_or_else(|| format!("图片 {}", i + 1))
                    .replace('\n', " ");
                let page = img
                    .page_idx
                    .map(|p| format!("，p{}", p + 1))
                    .unwrap_or_default();
                out.push_str(&format!(
                    "- **#{}** {}{} → [查看]({})\n",
                    i + 1,
                    label,
                    page,
                    img.url
                ));
            }
            if index.images.len() > 12 {
                out.push_str(&format!(
                    "… 其余 {} 张用 `read page=N` / `images=序号` 查看\n",
                    index.images.len() - 12
                ));
            }
        }
        out.push_str("\n### 质检\n");
        if index.errors.is_empty() && index.warnings.is_empty() {
            out.push_str("- ✅ 无阻断错误，无复核项\n");
        } else {
            for e in &index.errors {
                out.push_str(&format!("- ❌ {}\n", e));
            }
            for w in &index.warnings {
                out.push_str(&format!("- ⚠️ {}\n", w));
            }
        }
        out.push_str("\n### 下一步\n- 读正文：`read` + lines/section/find\n- 读图：`read` + page=N / images=序号 / caption=关键词\n- 定位：`locate` + keyword\n");
    } else {
        out.push_str("\n尚未生成 index.json（解析未完成）。\n- 继续：`query paper_id=");
        out.push_str(&record.paper_id);
        out.push_str("`\n- 进度：`status paper_id=");
        out.push_str(&record.paper_id);
        out.push_str("`\n");
        if let Some(error) = &record.error {
            out.push_str(&format!("- 最近错误：{}\n", error));
        }
    }
    let data = record_json(&record, true);
    Ok(CommandOutput::CardData {
        text: out,
        data: json!({ "command": "info", "paper": data }),
    })
}

// ---------------------------------------------------------------------------
// migrate：把旧的 paper_xxx 资产目录改为「标题__paper_xxx」
// ---------------------------------------------------------------------------

fn cmd_migrate(request: &Request) -> Result<CommandOutput, AppError> {
    let mut records = library::scan(true);
    if records.is_empty() {
        return Ok(CommandOutput::Card(
            "## 🗂️ 资产目录整理\n\n本地还没有论文，无需整理。".to_string(),
        ));
    }
    let mut refs: Vec<String> = request.paper_ids.clone().unwrap_or_default();
    if let Some(id) = &request.paper_id {
        refs.push(id.clone());
    }
    if !refs.is_empty()
        && !refs
            .iter()
            .any(|r| r.eq_ignore_ascii_case("all") || r == "*")
    {
        let mut wanted = std::collections::BTreeSet::new();
        for reference in &refs {
            wanted.insert(library::resolve_paper_ref(reference)?);
        }
        records.retain(|r| wanted.contains(&r.paper_id));
    }
    records.sort_by(|a, b| a.title_or_id().cmp(&b.title_or_id()));
    records.truncate(library::MIGRATE_MAX);

    let apply = request.apply;
    let urls = UrlContext::from_env();
    let file_root = project_base().join("file").join("mineru");
    let image_root = project_base().join("image").join("mineru");
    let mut rows = String::new();
    let mut planned = 0usize;
    let mut applied = 0usize;
    let mut skipped = 0usize;
    let mut failed = 0usize;

    for record in &records {
        if !record.has_index {
            skipped += 1;
            rows.push_str(&format!(
                "| `{}` | {} | 未完成，暂不改名 | - |\n",
                record.paper_id,
                library::truncate_chars(&record.title_or_id(), 40)
            ));
            continue;
        }
        let old_dir = file_dir_of(&record.paper_id);
        let old_leaf = library::asset_dir_name(&old_dir);
        if old_leaf.ends_with(&format!("__{}", record.paper_id)) {
            skipped += 1;
            rows.push_str(&format!(
                "| `{}` | {} | 已是标题目录 | `{}` |\n",
                record.paper_id,
                library::truncate_chars(&record.title_or_id(), 40),
                old_leaf
            ));
            continue;
        }
        let mut chosen: Option<String> = None;
        for version in 1..=50 {
            let leaf = library::versioned_leaf(&record.title_or_id(), &record.paper_id, version);
            let new_dir = file_root.join(&leaf);
            if new_dir == old_dir || !new_dir.exists() {
                chosen = Some(leaf);
                break;
            }
        }
        let Some(new_leaf) = chosen else {
            failed += 1;
            rows.push_str(&format!(
                "| `{}` | {} | ❌ 同名目录过多 | - |\n",
                record.paper_id,
                library::truncate_chars(&record.title_or_id(), 40)
            ));
            continue;
        };
        planned += 1;
        if !apply {
            rows.push_str(&format!(
                "| `{}` | {} | 预演 | `{}` → `{}` |\n",
                record.paper_id,
                library::truncate_chars(&record.title_or_id(), 40),
                old_leaf,
                new_leaf
            ));
            continue;
        }

        let new_dir = file_root.join(&new_leaf);
        if new_dir != old_dir {
            if let Err(e) = fs::rename(&old_dir, &new_dir) {
                failed += 1;
                rows.push_str(&format!(
                    "| `{}` | {} | ❌ 改名失败：{} | - |\n",
                    record.paper_id,
                    library::truncate_chars(&record.title_or_id(), 40),
                    library::truncate_chars(&e.to_string(), 60)
                ));
                continue;
            }
            let old_image = image_root.join(&old_leaf);
            let new_image = image_root.join(&new_leaf);
            if old_image.is_dir() && old_image != new_image {
                if let Err(e) = fs::rename(&old_image, &new_image) {
                    let _ = fs::rename(&new_dir, &old_dir);
                    failed += 1;
                    rows.push_str(&format!(
                        "| `{}` | {} | ❌ 图片目录改名失败，已回滚：{} | - |\n",
                        record.paper_id,
                        library::truncate_chars(&record.title_or_id(), 40),
                        library::truncate_chars(&e.to_string(), 50)
                    ));
                    continue;
                }
            }
        }

        // 更新 index.json 中的路径与 URL（优先原地替换，保留原有 pw key）
        let old_seg = format!("/mineru/{}/", assets::percent_encode_path(&old_leaf));
        let new_seg = format!("/mineru/{}/", assets::percent_encode_path(&new_leaf));
        if let Some(mut index) = state::load_index(&new_dir) {
            index.asset_dir = Some(new_leaf.clone());
            index.md_path = file_url_of(&new_dir.join("full.md"));
            index.render_url = if index.render_url.contains(&old_seg) {
                index.render_url.replace(&old_seg, &new_seg)
            } else {
                urls.file_url(&new_leaf, "full.render.md")
            };
            for image in &mut index.images {
                image.url = if image.url.contains(&old_seg) {
                    image.url.replace(&old_seg, &new_seg)
                } else {
                    urls.image_url(&new_leaf, &image.rel)
                };
            }
            let _ = state::save_index(&new_dir, &index);
        }
        // 渲染副本中的图片 URL 同步替换
        let render_path = new_dir.join("full.render.md");
        if let Ok(text) = fs::read_to_string(&render_path) {
            if text.contains(&old_seg) {
                let _ = fs::write(&render_path, text.replace(&old_seg, &new_seg));
            }
        }
        if let Some(mut st) = state::load_state(&new_dir) {
            st.asset_dir = Some(new_leaf.clone());
            let _ = state::save_state(&new_dir, &mut st);
        }
        applied += 1;
        rows.push_str(&format!(
            "| `{}` | {} | ✅ 已改名 | `{}` → `{}` |\n",
            record.paper_id,
            library::truncate_chars(&record.title_or_id(), 40),
            old_leaf,
            new_leaf
        ));
    }

    let mut out = format!(
        "## 🗂️ 资产目录整理：{}（{} ｜ ✅ 已改名 {} ｜ 预演 {} ｜ 跳过 {} ｜ ❌ {}）\n\n",
        if apply { "已执行" } else { "预演，未改动磁盘" },
        library::counts_text(&records),
        applied,
        if apply { 0 } else { planned },
        skipped,
        failed
    );
    out.push_str("| paper_id | 标题 | 结果 | 目录 |\n|---|---|---|---|\n");
    out.push_str(&rows);
    if !apply {
        out.push_str("\n以上仅为预演。确认无误后加 `apply=true` 实际改名；改完 `list` 会显示新的标题目录。\n");
    } else {
        out.push_str("\n目录已改为「标题__paper_id」，`list` / `info` / `read` 均已兼容新旧命名。\n");
    }
    Ok(CommandOutput::Card(out))
}

// ---------------------------------------------------------------------------
// 卡片渲染（零污染上下文：不含正文任何段落）
// ---------------------------------------------------------------------------

fn render_timeout(
    paper_id: &str,
    batch_id: &str,
    chunk_desc: &str,
    waited_secs: u64,
    progress: Option<&state::ProgressInfo>,
) -> CommandOutput {
    let progress_text = progress
        .map(|p| format!("（进度 {} / {} 页）", p.extracted_pages, p.total_pages))
        .unwrap_or_default();
    let chunk_text = if chunk_desc.is_empty() {
        String::new()
    } else {
        format!("（{}）", chunk_desc)
    };
    CommandOutput::Timeout {
        text: format!(
            "⏳ 解析仍在进行（已等待 {} 秒）{}{}。\n\n- **paper_id**：{}\n- **batch_id**：{}\n\n云端仍在处理，请稍后用 `query paper_id={}`（或 `query batch_id={}`）续查；多篇可一次 `query paper_ids=...` 或 `query all=true`。",
            waited_secs, progress_text, chunk_text, paper_id, batch_id, paper_id, batch_id
        ),
        data: json!({
            "paper_id": paper_id,
            "batch_id": batch_id,
            "state": "running",
            "hint": "请使用 query 命令续查（paper_id 或 batch_id 均可）"
        }),
    }
}

fn render_card(index: &IndexDoc, cached: bool) -> String {
    let mut out = String::new();
    out.push_str(&format!("## 📄 论文解析完成：{}\n\n", index.title));
    if cached {
        out.push_str("（缓存命中：此前已解析完成，本次未消耗 API 配额）\n\n");
    }
    out.push_str(&format!("- **paper_id**：{}\n", index.paper_id));
    let asset_dir = index
        .asset_dir
        .clone()
        .unwrap_or_else(|| index.paper_id.clone());
    out.push_str(&format!("- **资产目录**：`file/mineru/{}`\n", asset_dir));
    if let Some(source) = &index.source_path {
        out.push_str(&format!("- **源文件**：`{}`\n", source));
    }
    out.push_str(&format!(
        "- **页数**：{} 页 ｜ **正文字符数**：{}\n",
        index.pages,
        fmt_num(index.text_chars)
    ));
    out.push_str(&format!(
        "- **图片**：{} 张 ｜ **表格**：{} 个 ｜ **公式**：{} 处\n",
        index.image_count, index.table_count, index.formula_count
    ));
    out.push_str(&format!(
        "- **md 路径**：{}（read 命令按需读取；也可 UrlFetch 本地直读）\n",
        index.md_path
    ));
    out.push_str(&format!("- **渲染版**：{}\n", index.render_url));

    out.push_str("\n### 目录大纲\n");
    if index.outline.is_empty() {
        out.push_str("（未识别到标题层级）\n");
    } else {
        for line in render_outline(&index.outline) {
            out.push_str(&line);
            out.push('\n');
        }
    }

    out.push_str("\n### 图片清单\n");
    if index.images.is_empty() {
        out.push_str("（无图片）\n");
    } else {
        let total = index.images.len();
        let shown = total.min(CARD_IMAGE_PREVIEW_LIMIT);
        for (i, img) in index.images.iter().take(shown).enumerate() {
            let label = img
                .caption
                .clone()
                .map(|c| c.replace('\n', " "))
                .filter(|c| !c.trim().is_empty())
                .unwrap_or_else(|| format!("图片 {}", i + 1));
            let page = img
                .page_idx
                .map(|p| format!("，p{}", p + 1))
                .unwrap_or_default();
            out.push_str(&format!(
                "- **#{}** {}{} → [查看]({})\n",
                i + 1,
                label,
                page,
                img.url
            ));
        }
        if total > shown {
            out.push_str(&format!(
                "- … 其余 {} 张未展开；用 `read` 命令按 `page=N` / `images=序号` / `caption=关键词` 读取\n",
                total - shown
            ));
        }
    }

    out.push_str("\n### 质检报告\n");
    if index.errors.is_empty() && index.warnings.is_empty() {
        out.push_str("- ✅ 无阻断错误，无复核项\n");
    } else {
        for e in &index.errors {
            out.push_str(&format!("- ❌ {}\n", e));
        }
        for w in &index.warnings {
            out.push_str(&format!("- ⚠️ {}\n", w));
        }
    }

    out.push_str("\n### 使用提示\n");
    out.push_str(&format!(
        "- 读正文：`read` 命令（paper_id + lines=\"100-160\" / section=\"3.2 Experimental Setup\" / find=\"关键词\"），也可 UrlFetch(\"{}\")\n",
        index.md_path
    ));
    out.push_str("- 读图片：`read` + `page=4` / `images=3,5` / `caption=\"Figure 2\"`，图片以 base64 image_url 直接返回\n");
    out.push_str("- 渲染图片：也可直接使用上方图片清单中的 HTTP URL\n");
    out.push_str("- 定位章节：结合目录大纲与 content_list.json 块顺序\n");
    out.push_str("- 关键词定位：locate 命令（paper_id + keyword）秒级返回段落位置，再用 read 读上下文\n");
    out
}

/// 层级编号大纲：`2.1 Experimental Setup … p4`。
fn render_outline(outline: &[protocol::OutlineNode]) -> Vec<String> {
    let mut lines = Vec::new();
    let mut counters: Vec<u32> = Vec::new();
    for node in outline {
        let level = node.level.max(1) as usize;
        while counters.len() < level {
            counters.push(0);
        }
        counters[level - 1] += 1;
        counters.truncate(level);
        // 仅展示时把未出现过的前导层级显示为 1，计数器本身保持标准层级
        let number = counters
            .iter()
            .map(|c| if *c == 0 { "1".to_string() } else { c.to_string() })
            .collect::<Vec<_>>()
            .join(".");
        let indent = "  ".repeat(level.saturating_sub(1));
        lines.push(format!(
            "{}{} {} — p{}",
            indent,
            number,
            node.text,
            node.page_idx + 1
        ));
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paper_id_prefix() {
        let hex = "a1b2c3d4e5f6071899999999";
        assert_eq!(paper_id_from_hex(hex), "paper_a1b2c3d4e5f60718");
    }

    #[test]
    fn sha256_known_vector() {
        let dir = std::env::temp_dir().join(format!("mineruparser_sha_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("abc.txt");
        fs::write(&p, b"abc").unwrap();
        assert_eq!(
            sha256_file(&p).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fmt_thousands() {
        assert_eq!(fmt_num(0), "0");
        assert_eq!(fmt_num(999), "999");
        assert_eq!(fmt_num(1000), "1,000");
        assert_eq!(fmt_num(28430), "28,430");
        assert_eq!(fmt_num(1234567), "1,234,567");
    }

    #[test]
    fn outline_numbering() {
        let nodes = vec![
            protocol::OutlineNode { level: 1, text: "Intro".into(), page_idx: 0 },
            protocol::OutlineNode { level: 2, text: "Sub".into(), page_idx: 1 },
            protocol::OutlineNode { level: 3, text: "Deep".into(), page_idx: 2 },
            protocol::OutlineNode { level: 2, text: "Sub2".into(), page_idx: 3 },
            protocol::OutlineNode { level: 1, text: "Methods".into(), page_idx: 4 },
        ];
        let lines = render_outline(&nodes);
        assert_eq!(lines[0], "1 Intro — p1");
        assert_eq!(lines[1], "  1.1 Sub — p2");
        assert_eq!(lines[2], "    1.1.1 Deep — p3");
        assert_eq!(lines[3], "  1.2 Sub2 — p4");
        assert_eq!(lines[4], "2 Methods — p5");
    }

    #[test]
    fn outline_numbering_starts_at_one() {
        let nodes = vec![
            protocol::OutlineNode { level: 2, text: "A".into(), page_idx: 0 },
            protocol::OutlineNode { level: 2, text: "B".into(), page_idx: 1 },
            protocol::OutlineNode { level: 1, text: "C".into(), page_idx: 2 },
            protocol::OutlineNode { level: 2, text: "D".into(), page_idx: 3 },
        ];
        let lines = render_outline(&nodes);
        assert_eq!(lines[0], "  1.1 A — p1");
        assert_eq!(lines[1], "  1.2 B — p2");
        assert_eq!(lines[2], "1 C — p3");
        assert_eq!(lines[3], "  1.1 D — p4");
    }

    #[test]
    fn finalize_names_asset_dir_after_title() {
        let base = std::env::temp_dir().join(format!(
            "mineruparser_finalize_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        let old_dir = base.join("file/mineru/paper_0123456789abcdef");
        let work = old_dir.join(".work");
        fs::create_dir_all(work.join("images")).unwrap();
        fs::write(work.join("full.md"), "# Demo Paper\n\n![fig](images/a.jpg)\n\nBody\n").unwrap();
        fs::write(
            work.join("full_content_list.json"),
            r#"[{"type":"text","text":"Demo Paper","text_level":1,"page_idx":0},{"type":"image","img_path":"images/a.jpg","image_caption":["Figure 1"],"page_idx":0}]"#,
        )
        .unwrap();
        fs::write(work.join("images/a.jpg"), b"jpg").unwrap();

        let mut st = PersistentState::new("paper_0123456789abcdef", "demo.pdf");
        st.state = state::STATE_RUNNING.to_string();
        st.source_path = Some("D:/papers/demo.pdf".to_string());
        state::save_state(&old_dir, &mut st).unwrap();

        let specs = vec![(work, 0u64, 0u64)];
        let index =
            finalize_in(&base, &mut st, &old_dir, &specs).expect("finalize should succeed");
        assert_eq!(index.title, "Demo Paper");
        assert_eq!(
            index.asset_dir.as_deref(),
            Some("Demo Paper__paper_0123456789abcdef")
        );
        assert!(!old_dir.exists());
        let new_dir = base.join("file/mineru/Demo Paper__paper_0123456789abcdef");
        assert!(new_dir.join("full.md").is_file());
        assert!(new_dir.join("index.json").is_file());
        assert!(new_dir.join("state.json").is_file());
        assert!(base
            .join("image/mineru/Demo Paper__paper_0123456789abcdef/images/a.jpg")
            .is_file());
        assert!(index
            .images
            .first()
            .unwrap()
            .url
            .contains("/images/mineru/Demo%20Paper__paper_0123456789abcdef/"));
        assert!(base
            .join("file/mineru/Demo Paper__paper_0123456789abcdef/full.render.md")
            .is_file());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn concurrent_runner_preserves_order() {
        let items: Vec<usize> = (0..12).collect();
        let out = run_concurrent(&items, 3, |n| n * 2);
        assert_eq!(out, items.iter().map(|n| n * 2).collect::<Vec<_>>());
    }

    #[test]
    fn relocate_renames_file_and_image_dirs() {
        let base = std::env::temp_dir().join(format!(
            "mineruparser_relocate_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        let old_file = base.join("file/mineru/paper_0123456789abcdef");
        let old_image = base.join("image/mineru/paper_0123456789abcdef");
        fs::create_dir_all(old_file.join(".work")).unwrap();
        fs::create_dir_all(old_image.join("images")).unwrap();
        let moved = relocate_for_finalize_in(
            &base,
            "paper_0123456789abcdef",
            &old_file,
            "Demo Paper: A/B",
        );
        assert_eq!(moved.leaf, "Demo Paper A B__paper_0123456789abcdef");
        assert!(moved.file_dir.join(".work").is_dir());
        assert!(!old_file.exists());
        assert!(base
            .join("image/mineru/Demo Paper A B__paper_0123456789abcdef/images")
            .is_dir());
        assert!(!old_image.exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn expand_sources_walks_directories() {
        let base = std::env::temp_dir().join(format!(
            "mineruparser_expand_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("sub")).unwrap();
        fs::write(base.join("one.pdf"), b"x").unwrap();
        fs::write(base.join("sub/two.PDF"), b"x").unwrap();
        fs::write(base.join("sub/three.txt"), b"x").unwrap();
        let request: Request =
            serde_json::from_str(r#"{"command":"batch","recursive":"true"}"#).unwrap();
        let sources = expand_sources(&request, &[base.to_string_lossy().to_string()]).unwrap();
        assert_eq!(sources.len(), 2);
        assert!(sources.iter().any(|s| s.ends_with("one.pdf")));
        assert!(sources.iter().any(|s| s.ends_with("two.PDF")));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn card_caps_image_list_and_numbers() {
        let images = (0..50)
            .map(|i| protocol::ImageEntry {
                rel: format!("images/{}.jpg", i),
                url: format!("http://localhost/pw=K/images/{}.jpg", i),
                caption: None,
                page_idx: Some(i),
            })
            .collect();
        let index = IndexDoc {
            paper_id: "paper_x".into(),
            title: "Test Paper".into(),
            file_name: "t.pdf".into(),
            pages: 50,
            md_path: "file:///D:/vcp/file/mineru/paper_x/full.md".into(),
            render_url: "http://localhost/pw=F/files/mineru/paper_x/full.render.md".into(),
            images,
            ..Default::default()
        };
        let card = render_card(&index, false);
        assert!(card.contains("**#1** 图片 1"), "{}", card);
        assert!(card.contains("**#40** 图片 40"), "{}", card);
        assert!(!card.contains("**#41**"), "{}", card);
        assert!(card.contains("其余 10 张未展开"));
        assert!(card.contains("read"));
    }

    #[test]
    fn card_contains_no_body() {
        let index = IndexDoc {
            paper_id: "paper_x".into(),
            title: "Test Paper".into(),
            file_name: "t.pdf".into(),
            pages: 3,
            text_chars: 42,
            image_count: 1,
            table_count: 0,
            formula_count: 0,
            md_path: "file:///D:/vcp/file/mineru/paper_x/full.md".into(),
            render_url: "http://localhost:6005/pw=F/files/mineru/paper_x/full.render.md".into(),
            outline: vec![protocol::OutlineNode { level: 1, text: "Intro".into(), page_idx: 0 }],
            images: vec![],
            errors: vec![],
            warnings: vec!["1 项复核".into()],
            created_at: "2026-10-21T00:00:00Z".into(),
            ..Default::default()
        };
        let card = render_card(&index, false);
        assert!(card.contains("Test Paper"));
        assert!(card.contains("paper_x"));
        assert!(card.contains("1 Intro — p1"));
        assert!(card.contains("⚠️ 1 项复核"));
        assert!(card.contains("UrlFetch"));
        assert!(!card.contains("正文段落"));
    }
}
