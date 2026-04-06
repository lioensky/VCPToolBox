use crate::prelude::*;

// =============================================================================
// Document 工件路径
// =============================================================================

/// 文档工件路径
#[derive(Debug, Clone)]
pub struct DocumentArtifactPaths {
    pub source_manifest: PathBuf,
    pub mineru_raw: PathBuf,
    pub normalized_document: PathBuf,
    pub structure_tree: PathBuf,
    pub segment_set: PathBuf,
    pub asset_index: PathBuf,
    pub attention_plan: PathBuf,
    pub reading_state: PathBuf,
    pub segment_summaries: PathBuf,
    pub global_map: PathBuf,
    pub reading_synthesis: PathBuf,
    pub final_report: PathBuf,
    pub handoff: PathBuf,
    pub audit_report: PathBuf,
    pub retrieval_request: PathBuf,
    pub retrieval_hits: PathBuf,
    pub evidence_pack: PathBuf,
    pub claim_trace: PathBuf,
    pub support_matrix: PathBuf,
    pub contradiction_matrix: PathBuf,
}

impl DocumentArtifactPaths {
    pub fn new(base: &Path) -> Self {
        let reading_dir = base.join("reading");
        Self {
            source_manifest: base.join("source_manifest.json"),
            mineru_raw: base.join("mineru_raw.json"),
            normalized_document: base.join("normalized_document.json"),
            structure_tree: base.join("structure_tree.json"),
            segment_set: base.join("segment_set.json"),
            asset_index: base.join("asset_index.json"),
            attention_plan: reading_dir.join("attention_plan.json"),
            reading_state: reading_dir.join("reading_state.json"),
            segment_summaries: reading_dir.join("segment_summaries.json"),
            global_map: reading_dir.join("global_map.latest.md"),
            reading_synthesis: reading_dir.join("synthesis.latest.md"),
            final_report: reading_dir.join("final_report.latest.md"),
            handoff: reading_dir.join("handoff.json"),
            audit_report: reading_dir.join("audit_report.json"),
            retrieval_request: reading_dir.join("retrieval_request.json"),
            retrieval_hits: reading_dir.join("retrieval_hits.json"),
            evidence_pack: reading_dir.join("evidence_pack.json"),
            claim_trace: reading_dir.join("claim_trace.json"),
            support_matrix: reading_dir.join("support_matrix.json"),
            contradiction_matrix: reading_dir.join("contradiction_matrix.json"),
        }
    }
}

// =============================================================================
// Collection 工件路径
// =============================================================================

/// 集合工件路径
#[derive(Debug, Clone)]
pub struct CollectionArtifactPaths {
    pub collection_manifest: PathBuf,
    pub member_documents: PathBuf,
    pub collection_map: PathBuf,
    pub evidence_pack_latest: PathBuf,
    pub aligned_claims_latest: PathBuf,
    pub conflict_report_latest: PathBuf,
    pub comparison_table_latest: PathBuf,
    pub collection_synthesis_latest: PathBuf,
}

impl CollectionArtifactPaths {
    pub fn new(base: &Path) -> Self {
        Self {
            collection_manifest: base.join("collection_manifest.json"),
            member_documents: base.join("member_documents.json"),
            collection_map: base.join("collection_map.json"),
            evidence_pack_latest: base.join("evidence_pack.latest.json"),
            aligned_claims_latest: base.join("aligned_claims.latest.json"),
            conflict_report_latest: base.join("conflict_report.latest.json"),
            comparison_table_latest: base.join("comparison_table.latest.json"),
            collection_synthesis_latest: base.join("collection_synthesis.latest.md"),
        }
    }
}

// =============================================================================
// Run 工件路径
// =============================================================================

/// Run工件路径
#[derive(Debug, Clone)]
pub struct RunArtifactPaths {
    pub run_manifest: PathBuf,
    pub run_state: PathBuf,
    pub graph: PathBuf,
    pub graph_state: PathBuf,
    pub budget_state: PathBuf,
    pub checkpoints_dir: PathBuf,
    pub nodes_dir: PathBuf,
    pub merges_dir: PathBuf,
    pub outputs_dir: PathBuf,
    pub traces_dir: PathBuf,
    pub failures_dir: PathBuf,
}

impl RunArtifactPaths {
    pub fn new(base: &Path) -> Self {
        Self {
            run_manifest: base.join("run_manifest.json"),
            run_state: base.join("run_state.json"),
            graph: base.join("graph.json"),
            graph_state: base.join("graph_state.json"),
            budget_state: base.join("budget_state.json"),
            checkpoints_dir: base.join("checkpoints"),
            nodes_dir: base.join("nodes"),
            merges_dir: base.join("merges"),
            outputs_dir: base.join("outputs"),
            traces_dir: base.join("traces"),
            failures_dir: base.join("failures"),
        }
    }

    /// 创建所有目录
    pub fn create_directories(&self) -> anyhow::Result<()> {
        std::fs::create_dir_all(&self.checkpoints_dir)?;
        std::fs::create_dir_all(&self.nodes_dir)?;
        std::fs::create_dir_all(&self.merges_dir)?;
        std::fs::create_dir_all(&self.outputs_dir)?;
        std::fs::create_dir_all(&self.traces_dir)?;
        std::fs::create_dir_all(&self.failures_dir)?;
        Ok(())
    }
}

// =============================================================================
// Node 工件路径
// =============================================================================

/// 节点工件路径
#[derive(Debug, Clone)]
pub struct NodeArtifactPaths {
    pub node_json: PathBuf,
    pub input_manifest: PathBuf,
    pub output_manifest: PathBuf,
    pub handoff_in: PathBuf,
    pub handoff_out: PathBuf,
    pub trace_log: PathBuf,
    pub trace_jsonl: PathBuf,
    pub checkpoint: PathBuf,
    pub budget: PathBuf,
    pub result: PathBuf,
    pub failure: PathBuf,
}

impl NodeArtifactPaths {
    pub fn new(nodes_dir: &Path, node_id: &str) -> Self {
        let base = nodes_dir.join(node_id);
        Self {
            node_json: base.join("node.json"),
            input_manifest: base.join("input_manifest.json"),
            output_manifest: base.join("output_manifest.json"),
            handoff_in: base.join("handoff_in.json"),
            handoff_out: base.join("handoff_out.json"),
            trace_log: base.join("trace.log"),
            trace_jsonl: base.join("trace.jsonl"),
            checkpoint: base.join("checkpoint.json"),
            budget: base.join("budget.json"),
            result: base.join("result.json"),
            failure: base.join("failure.json"),
        }
    }
}
