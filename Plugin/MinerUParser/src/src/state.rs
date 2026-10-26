//! 状态机持久化：state.json 原子写 + index.json（卡片与 list 的数据源）。

use crate::error::AppError;
use crate::protocol::{ImageEntry, OutlineNode};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// state.json 中的状态值。
pub const STATE_UPLOADING: &str = "uploading";
pub const STATE_RUNNING: &str = "running";
pub const STATE_DOWNLOADING: &str = "downloading";
pub const STATE_EXTRACTING: &str = "extracting";
pub const STATE_INDEXED: &str = "indexed";
pub const STATE_FAILED: &str = "failed";
pub const STATE_TIMEOUT: &str = "timeout";

#[derive(Serialize, Deserialize, Debug, Default, Clone)]
pub struct PersistentState {
    pub paper_id: String,
    pub batch_id: String,
    pub state: String,
    pub file_name: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub last_progress: Option<ProgressInfo>,
    #[serde(default)]
    pub err_msg: Option<String>,
    /// >200 页分片模式：总页数
    #[serde(default)]
    pub split_pages: Option<u64>,
    /// 分片模式：每片页数
    #[serde(default)]
    pub chunk_size: Option<u64>,
    /// 分片进度（与 batch_id 字段互斥使用；单文件模式为空）
    #[serde(default)]
    pub chunks: Vec<ChunkState>,
    /// 原始解析参数（分片续查重传时使用）
    #[serde(default)]
    pub is_ocr: bool,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default = "default_model")]
    pub model_version: String,
    /// 源 PDF 绝对路径（URL 模式为空）
    #[serde(default)]
    pub source_path: Option<String>,
    /// 源文件所在目录（用于工作区溯源）
    #[serde(default)]
    pub source_dir: Option<String>,
    /// 用户显式指定的标题（优先于 content_list 推导）
    #[serde(default)]
    pub title_override: Option<String>,
    /// 标题化资产目录名（file/mineru 与 image/mineru 共用叶子名）
    #[serde(default)]
    pub asset_dir: Option<String>,
}

fn default_language() -> String {
    "en".to_string()
}

fn default_model() -> String {
    "vlm".to_string()
}

/// 单个分片的处理进度（start/end_page 为原书 0-based [start, end)）。
#[derive(Serialize, Deserialize, Debug, Default, Clone)]
pub struct ChunkState {
    pub index: usize,
    pub start_page: u64,
    pub end_page: u64,
    pub batch_id: String,
    /// pending（未上传）| running（已提交/处理中）| done（已下载解压）
    pub state: String,
    #[serde(default)]
    pub err_msg: Option<String>,
    #[serde(default)]
    pub extracted: Option<u64>,
    #[serde(default)]
    pub total: Option<u64>,
}

#[derive(Serialize, Deserialize, Debug, Default, Clone)]
pub struct ProgressInfo {
    #[serde(default)]
    pub extracted_pages: u64,
    #[serde(default)]
    pub total_pages: u64,
}

/// index.json：indexed 后生成的资产索引。
#[derive(Serialize, Deserialize, Debug, Default, Clone)]
pub struct IndexDoc {
    pub paper_id: String,
    pub title: String,
    pub file_name: String,
    /// 标题化资产目录叶子名（旧索引可能为空，回退 paper_id）
    #[serde(default)]
    pub asset_dir: Option<String>,
    /// 源 PDF 绝对路径 / 所在目录
    #[serde(default)]
    pub source_path: Option<String>,
    #[serde(default)]
    pub source_dir: Option<String>,
    /// 最近一次批次 ID（便于续查）
    #[serde(default)]
    pub batch_id: Option<String>,
    #[serde(default)]
    pub pages: u64,
    pub text_chars: u64,
    pub image_count: usize,
    pub table_count: usize,
    pub formula_count: usize,
    pub md_path: String,
    pub render_url: String,
    pub outline: Vec<OutlineNode>,
    pub images: Vec<ImageEntry>,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub created_at: String,
}

impl PersistentState {
    pub fn new(paper_id: &str, file_name: &str) -> Self {
        let now = now_iso();
        PersistentState {
            paper_id: paper_id.to_string(),
            batch_id: String::new(),
            state: STATE_UPLOADING.to_string(),
            file_name: file_name.to_string(),
            created_at: now.clone(),
            updated_at: now,
            last_progress: None,
            err_msg: None,
            split_pages: None,
            chunk_size: None,
            chunks: Vec::new(),
            is_ocr: false,
            language: default_language(),
            model_version: default_model(),
            source_path: None,
            source_dir: None,
            title_override: None,
            asset_dir: None,
        }
    }
}

pub fn state_path(file_dir: &Path) -> PathBuf {
    file_dir.join("state.json")
}

pub fn index_path(file_dir: &Path) -> PathBuf {
    file_dir.join("index.json")
}

/// 读取 state.json；不存在返回 None。
pub fn load_state(file_dir: &Path) -> Option<PersistentState> {
    let text = fs::read_to_string(state_path(file_dir)).ok()?;
    serde_json::from_str(&text).ok()
}

/// 原子写 state.json（临时文件 + rename），同时刷新 updated_at。
pub fn save_state(file_dir: &Path, state: &mut PersistentState) -> Result<(), AppError> {
    state.updated_at = now_iso();
    atomic_write_json(&state_path(file_dir), state)
}

pub fn load_index(file_dir: &Path) -> Option<IndexDoc> {
    let text = fs::read_to_string(index_path(file_dir)).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn save_index(file_dir: &Path, doc: &IndexDoc) -> Result<(), AppError> {
    atomic_write_json(&index_path(file_dir), doc)
}

fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), AppError> {
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(value)
        .map_err(|e| AppError::fix(format!("JSON 序列化失败: {}", e)))?;
    fs::write(&tmp, text).map_err(|e| AppError::fix(format!("写入 {} 失败: {}", tmp.display(), e)))?;
    fs::rename(&tmp, path)
        .map_err(|e| AppError::fix(format!("落盘 {} 失败: {}", path.display(), e)))?;
    Ok(())
}

/// UTC ISO 8601 时间戳（不引入 chrono，手工换算）。
pub fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    epoch_to_iso(secs)
}

fn epoch_to_iso(secs: u64) -> String {
    let days = secs / 86400;
    let rem = secs % 86400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (year, month, day) = civil_from_days(days as i64);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, h, m, s
    )
}

/// Howard Hinnant 的 days_from_civil 逆算法。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("mineruparser_state_{}_{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn state_roundtrip() {
        let dir = temp_dir("roundtrip");
        let mut st = PersistentState::new("paper_abc", "demo.pdf");
        st.batch_id = "batch1".to_string();
        st.state = STATE_RUNNING.to_string();
        st.last_progress = Some(ProgressInfo {
            extracted_pages: 3,
            total_pages: 12,
        });
        save_state(&dir, &mut st).unwrap();
        let loaded = load_state(&dir).unwrap();
        assert_eq!(loaded.paper_id, "paper_abc");
        assert_eq!(loaded.batch_id, "batch1");
        assert_eq!(loaded.state, "running");
        assert_eq!(loaded.last_progress.unwrap().total_pages, 12);
        // 原子写不留临时文件
        assert!(!dir.join("state.json.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn index_roundtrip() {
        let dir = temp_dir("index");
        let doc = IndexDoc {
            paper_id: "paper_abc".to_string(),
            title: "T".to_string(),
            pages: 5,
            outline: vec![OutlineNode {
                level: 1,
                text: "Intro".to_string(),
                page_idx: 0,
            }],
            ..Default::default()
        };
        save_index(&dir, &doc).unwrap();
        let loaded = load_index(&dir).unwrap();
        assert_eq!(loaded.outline.len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn iso_epoch_vectors() {
        assert_eq!(epoch_to_iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(epoch_to_iso(1_000_000_000), "2001-09-09T01:46:40Z");
        assert_eq!(epoch_to_iso(1_700_000_000), "2023-11-14T22:13:20Z");
        assert_eq!(epoch_to_iso(951_782_400), "2000-02-29T00:00:00Z"); // 闰年
    }

    #[test]
    fn missing_state_returns_none() {
        let dir = temp_dir("missing");
        assert!(load_state(&dir).is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
