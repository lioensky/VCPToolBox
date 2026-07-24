use flate2::read::GzDecoder;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use rayon::prelude::*;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::memo_sensing::SenseOutput;

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
    if left_norm > 1e-15 && right_norm > 1e-15 {
        dot / (left_norm.sqrt() * right_norm.sqrt())
    } else {
        0.0
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
    local_vector: Vec<f32>,
    transfer_vector: Vec<f32>,
    #[serde(default)]
    candidates: Vec<CandidateInput>,
    query_state: QueryStateInput,
    #[serde(default)]
    allowed_file_ids: Vec<i64>,
    #[serde(default)]
    config: NativeConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryInput {
    #[serde(default)]
    text: String,
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
}

impl NativeArtifact {
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
/// 该对象只包含请求相关的小型河网和两条查询向量，不复制全库图或 Tag 向量。
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
}

struct MemoQueryCacheEntry {
    value: Arc<MemoQueryObservation>,
    inserted_at: Instant,
}

/// VexusIndex 实例拥有的统一 Memo 原生运行时。
///
/// 活动资产使用 Arc 快照：查询开始时克隆一次 Arc，后续发布不会改变本次查询；
/// 旧代资产在最后一个查询释放后自动回收。请求观测缓存与活动资产代际绑定，
/// 让 DTSC 与 Topology V3 直接复用统一管线产物，避免河网经 JS JSON 往返。
pub(crate) struct MemoRuntime {
    active_artifact: RwLock<Option<(String, u64, Arc<NativeArtifact>)>>,
    generation: AtomicU64,
    query_sequence: AtomicU64,
    query_cache: Mutex<HashMap<String, MemoQueryCacheEntry>>,
    query_cache_order: Mutex<VecDeque<String>>,
    query_cache_capacity: usize,
    query_cache_ttl: Duration,
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
        let generation = self.generation.fetch_add(1, AtomicOrdering::AcqRel) + 1;
        let mut guard = self
            .active_artifact
            .write()
            .map_err(|error| format!("memo runtime publish lock failed: {}", error))?;
        *guard = Some((artifact_sig.to_string(), generation, artifact));
        drop(guard);
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

    pub(crate) fn clear(&self) -> std::result::Result<(), String> {
        let mut guard = self
            .active_artifact
            .write()
            .map_err(|error| format!("memo runtime clear lock failed: {}", error))?;
        *guard = None;
        drop(guard);
        self.clear_query_cache()
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

/// 旧模块级 N-API ABI 的兼容缓存。生产路径改由 VexusIndex.memo_runtime 持有，
/// 只有尚未升级的外部调用方才会进入这里。
static LEGACY_ARTIFACT_CACHE: OnceLock<Mutex<HashMap<String, Arc<NativeArtifact>>>> =
    OnceLock::new();

fn legacy_artifact_cache() -> &'static Mutex<HashMap<String, Arc<NativeArtifact>>> {
    LEGACY_ARTIFACT_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn open_readonly(path: &str) -> std::result::Result<Connection, String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("open readonly SQLite failed: {}", error))?;
    connection
        .busy_timeout(Duration::from_secs(30))
        .map_err(|error| format!("configure SQLite timeout failed: {}", error))?;
    connection
        .pragma_update(None, "query_only", "ON")
        .map_err(|error| format!("configure SQLite query_only failed: {}", error))?;
    Ok(connection)
}

fn decode_artifact(
    db_path: &str,
    artifact_sig: &str,
) -> std::result::Result<Arc<NativeArtifact>, String> {
    const MAX_DECOMPRESSED_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;

    let connection = open_readonly(db_path)?;
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

    let payload: Value = serde_json::from_slice(&raw)
        .map_err(|error| format!("decode RiverMemo artifact JSON failed: {}", error))?;

    let transport = payload
        .get("sharedTransport")
        .ok_or_else(|| "RiverMemo artifact has no sharedTransport".to_string())?;
    let node_ids: Vec<i64> = serde_json::from_value(
        transport
            .get("nodeIds")
            .cloned()
            .unwrap_or(Value::Array(Vec::new())),
    )
    .map_err(|error| format!("decode transport nodeIds failed: {}", error))?;
    let row_offsets_u64: Vec<u64> = serde_json::from_value(
        transport
            .get("rowOffsets")
            .cloned()
            .unwrap_or(Value::Array(Vec::new())),
    )
    .map_err(|error| format!("decode transport rowOffsets failed: {}", error))?;
    let targets_u64: Vec<u64> = serde_json::from_value(
        transport
            .get("targetIndices")
            .cloned()
            .unwrap_or(Value::Array(Vec::new())),
    )
    .map_err(|error| format!("decode transport targets failed: {}", error))?;
    let weights: Vec<f64> = serde_json::from_value(
        transport
            .get("weights")
            .cloned()
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
    if let Some(edges) = payload
        .get("provenanceView")
        .and_then(|value| value.get("edges"))
        .and_then(Value::as_array)
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
                    let Some(values) = row.as_array() else {
                        continue;
                    };
                    if values.len() >= 4 {
                        if let (Some(file_id), Some(mass)) =
                            (values[0].as_i64(), values[3].as_f64())
                        {
                            contributions.push((file_id, positive(mass)));
                        }
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
    }))
}

fn load_artifact_legacy(
    db_path: &str,
    artifact_sig: &str,
) -> std::result::Result<Arc<NativeArtifact>, String> {
    if let Some(cached) = legacy_artifact_cache()
        .lock()
        .map_err(|error| format!("legacy artifact cache lock failed: {}", error))?
        .get(artifact_sig)
        .cloned()
    {
        return Ok(cached);
    }

    let artifact = decode_artifact(db_path, artifact_sig)?;
    let mut cache = legacy_artifact_cache()
        .lock()
        .map_err(|error| format!("legacy artifact cache lock failed: {}", error))?;
    cache.clear();
    cache.insert(artifact_sig.to_string(), artifact.clone());
    Ok(artifact)
}

pub(crate) fn load_artifact_from_runtime(
    runtime: &MemoRuntime,
    db_path: &str,
    artifact_sig: &str,
) -> std::result::Result<Arc<NativeArtifact>, String> {
    if let Some(artifact) = runtime.get(artifact_sig)? {
        return Ok(artifact);
    }

    // 解码和校验在写锁外完成；发布临界区只替换 Arc。
    let staging = decode_artifact(db_path, artifact_sig)?;
    runtime.publish(artifact_sig, staging.clone())?;
    Ok(staging)
}

#[derive(Clone)]
struct TagData {
    id: i64,
    name: String,
    position: i64,
    vector: Vec<f32>,
    chunk_cosine: f64,
}

#[derive(Clone)]
struct Curve {
    id: i64,
    file_id: i64,
    tags: Vec<TagData>,
    chunk_vector: Vec<f32>,
    query_score: f64,
    denoised_score: f64,
    local_score: f64,
    transfer_score: f64,
    bm25_score: f64,
    anchor_score: f64,
    union_score: f64,
    union_rank: usize,
    sources: Vec<String>,
}

fn load_curves(
    db_path: &str,
    candidates: &[CandidateInput],
    dimension: usize,
) -> std::result::Result<Vec<Curve>, String> {
    let connection = open_readonly(db_path)?;
    let mut chunk_stmt = connection
        .prepare("SELECT id, file_id, vector FROM chunks WHERE id = ?1")
        .map_err(|error| format!("prepare chunk projection failed: {}", error))?;
    let mut tag_stmt = connection
        .prepare(
            "SELECT ft.tag_id, COALESCE(ft.position, 0), t.name, t.vector \
             FROM file_tags ft JOIN tags t ON t.id = ft.tag_id \
             WHERE ft.file_id = ?1 ORDER BY ft.position, ft.tag_id",
        )
        .map_err(|error| format!("prepare tag curve projection failed: {}", error))?;

    let mut curves = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let row = chunk_stmt.query_row(rusqlite::params![candidate.id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ))
        });
        let Ok((id, file_id, chunk_bytes)) = row else {
            continue;
        };
        let Some(chunk_vector) = decode_vector(&chunk_bytes, dimension) else {
            continue;
        };
        let rows = tag_stmt
            .query_map(rusqlite::params![file_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                ))
            })
            .map_err(|error| format!("query candidate tag curve failed: {}", error))?;
        let mut tags = Vec::new();
        for row in rows.flatten() {
            if let Some(vector) = decode_vector(&row.3, dimension) {
                let chunk_cosine = clamp01(cosine(&vector, &chunk_vector));
                tags.push(TagData {
                    id: row.0,
                    position: row.1,
                    name: row.2,
                    vector,
                    chunk_cosine,
                });
            }
        }
        curves.push(Curve {
            id,
            file_id,
            tags,
            chunk_vector,
            query_score: 0.0,
            denoised_score: 0.0,
            local_score: 0.0,
            transfer_score: 0.0,
            bm25_score: positive(candidate.bm25_score),
            anchor_score: positive(candidate.anchor_score),
            union_score: 0.0,
            union_rank: 0,
            sources: Vec::new(),
        });
    }
    Ok(curves)
}

fn compute_anchor_scores(curves: &mut [Curve], local_domain: &HashSet<i64>) {
    if local_domain.is_empty() {
        return;
    }
    let max_hits = curves
        .iter()
        .map(|curve| {
            curve
                .tags
                .iter()
                .filter(|tag| local_domain.contains(&tag.id))
                .count()
        })
        .max()
        .unwrap_or(0);
    if max_hits == 0 {
        return;
    }
    for curve in curves {
        let hits = curve
            .tags
            .iter()
            .filter(|tag| local_domain.contains(&tag.id))
            .count();
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
    query_tag_vectors: &HashMap<i64, Vec<f32>>,
) -> TopologyOutput {
    let mut output = TopologyOutput {
        query_nodes: input.query_state.river_nodes.len(),
        ..TopologyOutput::default()
    };
    let mut alignments = HashMap::new();
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
                        .map(|vector| clamp01(cosine(vector, &tag.vector)))
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
            .max((clamp01(cosine(&input.query.vector, &tag.vector)) * tag.chunk_cosine).sqrt());
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
    seed_vectors: &HashMap<i64, Vec<f32>>,
    config: &NativeConfig,
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
            .map(|tag| (tag, cosine(seed_vector, &tag.vector)))
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
    seed_vectors: &HashMap<i64, Vec<f32>>,
    artifact: &NativeArtifact,
    config: &NativeConfig,
    fallback: bool,
) -> Vec<AnchorOutput> {
    let contacts: Vec<Vec<(i64, i64, bool, f64, f64, f64)>> = curves
        .par_iter()
        .map(|curve| anchor_contacts(curve, seeds, seed_vectors, config))
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

fn query_mode(text: &str) -> &'static str {
    let relation_signals = [
        "导致", "造成", "因为", "所以", "通过", "依赖", "属于", "定义", "源于", "关系", "->", "→",
    ]
    .iter()
    .filter(|token| text.contains(**token))
    .count();
    let narrative_signals = [
        "随后", "之后", "此前", "最终", "阶段", "过程", "历史", "事件", "然后", "演变",
    ]
    .iter()
    .filter(|token| text.contains(**token))
    .count();
    let clauses = text
        .split(['，', ',', '。', '；', ';', '！', '？', '\n'])
        .filter(|value| !value.trim().is_empty())
        .count();
    if text.chars().count() <= 28 && clauses <= 1 && relation_signals == 0 {
        "atomic"
    } else if text.chars().count() >= 90
        || clauses >= 4
        || narrative_signals >= 2
        || relation_signals >= 3
    {
        "narrative"
    } else {
        "propositional"
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
    results: Vec<NativeResultItem>,
    diagnostics: NativeDiagnostics,
}

fn run_native(
    runtime: Option<&MemoRuntime>,
    db_path: &str,
    artifact_sig: &str,
    input_json: &str,
) -> std::result::Result<String, String> {
    let total_started = Instant::now();
    let mut input: NativeInput = serde_json::from_str(input_json)
        .map_err(|error| format!("invalid RiverMemo native input JSON: {}", error))?;
    if let (Some(runtime), Some(handle)) = (runtime, input.observation_handle.as_deref()) {
        let cached = runtime.get_query_observation(handle, artifact_sig)?;
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
    let artifact = match runtime {
        Some(runtime) => load_artifact_from_runtime(runtime, db_path, artifact_sig)?,
        None => load_artifact_legacy(db_path, artifact_sig)?,
    };
    let mut curves = load_curves(db_path, &input.candidates, dimension)?;
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
    compute_anchor_scores(&mut curves, &local_domain);
    curves.par_iter_mut().for_each(|curve| {
        curve.query_score = cosine(&input.query.vector, &curve.chunk_vector);
        curve.denoised_score = cosine(&input.denoised_vector, &curve.chunk_vector);
        curve.local_score = cosine(&input.local_vector, &curve.chunk_vector);
        curve.transfer_score = cosine(&input.transfer_vector, &curve.chunk_vector);
    });
    let projected_count = curves.len();
    let curves = select_superset(curves, &input.config);
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
    let connection = open_readonly(db_path)?;
    let river_ids: Vec<i64> = input
        .query_state
        .river_nodes
        .iter()
        .map(|node| node.id)
        .collect();
    let mut query_tag_vectors = HashMap::new();
    if !river_ids.is_empty() {
        let mut statement = connection
            .prepare("SELECT vector FROM tags WHERE id = ?1")
            .map_err(|error| format!("prepare query river vector read failed: {}", error))?;
        for id in river_ids {
            if let Ok(bytes) =
                statement.query_row(rusqlite::params![id], |row| row.get::<_, Vec<u8>>(0))
            {
                if let Some(vector) = decode_vector(&bytes, dimension) {
                    query_tag_vectors.insert(id, vector);
                }
            }
        }
    }

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
    let mut seed_vectors = HashMap::new();
    let mut statement = connection
        .prepare("SELECT vector FROM tags WHERE id = ?1")
        .map_err(|error| format!("prepare anchor vector read failed: {}", error))?;
    for seed in &seeds {
        if let Ok(bytes) =
            statement.query_row(rusqlite::params![seed.0], |row| row.get::<_, Vec<u8>>(0))
        {
            if let Some(vector) = decode_vector(&bytes, dimension) {
                seed_vectors.insert(seed.0, vector);
            }
        }
    }
    drop(statement);
    drop(connection);
    let load_ms = load_started.elapsed().as_secs_f64() * 1000.0;

    let compute_started = Instant::now();
    let allowed: HashSet<i64> = input.allowed_file_ids.iter().copied().collect();
    let explicit_scope = !allowed.is_empty();
    let mut work: Vec<ScoredWork> = curves
        .par_iter()
        .map(|curve| {
            let geometry = evaluate_path(curve, &workspace, &artifact, &input.config);
            let topology = evaluate_topology(curve, &input, &artifact, &query_tag_vectors);
            let visible = !explicit_scope || allowed.contains(&curve.file_id);
            let observables = evaluate_observables(curve, &geometry, &input, &workspace, visible);
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
            let mode = query_mode(&input.query.text);
            let graph_score = if mode == "atomic" {
                clamp01(0.75 * topology.node_graph_score + 0.25 * topology.edge_graph_score)
            } else if mode == "narrative" {
                clamp01(0.15 * topology.node_graph_score + 0.85 * topology.edge_graph_score)
            } else {
                clamp01(0.25 * topology.node_graph_score + 0.75 * topology.edge_graph_score)
            };
            ScoredWork {
                curve: curve.clone(),
                geometry,
                topology,
                direct_evidence: observables.semantic_boundary_score.max(observables.direct),
                observables,
                pure_score,
                graph_score,
                role: String::new(),
                anchor: AnchorOutput::default(),
                v2_bonus: 0.0,
                gated_bonus: 0.0,
                anchor_bonus: 0.0,
                final_score: 0.0,
            }
        })
        .collect();

    let anchor_results = compute_anchors(
        &curves,
        &seeds,
        &seed_vectors,
        &artifact,
        &input.config,
        fallback_anchor,
    );
    for (item, anchor) in work.iter_mut().zip(anchor_results) {
        item.anchor = anchor;
    }

    let omega = compute_omega(&input);
    let mode = query_mode(&input.query.text);
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

    let results: Vec<NativeResultItem> = work
        .into_iter()
        .take(input.top_k.max(1))
        .enumerate()
        .map(|(index, item)| {
            let matched_tags: Vec<String> = item
                .curve
                .tags
                .iter()
                .map(|tag| tag.name.clone())
                .collect::<HashSet<_>>()
                .into_iter()
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
        },
        results,
    };
    serde_json::to_string(&output)
        .map_err(|error| format!("encode RiverMemo native output failed: {}", error))
}

pub struct RiverMemoTopologyV3Task {
    runtime: Option<Arc<MemoRuntime>>,
    db_path: String,
    artifact_sig: String,
    input_json: String,
}

impl Task for RiverMemoTopologyV3Task {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        run_native(
            self.runtime.as_deref(),
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

/// RiverMemo Topology V3 原生异步入口。
///
/// N-API 只提交一次后台任务；SQLite 投影、候选几何与批级评分均在 Rust
/// 工作线程内完成，候选级热点由 Rayon 并行，不占用 Node.js 事件循环。
#[napi]
pub fn rerank_rivermemo_topology_v3(
    db_path: String,
    artifact_sig: String,
    input_json: String,
) -> AsyncTask<RiverMemoTopologyV3Task> {
    AsyncTask::new(RiverMemoTopologyV3Task {
        runtime: None,
        db_path,
        artifact_sig,
        input_json,
    })
}

pub(crate) fn rerank_with_runtime(
    runtime: Arc<MemoRuntime>,
    db_path: String,
    artifact_sig: String,
    input_json: String,
) -> AsyncTask<RiverMemoTopologyV3Task> {
    AsyncTask::new(RiverMemoTopologyV3Task {
        runtime: Some(runtime),
        db_path,
        artifact_sig,
        input_json,
    })
}

#[napi]
pub fn clear_rivermemo_topology_v3_cache() -> Result<()> {
    legacy_artifact_cache()
        .lock()
        .map_err(|error| {
            Error::from_reason(format!("legacy artifact cache lock failed: {}", error))
        })?
        .clear();
    Ok(())
}
