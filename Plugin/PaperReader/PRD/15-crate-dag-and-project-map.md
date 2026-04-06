# 15. Crate DAG and Project Map

> 状态: Draft
> 所属: PaperReader Rust DDD PRD
> 日期: 2026-04-01

---

## 1. 目标

本文件不是重复 `12-rust-architecture.md` 的 crate 列表，而是把“可以开工的项目地图”钉成一份工程约束：

1. 哪些 crate 是系统稳定骨架
2. 哪些依赖边允许存在，哪些必须禁止
3. 哪些 crate 先开工，哪些只能后置激活
4. 算法、工件、编排三层如何在 DAG 上闭环，而不重新长成泥团

一句话：

**本文件是 Rust workspace 的施工蓝图、依赖红线与推进顺序图。**

---

## 2. 总体拓扑定位

`PaperReader` 的 Rust 工程不是“10 个 crate 平铺”，而是一个分层有向无环图：

```text
graph TD
  CLI[paperreader-cli]
  API[paperreader-api]
  APP[paperreader-application]
  DOMAIN[paperreader-domain]
  ING[paperreader-ingestion]
  READ[paperreader-reading]
  RET[paperreader-retrieval]
  CORPUS[paperreader-corpus]
  ORCH[paperreader-orchestrator]
  WS[paperreader-workspace]

  CLI --> API
  API --> APP
  API --> DOMAIN

  APP --> DOMAIN
  APP --> ING
  APP --> READ
  APP --> RET
  APP --> CORPUS
  APP --> ORCH
  APP --> WS

  ING --> DOMAIN
  READ --> DOMAIN
  RET --> DOMAIN
  CORPUS --> DOMAIN
  ORCH --> DOMAIN
  ORCH --> WS
  WS --> DOMAIN
```

设计意图：

- `domain` 是最低层共同母语
- `application` 是唯一 use case 编排入口
- `ingestion/reading/retrieval/corpus/orchestrator/workspace` 是受控的能力插件层
- `api/cli` 只负责协议和进程边界，不反向侵入业务

---

## 3. 层次定义

### 3.1 L0: Ubiquitous Language Core

- `paperreader-domain`

职责：

- 统一领域语言
- 统一协议内核对象
- 统一可序列化的核心值对象与聚合根

这是全系统的“物理常数层”。

### 3.2 L1: Capability Providers

- `paperreader-ingestion`
- `paperreader-reading`
- `paperreader-retrieval`
- `paperreader-corpus`
- `paperreader-workspace`

职责：

- 提供单一能力面的服务实现或适配器
- 不直接承担完整跨 context 业务编排
- 不直接依赖 `api` / `cli`

这层是“器官层”，不是“大脑层”。

### 3.3 L2: Execution Control

- `paperreader-orchestrator`
- `paperreader-application`

职责：

- `orchestrator` 负责 research graph、checkpoint、resume、merge、budget、stop
- `application` 负责 command/use case 入口与跨能力组合

两者区别：

- `orchestrator` = 长时运行控制器
- `application` = 对外暴露的业务动作编排器

### 3.4 L3: Interface / Runtime Shell

- `paperreader-api`
- `paperreader-cli`

职责：

- 请求响应协议
- runtime 装配
- stdin/stdout 与 debug 入口

这层必须保持“薄”。

---

## 4. Crate-by-Crate Map

### 4.1 `paperreader-domain`

必须承载：

- `NormalizedDocument`
- `Document`
- `Collection`
- `StructureTree`
- `Segment`
- `ClaimUnit`
- `EvidenceRef`
- `ReadingState`
- `CrossDocumentState`
- `ResearchGraph`
- `ResearchNode`
- `NodeExecutionState`
- `Checkpoint`
- `StopCondition`
- `MergePlan`
- `PolicyDecision`
- `HealthSnapshot`
- `CommandEnvelope`
- `RequestContext`
- `ExecutionMode`
- `IdempotencyKey`
- `ClientInfo`
- `CapabilityNegotiation`
- `FeatureFlagSet`
- `CapabilitySet`

禁止承载：

- 文件系统访问
- MinerU client
- prompt 文本模板
- index backend 具体实现
- stdio 解析

### 4.2 `paperreader-ingestion`

必须承载：

- `ParserGateway` 的首个实现
- MinerU raw result 映射
- source validation
- `MinerURawResult -> NormalizedDocument` 前置桥接

允许依赖：

- `paperreader-domain`

禁止依赖：

- `paperreader-reading`
- `paperreader-retrieval`
- `paperreader-api`
- `paperreader-cli`
- `paperreader-application`

### 4.3 `paperreader-reading`

必须承载：

- `AttentionTriage`
- `SkimSummarize`
- `DeepDiveSummarize`
- `AuditDiff`
- `SegmentSummary` 相关 builder
- 单文档 survey / deep focus / audit 流程服务

允许依赖：

- `paperreader-domain`

### 4.4 `paperreader-retrieval`

必须承载：

- `RetrievalIndex`
- `LexicalIndexBackend`
- `VectorIndexBackend`
- `StructuralIndexBackend`
- `EvidenceIndexBackend`
- `EvidenceRerank`
- `IndexCatalog`
- `IndexSnapshot`
- `IndexBuildPlan`

允许依赖：

- `paperreader-domain`

### 4.5 `paperreader-corpus`

必须承载：

- `ClaimAlign`
- `ConflictScore`
- `compare_documents`
- `audit_collection_conflicts`
- `synthesize_collection` 所需的跨文档组装逻辑

允许依赖：

- `paperreader-domain`

### 4.6 `paperreader-workspace`

必须承载：

- `ArtifactRepository`
- `WorkspaceRepository`
- `MigrationRegistry`
- `ArtifactMigrator<From, To>`
- `BootstrapWorkspace`
- artifact / manifest / checkpoint / trace / replay 读写

允许依赖：

- `paperreader-domain`

禁止承载：

- 业务路由
- 具体阅读算法
- graph 调度决策

### 4.7 `paperreader-orchestrator`

必须承载：

- `ResearchGraphExecutor`
- `ResearchGraphPlan`
- node scheduler
- checkpoint / resume controller
- merge / replan / stop condition coordinator
- budget guard

允许依赖：

- `paperreader-domain`
- `paperreader-workspace`

暂时禁止直接依赖：

- `paperreader-reading`
- `paperreader-retrieval`
- `paperreader-corpus`
- `paperreader-ingestion`

原因：

- `orchestrator` 负责图执行控制，不直接下沉为“算法聚合器”
- 真正节点动作应通过 `application` 或 future executor port 注入，避免 graph 层绑死具体能力实现

### 4.8 `paperreader-application`

必须承载：

- `ingest_source`
- `ingest_collection`
- `refresh_ingestion`
- `read_document`
- `resume_read`
- `audit_document`
- `trace_claim_in_document`
- `survey_collection`
- `synthesize_collection`
- `compare_documents`
- `audit_collection_conflicts`
- `retrieve_evidence`
- `build_evidence_pack`
- `plan_research`
- `run_research_graph`
- `resume_research_graph`
- `get_workspace_state`
- `list_artifacts`
- `get_artifact`
- `reset_run`
- `bootstrap_workspace`
- `describe_runtime`
- `get_health_snapshot`
- `cancel_run`
- `stream_run_events`

允许依赖：

- `paperreader-domain`
- `paperreader-ingestion`
- `paperreader-reading`
- `paperreader-retrieval`
- `paperreader-corpus`
- `paperreader-orchestrator`
- `paperreader-workspace`

职责边界：

- 它是所有 command 的业务装配层
- 它可以组合多个能力 crate
- 但不能把协议解析塞回来，也不能承担 stdin/stdout 生命周期

### 4.9 `paperreader-api`

必须承载：

- request/response schema
- command router
- command-to-usecase binding
- error mapping
- capability negotiation shell

允许依赖：

- `paperreader-domain`
- `paperreader-application`

禁止依赖：

- `paperreader-reading`
- `paperreader-retrieval`
- `paperreader-corpus`
- `paperreader-ingestion`
- `paperreader-workspace`
- `paperreader-orchestrator`

### 4.10 `paperreader-cli`

必须承载：

- stdin/stdout main loop
- debug 子命令
- 本地 smoke-run 命令

允许依赖：

- `paperreader-api`

禁止依赖：

- 除 `paperreader-api` 外的所有业务 crate

---

## 5. 允许依赖边

当前 Day-1 正式允许边如下：

```text
paperreader-application -> paperreader-domain
paperreader-application -> paperreader-ingestion
paperreader-application -> paperreader-reading
paperreader-application -> paperreader-retrieval
paperreader-application -> paperreader-corpus
paperreader-application -> paperreader-orchestrator
paperreader-application -> paperreader-workspace

paperreader-ingestion -> paperreader-domain
paperreader-reading -> paperreader-domain
paperreader-retrieval -> paperreader-domain
paperreader-corpus -> paperreader-domain
paperreader-workspace -> paperreader-domain
paperreader-orchestrator -> paperreader-domain
paperreader-orchestrator -> paperreader-workspace

paperreader-api -> paperreader-domain
paperreader-api -> paperreader-application
paperreader-cli -> paperreader-api
```

---

## 6. 禁止依赖边

以下边从 Day-1 起就视为违规：

```text
paperreader-domain -> *
paperreader-cli -> paperreader-application
paperreader-cli -> paperreader-domain
paperreader-api -> paperreader-reading
paperreader-api -> paperreader-retrieval
paperreader-api -> paperreader-corpus
paperreader-api -> paperreader-ingestion
paperreader-api -> paperreader-workspace
paperreader-api -> paperreader-orchestrator
paperreader-reading -> paperreader-retrieval
paperreader-reading -> paperreader-workspace
paperreader-retrieval -> paperreader-reading
paperreader-corpus -> paperreader-reading
paperreader-corpus -> paperreader-retrieval
paperreader-ingestion -> paperreader-workspace
paperreader-ingestion -> paperreader-reading
paperreader-orchestrator -> paperreader-reading
paperreader-orchestrator -> paperreader-retrieval
paperreader-orchestrator -> paperreader-corpus
paperreader-orchestrator -> paperreader-ingestion
```

这些边为什么危险：

- 会让接口层偷偷携带业务逻辑
- 会让能力 crate 横向串线，最后回到“模块名不同，实则一锅粥”
- 会让 `orchestrator` 从图调度器退化成“什么都想碰的巨石神类”

---

## 7. 三层闭环如何映射到 DAG

### 7.1 算法层

算法层主要落在：

- `paperreader-reading`
- `paperreader-retrieval`
- `paperreader-corpus`

它们只消费 `domain`，不直接理解协议，不直接操作 CLI。

### 7.2 工件层

工件层主要落在：

- `paperreader-workspace`
- `paperreader-domain`

规则：

- 工件 schema 的语义母语定义在 `domain`
- 工件存取和迁移定义在 `workspace`

### 7.3 编排层

编排层主要落在：

- `paperreader-application`
- `paperreader-orchestrator`

闭环路径：

```text
api/cli
  -> application use case
  -> algorithm capability crate
  -> workspace artifact write/read
  -> orchestrator checkpoint/resume/replan
  -> application response shell
  -> api/cli
```

这保证：

- 算法不碰协议
- 工件不碰业务入口
- 编排不直接绑死具体前端壳

---

## 8. 开工顺序图

### Phase 0: 骨架已就位

当前已完成：

- workspace
- 10-crate scaffold
- minimal stdin/stdout loop
- `cargo check`

### Phase 1: 共核对象层

优先开工：

1. `paperreader-domain`
2. `paperreader-workspace`
3. `paperreader-api`

目标：

- 先把共同母语、工件母语、协议母语定稳
- 为后续算法和图编排提供稳定边界

### Phase 2: 单能力落点

其次开工：

1. `paperreader-ingestion`
2. `paperreader-reading`
3. `paperreader-retrieval`
4. `paperreader-corpus`

目标：

- 把解析、阅读、检索、跨文档能力变成可注入的独立能力模块

### Phase 3: 研究图控制层

然后开工：

1. `paperreader-orchestrator`
2. `paperreader-application`

目标：

- 把 research graph / checkpoint / resume / merge / replan 接到前两层

### Phase 4: 壳层增强

最后迭代：

1. `paperreader-api`
2. `paperreader-cli`

目标：

- streaming
- debug surface
- health snapshot
- capability describe
- cancel / heartbeat

---

## 9. 开工时的硬约束

### 9.1 新增依赖前先问四个问题

1. 这条边是为了领域母语，还是只是临时图省事？
2. 这条边会不会让接口层下沉进业务？
3. 这条边能否改成 trait / port 注入？
4. 这条边会不会让 future backend replace 变难？

### 9.2 Review 红线

以下情况直接视为需要返工：

- `cli` 直接依赖 `application` 以外的业务 crate
- `api` 直接调用具体算法实现
- 能力 crate 横向互相依赖
- `domain` 出现 IO / 外部服务逻辑
- `orchestrator` 直接塞入阅读/检索具体算法而不经端口隔离

### 9.3 演化策略

如果后面确实需要新增 crate，只允许按以下两种理由新增：

1. 形成新的 bounded context
2. 某现有 crate 已同时承担“领域母语 + 运行时壳 + 具体适配器”三种职责，需要拆纯

不允许因为“文件太多不好找”就新增 crate。

---

## 10. 与当前脚手架的一致性

当前 `paperreader-rs` 脚手架已经满足本地图的第一层形状：

- `cli -> api -> application -> domain`
- 能力 crate 大多仅依赖 `domain`
- `workspace -> domain`

还需要主动约束的一点是：

- `orchestrator` 目前只允许依赖 `domain` 与 `workspace`
- 后续真正实现节点执行时，应优先通过 executor port / trait 注入，而不是直接把 `reading/retrieval/corpus` 拉进 `orchestrator`

这是为了守住：

**graph control != algorithm implementation**

---

## 11. 低比特压缩

一句话总纲：

**`domain` 定义世界，`workspace` 固化世界，`capability crates` 处理世界，`application` 编排世界，`orchestrator` 驱动长时世界，`api/cli` 只暴露世界。**

再压一层：

- 不让接口层长业务
- 不让算法层横向串线
- 不让 orchestrator 退化成巨石核心
- 不让 domain 被 IO 污染

这张 crate DAG 不是形式主义，而是未来 100w+ 工程不烂掉的第一道骨架。
