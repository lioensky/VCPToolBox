use flate2::read::GzDecoder;
use napi::bindgen_prelude::*;
use rayon::prelude::*;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::memo_sensing::SenseOutput;
use crate::storage::{TagVectorPool, ensure_tag_vectors_loaded};

const RESULT_SCHEMA: &str = "rivermemo-topology-v3-native-result-v1";
const ALGORITHM_VERSION: &str = "rivermemo.topology-v3.1-rust";

fn clamp01(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn positive(value: f64) -> f64 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

fn cosine(left: &[f32], right: &[f32]) -> f64 {
    if left.len() != right.len() || left.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0;
    let mut left_norm = 0.0;
    let mut right_norm = 0.0;
    for index in 0..left.len() {
        let a = left[index] as f64;
        let b = right[index] as f64;
        dot += a * b;
        left_norm += a * a;
        right_norm += b * b;
    }
    cosine_from_parts(dot, left_norm, right_norm)
}

fn cosine_from_parts(dot: f64, left_norm: f64, right_norm: f64) -> f64 {
    if left_norm > 1e-15 && right_norm > 1e-15 {
        dot / (left_norm.sqrt() * right_norm.sqrt())
    } else {
        0.0
    }
}

/// The three accumulators in `cosine` are independent, so computing each one
/// separately in the same index order yields the same bits.
fn squared_norm(vector: &[f32]) -> f64 {
    let mut total = 0.0;
    for value in vector {
        let value = *value as f64;
        total += value * value;
    }
    total
}

fn cosine_with_norms(left: &[f32], left_norm: f64, right: &[f32], right_norm: f64) -> f64 {
    if left.len() != right.len() || left.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0;
    for index in 0..left.len() {
        dot += left[index] as f64 * right[index] as f64;
    }
    cosine_from_parts(dot, left_norm, right_norm)
}

/// Upper bound on the river/seed x candidate Tag table (32 MiB of f64).
const MAX_TAG_PAIR_COSINES: usize = 1 << 22;

/// Request-level cosine cache for the candidate readout. The same
/// (river or seed Tag, candidate Tag) pair recurs across candidates and chunks
/// of one file; every cached value is the raw `cosine` of the same two pool
/// vectors, so a lookup equals recomputation bit for bit. Misses recompute.
struct CosineCache {
    columns: HashMap<i64, usize>,
    column_norms: Vec<f64>,
    rows: HashMap<i64, usize>,
    row_norms: Vec<f64>,
    /// `cosine(river or seed Tag, candidate Tag)`, absent above the size bound.
    tag_pairs: Option<Vec<Vec<f64>>>,
    /// `cosine(query vector, candidate Tag)`; the query is not a Tag.
    query_tags: Vec<f64>,
}

impl CosineCache {
    fn build(
        curves: &[Curve],
        query: &[f32],
        row_ids: impl IntoIterator<Item = i64>,
        vectors: &TagVectorPool,
    ) -> Self {
        let mut columns = HashMap::new();
        let mut column_vectors: Vec<Arc<[f32]>> = Vec::new();
        for tag in curves.iter().flat_map(|curve| &curve.tags) {
            if let std::collections::hash_map::Entry::Vacant(entry) = columns.entry(tag.id) {
                entry.insert(column_vectors.len());
                column_vectors.push(tag.vector.clone());
            }
        }
        let mut rows = HashMap::new();
        let mut row_vectors: Vec<Arc<[f32]>> = Vec::new();
        for id in row_ids {
            let Some(vector) = vectors.get(&id) else { continue };
            if let std::collections::hash_map::Entry::Vacant(entry) = rows.entry(id) {
                entry.insert(row_vectors.len());
                row_vectors.push(vector.clone());
            }
        }
        let column_norms: Vec<f64> = column_vectors.par_iter().map(|v| squared_norm(v)).collect();
        let row_norms: Vec<f64> = row_vectors.iter().map(|v| squared_norm(v)).collect();
        let query_norm = squared_norm(query);
        let query_tags = column_vectors
            .par_iter()
            .zip(column_norms.par_iter())
            .map(|(column, norm)| cosine_with_norms(query, query_norm, column, *norm))
            .collect::<Vec<f64>>();
        let tag_pairs = (row_vectors.len().saturating_mul(column_vectors.len())
            <= MAX_TAG_PAIR_COSINES)
            .then(|| {
                row_vectors
                    .par_iter()
                    .zip(row_norms.par_iter())
                    .map(|(row, row_norm)| {
                        column_vectors
                            .iter()
                            .zip(&column_norms)
                            .map(|(column, norm)| cosine_with_norms(row, *row_norm, column, *norm))
                            .collect::<Vec<f64>>()
                    })
                    .collect::<Vec<Vec<f64>>>()
            });
        Self { columns, column_norms, rows, row_norms, tag_pairs, query_tags }
    }

    /// Same value as `cosine(left_vector, &tag.vector)`, where `left_vector`
    /// is the pool vector of `left_id`.
    fn tag_pair(&self, left_id: i64, left_vector: &[f32], tag: &TagData) -> f64 {
        match (self.rows.get(&left_id), self.columns.get(&tag.id)) {
            (Some(&row), Some(&column)) => match &self.tag_pairs {
                Some(table) => table[row][column],
                None => cosine_with_norms(
                    left_vector, self.row_norms[row], &tag.vector, self.column_norms[column],
                ),
            },
            _ => cosine(left_vector, &tag.vector),
        }
    }

    /// Same value as `cosine(query, &tag.vector)` for the request query vector.
    fn query_tag(&self, query: &[f32], tag: &TagData) -> f64 {
        match self.columns.get(&tag.id) {
            Some(&column) => self.query_tags[column],
            None => cosine(query, &tag.vector),
        }
    }
}

fn decode_vector(bytes: &[u8], dimension: usize) -> Option<Vec<f32>> {
    if bytes.len() != dimension * 4 {
        return None;
    }
    Some(
        bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_ne_bytes(chunk.try_into().unwrap()))
            .collect(),
    )
}

fn default_top_k() -> usize {
    10
}

fn default_dimension() -> usize {
    3072
}

fn default_true() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeInput {
    #[serde(default)]
    observation_handle: Option<String>,
    #[serde(default = "default_dimension")]
    dimension: usize,
    #[serde(default = "default_top_k")]
    top_k: usize,
    #[serde(default)]
    include_trace: bool,
    query: QueryInput,
    #[serde(default)]
    denoised_vector: Vec<f32>,
    #[serde(default)]
    local_vector: Vec<f32>,
    #[serde(default)]
    transfer_vector: Vec<f32>,
    #[serde(default)]
    candidates: Vec<CandidateInput>,
    query_state: QueryStateInput,
    #[serde(default)]
    allowed_file_ids: Option<Vec<i64>>,
    #[serde(default)]
    config: NativeConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryInput {
    #[serde(default, rename = "text")]
    _text: String,
    #[serde(default)]
    vector: Vec<f32>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CandidateInput {
    id: i64,
    #[serde(default)]
    score: f64,
    #[serde(default)]
    hybrid_score: f64,
    #[serde(default)]
    vector_score: f64,
    #[serde(default)]
    bm25_score: f64,
    #[serde(default)]
    time_score: f64,
    #[serde(default)]
    anchor_score: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryStateInput {
    #[serde(default)]
    query_id: Option<String>,
    #[serde(default)]
    source_field: Vec<(i64, f64)>,
    #[serde(default)]
    local_field: Vec<(i64, f64)>,
    #[serde(default)]
    transfer_field: Vec<(i64, f64)>,
    #[serde(default)]
    local_domain_ids: Vec<i64>,
    #[serde(default)]
    transfer_domain_ids: Vec<i64>,
    #[serde(default)]
    river_nodes: Vec<RiverNode>,
    #[serde(default)]
    river_edges: Vec<RiverEdge>,
    #[serde(default)]
    field_provenance: Vec<SourceProvenance>,
    #[serde(default = "default_true")]
    complete_observation: bool,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RiverNode {
    id: i64,
    #[serde(default)]
    energy: f64,
    #[serde(default)]
    normalized_energy: f64,
    #[serde(default)]
    hop: i64,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RiverEdge {
    source_id: i64,
    target_id: i64,
    #[serde(default)]
    flow: f64,
    #[serde(default)]
    normalized_flow: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceProvenance {
    id: i64,
    #[serde(default)]
    hop: i64,
    #[serde(default)]
    source_type: String,
}

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct NativeConfig {
    query_k: usize,
    denoised_k: usize,
    local_field_k: usize,
    transfer_field_k: usize,
    bm25_k: usize,
    anchor_k: usize,
    max_union_candidates: usize,
    local_weight: f64,
    transfer_weight: f64,
    direction_floor: f64,
    closure_floor: f64,
    semantic_node_threshold: f64,
    relative_distance_temperature: f64,
    reverse_direction_credit: f64,
    minimum_river_edge_flow: f64,
    maximum_river_edges: usize,
    node_only_reliability_cap: f64,
    kappa_edge: f64,
    kappa_ratio: f64,
    omega_epsilon: f64,
    collapsed_threshold: f64,
    sparse_threshold: f64,
    semantic_anchor_threshold: f64,
    semantic_anchor_discount: f64,
    specificity_floor: f64,
    rarity_floor: f64,
    reliability_seed_saturation: f64,
    fallback_reliability_cap: f64,
    pure_query_weight: f64,
    pure_local_weight: f64,
    pure_transfer_weight: f64,
    topology_bonus_cap: f64,
    topology_path_saturation: f64,
    conditional_bandwidth: f64,
    conditional_closure_bandwidth: f64,
    conditional_direct_bandwidth: f64,
    minimum_peers: usize,
    minimum_effective_peers: f64,
    innovation_confidence_z: f64,
    innovation_scale: f64,
    omega_gamma: f64,
    struct_role_min_omega: f64,
    anchor_bonus_cap: f64,
    anchor_activation_z: f64,
    anchor_activation_floor: f64,
    anchor_saturation: f64,
    anchor_frontier_contrast: f64,
    anchor_frontier_abs_floor: f64,
    #[serde(default)]
    experiment_preset: Option<String>,
    #[serde(default = "default_true")]
    enable_v8_extensions: bool,
    #[serde(default = "default_true")]
    enable_subspace_peer_kernel: bool,
    #[serde(default = "default_true")]
    enable_bipartite_bridge_pullback: bool,
    #[serde(default = "default_true")]
    enable_grassmann_subspace_readout: bool,
    #[serde(default = "default_true")]
    enable_cellular_sheaf_envelope: bool,
}

impl NativeConfig {
    pub(crate) fn apply_experiment_preset(&mut self) {
        if let Some(preset) = self.experiment_preset.as_deref() {
            match preset.trim().to_ascii_lowercase().as_str() {
                "upstream" | "v1" | "mainline" | "6167e64" | "legacy" | "v7" | "v7_legacy" | "off" | "all_off" => {
                    // Complete rollback to upstream baseline: disables all v2 extensions.
                    self.enable_v8_extensions = false;
                    self.enable_subspace_peer_kernel = false;
                    self.enable_bipartite_bridge_pullback = false;
                    self.enable_grassmann_subspace_readout = false;
                    self.enable_cellular_sheaf_envelope = false;
                }
                "v2" | "default" | "v9" | "v9_full" | "dual_ledger" => {
                    self.enable_v8_extensions = true;
                    self.enable_subspace_peer_kernel = true;
                    self.enable_bipartite_bridge_pullback = true;
                    self.enable_grassmann_subspace_readout = true;
                    self.enable_cellular_sheaf_envelope = true;
                }
                "v8_5" | "v8.5" => {
                    self.enable_v8_extensions = true;
                    self.enable_subspace_peer_kernel = true;
                    self.enable_bipartite_bridge_pullback = false;
                    self.enable_grassmann_subspace_readout = false;
                    self.enable_cellular_sheaf_envelope = false;
                }
                _ => {}
            }
        }
    }
}

impl Default for NativeConfig {
    fn default() -> Self {
        Self {
            query_k: 100,
            denoised_k: 100,
            local_field_k: 100,
            transfer_field_k: 100,
            bm25_k: 50,
            anchor_k: 50,
            max_union_candidates: 300,
            local_weight: 0.6,
            transfer_weight: 0.4,
            direction_floor: 0.05,
            closure_floor: 0.0,
            semantic_node_threshold: 0.48,
            relative_distance_temperature: 0.35,
            reverse_direction_credit: 0.25,
            minimum_river_edge_flow: 0.015,
            maximum_river_edges: 96,
            node_only_reliability_cap: 0.2,
            kappa_edge: 0.5,
            kappa_ratio: 0.3,
            omega_epsilon: 0.02,
            collapsed_threshold: 0.12,
            sparse_threshold: 0.45,
            semantic_anchor_threshold: 0.8,
            semantic_anchor_discount: 0.7,
            specificity_floor: 0.35,
            rarity_floor: 0.15,
            reliability_seed_saturation: 2.0,
            fallback_reliability_cap: 0.5,
            pure_query_weight: 0.25,
            pure_local_weight: 0.2,
            pure_transfer_weight: 0.15,
            topology_bonus_cap: 0.08,
            topology_path_saturation: 0.15,
            conditional_bandwidth: 0.04,
            conditional_closure_bandwidth: 0.1,
            conditional_direct_bandwidth: 0.12,
            minimum_peers: 3,
            minimum_effective_peers: 2.5,
            innovation_confidence_z: 1.0,
            innovation_scale: 0.5,
            omega_gamma: 1.0,
            struct_role_min_omega: 0.12,
            anchor_bonus_cap: 0.1,
            anchor_activation_z: 2.0,
            anchor_activation_floor: 0.05,
            anchor_saturation: 0.2,
            anchor_frontier_contrast: 2.0,
            anchor_frontier_abs_floor: 0.1,
            experiment_preset: None,
            enable_v8_extensions: true,
            enable_subspace_peer_kernel: true,
            enable_bipartite_bridge_pullback: true,
            enable_grassmann_subspace_readout: true,
            enable_cellular_sheaf_envelope: true,
        }
    }
}

/// Multi-hop discount per额外 step in a composed directed Stokes corridor: `0.70^(steps - 1)`.
const STOKES_CORRIDOR_STEP_DISCOUNT: f64 = 0.70;
/// Maximum number of composed (2..=3 hop) corridors kept, sorted by effective flow.
const STOKES_CORRIDOR_MAX_COMPOSED: usize = 64;
/// Maximum expansion depth of the directed corridor BFS.
const STOKES_CORRIDOR_MAX_STEPS: usize = 3;
/// Minimum 1-hop normalized flow that may seed a corridor.
const STOKES_CORRIDOR_MIN_FLOW: f64 = 0.015;

/// One directed Stokes channel `u ⇝ w` through the base manifold 1-skeleton.
///
/// By Stokes' theorem `∫_γ dφ = φ(w) - φ(u)`: the endpoint Tag potential difference is
/// fully determined by the oriented chain, so every consumer (`compute_bipartite_file_scores`,
/// `evaluate_topology`) reads the *same* corridor table instead of re-deriving reachability.
///
/// `steps == 1` means a genuine retained `river_edges` edge `(u -> w)`.
/// `steps >= 2` means a verified composed path with strictly non-decreasing hop order and a
/// strictly greater goal hop — a path that a note may skip in wording but not in direction.
/// Disconnected river branches stay disconnected here: no corridor is ever fabricated.
#[derive(Clone, Copy, Debug)]
pub(crate) struct DirectedStokesCorridor {
    pub source_id: i64,
    pub target_id: i64,
    /// 1 for a direct retained edge, 2..=3 for a verified composed path.
    pub steps: usize,
    /// `max(hop(u), hop(w))` of the reachable endpoints.
    pub max_hop: i64,
    /// Bottleneck flow `min_{e ∈ γ} J_e`, discounted by `0.70^(steps - 1)`.
    pub effective_flow: f64,
    /// Negative-curvature bridge factor averaged along the corridor.
    pub ricci_factor: f64,
}

/// Builds the shared directed Stokes corridor table from the retained river skeleton.
///
/// Only retained edges (flow `>= STOKES_CORRIDOR_MIN_FLOW`) contribute 1-hop corridors.
/// Composed corridors are generated by a bounded directed BFS that requires monotone hop
/// progression (`next_hop >= curr_hop`) and a strict frontier advance (`goal_hop > start_hop`),
/// keeping at most one corridor per `(source, target)` with the maximum bottleneck flow.
///
/// Audit P1-3 invariant: for disconnected branches such as `1 -> 2` plus `4 -> 3` the BFS never
/// reaches `3` from `1`, so no `(1, 3)` corridor exists and downstream flux is exactly `0`.
fn build_directed_stokes_corridors(
    retained_edges: &[&RiverEdge],
    river_nodes: &[RiverNode],
    artifact: &NativeArtifact,
    enable_multi_hop: bool,
) -> Vec<DirectedStokesCorridor> {
    let node_hop: HashMap<i64, i64> = river_nodes.iter().map(|node| (node.id, node.hop)).collect();
    let hop_of = |id: i64| node_hop.get(&id).copied().unwrap_or(0);
    let flow_of = |edge: &RiverEdge| {
        positive(if edge.normalized_flow != 0.0 {
            edge.normalized_flow
        } else {
            edge.flow
        })
    };

    let mut corridors: Vec<DirectedStokesCorridor> = Vec::new();
    let mut adjacency: HashMap<i64, Vec<(i64, f64)>> = HashMap::new();
    let mut direct_pairs: HashSet<(i64, i64)> = HashSet::new();
    for edge in retained_edges {
        let flow = flow_of(edge);
        if flow < STOKES_CORRIDOR_MIN_FLOW {
            continue;
        }
        adjacency.entry(edge.source_id).or_default().push((edge.target_id, flow));
        direct_pairs.insert((edge.source_id, edge.target_id));
        corridors.push(DirectedStokesCorridor {
            source_id: edge.source_id,
            target_id: edge.target_id,
            steps: 1,
            max_hop: hop_of(edge.source_id).max(hop_of(edge.target_id)),
            effective_flow: flow,
            ricci_factor: artifact.edge_ricci_factor(edge.source_id, edge.target_id),
        });
    }

    if enable_multi_hop && !adjacency.is_empty() {
        // Deterministic traversal: sort each adjacency list by target id so BFS order, and
        // therefore the `(source, target)` maximum-bottleneck selection, is reproducible.
        for neighbors in adjacency.values_mut() {
            neighbors.sort_by(|left, right| left.0.cmp(&right.0));
        }
        let mut sources: Vec<i64> = adjacency.keys().copied().collect();
        sources.sort_unstable();

        // `(source, target) -> (steps, bottleneck)`; the strongest bottleneck per pair wins.
        let mut composed: HashMap<(i64, i64), (usize, f64)> = HashMap::new();
        for source in sources {
            let start_hop = hop_of(source);
            // `path` is the live simple-path branch: a corridor may never revisit a node, and
            // the entry is popped on unwind so sibling branches stay independent.
            let mut path: Vec<i64> = vec![source];
            expand_directed_corridors(
                source,
                start_hop,
                source,
                0,
                f64::INFINITY,
                start_hop,
                &adjacency,
                &direct_pairs,
                &hop_of,
                &mut path,
                &mut composed,
            );
        }

        let mut composed_rows: Vec<((i64, i64), (usize, f64))> = composed.into_iter().collect();
        // Deterministic ranking: strongest discounted flux first, then stable (source, target).
        composed_rows.sort_by(|left, right| {
            let left_flow = left.1 .1 * STOKES_CORRIDOR_STEP_DISCOUNT.powi((left.1 .0 - 1) as i32);
            let right_flow = right.1 .1 * STOKES_CORRIDOR_STEP_DISCOUNT.powi((right.1 .0 - 1) as i32);
            right_flow
                .total_cmp(&left_flow)
                .then_with(|| left.0 .0.cmp(&right.0 .0))
                .then_with(|| left.0 .1.cmp(&right.0 .1))
        });
        composed_rows.truncate(STOKES_CORRIDOR_MAX_COMPOSED);
        for ((source_id, target_id), (steps, bottleneck)) in composed_rows {
            corridors.push(DirectedStokesCorridor {
                source_id,
                target_id,
                steps,
                max_hop: hop_of(source_id).max(hop_of(target_id)),
                effective_flow: bottleneck * STOKES_CORRIDOR_STEP_DISCOUNT.powi((steps - 1) as i32),
                ricci_factor: artifact.edge_ricci_factor(source_id, target_id),
            });
        }
    }

    corridors
}

/// Recursive simple-path expansion for [`build_directed_stokes_corridors`].
///
/// Records `(source -> current)` into `composed` whenever the branch is a genuine composed
/// reach (not a direct retained edge) and has advanced past the start hop. Bounded to
/// `STOKES_CORRIDOR_MAX_STEPS` steps so cost stays `O(deg^2)` on the retained skeleton.
#[allow(clippy::too_many_arguments)]
fn expand_directed_corridors(
    source: i64,
    start_hop: i64,
    current: i64,
    steps: usize,
    bottleneck: f64,
    current_hop: i64,
    adjacency: &HashMap<i64, Vec<(i64, f64)>>,
    direct_pairs: &HashSet<(i64, i64)>,
    hop_of: &impl Fn(i64) -> i64,
    path: &mut Vec<i64>,
    composed: &mut HashMap<(i64, i64), (usize, f64)>,
) {
    if steps >= STOKES_CORRIDOR_MAX_STEPS {
        return;
    }
    let Some(neighbors) = adjacency.get(&current) else { return };
    for &(next_id, edge_flow) in neighbors {
        if next_id == source || path.contains(&next_id) {
            continue;
        }
        let next_hop = hop_of(next_id);
        if next_hop < current_hop {
            continue;
        }
        let next_steps = steps + 1;
        let next_bottleneck = bottleneck.min(edge_flow);
        // A composed corridor must strictly advance the narrative hop frontier: a skipped
        // intermediate node may be omitted from wording, never routed backwards.
        if !direct_pairs.contains(&(source, next_id)) && next_hop > start_hop {
            let entry = composed
                .entry((source, next_id))
                .or_insert((next_steps, next_bottleneck));
            let better =
                next_steps < entry.0 || ((next_steps == entry.0) && next_bottleneck > entry.1);
            if better {
                *entry = (next_steps, next_bottleneck);
            }
        }
        path.push(next_id);
        expand_directed_corridors(
            source,
            start_hop,
            next_id,
            next_steps,
            next_bottleneck,
            next_hop,
            adjacency,
            direct_pairs,
            hop_of,
            path,
            composed,
        );
        path.pop();
    }
}

/// Live fingerprint of the `file_tags` and `tags` fact tables so hot-state resident
/// bipartite indices immediately detect tag deletions, insertions, or position moves
/// even when the training graph `artifact_sig` remains unchanged.
#[derive(Default, Clone, PartialEq, Eq, Debug)]
pub(crate) struct FileTagFactFingerprint {
    pub(crate) db_generation: u64,
    pub(crate) relation_count: i64,
    pub(crate) relation_checksum: i64,
    pub(crate) tag_count: i64,
    pub(crate) tag_checksum: i64,
}

/// Tag <-> File order-preserving bipartite CSR index synced to live fact tables.
#[derive(Default, Clone)]
pub(crate) struct BipartiteHypergraphIndex {
    /// tag_id -> Tag name
    pub(crate) tag_names: HashMap<i64, String>,
    /// file_id -> ordered Vec<(tag_id, position)>
    pub(crate) file_to_tags: HashMap<i64, Vec<(i64, i64)>>,
    /// tag_id -> sorted Vec<(file_id, normalized_pos_u16, raw_position)>
    /// Sorted strictly by `file_id` ASC so two-pointer sorted intersection runs in O(deg(u) + deg(v)).
    pub(crate) tag_to_files: HashMap<i64, Vec<(i64, u16, i64)>>,
    /// file_id -> primary representative chunk_id (highest-norm or first valid chunk)
    pub(crate) file_primary_chunk: HashMap<i64, i64>,
    /// True when built from a full SQLite connection scan (distinguishes live DB snapshots from partial test fixtures).
    pub(crate) from_live_db: bool,
}

impl BipartiteHypergraphIndex {
    pub(crate) fn compute_fingerprint(connection: &Connection) -> FileTagFactFingerprint {
        let db_generation = crate::storage::read_generation(connection).unwrap_or(0);
        let (relation_count, relation_checksum): (i64, i64) = connection
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM( \
                    ((ft.file_id * 1000003) + (ft.tag_id * 9176) + (COALESCE(ft.position, 0) * 131)) \
                    * ((ft.file_id & 255) + 17) \
                 ), 0) FROM file_tags ft",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap_or((0, 0));
        let (tag_count, tag_checksum): (i64, i64) = connection
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(t.id * 65537 + LENGTH(t.name) * 257), 0) FROM tags t",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap_or((0, 0));
        FileTagFactFingerprint {
            db_generation,
            relation_count,
            relation_checksum,
            tag_count,
            tag_checksum,
        }
    }

    pub(crate) fn build_from_connection(connection: &Connection) -> Self {
        let mut index = Self {
            from_live_db: true,
            ..Self::default()
        };
        if let Ok(mut stmt) = connection.prepare("SELECT id, name FROM tags") {
            if let Ok(rows) = stmt.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))) {
                for row in rows.flatten() {
                    index.tag_names.insert(row.0, row.1);
                }
            }
        }
        if let Ok(mut stmt) = connection.prepare(
            "SELECT ft.file_id, ft.tag_id, COALESCE(ft.position, 0) \
             FROM file_tags ft \
             ORDER BY ft.file_id ASC, ft.position ASC, ft.tag_id ASC",
        ) {
            if let Ok(rows) = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            }) {
                for row in rows.flatten() {
                    index.file_to_tags.entry(row.0).or_default().push((row.1, row.2));
                }
            }
        }
        for (&file_id, tags) in &index.file_to_tags {
            let len = tags.len();
            let denom = len.saturating_sub(1).max(1) as f64;
            for (ord, &(tag_id, raw_pos)) in tags.iter().enumerate() {
                let norm_u16 = if len <= 1 {
                    32768u16
                } else {
                    ((ord as f64 / denom) * 65535.0).round().clamp(0.0, 65535.0) as u16
                };
                index
                    .tag_to_files
                    .entry(tag_id)
                    .or_default()
                    .push((file_id, norm_u16, raw_pos));
            }
        }
        for list in index.tag_to_files.values_mut() {
            list.sort_by_key(|entry| entry.0);
            list.dedup_by_key(|entry| entry.0);
        }
        if let Ok(mut stmt) = connection.prepare(
            "SELECT file_id, MIN(id) FROM chunks WHERE vector IS NOT NULL GROUP BY file_id",
        ) {
            if let Ok(rows) = stmt.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))) {
                for row in rows.flatten() {
                    index.file_primary_chunk.insert(row.0, row.1);
                }
            }
        }
        index
    }
}
#[derive(Default, Clone)]
pub(crate) struct NativeArtifact {
    pub(crate) node_ids: Vec<i64>,
    pub(crate) node_index: HashMap<i64, usize>,
    pub(crate) row_offsets: Vec<usize>,
    pub(crate) targets: Vec<usize>,
    pub(crate) weights: Vec<f64>,
    pub(crate) inbound: HashMap<i64, f64>,
    pub(crate) max_inbound: f64,
    pub(crate) anchor_gain: HashMap<i64, f64>,
    pub(crate) wormhole_edges: HashSet<(i64, i64)>,
    pub(crate) provenance: HashMap<(i64, i64), Vec<(i64, f64)>>,
    pub(crate) node_anchor_gain: Vec<f64>,
    pub(crate) edge_is_wormhole: Vec<bool>,
    /// Row L2 norm: \sqrt{\sum_v w_{uv}^2}.
    pub(crate) row_l2_norm: Vec<f64>,
    /// Triangle-overlap bottleneck bridge factor in [0.30, 1.0].
    pub(crate) edge_ricci_bridge: Vec<f64>,
    /// Live-synced Tag <-> File bipartite index and its fact-table fingerprint.
    pub(crate) bipartite: Option<Arc<BipartiteHypergraphIndex>>,
    pub(crate) bipartite_fingerprint: Option<FileTagFactFingerprint>,
}
impl NativeArtifact {
    /// Derive immutable hot-path arrays after CSR validation, for both freshly
    /// built and restored assets. Temporary workspace is bounded to one row.
    pub(crate) fn prepared(mut self) -> Self {
        self.node_anchor_gain = self.node_ids.iter()
            .map(|id| self.anchor_gain.get(id).copied().unwrap_or(1.0)).collect();
        self.edge_is_wormhole = vec![false; self.targets.len()];
        self.row_l2_norm = vec![1.0; self.node_ids.len()];
        self.edge_ricci_bridge = vec![1.0; self.targets.len()];
        let mut sorted_neighbors: Vec<Vec<usize>> = Vec::with_capacity(self.node_ids.len());
        for source in 0..self.node_ids.len() {
            let start = self.row_offsets[source];
            let end = self.row_offsets[source + 1];
            let mut row: Vec<(usize, f64)> = (start..end)
                .map(|cursor| (self.targets[cursor], self.weights[cursor])).collect();
            row.sort_by(|left, right| positive(right.1).total_cmp(&positive(left.1))
                .then_with(|| self.node_ids[left.0].cmp(&self.node_ids[right.0])));
            let mut sum_sq = 0.0;
            let mut nbrs = Vec::with_capacity(end.saturating_sub(start));
            for (cursor, (target, weight)) in (start..end).zip(row) {
                self.targets[cursor] = target;
                self.weights[cursor] = weight;
                let pw = positive(weight);
                if pw > 0.0 {
                    nbrs.push(target);
                }
                sum_sq += pw * pw;
                self.edge_is_wormhole[cursor] = self.wormhole_edges
                    .contains(&(self.node_ids[source], self.node_ids[target]));
            }
            nbrs.sort_unstable();
            nbrs.dedup();
            sorted_neighbors.push(nbrs);
            let l2 = sum_sq.sqrt();
            self.row_l2_norm[source] = if l2 > 1e-12 { l2 } else { 1.0 };
        }
        // Compute discrete Ricci negative-curvature bridge factor via sorted two-pointer intersection
        for source in 0..self.node_ids.len() {
            let start = self.row_offsets[source];
            let end = self.row_offsets[source + 1];
            let u_nbrs = &sorted_neighbors[source];
            if u_nbrs.is_empty() {
                continue;
            }
            for cursor in start..end {
                let target = self.targets[cursor];
                let v_nbrs = &sorted_neighbors[target];
                let min_deg = u_nbrs.len().min(v_nbrs.len());
                if min_deg == 0 {
                    self.edge_ricci_bridge[cursor] = 1.0;
                    continue;
                }
                let (mut i, mut j, mut shared) = (0usize, 0usize, 0usize);
                while i < u_nbrs.len() && j < v_nbrs.len() {
                    match u_nbrs[i].cmp(&v_nbrs[j]) {
                        Ordering::Less => i += 1,
                        Ordering::Greater => j += 1,
                        Ordering::Equal => {
                            shared += 1;
                            i += 1;
                            j += 1;
                        }
                    }
                }
                let overlap_ratio = (shared as f64 / min_deg as f64).clamp(0.0, 1.0);
                // Negative curvature bottleneck (\triangle = 0) gets full 1.0 bridge factor;
                // dense intra-cluster clique edge (\triangle -> 1) is dampened to 0.30.
                self.edge_ricci_bridge[cursor] = 1.0 - 0.70 * overlap_ratio;
            }
        }
        self
    }

    pub(crate) fn edge_weight(&self, source_id: i64, target_id: i64) -> f64 {
        let Some(&source) = self.node_index.get(&source_id) else {
            return 0.0;
        };
        let Some(&target) = self.node_index.get(&target_id) else {
            return 0.0;
        };
        let start = self.row_offsets[source];
        let end = self.row_offsets[source + 1];
        for cursor in start..end {
            if self.targets[cursor] == target {
                return positive(self.weights[cursor]);
            }
        }
        0.0
    }

    pub(crate) fn independent_fraction(&self, source: i64, target: i64, file_id: i64) -> f64 {
        let Some(contributions) = self.provenance.get(&(source, target)) else {
            return 1.0;
        };
        let total: f64 = contributions.iter().map(|item| item.1).sum();
        if total <= 0.0 {
            return 1.0;
        }
        let own: f64 = contributions
            .iter()
            .filter(|item| item.0 == file_id)
            .map(|item| item.1)
            .sum();
        clamp01(1.0 - own / total).max(0.15)
    }

    pub(crate) fn edge_ricci_factor(&self, source_id: i64, target_id: i64) -> f64 {
        let Some(&source) = self.node_index.get(&source_id) else {
            return 1.0;
        };
        let Some(&target) = self.node_index.get(&target_id) else {
            return 1.0;
        };
        let start = self.row_offsets[source];
        let end = self.row_offsets[source + 1];
        for cursor in start..end {
            if self.targets[cursor] == target {
                return self.edge_ricci_bridge.get(cursor).copied().unwrap_or(1.0);
            }
        }
        1.0
    }

    /// V9 Order-Preserving 2-Simplex Edge-Flux & 1-Simplex Transfer Adjoint Pullback:
    /// Computes the bipartite adjoint potential \mathbf{s}_{\text{topo}}(f) over files using
    /// two-pointer sorted posting list intersection over the **shared directed Stokes corridor
    /// table** (1-hop retained edges plus verified 2..=3 hop reachable bridges) and
    /// degree-normalized transfer nodes.
    ///
    /// Reading the same `corridors` slice that `evaluate_topology` consumes is what closes the
    /// multi-hop Stokes boundary split: a diary that records `u ⇝ w` and skips the ferry node `v`
    /// now earns a real bipartite pullback instead of a hard zero.
    fn compute_bipartite_file_scores(
        &self,
        river_nodes: &[RiverNode],
        corridors: &[DirectedStokesCorridor],
        transfer_field: &[(i64, f64)],
        allowed_files: Option<&HashSet<i64>>,
    ) -> HashMap<i64, f64> {
        let Some(bipartite) = self.bipartite.as_ref() else {
            return HashMap::new();
        };
        let node_hop: HashMap<i64, i64> = river_nodes.iter().map(|n| (n.id, n.hop)).collect();
        let mut file_scores: HashMap<i64, f64> = HashMap::new();

        // 1) Directed Stokes Corridor Flux Pullback:
        //    J_{u⇝w} * \kappa_{Ricci}(u,w) * \sigma(\phi_f(w) - \phi_f(u))
        for corridor in corridors.iter().take(64) {
            if corridor.effective_flow < STOKES_CORRIDOR_MIN_FLOW {
                continue;
            }
            let Some(u_list) = bipartite.tag_to_files.get(&corridor.source_id) else {
                continue;
            };
            let Some(v_list) = bipartite.tag_to_files.get(&corridor.target_id) else {
                continue;
            };
            let hop_depth_gain = 1.0 + 0.35 * (corridor.max_hop.clamp(0, 4) as f64);
            // Penalize BOTH endpoints' document frequencies so a high-degree generic hub
            // (`df >= 50`) paired with a low-degree tag cannot bypass IDF damping via `min(df_u, df_v)`.
            let deg_u = u_list.len().max(1) as f64;
            let deg_v = v_list.len().max(1) as f64;
            let hub_penalty = if deg_u.max(deg_v) > 36.0 {
                (36.0 / deg_u.max(deg_v)).sqrt()
            } else {
                1.0
            };
            let idf_scale = (1.0 / (deg_u.min(deg_v).sqrt() * (deg_u.max(deg_v) / deg_u.min(deg_v)).powf(0.25))) * hub_penalty;

            let (mut i, mut j) = (0usize, 0usize);
            while i < u_list.len() && j < v_list.len() {
                let (u_file, u_pos, _) = u_list[i];
                let (v_file, v_pos, _) = v_list[j];
                match u_file.cmp(&v_file) {
                    Ordering::Less => i += 1,
                    Ordering::Greater => j += 1,
                    Ordering::Equal => {
                        i += 1;
                        j += 1;
                        if let Some(scope) = allowed_files {
                            if !scope.contains(&u_file) {
                                continue;
                            }
                        }
                        let delta_phi = (v_pos as f64 - u_pos as f64) / 65535.0;
                        // Composed corridors additionally REQUIRE strict forward narrative
                        // order: a reverse skip over multiple hops has no Stokes orientation
                        // and must not be pulled back.
                        if corridor.steps >= 2 && delta_phi <= 0.0 {
                            continue;
                        }
                        // Order-preserving narrative orientation credit: forward causal order
                        // gets full credit + phase bonus.
                        let orientation = if delta_phi > 0.0 {
                            1.0 + 0.45 * delta_phi.sqrt()
                        } else if delta_phi < 0.0 {
                            0.35
                        } else {
                            0.50
                        };
                        let stokes_flux = corridor.effective_flow
                            * corridor.ricci_factor
                            * hop_depth_gain
                            * orientation
                            * idf_scale;
                        *file_scores.entry(u_file).or_default() += stokes_flux;
                    }
                }
            }
        }

        // 2) 1-Simplex Degree-Normalized Transfer Field Adjoint Pullback: B D_T^{-1/2} f_trf
        let mut sorted_trf: Vec<(i64, f64)> = transfer_field
            .iter()
            .filter(|&&(id, val)| id > 0 && val > 0.0)
            .copied()
            .collect();
        sorted_trf.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        let max_trf = sorted_trf.first().map(|x| x.1).unwrap_or(1.0).max(1e-12);
        for (tag_id, mass) in sorted_trf.into_iter().take(24) {
            let norm_mass = mass / max_trf;
            if norm_mass < 0.08 {
                continue;
            }
            let Some(f_list) = bipartite.tag_to_files.get(&tag_id) else {
                continue;
            };
            if f_list.len() > 64 {
                continue; // skip overly generic high-degree hub tags
            }
            let hop = node_hop.get(&tag_id).copied().unwrap_or(1);
            if hop == 0 {
                continue; // focus on emergent cross-domain transfer nodes
            }
            let deg_inv_sqrt = 1.0 / ((f_list.len().max(1) as f64).sqrt());
            let contrib = 0.22 * norm_mass * deg_inv_sqrt * (1.0 + 0.25 * (hop.min(4) as f64));
            for &(file_id, _, _) in f_list {
                if let Some(scope) = allowed_files {
                    if !scope.contains(&file_id) {
                        continue;
                    }
                }
                *file_scores.entry(file_id).or_default() += contrib;
            }
        }

        file_scores
    }

    fn pullback_bridge_candidates(
        &self,
        river_nodes: &[RiverNode],
        corridors: &[DirectedStokesCorridor],
        transfer_field: &[(i64, f64)],
        allowed_files: Option<&HashSet<i64>>,
        existing_chunk_ids: &HashSet<i64>,
        limit: usize,
    ) -> Vec<(i64, i64, f64)> {
        let Some(bipartite) = self.bipartite.as_ref() else {
            return Vec::new();
        };
        if limit == 0 || bipartite.file_primary_chunk.is_empty() {
            return Vec::new();
        }
        let file_scores = self.compute_bipartite_file_scores(
            river_nodes,
            corridors,
            transfer_field,
            allowed_files,
        );
        let mut ranked: Vec<(i64, i64, f64)> = file_scores
            .into_iter()
            .filter_map(|(file_id, score)| {
                if score <= 0.02 {
                    return None;
                }
                let &chunk_id = bipartite.file_primary_chunk.get(&file_id)?;
                if existing_chunk_ids.contains(&chunk_id) {
                    return None;
                }
                Some((chunk_id, file_id, score))
            })
            .collect();
        ranked.sort_by(|a, b| b.2.total_cmp(&a.2).then_with(|| a.0.cmp(&b.0)));
        ranked.truncate(limit);
        ranked
    }
}

/// 统一管线留在原生侧、供候选阶段两个读出头复用的请求级观测。
///
/// 请求上下文而非跨请求结果缓存：持有河网、双场和已读取的 Tag 向量池。
/// 最后一个内部消费者完成后由拥有者释放句柄；不复制常驻全库图。
pub(crate) struct MemoQueryObservation {
    pub(crate) artifact_sig: String,
    pub(crate) artifact_generation: u64,
    pub(crate) observation: Arc<SenseOutput>,
    pub(crate) original_query_vector: Arc<Vec<f32>>,
    pub(crate) enhanced_query_vector: Arc<Vec<f32>>,
    pub(crate) local_vector: Arc<Vec<f32>>,
    pub(crate) transfer_vector: Arc<Vec<f32>>,
    pub(crate) transfer_basin_vectors: Arc<Vec<Vec<f32>>>,
    pub(crate) local_field: Arc<Vec<(i64, f64)>>,
    pub(crate) transfer_field: Arc<Vec<(i64, f64)>>,
    pub(crate) local_domain_ids: Arc<Vec<i64>>,
    pub(crate) transfer_domain_ids: Arc<Vec<i64>>,
    pub(crate) tag_vectors: Arc<TagVectorPool>,
    pub(crate) database_generation: u64,
}

impl MemoQueryObservation {
    /// Owned payload capacity only; excludes allocator headers and Arc headers.
    fn payload_bytes(&self) -> usize {
        use std::mem::size_of;
        let observation = &self.observation;
        self.artifact_sig.capacity()
            + size_of::<Self>()
            + size_of::<SenseOutput>()
            + observation.schema.capacity()
            + observation.algorithm_version.capacity()
            + observation.artifact_sig.capacity()
            + observation.query_id.as_ref().map_or(0, String::capacity)
            + observation.source_field.capacity() * size_of::<(i64, f64)>()
            + observation.nodes.capacity() * size_of::<crate::memo_sensing::ObservationNode>()
            + observation.nodes.iter().map(|node| node.source_type.capacity()
                + node.origin_type.as_ref().map_or(0, String::capacity)).sum::<usize>()
            + observation.edges.capacity() * size_of::<crate::memo_sensing::ObservationEdge>()
            + observation.transitions.capacity() * size_of::<crate::memo_sensing::ObservationTransition>()
            + observation.diagnostics.backend.capacity()
            + observation.diagnostics.hop_in_flight_mass.capacity() * size_of::<f64>()
            + [&self.original_query_vector, &self.enhanced_query_vector,
                &self.local_vector, &self.transfer_vector].iter()
                .map(|vector| vector.capacity() * size_of::<f32>()).sum::<usize>()
            + self.transfer_basin_vectors.iter()
                .map(|v| v.capacity() * size_of::<f32>()).sum::<usize>()
            + (self.local_field.capacity() + self.transfer_field.capacity())
                * size_of::<(i64, f64)>()
            + self.tag_vectors.values().map(|v| v.len() * size_of::<f32>()).sum::<usize>()
            + self.tag_vectors.capacity() * size_of::<(i64, Arc<[f32]>)>()
            + (self.local_domain_ids.capacity() + self.transfer_domain_ids.capacity())
                * size_of::<i64>()
    }
}

struct MemoQueryCacheEntry {
    value: Arc<MemoQueryObservation>,
    inserted_at: Instant,
}

/// VexusIndex 实例拥有的统一 Memo 原生运行时。
///
/// 活动资产使用 Arc 快照：查询开始时克隆一次 Arc，后续发布不会改变本次查询；
/// 旧代资产在最后一个查询释放后自动回收。请求观测缓存与活动资产代际绑定，
/// 让 RiverMemo Topology V3 直接复用统一管线产物，避免河网经 JS JSON 往返。
pub(crate) struct MemoRuntime {
    active_artifact: RwLock<Option<(String, u64, Arc<NativeArtifact>)>>,
    generation: AtomicU64,
    query_sequence: AtomicU64,
    query_cache: Mutex<HashMap<String, MemoQueryCacheEntry>>,
    query_cache_order: Mutex<VecDeque<String>>,
    query_cache_capacity: usize,
    query_cache_ttl: Duration,
    /// 冷加载排队：同时冷加载的查询只解码一次，其余等它发布后直接复用。
    cold_load: Mutex<()>,
}

impl MemoRuntime {
    pub(crate) fn new() -> Self {
        Self {
            active_artifact: RwLock::new(None),
            generation: AtomicU64::new(0),
            query_sequence: AtomicU64::new(0),
            query_cache: Mutex::new(HashMap::new()),
            query_cache_order: Mutex::new(VecDeque::new()),
            query_cache_capacity: 256,
            query_cache_ttl: Duration::from_secs(5 * 60),
            cold_load: Mutex::new(()),
        }
    }

    fn get(&self, artifact_sig: &str) -> std::result::Result<Option<Arc<NativeArtifact>>, String> {
        let guard = self
            .active_artifact
            .read()
            .map_err(|error| format!("memo runtime read lock failed: {}", error))?;
        Ok(guard
            .as_ref()
            .filter(|(signature, _, _)| signature == artifact_sig)
            .map(|(_, _, artifact)| artifact.clone()))
    }

    pub(crate) fn publish(
        &self,
        artifact_sig: &str,
        artifact: Arc<NativeArtifact>,
    ) -> std::result::Result<u64, String> {
        let mut guard = self
            .active_artifact
            .write()
            .map_err(|error| format!("memo runtime publish lock failed: {}", error))?;

        // 多个并发冷查询可能同时在写锁外解码同一个持久化 Artifact。
        // 第一个任务发布后，后续同签名任务必须视为幂等命中：不能递增
        // generation，也不能清空刚由其他查询写入的 observationHandle。
        //
        // Artifact 签名是内容寻址身份；同签名代表同一不可变图资产，因此保留
        // 已发布 Arc 与代际既安全，也避免重复解码任务破坏请求级观测缓存。
        if let Some((active_sig, active_generation, _)) = guard.as_ref() {
            if active_sig == artifact_sig {
                return Ok(*active_generation);
            }
        }
        let generation = self.generation.fetch_add(1, AtomicOrdering::AcqRel) + 1;
        *guard = Some((artifact_sig.to_string(), generation, artifact));
        drop(guard);

        // 只有真正切换到不同 Artifact 时，旧代请求观测才必须失效。
        self.clear_query_cache()?;
        Ok(generation)
    }

    /// Update the live `bipartite` fact snapshot on the active artifact in-place
    /// without bumping `generation` or invalidating active `observationHandle` entries.
    pub(crate) fn refresh_active_artifact_facts(
        &self,
        artifact_sig: &str,
        updated: Arc<NativeArtifact>,
    ) -> std::result::Result<(), String> {
        let mut guard = self
            .active_artifact
            .write()
            .map_err(|error| format!("memo runtime fact refresh lock failed: {}", error))?;
        if let Some((active_sig, active_gen, slot)) = guard.as_mut() {
            if active_sig == artifact_sig {
                let _ = *active_gen;
                *slot = updated;
            }
        }
        Ok(())
    }

    fn active_generation(&self, artifact_sig: &str) -> std::result::Result<u64, String> {
        let guard = self
            .active_artifact
            .read()
            .map_err(|error| format!("memo runtime generation lock failed: {}", error))?;
        guard
            .as_ref()
            .filter(|(signature, _, _)| signature == artifact_sig)
            .map(|(_, generation, _)| *generation)
            .ok_or_else(|| {
                format!(
                    "memo runtime artifact {} is not the active generation",
                    artifact_sig
                )
            })
    }

    fn clear_query_cache(&self) -> std::result::Result<(), String> {
        self.query_cache
            .lock()
            .map_err(|error| format!("memo query cache lock failed: {}", error))?
            .clear();
        self.query_cache_order
            .lock()
            .map_err(|error| format!("memo query cache order lock failed: {}", error))?
            .clear();
        Ok(())
    }

    pub(crate) fn store_query_observation(
        &self,
        artifact_sig: &str,
        observation: SenseOutput,
        original_query_vector: Vec<f32>,
        enhanced_query_vector: Vec<f32>,
        local_vector: Vec<f32>,
        transfer_vector: Vec<f32>,
        transfer_basin_vectors: Vec<Vec<f32>>,
        local_field: Vec<(i64, f64)>,
        transfer_field: Vec<(i64, f64)>,
        local_domain_ids: Vec<i64>,
        transfer_domain_ids: Vec<i64>,
        tag_vectors: Arc<TagVectorPool>,
        database_generation: u64,
    ) -> std::result::Result<String, String> {
        let artifact_generation = self.active_generation(artifact_sig)?;
        let sequence = self.query_sequence.fetch_add(1, AtomicOrdering::AcqRel) + 1;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let handle = format!(
            "memoq-{:016x}-{:016x}-{:016x}",
            artifact_generation,
            sequence,
            (timestamp as u64) ^ sequence.rotate_left(17)
        );
        let value = Arc::new(MemoQueryObservation {
            artifact_sig: artifact_sig.to_string(),
            artifact_generation,
            observation: Arc::new(observation),
            original_query_vector: Arc::new(original_query_vector),
            enhanced_query_vector: Arc::new(enhanced_query_vector),
            local_vector: Arc::new(local_vector),
            transfer_vector: Arc::new(transfer_vector),
            transfer_basin_vectors: Arc::new(transfer_basin_vectors),
            local_field: Arc::new(local_field),
            transfer_field: Arc::new(transfer_field),
            local_domain_ids: Arc::new(local_domain_ids),
            transfer_domain_ids: Arc::new(transfer_domain_ids),
            tag_vectors,
            database_generation,
        });

        let now = Instant::now();
        let mut cache = self
            .query_cache
            .lock()
            .map_err(|error| format!("memo query cache lock failed: {}", error))?;
        let mut order = self
            .query_cache_order
            .lock()
            .map_err(|error| format!("memo query cache order lock failed: {}", error))?;
        while let Some(front) = order.front().cloned() {
            let expired = cache
                .get(&front)
                .map(|entry| now.duration_since(entry.inserted_at) > self.query_cache_ttl)
                .unwrap_or(true);
            if !expired && cache.len() < self.query_cache_capacity {
                break;
            }
            order.pop_front();
            cache.remove(&front);
        }
        while cache.len() >= self.query_cache_capacity {
            let Some(oldest) = order.pop_front() else {
                break;
            };
            cache.remove(&oldest);
        }
        cache.insert(
            handle.clone(),
            MemoQueryCacheEntry {
                value,
                inserted_at: now,
            },
        );
        order.push_back(handle.clone());
        Ok(handle)
    }

    pub(crate) fn get_query_observation(
        &self,
        handle: &str,
        artifact_sig: &str,
    ) -> std::result::Result<Arc<MemoQueryObservation>, String> {
        let active_generation = self.active_generation(artifact_sig)?;
        let now = Instant::now();
        let mut cache = self
            .query_cache
            .lock()
            .map_err(|error| format!("memo query cache lock failed: {}", error))?;
        let entry = cache
            .get(handle)
            .ok_or_else(|| format!("memo query observation handle {} is unavailable", handle))?;
        if now.duration_since(entry.inserted_at) > self.query_cache_ttl {
            cache.remove(handle);
            return Err(format!("memo query observation handle {} expired", handle));
        }
        if entry.value.artifact_sig != artifact_sig
            || entry.value.artifact_generation != active_generation
        {
            return Err("memo query observation artifact generation mismatch".to_string());
        }
        Ok(entry.value.clone())
    }

    pub(crate) fn release_query_observation(&self, handle: &str)
        -> std::result::Result<bool, String> {
        // Remove both ownership and FIFO bookkeeping under the insertion lock order.
        // Consumers that already cloned the Arc remain valid until they complete.
        let mut cache = self.query_cache.lock()
            .map_err(|error| format!("memo query cache lock failed: {}", error))?;
        let mut order = self.query_cache_order.lock()
            .map_err(|error| format!("memo query cache order lock failed: {}", error))?;
        let removed = cache.remove(handle).is_some();
        order.retain(|entry| entry != handle);
        Ok(removed)
    }

    pub(crate) fn clear(&self) -> std::result::Result<(), String> {
        let mut guard = self
            .active_artifact
            .write()
            .map_err(|error| format!("memo runtime clear lock failed: {}", error))?;
        *guard = None;
        drop(guard);
        self.clear_query_cache()
    }

    pub(crate) fn observation_memory_stats(&self) -> std::result::Result<String, String> {
        let cache = self.query_cache.lock()
            .map_err(|error| format!("memo query cache lock failed: {}", error))?;
        let now = Instant::now();
        let mut bytes = 0usize;
        let mut expired = 0usize;
        let mut nodes = 0usize;
        let mut edges = 0usize;
        let mut field_entries = 0usize;
        let mut tag_vector_nodes = 0usize;
        let mut tag_vector_bytes = 0usize;
        let mut largest = 0usize;
        let mut oldest_ms = 0u128;
        for entry in cache.values() {
            let size = entry.value.payload_bytes();
            bytes += size;
            largest = largest.max(size);
            let age = now.duration_since(entry.inserted_at);
            oldest_ms = oldest_ms.max(age.as_millis());
            expired += usize::from(age > self.query_cache_ttl);
            nodes += entry.value.observation.nodes.len();
            edges += entry.value.observation.edges.len();
            field_entries += entry.value.local_field.len() + entry.value.transfer_field.len();
            tag_vector_nodes += entry.value.tag_vectors.len();
            tag_vector_bytes += entry.value.tag_vectors.values()
                .map(|vector| vector.len() * std::mem::size_of::<f32>()).sum::<usize>();
        }
        serde_json::to_string(&serde_json::json!({
            "entries": cache.len(), "expiredEntries": expired,
            "capacity": self.query_cache_capacity, "ttlMs": self.query_cache_ttl.as_millis(),
            "payloadCapacityBytes": bytes, "largestPayloadBytes": largest,
            "nodes": nodes, "edges": edges, "fieldEntries": field_entries,
            "tagVectorNodes": tag_vector_nodes, "tagVectorBytes": tag_vector_bytes,
            "ownership": "request-context-release-after-last-consumer",
            "oldestAgeMs": oldest_ms,
            "note": "Retained observation payload capacities; excludes allocator/container overhead and active task clones. Read-only: does not evict expired entries."
        })).map_err(|error| error.to_string())
    }

    pub(crate) fn diagnostics(
        &self,
    ) -> std::result::Result<(Option<String>, u64, usize, usize), String> {
        let guard = self
            .active_artifact
            .read()
            .map_err(|error| format!("memo runtime diagnostics lock failed: {}", error))?;
        Ok(match guard.as_ref() {
            Some((signature, generation, artifact)) => (
                Some(signature.clone()),
                *generation,
                artifact.node_ids.len(),
                artifact.targets.len(),
            ),
            None => (None, self.generation.load(AtomicOrdering::Acquire), 0, 0),
        })
    }
}

fn decode_provenance_row(row: &Value) -> Option<(i64, f64)> {
    let values = row.as_array()?;
    let mass_index = if values.len() == 2 { 1 } else if values.len() >= 4 { 3 } else { return None };
    let file_id = values[0].as_i64()?;
    let mass = values[mass_index].as_f64()?;
    if file_id <= 0 || !mass.is_finite() || mass < 0.0 { return None; }
    Some((file_id, mass))
}

fn decode_artifact(
    connection: &Connection,
    artifact_sig: &str,
) -> std::result::Result<Arc<NativeArtifact>, String> {
    const MAX_DECOMPRESSED_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;

    let (codec, expected_checksum, compressed): (String, String, Vec<u8>) = connection
        .query_row(
            "SELECT payload_codec, payload_checksum, payload FROM rivermemo_artifacts \
             WHERE artifact_sig = ?1 AND status = 'ready' LIMIT 1",
            rusqlite::params![artifact_sig],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| format!("RiverMemo artifact {} unavailable: {}", artifact_sig, error))?;
    if codec != "gzip-json-v1" {
        return Err(format!("unsupported RiverMemo artifact codec: {}", codec));
    }

    let decoder = GzDecoder::new(compressed.as_slice());
    let mut limited = decoder.take(MAX_DECOMPRESSED_ARTIFACT_BYTES + 1);
    let mut raw = Vec::new();
    limited
        .read_to_end(&mut raw)
        .map_err(|error| format!("decompress RiverMemo artifact failed: {}", error))?;
    if raw.len() as u64 > MAX_DECOMPRESSED_ARTIFACT_BYTES {
        return Err(format!(
            "RiverMemo artifact {} exceeds decompressed size limit of {} bytes",
            artifact_sig, MAX_DECOMPRESSED_ARTIFACT_BYTES
        ));
    }
    let actual_checksum = format!("{:x}", Sha256::digest(&raw));
    if expected_checksum.is_empty() || actual_checksum != expected_checksum {
        return Err(format!(
            "RiverMemo artifact {} checksum mismatch",
            artifact_sig
        ));
    }

    let mut payload: Value = serde_json::from_slice(&raw)
        .map_err(|error| format!("decode RiverMemo artifact JSON failed: {}", error))?;
    drop(raw);

    // 大数组从解析树里取出（take）而不是复制，转换后各自释放。
    let transport = payload
        .get_mut("sharedTransport")
        .ok_or_else(|| "RiverMemo artifact has no sharedTransport".to_string())?;
    let node_ids: Vec<i64> = serde_json::from_value(
        transport
            .get_mut("nodeIds")
            .map(Value::take)
            .unwrap_or(Value::Array(Vec::new())),
    )
    .map_err(|error| format!("decode transport nodeIds failed: {}", error))?;
    let row_offsets_u64: Vec<u64> = serde_json::from_value(
        transport
            .get_mut("rowOffsets")
            .map(Value::take)
            .unwrap_or(Value::Array(Vec::new())),
    )
    .map_err(|error| format!("decode transport rowOffsets failed: {}", error))?;
    let targets_u64: Vec<u64> = serde_json::from_value(
        transport
            .get_mut("targetIndices")
            .map(Value::take)
            .unwrap_or(Value::Array(Vec::new())),
    )
    .map_err(|error| format!("decode transport targets failed: {}", error))?;
    let weights: Vec<f64> = serde_json::from_value(
        transport
            .get_mut("weights")
            .map(Value::take)
            .unwrap_or(Value::Array(Vec::new())),
    )
    .map_err(|error| format!("decode transport weights failed: {}", error))?;

    let mut unique_node_ids = HashSet::with_capacity(node_ids.len());
    if node_ids
        .iter()
        .any(|id| *id <= 0 || !unique_node_ids.insert(*id))
    {
        return Err(format!(
            "RiverMemo artifact {} contains invalid or duplicate node IDs",
            artifact_sig
        ));
    }
    if row_offsets_u64.len() != node_ids.len() + 1 {
        return Err(format!(
            "RiverMemo artifact {} CSR rowOffsets length mismatch",
            artifact_sig
        ));
    }
    if row_offsets_u64.first().copied() != Some(0)
        || row_offsets_u64.windows(2).any(|pair| pair[0] > pair[1])
    {
        return Err(format!(
            "RiverMemo artifact {} CSR rowOffsets are not monotonic from zero",
            artifact_sig
        ));
    }
    if targets_u64.len() != weights.len()
        || row_offsets_u64.last().copied() != Some(targets_u64.len() as u64)
    {
        return Err(format!(
            "RiverMemo artifact {} CSR edge array length mismatch",
            artifact_sig
        ));
    }
    if targets_u64
        .iter()
        .any(|target| *target >= node_ids.len() as u64)
    {
        return Err(format!(
            "RiverMemo artifact {} CSR target index out of bounds",
            artifact_sig
        ));
    }
    if weights
        .iter()
        .any(|weight| !weight.is_finite() || *weight < 0.0)
    {
        return Err(format!(
            "RiverMemo artifact {} contains invalid edge weights",
            artifact_sig
        ));
    }

    let node_index = node_ids
        .iter()
        .enumerate()
        .map(|(index, id)| (*id, index))
        .collect();
    let row_offsets = row_offsets_u64
        .into_iter()
        .map(|value| value as usize)
        .collect();
    let targets = targets_u64
        .into_iter()
        .map(|value| value as usize)
        .collect();

    let mut inbound = HashMap::new();
    if let Some(entries) = payload.get("inboundMassView").and_then(Value::as_array) {
        for entry in entries {
            if let Some(parts) = entry.as_array() {
                if parts.len() >= 2 {
                    if let (Some(id), Some(value)) = (parts[0].as_i64(), parts[1].as_f64()) {
                        inbound.insert(id, positive(value));
                    }
                }
            }
        }
    }
    let max_inbound = payload
        .get("artifact")
        .and_then(|value| value.get("maxInbound"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);

    let mut anchor_gain = HashMap::new();
    if let Some(entries) = payload.get("anchorGainView").and_then(Value::as_array) {
        for entry in entries {
            let Some(parts) = entry.as_array() else {
                continue;
            };
            if parts.len() < 2 {
                continue;
            }
            if let (Some(id), Some(value)) = (parts[0].as_i64(), parts[1].as_f64()) {
                anchor_gain.insert(id, positive(value));
            }
        }
    }

    let mut wormhole_edges = HashSet::new();
    if let Some(entries) = payload.get("wormholeView").and_then(Value::as_array) {
        for entry in entries {
            let Some(key) = entry.as_str() else {
                continue;
            };
            let ids: Vec<i64> = key
                .split(':')
                .filter_map(|value| value.parse::<i64>().ok())
                .collect();
            if ids.len() == 2 {
                wormhole_edges.insert((ids[0], ids[1]));
            }
        }
    }

    let mut provenance = HashMap::new();
    if let Some(Value::Array(edges)) = payload
        .get_mut("provenanceView")
        .and_then(|value| value.get_mut("edges"))
        .map(Value::take)
    {
        for edge in edges {
            let Some(parts) = edge.as_array() else {
                continue;
            };
            if parts.len() < 2 {
                continue;
            }
            let Some(key) = parts[0].as_str() else {
                continue;
            };
            let ids: Vec<i64> = key
                .split(':')
                .filter_map(|value| value.parse::<i64>().ok())
                .collect();
            if ids.len() != 2 {
                continue;
            }
            let mut contributions = Vec::new();
            if let Some(rows) = parts[1].as_array() {
                for row in rows {
                    if let Some(contribution) = decode_provenance_row(row) {
                        contributions.push(contribution);
                    }
                }
            }
            provenance.insert((ids[0], ids[1]), contributions);
        }
    }
    let bipartite_fingerprint = Some(BipartiteHypergraphIndex::compute_fingerprint(connection));
    let bipartite = Some(Arc::new(BipartiteHypergraphIndex::build_from_connection(
        connection,
    )));
    Ok(Arc::new(
        NativeArtifact {
            node_ids,
            node_index,
            row_offsets,
            targets,
            weights,
            inbound,
            max_inbound,
            anchor_gain,
            wormhole_edges,
            provenance,
            bipartite,
            bipartite_fingerprint,
            ..NativeArtifact::default()
        }
        .prepared(),
    ))
}

pub(crate) fn load_artifact_with_connection(
    runtime: &MemoRuntime,
    connection: &Connection,
    artifact_sig: &str,
) -> std::result::Result<Arc<NativeArtifact>, String> {
    let compatible: bool = connection.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM rivermemo_artifacts a
           WHERE a.artifact_sig=?1 AND a.status='ready'
             AND a.algorithm_version='memo.native-artifact-v2-binary'
             AND a.schema_version='rivermemo-persisted-artifact-v2'
             AND (SELECT COUNT(*) FROM kbm_artifact_dependencies d
                  WHERE d.artifact_sig=a.artifact_sig
                    AND d.dependency_key IN (SELECT value FROM json_each(?2)))=?3
             AND (SELECT COUNT(*) FROM kbm_artifact_dependencies d WHERE d.artifact_sig=a.artifact_sig)=?3
             AND NOT EXISTS(
               SELECT 1 FROM kbm_artifact_dependencies d
               LEFT JOIN kbm_runtime_meta m ON m.key=d.dependency_key
               WHERE d.artifact_sig=a.artifact_sig
                 AND (m.value IS NULL
                      OR CAST(m.value AS INTEGER) < CAST(d.dependency_version AS INTEGER))
             )
         )", rusqlite::params![
             artifact_sig,
             serde_json::to_string(crate::storage::MEMO_ARTIFACT_DEPENDENCIES).map_err(|e|e.to_string())?,
             crate::storage::MEMO_ARTIFACT_DEPENDENCIES.len() as i64
         ], |row| row.get(0),
    ).map_err(|error| format!("Validate Memo artifact dependencies failed: {}", error))?;
    if !compatible {
        return Err("KNOWLEDGE_STORE_DERIVED_DEPENDENCY_CONFLICT: Memo artifact is incompatible (format, missing dependencies or version rollback)".to_string());
    }
    let current_fp = BipartiteHypergraphIndex::compute_fingerprint(connection);
    if let Some(artifact) = runtime.get(artifact_sig)? {
        if artifact.bipartite_fingerprint.as_ref() == Some(&current_fp) {
            return Ok(artifact);
        }
        let refreshed_bipartite = Arc::new(BipartiteHypergraphIndex::build_from_connection(connection));
        let mut updated = (*artifact).clone();
        updated.bipartite = Some(refreshed_bipartite);
        updated.bipartite_fingerprint = Some(current_fp);
        let updated_arc = Arc::new(updated);
        runtime.refresh_active_artifact_facts(artifact_sig, updated_arc.clone())?;
        return Ok(updated_arc);
    }

    // 同时冷加载的查询在这里排队：第一个解码并发布，后面的再查一次就命中，
    // 不再各自解码一份。锁里没有数据，所以持锁线程 panic 后照常取锁。
    let _cold_load = runtime.cold_load.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(artifact) = runtime.get(artifact_sig)? {
        return Ok(artifact);
    }

    // 解码和校验在写锁外完成；连接由 StorageEngine Read Pool 提供。
    let staging = decode_artifact(connection, artifact_sig)?;
    runtime.publish(artifact_sig, staging.clone())?;
    Ok(staging)
}

#[derive(Clone)]
struct TagData {
    id: i64,
    name: String,
    position: i64,
    /// 同一 Tag 在所有候选曲线间共享同一份解码向量，只做引用计数克隆。
    vector: Arc<[f32]>,
    chunk_cosine: f64,
}

#[derive(Clone)]
struct Curve {
    id: i64,
    file_id: i64,
    tags: Vec<TagData>,
    chunk_vector: Arc<[f32]>,
    query_score: f64,
    denoised_score: f64,
    local_score: f64,
    transfer_score: f64,
    /// Orthogonal-complement residual `s_perp` of the chunk against the unit query axis
    /// `q_hat`: `sqrt(||c||^2 - <q_hat, c>^2)`. Zero for a pure parallel direct answer.
    ortho_residual: f64,
    bipartite_score: f64,
    bm25_score: f64,
    time_score: f64,
    anchor_score: f64,
    union_score: f64,
    union_rank: usize,
    sources: Vec<String>,
}

/// Tag rows of one file in position order: (Tag ID, position, name).
type FileTagRows = HashMap<i64, Vec<(i64, i64, String)>>;

struct CurveLoadOutput {
    /// Candidate curves without Tags; `attach_tags` adds them after selection.
    curves: Vec<Curve>,
    relations: FileTagRows,
    chunk_sql_batches: usize,
    file_tag_sql_batches: usize,
}

/// Attaches each curve's Tags in position order, keeping only Tags whose vector
/// is in the pool: missing or invalid vector rows are never loaded, so they are
/// dropped exactly as before.
fn attach_tags(curves: &mut [Curve], relations: &FileTagRows, tag_vectors: &TagVectorPool) {
    for curve in curves {
        let chunk_vector = curve.chunk_vector.clone();
        curve.tags = relations
            .get(&curve.file_id)
            .into_iter()
            .flatten()
            .filter_map(|(id, position, name)| {
                let vector = tag_vectors.get(id)?;
                Some(TagData {
                    id: *id,
                    position: *position,
                    name: name.clone(),
                    vector: vector.clone(),
                    chunk_cosine: clamp01(cosine(vector, &chunk_vector)),
                })
            })
            .collect();
    }
}

fn load_curves(
    connection: &Connection,
    candidates: &[CandidateInput],
    dimension: usize,
    bipartite: Option<&BipartiteHypergraphIndex>,
) -> std::result::Result<CurveLoadOutput, String> {
    const SQLITE_BATCH_SIZE: usize = 500;
    let candidate_ids: Vec<i64> = candidates
        .iter()
        .map(|candidate| candidate.id)
        .filter(|id| *id > 0)
        .collect();
    let mut chunks_by_id: HashMap<i64, (i64, Arc<[f32]>)> =
        HashMap::with_capacity(candidate_ids.len());
    let mut unique_file_ids = HashSet::new();

    let mut chunk_sql_batches = 0usize;
    // Chunk 向量按 ID 分块读取；候选池不再产生逐候选 SQL。
    for batch in candidate_ids.chunks(SQLITE_BATCH_SIZE) {
        if batch.is_empty() {
            continue;
        }
        chunk_sql_batches += 1;
        let placeholders = std::iter::repeat("?")
            .take(batch.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT id, file_id, vector FROM chunks WHERE id IN ({})",
            placeholders
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| format!("prepare batched chunk projection failed: {}", error))?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(batch.iter()), |row| {
                let bytes: Vec<u8> = row.get(2)?;
                Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, bytes))
            })
            .map_err(|error| format!("query batched chunk projection failed: {}", error))?;
        for row in rows {
            let Ok((id, file_id, bytes)) = row else {
                continue;
            };
            let Some(vector) = decode_vector(&bytes, dimension) else {
                continue;
            };
            unique_file_ids.insert(file_id);
            chunks_by_id.insert(id, (file_id, Arc::from(vector)));
        }
    }

    // Zero-SQL Bipartite Curve Projection (when synced with live DB fact fingerprint):
    let file_ids: Vec<i64> = unique_file_ids.into_iter().collect();
    let mut relations: FileTagRows = HashMap::with_capacity(file_ids.len());
    let mut file_tag_sql_batches = 0usize;
    let mut missing_files = Vec::new();
    if let Some(bip) = bipartite {
        for &file_id in &file_ids {
            if let Some(tags) = bip.file_to_tags.get(&file_id) {
                let mut row_vec = Vec::with_capacity(tags.len());
                for &(tag_id, pos) in tags {
                    if let Some(name) = bip.tag_names.get(&tag_id) {
                        row_vec.push((tag_id, pos, name.clone()));
                    }
                }
                relations.insert(file_id, row_vec);
            } else if bip.from_live_db {
                // Live DB snapshot is authoritative: a file absent from `file_to_tags` has 0 tags.
                relations.insert(file_id, Vec::new());
            } else {
                missing_files.push(file_id);
            }
        }
    } else {
        missing_files = file_ids;
    }
    for batch in missing_files.chunks(SQLITE_BATCH_SIZE) {
        if batch.is_empty() {
            continue;
        }
        file_tag_sql_batches += 1;
        let placeholders = std::iter::repeat("?")
            .take(batch.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT ft.file_id, ft.tag_id, COALESCE(ft.position, 0), t.name \
             FROM file_tags ft JOIN tags t ON t.id = ft.tag_id \
             WHERE ft.file_id IN ({}) \
             ORDER BY ft.file_id, ft.position, ft.tag_id",
            placeholders
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| format!("prepare batched tag curve projection failed: {}", error))?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(batch.iter()), |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|error| format!("query batched tag curve projection failed: {}", error))?;
        for row in rows {
            let Ok((file_id, tag_id, position, name)) = row else { continue };
            relations.entry(file_id).or_default().push((tag_id, position, name));
        }
    }
    // 恢复原始候选顺序；稳定排序与旧实现完全一致。
    let mut curves = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let Some((file_id, chunk_vector)) = chunks_by_id.get(&candidate.id) else {
            continue;
        };
        curves.push(Curve {
            id: candidate.id,
            file_id: *file_id,
            tags: Vec::new(),
            chunk_vector: chunk_vector.clone(),
            query_score: 0.0,
            denoised_score: 0.0,
            local_score: 0.0,
            transfer_score: 0.0,
            ortho_residual: 0.0,
            bipartite_score: 0.0,
            bm25_score: positive(candidate.bm25_score),
            time_score: positive(candidate.time_score),
            anchor_score: positive(candidate.anchor_score),
            union_score: 0.0,
            union_rank: 0,
            sources: Vec::new(),
        });
    }
    Ok(CurveLoadOutput {
        curves,
        relations,
        chunk_sql_batches,
        file_tag_sql_batches,
    })
}

/// `hits(curve)`: the curve's Tags with a vector that lie in the local domain.
fn compute_anchor_scores(curves: &mut [Curve], hits: impl Fn(&Curve) -> usize) {
    let max_hits = curves.iter().map(&hits).max().unwrap_or(0);
    if max_hits == 0 {
        return;
    }
    for curve in curves {
        let hits = hits(curve);
        curve.anchor_score = curve.anchor_score.max(hits as f64 / max_hits as f64);
    }
}

fn source_top(curves: &[Curve], field: fn(&Curve) -> f64, limit: usize) -> Vec<(i64, f64, usize)> {
    let mut ranked: Vec<(i64, f64)> = curves
        .iter()
        .map(|curve| (curve.id, field(curve)))
        .filter(|item| item.1.is_finite() && item.1 > 0.0)
        .collect();
    ranked.sort_by(|left, right| {
        right
            .1
            .partial_cmp(&left.1)
            .unwrap_or(Ordering::Equal)
            .then_with(|| left.0.cmp(&right.0))
    });
    ranked
        .into_iter()
        .take(limit.max(1))
        .enumerate()
        .map(|(index, item)| (item.0, item.1, index + 1))
        .collect()
}

fn select_superset(curves: Vec<Curve>, config: &NativeConfig) -> Vec<Curve> {
    let mut sources = vec![
        (
            "query_knn",
            source_top(&curves, |curve| curve.query_score, config.query_k),
        ),
        (
            "denoised_field_knn",
            source_top(&curves, |curve| curve.denoised_score, config.denoised_k),
        ),
        (
            "local_field_knn",
            source_top(&curves, |curve| curve.local_score, config.local_field_k),
        ),
        (
            "transfer_field_knn",
            source_top(
                &curves,
                |curve| curve.transfer_score,
                config.transfer_field_k,
            ),
        ),
        (
            "bm25",
            source_top(&curves, |curve| curve.bm25_score, config.bm25_k),
        ),
        (
            "time",
            source_top(&curves, |curve| curve.time_score, config.query_k),
        ),
        (
            "anchor_direct",
            source_top(&curves, |curve| curve.anchor_score, config.anchor_k),
        ),
    ];
    if config.enable_bipartite_bridge_pullback {
        sources.push((
            "bipartite_corridor",
            source_top(&curves, |curve| curve.bipartite_score, config.anchor_k.min(16)),
        ));
    }

    let mut source_map: HashMap<i64, Vec<(String, f64, usize)>> = HashMap::new();
    for (name, ranked) in sources {
        if ranked.is_empty() {
            continue;
        }
        let minimum = ranked
            .iter()
            .map(|entry| entry.1)
            .fold(f64::INFINITY, f64::min);
        let maximum = ranked
            .iter()
            .map(|entry| entry.1)
            .fold(f64::NEG_INFINITY, f64::max);
        let spread = maximum - minimum;
        for (id, raw_score, rank) in ranked {
            let normalized = if spread > 1e-12 {
                clamp01((raw_score - minimum) / spread)
            } else {
                clamp01(1.0 / rank as f64)
            };
            source_map
                .entry(id)
                .or_default()
                .push((name.to_string(), normalized, rank));
        }
    }

    let mut selected: Vec<Curve> = curves
        .into_iter()
        .filter_map(|mut curve| {
            let entries = source_map.get(&curve.id)?;
            let maximum = entries.iter().map(|entry| entry.1).fold(0.0, f64::max);
            let mean = entries.iter().map(|entry| entry.1).sum::<f64>() / entries.len() as f64;
            let reciprocal = entries
                .iter()
                .map(|entry| 1.0 / (60.0 + entry.2 as f64))
                .sum::<f64>();
            let multi_bonus = (0.05 * entries.len().saturating_sub(1) as f64).min(0.2);
            curve.union_score = clamp01(
                0.5 * maximum + 0.25 * mean + 0.25 * clamp01(reciprocal * 20.0) + multi_bonus,
            );
            curve.sources = entries.iter().map(|entry| entry.0.clone()).collect();
            Some(curve)
        })
        .collect();
    selected.sort_by(|left, right| {
        right
            .sources
            .len()
            .cmp(&left.sources.len())
            .then_with(|| {
                right
                    .union_score
                    .partial_cmp(&left.union_score)
                    .unwrap_or(Ordering::Equal)
            })
            .then_with(|| left.id.cmp(&right.id))
    });
    selected.truncate(config.max_union_candidates.max(1));
    for (index, curve) in selected.iter_mut().enumerate() {
        curve.union_rank = index + 1;
    }
    selected
}

#[derive(Clone)]
struct FieldWorkspace {
    local: HashMap<i64, f64>,
    transfer: HashMap<i64, f64>,
    local_domain: HashSet<i64>,
    transfer_domain: HashSet<i64>,
    source_ids: HashSet<i64>,
}

fn normalize_field(entries: &[(i64, f64)]) -> HashMap<i64, f64> {
    let maximum = entries
        .iter()
        .map(|entry| positive(entry.1))
        .fold(0.0, f64::max);
    entries
        .iter()
        .filter_map(|entry| {
            let value = positive(entry.1);
            if entry.0 > 0 && value > 0.0 {
                Some((
                    entry.0,
                    if maximum > 0.0 {
                        value / maximum
                    } else {
                        value
                    },
                ))
            } else {
                None
            }
        })
        .collect()
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeometryOutput {
    path_quality: f64,
    path_core: f64,
    tag_closure: f64,
    support_coverage: f64,
    segment_count: usize,
    supported_segments: usize,
    transfer_segments: usize,
    mean_direction: f64,
    mean_continuity: f64,
    mean_local_potential: f64,
    mean_transfer_potential: f64,
}

fn evaluate_path(
    curve: &Curve,
    workspace: &FieldWorkspace,
    artifact: &NativeArtifact,
    config: &NativeConfig,
) -> GeometryOutput {
    let mut output = GeometryOutput::default();
    let mut quality_mass = 0.0;
    // Forward cut-edge (anchor domain -> transfer domain) cross potential keeps its full
    // geometric weight; the reverse direction is discounted by the same 0.65 directional
    // credit the Gentner dipole operator uses.
    const CUT_EDGE_REVERSE_CREDIT: f64 = 0.65;
    // Cut-edge potential must clear this floor before it can substitute for graph flow.
    const CUT_EDGE_MIN_POTENTIAL: f64 = 0.15;
    // A cut segment may not out-shine a genuine same-domain segment: it is enveloped at 0.92
    // against the same-domain potential so a cross-strait hop never invents extra potential.
    const CUT_EDGE_ENVELOPE: f64 = 0.92;
    for pair in curve.tags.windows(2) {
        let current = &pair[0];
        let next = &pair[1];
        let local_potential = (workspace.local.get(&current.id).copied().unwrap_or(0.0)
            * workspace.local.get(&next.id).copied().unwrap_or(0.0))
        .sqrt();
        let transfer_potential = (workspace.transfer.get(&current.id).copied().unwrap_or(0.0)
            * workspace.transfer.get(&next.id).copied().unwrap_or(0.0))
        .sqrt();
        let forward = artifact.edge_weight(current.id, next.id);
        let reverse = artifact.edge_weight(next.id, current.id);
        let local_supported = workspace.local_domain.contains(&current.id)
            && workspace.local_domain.contains(&next.id);
        let transfer_supported = workspace.transfer_domain.contains(&current.id)
            && workspace.transfer_domain.contains(&next.id);
        // Cut-Edge Cross Potential: an anchor foot in the local/seed domain paired with a
        // mechanism foot in the transfer domain. The two same-domain potentials above both
        // collapse to zero on this segment, which is exactly the cross-strait segment the
        // whole bridge search exists to find — it must not be scored as 0.0.
        let cur_l = workspace.local.get(&current.id).copied().unwrap_or(0.0);
        let next_l = workspace.local.get(&next.id).copied().unwrap_or(0.0);
        let cur_t = workspace.transfer.get(&current.id).copied().unwrap_or(0.0);
        let next_t = workspace.transfer.get(&next.id).copied().unwrap_or(0.0);
        let cross_forward = (cur_l * next_t).sqrt();
        let cross_reverse = CUT_EDGE_REVERSE_CREDIT * (cur_t * next_l).sqrt();
        let cut_potential = cross_forward.max(cross_reverse);
        let cur_in_l = workspace.local_domain.contains(&current.id)
            || workspace.source_ids.contains(&current.id);
        let next_in_l = workspace.local_domain.contains(&next.id)
            || workspace.source_ids.contains(&next.id);
        let cur_in_t = workspace.transfer_domain.contains(&current.id);
        let next_in_t = workspace.transfer_domain.contains(&next.id);
        let cut_supported = config.enable_bipartite_bridge_pullback
            && !local_supported
            && !transfer_supported
            && ((cur_in_l && next_in_t) || (cur_in_t && next_in_l));
        let direction = if forward + reverse > 0.0 {
            clamp01(forward / (forward + reverse))
        } else if cut_supported && (cross_forward + cross_reverse) > 0.0 {
            clamp01(cross_forward / (cross_forward + cross_reverse))
        } else {
            clamp01(config.direction_floor)
        };
        let semantic_continuity = clamp01((cosine(&current.vector, &next.vector) + 1.0) / 2.0);
        let effective_seg_potential = if cut_supported {
            local_potential.max(transfer_potential).max(cut_potential)
        } else {
            local_potential.max(transfer_potential)
        };
        let field_continuity = (effective_seg_potential * next_l.max(next_t)).sqrt();
        let continuity = clamp01(0.5 * semantic_continuity + 0.5 * field_continuity);
        let graph_linked =
            forward > 0.0 || reverse > 0.0 || (cut_supported && cut_potential > CUT_EDGE_MIN_POTENTIAL);
        let supported = (local_supported || transfer_supported || cut_supported) && graph_linked;
        let weight_total = (config.local_weight + config.transfer_weight).max(1e-12);
        let same_domain_potential = (config.local_weight * local_potential
            + config.transfer_weight * transfer_potential)
            / weight_total;
        let potential = if cut_supported && cut_potential > same_domain_potential {
            same_domain_potential.max(CUT_EDGE_ENVELOPE * cut_potential)
        } else {
            same_domain_potential
        };
        let quality = if supported {
            clamp01(
                potential
                    * direction.max(config.direction_floor).sqrt()
                    * continuity.max(0.0).sqrt(),
            )
        } else {
            0.0
        };
        output.segment_count += 1;
        output.supported_segments += usize::from(supported);
        output.transfer_segments += usize::from(
            supported
                && (transfer_supported || cut_supported)
                && (!local_supported
                    || cut_supported
                    || transfer_potential > local_potential),
        );
        output.mean_direction += direction;
        output.mean_continuity += continuity;
        output.mean_local_potential += local_potential;
        output.mean_transfer_potential += transfer_potential;
        quality_mass += quality;
    }

    if output.segment_count > 0 {
        let count = output.segment_count as f64;
        output.path_core = clamp01(quality_mass / count);
        output.mean_direction /= count;
        output.mean_continuity /= count;
        output.mean_local_potential /= count;
        output.mean_transfer_potential /= count;
        output.support_coverage = output.supported_segments as f64 / count;
    } else if let Some(tag) = curve.tags.first() {
        output.path_core = clamp01(
            workspace
                .local
                .get(&tag.id)
                .copied()
                .unwrap_or(0.0)
                .max(workspace.transfer.get(&tag.id).copied().unwrap_or(0.0))
                * 0.5,
        );
    }

    output.tag_closure = if curve.tags.is_empty() {
        0.0
    } else {
        curve
            .tags
            .iter()
            .map(|tag| {
                clamp01(
                    (tag.chunk_cosine - config.closure_floor)
                        / (1.0 - config.closure_floor).max(1e-9),
                )
            })
            .sum::<f64>()
            / curve.tags.len() as f64
    };
    output.path_quality = clamp01(
        output.path_core * (0.5 + 0.25 * output.support_coverage + 0.25 * output.tag_closure),
    );
    output
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct TopologyOutput {
    score: f64,
    reliability: f64,
    reliability_mode: String,
    node_alignment_score: f64,
    edge_graph_score: f64,
    node_graph_score: f64,
    relative_distance_score: f64,
    direction_score: f64,
    edge_topology_score: f64,
    motif_score: f64,
    matched_node_coverage: f64,
    matched_edge_coverage: f64,
    mean_closure: f64,
    matched_nodes: usize,
    matched_edges: usize,
    query_nodes: usize,
    query_edges: usize,
}

#[derive(Clone)]
struct Alignment {
    candidate_index: usize,
    candidate_position: i64,
    quality: f64,
    closure: f64,
}

fn evaluate_topology(
    curve: &Curve,
    input: &NativeInput,
    artifact: &NativeArtifact,
    query_tag_vectors: &TagVectorPool,
    cosines: &CosineCache,
    stokes_corridors: &[DirectedStokesCorridor],
) -> TopologyOutput {
    let mut output = TopologyOutput {
        query_nodes: input.query_state.river_nodes.len(),
        ..TopologyOutput::default()
    };
    // BTreeMap 而非 HashMap：mean_closure 把 alignments.values() 直接累加成 f64，
    // 而 HashMap 的迭代顺序由每进程随机的 RandomState 决定，f64 加法不满足结合律。
    // 结果是同一查询在不同进程拿到末位不同的 mean_closure，再经 node_graph_score /
    // reliability 漂到角色边界上。按 node.id 有序累加使这条链可复现。
    let mut alignments = BTreeMap::new();
    let mut total_node_weight = 0.0;
    let mut matched_node_weight = 0.0;
    let mut node_quality_mass = 0.0;

    for node in &input.query_state.river_nodes {
        let base_w = positive(if node.normalized_energy != 0.0 {
            node.normalized_energy
        } else {
            node.energy
        })
        .max(1e-9);
        // V8.5 Geodesic Hop-Depth Compensation:
        // Prevent Hop 0/1 seed nodes from drowning out Hop 2/3/4 multi-hop river discoveries in topology alignment.
        let hop_boost = if input.config.enable_v8_extensions && node.hop >= 2 {
            1.0 + 0.45 * (node.hop.min(4) - 1) as f64
        } else {
            1.0
        };
        let weight = base_w * hop_boost;
        total_node_weight += weight;
        let exact = curve
            .tags
            .iter()
            .enumerate()
            .find(|item| item.1.id == node.id);
        let alignment = if let Some((index, tag)) = exact {
            Some(Alignment {
                candidate_index: index,
                candidate_position: tag.position,
                quality: tag.chunk_cosine.sqrt(),
                closure: tag.chunk_cosine,
            })
        } else {
            let query_vector = query_tag_vectors.get(&node.id);
            curve
                .tags
                .iter()
                .enumerate()
                .filter_map(|(index, tag)| {
                    // 查询河网与候选曲线的原始 Tag 向量均已加载；直接计算精确
                    // 余弦，避免在 NativeArtifact 中再常驻一份字符串键 Pairwise 表。
                    let similarity = query_vector
                        .map(|vector| clamp01(cosines.tag_pair(node.id, vector, tag)))
                        .unwrap_or(0.0);
                    if similarity < input.config.semantic_node_threshold {
                        return None;
                    }
                    let normalized = clamp01(
                        (similarity - input.config.semantic_node_threshold)
                            / (1.0 - input.config.semantic_node_threshold).max(1e-9),
                    );
                    Some(Alignment {
                        candidate_index: index,
                        candidate_position: tag.position,
                        quality: (normalized * tag.chunk_cosine).sqrt(),
                        closure: tag.chunk_cosine,
                    })
                })
                .max_by(|left, right| {
                    left.quality
                        .partial_cmp(&right.quality)
                        .unwrap_or(Ordering::Equal)
                        .then_with(|| right.candidate_index.cmp(&left.candidate_index))
                })
        };
        if let Some(alignment) = alignment {
            matched_node_weight += weight;
            node_quality_mass += weight * alignment.quality;
            alignments.insert(node.id, alignment);
        }
    }

    output.matched_nodes = alignments.len();
    output.matched_node_coverage = if total_node_weight > 0.0 {
        clamp01(matched_node_weight / total_node_weight)
    } else {
        0.0
    };
    output.node_alignment_score = if matched_node_weight > 0.0 {
        clamp01(node_quality_mass / matched_node_weight)
    } else {
        0.0
    };
    output.mean_closure = if alignments.is_empty() {
        0.0
    } else {
        alignments.values().map(|item| item.closure).sum::<f64>() / alignments.len() as f64
    };

    let maximum_hop = input
        .query_state
        .river_nodes
        .iter()
        .map(|node| node.hop.max(0))
        .max()
        .unwrap_or(1)
        .max(1) as f64;
    let river_node_by_id: HashMap<i64, &RiverNode> = input
        .query_state
        .river_nodes
        .iter()
        .map(|node| (node.id, node))
        .collect();
    let minimum_position = curve.tags.first().map(|tag| tag.position).unwrap_or(0);
    let maximum_position = curve
        .tags
        .last()
        .map(|tag| tag.position)
        .unwrap_or(minimum_position);
    let candidate_span = (maximum_position - minimum_position).max(1) as f64;
    let retained_edges: Vec<&RiverEdge> = input
        .query_state
        .river_edges
        .iter()
        .filter(|edge| {
            clamp01(if edge.normalized_flow != 0.0 {
                edge.normalized_flow
            } else {
                edge.flow
            }) >= input.config.minimum_river_edge_flow
        })
        .take(input.config.maximum_river_edges.max(1))
        .collect();
    output.query_edges = retained_edges.len();

    let mut total_edge_weight = 0.0;
    let mut matched_edge_weight = 0.0;
    let mut distance_mass = 0.0;
    let mut direction_mass = 0.0;
    let mut topology_mass = 0.0;

    for edge in &retained_edges {
        let base_edge_w = positive(if edge.normalized_flow != 0.0 {
            edge.normalized_flow
        } else {
            edge.flow
        })
        .max(1e-9);
        let source_hop = river_node_by_id
            .get(&edge.source_id)
            .map(|node| node.hop)
            .unwrap_or(0);
        let target_hop = river_node_by_id
            .get(&edge.target_id)
            .map(|node| node.hop)
            .unwrap_or(0);
        // V9 Geodesic Ricci-Weighted Edge Measure:
        // Weight river edges by their hop depth and negative-curvature Ricci bottleneck factor
        // so Hop 2/3/4 cross-domain wormhole edges are not drowned out by Hop 0->1 hub fan-out!
        let edge_weight = if input.config.enable_v8_extensions {
            let max_edge_hop = source_hop.max(target_hop).clamp(0, 4);
            let edge_hop_boost = if max_edge_hop >= 2 {
                1.0 + 0.55 * (max_edge_hop - 1) as f64
            } else {
                1.0
            };
            let ricci = artifact.edge_ricci_factor(edge.source_id, edge.target_id);
            base_edge_w * edge_hop_boost * (0.7 + 0.3 * ricci)
        } else {
            base_edge_w
        };
        total_edge_weight += edge_weight;
        let (Some(source), Some(target)) = (
            alignments.get(&edge.source_id),
            alignments.get(&edge.target_id),
        ) else {
            continue;
        };
        if source.candidate_index == target.candidate_index {
            continue;
        }
        let query_distance = (target_hop - source_hop).abs().max(1) as f64 / maximum_hop;
        let candidate_distance =
            (target.candidate_position - source.candidate_position).abs() as f64 / candidate_span;
        let distance_similarity = (-(query_distance - candidate_distance).abs()
            / input.config.relative_distance_temperature.max(1e-6))
        .exp();
        let direction_similarity = if target.candidate_position > source.candidate_position {
            1.0
        } else {
            clamp01(input.config.reverse_direction_credit)
        };
        let independent =
            artifact.independent_fraction(edge.source_id, edge.target_id, curve.file_id);
        let endpoint = (source.quality * target.quality).sqrt();
        let edge_quality =
            clamp01(endpoint * distance_similarity * direction_similarity * independent);
        matched_edge_weight += edge_weight;
        distance_mass += edge_weight * distance_similarity;
        direction_mass += edge_weight * direction_similarity;
        topology_mass += edge_weight * edge_quality;
        output.matched_edges += 1;
    }

    // Path-Transitive Multi-Hop Reachability Alignment (Verified Directed Corridors Only):
    // When a candidate anchors `u` and `w` in forward order (`u_pos < w_pos`) and skips an
    // intermediate ferry node `v`, credit the bridge ONLY if the shared directed Stokes corridor
    // table holds `u ⇝ w` with `steps >= 2`. That table is built by
    // `build_directed_stokes_corridors` from the very same `retained_edges`, so the bipartite
    // pullback stage and this alignment stage can never disagree about reachability.
    //
    // Disconnected branches (e.g. `1 -> 2` and `4 -> 3`) have no directed path from 1 to 3 and
    // therefore NEVER fabricate a corridor, matched edges, or edge_topology reliability!
    if input.config.enable_bipartite_bridge_pullback && !stokes_corridors.is_empty() {
        // (u, w) -> strongest composed corridor; direct 1-hop pairs are excluded because those
        // are already scored by the exact-edge loop above and must not be double counted.
        let mut composed: HashMap<(i64, i64), &DirectedStokesCorridor> = HashMap::new();
        for corridor in stokes_corridors {
            if corridor.steps < 2 {
                continue;
            }
            composed
                .entry((corridor.source_id, corridor.target_id))
                .and_modify(|existing| {
                    if corridor.effective_flow > existing.effective_flow {
                        *existing = corridor;
                    }
                })
                .or_insert(corridor);
        }
        let mut transitive_bonus_weight = 0.0;
        let mut transitive_quality_mass = 0.0;
        let mut verified_transitive_paths = 0usize;
        for (&u_id, u_align) in &alignments {
            for (&w_id, w_align) in &alignments {
                if u_id == w_id
                    || u_align.candidate_index == w_align.candidate_index
                    || w_align.candidate_position <= u_align.candidate_position
                {
                    continue;
                }
                let Some(corridor) = composed.get(&(u_id, w_id)) else {
                    continue;
                };
                let endpoint_q = (u_align.quality * w_align.quality).sqrt();
                let discount =
                    STOKES_CORRIDOR_STEP_DISCOUNT.powi((corridor.steps.saturating_sub(1)) as i32);
                // `corridor.effective_flow` already carries `bottleneck * discount`
                let syn_w = corridor.effective_flow;
                transitive_bonus_weight += syn_w;
                transitive_quality_mass += syn_w * (endpoint_q * discount.sqrt());
                verified_transitive_paths += 1;
            }
        }
        if verified_transitive_paths > 0 && transitive_bonus_weight > 0.0 && total_edge_weight > 0.0 {
            let capped_add = transitive_bonus_weight
                .min(0.45 * (total_edge_weight - matched_edge_weight).max(0.0));
            if capped_add > 1e-9 {
                let avg_q = (transitive_quality_mass / transitive_bonus_weight).clamp(0.0, 1.0);
                matched_edge_weight += capped_add;
                distance_mass += capped_add * 0.85;
                direction_mass += capped_add * 1.0;
                topology_mass += capped_add * avg_q;
                output.matched_edges += verified_transitive_paths;
            }
        }
    }
    output.matched_edge_coverage = if total_edge_weight > 0.0 {
        clamp01(matched_edge_weight / total_edge_weight)
    } else {
        0.0
    };
    if matched_edge_weight > 0.0 {
        output.relative_distance_score = clamp01(distance_mass / matched_edge_weight);
        output.direction_score = clamp01(direction_mass / matched_edge_weight);
        output.edge_topology_score = clamp01(topology_mass / matched_edge_weight);
    }
    // D1（2026-08-12 标注，不改算术）：motif_score 是 edge_topology_score 的**纯别名**，
    // 不是独立证据维。因此下面的权重表里 0.28 + 0.14 = 0.42 全部压在同一个量上，
    // 边拓扑实际承担 edge_graph_score 的 42%（其余：节点对齐 0.18 + 相对距离 0.22 + 方向 0.18）。
    // 读 trace 时不要把 motifScore 当成第二份证据，也不要以为四项权重是四个独立通道。
    // 为什么不直接折叠成 `0.42 * edge_topology_score`：
    //   1) f64 下 0.28 + 0.14 == 0.42000000000000004 ≠ 0.42，折叠不是逐位等价（相对差 ~1e-16）；
    //   2) 折叠需重编译 .node 并重启生产；当前收益只是可读性，不值得动已调试完的二进制。
    // 若将来要折叠：连同 TopologyOutput.motif_score 字段与其序列化（motifScore）一起处理，
    // 并注意那是**输出契约变更**（AdminPanel / 探针脚本可能在读这个键）。
    output.motif_score = output.edge_topology_score;
    output.edge_graph_score = clamp01(
        0.18 * output.node_alignment_score
            + 0.22 * output.relative_distance_score
            + 0.18 * output.direction_score
            + 0.28 * output.edge_topology_score
            + 0.14 * output.motif_score,
    );
    output.node_graph_score = clamp01((output.node_alignment_score * output.mean_closure).sqrt());
    if output.matched_edges > 0 {
        output.score = output.edge_graph_score;
        output.reliability = clamp01(
            (output.matched_node_coverage * output.matched_edge_coverage * output.mean_closure)
                .cbrt(),
        );
        output.reliability_mode = "edge_topology".to_string();
    } else if output.matched_nodes > 0 {
        output.score = output.node_graph_score;
        output.reliability = input.config.node_only_reliability_cap.min(clamp01(
            (output.matched_node_coverage * output.mean_closure).sqrt(),
        ));
        output.reliability_mode = "node_alignment_fallback".to_string();
    } else {
        output.reliability_mode = "unavailable".to_string();
    }
    output
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ObservableOutput {
    direct: f64,
    structural: f64,
    thematic: f64,
    closure: f64,
    query_chunk_score: f64,
    semantic_boundary_score: f64,
    local_coverage: f64,
    transfer_coverage: f64,
    local_potential: f64,
    transfer_potential: f64,
    tail_only_ratio: f64,
}

fn evaluate_observables(
    curve: &Curve,
    geometry: &GeometryOutput,
    input: &NativeInput,
    workspace: &FieldWorkspace,
    visible: bool,
    cosines: &CosineCache,
) -> ObservableOutput {
    let chain_size = curve.tags.len().max(1) as f64;
    let mut exact_seed_hits = 0usize;
    let mut local_contacts = 0usize;
    let mut transfer_contacts = 0usize;
    let mut local_potential = 0.0;
    let mut transfer_potential = 0.0;
    let mut tail_only = 0usize;
    let mut boundary: f64 = 0.0;

    for tag in &curve.tags {
        let local = workspace.local.get(&tag.id).copied().unwrap_or(0.0);
        let transfer = workspace.transfer.get(&tag.id).copied().unwrap_or(0.0);
        exact_seed_hits += usize::from(workspace.source_ids.contains(&tag.id));
        local_contacts += usize::from(workspace.local_domain.contains(&tag.id));
        transfer_contacts += usize::from(workspace.transfer_domain.contains(&tag.id));
        local_potential += local;
        transfer_potential += transfer;
        tail_only += usize::from(
            (local > 0.0 || transfer > 0.0)
                && !workspace.local_domain.contains(&tag.id)
                && !workspace.transfer_domain.contains(&tag.id),
        );
        boundary = boundary
            .max((clamp01(cosines.query_tag(&input.query.vector, tag)) * tag.chunk_cosine).sqrt());
    }

    let local_coverage = local_contacts as f64 / chain_size;
    let transfer_coverage = transfer_contacts as f64 / chain_size;
    let local_mean = local_potential / chain_size;
    let transfer_mean = transfer_potential / chain_size;
    let tail_ratio = tail_only as f64 / chain_size;
    let dual_agreement = 1.0 - (clamp01(local_mean) - clamp01(transfer_mean)).abs();

    // V8 Gentner Structure-Mapping Bridge Dipole Operator:
    // True cross-domain inspiration requires a directed bridge along the ordered 1-Simplex Tag curve:
    // an anchor foot in the local/seed domain followed by a mechanism/transfer foot in the transfer domain
    // (or reverse with directional credit), weighted by tag-to-chunk closure so generic touch-and-go tags cannot freeload.
    let mut best_dipole = 0.0f64;
    if input.config.enable_v8_extensions && local_contacts > 0 && transfer_contacts > 0 && curve.tags.len() >= 2 {
        for (i, left_tag) in curve.tags.iter().enumerate() {
            let l_mass = workspace.local.get(&left_tag.id).copied().unwrap_or(0.0);
            let l_is_local = workspace.local_domain.contains(&left_tag.id)
                || workspace.source_ids.contains(&left_tag.id);
            if !l_is_local && l_mass <= 0.0 {
                continue;
            }
            let l_strength = (l_mass.max(if l_is_local { 0.35 } else { 0.0 })
                * left_tag.chunk_cosine.max(0.2))
            .sqrt();
            for (j, right_tag) in curve.tags.iter().enumerate() {
                if i == j || left_tag.id == right_tag.id {
                    continue;
                }
                let t_mass = workspace.transfer.get(&right_tag.id).copied().unwrap_or(0.0);
                let t_is_transfer = workspace.transfer_domain.contains(&right_tag.id);
                if !t_is_transfer && t_mass <= 0.0 {
                    continue;
                }
                let t_strength = (t_mass.max(if t_is_transfer { 0.35 } else { 0.0 })
                    * right_tag.chunk_cosine.max(0.2))
                .sqrt();
                let dir_factor = if j > i { 1.0 } else { 0.65 };
                let span_decay = (-0.12 * ((j as isize - i as isize).abs().saturating_sub(1) as f64)).exp();
                let dipole = (l_strength * t_strength).sqrt() * dir_factor * span_decay;
                if dipole > best_dipole {
                    best_dipole = dipole;
                }
            }
        }
    }
    let dipole_bonus = 0.12 * clamp01(best_dipole);

    let thematic = clamp01(
        (0.25 * local_coverage
            + 0.2 * transfer_coverage
            + 0.2 * clamp01(local_mean)
            + 0.15 * clamp01(transfer_mean)
            + 0.2 * dual_agreement
            + dipole_bonus)
            * (1.0 - 0.5 * clamp01(tail_ratio)),
    );
    let raw_query_chunk = clamp01(cosine(&input.query.vector, &curve.chunk_vector));
    // V9 Dual-Manifold Symmetric Closure:
    // A cross-domain bridge chunk aligns with the Grassmannian transfer frame (`curve.transfer_score`)
    // and denoised manifold (`curve.denoised_score`) rather than just the unexpanded raw query vector.
    // Using only `raw_query_chunk` in `closure` and `topology_reliability` systematically penalizes
    // cross-domain bridge notes whose raw cosine is 0.25~0.35 but whose transfer pole cosine is >0.65!
    let effective_chunk_resonance = if input.config.enable_grassmann_subspace_readout {
        raw_query_chunk
            .max(0.88 * clamp01(curve.denoised_score))
            .max(0.85 * clamp01(curve.transfer_score))
            .max(0.82 * clamp01(curve.local_score))
    } else {
        raw_query_chunk
    };
    let query_chunk = effective_chunk_resonance;
    let direct_contact = clamp01(exact_seed_hits as f64 / workspace.source_ids.len().max(1) as f64);
    let semantic_boundary_score = if boundary >= 0.55 { boundary } else { 0.0 };
    let direct = if visible {
        clamp01((0.75 * direct_contact).max(semantic_boundary_score))
    } else {
        0.0
    };
    let closure = clamp01(0.65 * query_chunk + 0.35 * geometry.tag_closure);
    ObservableOutput {
        direct,
        structural: geometry.path_quality,
        thematic,
        closure,
        query_chunk_score: query_chunk,
        semantic_boundary_score,
        local_coverage,
        transfer_coverage,
        local_potential: local_mean,
        transfer_potential: transfer_mean,
        tail_only_ratio: tail_ratio,
    }
}

#[derive(Clone, Default)]
struct AnchorOutput {
    score: f64,
    reliability: f64,
    strength: f64,
    contacted_seeds: usize,
    exact_contacts: usize,
    semantic_contacts: usize,
    mean_closure: f64,
}

fn anchor_contacts(
    curve: &Curve,
    seeds: &[(i64, f64)],
    seed_vectors: &TagVectorPool,
    config: &NativeConfig,
    cosines: &CosineCache,
) -> Vec<(i64, i64, bool, f64, f64, f64)> {
    let mut contacts = Vec::new();
    for (seed_id, mass) in seeds {
        if let Some(tag) = curve.tags.iter().find(|tag| tag.id == *seed_id) {
            contacts.push((*seed_id, tag.id, true, 1.0, *mass, tag.chunk_cosine));
            continue;
        }
        let Some(seed_vector) = seed_vectors.get(seed_id) else {
            continue;
        };
        if let Some((tag, similarity)) = curve
            .tags
            .iter()
            .map(|tag| (tag, cosines.tag_pair(*seed_id, seed_vector, tag)))
            .filter(|item| item.1 >= config.semantic_anchor_threshold)
            .max_by(|left, right| left.1.partial_cmp(&right.1).unwrap_or(Ordering::Equal))
        {
            contacts.push((*seed_id, tag.id, false, similarity, *mass, tag.chunk_cosine));
        }
    }
    contacts
}

fn compute_anchors(
    curves: &[Curve],
    seeds: &[(i64, f64)],
    seed_vectors: &TagVectorPool,
    artifact: &NativeArtifact,
    config: &NativeConfig,
    fallback: bool,
    cosines: &CosineCache,
) -> Vec<AnchorOutput> {
    let contacts: Vec<Vec<(i64, i64, bool, f64, f64, f64)>> = curves
        .par_iter()
        .map(|curve| anchor_contacts(curve, seeds, seed_vectors, config, cosines))
        .collect();
    let mut pool_counts: HashMap<i64, usize> = seeds.iter().map(|seed| (seed.0, 0)).collect();
    for candidate_contacts in &contacts {
        for contact in candidate_contacts {
            *pool_counts.entry(contact.0).or_default() += 1;
        }
    }
    let max_seed_mass = seeds
        .iter()
        .map(|seed| positive(seed.1))
        .fold(0.0, f64::max);
    contacts
        .into_par_iter()
        .map(|candidate_contacts| {
            let mut no_contact_probability = 1.0;
            let mut closure_sum = 0.0;
            let mut exact = 0usize;
            for contact in &candidate_contacts {
                let inbound = artifact.inbound.get(&contact.1).copied().unwrap_or(0.0);
                let specificity = if artifact.max_inbound > 0.0 {
                    config
                        .specificity_floor
                        .max(1.0 - clamp01(inbound / artifact.max_inbound).sqrt())
                } else {
                    1.0
                };
                let rarity = config.rarity_floor.max(
                    1.0 - pool_counts.get(&contact.0).copied().unwrap_or(0) as f64
                        / curves.len().max(1) as f64,
                );
                let normalized_mass = if max_seed_mass > 0.0 {
                    clamp01(contact.4 / max_seed_mass)
                } else {
                    0.0
                };
                let match_weight = if contact.2 {
                    exact += 1;
                    1.0
                } else {
                    config.semantic_anchor_discount
                };
                let contribution =
                    clamp01(normalized_mass * specificity * contact.5 * rarity * match_weight);
                no_contact_probability *= 1.0 - contribution;
                closure_sum += contact.5;
            }
            let contacted = candidate_contacts.len();
            let mean_closure = if contacted > 0 {
                closure_sum / contacted as f64
            } else {
                0.0
            };
            let score = clamp01(1.0 - no_contact_probability);
            let mut reliability = clamp01(
                (mean_closure
                    * (contacted as f64 / config.reliability_seed_saturation.max(1.0)).min(1.0))
                .sqrt(),
            );
            if fallback {
                reliability = reliability.min(config.fallback_reliability_cap);
            }
            AnchorOutput {
                score,
                reliability,
                strength: clamp01(score * reliability),
                contacted_seeds: contacted,
                exact_contacts: exact,
                semantic_contacts: contacted.saturating_sub(exact),
                mean_closure,
            }
        })
        .collect()
}

/// Dual-Ledger Conservation Tier (isomorphic to MoonAST `geo.rs` `Tier::Green / Yellow / Red`):
/// - `Green`: Both 0-order orthogonal section ledger (`s_perp`) and 1-order directed Stokes
///   coboundary ledger (`right_ledger_flux`, `matched_edges >= 1`) close simultaneously across
///   both local and transfer domains.
/// - `Yellow`: Conservative single-sided healing (e.g. cellular sheaf sibling envelope or
///   partial corridor support without full dual-domain closure).
/// - `Red`: Unbalanced or disconnected branch (`eta_balance == 0.0`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LedgerTier {
    Green,
    Yellow,
    Red,
}

/// Shared Schur-complement peer density shrinkage factor `(0.88 + 0.12 * \rho_i)` used by both
/// Stage-2 candidate reranking and `memo_thinking` stage selection.
#[inline]
pub(crate) fn schur_peer_density_scale(off_diag_weight: f64, peer_count: usize) -> f64 {
    let density = if peer_count > 0 {
        (off_diag_weight.max(0.0) / (peer_count as f64 * 0.35).max(1e-6)).clamp(0.0, 1.0)
    } else {
        1.0
    };
    0.88 + 0.12 * density
}

#[derive(Clone)]
struct ScoredWork {
    curve: Curve,
    geometry: GeometryOutput,
    topology: TopologyOutput,
    observables: ObservableOutput,
    pure_score: f64,
    graph_score: f64,
    direct_evidence: f64,
    ledger_tier: LedgerTier,
    role: String,
    original_role: String,
    role_reclassification_reason: Option<&'static str>,
    anchor: AnchorOutput,
    v2_bonus: f64,
    gated_bonus: f64,
    anchor_bonus: f64,
    final_score: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QueryMorphology {
    atomic_weight: f64,
    propositional_weight: f64,
    narrative_weight: f64,
    confidence: f64,
    effective_depth: f64,
    depth_variance: f64,
    energy_concentration: f64,
    shallow_energy_ratio: f64,
    forward_flow_ratio: f64,
    same_level_flow_ratio: f64,
    chainness: f64,
    branching: f64,
    merging: f64,
    growth_persistence: f64,
    dominant_mode: String,
}

fn compute_query_morphology(input: &NativeInput) -> QueryMorphology {
    let nodes = &input.query_state.river_nodes;
    let edges = &input.query_state.river_edges;
    let node_count = nodes.len();
    let edge_count = edges.len();
    let hop_by_id: HashMap<i64, usize> = nodes
        .iter()
        .map(|node| (node.id, node.hop.max(0) as usize))
        .collect();
    let maximum_hop = hop_by_id.values().copied().max().unwrap_or(0);

    let energies: Vec<f64> = nodes
        .iter()
        .map(|node| {
            positive(if node.normalized_energy != 0.0 {
                node.normalized_energy
            } else {
                node.energy
            })
        })
        .collect();
    let total_energy: f64 = energies.iter().sum();
    let weighted_hop = if total_energy > 1e-12 {
        nodes
            .iter()
            .zip(&energies)
            .map(|(node, energy)| node.hop.max(0) as f64 * energy)
            .sum::<f64>()
            / total_energy
    } else {
        0.0
    };
    let hop_variance = if total_energy > 1e-12 {
        nodes
            .iter()
            .zip(&energies)
            .map(|(node, energy)| energy * (node.hop.max(0) as f64 - weighted_hop).powi(2))
            .sum::<f64>()
            / total_energy
    } else {
        0.0
    };
    let effective_depth = clamp01(1.0 - (-weighted_hop / 1.75).exp());
    let depth_variance = clamp01(1.0 - (-hop_variance.sqrt() / 1.5).exp());
    let shallow_energy_ratio = if total_energy > 1e-12 {
        nodes
            .iter()
            .zip(&energies)
            .filter(|(node, _)| node.hop <= 1)
            .map(|(_, energy)| *energy)
            .sum::<f64>()
            / total_energy
    } else {
        1.0
    };

    let raw_hhi = if total_energy > 1e-12 {
        energies
            .iter()
            .map(|energy| (energy / total_energy).powi(2))
            .sum::<f64>()
    } else {
        1.0
    };
    let uniform_hhi = 1.0 / node_count.max(1) as f64;
    let energy_concentration = if node_count > 1 {
        clamp01((raw_hhi - uniform_hhi) / (1.0 - uniform_hhi))
    } else {
        1.0
    };

    let mut inbound_degree: HashMap<i64, usize> = HashMap::new();
    let mut outbound_degree: HashMap<i64, usize> = HashMap::new();
    let mut total_flow = 0.0;
    let mut forward_flow = 0.0;
    let mut same_level_flow = 0.0;
    for edge in edges {
        let flow = positive(if edge.normalized_flow != 0.0 {
            edge.normalized_flow
        } else {
            edge.flow
        });
        if flow <= 0.0 {
            continue;
        }
        total_flow += flow;
        *outbound_degree.entry(edge.source_id).or_default() += 1;
        *inbound_degree.entry(edge.target_id).or_default() += 1;
        let source_hop = hop_by_id.get(&edge.source_id).copied().unwrap_or(0);
        let target_hop = hop_by_id.get(&edge.target_id).copied().unwrap_or(0);
        if target_hop > source_hop {
            forward_flow += flow;
        } else if target_hop == source_hop {
            same_level_flow += flow;
        }
    }
    let forward_flow_ratio = if total_flow > 1e-12 {
        clamp01(forward_flow / total_flow)
    } else {
        0.0
    };
    let same_level_flow_ratio = if total_flow > 1e-12 {
        clamp01(same_level_flow / total_flow)
    } else {
        0.0
    };

    let reached_nodes: Vec<i64> = nodes
        .iter()
        .filter(|node| node.hop > 0)
        .map(|node| node.id)
        .collect();
    let reached_count = reached_nodes.len().max(1) as f64;
    let chain_fit = reached_nodes
        .iter()
        .filter(|id| {
            inbound_degree.get(id).copied().unwrap_or(0) <= 1
                && outbound_degree.get(id).copied().unwrap_or(0) <= 1
        })
        .count() as f64
        / reached_count;
    let branching = clamp01(
        reached_nodes
            .iter()
            .map(|id| {
                outbound_degree
                    .get(id)
                    .copied()
                    .unwrap_or(0)
                    .saturating_sub(1)
            })
            .sum::<usize>() as f64
            / reached_count,
    );
    let merging = clamp01(
        reached_nodes
            .iter()
            .map(|id| {
                inbound_degree
                    .get(id)
                    .copied()
                    .unwrap_or(0)
                    .saturating_sub(1)
            })
            .sum::<usize>() as f64
            / reached_count,
    );
    let chainness = clamp01(
        chain_fit
            * forward_flow_ratio.sqrt()
            * (0.35 + 0.65 * effective_depth)
            * (1.0 - 0.5 * branching),
    );

    let occupied_hops: HashSet<usize> = hop_by_id.values().copied().collect();
    let level_occupancy = if maximum_hop > 0 {
        occupied_hops.len().saturating_sub(1) as f64 / maximum_hop as f64
    } else {
        0.0
    };
    let growth_persistence = clamp01(level_occupancy * effective_depth.sqrt());
    let middle_depth = clamp01(1.0 - (2.0 * effective_depth - 1.0).abs());
    let relational_complexity =
        clamp01(0.35 * same_level_flow_ratio + 0.35 * branching + 0.3 * merging);

    let sample_reliability = clamp01(
        (1.0 - (-(node_count as f64) / 8.0).exp()) * (1.0 - (-(edge_count as f64) / 8.0).exp()),
    )
    .sqrt();
    let completeness = if input.query_state.complete_observation {
        1.0
    } else {
        0.5
    };
    let confidence = clamp01(sample_reliability * completeness);

    let atomic_logit = 1.45 * shallow_energy_ratio + 0.9 * energy_concentration
        - 1.25 * effective_depth
        - 0.65 * growth_persistence
        - 0.45 * chainness;
    let propositional_logit =
        1.25 * relational_complexity + 0.7 * middle_depth + 0.35 * depth_variance
            - 0.25 * chainness;
    let narrative_logit = 1.4 * effective_depth
        + 1.15 * chainness
        + 0.8 * forward_flow_ratio
        + 0.65 * growth_persistence
        - 0.65 * branching
        - 0.3 * energy_concentration;

    const TEMPERATURE: f64 = 1.0;
    let logits = [atomic_logit, propositional_logit, narrative_logit];
    let maximum_logit = logits.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let exponentials = logits.map(|logit| ((logit - maximum_logit) / TEMPERATURE).exp());
    let exponential_sum: f64 = exponentials.iter().sum();
    let topology_weights = exponentials.map(|value| value / exponential_sum.max(1e-12));
    let prior = [1.0 / 3.0; 3];
    let weights = [
        confidence * topology_weights[0] + (1.0 - confidence) * prior[0],
        confidence * topology_weights[1] + (1.0 - confidence) * prior[1],
        confidence * topology_weights[2] + (1.0 - confidence) * prior[2],
    ];
    let dominant_mode = if weights[0] >= weights[1] && weights[0] >= weights[2] {
        "atomic"
    } else if weights[2] >= weights[1] {
        "narrative"
    } else {
        "propositional"
    };

    QueryMorphology {
        atomic_weight: weights[0],
        propositional_weight: weights[1],
        narrative_weight: weights[2],
        confidence,
        effective_depth,
        depth_variance,
        energy_concentration,
        shallow_energy_ratio,
        forward_flow_ratio,
        same_level_flow_ratio,
        chainness,
        branching,
        merging,
        growth_persistence,
        dominant_mode: dominant_mode.to_string(),
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OmegaOutput {
    omega: f64,
    omega_edge: f64,
    omega_emerge: f64,
    omega_flow: f64,
    regime: String,
    active_edges: usize,
    seed_nodes: usize,
    reached_nodes: usize,
    emergent_nodes: usize,
    complete_observation: bool,
}

fn compute_omega(input: &NativeInput) -> OmegaOutput {
    let active_edges = input.query_state.river_edges.len();
    let seed_nodes = input
        .query_state
        .river_nodes
        .iter()
        .filter(|node| node.hop == 0)
        .count();
    let reached_nodes = input.query_state.river_nodes.len();
    let emergent_nodes = reached_nodes.saturating_sub(seed_nodes);
    let safe_seed = seed_nodes.max(1) as f64;
    let omega_edge = clamp01(active_edges as f64 / (input.config.kappa_edge * safe_seed));
    let omega_emerge = clamp01(emergent_nodes as f64 / (input.config.kappa_ratio * safe_seed));
    let flows: Vec<f64> = input
        .query_state
        .river_edges
        .iter()
        .map(|edge| positive(edge.flow))
        .filter(|value| *value > 0.0)
        .collect();
    let omega_flow = if flows.is_empty() {
        0.0
    } else if flows.len() == 1 {
        0.5
    } else {
        let total: f64 = flows.iter().sum();
        let entropy = flows
            .iter()
            .map(|flow| {
                let probability = *flow / total;
                -probability * probability.ln()
            })
            .sum::<f64>();
        clamp01(entropy / (flows.len() as f64).ln())
    };
    let geometric = (omega_edge.max(input.config.omega_epsilon)
        * omega_emerge.max(input.config.omega_epsilon)
        * omega_flow.max(input.config.omega_epsilon))
    .cbrt();
    let observation_factor = if input.query_state.complete_observation {
        1.0
    } else {
        0.5
    };
    let omega = clamp01(geometric * observation_factor);
    let regime = if omega < input.config.collapsed_threshold {
        "collapsed"
    } else if omega < input.config.sparse_threshold {
        "sparse"
    } else {
        "dense"
    };
    OmegaOutput {
        omega,
        omega_edge,
        omega_emerge,
        omega_flow,
        regime: regime.to_string(),
        active_edges,
        seed_nodes,
        reached_nodes,
        emergent_nodes,
        complete_observation: input.query_state.complete_observation,
    }
}

fn assign_v3_scores(
    work: &mut [ScoredWork],
    mode: &str,
    omega: &OmegaOutput,
    config: &NativeConfig,
) {
    let maximum_pure = work.iter().map(|item| item.pure_score).fold(0.0, f64::max);
    for item in work.iter_mut() {
        let near_frontier = item.pure_score >= maximum_pure - 0.03;
        let direct_answer = mode != "atomic"
            && item.observables.closure >= 0.55
            && (item.direct_evidence >= 0.55 || (near_frontier && item.curve.query_score >= 0.55));
        let structural = (item.topology.matched_edge_coverage
            * item.topology.reliability
            * item.observables.closure)
            .cbrt();
        item.role = if mode == "atomic" {
            "atomic_concept"
        } else if direct_answer {
            "direct_answer"
        } else if structural >= 0.35 {
            "structural_explanation"
        } else {
            "thematic_neighbor"
        }
        .to_string();
    }

    let direct_frontier = work
        .iter()
        .filter(|item| item.role == "direct_answer")
        .map(|item| item.pure_score)
        .fold(0.0, f64::max);

    // V8 Tangent Tag-Curve Subspace + Chunk DPP Coherence:
    // Blend candidate's activated Tag curve direction (weighted by chunk_cosine) with chunk_vector
    // so two notes sharing background narrative tone but exploring orthogonal Tag mechanisms
    // are recognized as independent subspace directions in the Schur peer kernel.
    let unit_chunks: Vec<(Vec<f32>, bool)> = work
        .iter()
        .map(|item| {
            let dim = item.curve.chunk_vector.len();
            if dim == 0 {
                return (Vec::new(), false);
            }
            let mut combined = vec![0.0f64; dim];
            let mut tag_weight_sum = 0.0f64;
            for tag in &item.curve.tags {
                if tag.vector.len() == dim {
                    let w = tag.chunk_cosine.max(0.15);
                    tag_weight_sum += w;
                    for (acc, &tv) in combined.iter_mut().zip(tag.vector.iter()) {
                        *acc += (tv as f64) * w;
                    }
                }
            }
            if tag_weight_sum > 1e-12 {
                let inv_tw = 1.0 / tag_weight_sum;
                for (acc, &cv) in combined.iter_mut().zip(item.curve.chunk_vector.iter()) {
                    *acc = 0.45 * (cv as f64) + 0.55 * (*acc * inv_tw);
                }
            } else {
                for (acc, &cv) in combined.iter_mut().zip(item.curve.chunk_vector.iter()) {
                    *acc = cv as f64;
                }
            }
            let norm_sq: f64 = combined.iter().map(|&x| x * x).sum();
            if norm_sq > 1e-12 {
                let inv = 1.0 / norm_sq.sqrt();
                (combined.into_iter().map(|x| (x * inv) as f32).collect(), true)
            } else {
                (Vec::new(), false)
            }
        })
        .collect();

    for index in 0..work.len() {
        let mut peers: Vec<(usize, f64)> = (0..work.len())
            .filter(|peer| *peer != index)
            .map(|peer| {
                let pure_delta = (work[peer].pure_score - work[index].pure_score)
                    / config.conditional_bandwidth.max(1e-4);
                let closure_delta = (work[peer].observables.closure
                    - work[index].observables.closure)
                    / config.conditional_closure_bandwidth.max(1e-4);
                let direct_delta = (work[peer].direct_evidence - work[index].direct_evidence)
                    / config.conditional_direct_bandwidth.max(1e-4);
                let role_weight = if work[peer].role == work[index].role {
                    1.0
                } else {
                    0.35
                };
                // Subspace-Coherence Peer Kernel (configurable via `enable_subspace_peer_kernel`):
                // Weight peer competition by directional cosine coherence in the combined chunk+tag space.
                let subspace_coherence = if config.enable_subspace_peer_kernel
                    && unit_chunks[index].1
                    && unit_chunks[peer].1
                    && unit_chunks[index].0.len() == unit_chunks[peer].0.len()
                {
                    let cos: f64 = unit_chunks[index]
                        .0
                        .iter()
                        .zip(unit_chunks[peer].0.iter())
                        .map(|(&a, &b)| (a as f64) * (b as f64))
                        .sum();
                    let pos_cos = cos.clamp(0.0, 1.0);
                    0.10 + 0.90 * (pos_cos * pos_cos)
                } else {
                    1.0
                };
                (
                    peer,
                    role_weight
                        * subspace_coherence
                        * (-0.5
                            * (pure_delta * pure_delta
                                + closure_delta * closure_delta
                                + direct_delta * direct_delta))
                            .exp(),
                )
            })
            .collect();
        peers.sort_by(|left, right| right.1.partial_cmp(&left.1).unwrap_or(Ordering::Equal));
        peers.retain(|entry| entry.1 >= 1e-4);
        if peers.len() < config.minimum_peers {
            let existing: HashSet<usize> = peers.iter().map(|entry| entry.0).collect();
            let mut fallback: Vec<(usize, f64)> = (0..work.len())
                .filter(|peer| *peer != index && !existing.contains(peer))
                .map(|peer| (peer, 1e-4))
                .take(config.minimum_peers.saturating_sub(peers.len()))
                .collect();
            peers.append(&mut fallback);
        }
        let total_weight: f64 = peers.iter().map(|entry| entry.1).sum();
        let squared_weight: f64 = peers.iter().map(|entry| entry.1 * entry.1).sum();
        let raw_expected = if total_weight > 1e-12 {
            peers
                .iter()
                .map(|entry| entry.1 * work[entry.0].graph_score)
                .sum::<f64>()
                / total_weight
        } else {
            work[index].graph_score
        };
        // Audit P2-8 Fix: If all peers are mutually orthogonal to `index`, a uniform 0.10 factor
        // cancels out in `sum(w_j s_j) / sum(w_j)`. Coupling `expected` with the mean peer weight
        // saturation ensures genuinely orthogonal outliers are not held to the same collinear baseline!
        let density_scale = if config.enable_subspace_peer_kernel && !peers.is_empty() {
            schur_peer_density_scale(total_weight, peers.len())
        } else {
            1.0
        };
        let expected = raw_expected * density_scale;
        let variance = if total_weight > 1e-12 {
            peers
                .iter()
                .map(|entry| entry.1 * (work[entry.0].graph_score - expected).powi(2))
                .sum::<f64>()
                / total_weight
        } else {
            0.0
        };
        let effective_peers = if squared_weight > 1e-12 {
            total_weight * total_weight / squared_weight
        } else {
            0.0
        };
        let uncertainty = (variance * (1.0 + 1.0 / effective_peers.max(1.0))).sqrt();
        let innovation = positive(
            work[index].graph_score - expected - config.innovation_confidence_z * uncertainty,
        );
        let candidate_confidence = if mode == "atomic" {
            (work[index].observables.closure
                * clamp01(
                    0.55 * work[index].topology.matched_node_coverage
                        + 0.45 * work[index].topology.node_alignment_score,
                ))
            .sqrt()
        } else {
            (work[index].observables.closure
                * clamp01(
                    0.75 * work[index].topology.matched_edge_coverage
                        + 0.25 * work[index].topology.matched_node_coverage,
                )
                * clamp01(
                    0.7 * work[index].topology.reliability
                        + 0.3 * work[index].topology.node_alignment_score,
                ))
            .cbrt()
        };
        let statistical = clamp01(effective_peers / config.minimum_effective_peers);
        let combined_confidence = clamp01(candidate_confidence * statistical);
        let is_v9_bridge = config.enable_bipartite_bridge_pullback
            && work[index].ledger_tier == LedgerTier::Green;
        let (role_cap, multiplier) = match work[index].role.as_str() {
            "atomic_concept" => (config.topology_bonus_cap, 1.0),
            "direct_answer" => {
                if is_v9_bridge {
                    (config.topology_bonus_cap.max(0.11), 1.10)
                } else {
                    (0.02, 0.35)
                }
            }
            "structural_explanation" => {
                if is_v9_bridge {
                    (config.topology_bonus_cap.max(0.11), 1.10)
                } else {
                    (0.045, 0.7)
                }
            }
            _ => {
                if is_v9_bridge {
                    (config.topology_bonus_cap.max(0.08), 0.80)
                } else {
                    (0.008, 0.15)
                }
            }
        };
        let requested = innovation * combined_confidence * config.innovation_scale * multiplier;
        let mut bonus = requested.min(role_cap).min(if is_v9_bridge {
            config.topology_bonus_cap.max(0.11)
        } else {
            config.topology_bonus_cap
        });
        // V9 Glass-Ceiling Guard:
        // Protect unambiguous high-similarity `direct_answer` leaders (`direct_frontier >= 0.62`)
        // from being displaced by multi-tag neighbors, while allowing verified cross-domain bridges
        // (`is_v9_bridge`) to break through moderate single-domain frontiers on asymmetric queries.
        let strong_direct_lock = direct_frontier >= 0.62
            && work[index].curve.query_score + 0.05 < direct_frontier;
        if direct_frontier > 0.0
            && work[index].role != "direct_answer"
            && mode != "atomic"
            && (!is_v9_bridge || strong_direct_lock)
        {
            bonus = bonus.min(positive(direct_frontier - 0.005 - work[index].pure_score));
        }
        work[index].v2_bonus = clamp01(bonus);
    }

    let anchor_mean = if work.is_empty() {
        0.0
    } else {
        work.iter().map(|item| item.anchor.strength).sum::<f64>() / work.len() as f64
    };
    let anchor_variance = if work.is_empty() {
        0.0
    } else {
        work.iter()
            .map(|item| (item.anchor.strength - anchor_mean).powi(2))
            .sum::<f64>()
            / work.len() as f64
    };
    let anchor_std = anchor_variance.sqrt();
    let threshold = clamp01(
        config
            .anchor_activation_floor
            .max(anchor_mean + config.anchor_activation_z * anchor_std),
    );
    let mut ranked_anchors: Vec<(usize, f64)> = work
        .iter()
        .enumerate()
        .map(|(index, item)| (index, item.anchor.strength))
        .collect();
    ranked_anchors.sort_by(|left, right| right.1.partial_cmp(&left.1).unwrap_or(Ordering::Equal));
    let strongest = ranked_anchors.first().copied();
    let second = ranked_anchors.get(1).map(|item| item.1).unwrap_or(0.0);
    let promote = strongest
        .map(|item| {
            item.1 >= config.anchor_frontier_abs_floor
                && item.1 >= config.anchor_frontier_contrast * second
        })
        .unwrap_or(false);
    let graph_gate = omega.omega.powf(config.omega_gamma.max(0.0));

    for (index, item) in work.iter_mut().enumerate() {
        let activation = if item.anchor.strength <= threshold {
            0.0
        } else if config.anchor_saturation - threshold > 1e-12 {
            let normalized = clamp01(
                (item.anchor.strength - threshold) / (config.anchor_saturation - threshold),
            );
            normalized * normalized * (3.0 - 2.0 * normalized)
        } else {
            1.0
        };
        item.anchor_bonus = config.anchor_bonus_cap * activation;
        // (modules/tagmemoV10/experimentArms.js:1199-1212) 对齐——否则 Rust 侧无从判断
        // struct_role_min_omega 这一支是否被走过。
        item.original_role = item.role.clone();
        if promote && strongest.map(|entry| entry.0) == Some(index) {
            if item.role != "direct_answer" {
                item.role_reclassification_reason = Some("strong-direct-anchor-contrast");
            }
            item.role = "direct_answer".to_string();
        } else if omega.omega < config.struct_role_min_omega
            && item.role == "structural_explanation"
        {
            item.role_reclassification_reason = Some("collapsed-river-structure");
            item.role = "thematic_neighbor".to_string();
        }
        item.gated_bonus = item.v2_bonus * graph_gate;
        item.final_score = clamp01(item.pure_score + item.gated_bonus + item.anchor_bonus);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeResultItem {
    id: i64,
    chunk_id: i64,
    rank: usize,
    score: f64,
    base_score: f64,
    topology_bonus: f64,
    anchor_bonus: f64,
    role: String,
    omega: f64,
    river_regime: String,
    matched_tags: Vec<String>,
    core_tags_matched: Vec<String>,
    candidate_sources: Vec<String>,
    original_score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    topology_v3: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    relative_topology: Option<TopologyOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    geometry: Option<GeometryOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    observables: Option<ObservableOutput>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeDiagnostics {
    backend: String,
    offered_candidates: usize,
    projected_candidates: usize,
    selected_candidates: usize,
    ranked_candidates: usize,
    returned_candidates: usize,
    rayon_threads: usize,
    artifact_nodes: usize,
    artifact_edges: usize,
    load_ms: f64,
    compute_ms: f64,
    total_ms: f64,
    chunk_sql_batches: usize,
    file_tag_sql_batches: usize,
    query_tag_sql_batches: usize,
    candidate_tag_vector_sql_batches: usize,
    candidate_tag_vector_fetched_nodes: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeOutput {
    schema: String,
    algorithm_version: String,
    artifact_sig: String,
    query_id: Option<String>,
    omega: OmegaOutput,
    query_mode: String,
    query_morphology: QueryMorphology,
    results: Vec<NativeResultItem>,
    diagnostics: NativeDiagnostics,
}

pub(crate) fn run_native(
    runtime: &MemoRuntime,
    db_path: &str,
    artifact_sig: &str,
    input_json: &str,
) -> std::result::Result<String, String> {
    let _publication_guard = crate::publication_gate::acquire_read(db_path, &[String::from("*")])?;
    crate::storage::with_registered_read_transaction(db_path, |connection| {
        run_native_with_connection(runtime, connection, artifact_sig, input_json)
    })
}

pub(crate) fn run_native_with_connection(
    runtime: &MemoRuntime,
    connection: &Connection,
    artifact_sig: &str,
    input_json: &str,
) -> std::result::Result<String, String> {
    let total_started = Instant::now();
    let mut input: NativeInput = serde_json::from_str(input_json)
        .map_err(|error| format!("invalid RiverMemo native input JSON: {}", error))?;
    input.config.apply_experiment_preset();
    let mut tag_vectors = TagVectorPool::new();
    let mut cached_transfer_basins: Vec<Vec<f32>> = Vec::new();
    if let Some(handle) = input.observation_handle.as_deref() {
        let cached = runtime.get_query_observation(handle, artifact_sig)?;
        if cached.database_generation != crate::storage::read_generation(connection)? {
            return Err("MEMO_OBSERVATION_STALE: database changed during Memo request".into());
        }
        tag_vectors.extend(cached.tag_vectors.iter().map(|(id, vector)| (*id, vector.clone())));
        input.query.vector = cached.original_query_vector.as_ref().clone();
        input.denoised_vector = cached.enhanced_query_vector.as_ref().clone();
        input.local_vector = cached.local_vector.as_ref().clone();
        input.transfer_vector = cached.transfer_vector.as_ref().clone();
        cached_transfer_basins = cached.transfer_basin_vectors.as_ref().clone();
        input.query_state.source_field = cached.observation.source_field.clone();
        input.query_state.local_field = cached.local_field.as_ref().clone();
        input.query_state.transfer_field = cached.transfer_field.as_ref().clone();
        input.query_state.local_domain_ids = cached.local_domain_ids.as_ref().clone();
        input.query_state.transfer_domain_ids = cached.transfer_domain_ids.as_ref().clone();
        input.query_state.river_nodes = cached
            .observation
            .nodes
            .iter()
            .map(|node| RiverNode {
                id: node.id,
                energy: node.energy,
                normalized_energy: node.normalized_energy,
                hop: node.hop as i64,
            })
            .collect();
        input.query_state.river_edges = cached
            .observation
            .edges
            .iter()
            .map(|edge| RiverEdge {
                source_id: edge.source_id,
                target_id: edge.target_id,
                flow: edge.flow,
                normalized_flow: edge.normalized_flow,
            })
            .collect();
        input.query_state.field_provenance = cached
            .observation
            .nodes
            .iter()
            .map(|node| SourceProvenance {
                id: node.id,
                hop: node.hop as i64,
                source_type: node.source_type.clone(),
            })
            .collect();
        input.query_state.complete_observation = !cached.observation.source_field.is_empty();
        if input.query_state.query_id.is_none() {
            input.query_state.query_id = cached.observation.query_id.clone();
        }
    }
    let dimension = input.dimension;
    if input.query.vector.len() != dimension
        || input.denoised_vector.len() != dimension
        || input.local_vector.len() != dimension
        || input.transfer_vector.len() != dimension
    {
        return Err(format!(
            "RiverMemo native vector dimension mismatch: expected {}",
            dimension
        ));
    }

    let load_started = Instant::now();
    let artifact = load_artifact_with_connection(runtime, connection, artifact_sig)?;
    let allowed: Option<HashSet<i64>> = input.allowed_file_ids.as_ref()
        .map(|ids| ids.iter().copied().collect());

    // V9 Stage-1.5 Order-Preserving Bipartite Hypergraph Bridge Pullback & Lyapunov Closure:
    // Build ONE directed Stokes corridor table from the retained skeleton and share it between
    // the pull-in stage below and `evaluate_topology` — that shared table is the single source
    // of directed reachability, so a bridge can never be admitted by one stage and denied by
    // the other.
    let retained_corridor_edges: Vec<&RiverEdge> = input
        .query_state
        .river_edges
        .iter()
        .filter(|edge| {
            clamp01(if edge.normalized_flow != 0.0 {
                edge.normalized_flow
            } else {
                edge.flow
            }) >= input.config.minimum_river_edge_flow
        })
        .take(input.config.maximum_river_edges.max(1))
        .collect();
    let stokes_corridors: Vec<DirectedStokesCorridor> = if input.config.enable_bipartite_bridge_pullback {
        build_directed_stokes_corridors(
            &retained_corridor_edges,
            &input.query_state.river_nodes,
            &artifact,
            true,
        )
    } else {
        Vec::new()
    };

    // `artifact.pullback_bridge_candidates` pulls in cross-domain bridge files that carry
    // high-flow directed Stokes corridors `u ⇝ w` in forward narrative order, bypassing
    // the rank-1 single-vector ANN bottleneck!
    let local_domain_set: HashSet<i64> = input.query_state.local_domain_ids.iter().copied().collect();
    let bridge_corridors: Vec<DirectedStokesCorridor> = stokes_corridors
        .iter()
        .filter(|c| c.steps >= 2 || !local_domain_set.contains(&c.target_id))
        .cloned()
        .collect();
    let bipartite_file_scores = if input.config.enable_bipartite_bridge_pullback && !bridge_corridors.is_empty() {
        artifact.compute_bipartite_file_scores(
            &input.query_state.river_nodes,
            &bridge_corridors,
            &input.query_state.transfer_field,
            allowed.as_ref(),
        )
    } else {
        HashMap::new()
    };
    let max_bipartite_score = bipartite_file_scores
        .values()
        .copied()
        .fold(0.0f64, f64::max);

    if input.config.enable_bipartite_bridge_pullback && !bridge_corridors.is_empty() && !input.candidates.is_empty() {
        let existing_ids: HashSet<i64> = input.candidates.iter().map(|c| c.id).collect();
        let pullback = artifact.pullback_bridge_candidates(
            &input.query_state.river_nodes,
            &bridge_corridors,
            &input.query_state.transfer_field,
            allowed.as_ref(),
            &existing_ids,
            12,
        );
        for (chunk_id, _file_id, _pb_score) in pullback {
            input.candidates.push(CandidateInput {
                id: chunk_id,
                score: 0.0,
                vector_score: 0.0,
                bm25_score: 0.0,
                time_score: 0.0,
                anchor_score: 0.0,
                hybrid_score: 0.0,
            });
        }
    }

    let curve_load = load_curves(
        connection,
        &input.candidates,
        dimension,
        if input.config.enable_bipartite_bridge_pullback {
            artifact.bipartite.as_deref()
        } else {
            None
        },
    )?;
    let mut curves = curve_load.curves;
    if max_bipartite_score > 1e-12 {
        for curve in &mut curves {
            if let Some(&raw_bip) = bipartite_file_scores.get(&curve.file_id) {
                curve.bipartite_score = clamp01(raw_bip / max_bipartite_score);
            }
        }
    }
    // 显式空集合也意味着无权限；必须在候选归一化和统计前移除越权项。
    if let Some(scope) = &allowed {
        curves.retain(|curve| scope.contains(&curve.file_id));
    }
    let original_score_by_id: HashMap<i64, f64> = input
        .candidates
        .iter()
        .map(|candidate| {
            (
                candidate.id,
                if candidate.score != 0.0 {
                    candidate.score
                } else if candidate.hybrid_score != 0.0 {
                    candidate.hybrid_score
                } else {
                    candidate.vector_score
                },
            )
        })
        .collect();
    let local_domain: HashSet<i64> = input.query_state.local_domain_ids.iter().copied().collect();
    let file_tags = |curve: &Curve| curve_load.relations.get(&curve.file_id).into_iter().flatten();
    let domain_tag_ids: Vec<i64> = curves.iter().flat_map(file_tags)
        .map(|relation| relation.0).filter(|id| local_domain.contains(id)).collect();
    let domain_stats = ensure_tag_vectors_loaded(connection, &mut tag_vectors, &domain_tag_ids, dimension)?;
    compute_anchor_scores(&mut curves, |curve| file_tags(curve)
        .filter(|relation| local_domain.contains(&relation.0) && tag_vectors.contains_key(&relation.0))
        .count());

    // V9 Grassmannian Orthogonal-Complement Stiefel Frame U_perp ∈ St(M, H) Construction:
    // Orthonormalize [transfer_vector, basin_pole_1, basin_pole_2, ...] into a mutually
    // orthogonal basis so the chordal subspace projection ||U_perp^T c||_2 never double-counts
    // collinear poles.
    //
    // The unit query direction q_hat is used as the 0-th Gram-Schmidt reference axis and is then
    // REMOVED from the frame: every retained pole axis u_k satisfies <u_k, q_hat> = 0 exactly,
    // so the frame spans the orthogonal complement to the query — the subspace where a genuine
    // cross-domain bridge lives and where a same-domain direct answer has no energy at all.
    let grassmann_frame: Vec<Vec<f32>> =
        if input.config.enable_grassmann_subspace_readout {
            let mut basis: Vec<Vec<f64>> = Vec::new();
            if input.query.vector.len() == dimension {
                let qf: Vec<f64> = input.query.vector.iter().map(|&x| x as f64).collect();
                let qn: f64 = qf.iter().map(|x| x * x).sum::<f64>().sqrt();
                if qn > 1e-12 {
                    let unit: Vec<f64> = qf.into_iter().map(|x| x / qn).collect();
                    basis.push(unit);
                }
            }
            let mut raw_poles: Vec<&[f32]> = Vec::new();
            if input.transfer_vector.len() == dimension {
                raw_poles.push(&input.transfer_vector);
            }
            for pole in &cached_transfer_basins {
                if pole.len() == dimension {
                    raw_poles.push(pole.as_slice());
                }
            }
            let mut axes: Vec<Vec<f64>> = Vec::new();
            for raw in raw_poles {
                let mut v: Vec<f64> = raw.iter().map(|&x| x as f64).collect();
                for b in &basis {
                    let dot_proj: f64 = v.iter().zip(b.iter()).map(|(a, b_val)| a * b_val).sum();
                    for (vi, &bi) in v.iter_mut().zip(b.iter()) {
                        *vi -= dot_proj * bi;
                    }
                }
                let norm: f64 = v.iter().map(|x| x * x).sum::<f64>().sqrt();
                if norm > 0.15 {
                    for vi in &mut v {
                        *vi /= norm;
                    }
                    basis.push(v.clone());
                    axes.push(v);
                    if axes.len() >= 4 {
                        break;
                    }
                }
            }
            axes.into_iter()
                .map(|b| b.into_iter().map(|x| x as f32).collect())
                .collect()
        } else {
            Vec::new()
        };

    curves.par_iter_mut().for_each(|curve| {
        curve.query_score = cosine(&input.query.vector, &curve.chunk_vector);
        curve.denoised_score = cosine(&input.denoised_vector, &curve.chunk_vector);
        curve.local_score = cosine(&input.local_vector, &curve.chunk_vector);
        let centroid_transfer = cosine(&input.transfer_vector, &curve.chunk_vector);
        let mut best_pole = centroid_transfer;
        let mut second_pole = 0.0f64;
        if input.config.enable_v8_extensions {
            for pole in cached_transfer_basins
                .iter()
                .filter(|pole| pole.len() == curve.chunk_vector.len())
            {
                let sim = cosine(pole, &curve.chunk_vector);
                if sim > best_pole {
                    second_pole = best_pole.max(second_pole);
                    best_pole = sim;
                } else if sim > second_pole {
                    second_pole = sim;
                }
            }
        }
        let simplicial_confluence = if best_pole > 0.25 && second_pole > 0.25 {
            0.08 * (best_pole * second_pole).sqrt()
        } else {
            0.0
        };
        let grassmann_gain = if grassmann_frame.len() >= 2 {
            let mut chordal_sq = 0.0f64;
            let mut active_axes = 0usize;
            for (axis_idx, axis) in grassmann_frame.iter().enumerate() {
                let weight = 1.0 / (1.0 + 0.25 * axis_idx as f64);
                let proj = positive(cosine(axis, &curve.chunk_vector));
                if proj > 0.12 {
                    active_axes += 1;
                    chordal_sq += weight * proj * proj;
                }
            }
            if active_axes >= 2 {
                0.06 * (chordal_sq.sqrt() - best_pole.max(0.0)).max(0.0)
            } else {
                0.0
            }
        } else {
            0.0
        };
        // Stiefel Frame Orthogonal-Complement Projection s_perp = ||U_perp^T c_hat||_2:
        // U_perp is the Gram-Schmidt orthonormalized transfer pole frame with q_hat projected out.
        // Irrelevant noise orthogonal to both q_hat and the transfer poles projects to 0.
        let ortho_residual = if !grassmann_frame.is_empty() && !curve.chunk_vector.is_empty() {
            let mut proj_sq = 0.0f64;
            for (axis_idx, axis) in grassmann_frame.iter().enumerate() {
                let weight = 1.0 / (1.0 + 0.25 * axis_idx as f64);
                let proj = positive(cosine(axis, &curve.chunk_vector));
                proj_sq += weight * proj * proj;
            }
            proj_sq.sqrt()
        } else {
            0.0
        };
        curve.ortho_residual = clamp01(ortho_residual);
        curve.transfer_score = (best_pole + simplicial_confluence + grassmann_gain).min(1.0);
    });
    let projected_count = curves.len();
    let mut curves = select_superset(curves, &input.config);
    let selected_tag_ids: Vec<i64> = curves.iter().flat_map(file_tags).map(|relation| relation.0).collect();
    let selected_stats = ensure_tag_vectors_loaded(connection, &mut tag_vectors, &selected_tag_ids, dimension)?;
    attach_tags(&mut curves, &curve_load.relations, &tag_vectors);

    // V9 Cellular Sheaf Cross-Chunk Supremum Section Envelope:
    // When multiple chunks from the same file_id (or adjacent sections) enter the candidate pool,
    // their individual `chunk_cosine` against the file's Tag curve represents only a local stalk.
    // By taking a soft sheaf envelope \psi_f(t_l) = 0.72 * c_local + 0.28 * \max_{sibling} c_sibling,
    // an introductory chunk and a conclusion chunk jointly illuminate the entire directed Tag river!
    if input.config.enable_cellular_sheaf_envelope && curves.len() > 1 {
        let mut file_tag_supremum: HashMap<(i64, i64), (f64, usize)> = HashMap::new();
        let mut file_chunk_counts: HashMap<i64, usize> = HashMap::new();
        for curve in &curves {
            *file_chunk_counts.entry(curve.file_id).or_default() += 1;
            for tag in &curve.tags {
                let entry = file_tag_supremum
                    .entry((curve.file_id, tag.id))
                    .or_insert((0.0, 0));
                if tag.chunk_cosine > entry.0 {
                    entry.0 = tag.chunk_cosine;
                }
                entry.1 += 1;
            }
        }
        for curve in &mut curves {
            if file_chunk_counts.get(&curve.file_id).copied().unwrap_or(0) > 1 {
                for tag in &mut curve.tags {
                    if let Some(&(sup_cos, _)) = file_tag_supremum.get(&(curve.file_id, tag.id)) {
                        if sup_cos > tag.chunk_cosine {
                            tag.chunk_cosine = clamp01(0.72 * tag.chunk_cosine + 0.28 * sup_cos);
                        }
                    }
                }
            }
        }
    }
    let selected_count = curves.len();

    let transfer_domain: HashSet<i64> = input
        .query_state
        .transfer_domain_ids
        .iter()
        .copied()
        .filter(|id| !input.config.enable_v8_extensions || !local_domain.contains(id))
        .collect();
    let workspace = FieldWorkspace {
        local: normalize_field(&input.query_state.local_field),
        transfer: if input.config.enable_v8_extensions {
            normalize_field(
                &input
                    .query_state
                    .transfer_field
                    .iter()
                    .copied()
                    .filter(|(id, _)| !local_domain.contains(id))
                    .collect::<Vec<_>>(),
            )
        } else {
            normalize_field(&input.query_state.transfer_field)
        },
        local_domain,
        transfer_domain,
        source_ids: input
            .query_state
            .source_field
            .iter()
            .map(|entry| entry.0)
            .collect(),
    };
    let direct_ids: Vec<i64> = input
        .query_state
        .field_provenance
        .iter()
        .filter(|entry| {
            entry.hop == 0 && (entry.source_type == "core" || entry.source_type == "seed")
        })
        .map(|entry| entry.id)
        .collect();
    let fallback_anchor = direct_ids.is_empty();
    let anchor_ids: HashSet<i64> = if fallback_anchor {
        input
            .query_state
            .source_field
            .iter()
            .map(|entry| entry.0)
            .collect()
    } else {
        direct_ids.into_iter().collect()
    };
    let seeds: Vec<(i64, f64)> = input
        .query_state
        .source_field
        .iter()
        .filter(|entry| anchor_ids.contains(&entry.0) && entry.1 > 0.0)
        .copied()
        .collect();

    // Query River 节点和 Direct Anchor/Seed 共享一次分块 Tag 向量读取。
    // 同一 ID 同时属于河网和锚点时只读取、解码并存储一次。
    let mut requested_tag_ids: Vec<i64> = input
        .query_state
        .river_nodes
        .iter()
        .map(|node| node.id)
        .collect();
    requested_tag_ids.extend(seeds.iter().map(|seed| seed.0));
    let query_stats = ensure_tag_vectors_loaded(
        connection, &mut tag_vectors, &requested_tag_ids, dimension)?;
    let query_tag_sql_batches = query_stats.sql_batches;
    let query_and_seed_tag_vectors = tag_vectors;
    let load_ms = load_started.elapsed().as_secs_f64() * 1000.0;

    let compute_started = Instant::now();
    let morphology = compute_query_morphology(&input);
    let cosines = CosineCache::build(
        &curves,
        &input.query.vector,
        input.query_state.river_nodes.iter().map(|node| node.id)
            .chain(seeds.iter().map(|seed| seed.0)),
        &query_and_seed_tag_vectors,
    );

    // Anchor rarity depends on the complete selected candidate pool, so compute it
    // before consuming `curves`. The indexed parallel result preserves curve order.
    let anchor_results = compute_anchors(
        &curves,
        &seeds,
        &query_and_seed_tag_vectors,
        &artifact,
        &input.config,
        fallback_anchor,
        &cosines,
    );
    let core_tag_names: HashSet<String> = input
        .query_state
        .field_provenance
        .iter()
        .filter(|entry| entry.source_type == "core")
        .filter_map(|entry| {
            curves
                .iter()
                .flat_map(|curve| curve.tags.iter())
                .find(|tag| tag.id == entry.id)
                .map(|tag| tag.name.to_lowercase())
        })
        .collect();

    let mut work: Vec<ScoredWork> = curves
        .into_par_iter()
        .zip(anchor_results.into_par_iter())
        .map(|(curve, anchor)| {
            let geometry = evaluate_path(&curve, &workspace, &artifact, &input.config);
            let topology = evaluate_topology(
                &curve, &input, &artifact, &query_and_seed_tag_vectors, &cosines, &stokes_corridors,
            );
            let visible = true; // 越权候选已在进入候选池前删除。
            let observables =
                evaluate_observables(&curve, &geometry, &input, &workspace, visible, &cosines);
            let semantic_total = (input.config.pure_query_weight
                + input.config.pure_local_weight
                + input.config.pure_transfer_weight)
                .max(1e-12);
            // V9 Dual-Manifold Semantic Base & Order-Preserving Bipartite Potential Coupling:
            // 1) Allow `denoised_score` (which carries the orthogonal dipole query component) to support `query_score`;
            // 2) Couple the 2-Simplex Stokes bipartite pullback score and geodesic edge graph score into the
            //    structural potential so genuine cross-domain bridge notes are not crushed by single-cluster neighbors!
            let effective_query_sim = clamp01(curve.query_score);
            let raw_semantic_base = clamp01(
                (input.config.pure_query_weight * effective_query_sim
                    + input.config.pure_local_weight * clamp01(curve.local_score)
                    + input.config.pure_transfer_weight * clamp01(curve.transfer_score))
                    / semantic_total,
            );
            // Dual-Ledger Conservation Architecture (left ledger = 0-order tangent section,
            // right ledger = 1-order directed Stokes coboundary):
            //
            //   s_parallel      : parallel direct-answer axis (the whole `raw_semantic_base`)
            //   s_perp          : orthogonal-complement bridge pole projection
            //   right_ledger    : directed Stokes flux closure over the corridor topology
            //   eta_balance     : bridge credence, gated by the dual-domain cut-edge continuity
            //
            // The two ledgers are recombined by the generalized Pythagorean identity
            // `E_sec = sqrt(s_parallel^2 + eta * s_perp^2)`. For a well-posed direct answer
            // (`s_perp ~ 0`) or a topology with no directed flux (`eta = 0`) this is EXACTLY
            // `s_parallel`: `sqrt(x^2) == x` bit-for-bit, so the good-state baseline is conserved.
            let s_parallel = raw_semantic_base;
            // Orthogonal-complement bridge projection: the chunk's real energy in U_perp
            // (query axis projected out), floored by the Grassmannian pole readout so a chunk
            // that a transfer basin explains but whose raw residual is tilted is still credited.
            let s_perp = (clamp01(curve.ortho_residual.max(0.0)) * clamp01(curve.transfer_score)).sqrt();
            let dual_domain_gate = if observables.local_coverage > 0.0
                && observables.transfer_coverage > 0.0
            {
                1.0
            } else if observables.transfer_coverage > 0.0 && curve.bipartite_score >= 0.30 {
                0.75
            } else {
                0.0
            };
            let right_ledger_flux = clamp01(
                0.55 * curve.bipartite_score
                    + 0.45 * topology.edge_graph_score.max(geometry.path_quality),
            );
            let eta_balance = if input.config.enable_bipartite_bridge_pullback
                && input.config.enable_grassmann_subspace_readout
            {
                clamp01(dual_domain_gate * (s_perp * right_ledger_flux).sqrt())
            } else {
                0.0
            };
            // Only the orthogonal residual space may be expanded: the Pythagorean lift can never
            // place more energy in the section than the unit sphere allows.
            let ortho_residual_cap = (1.0 - s_parallel * s_parallel).max(0.0);
            let pythagorean_lift = (s_parallel * s_parallel
                + 0.38 * eta_balance * (s_perp * s_perp).min(ortho_residual_cap))
            .sqrt();
            let semantic_base = clamp01(pythagorean_lift);
            let topology_raw = clamp01(
                0.50 * geometry.path_quality
                    + 0.20 * topology.edge_graph_score
                    + 0.30
                        * clamp01(
                            0.30 * observables.local_coverage
                                + 0.30 * observables.transfer_coverage
                                + 0.20 * clamp01(observables.local_potential)
                                + 0.20 * clamp01(observables.transfer_potential),
                        ),
            );
            let path_reliability = clamp01(
                geometry.path_quality.max(0.65 * topology.edge_graph_score)
                    / input.config.topology_path_saturation.max(1e-6),
            );
            let topology_reliability = (path_reliability * observables.query_chunk_score).sqrt();
            let ledger_tier = if input.config.enable_bipartite_bridge_pullback
                && observables.local_coverage > 0.0
                && observables.transfer_coverage > 0.0
                && topology.matched_edges >= 1
                && right_ledger_flux >= 0.28
                && (s_perp >= 0.22 || (topology.matched_edges >= 2 && curve.bipartite_score >= 0.35))
            {
                LedgerTier::Green
            } else if eta_balance > 0.0 || geometry.supported_segments > 0 {
                LedgerTier::Yellow
            } else {
                LedgerTier::Red
            };
            let effective_topo_cap = if ledger_tier == LedgerTier::Green {
                (input.config.topology_bonus_cap * (1.0 + 0.45 * eta_balance.max(0.5))).min(0.14)
            } else {
                input.config.topology_bonus_cap
            };
            let topology_bonus = effective_topo_cap * topology_raw * topology_reliability;
            let pure_score = clamp01(semantic_base + topology_bonus.min(effective_topo_cap));
            let atomic_score = 0.75 * topology.node_graph_score + 0.25 * topology.edge_graph_score;
            let propositional_score =
                0.25 * topology.node_graph_score + 0.75 * topology.edge_graph_score;
            let narrative_score =
                0.15 * topology.node_graph_score + 0.85 * topology.edge_graph_score;
            let graph_score = clamp01(
                morphology.atomic_weight * atomic_score
                    + morphology.propositional_weight * propositional_score
                    + morphology.narrative_weight * narrative_score,
            );
            ScoredWork {
                curve,
                geometry,
                topology,
                direct_evidence: observables.semantic_boundary_score.max(observables.direct),
                observables,
                pure_score,
                graph_score,
                ledger_tier,
                role: String::new(),
                original_role: String::new(),
                role_reclassification_reason: None,
                anchor,
                v2_bonus: 0.0,
                gated_bonus: 0.0,
                anchor_bonus: 0.0,
                final_score: 0.0,
            }
        })
        .collect();
    let omega = compute_omega(&input);
    let mode = morphology.dominant_mode.as_str();
    assign_v3_scores(&mut work, mode, &omega, &input.config);
    work.sort_by(|left, right| {
        right
            .final_score
            .partial_cmp(&left.final_score)
            .unwrap_or(Ordering::Equal)
            .then_with(|| {
                right
                    .curve
                    .union_score
                    .partial_cmp(&left.curve.union_score)
                    .unwrap_or(Ordering::Equal)
            })
            .then_with(|| left.curve.union_rank.cmp(&right.curve.union_rank))
    });
    let ranked_count = work.len();

    let results: Vec<NativeResultItem> = work
        .into_iter()
        .take(input.top_k.max(1))
        .enumerate()
        .map(|(index, item)| {
            // Same set as before, listed in curve order instead of hash order.
            let mut seen_names = HashSet::new();
            let matched_tags: Vec<String> = item
                .curve
                .tags
                .iter()
                .filter(|tag| seen_names.insert(tag.name.as_str()))
                .map(|tag| tag.name.clone())
                .collect();
            let core_tags_matched = matched_tags
                .iter()
                .filter(|name| core_tag_names.contains(&name.to_lowercase()))
                .cloned()
                .collect();
            let topology_v3 = if input.include_trace {
                Some(serde_json::json!({
                    "mode": "river_observability_gated_v2_with_direct_anchor",
                    "omega": omega.omega,
                    "regime": omega.regime,
                    "omegaEdge": omega.omega_edge,
                    "omegaEmerge": omega.omega_emerge,
                    "omegaFlow": omega.omega_flow,
                    "omegaGamma": input.config.omega_gamma,
                    "graphGate": omega.omega.powf(input.config.omega_gamma.max(0.0)),
                    "v2Bonus": item.v2_bonus,
                    "gatedV2Bonus": item.gated_bonus,
                    "anchorScore": item.anchor.score,
                    "anchorReliability": item.anchor.reliability,
                    "anchorStrength": item.anchor.strength,
                    "anchorBonus": item.anchor_bonus,
                    "contactedSeeds": item.anchor.contacted_seeds,
                    "exactContacts": item.anchor.exact_contacts,
                    "semanticContacts": item.anchor.semantic_contacts,
                    "meanClosure": item.anchor.mean_closure,
                    "role": item.role,
                    "originalRole": item.original_role,
                    "roleReclassified": item.original_role != item.role,
                    "roleReclassificationReason": item.role_reclassification_reason,
                    "pureScore": item.pure_score,
                    "finalScore": item.final_score,
                    "nativeBackend": "rust-rayon"
                }))
            } else {
                None
            };
            NativeResultItem {
                id: item.curve.id,
                chunk_id: item.curve.id,
                rank: index + 1,
                score: item.final_score,
                base_score: item.pure_score,
                topology_bonus: item.gated_bonus,
                anchor_bonus: item.anchor_bonus,
                role: item.role,
                omega: omega.omega,
                river_regime: omega.regime.clone(),
                matched_tags,
                core_tags_matched,
                candidate_sources: item.curve.sources,
                original_score: original_score_by_id
                    .get(&item.curve.id)
                    .copied()
                    .unwrap_or(0.0),
                topology_v3,
                relative_topology: input.include_trace.then_some(item.topology),
                geometry: input.include_trace.then_some(item.geometry),
                observables: input.include_trace.then_some(item.observables),
            }
        })
        .collect();
    let compute_ms = compute_started.elapsed().as_secs_f64() * 1000.0;

    let output = NativeOutput {
        schema: RESULT_SCHEMA.to_string(),
        algorithm_version: ALGORITHM_VERSION.to_string(),
        artifact_sig: artifact_sig.to_string(),
        query_id: input.query_state.query_id.clone(),
        omega,
        query_mode: mode.to_string(),
        query_morphology: morphology,
        diagnostics: NativeDiagnostics {
            backend: "rust-rayon-sqlite".to_string(),
            offered_candidates: input.candidates.len(),
            projected_candidates: projected_count,
            selected_candidates: selected_count,
            ranked_candidates: ranked_count,
            returned_candidates: results.len(),
            rayon_threads: rayon::current_num_threads(),
            artifact_nodes: artifact.node_ids.len(),
            artifact_edges: artifact.targets.len(),
            load_ms,
            compute_ms,
            total_ms: total_started.elapsed().as_secs_f64() * 1000.0,
            chunk_sql_batches: curve_load.chunk_sql_batches,
            file_tag_sql_batches: curve_load.file_tag_sql_batches,
            query_tag_sql_batches,
            candidate_tag_vector_sql_batches: domain_stats.sql_batches + selected_stats.sql_batches,
            candidate_tag_vector_fetched_nodes: domain_stats.fetched_nodes + selected_stats.fetched_nodes,
        },
        results,
    };
    serde_json::to_string(&output)
        .map_err(|error| format!("encode RiverMemo native output failed: {}", error))
}

pub struct RiverMemoTopologyV3Task {
    runtime: Arc<MemoRuntime>,
    db_path: String,
    artifact_sig: String,
    input_json: String,
}

impl Task for RiverMemoTopologyV3Task {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        run_native(
            &self.runtime,
            &self.db_path,
            &self.artifact_sig,
            &self.input_json,
        )
        .map_err(Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub(crate) fn rerank_with_runtime(
    lifecycle: &Arc<crate::task_lifecycle::TaskLifecycle>,
    runtime: Arc<MemoRuntime>,
    db_path: String,
    artifact_sig: String,
    input_json: String,
) -> AsyncTask<crate::task_lifecycle::TrackedTask<RiverMemoTopologyV3Task>> {
    AsyncTask::new(crate::task_lifecycle::TrackedTask::new(lifecycle, RiverMemoTopologyV3Task {
        runtime,
        db_path,
        artifact_sig,
        input_json,
    }))
}


#[cfg(test)]
mod provenance_codec_tests {
    use super::*;

    #[test]
    fn compact_and_legacy_contributions_have_identical_meaning() {
        assert_eq!(decode_provenance_row(&serde_json::json!([7, 0.35])),
            decode_provenance_row(&serde_json::json!([7, "diary", "path", 0.35])));
        assert_eq!(decode_provenance_row(&serde_json::json!([7, 0.35])), Some((7, 0.35)));
        for invalid in [serde_json::json!([7]), serde_json::json!([7, "x"]),
            serde_json::json!([0, 0.3]), serde_json::json!([7, -0.3])] {
            assert!(decode_provenance_row(&invalid).is_none());
        }
    }

    #[test]
    fn v9_bipartite_hypergraph_pullback_favors_forward_causal_order_and_zero_sql_curves() {
        let mut bip = BipartiteHypergraphIndex::default();
        bip.tag_names.insert(10, "TagA".to_string());
        bip.tag_names.insert(20, "TagB".to_string());
        // File 100 has forward narrative order: 10 (pos 0) -> 20 (pos 1)
        bip.file_to_tags.insert(100, vec![(10, 0), (20, 1)]);
        // File 200 has reverse narrative order: 20 (pos 0) -> 10 (pos 1)
        bip.file_to_tags.insert(200, vec![(20, 0), (10, 1)]);
        bip.tag_to_files.insert(10, vec![(100, 0, 0), (200, 65535, 1)]);
        bip.tag_to_files.insert(20, vec![(100, 65535, 1), (200, 0, 0)]);
        bip.file_primary_chunk.insert(100, 1001);
        bip.file_primary_chunk.insert(200, 2001);

        let artifact = NativeArtifact {
            node_ids: vec![10, 20],
            node_index: HashMap::from([(10, 0), (20, 1)]),
            row_offsets: vec![0, 1, 1],
            targets: vec![1],
            weights: vec![0.8],
            bipartite: Some(Arc::new(bip)),
            ..NativeArtifact::default()
        }
        .prepared();

        let nodes = vec![
            RiverNode { id: 10, energy: 1.0, normalized_energy: 1.0, hop: 0 },
            RiverNode { id: 20, energy: 0.6, normalized_energy: 0.6, hop: 2 },
        ];
        let edges = vec![RiverEdge {
            source_id: 10,
            target_id: 20,
            flow: 0.5,
            normalized_flow: 0.8,
        }];
        let edge_refs: Vec<&RiverEdge> = edges.iter().collect();
        let corridors = build_directed_stokes_corridors(&edge_refs, &nodes, &artifact, true);
        let pulled = artifact.pullback_bridge_candidates(
            &nodes,
            &corridors,
            &[(20, 0.5)],
            None,
            &HashSet::new(),
            10,
        );
        assert_eq!(pulled.len(), 2);
        // Forward causal order file 100 (chunk 1001) must outrank reverse file 200 (chunk 2001)
        assert_eq!(pulled[0].0, 1001);
        assert_eq!(pulled[1].0, 2001);
        assert!(pulled[0].2 > pulled[1].2 * 1.5);

        // Torture 1: Permission Scope Isolation & Empty Scope Zero-Leakage
        let empty_scope: HashSet<i64> = HashSet::new();
        assert!(
            artifact
                .pullback_bridge_candidates(&nodes, &corridors, &[(20, 0.5)], Some(&empty_scope), &HashSet::new(), 10)
                .is_empty(),
            "Explicit empty allowed_files scope must never leak any bipartite bridge candidate"
        );
        let restricted_scope: HashSet<i64> = HashSet::from([200]);
        let scoped = artifact.pullback_bridge_candidates(
            &nodes,
            &corridors,
            &[(20, 0.5)],
            Some(&restricted_scope),
            &HashSet::new(),
            10,
        );
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].1, 200);
    }

    #[test]
    fn v9_torture_antipodal_poles_collinear_rank_deficiency_and_glass_ceiling_liberation() {
        let mut bip = BipartiteHypergraphIndex::default();
        for (id, name) in [(1, "SeedA"), (2, "FerryB"), (3, "TargetC"), (4, "DistractorD")] {
            bip.tag_names.insert(id, name.to_string());
        }
        // File 10 (Bridge Note): 1 -> 2 -> 3, split across two sibling chunks (101: front, 102: back)
        bip.file_to_tags.insert(10, vec![(1, 0), (2, 1), (3, 2)]);
        // File 20 (Single-domain Direct Answer): only Tag 1
        bip.file_to_tags.insert(20, vec![(1, 0)]);
        bip.tag_to_files.insert(1, vec![(10, 0, 0), (20, 32768, 0)]);
        bip.tag_to_files.insert(2, vec![(10, 32768, 1)]);
        bip.tag_to_files.insert(3, vec![(10, 65535, 2)]);
        bip.file_primary_chunk.insert(10, 101);
        bip.file_primary_chunk.insert(20, 201);

        let artifact = NativeArtifact {
            node_ids: vec![1, 2, 3, 4],
            node_index: HashMap::from([(1, 0), (2, 1), (3, 2), (4, 3)]),
            row_offsets: vec![0, 1, 2, 2, 2],
            targets: vec![1, 2],
            weights: vec![0.9, 0.9],
            wormhole_edges: HashSet::from([(2, 3)]),
            bipartite: Some(Arc::new(bip)),
            ..NativeArtifact::default()
        }
        .prepared();

        // Torture 2: Path-Transitive Geodesic Homotopy when intermediate Hop-1 node (2) is missing from candidate tags
        // Candidate has tags [1 (pos 0), 3 (pos 2)], river has 1 (hop 0) -> 2 (hop 1) -> 3 (hop 2)
        let mut tag_vectors: TagVectorPool = TagVectorPool::new();
        tag_vectors.insert(1, Arc::from(vec![1.0f32, 0.0, 0.0, 0.0]));
        tag_vectors.insert(2, Arc::from(vec![0.0f32, 1.0, 0.0, 0.0]));
        tag_vectors.insert(3, Arc::from(vec![0.0f32, 0.0, 1.0, 0.0]));

        let transitive_curve = Curve {
            id: 101,
            file_id: 10,
            tags: vec![
                TagData {
                    id: 1,
                    name: "SeedA".into(),
                    position: 0,
                    vector: tag_vectors[&1].clone(),
                    chunk_cosine: 0.75,
                },
                TagData {
                    id: 3,
                    name: "TargetC".into(),
                    position: 2,
                    vector: tag_vectors[&3].clone(),
                    chunk_cosine: 0.80,
                },
            ],
            chunk_vector: Arc::from(vec![0.5f32, 0.0, 0.866, 0.0]),
            query_score: 0.50,
            denoised_score: 0.78,
            local_score: 0.60,
            transfer_score: 0.85,
            ortho_residual: 0.866,
            bipartite_score: 0.95,
            bm25_score: 0.0,
            time_score: 0.0,
            anchor_score: 0.80,
            union_score: 0.85,
            union_rank: 1,
            sources: vec!["query_knn".into()],
        };

        let mut input = NativeInput {
            observation_handle: None,
            dimension: 4,
            top_k: 5,
            include_trace: true,
            allowed_file_ids: None,
            query: QueryInput {
                _text: "q".into(),
                vector: vec![1.0, 0.0, 0.0, 0.0],
            },
            denoised_vector: vec![0.8, 0.0, 0.6, 0.0],
            local_vector: vec![1.0, 0.0, 0.0, 0.0],
            transfer_vector: vec![0.0, 0.0, 1.0, 0.0],
            candidates: Vec::new(),
            query_state: QueryStateInput {
                query_id: Some("torture".into()),
                source_field: vec![(1, 1.0)],
                local_field: vec![(1, 1.0), (2, 0.5)],
                transfer_field: vec![(2, 0.6), (3, 0.9)],
                local_domain_ids: vec![1, 2],
                transfer_domain_ids: vec![2, 3],
                river_nodes: vec![
                    RiverNode { id: 1, energy: 1.0, normalized_energy: 1.0, hop: 0 },
                    RiverNode { id: 2, energy: 0.6, normalized_energy: 0.6, hop: 1 },
                    RiverNode { id: 3, energy: 0.5, normalized_energy: 0.5, hop: 2 },
                ],
                river_edges: vec![
                    RiverEdge { source_id: 1, target_id: 2, flow: 0.6, normalized_flow: 1.0 },
                    RiverEdge { source_id: 2, target_id: 3, flow: 0.4, normalized_flow: 0.67 },
                ],
                field_provenance: vec![SourceProvenance { id: 1, hop: 0, source_type: "seed".into() }],
                complete_observation: true,
            },
            config: NativeConfig::default(),
        };

        let cosines = CosineCache::build(
            std::slice::from_ref(&transitive_curve),
            &input.query.vector,
            [1, 2, 3].into_iter(),
            &tag_vectors,
        );
        let retained_v9: Vec<&RiverEdge> = input.query_state.river_edges.iter().collect();
        let corridors_v9 = build_directed_stokes_corridors(
            &retained_v9,
            &input.query_state.river_nodes,
            &artifact,
            true,
        );
        let topo_v9 = evaluate_topology(
            &transitive_curve,
            &input,
            &artifact,
            &tag_vectors,
            &cosines,
            &corridors_v9,
        );
        assert!(
            topo_v9.matched_edges >= 1 && topo_v9.edge_graph_score > 0.35,
            "V9 Path-Transitive Homotopy must credit 2-hop river chain (1 -> 2 -> 3) when curve anchors (1 -> 3): {:?}",
            topo_v9
        );

        // Verify cut-edge segment potential in `evaluate_path`: segment (1 in Local -> 3 in Transfer)
        // must be supported and produce positive path_quality when pullback flag is ON!
        let ws = FieldWorkspace {
            local: normalize_field(&input.query_state.local_field),
            transfer: normalize_field(&input.query_state.transfer_field),
            local_domain: HashSet::from([1]),
            transfer_domain: HashSet::from([3]),
            source_ids: HashSet::from([1]),
        };
        let geom_v9 = evaluate_path(&transitive_curve, &ws, &artifact, &input.config);
        assert!(
            geom_v9.supported_segments == 1 && geom_v9.path_quality > 0.25,
            "Cut-edge cross potential must support segment (1 in Local -> 3 in Transfer): {:?}",
            geom_v9
        );

        // When flag is OFF, direct edge matching on (1->2) and (2->3) finds 0 matched edges because node 2 is absent!
        input.config.enable_bipartite_bridge_pullback = false;
        let topo_v8 = evaluate_topology(
            &transitive_curve,
            &input,
            &artifact,
            &tag_vectors,
            &cosines,
            &[],
        );
        assert_eq!(topo_v8.matched_edges, 0);

        // Counterexample 1 (Audit P1-3): Disconnected branches A (1 -> 2) and B (4 -> 3)
        // Candidate has ordered tags [1, 3], but no directed path 1 ->* 3 exists in river_edges.
        // Must NOT fabricate matched edges or edge_topology reliability!
        input.config.enable_bipartite_bridge_pullback = true;
        input.query_state.river_nodes = vec![
            RiverNode { id: 1, energy: 1.0, normalized_energy: 1.0, hop: 0 },
            RiverNode { id: 2, energy: 0.6, normalized_energy: 0.6, hop: 1 },
            RiverNode { id: 4, energy: 0.8, normalized_energy: 0.8, hop: 0 },
            RiverNode { id: 3, energy: 0.5, normalized_energy: 0.5, hop: 1 },
        ];
        input.query_state.river_edges = vec![
            RiverEdge { source_id: 1, target_id: 2, flow: 0.6, normalized_flow: 1.0 },
            RiverEdge { source_id: 4, target_id: 3, flow: 0.5, normalized_flow: 0.83 },
        ];
        let retained_disc: Vec<&RiverEdge> = input.query_state.river_edges.iter().collect();
        let corridors_disc = build_directed_stokes_corridors(
            &retained_disc,
            &input.query_state.river_nodes,
            &artifact,
            true,
        );
        let topo_disconnected = evaluate_topology(
            &transitive_curve,
            &input,
            &artifact,
            &tag_vectors,
            &cosines,
            &corridors_disc,
        );
        assert_eq!(
            topo_disconnected.matched_edges, 0,
            "disconnected branches 1->2 and 4->3 must never produce false matched_edges: {:?}",
            topo_disconnected
        );
        assert_eq!(topo_disconnected.matched_edge_coverage, 0.0);
        assert_eq!(topo_disconnected.edge_topology_score, 0.0);
        assert_eq!(topo_disconnected.reliability_mode, "node_alignment_fallback");

        // Counterexample 2 (Audit P1-2): Hot-state resident bipartite index must refresh when
        // `file_tags` are deleted or moved to a new position under the same active `artifact_sig`.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT);
             CREATE TABLE file_tags (file_id INTEGER, tag_id INTEGER, position INTEGER);
             CREATE TABLE chunks (id INTEGER PRIMARY KEY, file_id INTEGER, vector BLOB);
             INSERT INTO tags VALUES (1, 'Tag1'), (2, 'Tag2');
             INSERT INTO file_tags VALUES (1, 1, 1), (1, 2, 2);
             INSERT INTO chunks VALUES (101, 1, X'0000803F000000000000000000000000');"
        ).unwrap();
        let fp1 = BipartiteHypergraphIndex::compute_fingerprint(&conn);
        let bip1 = BipartiteHypergraphIndex::build_from_connection(&conn);
        assert_eq!(bip1.file_to_tags.get(&1).cloned().unwrap_or_default(), vec![(1, 1), (2, 2)]);

        // Delete tag 1, move tag 2 to position 3
        conn.execute("DELETE FROM file_tags WHERE file_id = 1 AND tag_id = 1", []).unwrap();
        conn.execute("UPDATE file_tags SET position = 3 WHERE file_id = 1 AND tag_id = 2", []).unwrap();
        let fp2 = BipartiteHypergraphIndex::compute_fingerprint(&conn);
        assert_ne!(fp1, fp2, "fingerprint must change when file_tags is mutated");
        let bip2 = BipartiteHypergraphIndex::build_from_connection(&conn);
        assert_eq!(bip2.file_to_tags.get(&1).cloned().unwrap_or_default(), vec![(2, 3)]);
    }
}

#[cfg(test)]
mod cold_load_tests {
    use super::*;
    use std::io::Write;

    const NODES: i64 = 3000;

    fn payload(with_provenance: bool) -> Value {
        let mut row_offsets = vec![0_u64];
        let mut targets = Vec::new();
        let mut weights = Vec::new();
        for source in 0..NODES {
            for step in 1..=8 {
                targets.push(((source + step) % NODES) as u64);
                weights.push(0.1 + 0.2 / step as f64);
            }
            row_offsets.push(targets.len() as u64);
        }
        let mut value = serde_json::json!({
            "schema": "rivermemo-persisted-artifact-v2",
            "artifact": {"maxInbound": 0.1 + 0.2},
            "sharedTransport": {
                "nodeIds": (1..=NODES).collect::<Vec<_>>(),
                "rowOffsets": row_offsets,
                "targetIndices": targets,
                "weights": weights,
            },
            "anchorGainView": [[1, 1.5], [2, 0.75]],
            "inboundMassView": [[2, 0.7], [3, 1e-310]],
            "wormholeView": ["1:2", "2:3"],
        });
        if with_provenance {
            value["provenanceView"] = serde_json::json!({"edges": (1..=NODES).map(|id| serde_json::json!(
                [format!("{}:{}", id, id % NODES + 1), [[id, 0.5], [id + 1, 0.1 + 0.2]]]
            )).collect::<Vec<_>>()});
        }
        value
    }

    fn store(connection: &Connection, payload: &Value) {
        let raw = serde_json::to_vec(payload).unwrap();
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(&raw).unwrap();
        connection.execute_batch(
            "CREATE TABLE rivermemo_artifacts(
                artifact_sig TEXT PRIMARY KEY, schema_version TEXT, algorithm_version TEXT,
                payload_codec TEXT, payload_checksum TEXT, payload BLOB, status TEXT);
             CREATE TABLE kbm_artifact_dependencies(
                artifact_sig TEXT, dependency_key TEXT, dependency_version TEXT,
                PRIMARY KEY(artifact_sig,dependency_key));
             CREATE TABLE kbm_runtime_meta(key TEXT PRIMARY KEY,value TEXT);
             INSERT INTO kbm_artifact_dependencies VALUES
                ('fixture','memo_tag_facts','7'),('fixture','derived_geometry','11');
             INSERT INTO kbm_runtime_meta VALUES ('memo_tag_facts','7'),('derived_geometry','11');"
        ).unwrap();
        connection.execute(
            "INSERT INTO rivermemo_artifacts VALUES('fixture','rivermemo-persisted-artifact-v2',
                'memo.native-artifact-v2-binary','gzip-json-v1',?1,?2,'ready')",
            rusqlite::params![format!("{:x}", Sha256::digest(&raw)), encoder.finish().unwrap()],
        ).unwrap();
    }

    #[test]
    fn decoded_arrays_keep_their_values() {
        for with_provenance in [true, false] {
            let connection = Connection::open_in_memory().unwrap();
            store(&connection, &payload(with_provenance));
            let artifact = decode_artifact(&connection, "fixture").unwrap();
            assert_eq!(artifact.node_ids, (1..=NODES).collect::<Vec<_>>());
            assert_eq!(artifact.row_offsets.len(), NODES as usize + 1);
            assert_eq!(artifact.targets.len(), 8 * NODES as usize);
            let mut weights: Vec<u64> = artifact.weights.iter().map(|weight| weight.to_bits()).collect();
            weights.sort_unstable();
            weights.dedup();
            let mut expected: Vec<u64> = (1..=8).map(|step| (0.1 + 0.2 / step as f64).to_bits()).collect();
            expected.sort_unstable();
            assert_eq!(weights, expected);
            assert_eq!(artifact.max_inbound.to_bits(), (0.1 + 0.2_f64).to_bits());
            assert_eq!(artifact.inbound.get(&3).map(|value| value.to_bits()), Some(1e-310_f64.to_bits()));
            assert_eq!(artifact.anchor_gain.get(&2), Some(&0.75));
            assert!(artifact.wormhole_edges.contains(&(2, 3)));
            if with_provenance {
                assert_eq!(artifact.provenance.len(), NODES as usize);
                assert_eq!(artifact.provenance.get(&(NODES, 1)), Some(&vec![(NODES, 0.5), (NODES + 1, 0.1 + 0.2)]));
            } else {
                assert!(artifact.provenance.is_empty());
            }
        }
    }

    #[test]
    fn concurrent_cold_loads_share_one_decode() {
        let path = std::env::temp_dir().join(format!(
            "cold-load-{}-{}.sqlite", std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_nanos()).unwrap_or(0),
        ));
        store(&Connection::open(&path).unwrap(), &payload(true));
        let runtime = MemoRuntime::new();
        const THREADS: usize = 8;
        for round in 0..4 {
            runtime.clear().unwrap();
            let barrier = std::sync::Barrier::new(THREADS);
            let loaded: Vec<Arc<NativeArtifact>> = std::thread::scope(|scope| {
                let workers: Vec<_> = (0..THREADS).map(|_| scope.spawn(|| {
                    let connection = Connection::open(&path).unwrap();
                    barrier.wait();
                    load_artifact_with_connection(&runtime, &connection, "fixture").unwrap()
                })).collect();
                workers.into_iter().map(|worker| worker.join().unwrap()).collect()
            });
            let active = runtime.get("fixture").unwrap().unwrap();
            for artifact in &loaded {
                assert!(Arc::ptr_eq(artifact, &active), "round {round}: more than one decode");
            }
            assert_eq!(active.provenance.len(), NODES as usize);
        }
        std::fs::remove_file(path).unwrap();
    }
}
