# modules 目录知识库

## 概览
`modules/` 存放被 `server.js`、路由层和核心执行链复用的后端内部模块，是可复用编排逻辑的主要承载层。

## 快速定位
| 任务 | 位置 | 说明 |
|------|------|------|
| Agent 别名与文件管理 | `modules/agentManager.js` | `agent_map.json` 读取、缓存、文件监听 |
| 对话主流程编排 | `modules/chatCompletionHandler.js` | Chat 请求主循环与 handler 调度 |
| 变量替换管线 | `modules/messageProcessor.js` | 多阶段占位符解析 |
| 日志初始化 | `modules/logger.js` | 控制台重定向与日志输出 |
| 角色分割转换 | `modules/roleDivider.js` | role 拆分与过滤 |

## 约定
- 默认采用 CommonJS 导出（`module.exports`）。
- 环境变量解析常见防御式处理（`try/catch` + 回退默认值）。
- 缓存与监听是显式策略（典型见 `agentManager`）。
- `DebugMode` 作为附加日志门控，不要绕过。
- Handler 主链路保持稳定：解析 tool call -> 分离 archery/normal -> 执行 -> 递归/继续。
- 导出风格按职责区分：handler 多为类导出，manager 多为单例导出，工具模块多为函数对象导出。

## 反模式
- 不要在 watcher/缓存链路里吞错（静默失败）。
- 不要绕开已有 manager 直接在 `server.js` 中复制状态逻辑。
- 不要无保护地引入 ESM-only 依赖破坏当前 CommonJS 运行约定。
