use super::*;

impl PaperReaderApplication {
    pub async fn read_document(&self, payload: &Value) -> Result<Value> {
        let repo = BootstrapWorkspace::ensure(self.resolve_workspace_root(payload))?;
        let document_id = DocumentId::new(required_string(payload, "document_id")?);
        let document_paths = repo.document_paths(&document_id);
        if requested_resume_from_state(payload)
            && !payload_flag(payload, "force_reread")
            && document_paths.reading_state.exists()
        {
            return self.resume_read(payload).await;
        }
        let goal =
            payload_string(payload, "goal").unwrap_or_else(|| "Summarize the document".to_string());
        let requested_mode = requested_read_mode(payload).unwrap_or_else(|| "auto".to_string());
        let constraints = requested_constraints(payload);
        self.read_document_core(
            &repo,
            &document_id,
            &document_paths,
            goal,
            requested_mode,
            constraints,
        )
        .await
    }

    async fn read_document_core(
        &self,
        repo: &WorkspaceRepository,
        document_id: &DocumentId,
        document_paths: &paperreader_workspace::DocumentArtifactPaths,
        goal: String,
        requested_mode: String,
        constraints: Vec<String>,
    ) -> Result<Value> {
        let segment_set: SegmentSet = repo.read_json(&document_paths.segment_set)?;

        let attention_plan = build_attention_plan(&segment_set, &goal);
        let mut selected =
            select_segments_for_request(&segment_set, &attention_plan, &requested_mode);
        if selected.len() > self.config.paperreader_max_chunks {
            selected.truncate(self.config.paperreader_max_chunks);
        }
        let mut read_log = Vec::new();
        let mut segment_summaries = HashMap::new();
        let mut confirmed_facts = Vec::new();
        let mut open_questions = Vec::new();
        let mut evidence_refs = Vec::new();

        let batch_size = self.config.paperreader_batch_size.max(1);
        let mut cursor = 0usize;
        while cursor < selected.len() {
            let batch_end = (cursor + batch_size).min(selected.len());
            let batch = selected[cursor..batch_end].to_vec();
            let base_index = cursor;
            let context_snapshot = build_reading_context_snapshot(
                &segment_summaries,
                self.config.paperreader_rolling_context_max_entries,
                self.config.paperreader_rolling_context_max_chars,
            );

            let mut join_set = tokio::task::JoinSet::new();
            for (offset, segment) in batch.into_iter().enumerate() {
                let llm_client = self.llm_client.clone();
                let goal = goal.clone();
                let requested_mode = requested_mode.clone();
                let context = context_snapshot.clone();
                let absolute_index = base_index + offset;

                join_set.spawn(async move {
                    let depth = Some(reading_depth_for_request(&requested_mode, absolute_index));
                    let reader = SegmentReader::new(llm_client);
                    let reading = reader
                        .read_segment_with_context(&segment, &goal, depth, &context)
                        .await;
                    (absolute_index, segment, reading)
                });
            }

            let mut batch_results = Vec::new();
            while let Some(joined) = join_set.join_next().await {
                let (index, segment, reading) = joined.context("failed to join segment task")?;
                batch_results.push((index, segment, reading?));
            }

            batch_results.sort_by_key(|(index, _, _)| *index);
            for (index, segment, reading) in batch_results {
                segment_summaries.insert(segment.segment_id.0.clone(), reading.summary.clone());
                evidence_refs.extend(reading.evidence_refs.clone());
                confirmed_facts.extend(reading.claims.iter().map(|claim| {
                    paperreader_workspace::ConfirmedFact {
                        fact_id: claim.claim_id.clone(),
                        text: claim.text.clone(),
                        confidence: claim.confidence,
                        evidence_refs: reading.evidence_refs.clone(),
                    }
                }));
                open_questions.extend(reading.open_questions.iter().map(|question| OpenQuestion {
                    question_id: question.question_id.clone(),
                    text: question.question.clone(),
                    priority: question.priority,
                    related_segments: vec![segment.segment_id.clone()],
                }));
                read_log.push(ReadLogEntry {
                    entry_id: format!("read-log-{}", index + 1),
                    segment_id: segment.segment_id.clone(),
                    mode: attention_mode_for_segment(&attention_plan, &segment.segment_id),
                    round: 1,
                    summary: reading.summary,
                    timestamp: chrono::Utc::now().to_rfc3339(),
                });
            }

            cursor = batch_end;
        }

        let rolling_context = compose_rolling_context_limited(
            &segment_summaries,
            self.config.paperreader_rolling_context_max_entries,
            self.config.paperreader_rolling_context_max_chars,
        );

        let mut recursive_artifact_refs = Vec::new();
        let global_map_md = if requested_mode == "recursive" {
            let built = build_recursive_global_map(
                repo,
                document_paths,
                self.llm_client.clone(),
                &goal,
                &segment_summaries,
                &self.config,
            )
            .await?;
            recursive_artifact_refs = built.artifact_refs.clone();
            built.global_map_markdown
        } else {
            build_shallow_global_map_markdown(&segment_summaries, &goal)
        };

        let final_report_md = build_final_report_markdown(
            document_id,
            &goal,
            &requested_mode,
            &constraints,
            &global_map_md,
            &rolling_context,
            &confirmed_facts,
            &open_questions,
        );

        let handoff = HandoffArtifact {
            focus_questions: vec![goal.clone()],
            confirmed_facts,
            open_questions,
            must_keep_refs: evidence_refs.clone(),
            next_action_hints: vec!["retrieve_evidence".to_string(), "plan_research".to_string()],
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        let audit_report = AuditReport {
            report_id: format!("audit-{}", document_id.0),
            findings: if evidence_refs.is_empty() {
                vec![AuditFinding {
                    finding_id: format!("audit-finding-{}", document_id.0),
                    severity: AuditSeverity::Info,
                    description: "No explicit evidence refs were extracted during read_document."
                        .to_string(),
                    evidence_refs: Vec::new(),
                    recommendation:
                        "Run retrieve_evidence or audit_document for stronger traceability."
                            .to_string(),
                }]
            } else if !constraints.is_empty() {
                vec![AuditFinding {
                    finding_id: format!("audit-constraints-{}", document_id.0),
                    severity: AuditSeverity::Info,
                    description: format!(
                        "Read completed with caller constraints: {}",
                        constraints.join(", ")
                    ),
                    evidence_refs: evidence_refs.clone(),
                    recommendation: "Use trace_claim_in_document or retrieve_evidence to validate the constrained output.".to_string(),
                }]
            } else {
                Vec::new()
            },
            overall_assessment: "baseline_read_audit".to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        let reading_state = paperreader_domain::ReadingState {
            document_id: document_id.clone(),
            goal: goal.clone(),
            requested_mode: Some(requested_mode.clone()),
            constraints: constraints.clone(),
            current_phase: ReadingPhase::Synthesize,
            attention_plan: Some(attention_plan.clone()),
            read_log,
            global_map: Some(global_map_md.clone()),
            rolling_context: Some(rolling_context.clone()),
            segment_summaries: segment_summaries
                .iter()
                .map(|(segment_id, summary)| (SegmentId::new(segment_id.clone()), summary.clone()))
                .collect(),
            audit_report: Some(audit_report.clone()),
            round: 1,
            created_at: chrono::Utc::now().to_rfc3339(),
            updated_at: chrono::Utc::now().to_rfc3339(),
        };

        repo.write_json(&document_paths.attention_plan, &attention_plan)?;
        repo.write_json(&document_paths.reading_state, &reading_state)?;
        repo.write_json(&document_paths.segment_summaries, &segment_summaries)?;
        repo.write_markdown(&document_paths.global_map, &global_map_md)?;
        repo.write_markdown(&document_paths.reading_synthesis, &final_report_md)?;
        repo.write_markdown(&document_paths.final_report, &final_report_md)?;
        repo.write_json(&document_paths.handoff, &handoff)?;
        repo.write_json(&document_paths.audit_report, &audit_report)?;
        Ok(json!({
            "document_id": document_id,
            "goal": goal,
            "mode": requested_mode,
            "constraints": constraints,
            "attention_plan_ref": display_path(&document_paths.attention_plan),
            "reading_state_ref": display_path(&document_paths.reading_state),
            "segment_summaries_ref": display_path(&document_paths.segment_summaries),
            "global_map_ref": display_path(&document_paths.global_map),
            "synthesis_ref": display_path(&document_paths.reading_synthesis),
            "final_report_ref": display_path(&document_paths.final_report),
            "handoff_ref": display_path(&document_paths.handoff),
            "audit_report_ref": display_path(&document_paths.audit_report),
            "recursive_artifact_refs": recursive_artifact_refs,
            "artifact_refs": [
                display_path(&document_paths.attention_plan),
                display_path(&document_paths.reading_state),
                display_path(&document_paths.segment_summaries),
                display_path(&document_paths.global_map),
                display_path(&document_paths.reading_synthesis),
                display_path(&document_paths.final_report),
                display_path(&document_paths.handoff),
                display_path(&document_paths.audit_report)
            ]
        }))
    }

    pub async fn resume_read(&self, payload: &Value) -> Result<Value> {
        let repo = BootstrapWorkspace::ensure(self.resolve_workspace_root(payload))?;
        let document_id = DocumentId::new(required_string(payload, "document_id")?);
        let document_paths = repo.document_paths(&document_id);
        let segment_set: SegmentSet = repo.read_json(&document_paths.segment_set)?;

        if !document_paths.reading_state.exists() {
            let goal = payload_string(payload, "goal")
                .unwrap_or_else(|| "Summarize the document".to_string());
            let requested_mode = requested_read_mode(payload).unwrap_or_else(|| "auto".to_string());
            let constraints = requested_constraints(payload);
            return self
                .read_document_core(
                    &repo,
                    &document_id,
                    &document_paths,
                    goal,
                    requested_mode,
                    constraints,
                )
                .await;
        }

        let mut reading_state: paperreader_domain::ReadingState =
            repo.read_json(&document_paths.reading_state)?;
        let goal = payload_string(payload, "goal").unwrap_or_else(|| reading_state.goal.clone());
        let requested_mode = requested_read_mode(payload).unwrap_or_else(|| {
            reading_state
                .requested_mode
                .clone()
                .unwrap_or_else(|| "auto".to_string())
        });
        let constraints = if payload.get("constraints").is_some() {
            requested_constraints(payload)
        } else {
            reading_state.constraints.clone()
        };
        let attention_plan = build_attention_plan(&segment_set, &goal);
        let selected = select_segments_for_request(&segment_set, &attention_plan, &requested_mode);
        let mut segment_summaries: HashMap<String, String> =
            if document_paths.segment_summaries.exists() {
                repo.read_json(&document_paths.segment_summaries)?
            } else {
                HashMap::new()
            };

        let mut to_read = selected
            .into_iter()
            .filter(|segment| !segment_summaries.contains_key(&segment.segment_id.0))
            .collect::<Vec<_>>();

        let remaining_budget = self
            .config
            .paperreader_max_chunks
            .saturating_sub(segment_summaries.len());
        if to_read.len() > remaining_budget {
            to_read.truncate(remaining_budget);
        }

        let now = chrono::Utc::now().to_rfc3339();
        let round = reading_state.round.saturating_add(1);
        let start_index = reading_state.read_log.len();
        let mut read_log = reading_state.read_log.clone();
        let mut confirmed_facts = Vec::new();
        let mut open_questions = Vec::new();
        let mut evidence_refs = Vec::new();

        let batch_size = self.config.paperreader_batch_size.max(1);
        let mut cursor = 0usize;
        while cursor < to_read.len() {
            let batch_end = (cursor + batch_size).min(to_read.len());
            let batch = to_read[cursor..batch_end].to_vec();
            let base_index = cursor;
            let context_snapshot = build_reading_context_snapshot(
                &segment_summaries,
                self.config.paperreader_rolling_context_max_entries,
                self.config.paperreader_rolling_context_max_chars,
            );

            let mut join_set = tokio::task::JoinSet::new();
            for (offset, segment) in batch.into_iter().enumerate() {
                let llm_client = self.llm_client.clone();
                let goal = goal.clone();
                let requested_mode = requested_mode.clone();
                let context = context_snapshot.clone();
                let read_index = base_index + offset;

                join_set.spawn(async move {
                    let depth = Some(reading_depth_for_request(
                        &requested_mode,
                        start_index + read_index,
                    ));
                    let reader = SegmentReader::new(llm_client);
                    let reading = reader
                        .read_segment_with_context(&segment, &goal, depth, &context)
                        .await;
                    (read_index, segment, reading)
                });
            }

            let mut batch_results = Vec::new();
            while let Some(joined) = join_set.join_next().await {
                let (read_index, segment, reading) =
                    joined.context("failed to join segment task")?;
                batch_results.push((read_index, segment, reading?));
            }

            batch_results.sort_by_key(|(index, _, _)| *index);
            for (read_index, segment, reading) in batch_results {
                segment_summaries.insert(segment.segment_id.0.clone(), reading.summary.clone());
                evidence_refs.extend(reading.evidence_refs.clone());
                confirmed_facts.extend(reading.claims.iter().map(|claim| {
                    paperreader_workspace::ConfirmedFact {
                        fact_id: claim.claim_id.clone(),
                        text: claim.text.clone(),
                        confidence: claim.confidence,
                        evidence_refs: reading.evidence_refs.clone(),
                    }
                }));
                open_questions.extend(reading.open_questions.iter().map(|question| OpenQuestion {
                    question_id: question.question_id.clone(),
                    text: question.question.clone(),
                    priority: question.priority,
                    related_segments: vec![segment.segment_id.clone()],
                }));
                read_log.push(ReadLogEntry {
                    entry_id: format!("read-log-{}", start_index + read_index + 1),
                    segment_id: segment.segment_id.clone(),
                    mode: attention_mode_for_segment(&attention_plan, &segment.segment_id),
                    round,
                    summary: reading.summary,
                    timestamp: chrono::Utc::now().to_rfc3339(),
                });
            }

            cursor = batch_end;
        }

        let mut handoff: HandoffArtifact = if document_paths.handoff.exists() {
            repo.read_json(&document_paths.handoff)?
        } else {
            HandoffArtifact {
                focus_questions: Vec::new(),
                confirmed_facts: Vec::new(),
                open_questions: Vec::new(),
                must_keep_refs: Vec::new(),
                next_action_hints: Vec::new(),
                created_at: now.clone(),
            }
        };

        if !handoff.focus_questions.iter().any(|q| q == &goal) {
            handoff.focus_questions.push(goal.clone());
        }

        let mut seen_facts: HashSet<String> = handoff
            .confirmed_facts
            .iter()
            .map(|fact| fact.fact_id.clone())
            .collect();
        for fact in confirmed_facts {
            if seen_facts.insert(fact.fact_id.clone()) {
                handoff.confirmed_facts.push(fact);
            }
        }

        let mut seen_questions: HashSet<String> = handoff
            .open_questions
            .iter()
            .map(|q| q.question_id.clone())
            .collect();
        for question in open_questions {
            if seen_questions.insert(question.question_id.clone()) {
                handoff.open_questions.push(question);
            }
        }

        handoff.must_keep_refs.extend(evidence_refs);
        handoff.next_action_hints = vec![
            "retrieve_evidence".to_string(),
            "audit_document".to_string(),
            "trace_claim_in_document".to_string(),
        ];
        handoff.created_at = now.clone();

        let rolling_context = compose_rolling_context_limited(
            &segment_summaries,
            self.config.paperreader_rolling_context_max_entries,
            self.config.paperreader_rolling_context_max_chars,
        );

        let mut recursive_artifact_refs = Vec::new();
        let global_map_md = if requested_mode == "recursive" {
            let built = build_recursive_global_map(
                &repo,
                &document_paths,
                self.llm_client.clone(),
                &goal,
                &segment_summaries,
                &self.config,
            )
            .await?;
            recursive_artifact_refs = built.artifact_refs.clone();
            built.global_map_markdown
        } else {
            build_shallow_global_map_markdown(&segment_summaries, &goal)
        };

        let final_report_md = build_final_report_markdown(
            &document_id,
            &goal,
            &requested_mode,
            &constraints,
            &global_map_md,
            &rolling_context,
            &handoff.confirmed_facts,
            &handoff.open_questions,
        );

        reading_state.goal = goal.clone();
        reading_state.requested_mode = Some(requested_mode.clone());
        reading_state.constraints = constraints.clone();
        reading_state.current_phase = ReadingPhase::Synthesize;
        reading_state.attention_plan = Some(attention_plan.clone());
        reading_state.read_log = read_log;
        reading_state.global_map = Some(global_map_md.clone());
        reading_state.rolling_context = Some(rolling_context.clone());
        reading_state.segment_summaries = segment_summaries
            .iter()
            .map(|(segment_id, summary)| (SegmentId::new(segment_id.clone()), summary.clone()))
            .collect();
        reading_state.round = round;
        reading_state.updated_at = now.clone();

        repo.write_json(&document_paths.attention_plan, &attention_plan)?;
        repo.write_json(&document_paths.reading_state, &reading_state)?;
        repo.write_json(&document_paths.segment_summaries, &segment_summaries)?;
        repo.write_markdown(&document_paths.global_map, &global_map_md)?;
        repo.write_markdown(&document_paths.reading_synthesis, &final_report_md)?;
        repo.write_markdown(&document_paths.final_report, &final_report_md)?;
        repo.write_json(&document_paths.handoff, &handoff)?;

        Ok(json!({
            "document_id": document_id,
            "goal": goal,
            "mode": requested_mode,
            "constraints": constraints,
            "round": reading_state.round,
            "segments_read": to_read.len(),
            "attention_plan_ref": display_path(&document_paths.attention_plan),
            "reading_state_ref": display_path(&document_paths.reading_state),
            "segment_summaries_ref": display_path(&document_paths.segment_summaries),
            "global_map_ref": display_path(&document_paths.global_map),
            "synthesis_ref": display_path(&document_paths.reading_synthesis),
            "final_report_ref": display_path(&document_paths.final_report),
            "handoff_ref": display_path(&document_paths.handoff),
            "recursive_artifact_refs": recursive_artifact_refs,
            "artifact_refs": [
                display_path(&document_paths.attention_plan),
                display_path(&document_paths.reading_state),
                display_path(&document_paths.segment_summaries),
                display_path(&document_paths.global_map),
                display_path(&document_paths.reading_synthesis),
                display_path(&document_paths.final_report),
                display_path(&document_paths.handoff)
            ]
        }))
    }

    pub fn audit_document(&self, payload: &Value) -> Result<Value> {
        let repo = BootstrapWorkspace::ensure(self.resolve_workspace_root(payload))?;
        let document_id = DocumentId::new(required_string(payload, "document_id")?);
        let document_paths = repo.document_paths(&document_id);
        let mut reading_state: paperreader_domain::ReadingState =
            repo.read_json(&document_paths.reading_state)?;
        let handoff: HandoffArtifact = repo.read_json(&document_paths.handoff)?;
        let now = chrono::Utc::now().to_rfc3339();

        let mut findings = Vec::new();
        if handoff.confirmed_facts.is_empty() {
            findings.push(AuditFinding {
                finding_id: "audit-finding-no-confirmed-facts".to_string(),
                severity: AuditSeverity::Medium,
                description: "No confirmed facts were extracted during read_document.".to_string(),
                evidence_refs: handoff.must_keep_refs.clone(),
                recommendation:
                    "Run read_document with a more specific goal or deeper focus on key sections."
                        .to_string(),
            });
        }
        if !handoff.open_questions.is_empty() {
            let sample = handoff
                .open_questions
                .iter()
                .take(5)
                .map(|q| q.text.clone())
                .collect::<Vec<_>>()
                .join(" | ");
            findings.push(AuditFinding {
                finding_id: "audit-finding-open-questions".to_string(),
                severity: AuditSeverity::Info,
                description: format!(
                    "There are {} open questions pending resolution. Sample: {sample}",
                    handoff.open_questions.len()
                ),
                evidence_refs: handoff.must_keep_refs.clone(),
                recommendation: "Use retrieve_evidence to gather supporting citations and then trace_claim_in_document on key hypotheses.".to_string(),
            });
        }
        for fact in handoff
            .confirmed_facts
            .iter()
            .filter(|f| f.confidence < 0.6)
            .take(10)
        {
            findings.push(AuditFinding {
                finding_id: format!("audit-finding-low-confidence-{}", fact.fact_id),
                severity: AuditSeverity::Low,
                description: format!(
                    "Low confidence fact detected (confidence {:.2}): {}",
                    fact.confidence, fact.text
                ),
                evidence_refs: fact.evidence_refs.clone(),
                recommendation:
                    "Trace the claim and retrieve more evidence; consider marking as uncertain in synthesis.".to_string(),
            });
        }
        if !document_paths.evidence_pack.exists() {
            findings.push(AuditFinding {
                finding_id: "audit-finding-missing-evidence-pack".to_string(),
                severity: AuditSeverity::Info,
                description:
                    "No evidence_pack.json found yet; evidence-backed audit may be incomplete."
                        .to_string(),
                evidence_refs: Vec::new(),
                recommendation: "Run retrieve_evidence before deep auditing or claim tracing."
                    .to_string(),
            });
        }

        let overall_assessment = if findings
            .iter()
            .any(|f| matches!(f.severity, AuditSeverity::Critical | AuditSeverity::High))
        {
            "Needs attention: critical/high issues detected.".to_string()
        } else if findings.is_empty() {
            "OK: no audit findings.".to_string()
        } else {
            "OK with notes: review medium/low findings.".to_string()
        };

        let report = AuditReport {
            report_id: format!("audit-{}", uuid::Uuid::new_v4().simple()),
            findings,
            overall_assessment,
            created_at: now.clone(),
        };

        reading_state.audit_report = Some(report.clone());
        reading_state.updated_at = now;

        repo.write_json(&document_paths.audit_report, &report)?;
        repo.write_json(&document_paths.reading_state, &reading_state)?;

        Ok(json!({
            "document_id": document_id,
            "audit_report_ref": display_path(&document_paths.audit_report),
            "reading_state_ref": display_path(&document_paths.reading_state),
            "artifact_refs": [
                display_path(&document_paths.audit_report),
                display_path(&document_paths.reading_state)
            ]
        }))
    }

    pub async fn trace_claim_in_document(&self, payload: &Value) -> Result<Value> {
        let repo = BootstrapWorkspace::ensure(self.resolve_workspace_root(payload))?;
        let document_id = DocumentId::new(required_string(payload, "document_id")?);
        let claim_text = payload_string(payload, "claim_text")
            .or_else(|| payload_string(payload, "claim"))
            .or_else(|| payload_string(payload, "query_text"))
            .context("missing required payload field: claim_text")?;
        let claim_id = payload_string(payload, "claim_id")
            .unwrap_or_else(|| format!("claim-{}", uuid::Uuid::new_v4().simple()));
        let document_paths = repo.document_paths(&document_id);
        let segment_set: SegmentSet = repo.read_json(&document_paths.segment_set)?;

        let segment_id = payload_string(payload, "segment_id")
            .map(SegmentId::new)
            .or_else(|| best_matching_segment_id(&segment_set, &claim_text))
            .unwrap_or_else(|| SegmentId::new("seg-unknown"));

        let claim = ClaimUnit {
            claim_id,
            text: claim_text,
            document_id: document_id.clone(),
            segment_id: segment_id.clone(),
            confidence: 0.7,
            claim_type: ClaimType::Fact,
        };

        let mut context = TraceContext::new();
        if document_paths.evidence_pack.exists() {
            let evidence_pack: EvidencePack = repo.read_json(&document_paths.evidence_pack)?;
            context.add_document_evidence(document_id.clone(), evidence_pack.refs.clone());
            let mut segment_map: HashMap<SegmentId, Vec<EvidenceRef>> = HashMap::new();
            for ev in evidence_pack.refs {
                if let Some(seg_id) = ev.segment_id.clone() {
                    segment_map.entry(seg_id).or_default().push(ev);
                }
            }
            for (seg_id, evidence) in segment_map {
                context.add_segment_evidence(seg_id, evidence);
            }
        }
        if document_paths.handoff.exists() {
            let handoff: HandoffArtifact = repo.read_json(&document_paths.handoff)?;
            let claims = handoff
                .confirmed_facts
                .into_iter()
                .map(|fact| {
                    let fact_seg = fact
                        .evidence_refs
                        .iter()
                        .filter_map(|ev| ev.segment_id.clone())
                        .next()
                        .unwrap_or_else(|| segment_id.clone());
                    ClaimUnit {
                        claim_id: fact.fact_id,
                        text: fact.text,
                        document_id: document_id.clone(),
                        segment_id: fact_seg,
                        confidence: fact.confidence,
                        claim_type: ClaimType::Fact,
                    }
                })
                .collect::<Vec<_>>();
            context.add_document_claims(document_id.clone(), claims);
        }

        let llm: Arc<dyn LlmClient> = self.llm_client.clone();
        let tracer = ClaimTracer::new(llm);
        let traced = tracer.trace_claim(&claim, &context).await?;

        let trace_artifact = json!({
            "trace_id": traced.trace_id,
            "target_claim": traced.target_claim,
            "supporting_evidence": traced.supporting_evidence,
            "contradicting_evidence": traced.contradicting_evidence,
            "related_claims": traced.related_claims,
            "status": format!("{:?}", traced.status),
            "credibility_assessment": {
                "overall_credibility": traced.credibility_assessment.overall_credibility,
                "evidence_sufficiency": traced.credibility_assessment.evidence_sufficiency,
                "source_reliability": traced.credibility_assessment.source_reliability,
                "internal_consistency": traced.credibility_assessment.internal_consistency,
                "assessment_notes": traced.credibility_assessment.assessment_notes,
            },
            "created_at": chrono::Utc::now().to_rfc3339(),
        });

        let support_matrix = json!({
            "trace_id": trace_artifact["trace_id"],
            "supporting_refs": trace_artifact["supporting_evidence"],
        });
        let contradiction_matrix = json!({
            "trace_id": trace_artifact["trace_id"],
            "contradicting_refs": trace_artifact["contradicting_evidence"],
        });

        repo.write_json(&document_paths.claim_trace, &trace_artifact)?;
        repo.write_json(&document_paths.support_matrix, &support_matrix)?;
        repo.write_json(&document_paths.contradiction_matrix, &contradiction_matrix)?;

        Ok(json!({
            "document_id": document_id,
            "segment_id": segment_id,
            "trace_id": trace_artifact["trace_id"],
            "claim_trace_ref": display_path(&document_paths.claim_trace),
            "support_matrix_ref": display_path(&document_paths.support_matrix),
            "contradiction_matrix_ref": display_path(&document_paths.contradiction_matrix),
            "artifact_refs": [
                display_path(&document_paths.claim_trace),
                display_path(&document_paths.support_matrix),
                display_path(&document_paths.contradiction_matrix)
            ],
            "trace": trace_artifact
        }))
    }
}

fn build_attention_plan(segment_set: &SegmentSet, goal: &str) -> AttentionPlan {
    let goal_terms = tokenize(goal);
    let mut allocations = segment_set
        .segments
        .iter()
        .enumerate()
        .map(|(index, segment)| {
            let score = score_text(&goal_terms, &segment.text);
            AttentionAllocation {
                segment_id: segment.segment_id.clone(),
                mode: if score >= 0.7 {
                    ReadMode::Deep
                } else if score >= 0.2 {
                    ReadMode::Skim
                } else {
                    ReadMode::Skip
                },
                priority: (100usize.saturating_sub(index)).min(100) as u8,
                reason: if score > 0.0 {
                    "goal term overlap".to_string()
                } else {
                    "default coverage".to_string()
                },
            }
        })
        .collect::<Vec<_>>();
    if allocations
        .iter()
        .all(|allocation| allocation.mode == ReadMode::Skip)
    {
        if let Some(first) = allocations.first_mut() {
            first.mode = ReadMode::Deep;
        }
    }
    AttentionPlan {
        plan_id: format!("attn-{}", chrono::Utc::now().timestamp()),
        goal: goal.to_string(),
        allocations,
        created_at: chrono::Utc::now().to_rfc3339(),
    }
}

fn select_segments<'a>(
    segment_set: &'a SegmentSet,
    attention_plan: &AttentionPlan,
) -> Vec<&'a Segment> {
    let skipped = attention_plan
        .allocations
        .iter()
        .filter(|allocation| allocation.mode == ReadMode::Skip)
        .map(|allocation| allocation.segment_id.clone())
        .collect::<HashSet<_>>();
    let mut selected = segment_set
        .segments
        .iter()
        .filter(|segment| !skipped.contains(&segment.segment_id))
        .collect::<Vec<_>>();
    if selected.is_empty() && !segment_set.segments.is_empty() {
        selected.push(&segment_set.segments[0]);
    }
    selected
}

fn attention_mode_for_segment(plan: &AttentionPlan, segment_id: &SegmentId) -> ReadMode {
    plan.allocations
        .iter()
        .find(|allocation| &allocation.segment_id == segment_id)
        .map(|allocation| allocation.mode.clone())
        .unwrap_or(ReadMode::Skim)
}

fn compose_rolling_context_limited(
    segment_summaries: &HashMap<String, String>,
    max_entries: usize,
    max_chars: usize,
) -> String {
    if segment_summaries.is_empty() {
        return String::new();
    }

    let mut items = segment_summaries.iter().collect::<Vec<_>>();
    items.sort_by(|(left_id, _), (right_id, _)| {
        segment_id_sort_key(left_id).cmp(&segment_id_sort_key(right_id))
    });

    let take = max_entries.min(items.len());
    let start = items.len().saturating_sub(take);
    let mut lines = items[start..]
        .iter()
        .map(|(segment_id, summary)| format!("{segment_id}: {summary}"))
        .collect::<Vec<_>>()
        .join("\n");

    if lines.len() > max_chars {
        lines = lines[lines.len().saturating_sub(max_chars)..].to_string();
    }
    lines
}

fn segment_id_sort_key(segment_id: &str) -> (u64, &str) {
    if let Some(rest) = segment_id.strip_prefix("seg-") {
        if let Ok(number) = rest.parse::<u64>() {
            return (number, "");
        }
    }
    (u64::MAX, segment_id)
}

fn build_shallow_global_map_markdown(
    segment_summaries: &HashMap<String, String>,
    goal: &str,
) -> String {
    if segment_summaries.is_empty() {
        return format!(
            "# Global Map\n\n## Goal\n{}\n\n(no segment summaries yet)\n",
            goal
        );
    }

    let mut items = segment_summaries.iter().collect::<Vec<_>>();
    items.sort_by(|(left_id, _), (right_id, _)| {
        segment_id_sort_key(left_id).cmp(&segment_id_sort_key(right_id))
    });

    let preview = items
        .iter()
        .take(12)
        .map(|(segment_id, summary)| format!("- **{}**: {}", segment_id, snippet(summary)))
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        "# Global Map\n\n## Goal\n{}\n\n## Preview (first {} segment summaries)\n{}\n",
        goal,
        items.len().min(12),
        preview
    )
}

fn build_final_report_markdown(
    document_id: &DocumentId,
    goal: &str,
    requested_mode: &str,
    constraints: &[String],
    global_map_markdown: &str,
    rolling_context: &str,
    confirmed_facts: &[paperreader_workspace::ConfirmedFact],
    open_questions: &[OpenQuestion],
) -> String {
    let shifted_global_map = shift_markdown_headings(global_map_markdown, 2);

    let mut facts = confirmed_facts.to_vec();
    facts.sort_by(|left, right| right.confidence.total_cmp(&left.confidence));
    let facts_md = facts
        .iter()
        .take(24)
        .map(|fact| format!("- ({:.2}) {}", fact.confidence, fact.text))
        .collect::<Vec<_>>()
        .join("\n");

    let mut questions = open_questions.to_vec();
    questions.sort_by(|left, right| right.priority.cmp(&left.priority));
    let questions_md = questions
        .iter()
        .take(24)
        .map(|question| format!("- (p{}) {}", question.priority, question.text))
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        "# Final Report\n\n\
## Document\n\
- document_id: `{}`\n\
- mode: `{}`\n\
- constraints:\n{}\n\n\
## Goal\n{}\n\n\
## Global Map\n{}\n\n\
## Confirmed Facts (Top {})\n{}\n\n\
## Open Questions (Top {})\n{}\n\n\
## Rolling Context (Latest)\n```\n{}\n```\n",
        document_id.0,
        requested_mode,
        format_constraints_markdown(constraints),
        goal,
        shifted_global_map,
        facts.len().min(24),
        if facts_md.is_empty() {
            "- (none)".to_string()
        } else {
            facts_md
        },
        questions.len().min(24),
        if questions_md.is_empty() {
            "- (none)".to_string()
        } else {
            questions_md
        },
        rolling_context
    )
}

fn shift_markdown_headings(markdown: &str, shift: usize) -> String {
    if shift == 0 {
        return markdown.to_string();
    }
    markdown
        .lines()
        .map(|line| {
            let trimmed = line.trim_start();
            let hashes = trimmed.chars().take_while(|ch| *ch == '#').count();
            if hashes == 0 {
                return line.to_string();
            }
            if !trimmed.chars().nth(hashes).is_some_and(|ch| ch == ' ') {
                return line.to_string();
            }
            let new_hashes = (hashes + shift).min(6);
            let prefix_spaces = line.len().saturating_sub(trimmed.len());
            let indent = " ".repeat(prefix_spaces);
            let rest = &trimmed[hashes..];
            format!("{}{}{}", indent, "#".repeat(new_hashes), rest)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn build_reading_context_snapshot(
    segment_summaries: &HashMap<String, String>,
    max_entries: usize,
    max_chars: usize,
) -> Vec<paperreader_reading::ContextMessage> {
    if segment_summaries.is_empty() {
        return Vec::new();
    }
    let rolling = compose_rolling_context_limited(segment_summaries, max_entries, max_chars);
    vec![paperreader_reading::ContextMessage {
        role: paperreader_reading::MessageRole::System,
        content: format!(
            "Rolling Context (previous segment summaries; use for consistency, avoid repetition):\n{}",
            rolling
        ),
    }]
}

fn payload_flag(payload: &Value, key: &str) -> bool {
    payload
        .get(key)
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn requested_resume_from_state(payload: &Value) -> bool {
    payload_flag(payload, "resume_from_state")
        || payload
            .get("resume_from_state")
            .and_then(|value| value.as_str())
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
}

fn requested_read_mode(payload: &Value) -> Option<String> {
    payload_string(payload, "mode").map(|value| value.to_lowercase())
}

pub(crate) fn requested_constraints(payload: &Value) -> Vec<String> {
    if let Some(value) = payload.get("constraints") {
        if let Some(items) = value.as_array() {
            return items
                .iter()
                .filter_map(|item| item.as_str().map(ToString::to_string))
                .collect();
        }
        if let Some(text) = value.as_str() {
            return vec![text.to_string()];
        }
    }
    Vec::new()
}

pub(crate) fn format_constraints_markdown(constraints: &[String]) -> String {
    if constraints.is_empty() {
        "- (none)".to_string()
    } else {
        constraints
            .iter()
            .map(|constraint| format!("- {constraint}"))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

fn select_segments_for_request(
    segment_set: &SegmentSet,
    attention_plan: &AttentionPlan,
    requested_mode: &str,
) -> Vec<Segment> {
    let selected = select_segments(segment_set, attention_plan)
        .into_iter()
        .cloned()
        .collect::<Vec<_>>();
    match requested_mode {
        "survey_only" => selected.into_iter().take(2).collect(),
        "deep_focus" => {
            let mut all = segment_set.segments.clone();
            all.sort_by(|left, right| left.segment_id.0.cmp(&right.segment_id.0));
            all
        }
        "recursive" => {
            let mut all = segment_set.segments.clone();
            all.sort_by(|left, right| left.segment_id.0.cmp(&right.segment_id.0));
            all
        }
        _ => selected,
    }
}

fn reading_depth_for_request(requested_mode: &str, index: usize) -> ReadingDepth {
    match requested_mode {
        "survey_only" => ReadingDepth::Medium,
        "deep_focus" => ReadingDepth::Deep,
        "recursive" => ReadingDepth::Medium,
        _ => {
            if index == 0 {
                ReadingDepth::Deep
            } else {
                ReadingDepth::Medium
            }
        }
    }
}

fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn score_text(query_terms: &[String], text: &str) -> f64 {
    if query_terms.is_empty() {
        return 0.0;
    }
    let normalized = text.to_lowercase();
    let matches = query_terms
        .iter()
        .filter(|term| normalized.contains(term.as_str()))
        .count();
    matches as f64 / query_terms.len() as f64
}

pub(crate) fn best_matching_segment_id(
    segment_set: &SegmentSet,
    claim_text: &str,
) -> Option<SegmentId> {
    let terms = tokenize(claim_text);
    segment_set
        .segments
        .iter()
        .map(|segment| {
            (
                score_text(&terms, &segment.text),
                segment.segment_id.clone(),
            )
        })
        .max_by(|left, right| {
            left.0
                .partial_cmp(&right.0)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .and_then(|(score, segment_id)| (score > 0.0).then_some(segment_id))
}
