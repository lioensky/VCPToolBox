//! read 命令：自由阅读已解析论文资产。
//!
//! 参考 ProjectForge ReadCode 的读取范式：
//! - `path` / `paths` / `glob` 选择文件，支持 `文件:行范围`；
//! - `lines` 支持 `head:N` / `tail:N` / `M-N` / `N` / `all`；
//! - `find` 关键词检索并返回命中行与上下文；
//! - `section` 按 Markdown 标题读取整节（含子节）；
//! - 图片按序号 / 页码 / 图注 / 路径选择，默认以 base64 data URL 返回，
//!   作为 `image_url` content part 直接交给多模态模型。

use crate::assets::normalize_ref;
use crate::error::AppError;
use crate::protocol::{ContentPart, Request};
use crate::state::{load_index, IndexDoc};
use crate::zip_safe::list_files;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

/// 未指定行范围时单次最多返回的行数（避免误读整本书撑爆上下文）。
const DEFAULT_MAX_LINES: usize = 600;
/// 单个文本文件的行数上限：超长空白/换行文件不得一次性展开成 Vec<String>。
const MAX_TEXT_LINES: usize = 1_000_000;
/// glob 模式长度与段数上限，避免病态模式导致匹配爆炸。
const MAX_GLOB_PATTERN_CHARS: usize = 512;
const MAX_GLOB_PATTERN_SEGMENTS: usize = 64;
/// 单批文本文件数上限。
const MAX_READ_FILES: usize = 20;
/// glob 单次匹配上限。
const MAX_GLOB_MATCHES: usize = 50;
/// 单次读取图片上限。
const MAX_IMAGES: usize = 12;
/// 单张图片内嵌上限。
const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
/// 单次内嵌图片总字节上限（base64 后约 1.33 倍）。
const MAX_TOTAL_IMAGE_BYTES: u64 = 24 * 1024 * 1024;
/// find 最多展示的命中数。
const FIND_MAX_HITS: usize = 30;
const DEFAULT_FIND_CONTEXT: u64 = 2;
/// 文本单文件读取上限（full.md 通常 <5MB）。
const MAX_TEXT_BYTES: u64 = 20 * 1024 * 1024;
/// 单行展示上限（content_list.json 等紧凑 JSON 可能是单行数 MB）。
const MAX_LINE_CHARS: usize = 1000;

const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "svg", "bmp"];

/// 论文资产上下文（文件目录 + 图片目录 + index.json）。
struct Ctx {
    paper_id: String,
    title: String,
    file_dir: PathBuf,
    image_dir: PathBuf,
    index: Option<IndexDoc>,
}

#[derive(Clone)]
struct AssetRef {
    rel: String,
    abs: PathBuf,
    is_image: bool,
}

#[derive(Clone)]
struct TextSpec {
    asset: AssetRef,
    lines: Option<String>,
}

#[derive(Clone)]
struct ImageCandidate {
    /// 1-based 序号（与卡片图片清单一致）
    index: usize,
    rel: String,
    abs: PathBuf,
    caption: Option<String>,
    page_idx: Option<u64>,
    http_url: Option<String>,
    size: u64,
}

struct ImageSelection {
    positions: Vec<usize>,
    truncated: bool,
}

// ---------------------------------------------------------------------------
// 命令入口
// ---------------------------------------------------------------------------

pub fn cmd_read(request: &Request) -> Result<crate::CommandOutput, AppError> {
    let reference = request
        .paper_id
        .as_deref()
        .ok_or_else(|| AppError::fix("read 命令缺少必需参数 paper_id（可用 list 命令查看）。"))?
        .trim()
        .to_string();
    // 允许直接传标题关键词：先按 paper_id 规范校验，不合法时在论文库中唯一解析。
    let mut paper_id = reference.clone();
    if validate_paper_id(&paper_id).is_err() {
        paper_id = crate::library::resolve_paper_ref(&reference)?;
    }
    let mut file_dir = crate::file_dir_of(&paper_id);
    if !file_dir.is_dir() {
        paper_id = crate::library::resolve_paper_ref(&reference)?;
        file_dir = crate::file_dir_of(&paper_id);
    }
    if !file_dir.is_dir() {
        return Err(AppError::fix(format!(
            "论文 {} 尚未解析（找不到资产目录）。{}\n可先用 `parse` 解析，或用 `list` 查看已解析论文。",
            paper_id,
            crate::library::missing_paper_hint(&paper_id)
        )));
    }
    let image_dir = crate::image_dir_of(&paper_id);
    let index = load_index(&file_dir);
    let title = index
        .as_ref()
        .map(|i| i.title.replace('\n', " "))
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| paper_id.clone());
    let ctx = Ctx {
        paper_id,
        title,
        file_dir,
        image_dir,
        index,
    };

    let (parts, data) = run_read(&ctx, request)?;
    Ok(crate::CommandOutput::Parts { parts, data })
}

fn run_read(
    ctx: &Ctx,
    request: &Request,
) -> Result<(Vec<ContentPart>, Option<Value>), AppError> {
    let mut text_specs: Vec<TextSpec> = Vec::new();
    let mut direct_images: Vec<AssetRef> = Vec::new();

    if let Some(raw) = request.path.as_deref() {
        let (path, suffix) = split_path_range(raw);
        push_target(ctx, &path, suffix, request, &mut text_specs, &mut direct_images)?;
    }
    for raw in request.paths.iter().flatten() {
        let (path, suffix) = split_path_range(raw);
        push_target(ctx, &path, suffix, request, &mut text_specs, &mut direct_images)?;
    }
    if let Some(pattern) = request.glob.as_deref() {
        for asset in glob_assets(ctx, pattern)? {
            if asset.is_image {
                direct_images.push(asset);
            } else {
                text_specs.push(TextSpec {
                    asset,
                    lines: request.lines.clone(),
                });
            }
        }
    }

    let has_image_selectors = request
        .images
        .as_ref()
        .map(|list| !list.is_empty())
        .unwrap_or(false)
        || request.page.is_some()
        || request.caption.is_some()
        || !direct_images.is_empty();

    // find / section 未显式给文件时默认读 full.md
    if text_specs.is_empty() && (request.find.is_some() || request.section.is_some()) {
        text_specs.push(TextSpec {
            asset: resolve_asset(ctx, "full.md")?,
            lines: request.lines.clone(),
        });
    }
    // 完全无参数：默认读 full.md 前 600 行
    if text_specs.is_empty()
        && !has_image_selectors
        && request.find.is_none()
        && request.section.is_none()
    {
        text_specs.push(TextSpec {
            asset: resolve_asset(ctx, "full.md")?,
            lines: request.lines.clone(),
        });
    }

    let mut truncated = false;
    let mut seen = BTreeSet::new();
    text_specs.retain(|spec| {
        seen.insert(format!(
            "{}|{}",
            spec.asset.rel,
            spec.lines.clone().unwrap_or_default()
        ))
    });
    let requested_files = text_specs.len();
    if requested_files > MAX_READ_FILES {
        text_specs.truncate(MAX_READ_FILES);
        truncated = true;
    }

    let mut parts: Vec<ContentPart> = Vec::new();
    let mut data_files: Vec<Value> = Vec::new();
    let mut data_images: Vec<Value> = Vec::new();
    let mut find_hits: Option<usize> = None;

    if let Some(keyword) = request.find.as_deref() {
        let found = run_find(ctx, &text_specs, request, keyword)?;
        parts.extend(found.parts);
        if truncated {
            parts.push(ContentPart::text(format!(
                "- ⚠️ 请求文件过多，仅检索前 {} 个（共 {} 个）。",
                MAX_READ_FILES, requested_files
            )));
        }
        data_files.extend(found.files);
        find_hits = Some(found.total_hits);
    } else if !text_specs.is_empty() {
        let mut header = format!(
            "## 📖 阅读：{}（`{}`）\n\n- 文件 {} 个 · {}\n- 续读：lines=\"M-N\"；章节：section=标题；检索：find=关键词；读图：page=N / images=序号\n",
            ctx.title,
            ctx.paper_id,
            text_specs.len(),
            if request.show_line {
                "行号格式 `N | 内容`（show_line=false 可关闭）"
            } else {
                "已关闭行号"
            }
        );
        if truncated {
            header.push_str(&format!(
                "- ⚠️ 请求文件过多，仅读取前 {} 个（共 {} 个）\n",
                MAX_READ_FILES, requested_files
            ));
        }
        parts.push(ContentPart::text(header));
        for spec in &text_specs {
            let (part, data) = read_text_spec(ctx, spec, request)?;
            parts.push(part);
            data_files.push(data);
        }
    }

    if has_image_selectors {
        let image_meta = content_list_image_meta(ctx);
        let mut candidates = collect_images(ctx, &image_meta);
        for asset in &direct_images {
            if !candidates.iter().any(|c| c.abs == asset.abs) {
                let entry = ctx.index.as_ref().and_then(|idx| {
                    idx.images
                        .iter()
                        .find(|e| normalize_ref(&e.rel) == asset.rel)
                });
                let meta = image_meta.get(&asset.rel);
                let size = fs::metadata(&asset.abs).map(|m| m.len()).unwrap_or(0);
                candidates.push(ImageCandidate {
                    index: candidates.len() + 1,
                    rel: asset.rel.clone(),
                    abs: asset.abs.clone(),
                    caption: entry
                        .and_then(|e| e.caption.clone())
                        .or_else(|| meta.and_then(|m| m.caption.clone())),
                    page_idx: entry
                        .and_then(|e| e.page_idx)
                        .or_else(|| meta.and_then(|m| m.page_idx)),
                    http_url: entry.map(|e| e.url.clone()),
                    size,
                });
            }
        }
        let selection = select_images(&candidates, request, &direct_images)?;
        if !selection.positions.is_empty() {
            let selected: Vec<ImageCandidate> = selection
                .positions
                .iter()
                .filter_map(|pos| candidates.get(*pos).cloned())
                .collect();
            let (image_parts, image_data) =
                render_images(ctx, &selected, request.with_base64, selection.truncated)?;
            parts.extend(image_parts);
            data_images.extend(image_data);
            truncated = truncated || selection.truncated;
        }
    }

    if parts.is_empty() {
        return Err(AppError::fix(format!(
            "没有可读取的内容。可用 path=full.md、section=标题、find=关键词，或 images=序号 / page=N 读取图片。{}",
            available_hint(ctx)
        )));
    }

    let mut data = json!({
        "paper_id": ctx.paper_id,
        "title": ctx.title,
    });
    if let Some(hits) = find_hits {
        data["find"] = json!({
            "keyword": request.find,
            "hits": hits,
        });
    }
    if !data_files.is_empty() {
        data["files"] = json!(data_files);
    }
    if !data_images.is_empty() {
        data["images"] = json!(data_images);
    }
    if truncated {
        data["truncated"] = json!(true);
    }
    Ok((parts, Some(data)))
}

fn push_target(
    ctx: &Ctx,
    raw_path: &str,
    suffix: Option<String>,
    request: &Request,
    text_specs: &mut Vec<TextSpec>,
    direct_images: &mut Vec<AssetRef>,
) -> Result<(), AppError> {
    let asset = resolve_asset(ctx, raw_path)?;
    if asset.is_image {
        direct_images.push(asset);
    } else {
        text_specs.push(TextSpec {
            asset,
            lines: request.lines.clone().or(suffix),
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 路径解析与安全边界
// ---------------------------------------------------------------------------

fn validate_paper_id(paper_id: &str) -> Result<(), String> {
    let rest = paper_id
        .strip_prefix("paper_")
        .ok_or_else(|| format!("paper_id 无效：{}。应形如 paper_a1b2c3d4e5f60718（可用 list 查看）。", paper_id))?;
    if rest.len() < 4
        || !rest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!(
            "paper_id 无效：{}。只允许字母、数字、下划线与连字符，且必须以 paper_ 开头。",
            paper_id
        ));
    }
    Ok(())
}

fn strip_file_url(raw: &str) -> String {
    if let Some(rest) = raw.strip_prefix("file://") {
        #[cfg(windows)]
        {
            return rest.trim_start_matches('/').to_string();
        }
        #[cfg(not(windows))]
        {
            return rest.to_string();
        }
    }
    raw.to_string()
}

fn alias_of(rel: &str) -> Option<&'static str> {
    match rel.trim_matches('/').to_lowercase().as_str() {
        "md" | "full" | "body" => Some("full.md"),
        "render" | "render.md" | "full.render" | "render_md" => Some("full.render.md"),
        "content_list" | "content-list" | "blocks" => Some("content_list.json"),
        "index" => Some("index.json"),
        "state" => Some("state.json"),
        "layout" => Some("layout.json"),
        _ => None,
    }
}

fn resolve_asset(ctx: &Ctx, raw: &str) -> Result<AssetRef, AppError> {
    let raw = strip_file_url(raw.trim());
    if raw.is_empty() {
        return Err(AppError::fix("路径不能为空。"));
    }

    let candidate = Path::new(&raw);
    if candidate.is_absolute() {
        if let Some(found) = resolve_absolute(ctx, candidate)? {
            return Ok(found);
        }
        return Err(AppError::fix(format!(
            "绝对路径不在论文资产目录内：{}。请使用相对路径（如 full.md、images/xxx.jpg）。",
            raw
        )));
    }

    let rel_raw = raw.replace('\\', "/");
    if rel_raw.split('/').any(|part| part == "..") {
        return Err(AppError::fix(format!(
            "路径不允许包含 .. 逃逸：{}。请使用论文资产目录内的相对路径。",
            raw
        )));
    }
    let rel_raw = alias_of(&rel_raw).unwrap_or(&rel_raw).to_string();
    let rel = normalize_ref(&rel_raw);
    if rel.is_empty() {
        return Err(AppError::fix("路径不能为空。"));
    }
    if rel.len() >= 2 && rel.as_bytes()[1] == b':' {
        return Err(AppError::fix(format!(
            "路径不允许盘符前缀：{}。请使用相对路径。",
            raw
        )));
    }

    let file_path = ctx
        .file_dir
        .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    if file_path.is_file() {
        return Ok(AssetRef {
            is_image: is_image_path(&rel),
            rel,
            abs: file_path,
        });
    }
    let image_path = ctx
        .image_dir
        .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    if image_path.is_file() {
        return Ok(AssetRef {
            rel,
            abs: image_path,
            is_image: true,
        });
    }

    Err(AppError::fix(format!(
        "未找到资产 `{}`。{}",
        raw,
        available_hint(ctx)
    )))
}

fn resolve_absolute(ctx: &Ctx, path: &Path) -> Result<Option<AssetRef>, AppError> {
    for (root, is_image_root) in [(&ctx.file_dir, false), (&ctx.image_dir, true)] {
        let (root_canon, path_canon) = match (fs::canonicalize(root), fs::canonicalize(path)) {
            (Ok(r), Ok(p)) => (r, p),
            _ => continue,
        };
        if let Ok(rel) = path_canon.strip_prefix(&root_canon) {
            let rel = rel.to_string_lossy().replace('\\', "/");
            if rel.is_empty() {
                return Err(AppError::fix(format!(
                    "目标是目录而不是文件：{}。可用 glob=images/*.jpg 批量读取。",
                    path.display()
                )));
            }
            return Ok(Some(AssetRef {
                is_image: is_image_root || is_image_path(&rel),
                rel,
                abs: path_canon,
            }));
        }
    }
    Ok(None)
}

fn available_hint(ctx: &Ctx) -> String {
    let mut files: Vec<&str> = Vec::new();
    for name in [
        "full.md",
        "full.render.md",
        "content_list.json",
        "index.json",
        "state.json",
        "layout.json",
    ] {
        if ctx.file_dir.join(name).is_file() {
            files.push(name);
        }
    }
    let images = if ctx.image_dir.is_dir() {
        list_files(&ctx.image_dir)
            .iter()
            .filter(|(rel, _)| is_image_path(rel))
            .count()
    } else {
        0
    };
    let mut hint = format!(
        "可用文件：{}；图片 {} 张（images=序号、page=N、caption=关键词 或 glob=images/*.jpg）。",
        if files.is_empty() {
            "无".to_string()
        } else {
            files.join("、")
        },
        images
    );
    if images > 0 {
        hint.push_str(" 提示：卡片图片清单中的 #序号 可直接用于 images=序号。");
    }
    hint
}

fn is_image_path(rel: &str) -> bool {
    let ext = rel.rsplit('.').next().unwrap_or("").to_lowercase();
    IMAGE_EXTENSIONS.contains(&ext.as_str())
}

fn mime_of(rel: &str) -> &'static str {
    match rel.rsplit('.').next().unwrap_or("").to_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    }
}

fn format_bytes(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else if bytes >= 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{} B", bytes)
    }
}

// ---------------------------------------------------------------------------
// 行范围与文本读取
// ---------------------------------------------------------------------------

fn split_path_range(raw: &str) -> (String, Option<String>) {
    let t = raw.trim();
    let lower = t.to_lowercase();
    // 先处理 file:head:N / file:tail:N 的双冒号形态
    for marker in [":head:", ":tail:"] {
        if let Some(pos) = lower.rfind(marker) {
            let suffix = &t[pos + 1..];
            if is_line_spec(suffix) {
                return (t[..pos].trim().to_string(), Some(suffix.to_string()));
            }
        }
    }
    // 处理 file:M:N（第二个冒号前的部分才是路径）
    let colons: Vec<usize> = lower.match_indices(':').map(|(pos, _)| pos).collect();
    if colons.len() >= 2 {
        let pos = colons[colons.len() - 2];
        let suffix = &t[pos + 1..];
        if suffix.contains(':') && is_line_spec(suffix) {
            return (t[..pos].trim().to_string(), Some(suffix.to_string()));
        }
    }
    if let Some(pos) = t.rfind(':') {
        let suffix = &t[pos + 1..];
        if is_line_spec(suffix) {
            return (t[..pos].trim().to_string(), Some(suffix.to_string()));
        }
    }
    (t.to_string(), None)
}

fn is_line_spec(spec: &str) -> bool {
    let s = spec.trim();
    if s.eq_ignore_ascii_case("all") || s.eq_ignore_ascii_case("full") {
        return true;
    }
    if let Some(rest) = s
        .strip_prefix("head:")
        .or_else(|| s.strip_prefix("tail:"))
        .or_else(|| s.strip_prefix("HEAD:"))
        .or_else(|| s.strip_prefix("TAIL:"))
    {
        return rest.parse::<usize>().map(|n| n > 0).unwrap_or(false);
    }
    if let Some((a, b)) = s.split_once('-').or_else(|| s.split_once(':')) {
        return a.trim().parse::<usize>().is_ok() && b.trim().parse::<usize>().is_ok();
    }
    s.parse::<usize>().map(|n| n > 0).unwrap_or(false)
}

struct ParsedRange {
    actual_start: usize,
    actual_end: usize,
    truncated: bool,
    out_of_range: bool,
}

fn parse_line_range(spec: &str, total: usize) -> Result<ParsedRange, String> {
    let requested = spec.trim();
    let lower = requested.to_lowercase();
    if lower == "all" || lower == "full" {
        return Ok(ParsedRange {
            actual_start: if total == 0 { 0 } else { 1 },
            actual_end: total,
            truncated: false,
            out_of_range: false,
        });
    }

    let (start, end) = if let Some(rest) = lower.strip_prefix("head:") {
        let n = parse_positive(rest, requested)?;
        (1, n)
    } else if let Some(rest) = lower.strip_prefix("tail:") {
        let n = parse_positive(rest, requested)?;
        (total.saturating_sub(n).saturating_add(1).max(1), total)
    } else if let Some((a, b)) = lower.split_once('-').or_else(|| lower.split_once(':')) {
        (parse_positive(a, requested)?, parse_positive(b, requested)?)
    } else {
        let n = parse_positive(&lower, requested)?;
        (n, n)
    };
    if start > end {
        return Err(format!(
            "行范围无效：{}。起始行不能大于结束行。",
            requested
        ));
    }
    if total == 0 {
        return Ok(ParsedRange {
            actual_start: 0,
            actual_end: 0,
            truncated: true,
            out_of_range: false,
        });
    }
    if start > total {
        return Ok(ParsedRange {
            actual_start: total + 1,
            actual_end: total,
            truncated: true,
            out_of_range: true,
        });
    }
    let actual_end = end.min(total);
    Ok(ParsedRange {
        actual_start: start,
        actual_end,
        truncated: end > total,
        out_of_range: false,
    })
}

fn parse_positive(raw: &str, requested: &str) -> Result<usize, String> {
    raw.trim()
        .parse::<usize>()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(|| {
            format!(
                "行范围无效：{}。支持 head:N、tail:N、M-N、M:N、N、all。",
                requested
            )
        })
}

fn split_text_lines(text: &str) -> Result<Vec<String>, AppError> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    if normalized.is_empty() {
        return Ok(Vec::new());
    }
    let body = normalized.strip_suffix('\n').unwrap_or(&normalized);
    let mut lines = Vec::new();
    for line in body.split('\n') {
        if lines.len() >= MAX_TEXT_LINES {
            return Err(AppError::fix(format!(
                "文本行数超过 {} 行上限，无法一次性展开。请改用 lines=head:N / 行范围 / section / find。",
                MAX_TEXT_LINES
            )));
        }
        lines.push(line.to_string());
    }
    Ok(lines)
}

struct RangeBase {
    start: usize,
    end: usize,
    total: usize,
    section_label: Option<String>,
    section_hits: usize,
    truncated: bool,
    out_of_range: bool,
}

fn resolve_range(
    lines: &[String],
    request: &Request,
    spec_lines: Option<&str>,
    apply_default_cap: bool,
) -> Result<RangeBase, AppError> {
    let total = lines.len();
    let mut base_start = 1usize;
    let mut base_end = total;
    let mut section_label = None;
    let mut section_hits = 0;

    if let Some(query) = request.section.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let hit = find_section(lines, query)?;
        section_label = Some(hit.display());
        section_hits = hit.match_count;
        base_start = hit.start + 1;
        base_end = hit.end;
    }

    if total == 0 {
        return Ok(RangeBase {
            start: 0,
            end: 0,
            total,
            section_label,
            section_hits,
            truncated: false,
            out_of_range: false,
        });
    }
    if base_end < base_start {
        return Ok(RangeBase {
            start: 0,
            end: 0,
            total,
            section_label,
            section_hits,
            truncated: false,
            out_of_range: true,
        });
    }

    let spec = request.lines.as_deref().or(spec_lines);
    if let Some(spec) = spec {
        let parsed = parse_line_range(spec, base_end - base_start + 1).map_err(AppError::fix)?;
        if parsed.out_of_range {
            return Ok(RangeBase {
                start: 0,
                end: 0,
                total,
                section_label,
                section_hits,
                truncated: parsed.truncated,
                out_of_range: true,
            });
        }
        let start = base_start + parsed.actual_start - 1;
        let end = base_start + parsed.actual_end - 1;
        return Ok(RangeBase {
            start,
            end,
            total,
            section_label,
            section_hits,
            truncated: parsed.truncated,
            out_of_range: false,
        });
    }

    let length = base_end - base_start + 1;
    if apply_default_cap && length > DEFAULT_MAX_LINES {
        return Ok(RangeBase {
            start: base_start,
            end: base_start + DEFAULT_MAX_LINES - 1,
            total,
            section_label,
            section_hits,
            truncated: true,
            out_of_range: false,
        });
    }
    Ok(RangeBase {
        start: base_start,
        end: base_end,
        total,
        section_label,
        section_hits,
        truncated: false,
        out_of_range: false,
    })
}

fn read_text_file(rel: &str, abs: &Path) -> Result<String, AppError> {
    let meta = fs::metadata(abs)
        .map_err(|e| AppError::fix(format!("读取 {} 失败: {}", rel, e)))?;
    if meta.len() > MAX_TEXT_BYTES {
        return Err(AppError::fix(format!(
            "{} 为 {}，超过文本读取上限 {}。可用 lines 指定范围，或直接用 UrlFetch 读取。",
            rel,
            format_bytes(meta.len()),
            format_bytes(MAX_TEXT_BYTES)
        )));
    }
    fs::read_to_string(abs).map_err(|e| AppError::fix(format!("读取 {} 失败: {}", rel, e)))
}

fn read_text_spec(
    _ctx: &Ctx,
    spec: &TextSpec,
    request: &Request,
) -> Result<(ContentPart, Value), AppError> {
    let text = read_text_file(&spec.asset.rel, &spec.asset.abs)?;
    let lines = split_text_lines(&text)?;
    let range = resolve_range(&lines, request, spec.lines.as_deref(), true)?;

    let body_slice: &[String] = if range.start == 0 || range.end < range.start {
        &[]
    } else {
        &lines[range.start - 1..range.end]
    };
    let body = if body_slice.is_empty() {
        String::new()
    } else if request.show_line {
        number_lines(body_slice, range.start, None, None)
    } else {
        body_slice
            .iter()
            .map(|line| clip_line(line, MAX_LINE_CHARS))
            .collect::<Vec<_>>()
            .join("\n")
    };

    let mut header = format!("### `{}`", spec.asset.rel);
    if let Some(label) = &range.section_label {
        header.push_str(&format!(" · 章节「{}」", label));
    }
    if range.total == 0 {
        header.push_str(" · 空文件");
    } else if range.start == 0 {
        header.push_str(&format!(" · 无内容（超出全文 {} 行）", range.total));
    } else {
        header.push_str(&format!(
            " · L{}-{} / {} 行",
            range.start, range.end, range.total
        ));
    }
    if range.truncated {
        header.push_str(" · ⚠️ 已截断");
    }
    if range.section_hits > 1 {
        header.push_str(&format!(
            " · 同名章节 {} 个，已取第一个",
            range.section_hits
        ));
    }
    if range.truncated && range.start > 0 && range.end < range.total {
        let next_end = (range.end + DEFAULT_MAX_LINES).min(range.total);
        header.push_str(&format!(
            "\n- 继续读取：lines=\"{}-{}\"（lines=all 一次读完）",
            range.end + 1,
            next_end
        ));
    }
    if range.out_of_range {
        header.push_str("\n- 提示：起始行超出文件长度。");
    }

    let content = if body.is_empty() {
        header
    } else {
        format!("{}\n\n{}", header, fenced(&body, language_of(&spec.asset.rel)))
    };
    let data = json!({
        "path": spec.asset.rel,
        "total_lines": range.total,
        "start": range.start,
        "end": range.end,
        "truncated": range.truncated,
        "section": range.section_label,
    });
    Ok((ContentPart::text(content), data))
}

fn number_lines(
    lines: &[String],
    start: usize,
    marked: Option<&BTreeSet<usize>>,
    focus: Option<&str>,
) -> String {
    if lines.is_empty() {
        return String::new();
    }
    let last = start + lines.len() - 1;
    let width = last.to_string().len().max(2);
    lines
        .iter()
        .enumerate()
        .map(|(i, line)| {
            let no = start + i;
            let is_marked = marked.map(|m| m.contains(&no)).unwrap_or(false);
            let marker = if is_marked { ">" } else { " " };
            let display = if is_marked {
                match focus {
                    Some(needle) => clip_line_around(line, needle, MAX_LINE_CHARS),
                    None => clip_line(line, MAX_LINE_CHARS),
                }
            } else {
                clip_line(line, MAX_LINE_CHARS)
            };
            format!("{}{:>width$} | {}", marker, no, display, width = width)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn clip_line(line: &str, max_chars: usize) -> String {
    if line.chars().count() <= max_chars {
        line.to_string()
    } else {
        let mut out: String = line.chars().take(max_chars).collect();
        out.push_str(" …（本行已截断）");
        out
    }
}

/// 超长行按命中词居中截取，避免只看到行首而错过关键词。
fn clip_line_around(line: &str, needle: &str, max_chars: usize) -> String {
    let total = line.chars().count();
    if total <= max_chars {
        return line.to_string();
    }
    let needle_lower = needle.to_lowercase();
    let match_char = if needle_lower.is_empty() {
        None
    } else {
        line.to_lowercase()
            .find(&needle_lower)
            .map(|byte_pos| line[..byte_pos].chars().count())
    };
    let start_char = match match_char {
        Some(idx) => idx.saturating_sub(max_chars / 3),
        None => 0,
    };
    let end_char = (start_char + max_chars).min(total);
    let mut out = String::new();
    if start_char > 0 {
        out.push('…');
    }
    out.extend(line.chars().skip(start_char).take(end_char - start_char));
    if end_char < total {
        out.push_str(" …（本行已截断）");
    }
    out
}

fn language_of(rel: &str) -> &'static str {
    let ext = rel.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "md" | "markdown" => "markdown",
        "json" => "json",
        "html" | "htm" => "html",
        "csv" => "csv",
        "txt" => "text",
        _ => "text",
    }
}

fn fenced(body: &str, language: &str) -> String {
    let mut longest = 0usize;
    let mut run = 0usize;
    for ch in body.chars() {
        if ch == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    let fence = "`".repeat(longest.max(2) + 1);
    format!("{}{}\n{}\n{}", fence, language, body, fence)
}

// ---------------------------------------------------------------------------
// 章节定位
// ---------------------------------------------------------------------------

struct SectionHit {
    start: usize,
    /// 0-based exclusive
    end: usize,
    text: String,
    number: String,
    match_count: usize,
}

impl SectionHit {
    fn display(&self) -> String {
        format!("{} {}", self.number, self.text)
            .trim()
            .to_string()
    }
}

fn markdown_heading(line: &str) -> Option<(usize, String)> {
    let trimmed = line.trim_start();
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = trimmed[hashes..].trim_start();
    if rest.is_empty() {
        return None;
    }
    Some((hashes, rest.trim().to_string()))
}

fn find_section(lines: &[String], query: &str) -> Result<SectionHit, AppError> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Err(AppError::fix("section 不能为空。"));
    }

    let mut headings: Vec<(usize, usize, String, String)> = Vec::new();
    let mut counters: Vec<usize> = Vec::new();
    for (idx, line) in lines.iter().enumerate() {
        let Some((level, text)) = markdown_heading(line) else {
            continue;
        };
        while counters.len() < level {
            counters.push(0);
        }
        counters[level - 1] += 1;
        counters.truncate(level);
        // 仅展示时把未出现过的前导层级显示为 1（如从二级标题开始的文档），
        // 计数器本身保持标准层级，避免后续一级标题被抬到 2。
        let number = counters
            .iter()
            .map(|c| if *c == 0 { "1".to_string() } else { c.to_string() })
            .collect::<Vec<_>>()
            .join(".");
        headings.push((idx, level, text, number));
    }

    let mut matches = Vec::new();
    for heading in &headings {
        let (idx, level, text, number) = heading;
        let text_l = text.to_lowercase();
        let display_l = format!("{} {}", number, text_l);
        if text_l.contains(&q) || display_l.contains(&q) || number.eq_ignore_ascii_case(&q) {
            matches.push((*idx, *level, text.clone(), number.clone()));
        }
    }

    let Some(first) = matches.first() else {
        let mut hint = headings
            .iter()
            .take(8)
            .map(|(_, _, text, number)| format!("{} {}", number, text))
            .collect::<Vec<_>>()
            .join("；");
        if hint.is_empty() {
            hint = "（未识别到 Markdown 标题，可直接用 lines=范围 读取）".to_string();
        }
        return Err(AppError::fix(format!(
            "未找到章节「{}」。可用标题：{}",
            query, hint
        )));
    };

    let (start, level, text, number) = first.clone();
    let end = headings
        .iter()
        .find(|(idx, lvl, _, _)| *idx > start && *lvl <= level)
        .map(|(idx, _, _, _)| *idx)
        .unwrap_or(lines.len());

    Ok(SectionHit {
        start,
        end,
        text,
        number,
        match_count: matches.len(),
    })
}

// ---------------------------------------------------------------------------
// 关键词检索
// ---------------------------------------------------------------------------

struct FindOutput {
    parts: Vec<ContentPart>,
    files: Vec<Value>,
    total_hits: usize,
}

fn run_find(
    ctx: &Ctx,
    specs: &[TextSpec],
    request: &Request,
    keyword: &str,
) -> Result<FindOutput, AppError> {
    let needle = keyword.trim();
    if needle.is_empty() {
        return Err(AppError::fix("find 不能为空。"));
    }
    let context = request
        .context
        .unwrap_or(DEFAULT_FIND_CONTEXT)
        .min(10) as usize;

    let mut blocks: Vec<String> = Vec::new();
    let mut misses: Vec<String> = Vec::new();
    let mut files: Vec<Value> = Vec::new();
    let mut total_hits = 0usize;
    let mut shown = 0usize;

    for spec in specs {
        let text = match read_text_file(&spec.asset.rel, &spec.asset.abs) {
            Ok(t) => t,
            Err(e) => {
                misses.push(format!("- `{}`：{}", spec.asset.rel, e.message()));
                continue;
            }
        };
        let lines = match split_text_lines(&text) {
            Ok(lines) => lines,
            Err(error) => {
                misses.push(format!("- `{}`：{}", spec.asset.rel, error.message()));
                continue;
            }
        };
        let range = match resolve_range(&lines, request, spec.lines.as_deref(), false) {
            Ok(r) => r,
            Err(e) => {
                misses.push(format!("- `{}`：{}", spec.asset.rel, e.message()));
                continue;
            }
        };
        if range.start == 0 || range.end < range.start {
            files.push(json!({
                "path": spec.asset.rel,
                "hits": 0,
                "total_lines": range.total,
            }));
            continue;
        }

        let (hits, count) = find_hits(
            &lines,
            needle,
            context,
            range.start,
            range.end,
            FIND_MAX_HITS.saturating_sub(shown),
        );
        total_hits += count;
        for hit in &hits {
            blocks.push(render_hit_block(&spec.asset.rel, &lines, hit, needle));
            shown += 1;
        }
        files.push(json!({
            "path": spec.asset.rel,
            "hits": count,
            "total_lines": range.total,
        }));
    }

    let mut summary = format!(
        "## 🔎 阅读检索：{}（`{}`）× “{}”\n\n",
        ctx.title, ctx.paper_id, needle
    );
    summary.push_str(&format!(
        "- 命中 **{}** 处{}。\n",
        total_hits,
        if total_hits > shown {
            format!("（仅展示前 {} 处）", shown)
        } else {
            String::new()
        }
    ));
    summary.push_str("- 命中行以 `>` 标记；用 lines=\"M-N\" 读取完整上下文，或用 section=标题 按章节阅读。\n");
    if total_hits == 0 {
        summary.push_str("- 未找到匹配。可换用论文原文表述、缩短关键词，或先用 locate 在 content_list 中定位图注/表格。\n");
    }

    let mut parts = vec![ContentPart::text(summary)];
    if !blocks.is_empty() {
        parts.push(ContentPart::text(blocks.join("\n\n")));
    }
    if !misses.is_empty() {
        parts.push(ContentPart::text(misses.join("\n")));
    }
    Ok(FindOutput {
        parts,
        files,
        total_hits,
    })
}

struct FindHit {
    line: usize,
    context_start: usize,
    context_end: usize,
}

fn find_hits(
    lines: &[String],
    needle: &str,
    context: usize,
    start: usize,
    end: usize,
    max_store: usize,
) -> (Vec<FindHit>, usize) {
    if start == 0 || end < start || lines.is_empty() {
        return (Vec::new(), 0);
    }
    let needle = needle.to_lowercase();
    let mut stored = Vec::new();
    let mut count = 0usize;
    let start_idx = start.saturating_sub(1);
    let end_idx = end.min(lines.len());
    for idx in start_idx..end_idx {
        if !lines[idx].to_lowercase().contains(&needle) {
            continue;
        }
        count += 1;
        if stored.len() >= max_store {
            continue;
        }
        let line_no = idx + 1;
        stored.push(FindHit {
            line: line_no,
            context_start: line_no.saturating_sub(context).max(start),
            context_end: (line_no + context).min(end),
        });
    }
    (stored, count)
}

fn render_hit_block(rel: &str, lines: &[String], hit: &FindHit, needle: &str) -> String {
    let mut marked = BTreeSet::new();
    marked.insert(hit.line);
    let body = number_lines(
        &lines[hit.context_start - 1..hit.context_end],
        hit.context_start,
        Some(&marked),
        Some(needle),
    );
    format!(
        "#### `{}` · L{}\n{}",
        rel,
        hit.line,
        fenced(&body, "text")
    )
}

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

fn glob_assets(ctx: &Ctx, pattern: &str) -> Result<Vec<AssetRef>, AppError> {
    let pattern = pattern.trim().replace('\\', "/");
    let pattern = pattern.strip_prefix("./").unwrap_or(&pattern).to_string();
    if pattern.is_empty() {
        return Err(AppError::fix("glob 不能为空。"));
    }
    let segments: Vec<&str> = pattern.split('/').filter(|s| !s.is_empty()).collect();
    if pattern.chars().count() > MAX_GLOB_PATTERN_CHARS || segments.len() > MAX_GLOB_PATTERN_SEGMENTS {
        return Err(AppError::fix(format!(
            "glob 过长（最多 {} 字符 / {} 段）。请缩小子目录或改用 path=full.md。",
            MAX_GLOB_PATTERN_CHARS, MAX_GLOB_PATTERN_SEGMENTS
        )));
    }

    let mut out: Vec<AssetRef> = Vec::new();
    let mut seen = BTreeSet::new();
    for (root, image_root) in [(&ctx.file_dir, false), (&ctx.image_dir, true)] {
        if !root.is_dir() {
            continue;
        }
        for (rel, _) in list_files(root) {
            if !glob_match(&pattern, &rel) {
                continue;
            }
            let abs = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            let key = abs.to_string_lossy().to_lowercase();
            if !seen.insert(key) {
                continue;
            }
            out.push(AssetRef {
                is_image: image_root || is_image_path(&rel),
                rel,
                abs,
            });
        }
    }
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    out.truncate(MAX_GLOB_MATCHES);
    if out.is_empty() {
        return Err(AppError::fix(format!(
            "glob 未匹配到任何文件：{}。可用 glob=images/*.jpg、glob=**/*.md，或直接 path=full.md。",
            pattern
        )));
    }
    Ok(out)
}

fn glob_match(pattern: &str, path: &str) -> bool {
    let pattern = pattern.to_lowercase();
    let path = path.to_lowercase();
    if pattern.contains('/') {
        let pat: Vec<&str> = pattern.split('/').filter(|s| !s.is_empty()).collect();
        let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        match_segments(&pat, &parts)
    } else {
        let base = path.rsplit('/').next().unwrap_or(&path);
        wildcard(&pattern, base)
    }
}

fn match_segments(pattern: &[&str], parts: &[&str]) -> bool {
    let mut memo: HashMap<(usize, usize), bool> = HashMap::new();
    match_segments_at(pattern, parts, 0, 0, &mut memo)
}

fn match_segments_at(
    pattern: &[&str],
    parts: &[&str],
    pattern_index: usize,
    part_index: usize,
    memo: &mut HashMap<(usize, usize), bool>,
) -> bool {
    if let Some(hit) = memo.get(&(pattern_index, part_index)) {
        return *hit;
    }
    let result = if pattern_index == pattern.len() {
        part_index == parts.len()
    } else if pattern[pattern_index] == "**" {
        // 记忆化后每个 (pattern, part) 状态只计算一次，避免多段 ** 组合爆炸。
        match_segments_at(pattern, parts, pattern_index + 1, part_index, memo)
            || (part_index < parts.len()
                && match_segments_at(pattern, parts, pattern_index, part_index + 1, memo))
    } else if part_index == parts.len() {
        false
    } else {
        wildcard(pattern[pattern_index], parts[part_index])
            && match_segments_at(pattern, parts, pattern_index + 1, part_index + 1, memo)
    };
    memo.insert((pattern_index, part_index), result);
    result
}

fn wildcard(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let mut dp = vec![vec![false; t.len() + 1]; p.len() + 1];
    dp[0][0] = true;
    for i in 1..=p.len() {
        if p[i - 1] == '*' {
            dp[i][0] = dp[i - 1][0];
        }
    }
    for i in 1..=p.len() {
        for j in 1..=t.len() {
            dp[i][j] = match p[i - 1] {
                '*' => dp[i - 1][j] || dp[i][j - 1],
                '?' => dp[i - 1][j - 1],
                c => dp[i - 1][j - 1] && c == t[j - 1],
            };
        }
    }
    dp[p.len()][t.len()]
}

// ---------------------------------------------------------------------------
// 图片选择与 base64 输出
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
struct ContentImageMeta {
    caption: Option<String>,
    page_idx: Option<u64>,
}

/// 从 content_list 读取图片图注/页码，作为旧 index.json 缺失字段的回退。
fn content_list_image_meta(ctx: &Ctx) -> BTreeMap<String, ContentImageMeta> {
    let mut out = BTreeMap::new();
    let path = ctx.file_dir.join("content_list.json");
    let Ok(text) = fs::read_to_string(path) else {
        return out;
    };
    let Ok(Value::Array(blocks)) = serde_json::from_str::<Value>(&text) else {
        return out;
    };
    for block in blocks {
        if block.get("type").and_then(Value::as_str) != Some("image") {
            continue;
        }
        let Some(img_path) = block.get("img_path").and_then(Value::as_str) else {
            continue;
        };
        let rel = normalize_ref(img_path);
        if rel.is_empty() {
            continue;
        }
        let caption = crate::outline::first_text_list(
            &block,
            &["image_caption", "img_caption", "image_footnote", "img_footnote"],
        );
        let page_idx = block.get("page_idx").and_then(Value::as_u64);
        out.insert(rel, ContentImageMeta { caption, page_idx });
    }
    out
}

fn collect_images(
    ctx: &Ctx,
    meta: &BTreeMap<String, ContentImageMeta>,
) -> Vec<ImageCandidate> {
    let mut out: Vec<ImageCandidate> = Vec::new();
    let mut seen = BTreeSet::new();

    if let Some(index) = &ctx.index {
        for entry in &index.images {
            let rel = normalize_ref(&entry.rel);
            if rel.is_empty() || !is_image_path(&rel) {
                continue;
            }
            let abs = ctx
                .image_dir
                .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            if !abs.is_file() {
                continue;
            }
            seen.insert(rel.to_lowercase());
            let size = fs::metadata(&abs).map(|m| m.len()).unwrap_or(0);
            let fallback = meta.get(&rel);
            out.push(ImageCandidate {
                index: out.len() + 1,
                rel,
                abs,
                caption: entry
                    .caption
                    .clone()
                    .or_else(|| fallback.and_then(|m| m.caption.clone())),
                page_idx: entry
                    .page_idx
                    .or_else(|| fallback.and_then(|m| m.page_idx)),
                http_url: Some(entry.url.clone()),
                size,
            });
        }
    }

    if ctx.image_dir.is_dir() {
        for (rel, size) in list_files(&ctx.image_dir) {
            if !is_image_path(&rel) || !seen.insert(rel.to_lowercase()) {
                continue;
            }
            let abs = ctx
                .image_dir
                .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            let fallback = meta.get(&rel);
            out.push(ImageCandidate {
                index: out.len() + 1,
                rel,
                abs,
                caption: fallback.and_then(|m| m.caption.clone()),
                page_idx: fallback.and_then(|m| m.page_idx),
                http_url: None,
                size,
            });
        }
    }
    out
}

fn select_images(
    candidates: &[ImageCandidate],
    request: &Request,
    direct: &[AssetRef],
) -> Result<ImageSelection, AppError> {
    let mut selected = BTreeSet::new();
    let mut touched = false;

    for asset in direct {
        touched = true;
        if let Some(pos) = candidates.iter().position(|c| c.abs == asset.abs) {
            selected.insert(pos);
        }
    }

    let tokens = request.images.clone().unwrap_or_default();
    for token in tokens {
        let token = token.trim();
        if token.is_empty() {
            continue;
        }
        touched = true;
        if let Some(n) = parse_image_index(token) {
            if n == 0 || n > candidates.len() {
                return Err(AppError::fix(format!(
                    "图片序号 #{} 超出范围（共 {} 张）。{}",
                    n,
                    candidates.len(),
                    image_list_hint(candidates)
                )));
            }
            selected.insert(n - 1);
        } else if let Some(page) = parse_page_token(token) {
            apply_page_filter(candidates, page, &mut selected)?;
        } else if let Some(caption) = parse_caption_token(token) {
            apply_caption_filter(candidates, &caption, &mut selected);
        } else {
            apply_path_filter(candidates, token, &mut selected);
        }
    }

    if let Some(page) = request.page {
        touched = true;
        apply_page_filter(candidates, page, &mut selected)?;
    }
    if let Some(caption) = request.caption.as_deref() {
        touched = true;
        apply_caption_filter(candidates, caption, &mut selected);
    }

    if !touched {
        return Ok(ImageSelection {
            positions: Vec::new(),
            truncated: false,
        });
    }
    if selected.is_empty() {
        return Err(AppError::fix(format!(
            "未匹配到图片（共 {} 张）。可用 images=序号、page=N（1 起）、caption=关键词 或 glob=images/*.jpg。{}",
            candidates.len(),
            image_list_hint(candidates)
        )));
    }

    let mut positions: Vec<usize> = selected.into_iter().collect();
    let truncated = positions.len() > MAX_IMAGES;
    positions.truncate(MAX_IMAGES);
    Ok(ImageSelection {
        positions,
        truncated,
    })
}

fn parse_image_index(token: &str) -> Option<usize> {
    let body = token.strip_prefix('#').unwrap_or(token);
    if body.is_empty() || !body.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    body.parse::<usize>().ok()
}

fn parse_page_token(token: &str) -> Option<u64> {
    let lower = token.to_lowercase();
    for prefix in ["page:", "page=", "p", "页:"] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            if let Ok(n) = rest.trim().parse::<u64>() {
                return Some(n);
            }
        }
    }
    None
}

fn parse_caption_token(token: &str) -> Option<String> {
    let lower = token.to_lowercase();
    for prefix in ["caption:", "caption=", "cap:", "图注:", "图注="] {
        if lower.starts_with(prefix) {
            let value = token[prefix.len()..].trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn apply_page_filter(
    candidates: &[ImageCandidate],
    page: u64,
    selected: &mut BTreeSet<usize>,
) -> Result<(), AppError> {
    if page == 0 {
        return Err(AppError::fix("page 从 1 开始（对应卡片中的 p1、p2…）。"));
    }
    let target = page - 1;
    for (pos, cand) in candidates.iter().enumerate() {
        if cand.page_idx == Some(target) {
            selected.insert(pos);
        }
    }
    Ok(())
}

fn apply_caption_filter(
    candidates: &[ImageCandidate],
    caption: &str,
    selected: &mut BTreeSet<usize>,
) {
    let needle = caption.trim().to_lowercase();
    if needle.is_empty() {
        return;
    }
    for (pos, cand) in candidates.iter().enumerate() {
        if cand
            .caption
            .as_deref()
            .map(|c| c.to_lowercase().contains(&needle))
            .unwrap_or(false)
        {
            selected.insert(pos);
        }
    }
}

fn apply_path_filter(
    candidates: &[ImageCandidate],
    token: &str,
    selected: &mut BTreeSet<usize>,
) {
    let token = token.replace('\\', "/").to_lowercase();
    let token = token.strip_prefix("./").unwrap_or(&token).to_string();
    if token.is_empty() {
        return;
    }
    let token_base = token.rsplit('/').next().unwrap_or(&token);
    for (pos, cand) in candidates.iter().enumerate() {
        let rel = cand.rel.to_lowercase();
        let base = rel.rsplit('/').next().unwrap_or(&rel);
        if rel == token
            || base == token_base
            || rel.ends_with(&format!("/{}", token))
            || base.contains(token_base)
        {
            selected.insert(pos);
        }
    }
}

fn image_list_hint(candidates: &[ImageCandidate]) -> String {
    if candidates.is_empty() {
        return "当前论文没有可读取的图片资产。".to_string();
    }
    let shown = candidates
        .iter()
        .take(12)
        .map(|c| {
            let page = c
                .page_idx
                .map(|p| format!("p{}", p + 1))
                .unwrap_or_else(|| "p?".to_string());
            match &c.caption {
                Some(caption) => format!("#{} {} {}", c.index, page, truncate_chars(caption, 40)),
                None => format!("#{} {}", c.index, page),
            }
        })
        .collect::<Vec<_>>()
        .join("；");
    format!("前几张：{}。", shown)
}

fn truncate_chars(text: &str, max: usize) -> String {
    let mut out: String = text.chars().take(max).collect();
    if text.chars().count() > max {
        out.push('…');
    }
    out.replace('\n', " ")
}

fn render_images(
    _ctx: &Ctx,
    selected: &[ImageCandidate],
    with_base64: bool,
    truncated: bool,
) -> Result<(Vec<ContentPart>, Vec<Value>), AppError> {
    let mut blocks: Vec<ContentPart> = Vec::new();
    let mut data: Vec<Value> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut embedded = 0usize;
    let mut total_bytes = 0u64;

    for cand in selected {
        let header = image_header(cand);
        blocks.push(ContentPart::text(header));
        let mime = mime_of(&cand.rel);
        let mut entry = json!({
            "index": cand.index,
            "rel": cand.rel,
            "page": cand.page_idx.map(|p| p + 1),
            "caption": cand.caption,
            "bytes": cand.size,
            "mime": mime,
            "embedded": false,
        });

        if with_base64 {
            if cand.size > MAX_IMAGE_BYTES {
                skipped.push(format!(
                    "#{} {}（{}，超过单图上限 {}）",
                    cand.index,
                    cand.rel,
                    format_bytes(cand.size),
                    format_bytes(MAX_IMAGE_BYTES)
                ));
                data.push(entry);
                continue;
            }
            if total_bytes + cand.size > MAX_TOTAL_IMAGE_BYTES {
                skipped.push(format!(
                    "#{} {}（本次内嵌总量将超过 {}）",
                    cand.index,
                    cand.rel,
                    format_bytes(MAX_TOTAL_IMAGE_BYTES)
                ));
                data.push(entry);
                continue;
            }
            let bytes = match fs::read(&cand.abs) {
                Ok(b) => b,
                Err(e) => {
                    skipped.push(format!("#{} {}（读取失败：{}）", cand.index, cand.rel, e));
                    data.push(entry);
                    continue;
                }
            };
            total_bytes += bytes.len() as u64;
            let data_url = format!("data:{};base64,{}", mime, base64_encode(&bytes));
            blocks.push(ContentPart::image_url(data_url));
            embedded += 1;
            entry["embedded"] = json!(true);
            entry["bytes"] = json!(bytes.len());
        }
        data.push(entry);
    }

    let mut summary = format!(
        "## 🖼️ 图片读取：{}（`{}`）\n\n- 选中 {} 张 · 内嵌 base64 {} 张 · 原始总计 {}\n",
        _ctx.title,
        _ctx.paper_id,
        selected.len(),
        embedded,
        format_bytes(total_bytes)
    );
    if !with_base64 {
        summary.push_str("- 已关闭 base64（with_base64=false），仅返回图片清单与 HTTP URL；需要看图时设 with_base64=true 重发。\n");
    }
    if truncated {
        summary.push_str(&format!(
            "- ⚠️ 匹配图片超过单次上限 {} 张，仅返回前 {} 张；可用 page=N / caption=关键词 缩小范围。\n",
            MAX_IMAGES,
            selected.len()
        ));
    }
    if !skipped.is_empty() {
        summary.push_str(&format!("- 跳过：{}\n", skipped.join("；")));
    }
    if with_base64 {
        summary.push_str("- 图片已按 `image_url` data URL 附在各自标题之后，可直接查看。\n");
    }

    let mut parts = vec![ContentPart::text(summary)];
    parts.extend(blocks);
    Ok((parts, data))
}

fn image_header(cand: &ImageCandidate) -> String {
    let mut header = format!("### 图片 #{}", cand.index);
    if let Some(page) = cand.page_idx {
        header.push_str(&format!(" · p{}", page + 1));
    }
    if let Some(caption) = &cand.caption {
        let caption = caption.replace('\n', " ");
        if !caption.trim().is_empty() {
            header.push_str(&format!(" · {}", caption.trim()));
        }
    }
    header.push_str(&format!(
        "\n- 文件：`{}` · {} · {}",
        cand.rel,
        format_bytes(cand.size),
        mime_of(&cand.rel)
    ));
    if let Some(url) = &cand.http_url {
        header.push_str(&format!("\n- 渲染 URL：{}", url));
    }
    header
}

/// 标准 base64（RFC 4648，带 `=` 填充）。
fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((n >> 18) & 0x3F) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[((n >> 6) & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(n & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ImageEntry;

    fn request() -> Request {
        Request {
            command: "read".to_string(),
            file_path: None,
            model_version: None,
            is_ocr: false,
            language: None,
            enable_formula: true,
            enable_table: true,
            batch_id: None,
            paper_id: Some("paper_test0000000000".to_string()),
            paper_ids: None,
            batch_ids: None,
            all: false,
            title: None,
            status: None,
            query: None,
            limit: None,
            sort: None,
            group_by: None,
            workers: None,
            recursive: true,
            apply: false,
            url: None,
            file_paths: None,
            urls: None,
            keyword: None,
            path: None,
            paths: None,
            lines: None,
            glob: None,
            find: None,
            section: None,
            images: None,
            page: None,
            caption: None,
            context: None,
            show_line: true,
            with_base64: true,
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("mineruparser_read_{}_{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn base64_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(&[0xFF, 0xD8, 0xFF]), "/9j/");
    }

    #[test]
    fn line_range_forms() {
        let r = parse_line_range("head:10", 100).unwrap();
        assert_eq!((r.actual_start, r.actual_end), (1, 10));
        let r = parse_line_range("tail:10", 100).unwrap();
        assert_eq!((r.actual_start, r.actual_end), (91, 100));
        let r = parse_line_range("20-30", 100).unwrap();
        assert_eq!((r.actual_start, r.actual_end), (20, 30));
        let r = parse_line_range("7", 100).unwrap();
        assert_eq!((r.actual_start, r.actual_end), (7, 7));
        let r = parse_line_range("90-120", 100).unwrap();
        assert_eq!((r.actual_start, r.actual_end), (90, 100));
        assert!(r.truncated);
        assert!(parse_line_range("90-120", 50).unwrap().out_of_range);
        assert!(parse_line_range("0-2", 100).is_err());
        assert!(parse_line_range("9-3", 100).is_err());
        let r = parse_line_range("all", 42).unwrap();
        assert_eq!((r.actual_start, r.actual_end), (1, 42));
    }

    #[test]
    fn path_range_splits_on_last_colon() {
        let (p, r) = split_path_range("full.md:100-160");
        assert_eq!(p, "full.md");
        assert_eq!(r.as_deref(), Some("100-160"));
        let (p, r) = split_path_range("D:\\papers\\full.md:head:20");
        assert_eq!(p, "D:\\papers\\full.md");
        assert_eq!(r.as_deref(), Some("head:20"));
        let (p, r) = split_path_range("images/fig_1.jpg");
        assert_eq!(p, "images/fig_1.jpg");
        assert_eq!(r, None);
        let (p, r) = split_path_range("full.md:10:20");
        assert_eq!(p, "full.md");
        assert_eq!(r.as_deref(), Some("10:20"));
        let (p, r) = split_path_range("D:\\papers\\full.md:10-20");
        assert_eq!(p, "D:\\papers\\full.md");
        assert_eq!(r.as_deref(), Some("10-20"));
    }

    #[test]
    fn section_lookup_and_numbering() {
        let text = "# Intro\n\nBody\n\n## 3.2 Experimental Setup\n\ndetails\n\n### Sub\n\nsub details\n\n## 3.3 Results\n\nnumbers";
        let lines = split_text_lines(text).unwrap();
        let hit = find_section(&lines, "Experimental Setup").unwrap();
        assert_eq!(hit.start, 4);
        assert_eq!(hit.end, 12);
        assert_eq!(hit.display(), "1.1 3.2 Experimental Setup");
        let hit = find_section(&lines, "1.1").unwrap();
        assert_eq!(hit.start, 4);
        let hit = find_section(&lines, "Results").unwrap();
        assert_eq!(hit.start, 12);
        assert_eq!(hit.end, 15);
        assert!(find_section(&lines, "不存在").is_err());

        let level2 = split_text_lines("## A\ntext\n## B\nmore").unwrap();
        assert_eq!(find_section(&level2, "B").unwrap().display(), "1.2 B");
    }

    #[test]
    fn glob_matching() {
        assert!(glob_match("images/*.jpg", "images/fig 1.jpg"));
        assert!(glob_match("*.jpg", "images/fig.jpg"));
        assert!(glob_match("**/*.md", "a/b/full.md"));
        assert!(glob_match("**/*.png", "fig.png"));
        assert!(!glob_match("images/*.jpg", "images/nested/fig.jpg"));
        assert!(glob_match("images/**", "images/nested/fig.jpg"));
        assert!(wildcard("fig_?.png", "fig_1.png"));
        assert!(!wildcard("fig_?.png", "fig_12.png"));
    }

    #[test]
    fn long_lines_are_clipped() {
        let long = "x".repeat(MAX_LINE_CHARS + 50);
        let rendered = number_lines(&[long.clone()], 1, None, None);
        assert!(rendered.contains("本行已截断"));
        assert!(rendered.chars().count() < MAX_LINE_CHARS + 80);
        assert_eq!(clip_line("short", MAX_LINE_CHARS), "short");

        let mut line = "a".repeat(2000);
        line.push_str(" needle here ");
        line.push_str(&"b".repeat(2000));
        let focused = clip_line_around(&line, "needle", 100);
        assert!(focused.contains("needle here"), "{}", focused);
        assert!(focused.starts_with('…'));
        assert!(focused.ends_with("本行已截断）"));
    }

    #[test]
    fn find_hits_with_context() {
        let lines = split_text_lines("alpha\nbeta keyword gamma\nomega\nkeyword again\ndelta").unwrap();
        let (hits, count) = find_hits(&lines, "KEYWORD", 1, 1, 5, 10);
        assert_eq!(count, 2);
        assert_eq!(hits[0].line, 2);
        assert_eq!((hits[0].context_start, hits[0].context_end), (1, 3));
        assert_eq!(hits[1].line, 4);
        let (hits, count) = find_hits(&lines, "keyword", 1, 1, 5, 1);
        assert_eq!(count, 2);
        assert_eq!(hits.len(), 1);
        let (hits, count) = find_hits(&lines, "keyword", 1, 1, 5, 0);
        assert_eq!(count, 2);
        assert!(hits.is_empty());
    }

    fn image_candidates() -> Vec<ImageCandidate> {
        vec![
            ImageCandidate {
                index: 1,
                rel: "images/a.jpg".into(),
                abs: PathBuf::from("a"),
                caption: Some("Figure 1: setup".into()),
                page_idx: Some(2),
                http_url: None,
                size: 10,
            },
            ImageCandidate {
                index: 2,
                rel: "images/b.png".into(),
                abs: PathBuf::from("b"),
                caption: None,
                page_idx: Some(2),
                http_url: None,
                size: 20,
            },
            ImageCandidate {
                index: 3,
                rel: "images/c.jpg".into(),
                abs: PathBuf::from("c"),
                caption: Some("Figure 3: results".into()),
                page_idx: Some(7),
                http_url: None,
                size: 30,
            },
        ]
    }

    #[test]
    fn image_selection_filters() {
        let candidates = image_candidates();
        let mut req = request();
        req.page = Some(3);
        let selection = select_images(&candidates, &req, &[]).unwrap();
        assert_eq!(selection.positions, vec![0, 1]);

        let mut req = request();
        req.images = Some(vec!["#3".into()]);
        let selection = select_images(&candidates, &req, &[]).unwrap();
        assert_eq!(selection.positions, vec![2]);

        let mut req = request();
        req.caption = Some("results".into());
        let selection = select_images(&candidates, &req, &[]).unwrap();
        assert_eq!(selection.positions, vec![2]);

        let mut req = request();
        req.images = Some(vec!["a.jpg".into()]);
        let selection = select_images(&candidates, &req, &[]).unwrap();
        assert_eq!(selection.positions, vec![0]);

        let mut req = request();
        req.images = Some(vec!["9".into()]);
        assert!(select_images(&candidates, &req, &[]).is_err());

        let mut req = request();
        req.page = Some(0);
        assert!(select_images(&candidates, &req, &[]).is_err());
    }

    #[test]
    fn run_read_text_and_image_end_to_end() {
        let base = temp_dir("e2e");
        let file_dir = base.join("file/mineru/paper_test");
        let image_dir = base.join("image/mineru/paper_test/images");
        fs::create_dir_all(&file_dir).unwrap();
        fs::create_dir_all(&image_dir).unwrap();
        fs::write(
            file_dir.join("full.md"),
            "# Title\n\nline two\nline three\nline four\n",
        )
        .unwrap();
        fs::write(
            file_dir.join("content_list.json"),
            r#"[{"type":"image","img_path":"images/fig1.png","image_caption":["Figure 1: demo"],"page_idx":1}]"#,
        )
        .unwrap();
        fs::write(image_dir.join("fig1.png"), [0x89u8, 0x50, 0x4E, 0x47]).unwrap();

        let index = IndexDoc {
            paper_id: "paper_test".into(),
            title: "Demo".into(),
            images: vec![ImageEntry {
                rel: "images/fig1.png".into(),
                url: "http://localhost/pw=/images/fig1.png".into(),
                caption: None,
                page_idx: None,
            }],
            ..Default::default()
        };
        let ctx = Ctx {
            paper_id: "paper_test".into(),
            title: "Demo".into(),
            file_dir,
            image_dir: base.join("image/mineru/paper_test"),
            index: Some(index),
        };

        let mut req = request();
        req.lines = Some("2-3".into());
        let (parts, data) = run_read(&ctx, &req).unwrap();
        let text = parts
            .iter()
            .filter_map(|part| match part {
                ContentPart::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("L2-3 / 5 行"), "{}", text);
        assert!(text.contains("line two"));
        assert!(!text.contains("line four"));
        assert!(data.unwrap()["files"][0]["start"] == 2);

        let mut req = request();
        req.page = Some(2);
        let (parts, data) = run_read(&ctx, &req).unwrap();
        let has_image = parts.iter().any(|p| matches!(p, ContentPart::ImageUrl { image_url } if image_url.url.starts_with("data:image/png;base64,")));
        assert!(has_image);
        let headers = parts
            .iter()
            .filter_map(|p| match p {
                ContentPart::Text { text } if text.starts_with("### 图片") => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(headers.contains("Figure 1: demo"), "{}", headers);
        assert!(data.unwrap()["images"][0]["caption"] == "Figure 1: demo");

        let mut req = request();
        req.caption = Some("demo".into());
        let (parts, _) = run_read(&ctx, &req).unwrap();
        assert!(parts.iter().any(|p| matches!(p, ContentPart::ImageUrl { .. })));

        let mut req = request();
        req.find = Some("line three".into());
        let (parts, data) = run_read(&ctx, &req).unwrap();
        let text = parts
            .iter()
            .filter_map(|part| match part {
                ContentPart::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("命中 **1** 处"), "{}", text);
        assert_eq!(data.unwrap()["find"]["hits"], 1);

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn traversal_and_bad_paper_id_rejected() {
        assert!(validate_paper_id("paper_abcd1234").is_ok());
        assert!(validate_paper_id("../etc/passwd").is_err());
        assert!(validate_paper_id("paper_../../x").is_err());
        assert!(validate_paper_id("paper_").is_err());

        let base = temp_dir("traversal");
        let ctx = Ctx {
            paper_id: "paper_x".into(),
            title: "x".into(),
            file_dir: base.join("file"),
            image_dir: base.join("image"),
            index: None,
        };
        fs::create_dir_all(&ctx.file_dir).unwrap();
        assert!(resolve_asset(&ctx, "../escape.md").is_err());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn pathological_text_and_glob_inputs_are_bounded() {
        assert!(split_text_lines("").unwrap().is_empty());
        let flood = "\n".repeat(MAX_TEXT_LINES + 1);
        let error = split_text_lines(&flood).unwrap_err();
        assert!(error.message().contains("行数"), "{}", error.message());

        assert!(parse_positive("999999999999999999999999999999", "huge").is_err());

        // 60 段 ** 与 60 段路径：无记忆化时组合数 2^60，测试会挂起
        let pattern = vec!["**"; 60];
        let parts = vec!["d"; 60];
        assert!(match_segments(&pattern, &parts));
        let mut pattern = vec!["**"; 59];
        pattern.push("x");
        assert!(!match_segments(&pattern, &["d"; 61]));
    }
}
