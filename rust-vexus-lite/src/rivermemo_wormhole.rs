//! Auxiliary evidence from observed wormholes, never a replacement scorer.
//! Admission is file-based; rewards share the original topology budget and Omega.
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
}

pub(super) fn gate(model: &mut Model, connection: &Connection, allowed: Option<&HashSet<i64>>)
    -> std::result::Result<Vec<GateDecision>, String> {
    // Two distinct files are repeated association, NOT proof of independence.
    // Apply scope before LIMIT so hidden files cannot admit a route.
    let scope = allowed.map(|ids| serde_json::to_string(ids).unwrap());
    let mut statement = connection.prepare_cached(
        "SELECT DISTINCT s.file_id FROM file_tags s
         JOIN file_tags t ON t.file_id=s.file_id AND t.tag_id=?2
         WHERE s.tag_id=?1 AND (?3 IS NULL OR s.file_id IN
             (SELECT value FROM json_each(?3)))
         ORDER BY s.file_id LIMIT 2"
    ).map_err(|e| format!("prepare wormhole cross gate: {e}"))?;
    let mut decisions = Vec::new();
    for route in &model.routes {
        let rows = statement.query_map(
            rusqlite::params![route.source_id, route.target_id, scope], |row| row.get::<_, i64>(0)
        ).map_err(|e| format!("query wormhole cross gate: {e}"))?;
        let files = rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| format!("decode wormhole cross gate: {e}"))?;
        decisions.push(GateDecision {
            source_id: route.source_id, target_id: route.target_id,
            accepted: files.len() >= 2, witness_file_ids: files,
        });
    }
    model.routes.retain(|route| decisions.iter().any(|d|
        d.source_id == route.source_id && d.target_id == route.target_id && d.accepted));
    Ok(decisions)
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
    fn gate_counts_distinct_files_not_rows_and_applies_scope_before_admission() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE file_tags(file_id INTEGER, tag_id INTEGER);
            CREATE INDEX tags_lookup ON file_tags(tag_id,file_id);
            INSERT INTO file_tags VALUES (10,1),(10,2),(10,2),(11,1);").unwrap();
        let mut single = model();
        let decisions = gate(&mut single, &db, None).unwrap();
        assert!(!decisions[0].accepted);
        assert_eq!(decisions[0].witness_file_ids, vec![10]);
        assert!(single.routes.is_empty());
        db.execute("INSERT INTO file_tags VALUES (11,2)", []).unwrap();
        let mut both = model();
        assert!(gate(&mut both, &db, None).unwrap()[0].accepted);
        assert_eq!(both.routes.len(), 1);
        for scope in [HashSet::new(), HashSet::from([10])] {
            let mut restricted = model();
            assert!(!gate(&mut restricted, &db, Some(&scope)).unwrap()[0].accepted);
            assert!(restricted.routes.is_empty());
        }
    }
}