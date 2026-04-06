# 03. Bounded Contexts

> 状态: Draft
> 所属: PaperReader Rust DDD PRD

---

## 1. 目标

将系统拆成清晰的 DDD 上下文，避免旧系统那种“解析、切分、阅读、query 全揉在一起”的演化路径。

---

## 2. 上下文划分

### 2.1 Ingestion Context

职责：

- 接收原始输入
- 管理导入任务
- 调用 MinerU
- 轮询结果
- 保存原始解析产物

不负责：

- 阅读策略
- segment 切分
- 摘要与问答

输入：

- 文件路径
- 文档来源引用
- 导入配置

输出：

- `DocumentImported`
- `DocumentParsed`
- MinerU raw result

---

### 2.2 Normalization Context

职责：

- 将 MinerU 返回结果映射到 `NormalizedDocument`
- 标准化块结构、标题层级、表格、图注、引用块
- 生成 canonical text

不负责：

- 阅读状态
- 多文档归纳

输入：

- MinerU raw result

输出：

- `NormalizedDocument`
- `StructureTree` 初始输入

---

### 2.3 Reading Context

职责：

- 单文档阅读状态机
- Survey/Triage/DeepDive/Skim/Audit/Synthesize
- 维护 `ReadingState`

不负责：

- 文档导入
- 集合级归纳

输入：

- `Document`
- `NormalizedDocument`
- `StructureTree`
- `goal`

输出：

- `ReadingState`
- 单文档总结工件
- 审核工件

---

### 2.4 Retrieval Context

职责：

- 证据检索
- 节点路由
- segment 召回
- evidence pack 构建

不负责：

- 解析
- 最终总结撰写

输入：

- `goal` 或 `question`
- `StructureTree`
- `SegmentSet`

输出：

- `EvidencePack`
- `RetrievalTrace`

---

### 2.5 Corpus Context

职责：

- Collection 管理
- 多文档比较
- claim 对齐
- 冲突审计
- 跨文档综合

不负责：

- 单文档原始解析

输入：

- `Collection`
- member documents
- cross-doc goal

输出：

- `CrossDocumentState`
- conflict report
- collection synthesis

---

### 2.6 Execution Context

职责：

- 任务编排
- 工件写入
- checkpoint
- 并发控制
- 错误模型
- 恢复机制

不负责：

- 领域判断本身

输入：

- 各 context 的命令请求与中间结果

输出：

- 可恢复执行流
- 结构化任务状态

---

## 3. Context Map

建议关系：

- `Ingestion -> Normalization`
- `Normalization -> Reading`
- `Normalization -> Retrieval`
- `Reading -> Retrieval`
- `Reading -> Corpus`
- `Retrieval -> Corpus`
- `Execution` 横切所有上下文

依赖原则：

- 上游不能依赖下游
- 解析上下文不感知阅读策略
- 多文档上下文不能直接绕过单文档结构模型

---

## 4. 边界语言（Ubiquitous Language）

建议统一术语：

- `Document`：系统中的单份文档对象
- `Collection`：文档集合
- `NormalizedDocument`：统一中间表示
- `StructureTree`：逻辑结构树
- `Segment`：可执行阅读单元
- `ReadingState`：单文档阅读状态
- `CrossDocumentState`：多文档运行状态
- `EvidencePack`：证据包
- `Goal`：任务目标
- `Claim`：待对齐/比较/审计的命题

必须避免继续泛用：

- `paperId`
- `chunk` 作为最高层概念
- `PDF mode`

---

## 5. 反模式警告

### 5.1 Parsing 污染 Reading

错误：在解析上下文里直接决定 triage/deep/skim。

### 5.2 Retrieval 绕过 NormalizedDocument

错误：直接对原始 Markdown 或原始 MinerU 文本做 ad-hoc 搜索。

### 5.3 Corpus 复制单文档能力

错误：多文档单独造一套结构树、摘要、检索流程。

### 5.4 Execution 侵入领域决策

错误：为了并发方便，把领域规则塞进调度器。

---

## 6. Rust 映射建议

每个 bounded context 在 Rust 中建议对应模块：

- `ingestion`
- `normalization`
- `reading`
- `retrieval`
- `corpus`
- `execution`

共享领域对象放在：

- `domain`
- `contracts`
- `artifacts`

这样做能避免把 crate 结构直接映射成旧 JS 文件结构。
