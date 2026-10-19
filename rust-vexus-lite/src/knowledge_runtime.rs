use crate::index_lifecycle::{IndexCheckpointTask, IndexRestoreTask, IndexScope};
use crate::task_lifecycle::{TaskLifecycle, TrackedTask};
use crate::text::TextPreparationTask;
use crate::ingestion::{
    DeleteCommitTask, IngestionCommitTask, IngestionFileProbeTask, IngestionTagProbeTask,
    MigrationReuseProbeTask, OrphanCleanupTask,
};
use crate::tag_consistency::{
    TagConsistencyCommitTask, TagConsistencyPrepareTask, TagConsistencySnapshotTask,
};
use crate::result_deduplicator::{self, DedupCandidate};
use crate::rivermemo_topology_v3::{self, MemoRuntime};
use crate::storage::{
    normalize_storage_options, with_registered_read_napi, with_registered_write,
    SqliteStorageEngine, StorageOptions,
};
use crate::{VexusIndex, VexusWatcher, WatchEvent, WatcherConfig};
use base64::Engine;
use rusqlite::OptionalExtension;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering as CompareOrdering;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use crate::retrieval_index::RetrievalIndex as Index;

pub struct GlobalTagSearchTask {
    db_path: String,
    memo_runtime: Arc<MemoRuntime>,
    index: Arc<crate::index_handle::IndexHandle>,
    content_revision: Arc<AtomicU64>,
    dimension: usize,
    query: Vec<f32>,
    limit: usize,
}

impl Task for GlobalTagSearchTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<String> {
        let scopes = [String::from("global_tags")];
        let mut guard = crate::publication_gate::acquire_read(&self.db_path, &scopes)
            .map_err(Error::from_reason)?;
        match ensure_index_scopes_ready(&self.db_path, &scopes) {
            Ok(()) => {}
            Err(error) if error.starts_with("KBM_INDEX_NOT_READY:") => {
                drop(guard);
                guard = crate::publication_gate::acquire(&self.db_path, &scopes)
                    .map_err(Error::from_reason)?;
            }
            Err(error) => return Err(Error::from_reason(error)),
        }
        match ensure_index_scopes_ready(&self.db_path, &["global_tags".to_string()]) {
            Ok(()) => {}
            Err(error) if error.starts_with("KBM_INDEX_NOT_READY:") => {
                self.memo_runtime.clear().map_err(Error::from_reason)?;
                recover_index_snapshot(
                    &self.db_path, "global_tags".to_string(), None,
                    &self.index, &self.content_revision, self.dimension,
                ).map_err(Error::from_reason)?;
            }
            Err(error) => return Err(Error::from_reason(error)),
        }
        ensure_index_scopes_ready(&self.db_path, &["global_tags".to_string()])
            .map_err(Error::from_reason)?;
        guard.downgrade().map_err(Error::from_reason)?;
        let output = crate::storage::with_registered_read_transaction(&self.db_path, |connection| {
            let matches = self.index.read()
                .map_err(|_| "Global Tag index lock poisoned".to_string())?
                .search_sql(connection, None, &self.query, self.limit)
                .map_err(|error| format!("Global Tag search failed: {}", error))?;
            let mut statement = connection.prepare("SELECT name FROM tags WHERE id=?1")
                .map_err(|error| error.to_string())?;
            let mut output = Vec::new();
            for (id, cosine) in &matches {
                let name: Option<String> = statement.query_row([*id as i64], |row| row.get(0))
                    .optional().map_err(|error| error.to_string())?;
                if let Some(name) = name {
                    output.push(serde_json::json!({
                        "tag": name, "score": *cosine as f64
                    }));
                }
            }
            serde_json::to_string(&output).map_err(|error| error.to_string())
        }).map_err(Error::from_reason)?;
        Ok(output)
    }

    fn resolve(&mut self, _env: Env, output: String) -> Result<String> {
        Ok(output)
    }
}

struct RegisteredDiaryIndex {
    index: Arc<crate::index_handle::IndexHandle>,
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
    pub store_open: bool,
    pub store_schema_version: i64,
    pub store_database_generation: i64,
}

#[napi(object)]
pub struct NativeRuntimeCapabilities {
    pub abi_version: u32,
    pub dimension: u32,
    pub capabilities: Vec<String>,
}

#[napi(object)]
pub struct NativeStoreState {
    pub db_path: String,
    pub schema_version: i64,
    pub database_generation: i64,
    pub accepting_writes: bool,
}

#[derive(Clone)]
struct DiarySearchSnapshot {
    diary_name: String,
    index: Arc<crate::index_handle::IndexHandle>,
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
    hydrated_chunks: Vec<serde_json::Value>,
    results: Vec<NativeAnnCandidate>,
    diagnostics: NativeAnnDiagnostics,
}

struct SemanticDedupConfig {
    db_path: String,
    threshold: f64,
}

pub struct NativeMultiIndexAnnTask {
    db_path: Option<String>,
    index_scopes: Vec<String>,
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
        let _publication_guard = self.query_guard(&self.index_scopes)?;
        self.compute_under_publication_gate()
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

impl NativeMultiIndexAnnTask {
    fn query_guard(&self, scopes: &[String]) -> Result<crate::publication_gate::PublicationGuard> {
        let path = self.db_path.as_deref().unwrap_or("unopened");
        let guard = crate::publication_gate::acquire_read(path, scopes).map_err(Error::from_reason)?;
        if let Some(db_path) = &self.db_path {
            match ensure_index_scopes_ready(db_path, &self.index_scopes) {
                Ok(()) => return Ok(guard),
                Err(error) if error.starts_with("KBM_INDEX_NOT_READY:") => {}
                Err(error) => return Err(Error::from_reason(error)),
            }
        } else {
            return Ok(guard);
        }
        drop(guard);
        let mut guard = crate::publication_gate::acquire(path, scopes).map_err(Error::from_reason)?;
        self.prepare_indices()?;
        guard.downgrade().map_err(Error::from_reason)?;
        Ok(guard)
    }

    fn compute_under_publication_gate(&mut self) -> Result<String> {
        self.prepare_indices()?;
        let db_path = self.db_path.clone();
        if let Some(db_path) = db_path {
            crate::storage::with_registered_read_transaction_napi(&db_path, |connection| {
                self.compute_with_connection(Some(connection))
            })
        } else {
            self.compute_with_connection(None)
        }
    }

    fn prepare_indices(&self) -> Result<()> {
        if let Some(db_path) = &self.db_path {
            for snapshot in &self.snapshots {
                let scope = format!("diary:{}", snapshot.diary_name);
                match ensure_index_scopes_ready(db_path, &[scope]) {
                    Ok(()) => {}
                    Err(error) if error.starts_with("KBM_INDEX_NOT_READY:") => {
                        recover_diary_snapshot(db_path, snapshot, self.dimension)
                            .map_err(Error::from_reason)?;
                    }
                    Err(error) => return Err(Error::from_reason(error)),
                }
            }
            ensure_index_scopes_ready(db_path, &self.index_scopes)
                .map_err(Error::from_reason)?;
        }
        Ok(())
    }

    fn compute_with_connection(&mut self, connection: Option<&rusqlite::Connection>) -> Result<String> {
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
                "Native supplemental ANN vector dimension mismatch".to_string(),
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
            let matches = match connection {
                Some(connection) => index.search_sql(
                    connection, Some(&snapshot.diary_name), &self.query, self.per_index_k,
                ),
                None => index.search(&self.query, self.per_index_k),
            }
                .map_err(|error| {
                    Error::from_reason(format!(
                        "Native ANN search failed for {}: {:?}",
                        snapshot.diary_name, error
                    ))
                })?;
            ann_candidates += matches.len();
            for (key, cosine) in &matches {
                let id = *key as i64;
                let score = *cosine as f64;
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

            for (query_index, supplemental_query) in self.supplemental_queries.iter().enumerate() {
                let weight = self
                    .supplemental_weights
                    .get(query_index)
                    .copied()
                    .unwrap_or(1.0)
                    .clamp(0.0, 1.0);
                let history_matches = match connection {
                    Some(connection) => index.search_sql(
                        connection, Some(&snapshot.diary_name),
                        supplemental_query, self.supplemental_per_index_k,
                    ),
                    None => index.search(supplemental_query, self.supplemental_per_index_k),
                }
                    .map_err(|error| {
                        Error::from_reason(format!(
                            "Native supplemental ANN search failed for {}: {:?}",
                            snapshot.diary_name, error
                        ))
                    })?;
                ann_candidates += history_matches.len();
                for (key, cosine) in &history_matches {
                    let id = *key as i64;
                    let raw_score = *cosine as f64;
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
                    entry
                        .sources
                        .push(format!("history_{}:{}", query_index, snapshot.diary_name));
                }
            }

            index_diagnostics.push(NativeAnnIndexSnapshot {
                diary_name: snapshot.diary_name.clone(),
                generation: snapshot.generation,
                content_revision: snapshot.content_revision.load(Ordering::Acquire),
                candidates: matches.len(),
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
            let semantic_db_path = self
                .semantic_dedup
                .as_ref()
                .map(|config| config.db_path.clone())
                .ok_or_else(|| {
                    Error::from_reason(
                        "Native hybrid file candidates require SQLite semantic config".to_string(),
                    )
                })?;
            with_query_connection(connection, &semantic_db_path, |connection| {
                let sparse_weight = self.bm25_weight.clamp(0.0, 1.0);
                let allowed_diaries: HashSet<&str> = self
                    .snapshots
                    .iter()
                    .map(|snapshot| snapshot.diary_name.as_str())
                    .collect();
                let mut pending_time_by_diary: HashMap<String, HashMap<i64, NativeAnnCandidate>> =
                    HashMap::new();
                for file_candidate in &self.file_candidates {
                    if file_candidate.path.trim().is_empty() {
                        continue;
                    }
                    let mut statement = connection
                        .prepare(
                            "SELECT c.id, c.vector, f.diary_name FROM chunks c \
                         JOIN files f ON f.id = c.file_id WHERE f.path = ?1 AND c.vector IS NOT NULL",
                        )
                        .map_err(|error| {
                            Error::from_reason(format!(
                                "Prepare native hybrid file expansion failed: {}",
                                error
                            ))
                        })?;
                    let rows = statement
                        .query_map([file_candidate.path.as_str()], |row| {
                            Ok((
                                row.get::<_, i64>(0)?,
                                row.get::<_, Vec<u8>>(1)?,
                                row.get::<_, String>(2)?,
                            ))
                        })
                        .map_err(|error| {
                            Error::from_reason(format!(
                                "Query native hybrid file expansion failed: {}",
                                error
                            ))
                        })?;
                    for row in rows {
                        let (id, bytes, diary_name) = row.map_err(|error| {
                            Error::from_reason(format!(
                                "Decode native hybrid Chunk failed: {}",
                                error
                            ))
                        })?;
                        // 文件计划来自 JavaScript 控制面，但 Rust 数据面仍必须再次执行
                        // 本次已冻结日记作用域校验，禁止同路径或坏计划越权注入候选。
                        if !allowed_diaries.contains(diary_name.as_str())
                            || bytes.len() != self.dimension * 4
                        {
                            continue;
                        }
                        let vector: Vec<f32> = bytes
                            .chunks_exact(4)
                            .map(|chunk| {
                                f32::from_ne_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
                            })
                            .collect();
                        if vector.iter().any(|value| !value.is_finite()) {
                            continue;
                        }
                        let vector_score = cosine_similarity(&self.query, &vector);
                        let normalized_bm25 = file_candidate.normalized_bm25_score.clamp(0.0, 1.0);
                        let bm25_score = file_candidate.bm25_score.max(0.0);
                        let time_score = file_candidate.time_score.max(0.0);
                        let hybrid_score = if bm25_score > 0.0 {
                            normalized_bm25 * sparse_weight + vector_score * (1.0 - sparse_weight)
                        } else {
                            vector_score
                        };
                        let source = if file_candidate.source.trim().is_empty() {
                            if bm25_score > 0.0 {
                                "bm25"
                            } else {
                                "time"
                            }
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
                            let diary_pool = pending_time_by_diary.entry(diary_name).or_default();
                            let entry = diary_pool.entry(id).or_insert_with(|| incoming.clone());
                            entry.score = entry.score.max(incoming.score);
                            entry.vector_score = entry.vector_score.max(incoming.vector_score);
                            entry.bm25_score = entry.bm25_score.max(incoming.bm25_score);
                            entry.time_score = entry.time_score.max(incoming.time_score);
                            entry.sources.extend(incoming.sources);
                        } else {
                            let entry = merged.entry(id).or_insert_with(|| incoming.clone());
                            entry.score = entry.score.max(incoming.score);
                            entry.vector_score = entry.vector_score.max(incoming.vector_score);
                            entry.bm25_score = entry.bm25_score.max(incoming.bm25_score);
                            entry.sources.extend(incoming.sources);
                            if bm25_score > 0.0 {
                                bm25_chunk_candidates += 1;
                            }
                        }
                    }
                }

                // 先执行每日记本硬上限，再执行全局硬上限。
                let (limited_time_candidates, before_limit, _, _) = limit_time_candidates(
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
                    entry.vector_score = entry.vector_score.max(incoming.vector_score);
                    entry.bm25_score = entry.bm25_score.max(incoming.bm25_score);
                    entry.time_score = entry.time_score.max(incoming.time_score);
                    entry.sources.extend(incoming.sources);
                }
                Ok(())
            })?;
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
            let deduplicated = result_deduplicator::deduplicate_with_connection(
                connection.ok_or_else(|| Error::from_reason("Query read transaction unavailable"))?,
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
        let hydrated_chunks = if self.semantic_dedup.is_none() {
            if let Some(db_path) = &self.db_path {
                with_query_connection(connection, db_path, |connection| {
                    let mut statement = connection.prepare(
                        "SELECT c.content, f.path, f.diary_name, f.id
                         FROM chunks c JOIN files f ON f.id=c.file_id WHERE c.id=?1",
                    ).map_err(|error| Error::from_reason(error.to_string()))?;
                    let mut rows = Vec::with_capacity(results.len());
                    for candidate in &results {
                        let row = statement.query_row([candidate.id], |row| {
                            Ok(serde_json::json!({
                                "id": candidate.id, "chunkId": candidate.id,
                                "text": row.get::<_, String>(0)?,
                                "sourceFile": row.get::<_, String>(1)?,
                                "diaryName": row.get::<_, String>(2)?,
                                "fileId": row.get::<_, i64>(3)?
                            }))
                        }).optional().map_err(|error| Error::from_reason(error.to_string()))?;
                        if let Some(row) = row { rows.push(row); }
                    }
                    Ok(rows)
                })?
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        };

        serde_json::to_string(&NativeAnnOutput {
            hydrated_chunks,
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
            Error::from_reason(format!(
                "Encode native multi-index ANN result failed: {}",
                error
            ))
        })
    }

}

fn with_query_connection<T>(
    connection: Option<&rusqlite::Connection>,
    db_path: &str,
    operation: impl FnOnce(&rusqlite::Connection) -> Result<T>,
) -> Result<T> {
    match connection {
        Some(connection) => operation(connection),
        None => with_registered_read_napi(db_path, operation),
    }
}

fn recover_diary_snapshot(
    db_path: &str,
    snapshot: &DiarySearchSnapshot,
    dimension: usize,
) -> std::result::Result<(), String> {
    recover_index_snapshot(
        db_path, format!("diary:{}", snapshot.diary_name),
        Some(&snapshot.diary_name), &snapshot.index, &snapshot.content_revision, dimension,
    )
}

// Caller holds the publication gate through recovery and subsequent query.
pub(crate) fn recover_index_snapshot(
    db_path: &str,
    scope: String,
    diary_name: Option<&str>,
    index: &Arc<crate::index_handle::IndexHandle>,
    content_revision: &Arc<AtomicU64>,
    dimension: usize,
) -> std::result::Result<(), String> {
    let state_scope = scope.clone();
    with_registered_write(db_path, move |tx| {
        tx.execute(
            "UPDATE kbm_index_states SET state='recovering' WHERE scope=?1",
            [&state_scope],
        ).map_err(|error| error.to_string())?;
        Ok(crate::storage::WriteReceipt {
            operation: "begin_index_recovery".to_string(),
            database_generation: 0, facts_changed: false,
        })
    })?;
    let (recovered_generation, build) =
        crate::storage::with_registered_read_transaction(db_path, |connection| {
            let generation: i64 = connection.query_row(
                "SELECT facts_generation FROM kbm_index_states WHERE scope=?1 AND state='recovering'",
                [&scope], |row| row.get(0),
            ).map_err(|error| format!("Read recovery generation failed: {}", error))?;
            let build = crate::index_source::build_memory_from_connection(
                connection, diary_name, dimension, "unendorsed-runtime-recovery",
            )?;
            Ok((generation, build))
        })?;
    let skipped_invalid_vectors = build.skipped_invalid;
    let replacement = Index::from_sql(build);
    if skipped_invalid_vectors > 0 {
        eprintln!("[KBM] Recovery for '{}' skipped {} invalid vectors", scope, skipped_invalid_vectors);
    }
    let recovery_warning = (skipped_invalid_vectors > 0).then(|| serde_json::json!({
        "skippedInvalidVectors": skipped_invalid_vectors
    }).to_string());
    {
        let mut active = index.write()
            .map_err(|_| "Replacement index lock poisoned".to_string())?;
        *active = replacement;
        content_revision.fetch_add(1, Ordering::AcqRel);
    }
    with_registered_write(db_path, move |tx| {
        let published = tx.execute(
            "UPDATE kbm_index_states SET state='ready',
             applied_generation=?2, error_message=?3
             WHERE scope=?1 AND state='recovering' AND facts_generation=?2",
            rusqlite::params![scope, recovered_generation, recovery_warning],
        ).map_err(|error| error.to_string())?;
        if published != 1 {
            return Err("KBM_INDEX_NOT_READY: facts changed during index recovery".to_string());
        }
        Ok(crate::storage::WriteReceipt {
            operation: "complete_index_recovery".to_string(),
            database_generation: 0, facts_changed: false,
        })
    })?;
    Ok(())
}

pub(crate) fn ensure_index_scopes_ready(db_path: &str, scopes: &[String]) -> std::result::Result<(), String> {
    if scopes.is_empty() {
        return Ok(());
    }
    let requested = scopes.to_vec();
    crate::storage::with_registered_read(db_path, move |connection| {
        let mut statement = connection
            .prepare(
                "SELECT scope, state, facts_generation, applied_generation
                 FROM kbm_index_states
                 WHERE scope = ?1",
            )
            .map_err(|error| format!("prepare KBM index gate failed: {}", error))?;
        for scope in requested {
            let row = statement
                .query_row([&scope], |row| {
                    Ok((
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                })
                .optional()
                .map_err(|error| format!("read KBM index gate failed: {}", error))?;
            if let Some((state, facts_generation, applied_generation)) = row {
                if state != "ready" || facts_generation != applied_generation {
                    return Err(format!(
                        "KBM_INDEX_NOT_READY: scope '{}', state '{}', factsGeneration={}, appliedGeneration={}",
                        scope, state, facts_generation, applied_generation
                    ));
                }
            }
        }
        Ok(())
    })
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

#[derive(Debug)]
pub struct DiaryDateIndexTask {
    pub(crate) db_path: String,
    pub(crate) diary_name: String,
}

impl Task for DiaryDateIndexTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let diary_name = self.diary_name.clone();
        let rows = with_registered_read_napi(&self.db_path, move |connection| {
            let mut statement = connection
                .prepare(
                    "SELECT f.path, c.content
                     FROM files f
                     JOIN chunks c ON c.file_id = f.id AND c.chunk_index = 0
                     WHERE f.diary_name = ?1
                     ORDER BY f.path ASC",
                )
                .map_err(|error| {
                    Error::from_reason(format!(
                        "Prepare diary date index query failed: {}",
                        error
                    ))
                })?;
            let mapped = statement
                .query_map([diary_name.as_str()], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                    ))
                })
                .map_err(|error| {
                    Error::from_reason(format!(
                        "Query diary date index rows failed: {}",
                        error
                    ))
                })?;

            let mut items = Vec::new();
            for row in mapped {
                let (relative_path, content) = row.map_err(|error| {
                    Error::from_reason(format!(
                        "Decode diary date index row failed: {}",
                        error
                    ))
                })?;
                if let Some(date) = parse_diary_date(content.lines().next().unwrap_or_default()) {
                    items.push(serde_json::json!({
                        "relativePath": relative_path,
                        "date": date,
                    }));
                }
            }
            Ok(items)
        })?;

        serde_json::to_string(&rows).map_err(|error| {
            Error::from_reason(format!(
                "Encode diary date index result failed: {}",
                error
            ))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

fn parse_diary_date(first_line: &str) -> Option<String> {
    // 保持旧 JS 正则的锚定语义：只允许行首日期，可选左方括号；
    // 不做 trim_start，避免把原本无效的缩进行误识别为日记日期。
    let value = first_line.strip_prefix('[').unwrap_or(first_line);
    let bytes = value.as_bytes();
    if bytes.len() < 10 {
        return None;
    }

    // 先验证 ASCII 字节，再把前 10 个字节转换为字符串，避免在多字节
    // Unicode 首行上直接执行 &value[..10] 造成 Rust 字符串切片 panic。
    let date_bytes = &bytes[..10];
    let valid_separators =
        (date_bytes[4] == b'-' || date_bytes[4] == b'.')
            && (date_bytes[7] == b'-' || date_bytes[7] == b'.');
    let valid_digits = date_bytes[..4].iter().all(u8::is_ascii_digit)
        && date_bytes[5..7].iter().all(u8::is_ascii_digit)
        && date_bytes[8..10].iter().all(u8::is_ascii_digit);
    if !valid_separators || !valid_digits {
        return None;
    }

    let date = std::str::from_utf8(date_bytes).ok()?;
    Some(date.replace('.', "-"))
}

#[derive(Debug)]
pub struct ChunkVectorLookupTask {
    pub(crate) db_path: String,
    pub(crate) chunk_id: i64,
    pub(crate) dimension: usize,
}

impl Task for ChunkVectorLookupTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let row = with_registered_read_napi(&self.db_path, |connection| {
            connection
                .query_row(
                    "SELECT vector FROM chunks WHERE id = ?1 LIMIT 1",
                    [self.chunk_id],
                    |row| row.get::<_, Option<Vec<u8>>>(0),
                )
                .optional()
                .map_err(|error| {
                    Error::from_reason(format!(
                        "Query Chunk vector failed for {}: {}",
                        self.chunk_id, error
                    ))
                })
        })?;

        let Some(Some(bytes)) = row else {
            return Ok("null".to_string());
        };
        if bytes.len() != self.dimension * std::mem::size_of::<f32>() {
            return Ok("null".to_string());
        }

        let vector: Vec<f32> = bytes
            .chunks_exact(std::mem::size_of::<f32>())
            .map(|chunk| f32::from_ne_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            .collect();
        if vector.iter().any(|value| !value.is_finite()) {
            return Ok("null".to_string());
        }

        serde_json::to_string(&base64::engine::general_purpose::STANDARD.encode(bytes))
            .map_err(|error| {
                Error::from_reason(format!(
                    "Encode Chunk vector result failed for {}: {}",
                    self.chunk_id, error
                ))
            })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[derive(Debug)]
pub struct ChunkVectorByTextLookupTask {
    pub(crate) db_path: String,
    pub(crate) diary_name: String,
    pub(crate) text: String,
    pub(crate) dimension: usize,
}

impl Task for ChunkVectorByTextLookupTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let row = with_registered_read_napi(&self.db_path, |connection| {
            let result = if self.diary_name.trim().is_empty() {
                connection.query_row(
                    "SELECT c.vector
                     FROM chunks c
                     WHERE c.content = ?1
                     ORDER BY c.id
                     LIMIT 1",
                    [&self.text],
                    |row| row.get::<_, Option<Vec<u8>>>(0),
                )
            } else {
                connection.query_row(
                    "SELECT c.vector
                     FROM chunks c
                     JOIN files f ON f.id = c.file_id
                     WHERE c.content = ?1 AND f.diary_name = ?2
                     ORDER BY c.id
                     LIMIT 1",
                    rusqlite::params![&self.text, &self.diary_name],
                    |row| row.get::<_, Option<Vec<u8>>>(0),
                )
            };
            result.optional().map_err(|error| {
                Error::from_reason(format!(
                    "Query Chunk vector by text failed: {}",
                    error
                ))
            })
        })?;

        let Some(Some(bytes)) = row else {
            return Ok("null".to_string());
        };
        if bytes.len() != self.dimension * std::mem::size_of::<f32>() {
            return Ok("null".to_string());
        }

        let vector: Vec<f32> = bytes
            .chunks_exact(std::mem::size_of::<f32>())
            .map(|chunk| f32::from_ne_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            .collect();
        if vector.iter().any(|value| !value.is_finite()) {
            return Ok("null".to_string());
        }

        Ok(serde_json::to_string(
            &base64::engine::general_purpose::STANDARD.encode(bytes),
        )
        .map_err(|error| {
            Error::from_reason(format!(
                "Encode Chunk vector by text result failed: {}",
                error
            ))
        })?)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[derive(Debug)]
pub struct TagVectorByNameLookupTask {
    pub(crate) db_path: String,
    pub(crate) tag_name: String,
    pub(crate) dimension: usize,
}

impl Task for TagVectorByNameLookupTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let tag_name = self.tag_name.clone();
        let row = with_registered_read_napi(&self.db_path, move |connection| {
            connection
                .query_row(
                    "SELECT vector FROM tags WHERE name = ?1 LIMIT 1",
                    rusqlite::params![tag_name],
                    |row| row.get::<_, Option<Vec<u8>>>(0),
                )
                .optional()
                .map_err(|error| {
                    Error::from_reason(format!("Query Tag vector by name failed: {}", error))
                })
        })?;

        let Some(Some(bytes)) = row else {
            return Ok("null".to_string());
        };
        if bytes.len() != self.dimension * std::mem::size_of::<f32>() {
            return Ok("null".to_string());
        }

        let vector: Vec<f32> = bytes
            .chunks_exact(std::mem::size_of::<f32>())
            .map(|chunk| f32::from_ne_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            .collect();
        if vector.iter().any(|value| !value.is_finite()) {
            return Ok("null".to_string());
        }

        serde_json::to_string(&base64::engine::general_purpose::STANDARD.encode(bytes))
            .map_err(|error| {
                Error::from_reason(format!("Encode Tag vector by name result failed: {}", error))
            })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[derive(Debug)]
pub struct KvVectorLookupTask {
    pub(crate) db_path: String,
    pub(crate) key: String,
}

impl Task for KvVectorLookupTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let key = self.key.clone();
        let value = with_registered_read_napi(&self.db_path, move |connection| {
            connection
                .query_row(
                    "SELECT vector FROM kv_store WHERE key = ?1 LIMIT 1",
                    rusqlite::params![key],
                    |row| row.get::<_, Option<Vec<u8>>>(0),
                )
                .optional()
                .map_err(|error| {
                    Error::from_reason(format!("Query KV vector failed: {}", error))
                })
        })?;

        let Some(Some(bytes)) = value else {
            return Ok("null".to_string());
        };

        serde_json::to_string(&base64::engine::general_purpose::STANDARD.encode(bytes))
            .map_err(|error| {
                Error::from_reason(format!("Encode KV vector result failed: {}", error))
            })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[derive(Debug)]
pub struct KvVectorWriteTask {
    pub(crate) db_path: String,
    pub(crate) key: String,
    pub(crate) vector: Vec<f32>,
}

impl Task for KvVectorWriteTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let _guard = crate::publication_gate::acquire(&self.db_path, &[String::from("*")])
            .map_err(Error::from_reason)?;
        let key = self.key.clone();
        let vector = self.vector.clone();
        let receipt = with_registered_write(&self.db_path, move |transaction| {
            let mut bytes = Vec::with_capacity(vector.len() * std::mem::size_of::<f32>());
            for value in vector {
                if !value.is_finite() {
                    return Err("KV vector contains a non-finite value".to_string());
                }
                bytes.extend_from_slice(&value.to_ne_bytes());
            }

            transaction
                .execute(
                    "INSERT INTO kv_store (key, vector) VALUES (?1, ?2) \
                     ON CONFLICT(key) DO UPDATE SET vector = excluded.vector",
                    rusqlite::params![key, bytes],
                )
                .map_err(|error| format!("Write KV vector failed: {}", error))?;

            Ok(crate::storage::WriteReceipt {
                operation: "set_kv_vector".to_string(),
                database_generation: 0,
                facts_changed: false,
            })
        })
        .map_err(|error| {
            Error::from_reason(format!("KV vector Write Actor commit failed: {}", error))
        })?;

        serde_json::to_string(&serde_json::json!({
            "ok": true,
            "operation": receipt.operation,
            "databaseGeneration": receipt.database_generation
        }))
        .map_err(|error| Error::from_reason(format!("Encode KV vector receipt failed: {}", error)))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[derive(Debug)]
pub struct KvVectorListTask {
    pub(crate) db_path: String,
    pub(crate) prefix: String,
}

impl Task for KvVectorListTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let prefix = self.prefix.clone();
        let rows = with_registered_read_napi(&self.db_path, move |connection| {
            let escaped_prefix = prefix
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            let pattern = format!("{}%", escaped_prefix);
            let mut statement = connection
                .prepare(
                    "SELECT key, vector FROM kv_store \
                     WHERE key LIKE ?1 ESCAPE '\\' AND vector IS NOT NULL \
                     ORDER BY key LIMIT 10000",
                )
                .map_err(|error| {
                    Error::from_reason(format!("Prepare KV vector list failed: {}", error))
                })?;
            let mapped = statement
                .query_map(rusqlite::params![pattern], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<Vec<u8>>>(1)?,
                    ))
                })
                .map_err(|error| {
                    Error::from_reason(format!("Query KV vector list failed: {}", error))
                })?;

            let mut values = Vec::new();
            for row in mapped {
                let (key, vector) = row.map_err(|error| {
                    Error::from_reason(format!("Decode KV vector list row failed: {}", error))
                })?;
                if !key.starts_with(&prefix) {
                    continue;
                }
                if let Some(bytes) = vector {
                    values.push(serde_json::json!({
                        "key": key,
                        "vector": base64::engine::general_purpose::STANDARD.encode(bytes),
                    }));
                }
            }
            Ok(values)
        })?;

        serde_json::to_string(&rows).map_err(|error| {
            Error::from_reason(format!("Encode KV vector list failed: {}", error))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[derive(Debug)]
pub struct ChunkHydrateTask {
    pub(crate) db_path: String,
    pub(crate) ids: Vec<i64>,
}

impl Task for ChunkHydrateTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        if self.ids.is_empty() {
            return Ok("[]".to_string());
        }

        let requested_ids = self.ids.clone();
        let rows = with_registered_read_napi(&self.db_path, move |connection| {
            let placeholders = std::iter::repeat("?")
                .take(requested_ids.len())
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "SELECT c.id, c.content AS text, c.vector, \
                        f.path AS sourceFile, f.diary_name AS diaryName, f.id AS fileId \
                 FROM chunks c JOIN files f ON f.id = c.file_id \
                 WHERE c.id IN ({})",
                placeholders
            );
            let mut statement = connection.prepare(&sql).map_err(|error| {
                Error::from_reason(format!("Prepare chunk hydrate query failed: {}", error))
            })?;
            let mapped = statement
                .query_map(rusqlite::params_from_iter(requested_ids.iter()), |row| {
                    let vector: Option<Vec<u8>> = row.get(2)?;
                    Ok(serde_json::json!({
                        "id": row.get::<_, i64>(0)?,
                        "text": row.get::<_, String>(1)?,
                        "vector": vector.map(|bytes|
                            base64::engine::general_purpose::STANDARD.encode(bytes)
                        ),
                        "sourceFile": row.get::<_, String>(3)?,
                        "diaryName": row.get::<_, String>(4)?,
                        "fileId": row.get::<_, i64>(5)?
                    }))
                })
                .map_err(|error| {
                    Error::from_reason(format!("Query chunk hydrate rows failed: {}", error))
                })?;

            let mut by_id = HashMap::new();
            for row in mapped {
                let value = row.map_err(|error| {
                    Error::from_reason(format!("Decode chunk hydrate row failed: {}", error))
                })?;
                if let Some(id) = value.get("id").and_then(serde_json::Value::as_i64) {
                    by_id.insert(id, value);
                }
            }

            Ok(requested_ids
                .into_iter()
                .filter_map(|id| by_id.remove(&id))
                .collect::<Vec<_>>())
        })?;

        serde_json::to_string(&rows).map_err(|error| {
            Error::from_reason(format!("Encode chunk hydrate result failed: {}", error))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[derive(Debug)]
pub struct TagNameHydrateTask {
    pub(crate) db_path: String,
    pub(crate) ids: Vec<i64>,
}

impl Task for TagNameHydrateTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        if self.ids.is_empty() {
            return Ok("[]".to_string());
        }

        let requested_ids = self.ids.clone();
        let rows = with_registered_read_napi(&self.db_path, move |connection| {
            let placeholders = std::iter::repeat("?")
                .take(requested_ids.len())
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "SELECT id, name FROM tags WHERE id IN ({})",
                placeholders
            );
            let mut statement = connection.prepare(&sql).map_err(|error| {
                Error::from_reason(format!("Prepare Tag name hydrate query failed: {}", error))
            })?;
            let mapped = statement
                .query_map(rusqlite::params_from_iter(requested_ids.iter()), |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, i64>(0)?,
                        "name": row.get::<_, String>(1)?
                    }))
                })
                .map_err(|error| {
                    Error::from_reason(format!("Query Tag name hydrate rows failed: {}", error))
                })?;

            let mut by_id = HashMap::new();
            for row in mapped {
                let value = row.map_err(|error| {
                    Error::from_reason(format!("Decode Tag name hydrate row failed: {}", error))
                })?;
                if let Some(id) = value.get("id").and_then(serde_json::Value::as_i64) {
                    by_id.insert(id, value);
                }
            }

            Ok(requested_ids
                .into_iter()
                .filter_map(|id| by_id.remove(&id))
                .collect::<Vec<_>>())
        })?;

        serde_json::to_string(&rows).map_err(|error| {
            Error::from_reason(format!("Encode Tag name hydrate result failed: {}", error))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[derive(Debug)]
pub struct ChunkPathHydrateTask {
    pub(crate) db_path: String,
    pub(crate) paths: Vec<String>,
}

impl Task for ChunkPathHydrateTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        if self.paths.is_empty() {
            return Ok("[]".to_string());
        }

        let requested_paths = self.paths.clone();
        let rows = with_registered_read_napi(&self.db_path, move |connection| {
            let placeholders = std::iter::repeat("?")
                .take(requested_paths.len())
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "SELECT c.id, c.content AS text, c.vector, \
                        f.path AS sourceFile, f.diary_name AS diaryName, f.id AS fileId \
                 FROM chunks c JOIN files f ON f.id = c.file_id \
                 WHERE f.path IN ({}) \
                 ORDER BY f.path ASC, c.id ASC",
                placeholders
            );
            let mut statement = connection.prepare(&sql).map_err(|error| {
                Error::from_reason(format!(
                    "Prepare path chunk hydrate query failed: {}",
                    error
                ))
            })?;
            let mapped = statement
                .query_map(rusqlite::params_from_iter(requested_paths.iter()), |row| {
                    let vector: Option<Vec<u8>> = row.get(2)?;
                    Ok(serde_json::json!({
                        "id": row.get::<_, i64>(0)?,
                        "text": row.get::<_, String>(1)?,
                        "vector": vector.map(|bytes|
                            base64::engine::general_purpose::STANDARD.encode(bytes)
                        ),
                        "sourceFile": row.get::<_, String>(3)?,
                        "diaryName": row.get::<_, String>(4)?,
                        "fileId": row.get::<_, i64>(5)?
                    }))
                })
                .map_err(|error| {
                    Error::from_reason(format!("Query path chunk hydrate rows failed: {}", error))
                })?;

            let mut grouped: HashMap<String, Vec<serde_json::Value>> = HashMap::new();
            for row in mapped {
                let value = row.map_err(|error| {
                    Error::from_reason(format!("Decode path chunk hydrate row failed: {}", error))
                })?;
                let path = value
                    .get("sourceFile")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                grouped.entry(path).or_default().push(value);
            }

            let mut output = Vec::new();
            for path in requested_paths {
                if let Some(mut path_rows) = grouped.remove(&path) {
                    output.append(&mut path_rows);
                }
            }
            Ok(output)
        })?;

        serde_json::to_string(&rows).map_err(|error| {
            Error::from_reason(format!("Encode path chunk hydrate result failed: {}", error))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}
#[derive(Debug)]
pub struct DiaryListTask {
    pub(crate) db_path: String,
}

impl Task for DiaryListTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let rows = with_registered_read_napi(&self.db_path, |connection| {
            let mut statement = connection
                .prepare(
                    "SELECT DISTINCT diary_name FROM files \
                     WHERE diary_name IS NOT NULL AND diary_name <> '' \
                     ORDER BY diary_name",
                )
                .map_err(|error| {
                    Error::from_reason(format!("Prepare diary list query failed: {}", error))
                })?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| {
                    Error::from_reason(format!("Query diary list failed: {}", error))
                })?;
            rows.collect::<rusqlite::Result<Vec<String>>>()
                .map_err(|error| Error::from_reason(format!("Decode diary list failed: {}", error)))
        })?;

        serde_json::to_string(&rows)
            .map_err(|error| Error::from_reason(format!("Encode diary list failed: {}", error)))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[derive(Debug)]
pub struct FileIdsByDiariesTask {
    pub(crate) db_path: String,
    pub(crate) names: Vec<String>,
}

impl Task for FileIdsByDiariesTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        if self.names.is_empty() {
            return Ok("[]".to_string());
        }

        let names = self.names.clone();
        let rows = with_registered_read_napi(&self.db_path, move |connection| {
            let placeholders = std::iter::repeat("?")
                .take(names.len())
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "SELECT id FROM files WHERE diary_name IN ({}) ORDER BY id",
                placeholders
            );
            let mut statement = connection.prepare(&sql).map_err(|error| {
                Error::from_reason(format!("Prepare file scope query failed: {}", error))
            })?;
            let rows = statement
                .query_map(rusqlite::params_from_iter(names.iter()), |row| {
                    row.get::<_, i64>(0)
                })
                .map_err(|error| {
                    Error::from_reason(format!("Query file scope failed: {}", error))
                })?;
            rows.collect::<rusqlite::Result<Vec<i64>>>()
                .map_err(|error| Error::from_reason(format!("Decode file scope failed: {}", error)))
        })?;

        serde_json::to_string(&rows)
            .map_err(|error| Error::from_reason(format!("Encode file scope failed: {}", error)))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct CancelPreparedPlanTask {
    db_path: String,
    token: String,
}

impl Task for CancelPreparedPlanTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<String> {
        let token = self.token.clone();
        let receipt = with_registered_write(&self.db_path, move |tx| {
            let changed = tx.execute(
                "UPDATE kbm_prepared_plans SET status='cancelled'
                 WHERE token=?1 AND status='prepared'",
                [&token],
            ).map_err(|error| error.to_string())?;
            Ok(crate::storage::WriteReceipt {
                operation: if changed > 0 { "cancelled" } else { "unchanged" }.to_string(),
                database_generation: 0,
                facts_changed: false,
            })
        }).map_err(Error::from_reason)?;
        Ok(serde_json::json!({
            "token": self.token,
            "cancelled": receipt.operation == "cancelled"
        }).to_string())
    }

    fn resolve(&mut self, _env: Env, output: String) -> Result<String> {
        Ok(output)
    }
}

#[derive(Debug)]
pub struct IndexedFilePathsTask {
    pub(crate) db_path: String,
}

impl Task for IndexedFilePathsTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let paths = with_registered_read_napi(&self.db_path, |connection| {
            let mut statement = connection
                .prepare(
                    "SELECT path FROM files
                     WHERE path IS NOT NULL AND path <> ''
                     ORDER BY path",
                )
                .map_err(|error| {
                    Error::from_reason(format!(
                        "Prepare indexed file path snapshot failed: {}",
                        error
                    ))
                })?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| {
                    Error::from_reason(format!(
                        "Query indexed file path snapshot failed: {}",
                        error
                    ))
                })?;
            let mut paths = Vec::new();
            for row in rows {
                let path = row.map_err(|error| {
                    Error::from_reason(format!(
                        "Decode indexed file path snapshot failed: {}",
                        error
                    ))
                })?;
                if !path.trim().is_empty() {
                    paths.push(path);
                }
            }
            Ok(paths)
        })?;

        serde_json::to_string(&paths).map_err(|error| {
            Error::from_reason(format!(
                "Encode indexed file path snapshot failed: {}",
                error
            ))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[derive(Debug)]
pub struct HealthCheckTask {
    pub(crate) db_path: String,
}

impl Task for HealthCheckTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        if self.db_path.trim().is_empty() {
            return Ok(serde_json::json!({
                "healthy": false,
                "state": "not_open",
                "databaseGeneration": 0
            })
            .to_string());
        }

        let health = with_registered_read_napi(&self.db_path, |connection| {
            let mut statement = connection.prepare("PRAGMA quick_check")
                .map_err(|error| Error::from_reason(format!(
                    "SQLite health prepare failed: {}", error
                )))?;
            let checks = statement.query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| Error::from_reason(format!(
                    "SQLite health query failed: {}", error
                )))?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|error| Error::from_reason(format!(
                    "SQLite health decode failed: {}", error
                )))?;
            let healthy = checks.len() == 1 && checks[0] == "ok";
            let database_generation: String = connection
                .query_row(
                    "SELECT value FROM kbm_runtime_meta \
                     WHERE key = 'database_generation'",
                    [],
                    |row| row.get(0),
                )
                .map_err(|error| {
                    Error::from_reason(format!(
                        "Read KBM database generation during health check failed: {}",
                        error
                    ))
                })?;

            Ok(serde_json::json!({
                "healthy": healthy,
                "state": if healthy { "healthy" } else { "corrupt" },
                "code": if healthy { "OK" } else { "KNOWLEDGE_STORE_CORRUPT" },
                "retryable": false,
                "integrityResults": checks,
                "databaseGeneration": database_generation.parse::<i64>().unwrap_or(0).max(0)
            }))
        }).unwrap_or_else(|error| {
            let message = error.reason.to_ascii_lowercase();
            let (state, code, retryable) = if message.contains("database disk image is malformed")
                || message.contains("file is not a database")
            {
                ("corrupt", "KNOWLEDGE_STORE_CORRUPT", false)
            } else if message.contains("locked") || message.contains("busy") {
                ("busy", "KNOWLEDGE_STORE_BUSY", true)
            } else if message.contains("closed") || message.contains("not_registered") {
                ("closed", "KNOWLEDGE_STORE_CLOSED", false)
            } else {
                ("suspect", "KNOWLEDGE_STORE_HEALTH_CHECK_FAILED", true)
            };
            serde_json::json!({
                "healthy": false, "state": state, "code": code,
                "retryable": retryable, "databaseGeneration": 0,
                "errorMessage": error.reason
            })
        });

        serde_json::to_string(&health).map_err(|error| {
            Error::from_reason(format!("Encode native health result failed: {}", error))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[derive(Debug)]
pub struct DiaryChunkCountTask {
    pub(crate) db_path: String,
    pub(crate) diary_name: String,
}

impl Task for DiaryChunkCountTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let diary_name = self.diary_name.clone();
        let count = with_registered_read_napi(&self.db_path, move |connection| {
            connection
                .query_row(
                    "SELECT COUNT(*) FROM chunks c \
                     JOIN files f ON f.id = c.file_id \
                     WHERE f.diary_name = ?1",
                    rusqlite::params![diary_name],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|error| {
                    Error::from_reason(format!("Query diary Chunk count failed: {}", error))
                })
        })?;

        serde_json::to_string(&serde_json::json!({
            "diaryName": self.diary_name,
            "count": count.max(0)
        }))
        .map_err(|error| {
            Error::from_reason(format!("Encode diary Chunk count failed: {}", error))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[derive(Debug)]
pub struct NativeMemoManifestLookupTask {
    pub(crate) db_path: String,
    pub(crate) model_sig: String,
    pub(crate) config_hash: String,
}

impl Task for NativeMemoManifestLookupTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let model_sig = self.model_sig.clone();
        let config_hash = self.config_hash.clone();
        let row = crate::storage::with_registered_read_transaction_napi(&self.db_path, move |connection| {
            connection
                .query_row(
                    "SELECT artifact_sig, algorithm_version, source_v9_artifact_sig,
                            source_graph_generation, model_sig, config_hash,
                            database_generation, provenance_generation,
                            node_count, edge_count, published_at,
                            COALESCE((SELECT CAST(value AS INTEGER) FROM kbm_runtime_meta
                                      WHERE key='memo_training_tag_count'), (SELECT COUNT(*) FROM tags)),
                            (SELECT COUNT(*) FROM kbm_memo_changed_tags)
                     FROM rivermemo_artifacts
                     WHERE model_sig = ?1
                       AND config_hash = ?2
                       AND algorithm_version = 'memo.native-artifact-v2-binary'
                       AND schema_version = 'rivermemo-persisted-artifact-v2'
                       AND status = 'ready'
                       AND payload IS NOT NULL
                       AND (SELECT COUNT(*) FROM kbm_artifact_dependencies d
                            WHERE d.artifact_sig=rivermemo_artifacts.artifact_sig
                              AND d.dependency_key IN (SELECT value FROM json_each(?3)))=?4
                       AND (SELECT COUNT(*) FROM kbm_artifact_dependencies d
                            WHERE d.artifact_sig=rivermemo_artifacts.artifact_sig)=?4
                       AND NOT EXISTS(
                         SELECT 1 FROM kbm_artifact_dependencies d
                         LEFT JOIN kbm_runtime_meta m ON m.key=d.dependency_key
                         WHERE d.artifact_sig=rivermemo_artifacts.artifact_sig
                           AND (m.value IS NULL
                                OR CAST(m.value AS INTEGER) < CAST(d.dependency_version AS INTEGER))
                       )
                     ORDER BY published_at DESC, updated_at DESC
                     LIMIT 1",
                    rusqlite::params![
                        model_sig,
                        config_hash,
                        serde_json::to_string(crate::storage::MEMO_ARTIFACT_DEPENDENCIES)
                            .map_err(|e| Error::from_reason(e.to_string()))?,
                        crate::storage::MEMO_ARTIFACT_DEPENDENCIES.len() as i64
                    ],
                    |row| {
                        Ok(serde_json::json!({
                            "artifactSig": row.get::<_, String>(0)?,
                            "algorithmVersion": row.get::<_, String>(1)?,
                            "sourceArtifactSig": row.get::<_, String>(2)?,
                            "sourceGraphGeneration": row.get::<_, String>(3)?,
                            "modelSig": row.get::<_, String>(4)?,
                            "configHash": row.get::<_, String>(5)?,
                            "databaseGeneration": row.get::<_, String>(6)?,
                            "provenanceGeneration": row.get::<_, String>(7)?,
                            "nodeCount": row.get::<_, i64>(8)?.max(0),
                            "edgeCount": row.get::<_, i64>(9)?.max(0),
                            "publishedAt": row.get::<_, Option<i64>>(10)?,
                            "trainingTagCount": row.get::<_, i64>(11)?.max(0),
                            "changedTagCount": row.get::<_, i64>(12)?.max(0)
                        }))
                    },
                )
                .optional()
                .map_err(|error| {
                    Error::from_reason(format!(
                        "Query native Memo artifact manifest failed: {}",
                        error
                    ))
                })
        })?;

        serde_json::to_string(&row).map_err(|error| {
            Error::from_reason(format!(
                "Encode native Memo artifact manifest failed: {}",
                error
            ))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[derive(Debug)]
pub struct NativeMemoArtifactPruneTask {
    pub(crate) db_path: String,
    pub(crate) retain_ready_artifacts: usize,
    pub(crate) failed_retention_ms: i64,
}

impl Task for NativeMemoArtifactPruneTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let _guard = crate::publication_gate::acquire(&self.db_path, &[String::from("*")])
            .map_err(Error::from_reason)?;
        let retain = self.retain_ready_artifacts.clamp(1, 1000) as i64;
        let retention_ms = self
            .failed_retention_ms
            .max(60 * 60 * 1000)
            .min(365_i64 * 24 * 60 * 60 * 1000);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_millis().min(i64::MAX as u128) as i64)
            .unwrap_or(0);
        let cutoff = now.saturating_sub(retention_ms);

        let receipt = with_registered_write(&self.db_path, move |transaction| {
            let retired = transaction
                .execute(
                    "UPDATE rivermemo_artifacts
                     SET status = 'retired',
                         payload = NULL,
                         payload_checksum = NULL,
                         updated_at = ?1
                     WHERE status = 'ready'
                       AND artifact_sig NOT IN (
                           SELECT artifact_sig
                           FROM rivermemo_artifacts
                           WHERE status = 'ready'
                           ORDER BY published_at DESC, updated_at DESC
                           LIMIT ?2
                       )",
                    rusqlite::params![now, retain],
                )
                .map_err(|error| {
                    format!("Retire old native Memo artifacts failed: {}", error)
                })?;
            let deleted = transaction
                .execute(
                    "DELETE FROM rivermemo_artifacts
                     WHERE status IN ('failed', 'retired')
                       AND updated_at < ?1",
                    rusqlite::params![cutoff],
                )
                .map_err(|error| {
                    format!("Delete expired native Memo artifacts failed: {}", error)
                })?;

            Ok(crate::storage::WriteReceipt {
                operation: format!(
                    "prune_rivermemo_artifacts;retired={};deleted={}",
                    retired, deleted
                ),
                database_generation: 0,
                facts_changed: false,
            })
        })
        .map_err(|error| {
            Error::from_reason(format!(
                "Native Memo artifact prune Write Actor commit failed: {}",
                error
            ))
        })?;

        let mut retired = 0_i64;
        let mut deleted = 0_i64;
        if let Some(summary) = receipt.operation.split(';').nth(1) {
            for item in summary.split(',') {
                let mut pair = item.split('=');
                match pair.next() {
                    Some("retired") => {
                        retired = pair.next().and_then(|value| value.parse().ok()).unwrap_or(0)
                    }
                    Some("deleted") => {
                        deleted = pair.next().and_then(|value| value.parse().ok()).unwrap_or(0)
                    }
                    _ => {}
                }
            }
        }

        serde_json::to_string(&serde_json::json!({
            "retired": retired,
            "deleted": deleted,
            "retainedReadyArtifacts": retain
        }))
        .map_err(|error| {
            Error::from_reason(format!(
                "Encode native Memo artifact prune receipt failed: {}",
                error
            ))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
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
        let mut scopes = self.ann_task.index_scopes.clone();
        scopes.push(String::from("global_tags"));
        let _publication_guard = self.ann_task.query_guard(&scopes)?;
        self.ann_task.prepare_indices()?;
        let db_path = self.db_path.clone();
        crate::storage::with_registered_read_transaction_napi(&db_path, |connection| {
            // 首次读取固定 WAL 快照；全部 SQL 阶段显式复用该连接。
            crate::storage::read_generation(connection).map_err(Error::from_reason)?;
            self.compute_with_connection(connection)
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

impl NativeRiverQueryTask {
    fn compute_with_connection(&mut self, connection: &rusqlite::Connection) -> Result<String> {
        let total_started = std::time::Instant::now();

        // 复用已验证的原生 ANN/合并/语义去重实现。此处只在 Rust 内解析其
        // 小型 ID/分数结果，不发生 N-API resolve，也不携带向量跨边界。
        let ann_payload = self.ann_task.compute_with_connection(Some(connection))?;
        let ann_output: serde_json::Value =
            serde_json::from_str(&ann_payload).map_err(|error| {
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

        let mut river_input: serde_json::Value = serde_json::from_str(&self.river_input_json)
            .map_err(|error| {
                Error::from_reason(format!("Decode native River query plan failed: {}", error))
            })?;
        let input_object = river_input.as_object_mut().ok_or_else(|| {
            Error::from_reason("Native River query plan root must be an object".to_string())
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

        let river_payload = rivermemo_topology_v3::run_native_with_connection(
            &self.runtime,
            connection,
            &self.artifact_sig,
            &serde_json::to_string(&river_input).map_err(|error| {
                Error::from_reason(format!("Encode native River query plan failed: {}", error))
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
        if let Some(results) = river_output.get_mut("results").and_then(serde_json::Value::as_array_mut) {
            let mut statement = connection.prepare(
                "SELECT c.content,f.path,f.diary_name,f.id FROM chunks c
                 JOIN files f ON f.id=c.file_id WHERE c.id=?1"
            ).map_err(|error| Error::from_reason(error.to_string()))?;
            for item in results {
                let Some(id) = item.get("chunkId").and_then(serde_json::Value::as_i64) else { continue; };
                let row = statement.query_row([id], |row| {
                    Ok(serde_json::json!({
                        "text": row.get::<_, String>(0)?,
                        "sourceFile": row.get::<_, String>(1)?,
                        "diaryName": row.get::<_, String>(2)?,
                        "fileId": row.get::<_, i64>(3)?
                    }))
                }).optional().map_err(|error| Error::from_reason(error.to_string()))?;
                if let (Some(object), Some(row)) = (item.as_object_mut(), row) {
                    object.insert("hydratedChunk".to_string(), row);
                }
            }
        }
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

}

#[napi]
pub struct NativeKnowledgeRuntime {
    dimension: u32,
    memo_runtime: Arc<MemoRuntime>,
    global_tag_index: Arc<crate::index_handle::IndexHandle>,
    global_tag_content_revision: Arc<AtomicU64>,
    diaries: RwLock<HashMap<String, RegisteredDiaryIndex>>,
    registry_generation: AtomicU64,
    accepting_queries: AtomicBool,
    storage: Mutex<Option<SqliteStorageEngine>>,
    watcher: Mutex<Option<VexusWatcher>>,
    tasks: Arc<TaskLifecycle>,
    global_chunks: Arc<Mutex<Option<crate::global_chunks::GlobalChunks>>>,
}

impl NativeKnowledgeRuntime {
    fn tracked_task<T: Task>(&self, task: T) -> AsyncTask<TrackedTask<T>> {
        AsyncTask::new(TrackedTask::new(&self.tasks, task))
    }

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
        let total_vectors = registered.index.cached_stats().0 as u32;
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
            global_tag_index: tag_index.index.clone(),
            global_tag_content_revision: tag_index.content_revision.clone(),
            diaries: RwLock::new(HashMap::new()),
            registry_generation: AtomicU64::new(0),
            accepting_queries: AtomicBool::new(true),
            storage: Mutex::new(None),
            watcher: Mutex::new(None),
            tasks: tag_index.tasks.clone(),
            global_chunks: Arc::new(Mutex::new(None)),
        })
    }

    /// 返回生产 KBM 数据面的 ABI 版本和必需能力。
    #[napi]
    pub fn capabilities(&self) -> NativeRuntimeCapabilities {
        NativeRuntimeCapabilities {
            abi_version: 2,
            dimension: self.dimension,
            capabilities: vec![
                "sqlite.storage-engine.v1".to_string(),
                "sqlite.write-actor.v1".to_string(),
                "sqlite.read-pool.v1".to_string(),
                "sqlite.schema-init.v1".to_string(),
                "sqlite.ingestion-commit.v1".to_string(),
                "sqlite.delete-commit.v1".to_string(),
                "sqlite.tag-consistency.v1".to_string(),
                "tag-consistency.prepare.v1".to_string(),
                "text.preparation.v1".to_string(),
                "index.async-restore.v1".to_string(),
                "index.dual-slot-checkpoint.v1".to_string(),
                "index.tdb-vec.v1".to_string(),
                "index.sql-authoritative-generational.v1".to_string(),
                "index.cosine-score.v1".to_string(),
                "watcher.runtime-owned.v1".to_string(),
                "memo.native-artifact.v1".to_string(),
                "river.native-query.v1".to_string(),
                "lightmemo.native-query.v1".to_string(),
            ],
        }
    }

    /// 打开并初始化中央 KBM SQLite 存储根。
    ///
    /// 现阶段只初始化 Runtime 元数据表；业务 Schema 迁移会在后续阶段
    /// 收归同一个 Write Actor，避免与旧 JS Schema 管理同时执行。
    #[napi]
    pub fn open_and_init_store(
        &self,
        db_path: String,
        options_json: Option<String>,
    ) -> Result<NativeStoreState> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() {
            return Err(Error::from_reason(
                "openAndInitStore requires a database path".to_string(),
            ));
        }

        let options_map = options_json
            .as_deref()
            .map(|value| {
                serde_json::from_str::<HashMap<String, i64>>(value).map_err(|error| {
                    Error::from_reason(format!("Invalid storage options JSON: {}", error))
                })
            })
            .transpose()?;
        let options: StorageOptions = normalize_storage_options(options_map);

        // 同一个 Runtime 的存储替换必须先关闭旧 Engine，再打开新 Engine。
        // 否则新连接会在注册前执行 schema/WAL/quick_check，期间可能与旧
        // Write Actor 并存；注册失败时还会留下无法表达的半替换状态。
        self.tasks.wait_idle();
        *self.global_chunks.lock().map_err(|_| {
            Error::from_reason("Global Chunk table lock poisoned")
        })? = None;
        let mut storage = self.storage.lock().map_err(|_| {
            Error::from_reason("NativeKnowledgeRuntime storage lock poisoned".to_string())
        })?;
        if let Some(previous) = storage.take() {
            previous.shutdown().map_err(Error::from_reason)?;
        }
        let (engine, ready) =
            SqliteStorageEngine::open_and_init(&db_path, options).map_err(Error::from_reason)?;
        let state = NativeStoreState {
            db_path: ready.db_path,
            schema_version: ready.schema_version,
            database_generation: ready.database_generation as i64,
            accepting_writes: true,
        };
        *storage = Some(engine);
        Ok(state)
    }

    fn storage_snapshot(&self) -> Result<Option<SqliteStorageEngine>> {
        self.storage
            .lock()
            .map(|storage| storage.clone())
            .map_err(|_| {
                Error::from_reason("NativeKnowledgeRuntime storage lock poisoned".to_string())
            })
    }

    #[napi]
    pub fn execute_light_memo_query(&self, plan_json: String, query: Float32Array)
        -> Result<AsyncTask<TrackedTask<crate::light_memo::LightMemoTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason("KNOWLEDGE_STORE_CLOSED"));
        }
        if plan_json.len() > 1024 * 1024 || query.len() != self.dimension as usize {
            return Err(Error::from_reason("LIGHTMEMO_INVALID_PLAN"));
        }
        let storage = self.storage_snapshot()?
            .ok_or_else(|| Error::from_reason("KNOWLEDGE_STORE_NOT_OPEN"))?;
        Ok(self.tracked_task(crate::light_memo::LightMemoTask {
            db_path: storage.db_path().to_string_lossy().into_owned(),
            dimension: self.dimension as usize,
            query: query.to_vec(),
            plan_json,
            table: self.global_chunks.clone(),
            runtime: self.memo_runtime.clone(),
        }))
    }

    /// Publication is scheduled independently from retrieval and never rebuilds
    /// an evicted table merely to save it.
    #[napi]
    pub fn checkpoint_global_chunk_index(
        &self, model_sig: String, threshold: f64, allow_initial: Option<bool>,
    ) -> Result<AsyncTask<TrackedTask<crate::light_memo::GlobalChunkCheckpointTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason("KNOWLEDGE_STORE_CLOSED"));
        }
        if model_sig.trim().is_empty() || !threshold.is_finite()
            || !(0.0..=1.0).contains(&threshold) {
            return Err(Error::from_reason("Invalid global Chunk checkpoint policy"));
        }
        let storage = self.storage_snapshot()?
            .ok_or_else(|| Error::from_reason("KNOWLEDGE_STORE_NOT_OPEN"))?;
        Ok(self.tracked_task(crate::light_memo::GlobalChunkCheckpointTask {
            db_path: storage.db_path().to_string_lossy().into_owned(),
            dimension: self.dimension as usize,
            model: model_sig,
            threshold,
            allow_initial: allow_initial.unwrap_or(false),
            table: self.global_chunks.clone(),
        }))
    }

    #[napi]
    pub fn light_memo_index_stats(&self) -> Result<String> {
        match self.global_chunks.try_lock() {
            Ok(slot) => Ok(match slot.as_ref() {
                Some(table) => serde_json::json!({
                    "resident": true, "chunks": table.rows.len(),
                    "idleMs": table.last_used.elapsed().as_millis() as u64,
                    "storageMode": "rust-sm-flat", "f32Resident": false
                }),
                None => serde_json::json!({
                    "resident": false, "chunks": 0, "f32Resident": false
                }),
            }.to_string()),
            Err(std::sync::TryLockError::WouldBlock) =>
                Ok(serde_json::json!({"busy": true}).to_string()),
            Err(_) => Err(Error::from_reason("Global Chunk table lock poisoned")),
        }
    }

    /// Never wait for a query lock on the Node main thread.
    #[napi]
    pub fn evict_idle_light_memo_index(&self, ttl_ms: u32) -> Result<bool> {
        match self.global_chunks.try_lock() {
            Ok(mut slot) => {
                if slot.as_ref().is_some_and(|table|
                    table.last_used.elapsed().as_millis() >= ttl_ms.max(1) as u128) {
                    *slot = None;
                    return Ok(true);
                }
                Ok(false)
            }
            Err(std::sync::TryLockError::WouldBlock) => Ok(false),
            Err(_) => Err(Error::from_reason("Global Chunk table lock poisoned")),
        }
    }

    #[napi]
    pub fn search_global_tags(&self, query: Float32Array, limit: u32)
        -> Result<AsyncTask<TrackedTask<GlobalTagSearchTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason("NativeKnowledgeRuntime is shutting down"));
        }
        if query.len() != self.dimension as usize || query.iter().any(|value| !value.is_finite()) {
            return Err(Error::from_reason("Invalid global Tag query vector"));
        }
        let storage = self.storage_snapshot()?.ok_or_else(|| Error::from_reason("KNOWLEDGE_STORE_NOT_OPEN"))?;
        Ok(self.tracked_task(GlobalTagSearchTask {
            db_path: storage.db_path().to_string_lossy().into_owned(),
            memo_runtime: self.memo_runtime.clone(),
            index: self.global_tag_index.clone(),
            content_revision: self.global_tag_content_revision.clone(),
            dimension: self.dimension as usize,
            query: query.to_vec(),
            limit: limit.clamp(1, 1000) as usize,
        }))
    }

    #[napi]
    pub fn store_state(&self) -> Result<Option<NativeStoreState>> {
        let Some(storage) = self.storage_snapshot()? else {
            return Ok(None);
        };
        Ok(Some(NativeStoreState {
            db_path: storage.db_path().to_string_lossy().replace('\\', "/"),
            schema_version: storage.schema_version(),
            database_generation: storage.database_generation() as i64,
            accepting_writes: true,
        }))
    }

    #[napi]
    pub fn health_check(&self) -> Result<AsyncTask<TrackedTask<HealthCheckTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        let storage = self.storage_snapshot()?;
        let Some(storage) = storage else {
            return Ok(self.tracked_task(HealthCheckTask {
                db_path: String::new(),
            }));
        };
        Ok(self.tracked_task(HealthCheckTask {
            db_path: storage.db_path().to_string_lossy().to_string(),
        }))
    }

    #[napi]
    pub fn database_generation(&self) -> Result<i64> {
        Ok(self
            .storage_snapshot()?
            .map(|storage| storage.database_generation() as i64)
            .unwrap_or(0))
    }

    #[napi]
    pub fn cancel_prepared_plan(&self, token: String) -> Result<AsyncTask<TrackedTask<CancelPreparedPlanTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason("KNOWLEDGE_STORE_CLOSED"));
        }
        if token.trim().is_empty() || token.len() > 256 {
            return Err(Error::from_reason("KNOWLEDGE_STORE_INVALID_PLAN_TOKEN"));
        }
        let storage = self.storage_snapshot()?
            .ok_or_else(|| Error::from_reason("KNOWLEDGE_STORE_NOT_OPEN"))?;
        Ok(self.tracked_task(CancelPreparedPlanTask {
            db_path: storage.db_path().to_string_lossy().into_owned(),
            token,
        }))
    }

    /// 在 Rust Read Pool 后台线程读取中央库中当前已索引文件的路径快照。
    ///
    /// 该快照只用于 watcher 溢出后的缺失文件对账；文件系统扫描和事件生成
    /// 仍由 Rust watcher 后台线程完成。
    #[napi]
    pub fn list_indexed_file_paths(
        &self,
        db_path: String,
    ) -> Result<AsyncTask<TrackedTask<IndexedFilePathsTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() {
            return Err(Error::from_reason(
                "listIndexedFilePaths requires a database path".to_string(),
            ));
        }
        Ok(self.tracked_task(IndexedFilePathsTask { db_path }))
    }

    /// 在 Rust Read Pool 后台线程读取中央库中的日记本名称。
    #[napi]
    pub fn list_distinct_diaries(&self, db_path: String) -> Result<AsyncTask<TrackedTask<DiaryListTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() {
            return Err(Error::from_reason(
                "listDistinctDiaries requires a database path".to_string(),
            ));
        }
        Ok(self.tracked_task(DiaryListTask { db_path }))
    }

    /// 在 Rust Read Pool 后台线程统计指定日记本的 Chunk 数量。
    #[napi]
    pub fn get_diary_chunk_count(
        &self,
        db_path: String,
        diary_name: String,
    ) -> Result<AsyncTask<TrackedTask<DiaryChunkCountTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() || diary_name.trim().is_empty() {
            return Err(Error::from_reason(
                "getDiaryChunkCount requires dbPath and diaryName".to_string(),
            ));
        }

        Ok(self.tracked_task(DiaryChunkCountTask {
            db_path,
            diary_name: diary_name.trim().to_string(),
        }))
    }

    /// 在 Rust Read Pool 后台线程按日记本名称解析文件 ID。
    #[napi]
    pub fn get_file_ids_by_diaries(
        &self,
        db_path: String,
        diary_names: Vec<String>,
    ) -> Result<AsyncTask<TrackedTask<FileIdsByDiariesTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() {
            return Err(Error::from_reason(
                "getFileIdsByDiaries requires a database path".to_string(),
            ));
        }
        let mut names = Vec::new();
        let mut seen = HashSet::new();
        for name in diary_names
            .into_iter()
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
        {
            if seen.insert(name.clone()) {
                names.push(name);
            }
        }
        names.sort();
        Ok(self.tracked_task(FileIdsByDiariesTask { db_path, names }))
    }

    #[napi]
    pub fn refresh_file_metadata(
        &self, db_path: String, request_json: String,
    ) -> Result<AsyncTask<TrackedTask<crate::ingestion::FileMetadataRefreshTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason("KNOWLEDGE_STORE_CLOSED"));
        }
        Ok(self.tracked_task(crate::ingestion::FileMetadataRefreshTask { db_path, request_json }))
    }

    /// 在 Rust Read Pool 后台线程批量探测文件事实状态。
    ///
    /// 该接口只返回文件元数据、Chunk 数量和向量完整性摘要，不跨越
    /// N-API 传输任何 Vector BLOB。
    #[napi]
    pub fn probe_ingestion_files(
        &self,
        db_path: String,
        file_paths: Vec<String>,
    ) -> Result<AsyncTask<TrackedTask<IngestionFileProbeTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() {
            return Err(Error::from_reason(
                "probeIngestionFiles requires a database path".to_string(),
            ));
        }

        let paths: Vec<String> = file_paths
            .into_iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .collect();
        if paths.is_empty() {
            return Ok(self.tracked_task(IngestionFileProbeTask {
                db_path,
                paths: Vec::new(),
                dimension: self.dimension as usize,
            }));
        }

        Ok(self.tracked_task(IngestionFileProbeTask {
            db_path,
            paths,
            dimension: self.dimension as usize,
        }))
    }

    /// 在 Rust 后台线程执行文本预处理、Tag 提取、cl100k_base token 计数和 Chunk 切分。
    ///
    /// 返回的 chunks/tags 保持稳定顺序；Embedding 请求仍由 Node.js 的
    /// EmbeddingUtils 编排，Rust 只提供缺失向量任务所需的文本计划。
    #[napi]
    pub fn prepare_text(&self, request_json: String) -> Result<AsyncTask<TrackedTask<TextPreparationTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if request_json.trim().is_empty() {
            return Err(Error::from_reason(
                "prepareText requires a request JSON payload".to_string(),
            ));
        }
        Ok(self.tracked_task(TextPreparationTask { request_json }))
    }

    /// 在 Rust Read Pool 后台线程扫描文件并构建 Tag 一致性计划。
    ///
    /// Rust 负责数据库快照、文件读取、Tag 规则、摘要、摘要哈希和短期
    /// 预览 token；Node.js 只负责展示预览、调用 Embedding 服务和提交向量。
    #[napi]
    pub fn prepare_tag_consistency(
        &self,
        request_json: String,
    ) -> Result<AsyncTask<TrackedTask<TagConsistencyPrepareTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if request_json.trim().is_empty() {
            return Err(Error::from_reason(
                "prepareTagConsistency requires a request JSON payload".to_string(),
            ));
        }
        Ok(self.tracked_task(TagConsistencyPrepareTask { request_json }))
    }

    /// 将 JS 已完成的文本切分与 Embedding 结果提交到 Rust Write Actor。
    ///
    /// Rust 只接受稳定的计划和位置向量，不在这里重写 JS 的 tokenizer/chunker。
    /// 在 Rust Read Pool 后台线程批量探测 Tag 状态。
    ///
    /// 仅返回 Tag ID 和向量是否存在且维度正确，不跨 N-API 传输 Vector BLOB。
    #[napi]
    pub fn probe_ingestion_tags(
        &self,
        db_path: String,
        tag_names: Vec<String>,
    ) -> Result<AsyncTask<TrackedTask<IngestionTagProbeTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() {
            return Err(Error::from_reason(
                "probeIngestionTags requires a database path".to_string(),
            ));
        }

        let names: Vec<String> = tag_names
            .into_iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .collect();

        Ok(self.tracked_task(IngestionTagProbeTask {
            db_path,
            names,
            dimension: self.dimension as usize,
        }))
    }

    /// 在 Rust Read Pool 后台线程查找可复用的迁移向量来源。
    ///
    /// 只返回 live file ID 或 migration tombstone ID；Vector BLOB 始终留在 Rust。
    #[napi]
    pub fn probe_migration_reuse(
        &self,
        db_path: String,
        requests_json: String,
    ) -> Result<AsyncTask<TrackedTask<MigrationReuseProbeTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() {
            return Err(Error::from_reason(
                "probeMigrationReuse requires a database path".to_string(),
            ));
        }
        if requests_json.trim().is_empty() {
            return Err(Error::from_reason(
                "probeMigrationReuse requires a request JSON payload".to_string(),
            ));
        }

        Ok(self.tracked_task(MigrationReuseProbeTask {
            db_path,
            requests_json,
            dimension: self.dimension as usize,
        }))
    }

    /// 清理缺失文件记录以及事实表中的孤儿关系。
    ///
    /// 文件系统扫描在 N-API 后台任务中执行，数据库删除统一提交到
    /// NativeKnowledgeRuntime 所属的 SQLite Write Actor。
    #[napi]
    pub fn cleanup_database_orphans(
        &self,
        db_path: String,
        root_path: String,
    ) -> Result<AsyncTask<TrackedTask<OrphanCleanupTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() || root_path.trim().is_empty() {
            return Err(Error::from_reason(
                "cleanupDatabaseOrphans requires dbPath and rootPath".to_string(),
            ));
        }

        Ok(self.tracked_task(OrphanCleanupTask {
            db_path,
            root_path,
        }))
    }

    /// 在 Rust Read Pool 中确认当前 pairwise 模型已有健康缓存后，
    /// 通过 Write Actor 删除旧模型签名的 pairwise 数值。
    ///
    /// 该维护操作不修改中央事实表，因此不会推进数据库事实代际。
    #[napi]
    pub fn commit_ingestion_batch(
        &self,
        db_path: String,
        plan_json: String,
        chunk_vectors: Float32Array,
        tag_vectors: Float32Array,
    ) -> Result<AsyncTask<TrackedTask<IngestionCommitTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() {
            return Err(Error::from_reason(
                "commitIngestionBatch requires a database path".to_string(),
            ));
        }
        if plan_json.trim().is_empty() {
            return Err(Error::from_reason(
                "commitIngestionBatch requires a plan JSON payload".to_string(),
            ));
        }

        let diary_indices = self
            .diaries
            .read()
            .map_err(|error| {
                Error::from_reason(format!(
                    "Diary registry read lock failed while admitting ingestion: {}",
                    error
                ))
            })?
            .iter()
            .map(|(diary_name, registered)| {
                (
                    diary_name.clone(),
                    (registered.index.clone(), registered.dimension),
                )
            })
            .collect();

        Ok(self.tracked_task(IngestionCommitTask {
            db_path,
            plan_json,
            chunk_vectors: chunk_vectors.to_vec(),
            tag_vectors: tag_vectors.to_vec(),
            diary_indices,
            global_tag_index: self.global_tag_index.clone(),
            global_tag_content_revision: self.global_tag_content_revision.clone(),
            diary_revisions: self.diaries.read()
                .map_err(|_| Error::from_reason("Diary registry lock poisoned"))?
                .iter().map(|(name, item)| (name.clone(), item.content_revision.clone())).collect(),
        }))
    }

    /// 由 Rust Write Actor 提交文件删除、迁移墓碑和索引删除回执。
    #[napi]
    pub fn commit_delete_batch(
        &self,
        db_path: String,
        file_paths: Vec<String>,
        ttl_ms: i64,
        root_path: Option<String>,
    ) -> Result<AsyncTask<TrackedTask<DeleteCommitTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() {
            return Err(Error::from_reason(
                "commitDeleteBatch requires a database path".to_string(),
            ));
        }
        let paths: Vec<String> = file_paths
            .into_iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .collect();
        if paths.is_empty() {
            return Err(Error::from_reason(
                "commitDeleteBatch requires at least one file path".to_string(),
            ));
        }

        let diary_indices = self
            .diaries
            .read()
            .map_err(|error| {
                Error::from_reason(format!(
                    "Diary registry read lock failed while admitting deletion: {}",
                    error
                ))
            })?
            .iter()
            .map(|(diary_name, registered)| {
                (diary_name.clone(), registered.index.clone())
            })
            .collect();

        Ok(self.tracked_task(DeleteCommitTask {
            root_path,
            db_path,
            file_paths: paths,
            ttl_ms,
            diary_indices,
            diary_revisions: self.diaries.read()
                .map_err(|_| Error::from_reason("Diary registry lock poisoned"))?
                .iter().map(|(name, item)| (name.clone(), item.content_revision.clone())).collect(),
        }))
    }

    /// 在 Rust Read Pool 后台线程读取 Tag 一致性预览所需的轻量数据库快照。
    ///
    /// 只返回文件元数据、Tag 元数据和 file_tags 关系，不返回向量 BLOB。
    #[napi]
    pub fn get_tag_consistency_snapshot(
        &self,
        db_path: String,
    ) -> Result<AsyncTask<TrackedTask<TagConsistencySnapshotTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() {
            return Err(Error::from_reason(
                "getTagConsistencySnapshot requires a database path".to_string(),
            ));
        }

        Ok(self.tracked_task(TagConsistencySnapshotTask { db_path }))
    }

    /// 通过 Rust Write Actor 提交 Tag 一致性快照。
    ///
    /// 文件扫描、规则计算和 Embedding 仍由 Node.js 控制面完成；本方法只接收
    /// 已冻结的快照计划与缺失 Tag 向量，所有事实表修改在 Write Actor 事务中执行。
    #[napi]
    pub fn commit_tag_consistency(
        &self,
        db_path: String,
        plan_json: String,
        tag_vectors: Float32Array,
    ) -> Result<AsyncTask<TrackedTask<TagConsistencyCommitTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() {
            return Err(Error::from_reason(
                "commitTagConsistency requires a database path".to_string(),
            ));
        }
        if plan_json.trim().is_empty() {
            return Err(Error::from_reason(
                "commitTagConsistency requires a plan JSON payload".to_string(),
            ));
        }
        if tag_vectors.len() > 32_768 * 100_000 {
            return Err(Error::from_reason(
                "commitTagConsistency vector payload exceeds native limits".to_string(),
            ));
        }

        Ok(self.tracked_task(TagConsistencyCommitTask {
            db_path,
            plan_json,
            tag_vectors: tag_vectors.to_vec(),
            global_tag_index: self.global_tag_index.clone(),
            global_tag_content_revision: self.global_tag_content_revision.clone(),
            memo_runtime: self.memo_runtime.clone(),
        }))
    }

    /// 在 Rust Read Pool 后台线程读取 kv_store 中的单个向量值。
    #[napi]
    pub fn get_kv_vector(
        &self,
        db_path: String,
        key: String,
    ) -> Result<AsyncTask<TrackedTask<KvVectorLookupTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() || key.trim().is_empty() {
            return Err(Error::from_reason(
                "getKvVector requires dbPath and key".to_string(),
            ));
        }

        Ok(self.tracked_task(KvVectorLookupTask {
            db_path,
            key,
        }))
    }

    /// 通过 Rust Write Actor 清理过期和超额的 RiverMemo 持久化资产。
    #[napi]
    pub fn prune_native_memo_artifacts(
        &self,
        db_path: String,
        retain_ready_artifacts: Option<u32>,
        failed_retention_ms: Option<i64>,
    ) -> Result<AsyncTask<TrackedTask<NativeMemoArtifactPruneTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() {
            return Err(Error::from_reason(
                "pruneNativeMemoArtifacts requires a database path".to_string(),
            ));
        }

        Ok(self.tracked_task(NativeMemoArtifactPruneTask {
            db_path,
            retain_ready_artifacts: retain_ready_artifacts.unwrap_or(2) as usize,
            failed_retention_ms: failed_retention_ms
                .unwrap_or(7 * 24 * 60 * 60 * 1000),
        }))
    }

    /// 通过 Rust Write Actor 写入 kv_store 中的单个向量值。
    #[napi]
    pub fn set_kv_vector(
        &self,
        db_path: String,
        key: String,
        vector: Float32Array,
    ) -> Result<AsyncTask<TrackedTask<KvVectorWriteTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() || key.trim().is_empty() {
            return Err(Error::from_reason(
                "setKvVector requires dbPath and key".to_string(),
            ));
        }
        if vector.len() != self.dimension as usize {
            return Err(Error::from_reason(format!(
                "setKvVector dimension mismatch: expected {}, got {}",
                self.dimension,
                vector.len()
            )));
        }

        Ok(self.tracked_task(KvVectorWriteTask {
            db_path,
            key,
            vector: vector.to_vec(),
        }))
    }

    /// 在 Rust Read Pool 后台线程按 key 前缀读取有限数量的 KV 向量。
    #[napi]
    pub fn list_kv_vectors(
        &self,
        db_path: String,
        prefix: String,
    ) -> Result<AsyncTask<TrackedTask<KvVectorListTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() || prefix.trim().is_empty() {
            return Err(Error::from_reason(
                "listKvVectors requires dbPath and prefix".to_string(),
            ));
        }
        if prefix.len() > 256 {
            return Err(Error::from_reason(
                "listKvVectors prefix exceeds the maximum length".to_string(),
            ));
        }

        Ok(self.tracked_task(KvVectorListTask {
            db_path,
            prefix,
        }))
    }

    /// 在 Rust Read Pool 后台线程读取兼容的 RiverMemo artifact manifest。
    /// 只返回控制面元数据，不读取或解压持久化 payload。
    #[napi]
    pub fn get_native_memo_manifest(
        &self,
        db_path: String,
        model_sig: String,
        config_hash: String,
    ) -> Result<AsyncTask<TrackedTask<NativeMemoManifestLookupTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty()
            || model_sig.trim().is_empty()
            || config_hash.trim().is_empty()
        {
            return Err(Error::from_reason(
                "getNativeMemoManifest requires dbPath, modelSig and configHash".to_string(),
            ));
        }

        Ok(self.tracked_task(NativeMemoManifestLookupTask {
            db_path,
            model_sig: model_sig.trim().to_string(),
            config_hash: config_hash.trim().to_string(),
        }))
    }

    /// 在 Rust 后台线程构建单个日记本的轻量日期索引。
    #[napi]
    pub fn get_diary_date_index(
        &self,
        db_path: String,
        diary_name: String,
    ) -> Result<AsyncTask<TrackedTask<DiaryDateIndexTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() {
            return Err(Error::from_reason(
                "getDiaryDateIndex requires a database path".to_string(),
            ));
        }
        let diary_name = diary_name.trim().to_string();
        if diary_name.is_empty() {
            return Err(Error::from_reason(
                "getDiaryDateIndex requires a diary name".to_string(),
            ));
        }

        Ok(self.tracked_task(DiaryDateIndexTask {
            db_path,
            diary_name,
        }))
    }

    /// 在 Rust 后台线程按 Tag 名称查找单个 Tag 向量；Vector BLOB 不经过 Node.js。
    #[napi]
    pub fn get_tag_vector_by_name(
        &self,
        db_path: String,
        tag_name: String,
    ) -> Result<AsyncTask<TrackedTask<TagVectorByNameLookupTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() || tag_name.trim().is_empty() {
            return Err(Error::from_reason(
                "getTagVectorByName requires dbPath and tagName".to_string(),
            ));
        }

        Ok(self.tracked_task(TagVectorByNameLookupTask {
            db_path,
            tag_name: tag_name.trim().to_string(),
            dimension: self.dimension as usize,
        }))
    }

    /// 在 Rust 后台线程按正文查找单个 Chunk 向量；Vector BLOB 不经过 Node.js。
    #[napi]
    pub fn get_chunk_vector_by_text(
        &self,
        db_path: String,
        diary_name: String,
        text: String,
    ) -> Result<AsyncTask<TrackedTask<ChunkVectorByTextLookupTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() {
            return Err(Error::from_reason(
                "getChunkVectorByText requires a database path".to_string(),
            ));
        }
        if text.is_empty() {
            return Ok(self.tracked_task(ChunkVectorByTextLookupTask {
                db_path,
                diary_name,
                text,
                dimension: self.dimension as usize,
            }));
        }

        Ok(self.tracked_task(ChunkVectorByTextLookupTask {
            db_path,
            diary_name,
            text,
            dimension: self.dimension as usize,
        }))
    }

    /// 在 Rust 后台线程读取单个 Chunk 向量；Vector BLOB 不经过 Node.js。
    #[napi]
    pub fn get_chunk_vector(
        &self,
        db_path: String,
        chunk_id: i64,
    ) -> Result<AsyncTask<TrackedTask<ChunkVectorLookupTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() {
            return Err(Error::from_reason(
                "getChunkVector requires a database path".to_string(),
            ));
        }
        if chunk_id <= 0 {
            return Err(Error::from_reason(
                "getChunkVector requires a positive chunk ID".to_string(),
            ));
        }

        Ok(self.tracked_task(ChunkVectorLookupTask {
            db_path,
            chunk_id,
            dimension: self.dimension as usize,
        }))
    }

    /// 按 Chunk ID 批量回填正文和文件元数据，结果按请求 ID 顺序返回。
    ///
    /// SQL 查询在 N-API 后台任务执行，不能在 Node.js 主线程等待 Read Pool。
    #[napi]
    pub fn hydrate_chunks_by_ids(
        &self,
        db_path: String,
        chunk_ids: Vec<i64>,
    ) -> Result<AsyncTask<TrackedTask<ChunkHydrateTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() {
            return Err(Error::from_reason(
                "hydrateChunksByIds requires a database path".to_string(),
            ));
        }

        let mut ids = Vec::new();
        let mut seen = HashSet::new();
        for id in chunk_ids.into_iter().filter(|id| *id > 0) {
            if seen.insert(id) {
                ids.push(id);
            }
        }

        Ok(self.tracked_task(ChunkHydrateTask { db_path, ids }))
    }

    /// 按 Tag ID 批量回填 Tag 名称，供纯 ANN 结果适配旧返回结构。
    #[napi]
    pub fn hydrate_tag_names_by_ids(
        &self,
        db_path: String,
        tag_ids: Vec<i64>,
    ) -> Result<AsyncTask<TrackedTask<TagNameHydrateTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() {
            return Err(Error::from_reason(
                "hydrateTagNamesByIds requires a database path".to_string(),
            ));
        }

        let mut ids = Vec::new();
        let mut seen = HashSet::new();
        for id in tag_ids.into_iter().filter(|id| *id > 0) {
            if seen.insert(id) {
                ids.push(id);
            }
        }

        Ok(self.tracked_task(TagNameHydrateTask { db_path, ids }))
    }

    /// 按文件路径批量回填正文和文件元数据，结果使用与 Chunk ID hydrate 相同的 JSON 契约。
    #[napi]
    pub fn hydrate_chunks_by_file_paths(
        &self,
        db_path: String,
        file_paths: Vec<String>,
    ) -> Result<AsyncTask<TrackedTask<ChunkPathHydrateTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() {
            return Err(Error::from_reason(
                "hydrateChunksByFilePaths requires a database path".to_string(),
            ));
        }

        let mut paths = Vec::new();
        let mut seen = HashSet::new();
        for path in file_paths
            .into_iter()
            .map(|path| path.trim().to_string())
            .filter(|path| !path.is_empty())
        {
            if seen.insert(path.clone()) {
                paths.push(path);
            }
        }

        Ok(self.tracked_task(ChunkPathHydrateTask { db_path, paths }))
    }

    /// 在 Rust 后台线程恢复日记索引。
    ///
    /// 调用方只提供已创建并注册的 VexusIndex；活动槽加载、成员差分回放
    /// 和无基线全量重建均在 Rust 后台执行，向量 BLOB 不经过 Node.js。
    #[napi]
    pub fn restore_diary_index(
        &self,
        db_path: String,
        diary_name: String,
        index_path: String,
        model_sig: String,
        capacity: u32,
        diary_index: ClassInstance<VexusIndex>,
    ) -> Result<AsyncTask<TrackedTask<IndexRestoreTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        let diary_name = Self::normalize_diary_name(diary_name)?;
        if db_path.trim().is_empty() || index_path.trim().is_empty() {
            return Err(Error::from_reason(
                "restoreDiaryIndex requires dbPath and indexPath".to_string(),
            ));
        }
        if diary_index.dimensions != self.dimension {
            return Err(Error::from_reason(format!(
                "Diary restore dimension mismatch for {}: runtime={}, index={}",
                diary_name, self.dimension, diary_index.dimensions
            )));
        }

        Ok(self.tracked_task(IndexRestoreTask {
            db_path,
            index_path,
            index: diary_index.index.clone(),
            content_revision: diary_index.content_revision.clone(),
            memo_runtime: None,
            scope: IndexScope::Diary,
            diary_name: Some(diary_name),
            dimension: self.dimension,
            model_sig,
            capacity,
        }))
    }

    /// 在 Rust 后台线程恢复全局 Tag 索引。
    #[napi]
    pub fn restore_global_tag_index(
        &self,
        db_path: String,
        index_path: String,
        model_sig: String,
        capacity: u32,
    ) -> Result<AsyncTask<TrackedTask<IndexRestoreTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() || index_path.trim().is_empty() {
            return Err(Error::from_reason(
                "restoreGlobalTagIndex requires dbPath and indexPath".to_string(),
            ));
        }

        Ok(self.tracked_task(IndexRestoreTask {
            db_path,
            index_path,
            index: self.global_tag_index.clone(),
            content_revision: self.global_tag_content_revision.clone(),
            memo_runtime: Some(self.memo_runtime.clone()),
            scope: IndexScope::GlobalTags,
            diary_name: None,
            dimension: self.dimension,
            model_sig,
            capacity,
        }))
    }

    /// 在 Rust 后台线程执行日记索引双槽代际 checkpoint。
    #[napi]
    pub fn checkpoint_diary_index(
        &self,
        db_path: String,
        diary_name: String,
        index_path: String,
        model_sig: String,
        threshold: f64,
        force: Option<bool>,
        allow_initial: Option<bool>,
    ) -> Result<AsyncTask<TrackedTask<IndexCheckpointTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        let diary_name = Self::normalize_diary_name(diary_name)?;
        if db_path.trim().is_empty() || index_path.trim().is_empty() {
            return Err(Error::from_reason(
                "checkpointDiaryIndex requires dbPath and indexPath".to_string(),
            ));
        }
        let diaries = self.diaries.read().map_err(|error| {
            Error::from_reason(format!(
                "Diary registry read lock failed: {}",
                error
            ))
        })?;
        let registered = diaries.get(&diary_name).ok_or_else(|| {
            Error::from_reason(format!(
                "Native diary index is not registered: {}",
                diary_name
            ))
        })?;
        let index = registered.index.clone();
        let content_revision = registered.content_revision.clone();
        drop(diaries);
        Ok(self.tracked_task(IndexCheckpointTask {
            db_path,
            index_path,
            index,
            content_revision,
            scope: IndexScope::Diary,
            diary_name: Some(diary_name),
            dimension: self.dimension,
            model_sig,
            threshold,
            force: force.unwrap_or(false),
            allow_initial: allow_initial.unwrap_or(false),
        }))
    }

    /// 在 Rust 后台线程执行全局 Tag 索引双槽代际 checkpoint。
    #[napi]
    pub fn checkpoint_global_tag_index(
        &self,
        db_path: String,
        index_path: String,
        model_sig: String,
        threshold: f64,
        force: Option<bool>,
        allow_initial: Option<bool>,
    ) -> Result<AsyncTask<TrackedTask<IndexCheckpointTask>>> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        if db_path.trim().is_empty() || index_path.trim().is_empty() {
            return Err(Error::from_reason(
                "checkpointGlobalTagIndex requires dbPath and indexPath".to_string(),
            ));
        }
        Ok(self.tracked_task(IndexCheckpointTask {
            db_path,
            index_path,
            index: self.global_tag_index.clone(),
            content_revision: self.global_tag_content_revision.clone(),
            scope: IndexScope::GlobalTags,
            diary_name: None,
            dimension: self.dimension,
            model_sig,
            threshold,
            force: force.unwrap_or(false),
            allow_initial: allow_initial.unwrap_or(false),
        }))
    }

    /// 注册或原子替换一个日记索引。
    ///
    /// 返回由 Runtime 自身分配的 generation；后续注销必须携带该 generation，
    /// 防止旧的空闲淘汰任务误删同名新实例。
    #[napi]
    pub fn register_diary_index(
        &self,
        diary_name: String,
        mut diary_index: ClassInstance<VexusIndex>,
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

        if !Arc::ptr_eq(&diary_index.tasks, &self.tasks) {
            if !diary_index.tasks.is_idle() {
                return Err(Error::from_reason(
                    "KNOWLEDGE_INDEX_BUSY: await index-owned tasks before registration",
                ));
            }
            diary_index.tasks = self.tasks.clone();
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
    ) -> Result<AsyncTask<TrackedTask<NativeMultiIndexAnnTask>>> {
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
        Ok(self.tracked_task(NativeMultiIndexAnnTask {
            db_path: Some(
                self.storage_snapshot()?.ok_or_else(|| {
                    Error::from_reason("KNOWLEDGE_STORE_NOT_OPEN")
                })?.db_path().to_string_lossy().into_owned()
            ),
            index_scopes: snapshots.iter()
                .map(|snapshot| format!("diary:{}", snapshot.diary_name))
                .collect(),
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
    ) -> Result<AsyncTask<TrackedTask<NativeMultiIndexAnnTask>>> {
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
        for diary_name in &requested {
            let registered = registry.get(diary_name).ok_or_else(|| {
                Error::from_reason(format!(
                    "Native diary index is not registered: {}",
                    diary_name
                ))
            })?;
            snapshots.push(DiarySearchSnapshot {
                diary_name: diary_name.clone(),
                index: registered.index.clone(),
                content_revision: registered.content_revision.clone(),
                generation: registered.generation,
            });
        }
        drop(registry);

        let candidate_k = global_k.max(1) as usize;
        let final_k = final_k.unwrap_or(global_k).max(1) as usize;
        Ok(self.tracked_task(NativeMultiIndexAnnTask {
            db_path: Some(db_path.clone()),
            index_scopes: requested
                .iter()
                .map(|name| format!("diary:{}", name))
                .collect(),
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
    ) -> Result<AsyncTask<TrackedTask<NativeRiverQueryTask>>> {
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
        let plan: serde_json::Value = serde_json::from_str(&river_input_json).map_err(|error| {
            Error::from_reason(format!("Invalid native River query plan JSON: {}", error))
        })?;
        let observation_handle = plan
            .get("observationHandle")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                Error::from_reason("Native River query requires observationHandle".to_string())
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
        Ok(self.tracked_task(NativeRiverQueryTask {
            runtime: self.memo_runtime.clone(),
            db_path: db_path.clone(),
            artifact_sig,
            river_input_json,
            ann_task: NativeMultiIndexAnnTask {
                db_path: Some(db_path.clone()),
                index_scopes: snapshots
                    .iter()
                    .map(|snapshot| format!("diary:{}", snapshot.diary_name))
                    .collect(),
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
    ) -> Result<AsyncTask<TrackedTask<NativeRiverQueryTask>>> {
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
                Error::from_reason(format!("Invalid native hybrid query plan JSON: {}", error))
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
                Error::from_reason(format!("Invalid native hybrid River input JSON: {}", error))
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
        Ok(self.tracked_task(NativeRiverQueryTask {
            runtime: self.memo_runtime.clone(),
            db_path: db_path.clone(),
            artifact_sig,
            river_input_json,
            ann_task: NativeMultiIndexAnnTask {
                db_path: Some(db_path.clone()),
                index_scopes: snapshots
                    .iter()
                    .map(|snapshot| format!("diary:{}", snapshot.diary_name))
                    .collect(),
                dimension,
                query: query.to_vec(),
                supplemental_queries,
                supplemental_weights: plan.supplemental.weights,
                supplemental_per_index_k,
                file_candidates: plan.file_candidates,
                bm25_weight: plan.bm25_weight.clamp(0.0, 1.0),
                time_per_diary_limit: plan.time_per_diary_limit.clamp(1, 50),
                time_global_limit: plan.time_global_limit.clamp(1, 500),
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

    /// 在 Runtime 生命周期内启动 Rust 原生文件监听器。
    ///
    /// watcher 的所有权归 NativeKnowledgeRuntime；JS 不再单独持有
    /// VexusWatcher 实例，也不能在 Runtime 关闭后遗留文件事件线程。
    #[napi]
    pub fn start_watch(&self, config: WatcherConfig) -> Result<()> {
        if !self.accepting_queries.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime is shutting down".to_string(),
            ));
        }
        let mut watcher = self.watcher.lock().map_err(|_| {
            Error::from_reason("NativeKnowledgeRuntime watcher lock poisoned".to_string())
        })?;
        if watcher.is_some() {
            return Err(Error::from_reason(
                "NativeKnowledgeRuntime watcher is already running".to_string(),
            ));
        }
        let native_watcher = VexusWatcher::new();
        native_watcher.start_watch(config)?;
        *watcher = Some(native_watcher);
        Ok(())
    }

    /// 批量取出 Rust watcher 已完成的稳定事件。
    ///
    /// 事件留在 Rust 有界队列中，Node.js 只能主动拉取轻量事件，
    /// 不参与 notify 回调、稳定性判断或文件扫描。
    #[napi]
    pub fn drain_watch_events(&self, max_events: Option<u32>) -> Result<Vec<WatchEvent>> {
        let watcher = self.watcher.lock().map_err(|_| {
            Error::from_reason("NativeKnowledgeRuntime watcher lock poisoned".to_string())
        })?;
        Ok(watcher
            .as_ref()
            .map(|value| value.drain_events(max_events.unwrap_or(256)))
            .unwrap_or_default())
    }

    /// 对 Runtime 持有的 KBM watcher 执行一次 Rust 侧文件对账。
    ///
    /// 对账结果重新进入同一个有界事件队列，Node.js 不直接递归扫描知识根目录。
    #[napi]
    pub fn reconcile_watch(&self) -> Result<()> {
        let watcher = self.watcher.lock().map_err(|_| {
            Error::from_reason("NativeKnowledgeRuntime watcher lock poisoned".to_string())
        })?;
        if let Some(native_watcher) = watcher.as_ref() {
            native_watcher.reconcile_watch()
        } else {
            Err(Error::from_reason(
                "NativeKnowledgeRuntime watcher is not running".to_string(),
            ))
        }
    }

    /// 使用 Rust Read Pool 返回的数据库文件路径快照执行缺失文件对账。
    ///
    /// 文件路径快照只跨 N-API 传递字符串；实际扫描、存在性确认和 unlink
    /// 事件生成仍在 Rust watcher 线程中完成。
    #[napi]
    pub fn reconcile_watch_with_paths(&self, paths: Vec<String>) -> Result<()> {
        let known_database_paths = paths
            .into_iter()
            .map(|path| std::path::PathBuf::from(path.replace('\\', "/")))
            .collect::<HashSet<_>>();
        let watcher = self.watcher.lock().map_err(|_| {
            Error::from_reason("NativeKnowledgeRuntime watcher lock poisoned".to_string())
        })?;
        if let Some(native_watcher) = watcher.as_ref() {
            native_watcher.reconcile_watch_with_paths(known_database_paths)
        } else {
            Err(Error::from_reason(
                "NativeKnowledgeRuntime watcher is not running".to_string(),
            ))
        }
    }

    /// 停止 Runtime 所有的文件监听，并释放 notify 句柄。
    #[napi]
    pub fn stop_watch(&self) -> Result<()> {
        let mut watcher = self.watcher.lock().map_err(|_| {
            Error::from_reason("NativeKnowledgeRuntime watcher lock poisoned".to_string())
        })?;
        if let Some(native_watcher) = watcher.take() {
            native_watcher.stop_watch()?;
        }
        Ok(())
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
        let storage = self.storage_snapshot()?;
        Ok(NativeKnowledgeRuntimeStats {
            accepting_queries: self.accepting_queries.load(Ordering::Acquire),
            dimension: self.dimension,
            registered_diaries,
            registry_generation: self.registry_generation.load(Ordering::Acquire) as i64,
            memo_runtime_resident: artifact_sig.is_some(),
            memo_artifact_sig: artifact_sig,
            memo_generation: memo_generation as i64,
            store_open: storage.is_some(),
            store_schema_version: storage
                .as_ref()
                .map(|value| value.schema_version())
                .unwrap_or(0),
            store_database_generation: storage
                .as_ref()
                .map(|value| value.database_generation() as i64)
                .unwrap_or(0),
        })
    }

    /// 停止接受后续查询并清空注册表。已开始任务持有的 Arc 快照不受影响。
    #[napi]
    pub fn shutdown(&self) -> Result<()> {
        self.accepting_queries.store(false, Ordering::Release);
        let mut errors = Vec::new();
        if let Err(error) = self.stop_watch() {
            errors.push(format!("watcher: {}", error));
        }
        self.tasks.close_and_wait();
        match self.global_chunks.lock() {
            Ok(mut slot) => *slot = None,
            Err(poisoned) => {
                *poisoned.into_inner() = None;
                errors.push("Global Chunk table shutdown lock poisoned".into());
            }
        }
        match self.diaries.write() {
            Ok(mut diaries) => diaries.clear(),
            Err(poisoned) => {
                poisoned.into_inner().clear();
                errors.push("Diary registry shutdown lock poisoned".to_string());
            }
        }
        let storage = match self.storage.lock() {
            Ok(mut slot) => slot.take(),
            Err(poisoned) => {
                errors.push("NativeKnowledgeRuntime storage lock poisoned".to_string());
                poisoned.into_inner().take()
            }
        };
        if let Some(storage) = storage {
            if let Err(error) = storage.shutdown() {
                errors.push(format!("storage: {}", error));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(Error::from_reason(format!("Runtime shutdown errors: {}", errors.join("; "))))
        }
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
    fn shutdown_releases_storage_even_when_registry_is_poisoned() {
        let root = std::env::temp_dir().join(format!(
            "kbm-shutdown-poison-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db = root.join("test.sqlite").to_string_lossy().into_owned();
        let index = VexusIndex::new(2, 16).unwrap();
        let runtime = NativeKnowledgeRuntime {
            dimension: 2,
            memo_runtime: index.memo_runtime.clone(),
            global_tag_index: index.index.clone(),
            global_tag_content_revision: index.content_revision.clone(),
            diaries: RwLock::new(HashMap::new()),
            registry_generation: AtomicU64::new(0),
            accepting_queries: AtomicBool::new(true),
            storage: Mutex::new(None),
            watcher: Mutex::new(None),
            tasks: Arc::new(TaskLifecycle::default()),
            global_chunks: Arc::new(Mutex::new(None)),
        };
        runtime.open_and_init_store(db, None).unwrap();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _registry = runtime.diaries.write().unwrap();
            panic!("injected registry poison");
        }));
        assert!(runtime.shutdown().unwrap_err().reason.contains("registry"));
        assert!(runtime.storage_snapshot().unwrap().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn global_tag_search_recovers_invalid_scope_without_ghost_vectors() {
        let root = std::env::temp_dir().join(format!(
            "kbm-tag-query-gate-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db = root.join("test.sqlite").to_string_lossy().into_owned();
        let (storage, _) = SqliteStorageEngine::open_and_init(
            &db, StorageOptions::default(),
        ).unwrap();
        storage.submit_write(|tx| {
            tx.execute(
                "INSERT INTO kbm_index_states(scope,state,facts_generation,applied_generation,updated_at)
                 VALUES ('global_tags','invalid',1,0,0)", [],
            ).map_err(|error| error.to_string())?;
            let vector: Vec<u8> = [1.0_f32, 0.0].iter()
                .flat_map(|value| value.to_ne_bytes()).collect();
            tx.execute(
                "INSERT INTO tags(id,name,vector) VALUES (1,'authoritative',?1)",
                [vector],
            ).map_err(|error| error.to_string())?;
            Ok(crate::storage::WriteReceipt {
                operation: "fixture".to_string(), database_generation: 0, facts_changed: false,
            })
        }).unwrap();
        let index = VexusIndex::new(2, 16).unwrap();
        index.index.write().unwrap().add(999, &[1.0_f32, 0.0]).unwrap();
        let mut task = GlobalTagSearchTask {
            db_path: db.clone(), index: index.index.clone(),
            memo_runtime: index.memo_runtime.clone(),
            content_revision: index.content_revision.clone(), dimension: 2,
            query: vec![1.0, 0.0], limit: 10,
        };
        let results: serde_json::Value = serde_json::from_str(&task.compute().unwrap()).unwrap();
        assert_eq!(results.as_array().unwrap().len(), 1);
        assert_eq!(results[0]["tag"], "authoritative");
        assert_eq!(results[0]["score"], 1.0);
        assert_eq!(index.index.read().unwrap().size(), 1);
        assert!(!index.index.read().unwrap().contains(999));
        ensure_index_scopes_ready(&db, &["global_tags".to_string()]).unwrap();
        storage.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_diary_index_recovery_removes_ghost_vectors() {
        let root = std::env::temp_dir().join(format!(
            "kbm-index-recovery-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db = root.join("test.sqlite").to_string_lossy().into_owned();
        let (storage, _) = SqliteStorageEngine::open_and_init(
            &db, StorageOptions::default(),
        ).unwrap();
        storage.submit_write(|tx| {
            tx.execute(
                "INSERT INTO kbm_index_states(scope,state,facts_generation,applied_generation,updated_at)
                 VALUES ('diary:test','invalid',1,0,0)", [],
            ).map_err(|error| error.to_string())?;
            Ok(crate::storage::WriteReceipt {
                operation: "test".to_string(), database_generation: 0, facts_changed: false,
            })
        }).unwrap();
        let index = VexusIndex::new(2, 16).unwrap();
        index.index.write().unwrap().add(999, &[1.0_f32, 0.0]).unwrap();
        let snapshot = DiarySearchSnapshot {
            diary_name: "test".to_string(), index: index.index.clone(),
            content_revision: index.content_revision.clone(), generation: 1,
        };
        {
            let _gate = crate::publication_gate::acquire(&db, &[String::from("diary:test")]).unwrap();
            recover_diary_snapshot(&db, &snapshot, 2).unwrap();
        }
        assert_eq!(snapshot.index.read().unwrap().size(), 0);
        ensure_index_scopes_ready(&db, &["diary:test".to_string()]).unwrap();
        assert_eq!(snapshot.content_revision.load(Ordering::Acquire), 1);
        storage.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
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

        let (limited, before, per_diary, global) = limit_time_candidates(pending, 2, 10);

        assert_eq!(before, 6);
        assert_eq!(per_diary, 2);
        assert_eq!(global, 10);
        assert_eq!(
            limited
                .iter()
                .map(|candidate| candidate.id)
                .collect::<Vec<_>>(),
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
            limited
                .iter()
                .map(|candidate| candidate.id)
                .collect::<Vec<_>>(),
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
            limited
                .iter()
                .map(|candidate| candidate.id)
                .collect::<Vec<_>>(),
            vec![10, 20, 30]
        );
    }

    #[test]
    fn time_limit_clamps_extreme_configuration() {
        let entries: Vec<(i64, f64)> = (1..=600).map(|id| (id, 1.0 - id as f64 / 1000.0)).collect();
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


#[cfg(test)]
mod light_memo_idle_tests {
    use super::*;

    #[test]
    fn idle_eviction_skips_busy_and_recent_tables_and_releases_expired_table() {
        let index = VexusIndex::new(2, 16).unwrap();
        let runtime = NativeKnowledgeRuntime {
            dimension: 2, memo_runtime: index.memo_runtime.clone(),
            global_tag_index: index.index.clone(),
            global_tag_content_revision: index.content_revision.clone(),
            diaries: RwLock::new(HashMap::new()), registry_generation: AtomicU64::new(0),
            accepting_queries: AtomicBool::new(true), storage: Mutex::new(None),
            watcher: Mutex::new(None), tasks: Arc::new(TaskLifecycle::default()),
            global_chunks: Arc::new(Mutex::new(Some(
                crate::global_chunks::GlobalChunks::empty(2, "test").unwrap(),
            ))),
        };
        assert!(!runtime.evict_idle_light_memo_index(60_000).unwrap());
        {
            let mut slot = runtime.global_chunks.lock().unwrap();
            slot.as_mut().unwrap().last_used =
                std::time::Instant::now() - std::time::Duration::from_secs(120);
            assert!(!runtime.evict_idle_light_memo_index(1).unwrap());
        }
        assert!(runtime.evict_idle_light_memo_index(1).unwrap());
        assert!(runtime.global_chunks.lock().unwrap().is_none());
        *runtime.global_chunks.lock().unwrap() = Some(
            crate::global_chunks::GlobalChunks::empty(2, "test").unwrap(),
        );
        runtime.shutdown().unwrap();
        assert!(runtime.global_chunks.lock().unwrap().is_none());
    }
}
