//! 去重：解析前预检（preflight）与全库重复检索（duplicates）。
//!
//! 判重依据：
//! - 内容指纹：PDF 的 SHA-256，与 paper_id 完全一致，同内容不同文件名也会命中；
//! - 正文指纹：full.md 归一化空白/大小写后的 SHA-256；
//! - 标题指纹：标题只保留字母数字并转小写；
//! - 资产重复：同一个 paper_id 存在多份资产目录（旧目录 + 标题化目录）；
//! - 源文件重复：同一 source_path 对应了不同 paper_id（源文件被替换后重新解析）。
//!
//! 两个命令都只读：不删除、不改名、不移动任何文件。

use crate::error::AppError;
use crate::library::{self, PaperRecord};
use crate::protocol::Request;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

/// preflight 单次最多检查的文件数（比 batch 的 20 宽松，仍防止误选整个磁盘）。
const MAX_PREFLIGHT_FILES: usize = 500;
/// preflight 文本卡片最多展开的行数；结构化 data 不受此限。
const PREFLIGHT_TEXT_ROWS: usize = 100;
/// 全局查重单次最多返回的分组数。
const MAX_DUPLICATE_GROUPS: usize = 200;
/// 正文指纹读取上限（full.md 通常远小于此值）。
const MAX_TEXT_BYTES: u64 = 8 * 1024 * 1024;
/// 单文件大小上限，与 parse 保持一致。
const MAX_FILE_SIZE: u64 = 200 * 1024 * 1024;
/// 标题指纹至少需要的字母数字字符数（避免 “Introduction” 之类的通用标题误报）。
const MIN_TITLE_KEY_CHARS: usize = 12;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GroupKind {
    Asset,
    Text,
    Title,
    Source,
}

impl GroupKind {
    fn as_str(self) -> &'static str {
        match self {
            GroupKind::Asset => "asset",
            GroupKind::Text => "text",
            GroupKind::Title => "title",
            GroupKind::Source => "source",
        }
    }

    fn label(self) -> &'static str {
        match self {
            GroupKind::Asset => "资产目录重复",
            GroupKind::Text => "正文相同",
            GroupKind::Title => "标题相同",
            GroupKind::Source => "同一源文件",
        }
    }
}

fn parse_group_by(raw: Option<&str>) -> Result<Vec<GroupKind>, AppError> {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(vec![
            GroupKind::Asset,
            GroupKind::Text,
            GroupKind::Title,
            GroupKind::Source,
        ]);
    };
    let mut out = Vec::new();
    for part in raw.split(|c| c == ',' || c == ';' || c == ' ' || c == '+') {
        let token = part.trim().to_lowercase();
        if token.is_empty() {
            continue;
        }
        let kind = match token.as_str() {
            "all" | "*" => {
                return Ok(vec![
                    GroupKind::Asset,
                    GroupKind::Text,
                    GroupKind::Title,
                    GroupKind::Source,
                ])
            }
            "asset" | "dir" | "paper_id" | "paperid" => GroupKind::Asset,
            "text" | "content" | "md" => GroupKind::Text,
            "title" | "name" => GroupKind::Title,
            "source" | "path" | "src" => GroupKind::Source,
            other => {
                return Err(AppError::fix(format!(
                    "group_by 仅支持 all / asset / text / title / source，收到: {}",
                    other
                )))
            }
        };
        if !out.contains(&kind) {
            out.push(kind);
        }
    }
    if out.is_empty() {
        out = vec![
            GroupKind::Asset,
            GroupKind::Text,
            GroupKind::Title,
            GroupKind::Source,
        ];
    }
    Ok(out)
}

fn is_url(source: &str) -> bool {
    source.starts_with("http://") || source.starts_with("https://")
}

fn sha256_text(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    hex::encode(hasher.finalize())
}

fn paper_id_from_hex(hex: &str) -> String {
    format!("paper_{}", &hex[..16])
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("document.pdf")
        .to_string()
}

fn url_file_name(url: &str) -> String {
    url.rsplit('/')
        .next()
        .map(|s| s.split('?').next().unwrap_or(s))
        .filter(|s| !s.is_empty())
        .unwrap_or("url.pdf")
        .to_string()
}

fn fmt_bytes(bytes: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / MB)
    } else if bytes >= 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{} B", bytes)
    }
}

/// 归一化正文：CRLF 统一为 LF，连续空白折叠成一个空格，转小写。
fn normalize_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pending_space = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        for lower in ch.to_lowercase() {
            out.push(lower);
        }
    }
    out
}

/// 标题归一化：只保留字母数字并转小写。
fn normalize_title(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    for ch in title.chars() {
        if ch.is_alphanumeric() {
            for lower in ch.to_lowercase() {
                out.push(lower);
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// preflight：解析前查重
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct SourceItem {
    path: String,
    file_name: String,
    size: u64,
    sha256: String,
    paper_id: String,
    is_url: bool,
}

#[derive(Default)]
struct ExpandOutcome {
    sources: Vec<String>,
    truncated: bool,
    invalid: Vec<(String, String)>,
}

fn expand_for_preflight(
    base: &Path,
    request: &Request,
    raw: &[String],
) -> Result<ExpandOutcome, AppError> {
    let _ = base;
    let mut outcome = ExpandOutcome::default();
    let mut seen = BTreeSet::new();
    for item in raw {
        let item = item.trim();
        if item.is_empty() {
            continue;
        }
        if is_url(item) {
            if seen.insert(item.to_lowercase()) {
                outcome.sources.push(item.to_string());
            }
            continue;
        }
        let path = Path::new(item);
        if path.is_dir() {
            let remaining = MAX_PREFLIGHT_FILES.saturating_sub(outcome.sources.len());
            let (pdfs, cut) = library::collect_pdfs(path, request.recursive, remaining)?;
            outcome.truncated = outcome.truncated || cut;
            for pdf in pdfs {
                let text = pdf.to_string_lossy().to_string();
                if seen.insert(text.to_lowercase()) {
                    outcome.sources.push(text);
                }
            }
        } else if path.is_file() {
            if seen.insert(item.to_lowercase()) {
                outcome.sources.push(item.to_string());
            }
        } else {
            outcome
                .invalid
                .push((item.to_string(), "文件或目录不存在".to_string()));
        }
        if outcome.sources.len() >= MAX_PREFLIGHT_FILES {
            outcome.truncated = true;
            break;
        }
    }
    Ok(outcome)
}

fn existing_record_map(records: &[PaperRecord]) -> BTreeMap<String, PaperRecord> {
    let mut map: BTreeMap<String, PaperRecord> = BTreeMap::new();
    for record in records {
        let replace = map
            .get(&record.paper_id)
            .map(|current| prefer_record(record, current))
            .unwrap_or(true);
        if replace {
            map.insert(record.paper_id.clone(), record.clone());
        }
    }
    map
}

fn record_summary(record: &PaperRecord) -> Value {
    json!({
        "paper_id": record.paper_id.as_str(),
        "title": record.title_or_id(),
        "status": record.group.as_str(),
        "asset_dir": record.asset_dir.as_str(),
        "pages": record.pages,
        "image_count": record.image_count,
        "updated_at": record.updated_at.as_str(),
    })
}

fn preflight_status(existing: Option<&PaperRecord>) -> &'static str {
    match existing.map(|r| r.group.as_str()) {
        Some("indexed") => "indexed",
        Some("running") => "running",
        Some("timeout") => "timeout",
        Some("failed") => "failed",
        Some(_) => "unknown",
        None => "new",
    }
}

fn preflight_in(base: &Path, request: &Request) -> Result<(Value, String), AppError> {
    let mut raw: Vec<String> = request.file_paths.clone().unwrap_or_default();
    if let Some(path) = &request.paths {
        raw.extend(path.clone());
    }
    if let Some(path) = &request.file_path {
        raw.push(path.clone());
    }
    if let Some(url) = &request.url {
        raw.push(url.clone());
    }
    if let Some(urls) = &request.urls {
        raw.extend(urls.clone());
    }
    if raw.is_empty() {
        return Err(AppError::fix(
            "preflight 缺少输入：请提供 file_path / file_paths（文件或文件夹，递归展开 PDF）或 url / urls。",
        ));
    }

    let expanded = expand_for_preflight(base, request, &raw)?;
    let library_records = library::scan_in(base, false);
    let existing = existing_record_map(&library_records);

    let mut items: Vec<Value> = Vec::new();
    let mut source_items: Vec<SourceItem> = Vec::new();
    let mut errors: Vec<(String, String)> = expanded.invalid;

    for source in &expanded.sources {
        if is_url(source) {
            let paper_id = paper_id_from_hex(&sha256_text(source));
            source_items.push(SourceItem {
                path: source.clone(),
                file_name: url_file_name(source),
                size: 0,
                sha256: sha256_text(source),
                paper_id,
                is_url: true,
            });
            continue;
        }
        let path = Path::new(source);
        let meta = match fs::metadata(path) {
            Ok(meta) => meta,
            Err(e) => {
                errors.push((source.clone(), format!("无法访问: {}", e)));
                continue;
            }
        };
        if !meta.is_file() {
            errors.push((source.clone(), "不是普通文件".to_string()));
            continue;
        }
        if !path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("pdf"))
            .unwrap_or(false)
        {
            errors.push((source.clone(), "不是 PDF 文件".to_string()));
            continue;
        }
        if meta.len() > MAX_FILE_SIZE {
            errors.push((
                source.clone(),
                format!("{}，超过 200MB 上限", fmt_bytes(meta.len())),
            ));
            continue;
        }
        let sha = match crate::sha256_file(path) {
            Ok(sha) => sha,
            Err(e) => {
                errors.push((source.clone(), e.message().to_string()));
                continue;
            }
        };
        source_items.push(SourceItem {
            path: source.clone(),
            file_name: file_name_of(path),
            size: meta.len(),
            paper_id: paper_id_from_hex(&sha),
            sha256: sha,
            is_url: false,
        });
    }

    // 本次选择内的内容重复：同一 paper_id 的第一项保留，后续标记 duplicate_of。
    let mut first_by_paper: BTreeMap<String, String> = BTreeMap::new();
    for item in &source_items {
        first_by_paper
            .entry(item.paper_id.clone())
            .or_insert_with(|| item.path.clone());
    }
    // 同名文件（不含扩展名）仅提示，不当作内容重复。
    let mut first_by_name: BTreeMap<String, String> = BTreeMap::new();
    for item in &source_items {
        let stem = Path::new(&item.file_name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&item.file_name)
            .to_lowercase();
        first_by_name
            .entry(stem)
            .or_insert_with(|| item.path.clone());
    }

    for item in &source_items {
        let record = existing.get(&item.paper_id);
        let status = preflight_status(record);
        let first_path = first_by_paper.get(&item.paper_id).cloned().unwrap_or_default();
        let duplicate_in_selection = first_path != item.path;
        let name_stem = Path::new(&item.file_name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&item.file_name)
            .to_lowercase();
        let name_duplicate_of = first_by_name
            .get(&name_stem)
            .filter(|first| **first != item.path)
            .cloned();
        items.push(json!({
            "path": item.path.as_str(),
            "file_name": item.file_name.as_str(),
            "size": item.size,
            "size_text": fmt_bytes(item.size),
            "sha256": item.sha256.as_str(),
            "paper_id": item.paper_id.as_str(),
            "is_url": item.is_url,
            "status": status,
            "duplicate_in_selection": duplicate_in_selection,
            "duplicate_of": duplicate_in_selection.then_some(first_path),
            "name_duplicate_of": name_duplicate_of,
            "existing": record.map(record_summary),
        }));
    }
    for (path, error) in &errors {
        items.push(json!({
            "path": path.as_str(),
            "file_name": Path::new(path).file_name().and_then(|n| n.to_str()).unwrap_or(path),
            "size": 0,
            "size_text": "-",
            "sha256": null,
            "paper_id": null,
            "status": "invalid",
            "error": error.as_str(),
        }));
    }

    let count_status = |status: &str| {
        items
            .iter()
            .filter(|item| item["status"].as_str() == Some(status))
            .count()
    };
    let duplicate_count = items
        .iter()
        .filter(|item| item["duplicate_in_selection"].as_bool().unwrap_or(false))
        .count();
    let indexed_count = count_status("indexed");
    let running_count = count_status("running");
    let timeout_count = count_status("timeout");
    let failed_count = count_status("failed");
    let unknown_count = count_status("unknown");
    let invalid_count = count_status("invalid");
    let new_count = items
        .iter()
        .filter(|item| {
            item["status"].as_str() == Some("new")
                && !item["duplicate_in_selection"].as_bool().unwrap_or(false)
        })
        .count();

    let mut text = format!(
        "## 🔍 解析前查重：{} 个输入\n\n",
        items.len()
    );
    text.push_str(&format!(
        "- 🆕 新文件 **{}** ｜ ♻️ 已解析 **{}** ｜ ⏳ 进行中 **{}** ｜ ⏱️ 待续查 **{}** ｜ ❌ 失败 **{}** ｜ 🔁 本次重复 **{}** ｜ ⚠️ 无效 **{}**\n",
        new_count,
        indexed_count,
        running_count,
        timeout_count,
        failed_count,
        duplicate_count,
        invalid_count
    ));
    text.push_str("- 判重依据：PDF 内容 SHA-256（与 paper_id 一致），同内容不同文件名也会命中。\n");
    if unknown_count > 0 {
        text.push_str(&format!("- ❔ 状态未知：**{}**\n", unknown_count));
    }
    if expanded.truncated {
        text.push_str(&format!(
            "- ⚠️ 文件数超过单次 {} 个上限，只检查了前 {} 个；请拆分目录后重试。\n",
            MAX_PREFLIGHT_FILES,
            expanded.sources.len()
        ));
    }
    text.push_str("\n| 文件 | 大小 | 状态 | paper_id | 说明 |\n|---|---|---|---|---|\n");
    for item in items.iter().take(PREFLIGHT_TEXT_ROWS) {
        let status = item["status"].as_str().unwrap_or("");
        let badge = match status {
            "new" => "🆕 新文件",
            "indexed" => "♻️ 已解析",
            "running" => "⏳ 进行中",
            "timeout" => "⏱️ 待续查",
            "failed" => "❌ 失败",
            "invalid" => "⚠️ 无效",
            _ => "❔ 未知",
        };
        let mut note = String::new();
        if item["duplicate_in_selection"].as_bool().unwrap_or(false) {
            note.push_str("本次重复；");
        }
        if let Some(name_dup) = item["name_duplicate_of"].as_str() {
            note.push_str(&format!("同名文件 `{}`；", library::truncate_chars(name_dup, 40)));
        }
        if let Some(existing) = item["existing"].as_object() {
            if let Some(title) = existing.get("title").and_then(Value::as_str) {
                note.push_str(&format!("已有：{}", library::truncate_chars(title, 40)));
            }
        }
        if status == "invalid" {
            note = item["error"].as_str().unwrap_or("无效").to_string();
        }
        text.push_str(&format!(
            "| `{}` | {} | {} | {} | {} |\n",
            library::truncate_chars(item["path"].as_str().unwrap_or(""), 52),
            item["size_text"].as_str().unwrap_or("-"),
            badge,
            item["paper_id"].as_str().unwrap_or("-"),
            note.trim_end_matches('；')
        ));
    }
    if items.len() > PREFLIGHT_TEXT_ROWS {
        text.push_str(&format!(
            "\n… 其余 {} 项未在文本中展开，完整结果见结构化 data。\n",
            items.len() - PREFLIGHT_TEXT_ROWS
        ));
    }
    text.push_str(
        "\n下一步：用 `parse` / `batch` 仅解析“新文件”；已解析项可直接 `read` / `info`；本次重复项无需重复提交。\n",
    );

    let data = json!({
        "command": "preflight",
        "counts": {
            "total": items.len(),
            "new": new_count,
            "indexed": indexed_count,
            "running": running_count,
            "timeout": timeout_count,
            "failed": failed_count,
            "unknown": unknown_count,
            "invalid": invalid_count,
            "duplicate": duplicate_count,
            "existing": indexed_count + running_count + timeout_count + failed_count + unknown_count,
        },
        "truncated": expanded.truncated,
        "items": items,
    });
    Ok((data, text))
}

pub fn cmd_preflight(request: &Request) -> Result<crate::CommandOutput, AppError> {
    let (data, text) = preflight_in(&crate::project_base(), request)?;
    Ok(crate::CommandOutput::CardData { text, data })
}

// ---------------------------------------------------------------------------
// duplicates：全库重复检索
// ---------------------------------------------------------------------------

fn prefer_record(a: &PaperRecord, b: &PaperRecord) -> bool {
    // true 表示 a 更适合作为保留项
    match (a.has_index, b.has_index) {
        (true, false) => return true,
        (false, true) => return false,
        _ => {}
    }
    if a.legacy_dir != b.legacy_dir {
        return !a.legacy_dir;
    }
    match b.updated_at.cmp(&a.updated_at) {
        Ordering::Equal => {
            let a_chars = a.text_chars.unwrap_or(0);
            let b_chars = b.text_chars.unwrap_or(0);
            a_chars >= b_chars
        }
        Ordering::Greater => false,
        _ => true,
    }
}

fn sort_members(members: &mut [PaperRecord]) {
    members.sort_by(|a, b| {
        if prefer_record(a, b) {
            Ordering::Less
        } else if prefer_record(b, a) {
            Ordering::Greater
        } else {
            a.asset_dir.cmp(&b.asset_dir)
        }
    });
}

fn dir_of(base: &Path, record: &PaperRecord) -> PathBuf {
    base.join("file").join("mineru").join(&record.asset_dir)
}

fn source_zip_bytes(base: &Path, record: &PaperRecord) -> u64 {
    let dir = dir_of(base, record);
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .to_lowercase()
                .starts_with("source")
        })
        .filter_map(|entry| entry.metadata().ok())
        .filter(|meta| meta.is_file() && meta.len() > 0)
        .map(|meta| meta.len())
        .sum()
}

fn text_fingerprint(base: &Path, record: &PaperRecord) -> Option<String> {
    if !record.has_index {
        return None;
    }
    let path = dir_of(base, record).join("full.md");
    let meta = fs::metadata(&path).ok()?;
    if meta.len() == 0 || meta.len() > MAX_TEXT_BYTES {
        return None;
    }
    let text = fs::read_to_string(path).ok()?;
    let normalized = normalize_text(&text);
    if normalized.chars().count() < 32 {
        return None;
    }
    Some(sha256_text(&normalized))
}

fn record_value(base: &Path, record: &PaperRecord, recommended: bool) -> Value {
    json!({
        "paper_id": record.paper_id.as_str(),
        "title": record.title_or_id(),
        "asset_dir": record.asset_dir.as_str(),
        "file_name": record.file_name.as_str(),
        "status": record.group.as_str(),
        "pages": record.pages,
        "text_chars": record.text_chars,
        "image_count": record.image_count,
        "source_path": record.source_path.as_deref(),
        "updated_at": record.updated_at.as_str(),
        "legacy_dir": record.legacy_dir,
        "recommended": recommended,
        "source_zip_bytes": source_zip_bytes(base, record),
        "md_path": dir_of(base, record).join("full.md").to_string_lossy().to_string(),
    })
}

fn group_json(
    base: &Path,
    kind: GroupKind,
    key: &str,
    label: String,
    members: &mut Vec<PaperRecord>,
) -> Value {
    sort_members(members);
    let mut total_zip: u64 = 0;
    let mut member_values: Vec<Value> = Vec::new();
    for (index, record) in members.iter().enumerate() {
        let recommended = index == 0;
        total_zip += source_zip_bytes(base, record);
        member_values.push(record_value(base, record, recommended));
    }
    let keep_zip = source_zip_bytes(base, &members[0]);
    let reclaim = total_zip.saturating_sub(keep_zip);
    json!({
        "kind": kind.as_str(),
        "kind_label": kind.label(),
        "key": key,
        "label": label,
        "member_count": members.len(),
        "reclaim_bytes": reclaim,
        "reclaim_text": fmt_bytes(reclaim),
        "recommended": members[0].asset_dir.as_str(),
        "members": member_values,
    })
}

fn duplicates_in(
    base: &Path,
    kinds: &[GroupKind],
    query: Option<&str>,
    limit: usize,
) -> (Value, String) {
    let records: Vec<PaperRecord> = library::scan_in(base, true)
        .into_iter()
        .filter(|r| {
            query
                .map(|q| library::query_match(r, q))
                .unwrap_or(true)
        })
        .collect();
    let total_papers = records.len();
    let mut groups: Vec<Value> = Vec::new();

    if kinds.contains(&GroupKind::Asset) {
        let mut by_paper: BTreeMap<String, Vec<PaperRecord>> = BTreeMap::new();
        for record in &records {
            by_paper
                .entry(record.paper_id.clone())
                .or_default()
                .push(record.clone());
        }
        for (paper_id, mut members) in by_paper {
            if members.len() < 2 {
                continue;
            }
            members.sort_by(|a, b| a.asset_dir.cmp(&b.asset_dir));
            let title = members[0].title_or_id();
            groups.push(group_json(
                base,
                GroupKind::Asset,
                &paper_id,
                format!("同一 paper_id 的多份资产：{}", library::truncate_chars(&title, 60)),
                &mut members,
            ));
        }
    }

    if kinds.contains(&GroupKind::Text) {
        let mut by_text: BTreeMap<String, Vec<PaperRecord>> = BTreeMap::new();
        for record in &records {
            if let Some(hash) = text_fingerprint(base, record) {
                by_text.entry(hash).or_default().push(record.clone());
            }
        }
        for (hash, mut members) in by_text {
            if members.len() < 2 {
                continue;
            }
            let label = format!("正文归一化后完全一致（指纹 {}…）", &hash[..12]);
            groups.push(group_json(base, GroupKind::Text, &hash, label, &mut members));
        }
    }

    if kinds.contains(&GroupKind::Title) {
        let mut by_title: BTreeMap<String, Vec<PaperRecord>> = BTreeMap::new();
        for record in &records {
            let key = normalize_title(&record.title_or_id());
            if key.chars().count() < MIN_TITLE_KEY_CHARS {
                continue;
            }
            by_title.entry(key).or_default().push(record.clone());
        }
        for (key, mut members) in by_title {
            if members.len() < 2 {
                continue;
            }
            let label = format!(
                "标题归一化后一致：{}",
                library::truncate_chars(&members[0].title_or_id(), 60)
            );
            groups.push(group_json(base, GroupKind::Title, &key, label, &mut members));
        }
    }

    if kinds.contains(&GroupKind::Source) {
        let mut by_source: BTreeMap<String, Vec<PaperRecord>> = BTreeMap::new();
        for record in &records {
            let Some(source) = record
                .source_path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty() && !s.starts_with("http://") && !s.starts_with("https://"))
            else {
                continue;
            };
            let key = source.replace('\\', "/").to_lowercase();
            by_source.entry(key).or_default().push(record.clone());
        }
        for (key, mut members) in by_source {
            let distinct: BTreeSet<&str> = members.iter().map(|r| r.paper_id.as_str()).collect();
            if members.len() < 2 || distinct.len() < 2 {
                continue;
            }
            let label = format!("同一源文件被解析成多个版本：{}", library::truncate_chars(&key, 60));
            groups.push(group_json(base, GroupKind::Source, &key, label, &mut members));
        }
    }

    groups.sort_by(|a, b| {
        let a_count = a["member_count"].as_u64().unwrap_or(0);
        let b_count = b["member_count"].as_u64().unwrap_or(0);
        b_count
            .cmp(&a_count)
            .then_with(|| a["kind"].as_str().cmp(&b["kind"].as_str()))
            .then_with(|| a["label"].as_str().cmp(&b["label"].as_str()))
    });
    let total_groups = groups.len();
    let truncated = total_groups > limit;
    groups.truncate(limit);

    let count_kind = |kind: &str| groups.iter().filter(|g| g["kind"] == kind).count();
    let involved: BTreeSet<String> = groups
        .iter()
        .flat_map(|group| {
            group["members"]
                .as_array()
                .map(|members| {
                    members
                        .iter()
                        .filter_map(|m| m["paper_id"].as_str().map(str::to_string))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        })
        .collect();
    let reclaim: u64 = groups
        .iter()
        .map(|group| group["reclaim_bytes"].as_u64().unwrap_or(0))
        .sum();

    let mut text = format!(
        "## 🧬 全库重复检索：{} 篇论文\n\n",
        total_papers
    );
    if total_groups == 0 {
        text.push_str("- ✅ 未发现重复项。\n");
        text.push_str("- 判重覆盖：同 paper_id 多份资产、正文指纹、标题指纹、同一源文件。\n");
    } else {
        text.push_str(&format!(
            "- 发现 **{}** 组重复，涉及 **{}** 篇论文；可回收约 **{}**（仅统计 source.zip）。\n",
            total_groups,
            involved.len(),
            fmt_bytes(reclaim)
        ));
        text.push_str(&format!(
            "- 分组：资产目录 {} ｜ 正文 {} ｜ 标题 {} ｜ 源文件 {}\n",
            count_kind("asset"),
            count_kind("text"),
            count_kind("title"),
            count_kind("source")
        ));
        if truncated {
            text.push_str(&format!(
                "- ⚠️ 仅返回前 {} 组（共 {} 组），可加 group_by 缩小范围。\n",
                limit, total_groups
            ));
        }
        for (index, group) in groups.iter().enumerate() {
            text.push_str(&format!(
                "\n### {}. {} · {}\n",
                index + 1,
                group["kind_label"].as_str().unwrap_or("重复"),
                group["label"].as_str().unwrap_or("")
            ));
            if let Some(members) = group["members"].as_array() {
                for member in members {
                    let mark = if member["recommended"].as_bool().unwrap_or(false) {
                        "✅ 建议保留"
                    } else {
                        "⚠️ 可清理"
                    };
                    text.push_str(&format!(
                        "- {} `{}`｜{}｜{} 页｜{} ｜zip {}\n",
                        mark,
                        member["paper_id"].as_str().unwrap_or(""),
                        library::truncate_chars(member["title"].as_str().unwrap_or(""), 40),
                        member["pages"].as_u64().unwrap_or(0),
                        member["asset_dir"].as_str().unwrap_or(""),
                        member["source_zip_bytes"]
                            .as_u64()
                            .map(fmt_bytes)
                            .unwrap_or_else(|| "-".to_string())
                    ));
                }
            }
        }
        text.push_str("\n> 本命令只读，不删除、不改名。确认重复后请在文件管理器中手动处理，或先备份再清理。\n");
    }

    let data = json!({
        "command": "duplicates",
        "counts": {
            "papers": total_papers,
            "groups": total_groups,
            "showing": groups.len(),
            "asset": count_kind("asset"),
            "text": count_kind("text"),
            "title": count_kind("title"),
            "source": count_kind("source"),
            "papers_involved": involved.len(),
            "reclaim_bytes": reclaim,
        },
        "truncated": truncated,
        "groups": groups,
    });
    (data, text)
}

pub fn cmd_duplicates(request: &Request) -> Result<crate::CommandOutput, AppError> {
    let kinds = parse_group_by(request.group_by.as_deref())?;
    let limit = request
        .limit
        .unwrap_or(MAX_DUPLICATE_GROUPS as u64)
        .clamp(1, MAX_DUPLICATE_GROUPS as u64) as usize;
    let (data, text) = duplicates_in(
        &crate::project_base(),
        &kinds,
        request.query.as_deref(),
        limit,
    );
    Ok(crate::CommandOutput::CardData { text, data })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{asset_leaf, scan_in};
    use crate::state::{save_index, save_state, IndexDoc, PersistentState, STATE_INDEXED};

    fn temp_base(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "mineruparser_dedupe_{}_{}",
            tag,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    fn write_indexed(base: &Path, paper_id: &str, title: &str, md: &str) -> String {
        let leaf = asset_leaf(title, paper_id);
        let dir = base.join("file").join("mineru").join(&leaf);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("full.md"), md).unwrap();
        let mut st = PersistentState::new(paper_id, "demo.pdf");
        st.state = STATE_INDEXED.to_string();
        save_state(&dir, &mut st).unwrap();
        let index = IndexDoc {
            paper_id: paper_id.to_string(),
            title: title.to_string(),
            file_name: "demo.pdf".to_string(),
            asset_dir: Some(leaf.clone()),
            pages: 3,
            text_chars: md.chars().count() as u64,
            ..Default::default()
        };
        save_index(&dir, &index).unwrap();
        leaf
    }

    fn request(value: Value) -> Request {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn preflight_marks_selection_duplicates_and_library_hits() {
        let base = temp_base("preflight");
        let input = base.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("a.pdf"), b"same-pdf-bytes").unwrap();
        fs::write(input.join("b.pdf"), b"same-pdf-bytes").unwrap();
        fs::write(input.join("c.pdf"), b"other-pdf-bytes").unwrap();

        let sha = crate::sha256_file(&input.join("a.pdf")).unwrap();
        let paper_id = paper_id_from_hex(&sha);
        write_indexed(&base, &paper_id, "Already Parsed", "# Already Parsed\n\nbody\n");

        let req = request(json!({
            "command": "preflight",
            "file_paths": [input.to_string_lossy().to_string()],
        }));
        let (data, text) = preflight_in(&base, &req).unwrap();
        let items = data["items"].as_array().unwrap();
        assert_eq!(items.len(), 3, "{}", text);
        let a = items.iter().find(|i| i["file_name"] == "a.pdf").unwrap();
        let b = items.iter().find(|i| i["file_name"] == "b.pdf").unwrap();
        let c = items.iter().find(|i| i["file_name"] == "c.pdf").unwrap();
        assert_eq!(a["status"], "indexed");
        assert_eq!(b["duplicate_in_selection"], true);
        assert_eq!(b["duplicate_of"], a["path"]);
        assert_eq!(c["status"], "new");
        assert_eq!(data["counts"]["duplicate"], 1);
        assert!(text.contains("解析前查重"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn preflight_skips_non_pdf_and_reports_invalid_paths() {
        let base = temp_base("preflight_invalid");
        let input = base.join("input");
        fs::create_dir_all(&input).unwrap();
        fs::write(input.join("one.PDF"), b"one").unwrap();
        fs::write(input.join("note.txt"), b"note").unwrap();
        let req = request(json!({
            "command": "preflight",
            "file_paths": [
                input.to_string_lossy().to_string(),
                input.join("missing.pdf").to_string_lossy().to_string()
            ],
        }));
        let (data, _) = preflight_in(&base, &req).unwrap();
        let items = data["items"].as_array().unwrap();
        assert_eq!(items.iter().filter(|i| i["status"] == "new").count(), 1);
        assert_eq!(items.iter().filter(|i| i["status"] == "invalid").count(), 1);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn duplicates_groups_assets_text_title_and_source() {
        let base = temp_base("duplicates");
        let md = "# Same Paper\n\nSame body with enough characters for a text fingerprint.\n";
        let leaf_a = write_indexed(&base, "paper_aaaaaaaaaaaaaaaa", "Same Title Here", md);
        let leaf_b = write_indexed(&base, "paper_bbbbbbbbbbbbbbbb", "Same Title Here", md);

        // 同一 paper_id 的第二份资产目录（模拟旧目录未清理）
        let legacy = base.join("file").join("mineru").join("paper_aaaaaaaaaaaaaaaa");
        fs::create_dir_all(&legacy).unwrap();
        let mut st = PersistentState::new("paper_aaaaaaaaaaaaaaaa", "demo.pdf");
        st.state = STATE_INDEXED.to_string();
        save_state(&legacy, &mut st).unwrap();
        fs::write(legacy.join("full.md"), md).unwrap();
        let index = IndexDoc {
            paper_id: "paper_aaaaaaaaaaaaaaaa".to_string(),
            title: "Same Title Here".to_string(),
            file_name: "demo.pdf".to_string(),
            pages: 3,
            ..Default::default()
        };
        save_index(&legacy, &index).unwrap();

        // 同一源文件被解析成不同 paper_id
        for (id, leaf) in [
            ("paper_aaaaaaaaaaaaaaaa", leaf_a.as_str()),
            ("paper_bbbbbbbbbbbbbbbb", leaf_b.as_str()),
        ] {
            let dir = base.join("file").join("mineru").join(leaf);
            let mut st = crate::state::load_state(&dir).unwrap();
            st.source_path = Some("D:/papers/shared.pdf".to_string());
            save_state(&dir, &mut st).unwrap();
            let mut idx = crate::state::load_index(&dir).unwrap();
            idx.source_path = Some("D:/papers/shared.pdf".to_string());
            save_index(&dir, &idx).unwrap();
            let _ = id;
        }

        let (data, text) =
            duplicates_in(&base, &parse_group_by(None).unwrap(), None, 200);
        let groups = data["groups"].as_array().unwrap();
        let kinds: BTreeSet<&str> = groups.iter().map(|g| g["kind"].as_str().unwrap()).collect();
        assert!(kinds.contains("asset"), "{}", text);
        assert!(kinds.contains("text"), "{}", text);
        assert!(kinds.contains("title"), "{}", text);
        assert!(kinds.contains("source"), "{}", text);
        assert!(data["counts"]["groups"].as_u64().unwrap() >= 4);
        let asset = groups.iter().find(|g| g["kind"] == "asset").unwrap();
        assert_eq!(asset["member_count"], 2);
        assert!(asset["members"][0]["recommended"].as_bool().unwrap());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn duplicates_without_library_is_empty() {
        let base = temp_base("duplicates_empty");
        let (data, text) = duplicates_in(&base, &parse_group_by(None).unwrap(), None, 200);
        assert_eq!(data["counts"]["groups"], 0);
        assert!(text.contains("未发现重复项"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn group_by_validation() {
        assert_eq!(parse_group_by(None).unwrap().len(), 4);
        assert_eq!(parse_group_by(Some("text,title")).unwrap().len(), 2);
        assert!(parse_group_by(Some("nonsense")).is_err());
    }

    #[test]
    fn normalization_helpers() {
        assert_eq!(normalize_title("A/B: Title!"), "abtitle");
        assert_eq!(normalize_text(" A\r\n\r\n B  C "), "a b c");
        assert_eq!(normalize_text("中文\n段落"), "中文 段落");
    }

    #[test]
    fn scan_in_sees_legacy_and_title_dirs() {
        let base = temp_base("scan");
        write_indexed(&base, "paper_cccccccccccccccc", "Title", "# Title\n\nbody\n");
        assert_eq!(scan_in(&base, true).len(), 1);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn preflight_caps_scan_at_limit() {
        let base = temp_base("preflight_cap");
        let input = base.join("input");
        fs::create_dir_all(&input).unwrap();
        for index in 0..(MAX_PREFLIGHT_FILES + 5) {
            fs::write(input.join(format!("{:04}.pdf", index)), format!("pdf-{}", index)).unwrap();
        }
        let req = request(json!({
            "command": "preflight",
            "file_paths": [input.to_string_lossy().to_string()],
        }));
        let (data, text) = preflight_in(&base, &req).unwrap();
        assert_eq!(data["truncated"], true);
        assert_eq!(data["items"].as_array().unwrap().len(), MAX_PREFLIGHT_FILES);
        assert_eq!(data["counts"]["total"], MAX_PREFLIGHT_FILES);
        assert_eq!(data["counts"]["new"], MAX_PREFLIGHT_FILES);
        assert!(text.contains("上限"), "{}", text);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn duplicates_reports_truncation_and_respects_limit() {
        let base = temp_base("duplicates_limit");
        for group in 0..6 {
            for member in 0..2 {
                let paper_id = format!("paper_{:02}{:014}", group, member);
                let title = format!("Duplicate Group {} Title", group);
                let md = format!(
                    "# {}\n\nunique body {} {} padding padding padding.\n",
                    title, group, member
                );
                write_indexed(&base, &paper_id, &title, &md);
            }
        }
        let (data, text) = duplicates_in(&base, &parse_group_by(Some("title")).unwrap(), None, 2);
        assert_eq!(data["counts"]["groups"], 6);
        assert_eq!(data["groups"].as_array().unwrap().len(), 2);
        assert_eq!(data["truncated"], true);
        assert!(text.contains("仅返回前 2 组"), "{}", text);
        let _ = fs::remove_dir_all(&base);
    }
}
