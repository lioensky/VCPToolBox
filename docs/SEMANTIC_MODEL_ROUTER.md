# 语义任务智能模型路由器（Semantic Model Router）

> 一期已实装。前端管理面板（CRUD、可视化预设编辑、env 模型列表拉取）属于二期工程，本文用于支撑二期开发。

## 1. 功能概述

语义模型路由器允许客户端使用一个虚拟模型名（默认 `VCPModelAuto`，或任意自定义"预设名"）发起聊天请求。VCP 在收到请求后会：

1. 取消息上下文中的最后一条用户消息和最后一条 AI 消息，做向量化。
2. 把这两个向量按权重合并为"上下文向量"。
3. 与该预设下每个候选模型的 `description` 字段向量做余弦相似度匹配。
4. 选出相似度最高且超过阈值的候选模型，作为本次请求的真实后端模型。
5. 同一预设下，按相似度排位形成容灾候选链，并接入现有的 retry 指数退避机制；上游某个模型失败时，下一次重试切换到下一个候选模型，而不是反复重试同一个。
6. 当向量化失败、相似度低于阈值，或没有 RAG 插件可用时，使用配置中的 `defaultModel` 与 `fallbackModels` 作为兜底。

它对外保留 OpenAI 兼容的 `/v1/chat/completions` 与 `/v1/models` 协议，前端无需改造，只需在请求中把 `model` 字段填成 `VCPModelAuto` 或某个预设名即可。

## 2. 涉及文件

| 文件 | 角色 |
|------|------|
| [`SemanticModelRouter.json`](../SemanticModelRouter.json) | 运行时配置，热加载，支持示例自动生成 |
| [`SemanticModelRouter.json.example`](../SemanticModelRouter.json.example) | 模板配置 |
| [`modules/semanticModelRouter.js`](../modules/semanticModelRouter.js) | 核心模块：配置加载、向量计算、路由解析、虚拟模型清单 |
| [`modules/chatCompletionHandler.js`](../modules/chatCompletionHandler.js) | 在变量替换前调用路由模块、注入容灾候选链到 `fetchWithRetry` |
| [`modules/handlers/streamHandler.js`](../modules/handlers/streamHandler.js) | VCP 工具循环内的后续 fetch 也接入容灾候选链 |
| [`modules/handlers/nonStreamHandler.js`](../modules/handlers/nonStreamHandler.js) | 非流式工具循环内的后续 fetch 也接入容灾候选链 |
| [`server.js`](../server.js) | 实例化路由器、加载配置、把虚拟模型注入 `/v1/models` 响应 |

## 3. JSON 配置规范

### 3.1 顶层字段

```jsonc
{
  "enabled": true,
  "autoModelName": "VCPModelAuto",
  "defaultPreset": "default",
  "matchThreshold": 0.18,
  "contextWeights": [0.7, 0.3],
  "presets": { /* ... */ }
}
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `true` | 总开关。`false` 时所有路由失效，`/v1/models` 也不再追加虚拟模型 |
| `autoModelName` | string | `"VCPModelAuto"` | 默认预设对外暴露的虚拟模型 ID |
| `defaultPreset` | string | `"default"` | 当客户端使用 `autoModelName` 时实际命中的预设 |
| `matchThreshold` | number | `0.18` | 全局相似度阈值，每个预设可单独覆盖 |
| `contextWeights` | number[] | `[0.7, 0.3]` | `[user向量权重, assistant向量权重]`，每个预设可单独覆盖 |
| `presets` | object | 必填 | 预设字典，`键`为预设名（同时也是对外暴露的模型 ID） |

### 3.2 预设字段

```jsonc
"presets": {
  "default": {
    "displayName": "VCPModelAuto",
    "defaultModel": "gemini-3.5-flash-thinking",
    "fallbackModels": ["gpt-5.5"],
    "matchThreshold": 0.18,
    "contextWeights": [0.7, 0.3],
    "routes": [ /* ... */ ]
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `displayName` | string | 否 | 在 `/v1/models` 列表中展示用名 |
| `defaultModel` | string | 是 | 兜底模型，向量化失败 / 低于阈值时使用 |
| `fallbackModels` | string[] | 否 | 当 `defaultModel` 也失败时按序尝试的容灾模型 |
| `matchThreshold` | number | 否 | 该预设的相似度阈值（覆盖顶层） |
| `contextWeights` | number[] | 否 | 该预设的上下文向量权重（覆盖顶层） |
| `routes` | object[] | 是 | 候选模型列表，按语义匹配 |

### 3.3 路由项字段

```jsonc
{
  "name": "daily_chat",
  "model": "gemini-3.5-flash-thinking",
  "description": "日常聊天、闲聊、寒暄、生活琐事、轻松对话、随意问答、情感陪伴、聊聊心情",
  "failoverPool": true,
  "enabled": true
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 否 | 仅用于日志和管理面板展示 |
| `model` | string | 是 | 实际请求上游时使用的模型名 |
| `description` | string | 是 | 该模型擅长的场景描述。会做向量化并参与匹配，越具体匹配越准 |
| `failoverPool` | boolean | 否（默认 `true`） | 是否参与同预设内的容灾轮换。设为 `false` 表示该模型只在被语义命中时使用，命中后失败直接走 `defaultModel + fallbackModels` |
| `enabled` | boolean | 否（默认 `true`） | `false` 时整个 route 不参与匹配，方便临时禁用 |

### 3.4 完整真实示例

参考 [`SemanticModelRouter.json`](../SemanticModelRouter.json)：包含 `default`（日常聊天 / 调研编码 / 复杂推理）和 `VCPModelLiterature`（文学讨论 / 文学创作 / 文学分析）两套预设，覆盖了"默认模型 / 容灾模型 / 不参与容灾的专用模型"三类典型场景。

## 4. 触发条件

聊天请求满足以下任一条件即进入语义路由：

- `model === autoModelName`（默认 `"VCPModelAuto"`），命中 `defaultPreset` 指向的预设
- `model` 等于 `presets` 字典中的某个键，命中该预设

判定函数：[`SemanticModelRouter.isRoutingModel()`](../modules/semanticModelRouter.js:309)、[`SemanticModelRouter.resolvePresetName()`](../modules/semanticModelRouter.js:294)。

非语义路由模型（如 `gpt-4o`）走原有的 `modelRedirectHandler` 路径，互不影响。

## 5. 核心处理流程

### 5.1 启动期

[`server.js`](../server.js:399)：

```text
启动 → loadModelRedirectConfig
       → semanticModelRouter.initialize('SemanticModelRouter.json', DEBUG_MODE)
         ├─ ensureConfigFile（不存在则写入示例配置）
         ├─ loadConfig（读取并 normalizeConfig）
         └─ startWatcher（fs.watch 热加载，250ms 防抖）
```

`ChatCompletionHandler` 通过构造参数注入 `semanticModelRouter` 单例（[`server.js`](../server.js:1135)）。

### 5.2 请求期

[`modules/chatCompletionHandler.js`](../modules/chatCompletionHandler.js) 关键节点：

1. 读取 `req.body.model`：
   - 如果是语义路由模型，**跳过** `modelRedirectHandler`，避免在路由前就被改写。
2. 角色分割、`{{TransBase64}}` 处理、`VCPTavern` 注入。
3. **语义路由解析**（在 Tavern 之后、统一变量替换之前）：
   - 调用 [`semanticModelRouter.resolveRoute()`](../modules/semanticModelRouter.js:398)。
   - 把 `selectedModel` 经 `modelRedirectHandler.redirectModelForBackend` 转成实际后端模型，覆盖 `originalBody.model`。
   - 应用 `applyChinaModelThinkingControl`，让真实模型生效国产模型思维链开关。
4. 进入统一变量替换（`replaceAgentVariables` / `replaceOtherVariables`），此时 `originalBody.model` 已经是路由后的真实模型，因此 [`SarPrompt`](../modules/sarPromptManager.js:108) 等模型敏感变量按真实模型生效。
5. 媒体处理器、其他消息预处理器、TransBase64+ 还原。
6. 把容灾候选链 `semanticModelFallbackCandidates` 传入 [`fetchWithRetry`](../modules/chatCompletionHandler.js:321)；后续 `streamHandler.js` / `nonStreamHandler.js` 中所有循环内的 fetch 也带上同一份候选链。

### 5.3 路由解析

[`SemanticModelRouter.resolveRoute()`](../modules/semanticModelRouter.js:398)：

```text
preset = resolvePresetName(model)
ragPlugin = pluginManager.messagePreprocessors.get('RAGDiaryPlugin')
  ↳ 不可用 → 返回 buildDefaultPlan(reason='rag_plugin_unavailable')

contextVector = buildContextVector(messages, ragPlugin, preset)
  ├─ findLastMessageText(messages, 'user')   过滤 [系统提示:] / [系统邀请指令:] / VCP_TOOL_PAYLOAD
  ├─ findLastMessageText(messages, 'assistant')
  ├─ ragPlugin.sanitizeForEmbedding（若可用）
  ├─ 并发 getSingleEmbeddingCached(user) + getSingleEmbeddingCached(assistant)
  └─ ragPlugin._getWeightedAverageVector(vectors, contextWeights)
  ↳ 任一向量化失败 → 返回 buildDefaultPlan(reason='context_embedding_unavailable')

scoredRoutes = preset.routes.map(route => {
  descVector = getDescriptionVector(ragPlugin, route.description)
                ↳ 优先 vectorDBManager.getPluginDescriptionVector（持久化于 SQLite kv_store，键为 plugin_desc_hash:<sha256>）
                ↳ 否则 ragPlugin.getSingleEmbeddingCached
  similarity = cosineSimilarity(contextVector, descVector)
})

scoredRoutes.sort(by similarity desc)
matchedRoutes = scoredRoutes.filter(similarity >= threshold)
candidates = buildFallbackPlan(preset, matchedRoutes)
selectedModel = candidates[0] || preset.defaultModel || requestedModel
```

#### `buildFallbackPlan` 的语义

[`SemanticModelRouter.buildFallbackPlan()`](../modules/semanticModelRouter.js:370)：

```text
if matchedRoutes 非空:
  primary = matchedRoutes[0]                  // 相似度最高的命中
  push primary.model
  if primary.failoverPool !== false:
    for route in matchedRoutes[1..]:
      if route.failoverPool !== false: push route.model
push preset.defaultModel
push preset.fallbackModels...
去重保序
```

要点：
- **`failoverPool: false` 的 route 不进入容灾池**：即使被语义命中，命中失败后直接跳到 `defaultModel + fallbackModels`，绝不会被其他场景下命中后的容灾轮换误用。
- **`failoverPool` 缺省为 `true`**：默认参与容灾池，符合直觉。

### 5.4 容灾重试

[`fetchWithRetry`](../modules/chatCompletionHandler.js:321) 接受 `modelFallbackCandidates` 参数：

- 总尝试次数 `maxAttempts = max(retries, candidates.length)`，确保候选链能被走完。
- 每次重试前 [`applyModelFallbackForAttempt`](../modules/chatCompletionHandler.js:288) 解析当前请求体 JSON，把 `model` 字段切换成 `candidates[min(attempt, candidates.length-1)]`，再发起请求。
- 触发重试的条件保持不变：500 / 503 / 429、含 `token` 的 401、连接超时、网络错误。
- 用户主动 abort（`/v1/interrupt` 或断联）不会触发重试。

后续 VCP 工具循环内的所有 fetch（[`streamHandler.js`](../modules/handlers/streamHandler.js:326)、[`streamHandler.js`](../modules/handlers/streamHandler.js:450)、[`nonStreamHandler.js`](../modules/handlers/nonStreamHandler.js:133)、[`nonStreamHandler.js`](../modules/handlers/nonStreamHandler.js:240)）都带上同一份 `semanticModelFallbackCandidates`，让循环里每一次 AI 调用都能享受同一条容灾链。

### 5.5 虚拟模型注入 `/v1/models`

[`server.js`](../server.js:841)：

```text
GET /v1/models
  ├─ 转发上游 /v1/models
  ├─ 如启用了 modelRedirectHandler，把内部模型名替换为公开模型名
  ├─ appendSemanticRouterModels(modelsData)
  │    └─ 追加 autoModelName（VCPModelAuto）+ 所有非默认预设名
  └─ 上游不可用时，仍然返回仅含语义路由虚拟模型的列表
```

虚拟模型条目固定 `owned_by: "vcp-semantic-router"`，前端 / 客户端可以据此在 UI 上做特殊处理。

## 6. 持久化与热加载

- **配置热加载**：[`SemanticModelRouter.json`](../SemanticModelRouter.json) 通过 [`fs.watch`](../modules/semanticModelRouter.js:254) 监听，250ms 防抖后调用 `loadConfig()` 重新解析。配置错误时回退到内置默认配置并打印日志，不会让服务器崩溃。
- **描述向量持久化**：在路由器内部使用进程内 [`Map`](../modules/semanticModelRouter.js:108) 缓存；底层调用 [`KnowledgeBaseManager.getPluginDescriptionVector()`](../KnowledgeBaseManager.js:907)，把 `plugin_desc_hash:<sha256(description)>` 写入 `VectorStore/knowledge_base.sqlite` 的 `kv_store` 表。重启后无需重新向量化，与工具动态折叠共享同一套缓存。
- **配置变更后**：`loadConfig()` 会清空进程内描述向量缓存，下一次请求会按需重新读 SQLite（命中时仍是 0 成本）。

## 7. 二期管理面板要点

二期实现 [`AdminPanel-Vue/`](../AdminPanel-Vue/) 内的可视化编辑时，建议：

### 7.1 后端接口建议（路由前缀 `/admin_api`）

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/semantic-router/config` | 返回当前 [`SemanticModelRouter.json`](../SemanticModelRouter.json) 解析后的对象（脱敏不需要，配置本身不含密钥） |
| PUT | `/semantic-router/config` | 用 [`SemanticModelRouter.normalizeConfig()`](../modules/semanticModelRouter.js:163) 校验后整文件覆盖写回，写入成功后 `fs.watch` 自动触发热加载 |
| GET | `/semantic-router/upstream-models` | 拉取 `process.env.API_URL/v1/models`（与 [`server.js`](../server.js:841) 一致），供面板下拉选择真实后端模型；建议加上 `modelRedirectHandler.getAllRules()` 返回的公开/内部映射 |
| POST | `/semantic-router/preview` | 输入一段示例 user/assistant 文本和预设名，返回每个 route 的相似度排序，供运营调试匹配阈值 |

注意：路由器实例在 [`server.js`](../server.js:402) 中创建，可通过 `app.get('semanticModelRouter')` 或在 `adminPanelRoutes` 工厂额外注入的方式让管理路由拿到。

### 7.2 表单字段映射

```text
预设
├─ 预设 ID（key）            → presets 字典的键
├─ displayName             → string
├─ defaultModel            → 单选（下拉来源 = 上游 /v1/models）
├─ fallbackModels          → 多选有序（同上下拉）
├─ matchThreshold          → 数字滑动条 0.05~0.6（推荐 0.15~0.25）
├─ contextWeights          → 两个数字输入（user / assistant），≥0
└─ routes[]
   ├─ name                 → string
   ├─ model                → 单选（同上下拉）
   ├─ description          → 多行文本（≥20 字符提示更精准）
   ├─ failoverPool         → 开关（默认 ON）
   └─ enabled              → 开关（默认 ON）
```

### 7.3 校验

- `defaultPreset` 必须是 `presets` 中存在的键。
- 每个预设 `routes` 至少 1 条 `enabled: true` 才能让语义匹配生效；否则永远走 `defaultModel`。
- 同一 preset 内 `route.name` 建议唯一（仅用于展示，重复不会出错）。
- 阈值过高（如 > 0.5）会导致几乎不匹配，UI 给出告警。
- `defaultModel` / `fallbackModels` / `routes[].model` 中如果有不在上游模型列表里的项，给出黄色提醒，但不阻止保存（用户可能配置了 `ModelRedirect.json` 中映射的内部模型）。

### 7.4 与现有面板模块对齐

可参考已有的 [`routes/admin/sarPrompts.js`](../routes/admin/sarPrompts.js) + [`AdminPanel-Vue/dist/assets/js/SarPromptEditor-*.js`](../AdminPanel-Vue) 的模式：
- 后端：薄路由 + 直接读写 JSON 文件 + 调用模块提供的校验函数。
- 前端：`getConfig` / `saveConfig` 两个 API，编辑页用列表 + 表单组合，自动从 `/admin_api/semantic-router/upstream-models` 拉取候选。

## 8. 已知边界

- 当用户的最后一条消息是工具占位符或系统通知（`[系统提示:]` / `[系统邀请指令:]` / `<!-- VCP_TOOL_PAYLOAD -->`），路由器会自动跳过这些行，向上找真正的对话内容；如果整段历史里都没有有效用户文本，路由器会回退到 `defaultModel`。
- VCP 工具循环里每一次 AI 调用都使用同一份候选链；不会在每个工具结果后重新做语义匹配。这样保证一次会话内行为可预期；如果你需要"工具结果改变后重新选择模型"，需要在二期单独设计。
- `failoverPool: false` 的 route 永远不会作为别人的容灾候选；如果它本身命中后失败，会跳到 `defaultModel + fallbackModels`。
- 路由器只改写请求体里的 `model` 字段，不修改 `messages` / `tools` 等其他字段；前端约定的提示词 / 工具列表对所有候选模型必须保持兼容。
- 如果上游 `/v1/models` 不可达，VCP 仍会返回包含 `VCPModelAuto` 与各预设名的虚拟模型列表，避免前端选不到自动模型。