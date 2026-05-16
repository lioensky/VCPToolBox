# TagMemo “浪潮”算法 V8.2 深度技术文档

## 1. 算法概述
TagMemo “浪潮”算法（TagMemo Wave Algorithm）是 VCP 系统中用于 RAG（检索增强生成）的核心优化方案。
V4 版本引入了**语义分段 (Semantic Segmentation)**、**霰弹枪查询 (Shotgun Query)** 和 **SVD智能去重 (Latent Topic Deduplication)**，进一步解决了长上下文中的"语义稀释"问题，实现了对复杂对话流的多点精准召回。
V6 版本在此基础上引入了 **LIF 脉冲扩散 (Spike Propagation)**、**动态核心加权 (Dynamic Core Boost)**、**语言置信度门控 (Language Confidence Gating)** 和 **语义去重 (Semantic Deduplication)**，将标签网络从静态查询跃升为**认知拓扑涌现**。

## 2. 核心哲学：语义引力与向量重塑
在浪潮算法的视角下，向量空间并非平坦的，而是充满了语义引力。
*   **语义锚点**：标签（Tags）被视为空间中的引力源。
*   **向量重塑**：算法不直接使用原始查询向量，而是根据感应到的标签引力，将向量向核心语义点进行“拉扯”和“扭曲”，从而在检索时能够穿透表层文字，直达语义核心。

### 2.1 语义动力学假设（V6 根基）
V6 建立在一个严格的核心假设之上：

> **AI 在撰写日记时最终生成的标签序列，具有严格紧密的逻辑意义——无论是标签的顺序、每个标签之间的能量差，还是这些标签为何共同出现——都蕴含着不可忽视的语义结构信息。**

这意味着：
*   **共现即关联**：两个标签频繁在同一篇日记中共现，说明它们之间存在深层的认知联系。
*   **频次即突触强度**：共现次数越高，两个概念之间的"突触连接"越强。
*   **标签网络即认知拓扑**：所有日记标签的共现关系，天然构成一张**加权无向图**——这就是 V6 脉冲扩散的神经网络基底。

这张共现拓扑图通过 `_buildCooccurrenceMatrix()` 在系统启动时构建，数据源为 `file_tags` 表的自连接：
```sql
SELECT ft1.tag_id as tag1, ft2.tag_id as tag2, COUNT(ft1.file_id) as weight
FROM file_tags ft1
JOIN file_tags ft2 ON ft1.file_id = ft2.file_id AND ft1.tag_id < ft2.tag_id
GROUP BY ft1.tag_id, ft2.tag_id
```
结果为对称填充的 `Map<tagId, Map<neighborId, weight>>`，是 V6 脉冲扩散的拓扑骨架。

## 3. 核心模块架构

### 3.1 EPA 模块 (Embedding Projection Analysis)
[`EPAModule.js`](EPAModule.js) 负责语义空间的初步定位。
*   **逻辑深度 (Logic Depth)**：通过计算投影熵值，判断用户意图的聚焦程度。
*   **世界观门控 (Worldview Gating)**：识别当前对话所处的语义维度（如技术、情感、社会等）。
*   **跨域共振 (Resonance)**：检测用户是否同时触及了多个正交的语义轴，决定检索的广度。

### 3.2 残差金字塔 (Residual Pyramid)
[`ResidualPyramid.js`](ResidualPyramid.js) 是算法的“数学心脏”，负责语义能量的精细拆解。
*   **多级剥离**：利用 **Gram-Schmidt 正交化投影**，将查询向量分解为“已解释能量”和“残差能量”。
*   **微弱信号捕获**：通过对残差向量的递归搜索，捕捉那些被宏观概念掩盖的微弱语义信号。
*   **相干性分析 (Coherence)**：评估召回标签之间的逻辑一致性，决定“浪潮”的激活强度。

### 3.3 知识库管理器 (KnowledgeBaseManager)
[`KnowledgeBaseManager.js`](KnowledgeBaseManager.js) 负责标签的召回与向量合成。
*   **核心标签 (CoreTags)**：拥有“虚拟召回”和“权重豁免”特权，作为语义的绝对锚点。
*   **逻辑拉回 (Logic Pull-back)**：利用标签共现矩阵，自动联想并拉回与当前主题强相关的逻辑词。
*   **语义去重**：消除冗余标签，确保召回信息的多样性。

### 3.4 偏振语义舵 (Polarization Semantic Rudder, PSR)
[`RAGDiaryPlugin.js`](Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js) 中的核心工程化函数。
*   **犹豫度检测 (Hesitation Detection)**：利用 NLP 解析识别输入输出中的转折与摇摆成分。
*   **动态偏振算法 (Dynamic Polarization)**：物理动态化语义向量在投影上的摆动程度。
*   **辩证对冲**：在召回阶段引入“同类知识”的“负向对冲知识”，构建辩证认知。

### 3.5 结果去重器 (ResultDeduplicator)
[`ResultDeduplicator.js`](ResultDeduplicator.js) 是 V4 新增的"智能过滤器"。
*   **SVD 主题建模**：对"霰弹枪"检索回来的海量结果进行 SVD 分解，识别出本次检索的 n 个潜在主题 (Latent Topics)。
*   **残差选择 (Residual Selection)**：使用 Gram-Schmidt 正交化，迭代选择能解释"未覆盖主题能量"的最佳结果。该机制确保了检索结果的多样性，既能覆盖主要意图，又能保留那些微弱但独特的重要信息 (Weak Links)，同时彻底消除语义重复的冗余条目。

## 4. 详细工作流

### 阶段一：感应 (Sensing)
1.  **净化处理**：移除 HTML标签、json结构化转md、Emoji 及工具调用标记（Tool Markers），消除技术噪音。
2.  **EPA 投影**：计算原始向量的逻辑深度和共振值，确定初始语义坐标。

### 阶段二：分段与分解 (Segmentation & Decomposition)
1.  **语义分段**：`ContextVectorManager` 扫描历史上下文，基于向量相似度（阈值 0.70）将连续对话流切割为独立的语义段落 (Topics)。
2.  **首轮感应**：使用当前查询向量投射 Tag 向量海，获取最强匹配标签 (CoreTag)。
3.  **金字塔迭代**：对当前向量进行残差分解，挖掘深层标签。

### 阶段三：扩张与召回 (Expansion & Recall)
1.  **核心标签补全**：若显式指定的核心标签未被搜到，强行从数据库捞取其向量。
2.  **关联词拉回**：根据共现矩阵，从高权重标签扩展出关联语义。
3.  **特权过滤**：核心标签无条件保留，普通标签需通过世界观门控筛选。

### 阶段四：重塑与检索 (Reshaping & Retrieval)
1.  **动态参数计算**：
    *   **Beta (TagWeight)**：根据逻辑深度和共振值动态决定标签增强的比例。
    *   **K 值调整**：根据信息量动态决定检索片段的数量。
2.  **向量融合**：将原始向量与增强标签向量按动态比例混合，实现“语义坍缩”。
3.  **偏振修正 (PSR Correction)**：
    *   检测上下文中的语义偏振信号。
    *   若触发犹豫机制，计算偏振向量投影。
    *   根据偏振强度，计算对冲检索参数。
4.  **霰弹枪检索与相控阵去重 (Shotgun & Deduplication)**：
    *   **霰弹枪发射**：并行执行 N+1 次检索（1次当前向量 + N次历史分段向量），最大限度覆盖长上下文中的所有潜在关注点。
    *   **SVD 建模**：对汇聚的数百条候选结果进行 SVD 分析，提取潜在主题。
    *   **残差去重**：迭代选择最具信息增量的结果，形成最终的精简结果集（通常为 Top K）。
    *   **对冲召回**：若偏振触发，同步混入对冲检索结果。

## 5. 工程原理亮点

### 5.1 核心标签 vs. 普通标签
| 特性 | 核心标签 (Core Tags) | 普通标签 (Other Tags) |
| :--- | :--- | :--- |
| **产生方式** | 显式指定或首轮强感应 | 残差金字塔逐层剥离 |
| **缺失处理** | **虚拟补全**（强行捞取） | 自动忽略 |
| **权重待遇** | **Core Boost** (1.2x-1.4x) | 原始贡献权重 |
| **噪音过滤** | **完全豁免** | 严格门控筛选 |

### 5.2 动态 Beta 公式
[`RAGDiaryPlugin.js`](Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js) 中算法通过以下公式实现能量平衡：
`β = σ(L · log(1 + R) - S · noise_penalty)`
该公式确保了：当用户意图明确（L高）且逻辑清晰（R高）时，算法会加大标签增强力度；当噪音较多（S高）时，则收紧增强，回归稳健检索。

### 5.3 噪音净化器 (Sanitizer)
为了防止 AI 的技术标记干扰向量搜索，算法实现了专门的工具调用净化逻辑，确保向量化的是纯粹的“人类语义”，而非“机器指令”。

### 5.4 辩证认知器 (Dialectical Cognitizer)
V4 版本引入的 PSR 机制本质上是一个可量化、可控制的辩证认知器。它不再盲目追求语义的绝对一致性，而是通过捕捉人类思维中的“犹豫”与“摇摆”，主动提供对冲信息，从而打破 AI 的“回声壁垒”，实现更深层次的逻辑闭环。

## 6. V6 新特性：认知拓扑涌现 (`_applyTagBoostV6`)
V6 带来了系统化的大规模重构，在保留 V4 优势的基础上，围绕"语义动力学"引入了多项核爆级更新。其核心代码主要集中在 `KnowledgeBaseManager.js` 中的 `_applyTagBoostV6` 方法内。

### 6.1 七步执行管线
V6 的单次向量增强流水线被扩展为 7 个严密的阶段：
1.  **EPA 定位**：计算"逻辑深度" (Logic Depth) 与跨域"共振" (Resonance)，确定当前所处的"世界" (Query World)。
2.  **残差金字塔拆解**：获取新颖度 (Novelty) 与覆盖率 (Coverage)。
3.  **动态基准调优 (Dynamic Boost & Core Boost)**：基于前两步特征，动态计算全局激增因子与**核心标签专门放大因子**（范围通常在 1.20 - 1.40）。
4.  **世界观与语言门控 (Language Compensation)**：所有候选 Tag 在进入脑网前，必须先经过过滤：若英文技术词汇脱离了技术语境（进入如政治、社会语境），其权重将被严格压制（软化惩罚）。
5.  **LIF 脉冲扩散 (Spike Propagation)**：🌟 V6 最核心的突破，通过突触关联矩阵让高能标签在拓扑图上发生电波传导。
6.  **语义去重 (Semantic Deduplication)**：对所有涌现及召回的标签计算相似度，融合高度冗余语义（如"委内瑞拉局势"与"委内瑞拉危机"），为特征多样性腾出空间。
7.  **最终融合 (Vector Fusion)**：防止超量重塑，使用 Clamp 和归一化处理最终输出向量。

### 6.2 LIF 脉冲扩散 (Spike Propagation)
传统 RAG 中，标签是被孤立搜索的。V6 引入了类神经元 (Leaky Integrate-and-Fire, LIF) 的放电网络：
1. **初始注入**：查询命中的种子 Tags 作为初始激活节点，其能量等于它原本的命中权重。
2. **突触传导**：只要一个节点的能量超过极高的触发门槛（`FIRING_THRESHOLD = 0.10`），它就可以沿着 `tagCooccurrenceMatrix` 向相邻节点**放电**。
3. **电位衰减**：传导电流遵循 `injectedCurrent = energy * coocWeight * DECAY_FACTOR`，强衰减机制防止能量无限放大。
4. **认知涌现**：经历 `MAX_HOPS = 2` 跳的狂暴扩散后，即使某些概念从未在字面上被提及，由于其在长期记忆里与活跃标签紧密相连，电位也会瞬间突破阈值被"涌现"出来（被标记为 `isPullback: true`）。
*为了工程鲁棒性，涌现节点总数被硬性截断（`MAX_EMERGENT_NODES = 50`），且微电流 (<0.01) 不参与计算。*

### 6.3 动态参数调控 (`rag_params.json` 热更新)
为了终结写死参数的历史，V6 将大量控制杆提取为外部热更新配置：
*   `activationMultiplier` / `dynamicBoostRange` / `coreBoostRange`
*   `languageCompensator` (惩罚阈值)
*   `deduplicationThreshold` (去重相似度门槛，如 0.88)
*   `techTagThreshold` / `normalTagThreshold` (召回纯净度过滤)

## 7. 结论
TagMemo 浪潮算法不仅解决检索问题，更是从系统底层试图模拟人类思考时的"隐性连接"与"直觉联想"。
*   **V4** 通过**偏振语义舵**实现了从单一线性检索到多角度辩证召回的跨越。
*   **V6** 则在**语义动力学**的严格假设上，通过构建共现拓扑并结合 **LIF 脉冲扩散**，让系统真正具备了**直觉涌现**的能力；配合**语言门控**与**核心加权**，做到了在海量信息噪音中"形散而神不散"。
它是整个 VCP 知识库在深层语义操纵上的王冠。

## 8. V7 进化：有向联想与内生残差 (OrdinalSpike)
2026年3月推出的 V7 版本（代号：**OrdinalSpike / 序位脉冲**）是对浪潮算法的一次底层重构，将标签网络从“无向加权图”进化为“有向序位拓扑”，并引入了基于 SVD 的信息增益控制。

### 8.1 核心突破：有向序位拓扑
V7 实现了 V2时代 提出对“对称共现”质疑，引入了**序位势能 (Ordinal Potential)**：
*   **有向连接**：建立了 `Source → Target` 的有向边。人类联想是具有方向性的（例如：看到“壁炉”容易想到“猫”，但看到“猫”不一定想到“壁炉”）。
*   **势能衰减**：日记中排在前面的标签拥有更高的“势能” ($\Phi \in [0.9, 0.5]$)。共现权重不再仅是次数叠加，而是势能的积 $W = \Phi_{source} \times \Phi_{target}$。这反映了作者在打标签时的心理优先级。

### 8.2 数学心脏：内生残差 (Intrinsic Residual / 语义残差能量)
V7 引入了一个革命性的概念——**内生残差**，用于衡量一个概念在局部联想网络中的“信息密度”或“不可替代性”。
1.  **计算原理**：在 `rust-vexus-lite` 核心中，利用截断 SVD 对每个 Tag 的有向邻居子空间进行分解。
2.  **残差能量**：计算该 Tag 向量在其邻居子空间投影后的残差模长。
    *   **低残差**：该 Tag 的语义可以被其邻居完全解释（平庸、从属概念）。
    *   **高残差**：该 Tag 带有邻居不具备的独特语义（核心、独特信息源）。
3.  **增益控制**：在脉冲扩散阶段，残差能量作为 **Node Residual Gain** 直接作用于放电强度。高残差节点（信息枢纽）具有更强的电波传导能力。

### 8.3 工程优化：防抖与阈值触发 (V7.1/V7.2)
由于 Rust SVD 计算较为昂贵，V7 实现了精细化的重构调度：
*   **1% 变动阈值**：只有当 `file_tags` 实际写入量达到总标签数的 1% 时，才会触发全量矩阵重建。
*   **静默防抖**：对小规模变动开启 120 秒防抖计时，确保在批量导入或高频写作时系统负载平稳。

### 8.4 动态精准虫洞路由 (Wormhole Routing / Variable Hops)
在 V7 的最终迭代中，为了解决“稠密陷阱”（脉冲在同质化、高聚集的标签区内空耗算力打转）的问题，引入了基于张力的虫洞逻辑：
1. **动量机制 (Momentum/TTL)**：废除全局死板的固定跳数（两跳限制），为每个初始脉冲赋予动量。普通稠密区的传播会迅速扣除动量并遭遇强衰减（`baseDecay`），确保“引力底座（涨潮）”阶段精准收敛，牢牢锁定核心意图。
2. **逻辑张力探测 (Logical Tension)**：在脉冲撞击目标节点时，实时探测其逻辑张力（`Tension = coocWeight * neighborResidual`）。只有当残差极高（跨域新颖度大）且共现强关联的边缘节点被击中时，才能触发“虫洞”。
3. **引力弹弓效应 (Slingshot Effect)**：进入虫洞的脉冲获得特权（免消耗动量，极低衰减 `wormholeDecay`），从而将稠密区聚集的庞大势能瞬间喷射向长尾、稀疏但致命相关的远端知识点（跨域非线性涌现）。

## 10. V8 进化：测地线重排 (Geodesic Rerank)
2026年4月推出的 V8 版本（代号：**GeodesicRerank / 测地线重排**）发现了一个被忽视的宝藏：Spike Propagation 计算过的 `accumulatedEnergy` 距离场在搜索完成后被丢弃了。V8 把它捡回来，用于对 KNN 候选做基于"地形贴地距离"的二次重排。

### 10.1 核心洞察：贴地线是直线的超集
KNN 余弦距离等价于在高维空间画一条"穿山直线"。但 embedding 空间并非平坦——标签共现矩阵在语义空间中构成了"地形"。

```
情况 A：平坦区域（日常对话）
  Q ─────────── Chunk1    KNN 和测地线一致 → 零风险

情况 B：存在语义山峰（跨域/多义词）
  Q ─── ╱╲ ─── Chunk2    KNN 穿山（余弦近但语义远）
       │  └──── Chunk3    测地线绕山（余弦远但Tag拓扑近）
                          → 重排把 Chunk3 提上来！
```

**激活方式**：`::TagMemo+` 修饰符（`::TagMemo` 的超集，同时激活标签增强 + 测地线重排）

### 10.2 算法实现：零额外计算的距离场复用
1. **距离场缓存**：`applyTagBoost()` 内部的 Spike Propagation 结束后，将 `accumulatedEnergy`（`Map<tagId, energy>`）缓存到 `TagMemoEngine.lastEnergyField`。成本：1 行赋值，零拷贝。
2. **`geodesicRerank(candidates, options)`**：
   - 批量查询 `chunk_id → file_id → tag_id[]` 映射（2 次 SQL）
   - 对每个候选：遍历其关联 Tag，在距离场中查找命中能量
   - `geoScore = totalEnergy / hitCount`（命中 Tag 的平均能量）
   - 归一化后混合：`finalScore = (1-α) * knnScore + α * normalizedGeoScore`
   - 按 finalScore 降序排列，**只重排不截断**

### 10.3 三层防御链
| 层级 | 条件 | 行为 |
|:--|:--|:--|
| L0 | `lastEnergyField` 为空 | 整个 geodesicRerank 退化，返回原数组 |
| L1 | chunk 的 `hitCount < minGeoSamples` | 该 chunk 的 geoScore = 0（采样密度不足） |
| L2 | 所有 chunk 的 maxGeo = 0 | 归一化跳过，全部走纯 KNN 排序 |

**最坏情况 = 不改动**（纯 KNN 排序结果原样返回）。

### 10.4 最小采样密度门槛 (MIN_GEO_SAMPLES)
莱恩在设计评审中提出的关键补充：如果一个 chunk 在距离场上只"踩到"了 1~3 个 Tag，统计上无法可靠估计测地线距离。设定门槛为 4，同时自然消除了"万能 Tag 误拉"问题（只命中 1 个高频 Tag 的 chunk 被动过滤）。

### 10.5 热调参
```json
"KnowledgeBaseManager": {
    "geodesicRerank": {
        "alpha": 0.3,        // 测地线混合权重 (0=纯KNN, 1=纯测地线)
        "minGeoSamples": 4   // 最小采样密度门槛
    }
}
```

### 10.6 与后续管线的协作
```
KNN 搜索 → TagBoost 向量增强 → [V8] 测地线重排 → TimeDecay → Rerank/Rerank+ → 最终截断
```
测地线重排位于 Rerank 之前，候选池不被截断，确保交叉编码器精排拥有完整的候选空间。

## 11. V8.2 进化：有序双向势能流形 (Ordered Bidirectional Potential Manifold)
2026 年 5 月推出的 V8.2 版本（代号：**OrderedBidirectional / 有序双向势能流形**）不是普通"优化"，而是对 V7 一处底层不自洽的**修正**——让 JS 侧 Spike Propagation 走的传播图与 Rust 侧 `compute_intrinsic_residuals` 用的预计算图（`i != j` 双向邻接）回到同一个度规上。

### 11.1 哲学起点：时序不是拓扑
V7 出于"叙事方向"考虑，把两件事焊死在一根边里：
- **拓扑邻接（形）**：A 和 B 在同一篇日记里出现 → 是否邻接
- **叙事方向（色）**：A 在 B 之前被写下 → 顺序

把它们焊死的代价是：B → A 的回溯联想被硬切。但记忆不是单向 DAG——查询"逻辑主权"应该能溯源到"VCP 架构 / 上下文折叠 / 引力场 RAG"。

V8.2 把两轴重新解开，并显化了第三轴：
| 轴 | 模型 | 作用 |
|:--|:--|:--|
| 拓扑层（形） | 双向共现 | 是否邻接，对称 |
| 方向层（色） | 顺/逆流阻尼 | 叙事方向，不对称 |
| 语义层（质） | 向量距离调制 | 语义邻近度，对称 |

> "V7 是叙事箭头，V8.2 是叙事流体力学。河道有主流也有回流，有深浅也有摩擦。但不再有人工硬墙。"

### 11.2 三层正交存储结构
V8.2 第一次让 TagMemo 拥有完整的"语义流形度规"：
```
┌─────────────────────────────────────────────┐
│  SQLite 持久化层 (跨重启稳定)                 │
│  ├─ tags                                    │
│  ├─ file_tags                               │
│  ├─ tag_intrinsic_residuals      节点质量    │
│  └─ tag_pair_similarity      ◀ 新增,边距离  │
├─────────────────────────────────────────────┤
│  Rust SIMD 计算层                            │
│  ├─ recoverFromSqlite                       │
│  ├─ computeIntrinsicResiduals               │
│  └─ computePairwiseSimilarities  ◀ 新增     │
├─────────────────────────────────────────────┤
│  JS 内存运行时层 (会话临时态)                 │
│  ├─ tagCooccurrenceMatrix       (有序双向)  │
│  ├─ tagIntrinsicResiduals       Map         │
│  ├─ tagPairSimilarities         Map ◀ 新增  │
│  └─ lastEnergyField             距离场       │
└─────────────────────────────────────────────┘
```
节点质量（`tag_intrinsic_residuals`）+ 边距离（`tag_pair_similarity`）+ 临时拓扑（内存矩阵）= 完整的语义流形度量。Rust 算物理量，SQLite 存物理量，JS 用物理量，各司其职。

### 11.3 算法核心：双向阻尼 + 残差锚 + 钟形语义增益
对每对共现 Tag (t1, t2)，构建两条边：
```
forwardWeight  = baseWeight × FORWARD_GAIN     × semanticGain(sim)
backwardWeight = baseWeight × dynamicReverseGain × semanticGain(sim)
backwardWeight = min(backwardWeight, forwardWeight × 0.95)   // 反转守卫
```
其中：
- `baseWeight = phi1 * phi2 * exp(-distanceDecay * (delta - 1))` —— 序位势能（V7 沿用）+ 序位距离衰减（V8.2 新增，默认关闭）
- `dynamicReverseGain = reverseGain × min(REVERSE_ANCHOR_MAX, anchorMass)` —— 概念锚 boost：高内生残差的源头节点更适合作为逆流目标
- `semanticGain(sim)` —— 钟形函数（见 11.4），对称项

### 11.4 钟形语义增益：黄金区放大 + 同义词抑制
朴素直觉是 "sim 越高 gain 越高"，但实际上**同义词冗余**会污染传播：
```
sim → 1   : 同义复读 → 传播了寂寞
sim → 0.7 : 概念邻接 → 真正的联想黄金区
sim → 0   : 偶然共现 → 噪声
```
所以采用钟形函数：
```js
function semanticGain(sim) {
    if (sim < 0.15) return 0.4 + sim * 1.0;        // 软底 0.40 ~ 0.55（噪声边沉到地形低洼）
    return 0.5 + 0.8 * exp(-((sim - peak)² / (2σ²)));  // 中段高斯钟形
}
```
形状特性：
- 低 sim 区：噪声边自然弱化但不切断
- 中段 peak（默认 0.65）：概念邻接黄金区放大
- 高 sim 区：钟形右侧自然衰减，抑制同义词回音壁

### 11.5 持久化语义距离表 (`tag_pair_similarity`)
SQLite 新增表：
```sql
CREATE TABLE tag_pair_similarity (
    tag_a INTEGER NOT NULL,
    tag_b INTEGER NOT NULL,           -- 约定 tag_a < tag_b
    similarity REAL NOT NULL,         -- [-1, 1] 余弦，不预归一化
    model_sig TEXT NOT NULL,          -- 模型签名 (含维度)，跨模型自动失效
    computed_at INTEGER NOT NULL,
    PRIMARY KEY (tag_a, tag_b),
    FOREIGN KEY (tag_a) REFERENCES tags(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_b) REFERENCES tags(id) ON DELETE CASCADE
);
```
关键决策：
- **FK + CASCADE**：Tag 删除自动清理 sim，不留孤儿
- **model_sig 含 dimension**：使用 `sha256(model:dim).slice(0, 16)`，防止 `VECTORDB_DIMENSION` 切换后读到维度错位的 BLOB
- **不存低 sim**：Rust 侧设阈值 `min_similarity = 0.05`，把表大小从 1250 万压到 5~10 万
- **不预归一化**：原始余弦存表，钟形函数留在 JS 侧调形

### 11.6 Rust 异步预计算：computePairwiseSimilarities
```rust
#[napi]
pub fn compute_pairwise_similarities(
    &self,
    db_path: String,
    model_sig: String,
    min_similarity: Option<f64>,
    full_rebuild: Option<bool>,
) -> AsyncTask<PairwiseSimTask>
```
执行流程：
1. 加载 Tag 向量到 `HashMap<i64, Vec<f32>>`
2. 在 Rust 侧聚合 `file_tags`，构建实际共现的 `(a, b)` pair 集合（单文件 ≤100 守恒）
3. 增量模式：跳过 `model_sig` 一致的已缓存 pair
4. 遍历待计算 pair，余弦计算，sim < `min_similarity` 丢弃
5. 事务批量 INSERT OR REPLACE（chunks(1000) 分批 commit）

性能：5000 tags × 5~10 万对实际共现 < 5 秒（Release 构建）

### 11.7 七条工程纪律
| # | 纪律 | 落点 |
|:--|:--|:--|
| 1 | 反转守卫 `backwardWeight ≤ forwardWeight × 0.95` | 保叙事方向公理 |
| 2 | 冷启动阻塞：首次 sim 表为空时必须 await | 防 getSim 全 0 压平整张矩阵 |
| 3 | model_sig 必须含 dimension | 防 `VECTORDB_DIMENSION` 切换后维度错位 |
| 4 | sim 预计算与矩阵重建共用 `_isMatrixRebuilding` 锁 | 防嵌合矩阵 |
| 5 | 低 sim fallback = 0.1 而非 0 | 与"刚好被丢"语义解耦 |
| 6 | Gemini 分布右移压缩，peak 不能照搬 OpenAI | 必须先扫真实分布直方图 |
| 7 | `tags.vector` 重写时 DELETE 涉及该 tag 的 sim 行 | 防陈旧缓存污染 |

## 12. 总结
从 V4 的线性检索，到 V6 的无向扩散，V7 的有向势能与虫洞路由，到 V8 的测地线重排，再到 V8.2 的有序双向势能流形，TagMemo 算法不断逼近人类大脑的认知与联想本质。

每一代的工程哲学都不一样：
- **V4** 通过偏振语义舵实现了从单一线性检索到多角度辩证召回的跨越
- **V6** 在严格的语义动力学假设上，通过 LIF 脉冲扩散让系统具备了"直觉涌现"
- **V7** 用有向势能 + 虫洞路由解决了"稠密陷阱"，让脉冲精准穿透同质化区域
- **V8** 证明了"最好的优化不是引入新计算，而是发现已有计算中被丢弃的宝藏"——Spike Propagation 的距离场就是一张语义等高线图
- **V8.2** 修正了 V7 的底层不对称（JS 单向 vs Rust 双向），把"形 / 色 / 质"三轴正交化，让叙事不再是箭头而是流体——河道可以逆流，但要付能量代价

V8.2 之后，TagMemo 第一次真正配得上"流形"两个字。