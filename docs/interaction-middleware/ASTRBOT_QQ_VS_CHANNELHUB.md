# AstrBot QQ 架构与 VCP ChannelHub 对照分析

## 目的

本文基于 `A:\VCP\PORJ\AstrBot-master` 的实际源码，对 AstrBot 的 QQ 接入架构进行拆解，并与当前 VCPToolBox 的 `ChannelHub + vcp-onebot-adapter` 方案做逐项对照。

目标不是复刻 AstrBot，而是回答三个问题：

1. AstrBot 的 QQ 架构到底是什么。
2. 我们当前方案和它哪些相同，哪些本质不同。
3. 后续 VCP 应该吸收哪些设计，避免哪些错误迁移。

---

## 一句话结论

AstrBot 的 QQ 接入是成熟的 `平台抽象 + 平台管理器 + 会话模型 + OneBot 消息段编解码` 架构；VCP 当前则是 `OneBot 传输适配器 + ChannelHub 编排服务 + 绑定存储 + 统一回复归一化` 架构。

两者方向相近，但切分点不同：

- AstrBot 把“平台”作为一等抽象。
- VCP 把“渠道中间层”作为一等抽象。

因此，VCP 最适合借鉴 AstrBot 的会话模型、消息编解码边界和平台注册思想，不适合直接照搬其 Python 运行时和反向 WebSocket 拓扑。

---

## 核心对照表

| 维度 | AstrBot | VCPToolBox | 结论 |
|------|---------|------------|------|
| 顶层抽象 | `Platform` 基类统一平台运行、状态、错误、按会话发送、事件提交 | `ChannelHubService` 统一入站、路由、运行时、回复归一化、出站投递 | VCP 更偏“中间层编排”，AstrBot 更偏“平台驱动” |
| 平台装载 | `PlatformManager` 按配置动态加载 `aiocqhttp/dingtalk/lark/...` | `ChannelHubService` 初始化各模块，适配器由 `AdapterRegistry` 管理 | 两者都支持多平台，但 VCP 的适配器管理与业务编排分离 |
| QQ 接入方式 | OneBot v11 反向 WebSocket，AstrBot 做服务端 | OneBot 前向 WebSocket 客户端，适配器主动连协议端 | 这是两者最关键的拓扑差异 |
| 入站事件模型 | `request/notice/group/private` 先转 AstrBot 统一消息对象 | OneBot 事件先转 `ChannelEventEnvelope`，再进入 ChannelHub | 两者都先做协议解耦再进主链 |
| 会话标识 | `platform_id:message_type:session_id` | 当前 QQ 侧常用 `qq:group:{groupId}:{userId}` / `qq:private:{userId}` | AstrBot 的 session 语义更简洁稳定，VCP 仍可优化 |
| 消息归一化 | `MessageChain` 与 OneBot 段双向转换，支持图片、文件、合并转发等 | `channelClient` 负责 OneBot -> content parts，`ReplyNormalizer` 负责 runtime reply -> 标准 reply | VCP 已有雏形，但“协议编解码层”还不够独立 |
| 出站发送 | 平台适配器直接 `send_by_session`，底层调用 OneBot API | `DeliveryOutbox` 出站，再由适配器能力降级与实际发送 | VCP 的出站治理更完整，但协议层可继续收紧 |
| 运维视角 | 平台自身状态和错误统计 | AdminPanel + metrics + audit + outbox | VCP 的管理面更强，AstrBot 的平台抽象更干净 |

---

## AstrBot 的实际架构

### 1. 它确实有平台基类，不是把 QQ 逻辑散落在业务层

AstrBot 的平台统一抽象在：

- `A:\VCP\PORJ\AstrBot-master\astrbot\core\platform\platform.py`

关键职责：

- 维护平台运行状态和错误列表
- 提供 `run()` 生命周期入口
- 提供 `send_by_session()` 抽象
- 提供 `commit_event()` 统一提交事件
- 预留统一 `webhook_callback()` 能力

对应证据：

- `platform.py:33` 定义 `Platform`
- `platform.py:85` 定义 `get_stats()`
- `platform.py:127` 定义 `send_by_session()`
- `platform.py:136` 定义 `commit_event()`

这说明 AstrBot 的“平台”不是简单 transport client，而是一个完整运行单元。

### 2. 它有专门的平台管理器负责动态加载

平台装载逻辑在：

- `A:\VCP\PORJ\AstrBot-master\astrbot\core\platform\manager.py`

这里会按配置动态 import 对应适配器，例如：

- `aiocqhttp`
- `qq_official`
- `qq_official_webhook`
- `dingtalk`
- `lark`

对应证据：

- `manager.py:93` 开始按 `platform_config["type"]` 装载
- `manager.py:129` 装载 `aiocqhttp`

这点比我们当前 `onebot-adapter` 更“平台中心化”。

### 3. QQ 个人号接入核心是 aiocqhttp 适配器

QQ OneBot 适配器在：

- `A:\VCP\PORJ\AstrBot-master\astrbot\core\platform\sources\aiocqhttp\aiocqhttp_platform_adapter.py`

它做了三件事：

1. 注册为平台适配器
2. 启动 `CQHttp`
3. 监听 OneBot 的 request/notice/message 事件并转成统一消息对象

对应证据：

- `aiocqhttp_platform_adapter.py:30` 注册 `aiocqhttp`
- `aiocqhttp_platform_adapter.py:55` 创建 `CQHttp`
- `aiocqhttp_platform_adapter.py:64` 注册 request handler
- `aiocqhttp_platform_adapter.py:75` 注册 notice handler
- `aiocqhttp_platform_adapter.py:85` 注册 group message handler
- `aiocqhttp_platform_adapter.py:95` 注册 private message handler

### 4. AstrBot 的 QQ 接入是反向 WebSocket，不是前向 WS

这是判断是否“照搬可行”的关键。

在 AstrBot 中：

- `ws_reverse_host`、`ws_reverse_port`、`ws_reverse_token` 是 QQ 平台配置核心字段
- `CQHttp(use_ws_reverse=True)` 说明 AstrBot 作为 WebSocket 服务端

对应证据：

- `aiocqhttp_platform_adapter.py:45` 读取 `ws_reverse_host`
- `aiocqhttp_platform_adapter.py:46` 读取 `ws_reverse_port`
- `aiocqhttp_platform_adapter.py:56` `use_ws_reverse=True`
- `A:\VCP\PORJ\AstrBot-master\docs\zh\platform\aiocqhttp.md` 明确写 AstrBot 支持 OneBot v11 反向 WebSocket

这与我们当前实现不同，不能直接把 AstrBot QQ 适配器设计原封不动搬进 VCP。

### 5. AstrBot 的消息段编解码层是独立存在的

消息发送和 OneBot 段转换在：

- `A:\VCP\PORJ\AstrBot-master\astrbot\core\platform\sources\aiocqhttp\aiocqhttp_message_event.py`

已确认能力包括：

- 文本
- `At`
- 图片
- 语音
- 视频
- 文件
- `Node/Nodes` 合并转发

对应证据：

- `aiocqhttp_message_event.py:35` segment -> dict
- `aiocqhttp_message_event.py:68` `MessageChain` -> OneBot JSON
- `aiocqhttp_message_event.py:100` `send_group_msg`
- `aiocqhttp_message_event.py:102` `send_private_msg`
- `aiocqhttp_message_event.py:145` `send_group_forward_msg`
- `aiocqhttp_message_event.py:148` `send_private_forward_msg`

这一层是 AstrBot 最值得参考的部分之一。

### 6. AstrBot 的会话模型是清晰且可持久化的

会话模型在：

- `A:\VCP\PORJ\AstrBot-master\astrbot\core\platform\message_session.py`

格式：

- `platform_id:message_type:session_id`

对应证据：

- `message_session.py:7` 定义 `MessageSession`
- `message_session.py:17` `__str__()` 输出该格式
- `message_session.py:24` `from_str()` 解析该格式

这让“按会话主动发消息”成为自然能力，而不依赖保留原始事件对象。

---

## VCP 当前架构

### 1. VCP 的顶层核心不是 Platform，而是 ChannelHub

主编排服务在：

- `A:\VCP\VCPToolBox\modules\channelHub\ChannelHubService.js`

其入站链路已经明确写出：

- AdapterAuth
- B1CompatTranslator
- EventSchemaValidator
- EventDeduplicator
- MessageNormalizer
- SessionBindingStore
- AgentRoutingPolicy
- RuntimeGateway
- ReplyNormalizer
- DeliveryOutbox

对应证据：

- `ChannelHubService.js:9-15` 注释中定义 inbound/outbound pipeline
- `ChannelHubService.js:46` 定义 `ChannelHubService`
- `ChannelHubService.js:178` 起开始初始化基础设施

这说明我们当前架构的中心是“渠道中间层编排”，不是“单个平台运行时”。

### 2. QQ 适配器当前是 OneBot 前向 WebSocket 客户端

OneBot 连接逻辑在：

- `A:\VCP\VCPToolBox\Plugin\vcp-onebot-adapter\src\adapters\onebot\client.js`

它当前的行为是：

- 使用 `wsUrl` 主动连接协议端
- 收消息时分发 `message/notice/request`
- 通过 `callApi()` 调用 OneBot API

对应证据：

- `client.js:24` `createOneBotClient`
- `client.js:171` `Connecting to: wsUrl`
- `client.js:173` `new WebSocket(wsUrl, { headers })`
- `client.js:115` 收到 `post_type === 'message'`

这与 AstrBot 的 `use_ws_reverse=True` 是两种不同部署拓扑。

### 3. VCP 已经有 OneBot -> 标准事件的转换层

转换逻辑在：

- `A:\VCP\VCPToolBox\Plugin\vcp-onebot-adapter\src\adapters\vcp\channelClient.js`

它会把 OneBot 消息转换成 `ChannelEventEnvelope`，并带上：

- `target`
- `client`
- `sender`
- `session`
- `payload.messages`
- `runtime`
- `metadata.onebot`

对应证据：

- `channelClient.js:45` `convertToEnvelope()`
- `channelClient.js:60` 构造 `bindingKey`
- `channelClient.js:105` 构造 `payload.messages`

这和 AstrBot 的统一消息对象思路是相通的。

### 4. VCP 的会话绑定是独立存储层，不是单纯 session 字符串

绑定管理在：

- `A:\VCP\VCPToolBox\modules\channelHub\SessionBindingStore.js`

它保存的不仅是 session key，还包括：

- `externalSessionKey`
- `adapterId`
- `conversationId`
- `topicId`
- `agentId`
- `lastActiveAt`
- `messageCount`

对应证据：

- `SessionBindingStore.js:52` `resolveBinding()`
- `SessionBindingStore.js:84` `_createBinding()`
- `SessionBindingStore.js:116` `bindSession()`

这使 VCP 的会话模型更偏“中间层绑定记录”，而不是单纯平台会话标识。

### 5. VCP 已经有回复标准化层

回复归一化在：

- `A:\VCP\VCPToolBox\modules\channelHub\ReplyNormalizer.js`

已支持：

- 文本 reply -> 标准 `messages[{ role, content[] }]`
- structured reply -> 标准 `messages[{ role, content[] }]`

对应证据：

- `ReplyNormalizer.js:32` `normalize()`
- `ReplyNormalizer.js:58` `normalizeTextReply()`
- `ReplyNormalizer.js:113` `normalizeStructuredReply()`

这部分是 AstrBot 平台架构里没有明确分离出来、但 VCP 已经做得更中间层化的一块。

### 6. VCP 的 internal route 已经具备统一入口思路

内部入口在：

- `A:\VCP\VCPToolBox\routes\internal\channelHub.js`

已具备：

- 统一 webhook 处理
- 适配器鉴权
- 签名验证
- 去重
- B1 兼容返回

对应证据：

- `channelHub.js:72` adapter auth middleware
- `channelHub.js:107` signature middleware
- `channelHub.js:150` deduplication middleware
- `channelHub.js:185` `handleWebhook()`

这说明 VCP 的问题不是“没有架构”，而是“还没把协议层边界完全做干净”。

---

## 哪些该借

### 1. 借 AstrBot 的会话语法

当前 VCP QQ 会话 key 偏业务型：

- 群：`qq:group:{groupId}:{userId}`
- 私聊：`qq:private:{userId}`

AstrBot 的会话语法更稳定：

- `platform_id:message_type:session_id`

建议：

- `externalSessionKey` 保持平台原生、简洁、稳定
- `bindingKey` 再承担 VCP 自己的绑定语义

这样能减少“平台会话标识”和“中间层绑定键”混用。

### 2. 借 AstrBot 的协议编解码边界

AstrBot 的 `aiocqhttp_message_event.py` 把 OneBot 的发送细节集中在一个模块里，这是正确方向。

VCP 建议继续收口成单独模块：

- `OneBotInboundCodec`
- `OneBotOutboundCodec`

而不是让 `channelClient.js` 同时承担：

- 协议解析
- 中间层 envelope 构造
- reply 提取
- 消息段转换

### 3. 借 AstrBot 的平台注册思想

AstrBot 的平台适配器有清晰注册点。

VCP 当前已存在 `AdapterRegistry`，但更偏存储和管理。建议继续补：

- 平台能力声明
- session grammar 声明
- inbound/outbound codec 声明
- transport mode 声明

让适配器从“配置记录”进一步变成“协议能力单元”。

### 4. 借 AstrBot 的按 session 发送抽象

AstrBot 的 `send_by_session()` 很值得保留思路。

VCP 也应逐步形成：

- 给定 binding/session
- 给定标准 reply
- 输出平台原生动作

而不是在不同地方散落拼接 `group_id/user_id`。

---

## 哪些不要搬

### 1. 不要搬 AstrBot 的 Python 平台运行时

原因很简单：

- 我们当前主系统是 Node
- `ChannelHubService` 已经承担了更强的编排职责
- 直接迁入 Python 风格平台层，只会与现有 `ChannelHub` 重叠

### 2. 不要默认切成反向 WebSocket

AstrBot 的 QQ 接入默认是反向 WS，这适合它自己的平台运行模型。

VCP 当前已经围绕前向 WS + HTTP B2 事件入口做了：

- `onebot client`
- `channelClient`
- `ChannelHub internal route`

如果没有明确部署收益，不应为了“像 AstrBot”而重构整条链。

### 3. 不要把会话模型退化回平台私有 session

AstrBot 的 `MessageSession` 很清爽，但它并不承担我们现在 `topic/agent/binding/audit` 这些中间层语义。

因此 VCP 只能借它的“格式设计”，不能丢掉自身绑定存储。

---

## 对 VCP 的直接建议

### 建议 1. 固化 QQ 的双层会话模型

分成两层：

- `externalSessionKey`
  - 平台原生会话键
  - 建议类似 `onebot:group:123456` / `onebot:private:987654`
- `bindingKey`
  - VCP 绑定键
  - 可继续承载用户级、Agent 级或话题级语义

### 建议 2. 把 OneBot 协议层单独抽出来

当前最值得新增的不是新页面，而是协议层模块：

- `Plugin/vcp-onebot-adapter/src/protocols/onebot/inboundCodec.js`
- `Plugin/vcp-onebot-adapter/src/protocols/onebot/outboundCodec.js`

把这些逻辑从 `channelClient.js` 里拆出去：

- segment -> content parts
- content parts -> onebot segments
- group/private/session 路由决策

### 建议 3. 明确 transport mode

适配器配置里应该显式声明：

- `transportMode: "forward_ws" | "reverse_ws" | "http_webhook"`

这样未来即使要支持 AstrBot/NapCat 风格反向 WS，也不会把现有实现推倒重来。

### 建议 4. 给适配器补协议能力矩阵

建议把 AstrBot 已明确覆盖的能力做成可配置声明：

- text
- at
- image
- audio
- video
- file
- forward_message

再让出站降级和页面说明都读这份能力声明。

### 建议 5. 把“按 session 发消息”设成统一内部接口

统一成类似：

```js
adapter.sendBySession(sessionDescriptor, normalizedReply)
```

这样后续 QQ、钉钉、企微、飞书都能共用同一层出站编排。

---

## 推荐落地顺序

1. 先固定 QQ 的 `externalSessionKey` 语法。
2. 从 `channelClient.js` 拆出 OneBot inbound/outbound codec。
3. 给 `AdapterRegistry` 增加 transport/capability/sessionGrammar 元数据。
4. 让 `DeliveryOutbox` 调用统一的 `sendBySession` 风格接口。
5. 再考虑是否新增反向 WS 支持。

---

## 最终判断

AstrBot 的 QQ 架构值得参考，但不是迁移目标。

对 VCP 来说，最优路径是：

- 保留 `ChannelHub` 作为中间层核心
- 吸收 AstrBot 的平台抽象思想
- 强化会话模型和 OneBot 编解码层
- 不重写为 AstrBot 那套运行时

如果后续要继续推进，下一份最值得写的不是再做泛化分析，而是：

- `QQ Session Grammar 设计稿`
- `OneBot Inbound/Outbound Codec 拆分方案`
- `AdapterRegistry 能力声明 schema`

