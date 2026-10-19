#![deny(clippy::all)]

mod text;
mod global_chunks;
mod light_memo;
mod index_handle;
mod index_source;
mod index_maintenance;
mod retrieval_index;
mod publication_gate;
mod index_lifecycle;
mod ingestion;
mod knowledge_runtime;
mod memo_geometry;
mod tag_consistency;
mod memo_artifact_builder;
mod memo_pipeline;
mod memo_projection;
mod memo_sensing;
mod memo_thinking;
mod result_deduplicator;
mod rivermemo_topology_v3;
mod schema;
mod storage;
mod task_lifecycle;

use rivermemo_topology_v3::MemoRuntime;
use task_lifecycle::{TaskLifecycle, TrackedTask};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use crate::retrieval_index::RetrievalIndex as Index;

/// 搜索结果 (返回 ID 而非 Tag 文本)
/// 上层 JS 会拿着 ID 去 SQLite 里查具体的文本内容
#[napi(object)]
pub struct SearchResult {
    pub id: i64, // 对应 SQLite 中的 chunks.id 或 tags.id
    pub score: f64,
}

/// 统计信息
#[napi(object)]
pub struct VexusStats {
    pub total_vectors: u32,
    pub dimensions: u32,
    pub capacity: u32,
    pub memory_usage: f64,
    /// Heap-resident routing, metadata and mutable delta estimate; excludes mmap.
    pub hot_bytes: f64,
    /// Mapped file length, not resident set size.
    pub mmap_bytes: f64,
    pub tombstones: f64,
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
    pub(crate) tasks: Arc<TaskLifecycle>,
    pub(crate) index: Arc<crate::index_handle::IndexHandle>,
    pub(crate) dimensions: u32,
    /// 索引内容代际。批量差分成功后只递增一次，供联合查询冻结和校验快照。
    pub(crate) content_revision: Arc<std::sync::atomic::AtomicU64>,
    /// TagMemo 与 RiverMemo 共用的原生图资产运行时。
    /// 与本 VexusIndex 实例同生命周期，禁止使用进程全局生产缓存。
    pub(crate) memo_runtime: Arc<MemoRuntime>,
}

/// One staging file per fixed generational slot. The caller must hold its
/// checkpoint gate until publication and SQL endorsement have finished.
/// This is not an index identity or a process-owned vector backing file.
pub(crate) struct CheckpointStaging(std::path::PathBuf);

impl CheckpointStaging {
    pub(crate) fn new(target: &std::path::Path) -> std::io::Result<Self> {
        let mut path = target.as_os_str().to_os_string();
        path.push(".tmp");
        let path = std::path::PathBuf::from(path);
        // Only called after publication is authorized and while its scope is
        // serialized. A leftover staging file has no SQL endorsement.
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        Ok(Self(path))
    }

    pub(crate) fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for CheckpointStaging {
    fn drop(&mut self) {
        match std::fs::remove_file(&self.0) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => eprintln!(
                "[Vexus-Lite] Checkpoint staging cleanup failed ({}): {}",
                self.0.display(), error
            ),
        }
    }
}

// Standalone saves and independent workspaces can overlap; their temporary
// names are not part of the SQL-endorsed generational index lifecycle.
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
    // 可读取也会返回 ERROR_ACCESS_DENIED。派生资产已完成临时文件写入，
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

impl VexusIndex {
    fn tracked_task<T: Task>(&self, task: T) -> AsyncTask<TrackedTask<T>> {
        AsyncTask::new(TrackedTask::new(&self.tasks, task))
    }
}

#[napi]
impl VexusIndex {
    /// 创建新的空索引
    #[napi(constructor)]
    pub fn new(dim: u32, capacity: u32) -> Result<Self> {
        let mut index = Index::empty(dim as usize)
        .map_err(|e| Error::from_reason(format!("Failed to create index: {:?}", e)))?;

        index
            .reserve(capacity as usize)
            .map_err(|e| Error::from_reason(format!("Failed to reserve capacity: {:?}", e)))?;

        Ok(Self {
            index: Arc::new(index_handle::IndexHandle::new(index)),
            dimensions: dim,
            tasks: Arc::new(TaskLifecycle::default()),
            content_revision: Arc::new(std::sync::atomic::AtomicU64::new(0)),
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

        let mut index = Index::load_standalone(std::path::Path::new(&index_path), dim as usize)
            .map_err(|e| Error::from_reason(format!("Failed to load vector asset: {}", e)))?;

        // 检查容量并扩容
        let current_capacity = index.capacity();
        if capacity as usize > current_capacity {
            // eprintln!("[Vexus] Expanding capacity on load: {} -> {}", current_capacity, capacity);
            index
                .reserve(capacity as usize)
                .map_err(|e| Error::from_reason(format!("Failed to expand capacity: {:?}", e)))?;
        }

        Ok(Self {
            index: Arc::new(index_handle::IndexHandle::new(index)),
            dimensions: dim,
            tasks: Arc::new(TaskLifecycle::default()),
            content_revision: Arc::new(std::sync::atomic::AtomicU64::new(0)),
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
    pub fn save_async(&self, index_path: String) -> AsyncTask<TrackedTask<IndexSaveTask>> {
        self.tracked_task(IndexSaveTask {
            index: self.index.clone(),
            index_path,
        })
    }

    /// 单个添加 (JS 循环调用)
    #[napi]
    pub fn add(&self, id: i64, vector: Float32Array) -> Result<()> {
        let mut index = self
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
        let mut index = self
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

        let keys: Vec<u64> = ids.iter().map(|id| *id as u64).collect();
        index.apply_delta(&[], &keys, vec_slice)
            .map_err(|error| Error::from_reason(format!("Batch add/update failed: {}", error)))?;
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
    ) -> AsyncTask<TrackedTask<ChunkIndexDeltaTask>> {
        self.tracked_task(ChunkIndexDeltaTask {
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
    /// N-API 调用只复制实际变化的向量并立即返回 Promise；耗时的索引删除、
    /// upsert 与 MemoRuntime 失效均在 libuv 工作线程执行，不阻塞 Node 事件循环。
    /// 搜索通过同一 RwLock 等待差分完成，只会看到差分前或差分后的索引。
    #[napi]
    pub fn apply_tag_delta(
        &self,
        remove_ids: Vec<i64>,
        upsert_ids: Vec<i64>,
        upsert_vectors: Float32Array,
    ) -> AsyncTask<TrackedTask<TagIndexDeltaTask>> {
        self.tracked_task(TagIndexDeltaTask {
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

        let results = matches.into_iter().map(|(id, cosine)| SearchResult {
            id: id as i64,
            score: cosine as f64,
        }).collect();

        Ok(results)
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
    ) -> AsyncTask<TrackedTask<memo_pipeline::MemoPipelineTask>> {
        memo_pipeline::run_with_runtime(
            &self.tasks,
            self.index.clone(),
            self.content_revision.clone(),
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
    ) -> AsyncTask<TrackedTask<rivermemo_topology_v3::RiverMemoTopologyV3Task>> {
        rivermemo_topology_v3::rerank_with_runtime(
            &self.tasks,
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
    ) -> AsyncTask<TrackedTask<memo_artifact_builder::NativeMemoArtifactBuildTask>> {
        memo_artifact_builder::rebuild_with_runtime(&self.tasks, self.dimensions as usize, self.memo_runtime.clone(), db_path, input_json)
    }

    /// 从已有 Sense 观测构建方法模块框架，不重新感应或修改图资产。
    /// 输入仅包含观测句柄、显式思维簇范围、候选 ID 与阶段配额。
    #[napi]
    pub fn plan_memo_thinking(
        &self,
        db_path: String,
        artifact_sig: String,
        input_json: String,
    ) -> AsyncTask<TrackedTask<memo_thinking::ThinkingTask>> {
        self.tracked_task(memo_thinking::ThinkingTask {
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

    /// Release one request observation without invalidating the shared artifact.
    #[napi]
    pub fn release_memo_observation(&self, handle: String) -> Result<bool> {
        self.memo_runtime.release_query_observation(&handle).map_err(Error::from_reason)
    }

    /// Read-only retained query payload diagnostics; never evicts observations.
    #[napi]
    pub fn memo_observation_memory_stats(&self) -> Result<String> {
        self.memo_runtime.observation_memory_stats().map_err(Error::from_reason)
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
        let mut index = self
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
        let (count, capacity, memory) = self.index.cached_stats();
        let (mmap, tombstones) = self.index.cached_asset_stats();
        Ok(VexusStats {
            total_vectors: count as u32,
            dimensions: self.dimensions,
            capacity: capacity as u32,
            memory_usage: memory as f64,
            hot_bytes: memory as f64,
            mmap_bytes: mmap as f64,
            tombstones: tombstones as f64,
        })
    }

    /// 从 SQLite 数据库恢复索引 (异步版本，不阻塞主线程)
    #[napi]
    pub fn recover_from_sqlite(
        &self,
        db_path: String,
        table_type: String,
        filter_diary_name: Option<String>,
    ) -> AsyncTask<TrackedTask<RecoverTask>> {
        self.tracked_task(RecoverTask {
            index: self.index.clone(),
            content_revision: self.content_revision.clone(),
            db_path,
            table_type,
            filter_diary_name,
            dimensions: self.dimensions,
        })
    }

    #[napi]
    pub fn compute_memo_geometry(&self, db_path: String, model_sig: String, config_json: String)
        -> AsyncTask<TrackedTask<memo_geometry::GeometryTask>> {
        self.tracked_task(memo_geometry::GeometryTask {
            index: self.index.clone(), content_revision: self.content_revision.clone(),
            dimensions: self.dimensions as usize, db_path, model_sig, config_json,
        })
    }
}

pub(crate) fn save_index_snapshot(
    index: &Arc<crate::index_handle::IndexHandle>,
    index_path: &str,
) -> std::result::Result<(), String> {
    let index = index
        .read()
        .map_err(|error| format!("Index save lock failed: {}", error))?;
    let target = std::path::Path::new(index_path);
    let temp = unique_index_sidecar_path(target, "tmp");
    let temp_text = temp.to_string_lossy().into_owned();
    if let Err(error) = index.write_staging(&temp, index.identity()) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("Failed to stream temporary index {}: {}", temp_text, error));
    }
    drop(index);

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
    index: Arc<crate::index_handle::IndexHandle>,
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
    index: Arc<crate::index_handle::IndexHandle>,
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

        let mut index = self.index.write().map_err(|error| {
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

        let removes: Vec<u64> = unique_removes.iter().map(|id| *id as u64).collect();
        let upserts: Vec<u64> = self.upsert_ids.iter().map(|id| *id as u64).collect();
        let applied_deletes = index.apply_delta(&removes, &upserts, &self.upsert_vectors)
            .map_err(|error| Error::from_reason(format!("Chunk delta failed: {}", error)))? as u32;
        let applied_upserts = upserts.len() as u32;

        let total_vectors = index.size() as u32;
        let revision = self.content_revision.fetch_add(1, Ordering::AcqRel) + 1;
        drop(index);

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
    index: Arc<crate::index_handle::IndexHandle>,
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

        let mut index = self.index.write().map_err(|error| {
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

        let removes: Vec<u64> = unique_removes.iter().map(|id| *id as u64).collect();
        let upserts: Vec<u64> = self.upsert_ids.iter().map(|id| *id as u64).collect();
        let applied_deletes = index.apply_delta(&removes, &upserts, &self.upsert_vectors)
            .map_err(|error| Error::from_reason(format!("Tag delta failed: {}", error)))? as u32;
        let applied_upserts = upserts.len() as u32;

        let total_vectors = index.size() as u32;
        self.content_revision
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        drop(index);

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
    index: Arc<crate::index_handle::IndexHandle>,
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
        let diary = match self.table_type.as_str() {
            "tags" => None,
            "chunks" => Some(self.filter_diary_name.as_deref().ok_or_else(|| {
                Error::from_reason("Recovery requires a diary name for chunk indices")
            })?),
            _ => return Err(Error::from_reason("Unsupported recovery table type")),
        };
        let scope = diary.map(|name| format!("diary:{}", name))
            .unwrap_or_else(|| "global_tags".to_string());
        let _gate = publication_gate::acquire(&self.db_path, &[scope])
            .map_err(Error::from_reason)?;
        let revision = self.content_revision.load(Ordering::Acquire);
        let build = storage::with_registered_read_transaction(&self.db_path, |connection| {
            index_source::build_memory_from_connection(
                connection, diary, self.dimensions as usize,
                "unendorsed-runtime-recovery",
            )
        }).map_err(Error::from_reason)?;
        let count = u32::try_from(build.index().len())
            .map_err(|_| Error::from_reason("Recovery vector count exceeds N-API limit"))?;
        let skipped = build.skipped_invalid;
        let mut index = self.index.write().map_err(|error| {
            Error::from_reason(format!("Recover index lock failed: {}", error))
        })?;
        if self.content_revision.load(Ordering::Acquire) != revision {
            return Err(Error::from_reason("Recovery content revision changed; retry required"));
        }
        *index = Index::from_sql(build);
        self.content_revision.fetch_add(1, Ordering::AcqRel);
        drop(index);
        if skipped > 0 {
            eprintln!("[Vexus-Lite] Recovery skipped {} invalid SQL vectors", skipped);
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
    let Ok(relative) = path.strip_prefix(root_path) else { return false; };
    knowledge_path_allowed(relative, allowed_extensions, ignore_folders, ignore_prefixes, ignore_suffixes)
}

/// Shared lexical filter: also works for deleted paths, without filesystem I/O.
pub(crate) fn knowledge_path_allowed(
    relative: &Path,
    extensions: &HashSet<String>,
    folders: &HashSet<String>,
    prefixes: &[String],
    suffixes: &[String],
) -> bool {
    if relative.as_os_str().is_empty() || relative.components().any(|component| {
        !matches!(component, std::path::Component::Normal(_))
    }) {
        return false;
    }
    let parts: Vec<_> = relative.iter().map(|part| part.to_string_lossy()).collect();
    let file = parts.last().map(|part| part.as_ref()).unwrap_or("");
    let diary = if parts.len() > 1 { parts[0].as_ref() } else { "Root" };
    if parts.iter().take(parts.len().saturating_sub(1)).any(|part| {
        part.starts_with('.') || ["node_modules", ".git", "dist", "target", "image"].contains(&part.as_ref())
            || folders.contains(part.as_ref())
    }) || folders.contains(diary) {
        return false;
    }
    let extension = relative.extension().map(|value| value.to_string_lossy().to_lowercase());
    extension.is_some_and(|value| extensions.contains(&value))
        && !prefixes.iter().any(|value| diary.starts_with(value) || file.starts_with(value))
        && !suffixes.iter().any(|value| diary.ends_with(value) || file.ends_with(value))
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

/// Full scans are replayable producers, not real-time notify callbacks. Apply
/// cancellable backpressure instead of dropping events and triggering another
/// full scan. Never hold the queue mutex while waiting for the JS consumer.
fn enqueue_scan_event(
    events: &Arc<Mutex<VecDeque<WatchEvent>>>,
    overflowed: &AtomicBool,
    running: &AtomicBool,
    event: WatchEvent,
) -> bool {
    while running.load(Ordering::Acquire) {
        {
            let Ok(mut queue) = events.lock() else {
                overflowed.store(true, Ordering::Release);
                return false;
            };
            if queue.len() < WATCH_EVENT_QUEUE_CAPACITY {
                queue.push_back(event);
                return true;
            }
        }
        if !wait_for_watcher_duration(running, Duration::from_millis(25)) {
            return false;
        }
    }
    false
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
            if !enqueue_scan_event(
                events,
                overflowed,
                running,
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
            ) {
                return;
            }
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
        if !enqueue_scan_event(
            events,
            overflowed,
            running,
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
        ) {
            return;
        }
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
                handle.thread().unpark();
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
                // 停泊保留唤醒令牌，避免请求发生在检查标志和 park 之间时丢失。
                // 新请求与 stop_watch 均负责 unpark，无空闲轮询。
                while running.load(Ordering::Acquire) {
                    if !reconcile_requested.swap(false, Ordering::AcqRel) {
                        thread::park();
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
            handle.thread().unpark();
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


#[cfg(test)]
mod path_filter_tests {
    use super::*;

    #[test]
    fn shared_filter_handles_nested_folders_root_names_and_custom_extensions() {
        let extensions = HashSet::from(["txt".into(), "custom".into()]);
        let folders = HashSet::from(["ignored".into()]);
        for relative in ["diary/node_modules/a.txt", "diary/.hidden/a.txt",
            "diary/ignored/a.txt", "target/a.txt", "../outside.txt", "a.md"] {
            assert!(!knowledge_path_allowed(Path::new(relative), &extensions, &folders, &[], &[]), "{}", relative);
        }
        for relative in ["root.txt", "diary/nested/a.TXT", "diary/a.custom"] {
            assert!(knowledge_path_allowed(Path::new(relative), &extensions, &folders, &[], &[]), "{}", relative);
        }
        assert!(!knowledge_path_allowed(Path::new("root.txt"), &extensions, &folders, &["Root".into()], &[]));
        assert!(!knowledge_path_allowed(Path::new("diary/pre-a.txt"), &extensions, &folders, &["pre-".into()], &[]));
        assert!(!knowledge_path_allowed(Path::new("diary/a.txt"), &extensions, &folders, &[], &[".txt".into()]));
    }

    #[test]
    fn initial_scan_and_notify_filter_agree_on_nested_ignored_paths() {
        let root = std::env::temp_dir().join(format!(
            "kbm-filter-{}-{}", std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        let paths = ["diary/kept.txt", "diary/node_modules/no.txt",
            "diary/.hidden/no.txt", "diary/ignored/no.txt"];
        for relative in paths {
            let path = root.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "Tag: example").unwrap();
        }
        let extensions = HashSet::from(["txt".into()]);
        let folders = HashSet::from(["ignored".into()]);
        let events = Arc::new(Mutex::new(VecDeque::new()));
        emit_initial_watch_events(&root, &extensions, &folders, &[], &[],
            &AtomicU64::new(0), &events, &Arc::new(AtomicBool::new(false)),
            &AtomicBool::new(true), &HashSet::new());
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 1);
        for relative in paths {
            let path = root.join(relative);
            let emitted = events.iter().any(|event| event.path == path.to_string_lossy().replace('\\', "/"));
            assert_eq!(emitted, watcher_path_allowed(&path, &root, &extensions, &folders, &[], &[]));
        }
        drop(events);
        std::fs::remove_dir_all(root).unwrap();
    }
}


#[cfg(test)]
mod sql_recovery_tests {
    use super::*;

    #[test]
    fn compatibility_recovery_builds_memory_without_private_vector_files() {
        let root = std::env::temp_dir().join(format!("kbm-memory-recovery-{}-{}",
            std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&root).unwrap();
        let db = root.join("test.sqlite").to_string_lossy().into_owned();
        let (storage, _) = storage::SqliteStorageEngine::open_and_init(
            &db, storage::StorageOptions::default()).unwrap();
        storage.submit_write(|tx| {
            let bytes = [1_f32,0.].iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<_>>();
            tx.execute("INSERT INTO tags(name,vector) VALUES ('tag',?1)", [bytes])
                .map_err(|e| e.to_string())?;
            Ok(storage::WriteReceipt {
                operation:"fixture".into(),database_generation:0,facts_changed:true,
            })
        }).unwrap();
        let index = VexusIndex::new(2, 16).unwrap();
        let before = std::fs::read_dir(&root).unwrap().count();
        let mut task = RecoverTask {
            index:index.index.clone(),content_revision:index.content_revision.clone(),
            db_path:db.clone(),table_type:"tags".into(),filter_diary_name:None,dimensions:2,
        };
        assert_eq!(task.compute().unwrap(), 1);
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), before);
        assert_eq!(index.stats().unwrap().mmap_bytes, 0.);
        storage::with_registered_read_transaction(&db, |connection| {
            assert_eq!(index.index.read().unwrap().search_sql(connection, None, &[1.,0.], 1)
                .map_err(|e| e.to_string())?, vec![(1,1.)]);
            Ok(())
        }).unwrap();
        assert!(index.save(root.join("bypass.vec").to_string_lossy().into_owned())
            .unwrap_err().reason.contains("generational publication"));
        assert!(!root.join("bypass.vec").exists());
        drop(task);
        drop(index);
        storage.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
