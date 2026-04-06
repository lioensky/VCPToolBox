# 12. Rust Architecture

> 状态: Draft
> 所属: PaperReader Rust DDD PRD

---

## 1. 目标

本文件回答两个问题：

1. Rust 重写到底重写什么结构，而不是只重写什么语言
2. 如何让 DDD 上下文、算法对象、工件系统和插件接口在代码层真正对齐

因此这里不讨论业务愿景，而讨论：

- crate 拆分
- 模块边界
- 分层依赖
- 运行时与任务执行
- 多-agent 递归编排在 Rust 层如何落地

---

## 2. 总体架构姿态

新系统建议采用：

**单仓多 crate 的 Rust workspace 架构**。

理由：

- DDD context 天然适合模块化分层
- 需要把 domain model、application service、adapter、workspace IO 分开
- 后续若要引入独立 indexer、orchestrator、worker，可继续演化而不推倒

建议姿态：

```text
paperreader-rs/
  crates/
    paperreader-domain/
    paperreader-application/
    paperreader-ingestion/
    paperreader-reading/
    paperreader-retrieval/
    paperreader-corpus/
    paperreader-orchestrator/
    paperreader-workspace/
    paperreader-api/
    paperreader-cli/
```

---

## 3. 分层规则

建议坚持 4 层：

### 3.1 Domain Layer

只放：

- 实体
- 值对象
- 聚合
- 领域服务接口
- 领域事件

禁止：

- 文件系统 IO
- MinerU 调用
- stdio 协议解析
- prompt 拼接细节

### 3.2 Application Layer

负责：

- use case
- workflow orchestration
- command handler 的内部入口
- 跨 context 协调

### 3.3 Infrastructure / Adapter Layer

负责：

- MinerU client
- artifact persistence
- index storage
- prompt adapter
- model/tool invocation adapter

### 3.4 Interface Layer

负责：

- stdio request/response
- CLI 参数
- debug 命令

---

## 4. 建议 crate 说明

### 4.1 `paperreader-domain`

内容：

- `Document`
- `Collection`
- `NormalizedDocument`
- `StructureTree`
- `Segment`
- `ReadingState`
- `CrossDocumentState`
- `ClaimUnit`
- `EvidenceRef`
- `AttentionPlan`

要求：

- 无外部服务依赖
- 尽量保持纯 Rust 业务对象

### 4.2 `paperreader-application`

内容：

- `ingest_source` use case
- `read_document` use case
- `synthesize_collection` use case
- `retrieve_evidence` use case
- `run_research_graph` use case

要求：

- 依赖 domain
- 只通过 trait 调基础设施

### 4.3 `paperreader-ingestion`

内容：

- MinerU API client
- raw result mapping
- source validation

### 4.4 `paperreader-reading`

内容：

- survey / triage / skim / deepdive / audit / synthesize 流程服务
- reading artifacts builder

### 4.5 `paperreader-retrieval`

内容：

- structural filter
- semantic recall adapter
- evidence rerank
- evidence pack build

### 4.6 `paperreader-corpus`

内容：

- collection survey
- claim alignment
- conflict audit
- cross-doc synthesis

### 4.7 `paperreader-orchestrator`

内容：

- research graph planner
- graph executor
- checkpoint / resume
- budget guard / stop condition

### 4.8 `paperreader-workspace`

内容：

- workspace root management
- run directory creation
- artifact persistence
- manifest/index utilities

### 4.9 `paperreader-api`

内容：

- stdio request/response schema
- command routing
- error mapping

### 4.10 `paperreader-cli`

内容：

- 进程入口
- stdin/stdout loop
- debug 子命令

---

## 5. 依赖方向

建议严格依赖方向：

```text
cli -> api -> application -> domain
                    -> ingestion / reading / retrieval / corpus / orchestrator / workspace

ingestion / reading / retrieval / corpus / orchestrator / workspace -> domain
```

额外要求：

- `domain` 不反向依赖任何 adapter
- `api` 不直接操作具体算法模块
- `cli` 只负责装配，不承载业务逻辑

---

## 6. Trait 先行原则

为防止 Rust 工程重新耦合回“脚本泥团”，建议大量使用 trait 抽象：

### 6.1 关键 trait

- `ParserGateway`
- `ArtifactRepository`
- `WorkspaceRepository`
- `RetrievalIndex`
- `PromptExecutor`
- `ResearchGraphExecutor`
- `PolicyEngine`
- `BootstrapWorkspace`
- `HealthReporter`
- `CapabilityDescriber`

目的：

- application 层不依赖具体存储与外部服务
- 便于未来替换模型、索引、调度器
- 测试时可注入 fake/mock 实现

---

## 7. Policy Engine

随着系统进入递归 deep research，`budget / retry / stop / degrade / access` 不能散落在各个 use case 和 orchestrator 分支中，必须提升为统一策略引擎。

建议定义：

- `PolicyEngine`
- `BudgetPolicy`
- `RetryPolicy`
- `DegradePolicy`
- `StopPolicy`
- `AccessPolicy`
- `PolicyDecision`

建议 `PolicyDecision` 至少包含：

- `decision` (`continue` | `retry` | `degrade` | `stop` | `reject`)
- `reason`
- `applied_policy`
- `next_budget_limit`
- `notes`
- `decision_ref`

要求：

- 所有“是否继续 / 是否重试 / 是否降级 / 是否熔断”的判断统一经过 `PolicyEngine`
- application 层只消费 `PolicyDecision`，不内嵌大量 if/else 规则
- policy 结果必须进入 telemetry 与 artifact
- 每次正式策略裁决都应可序列化为 `policy_decision.json` 或挂入 node-level trace envelope

---

## 8. 工件系统落地

Rust 重写后，系统不应主要依赖内存态，而应围绕工件系统运行。

建议：

- 所有长任务中间状态写入 workspace
- 领域对象可序列化为 JSON/Markdown 工件
- 每个关键步骤都留下 `trace` 与 `manifest`

原因：

- 便于断点恢复
- 便于调试与人工审阅
- 便于多-agent 协同读写共享状态

---

## 8. 多-agent 递归编排落地

### 8.1 为什么单独设 crate

多-agent 递归编排不是“多开线程”这么简单，而是新的执行边界：

- 要有研究图
- 要有节点状态
- 要有预算与熔断
- 要有 merge / audit / retry 机制

因此需要单独的 `paperreader-orchestrator`。

### 8.2 关键对象

建议对象：

- `ResearchGraph`
- `ResearchNode`
- `NodeExecutionState`
- `Checkpoint`
- `BudgetPolicy`
- `StopCondition`
- `MergePlan`

### 8.3 执行模式

建议至少支持：

1. **Sequential**
   - 适合强依赖链
2. **FanOut/FanIn**
   - 适合多个子问题并行调查后汇总
3. **Recursive Expansion**
   - 某些节点调查后再生成子图继续下钻

### 8.4 安全边界

递归编排必须受以下约束：

- 最大节点数
- 最大深度
- 最大 token / model 调用预算
- 最大 wall-clock time
- 连续失败熔断

这部分直接吸收 DeepResearch 的启发：

- 长时任务不能没有 `MAX_LLM_CALL_PER_RUN`
- 不能没有 time limit
- 不能没有 token limit fallback

PaperReader 要把这些从“脚本参数”提升为正式领域策略对象。

---

## 9. 并发与运行时策略

Rust 层建议使用异步运行时处理：

- MinerU API 调用
- 检索与索引 IO
- 多节点图执行
- 工件读写管线

但要注意：

- 并发只是执行手段，不是领域模型
- domain 对象不感知 tokio 等运行时细节
- graph executor 负责调度与回收

---

## 10. Prompt / Model Adapter 边界

即使系统以后使用不同模型，Rust 代码层也不应把 prompt 文本散落在各模块里。

建议：

- prompt 模板放 adapter 层
- application 传递结构化输入对象
- adapter 负责转成 prompt / tool schema
- 输出再映射回领域对象

这能避免“Rust 只是把 Python prompt 工程换壳”。

---

## 12. Feature Flags and Capability Seams

为了让实验功能不污染主路径，系统必须预留正式的 feature flag 与 capability seam。

建议第一批 flag：

- `adaptive_replan`
- `parallel_graph_execution`
- `hybrid_retrieval`
- `experimental_merge_strategy`
- `streaming_protocol`

约束：

- flag 只允许在 application / orchestrator 入口读取
- domain 对象不感知实验开关
- 所有启用的 flag 都应进入 `CommandEnvelope.execution.feature_flags` 与 telemetry 事件

这能保证：

- 实验能力可显式启停
- 不同运行之间的行为差异可审计
- 实验代码不会悄悄寄生进稳定主路径

---

## 13. Workspace Bootstrap and Health Seams

如果系统要作为长期演化的超级工程，`workspace` 初始化与运行态健康检查不能只是脚本习惯，而要成为正式 seam。

建议增加：

- `BootstrapWorkspace`：负责初始化 `documents/collections/runs/shared/indexes` 与 schema seed
- `HealthReporter`：输出 `HealthSnapshot`
- `CapabilityDescriber`：输出当前 runtime 的 protocol、feature flags、backend、policy、index 能力

建议 `HealthSnapshot` 至少包含：

- `workspace_health`
- `index_health`
- `artifact_store_health`
- `runtime_capabilities`
- `degraded_services`

要求：

- CLI 启动时可按需执行 bootstrap，而不是把目录创建逻辑散在各 handler 中
- 健康信息必须可被 API 和测试 harness 读取，而不是只写日志
- capability 描述结果必须与 `CommandEnvelope` 协商语义一致

---

## 14. Test Harness Architecture

建议三层测试：

### 13.1 Domain Tests

验证实体/值对象规则与状态机转换。

### 13.2 Application Tests

用 fake gateway 验证 use case 行为。

### 13.3 Integration Tests

验证：

- MinerU 接入
- workspace 工件生成
- stdio 命令路由
- research graph 恢复

重点：

- 先验证对象与工件契约
- 再验证外部服务联动

此外必须补一层 `Golden Artifact Harness`，专门验证：

- request/response envelope 是否回归
- artifact schema 是否回归
- checkpoint/resume 是否仍可恢复
- migration 后的 artifact 是否符合新 schema
- policy decision matrix 是否稳定

这层测试比“最终回答像不像”更重要，因为它直接守住超级工程的演化能力。

---

## 12. 目录草案

建议进一步细化为：

```text
crates/
  paperreader-domain/
    src/
      document.rs
      collection.rs
      normalized_document.rs
      structure_tree.rs
      segment.rs
      reading_state.rs
      cross_document_state.rs
      claim.rs
      evidence.rs
      attention.rs

  paperreader-application/
    src/
      commands/
      usecases/
      services/

  paperreader-orchestrator/
    src/
      graph.rs
      planner.rs
      executor.rs
      checkpoint.rs
      budget.rs
      merge.rs

  paperreader-api/
    src/
      request.rs
      response.rs
      router.rs
      errors.rs

  paperreader-cli/
    src/main.rs
```

---

## 13. 迁移原则

Rust 重写时必须坚持：

1. **不按旧 JS 文件逐个翻译**
2. **先定领域对象，再写流程服务**
3. **先把工件契约定稳，再接模型与检索能力**
4. **多-agent 编排从一开始就留位置，不要最后硬塞**

否则就会变成：

- 语言换了
- 架构没变
- 旧问题原封不动迁入新代码库

---

## 14. 验收问题

- 这些 crate 是否真正映射了 bounded context，而不是按技术细节乱拆？
- 多-agent 编排是否有正式对象、预算策略与 checkpoint，而不只是一个 while-loop？
- domain 是否保持纯净，adapter 是否承担了外部世界复杂性？
- 如果以后替换检索后端、模型后端、调度后端，当前依赖结构是否撑得住？
