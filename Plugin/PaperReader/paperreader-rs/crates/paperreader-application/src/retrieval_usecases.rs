use super::*;

impl PaperReaderApplication {
    pub fn retrieve_evidence_value(&self, payload: &Value) -> Result<Value> {
        self.execute_evidence_request(payload, false)
    }

    pub fn build_evidence_pack(&self, payload: &Value) -> Result<Value> {
        self.execute_evidence_request(payload, true)
    }

    fn execute_evidence_request(&self, payload: &Value, pack_only: bool) -> Result<Value> {
        let repo = BootstrapWorkspace::ensure(self.resolve_workspace_root(payload))?;
        let query_text = payload_string(payload, "query_text")
            .or_else(|| payload_string(payload, "query"))
            .context("missing required payload field: query_text")?;
        let collection_id = payload_string(payload, "collection_id");
        let target_document_ids =
            resolve_retrieval_document_ids(&repo, payload, collection_id.as_deref())?;
        let primary_document_id = target_document_ids
            .first()
            .cloned()
            .context("at least one target document is required")?;
        let scope = if collection_id.is_some() || target_document_ids.len() > 1 {
            "collection".to_string()
        } else {
            "document".to_string()
        };
        let request = RetrievalRequest {
            scope: scope.clone(),
            document_id: primary_document_id.clone(),
            document_ids: target_document_ids.clone(),
            collection_id: collection_id.clone(),
            query_text: query_text.clone(),
            query: payload_string(payload, "query").filter(|legacy| legacy != &query_text),
            query_type: payload_string(payload, "query_type"),
            filters: payload.get("filters").cloned(),
            budget: None,
            max_results: payload
                .get("max_results")
                .and_then(|v| v.as_u64())
                .unwrap_or(5) as usize,
        };
        let mut aggregated_hits = Vec::new();
        let mut aggregated_refs = Vec::new();
        for document_id in target_document_ids.iter() {
            let document_paths = repo.document_paths(document_id);
            let document: NormalizedDocument =
                repo.read_json(&document_paths.normalized_document)?;
            let segment_set: SegmentSet = repo.read_json(&document_paths.segment_set)?;
            let segment_summaries: HashMap<String, String> =
                if document_paths.segment_summaries.exists() {
                    repo.read_json(&document_paths.segment_summaries)?
                } else {
                    HashMap::new()
                };
            let mut per_document_request = request.clone();
            per_document_request.document_id = document_id.clone();
            let retrieval = retrieve_evidence_with_hits(
                &document,
                &segment_set,
                &segment_summaries.into_iter().collect::<Vec<_>>(),
                &per_document_request,
            );
            aggregated_hits.extend(retrieval.hits);
            aggregated_refs.extend(retrieval.evidence_pack.refs);

            if scope == "document" {
                repo.write_json(&document_paths.retrieval_request, &per_document_request)?;
                repo.write_json(&document_paths.retrieval_hits, &aggregated_hits)?;
            }
        }

        aggregated_hits.sort_by(|left, right| {
            right
                .score
                .partial_cmp(&left.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        aggregated_hits.truncate(request.max_results.max(1));

        let allowed_ref_ids = aggregated_hits
            .iter()
            .map(|hit| hit.ref_id.clone())
            .collect::<HashSet<_>>();
        aggregated_refs.retain(|reference| allowed_ref_ids.contains(&reference.ref_id));
        aggregated_refs.sort_by(|left, right| left.ref_id.cmp(&right.ref_id));
        aggregated_refs.dedup_by(|left, right| left.ref_id == right.ref_id);

        let mut evidence_pack = EvidencePack {
            refs: aggregated_refs,
            pack_id: format!("ep-{}", uuid::Uuid::new_v4().simple()),
            goal: payload_string(payload, "goal").or_else(|| request.query_type.clone()),
            query_text: Some(query_text.clone()),
            scope: scope.clone(),
            coverage_notes: vec![format!(
                "Pack built from {} hit(s) over {} document(s)",
                aggregated_hits.len(),
                target_document_ids.len()
            )],
            omission_risks: if scope == "collection" {
                vec!["collection_scope_may_hide_long_tail_evidence".to_string()]
            } else {
                vec!["single_document_scope".to_string()]
            },
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        if pack_only {
            evidence_pack
                .coverage_notes
                .push("pack_strategy=minimal_citable_set".to_string());
        }

        let (retrieval_request_ref, retrieval_hits_ref, evidence_pack_ref) = if scope == "document"
        {
            let document_paths = repo.document_paths(&primary_document_id);
            repo.write_json(&document_paths.retrieval_request, &request)?;
            repo.write_json(&document_paths.retrieval_hits, &aggregated_hits)?;
            repo.write_json(&document_paths.evidence_pack, &evidence_pack)?;
            (
                Some(display_path(&document_paths.retrieval_request)),
                Some(display_path(&document_paths.retrieval_hits)),
                Some(display_path(&document_paths.evidence_pack)),
            )
        } else if let Some(collection_id) = collection_id.clone() {
            let collection_paths = repo.collection_paths(&CollectionId::new(collection_id.clone()));
            repo.write_json(&collection_paths.evidence_pack_latest, &evidence_pack)?;
            (
                None,
                None,
                Some(display_path(&collection_paths.evidence_pack_latest)),
            )
        } else {
            (None, None, None)
        };

        let mut response = json!({
            "scope": scope,
            "document_id": primary_document_id,
            "document_ids": target_document_ids,
            "collection_id": collection_id,
            "query_text": query_text,
            "query": payload_string(payload, "query"),
            "evidence_pack": evidence_pack,
            "evidence_pack_ref": evidence_pack_ref,
        });
        if !pack_only {
            response["retrieval_hits"] = serde_json::to_value(&aggregated_hits)?;
            response["retrieval_request_ref"] = serde_json::to_value(retrieval_request_ref)?;
            response["retrieval_hits_ref"] = serde_json::to_value(retrieval_hits_ref)?;
        } else {
            response["pack_strategy"] = json!("minimal_citable_set");
            response["source_hit_count"] = json!(aggregated_hits.len());
        }
        Ok(response)
    }
}

pub(crate) fn resolve_retrieval_document_ids(
    repo: &WorkspaceRepository,
    payload: &Value,
    collection_id: Option<&str>,
) -> Result<Vec<DocumentId>> {
    if let Ok(document_ids) = required_document_ids(payload, "document_ids") {
        return Ok(document_ids);
    }
    if let Some(document_id) = payload_string(payload, "document_id") {
        return Ok(vec![DocumentId::new(document_id)]);
    }
    if let Some(collection_id) = collection_id {
        let collection_paths = repo.collection_paths(&CollectionId::new(collection_id.to_string()));
        if collection_paths.member_documents.exists() {
            let members: Vec<DocumentManifest> =
                repo.read_json(&collection_paths.member_documents)?;
            return Ok(members
                .into_iter()
                .map(|member| member.document_id)
                .collect());
        }
    }
    anyhow::bail!("missing required payload field: document_id | document_ids | collection_id");
}

pub(crate) fn load_claim_units_for_document(
    repo: &WorkspaceRepository,
    document_id: &DocumentId,
) -> Result<Vec<ClaimUnit>> {
    let document_paths = repo.document_paths(document_id);
    if !document_paths.handoff.exists() {
        return Ok(Vec::new());
    }

    let handoff: HandoffArtifact = repo.read_json(&document_paths.handoff)?;
    let segment_set: Option<SegmentSet> = if document_paths.segment_set.exists() {
        Some(repo.read_json(&document_paths.segment_set)?)
    } else {
        None
    };

    let mut claims = Vec::new();
    for fact in handoff.confirmed_facts.into_iter() {
        let segment_id = fact
            .evidence_refs
            .iter()
            .filter_map(|ev| ev.segment_id.clone())
            .next()
            .or_else(|| {
                segment_set
                    .as_ref()
                    .and_then(|set| best_matching_segment_id(set, &fact.text))
            })
            .unwrap_or_else(|| SegmentId::new("seg-unknown"));
        claims.push(ClaimUnit {
            claim_id: fact.fact_id,
            text: fact.text,
            document_id: document_id.clone(),
            segment_id,
            confidence: fact.confidence,
            claim_type: ClaimType::Fact,
        });
    }

    Ok(claims)
}
