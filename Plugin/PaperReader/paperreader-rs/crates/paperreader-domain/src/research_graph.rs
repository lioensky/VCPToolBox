use crate::prelude::*;
use crate::*;

// =============================================================================
// ResearchGraph - 研究图
// =============================================================================

fn default_graph_schema_version() -> String {
    "1.0".to_string()
}

/// 研究图
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResearchGraph {
    /// 图ID
    pub graph_id: String,
    /// 目标
    pub goal: String,
    /// 图 schema 版本
    #[serde(default = "default_graph_schema_version")]
    pub schema_version: String,
    /// 根作用域
    pub root_scope: GraphScopeRef,
    /// 根节点ID
    pub root_node_id: String,
    /// 节点映射
    pub nodes: HashMap<String, ResearchNode>,
    /// 节点执行顺序提示
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub node_order: Vec<String>,
    /// 边列表
    pub edges: Vec<ResearchEdge>,
    /// 创建时间
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraphScopeRef {
    pub scope_type: ScopeType,
    pub scope_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScopeType {
    Document,
    Collection,
}

/// 研究节点
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResearchNode {
    /// 节点ID
    pub node_id: String,
    /// 节点类型
    #[serde(rename = "kind", alias = "node_type")]
    pub node_type: NodeType,
    /// 目标/问题
    pub goal: String,
    /// 作用域引用
    pub scope_ref: String,
    /// 执行状态
    #[serde(rename = "status", alias = "execution_state")]
    pub execution_state: NodeExecutionState,
    /// 依赖节点ID列表
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<String>,
    /// 子节点ID列表
    #[serde(default)]
    pub child_ids: Vec<String>,
    /// 父节点ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// 输入工件ID列表
    #[serde(default)]
    pub input_artifacts: Vec<String>,
    /// 输入引用（PRD SSOT）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub input_refs: Vec<String>,
    /// 输出工件ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_artifact: Option<String>,
    /// 输出引用（PRD SSOT）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub output_refs: Vec<String>,
    /// handoff 输入引用
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handoff_in_ref: Option<String>,
    /// handoff 输出引用
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handoff_out_ref: Option<String>,
    /// checkpoint 引用
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkpoint_ref: Option<String>,
    /// 尝试次数
    #[serde(default)]
    pub attempt: u32,
    /// 预算消耗
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget_consumed: Option<BudgetConsumed>,
    /// PRD 预算视图
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget: Option<BudgetConsumed>,
    /// 停止条件
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stop_conditions: Vec<String>,
    /// 失败策略
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_policy: Option<String>,
    /// 执行载荷
    #[serde(default)]
    pub payload: serde_json::Value,
    /// 创建时间
    pub created_at: String,
    /// 更新时间
    pub updated_at: String,
}

/// 节点类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum NodeType {
    /// 概览
    Survey,
    /// 阅读
    Read,
    /// 检索
    Retrieve,
    /// 综合
    Synthesize,
    /// 比较
    Compare,
    /// 追踪声明
    TraceClaim,
    /// 审计冲突
    AuditConflict,
    /// 合并
    Merge,
    /// 重新规划
    Replan,
}

/// 节点执行状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeExecutionState {
    /// 待执行
    Pending,
    /// 执行中
    Running,
    /// 已完成
    Completed,
    /// 失败
    Failed(String),
    /// 已跳过
    Skipped,
}

/// 研究边
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResearchEdge {
    /// 边ID
    pub edge_id: String,
    /// 源节点
    pub from_node_id: String,
    /// 目标节点
    pub to_node_id: String,
    /// 边类型
    pub edge_type: EdgeType,
}

/// 边类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EdgeType {
    /// 顺序执行
    Sequential,
    /// 数据依赖
    DataDependency,
    /// 条件分支
    Conditional,
}

/// 预算消耗
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct BudgetConsumed {
    /// Token数量
    pub tokens: u64,
    /// LLM调用次数
    pub llm_calls: u32,
    /// 耗时（秒）
    pub elapsed_seconds: u64,
}
