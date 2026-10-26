//! locate 命令：content_list 关键词 → 段落秒级定位（V2-4）。
//! 直接扫描 content_list.json（Rust 顺序扫描 141KB 量级在毫秒级完成，无需预建索引）。

use crate::error::AppError;
use crate::protocol::Request;
use serde_json::Value;
use std::fs;

const DEFAULT_MAX_HITS: usize = 10;
const EXCERPT_CONTEXT_CHARS: usize = 70;

pub fn cmd_locate(request: &Request) -> Result<crate::CommandOutput, AppError> {
    let reference = request
        .paper_id
        .as_deref()
        .ok_or_else(|| AppError::fix("locate 命令缺少必需参数 paper_id。"))?
        .trim()
        .to_string();
    let keyword = request
        .keyword
        .as_deref()
        .ok_or_else(|| AppError::fix("locate 命令缺少必需参数 keyword（检索关键词）。"))?
        .to_string();
    if keyword.trim().is_empty() {
        return Err(AppError::fix("keyword 不能为空。"));
    }

    let mut paper_id = reference.clone();
    let mut file_dir = crate::file_dir_of(&paper_id);
    if !file_dir.is_dir() {
        paper_id = crate::library::resolve_paper_ref(&reference)?;
        file_dir = crate::file_dir_of(&paper_id);
    }
    let content_list_path = file_dir.join("content_list.json");
    if !content_list_path.is_file() {
        return Err(AppError::fix(format!(
            "论文 {} 尚未解析（缺少 content_list.json）。\n{}\n请先使用 parse 命令解析，或用 status 查看进度。",
            paper_id,
            crate::library::missing_paper_hint(&paper_id)
        )));
    }
    let text = fs::read_to_string(&content_list_path)
        .map_err(|e| AppError::fix(format!("读取 content_list 失败: {}", e)))?;
    let blocks: Vec<Value> = match serde_json::from_str(&text) {
        Ok(Value::Array(arr)) => arr,
        Ok(_) => return Err(AppError::fix("content_list 不是 JSON 数组。".to_string())),
        Err(e) => return Err(AppError::fix(format!("content_list 解析失败: {}", e))),
    };

    let max_hits = DEFAULT_MAX_HITS;
    let mut hits: Vec<Hit> = Vec::new();
    for (block_idx, block) in blocks.iter().enumerate() {
        let block_type = block.get("type").and_then(Value::as_str).unwrap_or("");
        let page = block.get("page_idx").and_then(Value::as_i64).unwrap_or(-1);
        // 可检索字段：text/equation 的 text；table 的 caption + body；image 的 caption
        let candidates: Vec<String> = match block_type {
            "text" | "equation" => block
                .get("text")
                .and_then(Value::as_str)
                .map(|s| vec![s.to_string()])
                .unwrap_or_default(),
            "table" => {
                let mut fields = Vec::new();
                if let Some(arr) = block.get("table_caption").and_then(Value::as_array) {
                    for c in arr {
                        if let Some(s) = c.as_str() {
                            fields.push(s.to_string());
                        }
                    }
                }
                if let Some(s) = block.get("table_body").and_then(Value::as_str) {
                    fields.push(strip_html_tags(s));
                }
                fields
            }
            "image" => {
                let mut fields = Vec::new();
                // MinerU v4 实际字段为 image_caption；兼容旧字段与脚注
                for key in ["image_caption", "img_caption", "image_footnote", "img_footnote"] {
                    if let Some(arr) = block.get(key).and_then(Value::as_array) {
                        for c in arr {
                            if let Some(s) = c.as_str() {
                                let trimmed = s.trim();
                                if !trimmed.is_empty() {
                                    fields.push(trimmed.to_string());
                                }
                            }
                        }
                    }
                }
                fields
            }
            _ => Vec::new(),
        };
        for field in candidates {
            if let Some(pos) = find_ci(&field, &keyword) {
                hits.push(Hit {
                    page,
                    block_idx,
                    kind: kind_label(block_type),
                    excerpt: build_excerpt(&field, pos, &keyword),
                });
                break; // 每块只取首个命中
            }
        }
    }

    let total = hits.len();
    if total == 0 {
        return Ok(crate::CommandOutput::Card(format!(
            "## 🔍 定位结果：{} × “{}”\n\n未找到任何命中。可检查关键词拼写，或换用论文中的原文表述（大小写不敏感）。",
            paper_id, keyword
        )));
    }

    let mut out = format!(
        "## 🔍 定位结果：{} × “{}”\n\n共 **{}** 处命中{}：\n\n",
        paper_id,
        keyword,
        total,
        if total > max_hits {
            format!("（展示前 {} 处）", max_hits)
        } else {
            String::new()
        }
    );
    for hit in hits.iter().take(max_hits) {
        let page = if hit.page >= 0 {
            format!("p{}", hit.page + 1)
        } else {
            "p?".to_string()
        };
        out.push_str(&format!(
            "- **{}** · {} · 块 #{}：{}\n",
            page, hit.kind, hit.block_idx, hit.excerpt
        ));
    }
    if total > max_hits {
        out.push_str(&format!("\n（另有 {} 处未展示，可用更具体的关键词缩小范围）\n", total - max_hits));
    }
    out.push_str(&format!(
        "\n读取上下文：用 `read` 命令（paper_id + `find=\"{}\"` 或 `section=章节标题`，也可 `lines=\"M-N\"`）；块编号对应 content_list.json 中的顺序（0 起）。\n",
        keyword
    ));
    Ok(crate::CommandOutput::Card(out))
}

struct Hit {
    page: i64,
    block_idx: usize,
    kind: &'static str,
    excerpt: String,
}

fn kind_label(block_type: &str) -> &'static str {
    match block_type {
        "text" => "正文",
        "equation" => "公式",
        "table" => "表格",
        "image" => "图注",
        _ => "内容",
    }
}

/// ASCII 小写化（字节长度不变，保证偏移量与原文对齐；中文不受影响）。
fn ascii_lower(s: &str) -> String {
    s.chars().map(|c| c.to_ascii_lowercase()).collect()
}

/// 大小写不敏感查找，返回原文中的字节偏移。
fn find_ci(text: &str, needle: &str) -> Option<usize> {
    let n = ascii_lower(needle);
    if n.is_empty() {
        return None;
    }
    ascii_lower(text).find(&n)
}

/// 命中点前后 EXCERPT_CONTEXT_CHARS 字符的摘录，命中词加粗。
fn build_excerpt(field: &str, pos: usize, keyword: &str) -> String {
    let total_chars = field.chars().count();
    let start_char = field[..pos].chars().count();
    let kw_chars = keyword.chars().count();
    let s = start_char.saturating_sub(EXCERPT_CONTEXT_CHARS);
    let e = (start_char + kw_chars + EXCERPT_CONTEXT_CHARS).min(total_chars);
    let window: String = field.chars().skip(s).take(e - s).collect();
    let mut out = String::new();
    if s > 0 {
        out.push('…');
    }
    match find_ci(&window, keyword) {
        Some(w) => {
            // 命中词在 window 中的字节长度 = keyword 字节长度（大小写折叠不改变字节数）
            let w_end = (w + keyword.len()).min(window.len());
            out.push_str(&window[..w]);
            out.push_str("**");
            out.push_str(&window[w..w_end]);
            out.push_str("**");
            out.push_str(&window[w_end..]);
        }
        None => out.push_str(&window),
    }
    if e < total_chars {
        out.push('…');
    }
    out.replace('\n', " ")
}

fn strip_html_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' '); // 标签边界补空格，避免单词粘连
            }
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_ci_cases() {
        assert_eq!(find_ci("Hello World", "world"), Some(6));
        assert_eq!(find_ci("微波吸收机制 GHB", "ghb"), Some(19));
        assert_eq!(find_ci("ABC", "xyz"), None);
        assert_eq!(find_ci("text", ""), None);
        // 字节偏移对齐：多字节字符后命中
        assert_eq!(find_ci("中文 absorption test", "absorption"), Some(7));
    }

    #[test]
    fn excerpt_highlights_and_truncates() {
        let field = "前文填充内容。The microwave absorption mechanism is the key point. 后文填充内容。";
        let pos = find_ci(field, "microwave").unwrap();
        let ex = build_excerpt(field, pos, "microwave");
        assert!(ex.contains("**microwave**"));
        assert!(ex.starts_with('…') || field.starts_with(&ex[..3]));
        // 短文本不加省略号
        let short = "tiny absorption here";
        let pos = find_ci(short, "absorption").unwrap();
        let ex = build_excerpt(short, pos, "absorption");
        assert_eq!(ex, "tiny **absorption** here");
    }

    #[test]
    fn html_stripped() {
        assert_eq!(strip_html_tags("<table><tr><td>Hi</td><td>There</td></tr></table>"), "Hi There");
    }
}
