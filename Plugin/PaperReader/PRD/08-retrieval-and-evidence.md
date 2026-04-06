# 08. Retrieval and Evidence

> 状态: Draft
> 所属: PaperReader Rust DDD PRD

---

## 1. 目标

`Retrieval Context` 负责回答一个核心问题：

**在给定 `goal` 与当前状态下，系统如何以最小上下文成本取回最有解释力的证据包。**

它不是普通的“相似文本搜索层”，而是：

- 面向 `goal` 的证据选择器
- 连接单文档阅读与多文档综合的中介层
- 所有结论可追溯性的基础设施

---

## 2. 基本原则

本层遵循以下硬原则：

1. **证据优先于摘要**：先找证据，再生成结论
2. **结构优先于裸相似度**：优先利用 `StructureTree`、section、block、caption、table 关系缩小空间
3. **最小证据包原则**：尽量用更小的上下文包提供足够支撑
4. **跨层追溯原则**：每条 evidence 都必须能追到 document -> segment -> block/asset
5. **可组合原则**：单文档检索与多文档检索共享同一 `EvidenceRef` 契约

---

## 3. 核心对象

### 3.1 RetrievalRequest

建议字段：

- `request_id`
- `goal`
- `scope` (`document` | `collection`)
- `document_ids`
- `query_text`
- `query_type`
- `filters`
- `budget`

### 3.2 RetrievalHit

建议字段：

- `hit_id`
- `document_id`
- `segment_id`
- `block_refs`
- `score`
- `score_breakdown`
- `reason`
- `snippet`

### 3.3 EvidenceRef

建议字段：

- `evidence_id`
- `document_id`
- `segment_id`
- `block_ids`
- `asset_refs`
- `locators`
- `citation_text`

### 3.4 EvidencePack

建议字段：

- `pack_id`
- `goal`
- `query_text`
- `scope`
- `evidence_refs`
- `coverage_notes`
- `omission_risks`
- `generated_at`

---

## 4. 检索问题类型

系统至少要区分 5 类检索意图：

### 4.1 FactLookup

寻找明确事实、数值、定义、结论。

### 4.2 ClaimSupport

围绕某个命题寻找支持或反驳证据。

### 4.3 MethodTrace

寻找方法步骤、实验设计、算法流程。

### 4.4 ComparativeRetrieval

为比较任务取回多个文档中的可对齐片段。

### 4.5 GapOrExceptionSearch

主动寻找限制、失败条件、反例、边界说明。

这类检索非常关键，因为它直接支撑 `Audit` 与 `ConflictAudit`。

---

## 5. 检索流水线

建议采用四段式流水线：

```text
GoalParse
-> StructuralFilter
-> SemanticRecall
-> EvidenceRerank
-> EvidencePackBuild
```

### 5.1 GoalParse

职责：

- 识别当前检索属于哪种 query type
- 提取关键实体、主题轴、约束条件
- 形成结构化检索请求

### 5.2 StructuralFilter

职责：

- 利用 document/section/segment/block 元数据做第一层裁剪
- 优先过滤明显无关区域
- 减少语义召回噪声

可用过滤条件包括：

- section title
- content type (`paragraph`, `table`, `caption`, `equation`, `figure_note`)
- page/heading range
- document role in collection

### 5.3 SemanticRecall

职责：

- 对候选 segment/block 做语义召回
- 支持全文向量、claim embedding、section summary embedding 等多层召回

### 5.4 EvidenceRerank

职责：

- 结合结构分、语义分、证据密度、可引用性重新排序
- 去重相似 hits
- 提升上下文紧凑度

### 5.5 EvidencePackBuild

职责：

- 把 top-k hits 整理成最小可用证据包
- 保留 citation 与 locator
- 补充覆盖风险与潜在遗漏说明

---

## 6. Score Breakdown

`RetrievalHit.score_breakdown` 建议显式包含：

- `structural_score`
- `semantic_score`
- `density_score`
- `citation_score`
- `novelty_score`
- `conflict_signal`

解释：

- **structural**：位置与类型是否匹配当前问题
- **semantic**：语义相似度
- **density**：单位上下文中的有效信息量
- **citation**：是否易于追溯引用
- **novelty**：相对已知信息是否提供增量
- **conflict_signal**：是否包含反例/限制/冲突价值

这使检索结果不再是黑盒分数，而是可解释决策对象。

---

## 7. EvidenceRef 设计要求

`EvidenceRef` 是全系统关键值对象，必须满足：

1. **稳定定位**：文档重读后仍能通过 locator 找回
2. **层级可追溯**：至少能回到 `document_id + segment_id + block_ids`
3. **支持资产引用**：图、表、公式、附录不能丢
4. **支持截断引用文本**：供 synthesis/citation 直接使用
5. **支持多文档统一使用**：单文档和集合级流程使用同一格式

建议 `locators` 包含：

- `page`
- `section_path`
- `block_offsets`
- `asset_anchor`

---

## 8. Index Backend Abstraction and Capability Matrix

为了保证检索层在未来可以替换底层索引实现，系统不能只抽象一个模糊的 `RetrievalIndex`，而应把不同索引职责拆开。

建议至少区分：

- `LexicalIndexBackend`
- `VectorIndexBackend`
- `StructuralIndexBackend`
- `EvidenceIndexBackend`
- `IndexCatalog`
- `IndexSnapshot`
- `IndexBuildPlan`
- `IndexBackendCapabilities`
- `RebuildPolicy`

建议 `IndexManifest` 至少包含：

- `index_type`
- `backend_name`
- `schema_version`
- `capabilities`
- `document_scope`
- `built_at`
- `rebuild_policy`
- `snapshot_ref`
- `health_ref`

`capabilities` 建议覆盖：

- `exact-term`
- `dense-recall`
- `structural-filter`
- `incremental-update`
- `snapshot-read`
- `cross-doc-query`

建议再明确索引生命周期工件：

- `index_manifest.json`
- `index_snapshot.json`
- `index_build_plan.json`
- `index_health.json`

约束：

- retrieval query 不得直接依赖某个具体 backend 的私有语义
- index rebuild / invalidation / snapshot 切换必须有正式 manifest
- backend 替换不应迫使上层 use case 重写
- retrieval 层只能消费 `IndexCatalog` 暴露的标准能力，而不能探测 backend 私有行为
- `workspace/indexes/` 必须能够通过 manifest + snapshot + build plan 恢复当前索引世界

---

## 9. Evidence Pack 类型

建议至少支持 4 类证据包：

### 8.1 ReadEvidencePack

用于单文档深读时支撑局部理解。

### 8.2 AuditEvidencePack

用于核查摘要是否遗漏、弱化、误读。

### 8.3 CrossDocEvidencePack

用于多文档 claim 对齐和冲突分析。

### 8.4 FinalAnswerEvidencePack

用于最终回答、综述或报告输出的可引用证据集。

---

## 9. 与 Reading Engine 的关系

关系应为：

- `Reading Engine` 产生 segment summary、patch context、局部证据
- `Retrieval Context` 在需要时重组这些证据，并补充新召回
- `Audit` 与 `Corpus Engine` 通过 `EvidencePack` 消费结果

不允许：

- 检索层自行维护另一套段落主键
- 检索结果绕开 `NormalizedDocument` 直接引用原始文本片段

---

## 10. 与 Corpus Engine 的关系

在多文档场景下，检索层要承担两种职责：

1. **集合内证据收集**：为某个主题从多个 document 取回候选证据
2. **冲突增强检索**：主动寻找与当前主线不一致的材料

因此 `Corpus Engine` 应调用：

- `retrieve_for_claim_support`
- `retrieve_for_conflict_audit`
- `retrieve_for_compare`
- `build_cross_doc_evidence_pack`

---

## 11. 工件建议

建议产出：

- `retrieval_request.json`
- `retrieval_hits.json`
- `evidence_pack.json`
- `evidence_rerank_trace.json`

这些工件用于：

- 调试检索效果
- 支持可解释性审计
- 作为后续算法迭代的离线数据

---

## 12. Rust 模块建议

- `retrieval/request.rs`
- `retrieval/hit.rs`
- `retrieval/evidence_ref.rs`
- `retrieval/evidence_pack.rs`
- `retrieval/goal_parse.rs`
- `retrieval/structural_filter.rs`
- `retrieval/semantic_recall.rs`
- `retrieval/rerank.rs`
- `retrieval/retrieval_service.rs`

---

## 13. 验收问题

设计完成后要反问：

- 这个检索流程拿回来的到底是“最相关文本”，还是“最有解释力证据”？
- 它是否能在较小上下文包中保持高证据密度？
- 当问题转向限制条件、反例和冲突时，检索是否还能工作？
- 任意一条最终结论，是否都能回指到明确的 `EvidenceRef`？
