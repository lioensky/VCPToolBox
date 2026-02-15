# 管理面板知识库

## 概览
`AdminPanel/` 是由后端直接托管的内嵌静态前端，并非独立 SPA 工程。改动时应优先保证与后端 `/admin_api` 协议兼容。

## 快速定位
| 任务 | 位置 | 说明 |
|------|------|------|
| 页面壳与布局 | `AdminPanel/index.html` | 主页面、样式与第三方编辑器资源引入 |
| 前端入口与分区路由 | `AdminPanel/script.js` | 页面分区导航与模块初始化 |
| 前端业务模块 | `AdminPanel/js/` | 接口调用、状态管理、交互逻辑（`API_BASE_URL=/admin_api`） |
| 面板后端接口 | `routes/adminPanelRoutes.js` | 系统监控、配置、日志、控制类操作 |
| 论坛子路由 | `routes/forumApi.js` | 挂载路径 `/admin_api/forum` |
| Markdown 工具 | `AdminPanel/easymde.min.js`, `AdminPanel/marked.min.js` | 打包进仓的前端依赖 |

## 约定
- 面板资源按“静态文件”模式被后端服务，不依赖前端打包流水线。
- `AdminPanel/login.html` 与 `/admin_api/check-auth` 构成登录态握手链路，改动需成对验证。
- 主题风格基于 CSS 变量（`var(--...)`），新增样式应保持同一机制。
- 协议变更优先后端接口，再同步前端调用，避免前后端错位。
- 文案默认中文优先，除非需求明确要求多语种调整。

## 反模式
- 不要假设存在现代前端工程化构建（当前大量资源为直接托管静态文件）。
- 不要在未同步后端的情况下修改接口字段结构。
- 不要把敏感值写入前端脚本或静态资源。
