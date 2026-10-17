# KBM 纯 Rust 单一 SQL 真相源与异步冷启动架构施工草图

> **状态**：最终施工方案已写入第 7—16 章；第 1—6 章仅保留为历史调查，不作为当前施工指令。仅修改文档，尚未实施生产源码迁移。
> **日期**：2026-10-17
> **作者**：Kerr & Ryan
> **目标仓库**：`H:\VCP\VCPMain\VCPToolBox`

---

## 1. 核心命题与第一性原理边界

### 1.1 为什么不把整个 VCPToolBox 主服务器重写为纯 Rust？
VCPToolBox 的核心竞争力之一是 `Plugin.js` 统领的 90+ 常驻服务插件、预消息处理器（Preprocessor）与混合插件生态。这些 JS 插件运行在**同一个 V8 Heap** 内，通过对象引用直传（0ns 指针传递）和动态模块方法混入深度协同。
若将 HTTP/WebSocket 主服务器强行改为纯 Rust，任何插件钩子调用都将退化为跨进程 IPC 或跨 FFI 边界的 JSON 序列化/反序列化，重蹈 Tauri 双堆状态撕裂的覆辙。

### 1.2 真正需要纯 Rust 大一统的边界在哪里？
真正的性能与内存病灶不在业务编排层，而在 **`KnowledgeBaseManager`（KBM）的数据面与存储主权割裂**：
1. **现状割裂**：`rust-vexus-lite` 仅负责 ANN 检索与 RiverMemo/EPA 算子计算；而 `VectorStore/database.sqlite`（及 `knowledge_base.sqlite`）的 Schema 管理、写入、冷启动对称差分查询、双槽基线调度、以及 `LightMemo` 的候选拉取，仍由 JS 侧 `better-sqlite3` 同步持有并执行。
2. **破局方向（One SQL Truth in Rust）**：
   - **保留 JS 控制面**：Node.js 主进程继续承载全部插件生态、HTTP/SSE 流式路由与远端 Embedding API 网络请求；
   - **收归 Rust 数据面**：将中央记忆库 SQLite 的**唯一读写持有权**、USearch 向量索引生命周期（含冷启动按需加载、双槽代际回放、空闲卸载）、文件变更 Diff 预检、以及 `LightMemo` 作用域混合检索，100% 收拢至 `rust-vexus-lite` 的 `NativeKnowledgeRuntime` 内部。
   - **彻底移除 KBM 的 `better-sqlite3` 连接**：让中央记忆库在全进程内只有 Rust `rusqlite` 一个连接池真相源，从物理上消灭双连接 Page Cache 膨胀、跨语言 WAL 写锁竞态（`rustWriteLease`）与 V8 主线程阻塞。

---

## 2. 现行架构三大病灶的源码级验尸（Forensics）

### 2.1 病灶一：Agent B 后台唤醒冷启动，卡停 Agent A 的 SSE 流式输出
当 Agent A 正在进行高频 SSE 流式输出时，若 Agent B 进入后台唤醒并触发未驻留日记本的记忆检索，Node.js 主线程 Event Loop 会出现 **100ms~400ms 级别的同步冻结**。源码级真凶如下：

1. **USearch 索引同步加载阻塞主线程**：
   - 坐标：`rust-vexus-lite/src/lib.rs:324` (`#[napi(factory)] pub fn load(...)`) 与 `lib.rs:374` (`#[napi] pub fn save(...)`)。
   - 问题：这两个 N-API 方法均为**同步导出函数**。当 `modules/knowledgeBase/indexRepository.js:183` (`loadDiaryBaseline`) 或 `422` (`loadGlobalTagBaseline`) 调用 `this.VexusIndex.load(...)` 时，直接在 V8 主线程上执行磁盘 I/O 与 HNSW 图结构反序列化；同理，`publishDiaryBaseline` (`indexRepository.js:317`) 与 `publishGlobalTagBaseline` (`529`) 调用 `index.save(...)` 在主线程同步写盘并执行 Windows 文件替换重试。
2. **冷启动基线对称差分在 JS 主线程拉取全量 Vector BLOB**：
   - 坐标：`modules/knowledgeBase/indexRepository.js:107-159` (`_countDiaryBaselineDelta`) 与 `191-257` (`loadDiaryBaseline` 差分回放)；Tag 基线同理位于 `366-485`。
   - 问题：用 `better-sqlite3` 在主线程同步执行多表 `LEFT JOIN chunk_index_baseline_entries` 查询，将所有增量 Chunk 的 `3072 * 4 = 12KB` Vector BLOB 读入 V8 堆内存，再在 JS 主线程分配巨型 `new Float32Array(addedRows.length * 3072)` 逐行拷贝（`flat.set`），最后再跨 N-API 传回给 Rust 的 `index.applyChunkDelta(...)`。
   - 荒谬性：**数据原本在 SQLite，目标消费者是同进程的 Rust `usearch::Index`，却在冷启动热路径上绕道 V8 主线程完成同步查询与内存拼接！**

### 2.2 病灶二：`LightMemo` 引发数百 MB 内存峰值与 V8 Major GC 停顿
每次调用 `LightMemo`（如 JEV `主动回忆`），都会制造剧烈的 RSS 内存尖峰并卡顿主线程：

1. **全表拉取 Chunk 正文并在 V8 主线程全量 Jieba 分词**：
   - 坐标：`Plugin/LightMemo/LightMemo.js:2002-2092` (`_gatherCandidateChunks`)。
   - 问题：直接操作 `this.vectorDBManager.db.prepare(...)` 执行 `SELECT c.id, c.file_id, c.content, f.diary_name, f.path FROM chunks c JOIN files f ON c.file_id = f.id`，把目标日记本（开启全库搜索时为整库）数千至上万条 Chunk 的完整文本同步拉入 V8，紧接着对每条 Chunk 同步调用 `this.jiebaInstance.cut(text)` 构造 `tokens` 数组常驻在候选对象上。
2. **绕过 Rust 索引，在 JS 主线程执行 N+1 次 BLOB 查询与纯 JS 余弦点积**：
   - 坐标：`Plugin/LightMemo/LightMemo.js:2111-2145` (`_scoreByVectorSimilarity`) 及 `671` (`_handleRiverMemoSearch`)、`923` (`handleMemoryAB`)。
   - 问题：对收集到的全部 `candidates`（即便在 RiverMemo 模式下），先在 JS 主线程循环调用 `stmt.get(candidate.label)`（`SELECT vector FROM chunks WHERE id = ?`），将数千条 12KB 向量 BLOB 逐一拉进 Node.js Buffer，再用纯 JS 循环 `this._cosineSimilarity(queryVector, chunkVector)` 算几千万次浮点乘加！
   - 二次读取：第 680 行将算完分数的庞大 JS 候选数组传给 `rerankWithRiverMemoAsync` 后，Rust 侧（`result_deduplicator.rs` / `rivermemo_topology_v3.rs`）又打开 `rusqlite` 连接去同一个 SQLite 数据库二次读取这批向量！

### 2.3 病灶三：SQLite 双连接争抢、双倍 Page Cache 与 `rustWriteLease` 复杂度
1. **双驱动并存**：
   - JS 侧：`KnowledgeBaseManager.js:345` 使用 `better-sqlite3` 打开长连接 `this.db`；
   - Rust 侧：`rust-vexus-lite/src/` 下共 6 处使用 `rusqlite::Connection::open_with_flags` 打开同一数据库文件（`knowledge_runtime.rs:344`、`lib.rs:1434/1455`、`memo_artifact_builder.rs:81/93`、`memo_pipeline.rs:72`、`result_deduplicator.rs:35`、`rivermemo_topology_v3.rs:601`）。
2. **后果**：
   - **双份内存页缓存**：`better-sqlite3` 与 `rusqlite` 各自在 C++/Rust 堆维护独立的 SQLite Page Cache；当 `LightMemo` 全表扫 `chunks` 时，`better-sqlite3` 缓存急剧膨胀且不与 Rust 共享。
   - **跨语言写锁互斥胶水**：因为 JS 写 `files/chunks/tags/*_baselines`，而 Rust 写 `tag_pair_similarity` / `tag_intrinsic_residuals` / `tagmemo_artifacts`，为了防止双写触发 `SQLITE_BUSY`，被迫在 `KnowledgeBaseManager.js:85-92, 251, 904-922` 与 `modules/knowledgeBase/databaseCoordinator.js` 中编写了近 600 行的 `rustWriteLease` 租约状态机与 `waitForIdle` 50ms 轮询等待。

---

## 3. 全仓 `kbm.db` 触点盘点与隔离边界

### 3.1 独立 SQLite 数据库（保持原状，不在本工程变更范围内）
经全仓检索 `require('better-sqlite3')`，以下模块操作的是**各自独立的业务 `.sqlite` 文件**，与中央记忆库无交集，保持原样：
- `TDBKnowledge.js` (`VectorStoreTDB/tdb_knowledge_meta.sqlite`)
- `modules/toolCallRecordStore.js`
- `Plugin/OneRing/OneRingDB.js`
- `Plugin/OpenHerPersona/OpenHerPersona.js`
- `Plugin/RAGDiaryPlugin/FoldingStore.js`
- `Plugin/ImageProcessor/image-processor.js` 与 `routes/admin/cache.js`

### 3.2 中央记忆库 (`kbm.db`) 全仓触点清单与迁移对策

| 序号 | 模块文件 | 触碰 `db` 的具体行为 | 迁移至 Rust 单一 SQL 真相源后的对策 |
|---|---|---|---|
| 1 | `KnowledgeBaseManager.js` | 打开/关闭连接、世代指纹计算 (`_computeNativeMemoDatabaseGeneration`)、孤儿清理、幽灵索引自检、`kv_store` 缓存查询、`hydrateChunks` | 全部收敛为 `NativeKnowledgeRuntime` 的原生异步方法 |
| 2 | `modules/knowledgeBase/schemaManager.js` | 表结构初始化、迁移与索引创建 | 移交 Rust `NativeKnowledgeRuntime::open_and_init_schema` 在启动时原子执行 |
| 3 | `modules/knowledgeBase/sqliteHealthManager.js` | WAL checkpoint、`PRAGMA quick_check`、损坏备份恢复 | 移交 Rust SQLite Writer 线程内建健康检查与恢复机制 |
| 4 | `modules/knowledgeBase/indexRepository.js` | 读写 `chunk_index_baselines`、`tag_index_baselines`、拉取差分 BLOB 回放 | **整块下沉至 Rust**：基线校验、USearch 加载、差分 BLOB 零拷贝回放、双槽原子发布全部在 Rust 后台完成 |
| 5 | `modules/knowledgeBase/ingestionPipeline.js` | 文件 `checksum/mtime/size` 比对、`files/chunks/tags/file_tags` 事务增删、`migration_deleted_files` 消费 | Rust 负责文件 Diff 预检（返回缺向量的文本给 JS）与拿到向量后的单线程事务写入 + 内存索引热更新 |
| 6 | `modules/knowledgeBase/databaseCoordinator.js` | `rustWriteLease` 租约授予/释放、外部文件变更轮询等待 | **彻底废除 `rustWriteLease`**；外部文件变更等待改为 Rust 异步 `Notify` 事件唤醒 |
| 7 | `modules/knowledgeBase/diaryMetadataCache.js` & `migrationVectorCache.js` | 查某日记本内文件的日期范围 (`files.path`)；查迁移重命名缓存向量 | 日期范围过滤直接内置于 Rust 检索器；迁移向量复用在 Rust 摄取预检阶段内部直接完成，无需跨界回传 JS |
| 8 | `modules/knowledgeBase/tagConsistencyService.js` | 统计 Tag 一致性快照、同步文件 Tag、补齐缺失 Tag 向量、清理孤儿 Tag | 拆分为 Rust `inspect_tag_consistency()`、`prepare_tag_sync()` 与 `commit_tag_vectors()` 原生接口 |
| 9 | `Plugin/LightMemo/LightMemo.js` | `_gatherCandidateChunks` 全表拉文本分词、`_scoreByVectorSimilarity` N+1 拉 BLOB 算余弦 | **彻底废除 JS 侧 `.db` 访问**：改为调用 `NativeKnowledgeRuntime` 的作用域混合检索 API，仅返回 Top-K 结果 |
| 10 | `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js` | 仅第 3748 行：`SELECT id FROM files WHERE diary_name IN (...)` | `NativeKnowledgeRuntime` 检索时直接按 `diary_names` 过滤，或提供轻量 `getFileIdsByDiaries` 接口 |
| 11 | `modules/associativeDiscovery.js` | 第 76、220、234 行：查日记名列表、按路径查 `file_id` 及首分片向量作为种子 | 在 `NativeKnowledgeRuntime` 提供 `resolve_association_seed(rel_paths)` 或直接在 Rust 内执行种子联想查询 |
| 12 | `TagMemoEngine.js` / `TagMemoV10Engine.js` / `EPAModule.js` / `ResidualPyramid.js` / `ResultDeduplicator.js` | 派生表读写与旧 JS 回退路径 | 生产主链已在 `memo_artifact_builder.rs`、`memo_pipeline.rs`、`result_deduplicator.rs` 中完成；剥离死代码回退，管理状态查询走 Rust |

---

## 4. 目标架构设计：`NativeKnowledgeRuntime` 单一 SQL 真相源

```
+-----------------------------------------------------------------------------------+
|                              Node.js 主进程 (控制面)                               |
|  +------------------+   +-----------------------+   +--------------------------+  |
|  | 90+ 业务/预处理  |   | LightMemo / RAGDiary  |   | EmbeddingUtils (HTTP)    |  |
|  | 插件 (同V8堆互调)|   | Associate / KBM 薄门面|   | 唯一职责: 文本 -> 向量API|  |
|  +--------+---------+   +-----------+-----------+   +-------------+------------+  |
|           |                         |                             ^               |
|           | 零阻塞 SSE 流转发        | N-API AsyncTask (仅传轻量参数与Top-K结果)    |
+-----------+-------------------------+-----------------------------+---------------+
                                      |                             |
+-------------------------------------v-----------------------------+---------------+
|                     rust-vexus-lite : NativeKnowledgeRuntime (数据面)              |
|                                                                                   |
|  +-----------------------------------------------------------------------------+  |
|  | 1. 单一 SQLite 权威连接池 (SqliteStorageEngine)                              |  |
|  |  - 1x Dedicated Write Actor Thread (mpsc 串行事务队列: 零锁争抢、零租约)     |  |
|  |  - Nx Read-Only Pool (受控 mmap_size / cache_size, query_only=ON)           |  |
|  +-----------------------------------------------------------------------------+  |
|  | 2. USearch 索引注册表与零拷贝冷启动自愈 (IndexLifecycleManager)              |  |
|  |  - 后台异步按需加载 (Lazy Load on Query) + 2h 空闲自动卸载 (Idle Evict)      |  |
|  |  - 对称差分回放: SQLite BLOB -> &[f32] 直接灌入 USearch (0 字节经过 V8!)     |  |
|  |  - 达到 5% 变动阈值时后台异步写非活动槽 (slot a/b) + Write Actor 切换代际    |  |
|  +-----------------------------------------------------------------------------+  |
|  | 3. 原生全链路检索与 LightMemo 下沉引擎                                       |  |
|  |  - 支持 diary_names / excluded_folders / time_range / maid 署名过滤          |  |
|  |  - Rust 内置分词 BM25 + USearch ANN / 精确余弦 + 语义去重 + RiverMemo V3     |  |
|  +-----------------------------------------------------------------------------+  |
|  | 4. Notify 文件监听与两阶段摄取状态机 (IngestionCoordinator)                  |  |
|  |  - Stage A (Rust): 文件稳定防抖 -> MD5/mtime对账 -> 切Chunk/Tag -> 复用旧向量 |  |
|  |  - 仅将缺失向量的纯文本抛给 JS EmbeddingUtils                                |  |
|  |  - Stage B (Rust): 接收 Float32Array -> Write Actor 落库 -> 内存索引原子Delta|  |
|  +-----------------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------------+
```

### 4.1 关键机制一：Rust 内部 SQLite 单写多读池（彻底消灭 `rustWriteLease`）
- 在 `NativeKnowledgeRuntime` 内部维护唯一的 `SqliteStorageEngine`：
  - **Write Actor**：独占 1 条 `SQLITE_OPEN_READ_WRITE` 连接，运行在独立后台线程，通过有界/无界命令队列（`crossbeam_channel` 或 `tokio::sync::mpsc`）串行消费所有写事务：
    - Schema 初始化与迁移；
    - 文件摄取与删除批次（`files`、`chunks`、`tags`、`file_tags`、`migration_deleted_files`）；
    - 双槽代际基线发布（`chunk_index_baselines`、`tag_index_baselines`、`kv_store`）；
    - 派生资产构建落盘（`tag_pair_similarity`、`tag_intrinsic_residuals`、`tagmemo_artifacts` 等）。
  - **Read Pool**：维护固定上限（如 `4~8` 条）的 `SQLITE_OPEN_READ_ONLY` 连接池，统一配置 `PRAGMA cache_size = -16384`（16MB 上限）与合理的 `mmap_size`，避免每次查询反复 `Connection::open_with_flags` 带来的句柄与页缓存抖动。
- **架构收益**：全进程不再有任何第二个组件对 `database.sqlite` 发起写操作。`rustWriteLease`、`rustWriteLeaseGraceMs`、`rustWriteLeaseCooldownMs` 等全套租约逻辑在数学上不再需要，直接归零。

### 4.2 关键机制二：冷启动、双槽基线回放与保存的 100% Rust 异步闭环
- **消除所有同步 N-API 文件操作**：
  - 将 `VexusIndex::load` 与 `VexusIndex::save` 的内部逻辑收归 `NativeKnowledgeRuntime` 的后台任务线程池，禁止在 V8 主线程直接执行磁盘反序列化或落盘。
- **查询驱动的后台无感冷启动（Lazy Cold-Start in Rust）**：
  - 当 JS 调用 `executeNativeRiverQuery` 或 `searchKnn` 传入 `diary_names` 时，若某 `diary_name` 尚未加载：
    1. Rust 在 `AsyncTask`（libuv/Rayon 后台线程）中通过单飞锁（Singleflight / `DashMap<String, Arc<OnceCell<...>>>`）拦截并发重复加载；
    2. 从 Read Pool 读取 `chunk_index_baselines` 的 active slot (`a` 或 `b`)，校验 `dimension` 与 `model_sig`；
    3. 加载对应 `.usearch` 文件，并在同一 Rust 线程内执行对称差分 SQL，查询出 `deleted_chunk_ids` 与 `added_chunks (id, vector_blob)`；
    4. 直接在 Rust 栈上将 SQLite 行的 `&[u8]` 校验长度与对齐后转为 `&[f32]`，调用 `usearch::Index::remove` / `add` 完成内存回放；
    5. 若差分比例 $\ge 5\%$ 或基线不存在，向后台提交异步 Checkpoint 任务（写另一槽文件 + 通知 Write Actor 更新 `chunk_index_baselines`）。
  - **全程 0 字节 Vector BLOB 进入 Node.js V8 堆，Event Loop 阻塞时间为 0ms！**

### 4.3 关键机制三：`LightMemo` 下沉与内存峰值斩首
- 在 `NativeKnowledgeRuntime` 中新增作用域检索能力（或扩展 `NativeHybridQueryPlan`），原生支持 `LightMemo` 的全部过滤与重排语义：
  - **SQL 级精准过滤**：
    - `diary_names` 白名单与 `excluded_folders` 黑名单；
    - `time_range: Option<(i32, i32)>`：直接在 Rust 侧解析文件路径/文件名中的日期（如 `2026-10-12`）或通过 `files` 表预计算的 `diary_date_int` 索引列过滤，无需拉取正文；
    - `maid_signature: Option<String>`：在 SQLite 查询或 Rust 流式扫描 `chunks.content` 首行时直接判定 `first_line.contains(&maid)`，不匹配的记录连 Rust 候选池都不进，更不会拷入 V8！
  - **Rust 原生 BM25 + 向量余弦 + RiverMemo V3**：
    - 由 JS 传入已分词/扩展好的 `query_tokens: Vec<String>`（或由 Rust 侧分词）及 `query_vector: Float32Array`；
    - 在 Rust 内部对符合作用域的候选流式计算 BM25 分数与精确向量相似度（直接读取 SQLite BLOB 视图算点积或走 USearch 子集检索，无需分配持久化大数组）；
    - 若 `engine_mode == "rivermemo"`，在同一 Rust 内存空间内无缝衔接 `rivermemo_topology_v3` 重排；
    - 最终**仅将排名前 `final_k`（通常 5~50 条）的 Chunk 文本、路径与诊断分值序列化回 JS**（随后在 JS 层按需走可选的外部 HTTP Rerank / JEV / AIMemo 总结）。
- **收益**：`LightMemo.js` 中的 `_gatherCandidateChunks`（全表拉文本）与 `_scoreByVectorSimilarity`（N+1 拉向量 BLOB）被彻底废除，单次检索 V8 内存峰值从数百 MB 降至 **<100KB**。

### 4.4 关键机制四：文件变更（Notify / DailyNote）-> KBM 两阶段摄取闭环
为了兼顾“Rust 独占 SQLite”与“JS 持有远端 Embedding HTTP 客户端（含多渠道容灾、代理与密钥配置）”，文件摄取采用 **Rust 预检 (Stage A) -> JS 算向量 -> Rust 提交 (Stage B)** 的两阶段流水线：

1. **统一文件变更入口**：
   - Rust `VexusWatcher` 监听 `dailynote/` 目录（内蔵 500ms 尺寸/mtime 稳定性校验與忽略目录过滤）；
   - 同时暴露 `runtime.notifyFileMutations(upserts, deletes)` 供 `DailyNote` / `DailyNoteManager` 等插件在主动写盘后显式触发，消除 OS 文件监听延迟。
2. **Stage A：`runtime.prepareIngestionBatch(filePaths)`（Rust 后台线程执行）**：
   - Rust 读取磁盘文件，校验读取前后 `size/mtime` 快照一致性；
   - 计算 MD5 `checksum`，对比 SQLite `files` 表：
     - 若 `checksum` 未变且向量完整，Write Actor 直接静默更新 `mtime/size`，该文件处理完毕；
     - 若文件发生了内容变更，在 Rust 侧执行 `TextChunker`（与现行 `TextChunker.js` 算法对齐，或由 JS 传入切分结果）和 Tag 提取；
     - 自动查询 SQLite `migration_deleted_files`（迁移缓存）与 `tags` 表，复用已存在的 Chunk 向量和 Tag 向量；
   - 最终仅向 JS 返回一个极简增量任务包：
     ```ts
     interface PreparedIngestionBatch {
       batchId: string;
       fastUpdatedFiles: number;
       missingChunkTexts: string[]; // 仅真正需要调 API 的新 Chunk 文本
       missingTagTexts: string[];   // 仅真正需要调 API 的新 Tag 名称
     }
     ```
3. **JS 无状态算向量**：
   - `KBM.js` 收到 `PreparedIngestionBatch` 后，若 `missingChunkTexts` 和 `missingTagTexts` 均为空，直接调用 `commitIngestionBatch(batchId, empty, empty)`；
   - 否则调用现有的 `EmbeddingUtils.getEmbeddingsBatch(...)` 获取 `Float32Array` 向量缓冲区。
4. **Stage B：`runtime.commitIngestionBatch(batchId, chunkVectors, tagVectors)`（Rust Write Actor + Index 原子更新）**：
   - Write Actor 在单个 SQLite 事务内写入 `files`、`chunks`、`tags`、`file_tags`，消费 `migration_deleted_files`，并递增数据库代际；
   - 同步对已加载在内存中的对应 `diary_name` USearch 索引与 `global_tags` 索引执行同写锁原子 Delta（`remove_ids + upsert_vectors`）；
   - 触发内部 `Notify` 唤醒所有正在 `awaitIndexedFilePaths` 的调用方（彻底替代 `databaseCoordinator.js` 的 50ms `while` 轮询）。

---

## 5. 分阶段施工路线图（Phased Implementation Plan）

为保证系统在演进过程中的绝对稳定与可测性，建议按以下 3 个独立可验收的 Phase 推进：

### Phase 1：止血与降峰——冷启动纯 Rust 异步闭环 + `LightMemo` 原生下沉
> **目标**：不破坏现有写入链路的前提下，立即消灭“Agent B 冷启动卡停 Agent A 流式输出”与“`LightMemo` 内存峰值”。
1. **Rust 侧 (`rust-vexus-lite`)**：
   - 为 `NativeKnowledgeRuntime` 建立内部受控的 `rusqlite` Read Pool；
   - 将日记本 USearch 索引与全局 Tag 索引的**冷启动加载 (`load`)、SQLite 基线对称差分回放 (`replay`)、双槽基线保存 (`save`)** 全部封装为 Rust 原生 `AsyncTask`，在 Rust 内部直接将 SQLite BLOB 转为 `&[f32]` 灌入 USearch；
   - 新增原生 `executeScopedLightMemoQuery`（支持 `diaryNames`、`excludedFolders`、`timeRange`、`maidSignature`、BM25 分词打分、向量打分与 RiverMemo V3 串联），只向 JS 返回 Top-K 命中结果。
2. **JS 侧 (`indexRepository.js` & `LightMemo.js`)**：
   - 删除 `indexRepository.js` 中在 V8 主线程用 `better-sqlite3` 拉取 `addedRows` BLOB 拼装 `Float32Array` 的逻辑，改为调用 Rust 异步基线恢复接口；
   - 删除 `LightMemo.js` 中的 `_gatherCandidateChunks` 全表 SQL 查询与 `_scoreByVectorSimilarity` N+1 向量查询，全面切换至 `NativeKnowledgeRuntime` 作用域查询。
3. **Phase 1 验收基准**：
   - 后台触发未加载日记本冷启动时，主线程 Event Loop Lag 监控（`eventLoopWatchdog`）峰值 `< 5ms`；
   - `LightMemo` 全库搜索时，V8 堆内存增量 `< 5MB`，不再触发全量 BLOB 拉取。

### Phase 2：收缴外围 `.db` 裸访问权与统一只读网关
> **目标**：让 `RAGDiaryPlugin`、`associativeDiscovery`、`searchService`、`TagMemoV10Engine` 等外围模块与 `kbm.db` 彻底解耦。
1. 在 `NativeKnowledgeRuntime` 暴露轻量元数据与种子查询接口：
   - `listDistinctDiaries()`
   - `getFileIdsByDiaries(diaryNames)`
   - `resolveAssociationSeeds(relPaths)`
   - `hydrateChunksByIds(chunkIds)` / `getChunksByFilePaths(relPaths)`
   - `getKvVector(key)` / `setKvVector(key, vector)`
2. 迁移 `RAGDiaryPlugin.js:3748`、`modules/associativeDiscovery.js`、`modules/knowledgeBase/searchService.js`、`KnowledgeBaseManager.js` 中的全部只读 SQL 查询至上述 Rust 接口。
3. 清理 `TagMemoEngine.js`、`EPAModule.js`、`ResidualPyramid.js`、`ResultDeduplicator.js` 中已不再被生产路径调用的旧 JS SQLite fallback 分支（保留共享生命周期门面与 Rust 产物的构建调度）。

### Phase 3：单写者收官——摄取管线移交 Rust Write Actor，废除 `better-sqlite3` 与 `rustWriteLease`
> **目标**：彻底拔除 KBM 的 `better-sqlite3` 连接，实现全服唯一 SQLite 真相源。
1. 在 `NativeKnowledgeRuntime` 中落地 **Dedicated SQLite Write Actor**，接管：
   - `schemaManager`（表初始化、加列迁移，建议在 `files` 表持久化 `file_date_int` 加速日期范围查询）；
   - `sqliteHealthManager`（启动与运行期健康检查、checkpoint、损坏恢复）；
   - `ingestionPipeline`（两阶段 `prepareIngestionBatch` + `commitIngestionBatch` 及删除批次）；
   - `tagConsistencyService`（Tag 一致性快照、同步与孤儿清理）；
   - `memo_artifact_builder`（派生表写入直接走同一个 Write Actor 队列，无需跨语言租约）。
2. 从 `KnowledgeBaseManager.js` 中正式移除 `new Database(dbPath)` (`better-sqlite3`)、移除 `rustWriteLease` 全套方法、简化 `databaseCoordinator.js` 为基于 Rust 异步 Promise 的事件等待。
3. 更新 `tests/` 下直连 `kbm.db` mock 的单元测试以适配新的 `NativeKnowledgeRuntime` 契约。

---

## 6. 供 Codex 复核的关键问题与边界检查清单（Review Checklist）

请 Codex 在复核本施工图时重点审视以下工程细节：

1. **`TextChunker` 与 Tag 提取的一致性**：
   - Stage A 摄取预检若下沉至 Rust，Rust 侧的分块算法与 `_extractTags` 正则是否需要与 `TextChunker.js` / `textPreprocessor.js` 保持 100% 字节级一致（避免升级后已有文件的 checksum/chunk 边界漂移导致重算 Embedding）？
   - *备选折中*：Stage A 中，Rust 先做文件 `mtime/size/MD5` 校验（99% 未变更文件在此直接短路）；对于确实发生变更的少数文件，可在 JS 侧调用原版 `chunkText` + `extractTags` 后将 `{ relPath, checksum, chunks, tags }` 传给 Rust `prepareIngestionBatch` 过滤已知向量，还是直接在 Rust 中 1:1 移植 `TextChunker`？
2. **`LightMemo` 特殊过滤语义的 100% 兼容**：
   - `LightMemo.js` 现有的 `_checkSignature(text, maid)` 检查的是 `chunk.content` 的第一行是否包含 `maid`；且支持 `MusicDiary` 跳过排除文件夹、时间范围正则解析（精确到年月日整数区间 `YYYYMMDD`）。下沉至 Rust 时需确保这些边界行为与原 JS 逻辑完全等价。
3. **测试套件兼容性（Test Harness）**：
   - `tests/associativeDiscoveryRiverMemo.test.js` 等部分测试通过 monkey-patch `knowledgeBaseManager.db = { prepare() ... }` 注入假数据。当 `.db` 从 KBM 移除后，应统一改为 mock KBM 的高层异步方法（如 `resolveAssociationSeeds`）或使用临时 SQLite 文件初始化 `NativeKnowledgeRuntime`。
4. **Windows 文件句柄与优雅关闭（Graceful Shutdown）**：
   - 当 `kbm.shutdown()` 或触发损坏恢复重建时，`NativeKnowledgeRuntime` 必须能够排空任务并关闭 Read Pool 与 Write Actor 持有的所有 `rusqlite::Connection`，确保 Windows 下不会因残留句柄导致 `.sqlite` / `.usearch` 文件无法 rename 或删除。

---

## 7. 最终施工图：KBM 代理化，Rust 独占中央记忆库

> **本章为最终施工基线，优先级高于前文仍带有探索性质的 Phase 草图。**
>
> 本次工程只处理中央 `knowledge_base.sqlite`、其基线表、派生表、Chunk/Tag 向量索引、Memo/RiverMemo 数据面，以及 KBM 与 Rust Vexus 的所有权交接。

### 7.1 四条硬边界

#### 边界 A：业务可靠性保持不变，实现归属迁移

本工程不改变 KBM 当前已经具备的业务语义，只改变这些业务由谁执行：

- 文件稳定性确认、mtime/size/checksum 对账；
- 文件新增、修改、删除和迁移重命名；
- Chunk 切分、Tag 提取、向量复用和缺失向量补齐；
- `files`、`chunks`、`tags`、`file_tags`、`migration_deleted_files` 的事务一致性；
- Schema 初始化、版本迁移和索引创建；
- 数据库损坏检测、隔离、恢复和重建；
- 日记索引、全局 Tag 索引、双槽基线和代际校验；
- Tag 一致性预览与确认提交；
- Memo/RiverMemo 派生资产构建、签名、版本和发布；
- 关闭流程中的任务排空、索引释放、连接关闭和 Windows 文件句柄清理。

迁移后应保持现有的幂等性、失败重试、旧数据兼容、损坏恢复和原子发布行为。Rust 化不能以“简化流程”为理由删除这些保护。

#### 边界 B：LightMemo 不属于今天的施工范围

`Plugin/LightMemo/LightMemo.js` 暂不改造。

今天不迁移：

- LightMemo 的候选收集；
- LightMemo 的 Jieba 分词；
- LightMemo 的正文过滤；
- LightMemo 的向量相似度计算；
- LightMemo 的专用重排和适配器调用。

LightMemo 后续作为一次独立的“新架构适配工程”重新接线，接入届时已经稳定的 Rust 作用域检索接口。今天的 Rust 所有权交接必须先为未来 LightMemo 保留稳定的高层接口，但不为其实现专用查询逻辑，也不把 LightMemo 的旧语义混入本次迁移。

#### 边界 C：KBM 保留成熟的 Embedding 编排

`EmbeddingUtils.js` 继续由 Node.js 持有，暂不迁移向量化 worker。

KBM 保留：

- Embedding API 配置；
- 多模型容灾；
- HTTP 代理与密钥；
- token 计数和批次切分；
- 并发请求控制；
- 429 退避；
- 返回数组对齐；
- 超长文本和失败项的 `null` 语义；
- Embedding 审计日志。

Rust 只向 KBM 返回真正缺失向量的文本任务包，KBM 调用现有 `EmbeddingUtils.getEmbeddingsBatch()`，再将 `Float32Array` 结果提交回 Rust。这样保留成熟的远端服务编排，同时避免把 SQL、索引和向量 BLOB 搬进 V8。

#### 边界 D：TDB 完全排除

`TDBKnowledge.js` 及其 `VectorStoreTDB/tdb_knowledge_meta.sqlite` 不属于本次施工范围。

本工程不修改：

- TDB 的 Schema；
- TDB 的 SQLite 连接；
- TDB 的向量化；
- TDB 的检索；
- TDB 的测试；
- TDB 与 KBM 中央记忆库之间不存在的独立业务边界。

本次“单一 SQL 真相源”只指中央 `knowledge_base.sqlite`。不能把 TDB 的独立数据库误并入 Rust KBM 数据面。

---

## 8. 最终所有权模型

### 8.1 Node.js 只保留控制面

KBM 最终保留以下职责：

```text
KnowledgeBaseManager
├── 运行配置与生命周期门面
├── 文件变化入口与外部插件协调
├── EmbeddingUtils 请求编排
├── N-API 参数整理与结果兼容转换
├── Agent/Plugin 调用适配
├── 旧业务 API 的兼容门面
└── 运行日志、指标与错误映射
```

KBM 不再持有中央数据库连接，也不再直接读取中央库的任何表。

以下对象最终从 KBM 生产路径消失：

- `this.db`；
- `better-sqlite3` 中央库连接；
- `schemaManager` 对中央库的直接调用；
- `sqliteHealthManager` 对中央库的直接调用；
- `indexRepository` 对中央库和 `.usearch` 文件的直接调用；
- `tagConsistencyService` 对中央库的直接事务；
- `databaseCoordinator` 中的 `rustWriteLease`；
- `lastJsWriteFinishedAt`；
- `lastRustWriteFinishedAt`；
- Rust 写后重开 JS SQLite 连接的屏障逻辑；
- 基于 50ms 轮询的数据库空闲等待。

KBM 的公开方法仍可保留，但内部实现改为调用 `NativeKnowledgeRuntime`。调用方看到的是原有业务结果和错误语义，数据库所有权已经完全隐藏在 Rust 内部。

### 8.2 Rust 独占中央记忆库数据面

`NativeKnowledgeRuntime` 最终拥有：

```text
NativeKnowledgeRuntime
├── SqliteStorageEngine
│   ├── Dedicated Write Actor
│   ├── Bounded Read Pool
│   ├── Schema/Migration Manager
│   ├── Health/Recovery Manager
│   └── Database Generation Manager
├── IndexLifecycleManager
│   ├── Diary Index Registry
│   ├── Global Tag Index
│   ├── Singleflight Cold Start
│   ├── Delta Replay
│   ├── Dual Slot Checkpoint
│   └── Idle Eviction
├── IngestionCoordinator
│   ├── File Diff
│   ├── Chunk/Tag Plan
│   ├── Vector Reuse
│   └── Commit Batch
├── Native Query Services
│   ├── RAGDiary Native Query
│   ├── Metadata/Seed Query
│   ├── Chunk Hydration
│   └── Memo/RiverMemo Query
├── DerivedAssetCoordinator
│   ├── Pairwise Similarity
│   ├── Intrinsic Residual
│   ├── Memo Artifact
│   └── EPA Cache
└── ShutdownCoordinator
```

Rust 内部可以有多条只读连接，但所有连接必须由 `SqliteStorageEngine` 创建、配置、回收和诊断。任何 Rust 子模块都不得自行调用 `Connection::open_with_flags` 绕过该引擎。

### 8.3 “单一 SQL 真相源”的准确含义

“单一”指的是单一所有者和单一事务裁决者，不要求所有查询共用一条物理连接。

允许的结构：

```text
Rust SqliteStorageEngine
├── 1 条 Write Actor 专用读写连接
└── 固定数量 Read Pool 只读连接
```

禁止的结构：

```text
Node better-sqlite3 长连接
Rust memo_artifact_builder 自己 open
Rust result_deduplicator 自己 open
Rust memo_pipeline 自己 open
Rust baseline 代码自己 open
```

所有写入都必须经过 Write Actor 排队。所有读取都必须经过 Read Pool 或 Write Actor 内部事务视图。这样 SQLite 的写锁顺序、WAL 配置、busy timeout、checkpoint、健康检查和关闭顺序都由一个 Rust 组件统一决定。

因此目标态不需要 `rustWriteLease`。Rust 内部已经拥有唯一写入排队点，Node.js 不再参与数据库写锁竞争。

---

## 9. `SqliteStorageEngine` 施工契约

### 9.1 Write Actor

Write Actor 是一个长期存活的 Rust 后台任务，拥有唯一的读写连接。

所有写操作必须包装成有界命令：

```rust
enum WriteCommand {
    InitializeSchema,
    RunMigration,
    PrepareIngestionCommit(PreparedCommit),
    DeleteFiles(DeleteBatch),
    PublishDiaryBaseline(DiaryBaselinePublication),
    PublishTagBaseline(TagBaselinePublication),
    WriteDerivedAsset(DerivedAssetWrite),
    WriteKvValue(KvWrite),
    ApplyTagConsistency(TagConsistencyCommit),
    Checkpoint,
    HealthCheck,
    Shutdown,
}
```

每个命令必须返回：

```rust
struct WriteReceipt {
    operation: String,
    database_generation: u64,
    affected_files: Vec<i64>,
    affected_chunks: Vec<i64>,
    affected_tags: Vec<i64>,
    index_invalidations: Vec<IndexInvalidation>,
}
```

Write Actor 必须具备：

- 有界队列，防止无限堆积；
- 每个命令独立错误返回；
- 事务提交前不发布内存索引变更；
- 事务提交成功后再发布对应索引 Delta；
- 失败时保留旧索引和旧基线；
- 对可重试的 `SQLITE_BUSY` 执行有限退避；
- 对损坏错误进入统一恢复状态；
- 关闭时拒绝新写入并排空已接受命令。

### 9.2 Read Pool

Read Pool 使用固定连接数，默认建议 4 条，允许配置到 2 至 8 条。

每条连接统一设置：

```sql
PRAGMA query_only = ON;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 30000;
PRAGMA cache_size = -16384;
PRAGMA mmap_size = <受控上限>;
```

Read Pool 不负责写入，不执行 `PRAGMA wal_checkpoint`，不参与 Schema 迁移。

查询任务必须：

- 借用连接；
- 在 Rust 后台线程执行；
- 读取完成后归还连接；
- 不把大批量 Vector BLOB 序列化到 N-API；
- 对高维向量采用流式读取或受控候选上限；
- 只返回业务需要的轻量结果。

### 9.3 Schema 与迁移

Rust 启动接口 `open_and_init_schema(dbPath, schemaVersion)` 必须原子完成：

1. 创建数据库目录；
2. 打开或创建数据库；
3. 设置 WAL、foreign keys、busy timeout；
4. 执行 Schema 版本检查；
5. 执行缺失迁移；
6. 创建必要索引；
7. 执行轻量完整性检查；
8. 发布 `StoreReady` 状态。

Schema 迁移不得由 Node.js 再次执行。旧 `schemaManager.js` 保留为迁移参考和兼容文档，但生产路径不再调用。

迁移失败时：

- 不删除原数据库；
- 将数据库标记为 `migration_failed`；
- 记录失败版本和 SQL 操作；
- 进入可诊断的只读或停止状态；
- 由统一恢复策略决定是否隔离并从日记文件重建。

### 9.4 健康检查与损坏恢复

Rust 接管现有 `sqliteHealthManager.js` 的语义：

- 启动 `quick_check`；
- 运行期按需 checkpoint；
- 区分 `busy`、`locked`、`corrupt`、`notadb`；
- 对瞬态 WAL/SHM 异常执行连接级重试；
- 对确认损坏执行数据库、WAL、SHM 一致隔离；
- 保留带时间戳的备份；
- 创建新库；
- 从文件系统重新摄取；
- 在恢复完成前拒绝普通写入。

恢复期间，查询接口必须返回结构化状态：

```json
{
  "code": "KNOWLEDGE_STORE_RECOVERING",
  "retryable": true,
  "databaseGeneration": 0
}
```

不能让 Node.js 通过关闭并重开 `better-sqlite3` 连接参与恢复。Windows 下必须确保所有 Rust Read Pool、Write Actor 和索引文件句柄在 rename 前释放或进入可证明的安全状态。

---

## 10. N-API 最终接口面

生产 N-API 只暴露 NativeKnowledgeRuntime 高层接口。`VexusIndex.load/save` 继续保留给离线工具兼容，但禁止新生产代码调用。

### 10.1 生命周期

```text
openAndInitStore(dbPath, options)
storeState()
healthCheck()
databaseGeneration()
shutdown()
```

`openAndInitStore` 返回：

```ts
interface StoreReady {
  dbPath: string;
  schemaVersion: number;
  databaseGeneration: string;
  dimension: number;
  modelSig: string;
  recovered: boolean;
}
```

### 10.2 索引生命周期

```text
ensureGlobalTagIndex()
ensureDiaryIndex(diaryName)
releaseDiaryIndex(diaryName)
flushIndexGeneration(scope)
listResidentIndices()
indexStats()
```

这些接口全部返回 Promise。冷启动、usearch 文件加载、SQL 差分回放、基线验证和保存均在 Rust 后台完成。

单飞语义必须保证：

```text
同一 diary_name 的并发 ensureDiaryIndex()
只允许一个实际加载任务；
其他调用方共享同一个 Promise/任务结果。
```

### 10.3 查询接口

RAGDiary 当前已经使用的 Rust 原生查询继续扩展为正式契约：

```text
executeNativeRiverQuery(query, scope, options)
searchDiaryIndices(scope, queryVector, options)
hydrateChunksByIds(chunkIds, options)
resolveAssociationSeeds(relativePaths)
getFileIdsByDiaries(diaryNames)
listDistinctDiaries()
```

查询必须在 Rust 内完成：

- 日记范围解析；
- 权限范围；
- 文件与 Chunk 关系；
- ANN；
- 语义去重；
- RiverMemo；
- 正文和路径 hydrate；
- 代际校验。

Node.js 只获得 Top-K 结果和诊断信息。查询过程不向 Node.js 传递全量向量 BLOB。

### 10.4 摄取接口

```text
prepareIngestionBatch(filePaths, options)
commitIngestionBatch(batchId, chunkVectors, tagVectors)
commitDeleteBatch(filePaths, options)
notifyFileMutations(upserts, deletes)
awaitMutation(batchId)
```

`prepareIngestionBatch` 返回：

```ts
interface PreparedIngestionBatch {
  batchId: string;
  databaseGeneration: string;
  fastUpdatedFiles: number;
  unchangedFiles: number;
  changedFiles: number;
  missingChunkTexts: string[];
  missingTagTexts: string[];
  chunkDescriptors: ChunkDescriptor[];
  tagDescriptors: TagDescriptor[];
}
```

`chunkDescriptors` 和 `tagDescriptors` 必须携带稳定顺序、文件身份、Chunk 身份和文本哈希，保证 JS Embedding 返回数组可以安全映射回 Rust 任务。

`commitIngestionBatch` 必须拒绝：

- 不存在的 batchId；
- 已过期 batchId；
- 向量数量不匹配；
- 向量维度不匹配；
- 文本哈希不匹配；
- 重复提交；
- 数据库代际冲突；
- 文件在预检后发生变化。

### 10.5 维护接口

```text
inspectTagConsistency()
commitTagConsistency(snapshotToken, vectors)
getKvValue(key)
setKvValue(key, value)
rebuildMemoArtifacts(options)
rebuildPairwiseSimilarity(options)
rebuildIntrinsicResiduals(options)
rebuildEpaBasis(options)
```

Tag 一致性预览可以继续由 JS 负责读取文件、执行已有 Tag 规则和请求 Embedding，但数据库快照读取和最终提交必须进入 Rust。这样保留当前用户确认模型，同时消除 JS 事实事务。

---

## 11. KBM 迁移后的职责分工

### 11.1 KBM 保留的适配器

KBM 最终对外保留：

```text
initialize()
shutdown()
search()
searchKnn()
searchMany()
executeNativeRiverQuery()
getEmbeddingsBatch()
runExternalFileMutation()
awaitIndexedFilePaths()
awaitDeletedFilePaths()
previewTagConsistency()
applyTagConsistencyPreview()
getMemoryProfile()
```

这些方法内部不再访问 `this.db`，而是：

1. 校验参数；
2. 调用 NativeKnowledgeRuntime；
3. 调用 `EmbeddingUtils`；
4. 映射错误码；
5. 保持旧调用方需要的返回结构。

### 11.2 KBM 删除的内部职责

下列实现必须删除或降级为纯兼容壳：

- 中央库 `better-sqlite3` 打开；
- JS Schema 初始化；
- JS orphan 清理事务；
- JS 基线统计与基线发布；
- JS `files/chunks/tags/file_tags` 事务；
- JS `kv_store` 读写；
- JS 派生表清理；
- JS `getVectorByChunkId` 直接查库；
- JS `getChunksByFilePaths` 直接查库；
- `rustWriteLease` 全套状态机；
- Rust 写后重新绑定 JS 连接；
- 以数据库连接是否空闲作为外部文件变更门禁。

### 11.3 数据库连接硬禁令

迁移完成后，生产运行时必须满足：

```text
KnowledgeBaseManager.js 不存在中央 knowledge_base.sqlite 的 Database 实例；
modules/knowledgeBase/*.js 不存在中央库 prepare/transaction/exec；
Rust 子模块不允许自行 open SQLite；
只有 SqliteStorageEngine 可以创建中央库连接。
```

测试和离线维修脚本可以直接打开临时数据库或服务停止后的中央库，但不得成为生产主链依赖。

---

## 12. 保持可靠性的迁移顺序

### Phase 0：契约冻结与双轨观测

目标：先固定行为，再改变实现。

工作：

- 为当前 KBM 业务建立 Rust 接口契约；
- 记录数据库代际、Schema 版本、模型签名；
- 给现有 JS 流程增加操作 ID 和结果摘要日志；
- 为每个迁移接口定义旧路径与新路径的对照结果；
- 暂不删除任何旧逻辑；
- 明确 LightMemo 和 TDB 不进入测试矩阵。

验收：

- 相同数据库和相同文件输入下，旧路径与 Rust 预检结果的文件数、Chunk 数、Tag 数和缺失向量集合一致；
- 失败时两边都能返回明确错误类别；
- 无任何生产数据改写。

### Phase 1：Rust 存储引擎与只读迁移

目标：Rust 先成为中央库唯一读取者。

工作：

- 实现 `SqliteStorageEngine`；
- 实现 Read Pool 和连接配置；
- 实现 Schema 读取、代际读取和健康检查；
- 把 RAGDiary 现有查询中的权限、hydrate 和元数据查询全部收进 Rust；
- KBM 删除中央库只读 SQL；
- 暂时保留 JS 写入，但禁止新增任何 JS 读取接口。

这一阶段仍可能存在 JS 写、Rust 读，但 Rust 不执行与 JS 并发的派生写入。它是短期迁移阶段，不是目标态。所有新功能只能通过 Rust 读接口实现。

验收：

- RAGDiary 结果与现有生产结果一致；
- Rust 读连接数有上限；
- Node.js 不再产生中央库查询 BLOB；
- 查询期间 Event Loop Lag 不因数据库读取显著增加。

### Phase 2：两阶段摄取和事实写入迁移

目标：Rust 接管中央事实表写入。

工作：

- 将现有 `ingestionPipeline.js` 改为调用 `prepareIngestionBatch`；
- JS 只执行 `EmbeddingUtils`；
- 将 `commitIngestionBatch` 接入 Write Actor；
- 迁移删除、重命名、向量复用和失败重试；
- Rust 在单一事务中维护事实表；
- Rust 提交成功后更新内存索引；
- Rust 发出 Notify 事件；
- KBM 的 `pendingFiles` 和 `pendingDeletes` 只保留为兼容状态投影。

验收：

- 单文件重复事件不会产生重复 Chunk；
- API 向量请求失败不会污染事实表；
- 事务提交失败不会发布索引 Delta；
- 索引 Delta 失败可以从 Rust 权威 SQLite 重建；
- 文件删除后不会留下孤儿 Chunk、Tag 或关系；
- Embedding 返回乱序或部分失败时不会错配向量。

### Phase 3：索引、基线和派生资产迁移

目标：Rust 接管所有非查询数据资产。

工作：

- 将 `indexRepository.js` 的双槽基线逻辑迁入 Rust；
- 将日记和 Tag 索引注册表迁入 Rust；
- 将同步 `VexusIndex.load/save` 从生产路径移除；
- 将 pairwise、intrinsic residual、EPA、Memo artifact 的写入统一提交到 Write Actor；
- 删除 `reopenAndAssertDatabaseHealthy` 这类跨语言屏障；
- 将 `TagConsistencyService` 的最终事务改为 Rust `commitTagConsistency`；
- 保持 JS 的文件扫描、Tag 规则和 Embedding 编排。

验收：

- 冷启动加载不进入 Node.js 主线程；
- 基线回放时 Vector BLOB 不进入 V8；
- 双槽发布具有文件与数据库元数据的一致性；
- 任意中途失败都保留旧活动槽；
- Rust 派生任务之间不再互相申请租约；
- 同一数据库只有 Write Actor 执行写事务。

### Phase 4：移除旧所有权和租约

只有 Phase 2 与 Phase 3 的验收完成后，才执行：

- 删除 KBM 的 `this.db`；
- 删除 `better-sqlite3` 对中央库的依赖；
- 删除 `DatabaseCoordinator` 的 `rustWriteLease`；
- 删除 Rust 写后 JS 连接重开屏障；
- 删除 JS 基线和派生表 fallback；
- 删除生产路径的 `VexusIndex.load/save` 调用；
- 删除围绕双连接设计的配置项；
- 将旧测试从 `db.prepare()` monkey-patch 改为高层 NativeKnowledgeRuntime mock；
- 保留离线维修脚本的独立入口，但不让它参与服务器运行时。

租约删除的硬条件不是“Rust 能打开 SQLite”，而是：

```text
所有中央库写入都已经进入 Rust Write Actor；
所有中央库读取都已经进入 Rust StorageEngine；
所有索引文件发布都已经进入 Rust IndexLifecycleManager；
Node.js 不再持有中央库连接；
Rust 子模块不再自行创建旁路连接。
```

满足这些条件后，租约必须删除，而不是继续保留。

---

## 13. 失败恢复与回滚策略

### 13.1 迁移期间的回滚原则

迁移阶段每次只切换一个所有权域：

```text
读接口 → 摄取写入 → 索引基线 → 派生资产 → 删除旧连接
```

不得在同一版本中同时切换全部业务并删除所有 fallback。每个阶段必须能通过配置或启动门控回到上一阶段。

### 13.2 事实事务失败

Rust commit 失败时：

- 不更新索引；
- 不推进数据库代际；
- 保留 batch 状态供重试或明确失败；
- JS 重新请求 Embedding 时不得重复写入；
- 超过重试上限后将任务标记为可观测失败。

### 13.3 索引更新失败

索引 Delta 失败时：

- 当前索引实例标记为 invalid；
- 不发布新的索引基线；
- 注销活动索引；
- Rust 从 SQLite 权威事实层异步全量恢复；
- 恢复完成后重新注册；
- 查询在恢复期间返回明确的 warming 状态或走已定义的降级路径。

### 13.4 派生资产失败

Pairwise、Residual、EPA 或 Memo 构建失败时：

- 不删除上一代 ready 资产；
- 不替换活动 artifact；
- 记录失败的 model/config/database generation；
- 后台任务按指数退避重试；
- 查询继续使用上一代兼容资产，或返回“派生资产 warming”诊断。

### 13.5 数据库损坏

确认损坏后：

1. 停止接收新的写命令；
2. 等待正在执行的读任务结束；
3. 关闭 Read Pool 和 Write Actor；
4. 隔离数据库、WAL、SHM；
5. 创建新库并初始化 Schema；
6. 从 dailynote 文件重新执行两阶段摄取；
7. 重新建立索引和派生资产；
8. 发布恢复完成事件；
9. KBM 继续作为代理恢复对外服务。

---

## 14. 测试与验收矩阵

本次测试只覆盖中央 KBM 数据面，不包含 TDB 和 LightMemo。

### 14.1 数据一致性

- 首次全量摄取后，`files/chunks/tags/file_tags` 数量与旧路径一致；
- 同一文件重复事件保持幂等；
- 文件重命名复用迁移向量；
- 文件删除不会留下孤儿关系；
- 向量缺失项与 Embedding 任务包严格对应；
- Chunk/Tag 文本哈希和向量顺序不漂移。

### 14.2 索引一致性

- 空基线全量恢复；
- 活动槽存在时差分回放；
- 删除与 upsert 同批原子应用；
- 5% 阈值前后行为一致；
- 双槽发布中断后旧槽仍可加载；
- 索引与 SQLite 数量不一致时自动恢复；
- 空闲卸载后再次查询单飞加载。

### 14.3 并发与冷启动

- Agent A SSE 持续输出期间 Agent B 首次唤醒未驻留日记本；
- 多 Agent 同时请求同一未加载日记本；
- 多 Agent 同时请求不同日记本；
- 摄取提交与查询并发；
- 派生构建与查询并发；
- 关闭期间新查询和新写入；
- Windows 下索引和数据库文件 rename/delete。

### 14.4 可靠性指标

目标指标：

```text
主线程不执行中央 SQLite 查询；
主线程不执行 usearch load/save；
冷启动任务不向 V8 传递 Vector BLOB；
同一日记本并发冷启动只有一次实际恢复；
所有中央写事务均可定位到 Rust Write Actor；
普通查询不因后台冷启动同步阻塞；
失败任务具有可重试错误码和操作 ID；
关闭后无 Rust SQLite/Usearch 句柄泄漏。
```

Event Loop Lag `<5ms` 是目标观测值，但不得把它作为掩盖正确性问题的唯一指标。首先保证事务、代际和索引原子性，再优化延迟。

---

## 15. 最终完成定义

本工程完成的判定不是“NativeKnowledgeRuntime 增加了几个方法”，而是以下不变量全部成立：

1. 中央 `knowledge_base.sqlite` 的 Schema、事实表、派生表、基线表、健康状态和恢复流程全部由 Rust 管理。
2. Rust 内部只有 `SqliteStorageEngine` 可以创建中央库连接。
3. 所有中央库写入都经过唯一 Write Actor。
4. 所有中央库读取都经过 Rust Read Pool 或 Write Actor 事务视图。
5. KBM 不再持有 `better-sqlite3` 中央库连接。
6. KBM 只做 NativeKnowledgeRuntime 代理、业务兼容和 EmbeddingUtils 编排。
7. `EmbeddingUtils.js` 继续保留，不因本次施工迁移到 Rust。
8. `rustWriteLease`、JS 写后健康屏障和跨语言数据库轮询全部删除。
9. 日记索引、Tag 索引、双槽基线和冷启动回放全部在 Rust 后台完成。
10. RAGDiary 当前 Rust 全链路查询契约保持兼容。
11. LightMemo 未被强行改造，后续单独适配新 Rust 查询接口。
12. TDB 业务、TDB 数据库和 TDB 测试完全不受本次工程影响。
13. 现有数据损坏恢复、幂等、重试、原子发布和优雅关闭能力得到保留。
14. RiverMemo V2 发布前，Rust 已经成为中央工业级记忆数据面的唯一事实所有者。

最终架构应当满足一句话：

> **KBM 负责“接收业务请求、编排向量化、调用 Rust、返回兼容结果”；Rust 负责“拥有数据库、执行事务、管理索引、构建派生资产、完成检索和恢复”。**

---

## 16. 实施补充契约与阻断性验收条件

> 本章将第 7—15 章的概念描述收束为实施约束；发生冲突时以本章为准。旧章节中的“零锁争抢”“0ms 阻塞”“SQL 与索引原子提交”“页缓存严格上限”等表述不能作为工程保证。

### 16.1 分期是施工顺序，交付必须完成所有权闭环

第 12 章各 Phase 是开发、临时库验证及代码审查顺序，不代表今天只交付索引异步化、继续保留租约。

最终生产切换必须同时满足：

- JS 中央库连接已经移除；
- 事实写入、派生写入、基线发布、健康维护全部进入 Rust；
- Rust 旁路打开连接全部消除；
- 租约、冷却窗口、JS 写后重开连接屏障已经删除；
- 现有 RAGDiary 原生查询、摄取与维护业务通过兼容性验收。

开发中可保留旧实现供对照，但同一生产数据库不得运行新旧双写。回滚以停机、匹配版本的代码和备份数据库为单位，不提供运行期自动切回 JS 数据库写入的开关。

### 16.2 LightMemo 延期与 SQL 所有权并不矛盾

LightMemo 专用适配器、检索算法和分词实现不进入本次工程。与此同时，Rust 独占中央库意味着旧 LightMemo 裸访问数据库的路径在新架构中不能继续工作。

明确部署规则：

- 本次不为 LightMemo 保留 JS 只读连接；
- 不提供模拟同步数据库连接的兼容对象；
- 不向 JS 暴露任意 SQL 执行通道；
- 不把 LightMemo 默认改接另一种检索器并声称语义兼容；
- 发布说明必须标明：旧 LightMemo 中央库直连路径等待二次适配，新架构部署期间不得路由到该路径；
- 如部署要求旧 LightMemo 同时保持可用，则该要求构成生产切换的未满足条件，应在二次适配完成后切换，不能削弱 Rust SQL 独占约束。

TDB 仍完全排除；其独立连接不会违反中央库独占约束。无需为本次工程修改 TDB 源码、Schema 或测试。

### 16.3 SQLite 提交与 usearch 更新是两个资源的协调发布

SQLite 事务和 usearch 内存变更不存在跨资源事务，不能承诺“一个写锁使两者自动原子”。

必须落实以下协议：

1. 每次事实写事务生成单调的事实代际，并在同一 SQLite 事务中记录受影响索引的变更或失效信息。
2. 查询和写入遵守同一组 Rust 索引发布门禁。开始变更前，阻止新查询取得受影响索引的旧快照；已开始查询必须按规定完成或重试。
3. Write Actor 提交 SQLite 事务。
4. 由 Rust 索引工作线程应用 Delta，推进对应索引的已应用代际。
5. 只有 SQL 提交与索引可查询代际均完成，才报告“已索引完成”。
6. Delta 失败时将实例标记为不可查询，从 SQLite 构建替代实例后原子替换；不得继续查询部分修改的实例。
7. 进程在步骤 3 和步骤 4 之间崩溃时，重启从事实代际和持久化失效信息发现落差并恢复。

写回执应区分“事实已提交”和“索引已就绪”。事实已提交后发生索引失败，客户端重试同一操作 ID 不能重复插入。前文写回执中的受影响 ID 列表仅供 Rust 内部使用，N-API 默认只返回计数、代际、操作 ID 和错误摘要。

Write Actor 不执行耗时 HNSW 构建、Embedding 请求、全图计算或压缩。它只负责短事务、发布条件检查和持久化回执。索引门禁等待和队列背压必须在后台发生。

### 16.4 查询一致性与锁顺序

查询不能先搜索旧索引、再从一个任意较新数据库视图回填正文而不校验。

实现采用受影响作用域的查询/发布门禁：

- 查询在后台取得作用域门禁后，固定索引代际与 SQLite 读事务视图；
- ANN、权限验证、hydrate 和去重使用该次固定的作用域与事实视图；
- 写入受影响作用域时等待已有查询退出，再提交并完成索引发布；
- 多日记查询按规范化日记名排序取得门禁，全局 Tag 门禁顺序固定；
- 不在持有注册表写锁时执行磁盘 I/O、SQL 扫描或等待另一个任务；
- 不在借用读连接后递归申请第二条读连接：内部算子接收当前连接/事务上下文；
- 后台任务不得持有索引锁等待 JS 回调。

为所有锁和资源定义并测试一套固定取得顺序。跨作用域隔离是后续性能优化空间，首版优先保证正确性与无死锁；不得把全局长时间阻塞重新引入主线程。

现有同步统计、注册、卸载、查询方法如果可能等待后台索引写锁，也必须改成异步接口或无等待的缓存摘要。仅异步化磁盘加载仍不足以保证主线程不被 Rust 锁等待卡住。

### 16.5 冷启动是可重试状态机

日记索引与全局 Tag 索引采用状态机：未加载、加载中、就绪、失效、恢复中、淘汰中、失败、关闭。

要求：

- 同名加载单飞，失败后清除失败任务，允许后续有限退避重试；不能永久缓存首次失败；
- 不同日记加载设置并发数和内存预算，不能无限并发全量恢复；
- 读取基线和差分时固定 SQLite 事实快照；
- 加载期间发生写入，必须回放快照之后的持久化变更，或在发布前校验代际并重试；
- 注册表只发布完整实例，加载中实例不能被查询；
- 空闲时间在真实查询时更新，卸载需校验实例代际，避免旧淘汰任务注销新实例；
- 查询持有活动引用期间不能强制释放索引；
- 基线缺失、维度/模型不匹配、文件损坏、回放失败时，异步全量恢复并核对有效向量数量；
- 恢复错误必须向上传递。当前恢复失败后返回数量零的做法不能作为新接口的成功结果；
- 全局 Tag 索引与共享 Memo 运行时由 Rust 同一个所有权根持有，重建 Tag 索引时必须一致更新依赖，不保留绑定旧实例的运行时。

### 16.6 双槽基线必须保存同一个快照

把同步保存改成异步后，不能“先保存索引文件，再查询当前 SQL 成员表作为基线”。二者之间可能发生摄取，造成永久漏回放。

发布协议：

1. 按索引串行化 checkpoint，冻结索引已应用代际和该代成员清单；Tag 成员必须包含向量版本。
2. 冻结后可选择在后台持有读锁保存，或创建受控快照后释放锁；不得无预算复制完整高维索引。
3. 写入非活动槽临时文件，完成内容校验、文件同步与平台兼容替换。
4. Write Actor 在事务中提交这个冻结清单、快照代际、槽号、模型、维度、文件校验信息及活动指针。
5. 并发事实变更保留为快照之后的差分，不混入该代基线成员。
6. 数据库发布失败时旧活动槽保持有效；未发布文件可以后续回收。
7. 首版保留原有 5% 差分阈值、静默窗口、持久化白名单及禁止落盘模式，不改变配置含义。

Chunk 对称差分如果只比较 ID，就必须证明所有向量更新都会分配新 ID。否则补充向量版本或内容指纹，并测试同 ID 向量更新；不能静默漏掉原地更新。

SQLite BLOB 不保证满足浮点对齐。首版使用安全解码和可复用的单行浮点缓冲区，保持现有编码兼容；禁止未经验证的指针强转。目标是“历史向量不经过 V8”，不是宣称 SQLite 到 usearch 端到端零拷贝。

### 16.7 摄取任务身份、部分失败与并发版本

前文“拒绝所有数据库代际冲突”和“拒绝重复提交”需要细化：

- 全局数据库代际用于追踪，不因无关文件写入就使所有预检批次过期；
- 提交在事务内重新校验受影响文件版本、内容哈希、删除墓碑、模型签名和预处理规则版本；
- 同一路径的新修改或删除使旧 Embedding 任务失效，旧结果不能复活已删除文件；
- 同一操作 ID 和相同输入的重复提交返回已存在回执；同 ID 不同输入拒绝；
- 批次有 TTL、数量上限、文本/向量字节预算、取消入口和过期清理；
- Embedding HTTP 等待期间不占用写事务、索引锁或读连接；
- 成功项、失败项通过显式任务 ID/位置映射提交，不能将失败项删除后挤压数组索引；
- 缺失响应 index、重复 index、非法维度、非有限浮点及模型空间不一致都要明确处理；
- 同维度不同模型不代表语义空间兼容；只允许声明为同一语义空间的备援继续写同一索引；
- 首先调查并冻结当前摄取在部分失败时的实际行为，再移植。不得擅自把现有补洞策略改成整批失败，也不得将有缺失向量的文件标记为完整。

零缺失向量的预检仍需按明确契约提交，不使用两套含糊的“已自动提交/等待提交”语义。mtime/size 快路径只有在存量向量完整性也成立时才能跳过，保持开机补洞能力。

### 16.8 文本处理兼容决策

最终 KBM 只保留代理与 Embedding 编排，因此文件预处理、Chunk 切分、Tag 规则和迁移向量复用的业务权威归 Rust。

实施前必须逐项读取并冻结以下实现，当前审查尚未覆盖其全部分支：

- [ingestionPipeline.js](../modules/knowledgeBase/ingestionPipeline.js)；
- [schemaManager.js](../modules/knowledgeBase/schemaManager.js)；
- [migrationVectorCache.js](../modules/knowledgeBase/migrationVectorCache.js)；
- [diaryMetadataCache.js](../modules/knowledgeBase/diaryMetadataCache.js)；
- [fileWatcher.js](../modules/knowledgeBase/fileWatcher.js)；
- [textPreprocessor.js](../modules/knowledgeBase/textPreprocessor.js)；
- [TextChunker.js](../TextChunker.js)。

为换行、Unicode、token 边界、超长段落、重叠切分、Tag 顺序/去重/黑名单/截断建立黄金样本。Rust 必须匹配旧结果；不得因迁移而默认全库重算向量。

如果 tokenizer 等价移植尚未完成，可在开发分支短期复用旧文本函数作对照或过渡。该过渡不算最终 KBM 代理化完成，不能悄然变成永久 JS 数据面。

EmbeddingUtils 保留，但不承诺其所有 CPU 工作天然非阻塞：token 计数和 JSON 处理目前仍在 JS。通过限制单次文本量、总字节和返回批量控制开销，本次不迁移 HTTP/tokenizer worker。

前文允许 Tag 一致性由 JS 读取文件并计算计划仅是过渡选项；最终预览计划、规则摘要、快照校验和事务均由 Rust 管理，JS 保留展示、确认 token 透传和缺失 Tag 的 Embedding 请求编排。

### 16.9 外部文件变更等待基于提交回执

操作系统 notify 与显式文件通知进入同一个 Rust 路径任务队列，统一防抖和版本去重。

- 文件写入本身仍由 DailyNote 等插件执行，KBM 仅代理通知和等待；
- 需要保留文件级互斥时使用明确的文件操作协调，不保留数据库租约；
- “已索引完成”对应每个路径版本的成功回执；
- “队列为空”“任务已经取走”“没有 pendingFiles”均不能代表成功；
- 等待者在登记时先检查状态，再订阅变更，收到通知后重新检查，避免丢唤醒；
- 删除回执必须覆盖 SQL 删除、索引移除和相关失效发布；
- 支持超时、取消、失败传播和最终一致模式；
- 全量启动对账、notify 漏事件补偿以及忽略目录规则继续保留。

### 16.10 派生资产发布校验输入代际

取消租约后，派生计算可与事实摄取并发，但不能无条件把过期计算结果发布成当前健康资产。

- 在固定读事务中读取输入和源事实代际，随后释放读连接再执行长计算；
- Pairwise、Residual、EPA 与统一 Memo 构建使用可验证的依赖签名，防止不同源代际混装；
- 结果经 Write Actor 提交前校验源依赖是否仍适用；
- 已过期结果丢弃重算，或作为明确版本化历史产物保存，不能覆盖当前 ready 指针；
- 数据库事务成功后才发布内存资产句柄；
- 不兼容旧资产不能被当作可用回退；返回结构化 warming/不可用状态；
- 派生队列设置去重、并发数、最大排队量、退避及取消；
- 保留现有训练触发阈值、quiet window、主动全量训练和退休资产清理语义，不重新启用已退役 DTSC；
- 算法保持现行生产版本，本工程不引入 RiverMemo V2 数学变更。

目前使用表数量及最大 rowid 生成的摘要不能检测所有原地更新，不能作为新引擎唯一事实版本。使用在事实事务内推进的持久化单调版本；保留数据库实例身份以区分恢复重建后的新库。

### 16.11 调度、连接与关闭的实施限制

- Write Actor 使用独立线程和有界命令队列。
- 同步 SQLite、文件读写与 usearch 工作在受控后台执行器运行，不直接阻塞 Tokio 调度线程。
- N-API AsyncTask 使用 libuv 工作池，不等同于“自动运行在 Rayon”；连接等待或单飞等待不得耗尽共享池并造成任务相互等待。
- 读池建议先设 4 条并通过压力测试调整。SQLite cache_size 是目标缓存配置，不是整个任务 RSS 的硬上限；mmap、排序临时内存、HNSW 和任务缓冲分别计量。
- 所有返回结果设置条数和字节预算；正常查询默认不返回向量，兼容业务确需单条向量时提供受限显式接口。
- 错误对象包含稳定错误码、操作 ID、是否可重试和提交阶段，不通过字符串猜测失败类型。
- 关闭先停止 watcher 和新任务接纳，取消未开始任务，处理在途 Embedding 回执，排空写事务和索引发布，再释放查询引用、关闭读池和写连接。
- 现有进程全局 SQLite keepalive 必须迁出或删除，不能在 Runtime 关闭后留下隐式连接。
- 超时不代表已关闭；若在途任务未退出，不得立即隔离、重命名或删除数据库文件。

### 16.12 文件级施工清单

以下名称为建议的新文件拆分，允许调整，但职责和唯一所有权不得改变。

| 建议位置 | 实施内容 | 关键依赖/验收 |
|---|---|---|
| Rust storage 模块 | 连接工厂、Write Actor、Read Pool、背压、关闭 | 所有开库点汇入此模块 |
| Rust schema 模块 | 完整迁移现有表、触发器、索引、版本迁移 | 老库/空库/迁移中断 |
| Rust health 模块 | 错误分级、checkpoint、隔离、重建 | busy 不当 corrupt；隔离前排空句柄 |
| Rust ingestion 模块 | 文件版本、预检、向量复用、提交、删除 | 部分失败、乱序完成、迁移重命名 |
| Rust text 模块 | 原预处理、切分和 Tag 规则等价迁移 | 黄金样本和无需重算存量向量 |
| Rust index lifecycle 模块 | 单飞、恢复、差分、双槽、淘汰 | 并发发布与崩溃窗口 |
| Rust metadata 模块 | 日期、名称向量缓存、KV、种子、hydrate | 保持既有公共返回语义 |
| Rust derived coordinator | 派生任务编排、版本检查、事务发布 | 无租约且无过期覆盖 |
| 现有 Rust 查询模块 | 接收 StorageEngine/查询上下文 | 不再接收任意路径自行开库 |
| [KnowledgeBaseManager.js](../KnowledgeBaseManager.js) | 异步代理、配置、Embedding 编排 | 无中央连接与全量 BLOB |
| [modules/knowledgeBase](../modules/knowledgeBase) | 门面化或退出生产路径 | 保留必要业务契约，移除 SQL 权限 |
| [TagMemoEngine.js](../TagMemoEngine.js)、[EPAModule.js](../EPAModule.js)、[TagMemoV10Engine.js](../TagMemoV10Engine.js) | 只保留仍有调用者的代理/配置适配 | 不通过删除函数丢失管理和训练能力 |
| [ResultDeduplicator.js](../ResultDeduplicator.js)、[ResidualPyramid.js](../ResidualPyramid.js)、[RiverMemoEngine.js](../RiverMemoEngine.js) | 审核调用者并迁移仍活跃的数据访问 | 无同步 JS 数据库回退 |
| [riverMemoArtifactRepository.js](../modules/tagmemoV10/riverMemoArtifactRepository.js) | 资产状态、prune 和持久化迁入 Rust | 清理也必须走 Write Actor |
| [associativeDiscovery.js](../modules/associativeDiscovery.js)及 RAGDiary 调用边界 | 改用异步高层元数据/种子接口 | 保持现行检索算法与权限 |
| 管理路由及维护入口 | 改用高层异步代理 | 全仓审计中央库调用者后补全清单 |
| 现有测试与原生类型声明 | 高层 mock、临时库、ABI 版本检查 | 二进制陈旧时启动明确失败 |

原生 ABI 必须提供能力/版本握手。生产必须具备完整新存储契约，缺失时启动失败并给出重建提示；不能自动恢复中央库 JS 连接。

施工前读取适用目录开发约定，记录工作树改动，保留用户现有修改。上表未完成调查的分支必须先读实现再移植；本文件不把未核对行为当成已证实事实。

### 16.13 必须执行的验证

复用现有索引 Delta、Tag 基线、一致性、Pairwise、原生查询、Manifest、联想发现、摄取失效测试，并将中央库 mock 改为高层接口。额外增加真正验证失效窗口的测试：

1. SQL 已提交、索引尚未发布时强制退出，重启能恢复且不重复写入。
2. 基线文件写完、活动元数据未切换时退出，旧活动基线仍有效。
3. 基线保存与文件修改/删除并发，恢复后的 ID、向量版本与 SQL 一致。
4. 同 ID 向量更新能被差分发现。
5. 同路径旧 Embedding 在删除/新修改之后返回，不能覆盖新版本。
6. 单飞首次加载失败后可重试；并发请求无重复加载。
7. Read Pool 饱和、写队列饱和、任务取消和关闭不死锁。
8. 派生计算期间事实变化，旧结果不能发布为新代资产。
9. 部分 Embedding 失败不串位，失败文件保留可重试状态。
10. Windows 关闭后能重命名临时数据库、WAL/SHM 与索引文件。

性能验证使用临时库和有代表性的脱敏副本，不直接向生产库压测。报告数据规模、向量维度、并发数、冷/热状态、Event Loop 延迟分位数、SSE 帧间隔、RSS、V8 heap/external、读连接数、队列深度、冷启动和写入延迟。5ms 目标相对空载基线评估，不承诺整台机器在任意负载下峰值绝对小于 5ms。

静态验收扫描必须同时覆盖 JS 中央库直接访问、Rust 旁路开库、同步索引方法调用和剩余租约引用；独立业务数据库与明确离线脚本列入显式允许清单，不能用全局删除依赖替代审计。

### 16.14 生产切换与完成回执

1. 停止服务，确认没有在线中央库维护脚本。
2. 使用 SQLite 一致性备份或所有连接已关闭后的完整备份，记录代码、Schema、模型和数据库身份。
3. 在备份副本验证升级、恢复和查询对照。
4. 构建匹配 ABI 的原生二进制并启动新模式。
5. 确认唯一 Rust 存储所有者、无租约、无 JS 中央连接、无同步冷启动。
6. 完成 RAGDiary、摄取、删除、Tag 维护、训练和关闭冒烟验证。
7. 回滚必须先停机，再恢复匹配备份与旧代码，不直接让旧程序打开可能不兼容的新 Schema。

交付回执应明确区分“施工图完成”“源码实现完成”“测试通过”“生产切换完成”。当前交付仅为施工图，不声称已完成 Rust 数据面迁移。