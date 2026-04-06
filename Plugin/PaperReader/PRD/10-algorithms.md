# 10. Algorithms

> 状态: Draft
> 所属: PaperReader Rust DDD PRD

---

## 1. 目标

本文件不写实现细节代码，而定义：

- 新系统真正需要哪些核心算法
- 每个算法的输入输出是什么
- 它们分别服务于哪个 bounded context
- 信息论约束如何变成具体算法原则

---

## 2. 算法全景

建议第一版至少包含 8 组核心算法：

1. `StructureTreeBuild`
2. `SegmentPlan`
3. `AttentionTriage`
4. `SkimSummarize`
5. `DeepDiveSummarize`
6. `AuditDiff`
7. `ClaimAlign`
8. `ConflictScore`

另外建议保留两类支持算法：

- `EvidenceRerank`
- `ResearchGraphPlan`

---

## 3. StructureTreeBuild

### 3.1 问题

MinerU 给出的是解析结果，但系统仍需构建自己的 `StructureTree`，以支撑：

- 章节级 triage
- segment 边界规划
- 检索结构过滤

### 3.2 输入

- `MinerURawResult`
- 标准化 block 列表
- heading / page / asset / layout 元信息

### 3.3 输出

- `StructureTree`
- 每个 node 的 `section_path`
- 每个 node 到 block 范围的映射

### 3.4 原则

- heading 层级优先
- 若 heading 缺失，允许按 layout + lexical cues 推断局部层级
- 图表、附录、参考文献需显式挂入树中，不能沦为孤块

---

## 4. SegmentPlan

### 4.1 问题

`Segment` 不是固定 token 切块，而是兼顾：

- 语义完整性
- 上下文预算
- 引用稳定性

### 4.2 输入

- `NormalizedDocument`
- `StructureTree`
- token budget 配置

### 4.3 输出

- `Segment[]`
- 每个 segment 的 boundary reason
- segment 到 node/block 的映射

### 4.4 原则

- 优先保证 claim 与支撑证据不被切开
- 表格和图注尽量与引用正文同 segment
- 若超长章节无法整体保留，则优先沿子结构切分
- 输出必须可解释：为什么在这里切

### 4.5 算法气质

它应被看作一个**率失真优化器**，而不是文本裁纸机。

---

## 5. AttentionTriage

### 5.1 问题

系统需要决定对哪些 segment：

- `deep`
- `skim`
- `skip`

### 5.2 输入

- `goal`
- `StructureTree`
- `Segment[]`
- 可选的 `Collection Map`

### 5.3 输出

- `AttentionPlan`
- 每个 segment 的 allocation 与 rationale

### 5.4 原则

- 不只是判断“相关不相关”
- 要估计边际信息增益
- 要考虑当前上下文预算
- 要保留探索未知和发现反例的能力

### 5.5 推荐评分项

- `goal_match`
- `structure_role`
- `novelty`
- `evidence_potential`
- `exception_potential`

---

## 6. SkimSummarize

### 6.1 问题

`skim` 的任务不是偷懒，而是：

- 保留必要线索
- 尽量不污染主上下文

### 6.2 输入

- `Segment`
- `goal`

### 6.3 输出

- `SegmentSummary`
- `upgrade_signal`

### 6.4 原则

- 输出一到两层：局部要点 + 升级建议
- 如果发现强相关异常点，应触发 `upgrade_to_deep`
- 不把 skim 结果自动写入主 `RollingContext`

---

## 7. DeepDiveSummarize

### 7.1 问题

深读不是复述，而是为当前 `goal` 生成高价值理解状态。

### 7.2 输入

- `Segment`
- `goal`
- `RollingContext`

### 7.3 输出

- `SegmentSummary`
- `PatchContext`
- `local EvidenceRef[]`

### 7.4 原则

- 明确区分事实、解释、限制、疑点
- 不能把 claim 和 evidence 混为一谈
- 应把未来会影响 routing 的线索显式提炼出来

---

## 8. AuditDiff

### 8.1 问题

深读过程存在叙事惯性偏见，必须通过审计层纠偏。

### 8.2 输入

- `Segment`
- `SegmentSummary`
- `PatchContext`
- `goal`

### 8.3 输出

- `AuditReport`
- `omissions`
- `downplays`
- `misinterpretations`
- `patch_suggestions`

### 8.4 原则

- 审计上下文必须尽可能干净
- 重点审查限制条件、反例、负结果、边界说明
- 输出不只是“对/错”，还要告诉系统该如何修补状态

---

## 9. ClaimAlign

### 9.1 问题

多文档综合时，系统必须把不同说法对齐到可比较 claim。

### 9.2 输入

- 多个文档的 `ClaimUnit[]`
- 对应 `EvidenceRef[]`
- 当前 `goal`

### 9.3 输出

- `AlignedClaimGroup[]`

### 9.4 原则

- 区分真正同 claim 与表面同词
- 允许 partial alignment
- 对定义差异单独标注，不要强行合并
- 记录每个 alignment 的信心与依据

---

## 10. ConflictScore

### 10.1 问题

冲突不能只靠字符串差异判断，需要建模“冲突强度”。

### 10.2 输入

- `AlignedClaimGroup`
- supporting / contradicting `EvidenceRef[]`

### 10.3 输出

- `ConflictItem`
- `severity`
- `conflict_type`

### 10.4 原则

冲突分型至少包括：

- `definition`
- `method`
- `result`
- `interpretation`

严重度评估建议考虑：

- 证据强弱
- 覆盖范围
- 是否直接影响主目标
- 是否只是口径差异

---

## 11. EvidenceRerank

### 11.1 问题

检索候选往往冗余、重复、表面相关，需要重排。

### 11.2 输入

- `RetrievalHit[]`
- `goal`
- 已知状态

### 11.3 输出

- top-k `RetrievalHit[]`
- `EvidencePack`

### 11.4 原则

- 提升证据密度
- 去掉高度重复 hits
- 保留有限数量的反例/限制材料
- 提供 score breakdown 供审计

---

## 12. ResearchGraphPlan

### 12.1 问题

当任务从“读一篇文档”升级为“围绕主题递归研究”时，需要一个规划算法把大问题拆成研究图。

### 12.2 输入

- 顶层 `goal`
- 文档集合与已有工件
- 预算约束

### 12.3 输出

- `ResearchGraph`
- node list
- dependency edges
- stopping conditions

### 12.4 原则

- 子问题必须可执行且可验证
- 优先先 survey，再展开重节点
- merge 节点必须显式存在，不能隐式堆叠答案
- 应支持递归扩展，但要受预算与熔断约束

---

## 13. 算法之间的依赖拓扑

建议拓扑：

```text
MinerU
-> StructureTreeBuild
-> SegmentPlan
-> AttentionTriage
-> SkimSummarize / DeepDiveSummarize
-> AuditDiff
-> EvidenceRerank
-> ClaimAlign
-> ConflictScore
-> ResearchGraphPlan
```

说明：

- 前半段偏单文档
- 中后段进入检索、多文档与编排
- `ResearchGraphPlan` 建立在前面工件能力可复用的基础上

---

## 14. 与 DeepResearch 的可迁移启发

从 `Alibaba-NLP/DeepResearch` 可提炼三点可迁移原则：

1. **工具调用必须显式化**：推理与工具边界清晰，便于轨迹回放
2. **长时任务需要预算护栏**：LLM call limit、time limit、token limit 都要制度化
3. **并行 rollout/graph execution 是能力放大器**：但必须建立在结构化状态和可恢复工件之上

PaperReader 不应照搬它的网页搜索代理实现，但可以吸收其：

- 研究图思维
- 长任务熔断机制
- 工具轨迹可回放

---

## 15. Rust 模块建议

- `algorithms/structure_tree.rs`
- `algorithms/segment_plan.rs`
- `algorithms/triage.rs`
- `algorithms/skim.rs`
- `algorithms/deep_dive.rs`
- `algorithms/audit.rs`
- `algorithms/evidence_rerank.rs`
- `algorithms/claim_align.rs`
- `algorithms/conflict_score.rs`
- `algorithms/research_graph_plan.rs`

---

## 16. 验收问题

- 这些算法是不是围绕信息增益、失真控制与可追溯性构建？
- 每个算法是否有明确输入输出对象，而不是只有 prompt 文本？
- 当任务扩展到多文档和递归研究时，算法能否复用已有工件？
- 算法失败时，是否能留下足够的 trace 供审计与恢复？
