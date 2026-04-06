use crate::prelude::*;
use crate::*;

// =============================================================================
// Segment - 可阅读/可检索的最小逻辑单元
// =============================================================================

/// 文档分段 - 可阅读、可检索、可引用的最小逻辑执行单元
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Segment {
    /// Segment ID
    pub segment_id: SegmentId,
    /// 所属文档ID
    pub document_id: DocumentId,
    /// 节点路径（在StructureTree中的位置）
    pub node_path: Vec<NodeId>,
    /// Block范围
    pub block_range: BlockRange,
    /// 文本内容
    pub text: String,
    /// Token估算
    pub token_estimate: u32,
    /// Segment类型
    pub segment_type: SegmentType,
    /// 引用
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub citations: Vec<String>,
}

/// Segment类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SegmentType {
    /// 标题
    Heading,
    /// 正文
    Body,
    /// 表格
    Table,
    /// 图片说明
    FigureCaption,
    /// 列表
    List,
    /// 引用
    Quote,
    /// 代码
    Code,
}

/// Segment集合
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SegmentSet {
    /// 文档ID
    pub document_id: DocumentId,
    /// Segment列表
    pub segments: Vec<Segment>,
    /// 版本
    pub version: String,
}
