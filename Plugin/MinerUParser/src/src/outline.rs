//! 从 MinerU content_list 提取大纲与统计（复刻 paper_study 思路，零硬编码兼容）。

use crate::protocol::{ImageEntry, OutlineNode};
use serde_json::Value;

#[derive(Debug, Default, Clone)]
pub struct RawImage {
    /// content_list 中记录的原始图片路径（相对 md 所在目录）
    pub img_path: String,
    pub caption: Option<String>,
    pub page_idx: Option<u64>,
}

#[derive(Debug, Default, Clone)]
pub struct ContentStats {
    pub outline: Vec<OutlineNode>,
    pub images: Vec<RawImage>,
    pub image_count: usize,
    pub table_count: usize,
    pub formula_count: usize,
    pub total_pages: u64,
    pub text_chars: u64,
    pub text_blocks: usize,
    /// 纯页码块（正文只有数字的文本块）数量，用于页眉页脚占比估算
    pub page_number_blocks: usize,
    /// page_idx 回退次数（疑似双栏阅读顺序错乱）
    pub page_regressions: usize,
    pub tables_without_body: usize,
    pub equations_without_latex: usize,
    pub negative_page_idx: bool,
    /// content_list 不是合法 JSON / 不是数组
    pub parse_failed: bool,
    pub empty: bool,
}

/// 解析 content_list JSON 文本。解析失败时返回 parse_failed 标记的空统计，
/// 由质检层决定是阻断还是降级。
pub fn analyze(content_list: &str) -> ContentStats {
    let mut stats = ContentStats::default();
    let blocks: Vec<Value> = match serde_json::from_str(content_list) {
        Ok(Value::Array(arr)) => arr,
        Ok(_) => {
            stats.parse_failed = true;
            return stats;
        }
        Err(_) => {
            stats.parse_failed = true;
            return stats;
        }
    };
    if blocks.is_empty() {
        stats.empty = true;
        return stats;
    }

    let mut last_page: Option<u64> = None;
    let mut max_page: u64 = 0;

    for block in &blocks {
        let block_type = block.get("type").and_then(Value::as_str).unwrap_or("");
        let page_idx = block.get("page_idx").and_then(Value::as_i64);
        if let Some(p) = page_idx {
            if p < 0 {
                stats.negative_page_idx = true;
            } else {
                let p = p as u64;
                max_page = max_page.max(p);
                if let Some(last) = last_page {
                    if p < last {
                        stats.page_regressions += 1;
                    }
                }
                last_page = Some(p);
            }
        }

        match block_type {
            "text" => {
                let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                stats.text_chars += text.chars().count() as u64;
                stats.text_blocks += 1;
                if text.chars().all(|c| c.is_whitespace() || c.is_ascii_digit())
                    && !text.trim().is_empty()
                {
                    stats.page_number_blocks += 1;
                }
                if let Some(level) = block.get("text_level").and_then(Value::as_u64) {
                    if level > 0 {
                        stats.outline.push(OutlineNode {
                            level: level as u32,
                            text: text.trim().to_string(),
                            page_idx: page_idx.map(|p| p.max(0) as u64).unwrap_or(0),
                        });
                    }
                }
            }
            "image" => {
                stats.image_count += 1;
                let img_path = block
                    .get("img_path")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if !img_path.is_empty() {
                    // MinerU v4 实际字段为 image_caption；兼容旧字段 img_caption 与脚注
                    let caption = first_text_list(
                        block,
                        &["image_caption", "img_caption", "image_footnote", "img_footnote"],
                    );
                    stats.images.push(RawImage {
                        img_path,
                        caption,
                        page_idx: page_idx.map(|p| p.max(0) as u64),
                    });
                }
            }
            "table" => {
                stats.table_count += 1;
                if block.get("table_body").and_then(Value::as_str).unwrap_or("").is_empty() {
                    stats.tables_without_body += 1;
                }
            }
            "equation" => {
                stats.formula_count += 1;
                let has_latex = block
                    .get("text_format")
                    .and_then(Value::as_str)
                    .map(|f| f == "latex")
                    .unwrap_or(false)
                    && !block.get("text").and_then(Value::as_str).unwrap_or("").is_empty();
                if !has_latex {
                    stats.equations_without_latex += 1;
                }
            }
            _ => {}
        }
    }

    stats.total_pages = max_page + 1;
    stats
}

/// 读取块中第一个非空文本列表/字符串（兼容不同版本 MinerU 的字段命名）。
pub(crate) fn first_text_list(block: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(arr) = block.get(*key).and_then(Value::as_array) {
            for item in arr {
                if let Some(s) = item.as_str() {
                    let trimmed = s.trim();
                    if !trimmed.is_empty() {
                        return Some(trimmed.to_string());
                    }
                }
            }
        }
        if let Some(s) = block.get(*key).and_then(Value::as_str) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// 论文标题：优先第一个 level 1 标题，其次任意首个标题，最后由调用方回退文件名。
pub fn derive_title(stats: &ContentStats, file_name: &str) -> String {
    stats
        .outline
        .iter()
        .find(|n| n.level == 1)
        .or_else(|| stats.outline.first())
        .map(|n| n.text.clone())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| file_name.to_string())
}

/// content_list 中图片引用 → 卡片图片清单（rel 映射由 assets 层提供的 lookup 完成）。
pub fn build_image_entries(
    stats: &ContentStats,
    lookup: &dyn Fn(&str) -> Option<(String, String)>,
) -> Vec<ImageEntry> {
    stats
        .images
        .iter()
        .filter_map(|img| {
            lookup(&img.img_path).map(|(rel, url)| ImageEntry {
                rel,
                url,
                caption: img.caption.clone(),
                page_idx: img.page_idx,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"[
        {"type":"text","text":"Deep Learning for X","text_level":1,"page_idx":0},
        {"type":"text","text":"Abstract body text here.","page_idx":0},
        {"type":"text","text":"2","page_idx":1},
        {"type":"image","img_path":"images/fig_1.jpg","img_caption":["Figure 1: setup"],"page_idx":3},
        {"type":"table","table_body":"<html>..</html>","page_idx":5},
        {"type":"table","table_caption":["Table 2"],"page_idx":5},
        {"type":"equation","text":"E=mc^2","text_format":"latex","page_idx":2},
        {"type":"equation","text":"","text_format":"latex","page_idx":2},
        {"type":"text","text":"Methods","text_level":2,"page_idx":4},
        {"type":"text","text":"back to page one content","page_idx":1}
    ]"#;

    #[test]
    fn analyze_outline_and_stats() {
        let s = analyze(FIXTURE);
        assert_eq!(s.outline.len(), 2);
        assert_eq!(s.outline[0].level, 1);
        assert_eq!(s.outline[0].text, "Deep Learning for X");
        assert_eq!(s.outline[0].page_idx, 0);
        assert_eq!(s.outline[1].text, "Methods");
        assert_eq!(s.image_count, 1);
        assert_eq!(s.table_count, 2);
        assert_eq!(s.formula_count, 2);
        assert_eq!(s.total_pages, 6); // max page_idx 5
        assert_eq!(s.text_chars, "Deep Learning for X".chars().count() as u64
            + "Abstract body text here.".chars().count() as u64
            + "2".chars().count() as u64
            + "back to page one content".chars().count() as u64
            + "Methods".chars().count() as u64);
        assert_eq!(s.page_number_blocks, 1);
        assert_eq!(s.page_regressions, 2); // 5→2 与 4→1 各一次
        assert_eq!(s.tables_without_body, 1);
        assert_eq!(s.equations_without_latex, 1);
        assert!(!s.parse_failed && !s.empty && !s.negative_page_idx);
        assert_eq!(s.images.len(), 1);
        assert_eq!(s.images[0].caption.as_deref(), Some("Figure 1: setup"));
    }

    #[test]
    fn analyze_bad_input() {
        let s = analyze("not json");
        assert!(s.parse_failed);
        let s = analyze("[]");
        assert!(s.empty && !s.parse_failed);
        let s = analyze(r#"{"key":1}"#);
        assert!(s.parse_failed);
    }

    #[test]
    fn title_fallback() {
        let s = analyze(FIXTURE);
        assert_eq!(derive_title(&s, "demo.pdf"), "Deep Learning for X");
        let empty = analyze("[]");
        assert_eq!(derive_title(&empty, "demo.pdf"), "demo.pdf");
    }

    #[test]
    fn caption_keys_are_compatible() {
        let block = serde_json::json!({
            "image_caption": ["Figure 1: actual"],
            "img_caption": ["legacy"],
        });
        assert_eq!(
            first_text_list(&block, &["image_caption", "img_caption"]),
            Some("Figure 1: actual".to_string())
        );
        let block = serde_json::json!({ "img_caption": ["legacy only"] });
        assert_eq!(
            first_text_list(&block, &["image_caption", "img_caption"]),
            Some("legacy only".to_string())
        );
        let block = serde_json::json!({ "image_footnote": ["note"] });
        assert_eq!(
            first_text_list(&block, &["image_caption", "image_footnote"]),
            Some("note".to_string())
        );
        let block = serde_json::json!({ "image_caption": [] });
        assert_eq!(first_text_list(&block, &["image_caption"]), None);
    }

    #[test]
    fn image_entries_lookup() {
        let s = analyze(FIXTURE);
        let entries = build_image_entries(&s, &|path| {
            if path == "images/fig_1.jpg" {
                Some(("images/fig_1.jpg".to_string(), "http://x/fig_1.jpg".to_string()))
            } else {
                None
            }
        });
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].url, "http://x/fig_1.jpg");
    }
}
