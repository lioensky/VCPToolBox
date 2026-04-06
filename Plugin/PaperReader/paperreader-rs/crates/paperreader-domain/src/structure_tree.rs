use crate::prelude::*;
use crate::*;

// =============================================================================
// StructureTree - 文档结构树
// =============================================================================

/// 文档结构树
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StructureTree {
    /// 文档ID
    pub document_id: DocumentId,
    /// 根节点列表
    pub root_nodes: Vec<StructureNode>,
    /// 节点索引（node_id -> node）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_index: Option<HashMap<NodeId, StructureNode>>,
    /// 版本
    pub version: String,
}

/// 结构树节点
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StructureNode {
    /// 节点ID
    pub node_id: NodeId,
    /// 标题
    pub title: String,
    /// 层级
    pub level: u8,
    /// 父节点ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<NodeId>,
    /// 子节点
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<StructureNode>,
    /// 包含的blocks
    pub block_ids: Vec<BlockId>,
    /// 节点摘要
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}
