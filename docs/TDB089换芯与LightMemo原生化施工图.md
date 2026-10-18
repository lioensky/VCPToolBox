# TDB 0.8.9 换芯 × USearch 退役 × LightMemo 原生化 施工图

- 日期：2026-10-19
- 状态：**Rust 换芯源码与隔离产物已实现并回归；生产验收未完成，LightMemo 尚未施工**。本文件保留为方案基线，实际格式、验证证据与未测项见[施工与验收记录](TDB089换芯施工与验收记录-2026-10-19.md)。
- 源码基线：`H:\VCP\VCPMain\VCPToolBox`（HEAD 以施工开始时为准，行号会漂移，以符号名定位）
- TDB 参考源码：`docs/TriviumDB-master`（`Cargo.toml` version = `0.8.9`）
- 本机工具链：`rustc 1.89.0` / `cargo 1.89.0`
- 前置已完成：AGS 统一图、KBM 纯 Rust 单一 SQL 真相源

---

## 0. 一句话目标

> **SQLite 守住身份、关系与 3072D f32 原件；TDB QuIVer（2-bit SM-L2 导航 + f32 末端精排）接管派生检索层；AGS / Spike / 双场 / Ω 数学一行不改。USearch 连同“顺手当 Tag 向量仓库”的职责一起退役。LightMemo 改为单次 N-API 原生闭环，最终仍由 RiverMemo V3 收口。**

---

## 1. 不变量（施工红线）

1. **SQL 是唯一真源**：`.vec` 是从 SQL 派生、可删可重建的加速资产，任何时候删掉都能从 SQL 重建，**不重新请求 embedding**。
2. **候选与测量分离**：索引只负责“找谁”；进入 AGS、残差金字塔正交投影、上下文融合、双场投影的向量，一律是 SQL（或其逐位镜像 `.vec`）中的原始 f32。**禁止用 2-bit 签名重建的近似向量参与任何数学。**
3. **事实/索引发布协议不变**：`SQL 提交 → 应用索引增量 → ready；失败 → invalid/recovering → 从 SQL 恢复`。`kbm_index_states`、publication gate、双槽 checkpoint 背书机制保留。
4. **读者不看见半批**：增删改仍在单个写锁内完成整批。
5. **不常驻全库 f32 矩阵**：精排只读候选行（mmap 按页加载）。
6. **单一后端**：不为 USearch / TDB 长期保留双实现泛型框架，换完即删。

---

## 2. 已核实的事实（施工依据）

### 2.1 VCP 侧 USearch 耦合面

| 类别 | 位置（`rust-vexus-lite/src/`） | 说明 |
|---|---|---|
| 句柄 | `index_handle.rs` `IndexHandle` | `RwLock<usearch::Index>` + 轻量统计，换芯主入口 |
| 构造 | `lib.rs` `VexusIndex::new / load`、`RecoverTask`；`index_lifecycle.rs` `new_restore_index`；`knowledge_runtime.rs` `recover_index_snapshot` | 共 6 处 `Index::new`，参数各写一份 |
| 检索 | `lib.rs` `VexusIndex::search`；`knowledge_runtime.rs` `GlobalTagSearchTask`、`NativeMultiIndexAnnTask`（当前查询 + supplemental 历史查询）；`memo_pipeline.rs` `analyze_pyramid` | 4 个入口必须全部覆盖 |
| **取数（错位职责）** | `lib.rs` `project_dual_weighted`、`fuse_memo_context`；`memo_pipeline.rs` `analyze_pyramid`(get)、`fuse_observation`、`project_field`(`&usearch::Index`)、`solve_dual_fields`；`memo_geometry.rs` `read_unit_vectors`（先 index.get 后 SQL 补漏）；`memo_artifact_builder.rs` `run_build`（从索引取 dimension） | 原件本在 SQL，这里只是借 USearch 缓存取数，**接回 SQL** |
| 增删改 | `lib.rs` `add/add_batch/remove/ChunkIndexDeltaTask/TagIndexDeltaTask`；`ingestion.rs` `apply_scope_index_deltas/apply_deleted_index_deltas`；`tag_consistency.rs` `TagConsistencyCommitTask`；`index_lifecycle.rs` `IndexRestoreTask` 重放 | 全部替换为新句柄 API |
| 持久化 | `lib.rs` `save_index_snapshot`（serialized_length→Buffer→tmp→publish）；`index_lifecycle.rs` `index_slot_path`（硬编码 `_a/_b.usearch`）、`IndexCheckpointTask` | 换格式，保留发布/背书 |
| 分数契约 | `knowledge_runtime.rs` 多处、`lib.rs search`、`memo_pipeline.rs` pyramid similarity | 全部是 `1/(1+L2²)` |

JS 侧：`modules/knowledgeBase/indexRepository.js`（路径 `index_global_tags_{slot}.usearch`、`index_diary_{hash}_{slot}.usearch`、旧文件识别正则）、`KnowledgeBaseManager.js`（全局 Tag 恢复路径 `index_global_tags_a.usearch`）、`scripts/rebuild_vector_indexes.js`、`scripts/repair_database.js`、`scripts/diary-semantic-classifier.js`、`scripts/rebuild_tag_index_custom.js`、`rust-vexus-lite/test.js` 及 `tests/*` 中的 `new VexusIndex`。

### 2.2 TDB 0.8.9 关键事实

- **两阶段检索**：`QuIVer::search(query, get_vec_f32, cfg)`：Stage1 默认无训练 **SM-L2** 导航（2-bit 符号/强弱位 + `weak/delta/norm` 幅值，重建 L2），Stage2 仅对 `rerank_limit`（默认 64，≥top_k，≤ef）个候选通过回调 `get_vec_f32(slot, buf)` 读 f32 精排。**QuIVer 自身不存 f32。**
- **返回分数**：默认模式返回**余弦（归一化后点积）**；`NativeL2` 模式返回负平方 L2。与 VCP 现有 `1/(1+L2²)` 不同。
- **维度**：`MAX_BQ_DIM = 3072`；SM 通用维度走 `corrected_sm/dynamic.rs`（768 有专用内核）。3072D SM 行 = 13 个 64B 块 = **832 B/行**。
- **增量**：`insert`（图增量插入，同步追加 default_sm 行）、`soft_delete`（墓碑，仍作中转）、`needs_rebuild`（dirty > 25%）。更新 = soft_delete + insert（新内部节点）。
- **持久化缺口**：`QuIVer::save_to_file` 只写 BQ 签名 + Layer0/Upper 图 + 墓碑 + IDs + slot；**不写 default_sm**。`load_from_file` 后 `default_sm = None`，原版依赖 `pub(crate) prepare_default_sm(fill)` 从全部活跃 slot **流式重扫 f32** 恢复。且 Windows 下其发布是“先删目标再 rename”，非原子。
- **可见性**：`prepare_default_sm / rebuild_default_sm / default_sm_ready` 为 `pub(crate)`，外部 crate 无法调用 → 这是选“移植”而非“直接依赖”的硬理由。
- **SIMD 分发**：BQ2 距离 AVX-512 → AVX2 → 标量；**SM 计数内核 `simd_available()` 要求 AVX-512**，否则走 `counts_scalar`（`u64::count_ones`）。
- **语言版本**：`edition = "2024"`，使用 `if let … && let …`（let chains，仅 2024 edition）、`<[T]>::as_chunks`（1.88）、`is_multiple_of`（1.87）。`rust-vexus-lite` 是 `edition = "2021"`。

### 2.3 LightMemo 现状

- `Plugin/LightMemo/LightMemo.js` 的 `_gatherCandidateChunks` 与 `_scoreByVectorSimilarity` 仍读取 `this.vectorDBManager.db`（旧 better-sqlite3 连接）。
- 静态搜索 `KnowledgeBaseManager.js` 中**未发现** `this.db =` 赋值（只剩 `this.dbPath` + `nativeKnowledgeRuntime`）。**推断热记忆检索当前直接返回空候选，需运行时确认一次。**
- 现有过滤语义（迁移必须逐条保持）：
  - 排除：`EXCLUDED_FOLDERS`、`已整理%`、`%簇`；音乐检索放行 `MusicDiary`。
  - folder：`diary_name LIKE %f%`（**子串**，多值 OR）。
  - maid（无 folder 时）：先 `diary_name LIKE %maid%`，再 `chunk 首行 includes(maid)`（**子串匹配**，不是等值）。
  - 时间：从 **chunk 正文前 100 字**正则提取首个 `20xx-mm(-dd)`，无日期即丢弃。
- RiverMemo 路径已可在 Rust 内直通：`knowledge_runtime.rs` `NativeRiverQueryTask` → `rivermemo_topology_v3::run_native_with_connection`（同一读事务）。

---

## 3. 架构决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | **移植**（路线 B），不直接依赖整个 `triviumdb` crate | `default_sm` 相关 API 为 `pub(crate)`；避免引入 TQL/图/Payload/WAL 全套依赖 |
| D2 | 移植代码放为**独立子 crate** `rust-vexus-lite/crates/vcp-tdb-index`（edition 2024），`rust-vexus-lite` 以 path 依赖引用 | 保留上游 let chains 等语法，不强迫主 crate 升 edition（主 crate 升 2024 会牵动 RPIT 捕获、`unsafe_op_in_unsafe_fn` 等全局变化）；后续同步上游 diff 也更容易 |
| D3 | 移植清单：`vector.rs`、`index/bq.rs`、`index/quiver.rs`、`index/quiver/corrected_sm.rs` 及 `corrected_sm/{build,dynamic,dynamic_search,production}.rs`（测试文件按需带入）。**不移植** `vec_pool.rs`，`.vec` 由 VCP 自定格式 | VCP 需要的是“id/slot 稳定 + 双槽发布 + SQL 背书”，不是 TDB 的 COW delta 池 |
| D4 | 魔改 `.vec` = **单文件派生资产**：头 + slot→id 表 + 64B 对齐 f32 矩阵（mmap 精排）+ QuIVer 图块 + **default_sm 行块** + 尾 CRC | 冷启动直接恢复 SM-L2，不重扫 f32；单文件契合现有双槽 `_a/_b` 发布 |
| D5 | 小规模作用域走**精确平扫**（mmap f32 SIMD 余弦），超过阈值才建 QuIVer | 小日记本几百条，建图收益为负；阈值 bench 决定（初值 2048） |
| D6 | 分数契约统一迁移为**余弦**；所有阈值、混合权重在 Phase 0 基线上重校 | 不能把 `cos` 当 `1/(1+L2²)` 直接塞，否则阈值语义静默漂移 |
| D7 | Tag/AGS 数学取数一律走 SQL 批量读（复用 `rivermemo_topology_v3.rs` `load_tag_vectors_by_ids` 形态），**不经过 `.vec`** | 数学路径与检索资产彻底解耦；`.vec` 损坏不影响 AGS |
| D8 | LightMemo 全局层采用**无图平坦表**（SM 行 832B + 过滤头），不建全局 Vamana | 跨库/时间/署名过滤下图导航会撞后过滤空洞；平坦线性冲程无构图、无拓扑维护 |

---

## 4. 分阶段施工

### Phase 1 · `vcp-tdb-index` 子 crate

1. 新建 `rust-vexus-lite/crates/vcp-tdb-index/`：`edition = "2024"`，依赖 `bytemuck`、`half`（如 `VectorType` f16 不需要可裁掉）、`rayon`、`crc32fast`、`tracing`（或替换为 `eprintln!`/no-op 宏，二选一，倾向裁掉以减依赖）。
2. 拷入 D3 清单，修正 `crate::` 路径；删除对 `crate::storage::memtable`、`crate::database` 的测试依赖（相关测试改为 slice 回调版本）。
3. **最小改动暴露**（标注 `// VCP-PATCH` 便于对上游 diff）：
   - `prepare_default_sm`、`set_default_sm`、`default_sm_ready` 改 `pub`；
   - 新增 `QuIVer::write_to<W: Write>` / `load_from_bytes` 已存在 → 用于嵌入单文件；
   - 新增 `CorrectedSmIndex` 动态行的序列化/反序列化（`rows/dynamic.data` + `exact_scales` + `scoring`），供 D4 的 default_sm 块。
4. 单测：从 slice 构建 → 搜索 → 序列化 → 反序列化 → 搜索结果逐位一致；soft_delete / insert / needs_rebuild。
5. 主 crate `Cargo.toml`：`[workspace]` 或直接 path 依赖 `vcp-tdb-index = { path = "crates/vcp-tdb-index" }`。

**构建注意**：
- 后端 `i7-8795H` 无 AVX-512：SM 计数走标量 `count_ones`。默认 `x86_64-pc-windows-msvc` 目标**未开启 popcnt**，`count_ones` 会退化为软件实现。建议 `.cargo/config.toml` 为本 crate 打开 `-C target-feature=+popcnt,+avx2,+fma`（8 代及前端 13 代均支持），并在 Phase 0 的 bench 里于**后端机器**实测；若需兼容更老 CPU 再改为运行时多版本。
- 禁止 `-C target-cpu=native`（前端编译会带入后端不支持的 AVX-512）。

### Phase 2 · `IndexHandle` 换芯 + `.vec` 格式

#### 2.1 `.vec` 文件布局（v1）

```text
[Header 128B]
  magic "VCPVEC01" | version u32 | dim u32 | count u64 | scope u8(diary/tags)
  layout u8(flat/quiver) | model_sig_hash [32]u8 | content_digest [32]u8
  off_ids u64 | off_vectors u64 | off_graph u64 | len_graph u64
  off_sm u64 | len_sm u64 | reserved
[slot→id 表]        count × u64（0 = 空槽/墓碑）
[f32 矩阵]          64B 对齐，count × dim × 4B，slot 顺序
[QuIVer 图块]       QuIVer::write_to 输出（layout=flat 时长度 0）
[default_sm 块]     CorrectedSmIndex 动态行序列化（layout=flat 时长度 0）
[Footer]            CRC32(header..sm) | magic "VCPVECEND"
```

- 加载：`mmap(.vec)` → 校验 header/footer/CRC → `QuIVer::load_from_bytes(graph)` → `set_default_sm(sm)`；f32 区只做 mmap 视图，不拷贝。
- 增量：内存态维护 **delta 区**（`Vec<f32>` + 新 slot），删除 = 墓碑 + 槽位回收表；checkpoint 时整文件重写到对侧槽位（与现行双槽语义一致）。
- 发布：写临时文件 → `sync_index_file` → 现有 `publish_index_file`（Windows 可回滚备份交换），**不用** QuIVer 自带的“先删再 rename”。
- 命名：`index_diary_{hash}_{a|b}.vec`、`index_global_tags_{a|b}.vec`；`index_slot_path` 改为识别 `.vec`。

#### 2.2 新 `IndexHandle`

```rust
pub(crate) struct IndexHandle {
    inner: RwLock<TdbIndex>,   // 替换 RwLock<usearch::Index>
    count: AtomicU64, capacity: AtomicU64, memory: AtomicU64,
}

pub(crate) struct TdbIndex {
    dim: usize,
    base: Option<Mmap>,              // 已发布 .vec 的 f32 区视图
    delta: Vec<f32>,                 // 自上次 checkpoint 以来新增 slot
    id_to_slot: HashMap<u64, usize>,
    slot_to_id: Vec<u64>,            // 0 = 空/墓碑
    free_slots: Vec<usize>,
    quiver: Option<QuIVer>,          // None = 平扫模式
}
```

统一 API（替代 usearch 调用点）：

| 方法 | 语义 |
|---|---|
| `upsert_batch(ids, vectors)` | 已存在 id → soft_delete 旧节点 + 新 slot 插入；否则新增；`needs_rebuild` 触发后台重建标记 |
| `remove_batch(ids)` | 墓碑 + 回收 slot |
| `search(query, k, ef?) -> Vec<(id, cos)>` | 平扫或 QuIVer；回调从 base/delta 取 slot 行 |
| `vector_for_slot` | 仅内部精排回调使用，**不对外提供 get(id)** |
| `write_snapshot(path)` / `load_snapshot(path)` | 2.1 格式 |
| `len / tombstones / hot_bytes` | 统计 |

- 构造工厂集中为 `TdbIndex::empty(dim)` / `TdbIndex::rebuild_from_rows(dim, rows)`，替换全部 6 处 `Index::new`。
- 平扫/建图切换：`count ≥ QUIVER_MIN_NODES`（初值 2048）且 dirty 收敛时后台 `batch_build_experimental_v2` 建图，发布期间搜索继续走平扫，构建完成再写锁换入（复刻 TDB `publish_quiver_if_current` 的代际校验思路）。
- `VexusIndex` N-API 类名保留（VCP 包装层名称，非依赖名），JS 调用面不变。

#### 2.3 逐点替换

- `lib.rs`：`new / load / save / save_async / add / add_batch / remove / apply_chunk_delta / apply_tag_delta / search / RecoverTask / save_index_snapshot`。
- `knowledge_runtime.rs`：`GlobalTagSearchTask`、`NativeMultiIndexAnnTask`（当前 + supplemental 两条都改）、`recover_index_snapshot`、`register_diary_index` 维度检查保持。
- `ingestion.rs`：`apply_scope_index_deltas`（含 reused vectors 路径）、`apply_deleted_index_deltas`。
- `tag_consistency.rs`：提交后 Tag 索引增量。
- `index_lifecycle.rs`：`IndexCheckpointTask`（保存走新格式）、`IndexRestoreTask`（加载 + 基线差分重放；**旧 `.usearch` 文件一律视为不兼容 → 从 SQL 重建**，并改名隔离为 `.usearch.retired`，不尝试解读）。
- 基线兼容判断增加 **索引格式版本**（不能只凭 dimension + modelSig 判兼容）。

#### 2.4 分数契约迁移（D6）

逐点把 `1.0 / (1.0 + distance)` 改为直接使用余弦，并在 Phase 0 基线上核对：
- `NativeMultiIndexAnnTask` 的 `score/vector_score`（混合 BM25 权重、semantic threshold）；
- `GlobalTagSearchTask` 输出 `score`；
- `VexusIndex::search` 对外 `SearchResult.score`（同步核对 JS 调用方阈值）；
- `analyze_pyramid` 的 `similarity`（若参与门控，需在 SQL f32 上重算余弦后再进入，见 Phase 3）。

### Phase 3 · 数学取数接回 SQL（D7）

| 位置 | 改法 |
|---|---|
| `memo_pipeline.rs` `analyze_pyramid` | 每层：`tdb.search(residual, pyramid_top_k)` 得候选 id → 同一 `connection` 批量 `SELECT id, vector FROM tags WHERE id IN (…)` → 精确余弦 → 原 `orthogonal_projection / analyze_handshakes` 不变 |
| `fuse_observation` | 所需 Tag 向量改走同一批量读（同查询内 HashMap 复用） |
| `project_field` | 签名从 `&usearch::Index` 改为 `&HashMap<i64, Vec<f32>>`（由 `solve_dual_fields` 先按两场非零节点批量 SQL 读出） |
| `solve_dual_fields` | 不再持索引读锁；接收 `connection` |
| `memo_geometry.rs` `read_unit_vectors` | 删除 index.get 优先分支，SQL 后备路径扶正为唯一路径（保留零向量/非有限剔除） |
| `memo_artifact_builder.rs` `run_build` | dimension 来自运行时配置，不再 `index.read().dimensions()` |
| `lib.rs` `project_dual_weighted / fuse_memo_context` | 先确认 JS 是否仍有调用方（静态搜索未发现）；无调用 → 删除；有调用 → 迁到 `NativeKnowledgeRuntime` 并走 SQL 批量读 |

共享工具函数：抽出 `storage::load_vectors_by_ids(connection, table, ids, dim)`，`rivermemo_topology_v3.rs::load_tag_vectors_by_ids` 改为调用它。

**验收**：同一组 Tag ID，SQL 取数后 AGS 资产签名、融合向量、双场投影向量与旧路径逐位或 ≤1e-6 一致。

### Phase 4 · JS 侧路径与运维脚本

- `indexRepository.js`：路径后缀、旧文件识别正则（新增 `.vec`，旧 `.usearch` 进入一次性迁移清理）。
- `KnowledgeBaseManager.js`：`restoreGlobalTagIndex` 路径。
- `scripts/rebuild_vector_indexes.js`、`repair_database.js`、`diary-semantic-classifier.js`、`rebuild_tag_index_custom.js`：改用新格式或标注废弃。
- `rust-vexus-lite/test.js`、`tests/*`：`new VexusIndex` 调用面不变；涉及 `.usearch` 文件名与 `index.get` 断言的用例改写。
- `memoryProfiler.js`：内存诊断字段换为 `hot_bytes / mmap_bytes / tombstones`。

### Phase 5 · LightMemo 原生化

#### 5.1 Rust：`NativeKnowledgeRuntime::execute_light_memo_query(plan_json, query_vector)`

```text
plan = {
  scope: { searchAll, folders[], maid, excludedFolders[], includeMusic, timeRange? },
  queryTokens[],            // JS 侧 jieba + semantic_groups 扩展后的词
  engineMode: knn|rivermemo,
  k, refinementK, vectorTopM(256), bm25TopM(128),
  observationHandle?, river config, abMode?
}
```

1. **作用域解析**：`diary_name` 列表在内存中按 `excluded / 已整理% / %簇 / folder 子串 / maid 子串` 求出允许的 `diary_id` 集合（日记本数量少，子串匹配成本可忽略）。
2. **全局轻量层（D8）**：常驻 `GlobalChunkTable`：
   - SM 行（832B/条，3072D）或 BQ2 签名（768B/条）——二选一，bench 决定；
   - 过滤头 `{ chunk_id u64, file_id u32, diary_id u16, flags u16, date_yyyymmdd u32 }`（20~24B）；
   - **首行署名不能做成 maid_id 等值**：现语义是首行子串包含。实现为常驻“首行前 N 字节（建议 64B）”紧凑串池，查询时只对作用域内条目做子串匹配；
   - `date_yyyymmdd`：**沿用现语义**——摄取时从 chunk 正文前 100 字提取首个日期，无日期记 0（时间约束下直接排除）；
   - 由 `ingestion.rs` / 删除路径同步维护；冷启动从 SQL 一次性流式构建（或随日记 `.vec` 一并持久化，见待决策 Q3）。
3. **双路并集**：
   - 向量路：作用域位图过滤后线性冲程 Top-`vectorTopM`；
   - BM25 路：见 5.3；
   - 并集 ≤ `vectorTopM + bm25TopM`（默认最多 384 条）。
4. **精排**：并集 id 从 SQL 读 f32（3072D × 384 ≈ 4.5 MiB 上限）→ 精确余弦；`hybrid = BM25 归一化 × w + cos × (1−w)`，权重沿用现值（0.6/0.4，无 BM25 命中时 0/1），Phase 0 基线复核。
5. **收口**：
   - `knn`：Top-k（或 refinementK）回填 `content/path/diary_name/file_id`；
   - `rivermemo`：同一读事务直接调用 `rivermemo_topology_v3::run_native_with_connection`，`allowedFileIds` = 作用域文件集合；只返回最终 refinementK 条正文与诊断；
   - `abMode`：同一次调用同时带回 `knnTopK` 与 `riverTopK`。

#### 5.2 JS：`LightMemo.js` 瘦身

- 删除：`_gatherCandidateChunks`、`_scoreByVectorSimilarity`、`_cosineSimilarity`、`_buildBm25TopIds` 中的全库文本分词与 JS 余弦；`BM25Ranker` 仅在 5.3 未落地前作为过渡。
- 保留：参数解析（`[音乐检索]`、时间区间、`[文件夹]署名`、别名布尔）、冷知识库分流（`TDBKnowledge`）、查询词 jieba + 语义组扩展、`getSingleEmbedding`、`prepareUnifiedMemoObservation`、Rerank / Jev / AIMemo / 格式化。
- `handleMemoryAB`：改为 `abMode: true` 单次原生调用后进入现有 Rerank/Jev 对比轨。
- 错误码：原生接口不可用时明确抛 `LIGHTMEMO_NATIVE_QUERY_UNAVAILABLE`，不回退 `.db` 裸查。

#### 5.4 全局表生命周期：复用代际索引链路（主人方案）

目标：既不完全冷启动（每次读约 600 MB BLOB），也不完全常驻。

**文件**：`index_global_chunks_{a|b}.vec`（layout = `sm_flat`）
- 只存：header + slot→chunk_id + 过滤头（file_id/diary_id/date/flags）+ 首行串池（64B/条）+ diary 字典 + SM 行（832B/条）+ CRC。
- **不存 f32 矩阵**：精排从 SQL 点射读取 ≤384 条，避免在磁盘上复制一份原件。5 万条约 45 MB。

**背书**：沿用双槽 baseline 表形态（新增 scope=`global_chunks`）
- manifest：generation、slot、dim、model_sig、format_version、`database_generation`、**文件 size + CRC 戳**。
- entries：`(chunk_id, vector_version 或 chunk_vector_sig)`。

**查询时序**
1. 驻留命中 → 校验 `database_generation`，未变化则直接搜（O(1) 快路径）。
2. 未驻留 → 单飞加载（single-flight，并发首调共享一次加载）：
   - 校验背书 manifest 与文件戳；不兼容（格式、模型、维度、diary 字典、戳不符）→ 从 SQL 流式全量重建。
   - 兼容 → 加载 `.vec`。
3. 代际差分：`database_generation` 变化时，只扫 SQL 元数据 `(id, version)` 做对称差，删除置墓碑；新增或变更只读差量 BLOB 并编码 SM 行。
4. 执行搜索（§5.1 第 3~5 步）。
5. 后台：差量占比 ≥5% 或空闲淘汰前 → checkpoint 写对侧槽：
   `tmp → sync → publish_index_file → 更新背书`，顺序不可颠倒（防止“新背书配旧文件”）。
6. 空闲 TTL（初值 10 分钟）到期 → 释放内存；未落盘差量先 checkpoint 或直接丢弃（下次由 diff 补齐，正确性不受影响）。

**同步维护**：已驻留时，摄取和删除路径直接更新内存表（与日记索引 delta 同一事务后序）；未驻留时不做任何事，由下次加载的 diff 补齐。

**验收**：截断或篡改 `.vec`、背书与文件不符、加载期间并发摄取、TTL 释放后再查询 → 结果与 SQL 暴力全量一致。

#### 5.3 BM25（分两步）

- **5.3a（随 Phase 5 上线）**：Rust 侧对“向量路候选 ∪ 作用域内日期/署名命中集”的正文做词项计数 BM25（只读候选正文，避免全库）；IDF 用作用域内文档频次近似 → **仍存在纯字面命中但语义不近的漏召回**，作为过渡。
- **5.3b（后续）**：摄取时分词（Rust `jieba-rs`，需对齐 `@node-rs/jieba` 词典）写入倒排表 `chunk_terms(term, chunk_id, tf)` + `chunk_len`，查询走真正全作用域 BM25 Top-128。

### Phase 6 · 退役清理

- `Cargo.toml` 移除 `usearch = "=2.21.3"`；`rg "usearch" rust-vexus-lite/src` 归零（文档/归档除外）。
- 删除 `index_handle.rs` 中 usearch 相关测试，换新句柄单测。
- `docs/` 更新：KBM 架构文档、`TDB_COLD_KNOWLEDGE_BASE.md` 补充“热层同源 QuIVer 内核”说明。

---

## 5. 验收标准

| 维度 | 标准 |
|---|---|
| 编译 | 无 usearch 依赖 release 编译通过；前端编译产物在后端 Win10 / i7-8795H 正常加载 |
| 检索质量 | 以暴力精确为真值：`Recall@K(TDB) ≥ Recall@K(USearch)`，日记 Chunk / 全局 Tag / 金字塔逐层分别统计 |
| 端到端 | 固定查询集上 RiverMemo 最终 Top-K：Jaccard 与 Kendall τ 相对基线不劣化（阈值 Phase 0 后定） |
| 数学一致 | AGS 资产签名、融合/双场向量与 SQL 原件路径一致（≤1e-6） |
| 生命周期 | 冷启动、首次查询、摄取、删除、Tag 一致性修复、checkpoint、截断/损坏 `.vec` 恢复、SQL 已提交但索引应用失败 → 全部可走通 |
| 性能 | 实测记录：冷启动耗时、RSS、单查询 P50/P99（前后端分别）；不预设数字 |
| LightMemo | 单角色 / 多 folder / 全库 / 时间区间 / 首行署名 / 音乐检索 / knn / rivermemo / memory_ab / Jev / AIMemo 全部回归；V8 侧不再出现全库正文与向量 |

---

## 6. 待主人决策

| Q | 问题 | Kerr 倾向 |
|---|---|---|
| Q1 | 子 crate（edition 2024）还是主 crate 整体升 edition 2024 | 子 crate |
| Q2 | 平扫/建图切换阈值、`rerank_limit`、`ef_search` | 初值 2048 / 64 / 128，Phase 0 bench 定 |
| Q3 | LightMemo 全局表驻留策略 | **已定（主人方案）**：按需加载 + 代际差分补齐 + 空闲 TTL 释放 + 阈值异步 checkpoint，见 §5.4 |
| Q4 | 全局表用 SM 行（832B，精度高）还是纯 BQ2（768B） | SM 行（与日记索引同一编码，省一套逻辑） |
| Q5 | `project_dual_weighted / fuse_memo_context` 是否删除 | 确认无调用方后删除 |
| Q6 | BM25 5.3b 何时上 | LightMemo 原生化稳定后单独立项 |

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 后端无 AVX-512，SM 计数走标量 | 开 `+popcnt,+avx2,+fma`；后端实测；必要时为 dynamic 计数补 AVX2 路径（`VCP-PATCH`） |
| 上游 TDB 后续迭代导致移植分叉 | 所有改动标注 `// VCP-PATCH`，保留上游原文件结构，便于 diff 同步 |
| 分数契约变化导致阈值静默漂移 | Phase 2.4 逐点清单 + Phase 0 基线复核，禁止“先换再说” |
| 更新 = soft_delete + insert 导致墓碑累积 | `needs_rebuild` 触发后台重建；checkpoint 时压实 slot |
| 时间/署名语义迁移偏差 | 摄取时提取规则与 JS 现规则逐条对拍测试（同一批 chunk 输出一致） |
| `.vec` 与 SQL 不一致 | header 带 `content_digest` + 基线 entries 背书；不一致即视为不兼容 → SQL 重建 |

---

## 8. 施工顺序总览

```text
Phase 0 基线 ─→ Phase 1 子 crate ─→ Phase 3 数学取数接回 SQL（可与 1 并行）
                       │
                       └─→ Phase 2 IndexHandle 换芯 + .vec ─→ Phase 4 JS/脚本
                                                     │
                                                     └─→ Phase 5 LightMemo 原生化 ─→ Phase 6 退役清理
```

Phase 3 不依赖 TDB，可最先落地，先把“数学走 SQL”这条线拔干净，之后换芯只剩检索与持久化。