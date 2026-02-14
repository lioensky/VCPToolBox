# 项目知识库

**生成时间：** 2026-02-13 16:34:00 Asia/Shanghai
**提交：** 3d54cad
**分支：** xxbb

## 📚 完整文档体系

**VCPToolBox 现已拥有完整的全景文档（12个文档，331KB，10,395行）：**

从 **[docs/DOCUMENTATION_INDEX.md](./docs/DOCUMENTATION_INDEX.md)** 开始浏览完整文档体系，包括：
- 系统架构与启动序列
- 插件生态完整规范（79个活跃插件）
- 配置系统与参数语义
- API路由与认证机制
- TagMemo算法与RAG系统（V3.7）
- WebSocket分布式架构
- Rust N-API向量引擎
- 前端组件与集成
- 文件清单与职责映射
- 功能矩阵与处理流程
- 运维部署与故障排查

**所有文档特点：**
- ✅ 高保真、全覆盖、可追溯
- ✅ 所有结论附证据定位（文件路径 + 行号）
- ✅ 已确认事实、推断结论、不确定项明确标注
- ✅ 保留边界条件、异常分支、兼容性处理

---

## 概览
VCPToolBox 是一个以 Node.js 为核心的 AI 中间层，包含大型插件运行时（`Plugin/` - 87个插件目录）、内嵌管理前端（`AdminPanel/`）以及 Rust N-API 向量组件（`rust-vexus-lite/`）。项目采用根目录扁平化运行结构（无 `src/` 分层），定位代码时应按职责找文件而不是按目录深度找。

**项目规模**：673文件，76,448行代码，37个大文件(>500行)，最大深度11层。

## 目录结构
```text
VCPToolBox/
|- server.js               # 主 HTTP/SSE 入口与启动编排
|- Plugin.js               # 插件生命周期、加载与执行总控
|- WebSocketServer.js      # 分布式节点与工具桥接
|- KnowledgeBaseManager.js # RAG/标签/向量索引总控
|- modules/                # 复用后端内部模块
|- routes/                 # Express 路由层
|- Plugin/                 # 79个活跃插件 + 8个禁用插件（Node/Python/Rust）
|- AdminPanel/             # 内嵌静态管理前端
|- rust-vexus-lite/        # Rust N-API 向量索引子项目
|- dailynote/              # 运行数据/知识内容（非核心源码）
`- image/                  # 运行期媒体资源（非核心源码）
```

## 快速定位
| 任务 | 位置 | 说明 |
|------|------|------|
| 启动与初始化 | `server.js` | 环境加载、中间件、路由挂载、启动顺序 |
| 插件执行链路 | `Plugin.js` | manifest 解析、同步/异步/静态执行 |
| 分布式工具 | `WebSocketServer.js`, `FileFetcherServer.js` | 节点注册、远程执行、跨节点取文件 |
| 安全敏感面 | `server.js`, `Plugin.js`, `routes/adminPanelRoutes.js` | 鉴权、shell 执行、管理控制接口 |
| 变量替换流程 | `modules/messageProcessor.js` | 提示词与占位符注入管线 |
| Agent 文件映射 | `modules/agentManager.js` | `agent_map.json` 与热更新监听 |
| 管理面板后端 | `routes/adminPanelRoutes.js` | 面板配置/系统控制类接口 |
| 特殊模型路由 | `routes/specialModelRouter.js` | 图像/向量白名单透传 |
| 插件协议样例 | `Plugin/*/plugin-manifest.json` | 各类插件本地约定 |
| 容器行为 | `Dockerfile`, `docker-compose.yml` | 运行用户、挂载策略、依赖安装方式 |

## 代码映射
| 符号/文件 | 类型 | 位置 | 作用 |
|-----------|------|------|------|
| `startServer` | 函数 | `server.js` | 最终启动门控（`app.listen` 前） |
| `PluginManager` | 类 | `Plugin.js` | 插件注册、配置合并与执行分发 |
| `initialize` | 函数 | `WebSocketServer.js` | 分布式 WebSocket 桥初始化 |
| `fetchFile` | 函数 | `FileFetcherServer.js` | 工具执行时的跨节点文件回退 |
| `KnowledgeBaseManager` | 类/单例 | `KnowledgeBaseManager.js` | 向量库与 RAG 管线总控 |
| `AgentManager` | 类 | `modules/agentManager.js` | 别名映射、缓存与热更新监听 |
| `ChatCompletionHandler` | 类 | `modules/chatCompletionHandler.js` | 对话主流程编排 |
| `router` | Express Router | `routes/specialModelRouter.js` | 特殊模型请求接管 |

## 约定
- **扁平根目录**：运行时目录刻意保持根层扁平（24个可执行文件），不要假设存在 `src/` 体系。
- **配置层级**：全局配置来自 `config.env`（模板 `config.env.example`）；插件可在各自目录覆盖配置。
- **插件契约**：插件契约文件固定为 `plugin-manifest.json`；禁用插件用 `plugin-manifest.json.block`（8个禁用插件）。
- **六种插件类型**：static, messagePreprocessor, synchronous, asynchronous, service, hybridservice。
- **静态插件占位符**：通过 `systemPromptPlaceholders` 暴露能力，通常以 `{{VCP...}}` 注入。
- **VCP工具协议**：使用中文分隔符 `「始」「末」` 的自定义块语法（`<<<[TOOL_REQUEST]>>>`），不是 OpenAI function-calling。
- **变量系统**：支持 `{{Agent*}}`, `{{Tar*}}`, `{{Var*}}`, `{{Sar*}}` 四类自定义变量，可从 `TVStxt/*.txt` 加载外部文件。
- **多运行时**：Node.js + Python + Rust 混合架构，插件可用任意语言实现。
- **无正式测试**：根 `package.json` 的 `npm test` 是占位脚本，项目采用生产验证而非单元测试。

## 反模式（本项目）
- **密钥安全**：不要提交真实密钥（`config.env`、插件私有配置等）。
- **运行时数据**：不要把 `dailynote/`、`image/`、插件 `state/` 当作稳定源码模块。
- **Manifest完整性**：不要随意改动 plugin manifest 关键字段，加载器依赖该 schema。
- **测试假设**：不要假设 CI 会跑单测；当前 CI 主要验证安装与 Docker 构建。
- **插件启用**：不要直接去掉 `.block` 来启用插件，先确认依赖与配置完整（8个禁用插件）。
- **Shell执行**：不要新增 `spawn(..., shell: true)` 类执行路径，除非有严格输入约束和鉴权门禁。
- **数据修改**：使用文件修改工具前务必备份（参考 DIARY_TAG_BATCH_PROCESSOR 警告）。
- **Docker根用户**：容器以root运行是已知权衡（卷挂载权限问题），已文档化风险。

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
cd rust-vexus-lite
npm run build                    # Release 构建
npm run build:debug              # Debug 构建
cd ..

# 配置
cp config.env.example config.env
# 编辑 config.env 填入 API 密钥

# 运行
node server.js                   # 直接运行
pm2 start server.js              # PM2 生产模式
pm2 logs                         # 查看日志

# Docker（推荐生产环境）
docker-compose up --build -d
docker-compose logs -f
docker-compose down
```

## 复杂插件子目录
以下插件因复杂度高（文件数>10或有多层子目录），可能需要专门文档：
- **Plugin/DailyHot/** (71文件) - 56+热点源聚合器，dist/routes/包含各平台爬虫
- **Plugin/RAGDiaryPlugin/** (8文件, 4,652行) - 语义分组、向量管理、元思考系统
- **Plugin/LinuxShellExecutor/** (12文件, 3,000行) - 安全关键，13+验证器类，SSH管理
- **Plugin/LinuxLogMonitor/** (8文件, 2,945行) - core/架构：AnomalyDetector, MonitorManager, MonitorTask
- **Plugin/ComfyUIGen/** (18文件) - JS+Python双语言工作流系统
- **Plugin/IMAPIndex/** (15文件) - 3个子系统：proxy, storkapp_dailynote, storkapp_dailynote_pubmed
- **Plugin/PaperReader/** (11文件) - lib/库架构：chunker, ingest, deep-reader, query管线

## 备注
- **CI工作流**：`.github/workflows/ci.yml` 执行 `npm ci` + Docker 构建（不推送镜像，且不做有效根层测试）。
- **容器运行**：采用 `pm2-runtime`，`docker-compose.yml` 默认大范围 bind mount。
- **继续深入**：请看子级文档：`Plugin/AGENTS.md`、`AdminPanel/AGENTS.md`、`modules/AGENTS.md`、`routes/AGENTS.md`、`rust-vexus-lite/AGENTS.md`。

---

## 📖 深度学习资源

**对于需要深入理解系统的 Agent，强烈推荐按以下顺序阅读完整文档：**

1. **首次接触**：
   - [docs/DOCUMENTATION_INDEX.md](./docs/DOCUMENTATION_INDEX.md) - 文档导航总览
   - [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) - 系统架构与启动序列
   - [docs/PLUGIN_ECOSYSTEM.md](./docs/PLUGIN_ECOSYSTEM.md) - 插件生态完整规范

2. **开发新功能**：
   - [docs/FEATURE_MATRIX.md](./docs/FEATURE_MATRIX.md) - 查找类似功能
   - [docs/FILE_INVENTORY.md](./docs/FILE_INVENTORY.md) - 定位相关文件
   - 对应专项文档查阅实现细节

3. **排查问题**：
   - [docs/OPERATIONS.md](./docs/OPERATIONS.md) - 常见故障排查
   - [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) - 配置项检查
   - [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) - 追踪调用链

**完整文档列表：**
- [DOCUMENTATION_INDEX.md](./docs/DOCUMENTATION_INDEX.md) - 文档导航与使用指南
- [ARCHITECTURE.md](./docs/ARCHITECTURE.md) - 系统架构、启动序列、模块依赖
- [PLUGIN_ECOSYSTEM.md](./docs/PLUGIN_ECOSYSTEM.md) - 插件类型、manifest schema、执行模式
- [CONFIGURATION.md](./docs/CONFIGURATION.md) - 配置参数、优先级规则、风险警告
- [API_ROUTES.md](./docs/API_ROUTES.md) - HTTP端点、认证机制、处理逻辑
- [MEMORY_SYSTEM.md](./docs/MEMORY_SYSTEM.md) - TagMemo算法、EPA模块、向量索引
- [DISTRIBUTED_ARCHITECTURE.md](./docs/DISTRIBUTED_ARCHITECTURE.md) - WebSocket协议、分布式工具执行
- [RUST_VECTOR_ENGINE.md](./docs/RUST_VECTOR_ENGINE.md) - N-API接口、向量操作、性能特性
- [FRONTEND_COMPONENTS.md](./docs/FRONTEND_COMPONENTS.md) - AdminPanel、VCPChrome、OpenWebUISub
- [FILE_INVENTORY.md](./docs/FILE_INVENTORY.md) - 文件清单、职责、依赖关系
- [FEATURE_MATRIX.md](./docs/FEATURE_MATRIX.md) - 功能入口、触发条件、处理流程
- [OPERATIONS.md](./docs/OPERATIONS.md) - 运维部署、故障排查、性能监控
