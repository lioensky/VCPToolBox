//! Ordinary Hop-1 proxy readout. Historical XW/RRF fixtures are test-only.
use super::*;

#[cfg(test)]
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

#[cfg(test)]
#[derive(Default)]
pub(super) struct Model {
    pub routes: Vec<Route>,
}


// Legacy additive readout retained only for regression tests.
#[cfg(test)]
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

#[cfg(test)]
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
    routes.truncate(input.config.maximum_river_edges.max(1));
    Model { routes }
}

#[cfg(test)]
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

#[cfg(test)]
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

#[cfg(test)]
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


pub(super) fn apply_ordinary_proxy(
    work: &mut [ScoredWork], input: &NativeInput, omega: &OmegaOutput, artifact: &NativeArtifact,
) -> HashMap<i64, Value> {
    apply_proxy_impl(work, input, omega, artifact, |_| Correction::default())
}

// Keep historical scoring fixtures executable without compiling legacy route logic into release.
#[cfg(test)]
fn apply_unified_bonus(
    work: &mut [ScoredWork], model: &Model, input: &NativeInput,
    omega: &OmegaOutput, artifact: &NativeArtifact,
) -> HashMap<i64, Value> {
    apply_proxy_impl(work, input, omega, artifact, |curve| correction(model, curve, input, omega))
}

fn apply_proxy_impl(
    work: &mut [ScoredWork], input: &NativeInput, omega: &OmegaOutput, artifact: &NativeArtifact,
    historical_correction: impl Fn(&Curve) -> Correction,
) -> HashMap<i64, Value> {
    let explicit: HashSet<i64> = input.query_state.field_provenance.iter()
        .filter(|p| p.hop == 0 && matches!(p.source_type.as_str(), "core" | "lexical_seed"))
        .map(|p| p.id).collect();
    let hops: HashMap<i64, i64> = input.query_state.river_nodes.iter()
        .map(|n| (n.id,n.hop)).collect();
    let gate = omega.omega.powf(input.config.omega_gamma.max(0.0));
    let cap = positive(input.config.topology_bonus_cap);
    let mut traces = HashMap::new();
    for item in work {
        let xw = historical_correction(&item.curve);
        let mut proxy = 0.0_f64;
        let mut proxy_edge = None;
        if input.query_state.complete_observation {
            for edge in &input.query_state.river_edges {
                if edge.wormhole || edge.immediate_return
                    || !explicit.contains(&edge.source_id)
                    || hops.get(&edge.target_id) != Some(&1)
                    || positive(edge.flow) == 0.0 { continue; }
                let conductance = artifact.edge_weight(edge.source_id, edge.target_id);
                let Some(&source) = artifact.node_index.get(&edge.source_id) else { continue };
                let row = artifact.row_offsets[source]..artifact.row_offsets[source+1];
                let total: f64 = row.clone().map(|i| positive(artifact.weights[i])).sum();
                let strongest = row.map(|i| positive(artifact.weights[i])).fold(0.0_f64,f64::max);
                if conductance <= 0.0 || conductance < 0.5 * strongest || total <= 0.0 { continue; }
                let closure = item.curve.tags.iter().filter(|t| t.id == edge.target_id)
                    .map(|t| t.chunk_cosine).fold(0.0_f64, f64::max);
                let evidence = clamp01(conductance / total) * closure * gate;
                if evidence > proxy {
                    proxy = evidence;
                    proxy_edge = Some((edge.source_id, edge.target_id));
                }
            }
        }
        let transport = cap * proxy.max(xw.evidence);
        // Rebuild from immutable raw evidence, not the previous merged result.
        // Noisy-OR is a bounded complement operator, not an independence claim.
        let previous = (item.v2_bonus * gate).min(positive(cap - item.path_bonus));
        let merged = if transport <= 0.0 { previous }
        else if previous <= 0.0 { transport }
        else if cap > 0.0 {
            cap * (1.0 - (1.0 - clamp01(previous / cap))
                * (1.0 - clamp01(transport / cap)))
        } else { 0.0 };
        item.gated_bonus = merged.min(positive(cap - item.path_bonus));
        item.final_score = clamp01(item.pure_score + item.path_bonus
            + item.gated_bonus + item.anchor_bonus);
        item.ranking_score = item.final_score;
        // Only the optional topology trace consumes this JSON; score clipping
        // and ranking use the numeric fields above directly.
        if !input.include_trace { continue; }
        traces.insert(item.curve.id, serde_json::json!({
            "mode":"continuous-shared-topology-budget", "active": xw.eligible || proxy > 0.0,
            "wormhole":xw, "proxyEvidence":proxy, "proxyEdge":proxy_edge,
            "previousGraphBonus":previous, "transportRequested":transport,
            "appliedGraphBonus":item.gated_bonus, "finalScore":item.final_score
        }));
    }
    traces
}
/// Historical B scorer, available only to document the retired contract.
#[cfg(test)]
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
    for item in work.iter_mut() {
        item.ranking_score = item.final_score;
    }
    if reference <= 0.0 || work.is_empty() { return traces; }
    let mut contributions = vec![0.0_f64; work.len()];
    let mut winners = vec![Value::Null; work.len()];
    for route in &model.routes {
        let single = Model { routes: vec![route.clone()] };
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
        item.ranking_score = if active { baseline_rrf + contributions[i] } else { baseline };
        traces.insert(item.curve.id, serde_json::json!({
            "active": active, "k": K, "baselineRank": i + 1,
            "baselineScore": baseline, "baselineContribution": baseline_rrf,
            "wormholeContribution": contributions[i], "winner": winners[i],
            "fusedScore": item.ranking_score,
            "referenceMode": if ordinary_max > 0.0 { "maximum-observed-ordinary-flow" }
                else { "maximum-observed-flow-no-ordinary-edge" }
        }));
    }
    traces
}

#[cfg(test)]
mod score_contract_fixture_tests {
    use super::*;
    use serde_json::json;

    fn candidate(id: i64, baseline: f64, eligible: bool) -> ScoredWork {
        ScoredWork {
            curve: Curve {
                id, file_id: id,
                tags: if eligible { vec![TagData { id: 2, name: "synthetic-target".into(),
                    position: 0, vector: Arc::from(vec![1.0_f32,0.0]), chunk_cosine: 1.0 }] } else { vec![] },
                chunk_vector: Arc::from(if eligible { vec![1.0_f32,0.0] } else { vec![0.0_f32,1.0] }),
                query_score: baseline, denoised_score: baseline, local_score: baseline,
                transfer_score: baseline, bm25_score: 0.0, time_score: 0.0,
                anchor_score: 0.0, union_score: baseline, union_rank: id as usize, sources: vec![],
            },
            geometry: GeometryOutput::default(), topology: TopologyOutput::default(),
            observables: ObservableOutput::default(), pure_score: baseline, field_score: baseline,
            field_resonance_bonus: 0.0, graph_score: 0.0, direct_evidence: 0.0,
            role: String::new(), anchor: AnchorOutput::default(), v2_bonus: 0.0,
            gated_bonus: 0.0, path_bonus: 0.0, anchor_bonus: 0.0,
            final_score: baseline, ranking_score: -1.0,
        }
    }

    #[test]
    fn public_dataset_preserves_rrf_order_and_candidate_quality_scores() {
        let fixture: Value = serde_json::from_str(include_str!("../tests/fixtures/rrf_score_contract.json")).unwrap();
        let omega_value = fixture["omega"].as_f64().unwrap();
        let omega = OmegaOutput { omega: omega_value, omega_edge: 1.0, omega_emerge: 1.0,
            omega_flow: 1.0, regime: "dense".into(), active_edges: 3,
            seed_nodes: 1, reached_nodes: 3, emergent_nodes: 2, complete_observation: true };
        for scenario in fixture["scenarios"].as_array().unwrap() {
            for trace in [true, false] {
                let ordinary = scenario["ordinaryFlow"].as_f64().unwrap();
                let flows: Vec<f64> = scenario["flows"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
                let mut edges = vec![];
                if ordinary > 0.0 {
                    edges.push(json!({"sourceId":1,"targetId":4,"flow":ordinary,"wormhole":false}));
                    edges.push(json!({"sourceId":1,"targetId":1,"flow":99,"wormhole":false}));
                    edges.push(json!({"sourceId":4,"targetId":1,"flow":88,"wormhole":false,"immediateReturn":true}));
                }
                for flow in &flows { edges.push(json!({"sourceId":1,"targetId":2,"flow":flow,"wormhole":true})); }
                let mut input: NativeInput = serde_json::from_value(json!({
                    "query":{"vector":[1,0]}, "queryState":{"completeObservation":true,
                    "fieldProvenance":[{"id":1,"hop":0,"sourceType":"core"}],"riverEdges":edges}
                })).unwrap();
                input.include_trace = trace;
                let model = Model { routes: flows.iter().map(|flow| Route {
                    source_id: 1, target_id: 2, flow: *flow, relative_flow: 1.0,
                    vector: Arc::from(vec![1.0_f32,0.0]),
                }).collect() };
                let mut items: Vec<_> = fixture["candidates"].as_array().unwrap().iter().map(|c|
                    candidate(c["id"].as_i64().unwrap(), c["baseline"].as_f64().unwrap(), c["eligible"].as_bool().unwrap())).collect();
                let baseline: Vec<_> = items.iter().map(|c| c.final_score.to_bits()).collect();
                let diagnostics = fuse_rrf(&mut items, &model, &input, &omega);
                let reference = scenario["reference"].as_f64().unwrap();
                let active = !flows.is_empty();
                let weight = if active {
                    flows.iter().copied().fold(0.0_f64, f64::max) / reference
                        * omega_value.powf(input.config.omega_gamma.max(0.0))
                } else { 0.0 };
                for (i,item) in items.iter().enumerate() {
                    assert_eq!(item.final_score.to_bits(), baseline[i]);
                    let expected = if active { 1.0/(61+i) as f64
                        + if i > 0 { weight/(60+i) as f64 } else { 0.0 }
                    } else { item.final_score };
                    assert!((item.ranking_score-expected).abs() <= 1e-15, "{}", scenario["name"]);
                    if reference > 0.0 {
                        assert_eq!(diagnostics[&item.curve.id]["fusedScore"], json!(item.ranking_score));
                    }
                }
                items.sort_by(|a,b| b.ranking_score.total_cmp(&a.ranking_score));
                assert_eq!(json!(items.iter().map(|c| c.curve.id).collect::<Vec<_>>()), scenario["expectedOrder"]);
                assert_eq!(items.iter().filter(|c| c.final_score >= fixture["threshold"].as_f64().unwrap()).count(), 2);
                assert_eq!(items.iter().find(|c| c.curve.id==10).unwrap().final_score, 0.4);
            }
        }
        assert!(fuse_rrf(&mut [], &Model::default(),
            &serde_json::from_value(json!({"query":{"vector":[1,0]},"queryState":{}})).unwrap(), &omega).is_empty());
    }

    #[test]
    fn unified_score_closes_and_does_not_depend_on_unrelated_candidates() {
        let input: NativeInput = serde_json::from_value(json!({
            "query":{"vector":[1,0]}, "queryState":{
                "completeObservation":true,
                "fieldProvenance":[{"id":1,"hop":0,"sourceType":"core"}]
            }
        })).unwrap();
        let omega = OmegaOutput { omega:1.0, omega_edge:1.0, omega_emerge:1.0,
            omega_flow:1.0, regime:"dense".into(), active_edges:1,
            seed_nodes:1,reached_nodes:2,emergent_nodes:1,complete_observation:true };
        let model = Model { routes:vec![Route {
            source_id:1,target_id:2,flow:1.0,relative_flow:1.0,
            vector:Arc::from(vec![1.0_f32,0.0]),
        }] };
        let mut work = vec![candidate(1,0.5,true)];
        apply_unified_bonus(&mut work,&model,&input,&omega,&NativeArtifact::default());
        let score = work[0].final_score;
        assert!(score > 0.5);
        assert_eq!(score.to_bits(),work[0].ranking_score.to_bits());
        assert!(work[0].path_bonus+work[0].gated_bonus <= input.config.topology_bonus_cap);
        work.push(candidate(2,0.9,false));
        apply_unified_bonus(&mut work,&model,&input,&omega,&NativeArtifact::default());
        assert_eq!(score.to_bits(),work[0].final_score.to_bits());
        assert_eq!(work[1].final_score,0.9);
    }

    #[test]
    fn unified_trace_is_optional_and_preserves_score_bits() {
        let mut input: NativeInput = serde_json::from_value(json!({
            "query":{"vector":[1,0]}, "queryState":{
                "completeObservation":true,
                "fieldProvenance":[{"id":1,"hop":0,"sourceType":"core"}],
                "riverNodes":[{"id":1,"hop":0},{"id":2,"hop":1}],
                "riverEdges":[{"sourceId":1,"targetId":2,"flow":0.1}]
            }
        })).unwrap();
        let omega = compute_omega(&input);
        let graph = NativeArtifact {
            node_ids:vec![1,2], node_index:HashMap::from([(1,0),(2,1)]),
            row_offsets:vec![0,1,1], targets:vec![1], weights:vec![0.4],
            ..NativeArtifact::default()
        };
        let model = Model { routes:vec![Route {
            source_id:1,target_id:2,flow:1.0,relative_flow:0.625,
            vector:Arc::from(vec![1.0_f32,0.0]),
        }] };
        let mut expected = None;
        for trace in [true, false] {
            input.include_trace = trace;
            let mut work = vec![candidate(1,0.5,true),candidate(2,0.5,false)];
            work[0].v2_bonus = 0.013;
            let traces = apply_unified_bonus(&mut work,&model,&input,&omega,&graph);
            assert_eq!(traces.len(), if trace { work.len() } else { 0 });
            let bits = work.iter().map(|item| (item.curve.id,
                item.gated_bonus.to_bits(), item.final_score.to_bits(), item.ranking_score.to_bits()))
                .collect::<Vec<_>>();
            if trace {
                for item in &work {
                    assert_eq!(traces[&item.curve.id]["finalScore"].as_f64().unwrap().to_bits(),
                        item.final_score.to_bits());
                }
                expected = Some(bits);
            } else {
                assert_eq!(&bits, expected.as_ref().unwrap());
            }
        }
    }

    #[test]
    fn complementary_graph_and_transport_are_bounded_and_idempotent() {
        let input: NativeInput = serde_json::from_value(json!({
            "query":{"vector":[1,0]}, "queryState":{
                "completeObservation":true,
                "fieldProvenance":[{"id":1,"hop":0,"sourceType":"core"}]
            }
        })).unwrap();
        let omega = OmegaOutput { omega:1.0, omega_edge:1.0, omega_emerge:1.0,
            omega_flow:1.0, regime:"dense".into(), active_edges:1,
            seed_nodes:1,reached_nodes:2,emergent_nodes:1,complete_observation:true };
        let model = Model { routes:vec![Route {
            source_id:1,target_id:2,flow:1.0,relative_flow:0.625,
            vector:Arc::from(vec![1.0_f32,0.0]),
        }] };
        let mut work=vec![candidate(1,0.5,true)];
        let cap=input.config.topology_bonus_cap;
        work[0].v2_bonus=0.5*cap;
        work[0].gated_bonus=0.5*cap;
        apply_unified_bonus(&mut work,&model,&input,&omega,&NativeArtifact::default());
        assert!((work[0].gated_bonus-cap*0.8125).abs()<1e-14);
        let bits=work[0].final_score.to_bits();
        for _ in 0..5 {
            apply_unified_bonus(&mut work,&model,&input,&omega,&NativeArtifact::default());
            assert_eq!(work[0].final_score.to_bits(),bits);
            assert_eq!(work[0].ranking_score.to_bits(),bits);
        }
        work[0].path_bonus=0.75*cap;
        apply_unified_bonus(&mut work,&model,&input,&omega,&NativeArtifact::default());
        assert!(work[0].path_bonus+work[0].gated_bonus<=cap);
        let mut empty=vec![candidate(2,0.5,false)];
        empty[0].v2_bonus=0.013;
        apply_unified_bonus(&mut empty,&Model::default(),&input,&omega,&NativeArtifact::default());
        assert_eq!(empty[0].gated_bonus.to_bits(),0.013_f64.to_bits());
    }

    #[test]
    fn ordinary_proxy_requires_real_forward_hop_one_and_shares_budget() {
        let mut input: NativeInput = serde_json::from_value(json!({
            "query":{"vector":[1,0]}, "queryState":{
                "completeObservation":true,
                "fieldProvenance":[{"id":1,"hop":0,"sourceType":"core"}],
                "riverNodes":[{"id":1,"hop":0},{"id":2,"hop":1}],
                "riverEdges":[{"sourceId":1,"targetId":2,"flow":0.1}]
            }
        })).unwrap();
        let omega = OmegaOutput { omega:1.0, omega_edge:1.0, omega_emerge:1.0,
            omega_flow:1.0, regime:"dense".into(), active_edges:1,
            seed_nodes:1,reached_nodes:2,emergent_nodes:1,complete_observation:true };
        let graph = NativeArtifact {
            node_ids:vec![1,2], node_index:HashMap::from([(1,0),(2,1)]),
            row_offsets:vec![0,1,1], targets:vec![1], weights:vec![0.4],
            ..NativeArtifact::default()
        };
        let score = |input: &NativeInput, graph: &NativeArtifact, omega: &OmegaOutput| {
            let mut items = vec![candidate(1,0.5,true)];
            apply_ordinary_proxy(&mut items,input,omega,graph);
            assert_eq!(items[0].ranking_score,items[0].final_score);
            assert!(items[0].path_bonus+items[0].gated_bonus <= input.config.topology_bonus_cap);
            items[0].final_score
        };
        assert!(score(&input,&graph,&omega)>0.5);
        assert_eq!(score(&input,&NativeArtifact::default(),&omega),0.5);
        input.query_state.river_edges[0].immediate_return=true;
        assert_eq!(score(&input,&graph,&omega),0.5);
        input.query_state.river_edges[0].immediate_return=false;
        input.query_state.river_nodes[1].hop=2;
        assert_eq!(score(&input,&graph,&omega),0.5);
        input.query_state.river_nodes[1].hop=1;
        let mut zero=omega.clone();
        zero.omega=0.0;
        assert_eq!(score(&input,&graph,&zero),0.5);
    }

    #[test]
    fn inactive_keys_keep_complete_baseline_tie_order() {
        let input: NativeInput = serde_json::from_value(json!({"query":{"vector":[1,0]},"queryState":{}})).unwrap();
        let omega = compute_omega(&input);
        let mut items = vec![candidate(30,0.6,false),candidate(10,0.6,false),candidate(20,0.6,false)];
        fuse_rrf(&mut items,&Model::default(),&input,&omega);
        items.sort_by(|a,b| b.ranking_score.total_cmp(&a.ranking_score));
        assert_eq!(items.iter().map(|c|c.curve.id).collect::<Vec<_>>(),vec![30,10,20]);
    }
}
