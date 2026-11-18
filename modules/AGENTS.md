# modules 目录知识库

## 概览

`modules/` 存放被 `server.js`、路由层和核心执行链复用的后端内部模块，是可复用编排逻辑的主要承载层。采用 CommonJS 导出，部分模块作为单例/服务注册中心运行。

## 快速定位

| 模块 | 职责 |
|------|------|
| `chatCompletionHandler.js` | 对话主流程编排（23 步管线），请求全生命周期控制器 |
| `messageProcessor.js` | 多阶段变量替换（Agent/Toolbox/TVS/System）、Detector 后置、占位符注入 |
| `dynamicToolRegistry.js` | 动态工具注册表、分类缓存、`{{VCPDynamicTools}}` 注入构建 |
| `agentManager.js` | Agent 别名映射、人格文件缓存、`agent_map.json` 热监听 |
| `roleDivider.js` | `<<<[ROLE_DIVIDE_*]>>>` 标签解析，单条消息拆分为多角色消息 |
| `semanticModelRouter.js` | VCPModelAuto 语义路由，基于对话内容自动选模型 |
| `contextManager.js` | 上下文 token 预算裁剪（pruneMessages） |
| `finalContextStore.js` | 存储最终上游请求 body 供调试复现 |
| `multiModalConfigStore.js` | 多模态配置热加载（`multimodal-config.json` 优先于 env） |
| `toolApprovalManager.js` | Human-in-the-loop 工具审批，规则来自 `toolApprovalConfig.json` |
| `toolboxManager.js` | Toolbox 文档管理，`toolbox_map.json` + foldProtocol 动态折叠 |
| `tvsManager.js` | TVS 变量系统，读取 `TVStxt/` 目录的静态文档块 |
| `sarPromptManager.js` | 模型级 SAR 提示词注入，基于目标模型名匹配 |
| `foldProtocol.js` | 语义折叠协议解析/构建（配合 toolboxManager 按相关度展开文档） |
| `associativeDiscovery.js` | 联想发现引擎，被 DailyNoteManager 的 associate 命令调用 |
| `distributedMusicDiarySync.js` | 分布式音乐播放列表同步到本地日记目录 |
| `captchaDecoder.js` | 管理员 6 位验证码解码（从 `Plugin/UserAuth/code.bin` 读取） |
| `dotenvPatch.js` | dotenv 加载补丁（环境变量预处理） |
| `sensitiveEnv.js` | 敏感环境变量白名单控制（仅允许特定插件访问） |
| `logger.js` | 控制台重定向与日志格式化输出 |

| 子目录 | 职责 |
|--------|------|
| `handlers/` | 流式/非流式响应处理器（streamHandler / nonStreamHandler） |
| `vcpLoop/` | VCP 工具调用循环（toolCallParser 解析 + toolExecutor 执行） |
| `SSHManager/` | SSH 连接池服务，通过 UDS 提供 RPC |
| `LogMonitor/` | 日志监控核心模块（AnomalyDetector / MonitorManager） |

## 约定

- 默认采用 CommonJS 导出（`module.exports`）。
- 环境变量解析常见防御式处理（`try/catch` + 回退默认值）。
- 缓存与监听是显式策略（典型见 `agentManager` 的 chokidar/fs.watch）。
- `DebugMode` 作为附加日志门控，不要绕过。
- Handler 主链路保持稳定：解析 tool call → 分离 archery/normal → 执行 → 递归/继续。
- 导出风格按职责区分：handler 为类导出，manager 为单例导出，工具模块为函数对象导出。
- messagePreprocessors Map 同时充当轻量级服务定位器（如 `.get('RAGDiaryPlugin')` 获取 embedding 能力）。

## 开发规范与常见陷阱

- 如需添加新模块，在模块内实现错误边界（try/catch + 日志），并在 watcher/缓存链路中确保异常可观测；
  不要静默吞错导致状态不一致。
- 如需访问已有状态（Agent 映射、工具列表、配置缓存），通过对应 manager 的公开接口调用；
  不要在 server.js 中复制状态逻辑绕开 manager。
- 如需引入新 npm 依赖，确认其同时支持 CommonJS require()；
  不要引入 ESM-only 包破坏当前运行约定（无 `"type": "module"`）。