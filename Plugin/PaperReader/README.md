# PaperReader

> 把任何长文档变成可追溯的研究资产。

PaperReader 不是普通的 PDF 阅读器，而是一个 **artifact-first 的研究流水线**。它让 AI 以人类研究者的方式阅读——有目标、有策略、可追溯、可恢复、可审计。

| | 普通 PDF 工具 | 通用 AI 聊天 | **PaperReader** |
|---|---|---|---|
| **解析成本** | 每次付费 | 每次付费 | **一次解析，终身复用** |
| **证据追溯** | ❌ 无 | ❌ 不可靠 | ✅ **每句话都可追溯到原文** |
| **中断恢复** | ❌ 从头开始 | ❌ 上下文丢失 | ✅ **随时暂停，随时恢复** |
| **多文档对比** | ❌ 不支持 | ⚠️ 容易混淆 | ✅ **结构化对比与冲突审计** |
| **研究轨迹** | ❌ 无 | ❌ 无 | ✅ **完整工件可复盘** |

---

## 为什么需要 PaperReader

当我们面对一份 100 页的技术规范或 20 篇相关论文时，传统工具的问题不在于"读不懂"，而在于：

- **不可追溯**：AI 给你一个漂亮的总结，但你不知道哪些是真的，哪些是编的
- **不可复用**：同一份文档，每次问不同问题都要重新付费解析
- **不可恢复**：读了一半被打断，回来不知道读到哪了，只能重新开始
- **不可审计**：研究过程像黑盒，无法复盘、无法验证、无法改进

PaperReader 解决这些问题的核心策略是 **artifact-first**：所有认知成果都落盘为显式工件，系统重启后仅凭工件即可恢复——不依赖猜测，不依赖运气。

---

## 核心设计哲学

### 1. Artifact-First：工件优先于内存态

长任务的所有中间状态都落盘为显式工件，而非保存在易失的内存中。workspace 不是"结果导出目录"，而是**递归 deep research 的长时认知外存**。

每个研究节点产生：
- `handoff.json` —— 下游节点可消费的决策状态包
- `checkpoint.json` —— 可恢复锚点
- `trace.jsonl` —— 运行轨迹
- `budget.json` —— 资源消耗记录

### 2. Information-Theoretic：信息增益最大化

系统的目标函数不是最大化处理量（读过的 token 数、产出的字数、调用次数），而是在给定预算下最大化对当前 `goal` 的有效信息增益。

**Segment 切分**是率失真优化：在有限上下文预算下，用尽可能少的语义失真把文档压缩成可读单元，尽量保持 claim 与证据不被切开。

**Triage**是注意力预算分配：对每个 segment 评估"如果精读，预期信息增益是多少？"，决定 deep / skim / skip，而非简单分类。

**Rolling Context**是有限容量信道：保留的是决策状态（已确认事实、主线结构、未解决问题），而非文本片段覆盖率。

**Audit**是有偏信道纠错：在干净上下文中重新比对原文与摘要，检测 omission / downplay / misinterpret，而非"再看一遍"。

### 3. Evidence-First：证据优先于结论

每条结论必须能追溯到具体的 document/segment/block 层级。`EvidenceRef`是贯穿单文档与多文档的核心值对象。

Retrieval 不是"找相似文本"，而是构建**最小上下文中的最大证据密度**——同时优化相关性、证据密度、上下文紧凑度、结构可解释性。

### 4. Research Graph：研究图即程序

复杂研究任务显式建模为 DAG 结构的研究图，而非隐式的顺序执行脚本。

- **Sequential**：适合强依赖链
- **FanOut/FanIn**：适合多个子问题并行调查后汇总
- **Recursive Expansion**：某些节点调查后再生成子图继续下钻

每个节点有独立的 goal、scope、checkpoint、budget、failure policy。可动态 replan，可 partial rerun。

---

## 三种典型工作流

### 📄 单文档深度阅读
适合：学术论文、技术规范、产品文档

```
ingest_source → read_document(mode=auto|deep_focus|recursive) 
→ retrieve_evidence / audit_document → trace_claim_in_document
```

一次 Ingest，终身复用。支持三种阅读模式：
- **survey_only**：快速结构阅读，判断是否值得深读
- **deep_focus**：目标驱动的深度阅读
- **recursive**：超大文档递归子图执行（自动分层解析）

递归模式下，系统会在 document-scope 规划 `read_recursive` 节点，拓扑为 `survey/read -> read_recursive -> retrieve -> merge -> synthesize`，自动处理超长文档的认知负荷。

### 📚 多文档集合研究
适合：文献综述、竞品分析、跨文档审计

```
ingest_collection → survey_collection → compare_documents 
→ audit_collection_conflicts → synthesize_collection
```

多文档归纳的本质不是摘要拼接，而是**共享/互补/冲突分解**：
- **共享信息**：多个文档共同支持的稳定结构
- **互补信息**：不同文档各自提供的非重叠增量
- **冲突信息**：同一 claim 的不一致描述或证据
- **弱信号**：暂时证据不足但值得保留的边缘信息

系统自动构建对比矩阵，识别观点冲突，生成带证据来源的综述报告。

### 🔬 递归研究编排
适合：超长文档、复杂研究问题

```
plan_research → run_research_graph (支持 async) 
→ stream_run_events / get_run_state → resume / cancel / reset
```

将研究任务分解为可执行的节点图，支持 checkpoint/resume/cancel，长任务可随时中断、随时恢复。

执行模式：
- `execution.mode=sync`：同步执行，等待完成返回结果
- `execution.mode=async`：返回 `accepted` 后后台继续执行，通过 `stream_run_events` 轮询进度

---

## 快速开始

### 构建 Release

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build_paperreader_rs_release.ps1
```

### 端到端验证

```powershell
# 离线可复现模式（默认，无需 API Key）
node .\scripts\vcp_host_smoke_paperreader_rs.js "path\to\your.pdf"

# 真实调用模式（需要配置 API Key）
$env:PAPERREADER_SMOKE_REAL=1
node .\scripts\vcp_host_smoke_paperreader_rs.js "path\to\your.pdf"
```

Smoke test 已覆盖递归阅读子图回归，会校验 `global_map` / `final_report` 等关键工件可落盘并可读取。

---

## 配置分层

配置按信息处理层级组织，从解析到递归，每层控制不同的质量-成本权衡。

### L0 解析层：输入统一
| 配置项 | 说明 |
|---|---|
| `MINERU_API_TOKEN` | MinerU 云 API Token（空则降级到 `pdf-parse`） |
| `MINERU_MODEL_VERSION` | `pipeline` / `vlm` / `MinerU-HTML` |

**MinerU 单核原则**：解析统一由 MinerU 提供。当 Token 可用时优先走 MinerU v4 的上传与轮询流程；不可用时显式降级，显式标注 degrade，不伪装成功。

### L1 切分层：率失真优化
| 配置项 | 说明 |
|---|---|
| `PaperReaderChunkSize` | 目标 chunk 大小（默认 2000 tokens） |
| `PaperReaderOverlap` | chunk 重叠比例（默认 0.15） |

Segment 切分不是"切得均匀"，而是在 token 上限约束下最小化语义边界损失，尽量保持 claim 与证据不被切开、表格与正文不分离、论述链不断裂。

### L2 阅读层：注意力预算分配
| 配置项 | 说明 |
|---|---|
| `PaperReaderModel` | LLM 模型名 |
| `PaperReaderBatchSize` | 批大小（默认 5，质量 vs 速度权衡） |
| `PaperReaderMaxChunks` | 单次阅读最多 chunk 数（默认 120，成本保护） |
| `PaperReaderMaxConcurrentLLM` | 进程级 LLM 并发上限（默认 5） |
| `PaperReaderMaxAuditChunks` | audit 抽样 chunk 上限（默认 8） |

Triage 决定 deep / skim / skip，本质是在有限预算下分配注意力资源。

### L3 递归层：分层认知架构
| 配置项 | 说明 |
|---|---|
| `PaperReaderRecursiveGroupSize` | Global Map 分组大小（默认 8，leaf->group reduce） |
| `PaperReaderRecursiveMaxLevels` | 最大 reduce 层级（默认 6） |
| `PaperReaderRecursiveCritic` | 是否启用 critic 代理（更严格但更贵，默认 false） |
| `PaperReaderRollingContextMaxEntries` | 滚动上下文最多保留的 segment summary 条数（默认 40） |
| `PaperReaderRollingContextMaxChars` | 滚动上下文最大字符数（默认 12000） |

递归模式将超长文档分解为分层认知结构：底层 segment summaries -> 中层 group maps -> 顶层 global map，每层都是上层的压缩表示，保留决策状态而非表面覆盖率。

---

## 运行模式

### 解析层（MinerU / pdf-parse）
- **MinerU（推荐）**：当 `MINERU_API_TOKEN` 存在且未开启 `PAPERREADER_FORCE_DETERMINISTIC` 时，走 MinerU v4 的上传与轮询流程（`file-urls/batch` + `extract-results/batch`），将 zip 内的 Markdown 桥接为统一中间表示
- **本地降级**：Token 缺失或强制 deterministic 时，降级到 `pdf-parse` 纯文本模式（质量低于 MinerU，显式标注 degrade）

### LLM 层（OpenAI / Deterministic）
- **真实 LLM（推荐）**：当 `API_URL + API_KEY + PaperReaderModel` 存在且未开启 `PAPERREADER_FORCE_DETERMINISTIC` 时，调用 OpenAI 兼容的 `/v1/chat/completions`
- **Deterministic**：使用可复现的 `DeterministicLlmClient`（保证 smoke 与 CI 门禁稳定）

通过 `describe_runtime.data.capabilities` 可查看当前运行时选用的能力组合（如 `mineru-v4` / `pdf-parse-fallback` / `openai-chat-completions` / `deterministic-llm-fallback`）。

---

## 架构与实现

### DDD 分层架构

```
paperreader-rs/          # Rust Workspace
├── paperreader-domain       # 统一领域语言（Document, Segment, EvidenceRef, Claim）
│                              # 无外部服务依赖，纯 Rust 业务对象
├── paperreader-workspace    # 工件/路径/仓库（外存系统）
│                              # workspace layout, artifact persistence, trace storage
├── paperreader-application  # use case 编排与命令分发
│                              # ingest_source, read_document, synthesize_collection
├── paperreader-api          # stdio 协议与 legacy 兼容
│                              # request/response schema, command routing
├── paperreader-ingestion    # MinerU client, raw result mapping
├── paperreader-reading      # survey / triage / skim / deepdive / audit / synthesize
├── paperreader-retrieval    # structural filter, semantic recall, evidence rerank
├── paperreader-corpus       # collection survey, claim alignment, conflict audit
├── paperreader-orchestrator # research graph planner, executor, checkpoint/resume
└── paperreader-cli          # 进程入口，stdin/stdout loop
```

**依赖方向严格约束**：`cli -> api -> application -> domain`，能力 crate 可依赖 domain，但 domain 不反向依赖任何 adapter。

### 领域模型作为单一真相源

核心实体：
- **Document**：基础认知对象，关联原始输入、规范化结果、结构树、segment 集合、阅读状态
- **NormalizedDocument**：统一中间表示，MinerU 输出映射为系统内部稳定结构
- **StructureTree**：文档的逻辑层级树，triage/query/evidence routing 的骨架
- **Segment**：可阅读、可检索、可引用的最小逻辑执行单元
- **ReadingState**：单文档阅读过程的运行状态，支持中断恢复、跨会话接力
- **Collection**：多文档工作单元，承载跨文档状态和工件

值对象：
- **DocumentId / CollectionId**：统一身份标识
- **EvidenceRef**：指向 document/block/segment 的统一证据引用结构
- **ReadingPhase**：survey / triage / deepdive / skim / audit / synthesize
- **ReadMode**：deep / skim / skip

### 工件系统三大原则

1. **artifact-first** —— 系统真相落盘为工件，而非内存态
2. **resume-first** —— run/read 都以可恢复为默认目标
3. **evidence-first** —— 每个结论尽量能追溯到 evidence 引用

**Workspace 结构**：
```
workspace-rs/
├── documents/<document_id>/     # 文档级工件
│   ├── source_manifest.json     # 原始输入元数据
│   ├── normalized_document.json # 统一中间表示
│   ├── structure_tree.json      # 逻辑层级树
│   ├── segment_set.json         # segment 清单
│   └── reading/                 # 阅读相关工件
│       ├── attention_plan.json  # 注意力预算分配结果
│       ├── reading_state.json   # 阅读状态（可恢复）
│       ├── segment_summaries.json
│       ├── global_map.latest.md # 全局认知地图
│       ├── final_report.latest.md
│       ├── recursive_maps/      # 递归模式中间工件
│       └── audit_report.json    # 纠偏报告
├── collections/<collection_id>/ # 集合级工件
│   ├── collection_manifest.json
│   ├── collection_map.json      # 集合认知骨架
│   ├── comparison_table.latest.json
│   ├── conflict_report.latest.json
│   └── collection_synthesis.latest.md
└── runs/<run_id>/               # 研究运行工件
    ├── run_manifest.json        # 运行主索引（恢复入口）
    ├── run_state.json           # 顶层状态
    ├── graph.json               # 静态研究图定义
    ├── graph_state.json         # 图执行状态
    ├── budget_state.json        # 资源消耗记录
    ├── checkpoints/             # 可恢复锚点
    ├── nodes/<node_id>/         # 每个节点的独立目录
    │   ├── node.json            # 节点定义
    │   ├── handoff_in.json      # 输入决策状态
    │   ├── handoff_out.json     # 输出决策状态
    │   ├── checkpoint.json      # 检查点
    │   └── trace.jsonl          # 运行轨迹
    └── traces/<run_id>.jsonl    # 完整运行轨迹
```

### Handoff 的语义

`handoff` 不是给人看的漂亮摘要，而是下一节点可消费的**决策状态包**：
- `confirmed_facts` —— 已确认关键事实
- `current_structure` —— 当前理解到的主线结构
- `open_questions` —— 未解决问题
- `must_keep_refs` —— 不可丢失的数值/定义/引用
- `next_action_hints` —— 对下游节点的执行建议

这使多 agent 协作成为可能：每个 agent 只需理解 handoff 契约，无需理解整个系统状态。

### Policy Engine

递归 deep research 的 `budget / retry / stop / degrade / access` 不能散落各处，必须提升为统一策略引擎：
- **BudgetPolicy**：token、调用次数、wall-clock 时间预算
- **RetryPolicy**：重试策略
- **DegradePolicy**：降级策略（如 MinerU 不可用时是否允许 pdf-parse）
- **StopPolicy**：停止条件
- **PolicyDecision**：每次裁决包含 `decision` (continue/retry/degrade/stop/reject)、`reason`、`next_budget_limit`

所有策略结果进入 telemetry 与 artifact，确保可审计。

---

## 命令面

### Legacy VCP 别名（向后兼容）

| Legacy VCP | Canonical | 典型效果 |
|---|---|---|
| `IngestPDF` | `ingest_source` | Ingest 一份 PDF/文本并返回可复用 `document_id` |
| `Read` | `read_document(mode=auto)` | 平衡阅读：结构、贡献、方法、实验、局限 |
| `ReadSkeleton` | `read_document(mode=survey_only)` | 快速结构阅读（判断是否值得深读） |
| `ReadDeep` | `read_document(mode=deep_focus)` | 目标驱动的深度阅读 |
| `Query` | `retrieve_evidence` | 证据导向检索问答（带引用） |

### Canonical 命令

**Workspace 与运行时**：`bootstrap_workspace` | `describe_runtime` | `get_health_snapshot` | `get_workspace_state` | `list_artifacts` | `get_artifact`

**单文档**：`ingest_source` | `refresh_ingestion` | `read_document` | `resume_read` | `audit_document` | `trace_claim_in_document`

**多文档**：`ingest_collection` | `survey_collection` | `synthesize_collection` | `compare_documents` | `audit_collection_conflicts`

**检索与证据**：`retrieve_evidence` | `build_evidence_pack`

**研究编排**：`plan_research` | `run_research_graph` | `resume_research_graph` | `stream_run_events` | `get_run_state` | `cancel_run` | `reset_run`

---

## 开发

```powershell
cd paperreader-rs
cargo fmt --all
cargo check -p paperreader-application -p paperreader-api -p paperreader-cli
cargo test -p paperreader-application -p paperreader-api
```

---

## 版本信息

- **当前版本**：0.6.0
- **插件类型**：VCP stdio JSON 插件
- **实现语言**：Rust
- **状态**：Implemented + Verified (Closeout+: 2026-04-05)
