# 05. Normalized Document

> 状态: Draft
> 所属: PaperReader Rust DDD PRD

---

## 1. 为什么这份文件最关键

如果没有统一中间表示，系统就会反复陷入：

- 输入格式差异污染下游算法
- chunk 逻辑和文档结构纠缠
- 阅读状态、query、audit 各自理解一份不同的文档

因此，`NormalizedDocument` 是整个系统的核心不变量。

---

## 2. 设计目标

`NormalizedDocument` 必须满足：

- 与输入文档类型解耦
- 与具体解析返回格式解耦
- 能支撑结构树构建、segment 切分、阅读、检索、跨文档归纳
- 对 block、asset、reference、outline 有明确表示

---

## 3. 顶层结构

建议模型：

```ts
NormalizedDocument {
  document_id: string
  title: string
  source_type: string
  metadata: DocumentMetadata
  blocks: Block[]
  outline: OutlineNode[]
  references: ReferenceEntry[]
  assets: AssetRef[]
  canonical_text: string
}
```

---

## 4. Block 模型

Block 是统一语义块，不等于最终阅读 segment。

建议 block 类型：

- `heading`
- `paragraph`
- `list`
- `quote`
- `table`
- `figure`
- `equation`
- `code`
- `reference`
- `metadata`

建议字段：

- `block_id`
- `block_type`
- `text`
- `heading_level?`
- `source_span`
- `asset_refs`
- `citation_refs`
- `attrs`

说明：

- `block` 负责保留文档原始语义单元
- `segment` 则是在 block 之上形成的阅读执行单元

---

## 5. Outline 模型

Outline 是文档逻辑结构，不等于 block 顺序本身。

建议字段：

- `node_id`
- `title`
- `level`
- `parent_id`
- `block_range`
- `summary_hint?`
- `node_type`

用途：

- 为 `StructureTree` 提供初始骨架
- 为 triage/query/cross-doc alignment 提供逻辑入口

---

## 6. Asset 模型

MinerU 可解析的不仅是纯文本，因此资产必须进入统一模型。

建议 `AssetRef` 字段：

- `asset_id`
- `asset_type` (`figure`, `table_image`, `attachment`, ...)
- `caption`
- `source_block_id`
- `storage_ref`

用途：

- 图注与正文绑定
- 表格、插图在 summary/query 时可被引用

---

## 7. Reference 模型

建议 `ReferenceEntry` 字段：

- `ref_id`
- `label`
- `text`
- `normalized_key?`
- `linked_blocks`

用途：

- 学术文档引用跟踪
- 技术文档规范条款引用
- 多文档 claim trace

---

## 8. Canonical Text

`canonical_text` 不是为了替代 block，而是为了：

- 提供全文线性视图
- 支持日志、调试、粗粒度压缩
- 为部分模型 prompt 提供统一文本串

注意：

- query / deepread / audit 不应只依赖 canonical text
- 必须优先使用 block 和 segment 结构

---

## 9. 从 NormalizedDocument 到 StructureTree

转换规则建议：

1. `heading` block 构成主树骨架
2. 非 heading block 挂载到最近逻辑节点
3. 表格、图注、公式作为节点内部特种 block
4. 如 MinerU 返回层级异常，normalizer 负责纠偏

产物：

- `outline.json`
- `normalized_document.json`
- `structure_tree.json`

---

## 10. 从 Block 到 Segment

segment 生成原则：

- segment 必须尽量对齐逻辑边界，而不是只按 token 硬切
- 同一 segment 内 block 应该在语义上属于同一论述单元
- 超大节点可切成多个 segment，但必须保留 `node_path`

切分信号来源：

- heading 层级
- paragraph group
- table/figure 插入点
- token 预算
- discourse boundary

---

## 11. Rust 类型建议

建议映射为：

- `NormalizedDocument`
- `DocumentMetadata`
- `Block`
- `BlockType`
- `OutlineNode`
- `ReferenceEntry`
- `AssetRef`

要求：

- 这些类型不应依赖 reading/retrieval/corpus 模块
- 它们属于核心 domain/contracts 层

---

## 12. Forward-Compatible Schema Evolution

`NormalizedDocument` 是全系统共同母语，因此它必须从第一天就具备演化边界。

建议增加顶层字段：

- `normalized_document_version`
- `schema_version`
- `extensions`

作用：

- `normalized_document_version` 表示对象语义版本
- `schema_version` 表示序列化结构版本
- `extensions` 用于承载未来字段扩展，而不污染核心不变量

演化原则：

1. 核心字段语义一旦发布，不允许静默改义
2. 新字段优先走 `extensions` 或显式 schema 升级
3. 下游模块读取时必须忽略未知扩展字段，而不是直接失败
4. 若语义发生非兼容变化，必须触发 migration 或 rebuild

这能防止未来在保持文件名不变的情况下，让不同版本的 `NormalizedDocument` 指向不同世界。

---

## 13. 边界约束

### 必须保证

- 同一个 `document_id` 的 normalized document 是稳定可复用的
- 后续所有能力都基于它构建

### 不允许

- query 直接绕过 normalized document 搜 raw parse text
- reading 状态直接把 segment 结构写回 block 结构里
- corpus 层维护自己的第二份“文档结构”副本
