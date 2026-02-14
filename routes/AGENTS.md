# routes 目录知识库

## 概览
`routes/` 是主要的 Express API 入口层，覆盖管理面板、日记管理、论坛接口与特殊模型转发。安全强度并不完全一致：`dailyNotesRoutes.js` 和 `forumApi.js` 的输入/路径校验更严格。

## 快速定位
| 任务 | 位置 | 说明 |
|------|------|------|
| 管理面板 API | `routes/adminPanelRoutes.js` | 配置/文件/插件控制，变更影响面最大 |
| 日记与文件安全样例 | `routes/dailyNotesRoutes.js` | 路径穿越与符号链接防护、队列与大小限制 |
| 论坛输入校验样例 | `routes/forumApi.js` | 参数约束与锁机制并发控制 |
| 特殊模型透传 | `routes/specialModelRouter.js` | 白名单条件接管转发 |
| 调度行为模块 | `routes/taskScheduler.js` | 放在 routes 下，但并非 HTTP Router |

## 约定
- 路由鉴权主要在 `server.js` 挂载层处理（`/admin_api`、`/AdminPanel`、bearer 鉴权链）。
- 每个 endpoint 使用显式 `try/catch` 和明确状态码（`400/403/404/500`，按需使用 `429/503/504`）。
- 涉及文件路径时优先使用规范化与根目录前缀校验（参照 `dailyNotesRoutes.js`）。
- 扩展接口时保持同模块内错误响应结构一致。

## 反模式
- 不要新增缺少规范化路径校验的管理端写文件接口。
- 不要在鉴权与输入边界不足时暴露重启/命令执行类接口。
- 不要只依赖前端做权限或参数校验。
- 不要假设 `routes/` 下所有文件都是 Express Router（`taskScheduler.js` 是编排模块）。
