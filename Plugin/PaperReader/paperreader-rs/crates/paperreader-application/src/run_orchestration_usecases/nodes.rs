use super::super::*;

impl PaperReaderApplication {
    pub(super) async fn execute_node(
        &self,
        repo: &WorkspaceRepository,
        run_manifest: &RunManifest,
        run_paths: &RunArtifactPaths,
        primary_document_id: Option<&DocumentId>,
        node: &ResearchNode,
        node_paths: &NodeArtifactPaths,
        input_refs: &[PathBuf],
    ) -> Result<NodeExecutionArtifact> {
        let result = match &node.node_type {
            NodeType::Survey => self.execute_survey_node(
                repo,
                run_manifest,
                primary_document_id,
                node_paths,
                &run_manifest.goal,
            ),
            NodeType::Read => {
                self.execute_read_node(
                    repo,
                    run_manifest,
                    run_paths,
                    primary_document_id,
                    node,
                    node_paths,
                    &run_manifest.goal,
                )
                .await
            }
            NodeType::Retrieve => self.execute_retrieve_node(
                repo,
                run_manifest,
                run_paths,
                primary_document_id,
                node,
                node_paths,
                &run_manifest.goal,
            ),
            NodeType::Compare => self.execute_compare_node(repo, run_manifest, node_paths),
            NodeType::AuditConflict => {
                self.execute_conflict_audit_node(repo, run_manifest, node_paths)
            }
            NodeType::Merge => {
                self.execute_merge_node(repo, run_manifest, run_paths, node, node_paths)
            }
            NodeType::Synthesize => {
                self.execute_synthesize_node(
                    repo,
                    run_manifest,
                    run_paths,
                    node_paths,
                    &run_manifest.goal,
                )
                .await
            }
            other => anyhow::bail!("unsupported node type in MVP: {:?}", other),
        };
        match result {
            Ok(value) => Ok(value),
            Err(error) => {
                let failure = FailureArtifact {
                    node_id: node.node_id.clone(),
                    failure_type: FailureType::ValidationFailure,
                    message: error.to_string(),
                    retryable: false,
                    related_input_refs: input_refs.to_vec(),
                    partial_outputs: Vec::new(),
                    suggested_recovery: Some("resume_research_graph".to_string()),
                    timestamp: chrono::Utc::now().to_rfc3339(),
                };
                repo.write_json(&node_paths.failure, &failure)?;
                Err(error)
            }
        }
    }

    fn execute_survey_node(
        &self,
        repo: &WorkspaceRepository,
        run_manifest: &RunManifest,
        primary_document_id: Option<&DocumentId>,
        node_paths: &NodeArtifactPaths,
        goal: &str,
    ) -> Result<NodeExecutionArtifact> {
        let survey = if run_manifest.scope == RunScope::Collection {
            self.survey_collection(&json!({
                "workspace_root": repo.layout.root,
                "collection_id": run_manifest.root_entity_refs.collection_id.as_ref().map(|value| value.0.clone()),
                "document_ids": run_manifest.root_entity_refs.document_ids.iter().map(|value| value.0.clone()).collect::<Vec<_>>(),
                "goal": goal,
            }))?
        } else {
            let document_id =
                primary_document_id.context("document-scoped run is missing document_id")?;
            let document: NormalizedDocument =
                repo.read_json(&repo.document_paths(document_id).normalized_document)?;
            json!({
                "document_id": document_id,
                "title": document.title,
                "goal": goal,
                "highlights": document.outline.iter().take(5).map(|node| node.title.clone()).collect::<Vec<_>>(),
                "summary": snippet(&document.canonical_text),
            })
        };
        repo.write_json(&node_paths.result, &survey)?;
        repo.write_json(
            &node_paths.handoff_out,
            &HandoffArtifact {
                focus_questions: vec![goal.to_string()],
                confirmed_facts: Vec::new(),
                open_questions: Vec::new(),
                must_keep_refs: Vec::new(),
                next_action_hints: vec!["read".to_string(), "retrieve".to_string()],
                created_at: chrono::Utc::now().to_rfc3339(),
            },
        )?;
        Ok(NodeExecutionArtifact::new(
            &node_paths.result,
            120,
            1,
            vec![node_paths.result.clone(), node_paths.handoff_out.clone()],
        ))
    }

    async fn execute_read_node(
        &self,
        repo: &WorkspaceRepository,
        run_manifest: &RunManifest,
        run_paths: &RunArtifactPaths,
        primary_document_id: Option<&DocumentId>,
        node: &ResearchNode,
        node_paths: &NodeArtifactPaths,
        goal: &str,
    ) -> Result<NodeExecutionArtifact> {
        if run_manifest.scope == RunScope::Collection {
            if let Some(document_id) = node_payload_document_id(node) {
                let requested_mode = node_payload_mode(node).unwrap_or("auto");
                let resume_from_state = node_payload_resume_from_state(node);
                let document_result = self
                    .read_document(&json!({
                        "workspace_root": repo.layout.root,
                        "document_id": document_id.0,
                        "goal": goal,
                        "mode": requested_mode,
                        "resume_from_state": resume_from_state,
                    }))
                    .await?;
                let document_paths = repo.document_paths(&document_id);
                let node_result = json!({
                    "document_id": document_id.0,
                    "result": document_result,
                });
                repo.write_json(&node_paths.result, &node_result)?;
                return Ok(NodeExecutionArtifact::new(
                    &node_paths.result,
                    240,
                    1,
                    vec![
                        node_paths.result.clone(),
                        document_paths.reading_state.clone(),
                        document_paths.segment_summaries.clone(),
                        document_paths.handoff.clone(),
                    ],
                ));
            }

            if node.depends_on.iter().any(|dep| dep.starts_with("read_")) {
                let mut fanout_results = Vec::new();
                let mut artifact_refs = vec![node_paths.result.clone()];
                for dep in node.depends_on.iter() {
                    let dep_result_path = run_paths.nodes_dir.join(dep).join("result.json");
                    if dep_result_path.exists() {
                        fanout_results.push(json!({
                            "node_id": dep,
                            "result_ref": display_path(&dep_result_path),
                        }));
                        artifact_refs.push(dep_result_path);
                    }
                }
                for document_id in run_manifest.root_entity_refs.document_ids.iter() {
                    let document_paths = repo.document_paths(document_id);
                    artifact_refs.push(document_paths.reading_state);
                    artifact_refs.push(document_paths.segment_summaries);
                    artifact_refs.push(document_paths.handoff);
                }
                artifact_refs.sort();
                artifact_refs.dedup();
                repo.write_json(
                    &node_paths.result,
                    &json!({
                        "aggregation": "read_fanout",
                        "fanout_count": fanout_results.len(),
                        "items": fanout_results,
                    }),
                )?;
                return Ok(NodeExecutionArtifact::new(
                    &node_paths.result,
                    120,
                    1,
                    artifact_refs,
                ));
            }

            let mut result = Vec::new();
            let mut artifact_refs = vec![node_paths.result.clone()];
            for document_id in run_manifest.root_entity_refs.document_ids.iter() {
                let document_result = self
                    .read_document(&json!({
                        "workspace_root": repo.layout.root,
                        "document_id": document_id.0,
                        "goal": goal,
                        "mode": "auto",
                    }))
                    .await?;
                let document_paths = repo.document_paths(document_id);
                artifact_refs.push(document_paths.reading_state.clone());
                artifact_refs.push(document_paths.segment_summaries.clone());
                artifact_refs.push(document_paths.handoff.clone());
                result.push(document_result);
            }
            repo.write_json(&node_paths.result, &result)?;
            artifact_refs.sort();
            artifact_refs.dedup();
            Ok(NodeExecutionArtifact::new(
                &node_paths.result,
                320,
                2,
                artifact_refs,
            ))
        } else {
            let document_id =
                primary_document_id.context("document-scoped run is missing document_id")?;
            let stage = node_payload_stage(node).unwrap_or("baseline");
            let requested_mode = node_payload_mode(node).unwrap_or_else(|| {
                if stage == "recursive_refine" {
                    "recursive"
                } else {
                    "auto"
                }
            });
            let resume_from_state = if stage == "recursive_refine" {
                node.payload
                    .get("resume_from_state")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(true)
            } else {
                node_payload_resume_from_state(node)
            };
            let result = self
                .read_document(&json!({
                    "workspace_root": repo.layout.root,
                    "document_id": document_id.0,
                    "goal": goal,
                    "mode": requested_mode,
                    "resume_from_state": resume_from_state,
                }))
                .await?;
            let document_paths = repo.document_paths(document_id);
            repo.write_json(&node_paths.result, &result)?;
            let mut artifact_refs = vec![
                node_paths.result.clone(),
                document_paths.reading_state.clone(),
                document_paths.segment_summaries.clone(),
                document_paths.handoff.clone(),
            ];
            if stage == "recursive_refine" {
                artifact_refs.push(document_paths.global_map.clone());
                artifact_refs.push(document_paths.reading_synthesis.clone());
                artifact_refs.push(document_paths.final_report.clone());
            }
            artifact_refs.sort();
            artifact_refs.dedup();
            Ok(NodeExecutionArtifact::new(
                &node_paths.result,
                if stage == "recursive_refine" {
                    420
                } else {
                    320
                },
                if stage == "recursive_refine" { 3 } else { 2 },
                artifact_refs,
            ))
        }
    }

    fn execute_retrieve_node(
        &self,
        repo: &WorkspaceRepository,
        run_manifest: &RunManifest,
        run_paths: &RunArtifactPaths,
        primary_document_id: Option<&DocumentId>,
        node: &ResearchNode,
        node_paths: &NodeArtifactPaths,
        goal: &str,
    ) -> Result<NodeExecutionArtifact> {
        if run_manifest.scope == RunScope::Collection {
            if let Some(document_id) = node_payload_document_id(node) {
                let result = self.retrieve_evidence_value(&json!({
                    "workspace_root": repo.layout.root,
                    "document_id": document_id.0,
                    "query_text": goal,
                }))?;
                let document_paths = repo.document_paths(&document_id);
                repo.write_json(
                    &node_paths.result,
                    &json!({
                        "document_id": document_id.0,
                        "result": result,
                    }),
                )?;
                return Ok(NodeExecutionArtifact::new(
                    &node_paths.result,
                    140,
                    1,
                    vec![
                        node_paths.result.clone(),
                        document_paths.retrieval_request.clone(),
                        document_paths.retrieval_hits.clone(),
                        document_paths.evidence_pack.clone(),
                    ],
                ));
            }

            if node
                .depends_on
                .iter()
                .any(|dep| dep.starts_with("retrieve_"))
            {
                let collection_id = run_manifest
                    .root_entity_refs
                    .collection_id
                    .as_ref()
                    .context("collection-scoped run is missing collection_id")?;
                let collection_result = self.build_evidence_pack(&json!({
                    "workspace_root": repo.layout.root,
                    "collection_id": collection_id.0,
                    "document_ids": run_manifest.root_entity_refs.document_ids.iter().map(|value| value.0.clone()).collect::<Vec<_>>(),
                    "query_text": goal,
                }))?;
                let collection_paths = repo.collection_paths(collection_id);
                let mut fanout_results = Vec::new();
                let mut artifact_refs = vec![
                    node_paths.result.clone(),
                    collection_paths.evidence_pack_latest,
                ];
                for dep in node.depends_on.iter() {
                    let dep_result_path = run_paths.nodes_dir.join(dep).join("result.json");
                    if dep_result_path.exists() {
                        fanout_results.push(json!({
                            "node_id": dep,
                            "result_ref": display_path(&dep_result_path),
                        }));
                        artifact_refs.push(dep_result_path);
                    }
                }
                for document_id in run_manifest.root_entity_refs.document_ids.iter() {
                    let document_paths = repo.document_paths(document_id);
                    artifact_refs.push(document_paths.retrieval_request);
                    artifact_refs.push(document_paths.retrieval_hits);
                    artifact_refs.push(document_paths.evidence_pack);
                }
                artifact_refs.sort();
                artifact_refs.dedup();
                repo.write_json(
                    &node_paths.result,
                    &json!({
                        "aggregation": "retrieve_fanout",
                        "fanout_count": fanout_results.len(),
                        "items": fanout_results,
                        "collection_pack": collection_result,
                    }),
                )?;
                return Ok(NodeExecutionArtifact::new(
                    &node_paths.result,
                    180,
                    1,
                    artifact_refs,
                ));
            }

            let result = self.build_evidence_pack(&json!({
                "workspace_root": repo.layout.root,
                "collection_id": run_manifest.root_entity_refs.collection_id.as_ref().map(|value| value.0.clone()),
                "document_ids": run_manifest.root_entity_refs.document_ids.iter().map(|value| value.0.clone()).collect::<Vec<_>>(),
                "query_text": goal,
            }))?;
            let collection_id = run_manifest
                .root_entity_refs
                .collection_id
                .as_ref()
                .context("collection-scoped run is missing collection_id")?;
            let collection_paths = repo.collection_paths(collection_id);
            repo.write_json(&node_paths.result, &result)?;
            Ok(NodeExecutionArtifact::new(
                &node_paths.result,
                180,
                1,
                vec![
                    node_paths.result.clone(),
                    collection_paths.evidence_pack_latest.clone(),
                ],
            ))
        } else {
            let document_id =
                primary_document_id.context("document-scoped run is missing document_id")?;
            let result = self.retrieve_evidence_value(&json!({
                "workspace_root": repo.layout.root,
                "document_id": document_id.0,
                "query_text": goal,
            }))?;
            let document_paths = repo.document_paths(document_id);
            repo.write_json(&node_paths.result, &result)?;
            Ok(NodeExecutionArtifact::new(
                &node_paths.result,
                180,
                1,
                vec![
                    node_paths.result.clone(),
                    document_paths.retrieval_request.clone(),
                    document_paths.retrieval_hits.clone(),
                    document_paths.evidence_pack.clone(),
                ],
            ))
        }
    }

    fn execute_compare_node(
        &self,
        repo: &WorkspaceRepository,
        run_manifest: &RunManifest,
        node_paths: &NodeArtifactPaths,
    ) -> Result<NodeExecutionArtifact> {
        let collection_id = run_manifest
            .root_entity_refs
            .collection_id
            .as_ref()
            .context("collection-scoped run is missing collection_id")?;
        let result = self.compare_documents(&json!({
            "workspace_root": repo.layout.root,
            "collection_id": collection_id.0,
            "document_ids": run_manifest.root_entity_refs.document_ids.iter().map(|value| value.0.clone()).collect::<Vec<_>>(),
        }))?;
        let collection_paths = repo.collection_paths(collection_id);
        repo.write_json(&node_paths.result, &result)?;
        repo.write_json(
            &node_paths.handoff_out,
            &HandoffArtifact {
                focus_questions: vec![run_manifest.goal.clone()],
                confirmed_facts: Vec::new(),
                open_questions: Vec::new(),
                must_keep_refs: Vec::new(),
                next_action_hints: vec!["conflict_audit".to_string(), "merge".to_string()],
                created_at: chrono::Utc::now().to_rfc3339(),
            },
        )?;
        Ok(NodeExecutionArtifact::new(
            &node_paths.result,
            160,
            1,
            vec![
                node_paths.result.clone(),
                node_paths.handoff_out.clone(),
                collection_paths.comparison_table_latest.clone(),
            ],
        ))
    }

    fn execute_conflict_audit_node(
        &self,
        repo: &WorkspaceRepository,
        run_manifest: &RunManifest,
        node_paths: &NodeArtifactPaths,
    ) -> Result<NodeExecutionArtifact> {
        let collection_id = run_manifest
            .root_entity_refs
            .collection_id
            .as_ref()
            .context("collection-scoped run is missing collection_id")?;
        let result = self.audit_collection_conflicts(&json!({
            "workspace_root": repo.layout.root,
            "collection_id": collection_id.0,
            "document_ids": run_manifest.root_entity_refs.document_ids.iter().map(|value| value.0.clone()).collect::<Vec<_>>(),
            "goal": run_manifest.goal,
        }))?;
        let collection_paths = repo.collection_paths(collection_id);
        repo.write_json(&node_paths.result, &result)?;
        repo.write_json(
            &node_paths.handoff_out,
            &HandoffArtifact {
                focus_questions: vec![run_manifest.goal.clone()],
                confirmed_facts: Vec::new(),
                open_questions: Vec::new(),
                must_keep_refs: Vec::new(),
                next_action_hints: vec!["merge".to_string()],
                created_at: chrono::Utc::now().to_rfc3339(),
            },
        )?;
        Ok(NodeExecutionArtifact::new(
            &node_paths.result,
            140,
            1,
            vec![
                node_paths.result.clone(),
                node_paths.handoff_out.clone(),
                collection_paths.aligned_claims_latest.clone(),
                collection_paths.conflict_report_latest.clone(),
            ],
        ))
    }

    fn execute_merge_node(
        &self,
        repo: &WorkspaceRepository,
        run_manifest: &RunManifest,
        run_paths: &RunArtifactPaths,
        node: &ResearchNode,
        node_paths: &NodeArtifactPaths,
    ) -> Result<NodeExecutionArtifact> {
        let merge_path = run_paths.merges_dir.join("single_document_merge.json");
        let merge = MergeArtifact {
            merge_id: format!("merge-{}", chrono::Utc::now().timestamp()),
            input_node_ids: if run_manifest.scope == RunScope::Collection {
                let mut inputs = vec![
                    "survey".to_string(),
                    "read".to_string(),
                    "retrieve".to_string(),
                    "compare".to_string(),
                    "conflict_audit".to_string(),
                ];
                for index in 0..run_manifest.root_entity_refs.document_ids.len() {
                    inputs.push(format!("read_{index}"));
                    inputs.push(format!("retrieve_{index}"));
                }
                inputs
            } else {
                if node.depends_on.is_empty() {
                    vec![
                        "survey".to_string(),
                        "read".to_string(),
                        "retrieve".to_string(),
                    ]
                } else {
                    node.depends_on.clone()
                }
            },
            merge_decisions: vec![MergeDecision {
                decision_id: "merge-1".to_string(),
                source_node_id: if run_manifest.scope == RunScope::Collection {
                    "compare".to_string()
                } else {
                    node.depends_on
                        .iter()
                        .rev()
                        .find(|dep| dep.starts_with("read"))
                        .cloned()
                        .unwrap_or_else(|| "read".to_string())
                },
                decision_type: MergeDecisionType::Absorbed,
                reason: if run_manifest.scope == RunScope::Collection {
                    "Collection-scope merge consumes compare, conflict_audit, and evidence-pack outputs before synthesis."
                        .to_string()
                } else {
                    "Single-document merge keeps the run handoff explicit.".to_string()
                },
                affected_claims: Vec::new(),
            }],
            unresolved_conflicts: Vec::new(),
            merged_handoff: HandoffArtifact {
                focus_questions: vec!["merge downstream evidence".to_string()],
                confirmed_facts: Vec::new(),
                open_questions: Vec::new(),
                must_keep_refs: Vec::new(),
                next_action_hints: vec!["synthesize".to_string()],
                created_at: chrono::Utc::now().to_rfc3339(),
            },
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        repo.write_json(&merge_path, &merge)?;
        repo.write_json(
            &node_paths.result,
            &json!({ "merge_ref": display_path(&merge_path) }),
        )?;
        Ok(NodeExecutionArtifact::new(
            &node_paths.result,
            80,
            1,
            vec![merge_path.clone(), node_paths.result.clone()],
        ))
    }

    async fn execute_synthesize_node(
        &self,
        repo: &WorkspaceRepository,
        run_manifest: &RunManifest,
        run_paths: &RunArtifactPaths,
        node_paths: &NodeArtifactPaths,
        goal: &str,
    ) -> Result<NodeExecutionArtifact> {
        let final_answer = if run_manifest.scope == RunScope::Collection {
            let collection_id = run_manifest
                .root_entity_refs
                .collection_id
                .as_ref()
                .context("missing collection id")?;
            let synthesis = self
                .synthesize_collection(&json!({
                    "workspace_root": repo.layout.root,
                    "collection_id": collection_id.0,
                    "document_ids": run_manifest.root_entity_refs.document_ids.iter().map(|value| value.0.clone()).collect::<Vec<_>>(),
                    "goal": goal,
                    "mode": "synthesis",
                }))
                .await?;
            json!({
                "goal": goal,
                "summary": "Collection-scope synthesis completed.",
                "collection_id": collection_id,
                "artifact_refs": synthesis["artifact_refs"].clone(),
                "synthesis": synthesis,
            })
        } else {
            let document_id = run_manifest
                .root_entity_refs
                .document_ids
                .first()
                .context("missing document id")?;
            let document_paths = repo.document_paths(document_id);
            let evidence_pack: Value = repo.read_json(&document_paths.evidence_pack)?;
            json!({
                "goal": goal,
                "summary": "Single-document synthesis completed.",
                "evidence_pack_ref": display_path(&document_paths.evidence_pack),
                "reading_state_ref": display_path(&document_paths.reading_state),
                "artifact_refs": [
                    display_path(&run_paths.graph),
                    display_path(&run_paths.graph_state),
                    display_path(&run_paths.budget_state),
                    display_path(&document_paths.evidence_pack)
                ],
                "evidence_preview": evidence_pack,
            })
        };
        let output_path = run_paths.outputs_dir.join("final_answer.json");
        repo.write_json(&output_path, &final_answer)?;
        repo.write_json(&node_paths.result, &final_answer)?;
        Ok(NodeExecutionArtifact::new(
            &output_path,
            220,
            1,
            vec![output_path.clone(), node_paths.result.clone()],
        ))
    }
}

#[derive(Debug, Clone)]
pub(super) struct NodeExecutionArtifact {
    pub(super) primary_ref: PathBuf,
    pub(super) artifact_refs: Vec<PathBuf>,
    pub(super) tokens_used: u64,
    pub(super) elapsed_seconds: u64,
}

impl NodeExecutionArtifact {
    fn new(
        primary_ref: &Path,
        tokens_used: u64,
        elapsed_seconds: u64,
        artifact_refs: Vec<PathBuf>,
    ) -> Self {
        Self {
            primary_ref: primary_ref.to_path_buf(),
            artifact_refs,
            tokens_used,
            elapsed_seconds,
        }
    }
}

fn node_payload_document_id(node: &ResearchNode) -> Option<DocumentId> {
    node.payload
        .get("document_id")
        .and_then(|value| value.as_str())
        .map(|value| DocumentId::new(value.to_string()))
}

fn node_payload_stage<'a>(node: &'a ResearchNode) -> Option<&'a str> {
    node.payload.get("stage").and_then(|value| value.as_str())
}

fn node_payload_mode<'a>(node: &'a ResearchNode) -> Option<&'a str> {
    node.payload.get("mode").and_then(|value| value.as_str())
}

fn node_payload_resume_from_state(node: &ResearchNode) -> bool {
    node.payload
        .get("resume_from_state")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}
