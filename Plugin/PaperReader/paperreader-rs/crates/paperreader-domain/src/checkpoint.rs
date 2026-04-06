use crate::prelude::*;
use crate::*;

// =============================================================================
// Checkpoint - 检查点
// =============================================================================

/// 检查点
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Checkpoint {
    /// 检查点ID
    pub checkpoint_id: String,
    /// 关联的运行ID
    pub run_id: String,
    /// 检查点类型
    pub checkpoint_type: CheckpointType,
    /// 节点状态快照
    pub node_states: HashMap<String, NodeExecutionState>,
    /// 工件引用
    pub artifact_refs: Vec<String>,
    /// 创建时间
    pub created_at: String,
    /// 元数据
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub metadata: HashMap<String, serde_json::Value>,
}

/// 检查点类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointType {
    /// 手动检查点
    Manual,
    /// 自动检查点
    Auto,
    /// 里程碑检查点
    Milestone,
    /// 失败恢复检查点
    Recovery,
}
