use crate::prelude::*;
use crate::*;

// =============================================================================
// CrossDocumentState - 多文档状态
// =============================================================================

/// 跨文档状态 - 多文档归纳与比较过程的运行状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CrossDocumentState {
    /// 集合ID
    pub collection_id: CollectionId,
    /// 研究目标
    pub goal: String,
    /// 各文档状态
    #[serde(default)]
    pub doc_states: HashMap<DocumentId, DocumentCrossState>,
    /// 声明对齐
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim_alignment: Option<ClaimAlignment>,
    /// 冲突映射
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict_map: Option<ConflictMap>,
    /// 证据包
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence_pack: Option<EvidencePack>,
    /// 综合状态
    #[serde(skip_serializing_if = "Option::is_none")]
    pub synthesis_state: Option<SynthesisState>,
}

/// 文档跨文档状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DocumentCrossState {
    /// 文档ID
    pub document_id: DocumentId,
    /// 是否已处理
    pub processed: bool,
    /// 关键声明
    #[serde(default)]
    pub key_claims: Vec<ClaimUnit>,
    /// 更新时间
    pub updated_at: String,
}

/// 声明单元
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClaimUnit {
    /// 声明ID
    pub claim_id: String,
    /// 声明文本
    pub text: String,
    /// 来源文档
    pub document_id: DocumentId,
    /// 来源Segment
    pub segment_id: SegmentId,
    /// 置信度
    pub confidence: f64,
    /// 声明类型
    pub claim_type: ClaimType,
}

/// 声明类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClaimType {
    /// 事实
    Fact,
    /// 观点
    Opinion,
    /// 假设
    Hypothesis,
    /// 结论
    Conclusion,
}

/// 声明对齐
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClaimAlignment {
    /// 对齐组
    pub alignment_groups: Vec<AlignmentGroup>,
    /// 创建时间
    pub created_at: String,
}

/// 对齐组
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AlignmentGroup {
    /// 组ID
    pub group_id: String,
    /// 对齐类型
    pub alignment_type: AlignmentType,
    /// 声明列表
    pub claims: Vec<ClaimUnit>,
    /// 对齐分数
    pub alignment_score: f64,
}

/// 对齐类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AlignmentType {
    /// 共享（相同声明）
    Shared,
    /// 互补（互相补充）
    Complementary,
    /// 冲突（互相矛盾）
    Conflicting,
    /// 弱信号（微弱关联）
    WeakSignal,
}

/// 冲突映射
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConflictMap {
    /// 冲突条目
    pub conflicts: Vec<ConflictEntry>,
    /// 创建时间
    pub created_at: String,
}

/// 冲突条目
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConflictEntry {
    /// 冲突ID
    pub conflict_id: String,
    /// 冲突声明
    pub claims: Vec<ClaimUnit>,
    /// 冲突分数
    pub conflict_score: f64,
    /// 冲突描述
    pub description: String,
}

/// 综合状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SynthesisState {
    /// 状态
    pub state: SynthesisProgress,
    /// 当前结果
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_result: Option<String>,
    /// 更新次数
    pub update_count: u32,
}

/// 综合进度
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SynthesisProgress {
    /// 未开始
    NotStarted,
    /// 进行中
    InProgress,
    /// 已完成
    Completed,
    /// 已暂停
    Paused,
}
