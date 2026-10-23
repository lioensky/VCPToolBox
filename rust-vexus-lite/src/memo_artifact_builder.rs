use crate::rivermemo_topology_v3::{MemoRuntime, NativeArtifact};
use crate::storage::{with_registered_read_transaction, with_registered_write};
use flate2::write::GzEncoder;
use flate2::Compression;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, Connection, OptionalExtension};
use serde::ser::SerializeMap;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io::Write;
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

const PAYLOAD_SCHEMA: &str = "rivermemo-persisted-artifact-v2";
const PAYLOAD_CODEC: &str = "gzip-json-v1";
const ALGORITHM_VERSION: &str = "memo.native-artifact-v2-binary";
const V9_ALGORITHM_VERSION: &str = "v9.1-rust-native";

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct BuildInput {
    #[serde(default)]
    model_sig: String,
    #[serde(default)]
    effective_config: Value,
}

#[derive(Clone)]
struct FileTag {
    file_id: i64,
    tag_id: i64,
    position: i64,
}

#[derive(Clone)]
struct ProvenanceContribution {
    file_id: i64,
    mass: f64,
}

#[napi(object)]
pub struct NativeMemoArtifactBuildResult {
    pub success: bool,
    pub artifact_sig: String,
    pub source_artifact_sig: String,
    pub graph_generation: String,
    pub database_generation: String,
    pub provenance_generation: String,
    pub generation: i64,
    pub node_count: u32,
    pub edge_count: u32,
    pub persisted: bool,
    pub resident: bool,
    pub elapsed_ms: f64,
    pub phase_summary: String,
    pub raw_bytes: u32,
    pub compressed_bytes: u32,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn hash_text(value: &str, length: usize) -> String {
    let digest = sha256_hex(value.as_bytes());
    digest[..length.min(digest.len())].to_string()
}

fn number(config: &Value, path: &[&str], fallback: f64) -> f64 {
    let mut current = config;
    for key in path {
        let Some(next) = current.get(*key) else {
            return fallback;
        };
        current = next;
    }
    current
        .as_f64()
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
}

fn boolean(config: &Value, path: &[&str], fallback: bool) -> bool {
    let mut current = config;
    for key in path {
        let Some(next) = current.get(*key) else {
            return fallback;
        };
        current = next;
    }
    match current {
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_i64().map(|item| item != 0).unwrap_or(fallback),
        _ => fallback,
    }
}

fn load_file_tags(connection: &Connection) -> std::result::Result<Vec<FileTag>, String> {
    let mut statement = connection
        .prepare(
            "SELECT ft.file_id, ft.tag_id, COALESCE(ft.position, 0) \
             FROM file_tags ft JOIN files f ON f.id = ft.file_id \
             ORDER BY ft.file_id, ft.position ASC, ft.tag_id ASC",
        )
        .map_err(|error| format!("prepare file_tags failed: {}", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(FileTag {
                file_id: row.get(0)?,
                tag_id: row.get(1)?,
                position: row.get(2)?,
            })
        })
        .map_err(|error| format!("query file_tags failed: {}", error))?;
    let mut output = Vec::new();
    for row in rows {
        output.push(row.map_err(|error| format!("decode file_tags row failed: {}", error))?);
    }
    Ok(output)
}


fn load_anchor_gains(
    connection: &Connection,
    model_sig: &str,
) -> std::result::Result<(HashMap<i64, f64>, HashMap<i64, f64>, String), String> {
    let mut statement = connection
        .prepare(
            "SELECT tag_id, COALESCE(v9_anchor_gain, residual_energy, 1.0), \
             COALESCE(raw_residual_ratio, 0.0), COALESCE(artifact_sig, '') \
             FROM tag_intrinsic_residuals WHERE model_sig = ?1 ORDER BY tag_id",
        )
        .map_err(|error| format!("prepare intrinsic residuals failed: {}", error))?;
    let rows = statement
        .query_map(params![model_sig], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|error| format!("query intrinsic residuals failed: {}", error))?;
    let mut gains = HashMap::new();
    let mut raw = HashMap::new();
    let geometry = connection.query_row(
        "SELECT artifact_sig,graph_generation FROM tagmemo_artifacts
         WHERE asset_type='unified_geometry' AND model_sig=?1 AND status='ready'
         ORDER BY updated_at DESC LIMIT 1",
        [model_sig], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    ).optional().map_err(|e| e.to_string())?;
    let signature = if let Some((signature, generation)) = geometry {
        let facts: String = connection.query_row(
            "SELECT value FROM kbm_runtime_meta WHERE key='memo_tag_facts'", [], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if generation != format!("facts:{facts}") {
            return Err("KNOWLEDGE_STORE_DERIVED_DEPENDENCY_CONFLICT: geometry facts are stale".into());
        }
        signature
    } else { String::new() };
    for row in rows {
        let (tag_id, gain, raw_residual, _artifact_sig) =
            row.map_err(|error| format!("decode intrinsic residual row failed: {}", error))?;
        if !gain.is_finite() || !raw_residual.is_finite() {
            return Err(format!(
                "intrinsic residual row for Tag {} contains non-finite values",
                tag_id
            ));
        }
        gains.insert(tag_id, gain.clamp(0.5, 2.0));
        raw.insert(tag_id, raw_residual.clamp(0.0, 1.0));
    }
    Ok((gains, raw, signature))
}

/// Stable grouping keeps every key's original floating-point addition order.
/// Compact in place after sorting; the first addition still starts at +0.0.
fn stable_sums<K: Ord + Copy>(mut entries: Vec<(K, f64)>) -> Vec<(K, f64)> {
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let mut write = 0usize;
    for read in 0..entries.len() {
        let (key, value) = entries[read];
        if write > 0 && entries[write - 1].0 == key {
            entries[write - 1].1 += value;
        } else {
            let mut sum = 0.0;
            sum += value;
            entries[write] = (key, sum);
            write += 1;
        }
    }
    entries.truncate(write);
    entries
}

fn add_edge(matrix: &mut Vec<((i64, i64), f64)>, source: i64, target: i64, weight: f64) {
    if source == target || !weight.is_finite() || weight <= 0.0 {
        return;
    }
    matrix.push(((source, target), weight));
}

/// Unit vectors of one build snapshot, keyed by Tag ID.
trait UnitVectors: Sync {
    fn unit_vector(&self, id: i64) -> Option<&[f64]>;
}

impl UnitVectors for crate::memo_geometry::UnitVectorWorkspace {
    fn unit_vector(&self, id: i64) -> Option<&[f64]> {
        self.get(&id)
    }
}

impl UnitVectors for HashMap<i64, Vec<f64>> {
    fn unit_vector(&self, id: i64) -> Option<&[f64]> {
        self.get(&id).map(Vec::as_slice)
    }
}

fn semantic_gain_enabled(config: &Value) -> bool {
    let ordered = config.get("orderedCooccurrence").unwrap_or(&Value::Null);
    boolean(ordered, &["semanticGainEnabled"], false)
        || boolean(ordered, &["semanticGain", "enabled"], false)
}

/// Tags of the files that contribute cooccurrence (2 to 100 Tags), sorted.
fn cooccurrence_tag_ids(rows: &[FileTag]) -> Vec<i64> {
    let mut ids = Vec::new();
    let mut offset = 0usize;
    while offset < rows.len() {
        let mut end = offset + 1;
        while end < rows.len() && rows[end].file_id == rows[offset].file_id {
            end += 1;
        }
        if end - offset >= 2 && end - offset <= 100 {
            ids.extend(rows[offset..end].iter().map(|tag| tag.tag_id));
        }
        offset = end;
    }
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// Enumerate pairs in first-occurrence order, retaining operand orientation.
/// The set is used only for membership, never for iteration or arithmetic.
fn semantic_pairs(rows: &[FileTag]) -> Vec<(i64, i64)> {
    let mut seen = HashSet::new();
    let mut pairs = Vec::new();
    let mut offset = 0;
    while offset < rows.len() {
        let mut end = offset + 1;
        while end < rows.len() && rows[end].file_id == rows[offset].file_id {
            end += 1;
        }
        let tags = &rows[offset..end];
        if (2..=100).contains(&tags.len()) {
            for (i, left) in tags.iter().enumerate() {
                for right in &tags[i + 1..] {
                    let key = (left.tag_id.min(right.tag_id), left.tag_id.max(right.tag_id));
                    if left.tag_id != right.tag_id && seen.insert(key) {
                        pairs.push((left.tag_id, right.tag_id));
                    }
                }
            }
        }
        offset = end;
    }
    pairs
}

fn configured_build_threads(value: Option<&str>, available: usize) -> usize {
    value.and_then(|text| text.parse::<usize>().ok()).filter(|&n| n > 0)
        .unwrap_or_else(|| available.clamp(1, 8))
}

fn evaluate_pair_gains(
    pairs: &[(i64, i64)],
    gain: &(impl Fn(i64, i64) -> f64 + Sync),
    threads: usize,
) -> Vec<f64> {
    if threads > 1 && !pairs.is_empty() {
        if let Ok(pool) = rayon::ThreadPoolBuilder::new().num_threads(threads).build() {
            use rayon::prelude::*;
            return pool.install(|| pairs.par_iter().map(|&(a, b)| gain(a, b)).collect());
        }
    }
    pairs.iter().map(|&(a, b)| gain(a, b)).collect()
}

fn build_fact_matrix(
    rows: &[FileTag],
    vectors: &dyn UnitVectors,
    anchor_gain: &HashMap<i64, f64>,
    config: &Value,
) -> std::result::Result<HashMap<i64, HashMap<i64, f64>>, String> {
    let ordered = config.get("orderedCooccurrence").unwrap_or(&Value::Null);
    let forward_gain = number(ordered, &["forwardGain"], 1.0).max(0.0);
    let reverse_gain = number(ordered, &["reverseGain"], 0.42).clamp(
        number(ordered, &["minReverseGain"], 0.25),
        number(ordered, &["maxReverseGain"], 0.70),
    );
    let distance_decay = number(ordered, &["distanceDecay"], 0.0).max(0.0);
    let reverse_guard = number(ordered, &["reverseInversionGuard"], 0.95).clamp(0.0, 1.0);
    let reverse_anchor_enabled = boolean(ordered, &["reverseAnchorBoost"], false);
    let reverse_anchor_max = number(ordered, &["reverseAnchorMax"], 1.5).max(1.0);
    let semantic_enabled = semantic_gain_enabled(config);
    let semantic_peak = number(
        ordered,
        &["semanticGainPeak"],
        number(ordered, &["semanticGain", "peak"], 0.65),
    );
    let semantic_sigma = number(
        ordered,
        &["semanticGainSigma"],
        number(ordered, &["semanticGain", "sigma"], 0.25),
    )
    .max(0.001);
    let low_fallback = number(
        ordered,
        &["semanticGainLowSimFallback"],
        number(ordered, &["semanticGain", "lowSimFallback"], 0.1),
    );

    let semantic_gain = |left: i64, right: i64| -> f64 {
        if !semantic_enabled {
            return 1.0;
        }
        let similarity = vectors.unit_vector(left).zip(vectors.unit_vector(right))
            .map(|(a,b)| crate::memo_geometry::dot(a,b).clamp(-1.0,1.0))
            .unwrap_or(low_fallback);
        if similarity < 0.15 {
            0.4 + similarity * 1.0
        } else {
            0.5 + 0.8
                * (-((similarity - semantic_peak).powi(2))
                    / (2.0 * semantic_sigma * semantic_sigma))
                    .exp()
        }
    };

    // One gain per unordered Tag pair. `dot` multiplies the same two vectors in
    // the same index order whichever comes first, so the stored value has the
    // bits every later file would compute. Bounded by the number of fact pairs.
    let pair_gains: HashMap<(i64, i64), f64> = if semantic_enabled {
        let pairs = semantic_pairs(rows);
        let available = std::thread::available_parallelism().map_or(1, usize::from);
        let threads = configured_build_threads(std::env::var("VCP_MEMO_BUILD_THREADS").ok().as_deref(), available);
        let gains = evaluate_pair_gains(&pairs, &semantic_gain, threads);
        pairs.into_iter().zip(gains).map(|((a, b), gain)| ((a.min(b), a.max(b)), gain)).collect()
    } else {
        HashMap::new()
    };
    let mut matrix = Vec::new();
    let mut offset = 0usize;
    while offset < rows.len() {
        let file_id = rows[offset].file_id;
        let mut end = offset + 1;
        while end < rows.len() && rows[end].file_id == file_id {
            end += 1;
        }
        let tags = &rows[offset..end];
        if tags.len() >= 2 && tags.len() <= 100 {
            for left_index in 0..tags.len() {
                for right_index in (left_index + 1)..tags.len() {
                    let left = &tags[left_index];
                    let right = &tags[right_index];
                    if left.tag_id == right.tag_id {
                        continue;
                    }
                    let semantic = if semantic_enabled {
                        let pair = (left.tag_id.min(right.tag_id), left.tag_id.max(right.tag_id));
                        pair_gains[&pair]
                    } else {
                        1.0
                    };
                    if left.position > 0 && right.position > 0 {
                        let count = tags.len() as f64;
                        let phi_left =
                            0.9 - 0.4 * (left.position - 1).max(0) as f64 / (count - 1.0).max(1.0);
                        let phi_right =
                            0.9 - 0.4 * (right.position - 1).max(0) as f64 / (count - 1.0).max(1.0);
                        let delta = (right.position - left.position).max(1) as f64;
                        let distance = if distance_decay > 0.0 {
                            (-distance_decay * (delta - 1.0)).exp()
                        } else {
                            1.0
                        };
                        let base = phi_left * phi_right * distance;
                        let forward = base * forward_gain * semantic;
                        let mut dynamic_reverse = reverse_gain;
                        if reverse_anchor_enabled {
                            dynamic_reverse *= anchor_gain
                                .get(&left.tag_id)
                                .copied()
                                .unwrap_or(1.0)
                                .min(reverse_anchor_max);
                        }
                        dynamic_reverse = dynamic_reverse.clamp(0.25, 0.70);
                        let backward =
                            (base * dynamic_reverse * semantic).min(forward * reverse_guard);
                        add_edge(&mut matrix, left.tag_id, right.tag_id, forward);
                        add_edge(&mut matrix, right.tag_id, left.tag_id, backward);
                    } else {
                        let weight = 0.7 * 0.7 * semantic;
                        add_edge(&mut matrix, left.tag_id, right.tag_id, weight);
                        add_edge(&mut matrix, right.tag_id, left.tag_id, weight);
                    }
                }
            }
        }
        offset = end;
    }
    let mut output: HashMap<i64, HashMap<i64, f64>> = HashMap::new();
    for ((source, target), weight) in stable_sums(matrix) {
        output.entry(source).or_default().insert(target, weight);
    }
    Ok(output)
}

fn build_transport(
    fact: &HashMap<i64, HashMap<i64, f64>>,
    anchor_gain: &HashMap<i64, f64>,
    config: &Value,
) -> (HashMap<i64, HashMap<i64, f64>>, HashSet<(i64, i64)>) {
    let v9 = config.get("v9").unwrap_or(&Value::Null);
    let outbound_mass = number(v9, &["outboundMass"], 0.95).clamp(0.01, 0.999999);
    let reserve_mass = number(v9, &["associationReserveMass"], 0.05).clamp(0.0, outbound_mass);
    let evidence_compression = number(v9, &["evidenceCompression"], 1.0).max(0.01);
    let wormhole_gain = number(v9, &["wormholeGain"], 1.35).max(1.0);
    let tension_threshold = number(v9, &["tensionThreshold"], 1.0).max(0.0);
    let hub_exponent = number(v9, &["hubPenaltyExponent"], 0.3).clamp(0.0, 1.0);
    let hub_floor = number(v9, &["hubPenaltyFloor"], 0.55).clamp(0.05, 1.0);
    let hub_ceiling = number(v9, &["hubPenaltyCeiling"], 1.8).clamp(1.0, 4.0);
    let smoothing_ratio = number(v9, &["hubSmoothingRatio"], 0.1).clamp(0.01, 2.0);

    let mut raw_rows: HashMap<i64, Vec<(i64, f64, bool)>> = HashMap::new();
    let mut target_inflow: HashMap<i64, f64> = HashMap::new();
    let mut sources: Vec<_> = fact.keys().copied().collect();
    sources.sort_unstable();
    for source_id in sources {
        let source = &source_id;
        let mut edges: Vec<_> = fact[source].iter().collect();
        edges.sort_by_key(|(target, _)| **target);
        for (target, compatibility) in edges {
            let evidence = (1.0 + compatibility.max(0.0) * evidence_compression).ln();
            let residual = anchor_gain.get(target).copied().unwrap_or(1.0);
            let wormhole = evidence * residual >= tension_threshold;
            let conductance = evidence * if wormhole { wormhole_gain } else { 1.0 };
            if conductance > 0.0 && conductance.is_finite() {
                raw_rows
                    .entry(*source)
                    .or_default()
                    .push((*target, conductance, wormhole));
                *target_inflow.entry(*target).or_default() += conductance;
            }
        }
    }

    let mut positive: Vec<f64> = target_inflow
        .values()
        .copied()
        .filter(|value| *value > 0.0 && value.is_finite())
        .collect();
    // Linear-time selection of index len/2. `total_cmp` distinguishes every bit
    // pattern, so this is the same value a full sort would place there.
    let median = if positive.is_empty() {
        1.0
    } else {
        let middle = positive.len() / 2;
        *positive.select_nth_unstable_by(middle, |left, right| left.total_cmp(right)).1
    };
    let smoothing = (median * smoothing_ratio).max(1e-9);
    let hub_penalty = |inflow: f64| -> f64 {
        let relative = inflow / (median + smoothing);
        let raw_penalty = if hub_exponent > 0.0 {
            relative.max(1e-9).powf(-hub_exponent)
        } else {
            1.0
        };
        raw_penalty.clamp(hub_floor, hub_ceiling)
    };
    // The penalty depends only on the target: one `powf` per target, not per edge.
    let penalties: HashMap<i64, f64> = target_inflow
        .iter()
        .map(|(target, inflow)| (*target, hub_penalty(*inflow)))
        .collect();

    let mut transport = HashMap::new();
    let mut wormholes = HashSet::new();
    for (source, edges) in raw_rows {
        let mut adjusted = Vec::new();
        let mut total = 0.0;
        let mut wormhole_total = 0.0;
        for (target, conductance, wormhole) in edges {
            let penalty = penalties.get(&target).copied().unwrap_or_else(|| hub_penalty(0.0));
            let value = conductance * penalty;
            if value > 0.0 && value.is_finite() {
                total += value;
                if wormhole {
                    wormhole_total += value;
                }
                adjusted.push((target, value, wormhole));
            }
        }
        if total <= 0.0 {
            continue;
        }
        let reserved = if wormhole_total > 0.0 {
            reserve_mass
        } else {
            0.0
        };
        let main = outbound_mass - reserved;
        let row = transport.entry(source).or_insert_with(HashMap::new);
        for (target, value, wormhole) in adjusted {
            let normalized = main * value / total
                + if wormhole && wormhole_total > 0.0 {
                    reserved * value / wormhole_total
                } else {
                    0.0
                };
            row.insert(target, normalized);
            if wormhole {
                wormholes.insert((source, target));
            }
        }
    }
    (transport, wormholes)
}

fn build_provenance(
    rows: &[FileTag],
    config: &Value,
) -> BTreeMap<(i64, i64), Vec<ProvenanceContribution>> {
    let ordered = config.get("orderedCooccurrence").unwrap_or(&Value::Null);
    let forward_gain = number(ordered, &["forwardGain"], 1.0).max(0.0);
    let reverse_gain = number(ordered, &["reverseGain"], 0.35).max(0.0);
    let distance_decay = number(ordered, &["distanceDecay"], 0.08).max(0.0);
    let mut aggregated: Vec<((i64, i64, i64), f64)> = Vec::new();

    let mut offset = 0usize;
    while offset < rows.len() {
        let file_id = rows[offset].file_id;
        let mut end = offset + 1;
        while end < rows.len() && rows[end].file_id == file_id {
            end += 1;
        }
        let tags = &rows[offset..end];
        if tags.len() >= 2 && tags.len() <= 100 {
            for left_index in 0..tags.len() {
                for right_index in (left_index + 1)..tags.len() {
                    let left = &tags[left_index];
                    let right = &tags[right_index];
                    if left.tag_id == right.tag_id {
                        continue;
                    }
                    let delta = (right.position - left.position).max(1) as f64;
                    let distance = (-distance_decay * (delta - 1.0).max(0.0)).exp();
                    for (source, target, mass) in [
                        (left.tag_id, right.tag_id, forward_gain * distance),
                        (right.tag_id, left.tag_id, reverse_gain * distance),
                    ] {
                        aggregated.push(((source, target, file_id), mass));
                    }
                }
            }
        }
        offset = end;
    }

    let mut output: Vec<((i64, i64), Vec<ProvenanceContribution>)> = Vec::new();
    for ((source, target, file_id), mass) in stable_sums(aggregated) {
        let edge = (source, target);
        if output.last().is_none_or(|(previous, _)| *previous != edge) {
            output.push((edge, Vec::new()));
        }
        output.last_mut().unwrap().1.push(ProvenanceContribution { file_id, mass });
    }
    output.into_iter().collect()
}

fn database_generation(connection: &Connection) -> std::result::Result<String, String> {
    connection
        .query_row(
            "SELECT value FROM kbm_runtime_meta \
             WHERE key = 'database_generation'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| format!("read persisted database generation failed: {}", error))
}

fn build_native_artifact(
    transport: &HashMap<i64, HashMap<i64, f64>>,
    inbound: HashMap<i64, f64>,
    anchor_gain: HashMap<i64, f64>,
    wormholes: HashSet<(i64, i64)>,
    provenance: &BTreeMap<(i64, i64), Vec<ProvenanceContribution>>,
) -> Arc<NativeArtifact> {
    let mut nodes = BTreeSet::new();
    for (source, edges) in transport {
        nodes.insert(*source);
        nodes.extend(edges.keys().copied());
    }
    let node_ids: Vec<i64> = nodes.into_iter().collect();
    let node_index: HashMap<i64, usize> = node_ids
        .iter()
        .enumerate()
        .map(|(index, id)| (*id, index))
        .collect();
    let mut row_offsets = Vec::with_capacity(node_ids.len() + 1);
    let mut targets = Vec::new();
    let mut weights = Vec::new();
    row_offsets.push(0);
    for source in &node_ids {
        let mut edges: Vec<(i64, f64)> = transport
            .get(source)
            .map(|items| items.iter().map(|(id, weight)| (*id, *weight)).collect())
            .unwrap_or_default();
        edges.sort_by_key(|item| item.0);
        for (target, weight) in edges {
            if let Some(index) = node_index.get(&target) {
                targets.push(*index);
                weights.push(weight);
            }
        }
        row_offsets.push(targets.len());
    }
    let native_provenance = provenance
        .iter()
        .map(|(edge, contributions)| {
            (
                *edge,
                contributions
                    .iter()
                    .map(|item| (item.file_id, item.mass))
                    .collect(),
            )
        })
        .collect();
    let max_inbound = inbound.values().copied().fold(0.0, f64::max);
    Arc::new(NativeArtifact {
        node_ids,
        node_index,
        row_offsets,
        targets,
        weights,
        inbound,
        max_inbound,
        anchor_gain,
        wormhole_edges: wormholes,
        provenance: native_provenance,
        ..NativeArtifact::default()
    }.prepared())
}

/// `"source:target"`, the text `format!("{}:{}", source, target)` produced.
struct EdgeKey(i64, i64);

impl Serialize for EdgeKey {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.collect_str(&format_args!("{}:{}", self.0, self.1))
    }
}

/// `[[fileId, mass], ...]` of one provenance edge.
struct Contributions<'a>(&'a [ProvenanceContribution]);

impl Serialize for Contributions<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.collect_seq(self.0.iter().map(|item| (item.file_id, item.mass)))
    }
}

/// `[["source:target", contributions], ...]` in provenance key order.
struct ProvenanceEdges<'a>(&'a BTreeMap<(i64, i64), Vec<ProvenanceContribution>>);

impl Serialize for ProvenanceEdges<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.collect_seq(self.0.iter().map(|((source, target), contributions)| {
            (EdgeKey(*source, *target), Contributions(contributions))
        }))
    }
}

struct ProvenanceView<'a> {
    generation: &'a Value,
    edges: ProvenanceEdges<'a>,
}

impl Serialize for ProvenanceView<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(3))?;
        map.serialize_entry("edges", &self.edges)?;
        map.serialize_entry("generation", self.generation)?;
        map.serialize_entry("schema", "tagmemo-provenance-file-mass-v2")?;
        map.end()
    }
}

struct SharedTransport<'a> {
    content_sig: &'a Value,
    artifact: &'a NativeArtifact,
}

impl Serialize for SharedTransport<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(6))?;
        map.serialize_entry("contentSig", self.content_sig)?;
        map.serialize_entry("nodeIds", &self.artifact.node_ids)?;
        map.serialize_entry("rowOffsets", &self.artifact.row_offsets)?;
        map.serialize_entry("schema", "tagmemo-v10-alpha-csr-snapshot-v1")?;
        map.serialize_entry("targetIndices", &self.artifact.targets)?;
        map.serialize_entry("weights", &self.artifact.weights)?;
        map.end()
    }
}

/// The persisted payload, serialised straight from the artifact instead of
/// through a `serde_json::Value` tree. serde_json is built without
/// `preserve_order`, so the tree wrote every object with its keys in sorted
/// order; each `serialize_map` below writes its keys in that same order. All
/// numbers and strings go through the same serializer as before, so the bytes
/// are identical. Only the sorted (ID, value) lists are materialised.
struct ArtifactPayload<'a> {
    metadata: &'a Value,
    artifact: &'a NativeArtifact,
    provenance: &'a BTreeMap<(i64, i64), Vec<ProvenanceContribution>>,
    anchor_gain: Vec<(i64, f64)>,
    inbound: Vec<(i64, f64)>,
    wormholes: Vec<EdgeKey>,
}

impl Serialize for ArtifactPayload<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(8))?;
        map.serialize_entry("anchorGainView", &self.anchor_gain)?;
        map.serialize_entry("artifact", self.metadata)?;
        map.serialize_entry("inboundMassView", &self.inbound)?;
        map.serialize_entry("provenanceView", &ProvenanceView {
            generation: &self.metadata["provenanceGeneration"],
            edges: ProvenanceEdges(self.provenance),
        })?;
        map.serialize_entry("rawResidualRatioView", &Value::Array(Vec::new()))?;
        map.serialize_entry("schema", PAYLOAD_SCHEMA)?;
        map.serialize_entry("sharedTransport", &SharedTransport {
            content_sig: &self.metadata["graphGeneration"],
            artifact: self.artifact,
        })?;
        map.serialize_entry("wormholeView", &self.wormholes)?;
        map.end()
    }
}

fn artifact_payload<'a>(
    artifact: &'a NativeArtifact,
    provenance: &'a BTreeMap<(i64, i64), Vec<ProvenanceContribution>>,
    metadata: &'a Value,
) -> ArtifactPayload<'a> {
    // Map keys are unique, so ascending ID is a total order.
    let mut inbound: Vec<(i64, f64)> =
        artifact.inbound.iter().map(|(id, mass)| (*id, *mass)).collect();
    inbound.sort_unstable_by_key(|entry| entry.0);
    let mut anchor_gain: Vec<(i64, f64)> =
        artifact.anchor_gain.iter().map(|(id, gain)| (*id, *gain)).collect();
    anchor_gain.sort_unstable_by_key(|entry| entry.0);
    let mut wormhole_ids: Vec<_> = artifact.wormhole_edges.iter().copied().collect();
    wormhole_ids.sort_unstable();
    ArtifactPayload {
        metadata,
        artifact,
        provenance,
        anchor_gain,
        inbound,
        wormholes: wormhole_ids.into_iter().map(|(source, target)| EdgeKey(source, target)).collect(),
    }
}

fn run_build(
    dimension: usize,
    runtime: &MemoRuntime,
    db_path: &str,
    input_json: &str,
) -> std::result::Result<NativeMemoArtifactBuildResult, String> {
    let started = Instant::now();
    let mut handoff = crate::storage::memo_workspace_slot(db_path).and_then(|slot| slot.take());
    let input: BuildInput = serde_json::from_str(input_json)
        .map_err(|error| format!("invalid native artifact build JSON: {}", error))?;
    if input.model_sig.trim().is_empty() {
        return Err("native artifact build requires modelSig".to_string());
    }

    let snapshot_gate = crate::publication_gate::acquire_read(db_path, &["*".into()])?;
    let (rows, fact, anchor_gain, residual_sig, database_generation, dependencies) =
        with_registered_read_transaction(db_path, |readonly| {
            let rows = load_file_tags(readonly)?;
            let (anchor_gain, _raw_residuals, residual_sig) = load_anchor_gains(readonly, &input.model_sig)?;
            // Each Tag vector is read and normalised once per snapshot into the
            // memory-mapped f64 workspace that geometry precompute also uses, instead
            // of once per file; no vector SQL when semantic gain is disabled.
            let vectors = if semantic_gain_enabled(&input.effective_config) {
                let ids = cooccurrence_tag_ids(&rows);
                let key = crate::memo_geometry::workspace::SnapshotKey::capture(
                    readonly, db_path, &input.model_sig, dimension)?;
                match handoff.take().and_then(|pending| pending.reuse(&key, &ids)) {
                    Some(workspace) => workspace,
                    None => crate::memo_geometry::UnitVectorWorkspace::build(readonly, &ids, dimension)?,
                }
            } else {
                crate::memo_geometry::UnitVectorWorkspace::empty(dimension)
            };
            drop(handoff.take());
            let fact = build_fact_matrix(&rows, &vectors, &anchor_gain, &input.effective_config)?;
            drop(vectors);
            let database_generation = database_generation(readonly)?;
            let dependencies = crate::storage::DerivedDependencies::capture(
                readonly, crate::storage::MEMO_ARTIFACT_DEPENDENCIES,
            )?;
            Ok((
                rows,
                fact,
                anchor_gain,
                residual_sig,
                database_generation,
                dependencies,
            ))
        })?;
    drop(snapshot_gate);
    let load_ms = started.elapsed().as_secs_f64()*1000.0;
    // Fact edge accumulation already completed inside the frozen SQL snapshot.
    let (transport, wormholes) = build_transport(&fact, &anchor_gain, &input.effective_config);
    drop(fact);
    let provenance = build_provenance(&rows, &input.effective_config);
    drop(rows);

    let mut inbound = HashMap::new();
    let mut sources: Vec<_> = transport.keys().copied().collect();
    sources.sort_unstable();
    let mut graph_hasher = Sha256::new();
    graph_hasher.update(b"memo-graph-le-v2");
    graph_hasher.update((sources.len() as u64).to_le_bytes());
    for source in sources {
        let mut edges: Vec<_> = transport[&source].iter().collect();
        edges.sort_by_key(|(target, _)| **target);
        graph_hasher.update(source.to_le_bytes());
        graph_hasher.update((edges.len() as u64).to_le_bytes());
        for (target, weight) in edges {
            *inbound.entry(*target).or_default() += *weight;
            graph_hasher.update(target.to_le_bytes());
            graph_hasher.update(weight.to_le_bytes());
        }
    }
    let graph_digest = format!("{:x}", graph_hasher.finalize())[..48].to_owned();
    let mut provenance_hasher = Sha256::new();
    provenance_hasher.update(b"memo-provenance-le-v2");
    provenance_hasher.update((provenance.len() as u64).to_le_bytes());
    for ((source, target), values) in &provenance {
        provenance_hasher.update(source.to_le_bytes());
        provenance_hasher.update(target.to_le_bytes());
        provenance_hasher.update((values.len() as u64).to_le_bytes());
        for value in values {
            provenance_hasher.update(value.file_id.to_le_bytes());
            provenance_hasher.update(value.mass.to_le_bytes());
        }
    }
    let provenance_generation = format!("{:x}", provenance_hasher.finalize())[..40].to_owned();
    let config_json = serde_json::to_string(&input.effective_config)
        .map_err(|error| format!("encode effective config failed: {}", error))?;
    let config_hash = hash_text(&config_json, 32);
    let source_artifact_sig = hash_text(
        &format!(
            "{}|{}|{}|{}",
            V9_ALGORITHM_VERSION, input.model_sig, graph_digest, residual_sig
        ),
        24,
    );
    let artifact_sig = hash_text(
        &format!(
            "{}|{}|{}|{}|{}|{}",
            ALGORITHM_VERSION,
            source_artifact_sig,
            graph_digest,
            provenance_generation,
            database_generation,
            config_hash
        ),
        48,
    );

    let native = build_native_artifact(&transport, inbound, anchor_gain, wormholes, &provenance);
    drop(transport);
    let published_at = now_ms();
    let metadata = json!({
        "schema": "tagmemo-v10-alpha-artifact-v1",
        "version": "v10_alpha",
        "algorithmVersion": ALGORITHM_VERSION,
        "artifactSig": artifact_sig,
        "graphGeneration": graph_digest,
        "databaseGeneration": database_generation,
        "provenanceGeneration": provenance_generation,
        "modelSig": input.model_sig,
        "configHash": config_hash,
        "sourceArtifactSig": source_artifact_sig,
        "sourceGraphGeneration": graph_digest,
        "maxInbound": native.max_inbound,
        "effectiveConfig": input.effective_config
    });
    let graph_ms = started.elapsed().as_secs_f64()*1000.0-load_ms;
    let payload = artifact_payload(&native, &provenance, &metadata);
    let raw = serde_json::to_vec(&payload)
        .map_err(|error| format!("encode native artifact payload failed: {}", error))?;
    drop(payload);
    drop(provenance);
    let checksum = sha256_hex(&raw);
    let encode_ms = started.elapsed().as_secs_f64()*1000.0-load_ms-graph_ms;
    let raw_bytes = raw.len() as u32;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder
        .write_all(&raw)
        .map_err(|error| format!("compress native artifact failed: {}", error))?;
    let compressed = encoder
        .finish()
        .map_err(|error| format!("finish native artifact compression failed: {}", error))?;

    drop(raw);
    let compressed_bytes = compressed.len() as u32;
    let compression_ms = started.elapsed().as_secs_f64()*1000.0-load_ms-graph_ms-encode_ms;
    // 只在最终提交和内存发布窗口持门禁，耗时图构建与压缩不阻塞查询。
    let _publication_guard = crate::publication_gate::acquire(db_path, &[String::from("*")])?;
    let source_generation = database_generation.parse::<u64>()
        .map_err(|error| format!("Invalid artifact source generation: {}", error))?;
    let artifact_sig_for_write = artifact_sig.clone();
    let source_artifact_sig_for_write = source_artifact_sig.clone();
    let graph_digest_for_write = graph_digest.clone();
    let database_generation_for_write = database_generation.clone();
    let provenance_generation_for_write = provenance_generation.clone();
    let model_sig_for_write = input.model_sig.clone();
    let config_hash_for_write = config_hash.clone();
    let checksum_for_write = checksum.clone();
    let native_for_write = native.clone();
    let dependencies_for_write = dependencies.clone();

    with_registered_write(db_path, move |transaction| {
        crate::storage::ensure_generation(transaction, source_generation)?;
        dependencies_for_write.ensure_current(transaction)?;
        transaction
            .execute(
                "INSERT INTO rivermemo_artifacts (\
             artifact_sig, schema_version, algorithm_version, source_v9_artifact_sig, \
             source_graph_generation, model_sig, config_hash, database_generation, \
             provenance_generation, payload_codec, payload_checksum, payload, status, \
             error_message, node_count, edge_count, created_at, updated_at, published_at\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'ready', \
             NULL, ?13, ?14, ?15, ?15, ?15) \
             ON CONFLICT(artifact_sig) DO UPDATE SET \
             payload_checksum=excluded.payload_checksum, payload=excluded.payload, \
             status='ready', error_message=NULL, updated_at=excluded.updated_at, \
             published_at=excluded.published_at, node_count=excluded.node_count, \
             edge_count=excluded.edge_count",
                params![
                    artifact_sig_for_write,
                    PAYLOAD_SCHEMA,
                    ALGORITHM_VERSION,
                    source_artifact_sig_for_write,
                    graph_digest_for_write,
                    model_sig_for_write,
                    config_hash_for_write,
                    database_generation_for_write,
                    provenance_generation_for_write,
                    PAYLOAD_CODEC,
                    checksum_for_write,
                    compressed,
                    native_for_write.node_ids.len() as i64,
                    native_for_write.targets.len() as i64,
                    published_at
                ],
            )
            .map_err(|error| format!("persist native artifact failed: {}", error))?;
        dependencies_for_write.persist_for_artifact(transaction, &artifact_sig_for_write)?;
        // The generation/dependency CAS above guarantees this graph includes every
        // committed change. Only a successful publication resets the durable budget.
        transaction.execute_batch(
            "INSERT INTO kbm_runtime_meta(key,value)
             VALUES ('memo_training_tag_count',(SELECT CAST(COUNT(*) AS TEXT) FROM tags))
             ON CONFLICT(key) DO UPDATE SET value=excluded.value;
             DELETE FROM kbm_memo_changed_tags;"
        ).map_err(|e| format!("publish Memo training baseline failed: {e}"))?;

        Ok(crate::storage::WriteReceipt {
            operation: "publish_rivermemo_artifact".to_string(),
            database_generation: 0,
            facts_changed: false,
        })
    })
    .map_err(|error| {
        format!(
            "persist native artifact through Write Actor failed: {}",
            error
        )
    })?;

    with_registered_read_transaction(db_path, |connection| {
        crate::storage::ensure_generation(connection, source_generation)?;
        dependencies.ensure_current(connection)
    })?;
    let generation = runtime.publish(&artifact_sig, native.clone())?;
    Ok(NativeMemoArtifactBuildResult {
        success: true,
        artifact_sig,
        source_artifact_sig,
        graph_generation: graph_digest,
        database_generation,
        provenance_generation,
        generation: generation as i64,
        node_count: native.node_ids.len() as u32,
        edge_count: native.targets.len() as u32,
        persisted: true,
        resident: true,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
        phase_summary: format!("load={load_ms:.3};graph={graph_ms:.3};encode={encode_ms:.3};compress={compression_ms:.3};publish={:.3}",
            started.elapsed().as_secs_f64()*1000.0-load_ms-graph_ms-encode_ms-compression_ms),
        raw_bytes,
        compressed_bytes,
    })
}

pub struct NativeMemoArtifactBuildTask {
    dimension: usize,
    runtime: Arc<MemoRuntime>,
    db_path: String,
    input_json: String,
}

impl Task for NativeMemoArtifactBuildTask {
    type Output = NativeMemoArtifactBuildResult;
    type JsValue = NativeMemoArtifactBuildResult;

    fn compute(&mut self) -> Result<Self::Output> {
        run_build(self.dimension, &self.runtime, &self.db_path, &self.input_json).map_err(Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub(crate) fn rebuild_with_runtime(
    lifecycle: &Arc<crate::task_lifecycle::TaskLifecycle>,
    dimension: usize,
    runtime: Arc<MemoRuntime>,
    db_path: String,
    input_json: String,
) -> AsyncTask<crate::task_lifecycle::TrackedTask<NativeMemoArtifactBuildTask>> {
    AsyncTask::new(crate::task_lifecycle::TrackedTask::new(lifecycle, NativeMemoArtifactBuildTask {
        dimension,
        runtime,
        db_path,
        input_json,
    }))
}


#[cfg(test)]
mod streamed_payload_tests {
    use super::*;

    /// The previous encoding: a `serde_json::Value` tree, then `to_vec`.
    fn tree_payload(
        artifact: &NativeArtifact,
        provenance: &BTreeMap<(i64, i64), Vec<ProvenanceContribution>>,
        metadata: &Value,
    ) -> Vec<u8> {
        let provenance_edges: Vec<Value> = provenance
            .iter()
            .map(|((source, target), contributions)| {
                json!([
                    format!("{}:{}", source, target),
                    contributions
                        .iter()
                        .map(|item| json!([item.file_id, item.mass]))
                        .collect::<Vec<_>>()
                ])
            })
            .collect();
        let mut inbound: Vec<Value> = artifact
            .inbound
            .iter()
            .map(|(id, mass)| json!([id, mass]))
            .collect();
        inbound.sort_by_key(|v| v[0].as_i64().unwrap_or(0));
        let mut anchor_gain: Vec<Value> = artifact
            .anchor_gain
            .iter()
            .map(|(id, gain)| json!([id, gain]))
            .collect();
        anchor_gain.sort_by_key(|v| v[0].as_i64().unwrap_or(0));
        let mut wormhole_ids: Vec<_> = artifact.wormhole_edges.iter().copied().collect();
        wormhole_ids.sort_unstable();
        let wormholes: Vec<Value> = wormhole_ids
            .iter()
            .map(|(source, target)| json!(format!("{}:{}", source, target)))
            .collect();

        serde_json::to_vec(&json!({
            "schema": PAYLOAD_SCHEMA,
            "artifact": metadata,
            "sharedTransport": {
                "schema": "tagmemo-v10-alpha-csr-snapshot-v1",
                "contentSig": metadata["graphGeneration"],
                "nodeIds": artifact.node_ids,
                "rowOffsets": artifact.row_offsets,
                "targetIndices": artifact.targets,
                "weights": artifact.weights
            },
            "provenanceView": {
                "schema": "tagmemo-provenance-file-mass-v2",
                "generation": metadata["provenanceGeneration"],
                "edges": provenance_edges
            },
            "rawResidualRatioView": [],
            "anchorGainView": anchor_gain,
            "inboundMassView": inbound,
            "wormholeView": wormholes
        }))
        .unwrap()
    }

    fn streamed_payload(
        artifact: &NativeArtifact,
        provenance: &BTreeMap<(i64, i64), Vec<ProvenanceContribution>>,
        metadata: &Value,
    ) -> Vec<u8> {
        serde_json::to_vec(&artifact_payload(artifact, provenance, metadata)).unwrap()
    }

    /// Floats whose shortest text takes every branch of the formatter, plus
    /// values the tree turned into `null`.
    const AWKWARD: [f64; 14] = [
        0.1 + 0.2, 1.0, -0.0, 0.0, 5e-324, 1e-310, 1e21, 1e-7, 123456789.0,
        f64::MAX, f64::MIN_POSITIVE, f64::NAN, f64::INFINITY, f64::NEG_INFINITY,
    ];

    #[test]
    fn streamed_payload_has_the_bytes_of_the_value_tree() {
        let ids: Vec<i64> = vec![1, 2, 3, 40, 512, 9_007_199_254_740_993, i64::MAX];
        let artifact = NativeArtifact {
            node_ids: ids.clone(),
            row_offsets: vec![0, 3, 3, 7, 9, 11, 14, 14],
            targets: (0..14).map(|index| (index * 5) % ids.len()).collect(),
            weights: AWKWARD.to_vec(),
            inbound: (0..200_i64).map(|id| (id * 7919 % 1000 - 300, AWKWARD[id as usize % 14])).collect(),
            anchor_gain: (0..200_i64).map(|id| (id * 104_729 % 997, 0.5 + id as f64 / 3.0)).collect(),
            wormhole_edges: [(3, 1), (-4, 2), (1, 3), (1, 2), (i64::MAX, i64::MIN)].into_iter().collect(),
            ..NativeArtifact::default()
        };
        let mut provenance = BTreeMap::new();
        for source in -3..12_i64 {
            for target in [source - 1, source + 2, 900] {
                let contributions = (0..(source + 3) as usize % 5)
                    .map(|index| ProvenanceContribution {
                        file_id: index as i64 * 31 + target,
                        mass: AWKWARD[(index + source as usize % 7) % 14],
                    })
                    .collect();
                provenance.insert((source, target), contributions);
            }
        }
        let metadata = json!({
            "schema": "tagmemo-v10-alpha-artifact-v1",
            "graphGeneration": "graph",
            "provenanceGeneration": "provenance",
            "maxInbound": 0.1 + 0.2,
            "effectiveConfig": {
                "zeta": [1, -1, 2.5, 1e300, -0.0, true, null],
                "Alpha": {"b": "quote \" backslash \\ newline \n tab \t 合成 \u{1}", "a": {}},
                "_": [],
                "a": u64::MAX,
            }
        });
        let streamed = streamed_payload(&artifact, &provenance, &metadata);
        assert_eq!(String::from_utf8(streamed.clone()).unwrap(),
            String::from_utf8(tree_payload(&artifact, &provenance, &metadata)).unwrap());
        // Non-finite weights and masses were written as `null`; they still are.
        let text = std::str::from_utf8(&streamed).unwrap();
        assert!(text.contains(",null,") && text.contains(",null]"));
    }

    #[test]
    fn empty_artifact_and_provenance_keep_the_tree_bytes() {
        let empty = NativeArtifact::default();
        let provenance = BTreeMap::new();
        for metadata in [json!({}), json!({"graphGeneration": "g", "provenanceGeneration": "p"}), Value::Null] {
            let streamed = streamed_payload(&empty, &provenance, &metadata);
            assert_eq!(streamed, tree_payload(&empty, &provenance, &metadata));
        }
        let mut one_empty_edge = BTreeMap::new();
        one_empty_edge.insert((1, 2), Vec::new());
        let metadata = json!({});
        assert_eq!(streamed_payload(&empty, &one_empty_edge, &metadata),
            tree_payload(&empty, &one_empty_edge, &metadata));
        assert_eq!(
            String::from_utf8(streamed_payload(&empty, &provenance, &metadata)).unwrap(),
            r#"{"anchorGainView":[],"artifact":{},"inboundMassView":[],"provenanceView":{"edges":[],"generation":null,"schema":"tagmemo-provenance-file-mass-v2"},"rawResidualRatioView":[],"schema":"rivermemo-persisted-artifact-v2","sharedTransport":{"contentSig":null,"nodeIds":[],"rowOffsets":[],"schema":"tagmemo-v10-alpha-csr-snapshot-v1","targetIndices":[],"weights":[]},"wormholeView":[]}"#
        );
    }
}

#[cfg(test)]
mod fact_dependency_tests {
    use super::*;
    use crate::storage::{SqliteStorageEngine, StorageOptions, WriteReceipt};

    #[test]
    fn published_snapshot_survives_tag_changes_and_cold_restore() {
        let root = std::env::temp_dir().join(format!(
            "kbm-artifact-facts-{}-{}", std::process::id(), now_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db = root.join("test.sqlite").to_string_lossy().into_owned();
        let (storage, _) = SqliteStorageEngine::open_and_init(&db, StorageOptions::default()).unwrap();
        storage.submit_write(|tx| {
            tx.execute_batch(
                "INSERT INTO files(id,path,diary_name,checksum,mtime,size) VALUES (1,'tagged.txt','test','h',1,1);
                 INSERT INTO tags(id,name,vector) VALUES (1,'a',X'0000803f00000000'),(2,'b',X'000000000000803f');
                 INSERT INTO file_tags VALUES (1,1,1),(1,2,2);"
            ).map_err(|error| error.to_string())?;
            Ok(WriteReceipt { operation: "fixture".into(), database_generation: 0, facts_changed: true })
        }).unwrap();
        let runtime = MemoRuntime::new();
        let built = run_build(2, &runtime, &db, r#"{"modelSig":"test","effectiveConfig":{}}"#).unwrap();
        let repeated = run_build(2, &runtime, &db, r#"{"modelSig":"test","effectiveConfig":{}}"#).unwrap();
        assert_eq!(built.graph_generation,repeated.graph_generation);
        assert_eq!(built.provenance_generation,repeated.provenance_generation);
        assert_eq!(built.artifact_sig,repeated.artifact_sig);
        let config_hash = hash_text("{}", 32);
        let mut manifest = crate::knowledge_runtime::NativeMemoManifestLookupTask {
            db_path: db.clone(), model_sig: "test".into(), config_hash,
        };
        storage.submit_write(|tx| {
            tx.execute_batch(
                "INSERT INTO files(path,diary_name,checksum,mtime,size) VALUES ('plain.txt','test','plain',1,1);"
            ).map_err(|error| error.to_string())?;
            Ok(WriteReceipt { operation: "ordinary".into(), database_generation: 0, facts_changed: true })
        }).unwrap();
        runtime.clear().unwrap();
        assert_ne!(manifest.compute().unwrap(), "null");
        with_registered_read_transaction(&db, |connection| {
            let loaded=crate::rivermemo_topology_v3::load_artifact_with_connection(
                &runtime, connection, &built.artifact_sig,
            )?;
            assert_eq!(loaded.provenance.get(&(1,2)),Some(&vec![(1,1.0)]));
            assert_eq!(loaded.provenance.get(&(2,1)),Some(&vec![(1,0.35)]));
            Ok(())
        }).unwrap();
        storage.submit_write(|tx| {
            tx.execute("UPDATE tags SET vector=X'000000000000803f' WHERE id=1", [])
                .map_err(|error| error.to_string())?;
            Ok(WriteReceipt { operation: "tag-change".into(), database_generation: 0, facts_changed: true })
        }).unwrap();
        runtime.clear().unwrap();
        assert_ne!(manifest.compute().unwrap(), "null");
        with_registered_read_transaction(&db, |connection| {
            crate::rivermemo_topology_v3::load_artifact_with_connection(
                &runtime, connection, &built.artifact_sig,
            ).map(|_| ())
        }).unwrap();
        let status: Value = serde_json::from_str(&manifest.compute().unwrap()).unwrap();
        assert_eq!(status["trainingTagCount"], 2);
        assert_eq!(status["changedTagCount"], 1);
        storage.submit_write(|tx| {
            tx.execute_batch(
                "UPDATE file_tags SET position=3 WHERE tag_id=2;
                 DELETE FROM file_tags WHERE tag_id=1;"
            ).map_err(|e| e.to_string())?;
            Ok(WriteReceipt { operation: "relation-change".into(), database_generation: 0, facts_changed: true })
        }).unwrap();
        let status: Value = serde_json::from_str(&manifest.compute().unwrap()).unwrap();
        assert_eq!(status["changedTagCount"], 2, "count unique Tags, not mutations");
        with_registered_read_transaction(&db, |connection| {
            crate::rivermemo_topology_v3::load_artifact_with_connection(
                &runtime, connection, &built.artifact_sig,
            ).map(|_| ())
        }).unwrap();
        storage.submit_write(|tx| {
            tx.execute("UPDATE kbm_runtime_meta SET value='0' WHERE key='memo_tag_facts'", [])
                .map_err(|e| e.to_string())?;
            Ok(WriteReceipt { operation: "rollback-fixture".into(), database_generation: 0, facts_changed: false })
        }).unwrap();
        assert_eq!(manifest.compute().unwrap(), "null", "rollback must not reuse a future graph");
        let error = with_registered_read_transaction(&db, |connection| {
            crate::rivermemo_topology_v3::load_artifact_with_connection(
                &runtime, connection, &built.artifact_sig,
            ).map(|_| ())
        }).unwrap_err();
        assert!(error.contains("DERIVED_DEPENDENCY_CONFLICT"));
        storage.submit_write(|tx| {
            tx.execute_batch(
                "UPDATE kbm_runtime_meta SET value='99999' WHERE key='memo_tag_facts';
                 DELETE FROM kbm_artifact_dependencies WHERE dependency_key='memo_tag_facts';"
            ).map_err(|e| e.to_string())?;
            Ok(WriteReceipt { operation: "missing-dependency".into(), database_generation: 0, facts_changed: false })
        }).unwrap();
        assert_eq!(manifest.compute().unwrap(), "null");
        assert!(with_registered_read_transaction(&db, |connection| {
            crate::rivermemo_topology_v3::load_artifact_with_connection(
                &runtime, connection, &built.artifact_sig,
            ).map(|_| ())
        }).unwrap_err().contains("DERIVED_DEPENDENCY_CONFLICT"));
        storage.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}


#[cfg(test)]
mod cold_restore_float_tests {
    use super::*;
    use crate::storage::{SqliteStorageEngine, StorageOptions, WriteReceipt};

    /// Every float a cold load reads from the payload, labelled by where it is.
    fn float_bits(artifact: &NativeArtifact) -> Vec<(String, u64)> {
        let mut out: Vec<(String, u64)> = artifact.weights.iter().enumerate()
            .map(|(cursor, weight)| (format!("weight[{cursor}]"), weight.to_bits())).collect();
        out.push(("maxInbound".into(), artifact.max_inbound.to_bits()));
        for (name, map) in [("inbound", &artifact.inbound), ("anchorGain", &artifact.anchor_gain)] {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_unstable_by_key(|(id, _)| **id);
            out.extend(entries.into_iter().map(|(id, value)| (format!("{name}[{id}]"), value.to_bits())));
        }
        let mut edges: Vec<_> = artifact.provenance.iter().collect();
        edges.sort_unstable_by_key(|(edge, _)| **edge);
        for ((source, target), rows) in edges {
            out.extend(rows.iter().map(|(file_id, mass)| (format!("provenance[{source}:{target}][{file_id}]"), mass.to_bits())));
        }
        out
    }

    /// The payload stores edge weights, inbound masses, anchor gains and
    /// provenance masses as JSON text. A cold load must read back the bits the
    /// build published, so that a restored graph answers exactly like the
    /// freshly built one; serde_json needs `float_roundtrip` for that (without
    /// it about one float in nine comes back one unit in the last place off).
    #[test]
    fn restored_artifact_has_published_float_bits() {
        let root = std::env::temp_dir().join(format!(
            "kbm-artifact-floats-{}-{}", std::process::id(), now_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db = root.join("test.sqlite").to_string_lossy().into_owned();
        let (storage, _) = SqliteStorageEngine::open_and_init(&db, StorageOptions::default()).unwrap();
        storage.submit_write(|tx| {
            for id in 1..=40_i64 {
                let vector: Vec<u8> = (0..4_i64)
                    .flat_map(|axis| (((id * 7 + axis * 3) as f32) * 0.37).sin().to_le_bytes())
                    .collect();
                tx.execute("INSERT INTO tags(id,name,vector) VALUES (?1,?2,?3)",
                    params![id, format!("t{id}"), vector]).map_err(|error| error.to_string())?;
            }
            for file_id in 1..=60_i64 {
                tx.execute("INSERT INTO files(id,path,diary_name,checksum,mtime,size) VALUES (?1,?2,'test','h',1,1)",
                    params![file_id, format!("f{file_id}.txt")]).map_err(|error| error.to_string())?;
                for position in 1..=5_i64 {
                    tx.execute("INSERT INTO file_tags VALUES (?1,?2,?3)",
                        params![file_id, (file_id * 3 + position * position) % 40 + 1, position])
                        .map_err(|error| error.to_string())?;
                }
            }
            Ok(WriteReceipt { operation: "fixture".into(), database_generation: 0, facts_changed: true })
        }).unwrap();
        let runtime = MemoRuntime::new();
        let built = run_build(4, &runtime, &db, r#"{"modelSig":"test","effectiveConfig":{}}"#).unwrap();
        let load = || with_registered_read_transaction(&db, |connection| {
            crate::rivermemo_topology_v3::load_artifact_with_connection(&runtime, connection, &built.artifact_sig)
        });
        let published = load().unwrap();
        runtime.clear().unwrap();
        let restored = load().unwrap();
        assert!(!Arc::ptr_eq(&published, &restored), "the second load must decode the stored payload");
        assert_eq!(published.node_ids, restored.node_ids);
        assert_eq!(published.row_offsets, restored.row_offsets);
        assert_eq!(published.targets, restored.targets);
        let (expected, actual) = (float_bits(&published), float_bits(&restored));
        assert!(published.weights.len() >= 200 && expected.len() >= 1000);
        assert_eq!(expected.iter().map(|(label, _)| label).collect::<Vec<_>>(),
            actual.iter().map(|(label, _)| label).collect::<Vec<_>>());
        let differing: Vec<&str> = expected.iter().zip(&actual)
            .filter(|(left, right)| left.1 != right.1).map(|(left, _)| left.0.as_str()).collect();
        assert!(differing.is_empty(), "{} of {} floats changed bits on a cold load, e.g. {:?}",
            differing.len(), expected.len(), &differing[..differing.len().min(4)]);
        storage.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod bounded_workspace_tests {
    use super::*;

    struct NoVectors;
    impl UnitVectors for NoVectors {
        fn unit_vector(&self, _: i64) -> Option<&[f64]> {
            panic!("semantic gain disabled must not read vectors")
        }
    }

    #[test]
    fn mapped_workspace_matches_in_memory_vectors_bits() {
        // Consecutive files share three Tags, so most pairs recur across files.
        let rows: Vec<_> = (1..=300).flat_map(|file_id| {
            (1..=4).map(move |position| FileTag {
                file_id, tag_id: file_id + position, position,
            })
        }).collect();
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE tags(id INTEGER PRIMARY KEY, vector BLOB)").unwrap();
        for id in 1..=304_i64 {
            let x = id as f32 * 0.013;
            let bytes: Vec<u8> = [x.cos(), x.sin()].iter().flat_map(|v| v.to_le_bytes()).collect();
            connection.execute("INSERT INTO tags VALUES (?1,?2)", params![id, bytes]).unwrap();
        }
        connection.execute("UPDATE tags SET vector=zeroblob(8) WHERE id=7", []).unwrap();
        let ids = cooccurrence_tag_ids(&rows);
        assert_eq!(ids.len(), 303);
        let workspace = crate::memo_geometry::UnitVectorWorkspace::build(&connection, &ids, 2).unwrap();
        let (in_memory, _) = crate::memo_geometry::read_unit_vectors(&connection, &ids, 2).unwrap();
        let config = json!({"orderedCooccurrence":{"semanticGainEnabled":true}});
        let mapped = build_fact_matrix(&rows, &workspace, &HashMap::new(), &config).unwrap();
        let heap = build_fact_matrix(&rows, &in_memory, &HashMap::new(), &config).unwrap();
        assert_eq!(mapped.len(), heap.len());
        for (source, edges) in &heap {
            assert_eq!(mapped[source].len(), edges.len());
            for (target, weight) in edges {
                assert_eq!(mapped[source][target].to_bits(), weight.to_bits());
            }
        }
        let plain = build_fact_matrix(&rows, &NoVectors, &HashMap::new(), &json!({})).unwrap();
        assert!(!plain.is_empty());
    }
}

#[cfg(test)]
mod sorted_contribution_tests {
    use super::*;
    fn baseline_add(matrix: &mut HashMap<i64, HashMap<i64, f64>>, source: i64, target: i64, weight: f64) {
        if source != target && weight.is_finite() && weight > 0.0 {
            *matrix.entry(source).or_default().entry(target).or_default() += weight;
        }
    }
fn baseline_fact(
    rows: &[FileTag],
    vectors: &dyn UnitVectors,
    anchor_gain: &HashMap<i64, f64>,
    config: &Value,
) -> std::result::Result<HashMap<i64, HashMap<i64, f64>>, String> {
    let ordered = config.get("orderedCooccurrence").unwrap_or(&Value::Null);
    let forward_gain = number(ordered, &["forwardGain"], 1.0).max(0.0);
    let reverse_gain = number(ordered, &["reverseGain"], 0.42).clamp(
        number(ordered, &["minReverseGain"], 0.25),
        number(ordered, &["maxReverseGain"], 0.70),
    );
    let distance_decay = number(ordered, &["distanceDecay"], 0.0).max(0.0);
    let reverse_guard = number(ordered, &["reverseInversionGuard"], 0.95).clamp(0.0, 1.0);
    let reverse_anchor_enabled = boolean(ordered, &["reverseAnchorBoost"], false);
    let reverse_anchor_max = number(ordered, &["reverseAnchorMax"], 1.5).max(1.0);
    let semantic_enabled = semantic_gain_enabled(config);
    let semantic_peak = number(
        ordered,
        &["semanticGainPeak"],
        number(ordered, &["semanticGain", "peak"], 0.65),
    );
    let semantic_sigma = number(
        ordered,
        &["semanticGainSigma"],
        number(ordered, &["semanticGain", "sigma"], 0.25),
    )
    .max(0.001);
    let low_fallback = number(
        ordered,
        &["semanticGainLowSimFallback"],
        number(ordered, &["semanticGain", "lowSimFallback"], 0.1),
    );

    let semantic_gain = |left: i64, right: i64| -> f64 {
        if !semantic_enabled {
            return 1.0;
        }
        let similarity = vectors.unit_vector(left).zip(vectors.unit_vector(right))
            .map(|(a,b)| crate::memo_geometry::dot(a,b).clamp(-1.0,1.0))
            .unwrap_or(low_fallback);
        if similarity < 0.15 {
            0.4 + similarity * 1.0
        } else {
            0.5 + 0.8
                * (-((similarity - semantic_peak).powi(2))
                    / (2.0 * semantic_sigma * semantic_sigma))
                    .exp()
        }
    };

    // One gain per unordered Tag pair. `dot` multiplies the same two vectors in
    // the same index order whichever comes first, so the stored value has the
    // bits every later file would compute. Bounded by the number of fact pairs.
    let mut pair_gains: HashMap<(i64, i64), f64> = HashMap::new();
    let mut matrix = HashMap::new();
    let mut offset = 0usize;
    while offset < rows.len() {
        let file_id = rows[offset].file_id;
        let mut end = offset + 1;
        while end < rows.len() && rows[end].file_id == file_id {
            end += 1;
        }
        let tags = &rows[offset..end];
        if tags.len() >= 2 && tags.len() <= 100 {
            for left_index in 0..tags.len() {
                for right_index in (left_index + 1)..tags.len() {
                    let left = &tags[left_index];
                    let right = &tags[right_index];
                    if left.tag_id == right.tag_id {
                        continue;
                    }
                    let semantic = if semantic_enabled {
                        let pair = (left.tag_id.min(right.tag_id), left.tag_id.max(right.tag_id));
                        *pair_gains.entry(pair)
                            .or_insert_with(|| semantic_gain(left.tag_id, right.tag_id))
                    } else {
                        1.0
                    };
                    if left.position > 0 && right.position > 0 {
                        let count = tags.len() as f64;
                        let phi_left =
                            0.9 - 0.4 * (left.position - 1).max(0) as f64 / (count - 1.0).max(1.0);
                        let phi_right =
                            0.9 - 0.4 * (right.position - 1).max(0) as f64 / (count - 1.0).max(1.0);
                        let delta = (right.position - left.position).max(1) as f64;
                        let distance = if distance_decay > 0.0 {
                            (-distance_decay * (delta - 1.0)).exp()
                        } else {
                            1.0
                        };
                        let base = phi_left * phi_right * distance;
                        let forward = base * forward_gain * semantic;
                        let mut dynamic_reverse = reverse_gain;
                        if reverse_anchor_enabled {
                            dynamic_reverse *= anchor_gain
                                .get(&left.tag_id)
                                .copied()
                                .unwrap_or(1.0)
                                .min(reverse_anchor_max);
                        }
                        dynamic_reverse = dynamic_reverse.clamp(0.25, 0.70);
                        let backward =
                            (base * dynamic_reverse * semantic).min(forward * reverse_guard);
                        baseline_add(&mut matrix, left.tag_id, right.tag_id, forward);
                        baseline_add(&mut matrix, right.tag_id, left.tag_id, backward);
                    } else {
                        let weight = 0.7 * 0.7 * semantic;
                        baseline_add(&mut matrix, left.tag_id, right.tag_id, weight);
                        baseline_add(&mut matrix, right.tag_id, left.tag_id, weight);
                    }
                }
            }
        }
        offset = end;
    }
    Ok(matrix)
}

fn baseline_provenance(
    rows: &[FileTag],
    config: &Value,
) -> BTreeMap<(i64, i64), Vec<ProvenanceContribution>> {
    let ordered = config.get("orderedCooccurrence").unwrap_or(&Value::Null);
    let forward_gain = number(ordered, &["forwardGain"], 1.0).max(0.0);
    let reverse_gain = number(ordered, &["reverseGain"], 0.35).max(0.0);
    let distance_decay = number(ordered, &["distanceDecay"], 0.08).max(0.0);
    let mut aggregated: BTreeMap<(i64, i64, i64), f64> = BTreeMap::new();

    let mut offset = 0usize;
    while offset < rows.len() {
        let file_id = rows[offset].file_id;
        let mut end = offset + 1;
        while end < rows.len() && rows[end].file_id == file_id {
            end += 1;
        }
        let tags = &rows[offset..end];
        if tags.len() >= 2 && tags.len() <= 100 {
            for left_index in 0..tags.len() {
                for right_index in (left_index + 1)..tags.len() {
                    let left = &tags[left_index];
                    let right = &tags[right_index];
                    if left.tag_id == right.tag_id {
                        continue;
                    }
                    let delta = (right.position - left.position).max(1) as f64;
                    let distance = (-distance_decay * (delta - 1.0).max(0.0)).exp();
                    for (source, target, mass) in [
                        (left.tag_id, right.tag_id, forward_gain * distance),
                        (right.tag_id, left.tag_id, reverse_gain * distance),
                    ] {
                        *aggregated.entry((source, target, file_id)).or_default() += mass;
                    }
                }
            }
        }
        offset = end;
    }

    let mut output: BTreeMap<(i64, i64), Vec<ProvenanceContribution>> = BTreeMap::new();
    for ((source, target, file_id), mass) in aggregated {
        output
            .entry((source, target))
            .or_default()
            .push(ProvenanceContribution { file_id, mass });
    }
    output
}


    #[test]
    fn stable_sums_preserve_order_and_initial_positive_zero() {
        let input = vec![(2, -0.0), (1, 1e16), (1, -1e16), (2, 2.0), (1, 1.0)];
        let result = stable_sums(input);
        assert_eq!(result, vec![(1, 1.0), (2, 2.0)]);
        assert_eq!(stable_sums(vec![(1, -0.0)])[0].1.to_bits(), 0.0f64.to_bits());
        assert!(stable_sums::<i64>(Vec::new()).is_empty());
    }

    #[test]
    fn repeated_tags_files_positions_and_excluded_files_match_baseline_bits() {
        let mut rows = Vec::new();
        for file_id in 1..=32 {
            for (i, tag_id) in [3, 1, 3, 2, 1, 4].into_iter().enumerate() {
                rows.push(FileTag { file_id, tag_id, position: if file_id % 3 == 0 { 0 } else { i as i64 + 1 } });
            }
        }
        rows.extend((0..101).map(|i| FileTag { file_id: 33, tag_id: 1000+i, position: i+1 }));
        rows.push(FileTag { file_id: 34, tag_id: 9999, position: 1 });
        let vectors: HashMap<i64, Vec<f64>> = [(1, vec![1.0, 0.0]), (2, vec![0.0, 1.0]),
            (3, vec![0.6, 0.8]), (4, vec![-1.0, 0.0])].into_iter().collect();
        for config in [json!({}), json!({"orderedCooccurrence":{"semanticGainEnabled":true,"reverseAnchorBoost":true,"distanceDecay":0.08}}),
                       json!({"orderedCooccurrence":{"forwardGain":0.0,"reverseGain":0.0}})] {
            let anchors = [(1, 1.3), (2, 0.5)].into_iter().collect();
            let actual = build_fact_matrix(&rows, &vectors, &anchors, &config).unwrap();
            let expected = baseline_fact(&rows, &vectors, &anchors, &config).unwrap();
            assert_eq!(actual.len(), expected.len());
            for (source, edges) in &expected {
                assert_eq!(actual[source].len(), edges.len());
                for (target, weight) in edges { assert_eq!(actual[source][target].to_bits(), weight.to_bits()); }
            }
            let actual = build_provenance(&rows, &config);
            let expected = baseline_provenance(&rows, &config);
            assert_eq!(actual.len(), expected.len());
            for (edge, values) in &expected {
                assert_eq!(actual[edge].len(), values.len());
                for (a,b) in actual[edge].iter().zip(values) {
                    assert_eq!(a.file_id,b.file_id); assert_eq!(a.mass.to_bits(),b.mass.to_bits());
                }
            }
        }
    }
}

#[cfg(test)]
mod parallel_gain_tests {
    use super::*;
    #[test]
    fn thread_setting_defaults_and_invalid_values() {
        for text in [None, Some(""), Some("0"), Some("-1"), Some("oops"), Some("99999999999999999999999999")] {
            assert_eq!(configured_build_threads(text, 20), 8);
            assert_eq!(configured_build_threads(text, 2), 2);
        }
        assert_eq!(configured_build_threads(Some("1"), 20), 1);
        assert_eq!(configured_build_threads(Some("2"), 20), 2);
        assert_eq!(configured_build_threads(Some("8"), 20), 8);
        assert_eq!(configured_build_threads(None, 0), 1);
    }
    #[test]
    fn first_operand_order_duplicates_and_file_limits() {
        let mut rows = vec![FileTag{file_id:1,tag_id:3,position:1},FileTag{file_id:1,tag_id:1,position:2},
            FileTag{file_id:1,tag_id:3,position:3},FileTag{file_id:2,tag_id:1,position:1},
            FileTag{file_id:2,tag_id:3,position:2},FileTag{file_id:3,tag_id:9,position:1}];
        rows.extend((0..101).map(|i|FileTag{file_id:4,tag_id:100+i,position:i}));
        assert_eq!(semantic_pairs(&rows), vec![(3,1)]);
        assert!(semantic_pairs(&[]).is_empty());
    }
    #[test]
    fn parallel_gains_match_sequential_bits_at_one_two_eight_threads() {
        let pairs: Vec<_> = (1..=1200).map(|i|(i,i+1)).collect();
        let gain = |a:i64,b:i64| {
            let left: Vec<_> = (0..3072).map(|i|((a+i) as f64*0.013).sin()).collect();
            let right: Vec<_> = (0..3072).map(|i|((b+i) as f64*0.017).cos()).collect();
            crate::memo_geometry::dot(&left,&right)
        };
        let expected: Vec<_> = pairs.iter().map(|&(a,b)|gain(a,b).to_bits()).collect();
        for n in [1,2,8] {
            let actual: Vec<_> = evaluate_pair_gains(&pairs,&gain,n).into_iter().map(f64::to_bits).collect();
            assert_eq!(actual,expected);
        }
    }
}

#[cfg(test)]
#[path = "memo_workspace_build_tests.rs"]
mod workspace_build_tests;
