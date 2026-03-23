# VCP 交互中间层核心 Schema

**版本：** Draft 1.0  
**创建日期：** 2026-03-23  
**关联文档：**

- `docs/interaction-middleware/VCP_INTERACTION_MIDDLEWARE_TARGET.md`
- `docs/interaction-middleware/CHANNEL_MIDDLEWARE_DESIGN.md`
- `docs/interaction-middleware/CHANNEL_MIDDLEWARE_IMPLEMENTATION_PLAN.md`

---

## 1. 文档目的

本文档用于把 `docs/interaction-middleware/VCP_INTERACTION_MIDDLEWARE_TARGET.md` 里的目标架构收敛成可执行契约。

它不讨论页面、不讨论部署，也不讨论单个平台细节。

它只回答一件事：

**VCP 交互中间层内部应该稳定使用哪些核心对象，以及这些对象至少应该长什么样。**

本文档定义五类核心 schema：

1. `Event`
2. `SessionDescriptor`
3. `NormalizedReply`
4. `DeliveryJob`
5. `AdapterContract`

---

## 2. 设计原则

### 2.1 核心链路只使用标准对象

平台原始 payload、SDK 对象、HTTP request、WebSocket message，都不应在核心链路中长期流动。

一旦进入中间层，就应尽快转换为标准对象。

### 2.2 Schema 先稳定，字段再扩展

长期维护中最容易失控的不是代码，而是字段语义漂移。

因此 schema 应优先保证：

- 名称稳定
- 语义清晰
- 分层合理
- 兼容扩展

### 2.3 平台字段必须隔离在 metadata

中间层主字段应尽量平台无关。

任何平台特有内容应放入：

- `metadata`
- `platformData`
- `raw`

而不是污染核心字段。

---

## 3. Event

### 3.1 作用

`Event` 是一切入站交互在 VCP 内部的统一表达。

所有上游输入都应该先转换为 Event，再进入：

- 去重
- Session 解析
- Route / Policy
- Execution
- Reply
- Delivery

### 3.2 最小结构

```json
{
  "version": "2.0",
  "eventId": "evt_123",
  "requestId": "req_123",
  "adapterId": "onebot-qq-main",
  "channel": "qq",
  "eventType": "message.created",
  "occurredAt": 1711111111111,
  "traceId": "trace_123",
  "sender": {},
  "client": {},
  "session": {},
  "payload": {},
  "target": {},
  "runtime": {},
  "metadata": {}
}
```

### 3.3 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `version` | `string` | 是 | Event schema 版本 |
| `eventId` | `string` | 是 | 全局唯一事件 ID |
| `requestId` | `string` | 是 | 同一请求链路 ID |
| `adapterId` | `string` | 是 | 入站适配器 ID |
| `channel` | `string` | 是 | 平台类型，例如 `qq` / `dingtalk` |
| `eventType` | `string` | 是 | 标准事件类型 |
| `occurredAt` | `number` | 是 | 事件发生时间戳 |
| `traceId` | `string` | 否 | 链路追踪 ID |
| `sender` | `object` | 是 | 发送方信息 |
| `client` | `object` | 是 | 会话客户端上下文 |
| `session` | `object` | 是 | 会话解析上下文 |
| `payload` | `object` | 是 | 归一化消息内容 |
| `target` | `object` | 否 | 显式指定目标 |
| `runtime` | `object` | 否 | 运行时偏好 |
| `metadata` | `object` | 否 | 平台原始附加信息 |

### 3.4 sender

```json
{
  "userId": "123456",
  "nick": "Alice",
  "displayName": "Alice",
  "isAdmin": false,
  "roles": ["member"],
  "tenantId": null,
  "organizationId": null
}
```

说明：

- `userId` 是中间层使用的发送者 ID
- 平台原始 ID 可以保留在 `metadata.platformData.sender`

### 3.5 client

```json
{
  "clientType": "qq",
  "conversationId": "group_987654",
  "conversationType": "group",
  "messageId": "13579",
  "messageThreadId": null,
  "replyToMessageId": null
}
```

说明：

- `conversationId` 表示平台上的会话对象
- `conversationType` 推荐值：
  - `private`
  - `group`
  - `channel`
  - `thread`
  - `system`

### 3.6 session

```json
{
  "externalSessionKey": "onebot:group:987654",
  "bindingKey": "qq:group:987654:123456",
  "currentTopicId": null,
  "allowCreateTopic": true,
  "allowSwitchTopic": true
}
```

说明：

- `externalSessionKey` 只表达平台事实
- `bindingKey` 承载 VCP 内部绑定语义

### 3.7 payload

```json
{
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "你好"
        }
      ]
    }
  ]
}
```

### 3.8 target

```json
{
  "itemType": "agent",
  "itemId": "Nova",
  "agentId": "Nova"
}
```

说明：

- `target` 是显式目标
- 若为空，则交给 route / policy 层解析

### 3.9 runtime

```json
{
  "stream": false,
  "model": null,
  "timeoutMs": 120000,
  "overrides": {}
}
```

### 3.10 metadata

```json
{
  "platformData": {},
  "raw": {},
  "sourceIp": "127.0.0.1"
}
```

说明：

- 一切平台私有字段尽量只放这里

---

## 4. SessionDescriptor

### 4.1 作用

`SessionDescriptor` 是中间层对一个“已解析会话”的标准表达。

它是 `Event.session` 的扩展结果，也是：

- Route
- Execution
- Delivery

共享的上下文对象。

### 4.2 最小结构

```json
{
  "bindingKey": "qq:group:987654:123456",
  "externalSessionKey": "onebot:group:987654",
  "adapterId": "onebot-qq-main",
  "channel": "qq",
  "conversationId": "group_987654",
  "conversationType": "group",
  "userId": "123456",
  "topicId": null,
  "agentId": "Nova",
  "identityId": null,
  "createdAt": 1711111111111,
  "updatedAt": 1711111111111,
  "lastActiveAt": 1711111111111,
  "deleted": false
}
```

### 4.3 关键原则

1. `externalSessionKey` 必须稳定，不能混入业务语义。
2. `bindingKey` 才允许绑定 Agent、Topic、Identity。
3. `SessionDescriptor` 必须可持久化、可重建、可审计。

---

## 5. NormalizedReply

### 5.1 作用

`NormalizedReply` 是 Execution 层产出的统一回复格式。

一旦形成，就不应再带平台判断。

后续平台只做：

- 编码
- 降级
- 投递

### 5.2 最小结构

```json
{
  "replyId": "reply_123",
  "requestId": "req_123",
  "messages": [
    {
      "role": "assistant",
      "content": [
        {
          "type": "text",
          "text": "你好，我在。"
        }
      ]
    }
  ],
  "toolEvents": [],
  "topic": {
    "resolvedTopicId": null
  },
  "usage": {
    "promptTokens": 0,
    "completionTokens": 0
  },
  "meta": {
    "agentId": "Nova",
    "sessionKey": "qq:group:987654:123456",
    "normalizedAt": 1711111111111,
    "format": "structured"
  }
}
```

### 5.3 content part 类型

推荐支持以下标准类型：

- `text`
- `image_url`
- `audio_url`
- `video_url`
- `file`
- `action`
- `card`

### 5.4 text

```json
{
  "type": "text",
  "text": "你好"
}
```

### 5.5 image_url

```json
{
  "type": "image_url",
  "image_url": {
    "url": "https://example.com/a.png",
    "fileName": "a.png"
  }
}
```

### 5.6 action

```json
{
  "type": "action",
  "action": {
    "name": "open_url",
    "label": "查看详情",
    "url": "https://example.com"
  }
}
```

### 5.7 card

```json
{
  "type": "card",
  "card": {
    "title": "任务结果",
    "summary": "执行完成",
    "sections": []
  }
}
```

说明：

- 平台是否支持 `action/card` 不由 Reply 决定
- 是否降级由 Delivery 层和 capabilities 决定

---

## 6. DeliveryJob

### 6.1 作用

`DeliveryJob` 是一切出站动作的统一任务对象。

任何回复、通知、补发、重试，都应先变成 DeliveryJob。

### 6.2 最小结构

```json
{
  "jobId": "job_123",
  "requestId": "req_123",
  "replyId": "reply_123",
  "adapterId": "onebot-qq-main",
  "channel": "qq",
  "session": {
    "bindingKey": "qq:group:987654:123456",
    "externalSessionKey": "onebot:group:987654"
  },
  "payload": {
    "messages": []
  },
  "status": "pending",
  "attempts": 0,
  "maxAttempts": 3,
  "priority": "normal",
  "createdAt": 1711111111111,
  "updatedAt": 1711111111111,
  "lastError": null
}
```

### 6.3 status 推荐值

- `pending`
- `processing`
- `sent`
- `failed`
- `dead_letter`
- `cancelled`

### 6.4 关键原则

1. Delivery 必须可重试。
2. Delivery 必须可审计。
3. Delivery 必须支持能力降级。
4. Delivery 不应依赖内存态原始 event。

---

## 7. AdapterContract

### 7.1 作用

`AdapterContract` 定义平台适配器必须提供的稳定接口。

VCP 核心层只依赖契约，不依赖平台实现细节。

### 7.2 元信息

```json
{
  "id": "onebot-qq-main",
  "channel": "qq",
  "displayName": "QQ OneBot 主适配器",
  "transportMode": "forward_ws",
  "sessionGrammar": "onebot:{conversationType}:{conversationId}",
  "capabilities": {}
}
```

### 7.3 transportMode 推荐值

- `forward_ws`
- `reverse_ws`
- `http_webhook`
- `polling`
- `internal`

### 7.4 capabilities 结构

```json
{
  "text": true,
  "image": true,
  "audio": true,
  "video": true,
  "file": true,
  "card": false,
  "action": false,
  "quoteReply": true,
  "forwardMessage": true,
  "streaming": false,
  "groupChat": true,
  "privateChat": true,
  "thread": false,
  "proactivePush": true
}
```

### 7.5 必备接口

#### `authenticate(requestContext)`

用途：

- adapter 级鉴权
- bridge key / token / IP 白名单校验

#### `verifySignature(requestContext)`

用途：

- 平台签名验证
- 时间戳、nonce、防重放

#### `decodeInbound(rawPayload, context) -> Event`

用途：

- 平台原始 payload -> 标准 Event

#### `encodeOutbound(reply, context) -> PlatformMessage[]`

用途：

- 标准 Reply -> 平台原生消息数组

#### `sendBySession(sessionDescriptor, platformMessages, context)`

用途：

- 将已编码平台消息投递给目标会话

#### `healthCheck()`

用途：

- 返回 adapter 当前健康状态

#### `getCapabilities()`

用途：

- 返回平台能力声明

---

## 8. EventType 推荐值

为避免事件语义漂移，建议统一命名风格。

推荐值：

- `message.created`
- `message.updated`
- `message.deleted`
- `reaction.created`
- `reaction.deleted`
- `member.joined`
- `member.left`
- `member.updated`
- `conversation.created`
- `conversation.updated`
- `system.notification`
- `callback.action`

说明：

- 中间层只保留对核心流程有价值的标准事件
- 过于平台私有的事件放入 `metadata.platformData`

---

## 9. Session Grammar 推荐值

### 9.1 原则

平台原生会话键应简洁、稳定、可重建。

推荐语法：

```text
{platform}:{conversationType}:{conversationId}
```

示例：

- `onebot:private:123456`
- `onebot:group:987654`
- `dingtalk:private:staff_abc123`
- `dingtalk:group:cidXXXX`

### 9.2 不推荐做法

不推荐把以下信息直接混入 `externalSessionKey`：

- `agentId`
- `topicId`
- `binding policy`
- `route rule`
- `messageId`

这些应保留在 binding 和 session record 层。

---

## 10. 兼容策略

### 10.1 B1 / B2 兼容

在过渡阶段允许：

- B1 输入翻译成标准 Event
- 标准 Reply 再翻译回 B1 reply

但翻译层必须位于 schema 边界之外，不应污染核心 schema。

### 10.2 平台私有字段兼容

平台私有字段只允许：

- 放入 `metadata.platformData`
- 通过 adapter codec 消费

不应在 core service 中直接读取。

---

## 11. 落地顺序建议

按落地优先级，建议先稳定以下三件事：

1. `Event`
2. `NormalizedReply`
3. `AdapterContract`

然后再稳定：

4. `SessionDescriptor`
5. `DeliveryJob`

因为前 3 项决定主链路是否解耦，后 2 项决定系统是否可运维。

---

## 12. 最终目标

当这份 schema 真正稳定下来后，VCP 的核心层应达到以下状态：

1. 上游平台差异只存在于 adapter codec。
2. 核心服务只接收标准 Event。
3. 执行层只产出标准 Reply。
4. 出站层只处理 DeliveryJob。
5. 新平台接入只扩边缘，不改主链。

如果这五点成立，VCP 才算真正从“桥接实现”走向“交互中间层”。
