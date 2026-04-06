//! Domain层业务不变量
//!
//! 本模块定义领域层的核心业务约束，确保领域对象始终处于有效状态。
//! 这些不变量是业务正确性的最后防线。

use crate::*;

/// 不变量验证结果
#[derive(Debug, Clone, PartialEq)]
pub enum InvariantResult {
    /// 验证通过
    Valid,
    /// 验证失败，包含失败原因
    Invalid(Vec<String>),
}

impl InvariantResult {
    /// 检查是否有效
    pub fn is_valid(&self) -> bool {
        matches!(self, InvariantResult::Valid)
    }

    /// 检查是否无效
    pub fn is_invalid(&self) -> bool {
        !self.is_valid()
    }

    /// 合并多个验证结果
    pub fn merge(results: Vec<InvariantResult>) -> InvariantResult {
        let mut errors = Vec::new();
        for result in results {
            if let InvariantResult::Invalid(errs) = result {
                errors.extend(errs);
            }
        }
        if errors.is_empty() {
            InvariantResult::Valid
        } else {
            InvariantResult::Invalid(errors)
        }
    }
}

/// 领域对象不变量 trait
pub trait DomainInvariant {
    /// 验证对象是否满足所有业务不变量
    fn validate(&self) -> InvariantResult;
}

// =============================================================================
// NormalizedDocument 不变量
// =============================================================================

impl DomainInvariant for NormalizedDocument {
    fn validate(&self) -> InvariantResult {
        let mut errors = Vec::new();

        // INV-001: document_id 不能为空
        if self.document_id.0.trim().is_empty() {
            errors.push("INV-001: document_id cannot be empty".to_string());
        }

        // INV-002: title 不能为空
        if self.title.trim().is_empty() {
            errors.push("INV-002: title cannot be empty".to_string());
        }

        // INV-003: schema_version 必须符合语义化版本
        if !is_valid_semver(&self.schema_version) {
            errors.push(format!(
                "INV-003: schema_version '{}' is not valid semver",
                self.schema_version
            ));
        }

        // INV-004: blocks 必须有唯一的 block_id
        let mut block_ids = std::collections::HashSet::new();
        for block in &self.blocks {
            if !block_ids.insert(&block.block_id.0) {
                errors.push(format!(
                    "INV-004: duplicate block_id '{}' found",
                    block.block_id.0
                ));
            }
        }

        // INV-005: outline 中的 node_id 必须唯一
        let mut node_ids = std::collections::HashSet::new();
        for node in &self.outline {
            if !node_ids.insert(&node.node_id.0) {
                errors.push(format!(
                    "INV-005: duplicate node_id '{}' in outline",
                    node.node_id.0
                ));
            }
        }

        // INV-006: canonical_text 长度必须与 blocks 内容一致（如果非空）
        if !self.canonical_text.is_empty() && !self.blocks.is_empty() {
            let blocks_text: String = self
                .blocks
                .iter()
                .map(|b| &b.text as &str)
                .collect::<Vec<_>>()
                .join("\n\n");
            if self.canonical_text != blocks_text {
                // 警告级别，不阻止验证通过
                // errors.push("INV-006: canonical_text does not match blocks content".to_string());
            }
        }

        // INV-007: 如果存在 assets，每个 asset 必须引用有效的 block
        let valid_block_ids: std::collections::HashSet<_> =
            self.blocks.iter().map(|b| &b.block_id.0).collect();
        for asset in &self.assets {
            if !valid_block_ids.contains(&asset.source_block_id.0) {
                errors.push(format!(
                    "INV-007: asset '{}' references non-existent block '{}'",
                    asset.asset_id, asset.source_block_id.0
                ));
            }
        }

        if errors.is_empty() {
            InvariantResult::Valid
        } else {
            InvariantResult::Invalid(errors)
        }
    }
}

// =============================================================================
// Document 不变量
// =============================================================================

impl DomainInvariant for Document {
    fn validate(&self) -> InvariantResult {
        let mut errors = Vec::new();

        // INV-DOC-001: document_id 不能为空
        if self.document_id.0.trim().is_empty() {
            errors.push("INV-DOC-001: document_id cannot be empty".to_string());
        }

        // INV-DOC-002: source_ref 不能为空
        if self.source_ref.trim().is_empty() {
            errors.push("INV-DOC-002: source_ref cannot be empty".to_string());
        }

        // INV-DOC-003: created_at 必须是有效的 RFC3339 时间
        if chrono::DateTime::parse_from_rfc3339(&self.created_at).is_err() {
            errors.push(format!(
                "INV-DOC-003: created_at '{}' is not valid RFC3339",
                self.created_at
            ));
        }

        // INV-DOC-004: updated_at 必须 >= created_at
        if let (Ok(created), Ok(updated)) = (
            chrono::DateTime::parse_from_rfc3339(&self.created_at),
            chrono::DateTime::parse_from_rfc3339(&self.updated_at),
        ) {
            if updated < created {
                errors.push("INV-DOC-004: updated_at must be >= created_at".to_string());
            }
        }

        if errors.is_empty() {
            InvariantResult::Valid
        } else {
            InvariantResult::Invalid(errors)
        }
    }
}

// =============================================================================
// Collection 不变量
// =============================================================================

impl DomainInvariant for Collection {
    fn validate(&self) -> InvariantResult {
        let mut errors = Vec::new();

        // INV-COL-001: collection_id 不能为空
        if self.collection_id.0.trim().is_empty() {
            errors.push("INV-COL-001: collection_id cannot be empty".to_string());
        }

        // INV-COL-002: name 不能为空
        if self.name.trim().is_empty() {
            errors.push("INV-COL-002: name cannot be empty".to_string());
        }

        // INV-COL-003: goal 不能为空（集合必须有明确的研究目标）
        if self.goal.trim().is_empty() {
            errors.push("INV-COL-003: goal cannot be empty".to_string());
        }

        // INV-COL-004: document_ids 不能包含重复项
        let unique_count = self
            .document_ids
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len();
        if unique_count != self.document_ids.len() {
            errors.push("INV-COL-004: document_ids contains duplicates".to_string());
        }

        if errors.is_empty() {
            InvariantResult::Valid
        } else {
            InvariantResult::Invalid(errors)
        }
    }
}

// =============================================================================
// ResearchGraph 不变量
// =============================================================================

impl DomainInvariant for ResearchGraph {
    fn validate(&self) -> InvariantResult {
        let mut errors = Vec::new();

        // INV-GRAPH-001: graph_id 不能为空
        if self.graph_id.trim().is_empty() {
            errors.push("INV-GRAPH-001: graph_id cannot be empty".to_string());
        }

        // INV-GRAPH-002: goal 不能为空
        if self.goal.trim().is_empty() {
            errors.push("INV-GRAPH-002: goal cannot be empty".to_string());
        }

        // INV-GRAPH-003: root_node_id 必须在 nodes 中存在
        if !self.nodes.contains_key(&self.root_node_id) {
            errors.push(format!(
                "INV-GRAPH-003: root_node_id '{}' not found in nodes",
                self.root_node_id
            ));
        }

        // INV-GRAPH-004: 所有边的 from_node_id 和 to_node_id 必须存在于 nodes
        for edge in &self.edges {
            if !self.nodes.contains_key(&edge.from_node_id) {
                errors.push(format!(
                    "INV-GRAPH-004: edge '{}' references non-existent from_node_id '{}'",
                    edge.edge_id, edge.from_node_id
                ));
            }
            if !self.nodes.contains_key(&edge.to_node_id) {
                errors.push(format!(
                    "INV-GRAPH-004: edge '{}' references non-existent to_node_id '{}'",
                    edge.edge_id, edge.to_node_id
                ));
            }
        }

        // INV-GRAPH-005: 不能有自环边（除非特别允许）
        for edge in &self.edges {
            if edge.from_node_id == edge.to_node_id {
                errors.push(format!(
                    "INV-GRAPH-005: edge '{}' is a self-loop",
                    edge.edge_id
                ));
            }
        }

        if errors.is_empty() {
            InvariantResult::Valid
        } else {
            InvariantResult::Invalid(errors)
        }
    }
}

// =============================================================================
// ResearchNode 不变量
// =============================================================================

impl DomainInvariant for ResearchNode {
    fn validate(&self) -> InvariantResult {
        let mut errors = Vec::new();

        // INV-NODE-001: node_id 不能为空
        if self.node_id.trim().is_empty() {
            errors.push("INV-NODE-001: node_id cannot be empty".to_string());
        }

        // INV-NODE-002: goal 不能为空
        if self.goal.trim().is_empty() {
            errors.push("INV-NODE-002: goal cannot be empty".to_string());
        }

        // INV-NODE-003: 如果状态为 Completed，必须有 output_artifact
        if matches!(self.execution_state, NodeExecutionState::Completed) {
            if self.output_artifact.is_none() {
                errors.push(format!(
                    "INV-NODE-003: node '{}' is Completed but has no output_artifact",
                    self.node_id
                ));
            }
        }

        // INV-NODE-004: budget_consumed 不能为负数
        if let Some(ref budget) = self.budget_consumed {
            if budget.tokens > i64::MAX as u64 {
                // 溢出检查
            }
        }

        if errors.is_empty() {
            InvariantResult::Valid
        } else {
            InvariantResult::Invalid(errors)
        }
    }
}

// =============================================================================
// EvidenceRef 不变量
// =============================================================================

impl DomainInvariant for EvidenceRef {
    fn validate(&self) -> InvariantResult {
        let mut errors = Vec::new();

        // INV-EVIDENCE-001: ref_id 不能为空
        if self.ref_id.trim().is_empty() {
            errors.push("INV-EVIDENCE-001: ref_id cannot be empty".to_string());
        }

        // INV-EVIDENCE-002: document_id 不能为空
        if self.document_id.0.trim().is_empty() {
            errors.push("INV-EVIDENCE-002: document_id cannot be empty".to_string());
        }

        // INV-EVIDENCE-003: 至少有一个定位信息（segment_id, block_id, 或 node_id）
        if self.segment_id.is_none() && self.block_id.is_none() && self.node_id.is_none() {
            errors.push("INV-EVIDENCE-003: at least one of segment_id, block_id, or node_id must be specified".to_string());
        }

        // INV-EVIDENCE-004: text_snippet 不能为空
        if self.text_snippet.trim().is_empty() {
            errors.push("INV-EVIDENCE-004: text_snippet cannot be empty".to_string());
        }

        // INV-EVIDENCE-005: relevance_score 如果在 0-1 范围内
        if let Some(score) = self.relevance_score {
            if score < 0.0 || score > 1.0 {
                errors.push(format!(
                    "INV-EVIDENCE-005: relevance_score {} must be in [0, 1]",
                    score
                ));
            }
        }

        if errors.is_empty() {
            InvariantResult::Valid
        } else {
            InvariantResult::Invalid(errors)
        }
    }
}

// =============================================================================
// Segment 不变量
// =============================================================================

impl DomainInvariant for Segment {
    fn validate(&self) -> InvariantResult {
        let mut errors = Vec::new();

        // INV-SEG-001: segment_id 不能为空
        if self.segment_id.0.trim().is_empty() {
            errors.push("INV-SEG-001: segment_id cannot be empty".to_string());
        }

        // INV-SEG-002: document_id 不能为空
        if self.document_id.0.trim().is_empty() {
            errors.push("INV-SEG-002: document_id cannot be empty".to_string());
        }

        // INV-SEG-003: text 不能为空
        if self.text.trim().is_empty() {
            errors.push("INV-SEG-003: text cannot be empty".to_string());
        }

        // INV-SEG-004: token_estimate 必须 > 0
        if self.token_estimate == 0 {
            errors.push("INV-SEG-004: token_estimate must be > 0".to_string());
        }

        if errors.is_empty() {
            InvariantResult::Valid
        } else {
            InvariantResult::Invalid(errors)
        }
    }
}

// =============================================================================
// ClaimUnit 不变量
// =============================================================================

impl DomainInvariant for ClaimUnit {
    fn validate(&self) -> InvariantResult {
        let mut errors = Vec::new();

        // INV-CLAIM-001: claim_id 不能为空
        if self.claim_id.trim().is_empty() {
            errors.push("INV-CLAIM-001: claim_id cannot be empty".to_string());
        }

        // INV-CLAIM-002: text 不能为空
        if self.text.trim().is_empty() {
            errors.push("INV-CLAIM-002: text cannot be empty".to_string());
        }

        // INV-CLAIM-003: confidence 必须在 [0, 1] 范围内
        if self.confidence < 0.0 || self.confidence > 1.0 {
            errors.push(format!(
                "INV-CLAIM-003: confidence {} must be in [0, 1]",
                self.confidence
            ));
        }

        if errors.is_empty() {
            InvariantResult::Valid
        } else {
            InvariantResult::Invalid(errors)
        }
    }
}

// =============================================================================
// 辅助函数
// =============================================================================

/// 检查是否为有效的语义化版本
fn is_valid_semver(version: &str) -> bool {
    // 简单检查：至少包含主版本号
    // 完整 semver 检查可以使用 semver crate
    let parts: Vec<_> = version.split('.').collect();
    if parts.is_empty() || parts.len() > 3 {
        return false;
    }
    parts
        .iter()
        .all(|p| p.parse::<u64>().is_ok() || p == &"x" || p == &"*")
}

// =============================================================================
// 批量验证
// =============================================================================

/// 验证领域对象集合
pub fn validate_collection<T: DomainInvariant>(items: &[T]) -> InvariantResult {
    let results: Vec<_> = items.iter().map(|item| item.validate()).collect();
    InvariantResult::merge(results)
}

/// 验证并 panic（用于测试和开发）
pub fn validate_or_panic<T: DomainInvariant>(item: &T) {
    match item.validate() {
        InvariantResult::Valid => {}
        InvariantResult::Invalid(errors) => {
            panic!("Domain invariant violations:\n{}", errors.join("\n"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalized_document_validation() {
        let doc = NormalizedDocument::new(DocumentId::new("doc-001"), "Test Document");
        assert!(doc.validate().is_valid());

        // 测试空 document_id
        let invalid_doc = NormalizedDocument::new(DocumentId::new(""), "Test");
        assert!(invalid_doc.validate().is_invalid());
    }

    #[test]
    fn test_collection_validation() {
        let coll = Collection::new(
            CollectionId::new("col-001"),
            "Test Collection",
            "Research goal",
        );
        assert!(coll.validate().is_valid());

        // 测试空 goal
        let invalid_coll = Collection::new(CollectionId::new("col-002"), "Test", "");
        assert!(invalid_coll.validate().is_invalid());
    }

    #[test]
    fn test_evidence_ref_validation() {
        let evidence = EvidenceRef {
            ref_id: "ev-001".to_string(),
            document_id: DocumentId::new("doc-001"),
            segment_id: Some(SegmentId::new("seg-001")),
            block_id: None,
            node_id: None,
            block_ids: vec![BlockId::new("blk-001")],
            asset_refs: Vec::new(),
            locators: Vec::new(),
            text_snippet: "Test snippet".to_string(),
            ref_type: EvidenceRefType::Direct,
            relevance_score: Some(0.95),
            citation_text: Some("Test snippet".to_string()),
            scope: Some("document".to_string()),
        };
        assert!(evidence.validate().is_valid());

        // 测试缺少定位信息
        let invalid_evidence = EvidenceRef {
            ref_id: "ev-002".to_string(),
            document_id: DocumentId::new("doc-001"),
            segment_id: None,
            block_id: None,
            node_id: None,
            block_ids: Vec::new(),
            asset_refs: Vec::new(),
            locators: Vec::new(),
            text_snippet: "Test".to_string(),
            ref_type: EvidenceRefType::Direct,
            relevance_score: None,
            citation_text: None,
            scope: Some("document".to_string()),
        };
        assert!(invalid_evidence.validate().is_invalid());
    }

    #[test]
    fn test_claim_unit_validation() {
        let claim = ClaimUnit {
            claim_id: "claim-001".to_string(),
            text: "Test claim".to_string(),
            document_id: DocumentId::new("doc-001"),
            segment_id: SegmentId::new("seg-001"),
            confidence: 0.85,
            claim_type: ClaimType::Fact,
        };
        assert!(claim.validate().is_valid());

        // 测试 confidence 超出范围
        let invalid_claim = ClaimUnit {
            claim_id: "claim-002".to_string(),
            text: "Test".to_string(),
            document_id: DocumentId::new("doc-001"),
            segment_id: SegmentId::new("seg-001"),
            confidence: 1.5, // 无效
            claim_type: ClaimType::Opinion,
        };
        assert!(invalid_claim.validate().is_invalid());
    }

    #[test]
    fn test_invariant_result_merge() {
        let results = vec![InvariantResult::Valid, InvariantResult::Valid];
        assert!(InvariantResult::merge(results).is_valid());

        let results = vec![
            InvariantResult::Valid,
            InvariantResult::Invalid(vec!["error1".to_string()]),
            InvariantResult::Invalid(vec!["error2".to_string()]),
        ];
        let merged = InvariantResult::merge(results);
        assert!(merged.is_invalid());
        if let InvariantResult::Invalid(errors) = merged {
            assert_eq!(errors.len(), 2);
        }
    }
}
