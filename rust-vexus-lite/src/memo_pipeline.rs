use crate::memo_sensing::{sense_typed, SenseConfig, SenseInput, SenseOutput, SenseSeed};
use crate::rivermemo_topology_v3::{load_artifact_from_runtime, MemoRuntime};
use base64::Engine;
use napi::bindgen_prelude::*;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use usearch::Index;

const PIPELINE_SCHEMA: &str = "vexus-unified-memo-pipeline-v1";
const PIPELINE_ALGORITHM: &str = "tagmemo.epa-pyramid-spike-fusion-v9.2-rust";

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

fn open_readonly(path: &str) -> std::result::Result<Connection, String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("open Memo pipeline SQLite failed: {}", error))?;
    connection
        .busy_timeout(Duration::from_secs(30))
        .map_err(|error| format!("configure Memo pipeline timeout failed: {}", error))?;
    connection
        .pragma_update(None, "query_only", "ON")
        .map_err(|error| format!("configure Memo pipeline query_only failed: {}", error))?;
    Ok(connection)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PipelineInput {
    #[serde(default)]
    query_id: Option<String>,
    #[serde(default, rename = "queryText")]
    _query_text: String,
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
    max_levels: usize,
    pyramid_top_k: usize,
    min_energy_ratio: f64,
    layer_decay: f64,
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
            max_levels: 3,
            pyramid_top_k: 10,
            min_energy_ratio: 0.1,
            layer_decay: 0.7,
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
}

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

fn analyze_epa(connection: &Connection, query: &[f32], dimension: usize) -> EpaOutput {
    let empty = || EpaOutput {
        logic_depth: 0.0,
        entropy: 1.0,
        resonance: 0.0,
        dominant_axes: Vec::new(),
        bridges: Vec::new(),
        basis_count: 0,
        cache_available: false,
    };
    let raw = match connection.query_row(
        "SELECT value FROM kv_store WHERE key = 'epa_basis_cache'",
        [],
        |row| row.get::<_, String>(0),
    ) {
        Ok(value) => value,
        Err(_) => return empty(),
    };
    let cache: EpaCache = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(_) => return empty(),
    };
    let mean = match decode_f32_base64(&cache.mean, dimension) {
        Some(value) => value,
        None => return empty(),
    };
    let bases: Vec<Vec<f32>> = cache
        .basis
        .iter()
        .filter_map(|encoded| decode_f32_base64(encoded, dimension))
        .collect();
    if bases.is_empty() {
        return empty();
    }

    let centered: Vec<f32> = query
        .iter()
        .zip(mean.iter())
        .map(|(value, average)| value - average)
        .collect();
    let projections: Vec<f64> = bases.iter().map(|basis| dot(&centered, basis)).collect();
    let total_energy = projections.iter().map(|value| value * value).sum::<f64>();
    if total_energy <= 1e-12 {
        return empty();
    }
    let probabilities: Vec<f64> = projections
        .iter()
        .map(|value| value * value / total_energy)
        .collect();
    let raw_entropy = probabilities
        .iter()
        .filter(|value| **value > 1e-9)
        .map(|value| -value * value.log2())
        .sum::<f64>();
    let normalized_entropy = if probabilities.len() > 1 {
        clamp01(raw_entropy / (probabilities.len() as f64).log2())
    } else {
        0.0
    };
    let mut dominant_axes: Vec<EpaAxis> = probabilities
        .iter()
        .enumerate()
        .filter(|(_, energy)| **energy > 0.05)
        .map(|(index, energy)| EpaAxis {
            index,
            label: cache
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
        logic_depth: 1.0 - normalized_entropy,
        entropy: normalized_entropy,
        resonance,
        dominant_axes,
        bridges,
        basis_count: bases.len(),
        cache_available: true,
    }
}

#[derive(Clone)]
struct PyramidTagWork {
    id: i64,
    name: String,
    vector: Vec<f32>,
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
    let mut statement = connection
        .prepare("SELECT name FROM tags WHERE id = ?1")
        .map_err(|error| format!("prepare Memo pipeline Tag name query failed: {}", error))?;
    for id in ids {
        if let Ok(name) = statement.query_row(rusqlite::params![id], |row| row.get::<_, String>(0))
        {
            names.insert(*id, name);
        }
    }
    Ok(names)
}

fn analyze_pyramid(
    index: &Index,
    connection: &Connection,
    query: &[f32],
    dimension: usize,
    config: &PipelineConfig,
) -> std::result::Result<(PyramidOutput, Vec<Vec<PyramidTagWork>>), String> {
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
        ));
    }

    let mut residual = query.to_vec();
    let mut levels_output = Vec::new();
    let mut levels_work = Vec::new();
    let mut total_explained = 0.0;
    for level in 0..config.max_levels.clamp(1, 8) {
        let matches = index
            .search(&residual, config.pyramid_top_k.clamp(1, 128))
            .map_err(|error| format!("Memo pyramid usearch search failed: {:?}", error))?;
        if matches.keys.is_empty() {
            break;
        }
        let ids: Vec<i64> = matches.keys.iter().map(|id| *id as i64).collect();
        let names = load_tag_names(connection, &ids)?;
        let mut buffer = vec![0.0f32; dimension];
        let mut tags = Vec::new();
        for (position, id) in ids.iter().enumerate() {
            let found = index
                .get(*id as u64, &mut buffer)
                .map_err(|error| format!("Memo pyramid Tag vector read failed: {:?}", error))?;
            if found == 0 {
                continue;
            }
            tags.push(PyramidTagWork {
                id: *id,
                name: names
                    .get(id)
                    .cloned()
                    .unwrap_or_else(|| format!("Tag#{}", id)),
                vector: buffer.clone(),
                similarity: matches
                    .distances
                    .get(position)
                    .map(|distance| 1.0 / (1.0 + *distance as f64))
                    .unwrap_or(0.0),
                contribution: 0.0,
                handshake_magnitude: 0.0,
            });
        }
        if tags.is_empty() {
            break;
        }

        let current_energy = magnitude(&residual).powi(2);
        let (projection, next_residual, coefficients) =
            orthogonal_projection(&residual, &tags, dimension);
        for (tag, coefficient) in tags.iter_mut().zip(coefficients.iter()) {
            tag.contribution = *coefficient;
        }
        let handshake = analyze_handshakes(&residual, &mut tags, dimension);
        let residual_magnitude = magnitude(&next_residual);
        let residual_energy = residual_magnitude * residual_magnitude;
        let energy_explained = positive(current_energy - residual_energy) / original_energy;
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
        levels_work.push(tags);
        residual = next_residual;
        if residual_energy / original_energy < config.min_energy_ratio.clamp(0.0, 1.0) {
            break;
        }
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
    ))
}

#[derive(Clone)]
struct GatedTag {
    id: i64,
    name: String,
    weight: f64,
    is_core: bool,
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

fn gate_tags(
    levels: &[Vec<PyramidTagWork>],
    epa: &EpaOutput,
    pyramid: &PyramidOutput,
    core_tags: &[String],
    config: &PipelineConfig,
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
    let core_names: HashSet<String> = core_tags.iter().map(|name| name.to_lowercase()).collect();
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
        for tag in tags {
            if tag.id <= 0 || !seen.insert(tag.id) {
                continue;
            }
            let is_core = core_names.contains(&tag.name.to_lowercase());
            let relevance = if tag.similarity != 0.0 {
                tag.similarity
            } else {
                0.5
            };
            let core_gain = if is_core {
                dynamic_core_boost * (0.95 + relevance * 0.1)
            } else {
                1.0
            };
            let mut language_gain = 1.0;
            if config.lang_confidence_enabled && technical_name(&tag.name, true) && !technical_world
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
            let layer_gain = config.layer_decay.clamp(0.0, 1.0).powi(level as i32);
            let weight = positive(tag.contribution) * layer_gain * language_gain * core_gain;
            if weight > 0.0 {
                gated.push(GatedTag {
                    id: tag.id,
                    name: tag.name.clone(),
                    weight,
                    is_core,
                });
            }
        }
    }
    (gated, effective_boost.clamp(0.0, 1.0), dynamic_core_boost)
}

#[derive(Clone)]
struct FusionTag {
    id: i64,
    name: String,
    weight: f64,
    is_core: bool,
    vector: Vec<f32>,
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

fn fuse_observation(
    index: &Index,
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
            });
        } else {
            emergent.push(GatedTag {
                id: node.id,
                name: String::new(),
                weight: node.energy,
                is_core: false,
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

    // 字符串 Core 不参与本轮 Spike 扩散；传播完成后按名称从数据库补入，
    // 保持 JS 的“最终融合锚点”语义。
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
            });
            supplemented_core_count += 1;
        }
    }

    let requested_count = merged.len() + ghost_tags.len();
    let mut buffer = vec![0.0f32; dimension];
    let mut vectors = Vec::with_capacity(requested_count);
    for tag in merged {
        let found = index
            .get(tag.id as u64, &mut buffer)
            .map_err(|error| format!("Memo pipeline fusion vector read failed: {:?}", error))?;
        if found == 0 {
            continue;
        }
        if magnitude(&buffer) > 1e-12 {
            vectors.push(FusionTag {
                id: tag.id,
                name: if tag.name.is_empty() {
                    format!("Tag#{}", tag.id)
                } else {
                    tag.name
                },
                weight: tag.weight,
                is_core: tag.is_core,
                vector: buffer.clone(),
            });
        }
    }

    // 幽灵节点使用专属负 ID，仅参与去重与向量融合，绝不进入 Artifact/Spike。
    let mut ghost_id = -1i64;
    let mut accepted_ghosts = 0usize;
    for ghost in ghost_tags {
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
            vector: ghost.vector.clone(),
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DualFieldDiagnostics {
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

fn apply_transport(artifact: &crate::rivermemo_topology_v3::NativeArtifact, input: &[f64], output: &mut [f64]) {
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

fn l1_distance(left: &[f64], right: &[f64]) -> f64 {
    left.iter().zip(right).map(|(a, b)| (a - b).abs()).sum()
}

fn field_mass(field: &[f64]) -> f64 {
    field.iter().map(|value| positive(*value)).sum()
}

fn effective_domain(artifact: &crate::rivermemo_topology_v3::NativeArtifact, field: &[f64], ratio: f64) -> Vec<i64> {
    let total = field_mass(field);
    if total <= 0.0 {
        return Vec::new();
    }
    let mut ranked: Vec<(i64, f64)> = artifact.node_ids.iter().copied()
        .zip(field.iter().copied())
        .filter(|(_, mass)| *mass > 0.0)
        .collect();
    ranked.sort_by(|left, right| right.1.partial_cmp(&left.1).unwrap_or(Ordering::Equal).then_with(|| left.0.cmp(&right.0)));
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

fn project_field(index: &Index, artifact: &crate::rivermemo_topology_v3::NativeArtifact, field: &[f64], dimension: usize) -> std::result::Result<Vec<f32>, String> {
    let mut output = vec![0.0f64; dimension];
    let mut buffer = vec![0.0f32; dimension];
    let mut total = 0.0;
    for (node_index, mass) in field.iter().copied().enumerate() {
        if mass <= 0.0 {
            continue;
        }
        let id = artifact.node_ids[node_index];
        let found = index.get(id as u64, &mut buffer)
            .map_err(|error| format!("Memo field projection failed for Tag {}: {:?}", id, error))?;
        if found == 0 {
            continue;
        }
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

fn solve_dual_fields(
    artifact: &crate::rivermemo_topology_v3::NativeArtifact,
    index: &Index,
    source_entries: &[(i64, f64)],
    dimension: usize,
    config: &PipelineConfig,
) -> std::result::Result<DualFieldOutput, String> {
    let mut source = vec![0.0f64; artifact.node_ids.len()];
    for (id, mass) in source_entries {
        if let Some(index) = artifact.node_index.get(id) {
            source[*index] += positive(*mass);
        }
    }
    let source_mass = field_mass(&source);
    if source_mass <= 0.0 {
        return Err("Memo dual field source contains no positive mass".to_string());
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
        if !local_converged {
            apply_transport(artifact, &local, &mut propagated_local);
            for index in 0..source.len() {
                next_local[index] = (1.0 - local_alpha) * source[index] + local_alpha * propagated_local[index];
            }
            local_residual = l1_distance(&next_local, &local);
            local_converged = local_residual <= config.local_tolerance.max(1e-15);
            std::mem::swap(&mut local, &mut next_local);
        }
        if !transfer_converged {
            apply_transport(artifact, &transfer, &mut propagated_transfer);
            for index in 0..source.len() {
                next_transfer[index] = (1.0 - transfer_alpha) * source[index] + transfer_alpha * propagated_transfer[index];
            }
            transfer_residual = l1_distance(&next_transfer, &transfer);
            transfer_converged = transfer_residual <= config.transfer_tolerance.max(1e-15);
            std::mem::swap(&mut transfer, &mut next_transfer);
        }
        if local_converged && transfer_converged {
            break;
        }
    }

    let local_field: Vec<(i64, f64)> = artifact.node_ids.iter().copied().zip(local.iter().copied())
        .filter(|(_, mass)| *mass > 0.0).collect();
    let transfer_field: Vec<(i64, f64)> = artifact.node_ids.iter().copied().zip(transfer.iter().copied())
        .filter(|(_, mass)| *mass > 0.0).collect();
    let local_domain_ids = effective_domain(artifact, &local, config.local_mass_ratio);
    let transfer_domain_ids = effective_domain(artifact, &transfer, config.transfer_mass_ratio);
    let local_vector = project_field(index, artifact, &local, dimension)?;
    let transfer_vector = project_field(index, artifact, &transfer, dimension)?;
    let local_mass = field_mass(&local);
    let transfer_mass = field_mass(&transfer);

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
    total_ms: f64,
    seed_nodes: usize,
    dual_field: DualFieldDiagnostics,
    fusion: FusionDiagnostics,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PipelineOutput {
    schema: String,
    algorithm_version: String,
    artifact_sig: String,
    query_id: Option<String>,
    observation_handle: Option<String>,
    observation: SenseOutput,
    enhanced_vector: Vec<f64>,
    local_vector: Vec<f32>,
    transfer_vector: Vec<f32>,
    local_field: Vec<(i64, f64)>,
    transfer_field: Vec<(i64, f64)>,
    local_domain_ids: Vec<i64>,
    transfer_domain_ids: Vec<i64>,
    epa: EpaOutput,
    pyramid: PyramidOutput,
    matched_tags: Vec<String>,
    core_tags_matched: Vec<String>,
    effective_tag_boost: f64,
    diagnostics: PipelineDiagnostics,
}

fn run_pipeline(
    index: &Arc<RwLock<Index>>,
    runtime: &MemoRuntime,
    db_path: &str,
    artifact_sig: &str,
    dimensions: usize,
    input_json: &str,
) -> std::result::Result<String, String> {
    let total_started = Instant::now();
    let input: PipelineInput = serde_json::from_str(input_json)
        .map_err(|error| format!("invalid unified Memo pipeline input JSON: {}", error))?;
    if input.query_vector.len() != dimensions {
        return Err(format!(
            "Memo pipeline dimension mismatch: expected {}, got {}",
            dimensions,
            input.query_vector.len()
        ));
    }
    let artifact = load_artifact_from_runtime(runtime, db_path, artifact_sig)?;
    let connection = open_readonly(db_path)?;

    let epa_started = Instant::now();
    let epa = analyze_epa(&connection, &input.query_vector, dimensions);
    let epa_ms = epa_started.elapsed().as_secs_f64() * 1000.0;

    let pyramid_started = Instant::now();
    let index_guard = index
        .read()
        .map_err(|error| format!("Memo pipeline index lock failed: {}", error))?;
    let (pyramid, level_tags) = analyze_pyramid(
        &index_guard,
        &connection,
        &input.query_vector,
        dimensions,
        &input.config,
    )?;
    let pyramid_ms = pyramid_started.elapsed().as_secs_f64() * 1000.0;

    let gating_started = Instant::now();
    let (gated_tags, effective_tag_boost, dynamic_core_boost) =
        gate_tags(&level_tags, &epa, &pyramid, &input.core_tags, &input.config);
    // 空 Pyramid 门控不再中止：Spike 生成合法空观测，随后字符串 Core/幽灵
    // 仍按 JS SOTA 在传播后注入；若最终仍为空，融合层返回原查询向量。
    let seeds: Vec<SenseSeed> = gated_tags
        .iter()
        .map(|tag| SenseSeed {
            id: tag.id,
            energy: tag.weight,
            source_type: if tag.is_core {
                "core".to_string()
            } else {
                "seed".to_string()
            },
        })
        .collect();
    let gating_ms = gating_started.elapsed().as_secs_f64() * 1000.0;

    let sensing_started = Instant::now();
    let observation = sense_typed(
        &artifact,
        artifact_sig,
        SenseInput {
            query_id: input.query_id.clone(),
            seeds,
            config: input.config.spike_routing.clone(),
        },
    )?;
    let sensing_ms = sensing_started.elapsed().as_secs_f64() * 1000.0;

    let fusion_started = Instant::now();
    let (enhanced_vector, fusion, selected_tags) = fuse_observation(
        &index_guard,
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
    )?;
    let fusion_ms = fusion_started.elapsed().as_secs_f64() * 1000.0;
    let dual_fields = solve_dual_fields(
        &artifact,
        &index_guard,
        &observation.source_field,
        dimensions,
        &input.config,
    )?;
    drop(index_guard);
    drop(connection);

    let observation_handle = runtime
        .store_query_observation(
            artifact_sig,
            observation.clone(),
            input.query_vector.clone(),
            enhanced_vector.iter().map(|value| *value as f32).collect(),
            dual_fields.local_vector.clone(),
            dual_fields.transfer_vector.clone(),
            dual_fields.local_field.clone(),
            dual_fields.transfer_field.clone(),
            dual_fields.local_domain_ids.clone(),
            dual_fields.transfer_domain_ids.clone(),
        )
        .ok();

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

    let DualFieldOutput {
        local_field,
        transfer_field,
        local_domain_ids,
        transfer_domain_ids,
        local_vector,
        transfer_vector,
        diagnostics: dual_field_diagnostics,
    } = dual_fields;

    serde_json::to_string(&PipelineOutput {
        schema: PIPELINE_SCHEMA.to_string(),
        algorithm_version: PIPELINE_ALGORITHM.to_string(),
        artifact_sig: artifact_sig.to_string(),
        query_id: input.query_id.clone(),
        observation_handle,
        observation,
        enhanced_vector,
        local_vector,
        transfer_vector,
        local_field,
        transfer_field,
        local_domain_ids,
        transfer_domain_ids,
        epa,
        pyramid,
        matched_tags,
        core_tags_matched,
        effective_tag_boost,
        diagnostics: PipelineDiagnostics {
            backend: "rust-unified-memo-pipeline".to_string(),
            runtime_ownership: "vexus-index-instance".to_string(),
            epa_ms,
            pyramid_ms,
            gating_ms,
            sensing_ms,
            fusion_ms,
            total_ms: total_started.elapsed().as_secs_f64() * 1000.0,
            seed_nodes,
            dual_field: dual_field_diagnostics,
            fusion,
        },
    })
    .map_err(|error| format!("encode unified Memo pipeline output failed: {}", error))
}

pub struct MemoPipelineTask {
    index: Arc<RwLock<Index>>,
    runtime: Arc<MemoRuntime>,
    db_path: String,
    artifact_sig: String,
    dimensions: usize,
    input_json: String,
}

impl Task for MemoPipelineTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        run_pipeline(
            &self.index,
            &self.runtime,
            &self.db_path,
            &self.artifact_sig,
            self.dimensions,
            &self.input_json,
        )
        .map_err(Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub(crate) fn run_with_runtime(
    index: Arc<RwLock<Index>>,
    runtime: Arc<MemoRuntime>,
    db_path: String,
    artifact_sig: String,
    dimensions: usize,
    input_json: String,
) -> AsyncTask<MemoPipelineTask> {
    AsyncTask::new(MemoPipelineTask {
        index,
        runtime,
        db_path,
        artifact_sig,
        dimensions,
        input_json,
    })
}
