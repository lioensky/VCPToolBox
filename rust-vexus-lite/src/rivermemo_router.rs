use super::*;

fn explanation_roots(input: &NativeInput) -> HashSet<i64> {
    let explicit: HashSet<i64> = input.query_state.field_provenance.iter()
        .filter(|p| p.hop == 0 && matches!(p.source_type.as_str(), "core" | "lexical_seed"))
        .map(|p| p.id).collect();
    if !explicit.is_empty() { return explicit; }
    input.query_state.field_provenance.iter()
        .filter(|p| p.hop == 0 && p.source_type == "seed")
        .map(|p| p.id).collect()
}

/// Readout-only explanation graph. Does not rewrite Sense or its dual fields.
pub(super) fn explain(input: &mut NativeInput, artifact: &NativeArtifact,
    admitted: &HashSet<(i64, i64)>) {
    let mut edges = BTreeMap::<(i64, i64), RiverEdge>::new();
    for edge in &input.query_state.river_edges {
        if edge.source_id <= 0 || edge.target_id <= 0
            || edge.source_id == edge.target_id || edge.immediate_return
            || positive(edge.flow) == 0.0
            || artifact.edge_weight(edge.source_id, edge.target_id) <= 0.0
            || (edge.wormhole && !admitted.contains(&(edge.source_id, edge.target_id))) {
            continue;
        }
        let key = (edge.source_id, edge.target_id);
        if edges.get(&key).is_none_or(|old| old.flow < edge.flow) {
            edges.insert(key, edge.clone());
        }
    }
    let mut reached = explanation_roots(input);
    loop {
        let before = reached.len();
        for edge in edges.values() {
            if reached.contains(&edge.source_id) { reached.insert(edge.target_id); }
        }
        if reached.len() == before { break; }
    }
    let mut retained: Vec<_> = edges.into_values()
        .filter(|e| reached.contains(&e.source_id)).collect();
    retained.sort_by(|a,b| b.flow.total_cmp(&a.flow)
        .then_with(|| a.source_id.cmp(&b.source_id))
        .then_with(|| a.target_id.cmp(&b.target_id)));
    retained.truncate(input.config.maximum_river_edges.max(1));
    // Only nodes belonging to retained relations or explicit roots remain.
    let mut nodes = explanation_roots(input);
    let maximum = retained.iter().map(|e| e.flow).fold(0.0_f64, f64::max);
    for edge in &mut retained {
        nodes.insert(edge.source_id);
        nodes.insert(edge.target_id);
        edge.normalized_flow = if maximum > 0.0 { edge.flow / maximum } else { 0.0 };
    }
    input.query_state.river_nodes.retain(|n| nodes.contains(&n.id));
    input.query_state.river_edges = retained;
}

fn branch_score(relative: f64, body: f64) -> f64 {
    clamp01(relative) * clamp01(body)
}

fn body_grounding(body: f64) -> f64 {
    // Absolute evidence, never rescaled by the strongest edge/candidate.
    let x = clamp01((body - 0.48) / (0.65 - 0.48));
    x * x * (3.0 - 2.0 * x)
}

fn correct(baseline: f64, topology: f64, confidence: f64) -> f64 {
    // Exact no-op (including bits) when evidence is unavailable.
    if confidence <= 0.0 || topology <= 0.0 { return baseline; }
    baseline + (1.0 - baseline) * clamp01(confidence) * clamp01(topology)
}

pub(super) fn route(work: &mut [ScoredWork], input: &NativeInput,
    vectors: &TagVectorPool, omega: &OmegaOutput) -> HashMap<i64, Value> {
    // Shared target capacity: duplicate/alias incoming relations cannot stack votes.
    let mut targets = BTreeMap::<i64, f64>::new();
    for edge in &input.query_state.river_edges {
        if vectors.contains_key(&edge.target_id) {
            let weight = targets.entry(edge.target_id).or_default();
            *weight = weight.max(positive(edge.flow));
        }
    }
    // Explicit roots identify the query, not downstream relation evidence.
    let roots = explanation_roots(input);
    targets.retain(|id, _| !roots.contains(id));
    let total: f64 = targets.values().sum();
    let maximum = targets.values().copied().fold(0.0_f64, f64::max);
    let evidence: Vec<(f64, f64, usize, f64, f64, Value)> = work.par_iter().map(|item| {
        let mut mass = 0.0;
        let mut body_mass = 0.0;
        let mut count = 0;
        // Candidate Tag capacity is one, with exact identity preferred.
        let mut bindings = Vec::new();
        for (&id, &flow) in &targets {
            let vector = &vectors[&id];
            let body = clamp01(cosine(vector, &item.curve.chunk_vector));
            if body <= 0.0 { continue; }
            for tag in &item.curve.tags {
                let exact = tag.id == id;
                let similarity = if exact { 1.0 } else { cosine(vector, &tag.vector) };
                if similarity <= input.config.semantic_node_threshold || tag.chunk_cosine <= 0.0 {
                    continue;
                }
                let credit = if exact { 1.0 } else {
                    clamp01((similarity - input.config.semantic_node_threshold)
                        / (1.0 - input.config.semantic_node_threshold).max(1e-9))
                };
                let support = credit * tag.chunk_cosine.sqrt();
                bindings.push((exact, id, tag.id, flow, support, body, similarity, tag.chunk_cosine));
            }
        }
        // Capacity follows grounded evidence, not just flow or exact addresses.
        bindings.sort_by(|a,b| (b.3*b.5*b.4.sqrt()*body_grounding(b.5))
            .total_cmp(&(a.3*a.5*a.4.sqrt()*body_grounding(a.5)))
            .then_with(|| b.0.cmp(&a.0))
            .then_with(|| a.1.cmp(&b.1)).then_with(|| a.2.cmp(&b.2)));
        let mut strongest = 0.0_f64;
        let mut availability = 0.0_f64;
        let mut winner = Value::Null;
        let mut used_nodes = HashSet::new();
        let mut used_tags = HashSet::new();
        for (exact, id, tag, flow, support, body, similarity, tag_closure) in bindings {
            if used_nodes.contains(&id) || used_tags.contains(&tag) { continue; }
            used_nodes.insert(id);
            used_tags.insert(tag);
            mass += flow * support;
            body_mass += flow * support * body;
            count += 1;
            let relative = if maximum > 0.0 { clamp01(flow / maximum) } else { 0.0 };
            let confidence = support.sqrt() * body_grounding(body);
            let score = branch_score(relative, body);
            if score * confidence > strongest * availability {
                availability = confidence;
                strongest = score;
                winner = serde_json::json!({
                    "targetId": id, "matchedTagId": tag, "flow": flow,
                    "relativeFlow": relative, "bodyCosine": body,
                    "score": score, "thresholdQualified": true,
                    "exactTarget": exact, "tagSimilarity": similarity,
                    "tagBodyClosure": tag_closure, "matchSupport": support,
                    "bodyGrounding": body_grounding(body),
                    "candidateConfidence": confidence
                });
            }
        }
        let coverage = if total > 0.0 { clamp01(mass / total) } else { 0.0 };
        let closure = if mass > 0.0 { clamp01(body_mass / mass) } else { 0.0 };
        (coverage, closure, count, strongest, availability, winner)
    }).collect();
    let observation_gate = if input.query_state.complete_observation && total > 0.0 {
        clamp01(omega.omega.powf(input.config.omega_gamma.max(0.0)))
    } else { 0.0 };
    let mut traces = HashMap::new();
    for (item, (coverage, closure, count, topology, availability, winner))
        in work.iter_mut().zip(evidence) {
        let baseline = item.final_score;
        let gt = observation_gate * availability;
        let vector = clamp01(item.curve.query_score);
        item.final_score = correct(baseline, topology, gt);
        traces.insert(item.curve.id, serde_json::json!({
            "baselineScore": baseline, "topologyScore": topology,
            "groundedCoverage": coverage, "endpointClosure": closure,
            "matchedTargets": count, "explanationTargets": targets.len(),
            "explanationEdges": input.query_state.river_edges.len(),
            "supportedEvidence": availability, "topologyGate": gt,
            "topologyWeight": gt, "baselineWeight": 1.0,
            "correction": item.final_score - baseline,
            "anchorScore": item.anchor.strength,
            "vectorScore": vector, "finalScore": item.final_score,
            "strongestBranch": winner, "branchAvailability": availability,
            "topologyReadout": "best-candidate-grounded-branch; positive-headroom-correction",
            "fieldPolicy": "complete-original-baseline-frozen-before-explanation-filter",
            "mode": "complete-baseline-candidate-local-positive-correction"
        }));
    }
    traces
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn correction_preserves_baseline_and_weak_body_cannot_authorize() {
        let baseline = 0.73123456789_f64;
        assert_eq!(correct(baseline, 1.0, 0.0).to_bits(), baseline.to_bits());
        assert_eq!(correct(baseline, 0.0, 1.0).to_bits(), baseline.to_bits());
        assert_eq!(body_grounding(0.47717143), 0.0);
        assert!(body_grounding(0.50) < 0.04);
        assert_eq!(body_grounding(0.65), 1.0);
        assert!(correct(baseline, 0.8, 0.9) > baseline);
        assert!(correct(baseline, 0.8, 0.9) <= 1.0);
    }
    #[test]
    fn rejected_wormhole_and_implicit_component_leave_explanation_graph() {
        let mut input: NativeInput = serde_json::from_value(serde_json::json!({
            "query":{"vector":[1,0]}, "queryState":{
                "fieldProvenance":[{"id":1,"hop":0,"sourceType":"lexical_seed"}],
                "riverNodes":[{"id":1},{"id":2,"hop":1},{"id":3},{"id":4,"hop":1}],
                "riverEdges":[
                    {"sourceId":1,"targetId":2,"flow":0.02},
                    {"sourceId":3,"targetId":4,"flow":0.1,"wormhole":true}]
            }
        })).unwrap();
        let artifact = NativeArtifact {
            node_ids:vec![1,2,3,4],
            node_index:HashMap::from([(1,0),(2,1),(3,2),(4,3)]),
            row_offsets:vec![0,1,1,2,2], targets:vec![1,3], weights:vec![1.0,1.0],
            ..NativeArtifact::default()
        };
        explain(&mut input, &artifact, &HashSet::new());
        assert_eq!(input.query_state.river_edges.len(),1);
        assert_eq!(input.query_state.river_nodes.len(),2);
        assert_eq!(input.query_state.river_edges[0].normalized_flow,1.0);
        // Semantic-only queries must retain their real ordinary graph.
        input.query_state.field_provenance[0].source_type = "seed".into();
        explain(&mut input, &artifact, &HashSet::new());
        assert_eq!(input.query_state.river_edges.len(),1);
        assert_eq!(input.query_state.river_nodes.len(),2);
    }
}

#[cfg(test)]
mod branch_regressions {
    use super::*;

    #[test]
    fn strong_semantic_branch_survives_weak_exact_address_and_beats_brand_anchor() {
        let mut input: NativeInput = serde_json::from_value(serde_json::json!({
            "query":{"vector":[1,0]},
            "queryState":{"fieldProvenance":[
                {"id":1,"hop":0,"sourceType":"lexical_seed"}],
                "riverEdges":[
                    {"sourceId":1,"targetId":2,"flow":0.108},
                    {"sourceId":1,"targetId":3,"flow":0.014}]}
        })).unwrap();
        let vectors: TagVectorPool = HashMap::from([
            (2, Arc::from(vec![0.0_f32,1.0])),
            (3, Arc::from(vec![0.85_f32,0.5267827]))
        ]);
        let curve = |id, body: Vec<f32>, tags| Curve {
            id, file_id:id, tags, chunk_vector:Arc::from(body),
            query_score:0.6, denoised_score:0.6, local_score:0.6,
            transfer_score:0.6, bm25_score:0.0, time_score:0.0,
            anchor_score:0.0, union_score:0.0, union_rank:id as usize, sources:vec![]
        };
        let tag = |id, vector: Vec<f32>| TagData {
            id, name:id.to_string(), position:0, vector:Arc::from(vector), chunk_cosine:0.6
        };
        let item = |curve, anchor| ScoredWork {
            curve, anchor, geometry:GeometryOutput::default(),
            topology:TopologyOutput::default(), observables:ObservableOutput::default(),
            pure_score:0.6, field_score:0.6, field_resonance_bonus:0.0,
            graph_score:0.0, direct_evidence:0.0, role:String::new(),
            v2_bonus:0.0, gated_bonus:0.0, path_bonus:0.0, anchor_bonus:0.0,
            final_score:0.6
        };
        let event = item(curve(10,vec![0.0,1.0],
            vec![tag(3,vec![0.85,0.5267827])]),AnchorOutput::default());
        let phone = item(curve(11,vec![1.0,0.0],vec![tag(1,vec![1.0,0.0])]),
            AnchorOutput { strength:0.31, explicit_exact_contacts:1, ..AnchorOutput::default() });
        let omega = OmegaOutput {
            omega:0.96, omega_edge:1.0, omega_emerge:1.0, omega_flow:0.9,
            regime:"dense".into(),active_edges:2, seed_nodes:1,reached_nodes:3,
            emergent_nodes:2,complete_observation:true
        };
        let mut work = vec![event,phone.clone()];
        let traces = route(&mut work,&input,&vectors,&omega);
        assert_eq!(traces[&10]["strongestBranch"]["targetId"],2);
        assert_eq!(traces[&10]["topologyScore"],1.0);
        assert!(work[0].final_score > work[1].final_score);
        let mut alone = vec![phone];
        route(&mut alone,&input,&vectors,&omega);
        assert_eq!(work[1].final_score.to_bits(), alone[0].final_score.to_bits());
        let saved: Vec<_> = work.iter().map(|w| w.final_score.to_bits()).collect();
        input.query_state.river_edges.clear();
        let traces = route(&mut work,&input,&vectors,&omega);
        assert_eq!(traces[&10]["topologyWeight"],0.0);
        assert_eq!(saved, work.iter().map(|w| w.final_score.to_bits()).collect::<Vec<_>>());
        // No other candidate can authorize a weak endpoint match.
        input.query_state.river_edges.push(RiverEdge {
            source_id:1, target_id:2, flow:1.0, normalized_flow:1.0,
            wormhole:false, immediate_return:false
        });
        let mut weak = work[0].clone();
        weak.curve.id = 12;
        weak.curve.chunk_vector = Arc::from(vec![0.878803_f32,0.47717143]);
        weak.final_score = 0.73;
        let mut pair = vec![work[0].clone(), weak];
        let traces = route(&mut pair,&input,&vectors,&omega);
        assert!(traces[&10]["topologyWeight"].as_f64().unwrap() > 0.0);
        assert_eq!(traces[&12]["topologyWeight"], 0.0);
        assert_eq!(pair[1].final_score.to_bits(), 0.73_f64.to_bits());
    }
}