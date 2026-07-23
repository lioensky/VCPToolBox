use crate::rivermemo_topology_v3::{load_artifact_from_runtime, MemoRuntime, NativeArtifact};
use napi::bindgen_prelude::*;
use rayon::prelude::*;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

const RESULT_SCHEMA: &str = "vexus-dtsc-native-result-v1";
const ALGORITHM_VERSION: &str = "tagmemo.dtsc-v9.2.1-rust-js-parity";

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
    if left_norm > 1e-12 && right_norm > 1e-12 {
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
            .map(|chunk| f32::from_ne_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            .collect(),
    )
}

fn open_readonly(path: &str) -> std::result::Result<Connection, String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("open DTSC SQLite failed: {}", error))?;
    connection
        .busy_timeout(Duration::from_secs(30))
        .map_err(|error| format!("configure DTSC SQLite timeout failed: {}", error))?;
    connection
        .pragma_update(None, "query_only", "ON")
        .map_err(|error| format!("configure DTSC SQLite query_only failed: {}", error))?;
    Ok(connection)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DtscInput {
    dimension: usize,
    #[serde(default)]
    observation_handle: Option<String>,
    #[serde(default)]
    top_k: usize,
    #[serde(default)]
    candidates: Vec<CandidateInput>,
    #[serde(default)]
    observation: ObservationInput,
    #[serde(default)]
    query_geometry_state: QueryGeometryState,
    #[serde(default)]
    original_query_vector: Vec<f32>,
    #[serde(default)]
    enhanced_query_vector: Vec<f32>,
    #[serde(default)]
    config: DtscConfig,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CandidateInput {
    id: i64,
    #[serde(default)]
    score: f64,
}

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct QueryGeometryState {
    #[serde(default)]
    epa: QueryEpaState,
    #[serde(default)]
    pyramid: QueryPyramidState,
}

impl Default for QueryGeometryState {
    fn default() -> Self {
        Self {
            epa: QueryEpaState::default(),
            pyramid: QueryPyramidState::default(),
        }
    }
}

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct QueryEpaState {
    logic_depth: f64,
    entropy: f64,
    resonance: f64,
}

impl Default for QueryEpaState {
    fn default() -> Self {
        Self {
            logic_depth: 0.5,
            entropy: 0.5,
            resonance: 0.0,
        }
    }
}

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct QueryPyramidState {
    coverage: f64,
    novelty: f64,
    depth: f64,
}

impl Default for QueryPyramidState {
    fn default() -> Self {
        Self {
            coverage: 0.5,
            novelty: 0.5,
            depth: 0.5,
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObservationInput {
    #[serde(default)]
    source_field: Vec<(i64, f64)>,
    #[serde(default)]
    nodes: Vec<ObservationNodeInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObservationNodeInput {
    id: i64,
    #[serde(default)]
    energy: f64,
    #[serde(default)]
    normalized_energy: f64,
    #[serde(default)]
    source_type: String,
    #[serde(default)]
    hop: usize,
}

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct DtscConfig {
    alpha: f64,
    min_field_tags: usize,
    min_field_entropy: f64,
    field_energy_mass_ratio: f64,
    #[serde(rename = "minGeoCoverageRatio", alias = "minCandidateCoverage")]
    min_candidate_coverage: f64,
    #[serde(rename = "minMaxGeoScore", alias = "minGeoScore")]
    min_geo_score: f64,
    #[serde(rename = "minGeoScoreSpread", alias = "minGeoSpread")]
    min_geo_spread: f64,
    min_strong_evidence: f64,
    fallback_to_knn_on_low_trust: bool,
    field_similarity_threshold: f64,
    strong_contact_threshold: f64,
    weak_contact_threshold: f64,
    field_kernel_exponent: f64,
    max_field_neighbors: usize,
    max_field_nodes: usize,
    #[serde(rename = "candidatePositionDecay", alias = "positionDecay")]
    position_decay: f64,
    public_hub_floor: f64,
    min_closure_similarity: f64,
    min_geo_samples: usize,
    geo_reward_floor: f64,
    geo_reward_saturation: f64,
    direct_bonus_cap: f64,
    structural_bonus_cap: f64,
    thematic_bonus_cap: f64,
    structural_continuity_min: f64,
    thematic_min_potential: f64,
    thematic_max_isolated_ratio: f64,
    sparse_association_enabled: bool,
    sparse_association_min_contacts: usize,
    sparse_association_min_conductance: f64,
    sparse_association_min_similarity: f64,
    sparse_association_min_potential: f64,
    sparse_association_min_closure: f64,
    sparse_association_pair_saturation: usize,
    sparse_association_max_relief: f64,
    direct_semantic_min_potential: f64,
    direct_semantic_saturation: f64,
    direct_semantic_min_contacts: usize,
    direct_confidence_floor: f64,
    geometry_auxiliary: GeometryAuxConfig,
}

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct GeometryAuxConfig {
    enabled: bool,
    max_aux_bonus: f64,
    direct_floor_cap: f64,
    structural_floor_cap: f64,
    thematic_floor_cap: f64,
    min_fused_score: f64,
    min_closure_score: f64,
    min_class_evidence: f64,
    floor_exponent: f64,
    identity_anchor: IdentityAnchorConfig,
}

impl Default for GeometryAuxConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            max_aux_bonus: 0.018,
            direct_floor_cap: 0.018,
            structural_floor_cap: 0.012,
            thematic_floor_cap: 0.006,
            min_fused_score: 0.12,
            min_closure_score: 0.55,
            min_class_evidence: 0.10,
            floor_exponent: 1.5,
            identity_anchor: IdentityAnchorConfig::default(),
        }
    }
}

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct IdentityAnchorConfig {
    enabled: bool,
    min_potential: f64,
    min_specificity: f64,
    min_tag_chunk_closure: f64,
    min_strength: f64,
    floor_cap: f64,
    floor_exponent: f64,
}

impl Default for IdentityAnchorConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            min_potential: 0.80,
            min_specificity: 0.55,
            min_tag_chunk_closure: 0.35,
            min_strength: 0.55,
            floor_cap: 0.018,
            floor_exponent: 1.25,
        }
    }
}

impl Default for DtscConfig {
    fn default() -> Self {
        Self {
            alpha: 0.35,
            min_field_tags: 3,
            min_field_entropy: 0.12,
            field_energy_mass_ratio: 0.95,
            min_candidate_coverage: 0.20,
            min_geo_score: 0.01,
            min_geo_spread: 0.03,
            min_strong_evidence: 1.0,
            fallback_to_knn_on_low_trust: true,
            field_similarity_threshold: 0.50,
            strong_contact_threshold: 0.16,
            weak_contact_threshold: 0.06,
            field_kernel_exponent: 2.0,
            max_field_neighbors: 4,
            max_field_nodes: 48,
            position_decay: 0.035,
            public_hub_floor: 0.35,
            min_closure_similarity: 0.20,
            min_geo_samples: 3,
            geo_reward_floor: 0.015,
            geo_reward_saturation: 0.25,
            direct_bonus_cap: 0.18,
            structural_bonus_cap: 0.10,
            thematic_bonus_cap: 0.035,
            structural_continuity_min: 0.08,
            thematic_min_potential: 0.08,
            thematic_max_isolated_ratio: 0.65,
            sparse_association_enabled: true,
            sparse_association_min_contacts: 3,
            sparse_association_min_conductance: 0.015,
            sparse_association_min_similarity: 0.48,
            sparse_association_min_potential: 0.08,
            sparse_association_min_closure: 0.20,
            sparse_association_pair_saturation: 3,
            sparse_association_max_relief: 0.55,
            direct_semantic_min_potential: 0.16,
            direct_semantic_saturation: 0.35,
            direct_semantic_min_contacts: 2,
            direct_confidence_floor: 0.35,
            geometry_auxiliary: GeometryAuxConfig::default(),
        }
    }
}

impl DtscConfig {
    /// Reproduce the effective-configuration clamps used by
    /// TagMemoEngine.geodesicRerank(). This keeps malformed or conflicting
    /// hot configuration from giving the native readout different mathematics.
    fn normalize(mut self) -> Self {
        self.alpha = self.alpha.clamp(0.0, 1.0);
        self.min_geo_samples = self.min_geo_samples.max(1);
        self.min_field_tags = self.min_field_tags.max(1);
        self.min_field_entropy = self.min_field_entropy.clamp(0.0, 1.0);
        self.field_energy_mass_ratio = self.field_energy_mass_ratio.clamp(0.5, 1.0);
        self.min_candidate_coverage = self.min_candidate_coverage.clamp(0.0, 1.0);
        self.min_geo_score = positive(self.min_geo_score);
        self.min_geo_spread = positive(self.min_geo_spread);
        self.min_strong_evidence = positive(self.min_strong_evidence);

        self.field_similarity_threshold = self.field_similarity_threshold.clamp(-1.0, 1.0);
        self.strong_contact_threshold = self.strong_contact_threshold.clamp(0.0, 1.0);
        self.weak_contact_threshold = self
            .weak_contact_threshold
            .clamp(0.0, self.strong_contact_threshold);
        self.field_kernel_exponent = self.field_kernel_exponent.max(0.25);
        self.max_field_neighbors = self.max_field_neighbors.max(1);
        self.max_field_nodes = self.max_field_nodes.max(self.min_field_tags);
        self.position_decay = positive(self.position_decay);
        self.public_hub_floor = self.public_hub_floor.clamp(0.05, 1.0);
        self.min_closure_similarity = self.min_closure_similarity.clamp(-1.0, 1.0);

        self.geo_reward_floor = self.geo_reward_floor.clamp(0.0, 1.0);
        self.geo_reward_saturation = self
            .geo_reward_saturation
            .min(1.0)
            .max(self.geo_reward_floor + 1e-6);
        self.direct_bonus_cap = self.direct_bonus_cap.clamp(0.0, 1.0);
        self.structural_bonus_cap = self.structural_bonus_cap.clamp(0.0, self.direct_bonus_cap);
        self.thematic_bonus_cap = self
            .thematic_bonus_cap
            .clamp(0.0, self.structural_bonus_cap);
        self.structural_continuity_min = self.structural_continuity_min.clamp(0.0, 1.0);
        self.thematic_min_potential = self.thematic_min_potential.clamp(0.0, 1.0);
        self.thematic_max_isolated_ratio = self.thematic_max_isolated_ratio.clamp(0.0, 1.0);

        self.sparse_association_min_contacts = self.sparse_association_min_contacts.max(2);
        self.sparse_association_min_conductance =
            self.sparse_association_min_conductance.clamp(0.0, 1.0);
        self.sparse_association_min_similarity =
            self.sparse_association_min_similarity.clamp(-1.0, 1.0);
        self.sparse_association_min_potential = self
            .sparse_association_min_potential
            .min(1.0)
            .max(self.weak_contact_threshold);
        self.sparse_association_min_closure = self.sparse_association_min_closure.clamp(0.0, 1.0);
        self.sparse_association_pair_saturation = self.sparse_association_pair_saturation.max(1);
        self.sparse_association_max_relief = self.sparse_association_max_relief.clamp(0.0, 0.8);

        self.direct_semantic_min_potential = self
            .direct_semantic_min_potential
            .min(1.0)
            .max(self.strong_contact_threshold);
        self.direct_semantic_saturation = self
            .direct_semantic_saturation
            .min(1.0)
            .max(self.direct_semantic_min_potential + 1e-6);
        self.direct_semantic_min_contacts = self.direct_semantic_min_contacts.max(1);
        self.direct_confidence_floor = self.direct_confidence_floor.clamp(0.0, 1.0);

        let aux = &mut self.geometry_auxiliary;
        aux.max_aux_bonus = aux.max_aux_bonus.clamp(0.0, 0.05);
        aux.direct_floor_cap = aux.direct_floor_cap.clamp(0.0, aux.max_aux_bonus);
        aux.structural_floor_cap = aux.structural_floor_cap.clamp(0.0, aux.direct_floor_cap);
        aux.thematic_floor_cap = aux.thematic_floor_cap.clamp(0.0, aux.structural_floor_cap);
        aux.min_fused_score = aux.min_fused_score.clamp(0.0, 1.0);
        aux.min_closure_score = aux.min_closure_score.clamp(0.0, 1.0);
        aux.min_class_evidence = aux.min_class_evidence.clamp(0.0, 1.0);
        aux.floor_exponent = aux.floor_exponent.clamp(0.5, 4.0);

        let identity = &mut aux.identity_anchor;
        identity.min_potential = identity.min_potential.clamp(0.0, 1.0);
        identity.min_specificity = identity.min_specificity.clamp(0.0, 1.0);
        identity.min_tag_chunk_closure = identity.min_tag_chunk_closure.clamp(0.0, 1.0);
        identity.min_strength = identity.min_strength.clamp(0.0, 1.0);
        identity.floor_cap = identity
            .floor_cap
            .clamp(0.0, self.direct_bonus_cap.min(aux.max_aux_bonus));
        identity.floor_exponent = identity.floor_exponent.clamp(0.5, 4.0);
        self
    }
}

#[derive(Clone)]
struct TagPoint {
    id: i64,
    name: String,
    position: i64,
    vector: Vec<f32>,
}

#[derive(Clone)]
struct CandidateCurve {
    id: i64,
    base_score: f64,
    chunk_vector: Vec<f32>,
    tags: Vec<TagPoint>,
}

#[derive(Clone)]
struct FieldNode {
    id: i64,
    potential: f64,
    vector: Vec<f32>,
    source_type: String,
}

#[derive(Clone)]
struct FieldSample {
    potential: f64,
    exact: bool,
    source_type: String,
}

#[derive(Clone)]
struct CurveScore {
    id: i64,
    base_score: f64,
    geo_score: f64,
    geo_bonus: f64,
    base_geo_bonus: f64,
    auxiliary_bonus: f64,
    final_score: f64,
    evidence_class: String,
    reward_eligible: bool,
    confidence: f64,
    exact_hits: usize,
    direct_exact_hits: usize,
    emergent_exact_hits: usize,
    direct_semantic_hits: usize,
    direct_semantic_strength: f64,
    strong_hits: usize,
    weak_hits: usize,
    weighted_coverage: f64,
    mean_potential: f64,
    max_potential: f64,
    continuity: f64,
    isolated_ratio: f64,
    raw_isolated_ratio: f64,
    sparse_association_confidence: f64,
    sparse_association_pairs: usize,
    action_quality: f64,
    closure_quality: f64,
    direction_consistency: f64,
    vector_lift: f64,
    direct_score: f64,
    structural_score: f64,
    thematic_score: f64,
    closure_score: f64,
    fused_geometry_score: f64,
    matched_tags: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DtscResultItem {
    id: i64,
    score: f64,
    original_knn_score: f64,
    geo_score: f64,
    normalized_geo: f64,
    geo_bonus: f64,
    geo_base_bonus: f64,
    geo_aux_bonus: f64,
    geo_effect: String,
    geo_evidence_class: String,
    geo_reward_eligible: bool,
    geo_confidence: f64,
    geo_exact_hits: usize,
    geo_direct_exact_hits: usize,
    geo_emergent_exact_hits: usize,
    geo_direct_semantic_hits: usize,
    geo_direct_semantic_strength: f64,
    geo_strong_hits: usize,
    geo_hit_count: usize,
    geo_weighted_coverage: f64,
    geo_mean_potential: f64,
    geo_max_potential: f64,
    geo_continuity: f64,
    geo_isolated_ratio: f64,
    geo_raw_isolated_ratio: f64,
    geo_sparse_association_confidence: f64,
    geo_sparse_association_pairs: usize,
    geo_action_quality: f64,
    geo_closure_quality: f64,
    geo_direction_consistency: f64,
    geo_vector_lift: f64,
    geo_direct_score: f64,
    geo_structural_score: f64,
    geo_thematic_score: f64,
    geo_closure_score: f64,
    geo_fused_shadow_score: f64,
    matched_tags: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DtscDiagnostics {
    backend: String,
    offered_candidates: usize,
    projected_candidates: usize,
    field_nodes: usize,
    contributing_candidates: usize,
    returned_candidates: usize,
    artifact_nodes: usize,
    artifact_edges: usize,
    field_trusted: bool,
    field_entropy: f64,
    fallback_used: bool,
    fallback_reason: Option<String>,
    load_ms: f64,
    compute_ms: f64,
    total_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DtscOutput {
    schema: String,
    algorithm_version: String,
    artifact_sig: String,
    results: Vec<DtscResultItem>,
    diagnostics: DtscDiagnostics,
}

fn load_tag_vectors(
    connection: &Connection,
    ids: &[i64],
    dimension: usize,
) -> std::result::Result<HashMap<i64, Vec<f32>>, String> {
    let mut vectors = HashMap::new();
    let mut statement = connection
        .prepare("SELECT vector FROM tags WHERE id = ?1")
        .map_err(|error| format!("prepare DTSC Tag vector query failed: {}", error))?;
    for id in ids {
        if let Ok(bytes) =
            statement.query_row(rusqlite::params![id], |row| row.get::<_, Vec<u8>>(0))
        {
            if let Some(vector) = decode_vector(&bytes, dimension) {
                vectors.insert(*id, vector);
            }
        }
    }
    Ok(vectors)
}

fn load_curves(
    connection: &Connection,
    candidates: &[CandidateInput],
    dimension: usize,
) -> std::result::Result<Vec<CandidateCurve>, String> {
    let mut chunk_statement = connection
        .prepare("SELECT file_id, vector FROM chunks WHERE id = ?1")
        .map_err(|error| format!("prepare DTSC chunk query failed: {}", error))?;
    let mut tag_statement = connection
        .prepare(
            "SELECT ft.tag_id, COALESCE(ft.position, 0), t.name, t.vector \
             FROM file_tags ft JOIN tags t ON t.id = ft.tag_id \
             WHERE ft.file_id = ?1 ORDER BY ft.position, ft.tag_id",
        )
        .map_err(|error| format!("prepare DTSC curve query failed: {}", error))?;

    let mut curves = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let row = chunk_statement.query_row(rusqlite::params![candidate.id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
        });
        let Ok((file_id, chunk_bytes)) = row else {
            // JS SOTA 对缺失曲线候选授予零测地贡献，但保留其原始 KNN 记录。
            curves.push(CandidateCurve {
                id: candidate.id,
                base_score: candidate.score,
                chunk_vector: Vec::new(),
                tags: Vec::new(),
            });
            continue;
        };
        let Some(chunk_vector) = decode_vector(&chunk_bytes, dimension) else {
            curves.push(CandidateCurve {
                id: candidate.id,
                base_score: candidate.score,
                chunk_vector: Vec::new(),
                tags: Vec::new(),
            });
            continue;
        };
        let rows = tag_statement
            .query_map(rusqlite::params![file_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                ))
            })
            .map_err(|error| format!("query DTSC curve failed: {}", error))?;
        let tags = rows
            .flatten()
            .filter_map(|row| {
                decode_vector(&row.3, dimension).map(|vector| TagPoint {
                    id: row.0,
                    position: row.1,
                    name: row.2,
                    vector,
                })
            })
            .collect();
        curves.push(CandidateCurve {
            id: candidate.id,
            base_score: candidate.score,
            chunk_vector,
            tags,
        });
    }
    Ok(curves)
}

fn hub_specificity(artifact: &NativeArtifact, tag_id: i64, floor: f64) -> f64 {
    if artifact.max_inbound <= 0.0 {
        return 1.0;
    }
    let inbound = artifact.inbound.get(&tag_id).copied().unwrap_or(0.0);
    floor
        .clamp(0.05, 1.0)
        .max(1.0 - clamp01(inbound / artifact.max_inbound).sqrt())
}

fn sample_field(
    tag: &TagPoint,
    exact_field: &HashMap<i64, FieldSample>,
    field_nodes: &[FieldNode],
    config: &DtscConfig,
    artifact: &NativeArtifact,
) -> FieldSample {
    let exact = exact_field.get(&tag.id);
    let mut neighbors: Vec<(f64, &FieldNode)> = field_nodes
        .iter()
        .filter_map(|node| {
            if node.id == tag.id {
                return None;
            }
            let similarity = cosine(&tag.vector, &node.vector);
            if similarity < config.field_similarity_threshold {
                return None;
            }
            let local = clamp01(
                (similarity - config.field_similarity_threshold)
                    / (1.0 - config.field_similarity_threshold).max(1e-6),
            );
            let potential = node.potential
                * local.powf(config.field_kernel_exponent.max(0.25))
                * hub_specificity(artifact, node.id, config.public_hub_floor);
            Some((potential, node))
        })
        .collect();
    neighbors.sort_by(|left, right| right.0.partial_cmp(&left.0).unwrap_or(Ordering::Equal));
    neighbors.truncate(config.max_field_neighbors.max(1));
    let interpolated = if neighbors.is_empty() {
        0.0
    } else {
        neighbors.iter().map(|entry| entry.0).sum::<f64>() / (neighbors.len() as f64).sqrt()
    };
    FieldSample {
        potential: clamp01(
            exact
                .map(|sample| sample.potential)
                .unwrap_or(0.0)
                .max(interpolated),
        ),
        exact: exact.is_some(),
        source_type: exact
            .map(|sample| sample.source_type.clone())
            .or_else(|| neighbors.first().map(|entry| entry.1.source_type.clone()))
            .unwrap_or_else(|| "unknown".to_string()),
    }
}

fn score_curve(
    curve: &CandidateCurve,
    exact_field: &HashMap<i64, FieldSample>,
    field_nodes: &[FieldNode],
    artifact: &NativeArtifact,
    input: &DtscInput,
) -> CurveScore {
    let config = &input.config;
    let empty = || {
        let original_closure = if input.original_query_vector.len() == curve.chunk_vector.len()
            && !curve.chunk_vector.is_empty()
        {
            clamp01((cosine(&input.original_query_vector, &curve.chunk_vector) + 1.0) / 2.0)
        } else {
            0.0
        };
        let enhanced_closure = if input.enhanced_query_vector.len() == curve.chunk_vector.len()
            && !curve.chunk_vector.is_empty()
        {
            clamp01((cosine(&input.enhanced_query_vector, &curve.chunk_vector) + 1.0) / 2.0)
        } else {
            0.0
        };
        let vector_lift = enhanced_closure - original_closure;
        let vector_lift_consistency = clamp01(0.5 + vector_lift * 5.0);
        CurveScore {
            id: curve.id,
            base_score: curve.base_score,
            geo_score: 0.0,
            geo_bonus: 0.0,
            base_geo_bonus: 0.0,
            auxiliary_bonus: 0.0,
            final_score: curve.base_score,
            evidence_class: "neutral".to_string(),
            reward_eligible: false,
            confidence: 0.0,
            exact_hits: 0,
            direct_exact_hits: 0,
            emergent_exact_hits: 0,
            direct_semantic_hits: 0,
            direct_semantic_strength: 0.0,
            strong_hits: 0,
            weak_hits: 0,
            weighted_coverage: 0.0,
            mean_potential: 0.0,
            max_potential: 0.0,
            continuity: 0.0,
            isolated_ratio: 1.0,
            raw_isolated_ratio: 1.0,
            sparse_association_confidence: 0.0,
            sparse_association_pairs: 0,
            action_quality: 0.0,
            closure_quality: 0.0,
            direction_consistency: 0.0,
            vector_lift,
            direct_score: 0.0,
            structural_score: 0.0,
            thematic_score: 0.0,
            closure_score: clamp01(
                0.35 * original_closure + 0.45 * enhanced_closure + 0.20 * vector_lift_consistency,
            ),
            fused_geometry_score: 0.0,
            matched_tags: Vec::new(),
        }
    };
    if curve.tags.is_empty() {
        return empty();
    }

    let mut samples = Vec::with_capacity(curve.tags.len());
    let mut total_mass = 0.0;
    let mut contacted_mass = 0.0;
    let mut weighted_potential = 0.0;
    let mut closure_mass = 0.0;
    let mut exact_hits = 0usize;
    let mut direct_exact_hits = 0usize;
    let mut emergent_exact_hits = 0usize;
    let mut direct_exact_max_potential: f64 = 0.0;
    let mut direct_semantic_hits = 0usize;
    let mut direct_semantic_potential_sum = 0.0;
    let mut strong_hits = 0usize;
    let mut weak_hits = 0usize;
    let mut max_potential: f64 = 0.0;

    for tag in &curve.tags {
        let closure = clamp01(
            (cosine(&tag.vector, &curve.chunk_vector) - config.min_closure_similarity)
                / (1.0 - config.min_closure_similarity).max(1e-6),
        );
        let anchor = artifact
            .anchor_gain
            .get(&tag.id)
            .copied()
            .unwrap_or(1.0)
            .clamp(0.5, 2.0);
        let specificity = hub_specificity(artifact, tag.id, config.public_hub_floor);
        let positional = (-config.position_decay * positive(tag.position as f64 - 1.0)).exp();
        let mass = (closure * anchor * positional * specificity).max(0.02);
        let field = sample_field(tag, exact_field, field_nodes, config, artifact);
        total_mass += mass;
        closure_mass += closure * mass;
        if field.potential >= config.weak_contact_threshold {
            weak_hits += 1;
            contacted_mass += mass;
            weighted_potential += mass * field.potential;
        }
        strong_hits += usize::from(field.potential >= config.strong_contact_threshold);
        if field.exact {
            exact_hits += 1;
            if field.source_type == "seed" || field.source_type == "core" {
                direct_exact_hits += 1;
                direct_exact_max_potential = direct_exact_max_potential.max(field.potential);
            } else {
                emergent_exact_hits += 1;
            }
        } else if (field.source_type == "seed" || field.source_type == "core")
            && field.potential >= config.direct_semantic_min_potential
        {
            direct_semantic_hits += 1;
            direct_semantic_potential_sum += field.potential;
        }
        max_potential = max_potential.max(field.potential);
        samples.push((tag, field, mass, closure, specificity));
    }

    if total_mass <= 0.0 || weak_hits == 0 {
        return empty();
    }
    let weighted_coverage = clamp01(contacted_mass / total_mass);
    let mean_potential = clamp01(weighted_potential / contacted_mass.max(1e-12));
    let closure_quality = clamp01(closure_mass / total_mass);

    let mut transition_mass = 0.0;
    let mut continuity_mass = 0.0;
    let mut weighted_semantic_arc = 0.0;
    let mut weighted_action = 0.0;
    let mut isolated_mass = 0.0;
    let mut isolated_indices = Vec::new();
    let mut direction_mass = 0.0;
    let mut directed_weight = 0.0;
    for index in 0..samples.len() {
        let current = &samples[index];
        let left = index > 0 && samples[index - 1].1.potential >= config.weak_contact_threshold;
        let right = index + 1 < samples.len()
            && samples[index + 1].1.potential >= config.weak_contact_threshold;
        if current.1.potential >= config.weak_contact_threshold && !left && !right {
            isolated_mass += current.2 * current.1.potential;
            isolated_indices.push(index);
        }
        if index + 1 >= samples.len() {
            continue;
        }
        let next = &samples[index + 1];
        let similarity = cosine(&current.0.vector, &next.0.vector).clamp(-1.0, 1.0);
        let arc = similarity.acos() / std::f64::consts::PI;
        let forward = artifact.edge_weight(current.0.id, next.0.id);
        let reverse = artifact.edge_weight(next.0.id, current.0.id);
        let topology = clamp01(forward.max(reverse).sqrt());
        let potential = (current.1.potential * next.1.potential).sqrt();
        let mass = (current.2 * next.2).sqrt();
        transition_mass += mass;
        continuity_mass += mass * potential * (0.65 + 0.35 * topology);
        weighted_semantic_arc += arc * mass;
        weighted_action += arc * mass / (potential + 0.25 * topology).max(0.08);
        if forward + reverse > 0.0 {
            let directional_weight = mass * potential.max(0.05);
            directed_weight += directional_weight;
            direction_mass += directional_weight * forward / (forward + reverse);
        }
    }
    let continuity = if transition_mass > 0.0 {
        clamp01(continuity_mass / transition_mass)
    } else {
        clamp01(max_potential * 0.35)
    };
    let raw_isolated_ratio = clamp01(isolated_mass / weighted_potential.max(1e-12));

    let mut sparse_pairs = 0usize;
    let mut sparse_quality = 0.0;
    let mut connected = HashSet::new();
    if config.sparse_association_enabled
        && isolated_indices.len() >= config.sparse_association_min_contacts
    {
        for left_pos in 0..isolated_indices.len() {
            let left_index = isolated_indices[left_pos];
            let left = &samples[left_index];
            if left.1.potential < config.sparse_association_min_potential
                || left.3 < config.sparse_association_min_closure
            {
                continue;
            }
            for &right_index in isolated_indices.iter().skip(left_pos + 1) {
                if right_index.abs_diff(left_index) <= 1 {
                    continue;
                }
                let right = &samples[right_index];
                if right.1.potential < config.sparse_association_min_potential
                    || right.3 < config.sparse_association_min_closure
                {
                    continue;
                }
                let conductance = artifact
                    .edge_weight(left.0.id, right.0.id)
                    .max(artifact.edge_weight(right.0.id, left.0.id));
                let similarity = cosine(&left.0.vector, &right.0.vector);
                if conductance < config.sparse_association_min_conductance
                    || similarity < config.sparse_association_min_similarity
                {
                    continue;
                }
                let topology_quality = clamp01(
                    (conductance - config.sparse_association_min_conductance)
                        / (1.0 - config.sparse_association_min_conductance).max(1e-6),
                );
                let semantic_quality = clamp01(
                    (similarity - config.sparse_association_min_similarity)
                        / (1.0 - config.sparse_association_min_similarity).max(1e-6),
                );
                let quality = positive(
                    topology_quality
                        * semantic_quality
                        * (left.1.potential * right.1.potential).sqrt()
                        * (left.3 * right.3).sqrt(),
                )
                .powf(0.25);
                if quality > 0.0 {
                    sparse_pairs += 1;
                    sparse_quality += quality;
                    connected.insert(left_index);
                    connected.insert(right_index);
                }
            }
        }
    }
    let connected_mass: f64 = connected
        .iter()
        .map(|index| samples[*index].2 * samples[*index].1.potential)
        .sum();
    let sparse_confidence = if sparse_pairs > 0 && isolated_mass > 0.0 {
        clamp01(connected_mass / isolated_mass)
            * clamp01(sparse_pairs as f64 / config.sparse_association_pair_saturation.max(1) as f64)
            * clamp01(sparse_quality / sparse_pairs as f64)
    } else {
        0.0
    };
    let isolated_ratio = clamp01(
        raw_isolated_ratio * (1.0 - config.sparse_association_max_relief * sparse_confidence),
    );
    let action_quality = if weighted_semantic_arc > 0.0 {
        clamp01((-weighted_action / weighted_semantic_arc.max(0.15)).exp())
    } else {
        clamp01(max_potential * 0.5)
    };
    let direction_consistency = if directed_weight > 0.0 {
        clamp01(direction_mass / directed_weight)
    } else {
        0.0
    };

    let evidence_target = config
        .min_geo_samples
        .max(1)
        .min((samples.len() as f64).sqrt().ceil() as usize);
    let evidence_confidence =
        clamp01((strong_hits as f64 + exact_hits as f64 * 0.75) / evidence_target as f64);
    let confidence = clamp01(
        weighted_coverage * (0.55 + 0.45 * evidence_confidence) * (1.0 - 0.65 * isolated_ratio),
    );
    let geo_score = confidence
        * clamp01(
            0.30 * mean_potential
                + 0.20 * max_potential
                + 0.20 * continuity
                + 0.15 * action_quality
                + 0.15 * closure_quality,
        );

    let direct_semantic_mean = if direct_semantic_hits > 0 {
        direct_semantic_potential_sum / direct_semantic_hits as f64
    } else {
        0.0
    };
    let direct_semantic_strength = if direct_semantic_hits >= config.direct_semantic_min_contacts {
        clamp01(
            (direct_semantic_mean - config.direct_semantic_min_potential)
                / (config.direct_semantic_saturation - config.direct_semantic_min_potential),
        )
    } else {
        0.0
    };

    let (evidence_class, eligible, cap) =
        if direct_exact_hits > 0 || direct_semantic_hits >= config.direct_semantic_min_contacts {
            ("direct", true, config.direct_bonus_cap)
        } else if exact_hits > 0
            || (strong_hits >= 2
                && continuity >= config.structural_continuity_min
                && isolated_ratio <= config.thematic_max_isolated_ratio)
        {
            ("structural", true, config.structural_bonus_cap)
        } else {
            (
                "thematic",
                max_potential >= config.thematic_min_potential
                    && isolated_ratio <= config.thematic_max_isolated_ratio,
                config.thematic_bonus_cap,
            )
        };

    let original_closure = if input.original_query_vector.len() == curve.chunk_vector.len() {
        clamp01((cosine(&input.original_query_vector, &curve.chunk_vector) + 1.0) / 2.0)
    } else {
        0.0
    };
    let enhanced_closure = if input.enhanced_query_vector.len() == curve.chunk_vector.len() {
        clamp01((cosine(&input.enhanced_query_vector, &curve.chunk_vector) + 1.0) / 2.0)
    } else {
        0.0
    };
    let vector_lift = enhanced_closure - original_closure;
    let vector_lift_consistency = clamp01(0.5 + vector_lift * 5.0);
    let closure_score = clamp01(
        0.25 * original_closure
            + 0.35 * enhanced_closure
            + 0.30 * closure_quality
            + 0.10 * vector_lift_consistency,
    );

    let direct_saturation = clamp01(
        (direct_exact_hits + direct_semantic_hits) as f64
            / (config.direct_semantic_min_contacts + 1).max(1) as f64,
    );
    let direct_score = clamp01(
        0.45 * direct_semantic_strength.max(if direct_exact_hits > 0 { 1.0 } else { 0.0 })
            + 0.25 * max_potential
            + 0.20 * mean_potential
            + 0.10 * direct_saturation,
    );
    let structural_contact = clamp01(
        (emergent_exact_hits + strong_hits.min(evidence_target)) as f64
            / (evidence_target + 1).max(1) as f64,
    );
    let structural_score = clamp01(
        0.25 * continuity
            + 0.20 * action_quality
            + 0.15 * closure_quality
            + 0.15 * (1.0 - isolated_ratio)
            + 0.15 * direction_consistency
            + 0.10 * structural_contact,
    );
    let thematic_score = clamp01(
        0.35 * weighted_coverage
            + 0.30 * mean_potential
            + 0.20 * (1.0 - isolated_ratio)
            + 0.15 * closure_quality,
    );
    let logic = clamp01(input.query_geometry_state.epa.logic_depth);
    let entropy = clamp01(input.query_geometry_state.epa.entropy);
    let resonance = clamp01(input.query_geometry_state.epa.resonance);
    let coverage = clamp01(input.query_geometry_state.pyramid.coverage);
    let novelty = clamp01(input.query_geometry_state.pyramid.novelty);
    let depth = clamp01(input.query_geometry_state.pyramid.depth);
    let wd = 0.45 + 0.35 * logic + 0.20 * coverage;
    let ws = 0.35 + 0.30 * depth + 0.25 * novelty + 0.10 * resonance;
    let wt = 0.20 + 0.35 * entropy + 0.30 * resonance + 0.15 * (1.0 - logic);
    let weight_sum = (wd + ws + wt).max(1e-12);
    let fused_geometry_score = clamp01(
        (1.0 - (1.0 - wd / weight_sum * direct_score)
            * (1.0 - ws / weight_sum * structural_score)
            * (1.0 - wt / weight_sum * thematic_score))
            * closure_score,
    );

    let normalized_geo = clamp01(
        (geo_score - config.geo_reward_floor)
            / (config.geo_reward_saturation - config.geo_reward_floor),
    );
    let semantic_qualified =
        evidence_class == "direct" && direct_semantic_hits >= config.direct_semantic_min_contacts;
    let reward_strength = if semantic_qualified {
        normalized_geo.max(direct_semantic_strength)
    } else {
        normalized_geo
    };
    let reward_confidence = if semantic_qualified {
        confidence.max(config.direct_confidence_floor)
    } else {
        confidence
    };
    let base_geo_bonus = if eligible {
        (config.alpha.clamp(0.0, 1.0) * reward_confidence * reward_strength).min(cap.max(0.0))
    } else {
        0.0
    };

    let aux = &config.geometry_auxiliary;
    let class_score = match evidence_class {
        "direct" => direct_score,
        "structural" => structural_score,
        _ => thematic_score,
    };
    let class_cap = match evidence_class {
        "direct" => aux.direct_floor_cap,
        "structural" => aux.structural_floor_cap,
        _ => aux.thematic_floor_cap,
    };
    let aux_eligible = aux.enabled
        && eligible
        && class_score >= aux.min_class_evidence
        && fused_geometry_score >= aux.min_fused_score
        && closure_score >= aux.min_closure_score;
    let geometry_floor = if aux_eligible {
        let fused_rel = clamp01(
            (fused_geometry_score - aux.min_fused_score) / (1.0 - aux.min_fused_score).max(1e-6),
        );
        let class_rel = clamp01(
            (class_score - aux.min_class_evidence) / (1.0 - aux.min_class_evidence).max(1e-6),
        );
        let closure_rel = clamp01(
            (closure_score - aux.min_closure_score) / (1.0 - aux.min_closure_score).max(1e-6),
        );
        class_cap
            * (fused_rel * class_rel * closure_rel)
                .cbrt()
                .powf(aux.floor_exponent)
    } else {
        0.0
    };

    let identity = &aux.identity_anchor;
    let best_direct = samples
        .iter()
        .filter(|sample| {
            sample.1.exact && (sample.1.source_type == "seed" || sample.1.source_type == "core")
        })
        .map(|sample| {
            (
                sample.1.potential,
                sample.4,
                sample.3,
                clamp01(sample.1.potential * sample.4 * sample.3.sqrt()),
            )
        })
        .max_by(|left, right| left.3.partial_cmp(&right.3).unwrap_or(Ordering::Equal));
    let identity_floor = if aux.enabled && identity.enabled && eligible {
        if let Some((_potential, specificity, closure, strength)) = best_direct {
            // JS tracks the strongest direct-exact potential independently
            // from the exact contact with the strongest identity product.
            if direct_exact_max_potential >= identity.min_potential
                && specificity >= identity.min_specificity
                && closure >= identity.min_tag_chunk_closure
                && strength >= identity.min_strength
            {
                let reliability = clamp01(
                    (strength - identity.min_strength) / (1.0 - identity.min_strength).max(1e-6),
                );
                identity.floor_cap * reliability.powf(identity.floor_exponent)
            } else {
                0.0
            }
        } else {
            0.0
        }
    } else {
        0.0
    };
    let target_floor = cap.min(geometry_floor.max(identity_floor));
    let auxiliary_bonus = if aux.enabled {
        aux.max_aux_bonus
            .min(positive(target_floor - base_geo_bonus))
    } else {
        0.0
    };
    let geo_bonus = cap.min(base_geo_bonus + auxiliary_bonus);

    CurveScore {
        id: curve.id,
        base_score: curve.base_score,
        geo_score,
        geo_bonus,
        base_geo_bonus,
        auxiliary_bonus,
        final_score: curve.base_score + geo_bonus,
        evidence_class: evidence_class.to_string(),
        reward_eligible: eligible,
        confidence,
        exact_hits,
        direct_exact_hits,
        emergent_exact_hits,
        direct_semantic_hits,
        direct_semantic_strength,
        strong_hits,
        weak_hits,
        weighted_coverage,
        mean_potential,
        max_potential,
        continuity,
        isolated_ratio,
        raw_isolated_ratio,
        sparse_association_confidence: sparse_confidence,
        sparse_association_pairs: sparse_pairs,
        action_quality,
        closure_quality,
        direction_consistency,
        vector_lift,
        direct_score,
        structural_score,
        thematic_score,
        closure_score,
        fused_geometry_score,
        matched_tags: curve
            .tags
            .iter()
            .map(|tag| tag.name.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect(),
    }
}

fn run(
    runtime: &MemoRuntime,
    db_path: &str,
    artifact_sig: &str,
    input_json: &str,
) -> std::result::Result<String, String> {
    let total_started = Instant::now();
    let mut input: DtscInput = serde_json::from_str(input_json)
        .map_err(|error| format!("invalid DTSC native input JSON: {}", error))?;
    input.config = input.config.normalize();
    if input.dimension == 0 {
        return Err("DTSC dimension must be positive".to_string());
    }
    let artifact = load_artifact_from_runtime(runtime, db_path, artifact_sig)?;
    let cached_observation = match input.observation_handle.as_deref() {
        Some(handle) => Some(runtime.get_query_observation(handle, artifact_sig)?),
        None => None,
    };
    if let Some(cached) = cached_observation.as_ref() {
        input.original_query_vector = cached.original_query_vector.as_ref().clone();
        input.enhanced_query_vector = cached.enhanced_query_vector.as_ref().clone();
    }
    let load_started = Instant::now();
    let connection = open_readonly(db_path)?;

    let mut normalized_observation_nodes: Vec<ObservationNodeInput> =
        if let Some(cached) = cached_observation.as_ref() {
            cached
                .observation
                .nodes
                .iter()
                .map(|node| ObservationNodeInput {
                    id: node.id,
                    energy: node.energy,
                    normalized_energy: node.normalized_energy,
                    source_type: node.source_type.clone(),
                    hop: node.hop,
                })
                .collect()
        } else if input.observation.nodes.is_empty() {
            // 兼容只提供 sourceField 的调用方；完整统一感应输出仍优先使用 nodes，
            // 因为它保留 seed/core/emergent 来源。
            input
                .observation
                .source_field
                .iter()
                .map(|(id, mass)| ObservationNodeInput {
                    id: *id,
                    energy: positive(*mass),
                    normalized_energy: positive(*mass),
                    source_type: "seed".to_string(),
                    hop: 0,
                })
                .collect()
        } else {
            input
                .observation
                .nodes
                .iter()
                .map(|node| ObservationNodeInput {
                    id: node.id,
                    energy: node.energy,
                    normalized_energy: node.normalized_energy,
                    source_type: node.source_type.clone(),
                    hop: node.hop,
                })
                .collect()
        };
    normalized_observation_nodes.retain(|node| {
        node.id > 0
            && (if node.energy > 0.0 {
                node.energy
            } else {
                node.normalized_energy
            }) > 0.0
    });
    normalized_observation_nodes.sort_by(|left, right| {
        let left_energy = if left.energy > 0.0 {
            left.energy
        } else {
            left.normalized_energy
        };
        let right_energy = if right.energy > 0.0 {
            right.energy
        } else {
            right.normalized_energy
        };
        right_energy
            .partial_cmp(&left_energy)
            .unwrap_or(Ordering::Equal)
            .then_with(|| left.id.cmp(&right.id))
    });

    // 与 JS SOTA 一致：场可信度使用原始正能量分布计算；先验证最小支持和
    // 归一化熵，再按累计能量质量与 maxFieldNodes 联合截断。
    let total_field_energy = normalized_observation_nodes
        .iter()
        .map(|node| {
            if node.energy > 0.0 {
                node.energy
            } else {
                node.normalized_energy
            }
        })
        .sum::<f64>();
    let field_entropy = if normalized_observation_nodes.len() > 1 && total_field_energy > 0.0 {
        let raw_entropy = normalized_observation_nodes
            .iter()
            .map(|node| {
                let energy = if node.energy > 0.0 {
                    node.energy
                } else {
                    node.normalized_energy
                };
                let probability = energy / total_field_energy;
                if probability > 0.0 {
                    -probability * probability.ln()
                } else {
                    0.0
                }
            })
            .sum::<f64>();
        raw_entropy / (normalized_observation_nodes.len() as f64).ln()
    } else {
        0.0
    };
    let max_field_energy = normalized_observation_nodes
        .iter()
        .map(|node| {
            if node.energy > 0.0 {
                node.energy
            } else {
                node.normalized_energy
            }
        })
        .fold(0.0, f64::max);
    // Exact identity contact is defined over the complete positive field,
    // not only the vector-bearing interpolation subset retained below.
    let exact_field: HashMap<i64, FieldSample> = normalized_observation_nodes
        .iter()
        .map(|node| {
            let energy = if node.energy > 0.0 {
                node.energy
            } else {
                node.normalized_energy
            };
            (
                node.id,
                FieldSample {
                    potential: if max_field_energy > 0.0 {
                        clamp01(energy / max_field_energy)
                    } else {
                        0.0
                    },
                    exact: true,
                    source_type: node.source_type.clone(),
                },
            )
        })
        .collect();
    let field_distribution_trusted = normalized_observation_nodes.len()
        >= input.config.min_field_tags.max(1)
        && total_field_energy > 0.0
        && (!input.config.fallback_to_knn_on_low_trust
            || field_entropy >= input.config.min_field_entropy.clamp(0.0, 1.0));

    let max_field_nodes = input
        .config
        .max_field_nodes
        .max(input.config.min_field_tags.max(1));
    let field_mass_ratio = input.config.field_energy_mass_ratio.clamp(0.5, 1.0);
    let mut retained_energy = 0.0;
    let mut retained_count = 0usize;
    for node in &normalized_observation_nodes {
        if retained_count >= max_field_nodes
            || (retained_count >= input.config.min_field_tags.max(1)
                && retained_energy / total_field_energy.max(1e-12) >= field_mass_ratio)
        {
            break;
        }
        retained_energy += if node.energy > 0.0 {
            node.energy
        } else {
            node.normalized_energy
        };
        retained_count += 1;
    }
    normalized_observation_nodes.truncate(retained_count);
    let field_ids: Vec<i64> = normalized_observation_nodes
        .iter()
        .map(|node| node.id)
        .collect();
    let field_vectors = load_tag_vectors(&connection, &field_ids, input.dimension)?;
    let field_nodes: Vec<FieldNode> = normalized_observation_nodes
        .iter()
        .filter_map(|node| {
            field_vectors.get(&node.id).map(|vector| {
                let energy = if node.energy > 0.0 {
                    node.energy
                } else {
                    node.normalized_energy
                };
                FieldNode {
                    id: node.id,
                    potential: if max_field_energy > 0.0 {
                        clamp01(energy / max_field_energy)
                    } else {
                        0.0
                    },
                    vector: vector.clone(),
                    source_type: node.source_type.clone(),
                }
            })
        })
        .collect();
    // JS 在读取 Tag 向量后再次检查 fieldNodes 数量；数据库缺向量不能继续
    // 被视为可信查询场。
    let field_trusted =
        field_distribution_trusted && field_nodes.len() >= input.config.min_field_tags.max(1);
    let curves = load_curves(&connection, &input.candidates, input.dimension)?;
    drop(connection);
    let load_ms = load_started.elapsed().as_secs_f64() * 1000.0;

    let compute_started = Instant::now();
    let mut scores: Vec<CurveScore> = curves
        .par_iter()
        .map(|curve| score_curve(curve, &exact_field, &field_nodes, &artifact, &input))
        .collect();

    // JS SOTA 的批级守卫按原始 geoScore 裁决。触发时必须保持输入候选顺序和
    // 原始 KNN 分数；不能仅清空 bonus 后继续按分数排序。
    let mut contributor_count = 0usize;
    let mut min_positive_geo = f64::INFINITY;
    let mut max_geo = 0.0f64;
    let mut strong_evidence = 0.0f64;
    for score in &scores {
        if score.geo_score <= 0.0 {
            continue;
        }
        contributor_count += 1;
        min_positive_geo = min_positive_geo.min(score.geo_score);
        max_geo = max_geo.max(score.geo_score);
        strong_evidence += score.strong_hits as f64 + score.exact_hits as f64 * 0.75;
    }
    let coverage_ratio = contributor_count as f64 / scores.len().max(1) as f64;
    let geo_spread = if contributor_count > 1 {
        max_geo - min_positive_geo
    } else {
        0.0
    };
    let fallback_reason = if !field_trusted {
        Some("query-energy-field-low-trust".to_string())
    } else if contributor_count == 0 {
        Some("no-candidate-curve-contacted-query-field".to_string())
    } else if input.config.fallback_to_knn_on_low_trust
        && coverage_ratio < input.config.min_candidate_coverage.clamp(0.0, 1.0)
        && max_geo < positive(input.config.min_geo_score)
        && strong_evidence < positive(input.config.min_strong_evidence)
    {
        Some("candidate-curve-readout-jointly-low-trust".to_string())
    } else if input.config.fallback_to_knn_on_low_trust
        && contributor_count > 1
        && geo_spread < positive(input.config.min_geo_spread)
        && max_geo < positive(input.config.min_geo_score)
        && strong_evidence < positive(input.config.min_strong_evidence)
    {
        Some("candidate-curve-scores-lack-discrimination".to_string())
    } else {
        None
    };
    let fallback_used = fallback_reason.is_some();
    if fallback_used {
        for score in &mut scores {
            score.geo_bonus = 0.0;
            score.base_geo_bonus = 0.0;
            score.auxiliary_bonus = 0.0;
            score.final_score = score.base_score;
        }
    } else {
        scores.sort_by(|left, right| {
            right
                .final_score
                .partial_cmp(&left.final_score)
                .unwrap_or(Ordering::Equal)
                .then_with(|| {
                    right
                        .base_score
                        .partial_cmp(&left.base_score)
                        .unwrap_or(Ordering::Equal)
                })
        });
    }
    let contributing_candidates = if fallback_used { 0 } else { contributor_count };
    let requested_k = if input.top_k == 0 {
        scores.len()
    } else {
        input.top_k
    };
    scores.truncate(requested_k.max(1));
    let results = scores
        .into_iter()
        .map(|score| {
            let normalized_geo = clamp01(
                (score.geo_score - input.config.geo_reward_floor)
                    / (input.config.geo_reward_saturation - input.config.geo_reward_floor),
            );
            DtscResultItem {
                id: score.id,
                score: score.final_score,
                original_knn_score: score.base_score,
                geo_score: score.geo_score,
                normalized_geo,
                geo_bonus: score.geo_bonus,
                geo_base_bonus: score.base_geo_bonus,
                geo_aux_bonus: score.auxiliary_bonus,
                geo_effect: if score.geo_bonus > 0.0 {
                    "boost".to_string()
                } else {
                    "neutral".to_string()
                },
                geo_evidence_class: score.evidence_class,
                geo_reward_eligible: score.reward_eligible,
                geo_confidence: score.confidence,
                geo_exact_hits: score.exact_hits,
                geo_direct_exact_hits: score.direct_exact_hits,
                geo_emergent_exact_hits: score.emergent_exact_hits,
                geo_direct_semantic_hits: score.direct_semantic_hits,
                geo_direct_semantic_strength: score.direct_semantic_strength,
                geo_strong_hits: score.strong_hits,
                geo_hit_count: score.weak_hits,
                geo_weighted_coverage: score.weighted_coverage,
                geo_mean_potential: score.mean_potential,
                geo_max_potential: score.max_potential,
                geo_continuity: score.continuity,
                geo_isolated_ratio: score.isolated_ratio,
                geo_raw_isolated_ratio: score.raw_isolated_ratio,
                geo_sparse_association_confidence: score.sparse_association_confidence,
                geo_sparse_association_pairs: score.sparse_association_pairs,
                geo_action_quality: score.action_quality,
                geo_closure_quality: score.closure_quality,
                geo_direction_consistency: score.direction_consistency,
                geo_vector_lift: score.vector_lift,
                geo_direct_score: score.direct_score,
                geo_structural_score: score.structural_score,
                geo_thematic_score: score.thematic_score,
                geo_closure_score: score.closure_score,
                geo_fused_shadow_score: score.fused_geometry_score,
                matched_tags: score.matched_tags,
            }
        })
        .collect::<Vec<_>>();
    let compute_ms = compute_started.elapsed().as_secs_f64() * 1000.0;

    serde_json::to_string(&DtscOutput {
        schema: RESULT_SCHEMA.to_string(),
        algorithm_version: ALGORITHM_VERSION.to_string(),
        artifact_sig: artifact_sig.to_string(),
        diagnostics: DtscDiagnostics {
            backend: "rust-rayon-shared-memo-runtime".to_string(),
            offered_candidates: input.candidates.len(),
            projected_candidates: curves.len(),
            field_nodes: field_nodes.len(),
            contributing_candidates,
            returned_candidates: results.len(),
            artifact_nodes: artifact.node_ids.len(),
            artifact_edges: artifact.targets.len(),
            field_trusted,
            field_entropy,
            fallback_used,
            fallback_reason,
            load_ms,
            compute_ms,
            total_ms: total_started.elapsed().as_secs_f64() * 1000.0,
        },
        results,
    })
    .map_err(|error| format!("encode DTSC native output failed: {}", error))
}

pub struct MemoDtscTask {
    runtime: Arc<MemoRuntime>,
    db_path: String,
    artifact_sig: String,
    input_json: String,
}

impl Task for MemoDtscTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        run(
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
    runtime: Arc<MemoRuntime>,
    db_path: String,
    artifact_sig: String,
    input_json: String,
) -> AsyncTask<MemoDtscTask> {
    AsyncTask::new(MemoDtscTask {
        runtime,
        db_path,
        artifact_sig,
        input_json,
    })
}
