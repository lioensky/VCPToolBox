# VCPToolBox 当前实现校准记录

**校准日期：** 2026-05-01
**目的：** 标记主文档中已经落后于代码的部分，并说明静态工具箱、动态工具清单、工具列表配置编辑器之间的真实关系。

---

## 1. 文档状态

### 仍可作为主入口的文档

| 文档 | 当前判断 |
|------|----------|
| `README.md` | 适合作为理念与总览入口，但部分插件数量和动态工具描述需要以代码为准。 |
| `docs/CONFIGURATION.md` | 配置结构基本可用，DynamicToolBridge 小节已按当前实现补充。 |
| `docs/API_ROUTES.md` | Admin API 端点描述基本可用，动态工具端点与当前路由一致。 |
| `docs/PLUGIN_ECOSYSTEM.md` | 插件机制仍有参考价值，动态工具清单小节已按当前实现补充。 |
| `VCP记忆管理系统.md` | 其中 ToolboxManager / TagMemo 章节仍有参考价值，但算法版本描述应以 `KnowledgeBaseManager.js`、`RAGDiaryPlugin`、`rag_params.json` 为准。 |

### 应视为历史快照的文档

| 文档 | 原因 |
|------|------|
| `docs/ARCHITECTURE.md` | 顶部标注为 2026-02-13 / d09c49f，启动序列和 AdminPanel 描述已落后。 |
| `docs/FRONTEND_COMPONENTS.md` | 仍描述旧 `AdminPanel/` 原生 JS 面板；当前主要管理面板是 `AdminPanel-Vue/dist`，由 `adminServer.js` 独立进程托管。 |
| `docs/ADMINPANEL_DEVELOPMENT.md` | 开发方式仍指向旧 `AdminPanel/index.html`、`AdminPanel/js/*.js`，不适合作为新增 Vue 面板页面的实现指南。 |
| `docs/FILE_INVENTORY.md` | 插件清单和前端目录硬编码，当前已有 95 个带 manifest 的插件目录，多个真实插件名已改为 `Server*`。 |
| `docs/FEATURE_MATRIX.md` | 功能矩阵是旧快照，系统控制示例仍有 `PowerShellExecutor` / `requiresAdmin:true` 等旧描述。 |
| `docs/VALIDATION_REPORT_2026-02-13.md` | 明确是历史校验报告，只能用于追溯，不应当当作当前状态。 |

本轮没有删除这些历史文档，因为它们仍可用于理解上游演进和旧设计背景。更安全的处理方式是在索引中标记时效性，让后续维护优先更新或重写，而不是直接丢失上下文。

---

## 2. 静态工具箱当前链路

静态工具箱现在有两层：

1. `{{VarToolList}}`、`{{VarFileTool}}` 这类 `Tar/Var` 环境变量会从 `TVStxt/*.txt` 读取普通文本。
2. `{{VCPFileToolBox}}`、`{{VCPSearchToolBox}}`、`{{VCPContactToolBox}}`、`{{VCPMemoToolBox}}`、`{{VCPMediaToolBox}}` 会走 `toolbox_map.json` -> `modules/toolboxManager.js` -> `modules/foldProtocol.js` -> `messageProcessor.resolveDynamicFoldProtocol()`，按上下文折叠展开。

因此，`TVStxt` 文件中的 `[===vcp_fold:...===]` 只有在通过 `toolboxManager` 这条链路注入时才真正执行折叠。单纯作为 `Var...=.txt` 普通文本注入时，它只是文本分隔符。

本轮已补充测试覆盖五个静态工具箱别名，防止后续退回到“只有 MemoToolBox 折叠”的状态。

---

## 3. 动态工具清单当前链路

DynamicToolBridge 不是新的 LLM 可调用工具，也不是插件执行通道。真实执行仍由 `PluginManager.processToolCall()` 按工具名路由。

动态工具清单只负责“提示词暴露层”：

1. `server.js` 启动时初始化 `modules/dynamicToolRegistry.js`。
2. `dynamicToolRegistry` 从 `PluginManager.plugins` 读取本地与分布式插件 manifest。
3. 它生成工具 catalog、分类缓存和轻量 brief。
4. `messageProcessor` 遇到 `{{VCPDynamicTools}}` 时，注入轻量工具清单，并按当前上下文展开少量相关工具的完整说明。

可显式要求展开：

```text
[[VCPDynamicTools:category=search:all]]
[[VCPDynamicTools:tool=VSearch]]
```

动态工具的优势不是“比静态工具箱更懂业务”，而是：

- 能自动跟随当前可用插件变化，包括分布式节点上线/离线。
- 能避免 `{{VCPAllTools}}` 全量注入造成的上下文膨胀。
- 能把长尾工具留在轻量清单里，只在语义命中或被点名时展开完整说明。
- 能通过后台排除、固定、分类别名控制工具暴露，而不需要手改 Agent 角色卡。

动态工具的短板也很明确：

- 自动分类依赖 manifest 描述质量，小模型/RAG/关键词分类都有误判可能。
- 不适合作为核心安全策略来源，安全仍必须由 `ToolApprovalManager`、插件 manifest、插件内部校验承担。
- 如果 Agent prompt 没有放入 `{{VCPDynamicTools}}`，它不会参与普通对话。

推荐使用方式：保留静态工具箱作为核心、稳定、带安全语义的基础层；把 `{{VCPDynamicTools}}` 作为长尾工具发现层，先在少数 Agent 上试用，再逐步替代部分冗长静态清单。

---

## 4. ToolConfigs 三类文件关系

| 文件 | 归属 | 是否人工编辑 | 作用 |
|------|------|--------------|------|
| `ToolConfigs/dynamic_tool_bridge.config.json` | DynamicToolBridge | 可以通过动态工具清单后台编辑 | 行为配置、排除/固定、分类别名、非敏感小模型开关。 |
| `ToolConfigs/dynamic_tool_catalog.json` | DynamicToolBridge | 不建议手改 | 运行时 catalog，记录插件来源、状态、hash、在线可用性。 |
| `ToolConfigs/dynamic_tool_categories.json` | DynamicToolBridge | 不建议手改 | 运行时分类缓存，记录 brief、categories、keywords、sourceHash。 |
| 其他 `ToolConfigs/*.json` | 工具列表配置编辑器 | 可以人工编辑 | 旧式手选工具清单配置，可导出为 `TVStxt/*.txt` 静态工具说明。 |

工具列表配置编辑器和动态工具清单不是同一套系统。工具列表配置编辑器是“手选工具 -> 保存 JSON -> 导出静态 txt”；动态工具清单是“扫描插件 -> 分类缓存 -> `{{VCPDynamicTools}}` 按需注入”。

本轮已让工具列表配置编辑器后台过滤 `dynamic_tool_*` 系统文件，并禁止读取、保存或删除这些保留配置，避免把动态工具运行时文件误当成普通工具列表配置。

---

## 5. 当前建议

1. 不建议马上把所有 Agent 的静态工具箱替换为 `{{VCPDynamicTools}}`。
2. 先保留 `{{VarToolList}}`、`{{VarFileTool}}` 与五个 `{{VCP...ToolBox}}`，因为它们承载了安全边界和工具名偏好。
3. 可以给测试 Agent 额外加入 `{{VCPDynamicTools}}`，观察长尾工具发现能力和误召回情况。
4. 文档后续应优先重写 `docs/FRONTEND_COMPONENTS.md`、`docs/ADMINPANEL_DEVELOPMENT.md`、`docs/FILE_INVENTORY.md`，因为这三份与当前代码偏差最大。
