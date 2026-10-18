# KBM 纯 Rust 单一 SQL 真相源与异步冷启动架构施工日志（续）

> 日期：2026-10-17  
> 施工分支：`feat/kbm-rust-single-sql-runtime`  
> 基线提交：`068c16b6`  
> 本日志：本轮续施工交接记录，不代表测试完成或生产切换完成

## 1. 本轮边界

本轮只处理中央 KBM `knowledge_base.sqlite` 的 Rust SQL 所有权和 Memo 派生资产生产入口。

明确排除：

- TDB 业务、TDB 数据库和 TDB 测试；
- `Plugin/LightMemo/LightMemo.js` 及其后续适配；
- 测试脚本迁移和测试套件执行；
- 离线维修脚本；
- 其他独立业务 SQLite 数据库。

## 2. 本轮已完成

### 2.1 Memo artifact 清理下沉 Rust

新增 `NativeMemoArtifactPruneTask`，清理逻辑位于 Rust Runtime 数据面：

- 通过统一 `SqliteStorageEngine` 的 Read/Write 入口访问中央库；
- 所有清理写入经过 SQLite Write Actor；
- 按 `published_at`、`updated_at` 倒序保留最近的 ready artifact；
- 超出保留数量的 ready artifact 标记为 `retired`；
- retired artifact 的 payload 和 checksum 一并清空；
- 超过保留期的 failed/retired artifact 删除；
- 清理结果返回 `retired`、`deleted` 和保留数量摘要；
- 清理任务在 N-API 后台任务中执行，不在 Node.js 主线程执行 SQL。

### 2.2 KBM 生产回调切换

`KnowledgeBaseManager.onNativeMemoArtifactPublished()` 已改为异步控制面回调：

- 继续只发布轻量 Native Memo artifact handle；
- 移除对旧 JS `artifactRepository.prune()` 的生产调用；
- 改为调用 `NativeKnowledgeRuntime.pruneNativeMemoArtifacts()`；
- 清理失败只记录警告，不回滚已经完成的 artifact 发布；
- 启动阶段增加 `pruneNativeMemoArtifacts` ABI 存在性检查；
- Node.js 不再直接管理 `rivermemo_artifacts` 的生命周期 SQL。

### 2.3 ABI 类型声明同步

`rust-vexus-lite/index.d.ts` 已增加：

```ts
pruneNativeMemoArtifacts(
    dbPath: string,
    retainReadyArtifacts?: number | null,
    failedRetentionMs?: number | null
): Promise<unknown>
```

Rust Runtime 导出、TypeScript 声明和 KBM 调用名称保持一致。

### 2.4 既有 Rust 所有权收口确认

本轮重新扫描中央库生产路径，确认以下项目没有出现在 KBM 主链：

- `better-sqlite3` 中央库连接；
- `rustWriteLease`；
- `artifactRepository.prune()`；
- 生产路径同步 `VexusIndex.load()`；
- 生产路径同步 `VexusIndex.save()`。

扫描命中项全部属于已排除范围：

- TDB；
- 独立插件数据库；
- 测试文件；
- 离线检查、重建和维修脚本；
- Rust standalone 测试样例。

## 3. 本轮验证

已执行：

```text
cargo check --manifest-path rust-vexus-lite/Cargo.toml
node --check KnowledgeBaseManager.js
```

结果：

```text
cargo check：通过，Exit code 0
KnowledgeBaseManager.js：通过，Exit code 0
```

本轮未执行：

- 测试套件；
- 测试脚本迁移；
- 原生 release 构建；
- Windows 原生二进制替换；
- 真实中央数据库迁移；
- 生产数据库压测；
- 崩溃窗口验证；
- Windows 文件句柄 rename/delete 验证。

## 4. 当前完整 Rust SQL 进度

当前中央记忆库已经达到以下阶段：

### 已进入 Rust 生产路径

- SQLite StorageEngine 注册和连接管理；
- Write Actor；
- Read Pool；
- Schema 初始化入口；
- 数据库代际基础设施；
- 中央事实表摄取提交；
- 文件删除提交；
- Tag 一致性事实提交；
- 部分索引 Delta；
- 日记索引和 Global Tag 索引恢复接口；
- 双槽 checkpoint 接口；
- Rust watcher Runtime 所有权；
- Native Memo artifact 构建；
- Native Memo manifest 读取；
- Native Memo artifact 清理；
- Rust pairwise、intrinsic residual 和部分派生资产维护入口；
- Native River 查询和 Rust 侧 SQLite 读取。

### 已从中央库生产路径移除或禁用

- KBM 的中央 `better-sqlite3` 连接；
- JS `schemaManager` 生产调用；
- JS `sqliteHealthManager` 生产调用；
- JS 中央库 SQL 查询门面；
- JS 摄取事实表写入；
- JS 删除事实表写入；
- JS Chunk Delta 生产方法；
- JS Memo artifact prune SQL；
- Rust 子模块通过独立 `Connection::open_with_flags` 绕过统一 StorageEngine 的生产路径。

## 5. 仍未达到最终完成定义的项目

本轮不应把工程标记为“完整 Rust 数据面闭环”。以下事项仍未完成：

### 5.1 索引代际与跨资源发布

SQLite 事实提交和 usearch 内存索引更新仍是协调发布，不是跨资源事务。

仍需完成：

- 事实代际与索引 applied generation 的持久化协议；
- 受影响作用域查询/发布门禁；
- SQL 已提交而索引未发布时的崩溃恢复；
- Delta 失败后的不可查询状态和替代实例原子替换；
- 摄取、删除、Tag 一致性统一使用同一套恢复调度；
- “factsCommitted”和“indexReady”在所有接口中一致表达。

### 5.2 Tag Delta 失败恢复

Tag Delta 已转入 Rust，但当前仍需继续加强：

- 避免 usearch Delta 中途失败后留下部分修改实例；
- 失败时将索引标记为 invalid；
- 从 SQLite 权威事实层异步重建；
- 重建完成前禁止查询半成品；
- MemoRuntime 失效和索引恢复状态需要由同一 Runtime 所有权根协调。

### 5.3 摄取版本化闭环

当前 JS 仍负责文本切分、Tag 提取和 Embedding 请求编排。

仍需完成：

- Rust 权威文本预处理、Chunk 切分和 Tag 规则；
- 文本规则版本和黄金样本冻结；
- 文件预检后的 mtime/size/checksum 再校验；
- 原生 batch TTL、取消、数量和字节预算；
- 操作 ID 持久化幂等回执；
- 删除墓碑阻止旧 Embedding 结果复活；
- 部分 Embedding 失败和乱序返回的完整持久化语义；
- 同维度不同模型的语义空间校验。

因此当前状态仍是“事实提交已主要由 Rust 持有，文本业务权威尚未完全迁入 Rust”。

### 5.4 watcher 可靠性

Rust watcher 已拥有主路径，但仍有未闭环风险：

- 有界队列溢出仍需显式 overflow/reconciliation 信号；
- 初始扫描、notify 事件和运行期对账需要保证最后路径版本可恢复；
- watcher worker 线程停止时需要可证明 join；
- 停止流程不能只清空队列后释放句柄；
- 文件稳定确认失败需要进入可恢复补偿，而不是只打印并丢弃；
- 生产 watcher 的取消和关闭行为仍需 Windows 实测。

### 5.5 健康恢复与关闭

Rust 已提供健康检查基础接口，但完整损坏恢复尚未完成：

- 损坏数据库隔离；
- WAL/SHM 一致处理；
- 备份保留；
- 新库重建；
- 从 dailynote 重新摄取；
- 恢复期间结构化错误状态；
- 所有 N-API 后台任务跟踪和排空；
- Write Actor、Read Pool、watcher、usearch 句柄的严格关闭顺序；
- Windows 下数据库和索引文件替换验证。

KBM 当前的损坏处理仍包含“停止服务并重启恢复”的控制面提示，不能视为 Rust 已经完成自动恢复。

### 5.6 派生资产代际校验

Pairwise、Residual、EPA 和 Memo artifact 已有 Rust 构建或写入路径，但仍需补齐：

- 固定读事务快照；
- 源事实代际；
- 依赖签名；
- 长计算结束后的代际复核；
- 过期结果禁止覆盖 ready 资产；
- 派生队列去重、背压、取消和关闭排空；
- 派生资产不兼容时的结构化 warming 状态。

本轮仅新增了 Memo artifact 生命周期清理，未声称所有派生计算已经完成代际发布协议。

## 6. 生产路径扫描结论

本轮扫描关键词：

```text
better-sqlite3
rustWriteLease
Connection::open_with_flags
VexusIndex.load
VexusIndex.save
artifactRepository.prune
v10_derived_asset_status
rivermemo_artifacts
```

中央 KBM 生产路径未发现旧 JS SQLite 连接和旧同步索引持有路径。

扫描仍能看到以下内容，但均不属于本轮中央 KBM 生产链：

- `TDBKnowledge.js`；
- `routes/admin/cache.js`；
- `Plugin/ImageProcessor`；
- `Plugin/OneRing`；
- `Plugin/OpenHerPersona`；
- `Plugin/RAGDiaryPlugin/FoldingStore.js`；
- `scripts/` 下离线工具；
- `tests/` 下临时数据库和行为测试；
- `rust-vexus-lite/test.js`。

这些路径不能作为中央 `knowledge_base.sqlite` 单一 Rust 所有权失败的证据。

## 7. 交接结论

本轮交付：

- Rust Memo artifact prune；
- Runtime N-API 接口；
- TypeScript ABI 声明；
- KBM 异步生产调用；
- 中央库生产路径旧清理入口移除；
- Rust 编译检查通过；
- KBM JavaScript 语法检查通过；
- 中央库生产路径静态残留扫描完成。

本轮未交付：

- 测试迁移；
- 测试通过；
- release 原生二进制构建；
- 生产切换；
- 完整索引崩溃恢复；
- 完整 watcher 不丢版本保证；
- 完整 SQLite 损坏自动恢复；
- Rust 文本处理权威迁移；
- LightMemo 适配；
- TDB 改造。

当前准确状态：

> 中央 KBM 的事实表读写、主要摄取/删除路径、索引恢复接口和 Memo 派生主链已经由 Rust 承接；Node.js 主要负责控制面、Embedding 编排和结果消费。中央生产路径的旧 JS SQL 入口已基本清除，但索引代际、失败恢复、关闭排空、watcher 补偿和文本规则迁移仍未达到最终完成定义。

下一阶段应由后续施工继续完成第 5 节中的阻断项，再交给另一位 Agent 进行测试迁移、测试执行和全量变更分析。

## 8. 2026-10-17 晚间续施工：文本/Tag 计划与 native ABI 验证

本节覆盖上一版交接记录之后的实际施工，不代表全部生产完成。

### 8.1 已完成源码接线

- Rust `text` 模块已接入 `cl100k_base` tokenizer，承担文本预处理、Tag 提取、token 计数和 Chunk 计划。
- `NativeKnowledgeRuntime.prepareText()` 已导出；`KnowledgeBaseManager.prepareIngestionText()` 作为 JS Embedding 代理。
- 摄取管线已消费 Rust 返回的 `chunks/tags`，并修复旧 `validChunks.length` 残留导致的运行时错误。
- Rust `TagConsistencyPrepareTask` 已导出为 `prepareTagConsistency()`。
- Tag 一致性预览已改为消费 Rust 生成的文件计划、摘要、digest、token、TTL、模型签名和维度。
- JS 仅保留管理面板兼容转换、Embedding HTTP 编排和向量提交代理。
- Rust Tag 计划增加根路径规范化、路径越界保护和实际关系差异统计。
- `tag-consistency.prepare.v1` 已加入 capability handshake；Runtime、`index.d.ts`、release addon 已同步。

### 8.2 已完成验证

- `cargo test --manifest-path Cargo.toml`：11 个测试通过。
- `npm run build`：release native addon 构建通过。
- Node smoke test 已成功加载 `NativeKnowledgeRuntime`，并确认 `prepareTagConsistency`、ABI v2 和 `tag-consistency.prepare.v1` 可用。
- `KnowledgeBaseManager.js`、`modules/knowledgeBase/tagConsistencyService.js`、`modules/knowledgeBase/ingestionPipeline.js` 语法检查通过。
- `git diff --check` 通过；剩余 LF/CRLF 信息是行尾提示。

### 8.3 当前未完成阻断项

- watcher 的有界队列溢出后仍需完成路径版本对账、补偿和可验证排空。
- watcher 稳定采样失败、停止竞态和 reconcile 重入仍需针对性实现与验证。
- SQLite 健康恢复目前具备启动期隔离基础，尚未完成运行期结构化恢复状态、备份清单、全量重建和任务排空闭环。
- 事实提交与 usearch 索引发布仍缺少统一的 applied generation、invalid/recovering 门禁和崩溃恢复回执。
- Tag token 已由 Rust 生成并在提交阶段校验，但尚未持久化为独立的权威计划记录；提交幂等回执仍需补齐。
- 摄取的版本化批次、取消、TTL/字节预算、删除墓碑和旧 Embedding 防复活仍需下沉。
- 三份施工日志尚未替代生产切换验收；当前不宣称生产切换完成。

### 8.4 env 数据库变量审计结论

- `KNOWLEDGEBASE_RUST_READ_POOL_SIZE`、`KNOWLEDGEBASE_RUST_MMAP_SIZE`、`KNOWLEDGEBASE_SQLITE_BUSY_TIMEOUT_MS` 由 JS 读取后通过 `openAndInitStore()` 传入 Rust `SqliteStorageEngine`。
- `EPA_RUST_SAMPLES_PER_ANCHOR`、`EPA_RUST_ANCHOR_CANDIDATE_LIMIT`、`TAGMEMO_INTRINSIC_RESIDUAL_FORCE_RECOMPUTE` 由 Rust 直接读取。
- `WhitelistEmbeddingModelMaxToken`、`TAG_BLACKLIST`、`TAG_BLACKLIST_SUPER`、`KNOWLEDGEBASE_MAX_TAGS_PER_FILE` 由 JS 规范化后传给 Rust 文本/Tag 任务。
- 租约变量当前无消费者，符合移除租约系统的目标。
- TDB、LightMemo 不属于本轮兼容或迁移范围。

### 8.5 下一施工顺序

1. watcher 路径版本队列、overflow/reconcile、停止排空和重复事件合并。
2. facts/index applied generation 与索引 invalid/recovery 门禁。
3. Rust 运行期健康恢复、备份清单、重建状态和关闭排空。
4. 摄取批次身份、TTL、取消、预算、删除墓碑和幂等回执。
5. Tag 计划持久化与重复提交回执。
6. 最终临时数据库、崩溃窗口、Windows 句柄和 release 验收。

## 9. 2026-10-17 晚间续施工：watcher 与存储替换顺序修复

本节记录本轮实际落盘和验证结果，不代表生产验收完成。

### 9.1 已落盘修复

- `VexusWatcher` 增加 reconcile 重跑请求标记；对账线程运行期间再次收到请求时，会在当前扫描结束后继续执行一次对账，避免并发请求被静默丢弃。
- watcher 路径稳定采样耗尽后会清除孤儿 generation，并设置可对账信号；该路径不再只打印日志后永久丢失。
- `stop_watch()` 先停止运行状态、释放 notify 句柄并 join 已登记的 worker/reconcile 线程，随后才清理 generation、事件队列、溢出标志和扫描配置。
- `NativeKnowledgeRuntime.openAndInitStore()` 先关闭当前 `SqliteStorageEngine`，再打开并安装新 Engine，避免旧 Write Actor 与新连接在同一数据库上并存。
- 本轮没有修改 TDB、LightMemo 或其他独立数据库路径。

### 9.2 验证结果

- `cargo check --manifest-path Cargo.toml`：通过。
- `cargo test --manifest-path Cargo.toml`：11 个测试通过，0 失败。
- Rust 测试进程输出的 Node-API `GetProcAddress` 警告来自无 Node 宿主的测试进程，不改变测试退出结果。
- `cargo fmt --check` 已不再报告 Rust 语法解析错误，但仓库存在未由本轮引入的格式差异，因此没有执行全仓格式化。
- 本轮尚未完成真实 watcher 文件事件压测、队列溢出对账、停止竞态和 Windows 句柄验证。
- 本轮尚未完成损坏 SQLite 隔离/备份/重建的真实故障注入验证。

### 9.3 当前准确完成度

watcher 的部分状态机缺陷已修复，但“路径版本不丢、溢出可对账、停止可排空”的最终闭环仍未验收：有界队列仍以 overflow 标志触发全量扫描，扫描结果没有 SQL 缺失文件 tombstone 补偿；notify 回调与 `stop_watch()` 的并发执行也尚未通过 Windows 实测。

SQLite 已具备启动期 quick-check 损坏分类、隔离重开和 Write Actor/Read Pool 关闭基础；运行期结构化健康状态、备份清单、完整重建、所有 N-API 后台任务排空和故障注入仍未完成。因此本轮不将恢复闭环标记为完成。

### 9.4 env 数据库变量状态补充

- `KNOWLEDGEBASE_RUST_READ_POOL_SIZE`、`KNOWLEDGEBASE_RUST_MMAP_SIZE`、`KNOWLEDGEBASE_SQLITE_BUSY_TIMEOUT_MS` 的 Rust 消费路径保持不变：JS 读取环境变量后序列化为 storage options，由 `openAndInitStore()` 进入 `SqliteStorageEngine::open_and_init()`，再用于 Read Pool、`PRAGMA mmap_size` 和 SQLite busy timeout。
- `KNOWLEDGEBASE_RUST_MMAP_SIZE=0` 在 JS 侧仍需检查 `||` 默认值问题；Rust 侧本身支持非负值。
- EPA、intrinsic residual 和文本/Tag 变量的消费路径未因本轮 watcher/存储修复改变。
- 租约变量继续保持无消费者状态，符合移除租约系统的目标。

## 10. watcher 门面与摄取确定性错误修复

- JS watcher 门面不再把 `reconcileWatch()` 的同步返回误认为后台扫描已完成；Rust 负责对账 singleflight 和重跑请求合并。
- 修复摄取迁移探测请求中的未定义 `validChunks`，改为使用 Rust 文本计划生成的 `doc.chunks.length`。
- `fileWatcher.js` 与 `ingestionPipeline.js` 的 `node --check` 均通过。
- 反向残留检查确认 `ingestionPipeline.js` 中已不存在 `validChunks`。
- 本节修复不改变“overflow 全量扫描仍缺少 SQL 缺失文件 tombstone 补偿”的完成度判断；watcher Windows 竞态和真实溢出测试仍未完成。

## 11. 2026-10-18 续施工：可靠性协议与定向验证

本节更新前文的历史判断；未明确列为已验证的项目，不应推断为已完成。未触碰 TDB、LightMemo 或生产数据库。

### 11.1 已落盘

- watcher 对账接收 SQL 已索引相对路径，在完整扫描后对缺失路径生成 unlink 补偿；路径包含父目录或绝对前缀时拒绝参与删除。扫描不完整时不发缺失删除，元数据非 NotFound 错误不再当作文件消失。
- 初始扫描使用扫描开始时的 generation，运行期事件可覆盖旧扫描；对账线程持续消费重跑请求和最新路径快照。路径稳定任务限制为 64，事件队列限制为 4096，超限产生补偿信号。
- JS watcher 的异步路径快照增加生命周期检查，停止后的旧快照不能重新启动对账；重复 overflow 会请求下一轮快照。
- Write Actor 在事实事务内分配代际，回填 invalid 作用域的 facts generation 和操作回执代际；保留原 applied generation。历史幂等回执不再推进返回代际或重放历史索引差分。
- 摄取摘要采用规范化 JSON、向量分区和长度编码；终态操作拒绝复用。增加数量、文本和向量预算，以及可选 TTL 校验。JS 在 Embedding 前冻结批次身份，并在提交前复核模型签名、维度、mtime/size 和 watcher generation。
- 删除不存在的 SQL 路径也写入递增墓碑，旧 expectedVersion=0 摄取不能使其复活。删除和孤儿清理在提交前复核文件不存在；已重新出现的文件不会因旧 unlink 直接删除。
- Tag 计划持久化到权威 prepared plans 表；提交校验原生计划、TTL、取消状态、准备时数据库代际及源文件摘要；提交回执和计划 committed 状态在同一事务持久化。重复提交返回历史回执，不重放差分。
- 事实写入、部分索引恢复、checkpoint 和原生 ANN 使用进程级发布互斥门禁。摄取、删除、Tag 提交在状态发布失败时保留 facts committed，但返回 index not ready，不把事实已提交伪装为普通事务失败。
- 普通 KNN 改用原生异步 ANN，由 Rust 在发布门禁内取得候选正文；JS 不再通过同步索引查询及第二次 hydrate 拼接该路径。
- 日记 ANN 遇到明确 index-not-ready 状态时从 SQL 构建替代实例，清除幽灵向量后替换。恢复读事务同时捕获 facts generation；完成状态仅在该代际仍匹配时发布，其他数据库读取错误不会触发索引重建。
- 启动损坏隔离生成包含原库和 WAL/SHM 路径、大小的备份清单；移动前检查全部源文件和目标冲突，移动或清单落盘失败时回滚。
- 健康检查遍历全部 quick_check 结果并返回健康分类；JS 摄取与 Tag 控制面增加在途任务等待。旧 schema 的补列先于依赖索引创建，新于支持版本的数据库拒绝迁移。
- 长文本分块修复 UTF-8 token 窗口解码失败导致内容被静默丢弃的问题；优先完整字符，再保留可验证的标点边界。极小 token 预算不足容纳单个字符时允许该字符超预算以防丢字。

### 11.2 验证记录

截至 2026-10-18 13:10（UTC+8）：

- Rust 测试：30 passed、0 failed，包括墓碑防旧批次复活、历史回执、Tag 计划幂等/终态拒绝、schema 迁移、损坏备份清单、索引幽灵向量恢复及 Unicode 内容完整性。
- Node 定向测试：7 passed、0 failed，包括 watcher 生命周期/重跑、控制面 drain 和原生 KNN 结果消费。
- Windows 真实 notify 启停、重复对账及关闭后目录 rename/delete 测试已通过；队列测试为主动注入内存队列超限，不代表实际操作系统事件溢出压测已通过。
- 此前 release 构建和 Node 宿主临时库 smoke 已通过，但早于本节最新源码；必须重新构建并验证最新 ABI 后才能交付当前二进制。
- 未执行生产迁移、生产负载压测或进程崩溃窗口验收。

### 11.3 尚未闭环

- 所有查询入口（尤其直接 Tag / Memo / River 后续阶段）的统一索引门禁、全局 Tag 失效重建、注册实例身份和完整代际协议仍需收口；当前全局互斥门禁还有吞吐与后台线程等待成本。
- 摄取仍缺 Rust 持久化权威准备计划、强制 TTL/取消、数据库实例/文本规则/模型身份绑定、跨重试稳定操作身份；预算检查发生在 JSON/向量入参分配之后。部分 Embedding 修复与迁移缓存复用仍需非空集成验证。
- Tag 缺失/忽略源文件重新出现的提交复核仍需完善；源文件摘要读取目前在 Writer 事务内，不宜视为最终长事务设计。
- watcher 的真实高频并发、操作系统溢出、关闭竞态、符号链接与目录不可用情况下的删除安全仍未充分验收。
- 运行期数据库损坏自动隔离/重新摄取、全部 N-API 任务统一 admission/drain、旧数据库任务不能绑定新实例等仍未完成。控制面 drain 不等于 Rust 全任务排空。
- 派生资产固定快照和代际发布、故障注入、跨资源崩溃恢复及最终生产切换仍待完成。

### 11.4 env 消费校正

- 读池、mmap、busy timeout：JS 读取并经 storage options 传给 Rust；Rust 统一在 StorageEngine 建连时应用，非 Rust 直接解析这些环境变量。
- mmap=0 的 JS 默认值吞零问题已修复，明确允许关闭映射。
- 模板补充读池和 mmap 配置，删除旧中央库租约赋值及双写说明；实际运行配置不在本次修改范围。旧租约键即使保留在运行 env 中，也不恢复消费者。
- 本节没有扩展其他独立数据库的兼容范围。

当前结论：单一 Rust SQL 所有权已落地，多项可靠性子协议已实现并通过定向验证；不能将其表述为所有最终闭环或生产验收已完成。

### 11.5 13:24 增量验证与剩余生命周期缺口

- Rust 测试更新为 33 passed、0 failed；Node 定向测试更新为 8 passed、0 failed。
- 缺失源文件的 Tag 计划现在保留源路径，并在提交时要求路径仍为 NotFound；文件重新出现时拒绝提交，原有关系不变。对应非空临时库回归测试通过。
- 全局相似 Tag 查询新增原生异步搜索及名称读取接口，置于发布门禁内；invalid 状态拒绝查询。JS 不再同步搜索 Tag 索引或在第二次读取中拼接名称。原生门禁测试与代理测试通过。
- 新全局 Tag 接口已完成 release 构建、声明生成及 Node 宿主空库调用验证；此前健康检查、计划取消、取消后拒绝提交、日记 ANN 和关闭后临时目录删除也已通过宿主验证。
- Runtime 关闭改为收集 watcher、注册表和存储清理错误，仍尝试后续释放。注册表锁中毒故障测试确认数据库句柄可释放；该改动晚于最近一次 release，当前二进制尚不包含此关闭改动。
- KBM 启动增加新查询、取消、SQL 路径快照和对账接口存在性校验，避免旧 addon 延迟到查询时才失败。
- 仍未完成全局 Tag 自动替代重建和全部查询/派生入口的代际收口。
- 仍未完成任务级 admission/drain：现有存储计数仅覆盖执行中的 SQL，不能覆盖约 40 个异步任务入口中排队、计算和索引发布的完整生命周期；按路径查注册表也仍需实例身份绑定。不能用关闭故障测试代替这些验收。