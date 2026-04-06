# 09. API Contracts

> 状态: Implemented + Verified (Closeout: 2026-04-03)
> 所属: PaperReader Rust DDD PRD

---

## 1. 目标

本文件定义新 `PaperReader` 的外部接口契约。

目标不是先设计 UI，而是先锁死：

- 插件如何通过 stdio 接受请求
- 不同 bounded context 暴露哪些命令
- 响应如何保证可追溯、可恢复、可组合
- 如何为旧插件调用方式提供最小兼容层

---

## 2. 接口边界

新系统建议维持 **VCP 插件标准的 stdio JSON 命令接口**，而不是直接暴露 HTTP 服务作为主入口。

原因：

- 与现有插件生态兼容
- 更适合本地工作空间与长任务工件写入
- 更便于命令式触发与断点恢复

可选扩展：

- 后续可加 debug HTTP API
- 但主契约仍以 stdio request/response 为准

---

## 3. 顶层命令分组

建议顶层命令按 bounded context 拆分：

### 3.1 Runtime Commands

- `bootstrap_workspace`
- `describe_runtime`
- `get_health_snapshot`

### 3.2 Ingestion Commands

- `ingest_source`
- `ingest_collection`
- `refresh_ingestion`

### 3.3 Reading Commands

- `read_document`
- `resume_read`
- `audit_document`
- `trace_claim_in_document`

### 3.4 Corpus Commands

- `survey_collection`
- `synthesize_collection`
- `compare_documents`
- `audit_collection_conflicts`

### 3.5 Retrieval Commands

- `retrieve_evidence`
- `build_evidence_pack`

### 3.6 Workspace Commands

- `get_workspace_state`
- `list_artifacts`
- `get_artifact`
- `reset_run`

### 3.7 Orchestration Commands

- `plan_research`
- `run_research_graph`
- `resume_research_graph`
- `stream_run_events`
- `get_run_state`
- `cancel_run`

---

## 4. Command Envelope 总览

所有请求都应统一包裹在 `CommandEnvelope` 中：

```json
{
  "protocol_version": "1.0",
  "command": "read_document",
  "request_id": "req_123",
  "idempotency_key": "idem_req_123",
  "client": {
    "name": "vcp-host",
    "version": "0.1.0",
    "capabilities": ["accepted-response", "workspace-artifacts"]
  },
  "workspace": {
    "root": "...",
    "run_id": "..."
  },
  "execution": {
    "mode": "sync",
    "timeout_ms": 30000,
    "priority": "normal",
    "feature_flags": []
  },
  "payload": {}
}
```

字段说明：

- `protocol_version`: 协议壳版本
- `command`: 命令名
- `request_id`: 幂等与日志追踪用
- `idempotency_key`: 跨重试去重键
- `client`: 调用方描述与 capability 集合
- `workspace.root`: 工作空间根目录
- `workspace.run_id`: 当前执行实例 ID
- `execution`: 运行模式、超时、优先级、实验开关
- `payload`: 命令特定参数

---

## 5. Protocol Versioning and Capability Negotiation

为了让系统能在长期迭代中保持兼容，协议层必须拆成三种版本：

- `protocol_version`: stdio envelope 与命令协议版本
- `schema_version`: 请求/响应或 artifact 的对象结构版本
- `capabilities`: 当前调用方与运行时支持的能力集合

约束：

- `protocol_version` 用于命令 envelope 的兼容协商
- `schema_version` 由具体对象或 artifact 自身携带，不与 protocol 混用
- `capabilities` 用于能力协商，避免“接口看似兼容但运行语义不一致”

能力协商至少应覆盖：

- `accepted-response`
- `resume-research-graph`
- `artifact-replay`
- `hybrid-retrieval`
- `adaptive-replan`
- `streaming-ready`

若调用方请求的能力未被运行时支持，响应应显式返回：

- 哪些 capability 被接受
- 哪些被拒绝
- 是否进入降级模式
- 是否建议回退到兼容 command 或 sync mode

---

## 6. Runtime Capability Describe Command

除了在每次请求中携带 capability，运行时还应提供显式描述命令：

- `describe_runtime`

响应应至少包含：

- `protocol_version`
- `supported_commands`
- `capabilities`
- `feature_flags`
- `index_backends`
- `policy_backends`
- `health_snapshot_ref`

作用：

- 让客户端在正式发起长任务前先协商世界状态
- 避免调用方只能靠试错判断是否支持 `resume`、`streaming`、`hybrid retrieval`
- 为 IDE/host/plugin 提供稳定的运行时探针

---

## 7. 通用响应头

建议统一响应结构：

```json
{
  "request_id": "req_123",
  "status": "ok",
  "command": "read_document",
  "accepted_capabilities": [],
  "rejected_capabilities": [],
  "degrade_mode": null,
  "data": {},
  "artifacts": [],
  "warnings": [],
  "errors": []
}
```

状态建议：

- `ok`
- `partial`
- `error`
- `accepted`
- `streaming`

其中：

- `ok`: 成功完成
- `partial`: 部分完成，带缺口或降级信息
- `error`: 失败
- `accepted`: 长任务已接收，后续异步产出工件
- `streaming`: 已进入事件流模式

---

## 8. 核心命令契约

### 6.1 `ingest_source`

用途：

- 将一个源文件送入 MinerU
- 生成 `NormalizedDocument`

请求示例：

```json
{
  "command": "ingest_source",
  "request_id": "req_ingest_01",
  "workspace": {
    "root": "./workspace",
    "run_id": "run_001"
  },
  "payload": {
    "source_uri": "./papers/paper_a.pdf",
    "source_type": "pdf",
    "document_name": "paper_a"
  }
}
```

响应重点：

- `document_id`
- `normalized_document_ref`
- `manifest_ref`

### 6.2 `read_document`

用途：

- 对单文档执行 survey/triage/deepdive/skim/audit/synthesize 流程

请求 payload 建议字段：

- `document_id`
- `goal`
- `mode` (`auto` | `survey_only` | `deep_focus` | `recursive`)
- `resume_from_state`
- `constraints`

响应重点：

- `reading_state_ref`
- `attention_plan_ref`
- `global_map_ref`
- `synthesis_ref`（兼容入口，与 `final_report_ref` 内容一致）
- `final_report_ref`
- `audit_report_ref`
- `recursive_artifact_refs`（仅当 `mode=recursive` 且产生了中间工件）

### 6.3 `synthesize_collection`

用途：

- 对 `Collection` 执行多文档综合

请求 payload 建议字段：

- `collection_id`
- `goal`
- `mode` (`synthesis` | `compare` | `conflict_audit`)
- `document_roles`
- `constraints`

响应重点：

- `collection_map_ref`
- `aligned_claims_ref`
- `conflict_report_ref`
- `collection_synthesis_ref`

### 6.4 `retrieve_evidence`

用途：

- 独立执行证据检索

请求 payload 建议字段：

- `scope`
- `document_ids`
- `query_text`
- `query_type`
- `filters`
- `budget`

响应重点：

- `retrieval_hits`
- `evidence_pack_ref`

---

## 9. 长任务与异步语义

由于阅读与多文档综合可能耗时较长，接口必须支持：

1. **accepted + artifact polling**
2. **断点恢复**
3. **增量工件输出**

建议：

- 对长任务命令返回 `status=accepted`
- 同时返回 `run_id` 与预期工件路径
- 后续通过 `get_workspace_state` / `get_artifact` 查询

这样可避免一次调用堵死在超长推理链上。

---

## 10. 错误模型

建议统一错误码层级：

### 8.1 TransportError

stdio 层解析失败、JSON 格式错误。

### 8.2 ValidationError

请求参数缺失、字段不合法。

### 8.3 IngestionError

MinerU 解析失败、文件不可读、格式不支持。

### 8.4 StateError

无法恢复状态、工件缺失、run_id 不存在。

### 8.5 RetrievalError

证据检索失败、结果为空、索引不可用。

### 8.6 OrchestrationError

研究图执行失败、子任务死锁、预算耗尽。

建议响应格式：

```json
{
  "request_id": "req_1",
  "status": "error",
  "command": "read_document",
  "errors": [
    {
      "code": "ValidationError.MissingGoal",
      "message": "payload.goal is required"
    }
  ]
}
```

---

## 11. 向后兼容策略

旧 PaperReader 已存在历史命令心智。

因此建议保留兼容命令别名：

- `IngestPDF` -> `ingest_source`
- `ReadSkeleton` -> `read_document(mode=survey_only)`
- `ReadDeep` -> `read_document(mode=deep_focus)`
  - 备注：超大单文本递归阅读建议直接使用 `read_document(mode=recursive)`（输出 global_map + 多层级递归工件）
- `Query` -> `retrieve_evidence` 或 `trace_claim_in_document`

注意：

- 兼容层只是 command adapter
- 内部不得保留旧 JS 流程分叉
- 所有请求统一落到新领域服务

---

## 12. 多-agent 递归编排接口

为支持研究型工作流，建议增加显式 orchestrator 契约。

### 10.1 `plan_research`

输出研究图定义：

- 主目标
- 子问题列表
- 每个子问题对应的命令计划
- merge 节点
- stopping conditions

### 10.2 `run_research_graph`

输入一个 research graph，按 DAG 执行：

- survey node
- retrieve node
- read node
- compare node
- audit node
- synthesize node

### 10.3 `resume_research_graph`

从指定 checkpoint 恢复未完成节点。

这使系统从“单命令工具”升级为“可编排认知执行器”。

---

## 13. Research Graph 与 Node Contract SSOT

`ResearchGraph` 与 `ResearchNode` 不应在 API 层和 workspace 层各自演化一套定义；协议 SSOT 以本节为准，workspace 工件层只做持久化映射。

### 13.1 `ResearchGraph`

建议格式：

```json
{
  "graph_id": "graph_001",
  "goal": "Compare the methodological differences across these papers",
  "root_scope": {
    "scope_type": "collection",
    "scope_ref": "col_01"
  },
  "nodes": [
    {
      "node_id": "n1",
      "kind": "survey",
      "goal": "Build a collection-level survey map",
      "scope_ref": "col_01",
      "depends_on": [],
      "input_refs": [],
      "output_refs": [],
      "checkpoint_ref": null,
      "status": "pending",
      "attempt": 0,
      "budget": {},
      "payload": {}
    }
  ]
}
```

### 13.2 `ResearchNode`

建议字段：

- `node_id`
- `kind`
- `goal`
- `scope_ref`
- `depends_on`
- `input_refs`
- `output_refs`
- `handoff_in_ref`
- `handoff_out_ref`
- `checkpoint_ref`
- `status`
- `attempt`
- `budget`
- `stop_conditions`
- `failure_policy`
- `payload`

### 13.3 约束

- `node_id` 唯一
- `kind` 必须映射到已注册命令或 node executor
- `payload` 保持与单命令接口兼容
- `ResearchNode` 是协议与工件共同对象，禁止 API 与 workspace 各写一套不兼容 schema

---

## 14. Workspace Bootstrap / Streaming / Health Commands

为了让 Day-1 seam 写死，建议显式增加：

- `bootstrap_workspace`
- `describe_runtime`
- `get_health_snapshot`
- `cancel_run`
- `stream_run_events`

其中：

- `bootstrap_workspace` 负责初始化 workspace 根目录与 schema seed
- `get_health_snapshot` 返回 `HealthSnapshot` 或其 artifact ref
- `cancel_run` 为未来 cancel/heartbeat 协议留稳定 command 位
- `stream_run_events` 为 streaming / heartbeat 事件流留稳定外壳

---

## 15. Rust 契约实现建议

建议分三层：

- `api/schema.rs`: 请求响应 schema
- `api/commands.rs`: 命令枚举与反序列化
- `api/handlers/*.rs`: 每个命令的 handler

并要求：

- schema 与 handler 解耦
- handler 只调用应用层服务
- handler 不直接操作文件系统细节，统一走 workspace service

---

## 16. 验收问题

设计完成后需要反问：

- 这些命令是否映射清楚了 bounded context，而不是混成一个万能入口？
- 响应是否把工件路径与追溯信息一并返回？
- 长任务是否可以 `accepted -> resume`，而不是只能阻塞等待？
- 多-agent 研究图是否复用单命令契约，而不是新造一套不可维护协议？
