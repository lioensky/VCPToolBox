//! 论文库（工作区）感知：
//! - 扫描 `file/mineru` 下全部论文资产，合并 `index.json` + `state.json`；
//! - 把论文标题写进资产目录名（`标题__paper_xxx`），同时兼容旧的 `paper_xxx` 目录；
//! - 为 list / status / info / query 提供统一的记录、筛选与提示。
//!
//! 参考 ProjectForge 的工作区解析思路：Agent 不需要记住内部 ID 才能工作，
//! 每次列表/缺失错误都返回「当前有哪些论文、状态如何、如何继续」。

use crate::error::AppError;
use crate::state::{self, IndexDoc, PersistentState, STATE_INDEXED};
use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// 资产目录名中标题与 paper_id 的分隔符。
const LEAF_SEP: &str = "__";
/// 目录名中标题的最大字符数（Windows 路径余量充足，同时避免超长失败）。
const MAX_DIR_TITLE_CHARS: usize = 100;
/// 迁移/整理时最多处理的论文数。
pub const MIGRATE_MAX: usize = 200;

/// `index.json` 存在即视为已完成；否则按 state 分组。
pub fn status_group(raw_state: &str, has_index: bool) -> &'static str {
    if has_index || raw_state == STATE_INDEXED {
        return "indexed";
    }
    match raw_state {
        state::STATE_TIMEOUT => "timeout",
        state::STATE_FAILED => "failed",
        state::STATE_UPLOADING
        | state::STATE_RUNNING
        | state::STATE_DOWNLOADING
        | state::STATE_EXTRACTING
        | "waiting-file"
        | "waiting"
        | "pending" => "running",
        _ => "unknown",
    }
}

pub fn status_badge(group: &str) -> &'static str {
    match group {
        "indexed" => "✅ 已完成",
        "running" => "⏳ 进行中",
        "timeout" => "⏱️ 待续查",
        "failed" => "❌ 失败",
        _ => "❔ 未知",
    }
}

/// 状态过滤词归一化（英文/中文/别名）。
fn normalize_status_word(word: &str) -> Option<&'static str> {
    match word.trim().to_lowercase().as_str() {
        "" | "all" | "*" | "全部" => None,
        "indexed" | "done" | "completed" | "finished" | "已完成" | "完成" => Some("indexed"),
        "running" | "processing" | "active" | "进行中" | "处理中" => Some("running"),
        "timeout" | "pending" | "待续查" | "超时" => Some("timeout"),
        "failed" | "error" | "失败" => Some("failed"),
        "unknown" | "未知" => Some("unknown"),
        "unfinished" | "unindexed" | "未完成" => Some("__unfinished"),
        _ => Some("__invalid"),
    }
}

/// None 表示不过滤；返回的列表可能包含 `__unfinished` 组合项。
pub fn normalize_status_filter(words: Option<&[String]>) -> Result<Option<Vec<String>>, AppError> {
    let Some(words) = words else {
        return Ok(None);
    };
    let mut out = Vec::new();
    for word in words {
        for part in word.split(|c| c == ',' || c == ';') {
            if part.trim().is_empty() {
                continue;
            }
            match normalize_status_word(part) {
                None => return Ok(None),
                Some("__invalid") => {
                    return Err(AppError::fix(format!(
                        "status 仅支持 indexed / running / timeout / failed / unknown / unfinished / all，收到: {}",
                        part
                    )));
                }
                Some(group) => out.push(group.to_string()),
            }
        }
    }
    if out.is_empty() {
        Ok(None)
    } else {
        Ok(Some(out))
    }
}

pub fn matches_status(group: &str, filters: Option<&[String]>) -> bool {
    match filters {
        None => true,
        Some(list) => list.iter().any(|f| {
            f == group || (f == "__unfinished" && group != "indexed")
        }),
    }
}

// ---------------------------------------------------------------------------
// 目录命名
// ---------------------------------------------------------------------------

/// 把一段 LaTeX 数学内容压缩成可读文本：
/// `$\mathrm { C o _ { 7 } F e _ { 3 } @ C }$` → `Co7Fe3@C`。
fn compact_math(raw: &str) -> String {
    let mut out = String::new();
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                // 丢弃命令名；\mathrm、\text、\left、\right、\frac…
                let mut had_letters = false;
                while let Some(&n) = chars.peek() {
                    if n.is_ascii_alphabetic() {
                        chars.next();
                        had_letters = true;
                    } else {
                        break;
                    }
                }
                // `\,` `\;` `\{` 之类：连同符号一起丢弃
                if !had_letters {
                    let _ = chars.next();
                }
            }
            '{' | '}' | '^' | '_' | '&' | '~' | '$' => {}
            c if c.is_whitespace() => {}
            // 目录分隔符与 Windows 非法字符统一替换为连字符
            '/' | ':' | '*' | '?' | '"' | '|' | '<' | '>' => out.push('-'),
            '#' | '%' => {}
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    let cleaned = out.trim_matches(|c: char| c == '.' || c == '-' || c == ' ').to_string();
    if cleaned.chars().count() < 2 {
        String::new()
    } else {
        cleaned
    }
}

/// 清理标题，生成适合作为 Windows/macOS/Linux 目录名的片段。
pub fn safe_dir_title(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut chars = title.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '$' => {
                // 收集 $...$ / $$...$$ 内的数学内容并压缩（避免目录名变成零散字母）
                let display = chars.peek() == Some(&'$');
                if display {
                    chars.next();
                }
                let mut math = String::new();
                let mut closed = false;
                while let Some(m) = chars.next() {
                    if m == '$' {
                        if display && chars.peek() != Some(&'$') {
                            math.push(m);
                            continue;
                        }
                        if display {
                            chars.next();
                        }
                        closed = true;
                        break;
                    }
                    math.push(m);
                }
                let compact = if closed { compact_math(&math) } else { String::new() };
                if compact.is_empty() {
                    out.push(' ');
                } else {
                    out.push(' ');
                    out.push_str(&compact);
                    out.push(' ');
                }
            }
            '<' => {
                // 丢弃 HTML 标签，但保留标签内文字（如 <sub>2</sub> → 2）
                for t in chars.by_ref() {
                    if t == '>' {
                        break;
                    }
                }
                out.push(' ');
            }
            '\\' => {
                // 丢弃 LaTeX 命令名（\mathrm、\text、\left…），保留后续内容
                while let Some(&n) = chars.peek() {
                    if n.is_ascii_alphabetic() {
                        chars.next();
                    } else {
                        break;
                    }
                }
                out.push(' ');
            }
            '{' | '}' | '^' | '_' | '&' | '%' | '#' | '~' => out.push(' '),
            '/' | ':' | '*' | '?' | '"' | '|' | '\n' | '\r' | '\t' => out.push(' '),
            // Windows 允许全角标点，但目录名统一清理，避免跨平台同步问题
            '：' | '？' | '＊' | '＂' | '＜' | '＞' | '｜' => out.push(' '),
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
    }
    let mut cleaned = out.split_whitespace().collect::<Vec<_>>().join(" ");
    cleaned = cleaned
        .trim_matches(|c: char| c == '.' || c == ' ' || c == '-')
        .to_string();
    if cleaned.chars().count() > MAX_DIR_TITLE_CHARS {
        let cut: String = cleaned.chars().take(MAX_DIR_TITLE_CHARS).collect();
        // 尽量在空格/连字符处截断，避免把单词劈开
        let cut = match cut.rfind([' ', '-', '，', '。', '、']) {
            Some(pos) if pos > MAX_DIR_TITLE_CHARS / 2 => cut[..pos].to_string(),
            _ => cut,
        };
        cleaned = cut.trim_end_matches([' ', '.', '-']).to_string();
    }
    if cleaned.is_empty() {
        cleaned = "paper".to_string();
    }
    let upper = cleaned.to_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"]
        .iter()
        .any(|r| upper == *r)
        || (upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.as_bytes()[3].is_ascii_digit());
    if reserved {
        cleaned = format!("_{}", cleaned);
    }
    cleaned
}

/// `标题__paper_xxx`。
pub fn asset_leaf(title: &str, paper_id: &str) -> String {
    format!("{}{}{}", safe_dir_title(title), LEAF_SEP, paper_id)
}

/// 带版本号的叶子名（标题重复/目录占用时使用）：`标题 (2)__paper_xxx`。
pub fn versioned_leaf(title: &str, paper_id: &str, version: usize) -> String {
    if version <= 1 {
        asset_leaf(title, paper_id)
    } else {
        format!(
            "{} ({}){}{}",
            safe_dir_title(title),
            version,
            LEAF_SEP,
            paper_id
        )
    }
}

/// 从叶子名反推标题（旧目录返回 None）。
pub fn title_from_leaf(leaf: &str) -> Option<String> {
    let pos = leaf.rfind(LEAF_SEP)?;
    let title = &leaf[..pos];
    let id = &leaf[pos + LEAF_SEP.len()..];
    if id.starts_with("paper_") && !title.trim().is_empty() {
        Some(title.to_string())
    } else {
        None
    }
}

fn is_same_paper_dir(name: &str, paper_id: &str) -> bool {
    name == paper_id || name.ends_with(&format!("{}{}", LEAF_SEP, paper_id))
}

fn dir_mtime(dir: &Path) -> SystemTime {
    fs::metadata(dir.join("index.json"))
        .or_else(|_| fs::metadata(dir.join("state.json")))
        .and_then(|m| m.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

fn resolve_under(root: &Path, paper_id: &str) -> PathBuf {
    let exact = root.join(paper_id);
    if exact.is_dir() {
        return exact;
    }
    let mut matches: Vec<PathBuf> = fs::read_dir(root)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .map(|n| is_same_paper_dir(n, paper_id))
                        .unwrap_or(false)
                })
                .collect()
        })
        .unwrap_or_default();
    matches.sort_by(|a, b| dir_mtime(b).cmp(&dir_mtime(a)));
    matches.into_iter().next().unwrap_or(exact)
}

pub fn resolve_file_dir(paper_id: &str) -> PathBuf {
    resolve_under(&crate::project_base().join("file").join("mineru"), paper_id)
}

pub fn resolve_image_dir(paper_id: &str) -> PathBuf {
    resolve_under(&crate::project_base().join("image").join("mineru"), paper_id)
}

pub fn asset_dir_name(dir: &Path) -> String {
    dir.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string()
}

// ---------------------------------------------------------------------------
// 扫描与记录
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default)]
pub struct PaperRecord {
    pub paper_id: String,
    pub title: String,
    pub file_name: String,
    pub group: String,
    pub raw_state: Option<String>,
    pub pages: Option<u64>,
    pub text_chars: Option<u64>,
    pub image_count: Option<usize>,
    pub table_count: Option<usize>,
    pub formula_count: Option<usize>,
    pub asset_dir: String,
    pub source_path: Option<String>,
    pub source_dir: Option<String>,
    pub batch_id: Option<String>,
    pub progress: Option<(u64, u64)>,
    pub chunks_done: Option<(usize, usize)>,
    pub updated_at: String,
    pub created_at: String,
    pub has_index: bool,
    pub has_state: bool,
    pub error: Option<String>,
    pub legacy_dir: bool,
    pub index: Option<IndexDoc>,
}

impl PaperRecord {
    pub fn title_or_id(&self) -> String {
        if self.title.trim().is_empty() {
            self.paper_id.clone()
        } else {
            self.title.clone()
        }
    }

    pub fn progress_text(&self) -> String {
        let mut parts = Vec::new();
        if let Some((done, total)) = self.chunks_done {
            if total > 0 {
                parts.push(format!("分片 {}/{}", done, total));
            }
        }
        if let Some((extracted, total)) = self.progress {
            if total > 0 {
                parts.push(format!("{}/{} 页", extracted, total));
            }
        }
        if parts.is_empty() {
            "-".to_string()
        } else {
            parts.join(" · ")
        }
    }

    pub fn status_text(&self) -> String {
        match (&self.raw_state, self.has_index) {
            (_, true) => status_badge("indexed").to_string(),
            (Some(raw), false) if !raw.is_empty() => {
                format!("{}（{}）", status_badge(&self.group), raw)
            }
            _ => status_badge(&self.group).to_string(),
        }
    }
}

fn record_from_dir(dir: &Path, load_index: bool) -> Option<PaperRecord> {
    let leaf = asset_dir_name(dir);
    if leaf.is_empty() || leaf.starts_with('.') {
        return None;
    }
    let index = if load_index { state::load_index(dir) } else { None };
    let st = state::load_state(dir);
    let has_index = dir.join("index.json").is_file();
    if index.is_none() && st.is_none() && !has_index {
        return None;
    }
    let paper_id = index
        .as_ref()
        .map(|i| i.paper_id.clone())
        .or_else(|| st.as_ref().map(|s| s.paper_id.clone()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            leaf.rsplit(LEAF_SEP)
                .next()
                .unwrap_or(&leaf)
                .to_string()
        });
    let index_title = index.as_ref().map(|i| i.title.clone()).filter(|t| !t.trim().is_empty());
    let leaf_title = title_from_leaf(&leaf);
    let file_name = index
        .as_ref()
        .map(|i| i.file_name.clone())
        .or_else(|| st.as_ref().map(|s| s.file_name.clone()))
        .unwrap_or_default();
    let state_group = status_group(
        st.as_ref().map(|s| s.state.as_str()).unwrap_or(""),
        has_index,
    );
    let title = index_title
        .or(leaf_title)
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| {
            Path::new(&file_name)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&paper_id)
                .to_string()
        });
    let progress = if has_index {
        None
    } else {
        st.as_ref().and_then(|s| {
            s.last_progress
                .as_ref()
                .map(|p| (p.extracted_pages, p.total_pages))
                .or_else(|| chunk_page_progress(s))
        })
    };
    let chunks_done = if has_index {
        None
    } else {
        st.as_ref().and_then(|s| {
            if s.chunks.is_empty() {
                None
            } else {
                let done = s.chunks.iter().filter(|c| c.state == "done").count();
                Some((done, s.chunks.len()))
            }
        })
    };
    let raw_state = st.as_ref().map(|s| s.state.clone());
    let batch_id = st
        .as_ref()
        .map(|s| s.batch_id.clone())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            st.as_ref().and_then(|s| {
                s.chunks
                    .iter()
                    .find(|c| !c.batch_id.is_empty() && c.state != "done")
                    .or_else(|| s.chunks.iter().find(|c| !c.batch_id.is_empty()))
                    .map(|c| c.batch_id.clone())
            })
        });
    // 已完成论文展示完成时间，避免迁移/重新读取 state 时刷新 updated_at 打乱“最近”排序。
    let updated_at = if has_index {
        index
            .as_ref()
            .map(|i| i.created_at.clone())
            .filter(|s| !s.is_empty())
            .or_else(|| st.as_ref().map(|s| s.updated_at.clone()))
            .unwrap_or_default()
    } else {
        st.as_ref()
            .map(|s| s.updated_at.clone())
            .filter(|s| !s.is_empty())
            .unwrap_or_default()
    };
    let created_at = index
        .as_ref()
        .map(|i| i.created_at.clone())
        .or_else(|| st.as_ref().map(|s| s.created_at.clone()))
        .unwrap_or_default();
    let source_path = index
        .as_ref()
        .and_then(|i| i.source_path.clone())
        .or_else(|| st.as_ref().and_then(|s| s.source_path.clone()));
    let source_dir = index
        .as_ref()
        .and_then(|i| i.source_dir.clone())
        .or_else(|| st.as_ref().and_then(|s| s.source_dir.clone()));
    let error = st
        .as_ref()
        .and_then(|s| s.err_msg.clone())
        .filter(|s| !s.trim().is_empty());

    Some(PaperRecord {
        paper_id,
        title,
        file_name,
        group: state_group.to_string(),
        raw_state,
        pages: index.as_ref().map(|i| i.pages),
        text_chars: index.as_ref().map(|i| i.text_chars),
        image_count: index.as_ref().map(|i| i.image_count),
        table_count: index.as_ref().map(|i| i.table_count),
        formula_count: index.as_ref().map(|i| i.formula_count),
        asset_dir: leaf.clone(),
        source_path,
        source_dir,
        batch_id,
        progress,
        chunks_done,
        updated_at,
        created_at,
        has_index,
        has_state: st.is_some(),
        error,
        legacy_dir: !leaf.contains(LEAF_SEP),
        index,
    })
}

pub fn scan_in(base: &Path, load_index: bool) -> Vec<PaperRecord> {
    let root = base.join("file").join("mineru");
    let Ok(entries) = fs::read_dir(&root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| record_from_dir(&e.path(), load_index))
        .collect()
}

pub fn scan(load_index: bool) -> Vec<PaperRecord> {
    scan_in(&crate::project_base(), load_index)
}

/// 轻量扫描：只读 state.json（用于每次卡片末尾的论文库摘要）。
pub fn scan_light() -> Vec<PaperRecord> {
    scan(false)
}

/// 读取单篇完整记录（含 index 大纲/图片）。
pub fn load_record(paper_id: &str) -> Option<PaperRecord> {
    record_from_dir(&resolve_file_dir(paper_id), true)
}

pub fn find_by_batch(batch_id: &str) -> Option<PaperRecord> {
    scan_light()
        .into_iter()
        .find(|r| r.batch_id.as_deref() == Some(batch_id))
}

/// paper_id / 标题 / 文件名 / 资产目录 → 唯一 paper_id（供 query/status/info 使用）。
pub fn resolve_paper_ref(reference: &str) -> Result<String, AppError> {
    let raw = reference.trim();
    if raw.is_empty() {
        return Err(AppError::fix("paper_id 不能为空。"));
    }
    // 形如 paper_xxx 且目录存在时直接返回，避免为常见路径扫描全部索引。
    if raw.starts_with("paper_")
        && raw
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        && resolve_file_dir(raw).is_dir()
    {
        return Ok(raw.to_string());
    }
    let low = raw.to_lowercase();
    let records = scan(true);
    if let Some(record) = records
        .iter()
        .find(|r| r.paper_id.eq_ignore_ascii_case(raw))
    {
        return Ok(record.paper_id.clone());
    }
    let mut hits: Vec<&PaperRecord> = records
        .iter()
        .filter(|r| {
            r.title.to_lowercase() == low
                || r.asset_dir.to_lowercase() == low
                || r.file_name.to_lowercase() == low
        })
        .collect();
    if hits.is_empty() {
        hits = records
            .iter()
            .filter(|r| {
                r.title.to_lowercase().contains(&low)
                    || r.asset_dir.to_lowercase().contains(&low)
                    || r.file_name.to_lowercase().contains(&low)
            })
            .collect();
    }
    match hits.len() {
        1 => Ok(hits[0].paper_id.clone()),
        0 => Err(AppError::fix(format!(
            "未找到论文“{}”。\n{}",
            raw,
            missing_paper_hint(raw)
        ))),
        _ => {
            let list = hits
                .iter()
                .take(5)
                .map(|r| format!("`{}`｜{}", r.paper_id, r.title_or_id()))
                .collect::<Vec<_>>()
                .join("\n");
            Err(AppError::fix(format!(
                "“{}”匹配到多篇论文，请改用 paper_id：\n{}",
                raw, list
            )))
        }
    }
}

pub fn sort_records(records: &mut [PaperRecord], sort: &str) {
    match sort.trim().to_lowercase().as_str() {
        "title" => records.sort_by(|a, b| {
            a.title_or_id()
                .to_lowercase()
                .cmp(&b.title_or_id().to_lowercase())
        }),
        "pages" => records.sort_by(|a, b| {
            let pa = a.pages.unwrap_or(0);
            let pb = b.pages.unwrap_or(0);
            pb.cmp(&pa).then_with(|| a.title_or_id().cmp(&b.title_or_id()))
        }),
        "created" => records.sort_by(|a, b| b.created_at.cmp(&a.created_at)),
        _ => records.sort_by(|a, b| match b.updated_at.cmp(&a.updated_at) {
            Ordering::Equal => a.title_or_id().cmp(&b.title_or_id()),
            ord => ord,
        }),
    }
}

pub fn query_match(record: &PaperRecord, query: &str) -> bool {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return true;
    }
    let hay = format!(
        "{} {} {} {} {} {}",
        record.paper_id,
        record.title,
        record.file_name,
        record.asset_dir,
        record.source_path.clone().unwrap_or_default(),
        record.source_dir.clone().unwrap_or_default()
    )
    .to_lowercase();
    hay.contains(&q)
}

/// 未找到论文时的可操作提示：给出相近论文与搜索方式。
pub fn missing_paper_hint(input: &str) -> String {
    let records = scan(true);
    if records.is_empty() {
        return "本地还没有已解析论文；可先用 batch 命令导入 PDF 文件夹。".to_string();
    }
    let q = input.trim().to_lowercase();
    let matched: Vec<&PaperRecord> = records
        .iter()
        .filter(|r| {
            !q.is_empty()
                && (r.paper_id.to_lowercase().contains(&q)
                    || r.title.to_lowercase().contains(&q)
                    || r.asset_dir.to_lowercase().contains(&q)
                    || r.file_name.to_lowercase().contains(&q))
        })
        .collect();
    if matched.is_empty() {
        // 没有相近项时退回最近更新的 3 篇（克隆为拥有所有权的记录，避免借用逃逸）。
        let mut recent = records.clone();
        sort_records(&mut recent, "recent");
        return format!(
            "相近论文（最近更新）：\n{}\n可用 `list`（可带 query=关键词）查看全部论文。",
            recent
                .iter()
                .take(3)
                .map(|r| format!(
                    "`{}`｜{}｜{}｜目录 {}",
                    r.paper_id,
                    r.title_or_id(),
                    r.status_text(),
                    r.asset_dir
                ))
                .collect::<Vec<_>>()
                .join("\n")
        );
    }
    let lines: Vec<String> = matched
        .iter()
        .take(3)
        .map(|r| {
            format!(
                "`{}`｜{}｜{}｜目录 {}",
                r.paper_id,
                r.title_or_id(),
                r.status_text(),
                r.asset_dir
            )
        })
        .collect();
    format!(
        "相近论文：\n{}\n可用 `list`（可带 query=关键词）查看全部论文。",
        lines.join("\n")
    )
}

/// 每次 parse/query/batch 卡片末尾的一行论文库摘要。
pub fn compact_summary() -> String {
    let mut records = scan(true);
    if records.is_empty() {
        return "论文库：本地还没有已解析论文。".to_string();
    }
    let total = records.len();
    sort_records(&mut records, "recent");
    let count = |group: &str| records.iter().filter(|r| r.group == group).count();
    let recent: Vec<String> = records
        .iter()
        .take(3)
        .map(|r| truncate_chars(&r.title_or_id(), 32))
        .collect();
    format!(
        "论文库：共 {} 篇（✅ {} ｜ ⏳ {} ｜ ⏱️ {} ｜ ❌ {}）｜最近：{}。用 `list` 查看全部、`status` 查看进度、`info` 查看单篇。",
        total,
        count("indexed"),
        count("running"),
        count("timeout"),
        count("failed"),
        recent.join("；")
    )
}

pub fn counts_text(records: &[PaperRecord]) -> String {
    let count = |group: &str| records.iter().filter(|r| r.group == group).count();
    format!(
        "共 {} 篇（✅ {} ｜ ⏳ {} ｜ ⏱️ {} ｜ ❌ {} ｜ ❔ {}）",
        records.len(),
        count("indexed"),
        count("running"),
        count("timeout"),
        count("failed"),
        count("unknown")
    )
}

/// 目录叶子名预览：保留可读标题开头与 `__paper_id` 后缀，避免表格中看不出归属。
pub fn leaf_preview(leaf: &str, max: usize) -> String {
    if leaf.chars().count() <= max {
        return leaf.to_string();
    }
    if let Some(pos) = leaf.rfind(LEAF_SEP) {
        let suffix = &leaf[pos..];
        let suffix_len = suffix.chars().count();
        if suffix_len + 2 < max {
            let avail = max - suffix_len - 1;
            let head: String = leaf.chars().take(avail).collect();
            return format!("{}…{}", head.trim_end(), suffix);
        }
    }
    truncate_chars(leaf, max)
}

pub fn truncate_chars(text: &str, max: usize) -> String {
    let clean = text.replace('\n', " ").replace('|', "\\|");
    if clean.chars().count() <= max {
        clean
    } else {
        let cut: String = clean.chars().take(max).collect();
        format!("{}…", cut.trim_end())
    }
}

/// 读取分片状态的页级进度（供 status/detail 使用）。
pub fn chunk_page_progress(st: &PersistentState) -> Option<(u64, u64)> {
    if st.chunks.is_empty() {
        return None;
    }
    let total: u64 = st
        .chunks
        .iter()
        .map(|c| c.end_page.saturating_sub(c.start_page))
        .sum();
    let extracted: u64 = st
        .chunks
        .iter()
        .map(|c| {
            if c.state == "done" {
                c.end_page.saturating_sub(c.start_page)
            } else {
                c.extracted.unwrap_or(0).min(c.total.unwrap_or(0))
            }
        })
        .sum();
    if total == 0 {
        None
    } else {
        Some((extracted, total))
    }
}

/// 目录内递归收集 PDF（供 batch 展开文件夹）。返回 (路径, 截断标记)。
pub fn collect_pdfs(root: &Path, recursive: bool, limit: usize) -> Result<(Vec<PathBuf>, bool), AppError> {
    let mut out = Vec::new();
    let mut truncated = false;
    let mut stack = vec![root.to_path_buf()];
    // 目录联接/符号链接可能形成环；按真实路径去重，避免无限展开。
    let mut visited: std::collections::BTreeSet<PathBuf> = std::collections::BTreeSet::new();
    while let Some(dir) = stack.pop() {
        let canonical = fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
        if !visited.insert(canonical) {
            continue;
        }
        let entries = fs::read_dir(&dir)
            .map_err(|e| AppError::fix(format!("读取目录失败 {}: {}", dir.display(), e)))?;
        let mut children: Vec<PathBuf> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || name.starts_with('_') {
                    continue;
                }
                if recursive {
                    children.push(path);
                }
            } else if ft.is_file()
                && path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.eq_ignore_ascii_case("pdf"))
                    .unwrap_or(false)
            {
                if out.len() >= limit {
                    truncated = true;
                    break;
                }
                out.push(path);
            }
        }
        if truncated {
            break;
        }
        children.sort();
        // 深度优先、目录名有序；栈后进先出，反向压入保持顺序
        for child in children.into_iter().rev() {
            stack.push(child);
        }
    }
    out.sort();
    Ok((out, truncated))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_base(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "mineruparser_library_{}_{}",
            tag,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn safe_dir_title_sanitizes() {
        assert_eq!(
            safe_dir_title("Electrostatically self-assembled $\\mathrm { C o }$ / test"),
            "Electrostatically self-assembled Co test"
        );
        assert_eq!(
            safe_dir_title(
                "Hierarchical magnetic $\\mathrm { C o _ { 7 } F e _ { 3 } @ C / T i _ { 3 } C _ { 2 } T _ { x } }$ nanocomposite"
            ),
            "Hierarchical magnetic Co7Fe3@C-Ti3C2Tx nanocomposite"
        );
        assert_eq!(safe_dir_title("Hierarchical CoFe-K/GC@MnO<sub>2</sub>"), "Hierarchical CoFe-K GC@MnO 2");
        assert_eq!(safe_dir_title("   ...  "), "paper");
        assert_eq!(safe_dir_title("CON"), "_CON");
        assert_eq!(safe_dir_title("中文 论文：标题？"), "中文 论文 标题");
        let long = "a".repeat(200);
        assert!(safe_dir_title(&long).chars().count() <= MAX_DIR_TITLE_CHARS);
    }

    #[test]
    fn leaf_roundtrip() {
        let leaf = asset_leaf("A/B: Test", "paper_0123456789abcdef");
        assert_eq!(leaf, "A B Test__paper_0123456789abcdef");
        assert_eq!(title_from_leaf(&leaf).as_deref(), Some("A B Test"));
        assert_eq!(title_from_leaf("paper_0123456789abcdef"), None);
    }

    #[test]
    fn leaf_preview_keeps_paper_id() {
        let leaf = "A very long readable paper title that should be shortened__paper_0123456789abcdef";
        let preview = leaf_preview(leaf, 40);
        assert!(preview.ends_with("__paper_0123456789abcdef"));
        assert!(preview.chars().count() <= 40);
        assert!(preview.contains('…'));
        assert_eq!(leaf_preview("Short__paper_x", 40), "Short__paper_x");
    }

    #[test]
    fn status_filter_normalization() {
        assert!(matches_status("indexed", None));
        let f = normalize_status_filter(Some(&["unfinished".to_string()])).unwrap();
        assert!(matches_status("running", f.as_deref()));
        assert!(!matches_status("indexed", f.as_deref()));
        assert!(normalize_status_filter(Some(&["nonsense".to_string()])).is_err());
    }

    #[test]
    fn scan_and_resolve_title_dirs() {
        let base = temp_base("scan");
        let file_root = base.join("file/mineru");
        let image_root = base.join("image/mineru");
        let leaf = asset_leaf("Demo Paper", "paper_0123456789abcdef");
        let dir = file_root.join(&leaf);
        fs::create_dir_all(&dir).unwrap();
        fs::create_dir_all(image_root.join(&leaf)).unwrap();
        let mut st = PersistentState::new("paper_0123456789abcdef", "demo.pdf");
        st.state = STATE_INDEXED.to_string();
        state::save_state(&dir, &mut st).unwrap();
        let index = IndexDoc {
            paper_id: "paper_0123456789abcdef".to_string(),
            title: "Demo Paper".to_string(),
            file_name: "demo.pdf".to_string(),
            pages: 3,
            ..Default::default()
        };
        state::save_index(&dir, &index).unwrap();

        let records = scan_in(&base, true);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].group, "indexed");
        assert_eq!(records[0].title, "Demo Paper");
        assert!(!records[0].legacy_dir);
        assert!(query_match(&records[0], "demo"));
        assert!(query_match(&records[0], "paper_0123"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn collect_pdfs_recurses_and_dedups() {
        let base = temp_base("pdfs");
        fs::create_dir_all(base.join("a")).unwrap();
        fs::create_dir_all(base.join("b")).unwrap();
        fs::write(base.join("root.PDF"), b"x").unwrap();
        fs::write(base.join("a/one.pdf"), b"x").unwrap();
        fs::write(base.join("b/two.pdf"), b"x").unwrap();
        fs::write(base.join("a/note.txt"), b"x").unwrap();
        let (pdfs, truncated) = collect_pdfs(&base, true, 10).unwrap();
        assert_eq!(pdfs.len(), 3);
        assert!(!truncated);
        let (pdfs, truncated) = collect_pdfs(&base, true, 2).unwrap();
        assert_eq!(pdfs.len(), 2);
        assert!(truncated);
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(windows)]
    fn make_junction(link: &Path, target: &Path) -> bool {
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[test]
    fn collect_pdfs_handles_deep_tree_and_junction_cycle() {
        let base = temp_base("pdfs_deep");
        let mut deep = base.join("d0");
        fs::create_dir_all(&deep).unwrap();
        for index in 1..40 {
            deep.push(format!("d{}", index));
            fs::create_dir_all(&deep).unwrap();
        }
        fs::write(deep.join("deep.pdf"), b"x").unwrap();

        #[cfg(windows)]
        {
            // 目录联接在 Windows 上不需要管理员权限；遍历必须终止且不重复收集。
            let _ = make_junction(&base.join("loop"), &base);
        }

        let (pdfs, truncated) = collect_pdfs(&base, true, 100).unwrap();
        assert_eq!(pdfs.len(), 1, "junction 形成的环不得重复收集 PDF");
        assert!(!truncated);
        assert!(pdfs[0].ends_with("deep.pdf"));
        let _ = fs::remove_dir_all(&base);
    }
}
