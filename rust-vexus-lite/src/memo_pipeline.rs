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
const PIPELINE_ALGORITHM: &str = "tagmemo.epa-pyramid-spike-fusion-v9.4-calibrated-rust";

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
    _query_text: String,
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
    experiment_preset: Option<String>,
    #[serde(default = "default_true")]
    enable_v8_extensions: bool,
    #[serde(default = "default_true")]
    enable_twisted_transfer_kernel: bool,
    #[serde(default = "default_true")]
    enable_oblique_bridge_retention: bool,
    #[serde(default = "default_true")]
    enable_orthogonal_dipole_query: bool,
    #[serde(default)]
    spike_routing: SenseConfig,
}

impl PipelineConfig {
    pub(crate) fn apply_experiment_preset(&mut self) {
        if let Some(preset) = self.experiment_preset.as_deref() {
            match preset.trim().to_ascii_lowercase().as_str() {
                "6167e64" | "mainline" | "v7" | "v7_legacy" | "legacy" | "baseline" | "all_off" | "off" => {
                    self.enable_v8_extensions = false;
                    self.enable_twisted_transfer_kernel = false;
                    self.enable_oblique_bridge_retention = false;
                    self.enable_orthogonal_dipole_query = false;
                }
                "v8_5" | "v8.5" => {
                    self.enable_v8_extensions = true;
                    self.enable_twisted_transfer_kernel = true;
                    self.enable_oblique_bridge_retention = true;
                    self.enable_orthogonal_dipole_query = false;
                }
                "v9" | "v9_full" | "dual_ledger" => {
                    self.enable_v8_extensions = true;
                    self.enable_twisted_transfer_kernel = true;
                    self.enable_oblique_bridge_retention = true;
                    self.enable_orthogonal_dipole_query = true;
                }
                _ => {}
            }
        }
    }
}

fn default_true() -> bool {
    true
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
            experiment_preset: None,
            enable_v8_extensions: true,
            enable_twisted_transfer_kernel: true,
            enable_oblique_bridge_retention: true,
            enable_orthogonal_dipole_query: true,
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

/// Load the global manifold mean vector \mathbf{m} from the decoded EPA basis cache if available,
/// reusing `cached_epa_basis` so base64 decoding is never repeated per query stage.
fn load_epa_mean(connection: &Connection, dimension: usize) -> Option<Vec<f32>> {
    let raw = connection
        .query_row(
            "SELECT value FROM kv_store WHERE key = 'epa_basis_cache'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()?;
    let cached = EPA_BASIS.lock().ok().and_then(|slot| {
        slot.as_ref()
            .filter(|basis| basis.dimension == dimension && basis.raw == raw)
            .cloned()
    });
    let decoded = match cached {
        Some(basis) => basis,
        None => {
            let basis = Arc::new(decode_epa_basis(raw, dimension)?);
            if let Ok(mut slot) = EPA_BASIS.lock() {
                *slot = Some(basis.clone());
            }
            basis
        }
    };
    let mean_energy: f64 = decoded.mean.iter().map(|&v| (v as f64) * (v as f64)).sum();
    if mean_energy > 1e-9 {
        Some(decoded.mean.clone())
    } else {
        None
    }
}

#[allow(dead_code)]
fn orthogonal_projection(
    query: &[f32],
    tags: &[PyramidTagWork],
    dimension: usize,
) -> (Vec<f32>, Vec<f32>, Vec<f64>) {
    let mut cumulative_basis = Vec::new();
    orthogonal_projection_with_mean_and_history(query, tags, dimension, None, &mut cumulative_basis)
}

#[allow(dead_code)]
fn orthogonal_projection_with_mean(
    query: &[f32],
    tags: &[PyramidTagWork],
    dimension: usize,
    mean: Option<&[f32]>,
) -> (Vec<f32>, Vec<f32>, Vec<f64>) {
    let mut cumulative_basis = Vec::new();
    orthogonal_projection_with_mean_and_history(query, tags, dimension, mean, &mut cumulative_basis)
}

/// Rank-Deficient & Near-Collinear Safe Moore-Penrose Löwdin Orthogonal Projection:
/// Builds the full m \times m Gram overlap matrix G = V^T V across ALL valid candidate vectors
/// (including exact duplicates or near-collinear pairs) and computes its spectral decomposition
/// G = U \Lambda U^T via cyclic Jacobi sweeps.
/// Both the subspace projection p = V G^+ V^T q and the symmetric contribution vector
/// c_sym = G^{+1/2} V^T q use the exact same eigenvalue cutoff \lambda_k > \tau, guaranteeing:
///   1) Strict permutation invariance even for identical/rank-deficient tags (A == B => c_A == c_B);
///   2) Exact Parseval energy identity ||p||_2^2 \equiv ||c_sym||_2^2 with zero near-collinear leakage!
fn orthogonal_projection_with_mean_and_history(
    query: &[f32],
    tags: &[PyramidTagWork],
    dimension: usize,
    mean: Option<&[f32]>,
    cumulative_basis: &mut Vec<Vec<f64>>,
) -> (Vec<f32>, Vec<f32>, Vec<f64>) {
    let prior_len = cumulative_basis.len();
    let mut active_indices: Vec<usize> = Vec::with_capacity(tags.len());
    let mut unit_vectors: Vec<Vec<f64>> = Vec::with_capacity(tags.len());
    let mut coefficients = vec![0.0; tags.len()];

    for (index, tag) in tags.iter().enumerate() {
        let mut vector: Vec<f64> = if let Some(m) = mean {
            if m.len() == dimension && tag.vector.len() == dimension {
                tag.vector
                    .iter()
                    .zip(m.iter())
                    .map(|(&v, &mv)| (v - mv) as f64)
                    .collect()
            } else {
                tag.vector.iter().map(|value| *value as f64).collect()
            }
        } else {
            tag.vector.iter().map(|value| *value as f64).collect()
        };
        if vector.len() != dimension {
            continue;
        }
        let orig_norm = vector.iter().map(|v| v * v).sum::<f64>().sqrt();
        if orig_norm <= 1e-12 {
            continue;
        }
        for v in &mut vector {
            *v /= orig_norm;
        }
        // Project out components lying in strictly prior pyramid levels' subspaces Q_{0..l-1}
        // while keeping all current-level candidates (including duplicates) on equal footing!
        if prior_len > 0 {
            for _pass in 0..2 {
                for prev_unit in &cumulative_basis[..prior_len] {
                    let proj = vector
                        .iter()
                        .zip(prev_unit.iter())
                        .map(|(left, right)| left * right)
                        .sum::<f64>();
                    for offset in 0..dimension {
                        vector[offset] -= proj * prev_unit[offset];
                    }
                }
            }
            let post_prior_norm = vector.iter().map(|v| v * v).sum::<f64>().sqrt();
            if post_prior_norm <= 1e-9 {
                continue;
            }
            for v in &mut vector {
                *v /= post_prior_norm;
            }
        }
        active_indices.push(index);
        unit_vectors.push(vector);
    }

    let m = unit_vectors.len();
    if m == 0 {
        return (vec![0.0f32; dimension], query.to_vec(), coefficients);
    }
    if m == 1 {
        let u = &unit_vectors[0];
        let signed = query
            .iter()
            .zip(u.iter())
            .map(|(&q, &uv)| (q as f64) * uv)
            .sum::<f64>();
        coefficients[active_indices[0]] = signed.abs();
        let mut projection = vec![0.0f32; dimension];
        for offset in 0..dimension {
            projection[offset] = (signed * u[offset]) as f32;
        }
        let residual = query
            .iter()
            .zip(projection.iter())
            .map(|(source, explained)| source - explained)
            .collect();
        cumulative_basis.push(u.clone());
        return (projection, residual, coefficients);
    }

    // Build full m x m symmetric overlap matrix G = V^T V and right-hand side b = V^T q
    let mut g_mat = vec![vec![0.0f64; m]; m];
    let mut b_vec = vec![0.0f64; m];
    for i in 0..m {
        let vi = &unit_vectors[i];
        b_vec[i] = query
            .iter()
            .zip(vi.iter())
            .map(|(&q, &uv)| (q as f64) * uv)
            .sum::<f64>();
        g_mat[i][i] = 1.0;
        for j in (i + 1)..m {
            let vj = &unit_vectors[j];
            let dot_ij = vi.iter().zip(vj.iter()).map(|(a, b)| a * b).sum::<f64>();
            g_mat[i][j] = dot_ij;
            g_mat[j][i] = dot_ij;
        }
    }

    // Cyclic Jacobi eigendecomposition of symmetric positive semi-definite G (m x m)
    let mut eig_vecs = vec![vec![0.0f64; m]; m];
    for i in 0..m {
        eig_vecs[i][i] = 1.0;
    }
    for _sweep in 0..16 {
        let mut max_off = 0.0f64;
        for p in 0..m {
            for q in (p + 1)..m {
                max_off = max_off.max(g_mat[p][q].abs());
            }
        }
        if max_off < 1e-14 {
            break;
        }
        for p in 0..m {
            for q in (p + 1)..m {
                let apq = g_mat[p][q];
                if apq.abs() < 1e-15 {
                    continue;
                }
                let app = g_mat[p][p];
                let aqq = g_mat[q][q];
                let tau = (aqq - app) / (2.0 * apq);
                let t = if tau >= 0.0 {
                    1.0 / (tau + (1.0 + tau * tau).sqrt())
                } else {
                    -1.0 / (-tau + (1.0 + tau * tau).sqrt())
                };
                let c = 1.0 / (1.0 + t * t).sqrt();
                let sn = t * c;
                g_mat[p][p] = app - t * apq;
                g_mat[q][q] = aqq + t * apq;
                g_mat[p][q] = 0.0;
                g_mat[q][p] = 0.0;
                for r in 0..m {
                    if r != p && r != q {
                        let arp = g_mat[r][p];
                        let arq = g_mat[r][q];
                        g_mat[r][p] = c * arp - sn * arq;
                        g_mat[p][r] = g_mat[r][p];
                        g_mat[r][q] = sn * arp + c * arq;
                        g_mat[q][r] = g_mat[r][q];
                    }
                    let vrp = eig_vecs[r][p];
                    let vrq = eig_vecs[r][q];
                    eig_vecs[r][p] = c * vrp - sn * vrq;
                    eig_vecs[r][q] = sn * vrp + c * vrq;
                }
            }
        }
    }

    // Unified scale-aware spectral rank threshold \tau:
    // Both projection p = \sum_{\lambda_k > \tau} (\phi_k^T q) \phi_k and symmetric contributions
    // c_sym = U diag(\lambda_k^{-1/2}) U^T b use the exact same retained eigenmodes!
    let max_eig = (0..m).map(|k| g_mat[k][k]).fold(0.0f64, f64::max);
    let eig_cutoff = (max_eig * 1e-9).max(1e-10);
    let mut mode_signed = vec![0.0f64; m];
    for col in 0..m {
        let lambda = g_mat[col][col];
        if lambda > eig_cutoff {
            let mut dot_ub = 0.0;
            for row in 0..m {
                dot_ub += eig_vecs[row][col] * b_vec[row];
            }
            mode_signed[col] = dot_ub / lambda.sqrt();
            // Build orthonormal eigen-basis vector \phi_col = \lambda^{-1/2} V u_col for cumulative_basis
            let inv_sqrt = 1.0 / lambda.sqrt();
            let mut phi = vec![0.0f64; dimension];
            for row in 0..m {
                let weight = eig_vecs[row][col] * inv_sqrt;
                if weight.abs() > 1e-15 {
                    for (out, &v_val) in phi.iter_mut().zip(unit_vectors[row].iter()) {
                        *out += weight * v_val;
                    }
                }
            }
            let phi_norm = phi.iter().map(|v| v * v).sum::<f64>().sqrt();
            if phi_norm > 1e-12 {
                for v in &mut phi {
                    *v /= phi_norm;
                }
                cumulative_basis.push(phi);
            }
        }
    }

    // Symmetric contribution vector c_sym = U mode_signed, and dual weights w = G^+ b = U (\lambda^{-1/2} mode_signed)
    let mut dual_weights = vec![0.0f64; m];
    for row in 0..m {
        let mut sym_val = 0.0;
        let mut dual_val = 0.0;
        for col in 0..m {
            let lambda = g_mat[col][col];
            if lambda > eig_cutoff {
                let u_rc = eig_vecs[row][col];
                sym_val += u_rc * mode_signed[col];
                dual_val += u_rc * (mode_signed[col] / lambda.sqrt());
            }
        }
        coefficients[active_indices[row]] = sym_val.abs();
        dual_weights[row] = dual_val;
    }

    let mut projection = vec![0.0f32; dimension];
    for (row, u_vec) in unit_vectors.iter().enumerate() {
        let w = dual_weights[row];
        if w.abs() > 1e-15 {
            for offset in 0..dimension {
                projection[offset] += (w * u_vec[offset]) as f32;
            }
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
    let limit = tags.len().min(5);
    let mut directions = Vec::with_capacity(limit);
    let mut average = vec![0.0f64; dimension];
    for (idx, tag) in tags.iter_mut().enumerate() {
        let mut magnitude_squared = 0.0;
        for offset in 0..dimension {
            let delta = (query[offset] - tag.vector[offset]) as f64;
            magnitude_squared += delta * delta;
        }
        let distance = magnitude_squared.sqrt();
        tag.handshake_magnitude = distance;
        let inv_dist = if distance > 1e-9 { 1.0 / distance } else { 0.0 };
        if idx < limit {
            let mut direction = vec![0.0f64; dimension];
            if inv_dist > 0.0 {
                for offset in 0..dimension {
                    let unit_delta = ((query[offset] - tag.vector[offset]) as f64) * inv_dist;
                    direction[offset] = unit_delta;
                    average[offset] += unit_delta;
                }
            }
            directions.push(direction);
        } else if inv_dist > 0.0 {
            for offset in 0..dimension {
                average[offset] += ((query[offset] - tag.vector[offset]) as f64) * inv_dist;
            }
        }
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
    analyze_pyramid_with_pool(index, connection, query, dimension, config, &mut TagVectorPool::new())
        .map(|(output, tags, _)| (output, tags))
}

fn analyze_pyramid_with_pool(
    index: &Arc<crate::index_handle::IndexHandle>,
    connection: &Connection,
    query: &[f32],
    dimension: usize,
    config: &PipelineConfig,
    tag_vectors: &mut TagVectorPool,
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

    // Direction 1 (Intrinsic Centered Tangent-Space Pyramid):
    // Keep `residual` initialized to `query` so Level-0 HNSW lookup and initial norm `original_energy`
    // match the raw index space 100%; for deep orthogonal residuals (level >= 1), evaluate cosine
    // in the centered tangent space \mathcal{T}_{\mathbf{m}} (\mathbf{v}_i - \mathbf{m}) so the 36.5%
    // common-mode cone bias does not inflate the denominator and crush deep similarity!
    let epa_mean = if config.enable_v8_extensions {
        load_epa_mean(connection, dimension)
    } else {
        None
    };
    let mut residual = query.to_vec();
    let mut levels_output = Vec::new();
    let mut levels_work = Vec::new();
    let mut residuals = Vec::new();
    let mut total_explained = 0.0;
    let mut seen_pyramid_ids: HashSet<u64> = HashSet::new();
    let mut cumulative_basis: Vec<Vec<f64>> = Vec::new();
    for level in 0..config.max_levels.clamp(1, 8) {
        let top_k = config.pyramid_top_k.clamp(1, 128);
        let guard = index.read().map_err(|error| format!("Pyramid index lock failed: {}", error))?;
        let (ef_opt, excl_opt) = if level == 0 {
            (None, None)
        } else {
            (Some(512), Some(&seen_pyramid_ids))
        };
        let matches = guard
            .search_sql_excluding(connection, None, &residual, top_k, ef_opt, excl_opt)
            .map_err(|error| format!("Memo pyramid retrieval search failed: {:?}", error))?;
        if matches.is_empty() {
            break;
        }
        let ids: Vec<i64> = matches.iter().map(|(id, _)| {
            seen_pyramid_ids.insert(*id);
            *id as i64
        }).collect();
        drop(guard);
        ensure_tag_vectors_loaded(connection, tag_vectors, &ids, dimension)?;
        let mut tags = Vec::new();
        let res_norm = magnitude(&residual);
        for id in &ids {
            let Some(vector) = tag_vectors.get(id).cloned() else { continue };
            let raw_sim = cosine(&residual, &vector);
            let similarity = if let (Some(ref m), true) = (&epa_mean, level >= 1) {
                // Intrinsic tangent-space cosine: \cos(\mathbf{r}_l, \mathbf{v}_i - \mathbf{m})
                let mut dot_val = 0.0f64;
                let mut v_centered_sq = 0.0f64;
                for i in 0..dimension {
                    let vc = (vector[i] - m[i]) as f64;
                    dot_val += (residual[i] as f64) * vc;
                    v_centered_sq += vc * vc;
                }
                let denom = res_norm * v_centered_sq.sqrt();
                if denom > 1e-12 {
                    raw_sim.max(dot_val / denom)
                } else {
                    raw_sim
                }
            } else {
                raw_sim
            };
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
        let proj_mean = if level >= 1 { epa_mean.as_deref() } else { None };
        let (projection, next_residual, coefficients) =
            orthogonal_projection_with_mean_and_history(
                &residual,
                &tags,
                dimension,
                proj_mean,
                &mut cumulative_basis,
            );
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
        if config.spike_routing.dynamic_wormholes {
            residuals.push(residual.clone());
        }
        // V8.5 Spectral Tikhonov Oblique Bridge Retention:
        // When handing residual over to level + 1 in high-dimensional spaces (dimension >= 64),
        // retain 16% of the oblique bridge component so semi-orthogonal transition concepts
        // (~60-70 deg to L0) are not completely annihilated before level 1 search!
        let handover_residual: Vec<f32> =
            if config.enable_oblique_bridge_retention && dimension >= 64 && level == 0 {
                residual
                    .iter()
                    .zip(projection.iter())
                    .map(|(&r, &p)| r - 0.84 * p)
                    .collect()
            } else {
                next_residual
            };
        levels_work.push(tags);
        residual = handover_residual;
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
        residuals,
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
        let proj_mag = pyramid
            .levels
            .get(level)
            .map(|l| l.projection_magnitude)
            .unwrap_or(0.0);
        let max_contrib = tags
            .iter()
            .map(|t| positive(t.contribution))
            .fold(0.0, f64::max);
        // When Löwdin S^{-1/2} distributes subspace energy across K correlated tags,
        // rescale the gating amplitude so the lead tag reaches `proj_mag` (preserving
        // Sense Hop-1 firing potential) while keeping Löwdin's permutation-invariant ratios!
        let lowdin_gate_scale = if config.enable_v8_extensions && proj_mag > max_contrib && max_contrib > 1e-9 {
            (proj_mag / max_contrib).min(2.2)
        } else {
            1.0
        };
        for tag in tags {
            if tag.id <= 0 || !seen.insert(tag.id) {
                continue;
            }
            let is_core = core_names.contains(&tag.name.to_lowercase());
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
            let base_layer_gain = config.layer_decay.clamp(0.0, 1.0).powi(level as i32);
            // V8 Stratified Deep-Layer Source Quota:
            // Prevent Level 0 from monopolizing >95% of initial seed current when Level >= 1
            // discovers high-coherence tangent-space concepts.
            let layer_gain = if config.enable_v8_extensions && level >= 1 && relevance > 0.15 {
                base_layer_gain.max(0.45 * (0.65_f64).powi((level - 1) as i32))
            } else {
                base_layer_gain
            };
            let weight = positive(tag.contribution) * lowdin_gate_scale * layer_gain * language_gain * core_gain;
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
    norm: f64,
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

    drop(core_statement);
    let requested_count = merged.len() + ghost_tags.len();
    let ids = merged.iter().map(|tag| tag.id).collect::<Vec<_>>();
    ensure_tag_vectors_loaded(connection, tag_vectors, &ids, dimension)?;
    let mut vectors = Vec::with_capacity(requested_count);
    for tag in merged {
        let Some(vector) = tag_vectors.get(&tag.id).cloned() else { continue };
        let norm = magnitude(&vector);
        if norm > 1e-12 {
            vectors.push(FusionTag {
                id: tag.id,
                name: if tag.name.is_empty() {
                    format!("Tag#{}", tag.id)
                } else {
                    tag.name
                },
                weight: tag.weight,
                is_core: tag.is_core,
                norm,
                vector,
            });
        }
    }

    // 幽灵节点使用专属负 ID，仅参与去重与向量融合，绝不进入 Artifact/Spike。
    let mut ghost_id = -1i64;
    let mut accepted_ghosts = 0usize;
    for ghost in ghost_tags {
        if ghost.vector.len() != dimension {
            continue;
        }
        let norm = magnitude(&ghost.vector);
        if norm <= 1e-12 {
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
            norm,
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
        let redundant_index = selected.iter().position(|existing| {
            let denom = candidate.norm * existing.norm;
            denom > 1e-12 && (dot(&candidate.vector, &existing.vector) / denom) > threshold
        });
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
    transfer_basin_vectors: Vec<Vec<f32>>,
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
fn apply_transport_with_weights(
    artifact: &crate::rivermemo_topology_v3::NativeArtifact,
    weights: &[f64],
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
            output[artifact.targets[cursor]] += mass * positive(weights[cursor]);
        }
    }
}

fn apply_transport_pair(
    artifact: &crate::rivermemo_topology_v3::NativeArtifact,
    transfer_weights: &[f64],
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
            let target = artifact.targets[cursor];
            if local_active {
                local_output[target] += local_mass * positive(artifact.weights[cursor]);
            }
            if transfer_active {
                transfer_output[target] += transfer_mass * positive(transfer_weights[cursor]);
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
    let (local, transfer, _) = project_basin_fields(
        connection, artifact, fields, domains, dimension, limit,
        river_ids, &[], pool, diagnostics,
    )?;
    Ok((local, transfer))
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
) -> std::result::Result<(Vec<f32>, Vec<f32>, Vec<Vec<f32>>), String> {
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
            for (out, value) in outputs[field].iter_mut().zip(vector.iter()) {
                *out += *value as f64 * mass;
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

    // V8 Multi-Basin Dipole Projection (ColBERT / Poly-Encoder Max-Sim Prototypes):
    // Instead of collapsing multiple orthogonal transfer basins into a single centroid vector
    // (where orthogonal cross-domain directions cancel each other out), compute up to 4
    // basin-specific unit transfer prototype vectors so readout can take max-sim across poles.
    let mut transfer_basin_vectors: Vec<Vec<f32>> = Vec::new();
    if basins.len() > 1 && !selected[1].is_empty() {
        let selected_transfer_set: HashSet<i64> = selected[1].iter().copied().collect();
        let mut ranked_basins: Vec<&crate::memo_projection::Basin> = basins.iter().collect();
        ranked_basins.sort_by(|a, b| {
            b.importance
                .partial_cmp(&a.importance)
                .unwrap_or(Ordering::Equal)
                .then_with(|| a.id.cmp(&b.id))
        });
        for basin in ranked_basins.into_iter().take(4) {
            let mut pole = vec![0.0f64; dimension];
            let mut pole_mass = 0.0f64;
            for &id in &basin.inner {
                if !selected_transfer_set.contains(&id) {
                    continue;
                }
                let Some(&index) = artifact.node_index.get(&id) else { continue };
                let mass = positive(fields[1][index]);
                if mass <= 0.0 {
                    continue;
                }
                let Some(vector) = pool.get(&id) else { continue };
                pole_mass += mass;
                for (out, value) in pole.iter_mut().zip(vector.iter()) {
                    *out += *value as f64 * mass;
                }
            }
            if pole_mass > 1e-12 {
                for out in &mut pole {
                    *out /= pole_mass;
                }
                normalize(&mut pole);
                transfer_basin_vectors.push(pole.into_iter().map(|v| v as f32).collect());
            }
        }
    }

    let [local, transfer] = outputs;
    Ok((
        local.into_iter().map(|v| v as f32).collect(),
        transfer.into_iter().map(|v| v as f32).collect(),
        transfer_basin_vectors,
    ))
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
        &mut TagVectorPool::new(), &source_entries.iter().map(|entry| entry.0).collect::<Vec<_>>(), &[], &[])
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
    node_resonances: &[f64],
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
            transfer_basin_vectors: Vec::new(),
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

    // Potential-Guided Row-Normalized Transfer Kernel:
    // Reweights outgoing transitions toward high-resonance residual targets and low-triangle
    // bridge edges while preserving each node's outbound row sum.
    let has_global_wormhole_resonance = config.enable_twisted_transfer_kernel
        && node_resonances.len() == artifact.node_ids.len()
        && node_resonances.iter().any(|&r| r > 0.0);
    let transfer_weights_cow: std::borrow::Cow<'_, [f64]> = if has_global_wormhole_resonance {
        const GRADIENT_TILT_BETA: f64 = 2.5;
        const WORMHOLE_COUPLE_GAMMA: f64 = 0.85;
        let mut mod_w = artifact.weights.clone();
        for src_idx in 0..artifact.node_ids.len() {
            let start = artifact.row_offsets[src_idx];
            let end = artifact.row_offsets[src_idx + 1];
            if start >= end {
                continue;
            }
            let r_u = node_resonances[src_idx].clamp(0.0, 1.0);
            let mut orig_sum = 0.0;
            let mut mod_sum = 0.0;
            let mut row_changed = false;
            for cursor in start..end {
                let w = positive(artifact.weights[cursor]);
                orig_sum += w;
                let dst_idx = artifact.targets[cursor];
                let r_v = node_resonances[dst_idx].clamp(0.0, 1.0);
                if r_v > 0.0 && w > 0.0 {
                    // Heuristic Potential-Gradient & Wormhole-Coupled Tilted Kernel:
                    // 1) Potential gradient rectification (r_v - 0.45 * r_u)_+ prevents high-resonance
                    //    hubs from back-flowing into lower-resonance generic neighbors.
                    // 2) True structural wormhole edges (`edge_is_wormhole`) receive explicit
                    //    cross-domain tunneling amplification when target resonance r_v is active.
                    // 3) Triangle-overlap bridge factor (`edge_ricci_bridge`) dampens intra-clique loops.
                    let grad_potential = (r_v - 0.45 * r_u).max(0.0);
                    let is_wh = artifact
                        .edge_is_wormhole
                        .get(cursor)
                        .copied()
                        .unwrap_or(false);
                    let ricci_bridge = artifact
                        .edge_ricci_bridge
                        .get(cursor)
                        .copied()
                        .unwrap_or(1.0);
                    let wh_bonus = if is_wh {
                        WORMHOLE_COUPLE_GAMMA * (r_u.max(0.15) * r_v).sqrt()
                    } else {
                        0.25 * (ricci_bridge - 0.5).max(0.0) * (r_u.max(0.20) * r_v).sqrt()
                    };
                    let h_val = (GRADIENT_TILT_BETA * grad_potential * (0.65 + 0.35 * ricci_bridge) + wh_bonus).exp();
                    let mw = w * h_val;
                    mod_w[cursor] = mw;
                    mod_sum += mw;
                    row_changed = true;
                } else {
                    mod_w[cursor] = w;
                    mod_sum += w;
                }
            }
            if row_changed && mod_sum > 1e-12 && orig_sum > 0.0 {
                let scale = orig_sum / mod_sum;
                for cursor in start..end {
                    mod_w[cursor] *= scale;
                }
            }
        }
        std::borrow::Cow::Owned(mod_w)
    } else {
        std::borrow::Cow::Borrowed(&artifact.weights)
    };
    let transfer_weights: &[f64] = transfer_weights_cow.as_ref();

    for iteration in 1..=config.field_max_iterations.max(1) {
        iterations = iteration;
        // The fields are independent; while both move, one CSR pass serves both.
        if !local_converged && !transfer_converged {
            apply_transport_pair(
                artifact,
                transfer_weights,
                &local,
                &transfer,
                &mut propagated_local,
                &mut propagated_transfer,
            );
        } else if !local_converged {
            apply_transport(artifact, &local, &mut propagated_local);
        } else if !transfer_converged {
            apply_transport_with_weights(
                artifact,
                transfer_weights,
                &transfer,
                &mut propagated_transfer,
            );
        }
        if !local_converged {
            local_residual = relax_field(
                &source,
                &propagated_local,
                local_alpha,
                &local,
                &mut next_local,
            );
            local_converged = local_residual <= config.local_tolerance.max(1e-15);
            std::mem::swap(&mut local, &mut next_local);
        }
        if !transfer_converged {
            transfer_residual = relax_field(
                &source,
                &propagated_transfer,
                transfer_alpha,
                &transfer,
                &mut next_transfer,
            );
            transfer_converged = transfer_residual <= config.transfer_tolerance.max(1e-15);
            std::mem::swap(&mut transfer, &mut next_transfer);
        }
        if local_converged && transfer_converged {
            break;
        }
    }

    // Post-hoc Steady-State Total Mass Calibration under Non-Uniform Node Leakage:
    // Row-normalized reweighting can alter steady-state total mass when shifting flow between a
    // continuing branch and a terminal sink. Rescaling `transfer` (and its step residual under
    // the correspondingly scaled source `scale * source`) aligns total steady-state mass with
    // the untwisted baseline while preserving relative node rankings and domain ratios.
    if has_global_wormhole_resonance {
        let mut base_trf = source.clone();
        let mut next_base = vec![0.0; source.len()];
        let mut prop_base = vec![0.0; source.len()];
        for _ in 1..=config.field_max_iterations.max(1) {
            apply_transport(artifact, &base_trf, &mut prop_base);
            let res = relax_field(&source, &prop_base, transfer_alpha, &base_trf, &mut next_base);
            std::mem::swap(&mut base_trf, &mut next_base);
            if res <= config.transfer_tolerance.max(1e-15) {
                break;
            }
        }
        let base_mass = field_mass(&base_trf);
        let cur_mass = field_mass(&transfer);
        if base_mass > 1e-12 && cur_mass > 1e-12 {
            let scale = base_mass / cur_mass;
            for v in &mut transfer {
                *v *= scale;
            }
            if transfer_residual.is_finite() {
                transfer_residual *= scale;
            }
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
    let (local_vector, transfer_vector, transfer_basin_vectors) = project_basin_fields(
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
        transfer_basin_vectors,
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
    input.config.apply_experiment_preset();
    input.config.apply_experiment_preset();
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
    let mut seed_levels = HashMap::new();
    for (level, tags) in level_tags.iter().enumerate() {
        for tag in tags { seed_levels.entry(tag.id).or_insert(level); }
    }
    let epa_mean = load_epa_mean(connection, dimensions);
    let mut wormholes = DynamicWormholeContext::new_with_mean(
        connection, &mut tag_vectors, residuals, seed_levels, epa_mean,
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
    let wh_threshold = input.config.spike_routing.dynamic_wormhole_threshold;
    let has_deep_residuals = wormholes.residuals.len() > 1;
    let mut global_node_resonances = wormholes.extract_global_node_resonances(
        artifact.node_ids.len(),
        wh_threshold,
    );
    drop(wormholes);
    // Also illuminate multi-hop global CSR nodes discovered by deeper pyramid layers (level >= 1)
    if has_deep_residuals {
        for tags in level_tags.iter().skip(1) {
            for tag in tags {
                if tag.similarity >= wh_threshold {
                    if let Some(&node_idx) = artifact.node_index.get(&tag.id) {
                        if tag.similarity > global_node_resonances[node_idx] {
                            global_node_resonances[node_idx] = tag.similarity;
                        }
                    }
                }
            }
        }
    }
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
        &global_node_resonances,
    )?;

    // V8.5 Orthogonal Transfer-Dipole Enhanced Query Vector:
    // Blend the component of `dual_fields.transfer_vector` that is strictly orthogonal to `enhanced_vector`
    // (bounded by 0.18 amplitude) so stage-1 KNN retrieval actively pulls in cross-domain bridge candidates
    // before stage-2 readout even begins!
    let mut enhanced_f64 = enhanced_vector.clone();
    if input.config.enable_orthogonal_dipole_query
        && dual_fields.transfer_vector.len() == dimensions
        && dimensions >= 64
    {
        let trf_f64: Vec<f64> = dual_fields.transfer_vector.iter().map(|&x| x as f64).collect();
        let trf_norm = trf_f64.iter().map(|v| v * v).sum::<f64>().sqrt();
        if trf_norm > 1e-12 {
            let parallel: f64 = enhanced_f64
                .iter()
                .zip(trf_f64.iter())
                .map(|(a, b)| a * b)
                .sum();
            let mut ortho_trf: Vec<f64> = trf_f64
                .iter()
                .zip(enhanced_f64.iter())
                .map(|(&t, &e)| t - parallel * e)
                .collect();
            let ortho_norm = ortho_trf.iter().map(|v| v * v).sum::<f64>().sqrt();
            if ortho_norm > 1e-9 {
                for v in &mut ortho_trf {
                    *v /= ortho_norm;
                }
                for (e, &ot) in enhanced_f64.iter_mut().zip(ortho_trf.iter()) {
                    *e += 0.18 * ot;
                }
                normalize(&mut enhanced_f64);
            }
        }
    }
    let enhanced_vector_f32: Vec<f32> = enhanced_f64.iter().map(|value| *value as f32).collect();
    let observation_handle = runtime.store_query_observation(
        artifact_sig,
        observation,
        input.query_vector.clone(),
        enhanced_vector_f32.clone(),
        dual_fields.local_vector.clone(),
        dual_fields.transfer_vector.clone(),
        dual_fields.transfer_basin_vectors.clone(),
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
            &levels, &epa, &pyramid, &names, &PipelineConfig::default(),
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
    fn inspiration_a_and_b_exclude_peeled_tags_and_conserve_global_wormhole_row_mass() {
        use crate::rivermemo_topology_v3::NativeArtifact;
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE tags(id INTEGER PRIMARY KEY,name TEXT,vector BLOB);"
        ).unwrap();
        let rows = [
            (1_i64, "main-axis", [1.0_f32, 0.0, 0.0]),
            (2_i64, "secondary-inspiration", [0.0_f32, 1.0, 0.0]),
            (3_i64, "tertiary-bridge", [0.0_f32, 0.0, 1.0]),
        ];
        let index = crate::VexusIndex::new(3, 16).unwrap();
        for (id, name, vec) in rows {
            let bytes: Vec<u8> = vec.iter().flat_map(|v| v.to_le_bytes()).collect();
            connection.execute("INSERT INTO tags VALUES (?1,?2,?3)", rusqlite::params![id, name, bytes]).unwrap();
            index.index.write().unwrap().add(id as u64, &vec).unwrap();
        }
        let config = PipelineConfig {
            max_levels: 3,
            pyramid_top_k: 1,
            min_energy_ratio: 0.01,
            ..PipelineConfig::default()
        };
        let query = [0.8_f32, 0.5, 0.3];
        connection.execute_batch("BEGIN").unwrap();
        let (pyramid, _) = analyze_pyramid(&index.index, &connection, &query, 3, &config).unwrap();
        connection.execute_batch("COMMIT").unwrap();
        // Inspiration A: each level peels a strictly distinct orthogonal tag without repeating Level 0!
        assert_eq!(pyramid.levels.len(), 3);
        assert_eq!(pyramid.levels[0].tags[0].id, 1);
        assert_eq!(pyramid.levels[1].tags[0].id, 2);
        assert_eq!(pyramid.levels[2].tags[0].id, 3);
        assert!((pyramid.total_explained_energy - 1.0).abs() < 1e-5);

        // Inspiration B: global wormhole transfer field strictly conserves total mass while steering toward resonant target
        let artifact = NativeArtifact {
            node_ids: vec![1, 2, 3],
            node_index: HashMap::from([(1, 0), (2, 1), (3, 2)]),
            row_offsets: vec![0, 2, 2, 2],
            targets: vec![1, 2],
            weights: vec![0.475, 0.475],
            ..NativeArtifact::default()
        }.prepared();
        let mut pool = TagVectorPool::new();
        let plain = solve_dual_fields_with_pool(
            &artifact, &connection, &[(1, 1.0)], 3, &config, &mut pool, &[1], &[], &[0.0, 0.0, 0.0],
        ).unwrap();
        let steered = solve_dual_fields_with_pool(
            &artifact, &connection, &[(1, 1.0)], 3, &config, &mut pool, &[1], &[], &[0.0, 0.0, 0.8],
        ).unwrap();
        // Total scalar mass is 100% identical (zero artificial energy injection!),
        // while transfer mass shifts from non-resonant node 2 to resonant wormhole node 3.
        assert!((plain.diagnostics.transfer_mass - steered.diagnostics.transfer_mass).abs() < 1e-12);
        assert!(( plain.diagnostics.local_mass - steered.diagnostics.local_mass).abs() < 1e-12);
        let t3_plain = plain.transfer_field.iter().find(|(id, _)| *id == 3).unwrap().1;
        let t3_steered = steered.transfer_field.iter().find(|(id, _)| *id == 3).unwrap().1;
        assert!(t3_steered > t3_plain * 1.4);

        // Audit Counterexample P2-7: Non-uniform leakage graph (node 2 propagates to 4, while node 3 is a dead-end sink).
        // Shifting outbound mass from continuing branch 2 to terminal sink 3 must still preserve global steady-state transfer_mass!
        let leaky_artifact = NativeArtifact {
            node_ids: vec![1, 2, 3, 4],
            node_index: HashMap::from([(1, 0), (2, 1), (3, 2), (4, 3)]),
            row_offsets: vec![0, 2, 3, 3, 3],
            targets: vec![1, 2, 3], // 1 -> 2 (idx 1), 1 -> 3 (idx 2), and 2 -> 4 (idx 3); node 3 has 0 outbound edges!
            weights: vec![0.475, 0.475, 0.95],
            ..NativeArtifact::default()
        }
        .prepared();
        let leaky_plain = solve_dual_fields_with_pool(
            &leaky_artifact,
            &connection,
            &[(1, 1.0)],
            3,
            &config,
            &mut pool,
            &[1],
            &[],
            &[0.0, 0.0, 0.0, 0.0],
        )
        .unwrap();
        let leaky_steered = solve_dual_fields_with_pool(
            &leaky_artifact,
            &connection,
            &[(1, 1.0)],
            3,
            &config,
            &mut pool,
            &[1],
            &[],
            &[0.0, 0.0, 0.9, 0.0],
        )
        .unwrap();
        assert!(
            (leaky_plain.diagnostics.transfer_mass - leaky_steered.diagnostics.transfer_mass).abs() < 1e-12,
            "Steady-state transfer mass under non-uniform leakage must remain invariant: plain={} vs steered={}",
            leaky_plain.diagnostics.transfer_mass,
            leaky_steered.diagnostics.transfer_mass
        );
    }

    #[test]
    fn theoretical_optima_lowdin_invariance_tangent_centering_and_renyi2_wavepacket_firing() {
        use crate::rivermemo_topology_v3::NativeArtifact;
        // 1. Löwdin S^{-1/2} Symmetric Orthogonalization:
        // Verify strict permutation invariance (reordering correlated tags yields identical contributions)
        // and exact energy conservation (\sum c_sym^2 == \sum c_GS^2 == ||projection||^2).
        let q = [0.85_f32, 0.50, 0.15];
        let tag_a = PyramidTagWork {
            id: 1,
            name: "a".into(),
            vector: Arc::from(vec![1.0_f32, 0.2, 0.0]),
            similarity: 0.9,
            contribution: 0.0,
            handshake_magnitude: 0.0,
        };
        let tag_b = PyramidTagWork {
            id: 2,
            name: "b".into(),
            vector: Arc::from(vec![0.6_f32, 0.8, 0.0]),
            similarity: 0.8,
            contribution: 0.0,
            handshake_magnitude: 0.0,
        };
        let (proj_ab, res_ab, coeff_ab) =
            orthogonal_projection(&q, &[tag_a.clone(), tag_b.clone()], 3);
        let (proj_ba, res_ba, coeff_ba) =
            orthogonal_projection(&q, &[tag_b, tag_a], 3);
        // Permutation-invariant contributions: tag_a gets identical contribution whether ranked 1st or 2nd!
        assert!((coeff_ab[0] - coeff_ba[1]).abs() < 1e-10);
        assert!((coeff_ab[1] - coeff_ba[0]).abs() < 1e-10);
        // Subspace residual and total explained energy are preserved to machine precision
        for i in 0..3 {
            assert!((proj_ab[i] - proj_ba[i]).abs() < 1e-6);
            assert!((res_ab[i] - res_ba[i]).abs() < 1e-6);
        }
        let proj_energy: f64 = proj_ab.iter().map(|&x| (x as f64) * (x as f64)).sum();
        let lowdin_energy: f64 = coeff_ab.iter().map(|&c| c * c).sum();
        assert!((proj_energy - lowdin_energy).abs() < 1e-10);

        // 1b. Audit Counterexample P2-5: Rank-deficient / identical duplicate tags must remain
        // strictly permutation-invariant (each gets 1/sqrt(2), never [1.0, 0.0] order monopoly).
        let dup_a = PyramidTagWork {
            id: 10,
            name: "dup_a".into(),
            vector: Arc::from(vec![1.0_f32, 0.0, 0.0]),
            similarity: 1.0,
            contribution: 0.0,
            handshake_magnitude: 0.0,
        };
        let dup_b = PyramidTagWork {
            id: 11,
            name: "dup_b".into(),
            vector: Arc::from(vec![1.0_f32, 0.0, 0.0]),
            similarity: 1.0,
            contribution: 0.0,
            handshake_magnitude: 0.0,
        };
        let (_, _, dup_ab) = orthogonal_projection(&[1.0_f32, 0.0, 0.0], &[dup_a.clone(), dup_b.clone()], 3);
        let (_, _, dup_ba) = orthogonal_projection(&[1.0_f32, 0.0, 0.0], &[dup_b, dup_a], 3);
        assert!((dup_ab[0] - dup_ab[1]).abs() < 1e-10, "Duplicate tags must share contribution equally: {:?}", dup_ab);
        assert!((dup_ab[0] - dup_ba[1]).abs() < 1e-10);
        assert!((dup_ab[0] * dup_ab[0] + dup_ab[1] * dup_ab[1] - 1.0).abs() < 1e-10);

        // 1c. Audit Counterexample P1-2: Near-collinear tags v1=(1,0,0), v2=(1,1e-6,0), q=(0,1,0)
        // must use unified spectral rank threshold so ||projection||^2 == ||c_sym||^2 (zero mismatch!).
        let col_1 = PyramidTagWork {
            id: 21,
            name: "col_1".into(),
            vector: Arc::from(vec![1.0_f32, 0.0, 0.0]),
            similarity: 0.0,
            contribution: 0.0,
            handshake_magnitude: 0.0,
        };
        let col_2 = PyramidTagWork {
            id: 22,
            name: "col_2".into(),
            vector: Arc::from(vec![1.0_f32, 1e-6, 0.0]),
            similarity: 1e-6,
            contribution: 0.0,
            handshake_magnitude: 0.0,
        };
        let (col_proj, _, col_coeff) = orthogonal_projection(&[0.0_f32, 1.0, 0.0], &[col_1, col_2], 3);
        let col_proj_energy: f64 = col_proj.iter().map(|&x| (x as f64) * (x as f64)).sum();
        let col_coeff_energy: f64 = col_coeff.iter().map(|&c| c * c).sum();
        assert!(
            (col_proj_energy - col_coeff_energy).abs() < 1e-6,
            "Near-collinear projection energy ({}) and Löwdin contribution energy ({}) must never diverge!",
            col_proj_energy,
            col_coeff_energy
        );

        // 2. Rényi-2 L2 Wavepacket Firing Potential vs L1 Mass Conservation:
        // Hub node 1 has 16 neighbors with L1 weight 0.95 / 16 = 0.059375 each.
        // Under pure L1 energy, Hop 1 energy at neighbor 2 is 0.25 * 0.059375 * 0.25 = 0.0037 < 0.10 (extinguished!).
        // Under Rényi-2 L2 wavepacket normalization (row_l2 = 0.95 / 4 = 0.2375, l2_amp = 0.25),
        // with seed energy 0.65 and base_decay 0.65, L1 energy is 0.65 * 0.059375 * 0.65 = 0.025 < 0.10,
        // while L2 firing_potential is 0.65 * 0.25 * 0.65 = 0.1056 >= 0.10, unlocking Hop 2 -> node 20!
        let mut node_ids: Vec<i64> = (1..=20).collect();
        let mut targets: Vec<usize> = (1..=16).collect(); // node 1 connects to indices 1..=16 (IDs 2..=17)
        let mut weights: Vec<f64> = vec![0.95 / 16.0; 16];
        // Node 2 (index 1) connects to node 20 (index 19) with weight 0.90
        targets.push(19);
        weights.push(0.90);
        let mut row_offsets = vec![0usize; 21];
        row_offsets[0] = 0;
        row_offsets[1] = 16;
        for r in 2..=20 {
            row_offsets[r] = 17;
        }
        let artifact = NativeArtifact {
            node_index: node_ids.iter().enumerate().map(|(i, &id)| (id, i)).collect(),
            node_ids: std::mem::take(&mut node_ids),
            row_offsets,
            targets,
            weights,
            ..NativeArtifact::default()
        }
        .prepared();

        let sense_out = sense_typed(
            &artifact,
            "renyi2-test",
            SenseInput {
                query_id: None,
                seeds: vec![SenseSeed {
                    id: 1,
                    energy: 0.65,
                    source_type: "seed".into(),
                }],
                config: SenseConfig {
                    max_safe_hops: 2,
                    firing_threshold: 0.10,
                    base_decay: 0.65,
                    minimum_injected_current: 0.005,
                    ..SenseConfig::default()
                },
            },
        )
        .unwrap();
        // Node 20 (at Hop 2) is successfully reached because Node 2's L2 wavepacket potential crossed 0.10!
        let node20 = sense_out.nodes.iter().find(|n| n.id == 20);
        assert!(node20.is_some(), "Rényi-2 L2 wavepacket potential must enable Hop-2 propagation from high-degree hub");
        assert_eq!(node20.unwrap().hop, 2);

        // 2b. Audit Counterexample P1-3: 1 -> 2 -> 3 -> 4 chain with weak single outbound edges w=0.001.
        // At Hop 2 (node 3), L1 energy is 0.000729 <= minimum_injected_current (0.01),
        // while L2 wavepacket potential is 0.81 >= firing_threshold (0.10).
        // The per-hop termination check must NOT break early at Hop 2; node 4 at Hop 3 must be reached!
        let chain_artifact = NativeArtifact {
            node_ids: vec![1, 2, 3, 4],
            node_index: HashMap::from([(1, 0), (2, 1), (3, 2), (4, 3)]),
            row_offsets: vec![0, 1, 2, 3, 3],
            targets: vec![1, 2, 3],
            weights: vec![0.001, 0.001, 0.001],
            ..NativeArtifact::default()
        }
        .prepared();
        let chain_out = sense_typed(
            &chain_artifact,
            "audit-p1-3-chain",
            SenseInput {
                query_id: None,
                seeds: vec![SenseSeed {
                    id: 1,
                    energy: 900.0,
                    source_type: "seed".into(),
                }],
                config: SenseConfig {
                    max_safe_hops: 3,
                    base_momentum: 4.0,
                    firing_threshold: 0.10,
                    base_decay: 0.90,
                    minimum_injected_current: 0.01,
                    ..SenseConfig::default()
                },
            },
        )
        .unwrap();
        let node4 = chain_out.nodes.iter().find(|n| n.id == 4);
        assert!(
            node4.is_some(),
            "Wavepacket frontier with potential 0.81 >= 0.10 must not be terminated early at Hop 2!"
        );
        assert_eq!(node4.unwrap().hop, 3);
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

    #[test]
    fn v9_torture_directed_cycle_plus_dead_end_sink_conserves_mass_without_nan() {
        use super::{solve_dual_fields_with_pool, Connection, TagVectorPool};
        use std::collections::HashSet;
        // Pathological graph: 1 -> 2 -> 3 -> 1 (directed 3-cycle with high resonance) + 1 -> 4 (dead-end sink)
        let artifact = NativeArtifact {
            node_ids: vec![1, 2, 3, 4],
            node_index: HashMap::from([(1, 0), (2, 1), (3, 2), (4, 3)]),
            row_offsets: vec![0, 2, 3, 4, 4],
            targets: vec![1, 3, 2, 0],
            weights: vec![0.5, 0.5, 1.0, 1.0],
            wormhole_edges: HashSet::from([(2, 3)]),
            ..NativeArtifact::default()
        }
        .prepared();

        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT, vector BLOB);").unwrap();
        for id in 1..=4 {
            let v: Vec<u8> = [1.0f32, 0.0, 0.0, 0.0].iter().flat_map(|f| f.to_ne_bytes()).collect();
            conn.execute("INSERT INTO tags (id, name, vector) VALUES (?1, ?2, ?3)", rusqlite::params![id, format!("t{id}"), v]).unwrap();
        }
        let mut cfg_off = PipelineConfig::default();
        cfg_off.enable_twisted_transfer_kernel = false;
        let mut cfg_on = PipelineConfig::default();
        cfg_on.enable_twisted_transfer_kernel = true;

        let resonances = vec![0.0, 0.95, 0.95, 0.0];
        let mut pool_off = TagVectorPool::new();
        let out_off = solve_dual_fields_with_pool(
            &artifact, &conn, &[(1, 1.0)], 4, &cfg_off, &mut pool_off, &[1, 2, 3, 4], &[], &resonances,
        ).unwrap();
        let mut pool_on = TagVectorPool::new();
        let out_on = solve_dual_fields_with_pool(
            &artifact, &conn, &[(1, 1.0)], 4, &cfg_on, &mut pool_on, &[1, 2, 3, 4], &[], &resonances,
        ).unwrap();

        let mass_off: f64 = out_off.transfer_field.iter().map(|x| x.1).sum();
        let mass_on: f64 = out_on.transfer_field.iter().map(|x| x.1).sum();
        assert!(mass_on.is_finite() && mass_off.is_finite());
        assert!(
            (mass_on - mass_off).abs() < 1e-9,
            "Directed cycle + dead-end sink must conserve total steady-state transfer mass: off={} vs on={}",
            mass_off,
            mass_on
        );
    }
}
