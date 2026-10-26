//! 资产落盘、图片路径重写与 HTTP URL 构建。

use crate::error::AppError;
use crate::protocol::ImageEntry;
use crate::zip_safe::list_files;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "svg", "bmp"];

/// 落盘后的产物集合，供 main 生成卡片与 index.json。
pub struct AssetsOutcome {
    pub md_text: String,
    pub render_md: String,
    pub content_list_text: Option<String>,
    pub has_layout: bool,
    pub missing_refs: usize,
    pub images: Vec<ImageEntry>,
    pub stats: crate::outline::ContentStats,
}

/// URL 上下文：来自环境变量（Plugin.js 注入）。
pub struct UrlContext {
    pub port: String,
    pub image_key: String,
    pub file_key: String,
}

impl UrlContext {
    pub fn from_env() -> Self {
        UrlContext {
            port: std::env::var("SERVER_PORT").unwrap_or_else(|_| "6005".to_string()),
            image_key: std::env::var("IMAGESERVER_IMAGE_KEY").unwrap_or_default(),
            file_key: std::env::var("IMAGESERVER_FILE_KEY").unwrap_or_default(),
        }
    }

    pub fn http_base(&self) -> String {
        format!("http://localhost:{}", self.port)
    }

    /// 图片 HTTP URL：/pw={IMAGE_KEY}/images/mineru/{asset_dir}/{rel}
    /// （asset_dir 为标题化目录叶子名，rel 为相对 md 的引用路径）
    pub fn image_url(&self, asset_dir: &str, rel: &str) -> String {
        format!(
            "{}/pw={}/images/mineru/{}/{}",
            self.http_base(),
            self.image_key,
            percent_encode_path(asset_dir),
            percent_encode_path(rel)
        )
    }

    /// 文件 HTTP URL：/pw={FILE_KEY}/files/mineru/{asset_dir}/{rel}
    pub fn file_url(&self, asset_dir: &str, rel: &str) -> String {
        format!(
            "{}/pw={}/files/mineru/{}/{}",
            self.http_base(),
            self.file_key,
            percent_encode_path(asset_dir),
            percent_encode_path(rel)
        )
    }
}

/// 本地直读 URL（UrlFetch 用，Windows 路径转 POSIX）。
pub fn file_url_of(path: &Path) -> String {
    format!("file:///{}", path.to_string_lossy().replace('\\', "/"))
}

fn ext_of(rel: &str) -> String {
    rel.rsplit('.')
        .next()
        .unwrap_or("")
        .to_lowercase()
}

/// 在解压产物中定位关键文件（模式匹配，零硬编码，兼容 ZIP 内任意子目录）。
struct Scanned {
    md: Option<String>,
    content_list: Option<String>,
    layout: Option<String>,
    images: Vec<String>,
}

fn scan(work_dir: &Path) -> Scanned {
    let files = list_files(work_dir);
    let mut md: Option<String> = None;
    let mut content_list: Option<String> = None;
    let mut layout: Option<String> = None;
    let mut images: Vec<String> = Vec::new();

    for (rel, _size) in files {
        let name = rel.rsplit('/').next().unwrap_or("").to_lowercase();
        let is_full = name == "full.md";
        let is_md = name.ends_with(".md");
        if (is_full || (is_md && md.is_none())) && rel != "full.render.md" {
            // full.md 优先；否则取第一个 .md（list_files 已按路径排序，结果稳定）
            if md.is_none() || is_full {
                md = Some(rel.clone());
            }
        } else if name.ends_with("_content_list.json") || name == "content_list.json" {
            if content_list.is_none() {
                content_list = Some(rel.clone());
            }
        } else if name == "layout.json" || name.ends_with("_middle.json") {
            if layout.is_none() {
                layout = Some(rel.clone());
            }
        } else if IMAGE_EXTENSIONS.contains(&ext_of(&rel).as_str()) {
            images.push(rel.clone());
        }
    }
    Scanned {
        md,
        content_list,
        layout,
        images,
    }
}

/// 归一化 md 中的图片引用：统一分隔符、消费 `.` 与 `..`、去空白。
pub fn normalize_ref(raw: &str) -> String {
    let t = raw.trim();
    let t = t.trim_start_matches('<').trim_end_matches('>');
    let t = t.replace('\\', "/");
    let mut stack: Vec<&str> = Vec::new();
    for comp in t.split('/') {
        match comp {
            "" | "." => {}
            ".." => {
                stack.pop();
            }
            other => stack.push(other),
        }
    }
    stack.join("/")
}

/// 相对 md 所在目录计算图片的归一化引用路径（ZIP 内子结构保持）。
/// image_rel 相对 work 根目录；若与 md 同子树则剥掉 md 目录前缀，否则原样使用。
fn rel_to_md_dir(md_rel: &str, image_rel: &str) -> String {
    let md_dir = match md_rel.rfind('/') {
        Some(pos) => &md_rel[..pos],
        None => "",
    };
    let stripped = if md_dir.is_empty() {
        image_rel
    } else {
        match image_rel.strip_prefix(&format!("{}/", md_dir)) {
            Some(rest) => rest,
            None => image_rel,
        }
    };
    normalize_ref(stripped)
}

/// 单个分片（或单文件）解压产物的扫描结果（纯读取，不落盘）。
pub struct ChunkScan {
    pub md_text: String,
    pub content_list_text: Option<String>,
    pub has_layout: bool,
    /// (相对 md 引用形态的 key, 源文件绝对路径)
    pub images: Vec<(String, PathBuf)>,
}

/// 扫描一个解压后的工作目录，读取 md / content_list / 图片清单。
pub fn scan_chunk(work_dir: &Path) -> Result<ChunkScan, AppError> {
    let scanned = scan(work_dir);
    let md_rel = scanned
        .md
        .clone()
        .ok_or_else(|| AppError::fix("解压产物中未找到任何 .md 文件"))?;
    let md_text = fs::read_to_string(work_dir.join(&md_rel))
        .map_err(|e| AppError::fix(format!("读取 md 失败: {}", e)))?;
    let content_list_text = scanned
        .content_list
        .as_deref()
        .map(|rel| fs::read_to_string(work_dir.join(rel)))
        .transpose()
        .map_err(|e| AppError::fix(format!("读取 content_list 失败: {}", e)))?;
    let images = scanned
        .images
        .iter()
        .map(|rel| (rel_to_md_dir(&md_rel, rel), work_dir.join(rel)))
        .filter(|(key, _)| !key.is_empty())
        .collect();
    Ok(ChunkScan {
        md_text,
        content_list_text,
        has_layout: scanned.layout.is_some(),
        images,
    })
}

/// 一个待合并的分片输入。
pub struct ChunkInput {
    pub scan: ChunkScan,
    /// 原始 PDF 中该片起始页（0-based）
    pub start_page: u64,
    /// 原始 PDF 中该片结束页（0-based，不含）
    pub end_page: u64,
    /// 单文件模式：md 不加分片分隔注释
    pub single: bool,
}

/// content_list 中每块的 page_idx 加偏移（原地修改 Value 数组）。
fn offset_content_list(text: &str, offset: u64) -> Result<Vec<serde_json::Value>, AppError> {
    let blocks: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| AppError::fix(format!("content_list 解析失败: {}", e)))?;
    let mut arr = match blocks {
        serde_json::Value::Array(a) => a,
        _ => return Err(AppError::fix("content_list 不是 JSON 数组".to_string())),
    };
    if offset > 0 {
        for block in arr.iter_mut() {
            if let Some(p) = block.get_mut("page_idx") {
                if let Some(n) = p.as_i64() {
                    if n >= 0 {
                        *p = serde_json::json!(n + offset as i64);
                    }
                }
            }
        }
    }
    Ok(arr)
}

fn part_separator(index: usize, start_page: u64, end_page: u64) -> String {
    format!(
        "\n\n<!-- ===== 分片 {}（原书第 {}-{} 页）===== -->\n\n",
        index + 1,
        start_page + 1,
        end_page
    )
}

/// 合并落盘：图片入 image 目录，md / content_list（页偏移合并）入 file 目录，
/// 生成渲染副本。source.zip 由调用方（mineru 下载）直接落在 file_dir。
pub fn build_assets_from_chunks(
    chunks: Vec<ChunkInput>,
    project_base: &Path,
    asset_dir: &str,
    urls: &UrlContext,
) -> Result<AssetsOutcome, AppError> {
    if chunks.is_empty() {
        return Err(AppError::fix("没有任何分片可合并".to_string()));
    }
    let file_dir = project_base.join("file").join("mineru").join(asset_dir);
    let image_root = project_base.join("image").join("mineru").join(asset_dir);
    fs::create_dir_all(&file_dir)
        .map_err(|e| AppError::fix(format!("创建资产目录失败: {}", e)))?;
    fs::create_dir_all(&image_root)
        .map_err(|e| AppError::fix(format!("图片目录创建失败: {}", e)))?;

    // 图片落盘：key = 相对 md 目录的归一化路径（md 引用形态），跨分片去重
    let mut rel_to_src: BTreeMap<String, PathBuf> = BTreeMap::new();
    let mut basename_to_rel: BTreeMap<String, String> = BTreeMap::new();
    for chunk in &chunks {
        for (key, src) in &chunk.scan.images {
            if key.is_empty() || rel_to_src.contains_key(key) {
                continue;
            }
            let dest = image_root.join(key.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = dest.parent() {
                let _ = fs::create_dir_all(parent);
            }
            fs::copy(src, &dest)
                .map_err(|e| AppError::fix(format!("复制图片失败 {}: {}", key, e)))?;
            rel_to_src.insert(key.clone(), dest);
            let base = key.rsplit('/').next().unwrap_or(key).to_lowercase();
            basename_to_rel.entry(base).or_insert(key.clone());
        }
    }

    // 合并 md 与 content_list（分片间加分隔注释，page_idx 加偏移）
    let mut md_text = String::new();
    let mut merged_blocks: Vec<serde_json::Value> = Vec::new();
    let mut has_layout = false;
    for (index, chunk) in chunks.iter().enumerate() {
        if index > 0 {
            md_text.push_str(&part_separator(index, chunk.start_page, chunk.end_page));
        }
        md_text.push_str(&chunk.scan.md_text);
        has_layout = has_layout || chunk.scan.has_layout;
        if let Some(text) = &chunk.scan.content_list_text {
            let mut blocks = offset_content_list(text, chunk.start_page)?;
            merged_blocks.append(&mut blocks);
        }
    }
    let content_list_text = if merged_blocks.is_empty() {
        chunks[0].scan.content_list_text.clone()
    } else {
        Some(serde_json::to_string(&serde_json::Value::Array(merged_blocks))
            .map_err(|e| AppError::fix(format!("合并 content_list 失败: {}", e)))?)
    };

    fs::write(file_dir.join("full.md"), &md_text)
        .map_err(|e| AppError::fix(format!("写入 full.md 失败: {}", e)))?;
    if let Some(text) = &content_list_text {
        fs::write(file_dir.join("content_list.json"), text)
            .map_err(|e| AppError::fix(format!("写入 content_list.json 失败: {}", e)))?;
    }

    // 渲染副本：逐分片重写图片引用（共享全部图片查找表），再按分隔拼接
    let missing = std::cell::Cell::new(0usize);
    let lookup = |target: &str| -> Option<String> {
        let key = normalize_ref(target);
        if let Some(rel) = rel_to_src.keys().find(|k| **k == key) {
            return Some(urls.image_url(asset_dir, rel));
        }
        if let Some(rel) =
            basename_to_rel.get(&key.rsplit('/').next().unwrap_or("").to_lowercase())
        {
            return Some(urls.image_url(asset_dir, rel));
        }
        None
    };
    let mut render_md = String::new();
    for (index, chunk) in chunks.iter().enumerate() {
        if index > 0 {
            render_md.push_str(&part_separator(index, chunk.start_page, chunk.end_page));
        }
        render_md.push_str(&rewrite_md_images(&chunk.scan.md_text, &lookup, &missing));
    }
    fs::write(file_dir.join("full.render.md"), &render_md)
        .map_err(|e| AppError::fix(format!("写入 full.render.md 失败: {}", e)))?;

    // content_list 图片清单 → 卡片条目
    let stats = crate::outline::analyze(content_list_text.as_deref().unwrap_or(""));
    let images = stats
        .images
        .iter()
        .filter_map(|img| {
            let key = normalize_ref(&img.img_path);
            let matched = rel_to_src
                .keys()
                .find(|k| **k == key)
                .cloned()
                .or_else(|| {
                    basename_to_rel
                        .get(&key.rsplit('/').next().unwrap_or("").to_lowercase())
                        .cloned()
                })?;
            Some(ImageEntry {
                rel: matched.clone(),
                url: urls.image_url(asset_dir, &matched),
                caption: img.caption.clone(),
                page_idx: img.page_idx,
            })
        })
        .collect();

    Ok(AssetsOutcome {
        md_text,
        render_md,
        content_list_text,
        has_layout,
        missing_refs: missing.get(),
        images,
        stats,
    })
}

/// 单文件便捷入口（V1 行为）：扫描 + 合并落盘 + layout 复制。
pub fn build_assets(
    work_dir: &Path,
    project_base: &Path,
    asset_dir: &str,
    urls: &UrlContext,
) -> Result<AssetsOutcome, AppError> {
    let scanned = scan(work_dir);
    let layout_src = scanned.layout.as_ref().map(|rel| work_dir.join(rel));
    let scan = scan_chunk(work_dir)?;
    let outcome = build_assets_from_chunks(
        vec![ChunkInput {
            scan,
            start_page: 0,
            end_page: 0,
            single: true,
        }],
        project_base,
        asset_dir,
        urls,
    )?;
    // 单文件模式保留 layout.json 复制（分片模式不合并 layout）
    if let Some(src) = layout_src {
        if src.is_file() {
            let bytes = fs::read(&src)
                .map_err(|e| AppError::fix(format!("读取 layout 失败: {}", e)))?;
            let file_dir = project_base.join("file").join("mineru").join(asset_dir);
            fs::write(file_dir.join("layout.json"), bytes)
                .map_err(|e| AppError::fix(format!("写入 layout.json 失败: {}", e)))?;
        }
    }
    Ok(outcome)
}

/// 重写 md 中全部 `![alt](target)` 图片引用；找不到目标文件时保留原样并计数。
/// 未闭合的引用不属于完整图片语法，原样保留且不计数。
pub fn rewrite_md_images<F: Fn(&str) -> Option<String>>(
    md: &str,
    lookup: F,
    missing: &std::cell::Cell<usize>,
) -> String {
    let bytes = md.as_bytes();
    let mut out = String::with_capacity(md.len() + 256);
    let mut i = 0;

    while i < bytes.len() {
        let handled = 'img: {
            if !(bytes[i] == b'!' && i + 1 < bytes.len() && bytes[i + 1] == b'[') {
                break 'img false;
            }
            // 定位匹配的 ']'（容忍 alt 中的嵌套 '[' 与转义）
            let mut depth = 1;
            let mut j = i + 2;
            while j < bytes.len() && depth > 0 {
                match bytes[j] {
                    b'[' => depth += 1,
                    b']' => depth -= 1,
                    b'\\' => j += 1,
                    _ => {}
                }
                j += 1;
            }
            if depth != 0 || j >= bytes.len() || bytes[j] != b'(' {
                break 'img false;
            }
            // 先找配对的 ')'：找不到说明不是完整图片语法
            let mut k = j + 1;
            let mut pdepth = 1;
            let mut found = None;
            while k < bytes.len() {
                match bytes[k] {
                    b'(' => pdepth += 1,
                    b')' => {
                        pdepth -= 1;
                        if pdepth == 0 {
                            found = Some(k);
                            break;
                        }
                    }
                    _ => {}
                }
                k += 1;
            }
            let close = match found {
                Some(c) => c,
                None => break 'img false,
            };
            // target 终点：close 之前、深度 1 处的首个空白（其后是 "title" 部分）
            let mut end = close;
            let mut m = j + 1;
            let mut d = 1;
            while m < close {
                match bytes[m] {
                    b'(' => d += 1,
                    b')' => d -= 1,
                    c if (c as char).is_whitespace() && d == 1 => {
                        end = m;
                        break;
                    }
                    _ => {}
                }
                m += 1;
            }
            let target = &md[j + 1..end];
            let alt = &md[i + 2..j - 1];
            match lookup(target) {
                Some(url) => {
                    out.push_str("![");
                    out.push_str(alt);
                    out.push_str("](");
                    out.push_str(&url);
                    out.push_str(&md[end..=end]); // ')' 或空白（title 部分原样接续）
                }
                None => {
                    missing.set(missing.get() + 1);
                    out.push_str(&md[i..=end]);
                }
            }
            i = end + 1;
            true
        };
        if !handled {
            // 非图片语法，原样搬一个字符（按 UTF-8 序列搬，避免拆散多字节字符）
            let ch_len = utf8_len(bytes[i]);
            out.push_str(&md[i..(i + ch_len).min(md.len())]);
            i += ch_len;
        }
    }
    out
}

fn utf8_len(b: u8) -> usize {
    match b {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        _ => 4,
    }
}

/// URL 路径百分号编码：保留 `/` 与 unreserved 字符。
pub fn percent_encode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_ref_forms() {
        assert_eq!(normalize_ref("./images/fig_1.jpg"), "images/fig_1.jpg");
        assert_eq!(normalize_ref("images\\fig_1.jpg"), "images/fig_1.jpg");
        assert_eq!(normalize_ref("../images/fig_1.jpg"), "images/fig_1.jpg");
        assert_eq!(normalize_ref("<images/a b.jpg>"), "images/a b.jpg");
        assert_eq!(normalize_ref("a/b/../../c.png"), "c.png");
    }

    #[test]
    fn rewrite_basic_and_missing() {
        let md = "# T\n\n![图1](images/fig_1.jpg)\n\n![alt [x]](./images/fig_2.png \"Fig 2\")\n\n![missing](images/nope.jpg)\n\n普通文本 ![未闭合](images/x.jpg\n";
        let missing = std::cell::Cell::new(0usize);
        let out = rewrite_md_images(md, |t| {
            if t.contains("fig_1") {
                Some("http://h/1.jpg".to_string())
            } else if t.contains("fig_2") {
                Some("http://h/2.png".to_string())
            } else {
                None
            }
        }, &missing);
        assert!(out.contains("![图1](http://h/1.jpg)"));
        // 嵌套括号 alt 与 title 语法保持
        assert!(out.contains("![alt [x]](http://h/2.png \"Fig 2\")"), "{}", out);
        // 缺失引用保留原样并计数
        assert!(out.contains("![missing](images/nope.jpg)"));
        assert_eq!(missing.get(), 1);
        // 未闭合引用原样保留
        assert!(out.contains("![未闭合](images/x.jpg"));
        // 非引用文本不受影响
        assert!(out.contains("# T"));
        assert!(out.contains("普通文本"));
    }

    #[test]
    fn rewrite_utf8_safe() {
        let md = "中文段落「引号」✅ emoji ![图](images/a.jpg) 结束";
        let missing = std::cell::Cell::new(0usize);
        let out = rewrite_md_images(md, |_| Some("http://h/a.jpg".to_string()), &missing);
        assert!(out.contains("![图](http://h/a.jpg)"));
        assert!(out.starts_with("中文段落「引号」✅ emoji "));
        assert!(out.ends_with(" 结束"));
    }

    #[test]
    fn percent_encoding() {
        assert_eq!(percent_encode_path("images/fig 1.jpg"), "images/fig%201.jpg");
        assert_eq!(percent_encode_path("图/图.png"), "%E5%9B%BE/%E5%9B%BE.png");
        assert_eq!(percent_encode_path("a~b-c_d.e"), "a~b-c_d.e");
    }

    #[test]
    fn url_builders() {
        let urls = UrlContext {
            port: "6005".to_string(),
            image_key: "IMGKEY".to_string(),
            file_key: "FILEKEY".to_string(),
        };
        assert_eq!(
            urls.image_url("paper_ab12", "images/fig 1.jpg"),
            "http://localhost:6005/pw=IMGKEY/images/mineru/paper_ab12/images/fig%201.jpg"
        );
        assert_eq!(
            urls.file_url("paper_ab12", "full.render.md"),
            "http://localhost:6005/pw=FILEKEY/files/mineru/paper_ab12/full.render.md"
        );
        // 标题化目录（空格 / 中文）必须整体百分号编码，否则 HTTP 服务器找不到文件
        assert_eq!(
            urls.image_url("中文 标题__paper_ab12", "images/图 1.jpg"),
            "http://localhost:6005/pw=IMGKEY/images/mineru/%E4%B8%AD%E6%96%87%20%E6%A0%87%E9%A2%98__paper_ab12/images/%E5%9B%BE%201.jpg"
        );
        assert_eq!(
            file_url_of(Path::new("D:\\vcp\\file\\mineru\\p\\full.md")),
            "file:///D:/vcp/file/mineru/p/full.md"
        );
    }

    #[test]
    fn build_assets_end_to_end() {
        let dir = std::env::temp_dir().join(format!("mineruparser_assets_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let work = dir.join("work");
        let base = dir.join("base");
        fs::create_dir_all(work.join("auto/images")).unwrap();
        fs::create_dir_all(&base).unwrap();
        fs::write(
            work.join("auto/full.md"),
            "# 标题\n\n![图1](images/fig_1.jpg)\n\n正文\n\n![缺](images/gone.jpg)\n",
        )
        .unwrap();
        fs::write(work.join("auto/images/fig_1.jpg"), b"jpg").unwrap();
        fs::write(
            work.join("auto/full_content_list.json"),
            r#"[{"type":"image","img_path":"images/fig_1.jpg","img_caption":["Figure 1"],"page_idx":3}]"#,
        )
        .unwrap();
        fs::write(work.join("auto/layout.json"), "{}").unwrap();

        let urls = UrlContext {
            port: "6005".to_string(),
            image_key: "K".to_string(),
            file_key: "F".to_string(),
        };
        let out = build_assets(&work, &base, "paper_test", &urls).unwrap();

        let fdir = base.join("file/mineru/paper_test");
        assert!(fdir.join("full.md").is_file());
        assert!(fdir.join("content_list.json").is_file());
        assert!(fdir.join("layout.json").is_file());
        assert!(fdir.join("full.render.md").is_file());
        assert!(base.join("image/mineru/paper_test/images/fig_1.jpg").is_file());
        assert_eq!(out.missing_refs, 1);
        assert!(out.render_md.contains("![图1](http://localhost:6005/pw=K/images/mineru/paper_test/images/fig_1.jpg)"));
        assert!(out.render_md.contains("![缺](images/gone.jpg)"));
        assert_eq!(out.images.len(), 1);
        assert_eq!(out.images[0].caption.as_deref(), Some("Figure 1"));
        assert!(out.has_layout);
        assert!(out.content_list_text.is_some());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_chunks_offsets_and_separators() {
        let dir = std::env::temp_dir().join(format!("mineruparser_merge_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let base = dir.join("base");
        fs::create_dir_all(&base).unwrap();

        // 两个分片工作目录：md 引用同名空间 images/，page_idx 均从 0 起
        let w1 = dir.join("w1");
        let w2 = dir.join("w2");
        fs::create_dir_all(w1.join("images")).unwrap();
        fs::create_dir_all(w2.join("images")).unwrap();
        fs::write(w1.join("full.md"), "# Part One\n\n![a](images/a.jpg)\n").unwrap();
        fs::write(
            w1.join("full_content_list.json"),
            r#"[{"type":"text","text":"Alpha","text_level":1,"page_idx":0},{"type":"image","img_path":"images/a.jpg","page_idx":5}]"#,
        )
        .unwrap();
        fs::write(w1.join("images/a.jpg"), b"a").unwrap();
        fs::write(w2.join("full.md"), "# Part Two\n\n![b](images/b.jpg)\n").unwrap();
        fs::write(
            w2.join("full_content_list.json"),
            r#"[{"type":"text","text":"Beta","text_level":1,"page_idx":0}]"#,
        )
        .unwrap();
        fs::write(w2.join("images/b.jpg"), b"b").unwrap();

        let urls = UrlContext {
            port: "6005".to_string(),
            image_key: "K".to_string(),
            file_key: "F".to_string(),
        };
        let scan1 = scan_chunk(&w1).unwrap();
        let scan2 = scan_chunk(&w2).unwrap();
        let out = build_assets_from_chunks(
            vec![
                ChunkInput { scan: scan1, start_page: 0, end_page: 200, single: false },
                ChunkInput { scan: scan2, start_page: 200, end_page: 400, single: false },
            ],
            &base,
            "paper_merge",
            &urls,
        )
        .unwrap();

        // content_list 合并且 page_idx 偏移
        let merged: Vec<serde_json::Value> =
            serde_json::from_str(out.content_list_text.as_deref().unwrap()).unwrap();
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0]["page_idx"], 0);
        assert_eq!(merged[1]["page_idx"], 5); // 原片内页码 5 + 偏移 0
        assert_eq!(merged[2]["page_idx"], 200); // 原片内页码 0 + 偏移 200

        // md 拼接与分片分隔注释
        assert!(out.md_text.contains("# Part One"));
        assert!(out.md_text.contains("# Part Two"));
        assert!(out.md_text.contains("分片 2（原书第 201-400 页）"));
        assert_eq!(out.md_text.matches("分片 1").count(), 0); // 首片无分隔

        // 统计与图片清单来自合并后的 content_list
        assert_eq!(out.stats.outline.len(), 2);
        assert_eq!(out.stats.images.len(), 1);
        assert_eq!(out.images.len(), 1);
        assert_eq!(out.images[0].page_idx, Some(5));

        // 渲染副本重写跨片共享图片表
        assert!(out.render_md.contains("pw=K/images/mineru/paper_merge/images/a.jpg"));
        assert!(out.render_md.contains("pw=K/images/mineru/paper_merge/images/b.jpg"));
        assert!(base.join("image/mineru/paper_merge/images/a.jpg").is_file());
        assert!(base.join("image/mineru/paper_merge/images/b.jpg").is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn offset_content_list_handles_bad_input() {
        let blocks = offset_content_list(
            r#"[{"type":"text","page_idx":3},{"type":"text","page_idx":-1},{"type":"text"}]"#,
            200,
        )
        .unwrap();
        assert_eq!(blocks[0]["page_idx"], 203);
        assert_eq!(blocks[1]["page_idx"], -1); // 负数保持（质检负责报告）
        assert!(blocks[2].get("page_idx").is_none());
        assert!(offset_content_list("not json", 0).is_err());
        assert!(offset_content_list("{}", 0).is_err());
    }
}
