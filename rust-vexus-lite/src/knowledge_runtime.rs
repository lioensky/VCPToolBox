use crate::result_deduplicator::{self, DedupCandidate};
use crate::rivermemo_topology_v3::{self, MemoRuntime};
use crate::VexusIndex;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::Serialize;
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeAnnCandidate {
    id: i64,
    score: f64,
    sources: Vec<String>,
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
    per_index_k: usize,
    candidate_k: usize,
    final_k: usize,
    snapshots: Vec<DiarySearchSnapshot>,
    semantic_dedup: Option<SemanticDedupConfig>,
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

        let mut merged: HashMap<i64, (f64, HashSet<String>)> = HashMap::new();
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
                let entry = merged
                    .entry(id)
                    .or_insert_with(|| (score, HashSet::new()));
                if score > entry.0 {
                    entry.0 = score;
                }
                entry.1.insert(snapshot.diary_name.clone());
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

        let unique_candidates = merged.len();
        let mut results: Vec<NativeAnnCandidate> = merged
            .into_iter()
            .map(|(id, (score, sources))| {
                let mut sources: Vec<String> = sources.into_iter().collect();
                sources.sort();
                NativeAnnCandidate { id, score, sources }
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
            let sources_by_id: HashMap<i64, Vec<String>> = results
                .iter()
                .map(|candidate| (candidate.id, candidate.sources.clone()))
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
                .map(|candidate| NativeAnnCandidate {
                    id: candidate.id,
                    score: candidate.score,
                    sources: sources_by_id
                        .get(&candidate.id)
                        .cloned()
                        .unwrap_or_default(),
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
                            "vectorScore": score
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