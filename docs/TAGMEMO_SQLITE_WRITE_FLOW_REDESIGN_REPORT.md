# TagMemo / KnowledgeBase SQLite 写入竞态与大库派生任务流程重设计开发报告

**生成时间：** 2026-06-04 00:20 Asia/Shanghai  
**范围：** KnowledgeBase 主库、TagMemo 派生表、Rust Vexus 派生计算、EPA 基底计算、启动恢复流程  
**相关文件：**
- `KnowledgeBaseManager.js`
- `TagMemoEngine.js`
- `EPAModule.js`
- `rust-vexus-lite/src/lib.rs`
- `ServerLog.txt`

---

## 1. 背景与问题概述

本次排查源于用户日志中出现 SQLite 健康检查异常：

```text
SQLite quick_check failed:
Tree 10 page 10 cell 62: invalid page number 138534
database disk image is malformed
```

异常发生在 TagMemo 矩阵重建流程中。初始判断容易指向“Rust 写坏 SQLite”，但后续补充日志显示，用户重启后：

- KnowledgeBase 正常初始化；
- EPA basis 成功重算；
- `tag_pair_similarity` 正常读出 107890 条；
- `tag_intrinsic_residuals` 正常读出 14691 条；
- TagMemo matrix 正常构建；
- RAG 查询和日记检索正常运行；
- 小巴士 50 文件批处理正常继续。

因此最终结论修正为：

> 业务逻辑本身已经基本通过；问题核心不是业务 SQL 写坏库，而是 SQLite 写入编排、跨连接 WAL/checkpoint、健康检查时机、长耗时派生任务持锁方式等流程设计问题。

本报告用于重置上下文后继续开发，目标是给出严谨、可实施、可扩展到更大库和更长计算任务的优化方案。

---

## 2. 现有架构与关键路径

### 2.1 主数据层

主数据表由 `KnowledgeBaseManager.js` 初始化：

```sql
files
chunks
tags
file_tags
kv_store
tag_pair_similarity
tag_intrinsic_residuals
```

核心事实表：

- `files`
- `chunks`
- `tags`
- `file_tags`

这些表构成 KnowledgeBase 的事实来源。

写入入口主要是：

- `_flushBatch()`
- `_handleDeleteBatch()`
- `_fetchAndCacheDiaryNameVector()`
- `getPluginDescriptionVector()`

其中 `_flushBatch()` 负责“小巴士”流程：

```text
pendingFiles
→ 每次取 50 files
→ Embedding
→ JS transaction 写 files/chunks/tags/file_tags
→ 更新内存 Vexus index
→ scheduleMatrixRebuild(actualTagChanges)
```

### 2.2 派生数据层

TagMemo 派生表：

- `tag_pair_similarity`
- `tag_intrinsic_residuals`

EPA 派生缓存：

- `kv_store.epa_basis_cache`

派生计算入口：

- `TagMemoEngine.recomputePairwiseSimilarities()`
- `TagMemoEngine.recomputeIntrinsicResiduals()`
- `EPAModule` 中 EPA basis 重算逻辑
- Rust N-API:
  - `compute_pairwise_similarities`
  - `compute_intrinsic_residuals`
  - `compute_epa_basis`

### 2.3 Rust 写租约

现有 `KnowledgeBaseManager.requestRustWriteLease()` 已经实现了基本门控：

```text
databaseCorruptionDetected
rustWriteLease active
isProcessing
isProcessingDeletes
pendingDeletes
pendingFiles threshold
JS write cooldown
Rust write cooldown
```

此机制已经能避免大量 JS 主写与 Rust 写直接重叠，是正确方向。

但它仍有几个边界不足：

1. 租约只覆盖 Rust 写，没有抽象为统一数据库写调度器；
2. 长计算和写入发布混在同一个租约中；
3. 单次 quick_check 失败直接进入 `databaseCorruptionDetected`；
4. Rust、JS 多处 checkpoint 责任分散；
5. 派生表直接写正式表，缺乏版本兜底；
6. 启动期 EPA 可能抢跑并长时间持写租约。

---

## 3. 事故时间线复盘

### 3.1 高压小巴士阶段

日志显示，系统持续进行 50 文件批处理：

```text
[KnowledgeBase] 🚌 Processing 50 files...
[KnowledgeBase] ✅ Batch complete. Updated 1 diary indices.
```

这对应主数据写入流程。此阶段出现大量 embedding API 400/429，但主库批处理仍持续推进。

同时 TagMemo matrix rebuild 等待：

```text
Rust SQLite write lease "tagmemo:matrix-rebuild" waiting: js-batch-processing
pendingFiles=4017
```

说明现有 Rust 写租约确实在等待 JS 小巴士结束，没有直接抢写。

### 3.2 首次 matrix rebuild 超时

日志显示：

```text
Rust SQLite write lease "tagmemo:matrix-rebuild" timed out after 1800000ms
```

这是因为 pendingFiles 长时间存在。此行为符合“主数据优先”的方向。

### 3.3 23:50 matrix rebuild 获得租约

后续 pendingFiles 清空或低于阈值后：

```text
Rust SQLite write lease granted to "tagmemo:matrix-rebuild"
```

随后 Rust pairwise 写入完成：

```text
V8.2 Rust pairwise sim done:
pairs=107890, computed=107890, skipped=0, stored=107890
```

紧接着 JS 读取 pairwise 表报：

```text
V8.2 pairwise similarity table not yet available:
database disk image is malformed
```

之后流程仍继续执行 intrinsic residual：

```text
Triggering Rust intrinsic residual precomputation...
Rust precomputation complete: 14691 computed, 12 skipped
```

最终 quick_check 报大量 invalid page number。

### 3.4 00:05 重启后恢复

用户重启后：

```text
Global Tag Index loaded from disk
EPA Rust basis ready
warm start: 107890 cached pairwise similarities
Loaded 107890 pairwise similarities
Loaded 14691 intrinsic residuals
Ordered-bidirectional matrix built
System Ready
```

这表明数据库并非永久性主库损坏，更像是运行时旧连接、WAL、SHM、checkpoint 后的 transient 视图异常。

### 3.5 关键结论

本次现象不支持简单结论“业务 SQL 写坏库”。

更准确的结论是：

> 在高压主数据写入后，Rust 独立连接执行派生表大批量写入，随后 Rust/JS 多连接 checkpoint 与 JS 旧连接读取发生竞态；JS 当前连接看到 malformed/invalid page，但重启新连接后 SQLite WAL/SHM 视图恢复正常。

---

## 4. 已确认不是核心 bug 的部分

### 4.1 小巴士 50 文件批处理不是直接 bug

小巴士流程符合主数据优先策略。大量 `Processing 50 files` 看起来密集，但来自启动 full scan queue 21667 files，是预期行为。

现有代码中：

```text
pendingFiles
→ _flushBatch()
→ maxBatchSize = 50
→ transaction()
→ setImmediate(next batch)
```

这个流程本身没有表现出业务错误。

### 4.2 Rust 分批写入已经存在

`PairwiseSimTask` 已经有：

```text
WRITE_CHUNK_SIZE = 1000
每批一个 transaction
每 8 批 PASSIVE checkpoint
最后 TRUNCATE checkpoint
```

这说明问题不是“没有分批”，而是分批后仍然存在：

- checkpoint 责任分散；
- JS/Rust 跨连接视图同步；
- 健康检查误判；
- 失败后未中止后续派生写；
- 派生表无版本兜底。

### 4.3 重启后可读说明不应单次判死库

用户重启后一切可读，证明单次 `quick_check` 失败不能直接等同于永久损坏。

---

## 5. 根因归纳

### 5.1 流程设计根因

核心根因是数据库写入编排不够分层：

```text
长计算 + 写入 + checkpoint + 验收
被打包进同一个 Rust write lease / 派生流程
```

这在小库可用，但大库下风险高。

### 5.2 checkpoint 责任分散

当前 checkpoint 可能发生在：

- Rust 内部 `checkpoint_sqlite_wal()`
- TagMemoEngine `_checkpointAfterRustWrite()`
- KnowledgeBaseManager `checkpointAndAssertDatabaseHealthy()`

多个连接轮流 checkpoint，增加 WAL/SHM 视图不一致概率。

### 5.3 健康检查过于刚性

当前逻辑趋向于：

```text
quick_check fail
→ databaseCorruptionDetected = true
```

但本次案例表明应改为：

```text
quick_check fail
→ suspect
→ close/reopen connection
→ re-check
→ fail again 才 corrupt
```

### 5.4 派生任务缺少阶段中止

`loadPairwiseSimilarities()` 读到 malformed 后只是 warn，不中止 matrix rebuild，导致后续 intrinsic 继续写入。

### 5.5 长任务持写租约不可扩展

当前 EPA 运行约 336 秒。若未来复杂 10-50 倍，可能运行 1-5 小时。长时间持写租约会阻塞主数据入库、删除、watcher 处理、派生队列等。

### 5.6 派生表直接写正式表

pairwise 和 intrinsic 直接写正式表，缺少：

- staging；
- versioned active pointer；
- 上一版本兜底；
- publish 原子化。

---

## 6. 新流程设计总原则

### 6.1 主数据优先

事实表写入永远最高优先级：

```text
files/chunks/tags/file_tags
```

派生任务只能在系统安静窗口运行。

### 6.2 长计算离库，短发布入库

大库派生任务必须拆为：

```text
Snapshot
→ Compute
→ Publish
```

其中：

- Snapshot 只读；
- Compute 不持 SQLite 连接，不持写租约；
- Publish 持短写租约，执行 staging/version publish。

### 6.3 JS 统一调度数据库状态

Rust 负责计算和批量写产物；JS 负责：

- write lease；
- checkpoint；
- quick_check；
- suspect/corrupt 状态；
- publish；
- recovery；
- task queue。

### 6.4 健康检查三态化

数据库状态分为：

```text
healthy
suspect
recovering
corrupt
```

单次 malformed/quick_check fail 只进入 suspect，不立即判 corrupt。

### 6.5 派生数据版本化

派生数据不是事实表，可以旧，但不能破坏当前可用版本。

推荐用 versioned table + active pointer：

```text
tag_pair_similarity_v(job_id, ...)
kv_store: tag_pair_similarity_active_job = job_id
```

publish 只更新 active pointer。

### 6.6 任务可恢复

长任务必须有 job manifest 和 artifact，支持：

- 进程崩溃恢复；
- stale 检测；
- cancel；
- publish retry；
- old version cleanup。

---

## 7. 新架构组件设计

## 7.1 DatabaseWriteCoordinator

建议从 `KnowledgeBaseManager` 中抽象或内嵌统一调度器。

职责：

1. 管理数据库状态；
2. 管理写租约；
3. 管理写队列；
4. 管理 checkpoint；
5. 管理 suspect recovery；
6. 管理 dirty marker；
7. 提供统一 API 给 JS/Rust/派生任务。

状态：

```js
{
  dbState: 'healthy' | 'suspect' | 'recovering' | 'corrupt',
  activeLease: null | { owner, lane, startedAt, ttlMs },
  pendingPrimaryWrites: number,
  pendingDerivedTasks: number,
  lastHealthCheckAt: number
}
```

写 lane：

```text
primary-js
delete-js
cache-js
derived-rust
maintenance
```

优先级：

```text
primary-js > delete-js > maintenance > cache-js > derived-rust
```

---

## 7.2 DerivedTaskQueue

派生任务队列统一调度：

任务类型：

```text
epa-basis
pairwise-sim
intrinsic-residuals
matrix-memory-build
```

运行条件：

```text
dbState == healthy
pendingFiles == 0
pendingDeletes == 0
isProcessing == false
isProcessingDeletes == false
startupCooldown passed
no active primary write lease
```

失败策略：

```text
malformed/quick_check fail
→ abort current task
→ dbState=suspect
→ recovery verify
→ success: requeue task later
→ fail: corrupt mode
```

---

## 7.3 Job Manifest

长任务必须落盘记录。

目录建议：

```text
VectorStore/jobs/
```

示例：

```json
{
  "jobId": "epa-20260604-000516-abc123",
  "type": "epa-basis",
  "status": "computing",
  "modelSig": "9868cc2e32ce4892",
  "dimension": 3072,
  "startEpoch": 12345,
  "createdAt": 1780000000000,
  "updatedAt": 1780000000000,
  "input": {
    "tagCount": 14703,
    "vectorCount": 14703
  },
  "output": {
    "artifactPath": "VectorStore/jobs/epa-xxx.artifact",
    "basisCount": 46
  }
}
```

状态机：

```text
queued
snapshotting
computing
computed
publishing
published
stale
failed
aborted
```

启动恢复：

```text
computing -> aborted
computed -> eligible for publish
publishing -> inspect staging/version state
published -> cleanup later
failed/stale -> cleanup or requeue
```

---

## 7.4 KB Epoch

引入主数据版本戳：

```text
kv_store.kb_epoch
```

规则：

1. 每次主数据事务成功递增；
2. 派生任务 snapshot 时记录 startEpoch；
3. publish 前读取 currentEpoch；
4. 根据 stale policy 决定 publish / discard / incremental follow-up。

不同派生任务策略：

| 任务 | epoch 变化策略 |
|---|---|
| EPA | 可容忍小幅 stale；超过阈值重算 |
| pairwise full rebuild | 建议严格或版本化 publish 后追加增量 |
| intrinsic | 对共现拓扑敏感，建议严格或阈值控制 |
| matrix-memory-build | 可直接基于当前 active 派生版本重建 |

---

## 8. 新运行时流程

### 8.1 启动流程

旧流程中 EPA 可能在 System Ready 前长时间写库。

新流程：

```text
open DB
→ configure PRAGMA
→ startup health check Level 2
→ if fail: recovery mode
→ load core cache
→ load active derived versions
→ build in-memory matrix
→ start watcher
→ System Ready
→ after cooldown schedule derived refresh
```

关键变化：

1. EPA 不再阻塞启动；
2. full scan 小巴士优先；
3. 派生刷新延迟到系统 ready 后；
4. 启动健康检查失败进入 recovery，而不是继续派生写。

---

### 8.2 小巴士主写流程

```text
watcher/full scan
→ pendingFiles
→ acquire primary-js lease
→ take 50 files
→ embedding
→ transaction write facts
→ update in-memory vector indexes
→ increment kb_epoch
→ scheduleMatrixRebuild(actualTagChanges)
→ release lease
→ continue next batch
```

约束：

```text
primary-js active 时 derived-rust 禁止启动
```

---

### 8.3 派生任务通用流程

```text
DerivedTaskQueue picks job
→ wait quiet window
→ snapshot metadata
→ compute artifact without write lease
→ acquire short publish lease
→ verify epoch/staleness
→ publish version/staging
→ JS checkpoint barrier
→ soft health check
→ load verify
→ release lease
```

---

### 8.4 健康检查流程

#### Level 0：轻量检查

用于热路径：

```sql
SELECT 1;
PRAGMA wal_checkpoint(PASSIVE);
```

#### Level 1：软检查

用于 Rust stage/publish 后：

```sql
PRAGMA wal_checkpoint(FULL or TRUNCATE);
PRAGMA quick_check;
```

失败进入 suspect。

#### Level 2：重开连接复检

```text
pause writes
close better-sqlite3 connection
wait 100-500ms
open new connection
configure PRAGMA
wal_checkpoint
quick_check
```

通过：

```text
dbState=healthy
reload prepared statements/caches
resume queues
```

失败：

```text
dbState=corrupt
stop watcher
block writes
enter recovery/quarantine flow
```

---

## 9. 派生表版本化方案

### 9.1 Pairwise versioned table

新表：

```sql
CREATE TABLE IF NOT EXISTS tag_pair_similarity_v (
    job_id TEXT NOT NULL,
    tag_a INTEGER NOT NULL,
    tag_b INTEGER NOT NULL,
    similarity REAL NOT NULL,
    model_sig TEXT NOT NULL,
    computed_at INTEGER NOT NULL,
    PRIMARY KEY (job_id, tag_a, tag_b)
);

CREATE INDEX IF NOT EXISTS idx_pair_v_job_model
ON tag_pair_similarity_v(job_id, model_sig);

CREATE INDEX IF NOT EXISTS idx_pair_v_job_pair
ON tag_pair_similarity_v(job_id, tag_a, tag_b);
```

active pointer：

```text
kv_store.tag_pair_similarity_active_job = job_id
```

读取流程：

```text
activeJob = kv_store active pointer
SELECT tag_a, tag_b, similarity
FROM tag_pair_similarity_v
WHERE job_id = ?
  AND model_sig = ?
```

publish：

```text
write all rows with job_id
→ health check
→ update active pointer
```

publish 成本极低。

### 9.2 Intrinsic residuals versioned table

```sql
CREATE TABLE IF NOT EXISTS tag_intrinsic_residuals_v (
    job_id TEXT NOT NULL,
    tag_id INTEGER NOT NULL,
    residual_energy REAL NOT NULL,
    neighbor_count INTEGER NOT NULL,
    computed_at INTEGER NOT NULL,
    PRIMARY KEY (job_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_intrinsic_v_job
ON tag_intrinsic_residuals_v(job_id);
```

active pointer：

```text
kv_store.tag_intrinsic_residuals_active_job = job_id
```

### 9.3 EPA versioned cache

可先用 `kv_store`：

```text
epa_basis_cache:<job_id>
epa_basis_cache_active_job = job_id
```

正式读取：

```text
activeJob = epa_basis_cache_active_job
cache = epa_basis_cache:<activeJob>
```

后续可迁移为专表。

---

## 10. Rust API 重设计建议

### 10.1 EPA

现有 Rust EPA 在单个 task 中读取、计算、写 `kv_store`。

新 API：

```text
compute_epa_basis_artifact(db_path, artifact_path, options)
```

要求：

- 只读打开 SQLite；
- 读取 tag vectors；
- 关闭 SQLite；
- 长计算；
- 写 artifact；
- 不写数据库；
- 支持 cancel flag。

publish 由 JS 完成。

### 10.2 Pairwise

新 API：

```text
compute_pairwise_similarities_artifact(db_path, artifact_path, model_sig, options)
```

或：

```text
compute_pairwise_similarities_versioned(db_path, job_id, model_sig, ...)
```

更稳的是 artifact，但考虑数据量大，可分阶段：

#### 过渡方案

Rust 仍写 SQLite，但写 versioned table 的 `job_id`，不改 active pointer。  
JS publish 只更新 active pointer。

#### 最终方案

Rust 输出 artifact，JS/Rust publish import artifact 到 versioned table，最后 JS 更新 active pointer。

### 10.3 Intrinsic

同 pairwise，写 versioned table 或 artifact。

---

## 11. checkpoint 策略

### 11.1 统一原则

最终 checkpoint 只由 JS coordinator 执行。

Rust 内部不执行最终 `TRUNCATE`。

建议：

```text
Rust:
  transaction batches
  no final TRUNCATE
  optionally no checkpoint at all

JS:
  after publish/stage
  wal_checkpoint(FULL/TRUNCATE)
  quick_check
```

### 11.2 为什么

避免：

```text
Rust connection checkpoint
→ JS connection checkpoint
→ JS old connection quick_check
```

导致连接视图竞态。

### 11.3 checkpoint 失败处理

不直接 corrupt：

```text
checkpoint/quick_check fail
→ suspect
→ reopen verify
→ corrupt only if second fail
```

---

## 12. 竞态场景覆盖

### 12.1 小巴士与 matrix rebuild

新流程：

- pendingFiles > 0 时 derived queue 不启动；
- matrix rebuild 只累计 tag changes；
- 小巴士完成后 quiet debounce；
- 派生任务后台运行。

### 12.2 EPA 长计算与小巴士

新流程：

- EPA compute 不持写租约；
- 小巴士可继续写；
- EPA publish 前检查 epoch；
- stale 可丢弃或容忍小 delta。

### 12.3 用户查询与派生 publish

用户查询读取 active pointer 指向的旧版本。  
新版本 publish 只是更新 active pointer，极短原子操作。

### 12.4 malformed transient

新流程：

```text
malformed
→ abort current derived task
→ suspect
→ reopen verify
→ success resume
```

不会继续写后续 intrinsic，也不会立刻判死库。

### 12.5 进程崩溃

job manifest 恢复：

- computing -> aborted；
- computed -> retry publish；
- published -> cleanup；
- old active version remains readable。

### 12.6 大库 publish

版本化表避免大规模 DELETE+INSERT 正式表。  
publish 只更新 active pointer。

---

## 13. 分阶段实施路线图

## P0：止血和正确恢复语义

目标：解决误判、继续写和 checkpoint 竞态。

1. 修改 `checkpointAndAssertDatabaseHealthy()`：
   - 单次失败进入 suspect；
   - close/reopen verify；
   - 二次失败才 corrupt。

2. 修改 `loadPairwiseSimilarities()`：
   - malformed 不再只 warn；
   - abort 当前 matrix rebuild；
   - 调用 suspect handler。

3. 修改 `loadIntrinsicResiduals()`：
   - 同上。

4. 修改 `doMatrixRebuild()`：
   - pairwise 阶段失败不继续 intrinsic；
   - intrinsic 阶段失败不继续 matrix build。

5. 减少 checkpoint 重复：
   - Rust 不做最终 TRUNCATE；
   - JS coordinator 统一 checkpoint。

---

## P1：派生队列与启动顺序

目标：避免 EPA 启动抢跑和长时间阻塞 System Ready。

1. 引入 DerivedTaskQueue。
2. EPA initialize 改为优先加载旧 cache。
3. EPA refresh 延迟到 System Ready 后后台执行。
4. full scan pendingFiles 清零前不跑派生重建。
5. 启动 cooldown。

---

## P2：Job Manifest + 长计算离库

目标：支持 10-50 倍长耗时派生任务。

1. 新增 `VectorStore/jobs/`。
2. EPA 改为 snapshot + artifact + publish。
3. 增加 cancel flag。
4. job 状态可恢复。
5. publish 持短写租约。

---

## P3：版本化派生表

目标：大库下 publish 原子化、旧版本兜底。

1. `tag_pair_similarity_v` + active pointer。
2. `tag_intrinsic_residuals_v` + active pointer。
3. `epa_basis_cache:<job_id>` + active pointer。
4. 读取逻辑切 active version。
5. 后台清理旧版本。

---

## P4：KB Epoch 与增量策略

目标：长计算结果 stale 判断和增量补偿。

1. 主数据事务递增 `kb_epoch`。
2. 派生 job 记录 startEpoch。
3. publish 判断 stale delta。
4. EPA 容忍小 stale。
5. pairwise/intrinsic 支持增量补偿。

---

## 14. 最小可落地改造建议

如果从头开干，建议第一轮不要直接做全部 versioned 表，而是先做 P0 + P1：

### 第一轮必改

- 二阶段健康检查；
- malformed 中止当前派生任务；
- Rust 最终 checkpoint 移交 JS；
- EPA 后台化；
- 派生任务等待 pendingFiles 清零；
- matrix rebuild 每阶段 fail-fast。

### 第一轮收益

- 解决当前日志中的 transient malformed 误判；
- 避免 malformed 后继续写 intrinsic；
- 降低跨连接 checkpoint 竞态；
- 启动更快；
- 小巴士主数据不被 EPA 阻塞。

### 第二轮再做

- job manifest；
- EPA artifact；
- versioned pairwise/intrinsic。

---

## 15. 关键设计结论

1. **业务逻辑已基本通过。**  
   重启后 pairwise、intrinsic、matrix、RAG 都可用，说明数据写入结果本身不是根本错误。

2. **问题本质是流程竞态。**  
   包括跨连接 WAL/checkpoint、健康检查时机、长任务持锁、派生写抢跑。

3. **小巴士不是 bug。**  
   小巴士是主事实表入库机制，应保持最高优先级。

4. **Rust 分批写入仍正确但不充分。**  
   分批解决事务体量，不解决 checkpoint 竞态和 publish 原子性。

5. **健康检查必须二阶段。**  
   单次 quick_check fail 只能进入 suspect，重开连接复检失败才 corrupt。

6. **长计算必须离库。**  
   EPA 若复杂 10-50 倍，绝不能持写租约计算数小时。

7. **派生数据必须版本化。**  
   大库下 active pointer publish 比 DELETE+INSERT 正式表更稳。

8. **JS 应是数据库状态唯一裁决者。**  
   Rust 负责计算和产物，JS 负责 checkpoint、publish、恢复、状态机。

---

## 16. 最终目标流程摘要

```text
启动:
open DB
→ Level-2 health check
→ load old derived versions
→ build memory matrix
→ start watcher
→ System Ready
→ background derived queue
```

```text
小巴士:
pendingFiles
→ 50 files transaction
→ update facts
→ increment kb_epoch
→ accumulate tag changes
```

```text
派生任务:
wait quiet window
→ snapshot
→ compute artifact without DB write lease
→ short publish lease
→ versioned write / active pointer update
→ JS checkpoint
→ quick_check soft
→ load verify
```

```text
异常:
malformed / quick_check fail
→ suspect
→ pause writes
→ close/reopen DB
→ re-check
→ healthy: resume
→ corrupt: stop watcher and recovery mode
```

一句话总结：

> 面向大库的最终架构应是：主数据优先、派生任务后台化、长计算离库、短发布入库、派生数据版本化、健康检查二阶段、JS 统一裁决数据库状态。