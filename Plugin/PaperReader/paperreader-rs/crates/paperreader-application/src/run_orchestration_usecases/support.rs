use super::super::*;

pub(super) fn sync_run_manifest_entry_checkpoint(
    repo: &WorkspaceRepository,
    run_paths: &RunArtifactPaths,
    run_manifest: &mut RunManifest,
    checkpoint_path: Option<PathBuf>,
) -> Result<()> {
    run_manifest.entry_checkpoint = checkpoint_path;
    run_manifest.updated_at = chrono::Utc::now().to_rfc3339();
    repo.write_json(&run_paths.run_manifest, run_manifest)
}

pub(super) fn resolve_checkpoint_entry_path(
    workspace_root: &Path,
    checkpoint_ref: Option<&PathBuf>,
) -> Option<PathBuf> {
    checkpoint_ref.map(|path| {
        if path.is_absolute() {
            path.clone()
        } else {
            workspace_root.join(path)
        }
    })
}

pub(super) fn node_input_refs(
    repo: &WorkspaceRepository,
    run_manifest: &RunManifest,
    run_paths: &RunArtifactPaths,
    node: &ResearchNode,
) -> Vec<PathBuf> {
    if run_manifest.scope == RunScope::Collection {
        let collection_inputs = run_manifest
            .root_entity_refs
            .collection_id
            .as_ref()
            .map(|collection_id| repo.collection_paths(collection_id));
        return match &node.node_type {
            NodeType::Survey => collection_inputs
                .map(|paths| vec![paths.member_documents, paths.collection_map])
                .unwrap_or_default(),
            NodeType::Read => {
                if let Some(document_id) = payload_document_id(node) {
                    let document_paths = repo.document_paths(&document_id);
                    if payload_read_stage(node) == Some("recursive_refine") {
                        vec![
                            document_paths.reading_state,
                            document_paths.segment_summaries,
                            document_paths.handoff,
                        ]
                    } else {
                        vec![document_paths.segment_set, document_paths.attention_plan]
                    }
                } else if node.depends_on.iter().any(|dep| dep.starts_with("read_")) {
                    node.depends_on
                        .iter()
                        .map(|dep| run_paths.nodes_dir.join(dep).join("result.json"))
                        .collect()
                } else {
                    run_manifest
                        .root_entity_refs
                        .document_ids
                        .iter()
                        .flat_map(|document_id| {
                            let document_paths = repo.document_paths(document_id);
                            vec![document_paths.segment_set, document_paths.attention_plan]
                        })
                        .collect()
                }
            }
            NodeType::Retrieve => {
                if let Some(document_id) = payload_document_id(node) {
                    let document_paths = repo.document_paths(&document_id);
                    vec![
                        document_paths.reading_state,
                        document_paths.segment_summaries,
                        document_paths.handoff,
                    ]
                } else if node
                    .depends_on
                    .iter()
                    .any(|dep| dep.starts_with("retrieve_"))
                {
                    let mut refs = node
                        .depends_on
                        .iter()
                        .map(|dep| run_paths.nodes_dir.join(dep).join("result.json"))
                        .collect::<Vec<_>>();
                    if let Some(paths) = collection_inputs {
                        refs.push(paths.collection_map);
                        refs.push(paths.member_documents);
                    }
                    refs
                } else {
                    collection_inputs
                        .map(|paths| vec![paths.collection_map, paths.member_documents])
                        .unwrap_or_default()
                }
            }
            NodeType::Compare => collection_inputs
                .map(|paths| {
                    vec![
                        paths.member_documents,
                        paths.collection_map,
                        paths.evidence_pack_latest,
                        run_paths.nodes_dir.join("read").join("result.json"),
                        run_paths.nodes_dir.join("retrieve").join("result.json"),
                    ]
                })
                .unwrap_or_default(),
            NodeType::AuditConflict => collection_inputs
                .map(|paths| {
                    vec![
                        paths.member_documents,
                        run_paths.nodes_dir.join("compare").join("result.json"),
                        paths.comparison_table_latest,
                        run_paths.nodes_dir.join("retrieve").join("result.json"),
                    ]
                })
                .unwrap_or_default(),
            NodeType::Merge => merge_node_input_refs(run_paths, node),
            NodeType::Synthesize => {
                let mut refs = vec![run_paths.merges_dir.join("single_document_merge.json")];
                if let Some(paths) = collection_inputs {
                    refs.push(paths.evidence_pack_latest);
                    refs.push(paths.comparison_table_latest);
                    refs.push(paths.conflict_report_latest);
                }
                refs
            }
            _ => Vec::new(),
        };
    }

    let Some(document_id) = run_manifest.root_entity_refs.document_ids.first() else {
        return Vec::new();
    };
    let document_paths = repo.document_paths(document_id);
    match &node.node_type {
        NodeType::Survey => vec![document_paths.normalized_document],
        NodeType::Read => {
            if payload_read_stage(node) == Some("recursive_refine") {
                vec![
                    document_paths.reading_state,
                    document_paths.segment_summaries,
                    document_paths.handoff,
                ]
            } else {
                vec![document_paths.segment_set, document_paths.attention_plan]
            }
        }
        NodeType::Retrieve => vec![
            document_paths.reading_state,
            document_paths.segment_summaries,
            document_paths.handoff,
        ],
        NodeType::Merge => merge_node_input_refs(run_paths, node),
        NodeType::Synthesize => vec![
            run_paths.merges_dir.join("single_document_merge.json"),
            document_paths.evidence_pack,
        ],
        _ => Vec::new(),
    }
}

fn payload_document_id(node: &ResearchNode) -> Option<DocumentId> {
    node.payload
        .get("document_id")
        .and_then(|value| value.as_str())
        .map(|value| DocumentId::new(value.to_string()))
}

fn payload_read_stage<'a>(node: &'a ResearchNode) -> Option<&'a str> {
    node.payload.get("stage").and_then(|value| value.as_str())
}

fn merge_node_input_refs(run_paths: &RunArtifactPaths, node: &ResearchNode) -> Vec<PathBuf> {
    let mut refs = Vec::new();
    for dependency in node.depends_on.iter() {
        let dependency_root = run_paths.nodes_dir.join(dependency);
        refs.push(dependency_root.join("result.json"));
        let handoff_ref = dependency_root.join("handoff_out.json");
        if handoff_ref.exists() {
            refs.push(handoff_ref);
        }
    }
    refs.sort();
    refs.dedup();
    refs
}

pub(super) fn write_node_input_manifest(
    repo: &WorkspaceRepository,
    node_paths: &NodeArtifactPaths,
    run_id: &str,
    node: &ResearchNode,
    input_refs: &[PathBuf],
) -> Result<()> {
    repo.write_json(
        &node_paths.input_manifest,
        &NodeInputManifest {
            run_id: run_id.to_string(),
            node_id: node.node_id.clone(),
            node_type: format!("{:?}", &node.node_type),
            input_refs: input_refs.to_vec(),
            created_at: chrono::Utc::now().to_rfc3339(),
        },
    )
}

pub(super) fn write_node_output_manifest(
    repo: &WorkspaceRepository,
    node_paths: &NodeArtifactPaths,
    run_id: &str,
    node_id: &str,
    status: &str,
    primary_ref: Option<PathBuf>,
    output_refs: &[PathBuf],
    checkpoint_ref: Option<PathBuf>,
) -> Result<()> {
    repo.write_json(
        &node_paths.output_manifest,
        &NodeOutputManifest {
            run_id: run_id.to_string(),
            node_id: node_id.to_string(),
            status: status.to_string(),
            primary_ref,
            output_refs: output_refs.to_vec(),
            checkpoint_ref,
            trace_ref: node_paths.trace_jsonl.clone(),
            updated_at: chrono::Utc::now().to_rfc3339(),
        },
    )
}

pub(super) fn record_trace_event(
    trace_store: &TraceStore,
    node_paths: Option<&NodeArtifactPaths>,
    event: TraceEvent,
) -> Result<()> {
    trace_store.append_event(&event.run_id, &event)?;
    if let Some(node_paths) = node_paths {
        append_jsonl(&node_paths.trace_jsonl, &event)?;
        append_text_line(
            &node_paths.trace_log,
            &format!(
                "{} [{}] {}",
                event.timestamp,
                event.event_type,
                event.note.as_deref().unwrap_or_default()
            ),
        )?;
    }
    Ok(())
}

fn append_jsonl<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let line = serde_json::to_string(value)?;
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(file, "{line}")?;
    Ok(())
}

fn append_text_line(path: &Path, line: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(file, "{line}")?;
    Ok(())
}

pub(super) fn budget_state_from_checkpoint(
    run_id: &str,
    current: &BudgetState,
    snapshot: &BudgetStateSnapshot,
) -> BudgetState {
    BudgetState {
        run_id: run_id.to_string(),
        token_budget_total: snapshot.token_total,
        token_budget_used: snapshot.token_used,
        llm_call_budget_total: snapshot.llm_call_total,
        llm_call_budget_used: snapshot.llm_call_used,
        wall_clock_budget_total_seconds: snapshot.time_total_seconds,
        wall_clock_budget_used_seconds: snapshot.time_used_seconds,
        context_pressure_score: current.context_pressure_score,
        artifact_volume_score: current.artifact_volume_score,
        updated_at: chrono::Utc::now().to_rfc3339(),
    }
}

pub(super) fn requested_execution_mode(payload: &Value) -> Option<ExecutionMode> {
    payload
        .get("execution")
        .and_then(|value| value.get("mode"))
        .and_then(|value| value.as_str())
        .or_else(|| {
            payload
                .get("execution_mode")
                .and_then(|value| value.as_str())
        })
        .and_then(|mode| match mode {
            "sync" => Some(ExecutionMode::Sync),
            "async" => Some(ExecutionMode::Async),
            "stream" => Some(ExecutionMode::Stream),
            _ => None,
        })
}

pub(super) fn build_aborted_run_response(run_id: &str, run_paths: &RunArtifactPaths) -> Value {
    json!({
        "run_id": run_id,
        "status": "aborted",
        "run_state_ref": display_path(&run_paths.run_state),
        "graph_state_ref": display_path(&run_paths.graph_state),
        "budget_state_ref": display_path(&run_paths.budget_state),
        "artifact_refs": [
            display_path(&run_paths.run_manifest),
            display_path(&run_paths.run_state),
            display_path(&run_paths.graph_state),
            display_path(&run_paths.budget_state)
        ]
    })
}

// Legacy helper for the sequential executor (kept for debugging fallback).
#[allow(dead_code)]
pub(super) fn execution_order(graph: &ResearchGraph) -> Result<Vec<String>> {
    if !graph.node_order.is_empty() {
        return Ok(graph.node_order.clone());
    }

    let mut order = Vec::new();
    let mut cursor = graph.root_node_id.clone();
    loop {
        order.push(cursor.clone());
        let node = graph
            .nodes
            .get(&cursor)
            .with_context(|| format!("missing node {cursor}"))?;
        let Some(next) = node.child_ids.first() else {
            break;
        };
        cursor = next.clone();
    }
    Ok(order)
}

pub(super) fn status_from_snapshot(state: &str) -> NodeWorkspaceStatus {
    if state == "completed" {
        NodeWorkspaceStatus::Completed
    } else if state == "running" {
        NodeWorkspaceStatus::Running
    } else if state.starts_with("failed:") {
        NodeWorkspaceStatus::Failed
    } else {
        NodeWorkspaceStatus::Pending
    }
}

pub(super) fn create_node_directories(paths: &NodeArtifactPaths) -> Result<()> {
    for path in [
        &paths.node_json,
        &paths.input_manifest,
        &paths.output_manifest,
        &paths.handoff_in,
        &paths.handoff_out,
        &paths.trace_log,
        &paths.trace_jsonl,
        &paths.checkpoint,
        &paths.budget,
        &paths.result,
        &paths.failure,
    ] {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
    }
    Ok(())
}
