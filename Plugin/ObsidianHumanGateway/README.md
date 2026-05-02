# ObsidianHumanGateway

用于统一人工确认流程的 P0 混合服务插件。

## 边界

- 负责：通过服务路由创建、查询、批准和拒绝确认请求；通过 VCP 工具调用创建确认请求。
- 不负责：执行笔记编辑、搜索 vault、保存长期审计历史。

## 路由

- `POST /api/obsidian-human/confirm`
- `GET /api/obsidian-human/pending/:id`
- `POST /api/obsidian-human/resolve/:id`

这个插件使用 `hybridservice` 类型，同时保留 HTTP 路由和 `processToolCall`，便于 Agent 在工具链中直接发起确认请求。
