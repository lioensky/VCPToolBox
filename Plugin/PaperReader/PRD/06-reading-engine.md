# 06. Reading Engine

> 状态: Implemented + Verified (Closeout+: 2026-04-05)
> 所属: PaperReader Rust DDD PRD

---

## 1. 目标

`Reading Engine` 负责单文档认知流程。

它的职责不是“把文档从头读到尾”，而是：

- 围绕 `goal` 分配注意力
- 在有限上下文预算下最大化有效信息获取
- 生成可追溯的阅读工件
- 对累积偏差进行审核与修补

---

## 1.1 实现对齐说明（Closeout SSOT）

本 PRD 的 “已实现语义” 以代码为准：

- `paperreader-application`: `read_document` / `resume_read` / `audit_document` / `trace_claim_in_document`
- 递归全局地图（Global Map）与 critic：`build_recursive_global_map`

对应实现入口：

- `paperreader-rs/crates/paperreader-application/src/reading_usecases.rs`
- `paperreader-rs/crates/paperreader-application/src/recursive_reading.rs`

说明：

- 本 PRD 里的 Survey/Triage/DeepDive/Skim/Audit/Synthesize 是概念状态机；closeout 版本把它们收敛为 `read_document` 的复合流程，并通过 artifact-first 工件体系保证可追溯与可恢复。
- `PatchContext` 属于可选扩展；closeout 版本不会自动重写历史摘要，只会把审计发现写入 `audit_report.json` 与 `reading_state.json`。

---

## 2. 状态机定义

建议状态机：

```text
Survey
-> Triage
-> DeepDive / Skim / Skip
-> Audit
-> Synthesize
```

必要时允许：

- `Skim -> DeepDive` 升级
- `Audit -> PatchContext -> Synthesize`
- `Round-k` 多轮重入

说明：

- `Reading Engine` 是单文档引擎，不负责跨文档归纳
- 它必须消费 `NormalizedDocument + StructureTree + SegmentSet`
- 它输出的是 `ReadingState` 与单文档阅读工件

---

## 3. ReadingState

closeout 版本结构（字段名以 Rust struct 为准）：

```ts
ReadingState {
  document_id: string
  goal: string
  requested_mode?: string
  constraints: string[]
  current_phase: ReadingPhase
  attention_plan?: AttentionPlan
  read_log: ReadLogEntry[]
  global_map?: string
  rolling_context?: string
  segment_summaries: { [segment_id: string]: string }
  audit_report?: AuditReport
  round: number
  created_at: string
  updated_at: string
}
```

关键要求：

- 必须可持久化
- 必须可中断恢复
- 必须支持跨会话接力
- 必须支持多轮阅读但轮次目标不可完全重复

---

## 4. 六个阶段的职责

### 4.1 Survey

输入：

- `NormalizedDocument`
- `StructureTree`
- `goal`

输出：

- `GlobalMap`
- 章节功能标注
- 初始阅读假设

职责：

- 抽取文档骨架
- 判断哪些节点可能与目标相关
- 给 Triage 提供全局视图

### 4.2 Triage

输入：

- `GlobalMap`
- `StructureTree`
- `goal`
- 历史 `read_log`（若为 Round > 1）

输出：

- `AttentionPlan`

职责：

- 把 segment/node 分配为 `deep/skim/skip`
- 给出推荐顺序与原因
- 显式表示预算分配结果

### 4.3 DeepDive

输入：

- 高优先级 segments
- `rolling_context`
- `goal`

输出：

- `SegmentSummary`
- `read_log` 更新
- `rolling_context` 更新

职责：

- 做高保真阅读
- 提取 key facts / methods / definitions / limitations / open questions
- 写入后续综合需要的结构化状态

### 4.4 Skim

输入：

- 中优先级 segments
- `goal`

输出：

- 轻量摘要
- `upgrade` 信号

职责：

- 提供低成本快速概览
- 不污染核心 `rolling_context`
- 只在意外发现高价值信息时升级为 `DeepDive`

### 4.5 Audit

输入：

- 抽样后的 segment 原文
- 对应 summary
- `GlobalMap`

输出：

- `AuditReport`
- `PatchSet`

职责：

- 检查 omission / downplay / misinterpret
- 对抗上下文惯性偏见
- 必要时修补 `rolling_context` 与 `segment_summaries`

### 4.6 Synthesize

输入：

- `GlobalMap`
- `segment_summaries`
- `audit_report`
- `rolling_context`

输出：

- 单文档最终报告
- `handoff`

职责：

- 生成围绕 `goal` 的最终理解包
- 输出结构化总结与后续接力棒

---

## 5. AttentionPlan

建议结构：

```ts
AttentionPlan {
  document_id: string
  goal: string
  allocations: AttentionAllocation[]
}

AttentionAllocation {
  node_id: string
  segment_ids: string[]
  read_mode: 'deep' | 'skim' | 'skip'
  priority_score: number
  reason: string
  dependencies: string[]
  suggested_order: number
}
```

说明：

- `AttentionPlan` 不是静态标签表，而是预算决策结果
- 后续算法应允许它在运行中被局部修正

---

## 6. SegmentSummary

建议结构：

```ts
SegmentSummary {
  segment_id: string
  node_path: string[]
  read_mode: 'deep' | 'skim'
  summary: string
  key_facts: string[]
  methods: string[]
  evidence_refs: EvidenceRef[]
  limitations: string[]
  open_questions: string[]
  audited: boolean
  audit_correction?: string
}
```

要求：

- 必须保留证据引用
- 不允许成为“不可回溯的自由文本”

---

## 7. PatchContext

当 `Audit` 发现高严重度偏差时，执行 `PatchContext`：

- 生成修正条目
- 用显式标记写入 `rolling_context`
- 修订对应 `SegmentSummary`
- 把修补行为记录进工件

目的：

- 不隐式覆盖原状态
- 让后续 `Synthesize` 能感知到修订来源

closeout 现状：

- `audit_document` 会把审计结论写回 `audit_report.json` 与 `reading_state.json`，但不会自动修改既有 `segment_summaries.json` 或 `global_map.latest.md`。
- 若需要 “审计后自动修补摘要/上下文” 的强策略，可作为 vNext 在 `resume_read` 的新 round 内实现（显式记录 patch 来源与影响范围）。

---

## 8. 工件设计

建议产物：

- `global_map.latest.md`
- `attention_plan.json`
- `reading_state.json`
- `segment_summaries.json`
- `audit_report.json`
- `synthesis.latest.md`（兼容入口，与 `final_report.latest.md` 内容一致）
- `final_report.latest.md`
- `handoff.json`

当 `mode=recursive` 时额外产物（位于 `documents/<document_id>/reading/recursive_maps/`）：

- `level_*/group_*.md`（多层级 reduce 过程产物）
- `global_map.critic.md`（仅当 `PaperReaderRecursiveCritic=true`）
- `level_*/group_*.critic.md`（仅当 `PaperReaderRecursiveCritic=true`）

这些工件必须能支持：

- 断点恢复
- 复盘审计
- 多轮阅读
- 后续进入 `Corpus Engine`

---

## 9. 与 Retrieval Context 的关系

`Reading Engine` 不直接负责“最佳检索算法”。

但它依赖 `Retrieval Context` 提供：

- 节点到 segment 的候选集合
- 证据定位
- query 所需 evidence pack

边界要求：

- Reading 可以请求 evidence pack
- Retrieval 不能直接篡改 ReadingState

---

## 10. Rust 模块建议

closeout 版本的模块组织以 DDD 分层为准：

- `paperreader-domain`: `ReadingState`, `ReadingPhase`, `AuditReport`, `ReadMode` 等统一领域类型
- `paperreader-workspace`: 文档 reading 工件路径（`global_map.latest.md` / `final_report.latest.md` / `recursive_maps/*`）
- `paperreader-application`: 单文档阅读编排与递归 reduce

对应实现文件：

- `paperreader-rs/crates/paperreader-application/src/reading_usecases.rs`
- `paperreader-rs/crates/paperreader-application/src/recursive_reading.rs`

---

## 11. 验收标准

### 单轮阅读验收

- 能在 `goal` 驱动下跑完完整状态机
- 产出 `final_report.md`
- 报告中所有核心结论可回溯到 evidence refs

### 状态一致性验收

- 中途停止后可恢复
- `reading_state.json` 与 `segment_summaries.json` 一致
- `audit_report` 的修正能反映到 synthesis

### 算法边界验收

- `skim` 默认不写入主 rolling context
- `audit` 在干净上下文中运行
- `handoff` 聚焦后续决策状态而非全文复述
