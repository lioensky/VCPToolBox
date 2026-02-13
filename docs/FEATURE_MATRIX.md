# VCPToolBox 功能矩阵文档

**版本:** VCP 6.4  
**生成日期:** 2026-02-13  
**适用提交:** d09c49f

---

## 目录

1. [功能总览](#1-功能总览)
2. [HTTP API 功能](#2-http-api-功能)
3. [插件执行功能](#3-插件执行功能)
4. [WebSocket 通信功能](#4-websocket-通信功能)
5. [RAG 检索功能](#5-rag-检索功能)
6. [管理面板功能](#6-管理面板功能)
7. [分布式工具功能](#7-分布式工具功能)
8. [功能依赖关系图](#8-功能依赖关系图)
9. [常见功能组合场景](#9-常见功能组合场景)

---

## 1. 功能总览

### 1.1 系统功能架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              VCPToolBox 功能矩阵                              │
├──────────────┬──────────────┬──────────────┬──────────────┬────────────────┤
│  HTTP API    │  插件执行     │  WebSocket   │  RAG 检索    │  管理面板      │
│  对话/模型   │  6种类型      │  6种客户端   │  TagMemo V5  │  系统配置      │
├──────────────┴──────────────┴──────────────┴──────────────┴────────────────┤
│                           分布式工具执行层                                    │
│                    (透明代理 / 远程文件 / 跨节点调度)                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 功能统计

| 功能分类 | 子功能数 | 核心入口文件 | 主要配置文件 |
|---------|---------|-------------|-------------|
| HTTP API | 12 | `server.js` | `config.env` |
| 插件执行 | 6 种类型 | `Plugin.js` | `plugin-manifest.json` |
| WebSocket | 6 种客户端 | `WebSocketServer.js` | `config.env` |
| RAG 检索 | 8 | `KnowledgeBaseManager.js` | `rag_params.json` |
| 管理面板 | 15+ | `routes/adminPanelRoutes.js` | `config.env` |
| 分布式工具 | 5 | `WebSocketServer.js` + `Plugin.js` | `config.env` |

---

## 2. HTTP API 功能

### 2.1 对话补全 (Chat Completions)

| 属性 | 说明 |
|------|------|
| **功能描述** | 核心 AI 对话接口，兼容 OpenAI API 格式，支持 VCP 工具调用循环 |
| **入口文件** | `server.js` |
| **入口函数** | `app.post('/v1/chat/completions', ...)` (行 788-813) |
| **触发条件** | HTTP POST 请求到 `/v1/chat/completions`，携带 Bearer Token |
| **处理流程** | 1. Bearer Token 认证 → 2. 模型重定向检查 → 3. 消息预处理器链执行 → 4. 插件占位符替换 → 5. VCP 工具调用循环 → 6. 流式/非流式响应 |
| **相关配置** | `Key`, `ApiRetries`, `MaxVCPLoopStream`, `MaxVCPLoopNonStream` |
| **输出格式** | 流式 SSE 或非流式 JSON，兼容 OpenAI 格式 |
| **限制条件** | 最多 `MaxVCPLoop*` 次工具调用循环；Bearer Token 必须有效 |

**请求示例：**
```json
{
  "model": "gpt-4",
  "messages": [{"role": "user", "content": "Hello"}],
  "stream": true
}
```

**响应示例（非流式）：**
```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "choices": [{"message": {"role": "assistant", "content": "Hi!"}}]
}
```

---

### 2.2 模型列表 (Models List)

| 属性 | 说明 |
|------|------|
| **功能描述** | 获取可用模型列表，透传后端 API |
| **入口文件** | `server.js` |
| **入口函数** | `app.get('/v1/models', ...)` |
| **触发条件** | HTTP GET 请求到 `/v1/models` |
| **处理流程** | 1. Bearer Token 认证 → 2. 透传后端 API → 3. 模型名称重定向（可选） |
| **相关配置** | `Key`, `ModelRedirect.json` |
| **输出格式** | JSON 模型列表 |
| **限制条件** | 无特殊限制 |

---

### 2.3 请求中断 (Request Interrupt)

| 属性 | 说明 |
|------|------|
| **功能描述** | 紧急停止正在进行的对话请求 |
| **入口文件** | `server.js` |
| **入口函数** | `app.post('/v1/interrupt', ...)` (行 636-745) |
| **触发条件** | HTTP POST 请求到 `/v1/interrupt` |
| **处理流程** | 1. 解析 requestId → 2. 查找 activeRequests Map → 3. 设置 aborted 标志 → 4. 调用 AbortController.abort() |
| **相关配置** | 无 |
| **输出格式** | JSON 状态消息 |
| **限制条件** | requestId 必须存在于 activeRequests |

---

### 2.4 人类直接调用工具 (Human Tool Call)

| 属性 | 说明 |
|------|------|
| **功能描述** | 允许人类用户直接调用 VCP 工具，绕过 AI 对话 |
| **入口文件** | `server.js` |
| **入口函数** | `app.post('/v1/human/tool', ...)` |
| **触发条件** | HTTP POST 请求到 `/v1/human/tool`，请求体为 VCP 指令文本 |
| **处理流程** | 1. 解析 VCP 指令 → 2. 调用 pluginManager.processToolCall() → 3. 返回执行结果 |
| **相关配置** | `Key` |
| **输出格式** | JSON 结果对象 |
| **限制条件** | 指令格式必须符合 VCP 协议 |

**请求示例：**
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」VCPFluxGen「末」,
prompt:「始」一只猫「末」
<<<[END_TOOL_REQUEST]>>>
```

---

### 2.5 任务调度 (Schedule Task)

| 属性 | 说明 |
|------|------|
| **功能描述** | 创建定时任务，在指定时间执行工具调用 |
| **入口文件** | `server.js` |
| **入口函数** | `app.post('/v1/schedule_task', ...)` |
| **触发条件** | HTTP POST 请求到 `/v1/schedule_task` |
| **处理流程** | 1. 解析 schedule_time 和 tool_call → 2. 创建定时任务 → 3. 到期后自动执行工具 |
| **相关配置** | 无 |
| **输出格式** | JSON 任务确认 |
| **限制条件** | schedule_time 必须是有效的 ISO 8601 格式 |

---

### 2.6 插件回调 (Plugin Callback)

| 属性 | 说明 |
|------|------|
| **功能描述** | 异步插件任务完成后的回调端点 |
| **入口文件** | `server.js` |
| **入口函数** | `app.post('/plugin-callback/:pluginName/:taskId', ...)` |
| **触发条件** | 异步插件 POST 请求到 `/plugin-callback/:pluginName/:taskId` |
| **处理流程** | 1. 解析路径参数 → 2. 查找待处理回调 → 3. 注入结果到对话历史 → 4. 触发 AI 重新响应 |
| **相关配置** | `CALLBACK_BASE_URL` |
| **输出格式** | JSON 确认消息 |
| **限制条件** | taskId 必须存在；无认证要求 |

---

### 2.7 特殊模型透传 (Special Model Router)

| 属性 | 说明 |
|------|------|
| **功能描述** | 白名单模型绕过 VCP 处理，直接透传到后端 |
| **入口文件** | `routes/specialModelRouter.js` |
| **入口函数** | `router.post('/v1/chat/completions', ...)` |
| **触发条件** | 请求模型名匹配 `WhitelistImageModel` 或 `WhitelistEmbeddingModel` |
| **处理流程** | 1. 检查模型白名单 → 2. 匹配则直接透传 → 3. 图像模型自动添加 generationConfig |
| **相关配置** | `WhitelistImageModel`, `WhitelistEmbeddingModel` |
| **输出格式** | 透传后端响应 |
| **限制条件** | 仅对白名单模型生效 |

---

## 3. 插件执行功能

### 3.1 静态插件 (static)

| 属性 | 说明 |
|------|------|
| **功能描述** | 周期性生成静态数据，通过占位符注入系统提示词 |
| **入口文件** | `Plugin.js` |
| **入口函数** | `_updateStaticPluginValue()`, `initializeStaticPlugins()` (行 116-258) |
| **触发条件** | 1. 系统启动时首次执行 2. 按 `refreshIntervalCron` 周期调度 |
| **处理流程** | 1. 解析 cron 表达式 → 2. spawn 子进程执行脚本 → 3. 收集 stdout 输出 → 4. 更新 `staticPlaceholderValues` Map |
| **相关配置** | `refreshIntervalCron`, `communication.timeout` (默认 60s) |
| **输出格式** | 存储为占位符值，通过 `{{PlaceholderName}}` 访问 |
| **限制条件** | 超时不视为错误；输出非 JSON 时作为纯文本处理 |

**Manifest 示例：**
```json
{
  "pluginType": "static",
  "refreshIntervalCron": "*/5 * * * *",
  "capabilities": {
    "systemPromptPlaceholders": [
      { "placeholder": "{{VCPWeatherInfo}}", "description": "天气信息" }
    ]
  }
}
```

---

### 3.2 同步插件 (synchronous)

| 属性 | 说明 |
|------|------|
| **功能描述** | 执行一次性工具任务，阻塞等待结果返回 |
| **入口文件** | `Plugin.js` |
| **入口函数** | `executePlugin()`, `processToolCall()` (行 805-918, 632-803) |
| **触发条件** | AI 输出包含 VCP 工具调用指令 |
| **处理流程** | 1. 解析 VCP 指令 → 2. 构建环境变量 → 3. spawn 子进程 → 4. 发送参数到 stdin → 5. 收集 stdout → 6. 解析 JSON 结果 |
| **相关配置** | `communication.timeout` (默认 60s), `requiresAdmin` |
| **输出格式** | 标准 JSON: `{ status, result/error, messageForAI?, base64? }` |
| **限制条件** | 必须返回有效 JSON；超时自动终止进程 |

**返回格式：**
```json
{
  "status": "success",
  "result": "执行结果内容",
  "messageForAI": "可选，给 AI 的额外提示",
  "base64": "可选，Base64 编码数据"
}
```

---

### 3.3 异步插件 (asynchronous)

| 属性 | 说明 |
|------|------|
| **功能描述** | 执行长时间任务，立即返回任务 ID，完成后通过回调通知 |
| **入口文件** | `Plugin.js` |
| **入口函数** | `executePlugin()` (行 886-906) |
| **触发条件** | AI 输出包含 VCP 工具调用指令，且插件类型为 `asynchronous` |
| **处理流程** | 1. 立即返回初始响应（含 requestId）→ 2. 后台任务执行 → 3. 完成后 POST 到 `/plugin-callback/:pluginName/:taskId` |
| **相关配置** | `communication.timeout` (默认 30min), `CALLBACK_BASE_URL` |
| **输出格式** | 初始响应 + 回调响应 |
| **限制条件** | 必须在初始响应中返回 `requestId`；回调 URL 必须可达 |

**初始响应：**
```json
{
  "status": "success",
  "result": { "requestId": "task_123", "message": "任务已提交" }
}
```

**回调请求：**
```json
{
  "requestId": "task_123",
  "status": "Succeed",
  "result": "最终结果"
}
```

---

### 3.4 服务插件 (service)

| 属性 | 说明 |
|------|------|
| **功能描述** | 常驻内存服务，提供持续性功能（HTTP 路由、WebSocket 等） |
| **入口文件** | `Plugin.js` |
| **入口函数** | `loadPlugins()` 中的 direct 协议加载 (行 455-466) |
| **触发条件** | 系统启动时自动加载 |
| **处理流程** | 1. require 模块 → 2. 调用 `initialize(config, dependencies)` → 3. 可选调用 `registerApiRoutes(router)` |
| **相关配置** | `configSchema`, `hasApiRoutes` |
| **输出格式** | 服务常驻内存，无直接输出 |
| **限制条件** | 使用 `direct` 协议，不支持热加载 |

**模块接口：**
```javascript
module.exports = {
  async initialize(config, dependencies) { },
  registerApiRoutes(router, config, projectBasePath, webSocketServer) { },
  async shutdown() { }
};
```

---

### 3.5 消息预处理器 (messagePreprocessor)

| 属性 | 说明 |
|------|------|
| **功能描述** | 在消息发送给 LLM 前进行预处理（图像理解、格式转换等） |
| **入口文件** | `Plugin.js`, `modules/chatCompletionHandler.js` |
| **入口函数** | `processMessages()` (行 324-345), `chatCompletionHandler.js:463-473` |
| **触发条件** | 每次对话请求时按顺序执行 |
| **处理流程** | 1. 按 `preprocessor_order.json` 顺序排列 → 2. 依次调用 `processMessages(messages, config)` → 3. 修改后的 messages 传递给下游 |
| **相关配置** | `preprocessor_order.json`, `configSchema` |
| **输出格式** | 修改后的 messages 数组 |
| **限制条件** | 执行顺序影响结果；单个预处理器异常会中断整个请求 |

---

### 3.6 混合服务插件 (hybridservice)

| 属性 | 说明 |
|------|------|
| **功能描述** | 同时具备静态占位符、消息预处理和工具调用能力的综合型插件 |
| **入口文件** | `Plugin.js` |
| **入口函数** | 综合调用 `processMessages()`, `processToolCall()`, 占位符获取 |
| **触发条件** | 根据使用场景触发不同能力 |
| **处理流程** | 1. 启动时调用 `initialize()` → 2. 对话时调用 `processMessages()` → 3. 工具调用时调用 `processToolCall()` → 4. 占位符替换时获取缓存值 |
| **相关配置** | `capabilities.systemPromptPlaceholders`, `capabilities.invocationCommands` |
| **输出格式** | 根据调用类型返回不同格式 |
| **限制条件** | 最灵活但实现最复杂；使用 `direct` 协议 |

**模块接口：**
```javascript
module.exports = {
  async initialize(config, dependencies) { },
  async processMessages(messages, config) { return messages; },
  async processToolCall(args) { return { status, result }; },
  async shutdown() { }
};
```

---

## 4. WebSocket 通信功能

### 4.1 VCPLog 客户端

| 属性 | 说明 |
|------|------|
| **功能描述** | 普通日志客户端，接收服务器广播的日志消息 |
| **入口文件** | `WebSocketServer.js` |
| **WebSocket 路径** | `/VCPlog/VCP_Key=<key>` |
| **触发条件** | 客户端发起 WebSocket 连接请求 |
| **处理流程** | 1. 正则匹配路径 → 2. 验证 VCP_Key → 3. 存储到 `clients` Map → 4. 发送 connection_ack |
| **相关配置** | `VCP_Key` |
| **输出格式** | JSON 消息: `{ type: 'connection_ack', message: '...' }` |
| **限制条件** | VCP_Key 必须匹配 |

---

### 4.2 VCPInfo 客户端

| 属性 | 说明 |
|------|------|
| **功能描述** | 信息通道客户端，接收系统状态、插件状态等推送 |
| **入口文件** | `WebSocketServer.js` |
| **WebSocket 路径** | `/vcpinfo/VCP_Key=<key>` |
| **触发条件** | 客户端发起 WebSocket 连接请求 |
| **处理流程** | 同 VCPLog，使用 `broadcastVCPInfo(data)` 广播 |
| **相关配置** | `VCP_Key` |
| **输出格式** | JSON 系统状态消息 |
| **限制条件** | VCP_Key 必须匹配 |

---

### 4.3 分布式服务器节点 (DistributedServer)

| 属性 | 说明 |
|------|------|
| **功能描述** | 分布式服务器节点，注册远程工具并执行主服务器下发的工具调用 |
| **入口文件** | `WebSocketServer.js` |
| **WebSocket 路径** | `/vcp-distributed-server/VCP_Key=<key>` |
| **触发条件** | VCPDistributedServer 连接主服务器 |
| **处理流程** | 1. 连接建立 → 2. 发送 `register_tools` → 3. 发送 `report_ip` → 4. 接收 `execute_tool` 请求 → 5. 执行本地插件 → 6. 返回 `tool_result` |
| **相关配置** | `VCP_Key` |
| **输出格式** | 工具执行结果 JSON |
| **限制条件** | 节点断开时自动注销所有工具 |

---

### 4.4 ChromeObserver 客户端

| 属性 | 说明 |
|------|------|
| **功能描述** | Chrome 浏览器扩展观察者端，持续上报页面状态 |
| **入口文件** | `WebSocketServer.js` |
| **WebSocket 路径** | `/vcp-chrome-observer/VCP_Key=<key>` |
| **触发条件** | Chrome 扩展发起连接 |
| **处理流程** | 1. 连接建立 → 2. 存储到 `chromeObserverClients` → 3. 调用 ChromeBridge.handleNewClient() → 4. 持续接收 `pageInfoUpdate` |
| **相关配置** | `VCP_Key` |
| **输出格式** | 页面信息 Markdown |
| **限制条件** | 需要定期发送心跳 |

---

### 4.5 ChromeControl 客户端

| 属性 | 说明 |
|------|------|
| **功能描述** | Chrome 浏览器扩展控制端，发送控制命令 |
| **入口文件** | `WebSocketServer.js` |
| **WebSocket 路径** | `/vcp-chrome-control/VCP_Key=<key>` |
| **触发条件** | Chrome 扩展控制端发起连接 |
| **处理流程** | 1. 发送 `command` 消息 → 2. 服务器转发给 Observer → 3. 接收 `command_result` |
| **相关配置** | `VCP_Key` |
| **输出格式** | 命令执行结果 |
| **限制条件** | 需要有对应的 Observer 在线 |

---

### 4.6 AdminPanel 客户端

| 属性 | 说明 |
|------|------|
| **功能描述** | Web 管理面板客户端，实时接收系统状态更新 |
| **入口文件** | `WebSocketServer.js` |
| **WebSocket 路径** | `/vcp-admin-panel/VCP_Key=<key>` |
| **触发条件** | 管理面板页面加载 |
| **处理流程** | 1. 连接建立 → 2. 存储到 `adminPanelClients` → 3. 通过 `broadcastToAdminPanel()` 接收更新 |
| **相关配置** | `VCP_Key`, `AdminUsername`, `AdminPassword` |
| **输出格式** | JSON 状态更新 |
| **限制条件** | 需要先通过 Basic Auth 登录 |

---

## 5. RAG 检索功能

### 5.1 日记本向量检索

| 属性 | 说明 |
|------|------|
| **功能描述** | 基于语义相似度检索日记本内容，每个日记本拥有独立索引 |
| **入口文件** | `KnowledgeBaseManager.js` |
| **入口函数** | `search()`, `_getOrLoadDiaryIndex()` (行 210-220, 446-621) |
| **触发条件** | 系统提示词中包含 `[[日记本名::...]]` 占位符 |
| **处理流程** | 1. 解析日记本名 → 2. 懒加载对应索引 → 3. 计算查询向量 → 4. TagMemo 算法处理 → 5. 返回相关 chunks |
| **相关配置** | `VECTORDB_DIMENSION`, `KNOWLEDGEBASE_BATCH_WINDOW_MS` |
| **输出格式** | 文本 chunks 列表 |
| **限制条件** | 向量维度必须与 Embedding 模型匹配；索引容量 50,000 |

---

### 5.2 TagMemo "浪潮"算法 V5

| 属性 | 说明 |
|------|------|
| **功能描述** | 基于语义引力与向量重塑的高级 RAG 算法，包含 EPA 分析、残差金字塔、霰弹枪查询 |
| **入口文件** | `KnowledgeBaseManager.js`, `EPAModule.js`, `ResidualPyramid.js` |
| **入口函数** | `search()` 主流程 (行 446-621) |
| **触发条件** | RAG 检索时自动应用 |
| **处理流程** | **阶段一-感应**: EPA 投影计算逻辑深度 → **阶段二-分解**: 残差金字塔迭代 → **阶段三-扩张**: 核心标签补全 + 关联词拉回 → **阶段四-重塑**: 动态参数融合 + 语义去重 |
| **相关配置** | `rag_params.json` (activationMultiplier, dynamicBoostRange, coreBoostRange 等) |
| **输出格式** | 增强后的检索结果 |
| **限制条件** | 需要 Tag 向量索引已建立；核心标签有特权豁免 |

---

### 5.3 EPA 语义空间分析

| 属性 | 说明 |
|------|------|
| **功能描述** | 通过加权 PCA 计算逻辑深度、世界观门控、跨域共振 |
| **入口文件** | `modules/EPAModule.js` |
| **入口函数** | `project()`, `detectCrossDomainResonance()` (行 71-201) |
| **触发条件** | TagMemo 算法感应阶段 |
| **处理流程** | 1. K-Means 聚类 Tag 向量 → 2. 加权 SVD 提取主成分 → 3. 计算投影熵 → 4. 输出逻辑深度 = 1 - 归一化熵 |
| **相关配置** | 聚类数 K, 收敛阈值 1e-4 |
| **输出格式** | `{ logicDepth, dominantAxes, resonance }` |
| **限制条件** | 需要 Tag 向量数量 ≥ K |

---

### 5.4 残差金字塔分析

| 属性 | 说明 |
|------|------|
| **功能描述** | 使用 Gram-Schmidt 正交化分解语义能量，捕捉微弱信号 |
| **入口文件** | `modules/ResidualPyramid.js` |
| **入口函数** | `analyze()`, `_computeOrthogonalProjection()` (行 25-210) |
| **触发条件** | TagMemo 算法分解阶段 |
| **处理流程** | 1. 搜索最近 Tags → 2. Gram-Schmidt 正交化 → 3. 计算残差 → 4. 迭代直到 90% 能量被解释 |
| **相关配置** | `maxLevels`, `topK`, `minEnergyRatio` |
| **输出格式** | `{ levels, totalExplainedEnergy, features: { coverage, novelty, coherence } }` |
| **限制条件** | 最大迭代层数限制；能量阈值截断 |

---

### 5.5 SVD 结果去重器

| 属性 | 说明 |
|------|------|
| **功能描述** | 使用 SVD 主题建模和残差选择进行智能去重 |
| **入口文件** | `modules/ResultDeduplicator.js` |
| **入口函数** | `deduplicate()` (行 44-168) |
| **触发条件** | TagMemo 霰弹枪查询后 |
| **处理流程** | 1. SVD 提取候选结果主题 → 2. 保留 95% 累积能量主题 → 3. 残差选择：迭代选择能解释"未覆盖能量"的最佳结果 |
| **相关配置** | 去重阈值, 最大选择轮数 |
| **输出格式** | 去重后的候选列表 |
| **限制条件** | 候选数 ≤ 5 时不执行去重 |

---

### 5.6 文件索引管道

| 属性 | 说明 |
|------|------|
| **功能描述** | 实时监听文件变更，自动更新向量索引 |
| **入口文件** | `KnowledgeBaseManager.js` |
| **入口函数** | `_startWatcher()`, `_flushBatch()` (行 880-1152) |
| **触发条件** | 文件创建/修改/删除 |
| **处理流程** | 1. chokidar 监听 → 2. 批处理窗口聚合 → 3. 文本分块 → 4. 批量 Embedding → 5. SQLite 事务写入 → 6. 更新 Vexus 索引 |
| **相关配置** | `KNOWLEDGEBASE_BATCH_WINDOW_MS`, `KNOWLEDGEBASE_MAX_BATCH_SIZE` |
| **输出格式** | 索引更新 |
| **限制条件** | 忽略规则检查；支持的文件类型: .md, .txt |

---

### 5.7 标签共现矩阵

| 属性 | 说明 |
|------|------|
| **功能描述** | 构建 Tag 共现关系，用于关联词拉回 |
| **入口文件** | `KnowledgeBaseManager.js` |
| **入口函数** | `_buildCooccurrenceMatrix()` (行 1233-1258) |
| **触发条件** | 索引更新后异步重建 |
| **处理流程** | 1. 查询 file_tags 关联 → 2. 统计共现次数 → 3. 构建对称矩阵 |
| **相关配置** | 无 |
| **输出格式** | `Map<tagId, Map<relatedTagId, weight>>` |
| **限制条件** | 大量 Tag 时构建耗时 |

---

### 5.8 RAG 参数热调控

| 属性 | 说明 |
|------|------|
| **功能描述** | 支持运行时动态调整 RAG 参数，无需重启 |
| **入口文件** | `KnowledgeBaseManager.js` |
| **入口函数** | `loadRagParams()`, `_startRagParamsWatcher()` (行 140-164) |
| **触发条件** | `rag_params.json` 文件变更 |
| **处理流程** | 1. chokidar 监听文件 → 2. 检测变更 → 3. 重新加载参数 → 4. 应用到后续检索 |
| **相关配置** | `rag_params.json` |
| **输出格式** | 参数对象 |
| **限制条件** | JSON 格式必须有效 |

**可调控参数：**
| 参数名 | 默认值 | 说明 |
|--------|--------|------|
| `activationMultiplier` | [0.5, 1.5] | TagMemo 激活乘数范围 |
| `dynamicBoostRange` | [0.3, 2.0] | 动态增强范围 |
| `coreBoostRange` | [1.20, 1.40] | 核心标签增强范围 |
| `deduplicationThreshold` | 0.88 | 语义去重阈值 |

---

## 6. 管理面板功能

### 6.1 系统监控

| 属性 | 说明 |
|------|------|
| **功能描述** | 实时监控 CPU、内存、PM2 进程状态 |
| **入口文件** | `routes/adminPanelRoutes.js` |
| **API 端点** | `GET /admin_api/system-monitor/pm2/processes`, `GET /admin_api/system-monitor/system/resources` |
| **触发条件** | 管理面板访问系统监控页面 |
| **处理流程** | 1. 验证 Basic Auth → 2. 调用系统 API → 3. 返回监控数据 |
| **相关配置** | `AdminUsername`, `AdminPassword` |
| **输出格式** | JSON 进程/资源列表 |
| **限制条件** | 需要 PM2 运行；凭据未配置时返回 503 |

---

### 6.2 配置管理

| 属性 | 说明 |
|------|------|
| **功能描述** | 在线预览和编辑 `config.env` |
| **入口文件** | `routes/adminPanelRoutes.js` |
| **API 端点** | `GET /admin_api/config/main`, `POST /admin_api/config/main` |
| **触发条件** | 管理员编辑配置 |
| **处理流程** | 1. 读取/写入 config.env → 2. 自动隐藏敏感字段 → 3. 保存后需重启生效 |
| **相关配置** | `config.env` |
| **输出格式** | JSON 配置对象 |
| **限制条件** | 敏感字段（如 API Key）以 `****` 显示 |

---

### 6.3 插件中心

| 属性 | 说明 |
|------|------|
| **功能描述** | 集中管理所有已加载插件，支持启用/禁用、配置编辑 |
| **入口文件** | `routes/adminPanelRoutes.js` |
| **API 端点** | `GET /admin_api/plugins`, `POST /admin_api/plugins/:name/toggle` |
| **触发条件** | 管理员操作插件 |
| **处理流程** | 1. 获取插件列表 → 2. 启用/禁用通过 `.block` 文件实现 → 3. 配置编辑写入 `config.env` |
| **相关配置** | `plugin-manifest.json`, `config.env` |
| **输出格式** | JSON 插件列表 |
| **限制条件** | `direct` 协议插件禁用后需重启 |

---

### 6.4 知识库浏览器

| 属性 | 说明 |
|------|------|
| **功能描述** | 浏览、搜索、编辑 `dailynote/` 目录下的知识库文件 |
| **入口文件** | `routes/adminPanelRoutes.js` |
| **API 端点** | `GET /admin_api/knowledge-base/browse`, `GET/POST/DELETE /admin_api/knowledge-base/file` |
| **触发条件** | 管理员管理知识库 |
| **处理流程** | 1. 遍历目录结构 → 2. 读取/写入文件 → 3. 更新触发索引重建 |
| **相关配置** | `dailynote/` 目录 |
| **输出格式** | JSON 文件树/内容 |
| **限制条件** | 文件编码必须为 UTF-8 |

---

### 6.5 RAG-Tags 编辑器

| 属性 | 说明 |
|------|------|
| **功能描述** | 管理与知识库文件关联的 RAG 标签 |
| **入口文件** | `routes/adminPanelRoutes.js` |
| **API 端点** | `GET /admin_api/knowledge-base/tags` |
| **触发条件** | 管理员编辑文件标签 |
| **处理流程** | 1. 解析文件中的 `Tag:` 行 → 2. 显示已有标签 → 3. 编辑后更新文件 |
| **相关配置** | 无 |
| **输出格式** | JSON 标签列表 |
| **限制条件** | 标签格式必须符合规范 |

---

### 6.6 Agent 管理器

| 属性 | 说明 |
|------|------|
| **功能描述** | 管理 `Agent/` 目录下的角色定义文件 |
| **入口文件** | `routes/adminPanelRoutes.js` |
| **API 端点** | `GET /admin_api/agent/files`, `GET/POST /admin_api/agent/file` |
| **触发条件** | 管理员管理 Agent |
| **处理流程** | 1. 遍历 Agent 目录 → 2. 读取/写入角色定义 → 3. 更新 `agent_map.json` |
| **相关配置** | `Agent/agent_map.json` |
| **输出格式** | JSON Agent 列表/内容 |
| **限制条件** | Agent 文件必须包含有效的角色定义 |

---

### 6.7 服务器日志查看

| 属性 | 说明 |
|------|------|
| **功能描述** | 实时查看服务器日志，支持增量读取 |
| **入口文件** | `routes/adminPanelRoutes.js` |
| **API 端点** | `GET /admin_api/server-log`, `POST /admin_api/server-log/clear` |
| **触发条件** | 管理员查看日志 |
| **处理流程** | 1. 读取日志文件 → 2. 增量模式返回新增内容 → 3. 清空模式重置日志 |
| **相关配置** | 日志文件路径 |
| **输出格式** | JSON `{ content, offset, fileSize }` |
| **限制条件** | 大文件时自动截断 |

---

### 6.8 预处理器顺序管理

| 属性 | 说明 |
|------|------|
| **功能描述** | 通过拖拽方式调整消息预处理器执行顺序 |
| **入口文件** | `routes/adminPanelRoutes.js` |
| **API 端点** | `GET/POST /admin_api/preprocessors/order` |
| **触发条件** | 管理员调整顺序 |
| **处理流程** | 1. 读取 `preprocessor_order.json` → 2. 更新顺序 → 3. 写回文件 |
| **相关配置** | `preprocessor_order.json` |
| **输出格式** | JSON 顺序数组 |
| **限制条件** | 必须包含所有已注册的预处理器 |

---

## 7. 分布式工具功能

### 7.1 节点注册

| 属性 | 说明 |
|------|------|
| **功能描述** | 分布式节点连接后自动注册其提供的工具 |
| **入口文件** | `WebSocketServer.js`, `Plugin.js` |
| **入口函数** | `handleDistributedServerMessage()` 中的 `register_tools` 分支 (行 407-416) |
| **触发条件** | 节点发送 `register_tools` 消息 |
| **处理流程** | 1. 过滤内部工具 → 2. 调用 `pluginManager.registerDistributedTools()` → 3. 添加 `[云端]` 前缀和 `isDistributed: true` 标记 |
| **相关配置** | `VCP_Key` |
| **输出格式** | 更新后的插件列表 |
| **限制条件** | 工具名不能与本地插件冲突 |

---

### 7.2 IP 上报与溯源

| 属性 | 说明 |
|------|------|
| **功能描述** | 节点上报 IP 信息，用于文件溯源 |
| **入口文件** | `WebSocketServer.js` |
| **入口函数** | `handleDistributedServerMessage()` 中的 `report_ip` 分支 (行 418-430) |
| **触发条件** | 节点发送 `report_ip` 消息 |
| **处理流程** | 1. 存储到 `distributedServerIPs` Map → 2. 建立服务器名称映射 |
| **相关配置** | 无 |
| **输出格式** | 内部存储 |
| **限制条件** | 无 |

---

### 7.3 分布式工具执行

| 属性 | 说明 |
|------|------|
| **功能描述** | 透明执行远程节点上的工具 |
| **入口文件** | `Plugin.js`, `WebSocketServer.js` |
| **入口函数** | `processToolCall()` 检测 `isDistributed` → `executeDistributedTool()` (行 467-509) |
| **触发条件** | AI 调用带有 `isDistributed: true` 标记的插件 |
| **处理流程** | 1. 检测分布式标记 → 2. 生成 requestId → 3. 发送 `execute_tool` 消息 → 4. 等待 `tool_result` 响应 → 5. 超时处理 |
| **相关配置** | `communication.timeout` |
| **输出格式** | 与本地工具相同 |
| **限制条件** | 节点必须在线；超时自动拒绝 |

---

### 7.4 跨节点文件获取 (FileFetcher)

| 属性 | 说明 |
|------|------|
| **功能描述** | 当本地文件不存在时，自动从来源节点获取 |
| **入口文件** | `FileFetcherServer.js`, `Plugin.js` |
| **入口函数** | `fetchFile()` (行 726-773) |
| **触发条件** | 插件执行时遇到 `file://` URL 且本地文件不存在 |
| **处理流程** | 1. 检查本地缓存 → 2. 根据 IP 查找来源服务器 → 3. 调用 `internal_request_file` → 4. 返回 Base64 数据 → 5. 重试插件执行 |
| **相关配置** | 缓存目录 `.file_cache/` |
| **输出格式** | `{ buffer, mimeType }` |
| **限制条件** | 循环请求检测；失败缓存 30 秒 |

---

### 7.5 静态占位符远程更新

| 属性 | 说明 |
|------|------|
| **功能描述** | 分布式节点可以推送静态占位符更新 |
| **入口文件** | `WebSocketServer.js` |
| **入口函数** | `handleDistributedServerMessage()` 中的 `update_static_placeholders` 分支 |
| **触发条件** | 节点发送 `update_static_placeholders` 消息 |
| **处理流程** | 1. 接收占位符数据 → 2. 更新 `staticPlaceholderValues` Map |
| **相关配置** | 无 |
| **输出格式** | 内部存储 |
| **限制条件** | 占位符名不能与本地冲突 |

---

## 8. 功能依赖关系图

### 8.1 核心依赖图

```
                    ┌─────────────────────────────────────┐
                    │           HTTP 请求                  │
                    │   (POST /v1/chat/completions)       │
                    └──────────────────┬──────────────────┘
                                       │
                    ┌──────────────────▼──────────────────┐
                    │         Bearer Token 认证            │
                    │         (server.js:466-493)          │
                    └──────────────────┬──────────────────┘
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
        │                              │                              │
        ▼                              ▼                              ▼
┌───────────────┐            ┌─────────────────┐            ┌─────────────────┐
│  模型重定向    │            │  特殊模型检查    │            │  对话处理       │
│  (config)     │            │  (whitelist)    │            │  ChatCompletion │
└───────────────┘            └─────────────────┘            │  Handler        │
                                                              └────────┬────────┘
                                                                       │
                    ┌──────────────────────────────────────────────────┤
                    │                                                  │
                    ▼                                                  ▼
        ┌─────────────────────┐                            ┌─────────────────────┐
        │  消息预处理器链      │                            │  变量替换管线        │
        │  (messagePreprocessor)│                           │  (messageProcessor)  │
        │  - ImageProcessor    │                            │  - Agent 展开        │
        │  - RAGDiaryPlugin    │                            │  - 占位符替换        │
        │  - VCPTavern         │                            │  - 静态插件注入      │
        └──────────┬──────────┘                            └──────────┬──────────┘
                   │                                                  │
                   └───────────────────────┬──────────────────────────┘
                                           │
                                           ▼
                    ┌─────────────────────────────────────┐
                    │         调用上游 AI API               │
                    │         (fetchWithRetry)             │
                    └──────────────────┬──────────────────┘
                                       │
                                       ▼
                    ┌─────────────────────────────────────┐
                    │         VCP 工具调用检测              │
                    │         (<<<[TOOL_REQUEST]>>>)       │
                    └──────────────────┬──────────────────┘
                                       │
                    ┌──────────────────┼──────────────────┐
                    │                  │                  │
                    ▼                  ▼                  ▼
            ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
            │  本地插件    │    │  混合插件    │    │  分布式插件  │
            │  (stdio)    │    │  (direct)   │    │  (WebSocket) │
            └──────┬──────┘    └──────┬──────┘    └──────┬──────┘
                   │                  │                  │
                   │                  │                  ▼
                   │                  │          ┌─────────────────┐
                   │                  │          │  executeDistrib │
                   │                  │          │  utedTool()     │
                   │                  │          └────────┬────────┘
                   │                  │                   │
                   └──────────────────┴───────────────────┘
                                      │
                                      ▼
                    ┌─────────────────────────────────────┐
                    │         工具结果注入对话历史          │
                    │         递归调用 AI（如需要）         │
                    └─────────────────────────────────────┘
```

### 8.2 RAG 子系统依赖

```
┌─────────────────────────────────────────────────────────────────┐
│                    KnowledgeBaseManager                          │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    文件监听 (chokidar)                        │ │
│  └─────────────────────────────┬───────────────────────────────┘ │
│                                │                                  │
│                                ▼                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │              批处理管道 (_flushBatch)                         │ │
│  │  1. 文本分块 (TextChunker)                                   │ │
│  │  2. 标签提取 (_extractTags)                                  │ │
│  │  3. 批量 Embedding (EmbeddingUtils)                          │ │
│  │  4. SQLite 事务写入                                          │ │
│  │  5. Vexus 索引更新                                           │ │
│  └─────────────────────────────┬───────────────────────────────┘ │
│                                │                                  │
│                                ▼                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ diaryIndices │  │   tagIndex   │  │ SQLite (chunks/tags) │   │
│  │  (多索引)    │  │  (全局)      │  │                      │   │
│  └──────────────┘  └──────────────┘  └──────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      检索时 (search)                             │
│  ┌─────────────┐                                                │
│  │  EPA Module │ ──► 逻辑深度 / 共振检测 / 世界观门控            │
│  └─────────────┘                                                │
│        │                                                        │
│        ▼                                                        │
│  ┌─────────────────┐                                            │
│  │ ResidualPyramid │ ──► 残差分解 / 能量解释 / 特征提取          │
│  └─────────────────┘                                            │
│        │                                                        │
│        ▼                                                        │
│  ┌──────────────────────┐                                       │
│  │ ResultDeduplicator   │ ──► SVD 主题建模 / 残差选择            │
│  └──────────────────────┘                                       │
│        │                                                        │
│        ▼                                                        │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ 动态参数融合 (effectiveTagBoost = baseTagBoost * factor) │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 8.3 分布式系统依赖

```
┌─────────────────────────────────────────────────────────────────┐
│                       VCP 主服务器                               │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                   WebSocketServer                            │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │ │
│  │  │ clients     │  │ distributed │  │ chromeObserver      │ │ │
│  │  │ Map         │  │ Servers Map │  │ Clients Map         │ │ │
│  │  └─────────────┘  └─────────────┘  └─────────────────────┘ │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                              │                                   │
│                              ▼                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                   FileFetcherServer                          │ │
│  │  - findServerByIp(): IP → serverId 映射                      │ │
│  │  - fetchFile(): 跨节点文件获取 + 缓存                         │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                              │                                   │
│                              ▼                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                   PluginManager                              │ │
│  │  - registerDistributedTools(): 注册远程工具                   │ │
│  │  - processToolCall(): isDistributed 检测与路由               │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                    │
        ┌───────────┼───────────┐
        │           │           │
        ▼           ▼           ▼
┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│  分布式节点  │ │  分布式节点  │ │  Chrome 扩展 │
│  (GPU)      │ │  (File)     │ │  (Observer) │
│             │ │             │ │             │
│ - 本地插件  │ │ - 文件服务  │ │ - 页面监听  │
│ - 执行结果  │ │ - 文件传输  │ │ - 命令执行  │
└─────────────┘ └─────────────┘ └─────────────┘
```

---

## 9. 常见功能组合场景

### 9.1 AI 调用联网搜索 + 记忆

**场景描述**: 用户询问需要联网搜索且涉及历史记忆的问题

**功能组合**:
```
HTTP API (/v1/chat/completions)
    │
    ├── 消息预处理器链
    │   ├── ImageProcessor (处理图像)
    │   └── RAGDiaryPlugin (TagMemo 检索记忆)
    │
    ├── 变量替换
    │   └── [[日记本::Time::Group::TagMemo]] (记忆注入)
    │
    ├── AI 响应 (含工具调用)
    │   └── <<<[TOOL_REQUEST]>>> VSearch ...
    │
    └── 工具执行
        └── VSearch (同步插件，联网搜索)
```

**关键配置**:
- `MaxVCPLoopStream`: 控制最大工具调用轮数
- `rag_params.json`: 调整记忆检索参数
- VSearch 插件的 `config.env`: 搜索 API 配置

---

### 9.2 分布式视频生成

**场景描述**: AI 生成视频，任务分发到 GPU 服务器节点

**功能组合**:
```
HTTP API (/v1/chat/completions)
    │
    ├── AI 响应 (含工具调用)
    │   └── <<<[TOOL_REQUEST]>>> VideoGenerator ...
    │
    ├── 工具执行 (Plugin.js 检测 isDistributed)
    │   └── WebSocketServer.executeDistributedTool()
    │       │
    │       ├── 发送 execute_tool 到 GPU 节点
    │       │
    │       └── 节点返回 tool_result (异步)
    │
    └── 初始响应返回给用户
        │
        └── 后续回调注入对话历史
            └── /plugin-callback/VideoGenerator/:taskId
```

**关键配置**:
- GPU 节点 `config.env`: `Main_Server_URL`, `VCP_Key`
- VideoGenerator 插件: `pluginType: "asynchronous"`, `timeout: 1800000`

---

### 9.3 跨节点文件处理

**场景描述**: AI 需要处理存储在另一台服务器上的文件

**功能组合**:
```
HTTP API (/v1/chat/completions)
    │
    ├── AI 响应 (含工具调用)
    │   └── <<<[TOOL_REQUEST]>>> ImageEditor image_url:「始」file:///path/to/image.jpg「末」
    │
    ├── 工具执行
    │   └── 本地插件尝试读取文件
    │       └── FILE_NOT_FOUND_LOCALLY
    │
    ├── FileFetcherServer.fetchFile()
    │   ├── 根据 requestIp 查找来源服务器
    │   ├── executeDistributedTool(serverId, 'internal_request_file', ...)
    │   └── 返回 Base64 数据
    │
    └── 重试插件执行 (替换 file:// 为 data: URI)
```

**关键配置**:
- 所有节点配置相同的 `VCP_Key`
- 节点发送 `report_ip` 消息建立 IP 映射

---

### 9.4 浏览器自动化

**场景描述**: AI 控制用户的 Chrome 浏览器执行操作

**功能组合**:
```
HTTP API (/v1/chat/completions)
    │
    ├── 占位符注入
    │   └── {{VCPChromePageInfo}} (当前页面内容)
    │
    ├── AI 响应 (含工具调用)
    │   └── <<<[TOOL_REQUEST]>>> ChromeControl command:「始」click「末」selector:「始」#submit「末」
    │
    ├── 工具执行 (ChromeBridge hybridservice)
    │   │
    │   ├── WebSocket 转发到 ChromeObserver
    │   │   └── { type: 'command', data: { ... } }
    │   │
    │   └── Chrome 扩展执行命令
    │       └── 返回 command_result
    │
    └── 可选: 等待 pageInfoUpdate (页面更新)
```

**关键配置**:
- Chrome 扩展连接到 `/vcp-chrome-observer/VCP_Key=xxx`
- ChromeBridge 插件: `pluginType: "hybridservice"`

---

### 9.5 系统监控 + 自动化运维

**场景描述**: 管理员通过面板监控系统，AI 自动处理告警

**功能组合**:
```
AdminPanel WebSocket
    │
    ├── 实时推送
    │   └── broadcastToAdminPanel({ type: 'system_alert', ... })
    │
Admin API
    │
    ├── GET /admin_api/system-monitor/system/resources
    │   └── 返回 CPU/内存使用率
    │
    └── GET /admin_api/server-log?incremental=true
        └── 增量读取日志
        │
        └── AI 检测异常模式
            └── <<<[TOOL_REQUEST]>>> PowerShellExecutor ...
```

**关键配置**:
- `AdminUsername`, `AdminPassword`: 面板认证
- PowerShellExecutor 插件: `requiresAdmin: true`

---

### 9.6 Agent 自主记忆与学习

**场景描述**: AI Agent 自主记录重要信息并持续学习

**功能组合**:
```
HTTP API (/v1/chat/completions)
    │
    ├── AI 响应 (含日记写入指令)
    │   └── <<<[TOOL_REQUEST]>>> DailyNoteWrite content:「始」今天学习了...「末」
    │
    ├── 工具执行 (DailyNoteWrite 同步插件)
    │   └── 写入 dailynote/日记本/xxx.txt
    │
    └── 文件监听触发
        └── KnowledgeBaseManager._startWatcher()
            │
            ├── 文本分块 + Embedding
            │
            └── 更新向量索引
                │
                └── 后续对话自动检索相关记忆
```

**关键配置**:
- `dailynote/` 目录结构
- `KNOWLEDGEBASE_BATCH_WINDOW_MS`: 批处理窗口
- Tag 提取规则: `Tag: xxx, yyy`

---

### 9.7 元思考 + RAG 增强推理

**场景描述**: 复杂问题需要深度思考和知识检索

**功能组合**:
```
HTTP API (/v1/chat/completions)
    │
    ├── 系统提示词
    │   └── [[VCP元思考:creative_writing::Group]]
    │       └── 触发元思考系统
    │           │
    │           ├── 词元组捕网 (Semantic Group)
    │           │   └── 增强 Query 向量
    │           │
    │           └── 元逻辑模块库
    │               └── 递归融合推理
    │
    ├── 记忆检索 (TagMemo V5)
    │   ├── EPA 分析意图聚焦度
    │   ├── 残差金字塔分解语义
    │   └── 霰弹枪查询 + 相控阵去重
    │
    └── AI 深度推理响应
```

**关键配置**:
- 元思考配置文件: `thinktheme/*.json`
- `rag_params.json`: TagMemo 参数

---

### 9.8 多 Agent 协同工作

**场景描述**: 多个 AI Agent 协作完成复杂任务

**功能组合**:
```
Agent A (主控)
    │
    ├── HTTP API (/v1/chat/completions)
    │   └── AI 响应含任务分解
    │
    ├── AgentAssistant 服务
    │   ├── 发送任务给 Agent B
    │   │   └── POST 到 Agent B 的 API
    │   │
    │   └── 接收 Agent B 的结果
    │       └── 回调注入 Agent A 对话
    │
Agent B (执行者)
    │
    ├── 接收任务
    │   └── HTTP API (/v1/chat/completions)
    │
    ├── 执行工具
    │   └── VSearch / FluxGen / ...
    │
    └── 返回结果给 Agent A
```

**关键配置**:
- AgentAssistant 插件配置
- VCP 论坛/任务版: Agent 间通信平台

---

## 附录

### A. 配置文件索引

| 文件 | 用途 | 加载位置 |
|------|------|----------|
| `config.env` | 全局环境变量 | `server.js:4` |
| `Plugin/*/config.env` | 插件私有配置 | `Plugin.js:442-446` |
| `Plugin/*/plugin-manifest.json` | 插件清单 | `Plugin.js:435` |
| `preprocessor_order.json` | 预处理器顺序 | `Plugin.js:484-496` |
| `rag_params.json` | RAG 热调控参数 | `KnowledgeBaseManager.js:140-149` |
| `ModelRedirect.json` | 模型重定向 | `modules/modelRedirectHandler.js` |
| `ip_blacklist.json` | IP 黑名单 | `server.js:179-193` |
| `Agent/agent_map.json` | Agent 别名映射 | `modules/agentManager.js` |

### B. 核心文件索引

| 文件 | 职责 | 核心类/函数 |
|------|------|-------------|
| `server.js` | HTTP 入口、启动编排 | `initialize()`, `startServer()` |
| `Plugin.js` | 插件生命周期管理 | `PluginManager` 类 |
| `WebSocketServer.js` | 分布式通信骨架 | `initialize()`, `executeDistributedTool()` |
| `KnowledgeBaseManager.js` | 向量库与 RAG 总控 | `KnowledgeBaseManager` 类 |
| `chatCompletionHandler.js` | 对话主流程编排 | `ChatCompletionHandler` 类 |
| `messageProcessor.js` | 变量替换管线 | `replaceAgentVariables()` |
| `FileFetcherServer.js` | 跨节点文件获取 | `fetchFile()` |
| `EPAModule.js` | 语义空间分析 | `EPAModule` 类 |
| `ResidualPyramid.js` | 残差金字塔 | `ResidualPyramid` 类 |
| `ResultDeduplicator.js` | 结果去重 | `ResultDeduplicator` 类 |

### C. 环境变量参考

```env
# 服务配置
PORT=6005
Key=YOUR_KEY                    # Bearer Token 密钥
VCP_Key=YOUR_VCP_KEY            # WebSocket 认证密钥

# Admin 认证
AdminUsername=admin
AdminPassword=123456

# API 配置
ApiRetries=3
ApiRetryDelay=200
MaxVCPLoopStream=5
MaxVCPLoopNonStream=5

# 特殊模型白名单
WhitelistImageModel=model1,model2
WhitelistEmbeddingModel=embed1,embed2

# 向量数据库
VECTORDB_DIMENSION=3072
KNOWLEDGEBASE_BATCH_WINDOW_MS=2000
KNOWLEDGEBASE_MAX_BATCH_SIZE=50

# 图片/文件服务密钥
Image_Key=YOUR_IMAGE_KEY
File_Key=YOUR_FILE_KEY
```

---

**文档版本**: 1.0.0  
**最后更新**: 2026-02-13  
**维护者**: VCP Team
