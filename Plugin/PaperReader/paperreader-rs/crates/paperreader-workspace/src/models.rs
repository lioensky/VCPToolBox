use crate::prelude::*;

// =============================================================================
// Workspace 工件定义
// =============================================================================

/// 源清单
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SourceManifest {
    pub document_id: DocumentId,
    pub source_type: SourceType,
    pub source_ref: String,
    pub original_filename: Option<String>,
    pub file_size_bytes: Option<u64>,
    pub checksum: Option<String>,
    pub ingested_at: String,
}

/// 文档清单
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DocumentManifest {
    pub document_id: DocumentId,
    pub title: String,
    pub parse_status: ParseStatus,
    pub parse_quality: ParseQuality,
}

/// 集合清单
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CollectionManifest {
    pub collection_id: CollectionId,
    pub name: String,
    pub goal: String,
    pub document_count: usize,
    pub created_at: String,
    pub updated_at: String,
}

/// Run清单
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunManifest {
    pub run_id: String,
    pub goal: String,
    pub scope: RunScope,
    pub root_entity_refs: RootEntityRefs,
    pub graph_ref: PathBuf,
    pub run_state_ref: PathBuf,
    pub budget_state_ref: PathBuf,
    pub entry_checkpoint: Option<PathBuf>,
    pub created_at: String,
    pub updated_at: String,
}

/// Run范围
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunScope {
    Document,
    Collection,
}

/// 根实体引用
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RootEntityRefs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection_id: Option<CollectionId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub document_ids: Vec<DocumentId>,
}

/// Run状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunState {
    pub run_id: String,
    pub status: RunStatus,
    pub current_phase: Option<String>,
    pub current_node_id: Option<String>,
    pub resume_entry: Option<String>,
    pub started_at: String,
    pub last_updated_at: String,
    pub completed_at: Option<String>,
}

/// Run状态枚举
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Pending,
    Running,
    Paused,
    Completed,
    Failed,
    Aborted,
}

/// 图状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GraphState {
    pub graph_id: String,
    pub run_id: String,
    pub node_states: HashMap<String, NodeStateEntry>,
    pub active_nodes: Vec<String>,
    pub completed_nodes: Vec<String>,
    pub failed_nodes: Vec<String>,
    pub updated_at: String,
}

/// 节点状态条目
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NodeStateEntry {
    pub node_id: String,
    pub status: NodeWorkspaceStatus,
    pub attempt: u32,
    pub checkpoint_ref: Option<PathBuf>,
    pub output_refs: Vec<PathBuf>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

/// 节点工作空间状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeWorkspaceStatus {
    Pending,
    Ready,
    Running,
    Checkpointed,
    Blocked,
    WaitingMerge,
    Completed,
    Partial,
    Failed,
    Aborted,
    Superseded,
}

/// 预算状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BudgetState {
    pub run_id: String,
    pub token_budget_total: u64,
    pub token_budget_used: u64,
    pub llm_call_budget_total: u32,
    pub llm_call_budget_used: u32,
    pub wall_clock_budget_total_seconds: u64,
    pub wall_clock_budget_used_seconds: u64,
    pub context_pressure_score: f64,
    pub artifact_volume_score: f64,
    pub updated_at: String,
}

/// Handoff工件
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HandoffArtifact {
    /// 聚焦问题
    pub focus_questions: Vec<String>,
    /// 已确认事实
    pub confirmed_facts: Vec<ConfirmedFact>,
    /// 未解决问题
    pub open_questions: Vec<OpenQuestion>,
    /// 必须保留的引用
    pub must_keep_refs: Vec<EvidenceRef>,
    /// 下一个动作提示
    pub next_action_hints: Vec<String>,
    /// 创建时间
    pub created_at: String,
}

/// 已确认事实
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConfirmedFact {
    pub fact_id: String,
    pub text: String,
    pub confidence: f64,
    pub evidence_refs: Vec<EvidenceRef>,
}

/// 未解决问题
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OpenQuestion {
    pub question_id: String,
    pub text: String,
    pub priority: u8,
    pub related_segments: Vec<SegmentId>,
}

/// 失败工件
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FailureArtifact {
    pub node_id: String,
    pub failure_type: FailureType,
    pub message: String,
    pub retryable: bool,
    pub related_input_refs: Vec<PathBuf>,
    pub partial_outputs: Vec<PathBuf>,
    pub suggested_recovery: Option<String>,
    pub timestamp: String,
}

/// 节点输入清单
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NodeInputManifest {
    pub run_id: String,
    pub node_id: String,
    pub node_type: String,
    pub input_refs: Vec<PathBuf>,
    pub created_at: String,
}

/// 节点输出清单
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NodeOutputManifest {
    pub run_id: String,
    pub node_id: String,
    pub status: String,
    pub primary_ref: Option<PathBuf>,
    pub output_refs: Vec<PathBuf>,
    pub checkpoint_ref: Option<PathBuf>,
    pub trace_ref: PathBuf,
    pub updated_at: String,
}

/// 失败类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FailureType {
    ValidationFailure,
    BudgetExceeded,
    RetrievalFailure,
    ParseFailure,
    MergeFailure,
    ConflictUnresolved,
    CheckpointCorrupted,
}

/// 合并工件
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MergeArtifact {
    pub merge_id: String,
    pub input_node_ids: Vec<String>,
    pub merge_decisions: Vec<MergeDecision>,
    pub unresolved_conflicts: Vec<UnresolvedConflict>,
    pub merged_handoff: HandoffArtifact,
    pub created_at: String,
}

/// 合并决策
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MergeDecision {
    pub decision_id: String,
    pub source_node_id: String,
    pub decision_type: MergeDecisionType,
    pub reason: String,
    pub affected_claims: Vec<String>,
}

/// 合并决策类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MergeDecisionType {
    Absorbed,
    Discarded,
    Downgraded,
    FlaggedForReview,
}

/// 未解决冲突
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UnresolvedConflict {
    pub conflict_id: String,
    pub conflicting_claims: Vec<String>,
    pub description: String,
}
