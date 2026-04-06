# 13. Roadmap and Risks

> 状态: Closeout+ Plan (2026-04-05)
> 所属: PaperReader Rust DDD PRD

---

## 1. 目标

本文件回答两个问题：

1. 这个 Rust-first `PaperReader` 递归研究引擎应该按什么顺序落地
2. 在什么地方最容易失控，以及如何提前设防

这里的路线图不按“功能菜单”划分，而按：

**递归 deep research 能力何时真正闭环。**

也就是：

- 何时有单文档研究图
- 何时有多文档递归综合
- 何时有 checkpoint / resume / rerun
- 何时有 budget guard / trace replay / graph replanning

---

## 2. 总体路线原则

路线设计遵循 6 条原则：

1. **先把工件链打通，再追求智能度**
2. **先做单文档研究图，再做多文档递归扩张**
3. **先能恢复，再能并行**
4. **先把 merge 写实，再谈复杂图执行**
5. **先把预算与熔断制度化，再放开递归深度**
6. **Rust 重写优先重建对象边界，不优先翻译旧逻辑**

---

## 3. 阶段总览

建议分 4 个主阶段：

- **Phase 0: Foundation**
- **Phase 1: Single-Document Research Graph（闭环）**
- **Phase 2: Multi-Document Recursive Research**
- **Phase 3: Controlled Scale-Up**

可再加一个长期阶段：

- **Phase 4: Adaptive Research Orchestration**

---

## 3.1 Closeout+（2026-04-05）现状与下一步重点

已收口能力（门禁通过：`cargo test --workspace` + Host/Direct smoke）：

- 单文档：`read_document` / `resume_read` / `audit_document` / `trace_claim_in_document`
- 超大单文本递归阅读：`read_document(mode=recursive)`（含可选 critic 工件）
- 多文档集合：`compare_documents` / `audit_collection_conflicts` / `synthesize_collection`
- 研究图：`plan_research` / `run_research_graph` / `resume_research_graph` / `cancel_run` / `stream_run_events`

Closeout+ 后的“真正多-agent 并发版”关键收口如下：

1. **图执行并发化（已完成）**：研究图节点级并发调度已落地（受 `PaperReaderMaxConcurrentNodes` 控制，默认 3）
2. **collection 文档 fan-out 子图（已完成）**：`plan_research(scope=collection)` 已生成 `read_i/retrieve_i` 扇出节点，并通过聚合 `read/retrieve` 节点保持旧命令与工件兼容
3. **递归阅读子图化（已完成）**：`plan_research(reading_mode=recursive)` 在 document scope 下生成 `read_recursive` 节点，图形态为 `survey/read -> read_recursive -> retrieve -> merge -> synthesize`，其中 `read_recursive` 显式走 `resume_from_state`，具备 run 节点级 checkpoint/resume 语义

---

## 4. Phase 0: Foundation

### 4.1 目标

建立不可推倒的底座：

- MinerU 接入
- `NormalizedDocument`
- `StructureTree`
- `SegmentSet`
- workspace 基础布局
- stdio API 基础命令

### 4.2 本阶段必须完成

- `ingest_source`
- `read_document` 的最小骨架
- 文档级基础工件落盘
- `run_manifest / run_state / artifact manifests`
- `EvidenceRef` 契约稳定

### 4.3 本阶段故意不做

- 复杂 research graph
- 多文档冲突审计
- 自动 replanning
- 并行图执行

### 4.4 验收标准

至少做到：

- 一个文档被解析后，后续流程不再依赖原始临时内存
- 工件路径和引用体系稳定
- `NormalizedDocument` 成为全系统共同母语

---

## 5. Phase 1: Single-Document Research Graph（闭环）

### 5.1 目标

让系统第一次具备“对文本递归 deep research”的最小闭环。

不是简单深读，而是：

- 能围绕一个复杂 `goal`
- 生成一个最小 research graph
- 执行 `survey -> read/retrieve -> synthesize`
- 中断后可恢复

### 5.2 推荐最小节点集

- `survey`
- `read`
- `retrieve`
- `synthesize`
- `merge`（即便单文档也建议保留）

### 5.3 本阶段必须完成

- `plan_research` 生成最小研究图
- `run_research_graph` 执行单文档 DAG
- `resume_research_graph` 支持 checkpoint 恢复
- `handoff` 与 `checkpoint` 成为正式工件
- `budget_state` 开始记录 token/time/call 消耗

### 5.4 为什么这是“闭环”

因为到这里系统已经不再只是阅读器，而是：

**一个能够对单文档问题做分解、执行、工件化、恢复的文本研究引擎。**

### 5.5 验收标准

- 同一文档上的复杂问题可拆成多个节点
- 中断后恢复不需要重头再读
- synthesis 的结论能回溯到 evidence pack

---

## 6. Phase 2: Multi-Document Recursive Research

### 6.1 目标

把单文档研究图扩展到 `Collection`，形成真正的多文档递归研究能力。

### 6.2 新增核心节点

- `compare`
- `trace_claim`
- `conflict_audit`
- `merge`
- `replan`（初版可半自动）

### 6.3 本阶段必须完成

- `survey_collection`
- `synthesize_collection`
- `ClaimAlign`
- `ConflictScore`
- `CrossDocEvidencePack`
- merge 输入输出显式工件化

### 6.4 本阶段关键认知升级

从：

- “读很多文档后写总结合并”

升级为：

- “围绕 shared / complementary / conflicting / weak signals 做显式分解”

### 6.5 验收标准

- 多文档任务中，系统能区分共享信息、互补信息和冲突信息
- `compare` 与 `conflict_audit` 有独立节点与独立产物
- 必要时可触发单文档补读，而不是靠口头假设补齐

---

## 7. Phase 3: Controlled Scale-Up

### 7.1 目标

让递归研究系统从“能跑”走向“可控扩张”。

### 7.2 本阶段必须完成

- partial rerun
- attempt versioning
- trace replay
- graph-level budget guard
- failure artifact + recovery policy
- basic parallel node execution

### 7.3 关键能力

- 节点失败后局部重试
- merge 失败后不必整图重来
- 预算逼近阈值时自动降级或停止
- trace 支持复盘与离线评估

### 7.4 验收标准

- 一个中等规模研究图可在预算内稳定跑完
- 局部失败不会导致整 run 报废
- run 具备 replay 与审计价值

---

## 8. Phase 4: Adaptive Research Orchestration

### 8.1 目标

把系统从“静态研究图执行器”推进到“可自适应研究编排器”。

### 8.2 可能新增能力

- 动态 `replan`
- 基于 budget / conflict / uncertainty 的图扩张
- 更细粒度的 node selection
- 策略化 budget allocator
- 多 agent role specialization

### 8.3 注意

这一阶段属于 vNext（非 closeout 必需品）。

若 Phase 1-3 的工件体系、checkpoint 机制、merge 语义没有真正立住，过早进入自适应编排只会把复杂度放大。

---

## 9. 最小闭环定义（历史备注，已完成）

如果必须给出一个最小可交付闭环（用于回顾工程路径），我建议定义为：

### 闭环定义

一个基于 Rust 的 `PaperReader`，能够：

- ingest 一个文档
- 建立 `NormalizedDocument`
- 根据 `goal` 规划最小 research graph
- 执行 `survey/read/retrieve/synthesize`
- 把 node 工件、handoff、checkpoint、budget 状态全部落盘
- 在中断后恢复
- 输出带 evidence refs 的最终综合结果

### vNext（闭环外）

- 并行多图执行
- 自动复杂 replan
- 高阶多-agent 协作策略
- 大规模 collection 的全自动递归扩张

---

## 10. 推荐实施顺序

建议实际工程顺序：

1. `paperreader-domain`
2. `paperreader-workspace`
3. `paperreader-ingestion`
4. `paperreader-reading`
5. `paperreader-api`
6. `paperreader-orchestrator`
7. `paperreader-retrieval`
8. `paperreader-corpus`
9. `paperreader-cli`

理由：

- 没有 domain，后面全会漂
- 没有 workspace，递归系统没有外存
- ingestion 和 reading 先稳定，orchestrator 才有真实对象可编排
- retrieval/corpus 放到后面，是因为它们依赖前面的对象与工件契约已经稳定

---

## 11. 核心风险总览

递归 deep research 的风险主要不是“普通工程复杂度”，而是以下 8 类：

1. **递归扩张失控**
2. **工件爆炸**
3. **证据链断裂**
4. **预算穿透**
5. **上下文污染**
6. **单双文档双核分叉**
7. **merge 黑箱化**
8. **恢复语义虚假存在**

---

## 12. 风险一：递归扩张失控

### 表现

- 子问题无限生长
- graph 深度失控
- 系统一直在“继续研究”，却不收束

### 触发条件

- 没有最大深度
- 没有节点数上限
- 没有 stop condition

### 缓解策略

- `max_depth`
- `max_nodes`
- `max_budget`
- `must_merge_by_depth`
- `replan` 需要显式审批条件，而不是每轮自动触发

---

## 13. 风险二：工件爆炸

### 表现

- trace、checkpoint、summary 数量过大
- workspace 难以导航
- replay 成本越来越高

### 缓解策略

- 按 node 粒度分目录
- manifest 索引化
- trace 分层（人类 log vs machine jsonl）
- checkpoint 保留策略（latest + milestones）
- 对大型中间文本只保留引用与摘要，不做无限复制

---

## 14. 风险三：证据链断裂

### 表现

- synthesis 有漂亮结论，但追不到源 evidence
- merge 后结论和原始文档关系模糊

### 缓解策略

- `EvidenceRef` 全链贯通
- `handoff` 中保留 must-keep refs
- `merge_decisions` 显式记录吸收/舍弃/降级依据
- 最终输出必须附 `final_answer_evidence_pack`

---

## 15. 风险四：预算穿透

### 表现

- token 失控
- LLM 调用次数失控
- wall-clock 爆炸

### 缓解策略

- 全局 `budget_state`
- 节点级 `budget.json`
- `MAX_LLM_CALL_PER_RUN` 等硬阈值进入正式策略对象
- 预算接近阈值时触发：
  - 降级检索
  - 减少 graph expansion
  - 提前 merge
  - 停止并输出 partial result

---

## 16. 风险五：上下文污染

### 表现

- 早期 handoff 绑架后续判断
- 审计发现反例，但下游仍沿旧叙事推进

### 缓解策略

- `AuditReport + PatchContext + CorrectionLog` 工件化
- handoff 中区分 confirmed / uncertain / contradicted
- merge 时显式清理 superseded 结论
- 高风险节点支持“clean-room re-eval”模式

---

## 17. 风险六：单双文档双核分叉

### 表现

- `Corpus Engine` 重新造一套 segment / summary / evidence 体系
- 单文档和多文档逻辑越走越远

### 缓解策略

- `NormalizedDocument`、`EvidenceRef`、`AttentionPlan`、`ClaimUnit` 必须跨层共用
- 多文档节点必要时触发单文档补读，而不是重做单文档引擎
- architecture review 时优先检查“有没有重造核”

---

## 18. 风险七：merge 黑箱化

### 表现

- merge 成了“最后一段神秘总结”
- 无法知道不同子节点结果如何被取舍

### 缓解策略

- merge 作为正式 node
- 独立 `merge_manifest / merge_decisions / merged_handoff`
- merge 后必须保留 unresolved conflicts

---

## 19. 风险八：恢复语义虚假存在

### 表现

- 文档写了“支持 resume”
- 真实恢复时却只能从头跑

### 缓解策略

- checkpoint 结构先设计，再谈 resume API
- 每个 node 至少一个正式可恢复边界
- integration test 必须模拟中断恢复
- 禁止只靠日志近似恢复

---

## 20. 何时算真正进入“递归研究引擎”阶段

满足以下条件，才能说系统已经不是增强阅读器，而是递归研究引擎：

1. 问题可以被规划成 research graph
2. 节点可以消耗与产出正式工件
3. handoff 是结构化决策状态，不是自然语言摘要
4. 中断后可以恢复
5. merge 有正式语义
6. budget 与 failure 进入制度层
7. 多文档场景可显式处理冲突与补读

只要缺两三项，系统都更像“复杂阅读工作流”，还不算真正的 recursive deep research engine。

---

## 21. Day-1 Hard Decisions vs Deferred Seams

如果目标是支撑十轮以上迭代，第一天必须定死的不是所有功能，而是以下制度接口：

### Day-1 Hard Decisions

- `CommandEnvelope` 顶层结构
- `protocol_version` 与 capability negotiation
- artifact header 与 `schema_version`
- `NormalizedDocument.normalized_document_version`
- `PolicyDecision` 统一返回结构
- `IndexManifest` 与 backend capability 描述
- `request_id / run_id / node_id` 全链路主键
- feature flag 的读取边界

### Deferred Seams

这些可以先留 seam，不必第一天实现：

- 自动 migration 批处理器
- 多 backend 混合检索
- streaming / cancel 协议
- 远程 feature flag 配置
- telemetry exporter
- policy DSL
- chaos / fault injection
- 自适应 health remediation

但以下 8 个 seam 必须在 Day-1 文档中显式留位，即使不全部实现：

1. `ResearchNode / ResearchGraph` 单一真源契约
2. `CommandEnvelope` 与响应头的稳定编号和引用体系
3. `IndexManifest / IndexSnapshot / RebuildPolicy` 生命周期
4. `PolicyDecision` 的 artifact / telemetry 落点
5. runtime capability 描述命令
6. `bootstrap_workspace` 初始化协议
7. streaming / cancel / heartbeat 外壳
8. `HealthSnapshot` 运行态健康读模型

关键判断：

- Day-1 项目决定的是“以后能不能演化”
- Deferred seam 决定的是“以后演化有多顺滑”

---

## 22. 建议的里程碑验收

### Milestone A

- 单文档 ingest + read + artifact store 打通

### Milestone B

- 单文档 research graph + checkpoint/resume 打通

### Milestone C

- 多文档 compare/conflict/merge 打通

### Milestone D

- partial rerun + budget guard + trace replay 打通

### Milestone E

- replanning / adaptive orchestration 初步可用

---

## 22. 最容易写偏的地方

必须明确防止：

1. 把路线图写成“功能列表堆叠”
2. 把 deep research 理解成“多轮检索+最终总结”
3. 过早追求并行和自动化，而工件体系没立住
4. 把恢复能力只写在 API，不写在 workspace 结构里
5. 把多-agent 只理解成多个线程，而不是研究图上的角色化节点执行

---

## 23. 验收问题

路线图完成后必须反问：

- 如果只给三个月，我们最该先交付的是“阅读更强”，还是“研究图首次闭环”？
- 哪些能力如果不先立住，后面所有智能化都会成为空中楼阁？
- 当前阶段是否真的解决了恢复、merge、budget、evidence chain 这些递归系统硬问题？
- 如果今天就要砍范围，哪些该保，哪些该延后？

只有这些问题能答清，路线图才不是愿景海报，而是可执行工程计划。
