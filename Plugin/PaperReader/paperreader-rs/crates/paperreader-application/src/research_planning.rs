use super::*;

pub(crate) fn build_research_graph(
    run_id: &str,
    scope: RunScope,
    collection_id: Option<&str>,
    document_ids: &[DocumentId],
    goal: &str,
    reading_mode: Option<&str>,
) -> ResearchGraph {
    let mut nodes = HashMap::new();
    let now = chrono::Utc::now().to_rfc3339();
    let requested_reading_mode = reading_mode
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());
    let scope_type = if scope == RunScope::Collection {
        paperreader_domain::ScopeType::Collection
    } else {
        paperreader_domain::ScopeType::Document
    };
    let scope_ref = collection_id
        .map(ToString::to_string)
        .or_else(|| document_ids.first().map(|value| value.0.clone()))
        .unwrap_or_else(|| "workspace".to_string());
    let base_payload = |extra: Value| {
        let mut payload = json!({
            "document_ids": document_ids,
            "collection_id": collection_id,
            "goal": goal,
            "scope": if scope == RunScope::Collection { "collection" } else { "document" },
        });
        if let (Some(payload_map), Some(extra_map)) = (payload.as_object_mut(), extra.as_object()) {
            if scope == RunScope::Document {
                if let Some(mode) = requested_reading_mode.as_ref() {
                    payload_map.insert("reading_mode".to_string(), json!(mode));
                }
            }
            payload_map.extend(extra_map.clone());
        }
        payload
    };

    let mut node_specs: Vec<(String, NodeType, Vec<String>, Value)> = Vec::new();
    if scope == RunScope::Collection {
        node_specs.push((
            "survey".to_string(),
            NodeType::Survey,
            Vec::new(),
            base_payload(json!({})),
        ));

        let mut read_fanout_node_ids = Vec::new();
        let mut retrieve_fanout_node_ids = Vec::new();
        for (index, document_id) in document_ids.iter().enumerate() {
            let read_node_id = format!("read_{index}");
            let retrieve_node_id = format!("retrieve_{index}");
            read_fanout_node_ids.push(read_node_id.clone());
            retrieve_fanout_node_ids.push(retrieve_node_id.clone());

            node_specs.push((
                read_node_id.clone(),
                NodeType::Read,
                Vec::new(),
                base_payload(json!({
                    "document_id": document_id.0,
                    "fanout_index": index,
                })),
            ));
            node_specs.push((
                retrieve_node_id.clone(),
                NodeType::Retrieve,
                vec![read_node_id],
                base_payload(json!({
                    "document_id": document_id.0,
                    "fanout_index": index,
                })),
            ));
        }

        node_specs.push((
            "read".to_string(),
            NodeType::Read,
            read_fanout_node_ids,
            base_payload(json!({ "aggregate": "fan_in" })),
        ));
        node_specs.push((
            "retrieve".to_string(),
            NodeType::Retrieve,
            retrieve_fanout_node_ids,
            base_payload(json!({ "aggregate": "fan_in" })),
        ));
        node_specs.push((
            "compare".to_string(),
            NodeType::Compare,
            vec!["read".to_string(), "retrieve".to_string()],
            base_payload(json!({})),
        ));
        node_specs.push((
            "conflict_audit".to_string(),
            NodeType::AuditConflict,
            vec!["compare".to_string()],
            base_payload(json!({})),
        ));
        node_specs.push((
            "merge".to_string(),
            NodeType::Merge,
            vec![
                "survey".to_string(),
                "read".to_string(),
                "retrieve".to_string(),
                "compare".to_string(),
                "conflict_audit".to_string(),
            ],
            base_payload(json!({})),
        ));
        node_specs.push((
            "synthesize".to_string(),
            NodeType::Synthesize,
            vec!["merge".to_string()],
            base_payload(json!({})),
        ));
    } else if requested_reading_mode.as_deref() == Some("recursive") {
        node_specs.push((
            "survey".to_string(),
            NodeType::Survey,
            Vec::new(),
            base_payload(json!({})),
        ));
        node_specs.push((
            "read".to_string(),
            NodeType::Read,
            Vec::new(),
            base_payload(json!({
                "stage": "baseline",
                "mode": "auto",
            })),
        ));
        node_specs.push((
            "read_recursive".to_string(),
            NodeType::Read,
            vec!["read".to_string()],
            base_payload(json!({
                "stage": "recursive_refine",
                "mode": "recursive",
                "resume_from_state": true,
            })),
        ));
        node_specs.push((
            "retrieve".to_string(),
            NodeType::Retrieve,
            vec!["read_recursive".to_string()],
            base_payload(json!({})),
        ));
        node_specs.push((
            "merge".to_string(),
            NodeType::Merge,
            vec![
                "survey".to_string(),
                "read_recursive".to_string(),
                "retrieve".to_string(),
            ],
            base_payload(json!({})),
        ));
        node_specs.push((
            "synthesize".to_string(),
            NodeType::Synthesize,
            vec!["merge".to_string()],
            base_payload(json!({})),
        ));
    } else {
        node_specs.push((
            "survey".to_string(),
            NodeType::Survey,
            Vec::new(),
            base_payload(json!({})),
        ));
        node_specs.push((
            "read".to_string(),
            NodeType::Read,
            Vec::new(),
            base_payload(json!({})),
        ));
        node_specs.push((
            "retrieve".to_string(),
            NodeType::Retrieve,
            vec!["read".to_string()],
            base_payload(json!({})),
        ));
        node_specs.push((
            "merge".to_string(),
            NodeType::Merge,
            vec![
                "survey".to_string(),
                "read".to_string(),
                "retrieve".to_string(),
            ],
            base_payload(json!({})),
        ));
        node_specs.push((
            "synthesize".to_string(),
            NodeType::Synthesize,
            vec!["merge".to_string()],
            base_payload(json!({})),
        ));
    }

    for (node_id, node_type, depends_on, payload) in node_specs.iter() {
        nodes.insert(
            node_id.clone(),
            ResearchNode {
                node_id: node_id.clone(),
                node_type: node_type.clone(),
                goal: format!("{goal} :: {scope_ref}"),
                scope_ref: scope_ref.clone(),
                execution_state: NodeExecutionState::Pending,
                depends_on: depends_on.clone(),
                child_ids: Vec::new(),
                parent_id: None,
                input_artifacts: Vec::new(),
                input_refs: Vec::new(),
                output_artifact: None,
                output_refs: Vec::new(),
                handoff_in_ref: None,
                handoff_out_ref: None,
                checkpoint_ref: None,
                attempt: 0,
                budget_consumed: None,
                budget: None,
                stop_conditions: Vec::new(),
                failure_policy: Some("fail_run".to_string()),
                payload: payload.clone(),
                created_at: now.clone(),
                updated_at: now.clone(),
            },
        );
    }

    // Fill parent/child fields for visualization and legacy sequential fallback.
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    for (node_id, node) in nodes.iter() {
        for dep in node.depends_on.iter() {
            children
                .entry(dep.clone())
                .or_default()
                .push(node_id.clone());
        }
    }
    for (node_id, node) in nodes.iter_mut() {
        node.parent_id = if node.depends_on.len() == 1 {
            node.depends_on.first().cloned()
        } else {
            None
        };
        node.child_ids = children.get(node_id).cloned().unwrap_or_default();
        node.child_ids.sort();
        node.child_ids.dedup();
    }

    let mut edges = Vec::new();
    for (node_id, node) in nodes.iter() {
        for dep in node.depends_on.iter() {
            edges.push(ResearchEdge {
                edge_id: format!("{dep}->{node_id}"),
                from_node_id: dep.clone(),
                to_node_id: node_id.clone(),
                edge_type: EdgeType::DataDependency,
            });
        }
    }
    edges.sort_by(|left, right| left.edge_id.cmp(&right.edge_id));

    ResearchGraph {
        graph_id: format!("graph-{run_id}"),
        goal: goal.to_string(),
        schema_version: "1.0".to_string(),
        root_scope: paperreader_domain::GraphScopeRef {
            scope_type,
            scope_ref,
        },
        root_node_id: "survey".to_string(),
        node_order: node_specs
            .iter()
            .map(|(node_id, _, _, _)| node_id.clone())
            .collect(),
        nodes,
        edges,
        created_at: now,
    }
}

pub(crate) fn build_graph_state(run_id: &str, graph: &ResearchGraph) -> GraphState {
    GraphState {
        graph_id: graph.graph_id.clone(),
        run_id: run_id.to_string(),
        node_states: graph
            .nodes
            .keys()
            .map(|node_id| {
                (
                    node_id.clone(),
                    NodeStateEntry {
                        node_id: node_id.clone(),
                        status: NodeWorkspaceStatus::Pending,
                        attempt: 0,
                        checkpoint_ref: None,
                        output_refs: Vec::new(),
                        started_at: None,
                        completed_at: None,
                    },
                )
            })
            .collect(),
        active_nodes: Vec::new(),
        completed_nodes: Vec::new(),
        failed_nodes: Vec::new(),
        updated_at: chrono::Utc::now().to_rfc3339(),
    }
}

pub(crate) fn default_budget_state(run_id: &str) -> BudgetState {
    BudgetState {
        run_id: run_id.to_string(),
        token_budget_total: 50_000,
        token_budget_used: 0,
        llm_call_budget_total: 50,
        llm_call_budget_used: 0,
        wall_clock_budget_total_seconds: 3600,
        wall_clock_budget_used_seconds: 0,
        context_pressure_score: 0.0,
        artifact_volume_score: 0.0,
        updated_at: chrono::Utc::now().to_rfc3339(),
    }
}
