# TagMemo V10 Alpha 施工完成与 LightMemo 指令升级

> 日期：2026-07-21  
> 状态：Commit 1—5 核心施工与 LightMemo 实验入口已完成  
> 实验分支：`experiment/tagmemo-v10-alpha-unified-geometry`  
> V9.2 基线：`5d55afb101da54734e65f766905de3a86f0e4802`  
> 基线标签：`tagmemo-v9.2-baseline-20260721`  
> V10 外部版本：`v10_alpha`  
> V10 算法版本：`v10.alpha.1`

---

## 1. 本轮施工裁决

TagMemo V10 Alpha 已作为独立实验内核落地。

本轮没有继续扩写 V9.2 的 `geodesicRerank()`，也没有让 V9.2 在 V10 请求失败时充当内部兜底人格。V9.2 继续保留为生产基线和外部裁判，V10 则拥有独立的：

- Artifact；
- Query State；
- 条件化输运算子；
- Local/Transfer 双尺度场；
- 对称候选超集；
- 有序候选曲线；
- 有界路径泛函；
- D/S/T/C 观测；
- Pure/Gated/Observed 三臂实验；
- LightMemo 批量测试入口。

普通 V9.2 搜索路径未被切换到 V10。

---

## 2. Commit 1：不可变 Artifact 与 Query State

新增了独立的 V10 引擎和不可变基础设施。

### 2.1 V10 Artifact

V10 Artifact 包含：

- 完整传播图内容签名；
- CSR 稀疏输运资产；
- `artifactSig`；
- `graphGeneration`；
- `databaseGeneration`；
- `provenanceGeneration`；
- `modelSig`；
- `configHash`；
- V9 事实资产来源签名；
- Residual、Anchor、Pairwise、Inbound 和 Wormhole 只读视图；
- V10 独立配置快照。

V10 不把 V9 的可写 `Map` 直接暴露给查询层，而是重新编译为只读 CSR 和只读视图。

### 2.2 Query State

每次查询会生成请求级隔离状态，包含：

- `queryId`；
- `artifactSig`；
- `artifactGeneration`；
- `configHash`；
- `databaseGeneration`；
- `scopeHash`；
- 查询文本和查询向量摘要；
- Agent/日记本/文件权限上下文；
- 归一化源场；
- Local/Transfer 求解器配置；
- 创建时间。

Query State 创建后冻结，不写入全局“最近场”。

---

## 3. Commit 2：边权限条件化与双尺度场

### 3.1 硬门与软门分离

V10 条件化算子明确区分：

- `hardVisible`：节点与边是否具备传播权限；
- `propagationEligible`：是否允许传播；
- `identityEligible`：是否具备当前主体身份资格；
- `rankingEligible`：是否具备排序资格；
- `queryAffinity`：查询相关软门；
- `subjectAffinity`：主体亲和软门；
- `authorizedFraction`：边来源中合法质量的占比。

传播资格、身份资格和排序资格不再混为一个分数。

### 3.2 边级 provenance

V10 从 `files`、`file_tags` 和有序 Tag 链构造边来源资产。

每条边可以按查询上下文划分为：

- public；
- agent-own；
- authorized；
- other-agent-public；
- private-forbidden；
- unknown。

未被明确授权的来源不会自动推断为 public。

权限过滤后，被删除的质量不会重新分配给剩余合法边，因此私有质量不能通过行归一化被“救回来”。

### 3.3 Local/Transfer 双尺度场

已实现同一节点空间和同一事实底座上的双尺度 Resolvent：

- Local 默认 `alpha = 0.15`；
- Transfer 默认 `alpha = 0.55`；
- 默认最大迭代 80；
- 默认收敛阈值 `1e-9`。

输出包括：

- Local Field；
- Transfer Field；
- 两套有效支持域；
- 收敛残差；
- 迭代次数；
- 输入/输出质量；
- 尾部质量；
- 禁止质量；
- 传播边访问诊断。

支持域可以使用质量域、Shannon、Participation Ratio 和谱间隙方法，不写死 Top-10。

---

## 4. Commit 3：配额感知候选超集

V10 候选池由以下五路组成：

- `query_knn`；
- `local_field_knn`；
- `transfer_field_knn`；
- `bm25`；
- `anchor_direct`。

候选裁剪顺序为：

1. 每路最低保留配额；
2. 多来源候选优先；
3. 剩余位置按统一归一分竞争；
4. 使用确定性顺序解决同分；
5. 输出所有被上限淘汰的候选。

诊断中记录：

- 每路 offered 数；
- entered 数；
- exclusive 数；
- dropped 数；
- entry rate；
- exclusive rate；
- drop rate；
- `droppedByUnionCap`。

Pure、Gated、Observed 三臂消费同一个候选超集。

---

## 5. Commit 4：候选曲线与有界路径几何

### 5.1 曲线投影

候选通过批量 SQLite 查询投影为有序 Tag 曲线，保留：

- chunk ID；
- file ID；
- diary name；
- 文件路径；
- Chunk 正文和向量；
- 有序 Tag ID、名称、位置和向量；
- 候选进入来源；
- Query/Local/Transfer/BM25/Anchor 分数。

没有为每个候选执行全图 Dijkstra，也没有构造稠密矩阵。

### 5.2 最小统一路径泛函

首版路径泛函只读取：

- Local 势；
- Transfer 势；
- 正反方向导通；
- 路径连续性；
- Tag 到 Chunk 的闭合；
- 支持片段覆盖率。

路径分数严格限制在 `[0,1]`。

作用量定义为路径质量的单调对数表示，不使用无界倒数累计。

每个路径片段输出：

- 起止 Tag；
- Local/Transfer 势；
- 正向/反向导通；
- 方向一致性；
- 连续性；
- 是否为 Transfer 片段；
- 是否有真实结构支持；
- 片段质量。

---

## 6. Commit 5：D/S/T/C 与三臂实验

### 6.1 D/S/T/C 独立观测

Direct、Structural、Thematic、Closure 已实现为统一状态上的独立纯函数观测。

- Direct：种子接触、身份资格和可见性；
- Structural：直接读取统一路径质量；
- Thematic：分别读取 Local/Transfer 覆盖、势能、尾部和双尺度一致性；
- Closure：场加权 Tag 表达是否回到 Chunk 向量。

### 6.2 Pure

Pure 只读取统一状态生成的：

- Query 语义分；
- Local 回投影分；
- Transfer 回投影分；
- Path Quality；
- Field Occupancy。

D/S/T/C 在 Pure 中只记录，不影响排序。

### 6.3 Gated

Gated 的主分仍来自 Pure。

D/S/T/C 只能：

- 保持；
- 限幅；
- 降权；
- 拒绝。

Gated 的最终分数不能高于 Pure。

### 6.4 Observed

Observed 允许 D/S/T/C 提供受限奖励，但：

- 总奖励受 `observedRewardCap` 限制；
- 每项输出独立边际贡献；
- 禁用项贡献严格为 0；
- 不允许任一观测无限抬升候选。

---

## 7. KnowledgeBaseManager 接入

KnowledgeBaseManager 现在同时持有：

- V9.2 生产引擎；
- V10 Alpha 实验引擎。

V10 在 V9 事实资产发布完成后初始化，但不替换 V9 搜索接口。

新增的管理器能力包括：

- 获取或强制重建 V10 Artifact；
- 准备 V10 Query State；
- 生成双尺度场与回投影向量；
- 构建候选超集；
- 投影候选曲线；
- 计算统一路径几何；
- 计算 D/S/T/C；
- 运行单臂；
- 同池运行三臂。

数据库连接重绑定和热配置更新会同步传递给 V10 引擎。

---

## 8. V10 Artifact 的实际构建方式

V10 当前拥有独立内存 Artifact，但不重复执行一套 Rust intrinsic residual 或 pairwise 训练。

构建流程为：

1. V9.2 加载或生成事实传播底座；
2. V10 从当前 V9 事实资产复制并编译只读 CSR；
3. V10 从数据库事实生成边级 provenance；
4. 计算数据库、图、来源和配置代际；
5. 发布独立 V10 Artifact 指针。

默认配置中 V10 为关闭状态，因此普通启动不会主动构建 V10 Artifact。

第一次显式 V10 请求会按需构建。

若把 `tagMemoV10Alpha.enabled` 改为 `true`，服务器会在 V9 初始化完成后预构建 V10 Artifact。

LightMemo V10 请求也可以传：

`force_artifact_rebuild = true`

以强制重新编译当前 V10 Artifact。

正式跑批建议只在第一条预热请求中强制重建，后续固定返回的 `artifactSig`。

---

## 9. LightMemo 指令升级

LightMemo 插件版本由 `1.0.0` 升级为 `1.1.0`。

插件 manifest 新增独立能力：

`TagMemoV10Alpha`

### 9.1 触发方式

推荐：

`command = tagmemo_v10`

兼容：

- `tagmemo-v10`；
- `tagmemo_v10_alpha`；
- `tagmemo-v10-alpha`；
- `v10_alpha`；
- `v10-alpha`；
- `统一认知几何`；
- `version = v10_alpha`；
- `tagmemo_version = v10_alpha`。

### 9.2 新增参数

- `experiment_arm`：`pure`、`gated`、`observed` 或 `all`；
- `disabled_observables`：D/S/T/C 消融列表；
- `source_k`：源场读取的 Tag 数；
- `force_artifact_rebuild`：是否强制重建 V10 Artifact；
- `BM25`：是否让 BM25 候选进入对称超集。

作用域继续使用：

- `maid`；
- `folder`；
- `search_all_knowledge_bases`。

### 9.3 推荐调用

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」LightMemo「末」,
command:「始」tagmemo_v10「末」,
folder:「始」VCP开发「末」,
query:「始」TagMemo统一认知几何如何生成Local与Transfer双尺度场「末」,
k:「始」8「末」,
source_k:「始」16「末」,
experiment_arm:「始」all「末」,
BM25:「始」true「末」,
force_artifact_rebuild:「始」true「末」
<<<[END_TOOL_REQUEST]>>>
```

### 9.4 D/S/T/C 消融

示例：

`disabled_observables = direct,closure`

可选值：

- direct；
- structural；
- thematic；
- closure。

### 9.5 返回结果

V10 LightMemo 返回可供服务器脚本解析的 JSON 文本。

Schema：

`tagmemo-v10-alpha-lightmemo-result-v1`

内容包括：

- Artifact 代际与签名；
- Query Trace；
- Local/Transfer 域；
- 候选来源统计；
- 被候选上限淘汰的项目；
- 路径分段归因；
- D/S/T/C；
- Pure/Gated/Observed 排名；
- Gate multiplier；
- Observed bonus；
- 逐项边际贡献；
- 拒绝原因。

---

## 10. 本分支修改文件统计

### 10.1 新增文件

- `TagMemoV10Engine.js`
- `modules/tagmemoV10/immutable.js`
- `modules/tagmemoV10/provenance.js`
- `modules/tagmemoV10/agentConditioner.js`
- `modules/tagmemoV10/scaledFieldSolver.js`
- `modules/tagmemoV10/candidateSuperset.js`
- `modules/tagmemoV10/curveProjector.js`
- `modules/tagmemoV10/unifiedPathGeometry.js`
- `modules/tagmemoV10/dstcObservables.js`
- `modules/tagmemoV10/experimentArms.js`
- `开发日志/TagMemo-V10-Alpha施工完成与LightMemo指令升级-20260721.md`

### 10.2 修改文件

- `KnowledgeBaseManager.js`
- `Plugin/LightMemo/LightMemo.js`
- `Plugin/LightMemo/plugin-manifest.json`
- `rag_params.json`

### 10.3 未修改的关键生产内核

- `TagMemoEngine.js`
- `modules/knowledgeBase/searchService.js`

V9.2 的生产排序内核未被改写。

---

## 11. 已完成的静态验收

本轮已完成：

- 全部新增 JavaScript 文件语法检查；
- KnowledgeBaseManager 接入语法检查；
- LightMemo 模块加载检查；
- LightMemo V9/V10 方法并存检查；
- `rag_params.json` 解析检查；
- CSR 只读与内容签名探针；
- 私有边质量不重分配探针；
- Local/Transfer 收敛探针；
- 候选最低配额与淘汰诊断探针；
- 正反向路径几何差异探针；
- Pure/Gated/Observed 隔离探针；
- Observed 奖励上限与消融贡献归零探针；
- Git diff 空白错误检查。

正式效果评估仍由服务器批量调用 LightMemo 完成。

---

## 12. 最终状态

本轮已经完成 V10 Alpha 的核心施工和 LightMemo 指令升级。

V10 当前具备独立运行、独立失败、独立回放和公平三臂比较的工程基础；V9.2 继续作为完整生产基线，不承担 V10 内部兜底。

---

## 13. 服务器性能重构与实测

V10 初版在约 28,286 个节点、449,870 条边的知识图上曾出现约 80 秒同步阻塞。

根因不是双尺度理论本身，而是条件化执行方式：

- 每条边、每轮迭代重复构造权限集合；
- Local 与 Transfer 分别扫描整张图；
- 热循环反复创建并冻结 provenance 对象；
- 最坏情况下形成约 `边数 × 两尺度 × 80轮` 的高分配遍历。

后续已完成：

1. 查询上下文 provenance 分类器只编译一次；
2. 查询级条件化图编译为 TypedArray 稀疏资产；
3. Local/Transfer 通过 `applyDual()` 共用邻接遍历；
4. 已收敛尺度停止继续迭代；
5. 热循环不再创建权限集合和冻结边对象。

服务器实测结果：

- `prepareAndSolveQueryMs` 约 1065ms；
- 完整具名 A/B 在启用外部 Rerank 时约 12—21 秒；
- Embedding 与外部 Rerank 已成为主要耗时；
- V10 双场求解不再是 80 秒阻塞源。

## 14. 四地图与双内核正交实验

为避免把 Raw KNN 当作唯一公平候选池，具名 A/B 新增四张候选地图：

1. Raw KNN Map；
2. V9 Private KNN Map；
3. V10 Local Map；
4. V10 Transfer Map。

并在固定 Map-K 候选上分别运行：

- V9 Production Kernel；
- V10 Unified-Pure Kernel。

该实验把“地图生成差异”和“排序内核差异”正交分离。

同时新增：

- 地图间 Top-K 交集、并集和 Jaccard；
- 每张地图内的 V9/V10 内核排名跨越；
- V10 Pure 相对 Raw KNN 的排名跨越；
- Query/Local/Transfer/Path/Occupancy 五分量；
- 候选来源与独占来源诊断。

## 15. 2026-07-21「特朗普赢学叙事」实测裁决

查询：

`特朗普赢学叙事`

Top-K：

`20`

Map-K：

`80`

总耗时：

约 `21.4s`，包含外部 Rerank。

### 15.1 地图层结论

地图重合：

| 地图对 | Jaccard |
|---|---:|
| Raw KNN ↔ V9 Private KNN | 0.9048 |
| V9 Private KNN ↔ V10 Local | 0.7391 |
| V10 Local ↔ V10 Transfer | 0.7391 |
| Raw KNN ↔ V10 Local | 0.7391 |
| Raw KNN ↔ V10 Transfer | 0.5385 |

裁决：

- V9 Private Map 对 Raw KNN 是温和矫正；
- V10 Local Map 与 V9 Private Map 保持明显连续性；
- V10 Transfer Map 进一步扩张，但没有随机换域；
- 先前的大幅偏移并非单纯由 Transfer 候选生成造成；
- 双尺度地图确实表现出独特且可用的拓扑性。

### 15.2 内核层结论

在四张不同 Map-K=80 地图上，V10 Pure Kernel 的 Top-K 高度趋同。

典型排名跨越：

- Chunk 8093：Raw `#30` → V10 `#1`，但 Path 仅 `0.0731`；
- Chunk 6852：Raw `#71` → V10 `#4`，但 Path 仅 `0.0387`；
- Chunk 8174：Raw `#44` → V10 `#11`，Path 仅 `0.0011`，主要由 Occupancy `0.1236` 推动；
- 多个 Raw/V9 核心候选 Path 与 Occupancy 接近 0，因而被 V10 内核明显后移。

这说明：

> V10 已经发现真实拓扑信号，但当前排序权限没有按拓扑证据绝对强度校准。

当前问题不再是“V10 是否有拓扑性”，而是：

\[
\text{弱拓扑证据}
\not\Rightarrow
\text{大幅排序权限}
\]

### 15.3 偏移根因的最新定位

四张地图经 V10 内核后几乎收敛到相同头部，因此主要偏移发生在排序内核，而非某一张候选地图。

当前 Pure 线性效用允许：

- 很弱的 Path；
- 中等 Occupancy；
- Local/Transfer 普遍偏高；

共同把低 Raw 排名候选大幅推到头部。

这证明先前的区间推动至少包含两层：

1. 旧式 `(cos + 1) / 2` 造成的 0.5 公共底座；
2. 修复公共底座后，拓扑分量仍缺少证据强度对应的排序权限上限。

第一层已修复。

第二层需要继续做“拓扑权限校准”，而不是删除拓扑。

### 15.4 下一阶段施工原则

后续去噪应遵守：

1. Query 语义仍是基础排序坐标；
2. Local/Transfer 负责提供地图与候选，不自动获得无限排序权；
3. Path/Occupancy 必须根据绝对可信度获得渐进权限；
4. 弱路径只能提供诊断或微调；
5. 连续、闭合、有效域内的强路径才允许产生较大排名跨越；
6. Transfer 独占候选必须通过 Query→Chunk Closure；
7. 不得用简单删除 Transfer 或恢复 V9 手工分数掩盖问题；
8. 所有新权限公式必须有独立开关并可回放旧方程。

当前阶段结论：

> V10 Alpha 已从“发生不可解释的主题区间偏移”推进到“具备可用、独特的拓扑召回，但排序权限仍需去噪校准”。这属于积极的可解释进展，尚不构成生产资格。

---

## 16. 拓扑权限校准后的双赛道复测裁决

### 16.1 权限校准公式

V10 Pure 不再无条件线性叠加 Query、Local、Transfer、Path 与 Occupancy，而改为：

\[
R_{\mathrm{pure}}
=
R_{\mathrm{semantic}}
+
\Delta_{\mathrm{topology}}
\]

其中：

- Query、Local、Transfer 构成语义底座；
- Path、Occupancy 构成拓扑原量；
- Path 绝对强度决定拓扑证据可靠度；
- Query→Chunk Closure 决定拓扑证据能否回到查询正文；
- 拓扑增益受到独立上限约束；
- 默认上限为 `0.08`；
- `legacy_linear` 可精确回放旧线性方程。

默认配置：

```json
{
  "pureScoreMode": "topology_limited",
  "topologyBonusCap": 0.08,
  "topologyPathSaturation": 0.15,
  "topologyReliabilityMode": "path_closure"
}
```

### 16.2 地缘政治致密河网复测

查询：

`特朗普赢学叙事`

结果：

- KNN ↔ V10 Pure：`17/20`；
- V9 Production ↔ V10 Pure：`18/20`；
- Observed ↔ Pure：`19/20`；
- Rerank ↔ Pure：`6/20`；
- 候选超集：147；
- 总耗时约 `21.1s`，包含外部 Rerank。

关键变化：

- Chunk 8093 从 Raw KNN `#30` 提升到 V10 `#13`；
- Path 为 `0.0731`；
- Occupancy 为 `0.3998`；
- 拓扑可靠度为 `0.5269`；
- 最终拓扑增益仅为 `0.0082`。

该结果保留了拓扑独占召回，同时阻止弱证据候选直接跃升榜首。

在地缘政治赛道中，索引叙事完整、Tag 河流网络接近致密。V10 的双尺度地图能够读取：

- 连续事件链；
- 叙事前因；
- 战争阶段迁移；
- 跨时间结构共振；
- Query KNN 未直接表达的历史河道。

当前结果支持：

> 在高信息密度、叙事链完整、Tag 河道质量较高的知识域中，V10 已经具备同时挑战 V9 Production 与外部 Rerank 的能力。

这仍是 Alpha 证据，不等于生产资格，但已不再只是结构探针成功。

### 16.3 AI 行业知识拟合稀疏河网复测

查询为关于 Altman、Fable、Grok 4.5 与 Codex 活动的长文本自然查询。

结果：

- KNN ↔ V10 Pure：`19/20`；
- V9 Production ↔ V10 Pure：`19/20`；
- Observed ↔ Pure：`19/20`；
- Rerank ↔ Pure：`15/20`；
- 候选超集：44；
- 总耗时约 `13.2s`，包含外部 Rerank。

该查询中：

- 大部分候选 Path 为 0；
- Occupancy 有少量读数，但因 Path 可靠度为 0，不再获得拓扑奖励；
- V10 主要表现为 Query/Local/Transfer 三尺度语义重建；
- V10 与 KNN 的排序差距因此有限；
- V9 旧式 D/S/T/C 对低质量、离散河道的经验性补全仍更强。

当前结果支持：

> 在知识分散、事件样本较少、Tag 河道不均匀的知识拟合赛道中，V10 的统一拓扑尚未形成足够可观测路径；V9 的历史 D/S/T/C 工程规则仍具有明显优势。

这不是 V10 理论失败，而是统一几何优势存在明确的数据条件：

\[
\text{V10 拓扑收益}
\propto
\text{河网质量}
\times
\text{路径可观测性}
\times
\text{查询闭合}
\]

### 16.4 双赛道统一裁决

当前不能使用一条笼统结论描述 V9 与 V10。

更准确的判断是：

| 知识域条件 | 当前优势 |
|---|---|
| 高密度、长叙事链、Tag 河道接近致密 | V10 Pure 开始显现统一拓扑优势 |
| 低密度、碎片化、河道不均匀 | V9 Production 的历史 D/S/T/C 补全更稳 |
| 正文直接相关性极强 | 外部 Rerank 仍是重要独立裁判 |
| Path 不可观测 | V10 应退化为受控双尺度语义地图，而非伪造拓扑奖励 |

因此下一阶段不应：

- 为两类知识域复制两套 V10 人格；
- 在稀疏图中强行制造 Path；
- 把 V9 D/S/T/C 整体搬回 V10 Pure；
- 因致密图成功就立即替换 V9；
- 因稀疏图无明显增益就删除 Transfer。

下一阶段应新增查询级“河网质量”诊断，至少记录：

- 有效域内边密度；
- 候选曲线可支持片段率；
- 非零 Path 候选率；
- 平均有效路径长度；
- Local/Transfer 支持重合；
- Query→Chunk Closure 分布；
- 拓扑增益出手率；
- 拓扑增益总质量。

该诊断首先只用于解释和分桶跑分，不立即参与排序。

### 16.5 Gated 臂裁决

两组复测中：

- 地缘政治查询 Gated ↔ Pure：`7/20`；
- AI 行业查询 Gated ↔ Pure：`11/20`。

当前 Gated 仍表现为失败实验臂。

根因仍是：

> “没有触发违规”不等于“与查询相关”。

现有乘法门控会使低基础分但未受处罚的候选产生相对上浮。Gated 必须继续保持独立实验身份，不得成为 V10 默认排序臂，也不得用于否定 Pure 的统一内核。

### 16.6 数值探针验收

静态检查、配置解析和拓扑权限探针全部通过。

探针结果：

| 场景 | 语义底座 | 拓扑增益 | 最终分 |
|---|---:|---:|---:|
| 极弱 Path、较高 Occupancy | 0.6267 | 0.0008 | 0.6275 |
| 中等 Path、中等 Occupancy | 0.6267 | 0.0046 | 0.6313 |
| 强 Path、强 Closure | 0.6267 | 0.0450 | 0.6717 |

同时确认：

- `legacy_linear` 与旧线性方程精确一致；
- 弱 Path 增益小于 `0.001`；
- 中等 Path 增益严格低于 `0.08`；
- 强 Path 增益仍受上限约束；
- 所有最终分保持在 `[0,1]`。

最终阶段裁决：

> V10 Alpha 已证明其拓扑信号真实存在，并在致密叙事河网中表现出独立产品价值；拓扑权限校准显著降低了此前的主题区间偏移。当前主要研究对象已从“V10 是否有效”转为“统一几何在何种河网质量下有效，以及如何在稀疏河道中保持诚实退化”。V9 Production 继续作为稀疏河道和历史工程经验的强裁判，V10 不在内部模拟 V9 人格。