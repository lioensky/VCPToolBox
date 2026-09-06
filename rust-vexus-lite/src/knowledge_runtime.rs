use crate::result_deduplicator::{self, DedupCandidate};
use crate::rivermemo_topology_v3::{self, MemoRuntime};
use crate::VexusIndex;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering as CompareOrdering;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use usearch::Index;

struct RegisteredDiaryIndex {
    index: Arc<RwLock<Index>>,
    content_revision: Arc<AtomicU64>,
    generation: u64,
    dimension: u32,
}

#[napi(object)]
pub struct RegisteredDiaryIndexState {
    pub diary_name: String,
    pub generation: i64,
    pub content_revision: i64,
    pub dimension: u32,
    pub total_vectors: u32,
}

#[napi(object)]
pub struct NativeKnowledgeRuntimeStats {
    pub accepting_queries: bool,
    pub dimension: u32,
    pub registered_diaries: u32,
    pub registry_generation: i64,
    pub memo_runtime_resident: bool,
    pub memo_artifact_sig: Option<String>,
    pub memo_generation: i64,
}

#[derive(Clone)]
struct DiarySearchSnapshot {
    diary_name: String,
    index: Arc<RwLock<Index>>,
    content_revision: Arc<AtomicU64>,
    generation: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeAnnCandidate {
    id: i64,
    score: f64,
    vector_score: f64,
    bm25_score: f64,
    time_score: f64,
    sources: Vec<String>,
}

#[derive(Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct NativeSupplementalQueryPlan {
    weights: Vec<f64>,
    per_index_k: Option<usize>,
}

#[derive(Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct NativeFileCandidate {
    path: String,
    bm25_score: f64,
    normalized_bm25_score: f64,
    time_score: f64,
    source: String,
}

#[derive(Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct NativeHybridQueryPlan {
    schema: String,
    supplemental: NativeSupplementalQueryPlan,
    file_candidates: Vec<NativeFileCandidate>,
    bm25_weight: f64,
    time_per_diary_limit: usize,
    time_global_limit: usize,
}

impl Default for NativeHybridQueryPlan {
    fn default() -> Self {
        Self {
            schema: "vcp-native-hybrid-query-plan-v2".to_string(),
            supplemental: NativeSupplementalQueryPlan::default(),
            file_candidates: Vec::new(),
            bm25_weight: 0.6,
            time_per_diary_limit: 10,
            time_global_limit: 50,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeAnnIndexSnapshot {
    diary_name: String,
    generation: u64,
    content_revision: u64,
    candidates: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeAnnDiagnostics {
    requested_diaries: usize,
    resolved_indices: usize,
    per_index_k: usize,
    candidate_k: usize,
    final_k: usize,
    query_vector_count: usize,
    supplemental_vector_count: usize,
    file_candidate_count: usize,
    bm25_chunk_candidates: usize,
    time_chunk_candidates_before_limit: usize,
    time_chunk_candidates: usize,
    time_per_diary_limit: usize,
    time_global_limit: usize,
    ann_candidates: usize,
    unique_candidates: usize,
    returned_candidates: usize,
    lock_and_search_ms: f64,
    semantic_enabled: bool,
    semantic_sql_batches: usize,
    hydrated_vectors: usize,
    missing_vectors: usize,
    semantic_comparisons: usize,
    semantic_suppressed: usize,
    semantic_dedup_ms: f64,
    total_ms: f64,
    indices: Vec<NativeAnnIndexSnapshot>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeAnnOutput {
    schema: String,
    results: Vec<NativeAnnCandidate>,
    diagnostics: NativeAnnDiagnostics,
}

struct SemanticDedupConfig {
    db_path: String,
    threshold: f64,
}

pub struct NativeMultiIndexAnnTask {
    dimension: usize,
    query: Vec<f32>,
    supplemental_queries: Vec<Vec<f32>>,
    supplemental_weights: Vec<f64>,
    supplemental_per_index_k: usize,
    file_candidates: Vec<NativeFileCandidate>,
    bm25_weight: f64,
    time_per_diary_limit: usize,
    time_global_limit: usize,
    per_index_k: usize,
    candidate_k: usize,
    final_k: usize,
    snapshots: Vec<DiarySearchSnapshot>,
    semantic_dedup: Option<SemanticDedupConfig>,
}

fn compare_time_candidates(
    left: &NativeAnnCandidate,
    right: &NativeAnnCandidate,
) -> CompareOrdering {
    right
        .vector_score
        .partial_cmp(&left.vector_score)
        .unwrap_or(CompareOrdering::Equal)
        .then_with(|| left.id.cmp(&right.id))
}

/// 对已按日记本隔离并按 Chunk ID 合并的 Time 候选执行双重硬限流。
///
/// 返回值依次为：最终候选、限流前唯一 Chunk 数、实际每日记本上限、
/// 实际全局上限。日记名和 Chunk ID 都参与稳定排序，HashMap 迭代顺序
/// 不会影响结果。
fn limit_time_candidates(
    mut pending_by_diary: HashMap<String, HashMap<i64, NativeAnnCandidate>>,
    requested_per_diary_limit: usize,
    requested_global_limit: usize,
) -> (Vec<NativeAnnCandidate>, usize, usize, usize) {
    let per_diary_limit = requested_per_diary_limit.clamp(1, 50);
    let global_limit = requested_global_limit.clamp(1, 500);
    let before_limit = pending_by_diary.values().map(HashMap::len).sum();
    let mut limited = Vec::new();
    let mut diary_names: Vec<String> = pending_by_diary.keys().cloned().collect();
    diary_names.sort();

    for diary_name in diary_names {
        let mut diary_candidates: Vec<NativeAnnCandidate> = pending_by_diary
            .remove(&diary_name)
            .unwrap_or_default()
            .into_values()
            .collect();
        diary_candidates.sort_by(compare_time_candidates);
        diary_candidates.truncate(per_diary_limit);
        limited.extend(diary_candidates);
    }

    limited.sort_by(compare_time_candidates);
    limited.truncate(global_limit);
    (limited, before_limit, per_diary_limit, global_limit)
}

impl Task for NativeMultiIndexAnnTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let total_started = std::time::Instant::now();
        if self.query.len() != self.dimension {
            return Err(Error::from_reason(format!(
                "Native multi-index ANN dimension mismatch: expected {}, got {}",
                self.dimension,
                self.query.len()
            )));
        }
        if self
            .supplemental_queries
            .iter()
            .any(|query| query.len() != self.dimension)
        {
            return Err(Error::from_reason(
                "Native supplemental ANN vector dimension mismatch".to_string()
            ));
        }

        // snapshots 已按日记名排序；按相同顺序同时取得全部读锁，避免多个公共
        // 索引查询期间与任一批量写入交错，也避免不同任务反序加锁造成死锁。
        let lock_started = std::time::Instant::now();
        let guards = self
            .snapshots
            .iter()
            .map(|snapshot| {
                snapshot.index.read().map_err(|error| {
                    Error::from_reason(format!(
                        "Native ANN index read lock failed for {}: {}",
                        snapshot.diary_name, error
                    ))
                })
            })
            .collect::<Result<Vec<_>>>()?;

        let mut merged: HashMap<i64, NativeAnnCandidate> = HashMap::new();
        let mut ann_candidates = 0usize;
        let mut index_diagnostics = Vec::with_capacity(self.snapshots.len());
        for (snapshot, index) in self.snapshots.iter().zip(guards.iter()) {
            let matches = index
                .search(&self.query, self.per_index_k)
                .map_err(|error| {
                    Error::from_reason(format!(
                        "Native ANN search failed for {}: {:?}",
                        snapshot.diary_name, error
                    ))
                })?;
            ann_candidates += matches.keys.len();
            for (key, distance) in matches.keys.iter().zip(matches.distances.iter()) {
                let id = *key as i64;
                let score = 1.0 / (1.0 + *distance as f64);
                let entry = merged.entry(id).or_insert_with(|| NativeAnnCandidate {
                    id,
                    score,
                    vector_score: score,
                    bm25_score: 0.0,
                    time_score: 0.0,
                    sources: Vec::new(),
                });
                entry.score = entry.score.max(score);
                entry.vector_score = entry.vector_score.max(score);
                // 当前 Query 保持既有公共契约：sources 直接记录日记本名。
                // 只有 supplemental 历史向量使用 history_N: 前缀区分来源。
                entry.sources.push(snapshot.diary_name.clone());
            }

            for (query_index, supplemental_query) in
                self.supplemental_queries.iter().enumerate()
            {
                let weight = self
                    .supplemental_weights
                    .get(query_index)
                    .copied()
                    .unwrap_or(1.0)
                    .clamp(0.0, 1.0);
                let history_matches = index
                    .search(supplemental_query, self.supplemental_per_index_k)
                    .map_err(|error| {
                        Error::from_reason(format!(
                            "Native supplemental ANN search failed for {}: {:?}",
                            snapshot.diary_name, error
                        ))
                    })?;
                ann_candidates += history_matches.keys.len();
                for (key, distance) in history_matches
                    .keys
                    .iter()
                    .zip(history_matches.distances.iter())
                {
                    let id = *key as i64;
                    let raw_score = 1.0 / (1.0 + *distance as f64);
                    let score = raw_score * weight;
                    let entry = merged.entry(id).or_insert_with(|| NativeAnnCandidate {
                        id,
                        score,
                        vector_score: raw_score,
                        bm25_score: 0.0,
                        time_score: 0.0,
                        sources: Vec::new(),
                    });
                    entry.score = entry.score.max(score);
                    entry.vector_score = entry.vector_score.max(raw_score);
                    entry.sources.push(format!(
                        "history_{}:{}",
                        query_index,
                        snapshot.diary_name
                    ));
                }
            }

            index_diagnostics.push(NativeAnnIndexSnapshot {
                diary_name: snapshot.diary_name.clone(),
                generation: snapshot.generation,
                content_revision: snapshot.content_revision.load(Ordering::Acquire),
                candidates: matches.keys.len(),
            });
        }
        let lock_and_search_ms = lock_started.elapsed().as_secs_f64() * 1000.0;
        drop(guards);

        let mut bm25_chunk_candidates = 0usize;
        let mut time_chunk_candidates_before_limit = 0usize;
        let mut time_chunk_candidates = 0usize;
        let time_per_diary_limit = self.time_per_diary_limit.clamp(1, 50);
        let time_global_limit = self.time_global_limit.clamp(1, 500);
        if !self.file_candidates.is_empty() {
            let connection = rusqlite::Connection::open_with_flags(
                self.semantic_dedup
                    .as_ref()
                    .map(|config| config.db_path.as_str())
                    .ok_or_else(|| Error::from_reason(
                        "Native hybrid file candidates require SQLite semantic config"
                            .to_string()
                    ))?,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .map_err(|error| Error::from_reason(format!(
                "Open native hybrid SQLite failed: {}",
                error
            )))?;
            connection
                .busy_timeout(std::time::Duration::from_secs(30))
                .map_err(|error| Error::from_reason(format!(
                    "Configure native hybrid SQLite failed: {}",
                    error
                )))?;

            let sparse_weight = self.bm25_weight.clamp(0.0, 1.0);
            let allowed_diaries: HashSet<&str> = self
                .snapshots
                .iter()
                .map(|snapshot| snapshot.diary_name.as_str())
                .collect();
            let mut pending_time_by_diary:
                HashMap<String, HashMap<i64, NativeAnnCandidate>> = HashMap::new();
            for file_candidate in &self.file_candidates {
                if file_candidate.path.trim().is_empty() {
                    continue;
                }
                let mut statement = connection
                    .prepare(
                        "SELECT c.id, c.vector, f.diary_name FROM chunks c \
                         JOIN files f ON f.id = c.file_id WHERE f.path = ?1"
                    )
                    .map_err(|error| Error::from_reason(format!(
                        "Prepare native hybrid file expansion failed: {}",
                        error
                    )))?;
                let rows = statement
                    .query_map([file_candidate.path.as_str()], |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, Vec<u8>>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })
                    .map_err(|error| Error::from_reason(format!(
                        "Query native hybrid file expansion failed: {}",
                        error
                    )))?;
                for row in rows {
                    let (id, bytes, diary_name) =
                        row.map_err(|error| Error::from_reason(
                            format!("Decode native hybrid Chunk failed: {}", error)
                        ))?;
                    // 文件计划来自 JavaScript 控制面，但 Rust 数据面仍必须再次执行
                    // 本次已冻结日记作用域校验，禁止同路径或坏计划越权注入候选。
                    if !allowed_diaries.contains(diary_name.as_str())
                        || bytes.len() != self.dimension * 4
                    {
                        continue;
                    }
                    let vector: Vec<f32> = bytes
                        .chunks_exact(4)
                        .map(|chunk| f32::from_ne_bytes(
                            [chunk[0], chunk[1], chunk[2], chunk[3]]
                        ))
                        .collect();
                    let vector_score = cosine_similarity(&self.query, &vector);
                    let normalized_bm25 = file_candidate
                        .normalized_bm25_score
                        .clamp(0.0, 1.0);
                    let bm25_score = file_candidate.bm25_score.max(0.0);
                    let time_score = file_candidate.time_score.max(0.0);
                    let hybrid_score = if bm25_score > 0.0 {
                        normalized_bm25 * sparse_weight
                            + vector_score * (1.0 - sparse_weight)
                    } else {
                        vector_score
                    };
                    let source = if file_candidate.source.trim().is_empty() {
                        if bm25_score > 0.0 { "bm25" } else { "time" }
                    } else {
                        file_candidate.source.as_str()
                    };
                    let incoming = NativeAnnCandidate {
                        id,
                        score: hybrid_score,
                        vector_score,
                        bm25_score,
                        time_score,
                        sources: vec![source.to_string()],
                    };

                    if source == "time" || time_score > 0.0 {
                        // Time 候选先留在日记本私有池中。多个重叠时间范围命中
                        // 同一 Chunk 时按 ID 合并，不能通过重复范围绕过硬上限。
                        let diary_pool = pending_time_by_diary
                            .entry(diary_name)
                            .or_default();
                        let entry = diary_pool.entry(id).or_insert_with(|| incoming.clone());
                        entry.score = entry.score.max(incoming.score);
                        entry.vector_score =
                            entry.vector_score.max(incoming.vector_score);
                        entry.bm25_score =
                            entry.bm25_score.max(incoming.bm25_score);
                        entry.time_score =
                            entry.time_score.max(incoming.time_score);
                        entry.sources.extend(incoming.sources);
                    } else {
                        let entry = merged.entry(id).or_insert_with(|| incoming.clone());
                        entry.score = entry.score.max(incoming.score);
                        entry.vector_score =
                            entry.vector_score.max(incoming.vector_score);
                        entry.bm25_score =
                            entry.bm25_score.max(incoming.bm25_score);
                        entry.sources.extend(incoming.sources);
                        if bm25_score > 0.0 {
                            bm25_chunk_candidates += 1;
                        }
                    }
                }
            }

            // 先执行每日记本硬上限，再执行全局硬上限。
            let (limited_time_candidates, before_limit, _, _) =
                limit_time_candidates(
                    pending_time_by_diary,
                    time_per_diary_limit,
                    time_global_limit,
                );
            time_chunk_candidates_before_limit = before_limit;
            time_chunk_candidates = limited_time_candidates.len();

            for mut incoming in limited_time_candidates {
                incoming.sources.sort();
                incoming.sources.dedup();
                let entry = merged
                    .entry(incoming.id)
                    .or_insert_with(|| incoming.clone());
                entry.score = entry.score.max(incoming.score);
                entry.vector_score =
                    entry.vector_score.max(incoming.vector_score);
                entry.bm25_score =
                    entry.bm25_score.max(incoming.bm25_score);
                entry.time_score =
                    entry.time_score.max(incoming.time_score);
                entry.sources.extend(incoming.sources);
            }
        }

        let unique_candidates = merged.len();
        let mut results: Vec<NativeAnnCandidate> = merged
            .into_values()
            .map(|mut candidate| {
                candidate.sources.sort();
                candidate.sources.dedup();
                candidate
            })
            .collect();
        results.sort_by(|left, right| {
            right
                .score
                .partial_cmp(&left.score)
                .unwrap_or(CompareOrdering::Equal)
                .then_with(|| left.id.cmp(&right.id))
        });
        // candidate_k 控制进入 hydrate/语义比较的候选池；final_k 只控制最终输出。
        // 二者分离后，高重复候选池可以从后续候选补足最终 Top-K。
        results.truncate(self.candidate_k);

        let semantic_started = std::time::Instant::now();
        let mut semantic_sql_batches = 0usize;
        let mut hydrated_vectors = 0usize;
        let mut missing_vectors = 0usize;
        let mut semantic_comparisons = 0usize;
        let mut semantic_suppressed = 0usize;
        let semantic_enabled = self.semantic_dedup.is_some();
        if let Some(config) = &self.semantic_dedup {
            let metadata_by_id: HashMap<i64, NativeAnnCandidate> = results
                .iter()
                .map(|candidate| (candidate.id, candidate.clone()))
                .collect();
            let dedup_input = results
                .iter()
                .enumerate()
                .map(|(original_index, candidate)| DedupCandidate {
                    id: candidate.id,
                    score: candidate.score,
                    original_index,
                })
                .collect();
            let deduplicated = result_deduplicator::deduplicate(
                &config.db_path,
                dedup_input,
                &self.query,
                self.dimension,
                config.threshold,
                self.final_k,
            )
            .map_err(Error::from_reason)?;
            semantic_sql_batches = deduplicated.sql_batches;
            hydrated_vectors = deduplicated.hydrated_vectors;
            missing_vectors = deduplicated.missing_vectors;
            semantic_comparisons = deduplicated.comparison_count;
            semantic_suppressed = deduplicated.suppressed;
            results = deduplicated
                .candidates
                .into_iter()
                .map(|candidate| {
                    metadata_by_id
                        .get(&candidate.id)
                        .cloned()
                        .unwrap_or(NativeAnnCandidate {
                            id: candidate.id,
                            score: candidate.score,
                            vector_score: candidate.score,
                            bm25_score: 0.0,
                            time_score: 0.0,
                            sources: Vec::new(),
                        })
                })
                .collect();
        } else {
            results.truncate(self.final_k);
        }
        let semantic_dedup_ms = if semantic_enabled {
            semantic_started.elapsed().as_secs_f64() * 1000.0
        } else {
            0.0
        };
        let returned_candidates = results.len();

        serde_json::to_string(&NativeAnnOutput {
            schema: if semantic_enabled {
                "vcp-native-multi-index-ann-dedup-result-v1".to_string()
            } else {
                "vcp-native-multi-index-ann-result-v1".to_string()
            },
            results,
            diagnostics: NativeAnnDiagnostics {
                requested_diaries: self.snapshots.len(),
                resolved_indices: self.snapshots.len(),
                per_index_k: self.per_index_k,
                candidate_k: self.candidate_k,
                final_k: self.final_k,
                query_vector_count: 1 + self.supplemental_queries.len(),
                supplemental_vector_count: self.supplemental_queries.len(),
                file_candidate_count: self.file_candidates.len(),
                bm25_chunk_candidates,
                time_chunk_candidates_before_limit,
                time_chunk_candidates,
                time_per_diary_limit,
                time_global_limit,
                ann_candidates,
                unique_candidates,
                returned_candidates,
                lock_and_search_ms,
                semantic_enabled,
                semantic_sql_batches,
                hydrated_vectors,
                missing_vectors,
                semantic_comparisons,
                semantic_suppressed,
                semantic_dedup_ms,
                total_ms: total_started.elapsed().as_secs_f64() * 1000.0,
                indices: index_diagnostics,
            },
        })
        .map_err(|error| {
            Error::from_reason(format!("Encode native multi-index ANN result failed: {}", error))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

fn cosine_similarity(left: &[f32], right: &[f32]) -> f64 {
    if left.len() != right.len() || left.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f64;
    let mut left_norm = 0.0f64;
    let mut right_norm = 0.0f64;
    for index in 0..left.len() {
        let a = left[index] as f64;
        let b = right[index] as f64;
        if !a.is_finite() || !b.is_finite() {
            return 0.0;
        }
        dot += a * b;
        left_norm += a * a;
        right_norm += b * b;
    }
    if left_norm <= 1e-12 || right_norm <= 1e-12 {
        0.0
    } else {
        dot / (left_norm.sqrt() * right_norm.sqrt())
    }
}

/// 一次原生 River 查询任务：前半段 ANN/合并/去重的结果不解析到 JS，
/// 而是直接成为 Topology V3 的候选输入。
pub struct NativeRiverQueryTask {
    runtime: Arc<MemoRuntime>,
    db_path: String,
    artifact_sig: String,
    river_input_json: String,
    ann_task: NativeMultiIndexAnnTask,
}

impl Task for NativeRiverQueryTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let total_started = std::time::Instant::now();

        // 复用已验证的原生 ANN/合并/语义去重实现。此处只在 Rust 内解析其
        // 小型 ID/分数结果，不发生 N-API resolve，也不携带向量跨边界。
        let ann_payload = self.ann_task.compute()?;
        let ann_output: serde_json::Value = serde_json::from_str(&ann_payload)
            .map_err(|error| {
                Error::from_reason(format!(
                    "Decode native River query ANN stage failed: {}",
                    error
                ))
            })?;
        let ann_results = ann_output
            .get("results")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();

        let mut river_input: serde_json::Value =
            serde_json::from_str(&self.river_input_json).map_err(|error| {
                Error::from_reason(format!(
                    "Decode native River query plan failed: {}",
                    error
                ))
            })?;
        let input_object = river_input.as_object_mut().ok_or_else(|| {
            Error::from_reason(
                "Native River query plan root must be an object".to_string()
            )
        })?;
        input_object.insert(
            "candidates".to_string(),
            serde_json::Value::Array(
                ann_results
                    .iter()
                    .filter_map(|candidate| {
                        let id = candidate.get("id")?.as_i64()?;
                        let score = candidate
                            .get("score")
                            .and_then(serde_json::Value::as_f64)
                            .unwrap_or(0.0);
                        Some(serde_json::json!({
                            "id": id,
                            "score": score,
                            "vectorScore": candidate
                                .get("vectorScore")
                                .and_then(serde_json::Value::as_f64)
                                .unwrap_or(score),
                            "bm25Score": candidate
                                .get("bm25Score")
                                .and_then(serde_json::Value::as_f64)
                                .unwrap_or(0.0),
                            "timeScore": candidate
                                .get("timeScore")
                                .and_then(serde_json::Value::as_f64)
                                .unwrap_or(0.0),
                            "candidateSources": candidate
                                .get("sources")
                                .cloned()
                                .unwrap_or_else(|| serde_json::json!([]))
                        }))
                    })
                    .collect(),
            ),
        );

        let river_payload = rivermemo_topology_v3::run_native(
            &self.runtime,
            &self.db_path,
            &self.artifact_sig,
            &serde_json::to_string(&river_input).map_err(|error| {
                Error::from_reason(format!(
                    "Encode native River query plan failed: {}",
                    error
                ))
            })?,
        )
        .map_err(Error::from_reason)?;

        let mut river_output: serde_json::Value =
            serde_json::from_str(&river_payload).map_err(|error| {
                Error::from_reason(format!(
                    "Decode native River query output failed: {}",
                    error
                ))
            })?;
        if let Some(diagnostics) = river_output
            .get_mut("diagnostics")
            .and_then(serde_json::Value::as_object_mut)
        {
            diagnostics.insert(
                "nativeQuery".to_string(),
                serde_json::json!({
                    "schema": "vcp-native-river-query-v1",
                    "ann": ann_output.get("diagnostics").cloned()
                        .unwrap_or(serde_json::Value::Null),
                    "ffiTrips": 1,
                    "intermediateCandidatesCrossedNapi": false,
                    "totalMs": total_started.elapsed().as_secs_f64() * 1000.0
                }),
            );
        }
        serde_json::to_string(&river_output).map_err(|error| {
            Error::from_reason(format!(
                "Encode native River query output failed: {}",
                error
            ))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub struct NativeKnowledgeRuntime {
    dimension: u32,
    memo_runtime: Arc<MemoRuntime>,
    diaries: RwLock<HashMap<String, RegisteredDiaryIndex>>,
    registry_generation: AtomicU64,
    accepting_queries: AtomicBool,
}

impl NativeKnowledgeRuntime {
    fn normalize_diary_name(value: String) -> Result<String> {
        let normalized = value.trim().to_string();
        if normalized.is_empty() {
            return Err(Error::from_reason(
                "Diary index registration requires a non-empty diary name".to_string(),
            ));
        }
        Ok(normalized)
    }

    fn state_for(
        diary_name: String,
        registered: &RegisteredDiaryIndex,
    ) -> Result<RegisteredDiaryIndexState> {
        let total_vectors = registered
            .index
            .read()
            .map_err(|error| {
                Error::from_reason(format!(
                    "Diary index state read lock failed for {}: {}",
                    diary_name, error
                ))
            })?
            .size() as u32;
        Ok(RegisteredDiaryIndexState {
            diary_name,
            generation: registered.generation as i64,
            content_revision: registered.content_revision.load(Ordering::Acquire) as i64,
            dimension: registered.dimension,
            total_vectors,
        })
    }
}

#[napi]
impl NativeKnowledgeRuntime {
    /// 创建实例级知识查询运行时，并绑定全局 Tag VexusIndex 拥有的 MemoRuntime。
    ///
    /// 构造完成后只持有纯 Rust Arc，不保存 N-API 对象引用。
    #[napi(constructor)]
    pub fn new(tag_index: ClassInstance<VexusIndex>) -> Result<Self> {
        Ok(Self {
            dimension: tag_index.dimensions,
            memo_runtime: tag_index.memo_runtime.clone(),
            diaries: RwLock::new(HashMap::new()),
            registry_generation: AtomicU64::new(0),
            accepting_queries: AtomicBool::new(true),
        })
    }

    /// 注册或原子替换一个日记索引。
    ///
    /// 返回由 Runtime 自身分配的 generation；后续注销必须携带该 generation，
    /// 防止旧的空闲淘汰任务误删同名新实例。
    #[napi]
    pub fn register_diary_index(
        &self,
        diary_name: String,
        diary_index: ClassInstance<VexusIndex>,
    ) -> Result<RegisteredDiaryIndexState> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        let diary_name = Self::normalize_diary_name(diary_name)?;
        if diary_index.dimensions != self.dimension {
            return Err(Error::from_reason(format!(
                "Diary index dimension mismatch for {}: runtime={}, index={}",
                diary_name, self.dimension, diary_index.dimensions
            )));
        }

        let generation = self.registry_generation.fetch_add(1, Ordering::AcqRel) + 1;
        let registered = RegisteredDiaryIndex {
            index: diary_index.index.clone(),
            content_revision: diary_index.content_revision.clone(),
            generation,
            dimension: diary_index.dimensions,
        };
        let state = Self::state_for(diary_name.clone(), &registered)?;
        self.diaries
            .write()
            .map_err(|error| {
                Error::from_reason(format!("Diary registry write lock failed: {}", error))
            })?
            .insert(diary_name, registered);
        Ok(state)
    }

    /// 在多个已注册日记索引上执行一次后台 ANN，并按 Chunk ID 确定性合并。
    #[napi]
    pub fn search_diary_indices(
        &self,
        diary_names: Vec<String>,
        query: Float32Array,
        per_index_k: u32,
        global_k: u32,
    ) -> Result<AsyncTask<NativeMultiIndexAnnTask>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if query.len() != self.dimension as usize {
            return Err(Error::from_reason(format!(
                "Native multi-index ANN dimension mismatch: expected {}, got {}",
                self.dimension,
                query.len()
            )));
        }

        let mut requested: Vec<String> = diary_names
            .into_iter()
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        requested.sort();
        if requested.is_empty() {
            return Err(Error::from_reason(
                "Native multi-index ANN requires at least one diary name".to_string(),
            ));
        }

        let registry = self.diaries.read().map_err(|error| {
            Error::from_reason(format!("Diary registry read lock failed: {}", error))
        })?;
        let mut snapshots = Vec::with_capacity(requested.len());
        for diary_name in requested {
            let registered = registry.get(&diary_name).ok_or_else(|| {
                Error::from_reason(format!(
                    "Native diary index is not registered: {}",
                    diary_name
                ))
            })?;
            snapshots.push(DiarySearchSnapshot {
                diary_name,
                index: registered.index.clone(),
                content_revision: registered.content_revision.clone(),
                generation: registered.generation,
            });
        }
        drop(registry);

        let final_k = global_k.max(1) as usize;
        Ok(AsyncTask::new(NativeMultiIndexAnnTask {
            dimension: self.dimension as usize,
            query: query.to_vec(),
            supplemental_queries: Vec::new(),
            supplemental_weights: Vec::new(),
            supplemental_per_index_k: per_index_k.max(1) as usize,
            file_candidates: Vec::new(),
            bm25_weight: 0.6,
            time_per_diary_limit: 10,
            time_global_limit: 50,
            per_index_k: per_index_k.max(1) as usize,
            candidate_k: final_k,
            final_k,
            snapshots,
            semantic_dedup: None,
        }))
    }

    /// 多索引 ANN 后在同一后台任务中批量读取 Chunk 向量并执行确定性语义去重。
    ///
    /// global_k 是进入语义阶段的候选池上限；final_k 是去重后的输出上限。
    /// final_k 省略时回退 global_k，保持早期 ABI 调用兼容。
    #[napi]
    pub fn search_diary_indices_deduplicated(
        &self,
        db_path: String,
        diary_names: Vec<String>,
        query: Float32Array,
        per_index_k: u32,
        global_k: u32,
        semantic_threshold: f64,
        final_k: Option<u32>,
    ) -> Result<AsyncTask<NativeMultiIndexAnnTask>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() {
            return Err(Error::from_reason(
                "Native semantic dedup requires a SQLite database path".to_string(),
            ));
        }
        if query.len() != self.dimension as usize {
            return Err(Error::from_reason(format!(
                "Native multi-index ANN dimension mismatch: expected {}, got {}",
                self.dimension,
                query.len()
            )));
        }

        let mut requested: Vec<String> = diary_names
            .into_iter()
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        requested.sort();
        if requested.is_empty() {
            return Err(Error::from_reason(
                "Native multi-index ANN requires at least one diary name".to_string(),
            ));
        }

        let registry = self.diaries.read().map_err(|error| {
            Error::from_reason(format!("Diary registry read lock failed: {}", error))
        })?;
        let mut snapshots = Vec::with_capacity(requested.len());
        for diary_name in requested {
            let registered = registry.get(&diary_name).ok_or_else(|| {
                Error::from_reason(format!(
                    "Native diary index is not registered: {}",
                    diary_name
                ))
            })?;
            snapshots.push(DiarySearchSnapshot {
                diary_name,
                index: registered.index.clone(),
                content_revision: registered.content_revision.clone(),
                generation: registered.generation,
            });
        }
        drop(registry);

        let candidate_k = global_k.max(1) as usize;
        let final_k = final_k.unwrap_or(global_k).max(1) as usize;
        Ok(AsyncTask::new(NativeMultiIndexAnnTask {
            dimension: self.dimension as usize,
            query: query.to_vec(),
            supplemental_queries: Vec::new(),
            supplemental_weights: Vec::new(),
            supplemental_per_index_k: per_index_k.max(1) as usize,
            file_candidates: Vec::new(),
            bm25_weight: 0.6,
            time_per_diary_limit: 10,
            time_global_limit: 50,
            per_index_k: per_index_k.max(1) as usize,
            candidate_k,
            final_k,
            snapshots,
            semantic_dedup: Some(SemanticDedupConfig {
                db_path,
                threshold: semantic_threshold,
            }),
        }))
    }

    /// 使用已有 Memo observationHandle，在一次 N-API 后台任务中执行：
    /// 多索引 ANN → Chunk ID 合并 → SQLite 批量向量 hydrate → 语义去重
    /// → RiverMemo Topology V3。river_input_json 中的 candidates 会被忽略并由
    /// 原生检索结果替换；topK、权限作用域和 Topology 配置保持原契约。
    #[napi]
    pub fn execute_river_query(
        &self,
        db_path: String,
        artifact_sig: String,
        river_input_json: String,
        diary_names: Vec<String>,
        query: Float32Array,
        per_index_k: u32,
        candidate_k: u32,
        semantic_threshold: f64,
    ) -> Result<AsyncTask<NativeRiverQueryTask>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() || artifact_sig.trim().is_empty() {
            return Err(Error::from_reason(
                "Native River query requires dbPath and artifactSig".to_string(),
            ));
        }
        if query.len() != self.dimension as usize {
            return Err(Error::from_reason(format!(
                "Native River query dimension mismatch: expected {}, got {}",
                self.dimension,
                query.len()
            )));
        }

        // 提前校验计划及 observationHandle，让可预见错误在 ANN 前失败，
        // 避免原生执行到末尾后再触发完整旧链路回退。
        let plan: serde_json::Value =
            serde_json::from_str(&river_input_json).map_err(|error| {
                Error::from_reason(format!(
                    "Invalid native River query plan JSON: {}",
                    error
                ))
            })?;
        let observation_handle = plan
            .get("observationHandle")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                Error::from_reason(
                    "Native River query requires observationHandle".to_string(),
                )
            })?;
        self.memo_runtime
            .get_query_observation(observation_handle, &artifact_sig)
            .map_err(Error::from_reason)?;

        let mut requested: Vec<String> = diary_names
            .into_iter()
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        requested.sort();
        if requested.is_empty() {
            return Err(Error::from_reason(
                "Native River query requires at least one diary name".to_string(),
            ));
        }

        let registry = self.diaries.read().map_err(|error| {
            Error::from_reason(format!("Diary registry read lock failed: {}", error))
        })?;
        let mut snapshots = Vec::with_capacity(requested.len());
        for diary_name in requested {
            let registered = registry.get(&diary_name).ok_or_else(|| {
                Error::from_reason(format!(
                    "Native diary index is not registered: {}",
                    diary_name
                ))
            })?;
            snapshots.push(DiarySearchSnapshot {
                diary_name,
                index: registered.index.clone(),
                content_revision: registered.content_revision.clone(),
                generation: registered.generation,
            });
        }
        drop(registry);

        let candidate_k = candidate_k.max(1) as usize;
        Ok(AsyncTask::new(NativeRiverQueryTask {
            runtime: self.memo_runtime.clone(),
            db_path: db_path.clone(),
            artifact_sig,
            river_input_json,
            ann_task: NativeMultiIndexAnnTask {
                dimension: self.dimension as usize,
                query: query.to_vec(),
                supplemental_queries: Vec::new(),
                supplemental_weights: Vec::new(),
                supplemental_per_index_k: per_index_k.max(1) as usize,
                file_candidates: Vec::new(),
                bm25_weight: 0.6,
                time_per_diary_limit: 10,
                time_global_limit: 50,
                per_index_k: per_index_k.max(1) as usize,
                candidate_k,
                // Topology V3 自己执行最终 topK；去重阶段保留完整候选池。
                final_k: candidate_k,
                snapshots,
                semantic_dedup: Some(SemanticDedupConfig {
                    db_path,
                    threshold: semantic_threshold,
                }),
            },
        }))
    }

    /// Native Query Plan V2：在一次后台任务中融合当前向量、历史分段向量、
    /// Time 文件候选和 BM25 文件候选，再执行统一语义去重与 Topology V3。
    ///
    /// supplemental_vectors 是 count × dimension 的扁平 Float32Array；低维计划
    /// 继续使用 JSON，避免任何 Chunk/Tag 高维向量经 JSON 或 N-API 往返。
    #[napi]
    pub fn execute_river_query_hybrid(
        &self,
        db_path: String,
        artifact_sig: String,
        river_input_json: String,
        diary_names: Vec<String>,
        query: Float32Array,
        supplemental_vectors: Float32Array,
        hybrid_plan_json: String,
        per_index_k: u32,
        candidate_k: u32,
        semantic_threshold: f64,
    ) -> Result<AsyncTask<NativeRiverQueryTask>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() || artifact_sig.trim().is_empty() {
            return Err(Error::from_reason(
                "Native hybrid River query requires dbPath and artifactSig".to_string(),
            ));
        }
        if query.len() != self.dimension as usize {
            return Err(Error::from_reason(format!(
                "Native hybrid River query dimension mismatch: expected {}, got {}",
                self.dimension,
                query.len()
            )));
        }

        let plan: NativeHybridQueryPlan =
            serde_json::from_str(&hybrid_plan_json).map_err(|error| {
                Error::from_reason(format!(
                    "Invalid native hybrid query plan JSON: {}",
                    error
                ))
            })?;
        if plan.schema != "vcp-native-hybrid-query-plan-v2" {
            return Err(Error::from_reason(format!(
                "Unsupported native hybrid query plan schema: {}",
                plan.schema
            )));
        }

        let dimension = self.dimension as usize;
        if supplemental_vectors.len() % dimension != 0 {
            return Err(Error::from_reason(format!(
                "Native supplemental vectors length {} is not divisible by dimension {}",
                supplemental_vectors.len(),
                dimension
            )));
        }
        let supplemental_queries: Vec<Vec<f32>> = supplemental_vectors
            .chunks(dimension)
            .map(|chunk| chunk.to_vec())
            .collect();
        if !plan.supplemental.weights.is_empty()
            && plan.supplemental.weights.len() != supplemental_queries.len()
        {
            return Err(Error::from_reason(format!(
                "Native supplemental weights count mismatch: vectors={}, weights={}",
                supplemental_queries.len(),
                plan.supplemental.weights.len()
            )));
        }

        let river_plan: serde_json::Value =
            serde_json::from_str(&river_input_json).map_err(|error| {
                Error::from_reason(format!(
                    "Invalid native hybrid River input JSON: {}",
                    error
                ))
            })?;
        let observation_handle = river_plan
            .get("observationHandle")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                Error::from_reason(
                    "Native hybrid River query requires observationHandle".to_string(),
                )
            })?;
        self.memo_runtime
            .get_query_observation(observation_handle, &artifact_sig)
            .map_err(Error::from_reason)?;

        let mut requested: Vec<String> = diary_names
            .into_iter()
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        requested.sort();
        if requested.is_empty() {
            return Err(Error::from_reason(
                "Native hybrid River query requires at least one diary name".to_string(),
            ));
        }

        let registry = self.diaries.read().map_err(|error| {
            Error::from_reason(format!("Diary registry read lock failed: {}", error))
        })?;
        let mut snapshots = Vec::with_capacity(requested.len());
        for diary_name in requested {
            let registered = registry.get(&diary_name).ok_or_else(|| {
                Error::from_reason(format!(
                    "Native diary index is not registered: {}",
                    diary_name
                ))
            })?;
            snapshots.push(DiarySearchSnapshot {
                diary_name,
                index: registered.index.clone(),
                content_revision: registered.content_revision.clone(),
                generation: registered.generation,
            });
        }
        drop(registry);

        let candidate_k = candidate_k.max(1) as usize;
        let supplemental_per_index_k = plan
            .supplemental
            .per_index_k
            .unwrap_or_else(|| (candidate_k / 2).max(2))
            .max(1);
        Ok(AsyncTask::new(NativeRiverQueryTask {
            runtime: self.memo_runtime.clone(),
            db_path: db_path.clone(),
            artifact_sig,
            river_input_json,
            ann_task: NativeMultiIndexAnnTask {
                dimension,
                query: query.to_vec(),
                supplemental_queries,
                supplemental_weights: plan.supplemental.weights,
                supplemental_per_index_k,
                file_candidates: plan.file_candidates,
                bm25_weight: plan.bm25_weight.clamp(0.0, 1.0),
                time_per_diary_limit:
                    plan.time_per_diary_limit.clamp(1, 50),
                time_global_limit:
                    plan.time_global_limit.clamp(1, 500),
                per_index_k: per_index_k.max(1) as usize,
                candidate_k,
                final_k: candidate_k,
                snapshots,
                semantic_dedup: Some(SemanticDedupConfig {
                    db_path,
                    threshold: semantic_threshold,
                }),
            },
        }))
    }

    /// 按 expectedGeneration 注销索引。代际不匹配时返回 false，不修改注册表。
    #[napi]
    pub fn unregister_diary_index(
        &self,
        diary_name: String,
        expected_generation: i64,
    ) -> Result<bool> {
        let diary_name = Self::normalize_diary_name(diary_name)?;
        if expected_generation <= 0 {
            return Err(Error::from_reason(
                "expectedGeneration must be a positive integer".to_string(),
            ));
        }
        let mut registry = self.diaries.write().map_err(|error| {
            Error::from_reason(format!("Diary registry write lock failed: {}", error))
        })?;
        let matches = registry
            .get(&diary_name)
            .map(|registered| registered.generation == expected_generation as u64)
            .unwrap_or(false);
        if matches {
            registry.remove(&diary_name);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    #[napi]
    pub fn diary_index_state(
        &self,
        diary_name: String,
    ) -> Result<Option<RegisteredDiaryIndexState>> {
        let diary_name = Self::normalize_diary_name(diary_name)?;
        let registry = self.diaries.read().map_err(|error| {
            Error::from_reason(format!("Diary registry read lock failed: {}", error))
        })?;
        registry
            .get(&diary_name)
            .map(|registered| Self::state_for(diary_name, registered))
            .transpose()
    }

    #[napi]
    pub fn list_diary_indices(&self) -> Result<Vec<RegisteredDiaryIndexState>> {
        let registry = self.diaries.read().map_err(|error| {
            Error::from_reason(format!("Diary registry read lock failed: {}", error))
        })?;
        let mut names: Vec<String> = registry.keys().cloned().collect();
        names.sort();
        names
            .into_iter()
            .filter_map(|name| {
                registry
                    .get(&name)
                    .map(|registered| Self::state_for(name, registered))
            })
            .collect()
    }

    #[napi]
    pub fn stats(&self) -> Result<NativeKnowledgeRuntimeStats> {
        let registered_diaries = self
            .diaries
            .read()
            .map_err(|error| {
                Error::from_reason(format!("Diary registry read lock failed: {}", error))
            })?
            .len() as u32;
        let (artifact_sig, memo_generation, _, _) = self
            .memo_runtime
            .diagnostics()
            .map_err(Error::from_reason)?;
        Ok(NativeKnowledgeRuntimeStats {
            accepting_queries: self.accepting_queries.load(Ordering::Acquire),
            dimension: self.dimension,
            registered_diaries,
            registry_generation: self.registry_generation.load(Ordering::Acquire) as i64,
            memo_runtime_resident: artifact_sig.is_some(),
            memo_artifact_sig: artifact_sig,
            memo_generation: memo_generation as i64,
        })
    }

    /// 停止接受后续查询并清空注册表。已开始任务持有的 Arc 快照不受影响。
    #[napi]
    pub fn shutdown(&self) -> Result<()> {
        self.accepting_queries.store(false, Ordering::Release);
        self.diaries
            .write()
            .map_err(|error| {
                Error::from_reason(format!("Diary registry shutdown lock failed: {}", error))
            })?
            .clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn time_candidate(id: i64, vector_score: f64) -> NativeAnnCandidate {
        NativeAnnCandidate {
            id,
            score: vector_score,
            vector_score,
            bm25_score: 0.0,
            time_score: 1.0,
            sources: vec!["time".to_string()],
        }
    }

    fn diary_pool(entries: &[(i64, f64)]) -> HashMap<i64, NativeAnnCandidate> {
        entries
            .iter()
            .map(|(id, score)| (*id, time_candidate(*id, *score)))
            .collect()
    }

    #[test]
    fn time_limit_applies_per_diary_before_global_limit() {
        let pending = HashMap::from([
            (
                "alpha".to_string(),
                diary_pool(&[(1, 0.9), (2, 0.8), (3, 0.7)]),
            ),
            (
                "beta".to_string(),
                diary_pool(&[(4, 0.95), (5, 0.85), (6, 0.75)]),
            ),
        ]);

        let (limited, before, per_diary, global) =
            limit_time_candidates(pending, 2, 10);

        assert_eq!(before, 6);
        assert_eq!(per_diary, 2);
        assert_eq!(global, 10);
        assert_eq!(
            limited.iter().map(|candidate| candidate.id).collect::<Vec<_>>(),
            vec![4, 1, 5, 2]
        );
    }

    #[test]
    fn time_limit_applies_global_cap_after_diary_caps() {
        let pending = HashMap::from([
            ("alpha".to_string(), diary_pool(&[(1, 0.9), (2, 0.8)])),
            ("beta".to_string(), diary_pool(&[(3, 0.95), (4, 0.7)])),
        ]);

        let (limited, _, _, _) = limit_time_candidates(pending, 2, 3);

        assert_eq!(
            limited.iter().map(|candidate| candidate.id).collect::<Vec<_>>(),
            vec![3, 1, 2]
        );
    }

    #[test]
    fn time_limit_uses_chunk_id_as_stable_tie_breaker() {
        let pending = HashMap::from([(
            "alpha".to_string(),
            diary_pool(&[(30, 0.8), (10, 0.8), (20, 0.8)]),
        )]);

        let (limited, _, _, _) = limit_time_candidates(pending, 10, 10);

        assert_eq!(
            limited.iter().map(|candidate| candidate.id).collect::<Vec<_>>(),
            vec![10, 20, 30]
        );
    }

    #[test]
    fn time_limit_clamps_extreme_configuration() {
        let entries: Vec<(i64, f64)> = (1..=600)
            .map(|id| (id, 1.0 - id as f64 / 1000.0))
            .collect();
        let pending = HashMap::from([("alpha".to_string(), diary_pool(&entries))]);

        let (limited, before, per_diary, global) =
            limit_time_candidates(pending, usize::MAX, usize::MAX);

        assert_eq!(before, 600);
        assert_eq!(per_diary, 50);
        assert_eq!(global, 500);
        assert_eq!(limited.len(), 50);
    }

    #[test]
    fn time_limit_counts_overlapping_ranges_once_after_chunk_merge() {
        let mut alpha = HashMap::new();
        alpha.insert(7, time_candidate(7, 0.7));
        let overlapping = time_candidate(7, 0.9);
        let entry = alpha
            .entry(overlapping.id)
            .or_insert_with(|| overlapping.clone());
        entry.vector_score = entry.vector_score.max(overlapping.vector_score);
        entry.score = entry.score.max(overlapping.score);
        let pending = HashMap::from([("alpha".to_string(), alpha)]);

        let (limited, before, _, _) = limit_time_candidates(pending, 10, 10);

        assert_eq!(before, 1);
        assert_eq!(limited.len(), 1);
        assert_eq!(limited[0].id, 7);
        assert_eq!(limited[0].vector_score, 0.9);
    }
}