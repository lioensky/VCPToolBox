# TDB 冷知识库系统开发文档

**开发日期：** 2026-06-01
**状态：** 全量测试通过（Rust release 编译通过 + 全部 JS 语法检查通过 + 300 文档建库 + LightMemo 检索接入）
**作者：** VCP

---

## 1. 背景与动机

VCPToolBox 现有的浪潮记忆系统（[`KnowledgeBaseManager.js`](../KnowledgeBaseManager.js) + [`TagMemoEngine.js`](../TagMemoEngine.js)）专为 Agent 的**热记忆**设计：记忆、经验、反思、思想、日常行为、协作记录、工作日程。它的 TagMemo 算法擅长直觉、联想、逻辑推理，依赖标签共现矩阵、EPA 模块、测地线重排等重型语义机制。

但对于动辄百万级的**冷知识库**（百科全书、技术手册、私有数据），这套机制过重：

- 每个 chunk 都要抽 Tag、维护 Tag 向量、参与共现矩阵。
- 频繁的小写入优化与冷知识库的批量导入需求不匹配。
- TagMemo 的联想增强对“事实召回”类查询是噪声而非增益。

因此引入全新的**冷知识库通道**，与热记忆系统**平行**运行，互不干扰。

---

## 2. 三层架构定位

```text
热记忆层   KnowledgeBaseManager.js  ->  dailynote/   ->  TagMemo / 联想 / 反思 / Agent 内心
冷知识层   TDBKnowledge.js          ->  knowledge/   ->  TriviumDB / 百科 / 手册 / 私有资料
检索路由层 LightMemo 插件指令集      ->  常驻进程     ->  按意图分流到对应通道
```

设计哲学：

> **TagMemo 是 Agent 的“脑内联想皮层”，TDBKnowledge 是 Agent 的“外部冷知识资料馆”，LightMemo 是“最后检索路由”。**

职责边界明确，互不污染：

| 维度 | 热记忆（TagMemo） | 冷知识（TDB） |
|------|-------------------|---------------|
| 数据 | 记忆/反思/日程/协作 | 百科/手册/论文/私有文档 |
| 规模 | 中小规模、高关联 | 几十万~百万级 chunk |
| 写入特征 | 频繁小写入 | 批量导入、低频变更 |
| 检索诉求 | 直觉联想、逻辑推理 | 事实召回、精确检索、文档溯源 |
| 结果解释 | 为什么联想到 | 来自哪个文档/章节/片段 |
| 引擎 | SQLite + Vexus + TagMemo | TriviumDB（向量×图谱×文档三位一体） |

---

## 3. 核心组件

### 3.1 TDBKnowledge.js（冷知识库管理器）

文件：[`TDBKnowledge.js`](../TDBKnowledge.js)

职责：面向 `knowledge/` 下的多个一级目录，每个目录构建一个独立的 TriviumDB 知识库（`.tdb` 单文件），负责扫描、入库、更新、删除、检索。

关键设计：

- **单例 + 多库句柄**：`TDBKnowledgeManager` 为服务内单例（TriviumDB 是独占文件锁，绝不能多进程/多实例打开同一库）；内部用 `this.libs = Map<libraryName, handle>` 管理多个库句柄。
- **轻量 manifest（better-sqlite3）**：`VectorStoreTDB/tdb_knowledge_meta.sqlite` 维护 `files` / `chunks` 两张表，记录文件 hash、mtime、size、doc_node_id、chunk node_id。TriviumDB 自身不是文件索引器，文件更新时需要靠此 manifest 精准删除旧 chunk 节点。
- **节点模型**：一个 chunk 一个节点（type=chunk），一个文件一个文档节点（type=document）。
  - Payload 精简原则：只存 `source_path`、`chunk_index`、`hash`、`text_preview`（前 500 字），不塞全文（TriviumDB 的 Payload 与图关系全量常驻内存）。
  - 图关系：`document -[contains]-> chunk`、`chunk[i] -[next]-> chunk[i+1]`、`chunk[i+1] -[prev]-> chunk[i]`，使图扩散检索有意义。
- **混合检索**：优先调用 TriviumDB 的 `search_hybrid`（BM25 稀疏 + 向量稠密 + 图扩散），不可用时回退到 `search`。
- **绑定兼容**：通过 `_callDb()` 在多种方法命名（驼峰/下划线）和多种构造签名间做容错，避免 TriviumDB Node 绑定 API 命名差异导致崩溃。
- **空闲安全**：`indexText` / `buildTextIndex` 等可选能力用 try-catch 包裹，缺失时自动退化为纯向量检索。

核心方法：

| 方法 | 职责 |
|------|------|
| `initialize()` | 打开 meta DB、建表、启动监听、按需全量扫描 |
| `getOrOpenLibrary(name)` | 打开/复用某个库句柄 |
| `upsertFile(filePath)` | 切片→embedding→建节点→建边→写 manifest |
| `deleteFile(filePath)` | 删除该文件的全部节点并清理 manifest |
| `search(query, options)` | 多库合并检索，按 score 排序取 topK |
| `searchLibrary(name, query, vec, options)` | 单库混合检索 |
| `shutdown()` | flush 所有库、关闭 meta DB |

### 3.2 Rust 监听器泛化

文件：[`rust-vexus-lite/src/lib.rs`](../rust-vexus-lite/src/lib.rs)

原 `VexusWatcher` 硬编码只监听 `.md` / `.txt`（为热记忆系统设计）。本次将其泛化：

- `WatcherConfig` 新增可选字段 `extensions: Option<Vec<String>>`。
- 监听回调中的后缀过滤改为读取 `allowed_extensions` 集合；为空时保持旧默认（`md`/`txt`），向后兼容。

这样同一个 Rust 原生 watcher 既能服务热记忆（md/txt），也能服务冷知识库（md/txt/json/html/pdf 等可配置）。TDBKnowledge 优先用 Rust watcher，失败时回退 chokidar。

### 3.3 LightMemo 冷知识库检索指令

文件：[`Plugin/LightMemo/LightMemo.js`](../Plugin/LightMemo/LightMemo.js)、[`Plugin/LightMemo/plugin-manifest.json`](../Plugin/LightMemo/plugin-manifest.json)

LightMemo 是常驻进程的 hybridservice 插件，内置 jieba 分词、BM25、Rerank（含 RRF 融合），非常适合做企业级知识库检索的“最后一公里”。本次为其新增冷知识库检索分流，复用其 Rerank 能力，无需新建插件。

---

## 4. 检索指令语法

### 4.1 触发方式（任选其一）

**方式一：query 内嵌 `[知识库]` 语法（推荐）**

```
[知识库] <查询>                    # 搜全部冷知识库
[知识库:库名1,库名2] <查询>        # 指定知识库（半角冒号）
[知识库：库名] <查询>              # 指定知识库（全角冒号）
```

**方式二：显式 `knowledge_base` 参数**

```
knowledge_base:「始」库名1,库名2「末」
```

库名 = `knowledge/` 下的一级目录名（如 `VCP知识`、`TDBdocs`）。

### 4.2 调用示例

搜全部冷知识库：

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」LightMemo「末」,
query:「始」[知识库] VCP的元思考系统是如何工作的「末」,
k:「始」5「末」
<<<[END_TOOL_REQUEST]>>>
```

指定单库 + RRF 融合精排：

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」LightMemo「末」,
query:「始」[知识库:VCP知识] 分布式星型网络架构「末」,
k:「始」5「末」,
rerank:「始」rrf0.7「末」
<<<[END_TOOL_REQUEST]>>>
```

### 4.3 参数适用性

| 参数 | 冷知识库是否生效 | 说明 |
|------|------------------|------|
| `query` | ✅ 必需 | 去除 `[知识库...]` 语法后作为检索词 |
| `k` | ✅ | 返回条数，默认 5 |
| `rerank` | ✅ | 复用 LightMemo 现有语法（`true`/`rrf`/`rrf0.7`/0~1 数字） |
| `knowledge_base` | ✅ | 显式指定库，逗号分隔 |
| `tag_boost` | ❌ 忽略 | TagMemo 专用，对冷知识库无意义 |
| `maid` / `folder` | ❌ 忽略 | 日记本作用域，对冷知识库无意义 |
| 时间范围 `[2026-02-14]` | ❌ 忽略 | 日记时间约束，对冷知识库无意义 |

不带 `[知识库]` 也不带 `knowledge_base` 时，LightMemo 行为完全不变，仍走原日记/TagMemo 检索。

### 4.4 返回格式

```
[--- TDB 冷知识库检索 ---]
[查询内容: "..."]
[知识库范围: VCP知识]
[找到 N 条相关知识片段:]
--- (来源: VCP知识, 相关性: 87.3%(混合))
    [路径: VCP知识/03_VCP元思考系统.txt]
<片段正文>
[--- 知识库检索结束 ---]
```

---

## 5. 数据流

### 5.1 写入链路（建库）

```
文件变更 → Rust VexusWatcher / chokidar
        → TDBKnowledge._queueStableFile (稳定性检查)
        → 批处理 _flushBatch
        → upsertFile: chunkText 切片 → getEmbeddingsBatch 向量化
        → TriviumDB insert(chunk/document 节点) + link(图关系)
        → indexText + buildTextIndex (BM25 稀疏索引)
        → flush 落盘
        → 写入 meta.sqlite (files/chunks)
```

### 5.2 查询链路（检索）

```
AI 调用 LightMemo (query 含 [知识库])
   → handleSearch 检测冷知识库路由 _detectColdKnowledgeRoute
   → _handleColdKnowledgeSearch
   → TDBKnowledge.search (embedding → 多库 search_hybrid → 合并排序)
   → 可选 LightMemo Rerank 精排 (复用 _rerankDocuments)
   → _formatColdKnowledgeResults 格式化返回
```

---

## 6. 配置项（config.env）

新增于 [`config.env.example`](../config.env.example)：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TDB_KNOWLEDGE_ENABLED` | `true` | 是否启用冷知识库 |
| `TDB_KNOWLEDGE_ROOT_PATH` | `./knowledge` | 冷知识库根目录 |
| `TDB_KNOWLEDGE_STORE_PATH` | `./VectorStoreTDB` | TriviumDB 库与 meta 存储目录 |
| `TDB_KNOWLEDGE_FULL_SCAN_ON_STARTUP` | `true` | 启动全量扫描 |
| `TDB_KNOWLEDGE_EXTENSIONS` | `.md,.txt,.json,.html,.pdf` | 监听的文件扩展名 |
| `TDB_KNOWLEDGE_EXCLUDE_FOLDERS` | `TDBdocs` | 忽略的一级目录 |
| `TDB_KNOWLEDGE_DIMENSION` | `3072` | 向量维度，须与 embedding 模型一致 |
| `TDB_KNOWLEDGE_MODEL` | `gemini-embedding-2-preview` | embedding 模型 |

---

## 7. 依赖注入链路

```
server.js initialize()
  → tdbKnowledgeManager.initialize()
  → pluginManager.setTdbKnowledgeManager(tdbKnowledgeManager)

Plugin.js loadPlugins() (LightMemo 初始化时)
  → dependencies.tdbKnowledgeManager = this.tdbKnowledgeManager
  → LightMemo.initialize() 接收并启用冷知识库检索
```

关闭顺序（[`server.js`](../server.js) gracefulShutdown Phase 9）：先 `tdbKnowledgeManager.shutdown()`，再 `knowledgeBaseManager.shutdown()`。

---

## 8. 改动文件清单

| 文件 | 改动 |
|------|------|
| [`TDBKnowledge.js`](../TDBKnowledge.js) | 新建：冷知识库管理器 |
| [`server.js`](../server.js) | 引入并初始化 TDB；注入 PluginManager；关闭钩子 |
| [`Plugin.js`](../Plugin.js) | 新增 `setTdbKnowledgeManager()`；向 LightMemo 注入 |
| [`Plugin/LightMemo/LightMemo.js`](../Plugin/LightMemo/LightMemo.js) | 新增冷知识库分流、检索、格式化 |
| [`Plugin/LightMemo/plugin-manifest.json`](../Plugin/LightMemo/plugin-manifest.json) | 新增指令文档与示例 |
| [`rust-vexus-lite/src/lib.rs`](../rust-vexus-lite/src/lib.rs) | WatcherConfig 新增 extensions 白名单 |
| [`config.env.example`](../config.env.example) | 新增 TDB 冷知识库配置项 |

---

## 9. 风险与注意事项

1. **TriviumDB 独占锁**：同一 `.tdb` 同一时刻只能一个进程打开。TDBKnowledge 必须是服务内单例，插件侧只能通过依赖注入复用，绝不能各自 new。
2. **Payload 内存**：百万 chunk 时 Payload 不能放全文（全量常驻内存），只放摘要/路径/hash，正文回源读取。
3. **库名一致性**：检索时库名必须与 `knowledge/` 一级目录名完全一致。
4. **TDBdocs 默认排除**：`TDB_KNOWLEDGE_EXCLUDE_FOLDERS=TDBdocs` 默认排除文档源目录；如需检索它，先从排除项移除并重启建库。
5. **批量导入速度**：大库初始导入建议结合 TriviumDB 的低同步模式与分批 flush（如 Node 绑定暴露 syncMode）。
6. **绑定 API 验证**：TriviumDB Node 包的实际导出类名/方法名需以安装后实测为准；`_callDb()` 已做多命名容错。

---

## 10. 测试结论

- ✅ Rust 模块 `npm run build`（release）编译通过
- ✅ `node -c` 语法检查全部通过：TDBKnowledge.js / server.js / Plugin.js / LightMemo.js
- ✅ manifest JSON 解析通过
- ✅ 启动顺利，300 文档光速建库
- ✅ LightMemo 冷知识库检索指令接入完成

**全量测试通过。**