# 07. Corpus Engine

> 状态: Draft
> 所属: PaperReader Rust DDD PRD

---

## 1. 目标

`Corpus Engine` 负责多文档认知流程。

它不是“把多篇文档摘要拼在一起”，而是：

- 把多个 `Document` 组织成一个 `Collection`
- 围绕同一 `goal` 提取共享信息、互补信息与冲突信息
- 生成跨文档可追溯的证据与综合结论

---

## 2. 核心对象

### 2.1 Collection

建议字段：

- `collection_id`
- `name`
- `goal`
- `document_ids`
- `created_at`
- `updated_at`

### 2.2 CrossDocumentState

建议字段：

- `collection_id`
- `goal`
- `doc_statuses`
- `aligned_claims`
- `conflict_map`
- `evidence_pack`
- `synthesis_artifact`

### 2.3 ClaimUnit

建议字段：

- `claim_id`
- `claim_text`
- `normalized_claim`
- `supporting_evidence`
- `contradicting_evidence`
- `related_documents`

---

## 3. 多文档处理模式

建议支持 4 种模式：

### 3.1 Compare

围绕同一主题比较多个文档的：

- 观点差异
- 方法差异
- 实验差异
- 定义差异

### 3.2 SynthesizeAcrossDocs

对多个文档进行综述与整合，形成：

- 共同结论
- 补充信息
- 知识空白

### 3.3 ConflictAudit

聚焦冲突：

- 同一 claim 在不同文档中的不一致结论
- 证据强弱冲突
- 定义口径冲突

### 3.4 TraceClaim

围绕单个命题追踪：

- 哪些文档支持
- 哪些文档反驳
- 哪些文档只提供背景或边缘证据

---

## 4. 高层状态机

建议流程：

```text
CollectionSurvey
-> DocSelection
-> EvidenceHarvest
-> ClaimAlignment
-> ConflictAudit
-> CrossDocSynthesis
```

### 4.1 CollectionSurvey

职责：

- 建立集合级概览
- 判断每份文档在当前 `goal` 下的角色

### 4.2 DocSelection

职责：

- 决定哪些 document 需要深度参与
- 哪些文档只需摘要级参与

### 4.3 EvidenceHarvest

职责：

- 从 member documents 收集与目标相关的证据包
- 可以直接复用单文档 `Reading Engine` 的工件

### 4.4 ClaimAlignment

职责：

- 将不同文档中的 claims 对齐到同一语义框架
- 建立 claim -> evidence -> documents 映射

### 4.5 ConflictAudit

职责：

- 检测冲突
- 区分真正冲突与表述差异
- 评估冲突强度

### 4.6 CrossDocSynthesis

职责：

- 输出集合级最终总结
- 给出共享结论、互补信息、冲突信息和未解决问题

---

## 5. 共享与冲突建模

建议把跨文档结果拆成 4 类：

- `shared_findings`
- `complementary_findings`
- `conflicting_findings`
- `weak_signals`

定义：

- **shared**：多个文档都支持的稳定信息
- **complementary**：不同文档提供的非重叠增量信息
- **conflicting**：对同一 claim 的不一致描述或证据
- **weak_signals**：证据薄弱但值得保留观察的信号

---

## 6. 与单文档引擎的关系

`Corpus Engine` 不应该复制 `Reading Engine`。

正确关系：

- `Corpus Engine` 复用单文档工件
- 必要时触发单文档补读
- 以 `Document summary + EvidencePack + ClaimUnit` 为中间层工作

不允许：

- 为多文档场景另造一套 segment 体系
- 绕开单文档结构树直接做自由摘要拼接

---

## 7. 集合级工件

建议产物：

- `collection_manifest.json`
- `collection_map.json`
- `aligned_claims.json`
- `conflict_report.json`
- `cross_doc_evidence_pack.json`
- `collection_synthesis.md`

这些工件必须支持：

- 增量加入新文档
- 重新执行冲突审计
- 追溯每条结论来自哪些文档与证据块

---

## 8. Collection Map

`Collection Map` 是集合级骨架。

建议包含：

- collection 目标
- member document 列表
- 每份 document 的主题角色
- 初始 claim cluster
- 关键未解决问题

作用：

- 为后续 claim 对齐与综合提供全局视图

---

## 9. Conflict Report

建议结构：

```ts
ConflictReport {
  collection_id: string
  goal: string
  conflicts: ConflictItem[]
}

ConflictItem {
  claim_id: string
  claim_text: string
  conflict_type: 'definition' | 'method' | 'result' | 'interpretation'
  supporting_refs: EvidenceRef[]
  contradicting_refs: EvidenceRef[]
  severity: 'high' | 'medium' | 'low'
  notes: string
}
```

---

## 10. Rust 模块建议

- `corpus/collection.rs`
- `corpus/corpus_engine.rs`
- `corpus/collection_survey.rs`
- `corpus/evidence_harvest.rs`
- `corpus/claim_alignment.rs`
- `corpus/conflict_audit.rs`
- `corpus/cross_doc_synthesis.rs`
- `corpus/artifacts.rs`

---

## 11. 验收标准

### 集合级验收

- 能把多份文档组织成 collection
- 能围绕明确 goal 生成 collection-level synthesis
- synthesis 中每个关键结论都能回溯到具体 document/segment

### 冲突审计验收

- 能显式列出冲突 claim
- 能区分定义冲突与结果冲突
- 能给出冲突强度和来源证据

### 复用性验收

- 单文档工件可以直接进入 Corpus Engine
- 新加入文档时无需重建整套单文档能力
