use crate::prelude::*;
use crate::*;

// =============================================================================
// 领域事件
// =============================================================================

/// 领域事件枚举
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case", tag = "event_type")]
pub enum DomainEvent {
    /// 文档已导入
    DocumentImported {
        document_id: DocumentId,
        timestamp: String,
    },
    /// 文档已解析
    DocumentParsed {
        document_id: DocumentId,
        timestamp: String,
    },
    /// 文档已规范化
    DocumentNormalized {
        document_id: DocumentId,
        timestamp: String,
    },
    /// 结构已构建
    StructureBuilt {
        document_id: DocumentId,
        timestamp: String,
    },
    /// Segments已规划
    SegmentsPlanned {
        document_id: DocumentId,
        segment_count: usize,
        timestamp: String,
    },
    /// 阅读已开始
    ReadingStarted {
        document_id: DocumentId,
        goal: String,
        timestamp: String,
    },
    /// 注意力已规划
    AttentionPlanned {
        document_id: DocumentId,
        plan_id: String,
        timestamp: String,
    },
    /// Segment已阅读
    SegmentRead {
        document_id: DocumentId,
        segment_id: SegmentId,
        timestamp: String,
    },
    /// 审计已完成
    AuditCompleted {
        document_id: DocumentId,
        report_id: String,
        timestamp: String,
    },
    /// 文档已综合
    DocumentSynthesized {
        document_id: DocumentId,
        timestamp: String,
    },
    /// 集合已创建
    CollectionCreated {
        collection_id: CollectionId,
        timestamp: String,
    },
    /// 跨文档已对齐
    CrossDocumentAligned {
        collection_id: CollectionId,
        timestamp: String,
    },
    /// 冲突已检测
    ConflictDetected {
        collection_id: CollectionId,
        conflict_id: String,
        timestamp: String,
    },
    /// 集合已综合
    CollectionSynthesized {
        collection_id: CollectionId,
        timestamp: String,
    },
}
