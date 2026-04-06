use crate::prelude::*;
use crate::*;

// =============================================================================
// Document - 文档聚合根
// =============================================================================

/// 文档聚合根
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Document {
    /// 文档ID
    pub document_id: DocumentId,
    /// 标题
    pub title: String,
    /// 源类型
    pub source_type: SourceType,
    /// 源引用（原始文件路径/URL）
    pub source_ref: String,
    /// 元数据
    pub metadata: DocumentMetadata,
    /// 解析状态
    pub parse_status: ParseStatus,
    /// 解析质量
    pub parse_quality: ParseQuality,
    /// 创建时间
    pub created_at: String,
    /// 更新时间
    pub updated_at: String,
}

/// 解析状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ParseStatus {
    /// 待解析
    Pending,
    /// 解析中
    Parsing,
    /// 已解析
    Parsed,
    /// 解析失败
    Failed(String),
}

impl Document {
    pub fn new(
        document_id: DocumentId,
        title: impl Into<String>,
        source_type: SourceType,
        source_ref: impl Into<String>,
    ) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            document_id,
            title: title.into(),
            source_type,
            source_ref: source_ref.into(),
            metadata: DocumentMetadata::default(),
            parse_status: ParseStatus::Pending,
            parse_quality: ParseQuality::Unsupported,
            created_at: now.clone(),
            updated_at: now,
        }
    }
}
