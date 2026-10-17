# KBM 纯 Rust 单一 SQL 真相源与异步冷启动架构施工日志

> 日期：2026-10-17  
> 施工分支：`feat/kbm-rust-single-sql-runtime`  
> 仓库：`H:\VCP\VCPMain\VCPToolBox`  
> 本日志：阶段性工程交接记录，不代表最终生产切换完成

## 1. 本阶段目标与边界

本阶段按《KBM 纯 Rust 单一 SQL 真相源与异步冷启动架构施工草图》第 7—16 章推进，目标是把中央 `knowledge_base.sqlite` 的数据面逐步收拢到 Rust `NativeKnowledgeRuntime`，同时保留 Node.js 控制面和 `EmbeddingUtils.js` 的远端向量化职责。

明确排除：

- 不修改 TDB 业务、TDB 数据库和 TDB 测试。
- 不改造 `Plugin/LightMemo/LightMemo.js`。
- 本阶段不执行测试套件、不做生产上机实测。
- 本阶段不宣称已经完成最终生产切换。

本阶段允许保留部分旧 JS 门面用于兼容，但中央库的生产事实写入正在转移到 Rust Write Actor；后续必须继续完成所有权收口，不能把当前兼容层当作目标态。

## 2. Git 与工作树状态

当前分支：

```text
feat/kbm-rust-single-sql-runtime
```

当前工作树包含大量本阶段施工改动，既有已暂存修改，也有工作区继续修改。不能使用回滚或清理命令覆盖这些变更。

已确认的主要变更类别：

- 删除旧 JS EPA/Residual 实现。
- 调整 TagMemo、RiverMemo、ResultDeduplicator、AgentDream、RAGDiary 和联想发现等生产适配边界。
- 新增 Rust 存储、Schema、索引生命周期、摄取、Tag 一致性和 pairwise 维护模块。
- 扩展 `NativeKnowledgeRuntime` 与 N-API 类型声明。
- 将中央库摄取、删除和部分查询/维护能力转入 Rust。
- 将 KBM 文件监听路径改为 Rust watcher 事件队列消费。
- 更新 Windows 原生 `.node` 二进制文件。

Git 状态中已确认的核心路径包括：

```text
KnowledgeBaseManager.js
modules/knowledgeBase/databaseCoordinator.js
modules/knowledgeBase/diaryMetadataCache.js
modules/knowledgeBase/fileWatcher.js
modules/knowledgeBase/indexRepository.js
modules/knowledgeBase/ingestionPipeline.js
modules/knowledgeBase/searchService.js
modules/knowledgeBase/tagConsistencyService.js
rust-vexus-lite/src/index_lifecycle.rs
rust-vexus-lite/src/ingestion.rs
rust-vexus-lite/src/knowledge_runtime.rs
rust-vexus-lite/src/lib.rs
rust-vexus-lite/src/schema.rs
rust-vexus-lite/src/storage.rs
rust-vexus-lite/src/tag_consistency.rs
rust-vexus-lite/index.d.ts
```

同时存在已删除文件：

```text
EPAModule.js
ResidualPyramid.js
modules/knowledgeBase/migrationVectorCache.js
modules/tagmemoV10/riverMemoWorker.js
modules/tagmemoV10/riverMemoWorkerPool.js
```

这些删除属于此前授权的旧生产实现收敛范围，不涉及 TDB 或 LightMemo。

## 3. 已完成的工程工作

### 3.1 Rust StorageEngine 骨架

已建立 Rust 存储所有权骨架，包含：

- 中央 SQLite 注册和连接管理。
- Write Actor 入口。
- Read Pool 入口。
- Schema 初始化入口。
- 数据库代际与运行时元数据接口。
- Native Runtime 的 Store 生命周期接口。
- Runtime capability/ABI 握手字段。

当前目标结构是：

```text
NativeKnowledgeRuntime
└── SqliteStorageEngine
    ├── Write Actor
    ├── Read Pool
    ├── Schema/Migration
    └── Runtime metadata
```

需要注意：当前代码仍处于施工阶段，健康恢复、任务排空、严格关闭语义和所有旁路连接审计尚未达到最终完成定义。

### 3.2 NativeKnowledgeRuntime 接口扩展

已增加或推进以下接口族：

- `openAndInitStore`
- `storeState`
- `healthCheck`
- `databaseGeneration`
- `capabilities`
- `commitIngestionBatch`
- `commitDeleteBatch`
- `probeIngestionFiles`
- `probeIngestionTags`
- `probeMigrationReuse`
- `cleanupDatabaseOrphans`
- `getTagConsistencySnapshot`
- `commitTagConsistency`
- `getKvVector`
- `setKvVector`
- `listKvVectors`
- `hydrateChunksByIds`
- `hydrateChunksByFilePaths`
- 日记本列表、文件范围、日期索引等轻量查询
- 日记索引注册、注销、恢复和 checkpoint
- Runtime 所有权的 watcher 启停和事件排空

KBM 启动阶段已经增加 capability handshake，要求原生模块具备中央存储、摄取、删除、Tag 一致性、索引恢复、watcher 和 Memo/River 查询能力。缺少能力时启动失败，而不是退回 JS 中央数据库连接。

### 3.3 摄取事实表提交

已将摄取批次的事实表提交接入 Rust Write Actor：

- 文件版本检查在 Rust 事务内执行。
- `files`、`chunks`、`tags`、`file_tags` 和迁移缓存消费进入 Rust 事务。
- JS 保留文件读取、文本切分、Tag 提取和 Embedding API 编排。
- 向量以 Float32Array 位置槽提交，Rust 校验维度、长度和有限浮点值。
- 部分 Embedding 失败以空槽保留，不通过删除数组元素改变位置。
- 迁移向量复用在 Rust 事务内读取 BLOB，避免向量 BLOB 进入 V8。
- 返回事实提交回执、受影响文件、Chunk、日记和 Tag 信息。

当前仍需补齐：

- 原生批次 TTL、取消、预算和持久化操作身份。
- 同一路径删除/修改后的旧 Embedding 防复活。
- 严格的文件快照再校验和预处理版本校验。
- 部分失败、乱序返回和重复提交的完整持久化语义。
- Rust 权威文本切分与 Tag 规则迁移。

### 3.4 删除提交和索引 Delta

本阶段已完成删除路径的关键收口：

- Rust `DeleteCommitTask` 取得已注册日记索引的 Arc 快照。
- 删除事实事务继续由 Rust Write Actor 执行。
- 删除后的 Chunk ID Delta 在 Rust 后台任务内应用到驻留日记索引。
- `DeleteCommitResult` 增加 `indexReady`。
- Rust 事实提交成功但索引未驻留、锁失败或删除失败时返回 `indexReady: false`，不把已提交事实误判为可重试数据库失败。
- JS `_handleDeleteBatch` 已移除：
  - `indexRepository.applyChunkDelta`
  - 大删除时的 JS 索引注销
  - JS 持久化索引删除
- JS 只保留日期缓存失效、回执日志和队列状态处理。
- KBM 空删除批次回执已明确返回 `indexReady: true`。

已执行并通过：

```text
cargo check --manifest-path rust-vexus-lite/Cargo.toml
node --check KnowledgeBaseManager.js
node --check modules/knowledgeBase/ingestionPipeline.js
node --check modules/knowledgeBase/fileWatcher.js
```

最后一次验证结果：

```text
Exit code: 0
Finished `dev` profile [unoptimized + debuginfo]
无编译警告
```

删除 Delta 当前仍是“事实提交后应用内存索引”的协调实现，不是 SQLite 与 usearch 的跨资源事务。后续必须接入索引发布门禁、已应用代际、失效记录和崩溃恢复。

### 3.5 Rust watcher 事件队列

已推进 Rust watcher 的 Runtime 所有权方向：

- `NativeKnowledgeRuntime` 持有 watcher。
- watcher 事件进入 Rust 内部有界队列。
- Runtime 暴露 `drainWatchEvents`。
- JS `fileWatcher.js` 使用 Runtime 队列消费轻量事件。
- RAG 参数 watcher 也已改为 Rust watcher 队列消费。
- `WatcherConfig` 的 TypeScript 声明已补充 `initialScan`。
- watcher 的稳定性采样、generation 和稳定事件字段已纳入事件结构。

当前仍需重点处理：

- 队列满时不能静默丢弃关键文件事件，必须有 overflow/reconciliation 信号。
- 初始扫描、notify 事件和停止流程需要可取消、可排空、可证明不丢版本。
- Rust watcher 的 standalone 兼容 API 必须继续兼容 TDB 既有回调语义。
- 不能让 KBM 长期依赖“Rust 事件 -> JS pendingFiles -> JS 批处理”作为最终架构；最终目标是 Rust 内部版本化路径队列和原生准备任务，JS 只接收缺失 Embedding 文本并提交结果。
- watcher 的文件扫描、稳定确认、忽略目录和错误补偿仍需完整审计。

### 3.6 索引生命周期和基线方向

已新增/推进 Rust 索引生命周期模块和 Runtime 日记索引注册：

- 日记索引注册具有 generation。
- 注销操作携带 expected generation，避免旧淘汰任务误删新实例。
- Runtime 能够在后台执行日记和 Global Tag 索引恢复。
- 基线恢复、差分回放和 checkpoint 已形成接口。
- N-API 类型声明已暴露异步恢复与 checkpoint 接口。

当前不能视为完成的部分：

- 冷启动单飞、失败重试和并发预算仍需完整闭环。
- 索引实例的 invalid/warming/recovering 状态没有完全成为查询门禁。
- 索引更新失败后需要构建替代实例并原子替换，不能继续使用部分修改实例。
- 事实代际和索引 applied generation 还需要持久化协调。
- 双槽文件和活动元数据必须保证来自同一个冻结快照。
- 同 ID 向量更新必须有向量版本或内容指纹，不能只按 Chunk ID 判断差异。
- 不能在未完成索引 Delta 时返回“索引完成”。
- JS `IndexRepository` 仍有较多兼容与生命周期逻辑，后续需继续降为 Rust 门面。

### 3.7 Memo/River/派生方向

已推进：

- Memo/River 原生查询和 MemoRuntime 相关接口。
- Memo artifact 的 Rust 构建与控制面句柄。
- TagMemo V9/V10 控制面适配。
- EPA/Residual 旧 JS 实现删除。
- 部分 pairwise、Tag 一致性和派生维护接口迁移到 Rust。
- KBM 仍保留管理、训练触发、配置和兼容 API。

后续必须继续核对：

- 所有派生计算的输入快照、源事实代际和依赖签名。
- 过期计算结果不得覆盖当前 ready 资产。
- 派生资产写入必须经过 Write Actor。
- 派生任务不能重新引入 Rust 子模块旁路开库。
- 管理页面使用的训练、状态、清理和发布 API 不能因删除旧 JS 实现而丢失。
- MemoRuntime 与 Global Tag 索引必须由同一个 Rust 所有权根协调。

## 4. 当前已知风险和未完成项

### 4.1 中央库所有权尚未最终闭环

施工目标要求：

```text
KBM 不持有中央 better-sqlite3 连接
modules/knowledgeBase/*.js 不直接访问中央库
Rust 子模块不自行 open 中央 SQLite
所有中央读写进入 SqliteStorageEngine
```

当前 Rust StorageEngine 和多数代理已经建立，但仍需继续完成全仓静态审计，尤其是：

- 旧 schema/health/query utility 的生产引用。
- `IndexRepository`、TagConsistency、SearchService 的兼容路径。
- 派生模块和 RiverMemo artifact repository。
- 管理路由与维护入口。
- 旧数据库协调器和租约相关残留。

### 4.2 数据库代际仍需加强

当前部分 WriteReceipt 的 `database_generation` 仍存在施工期占位或弱语义。必须改为：

- 事实事务内推进持久化单调版本。
- 区分数据库实例身份和事实代际。
- 同一操作 ID 重复提交返回既有回执。
- SQL 已提交、索引未发布时保留可恢复状态。
- 重启时根据事实代际和失效记录恢复索引。

### 4.3 关闭与 Windows 句柄

当前关闭流程已尝试先停 watcher、等待外部变更和索引恢复，再关闭 Native Runtime，但仍需验证：

- 在途 AsyncTask 是否全部被跟踪和排空。
- Write Actor 队列是否拒绝新任务并排空已接纳任务。
- Read Pool 是否确实全部归还并关闭。
- watcher worker 是否可 join。
- usearch 临时文件、SQLite、WAL/SHM 是否在 rename 前释放。
- shutdown 超时是否不会伪装成已关闭。

### 4.4 watcher 事件丢失风险

当前 Rust 队列是有界队列，队列满时的处理仍需从“静默丢弃”提升为：

- coalesce 同一路径事件；
- 记录 overflow；
- 触发全量对账；
- 保证最后一个路径版本可恢复；
- 对 notify 漏事件提供启动和运行期补偿。

### 4.5 索引更新的错误语义

当前删除路径已避免把事实提交后的索引异常转为重复删除，但“索引未就绪”还需要接入真正的原生恢复调度。仅返回 `indexReady: false` 并打印日志不足以完成恢复闭环。

摄取路径同样需要：

- factsCommitted 与 indexReady 分离；
- index invalid 状态；
- 原生重建任务；
- 可查询门禁；
- 失败回执和操作 ID；
- 不依赖 JS 重新提交同一批次来恢复索引。

## 5. 本阶段验证

已执行的验证：

```text
cargo check --manifest-path rust-vexus-lite/Cargo.toml
node --check KnowledgeBaseManager.js
node --check modules/knowledgeBase/ingestionPipeline.js
node --check modules/knowledgeBase/fileWatcher.js
```

结果：

```text
全部通过，Exit code 0。
```

按用户要求，本阶段没有运行测试套件，也没有执行生产数据库上机验证。

因此当前状态只能表述为：

- 源码阶段性编译通过；
- 相关 JS 文件语法通过；
- 未完成测试验收；
- 未完成真实数据库迁移验证；
- 未完成生产切换；
- 未完成 Windows 文件句柄和崩溃窗口验证。

## 6. 下一阶段建议顺序

后续接续施工时建议按以下顺序恢复：

1. 修复 Rust watcher 队列溢出、初始扫描、停止排空和 TDB standalone 兼容。
2. 完成 `SqliteStorageEngine` 的持久化事实代际、操作回执和关闭状态机。
3. 将删除/摄取索引发布统一为 Rust scope gate + applied generation。
4. 完成删除、摄取、孤儿清理对索引失效和恢复的统一调度。
5. 完成 Rust 原生文本预处理、Chunk/Tag 黄金样本对照和版本冻结。
6. 将 native ingestion 从 JS pending queue 继续下沉为 Rust 版本化路径队列。
7. 完成 TagConsistency 的 Rust 快照、确认 token、向量任务和最终提交闭环。
8. 清理 Rust 子模块旁路 `Connection::open_with_flags`。
9. 清理 JS 中央 SQL、better-sqlite3、rustWriteLease 和 50ms 轮询。
10. 完成派生资产源代际校验和 Write Actor 发布。
11. 完成 ABI 声明、原生二进制和生产启动门控一致性。
12. 最后再进入测试套件、临时库压力验证、崩溃窗口验证和生产切换演练。

## 7. 交接结论

本阶段已经把工程从“施工图”推进到“Rust 存储/摄取/删除/索引/watcher 的实际代码骨架和部分生产路径接管”。

本阶段没有完成以下最终定义：

- 不是完整 Rust 数据面闭环。
- 不是中央 SQLite 所有旁路已经清零。
- 不是所有索引发布都具备崩溃恢复。
- 不是 watcher 已经具备绝对不丢版本保证。
- 不是 LightMemo 已适配。
- 不是 TDB 已修改或纳入施工。
- 不是测试通过。
- 不是生产切换完成。

后续开发应以本日志和原施工草图第 16 章为接续依据，优先修复已列出的所有权、代际、watcher 和关闭风险，再进入测试阶段。