use crate::rivermemo_topology_v3::{MemoRuntime, NativeArtifact};
use crate::storage::{with_registered_read_transaction, with_registered_write};
use flate2::write::GzEncoder;
use flate2::Compression;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
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

fn add_edge(matrix: &mut HashMap<i64, HashMap<i64, f64>>, source: i64, target: i64, weight: f64) {
    if source == target || !weight.is_finite() || weight <= 0.0 {
        return;
    }
    *matrix.entry(source).or_default().entry(target).or_default() += weight;
}

fn build_fact_matrix(
    rows: &[FileTag],
    mut load_vectors: impl FnMut(&[i64]) -> std::result::Result<HashMap<i64, Vec<f64>>, String>,
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

    let semantic_gain = |vectors: &HashMap<i64, Vec<f64>>, left: i64, right: i64| -> f64 {
        if !semantic_enabled {
            return 1.0;
        }
        let similarity = vectors.get(&left).zip(vectors.get(&right))
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
            // VCP: bound high-dimensional workspace to one eligible file.
            // No vector SQL is needed when semantic gain is disabled.
            let vectors = if semantic_enabled {
                load_vectors(&tags.iter().map(|tag| tag.tag_id).collect::<Vec<_>>())?
            } else {
                HashMap::new()
            };
            for left_index in 0..tags.len() {
                for right_index in (left_index + 1)..tags.len() {
                    let left = &tags[left_index];
                    let right = &tags[right_index];
                    if left.tag_id == right.tag_id {
                        continue;
                    }
                    let semantic = semantic_gain(&vectors, left.tag_id, right.tag_id);
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
    Ok(matrix)
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
    positive.sort_by(|left, right| left.total_cmp(right));
    let median = positive.get(positive.len() / 2).copied().unwrap_or(1.0);
    let smoothing = (median * smoothing_ratio).max(1e-9);

    let mut transport = HashMap::new();
    let mut wormholes = HashSet::new();
    for (source, edges) in raw_rows {
        let mut adjusted = Vec::new();
        let mut total = 0.0;
        let mut wormhole_total = 0.0;
        for (target, conductance, wormhole) in edges {
            let relative =
                target_inflow.get(&target).copied().unwrap_or(0.0) / (median + smoothing);
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
            "schema": "tagmemo-provenance-file-mass-v2",
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
    dimension: usize,
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

    let snapshot_gate = crate::publication_gate::acquire_read(db_path, &["*".into()])?;
    let (rows, fact, anchor_gain, residual_sig, database_generation, dependencies) =
        with_registered_read_transaction(db_path, |readonly| {
            let rows = load_file_tags(readonly)?;
            let (anchor_gain, _raw_residuals, residual_sig) = load_anchor_gains(readonly, &input.model_sig)?;
            let fact = build_fact_matrix(
                &rows,
                |ids| crate::memo_geometry::read_unit_vectors(readonly, ids, dimension)
                    .map(|(vectors, _)| vectors),
                &anchor_gain,
                &input.effective_config,
            )?;
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
    drop(provenance);
    let raw = serde_json::to_vec(&payload)
        .map_err(|error| format!("encode native artifact payload failed: {}", error))?;
    drop(payload);
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
mod bounded_workspace_tests {
    use super::*;

    #[test]
    fn file_vector_workspace_is_bounded_and_matches_full_source_bits() {
        let rows: Vec<_> = (1..=300).flat_map(|file_id| {
            (1..=4).map(move |position| FileTag {
                file_id, tag_id: file_id + position, position,
            })
        }).collect();
        let vectors: HashMap<_, _> = (1..=304).map(|id| {
            let x = id as f64 * 0.013;
            (id, vec![x.cos(), x.sin()])
        }).collect();
        let config = json!({"orderedCooccurrence":{"semanticGainEnabled":true}});
        let mut calls = 0;
        let bounded = build_fact_matrix(&rows, |ids| {
            calls += 1;
            assert!(ids.len() <= 100);
            Ok(ids.iter().filter_map(|id| vectors.get(id).map(|v| (*id, v.clone()))).collect())
        }, &HashMap::new(), &config).unwrap();
        let full = build_fact_matrix(&rows, |_| Ok(vectors.clone()),
            &HashMap::new(), &config).unwrap();
        assert_eq!(calls, 300);
        for (source, edges) in &full {
            for (target, weight) in edges {
                assert_eq!(bounded[source][target].to_bits(), weight.to_bits());
            }
        }
        let plain = build_fact_matrix(&rows, |_| {
            panic!("semantic gain disabled must not read vectors")
        }, &HashMap::new(), &json!({})).unwrap();
        assert!(!plain.is_empty());
    }
}
