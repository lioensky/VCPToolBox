# TagMemo Rust 派生计算、一致性租约、EPA 与 IR 重构重要更新日志

**生成时间：** 2026-06-04 Asia/Shanghai  
**更新范围：** TagMemo 派生任务、SQLite/WAL 一致性、Rust N-API 向量引擎、EPA 基底计算、IR 内生残差、后台派生队列、启动期调度  
**前置报告：** [`TAGMEMO_SQLITE_WRITE_FLOW_REDESIGN_REPORT.md`](TAGMEMO_SQLITE_WRITE_FLOW_REDESIGN_REPORT.md)  
**核心实现：**
- [`KnowledgeBaseManager.js`](../KnowledgeBaseManager.js)
- [`TagMemoEngine.js`](../TagMemoEngine.js)
- [`EPAModule.js`](../EPAModule.js)
- [`rust-vexus-lite/src/lib.rs`](../rust-vexus-lite/src/lib.rs)
- [`config.env.example`](../config.env.example)

---

## 1. 更新摘要

本轮更新是 TagMemo / KnowledgeBase 派生计算体系的一次关键稳定性升级。

更新目标不只是“修一个 SQLite malformed 报错”，而是把原先由 JS 与 Rust 混合抢占 SQLite 写入窗口的派生流程，升级为更接近数据库写协调器的运行模型：

```text
主数据优先
→ Rust 派生写租约门控
→ 二阶段 SQLite 健康检查
→ 派生任务 fail-fast
→ EPA 长计算只读化
→ EPA 短租约发布
→ IR 算法降算力重构
→ Matrix rebuild 后台队列化
```

本轮实际落地了前置报告中 P0/P1 的核心止血目标，并进一步完成了 Rust EPA 算法下沉与 IR 算法重构。

---

## 2. 背景：为什么这次升级重要

前置报告指出，旧问题的本质不是单条 SQL 写坏库，而是多连接 WAL/SHM 视图、Rust 写入、JS 旧连接读取、checkpoint 与健康检查时机叠加造成的竞态。

典型风险路径是：

```text
JS 小巴士批量写入事实表
→ Rust 派生表批量写入
→ Rust/JS 多连接 checkpoint
→ JS 旧连接 quick_check / 派生表读取
→ transient malformed
→ 流程误判或继续写后续派生表
```

这类问题在小库中不显著，但在 2 万级 Tag、大量 full scan、EPA/IR/matrix 同时刷新时，会成为系统稳定性的主要瓶颈。

因此本次更新把重点放在三件事：

1. 谁能写 SQLite；
2. 什么时候能写 SQLite；
3. 写完以后谁来裁决数据库是否健康。

---

## 3. SQLite 一致性与 Rust 写租约系统升级

### 3.1 Rust 写租约成为派生写入入口

[`KnowledgeBaseManager`](../KnowledgeBaseManager.js:26) 现在维护 Rust 写租约状态：

- [`rustWriteLease`](../KnowledgeBaseManager.js:109)
- [`lastJsWriteFinishedAt`](../KnowledgeBaseManager.js:110)
- [`lastRustWriteFinishedAt`](../KnowledgeBaseManager.js:111)

租约授予由 [`requestRustWriteLease()`](../KnowledgeBaseManager.js:556) 负责，释放由 [`releaseRustWriteLease()`](../KnowledgeBaseManager.js:605) 负责。

授予前会检查：

- 数据库是否为 `healthy`；
- 是否已有 Rust 租约；
- JS 小巴士是否正在处理；
- 删除批处理是否正在处理；
- pending deletes 是否为空；
- pending files 是否低于阈值；
- JS 写后 grace 是否结束；
- Rust 写后 cooldown 是否结束；
- 启动后的派生冷却窗口是否结束。

核心判断集中在 [`_canGrantRustWriteLease()`](../KnowledgeBaseManager.js:513)。

### 3.2 JS 主写会尊重 Rust 租约

小巴士主写入口 [`_flushBatch()`](../KnowledgeBaseManager.js:1740) 在发现 Rust 租约存在时，会通过 [`_deferBatchForRustLease()`](../KnowledgeBaseManager.js:628) 延迟执行。

删除批处理入口 [`_flushDeleteBatch()`](../KnowledgeBaseManager.js:1704) 也做了同样门控。

这保证了：

```text
Rust 派生写期间
→ JS 不再直接插入/删除事实表
→ 避免 better-sqlite3 与 rusqlite 同时写 WAL
```

### 3.3 二阶段 SQLite 健康检查

[`checkpointAndAssertDatabaseHealthy()`](../KnowledgeBaseManager.js:336) 不再把单次 SQLite malformed / quick_check fail 直接判定为永久损坏。

新的流程是：

```text
wal_checkpoint(TRUNCATE)
→ quick_check
→ fail: dbHealthState=suspect
→ close/reopen SQLite connection
→ reconfigure PRAGMA
→ checkpoint + quick_check
→ pass: healthy
→ fail: corrupt
```

重开连接复检逻辑在 [`_recoverSuspectDatabaseConnection()`](../KnowledgeBaseManager.js:374)。

这解决了前置报告中最关键的误判问题：单次跨连接 WAL/SHM 瞬态视图异常不再直接进入 corrupt 模式。

---

## 4. TagMemo 派生任务队列与启动顺序升级

### 4.1 启动期不再阻塞派生重算

[`TagMemoEngine.initialize()`](../TagMemoEngine.js:95) 现在冷启动只检测派生缓存状态，不在初始化阶段阻塞 pairwise/EPA/IR 重算。

启动时做的是：

1. 初始化 [`EPAModule`](../EPAModule.js:7)；
2. 加载现有 pairwise；
3. 加载现有 intrinsic residual；
4. 构建内存共现矩阵。

后台刷新延迟到系统 ready 之后。

### 4.2 Post-startup 派生队列

[`schedulePostStartupDerivedRefresh()`](../TagMemoEngine.js:1377) 会在启动冷却窗口后把派生任务放入队列：

- `epa-basis`
- `matrix-rebuild`

队列入口是 [`_enqueueDerivedTask()`](../TagMemoEngine.js:1401)，执行泵是 [`_processDerivedTaskQueue()`](../TagMemoEngine.js:1446)。

队列启动前会通过 [`_getDerivedTaskBlockReason()`](../TagMemoEngine.js:1433) 检查：

- 数据库是否 corrupt/suspect/recovering；
- Rust 租约是否活跃；
- JS 小巴士是否工作中；
- 删除批处理是否工作中；
- pending deletes 是否存在；
- pending files 是否存在。

这使后台派生任务服从主数据写入节奏。

---

## 5. Matrix rebuild 流程一致性升级

[`doMatrixRebuild()`](../TagMemoEngine.js:1265) 现在被组织为严格的阶段链：

```text
申请 tagmemo:matrix-rebuild 写租约
→ recompute pairwise
→ checkpoint + health barrier
→ load pairwise
→ recompute intrinsic residuals
→ checkpoint + health barrier
→ load intrinsic residuals
→ build memory matrix
→ release lease
```

关键变化：

1. pairwise 失败不再继续 IR；
2. IR 失败不再继续 matrix build；
3. 派生表读取 malformed 时可触发二阶段复检；
4. 健康屏障失败会中止本轮派生任务；
5. 新增 follow-up debounce，重建期间到达的新 tag 变更会延后重跑。

pairwise 加载的恢复语义在 [`loadPairwiseSimilarities()`](../TagMemoEngine.js:1028)，IR 加载的恢复语义在 [`loadIntrinsicResiduals()`](../TagMemoEngine.js:1180)。

---

## 6. EPA：从 JS 长计算升级为 Rust 只读计算 + 短租约发布

### 6.1 旧 EPA 的问题

旧 JS EPA 在大库下存在明显问题：

```text
读取所有 tag
→ JS K-Means
→ JS weighted PCA
→ 主线程长时间 CPU 占用
→ 日志、HTTP、定时器、watcher 均可能停顿
```

[`EPAModule.refreshInBackground()`](../EPAModule.js:312) 的注释中已经明确记录了旧 JS K-Means/PCA 在大库下造成主线程长阻塞的风险。

### 6.2 Rust EPA 新流程

Rust EPA 被拆成两阶段：

```text
compute_epa_basis: 只读 SQLite + Rust 内存暂存
publish_epa_basis_cache: 短写事务发布 kv_store.epa_basis_cache
```

JS 调用入口在 [`_recomputeWithRust()`](../EPAModule.js:244)。

Rust 只读计算入口是 [`compute_epa_basis()`](../rust-vexus-lite/src/lib.rs:567)，发布入口是 [`publish_epa_basis_cache()`](../rust-vexus-lite/src/lib.rs:592)。

### 6.3 EPA 新算法：density-residual-sampling

Rust 侧不再做旧式全量 K-Means，而是采用密度残差采样：

1. 计算全局 mean；
2. 用随机投影 bit 构造密度桶；
3. 每个桶保留 residual 最大样本；
4. 按密度与 residual 混合评分选 anchor；
5. 使用多样性衰减选择语义锚；
6. 对 anchor centroid 做加权 PCA/SVD；
7. 生成 basis/mean/energies/labels cache。

核心采样函数是 [`select_epa_density_residual_samples()`](../rust-vexus-lite/src/lib.rs:870)。

新算法在日志中表现为：

```text
algorithm=density-residual-sampling
tags=25854
buckets=4035
anchors=64
samples=1054
basis=52
```

这相比旧 JS 路径显著减少了参与 SVD 的行数，并避免 Node 主线程长时间 CPU 占用。

### 6.4 EPA 发布短租约

EPA 发布通过 [`withRustWriteLease`](../EPAModule.js:291) 申请 `tagmemo:epa-basis-publish`，并设置短 TTL。

这实现了前置报告中的核心原则：

```text
长计算不持写租约
短发布才持写租约
```

---

## 7. Pairwise similarity：边语义底座稳定化

[`compute_pairwise_similarities()`](../rust-vexus-lite/src/lib.rs:697) 负责预计算实际共现 tag pair 的余弦相似度。

核心约束：

- 只计算实际共现 pair，避免全局 N²；
- 单文件 tag 数超过 100 时跳过；
- 使用 `model_sig` 隔离不同 embedding 空间；
- 增量模式跳过已有 pair；
- 低于 `min_similarity` 的 pair 不写入；
- Rust 不再执行最终 TRUNCATE checkpoint，最终裁决交给 JS coordinator。

最终 checkpoint 移交说明见 [`PairwiseSimTask`](../rust-vexus-lite/src/lib.rs:2194)。

JS 触发入口是 [`recomputePairwiseSimilarities()`](../TagMemoEngine.js:1135)。

---

## 8. IR：Intrinsic Residual 算法完全重构

### 8.1 旧 IR 的问题

旧 IR 对每个 tag 都基于邻居矩阵执行局部 SVD：

```text
for each tag:
  collect up to 100 neighbors
  build n × dim matrix
  DMatrix::svd(false, true)
  project tag to top-k basis
  compute residual
```

在大库下，该路径成本极高，近似是：

```text
O(tags × neighbors² × dim)
```

旧实现位置可参考本轮重构前的 [`compute_intrinsic_residuals()`](../rust-vexus-lite/src/lib.rs:667) 调用入口。

### 8.2 新 IR 三档算法

Rust 侧新增三档 IR 后端：

| 档位 | 用途 | 相对旧算法算力 |
|---|---|---:|
| `anchored_gs` | 默认推荐，Residual-Greedy Anchored Gram-Schmidt | 约 5%~10% |
| `centroid` | 极速 fallback，适合大库快速刷新 | 约 1%~3% |
| `svd` | 对照/高成本基准，已 Top-K 降载 | 约 20%~30% |

算法选择由 [`intrinsic_method_from_env()`](../rust-vexus-lite/src/lib.rs:1382) 读取 `TAGMEMO_IR_METHOD` 决定。

### 8.3 Anchored-GS 默认算法

默认算法 [`compute_anchored_gs_residual()`](../rust-vexus-lite/src/lib.rs:1485) 不再对每个节点做稠密 SVD，而是：

1. 按拓扑权重与语义门控筛选 Top-K 邻居；
2. 在当前 residual 上贪心选择解释收益最高的邻居方向；
3. 通过 Gram-Schmidt 去除已选方向；
4. 达到 `max_basis` 或 `min_gain` 后停止；
5. 用最终 residual norm 表示内生残差。

复杂度从近似 `N²D` 降为 `M×B²×D`，默认 `M=48`、`B=4`。

### 8.4 Centroid 极速档

[`compute_centroid_residual()`](../rust-vexus-lite/src/lib.rs:1450) 使用带权邻居质心作为局部已知语义方向。

它牺牲一部分子空间表达能力，但计算量接近 `M×D`，适合极大库或低功耗设备。

### 8.5 SVD 基准档

[`compute_svd_residual()`](../rust-vexus-lite/src/lib.rs:1560) 保留 SVD 路径用于精度对照，但现在也会先经过 Top-K 邻居筛选，因此默认不再等价于旧 `100 neighbors` 全量 SVD。

---

## 9. IR 邻接与语义门控升级

### 9.1 邻接从 Set 升级为带权图

IR 的邻接结构从“是否共现”升级为带权图：

```text
HashMap<tag_id, HashMap<neighbor_id, weight>>
```

构建位置在 [`IntrinsicResidualTask::compute()`](../rust-vexus-lite/src/lib.rs:1601)。

权重来源：

- 同文件共现；
- file_tags position 距离衰减；
- 重复共现累加。

位置衰减由 `TAGMEMO_IR_POSITION_DECAY` 控制，读取位置见 [`env_f64()`](../rust-vexus-lite/src/lib.rs:1701)。

### 9.2 Top-K 截断

候选邻居会按：

```text
topology_weight × semantic_gate
```

排序，并截断到 `TAGMEMO_IR_MAX_NEIGHBORS`。

排序与截断逻辑在 [`IntrinsicResidualTask::compute()`](../rust-vexus-lite/src/lib.rs:1846)。

### 9.3 语义门控

IR 会读取当前模型签名下的 `tag_pair_similarity`，作为边语义质量。

加载位置在 [`IntrinsicResidualTask::compute()`](../rust-vexus-lite/src/lib.rs:1755)。

语义门控函数是 [`semantic_gate()`](../rust-vexus-lite/src/lib.rs:1432)。

默认策略是 Bell/Floor：

```text
低相似度不默认一票否决
保留 semantic floor
保护跨域边缘锚点
```

如果需要强去噪，可设置 `TAGMEMO_IR_SEMANTIC_HARD_FLOOR`。

---

## 10. 配置面升级

根配置模板 [`config.env.example`](../config.env.example) 已新增 TagMemo IR 配置段。

当前事实优先级：

```text
config.env 环境变量 > rag_params.json 部分参数 > 代码默认值
```

新增的关键环境变量：

- `TAGMEMO_IR_METHOD`
- `TAGMEMO_IR_MAX_NEIGHBORS`
- `TAGMEMO_IR_MAX_BASIS`
- `TAGMEMO_IR_MIN_NEIGHBORS`
- `TAGMEMO_IR_POSITION_DECAY`
- `TAGMEMO_IR_SEMANTIC_GATE_ENABLED`
- `TAGMEMO_IR_SEMANTIC_PEAK`
- `TAGMEMO_IR_SEMANTIC_SIGMA`
- `TAGMEMO_IR_SEMANTIC_FLOOR`
- `TAGMEMO_IR_SEMANTIC_HARD_FLOOR`
- `TAGMEMO_IR_MIN_GAIN`

JS 侧触发 IR 时会读取 [`rag_params.json`](../rag_params.json) 的 `KnowledgeBaseManager.intrinsicResidual`，并把 `maxBasis`、`minNeighbors` 与 [`modelSig`](../TagMemoEngine.js:35) 传给 Rust。

调用位置是 [`recomputeIntrinsicResiduals()`](../TagMemoEngine.js:1330)。

---

## 11. 实际运行链路

当前一次后台派生刷新大致为：

```text
System Ready
→ startup cooldown
→ derived queue starts epa-basis
→ Rust computeEpaBasis read-only
→ short lease publish EPA cache
→ derived queue starts matrix-rebuild
→ acquire tagmemo:matrix-rebuild lease
→ Rust pairwise sim
→ JS checkpoint + health barrier
→ load pairwise
→ Rust intrinsic residuals
→ JS checkpoint + health barrier
→ load intrinsic residuals
→ JS memory matrix rebuild
→ release lease
```

这条链路对应：

- [`schedulePostStartupDerivedRefresh()`](../TagMemoEngine.js:1377)
- [`_processDerivedTaskQueue()`](../TagMemoEngine.js:1446)
- [`doMatrixRebuild()`](../TagMemoEngine.js:1265)
- [`_withRustWriteLease()`](../TagMemoEngine.js:1106)
- [`requestRustWriteLease()`](../KnowledgeBaseManager.js:556)

---

## 12. 当前仍保留的边界与后续建议

本轮已经完成前置报告中的 P0/P1 主要目标，但仍未完全实现 P2/P3/P4。

仍建议后续继续推进：

1. 派生表版本化；
2. `job_id` active pointer；
3. EPA artifact / job manifest；
4. pairwise / intrinsic artifact 或 versioned table；
5. KB epoch；
6. stale policy；
7. AdminPanel 对 IR 档位与 EPA 后台刷新参数的可视化控制。

当前仍直接写正式表：

- `tag_pair_similarity`
- `tag_intrinsic_residuals`
- `kv_store.epa_basis_cache`

这在短中期已经通过租约、健康屏障、二阶段复检显著降低风险，但大库最终形态仍应走“版本化派生表 + active pointer”。

---

## 13. 工程效果总结

本轮更新带来的直接收益：

1. **启动更稳。**  
   EPA 和 matrix 派生刷新不再抢跑系统启动期 full scan。

2. **写入更稳。**  
   Rust 派生写入必须经过 JS 租约系统，JS 主写与 Rust 写不再直接撞 WAL。

3. **健康判断更稳。**  
   单次 malformed 不再直接判死库，而是进入 suspect 并重开连接复检。

4. **派生链路更稳。**  
   pairwise / intrinsic / matrix 每阶段都有健康屏障，失败即中止，不再带病继续写。

5. **EPA 算法更适合大库。**  
   长计算下沉 Rust，只读执行；发布阶段短事务写入。

6. **IR 算法计算量大幅下降。**  
   默认 `anchored_gs` 预计约为旧 SVD 算力的 5%~10%，同时保留 `centroid` 与 `svd` 三档切换。

7. **可观测性增强。**  
   EPA Rust summary、IR progress、matrix progress、event loop watchdog、租约等待原因均可输出结构化日志。

---

## 14. 推荐生产配置

大多数用户建议保持：

```env
TAGMEMO_IR_METHOD=anchored_gs
TAGMEMO_IR_MAX_NEIGHBORS=48
TAGMEMO_IR_MAX_BASIS=4
TAGMEMO_IR_MIN_NEIGHBORS=3
TAGMEMO_IR_SEMANTIC_GATE_ENABLED=true
TAGMEMO_IR_SEMANTIC_HARD_FLOOR=-1.0
KNOWLEDGEBASE_DERIVED_STARTUP_COOLDOWN_MS=300000
KNOWLEDGEBASE_EPA_BACKGROUND_RECOMPUTE=false
```

如果需要强制 EPA 重新训练：

```env
KNOWLEDGEBASE_EPA_BACKGROUND_RECOMPUTE=true
```

如果是极大库、低功耗设备或需要快速刷新 IR：

```env
TAGMEMO_IR_METHOD=centroid
TAGMEMO_IR_MAX_NEIGHBORS=32
```

如果需要做算法对照：

```env
TAGMEMO_IR_METHOD=svd
TAGMEMO_IR_MAX_NEIGHBORS=48
TAGMEMO_IR_MAX_BASIS=4
```

---

## 15. 最终结论

这次更新把 TagMemo 派生计算从“能跑的大库实验路径”推进到了“可控、可恢复、可观测、可继续扩展”的工程路径。

一句话概括：

> TagMemo 的派生计算体系已经从 JS 主线程重计算 + Rust 直接写表，升级为 Rust 后台计算、JS 统一租约裁决、SQLite 二阶段健康检查、EPA 只读长计算短发布、IR 低算力多档算法的稳定化架构。