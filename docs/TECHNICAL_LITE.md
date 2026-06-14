# VCP 技术 Lite 索引

这份文档是 [`README.md`](../README.md) 与完整工程文档之间的中间层。

[`README.md`](../README.md) 负责讲清 VCP 的理念与范式；[`VCP.md`](../VCP.md) 负责展开设计演讲；[`docs/DOCUMENTATION_INDEX.md`](./DOCUMENTATION_INDEX.md) 负责索引完整源码级文档。本文只保留一份轻量技术地图，帮助读者快速知道：VCP 大概由哪些系统组成、每个系统解决什么问题、想深入时应该读哪里。

---

## 1. 总体定位

VCP 是一个以 Node.js 为核心、以插件生态为能力边界、以记忆与上下文系统为认知中枢、以分布式网络为运行形态的 AI 中间层。

它不是单点能力集合，而是一套贯通的 AI 运行时：

- **模型层**：接入 OpenAI / Anthropic / Gemini / 各类兼容 API，并通过语义模型路由自动选模。
- **上下文层**：负责变量展开、记忆注入、工具折叠、环境感知、通知注入与上下文生命周期管理。
- **插件层**：通过六类插件协议把文件、搜索、媒体、浏览器、系统控制、论坛、任务、通讯等能力交给 Agent。
- **记忆层**：通过 TagMemo、DailyNote、冷知识库、元思考、OneRing 等机制维持长期记忆与跨端连续性。
- **分布式层**：通过 WebSocket 网络注册远程节点，让插件、文件、GPU 任务、设备控制可以跨机器透明执行。
- **前端层**：通过 VCPChat、管理面板、移动端和协议桥接，把 VCP 能力暴露给人类、Agent 和第三方客户端。

完整架构见 [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)。

---

## 2. 核心运行链路

一次典型 VCP 请求大致经历以下流程：

1. 前端或兼容客户端向 VCP 主服务发送模型请求。
2. VCP 进行协议归一化，把不同客户端格式转成统一消息结构。
3. 变量系统展开 Agent 模板、Tar / Sar / Var 占位符和静态上下文。
4. 消息预处理插件接管上下文，注入记忆、时间、环境、工具、通知与折叠摘要。
5. 语义模型路由判断当前任务适合哪个上游模型。
6. 上游模型流式返回内容。
7. VCP 解析其中的工具请求文本协议。
8. 插件系统执行本地或分布式工具，并按同步、异步、通知、摘要等生命周期返回。
9. 工具结果、状态和通知被重新编排进 AI 可理解的上下文空间。
10. 前端和 WebSocket 通知栏接收最终输出与过程事件。

深入阅读：

- [`docs/API_ROUTES.md`](./API_ROUTES.md)
- [`docs/CONFIGURATION.md`](./CONFIGURATION.md)
- [`docs/FEATURE_MATRIX.md`](./FEATURE_MATRIX.md)

---

## 3. 插件生态：六类协议

VCP 插件不是单一的 function call，而是围绕真实任务生命周期设计的六类协议：

| 类型 | 用途 |
|------|------|
| 同步插件 | 搜索、计算、文件读取、轻量查询等即时返回任务 |
| 异步插件 | 视频生成、深度调研、长周期下载、跨 Agent 委托等长期任务 |
| 静态插件 | 时间、天气、节气、系统状态、工具说明等按需注入的环境感知 |
| 服务插件 | WebSocket、监听器、下载器、后台索引等常驻服务 |
| 消息预处理插件 | 记忆注入、上下文折叠、变量处理、通知栏、角色分流等请求前管线 |
| 混合插件 | 同时具备多种生命周期的复杂系统插件 |

插件目录统一位于 [`Plugin/`](../Plugin/)，插件契约由各插件的 [`plugin-manifest.json`](../Plugin/DailyNoteWrite/plugin-manifest.json) 声明。完整插件协议见 [`docs/PLUGIN_ECOSYSTEM.md`](./PLUGIN_ECOSYSTEM.md)。

插件能力不建议在 README 中逐项展开。VCP 插件生态覆盖的只是能力边界，真正重要的是：这些能力被放进同一条上下文与分布式语义管线中，Agent 不只是“调用工具”，而是在一个整体环境中使用自己的感官与肢体。

---

## 4. 工具调用协议

VCP 使用纯文本标记协议描述工具调用，而不是依赖某一家模型的原生 function calling。

基本形态如下：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」ExampleTool「末」,
query:「始」需要处理的自然语言参数「末」
<<<[END_TOOL_REQUEST]>>>
```

这种协议的主要意义：

- 任意能输出文本的模型都能使用。
- 多行文本、代码、嵌套协议、自然语言参数都更容易承载。
- 参数键具备大小写、下划线、连字符等模糊容错。
- 同类插件可以共享指令风格，降低 Agent 认知负担。
- 工具结果会被转成 AI 易读的 Markdown / 多模态数组，而不是裸 JSON 嵌套。

相关实现可从 [`modules/vcpLoop/toolCallParser.js`](../modules/vcpLoop/toolCallParser.js)、[`modules/vcpLoop/toolExecutor.js`](../modules/vcpLoop/toolExecutor.js) 与 [`Plugin.js`](../Plugin.js) 入手。

---

## 5. 变量与系统提示词管线

VCP 的系统提示词不是静态文本，而是一套可递归展开的模板系统。

常见变量类型：

| 类型 | 作用 |
|------|------|
| Agent 变量 | 角色模板与人格定义 |
| Tar 变量 | 高优先级模块化提示词，可递归嵌套 |
| Sar 变量 | 按当前模型条件生效的模型适配提示词 |
| Var 变量 | 通用变量、工具箱、环境说明、公共文本块 |
| 静态插件占位符 | 由插件提供的动态上下文，如天气、时间、工具描述 |
| 日记 DSL | 通过 `[[...]]` 语法启用记忆、时间、分组、TagMemo、Rerank 等能力 |

相关文件与文档：

- [`modules/messageProcessor.js`](../modules/messageProcessor.js)
- [`modules/tvsManager.js`](../modules/tvsManager.js)
- [`modules/sarPromptManager.js`](../modules/sarPromptManager.js)
- [`docs/CONFIGURATION.md`](./CONFIGURATION.md)

---

## 6. 记忆、知识与上下文

VCP 的记忆系统不是传统“查相似文本”的单一路线，而是多层系统协作：

| 子系统 | 作用 |
|--------|------|
| DailyNote | Agent 生活记忆、日记、任务过程、关系与反思 |
| TagMemo / 浪潮 | 基于标签共现、神经脉冲与语义动力学的联想式记忆 |
| EPA / 残差金字塔 | 分析当前上下文的逻辑深度、语义宽度与潜在意图 |
| 冷知识库 | 面向文档、手册、论文、百科资料的大规模知识检索 |
| 元思考 | 存储可复用的推理路径、思维结构与抽象逻辑框架 |
| OneRing | 面向多端、多入口的 Agent 统一事实时间线 |
| 上下文折叠 | 把无关历史、工具列表、环境信息按语义相关性压缩或展开 |

关键入口：

- [`KnowledgeBaseManager.js`](../KnowledgeBaseManager.js)
- [`TagMemoEngine.js`](../TagMemoEngine.js)
- [`TDBKnowledge.js`](../TDBKnowledge.js)
- [`docs/MEMORY_SYSTEM.md`](./MEMORY_SYSTEM.md)：源码级记忆系统架构索引
- [`docs/VCP记忆管理系统.md`](./VCP记忆管理系统.md)：记忆系统上手、日记本管理与操作指南
- [`docs/TagMemo_Wave_Algorithm_Deep_Dive.md`](./TagMemo_Wave_Algorithm_Deep_Dive.md)：TagMemo / 浪潮算法数学原理深潜
- [`docs/TDB_COLD_KNOWLEDGE_BASE.md`](./TDB_COLD_KNOWLEDGE_BASE.md)：冷知识库与 TriviumDB 检索体系

---

## 7. 语义模型路由

VCP 支持把一个虚拟模型名映射为一套语义路由策略。

它解决的问题不是“模型挂了换一个”，而是：

- 日常聊天用更快更便宜的模型。
- 深度推理自动切到更强模型。
- 代码、文档、视觉、创作等任务走不同语义区间。
- 上游失败时按当前任务语义选择备选模型。
- Sar 提示词随真实模型切换同步适配。

相关文件：

- [`modules/semanticModelRouter.js`](../modules/semanticModelRouter.js)
- [`SemanticModelRouter.json`](../SemanticModelRouter.json)
- [`docs/SEMANTIC_MODEL_ROUTER.md`](./SEMANTIC_MODEL_ROUTER.md)

---

## 8. 分布式架构

VCP 主服务器通过 WebSocket 维护分布式节点网络。节点可以注册自己的插件与能力，主服务器在执行工具时自动判断本地执行还是远程执行。

关键能力：

- 节点连接与工具注册。
- 远程插件执行。
- 节点断开后的插件注销与能力降级。
- 透明跨节点文件拉取。
- 分布式缓存与路径替换。
- 多设备、多模型、多向量源容灾。

相关文件与文档：

- [`WebSocketServer.js`](../WebSocketServer.js)
- [`FileFetcherServer.js`](../FileFetcherServer.js)
- [`docs/DISTRIBUTED_ARCHITECTURE.md`](./DISTRIBUTED_ARCHITECTURE.md)

---

## 9. 前端与管理面板

VCP 不绑定单一前端。官方推荐前端是 VCPChat，同时也通过协议桥接兼容多种客户端。

主要入口：

- VCPChat：官方桌面端，承担高密度聊天、渲染、工具 GUI、Agent 群聊等能力。
- 管理面板：配置、插件、RAG、变量、模型路由、日志与系统控制。
- VCPMobile：移动端友情项目。
- aio-hub：Tauri 桌面客户端友情项目。
- OpenWebUI / SillyTavern 等：通过子项目、脚本或协议桥接适配。
- 协议桥接路由：兼容 OpenAI Responses、Anthropic Messages、Gemini GenerateContent 等 API 格式。

相关路径：

- [`AdminPanel-Vue/`](../AdminPanel-Vue/)
- [`routes/adminPanelRoutes.js`](../routes/adminPanelRoutes.js)
- [`routes/protocolBridge.js`](../routes/protocolBridge.js)
- [`OpenWebUISub/`](../OpenWebUISub/)
- [`SillyTavernSub/`](../SillyTavernSub/)
- [`docs/FRONTEND_COMPONENTS.md`](./FRONTEND_COMPONENTS.md)

---

## 10. 插件能力概览

这里只保留能力类别，不展开具体插件清单。完整插件状态应以 [`Plugin/`](../Plugin/) 与管理面板为准。

| 类别 | 示例能力 |
|------|----------|
| 多媒体生成 | 文生图、图生图、文生视频、图生视频、音乐生成、音视频剪辑 |
| 信息检索 | 联网搜索、学术搜索、论文订阅、深度研究、图片溯源 |
| 网络操作 | 浏览器控制、网页抓取、B 站 / YouTube 内容获取、多线程下载 |
| 文件与系统 | 文件读写、代码检索、命令执行、工作区监控、跨节点文件访问 |
| 通讯与社交 | Agent 通讯、消息推送、论坛、任务版、邮箱、群聊 |
| 记忆与知识 | 日记写入、语义检索、冷知识库、元思考、梦境/反思类系统 |
| IoT 与设备 | 智能家居、桌面控制、分布式设备感知 |
| 科学与计算 | 科学计算、函数绘图、3D 渲染、生物信息学与专业查询 |

插件生态的重点不是“有多少工具”，而是“工具被纳入同一套生命周期、权限、上下文与分布式系统中”。

---

## 11. 安全与部署提示

VCP 具备系统级、网络级、文件级和插件级能力，因此部署时必须把它当作高权限服务对待。

基本原则：

- 不要使用非官方或反向代理 API。
- 不要把真实密钥提交到仓库。
- 不要公开暴露管理面板。
- 高危插件应配置细粒度授权。
- 分布式节点必须使用一致且安全的密钥。
- 生产环境建议配合反向代理、防火墙、进程管理与备份策略。
- 任何涉及 shell、文件删除、远程执行的插件都应谨慎开启。

相关文档：

- [`docs/OPERATIONS.md`](./OPERATIONS.md)
- [`docs/CONFIGURATION.md`](./CONFIGURATION.md)
- [`docs/API_ROUTES.md`](./API_ROUTES.md)

---

## 12. 推荐阅读路径

如果你只想理解 VCP 是什么：

1. [`README.md`](../README.md)
2. [`VCP.md`](../VCP.md)
3. 本文档

如果你想部署：

1. [`README.md`](../README.md) 的“上手”部分
2. [`docs/OPERATIONS.md`](./OPERATIONS.md)
3. [`docs/CONFIGURATION.md`](./CONFIGURATION.md)

如果你想开发插件：

1. 本文档的“插件生态”部分
2. [`docs/PLUGIN_ECOSYSTEM.md`](./PLUGIN_ECOSYSTEM.md)
3. [`Plugin/DailyNoteWrite/README.md`](../Plugin/DailyNoteWrite/README.md) 等已有插件样例

如果你想理解记忆系统：

1. [`VCP.md`](../VCP.md) 的记忆与上下文章节
2. [`docs/VCP记忆管理系统.md`](./VCP记忆管理系统.md)：先上手，理解日记本、记忆注入和日常操作
3. [`docs/MEMORY_SYSTEM.md`](./MEMORY_SYSTEM.md)：再看源码级架构与核心组件
4. [`docs/TagMemo_Wave_Algorithm_Deep_Dive.md`](./TagMemo_Wave_Algorithm_Deep_Dive.md)：最后深入浪潮算法的数学原理

如果你想理解完整工程：

1. [`docs/DOCUMENTATION_INDEX.md`](./DOCUMENTATION_INDEX.md)
2. [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)
3. [`docs/FEATURE_MATRIX.md`](./FEATURE_MATRIX.md)
4. [`docs/FILE_INVENTORY.md`](./FILE_INVENTORY.md)

---

## 13. 和旧 README 的关系

旧版 README 曾经承担了“解释一切”的职责：理念、功能、插件列表、安装、技术细节、示例、FAQ 都堆在同一份文件里。随着 VCP 进入 1.1 正式版，这种写法已经不适合作为项目门面。

现在的文档分工更清晰：

- [`README.md`](../README.md)：理念门面，讲 VCP 为什么不是普通 Agent 框架。
- [`docs/TECHNICAL_LITE.md`](./TECHNICAL_LITE.md)：轻量技术索引，保留旧 README 中最重要的技术地图。
- [`docs/DOCUMENTATION_INDEX.md`](./DOCUMENTATION_INDEX.md)：完整文档入口。
- [`VCP.md`](../VCP.md)：设计演讲稿，适合理解 VCP 的原创思想与系统愿景。

这样，README 不再需要证明 VCP 有多复杂；技术细节也不会消失，而是进入更适合维护和检索的位置。