use super::*;

mod lock;
mod nodes;
mod support;

pub(crate) use lock::mutate_run_state_if_active;
use lock::{mutate_run_state_locked, read_run_state_locked};
use support::*;

impl PaperReaderApplication {
    pub fn plan_research(&self, payload: &Value) -> Result<Value> {
        let repo = BootstrapWorkspace::ensure(self.resolve_workspace_root(payload))?;
        let goal = required_string(payload, "goal")?;
        let run_id = payload_string(payload, "run_id")
            .unwrap_or_else(|| format!("run-{}", uuid::Uuid::new_v4().simple()));
        let collection_id = payload_string(payload, "collection_id");
        let requested_reading_mode = payload_string(payload, "reading_mode")
            .or_else(|| payload_string(payload, "mode"))
            .map(|value| value.trim().to_lowercase())
            .filter(|value| !value.is_empty());
        let document_ids =
            resolve_retrieval_document_ids(&repo, payload, collection_id.as_deref())?;
        let scope = if collection_id.is_some() || document_ids.len() > 1 {
            RunScope::Collection
        } else {
            RunScope::Document
        };
        let graph = build_research_graph(
            &run_id,
            scope.clone(),
            collection_id.as_deref(),
            &document_ids,
            &goal,
            requested_reading_mode.as_deref(),
        );
        let run_paths = repo.run_paths(&run_id);
        run_paths.create_directories()?;
        let run_manifest = RunManifest {
            run_id: run_id.clone(),
            goal: goal.clone(),
            scope: scope.clone(),
            root_entity_refs: RootEntityRefs {
                collection_id: collection_id.clone().map(CollectionId::new),
                document_ids: document_ids.clone(),
            },
            graph_ref: run_paths.graph.clone(),
            run_state_ref: run_paths.run_state.clone(),
            budget_state_ref: run_paths.budget_state.clone(),
            entry_checkpoint: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            updated_at: chrono::Utc::now().to_rfc3339(),
        };
        let run_state = RunState {
            run_id: run_id.clone(),
            status: RunStatus::Pending,
            current_phase: Some("planned".to_string()),
            current_node_id: None,
            resume_entry: None,
            started_at: chrono::Utc::now().to_rfc3339(),
            last_updated_at: chrono::Utc::now().to_rfc3339(),
            completed_at: None,
        };
        let budget_state = default_budget_state(&run_id);
        let graph_state = build_graph_state(&run_id, &graph);
        repo.write_json(&run_paths.graph, &graph)?;
        repo.write_json(&run_paths.run_manifest, &run_manifest)?;
        repo.write_json(&run_paths.run_state, &run_state)?;
        repo.write_json(&run_paths.graph_state, &graph_state)?;
        repo.write_json(&run_paths.budget_state, &budget_state)?;
        Ok(json!({
            "run_id": run_id,
            "graph_id": graph.graph_id,
            "scope": scope,
            "root_entity_refs": run_manifest.root_entity_refs,
            "nodes": graph.nodes.keys().collect::<Vec<_>>(),
            "artifact_refs": [
                display_path(&run_paths.run_manifest),
                display_path(&run_paths.graph),
                display_path(&run_paths.run_state),
                display_path(&run_paths.graph_state),
                display_path(&run_paths.budget_state)
            ]
        }))
    }

    pub async fn run_research_graph(&self, payload: &Value) -> Result<Value> {
        let repo = BootstrapWorkspace::ensure(self.resolve_workspace_root(payload))?;
        let run_id = if let Some(run_id) = payload_string(payload, "run_id") {
            run_id
        } else {
            self.plan_research(payload)?
                .get("run_id")
                .and_then(|v| v.as_str())
                .context("plan_research did not return run_id")?
                .to_string()
        };
        let execution_mode = requested_execution_mode(payload);
        if execution_mode == Some(ExecutionMode::Async) {
            let run_paths = repo.run_paths(&run_id);
            if mutate_run_state_if_active(&repo, &run_paths, |run_state| {
                run_state.status = RunStatus::Pending;
                run_state.current_phase = Some("accepted".to_string());
                run_state.last_updated_at = chrono::Utc::now().to_rfc3339();
                Ok(())
            })?
            .is_none()
            {
                return Ok(build_aborted_run_response(&run_id, &run_paths));
            }
            return Ok(json!({
                "run_id": run_id,
                "status": "accepted",
                "degrade_mode": "manual_resume_required",
                "run_state_ref": display_path(&run_paths.run_state),
                "graph_state_ref": display_path(&run_paths.graph_state),
                "poll_command": "get_run_state",
                "resume_command": "resume_research_graph",
                "stream_command": "stream_run_events",
                "artifact_refs": [
                    display_path(&run_paths.run_manifest),
                    display_path(&run_paths.run_state),
                    display_path(&run_paths.graph_state),
                    display_path(&run_paths.budget_state)
                ]
            }));
        }
        self.execute_run_dag(&repo, &run_id, None, None).await
    }

    pub async fn resume_research_graph(&self, payload: &Value) -> Result<Value> {
        let repo = BootstrapWorkspace::ensure(self.resolve_workspace_root(payload))?;
        let run_id = required_string(payload, "run_id")?;
        let run_paths = repo.run_paths(&run_id);
        let mut run_manifest: RunManifest = repo.read_json(&run_paths.run_manifest)?;
        let mut graph: ResearchGraph = repo.read_json(&run_paths.graph)?;
        let mut graph_state: GraphState = repo.read_json(&run_paths.graph_state)?;
        let current_budget_state: BudgetState = repo.read_json(&run_paths.budget_state)?;
        let checkpoint_manager = CheckpointManager::new(&run_paths.checkpoints_dir);
        let checkpoint_path = if let Some(checkpoint_id) = payload_string(payload, "checkpoint_id")
        {
            Some(
                run_paths
                    .checkpoints_dir
                    .join(format!("{checkpoint_id}.json")),
            )
        } else if let Some(entry_checkpoint) =
            resolve_checkpoint_entry_path(&repo.layout.root, run_manifest.entry_checkpoint.as_ref())
        {
            if entry_checkpoint.exists() {
                Some(entry_checkpoint)
            } else {
                checkpoint_manager
                    .get_latest_checkpoint(&run_id)
                    .await?
                    .map(|ckpt| {
                        run_paths
                            .checkpoints_dir
                            .join(format!("{}.json", ckpt.checkpoint_id))
                    })
            }
        } else {
            checkpoint_manager
                .get_latest_checkpoint(&run_id)
                .await?
                .map(|ckpt| {
                    run_paths
                        .checkpoints_dir
                        .join(format!("{}.json", ckpt.checkpoint_id))
                })
        };
        let Some(checkpoint_path) = checkpoint_path else {
            return self.execute_run_dag(&repo, &run_id, None, None).await;
        };
        let checkpoint_id = checkpoint_path
            .file_stem()
            .and_then(|value| value.to_str())
            .context("entry_checkpoint path must resolve to a checkpoint json file")?
            .to_string();
        let resume = checkpoint_manager
            .resume_from_checkpoint(&checkpoint_id, &mut graph)
            .await?;
        sync_run_manifest_entry_checkpoint(
            &repo,
            &run_paths,
            &mut run_manifest,
            Some(checkpoint_path.clone()),
        )?;
        for (node_id, snapshot) in &resume.node_states {
            if let Some(entry) = graph_state.node_states.get_mut(node_id) {
                entry.status = status_from_snapshot(&snapshot.execution_state);
                entry.checkpoint_ref = Some(
                    run_paths
                        .checkpoints_dir
                        .join(format!("{checkpoint_id}.json")),
                );
            }
        }
        let resumed_budget_state = resume
            .budget_state
            .as_ref()
            .map(|snapshot| budget_state_from_checkpoint(&run_id, &current_budget_state, snapshot));
        repo.write_json(&run_paths.graph, &graph)?;
        repo.write_json(&run_paths.graph_state, &graph_state)?;
        if let Some(ref budget_state) = resumed_budget_state {
            repo.write_json(&run_paths.budget_state, budget_state)?;
        }
        self.execute_run_dag(
            &repo,
            &run_id,
            resume.resume_from_node,
            resumed_budget_state,
        )
        .await
    }

    pub fn stream_run_events(&self, payload: &Value) -> Result<Value> {
        let repo = BootstrapWorkspace::ensure(self.resolve_workspace_root(payload))?;
        let run_id = required_string(payload, "run_id")?;
        let cursor = payload
            .get("cursor")
            .and_then(|value| value.as_u64())
            .unwrap_or(0) as usize;
        let limit = payload
            .get("limit")
            .and_then(|value| value.as_u64())
            .unwrap_or(100) as usize;
        let run_paths = repo.run_paths(&run_id);
        if !run_paths.run_manifest.exists() && !run_paths.run_state.exists() {
            anyhow::bail!("run not found: {run_id}");
        }
        let trace_store = TraceStore::new(run_paths.traces_dir.clone());
        let trace_ref = trace_store.trace_path(&run_id);
        let (events, next_cursor, end_of_stream) =
            trace_store.read_events(&run_id, cursor, limit)?;
        let run_state: Option<RunState> = if run_paths.run_state.exists() {
            Some(repo.read_json(&run_paths.run_state)?)
        } else {
            None
        };
        Ok(json!({
            "run_id": run_id,
            "events": events,
            "next_cursor": next_cursor,
            "end_of_stream": end_of_stream,
            "trace_ref": display_path(&trace_ref),
            "run_state_ref": display_path(&run_paths.run_state),
            "run_state": run_state,
        }))
    }

    pub fn get_run_state(&self, payload: &Value) -> Result<Value> {
        self.get_workspace_state(payload)
    }

    pub fn cancel_run(&self, payload: &Value) -> Result<Value> {
        let repo = BootstrapWorkspace::ensure(self.resolve_workspace_root(payload))?;
        let run_id = required_string(payload, "run_id")?;
        let run_paths = repo.run_paths(&run_id);
        if !run_paths.run_state.exists() {
            anyhow::bail!("run not found: {run_id}");
        }
        let (_, already_terminal) = mutate_run_state_locked(&repo, &run_paths, |run_state| {
            if matches!(
                run_state.status,
                RunStatus::Completed | RunStatus::Failed | RunStatus::Aborted
            ) {
                return Ok(true);
            }
            run_state.status = RunStatus::Aborted;
            run_state.current_phase = Some("aborted".to_string());
            run_state.last_updated_at = chrono::Utc::now().to_rfc3339();
            Ok(false)
        })?;
        if already_terminal {
            return Ok(json!({
                "run_id": run_id,
                "status": "partial",
                "degrade_mode": "terminal_run_state",
                "run_state_ref": display_path(&run_paths.run_state),
                "artifact_refs": [display_path(&run_paths.run_state)],
            }));
        }
        let trace_store = TraceStore::new(run_paths.traces_dir.clone());
        record_trace_event(
            &trace_store,
            None,
            TraceEvent {
                timestamp: chrono::Utc::now().to_rfc3339(),
                run_id: run_id.clone(),
                node_id: None,
                event_type: "run_cancelled".to_string(),
                input_refs: vec![run_paths.run_state.clone()],
                output_refs: vec![run_paths.run_state.clone()],
                budget_delta: None,
                note: payload_string(payload, "reason"),
            },
        )?;
        Ok(json!({
            "run_id": run_id,
            "status": "aborted",
            "run_state_ref": display_path(&run_paths.run_state),
            "trace_ref": display_path(&trace_store.trace_path(&run_id)),
            "artifact_refs": [
                display_path(&run_paths.run_state),
                display_path(&trace_store.trace_path(&run_id))
            ]
        }))
    }

    pub fn reset_run(&self, payload: &Value) -> Result<Value> {
        let repo = BootstrapWorkspace::ensure(self.resolve_workspace_root(payload))?;
        let run_id = required_string(payload, "run_id")?;
        let run_paths = repo.run_paths(&run_id);
        if !run_paths.run_manifest.exists() {
            anyhow::bail!("run not found: {run_id}");
        }

        let mut run_manifest: RunManifest = repo.read_json(&run_paths.run_manifest)?;
        let mut graph: ResearchGraph = repo.read_json(&run_paths.graph)?;
        let now = chrono::Utc::now().to_rfc3339();

        // Clear run-scoped volatile dirs while keeping the static graph + manifest files.
        for dir in [
            &run_paths.checkpoints_dir,
            &run_paths.nodes_dir,
            &run_paths.merges_dir,
            &run_paths.outputs_dir,
            &run_paths.traces_dir,
            &run_paths.failures_dir,
        ] {
            if dir.exists() {
                std::fs::remove_dir_all(dir)?;
            }
            std::fs::create_dir_all(dir)?;
        }

        // Reset graph dynamic fields so resume can re-run from a clean slate.
        // graph_state is the SSOT, but graph.json is also persisted and reused by resume paths.
        for node in graph.nodes.values_mut() {
            node.execution_state = NodeExecutionState::Pending;
            node.input_artifacts.clear();
            node.output_artifact = None;
            node.output_refs.clear();
            node.handoff_in_ref = None;
            node.handoff_out_ref = None;
            node.checkpoint_ref = None;
            node.attempt = 0;
            node.budget_consumed = None;
            node.updated_at = now.clone();
        }

        let run_state = RunState {
            run_id: run_id.clone(),
            status: RunStatus::Pending,
            current_phase: Some("planned".to_string()),
            current_node_id: None,
            resume_entry: None,
            started_at: now.clone(),
            last_updated_at: now.clone(),
            completed_at: None,
        };
        let budget_state = default_budget_state(&run_id);
        let graph_state = build_graph_state(&run_id, &graph);

        sync_run_manifest_entry_checkpoint(&repo, &run_paths, &mut run_manifest, None)?;
        repo.write_json(&run_paths.graph, &graph)?;
        repo.write_json(&run_paths.run_state, &run_state)?;
        repo.write_json(&run_paths.graph_state, &graph_state)?;
        repo.write_json(&run_paths.budget_state, &budget_state)?;

        Ok(json!({
            "run_id": run_id,
            "status": "reset",
            "artifact_refs": [
                display_path(&run_paths.run_manifest),
                display_path(&run_paths.graph),
                display_path(&run_paths.run_state),
                display_path(&run_paths.graph_state),
                display_path(&run_paths.budget_state)
            ]
        }))
    }

    // Legacy sequential executor kept as a debugging fallback.
    // The DAG scheduler (`execute_run_dag`) is the SSOT for production paths.
    #[allow(dead_code)]
    async fn execute_run(
        &self,
        repo: &WorkspaceRepository,
        run_id: &str,
        resume_from_node: Option<String>,
        initial_budget_state: Option<BudgetState>,
    ) -> Result<Value> {
        let run_paths = repo.run_paths(run_id);
        let mut run_manifest: RunManifest = repo.read_json(&run_paths.run_manifest)?;
        let mut graph: ResearchGraph = repo.read_json(&run_paths.graph)?;
        let run_state = read_run_state_locked(repo, &run_paths)?;
        let mut graph_state: GraphState = repo.read_json(&run_paths.graph_state)?;
        let mut budget_state: BudgetState = if let Some(budget_state) = initial_budget_state {
            repo.write_json(&run_paths.budget_state, &budget_state)?;
            budget_state
        } else {
            repo.read_json(&run_paths.budget_state)?
        };
        if matches!(run_state.status, RunStatus::Aborted) {
            return Ok(build_aborted_run_response(run_id, &run_paths));
        }
        let order = execution_order(&graph)?;
        let start_index = resume_from_node
            .as_ref()
            .and_then(|node_id| order.iter().position(|candidate| candidate == node_id))
            .unwrap_or_else(|| {
                order
                    .iter()
                    .position(|node_id| !graph_state.completed_nodes.contains(node_id))
                    .unwrap_or(order.len())
            });
        let primary_document_id = run_manifest.root_entity_refs.document_ids.first().cloned();
        let trace_store = TraceStore::new(run_paths.traces_dir.clone());

        let Some((_, ())) = mutate_run_state_if_active(repo, &run_paths, |state| {
            state.status = RunStatus::Running;
            state.current_phase = Some("executing".to_string());
            state.last_updated_at = chrono::Utc::now().to_rfc3339();
            Ok(())
        })?
        else {
            return Ok(build_aborted_run_response(run_id, &run_paths));
        };
        graph_state.updated_at = chrono::Utc::now().to_rfc3339();
        repo.write_json(&run_paths.graph_state, &graph_state)?;
        record_trace_event(
            &trace_store,
            None,
            TraceEvent {
                timestamp: chrono::Utc::now().to_rfc3339(),
                run_id: run_id.to_string(),
                node_id: None,
                event_type: "run_started".to_string(),
                input_refs: vec![run_paths.run_manifest.clone(), run_paths.graph.clone()],
                output_refs: vec![
                    run_paths.run_state.clone(),
                    run_paths.graph_state.clone(),
                    run_paths.budget_state.clone(),
                ],
                budget_delta: None,
                note: resume_from_node
                    .as_ref()
                    .map(|node_id| format!("resume_from_node={node_id}")),
            },
        )?;

        let checkpoint_manager = CheckpointManager::new(&run_paths.checkpoints_dir);
        for node_id in order.into_iter().skip(start_index) {
            let persisted_run_state = read_run_state_locked(repo, &run_paths)?;
            if matches!(persisted_run_state.status, RunStatus::Aborted) {
                return Ok(build_aborted_run_response(run_id, &run_paths));
            }
            if graph_state.completed_nodes.contains(&node_id) {
                continue;
            }
            let node = graph
                .nodes
                .get(&node_id)
                .cloned()
                .with_context(|| format!("missing node {node_id}"))?;
            let node_paths = repo.node_paths(&run_manifest.run_id, &node.node_id);
            create_node_directories(&node_paths)?;
            repo.write_json(&node_paths.node_json, &node)?;
            let input_refs = node_input_refs(repo, &run_manifest, &run_paths, &node);
            if let Some(graph_node) = graph.nodes.get_mut(&node_id) {
                graph_node.input_artifacts =
                    input_refs.iter().map(|path| display_path(path)).collect();
                graph_node.execution_state = NodeExecutionState::Running;
            }
            write_node_input_manifest(repo, &node_paths, run_id, &node, &input_refs)?;
            let Some((_, ())) = mutate_run_state_if_active(repo, &run_paths, |state| {
                state.current_node_id = Some(node_id.clone());
                state.last_updated_at = chrono::Utc::now().to_rfc3339();
                Ok(())
            })?
            else {
                return Ok(build_aborted_run_response(run_id, &run_paths));
            };
            if let Some(entry) = graph_state.node_states.get_mut(&node_id) {
                entry.status = NodeWorkspaceStatus::Running;
                entry.started_at = Some(chrono::Utc::now().to_rfc3339());
            }
            graph_state.active_nodes = vec![node_id.clone()];
            graph_state.updated_at = chrono::Utc::now().to_rfc3339();
            repo.write_json(&run_paths.graph, &graph)?;
            repo.write_json(&run_paths.graph_state, &graph_state)?;
            record_trace_event(
                &trace_store,
                Some(&node_paths),
                TraceEvent {
                    timestamp: chrono::Utc::now().to_rfc3339(),
                    run_id: run_id.to_string(),
                    node_id: Some(node_id.clone()),
                    event_type: "node_started".to_string(),
                    input_refs: input_refs.clone(),
                    output_refs: vec![
                        node_paths.input_manifest.clone(),
                        node_paths.node_json.clone(),
                    ],
                    budget_delta: None,
                    note: Some(format!("{:?}", &node.node_type)),
                },
            )?;

            match self
                .execute_node(
                    repo,
                    &run_manifest,
                    &run_paths,
                    primary_document_id.as_ref(),
                    &node,
                    &node_paths,
                    &input_refs,
                )
                .await
            {
                Ok(execution) => {
                    if let Some(graph_node) = graph.nodes.get_mut(&node_id) {
                        graph_node.execution_state = NodeExecutionState::Completed;
                        graph_node.output_artifact = Some(display_path(&execution.primary_ref));
                        graph_node.budget_consumed = Some(BudgetConsumed {
                            tokens: execution.tokens_used,
                            llm_calls: 1,
                            elapsed_seconds: execution.elapsed_seconds,
                        });
                    }
                    if let Some(entry) = graph_state.node_states.get_mut(&node_id) {
                        entry.status = NodeWorkspaceStatus::Completed;
                        entry.output_refs = execution.artifact_refs.clone();
                        entry.completed_at = Some(chrono::Utc::now().to_rfc3339());
                    }
                    budget_state.token_budget_used += execution.tokens_used;
                    budget_state.llm_call_budget_used += 1;
                    budget_state.wall_clock_budget_used_seconds += execution.elapsed_seconds;
                    budget_state.updated_at = chrono::Utc::now().to_rfc3339();
                    repo.write_json(&node_paths.budget, &budget_state)?;
                    graph_state.active_nodes.clear();
                    graph_state.completed_nodes.push(node_id.clone());
                    graph_state.updated_at = chrono::Utc::now().to_rfc3339();
                    repo.write_json(&run_paths.graph, &graph)?;
                    repo.write_json(&run_paths.graph_state, &graph_state)?;
                    repo.write_json(&run_paths.budget_state, &budget_state)?;
                    let Some((_, ())) = mutate_run_state_if_active(repo, &run_paths, |state| {
                        state.resume_entry = None;
                        state.last_updated_at = chrono::Utc::now().to_rfc3339();
                        Ok(())
                    })?
                    else {
                        return Ok(build_aborted_run_response(run_id, &run_paths));
                    };
                    let checkpoint = checkpoint_manager
                        .create_checkpoint(run_id, &graph, &budget_state)
                        .await?;
                    let checkpoint_path = run_paths
                        .checkpoints_dir
                        .join(format!("{}.json", checkpoint.checkpoint_id));
                    repo.write_json(&node_paths.checkpoint, &checkpoint)?;
                    if let Some(entry) = graph_state.node_states.get_mut(&node_id) {
                        entry.checkpoint_ref = Some(checkpoint_path.clone());
                    }
                    sync_run_manifest_entry_checkpoint(
                        repo,
                        &run_paths,
                        &mut run_manifest,
                        Some(checkpoint_path.clone()),
                    )?;
                    repo.write_json(&run_paths.graph_state, &graph_state)?;
                    write_node_output_manifest(
                        repo,
                        &node_paths,
                        run_id,
                        &node.node_id,
                        "completed",
                        Some(execution.primary_ref.clone()),
                        &execution.artifact_refs,
                        Some(checkpoint_path.clone()),
                    )?;
                    let budget_delta = BudgetConsumed {
                        tokens: execution.tokens_used,
                        llm_calls: 1,
                        elapsed_seconds: execution.elapsed_seconds,
                    };
                    record_trace_event(
                        &trace_store,
                        Some(&node_paths),
                        TraceEvent {
                            timestamp: chrono::Utc::now().to_rfc3339(),
                            run_id: run_id.to_string(),
                            node_id: Some(node_id.clone()),
                            event_type: "node_completed".to_string(),
                            input_refs: input_refs.clone(),
                            output_refs: execution.artifact_refs.clone(),
                            budget_delta: Some(budget_delta.clone()),
                            note: Some(display_path(&execution.primary_ref)),
                        },
                    )?;
                    record_trace_event(
                        &trace_store,
                        Some(&node_paths),
                        TraceEvent {
                            timestamp: chrono::Utc::now().to_rfc3339(),
                            run_id: run_id.to_string(),
                            node_id: Some(node_id.clone()),
                            event_type: "checkpoint_created".to_string(),
                            input_refs: vec![node_paths.output_manifest.clone()],
                            output_refs: vec![
                                checkpoint_path.clone(),
                                node_paths.checkpoint.clone(),
                                node_paths.budget.clone(),
                            ],
                            budget_delta: None,
                            note: Some(checkpoint.checkpoint_id),
                        },
                    )?;
                }
                Err(error) => {
                    if let Some(graph_node) = graph.nodes.get_mut(&node_id) {
                        graph_node.execution_state = NodeExecutionState::Failed(error.to_string());
                    }
                    if let Some(entry) = graph_state.node_states.get_mut(&node_id) {
                        entry.status = NodeWorkspaceStatus::Failed;
                        entry.completed_at = Some(chrono::Utc::now().to_rfc3339());
                    }
                    graph_state.failed_nodes.push(node_id.clone());
                    graph_state.active_nodes.clear();
                    graph_state.updated_at = chrono::Utc::now().to_rfc3339();
                    repo.write_json(&node_paths.budget, &budget_state)?;
                    let failure_outputs = if node_paths.failure.exists() {
                        vec![node_paths.failure.clone()]
                    } else {
                        Vec::new()
                    };
                    write_node_output_manifest(
                        repo,
                        &node_paths,
                        run_id,
                        &node.node_id,
                        "failed",
                        failure_outputs.first().cloned(),
                        &failure_outputs,
                        None,
                    )?;
                    repo.write_json(&run_paths.graph, &graph)?;
                    repo.write_json(&run_paths.graph_state, &graph_state)?;
                    let Some((_, ())) = mutate_run_state_if_active(repo, &run_paths, |state| {
                        state.status = RunStatus::Failed;
                        state.resume_entry = Some(node_id.clone());
                        state.current_phase = Some("failed".to_string());
                        state.last_updated_at = chrono::Utc::now().to_rfc3339();
                        Ok(())
                    })?
                    else {
                        return Ok(build_aborted_run_response(run_id, &run_paths));
                    };
                    record_trace_event(
                        &trace_store,
                        Some(&node_paths),
                        TraceEvent {
                            timestamp: chrono::Utc::now().to_rfc3339(),
                            run_id: run_id.to_string(),
                            node_id: Some(node_id.clone()),
                            event_type: "node_failed".to_string(),
                            input_refs: input_refs.clone(),
                            output_refs: failure_outputs.clone(),
                            budget_delta: None,
                            note: Some(error.to_string()),
                        },
                    )?;
                    record_trace_event(
                        &trace_store,
                        None,
                        TraceEvent {
                            timestamp: chrono::Utc::now().to_rfc3339(),
                            run_id: run_id.to_string(),
                            node_id: Some(node_id.clone()),
                            event_type: "run_failed".to_string(),
                            input_refs: vec![
                                run_paths.graph.clone(),
                                run_paths.graph_state.clone(),
                            ],
                            output_refs: failure_outputs,
                            budget_delta: None,
                            note: Some(error.to_string()),
                        },
                    )?;
                    return Err(error);
                }
            }
        }

        let Some((_, ())) = mutate_run_state_if_active(repo, &run_paths, |state| {
            state.status = RunStatus::Completed;
            state.current_phase = Some("completed".to_string());
            state.current_node_id = None;
            state.completed_at = Some(chrono::Utc::now().to_rfc3339());
            state.last_updated_at = chrono::Utc::now().to_rfc3339();
            Ok(())
        })?
        else {
            return Ok(build_aborted_run_response(run_id, &run_paths));
        };
        let final_ref = run_paths.outputs_dir.join("final_answer.json");
        let final_output: Value = repo.read_json(&final_ref)?;
        let checkpoint_id = checkpoint_manager
            .get_latest_checkpoint(run_id)
            .await?
            .map(|ckpt| ckpt.checkpoint_id);
        record_trace_event(
            &trace_store,
            None,
            TraceEvent {
                timestamp: chrono::Utc::now().to_rfc3339(),
                run_id: run_id.to_string(),
                node_id: None,
                event_type: "run_completed".to_string(),
                input_refs: vec![run_paths.graph.clone(), run_paths.graph_state.clone()],
                output_refs: vec![
                    run_paths.run_state.clone(),
                    run_paths.graph_state.clone(),
                    run_paths.budget_state.clone(),
                    final_ref.clone(),
                ],
                budget_delta: None,
                note: checkpoint_id.clone(),
            },
        )?;
        Ok(json!({
            "run_id": run_id,
            "status": "completed",
            "checkpoint_id": checkpoint_id,
            "final_output": final_output,
            "artifact_refs": [
                display_path(&run_paths.graph),
                display_path(&run_paths.graph_state),
                display_path(&run_paths.budget_state),
                display_path(&final_ref)
            ]
        }))
    }

    async fn execute_run_dag(
        &self,
        repo: &WorkspaceRepository,
        run_id: &str,
        resume_from_node: Option<String>,
        initial_budget_state: Option<BudgetState>,
    ) -> Result<Value> {
        let run_paths = repo.run_paths(run_id);
        let mut run_manifest: RunManifest = repo.read_json(&run_paths.run_manifest)?;
        let mut graph: ResearchGraph = repo.read_json(&run_paths.graph)?;
        let run_state = read_run_state_locked(repo, &run_paths)?;
        let mut graph_state: GraphState = repo.read_json(&run_paths.graph_state)?;
        let mut budget_state: BudgetState = if let Some(budget_state) = initial_budget_state {
            repo.write_json(&run_paths.budget_state, &budget_state)?;
            budget_state
        } else {
            repo.read_json(&run_paths.budget_state)?
        };

        if matches!(run_state.status, RunStatus::Aborted) {
            return Ok(build_aborted_run_response(run_id, &run_paths));
        }

        // Ready-queue ordering: follow graph.node_order when present.
        let order_index = graph
            .node_order
            .iter()
            .enumerate()
            .map(|(idx, node_id)| (node_id.clone(), idx))
            .collect::<HashMap<_, _>>();
        let default_priority = order_index.len();
        let resume_hint = resume_from_node.clone();
        let priority_key = |node_id: &str| -> (usize, usize, String) {
            let boost = if resume_hint.as_deref() == Some(node_id) {
                0
            } else {
                1
            };
            let base = order_index
                .get(node_id)
                .copied()
                .unwrap_or(default_priority);
            (boost, base, node_id.to_string())
        };

        // Ensure graph_state has an entry for each node.
        for node_id in graph.nodes.keys() {
            graph_state
                .node_states
                .entry(node_id.clone())
                .or_insert(NodeStateEntry {
                    node_id: node_id.clone(),
                    status: NodeWorkspaceStatus::Pending,
                    attempt: 0,
                    checkpoint_ref: None,
                    output_refs: Vec::new(),
                    started_at: None,
                    completed_at: None,
                });
        }

        // Normalize previous snapshot leftovers so we can safely schedule:
        // - Completed nodes remain completed.
        // - Everything else becomes Pending.
        let mut completed = HashSet::new();
        for (node_id, entry) in graph_state.node_states.iter() {
            if matches!(entry.status, NodeWorkspaceStatus::Completed) {
                completed.insert(node_id.clone());
            }
        }

        for (node_id, node) in graph.nodes.iter_mut() {
            if completed.contains(node_id) {
                node.execution_state = NodeExecutionState::Completed;
                continue;
            }

            node.execution_state = NodeExecutionState::Pending;
            node.input_artifacts.clear();
            node.output_artifact = None;
            node.output_refs.clear();
            node.handoff_in_ref = None;
            node.handoff_out_ref = None;
            node.checkpoint_ref = None;
            node.attempt = 0;
            node.budget_consumed = None;
        }
        for (node_id, entry) in graph_state.node_states.iter_mut() {
            if completed.contains(node_id) {
                entry.status = NodeWorkspaceStatus::Completed;
            } else {
                entry.status = NodeWorkspaceStatus::Pending;
                entry.attempt = 0;
                entry.checkpoint_ref = None;
                entry.output_refs.clear();
                entry.started_at = None;
                entry.completed_at = None;
            }
        }
        graph_state.active_nodes.clear();
        graph_state.failed_nodes.clear();
        graph_state.completed_nodes = completed.iter().cloned().collect::<Vec<_>>();
        graph_state.completed_nodes.sort_by_key(|node_id| {
            order_index
                .get(node_id)
                .copied()
                .unwrap_or(default_priority)
        });
        graph_state.updated_at = chrono::Utc::now().to_rfc3339();
        repo.write_json(&run_paths.graph, &graph)?;
        repo.write_json(&run_paths.graph_state, &graph_state)?;

        let max_concurrent_nodes = self.config.paperreader_max_concurrent_nodes.max(1);
        let primary_document_id = run_manifest.root_entity_refs.document_ids.first().cloned();
        let trace_store = TraceStore::new(run_paths.traces_dir.clone());
        let checkpoint_manager = CheckpointManager::new(&run_paths.checkpoints_dir);
        let workspace_root = repo.layout.root.clone();
        let app = self.clone();

        #[derive(Debug, Clone)]
        struct RunningNodeContext {
            node_paths: NodeArtifactPaths,
            input_refs: Vec<PathBuf>,
        }

        let Some((_, ())) = mutate_run_state_if_active(repo, &run_paths, |state| {
            state.status = RunStatus::Running;
            state.current_phase = Some("executing".to_string());
            state.last_updated_at = chrono::Utc::now().to_rfc3339();
            Ok(())
        })?
        else {
            return Ok(build_aborted_run_response(run_id, &run_paths));
        };

        record_trace_event(
            &trace_store,
            None,
            TraceEvent {
                timestamp: chrono::Utc::now().to_rfc3339(),
                run_id: run_id.to_string(),
                node_id: None,
                event_type: "run_started".to_string(),
                input_refs: vec![run_paths.run_manifest.clone(), run_paths.graph.clone()],
                output_refs: vec![
                    run_paths.run_state.clone(),
                    run_paths.graph_state.clone(),
                    run_paths.budget_state.clone(),
                ],
                budget_delta: None,
                note: resume_from_node
                    .as_ref()
                    .map(|node_id| format!("resume_from_node={node_id}")),
            },
        )?;

        // Build dependency index (depends_on is the SSOT for readiness).
        let mut pending = HashSet::new();
        let mut remaining_deps = HashMap::new();
        let mut dependents: HashMap<String, Vec<String>> = HashMap::new();
        for (node_id, node) in graph.nodes.iter() {
            if completed.contains(node_id) {
                continue;
            }
            pending.insert(node_id.clone());
            let mut remaining = 0usize;
            for dep in node.depends_on.iter() {
                if !graph.nodes.contains_key(dep) {
                    anyhow::bail!("node '{}' depends_on missing node '{}'", node_id, dep);
                }
                dependents
                    .entry(dep.clone())
                    .or_default()
                    .push(node_id.clone());
                if !completed.contains(dep) {
                    remaining = remaining.saturating_add(1);
                }
            }
            remaining_deps.insert(node_id.clone(), remaining);
        }

        let mut ready: BTreeSet<(usize, usize, String)> = BTreeSet::new();
        for (node_id, remaining) in remaining_deps.iter() {
            if *remaining == 0 {
                let (boost, base, _) = priority_key(node_id);
                ready.insert((boost, base, node_id.clone()));
            }
        }

        let mut active_nodes: BTreeSet<String> = BTreeSet::new();
        let mut running_nodes: HashSet<String> = HashSet::new();
        let mut running_context: HashMap<String, RunningNodeContext> = HashMap::new();
        let mut join_set: tokio::task::JoinSet<(String, Result<nodes::NodeExecutionArtifact>)> =
            tokio::task::JoinSet::new();

        while !pending.is_empty() {
            while running_nodes.len() < max_concurrent_nodes && !ready.is_empty() {
                let next = ready.iter().next().cloned().context("ready queue empty")?;
                ready.remove(&next);
                let node_id = next.2.clone();

                let persisted_run_state = read_run_state_locked(repo, &run_paths)?;
                if matches!(persisted_run_state.status, RunStatus::Aborted) {
                    join_set.abort_all();
                    return Ok(build_aborted_run_response(run_id, &run_paths));
                }

                let node = graph
                    .nodes
                    .get(&node_id)
                    .cloned()
                    .with_context(|| format!("missing node {node_id}"))?;
                let node_paths = repo.node_paths(&run_manifest.run_id, &node.node_id);
                create_node_directories(&node_paths)?;
                repo.write_json(&node_paths.node_json, &node)?;
                let input_refs = node_input_refs(repo, &run_manifest, &run_paths, &node);
                if let Some(graph_node) = graph.nodes.get_mut(&node_id) {
                    graph_node.input_artifacts =
                        input_refs.iter().map(|path| display_path(path)).collect();
                    graph_node.execution_state = NodeExecutionState::Running;
                }
                write_node_input_manifest(repo, &node_paths, run_id, &node, &input_refs)?;
                let Some((_, ())) = mutate_run_state_if_active(repo, &run_paths, |state| {
                    state.current_node_id = Some(node_id.clone());
                    state.last_updated_at = chrono::Utc::now().to_rfc3339();
                    Ok(())
                })?
                else {
                    join_set.abort_all();
                    return Ok(build_aborted_run_response(run_id, &run_paths));
                };
                if let Some(entry) = graph_state.node_states.get_mut(&node_id) {
                    entry.status = NodeWorkspaceStatus::Running;
                    entry.started_at = Some(chrono::Utc::now().to_rfc3339());
                }

                active_nodes.insert(node_id.clone());
                graph_state.active_nodes = active_nodes.iter().cloned().collect();
                graph_state.updated_at = chrono::Utc::now().to_rfc3339();
                repo.write_json(&run_paths.graph, &graph)?;
                repo.write_json(&run_paths.graph_state, &graph_state)?;
                record_trace_event(
                    &trace_store,
                    Some(&node_paths),
                    TraceEvent {
                        timestamp: chrono::Utc::now().to_rfc3339(),
                        run_id: run_id.to_string(),
                        node_id: Some(node_id.clone()),
                        event_type: "node_started".to_string(),
                        input_refs: input_refs.clone(),
                        output_refs: vec![
                            node_paths.input_manifest.clone(),
                            node_paths.node_json.clone(),
                        ],
                        budget_delta: None,
                        note: Some(format!("{:?}", &node.node_type)),
                    },
                )?;

                running_nodes.insert(node_id.clone());
                running_context.insert(
                    node_id.clone(),
                    RunningNodeContext {
                        node_paths: node_paths.clone(),
                        input_refs: input_refs.clone(),
                    },
                );

                let run_manifest = run_manifest.clone();
                let run_paths = run_paths.clone();
                let primary_document_id = primary_document_id.clone();
                let workspace_root = workspace_root.clone();
                let app = app.clone();
                let node_clone = node.clone();
                let node_paths_task = node_paths.clone();
                let input_refs_task = input_refs.clone();
                join_set.spawn(async move {
                    let result = match BootstrapWorkspace::ensure(workspace_root) {
                        Ok(repo) => {
                            app.execute_node(
                                &repo,
                                &run_manifest,
                                &run_paths,
                                primary_document_id.as_ref(),
                                &node_clone,
                                &node_paths_task,
                                &input_refs_task,
                            )
                            .await
                        }
                        Err(err) => Err(err),
                    };
                    (node_id, result)
                });
            }

            let Some(joined) = join_set.join_next().await else {
                if ready.is_empty() && !pending.is_empty() {
                    anyhow::bail!(
                        "graph execution deadlocked: pending_nodes={}, ready_nodes=0, running_nodes=0",
                        pending.len()
                    );
                }
                continue;
            };

            let (node_id, outcome) = joined.context("failed to join node task")?;
            running_nodes.remove(&node_id);
            active_nodes.remove(&node_id);
            let ctx = running_context
                .remove(&node_id)
                .with_context(|| format!("missing running context for {node_id}"))?;

            graph_state.active_nodes = active_nodes.iter().cloned().collect();

            match outcome {
                Ok(execution) => {
                    pending.remove(&node_id);
                    completed.insert(node_id.clone());

                    if let Some(graph_node) = graph.nodes.get_mut(&node_id) {
                        graph_node.execution_state = NodeExecutionState::Completed;
                        graph_node.output_artifact = Some(display_path(&execution.primary_ref));
                        graph_node.budget_consumed = Some(BudgetConsumed {
                            tokens: execution.tokens_used,
                            llm_calls: 1,
                            elapsed_seconds: execution.elapsed_seconds,
                        });
                    }
                    if let Some(entry) = graph_state.node_states.get_mut(&node_id) {
                        entry.status = NodeWorkspaceStatus::Completed;
                        entry.output_refs = execution.artifact_refs.clone();
                        entry.completed_at = Some(chrono::Utc::now().to_rfc3339());
                    }

                    budget_state.token_budget_used += execution.tokens_used;
                    budget_state.llm_call_budget_used += 1;
                    budget_state.wall_clock_budget_used_seconds += execution.elapsed_seconds;
                    budget_state.updated_at = chrono::Utc::now().to_rfc3339();

                    repo.write_json(&ctx.node_paths.budget, &budget_state)?;
                    if !graph_state.completed_nodes.contains(&node_id) {
                        graph_state.completed_nodes.push(node_id.clone());
                    }
                    graph_state.updated_at = chrono::Utc::now().to_rfc3339();
                    repo.write_json(&run_paths.graph, &graph)?;
                    repo.write_json(&run_paths.graph_state, &graph_state)?;
                    repo.write_json(&run_paths.budget_state, &budget_state)?;

                    let Some((_, ())) = mutate_run_state_if_active(repo, &run_paths, |state| {
                        state.resume_entry = None;
                        state.last_updated_at = chrono::Utc::now().to_rfc3339();
                        Ok(())
                    })?
                    else {
                        join_set.abort_all();
                        return Ok(build_aborted_run_response(run_id, &run_paths));
                    };

                    let checkpoint = checkpoint_manager
                        .create_checkpoint(run_id, &graph, &budget_state)
                        .await?;
                    let checkpoint_path = run_paths
                        .checkpoints_dir
                        .join(format!("{}.json", checkpoint.checkpoint_id));
                    repo.write_json(&ctx.node_paths.checkpoint, &checkpoint)?;
                    if let Some(entry) = graph_state.node_states.get_mut(&node_id) {
                        entry.checkpoint_ref = Some(checkpoint_path.clone());
                    }
                    sync_run_manifest_entry_checkpoint(
                        repo,
                        &run_paths,
                        &mut run_manifest,
                        Some(checkpoint_path.clone()),
                    )?;
                    repo.write_json(&run_paths.graph_state, &graph_state)?;
                    write_node_output_manifest(
                        repo,
                        &ctx.node_paths,
                        run_id,
                        &node_id,
                        "completed",
                        Some(execution.primary_ref.clone()),
                        &execution.artifact_refs,
                        Some(checkpoint_path.clone()),
                    )?;

                    let budget_delta = BudgetConsumed {
                        tokens: execution.tokens_used,
                        llm_calls: 1,
                        elapsed_seconds: execution.elapsed_seconds,
                    };
                    record_trace_event(
                        &trace_store,
                        Some(&ctx.node_paths),
                        TraceEvent {
                            timestamp: chrono::Utc::now().to_rfc3339(),
                            run_id: run_id.to_string(),
                            node_id: Some(node_id.clone()),
                            event_type: "node_completed".to_string(),
                            input_refs: ctx.input_refs.clone(),
                            output_refs: execution.artifact_refs.clone(),
                            budget_delta: Some(budget_delta),
                            note: Some(display_path(&execution.primary_ref)),
                        },
                    )?;
                    record_trace_event(
                        &trace_store,
                        Some(&ctx.node_paths),
                        TraceEvent {
                            timestamp: chrono::Utc::now().to_rfc3339(),
                            run_id: run_id.to_string(),
                            node_id: Some(node_id.clone()),
                            event_type: "checkpoint_created".to_string(),
                            input_refs: vec![ctx.node_paths.output_manifest.clone()],
                            output_refs: vec![
                                checkpoint_path,
                                ctx.node_paths.checkpoint.clone(),
                                ctx.node_paths.budget.clone(),
                            ],
                            budget_delta: None,
                            note: Some(checkpoint.checkpoint_id),
                        },
                    )?;

                    if let Some(children) = dependents.get(&node_id) {
                        for child_id in children {
                            if completed.contains(child_id) {
                                continue;
                            }
                            let Some(remaining) = remaining_deps.get_mut(child_id) else {
                                continue;
                            };
                            if *remaining > 0 {
                                *remaining -= 1;
                            }
                            if *remaining == 0 {
                                let (boost, base, _) = priority_key(child_id);
                                ready.insert((boost, base, child_id.clone()));
                            }
                        }
                    }
                }
                Err(error) => {
                    join_set.abort_all();
                    pending.remove(&node_id);

                    if let Some(graph_node) = graph.nodes.get_mut(&node_id) {
                        graph_node.execution_state = NodeExecutionState::Failed(error.to_string());
                    }
                    if let Some(entry) = graph_state.node_states.get_mut(&node_id) {
                        entry.status = NodeWorkspaceStatus::Failed;
                        entry.completed_at = Some(chrono::Utc::now().to_rfc3339());
                    }
                    graph_state.failed_nodes.push(node_id.clone());
                    active_nodes.clear();
                    graph_state.active_nodes.clear();
                    graph_state.updated_at = chrono::Utc::now().to_rfc3339();
                    repo.write_json(&ctx.node_paths.budget, &budget_state)?;
                    let failure_outputs = if ctx.node_paths.failure.exists() {
                        vec![ctx.node_paths.failure.clone()]
                    } else {
                        Vec::new()
                    };
                    write_node_output_manifest(
                        repo,
                        &ctx.node_paths,
                        run_id,
                        &node_id,
                        "failed",
                        failure_outputs.first().cloned(),
                        &failure_outputs,
                        None,
                    )?;
                    repo.write_json(&run_paths.graph, &graph)?;
                    repo.write_json(&run_paths.graph_state, &graph_state)?;
                    let Some((_, ())) = mutate_run_state_if_active(repo, &run_paths, |state| {
                        state.status = RunStatus::Failed;
                        state.resume_entry = Some(node_id.clone());
                        state.current_phase = Some("failed".to_string());
                        state.last_updated_at = chrono::Utc::now().to_rfc3339();
                        Ok(())
                    })?
                    else {
                        return Ok(build_aborted_run_response(run_id, &run_paths));
                    };
                    record_trace_event(
                        &trace_store,
                        Some(&ctx.node_paths),
                        TraceEvent {
                            timestamp: chrono::Utc::now().to_rfc3339(),
                            run_id: run_id.to_string(),
                            node_id: Some(node_id.clone()),
                            event_type: "node_failed".to_string(),
                            input_refs: ctx.input_refs,
                            output_refs: failure_outputs.clone(),
                            budget_delta: None,
                            note: Some(error.to_string()),
                        },
                    )?;
                    record_trace_event(
                        &trace_store,
                        None,
                        TraceEvent {
                            timestamp: chrono::Utc::now().to_rfc3339(),
                            run_id: run_id.to_string(),
                            node_id: Some(node_id.clone()),
                            event_type: "run_failed".to_string(),
                            input_refs: vec![
                                run_paths.graph.clone(),
                                run_paths.graph_state.clone(),
                            ],
                            output_refs: failure_outputs,
                            budget_delta: None,
                            note: Some(error.to_string()),
                        },
                    )?;
                    return Err(error);
                }
            }
        }

        let Some((_, ())) = mutate_run_state_if_active(repo, &run_paths, |state| {
            state.status = RunStatus::Completed;
            state.current_phase = Some("completed".to_string());
            state.current_node_id = None;
            state.completed_at = Some(chrono::Utc::now().to_rfc3339());
            state.last_updated_at = chrono::Utc::now().to_rfc3339();
            Ok(())
        })?
        else {
            return Ok(build_aborted_run_response(run_id, &run_paths));
        };

        let final_ref = run_paths.outputs_dir.join("final_answer.json");
        let final_output: Value = repo.read_json(&final_ref)?;
        let checkpoint_id = checkpoint_manager
            .get_latest_checkpoint(run_id)
            .await?
            .map(|ckpt| ckpt.checkpoint_id);
        record_trace_event(
            &trace_store,
            None,
            TraceEvent {
                timestamp: chrono::Utc::now().to_rfc3339(),
                run_id: run_id.to_string(),
                node_id: None,
                event_type: "run_completed".to_string(),
                input_refs: vec![run_paths.graph.clone(), run_paths.graph_state.clone()],
                output_refs: vec![
                    run_paths.run_state.clone(),
                    run_paths.graph_state.clone(),
                    run_paths.budget_state.clone(),
                    final_ref.clone(),
                ],
                budget_delta: None,
                note: checkpoint_id.clone(),
            },
        )?;

        Ok(json!({
            "run_id": run_id,
            "status": "completed",
            "checkpoint_id": checkpoint_id,
            "final_output": final_output,
            "artifact_refs": [
                display_path(&run_paths.graph),
                display_path(&run_paths.graph_state),
                display_path(&run_paths.budget_state),
                display_path(&final_ref)
            ]
        }))
    }
}
