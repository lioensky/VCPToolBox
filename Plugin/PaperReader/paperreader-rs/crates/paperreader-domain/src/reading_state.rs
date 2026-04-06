use crate::prelude::*;
use crate::*;

// =============================================================================
// ReadingState - 单文档阅读状态
// =============================================================================

/// 阅读状态 - 单文档阅读过程的运行状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReadingState {
    /// 文档ID
    pub document_id: DocumentId,
    /// 研究目标
    pub goal: String,
    /// 请求的阅读模式
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_mode: Option<String>,
    /// 读取约束
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub constraints: Vec<String>,
    /// 当前阶段
    pub current_phase: ReadingPhase,
    /// 注意力计划
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attention_plan: Option<AttentionPlan>,
    /// 阅读日志
    #[serde(default)]
    pub read_log: Vec<ReadLogEntry>,
    /// 全局地图（面向超大单文本的递归压缩视图）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub global_map: Option<String>,
    /// 滚动上下文
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rolling_context: Option<String>,
    /// Segment摘要
    #[serde(default)]
    pub segment_summaries: HashMap<SegmentId, String>,
    /// 审计报告
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audit_report: Option<AuditReport>,
    /// 当前轮次
    pub round: u32,
    /// 创建时间
    pub created_at: String,
    /// 更新时间
    pub updated_at: String,
}

/// 注意力计划
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AttentionPlan {
    /// 计划ID
    pub plan_id: String,
    /// 目标
    pub goal: String,
    /// 注意力分配
    pub allocations: Vec<AttentionAllocation>,
    /// 创建时间
    pub created_at: String,
}

/// 注意力分配
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AttentionAllocation {
    /// Segment ID
    pub segment_id: SegmentId,
    /// 阅读模式
    pub mode: ReadMode,
    /// 优先级
    pub priority: u8,
    /// 理由
    pub reason: String,
}

/// 阅读日志条目
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReadLogEntry {
    /// 条目ID
    pub entry_id: String,
    /// Segment ID
    pub segment_id: SegmentId,
    /// 阅读模式
    pub mode: ReadMode,
    /// 轮次
    pub round: u32,
    /// 摘要
    pub summary: String,
    /// 时间戳
    pub timestamp: String,
}

/// 审计报告
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AuditReport {
    /// 报告ID
    pub report_id: String,
    /// 发现的问题
    pub findings: Vec<AuditFinding>,
    /// 总体评估
    pub overall_assessment: String,
    /// 创建时间
    pub created_at: String,
}

/// 审计发现
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AuditFinding {
    /// 发现ID
    pub finding_id: String,
    /// 严重程度
    pub severity: AuditSeverity,
    /// 描述
    pub description: String,
    /// 相关证据
    pub evidence_refs: Vec<EvidenceRef>,
    /// 建议
    pub recommendation: String,
}

/// 审计严重程度
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuditSeverity {
    /// 严重
    Critical,
    /// 高
    High,
    /// 中
    Medium,
    /// 低
    Low,
    /// 信息
    Info,
}
