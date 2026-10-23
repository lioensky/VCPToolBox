#![allow(dead_code)]

//! Read-only method-module planning over one existing Sense observation.
//! This is a propagation-supported scaffold, not a formal proof.
use crate::memo_sensing::ObservationTransition;
use crate::rivermemo_topology_v3::{load_artifact_with_connection, MemoRuntime, NativeArtifact};
use crate::storage::with_registered_read_transaction;
use napi::bindgen_prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stage {
    diary_name: String,
    k: usize,
    candidate_ids: Vec<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    observation_handle: String,
    stages: Vec<Stage>,
    #[serde(default)]
    experiment_preset: Option<String>,
    #[serde(default = "default_closure")]
    min_closure: f64,
    #[serde(default = "default_true")]
    enable_v8_extensions: bool,
    #[serde(default = "default_true")]
    enable_viterbi_lookahead: bool,
    #[serde(default = "default_true")]
    enable_homotopy_relay: bool,
    #[serde(default = "default_true")]
    enable_grassmann_stage_resonance: bool,
    #[serde(default = "default_true")]
    enable_diagnostics: bool,
}

impl Input {
    fn apply_preset(&mut self) {
        if let Some(preset) = self.experiment_preset.as_deref() {
            match preset.trim().to_ascii_lowercase().as_str() {
                "upstream" | "v1" | "6167e64" | "mainline" | "legacy" | "baseline" | "v7" | "off" | "all_off" => {
                    self.enable_v8_extensions = false;
                    self.enable_viterbi_lookahead = false;
                    self.enable_homotopy_relay = false;
                    self.enable_grassmann_stage_resonance = false;
                }
                "v8_5" | "v8.5" => {
                    self.enable_v8_extensions = true;
                    self.enable_viterbi_lookahead = false;
                    self.enable_homotopy_relay = false;
                    self.enable_grassmann_stage_resonance = false;
                }
                "v2" | "default" | "v9" | "v9_full" | "dual_ledger" => {
                    self.enable_v8_extensions = true;
                    self.enable_viterbi_lookahead = true;
                    self.enable_homotopy_relay = true;
                    self.enable_grassmann_stage_resonance = true;
                }
                _ => {}
            }
        }
    }
}

fn default_closure() -> f64 {
    0.2
}

fn default_true() -> bool {
    true
}
#[derive(Clone)]
struct Module {
    id: i64,
    file_id: i64,
    vector: Arc<[f32]>,
    v_norm: f64,
    relevance: f64,
    anchor_relevance: f64,
    transfer_relevance: f64,
    tags: HashMap<i64, (usize, f64)>,
    ordered_tags: Vec<(i64, usize, f64)>,
}

/// RiverMemo V3-Core × V9-Inspiration Synthesis Constants:
/// - `MIN_VIABLE_ROUTE_SCORE`: minimum topological excitation T(c) to claim a grounded river edge;
/// - `SOFT_TAG_PROJECTION_MIN_COS`: tangent cosine gate for explicit specialized tags;
/// - `PEER_BASE_SIGMA`: Gaussian kernel bandwidth \sigma_b in Topology V3 peer-expected baseline.
const MIN_VIABLE_ROUTE_SCORE: f64 = 0.14;
const SOFT_TAG_PROJECTION_MIN_COS: f64 = 0.62;
const PEER_BASE_SIGMA: f64 = 0.12;

/// Stage-Conjugate Phase Envelope `\alpha_s = \sin(\pi * s / (S - 1))`:
/// Returns `(local_weight, grassmann_weight, innovation_gain)` for stage `s`:
/// - Boundary stages (`s = 0` or `S - 1`, `\alpha_s = 0.0`): anchor on Local field (`0.85 : 0.15`), conservative innovation (`0.35`);
/// - Conjugate peak stage (Middle stage, `\alpha_s = 1.0`): open Grassmann transfer field (`0.55 : 0.45`), boost V3 innovation (`0.65`).
fn stage_v3_conjugate_profile(stage_idx: usize, num_stages: usize) -> (f64, f64, f64) {
    let alpha = if num_stages >= 3 {
        let t = (stage_idx as f64) / ((num_stages - 1) as f64);
        (std::f64::consts::PI * t).sin().clamp(0.0, 1.0)
    } else {
        0.5
    };
    let w_grassmann = 0.15 + 0.30 * alpha;
    let w_local = 1.0 - w_grassmann;
    let lambda_innovation = 0.35 + 0.30 * alpha;
    (w_local, w_grassmann, lambda_innovation)
}

/// Backwards-compatible helper exposing `(w_anchor, w_trf, w_route_scale)` for unit tests.
fn stage_conjugate_weights(stage_idx: usize, num_stages: usize) -> (f64, f64, f64) {
    let (w_local, w_grassmann, lambda_innovation) = stage_v3_conjugate_profile(stage_idx, num_stages);
    let sum = (w_local + w_grassmann + lambda_innovation).max(1e-12);
    (w_local / sum, w_grassmann / sum, lambda_innovation / sum)
}

/// Resolves `(a_pos, a_closure, b_pos, b_closure, is_exact)` for an external river edge `(source_id -> target_id)`
/// against a meta-thinking module:
/// 1) Tier 1 (Exact ID): fast path when module has explicit `file_tags` matching `(source_id, target_id)`;
/// 2) Tier 2 (Tagless External Dipole Coupling): meta-thinking chains are pure operators without `Tag:` lines
///    (`ordered_tags.is_empty()`). Couples the module vector `\mathbf{c}` directly with external river edge
///    endpoints `(\mathbf{t}_u \to \mathbf{t}_v)` via dipole resonance and forward directional drift `\sigma(\gamma(c_v - c_u))`;
/// 3) Tier 3 (Soft Semantic Tag Projection): bridges specialized module tags in tangent space (`cos >= 0.62`).
fn resolve_module_edge_endpoints(
    module: &Module,
    source_id: i64,
    target_id: i64,
    min_closure: f64,
    artifact: &NativeArtifact,
    global_tag_vecs: &HashMap<i64, (Arc<[f32]>, f64)>,
) -> Option<(usize, f64, usize, f64, bool)> {
    // Tier 1 (Exact ID): when module explicitly contains both tags, return their exact positions
    // (including inverted `a_pos >= b_pos` so caller diagnostics catch `TAG_ORDER_INVERTED` and reject it
    // without letting soft projection fabricate a self-match!).
    if let (Some(&(a_pos, a_c)), Some(&(b_pos, b_c))) = (
        module.tags.get(&source_id),
        module.tags.get(&target_id),
    ) {
        return Some((a_pos, a_c, b_pos, b_c, true));
    }
    let (u_vec, u_norm) = global_tag_vecs.get(&source_id)?;
    let (v_vec, v_norm) = global_tag_vecs.get(&target_id)?;
    if *u_norm <= 1e-12 || *v_norm <= 1e-12 || u_vec.len() != v_vec.len() {
        return None;
    }
    // Tier 2: Pure Tagless Operator -> External River Tag Dipole Coupling
    if module.ordered_tags.is_empty() {
        if module.v_norm <= 1e-12 || module.vector.len() != u_vec.len() {
            return None;
        }
        let dot_u: f64 = module.vector.iter().zip(u_vec.iter()).map(|(&a, &b)| (a as f64) * (b as f64)).sum();
        let dot_v: f64 = module.vector.iter().zip(v_vec.iter()).map(|(&a, &b)| (a as f64) * (b as f64)).sum();
        let cu = (dot_u / (module.v_norm * *u_norm)).clamp(0.0, 1.0);
        let cv = (dot_v / (module.v_norm * *v_norm)).clamp(0.0, 1.0);
        let geom = (cu * cv).sqrt();
        if cu >= 0.28 && cv >= 0.28 && geom >= 0.31 && cv + 0.04 >= cu {
            let drift_gate = 1.0 / (1.0 + (-6.0 * (cv - cu)).exp());
            let eff_a = ((0.22 + (cu - 0.28) * 2.1) * (0.85 + 0.30 * drift_gate)).clamp(min_closure.max(0.20), 0.90);
            let eff_b = ((0.22 + (cv - 0.28) * 2.1) * (0.85 + 0.30 * drift_gate)).clamp(min_closure.max(0.20), 0.90);
            return Some((0, eff_a, 1, eff_b, false));
        }
        return None;
    }
    // Tier 3 (Soft Semantic Tag Projection): only when neither endpoint is already an inverted exact pair,
    // and never allow an in-graph river node (`artifact.node_index.contains_key`) to masquerade as a different river node ID!
    if module.ordered_tags.len() < 2 {
        return None;
    }
    let mut best_pair: Option<(usize, f64, usize, f64, f64)> = None;
    for (idx_a, &(tid_a, pos_a, clos_a)) in module.ordered_tags.iter().enumerate() {
        if clos_a < min_closure || tid_a == target_id {
            continue;
        }
        if tid_a != source_id && artifact.node_index.contains_key(&tid_a) {
            continue;
        }
        let sim_u = if tid_a == source_id {
            1.0
        } else if let Some((ta_vec, ta_norm)) = global_tag_vecs.get(&tid_a) {
            if *ta_norm > 1e-12 && ta_vec.len() == u_vec.len() {
                let dot: f64 = ta_vec.iter().zip(u_vec.iter()).map(|(&x, &y)| (x as f64) * (y as f64)).sum();
                (dot / (*ta_norm * *u_norm)).clamp(0.0, 1.0)
            } else {
                0.0
            }
        } else {
            0.0
        };
        if sim_u < SOFT_TAG_PROJECTION_MIN_COS {
            continue;
        }
        let eff_a = clos_a * sim_u * if tid_a == source_id { 1.0 } else { 0.92 };
        if eff_a < min_closure {
            continue;
        }
        for &(tid_b, pos_b, clos_b) in module.ordered_tags.iter().skip(idx_a + 1) {
            if pos_b <= pos_a || clos_b < min_closure || tid_b == tid_a || tid_b == source_id {
                continue;
            }
            if tid_b != target_id && artifact.node_index.contains_key(&tid_b) {
                continue;
            }
            let sim_v = if tid_b == target_id {
                1.0
            } else if let Some((tb_vec, tb_norm)) = global_tag_vecs.get(&tid_b) {
                if *tb_norm > 1e-12 && tb_vec.len() == v_vec.len() {
                    let dot: f64 = tb_vec.iter().zip(v_vec.iter()).map(|(&x, &y)| (x as f64) * (y as f64)).sum();
                    (dot / (*tb_norm * *v_norm)).clamp(0.0, 1.0)
                } else {
                    0.0
                }
            } else {
                0.0
            };
            if sim_v < SOFT_TAG_PROJECTION_MIN_COS {
                continue;
            }
            let eff_b = clos_b * sim_v * if tid_b == target_id { 1.0 } else { 0.92 };
            if eff_b < min_closure {
                continue;
            }
            let pair_geom = (eff_a * eff_b).sqrt();
            if best_pair.as_ref().map_or(true, |p| pair_geom > p.4) {
                best_pair = Some((pos_a, eff_a, pos_b, eff_b, pair_geom));
            }
        }
    }
    best_pair.map(|(pa, ca, pb, cb, _)| (pa, ca, pb, cb, false))
}

/// V9 Inspiration Excitation Operator `T(c, e)`:
/// Measures how strongly an active river transition edge `e = (u -> v)` excites module `c`,
/// combining river flow, dipole/tag closure, Ollivier-Ricci negative-curvature bridge gain,
/// and magnetic causal phase coherence.
fn compute_fitted_route_base_score(
    flow_norm: f64,
    a_closure: f64,
    b_closure: f64,
    independent: f64,
    novelty: f64,
    phase_span: f64,
    ricci_factor: f64,
) -> f64 {
    let closure_geom = (a_closure * b_closure).sqrt().clamp(0.0, 1.0);
    let magnetic_phase_gain = 0.95 + 0.10 * (std::f64::consts::FRAC_PI_2 * phase_span.clamp(0.0, 1.0)).sin();
    let ricci_bridge_gain = 0.90 + 0.18 * ricci_factor.clamp(0.0, 1.5);
    let provenance_gate = 0.35 + 0.65 * independent.clamp(0.0, 1.0);
    (flow_norm * closure_geom * provenance_gate * novelty * magnetic_phase_gain * ricci_bridge_gain).clamp(0.0, 1.0)
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Selection {
    chunk_id: i64,
    score: f64,
    parents: Vec<i64>,
    relation: &'static str,
    route: Option<ObservationTransition>,
    #[serde(skip)]
    stage_idx: usize,
    #[serde(skip)]
    anchor_relevance: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StageOutput {
    diary_name: String,
    k: usize,
    results: Vec<Selection>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OptimizationHint {
    stage: String,
    module_id: i64,
    bottleneck: &'static str,
    potential_score_gain: f64,
    source_tag_id: i64,
    target_tag_id: i64,
    prescription: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LatentWormhole {
    from_stage: String,
    to_stage: String,
    from_module_id: i64,
    to_module_id: i64,
    source_tag_id: i64,
    target_tag_id: i64,
    structural_cosine: f64,
    sweet_spot_gain: f64,
    inspiration_potential: f64,
}

fn cosine(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let dot: f64 = a.iter().zip(b).map(|(x, y)| *x as f64 * *y as f64).sum();
    let aa: f64 = a.iter().map(|x| (*x as f64).powi(2)).sum();
    let bb: f64 = b.iter().map(|x| (*x as f64).powi(2)).sum();
    let value = dot / (aa * bb).sqrt();
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn decode(bytes: Vec<u8>, dimension: usize) -> Option<Vec<f32>> {
    if bytes.len() != dimension * 4 {
        return None;
    }
    let values: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|b| f32::from_ne_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    values.iter().all(|v| v.is_finite()).then_some(values)
}

/// Adjacency requires the actual time-expanded predecessor state, not Tag
/// reachability in the aggregated river. Immediate return is never progression.
fn follows(left: &ObservationTransition, right: &ObservationTransition) -> bool {
    !right.immediate_return
        && left.hop + 1 == right.hop
        && left.target_id == right.source_id
        && right.previous_id == Some(left.source_id)
}

/// V9 Homotopy Continuation Kernel:
/// 1) Returns `Some(1.0)` when strict `follows(left, right)` holds;
/// 2) When `enable_homotopy_relay` is enabled and `right` advances in hop depth without folding back,
///    awards a soft relay factor in `[0.60, 0.92]` if `left.target_id -> right.source_id` is bridged
///    by a directed graph edge (`w >= 0.08`) or high-dimensional tangent cosine (`sim >= 0.72`).
fn homotopy_continuation_factor(
    left: &ObservationTransition,
    right: &ObservationTransition,
    enable_homotopy_relay: bool,
    artifact: &NativeArtifact,
    global_tag_vecs: &HashMap<i64, (Arc<[f32]>, f64)>,
) -> Option<f64> {
    if follows(left, right) {
        return Some(1.0);
    }
    if !enable_homotopy_relay || right.immediate_return {
        return None;
    }
    if right.hop < left.hop
        || right.hop > left.hop + 2
        || right.target_id == left.source_id
        || (right.source_id == left.source_id && right.target_id == left.target_id)
    {
        return None;
    }
    if left.target_id == right.source_id && right.hop > left.hop {
        return Some(0.94);
    }
    let bridge_src = left.target_id;
    let bridge_dst = if right.source_id == left.source_id {
        right.target_id
    } else {
        right.source_id
    };
    let graph_bridge = artifact.edge_weight(bridge_src, bridge_dst);
    if graph_bridge >= 0.08 {
        return Some((0.82 + 0.12 * graph_bridge.min(1.0)).min(0.92));
    }
    if let (Some((u_vec, u_norm)), Some((v_vec, v_norm))) = (
        global_tag_vecs.get(&bridge_src),
        global_tag_vecs.get(&bridge_dst),
    ) {
        if *u_norm > 1e-12 && *v_norm > 1e-12 && u_vec.len() == v_vec.len() {
            let dot: f64 = u_vec
                .iter()
                .zip(v_vec.iter())
                .map(|(&a, &b)| (a as f64) * (b as f64))
                .sum();
            let sim = dot / (u_norm * v_norm);
            if sim >= 0.72 {
                return Some((0.86 * sim).clamp(0.64, 0.88));
            }
        }
    }
    None
}
pub(crate) fn plan(
    runtime: &MemoRuntime,
    db_path: &str,
    artifact_sig: &str,
    input_json: &str,
) -> std::result::Result<String, String> {
    let _guard = crate::publication_gate::acquire_read(db_path, &[String::from("*")])?;
    let mut input: Input = serde_json::from_str(input_json).map_err(|e| e.to_string())?;
    input.apply_preset();
    if input.stages.is_empty()
        || input.stages.len() > 32
        || !input.min_closure.is_finite()
        || !(0.0..=1.0).contains(&input.min_closure)
        || input
            .stages
            .iter()
            .any(|s| s.k > 32 || s.candidate_ids.len() > 256 || s.diary_name.trim().is_empty())
    {
        return Err("invalid or oversized method planning request".into());
    }
    let cached = runtime.get_query_observation(&input.observation_handle, artifact_sig)?;
    let observation = &cached.observation;
    if observation.transitions.is_empty() || observation.transitions_truncated {
        return Err("Sense transitions unavailable or truncated".into());
    }
    let dimension = cached.original_query_vector.len();
    with_registered_read_transaction(db_path, |connection| {
        let artifact = load_artifact_with_connection(runtime, connection, artifact_sig)?;
        let mut chunk_statement = connection
            .prepare(
                "SELECT c.file_id, c.vector FROM chunks c JOIN files f ON f.id=c.file_id
             WHERE c.id=?1 AND f.diary_name=?2 AND c.vector IS NOT NULL",
            )
            .map_err(|e| e.to_string())?;
        let mut tag_statement = connection
            .prepare(
                "SELECT ft.tag_id, t.vector FROM file_tags ft JOIN tags t ON t.id=ft.tag_id
             WHERE ft.file_id=?1 AND t.vector IS NOT NULL ORDER BY ft.position, ft.tag_id LIMIT 128",
            )
            .map_err(|e| e.to_string())?;
        let maximum_flow = observation
            .transitions
            .iter()
            .map(|e| e.flow)
            .fold(0.0, f64::max);
        // Direction B (Per-Hop Layer Peak Normalization):
        // Prevent Hop-1 dominant flow from crushing Hop-2/3/4 multi-hop continuations.
        // Blend 50% global flow ratio + 50% per-hop peak flow ratio so deep hops compete fairly
        // while preserving monotone flow preference within the same hop.
        let mut max_flow_by_hop: HashMap<usize, f64> = HashMap::new();
        for e in &observation.transitions {
            if !e.immediate_return {
                let entry = max_flow_by_hop.entry(e.hop).or_insert(0.0);
                if e.flow > *entry {
                    *entry = e.flow;
                }
            }
        }

        // Direction A (4-Way Fused Multi-Field Envelope Relevance):
        // Measure module relevance against original, enhanced, local, and transfer field vectors
        // in a single pass so abstract philosophical modules resonate with cross-domain transfer intent.
        let q_orig = cached.original_query_vector.as_ref();
        let q_enh = cached.enhanced_query_vector.as_ref();
        let q_loc = cached.local_vector.as_ref();
        let q_trf = cached.transfer_vector.as_ref();
        let norm_orig = q_orig.iter().map(|&x| (x as f64).powi(2)).sum::<f64>().sqrt();
        let norm_enh = if q_enh.len() == dimension {
            q_enh.iter().map(|&x| (x as f64).powi(2)).sum::<f64>().sqrt()
        } else {
            0.0
        };
        let norm_loc = if q_loc.len() == dimension {
            q_loc.iter().map(|&x| (x as f64).powi(2)).sum::<f64>().sqrt()
        } else {
            0.0
        };
        let norm_trf = if q_trf.len() == dimension {
            q_trf.iter().map(|&x| (x as f64).powi(2)).sum::<f64>().sqrt()
        } else {
            0.0
        };

        // V9 Grassmannian Stiefel Frame U \in St(M+1, d) for Multi-Pole Stage Resonance:
        let grassmann_poles: Vec<Vec<f32>> = if input.enable_grassmann_stage_resonance {
            let mut basis: Vec<Vec<f64>> = Vec::new();
            for pole in cached.transfer_basin_vectors.iter().take(4) {
                if pole.len() != dimension {
                    continue;
                }
                let mut v: Vec<f64> = pole.iter().map(|&x| x as f64).collect();
                for b in &basis {
                    let dot_p: f64 = v.iter().zip(b.iter()).map(|(a, b_val)| a * b_val).sum();
                    for (vi, &bi) in v.iter_mut().zip(b.iter()) {
                        *vi -= dot_p * bi;
                    }
                }
                let n: f64 = v.iter().map(|x| x * x).sum::<f64>().sqrt();
                if n > 0.15 {
                    for vi in &mut v {
                        *vi /= n;
                    }
                    basis.push(v);
                }
            }
            basis
                .into_iter()
                .map(|b| b.into_iter().map(|x| x as f32).collect())
                .collect()
        } else {
            Vec::new()
        };

        // Audit P1-4 Hard Budgets: cap unique cached tag vectors and active transition evaluations.
        const MAX_CACHED_UNIQUE_TAGS: usize = 4096;
        const MAX_ACTIVE_TRANSITIONS: usize = 1024;
        let active_transitions: &[ObservationTransition] = if observation.transitions.len() > MAX_ACTIVE_TRANSITIONS {
            &observation.transitions[..MAX_ACTIVE_TRANSITIONS]
        } else {
            &observation.transitions
        };
        let mut file_tags_cache: HashMap<i64, Vec<(usize, i64)>> = HashMap::new();
        let mut global_tag_vecs: HashMap<i64, (Arc<[f32]>, f64)> = HashMap::new();
        for (&tid, vec_arc) in cached.tag_vectors.iter().take(MAX_CACHED_UNIQUE_TAGS) {
            if vec_arc.len() == dimension {
                let norm = vec_arc.iter().map(|&x| (x as f64).powi(2)).sum::<f64>().sqrt();
                if norm > 1e-12 {
                    global_tag_vecs.insert(tid, (vec_arc.clone(), norm));
                }
            }
        }
        let mut stage_modules: Vec<(Stage, Vec<Module>)> = Vec::with_capacity(input.stages.len());

        // Preload all stages so we can compute Backward Viterbi Continuation Potential \beta_s(edge)
        for stage in input.stages {
            let mut modules = Vec::new();
            let mut seen = HashSet::new();
            for &id in &stage.candidate_ids {
                if id <= 0 || !seen.insert(id) {
                    continue;
                }
                let row = chunk_statement.query_row(rusqlite::params![id, stage.diary_name], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))
                });
                let (file_id, bytes) = match row {
                    Ok(row) => row,
                    Err(rusqlite::Error::QueryReturnedNoRows) => continue,
                    Err(error) => return Err(error.to_string()),
                };
                let Some(vector) = decode(bytes, dimension) else {
                    continue;
                };
                let v_norm = vector.iter().map(|&x| (x as f64).powi(2)).sum::<f64>().sqrt();
                let cached_tags = match file_tags_cache.entry(file_id) {
                    std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                    std::collections::hash_map::Entry::Vacant(entry) => {
                        let rows = tag_statement
                            .query_map([file_id], |r| {
                                Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))
                            })
                            .map_err(|e| e.to_string())?;
                        let mut positions = Vec::new();
                        for (position, row) in rows.enumerate() {
                            let (tag_id, bytes) = row.map_err(|e| e.to_string())?;
                            if !global_tag_vecs.contains_key(&tag_id) {
                                if let Some(tag_vector) = decode(bytes, dimension) {
                                    let t_norm = tag_vector.iter().map(|&x| (x as f64).powi(2)).sum::<f64>().sqrt();
                                    if t_norm > 1e-12 && global_tag_vecs.len() < MAX_CACHED_UNIQUE_TAGS {
                                        global_tag_vecs.insert(tag_id, (Arc::from(tag_vector), t_norm));
                                    }
                                }
                            }
                            if global_tag_vecs.contains_key(&tag_id) {
                                positions.push((position, tag_id));
                            }
                        }
                        entry.insert(positions)
                    }
                };
                let mut tags = HashMap::with_capacity(cached_tags.len());
                let mut ordered_tags = Vec::with_capacity(cached_tags.len());
                for &(position, tag_id) in cached_tags.iter() {
                    let Some(&(ref tag_vector, t_norm)) = global_tag_vecs.get(&tag_id) else {
                        continue;
                    };
                    let dot: f64 = vector.iter().zip(tag_vector.iter()).map(|(x, y)| *x as f64 * *y as f64).sum();
                    let val = dot / (v_norm * t_norm).max(1e-12);
                    let closure_val = if val.is_finite() { val.clamp(0.0, 1.0) } else { 0.0 };
                    tags.insert(tag_id, (position, closure_val));
                    ordered_tags.push((tag_id, position, closure_val));
                }
                let (relevance, anchor_relevance, transfer_relevance) =
                    if v_norm > 1e-12 && vector.len() == dimension && !vector.is_empty() {
                        let (mut d_orig, mut d_enh, mut d_loc, mut d_trf) =
                            (0.0f64, 0.0f64, 0.0f64, 0.0f64);
                        let has_enh = norm_enh > 1e-12;
                        let has_loc = norm_loc > 1e-12;
                        let has_trf = norm_trf > 1e-12;
                        for i in 0..dimension {
                            let vi = vector[i] as f64;
                            d_orig += vi * (q_orig[i] as f64);
                            if has_enh {
                                d_enh += vi * (q_enh[i] as f64);
                            }
                            if has_loc {
                                d_loc += vi * (q_loc[i] as f64);
                            }
                            if has_trf {
                                d_trf += vi * (q_trf[i] as f64);
                            }
                        }
                        let c_orig = if norm_orig > 1e-12 {
                            (d_orig / (v_norm * norm_orig)).clamp(0.0, 1.0)
                        } else {
                            0.0
                        };
                        let c_enh = if has_enh {
                            (d_enh / (v_norm * norm_enh)).clamp(0.0, 1.0)
                        } else {
                            c_orig
                        };
                        let c_loc = if has_loc {
                            (d_loc / (v_norm * norm_loc)).clamp(0.0, 1.0)
                        } else {
                            c_orig
                        };
                        let mut c_trf = if has_trf {
                            (d_trf / (v_norm * norm_trf)).clamp(0.0, 1.0)
                        } else {
                            c_orig
                        };
                        if !grassmann_poles.is_empty() {
                            let mut chordal_sq = 0.0f64;
                            for (p_idx, pole) in grassmann_poles.iter().enumerate() {
                                let p_cos = cosine(&vector, pole);
                                if p_cos > c_trf {
                                    c_trf = p_cos;
                                }
                                chordal_sq += (1.0 / (1.0 + 0.25 * p_idx as f64)) * p_cos * p_cos;
                            }
                            c_trf = c_trf.max(chordal_sq.sqrt().min(1.0));
                        }
                        let anchor_rel = (0.55 * c_orig + 0.28 * c_enh + 0.17 * c_loc).max(c_orig);
                        let overall_rel = (0.73 * anchor_rel + 0.27 * c_trf).max(c_orig);
                        (overall_rel, anchor_rel, c_trf)
                    } else {
                        (0.0, 0.0, 0.0)
                    };
                modules.push(Module {
                    id,
                    file_id,
                    vector: Arc::from(vector),
                    v_norm,
                    tags,
                    ordered_tags,
                    relevance,
                    anchor_relevance,
                    transfer_relevance,
                });
            }
            stage_modules.push((stage, modules));
        }

        // Direction C (Backward Viterbi Continuation Envelope \beta):
        // Precompute for each transition edge in stage s whether and how strongly it can be
        // continued by any valid module in stage s + 1. This prevents stage-1 greedy lock-in
        // on dead-end edges when a slightly lower edge unlocks a multi-stage causal chain.
        let num_stages = stage_modules.len();
        let num_transitions = active_transitions.len();
        let mut stage_edge_best_intrinsic: Vec<Vec<f64>> = vec![vec![0.0; num_transitions]; num_stages];
        if input.enable_viterbi_lookahead {
            for (s_idx, (_, modules)) in stage_modules.iter().enumerate() {
                for (e_idx, edge) in active_transitions.iter().enumerate() {
                    if edge.immediate_return {
                        continue;
                    }
                    let hop_max = max_flow_by_hop.get(&edge.hop).copied().unwrap_or(maximum_flow).max(1e-12);
                    let flow_norm = 0.5 * (edge.flow / maximum_flow.max(1e-12)) + 0.5 * (edge.flow / hop_max);
                    let ricci_factor = artifact.edge_ricci_factor(edge.source_id, edge.target_id);
                    let mut best_mod_score = 0.0f64;
                    for m in modules {
                        if let Some((a_pos, a_c, b_pos, b_c, _)) = resolve_module_edge_endpoints(
                            m,
                            edge.source_id,
                            edge.target_id,
                            input.min_closure,
                            &artifact,
                            &global_tag_vecs,
                        ) {
                            if a_pos < b_pos && a_c >= input.min_closure && b_c >= input.min_closure {
                                let ind = artifact.independent_fraction(edge.source_id, edge.target_id, m.file_id);
                                let chain_len = m.ordered_tags.len().max(2) as f64;
                                let phase_span = ((b_pos as f64 - a_pos as f64) / (chain_len - 1.0)).clamp(0.0, 1.0);
                                let sc = compute_fitted_route_base_score(
                                    flow_norm,
                                    a_c,
                                    b_c,
                                    ind,
                                    1.0,
                                    phase_span,
                                    ricci_factor,
                                );
                                if sc > best_mod_score {
                                    best_mod_score = sc;
                                }
                            }
                        }
                    }
                    stage_edge_best_intrinsic[s_idx][e_idx] = best_mod_score;
                }
            }
        }

        // Build predecessor adjacency index `(hop, previous_id, source_id) -> Vec<next_e_idx>`
        // so Backward Viterbi DP evaluates only valid causal successors instead of O(S * |T|^2) all-pairs scans!
        let mut next_edges_by_pred: HashMap<(usize, Option<i64>, i64), Vec<usize>> = HashMap::new();
        if input.enable_viterbi_lookahead {
            for (next_e_idx, next_edge) in active_transitions.iter().enumerate() {
                if !next_edge.immediate_return && next_edge.hop > 1 {
                    next_edges_by_pred
                        .entry((next_edge.hop, next_edge.previous_id, next_edge.source_id))
                        .or_default()
                        .push(next_e_idx);
                }
            }
        }

        // Backward DP sweep: beta[s][e_idx] = max future continuation chain value from stage s+1..num_stages
        let mut beta_lookahead: Vec<Vec<f64>> = vec![vec![0.0; num_transitions]; num_stages];
        if input.enable_viterbi_lookahead && num_stages >= 2 {
            for s_idx in (0..num_stages - 1).rev() {
                if stage_modules[s_idx + 1].0.k == 0 {
                    continue;
                }
                for (e_idx, edge) in active_transitions.iter().enumerate() {
                    if stage_edge_best_intrinsic[s_idx][e_idx] <= 0.0 {
                        continue;
                    }
                    let mut best_next = 0.0f64;
                    let key = (edge.hop + 1, Some(edge.source_id), edge.target_id);
                    if let Some(successors) = next_edges_by_pred.get(&key) {
                        for &next_e_idx in successors {
                            let next_intrinsic = stage_edge_best_intrinsic[s_idx + 1][next_e_idx];
                            if next_intrinsic > 0.0 {
                                let total_future = next_intrinsic + 0.5 * beta_lookahead[s_idx + 1][next_e_idx];
                                if total_future > best_next {
                                    best_next = total_future;
                                }
                            }
                        }
                    }
                    beta_lookahead[s_idx][e_idx] = best_next;
                }
            }
        }

        let mut output = Vec::new();
        let mut selected: Vec<Selection> = Vec::new();
        let mut selected_vecs: Vec<(Arc<[f32]>, f64)> = Vec::new();
        let mut used_files = HashSet::new();
        let mut used_edges = HashSet::new();
        let mut parent_usage_count: HashMap<i64, usize> = HashMap::new();
        let mut optimization_hints: Vec<OptimizationHint> = Vec::new();

        for (s_idx, (stage, modules)) in stage_modules.iter().enumerate() {
            let (w_local, w_grassmann, lambda_innovation) = stage_v3_conjugate_profile(s_idx, num_stages);
            let mut results = Vec::new();
            for pick_iter in 0..stage.k {
                // Step 1: Evaluate Dual-Field Base_s(c) (with Residual Pyramid orthogonal stripping against
                // previously selected modules) and V9 Inspiration Excitation T_s(c) for all candidates in stage.
                struct CandidateEval<'a> {
                    module: &'a Module,
                    base_score: f64,
                    topo_excitation: f64,
                    best_route: Option<ObservationTransition>,
                    best_parents: Vec<i64>,
                }
                let mut evals: Vec<CandidateEval<'_>> = Vec::with_capacity(modules.len());

                for module in modules {
                    if used_files.contains(&module.file_id) {
                        continue;
                    }
                    // Dual-Field Conjugate Base + Residual Pyramid Orthogonal Stripping:
                    let dual_field_base = w_local * module.anchor_relevance + w_grassmann * module.transfer_relevance;
                    let mut max_prev_sim_sq = 0.0f64;
                    if module.v_norm > 1e-12 {
                        for (prev_vec, prev_norm) in &selected_vecs {
                            if *prev_norm > 1e-12 && prev_vec.len() == module.vector.len() {
                                let dot: f64 = module
                                    .vector
                                    .iter()
                                    .zip(prev_vec.iter())
                                    .map(|(&a, &b)| (a as f64) * (b as f64))
                                    .sum();
                                let sim = (dot / (module.v_norm * *prev_norm)).clamp(0.0, 1.0);
                                if sim * sim > max_prev_sim_sq {
                                    max_prev_sim_sq = sim * sim;
                                }
                            }
                        }
                    }
                    // Strip already-expressed subspace projection so each stage advances orthogonally
                    let residual_gate = 1.0 - 0.35 * max_prev_sim_sq;
                    let stage_base = (dual_field_base * residual_gate).clamp(0.0, 1.0);

                    let mut best_route = None;
                    let mut best_parents = Vec::new();
                    let mut best_route_score = 0.0;
                    for (e_idx, edge) in active_transitions.iter().enumerate() {
                        if edge.immediate_return {
                            continue;
                        }
                        let resolved_endpoints = if input.enable_v8_extensions {
                            resolve_module_edge_endpoints(
                                module,
                                edge.source_id,
                                edge.target_id,
                                input.min_closure,
                                &artifact,
                                &global_tag_vecs,
                            )
                        } else {
                            module
                                .tags
                                .get(&edge.source_id)
                                .zip(module.tags.get(&edge.target_id))
                                .map(|(&(a_p, a_c), &(b_p, b_c))| (a_p, a_c, b_p, b_c, true))
                        };
                        let Some((a_pos, a_closure, b_pos, b_closure, _is_exact)) =
                            resolved_endpoints
                        else {
                            continue;
                        };
                        let hop_max = max_flow_by_hop.get(&edge.hop).copied().unwrap_or(maximum_flow).max(1e-12);
                        let flow_norm = 0.5 * (edge.flow / maximum_flow.max(1e-12)) + 0.5 * (edge.flow / hop_max);

                        // Inverse Topology Diagnostics (Counterfactual Bottleneck Detection on 1st pick):
                        if input.enable_diagnostics && pick_iter == 0 {
                            if a_pos >= b_pos && a_closure >= input.min_closure && b_closure >= input.min_closure {
                                let ind = artifact.independent_fraction(edge.source_id, edge.target_id, module.file_id);
                                let counterfactual = lambda_innovation * flow_norm * (a_closure * b_closure).sqrt() * ind;
                                if counterfactual >= 0.05 {
                                     optimization_hints.push(OptimizationHint {
                                        stage: stage.diary_name.clone(),
                                        module_id: module.id,
                                        bottleneck: "TAG_ORDER_INVERTED",
                                        potential_score_gain: (counterfactual * 10000.0).round() / 10000.0,
                                        source_tag_id: edge.source_id,
                                        target_tag_id: edge.target_id,
                                        prescription: format!(
                                            "Module #{} hits river edge [{} -> {}], but tag order is inverted (pos {} >= pos {}); swapping order unlocks +{:.3} route score.",
                                            module.id, edge.source_id, edge.target_id, a_pos, b_pos, counterfactual
                                        ),
                                    });
                                }
                            } else if a_pos < b_pos && (a_closure < input.min_closure || b_closure < input.min_closure) {
                                let min_c = a_closure.min(b_closure);
                                if min_c >= input.min_closure * 0.65 {
                                    let ind = artifact.independent_fraction(edge.source_id, edge.target_id, module.file_id);
                                    let counterfactual = lambda_innovation * flow_norm * input.min_closure.max(0.25) * ind;
                                    if counterfactual >= 0.05 {
                                        optimization_hints.push(OptimizationHint {
                                            stage: stage.diary_name.clone(),
                                            module_id: module.id,
                                            bottleneck: "WEAK_TAG_CLOSURE",
                                            potential_score_gain: (counterfactual * 10000.0).round() / 10000.0,
                                            source_tag_id: edge.source_id,
                                            target_tag_id: edge.target_id,
                                            prescription: format!(
                                                "Module #{} matches edge [{} -> {}], but tag closure ({:.3}, {:.3}) is below min_closure {:.2}; grounding the concept in text unlocks +{:.3}.",
                                                module.id, edge.source_id, edge.target_id, a_closure, b_closure, input.min_closure, counterfactual
                                            ),
                                        });
                                    }
                                }
                            }
                        }

                        if a_pos >= b_pos
                            || a_closure < input.min_closure
                            || b_closure < input.min_closure
                        {
                            continue;
                        }
                        let mut best_relay_factor = 0.0f64;
                        let mut relayed_candidates: Vec<(i64, f64, usize)> = selected
                            .iter()
                            .filter_map(|s| {
                                let prev = s.route.as_ref()?;
                                let raw_factor = homotopy_continuation_factor(
                                    prev,
                                    edge,
                                    input.enable_homotopy_relay,
                                    &artifact,
                                    &global_tag_vecs,
                                )?;
                                let stage_gap = s_idx.saturating_sub(s.stage_idx).max(1);
                                let gap_decay = (0.90_f64).powi((stage_gap - 1) as i32);
                                let root_trust = (0.72 + 0.28 * s.anchor_relevance).clamp(0.75, 1.0);
                                let factor = (raw_factor * gap_decay * root_trust).clamp(0.58, 1.0);
                                if factor > best_relay_factor {
                                    best_relay_factor = factor;
                                }
                                let used_cnt = parent_usage_count.get(&s.chunk_id).copied().unwrap_or(0);
                                Some((s.chunk_id, factor, used_cnt))
                            })
                            .collect();
                        // Branching Diversity & Anti-Hub Monopoly:
                        // Prefer the strongest predecessor that hasn't been over-consumed as a single bottleneck parent,
                        // keeping at most 2 distinct causal parents per module.
                        relayed_candidates.sort_by(|a, b| {
                            let eff_a = a.1 * (0.92_f64).powi(a.2 as i32);
                            let eff_b = b.1 * (0.92_f64).powi(b.2 as i32);
                            eff_b.total_cmp(&eff_a).then_with(|| a.0.cmp(&b.0))
                        });
                        let parents: Vec<i64> = relayed_candidates
                            .iter()
                            .take(2)
                            .map(|&(cid, _, _)| cid)
                            .collect();
                        if edge.hop != 1 && parents.is_empty() {
                            continue;
                        }
                        let edge_key = (edge.hop, edge.previous_id, edge.source_id, edge.target_id);
                        let novelty = if used_edges.contains(&edge_key) {
                            0.25
                        } else {
                            1.0
                        };
                        let independent = artifact.independent_fraction(
                            edge.source_id,
                            edge.target_id,
                            module.file_id,
                        );
                        if input.enable_diagnostics && pick_iter == 0 && independent < 0.25 && flow_norm * (a_closure * b_closure).sqrt() > 0.20 {
                            let gain = lambda_innovation * flow_norm * (a_closure * b_closure).sqrt() * (0.85 - independent);
                            optimization_hints.push(OptimizationHint {
                                stage: stage.diary_name.clone(),
                                module_id: module.id,
                                bottleneck: "SELF_PROVENANCE_ONLY",
                                potential_score_gain: (gain * 10000.0).round() / 10000.0,
                                source_tag_id: edge.source_id,
                                target_tag_id: edge.target_id,
                                prescription: format!(
                                    "Edge [{} -> {}] in Module #{} has low external independence ({:.2}); citing this tag pair in an external note unlocks +{:.3}.",
                                    edge.source_id, edge.target_id, module.id, independent, gain
                                ),
                            });
                        }
                        let chain_len = module.ordered_tags.len().max(2) as f64;
                        let phase_span = ((b_pos as f64 - a_pos as f64) / (chain_len - 1.0)).clamp(0.0, 1.0);
                        let ricci_factor = artifact.edge_ricci_factor(edge.source_id, edge.target_id);
                        let base_score = compute_fitted_route_base_score(
                            flow_norm,
                            a_closure,
                            b_closure,
                            independent,
                            novelty,
                            phase_span,
                            ricci_factor,
                        );
                        let min_parent_reuse = relayed_candidates
                            .first()
                            .map(|x| x.2)
                            .unwrap_or(0);
                        let diversity_factor = (0.93_f64).powi(min_parent_reuse as i32);
                        let parent_factor = if parents.is_empty() {
                            if s_idx == 0 {
                                if pick_iter == 0 && edge.wormhole { 0.72 } else { 0.90 }
                            } else {
                                0.64
                            }
                        } else {
                            (0.84 + 0.16 * best_relay_factor * diversity_factor).clamp(0.82, 1.0)
                        };
                        let viterbi_future = if input.enable_viterbi_lookahead {
                            0.16 * beta_lookahead[s_idx][e_idx]
                        } else {
                            0.0
                        };
                        let score = if input.enable_v8_extensions {
                            (base_score * parent_factor + viterbi_future).min(1.0)
                        } else {
                            let legacy_novelty = if used_edges.contains(&edge_key) { 0.2 } else { 1.0 };
                            let legacy_parent = if parents.is_empty() { 0.8 } else { 1.0 };
                            ((edge.flow / maximum_flow.max(1e-12))
                                * (a_closure * b_closure).sqrt()
                                * independent
                                * legacy_novelty
                                * legacy_parent)
                                .clamp(0.0, 1.0)
                        };
                        if score > best_route_score {
                            best_route_score = score;
                            best_route = Some(edge.clone());
                            best_parents = parents;
                        }
                    }
                    if pick_iter == 0 && best_route.is_none() && stage_base >= 0.45 {
                        if let Some(top_edge) = observation.transitions.iter().find(|e| !e.immediate_return) {
                            let gain = lambda_innovation * 0.55 * stage_base;
                            optimization_hints.push(OptimizationHint {
                                stage: stage.diary_name.clone(),
                                module_id: module.id,
                                bottleneck: "ISOLATED_MODULE_NO_FERRY",
                                potential_score_gain: (gain * 10000.0).round() / 10000.0,
                                source_tag_id: top_edge.source_id,
                                target_tag_id: top_edge.target_id,
                                prescription: format!(
                                    "Module #{} has high semantic relevance ({:.3}) but zero river ferry tags; anchoring onto active flow [{} -> {}] unlocks +{:.3}.",
                                    module.id, stage_base, top_edge.source_id, top_edge.target_id, gain
                                ),
                            });
                        }
                    }
                    let min_route_gate = if input.enable_v8_extensions {
                        MIN_VIABLE_ROUTE_SCORE
                    } else {
                        1e-12
                    };
                    let grounded_route = best_route.is_some() && best_route_score >= min_route_gate;
                    if !grounded_route {
                        best_route = None;
                        best_parents.clear();
                        best_route_score = 0.0;
                    }
                    evals.push(CandidateEval {
                        module,
                        base_score: stage_base,
                        topo_excitation: best_route_score,
                        best_route,
                        best_parents,
                    });
                }

                // Step 2: RiverMemo Topology V3 Peer-Gaussian Expected Baseline & Conditional Innovation!
                // Compute peer-expected topological excitation `Expected_i = (\sum_j K_ij * T_j) / (\sum_j K_ij)`
                // using the V6/V9 DPP subspace-coherent Gaussian kernel, and reward positive `Innovation_i = max(0, T_i - Expected_i)`.
                let mut offers = Vec::with_capacity(evals.len());
                let two_sigma_sq = 2.0 * PEER_BASE_SIGMA * PEER_BASE_SIGMA;
                for (i, ev_i) in evals.iter().enumerate() {
                    let mut weight_sum = 0.0f64;
                    let mut weighted_topo = 0.0f64;
                    for (j, ev_j) in evals.iter().enumerate() {
                        let diff = ev_i.base_score - ev_j.base_score;
                        let gauss = (-diff * diff / two_sigma_sq).exp();
                        let subspace_coh = if i == j {
                            1.0
                        } else if ev_i.module.v_norm > 1e-12
                            && ev_j.module.v_norm > 1e-12
                            && ev_i.module.vector.len() == ev_j.module.vector.len()
                        {
                            let dot: f64 = ev_i
                                .module
                                .vector
                                .iter()
                                .zip(ev_j.module.vector.iter())
                                .map(|(&a, &b)| (a as f64) * (b as f64))
                                .sum();
                            let c = (dot / (ev_i.module.v_norm * ev_j.module.v_norm)).clamp(0.0, 1.0);
                            0.10 + 0.90 * c * c
                        } else {
                            0.10
                        };
                        let k_ij = gauss * subspace_coh;
                        weight_sum += k_ij;
                        weighted_topo += k_ij * ev_j.topo_excitation;
                    }
                    let raw_expected_topo = if weight_sum > 1e-12 {
                        weighted_topo / weight_sum
                    } else {
                        0.0
                    };
                    // SchurPeerInnovation Isomorphism: call shared `schur_peer_density_scale` primitive
                    let off_diag_weight = (weight_sum - 1.0).max(0.0);
                    let peer_count = evals.len().saturating_sub(1);
                    let expected_topo = raw_expected_topo
                        * crate::rivermemo_topology_v3::schur_peer_density_scale(
                            off_diag_weight,
                            peer_count,
                        );
                    let innovation = (ev_i.topo_excitation - expected_topo).max(0.0);
                    let grounded_coupling = 0.35 * ev_i.topo_excitation * ev_i.base_score.max(0.40);
                    let v3_final_score = (0.55 * ev_i.base_score + lambda_innovation * innovation + grounded_coupling).clamp(0.0, 1.0);

                    let has_graph_grounded_parent = ev_i.best_route.as_ref().is_some_and(|edge| {
                        selected.iter().any(|s| {
                            s.route.as_ref().is_some_and(|prev| {
                                let bridge_dst = if edge.source_id == prev.source_id {
                                    edge.target_id
                                } else {
                                    edge.source_id
                                };
                                follows(prev, edge)
                                    || (prev.target_id == edge.source_id && edge.hop > prev.hop)
                                    || artifact.edge_weight(prev.target_id, bridge_dst) >= 0.08
                            })
                        })
                    });
                    let v3_final_score = if !input.enable_v8_extensions {
                        (0.35 * ev_i.module.relevance + 0.65 * ev_i.topo_excitation).clamp(0.0, 1.0)
                    } else {
                        v3_final_score
                    };
                    let relation = match &ev_i.best_route {
                        Some(_) if ev_i.best_parents.is_empty() => "root",
                        Some(edge) if edge.wormhole => "analogy",
                        Some(_) if has_graph_grounded_parent => "continuation",
                        Some(_) => "analogy",
                        None => "supplement",
                    };
                    let ranking_score = if !input.enable_v8_extensions {
                        v3_final_score
                    } else if ev_i.best_route.is_some() {
                        (v3_final_score + 0.08 * ev_i.topo_excitation.sqrt()).min(1.0)
                    } else {
                        v3_final_score * 0.88
                    };
                    offers.push((
                        ev_i.module.file_id,
                        !input.enable_v8_extensions && ev_i.best_route.is_some(),
                        ranking_score,
                        ev_i.module.vector.clone(),
                        ev_i.module.v_norm,
                        Selection {
                            chunk_id: ev_i.module.id,
                            score: v3_final_score,
                            parents: ev_i.best_parents.clone(),
                            relation,
                            route: ev_i.best_route.clone(),
                            stage_idx: s_idx,
                            anchor_relevance: ev_i.module.anchor_relevance,
                        },
                    ));
                }
                offers.sort_by(|a, b| {
                    b.1.cmp(&a.1)
                        .then_with(|| b.2.total_cmp(&a.2))
                        .then_with(|| b.5.score.total_cmp(&a.5.score))
                        .then_with(|| a.5.chunk_id.cmp(&b.5.chunk_id))
                });
                let Some((file_id, _, _, chosen_vec, chosen_norm, choice)) = offers.into_iter().next() else {
                    break;
                };
                used_files.insert(file_id);
                if chosen_norm > 1e-12 {
                    selected_vecs.push((chosen_vec, chosen_norm));
                }
                if let Some(edge) = &choice.route {
                    used_edges.insert((edge.hop, edge.previous_id, edge.source_id, edge.target_id));
                }
                for &pid in &choice.parents {
                    *parent_usage_count.entry(pid).or_insert(0) += 1;
                }
                selected.push(choice.clone());
                results.push(choice);
            }
            output.push(StageOutput {
                diary_name: stage.diary_name.clone(),
                k: stage.k,
                results,
            });
        }
        if !selected.iter().any(|s| s.route.is_some()) {
            return Err("no grounded method route; use legacy chain".into());
        }

        // Industrial Inspiration Factory (Forward-Backward Latent Wormhole Collider):
        // Sweep cross-stage tag pairs (u in stage s, v in stage s+1) to discover high-potential
        // structural isomorphisms (cosine in Gaussian sweet spot [0.45, 0.85]) with zero/low historical co-occurrence.
        let mut latent_wormholes: Vec<LatentWormhole> = Vec::new();
        for s_idx in 0..num_stages.saturating_sub(1) {
            let (ref st_a, ref mods_a) = stage_modules[s_idx];
            let (ref st_b, ref mods_b) = stage_modules[s_idx + 1];
            for ma in mods_a.iter().take(8) {
                let alpha = (0.35 * ma.relevance + 0.65 * ma.ordered_tags.iter().map(|t| t.2).fold(0.0, f64::max)).max(0.2);
                for mb in mods_b.iter().take(8) {
                    if ma.file_id == mb.file_id {
                        continue;
                    }
                    let beta = (0.35 * mb.relevance + 0.65 * mb.ordered_tags.iter().map(|t| t.2).fold(0.0, f64::max)).max(0.2);
                    for &(u_id, _, u_closure) in ma.ordered_tags.iter().rev().take(3) {
                        if u_closure < input.min_closure {
                            continue;
                        }
                        let Some((ref u_vec, u_norm)) = global_tag_vecs.get(&u_id) else {
                            continue;
                        };
                        if *u_norm <= 1e-12 {
                            continue;
                        }
                        for &(v_id, _, v_closure) in mb.ordered_tags.iter().take(3) {
                            if u_id == v_id || v_closure < input.min_closure {
                                continue;
                            }
                            let hist_w = artifact.edge_weight(u_id, v_id);
                            if hist_w > 0.05 {
                                continue;
                            }
                            let Some((ref v_vec, v_norm)) = global_tag_vecs.get(&v_id) else {
                                continue;
                            };
                            if *v_norm <= 1e-12 {
                                continue;
                            }
                            let dot_uv: f64 = u_vec.iter().zip(v_vec.iter()).map(|(&a, &b)| (a as f64) * (b as f64)).sum();
                            let cos_uv = (dot_uv / (u_norm * v_norm)).clamp(-1.0, 1.0);
                            if (0.35..=0.88).contains(&cos_uv) {
                                let diff = (cos_uv - 0.65) / 0.20;
                                let sweet_gain = (-0.5 * diff * diff).exp();
                                let potential = alpha * beta * (u_closure * v_closure).sqrt() * sweet_gain / (1.0 + 10.0 * hist_w);
                                if potential >= 0.08 {
                                    latent_wormholes.push(LatentWormhole {
                                        from_stage: st_a.diary_name.clone(),
                                        to_stage: st_b.diary_name.clone(),
                                        from_module_id: ma.id,
                                        to_module_id: mb.id,
                                        source_tag_id: u_id,
                                        target_tag_id: v_id,
                                        structural_cosine: (cos_uv * 10000.0).round() / 10000.0,
                                        sweet_spot_gain: (sweet_gain * 10000.0).round() / 10000.0,
                                        inspiration_potential: (potential * 10000.0).round() / 10000.0,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
        optimization_hints.sort_by(|a, b| b.potential_score_gain.total_cmp(&a.potential_score_gain));
        optimization_hints.truncate(10);
        latent_wormholes.sort_by(|a, b| b.inspiration_potential.total_cmp(&a.inspiration_potential));
        latent_wormholes.truncate(10);

        serde_json::to_string(&serde_json::json!({
            "schema": "vcp-river-thinking-plan-v1",
            "artifactSig": artifact_sig,
            "observationHandle": input.observation_handle,
            "stages": output,
            "diagnostics": {
                "optimizationHints": optimization_hints,
                "latentWormholes": latent_wormholes
            }
        }))
        .map_err(|e| e.to_string())
    })
}

pub struct ThinkingTask {
    pub(crate) runtime: Arc<MemoRuntime>,
    pub(crate) db_path: String,
    pub(crate) artifact_sig: String,
    pub(crate) input_json: String,
}

impl Task for ThinkingTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<String> {
        plan(
            &self.runtime,
            &self.db_path,
            &self.artifact_sig,
            &self.input_json,
        )
        .map_err(Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, output: String) -> Result<String> {
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memo_sensing::{sense_typed, SenseConfig, SenseInput, SenseSeed};
    use crate::rivermemo_topology_v3::NativeArtifact;

    fn artifact() -> NativeArtifact {
        NativeArtifact {
            node_ids: vec![1, 2, 3],
            node_index: HashMap::from([(1, 0), (2, 1), (3, 2)]),
            row_offsets: vec![0, 1, 2, 2],
            targets: vec![1, 2],
            weights: vec![0.9, 0.9],
            inbound: HashMap::new(),
            max_inbound: 0.0,
            anchor_gain: HashMap::new(),
            wormhole_edges: HashSet::new(),
            provenance: HashMap::new(),
            ..NativeArtifact::default()
        }.prepared()
    }

    fn observation(graph: &NativeArtifact, limit: usize) -> crate::memo_sensing::SenseOutput {
        sense_typed(
            graph,
            "fixture",
            SenseInput {
                query_id: Some("test".into()),
                seeds: vec![SenseSeed {
                    id: 1,
                    energy: 1.0,
                    source_type: "seed".into(),
                }],
                config: SenseConfig {
                    max_transition_records: limit,
                    max_safe_hops: 3,
                    base_decay: 0.9,
                    firing_threshold: 0.001,
                    minimum_injected_current: 0.001,
                    ..SenseConfig::default()
                },
            },
        )
        .unwrap()
    }

    #[test]
    fn accepted_routes_preserve_propagation_and_reject_wrong_predecessor() {
        let graph = artifact();
        let plain = observation(&graph, 0);
        let recorded = observation(&graph, 100);
        assert!(plain.transitions.is_empty());
        assert_eq!(plain.source_field, recorded.source_field);
        assert_eq!(recorded.transitions.len(), 2);
        assert!(follows(&recorded.transitions[0], &recorded.transitions[1]));
        let mut wrong = recorded.transitions[1].clone();
        wrong.previous_id = Some(99);
        assert!(!follows(&recorded.transitions[0], &wrong));
        wrong = recorded.transitions[1].clone();
        wrong.immediate_return = true;
        assert!(!follows(&recorded.transitions[0], &wrong));
        let bounded = observation(&graph, 1);
        assert!(bounded.transitions_truncated);
        assert_eq!(bounded.transitions.len(), 1);
        assert_eq!(plain.source_field, bounded.source_field);
    }

    #[test]
    fn planning_uses_routes_and_scope_not_just_relevance() {
        let graph = Arc::new(artifact());
        let runtime = MemoRuntime::new();
        runtime.publish("fixture", graph.clone()).unwrap();
        let sensed = observation(&graph, 100);
        let handle = runtime
            .store_query_observation(
                "fixture",
                sensed,
                vec![1.0, 0.0],
                vec![1.0, 0.0],
                vec![1.0, 0.0],
                vec![1.0, 0.0],
                vec![],
                vec![],
                vec![],
                vec![],
                vec![],
                Arc::new(HashMap::new()),
                0,
            )
            .unwrap();
        let path = std::env::temp_dir().join(format!(
            "vcp-thinking-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let db_path = path.to_str().unwrap();
        let (storage, _) =
            crate::storage::SqliteStorageEngine::open_and_init(
                &path,
                crate::storage::StorageOptions::default(),
            )
            .unwrap();
        {
            let db = rusqlite::Connection::open(&path).unwrap();
            db.execute_batch(
                "CREATE TABLE IF NOT EXISTS files(id INTEGER PRIMARY KEY, diary_name TEXT);
                 CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY, file_id INTEGER, vector BLOB);
                 CREATE TABLE IF NOT EXISTS tags(id INTEGER PRIMARY KEY, vector BLOB);
                 CREATE TABLE IF NOT EXISTS file_tags(file_id INTEGER, tag_id INTEGER, position INTEGER);",
            )
            .unwrap();
            let bytes = |v: [f32; 2]| v.into_iter().flat_map(f32::to_ne_bytes).collect::<Vec<_>>();
            for id in 1..=3 {
                db.execute(
                    "INSERT INTO tags(name, vector) VALUES(?1, ?2)",
                    rusqlite::params![format!("tag-{}", id), bytes([1.0, 0.0])],
                )
                .unwrap();
            }
            for (id, diary, vector) in [
                (10, "A", [0.8, 0.6]),
                (20, "B", [0.8, 0.6]),
                (21, "B", [1.0, 0.0]),
                (22, "Other", [1.0, 0.0]),
            ] {
                db.execute(
                    "INSERT INTO files(id, path, diary_name, checksum, mtime, size) \
                     VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
                    rusqlite::params![
                        id,
                        format!("{}.md", id),
                        diary,
                        format!("checksum-{}", id),
                        0_i64,
                        0_i64
                    ],
                )
                .unwrap();
                db.execute(
                    "INSERT INTO chunks(id, file_id, chunk_index, content, vector) \
                     VALUES(?1, ?1, 0, ?2, ?3)",
                    rusqlite::params![id, format!("chunk-{}", id), bytes(vector)],
                )
                .unwrap();
            }
            for (file, tags) in [(10, [1, 2]), (20, [2, 3]), (21, [3, 2]), (22, [2, 3])] {
                for (pos, tag) in tags.into_iter().enumerate() {
                    db.execute(
                        "INSERT INTO file_tags VALUES(?1,?2,?3)",
                        rusqlite::params![file, tag, pos as i64],
                    )
                    .unwrap();
                }
            }
            db.execute_batch(
                "INSERT INTO rivermemo_artifacts(
                   artifact_sig,schema_version,algorithm_version,source_v9_artifact_sig,
                   source_graph_generation,model_sig,config_hash,database_generation,
                   provenance_generation,status,created_at,updated_at)
                 VALUES('fixture','rivermemo-persisted-artifact-v2','memo.native-artifact-v2-binary','test','test','test','test','0','test','ready',0,0);
                 INSERT INTO kbm_artifact_dependencies
                 SELECT 'fixture',key,value FROM kbm_runtime_meta
                 WHERE key IN ('memo_tag_facts','derived_geometry');"
            ).unwrap();
        }
        let input = serde_json::json!({
            "observationHandle": handle,
            "stages": [
                {"diaryName":"A","k":1,"candidateIds":[10]},
                {"diaryName":"B","k":1,"candidateIds":[21,22,20]},
                {"diaryName":"A","k":0,"candidateIds":[10]}
            ]
        });
        let output: serde_json::Value =
            serde_json::from_str(&plan(&runtime, db_path, "fixture", &input.to_string()).unwrap())
                .unwrap();
        assert_eq!(output["stages"][0]["results"][0]["chunkId"], 10);
        assert_eq!(output["stages"][1]["results"][0]["chunkId"], 20);
        assert_eq!(
            output["stages"][1]["results"][0]["parents"],
            serde_json::json!([10])
        );
        assert_eq!(
            output["stages"][1]["results"][0]["relation"],
            "continuation"
        );
        assert_eq!(output["stages"][2]["results"], serde_json::json!([]));
        // Verify Inverse Topology Diagnostics caught module #21's inverted tag order [3, 2] vs river edge 2 -> 3!
        let hints = output["diagnostics"]["optimizationHints"].as_array().unwrap();
        assert!(
            hints.iter().any(|h| h["moduleId"] == 21 && h["bottleneck"] == "TAG_ORDER_INVERTED"),
            "Inverse topology diagnostics must detect TAG_ORDER_INVERTED on module 21: {:?}",
            hints
        );
        // Verify V9 Homotopy Continuation Kernel & Isolation Flags
        let e1 = ObservationTransition {
            hop: 1,
            previous_id: None,
            source_id: 1,
            target_id: 2,
            flow: 0.6,
            wormhole: false,
            immediate_return: false,
        };
        let e2_homotopy = ObservationTransition {
            hop: 2,
            previous_id: Some(2),
            source_id: 3,
            target_id: 1,
            flow: 0.5,
            wormhole: false,
            immediate_return: false,
        };
        let e2_valid_bridge = ObservationTransition {
            hop: 2,
            previous_id: Some(2),
            source_id: 3,
            target_id: 99,
            flow: 0.5,
            wormhole: false,
            immediate_return: false,
        };
        assert!(!follows(&e1, &e2_valid_bridge));
        assert!(homotopy_continuation_factor(&e1, &e2_homotopy, true, &graph, &HashMap::new()).is_none());
        assert!(homotopy_continuation_factor(&e1, &e2_valid_bridge, false, &graph, &HashMap::new()).is_none());
        let relay = homotopy_continuation_factor(&e1, &e2_valid_bridge, true, &graph, &HashMap::new());
        assert!(relay.is_some_and(|f| f >= 0.85));

        runtime.clear().unwrap();
        assert!(plan(&runtime, db_path, "fixture", &input.to_string()).is_err());
        storage.shutdown().unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn stage_conjugate_weights_and_soft_tag_projection_prevent_blind_association() {
        // 1. Boundary stages (0 and 4 in a 5-stage chain) must weight anchor relevance strictly higher
        //    than the middle peak stage (stage 2), while stage 2 maximizes transfer & innovation gain.
        let (w_anchor_start, w_trf_start, w_route_start) = stage_conjugate_weights(0, 5);
        let (w_anchor_mid, w_trf_mid, w_route_mid) = stage_conjugate_weights(2, 5);
        let (w_anchor_end, w_trf_end, _) = stage_conjugate_weights(4, 5);
        assert!(w_anchor_start > w_anchor_mid);
        assert!(w_trf_mid > w_trf_start);
        assert!(w_route_mid > w_route_start);
        assert!((w_anchor_start - w_anchor_end).abs() < 1e-9);
        assert!((w_trf_start - w_trf_end).abs() < 1e-9);

        // 2. Soft Semantic Tag Projection & Tagless External Dipole Coupling
        let mut global_vecs: HashMap<i64, (Arc<[f32]>, f64)> = HashMap::new();
        global_vecs.insert(1, (Arc::from(vec![1.0_f32, 0.0]), 1.0));
        global_vecs.insert(2, (Arc::from(vec![0.0_f32, 1.0]), 1.0));
        global_vecs.insert(101, (Arc::from(vec![0.96_f32, 0.28]), 1.0));
        global_vecs.insert(102, (Arc::from(vec![0.28_f32, 0.96]), 1.0));
        global_vecs.insert(999, (Arc::from(vec![-1.0_f32, 0.0]), 1.0));

        let m_soft = Module {
            id: 501,
            file_id: 501,
            vector: Arc::from(vec![0.8_f32, 0.6]),
            v_norm: 1.0,
            relevance: 0.85,
            anchor_relevance: 0.85,
            transfer_relevance: 0.80,
            tags: HashMap::from([(101, (0, 0.82)), (102, (3, 0.84))]),
            ordered_tags: vec![(101, 0, 0.82), (102, 3, 0.84)],
        };
        let graph = artifact();
        let resolved = resolve_module_edge_endpoints(&m_soft, 1, 2, 0.20, &graph, &global_vecs);
        assert!(resolved.is_some());
        let (pa, ca, pb, cb, is_exact) = resolved.unwrap();
        assert!(!is_exact && pa < pb && ca >= 0.65 && cb >= 0.65);

        // 3. Noise tags below 0.62 cosine must be strictly rejected
        let m_noise = Module {
            id: 502,
            file_id: 502,
            vector: Arc::from(vec![0.8_f32, 0.6]),
            v_norm: 1.0,
            relevance: 0.90,
            anchor_relevance: 0.90,
            transfer_relevance: 0.50,
            tags: HashMap::from([(999, (0, 0.90)), (102, (1, 0.90))]),
            ordered_tags: vec![(999, 0, 0.90), (102, 1, 0.90)],
        };
        assert!(resolve_module_edge_endpoints(&m_noise, 1, 2, 0.20, &graph, &global_vecs).is_none());

        // 4. Tagless Pure Operator Dipole Coupling (`ordered_tags.is_empty()`)
        let m_tagless = Module {
            id: 503,
            file_id: 503,
            vector: Arc::from(vec![0.68_f32, 0.733]),
            v_norm: 1.0,
            relevance: 0.82,
            anchor_relevance: 0.82,
            transfer_relevance: 0.78,
            tags: HashMap::new(),
            ordered_tags: Vec::new(),
        };
        let dipole = resolve_module_edge_endpoints(&m_tagless, 1, 2, 0.20, &graph, &global_vecs);
        assert!(dipole.is_some(), "Tagless pure operator must couple with external river dipole");
    }
}
