use crate::prelude::*;

// =============================================================================
// 基础值对象
// =============================================================================

/// 文档唯一标识
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct DocumentId(pub String);

impl DocumentId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }
}

impl std::fmt::Display for DocumentId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// 集合唯一标识
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct CollectionId(pub String);

impl CollectionId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }
}

impl std::fmt::Display for CollectionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Segment唯一标识
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct SegmentId(pub String);

impl SegmentId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }
}

/// Block唯一标识
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct BlockId(pub String);

impl BlockId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }
}

/// Node唯一标识（用于StructureTree）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct NodeId(pub String);

impl NodeId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }
}

/// 解析质量
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ParseQuality {
    /// 完全结构化
    Structured,
    /// 部分结构化
    Partial,
    /// 不支持
    Unsupported,
}

/// 阅读阶段
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReadingPhase {
    /// 概览阶段
    Survey,
    /// 分流阶段
    Triage,
    /// 深度阅读
    DeepDive,
    /// 扫读
    Skim,
    /// 审计
    Audit,
    /// 综合
    Synthesize,
}

/// 阅读模式
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReadMode {
    /// 深度阅读
    Deep,
    /// 扫读
    Skim,
    /// 跳过
    Skip,
}

/// 源类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SourceType {
    /// PDF
    Pdf,
    /// Markdown
    Markdown,
    /// HTML
    Html,
    /// 纯文本
    PlainText,
    /// 其他
    Other(String),
}
