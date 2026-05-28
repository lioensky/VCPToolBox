# 语义任务智能模型路由器（Semantic Model Router）

`Semantic Model Router` 允许客户端把 `model` 填成一个虚拟模型名，例如 `VCPModelAuto`，再由 VCP 根据最近上下文的语义向量，自动选择真正的后端模型。

当前这套能力在本仓库里的组成是：

- 运行时路由：
  - [`modules/semanticModelRouter.js`](../modules/semanticModelRouter.js)
  - [`modules/chatCompletionHandler.js`](../modules/chatCompletionHandler.js)
  - [`modules/handlers/streamHandler.js`](../modules/handlers/streamHandler.js)
  - [`modules/handlers/nonStreamHandler.js`](../modules/handlers/nonStreamHandler.js)
  - [`server.js`](../server.js)
- 管理 API：
  - [`routes/admin/semanticRouter.js`](../routes/admin/semanticRouter.js)
  - [`routes/adminPanelRoutes.js`](../routes/adminPanelRoutes.js)
  - [`adminServer.js`](../adminServer.js)
- AdminPanel-Vue 源码：
  - [`AdminPanel-Vue/src/api/semanticRouter.ts`](../AdminPanel-Vue/src/api/semanticRouter.ts)
  - [`AdminPanel-Vue/src/views/SemanticModelRouterEditor.vue`](../AdminPanel-Vue/src/views/SemanticModelRouterEditor.vue)
- 配置文件：
  - [`SemanticModelRouter.json`](../SemanticModelRouter.json)
  - [`SemanticModelRouter.json.example`](../SemanticModelRouter.json.example)

## 工作方式

当请求里的 `model` 命中 `autoModelName` 或某个预设名时，路由器会：

1. 取最后一条用户消息和最后一条 assistant 消息。
2. 做 embedding，并按 `contextWeights` 合并成上下文向量。
3. 将上下文向量与当前预设下每个 `routes[].description` 的向量做余弦相似度匹配。
4. 选择最高分且高于阈值的 route 对应模型作为真实后端模型。
5. 把其余可参与容灾的 route、`defaultModel`、`fallbackModels` 组成重试候选链。

如果向量化失败、RAG 插件不可用、没有匹配项，或者相似度低于阈值，则退回 `defaultModel` 与 `fallbackModels`。

## 对外接口

### `/v1/chat/completions`

- 当 `model` 不是语义路由模型时，仍走原有 `modelRedirectHandler` 逻辑。
- 当 `model` 是语义路由模型时，先做语义解析，再把真实模型注回请求体。
- 语义候选链会传入现有 `fetchWithRetry`，因此 500/503/429、token 型 401、连接超时和网络错误时，会依次切换候选模型，而不是重复打同一个模型。

### `/v1/models`

`server.js` 会把虚拟模型条目追加到 `/v1/models` 响应里：

- `autoModelName`
- 非默认预设名

这些模型条目的 `owned_by` 固定为 `vcp-semantic-router`。

### `/admin_api/semantic-router/*`

当前管理接口包括：

- `GET /semantic-router/config`
- `PUT /semantic-router/config`
- `GET /semantic-router/upstream-models`
- `POST /semantic-router/preview`

独立后台进程支持配置读写和上游模型列表拉取；`preview` 依赖主进程运行态中的 `semanticModelRouter` 与 RAG 插件。

## 配置结构

顶层字段：

```json
{
  "enabled": true,
  "autoModelName": "VCPModelAuto",
  "defaultPreset": "default",
  "matchThreshold": 0.18,
  "contextWeights": [0.7, 0.3],
  "presets": {}
}
```

预设字段：

- `displayName`
- `defaultModel`
- `fallbackModels`
- `matchThreshold`
- `contextWeights`
- `routes`

路由项字段：

- `name`
- `model`
- `description`
- `failoverPool`
- `enabled`

## 行为边界

- `failoverPool: false` 的 route 只在自己被命中时使用，不会进入别的命中场景的容灾池。
- 路由器只改写真实请求的 `model` 字段，不改写 `messages`、`tools` 等其他负载。
- 工具循环中的后续 AI 调用复用同一条候选链，不会在每个工具结果后重新做一次语义匹配。
- 如果 [`SemanticModelRouter.json`](../SemanticModelRouter.json) 不存在，运行时会自动生成默认配置。

## 本地验证

当前相关的最小验证命令：

```powershell
node --check modules/semanticModelRouter.js
node --check modules/chatCompletionHandler.js
node --check modules/handlers/nonStreamHandler.js
node --check modules/handlers/streamHandler.js
node --check routes/admin/semanticRouter.js
node --check routes/adminPanelRoutes.js
node --check adminServer.js
node --check server.js
npm run build:admin
```
