# PaperReader Rust DDD PRD Index

> 状态: Implemented + Verified (Closeout+: 2026-04-05)
> 作者: 小满 × 阿猫
> 日期: 2026-04-01
> 目标: 将 `PaperReader` 从单 PDF 阅读插件重构为基于 Rust 的多文档认知引擎，采用 DDD 分层拆分 PRD。

---

## 0. 新边界声明

新系统不再把自己定义为“PDF 阅读器”，而定义为：

**一个以 MinerU 为统一解析内核、面向多文档类型、支持单文档深读与多文档归纳的认知引擎。**

关键边界：

- **解析以 MinerU 为主路径**：当 `MINERU_API_TOKEN` 可用时优先走 MinerU v4
- **允许本地降级**：当 MinerU 不可用/无 Token 时，PDF 可降级到 `pdf-parse` 纯文本模式（显式标注 degrade）
- **兼容多种文本/文档输入**：`file/url/raw_text/snapshot` 进入统一中间表示（必要时使用 text bridge）
- **Rust 重写不是翻译旧 JS 文件**，而是围绕领域模型、状态机与工件系统重建
- **单文档与多文档能力共用同一核心内核**，而不是两套系统

---

## 1. PRD 拆分总览

本次采用 DDD 风格，将 PRD 拆为以下模块：

1. `01-vision-and-scope.md`
   - 愿景、目标、范围、边界、非目标
2. `02-domain-model.md`
   - 统一领域模型、实体、值对象、聚合、领域事件
3. `03-bounded-contexts.md`
   - DDD 上下文拆分、上下文映射、职责边界
4. `04-mineru-ingestion.md`
   - MinerU 统一接入、输入类型、解析流程、错误模型
5. `05-normalized-document.md`
   - 统一中间表示、块模型、结构树、资产引用
6. `06-reading-engine.md`
   - 单文档阅读状态机、ReadingState、工件模型
7. `07-corpus-engine.md`
   - 多文档集合、跨文档比较、归纳、冲突审计
8. `08-retrieval-and-evidence.md`
   - 检索契约、证据包、结构检索与语义检索融合策略
9. `09-api-contracts.md`
   - stdio 命令接口、请求响应模型、向后兼容策略
10. `10-algorithms.md`
    - 核心算法：结构树构建、分段、triage、audit、cross-doc align
11. `11-workspace-and-artifacts.md`
    - 工作空间目录、文件命名、工件 schema、断点恢复
12. `12-rust-architecture.md`
    - Rust crate 结构、模块边界、分层依赖规则
13. `13-roadmap-and-risks.md`
    - 分阶段实施路线、迁移计划、风险边界
14. `14-information-theoretic-architecture.md`
    - 信息论视角下的架构压缩、预算与递归研究约束
15. `15-crate-dag-and-project-map.md`
    - crate DAG、开工顺序图、允许/禁止依赖边与项目地图
16. `16-closeout-2026-04-03.md`
    - 收口报告：PRD 与代码对齐、Host+Direct stdio 可复现验证证据

---

## 2. 阅读顺序建议

建议按以下顺序阅读和推进：

1. 先定 `01-vision-and-scope.md`
2. 再定 `02-domain-model.md` 与 `03-bounded-contexts.md`
3. 然后锁死 `05-normalized-document.md`
4. 再分别展开 `06-reading-engine.md` 与 `07-corpus-engine.md`
5. 之后收敛 `08/09/10/11/12`
6. 最后落 `13-roadmap-and-risks.md`

原因：

- 愿景不清，后面全会漂
- 领域模型不清，模块边界会乱
- 中间表示不稳，所有算法都会反复推倒
- 单文档能力先于多文档能力，但两者必须共核

---

## 3. 总体设计压缩

一句话：

`SourceAsset -> (MinerU | pdf-parse | text-bridge) -> NormalizedDocument -> StructureTree/Segments -> ReadEngine/CorpusEngine -> Artifacts`

再压一层：

- **输入统一**：不同输入通过统一中间表示进入阅读/检索/归纳链路（MinerU 为主路径，必要时降级）
- **结构优先**：先统一表示，再谈阅读与检索
- **目标驱动**：所有摘要、阅读、检索围绕 goal 展开
- **证据可追溯**：每个结论都能追到 segment/block/document
- **跨文档共核**：单文档与多文档能力不是两套实现

---

## 4. 当前文件关系

当前发布态只保留 Rust DDD 结构化 PRD。

早期 JavaScript 时代的追加式 PRD 草稿已经随遗留运行时一并退役，不再作为当前实现说明或维护依据。

今后的设计、实现与验收，以本目录中的结构化 PRD 文件为准，不再回到旧草稿上继续追加。

---

## 5. 当前推进状态

当前 PRD 已覆盖：

- Rust-first DDD 边界
- `NormalizedDocument` 共同母语
- Retrieval / Evidence pack 体系
- Workspace / Artifact / Checkpoint / Resume
- Research graph / multi-agent orchestration
- Policy / capability / migration / telemetry / replay seams
- crate DAG / project map / 开工顺序图

下一步不再是继续扩写基础 PRD，而是：

1. 按 crate DAG 约束推进具体实现
2. 先固化 `domain/workspace/api` 三个共核边界
3. 在不破坏 DAG 的前提下逐步激活 capability crates 与 orchestrator
