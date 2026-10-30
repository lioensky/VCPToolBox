//! Auxiliary evidence from observed wormholes, never a replacement scorer.
//! Strict global admission enables a separate correction key; baseline scores stay intact.
use super::*;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Route {
    source_id: i64,
    target_id: i64,
    flow: f64,
    relative_flow: f64,
    #[serde(skip)]
    vector: Arc<[f32]>,
}

#[derive(Default)]
pub(super) struct Model {
    pub routes: Vec<Route>,
    pub eligible_routes: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GateDecision {
    source_id: i64,
    target_id: i64,
    witness_file_ids: Vec<i64>,
    accepted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    refined_evidence: Option<Value>,
}

pub(super) fn gate(model: &mut Model, connection: &Connection)
    -> std::result::Result<Vec<GateDecision>, String> {
    // Global graph evidence, independent of candidate and retrieval scopes.
    // Two distinct files are repeated association, NOT proof of independence.
    let mut statement = connection.prepare_cached(
        "SELECT DISTINCT s.file_id FROM file_tags s
         JOIN file_tags t ON t.file_id=s.file_id AND t.tag_id=?2
         WHERE s.tag_id=?1 ORDER BY s.file_id LIMIT 2"
    ).map_err(|e| format!("prepare wormhole cross gate: {e}"))?;
    let mut decisions = Vec::new();
    for route in &model.routes {
        let rows = statement.query_map(
            rusqlite::params![route.source_id, route.target_id], |row| row.get::<_, i64>(0)
        ).map_err(|e| format!("query wormhole cross gate: {e}"))?;
        let files = rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| format!("decode wormhole cross gate: {e}"))?;
        decisions.push(GateDecision {
            source_id: route.source_id, target_id: route.target_id,
            accepted: files.len() >= 2, witness_file_ids: files, refined_evidence: None,
        });
    }
    model.routes.retain(|route| decisions.iter().any(|d|
        d.source_id == route.source_id && d.target_id == route.target_id && d.accepted));
    Ok(decisions)
}
 
pub(super) fn refine(model: &mut Model, decisions: &mut [GateDecision],
    connection: &Connection, input: &NativeInput)
    -> std::result::Result<(), String> {
    const FILE_LIMIT: usize = 128;
    const TAG_LIMIT: usize = 128;
    let focus: HashSet<i64> = input.query_state.field_provenance.iter()
        .filter(|p| p.hop == 0 && matches!(p.source_type.as_str(), "core" | "lexical_seed"))
        .map(|p| p.id).collect();
    let mut files_query = connection.prepare_cached(
        "SELECT DISTINCT s.file_id, f.checksum FROM file_tags s
         JOIN file_tags t ON t.file_id=s.file_id AND t.tag_id=?2
         JOIN files f ON f.id=s.file_id
         WHERE s.tag_id=?1 ORDER BY s.file_id LIMIT 129"
    ).map_err(|e| e.to_string())?;
    let mut tags_query = connection.prepare_cached(
        "SELECT DISTINCT tag_id FROM file_tags WHERE file_id=?1 ORDER BY tag_id LIMIT 129"
    ).map_err(|e| e.to_string())?;
    for decision in decisions.iter_mut().filter(|d| d.accepted) {
        let files = files_query.query_map(
            rusqlite::params![decision.source_id, decision.target_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?))
        ).map_err(|e| e.to_string())?.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        let mut truncated = files.len() > FILE_LIMIT;
        let mut evidence = Vec::new();
        for (id, checksum) in files.into_iter().take(FILE_LIMIT) {
            let tags = tags_query.query_map([id], |r| r.get::<_, i64>(0))
                .map_err(|e| e.to_string())?.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| e.to_string())?;
            truncated |= tags.len() > TAG_LIMIT;
            evidence.push((id, checksum, tags.into_iter().take(TAG_LIMIT).collect::<HashSet<_>>()));
        }
        let mut witness = None;
        if !truncated {
            'pairs: for (i, left) in evidence.iter().enumerate() {
                for right in evidence.iter().skip(i + 1) {
                    let (Some(a), Some(b)) = (&left.1, &right.1) else { continue };
                    if a.is_empty() || b.is_empty() || a == b { continue; }
                    let other_focus = focus.iter().copied().filter(|id|
                        *id != decision.source_id && *id != decision.target_id
                        && (left.2.contains(id) || right.2.contains(id))).min();
                    let Some(anchor) = other_focus else { continue };
                    let bridge = left.2.intersection(&right.2).copied().filter(|id|
                        *id != decision.source_id && *id != decision.target_id
                        && !focus.contains(id)).min();
                    if let Some(bridge) = bridge {
                        witness = Some(serde_json::json!({
                            "fileIds": [left.0, right.0], "focusId": anchor,
                            "bridgeTagId": bridge, "differentChecksums": true
                        }));
                        break 'pairs;
                    }
                }
            }
        }
        decision.accepted = witness.is_some();
        decision.refined_evidence = Some(serde_json::json!({
            "witness": witness, "truncated": truncated,
            "examinedFiles": evidence.len(), "fileLimit": FILE_LIMIT, "tagLimit": TAG_LIMIT,
            "note": "cross-file association; different checksums do not prove independence"
        }));
    }
    model.routes.retain(|r| decisions.iter().any(|d|
        d.source_id == r.source_id && d.target_id == r.target_id && d.accepted));
    Ok(())
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Readout {
    pub available: bool,
    pub score: f64,
    pub source_id: Option<i64>,
    pub target_id: Option<i64>,
    pub flow: f64,
    pub relative_flow: f64,
    pub endpoint_body_cosine: f64,
    pub exact_target_tag: bool,
    pub edge_source_file: bool,
    pub location: String,
}

pub(super) fn build(input: &NativeInput, vectors: &TagVectorPool, artifact: &NativeArtifact) -> Model {
    // Use the same denominator as the observation display: maximum observed
    // positive raw flow, not a candidate-pool statistic or a second saturation.
    let maximum = input.query_state.river_edges.iter()
        .map(|edge| positive(edge.flow)).fold(0.0_f64, f64::max);
    if maximum == 0.0 { return Model::default(); }
    let mut routes = BTreeMap::<(i64, i64), Route>::new();
    for edge in &input.query_state.river_edges {
        if !edge.wormhole || edge.immediate_return || edge.source_id <= 0
            || edge.target_id <= 0 || edge.source_id == edge.target_id
            || positive(edge.flow) == 0.0
            || artifact.edge_weight(edge.source_id, edge.target_id) <= 0.0 {
            continue;
        }
        let Some(vector) = vectors.get(&edge.target_id) else { continue };
        if !vector.iter().all(|v| v.is_finite()) || squared_norm(vector) <= 1e-15 {
            continue;
        }
        // Dynamic routing also selects real CSR edges. Neither the persisted
        // wormhole flag nor a source-target similarity is re-tested here.
        // Duplicate serialized edges cannot increase a route's vote.
        let key = (edge.source_id, edge.target_id);
        let route = Route {
            source_id: edge.source_id, target_id: edge.target_id,
            flow: edge.flow, relative_flow: clamp01(edge.flow / maximum),
            vector: vector.clone(),
        };
        if routes.get(&key).is_none_or(|old| old.flow < route.flow) {
            routes.insert(key, route);
        }
    }
    let mut routes: Vec<_> = routes.into_values().collect();
    routes.sort_by(|a, b| b.flow.total_cmp(&a.flow)
        .then_with(|| a.source_id.cmp(&b.source_id))
        .then_with(|| a.target_id.cmp(&b.target_id)));
    let eligible_routes = routes.len();
    routes.truncate(input.config.maximum_river_edges.max(1));
    Model { routes, eligible_routes }
}

pub(super) fn evaluate(model: &Model, curve: &Curve, artifact: &NativeArtifact) -> Readout {
    let mut output = Readout {
        available: !model.routes.is_empty(),
        location: "unavailable".into(),
        ..Readout::default()
    };
    for route in &model.routes {
        // Endpoint evidence only. Budget and Omega are applied by augment().
        let endpoint_body_cosine = cosine(&route.vector, &curve.chunk_vector);
        let score = route.relative_flow * clamp01(endpoint_body_cosine);
        if output.source_id.is_some() && score <= output.score { continue; }
        let exact_target_tag = curve.tags.iter().any(|tag| tag.id == route.target_id);
        let edge_source_file = artifact.provenance
            .get(&(route.source_id, route.target_id))
            .is_some_and(|rows| rows.iter().any(|(file, mass)|
                *file == curve.file_id && positive(*mass) > 0.0));
        output = Readout {
            available: true, score,
            source_id: Some(route.source_id), target_id: Some(route.target_id),
            flow: route.flow, relative_flow: route.relative_flow,
            endpoint_body_cosine, exact_target_tag, edge_source_file,
            // File-level addresses do not prove this particular chunk answers.
            location: if exact_target_tag { "exact-file-tag" }
                else if edge_source_file { "edge-source-file" }
                else { "semantic-body-approximation" }.into(),
        };
    }
    output
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Correction {
    pub eligible: bool,
    pub evidence: f64,
    pub source_id: Option<i64>,
    pub target_id: Option<i64>,
    pub matched_tag_id: Option<i64>,
    pub tag_similarity: f64,
    pub body_cosine: f64,
    pub relative_flow: f64,
}

pub(super) fn correction(model: &Model, curve: &Curve, input: &NativeInput,
    omega: &OmegaOutput) -> Correction {
    let mut best = Correction::default();
    if !input.query_state.complete_observation || omega.omega <= 0.0 { return best; }
    let explicit: HashSet<i64> = input.query_state.field_provenance.iter()
        .filter(|p| p.hop == 0 && matches!(p.source_type.as_str(), "core" | "lexical_seed"))
        .map(|p| p.id).collect();
    for route in &model.routes {
        // Original observation denominator, never renormalized after admission.
        if route.relative_flow < 0.5 || !explicit.contains(&route.source_id) { continue; }
        let body = clamp01(cosine(&route.vector, &curve.chunk_vector));
        if body <= 0.0 { continue; }
        let matched = curve.tags.iter().filter_map(|tag| {
            let similarity = if tag.id == route.target_id { 1.0 }
                else { cosine(&route.vector, &tag.vector) };
            (similarity > input.config.semantic_node_threshold && tag.chunk_cosine > 0.0)
                .then_some((tag.id, similarity, tag.chunk_cosine))
        }).max_by(|a, b| a.1.total_cmp(&b.1).then_with(|| b.0.cmp(&a.0)));
        let Some((tag, similarity, _closure)) = matched else { continue };
        let evidence = route.relative_flow * body
            * omega.omega.powf(input.config.omega_gamma.max(0.0));
        if best.eligible && evidence <= best.evidence { continue; }
        best = Correction { eligible: true, evidence, source_id: Some(route.source_id),
            target_id: Some(route.target_id), matched_tag_id: Some(tag),
            tag_similarity: similarity, body_cosine: body, relative_flow: route.relative_flow };
    }
    best
}

pub(super) fn compare(a: &Correction, b: &Correction) -> Ordering {
    b.eligible.cmp(&a.eligible)
        .then_with(|| b.evidence.total_cmp(&a.evidence))
}

pub(super) fn augment(item: &mut ScoredWork, readout: &Readout,
    omega: &OmegaOutput, config: &NativeConfig) {
    if !readout.available || readout.score <= 0.0 { return; }
    let cap = positive(config.topology_bonus_cap);
    let gate = omega.omega.powf(config.omega_gamma.max(0.0));
    let proposed = (cap * clamp01(readout.score) * gate)
        .min(positive(cap - item.path_bonus));
    // Never reduce old evidence; never stack another topology budget.
    if proposed <= item.gated_bonus { return; }
    item.gated_bonus = proposed;
    item.final_score = clamp01(item.pure_score + item.path_bonus
        + item.gated_bonus + item.anchor_bonus);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(edges: Value) -> NativeInput {
        serde_json::from_value(serde_json::json!({
            "query": {"vector": [1, 0]}, "queryState": {"riverEdges": edges}
        })).unwrap()
    }

    fn artifact() -> NativeArtifact {
        NativeArtifact {
            node_ids: vec![1, 2, 3, 4],
            node_index: [(1, 0), (2, 1), (3, 2), (4, 3)].into_iter().collect(),
            row_offsets: vec![0, 3, 3, 3, 3], targets: vec![1, 2, 3],
            weights: vec![1.0, 1.0, 1.0], ..NativeArtifact::default()
        }
    }

    fn curve(vector: Vec<f32>) -> Curve {
        Curve { id: 7, file_id: 8, tags: vec![], chunk_vector: Arc::from(vector),
            query_score: 0.99, denoised_score: 0.99, local_score: 0.99,
            transfer_score: 0.99, bm25_score: 0.0, time_score: 0.0,
            anchor_score: 0.0, union_score: 0.0, union_rank: 1, sources: vec![] }

    }

    #[test]
    fn endpoint_evidence_does_not_retest_source_similarity() {
        let input = input(serde_json::json!([
            {"sourceId": 1, "targetId": 2, "flow": 0.1, "wormhole": true},
            {"sourceId": 1, "targetId": 3, "flow": 0.02, "wormhole": true},
            {"sourceId": 1, "targetId": 4, "flow": 0.09, "wormhole": false}
        ]));
        let vectors = [(2, Arc::from(vec![0.0_f32, 1.0])),
            (3, Arc::from(vec![1.0_f32, 0.0]))].into_iter().collect();
        let model = build(&input, &vectors, &artifact());
        let event = evaluate(&model, &curve(vec![0.0, 1.0]), &NativeArtifact::default());
        let background = evaluate(&model, &curve(vec![1.0, 0.0]), &NativeArtifact::default());
        assert_eq!(event.score, 1.0);
        assert!((background.score - 0.2).abs() < 1e-12);
        assert_eq!(event.target_id, Some(2));
        assert_eq!(event.location, "semantic-body-approximation");
        assert!(event.score > background.score);
    }

    #[test]
    fn invalid_return_ordinary_and_missing_vector_routes_do_not_activate_channel() {
        let input = input(serde_json::json!([
            {"sourceId": 1, "targetId": 2, "flow": 1, "wormhole": false},
            {"sourceId": 1, "targetId": 2, "flow": 1, "wormhole": true, "immediateReturn": true},
            {"sourceId": 2, "targetId": 2, "flow": 1, "wormhole": true},
            {"sourceId": 1, "targetId": 2, "flow": -1, "wormhole": true},
            {"sourceId": 1, "targetId": 99, "flow": 1, "wormhole": true}
        ]));
        let vectors = [(2, Arc::from(vec![0.0_f32, 1.0]))].into_iter().collect();
        let model = build(&input, &vectors, &artifact());
        assert!(!evaluate(&model, &curve(vec![1.0, 0.0]), &NativeArtifact::default()).available);
    }

    #[test]
    fn address_diagnostics_do_not_invent_a_chunk_level_relevance_bonus() {
        let input = input(serde_json::json!([
            {"sourceId": 1, "targetId": 2, "flow": 0.1, "wormhole": true}
        ]));
        let vectors = [(2, Arc::from(vec![0.0_f32, 1.0]))].into_iter().collect();
        let model = build(&input, &vectors, &artifact());
        let candidate = curve(vec![0.0, 1.0]);
        let mut artifact = NativeArtifact::default();
        let before = evaluate(&model, &candidate, &artifact);
        artifact.provenance.insert((1, 2), vec![(8, 1.0)]);
        let after = evaluate(&model, &candidate, &artifact);
        assert_eq!(before.score, after.score);
        assert!(after.edge_source_file);
        assert_eq!(after.location, "edge-source-file");
        assert_eq!(evaluate(&model, &curve(vec![0.0, -1.0]), &artifact).score, 0.0);
    }
}

#[cfg(test)]
mod gate_regressions {
    use super::*;

    fn model() -> Model {
        Model { eligible_routes: 1, routes: vec![Route {
            source_id: 1, target_id: 2, flow: 1.0, relative_flow: 1.0,
            vector: Arc::from(vec![0.0_f32, 1.0]),
        }] }
    }

    #[test]
    fn refined_requires_distinct_content_bridge_and_another_explicit_focus() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE file_tags(file_id INTEGER, tag_id INTEGER);
            CREATE INDEX tags_lookup ON file_tags(tag_id,file_id);
            CREATE TABLE files(id INTEGER PRIMARY KEY, checksum TEXT);
            INSERT INTO files VALUES (10,'same'),(11,'same');
            INSERT INTO file_tags VALUES (10,1),(10,2),(10,3),(10,9),
                (11,1),(11,2),(11,9);").unwrap();
        let input: NativeInput = serde_json::from_value(serde_json::json!({
            "query": {"vector": [1,0]}, "queryState": {"fieldProvenance": [
                {"id":1,"hop":0,"sourceType":"lexical_seed"},
                {"id":3,"hop":0,"sourceType":"lexical_seed"}
            ]}
        })).unwrap();
        let check = |db: &Connection| {
            let mut m = model();
            let mut d = gate(&mut m, db).unwrap();
            refine(&mut m, &mut d, db, &input).unwrap();
            d[0].accepted
        };
        assert!(!check(&db), "same content cannot qualify");
        db.execute("UPDATE files SET checksum='different' WHERE id=11", []).unwrap();
        assert!(check(&db));
        db.execute("DELETE FROM file_tags WHERE file_id=11 AND tag_id=9", []).unwrap();
        assert!(!check(&db), "route endpoints cannot act as third-tag witness");
        db.execute("INSERT INTO file_tags VALUES (11,9)", []).unwrap();
        db.execute("DELETE FROM file_tags WHERE tag_id=3", []).unwrap();
        assert!(!check(&db), "implicit context alone cannot qualify");
    }

    #[test]
    fn global_gate_counts_distinct_files_not_rows() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE file_tags(file_id INTEGER, tag_id INTEGER);
            CREATE INDEX tags_lookup ON file_tags(tag_id,file_id);
            INSERT INTO file_tags VALUES (10,1),(10,2),(10,2),(11,1);").unwrap();
        let mut single = model();
        let decisions = gate(&mut single, &db).unwrap();
        assert!(!decisions[0].accepted);
        assert_eq!(decisions[0].witness_file_ids, vec![10]);
        assert!(single.routes.is_empty());
        db.execute("INSERT INTO file_tags VALUES (11,2)", []).unwrap();
        let mut both = model();
        assert!(gate(&mut both, &db).unwrap()[0].accepted);
        assert_eq!(both.routes.len(), 1);
        // Admission has no candidate/retrieval-scope argument: witnesses belong
        // to the global file-tag graph, not the returned candidate pool.
        assert_eq!(both.routes[0].target_id, 2);
    }
}

/// `work` must already be sorted by the untouched baseline comparator.
pub(super) fn fuse_rrf(work: &mut [ScoredWork], model: &Model,
    input: &NativeInput, omega: &OmegaOutput) -> HashMap<i64, Value> {
    const K: f64 = 60.0;
    let ordinary_max = input.query_state.river_edges.iter()
        .filter(|e| !e.wormhole && !e.immediate_return && e.source_id != e.target_id)
        .map(|e| positive(e.flow)).fold(0.0_f64, f64::max);
    // With no ordinary edge use the original observation maximum, not epsilon.
    let reference = if ordinary_max > 0.0 { ordinary_max } else {
        input.query_state.river_edges.iter().map(|e| positive(e.flow))
            .fold(0.0_f64, f64::max)
    };
    let mut traces = HashMap::new();
    if reference <= 0.0 || work.is_empty() { return traces; }
    let mut contributions = vec![0.0_f64; work.len()];
    let mut winners = vec![Value::Null; work.len()];
    for route in &model.routes {
        let single = Model { routes: vec![route.clone()], eligible_routes: 1 };
        let mut ranked: Vec<(usize, Correction)> = work.iter().enumerate()
            .filter_map(|(i, item)| {
                let evidence = correction(&single, &item.curve, input, omega);
                evidence.eligible.then_some((i, evidence))
            }).collect();
        ranked.sort_by(|a, b| b.1.evidence.total_cmp(&a.1.evidence)
            .then_with(|| a.0.cmp(&b.0)));
        let weight = route.flow / reference
            * omega.omega.powf(input.config.omega_gamma.max(0.0));
        for (rank, (i, evidence)) in ranked.into_iter().enumerate() {
            let contribution = weight / (K + (rank + 1) as f64);
            if contribution <= contributions[i] { continue; }
            contributions[i] = contribution;
            winners[i] = serde_json::json!({
                "sourceId": route.source_id, "targetId": route.target_id,
                "flow": route.flow, "relativeFlow": route.relative_flow,
                "referenceFlow": reference, "weight": weight,
                "routeRank": rank + 1, "contribution": contribution,
                "grounding": evidence
            });
        }
    }
    let active = contributions.iter().any(|v| *v > 0.0);
    for (i, item) in work.iter_mut().enumerate() {
        let baseline = item.final_score;
        let baseline_rrf = 1.0 / (K + (i + 1) as f64);
        if active { item.final_score = baseline_rrf + contributions[i]; }
        traces.insert(item.curve.id, serde_json::json!({
            "active": active, "k": K, "baselineRank": i + 1,
            "baselineScore": baseline, "baselineContribution": baseline_rrf,
            "wormholeContribution": contributions[i], "winner": winners[i],
            "fusedScore": item.final_score,
            "referenceMode": if ordinary_max > 0.0 { "maximum-observed-ordinary-flow" }
                else { "maximum-observed-flow-no-ordinary-edge" }
        }));
    }
    traces
}