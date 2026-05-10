use anyhow::{Context, Result};
use paperreader_corpus as corpus;
use paperreader_domain::{
    AttentionAllocation, AttentionPlan, AuditFinding, AuditReport, AuditSeverity, BlockRange,
    BudgetConsumed, ClaimType, ClaimUnit, Collection, CollectionId, CommandEnvelope, DocumentId,
    EdgeType, EvidencePack, EvidenceRef, ExecutionMode, HealthMetrics, HealthSnapshot,
    HealthStatus, NodeExecutionState, NodeId, NodeType, NormalizedDocument, ParseQuality,
    ParseStatus, ReadLogEntry, ReadMode, ReadingPhase, ResearchEdge, ResearchGraph, ResearchNode,
    Segment, SegmentId, SegmentSet, SegmentType, SourceType, StructureNode, StructureTree,
};
use paperreader_ingestion::{
    ImportSourceType, IngestionError, MinerUGateway, MinerUGatewayConfig, MinerUHttpGateway,
    MinerURawResult, ModelVersion, Normalizer,
};
use paperreader_orchestrator::{BudgetStateSnapshot, CheckpointManager};
use paperreader_reading::{
    ClaimTracer, LlmClient, LlmError, ReadingDepth, SegmentReader, TraceContext,
};
use paperreader_retrieval::{RetrievalRequest, retrieve_evidence_with_hits};
use paperreader_workspace::{
    BootstrapWorkspace, BudgetState, CollectionManifest, DocumentManifest, FailureArtifact,
    FailureType, GraphState, HandoffArtifact, MergeArtifact, MergeDecision, MergeDecisionType,
    NodeArtifactPaths, NodeInputManifest, NodeOutputManifest, NodeStateEntry, NodeWorkspaceStatus,
    OpenQuestion, RootEntityRefs, RunArtifactPaths, RunManifest, RunScope, RunState, RunStatus,
    TraceEvent, TraceStore, WorkspaceRepository,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs::OpenOptions;
use std::future::Future;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

mod collection_usecases;
mod config;
mod deterministic_adapters;
mod ingestion_usecases;
mod openai_client;
mod payload_support;
mod reading_usecases;
mod recursive_reading;
mod research_planning;
mod retrieval_usecases;
mod run_orchestration_usecases;
mod runtime_commands;
mod workspace_query_usecases;

pub use config::RuntimeConfig;
pub(crate) use deterministic_adapters::{DeterministicLlmClient, StaticMinerUGateway};
pub(crate) use openai_client::OpenAiChatCompletionsClient;
pub(crate) use payload_support::{
    display_path, guess_display_name, payload_string, required_document_ids, required_string,
    snippet,
};
pub(crate) use reading_usecases::{
    best_matching_segment_id, format_constraints_markdown, requested_constraints,
};
pub(crate) use recursive_reading::build_recursive_global_map;
pub(crate) use research_planning::{build_graph_state, build_research_graph, default_budget_state};
pub(crate) use retrieval_usecases::{
    load_claim_units_for_document, resolve_retrieval_document_ids,
};
#[cfg(test)]
pub(crate) use run_orchestration_usecases::mutate_run_state_if_active;

pub fn validate_envelope(envelope: &CommandEnvelope) -> anyhow::Result<()> {
    if envelope.command.trim().is_empty() {
        anyhow::bail!("command must not be empty");
    }
    if envelope.request_id.trim().is_empty() {
        anyhow::bail!("request_id must not be empty");
    }
    Ok(())
}

pub struct PaperReaderApplication {
    config: RuntimeConfig,
    gateway: Arc<dyn MinerUGateway + Send + Sync>,
    llm_client: Arc<dyn LlmClient>,
}

impl Clone for PaperReaderApplication {
    fn clone(&self) -> Self {
        Self {
            config: self.config.clone(),
            gateway: self.gateway.clone(),
            llm_client: self.llm_client.clone(),
        }
    }
}

impl PaperReaderApplication {
    pub fn from_env() -> Result<Self> {
        Ok(Self::new(RuntimeConfig::from_env()))
    }

    pub fn new(config: RuntimeConfig) -> Self {
        let gateway = build_ingestion_gateway(&config);
        let llm_client = build_llm_client(&config);
        Self {
            config,
            gateway,
            llm_client,
        }
    }

    pub fn config(&self) -> &RuntimeConfig {
        &self.config
    }

    pub async fn dispatch(&self, command: &str, payload: &Value) -> Result<Value> {
        match command {
            "bootstrap_workspace" => self.bootstrap_workspace(payload),
            "describe_runtime" => self.describe_runtime(payload),
            "get_health_snapshot" => self.get_health_snapshot_value(payload),
            "ingest_source" => self.ingest_source(payload),
            "ingest_collection" => self.ingest_collection(payload),
            "refresh_ingestion" => self.refresh_ingestion(payload),
            "read_document" => self.read_document(payload).await,
            "resume_read" => self.resume_read(payload).await,
            "audit_document" => self.audit_document(payload),
            "trace_claim_in_document" => self.trace_claim_in_document(payload).await,
            "survey_collection" => self.survey_collection(payload),
            "synthesize_collection" => self.synthesize_collection(payload).await,
            "compare_documents" => self.compare_documents(payload),
            "audit_collection_conflicts" => self.audit_collection_conflicts(payload),
            "retrieve_evidence" => self.retrieve_evidence_value(payload),
            "build_evidence_pack" => self.build_evidence_pack(payload),
            "plan_research" => self.plan_research(payload),
            "run_research_graph" => self.run_research_graph(payload).await,
            "resume_research_graph" => self.resume_research_graph(payload).await,
            "stream_run_events" => self.stream_run_events(payload),
            "get_run_state" => self.get_run_state(payload),
            "cancel_run" => self.cancel_run(payload),
            "get_workspace_state" => self.get_workspace_state(payload),
            "list_artifacts" => self.list_artifacts(payload),
            "get_artifact" => self.get_artifact(payload),
            "reset_run" => self.reset_run(payload),
            other => anyhow::bail!("unsupported command: {other}"),
        }
    }
}

fn build_ingestion_gateway(config: &RuntimeConfig) -> Arc<dyn MinerUGateway + Send + Sync> {
    if config.force_deterministic {
        return Arc::new(StaticMinerUGateway);
    }
    let Some(token) = config.mineru_api_token.clone() else {
        return Arc::new(StaticMinerUGateway);
    };

    let model_version = parse_mineru_model_version(&config.mineru_model_version);
    let timeout_seconds = (config.mineru_api_timeout_ms / 1000).max(1);
    let poll_interval = Duration::from_millis(config.mineru_poll_interval_ms.max(250));

    let gateway = MinerUHttpGateway::new(
        MinerUGatewayConfig {
            base_url: MinerUGatewayConfig::default().base_url,
            token,
            timeout_seconds,
            max_retries: MinerUGatewayConfig::default().max_retries,
        },
        poll_interval,
        model_version,
    );

    match gateway {
        Ok(gateway) => Arc::new(gateway),
        Err(_) => Arc::new(StaticMinerUGateway),
    }
}

fn parse_mineru_model_version(value: &str) -> ModelVersion {
    match value.trim().to_lowercase().as_str() {
        "vlm" => ModelVersion::Vlm,
        "mineru-html" | "mineru_html" | "html" => ModelVersion::MinerUHtml,
        _ => ModelVersion::Pipeline,
    }
}

fn build_llm_client(config: &RuntimeConfig) -> Arc<dyn LlmClient> {
    if config.force_deterministic {
        return Arc::new(DeterministicLlmClient);
    }

    let api_url = config.api_url.clone();
    let api_key = config.api_key.clone();
    let model = config.paperreader_model.clone();

    if let (Some(api_url), Some(api_key), Some(model)) = (api_url, api_key, model) {
        let client = OpenAiChatCompletionsClient::new(
            api_url,
            api_key,
            model,
            config.paperreader_max_output_tokens,
            config.paperreader_max_concurrent_llm,
        );
        if let Ok(client) = client {
            return Arc::new(client);
        }
    }

    Arc::new(DeterministicLlmClient)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "paperreader-app-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[tokio::test]
    async fn test_bootstrap_ingest_read_plan_run_resume_flow() {
        let root = temp_root();
        let app = PaperReaderApplication::new(RuntimeConfig {
            workspace_root: root.clone(),
            ..RuntimeConfig::from_env()
        });
        app.bootstrap_workspace(&json!({ "workspace_root": root }))
            .unwrap();
        let ingest = app.ingest_source(&json!({
            "workspace_root": root,
            "source_type": "raw_text",
            "source_text": "Test title\n\nThis segment discusses alpha evidence.\n\nThis segment discusses beta evidence.",
            "document_name": "alpha-paper"
        })).unwrap();
        let document_id = ingest["document_id"].as_str().unwrap().to_string();
        let read_document = app
            .read_document(&json!({
                "workspace_root": root,
                "document_id": document_id,
                "goal": "Find alpha evidence"
            }))
            .await
            .unwrap();
        let reading_synthesis_ref = read_document["synthesis_ref"].as_str().unwrap().to_string();
        let resumed_read = app
            .resume_read(&json!({
                "workspace_root": root,
                "document_id": document_id,
                "goal": "Find alpha evidence"
            }))
            .await
            .unwrap();
        assert_eq!(resumed_read["round"], 2);
        let built_pack = app
            .build_evidence_pack(&json!({
                "workspace_root": root,
                "document_id": document_id,
                "query_text": "alpha evidence"
            }))
            .unwrap();
        assert!(built_pack.get("evidence_pack_ref").is_some());
        let audit = app
            .audit_document(&json!({
                "workspace_root": root,
                "document_id": document_id
            }))
            .unwrap();
        assert!(audit.get("audit_report_ref").is_some());
        let planned = app
            .plan_research(&json!({
                "workspace_root": root,
                "document_id": document_id,
                "goal": "Find alpha evidence"
            }))
            .unwrap();
        let run_id = planned["run_id"].as_str().unwrap().to_string();
        let empty_stream = app
            .stream_run_events(&json!({
                "workspace_root": root,
                "run_id": run_id
            }))
            .unwrap();
        assert_eq!(
            empty_stream["events"]
                .as_array()
                .map(|items| items.len())
                .unwrap_or(1),
            0
        );
        assert_eq!(empty_stream["next_cursor"], 0);
        assert_eq!(empty_stream["end_of_stream"], true);
        let run = app
            .run_research_graph(&json!({
                "workspace_root": root,
                "run_id": run_id
            }))
            .await
            .unwrap();
        assert_eq!(run["status"], "completed");
        let traced = app
            .trace_claim_in_document(&json!({
                "workspace_root": root,
                "document_id": document_id,
                "claim_text": "This segment discusses alpha evidence."
            }))
            .await
            .unwrap();
        assert!(traced.get("claim_trace_ref").is_some());
        let repo = BootstrapWorkspace::ensure(root.clone()).unwrap();
        let run_paths = repo.run_paths(&run_id);
        let run_manifest: RunManifest = repo.read_json(&run_paths.run_manifest).unwrap();
        let entry_checkpoint = run_manifest
            .entry_checkpoint
            .clone()
            .expect("completed run should persist entry_checkpoint");
        assert!(
            entry_checkpoint.exists(),
            "entry_checkpoint should point to an existing checkpoint file"
        );
        let graph_state: GraphState = repo.read_json(&run_paths.graph_state).unwrap();
        let checkpoint_count = std::fs::read_dir(&run_paths.checkpoints_dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("json"))
            .count();
        assert_eq!(checkpoint_count, graph_state.completed_nodes.len());

        let state = app
            .get_workspace_state(&json!({
                "workspace_root": root,
                "run_id": run_id
            }))
            .unwrap();
        assert!(state.get("run_state").is_some());
        assert!(state.get("graph_state").is_some());
        assert!(state.get("budget_state").is_some());

        let artifacts = app
            .list_artifacts(&json!({
                "workspace_root": root,
                "run_id": run_id
            }))
            .unwrap();
        assert!(
            artifacts["artifacts"]
                .as_array()
                .map(|items| !items.is_empty())
                .unwrap_or(false)
        );
        let artifact_paths = artifacts["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item.get("path").and_then(|value| value.as_str()))
            .map(|path| path.replace('\\', "/"))
            .collect::<Vec<_>>();
        assert!(
            artifact_paths
                .iter()
                .any(|path| path.ends_with("/nodes/retrieve/input_manifest.json"))
        );
        assert!(
            artifact_paths
                .iter()
                .any(|path| path.ends_with("/nodes/retrieve/output_manifest.json"))
        );
        assert!(
            artifact_paths
                .iter()
                .any(|path| path.contains("/traces/") && path.ends_with(".jsonl"))
        );
        assert!(
            artifact_paths
                .iter()
                .any(|path| path.ends_with("/reading/retrieval_request.json"))
        );
        assert!(
            artifact_paths
                .iter()
                .any(|path| path.ends_with("/reading/retrieval_hits.json"))
        );
        assert!(
            artifact_paths
                .iter()
                .any(|path| path.ends_with("/reading/evidence_pack.json"))
        );
        assert!(
            artifact_paths
                .iter()
                .any(|path| path.ends_with("/reading/audit_report.json"))
        );
        assert!(
            artifact_paths
                .iter()
                .any(|path| path.ends_with("/reading/claim_trace.json"))
        );
        assert!(
            artifact_paths
                .iter()
                .any(|path| path.ends_with("/reading/support_matrix.json"))
        );
        assert!(
            artifact_paths
                .iter()
                .any(|path| path.ends_with("/reading/contradiction_matrix.json"))
        );

        let document_paths = repo.document_paths(&DocumentId::new(document_id.clone()));
        assert!(document_paths.retrieval_request.exists());
        assert!(document_paths.retrieval_hits.exists());
        assert!(document_paths.evidence_pack.exists());
        assert!(document_paths.audit_report.exists());
        assert!(document_paths.claim_trace.exists());
        assert!(document_paths.support_matrix.exists());
        assert!(document_paths.contradiction_matrix.exists());
        for node_id in ["survey", "read", "retrieve", "merge", "synthesize"] {
            let node_paths = repo.node_paths(&run_id, node_id);
            assert!(
                node_paths.input_manifest.exists(),
                "missing input manifest for {node_id}"
            );
            assert!(
                node_paths.output_manifest.exists(),
                "missing output manifest for {node_id}"
            );
            assert!(
                node_paths.trace_jsonl.exists(),
                "missing trace jsonl for {node_id}"
            );
        }

        let first_page = app
            .stream_run_events(&json!({
                "workspace_root": root,
                "run_id": run_id,
                "cursor": 0,
                "limit": 2
            }))
            .unwrap();
        assert_eq!(
            first_page["events"]
                .as_array()
                .map(|items| items.len())
                .unwrap_or_default(),
            2
        );
        assert_eq!(first_page["events"][0]["event_type"], "run_started");
        assert_eq!(first_page["events"][1]["event_type"], "node_started");
        assert_eq!(first_page["end_of_stream"], false);
        let second_page = app
            .stream_run_events(&json!({
                "workspace_root": root,
                "run_id": run_id,
                "cursor": first_page["next_cursor"],
                "limit": 50
            }))
            .unwrap();
        assert!(
            second_page["events"]
                .as_array()
                .map(|items| !items.is_empty())
                .unwrap_or(false)
        );
        let repeated_tail = app
            .stream_run_events(&json!({
                "workspace_root": root,
                "run_id": run_id,
                "cursor": second_page["next_cursor"],
                "limit": 50
            }))
            .unwrap();
        assert_eq!(
            repeated_tail["events"]
                .as_array()
                .map(|items| items.len())
                .unwrap_or(1),
            0
        );
        assert_eq!(repeated_tail["end_of_stream"], true);

        let missing_stream = app.stream_run_events(&json!({
            "workspace_root": root,
            "run_id": "missing-run"
        }));
        assert!(missing_stream.is_err());
        assert!(
            format!("{:#}", missing_stream.unwrap_err()).contains("run not found"),
            "missing run should produce a clear not-found error"
        );

        let original_budget: BudgetState = repo.read_json(&run_paths.budget_state).unwrap();
        let zero_budget = BudgetState {
            token_budget_used: 0,
            llm_call_budget_used: 0,
            wall_clock_budget_used_seconds: 0,
            ..original_budget.clone()
        };
        repo.write_json(&run_paths.budget_state, &zero_budget)
            .unwrap();
        let resumed = app
            .resume_research_graph(&json!({
                "workspace_root": root,
                "run_id": run["run_id"].as_str().unwrap()
            }))
            .await
            .unwrap();
        assert_eq!(resumed["status"], "completed");
        let restored_budget: BudgetState = repo.read_json(&run_paths.budget_state).unwrap();
        assert_eq!(
            restored_budget.token_budget_used,
            original_budget.token_budget_used
        );
        assert_eq!(
            restored_budget.llm_call_budget_used,
            original_budget.llm_call_budget_used
        );
        assert_eq!(
            restored_budget.wall_clock_budget_used_seconds,
            original_budget.wall_clock_budget_used_seconds
        );

        let run_state_ref = state["run_state_ref"].as_str().unwrap();
        let artifact = app
            .get_artifact(&json!({
                "workspace_root": root,
                "artifact_path": run_state_ref
            }))
            .unwrap();
        assert_eq!(artifact["kind"], "json");
        assert!(artifact["data"].is_object());
        let reading_synthesis_artifact = app
            .get_artifact(&json!({
                "workspace_root": root,
                "artifact_path": reading_synthesis_ref
            }))
            .unwrap();
        assert_eq!(reading_synthesis_artifact["kind"], "text");
        assert_eq!(reading_synthesis_artifact["has_header"], true);
        assert_eq!(
            reading_synthesis_artifact["schema_probe"],
            "can_read_directly"
        );
        assert_eq!(
            reading_synthesis_artifact["header"]["artifact_type"],
            "synthesis_latest"
        );

        let reset = app
            .reset_run(&json!({
                "workspace_root": root,
                "run_id": run_id
            }))
            .unwrap();
        assert_eq!(reset["status"], "reset");
        let after_reset = app
            .get_workspace_state(&json!({
                "workspace_root": root,
                "run_id": run_id
            }))
            .unwrap();
        assert_eq!(after_reset["run_state"]["status"], "pending");
        let checkpoint_count_after = std::fs::read_dir(&run_paths.checkpoints_dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("json"))
            .count();
        assert_eq!(checkpoint_count_after, 0);
        let reset_manifest: RunManifest = repo.read_json(&run_paths.run_manifest).unwrap();
        assert_eq!(reset_manifest.entry_checkpoint, None);

        let reset_graph: ResearchGraph = repo.read_json(&run_paths.graph).unwrap();
        for (node_id, node) in reset_graph.nodes.iter() {
            assert!(
                matches!(node.execution_state, NodeExecutionState::Pending),
                "reset should set node {node_id} to pending"
            );
            assert!(
                node.input_artifacts.is_empty(),
                "reset should clear node {node_id} input_artifacts"
            );
            assert!(
                node.output_artifact.is_none(),
                "reset should clear node {node_id} output_artifact"
            );
            assert!(
                node.output_refs.is_empty(),
                "reset should clear node {node_id} output_refs"
            );
            assert!(
                node.checkpoint_ref.is_none(),
                "reset should clear node {node_id} checkpoint_ref"
            );
            assert_eq!(node.attempt, 0, "reset should clear node {node_id} attempt");
            assert!(
                node.budget_consumed.is_none(),
                "reset should clear node {node_id} budget_consumed"
            );
        }

        let reset_graph_state: GraphState = repo.read_json(&run_paths.graph_state).unwrap();
        for entry in reset_graph_state.node_states.values() {
            assert!(
                matches!(entry.status, NodeWorkspaceStatus::Pending),
                "reset should set graph_state node {} to pending",
                entry.node_id
            );
            assert_eq!(
                entry.attempt, 0,
                "reset should clear graph_state node {} attempt",
                entry.node_id
            );
            assert!(
                entry.checkpoint_ref.is_none(),
                "reset should clear graph_state node {} checkpoint_ref",
                entry.node_id
            );
            assert!(
                entry.output_refs.is_empty(),
                "reset should clear graph_state node {} output_refs",
                entry.node_id
            );
        }

        let rerun_after_reset = app
            .resume_research_graph(&json!({
                "workspace_root": root,
                "run_id": run_id
            }))
            .await
            .unwrap();
        assert_eq!(rerun_after_reset["status"], "completed");
    }

    #[tokio::test]
    async fn test_collection_survey_compare_conflict_audit_flow() {
        let root = temp_root();
        let app = PaperReaderApplication::new(RuntimeConfig {
            workspace_root: root.clone(),
            ..RuntimeConfig::from_env()
        });
        app.bootstrap_workspace(&json!({ "workspace_root": root }))
            .unwrap();

        let collection_id = "coll-test";
        let ingested = app
            .ingest_collection(&json!({
                "workspace_root": root,
                "collection_id": collection_id,
                "name": "Test Collection",
                "goal": "Compare alpha and beta",
                "sources": [
                    {
                        "source_type": "raw_text",
                        "source_text": "Alpha title\n\nThis segment discusses alpha evidence.\n\nThis segment discusses a fast system.",
                        "document_name": "alpha-paper"
                    },
                    {
                        "source_type": "raw_text",
                        "source_text": "Beta title\n\nThis segment discusses beta evidence.\n\nThis segment discusses a not fast system.",
                        "document_name": "beta-paper"
                    }
                ]
            }))
            .unwrap();
        assert!(ingested.get("collection_manifest_ref").is_some());
        assert!(ingested.get("member_documents_ref").is_some());
        assert!(ingested.get("collection_map_ref").is_some());
        let doc_ids = ingested["document_ids"].as_array().unwrap();
        assert_eq!(doc_ids.len(), 2);
        let doc_alpha = doc_ids[0].as_str().unwrap().to_string();
        let doc_beta = doc_ids[1].as_str().unwrap().to_string();

        let refreshed = app
            .refresh_ingestion(&json!({
                "workspace_root": root,
                "document_id": doc_alpha
            }))
            .unwrap();
        assert_eq!(refreshed["refreshed"], true);

        app.read_document(&json!({
            "workspace_root": root,
            "document_id": doc_alpha,
            "goal": "Find alpha evidence"
        }))
        .await
        .unwrap();
        app.read_document(&json!({
            "workspace_root": root,
            "document_id": doc_beta,
            "goal": "Find beta evidence"
        }))
        .await
        .unwrap();

        let compare = app
            .compare_documents(&json!({
                "workspace_root": root,
                "collection_id": collection_id,
                "document_ids": [doc_alpha, doc_beta]
            }))
            .unwrap();
        assert!(compare.get("comparison_table_ref").is_some());
        assert_eq!(compare["comparison_table"]["document_count"], 2);
        assert_eq!(compare["comparison_table"]["pair_count"], 1);

        let audit = app
            .audit_collection_conflicts(&json!({
                "workspace_root": root,
                "collection_id": collection_id,
                "document_ids": [doc_alpha, doc_beta]
            }))
            .unwrap();
        assert!(audit.get("conflict_report_ref").is_some());
        assert!(audit.get("aligned_claims_ref").is_some());

        let synthesized = app
            .synthesize_collection(&json!({
                "workspace_root": root,
                "collection_id": collection_id
            }))
            .await
            .unwrap();
        assert!(synthesized.get("collection_synthesis_ref").is_some());
        assert!(synthesized.get("comparison_table_ref").is_some());
        let collection_synthesis_ref = synthesized["collection_synthesis_ref"]
            .as_str()
            .unwrap()
            .to_string();

        let repo = BootstrapWorkspace::ensure(root.clone()).unwrap();
        let collection_paths = repo.collection_paths(&CollectionId::new(collection_id));
        assert!(collection_paths.collection_manifest.exists());
        assert!(collection_paths.member_documents.exists());
        assert!(collection_paths.collection_map.exists());
        assert!(collection_paths.comparison_table_latest.exists());
        assert!(collection_paths.aligned_claims_latest.exists());
        assert!(collection_paths.conflict_report_latest.exists());
        assert!(collection_paths.collection_synthesis_latest.exists());

        let artifacts = app
            .list_artifacts(&json!({
                "workspace_root": root,
                "collection_id": collection_id
            }))
            .unwrap();
        assert!(
            artifacts["artifacts"]
                .as_array()
                .map(|items| !items.is_empty())
                .unwrap_or(false)
        );
        let paths = artifacts["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item.get("path").and_then(|value| value.as_str()))
            .map(|path| path.replace('\\', "/"))
            .collect::<Vec<_>>();
        let synthesis_artifact = artifacts["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| {
                item.get("path")
                    .and_then(|value| value.as_str())
                    .map(|path| {
                        path.replace('\\', "/")
                            .ends_with("collections/coll-test/collection_synthesis.latest.md")
                    })
                    .unwrap_or(false)
            })
            .expect("expected collection synthesis artifact entry");
        assert_eq!(synthesis_artifact["has_header"], true);
        assert_eq!(synthesis_artifact["probe_result"], "can_read_directly");
        assert!(
            paths.iter().any(|path| {
                path.ends_with("collections/coll-test/comparison_table.latest.json")
            }),
            "expected comparison_table.latest.json to be discoverable via list_artifacts(collection_id)"
        );
        assert!(
            paths.iter().any(|path| {
                path.ends_with("collections/coll-test/conflict_report.latest.json")
            }),
            "expected conflict_report.latest.json to be discoverable via list_artifacts(collection_id)"
        );
        assert!(
            paths.iter().any(|path| {
                path.ends_with("collections/coll-test/collection_synthesis.latest.md")
            }),
            "expected collection_synthesis.latest.md to be discoverable via list_artifacts(collection_id)"
        );
        let synthesis_artifact_payload = app
            .get_artifact(&json!({
                "workspace_root": root,
                "artifact_path": collection_synthesis_ref
            }))
            .unwrap();
        assert_eq!(synthesis_artifact_payload["kind"], "text");
        assert_eq!(synthesis_artifact_payload["has_header"], true);
        assert_eq!(
            synthesis_artifact_payload["schema_probe"],
            "can_read_directly"
        );
        assert_eq!(
            synthesis_artifact_payload["header"]["artifact_type"],
            "collection_synthesis_latest"
        );
    }

    #[tokio::test]
    async fn test_synthesize_collection_compare_keeps_all_documents() {
        let root = temp_root();
        let app = PaperReaderApplication::new(RuntimeConfig {
            workspace_root: root.clone(),
            ..RuntimeConfig::from_env()
        });
        app.bootstrap_workspace(&json!({ "workspace_root": root }))
            .unwrap();

        let ingested = app
            .ingest_collection(&json!({
                "workspace_root": root,
                "collection_id": "coll-compare-3",
                "goal": "Compare all three documents",
                "sources": [
                    {
                        "source_type": "raw_text",
                        "source_text": "Doc A\n\nAlpha evidence and shared methods.",
                        "document_name": "doc-a"
                    },
                    {
                        "source_type": "raw_text",
                        "source_text": "Doc B\n\nBeta evidence and conflicting methods.",
                        "document_name": "doc-b"
                    },
                    {
                        "source_type": "raw_text",
                        "source_text": "Doc C\n\nGamma evidence and complementary results.",
                        "document_name": "doc-c"
                    }
                ]
            }))
            .unwrap();
        let document_ids = ingested["document_ids"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|value| value.as_str().map(ToString::to_string))
            .collect::<Vec<_>>();
        assert_eq!(document_ids.len(), 3);

        let compare = app
            .synthesize_collection(&json!({
                "workspace_root": root,
                "collection_id": "coll-compare-3",
                "document_ids": document_ids,
                "mode": "compare"
            }))
            .await
            .unwrap();
        assert_eq!(compare["document_ids"].as_array().unwrap().len(), 3);
        assert_eq!(compare["comparison_table"]["document_count"], 3);
        assert_eq!(compare["comparison_table"]["pair_count"], 3);
        assert_eq!(
            compare["comparison_table"]["pairwise_comparisons"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
    }

    #[tokio::test]
    async fn test_collection_scope_plan_and_legacy_artifact_ref_round_trip() {
        let root = temp_root();
        let app = PaperReaderApplication::new(RuntimeConfig {
            workspace_root: root.clone(),
            ..RuntimeConfig::from_env()
        });
        app.bootstrap_workspace(&json!({ "workspace_root": root }))
            .unwrap();

        let ingested = app
            .ingest_collection(&json!({
                "workspace_root": root,
                "collection_id": "coll-scope",
                "sources": [
                    {
                        "source_type": "raw_text",
                        "source_text": "Doc A\n\nAlpha evidence.",
                        "document_name": "doc-a"
                    },
                    {
                        "source_type": "raw_text",
                        "source_text": "Doc B\n\nBeta evidence.",
                        "document_name": "doc-b"
                    },
                    {
                        "source_type": "raw_text",
                        "source_text": "Doc C\n\nGamma evidence.",
                        "document_name": "doc-c"
                    }
                ]
            }))
            .unwrap();
        let document_ids = ingested["document_ids"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|value| value.as_str().map(ToString::to_string))
            .collect::<Vec<_>>();

        let planned = app
            .plan_research(&json!({
                "workspace_root": root,
                "collection_id": "coll-scope",
                "document_ids": document_ids,
                "goal": "Compare both documents"
            }))
            .unwrap();
        assert_eq!(planned["scope"], "collection");
        assert_eq!(planned["root_entity_refs"]["collection_id"], "coll-scope");
        let planned_nodes = planned["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|value| value.as_str())
            .collect::<Vec<_>>();
        assert!(planned_nodes.contains(&"read"));
        assert!(planned_nodes.contains(&"retrieve"));
        assert!(planned_nodes.contains(&"compare"));
        assert!(planned_nodes.contains(&"conflict_audit"));
        assert!(
            planned_nodes
                .iter()
                .any(|node_id| node_id.starts_with("read_"))
        );
        assert!(
            planned_nodes
                .iter()
                .any(|node_id| node_id.starts_with("retrieve_"))
        );

        let run_id = planned["run_id"].as_str().unwrap().to_string();
        let completed = app
            .run_research_graph(&json!({
                "workspace_root": root,
                "run_id": run_id
            }))
            .await
            .unwrap();
        assert_eq!(completed["status"], "completed");

        let state = app
            .get_workspace_state(&json!({
                "workspace_root": root,
                "run_id": run_id
            }))
            .unwrap();
        let run_state_ref = state["run_state_ref"].as_str().unwrap();
        let legacy_ref = format!("workspace-rs/{run_state_ref}");
        let artifact = app
            .get_artifact(&json!({
                "workspace_root": root,
                "artifact_path": legacy_ref
            }))
            .unwrap();
        assert_eq!(artifact["artifact_path"], run_state_ref);

        let repo = BootstrapWorkspace::ensure(root.clone()).unwrap();
        let run_paths = repo.run_paths(&run_id);
        let graph: ResearchGraph = repo.read_json(&run_paths.graph).unwrap();
        assert!(graph.nodes.contains_key("read"));
        assert!(graph.nodes.contains_key("retrieve"));
        assert!(graph.nodes.contains_key("compare"));
        assert!(graph.nodes.contains_key("conflict_audit"));
        for node_id in ["read", "retrieve", "compare", "conflict_audit"] {
            let node_paths = repo.node_paths(&run_id, node_id);
            assert!(node_paths.input_manifest.exists());
            assert!(node_paths.output_manifest.exists());
            assert!(node_paths.result.exists());
        }
        for index in 0..3 {
            let read_node = format!("read_{index}");
            let retrieve_node = format!("retrieve_{index}");
            assert!(
                graph.nodes.contains_key(&read_node),
                "missing collection fan-out node {read_node}"
            );
            assert!(
                graph.nodes.contains_key(&retrieve_node),
                "missing collection fan-out node {retrieve_node}"
            );
            let read_paths = repo.node_paths(&run_id, &read_node);
            let retrieve_paths = repo.node_paths(&run_id, &retrieve_node);
            assert!(read_paths.result.exists());
            assert!(retrieve_paths.result.exists());
        }
        let collection_paths = repo.collection_paths(&CollectionId::new("coll-scope"));
        let comparison_table: Value = repo
            .read_json(&collection_paths.comparison_table_latest)
            .unwrap();
        assert_eq!(comparison_table["document_count"], 3);
        assert_eq!(comparison_table["pair_count"], 3);
    }

    #[tokio::test]
    async fn test_async_run_accepts_and_cancel_updates_state() {
        let root = temp_root();
        let app = PaperReaderApplication::new(RuntimeConfig {
            workspace_root: root.clone(),
            ..RuntimeConfig::from_env()
        });
        app.bootstrap_workspace(&json!({ "workspace_root": root }))
            .unwrap();

        let ingest = app
            .ingest_source(&json!({
                "workspace_root": root,
                "source_type": "raw_text",
                "source_text": "Async title\n\nThis segment discusses async evidence.",
                "document_name": "async-paper"
            }))
            .unwrap();
        let document_id = ingest["document_id"].as_str().unwrap().to_string();
        let planned = app
            .plan_research(&json!({
                "workspace_root": root,
                "document_id": document_id,
                "goal": "Validate accepted lifecycle"
            }))
            .unwrap();
        let run_id = planned["run_id"].as_str().unwrap().to_string();

        let accepted = app
            .run_research_graph(&json!({
                "workspace_root": root,
                "run_id": run_id,
                "execution": {
                    "mode": "async"
                }
            }))
            .await
            .unwrap();
        assert_eq!(accepted["status"], "accepted");
        assert_eq!(accepted["degrade_mode"], "manual_resume_required");
        assert_eq!(accepted["poll_command"], "get_run_state");
        assert_eq!(accepted["resume_command"], "resume_research_graph");
        assert_eq!(accepted["stream_command"], "stream_run_events");
        assert!(accepted.get("run_state_ref").is_some());

        let state = app
            .get_run_state(&json!({
                "workspace_root": root,
                "run_id": run_id
            }))
            .unwrap();
        assert_eq!(state["run_state"]["status"], "pending");
        assert_eq!(state["run_state"]["current_phase"], "accepted");

        let cancelled = app
            .cancel_run(&json!({
                "workspace_root": root,
                "run_id": run_id,
                "reason": "operator cancel"
            }))
            .unwrap();
        assert_eq!(cancelled["status"], "aborted");
        assert!(cancelled.get("trace_ref").is_some());

        let after_cancel = app
            .get_run_state(&json!({
                "workspace_root": root,
                "run_id": run_id
            }))
            .unwrap();
        assert_eq!(after_cancel["run_state"]["status"], "aborted");
        assert_eq!(after_cancel["run_state"]["current_phase"], "aborted");

        let terminal_cancel = app
            .cancel_run(&json!({
                "workspace_root": root,
                "run_id": run_id
            }))
            .unwrap();
        assert_eq!(terminal_cancel["status"], "partial");
        assert_eq!(terminal_cancel["degrade_mode"], "terminal_run_state");
    }

    #[test]
    fn test_cancelled_run_state_cannot_be_overwritten_by_completion_persistence() {
        let root = temp_root();
        let app = PaperReaderApplication::new(RuntimeConfig {
            workspace_root: root.clone(),
            ..RuntimeConfig::from_env()
        });
        app.bootstrap_workspace(&json!({ "workspace_root": root }))
            .unwrap();

        let ingest = app
            .ingest_source(&json!({
                "workspace_root": root,
                "source_type": "raw_text",
                "source_text": "Terminal cancel\n\nThe persisted run state must stay aborted.",
                "document_name": "terminal-cancel"
            }))
            .unwrap();
        let document_id = ingest["document_id"].as_str().unwrap().to_string();
        let planned = app
            .plan_research(&json!({
                "workspace_root": root,
                "document_id": document_id,
                "goal": "Validate terminal cancel persistence"
            }))
            .unwrap();
        let run_id = planned["run_id"].as_str().unwrap().to_string();
        let repo = BootstrapWorkspace::ensure(root.clone()).unwrap();
        let run_paths = repo.run_paths(&run_id);

        app.cancel_run(&json!({
            "workspace_root": root,
            "run_id": run_id,
            "reason": "test cancellation"
        }))
        .unwrap();

        let attempted_completion = mutate_run_state_if_active(&repo, &run_paths, |run_state| {
            run_state.status = RunStatus::Completed;
            run_state.current_phase = Some("completed".to_string());
            run_state.completed_at = Some(chrono::Utc::now().to_rfc3339());
            run_state.last_updated_at = chrono::Utc::now().to_rfc3339();
            Ok(())
        })
        .unwrap();
        assert!(attempted_completion.is_none());

        let persisted_run_state: RunState = repo.read_json(&run_paths.run_state).unwrap();
        assert_eq!(persisted_run_state.status, RunStatus::Aborted);
        assert_eq!(
            persisted_run_state.current_phase.as_deref(),
            Some("aborted")
        );
        assert!(persisted_run_state.completed_at.is_none());
    }

    #[tokio::test]
    async fn test_recursive_read_document_writes_global_map_and_recursive_maps() {
        let root = temp_root();
        let app = PaperReaderApplication::new(RuntimeConfig {
            workspace_root: root.clone(),
            force_deterministic: true,
            ..RuntimeConfig::from_env()
        });
        app.bootstrap_workspace(&json!({ "workspace_root": root }))
            .unwrap();

        let document_id = "recursive-smoke-doc";
        let paragraph = "This paragraph exists to exercise recursive single-document reading. It should be long enough and split into many blocks so the SegmentSet yields multiple segments.";
        let text = (1..=60)
            .map(|idx| format!("Section {idx}. {paragraph} {paragraph}"))
            .collect::<Vec<_>>()
            .join("\n\n");

        let ingest = app
            .ingest_source(&json!({
                "workspace_root": root,
                "source_type": "raw_text",
                "source_text": text,
                "document_name": "recursive-smoke-source",
                "document_id": document_id,
            }))
            .unwrap();
        assert_eq!(ingest["document_id"].as_str(), Some(document_id));

        let read = app
            .read_document(&json!({
                "workspace_root": root,
                "document_id": document_id,
                "goal": "Build a global map for recursive smoke",
                "mode": "recursive",
            }))
            .await
            .unwrap();

        assert!(read.get("global_map_ref").is_some());
        assert!(read.get("final_report_ref").is_some());
        assert!(
            read.get("recursive_artifact_refs")
                .and_then(|value| value.as_array())
                .map(|items| !items.is_empty())
                .unwrap_or(false),
            "expected recursive_artifact_refs to be non-empty"
        );

        let repo = BootstrapWorkspace::ensure(root.clone()).unwrap();
        let paths = repo.document_paths(&DocumentId::new(document_id));
        assert!(paths.global_map.exists());
        assert!(paths.final_report.exists());
        assert!(paths.reading_synthesis.exists());

        let global_map = std::fs::read_to_string(&paths.global_map).unwrap_or_default();
        assert!(global_map.contains("Global Map"));

        let report = std::fs::read_to_string(&paths.final_report).unwrap_or_default();
        assert!(report.contains("# Final Report"));

        let recursive_root = paths.reading_state.parent().unwrap().join("recursive_maps");
        assert!(recursive_root.exists());
    }

    #[tokio::test]
    async fn test_recursive_read_document_with_critic_writes_critic_artifacts() {
        let root = temp_root();
        let app = PaperReaderApplication::new(RuntimeConfig {
            workspace_root: root.clone(),
            force_deterministic: true,
            paperreader_recursive_enable_critic: true,
            ..RuntimeConfig::from_env()
        });
        app.bootstrap_workspace(&json!({ "workspace_root": root }))
            .unwrap();

        let document_id = "recursive-critic-smoke-doc";
        let paragraph = "This paragraph exists to exercise recursive single-document reading. It should be long enough and split into many blocks so the SegmentSet yields multiple segments.";
        let text = (1..=60)
            .map(|idx| format!("Section {idx}. {paragraph} {paragraph}"))
            .collect::<Vec<_>>()
            .join("\n\n");

        let ingest = app
            .ingest_source(&json!( {
                "workspace_root": root,
                "source_type": "raw_text",
                "source_text": text,
                "document_name": "recursive-critic-smoke-source",
                "document_id": document_id,
            }))
            .unwrap();
        assert_eq!(ingest["document_id"].as_str(), Some(document_id));

        let read = app
            .read_document(&json!( {
                "workspace_root": root,
                "document_id": document_id,
                "goal": "Build a global map for recursive critic smoke",
                "mode": "recursive",
            }))
            .await
            .unwrap();

        let refs = read
            .get("recursive_artifact_refs")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|value| value.as_str().map(String::from))
            .collect::<Vec<_>>();

        assert!(
            refs.iter()
                .any(|item| item.ends_with("global_map.critic.md")),
            "expected recursive_artifact_refs to contain global_map.critic.md, got: {refs:?}"
        );
        assert!(
            refs.iter()
                .any(|item| item.contains("group_") && item.ends_with(".critic.md")),
            "expected recursive_artifact_refs to contain group_*.critic.md, got: {refs:?}"
        );

        let repo = BootstrapWorkspace::ensure(root.clone()).unwrap();
        let paths = repo.document_paths(&DocumentId::new(document_id));
        let recursive_root = paths.reading_state.parent().unwrap().join("recursive_maps");

        assert!(recursive_root.join("global_map.critic.md").exists());
        let level1_dir = recursive_root.join("level_1");
        assert!(level1_dir.exists());
        let has_group_critic = std::fs::read_dir(&level1_dir)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().ends_with(".critic.md"));
        assert!(has_group_critic);

        let critique_path = recursive_root.join("global_map.critic.md");
        let critique = std::fs::read_to_string(&critique_path).unwrap_or_default();
        let critique_trimmed = critique.trim();
        assert!(!critique_trimmed.is_empty());

        let global_map = std::fs::read_to_string(&paths.global_map).unwrap_or_default();
        let critique_snippet = critique_trimmed.chars().take(32).collect::<String>();
        assert!(
            global_map.contains(&critique_snippet),
            "expected global_map.latest.md to include the critic output snippet"
        );
    }

    #[tokio::test]
    async fn test_plan_and_run_recursive_document_subgraph() {
        let root = temp_root();
        let app = PaperReaderApplication::new(RuntimeConfig {
            workspace_root: root.clone(),
            force_deterministic: true,
            ..RuntimeConfig::from_env()
        });
        app.bootstrap_workspace(&json!({ "workspace_root": root }))
            .unwrap();

        let paragraph = "This paragraph exercises recursive run graph planning and execution.";
        let text = (1..=48)
            .map(|idx| format!("Section {idx}. {paragraph} {paragraph}"))
            .collect::<Vec<_>>()
            .join("\n\n");
        let ingest = app
            .ingest_source(&json!({
                "workspace_root": root,
                "source_type": "raw_text",
                "source_text": text,
                "document_name": "recursive-graph-smoke",
            }))
            .unwrap();
        let document_id = ingest["document_id"].as_str().unwrap().to_string();

        let planned = app
            .plan_research(&json!({
                "workspace_root": root,
                "document_id": document_id,
                "goal": "Run recursive graph smoke",
                "reading_mode": "recursive",
            }))
            .unwrap();
        assert_eq!(planned["scope"], "document");
        let planned_nodes = planned["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|value| value.as_str())
            .collect::<Vec<_>>();
        assert!(
            planned_nodes.contains(&"read_recursive"),
            "expected plan_research(reading_mode=recursive) to include read_recursive node"
        );

        let run_id = planned["run_id"].as_str().unwrap().to_string();
        let completed = app
            .run_research_graph(&json!({
                "workspace_root": root,
                "run_id": run_id
            }))
            .await
            .unwrap();
        assert_eq!(completed["status"], "completed");

        let repo = BootstrapWorkspace::ensure(root.clone()).unwrap();
        let run_paths = repo.run_paths(&run_id);
        let graph: ResearchGraph = repo.read_json(&run_paths.graph).unwrap();
        let read_recursive = graph
            .nodes
            .get("read_recursive")
            .expect("missing read_recursive node");
        assert_eq!(read_recursive.depends_on, vec!["read".to_string()]);
        assert_eq!(read_recursive.payload["stage"], "recursive_refine");

        let read_recursive_paths = repo.node_paths(&run_id, "read_recursive");
        assert!(read_recursive_paths.result.exists());
        let read_recursive_result: Value = repo.read_json(&read_recursive_paths.result).unwrap();
        assert_eq!(read_recursive_result["mode"], "recursive");
        assert!(read_recursive_result.get("global_map_ref").is_some());
        assert!(read_recursive_result.get("final_report_ref").is_some());

        let merge_paths = repo.node_paths(&run_id, "merge");
        let merge_input_manifest: Value = repo.read_json(&merge_paths.input_manifest).unwrap();
        let merge_inputs = merge_input_manifest["input_refs"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|value| value.as_str().map(String::from))
            .collect::<Vec<_>>();
        assert!(
            merge_inputs
                .iter()
                .any(|item| item.contains("read_recursive") && item.ends_with("result.json")),
            "expected merge input refs to include read_recursive/result.json, got: {merge_inputs:?}"
        );

        let document_paths = repo.document_paths(&DocumentId::new(document_id));
        assert!(document_paths.global_map.exists());
        assert!(document_paths.final_report.exists());
        assert!(document_paths.reading_synthesis.exists());
    }

    #[tokio::test]
    async fn test_run_research_graph_dag_scheduler_starts_multiple_ready_nodes() {
        let root = temp_root();
        let app = PaperReaderApplication::new(RuntimeConfig {
            workspace_root: root.clone(),
            paperreader_max_concurrent_nodes: 2,
            ..RuntimeConfig::from_env()
        });

        app.bootstrap_workspace(&json!({ "workspace_root": root }))
            .unwrap();
        let ingest = app
            .ingest_source(&json!({
                "workspace_root": root,
                "source_type": "raw_text",
                "source_text": "Test title\n\nAlpha.\n\nBeta.",
                "document_name": "dag-parallel"
            }))
            .unwrap();
        let document_id = ingest["document_id"].as_str().unwrap().to_string();

        let planned = app
            .plan_research(&json!({
                "workspace_root": root,
                "document_id": document_id,
                "goal": "Parallel scheduler smoke"
            }))
            .unwrap();
        let run_id = planned["run_id"].as_str().unwrap().to_string();

        // Graph planner produces a DAG where `survey` and `read` are both ready at time zero.

        let run = app
            .run_research_graph(&json!({
                "workspace_root": root,
                "run_id": run_id
            }))
            .await
            .unwrap();
        assert_eq!(run["status"], "completed");

        let stream = app
            .stream_run_events(&json!({
                "workspace_root": root,
                "run_id": run_id,
                "cursor": 0,
                "limit": 200
            }))
            .unwrap();
        let events = stream["events"].as_array().expect("expected events array");

        // Expect: run_started, node_started(survey), node_started(survey_aux), ... node_completed later.
        assert!(
            events.len() >= 3,
            "expected at least 3 events, got {}",
            events.len()
        );
        assert_eq!(events[0]["event_type"], "run_started");
        assert_eq!(events[1]["event_type"], "node_started");
        assert_eq!(events[2]["event_type"], "node_started");
        let started_node_ids = HashSet::from([
            events[1]["node_id"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            events[2]["node_id"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
        ]);
        assert!(
            started_node_ids.contains("survey") && started_node_ids.contains("read"),
            "expected first two started nodes to be survey + read, got {:?}",
            started_node_ids
        );
        let first_completed = events
            .iter()
            .position(|event| {
                event.get("event_type").and_then(|value| value.as_str()) == Some("node_completed")
            })
            .unwrap_or(0);
        assert!(
            first_completed > 2,
            "expected node_completed after two node_started events, got index={first_completed}"
        );
    }
}
