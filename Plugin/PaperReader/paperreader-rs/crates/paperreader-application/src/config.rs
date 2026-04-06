use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RuntimeConfig {
    pub protocol_version: String,
    pub workspace_root: PathBuf,
    pub api_url: Option<String>,
    #[serde(default, skip_serializing)]
    pub api_key: Option<String>,
    pub api_key_present: bool,
    #[serde(default, skip_serializing)]
    pub mineru_api_token: Option<String>,
    pub mineru_api_token_present: bool,
    pub mineru_model_version: String,
    pub mineru_api_timeout_ms: u64,
    pub mineru_poll_interval_ms: u64,
    pub paperreader_model: Option<String>,
    pub paperreader_max_output_tokens: u32,
    pub paperreader_chunk_size_tokens: usize,
    pub paperreader_overlap_ratio: f64,
    pub paperreader_batch_size: usize,
    pub paperreader_max_concurrent_llm: usize,
    pub paperreader_max_concurrent_nodes: usize,
    pub paperreader_max_chunks: usize,
    pub paperreader_max_audit_chunks: usize,
    pub paperreader_recursive_group_size: usize,
    pub paperreader_recursive_max_levels: usize,
    pub paperreader_recursive_enable_critic: bool,
    pub paperreader_rolling_context_max_entries: usize,
    pub paperreader_rolling_context_max_chars: usize,
    pub force_deterministic: bool,
}

impl RuntimeConfig {
    pub fn from_env() -> Self {
        Self::from_reader(|key| std::env::var(key).ok())
    }

    pub(crate) fn from_reader<F>(mut read_var: F) -> Self
    where
        F: FnMut(&str) -> Option<String>,
    {
        let api_key = first_non_empty(&mut read_var, &["API_Key", "API_KEY"]);
        let mineru_api_token = first_non_empty(&mut read_var, &["MINERU_API_TOKEN"]);
        let force_deterministic = parse_bool(&mut read_var, &["PAPERREADER_FORCE_DETERMINISTIC"]);
        Self {
            protocol_version: "1.0".to_string(),
            workspace_root: first_non_empty(&mut read_var, &["PAPERREADER_WORKSPACE_ROOT"])
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("./workspace-rs")),
            api_url: first_non_empty(&mut read_var, &["API_URL"]),
            api_key_present: api_key.is_some(),
            api_key,
            mineru_api_token_present: mineru_api_token.is_some(),
            mineru_api_token,
            mineru_model_version: first_non_empty(&mut read_var, &["MINERU_MODEL_VERSION"])
                .unwrap_or_else(|| "pipeline".to_string()),
            mineru_api_timeout_ms: parse_u64(&mut read_var, &["MINERU_API_TIMEOUT"], 300_000),
            mineru_poll_interval_ms: parse_u64(&mut read_var, &["MINERU_POLL_INTERVAL"], 5_000),
            paperreader_model: first_non_empty(
                &mut read_var,
                &["PaperReaderModel", "PAPERREADER_MODEL"],
            ),
            paperreader_max_output_tokens: parse_u32(
                &mut read_var,
                &["PaperReaderMaxOutputTokens"],
                12_000,
            ),
            paperreader_chunk_size_tokens: parse_usize(
                &mut read_var,
                &["PaperReaderChunkSize"],
                2_000,
            ),
            paperreader_overlap_ratio: parse_f64(&mut read_var, &["PaperReaderOverlap"], 0.15),
            paperreader_batch_size: parse_usize(&mut read_var, &["PaperReaderBatchSize"], 5),
            paperreader_max_concurrent_llm: parse_usize(
                &mut read_var,
                &["PaperReaderMaxConcurrentLLM"],
                5,
            ),
            paperreader_max_concurrent_nodes: parse_usize(
                &mut read_var,
                &["PaperReaderMaxConcurrentNodes"],
                3,
            ),
            paperreader_max_chunks: parse_usize(&mut read_var, &["PaperReaderMaxChunks"], 120),
            paperreader_max_audit_chunks: parse_usize(
                &mut read_var,
                &["PaperReaderMaxAuditChunks"],
                8,
            ),
            paperreader_recursive_group_size: parse_usize(
                &mut read_var,
                &["PaperReaderRecursiveGroupSize"],
                8,
            ),
            paperreader_recursive_max_levels: parse_usize(
                &mut read_var,
                &["PaperReaderRecursiveMaxLevels"],
                6,
            ),
            paperreader_recursive_enable_critic: parse_bool(
                &mut read_var,
                &["PaperReaderRecursiveCritic"],
            ),
            paperreader_rolling_context_max_entries: parse_usize(
                &mut read_var,
                &["PaperReaderRollingContextMaxEntries"],
                40,
            ),
            paperreader_rolling_context_max_chars: parse_usize(
                &mut read_var,
                &["PaperReaderRollingContextMaxChars"],
                12_000,
            ),
            force_deterministic,
        }
    }

    pub fn capabilities(&self) -> Vec<String> {
        let mut caps = vec![
            "accepted-response".to_string(),
            "resume-research-graph".to_string(),
            "artifact-replay".to_string(),
            "workspace-artifacts".to_string(),
            "adaptive-replan".to_string(),
            "document-reading".to_string(),
            "collection-corpus".to_string(),
            "background-async-worker".to_string(),
            "recursive-reading".to_string(),
        ];

        if self.force_deterministic || self.api_url.is_none() || self.api_key.is_none() {
            caps.push("deterministic-llm-fallback".to_string());
        } else {
            caps.push("openai-chat-completions".to_string());
        }

        if self.force_deterministic || self.mineru_api_token.is_none() {
            caps.push("pdf-parse-fallback".to_string());
        } else {
            caps.push("mineru-v4".to_string());
        }

        caps
    }
}

fn first_non_empty<F>(read_var: &mut F, keys: &[&str]) -> Option<String>
where
    F: FnMut(&str) -> Option<String>,
{
    keys.iter().find_map(|key| {
        read_var(key).and_then(|value| {
            if value.trim().is_empty() {
                None
            } else {
                Some(value)
            }
        })
    })
}

fn parse_u64<F>(read_var: &mut F, keys: &[&str], default_value: u64) -> u64
where
    F: FnMut(&str) -> Option<String>,
{
    first_non_empty(read_var, keys)
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(default_value)
}

fn parse_u32<F>(read_var: &mut F, keys: &[&str], default_value: u32) -> u32
where
    F: FnMut(&str) -> Option<String>,
{
    first_non_empty(read_var, keys)
        .and_then(|value| value.trim().parse::<u32>().ok())
        .unwrap_or(default_value)
}

fn parse_usize<F>(read_var: &mut F, keys: &[&str], default_value: usize) -> usize
where
    F: FnMut(&str) -> Option<String>,
{
    first_non_empty(read_var, keys)
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(default_value)
}

fn parse_f64<F>(read_var: &mut F, keys: &[&str], default_value: f64) -> f64
where
    F: FnMut(&str) -> Option<String>,
{
    first_non_empty(read_var, keys)
        .and_then(|value| value.trim().parse::<f64>().ok())
        .unwrap_or(default_value)
}

fn parse_bool<F>(read_var: &mut F, keys: &[&str]) -> bool
where
    F: FnMut(&str) -> Option<String>,
{
    first_non_empty(read_var, keys)
        .map(|value| value.trim().to_lowercase())
        .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "yes" | "y" | "on"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn runtime_config_reads_aliases_without_touching_process_env() {
        let vars = HashMap::from([
            ("PAPERREADER_WORKSPACE_ROOT", "D:/tmp/workspace-rs"),
            ("API_KEY", "secret"),
            ("MINERU_API_TOKEN", "mineru-secret"),
            ("MINERU_MODEL_VERSION", "vlm"),
            ("PAPERREADER_MODEL", "gpt-5.3"),
            ("MINERU_API_TIMEOUT", "123000"),
            ("MINERU_POLL_INTERVAL", "7000"),
            ("PaperReaderChunkSize", "999"),
            ("PaperReaderOverlap", "0.2"),
            ("PaperReaderMaxOutputTokens", "2222"),
            ("PaperReaderBatchSize", "3"),
            ("PaperReaderMaxConcurrentLLM", "4"),
            ("PaperReaderMaxConcurrentNodes", "6"),
            ("PaperReaderMaxChunks", "77"),
            ("PaperReaderMaxAuditChunks", "9"),
            ("PaperReaderRecursiveGroupSize", "12"),
            ("PaperReaderRecursiveMaxLevels", "4"),
            ("PaperReaderRecursiveCritic", "true"),
            ("PaperReaderRollingContextMaxEntries", "66"),
            ("PaperReaderRollingContextMaxChars", "7777"),
            ("PAPERREADER_FORCE_DETERMINISTIC", "true"),
        ]);

        let config = RuntimeConfig::from_reader(|key| vars.get(key).map(|value| value.to_string()));

        assert_eq!(config.workspace_root, PathBuf::from("D:/tmp/workspace-rs"));
        assert!(config.api_key_present);
        assert_eq!(config.api_key.as_deref(), Some("secret"));
        assert!(config.mineru_api_token_present);
        assert_eq!(config.mineru_api_token.as_deref(), Some("mineru-secret"));
        assert_eq!(config.mineru_model_version, "vlm");
        assert_eq!(config.paperreader_model.as_deref(), Some("gpt-5.3"));
        assert_eq!(config.mineru_api_timeout_ms, 123000);
        assert_eq!(config.mineru_poll_interval_ms, 7000);
        assert_eq!(config.paperreader_chunk_size_tokens, 999);
        assert!((config.paperreader_overlap_ratio - 0.2).abs() < f64::EPSILON);
        assert_eq!(config.paperreader_max_output_tokens, 2222);
        assert_eq!(config.paperreader_batch_size, 3);
        assert_eq!(config.paperreader_max_concurrent_llm, 4);
        assert_eq!(config.paperreader_max_concurrent_nodes, 6);
        assert_eq!(config.paperreader_max_chunks, 77);
        assert_eq!(config.paperreader_max_audit_chunks, 9);
        assert_eq!(config.paperreader_recursive_group_size, 12);
        assert_eq!(config.paperreader_recursive_max_levels, 4);
        assert!(config.paperreader_recursive_enable_critic);
        assert_eq!(config.paperreader_rolling_context_max_entries, 66);
        assert_eq!(config.paperreader_rolling_context_max_chars, 7777);
        assert!(config.force_deterministic);
    }

    #[test]
    fn runtime_config_ignores_empty_values() {
        let vars = HashMap::from([
            ("API_URL", "   "),
            ("API_Key", ""),
            ("PaperReaderModel", "\t"),
        ]);

        let config = RuntimeConfig::from_reader(|key| vars.get(key).map(|value| value.to_string()));

        assert!(config.api_url.is_none());
        assert!(!config.api_key_present);
        assert!(config.api_key.is_none());
        assert!(config.paperreader_model.is_none());
        assert_eq!(config.workspace_root, PathBuf::from("./workspace-rs"));
        assert_eq!(config.mineru_model_version, "pipeline");
        assert_eq!(config.mineru_api_timeout_ms, 300_000);
        assert_eq!(config.mineru_poll_interval_ms, 5_000);
        assert_eq!(config.paperreader_chunk_size_tokens, 2_000);
        assert!((config.paperreader_overlap_ratio - 0.15).abs() < f64::EPSILON);
        assert_eq!(config.paperreader_max_output_tokens, 12_000);
        assert_eq!(config.paperreader_batch_size, 5);
        assert_eq!(config.paperreader_max_concurrent_llm, 5);
        assert_eq!(config.paperreader_max_concurrent_nodes, 3);
        assert_eq!(config.paperreader_max_chunks, 120);
        assert_eq!(config.paperreader_max_audit_chunks, 8);
        assert_eq!(config.paperreader_recursive_group_size, 8);
        assert_eq!(config.paperreader_recursive_max_levels, 6);
        assert!(!config.paperreader_recursive_enable_critic);
        assert_eq!(config.paperreader_rolling_context_max_entries, 40);
        assert_eq!(config.paperreader_rolling_context_max_chars, 12_000);
        assert!(!config.force_deterministic);
    }
}
