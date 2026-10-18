#![deny(clippy::all)]

mod text;
mod index_lifecycle;
mod ingestion;
mod knowledge_runtime;
mod pairwise_maintenance;
mod tag_consistency;
mod memo_artifact_builder;
mod memo_pipeline;
mod memo_sensing;
mod memo_thinking;
mod result_deduplicator;
mod rivermemo_topology_v3;
mod schema;
mod storage;
mod task_lifecycle;

use rivermemo_topology_v3::MemoRuntime;
use storage::{with_registered_read, with_registered_read_napi, with_registered_write};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use usearch::Index;

/// 搜索结果 (返回 ID 而非 Tag 文本)
/// 上层 JS 会拿着 ID 去 SQLite 里查具体的文本内容
#[napi(object)]
pub struct SearchResult {
    pub id: i64, // 对应 SQLite 中的 chunks.id 或 tags.id
    pub score: f64,
}

#[napi(object)]
pub struct SvdResult {
    pub u: Vec<f64>, // 扁平化的正交基底向量集 (k * dim)
    pub s: Vec<f64>, // 特征值 (奇异值)
    pub k: u32,
    pub dim: u32,
}

#[napi(object)]
pub struct OrthogonalProjectionResult {
    pub projection: Vec<f64>,
    pub residual: Vec<f64>,
    pub basis_coefficients: Vec<f64>,
}

#[napi(object)]
pub struct HandshakeResult {
    pub magnitudes: Vec<f64>,
    pub directions: Vec<f64>, // 扁平化的方向向量 (n * dim)
}

#[napi(object)]
pub struct ProjectResult {
    pub projections: Vec<f64>,
    pub probabilities: Vec<f64>,
    pub entropy: f64,
    pub total_energy: f64,
}

#[napi(object)]
pub struct DualWeightedProjectionResult {
    pub local_vector: Option<Vec<f64>>,
    pub transfer_vector: Option<Vec<f64>>,
    pub requested_count: u32,
    pub found_count: u32,
    pub missing_count: u32,
    pub local_total_weight: f64,
    pub transfer_total_weight: f64,
    pub elapsed_ms: f64,
}

#[napi(object)]
pub struct MemoFusionResult {
    pub vector: Vec<f64>,
    pub selected_tag_ids: Vec<i64>,
    pub requested_count: u32,
    pub found_count: u32,
    pub deduplicated_count: u32,
    pub total_weight: f64,
    pub elapsed_ms: f64,
}

#[napi(object)]
pub struct IntrinsicResidualResult {
    pub tag_count: u32,
    pub computed_count: u32,
    pub skipped_count: u32,
    pub elapsed_ms: f64,
    pub algorithm_version: String,
    pub artifact_sig: String,
    pub effective_config: String,
}

/// 🌟 EPA Rust 基底重算结果
#[napi(object)]
pub struct EpaBasisResult {
    pub success: bool,
    pub message: String,
    pub tag_count: u32,
    pub cluster_count: u32,
    pub basis_count: u32,
    pub elapsed_ms: f64,
    pub algorithm: String,
    pub phase_summary: String,
    pub anchor_count: u32,
    pub representative_sample_count: u32,
    pub density_bucket_count: u32,
    pub publish_elapsed_ms: f64,
}

/// 🌟 TagMemo V8.2: 成对语义距离预计算结果
#[napi(object)]
pub struct PairwiseSimResult {
    pub pair_count: u32,     // 实际共现 pair 总数 (经单文件≤100守恒后)
    pub computed_count: u32, // 本次实际完成余弦计算的 pair 数
    pub skipped_count: u32,  // 已有缓存、缺失向量或 sim 低于阈值被丢弃的 pair 数
    pub stored_count: u32,   // 实际写入数据库的 pair 数 (sim >= min_similarity)
    pub elapsed_ms: f64,
}

/// 统计信息
#[napi(object)]
pub struct VexusStats {
    pub total_vectors: u32,
    pub dimensions: u32,
    pub capacity: u32,
    pub memory_usage: f64,
}

/** 对任意 Chunk/日记索引执行单次排他差分后的摘要。 */
#[napi(object)]
pub struct ChunkIndexDeltaResult {
    pub requested_deletes: u32,
    pub requested_upserts: u32,
    pub applied_deletes: u32,
    pub applied_upserts: u32,
    pub total_vectors: u32,
    pub previous_revision: i64,
    pub revision: i64,
}

/// 对活动 Tag 索引执行单次排他差分后的摘要。
#[napi(object)]
pub struct TagIndexDeltaResult {
    pub requested_deletes: u32,
    pub requested_upserts: u32,
    pub applied_deletes: u32,
    pub applied_upserts: u32,
    pub total_vectors: u32,
    pub memo_runtime_cleared: bool,
}

/// VexusIndex 内部统一 Memo 运行时诊断。
#[napi(object)]
pub struct MemoRuntimeStats {
    pub active_artifact_sig: Option<String>,
    pub generation: i64,
    pub node_count: u32,
    pub edge_count: u32,
    pub resident: bool,
}

/// 核心索引结构 (无状态，只存向量)
#[napi]
pub struct VexusIndex {
    pub(crate) index: Arc<RwLock<Index>>,
    pub(crate) dimensions: u32,
    /// 索引内容代际。批量差分成功后只递增一次，供联合查询冻结和校验快照。
    pub(crate) content_revision: Arc<std::sync::atomic::AtomicU64>,
    epa_pending_cache: Arc<std::sync::Mutex<Option<EpaPendingCache>>>,
    /// TagMemo 与 RiverMemo 共用的原生图资产运行时。
    /// 与本 VexusIndex 实例同生命周期，禁止使用进程全局生产缓存。
    pub(crate) memo_runtime: Arc<MemoRuntime>,
}

static INDEX_SAVE_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn unique_index_sidecar_path(target: &std::path::Path, role: &str) -> std::path::PathBuf {
    let sequence = INDEX_SAVE_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let file_name = target
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "vexus-index".to_string());
    target.with_file_name(format!(
        ".{}.{}.{}.{}.{}",
        file_name,
        role,
        std::process::id(),
        timestamp,
        sequence
    ))
}

fn sync_index_file(path: &std::path::Path) -> std::io::Result<()> {
    // Windows 的 FlushFileBuffers 要求句柄具备写权限；只读句柄即使文件
    // 可读取也会返回 ERROR_ACCESS_DENIED。usearch 已完成临时文件写入，
    // 此处仅重新打开同一文件执行持久化屏障，不修改内容。
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)?
        .sync_all()
}

#[cfg(unix)]
fn sync_parent_directory(target: &std::path::Path) -> std::io::Result<()> {
    let parent = target.parent().unwrap_or_else(|| std::path::Path::new("."));
    std::fs::File::open(parent)?.sync_all()
}

#[cfg(target_os = "windows")]
fn retry_windows_file_operation<T, F>(mut operation: F) -> std::io::Result<T>
where
    F: FnMut() -> std::io::Result<T>,
{
    const RETRY_DELAYS_MS: [u64; 6] = [20, 40, 80, 160, 320, 500];
    let mut last_error = None;

    for attempt in 0..=RETRY_DELAYS_MS.len() {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error)
                if attempt < RETRY_DELAYS_MS.len()
                    && matches!(
                        error.kind(),
                        std::io::ErrorKind::PermissionDenied
                            | std::io::ErrorKind::WouldBlock
                            | std::io::ErrorKind::Interrupted
                    ) =>
            {
                last_error = Some(error);
                std::thread::sleep(std::time::Duration::from_millis(RETRY_DELAYS_MS[attempt]));
            }
            Err(error) => return Err(error),
        }
    }

    Err(last_error.unwrap_or_else(|| std::io::Error::other("file operation retry exhausted")))
}

fn publish_index_file(temp: &std::path::Path, target: &std::path::Path) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        let backup = unique_index_sidecar_path(target, "bak");
        let had_target = target.exists();

        if had_target {
            retry_windows_file_operation(|| std::fs::rename(target, &backup))?;
        }

        if let Err(replace_error) = retry_windows_file_operation(|| std::fs::rename(temp, target)) {
            let rollback_error = if had_target {
                retry_windows_file_operation(|| std::fs::rename(&backup, target)).err()
            } else {
                None
            };
            return Err(match rollback_error {
                Some(error) => std::io::Error::new(
                    replace_error.kind(),
                    format!(
                        "failed to publish new index: {}; rollback also failed: {}",
                        replace_error, error
                    ),
                ),
                None => replace_error,
            });
        }

        if had_target {
            if let Err(error) = retry_windows_file_operation(|| std::fs::remove_file(&backup)) {
                // 新目标已经完整发布；遗留唯一命名备份不应把成功保存误报为失败。
                eprintln!(
                    "[Vexus-Lite] Index published but stale backup cleanup failed ({}): {}",
                    backup.to_string_lossy(),
                    error
                );
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::fs::rename(temp, target)?;
        #[cfg(unix)]
        sync_parent_directory(target)?;
    }

    Ok(())
}

#[napi]
impl VexusIndex {
    /// 创建新的空索引
    #[napi(constructor)]
    pub fn new(dim: u32, capacity: u32) -> Result<Self> {
        let index = Index::new(&usearch::IndexOptions {
            dimensions: dim as usize,
            metric: usearch::MetricKind::L2sq, // 余弦相似度通常用 L2sq 或 Cosine (如果是归一化向量，L2sq 等价于 Cosine)
            quantization: usearch::ScalarKind::F32,
            connectivity: 16,
            expansion_add: 128,
            expansion_search: 64,
            multi: false,
        })
        .map_err(|e| Error::from_reason(format!("Failed to create index: {:?}", e)))?;

        index
            .reserve(capacity as usize)
            .map_err(|e| Error::from_reason(format!("Failed to reserve capacity: {:?}", e)))?;

        Ok(Self {
            index: Arc::new(RwLock::new(index)),
            dimensions: dim,
            content_revision: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            epa_pending_cache: Arc::new(std::sync::Mutex::new(None)),
            memo_runtime: Arc::new(MemoRuntime::new()),
        })
    }

    /// 从磁盘加载索引
    /// 注意：移除了 map_path，因为映射关系现在由 SQLite 管理
    #[napi(factory)]
    pub fn load(
        index_path: String,
        _unused_map_path: Option<String>,
        dim: u32,
        capacity: u32,
    ) -> Result<Self> {
        // 为了保持 JS 调用签名兼容，保留了 map_path 参数但忽略它
        // 或者你可以修改 JS 里的调用去掉第二个参数

        // 创建空索引配置
        let index = Index::new(&usearch::IndexOptions {
            dimensions: dim as usize,
            metric: usearch::MetricKind::L2sq,
            quantization: usearch::ScalarKind::F32,
            connectivity: 16,
            expansion_add: 128,
            expansion_search: 64,
            multi: false,
        })
        .map_err(|e| Error::from_reason(format!("Failed to create index wrapper: {:?}", e)))?;

        // 加载二进制文件
        index
            .load(&index_path)
            .map_err(|e| Error::from_reason(format!("Failed to load index from disk: {:?}", e)))?;

        // 检查容量并扩容
        let current_capacity = index.capacity();
        if capacity as usize > current_capacity {
            // eprintln!("[Vexus] Expanding capacity on load: {} -> {}", current_capacity, capacity);
            index
                .reserve(capacity as usize)
                .map_err(|e| Error::from_reason(format!("Failed to expand capacity: {:?}", e)))?;
        }

        Ok(Self {
            index: Arc::new(RwLock::new(index)),
            dimensions: dim,
            content_revision: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            epa_pending_cache: Arc::new(std::sync::Mutex::new(None)),
            memo_runtime: Arc::new(MemoRuntime::new()),
        })
    }

    /// 保存索引到磁盘。
    ///
    /// 临时文件始终与目标位于同一目录，保证 rename 不跨文件系统。Unix 使用
    /// 原子覆盖并同步父目录；Windows 使用可回滚备份交换，并对杀毒软件、索引器
    /// 短暂持有句柄造成的共享冲突进行有界重试。
    #[napi]
    pub fn save(&self, index_path: String) -> Result<()> {
        save_index_snapshot(&self.index, &index_path).map_err(Error::from_reason)
    }

    /// 在 N-API 后台线程保存索引，禁止调用方在 V8 主线程执行磁盘序列化。
    #[napi]
    pub fn save_async(&self, index_path: String) -> AsyncTask<IndexSaveTask> {
        AsyncTask::new(IndexSaveTask {
            index: self.index.clone(),
            index_path,
        })
    }

    /// 单个添加 (JS 循环调用)
    #[napi]
    pub fn add(&self, id: i64, vector: Float32Array) -> Result<()> {
        let index = self
            .index
            .write()
            .map_err(|e| Error::from_reason(format!("Lock failed: {}", e)))?;

        let vec_slice: &[f32] = &vector;

        if vec_slice.len() != self.dimensions as usize {
            return Err(Error::from_reason(format!(
                "Dimension mismatch: expected {}, got {}",
                self.dimensions,
                vec_slice.len()
            )));
        }

        // 自动扩容检查
        if index.size() + 1 >= index.capacity() {
            let new_cap = (index.capacity() as f64 * 1.5) as usize;
            index
                .reserve(new_cap)
                .map_err(|e| Error::from_reason(format!("Auto-expand failed: {:?}", e)))?;
        }

        index
            .add(id as u64, vec_slice)
            .map_err(|e| Error::from_reason(format!("Add failed: {:?}", e)))?;
        self.content_revision
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);

        Ok(())
    }

    /// 批量添加 (FFI 优化版)
    /// 注意：这目前是一个“伪批量”实现，主要通过减少 JS/Rust 跨界调用开销来提速。
    /// 内部依然是逐条 add，但避免了多次获取写锁的开销。
    #[napi]
    pub fn add_batch(&self, ids: Vec<i64>, vectors: Float32Array) -> Result<()> {
        let index = self
            .index
            .write()
            .map_err(|e| Error::from_reason(format!("Lock failed: {}", e)))?;

        let count = ids.len();
        let dim = self.dimensions as usize;

        let vec_slice: &[f32] = &vectors;

        if vec_slice.len() != count * dim {
            return Err(Error::from_reason("Batch size mismatch".to_string()));
        }

        // 预扩容
        if index.size() + count >= index.capacity() {
            let new_cap = ((index.size() + count) as f64 * 1.5) as usize;
            index
                .reserve(new_cap)
                .map_err(|e| Error::from_reason(format!("Batch auto-expand failed: {:?}", e)))?;
        }

        for (i, id) in ids.iter().enumerate() {
            let start = i * dim;
            let v = &vec_slice[start..start + dim];
            // multi=false 下重复 key 直接 add 会报 duplicate key；
            // 先尽力 remove 再 add，使批量路径与单条“重嵌入更新”语义一致。
            let _ = index.remove(*id as u64);
            index.add(*id as u64, v).map_err(|e| {
                Error::from_reason(format!(
                    "Batch add/update failed idx {} id {}: {:?}",
                    i, id, e
                ))
            })?;
        }
        if count > 0 {
            self.content_revision
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        }

        Ok(())
    }

    /// 对日记/Chunk 索引执行一次后台排他差分。
    ///
    /// 删除、容量预留和全部 upsert 在同一写锁内完成。并发 search 只能在整个
    /// 批次之前或之后取得读锁，不会观察到公共索引的半批状态。
    #[napi]
    pub fn apply_chunk_delta(
        &self,
        remove_ids: Vec<i64>,
        upsert_ids: Vec<i64>,
        upsert_vectors: Float32Array,
    ) -> AsyncTask<ChunkIndexDeltaTask> {
        AsyncTask::new(ChunkIndexDeltaTask {
            index: self.index.clone(),
            content_revision: self.content_revision.clone(),
            dimensions: self.dimensions,
            remove_ids,
            upsert_ids,
            upsert_vectors: upsert_vectors.to_vec(),
        })
    }

    /// 返回当前索引内容代际。
    #[napi(getter)]
    pub fn revision(&self) -> i64 {
        self.content_revision
            .load(std::sync::atomic::Ordering::Acquire) as i64
    }

    /// 对当前活动 Tag 索引执行一次后台排他差分。
    ///
    /// N-API 调用只复制实际变化的向量并立即返回 Promise；耗时的 usearch 删除、
    /// upsert 与 MemoRuntime 失效均在 libuv 工作线程执行，不阻塞 Node 事件循环。
    /// 搜索通过同一 RwLock 等待差分完成，只会看到差分前或差分后的索引。
    #[napi]
    pub fn apply_tag_delta(
        &self,
        remove_ids: Vec<i64>,
        upsert_ids: Vec<i64>,
        upsert_vectors: Float32Array,
    ) -> AsyncTask<TagIndexDeltaTask> {
        AsyncTask::new(TagIndexDeltaTask {
            index: self.index.clone(),
            content_revision: self.content_revision.clone(),
            memo_runtime: self.memo_runtime.clone(),
            dimensions: self.dimensions,
            remove_ids,
            upsert_ids,
            upsert_vectors: upsert_vectors.to_vec(),
        })
    }

    /// 搜索
    #[napi]
    pub fn search(&self, query: Float32Array, k: u32) -> Result<Vec<SearchResult>> {
        let index = self
            .index
            .read()
            .map_err(|e| Error::from_reason(format!("Lock failed: {}", e)))?;

        let query_slice: &[f32] = &query;

        // 🔥🔥🔥【新增】维度安全检查 🔥🔥🔥
        if query_slice.len() != self.dimensions as usize {
            return Err(Error::from_reason(format!(
                "Search dimension mismatch: expected {}, got {}. (Check your JS Buffer slicing!)",
                self.dimensions,
                query_slice.len()
            )));
        }

        // 执行搜索
        let matches = index
            .search(query_slice, k as usize)
            .map_err(|e| Error::from_reason(format!("Search failed: {:?}", e)))?;

        let mut results = Vec::with_capacity(matches.keys.len());

        for (key, &dist) in matches.keys.iter().zip(matches.distances.iter()) {
            results.push(SearchResult {
                id: *key as i64,
                score: 1.0 / (1.0 + dist as f64), // L2sq 距离转相似度分数
            });
        }

        Ok(results)
    }

    /// RiverMemo 全局双场投影。
    ///
    /// Tag 向量直接从当前常驻 usearch F32 索引按 key 读取；整个查询只复用一个
    /// dimension 大小的临时缓冲区，不维护第二份全库向量矩阵。
    #[napi]
    pub fn project_dual_weighted(
        &self,
        tag_ids: Vec<i64>,
        local_masses: Float64Array,
        transfer_masses: Float64Array,
    ) -> Result<DualWeightedProjectionResult> {
        let started_at = std::time::Instant::now();
        let dim = self.dimensions as usize;
        let local_weights: &[f64] = &local_masses;
        let transfer_weights: &[f64] = &transfer_masses;

        if local_weights.len() != tag_ids.len() || transfer_weights.len() != tag_ids.len() {
            return Err(Error::from_reason(format!(
                "Dual projection size mismatch: ids={}, local={}, transfer={}",
                tag_ids.len(),
                local_weights.len(),
                transfer_weights.len()
            )));
        }

        let index = self
            .index
            .read()
            .map_err(|e| Error::from_reason(format!("Lock failed: {}", e)))?;
        let mut tag_vector = vec![0.0f32; dim];
        let mut local_output = vec![0.0f64; dim];
        let mut transfer_output = vec![0.0f64; dim];
        let mut local_total_weight = 0.0f64;
        let mut transfer_total_weight = 0.0f64;
        let mut found_count = 0usize;

        for (position, &tag_id) in tag_ids.iter().enumerate() {
            let local_mass = local_weights[position].max(0.0);
            let transfer_mass = transfer_weights[position].max(0.0);
            if tag_id <= 0
                || (!local_mass.is_finite() && !transfer_mass.is_finite())
                || (local_mass <= 0.0 && transfer_mass <= 0.0)
            {
                continue;
            }

            let local_mass = if local_mass.is_finite() {
                local_mass
            } else {
                0.0
            };
            let transfer_mass = if transfer_mass.is_finite() {
                transfer_mass
            } else {
                0.0
            };
            let matches = index.get(tag_id as u64, &mut tag_vector).map_err(|e| {
                Error::from_reason(format!(
                    "Failed to read Tag vector {} from usearch: {:?}",
                    tag_id, e
                ))
            })?;
            if matches == 0 {
                continue;
            }

            found_count += 1;
            for dimension in 0..dim {
                let value = tag_vector[dimension] as f64;
                if local_mass > 0.0 {
                    local_output[dimension] += value * local_mass;
                }
                if transfer_mass > 0.0 {
                    transfer_output[dimension] += value * transfer_mass;
                }
            }
            local_total_weight += local_mass;
            transfer_total_weight += transfer_mass;
        }

        let finalize = |mut output: Vec<f64>, total_weight: f64| -> Option<Vec<f64>> {
            if total_weight <= 0.0 {
                return None;
            }
            let mut norm_sq = 0.0f64;
            for value in output.iter_mut() {
                *value /= total_weight;
                norm_sq += *value * *value;
            }
            let norm = norm_sq.sqrt();
            if norm <= 1e-12 {
                return None;
            }
            for value in output.iter_mut() {
                *value /= norm;
            }
            Some(output)
        };

        Ok(DualWeightedProjectionResult {
            local_vector: finalize(local_output, local_total_weight),
            transfer_vector: finalize(transfer_output, transfer_total_weight),
            requested_count: tag_ids.len() as u32,
            found_count: found_count as u32,
            missing_count: tag_ids.len().saturating_sub(found_count) as u32,
            local_total_weight,
            transfer_total_weight,
            elapsed_ms: started_at.elapsed().as_secs_f64() * 1000.0,
        })
    }

    /// 使用当前 VexusIndex 唯一 Tag 向量空间完成 TagMemo 上下文融合。
    ///
    /// 只在批量读取请求涉及的 Tag 向量时短持 usearch 读锁；语义去重、
    /// 上下文加权和最终融合均在释放索引锁后执行，不维护第二份全库向量。
    #[napi]
    pub fn fuse_memo_context(
        &self,
        original: Float32Array,
        tag_ids: Vec<i64>,
        tag_weights: Float64Array,
        alpha: f64,
        dedup_threshold: Option<f64>,
        max_tags: Option<u32>,
    ) -> Result<MemoFusionResult> {
        let started_at = std::time::Instant::now();
        let dim = self.dimensions as usize;
        let source: &[f32] = &original;
        let weights: &[f64] = &tag_weights;
        if source.len() != dim {
            return Err(Error::from_reason(format!(
                "Memo fusion dimension mismatch: expected {}, got {}",
                dim,
                source.len()
            )));
        }
        if tag_ids.len() != weights.len() {
            return Err(Error::from_reason(format!(
                "Memo fusion input mismatch: ids={}, weights={}",
                tag_ids.len(),
                weights.len()
            )));
        }

        let requested_count = tag_ids.len();
        let mut requested: Vec<(i64, f64)> = tag_ids
            .into_iter()
            .zip(weights.iter().copied())
            .filter_map(|(id, weight)| {
                let weight = if weight.is_finite() {
                    weight.max(0.0)
                } else {
                    0.0
                };
                (id > 0 && weight > 0.0).then_some((id, weight))
            })
            .collect();
        requested.sort_by(|left, right| {
            right
                .1
                .partial_cmp(&left.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.0.cmp(&right.0))
        });
        requested.truncate(max_tags.unwrap_or(128).clamp(1, 1024) as usize);

        let mut vectors: Vec<(i64, f64, Vec<f32>, f64)> = Vec::with_capacity(requested.len());
        {
            let index = self.index.read().map_err(|error| {
                Error::from_reason(format!("Memo fusion index lock failed: {}", error))
            })?;
            let mut buffer = vec![0.0f32; dim];
            for (id, weight) in requested {
                let matches = index.get(id as u64, &mut buffer).map_err(|error| {
                    Error::from_reason(format!(
                        "Memo fusion failed to read Tag vector {}: {:?}",
                        id, error
                    ))
                })?;
                if matches == 0 {
                    continue;
                }
                let norm = buffer
                    .iter()
                    .map(|value| (*value as f64) * (*value as f64))
                    .sum::<f64>()
                    .sqrt();
                if norm <= 1e-12 {
                    continue;
                }
                vectors.push((id, weight, buffer.clone(), norm));
            }
        }

        let found_count = vectors.len();
        let threshold = dedup_threshold.unwrap_or(0.88).clamp(-1.0, 1.0);
        let mut selected: Vec<(i64, f64, Vec<f32>, f64)> = Vec::new();
        for (id, weight, vector, norm) in vectors {
            let redundant = selected.iter().any(|(_, _, existing, existing_norm)| {
                let dot = vector
                    .iter()
                    .zip(existing.iter())
                    .map(|(left, right)| (*left as f64) * (*right as f64))
                    .sum::<f64>();
                dot / (norm * *existing_norm) > threshold
            });
            if !redundant {
                selected.push((id, weight, vector, norm));
            }
        }

        let mut context = vec![0.0f64; dim];
        let total_weight: f64 = selected.iter().map(|entry| entry.1).sum();
        if total_weight > 0.0 {
            for (_, weight, vector, _) in &selected {
                for dimension in 0..dim {
                    context[dimension] += vector[dimension] as f64 * *weight;
                }
            }
            for value in &mut context {
                *value /= total_weight;
            }
            let context_norm = context
                .iter()
                .map(|value| value * value)
                .sum::<f64>()
                .sqrt();
            if context_norm > 1e-12 {
                for value in &mut context {
                    *value /= context_norm;
                }
            }
        }

        let mix = if alpha.is_finite() {
            alpha.clamp(0.0, 1.0)
        } else {
            0.0
        };
        let mut fused: Vec<f64> = source
            .iter()
            .zip(context.iter())
            .map(|(source_value, context_value)| {
                (1.0 - mix) * (*source_value as f64) + mix * *context_value
            })
            .collect();
        let fused_norm = fused.iter().map(|value| value * value).sum::<f64>().sqrt();
        if fused_norm > 1e-12 {
            for value in &mut fused {
                *value /= fused_norm;
            }
        }

        Ok(MemoFusionResult {
            vector: fused,
            selected_tag_ids: selected.iter().map(|entry| entry.0).collect(),
            requested_count: requested_count as u32,
            found_count: found_count as u32,
            deduplicated_count: selected.len() as u32,
            total_weight,
            elapsed_ms: started_at.elapsed().as_secs_f64() * 1000.0,
        })
    }

    /// 在本 Tag 向量索引与 MemoRuntime 上执行统一查询数学管线。
    ///
    /// EPA、Residual Pyramid、Core/语言/层级门控、Spike 与向量融合全部在
    /// 同一 Rust 后台任务中完成；返回值供 RiverMemo Topology V3 读出复用。
    #[napi]
    pub fn run_memo_pipeline(
        &self,
        db_path: String,
        artifact_sig: String,
        input_json: String,
        query_vector: Float32Array,
        ghost_vectors: Float32Array,
    ) -> AsyncTask<memo_pipeline::MemoPipelineTask> {
        memo_pipeline::run_with_runtime(
            self.index.clone(),
            self.memo_runtime.clone(),
            db_path,
            artifact_sig,
            self.dimensions as usize,
            input_json,
            query_vector.to_vec(),
            ghost_vectors.to_vec(),
        )
    }

    /// 在本 Tag 向量索引拥有的统一 MemoRuntime 上执行 RiverMemo Topology V3。
    ///
    /// 首次请求从持久化资产恢复 CSR，随后由本 VexusIndex 实例持有活动 Arc 快照；
    /// 查询只克隆快照，不再访问进程全局生产缓存。
    #[napi]
    pub fn rerank_rivermemo_topology_v3(
        &self,
        db_path: String,
        artifact_sig: String,
        input_json: String,
    ) -> AsyncTask<rivermemo_topology_v3::RiverMemoTopologyV3Task> {
        rivermemo_topology_v3::rerank_with_runtime(
            self.memo_runtime.clone(),
            db_path,
            artifact_sig,
            input_json,
        )
    }

    /// 从 SQLite 事实层和 Rust 派生表原生编译统一 Memo 图资产。
    ///
    /// 完整图、CSR、provenance、持久化 payload 与活动 Arc 均不跨越
    /// N-API 边界；JavaScript 只接收签名、代际与规模摘要。
    #[napi]
    pub fn rebuild_memo_artifact(
        &self,
        db_path: String,
        input_json: String,
    ) -> AsyncTask<memo_artifact_builder::NativeMemoArtifactBuildTask> {
        memo_artifact_builder::rebuild_with_runtime(self.memo_runtime.clone(), db_path, input_json)
    }

    /// 从已有 Sense 观测构建方法模块框架，不重新感应或修改图资产。
    /// 输入仅包含观测句柄、显式思维簇范围、候选 ID 与阶段配额。
    #[napi]
    pub fn plan_memo_thinking(
        &self,
        db_path: String,
        artifact_sig: String,
        input_json: String,
    ) -> AsyncTask<memo_thinking::ThinkingTask> {
        AsyncTask::new(memo_thinking::ThinkingTask {
            runtime: self.memo_runtime.clone(),
            db_path,
            artifact_sig,
            input_json,
        })
    }

    /// 释放本索引持有的统一 Memo 图快照。
    #[napi]
    pub fn clear_memo_runtime(&self) -> Result<()> {
        self.memo_runtime.clear().map_err(Error::from_reason)
    }

    /// 获取统一 Memo 图快照的常驻诊断。
    #[napi]
    pub fn memo_runtime_stats(&self) -> Result<MemoRuntimeStats> {
        let (signature, generation, node_count, edge_count) = self
            .memo_runtime
            .diagnostics()
            .map_err(Error::from_reason)?;
        Ok(MemoRuntimeStats {
            resident: signature.is_some(),
            active_artifact_sig: signature,
            generation: generation as i64,
            node_count: node_count as u32,
            edge_count: edge_count as u32,
        })
    }

    /// 删除 (按 ID)
    #[napi]
    pub fn remove(&self, id: i64) -> Result<()> {
        let index = self
            .index
            .write()
            .map_err(|e| Error::from_reason(format!("Lock failed: {}", e)))?;

        index
            .remove(id as u64)
            .map_err(|e| Error::from_reason(format!("Remove failed: {:?}", e)))?;
        self.content_revision
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);

        Ok(())
    }

    /// 获取当前索引状态
    #[napi]
    pub fn stats(&self) -> Result<VexusStats> {
        let index = self
            .index
            .read()
            .map_err(|e| Error::from_reason(format!("Lock failed: {}", e)))?;

        Ok(VexusStats {
            total_vectors: index.size() as u32,
            dimensions: self.dimensions,
            capacity: index.capacity() as u32,
            memory_usage: index.memory_usage() as f64,
        })
    }

    /// 从 SQLite 数据库恢复索引 (异步版本，不阻塞主线程)
    #[napi]
    pub fn recover_from_sqlite(
        &self,
        db_path: String,
        table_type: String,
        filter_diary_name: Option<String>,
    ) -> AsyncTask<RecoverTask> {
        AsyncTask::new(RecoverTask {
            index: self.index.clone(),
            content_revision: self.content_revision.clone(),
            db_path,
            table_type,
            filter_diary_name,
            dimensions: self.dimensions,
        })
    }

    /// 高性能 SVD 分解 (用于 EPA 基底构建)
    /// flattened_vectors: n * dim 的扁平化向量数组
    /// n: 向量数量
    /// max_k: 最大保留的主成分数量
    #[napi]
    pub fn compute_svd(
        &self,
        flattened_vectors: Float32Array,
        n: u32,
        max_k: u32,
    ) -> Result<SvdResult> {
        let dim = self.dimensions as usize;
        let n = n as usize;
        let max_k = max_k as usize;

        let vec_slice: &[f32] = &flattened_vectors;

        if vec_slice.len() != n * dim {
            return Err(Error::from_reason(format!(
                "Flattened vectors length mismatch: expected {}, got {}",
                n * dim,
                vec_slice.len()
            )));
        }

        // 使用 nalgebra 进行 SVD 分解
        // M 是 n x dim 矩阵
        use nalgebra::DMatrix;
        let matrix = DMatrix::from_row_slice(n, dim, vec_slice);

        // 计算 SVD: M = U * S * V^T
        // 我们需要的是 V^T 的行，它们是原始空间中的主成分
        let svd = matrix.svd(false, true);

        let s = svd
            .singular_values
            .as_slice()
            .iter()
            .map(|&x| x as f64)
            .collect::<Vec<_>>();
        let v_t = svd
            .v_t
            .ok_or_else(|| Error::from_reason("Failed to compute V^T matrix".to_string()))?;

        let k = std::cmp::min(s.len(), max_k);
        let mut u_flattened = Vec::with_capacity(k * dim);

        for i in 0..k {
            let row = v_t.row(i);
            // nalgebra 的 row view 可能不连续，手动迭代以确保安全
            for &val in row.iter() {
                u_flattened.push(val as f64);
            }
        }

        Ok(SvdResult {
            u: u_flattened,
            s: s[..k].to_vec(),
            k: k as u32,
            dim: dim as u32,
        })
    }

    /// 高性能 Gram-Schmidt 正交投影
    #[napi]
    pub fn compute_orthogonal_projection(
        &self,
        vector: Float32Array,
        flattened_tags: Float32Array,
        n_tags: u32,
    ) -> Result<OrthogonalProjectionResult> {
        let dim = self.dimensions as usize;
        let n = n_tags as usize;

        let query: &[f32] = &vector;
        let tags_slice: &[f32] = &flattened_tags;

        if query.len() != dim || tags_slice.len() != n * dim {
            return Err(Error::from_reason("Dimension mismatch".to_string()));
        }

        let mut basis: Vec<Vec<f64>> = Vec::with_capacity(n);
        let mut basis_coefficients = vec![0.0; n];
        let mut projection = vec![0.0; dim];

        for i in 0..n {
            let start = i * dim;
            let tag_vec = &tags_slice[start..start + dim];
            let mut v: Vec<f64> = tag_vec.iter().map(|&x| x as f64).collect();

            for u in &basis {
                let mut dot = 0.0;
                for d in 0..dim {
                    dot += v[d] * u[d];
                }
                for d in 0..dim {
                    v[d] -= dot * u[d];
                }
            }

            let mut mag_sq = 0.0;
            for d in 0..dim {
                mag_sq += v[d] * v[d];
            }
            let mag = mag_sq.sqrt();

            if mag > 1e-6 {
                for d in 0..dim {
                    v[d] /= mag;
                }

                let mut coeff = 0.0;
                for d in 0..dim {
                    coeff += (query[d] as f64) * v[d];
                }
                basis_coefficients[i] = coeff.abs();

                for d in 0..dim {
                    projection[d] += coeff * v[d];
                }
                basis.push(v);
            }
        }

        let mut residual = vec![0.0; dim];
        for d in 0..dim {
            residual[d] = (query[d] as f64) - projection[d];
        }

        Ok(OrthogonalProjectionResult {
            projection,
            residual,
            basis_coefficients,
        })
    }

    /// 高性能握手分析
    #[napi]
    pub fn compute_handshakes(
        &self,
        query: Float32Array,
        flattened_tags: Float32Array,
        n_tags: u32,
    ) -> Result<HandshakeResult> {
        let dim = self.dimensions as usize;
        let n = n_tags as usize;

        let q: &[f32] = &query;
        let tags: &[f32] = &flattened_tags;
        let expected_tags_len = n.checked_mul(dim).ok_or_else(|| {
            Error::from_reason(format!(
                "Handshake input size overflow: n_tags={}, dimension={}",
                n, dim
            ))
        })?;
        if q.len() != dim || tags.len() != expected_tags_len {
            return Err(Error::from_reason(format!(
                "Handshake dimension mismatch: query expected {}, got {}; tags expected {}, got {}",
                dim,
                q.len(),
                expected_tags_len,
                tags.len()
            )));
        }

        let mut magnitudes = Vec::with_capacity(n);
        let mut directions = Vec::with_capacity(n * dim);

        for i in 0..n {
            let start = i * dim;
            let tag_vec = &tags[start..start + dim];
            let mut mag_sq = 0.0;
            let mut delta = vec![0.0; dim];

            for d in 0..dim {
                let diff = (q[d] - tag_vec[d]) as f64;
                delta[d] = diff;
                mag_sq += diff * diff;
            }

            let mag = mag_sq.sqrt();
            magnitudes.push(mag);

            if mag > 1e-9 {
                for d in 0..dim {
                    directions.push(delta[d] / mag);
                }
            } else {
                for _ in 0..dim {
                    directions.push(0.0);
                }
            }
        }

        Ok(HandshakeResult {
            magnitudes,
            directions,
        })
    }

    /// 高性能 EPA 投影
    #[napi]
    pub fn project(
        &self,
        vector: Float32Array,
        flattened_basis: Float32Array,
        mean_vector: Float32Array,
        k: u32,
    ) -> Result<ProjectResult> {
        let dim = self.dimensions as usize;
        let k = k as usize;

        let vec: &[f32] = &vector;
        let basis_slice: &[f32] = &flattened_basis;
        let mean: &[f32] = &mean_vector;

        if vec.len() != dim || basis_slice.len() != k * dim || mean.len() != dim {
            return Err(Error::from_reason("Dimension mismatch".to_string()));
        }

        let mut centered = vec![0.0; dim];
        for d in 0..dim {
            centered[d] = (vec[d] - mean[d]) as f64;
        }

        let mut projections = vec![0.0; k];
        let mut total_energy = 0.0;

        for i in 0..k {
            let start = i * dim;
            let b = &basis_slice[start..start + dim];
            let mut dot = 0.0;
            for d in 0..dim {
                dot += centered[d] * (b[d] as f64);
            }
            projections[i] = dot;
            total_energy += dot * dot;
        }

        let mut probabilities = vec![0.0; k];
        let mut entropy = 0.0;

        if total_energy > 1e-12 {
            for i in 0..k {
                let p = (projections[i] * projections[i]) / total_energy;
                probabilities[i] = p;
                if p > 1e-9 {
                    entropy -= p * p.log2();
                }
            }
        }

        Ok(ProjectResult {
            projections,
            probabilities,
            entropy,
            total_energy,
        })
    }

    /// 🌟 EPA: Rust 侧重算基底并暂存在 Rust 内存中。
    ///
    /// 计算阶段只读 SQLite，不持有 JS 写租约；调用方应在结果成功后短租约调用 publish_epa_basis_cache。
    #[napi]
    pub fn compute_epa_basis(
        &self,
        db_path: String,
        cluster_count: u32,
        max_basis_dim: u32,
    ) -> AsyncTask<EpaBasisTask> {
        println!(
            "[Vexus-Lite][EPA] compute_epa_basis task accepted: db={}, cluster_count={}, max_basis_dim={}",
            db_path,
            cluster_count,
            max_basis_dim
        );
        AsyncTask::new(EpaBasisTask {
            db_path,
            dimensions: self.dimensions,
            cluster_count: cluster_count.max(8),
            max_basis_dim: max_basis_dim.max(1),
            pending_cache: self.epa_pending_cache.clone(),
        })
    }

    /// 🌟 EPA: 发布最近一次 Rust 计算完成的 EPA cache。
    ///
    /// 该方法执行短 SQLite 写入，JS 调用方必须先获取 Rust 写租约。
    #[napi]
    pub fn publish_epa_basis_cache(&self, db_path: String) -> Result<EpaBasisResult> {
        let pending = {
            let guard = self
                .epa_pending_cache
                .lock()
                .map_err(|e| Error::from_reason(format!("EPA pending cache lock failed: {}", e)))?;
            guard.clone()
        };

        let pending = match pending {
            Some(cache) => cache,
            None => {
                return Ok(EpaBasisResult {
                    success: false,
                    message: "no pending EPA basis cache to publish".to_string(),
                    tag_count: 0,
                    cluster_count: 0,
                    basis_count: 0,
                    elapsed_ms: 0.0,
                    algorithm: "density-residual-sampling".to_string(),
                    phase_summary: "publish=no_pending_cache".to_string(),
                    anchor_count: 0,
                    representative_sample_count: 0,
                    density_bucket_count: 0,
                    publish_elapsed_ms: 0.0,
                });
            }
        };

        let target_db_identity = sqlite_database_identity(&db_path);
        if target_db_identity != pending.db_identity {
            return Err(Error::from_reason(format!(
                "EPA pending cache database mismatch: computed for {}, publish requested for {}",
                pending.db_identity, target_db_identity
            )));
        }

        println!(
            "[Vexus-Lite][EPA] publish_epa_basis_cache started: db={}, tags={}, clusters={}, basis={}",
            db_path,
            pending.tag_count,
            pending.cluster_count,
            pending.basis_count
        );

        let started_at = std::time::Instant::now();
        let cache_json = pending.cache_json.clone();
        with_registered_write(&db_path, move |transaction| {
            transaction
                .execute(
                    "INSERT OR REPLACE INTO kv_store (key, value) VALUES (?1, ?2)",
                    rusqlite::params!["epa_basis_cache", cache_json],
                )
                .map_err(|error| format!("EPA cache write failed: {}", error))?;

            Ok(crate::storage::WriteReceipt {
                operation: "publish_epa_basis_cache".to_string(),
                database_generation: 0,
                facts_changed: false,
            })
        })
        .map_err(|error| format!("EPA cache Write Actor publish failed: {}", error))
        .map_err(Error::from_reason)?;

        {
            let mut guard = self
                .epa_pending_cache
                .lock()
                .map_err(|e| Error::from_reason(format!("EPA pending cache lock failed: {}", e)))?;
            if guard.as_ref().map(|cache| cache.cache_sig.as_str())
                == Some(pending.cache_sig.as_str())
            {
                *guard = None;
            }
        }

        let publish_ms = started_at.elapsed().as_secs_f64() * 1000.0;
        println!(
            "[Vexus-Lite][EPA] publish_epa_basis_cache finished: publish_elapsed={:.2}ms, compute_elapsed={:.2}ms",
            publish_ms,
            pending.elapsed_ms
        );

        Ok(EpaBasisResult {
            success: true,
            message: "ok".to_string(),
            tag_count: pending.tag_count,
            cluster_count: pending.cluster_count,
            basis_count: pending.basis_count,
            elapsed_ms: pending.elapsed_ms + publish_ms,
            algorithm: pending.algorithm,
            phase_summary: format!("{};publish={:.2}ms", pending.phase_summary, publish_ms),
            anchor_count: pending.anchor_count,
            representative_sample_count: pending.representative_sample_count,
            density_bucket_count: pending.density_bucket_count,
            publish_elapsed_ms: publish_ms,
        })
    }

    /// 预计算任务：矩阵内生残差 (TagMemo V7)
    #[napi]
    pub fn compute_intrinsic_residuals(
        &self,
        db_path: String,
        max_svd_rank: Option<u32>,
        min_neighbors: Option<u32>,
        model_sig: Option<String>,
        effective_config_json: Option<String>,
    ) -> AsyncTask<IntrinsicResidualTask> {
        AsyncTask::new(IntrinsicResidualTask {
            db_path,
            dimensions: self.dimensions,
            max_basis: max_svd_rank.unwrap_or(4),
            min_neighbors: min_neighbors.unwrap_or(3),
            model_sig,
            effective_config_json,
        })
    }

    /// 🌟 TagMemo V8.2: 预计算 Tag 对的语义距离（成对余弦相似度）
    ///
    /// - 仅对实际共现的 pair 进行计算（避免 N² 爆炸）
    /// - 单文件 Tag 数 > 100 的脏文件跳过（与 JS / V7 守恒一致）
    /// - 增量模式：已存在且 model_sig 一致的 pair 直接跳过
    /// - sim < min_similarity 的 pair 不写入（默认丢弃噪声）
    /// - 单模型缓存策略：full_rebuild 会清空整张 sim 表，避免旧模型签名残留
    ///
    /// # 参数
    /// - `db_path`: SQLite 路径
    /// - `model_sig`: embedding 模型签名 (含维度)，跨模型自动失效
    /// - `min_similarity`: 噪声阈值，默认 0.05
    /// - `full_rebuild`: 是否清空 sim 表后重算 (默认 false 增量)
    #[napi]
    pub fn compute_pairwise_similarities(
        &self,
        db_path: String,
        model_sig: String,
        min_similarity: Option<f64>,
        full_rebuild: Option<bool>,
    ) -> AsyncTask<PairwiseSimTask> {
        AsyncTask::new(PairwiseSimTask {
            db_path,
            dimensions: self.dimensions,
            model_sig,
            min_similarity: min_similarity.unwrap_or(0.05),
            full_rebuild: full_rebuild.unwrap_or(false),
        })
    }
}

/// 🌟 EPA: Rust 侧 K-Means + 加权 PCA 计算结果暂存。
#[derive(Clone)]
pub struct EpaPendingCache {
    cache_json: String,
    cache_sig: String,
    db_identity: String,
    tag_count: u32,
    cluster_count: u32,
    basis_count: u32,
    elapsed_ms: f64,
    algorithm: String,
    phase_summary: String,
    anchor_count: u32,
    representative_sample_count: u32,
    density_bucket_count: u32,
}

/// 🌟 EPA: Rust 侧 K-Means + 加权 PCA 计算任务。
///
/// 注意：该任务只读 SQLite 并把结果暂存在 Rust 内存，不写 kv_store；写入由 publish_epa_basis_cache 在短租约内完成。
pub struct EpaBasisTask {
    db_path: String,
    dimensions: u32,
    cluster_count: u32,
    max_basis_dim: u32,
    pending_cache: Arc<std::sync::Mutex<Option<EpaPendingCache>>>,
}

fn stable_sha256_hex(value: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn sqlite_database_identity(db_path: &str) -> String {
    std::fs::canonicalize(db_path)
        .unwrap_or_else(|_| std::path::PathBuf::from(db_path))
        .to_string_lossy()
        .replace('\\', "/")
        .to_lowercase()
}

fn json_string(value: &str) -> String {
    // 正确处理引号、反斜杠和所有控制字符
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

/// 仅返回 JSON 字符串字面量的内部转义内容（不含外层引号），
/// 供手工拼接 `"\"{}\""` 形式的 JSON 片段使用。
fn json_escape(value: &str) -> String {
    let quoted = json_string(value);
    // serde_json 输出恒为 `"..."`，去掉首尾引号即得转义正文
    quoted[1..quoted.len() - 1].to_string()
}

fn f32_slice_to_base64(values: &[f32]) -> String {
    use base64::Engine;
    let mut bytes = Vec::with_capacity(std::mem::size_of_val(values));
    for value in values {
        bytes.extend_from_slice(&value.to_ne_bytes());
    }
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn normalize_f32_vector(vector: &mut [f32]) {
    let mut mag = 0.0f64;
    for value in vector.iter() {
        mag += (*value as f64) * (*value as f64);
    }
    let mag = mag.sqrt();
    if mag > 1e-9 {
        for value in vector.iter_mut() {
            *value = (*value as f64 / mag) as f32;
        }
    }
}

struct EpaDensityBucket {
    count: usize,
    sum: Vec<f32>,
    best_idx: usize,
    best_residual: f64,
    samples: Vec<(usize, f64)>,
}

struct EpaAnchorCandidate {
    key: u16,
    density: usize,
    centroid: Vec<f32>,
    label_idx: usize,
    base_score: f64,
}

fn epa_projection_bit(vector: &[f32], mean: &[f32], bit: usize, dim: usize) -> bool {
    let mut acc = 0.0f64;
    let mut state = (bit as u64 + 1).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    for _ in 0..16 {
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        let idx = (state as usize) % dim;
        let sign = if (state & 0x8000_0000_0000_0000) == 0 {
            1.0
        } else {
            -1.0
        };
        acc += ((vector[idx] - mean[idx]) as f64) * sign;
    }
    acc >= 0.0
}

fn epa_density_key(vector: &[f32], mean: &[f32], dim: usize) -> u16 {
    let mut key = 0u16;
    for bit in 0..12 {
        if epa_projection_bit(vector, mean, bit, dim) {
            key |= 1u16 << bit;
        }
    }
    key
}

fn epa_residual_norm(vector: &[f32], mean: &[f32], dim: usize) -> f64 {
    let mut norm = 0.0f64;
    for d in 0..dim {
        let v = (vector[d] - mean[d]) as f64;
        norm += v * v;
    }
    norm.sqrt()
}

fn select_epa_density_residual_samples(
    vectors: &[Vec<f32>],
    names: &[String],
    requested_anchors: usize,
    dim: usize,
) -> (Vec<Vec<f32>>, Vec<usize>, Vec<String>, usize, usize, usize) {
    use std::collections::{HashMap, HashSet};

    let started_at = std::time::Instant::now();
    let tag_count = vectors.len();
    let anchor_count = requested_anchors.clamp(8, 128).min(tag_count);
    let samples_per_anchor = std::env::var("EPA_RUST_SAMPLES_PER_ANCHOR")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(32)
        .clamp(4, 128);

    println!(
        "[Vexus-Lite][EPA] density-residual sampling started: tags={}, anchors={}, samples_per_anchor={}, dim={}",
        tag_count,
        anchor_count,
        samples_per_anchor,
        dim
    );

    let mut mean = vec![0.0f32; dim];
    for vector in vectors {
        for d in 0..dim {
            mean[d] += vector[d];
        }
    }
    for value in &mut mean {
        *value /= tag_count as f32;
    }

    let mut buckets: HashMap<u16, EpaDensityBucket> = HashMap::new();
    for (idx, vector) in vectors.iter().enumerate() {
        let key = epa_density_key(vector, &mean, dim);
        let residual = epa_residual_norm(vector, &mean, dim);
        let bucket = buckets.entry(key).or_insert_with(|| EpaDensityBucket {
            count: 0,
            sum: vec![0.0f32; dim],
            best_idx: idx,
            best_residual: residual,
            samples: Vec::with_capacity(samples_per_anchor),
        });

        bucket.count += 1;
        for d in 0..dim {
            bucket.sum[d] += vector[d];
        }

        if residual > bucket.best_residual {
            bucket.best_residual = residual;
            bucket.best_idx = idx;
        }

        let insert_at = bucket
            .samples
            .binary_search_by(|probe| {
                probe
                    .1
                    .partial_cmp(&residual)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .reverse()
            })
            .unwrap_or_else(|pos| pos);
        if insert_at < samples_per_anchor {
            bucket.samples.insert(insert_at, (idx, residual));
            if bucket.samples.len() > samples_per_anchor {
                bucket.samples.pop();
            }
        } else if bucket.samples.len() < samples_per_anchor {
            bucket.samples.push((idx, residual));
        }
    }

    println!(
        "[Vexus-Lite][EPA] density buckets built: buckets={}, elapsed={:.2}ms",
        buckets.len(),
        started_at.elapsed().as_secs_f64() * 1000.0
    );

    let mut candidates = Vec::with_capacity(buckets.len());
    for (key, bucket) in &buckets {
        if bucket.count == 0 {
            continue;
        }

        let mut centroid = bucket.sum.clone();
        for value in &mut centroid {
            *value /= bucket.count as f32;
        }
        normalize_f32_vector(&mut centroid);

        let density = bucket.count as f64;
        let residual = bucket.best_residual.max(1e-9);
        let base_score = density.powf(0.65) * residual.powf(0.35);

        candidates.push(EpaAnchorCandidate {
            key: *key,
            density: bucket.count,
            centroid,
            label_idx: bucket.best_idx,
            base_score,
        });
    }

    candidates.sort_by(|a, b| {
        b.base_score
            .partial_cmp(&a.base_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let candidate_limit = std::env::var("EPA_RUST_ANCHOR_CANDIDATE_LIMIT")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(512)
        .clamp(anchor_count, 4096);
    candidates.truncate(candidate_limit);

    let mut centered_centroids: Vec<Vec<f64>> = Vec::with_capacity(candidates.len());
    for candidate in &candidates {
        let mut centered = Vec::with_capacity(dim);
        let mut norm_sq = 0.0f64;
        for d in 0..dim {
            let value = (candidate.centroid[d] - mean[d]) as f64;
            norm_sq += value * value;
            centered.push(value);
        }
        let norm = norm_sq.sqrt();
        if norm > 1e-12 {
            for value in &mut centered {
                *value /= norm;
            }
        }
        centered_centroids.push(centered);
    }

    let mut selected: Vec<EpaAnchorCandidate> = Vec::with_capacity(anchor_count);
    let mut selected_centered: Vec<Vec<f64>> = Vec::with_capacity(anchor_count);
    let mut candidate_max_sim = vec![0.0f64; candidates.len()];

    while selected.len() < anchor_count && !candidates.is_empty() {
        let mut best_idx = 0usize;
        let mut best_score = f64::MIN;

        for (idx, candidate) in candidates.iter().enumerate() {
            let max_sim = candidate_max_sim[idx];
            let diversity_decay = (-3.0 * max_sim * max_sim).exp();
            let score = candidate.base_score * diversity_decay;
            if score > best_score {
                best_score = score;
                best_idx = idx;
            }
        }

        let chosen = candidates.swap_remove(best_idx);
        let chosen_centered = centered_centroids.swap_remove(best_idx);
        candidate_max_sim.swap_remove(best_idx);

        for (idx, centered) in centered_centroids.iter().enumerate() {
            let mut sim = 0.0f64;
            for d in 0..dim {
                sim += centered[d] * chosen_centered[d];
            }
            let sim = sim.max(0.0);
            if sim > candidate_max_sim[idx] {
                candidate_max_sim[idx] = sim;
            }
        }

        selected_centered.push(chosen_centered);
        selected.push(chosen);
    }

    let mut representative_tag_indices = HashSet::new();
    let mut anchor_vectors = Vec::with_capacity(selected.len());
    let mut weights = Vec::with_capacity(selected.len());
    let mut labels = Vec::with_capacity(selected.len());

    for anchor in &selected {
        labels.push(
            names
                .get(anchor.label_idx)
                .cloned()
                .unwrap_or_else(|| "Unknown".to_string()),
        );
        anchor_vectors.push(anchor.centroid.clone());
        weights.push(anchor.density.max(1));

        if let Some(bucket) = buckets.get(&anchor.key) {
            for (idx, _residual) in &bucket.samples {
                representative_tag_indices.insert(*idx);
            }
        }
        representative_tag_indices.insert(anchor.label_idx);
    }

    println!(
        "[Vexus-Lite][EPA] density-residual sampling finished: anchors={}, representative_tags={}, svd_rows={}, elapsed={:.2}ms",
        selected.len(),
        representative_tag_indices.len(),
        anchor_vectors.len(),
        started_at.elapsed().as_secs_f64() * 1000.0
    );

    (
        anchor_vectors,
        weights,
        labels,
        selected.len(),
        representative_tag_indices.len(),
        buckets.len(),
    )
}

impl Task for EpaBasisTask {
    type Output = EpaBasisResult;
    type JsValue = EpaBasisResult;

    fn compute(&mut self) -> Result<Self::Output> {
        use nalgebra::DMatrix;
        use std::time::Instant;

        let start = Instant::now();
        let dim = self.dimensions as usize;
        println!(
            "[Vexus-Lite][EPA] compute_epa_basis started: db={}, dim={}, cluster_count={}, max_basis_dim={}",
            self.db_path,
            dim,
            self.cluster_count,
            self.max_basis_dim
        );

        let mut tag_names = Vec::new();
        let mut tag_vectors = Vec::new();

        with_registered_read(&self.db_path, |connection| {
            let mut statement = connection
                .prepare("SELECT name, vector FROM tags WHERE vector IS NOT NULL")
                .map_err(|error| format!("Prepare tags failed: {}", error))?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
                })
                .map_err(|error| format!("Query tags failed: {}", error))?;

            for row in rows {
                let (name, bytes) =
                    row.map_err(|error| format!("Decode EPA Tag row failed: {}", error))?;
                if bytes.len() != dim * 4 {
                    continue;
                }
                let mut vector: Vec<f32> = bytes
                    .chunks_exact(4)
                    .map(|chunk| f32::from_ne_bytes(chunk.try_into().unwrap()))
                    .collect();
                normalize_f32_vector(&mut vector);
                tag_names.push(name);
                tag_vectors.push(vector);
            }
            Ok(())
        })
        .map_err(Error::from_reason)?;

        println!(
            "[Vexus-Lite][EPA] loaded tag vectors: count={} elapsed={:.2}ms",
            tag_vectors.len(),
            start.elapsed().as_secs_f64() * 1000.0
        );

        let tag_count = tag_vectors.len();
        if tag_count < 8 {
            return Ok(EpaBasisResult {
                success: false,
                message: "not enough tag vectors".to_string(),
                tag_count: tag_count as u32,
                cluster_count: 0,
                basis_count: 0,
                elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
                algorithm: "density-residual-sampling".to_string(),
                phase_summary: "load=not_enough_vectors".to_string(),
                anchor_count: 0,
                representative_sample_count: 0,
                density_bucket_count: 0,
                publish_elapsed_ms: 0.0,
            });
        }

        let requested_anchors = std::cmp::min(tag_count, self.cluster_count as usize);
        println!(
            "[Vexus-Lite][EPA] density-residual sampling phase started: tag_count={}, requested_anchors={}, elapsed={:.2}ms",
            tag_count,
            requested_anchors,
            start.elapsed().as_secs_f64() * 1000.0
        );
        let (
            centroids,
            weights,
            labels,
            anchor_count,
            representative_tag_count,
            density_bucket_count,
        ) = select_epa_density_residual_samples(&tag_vectors, &tag_names, requested_anchors, dim);
        let k_clusters = centroids.len();
        println!(
            "[Vexus-Lite][EPA] density-residual sampling phase finished: buckets={}, anchors={}, representative_tags={}, svd_rows={}, elapsed={:.2}ms",
            density_bucket_count,
            anchor_count,
            representative_tag_count,
            k_clusters,
            start.elapsed().as_secs_f64() * 1000.0
        );
        let total_weight: usize = weights.iter().sum();

        if total_weight == 0 {
            return Ok(EpaBasisResult {
                success: false,
                message: "empty EPA clusters".to_string(),
                tag_count: tag_count as u32,
                cluster_count: k_clusters as u32,
                basis_count: 0,
                elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
                algorithm: "density-residual-sampling".to_string(),
                phase_summary: "sampling=empty_clusters".to_string(),
                anchor_count: anchor_count as u32,
                representative_sample_count: k_clusters as u32,
                density_bucket_count: density_bucket_count as u32,
                publish_elapsed_ms: 0.0,
            });
        }

        let mut mean = vec![0.0f32; dim];
        for (idx, centroid) in centroids.iter().enumerate() {
            let weight = weights[idx] as f32;
            for d in 0..dim {
                mean[d] += centroid[d] * weight;
            }
        }
        for value in &mut mean {
            *value /= total_weight as f32;
        }

        let mut matrix_data = Vec::with_capacity(k_clusters * dim);
        for (idx, centroid) in centroids.iter().enumerate() {
            let scale = (weights[idx] as f32).sqrt();
            for d in 0..dim {
                matrix_data.push((centroid[d] - mean[d]) * scale);
            }
        }

        println!(
            "[Vexus-Lite][EPA] SVD phase started: matrix={}x{}, elapsed={:.2}ms",
            k_clusters,
            dim,
            start.elapsed().as_secs_f64() * 1000.0
        );
        let matrix = DMatrix::from_row_slice(k_clusters, dim, &matrix_data);
        let svd = matrix.svd(false, true);
        let v_t = svd
            .v_t
            .ok_or_else(|| Error::from_reason("EPA SVD failed to compute V^T".to_string()))?;

        println!(
            "[Vexus-Lite][EPA] SVD phase finished: elapsed={:.2}ms",
            start.elapsed().as_secs_f64() * 1000.0
        );

        let singular_values = svd.singular_values.as_slice();
        let max_basis = std::cmp::min(
            std::cmp::min(singular_values.len(), self.max_basis_dim as usize),
            k_clusters,
        );

        let total_energy: f64 = singular_values
            .iter()
            .take(max_basis)
            .map(|value| {
                let v = *value as f64;
                v * v
            })
            .sum();

        let mut selected_k = max_basis;
        if total_energy > 1e-12 {
            let mut cumulative = 0.0f64;
            for (idx, value) in singular_values.iter().take(max_basis).enumerate() {
                let v = *value as f64;
                cumulative += v * v;
                if cumulative / total_energy > 0.95 {
                    selected_k = std::cmp::max(idx + 1, std::cmp::min(8, max_basis));
                    break;
                }
            }
        }

        let mut basis_b64 = Vec::with_capacity(selected_k);
        let mut energies = Vec::with_capacity(selected_k);
        for i in 0..selected_k {
            let mut basis = Vec::with_capacity(dim);
            for d in 0..dim {
                basis.push(v_t[(i, d)]);
            }
            normalize_f32_vector(&mut basis);
            basis_b64.push(f32_slice_to_base64(&basis));

            let s = singular_values[i] as f64;
            energies.push(s * s);
        }

        let labels_json = labels
            .iter()
            .take(selected_k)
            .map(|label| format!("\"{}\"", json_escape(label)))
            .collect::<Vec<_>>()
            .join(",");

        let basis_json = basis_b64
            .iter()
            .map(|basis| format!("\"{}\"", basis))
            .collect::<Vec<_>>()
            .join(",");

        let energies_json = energies
            .iter()
            .map(|energy| energy.to_string())
            .collect::<Vec<_>>()
            .join(",");

        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0);

        let cache_json = format!(
            "{{\"basis\":[{}],\"mean\":\"{}\",\"energies\":[{}],\"labels\":[{}],\"timestamp\":{},\"tagCount\":{},\"epaAlgorithm\":\"density-residual-sampling\",\"anchorCount\":{},\"representativeSampleCount\":{},\"densityBucketCount\":{},\"svdRows\":{}}}",
            basis_json,
            f32_slice_to_base64(&mean),
            energies_json,
            labels_json,
            timestamp,
            tag_count,
            anchor_count,
            representative_tag_count,
            density_bucket_count,
            k_clusters
        );

        let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
        let cache_sig = stable_sha256_hex(&cache_json);
        let db_identity = sqlite_database_identity(&self.db_path);
        {
            let mut guard = self
                .pending_cache
                .lock()
                .map_err(|e| Error::from_reason(format!("EPA pending cache lock failed: {}", e)))?;
            *guard = Some(EpaPendingCache {
                cache_json,
                cache_sig,
                db_identity,
                tag_count: tag_count as u32,
                cluster_count: k_clusters as u32,
                basis_count: selected_k as u32,
                elapsed_ms,
                algorithm: "density-residual-sampling".to_string(),
                phase_summary: format!(
                    "load_tags={};buckets={};representative_tags={};anchors={};svd_rows={};basis={};compute={:.2}ms",
                    tag_count,
                    density_bucket_count,
                    representative_tag_count,
                    anchor_count,
                    k_clusters,
                    selected_k,
                    elapsed_ms
                ),
                anchor_count: anchor_count as u32,
                representative_sample_count: representative_tag_count as u32,
                density_bucket_count: density_bucket_count as u32,
            });
        }

        println!(
            "[Vexus-Lite][EPA] compute_epa_basis finished and cached in Rust memory: tag_count={}, clusters={}, basis={} elapsed={:.2}ms",
            tag_count,
            k_clusters,
            selected_k,
            elapsed_ms
        );

        Ok(EpaBasisResult {
            success: true,
            message: "computed_pending_publish".to_string(),
            tag_count: tag_count as u32,
            cluster_count: k_clusters as u32,
            basis_count: selected_k as u32,
            elapsed_ms,
            algorithm: "density-residual-sampling".to_string(),
            phase_summary: format!(
                "load_tags={};buckets={};representative_tags={};anchors={};svd_rows={};basis={};compute={:.2}ms",
                tag_count,
                density_bucket_count,
                representative_tag_count,
                anchor_count,
                k_clusters,
                selected_k,
                elapsed_ms
            ),
            anchor_count: anchor_count as u32,
            representative_sample_count: representative_tag_count as u32,
            density_bucket_count: density_bucket_count as u32,
            publish_elapsed_ms: 0.0,
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct IntrinsicResidualTask {
    db_path: String,
    dimensions: u32,
    max_basis: u32,
    min_neighbors: u32,
    model_sig: Option<String>,
    effective_config_json: Option<String>,
}

#[derive(Clone, Copy)]
enum IntrinsicResidualMethod {
    AnchoredGs,
    Centroid,
    Svd,
}

#[derive(Clone)]
struct IntrinsicNeighbor {
    id: i64,
    weight: f64,
    semantic: f64,
}

struct IntrinsicResidualConfig {
    method: IntrinsicResidualMethod,
    max_neighbors: usize,
    max_basis: usize,
    min_neighbors: usize,
    semantic_enabled: bool,
    semantic_peak: f64,
    semantic_sigma: f64,
    semantic_floor: f64,
    semantic_hard_floor: f64,
    min_gain: f64,
    v9_anchor_base: f64,
    v9_anchor_scale: f64,
    v9_anchor_gamma: f64,
    v9_anchor_min: f64,
    v9_anchor_max: f64,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct IntrinsicResidualConfigInput {
    method: Option<String>,
    max_neighbors: Option<usize>,
    max_basis: Option<usize>,
    min_neighbors: Option<usize>,
    semantic_enabled: Option<bool>,
    semantic_peak: Option<f64>,
    semantic_sigma: Option<f64>,
    semantic_floor: Option<f64>,
    semantic_hard_floor: Option<f64>,
    min_gain: Option<f64>,
    position_decay: Option<f64>,
    v9_anchor_base: Option<f64>,
    v9_anchor_scale: Option<f64>,
    v9_anchor_gamma: Option<f64>,
    v9_anchor_min: Option<f64>,
    v9_anchor_max: Option<f64>,
}

fn intrinsic_method_from_name(value: Option<&str>) -> IntrinsicResidualMethod {
    match value
        .unwrap_or("anchored_gs")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "centroid" => IntrinsicResidualMethod::Centroid,
        "svd" => IntrinsicResidualMethod::Svd,
        _ => IntrinsicResidualMethod::AnchoredGs,
    }
}

fn intrinsic_method_name(method: IntrinsicResidualMethod) -> &'static str {
    match method {
        IntrinsicResidualMethod::AnchoredGs => "anchored_gs",
        IntrinsicResidualMethod::Centroid => "centroid",
        IntrinsicResidualMethod::Svd => "svd",
    }
}

fn dot_f32_f64(a: &[f32], b: &[f64], dim: usize) -> f64 {
    let mut dot = 0.0;
    for d in 0..dim {
        dot += (a[d] as f64) * b[d];
    }
    dot
}

fn dot_f64(a: &[f64], b: &[f64], dim: usize) -> f64 {
    let mut dot = 0.0;
    for d in 0..dim {
        dot += a[d] * b[d];
    }
    dot
}

fn residual_norm_from_basis(tag_vec: &[f32], basis: &[Vec<f64>], dim: usize) -> f64 {
    let coeffs = basis
        .iter()
        .map(|u| dot_f32_f64(tag_vec, u, dim))
        .collect::<Vec<_>>();

    let mut residual_sq = 0.0;
    for d in 0..dim {
        let mut projection = 0.0;
        for (coeff, u) in coeffs.iter().zip(basis.iter()) {
            projection += coeff * u[d];
        }
        let diff = (tag_vec[d] as f64) - projection;
        residual_sq += diff * diff;
    }
    residual_sq.sqrt()
}

fn semantic_gate(sim: f64, cfg: &IntrinsicResidualConfig) -> f64 {
    if !cfg.semantic_enabled {
        return 1.0;
    }
    if !sim.is_finite() || sim <= 0.0 {
        return cfg.semantic_floor;
    }
    if sim < cfg.semantic_hard_floor {
        return 0.0;
    }
    let bell = 0.5
        + 0.8
            * (-((sim - cfg.semantic_peak).powi(2))
                / (2.0 * cfg.semantic_sigma * cfg.semantic_sigma))
                .exp();
    bell.max(cfg.semantic_floor)
}

fn pair_key(a: i64, b: i64) -> (i64, i64) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

fn compute_centroid_residual(
    tag_vec: &[f32],
    neighbors: &[IntrinsicNeighbor],
    tag_vectors: &std::collections::HashMap<i64, Vec<f32>>,
    dim: usize,
) -> Option<f64> {
    let mut centroid = vec![0.0f64; dim];
    let mut total_weight = 0.0;
    for neighbor in neighbors {
        let vec = tag_vectors.get(&neighbor.id)?;
        let weight = neighbor.weight * neighbor.semantic;
        if weight <= 0.0 {
            continue;
        }
        total_weight += weight;
        for d in 0..dim {
            centroid[d] += (vec[d] as f64) * weight;
        }
    }
    if total_weight <= 1e-12 {
        return None;
    }
    for value in &mut centroid {
        *value /= total_weight;
    }
    let mag = dot_f64(&centroid, &centroid, dim).sqrt();
    if mag <= 1e-9 {
        return None;
    }
    for value in &mut centroid {
        *value /= mag;
    }
    Some(residual_norm_from_basis(tag_vec, &[centroid], dim))
}

fn compute_anchored_gs_residual(
    tag_vec: &[f32],
    neighbors: &[IntrinsicNeighbor],
    tag_vectors: &std::collections::HashMap<i64, Vec<f32>>,
    dim: usize,
    cfg: &IntrinsicResidualConfig,
) -> Option<f64> {
    let mut basis: Vec<Vec<f64>> = Vec::with_capacity(cfg.max_basis);
    let mut residual = tag_vec
        .iter()
        .map(|value| *value as f64)
        .collect::<Vec<_>>();
    let mut used = vec![false; neighbors.len()];

    for _ in 0..cfg.max_basis {
        let mut best_index: Option<usize> = None;
        let mut best_score = 0.0;
        let mut best_unit = Vec::new();
        let mut best_gain = 0.0;

        for (idx, neighbor) in neighbors.iter().enumerate() {
            if used[idx] || neighbor.semantic <= 0.0 {
                continue;
            }
            let source = match tag_vectors.get(&neighbor.id) {
                Some(value) => value,
                None => continue,
            };
            let mut candidate = source.iter().map(|value| *value as f64).collect::<Vec<_>>();
            for u in &basis {
                let dot = dot_f64(&candidate, u, dim);
                for d in 0..dim {
                    candidate[d] -= dot * u[d];
                }
            }

            let orth_norm = dot_f64(&candidate, &candidate, dim).sqrt();
            if orth_norm <= 1e-6 {
                continue;
            }
            for value in &mut candidate {
                *value /= orth_norm;
            }

            let explain_gain = dot_f64(&residual, &candidate, dim).abs();
            let topology = (1.0 + neighbor.weight).ln().max(1e-6);
            let score = explain_gain * orth_norm * topology * neighbor.semantic;

            if score > best_score {
                best_score = score;
                best_gain = explain_gain;
                best_index = Some(idx);
                best_unit = candidate;
            }
        }

        let Some(idx) = best_index else {
            break;
        };
        if best_gain < cfg.min_gain {
            break;
        }

        used[idx] = true;
        let signed_gain = dot_f64(&residual, &best_unit, dim);
        for d in 0..dim {
            residual[d] -= signed_gain * best_unit[d];
        }
        basis.push(best_unit);
    }

    if basis.is_empty() {
        None
    } else {
        Some(dot_f64(&residual, &residual, dim).sqrt())
    }
}

fn compute_svd_residual(
    tag_vec: &[f32],
    neighbors: &[IntrinsicNeighbor],
    tag_vectors: &std::collections::HashMap<i64, Vec<f32>>,
    dim: usize,
    max_k: usize,
) -> Option<f64> {
    use nalgebra::DMatrix;

    let mut flat = Vec::with_capacity(neighbors.len() * dim);
    let mut n = 0usize;
    for neighbor in neighbors {
        if let Some(vec) = tag_vectors.get(&neighbor.id) {
            flat.extend_from_slice(vec);
            n += 1;
        }
    }
    if n == 0 {
        return None;
    }

    let matrix = DMatrix::from_row_slice(n, dim, &flat);
    let svd = matrix.svd(false, true);
    let v_t = svd.v_t?;
    let k = max_k.min(n).min(dim);
    let mut basis = Vec::with_capacity(k);
    for i in 0..k {
        let mut row = Vec::with_capacity(dim);
        for d in 0..dim {
            row.push(v_t[(i, d)] as f64);
        }
        basis.push(row);
    }

    Some(residual_norm_from_basis(tag_vec, &basis, dim))
}

impl Task for IntrinsicResidualTask {
    type Output = IntrinsicResidualResult;
    type JsValue = IntrinsicResidualResult;

    fn compute(&mut self) -> Result<Self::Output> {
        use std::collections::HashMap;
        use std::time::Instant;

        let start = Instant::now();
        let dim = self.dimensions as usize;
        let config_input: IntrinsicResidualConfigInput = match self.effective_config_json.as_deref()
        {
            Some(raw) => serde_json::from_str(raw).map_err(|e| {
                Error::from_reason(format!(
                    "Invalid intrinsic residual effective config JSON: {}",
                    e
                ))
            })?,
            None => IntrinsicResidualConfigInput::default(),
        };
        let config_source = if self.effective_config_json.is_some() {
            "js_snapshot"
        } else {
            "legacy_args_and_defaults"
        };
        let method = intrinsic_method_from_name(config_input.method.as_deref());
        let max_neighbors = config_input.max_neighbors.unwrap_or(48).clamp(4, 256);
        let max_basis = config_input
            .max_basis
            .unwrap_or(self.max_basis as usize)
            .clamp(1, 32);
        let min_neighbors = config_input
            .min_neighbors
            .unwrap_or(self.min_neighbors as usize)
            .clamp(1, 64);
        let semantic_enabled = config_input.semantic_enabled.unwrap_or(true);
        let semantic_peak = config_input.semantic_peak.unwrap_or(0.65).clamp(-1.0, 1.0);
        let semantic_sigma = config_input.semantic_sigma.unwrap_or(0.25).clamp(0.02, 2.0);
        let semantic_floor = config_input.semantic_floor.unwrap_or(0.35).clamp(0.0, 1.0);
        let semantic_hard_floor = config_input
            .semantic_hard_floor
            .unwrap_or(-1.0)
            .clamp(-1.0, 1.0);
        let min_gain = config_input.min_gain.unwrap_or(0.015).clamp(0.0, 1.0);
        let distance_decay = config_input.position_decay.unwrap_or(0.15).clamp(0.0, 4.0);
        let v9_anchor_base = config_input.v9_anchor_base.unwrap_or(0.75).clamp(0.0, 4.0);
        let v9_anchor_scale = config_input.v9_anchor_scale.unwrap_or(1.25).clamp(0.0, 4.0);
        let v9_anchor_gamma = config_input.v9_anchor_gamma.unwrap_or(1.0).clamp(0.1, 8.0);
        let v9_anchor_min = config_input.v9_anchor_min.unwrap_or(0.5).clamp(0.0, 4.0);
        let v9_anchor_max = config_input.v9_anchor_max.unwrap_or(2.0).clamp(0.0, 8.0);

        let cfg = IntrinsicResidualConfig {
            method,
            max_neighbors,
            max_basis,
            min_neighbors,
            semantic_enabled,
            semantic_peak,
            semantic_sigma,
            semantic_floor,
            semantic_hard_floor,
            min_gain,
            v9_anchor_base,
            v9_anchor_scale,
            v9_anchor_gamma,
            v9_anchor_min: v9_anchor_min.min(v9_anchor_max),
            v9_anchor_max: v9_anchor_max.max(v9_anchor_min),
        };
        const INTRINSIC_ALGORITHM_VERSION: &str = "intrinsic_residual_ratio_v9_1_single_track";
        let effective_config = format!(
            "{{\"algorithm\":\"{}\",\"method\":\"{}\",\"dimension\":{},\"maxNeighbors\":{},\"maxBasis\":{},\"minNeighbors\":{},\"semanticEnabled\":{},\"semanticPeak\":{},\"semanticSigma\":{},\"semanticFloor\":{},\"semanticHardFloor\":{},\"minGain\":{},\"positionDecay\":{},\"v9AnchorBase\":{},\"v9AnchorScale\":{},\"v9AnchorGamma\":{},\"v9AnchorMin\":{},\"v9AnchorMax\":{}}}",
            INTRINSIC_ALGORITHM_VERSION,
            intrinsic_method_name(cfg.method),
            dim,
            cfg.max_neighbors,
            cfg.max_basis,
            cfg.min_neighbors,
            cfg.semantic_enabled,
            cfg.semantic_peak,
            cfg.semantic_sigma,
            cfg.semantic_floor,
            cfg.semantic_hard_floor,
            cfg.min_gain,
            distance_decay,
            cfg.v9_anchor_base,
            cfg.v9_anchor_scale,
            cfg.v9_anchor_gamma,
            cfg.v9_anchor_min,
            cfg.v9_anchor_max
        );
        let config_hash = stable_sha256_hex(&effective_config);

        let mut tag_vectors: HashMap<i64, Vec<f32>> = HashMap::new();
        let mut adjacency: HashMap<i64, HashMap<i64, f64>> = HashMap::new();
        let mut pairwise_similarity: HashMap<(i64, i64), f64> = HashMap::new();
        let mut skipped_files = 0usize;
        let mut edge_updates = 0usize;
        let load_started = Instant::now();
        let mut content_hasher = {
            use sha2::Digest;
            sha2::Sha256::new()
        };

        with_registered_read(&self.db_path, |conn| {
            let mut stmt = conn
                .prepare("SELECT id, vector FROM tags WHERE vector IS NOT NULL ORDER BY id")
                .map_err(|e| format!("Prepare failed: {}", e))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
                })
                .map_err(|e| format!("Query failed: {}", e))?;

            for row in rows {
                let (id, bytes) = row.map_err(|e| {
                    format!("Decode intrinsic Tag row failed: {}", e)
                })?;
                {
                    use sha2::Digest;
                    content_hasher.update(id.to_le_bytes());
                    content_hasher.update((bytes.len() as u64).to_le_bytes());
                    content_hasher.update(&bytes);
                }
                if bytes.len() == dim * 4 {
                    let mut vec: Vec<f32> = bytes
                        .chunks_exact(4)
                        .map(|c| f32::from_ne_bytes(c.try_into().unwrap()))
                        .collect();
                    // P0: residual 必须是单位向量相对于局部子空间的不可解释比例。
                    // 不再隐含依赖 embedding 服务已经归一化。
                    normalize_f32_vector(&mut vec);
                    tag_vectors.insert(id, vec);
                }
            }

            let force_recompute = std::env::var("TAGMEMO_INTRINSIC_RESIDUAL_FORCE_RECOMPUTE")
                .map(|value| {
                    let normalized = value.trim().to_ascii_lowercase();
                    normalized == "true" || normalized == "1" || normalized == "yes"
                })
                .unwrap_or(false);

            if force_recompute {
                println!("[Vexus-Lite][IntrinsicResidual] force recompute enabled by TAGMEMO_INTRINSIC_RESIDUAL_FORCE_RECOMPUTE.");
            }

            let adjacency_started = Instant::now();
            let mut stmt = conn.prepare(
                "SELECT file_id, tag_id, COALESCE(position, 0) FROM file_tags ORDER BY file_id, position"
            ).map_err(|e| format!("Prepare adjacency query failed: {}", e))?;

            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })
                .map_err(|e| {
                    format!("Execute adjacency query failed: {}", e)
                })?;

            let flush = |tags: &[(i64, i64)],
                         graph: &mut HashMap<i64, HashMap<i64, f64>>,
                         updates: &mut usize,
                         skipped: &mut usize| {
                if tags.len() < 2 {
                    return;
                }
                if tags.len() > 100 {
                    *skipped += 1;
                    return;
                }
                for i in 0..tags.len() {
                    for j in 0..tags.len() {
                        if i == j || tags[i].0 == tags[j].0 {
                            continue;
                        }
                        let delta = if tags[i].1 > 0 && tags[j].1 > 0 {
                            (tags[i].1 - tags[j].1).abs().max(1) as f64
                        } else {
                            1.0
                        };
                        let weight = if distance_decay > 0.0 {
                            (-distance_decay * (delta - 1.0)).exp()
                        } else {
                            1.0
                        };
                        let entry = graph
                            .entry(tags[i].0)
                            .or_default()
                            .entry(tags[j].0)
                            .or_insert(0.0);
                        *entry += weight;
                        *updates += 1;
                    }
                }
            };

            let mut current_file_id = -1_i64;
            let mut file_tags: Vec<(i64, i64)> = Vec::with_capacity(64);

            for row in rows {
                let (fid, tid, position) = row.map_err(|e| {
                    format!("Decode intrinsic adjacency row failed: {}", e)
                })?;
                {
                    use sha2::Digest;
                    content_hasher.update(fid.to_le_bytes());
                    content_hasher.update(tid.to_le_bytes());
                    content_hasher.update(position.to_le_bytes());
                }
                if fid != current_file_id {
                    flush(
                        &file_tags,
                        &mut adjacency,
                        &mut edge_updates,
                        &mut skipped_files,
                    );
                    file_tags.clear();
                    current_file_id = fid;
                }
                file_tags.push((tid, position));
            }
            flush(
                &file_tags,
                &mut adjacency,
                &mut edge_updates,
                &mut skipped_files,
            );

            println!(
                "[Vexus-Lite][IntrinsicResidual] adjacency built: sources={}, edge_updates={}, skipped_files={}, elapsed={:.2}ms",
                adjacency.len(),
                edge_updates,
                skipped_files,
                adjacency_started.elapsed().as_secs_f64() * 1000.0
            );

            if cfg.semantic_enabled {
                if let Some(model_sig) = &self.model_sig {
                    let pair_started = Instant::now();
                    let mut stmt = conn
                        .prepare("SELECT tag_a, tag_b, similarity FROM tag_pair_similarity WHERE model_sig = ?1")
                        .map_err(|e| format!("Prepare pairwise similarity query failed: {}", e))?;
                    let rows = stmt
                        .query_map(rusqlite::params![model_sig], |row| {
                            Ok((
                                row.get::<_, i64>(0)?,
                                row.get::<_, i64>(1)?,
                                row.get::<_, f64>(2)?,
                            ))
                        })
                        .map_err(|e| {
                            format!("Query pairwise similarity failed: {}", e)
                        })?;

                    for row in rows {
                        let (a, b, sim) = row.map_err(|e| {
                            format!(
                                "Decode pairwise similarity row failed: {}",
                                e
                            )
                        })?;
                        pairwise_similarity.insert(pair_key(a, b), sim);
                    }
                    println!(
                        "[Vexus-Lite][IntrinsicResidual] semantic cache loaded: pairs={}, model_sig={}, elapsed={:.2}ms",
                        pairwise_similarity.len(),
                        model_sig,
                        pair_started.elapsed().as_secs_f64() * 1000.0
                    );
                } else {
                    println!("[Vexus-Lite][IntrinsicResidual] semantic gate enabled but model_sig missing; using semantic floor.");
                }
            }
            Ok(())
        })
        .map_err(Error::from_reason)?;

        let content_digest = {
            use sha2::Digest;
            format!("{:x}", content_hasher.finalize())
        };
        let graph_generation = format!(
            "content:{}:tags:{}:sources:{}:edge_updates:{}:skipped_files:{}",
            content_digest,
            tag_vectors.len(),
            adjacency.len(),
            edge_updates,
            skipped_files
        );
        let model_sig_value = self.model_sig.as_deref().unwrap_or("missing-model-sig");
        let artifact_sig = stable_sha256_hex(&format!(
            "{}|{}|{}|{}",
            model_sig_value, graph_generation, INTRINSIC_ALGORITHM_VERSION, config_hash
        ));

        let force_recompute = std::env::var("TAGMEMO_INTRINSIC_RESIDUAL_FORCE_RECOMPUTE")
            .map(|value| {
                let normalized = value.trim().to_ascii_lowercase();
                normalized == "true" || normalized == "1" || normalized == "yes"
            })
            .unwrap_or(false);
        if !force_recompute && !tag_vectors.is_empty() {
            let cached_count = with_registered_read(&self.db_path, |connection| {
                Ok(
                    connection
                        .query_row(
                            "SELECT COUNT(*) FROM tag_intrinsic_residual_status WHERE artifact_sig = ?1",
                            rusqlite::params![&artifact_sig],
                            |row| row.get::<_, i64>(0),
                        )
                        .unwrap_or(0)
                        .max(0) as usize,
                )
            })
            .map_err(Error::from_reason)?;

            if cached_count >= tag_vectors.len() {
                let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                println!(
                    "[Vexus-Lite][IntrinsicResidual] artifact cache complete; skipping recompute: artifact={}, processed={}, tags={}, elapsed={:.2}ms",
                    artifact_sig,
                    cached_count,
                    tag_vectors.len(),
                    elapsed
                );
                return Ok(IntrinsicResidualResult {
                    tag_count: tag_vectors.len() as u32,
                    computed_count: 0,
                    skipped_count: tag_vectors.len() as u32,
                    elapsed_ms: elapsed,
                    algorithm_version: INTRINSIC_ALGORITHM_VERSION.to_string(),
                    artifact_sig,
                    effective_config,
                });
            }
            println!(
                "[Vexus-Lite][IntrinsicResidual] artifact cache incomplete: artifact={}, processed={}, tags={}",
                artifact_sig,
                cached_count,
                tag_vectors.len()
            );
        }

        println!(
            "[Vexus-Lite][IntrinsicResidual] input loaded: tags={}, config_source={}, effective_config={}, artifact={}, load_elapsed={:.2}ms",
            tag_vectors.len(),
            config_source,
            effective_config,
            artifact_sig,
            load_started.elapsed().as_secs_f64() * 1000.0
        );

        let tag_count = tag_vectors.len() as u32;
        let mut computed = 0u32;
        let mut skipped = 0u32;
        let mut total_neighbors = 0usize;
        let mut results: Vec<(i64, f64, usize)> = Vec::new();
        let mut status_results: Vec<(i64, &'static str, usize, Option<String>)> =
            Vec::with_capacity(tag_vectors.len());
        let compute_started = Instant::now();

        for (&tag_id, tag_vec) in &tag_vectors {
            if (computed + skipped) > 0 && (computed + skipped) % 1000 == 0 {
                let avg_neighbors = if computed > 0 {
                    total_neighbors as f64 / computed as f64
                } else {
                    0.0
                };
                println!(
                    "[Vexus-Lite][IntrinsicResidual] progress: processed={}, computed={}, skipped={}, avg_neighbors={:.2}, elapsed={:.2}ms",
                    computed + skipped,
                    computed,
                    skipped,
                    avg_neighbors,
                    start.elapsed().as_secs_f64() * 1000.0
                );
            }

            let neighbors = match adjacency.get(&tag_id) {
                Some(value) => value,
                None => {
                    skipped += 1;
                    status_results.push((tag_id, "insufficient_neighbors", 0, None));
                    continue;
                }
            };

            let mut candidates = Vec::with_capacity(neighbors.len().min(cfg.max_neighbors));
            for (&nid, &weight) in neighbors {
                if !tag_vectors.contains_key(&nid) {
                    continue;
                }
                let sim = pairwise_similarity
                    .get(&pair_key(tag_id, nid))
                    .copied()
                    .unwrap_or(0.0);
                let semantic = semantic_gate(sim, &cfg);
                if semantic <= 0.0 {
                    continue;
                }
                candidates.push(IntrinsicNeighbor {
                    id: nid,
                    weight,
                    semantic,
                });
            }

            candidates.sort_by(|a, b| {
                let sa = a.weight * a.semantic;
                let sb = b.weight * b.semantic;
                sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
            });
            if candidates.len() > cfg.max_neighbors {
                candidates.truncate(cfg.max_neighbors);
            }

            if candidates.len() < cfg.min_neighbors {
                skipped += 1;
                status_results.push((tag_id, "insufficient_neighbors", candidates.len(), None));
                continue;
            }

            let residual_energy = match cfg.method {
                IntrinsicResidualMethod::AnchoredGs => {
                    compute_anchored_gs_residual(tag_vec, &candidates, &tag_vectors, dim, &cfg)
                }
                IntrinsicResidualMethod::Centroid => {
                    compute_centroid_residual(tag_vec, &candidates, &tag_vectors, dim)
                }
                IntrinsicResidualMethod::Svd => {
                    compute_svd_residual(tag_vec, &candidates, &tag_vectors, dim, cfg.max_basis)
                }
            };

            if let Some(value) = residual_energy {
                total_neighbors += candidates.len();
                // 输入已单位化且基底正交，理论范围为 [0,1]；夹逼仅吸收浮点误差。
                let raw_residual_ratio = value.clamp(0.0, 1.0);
                results.push((tag_id, raw_residual_ratio, candidates.len()));
                status_results.push((tag_id, "computed", candidates.len(), None));
                computed += 1;
            } else {
                skipped += 1;
                status_results.push((
                    tag_id,
                    "failed",
                    candidates.len(),
                    Some("residual method produced no usable basis".to_string()),
                ));
            }
        }

        println!(
            "[Vexus-Lite][IntrinsicResidual] compute phase finished: computed={}, skipped={}, avg_neighbors={:.2}, elapsed={:.2}ms",
            computed,
            skipped,
            if computed > 0 { total_neighbors as f64 / computed as f64 } else { 0.0 },
            compute_started.elapsed().as_secs_f64() * 1000.0
        );

        if !status_results.is_empty() {
            let write_started = Instant::now();
            let max_r = results.iter().map(|r| r.1).fold(0.0f64, f64::max);
            let min_r = results.iter().map(|r| r.1).fold(f64::MAX, f64::min);

            // V9.1 单轨：原始 residual ratio 直接进入固定、数据库无关的锚增益映射。
            // 不再计算依赖全库分布的 V8.3 median/MAD 兼容增益，避免任一离群标签
            // 重新标定其他节点，也避免退休资产在全量重建后被原生侧重新写回。
            let computed_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or(0);

            let artifact_sig_for_write = artifact_sig.clone();
            let graph_generation_for_write = graph_generation.clone();
            let effective_config_for_write = effective_config.clone();
            let config_hash_for_write = config_hash.clone();
            let model_sig_for_write = model_sig_value.to_string();
            let results_for_write = results.clone();
            let status_results_for_write = status_results.clone();
            let v9_anchor_base_for_write = cfg.v9_anchor_base;
            let v9_anchor_scale_for_write = cfg.v9_anchor_scale;
            let v9_anchor_gamma_for_write = cfg.v9_anchor_gamma;
            let v9_anchor_min_for_write = cfg.v9_anchor_min;
            let v9_anchor_max_for_write = cfg.v9_anchor_max;
            let db_path_for_write = self.db_path.clone();

            with_registered_write(&db_path_for_write, move |tx| {
            // 数值表保存当前健康 V9.1 artifact；residual_energy 作为 V9.1 锚增益的
            // 通用兼容镜像。退休的 v8_3_compat_gain 列保留物理结构但写入 NULL。
            // 状态表按 artifact 版本化保留，允许 skipped/failed 也参与完整性判断。
            tx.execute("DELETE FROM tag_intrinsic_residuals", [])
                .map_err(|e| format!("Residual value clear failed: {}", e))?;
            tx.execute(
                "DELETE FROM tag_intrinsic_residual_status WHERE artifact_sig = ?1",
                rusqlite::params![&artifact_sig_for_write],
            )
            .map_err(|e| format!("Residual status clear failed: {}", e))?;

            tx.execute(
                "INSERT OR REPLACE INTO tagmemo_artifacts \
                 (artifact_sig, asset_type, model_sig, graph_generation, algorithm_version, config_hash, effective_config, status, created_at, updated_at) \
                 VALUES (?1, 'intrinsic_residual', ?2, ?3, ?4, ?5, ?6, 'ready', ?7, ?7)",
                rusqlite::params![
                    &artifact_sig_for_write,
                    &model_sig_for_write,
                    &graph_generation_for_write,
                    INTRINSIC_ALGORITHM_VERSION,
                    &config_hash_for_write,
                    &effective_config_for_write,
                    computed_at
                ],
            )
            .map_err(|e| format!("Residual artifact registration failed: {}", e))?;

            {
                let mut insert = tx.prepare(
                    "INSERT INTO tag_intrinsic_residuals \
                     (tag_id, residual_energy, neighbor_count, raw_residual_ratio, v8_3_compat_gain, v9_anchor_gain, model_sig, artifact_sig, algorithm_version, config_hash, status) \
                     VALUES (?1, ?2, ?3, ?4, NULL, ?2, ?5, ?6, ?7, ?8, 'computed')"
                ).map_err(|e| format!("Prepare residual value insert failed: {}", e))?;

                for (tag_id, raw_residual, n_count) in &results_for_write {
                    // V9.1 使用数据库无关的固定单调映射；该值同时作为 residual_energy
                    // 通用镜像，旧读取器仍能获得有效增益，但不再生成 V8.3 专属数值。
                    let v9_anchor_gain = (v9_anchor_base_for_write
                        + v9_anchor_scale_for_write
                            * raw_residual.powf(v9_anchor_gamma_for_write))
                    .clamp(v9_anchor_min_for_write, v9_anchor_max_for_write);
                    insert
                        .execute(rusqlite::params![
                            tag_id,
                            v9_anchor_gain,
                            *n_count as i64,
                            raw_residual,
                            &model_sig_for_write,
                            &artifact_sig_for_write,
                            INTRINSIC_ALGORITHM_VERSION,
                            &config_hash_for_write
                        ])
                        .map_err(|e| {
                            format!("Residual value insert failed: {}", e)
                        })?;
                }
            }

            {
                let mut insert_status = tx
                    .prepare(
                        "INSERT OR REPLACE INTO tag_intrinsic_residual_status \
                     (tag_id, artifact_sig, status, neighbor_count, error_message, computed_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    )
                    .map_err(|e| {
                        format!("Prepare residual status insert failed: {}", e)
                    })?;

                for (tag_id, status, neighbor_count, error_message) in &status_results_for_write {
                    insert_status
                        .execute(rusqlite::params![
                            tag_id,
                            &artifact_sig_for_write,
                            status,
                            *neighbor_count as i64,
                            error_message,
                            computed_at
                        ])
                        .map_err(|e| {
                            format!("Residual status insert failed: {}", e)
                        })?;
                }
            }

            Ok(crate::storage::WriteReceipt {
                operation: "publish_intrinsic_residuals".to_string(),
                database_generation: 0,
                facts_changed: false,
            })
            })
            .map_err(|error| Error::from_reason(format!(
                "Intrinsic residual Write Actor publish failed: {}",
                error
            )))?;

            println!(
                "[Vexus-Lite][IntrinsicResidual] V9.1 single-track write finished: values={}, statuses={}, artifact={}, raw_min={:.6}, raw_max={:.6}, elapsed={:.2}ms",
                results.len(),
                status_results.len(),
                artifact_sig,
                if results.is_empty() { 0.0 } else { min_r },
                max_r,
                write_started.elapsed().as_secs_f64() * 1000.0
            );
        }

        let elapsed = start.elapsed().as_secs_f64() * 1000.0;

        Ok(IntrinsicResidualResult {
            tag_count,
            computed_count: computed,
            skipped_count: skipped,
            elapsed_ms: elapsed,
            algorithm_version: INTRINSIC_ALGORITHM_VERSION.to_string(),
            artifact_sig,
            effective_config,
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// 🌟 TagMemo V8.2: PairwiseSimTask
/// 预计算实际共现的 Tag 对的余弦相似度，并写入 tag_pair_similarity。
pub struct PairwiseSimTask {
    db_path: String,
    dimensions: u32,
    model_sig: String,
    min_similarity: f64,
    full_rebuild: bool,
}

impl Task for PairwiseSimTask {
    type Output = PairwiseSimResult;
    type JsValue = PairwiseSimResult;

    fn compute(&mut self) -> Result<Self::Output> {
        use std::collections::{HashMap, HashSet};
        use std::time::Instant;

        let start = Instant::now();
        let dim = self.dimensions as usize;
        const PAIRWISE_ALGORITHM_VERSION: &str = "pairwise_cosine_v9_1_single_track";
        let effective_config = format!(
            "{{\"algorithm\":\"{}\",\"dimension\":{},\"minSimilarity\":{},\"modelSig\":\"{}\"}}",
            PAIRWISE_ALGORITHM_VERSION,
            dim,
            self.min_similarity,
            json_escape(&self.model_sig)
        );
        let config_hash = stable_sha256_hex(&effective_config);

        // 扫描前代际门禁：事实事务通过 SQLite trigger 单调推进该值。
        // 命中同模型/算法/配置的 ready artifact 时，避免读取全部高维 Tag BLOB、
        // 扫描 file_tags 以及重新构造几十万条 pair_set。
        let fact_generation = with_registered_read(&self.db_path, |connection| {
            Ok(connection
                .query_row(
                    "SELECT value FROM kv_store \
                     WHERE key = 'tagmemo_pairwise_fact_generation'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap_or_else(|_| "unavailable".to_string()))
        })
        .map_err(Error::from_reason)?;
        if !self.full_rebuild && fact_generation != "unavailable" {
            let prefix = format!("fact:{}:%", fact_generation);
            let cached_graph = with_registered_read(&self.db_path, |connection| {
                Ok(connection
                    .query_row(
                        "SELECT graph_generation FROM tagmemo_artifacts \
                         WHERE asset_type = 'pairwise_similarity' \
                           AND model_sig = ?1 \
                           AND algorithm_version = ?2 \
                           AND config_hash = ?3 \
                           AND graph_generation LIKE ?4 \
                           AND status = 'ready' \
                         ORDER BY updated_at DESC LIMIT 1",
                        rusqlite::params![
                            &self.model_sig,
                            PAIRWISE_ALGORITHM_VERSION,
                            &config_hash,
                            &prefix
                        ],
                        |row| row.get::<_, String>(0),
                    )
                    .ok())
            })
            .map_err(Error::from_reason)?;
            if let Some(graph_generation) = cached_graph {
                let pair_count = graph_generation
                    .rsplit_once(":pairs:")
                    .and_then(|(_, value)| value.parse::<u32>().ok())
                    .unwrap_or(0);
                let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
                println!(
                    "[Vexus-Lite][Pairwise] fact generation unchanged; full scan skipped: generation={}, pairs={}, elapsed={:.2}ms",
                    fact_generation, pair_count, elapsed_ms
                );
                return Ok(PairwiseSimResult {
                    pair_count,
                    computed_count: 0,
                    skipped_count: pair_count,
                    stored_count: 0,
                    elapsed_ms,
                });
            }
        }

        // ====================================================================
        // Step 1-3: 只读加载 Tag 向量、共现 pair 与缓存集合
        // ====================================================================
        let mut tag_vectors: HashMap<i64, Vec<f32>> = HashMap::new();
        let mut pair_set: HashSet<(i64, i64)> = HashSet::new();
        let mut max_tag_id = 0_i64;
        let mut file_tag_rows = 0_u64;
        let (pair_count, graph_generation) = with_registered_read_napi(&self.db_path, |conn| {
            let mut content_hasher = {
                use sha2::Digest;
                sha2::Sha256::new()
            };
            let mut stmt = conn
                .prepare("SELECT id, vector FROM tags WHERE vector IS NOT NULL ORDER BY id")
                .map_err(|e| Error::from_reason(format!("Prepare tags query failed: {}", e)))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
                })
                .map_err(|e| Error::from_reason(format!("Query tags failed: {}", e)))?;

            for row in rows {
                let (id, bytes) = row.map_err(|e| {
                    Error::from_reason(format!("Decode pairwise Tag row failed: {}", e))
                })?;
                max_tag_id = max_tag_id.max(id);
                {
                    use sha2::Digest;
                    content_hasher.update(id.to_le_bytes());
                    content_hasher.update((bytes.len() as u64).to_le_bytes());
                    content_hasher.update(&bytes);
                }
                if bytes.len() == dim * 4 {
                    let vec: Vec<f32> = bytes
                        .chunks_exact(4)
                        .map(|c| f32::from_ne_bytes(c.try_into().unwrap()))
                        .collect();
                    tag_vectors.insert(id, vec);
                }
            }

            // ====================================================================
            // Step 2: 在 Rust 侧聚合 file_tags，构建实际共现的 (tag_a, tag_b) 集合
            // 单文件 Tag 数 > 100 的脏文件跳过（与 JS/V7 守恒）
            // 约定 tag_a < tag_b
            // ====================================================================
            let mut stmt = conn
                .prepare("SELECT file_id, tag_id FROM file_tags ORDER BY file_id, tag_id")
                .map_err(|e| {
                    Error::from_reason(format!("Prepare file_tags query failed: {}", e))
                })?;

            let rows = stmt
                .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
                .map_err(|e| Error::from_reason(format!("Query file_tags failed: {}", e)))?;

            let mut current_file_id = -1_i64;
            let mut file_tags: Vec<i64> = Vec::with_capacity(64);

            let flush = |tags: &Vec<i64>, set: &mut HashSet<(i64, i64)>| {
                if tags.len() < 2 || tags.len() > 100 {
                    return;
                }
                for i in 0..tags.len() {
                    for j in (i + 1)..tags.len() {
                        let a = tags[i];
                        let b = tags[j];
                        if a == b {
                            continue;
                        }
                        let pair = if a < b { (a, b) } else { (b, a) };
                        set.insert(pair);
                    }
                }
            };

            for row in rows {
                let (fid, tid) = row.map_err(|e| {
                    Error::from_reason(format!("Decode pairwise file_tags row failed: {}", e))
                })?;
                file_tag_rows += 1;
                max_tag_id = max_tag_id.max(tid);
                {
                    use sha2::Digest;
                    content_hasher.update(fid.to_le_bytes());
                    content_hasher.update(tid.to_le_bytes());
                }
                if fid != current_file_id {
                    flush(&file_tags, &mut pair_set);
                    file_tags.clear();
                    current_file_id = fid;
                }
                file_tags.push(tid);
            }
            flush(&file_tags, &mut pair_set);

            let content_digest = {
                use sha2::Digest;
                format!("{:x}", content_hasher.finalize())
            };
            let pair_count = pair_set.len() as u32;
            let graph_generation = format!(
                "fact:{}:content:{}:tags:{}:max_tag:{}:file_tag_rows:{}:pairs:{}",
                fact_generation,
                content_digest,
                tag_vectors.len(),
                max_tag_id,
                file_tag_rows,
                pair_count
            );
            Ok((pair_count, graph_generation))
        })
        .map_err(|error| Error::from_reason(error.reason.clone()))?;

        let artifact_sig = stable_sha256_hex(&format!(
            "{}|{}|{}|{}",
            self.model_sig, graph_generation, PAIRWISE_ALGORITHM_VERSION, config_hash
        ));

        // ====================================================================
        // Step 3: 增量模式 — 跨图代际加载兼容的正/负 pair 状态。
        //
        // artifact_sig 包含完整 graph_generation；只按当前 artifact 查询会导致
        // 任意新增 file_tag / pair 都生成新签名，使旧图中几十万条未变化 pair
        // 全部失去命中。pair 的余弦值只依赖：
        //   model_sig + dimension + algorithm + min_similarity + 两端向量。
        // Tag 向量更新会由 SQLite 事实事务删除涉及该 Tag 的正值与状态行，
        // 因此这里可以安全地跨 graph_generation 复用兼容 artifact 的状态。
        //
        // full_rebuild = true 时仍按显式重建语义清空并重算全部 pair。
        // 非 full_rebuild 不主动删除旧 model_sig，旧模型清理由 JS 在当前模型
        // 已产生健康缓存后执行，避免空库/签名切换窗口形成缓存真空。
        // ====================================================================
        let cached: HashSet<(i64, i64)> = if !self.full_rebuild {
            let model_sig_for_read = self.model_sig.clone();
            let config_hash_for_read = config_hash.clone();
            let min_similarity_for_read = self.min_similarity;
            with_registered_read(&self.db_path, move |connection| {
                let mut cached = HashSet::new();
                let mut stmt = connection
                    .prepare(
                        "SELECT DISTINCT s.tag_a, s.tag_b \
                         FROM tag_pair_similarity_status s \
                         JOIN tagmemo_artifacts a ON a.artifact_sig = s.artifact_sig \
                         WHERE s.model_sig = ?1 \
                           AND s.min_similarity = ?2 \
                           AND s.status IN ('computed', 'below_threshold', 'missing_vector') \
                           AND a.asset_type = 'pairwise_similarity' \
                           AND a.model_sig = ?1 \
                           AND a.algorithm_version = ?3 \
                           AND a.config_hash = ?4 \
                           AND a.status = 'ready'",
                    )
                    .map_err(|e| {
                        format!(
                            "Prepare compatible pairwise status cache query failed: {}",
                            e
                        )
                    })?;
                let rows = stmt
                    .query_map(
                        rusqlite::params![
                            &model_sig_for_read,
                            min_similarity_for_read,
                            PAIRWISE_ALGORITHM_VERSION,
                            &config_hash_for_read
                        ],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                    )
                    .map_err(|e| format!("Query compatible pairwise status cache failed: {}", e))?;

                for row in rows {
                    let (a, b) = row.map_err(|e| {
                        format!("Decode compatible pairwise status row failed: {}", e)
                    })?;
                    cached.insert(pair_key(a, b));
                }
                Ok(cached)
            })
            .map_err(Error::from_reason)?
        } else {
            HashSet::new()
        };

        println!(
            "[Vexus-Lite][Pairwise] artifact={} graph_generation={} cached_statuses={}",
            artifact_sig,
            graph_generation,
            cached.len()
        );

        // ====================================================================
        // Step 4: 遍历待计算 pair，计算余弦相似度
        // 假设 tag 向量已归一化（embedding 模型默认输出归一化向量），
        // 若未归一化，下方会按需 fallback 到带分母的余弦
        // ====================================================================
        let mut to_insert: Vec<(i64, i64, f64, i64)> = Vec::new();
        let mut status_rows: Vec<(i64, i64, &'static str, Option<f64>, i64)> = Vec::new();
        let mut computed = 0_u32;
        let mut skipped = 0_u32;
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        // 预先为每个 tag 计算并缓存模长（仅在第一次需要时）
        let mut norm_cache: HashMap<i64, f32> = HashMap::new();
        let get_norm = |id: i64, vec: &Vec<f32>, cache: &mut HashMap<i64, f32>| -> f32 {
            if let Some(&n) = cache.get(&id) {
                return n;
            }
            let mut s = 0.0_f32;
            for &x in vec.iter() {
                s += x * x;
            }
            let n = s.sqrt();
            cache.insert(id, n);
            n
        };

        for &(a, b) in pair_set.iter() {
            if cached.contains(&(a, b)) {
                skipped += 1;
                continue;
            }

            let va = match tag_vectors.get(&a) {
                Some(v) => v,
                None => {
                    skipped += 1;
                    status_rows.push((a, b, "missing_vector", None, now_ms));
                    continue;
                }
            };
            let vb = match tag_vectors.get(&b) {
                Some(v) => v,
                None => {
                    skipped += 1;
                    status_rows.push((a, b, "missing_vector", None, now_ms));
                    continue;
                }
            };

            // 安全的余弦：dot / (|a| * |b|)
            let mut dot = 0.0_f64;
            for d in 0..dim {
                dot += (va[d] as f64) * (vb[d] as f64);
            }

            let na = get_norm(a, va, &mut norm_cache) as f64;
            let nb = get_norm(b, vb, &mut norm_cache) as f64;
            let denom = na * nb;
            let sim = if denom > 1e-9 { dot / denom } else { 0.0 };

            computed += 1;

            if sim < self.min_similarity {
                // 数值不写旧正值表，但写入状态表形成真正的增量负缓存。
                skipped += 1;
                status_rows.push((a, b, "below_threshold", Some(sim), now_ms));
                continue;
            }

            to_insert.push((a, b, sim, now_ms));
            status_rows.push((a, b, "computed", Some(sim), now_ms));
        }

        // ====================================================================
        // Step 5: 流式分包写入
        // ====================================================================
        let stored_count = to_insert.len() as u32;
        if !status_rows.is_empty() || self.full_rebuild {
            let artifact_sig_for_write = artifact_sig.clone();
            let graph_generation_for_write = graph_generation.clone();
            let effective_config_for_write = effective_config.clone();
            let config_hash_for_write = config_hash.clone();
            let model_sig_for_write = self.model_sig.clone();
            let min_similarity_for_write = self.min_similarity;
            let full_rebuild_for_write = self.full_rebuild;
            let to_insert_for_write = to_insert;
            let status_rows_for_write = status_rows;

            with_registered_write(&self.db_path, move |tx| {
                if full_rebuild_for_write {
                    tx.execute("DELETE FROM tag_pair_similarity", [])
                        .map_err(|e| {
                            format!("Full rebuild positive cache clear failed: {}", e)
                        })?;
                    tx.execute("DELETE FROM tag_pair_similarity_status", [])
                        .map_err(|e| {
                            format!("Full rebuild status cache clear failed: {}", e)
                        })?;
                }

                let artifact_now = now_ms;
                tx.execute(
                    "INSERT OR REPLACE INTO tagmemo_artifacts \
                     (artifact_sig, asset_type, model_sig, graph_generation, algorithm_version, config_hash, effective_config, status, created_at, updated_at) \
                     VALUES (?1, 'pairwise_similarity', ?2, ?3, ?4, ?5, ?6, 'building', ?7, ?7)",
                    rusqlite::params![
                        &artifact_sig_for_write,
                        &model_sig_for_write,
                        &graph_generation_for_write,
                        PAIRWISE_ALGORITHM_VERSION,
                        &config_hash_for_write,
                        &effective_config_for_write,
                        artifact_now
                    ],
                )
                .map_err(|e| {
                    format!("Pairwise building registration failed: {}", e)
                })?;

                {
                    let mut stmt = tx
                        .prepare(
                            "INSERT OR REPLACE INTO tag_pair_similarity \
                             (tag_a, tag_b, similarity, model_sig, computed_at) \
                             VALUES (?1, ?2, ?3, ?4, ?5)",
                        )
                        .map_err(|e| {
                            format!("Prepare pairwise value insert failed: {}", e)
                        })?;
                    for (a, b, sim, ts) in &to_insert_for_write {
                        stmt.execute(rusqlite::params![
                            a,
                            b,
                            sim,
                            &model_sig_for_write,
                            ts
                        ])
                        .map_err(|e| {
                            format!("Insert pairwise value ({}, {}) failed: {}", a, b, e)
                        })?;
                    }
                }

                {
                    let mut stmt = tx
                        .prepare(
                            "INSERT OR REPLACE INTO tag_pair_similarity_status \
                             (tag_a, tag_b, model_sig, artifact_sig, status, similarity, min_similarity, computed_at) \
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                        )
                        .map_err(|e| {
                            format!("Prepare pairwise status insert failed: {}", e)
                        })?;
                    for (a, b, status, similarity, ts) in &status_rows_for_write {
                        stmt.execute(rusqlite::params![
                            a,
                            b,
                            &model_sig_for_write,
                            &artifact_sig_for_write,
                            status,
                            similarity,
                            min_similarity_for_write,
                            ts
                        ])
                        .map_err(|e| {
                            format!("Insert pairwise status ({}, {}) failed: {}", a, b, e)
                        })?;
                    }
                }

                tx.execute(
                    "UPDATE tagmemo_artifacts SET status = 'ready', updated_at = ?2 \
                     WHERE artifact_sig = ?1",
                    rusqlite::params![&artifact_sig_for_write, artifact_now],
                )
                .map_err(|e| {
                    format!("Pairwise ready transition failed: {}", e)
                })?;

                Ok(crate::storage::WriteReceipt {
                    operation: "publish_pairwise_similarity".to_string(),
                    database_generation: 0,
                    facts_changed: false,
                })
            })
            .map_err(|error| {
                Error::from_reason(format!(
                    "Pairwise Write Actor publish failed: {}",
                    error
                ))
            })?;
        }

        let elapsed = start.elapsed().as_secs_f64() * 1000.0;

        Ok(PairwiseSimResult {
            pair_count,
            computed_count: computed,
            skipped_count: skipped,
            stored_count,
            elapsed_ms: elapsed,
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub(crate) fn save_index_snapshot(
    index: &Arc<RwLock<Index>>,
    index_path: &str,
) -> std::result::Result<(), String> {
    let index = index
        .write()
        .map_err(|error| format!("Index save lock failed: {}", error))?;
    let target = std::path::Path::new(index_path);
    let temp = unique_index_sidecar_path(target, "tmp");
    let temp_text = temp.to_string_lossy().into_owned();

    if let Err(error) = index.save(&temp_text) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!(
            "Failed to save temporary index {}: {:?}",
            temp_text, error
        ));
    }

    if let Err(error) = sync_index_file(&temp) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!(
            "Failed to sync temporary index {}: {}",
            temp_text, error
        ));
    }

    if let Err(error) = publish_index_file(&temp, target) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!(
            "Failed to atomically publish index {}: {}",
            index_path, error
        ));
    }

    Ok(())
}

pub struct IndexSaveTask {
    index: Arc<RwLock<Index>>,
    index_path: String,
}

impl Task for IndexSaveTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        save_index_snapshot(&self.index, &self.index_path)
            .map_err(Error::from_reason)?;
        Ok(self.index_path.clone())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct ChunkIndexDeltaTask {
    index: Arc<RwLock<Index>>,
    content_revision: Arc<std::sync::atomic::AtomicU64>,
    dimensions: u32,
    remove_ids: Vec<i64>,
    upsert_ids: Vec<i64>,
    upsert_vectors: Vec<f32>,
}

impl Task for ChunkIndexDeltaTask {
    type Output = ChunkIndexDeltaResult;
    type JsValue = ChunkIndexDeltaResult;

    fn compute(&mut self) -> Result<Self::Output> {
        use std::collections::HashSet;
        use std::sync::atomic::Ordering;

        let dim = self.dimensions as usize;
        let expected_len =
            self.upsert_ids.len().checked_mul(dim).ok_or_else(|| {
                Error::from_reason("Chunk delta vector size overflow".to_string())
            })?;
        if self.upsert_vectors.len() != expected_len {
            return Err(Error::from_reason(format!(
                "Chunk delta size mismatch: ids={}, expected vector values={}, got={}",
                self.upsert_ids.len(),
                expected_len,
                self.upsert_vectors.len()
            )));
        }
        if self
            .remove_ids
            .iter()
            .chain(self.upsert_ids.iter())
            .any(|id| *id <= 0)
        {
            return Err(Error::from_reason(
                "Chunk delta IDs must all be positive integers".to_string(),
            ));
        }

        let unique_removes: HashSet<i64> = self.remove_ids.iter().copied().collect();
        let mut seen_upserts = HashSet::with_capacity(self.upsert_ids.len());
        if self.upsert_ids.iter().any(|id| !seen_upserts.insert(*id)) {
            return Err(Error::from_reason(
                "Chunk delta contains duplicate upsert IDs".to_string(),
            ));
        }

        let previous_revision = self.content_revision.load(Ordering::Acquire);
        if unique_removes.is_empty() && self.upsert_ids.is_empty() {
            let total_vectors = self
                .index
                .read()
                .map_err(|error| {
                    Error::from_reason(format!("Chunk delta index read lock failed: {}", error))
                })?
                .size() as u32;
            return Ok(ChunkIndexDeltaResult {
                requested_deletes: 0,
                requested_upserts: 0,
                applied_deletes: 0,
                applied_upserts: 0,
                total_vectors,
                previous_revision: previous_revision as i64,
                revision: previous_revision as i64,
            });
        }

        let index = self.index.write().map_err(|error| {
            Error::from_reason(format!("Chunk delta index write lock failed: {}", error))
        })?;

        // 在任何结构修改前完成容量预留，尽可能让可预见失败保持零副作用。
        let required_capacity = index
            .size()
            .checked_add(self.upsert_ids.len())
            .and_then(|value| value.checked_add(1))
            .ok_or_else(|| Error::from_reason("Chunk delta capacity overflow".to_string()))?;
        if required_capacity >= index.capacity() {
            let expanded = required_capacity
                .checked_add(required_capacity / 2)
                .unwrap_or(required_capacity);
            index.reserve(expanded).map_err(|error| {
                Error::from_reason(format!(
                    "Chunk delta reserve failed before mutation: {:?}",
                    error
                ))
            })?;
        }

        let mut applied_deletes = 0_u32;
        for id in &unique_removes {
            if index.remove(*id as u64).is_ok() {
                applied_deletes = applied_deletes.saturating_add(1);
            }
        }

        let mut applied_upserts = 0_u32;
        for (position, id) in self.upsert_ids.iter().enumerate() {
            let start = position * dim;
            let vector = &self.upsert_vectors[start..start + dim];
            let _ = index.remove(*id as u64);
            index.add(*id as u64, vector).map_err(|error| {
                Error::from_reason(format!(
                    "Chunk delta became unusable after partial apply at upsert {} id {}: {:?}",
                    position, id, error
                ))
            })?;
            applied_upserts = applied_upserts.saturating_add(1);
        }

        let total_vectors = index.size() as u32;
        drop(index);
        let revision = self.content_revision.fetch_add(1, Ordering::AcqRel) + 1;

        Ok(ChunkIndexDeltaResult {
            requested_deletes: unique_removes.len() as u32,
            requested_upserts: self.upsert_ids.len() as u32,
            applied_deletes,
            applied_upserts,
            total_vectors,
            previous_revision: previous_revision as i64,
            revision: revision as i64,
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct TagIndexDeltaTask {
    index: Arc<RwLock<Index>>,
    content_revision: Arc<std::sync::atomic::AtomicU64>,
    memo_runtime: Arc<MemoRuntime>,
    dimensions: u32,
    remove_ids: Vec<i64>,
    upsert_ids: Vec<i64>,
    upsert_vectors: Vec<f32>,
}

impl Task for TagIndexDeltaTask {
    type Output = TagIndexDeltaResult;
    type JsValue = TagIndexDeltaResult;

    fn compute(&mut self) -> Result<Self::Output> {
        use std::collections::HashSet;

        let dim = self.dimensions as usize;
        let expected_len = self
            .upsert_ids
            .len()
            .checked_mul(dim)
            .ok_or_else(|| Error::from_reason("Tag delta vector size overflow".to_string()))?;
        if self.upsert_vectors.len() != expected_len {
            return Err(Error::from_reason(format!(
                "Tag delta size mismatch: ids={}, expected vector values={}, got={}",
                self.upsert_ids.len(),
                expected_len,
                self.upsert_vectors.len()
            )));
        }
        if self
            .remove_ids
            .iter()
            .chain(self.upsert_ids.iter())
            .any(|id| *id <= 0)
        {
            return Err(Error::from_reason(
                "Tag delta IDs must all be positive integers".to_string(),
            ));
        }

        let mut seen_upserts = HashSet::with_capacity(self.upsert_ids.len());
        if self.upsert_ids.iter().any(|id| !seen_upserts.insert(*id)) {
            return Err(Error::from_reason(
                "Tag delta contains duplicate upsert IDs".to_string(),
            ));
        }
        let unique_removes: HashSet<i64> = self.remove_ids.iter().copied().collect();

        let index = self.index.write().map_err(|error| {
            Error::from_reason(format!("Tag delta index lock failed: {}", error))
        })?;

        // 在首个结构修改前完成最大容量预留，避免常见内存错误产生部分应用。
        let required_capacity = index
            .size()
            .checked_add(self.upsert_ids.len())
            .and_then(|value| value.checked_add(1))
            .ok_or_else(|| Error::from_reason("Tag delta capacity overflow".to_string()))?;
        if required_capacity >= index.capacity() {
            let expanded = required_capacity
                .checked_add(required_capacity / 2)
                .unwrap_or(required_capacity);
            index.reserve(expanded).map_err(|error| {
                Error::from_reason(format!(
                    "Tag delta reserve failed before mutation: {:?}",
                    error
                ))
            })?;
        }

        let mut applied_deletes = 0_u32;
        for id in &unique_removes {
            if index.remove(*id as u64).is_ok() {
                applied_deletes = applied_deletes.saturating_add(1);
            }
        }

        let mut applied_upserts = 0_u32;
        for (position, id) in self.upsert_ids.iter().enumerate() {
            let start = position * dim;
            let vector = &self.upsert_vectors[start..start + dim];
            let _ = index.remove(*id as u64);
            index.add(*id as u64, vector).map_err(|error| {
                Error::from_reason(format!(
                    "Tag delta became unusable after partial apply at upsert {} id {}: {:?}",
                    position, id, error
                ))
            })?;
            applied_upserts = applied_upserts.saturating_add(1);
        }

        let total_vectors = index.size() as u32;
        drop(index);
        self.content_revision
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);

        self.memo_runtime.clear().map_err(|error| {
            Error::from_reason(format!(
                "Tag delta applied but MemoRuntime invalidation failed; index must be recovered: {}",
                error
            ))
        })?;

        Ok(TagIndexDeltaResult {
            requested_deletes: unique_removes.len() as u32,
            requested_upserts: self.upsert_ids.len() as u32,
            applied_deletes,
            applied_upserts,
            total_vectors,
            memo_runtime_cleared: true,
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct RecoverTask {
    index: Arc<RwLock<Index>>,
    content_revision: Arc<std::sync::atomic::AtomicU64>,
    db_path: String,
    table_type: String,
    filter_diary_name: Option<String>,
    dimensions: u32,
}

impl Task for RecoverTask {
    type Output = u32;
    type JsValue = u32;

    fn compute(&mut self) -> Result<Self::Output> {
        let expected_byte_len = self.dimensions as usize * std::mem::size_of::<f32>();

        let table_type = self.table_type.clone();
        let diary_name = self.filter_diary_name.clone();
        let rows: Vec<(i64, Vec<u8>)> = with_registered_read(&self.db_path, move |connection| {
            if table_type == "tags" {
                let mut statement = connection
                    .prepare("SELECT id, vector FROM tags WHERE vector IS NOT NULL")
                    .map_err(|error| format!("Prepare recovery query failed: {}", error))?;
                let rows = statement
                    .query_map([], |row| {
                        Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
                    })
                    .map_err(|error| format!("Query recovery rows failed: {}", error))?;

                rows.collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(|error| format!("Decode recovery row failed: {}", error))
            } else if table_type == "chunks" {
                let diary_name = diary_name.as_deref().ok_or_else(|| {
                    "Recovery requires a diary name for chunk indices".to_string()
                })?;
                let mut statement = connection
                    .prepare(
                        "SELECT c.id, c.vector \
                         FROM chunks c \
                         JOIN files f ON c.file_id = f.id \
                         WHERE f.diary_name = ?1 AND c.vector IS NOT NULL",
                    )
                    .map_err(|error| format!("Prepare recovery query failed: {}", error))?;
                let rows = statement
                    .query_map([diary_name], |row| {
                        Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
                    })
                    .map_err(|error| format!("Query recovery rows failed: {}", error))?;

                rows.collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(|error| format!("Decode recovery row failed: {}", error))
            } else {
                Err("Unsupported recovery table type".to_string())
            }
        })
        .map_err(Error::from_reason)?;

        let mut count = 0u32;
        let mut skipped_dim_mismatch = 0u32;
        let rebuilt = Index::new(&usearch::IndexOptions {
            dimensions: self.dimensions as usize,
            metric: usearch::MetricKind::L2sq,
            quantization: usearch::ScalarKind::F32,
            connectivity: 16,
            expansion_add: 128,
            expansion_search: 64,
            multi: false,
        })
        .map_err(|error| {
            Error::from_reason(format!("Recover index construction failed: {:?}", error))
        })?;

        rebuilt.reserve(rows.len().max(1)).map_err(|error| {
            Error::from_reason(format!("Recover initial reserve failed: {:?}", error))
        })?;

        // 维度不匹配按兼容契约跳过；所有 SQL 读取和临时索引构建完成后，
        // 才取得活动索引写锁执行一次替换，避免失败时污染旧实例。
        for (id, vector_bytes) in rows {
            if vector_bytes.len() != expected_byte_len {
                skipped_dim_mismatch = skipped_dim_mismatch.saturating_add(1);
                continue;
            }

            let vector: Vec<f32> = vector_bytes
                .chunks_exact(std::mem::size_of::<f32>())
                .map(|chunk| f32::from_ne_bytes(chunk.try_into().unwrap()))
                .collect();

            if vector.iter().any(|value| !value.is_finite()) {
                return Err(Error::from_reason(format!(
                    "Recover encountered non-finite vector {}",
                    id
                )));
            }

            if rebuilt.size() + 1 >= rebuilt.capacity() {
                let new_capacity = (rebuilt.capacity().max(1) as f64 * 1.5) as usize;
                rebuilt.reserve(new_capacity).map_err(|error| {
                    Error::from_reason(format!(
                        "Recover reserve failed before vector {}: {:?}",
                        id, error
                    ))
                })?;
            }

            rebuilt.add(id as u64, &vector).map_err(|error| {
                Error::from_reason(format!("Recover add failed for vector {}: {:?}", id, error))
            })?;
            count = count.saturating_add(1);
        }

        let mut index = self
            .index
            .write()
            .map_err(|error| Error::from_reason(format!("Recover index lock failed: {}", error)))?;
        *index = rebuilt;
        drop(index);
        self.content_revision
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);

        if skipped_dim_mismatch > 0 {
            println!(
                "[Vexus-Lite] Skipped {} vectors due to dimension mismatch (expected {} bytes)",
                skipped_dim_mismatch, expected_byte_len
            );
        }

        Ok(count)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

// ============================================================================
// 🦀 高性能原生文件监听器 (VexusWatcher)
// ============================================================================

use notify::{Event, EventKind, RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

#[napi(object)]
pub struct WatchEvent {
    pub event: String,
    pub path: String,
    pub generation: i64,
    pub stable: bool,
    pub size: i64,
    pub mtime_ms: i64,
    pub emitted_at: i64,
}

#[napi(object)]
pub struct WatcherConfig {
    pub root_path: String,
    pub ignore_folders: Vec<String>,
    pub ignore_prefixes: Vec<String>,
    pub ignore_suffixes: Vec<String>,
    /// 是否在启动 watcher 时执行 Rust 侧初始扫描。
    pub initial_scan: Option<bool>,
    /// 可选扩展名白名单。为空时保持旧行为：仅监听 .md / .txt。
    pub extensions: Option<Vec<String>>,
    /// 路径事件静默窗口。窗口内的新事件会使旧 generation 自动失效。
    pub debounce_ms: Option<u32>,
    /// 两次文件元数据采样之间的稳定确认间隔。
    pub stability_ms: Option<u32>,
    /// 同一 generation 内最多执行的稳定采样次数。
    pub stability_retries: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WatchFileSnapshot {
    size: u64,
    modified_ms: u128,
}

#[derive(Clone, Copy)]
struct WatchPendingPath {
    generation: u64,
    observed_as_create: bool,
}

fn watch_file_snapshot(
    path: &Path,
) -> std::result::Result<Option<WatchFileSnapshot>, std::io::ErrorKind> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.kind()),
    };
    if !metadata.is_file() {
        return Err(std::io::ErrorKind::InvalidInput);
    }
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis())
        .unwrap_or(0);
    Ok(Some(WatchFileSnapshot {
        size: metadata.len(),
        modified_ms,
    }))
}

fn watcher_path_allowed(
    path: &Path,
    root_path: &Path,
    allowed_extensions: &HashSet<String>,
    ignore_folders: &HashSet<String>,
    ignore_prefixes: &[String],
    ignore_suffixes: &[String],
) -> bool {
    let ext = match path.extension() {
        Some(value) => value.to_string_lossy().to_lowercase(),
        None => return false,
    };
    if !allowed_extensions.contains(&ext) {
        return false;
    }

    let rel_path = match path.strip_prefix(root_path) {
        Ok(value) => value,
        Err(_) => return false,
    };
    let diary_name = rel_path
        .components()
        .next()
        .map(|value| value.as_os_str().to_string_lossy().to_string())
        .unwrap_or_else(|| "Root".to_string());
    if ignore_folders.contains(&diary_name) {
        return false;
    }

    let file_name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    if ignore_prefixes
        .iter()
        .any(|prefix| diary_name.starts_with(prefix) || file_name.starts_with(prefix))
    {
        return false;
    }
    if ignore_suffixes
        .iter()
        .any(|suffix| diary_name.ends_with(suffix) || file_name.ends_with(suffix))
    {
        return false;
    }

    true
}

const WATCH_EVENT_QUEUE_CAPACITY: usize = 4096;
const WATCH_PATH_WORKER_LIMIT: usize = 64;

#[derive(Clone)]
struct WatchScanConfig {
    root_path: PathBuf,
    allowed_extensions: Arc<HashSet<String>>,
    ignore_folders: Arc<HashSet<String>>,
    ignore_prefixes: Arc<Vec<String>>,
    ignore_suffixes: Arc<Vec<String>>,
}

fn reap_finished_watch_workers(
    worker_handles: &Arc<Mutex<Vec<thread::JoinHandle<()>>>>,
) {
    let Ok(mut handles) = worker_handles.lock() else {
        return;
    };
    let mut active = Vec::with_capacity(handles.len());
    for handle in handles.drain(..) {
        if handle.is_finished() {
            let _ = handle.join();
        } else {
            active.push(handle);
        }
    }
    *handles = active;
}

fn enqueue_watch_event(
    events: &Arc<Mutex<VecDeque<WatchEvent>>>,
    overflowed: &Arc<AtomicBool>,
    event: WatchEvent,
) {
    if let Ok(mut queue) = events.lock() {
        if queue.len() >= WATCH_EVENT_QUEUE_CAPACITY {
            queue.pop_front();
            overflowed.store(true, Ordering::Release);
        }
        queue.push_back(event);
    }
}

fn wait_for_watcher_duration(running: &AtomicBool, duration: Duration) -> bool {
    const WAIT_SLICE: Duration = Duration::from_millis(25);
    let started = std::time::Instant::now();
    while started.elapsed() < duration {
        if !running.load(Ordering::Acquire) {
            return false;
        }
        let remaining = duration.saturating_sub(started.elapsed());
        std::thread::sleep(remaining.min(WAIT_SLICE));
    }
    running.load(Ordering::Acquire)
}

fn emit_initial_watch_events(
    root_path: &Path,
    allowed_extensions: &HashSet<String>,
    ignore_folders: &HashSet<String>,
    ignore_prefixes: &[String],
    ignore_suffixes: &[String],
    generation_counter: &AtomicU64,
    events: &Arc<Mutex<VecDeque<WatchEvent>>>,
    overflowed: &Arc<AtomicBool>,
    running: &AtomicBool,
    known_database_paths: &HashSet<PathBuf>,
) {
    // 整次扫描使用开始时的代际。扫描期间到来的 notify 必须具有更高代际，
    // 不能因为扫描较晚访问某一路径就覆盖该路径的新事件。
    let scan_generation = generation_counter.fetch_add(1, Ordering::AcqRel) + 1;
    let mut stack = vec![root_path.to_path_buf()];
    let mut seen_paths = HashSet::new();
    let mut scan_complete = true;
    while let Some(directory) = stack.pop() {
        if !running.load(Ordering::Acquire) {
            return;
        }
        let entries = match std::fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) => {
                scan_complete = false;
                eprintln!(
                    "[VexusWatcher] Initial scan skipped directory {}: {}",
                    directory.to_string_lossy(),
                    error
                );
                continue;
            }
        };

        for entry_result in entries {
            let entry = match entry_result {
                Ok(entry) => entry,
                Err(error) => {
                    scan_complete = false;
                    eprintln!(
                        "[VexusWatcher] Initial scan skipped an entry in {}: {}",
                        directory.to_string_lossy(),
                        error
                    );
                    continue;
                }
            };
            if !running.load(Ordering::Acquire) {
                return;
            }
            let path = entry.path();
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(error) => {
                    scan_complete = false;
                    eprintln!(
                        "[VexusWatcher] Initial scan skipped metadata for {}: {}",
                        path.to_string_lossy(),
                        error
                    );
                    continue;
                }
            };
            if metadata.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name == "node_modules"
                    || name == ".git"
                    || name == "dist"
                    || name == "target"
                    || name == "image"
                    || name.starts_with('.')
                {
                    continue;
                }
                stack.push(path);
                continue;
            }
            if !metadata.is_file()
                || !watcher_path_allowed(
                    &path,
                    root_path,
                    allowed_extensions,
                    ignore_folders,
                    ignore_prefixes,
                    ignore_suffixes,
                )
            {
                continue;
            }

            let normalized_path = path.to_string_lossy().replace('\\', "/");
            seen_paths.insert(PathBuf::from(&normalized_path));
            let generation = scan_generation;
            let modified_ms = metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                .map(|value| value.as_millis())
                .unwrap_or(0);
            enqueue_watch_event(
                events,
                overflowed,
                WatchEvent {
                    event: "add".to_string(),
                    path: normalized_path,
                    generation: generation as i64,
                    stable: true,
                    size: metadata.len().min(i64::MAX as u64) as i64,
                    mtime_ms: modified_ms.min(i64::MAX as u128) as i64,
                    emitted_at: SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|value| value.as_millis().min(i64::MAX as u128) as i64)
                        .unwrap_or(0),
                },
            );
        }
    }

    if !scan_complete {
        eprintln!(
            "[VexusWatcher] Reconciliation scan was incomplete; suppressing missing-file tombstones."
        );
        return;
    }

    for stored_path in known_database_paths {
        if !running.load(Ordering::Acquire) {
            return;
        }
        // files.path 是知识根目录下的相对路径；不接受父目录、盘符或根路径，
        // 防止损坏的数据库记录把对账扩展到知识根目录之外。
        if stored_path.components().any(|component| {
            !matches!(component, std::path::Component::Normal(_))
        }) {
            continue;
        }
        let database_path = &root_path.join(stored_path);
        let normalized_path = database_path.to_string_lossy().replace('\\', "/");
        if seen_paths.contains(&PathBuf::from(&normalized_path))
            || !watcher_path_allowed(
                database_path,
                root_path,
                allowed_extensions,
                ignore_folders,
                ignore_prefixes,
                ignore_suffixes,
            )
        {
            continue;
        }

        // 扫描之后可能已经重建文件；权限、共享句柄和 I/O 错误均不是删除证据。
        match std::fs::metadata(database_path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => continue,
            Err(error) => {
                eprintln!(
                    "[VexusWatcher] Missing-file verification deferred for {}: {}",
                    normalized_path, error
                );
                continue;
            }
        }
        let generation = scan_generation;
        enqueue_watch_event(
            events,
            overflowed,
            WatchEvent {
                event: "unlink".to_string(),
                path: normalized_path,
                generation: generation as i64,
                stable: true,
                size: 0,
                mtime_ms: 0,
                emitted_at: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|value| value.as_millis().min(i64::MAX as u128) as i64)
                    .unwrap_or(0),
            },
        );
    }
}

#[napi]
pub struct VexusWatcher {
    watcher: Arc<Mutex<Option<notify::RecommendedWatcher>>>,
    // 同一路径只保留一个可重置状态和一个 worker；重复 notify 事件仅刷新 generation。
    path_generations: Arc<Mutex<HashMap<PathBuf, WatchPendingPath>>>,
    generation_counter: Arc<AtomicU64>,
    events: Arc<Mutex<VecDeque<WatchEvent>>>,
    overflowed: Arc<AtomicBool>,
    scan_config: Arc<Mutex<Option<WatchScanConfig>>>,
    worker_handles: Arc<Mutex<Vec<thread::JoinHandle<()>>>>,
    reconcile_handle: Arc<Mutex<Option<thread::JoinHandle<()>>>>,
    reconcile_requested: Arc<AtomicBool>,
    reconcile_paths: Arc<Mutex<HashSet<PathBuf>>>,
    running: Arc<AtomicBool>,
}

#[napi]
impl VexusWatcher {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            watcher: Arc::new(Mutex::new(None)),
            path_generations: Arc::new(Mutex::new(HashMap::new())),
            generation_counter: Arc::new(AtomicU64::new(0)),
            events: Arc::new(Mutex::new(VecDeque::with_capacity(
                WATCH_EVENT_QUEUE_CAPACITY,
            ))),
            overflowed: Arc::new(AtomicBool::new(false)),
            scan_config: Arc::new(Mutex::new(None)),
            worker_handles: Arc::new(Mutex::new(Vec::new())),
            reconcile_handle: Arc::new(Mutex::new(None)),
            reconcile_requested: Arc::new(AtomicBool::new(false)),
            reconcile_paths: Arc::new(Mutex::new(HashSet::new())),
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    /// 启动高性能原生文件监听
    #[napi]
    pub fn start_watch(&self, config: WatcherConfig) -> Result<()> {
        let root_path_buf = PathBuf::from(&config.root_path);
        let root_path_buf_clone = root_path_buf.clone();
        let ignore_folders: Arc<HashSet<String>> =
            Arc::new(config.ignore_folders.into_iter().collect());
        let ignore_prefixes = Arc::new(config.ignore_prefixes);
        let ignore_suffixes = Arc::new(config.ignore_suffixes);
        let allowed_extensions: Arc<HashSet<String>> = Arc::new(
            config
                .extensions
                .unwrap_or_else(|| vec!["md".to_string(), "txt".to_string()])
                .into_iter()
                .map(|ext| ext.trim().trim_start_matches('.').to_lowercase())
                .filter(|ext| !ext.is_empty())
                .collect(),
        );
        let debounce_ms = config.debounce_ms.unwrap_or(350).clamp(25, 30_000) as u64;
        let stability_ms = config.stability_ms.unwrap_or(150).clamp(25, 10_000) as u64;
        let stability_retries = config.stability_retries.unwrap_or(6).clamp(2, 100);

        let watcher_ref = self.watcher.clone();
        let path_generations = self.path_generations.clone();
        let generation_counter = self.generation_counter.clone();
        let events = self.events.clone();
        let overflowed = self.overflowed.clone();
        let worker_handles = self.worker_handles.clone();
        let callback_worker_handles = worker_handles.clone();
        let running = self.running.clone();
        let initial_running = running.clone();
        if let Ok(mut scan_config) = self.scan_config.lock() {
            *scan_config = Some(WatchScanConfig {
                root_path: root_path_buf.clone(),
                allowed_extensions: allowed_extensions.clone(),
                ignore_folders: ignore_folders.clone(),
                ignore_prefixes: ignore_prefixes.clone(),
                ignore_suffixes: ignore_suffixes.clone(),
            });
        }
        let callback_ignore_folders = ignore_folders.clone();
        let callback_ignore_prefixes = ignore_prefixes.clone();
        let callback_ignore_suffixes = ignore_suffixes.clone();
        let callback_allowed_extensions = allowed_extensions.clone();
        let callback_generation_counter = generation_counter.clone();
        let callback_events = events.clone();
        let callback_overflowed = overflowed.clone();
        running.store(true, Ordering::Release);
        overflowed.store(false, Ordering::Release);
        if let Ok(mut generations) = path_generations.lock() {
            generations.clear();
        }

        let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            if !running.load(Ordering::Acquire) {
                return;
            }
            match res {
                Ok(event) => {
                    // notify 的 rename 事件通常同时携带旧路径与新路径。
                    // 必须遍历全部路径；最终事件类型由静默窗口结束时的真实存在性决定：
                    // 旧路径不存在 => unlink，新路径存在 => add/change。
                    if !matches!(
                        event.kind,
                        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
                    ) {
                        return;
                    }

                    for path in event.paths {
                        reap_finished_watch_workers(&callback_worker_handles);
                        if !watcher_path_allowed(
                            &path,
                            &root_path_buf_clone,
                            &callback_allowed_extensions,
                            &callback_ignore_folders,
                            &callback_ignore_prefixes,
                            &callback_ignore_suffixes,
                        ) {
                            continue;
                        }

                        let generation =
                            callback_generation_counter.fetch_add(1, Ordering::AcqRel) + 1;
                        let observed_as_create = matches!(event.kind, EventKind::Create(_));
                        let should_spawn = if let Ok(mut generations) = path_generations.lock() {
                            let should_spawn = !generations.contains_key(&path);
                            if should_spawn && generations.len() >= WATCH_PATH_WORKER_LIMIT {
                                callback_overflowed.store(true, Ordering::Release);
                                continue;
                            }
                            generations.insert(
                                path.clone(),
                                WatchPendingPath {
                                    generation,
                                    observed_as_create,
                                },
                            );
                            should_spawn
                        } else {
                            continue;
                        };

                        // 乐观防御：同一路径已有 worker 时只刷新其状态，不再创建额外线程。
                        if !should_spawn {
                            continue;
                        }

                        let pending = path_generations.clone();
                        let task_running = running.clone();
                        let task_path = path.clone();
                        let cleanup_path = path.clone();
                        let cleanup_pending = path_generations.clone();
                        let task_events = callback_events.clone();
                        let task_overflowed = callback_overflowed.clone();

                        let spawn_result = std::thread::Builder::new()
                            .name("vexus-watch-path".to_string())
                            .spawn(move || {
                                'generation: loop {
                                    if !task_running.load(Ordering::Acquire) {
                                        return;
                                    }
                                    let current = match pending
                                        .lock()
                                        .ok()
                                        .and_then(|generations| generations.get(&task_path).copied())
                                    {
                                        Some(value) => value,
                                        None => return,
                                    };
                                    let generation = current.generation;

                                    if !wait_for_watcher_duration(
                                        &task_running,
                                        Duration::from_millis(debounce_ms),
                                    ) {
                                        return;
                                    }

                                    // 静默窗口内若收到新事件，当前 worker 继续存活并为最新代际重启窗口。
                                    let after_debounce = pending
                                        .lock()
                                        .ok()
                                        .and_then(|generations| generations.get(&task_path).copied());
                                    if after_debounce.map(|value| value.generation) != Some(generation) {
                                        continue 'generation;
                                    }

                                    // 文件存在时要求连续两次 metadata 完全一致。
                                    // 同一 generation 内有限重采样，防止某些文件系统只发一次 notify、
                                    // 首轮采样仍在变化而后续没有新事件时永久漏入库。
                                    let mut previous_snapshot = watch_file_snapshot(&task_path);
                                    let mut final_snapshot = None;
                                    let mut stable = false;

                                    for _ in 0..stability_retries {
                                        if !wait_for_watcher_duration(
                                            &task_running,
                                            Duration::from_millis(stability_ms),
                                        ) {
                                            return;
                                        }

                                        let latest = pending
                                            .lock()
                                            .ok()
                                            .and_then(|generations| {
                                                generations.get(&task_path).copied()
                                            });
                                        if latest.map(|value| value.generation) != Some(generation) {
                                            continue 'generation;
                                        }

                                        let next_snapshot = watch_file_snapshot(&task_path);
                                        if next_snapshot.is_ok() && next_snapshot == previous_snapshot {
                                            stable = true;
                                            final_snapshot = next_snapshot.ok().flatten();
                                            break;
                                        }
                                        previous_snapshot = next_snapshot;
                                    }

                                    if !stable {
                                        // 稳定确认耗尽后必须留下可对账信号，不能让路径停留在
                                        // “已有 generation 但没有 worker”的孤儿状态。
                                        if let Ok(mut generations) = pending.lock() {
                                            if generations
                                                .get(&task_path)
                                                .map(|value| value.generation)
                                                == Some(generation)
                                            {
                                                generations.remove(&task_path);
                                            } else {
                                                continue 'generation;
                                            }
                                        }
                                        task_overflowed.store(true, Ordering::Release);
                                        eprintln!(
                                            "[VexusWatcher] ⚠️ Path did not stabilize after {} samples; reconciliation requested for generation {}: {}",
                                            stability_retries,
                                            generation,
                                            task_path.to_string_lossy()
                                        );
                                        return;
                                    }

                                    let observed_as_create =
                                        if let Ok(mut generations) = pending.lock() {
                                            match generations.get(&task_path).copied() {
                                                Some(value) if value.generation == generation => {
                                                    generations.remove(&task_path);
                                                    value.observed_as_create
                                                }
                                                Some(_) => continue 'generation,
                                                None => return,
                                            }
                                        } else {
                                            return;
                                        };

                                    let (event_type, size, modified_ms) = match final_snapshot {
                                        Some(snapshot) => (
                                            if observed_as_create { "add" } else { "change" },
                                            snapshot.size,
                                            snapshot.modified_ms,
                                        ),
                                        None => ("unlink", 0, 0),
                                    };
                                    let emitted_at = SystemTime::now()
                                        .duration_since(UNIX_EPOCH)
                                        .map(|value| value.as_millis())
                                        .unwrap_or(0);
                                    enqueue_watch_event(
                                        &task_events,
                                        &task_overflowed,
                                        WatchEvent {
                                            event: event_type.to_string(),
                                            path: task_path.to_string_lossy().replace('\\', "/"),
                                            generation: generation as i64,
                                            stable: true,
                                            size: size.min(i64::MAX as u64) as i64,
                                            mtime_ms: modified_ms.min(i64::MAX as u128) as i64,
                                            emitted_at: emitted_at.min(i64::MAX as u128) as i64,
                                        },
                                    );
                                    return;
                                }
                            });

                        match spawn_result {
                            Ok(handle) => {
                                if let Ok(mut handles) = callback_worker_handles.lock() {
                                    handles.push(handle);
                                } else {
                                    eprintln!(
                                        "[VexusWatcher] ⚠️ Worker handle registry poisoned; \
                                         joining path worker immediately: {}",
                                        cleanup_path.to_string_lossy()
                                    );
                                    let _ = handle.join();
                                }
                            }
                            Err(error) => {
                                // spawn 已明确失败，此路径不可能存在活跃 worker；无条件清理，
                                // 避免并发刷新的新 generation 留下“有状态、无执行者”的孤儿项。
                                if let Ok(mut generations) = cleanup_pending.lock() {
                                    generations.remove(&cleanup_path);
                                }
                                callback_overflowed.store(true, Ordering::Release);
                                eprintln!(
                                    "[VexusWatcher] ❌ Failed to spawn path worker for {}: {}",
                                    cleanup_path.to_string_lossy(),
                                    error
                                );
                            }
                        }
                    }
                }
                Err(e) => {
                    callback_overflowed.store(true, Ordering::Release);
                    eprintln!("[VexusWatcher] ❌ Native watch error: {:?}", e);
                }
            }
        })
        .map_err(|e| Error::from_reason(format!("Failed to create native watcher: {:?}", e)))?;

        // 开始递归监听
        watcher
            .watch(&root_path_buf, RecursiveMode::Recursive)
            .map_err(|e| Error::from_reason(format!("Failed to start watching path: {:?}", e)))?;

        // 初始对账由 Rust watcher 完成，和 notify 事件使用同一个回调与
        // generation 序列。这样 JS 不再递归扫描文件系统，也不会制造第二套
        // 初始 pending 队列。
        if config.initial_scan.unwrap_or(true) {
            let initial_root = root_path_buf.clone();
            let initial_extensions = allowed_extensions.clone();
            let initial_ignore_folders = ignore_folders.clone();
            let initial_ignore_prefixes = ignore_prefixes.clone();
            let initial_ignore_suffixes = ignore_suffixes.clone();
            let initial_generation_counter = generation_counter.clone();
            let initial_events = events.clone();
            let initial_overflowed = overflowed.clone();
            let initial_worker_handles = worker_handles.clone();
            let initial_running = initial_running.clone();
            let initial_handle = std::thread::Builder::new()
                .name("vexus-watch-initial-scan".to_string())
                .spawn(move || {
                    emit_initial_watch_events(
                        &initial_root,
                        &initial_extensions,
                        &initial_ignore_folders,
                        &initial_ignore_prefixes,
                        &initial_ignore_suffixes,
                        &initial_generation_counter,
                        &initial_events,
                        &initial_overflowed,
                        &initial_running,
                        &HashSet::new(),
                    );
                })
                .map_err(|error| {
                    Error::from_reason(format!(
                        "Failed to spawn native watcher initial scan: {}",
                        error
                    ))
                })?;
            if let Ok(mut handles) = initial_worker_handles.lock() {
                handles.push(initial_handle);
            } else {
                eprintln!(
                    "[VexusWatcher] ⚠️ Worker handle registry poisoned; \
                     joining initial scan immediately."
                );
                let _ = initial_handle.join();
            };
        }

        let mut lock = watcher_ref
            .lock()
            .map_err(|e| Error::from_reason(format!("Watcher lock failed: {}", e)))?;
        *lock = Some(watcher);

        println!(
            "[VexusWatcher] 🦀 Stable native watcher started for: {} (debounce={}ms, stability={}ms, retries={})",
            config.root_path, debounce_ms, stability_ms, stability_retries
        );
        Ok(())
    }

    /// 请求一次 Rust 侧后台文件对账。
    ///
    /// 对账线程在 Runtime 内部单飞运行；N-API 调用只负责提交请求，
    /// 不在 Node.js 主线程执行递归文件扫描。扫描结果重新进入同一个
    /// 有界事件队列，停止时由 stop_watch() 取消并 join。
    #[napi]
    pub fn reconcile_watch(&self) -> Result<()> {
        self.reconcile_watch_with_paths(HashSet::new())
    }

    pub fn reconcile_watch_with_paths(&self, known_database_paths: HashSet<PathBuf>) -> Result<()> {
        if !self.running.load(Ordering::Acquire) {
            return Err(Error::from_reason(
                "Cannot reconcile a stopped native watcher".to_string(),
            ));
        }
        let scan_config = self
            .scan_config
            .lock()
            .map_err(|_| Error::from_reason("Watcher scan config lock poisoned".to_string()))?
            .clone()
            .ok_or_else(|| {
                Error::from_reason("Native watcher scan config is unavailable".to_string())
            })?;

        let mut reconcile_slot = self
            .reconcile_handle
            .lock()
            .map_err(|_| Error::from_reason("Watcher reconcile lock poisoned".to_string()))?;

        *self.reconcile_paths.lock().map_err(|_| {
            Error::from_reason("Watcher reconcile paths lock poisoned".to_string())
        })? = known_database_paths;
        self.reconcile_requested.store(true, Ordering::Release);
        if let Some(handle) = reconcile_slot.as_ref() {
            if !handle.is_finished() {
                return Ok(());
            }
        }
        if let Some(handle) = reconcile_slot.take() {
            let _ = handle.join();
        }

        let generation_counter = self.generation_counter.clone();
        let events = self.events.clone();
        let overflowed = self.overflowed.clone();
        let running = self.running.clone();
        let reconcile_requested = self.reconcile_requested.clone();
        let reconcile_paths = self.reconcile_paths.clone();
        let handle = thread::Builder::new()
            .name("vexus-watch-reconcile".to_string())
            .spawn(move || {
                // 对账 worker 在 watcher 生命周期内保持待命，避免“检查重跑标志”
                // 到线程退出之间的新请求被遗失。停止时由 stop_watch 取消并 join。
                while running.load(Ordering::Acquire) {
                    if !reconcile_requested.swap(false, Ordering::AcqRel) {
                        if !wait_for_watcher_duration(&running, Duration::from_millis(25)) {
                            break;
                        }
                        continue;
                    }
                    let known_database_paths = match reconcile_paths.lock() {
                        Ok(paths) => paths.clone(),
                        Err(_) => {
                            overflowed.store(true, Ordering::Release);
                            break;
                        }
                    };
                    emit_initial_watch_events(
                        &scan_config.root_path,
                        &scan_config.allowed_extensions,
                        &scan_config.ignore_folders,
                        &scan_config.ignore_prefixes,
                        &scan_config.ignore_suffixes,
                        &generation_counter,
                        &events,
                        &overflowed,
                        &running,
                        &known_database_paths,
                    );
                }
            })
            .map_err(|error| {
                Error::from_reason(format!(
                    "Failed to spawn native watcher reconciliation: {}",
                    error
                ))
            })?;
        *reconcile_slot = Some(handle);
        Ok(())
    }

    #[napi]
    pub fn stop_watch(&self) -> Result<()> {
        // 先禁止新任务并释放 notify 生产者；随后 join 所有已有 worker。
        // 队列和 generation 必须等生产者完全退出后再清理，避免 stop 与 enqueue 竞态。
        self.running.store(false, Ordering::Release);
        self.reconcile_requested.store(false, Ordering::Release);
        let mut lock = self
            .watcher
            .lock()
            .map_err(|e| Error::from_reason(format!("Watcher lock failed: {}", e)))?;
        *lock = None;
        drop(lock);

        let handles = self
            .worker_handles
            .lock()
            .map_err(|_| Error::from_reason("Watcher worker handle lock poisoned".to_string()))?
            .drain(..)
            .collect::<Vec<_>>();
        let reconcile_handle = self
            .reconcile_handle
            .lock()
            .map_err(|_| Error::from_reason("Watcher reconcile lock poisoned".to_string()))?
            .take();
        let mut join_errors = 0usize;
        for handle in handles {
            if handle.join().is_err() {
                join_errors = join_errors.saturating_add(1);
            }
        }
        if let Some(handle) = reconcile_handle {
            if handle.join().is_err() {
                join_errors = join_errors.saturating_add(1);
            }
        }
        if join_errors > 0 {
            return Err(Error::from_reason(format!(
                "Native watcher stopped but {} worker thread(s) panicked",
                join_errors
            )));
        }

        if let Ok(mut generations) = self.path_generations.lock() {
            generations.clear();
        }
        if let Ok(mut events) = self.events.lock() {
            events.clear();
        }
        self.overflowed.store(false, Ordering::Release);
        if let Ok(mut scan_config) = self.scan_config.lock() {
            *scan_config = None;
        }

        println!("[VexusWatcher] 🦀 Native watcher stopped and workers joined.");
        Ok(())
    }

    #[napi]
    pub fn drain_events(&self, max_events: u32) -> Vec<WatchEvent> {
        let limit = (max_events as usize).clamp(1, WATCH_EVENT_QUEUE_CAPACITY);
        let mut output = Vec::new();
        if self.overflowed.swap(false, Ordering::AcqRel) {
            output.push(WatchEvent {
                event: "overflow".to_string(),
                path: self
                    .scan_config
                    .lock()
                    .ok()
                    .and_then(|config| config.as_ref().map(|value| {
                        value.root_path.to_string_lossy().replace('\\', "/")
                    }))
                    .unwrap_or_default(),
                generation: self.generation_counter.load(Ordering::Acquire) as i64,
                stable: true,
                size: 0,
                mtime_ms: 0,
                emitted_at: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|value| value.as_millis().min(i64::MAX as u128) as i64)
                    .unwrap_or(0),
            });
        }
        let Ok(mut queue) = self.events.lock() else {
            return output;
        };
        let remaining = limit.saturating_sub(output.len());
        let count = queue.len().min(remaining);
        output.extend(queue.drain(..count));
        output
    }
}


#[cfg(test)]
mod watcher_reconciliation_tests {
    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "vexus-watch-test-{}-{}",
                std::process::id(),
                SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn scan(root: &Path, paths: &[&str]) -> Vec<WatchEvent> {
        let events = Arc::new(Mutex::new(VecDeque::new()));
        emit_initial_watch_events(
            root,
            &HashSet::from(["txt".to_string()]),
            &HashSet::new(),
            &[],
            &[],
            &AtomicU64::new(0),
            &events,
            &Arc::new(AtomicBool::new(false)),
            &AtomicBool::new(true),
            &paths.iter().map(PathBuf::from).collect(),
        );
        let output = events.lock().unwrap().drain(..).collect::<Vec<_>>();
        output
    }

    #[test]
    fn reconciliation_emits_missing_relative_path_only() {
        let dir = TestDirectory::new();
        std::fs::create_dir(dir.0.join("diary")).unwrap();
        std::fs::write(dir.0.join("diary/present.txt"), "present").unwrap();
        let events = scan(&dir.0, &["diary/present.txt", "diary/missing.txt"]);
        let deletions: Vec<_> = events.iter().filter(|event| event.event == "unlink").collect();
        assert_eq!(deletions.len(), 1);
        assert_eq!(
            deletions[0].path,
            dir.0.join("diary/missing.txt").to_string_lossy().replace('\\', "/")
        );
        assert!(deletions[0].stable);
    }

    #[test]
    fn incomplete_root_scan_never_emits_deletions() {
        let dir = TestDirectory::new();
        let events = scan(&dir.0.join("unavailable"), &["diary/missing.txt"]);
        assert!(events.is_empty());
    }

    #[test]
    fn reconciliation_rejects_parent_and_absolute_paths() {
        let dir = TestDirectory::new();
        let absolute = dir.0.join("missing.txt").to_string_lossy().into_owned();
        let events = scan(&dir.0, &["../missing.txt", &absolute]);
        assert!(events.is_empty());
    }

    #[test]
    fn queue_overflow_is_bounded_and_reported() {
        let watcher = VexusWatcher::new();
        for generation in 1..=(WATCH_EVENT_QUEUE_CAPACITY + 100) {
            enqueue_watch_event(
                &watcher.events,
                &watcher.overflowed,
                WatchEvent {
                    event: "change".to_string(),
                    path: "diary/event.txt".to_string(),
                    generation: generation as i64,
                    stable: true,
                    size: 1,
                    mtime_ms: 0,
                    emitted_at: 0,
                },
            );
        }
        assert_eq!(watcher.events.lock().unwrap().len(), WATCH_EVENT_QUEUE_CAPACITY);
        let events = watcher.drain_events(256);
        assert_eq!(events.len(), 256);
        assert_eq!(events[0].event, "overflow");
        assert!(!watcher.overflowed.load(Ordering::Acquire));
    }

    #[test]
    fn native_watcher_reconciles_repeatedly_and_releases_handles() {
        let dir = TestDirectory::new();
        let watcher = VexusWatcher::new();
        watcher.start_watch(WatcherConfig {
            root_path: dir.0.to_string_lossy().into_owned(),
            ignore_folders: vec![],
            ignore_prefixes: vec![],
            ignore_suffixes: vec![],
            initial_scan: Some(false),
            extensions: None,
            debounce_ms: Some(25),
            stability_ms: Some(25),
            stability_retries: Some(2),
        }).unwrap();

        let wait_for_missing = |expected: &str| {
            let started = std::time::Instant::now();
            while started.elapsed() < Duration::from_secs(5) {
                if watcher.drain_events(256).iter().any(|event| {
                    event.event == "unlink" && event.path.ends_with(expected)
                }) {
                    return;
                }
                thread::sleep(Duration::from_millis(10));
            }
            panic!("missing reconciliation event: {}", expected);
        };
        watcher.reconcile_watch_with_paths(HashSet::from([
            PathBuf::from("first.txt")
        ])).unwrap();
        wait_for_missing("first.txt");
        watcher.reconcile_watch_with_paths(HashSet::from([
            PathBuf::from("second.txt")
        ])).unwrap();
        wait_for_missing("second.txt");
        watcher.stop_watch().unwrap();
        assert!(watcher.events.lock().unwrap().is_empty());
        assert!(watcher.worker_handles.lock().unwrap().is_empty());
        assert!(watcher.reconcile_handle.lock().unwrap().is_none());
        // Windows 上仍有 notify 目录句柄时，删除/重命名会失败。
        let moved = dir.0.with_extension("released");
        std::fs::rename(&dir.0, &moved).unwrap();
        std::fs::remove_dir_all(moved).unwrap();
    }

    #[test]
    fn snapshot_distinguishes_non_file_from_absence() {
        let dir = TestDirectory::new();
        assert_eq!(watch_file_snapshot(&dir.0), Err(std::io::ErrorKind::InvalidInput));
        assert_eq!(watch_file_snapshot(&dir.0.join("missing.txt")), Ok(None));
    }
}
