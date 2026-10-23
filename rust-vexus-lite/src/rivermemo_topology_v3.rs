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
        }
    }
}
#[derive(Default)]
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
}

impl NativeArtifact {
    /// Derive immutable hot-path arrays after CSR validation, for both freshly
    /// built and restored assets. Temporary workspace is bounded to one row.
    pub(crate) fn prepared(mut self) -> Self {
        self.node_anchor_gain = self.node_ids.iter()
            .map(|id| self.anchor_gain.get(id).copied().unwrap_or(1.0)).collect();
        self.edge_is_wormhole = vec![false; self.targets.len()];
        for source in 0..self.node_ids.len() {
            let start = self.row_offsets[source];
            let end = self.row_offsets[source + 1];
            let mut row: Vec<(usize, f64)> = (start..end)
                .map(|cursor| (self.targets[cursor], self.weights[cursor])).collect();
            row.sort_by(|left, right| positive(right.1).total_cmp(&positive(left.1))
                .then_with(|| self.node_ids[left.0].cmp(&self.node_ids[right.0])));
            for (cursor, (target, weight)) in (start..end).zip(row) {
                self.targets[cursor] = target;
                self.weights[cursor] = weight;
                self.edge_is_wormhole[cursor] = self.wormhole_edges
                    .contains(&(self.node_ids[source], self.node_ids[target]));
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

    Ok(Arc::new(NativeArtifact {
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
        ..NativeArtifact::default()
    }.prepared()))
}

pub(crate) fn load_artifact_with_connection(
    runtime: &MemoRuntime,
    connection: &Connection,
    artifact_sig: &str,
) -> std::result::Result<Arc<NativeArtifact>, String> {
    let dependency_keys = serde_json::to_string(crate::storage::MEMO_ARTIFACT_DEPENDENCIES)
        .map_err(|e| e.to_string())?;
    let dependency_count = crate::storage::MEMO_ARTIFACT_DEPENDENCIES.len() as i64;
    let validate = |index_hint: &str| -> rusqlite::Result<bool> { connection.query_row(
        &format!("SELECT EXISTS(
           SELECT 1 FROM rivermemo_artifacts a{index_hint}
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
         )"), rusqlite::params![artifact_sig, dependency_keys, dependency_count], |row| row.get(0),
    ) };
    // 覆盖索引让校验只读索引页，不必越过行里的大 payload 去读排在它后面的列；
    // SQLite 默认会选主键索引，所以显式指定。还没建这个索引的库退回原查询，条件不变。
    let compatible = match validate(" INDEXED BY idx_rivermemo_validation") {
        Err(rusqlite::Error::SqliteFailure(_, Some(message)))
            if message.starts_with("no such index") => validate(""),
        other => other,
    }
    .map_err(|error| format!("Validate Memo artifact dependencies failed: {}", error))?;
    if !compatible {
        return Err("KNOWLEDGE_STORE_DERIVED_DEPENDENCY_CONFLICT: Memo artifact is incompatible (format, missing dependencies or version rollback)".to_string());
    }
    if let Some(artifact) = runtime.get(artifact_sig)? {
        return Ok(artifact);
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
            // 与旧逐候选实现保持行级故障隔离：单条脏记录不能拖垮
            // 整个候选批次；prepare/query 级数据库错误仍在上方显式返回。
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

    // 同一文件的 Tag 关系只读取一次，供该文件的全部候选 Chunk 复用；
    // Tag 向量在候选筛选之后才读取（见 attach_tags）。
    let file_ids: Vec<i64> = unique_file_ids.into_iter().collect();
    let mut relations: FileTagRows = HashMap::with_capacity(file_ids.len());
    let mut file_tag_sql_batches = 0usize;
    for batch in file_ids.chunks(SQLITE_BATCH_SIZE) {
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
            // 旧实现通过 rows.flatten() 跳过单条 Tag 行解码错误。
            // 批量化后保留同一容错边界，避免一条脏 Tag 污染整次查询。
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
    let sources = vec![
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

#[derive(Clone, Default, Serialize)]
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
        let direction = if forward + reverse > 0.0 {
            clamp01(forward / (forward + reverse))
        } else {
            clamp01(config.direction_floor)
        };
        let semantic_continuity = clamp01((cosine(&current.vector, &next.vector) + 1.0) / 2.0);
        let field_continuity = (local_potential.max(transfer_potential)
            * workspace
                .local
                .get(&next.id)
                .copied()
                .unwrap_or(0.0)
                .max(workspace.transfer.get(&next.id).copied().unwrap_or(0.0)))
        .sqrt();
        let continuity = clamp01(0.5 * semantic_continuity + 0.5 * field_continuity);
        let local_supported = workspace.local_domain.contains(&current.id)
            && workspace.local_domain.contains(&next.id);
        let transfer_supported = workspace.transfer_domain.contains(&current.id)
            && workspace.transfer_domain.contains(&next.id);
        let supported = (local_supported || transfer_supported) && (forward > 0.0 || reverse > 0.0);
        let weight_total = (config.local_weight + config.transfer_weight).max(1e-12);
        let potential = (config.local_weight * local_potential
            + config.transfer_weight * transfer_potential)
            / weight_total;
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
                && transfer_supported
                && (!local_supported || transfer_potential > local_potential),
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

#[derive(Clone, Default, Serialize)]
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
) -> TopologyOutput {
    let mut output = TopologyOutput {
        query_nodes: input.query_state.river_nodes.len(),
        ..TopologyOutput::default()
    };
    // Ordered by Tag ID so that `mean_closure` does not sum in hash order.
    let mut alignments = BTreeMap::new();
    let mut total_node_weight = 0.0;
    let mut matched_node_weight = 0.0;
    let mut node_quality_mass = 0.0;

    for node in &input.query_state.river_nodes {
        let weight = positive(if node.normalized_energy != 0.0 {
            node.normalized_energy
        } else {
            node.energy
        })
        .max(1e-9);
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

    for edge in retained_edges {
        let edge_weight = positive(if edge.normalized_flow != 0.0 {
            edge.normalized_flow
        } else {
            edge.flow
        })
        .max(1e-9);
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
        let source_hop = river_node_by_id
            .get(&edge.source_id)
            .map(|node| node.hop)
            .unwrap_or(0);
        let target_hop = river_node_by_id
            .get(&edge.target_id)
            .map(|node| node.hop)
            .unwrap_or(0);
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
    let thematic = clamp01(
        0.25 * local_coverage
            + 0.2 * transfer_coverage
            + 0.2 * clamp01(local_mean)
            + 0.15 * clamp01(transfer_mean)
            + 0.2 * dual_agreement,
    ) * (1.0 - 0.5 * clamp01(tail_ratio));
    let query_chunk = clamp01(cosine(&input.query.vector, &curve.chunk_vector));
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

#[derive(Clone)]
struct ScoredWork {
    curve: Curve,
    geometry: GeometryOutput,
    topology: TopologyOutput,
    observables: ObservableOutput,
    pure_score: f64,
    graph_score: f64,
    direct_evidence: f64,
    role: String,
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
                (
                    peer,
                    role_weight
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
        let expected = if total_weight > 1e-12 {
            peers
                .iter()
                .map(|entry| entry.1 * work[entry.0].graph_score)
                .sum::<f64>()
                / total_weight
        } else {
            work[index].graph_score
        };
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
        let (role_cap, multiplier) = match work[index].role.as_str() {
            "atomic_concept" => (config.topology_bonus_cap, 1.0),
            "direct_answer" => (0.02, 0.35),
            "structural_explanation" => (0.045, 0.7),
            _ => (0.008, 0.15),
        };
        let requested = innovation * combined_confidence * config.innovation_scale * multiplier;
        let mut bonus = requested.min(role_cap).min(config.topology_bonus_cap);
        if direct_frontier > 0.0 && work[index].role != "direct_answer" && mode != "atomic" {
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
        if promote && strongest.map(|entry| entry.0) == Some(index) {
            item.role = "direct_answer".to_string();
        } else if omega.omega < config.struct_role_min_omega
            && item.role == "structural_explanation"
        {
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
    let mut tag_vectors = TagVectorPool::new();
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
    let curve_load = load_curves(connection, &input.candidates, dimension)?;
    let mut curves = curve_load.curves;
    // 显式空集合也意味着无权限；必须在候选归一化和统计前移除越权项。
    let allowed: Option<HashSet<i64>> = input.allowed_file_ids.as_ref()
        .map(|ids| ids.iter().copied().collect());
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
    // Anchor hits count only Tags with a loadable vector, as when every candidate
    // Tag was loaded up front, so the local-domain Tags are checked now; the
    // other Tags are read only for the curves that survive selection.
    let file_tags = |curve: &Curve| curve_load.relations.get(&curve.file_id).into_iter().flatten();
    let domain_tag_ids: Vec<i64> = curves.iter().flat_map(file_tags)
        .map(|relation| relation.0).filter(|id| local_domain.contains(id)).collect();
    let domain_stats = ensure_tag_vectors_loaded(connection, &mut tag_vectors, &domain_tag_ids, dimension)?;
    compute_anchor_scores(&mut curves, |curve| file_tags(curve)
        .filter(|relation| local_domain.contains(&relation.0) && tag_vectors.contains_key(&relation.0))
        .count());
    curves.par_iter_mut().for_each(|curve| {
        curve.query_score = cosine(&input.query.vector, &curve.chunk_vector);
        curve.denoised_score = cosine(&input.denoised_vector, &curve.chunk_vector);
        curve.local_score = cosine(&input.local_vector, &curve.chunk_vector);
        curve.transfer_score = cosine(&input.transfer_vector, &curve.chunk_vector);
    });
    let projected_count = curves.len();
    let mut curves = select_superset(curves, &input.config);
    let selected_tag_ids: Vec<i64> = curves.iter().flat_map(file_tags).map(|relation| relation.0).collect();
    let selected_stats = ensure_tag_vectors_loaded(connection, &mut tag_vectors, &selected_tag_ids, dimension)?;
    attach_tags(&mut curves, &curve_load.relations, &tag_vectors);
    let selected_count = curves.len();

    let workspace = FieldWorkspace {
        local: normalize_field(&input.query_state.local_field),
        transfer: normalize_field(&input.query_state.transfer_field),
        local_domain,
        transfer_domain: input
            .query_state
            .transfer_domain_ids
            .iter()
            .copied()
            .collect(),
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
                &curve, &input, &artifact, &query_and_seed_tag_vectors, &cosines,
            );
            let visible = true; // 越权候选已在进入候选池前删除。
            let observables =
                evaluate_observables(&curve, &geometry, &input, &workspace, visible, &cosines);
            let semantic_total = (input.config.pure_query_weight
                + input.config.pure_local_weight
                + input.config.pure_transfer_weight)
                .max(1e-12);
            let semantic_base = clamp01(
                (input.config.pure_query_weight * clamp01(curve.query_score)
                    + input.config.pure_local_weight * clamp01(curve.local_score)
                    + input.config.pure_transfer_weight * clamp01(curve.transfer_score))
                    / semantic_total,
            );
            let topology_raw = clamp01(
                0.625 * geometry.path_quality
                    + 0.375
                        * clamp01(
                            0.35 * observables.local_coverage
                                + 0.25 * observables.transfer_coverage
                                + 0.25 * clamp01(observables.local_potential)
                                + 0.15 * clamp01(observables.transfer_potential),
                        ),
            );
            let path_reliability =
                clamp01(geometry.path_quality / input.config.topology_path_saturation.max(1e-6));
            let topology_reliability = (path_reliability * observables.query_chunk_score).sqrt();
            let topology_bonus =
                input.config.topology_bonus_cap * topology_raw * topology_reliability;
            let pure_score =
                clamp01(semantic_base + topology_bonus.min(input.config.topology_bonus_cap));
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
                role: String::new(),
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
}

#[cfg(test)]
mod validation_index_regression_tests {
    use super::*;

    const CONFLICT: &str = "KNOWLEDGE_STORE_DERIVED_DEPENDENCY_CONFLICT: Memo artifact is incompatible (format, missing dependencies or version rollback)";

    fn fixture() -> (Connection, MemoRuntime) {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE rivermemo_artifacts(
                artifact_sig TEXT PRIMARY KEY, schema_version TEXT, algorithm_version TEXT,
                payload_codec TEXT, payload_checksum TEXT, payload BLOB, status TEXT);
             CREATE TABLE kbm_artifact_dependencies(
                artifact_sig TEXT, dependency_key TEXT, dependency_version TEXT,
                PRIMARY KEY(artifact_sig,dependency_key));
             CREATE TABLE kbm_runtime_meta(key TEXT PRIMARY KEY,value TEXT);
             CREATE INDEX IF NOT EXISTS idx_rivermemo_validation
                ON rivermemo_artifacts(artifact_sig,status,algorithm_version,schema_version);
             INSERT INTO rivermemo_artifacts VALUES(
                'fixture','rivermemo-persisted-artifact-v2','memo.native-artifact-v2-binary',
                'bad-codec','checksum',zeroblob(1048576),'ready');
             INSERT INTO kbm_artifact_dependencies VALUES
                ('fixture','memo_tag_facts','7'),('fixture','derived_geometry','11');
             INSERT INTO kbm_runtime_meta VALUES ('memo_tag_facts','7'),('derived_geometry','11');"
        ).unwrap();
        let runtime = MemoRuntime::new();
        runtime.publish("fixture", Arc::new(NativeArtifact::default())).unwrap();
        (connection, runtime)
    }

    #[test]
    fn every_validation_branch_keeps_exact_errors_on_warm_and_cold_assets() {
        let cases = [
            ("ready", "", "fixture", true),
            ("missing asset", "DELETE FROM rivermemo_artifacts", "fixture", false),
            ("wrong signature", "", "absent", false),
            ("pending", "UPDATE rivermemo_artifacts SET status='building'", "fixture", false),
            ("failed", "UPDATE rivermemo_artifacts SET status='failed'", "fixture", false),
            ("algorithm", "UPDATE rivermemo_artifacts SET algorithm_version='old'", "fixture", false),
            ("schema", "UPDATE rivermemo_artifacts SET schema_version='old'", "fixture", false),
            ("missing dependency", "DELETE FROM kbm_artifact_dependencies WHERE dependency_key='memo_tag_facts'", "fixture", false),
            ("extra dependency", "INSERT INTO kbm_artifact_dependencies VALUES('fixture','extra','0')", "fixture", false),
            ("wrong dependency", "UPDATE kbm_artifact_dependencies SET dependency_key='other' WHERE dependency_key='memo_tag_facts'", "fixture", false),
            ("missing meta", "DELETE FROM kbm_runtime_meta WHERE key='memo_tag_facts'", "fixture", false),
            ("null meta", "UPDATE kbm_runtime_meta SET value=NULL WHERE key='derived_geometry'", "fixture", false),
            ("tag rollback", "UPDATE kbm_runtime_meta SET value='6' WHERE key='memo_tag_facts'", "fixture", false),
            ("geometry rollback", "UPDATE kbm_runtime_meta SET value='10' WHERE key='derived_geometry'", "fixture", false),
            ("advanced generations", "UPDATE kbm_runtime_meta SET value='99'", "fixture", true),
            ("numeric cast", "UPDATE kbm_runtime_meta SET value='11x' WHERE key='derived_geometry'", "fixture", true),
            ("unrelated dependency", "INSERT INTO kbm_artifact_dependencies VALUES('other','extra','0')", "fixture", true),
        ];
        for (name, mutation, signature, valid) in cases {
            for cold in [false, true] {
                let (connection, runtime) = fixture();
                connection.execute_batch(mutation).unwrap();
                if cold { runtime.clear().unwrap(); }
                let result = load_artifact_with_connection(&runtime, &connection, signature).map(|_| ());
                if !valid {
                    assert_eq!(result.unwrap_err(), CONFLICT, "{name}, cold={cold}");
                } else if cold {
                    assert_eq!(result.unwrap_err(), "unsupported RiverMemo artifact codec: bad-codec", "{name}");
                } else {
                    assert!(result.is_ok(), "{name}: {result:?}");
                }
            }
        }
        let (connection, runtime) = fixture();
        connection.execute_batch("DROP TABLE kbm_artifact_dependencies").unwrap();
        let error = load_artifact_with_connection(&runtime, &connection, "fixture").err().unwrap();
        assert_eq!(error, "Validate Memo artifact dependencies failed: no such table: kbm_artifact_dependencies");
    }

    #[test]
    fn a_database_without_the_index_falls_back_to_the_plain_query() {
        let cases = [
            ("ready", "", true),
            ("pending", "UPDATE rivermemo_artifacts SET status='building'", false),
            ("tag rollback", "UPDATE kbm_runtime_meta SET value='6' WHERE key='memo_tag_facts'", false),
        ];
        for (name, mutation, valid) in cases {
            let (connection, runtime) = fixture();
            connection.execute_batch("DROP INDEX idx_rivermemo_validation").unwrap();
            connection.execute_batch(mutation).unwrap();
            let result = load_artifact_with_connection(&runtime, &connection, "fixture").map(|_| ());
            if valid {
                assert!(result.is_ok(), "{name}: {result:?}");
            } else {
                assert_eq!(result.unwrap_err(), CONFLICT, "{name}");
            }
        }
        let (connection, runtime) = fixture();
        connection.execute_batch("DROP INDEX idx_rivermemo_validation; DROP TABLE kbm_artifact_dependencies").unwrap();
        let error = load_artifact_with_connection(&runtime, &connection, "fixture").err().unwrap();
        assert_eq!(error, "Validate Memo artifact dependencies failed: no such table: kbm_artifact_dependencies");
    }

    #[test]
    fn a_separate_connection_invalidates_an_already_cached_asset() {
        let path = std::env::temp_dir().join(format!("validation-index-{}.sqlite", std::process::id()));
        let (connection, runtime) = fixture();
        connection.execute("VACUUM INTO ?1", [path.to_str().unwrap()]).unwrap();
        let reader = Connection::open(&path).unwrap();
        let writer = Connection::open(&path).unwrap();
        assert!(load_artifact_with_connection(&runtime, &reader, "fixture").is_ok());
        writer.execute("UPDATE rivermemo_artifacts SET status='failed'", []).unwrap();
        assert_eq!(load_artifact_with_connection(&runtime, &reader, "fixture").err().unwrap(), CONFLICT);
        writer.execute("UPDATE rivermemo_artifacts SET status='ready'", []).unwrap();
        writer.execute("UPDATE kbm_runtime_meta SET value='0' WHERE key='memo_tag_facts'", []).unwrap();
        assert_eq!(load_artifact_with_connection(&runtime, &reader, "fixture").err().unwrap(), CONFLICT);
        drop(writer); drop(reader);
        std::fs::remove_file(path).unwrap();
    }
}

#[cfg(test)]
mod cold_load_tests {
    use super::*;
    use std::io::Write;

    const NODES: i64 = 3000;

    /// A valid payload: a ring CSR with 8 edges per node and two provenance
    /// contributions per edge.
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
            // A query that decoded on its own would return its own allocation.
            let active = runtime.get("fixture").unwrap().unwrap();
            for artifact in &loaded {
                assert!(Arc::ptr_eq(artifact, &active), "round {round}: more than one decode");
            }
            assert_eq!(active.provenance.len(), NODES as usize);
        }
        std::fs::remove_file(path).unwrap();
    }
}
