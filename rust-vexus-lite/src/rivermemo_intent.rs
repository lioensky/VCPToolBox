//! Request-local intent readout. Ignition amplitudes never allocate intent votes.
use super::*;

const ALIAS_COSINE: f64 = 0.95;
const SATISFACTION_FLOOR: f64 = 0.05;

struct IntentAxis {
    ids: Vec<i64>,
    vector: Vec<f32>,
    residual: Vec<f32>,
    residual_energy: f64,
    query_explanation: f64,
    weight: f64,
}

pub(super) struct IntentModel {
    axes: Vec<IntentAxis>,
    routes: Vec<(i64, i64, f64, bool)>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IntentEvidence {
    seed_ids: Vec<i64>,
    weight: f64,
    residual_energy: f64,
    query_explanation: f64,
    direct_support: f64,
    wormhole_support: f64,
    satisfaction: f64,
    route_source: Option<i64>,
    route_target: Option<i64>,
    route_current: f64,
    endpoint_grounding: f64,
    route_is_wormhole: bool,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IntentOutput {
    pub(super) available: bool,
    pub(super) satisfaction: f64,
    pub(super) direct_satisfaction: f64,
    /// Compatibility name: marginal lift from all source-attributed observed edges.
    pub(super) wormhole_lift: f64,
    pub(super) ledger: Vec<IntentEvidence>,
}

fn unit(vector: &[f32]) -> Option<Vec<f32>> {
    let norm = squared_norm(vector).sqrt();
    (norm.is_finite() && norm > 1e-8)
        .then(|| vector.iter().map(|v| (*v as f64 / norm) as f32).collect())
}

/// Two-pass orthogonalization, with stable ID order and no matrix inversion.
fn leave_one_out(vectors: &[Vec<f32>], index: usize) -> (Vec<f32>, f64) {
    let mut basis: Vec<Vec<f64>> = Vec::new();
    for (other, vector) in vectors.iter().enumerate() {
        if other == index { continue; }
        let mut v: Vec<f64> = vector.iter().map(|v| *v as f64).collect();
        for _ in 0..2 {
            for b in &basis {
                let dot: f64 = v.iter().zip(b).map(|(a, b)| a * b).sum();
                for (a, b) in v.iter_mut().zip(b) { *a -= dot * b; }
            }
        }
        let norm = v.iter().map(|v| v * v).sum::<f64>().sqrt();
        if norm > 1e-6 {
            for value in &mut v { *value /= norm; }
            basis.push(v);
        }
    }
    let mut residual: Vec<f64> = vectors[index].iter().map(|v| *v as f64).collect();
    for _ in 0..2 {
        for b in &basis {
            let dot: f64 = residual.iter().zip(b).map(|(a, b)| a * b).sum();
            for (a, b) in residual.iter_mut().zip(b) { *a -= dot * b; }
        }
    }
    let energy = clamp01(residual.iter().map(|v| v * v).sum());
    let norm = energy.sqrt();
    let direction = if norm > 1e-6 {
        residual.iter().map(|v| (v / norm) as f32).collect()
    } else { vectors[index].clone() };
    (direction, energy)
}

pub(super) fn build(
    seeds: &[(i64, f64)],
    explicit: &HashSet<i64>,
    vectors: &TagVectorPool,
    input: &NativeInput,
    artifact: &NativeArtifact,
) -> IntentModel {
    let mut entries: Vec<(i64, Vec<f32>)> = seeds.iter()
        .filter(|s| explicit.contains(&s.0))
        .filter_map(|s| vectors.get(&s.0).and_then(|v| unit(v)).map(|v| (s.0, v)))
        .collect();
    entries.sort_by_key(|s| s.0);
    entries.dedup_by_key(|s| s.0);
    // Complete-link clusters: no transitive alias chain may collapse distinct foci.
    let mut groups: Vec<Vec<usize>> = Vec::new();
    for i in 0..entries.len() {
        if let Some(group) = groups.iter_mut().find(|g|
            g.iter().all(|&j| cosine(&entries[i].1, &entries[j].1) >= ALIAS_COSINE)) {
            group.push(i);
        } else { groups.push(vec![i]); }
    }
    let representatives: Vec<Vec<f32>> = groups.iter().map(|group| {
        let mut mean = vec![0.0_f32; input.dimension];
        for &i in group {
            for (out, v) in mean.iter_mut().zip(&entries[i].1) { *out += *v; }
        }
        unit(&mean).unwrap_or_else(|| entries[group[0]].1.clone())
    }).collect();
    let mut axes: Vec<IntentAxis> = groups.iter().enumerate().map(|(i, group)| {
        let (residual, energy) = leave_one_out(&representatives, i);
        // The tag's independent energy is not its importance to this query.
        // Positive projection prevents an opposite independent direction gaining a vote.
        let query_explanation = if energy > 1e-10 {
            positive(cosine(&input.query.vector, &residual)).powi(2)
        } else { 0.0 };
        IntentAxis {
            ids: group.iter().map(|&j| entries[j].0).collect(),
            vector: representatives[i].clone(), residual,
            residual_energy: energy, query_explanation, weight: query_explanation,
        }
    }).collect();
    let total: f64 = axes.iter().map(|a| a.weight).sum();
    let count = axes.len().max(1) as f64;
    for axis in &mut axes {
        // If independent directions explain nothing, do not amplify numerical noise.
        axis.weight = if total > 1e-8 { axis.weight / total } else { 1.0 / count };
    }
    // Absolute current calibration; max-normalized flow alone is not confidence.
    let mut routes: Vec<(i64, i64, f64, bool)> = input.query_state.river_edges.iter()
        .filter(|e| !e.immediate_return && e.source_id != e.target_id
            && axes.iter().any(|a| a.ids.contains(&e.source_id))
            && artifact.edge_weight(e.source_id, e.target_id) > 0.0)
        .filter_map(|e| {
            let flow = positive(e.flow);
            (flow > 0.0).then_some((e.source_id, e.target_id, flow / (flow + 0.03), e.wormhole))
        }).collect();
    routes.sort_by(|a, b| b.2.total_cmp(&a.2).then(a.0.cmp(&b.0)).then(a.1.cmp(&b.1)));
    routes.truncate(input.config.maximum_river_edges.max(1));
    IntentModel { axes, routes }
}

fn endpoint_support(
    id: i64, vector: &[f32], curve: &Curve, cosines: &CosineCache,
) -> f64 {
    let body = clamp01(cosine(vector, &curve.chunk_vector));
    let tags = curve.tags.iter().map(|tag| {
        let similarity = if tag.id == id { 1.0 }
            else { clamp01(cosines.tag_pair(id, vector, tag)) };
        // Semantic credit has a baseline removed; exact identity still needs closure.
        let identity = if tag.id == id { 1.0 }
            else { clamp01((similarity - 0.48) / 0.52) };
        identity * tag.chunk_cosine
    }).fold(0.0_f64, f64::max);
    // Untagged but semantically grounded bodies remain eligible at lower confidence.
    tags.max(0.7 * clamp01((body - 0.45) / 0.55))
}

pub(super) fn evaluate(
    model: &IntentModel, curve: &Curve, vectors: &TagVectorPool, cosines: &CosineCache,
) -> IntentOutput {
    if model.axes.is_empty() { return IntentOutput::default(); }
    let mut log_direct = 0.0;
    let mut log_total = 0.0;
    let mut ledger = Vec::new();
    for axis in &model.axes {
        let body = clamp01((cosine(&axis.vector, &curve.chunk_vector) - 0.45) / 0.55);
        let tag_support = curve.tags.iter().map(|tag| {
            let exact = axis.ids.contains(&tag.id);
            let similarity = if exact { 1.0 } else { cosine(&axis.vector, &tag.vector) };
            let identity = if exact { 1.0 } else { clamp01((similarity - 0.48) / 0.52) };
            identity * tag.chunk_cosine
        }).fold(0.0_f64, f64::max);
        // Direct semantic contact must also express the independent query direction.
        // This is NOT applied to transferred evidence: a real edge supplies that relation.
        let residual_gain = if model.axes.len() > 1 && axis.residual_energy > 1e-10 {
            clamp01(cosine(&axis.residual, &curve.chunk_vector)).sqrt()
        } else { 1.0 };
        let direct = clamp01(tag_support.max(0.7 * body) * residual_gain);
        let mut route_best = 0.0;
        let mut source = None;
        let mut target = None;
        let mut route_current = 0.0;
        let mut endpoint_grounding = 0.0;
        let mut route_is_wormhole = false;
        for &(from, to, flow, wormhole) in &model.routes {
            // Exact source ownership replaces destination-to-source similarity.
            // Aggregated observations cannot establish arbitrary multi-hop lineage.
            if !axis.ids.contains(&from) { continue; }
            let Some(vector) = vectors.get(&to) else { continue };
            let grounding = endpoint_support(to, vector, curve, cosines);
            let support = flow * grounding;
            if support > route_best {
                route_best = support; source = Some(from); target = Some(to);
                route_current = flow; endpoint_grounding = grounding;
                route_is_wormhole = wormhole;
            }
        }
        let satisfaction = direct.max(route_best);
        log_direct += axis.weight * (SATISFACTION_FLOOR + direct).ln();
        log_total += axis.weight * (SATISFACTION_FLOOR + satisfaction).ln();
        ledger.push(IntentEvidence {
            seed_ids: axis.ids.clone(), weight: axis.weight,
            residual_energy: axis.residual_energy, query_explanation: axis.query_explanation,
            direct_support: direct,
            wormhole_support: route_best, satisfaction,
            route_source: source, route_target: target,
            route_current, endpoint_grounding, route_is_wormhole,
        });
    }
    // Remove the numerical floor: no evidence must produce exactly zero reward.
    let calibrate = |v: f64| {
        let score = clamp01(v.exp() - SATISFACTION_FLOOR);
        if score < 1e-12 { 0.0 } else { score }
    };
    let satisfaction = calibrate(log_total);
    let direct_satisfaction = calibrate(log_direct);
    IntentOutput { available: true, satisfaction, direct_satisfaction,
        wormhole_lift: positive(satisfaction - direct_satisfaction), ledger }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leave_one_residual_is_finite_and_duplicate_safe() {
        let vectors = vec![vec![1., 0., 0.], vec![1., 0., 0.], vec![0., 1., 0.]];
        let (_, redundant) = leave_one_out(&vectors, 0);
        let (_, independent) = leave_one_out(&vectors, 2);
        assert!(redundant < 1e-10);
        assert!((independent - 1.0).abs() < 1e-10);
    }

    #[test]
    fn conjunction_rejects_one_of_two_and_zero_has_no_reward() {
        let conjunction = |a: f64, b: f64|
            (((a + 0.05).ln() + (b + 0.05).ln()) / 2.0).exp() - 0.05;
        assert!(conjunction(0.8, 0.8) > conjunction(1.0, 0.0) * 3.0);
        assert!(conjunction(0.0, 0.0).abs() < 1e-12);
    }
}

#[cfg(test)]
mod readout_tests {
    use super::*;

    fn fixture() -> (NativeInput, NativeArtifact, TagVectorPool, Curve) {
        let input: NativeInput = serde_json::from_value(serde_json::json!({
            "dimension": 3, "query": {"vector": [1.0,0.0,0.0]},
            "queryState": {
                "riverEdges": [{
                    "sourceId": 1, "targetId": 3, "flow": 0.3,
                    "normalizedFlow": 1.0, "wormhole": true
                }]
            }
        })).unwrap();
        let artifact = NativeArtifact {
            node_ids: vec![1,3], node_index: HashMap::from([(1,0),(3,1)]),
            row_offsets: vec![0,1,1], targets: vec![1], weights: vec![0.5],
            ..NativeArtifact::default()
        };
        // Endpoint is related but deliberately below direct semantic-anchor identity.
        let pool: TagVectorPool = [
            (1, Arc::from(vec![1.0_f32,0.0,0.0])),
            (2, Arc::from(vec![1.0_f32,0.0,0.0])),
            (3, Arc::from(vec![0.6_f32,0.8,0.0])),
        ].into_iter().collect();
        let curve = Curve {
            id: 10, file_id: 10, tags: vec![TagData {
                id: 3, name: "event".into(), position: 0,
                vector: pool[&3].clone(), chunk_cosine: 1.0,
            }], chunk_vector: pool[&3].clone(),
            query_score: 0.6, denoised_score: 0.6, local_score: 0.6,
            transfer_score: 0.6, bm25_score: 0.0, time_score: 0.0,
            anchor_score: 0.0, union_score: 0.0, union_rank: 1, sources: vec![],
        };
        (input, artifact, pool, curve)
    }

    #[test]
    fn endpoint_only_wormhole_lifts_readout_without_fabricating_exact_identity() {
        let (input, artifact, pool, curve) = fixture();
        let cache = CosineCache::build(std::slice::from_ref(&curve),
            &input.query.vector, [1,3], &pool);
        let model = build(&[(1,1.0)], &HashSet::from([1]), &pool, &input, &artifact);
        let result = evaluate(&model, &curve, &pool, &cache);
        assert!(result.wormhole_lift > 0.1, "{}", serde_json::to_string(&result).unwrap());
        assert_eq!(result.ledger[0].route_target, Some(3));
        assert!(curve.tags.iter().all(|tag| tag.id != 1));
        // Evaluating unrelated peers cannot change a candidate's own evidence.
        let before = serde_json::to_string(&result).unwrap();
        let mut unrelated = curve.clone();
        unrelated.tags.clear();
        unrelated.chunk_vector = Arc::from(vec![0.0,0.0,1.0]);
        assert_eq!(evaluate(&model, &unrelated, &pool, &cache).satisfaction, 0.0);
        assert_eq!(before, serde_json::to_string(&evaluate(&model, &curve, &pool, &cache)).unwrap());
    }

    #[test]
    fn zero_current_return_and_nonexistent_edges_never_create_arrival_credit() {
        for mode in 0..4 {
            let (mut input, mut artifact, pool, curve) = fixture();
            match mode {
                0 => input.query_state.river_edges[0].flow = 0.0,
                1 => input.query_state.river_edges[0].immediate_return = true,
                2 => artifact.weights[0] = 0.0,
                _ => input.query_state.river_edges[0].source_id = 99,
            }
            let model = build(&[(1,1.0)], &HashSet::from([1]), &pool, &input, &artifact);
            let cache = CosineCache::build(std::slice::from_ref(&curve),
                &input.query.vector, [1,3], &pool);
            let result = evaluate(&model, &curve, &pool, &cache);
            assert_eq!(result.wormhole_lift, 0.0);
        }
    }

    #[test]
    fn orthogonal_endpoint_multi_intent_is_source_owned_and_small_lifts_survive() {
        let (mut input, artifact, mut pool, mut curve) = fixture();
        input.query.vector = vec![1.0, 1.0, 0.0];
        pool.insert(2, Arc::from(vec![0.0_f32, 1.0, 0.0]));
        pool.insert(3, Arc::from(vec![0.0_f32, 0.0, 1.0]));
        curve.tags[0].vector = pool[&3].clone();
        curve.chunk_vector = pool[&3].clone();
        let run = |input: &NativeInput| {
            let model = build(&[(1, 1.0), (2, 1.0)], &HashSet::from([1, 2]),
                &pool, input, &artifact);
            let cache = CosineCache::build(std::slice::from_ref(&curve),
                &input.query.vector, [1, 2, 3], &pool);
            evaluate(&model, &curve, &pool, &cache)
        };
        let result = run(&input);
        assert_eq!(cosine(&pool[&1], &pool[&3]), 0.0);
        assert!(result.wormhole_lift > 0.1);
        assert!(result.ledger[0].wormhole_support > 0.9);
        assert_eq!(result.ledger[1].wormhole_support, 0.0);
        assert_eq!(result.ledger[1].route_target, None);
        input.query_state.river_edges[0].flow = 0.0001;
        let small = run(&input);
        assert!(small.wormhole_lift > 0.0 && small.wormhole_lift < result.wormhole_lift);
        // Wormhole flag explains propagation; it is not a second reward multiplier.
        input.query_state.river_edges[0].wormhole = false;
        assert_eq!(small.satisfaction, run(&input).satisfaction);
        input.query_state.river_edges.clear();
        assert_eq!(run(&input).satisfaction, 0.0);
    }

    #[test]
    fn query_projection_not_tag_independence_allocates_votes() {
        let (mut input, artifact, mut pool, _) = fixture();
        pool.insert(2, Arc::from(vec![0.0_f32, 1.0, 0.0]));
        pool.insert(3, Arc::from(vec![0.0_f32, 0.0, 1.0]));
        input.query.vector = vec![0.0, 1.0, 1.0];
        let model = build(&[(1, 1.0), (2, 1.0), (3, 1.0)],
            &HashSet::from([1, 2, 3]), &pool, &input, &artifact);
        assert_eq!(model.axes[0].residual_energy, 1.0);
        assert_eq!(model.axes[0].weight, 0.0);
        assert!((model.axes[1].weight - 0.5).abs() < 1e-12);
        assert!((model.axes[2].weight - 0.5).abs() < 1e-12);
    }

    #[test]
    fn aliases_share_one_vote_and_ignition_does_not_change_discriminative_weights() {
        let (input, artifact, pool, _) = fixture();
        let explicit = HashSet::from([1,2,3]);
        let a = build(&[(1,0.1),(2,1.0),(3,0.5)], &explicit, &pool, &input, &artifact);
        let b = build(&[(3,0.01),(2,0.2),(1,100.0)], &explicit, &pool, &input, &artifact);
        assert_eq!(a.axes.len(), 2);
        assert_eq!(a.axes[0].ids, vec![1,2]);
        assert_eq!(a.axes[0].weight, b.axes[0].weight);
        assert_eq!(a.axes[1].weight, b.axes[1].weight);
        assert!((a.axes.iter().map(|a| a.weight).sum::<f64>() - 1.0).abs() < 1e-12);
    }
}