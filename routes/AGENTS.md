# routes 目录知识库

## 概览

`routes/` 是 Express API 入口层，覆盖管理面板、日记管理、论坛接口、多协议适配与特殊模型转发。安全强度按模块分级：`dailyNotesRoutes.js` 和 `forumApi.js` 具有最严格的输入/路径校验。

## 快速定位

| 任务 | 位置 | 说明 |
|------|------|------|
| 管理面板 API 总入口 | `adminPanelRoutes.js` | 初始化并 mount admin/ 下所有子模块 |
| 管理面板子路由 | `admin/` | 25+ 独立模块（system/config/plugins/agents/rag/schedules 等） |
| 日记与文件安全样例 | `dailyNotesRoutes.js` | 路径穿越防护、符号链接检测、队列与大小限制 |
| 论坛输入校验样例 | `forumApi.js` | 参数约束、锁机制并发控制 |
| 多协议适配 | `protocolBridge.js` | OpenAI Responses / Anthropic Messages / Gemini → 统一 /v1/chat/completions |
| 特殊模型透传 | `specialModelRouter.js` | 白名单条件接管转发 |
| 并行搜索 | `searchWorker.js` | Worker Thread，被 dailyNotesRoutes 调用执行并行文件搜索 |
| 调度编排 | `taskScheduler.js` | 非 HTTP Router，是定时任务编排模块 |

## 约定

- 路由鉴权主要在 `server.js` 挂载层处理（`/admin_api`、`/AdminPanel`、bearer 鉴权链）。
- 每个 endpoint 使用显式 `try/catch` 和明确状态码（`400/403/404/500`，按需 `429/503/504`）。
- 涉及文件路径时优先使用 `path.resolve()` + `startsWith(allowedRoot)` 规范化校验。
- 扩展接口时保持同模块内错误响应结构一致。
- `admin/` 子目录的每个模块由 `adminPanelRoutes.js` 统一注册，接收 options 依赖注入。

## 开发规范与常见陷阱

- 如需新增写文件接口，参照 `dailyNotesRoutes.js` 的路径规范化校验（`path.resolve` + 白名单根目录前缀检测）；
  不要跳过路径校验直接拼接用户输入。
- 如需暴露命令执行类接口，须通过 `requiresAdmin` 验证码 + 白名单命令约束；
  不要在鉴权与输入边界不足时暴露此类端点。
- 如需校验参数，后端路由层必须独立做完整校验（req.body/req.params）；
  不要只依赖前端做权限或参数校验。
- 如需确认某文件是否是路由，检查其是否导出 Express Router 实例；
  注意 `taskScheduler.js` 和 `searchWorker.js` 是工具模块，不是路由。