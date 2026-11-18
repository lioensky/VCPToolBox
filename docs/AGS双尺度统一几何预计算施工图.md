# AGS 双尺度统一几何预计算施工图

> 版本：草案 v1 ｜ 日期：2026-10-18 ｜ 起草：Kerr ｜ 决策：莱恩
> 范围：`rust-vexus-lite` 预计算层、SQLite schema、`TagMemoEngine.js` 调度链、相关测试

---

## 0. 目标与原则

用**同一个算子 Anchored Greedy Gram-Schmidt（AGS）**在两个尺度上完成全部几何预计算：

| 尺度 | 模式 | 输入 | 产物 | 替代对象 |
|---|---|---|---|---|
| 局部 | `Explain`（有目标向量） | Tag 自身 + 共现邻居 | `raw_residual_ratio` → `v9_anchor_gain` | IntrinsicResidualTask |
| 全局 | `Span`（无目标向量） | 全库高分 Tag 候选池 | K 个正交主题面 + 覆盖率曲线 | EpaBasisTask + EpaPublishTask |
| — | 内联 | 邻居 Gram 矩阵 | 现场余弦（语义门控） | PairwiseSimTask + 两张 pair 表 |

设计原则：

1. **精度 = 1 − 残差能量比**。局部与全局用同一个量度量，用同一条停止规则截断。
2. **前缀嵌套**：贪心 GS 的前 k 个面与 K 无关，只需计算一次 K_max，后续按需截取。
3. **单读、单算、单发布**：一次读事务、一个任务、一个写事务。
4. **零第二份全库向量**：直接从常驻 usearch 索引按 ID 读取。
5. **硬切换**：不保留旧表和旧接口的兼容层。

---

## 1. 调研结论（现状事实）

### 1.1 调度链
`TagMemoEngine.doMatrixRebuild()` 的执行顺序：
1. `recomputePairwiseSimilarities()`：**每次都执行**；
2. `recomputeIntrinsicResiduals()`：**仅在** `reason==='threshold'`、强制选项或环境变量开启时执行；
3. `rebuildMemoArtifact()`。

`requestActiveFullTraining()` 会以 `fullRebuildPairwise + forceIntrinsicResiduals` 进入同一链路。

**隐患**：普通增量重建会刷新 pairwise，但不会刷新残差。结果是 `anchor_gain` 跟不上图的变化，虫洞判定依据的是过期的锚增益。

### 1.2 EPA 生产停摆
- `computeEpaBasis` 和 `publishEpaBasisCache` 只在 `tests/kbmNativeLifecycle.test.js` 中被调用，**生产代码中没有触发点**。
- `memo_pipeline::analyze_epa` 读取 `kv_store.epa_basis_cache`，在缓存缺失时返回 `cache_available=false`、`logic_depth=0`、`entropy=1`。
- `TagMemoEngine.getEPAAnalysis()` 是一个返回固定值 0.5 的桩函数。
- 结论：EPA 的下游信号目前基本处于失效状态。

### 1.3 无调用方的 napi 接口（死代码）
`computeSvd`、`computeOrthogonalProjection`、`computeHandshakes`、`project`：在 JS 侧没有任何调用，只出现在 `index.d.ts` 中。Rust 管线内部另有独立实现（`memo_pipeline::orthogonal_projection` / `analyze_handshakes`）。

### 1.4 Pairwise 的全部消费方
| 位置 | 用途 | 处置 |
|---|---|---|
| `lib.rs::IntrinsicResidualTask` | 邻居语义门控 | 改为 Gram 内联 |
| `memo_artifact_builder::load_pairwise` → `semantic_gain` | 有序共现边的语义增益；**生产中已开启**（`rag_params.orderedCooccurrence.semanticGainEnabled=1`） | 改为构建时从 usearch 读取后内联计算 |
| `pairwise_maintenance.rs` + `KBM._cleanupStalePairwiseSimilarityModels()` | 启动时清理旧模型签名 | 整体删除 |
| `tag_consistency.rs:382` | 一致性重建时清表 | 删除对应语句 |
| `scripts/tagmemo_unified_geometry_probe.js` | 离线探针 | 改为内联余弦 |
| `ecosystem.config.js` 注释 | 历史说明 | 更新 |

### 1.5 Schema 与依赖版本
- 表：`tag_pair_similarity`、`tag_pair_similarity_status` 及 4 个索引。
- 触发器：`trg_tags_vector_version`（其中两条 DELETE pair 语句）、`trg_tags_delete_pair_cache`、`GENERATION_SQL` 中的 5 个 `tagmemo_pairwise_fact_generation` 触发器。
- 派生版本键：`derived_pairwise`、`derived_intrinsic`、`derived_epa`，并按表动态生成 `trg_{table}_{event}_derived` 触发器。
- **3 个硬编码依赖校验点**（必须同步修改）：
  - `rivermemo_topology_v3.rs::load_artifact_with_connection`（约 853 行）
  - `knowledge_runtime.rs` manifest 查询（约 1980 行）
  - `memo_artifact_builder.rs::run_build` 中的 `DerivedDependencies::capture`（约 626 行）
- 测试夹具：`memo_thinking.rs:480`、`storage.rs:1150`。

---

## 2. 目标架构

```
facts 事务提交 (tags / file_tags)
        │  memo_tag_facts++
        ▼
GeometryTask  ── 读事务：generation + deps + file_tags 流
   │  Pass1 邻接 CSR + 支持度
   │  Pass2 局部 AGS(Explain)  rayon，按 tag_id 排序
   │  Pass3 全局 AGS(Span)     候选池 M → K_max 面
   │  Pass4 覆盖率流式统计      → K_eff
   ▼
单写事务：tag_intrinsic_residuals(+status) + kv_store.epa_basis_cache
          + tagmemo_artifacts(asset_type='unified_geometry')
        │  derived_geometry++
        ▼
rebuildMemoArtifact  依赖 = {memo_tag_facts, derived_geometry}
```

**调度规则**：`doMatrixRebuild` 固定执行 `geometry → artifact`，消除残差过期隐患。

---

## 3. 算子规范：`anchored_gs`

新模块 `src/memo_geometry.rs`。

```rust
pub(crate) enum AgsTarget<'a> { Explain(&'a [f64]), Span }
pub(crate) struct AgsCandidate { pub id: i64, pub prior: f64 }
pub(crate) struct AgsTrace {
    pub picked: Vec<(i64, f64)>,     // (id, gain)
    pub basis: Vec<Vec<f64>>,        // 正交单位基
    pub residual_norm: Option<f64>,  // Explain 专有
}
```

单步选择规则：
- 候选 u 先对已选基做正交化，记 `orth=‖u⊥‖`，过滤 `orth ≤ 1e-6`。
- `gain = Explain ? |⟨r, û⊥⟩| : orth`。
- `score = gain × orth × prior`；分数相同时取 ID 较小者，保证可复现。
- `gain < min_gain` 时停止。

### 3.1 局部模式的 Gram 空间加速（推荐实现）
目标 t 与 n 个邻居先计算一次 `(n+1)×(n+1)` Gram 矩阵 G（单位向量的点积）。此后所有 GS 步骤都在 n 维系数空间中进行，不再触碰 3072 维向量：
- 第一行 `G[0][j]` 就是 t 与邻居 j 的余弦，**语义门控直接免费获得**；
- 残差模长平方 `‖r‖² = 1 − Σ c_k²`，其中 c_k 是 t 在已选正交基上的系数。

复杂度：每个 Tag 需要 `O(n²·dim)` 的 Gram 计算加 `O(K·n²)` 的低维 GS。以 n=48 估算，每个 Tag 约 7M flops，3 万个 Tag 用 rayon 并行在秒级完成。

### 3.2 停止规则（两个尺度共用）
- 局部：沿用 `max_basis`（默认 4）与 `min_gain`，输出 `raw_residual_ratio = ‖r‖`。
- 全局：先用 Span 模式算到 `K_max`，再根据覆盖率曲线截断：
  `K_eff = min{k : 1−coverage[k] ≤ ε  或  coverage[k]−coverage[k−1] < δ}`，并满足 `K_eff ≥ K_sem`。
  前缀嵌套性保证这样截断与直接计算 K_eff 的结果完全一致。

---

## 4. GeometryTask 详细流程

napi 入口（挂在 `VexusIndex` 上）：
```rust
#[napi]
pub fn compute_memo_geometry(&self, db_path: String, model_sig: String, config_json: String)
    -> AsyncTask<TrackedTask<GeometryTask>>
// Task 持有 index: Arc<IndexHandle>, content_revision: Arc<AtomicU64>, dimensions
```

### Pass 0：快照
- 读事务内：`read_generation`、`DerivedDependencies::capture(&["memo_tag_facts"])`。
- 记录 `rev0 = content_revision`。

### Pass 1：邻接 CSR（复用现有 flush 语义）
- 流式读取 `SELECT file_id, tag_id, COALESCE(position,0) FROM file_tags ORDER BY file_id, position`。
- 跳过 Tag 数为 1 或超过 100 的文件；按位置差做指数衰减（`positionDecay`），对称累加。
- 同时累加 `support[tag] = Σ w`，并计算 `content_digest`，用于生成 artifact_sig。
- 输出结构由 `HashMap<i64, HashMap<i64,f64>>` 改为**排序后的 CSR**，以降低内存占用。

### Pass 2：局部 AGS
- 用 `par_iter` 遍历 Tag ID 有序列表。每个 Tag：
  1. 按 `w` 取 Top `max_neighbors`；
  2. 从 usearch 批量读取 `1+n` 个向量并单位化；按 ID 分批，短时持有读锁，每批读取后立即释放；
  3. 计算 Gram 矩阵，得到 `sim_j = G[0][j]` 和 `prior_j = ln(1+w_j) × gate(sim_j)`；
  4. 执行 Explain 模式 AGS，得到 `raw_residual_ratio`，再映射为 `v9_anchor_gain`（公式不变）。
- 状态与现有实现一致：`computed`、`insufficient_neighbors`、`failed`。
- 同时累加全库单位向量之和，用于计算 `mean`。

### Pass 3：全局 AGS（主题面）
- 候选：`support ≥ min_support` 且状态为 `computed` 的 Tag。
  `prior = support^a × raw_residual^b`，默认 `a=0.65, b=0.35`。
- 按 prior 取 Top `M`（默认 512），读取向量后执行 `x = normalize(unit(t) − mean)`。
- 执行 `anchored_gs(Span, K_max, min_gain_global)`，label 取锚点 Tag 的名称。

### Pass 4：覆盖率与能量
- 流式遍历全部 Tag，计算 `x = unit(t) − mean`：
  `E_total += ‖x‖²`，并对每个 k 累加 `captured[k] += ⟨x, axis_k⟩²`。
- 由此得到 `energies[k] = captured[k]`、`coverage[k]`（累计值），以及 `K_eff`。
- 复杂度为 `O(N·K_max·dim)`，可用 rayon 分片后归约。

### Pass 5：一致性校验与发布
- 若 `content_revision != rev0`，则作废结果并返回 `revision_conflict`，由 JS 侧重新入队。
- 在 `publication_gate::acquire` 下执行 `with_registered_write`：
  1. `ensure_generation(source_generation)` 与 `dependencies.ensure_current`；
  2. `DELETE FROM tag_intrinsic_residuals`，然后重新写入（列定义不变）；
  3. 状态表按 artifact 替换；
  4. 对 `kv_store` 执行 `INSERT OR REPLACE` 写入 `epa_basis_cache`（结构见 §5）；
  5. 登记 `tagmemo_artifacts`，`asset_type='unified_geometry'`；清理同类型的旧签名记录。
- 结果返回签名、K_eff、覆盖率摘要和各 Pass 的耗时。

### 4.1 向量来源与降级
- 优先通过 `index.get(id)` 读取。usearch 中存储的是写入时的原始向量，读出后必须单位化。
- 若 usearch 未命中（索引尚未追上 facts），按 ID 分批从 `tags.vector` BLOB 中补读，并计入 `vector_fallback_count`。
- **待核实项**：JS 侧是否保证 `apply_tag_delta` 在派生任务入队之前完成。若无法保证，就依赖上述降级路径。

---

## 5. 输出结构

### 5.1 `tag_intrinsic_residuals`
列定义不变。`algorithm_version` 改为 `unified_geometry_ags_v1`；`v8_3_compat_gain` 继续写入 NULL。

### 5.2 `kv_store.epa_basis_cache`（向后兼容扩展）
```json
{
  "basis": ["<b64 f32>", ...],      // 长度 = K_eff
  "mean": "<b64 f32>",
  "energies": [..],                 // 每个面的绝对能量
  "labels": ["VCP架构", ...],       // 真实 Tag 名
  "anchorTagIds": [..],
  "coverage": [..],                 // 累计覆盖率，单调不减
  "totalEnergy": 0.0,
  "kSem": 8,
  "kMax": 32,
  "epaAlgorithm": "ags-global-anchor",
  "artifactSig": "...",
  "tagCount": 0,
  "timestamp": 0
}
```
`analyze_epa` 的 `EpaCache` 反序列化会忽略未知字段，**旧读取路径无需改动即可工作**。

### 5.3 `analyze_epa` 小改动（Phase 4）
- 熵只在前缀 `kSem` 上计算，`log2(kSem)` 作为归一化分母，与 K_eff 解耦。
- 新增 `out_of_domain = ‖q − mean − Σ⟨q−mean, b_k⟩ b_k‖ / ‖q − mean‖`，写入 `EpaOutput`，供 Spike 抑制使用（第一版只输出，不参与计算）。

---

## 6. Schema 迁移（schema_version +1）

在 `initialize_schema` 中，当版本升级时执行：
```sql
DROP TRIGGER IF EXISTS trg_tags_delete_pair_cache;
DROP TRIGGER IF EXISTS trg_pairwise_tags_insert_generation;
DROP TRIGGER IF EXISTS trg_pairwise_tags_vector_generation;
DROP TRIGGER IF EXISTS trg_pairwise_tags_delete_generation;
DROP TRIGGER IF EXISTS trg_pairwise_file_tags_insert_generation;
DROP TRIGGER IF EXISTS trg_pairwise_file_tags_delete_generation;
DROP TRIGGER IF EXISTS trg_tag_pair_similarity_INSERT_derived;  -- 及 UPDATE/DELETE
DROP TRIGGER IF EXISTS trg_tag_intrinsic_residuals_INSERT_derived; -- 及 UPDATE/DELETE，下面重建
DROP TRIGGER IF EXISTS trg_kv_store_INSERT_derived;               -- 及 UPDATE/DELETE，下面重建
DROP TABLE IF EXISTS tag_pair_similarity_status;
DROP TABLE IF EXISTS tag_pair_similarity;
DELETE FROM kv_store WHERE key IN ('tagmemo_pairwise_fact_generation','epa_basis_cache');
DELETE FROM kbm_runtime_meta WHERE key IN ('derived_pairwise','derived_intrinsic','derived_epa');
INSERT OR IGNORE INTO kbm_runtime_meta(key,value) VALUES ('derived_geometry','0');
DELETE FROM tagmemo_artifacts WHERE asset_type IN ('pairwise_similarity','intrinsic_residual');
```
- 重写 `trg_tags_vector_version`：只保留 `vector_version` 自增，删除 pair 相关语句。
- 从 `SCHEMA_SQL` 中移除两张表及其索引的建表语句。
- 派生触发器循环改为：`(tag_intrinsic_residuals, derived_geometry)` 与 `(kv_store WHEN key='epa_basis_cache', derived_geometry)`。
  同一写事务中两张表都会递增版本号，这是预期行为，只要版本号发生变化即可。
- **迁移副作用**：旧 RiverMemo artifact 的依赖数不再匹配，首次启动时会判定为不兼容并触发完整重建，与硬切换的预期一致。

依赖校验 3 处统一修改为：
```sql
d.dependency_key IN ('memo_tag_facts','derived_geometry')) = 2
```
建议抽取为 `storage::MEMO_ARTIFACT_DEPENDENCIES: &[&str]` 常量，三处共同引用，避免以后再次出现漂移。

---

## 7. Artifact 构建改造

- `rebuild_memo_artifact` 改为同时传入 `self.index.clone()`。
- 删除 `load_pairwise`。`semantic_gain` 的余弦改为：先收集所有有序共现 pair 中涉及的 Tag ID，批量从 usearch 读取并单位化，在构建时现场计算点积。按文件分组计算，每个文件最多 100 个 Tag，单文件内 Gram 计算量很小。
- `DerivedDependencies::capture(&["memo_tag_facts","derived_geometry"])`。
- `source_artifact_sig` 中的 `residual_sig` 改为 geometry 的 artifact_sig。

---

## 8. JS 改造

**TagMemoEngine.js**
- 删除 `recomputePairwiseSimilarities`、`recomputeIntrinsicResiduals`。
- `_intrinsicResidualConfig()` 重命名为 `_geometryConfig()`，读取 `rag_params.KnowledgeBaseManager.geometry`；若该字段不存在，则回退到 `intrinsicResidual` 字段。
- 新增 `recomputeGeometry()`，调用 `tagIndex.computeMemoGeometry(dbPath, modelSig, JSON.stringify(cfg))`。遇到 `revision_conflict` 时进行一次有界重试。
- `doMatrixRebuild`：`geometry → artifact`。删除 `fullRebuildPairwise`、`forceIntrinsicResiduals` 选项；`requestActiveFullTraining` 相应简化。
- `intrinsicResidualArtifact` 改名为 `geometryArtifact`。

**KnowledgeBaseManager.js**
- 删除 `_cleanupStalePairwiseSimilarityModels()` 及其在启动流程中的调用（约 576 行）。
- `recomputeIntrinsicResiduals()` 包装改为 `recomputeGeometry()`。

**modules/knowledgeBase/memoryProfiler.js**：同步修改字段名。

**rag_params.json** 新增配置节：
```json
"geometry": {
  "local":  { "maxNeighbors": 48, "minNeighbors": 3, "maxBasis": 4, "minGain": 0.015,
              "positionDecay": 0.15,
              "semanticGate": { "enabled": true, "peak": 0.65, "sigma": 0.25, "floor": 0.35, "hardFloor": -1 },
              "anchorGain": { "base": 0.75, "scale": 1.25, "gamma": 1.0, "min": 0.5, "max": 2.0 } },
  "global": { "candidatePool": 512, "minSupport": 3, "supportExponent": 0.65, "residualExponent": 0.35,
              "kMax": 32, "kSem": 8, "epsilon": 0.10, "kneeDelta": 0.005, "minGain": 0.02 }
}
```

**index.d.ts**：由 napi 构建重新生成。

---

## 9. Rust 删除清单（lib.rs 及其他）

- 结构体与 Task：`PairwiseSimResult`、`PairwiseSimTask`、`IntrinsicResidualResult`、`IntrinsicResidualTask`、`IntrinsicResidualConfig*`、`IntrinsicResidualMethod`（centroid 和 svd 分支一并退休）、`EpaBasisResult`、`EpaBasisTask`、`EpaPublishTask`、`EpaPendingCache`、`EpaDensityBucket`、`EpaAnchorCandidate`。
- 函数：`select_epa_density_residual_samples`、`epa_projection_bit`、`epa_density_key`、`epa_residual_norm`、`compute_centroid_residual`、`compute_svd_residual`、`compute_anchored_gs_residual`（迁入 `memo_geometry` 并重写）、`residual_norm_from_basis`、`semantic_gate`（迁入 `memo_geometry`）。
- napi 方法：`compute_svd`、`compute_orthogonal_projection`、`compute_handshakes`、`project`、`compute_epa_basis`、`publish_epa_basis_cache`、`compute_intrinsic_residuals`、`compute_pairwise_similarities`。
- 字段：`VexusIndex.epa_pending_cache`。
- 结构：`SvdResult`、`OrthogonalProjectionResult`、`HandshakeResult`、`ProjectResult`。
- 模块：`pairwise_maintenance.rs` 整体删除；同时删除 `knowledge_runtime` 中对应的 napi 导出 `cleanupStalePairwiseSimilarityModels`（需核实具体位置）。
- `tag_consistency.rs:382`：删除两条 pair 表 DELETE 语句，并加入 `DELETE FROM kv_store WHERE key='epa_basis_cache'`。
- `lib.rs` 预计瘦身约 1500 行。

---

## 10. 测试计划

**删除**：`tests/tagPairwiseIncrementalPersistence.test.js`。

**修改**：
- `kbmNativeLifecycle.test.js`：pairwise 与 EPA 生命周期用例改为 `computeMemoGeometry`，验证关闭时拒绝新任务、代际冲突时拒绝发布。
- `nativeMemoManifestCompatibility.test.js`：用 geometry 替代 pairwise 作为前置步骤。
- `newTagIngestionDerivedInvalidation.test.js`：删除 pair 表相关断言，改为验证 `memo_tag_facts` 递增会使 artifact 失效。
- `storage.rs`、`schema.rs`、`memo_thinking.rs` 中的夹具：依赖键改为新键集合。

**新增**（`memo_geometry` 单元测试与 JS 集成测试）：
1. **前缀嵌套**：K=8 与 K_max=32 截取前 8 个面，basis 逐位相同。
2. **确定性**：在 rayon 不同线程数下运行两次，`artifact_sig` 与全部数值一致。
3. **覆盖率单调**：`coverage` 不减且不超过 1；Span 模式下主题面两两正交（误差小于 1e-6）。
4. **Gram 等价**：Gram 空间 AGS 与高维直接 AGS 的残差差异小于 1e-9。
5. **局部语义**：构造“可被邻居完全线性表示”的 Tag，残差接近 0；构造“与邻居正交”的 Tag，残差接近 1。
6. **ε 截断**：给定合成数据的本征维度 d，K_eff 能在 d 附近停止。
7. **代际冲突**：计算期间提交 facts 或执行 `apply_tag_delta`，发布被拒绝。
8. **迁移**：旧 schema 数据库升级后，旧表和触发器不存在，`derived_geometry` 存在，旧 artifact 被判定为不兼容。
9. **端到端**：在 `geometry → artifact` 之后执行 `run_memo_pipeline`，`EpaOutput.cache_available == true`。

**性能基准**（使用真实库，记录到 ChangeLog）：总耗时、各 Pass 耗时、RSS 峰值，与旧三任务串行的总耗时对比。

---

## 11. 施工阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | 核实遗留项：JS 侧 delta 与派生任务的先后顺序；`cleanupStalePairwiseSimilarityModels` 的导出位置；VCPChat 等其他仓库是否调用死接口 | 形成核实记录 |
| P1 | 新建 `memo_geometry.rs`：实现 `anchored_gs` 双模式、Gram 加速、停止规则，附单元测试 1、3、4、5、6 | `cargo test` 通过 |
| P2 | 实现 `GeometryTask` 与 napi 接口、发布事务；Artifact 构建切换到内联语义增益 | 测试 2、7、9 通过 |
| P3 | Schema 迁移、依赖常量抽取、3 处校验点同步修改；按 §9 删除代码 | 测试 8 通过，`cargo clippy` 无告警 |
| P4 | JS 调度链改造、rag_params 新增配置节、`analyze_epa` 的 `kSem` 与越界度 | 全量 `npm test` 通过 |
| P5 | 真实库基准测试与回归评估（Spike 输出、RiverMemo Top-K 对比抽样） | 基准记录写入 ChangeLog |

---

## 12. 风险与对策

| 风险 | 对策 |
|---|---|
| 主题面能量效率低于 SVD（Eckart–Young） | 用多几个面补偿；记录 coverage 曲线，可直接看到实际代价 |
| 长尾专名成为主题面 | 设 `minSupport` 阈值；prior 中计入 support 指数 |
| usearch 与 SQLite 短暂不一致 | revision 双检加 BLOB 降级补读 |
| Artifact 构建内联余弦增加耗时 | 按文件分组，每文件不超过 100 个 Tag，复杂度为 O(Σ n_f²·dim)，与旧 Pairwise 的计算量同阶，但省去了读写 SQLite 的往返 |
| 硬切换导致首次启动全量重建 | 属于预期行为；在 ChangeLog 中提示首次启动耗时 |
| `semanticGainEnabled` 的数值行为发生变化 | 旧路径对缺失的 pair 使用 `lowSimFallback`；新路径总能得到真实余弦，属于修正。在 P5 回归中进行对比 |

---

## 13. 已拍板与待确认

- ✅ AGS 作为唯一算子，覆盖局部与全局两个尺度
- ✅ Pairwise 退休，改为内联计算
- ✅ EPA 的密度桶和 SVD 退休，由全局 AGS 主题面替代
- ✅ 精度由 ε、δ、K_max 控制，熵锁定在前缀 K_sem
- ✅ 硬切换
- ⏳ 语义门控：默认**保留内联门控**（零存储成本，可兜底未按提示词规范书写的旧日记）
- ⏳ 触发时机：默认 `facts → geometry → artifact` 单链，并沿用现有阈值调度


## 可能存在的暗礁
### ⚠️ 暗礁 1：`GeometryTask` 缺少「缓存命中短路（Short-circuit）」，会导致每次重启误触发 `derived_geometry++` 并作废 `rivermemo_artifacts`
* **问题推演**：
  在 §6 中，你设置了触发器：当 `tag_intrinsic_residuals` 或 `kv_store(epa_basis_cache)` 发生 `INSERT/UPDATE/DELETE` 时，`kbm_runtime_meta.derived_geometry` 自增 1。
  而在旧版 `IntrinsicResidualTask`（`lib.txt` 1545 行）和 `PairwiseSimTask`（1746 行）中，都有一段**预检短路逻辑**：如果根据 `content_digest + model_sig + config_hash` 算出的 `artifact_sig` 在数据库中已经是 `ready` 状态，则直接返回缓存命中，**不执行写事务**。
  在你的施工图 §4 中，Pass 0 $\to$ Pass 5 似乎是无条件执行写事务的。如果冷启动 5 分钟后的 `schedulePostStartupDerivedRefresh` 触发了 `GeometryTask`，哪怕全库没有任何新文件或新 Tag，只要 Pass 5 执行了 `DELETE` + `INSERT`，就会触发 `derived_geometry++`，进而导致冷启动刚刚恢复的 `rivermemo_artifacts` 因依赖版本失配 (`DERIVED_DEPENDENCY_CONFLICT`) 而被迫全量重算！
* **修正方案**：
  在 **Pass 1 结束算出 `artifact_sig` 后（进入 Pass 2 之前）**，在读事务内检查：
  1. `tagmemo_artifacts` 中是否存在 `asset_type = 'unified_geometry' AND artifact_sig = ?1 AND status = 'ready'`；
  2. `kv_store` 中是否存在 `key = 'epa_basis_cache'`。
  若二者皆满足且未开启 `force_recompute`，**直接短路返回 `skipped_count = tag_count`**，不触碰写事务，从而保护 `derived_geometry` 代际稳定。

### ⚠️ 暗礁 2：Pass 2 / Pass 3 / Pass 4 的向量读取方式——切勿在 Rayon `par_iter` 内高频争用 `usearch` 锁或按邻居重复读取
* **问题推演**：
  施工图 §4 写道：
  > 用 `par_iter` 遍历 Tag ID 有序列表。每个 Tag：从 usearch 批量读取 `1+n` 个向量并单位化；按 ID 分批，短时持有读锁，每批读取后立即释放……
  这里有两个严重隐患：
  1. **重复读取与重复归一化放大 48 倍**：共现图是高度偏斜的无标度网络，高频 Hub Tag 会作为数千个 Tag 的邻居出现。如果每个 Tag 在 `par_iter` 中各自去 `usearch.get(neighbor_id)` 并归一化，同一个 Hub Tag 会被从 `usearch` 拷贝并归一化数千次（$30000 \times 49 \approx 147$ 万次 `usearch.get`）。
  2. **跨线程 fallback 与读写锁饥饿**：SQLite 的 `rusqlite::Connection` 是 `!Sync` 的，无法在 Rayon 的 `par_iter` 闭包内直接执行 BLOB 降级补读；而且多线程高频抢占 `IndexHandle` 的 `RwLock` 会阻塞前台摄取的写锁并导致 `content_revision` 冲突。
* **修正方案**：
  在 Pass 1 结束后，你已经拿到了紧凑的活跃 `tag_ids` 列表（按 ID 排序，记为 $V$ 个，通常几千到几万）。
  在进入 Pass 2 的 `par_iter` **之前**：
  1. 持一次 `index.read()` 锁，顺序遍历这 $V$ 个唯一 Tag ID，调用 `index.get` 读出并一次性完成单位化（同时顺便就累加好了全库 `mean`！）；
  2. 若有个别 ID 未命中 `usearch`，此时仍在单线程读事务内，直接从 SQLite `tags` 表补读 BLOB；
  3. 释放 `index.read()` 锁和 SQLite 读事务！
  4. 此后 **Pass 2（局部 AGS）、Pass 3（全局 Span）、Pass 4（覆盖率统计）全部在纯内存切片上无锁并行运行**，每个 Tag 向量只读一次、只归一化一次，且在计算结束后立即随局部变量 `drop` 释放，不会产生任何常驻的第二份向量内存！

### ⚠️ 暗礁 3：`memo_artifact_builder` 中获取 `geometry` 签名的表来源（§7）
* **问题推演**：
  施工图 §7 提到：`source_artifact_sig` 中的 `residual_sig` 改为 geometry 的 `artifact_sig`。
  注意在现有 `memo_artifact_builder.txt`（第 157 行）中，`residual_sig` 是从 `SELECT ... artifact_sig FROM tag_intrinsic_residuals WHERE model_sig = ?1` 的第一行顺手读出来的。
  但在小型知识库或测试用例（如只有 2 个 Tag 共现，小于 `min_neighbors = 3`）中，所有 Tag 的状态都是 `insufficient_neighbors`，此时 **`tag_intrinsic_residuals` 数值表是空的（0 行）**，会导致 `residual_sig` 读出空字符串 `""`！
* **修正方案**：
  在 `memo_artifact_builder` 中，应直接从 `tagmemo_artifacts` 表读取：
  ```sql
  SELECT artifact_sig FROM tagmemo_artifacts
  WHERE asset_type = 'unified_geometry' AND model_sig = ?1 AND status = 'ready'
  ORDER BY updated_at DESC LIMIT 1
  ```

### ⚠️ 暗礁 4：Schema 版本升级在「新库创建」与「旧库迁移」下的分支覆盖（§6）
* **问题推演**：
  在现有 `storage.txt`（第 425 行）中，`initialize_schema_metadata` 会在新库首次打开时先把请求的 `schema_version` 插入 `kbm_runtime_meta`，然后再调用 `schema::initialize_schema`。
  这意味着：对于**全新创建的数据库**，进入 `initialize_schema` 时 `version == requested_version`；只有**旧库升级**时才满足 `version < requested_version`。
  此外，Rust 单元测试中大量使用了 `StorageOptions::default()`（默认 `schema_version: 1`）和手动 `initialize_schema(&conn, 1)`。
* **修正方案**：
  1. 将 §6 中的 `DROP TRIGGER IF EXISTS ...`、`DROP TABLE IF EXISTS ...`、`DELETE FROM kbm_runtime_meta WHERE key IN ('derived_pairwise', ...)` 设为**无条件幂等执行**（不要仅放在 `if version < requested_version` 分支内），这样无论新库、旧库升级还是单测夹具都能保证干净。
  2. 同步将 `StorageOptions::default()` (`storage.txt`) 和 `KnowledgeBaseManager.js` (`openAndInitStore`) 中的 `schemaVersion` 升为 `2`。

### ⚠️ 暗礁 5：`tag_consistency.rs` 的失效清理语句需同步对齐 `derived_geometry`
* **问题推演**：
  在 `tag_consistency.txt` 第 381–388 行，当 Tag 一致性修复提交时，有一段硬编码的清理 SQL：
  ```sql
  DELETE FROM tag_pair_similarity;
  DELETE FROM tag_pair_similarity_status;
  DELETE FROM tag_intrinsic_residuals;
  DELETE FROM tag_intrinsic_residual_status;
  DELETE FROM tagmemo_artifacts;
  DELETE FROM rivermemo_artifacts;
  ```
  你在 §9 中已经注意到要删除前两行并加入 `DELETE FROM kv_store WHERE key='epa_basis_cache'`。
  **补充一点**：当 `tag_intrinsic_residuals` 和 `epa_basis_cache` 在 `tag_consistency` 已经为空时，`DELETE` 影响行数为 0，不会触发 SQLite 的 `AFTER DELETE` 触发器去递增 `derived_geometry`（不过因为 `tags` / `file_tags` 变动已经触发了 `memo_tag_facts++`，且 `rivermemo_artifacts` 已被清空，所以依然安全）。
---

## 14. 第三阶段加单 Todo（基于二阶段消融实测的精准收口）

### Todo 1：【P0 数学刻度校准】修复 `analyze_epa` 绝对解释率导致的 `logic_depth` 15 倍过阻尼与 `0.18` 地板锁死
- **病灶位置**：`rust-vexus-lite/src/memo_pipeline.rs`（`EpaCache`、`analyze_epa` 约 260–335 行、`gate_tags` 约 705–720 行）。
- **根因**：
  在 3072 维全库流形上，前 `k_sem = 8` 个正交星团面的全库基准覆盖率 `coverage[k_sem - 1]` 约为 `7.27%`（`0.0727`）。库内真实 Tag 落在前 8 面的平均解释率 `semantic_explained_ratio = total_energy / centered_energy ≈ 0.0660` 已接近理论满水位（相比之下，纯随机方向仅 `8 / 3072 ≈ 0.0026`）。
  当前代码直接令 `logic_depth = (1.0 - normalized_entropy) * semantic_explained_ratio`，把正常查询的 `logic_depth` 无差别缩小了约 15 倍（均值仅 `0.0222`），导致 `gate_tags` 中的 `dynamic_factor` 永远小于下限 `0.3`，所有 24 个烟测样本的 `effective_boost` 100% 锁死在 `0.18`（`0.6 * 0.3`），丧失了动态区分度。
- **修改要求**：
  1. 在 `EpaCache` 中反序列化 `coverage: Vec<f64>`。
  2. 取前缀基准覆盖率：`baseline = cache.coverage.get(semantic_count.saturating_sub(1)).copied().filter(|v| v.is_finite() && *v > 0.0).unwrap_or(semantic_count as f64 / dimension.max(1) as f64).max(1e-4)`。
  3. 用相对基准比构造域内门控（在基准测试中对比线性相对比 `clamp01(semantic_explained_ratio / baseline)` 与平方根相对比 `clamp01((semantic_explained_ratio / baseline).sqrt())`）：
     - 目标 A：纯随机方向的 `logic_depth` 依然被强力压制（`< 0.10`）；
     - 目标 B：24 个真实 Tag 烟测样本的 `in_domain_gate` 恢复到合理区间（`0.7 ~ 1.0`），`logic_depth` 与 `effective_boost` 脱离 `0.18` 常数地板，展现真实的熵与共振分布差异。
  4. 在 `EpaOutput` 中保留 `semantic_explained_ratio` 或 `in_domain_gate` 诊断字段，并在单元测试与 `benchmark_memo_geometry.js` 中验证。

### Todo 2：【P1 载荷与构图瘦身】砍掉 `memo_artifact_builder.rs` 中 85.84 MB 的 `provenanceView` 路径字符串重复序列化
- **病灶位置**：`rust-vexus-lite/src/memo_artifact_builder.rs`（`FileTag`、`ProvenanceContribution`、`build_provenance`、`artifact_payload`）与 `rust-vexus-lite/src/rivermemo_topology_v3.rs`（`decode_artifact` 约 795–825 行）。
- **根因**：
  552,616 条边在 `build_provenance` 和 `artifact_payload` 中，把每个贡献文件的 `diary_name` 与 `path` 字符串塞进 `[file_id, diary_name, path, mass]` 四元组重复克隆并序列化了上百万次，导致 JSON 暴涨至 **85.84 MB**（构图 + 序列化耗时约 4.5s）。而消费端 `decode_artifact` 仅读取 `(file_id, mass)`，完全丢弃了字符串。
- **修改要求**：
  1. 审计仓库内是否有任何 JS/Rust 消费方读取持久化 `rivermemo_artifacts.payload` 中 `provenanceView.edges` 里的 `diary_name` 和 `path`。
  2. 将 `ProvenanceContribution` 精简为 `{ file_id: i64, mass: f64 }`（`BTreeMap<(i64, i64, i64), f64>` 直接累加 mass，消除百万次 `String` 克隆）；`provenanceView.edges` 内层数组改为紧凑二元组 `[file_id, mass]`。
  3. `rivermemo_topology_v3.rs::decode_artifact` 同时兼容二元组 `[file_id, mass]`（`values.len() == 2`）与旧四元组 `[file_id, diary, path, mass]`（`values.len() >= 4`）。
  4. 在独立基准库上实测优化前后的 raw JSON 体积、压缩后体积、构图耗时、序列化耗时与总耗时。

### Todo 3：【P1 几何发布写入加速】消除 `GeometryTask` 发布阶段的 975ms 二级索引维护开销
- **病灶位置**：`rust-vexus-lite/src/memo_geometry.rs`（发布事务约 480–515 行）与 `rust-vexus-lite/src/schema.rs`。
- **根因**：
  `tag_intrinsic_residuals` 每次发布前都会 `DELETE FROM tag_intrinsic_residuals;` 全表清空重写 37,076 行，但表上挂着二级索引 `idx_intrinsic_residual_artifact(artifact_sig, model_sig)`，且每行重复写入相同的 `model_sig`、`artifact_sig`、`algorithm_version`、`config_hash` 字符串列，导致 3.7 万次 B-Tree 二级索引拆分。
- **修改要求**：
  1. 审计全库对 `tag_intrinsic_residuals` 的查询语句（如 `memo_artifact_builder::load_anchor_gains`）。
  2. 移除不必要的二级索引 `idx_intrinsic_residual_artifact`（表内仅存当前活动 `model_sig` 的行，按主键 `tag_id` 顺序扫描即可），或在批量插入前后治理索引开销，实测 `publish` 阶段耗时下降幅度。

### Todo 4：【P2 回归测试债清理】修复验收报告第 5 节列出的 9 个失败/超时 JS 测试文件
- **范围**：验收报告中定位的 9 个 JS 测试文件（旧 `databaseSchema.js` 导入缺失、测试桩缺少当前原生补水/ANN/权限接口、以及人格预处理测试进程未退出问题）。
- **修改要求**：
  1. 对齐当前 Native 存储与 Schema v2 契约，更新过时的测试夹具与 Mock 桩，禁止为迁就旧测试而恢复已退休的生产代码。
  2. 修复超时测试的句柄/定时器泄漏，确保全量 JS 测试可干净退出并全绿通过。