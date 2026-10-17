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