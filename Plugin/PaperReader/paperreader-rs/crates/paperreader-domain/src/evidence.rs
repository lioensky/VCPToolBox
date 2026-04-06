use crate::prelude::*;
use crate::*;

// =============================================================================
// EvidenceRef - 证据引用
// =============================================================================

/// 证据引用 - 指向document/block/segment的统一证据引用结构
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EvidenceRef {
    /// 引用ID
    #[serde(alias = "evidence_id")]
    pub ref_id: String,
    /// 文档ID
    pub document_id: DocumentId,
    /// Segment ID（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segment_id: Option<SegmentId>,
    /// Block ID（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_id: Option<BlockId>,
    /// 节点ID（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<NodeId>,
    /// Block ID 列表
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub block_ids: Vec<BlockId>,
    /// 关联资产引用
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub asset_refs: Vec<String>,
    /// 稳定定位信息
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub locators: Vec<EvidenceLocator>,
    /// 引用文本片段
    pub text_snippet: String,
    /// 引用类型
    pub ref_type: EvidenceRefType,
    /// 相关性分数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relevance_score: Option<f64>,
    /// 原始 citation 文本
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub citation_text: Option<String>,
    /// 证据作用域
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

/// 证据定位信息
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct EvidenceLocator {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub section_path: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub block_offsets: Vec<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_anchor: Option<String>,
}

/// 证据引用类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceRefType {
    /// 直接引用
    Direct,
    /// 推断
    Inference,
    /// 对比
    Contrast,
    /// 支持
    Support,
    /// 反驳
    Refute,
}

/// 证据包
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EvidencePack {
    /// 证据引用列表
    #[serde(rename = "evidence_refs", alias = "refs")]
    pub refs: Vec<EvidenceRef>,
    /// 包ID
    pub pack_id: String,
    /// 生成目标
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    /// 查询文本
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query_text: Option<String>,
    /// 作用域
    pub scope: String,
    /// 覆盖说明
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub coverage_notes: Vec<String>,
    /// 潜在遗漏风险
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub omission_risks: Vec<String>,
    /// 创建时间
    #[serde(alias = "generated_at")]
    pub created_at: String,
}
