#[cfg(test)]
use crate::memo_sensing::sense_typed;
use crate::memo_sensing::{sense_with_context, DynamicWormholeContext,
    SenseConfig, SenseDiagnostics, SenseInput, SenseOutput, SenseSeed};
use crate::rivermemo_topology_v3::{load_artifact_with_connection, MemoRuntime};
use crate::storage::with_registered_read_transaction;
use base64::Engine;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
#[cfg(test)]
use std::collections::BinaryHeap;
use std::sync::{Arc};
use std::time::Instant;
use crate::storage::{ensure_tag_vectors_loaded, TagVectorPool};
#[cfg(test)]
use crate::storage::load_vectors_by_ids;

const PIPELINE_SCHEMA: &str = "vexus-unified-memo-pipeline-v1";
const PIPELINE_ALGORITHM: &str = "memo.conservative-topology-v2.2";

fn positive(value: f64) -> f64 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

fn clamp01(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn magnitude(vector: &[f32]) -> f64 {
    vector
        .iter()
        .map(|value| (*value as f64) * (*value as f64))
        .sum::<f64>()
        .sqrt()
}

fn dot(left: &[f32], right: &[f32]) -> f64 {
    left.iter()
        .zip(right.iter())
        .map(|(a, b)| (*a as f64) * (*b as f64))
        .sum()
}

fn cosine(left: &[f32], right: &[f32]) -> f64 {
    if left.len() != right.len() || left.is_empty() {
        return 0.0;
    }
    let denominator = magnitude(left) * magnitude(right);
    if denominator > 1e-12 {
        dot(left, right) / denominator
    } else {
        0.0
    }
}

fn normalize(vector: &mut [f64]) -> bool {
    let norm = vector.iter().map(|value| value * value).sum::<f64>().sqrt();
    if norm <= 1e-12 {
        return false;
    }
    for value in vector {
        *value /= norm;
    }
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PipelineInput {
    #[serde(default)]
    query_id: Option<String>,
    #[serde(default, rename = "queryText")]
    query_text: String,
    #[serde(default)]
    query_vector: Vec<f32>,
    #[serde(default)]
    core_tags: Vec<String>,
    #[serde(default)]
    ghost_tags: Vec<GhostTagInput>,
    #[serde(default)]
    config: PipelineConfig,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhostTagInput {
    name: String,
    #[serde(default)]
    vector: Vec<f32>,
    #[serde(default)]
    is_core: bool,
}

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct PipelineConfig {
    base_tag_boost: f64,
    core_boost_factor: f64,
    local_alpha: f64,
    transfer_alpha: f64,
    field_max_iterations: usize,
    local_tolerance: f64,
    transfer_tolerance: f64,
    local_mass_ratio: f64,
    transfer_mass_ratio: f64,
    max_field_projection_nodes: usize,
    max_levels: usize,
    pyramid_top_k: usize,
    min_energy_ratio: f64,
    layer_decay: f64,
    min_layer_explained_energy: f64,
    seed_contribution_ratio: f64,
    seed_contribution_floor: f64,
    activation_multiplier: Vec<f64>,
    dynamic_boost_range: Vec<f64>,
    core_boost_range: Vec<f64>,
    lang_confidence_enabled: bool,
    lang_penalty_unknown: f64,
    lang_penalty_cross_domain: f64,
    deduplication_threshold: f64,
    max_fusion_tags: usize,
    max_emergent_nodes: usize,
    tech_tag_threshold: f64,
    normal_tag_threshold: f64,
    epa_gate_mode: String,
    #[serde(default)]
    spike_routing: SenseConfig,
}

impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            base_tag_boost: 0.6,
            core_boost_factor: 1.33,
            local_alpha: 0.15,
            transfer_alpha: 0.55,
            field_max_iterations: 80,
            local_tolerance: 1e-9,
            transfer_tolerance: 1e-9,
            local_mass_ratio: 0.8,
            transfer_mass_ratio: 0.9,
            max_field_projection_nodes: 256,
            max_levels: 3,
            pyramid_top_k: 10,
            min_energy_ratio: 0.1,
            layer_decay: 0.7,
            min_layer_explained_energy: 0.03,
            seed_contribution_ratio: 0.1,
            seed_contribution_floor: 0.05,
            activation_multiplier: vec![0.5, 1.5],
            dynamic_boost_range: vec![0.3, 2.0],
            core_boost_range: vec![1.2, 1.4],
            lang_confidence_enabled: true,
            lang_penalty_unknown: 0.05,
            lang_penalty_cross_domain: 0.2,
            deduplication_threshold: 0.88,
            max_fusion_tags: 128,
            max_emergent_nodes: 50,
            tech_tag_threshold: 0.08,
            normal_tag_threshold: 0.015,
            epa_gate_mode: "backgroundRelative".into(),
            spike_routing: SenseConfig::default(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EpaCache {
    basis: Vec<String>,
    mean: String,
    #[serde(default, rename = "energies")]
    _energies: Vec<f64>,
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default = "default_k_sem")]
    k_sem: usize,
    #[serde(default)]
    coverage: Vec<f64>,
}

fn default_k_sem() -> usize { 8 }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EpaAxis {
    index: usize,
    label: String,
    energy: f64,
    projection: f64,
    score: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EpaBridge {
    from: String,
    to: String,
    strength: f64,
    balance: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EpaOutput {
    logic_depth: f64,
    entropy: f64,
    resonance: f64,
    dominant_axes: Vec<EpaAxis>,
    bridges: Vec<EpaBridge>,
    basis_count: usize,
    cache_available: bool,
    out_of_domain: f64,
    semantic_explained_ratio: f64,
    in_domain_gate: f64,
    baseline_coverage: f64,
    background_ratio: f64,
}

fn decode_f32_base64(encoded: &str, dimension: usize) -> Option<Vec<f32>> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    if bytes.len() != dimension * std::mem::size_of::<f32>() {
        return None;
    }
    Some(
        bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_ne_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            .collect(),
    )
}

#[cfg(test)]
fn analyze_epa(connection: &Connection, query: &[f32], dimension: usize) -> EpaOutput {
    analyze_epa_with_mode(connection, query, dimension, "absolute")
}

/// Background is the ratio of expected energies for an isotropic unit query after
/// subtracting the same mean. It is a calibration reference, not an OOD probability.
fn calibrated_gate(ratio: f64, baseline: f64, background: f64, mode: &str) -> f64 {
    match mode {
        "relativeLinear" => clamp01(ratio / baseline),
        "relativeSqrt" => clamp01((ratio / baseline).max(0.0).sqrt()),
        "backgroundRelative" => {
            if baseline <= background + 1e-8 { 0.0 }
            else { clamp01((ratio-background)/(baseline-background)) }
        },
        _ => clamp01(ratio),
    }
}

/// Query-independent part of the EPA cache row: decoded basis and mean, and the
/// values derived from them alone.
struct EpaBasis {
    raw: String,
    dimension: usize,
    k_sem: usize,
    labels: Vec<String>,
    mean: Vec<f32>,
    bases: Vec<Vec<f32>>,
    semantic_count: usize,
    baseline_coverage: f64,
    background_ratio: f64,
}

/// The most recently decoded EPA cache row. It is reused only when the stored
/// JSON text and the dimension are identical, so any write to the row (in any
/// database) decodes again; the per-query arithmetic is unchanged.
static EPA_BASIS: std::sync::Mutex<Option<Arc<EpaBasis>>> = std::sync::Mutex::new(None);

fn decode_epa_basis(raw: String, dimension: usize) -> Option<EpaBasis> {
    let cache: EpaCache = serde_json::from_str(&raw).ok()?;
    let mean = decode_f32_base64(&cache.mean, dimension)?;
    let bases: Vec<Vec<f32>> = cache
        .basis
        .iter()
        .filter_map(|encoded| decode_f32_base64(encoded, dimension))
        .collect();
    let semantic_count = cache.k_sem.max(1).min(bases.len());
    let baseline_coverage=cache.coverage.get(semantic_count.saturating_sub(1)).copied()
        .filter(|v|v.is_finite() && *v>0.0 && *v<=1.0)
        .unwrap_or(semantic_count as f64/dimension.max(1) as f64).max(1e-4);
    let mean_captured=bases.iter().take(semantic_count).map(|b|dot(&mean,b).powi(2)).sum::<f64>();
    let background_ratio=clamp01((semantic_count as f64/dimension.max(1) as f64+mean_captured)
        /(1.0+dot(&mean,&mean)));
    Some(EpaBasis {
        raw, dimension, k_sem: cache.k_sem, labels: cache.labels, mean, bases,
        semantic_count, baseline_coverage, background_ratio,
    })
}

fn analyze_epa_with_mode(connection: &Connection, query: &[f32], dimension: usize, mode: &str) -> EpaOutput {
    let empty = || EpaOutput {
        logic_depth: 0.0,
        entropy: 1.0,
        resonance: 0.0,
        dominant_axes: Vec::new(),
        bridges: Vec::new(),
        basis_count: 0,
        cache_available: false,
        out_of_domain: 1.0,
        semantic_explained_ratio: 0.0,
        in_domain_gate: 0.0,
        baseline_coverage: 0.0,
        background_ratio: 0.0,
    };
    let raw = match connection.query_row(
        "SELECT value FROM kv_store WHERE key = 'epa_basis_cache'",
        [],
        |row| row.get::<_, String>(0),
    ) {
        Ok(value) => value,
        Err(_) => return empty(),
    };
    let cached = EPA_BASIS.lock().ok().and_then(|slot| {
        slot.as_ref().filter(|basis| basis.dimension == dimension && basis.raw == raw).cloned()
    });
    let basis = match cached {
        Some(basis) => basis,
        None => match decode_epa_basis(raw, dimension) {
            Some(basis) => {
                let basis = Arc::new(basis);
                if let Ok(mut slot) = EPA_BASIS.lock() {
                    *slot = Some(basis.clone());
                }
                basis
            }
            None => return empty(),
        },
    };
    let mean = &basis.mean;
    let bases = &basis.bases;
    let centered: Vec<f32> = query
        .iter()
        .zip(mean.iter())
        .map(|(value, average)| value - average)
        .collect();
    let projections: Vec<f64> = bases.iter().map(|basis| dot(&centered, basis)).collect();
    let centered_energy = dot(&centered, &centered);
    let captured = projections.iter().map(|value| value * value).sum::<f64>();
    let out_of_domain = if centered_energy > 1e-12 {
        ((centered_energy - captured).max(0.0) / centered_energy).sqrt().clamp(0.0, 1.0)
    } else { 0.0 };
    let semantic_count = basis.semantic_count;
    let total_energy = projections.iter().take(semantic_count).map(|value| value * value).sum::<f64>();
    let semantic_explained_ratio = if centered_energy > 1e-12 {
        clamp01(total_energy / centered_energy)
    } else { 0.0 };
    let baseline_coverage = basis.baseline_coverage;
    let background_ratio = basis.background_ratio;
    let in_domain_gate=if semantic_count==0 || centered_energy<=1e-12 {0.0}
        else {calibrated_gate(semantic_explained_ratio,baseline_coverage,background_ratio,mode)};
    let probabilities: Vec<f64> = projections
        .iter().take(semantic_count)
        .map(|value| if total_energy > 1e-12 { value * value / total_energy } else { 0.0 })
        .collect();
    let raw_entropy = probabilities
        .iter()
        .filter(|value| **value > 1e-9)
        .map(|value| -value * value.log2())
        .sum::<f64>();
    let normalized_entropy = if total_energy <= 1e-12 {
        1.0
    } else if basis.k_sem > 1 {
        clamp01(raw_entropy / (basis.k_sem as f64).log2())
    } else {
        0.0
    };
    let mut dominant_axes: Vec<EpaAxis> = probabilities
        .iter()
        .enumerate()
        .filter(|(_, energy)| **energy > 0.05)
        .map(|(index, energy)| EpaAxis {
            index,
            label: basis
                .labels
                .get(index)
                .cloned()
                .unwrap_or_else(|| "Unknown".to_string()),
            energy: *energy,
            projection: projections[index],
            score: *energy,
        })
        .collect();
    dominant_axes.sort_by(|left, right| {
        right
            .energy
            .partial_cmp(&left.energy)
            .unwrap_or(Ordering::Equal)
    });

    let mut bridges = Vec::new();
    if let Some(primary) = dominant_axes.first() {
        for secondary in dominant_axes.iter().skip(1) {
            let strength = (primary.energy * secondary.energy).sqrt();
            if strength > 0.15 {
                bridges.push(EpaBridge {
                    from: primary.label.clone(),
                    to: secondary.label.clone(),
                    strength,
                    balance: if primary.energy.max(secondary.energy) > 0.0 {
                        primary.energy.min(secondary.energy) / primary.energy.max(secondary.energy)
                    } else {
                        0.0
                    },
                });
            }
        }
    }
    let resonance = bridges.iter().map(|bridge| bridge.strength).sum();

    EpaOutput {
        logic_depth: (1.0 - normalized_entropy) * in_domain_gate,
        entropy: normalized_entropy,
        resonance,
        dominant_axes,
        bridges,
        basis_count: bases.len(),
        cache_available: true,
        out_of_domain,
        semantic_explained_ratio,
        in_domain_gate,
        baseline_coverage,
        background_ratio,
    }
}

#[derive(Clone)]
struct PyramidTagWork {
    id: i64,
    name: String,
    vector: Arc<[f32]>,
    similarity: f64,
    contribution: f64,
    handshake_magnitude: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PyramidTagOutput {
    id: i64,
    name: String,
    similarity: f64,
    contribution: f64,
    handshake_magnitude: f64,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct HandshakeFeatures {
    direction_coherence: f64,
    pattern_strength: f64,
    novelty_signal: f64,
    noise_signal: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PyramidLevelOutput {
    level: usize,
    tags: Vec<PyramidTagOutput>,
    projection_magnitude: f64,
    residual_magnitude: f64,
    residual_energy_ratio: f64,
    energy_explained: f64,
    handshake_features: HandshakeFeatures,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct PyramidFeatures {
    depth: usize,
    coverage: f64,
    novelty: f64,
    coherence: f64,
    activation: f64,
    expansion_signal: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PyramidOutput {
    levels: Vec<PyramidLevelOutput>,
    total_explained_energy: f64,
    features: PyramidFeatures,
}

fn orthogonal_projection(
    query: &[f32],
    tags: &[PyramidTagWork],
    dimension: usize,
) -> (Vec<f32>, Vec<f32>, Vec<f64>) {
    let mut basis: Vec<Vec<f64>> = Vec::with_capacity(tags.len());
    let mut coefficients = vec![0.0; tags.len()];
    for (index, tag) in tags.iter().enumerate() {
        let mut vector: Vec<f64> = tag.vector.iter().map(|value| *value as f64).collect();
        for unit in &basis {
            let projection = vector
                .iter()
                .zip(unit.iter())
                .map(|(left, right)| left * right)
                .sum::<f64>();
            for offset in 0..dimension {
                vector[offset] -= projection * unit[offset];
            }
        }
        if normalize(&mut vector) {
            coefficients[index] = query
                .iter()
                .zip(vector.iter())
                .map(|(left, right)| (*left as f64) * right)
                .sum::<f64>()
                .abs();
            basis.push(vector);
        }
    }

    let mut projection = vec![0.0f32; dimension];
    for unit in &basis {
        let coefficient = query
            .iter()
            .zip(unit.iter())
            .map(|(left, right)| (*left as f64) * right)
            .sum::<f64>();
        for offset in 0..dimension {
            projection[offset] += (coefficient * unit[offset]) as f32;
        }
    }
    let residual = query
        .iter()
        .zip(projection.iter())
        .map(|(source, explained)| source - explained)
        .collect();
    (projection, residual, coefficients)
}

fn analyze_handshakes(
    query: &[f32],
    tags: &mut [PyramidTagWork],
    dimension: usize,
) -> HandshakeFeatures {
    if tags.is_empty() {
        return HandshakeFeatures::default();
    }
    let mut directions = Vec::with_capacity(tags.len());
    let mut average = vec![0.0f64; dimension];
    for tag in tags.iter_mut() {
        let mut direction = vec![0.0f64; dimension];
        let mut magnitude_squared = 0.0;
        for offset in 0..dimension {
            let delta = (query[offset] - tag.vector[offset]) as f64;
            direction[offset] = delta;
            magnitude_squared += delta * delta;
        }
        let distance = magnitude_squared.sqrt();
        tag.handshake_magnitude = distance;
        if distance > 1e-9 {
            for offset in 0..dimension {
                direction[offset] /= distance;
                average[offset] += direction[offset];
            }
        }
        directions.push(direction);
    }
    for value in &mut average {
        *value /= tags.len() as f64;
    }
    let direction_coherence = clamp01(
        average
            .iter()
            .map(|value| value * value)
            .sum::<f64>()
            .sqrt(),
    );
    let limit = directions.len().min(5);
    let mut pairwise_sum = 0.0;
    let mut pair_count = 0usize;
    for left in 0..limit {
        for right in (left + 1)..limit {
            pairwise_sum += directions[left]
                .iter()
                .zip(directions[right].iter())
                .map(|(a, b)| a * b)
                .sum::<f64>()
                .abs();
            pair_count += 1;
        }
    }
    let pattern_strength = if pair_count > 0 {
        clamp01(pairwise_sum / pair_count as f64)
    } else {
        0.0
    };
    HandshakeFeatures {
        direction_coherence,
        pattern_strength,
        novelty_signal: direction_coherence,
        noise_signal: (1.0 - direction_coherence) * (1.0 - pattern_strength),
    }
}

fn load_tag_names(
    connection: &Connection,
    ids: &[i64],
) -> std::result::Result<HashMap<i64, String>, String> {
    let mut names = HashMap::new();
    let mut unique = ids.to_vec();
    unique.sort_unstable();
    unique.dedup();
    for batch in unique.chunks(128) {
        let sql = format!("SELECT id, name FROM tags WHERE id IN ({})",
            vec!["?"; batch.len()].join(","));
        let mut statement = connection.prepare(&sql)
            .map_err(|error| format!("prepare Memo Tag names failed: {error}"))?;
        let rows = statement.query_map(rusqlite::params_from_iter(batch.iter()), |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        }).map_err(|error| format!("query Memo Tag names failed: {error}"))?;
        for row in rows {
            if let Ok((id, name)) = row { names.insert(id, name); }
        }
    }
    Ok(names)
}

#[cfg(test)]
fn analyze_pyramid(
    index: &Arc<crate::index_handle::IndexHandle>,
    connection: &Connection,
    query: &[f32],
    dimension: usize,
    config: &PipelineConfig,
) -> std::result::Result<(PyramidOutput, Vec<Vec<PyramidTagWork>>), String> {
    analyze_pyramid_with_pool(index, connection, query, dimension, config, &mut TagVectorPool::new(), None)
        .map(|(output, tags, _)| (output, tags))
}

fn analyze_pyramid_with_pool(
    index: &Arc<crate::index_handle::IndexHandle>,
    connection: &Connection,
    query: &[f32],
    dimension: usize,
    config: &PipelineConfig,
    tag_vectors: &mut TagVectorPool,
    eligible: Option<&HashMap<i64, usize>>,
) -> std::result::Result<(PyramidOutput, Vec<Vec<PyramidTagWork>>, Vec<Vec<f32>>), String> {
    let original_energy = magnitude(query).powi(2);
    if original_energy <= 1e-12 {
        return Ok((
            PyramidOutput {
                levels: Vec::new(),
                total_explained_energy: 0.0,
                features: PyramidFeatures {
                    novelty: 1.0,
                    expansion_signal: 1.0,
                    ..PyramidFeatures::default()
                },
            },
            Vec::new(),
            Vec::new(),
        ));
    }

    let mut residual = query.to_vec();
    let mut levels_output = Vec::new();
    let mut levels_work = Vec::new();
    let mut residuals = Vec::new();
    let mut total_explained = 0.0;
    for level in 0..config.max_levels.clamp(1, 8) {
        let guard = index.read().map_err(|error| format!("Pyramid index lock failed: {}", error))?;
        let matches = guard
            .search_sql(connection, None, &residual, config.pyramid_top_k.clamp(1, 128))
            .map_err(|error| format!("Memo pyramid retrieval search failed: {:?}", error))?;
        if matches.is_empty() {
            break;
        }
        // Filter before Gram-Schmidt: graph-external tags cannot consume energy
        // that no admitted propagation seed can carry. Do not require outdegree.
        let ids: Vec<i64> = matches.iter().map(|(id, _)| *id as i64)
            .filter(|id| eligible.map_or(true, |nodes| nodes.contains_key(id))).collect();
        drop(guard);
        ensure_tag_vectors_loaded(connection, tag_vectors, &ids, dimension)?;
        let mut tags = Vec::new();
        for id in &ids {
            let Some(vector) = tag_vectors.get(id).cloned() else { continue };
            let similarity = cosine(&residual, &vector);
            tags.push(PyramidTagWork {
                id: *id,
                name: String::new(),
                vector,
                similarity,
                contribution: 0.0,
                handshake_magnitude: 0.0,
            });
        }
        let names = load_tag_names(connection, &ids)?;
        for tag in &mut tags {
            tag.name = names.get(&tag.id).cloned().unwrap_or_else(|| format!("Tag#{}", tag.id));
        }
        if tags.is_empty() {
            break;
        }

        let current_energy = magnitude(&residual).powi(2);
        let (projection, next_residual, coefficients) =
            orthogonal_projection(&residual, &tags, dimension);
        for (tag, coefficient) in tags.iter_mut().zip(coefficients.iter()) {
            tag.contribution = *coefficient / current_energy.sqrt().max(1e-12);
        }
        let handshake = analyze_handshakes(&residual, &mut tags, dimension);
        let residual_magnitude = magnitude(&next_residual);
        let residual_energy = residual_magnitude * residual_magnitude;
        let energy_explained = positive(current_energy - residual_energy) / original_energy;
        // A large remaining residual is not evidence that another layer is useful.
        // Reject before publishing work/residuals, including dynamic-wormhole inputs.
        if energy_explained < config.min_layer_explained_energy.clamp(0.0, 1.0) {
            break;
        }
        total_explained += energy_explained;
        levels_output.push(PyramidLevelOutput {
            level,
            tags: tags
                .iter()
                .map(|tag| PyramidTagOutput {
                    id: tag.id,
                    name: tag.name.clone(),
                    similarity: tag.similarity,
                    contribution: tag.contribution,
                    handshake_magnitude: tag.handshake_magnitude,
                })
                .collect(),
            projection_magnitude: magnitude(&projection),
            residual_magnitude,
            residual_energy_ratio: residual_energy / original_energy,
            energy_explained,
            handshake_features: handshake,
        });
        if config.spike_routing.dynamic_wormholes {
            residuals.push(residual.clone());
        }
        levels_work.push(tags);
        residual = next_residual;
        if residual_energy / original_energy < config.min_energy_ratio.clamp(0.0, 1.0) {
            break;
        }
    }

    // One pre-strip residual per accepted layer, followed by the unexplained
    // tail. The tail supplies routing evidence only, never another seed layer.
    let tail_energy = magnitude(&residual).powi(2);
    if config.spike_routing.dynamic_wormholes && !levels_work.is_empty()
        && tail_energy.is_finite() && tail_energy > 1e-12
        && tail_energy / original_energy >= 0.02 {
        residuals.push(residual);
    }

    let coverage = clamp01(total_explained);
    let first_handshake = levels_output
        .first()
        .map(|level| level.handshake_features.clone())
        .unwrap_or_default();
    let novelty = clamp01((1.0 - coverage) * 0.7 + first_handshake.novelty_signal * 0.3);
    let coherence = first_handshake.pattern_strength;
    let activation = clamp01(coverage * coherence * (1.0 - first_handshake.noise_signal));
    let features = PyramidFeatures {
        depth: levels_output.len(),
        coverage,
        novelty,
        coherence,
        activation,
        expansion_signal: novelty,
    };
    Ok((
        PyramidOutput {
            levels: levels_output,
            total_explained_energy: total_explained,
            features,
        },
        levels_work,
        residuals,
    ))
}

#[derive(Clone)]
struct GatedTag {
    id: i64,
    name: String,
    weight: f64,
    is_core: bool,
    lexical: bool,
}

// ASCII words have token boundaries; CJK uses adjacent bigrams (singletons
// only for one-character runs). Punctuation never joins unrelated ASCII words.
fn lexical_tokens(text: &str) -> HashSet<String> {
    let mut tokens = HashSet::new();
    let mut ascii = String::new();
    let mut cjk = Vec::new();
    let flush = |ascii: &mut String, cjk: &mut Vec<char>, tokens: &mut HashSet<String>| {
        if !ascii.is_empty() { tokens.insert(std::mem::take(ascii)); }
        if cjk.len() == 1 { tokens.insert(cjk[0].to_string()); }
        for pair in cjk.windows(2) { tokens.insert(pair.iter().collect()); }
        cjk.clear();
    };
    for ch in text.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            if !cjk.is_empty() { flush(&mut ascii, &mut cjk, &mut tokens); }
            ascii.push(ch);
        } else if ('\u{4e00}'..='\u{9fff}').contains(&ch) {
            if !ascii.is_empty() { flush(&mut ascii, &mut cjk, &mut tokens); }
            cjk.push(ch);
        } else { flush(&mut ascii, &mut cjk, &mut tokens); }
    }
    flush(&mut ascii, &mut cjk, &mut tokens);
    tokens
}

fn lexical_grounding(query: &str, name: &str) -> f64 {
    let query = lexical_tokens(query);
    let tag = lexical_tokens(name);
    if tag.is_empty() { return 0.0; }
    tag.intersection(&query).count() as f64 / tag.len() as f64
}

fn range_value(values: &[f64], index: usize, fallback: f64) -> f64 {
    values
        .get(index)
        .copied()
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
}

fn contains_cjk(value: &str) -> bool {
    value
        .chars()
        .any(|character| ('\u{4e00}'..='\u{9fff}').contains(&character))
}

fn technical_name(value: &str, allow_space: bool) -> bool {
    !contains_cjk(value)
        && value.chars().count() > 3
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '-' | '_' | '.')
                || (allow_space && character.is_ascii_whitespace())
        })
}

#[cfg(test)]
fn gate_tags(
    levels: &[Vec<PyramidTagWork>],
    epa: &EpaOutput,
    pyramid: &PyramidOutput,
    core_tags: &[String],
    config: &PipelineConfig,
    query_text: &str,
) -> (Vec<GatedTag>, f64, f64) {
    gate_tags_for_graph(levels, epa, pyramid, core_tags, config, query_text, None, &[])
}

fn scale_implicit_seeds(gated: &mut [GatedTag], eligible: Option<&HashMap<i64, usize>>) {
    let explicit_max = gated.iter().filter(|t| (t.is_core || t.lexical)
        && eligible.map_or(true, |ids| ids.contains_key(&t.id)))
        .map(|t| t.weight).fold(0.0, f64::max);
    let implicit_max = gated.iter().filter(|t| !t.is_core && !t.lexical)
        .map(|t| t.weight).fold(0.0, f64::max);
    if explicit_max > 0.0 && implicit_max > 0.35 * explicit_max {
        let scale = 0.35 * explicit_max / implicit_max;
        for tag in gated {
            if !tag.is_core && !tag.lexical { tag.weight *= scale; }
        }
    }
}

/// Resolve explicit names against SQL originals without inventing graph nodes.
/// Hard ghosts may bind to real Tags; soft and unknown ghosts stay fusion-only.
fn resolve_core_seeds(
    connection: &Connection,
    core_tags: &[String],
    ghost_tags: &[GhostTagInput],
    eligible: &HashMap<i64, usize>,
    pool: &mut TagVectorPool,
    dimension: usize,
) -> std::result::Result<Vec<(i64, String)>, String> {
    let mut statement = connection.prepare(
        "SELECT id, name FROM tags WHERE lower(name) = lower(?1) LIMIT 1"
    ).map_err(|error| format!("prepare Memo core seed query failed: {error}"))?;
    let mut resolved = Vec::new();
    let mut seen = HashSet::new();
    for name in core_tags.iter().map(String::as_str)
        .chain(ghost_tags.iter().filter(|tag| tag.is_core).map(|tag| tag.name.as_str())) {
        let name = name.trim();
        if name.is_empty() { continue; }
        let row = statement.query_row(rusqlite::params![name], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        });
        match row {
            Ok((id, name)) if id > 0 && eligible.contains_key(&id) && seen.insert(id) => {
                resolved.push((id, name));
            }
            Ok(_) | Err(rusqlite::Error::QueryReturnedNoRows) => {}
            Err(error) => return Err(format!("query Memo core seed failed: {error}")),
        }
    }
    let ids: Vec<i64> = resolved.iter().map(|tag| tag.0).collect();
    ensure_tag_vectors_loaded(connection, pool, &ids, dimension)?;
    resolved.retain(|(id, _)| pool.get(id).is_some_and(|v| magnitude(v) > 1e-12));
    Ok(resolved)
}

fn gate_tags_for_graph(
    levels: &[Vec<PyramidTagWork>], epa: &EpaOutput, pyramid: &PyramidOutput,
    core_tags: &[String], config: &PipelineConfig, query_text: &str,
    eligible: Option<&HashMap<i64, usize>>,
    explicit_cores: &[(i64, String)],
) -> (Vec<GatedTag>, f64, f64) {
    let activation_min = range_value(&config.activation_multiplier, 0, 0.5);
    let activation_max = range_value(&config.activation_multiplier, 1, 1.5);
    let activation_multiplier =
        activation_min + pyramid.features.activation * (activation_max - activation_min);
    let dynamic_factor = epa.logic_depth * (1.0 + epa.resonance.ln_1p())
        / (1.0 + epa.entropy * 0.5)
        * activation_multiplier;
    let boost_min = range_value(&config.dynamic_boost_range, 0, 0.3);
    let boost_max = range_value(&config.dynamic_boost_range, 1, 2.0);
    let effective_boost =
        positive(config.base_tag_boost) * dynamic_factor.clamp(boost_min, boost_max);

    let core_metric = epa.logic_depth * 0.5 + (1.0 - pyramid.features.coverage) * 0.5;
    let core_min = range_value(&config.core_boost_range, 0, 1.2);
    let core_max = range_value(&config.core_boost_range, 1, 1.4);
    let dynamic_core_boost = core_min + core_metric * (core_max - core_min);
    let core_names: HashSet<String> = core_tags.iter().map(|name| name.trim().to_lowercase())
        .chain(explicit_cores.iter().map(|(_, name)| name.to_lowercase())).collect();
    let world = epa
        .dominant_axes
        .first()
        .map(|axis| axis.label.as_str())
        .unwrap_or("Unknown");
    let world_lower = world.to_ascii_lowercase();
    let social_world = ["politics", "society", "history", "economics", "culture"]
        .iter()
        .any(|token| world_lower.contains(token));
    let technical_world = world != "Unknown" && technical_name(world, false);

    let mut seen = HashSet::new();
    let mut gated = Vec::new();
    for (level, tags) in levels.iter().enumerate() {
        let maximum = tags.iter().map(|tag| positive(tag.contribution)).fold(0.0, f64::max);
        let threshold = (maximum * config.seed_contribution_ratio.clamp(0.0, 1.0))
            .max(config.seed_contribution_floor.max(0.0));
        let dominant = tags.first().filter(|tag|
            tag.contribution.powi(2) > 0.85 && tag.similarity > 0.0);
        // At most two redundant directions borrow amplitude; the sum is bounded.
        // Raw orthogonal contributions and residuals remain untouched.
        let mut redundancy_left = dominant.map_or(0.0, |tag| 0.3 * tag.contribution);
        let mut redundancy_slots = 2usize;
        for tag in tags {
            let is_core = core_names.contains(&tag.name.to_lowercase());
            if tag.id <= 0 || seen.contains(&tag.id) {
                continue;
            }
            let grounding = lexical_grounding(query_text, &tag.name);
            let lexical = grounding >= 0.5;
            // Only already independently supported peers can lend amplitude.
            // A low-contribution alias cannot recursively sponsor other aliases.
            let sponsor = tags.iter().filter(|peer| peer.id != tag.id
                && peer.contribution >= threshold && peer.similarity > 0.0)
                .filter_map(|peer| {
                    let tightness = clamp01(cosine(&peer.vector, &tag.vector));
                    (tightness >= 0.80).then_some(peer.contribution * tightness)
                }).fold(0.0, f64::max);
            let alias = tag.similarity >= 0.20 && sponsor > 0.0;
            let collapsed_redundant = !is_core && !lexical && tag.contribution < 1e-6
                && tag.similarity >= 0.75
                && dominant.is_some_and(|first| first.id != tag.id
                    && cosine(&first.vector, &tag.vector) >= 0.90);
            let redundant = collapsed_redundant && redundancy_slots > 0;
            if collapsed_redundant && !redundant { continue; }
            let redundancy_floor = if redundant {
                let first = dominant.unwrap();
                let borrowed = (0.15 * first.contribution
                    * clamp01(tag.similarity / first.similarity)
                    * clamp01(cosine(&first.vector, &tag.vector))).min(redundancy_left);
                redundancy_left -= borrowed;
                redundancy_slots -= 1;
                borrowed
            } else { 0.0 };
            if !is_core && !lexical && !alias
                && (tag.contribution < threshold || tag.similarity <= 0.0) {
                continue;
            }
            let effective_contribution = if lexical {
                // Preserve 1.1 literal-focus ignition independently of alias policy.
                tag.contribution.max(0.6 * sponsor).max(0.6 * maximum)
            } else if redundant {
                tag.contribution.max(redundancy_floor)
            } else if alias {
                tag.contribution.max(0.6 * sponsor * tag.similarity.clamp(0.2, 1.0))
            } else { tag.contribution };
            seen.insert(tag.id);
            // Cosine zero is a measured orthogonal relationship, not a
            // missing-score sentinel. Every pyramid candidate is measured
            // against its SQL original before entering this gate.
            let relevance = tag.similarity;
            let core_gain = if is_core {
                dynamic_core_boost * (0.95 + relevance * 0.1)
            } else {
                1.0
            };
            let mut language_gain = 1.0;
            if !lexical && config.lang_confidence_enabled && technical_name(&tag.name, true) && !technical_world
            {
                let penalty = if world == "Unknown" {
                    config.lang_penalty_unknown
                } else {
                    config.lang_penalty_cross_domain
                }
                .clamp(0.0, 1.0);
                language_gain = if social_world {
                    penalty.sqrt()
                } else {
                    penalty
                };
            }
            let decay = config.layer_decay.clamp(0.0, 1.0).powi(level as i32);
            // Restore, never amplify, strong residual foci in accepted layers.
            let independent_support = clamp01(effective_contribution / maximum.max(1e-12));
            let layer_gain = if lexical { 1.0 } else {
                decay + (1.0 - decay) * independent_support
            };
            let raw_weight = positive(effective_contribution) * layer_gain * language_gain * core_gain
                * if lexical && !is_core { 1.6 } else { 1.0 };
            let weight = if is_core { raw_weight } else { raw_weight.min(1.0) };
            if weight > 0.0 {
                gated.push(GatedTag {
                    id: tag.id,
                    name: tag.name.clone(),
                    weight,
                    is_core,
                    lexical,
                });
            }
        }
    }
    // Explicit focus has unit base amplitude, independent of ANN recall and
    // Gram-Schmidt contribution. Promote existing IDs instead of duplicating them.
    for (id, name) in explicit_cores {
        if let Some(tag) = gated.iter_mut().find(|tag| tag.id == *id) {
            tag.is_core = true;
            tag.weight = tag.weight.max(dynamic_core_boost);
        } else {
            gated.push(GatedTag {
                id: *id, name: name.clone(), weight: dynamic_core_boost,
                is_core: true, lexical: false,
            });
        }
    }
    scale_implicit_seeds(&mut gated, eligible);
    (gated, effective_boost.clamp(0.0, 1.0), dynamic_core_boost)
}

#[derive(Clone)]
struct FusionTag {
    id: i64,
    name: String,
    weight: f64,
    is_core: bool,
    vector: Arc<[f32]>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FusionDiagnostics {
    requested_count: usize,
    found_count: usize,
    deduplicated_count: usize,
    total_weight: f64,
    selected_tag_ids: Vec<i64>,
    emergent_count: usize,
    supplemented_core_count: usize,
    ghost_count: usize,
}

#[cfg(test)]
fn fuse_observation(
    connection: &Connection, query: &[f32], observation: &SenseOutput,
    gated_tags: &[GatedTag], core_tags: &[String], ghost_tags: &[GhostTagInput],
    dynamic_core_boost: f64, dimension: usize, alpha: f64, config: &PipelineConfig,
) -> std::result::Result<(Vec<f64>, FusionDiagnostics, Vec<FusionTag>), String> {
    fuse_observation_with_pool(connection, query, observation, gated_tags, core_tags,
        ghost_tags, dynamic_core_boost, dimension, alpha, config, &mut TagVectorPool::new())
}

fn fuse_observation_with_pool(
    connection: &Connection,
    query: &[f32],
    observation: &SenseOutput,
    gated_tags: &[GatedTag],
    core_tags: &[String],
    ghost_tags: &[GhostTagInput],
    dynamic_core_boost: f64,
    dimension: usize,
    alpha: f64,
    config: &PipelineConfig,
    tag_vectors: &mut TagVectorPool,
) -> std::result::Result<(Vec<f64>, FusionDiagnostics, Vec<FusionTag>), String> {
    // 与 JS SOTA 完全相同：传播后的原始种子取 max，防止循环共现膨胀；
    // 纯涌现节点按能量排序后只保留 Top-N。
    let gated_by_id: HashMap<i64, &GatedTag> = gated_tags.iter().map(|tag| (tag.id, tag)).collect();
    let mut merged = Vec::new();
    let mut emergent = Vec::new();
    for node in &observation.nodes {
        if node.id <= 0 || node.energy <= 0.0 {
            continue;
        }
        if let Some(seed) = gated_by_id.get(&node.id) {
            merged.push(GatedTag {
                id: seed.id,
                name: seed.name.clone(),
                weight: seed.weight.max(node.energy),
                is_core: seed.is_core,
                lexical: seed.lexical,
            });
        } else {
            emergent.push(GatedTag {
                id: node.id,
                name: String::new(),
                weight: node.energy,
                is_core: false,
                lexical: false,
            });
        }
    }
    emergent.sort_by(|left, right| {
        right
            .weight
            .partial_cmp(&left.weight)
            .unwrap_or(Ordering::Equal)
            .then_with(|| left.id.cmp(&right.id))
    });
    if config.max_emergent_nodes > 0 {
        emergent.truncate(config.max_emergent_nodes);
    }
    let emergent_count = emergent.len();
    merged.extend(emergent);

    // JS 使用传播后 allTags 的最大基准权重；coreBoostFactor 仅用于还原基准，
    // 实际补全 Core 与 Hard Ghost 使用动态 Core 增益。
    let core_divisor =
        if config.core_boost_factor.is_finite() && config.core_boost_factor.abs() > 1e-12 {
            config.core_boost_factor
        } else {
            1.33
        };
    let max_base_weight = merged
        .iter()
        .map(|tag| tag.weight / core_divisor)
        .fold(0.0, f64::max)
        .max(if merged.is_empty() { 1.0 } else { 0.0 });

    // 图内有效 Core 已提前作为 Spike 起点；此处保留未入图 Core 的融合回退。
    let mut present_names: HashSet<String> = merged
        .iter()
        .filter(|tag| !tag.name.is_empty())
        .map(|tag| tag.name.to_lowercase())
        .collect();
    let mut supplemented_core_count = 0usize;
    let mut core_statement = connection
        .prepare("SELECT id, name FROM tags WHERE lower(name) = lower(?1) LIMIT 1")
        .map_err(|error| format!("prepare Memo core supplement query failed: {}", error))?;
    for core_name in core_tags {
        let normalized = core_name.to_lowercase();
        if normalized.is_empty() || present_names.contains(&normalized) {
            continue;
        }
        if let Ok((id, name)) = core_statement.query_row(rusqlite::params![core_name], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        }) {
            if merged.iter().any(|tag| tag.id == id) {
                continue;
            }
            present_names.insert(name.to_lowercase());
            merged.push(GatedTag {
                id,
                name,
                weight: max_base_weight * dynamic_core_boost,
                is_core: true,
                lexical: false,
            });
            supplemented_core_count += 1;
        }
    }

    drop(core_statement);
    let requested_count = merged.len() + ghost_tags.len();
    let ids = merged.iter().map(|tag| tag.id).collect::<Vec<_>>();
    ensure_tag_vectors_loaded(connection, tag_vectors, &ids, dimension)?;
    let mut vectors = Vec::with_capacity(requested_count);
    for tag in merged {
        let Some(vector) = tag_vectors.get(&tag.id).cloned() else { continue };
        if magnitude(&vector) > 1e-12 {
            vectors.push(FusionTag {
                id: tag.id,
                name: if tag.name.is_empty() {
                    format!("Tag#{}", tag.id)
                } else {
                    tag.name
                },
                weight: tag.weight,
                is_core: tag.is_core,
                vector,
            });
        }
    }

    // 幽灵节点使用专属负 ID，仅参与去重与向量融合，绝不进入 Artifact/Spike。
    let mut ghost_id = -1i64;
    let mut accepted_ghosts = 0usize;
    for ghost in ghost_tags {
        // A hard ghost bound to a real core seed already contributes its SQL vector.
        if ghost.is_core && gated_tags.iter().any(|tag|
            tag.is_core && tag.name.eq_ignore_ascii_case(ghost.name.trim())) {
            continue;
        }
        if ghost.vector.len() != dimension || magnitude(&ghost.vector) <= 1e-12 {
            continue;
        }
        vectors.push(FusionTag {
            id: ghost_id,
            name: ghost.name.clone(),
            weight: max_base_weight
                * if ghost.is_core {
                    dynamic_core_boost
                } else {
                    1.0
                },
            is_core: ghost.is_core,
            vector: Arc::from(ghost.vector.clone()),
        });
        ghost_id -= 1;
        accepted_ghosts += 1;
    }
    let found_count = vectors.len();

    // JS SOTA：按权重降序贪心去重；冗余标签把 20% 能量转移给代表标签，
    // 同时保留 Core 属性。不能简化为“直接丢弃冗余标签”。
    vectors.sort_by(|left, right| {
        right
            .weight
            .partial_cmp(&left.weight)
            .unwrap_or(Ordering::Equal)
            .then_with(|| left.id.cmp(&right.id))
    });
    vectors.truncate(config.max_fusion_tags.clamp(1, 1024));
    let threshold = config.deduplication_threshold.clamp(-1.0, 1.0);
    let mut selected: Vec<FusionTag> = Vec::new();
    for candidate in vectors {
        let redundant_index = selected
            .iter()
            .position(|existing| cosine(&candidate.vector, &existing.vector) > threshold);
        if let Some(index) = redundant_index {
            selected[index].weight += candidate.weight * 0.2;
            selected[index].is_core |= candidate.is_core;
        } else {
            selected.push(candidate);
        }
    }

    let total_weight = selected.iter().map(|entry| entry.weight).sum::<f64>();
    if total_weight <= 0.0 {
        // JS applyTagBoost() 的兼容契约：无法构造 Tag 上下文时原样返回查询向量，
        // 而不是抛错。空 selected 也确保 matched/coreTagsMatched 保持为空。
        let diagnostics = FusionDiagnostics {
            requested_count,
            found_count,
            deduplicated_count: 0,
            total_weight: 0.0,
            selected_tag_ids: Vec::new(),
            emergent_count,
            supplemented_core_count,
            ghost_count: accepted_ghosts,
        };
        return Ok((
            query.iter().map(|value| *value as f64).collect(),
            diagnostics,
            Vec::new(),
        ));
    }
    let mut context = vec![0.0f64; dimension];
    for tag in &selected {
        for offset in 0..dimension {
            context[offset] += tag.vector[offset] as f64 * tag.weight;
        }
    }
    for value in &mut context {
        *value /= total_weight;
    }
    normalize(&mut context);

    let mut fused: Vec<f64> = query
        .iter()
        .zip(context.iter())
        .map(|(source, memo)| (1.0 - alpha) * (*source as f64) + alpha * *memo)
        .collect();
    normalize(&mut fused);
    let diagnostics = FusionDiagnostics {
        requested_count,
        found_count,
        deduplicated_count: selected.len(),
        total_weight,
        selected_tag_ids: selected.iter().map(|entry| entry.id).collect(),
        emergent_count,
        supplemented_core_count,
        ghost_count: accepted_ghosts,
    };
    Ok((fused, diagnostics, selected))
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct DualFieldDiagnostics {
    retained_local_field_nodes: usize,
    retained_transfer_field_nodes: usize,
    local_domain_nodes: usize,
    transfer_domain_nodes: usize,
    projected_nodes: usize,
    selected_projection_nodes: usize,
    sql_fetched_nodes: usize,
    sql_requested_nodes: usize,
    sql_batches: usize,
    growth: crate::memo_projection::GrowthDiagnostics,
    local_support: ProjectionSupportDiagnostics,
    transfer_support: ProjectionSupportDiagnostics,
    local_selected_mass_ratio: f64,
    transfer_selected_mass_ratio: f64,
    local_projected_mass_ratio: f64,
    transfer_projected_mass_ratio: f64,
    solve_ms: f64,
    domain_ms: f64,
    project_ms: f64,
    iterations: usize,
    local_converged: bool,
    transfer_converged: bool,
    local_residual: f64,
    transfer_residual: f64,
    local_mass: f64,
    transfer_mass: f64,
}

struct DualFieldOutput {
    local_field: Vec<(i64, f64)>,
    transfer_field: Vec<(i64, f64)>,
    local_domain_ids: Vec<i64>,
    transfer_domain_ids: Vec<i64>,
    local_vector: Vec<f32>,
    transfer_vector: Vec<f32>,
    diagnostics: DualFieldDiagnostics,
}

fn apply_transport(
    artifact: &crate::rivermemo_topology_v3::NativeArtifact,
    input: &[f64],
    output: &mut [f64],
) {
    output.fill(0.0);
    for source in 0..artifact.node_ids.len() {
        let mass = input[source];
        if mass == 0.0 {
            continue;
        }
        for cursor in artifact.row_offsets[source]..artifact.row_offsets[source + 1] {
            output[artifact.targets[cursor]] += mass * positive(artifact.weights[cursor]);
        }
    }
}

/// `apply_transport` for both fields in one pass over the CSR. Every output
/// position receives the same additions in the same order as two separate
/// passes, and each field keeps its own zero-mass skip.
fn apply_transport_pair(
    artifact: &crate::rivermemo_topology_v3::NativeArtifact,
    local: &[f64],
    transfer: &[f64],
    local_output: &mut [f64],
    transfer_output: &mut [f64],
) {
    local_output.fill(0.0);
    transfer_output.fill(0.0);
    for source in 0..artifact.node_ids.len() {
        let local_mass = local[source];
        let transfer_mass = transfer[source];
        let local_active = local_mass != 0.0;
        let transfer_active = transfer_mass != 0.0;
        if !local_active && !transfer_active {
            continue;
        }
        for cursor in artifact.row_offsets[source]..artifact.row_offsets[source + 1] {
            let weight = positive(artifact.weights[cursor]);
            let target = artifact.targets[cursor];
            if local_active {
                local_output[target] += local_mass * weight;
            }
            if transfer_active {
                transfer_output[target] += transfer_mass * weight;
            }
        }
    }
}

/// `next = (1 - alpha) * source + alpha * propagated` and the L1 change from
/// `current`, in one pass with the same arithmetic and index order as a
/// separate update followed by an L1 sum of non-negative terms.
fn relax_field(
    source: &[f64],
    propagated: &[f64],
    alpha: f64,
    current: &[f64],
    next: &mut [f64],
) -> f64 {
    let mut residual = 0.0;
    for index in 0..source.len() {
        next[index] = (1.0 - alpha) * source[index] + alpha * propagated[index];
        residual += (next[index] - current[index]).abs();
    }
    residual
}

fn field_mass(field: &[f64]) -> f64 {
    field.iter().map(|value| positive(*value)).sum()
}

fn effective_domain(
    artifact: &crate::rivermemo_topology_v3::NativeArtifact,
    field: &[f64],
    ratio: f64,
) -> Vec<i64> {
    let total = field_mass(field);
    if total <= 0.0 {
        return Vec::new();
    }
    let mut ranked: Vec<(i64, f64)> = artifact
        .node_ids
        .iter()
        .copied()
        .zip(field.iter().copied())
        .filter(|(_, mass)| *mass > 0.0)
        .collect();
    ranked.sort_by(|left, right| {
        right
            .1
            .partial_cmp(&left.1)
            .unwrap_or(Ordering::Equal)
            .then_with(|| left.0.cmp(&right.0))
    });
    let mut retained = Vec::new();
    let mut mass = 0.0;
    for (id, value) in ranked {
        retained.push(id);
        mass += value;
        if mass / total >= ratio.clamp(0.01, 1.0) {
            break;
        }
    }
    retained
}

#[cfg(test)]
fn project_field(
    vectors: &HashMap<i64, Vec<f32>>,
    artifact: &crate::rivermemo_topology_v3::NativeArtifact,
    field: &[f64],
    dimension: usize,
) -> std::result::Result<Vec<f32>, String> {
    let mut output = vec![0.0f64; dimension];
    let mut total = 0.0;
    for (node_index, mass) in field.iter().copied().enumerate() {
        if mass <= 0.0 {
            continue;
        }
        let id = artifact.node_ids[node_index];
        let Some(buffer) = vectors.get(&id) else { continue };
        total += mass;
        for offset in 0..dimension {
            output[offset] += buffer[offset] as f64 * mass;
        }
    }
    if total > 0.0 {
        for value in &mut output {
            *value /= total;
        }
        normalize(&mut output);
    }
    Ok(output.into_iter().map(|value| value as f32).collect())
}

/// Legacy full-support projection retained only as a regression reference.
#[cfg(test)]
fn project_dual_fields(
    connection: &Connection,
    artifact: &crate::rivermemo_topology_v3::NativeArtifact,
    local: &[f64],
    transfer: &[f64],
    dimension: usize,
) -> std::result::Result<(Vec<f32>, Vec<f32>), String> {
    let mut outputs = [vec![0.0f64; dimension], vec![0.0f64; dimension]];
    let mut totals = [0.0f64; 2];
    for (batch_index, ids) in artifact.node_ids.chunks(128).enumerate() {
        let start = batch_index * 128;
        let requested: Vec<i64> = ids.iter().enumerate()
            .filter(|(offset, _)| local[start + offset] > 0.0
                || transfer[start + offset] > 0.0)
            .map(|(_, id)| *id)
            .collect();
        let vectors = load_vectors_by_ids(connection, "tags", &requested, dimension)?;
        for (offset, id) in ids.iter().enumerate() {
            let Some(vector) = vectors.get(id) else { continue };
            for (field, mass) in [local[start + offset], transfer[start + offset]]
                .into_iter().enumerate()
            {
                if mass <= 0.0 { continue; }
                totals[field] += mass;
                for (output, value) in outputs[field].iter_mut().zip(vector) {
                    *output += *value as f64 * mass;
                }
            }
        }
    }
    for (output, total) in outputs.iter_mut().zip(totals) {
        if total > 0.0 {
            for value in output.iter_mut() { *value /= total; }
            normalize(output);
        }
    }
    let [local, transfer] = outputs;
    Ok((
        local.into_iter().map(|value| value as f32).collect(),
        transfer.into_iter().map(|value| value as f32).collect(),
    ))
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionSupportDiagnostics {
    core_nodes: usize,
    selected_nodes: usize,
    outside_domain_nodes: usize,
    missing_vector_nodes: usize,
    stop_reason: String,
}

#[cfg(test)]
struct ProjectionSupport {
    ids: Vec<i64>,
    diagnostics: ProjectionSupportDiagnostics,
}

// A deterministic max-heap: highest field mass first, then lowest Tag ID.
#[cfg(test)]
#[derive(Clone, Copy)]
struct ProjectionFrontier {
    mass: f64,
    id: i64,
    index: usize,
}
#[cfg(test)]
impl PartialEq for ProjectionFrontier {
    fn eq(&self, other: &Self) -> bool {
        self.mass.total_cmp(&other.mass) == Ordering::Equal && self.id == other.id
    }
}
#[cfg(test)]
impl Eq for ProjectionFrontier {}
#[cfg(test)]
impl PartialOrd for ProjectionFrontier {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> { Some(self.cmp(other)) }
}
#[cfg(test)]
impl Ord for ProjectionFrontier {
    fn cmp(&self, other: &Self) -> Ordering {
        self.mass.total_cmp(&other.mass).then_with(|| other.id.cmp(&self.id))
    }
}

/// Core-anchored directed region growing. A candidate is exposed only by an
/// already selected predecessor; low-mass bridges are never skipped to reach peaks.
/// Domains remain unchanged for downstream geometry: they supply only the mass target.
#[cfg(test)]
fn select_projection_support(
    artifact: &crate::rivermemo_topology_v3::NativeArtifact,
    field: &[f64],
    domain: &[i64],
    river_ids: &[i64],
    limit: usize,
) -> std::result::Result<ProjectionSupport, String> {
    let mut ids: Vec<i64> = river_ids.iter().copied()
        .filter(|id| artifact.node_index.contains_key(id)).collect();
    ids.sort_unstable();
    ids.dedup();
    if limit > 0 && ids.len() > limit {
        return Err(format!(
            "MEMO_PROJECTION_CORE_EXCEEDS_BUDGET: core has {} nodes, per-field budget is {}; increase maxFieldProjectionNodes or use 0",
            ids.len(), limit));
    }
    let domain_set: HashSet<i64> = domain.iter().copied().collect();
    let target_mass: f64 = domain.iter().filter_map(|id| artifact.node_index.get(id))
        .map(|&i| positive(field[i])).sum();
    let mut diagnostics = ProjectionSupportDiagnostics {
        core_nodes: ids.len(), ..ProjectionSupportDiagnostics::default()
    };
    if ids.is_empty() {
        diagnostics.stop_reason = "empty_core".into();
        return Ok(ProjectionSupport { ids, diagnostics });
    }
    let mut discovered: HashSet<usize> = ids.iter().map(|id| artifact.node_index[id]).collect();
    let mut frontier = BinaryHeap::new();
    let cutoff = field.iter().copied().map(positive).fold(0.0_f64, f64::max) * 1e-12;
    let expose = |source: usize, discovered: &mut HashSet<usize>,
                  frontier: &mut BinaryHeap<ProjectionFrontier>| {
        for cursor in artifact.row_offsets[source]..artifact.row_offsets[source + 1] {
            if positive(artifact.weights[cursor]) <= 0.0 { continue; }
            let index = artifact.targets[cursor];
            let mass = positive(field[index]);
            // Do not fill seats with numerical tails or zero-mass transit nodes.
            if mass > 0.0 && mass >= cutoff && discovered.insert(index) {
                frontier.push(ProjectionFrontier { mass, id: artifact.node_ids[index], index });
            }
        }
    };
    // Stable initial summation and edge exposure, independent of hash iteration.
    let mut selected_mass: f64 = ids.iter().map(|id| positive(field[artifact.node_index[id]])).sum();
    for id in &ids { expose(artifact.node_index[id], &mut discovered, &mut frontier); }
    loop {
        if selected_mass >= target_mass {
            diagnostics.stop_reason = "mass_target".into();
            break;
        }
        if limit > 0 && ids.len() >= limit {
            diagnostics.stop_reason = "budget".into();
            break;
        }
        let Some(next) = frontier.pop() else {
            diagnostics.stop_reason = "frontier_exhausted".into();
            break;
        };
        ids.push(next.id);
        selected_mass += next.mass;
        expose(next.index, &mut discovered, &mut frontier);
    }
    diagnostics.selected_nodes = ids.len();
    diagnostics.outside_domain_nodes = ids.iter().filter(|id| !domain_set.contains(id)).count();
    Ok(ProjectionSupport { ids, diagnostics })
}

#[cfg(test)]
fn project_supported_fields(
    connection: &Connection,
    artifact: &crate::rivermemo_topology_v3::NativeArtifact,
    fields: [&[f64]; 2],
    domains: [&[i64]; 2],
    dimension: usize,
    limit: usize,
    river_ids: &[i64],
    pool: &mut TagVectorPool,
    diagnostics: &mut DualFieldDiagnostics,
) -> std::result::Result<(Vec<f32>, Vec<f32>), String> {
    project_basin_fields(connection, artifact, fields, domains, dimension, limit,
        river_ids, &[], pool, diagnostics)
}

fn project_basin_fields(
    connection: &Connection,
    artifact: &crate::rivermemo_topology_v3::NativeArtifact,
    fields: [&[f64]; 2],
    domains: [&[i64]; 2],
    dimension: usize,
    limit: usize,
    river_ids: &[i64],
    basins: &[crate::memo_projection::Basin],
    pool: &mut TagVectorPool,
    diagnostics: &mut DualFieldDiagnostics,
) -> std::result::Result<(Vec<f32>, Vec<f32>), String> {
    let supports = crate::memo_projection::grow(artifact, fields, domains, river_ids, basins, limit)?;
    let selected = supports.ids;
    let support_diagnostics = |f: usize| {
        let domain: HashSet<i64> = domains[f].iter().copied().collect();
        ProjectionSupportDiagnostics {
            core_nodes: supports.diagnostics.core_nodes,
            selected_nodes: selected[f].len(),
            outside_domain_nodes: selected[f].iter().filter(|id| !domain.contains(id)).count(),
            stop_reason: supports.diagnostics.stop_reason.clone(),
            ..ProjectionSupportDiagnostics::default()
        }
    };
    diagnostics.local_support = support_diagnostics(0);
    diagnostics.transfer_support = support_diagnostics(1);
    diagnostics.growth = supports.diagnostics;
    let mut union: Vec<i64> = selected.iter().flatten().copied().collect();
    union.sort_unstable();
    union.dedup();
    diagnostics.selected_projection_nodes = union.len();
    let stats = ensure_tag_vectors_loaded(connection, pool, &union, dimension)?;
    diagnostics.sql_fetched_nodes = stats.fetched_nodes;
    diagnostics.sql_requested_nodes = stats.requested_nodes;
    diagnostics.sql_batches = stats.sql_batches;
    diagnostics.projected_nodes = union.iter().filter(|id| pool.contains_key(id)).count();
    diagnostics.local_support.missing_vector_nodes =
        selected[0].iter().filter(|id| !pool.contains_key(id)).count();
    diagnostics.transfer_support.missing_vector_nodes =
        selected[1].iter().filter(|id| !pool.contains_key(id)).count();
    let mut outputs = [vec![0.0f64; dimension], vec![0.0f64; dimension]];
    let mut selected_ratios = [0.0; 2];
    let mut projected_ratios = [0.0; 2];
    for field in 0..2 {
        let total_mass = field_mass(fields[field]);
        let mut selected_mass = 0.0;
        let mut projected_mass = 0.0;
        for id in &selected[field] {
            let Some(&index) = artifact.node_index.get(id) else { continue };
            let mass = positive(fields[field][index]);
            selected_mass += mass;
            let Some(vector) = pool.get(id) else { continue };
            projected_mass += mass;
            // Transport already penalizes hubs. Apply only a mild residual
            // projection discount, preserving the observed query core unchanged.
            let hub_ratio = if artifact.max_inbound > 0.0 {
                positive(artifact.inbound.get(id).copied().unwrap_or(0.0)) / artifact.max_inbound
            } else { 0.0 };
            let projection_gain = if river_ids.contains(id) { 1.0 }
                else { 1.0 / (1.0 + hub_ratio.sqrt()) };
            for (out, value) in outputs[field].iter_mut().zip(vector.iter()) {
                *out += *value as f64 * mass * projection_gain;
            }
        }
        if projected_mass > 0.0 {
            for out in &mut outputs[field] { *out /= projected_mass; }
            normalize(&mut outputs[field]);
        }
        if total_mass > 0.0 {
            selected_ratios[field] = selected_mass / total_mass;
            projected_ratios[field] = projected_mass / total_mass;
        }
    }
    [diagnostics.local_selected_mass_ratio, diagnostics.transfer_selected_mass_ratio] = selected_ratios;
    [diagnostics.local_projected_mass_ratio, diagnostics.transfer_projected_mass_ratio] = projected_ratios;
    let [local, transfer] = outputs;
    Ok((local.into_iter().map(|v| v as f32).collect(),
        transfer.into_iter().map(|v| v as f32).collect()))
}

#[cfg(test)]
fn solve_dual_fields(
    artifact: &crate::rivermemo_topology_v3::NativeArtifact,
    connection: &Connection,
    source_entries: &[(i64, f64)],
    dimension: usize,
    config: &PipelineConfig,
) -> std::result::Result<DualFieldOutput, String> {
    solve_dual_fields_with_pool(artifact, connection, source_entries, dimension, config,
        &mut TagVectorPool::new(), &source_entries.iter().map(|entry| entry.0).collect::<Vec<_>>(), &[])
}

fn solve_dual_fields_with_pool(
    artifact: &crate::rivermemo_topology_v3::NativeArtifact,
    connection: &Connection,
    source_entries: &[(i64, f64)],
    dimension: usize,
    config: &PipelineConfig,
    pool: &mut TagVectorPool,
    river_ids: &[i64],
    basins: &[crate::memo_projection::Basin],
) -> std::result::Result<DualFieldOutput, String> {
    let solve_started = Instant::now();
    let mut source = vec![0.0f64; artifact.node_ids.len()];
    for (id, mass) in source_entries {
        if let Some(index) = artifact.node_index.get(id) {
            source[*index] += positive(*mass);
        }
    }
    let source_mass = field_mass(&source);
    if source_mass <= 0.0 {
        return Ok(DualFieldOutput {
            local_field: Vec::new(),
            transfer_field: Vec::new(),
            local_domain_ids: Vec::new(),
            transfer_domain_ids: Vec::new(),
            local_vector: vec![0.0; dimension],
            transfer_vector: vec![0.0; dimension],
            diagnostics: DualFieldDiagnostics {
                iterations: 0,
                local_converged: true,
                transfer_converged: true,
                local_residual: 0.0,
                transfer_residual: 0.0,
                local_mass: 0.0,
                transfer_mass: 0.0,
                ..DualFieldDiagnostics::default()
            },
        });
    }
    for value in &mut source {
        *value /= source_mass;
    }

    let local_alpha = config.local_alpha.clamp(0.0, 0.999999);
    let transfer_alpha = config.transfer_alpha.clamp(0.0, 0.999999);
    let mut local = source.clone();
    let mut transfer = source.clone();
    let mut next_local = vec![0.0; source.len()];
    let mut next_transfer = vec![0.0; source.len()];
    let mut propagated_local = vec![0.0; source.len()];
    let mut propagated_transfer = vec![0.0; source.len()];
    let mut local_converged = false;
    let mut transfer_converged = false;
    let mut local_residual = f64::INFINITY;
    let mut transfer_residual = f64::INFINITY;
    let mut iterations = 0;

    for iteration in 1..=config.field_max_iterations.max(1) {
        iterations = iteration;
        // The fields are independent; while both move, one CSR pass serves both.
        if !local_converged && !transfer_converged {
            apply_transport_pair(artifact, &local, &transfer,
                &mut propagated_local, &mut propagated_transfer);
        } else if !local_converged {
            apply_transport(artifact, &local, &mut propagated_local);
        } else if !transfer_converged {
            apply_transport(artifact, &transfer, &mut propagated_transfer);
        }
        if !local_converged {
            local_residual = relax_field(&source, &propagated_local, local_alpha,
                &local, &mut next_local);
            local_converged = local_residual <= config.local_tolerance.max(1e-15);
            std::mem::swap(&mut local, &mut next_local);
        }
        if !transfer_converged {
            transfer_residual = relax_field(&source, &propagated_transfer, transfer_alpha,
                &transfer, &mut next_transfer);
            transfer_converged = transfer_residual <= config.transfer_tolerance.max(1e-15);
            std::mem::swap(&mut transfer, &mut next_transfer);
        }
        if local_converged && transfer_converged {
            break;
        }
    }

    let solve_ms = solve_started.elapsed().as_secs_f64() * 1000.0;
    let domain_started = Instant::now();
    let local_domain_ids = effective_domain(artifact, &local, config.local_mass_ratio);
    let transfer_domain_ids = effective_domain(artifact, &transfer, config.transfer_mass_ratio);
    // Scalar retention is independent of projection K. Keep meaningful tails for
    // path potentials/tail penalties, and always preserve support/river nodes.
    let mut retained: Vec<i64> = local_domain_ids.iter().chain(&transfer_domain_ids)
        .chain(river_ids).copied().collect();
    retained.sort_unstable();
    retained.dedup();
    let required: HashSet<i64> = retained.into_iter().collect();
    let scalar = |field: &[f64]| -> Vec<(i64, f64)> {
        let maximum = field.iter().copied().fold(0.0f64, f64::max);
        let cutoff = maximum * 1e-12;
        artifact.node_ids.iter().copied().zip(field.iter().copied())
            .filter(|(id, mass)| mass.is_finite() && *mass > 0.0
                && (*mass >= cutoff || required.contains(id)))
            .collect()
    };
    let local_field = scalar(&local);
    let transfer_field = scalar(&transfer);
    let local_mass = field_mass(&local);
    let transfer_mass = field_mass(&transfer);
    let mut projection = DualFieldDiagnostics {
        solve_ms,
        retained_local_field_nodes: local_field.len(),
        retained_transfer_field_nodes: transfer_field.len(),
        local_domain_nodes: local_domain_ids.len(),
        transfer_domain_nodes: transfer_domain_ids.len(),
        domain_ms: domain_started.elapsed().as_secs_f64() * 1000.0,
        ..DualFieldDiagnostics::default()
    };
    let project_started = Instant::now();
    let (local_vector, transfer_vector) = project_basin_fields(
        connection, artifact, [&local, &transfer],
        [&local_domain_ids, &transfer_domain_ids], dimension,
        config.max_field_projection_nodes, river_ids, basins, pool, &mut projection)?;
    projection.project_ms = project_started.elapsed().as_secs_f64() * 1000.0;

    Ok(DualFieldOutput {
        local_field,
        transfer_field,
        local_domain_ids,
        transfer_domain_ids,
        local_vector,
        transfer_vector,
        diagnostics: DualFieldDiagnostics {
            iterations,
            local_converged,
            transfer_converged,
            local_residual,
            transfer_residual,
            local_mass,
            transfer_mass,
            ..projection
        },
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PipelineDiagnostics {
    backend: String,
    runtime_ownership: String,
    epa_ms: f64,
    pyramid_ms: f64,
    gating_ms: f64,
    sensing_ms: f64,
    fusion_ms: f64,
    dual_field_solve_ms: f64,
    dual_field_project_ms: f64,
    dual_field_domain_ms: f64,
    total_ms: f64,
    seed_nodes: usize,
    routing_residual_count: usize,
    routing_tail_appended: bool,
    observation_cached: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    observation_cache_error: Option<String>,
    dual_field: DualFieldDiagnostics,
    fusion: FusionDiagnostics,
    sensing: SenseDiagnostics,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PipelineMetadataOutput {
    schema: String,
    algorithm_version: String,
    artifact_sig: String,
    query_id: Option<String>,
    observation_handle: String,
    epa: EpaOutput,
    pyramid: PyramidOutput,
    matched_tags: Vec<String>,
    core_tags_matched: Vec<String>,
    effective_tag_boost: f64,
    propagation_parameters: SenseConfig,
    diagnostics: PipelineDiagnostics,
}

pub struct MemoPipelineComputeOutput {
    pub(crate) metadata_json: String,
    pub(crate) enhanced_vector: Vec<f32>,
}

/// 统一 Memo 查询的轻量 N-API 返回值。
///
/// 完整 Observation、双场、域集合与投影向量只保留在 MemoRuntime 中；Node
/// 只接收后续读出所需的句柄、诊断摘要和用于 KNN 的增强查询向量。
#[napi(object)]
pub struct MemoPipelineResult {
    pub metadata_json: String,
    pub enhanced_vector: Float32Array,
}

fn run_pipeline_with_connection(
    index: &Arc<crate::index_handle::IndexHandle>,
    runtime: &MemoRuntime,
    artifact_sig: &str,
    dimensions: usize,
    input_json: &str,
    query_vector: &[f32],
    ghost_vectors: &[f32],
    artifact: &Arc<crate::rivermemo_topology_v3::NativeArtifact>,
    connection: &Connection,
) -> std::result::Result<MemoPipelineComputeOutput, String> {
    let total_started = Instant::now();
    let mut input: PipelineInput = serde_json::from_str(input_json)
        .map_err(|error| format!("invalid unified Memo pipeline input JSON: {}", error))?;
    input.query_vector = query_vector.to_vec();
    if input.query_vector.len() != dimensions {
        return Err(format!(
            "Memo pipeline dimension mismatch: expected {}, got {}",
            dimensions,
            input.query_vector.len()
        ));
    }
    let expected_ghost_values = input
        .ghost_tags
        .len()
        .checked_mul(dimensions)
        .ok_or_else(|| "Memo pipeline ghost vector size overflow".to_string())?;
    if ghost_vectors.len() != expected_ghost_values {
        return Err(format!(
            "Memo pipeline ghost vector size mismatch: ghosts={}, expected values={}, got={}",
            input.ghost_tags.len(),
            expected_ghost_values,
            ghost_vectors.len()
        ));
    }
    for (position, ghost) in input.ghost_tags.iter_mut().enumerate() {
        let start = position * dimensions;
        ghost.vector = ghost_vectors[start..start + dimensions].to_vec();
    }
    let epa_started = Instant::now();
    if !["absolute","relativeLinear","relativeSqrt","backgroundRelative"].contains(&input.config.epa_gate_mode.as_str()) {
        return Err("Invalid epaGateMode".into());
    }
    let epa = analyze_epa_with_mode(&connection, &input.query_vector, dimensions, &input.config.epa_gate_mode);
    let epa_ms = epa_started.elapsed().as_secs_f64() * 1000.0;

    let mut tag_vectors = TagVectorPool::new();
    let pyramid_started = Instant::now();
    let (pyramid, level_tags, residuals) = analyze_pyramid_with_pool(
        index,
        &connection,
        &input.query_vector,
        dimensions,
        &input.config,
        &mut tag_vectors,
        Some(&artifact.node_index),
    )?;
    let pyramid_ms = pyramid_started.elapsed().as_secs_f64() * 1000.0;

    let gating_started = Instant::now();
    let explicit_cores = resolve_core_seeds(connection, &input.core_tags, &input.ghost_tags,
        &artifact.node_index, &mut tag_vectors, dimensions)?;
    let (gated_tags, effective_tag_boost, dynamic_core_boost) =
        gate_tags_for_graph(&level_tags, &epa, &pyramid, &input.core_tags, &input.config,
            &input.query_text, Some(&artifact.node_index), &explicit_cores);
    // Even an empty Pyramid can ignite valid explicit cores. Unknown/out-of-graph
    // cores and ghosts retain their fusion-only fallback.
    let seeds: Vec<SenseSeed> = gated_tags
        .iter()
        .map(|tag| SenseSeed {
            id: tag.id,
            energy: tag.weight,
            source_type: if tag.is_core {
                "core".to_string()
            } else if tag.lexical {
                "lexical_seed".to_string()
            } else {
                "seed".to_string()
            },
        })
        .collect();
    let gating_ms = gating_started.elapsed().as_secs_f64() * 1000.0;

    let sensing_started = Instant::now();
    let mut seed_levels = HashMap::new();
    for (level, tags) in level_tags.iter().enumerate() {
        for tag in tags { seed_levels.entry(tag.id).or_insert(level); }
    }
    let routing_residual_count = residuals.len();
    let routing_tail_appended = residuals.len() > level_tags.len();
    let mut wormholes = DynamicWormholeContext::new(
        connection, &mut tag_vectors, residuals, seed_levels,
    );
    for (layer, tags) in level_tags.iter().enumerate() {
        for tag in tags { wormholes.reuse_score(layer, tag.id, tag.similarity); }
    }
    let observation = sense_with_context(
        &artifact,
        artifact_sig,
        SenseInput {
            query_id: input.query_id.clone(),
            seeds,
            config: input.config.spike_routing.clone(),
        },
        Some(&mut wormholes),
    )?;
    let sensing_diagnostics = observation.diagnostics.clone();
    drop(wormholes);
    let sensing_ms = sensing_started.elapsed().as_secs_f64() * 1000.0;

    let fusion_started = Instant::now();
    let (enhanced_vector, fusion, selected_tags) = fuse_observation_with_pool(
        &connection,
        &input.query_vector,
        &observation,
        &gated_tags,
        &input.core_tags,
        &input.ghost_tags,
        dynamic_core_boost,
        dimensions,
        effective_tag_boost,
        &input.config,
        &mut tag_vectors,
    )?;
    let fusion_ms = fusion_started.elapsed().as_secs_f64() * 1000.0;
    let dual_fields = solve_dual_fields_with_pool(
        artifact,
        connection,
        &observation.source_field,
        dimensions,
        &input.config,
        &mut tag_vectors,
        &observation.nodes.iter().map(|node| node.id).collect::<Vec<_>>(),
        &crate::memo_projection::seed_basins(&observation, artifact),
    )?;

    let enhanced_vector_f32: Vec<f32> = enhanced_vector.iter().map(|value| *value as f32).collect();
    let observation_handle = runtime.store_query_observation(
        artifact_sig,
        observation,
        input.query_vector.clone(),
        enhanced_vector_f32.clone(),
        dual_fields.local_vector.clone(),
        dual_fields.transfer_vector.clone(),
        dual_fields.local_field.clone(),
        dual_fields.transfer_field.clone(),
        dual_fields.local_domain_ids.clone(),
        dual_fields.transfer_domain_ids.clone(),
        Arc::new(tag_vectors),
        crate::storage::read_generation(connection)?,
    )?;
    let observation_cached = true;

    let maximum_weight = selected_tags
        .iter()
        .map(|tag| tag.weight)
        .fold(0.0, f64::max);
    let matched_tags = selected_tags
        .iter()
        .filter(|tag| {
            tag.is_core
                || tag.weight
                    > maximum_weight
                        * if technical_name(&tag.name, true) {
                            input.config.tech_tag_threshold
                        } else {
                            input.config.normal_tag_threshold
                        }
        })
        .map(|tag| tag.name.clone())
        .collect::<Vec<_>>();
    let core_tags_matched = selected_tags
        .iter()
        .filter(|tag| tag.is_core)
        .map(|tag| tag.name.clone())
        .collect::<Vec<_>>();
    let seed_nodes = gated_tags.len();

    let dual_field_diagnostics = dual_fields.diagnostics;
    let metadata_json = serde_json::to_string(&PipelineMetadataOutput {
        schema: PIPELINE_SCHEMA.to_string(),
        algorithm_version: PIPELINE_ALGORITHM.to_string(),
        artifact_sig: artifact_sig.to_string(),
        query_id: input.query_id.clone(),
        observation_handle,
        epa,
        pyramid,
        matched_tags,
        core_tags_matched,
        effective_tag_boost,
        propagation_parameters: input.config.spike_routing.clone(),
        diagnostics: PipelineDiagnostics {
            backend: "rust-unified-memo-pipeline".to_string(),
            runtime_ownership: "vexus-index-instance".to_string(),
            epa_ms,
            pyramid_ms,
            gating_ms,
            sensing_ms,
            fusion_ms,
            dual_field_solve_ms: dual_field_diagnostics.solve_ms,
            dual_field_project_ms: dual_field_diagnostics.project_ms,
            dual_field_domain_ms: dual_field_diagnostics.domain_ms,
            total_ms: total_started.elapsed().as_secs_f64() * 1000.0,
            seed_nodes,
            routing_residual_count,
            routing_tail_appended,
            observation_cached,
            observation_cache_error: None,
            dual_field: dual_field_diagnostics,
            fusion,
            sensing: sensing_diagnostics,
        },
    })
    .map_err(|error| format!("encode unified Memo pipeline metadata failed: {}", error))?;

    Ok(MemoPipelineComputeOutput {
        metadata_json,
        enhanced_vector: enhanced_vector_f32,
    })
}

fn run_pipeline(
    index: &Arc<crate::index_handle::IndexHandle>,
    runtime: &MemoRuntime,
    db_path: &str,
    artifact_sig: &str,
    dimensions: usize,
    input_json: &str,
    query_vector: &[f32],
    ghost_vectors: &[f32],
) -> std::result::Result<MemoPipelineComputeOutput, String> {
    with_registered_read_transaction(db_path, |connection| {
        crate::storage::read_generation(connection)?;
        let artifact = load_artifact_with_connection(runtime, connection, artifact_sig)?;
        run_pipeline_with_connection(
            index,
            runtime,
            artifact_sig,
            dimensions,
            input_json,
            query_vector,
            ghost_vectors,
            &artifact,
            connection,
        )
    })
}

pub struct MemoPipelineTask {
    index: Arc<crate::index_handle::IndexHandle>,
    content_revision: Arc<std::sync::atomic::AtomicU64>,
    runtime: Arc<MemoRuntime>,
    db_path: String,
    artifact_sig: String,
    dimensions: usize,
    input_json: String,
    query_vector: Vec<f32>,
    ghost_vectors: Vec<f32>,
}

impl Task for MemoPipelineTask {
    type Output = MemoPipelineComputeOutput;
    type JsValue = MemoPipelineResult;

    fn compute(&mut self) -> Result<Self::Output> {
        let scopes = ["global_tags".to_string()];
        let mut gate = crate::publication_gate::acquire_read(&self.db_path, &scopes)
            .map_err(Error::from_reason)?;
        if crate::knowledge_runtime::ensure_index_scopes_ready(&self.db_path, &scopes).is_err() {
            drop(gate);
            gate = crate::publication_gate::acquire(&self.db_path, &scopes)
                .map_err(Error::from_reason)?;
        }
        match crate::knowledge_runtime::ensure_index_scopes_ready(&self.db_path, &scopes) {
            Ok(()) => {}
            Err(error) if error.starts_with("KBM_INDEX_NOT_READY:") => {
                self.runtime.clear().map_err(Error::from_reason)?;
                crate::knowledge_runtime::recover_index_snapshot(
                    &self.db_path, "global_tags".to_string(), None,
                    &self.index, &self.content_revision, self.dimensions,
                ).map_err(Error::from_reason)?;
            }
            Err(error) => return Err(Error::from_reason(error)),
        }
        crate::knowledge_runtime::ensure_index_scopes_ready(&self.db_path, &scopes)
            .map_err(Error::from_reason)?;
        gate.downgrade().map_err(Error::from_reason)?;
        run_pipeline(
            &self.index,
            &self.runtime,
            &self.db_path,
            &self.artifact_sig,
            self.dimensions,
            &self.input_json,
            &self.query_vector,
            &self.ghost_vectors,
        )
        .map_err(Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(MemoPipelineResult {
            metadata_json: output.metadata_json,
            enhanced_vector: Float32Array::new(output.enhanced_vector),
        })
    }
}

pub(crate) fn compute_owned(
    index: Arc<crate::index_handle::IndexHandle>,
    content_revision: Arc<std::sync::atomic::AtomicU64>,
    runtime: Arc<MemoRuntime>,
    db_path: String,
    artifact_sig: String,
    dimensions: usize,
    input_json: String,
    query_vector: Vec<f32>,
    ghost_vectors: Vec<f32>,
) -> Result<MemoPipelineComputeOutput> {
    MemoPipelineTask {
        index, content_revision, runtime, db_path, artifact_sig, dimensions,
        input_json, query_vector, ghost_vectors,
    }.compute()
}

pub(crate) fn run_with_runtime(
    lifecycle: &Arc<crate::task_lifecycle::TaskLifecycle>,
    index: Arc<crate::index_handle::IndexHandle>,
    content_revision: Arc<std::sync::atomic::AtomicU64>,
    runtime: Arc<MemoRuntime>,
    db_path: String,
    artifact_sig: String,
    dimensions: usize,
    input_json: String,
    query_vector: Vec<f32>,
    ghost_vectors: Vec<f32>,
) -> AsyncTask<crate::task_lifecycle::TrackedTask<MemoPipelineTask>> {
    AsyncTask::new(crate::task_lifecycle::TrackedTask::new(lifecycle, MemoPipelineTask {
        index,
        content_revision,
        runtime,
        db_path,
        artifact_sig,
        dimensions,
        input_json,
        query_vector,
        ghost_vectors,
    }))
}


#[cfg(test)]
mod audit_gate_tests {
    use super::*;

    #[test]
    fn batched_dual_projection_matches_materialized_projection_bit_for_bit() {
        use crate::rivermemo_topology_v3::NativeArtifact;
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE tags(id INTEGER PRIMARY KEY,vector BLOB);"
        ).unwrap();
        let ids: Vec<i64> = (1..=300).rev().collect();
        for id in 1..=300_i64 {
            if id == 129 { continue; }
            let vector = if id == 258 {
                vec![f32::NAN, 0.0, 0.0]
            } else {
                vec![(id as f32).sin(), id as f32 * 0.01, -0.25]
            };
            let bytes: Vec<u8> = vector.iter().flat_map(|v| v.to_le_bytes()).collect();
            connection.execute("INSERT INTO tags VALUES (?1,?2)",
                rusqlite::params![id, bytes]).unwrap();
        }
        let artifact = NativeArtifact {
            node_index: ids.iter().enumerate().map(|(i, id)| (*id, i)).collect(),
            node_ids: ids.clone(), row_offsets: vec![], targets: vec![],
            weights: vec![], inbound: HashMap::new(), max_inbound: 0.0,
            anchor_gain: HashMap::new(), wormhole_edges: HashSet::new(),
            provenance: HashMap::new(),
            ..NativeArtifact::default()
        };
        let local: Vec<f64> = (0..300).map(|i|
            if i % 3 == 0 { 0.0 } else { 1.0 / (i + 1) as f64 }).collect();
        let transfer: Vec<f64> = (0..300).map(|i|
            if i % 5 == 0 { 0.0 } else { (i + 1) as f64 * 0.0001 }).collect();
        let vectors = load_vectors_by_ids(&connection, "tags", &ids, 3).unwrap();
        let expected_local = project_field(&vectors, &artifact, &local, 3).unwrap();
        let expected_transfer = project_field(&vectors, &artifact, &transfer, 3).unwrap();
        let (actual_local, actual_transfer) =
            project_dual_fields(&connection, &artifact, &local, &transfer, 3).unwrap();
        assert_eq!(actual_local.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            expected_local.iter().map(|v| v.to_bits()).collect::<Vec<_>>());
        assert_eq!(actual_transfer.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            expected_transfer.iter().map(|v| v.to_bits()).collect::<Vec<_>>());
        let zeros = vec![0.0; 300];
        assert_eq!(project_dual_fields(&connection, &artifact, &zeros, &zeros, 3).unwrap(),
            (vec![0.0; 3], vec![0.0; 3]));
    }

    #[test]
    fn core_gate_preserves_zero_and_negative_cosine_measurements() {
        let epa = EpaOutput {
            logic_depth: 0.5, entropy: 0.0, resonance: 0.0,
            dominant_axes: vec![], bridges: vec![], basis_count: 0,
            cache_available: false, out_of_domain: 0.0,
            semantic_explained_ratio: 0.0, in_domain_gate: 1.0,
            baseline_coverage: 0.0, background_ratio: 0.0,
        };
        let pyramid = PyramidOutput {
            levels: vec![], total_explained_energy: 0.0,
            features: PyramidFeatures::default(),
        };
        let levels = vec![[-1.0, 0.0, 1.0].into_iter().enumerate()
            .map(|(position, similarity)| PyramidTagWork {
                id: position as i64 + 1, name: format!("核心{}", position),
                vector: Arc::from(vec![]), similarity, contribution: 1.0,
                handshake_magnitude: 0.0,
            }).collect::<Vec<_>>()];
        let names = levels[0].iter().map(|tag| tag.name.clone()).collect::<Vec<_>>();
        let (gated, _, core_boost) = gate_tags(
            &levels, &epa, &pyramid, &names, &PipelineConfig::default(), "",
        );
        assert_eq!(gated.len(), 3);
        for (tag, cosine) in gated.iter().zip([-1.0, 0.0, 1.0]) {
            assert!((tag.weight - core_boost * (0.95 + cosine * 0.1)).abs() < 1e-12);
        }
    }

    #[test]
    fn pyramid_uses_index_only_for_ids_and_measures_sql_originals() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE tags(id INTEGER PRIMARY KEY,name TEXT,vector BLOB);"
        ).unwrap();
        let bytes: Vec<u8> = [3.0_f32, 0.0, 0.0].iter()
            .flat_map(|value| value.to_le_bytes()).collect();
        connection.execute("INSERT INTO tags VALUES (1,'sql-original',?1)", [bytes]).unwrap();
        let index = crate::VexusIndex::new(3, 16).unwrap();
        index.index.write().unwrap().add(1, &[-9.0, 0.0, 0.0]).unwrap();
        let config = PipelineConfig {
            max_levels: 1, pyramid_top_k: 1, ..PipelineConfig::default()
        };
        let query = [1.0_f32, 2.0, 0.0];
        connection.execute_batch("BEGIN").unwrap();
        let (output, work) = analyze_pyramid(
            &index.index, &connection, &query, 3, &config,
        ).unwrap();
        assert_eq!(work[0][0].vector.as_ref(), &[3.0, 0.0, 0.0]);
        assert!((output.levels[0].tags[0].similarity - 1.0 / 5.0_f64.sqrt()).abs() < 1e-12);
        assert!((output.levels[0].projection_magnitude - 1.0).abs() < 1e-6);
        assert!((output.levels[0].residual_magnitude - 2.0).abs() < 1e-6);
        assert!((output.total_explained_energy - 0.2).abs() < 1e-6);
    }

    #[test]
    fn fusion_and_dual_projection_use_sql_original_f32() {
        use crate::rivermemo_topology_v3::NativeArtifact;
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE tags(id INTEGER PRIMARY KEY,name TEXT,vector BLOB);"
        ).unwrap();
        let originals = [[3.0_f32, 0.0, 0.0], [0.0, 4.0, 0.0]];
        for (slot, vector) in originals.iter().enumerate() {
            let bytes: Vec<u8> = vector.iter().flat_map(|v| v.to_le_bytes()).collect();
            connection.execute("INSERT INTO tags VALUES (?1,?2,?3)",
                rusqlite::params![slot as i64 + 1, format!("core-{}", slot + 1), bytes]
            ).unwrap();
        }
        let artifact = NativeArtifact {
            node_ids: vec![1, 2],
            node_index: HashMap::from([(1, 0), (2, 1)]),
            row_offsets: vec![0, 1, 2],
            targets: vec![1, 0],
            weights: vec![1.0, 1.0],
            inbound: HashMap::new(), max_inbound: 0.0,
            anchor_gain: HashMap::new(), wormhole_edges: HashSet::new(),
            provenance: HashMap::new(),
            ..NativeArtifact::default()
        };
        let artifact = artifact.prepared();
        let config = PipelineConfig { local_mass_ratio: 1.0, transfer_mass_ratio: 1.0, ..PipelineConfig::default() };
        let observation = sense_typed(&artifact, "sql-original-test", SenseInput {
            query_id: None, seeds: Vec::new(), config: SenseConfig::default(),
        }).unwrap();
        let (fused, diagnostics, selected) = fuse_observation(
            &connection, &[0.0, 0.0, 1.0], &observation, &[],
            &["core-1".into(), "core-2".into()], &[], 1.0, 3, 0.5, &config,
        ).unwrap();
        assert_eq!(diagnostics.found_count, 2);
        assert_eq!(selected[0].vector.as_ref(), &originals[0]);
        assert_eq!(selected[1].vector.as_ref(), &originals[1]);
        let mut expected_fusion = vec![0.3_f64, 0.4, 0.5];
        normalize(&mut expected_fusion);
        for (actual, expected) in fused.iter().zip(expected_fusion) {
            assert!((actual - expected).abs() <= 1e-6);
        }
        let fields = solve_dual_fields(
            &artifact, &connection, &[(1, 1.0)], 3, &config,
        ).unwrap();
        for (field, actual) in [
            (&fields.local_field, &fields.local_vector),
            (&fields.transfer_field, &fields.transfer_vector),
        ] {
            let mut expected = vec![0.0_f64; 3];
            for (id, mass) in field {
                for (out, value) in expected.iter_mut().zip(originals[*id as usize - 1]) {
                    *out += value as f64 * mass;
                }
            }
            normalize(&mut expected);
            for (value, expected) in actual.iter().zip(expected) {
                assert!((*value as f64 - expected).abs() <= 1e-6);
            }
        }
    }

    #[test]
    fn pipeline_recovers_invalid_global_index_before_loading_artifact() {
        let root = std::env::temp_dir().join(format!(
            "kbm-pipeline-audit-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db = root.join("test.sqlite").to_string_lossy().into_owned();
        let (storage, _) = crate::storage::SqliteStorageEngine::open_and_init(
            &db, crate::storage::StorageOptions::default(),
        ).unwrap();
        storage.submit_write(|tx| {
            tx.execute(
                "INSERT INTO kbm_index_states VALUES ('global_tags','invalid',1,0,NULL,0)", []
            ).map_err(|error| error.to_string())?;
            Ok(crate::storage::WriteReceipt {
                operation: "fixture".into(), database_generation: 0, facts_changed: false,
            })
        }).unwrap();
        let index = crate::VexusIndex::new(2, 16).unwrap();
        index.index.write().unwrap().add(999, &[1.0_f32, 0.0]).unwrap();
        let mut task = MemoPipelineTask {
            index: index.index.clone(), content_revision: index.content_revision.clone(),
            runtime: index.memo_runtime.clone(), db_path: db.clone(), artifact_sig: "missing".into(),
            dimensions: 2, input_json: "{}".into(), query_vector: vec![1.0, 0.0], ghost_vectors: vec![],
        };
        assert!(task.compute().is_err()); // 图资产缺失仍应显式失败，不能跳过索引门禁。
        assert_eq!(index.index.read().unwrap().size(), 0);
        crate::knowledge_runtime::ensure_index_scopes_ready(&db, &["global_tags".into()]).unwrap();
        assert_eq!(index.content_revision.load(std::sync::atomic::Ordering::Acquire), 1);
        storage.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}


#[cfg(test)]
mod geometry_epa_tests {
    use super::*;

    fn encoded(values: &[f32]) -> String {
        let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn calibrated_gates_preserve_scale_and_reject_background() {
        assert_eq!(calibrated_gate(0.07,0.07,0.02,"relativeLinear"),1.0);
        assert_eq!(calibrated_gate(0.07,0.07,0.02,"backgroundRelative"),1.0);
        assert_eq!(calibrated_gate(0.02,0.07,0.02,"backgroundRelative"),0.0);
        assert_eq!(calibrated_gate(0.01,0.07,0.02,"backgroundRelative"),0.0);
        assert_eq!(calibrated_gate(0.1,0.01,0.02,"backgroundRelative"),0.0);
        assert!((calibrated_gate(0.025,0.1,0.0,"relativeSqrt")-0.5).abs()<1e-12);
    }

    #[test]
    fn cached_coverage_calibrates_prefix_without_tail_backing() {
        let connection=Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE kv_store(key TEXT PRIMARY KEY,value TEXT);").unwrap();
        let cache=serde_json::json!({
            "mean":encoded(&[0.0,0.0,0.0,0.0]),
            "basis":[encoded(&[1.0,0.0,0.0,0.0])],
            "coverage":[0.75],"kSem":1
        });
        connection.execute("INSERT INTO kv_store VALUES ('epa_basis_cache',?1)",[cache.to_string()]).unwrap();
        let inside=analyze_epa_with_mode(&connection,&[1.0,0.0,0.0,0.0],4,"backgroundRelative");
        assert_eq!(inside.baseline_coverage,0.75);
        assert_eq!(inside.background_ratio,0.25);
        assert_eq!(inside.logic_depth,1.0);
        let background=analyze_epa_with_mode(&connection,&[0.5,0.8660254,0.0,0.0],4,"backgroundRelative");
        assert!(background.logic_depth<1e-6);
        assert_eq!(PipelineConfig::default().epa_gate_mode,"backgroundRelative");
    }

    #[test]
    fn semantic_entropy_ignores_tail_axes_and_reports_out_of_domain() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE kv_store(key TEXT PRIMARY KEY,value TEXT);").unwrap();
        let write = |basis: Vec<Vec<f32>>| {
            let cache = serde_json::json!({
                "mean": encoded(&[0.0,0.0,0.0]),
                "basis": basis.iter().map(|v| encoded(v)).collect::<Vec<_>>(),
                "kSem": 2
            });
            connection.execute(
                "INSERT OR REPLACE INTO kv_store VALUES ('epa_basis_cache',?1)",
                [cache.to_string()],
            ).unwrap();
        };
        write(vec![vec![1.0,0.0,0.0],vec![0.0,1.0,0.0]]);
        let first = analyze_epa(&connection, &[0.5,0.5,0.70710677], 3);
        assert!(first.cache_available);
        assert!((first.entropy-1.0).abs()<1e-12);
        assert!((first.out_of_domain-0.70710678).abs()<1e-6);
        write(vec![vec![1.0,0.0,0.0],vec![0.0,1.0,0.0],vec![0.0,0.0,1.0]]);
        let expanded = analyze_epa(&connection, &[0.5,0.5,0.70710677], 3);
        assert_eq!(expanded.entropy, first.entropy);
        assert!(expanded.out_of_domain<1e-6);
        assert_eq!(expanded.semantic_explained_ratio, first.semantic_explained_ratio);
        let low_energy = analyze_epa(&connection, &[0.1,0.0,0.9949874], 3);
        assert!(low_energy.out_of_domain<1e-6); // Tail explains most energy, not the semantic prefix.
        assert!(low_energy.entropy<1e-12);
        assert!((low_energy.logic_depth-0.01).abs()<1e-6);
        let on_axis = analyze_epa(&connection, &[1.0,0.0,0.0], 3);
        assert_eq!(on_axis.logic_depth,1.0);
        write(vec![vec![1.0,0.0,0.0]]);
        let orthogonal = analyze_epa(&connection, &[0.0,1.0,0.0], 3);
        assert!(orthogonal.cache_available);
        assert_eq!(orthogonal.out_of_domain,1.0);
        assert_eq!(orthogonal.entropy,1.0);
        write(vec![]);
        assert!(analyze_epa(&connection, &[0.0,1.0,0.0], 3).cache_available);
    }
}


#[cfg(test)]
mod projection_budget_tests {
    use super::*;
    use crate::rivermemo_topology_v3::NativeArtifact;

    #[test]
    fn independent_domains_budget_union_and_pool_reuse() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE tags(id INTEGER PRIMARY KEY, vector BLOB);").unwrap();
        for (id, values) in [(1, [1.0f32, 0.0]), (2, [0.0, 1.0]), (3, [1.0, 1.0])] {
            let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
            connection.execute("INSERT INTO tags VALUES (?1,?2)",
                rusqlite::params![id, bytes]).unwrap();
        }
        let artifact = NativeArtifact {
            node_ids: vec![1, 2, 3],
            node_index: HashMap::from([(1, 0), (2, 1), (3, 2)]),
            row_offsets: vec![0, 2, 2, 2], targets: vec![1, 2], weights: vec![0.5, 0.5],
            inbound: HashMap::new(), max_inbound: 0.0, anchor_gain: HashMap::new(),
            wormhole_edges: HashSet::new(), provenance: HashMap::new(),
            ..NativeArtifact::default()
        };
        let local = [0.7, 0.2, 0.1];
        let transfer = [0.1, 0.7, 0.2];
        let mut pool = TagVectorPool::new();
        ensure_tag_vectors_loaded(&connection, &mut pool, &[1], 2).unwrap();
        let original = pool[&1].clone();
        let mut diagnostics = DualFieldDiagnostics::default();
        let projected = project_supported_fields(&connection, &artifact,
            [&local, &transfer], [&[1, 2], &[2, 3]], 2, 2, &[1],
            &mut pool, &mut diagnostics).unwrap();
        assert!(projected.0[0] > projected.0[1]);
        assert!(projected.1[1] > projected.1[0]);
        assert_eq!(diagnostics.projected_nodes, 2);
        assert_eq!(diagnostics.sql_fetched_nodes, 1);
        assert_eq!(diagnostics.sql_batches, 1);
        assert!((diagnostics.local_selected_mass_ratio - 0.9).abs() < 1e-12);
        assert!(Arc::ptr_eq(&original, &pool[&1]));
        project_supported_fields(&connection, &artifact,
            [&local, &transfer], [&[1, 2], &[2, 3]], 2, 2, &[1],
            &mut pool, &mut diagnostics).unwrap();
        assert_eq!(diagnostics.sql_batches, 0);
        assert_eq!(diagnostics.sql_fetched_nodes, 0);
        project_supported_fields(&connection, &artifact,
            [&local, &transfer], [&[1, 2], &[2, 3]], 2, 0, &[1],
            &mut pool, &mut diagnostics).unwrap();
        assert_eq!(diagnostics.selected_projection_nodes, 3);
        assert_eq!(diagnostics.sql_fetched_nodes, 1);
        assert!((diagnostics.local_selected_mass_ratio - 0.9).abs() < 1e-12);
    }

    #[test]
    fn arbitrary_budget_and_missing_rows_do_not_expand_support() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE tags(id INTEGER PRIMARY KEY, vector BLOB);").unwrap();
        let ids: Vec<i64> = (1..=600).collect();
        let artifact = NativeArtifact {
            node_index: ids.iter().enumerate().map(|(i,id)| (*id,i)).collect(),
            node_ids: ids.clone(),
            row_offsets: std::iter::once(0).chain(1..=599).chain(std::iter::once(599)).collect(),
            targets: (1..600).collect(), weights: vec![1.0; 599],
            inbound: HashMap::new(), max_inbound: 0.0, anchor_gain: HashMap::new(),
            wormhole_edges: HashSet::new(), provenance: HashMap::new(),
            ..NativeArtifact::default()
        };
        let values = vec![1.0; 600];
        for k in [0, 1, 64, 128, 193, 256, 512, 1000] {
            let mut diagnostics = DualFieldDiagnostics::default();
            let result = project_supported_fields(&connection, &artifact,
                [&values, &values], [&ids[..400], &ids[200..]], 2, k, &[1],
                &mut TagVectorPool::new(), &mut diagnostics).unwrap();
            let count = if k == 0 { 400 } else { k.min(400) };
            let expected: HashSet<i64> = ids[..count].iter().copied().collect();
            assert_eq!(diagnostics.selected_projection_nodes, expected.len());
            assert_eq!(diagnostics.sql_requested_nodes, expected.len());
            assert_eq!(diagnostics.sql_batches, expected.len().div_ceil(128));
            assert_eq!(diagnostics.projected_nodes, 0);
            assert_eq!(diagnostics.local_projected_mass_ratio, 0.0);
            assert_eq!(result, (vec![0.0; 2], vec![0.0; 2]));
        }
    }

    fn support_graph() -> NativeArtifact {
        // 1 -> 2 -> 3; 1 -> 4; 5 is an unreachable high-mass island.
        NativeArtifact {
            node_ids: vec![1, 2, 3, 4, 5],
            node_index: (1..=5).enumerate().map(|(i, id)| (id, i)).collect(),
            row_offsets: vec![0, 2, 3, 3, 3, 3],
            targets: vec![1, 3, 2], weights: vec![0.5, 0.5, 1.0],
            ..NativeArtifact::default()
        }
    }

    #[test]
    fn growing_keeps_low_mass_bridge_and_rejects_global_islands() {
        let graph = support_graph();
        let field = [0.1, 0.01, 0.3, 0.02, 0.57];
        let support = select_projection_support(&graph, &field, &[5, 3, 1], &[1], 0).unwrap();
        assert_eq!(support.ids, vec![1, 4, 2, 3]);
        assert_eq!(support.diagnostics.outside_domain_nodes, 2);
        assert_eq!(support.diagnostics.stop_reason, "frontier_exhausted");
        let limited = select_projection_support(&graph, &field, &[5, 3, 1], &[1], 3).unwrap();
        assert_eq!(limited.ids, vec![1, 4, 2]);
        assert_eq!(limited.diagnostics.stop_reason, "budget");
        // Every non-core node has an earlier selected, positive-weight predecessor.
        for (position, id) in support.ids.iter().enumerate().skip(1) {
            assert!(support.ids[..position].iter().any(|parent| graph.edge_weight(*parent, *id) > 0.0));
        }
    }

    #[test]
    fn fields_grow_independently_and_ties_use_tag_id() {
        let graph = support_graph();
        let local = select_projection_support(&graph, &[0.1, 0.6, 0.1, 0.1, 0.1],
            &[2, 1, 3, 4, 5], &[1], 2).unwrap();
        let transfer = select_projection_support(&graph, &[0.1, 0.1, 0.1, 0.6, 0.1],
            &[4, 1, 2, 3, 5], &[1], 2).unwrap();
        assert_eq!(local.ids, vec![1, 2]);
        assert_eq!(transfer.ids, vec![1, 4]);
        let tied = select_projection_support(&graph, &[0.2; 5],
            &[1, 2, 3, 4, 5], &[1], 2).unwrap();
        assert_eq!(tied.ids, vec![1, 2]);
    }

    #[test]
    fn core_budget_empty_core_and_mass_stop_are_explicit() {
        let graph = support_graph();
        let field = [0.2; 5];
        let error = select_projection_support(&graph, &field, &[1, 2], &[1, 2], 1)
            .err().unwrap();
        assert!(error.starts_with("MEMO_PROJECTION_CORE_EXCEEDS_BUDGET:"));
        let empty = select_projection_support(&graph, &field, &[1, 2], &[], 2).unwrap();
        assert!(empty.ids.is_empty());
        assert_eq!(empty.diagnostics.stop_reason, "empty_core");
        let stopped = select_projection_support(&graph, &field, &[1], &[1], 256).unwrap();
        assert_eq!(stopped.ids, vec![1]);
        assert_eq!(stopped.diagnostics.stop_reason, "mass_target");
        // Independent seed components stay explicit; no invented connecting edges.
        let multi = select_projection_support(&graph, &field, &[1, 5], &[5, 1, 5], 2).unwrap();
        assert_eq!(multi.ids, vec![1, 5]);
        assert_eq!(multi.diagnostics.core_nodes, 2);
    }

    #[test]
    fn zero_edges_cycles_and_numerical_tails_never_fill_seats() {
        let mut graph = support_graph();
        graph.weights[0] = 0.0;
        let support = select_projection_support(&graph, &[0.1, 0.4, 0.3, 1e-15, 0.2],
            &[1, 2, 3, 5], &[1], 256).unwrap();
        assert_eq!(support.ids, vec![1]);
        assert_eq!(support.diagnostics.stop_reason, "frontier_exhausted");
        let graph = NativeArtifact {
            node_ids: vec![1, 2], node_index: HashMap::from([(1, 0), (2, 1)]),
            row_offsets: vec![0, 2, 3], targets: vec![0, 1, 0], weights: vec![1.0; 3],
            ..NativeArtifact::default()
        };
        let support = select_projection_support(&graph, &[0.5, 0.5], &[1, 2], &[1], 0).unwrap();
        assert_eq!(support.ids, vec![1, 2]);
    }

    #[test]
    fn budget_config_is_nonnegative_integer_with_default() {
        let default: PipelineConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(default.max_field_projection_nodes, 256);
        for k in [0, 64, 193, 512] {
            let config: PipelineConfig = serde_json::from_value(
                serde_json::json!({"maxFieldProjectionNodes": k})).unwrap();
            assert_eq!(config.max_field_projection_nodes, k);
        }
        for value in [serde_json::json!(-1), serde_json::json!(1.5), serde_json::json!("256")] {
            assert!(serde_json::from_value::<PipelineConfig>(
                serde_json::json!({"maxFieldProjectionNodes": value})).is_err());
        }
    }
}


#[cfg(test)]
mod stoploss_gate_tests {
    use super::*;

    #[test]
    fn contribution_tails_are_removed_and_residual_focus_keeps_weight() {
        let epa = EpaOutput {
            logic_depth: 0.5, entropy: 0.5, resonance: 0.0, dominant_axes: vec![],
            bridges: vec![], basis_count: 0, cache_available: false, out_of_domain: 1.0,
            semantic_explained_ratio: 0.0, in_domain_gate: 0.0,
            baseline_coverage: 0.0, background_ratio: 0.0,
        };
        let make = |id, contribution, similarity| PyramidTagWork {
            id, name: format!("标签{id}"), vector: Arc::from(
                if id == 2 || id == 4 { vec![0.0_f32, 1.0] } else { vec![1.0_f32, 0.0] }),
            similarity, contribution, handshake_magnitude: 0.0,
        };
        let levels = vec![vec![make(1, 0.66, 0.66), make(2, 0.02, 0.6)],
            vec![make(3, 0.2, 0.32), make(4, 0.01, 0.1), make(5, 0.1, -0.1)]];
        let pyramid = PyramidOutput { levels: vec![], total_explained_energy: 0.68,
            features: PyramidFeatures::default() };
        let (gated, _, _) = gate_tags(&levels, &epa, &pyramid, &[], &PipelineConfig::default(), "");
        assert_eq!(gated.iter().map(|t| t.id).collect::<Vec<_>>(), vec![1, 3]);
        assert!((gated[1].weight - 0.2).abs() < 1e-12);
    }
}


#[cfg(test)]
mod lexical_patch_tests {
    use super::*;

    fn epa() -> EpaOutput {
        EpaOutput { logic_depth: 0.5, entropy: 0.5, resonance: 0.0,
            dominant_axes: vec![], bridges: vec![], basis_count: 0,
            cache_available: false, out_of_domain: 1.0,
            semantic_explained_ratio: 0.0, in_domain_gate: 0.0,
            baseline_coverage: 0.0, background_ratio: 0.0 }
    }

    #[test]
    fn lexical_grounding_respects_ascii_boundaries_and_mixed_names() {
        let query = "小冰，还记得那个 Lunarium 星之旅吗？";
        for name in ["Lunarium星之旅", "Lunarium", "星之旅"] {
            assert_eq!(lexical_grounding(query, name), 1.0);
        }
        assert_eq!(lexical_grounding(query, "AI自编自演Galgame"), 0.0);
        assert_eq!(lexical_grounding("chair", "AI"), 0.0);
        assert_eq!(lexical_grounding("", "Lunarium"), 0.0);
        assert_eq!(lexical_grounding("测试", ""), 0.0);
    }

    #[test]
    fn grounded_residual_and_short_alias_survive_and_ignite_without_lowering_threshold() {
        let make = |id, name: &str, contribution, similarity, vector: Vec<f32>| PyramidTagWork {
            id, name: name.into(), contribution, similarity,
            vector: Arc::from(vector), handshake_magnitude: 0.0,
        };
        // Realistic layer-normalized coefficients; short alias loses its
        // independent component under Gram-Schmidt but retains identity.
        let levels = vec![
            vec![make(1, "AI自编自演Galgame", 0.6604, 0.66, vec![1.0, 0.0])],
            vec![make(2, "Lunarium星之旅", 0.2109 / 0.6648, 0.32, vec![0.0, 1.0]),
                 make(3, "Lunarium", 0.0288 / 0.6648, 0.23, vec![0.0, 1.0])],
        ];
        let pyramid = PyramidOutput { levels: vec![], total_explained_energy: 0.68,
            features: PyramidFeatures::default() };
        let (gated, _, _) = gate_tags(&levels, &epa(), &pyramid, &[],
            &PipelineConfig::default(), "Lunarium 星之旅有问题");
        let focus = gated.iter().find(|t| t.id == 2).unwrap();
        let alias = gated.iter().find(|t| t.id == 3).unwrap();
        let implicit = gated.iter().find(|t| t.id == 1).unwrap();
        assert!(focus.lexical && alias.lexical);
        assert!(focus.weight > 0.5);
        assert!(alias.weight > 0.3); // ASCII language penalty must not suppress literal names.
        assert!(implicit.weight <= focus.weight * 0.35);
        let graph = crate::rivermemo_topology_v3::NativeArtifact {
            node_ids: vec![1, 2, 3, 4],
            node_index: [(1,0), (2,1), (3,2), (4,3)].into_iter().collect(),
            row_offsets: vec![0,0,1,1,1], targets: vec![3], weights: vec![0.1],
            ..crate::rivermemo_topology_v3::NativeArtifact::default()
        }.prepared();
        let output = sense_typed(&graph, "lexical-test", SenseInput {
            query_id: None,
            seeds: gated.iter().map(|t| SenseSeed { id: t.id, energy: t.weight,
                source_type: if t.lexical { "lexical_seed" } else { "seed" }.into() }).collect(),
            config: SenseConfig::default(),
        }).unwrap();
        assert!(output.edges.iter().any(|e| e.source_id == 2 && e.target_id == 4));
        assert_eq!(output.nodes.iter().find(|n| n.id == 2).unwrap().source_type, "lexical_seed");
    }
}


#[cfg(test)]
mod v21_seed_tests {
    use super::*;

    fn tag(id: i64, weight: f64, lexical: bool) -> GatedTag {
        GatedTag { id, name: id.to_string(), weight, lexical, is_core: false }
    }
    fn epa() -> EpaOutput {
        EpaOutput { logic_depth: 0.5, entropy: 0.5, resonance: 0.0,
            dominant_axes: vec![], bridges: vec![], basis_count: 0, cache_available: false,
            out_of_domain: 1.0, semantic_explained_ratio: 0.0, in_domain_gate: 0.0,
            baseline_coverage: 0.0, background_ratio: 0.0 }
    }

    #[test]
    fn proportional_scaling_preserves_ratios_and_ignores_missing_explicit_node() {
        let original = vec![tag(1, 0.4, true), tag(2, 0.8, false), tag(3, 0.4, false)];
        let mut accepted = original.clone();
        scale_implicit_seeds(&mut accepted, Some(&HashMap::from([(1, 0)])));
        assert!((accepted[1].weight - 0.14).abs() < 1e-12);
        assert!((accepted[1].weight / accepted[2].weight - 2.0).abs() < 1e-12);
        let mut missing = original.clone();
        scale_implicit_seeds(&mut missing, Some(&HashMap::from([(2, 0), (3, 1)])));
        assert_eq!(missing.iter().map(|t| t.weight).collect::<Vec<_>>(), vec![0.4, 0.8, 0.4]);
    }

    #[test]
    fn sponsorship_has_gradient_and_collapsed_rescue_is_bounded_without_rewriting_energy() {
        let make = |id, similarity, contribution| PyramidTagWork {
            id, name: format!("标签{id}"), similarity, contribution,
            vector: Arc::from(vec![1.0, 0.0]), handshake_magnitude: 0.0,
        };
        let pyramid = PyramidOutput { levels: vec![], total_explained_energy: 1.0,
            features: PyramidFeatures::default() };
        let config = PipelineConfig::default();
        let levels = vec![vec![make(1, 0.8, 0.8), make(2, 0.7, 0.01), make(3, 0.4, 0.01)]];
        let (gated, _, _) = gate_tags(&levels, &epa(), &pyramid, &[], &config, "");
        assert!(gated[1].weight > gated[2].weight);
        assert!((gated[1].weight / gated[2].weight - 1.75).abs() < 1e-12);
        let levels = vec![vec![make(1, 0.96, 0.96), make(2, 0.90, 1e-9),
            make(3, 0.80, 1e-10), make(4, 0.76, 1e-11)]];
        let (gated, _, _) = gate_tags(&levels, &epa(), &pyramid, &[], &config, "");
        assert_eq!(gated.len(), 3);
        assert!(gated[1].weight > gated[2].weight);
        assert!(gated[1..].iter().map(|t| t.weight).sum::<f64>() <= 0.3 * 0.96);
        assert!(gated.iter().all(|t| !t.lexical && !t.is_core));
        assert_eq!(levels[0][1].contribution, 1e-9);
        assert_eq!(pyramid.total_explained_energy, 1.0);
    }
}


#[cfg(test)]
mod v22_residual_tests {
    use super::*;
    use crate::rivermemo_topology_v3::NativeArtifact;

    fn fixture() -> (Connection, crate::VexusIndex) {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE tags(id INTEGER PRIMARY KEY,name TEXT,vector BLOB);").unwrap();
        let index = crate::VexusIndex::new(3, 16).unwrap();
        for (id, v) in [(1, [1.0_f32,0.0,0.0]), (2, [0.0,1.0,0.0]),
            (3, [0.0,0.0,1.0]), (99, [3.0,2.0,1.0])] {
            let bytes: Vec<u8> = v.iter().flat_map(|x| x.to_le_bytes()).collect();
            db.execute("INSERT INTO tags VALUES (?1,?2,?3)",
                rusqlite::params![id, format!("tag{id}"), bytes]).unwrap();
            if id != 3 { index.index.write().unwrap().add(id as u64, &v).unwrap(); }
        }
        db.execute_batch("BEGIN").unwrap();
        (db, index)
    }

    #[test]
    fn graph_external_tag_is_filtered_before_projection_but_isolated_member_survives() {
        let (db, index) = fixture();
        let config = PipelineConfig { max_levels: 1, pyramid_top_k: 3, ..PipelineConfig::default() };
        let eligible = HashMap::from([(1,0)]);
        let (p, tags, residuals) = analyze_pyramid_with_pool(&index.index, &db,
            &[3.0,2.0,1.0], 3, &config, &mut TagVectorPool::new(), Some(&eligible)).unwrap();
        assert_eq!(tags[0].iter().map(|t| t.id).collect::<Vec<_>>(), vec![1]);
        assert!((p.total_explained_energy - 9.0/14.0).abs() < 1e-6);
        assert_eq!(residuals.len(), 2);
        assert_eq!(residuals[1], vec![0.0,2.0,1.0]);
        let empty = HashMap::new();
        let (p, tags, residuals) = analyze_pyramid_with_pool(&index.index, &db,
            &[3.0,2.0,1.0], 3, &config, &mut TagVectorPool::new(), Some(&empty)).unwrap();
        assert!(p.levels.is_empty() && tags.is_empty() && residuals.is_empty());
    }

    #[test]
    fn final_tail_routes_single_and_last_accepted_layer_without_extra_seeds() {
        let (db, index) = fixture();
        // Remove the graph-external top hit from the index for the one-hit layer test.
        // SQL remains authoritative; a separate index has only the two seed axes.
        let axes = crate::VexusIndex::new(3,16).unwrap();
        axes.index.write().unwrap().add(1, &[1.0,0.0,0.0]).unwrap();
        axes.index.write().unwrap().add(2, &[0.0,1.0,0.0]).unwrap();
        let graph = NativeArtifact {
            node_ids: vec![1,2,3], node_index: HashMap::from([(1,0),(2,1),(3,2)]),
            row_offsets: vec![0,1,2,2], targets: vec![2,2], weights: vec![0.2,0.2],
            ..NativeArtifact::default()
        }.prepared();
        for depth in [1,2] {
            let config = PipelineConfig { max_levels: depth, pyramid_top_k: 1,
                ..PipelineConfig::default() };
            let mut pool = TagVectorPool::new();
            let (p, tags, residuals) = analyze_pyramid_with_pool(&axes.index, &db,
                &[3.0,2.0,1.0], 3, &config, &mut pool, Some(&graph.node_index)).unwrap();
            assert_eq!(p.levels.len(), depth);
            assert_eq!(tags.len(), depth);
            assert_eq!(residuals.len(), depth + 1);
            let last = tags.last().unwrap()[0].id;
            let mut ctx = DynamicWormholeContext::new(&db, &mut pool, residuals,
                HashMap::from([(last,depth-1)]));
            let output = sense_with_context(&graph, "tail-test", SenseInput {
                query_id: None,
                seeds: vec![SenseSeed { id: last, energy: 1.0, source_type: "seed".into() }],
                config: SenseConfig { max_safe_hops: 1, ..SenseConfig::default() },
            }, Some(&mut ctx)).unwrap();
            assert_eq!(output.diagnostics.accepted_seed_nodes, 1);
            assert!(output.diagnostics.dynamic_wormhole_candidates > 0);
            assert_eq!(output.diagnostics.dynamic_wormhole_edges_fired, 1);
            assert!(output.edges.iter().all(|e| e.source_id == last && e.target_id == 3));
        }
        drop(index);
    }

    #[test]
    fn disabled_tiny_exhausted_and_unaccepted_tails_are_not_appended() {
        let (db, index) = fixture();
        let eligible = HashMap::from([(1,0)]);
        for (enabled, query, minimum, expected_layers, expected_residuals) in [
            (false, [3.0,2.0,1.0], 0.03, 1, 0),
            (true, [10.0,1.0,0.0], 0.03, 1, 1),
            (true, [1.0,0.0,0.0], 0.03, 1, 1),
            (true, [3.0,2.0,1.0], 0.99, 0, 0),
        ] {
            let config = PipelineConfig { max_levels: 1, pyramid_top_k: 3,
                min_layer_explained_energy: minimum,
                spike_routing: SenseConfig { dynamic_wormholes: enabled, ..SenseConfig::default() },
                ..PipelineConfig::default() };
            let (p, _, residuals) = analyze_pyramid_with_pool(&index.index, &db,
                &query, 3, &config, &mut TagVectorPool::new(), Some(&eligible)).unwrap();
            assert_eq!(p.levels.len(), expected_layers);
            assert_eq!(residuals.len(), expected_residuals);
        }
    }
}


#[cfg(test)]
mod explicit_core_seed_tests {
    use super::*;

    #[test]
    fn sql_cores_and_hard_anchors_ignite_without_pyramid_but_soft_ghosts_do_not() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE tags(id INTEGER PRIMARY KEY,name TEXT,vector BLOB);").unwrap();
        for (id, name, vector) in [
            (1, "尊界", [1.0_f32, 0.0]), (2, "问界", [0.0, 1.0]),
            (3, "软标签", [1.0, 1.0]), (4, "图外", [1.0, 0.0]),
            (5, "坏向量", [0.0, 0.0]),
        ] {
            let bytes: Vec<u8> = vector.iter().flat_map(|v| v.to_le_bytes()).collect();
            db.execute("INSERT INTO tags VALUES (?1,?2,?3)",
                rusqlite::params![id, name, bytes]).unwrap();
        }
        let ghost = |name: &str, is_core| GhostTagInput {
            name: name.into(), vector: vec![1.0, 0.0], is_core,
        };
        let ghosts = vec![ghost("问界", true), ghost("软标签", false),
            ghost("不存在", true)];
        let cores = vec![" 尊界 ".into(), "尊界".into(), "图外".into(), "坏向量".into()];
        let graph = crate::rivermemo_topology_v3::NativeArtifact {
            node_ids: vec![1, 2, 3, 5],
            node_index: HashMap::from([(1, 0), (2, 1), (3, 2), (5, 3)]),
            row_offsets: vec![0, 1, 1, 1, 1], targets: vec![2], weights: vec![0.5],
            ..crate::rivermemo_topology_v3::NativeArtifact::default()
        }.prepared();
        let resolved = resolve_core_seeds(&db, &cores, &ghosts,
            &graph.node_index, &mut TagVectorPool::new(), 2).unwrap();
        assert_eq!(resolved, vec![(1, "尊界".into()), (2, "问界".into())]);
        let epa = EpaOutput {
            logic_depth: 0.0, entropy: 1.0, resonance: 0.0, dominant_axes: vec![],
            bridges: vec![], basis_count: 0, cache_available: false, out_of_domain: 1.0,
            semantic_explained_ratio: 0.0, in_domain_gate: 0.0,
            baseline_coverage: 0.0, background_ratio: 0.0,
        };
        let pyramid = PyramidOutput { levels: vec![], total_explained_energy: 0.0,
            features: PyramidFeatures::default() };
        let (gated, _, boost) = gate_tags_for_graph(&[], &epa, &pyramid, &cores,
            &PipelineConfig::default(), "", Some(&graph.node_index), &resolved);
        assert_eq!(gated.len(), 2);
        assert!(gated.iter().all(|t| t.is_core && t.weight == boost));
        let observation = sense_typed(&graph, "explicit-core", SenseInput {
            query_id: None, config: SenseConfig::default(),
            seeds: gated.iter().map(|t| SenseSeed {
                id: t.id, energy: t.weight, source_type: "core".into(),
            }).collect(),
        }).unwrap();
        assert_eq!(observation.diagnostics.accepted_seed_nodes, 2);
        for id in [1, 2] {
            let node = observation.nodes.iter().find(|n| n.id == id).unwrap();
            assert_eq!(node.hop, 0);
            assert_eq!(node.source_type, "core");
        }
        assert!(!observation.edges.is_empty());
        let (_, fusion, _) = fuse_observation(&db, &[1.0, 0.0], &observation,
            &gated, &[], &ghosts[..1], boost, 2, 0.2, &PipelineConfig::default()).unwrap();
        assert_eq!(fusion.ghost_count, 0);

        let levels = vec![vec![PyramidTagWork {
            id: 1, name: "尊界".into(), vector: Arc::from(vec![1.0, 0.0]),
            similarity: 0.2, contribution: 0.01, handshake_magnitude: 0.0,
        }]];
        let (promoted, _, boost) = gate_tags_for_graph(&levels, &epa, &pyramid, &cores,
            &PipelineConfig::default(), "", Some(&graph.node_index), &resolved);
        assert_eq!(promoted.len(), 2);
        assert!(promoted.iter().all(|t| t.is_core && t.weight >= boost));
    }
}
