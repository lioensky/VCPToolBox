use crate::rivermemo_topology_v3::{MemoRuntime, NativeArtifact};
use flate2::write::GzEncoder;
use flate2::Compression;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, Connection, OpenFlags};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io::Write;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const PAYLOAD_SCHEMA: &str = "rivermemo-persisted-artifact-v2";
const PAYLOAD_CODEC: &str = "gzip-json-v1";
const ALGORITHM_VERSION: &str = "memo.native-artifact-v1";
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
    diary_name: String,
    path: String,
}

#[derive(Clone)]
struct ProvenanceContribution {
    file_id: i64,
    diary_name: String,
    path: String,
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

fn open_readwrite(path: &str) -> std::result::Result<Connection, String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|error| format!("open readwrite SQLite failed: {}", error))?;
    connection
        .busy_timeout(Duration::from_secs(30))
        .map_err(|error| format!("configure SQLite timeout failed: {}", error))?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| format!("configure SQLite WAL failed: {}", error))?;
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(|error| format!("configure SQLite synchronous failed: {}", error))?;
    Ok(connection)
}

fn number(config: &Value, path: &[&str], fallback: f64) -> f64 {
    let mut current = config;
    for key in path {
        let Some(next) = current.get(*key) else {
            return fallback;
        };
        current = next;
    }
    current.as_f64().filter(|value| value.is_finite()).unwrap_or(fallback)
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
            "SELECT ft.file_id, ft.tag_id, COALESCE(ft.position, 0), \
             COALESCE(f.diary_name, ''), COALESCE(f.path, '') \
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
                diary_name: row.get(3)?,
                path: row.get(4)?,
            })
        })
        .map_err(|error| format!("query file_tags failed: {}", error))?;
    let mut output = Vec::new();
    for row in rows {
        output.push(row.map_err(|error| format!("decode file_tags row failed: {}", error))?);
    }
    Ok(output)
}

fn load_pairwise(
    connection: &Connection,
    model_sig: &str,
) -> std::result::Result<HashMap<(i64, i64), f64>, String> {
    let mut statement = connection
        .prepare(
            "SELECT tag_a, tag_b, similarity FROM tag_pair_similarity WHERE model_sig = ?1",
        )
        .map_err(|error| format!("prepare pairwise failed: {}", error))?;
    let rows = statement
        .query_map(params![model_sig], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, f64>(2)?,
            ))
        })
        .map_err(|error| format!("query pairwise failed: {}", error))?;
    let mut output = HashMap::new();
    for row in rows.flatten() {
        output.insert((row.0.min(row.1), row.0.max(row.1)), row.2);
    }
    Ok(output)
}

fn load_anchor_gains(
    connection: &Connection,
) -> std::result::Result<(HashMap<i64, f64>, HashMap<i64, f64>, String), String> {
    let mut statement = connection
        .prepare(
            "SELECT tag_id, COALESCE(v9_anchor_gain, residual_energy, 1.0), \
             COALESCE(raw_residual_ratio, 0.0), COALESCE(artifact_sig, '') \
             FROM tag_intrinsic_residuals",
        )
        .map_err(|error| format!("prepare intrinsic residuals failed: {}", error))?;
    let rows = statement
        .query_map([], |row| {
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
    let mut signature = String::new();
    for row in rows.flatten() {
        gains.insert(row.0, row.1.clamp(0.5, 2.0));
        raw.insert(row.0, row.2.clamp(0.0, 1.0));
        if signature.is_empty() && !row.3.is_empty() {
            signature = row.3;
        }
    }
    Ok((gains, raw, signature))
}

fn add_edge(matrix: &mut HashMap<i64, HashMap<i64, f64>>, source: i64, target: i64, weight: f64) {
    if source == target || !weight.is_finite() || weight <= 0.0 {
        return;
    }
    *matrix.entry(source).or_default().entry(target).or_default() += weight;
}

fn build_fact_matrix(
    rows: &[FileTag],
    pairwise: &HashMap<(i64, i64), f64>,
    anchor_gain: &HashMap<i64, f64>,
    config: &Value,
) -> HashMap<i64, HashMap<i64, f64>> {
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
    let semantic_enabled = boolean(ordered, &["semanticGainEnabled"], false)
        || boolean(ordered, &["semanticGain", "enabled"], false);
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
        let key = (left.min(right), left.max(right));
        let similarity = pairwise.get(&key).copied().unwrap_or(low_fallback);
        if similarity < 0.15 {
            0.4 + similarity * 1.0
        } else {
            0.5
                + 0.8
                    * (-((similarity - semantic_peak).powi(2))
                        / (2.0 * semantic_sigma * semantic_sigma))
                        .exp()
        }
    };

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
                    let semantic = semantic_gain(left.tag_id, right.tag_id);
                    if left.position > 0 && right.position > 0 {
                        let count = tags.len() as f64;
                        let phi_left = 0.9 - 0.4 * (left.position - 1).max(0) as f64 / (count - 1.0).max(1.0);
                        let phi_right = 0.9 - 0.4 * (right.position - 1).max(0) as f64 / (count - 1.0).max(1.0);
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
                        let backward = (base * dynamic_reverse * semantic).min(forward * reverse_guard);
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
    matrix
}

fn build_transport(
    fact: &HashMap<i64, HashMap<i64, f64>>,
    anchor_gain: &HashMap<i64, f64>,
    config: &Value,
) -> (HashMap<i64, HashMap<i64, f64>>, HashSet<(i64, i64)>) {
    let v9 = config.get("v9").unwrap_or(&Value::Null);
    let outbound_mass = number(v9, &["outboundMass"], 0.95).clamp(0.01, 0.999999);
    let reserve_mass = number(v9, &["associationReserveMass"], 0.05)
        .clamp(0.0, outbound_mass);
    let evidence_compression = number(v9, &["evidenceCompression"], 1.0).max(0.01);
    let wormhole_gain = number(v9, &["wormholeGain"], 1.35).max(1.0);
    let tension_threshold = number(v9, &["tensionThreshold"], 1.0).max(0.0);
    let hub_exponent = number(v9, &["hubPenaltyExponent"], 0.3).clamp(0.0, 1.0);
    let hub_floor = number(v9, &["hubPenaltyFloor"], 0.55).clamp(0.05, 1.0);
    let hub_ceiling = number(v9, &["hubPenaltyCeiling"], 1.8).clamp(1.0, 4.0);
    let smoothing_ratio = number(v9, &["hubSmoothingRatio"], 0.1).clamp(0.01, 2.0);

    let mut raw_rows: HashMap<i64, Vec<(i64, f64, bool)>> = HashMap::new();
    let mut target_inflow: HashMap<i64, f64> = HashMap::new();
    for (source, edges) in fact {
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
    positive.sort_by(|left, right| left.total_cmp(right));
    let median = positive
        .get(positive.len() / 2)
        .copied()
        .unwrap_or(1.0);
    let smoothing = (median * smoothing_ratio).max(1e-9);

    let mut transport = HashMap::new();
    let mut wormholes = HashSet::new();
    for (source, edges) in raw_rows {
        let mut adjusted = Vec::new();
        let mut total = 0.0;
        let mut wormhole_total = 0.0;
        for (target, conductance, wormhole) in edges {
            let relative = target_inflow.get(&target).copied().unwrap_or(0.0) / (median + smoothing);
            let raw_penalty = if hub_exponent > 0.0 {
                relative.max(1e-9).powf(-hub_exponent)
            } else {
                1.0
            };
            let value = conductance * raw_penalty.clamp(hub_floor, hub_ceiling);
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
        let reserved = if wormhole_total > 0.0 { reserve_mass } else { 0.0 };
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
    let mut aggregated: BTreeMap<(i64, i64, i64), ProvenanceContribution> = BTreeMap::new();

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
                        let entry = aggregated
                            .entry((source, target, file_id))
                            .or_insert_with(|| ProvenanceContribution {
                                file_id,
                                diary_name: left.diary_name.clone(),
                                path: left.path.clone(),
                                mass: 0.0,
                            });
                        entry.mass += mass;
                    }
                }
            }
        }
        offset = end;
    }

    let mut output: BTreeMap<(i64, i64), Vec<ProvenanceContribution>> = BTreeMap::new();
    for ((source, target, _), contribution) in aggregated {
        output.entry((source, target)).or_default().push(contribution);
    }
    output
}

fn database_generation(connection: &Connection) -> String {
    let mut facts = Vec::new();
    for table in ["files", "chunks", "tags", "file_tags"] {
        let query = format!("SELECT COUNT(*), COALESCE(MAX(rowid), 0) FROM {}", table);
        let value = connection
            .query_row(&query, [], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
            })
            .unwrap_or((0, 0));
        facts.push(format!("{}:{}:{}", table, value.0, value.1));
    }
    hash_text(&facts.join("|"), 40)
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
    })
}

fn artifact_payload(
    artifact: &NativeArtifact,
    provenance: &BTreeMap<(i64, i64), Vec<ProvenanceContribution>>,
    metadata: &Value,
) -> Value {
    let provenance_edges: Vec<Value> = provenance
        .iter()
        .map(|((source, target), contributions)| {
            json!([
                format!("{}:{}", source, target),
                contributions
                    .iter()
                    .map(|item| {
                        json!([
                            item.file_id,
                            item.diary_name,
                            item.path,
                            item.mass
                        ])
                    })
                    .collect::<Vec<_>>()
            ])
        })
        .collect();
    let inbound: Vec<Value> = artifact
        .inbound
        .iter()
        .map(|(id, mass)| json!([id, mass]))
        .collect();
    let anchor_gain: Vec<Value> = artifact
        .anchor_gain
        .iter()
        .map(|(id, gain)| json!([id, gain]))
        .collect();
    let wormholes: Vec<Value> = artifact
        .wormhole_edges
        .iter()
        .map(|(source, target)| json!(format!("{}:{}", source, target)))
        .collect();

    json!({
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
            "schema": "tagmemo-v10-alpha-provenance-snapshot-v1",
            "generation": metadata["provenanceGeneration"],
            "edges": provenance_edges
        },
        "rawResidualRatioView": [],
        "anchorGainView": anchor_gain,
        "inboundMassView": inbound,
        "wormholeView": wormholes
    })
}

fn run_build(
    runtime: &MemoRuntime,
    db_path: &str,
    input_json: &str,
) -> std::result::Result<NativeMemoArtifactBuildResult, String> {
    let started = Instant::now();
    let input: BuildInput = serde_json::from_str(input_json)
        .map_err(|error| format!("invalid native artifact build JSON: {}", error))?;
    if input.model_sig.trim().is_empty() {
        return Err("native artifact build requires modelSig".to_string());
    }

    let readonly = open_readonly(db_path)?;
    let rows = load_file_tags(&readonly)?;
    let pairwise = load_pairwise(&readonly, &input.model_sig)?;
    let (anchor_gain, _raw_residuals, residual_sig) = load_anchor_gains(&readonly)?;
    let fact = build_fact_matrix(&rows, &pairwise, &anchor_gain, &input.effective_config);
    let (transport, wormholes) = build_transport(&fact, &anchor_gain, &input.effective_config);
    let provenance = build_provenance(&rows, &input.effective_config);

    let mut inbound = HashMap::new();
    for edges in transport.values() {
        for (target, weight) in edges {
            *inbound.entry(*target).or_default() += *weight;
        }
    }

    let graph_digest = {
        let mut rows = Vec::new();
        let mut sources: Vec<i64> = transport.keys().copied().collect();
        sources.sort_unstable();
        for source in sources {
            let mut edges: Vec<(i64, f64)> = transport[&source]
                .iter()
                .map(|(target, weight)| (*target, *weight))
                .collect();
            edges.sort_by_key(|item| item.0);
            rows.push(format!("{}:{:?}", source, edges));
        }
        hash_text(&rows.join("|"), 48)
    };
    let provenance_generation = {
        let rows: Vec<String> = provenance
            .iter()
            .map(|(edge, values)| {
                format!(
                    "{}:{}:{:?}",
                    edge.0,
                    edge.1,
                    values
                        .iter()
                        .map(|item| (item.file_id, item.mass))
                        .collect::<Vec<_>>()
                )
            })
            .collect();
        hash_text(&rows.join("|"), 40)
    };
    let database_generation = database_generation(&readonly);
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

    let native = build_native_artifact(
        &transport,
        inbound,
        anchor_gain,
        wormholes,
        &provenance,
    );
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
    let payload = artifact_payload(&native, &provenance, &metadata);
    let raw = serde_json::to_vec(&payload)
        .map_err(|error| format!("encode native artifact payload failed: {}", error))?;
    let checksum = sha256_hex(&raw);
    let mut encoder = GzEncoder::new(Vec::new(), Compression::new(6));
    encoder
        .write_all(&raw)
        .map_err(|error| format!("compress native artifact failed: {}", error))?;
    let compressed = encoder
        .finish()
        .map_err(|error| format!("finish native artifact compression failed: {}", error))?;

    drop(readonly);
    let mut writable = open_readwrite(db_path)?;
    let transaction = writable
        .transaction()
        .map_err(|error| format!("begin native artifact transaction failed: {}", error))?;
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
                artifact_sig,
                PAYLOAD_SCHEMA,
                ALGORITHM_VERSION,
                source_artifact_sig,
                graph_digest,
                input.model_sig,
                config_hash,
                database_generation,
                provenance_generation,
                PAYLOAD_CODEC,
                checksum,
                compressed,
                native.node_ids.len() as i64,
                native.targets.len() as i64,
                published_at
            ],
        )
        .map_err(|error| format!("persist native artifact failed: {}", error))?;
    transaction
        .commit()
        .map_err(|error| format!("commit native artifact failed: {}", error))?;

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
    })
}

pub struct NativeMemoArtifactBuildTask {
    runtime: Arc<MemoRuntime>,
    db_path: String,
    input_json: String,
}

impl Task for NativeMemoArtifactBuildTask {
    type Output = NativeMemoArtifactBuildResult;
    type JsValue = NativeMemoArtifactBuildResult;

    fn compute(&mut self) -> Result<Self::Output> {
        run_build(&self.runtime, &self.db_path, &self.input_json)
            .map_err(Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub(crate) fn rebuild_with_runtime(
    runtime: Arc<MemoRuntime>,
    db_path: String,
    input_json: String,
) -> AsyncTask<NativeMemoArtifactBuildTask> {
    AsyncTask::new(NativeMemoArtifactBuildTask {
        runtime,
        db_path,
        input_json,
    })
}