# 11. Workspace and Artifacts

> 状态: Implemented + Verified (Closeout+: 2026-04-05)
> 所属: PaperReader Rust DDD PRD

---

## 1. 目标

本文件定义新 `PaperReader` 的运行时外存系统。

这里的 `workspace` 不是“结果导出目录”，而是：

**递归 deep research 的长时认知外存（long-lived cognitive external memory）。**

它必须承担以下职责：

- 保存单文档与多文档流程的中间工件
- 为 `run_research_graph` 提供节点级 checkpoint 与 resume 基础
- 让不同阶段、不同节点、不同 agent 可以通过显式工件接力，而不是依赖脆弱内存态
- 支撑 trace replay、partial rerun、merge、audit correction 与失败恢复

---

## 1.1 实现对齐说明（Closeout SSOT）

workspace 的 “已实现语义” 以 Rust crate 为准：

- 顶层目录布局：`paperreader-workspace/src/layout.rs`
- 各类实体工件路径：`paperreader-workspace/src/paths.rs`
- trace 事件存储与游标读取：`paperreader-workspace/src/trace.rs`
- 仓库读写与 artifact probe：`paperreader-workspace/src/repository.rs` / `paperreader-workspace/src/artifact.rs`

递归阅读的中间工件（`read_document(mode=recursive)`）会写入：

- `documents/<document_id>/reading/recursive_maps/level_*/group_*.md`
- critic 模式额外写入：`group_*.critic.md` 与 `global_map.critic.md`

说明：本 PRD 的更长篇幅描述包含了 “可扩展的理想形态”；closeout 版本已经具备核心目录、工件 schema 与 trace/resume 门禁，后续扩展应沿用现有 `WorkspaceLayout + *ArtifactPaths + ArtifactHeader` 约束，不再引入新的随意目录分支。

---

## 2. 设计原则

workspace 设计遵循 8 条硬原则：

1. **工件优先于内存态**：长任务状态必须落盘
2. **节点优先于整图**：每个 research node 都要有自己的输入、输出、trace 与 checkpoint
3. **恢复优先于整洁**：宁可多存必要状态，也不能把恢复语义写成猜测
4. **追溯优先于美观**：每条结论都要能追到 evidence / node / artifact
5. **增量优先于覆盖**：重跑节点不应无脑覆盖整 run
6. **失败可见**：失败也必须生成正式工件
7. **merge 显式化**：合并不是“最后总结一下”，而是独立节点与独立工件
8. **预算入账**：token、时间、调用次数、上下文占用要进入工件系统

---

## 3. Workspace 的拓扑定位

在系统总链路里，workspace 位于：

```text
SourceAsset
-> MinerU
-> NormalizedDocument
-> Reading / Retrieval / Corpus / Orchestrator
-> Workspace Artifacts
-> Resume / Replay / Merge / Final Delivery
```

其本质不是结果缓存，而是：

- **运行时状态库**
- **工件账本**
- **恢复锚点**
- **审计依据**

---

## 4. 顶层目录结构建议

建议 workspace 根目录如下：

```text
workspace/
  documents/
  collections/
  runs/
  shared/
  indexes/
```

说明：

- `documents/`: 单文档稳定资产与标准化结果
- `collections/`: 多文档集合定义与集合级映射
- `runs/`: 每次阅读/研究执行实例
- `shared/`: 可复用 schema、prompt trace、公共缓存
- `indexes/`: 检索索引与映射缓存

---

## 5. Documents 区

建议结构：

```text
documents/
  {document_id}/
    source_manifest.json
    mineru_raw.json
    normalized_document.json
    structure_tree.json
    segment_set.json
    asset_index.json
```

用途：

- 保存稳定文档底座
- 作为所有 run 的共享只读输入
- 避免每次研究任务重复做 MinerU 与标准化

要求：

- `document_id` 稳定
- 文档级基础工件不随 run 覆盖
- 后续重解析必须写版本信息

---

## 6. Collections 区

建议结构：

```text
collections/
  {collection_id}/
    collection_manifest.json
    member_documents.json
    collection_map.json
    aligned_claims.latest.json
    conflict_report.latest.json
```

用途：

- 保存集合定义与集合级稳定骨架
- 为 `Corpus Engine` 与 research graph 提供共享输入

说明：

- `collection_map.json` 是集合的认知骨架
- `.latest` 文件只是快捷引用，正式 run 结果仍应落在 `runs/`

---

## 7. Runs 区

`runs/` 是递归 deep research 的主战场。

建议结构：

```text
runs/
  {run_id}/
    run_manifest.json
    run_state.json
    graph.json
    graph_state.json
    budget_state.json
    checkpoints/
    nodes/
    merges/
    outputs/
    traces/
    failures/
```

字段意义：

- `run_manifest.json`: 本次运行的主索引
- `run_state.json`: 顶层状态、当前 phase、恢复入口
- `graph.json`: 静态研究图定义
- `graph_state.json`: 图执行状态
- `budget_state.json`: 全局预算与消耗记录
- `checkpoints/`: 可恢复锚点
- `nodes/`: 每个 research node 的独立目录
- `merges/`: fan-in 与综合节点结果
- `outputs/`: 对外最终产物
- `traces/`: 运行轨迹与调试日志
- `failures/`: 失败事件与降级信息

---

## 8. Artifact Header and Schema Evolution

所有正式 artifact 都必须共享一个统一头部，避免未来同名文件在语义上偷偷变义。

建议头部字段：

```json
{
  "artifact_type": "run_manifest",
  "schema_version": "1.0",
  "created_by": "paperreader-orchestrator",
  "created_at": "...",
  "protocol_compat": {
    "min_protocol": "1.0",
    "max_protocol": "1.x"
  }
}
```

要求：

- `artifact_type` 明确对象类型，而不是靠文件名猜
- `schema_version` 必须独立存在，不能隐含在代码版本里
- 读取 artifact 时，必须先做 schema probe，再决定直接读取、迁移还是拒绝

---

## 9. Migration Registry

为了让 checkpoint、run state、normalized document 等核心工件在新代码下仍可解释，workspace 必须预留迁移机制。

建议引入：

- `MigrationRegistry`
- `ArtifactMigrator<From, To>`
- `migration_report.json`

迁移结果至少分三类：

- `can_read_directly`
- `can_upgrade_in_place`
- `requires_rebuild`

设计要求：

- migrate 是正式制度，不是事后脚本补丁
- resume 前必须确认相关 artifact 处于可解释版本
- 任何自动迁移都应留下 `migration_report.json`

---

## 10. Run Manifest

建议结构：

```json
{
  "run_id": "run_001",
  "goal": "Compare the methodological differences across selected papers",
  "scope": "collection",
  "root_entity_refs": {
    "collection_id": "col_01",
    "document_ids": ["doc_a", "doc_b"]
  },
  "graph_ref": "./graph.json",
  "run_state_ref": "./run_state.json",
  "budget_state_ref": "./budget_state.json",
  "entry_checkpoint": "./checkpoints/latest.json",
  "created_at": "...",
  "updated_at": "..."
}
```

要求：

- 它是恢复入口，不是装饰性元数据
- 任意时候只要拿到 `run_manifest.json`，就应知道如何恢复当前 run

---

## 11. ResearchNode 契约映射

协议层的 `ResearchNode` / `ResearchGraph` SSOT 以 `09-api-contracts.md` 为准；本节只定义其在 workspace 中的持久化映射。

### 11.1 持久化最小结构

建议每个 node 落盘时至少包含：

```json
{
  "node_id": "n_read_01",
  "kind": "read",
  "goal": "Extract the experimental pipeline of document A",
  "scope_ref": "doc_a",
  "depends_on": ["n_survey_01"],
  "input_refs": [],
  "output_refs": [],
  "checkpoint_ref": null,
  "status": "pending",
  "attempt": 0,
  "budget": {},
  "created_at": "...",
  "updated_at": "..."
}
```

### 11.2 持久化附加字段

- `handoff_in_ref`
- `handoff_out_ref`
- `stop_conditions`
- `failure_policy`
- `decision_refs`

### 11.3 约束

- workspace 不得扩展出第二套 node 核心语义
- 若协议层字段升级，workspace 必须通过 migration 或 rebuild 显式跟进
- `node.json` 是 SSOT 的持久化镜像，不是自由扩展日志

---

## 10. 节点状态枚举

建议状态：

- `pending`
- `ready`
- `running`
- `checkpointed`
- `blocked`
- `waiting_merge`
- `completed`
- `partial`
- `failed`
- `aborted`
- `superseded`

定义：

- `pending`: 尚未满足依赖
- `ready`: 可执行
- `running`: 正在运行
- `checkpointed`: 有中途可恢复状态
- `blocked`: 因依赖缺失或预算冻结而暂停
- `waiting_merge`: 已完成局部任务，等待汇合
- `completed`: 成功完成
- `partial`: 部分完成，有价值输出但存在缺口
- `failed`: 失败并已留下失败工件
- `aborted`: 被上层停止条件主动终止
- `superseded`: 被新 replanning 节点替代

---

## 11. 典型节点类型

建议第一版至少支持：

- `survey`
- `read`
- `retrieve`
- `trace_claim`
- `compare`
- `conflict_audit`
- `synthesize`
- `merge`
- `replan`

说明：

- `survey`: 建立局部认知地图
- `read`: 对文档或片段做单文档深入处理
- `retrieve`: 生成证据包
- `trace_claim`: 围绕命题做证据追踪
- `compare`: 做并列比较
- `conflict_audit`: 做冲突审计
- `synthesize`: 生成阶段性综合
- `merge`: 合并多个子节点结果
- `replan`: 在中途修正研究图

---

## 12. 节点目录结构

建议每个 node 独立成目录：

```text
nodes/
  {node_id}/
    node.json
    input_manifest.json
    output_manifest.json
    handoff_in.json
    handoff_out.json
    trace.log
    trace.jsonl
    checkpoint.json
    budget.json
    result.json
    failure.json
```

用途：

- 节点自描述
- 节点级恢复
- 节点级调试
- partial rerun 最小粒度

---

## 13. 节点类型与关键工件矩阵

### 13.1 `survey`

输入工件：

- `normalized_document.json` 或 `collection_manifest.json`
- `structure_tree.json` / `collection_map.json`

输出工件：

- `global_map.json`
- `survey_notes.md`
- `handoff_out.json`

### 13.2 `read`

输入工件：

- `global_map.json`
- `segment_set.json`
- `handoff_in.json`

输出工件：

- `reading_state.json`
- `attention_plan.json`
- `segment_summaries.json`
- `audit_report.json`（如果本节点内含 audit）
- `handoff_out.json`

### 13.3 `retrieve`

输入工件：

- `handoff_in.json`
- `query_spec.json`
- `document/collection refs`

输出工件：

- `retrieval_hits.json`
- `evidence_pack.json`
- `evidence_rerank_trace.json`
- `handoff_out.json`

### 13.4 `trace_claim`

输入工件：

- `claim_spec.json`
- `evidence_pack.json` 或 `collection refs`

输出工件：

- `claim_trace.json`
- `support_matrix.json`
- `contradiction_matrix.json`
- `handoff_out.json`

### 13.5 `compare`

输入工件：

- 多个 `reading_state` / `segment_summaries` / `evidence_pack`

输出工件：

- `comparison_table.json`
- `comparison_notes.md`
- `handoff_out.json`

### 13.6 `conflict_audit`

输入工件：

- `aligned_claims.json`
- `cross_doc_evidence_pack.json`
- `handoff_in.json`

输出工件：

- `conflict_report.json`
- `resolution_notes.md`
- `handoff_out.json`

### 13.7 `synthesize`

输入工件：

- `segment_summaries.json`
- `evidence_pack.json`
- `comparison_table.json`
- `conflict_report.json`
- `handoff_in.json`

输出工件：

- `synthesis.json`
- `synthesis.md`
- `final_answer_evidence_pack.json`
- `handoff_out.json`

### 13.8 `merge`

输入工件：

- 多个子节点 `handoff_out.json`
- 多个阶段性 `synthesis.json`

输出工件：

- `merge_manifest.json`
- `merged_handoff.json`
- `merge_decisions.json`
- `merge_trace.json`

### 13.9 `replan`

输入工件：

- 当前 `graph_state.json`
- `budget_state.json`
- 失败/冲突/缺口相关工件

输出工件：

- `graph_patch.json`
- `replan_notes.md`
- `new_nodes_manifest.json`

---

## 14. Handoff 的语义

`handoff` 不是给人看的漂亮摘要，而是下一节点可消费的**决策状态包**。

建议包含：

- 已确认关键事实
- 当前主线结构
- 未解决问题
- 必查线索
- 不可丢失的数值/定义/引用
- 对下游节点的执行建议

建议格式：

```json
{
  "focus_questions": [],
  "confirmed_facts": [],
  "open_questions": [],
  "must_keep_refs": [],
  "next_action_hints": []
}
```

---

## 15. Checkpoint 与 Resume

### 15.1 Checkpoint 的本质

checkpoint 不是普通快照，而是：

- 节点在某一可恢复边界上的正式锚点
- 保证恢复后不会重复推断必要前置状态

### 15.2 建议记录内容

- 当前 node 状态
- 已消费输入 refs
- 已产出输出 refs
- 当前 handoff
- 当前预算消耗
- 当前 phase / round
- 下一个待执行动作

### 15.3 Resume 规则

恢复时必须以工件为准：

1. 读取 `run_manifest`
2. 读取 `graph_state`
3. 找到 `latest checkpoint`
4. 对每个未完成 node 依据 `checkpoint_ref` 恢复
5. 若 checkpoint 缺失，则从最近 completed ancestor 或 node start 重新执行

禁止：

- 依赖隐式内存猜测恢复
- 依赖“最后一条日志看起来像做到哪了”进行恢复

---

## 16. Budget State

递归 deep research 必须把预算变成正式工件。

建议 `budget_state.json` 同时维护：

- `token_budget_total`
- `token_budget_used`
- `llm_call_budget_total`
- `llm_call_budget_used`
- `wall_clock_budget_total`
- `wall_clock_budget_used`
- `context_pressure_score`
- `artifact_volume_score`

作用：

- 支撑 stop condition
- 支撑 replan
- 支撑 partial rerun 的成本判断

---

## 17. Failure Artifact

失败必须结构化留痕。

建议 `failure.json` 包含：

- `node_id`
- `failure_type`
- `message`
- `retryable`
- `related_input_refs`
- `partial_outputs`
- `suggested_recovery`
- `timestamp`

失败类型建议至少包括：

- `ValidationFailure`
- `BudgetExceeded`
- `RetrievalFailure`
- `ParseFailure`
- `MergeFailure`
- `ConflictUnresolved`
- `CheckpointCorrupted`

---

## 18. Merge Artifact

`merge` 是图执行中的一等公民，不能隐藏在 synthesis 文本里。

建议保留：

- `merge_manifest.json`
- `merge_inputs.json`
- `merge_decisions.json`
- `merged_handoff.json`

其中 `merge_decisions.json` 应说明：

- 哪些上游结果被吸收
- 哪些被舍弃
- 哪些冲突被保留待审
- 哪些结论因证据不足被降级

---

## 19. Partial Rerun

partial rerun 是递归系统成熟度的关键。

要求：

- rerun 以 node 为最小粒度
- rerun 不应清空整个 run
- rerun 必须保留旧版本工件引用
- rerun 后需要在 `graph_state` 中标记 superseded / active 分支

建议：

- 节点目录允许 `attempt_1/attempt_2/...` 子版本
- `node.json` 记录当前活动版本

---

## 22. Telemetry and Replay Envelope

仅有 trace 文件还不够，超级工程必须把运行观测与 replay 升级成正式契约。

建议定义统一 `TelemetryEvent`：

- `timestamp`
- `request_id`
- `run_id`
- `node_id`
- `command`
- `event_type`
- `policy_decision`
- `backend`
- `latency_ms`
- `token_in`
- `token_out`
- `artifact_bytes`
- `result_status`

建议再定义 `ReplayEnvelope`：

- 原始输入 refs
- 运行时 capability 集合
- 使用的 artifact versions
- policy decisions
- backend selections

并建议新增正式工件：

- `policy_decision.json`
- `health_snapshot.json`

作用：

- 支撑 replay-based regression
- 支撑性能归因
- 支撑 schema / policy / backend 变化后的对比回放
- 让策略裁决和系统健康状态进入可审计外存

---

## 23. Trace 系统

建议同时保留两类 trace：

### 20.1 `trace.log`

面向人类快速排障。

### 20.2 `trace.jsonl`

面向程序 replay 与离线分析。

每条 trace 事件建议至少包含：

- `timestamp`
- `run_id`
- `node_id`
- `event_type`
- `input_refs`
- `output_refs`
- `budget_delta`
- `note`

---

## 21. 审计与纠错工件

递归研究系统不能只记录“成功产物”，还要记录修补过程。

建议专门工件：

- `audit_report.json`
- `patch_context.json`
- `correction_log.json`

作用：

- 让后续节点知道哪些结论被纠偏过
- 防止旧错误 handoff 继续污染下游节点

---

## 24. Workspace Bootstrap / Health / Streaming 映射

在 API 层，以下命令应直接对应 workspace 工件系统：

- `bootstrap_workspace` -> 初始化 `documents/collections/runs/shared/indexes`
- `get_workspace_state` -> `run_state.json + graph_state.json + budget_state.json`
- `list_artifacts` -> 遍历 `run_manifest + node/output manifests`
- `get_artifact` -> 直接读指定 artifact
- `resume_research_graph` -> 读取 `entry_checkpoint + node checkpoints`
- `get_health_snapshot` -> `health_snapshot.json`
- `stream_run_events` -> `trace.jsonl` 或事件流适配层

这保证 API 不是空壳，而是真正映射到外存系统。

---

## 23. Rust 模块建议

建议在 `paperreader-workspace` 与 `paperreader-orchestrator` 中实现：

- `workspace/layout.rs`
- `workspace/manifest.rs`
- `workspace/checkpoint.rs`
- `workspace/artifact_store.rs`
- `workspace/trace_store.rs`
- `orchestrator/node_contract.rs`
- `orchestrator/graph_state.rs`
- `orchestrator/budget_state.rs`
- `orchestrator/merge_artifacts.rs`

---

## 24. 必须防止的错误设计

以下设计必须明确禁止：

1. 把 workspace 当成 Markdown 导出目录
2. 只存最终总结，不存 node 级中间工件
3. 用日志代替 checkpoint
4. handoff 只写自然语言，不写结构化决策状态
5. merge 不留决策记录
6. rerun 覆盖旧工件，导致不可审计
7. budget 不落盘，导致递归扩张失控

---

## 25. 验收问题

设计完成后必须反问：

- 如果进程中断，系统是否能只靠 workspace 工件恢复，而不是靠运气？
- 任意一个节点失败后，是否都能知道它读了什么、产出了什么、还差什么？
- merge、handoff、audit correction 是否都成了一等工件，而不只是文本过程？
- partial rerun 是否能局部修复，而不是整图重来？
- workspace 是否真的承担了递归 deep research 的“长时认知外存”角色？
