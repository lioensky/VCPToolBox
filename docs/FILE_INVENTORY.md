# VCPToolBox 文件清单

> **生成时间：** 2026-02-13
> **项目版本：** VCP 6.4

---

## 目录

1. [根目录核心文件](#1-根目录核心文件)
2. [modules 模块清单](#2-modules-模块清单)
3. [routes 路由清单](#3-routes-路由清单)
4. [Plugin 插件目录](#4-plugin-插件目录)
5. [配置文件清单](#5-配置文件清单)
6. [前端资源清单](#6-前端资源清单)
7. [Rust 向量引擎](#7-rust-向量引擎)
8. [辅助脚本与工具](#8-辅助脚本与工具)

---

## 1. 根目录核心文件

### 1.1 核心入口文件

| 文件路径 | 职责 | 关键函数/类 | 依赖关系 |
|---------|------|------------|---------|
| `server.js` | 主HTTP/SSE入口与启动编排 | `startServer()`, `ensureAgentDirectory()` | express, dotenv, node-schedule, chokidar, basic-auth, cors |
| `Plugin.js` | 插件生命周期、加载与执行总控 | `PluginManager` 类 | child_process, node-schedule, chokidar, FileFetcherServer |
| `WebSocketServer.js` | 分布式节点与工具桥接 | `initialize()`, `generateClientId()` | ws, url |
| `KnowledgeBaseManager.js` | RAG/标签/向量索引总控 | `KnowledgeBaseManager` 类 | better-sqlite3, chokidar, TextChunker, EmbeddingUtils, EPAModule, ResidualPyramid, ResultDeduplicator |
| `FileFetcherServer.js` | 跨节点文件获取服务 | `initialize()`, `fetchFile()` | fs, mime-types, crypto |

### 1.2 核心工具模块

| 文件路径 | 职责 | 关键函数/类 | 依赖关系 |
|---------|------|------------|---------|
| `EmbeddingUtils.js` | 向量嵌入批量处理 | `getEmbeddingsBatch()` | axios |
| `TextChunker.js` | 文本分块算法 | `chunkText()` | - |
| `ResidualPyramid.js` | 残差金字塔算法（TagMemo核心） | `ResidualPyramid` 类 | - |
| `ResultDeduplicator.js` | 检索结果去重 | `ResultDeduplicator` 类 | - |
| `EPAModule.js` | 嵌入投影分析模块 | `EPAModule` 类 | - |
| `WorkerPool.js` | 并行工作线程池 | `WorkerPool` 类 | worker_threads |
| `vcpInfoHandler.js` | VCP信息处理器 | `vcpInfoHandler` | - |
| `modelRedirectHandler.js` | 模型重定向处理 | `modelRedirectHandler` | - |

### 1.3 维护与修复脚本

| 文件路径 | 职责 | 入口函数 | 依赖关系 |
|---------|------|---------|---------|
| `rebuild_vector_indexes.js` | 重建向量索引 | main() | KnowledgeBaseManager |
| `rebuild_tag_index_custom.js` | 重建标签索引 | main() | KnowledgeBaseManager |
| `repair_database.js` | 数据库修复 | main() | better-sqlite3 |
| `reset_vectordb.js` | 重置向量数据库 | main() | fs |
| `sync_missing_tags.js` | 同步缺失标签 | main() | KnowledgeBaseManager |
| `diary-tag-batch-processor.js` | 日记标签批处理 | main() | - |

### 1.4 Python 脚本

| 文件路径 | 职责 | 依赖关系 |
|---------|------|---------|
| `WinNotify.py` | Windows 系统通知 | win10toast |
| `backup_vcp.py` | VCP 备份脚本 | - |
| `timeline整理器.py` | 时间线整理工具 | - |

### 1.5 批处理脚本

| 文件路径 | 职责 |
|---------|------|
| `start_server.bat` | 启动服务器 |
| `update.bat` | 完整更新（含依赖） |
| `update_with_no_dependency.bat` | 无依赖更新 |

---

## 2. modules 模块清单

### 2.1 核心处理模块

| 文件路径 | 职责 | 导出接口 | 被调用者 |
|---------|------|---------|---------|
| `modules/chatCompletionHandler.js` | 对话主流程编排 | `ChatCompletionHandler` 类 | server.js |
| `modules/messageProcessor.js` | 提示词与占位符注入管线 | `resolveAllVariables()`, `replaceOtherVariables()` | ChatCompletionHandler, server.js |
| `modules/contextManager.js` | 上下文管理 | `ContextManager` | ChatCompletionHandler |
| `modules/roleDivider.js` | 角色分割转换 | `divideRoles()` | messageProcessor |

### 2.2 管理器模块

| 文件路径 | 职责 | 导出接口 | 被调用者 |
|---------|------|---------|---------|
| `modules/agentManager.js` | Agent别名映射与文件管理 | `isAgent()`, `getAgentPrompt()`, `getAgentList()` | messageProcessor, server.js |
| `modules/tvsManager.js` | TVS高级变量管理 | `getTVSContent()`, `getAllTVSFiles()` | messageProcessor |
| `modules/logger.js` | 日志初始化与控制台重定向 | `initializeServerLogger()`, `overrideConsole()` | server.js |
| `modules/captchaDecoder.js` | 验证码解码 | `getAuthCode()`, `decryptAuthCode()` | Plugin.js, adminPanelRoutes.js |

### 2.3 VCP Loop 子模块

| 文件路径 | 职责 | 导出接口 | 被调用者 |
|---------|------|---------|---------|
| `modules/vcpLoop/toolCallParser.js` | VCP工具调用解析 | `ToolCallParser` 类 | ChatCompletionHandler |
| `modules/vcpLoop/toolExecutor.js` | 工具执行器 | `ToolExecutor` 类 | ChatCompletionHandler |

### 2.4 Handler 子模块

| 文件路径 | 职责 | 导出接口 | 被调用者 |
|---------|------|---------|---------|
| `modules/handlers/streamHandler.js` | 流式响应处理 | `StreamHandler` 类 | ChatCompletionHandler |
| `modules/handlers/nonStreamHandler.js` | 非流式响应处理 | `NonStreamHandler` 类 | ChatCompletionHandler |

### 2.5 SSHManager 子模块

| 文件路径 | 职责 | 导出接口 | 被调用者 |
|---------|------|---------|---------|
| `modules/SSHManager/index.js` | SSH管理入口 | `SSHManager` | Plugin/LinuxShellExecutor |
| `modules/SSHManager/SSHManager.js` | SSH连接管理 | `SSHManager` 类 | index.js |
| `modules/SSHManager/hosts.json` | SSH主机配置 | - | SSHManager |

---

## 3. routes 路由清单

| 文件路径 | 挂载路径 | 职责 | 主要端点 |
|---------|---------|------|---------|
| `routes/adminPanelRoutes.js` | `/admin_api` | 管理面板API | `/system-monitor/*`, `/config/*`, `/plugins/*`, `/notes/*`, `/rag/*` |
| `routes/dailyNotesRoutes.js` | `/dailynote` | 日记文件管理 | `GET/POST/DELETE /*`（路径穿越防护） |
| `routes/forumApi.js` | `/forum_api` | 论坛接口 | `/posts/*`, `/threads/*`, `/vote/*` |
| `routes/specialModelRouter.js` | `/v1` | 特殊模型透传 | `/images/generations`, `/embeddings` |
| `routes/taskScheduler.js` | (非Router) | 任务调度模块 | `scheduleJob()`, `cancelJob()` |

---

## 4. Plugin 插件目录

### 4.1 多媒体生成类 (15个)

| 插件目录 | 类型 | 职责 | 主要文件 |
|---------|------|------|---------|
| `FluxGen` | synchronous | Flux文生图 | FluxGen.js |
| `ComfyUIGen` | asynchronous | ComfyUI工作流生图 | ComfyUIGen.js, workflow_template_processor.py |
| `DoubaoGen` | synchronous | 豆包生图 | DoubaoGen.js |
| `DMXDoubaoGen` | synchronous | 豆包视频生成 | DMXDoubaoGen.js |
| `GeminiImageGen` | synchronous | Gemini图像生成 | GeminiImageGen.js |
| `GrokVideo` | asynchronous | Grok视频生成 | video_handler.py, GrokVideo.js |
| `VideoGenerator` | asynchronous | 视频生成器 | video_handler.py, VideoGenerator.js |
| `SunoGen` | asynchronous | Suno音乐生成 | SunoGen.js |
| `NanoBananaGen2` | synchronous | 纳米香蕉2代 | NanoBananaGen2.js |
| `NanoBananaGenOR` | synchronous | 纳米香蕉OR版 | NanoBananaGenOR.js |
| `NovelAIGen` | synchronous | NovelAI生图 | NovelAIGen.js |
| `QwenImageGen` | synchronous | 通义千问生图 | QwenImageGen.js |
| `WebUIGen` | synchronous | WebUI生图 | WebUIGen.js |
| `ZImageGen` | synchronous | Z图像生成 | ZImageGen.js |
| `ZImageGen2` | synchronous | Z图像生成2代 | ZImageGen2.js |

### 4.2 信息检索类 (12个)

| 插件目录 | 类型 | 职责 | 主要文件 |
|---------|------|------|---------|
| `VSearch` | synchronous | VCP联网搜索 | VSearch.js |
| `TavilySearch` | synchronous | Tavily搜索 | TavilySearch.js |
| `GoogleSearch` | synchronous | 谷歌搜索 | GoogleSearch.js |
| `SerpSearch` | synchronous | SerpAPI搜索 | SerpSearch.js, engines/*.js |
| `ArxivDailyPapers` | static | Arxiv论文订阅 | ArxivDailyPapers.js |
| `CrossRefDailyPapers` | static | CrossRef论文订阅 | - |
| `DeepWikiVCP` | synchronous | DeepWiki集成 | DeepWikiVCP.js |
| `FlashDeepSearch` | synchronous | 深度爬虫搜索 | FlashDeepSearch.js |
| `PubMedSearch` | synchronous | PubMed搜索 | PubMedSearch.js |
| `NCBIDatasets` | synchronous | NCBI数据集 | NCBIDatasets.js |
| `KEGGSearch` | synchronous | KEGG搜索 | KEGGSearch.js |
| `KarakeepSearch` | synchronous | Karakeep搜索 | KarakeepSearch.js |

### 4.3 日记与记忆类 (6个)

| 插件目录 | 类型 | 职责 | 主要文件 |
|---------|------|------|---------|
| `DailyNote` | synchronous | 日记管理（统一入口） | dailynote.js |
| `DailyNoteGet` | synchronous | 日记获取 | daily-note-get.js |
| `DailyNoteWrite` | synchronous | 日记写入 | - |
| `DailyNotePanel` | service | 日记面板服务 | - |
| `DailyNoteManager` | synchronous | 日记管理器 | - |
| `RAGDiaryPlugin` | static | RAG日记插件 | - |

### 4.4 文件操作类 (6个)

| 插件目录 | 类型 | 职责 | 主要文件 |
|---------|------|------|---------|
| `FileOperator` | synchronous | 文件编辑器 | FileOperator.js, CodeValidator.js |
| `FileServer` | service | 文件服务器 | - |
| `FileListGenerator` | static | 文件列表生成 | file-list-generator.js |
| `FileTreeGenerator` | synchronous | 文件树生成 | - |
| `VCPEverything` | synchronous | 本地文件搜索 | local-search-controller.js |
| `WorkspaceInjector` | static | 工作区注入 | injector.js |

### 4.5 浏览器与网络类 (4个)

| 插件目录 | 类型 | 职责 | 主要文件 |
|---------|------|------|---------|
| `ChromeBridge` | synchronous | 浏览器控制 | - |
| `UrlFetch` | synchronous | URL抓取 | UrlFetch.js |
| `BilibiliFetch` | synchronous | B站内容获取 | BilibiliFetch.py |
| `IMAPSearch` | synchronous | IMAP邮件搜索 | - |

### 4.6 Agent通讯类 (5个)

| 插件目录 | 类型 | 职责 | 主要文件 |
|---------|------|------|---------|
| `AgentAssistant` | service | Agent通讯服务器 | AgentAssistant.js |
| `AgentMessage` | synchronous | Agent消息推送 | AgentMessage.js |
| `MagiAgent` | service | Magi三贤者系统 | - |
| `VCPForum` | service | VCP论坛服务 | - |
| `VCPForumAssistant` | static | 论坛小助手 | - |

### 4.7 系统监控与Shell类 (5个)

| 插件目录 | 类型 | 职责 | 主要文件 |
|---------|------|------|---------|
| `LinuxShellExecutor` | synchronous | Linux Shell执行 | - |
| `PowerShellExecutor` | synchronous | PowerShell执行 | - |
| `LinuxLogMonitor` | service | Linux日志监控 | LinuxLogMonitor.js, core/*.js |
| `1PanelInfoProvider` | static | 1Panel信息 | 1PanelInfoProvider.js, utils.js |
| `FRPSInfoProvider` | static | FRPS信息 | - |

### 4.8 科学计算类 (3个)

| 插件目录 | 类型 | 职责 | 主要文件 |
|---------|------|------|---------|
| `SciCalculator` | synchronous | 科学计算器 | calculator.py |
| `Randomness` | synchronous | 随机数/塔罗牌 | main.py, dice_roller.py |
| `TarotDivination` | synchronous | 塔罗占卜 | Celestial.py |

### 4.9 图像与多模态类 (4个)

| 插件目录 | 类型 | 职责 | 主要文件 |
|---------|------|------|---------|
| `ImageProcessor` | synchronous | 图像处理 | - |
| `ImageServer` | service | 图像服务器 | - |
| `PyScreenshot` | synchronous | Python截图 | screenshot.py |
| `PyCameraCapture` | synchronous | 摄像头捕获 | capture.py |

### 4.10 调度与任务类 (4个)

| 插件目录 | 类型 | 职责 | 主要文件 |
|---------|------|------|---------|
| `ScheduleManager` | service | 调度管理器 | - |
| `ScheduleBriefing` | static | 调度简报 | - |
| `TimelineGenerator` | synchronous | 时间线生成 | - |
| `ProjectAnalyst` | service | 项目分析 | GUI.py |

### 4.11 其他工具类 (15个)

| 插件目录 | 类型 | 职责 | 主要文件 |
|---------|------|------|---------|
| `UserAuth` | static | 用户认证 | auth.js |
| `CapturePreprocessor` | messagePreprocessor | 消息预处理 | CapturePreprocessor.js |
| `CodeSearcher` | synchronous | 代码搜索 | - |
| `WeatherReporter` | static | 天气报告 | - |
| `WeatherInfoNow` | static | 实时天气 | - |
| `DailyHot` | static | 热点新闻 | - |
| `EmojiListGenerator` | static | 表情包列表 | emoji-list-generator.js |
| `LightMemo` | synchronous | 轻量备忘 | - |
| `MCPO` | synchronous | MCP协议兼容 | mcpo_plugin.py |
| `MCPOMonitor` | service | MCP监控 | - |
| `AnimeFinder` | synchronous | 动漫查找 | AnimeFinder.js |
| `ArtistMatcher` | synchronous | 艺术家匹配 | artist_matcher.py |
| `SVCardFinder` | synchronous | SV卡片查找 | card_finder.py |
| `MIDITranslator` | synchronous | MIDI翻译 | - |
| `TencentCOSBackup` | asynchronous | 腾讯云备份 | cos_handler.py |
| `SynapsePusher` | synchronous | Synapse推送 | - |
| `VCPLog` | service | VCP日志 | - |
| `VCPForumLister` | static | 论坛列表 | - |
| `ThoughtClusterManager` | service | 思维聚类管理 | - |
| `SemanticGroupEditor` | static | 语义组编辑 | - |
| `IMAPIndex` | service | IMAP索引 | - |
| `PaperReader` | synchronous | 论文阅读 | - |

---

## 5. 配置文件清单

### 5.1 全局配置

| 文件路径 | 职责 | 格式 |
|---------|------|------|
| `config.env` | 主配置文件（需创建） | ENV |
| `config.env.example` | 配置模板 | ENV |
| `package.json` | NPM包配置 | JSON |
| `package-lock.json` | NPM锁定文件 | JSON |
| `requirements.txt` | Python依赖 | TXT |
| `Dockerfile` | Docker构建文件 | Dockerfile |
| `docker-compose.yml` | Docker编排文件 | YAML |
| `.gitignore` | Git忽略规则 | TXT |
| `LICENSE` | 许可证 | TXT |

### 5.2 运行时配置

| 文件路径 | 职责 | 格式 |
|---------|------|------|
| `rag_params.json` | RAG参数配置 | JSON |
| `ip_blacklist.json` | IP黑名单 | JSON |
| `preprocessor_order.json` | 预处理器顺序 | JSON |
| `diary-tag-processor-package.json` | 日记标签处理器包 | JSON |

### 5.3 插件配置文件 (52个)

每个插件可有自己的 `config.env` 或 `config.env.example`：

```
Plugin/FluxGen/config.env.example
Plugin/ComfyUIGen/config.env.example
Plugin/VideoGenerator/config.env.example
Plugin/AgentAssistant/config.env.example
Plugin/LinuxShellExecutor/config.env
Plugin/PowerShellExecutor/config.env
Plugin/FileOperator/config.env
Plugin/DailyNote/config.env
...（共52个插件配置）
```

### 5.4 插件Manifest文件 (79个)

每个插件都有 `plugin-manifest.json` 定义其元数据和能力。

---

## 6. 前端资源清单

### 6.1 AdminPanel 管理面板 (37个文件)

#### 主页面

| 文件路径 | 职责 |
|---------|------|
| `AdminPanel/index.html` | 主页面入口 |
| `AdminPanel/login.html` | 登录页面 |
| `AdminPanel/style.css` | 主样式 |
| `AdminPanel/script.js` | 主脚本 |

#### 子页面

| 文件路径 | 职责 |
|---------|------|
| `AdminPanel/rag_tags_editor.html` | RAG标签编辑器 |
| `AdminPanel/rag_tags_editor.css` | RAG标签样式 |
| `AdminPanel/tool_list_editor.html` | 工具列表编辑器 |
| `AdminPanel/tool_list_editor.js` | 工具列表脚本 |
| `AdminPanel/tool_list_editor_new.css` | 工具新样式 |
| `AdminPanel/vcptavern_editor.html` | VCPTavern编辑器 |
| `AdminPanel/vcptavern_editor.js` | VCPTavern脚本 |
| `AdminPanel/vcptavern_editor.css` | VCPTavern样式 |
| `AdminPanel/image_cache_editor.html` | 图像缓存编辑器 |
| `AdminPanel/image_cache_editor.css` | 图像缓存样式 |

#### JS模块

| 文件路径 | 职责 |
|---------|------|
| `AdminPanel/js/dashboard.js` | 仪表盘模块 |
| `AdminPanel/js/config.js` | 配置管理模块 |
| `AdminPanel/js/plugins.js` | 插件管理模块 |
| `AdminPanel/js/notes-manager.js` | 笔记管理模块 |
| `AdminPanel/js/log-viewer.js` | 日志查看器 |
| `AdminPanel/js/rag-tuning.js` | RAG调参模块 |
| `AdminPanel/js/tvs-editor.js` | TVS编辑器 |
| `AdminPanel/js/agent-manager.js` | Agent管理器 |
| `AdminPanel/js/agent-assistant-config.js` | Agent助手配置 |
| `AdminPanel/js/forum.js` | 论坛模块 |
| `AdminPanel/js/schedule-manager.js` | 调度管理器 |
| `AdminPanel/js/preprocessor-manager.js` | 预处理器管理 |
| `AdminPanel/js/thinking-chains-editor.js` | 思维链编辑器 |
| `AdminPanel/js/semantic-groups-editor.js` | 语义组编辑器 |
| `AdminPanel/js/utils.js` | 工具函数 |

#### 静态资源

| 文件路径 | 职责 |
|---------|------|
| `AdminPanel/marked.min.js` | Markdown解析器 |
| `AdminPanel/easymde.min.js` | EasyMDE编辑器 |
| `AdminPanel/easymde.min.css` | EasyMDE样式 |
| `AdminPanel/woff.css` | 字体样式 |
| `AdminPanel/font.woff2` | 字体文件 |
| `AdminPanel/favicon.ico` | 网站图标 |
| `AdminPanel/VCPLogo2.png` | Logo图片 |
| `AdminPanel/AGENTS.md` | 模块文档 |

### 6.2 VCPChrome 浏览器扩展 (9个文件)

| 文件路径 | 职责 |
|---------|------|
| `VCPChrome/manifest.json` | 扩展清单 |
| `VCPChrome/background.js` | 后台脚本 |
| `VCPChrome/content_script.js` | 内容脚本 |
| `VCPChrome/popup.js` | 弹出窗口脚本 |
| `VCPChrome/popup.html` | 弹出窗口页面 |
| `VCPChrome/icons/icon16.png` | 16x16图标 |
| `VCPChrome/icons/icon48.png` | 48x48图标 |
| `VCPChrome/icons/icon128.png` | 128x128图标 |
| `VCPChrome/icons/icon_disconnected.png` | 断开连接图标 |

### 6.3 OpenWebUISub 用户脚本 (3个文件)

| 文件路径 | 职责 |
|---------|------|
| `OpenWebUISub/VCP_DailyNote_SidePanel.user.js` | 日记侧边栏 |
| `OpenWebUISub/OpenWebUI VCP Tool Call Display Enhancer.user.js` | 工具调用增强显示 |
| `OpenWebUISub/OpenWebUI Force HTML Image Renderer with Lightbox.user.js` | HTML图像渲染器 |

### 6.4 SillyTavernSub 资源 (8个文件)

| 文件路径 | 职责 |
|---------|------|
| `SillyTavernSub/ST油猴插件-酒馆VCP-通知栏.js` | 通知栏脚本 |
| `SillyTavernSub/ST油猴插件-酒馆VCP-VCP渲染.js` | VCP渲染脚本 |
| `SillyTavernSub/ST油猴插件-酒馆VCP-VCP时钟.js` | VCP时钟脚本 |
| `SillyTavernSub/ST正则 优化日记显示1.json` | 日记正则1 |
| `SillyTavernSub/ST正则 优化日记显示2.json` | 日记正则2 |
| `SillyTavernSub/ST正则 vcp调用优化1.json` | VCP调用正则1 |
| `SillyTavernSub/ST正则 vcp调用优化2.json` | VCP调用正则2 |
| `SillyTavernSub/ST主题布局 Inspired Mix V1.17 By Lionsky.json` | 主题布局 |

---

## 7. Rust 向量引擎

### 7.1 rust-vexus-lite 目录

| 文件路径 | 职责 |
|---------|------|
| `rust-vexus-lite/Cargo.toml` | Rust项目配置 |
| `rust-vexus-lite/src/lib.rs` | 核心库代码 |
| `rust-vexus-lite/index.js` | Node.js绑定 |
| `rust-vexus-lite/test.js` | 测试脚本 |
| `rust-vexus-lite/package.json` | NPM配置 |
| `rust-vexus-lite/AGENTS.md` | 模块文档 |

### 7.2 编译产物

| 文件路径 | 职责 |
|---------|------|
| `rust-vexus-lite/*.node` | 原生Node模块（按平台） |

---

## 8. 辅助脚本与工具

### 8.1 测试文件

| 文件路径 | 职责 |
|---------|------|
| `test-units.js` | 单元测试 |
| `example.test.js` | 示例测试 |

### 8.2 CI/CD 配置

| 文件路径 | 职责 |
|---------|------|
| `.github/workflows/ci.yml` | GitHub Actions CI配置 |

### 8.3 文档文件

| 文件路径 | 职责 |
|---------|------|
| `README.md` | 主文档（中文） |
| `README_en.md` | 英文文档 |
| `README_ja.md` | 日文文档 |
| `README_ru.md` | 俄文文档 |
| `VCP.md` | VCP理论文档 |
| `dailynote.md` | 日记系统文档 |
| `TagMemo_Wave_Algorithm_Deep_Dive.md` | TagMemo算法深度解析 |
| `AGENTS.md` | 项目知识库 |
| `Plugin/AGENTS.md` | 插件知识库 |
| `AdminPanel/AGENTS.md` | 前端知识库 |
| `modules/AGENTS.md` | 模块知识库 |
| `routes/AGENTS.md` | 路由知识库 |
| `rust-vexus-lite/AGENTS.md` | Rust模块知识库 |

---

## 统计摘要

| 类别 | 数量 |
|------|------|
| 根目录JS文件 | 27 |
| 根目录Python文件 | 3 |
| 批处理脚本 | 3 |
| modules模块 | 14 |
| routes路由 | 5 |
| 活跃插件 | 79 |
| 插件配置文件 | 52 |
| AdminPanel文件 | 37 |
| VCPChrome文件 | 9 |
| OpenWebUISub脚本 | 3 |
| SillyTavernSub资源 | 8 |
| Rust模块文件 | 6 |

---

> **备注：** 本清单基于项目当前状态生成，可能随项目更新而变化。插件目录的完整列表可通过 `ls Plugin/` 获取最新状态。
