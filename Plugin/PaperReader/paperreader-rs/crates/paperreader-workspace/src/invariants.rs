//! Workspace层业务不变量
//!
//! 本模块定义工件系统的核心业务约束，确保工作空间始终处于一致状态。

use crate::*;
use paperreader_domain::invariants::InvariantResult;

/// Workspace对象不变量 trait
pub trait WorkspaceInvariant {
    /// 验证对象是否满足所有业务不变量
    fn validate_workspace(&self) -> InvariantResult;
}

// =============================================================================
// ArtifactHeader 不变量
// =============================================================================

impl WorkspaceInvariant for ArtifactHeader {
    fn validate_workspace(&self) -> InvariantResult {
        let mut errors = Vec::new();

        // INV-ART-001: artifact_type 不能为空
        if self.artifact_type.trim().is_empty() {
            errors.push("INV-ART-001: artifact_type cannot be empty".to_string());
        }

        // INV-ART-002: schema_version 必须符合语义化版本
        if !is_valid_semver(&self.schema_version) {
            errors.push(format!(
                "INV-ART-002: schema_version '{}' is not valid semver",
                self.schema_version
            ));
        }

        // INV-ART-003: created_by 不能为空
        if self.created_by.trim().is_empty() {
            errors.push("INV-ART-003: created_by cannot be empty".to_string());
        }

        // INV-ART-004: created_at 必须是有效的 RFC3339 时间
        if chrono::DateTime::parse_from_rfc3339(&self.created_at).is_err() {
            errors.push(format!(
                "INV-ART-004: created_at '{}' is not valid RFC3339",
                self.created_at
            ));
        }

        // INV-ART-005: protocol_compat 必须有效
        if self.protocol_compat.min_protocol.trim().is_empty() {
            errors.push("INV-ART-005: min_protocol cannot be empty".to_string());
        }
        if self.protocol_compat.max_protocol.trim().is_empty() {
            errors.push("INV-ART-005: max_protocol cannot be empty".to_string());
        }

        if errors.is_empty() {
            InvariantResult::Valid
        } else {
            InvariantResult::Invalid(errors)
        }
    }
}

// =============================================================================
// RunManifest 不变量
// =============================================================================

impl WorkspaceInvariant for RunManifest {
    fn validate_workspace(&self) -> InvariantResult {
        let mut errors = Vec::new();

        // INV-RUN-001: run_id 不能为空
        if self.run_id.trim().is_empty() {
            errors.push("INV-RUN-001: run_id cannot be empty".to_string());
        }

        // INV-RUN-002: goal 不能为空
        if self.goal.trim().is_empty() {
            errors.push("INV-RUN-002: goal cannot be empty".to_string());
        }

        // INV-RUN-003: 至少有一个 root_entity_refs
        if self.root_entity_refs.collection_id.is_none()
            && self.root_entity_refs.document_ids.is_empty()
        {
            errors.push(
                "INV-RUN-003: at least one of collection_id or document_ids must be specified"
                    .to_string(),
            );
        }

        // INV-RUN-004: graph_ref 不能为空路径
        if self.graph_ref.as_os_str().is_empty() {
            errors.push("INV-RUN-004: graph_ref cannot be empty".to_string());
        }

        // INV-RUN-005: created_at 必须是有效的 RFC3339 时间
        if chrono::DateTime::parse_from_rfc3339(&self.created_at).is_err() {
            errors.push(format!(
                "INV-RUN-005: created_at '{}' is not valid RFC3339",
                self.created_at
            ));
        }

        // INV-RUN-006: updated_at 必须 >= created_at
        if let (Ok(created), Ok(updated)) = (
            chrono::DateTime::parse_from_rfc3339(&self.created_at),
            chrono::DateTime::parse_from_rfc3339(&self.updated_at),
        ) {
            if updated < created {
                errors.push("INV-RUN-006: updated_at must be >= created_at".to_string());
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
// RunState 不变量
// =============================================================================

impl WorkspaceInvariant for RunState {
    fn validate_workspace(&self) -> InvariantResult {
        let mut errors = Vec::new();

        // INV-RUNSTATE-001: run_id 不能为空
        if self.run_id.trim().is_empty() {
            errors.push("INV-RUNSTATE-001: run_id cannot be empty".to_string());
        }

        // INV-RUNSTATE-002: started_at 必须是有效的 RFC3339 时间
        if chrono::DateTime::parse_from_rfc3339(&self.started_at).is_err() {
            errors.push(format!(
                "INV-RUNSTATE-002: started_at '{}' is not valid RFC3339",
                self.started_at
            ));
        }

        // INV-RUNSTATE-003: 如果 completed，必须有 completed_at
        if matches!(self.status, RunStatus::Completed) {
            if self.completed_at.is_none() {
                errors.push("INV-RUNSTATE-003: Completed run must have completed_at".to_string());
            }
        }

        // INV-RUNSTATE-004: 如果 completed_at 存在，必须是有效的 RFC3339
        if let Some(ref completed_at) = self.completed_at {
            if chrono::DateTime::parse_from_rfc3339(completed_at).is_err() {
                errors.push(format!(
                    "INV-RUNSTATE-004: completed_at '{}' is not valid RFC3339",
                    completed_at
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
// BudgetState 不变量
// =============================================================================

impl WorkspaceInvariant for BudgetState {
    fn validate_workspace(&self) -> InvariantResult {
        let mut errors = Vec::new();

        // INV-BUDGET-001: run_id 不能为空
        if self.run_id.trim().is_empty() {
            errors.push("INV-BUDGET-001: run_id cannot be empty".to_string());
        }

        // INV-BUDGET-002: token_used 不能超过 token_total
        if self.token_budget_used > self.token_budget_total {
            errors.push(format!(
                "INV-BUDGET-002: token_used ({}) exceeds token_total ({})",
                self.token_budget_used, self.token_budget_total
            ));
        }

        // INV-BUDGET-003: llm_call_used 不能超过 llm_call_total
        if self.llm_call_budget_used > self.llm_call_budget_total {
            errors.push(format!(
                "INV-BUDGET-003: llm_call_used ({}) exceeds llm_call_total ({})",
                self.llm_call_budget_used, self.llm_call_budget_total
            ));
        }

        // INV-BUDGET-004: wall_clock_used 不能超过 wall_clock_total
        if self.wall_clock_budget_used_seconds > self.wall_clock_budget_total_seconds {
            errors.push(format!(
                "INV-BUDGET-004: wall_clock_used ({}) exceeds wall_clock_total ({})",
                self.wall_clock_budget_used_seconds, self.wall_clock_budget_total_seconds
            ));
        }

        // INV-BUDGET-005: context_pressure_score 必须在 [0, 1] 范围内
        if self.context_pressure_score < 0.0 || self.context_pressure_score > 1.0 {
            errors.push(format!(
                "INV-BUDGET-005: context_pressure_score {} must be in [0, 1]",
                self.context_pressure_score
            ));
        }

        // INV-BUDGET-006: artifact_volume_score 必须在 [0, 1] 范围内
        if self.artifact_volume_score < 0.0 || self.artifact_volume_score > 1.0 {
            errors.push(format!(
                "INV-BUDGET-006: artifact_volume_score {} must be in [0, 1]",
                self.artifact_volume_score
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
// HandoffArtifact 不变量
// =============================================================================

impl WorkspaceInvariant for HandoffArtifact {
    fn validate_workspace(&self) -> InvariantResult {
        let mut errors = Vec::new();

        // INV-HANDOFF-001: 至少有一个 confirmed_fact 或 open_question
        if self.confirmed_facts.is_empty() && self.open_questions.is_empty() {
            errors.push("INV-HANDOFF-001: at least one of confirmed_facts or open_questions must be present".to_string());
        }

        // INV-HANDOFF-002: confirmed_facts 中的 confidence 必须在 [0, 1] 范围内
        for fact in &self.confirmed_facts {
            if fact.confidence < 0.0 || fact.confidence > 1.0 {
                errors.push(format!(
                    "INV-HANDOFF-002: fact confidence {} must be in [0, 1]",
                    fact.confidence
                ));
            }
            // INV-HANDOFF-003: fact_id 不能为空
            if fact.fact_id.trim().is_empty() {
                errors.push("INV-HANDOFF-003: fact_id cannot be empty".to_string());
            }
            // INV-HANDOFF-004: text 不能为空
            if fact.text.trim().is_empty() {
                errors.push("INV-HANDOFF-004: fact text cannot be empty".to_string());
            }
        }

        // INV-HANDOFF-005: open_questions 中的 priority 必须在 1-10 范围内
        for question in &self.open_questions {
            if question.priority == 0 || question.priority > 10 {
                errors.push(format!(
                    "INV-HANDOFF-005: question priority {} must be in [1, 10]",
                    question.priority
                ));
            }
            // INV-HANDOFF-006: question_id 不能为空
            if question.question_id.trim().is_empty() {
                errors.push("INV-HANDOFF-006: question_id cannot be empty".to_string());
            }
            // INV-HANDOFF-007: text 不能为空
            if question.text.trim().is_empty() {
                errors.push("INV-HANDOFF-007: question text cannot be empty".to_string());
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
// FailureArtifact 不变量
// =============================================================================

impl WorkspaceInvariant for FailureArtifact {
    fn validate_workspace(&self) -> InvariantResult {
        let mut errors = Vec::new();

        // INV-FAIL-001: node_id 不能为空
        if self.node_id.trim().is_empty() {
            errors.push("INV-FAIL-001: node_id cannot be empty".to_string());
        }

        // INV-FAIL-002: message 不能为空
        if self.message.trim().is_empty() {
            errors.push("INV-FAIL-002: message cannot be empty".to_string());
        }

        // INV-FAIL-003: timestamp 必须是有效的 RFC3339 时间
        if chrono::DateTime::parse_from_rfc3339(&self.timestamp).is_err() {
            errors.push(format!(
                "INV-FAIL-003: timestamp '{}' is not valid RFC3339",
                self.timestamp
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
// MergeArtifact 不变量
// =============================================================================

impl WorkspaceInvariant for MergeArtifact {
    fn validate_workspace(&self) -> InvariantResult {
        let mut errors = Vec::new();

        // INV-MERGE-001: merge_id 不能为空
        if self.merge_id.trim().is_empty() {
            errors.push("INV-MERGE-001: merge_id cannot be empty".to_string());
        }

        // INV-MERGE-002: 至少有两个 input_node_ids
        if self.input_node_ids.len() < 2 {
            errors.push(format!(
                "INV-MERGE-002: at least 2 input_node_ids required, got {}",
                self.input_node_ids.len()
            ));
        }

        // INV-MERGE-003: input_node_ids 不能包含重复项
        let unique_count = self
            .input_node_ids
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len();
        if unique_count != self.input_node_ids.len() {
            errors.push("INV-MERGE-003: input_node_ids contains duplicates".to_string());
        }

        // INV-MERGE-004: 每个 merge_decision 必须有有效的 source_node_id
        for decision in &self.merge_decisions {
            if decision.source_node_id.trim().is_empty() {
                errors.push("INV-MERGE-004: decision source_node_id cannot be empty".to_string());
            }
            if decision.decision_id.trim().is_empty() {
                errors.push("INV-MERGE-004: decision_id cannot be empty".to_string());
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
// GraphState 不变量
// =============================================================================

impl WorkspaceInvariant for GraphState {
    fn validate_workspace(&self) -> InvariantResult {
        let mut errors = Vec::new();

        // INV-GRAPHSTATE-001: graph_id 不能为空
        if self.graph_id.trim().is_empty() {
            errors.push("INV-GRAPHSTATE-001: graph_id cannot be empty".to_string());
        }

        // INV-GRAPHSTATE-002: run_id 不能为空
        if self.run_id.trim().is_empty() {
            errors.push("INV-GRAPHSTATE-002: run_id cannot be empty".to_string());
        }

        // INV-GRAPHSTATE-003: active_nodes 和 completed_nodes 不能重叠
        let active_set: std::collections::HashSet<_> = self.active_nodes.iter().collect();
        let completed_set: std::collections::HashSet<_> = self.completed_nodes.iter().collect();
        let overlap: Vec<_> = active_set.intersection(&completed_set).collect();
        if !overlap.is_empty() {
            errors.push(format!(
                "INV-GRAPHSTATE-003: active_nodes and completed_nodes overlap: {:?}",
                overlap
            ));
        }

        // INV-GRAPHSTATE-004: failed_nodes 不应该在 completed_nodes 中
        let failed_set: std::collections::HashSet<_> = self.failed_nodes.iter().collect();
        let failed_completed_overlap: Vec<_> = failed_set.intersection(&completed_set).collect();
        if !failed_completed_overlap.is_empty() {
            errors.push(format!(
                "INV-GRAPHSTATE-004: failed_nodes and completed_nodes overlap: {:?}",
                failed_completed_overlap
            ));
        }

        // INV-GRAPHSTATE-005: node_states 中的每个节点必须在 node_states 中
        for node_id in &self.active_nodes {
            if !self.node_states.contains_key(node_id) {
                errors.push(format!(
                    "INV-GRAPHSTATE-005: active node '{}' not found in node_states",
                    node_id
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
// 辅助函数
// =============================================================================

/// 检查是否为有效的语义化版本
fn is_valid_semver(version: &str) -> bool {
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

/// 验证 workspace 对象集合
pub fn validate_workspace_collection<T: WorkspaceInvariant>(items: &[T]) -> InvariantResult {
    let results: Vec<_> = items.iter().map(|item| item.validate_workspace()).collect();
    InvariantResult::merge(results)
}

/// 验证并 panic（用于测试和开发）
pub fn validate_workspace_or_panic<T: WorkspaceInvariant>(item: &T) {
    match item.validate_workspace() {
        InvariantResult::Valid => {}
        InvariantResult::Invalid(errors) => {
            panic!("Workspace invariant violations:\n{}", errors.join("\n"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_artifact_header_validation() {
        let header = ArtifactHeader::new("run_manifest", "1.0");
        assert!(header.validate_workspace().is_valid());

        // 测试无效版本
        let invalid_header = ArtifactHeader {
            artifact_type: "test".to_string(),
            schema_version: "invalid".to_string(),
            created_by: "test".to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            protocol_compat: ProtocolCompat::default(),
        };
        assert!(invalid_header.validate_workspace().is_invalid());
    }

    #[test]
    fn test_budget_state_validation() {
        let budget = BudgetState {
            run_id: "run-001".to_string(),
            token_budget_total: 10000,
            token_budget_used: 5000,
            llm_call_budget_total: 100,
            llm_call_budget_used: 50,
            wall_clock_budget_total_seconds: 3600,
            wall_clock_budget_used_seconds: 1800,
            context_pressure_score: 0.5,
            artifact_volume_score: 0.3,
            updated_at: chrono::Utc::now().to_rfc3339(),
        };
        assert!(budget.validate_workspace().is_valid());

        // 测试超出预算
        let invalid_budget = BudgetState {
            run_id: "run-002".to_string(),
            token_budget_total: 10000,
            token_budget_used: 15000, // 超出
            llm_call_budget_total: 100,
            llm_call_budget_used: 50,
            wall_clock_budget_total_seconds: 3600,
            wall_clock_budget_used_seconds: 1800,
            context_pressure_score: 0.5,
            artifact_volume_score: 0.3,
            updated_at: chrono::Utc::now().to_rfc3339(),
        };
        assert!(invalid_budget.validate_workspace().is_invalid());
    }

    #[test]
    fn test_handoff_artifact_validation() {
        let handoff = HandoffArtifact {
            focus_questions: vec!["What is the main finding?".to_string()],
            confirmed_facts: vec![ConfirmedFact {
                fact_id: "fact-001".to_string(),
                text: "The sky is blue".to_string(),
                confidence: 0.95,
                evidence_refs: vec![],
            }],
            open_questions: vec![],
            must_keep_refs: vec![],
            next_action_hints: vec![],
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        assert!(handoff.validate_workspace().is_valid());

        // 测试空 handoff
        let invalid_handoff = HandoffArtifact {
            focus_questions: vec![],
            confirmed_facts: vec![],
            open_questions: vec![],
            must_keep_refs: vec![],
            next_action_hints: vec![],
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        assert!(invalid_handoff.validate_workspace().is_invalid());
    }

    #[test]
    fn test_merge_artifact_validation() {
        let merge = MergeArtifact {
            merge_id: "merge-001".to_string(),
            input_node_ids: vec!["node-001".to_string(), "node-002".to_string()],
            merge_decisions: vec![],
            unresolved_conflicts: vec![],
            merged_handoff: HandoffArtifact {
                focus_questions: vec![],
                confirmed_facts: vec![ConfirmedFact {
                    fact_id: "fact-001".to_string(),
                    text: "Test".to_string(),
                    confidence: 0.9,
                    evidence_refs: vec![],
                }],
                open_questions: vec![],
                must_keep_refs: vec![],
                next_action_hints: vec![],
                created_at: chrono::Utc::now().to_rfc3339(),
            },
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        assert!(merge.validate_workspace().is_valid());

        // 测试少于2个输入节点
        let invalid_merge = MergeArtifact {
            merge_id: "merge-002".to_string(),
            input_node_ids: vec!["node-001".to_string()], // 只有一个
            merge_decisions: vec![],
            unresolved_conflicts: vec![],
            merged_handoff: HandoffArtifact {
                focus_questions: vec![],
                confirmed_facts: vec![ConfirmedFact {
                    fact_id: "fact-001".to_string(),
                    text: "Test".to_string(),
                    confidence: 0.9,
                    evidence_refs: vec![],
                }],
                open_questions: vec![],
                must_keep_refs: vec![],
                next_action_hints: vec![],
                created_at: chrono::Utc::now().to_rfc3339(),
            },
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        assert!(invalid_merge.validate_workspace().is_invalid());
    }
}
