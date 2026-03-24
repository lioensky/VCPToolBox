# VCPToolBox 多端接入中间层实施与迁移方案
**版本:** 1.1 (2026-03-24 更新)
**创建日期:** 2026-03-23
**当前进度:** 约 75%
**适用范围:** VCPToolBox 作为多端接入中间层，面向 QQ、微信、企业微信、钉钉、飞书等外部渠道
**关联文档:** [CHANNEL_MIDDLEWARE_DESIGN.md](./CHANNEL_MIDDLEWARE_DESIGN.md)

---

## 1. 文档目标

本文档用于回答“怎么把设计真正落地”这件事，重点覆盖：

- 频道中间层的实施范围和边界
- 目标模块拆分、目录结构和文件职责
- 内部接口、管理接口、状态文件和核心数据结构
- 分阶段推进顺序、验收标准和回滚条件
- 从现有 `/internal/channel-ingest` 过渡到正式 `ChannelHub` 的迁移方案
- 现有钉钉接入如何标准化，其它平台如何按优先级接入

本文档默认建立在以下现状之上：

- 当前已存在 `/internal/channel-ingest` 入口，但它仍然是桥接型实现，而不是正式的通道中台能力。证据：`server.js:904-1021`
- 当前桥接返回值仍以文本为中心，只返回 `reply.text` / `reply.content`。证据：`server.js:1003-1013`
- 当前桥接鉴权实际使用全局 `Key` 或 `x-channel-bridge-key`，而不是单独的桥接密钥配置。证据：`server.js:931`；配置侧已有 `VCP_CHANNEL_BRIDGE_KEY` 说明，但尚未形成完整闭环。证据：`config.env.example:30-33`
- VCPToolBox 已有较强的插件运行时、工具调度和分布式能力，可作为中间层核心 runtime 复用。证据：`Plugin.js:477-478`、`Plugin.js:661-807`、`Plugin.js:1179`
- 当前已有 WebSocket 事件分发骨架，可复用为运维和通知平面的一部分。证据：`WebSocketServer.js:53-91`、`WebSocketServer.js:374-376`、`WebSocketServer.js:542`、`WebSocketServer.js:561-562`
- 钉钉适配器已经在发送结构化 payload，说明外部适配器层已经天然需要结构化协议，而不是文本桥。证据：`Plugin/vcp-dingtalk-adapter/src/adapters/vcp/client.js:233-305`

---

## 2. 实施原则

### 2.1 总体原则

- 不推翻现有运行时，新增一层 `ChannelHub`
- 先做“正式协议 + 正式状态模型”，再做更多平台
- 先保证钉钉迁移闭环，再复制到企业微信、飞书、QQ
- 先做可靠投递、会话绑定、审计，再做花哨富交互
- 默认不把高风险“个人微信”作为核心第一阶段能力

### 2.2 架构原则

- `ChannelHub` 只负责“通道接入、归一化、路由、投递、审计”
- `PluginManager` / `ChatCompletionHandler` 继续负责“AI 执行和工具编排”
- 外部平台差异收敛在 Adapter 层，不把平台逻辑污染到核心 runtime
- 富回复必须先表达成统一结构，再做平台能力降级
- B1 旧桥接接口保留兼容期，但不继续扩展新能力

### 2.3 迁移原则

- 先并行双栈，再逐个适配器迁移
- 所有迁移都必须可回滚
- 迁移期间保留 B1 到 B2 的兼容转换器
- 状态迁移优先保守，不做大规模破坏式重命名

---

## 3. 目标交付范围

## 3.1 核心交付

- 正式 `ChannelHub` 服务层
- 正式通道事件协议 `ChannelEventEnvelope`
- 正式运行时请求/响应协议
- 会话绑定、身份映射、去重、投递、审计五大持久层
- AdminPanel 频道中间层管理页
- B1 到 B2 兼容桥
- 钉钉适配器迁移到 B2
- 企业微信 / 飞书 / QQ 的接入规范和标准适配器骨架

## 3.2 暂不纳入第一阶段

- 个人微信自动化作为默认官方能力
- 自动执行 `npm install` / `pip install` 之类的远程安装动作
- 多租户 SaaS 化隔离
- 评分、评论、市场分发等插件生态功能
- 全平台“完全一致”的交互表现

---

## 4. 目标目录与模块拆分

建议新增如下目录结构：

```text
VCPToolBox/
|- modules/
|  `- channelHub/
|     |- ChannelHubService.js
|     |- AdapterRegistry.js
|     |- AdapterAuthManager.js
|     |- SignatureValidator.js
|     |- EventSchemaValidator.js
|     |- EventDeduplicator.js
|     |- MessageNormalizer.js
|     |- CapabilityRegistry.js
|     |- SessionBindingStore.js
|     |- IdentityMappingStore.js
|     |- AgentRoutingPolicy.js
|     |- RuntimeGateway.js
|     |- ReplyNormalizer.js
|     |- CapabilityDowngrader.js
|     |- DeliveryOutbox.js
|     |- MediaGateway.js
|     |- AuditLogger.js
|     |- MetricsCollector.js
|     |- StateStore.js
|     |- constants.js
|     `- schemas/
|        |- channel-event-envelope.schema.json
|        |- channel-runtime-request.schema.json
|        |- channel-runtime-reply.schema.json
|        |- channel-delivery-job.schema.json
|        `- channel-capability.schema.json
|- routes/
|  |- internal/
|  |  `- channelHub.js
|  `- admin/
|     `- channelHub.js
|- AdminPanel/
|  |- channel-hub.html
|  `- js/
|     |- channel-hub.js
|     |- channel-hub-adapters.js
|     |- channel-hub-sessions.js
|     |- channel-hub-outbox.js
|     `- channel-hub-audit.js
`- state/
   `- channelHub/
      |- adapters.json
      |- sessions.jsonl
      |- identity-map.json
      |- outbox.jsonl
      |- dedup-cache.json
      |- audit/
      |- media/
      `- tasks.jsonl
```

### 4.1 模块职责表

| 模块 | 职责 | 关键输入 | 关键输出 |
|------|------|----------|----------|
| `ChannelHubService.js` | 编排总入口 | 归一化事件 | 运行时结果、投递任务 |
| `AdapterRegistry.js` | 维护适配器定义和能力矩阵 | adapter 配置 | adapter 元数据 |
| `AdapterAuthManager.js` | 管理桥接密钥、来源白名单、启停状态 | headers、adapterId | 鉴权结果 |
| `SignatureValidator.js` | 平台签名校验 | timestamp、nonce、signature | 可信来源判断 |
| `EventSchemaValidator.js` | 校验事件协议 | ingress payload | 标准 Envelope |
| `EventDeduplicator.js` | 幂等去重 | eventId、messageId | 是否重复 |
| `MessageNormalizer.js` | 归一化文本/图片/文件/语音输入 | 平台消息 | 标准 message parts |
| `CapabilityRegistry.js` | 记录平台能力和限制 | adapterId | capability profile |
| `SessionBindingStore.js` | 绑定外部会话与 VCP 会话 | bindingKey、topicKey | session record |
| `IdentityMappingStore.js` | 绑定平台用户与 VCP 身份 | userId、corpId | identity record |
| `AgentRoutingPolicy.js` | 根据规则决定 agent / topic / model | normalized event | route decision |
| `RuntimeGateway.js` | 调 VCP 内部 runtime | runtime request | structured reply |
| `ReplyNormalizer.js` | 统一 runtime reply 格式 | runtime output | normalized reply |
| `CapabilityDowngrader.js` | 将富回复降级到平台支持范围 | reply + capability | deliverable payloads |
| `DeliveryOutbox.js` | 记录并执行投递任务 | delivery jobs | delivery result |
| `MediaGateway.js` | 媒体上传/下载/转存 | file/image/audio refs | platform-ready media refs |
| `AuditLogger.js` | 审计入站/出站/失败/重试 | events, jobs | audit records |
| `MetricsCollector.js` | 汇总延迟、成功率、队列积压 | all lifecycle events | metrics snapshot |
| `StateStore.js` | 统一状态文件访问 | file ops | state persistence |

---

## 5. 核心数据结构

## 5.1 入站事件协议 `ChannelEventEnvelope`

```json
{
  "version": "2.0",
  "eventId": "evt_xxx",
  "adapterId": "dingtalk-stream",
  "channel": "dingtalk",
  "eventType": "message.created",
  "occurredAt": 1760000000000,
  "requestId": "req_xxx",
  "target": {
    "agentId": "Nova",
    "itemType": "agent",
    "itemId": "Nova"
  },
  "client": {
    "clientType": "dingtalk",
    "conversationId": "cid_xxx",
    "conversationType": "group",
    "messageId": "msg_xxx",
    "messageThreadId": null
  },
  "sender": {
    "userId": "user_xxx",
    "nick": "Alice",
    "corpId": "corp_xxx",
    "isAdmin": false
  },
  "session": {
    "bindingKey": "dingtalk:group:cid:user",
    "externalSessionKey": "dingtalk:group:cid:user",
    "currentTopicId": null,
    "allowCreateTopic": true,
    "allowSwitchTopic": true
  },
  "payload": {
    "messages": [
      {
        "role": "user",
        "content": [
          { "type": "text", "text": "你好" },
          { "type": "image_url", "image_url": { "url": "https://..." } }
        ]
      }
    ]
  },
  "runtime": {
    "stream": false,
    "model": "Nova",
    "overrides": {
      "apiKey": "",
      "apiBase": "",
      "timeoutMs": 90000
    }
  },
  "metadata": {
    "platform": "dingtalk"
  }
}
```

### 5.1.1 必填字段

- `version`
- `eventId`
- `adapterId`
- `channel`
- `eventType`
- `occurredAt`
- `target.agentId`
- `client.messageId` 或 `eventId`
- `payload.messages`

### 5.1.2 幂等键建议

- 主键：`adapterId + eventId`
- 次键：`channel + client.conversationId + client.messageId`

## 5.2 运行时请求协议 `ChannelRuntimeRequest`

```json
{
  "agentId": "Nova",
  "messages": [
    { "role": "system", "content": "{{Nova}}" },
    { "role": "user", "content": [{ "type": "text", "text": "你好" }] }
  ],
  "externalSessionKey": "dingtalk:group:cid:user",
  "topic": {
    "bindingKey": "dingtalk:group:cid:user",
    "currentTopicId": null
  },
  "clientContext": {
    "platform": "dingtalk",
    "conversationId": "cid_xxx",
    "userId": "user_xxx"
  },
  "runtimeOverrides": {
    "apiKey": "",
    "apiBase": "",
    "model": "Nova",
    "timeoutMs": 90000
  }
}
```

## 5.3 运行时响应协议 `ChannelRuntimeReply`

```json
{
  "replyId": "reply_xxx",
  "messages": [
    {
      "role": "assistant",
      "content": [
        { "type": "text", "text": "这是文本回复" },
        { "type": "image_url", "image_url": { "url": "https://..." } },
        {
          "type": "action",
          "action": {
            "kind": "button_group",
            "items": [
              { "id": "retry", "label": "重试" }
            ]
          }
        }
      ]
    }
  ],
  "toolEvents": [],
  "topic": {
    "resolvedTopicId": "topic_xxx"
  },
  "usage": {
    "promptTokens": 100,
    "completionTokens": 80
  },
  "meta": {
    "agentId": "Nova",
    "model": "Nova"
  }
}
```

## 5.4 投递任务协议 `ChannelDeliveryJob`

```json
{
  "jobId": "job_xxx",
  "adapterId": "dingtalk-stream",
  "channel": "dingtalk",
  "requestId": "req_xxx",
  "target": {
    "conversationId": "cid_xxx"
  },
  "messages": [
    {
      "type": "text",
      "text": "这是降级后的钉钉文本"
    }
  ],
  "status": "pending",
  "attempt": 0,
  "nextRetryAt": null,
  "createdAt": 1760000000000
}
```

## 5.5 状态持久化模型

| 文件 | 内容 | 写入频率 | 保留策略 |
|------|------|----------|----------|
| `state/channelHub/adapters.json` | adapter 配置与启停状态 | 低 | 长期保留 |
| `state/channelHub/sessions.jsonl` | 外部会话到 topic/session 的绑定 | 中 | 长期保留 |
| `state/channelHub/identity-map.json` | 用户身份映射 | 中 | 长期保留 |
| `state/channelHub/outbox.jsonl` | 出站任务队列 | 高 | 保留最近 7-30 天 |
| `state/channelHub/dedup-cache.json` | 去重缓存 | 高 | TTL 清理 |
| `state/channelHub/tasks.jsonl` | 任务历史 | 中 | 保留最近 30-90 天 |
| `state/channelHub/audit/*.jsonl` | 审计日志 | 高 | 按天分桶，支持裁剪 |
| `state/channelHub/media/` | 临时媒体缓存 | 中高 | TTL 清理 |

---

## 6. 接口设计

## 6.1 内部接入接口

### 6.1.1 `POST /internal/channel-hub/events`

用途：

- 外部适配器统一入站
- 替代当前 `/internal/channel-ingest` 的正式 B2 协议入口

请求：

- body 使用 `ChannelEventEnvelope`
- headers 至少包含：
  - `x-channel-adapter-id`
  - `x-channel-signature` 或平台原生签名头
  - `x-channel-request-timestamp`

响应：

```json
{
  "ok": true,
  "requestId": "req_xxx",
  "reply": {
    "messages": [
      {
        "type": "text",
        "text": "你好"
      }
    ]
  },
  "delivery": {
    "mode": "sync",
    "jobs": []
  },
  "meta": {
    "agentId": "Nova",
    "topicId": "topic_xxx"
  }
}
```

### 6.1.2 `POST /internal/channel-hub/media/upload`

用途：

- 适配器上传媒体到 VCP 中间层
- 为后续 runtime 或其它平台复用媒体引用

### 6.1.3 `POST /internal/channel-hub/deliveries/:jobId/callback`

用途：

- 平台回执、卡片按钮回调、异步投递状态上报

## 6.2 管理接口

### 6.2.1 概览与监控

- `GET /admin_api/channel-hub/overview`
- `GET /admin_api/channel-hub/metrics`
- `GET /admin_api/channel-hub/platform-matrix`

### 6.2.2 适配器管理

- `GET /admin_api/channel-hub/adapters`
- `POST /admin_api/channel-hub/adapters`
- `PATCH /admin_api/channel-hub/adapters/:adapterId`
- `POST /admin_api/channel-hub/adapters/:adapterId/enable`
- `POST /admin_api/channel-hub/adapters/:adapterId/disable`
- `POST /admin_api/channel-hub/adapters/:adapterId/test-signature`

### 6.2.3 会话与身份

- `GET /admin_api/channel-hub/sessions`
- `GET /admin_api/channel-hub/sessions/:bindingKey`
- `POST /admin_api/channel-hub/sessions/rebind`
- `GET /admin_api/channel-hub/identities`
- `POST /admin_api/channel-hub/identities/link`

### 6.2.4 出站与重试

- `GET /admin_api/channel-hub/outbox`
- `GET /admin_api/channel-hub/outbox/:jobId`
- `POST /admin_api/channel-hub/outbox/:jobId/retry`
- `POST /admin_api/channel-hub/outbox/:jobId/cancel`
- `GET /admin_api/channel-hub/dead-letter`

### 6.2.5 审计与追踪

- `GET /admin_api/channel-hub/audit`
- `GET /admin_api/channel-hub/audit/:requestId`
- `GET /admin_api/channel-hub/traces/:requestId`

## 6.3 兼容接口

### 6.3.1 保留 `POST /internal/channel-ingest`

兼容策略：

- 作为 B1 旧接口继续存在
- 服务端内部立即转换成 `ChannelEventEnvelope`
- B1 只保证文本回复兼容，不再扩展媒体、动作卡片等新能力
- 所有新适配器禁止直接接 B1

---

## 7. 运行时集成策略

## 7.1 为什么不能继续直接复用旧桥接方式

当前 B1 做法是：

- 重写 `req.body`
- 覆盖 `res.write`、`res.json`、`res.end`
- 调 `chatCompletionHandler.handle()`
- 再从输出中提取 `replyText`

证据：`server.js:904-1021`

这条链路能打通原型，但不适合作为长期正式方案，原因是：

- 强耦合 HTTP 控制流
- 输出解析依赖 SSE/JSON 的二次提取
- 无法干净承载富媒体和动作回复
- 不利于审计、重试和多阶段投递

## 7.2 目标集成方式

建议新增 `RuntimeGateway`，把“面向通道的请求”转换成“面向内部 runtime 的标准请求”。

目标调用方式：

1. `ChannelHubService` 接收标准 Envelope
2. `SessionBindingStore` 解析或创建绑定
3. `AgentRoutingPolicy` 解析 agent / topic / model
4. `RuntimeGateway` 构造 `ChannelRuntimeRequest`
5. `RuntimeGateway` 调内部 runtime
6. `ReplyNormalizer` 统一格式
7. `CapabilityDowngrader` 生成平台可投递消息
8. `DeliveryOutbox` 同步返回或异步投递

## 7.3 RuntimeGateway 的三阶段演进

### 阶段 A

- 仍然可临时调用现有 `chatCompletionHandler.handle()`
- 但封装在 `RuntimeGateway` 里
- 从路由层移除 req/res 改写逻辑

### 阶段 B

- 抽出内部 `handleChannelRequest()` 风格的无 HTTP 入口
- 输入是 plain object，输出是 structured reply

### 阶段 C

- 将通道 runtime 与 OpenAI 兼容 HTTP runtime 完全解耦

---

## 8. 平台适配器策略

## 8.1 平台分层

| 平台 | 推荐接入方式 | 风险级别 | 优先级 | 说明 |
|------|--------------|----------|--------|------|
| 钉钉 | 官方 Stream / 机器人事件流 | 中 | P0 | 已有适配器样板，最适合先标准化 |
| 企业微信 | 官方回调 + 应用消息 | 中 | P1 | 企业场景强，卡片和媒体能力明确 |
| 飞书 | 官方事件订阅 + 卡片 | 中 | P1 | 协议规范完整，适合复制钉钉经验 |
| QQ | OneBot / NapCat / LLOneBot 桥接 | 中高 | P2 | 更建议走桥接协议，不建议直绑多套实现 |
| 微信公众号/客服 | 官方回调 + 模板/客服消息 | 中 | P2 | 适合作为官方微信入口 |
| 个人微信 | 非官方自动化适配器 | 高 | P3 | 高风控，建议隔离为实验性接入 |

## 8.2 平台能力矩阵最小模型

所有适配器都必须声明：

- `supportsText`
- `supportsImage`
- `supportsFile`
- `supportsAudio`
- `supportsCard`
- `supportsActionCallback`
- `supportsThread`
- `supportsMention`
- `supportsProactivePush`
- `maxMessageLength`
- `mediaUploadMode`

## 8.3 推荐接入顺序

1. 标准化钉钉适配器
2. 做企业微信适配器
3. 做飞书适配器
4. 做 QQ OneBot 适配器
5. 做官方微信适配器
6. 个人微信单独隔离成实验模块

---

## 9. AdminPanel 页面规划

建议新增一组频道中间层运维页。

## 9.1 页面清单

| 页面 | 路径建议 | 功能 |
|------|----------|------|
| 频道总览 | `/AdminPanel/channel-hub.html` | 总体健康状态、吞吐、失败率、积压 |
| 适配器管理 | 同页 tab 1 | 启停、签名测试、能力声明 |
| 会话映射 | 同页 tab 2 | 查找 bindingKey、topic、agent 路由 |
| 出站队列 | 同页 tab 3 | 查看重试、死信、手工补发 |
| 审计追踪 | 同页 tab 4 | requestId 级别全链路追踪 |
| 平台矩阵 | 同页 tab 5 | 对比各平台能力与降级规则 |

## 9.2 前端模块拆分

| 文件 | 职责 |
|------|------|
| `AdminPanel/js/channel-hub.js` | 总入口、tab 调度、概览加载 |
| `AdminPanel/js/channel-hub-adapters.js` | adapter CRUD、签名测试 |
| `AdminPanel/js/channel-hub-sessions.js` | session / identity 查询与重绑 |
| `AdminPanel/js/channel-hub-outbox.js` | 出站队列、重试、取消、死信查看 |
| `AdminPanel/js/channel-hub-audit.js` | 审计查询、trace 渲染 |

---

## 10. 分阶段实施计划

## 10.1 Phase 0: 协议冻结与现状盘点

目标：

- 冻结 B2 协议和状态模型
- 冻结 B1 兼容边界

任务：

- 定稿 `ChannelEventEnvelope`
- 定稿 `ChannelRuntimeReply`
- 定稿 `ChannelDeliveryJob`
- 定稿平台能力矩阵字段
- 盘点当前 B1 使用方
- 给现有 `/internal/channel-ingest` 加入基础调用埋点方案

产出：

- schema 文件
- adapter 能力清单
- B1 使用方列表

验收：

- 所有既有适配器都能映射到 B2 字段
- B1 与 B2 字段映射表完成

## 10.2 Phase 1: ChannelHub 核心骨架

目标：

- 建立独立的中间层核心

任务：

- 创建 `modules/channelHub/`
- 实现 `StateStore`
- 实现 `AdapterRegistry`
- 实现 `AdapterAuthManager`
- 实现 `EventSchemaValidator`
- 实现 `EventDeduplicator`
- 实现 `AuditLogger`

产出：

- 可接收事件但尚未接 runtime 的骨架

验收：

- 能存储 adapter 配置
- 能对同一事件做去重
- 能产生日志和审计记录

## 10.3 Phase 2: RuntimeGateway 与同步文本闭环

目标：

- 打通从 B2 到 runtime 的最小闭环

任务：

- 实现 `SessionBindingStore`
- 实现 `AgentRoutingPolicy`
- 实现 `RuntimeGateway`
- 实现 `ReplyNormalizer`
- 保持只支持文本回复

产出：

- `POST /internal/channel-hub/events`
- 可从标准事件得到标准文本回复

验收：

- 单聊、群聊文本事件可完成收发
- 不再在路由层直接伪造 req/res

## 10.4 Phase 3: 富回复、能力降级与出站队列

目标：

- 让中间层正式具备多平台差异处理能力

任务：

- 实现 `CapabilityRegistry`
- 实现 `CapabilityDowngrader`
- 实现 `DeliveryOutbox`
- 实现 `MediaGateway`
- 实现死信和重试

产出：

- 图片、文件、按钮组等统一回复模型
- 平台降级规则
- 出站任务状态查询

验收：

- 不同平台能根据能力矩阵收到不同形态但语义一致的回复
- 失败投递可重试

## 10.5 Phase 4: AdminPanel 运维面板

目标：

- 运维、排障、观测能力上线

任务：

- 实现概览页
- 实现会话映射查询
- 实现出站队列管理
- 实现审计追踪页

验收：

- 能按 `requestId` 查询完整链路
- 能手工重试死信任务

## 10.6 Phase 5: 钉钉适配器迁移

目标：

- 把已有钉钉能力从样板升级为正式标准适配器

任务：

- 将 `vcp-dingtalk-adapter` 改成发送 B2 Envelope
- 验证 topic binding 映射
- 验证文本、图片、文件、语音输入
- 验证按钮/卡片降级策略

证据基线：

- 当前钉钉适配器已发结构化 payload。证据：`Plugin/vcp-dingtalk-adapter/src/adapters/vcp/client.js:233-305`
- 当前 README 已包含 topic binding 和媒体接收思路。证据：`Plugin/vcp-dingtalk-adapter/README.md:21`、`Plugin/vcp-dingtalk-adapter/README.md:44-45`、`Plugin/vcp-dingtalk-adapter/README.md:353-376`

验收：

- 钉钉适配器优先走 B2
- B1 仅留兼容模式

## 10.7 Phase 6: 企业微信 / 飞书接入

目标：

- 把标准适配器模式复制到企业平台

任务：

- 实现签名校验器
- 适配企业微信回调模型
- 适配飞书事件订阅和卡片回复

验收：

- 企业微信和飞书最小文本闭环上线
- 能复用相同的 session / outbox / audit 体系

## 10.8 Phase 7: QQ / 微信接入

目标：

- 覆盖更多外部 IM 端

任务：

- QQ 优先对接 OneBot 类协议
- 微信优先对接官方公众号/客服通道
- 个人微信隔离到实验性 adapter

验收：

- QQ / 微信都不新增核心层特化逻辑
- 仅通过能力矩阵和 adapter 差异实现接入

---

## 11. 详细迁移方案

## 11.1 当前基线

当前线上桥接能力存在以下事实：

- 路由入口是 `/internal/channel-ingest`。证据：`server.js:904`
- 鉴权使用 `x-channel-bridge-key` 与全局 `Key`。证据：`server.js:931`
- 内部通过 `syntheticMessages` 拼接系统消息。证据：`server.js:966-975`
- 回复被压缩成 `replyText`。证据：`server.js:964-1007`
- 钉钉端已经在发送比 B1 更丰富的结构。证据：`Plugin/vcp-dingtalk-adapter/src/adapters/vcp/client.js:233-305`

这说明迁移重点不是“有没有入口”，而是“把临时桥接升级成正式平台能力”。

## 11.2 B1 到 B2 字段映射

| B1 字段 | B2 字段 | 备注 |
|--------|--------|------|
| `agentId` | `target.agentId` | 保持语义一致 |
| `agentName` | `metadata.agentName` | 展示字段 |
| `requestId` | `requestId` | 可直接沿用 |
| `channel` | `channel` | 可直接沿用 |
| `client.*` | `client.*` | 基本一致 |
| `sender.*` | `sender.*` | 基本一致 |
| `topicControl.bindingKey` | `session.bindingKey` | 归到 session 语义 |
| `topicControl.currentTopicId` | `session.currentTopicId` | 归到 session 语义 |
| `messages` | `payload.messages` | 收敛到 payload |
| `modelConfig.*` | `runtime.*` | 归到 runtime 语义 |
| `vcpConfig.runtimeOverrides` | `runtime.overrides` | 明确命名 |
| `reply.text` | `reply.messages[].text` | B2 改为结构化回复 |

## 11.3 迁移阶段

### M0: 兼容冻结

- 冻结 B1 协议
- 给 B1 加 usage 统计和来源标识
- 在日志中标记所有旧调用方

### M1: 引入 B2 并行入口

- 新增 `POST /internal/channel-hub/events`
- 新增 `B1CompatTranslator`
- 所有 B1 请求在服务端内部先转成 B2 Envelope

### M2: 钉钉优先迁移

- 钉钉适配器先支持配置切换：
  - `bridgeVersion=b1`
  - `bridgeVersion=b2`
- 默认灰度走 B2
- 失败时自动回退 B1

### M3: 中间层状态接管

- topic binding 从 adapter 私有逻辑逐步转到 `SessionBindingStore`
- request tracing 从 adapter 日志转到 `AuditLogger`
- 去重和 outbox 从 adapter 内部逻辑转到核心层

### M4: 新平台全部要求 B2

- 企业微信、飞书、QQ 的新适配器一律不接 B1
- B1 只保留钉钉兼容和紧急回滚通道

### M5: B1 退役准备

- 当 B1 流量低于阈值时，进入只读兼容期
- 文档标记废弃
- 最终将 B1 下沉为兼容插件，而不是核心入口

## 11.4 数据迁移策略

### 会话绑定迁移

- 不批量改写历史 topic 文件
- 采用“首次命中即写入新绑定记录”的懒迁移
- adapter 已带 `bindingKey` 的，直接写入 `sessions.jsonl`

### 身份映射迁移

- 先只记录平台用户主键
- 第二阶段再引入跨平台合并身份

### 出站任务迁移

- 新 outbox 与旧 adapter 内部投递逻辑并行一段时间
- 灰度阶段只对 B2 请求写 outbox

## 11.5 回滚策略

回滚触发条件：

- B2 文本回复成功率显著低于 B1
- topic binding 出现错绑
- 平台媒体投递失败率过高
- 审计发现重复回复或漏回

回滚动作：

- adapter 配置切回 B1
- 禁用 `ChannelHub` 新出站队列
- 保留状态文件，不删除迁移数据
- 保留审计日志用于复盘

回滚要求：

- 任何阶段都不能要求删除历史 topic 或 binding 数据
- 回滚必须只涉及配置切换和入口切换

---

## 12. 关键补强项清单

必须补强的能力如下：

1. 独立 adapter 密钥与白名单
2. 平台签名校验器
3. 正式 Session / Topic 绑定存储
4. 身份映射存储
5. 富回复结构和降级器
6. 媒体网关
7. 出站队列和死信
8. requestId 级别审计追踪
9. AdminPanel 运维面板
10. B1 兼容转换器

---

## 13. 里程碑与验收口径

## 13.1 Milestone A: B2 文本闭环

完成标准：

- `ChannelHub` 核心骨架完成
- B2 事件可完成文本收发
- 钉钉 adapter 可灰度切 B2

## 13.2 Milestone B: 富回复与运维闭环

完成标准：

- 图片/文件/按钮组可统一表达
- 能力降级规则可生效
- 出站队列与死信可观测、可重试

## 13.3 Milestone C: 多平台复制

完成标准：

- 企业微信、飞书至少一个完成接入
- QQ 或官方微信至少一个完成接入
- 核心层无新增平台特化分支膨胀

---

## 14. 推荐开发顺序

如果按最稳妥的方式落地，建议顺序如下：

1. `StateStore`
2. `AdapterRegistry`
3. `AdapterAuthManager`
4. `EventSchemaValidator`
5. `SessionBindingStore`
6. `RuntimeGateway`
7. `ReplyNormalizer`
8. `DeliveryOutbox`
9. `AuditLogger`
10. AdminPanel 页面
11. 钉钉迁移
12. 企业微信 / 飞书 / QQ 复制

这个顺序的核心原因是：

- 先把“状态”和“协议”定稳
- 再把“运行时调用”定稳
- 最后再做“平台复制”

---

## 15. 最终建议

最好的进化方向不是“给每个平台各写一套桥接逻辑”，而是：

- 让 VCPToolBox 从“AI 工具中间层”进化为“统一多端接入中台”
- 用 `ChannelHub` 承接所有外部平台差异
- 用统一 session、identity、reply、outbox、audit 体系固化中台能力
- 用钉钉完成第一条标准化迁移链路，再复制到企业微信、飞书、QQ、微信

一句话总结：

**不是继续堆 adapter，而是先把 VCPToolBox 做成真正的 ChannelHub。**
