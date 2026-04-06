# 02. Domain Model

> 状态: Draft
> 所属: PaperReader Rust DDD PRD

---

## 1. 设计目标

用统一领域模型替换旧系统中围绕 `paperId/chunk/query` 的功能性建模。

领域模型必须回答三件事：

- 系统真正处理的对象是什么
- 这些对象之间怎样组织
- 单文档与多文档如何共享同一套建模语言

---

## 2. 核心实体

### 2.1 Document

系统中的基础认知对象。

建议字段：

- `document_id`
- `title`
- `source_type`
- `source_ref`
- `metadata`
- `parse_status`
- `parse_quality`
- `created_at`
- `updated_at`

职责：

- 表示一份被系统接管的文档
- 关联其原始输入、规范化结果、结构树、segment 集合、阅读状态

### 2.2 Collection

多文档工作单元。

建议字段：

- `collection_id`
- `name`
- `goal`
- `document_ids`
- `created_at`
- `updated_at`

职责：

- 组织一组文档形成一个归纳与比较空间
- 承载跨文档状态和工件

### 2.3 NormalizedDocument

统一中间表示，是整个系统的核心资产。

建议字段：

- `document_id`
- `blocks`
- `outline`
- `references`
- `assets`
- `canonical_text`

职责：

- 将 MinerU 解析结果映射为系统内部稳定结构
- 为后续结构树构建、segment 切分、检索和阅读提供共同基底

### 2.4 StructureTree

文档的逻辑层级树。

建议字段：

- `root_nodes`
- `node_index`
- `version`

职责：

- 表达章节层级、逻辑单元层级、局部依赖关系
- 成为 triage、query、evidence routing 的骨架

### 2.5 Segment

可阅读、可检索、可引用的最小逻辑执行单元。

建议字段：

- `segment_id`
- `document_id`
- `node_path`
- `block_range`
- `text`
- `token_estimate`
- `segment_type`
- `citations`

职责：

- 成为 deep/skim/query 的最小输入单元
- 承载证据定位

### 2.6 ReadingState

单文档阅读过程的运行状态。

建议字段：

- `document_id`
- `goal`
- `current_phase`
- `attention_plan`
- `read_log`
- `rolling_context`
- `segment_summaries`
- `audit_report`
- `round`

职责：

- 支持单文档状态机推进
- 支持中断恢复、跨会话接力、多轮重读

### 2.7 CrossDocumentState

多文档归纳与比较过程的运行状态。

建议字段：

- `collection_id`
- `goal`
- `doc_states`
- `claim_alignment`
- `conflict_map`
- `evidence_pack`
- `synthesis_state`

职责：

- 记录集合级处理进度
- 为跨文档比较、冲突审计、归纳总结提供状态容器

---

## 3. 值对象

### 3.1 DocumentId
- 全系统统一文档身份标识

### 3.2 CollectionId
- 文档集合身份标识

### 3.3 ParseQuality
- `structured`
- `partial`
- `unsupported`

### 3.4 ReadingPhase
- `survey`
- `triage`
- `deepdive`
- `skim`
- `audit`
- `synthesize`

### 3.5 ReadMode
- `deep`
- `skim`
- `skip`

### 3.6 EvidenceRef
- 指向 document/block/segment 的统一证据引用结构

---

## 4. 聚合设计

### 4.1 Document Aggregate

聚合根：`Document`

包含：

- `NormalizedDocument`
- `StructureTree`
- `SegmentSet`
- `ReadingState`

约束：

- 一个 document 的结构、segments、reading state 必须对同一版本的 normalized document 一致

### 4.2 Collection Aggregate

聚合根：`Collection`

包含：

- `document_ids`
- `CrossDocumentState`
- `collection artifacts`

约束：

- collection 内所有跨文档结论必须能够回溯到 member document

---

## 5. 领域事件

建议显式建模的事件：

- `DocumentImported`
- `DocumentParsed`
- `DocumentNormalized`
- `StructureBuilt`
- `SegmentsPlanned`
- `ReadingStarted`
- `AttentionPlanned`
- `SegmentRead`
- `AuditCompleted`
- `DocumentSynthesized`
- `CollectionCreated`
- `CrossDocumentAligned`
- `ConflictDetected`
- `CollectionSynthesized`

这些事件即使第一版不做事件总线，也建议在工件或日志中保留语义。

---

## 6. 旧模型到新模型的迁移关系

旧系统对象到新系统对象的映射：

- `paperId` -> `document_id`
- `chunk` -> `segment`
- `Global_Map.md` -> `Document Survey Artifact`
- `tree_index.json` -> `StructureTree Artifact`
- `Round_1_Summary.md` -> `Document Synthesis Artifact`
- `reading_state.json` -> `ReadingState`

关键变化：

- 从功能命名迁移到领域命名
- 从论文专属语义迁移到通用文档语义
- 从单文档视角迁移到 document/collection 双层视角
