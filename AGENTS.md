# 项目知识库

## 📚 完整文档体系

VCPToolBox 拥有完整的全景文档体系，从 **[docs/DOCUMENTATION_INDEX.md](./docs/DOCUMENTATION_INDEX.md)** 开始浏览。

---

## 概览

VCPToolBox 是一个以 Node.js 为核心的 AI 中间层，包含大型插件运行时（`Plugin/`）、内嵌管理前端（`AdminPanel/`）以及 Rust N-API 向量组件（`rust-vexus-lite/`）。项目采用根目录扁平化运行结构（无 `src/` 分层），定位代码时应按职责找文件而不是按目录深度找。

## 目录结构

```text
VCPToolBox/
|- server.js               # 主 HTTP/SSE 入口与启动编排
|- Plugin.js               # 插件生命周期、加载与执行总控
|- WebSocketServer.js      # 分布式节点与工具桥接
|- KnowledgeBaseManager.js # RAG/标签/向量索引总控
|- modules/                # 复用后端内部模块（见 modules/AGENTS.md）
|- routes/                 # Express 路由层（见 routes/AGENTS.md）
|- Plugin/                 # 活跃插件 + 禁用插件（见 Plugin/AGENTS.md）
|- AdminPanel/             # 内嵌静态管理前端
|- rust-vexus-lite/        # Rust N-API 向量索引子项目（见其 AGENTS.md）
|- dailynote/              # 运行数据/知识内容（非核心源码）
`- image/                  # 运行期媒体资源（非核心源码）
```

## 快速定位

| 任务 | 位置 | 说明 |
|------|------|------|
| 启动与初始化 | `server.js` | 环境加载、中间件、路由挂载、启动顺序 |
| 插件执行链路 | `Plugin.js` | manifest 解析、同步/异步/静态执行 |
| 分布式工具 | `WebSocketServer.js`, `FileFetcherServer.js` | 节点注册、远程执行、跨节点文件透明预处理 |
| 安全敏感面 | `server.js`, `Plugin.js`, `routes/adminPanelRoutes.js` | 鉴权、shell 执行、管理控制接口 |
| 变量替换流程 | `modules/messageProcessor.js` | 提示词与占位符多阶段注入管线 |
| Agent 文件映射 | `modules/agentManager.js` | `agent_map.json` 与热更新监听 |
| 多协议适配 | `routes/protocolBridge.js` | OpenAI/Anthropic/Gemini → 统一格式 |
| 管理面板后端 | `routes/adminPanelRoutes.js` + `routes/admin/` | 面板配置/系统控制类接口 |
| 特殊模型路由 | `routes/specialModelRouter.js` | 图像/向量白名单透传 |
| 插件协议样例 | `Plugin/*/plugin-manifest.json` | 各类插件本地约定 |
| 容器行为 | `Dockerfile`, `docker-compose.yml` | 运行用户、挂载策略、依赖安装方式 |

## 代码映射

| 符号/文件 | 类型 | 位置 | 作用 |
|-----------|------|------|------|
| `startServer` | 函数 | `server.js` | 最终启动门控（`app.listen` 前） |
| `PluginManager` | 类 | `Plugin.js` | 插件注册、配置合并与执行分发 |
| `initialize` | 函数 | `WebSocketServer.js` | 分布式 WebSocket 桥初始化 |
| `fetchFile` | 函数 | `FileFetcherServer.js` | 工具执行时的跨节点文件透明预处理 |
| `KnowledgeBaseManager` | 类/单例 | `KnowledgeBaseManager.js` | 向量库与 RAG 管线总控 |
| `ChatCompletionHandler` | 类 | `modules/chatCompletionHandler.js` | 对话主流程 23 步编排 |
| `AgentManager` | 类 | `modules/agentManager.js` | 别名映射、缓存与热更新监听 |
| `DynamicToolRegistry` | 类 | `modules/dynamicToolRegistry.js` | 动态工具注册、分类与按需注入 |

## 约定

- **扁平根目录**：运行时目录刻意保持根层扁平，不要假设存在 `src/` 体系。
- **配置层级**：全局配置来自 `config.env`（模板 `config.env.example`）；插件可在各自目录覆盖配置。
- **插件契约**：插件契约文件固定为 `plugin-manifest.json`；禁用插件用 `.json.block` 后缀。
- **六种插件类型**：static, messagePreprocessor, synchronous, asynchronous, service, hybridservice。
- **静态插件占位符**：通过 `systemPromptPlaceholders` 暴露能力，通常以 `{{VCP...}}` 注入。
- **VCP工具协议**：使用中文分隔符 `「始」「末」` 的自定义块语法（`<<<[TOOL_REQUEST]>>>`），不是 OpenAI function-calling。
- **变量系统**：支持 `{{Agent*}}`, `{{Tar*}}`, `{{Var*}}`, `{{Sar*}}` 四类自定义变量，可从 `TVStxt/*.txt` 加载外部文件。
- **多运行时**：Node.js + Python + Rust 混合架构，插件可用任意语言实现。
- **无正式测试**：根 `package.json` 的 `npm test` 是占位脚本，项目采用生产验证而非单元测试。

## 开发规范与常见陷阱

- 如需使用密钥或敏感配置，写入 `config.env` 或插件级 `config.env`；
  不要提交真实密钥到仓库。
- 如需引用运行数据（`dailynote/`、`image/`、插件 `state/`），将其作为运行时 I/O 对象处理；
  不要把它们当作稳定源码模块依赖。
- 如需修改 plugin-manifest 字段，先查 `Plugin.js` 的解析逻辑确认字段被消费；
  不要随意变更关键字段（加载器依赖 schema 稳定性）。
- 如需验证改动效果，在真实环境运行并观察日志；
  不要假设 CI 会跑单测（当前 CI 主要验证安装与 Docker 构建）。
- 如需启用禁用插件（`.block` 文件），先核对该插件的 `config.env.example` 和依赖是否就绪；
  不要直接重命名文件盲目启用。
- 如需新增 shell 执行路径，须配备严格输入约束和鉴权门禁（参照 PowerShellExecutor 模式）；
  不要新增不受约束的 `spawn(..., shell: true)` 调用。
- 如需修改文件数据，先备份或确认可回退；
  不要对 dailynote 等运行数据执行不可逆批量操作。

## 项目特性风格

- 单仓多运行时插件生态（Node + Python + 原生/Rust）。
- 以 manifest 驱动插件生命周期，禁用态通过文件命名表达。
- 提示词工程高度依赖占位符与配置注入。
- 管理前端以内嵌静态资源方式存在于 `AdminPanel/`，不是独立前端工程。

## 常用命令

```bash
# 开发环境设置
npm install
pip install -r requirements.txt

# 构建 Rust N-API 向量引擎（必需）
cd rust-vexus-lite && npm run build && cd ..

# 配置
cp config.env.example config.env
# 编辑 config.env 填入 API 密钥

# 运行
node server.js                   # 直接运行
pm2 start server.js              # PM2 生产模式

# Docker
docker-compose up --build -d
docker-compose logs -f
```

## 复杂插件说明

Plugin/ 目录中部分插件因规模或复杂度较高（多文件、多层子目录、多语言混合），在开发或审计时可能需要单独深入理解。典型特征包括：
- 文件数 >10 或含多层子目录
- 多语言混合（JS + Python）
- 拥有独立的内部路由或服务架构

遇到此类插件时，建议先阅读其目录下的 README.md（如有），再查阅 `plugin-manifest.json` 了解入口和类型。

## 📖 深度学习资源

**首次接触 VCPToolBox：**
1. [docs/DOCUMENTATION_INDEX.md](./docs/DOCUMENTATION_INDEX.md) — 文档导航总览
2. [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — 系统架构与启动序列
3. [docs/PLUGIN_ECOSYSTEM.md](./docs/PLUGIN_ECOSYSTEM.md) — 插件生态完整规范

**开发新功能：**
1. [docs/VCP同步异步插件开发手册.md](./docs/VCP同步异步插件开发手册.md) — 插件开发全流程教程
2. [docs/FEATURE_MATRIX.md](./docs/FEATURE_MATRIX.md) — 查找类似功能实现
3. [docs/CONTEXT_BRIDGE.md](./docs/CONTEXT_BRIDGE.md) — 插件间向量能力共享

**排查问题：**
1. [docs/OPERATIONS.md](./docs/OPERATIONS.md) — 运维部署与故障排查
2. [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) — 配置参数与风险警告
3. [docs/API_ROUTES.md](./docs/API_ROUTES.md) — HTTP 端点与认证机制

**记忆/RAG 系统：**
1. [docs/VCP记忆管理系统.md](./docs/VCP记忆管理系统.md) — 记忆系统上手指南
2. [docs/TagMemo_Wave_Algorithm_Deep_Dive.md](./docs/TagMemo_Wave_Algorithm_Deep_Dive.md) — 浪潮算法数学原理
3. [docs/MEMORY_SYSTEM.md](./docs/MEMORY_SYSTEM.md) — 记忆系统架构概览

**其他专项：**
- [docs/DISTRIBUTED_ARCHITECTURE.md](./docs/DISTRIBUTED_ARCHITECTURE.md) — 分布式 WebSocket 协议
- [docs/RUST_VECTOR_ENGINE.md](./docs/RUST_VECTOR_ENGINE.md) — N-API 向量引擎
- [docs/FRONTEND_COMPONENTS.md](./docs/FRONTEND_COMPONENTS.md) — AdminPanel 与前端集成
- [docs/SEMANTIC_MODEL_ROUTER.md](./docs/SEMANTIC_MODEL_ROUTER.md) — 语义模型路由
- [docs/TECHNICAL_LITE.md](./docs/TECHNICAL_LITE.md) — README 与完整文档之间的轻量技术地图