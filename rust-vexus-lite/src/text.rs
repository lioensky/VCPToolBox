use napi::bindgen_prelude::*;
use serde::{Deserialize, Serialize};
use tiktoken_rs::cl100k_base_singleton;

pub const EMPTY_CONTENT: &str = "[EMPTY_CONTENT]";
pub const TEXT_RULES_VERSION: &str = "kbm-text-v1-cl100k-base";

#[derive(Debug, Clone, Default)]
pub struct TagRules {
    pub tag_blacklist_super: Vec<String>,
    pub tag_blacklist: Vec<String>,
    pub max_tags: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkConfig {
    pub max_tokens: usize,
    pub overlap_tokens: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextPreparation {
    pub prepared_text: String,
    pub tags: Vec<String>,
    pub chunks: Vec<String>,
    pub token_count: usize,
    pub rules_version: String,
}

fn is_decorative_emoji(value: char) -> bool {
    matches!(
        value as u32,
        0x1F600..=0x1F64F
            | 0x1F300..=0x1F5FF
            | 0x1F680..=0x1F6FF
            | 0x1F1E0..=0x1F1FF
            | 0x2600..=0x26FF
            | 0x2700..=0x27BF
    )
}

pub fn prepare_text_for_embedding(text: Option<&str>) -> String {
    let Some(text) = text else {
        return EMPTY_CONTENT.to_string();
    };

    let mut cleaned = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(value) = chars.next() {
        if is_decorative_emoji(value) {
            cleaned.push(' ');
            continue;
        }

        if value == '<' && chars.peek() == Some(&'|') {
            chars.next();
            let mut replacement = String::new();
            let mut found_end = false;
            while let Some(inner) = chars.next() {
                if inner == '|' && chars.peek() == Some(&'>') {
                    chars.next();
                    found_end = true;
                    break;
                }
                replacement.push(inner);
            }
            if found_end {
                cleaned.push_str(&replacement);
            } else {
                cleaned.push('<');
                cleaned.push('|');
                cleaned.push_str(&replacement);
            }
        } else {
            cleaned.push(value);
        }
    }

    let mut normalized = String::with_capacity(cleaned.len());
    let mut pending_horizontal_space = false;
    for value in cleaned.chars() {
        if value == ' ' || value == '\t' {
            pending_horizontal_space = true;
            continue;
        }
        if value == '\n' {
            while normalized.ends_with(' ') {
                normalized.pop();
            }
            normalized.push('\n');
            pending_horizontal_space = false;
            continue;
        }
        if pending_horizontal_space && !normalized.is_empty() && !normalized.ends_with('\n') {
            normalized.push(' ');
        }
        pending_horizontal_space = false;
        normalized.push(value);
    }
    if pending_horizontal_space && !normalized.is_empty() && !normalized.ends_with('\n') {
        normalized.push(' ');
    }

    let mut collapsed = String::with_capacity(normalized.len());
    let mut previous_newline = false;
    for value in normalized.chars() {
        if value == '\n' {
            if previous_newline {
                continue;
            }
            previous_newline = true;
        } else {
            previous_newline = false;
        }
        collapsed.push(value);
    }

    collapsed.trim().to_string().if_empty_or(EMPTY_CONTENT)
}

trait EmptyOr {
    fn if_empty_or(self, fallback: &str) -> String;
}

impl EmptyOr for String {
    fn if_empty_or(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

fn split_tag_content(value: &str) -> impl Iterator<Item = &str> {
    value.split(|character| matches!(character, ',' | '，' | '、' | ';' | '|' | '｜'))
}

fn contains_date(value: &str) -> bool {
    const DATE_PATTERN: &str =
        r"(\d{4}年\d{1,2}月\d{1,2}日|\d{4}年\d{1,2}月|\d{1,2}月\d{1,2}日|\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{2}[-./]\d{1,2}[-./]\d{1,2}|\d{4}[-./]\d{1,2})";
    static DATE_REGEX: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    DATE_REGEX.get_or_init(|| regex::Regex::new(DATE_PATTERN).expect("static date regex"))
        .is_match(value)
}

pub fn extract_tags(content: &str, rules: &TagRules) -> Vec<String> {
    let lines: Vec<&str> = content.split('\n').collect();
    let mut last_content_line = lines.len();
    while last_content_line > 0 && lines[last_content_line - 1].trim().is_empty() {
        last_content_line -= 1;
    }

    static TAG_REGEX: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let tag_pattern = TAG_REGEX.get_or_init(||
        regex::Regex::new(r"^\s*Tag:\s*(.+?)\s*$").expect("static Tag regex"));
    let mut tag_contents = Vec::new();
    let mut index = last_content_line;
    while index > 0 {
        index -= 1;
        let Some(captures) = tag_pattern.captures(lines[index]) else {
            break;
        };
        tag_contents.push(captures[1].to_string());
    }
    tag_contents.reverse();

    let mut tags = Vec::new();
    for content in tag_contents {
        for raw_tag in split_tag_content(&content) {
            let tag = raw_tag.trim().trim_end_matches(['。', '.']).trim();
            let prepared = prepare_text_for_embedding(Some(tag));
            if prepared != EMPTY_CONTENT {
                tags.push(prepared);
            }
        }
    }

    if !rules.tag_blacklist_super.is_empty() {
        let pattern = rules
            .tag_blacklist_super
            .iter()
            .filter(|value| !value.is_empty())
            .map(|value| regex::escape(value))
            .collect::<Vec<_>>()
            .join("|");
        if !pattern.is_empty() {
            // 动态规则每次提取仅编译一次，不能按每个 Tag 重编译。
            let regex = regex::Regex::new(&pattern).expect("escaped blacklist regex");
            tags = tags.into_iter()
                .map(|tag| regex.replace_all(&tag, "").trim().to_string())
                .collect();
        }
    }

    let mut unique = Vec::new();
    for tag in tags {
        if tag.is_empty()
            || rules.tag_blacklist.iter().any(|blocked| blocked == &tag)
            || contains_date(&tag)
        {
            continue;
        }
        let is_chinese = tag.chars().any(|character| ('\u{4E00}'..='\u{9FA5}').contains(&character));
        let max_length = if is_chinese { 20 } else { 40 };
        if tag.chars().count() > max_length || unique.iter().any(|existing| existing == &tag) {
            continue;
        }
        unique.push(tag);
    }

    let max_tags = rules.max_tags.unwrap_or(50).max(1);
    unique.truncate(max_tags);
    unique
}

fn token_count(text: &str) -> usize {
    cl100k_base_singleton().encode_ordinary(text).len()
}

fn sentence_split(text: &str) -> Vec<&str> {
    let mut sentences = Vec::new();
    let mut start = 0;
    for (index, character) in text.char_indices() {
        if matches!(character, '。' | '？' | '！' | '.' | '!' | '?' | '\n') {
            let end = index + character.len_utf8();
            sentences.push(&text[start..end]);
            start = end;
        }
    }
    if start < text.len() {
        sentences.push(&text[start..]);
    }
    sentences
}

pub fn chunk_text(text: &str, config: &ChunkConfig) -> Vec<String> {
    if text.is_empty() || config.max_tokens == 0 {
        return Vec::new();
    }

    let overlap = config
        .overlap_tokens
        .min(config.max_tokens.saturating_sub(1));
    let sentences = sentence_split(text);
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut current_tokens = 0usize;

    for (sentence_index, sentence) in sentences.iter().enumerate() {
        let sentence_tokens = token_count(sentence);
        if sentence_tokens > config.max_tokens {
            if !current.trim().is_empty() {
                chunks.push(current.trim().to_string());
            }
            current.clear();
            current_tokens = 0;
            chunks.extend(force_split_long_text(sentence, config.max_tokens, overlap));
            continue;
        }

        if current_tokens + sentence_tokens > config.max_tokens && !current.trim().is_empty() {
            chunks.push(current.trim().to_string());
            let mut overlap_text = String::new();
            let mut overlap_count = 0usize;
            for previous in sentences[..sentence_index].iter().rev() {
                let previous_tokens = token_count(previous);
                if overlap_count + previous_tokens > overlap {
                    break;
                }
                overlap_text.insert_str(0, previous);
                overlap_count += previous_tokens;
            }
            current = overlap_text;
            current_tokens = overlap_count;
        }

        current.push_str(sentence);
        current_tokens += sentence_tokens;
    }

    if !current.trim().is_empty() {
        chunks.push(current.trim().to_string());
    }
    chunks
}

fn force_split_long_text(text: &str, max_tokens: usize, overlap_tokens: usize) -> Vec<String> {
    let encoding = cl100k_base_singleton();
    let tokens = encoding.encode_ordinary(text);
    let safe_overlap = overlap_tokens.min(max_tokens.saturating_sub(1));
    let mut output = Vec::new();
    let mut start = 0usize;

    while start < tokens.len() {
        let budget_end = start.saturating_add(max_tokens).min(tokens.len());
        let mut end = budget_end;
        while end > start && encoding.decode(&tokens[start..end]).is_err() {
            end -= 1;
        }
        if end == start {
            // A Unicode scalar can span several tokens. Never discard its bytes
            // when the configured budget is smaller than that scalar.
            end = budget_end;
            while end < tokens.len() && encoding.decode(&tokens[start..end]).is_err() {
                end += 1;
            }
        }
        let mut decoded = encoding.decode(&tokens[start..end])
            .expect("complete UTF-8 source has a decodable token boundary");
        if end < tokens.len() {
            let mut search_start = decoded.len().saturating_sub(200);
            while !decoded.is_char_boundary(search_start) {
                search_start += 1;
            }
            let preferred = decoded[search_start..].char_indices().rev()
                .find_map(|(index, character)| {
                    matches!(character, '\n' | '。' | '！' | '？' | '，' | '；' | '：' | ' ' | '\t')
                        .then_some(search_start + index + character.len_utf8())
                });
            if let Some(byte_end) = preferred {
                let prefix = &decoded[..byte_end];
                let candidate_end = start + encoding.encode_ordinary(prefix).len();
                if candidate_end > start + safe_overlap && candidate_end <= end {
                    if let Ok(candidate) = encoding.decode(&tokens[start..candidate_end]) {
                        if candidate == prefix {
                            end = candidate_end;
                            decoded = candidate;
                        }
                    }
                }
            }
        }
        output.push(decoded.trim().to_string());
        if end == tokens.len() {
            break;
        }

        let mut next = end.saturating_sub(safe_overlap).max(start + 1);
        // Both boundaries must be valid: otherwise the next window starts with
        // continuation bytes and may silently lose an entire chunk.
        while next < end && encoding.decode(&tokens[next..end]).is_err() {
            next += 1;
        }
        start = next;
    }

    output.into_iter().filter(|value| !value.is_empty()).collect()
}

pub fn prepare_document(text: &str, rules: &TagRules, config: &ChunkConfig) -> TextPreparation {
    // 与现有 ingestionPipeline.js 保持相同顺序：原文切 Chunk，
    // 然后逐 Chunk 预处理并过滤 EMPTY_CONTENT；Tag 仍从原始全文末尾元数据提取。
    let prepared_text = prepare_text_for_embedding(Some(text));
    let tags = extract_tags(text, rules);
    let chunks = chunk_text(text, config)
        .into_iter()
        .map(|chunk| prepare_text_for_embedding(Some(&chunk)))
        .filter(|chunk| chunk != EMPTY_CONTENT)
        .collect();
    let token_count = token_count(&prepared_text);
    TextPreparation {
        prepared_text,
        tags,
        chunks,
        token_count,
        rules_version: TEXT_RULES_VERSION.to_string(),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPreparationRequest {
    pub text: String,
    #[serde(default)]
    pub tag_blacklist_super: Vec<String>,
    #[serde(default)]
    pub tag_blacklist: Vec<String>,
    pub max_tags: Option<usize>,
    pub max_tokens: Option<usize>,
    pub overlap_tokens: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPreparationResponse {
    pub prepared_text: String,
    pub tags: Vec<String>,
    pub chunks: Vec<String>,
    pub token_count: usize,
    pub rules_version: String,
}

pub struct TextPreparationTask {
    pub request_json: String,
}

impl Task for TextPreparationTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let request: TextPreparationRequest =
            serde_json::from_str(&self.request_json).map_err(|error| {
                Error::from_reason(format!("Invalid text preparation request JSON: {}", error))
            })?;
        let max_tokens = request
            .max_tokens
            .unwrap_or(6800)
            .clamp(1, 1_000_000);
        let overlap_tokens = request
            .overlap_tokens
            .unwrap_or(max_tokens / 10)
            .min(max_tokens.saturating_sub(1));
        let result = prepare_document(
            &request.text,
            &TagRules {
                tag_blacklist_super: request.tag_blacklist_super,
                tag_blacklist: request.tag_blacklist,
                max_tags: request.max_tags,
            },
            &ChunkConfig {
                max_tokens,
                overlap_tokens,
            },
        );
        serde_json::to_string(&TextPreparationResponse {
            prepared_text: result.prepared_text,
            tags: result.tags,
            chunks: result.chunks,
            token_count: result.token_count,
            rules_version: result.rules_version,
        })
        .map_err(|error| Error::from_reason(format!("Encode text preparation result failed: {}", error)))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preprocessing_matches_empty_and_metadata_contract() {
        assert_eq!(prepare_text_for_embedding(None), EMPTY_CONTENT);
        assert_eq!(
            prepare_text_for_embedding(Some("😀 甲\t乙\n\n 丙 <|role|>")),
            "甲 乙\n丙 role"
        );
    }

    #[test]
    fn tags_only_come_from_trailing_contiguous_metadata() {
        let rules = TagRules::default();
        assert_eq!(
            extract_tags("Tag: 正文示例\n内容\nTag: Alpha, Beta。", &rules),
            vec!["Alpha", "Beta"]
        );
        assert_eq!(extract_tags("Tag: Alpha\n\nTag: Beta", &rules), vec!["Beta"]);
    }

    #[test]
    fn token_windows_preserve_every_unicode_scalar_without_overlap() {
        let input = "汉字𠮷🧬éक한".repeat(20);
        for max_tokens in 1..=16 {
            let chunks = force_split_long_text(&input, max_tokens, 0);
            assert_eq!(chunks.concat(), input, "budget {}", max_tokens);
        }
    }

    #[test]
    fn long_unicode_boundary_search_does_not_panic() {
        let input = "中文边界测试，没有句号".repeat(100);
        let chunks = chunk_text(&input, &ChunkConfig {
            max_tokens: 200,
            overlap_tokens: 20,
        });
        assert!(!chunks.is_empty());
        assert!(chunks.iter().all(|chunk| !chunk.contains('\u{FFFD}')));
    }

    #[test]
    fn cl100k_tokenizer_decodes_long_text_without_token_id_utf8_corruption() {
        let config = ChunkConfig {
            max_tokens: 8,
            overlap_tokens: 2,
        };
        let chunks = chunk_text("这是一个很长的中文句子，没有句号，继续继续继续继续继续继续。", &config);
        assert!(!chunks.is_empty());
        assert!(chunks.iter().all(|chunk| !chunk.contains('\u{FFFD}')));
    }
}