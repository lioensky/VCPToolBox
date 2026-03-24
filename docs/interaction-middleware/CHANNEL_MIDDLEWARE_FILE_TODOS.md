# VCPToolBox 多端接入中间层逐文件 TODO 清单

**版本:** 1.1 (2026-03-24 更新)
**创建日期:** 2026-03-23
**当前进度:** 约 80%
**关联文档:**
- [CHANNEL_MIDDLEWARE_DESIGN.md](./CHANNEL_MIDDLEWARE_DESIGN.md)
- [CHANNEL_MIDDLEWARE_IMPLEMENTATION_PLAN.md](./CHANNEL_MIDDLEWARE_IMPLEMENTATION_PLAN.md)
- [VCP_INTERACTION_MIDDLEWARE_TARGET.md](./VCP_INTERACTION_MIDDLEWARE_TARGET.md)

---

## 1. 文档目标

本文档把 `ChannelHub` 再往下拆一层，细化到“每个文件要做什么”的粒度，明确：

- 每个文件的职责边界
- 建议导出的方法或类
- 关键输入输出
- 依赖关系
- 完成标准
- 推荐编码顺序

这份文档适合直接用于：

- 排开发任务
- 拆 worker 子任务
- 做阶段验收
- 对照代码检查是否偏离设计

---

## 2. 后端核心文件 TODO

## 2.1 `modules/channelHub/constants.js`

### 目标

集中维护 `ChannelHub` 相关常量，避免状态名、目录名、事件名散落在各模块里。

### 建议导出

```js
module.exports = {
  CHANNEL_HUB_STATE_VERSION,
  CHANNEL_EVENT_VERSION,
  OUTBOX_STATUS,
  AUDIT_TYPES,
  CHANNEL_EVENT_TYPES,
  DEFAULT_RETRY_POLICY,
  DEFAULT_CAPABILITY_PROFILE,
  STATE_DIRNAME,
  AUDIT_DIRNAME,
  MEDIA_DIRNAME
};
```

### TODO

- 定义状态文件版本号
- 定义事件类型枚举
- 定义出站任务状态枚举
- 定义审计事件类型
- 定义默认重试策略
- 定义默认能力矩阵

### 完成标准

- 其他模块不再硬编码事件名和状态名
- 目录名、状态名、默认值只有一处定义

---

## 2.2 `modules/channelHub/errors.js`

### 目标

统一 `ChannelHub` 错误类型，让路由和审计都能拿到结构化错误。

### 建议导出

```js
class ChannelHubError extends Error {}
class AdapterAuthError extends ChannelHubError {}
class SignatureValidationError extends ChannelHubError {}
class EventValidationError extends ChannelHubError {}
class DeduplicationError extends ChannelHubError {}
class RoutingError extends ChannelHubError {}
class RuntimeGatewayError extends ChannelHubError {}
class DeliveryError extends ChannelHubError {}
class MediaGatewayError extends ChannelHubError {}

module.exports = {
  ChannelHubError,
  AdapterAuthError,
  SignatureValidationError,
  EventValidationError,
  DeduplicationError,
  RoutingError,
  RuntimeGatewayError,
  DeliveryError,
  MediaGatewayError
};
```

### TODO

- 定义基础错误类
- 定义可映射到 HTTP 状态码的子类
- 给错误加 `code`、`details`、`retryable`

### 完成标准

- 路由层能根据错误类型返回明确状态码
- 审计日志能保存结构化错误对象

---

## 2.3 `modules/channelHub/utils.js`

### 目标

提供 `ChannelHub` 通用工具函数，抽离文件读写、路径校验、ID 生成等细节。

### 建议导出

```js
module.exports = {
  ensureDir,
  readJsonFile,
  writeJsonFile,
  appendJsonLine,
  pathExists,
  resolvePathInside,
  createRequestId,
  createDeliveryJobId,
  nowTimestamp,
  safeParseJson,
  buildDedupKey
};
```

### TODO

- 封装 JSON 文件读写
- 封装 JSONL 追加写入
- 封装安全路径解析
- 封装 requestId 和 jobId 生成
- 封装去重键构造

### 完成标准

- 文件与目录处理逻辑不再分散在服务类中
- 所有状态文件读写都走统一工具

---

## 2.4 `modules/channelHub/StateStore.js`

### 目标

成为 `state/channelHub/` 下所有状态文件的统一读写入口。

### 管理文件

- `state/channelHub/adapters.json`
- `state/channelHub/identity-map.json`
- `state/channelHub/dedup-cache.json`
- `state/channelHub/sessions.jsonl`
- `state/channelHub/outbox.jsonl`
- `state/channelHub/tasks.jsonl`
- `state/channelHub/audit/*.jsonl`

### 建议导出

```js
class StateStore {
  constructor(options) {}

  async initialize() {}

  async getAdapters() {}
  async saveAdapters(data) {}

  async getIdentityMap() {}
  async saveIdentityMap(data) {}

  async getDedupCache() {}
  async saveDedupCache(data) {}

  async appendSession(record) {}
  async querySessions(filter) {}

  async appendOutboxJob(job) {}
  async updateOutboxJob(jobId, patch) {}
  async queryOutbox(filter) {}

  async appendTask(record) {}
  async queryTasks(filter) {}

  async appendAuditRecord(type, record) {}
  async queryAudit(filter) {}
}

module.exports = StateStore;
```

### TODO

- 自动创建缺失的状态目录和文件
- 定义默认数据结构
- 支持 JSON 与 JSONL 混合存储
- 支持简单过滤查询
- 预留串行写入保护

### 依赖

- `utils.js`
- `constants.js`

### 完成标准

- 其他服务类不直接操作 `state/channelHub/*`
- 所有状态写入都能落到统一入口

---

## 2.5 `modules/channelHub/AdapterRegistry.js`

### 目标

维护所有适配器定义、能力声明、启停状态和优先级。

### 建议导出

```js
class AdapterRegistry {
  constructor(options) {}

  async initialize() {}
  async listAdapters() {}
  async getAdapter(adapterId) {}
  async upsertAdapter(adapterConfig) {}
  async enableAdapter(adapterId) {}
  async disableAdapter(adapterId) {}
  async getCapabilityProfile(adapterId) {}
}

module.exports = AdapterRegistry;
```

### TODO

- 定义 adapter 配置结构
- 支持启用和停用
- 支持查询能力矩阵
- 支持仓库内置 adapter 和手工注册 adapter 共存

### 输入输出

- 输入：adapterId、adapterConfig
- 输出：adapter metadata、capability profile

### 完成标准

- 新平台接入不需要修改核心服务硬编码列表
- 能通过配置查询到某 adapter 的可用能力

---

## 2.6 `modules/channelHub/AdapterAuthManager.js`

### 目标

负责适配器级别的鉴权，而不是继续依赖全局 `Key`。

### 背景

当前 `/internal/channel-ingest` 实际鉴权仍使用全局 `Key` 或 `x-channel-bridge-key`。证据：`server.js:931`

### 建议导出

```js
class AdapterAuthManager {
  constructor(options) {}

  async authenticate(headers) {}
  async getAdapterByHeaders(headers) {}
  async rotateAdapterSecret(adapterId, nextSecret) {}
  async validateSourceIp(adapterId, sourceIp) {}
}

module.exports = AdapterAuthManager;
```

### TODO

- 支持独立 adapter secret
- 支持来源 IP / 网段白名单
- 支持停用 adapter 后拒绝请求
- 预留 secret 轮换逻辑

### 依赖

- `AdapterRegistry.js`
- `errors.js`

### 完成标准

- 新入口不再直接依赖全局 `Key`
- 单个 adapter 可以独立撤权

---

## 2.7 `modules/channelHub/SignatureValidator.js`

### 目标

做平台来源签名校验，承接钉钉、企业微信、飞书等平台的回调鉴权。

### 建议导出

```js
class SignatureValidator {
  constructor(options) {}

  async validate(adapter, headers, rawBody) {}
  async validateDingTalk(headers, rawBody, adapter) {}
  async validateWeCom(headers, rawBody, adapter) {}
  async validateFeishu(headers, rawBody, adapter) {}
}

module.exports = SignatureValidator;
```

### TODO

- 定义统一签名校验入口
- 为不同平台预留子校验器
- 支持时间戳过期校验
- 支持 nonce 重放保护

### 完成标准

- 新平台签名逻辑以插件式子校验器扩展
- 平台差异不泄漏到 `ChannelHubService`

---

## 2.8 `modules/channelHub/EventSchemaValidator.js`

### 目标

校验并标准化 B2 事件 Envelope。

### 建议导出

```js
class EventSchemaValidator {
  constructor(options) {}

  validateEnvelope(input) {}
  normalizeEnvelope(input) {}
}

module.exports = EventSchemaValidator;
```

### TODO

- 校验必填字段
- 补齐默认字段
- 归一化时间戳、布尔值和空数组
- 统一错误输出

### 依赖

- `schemas/channel-event-envelope.schema.json`
- `errors.js`

### 完成标准

- 路由层传入的事件在进入核心服务前已经合法
- 任意 adapter 发送的 B2 请求都能得到统一字段形态

---

## 2.9 `modules/channelHub/B1CompatTranslator.js`

### 目标

把现有 `/internal/channel-ingest` 的旧请求转换成 B2 `ChannelEventEnvelope`。

### 背景

迁移期间 B1 需要保留兼容，但不继续扩展新能力。

### 建议导出

```js
class B1CompatTranslator {
  translateRequest(body, headers) {}
  translateReply(channelRuntimeReply) {}
}

module.exports = B1CompatTranslator;
```

### TODO

- 将 B1 的 `agentId`、`client`、`sender`、`topicControl`、`messages` 映射到 B2
- 把结构化回复退化成 B1 的 `reply.text`
- 保留 requestId 和 sessionKey

### 完成标准

- B1 可作为 B2 的兼容入口运行
- B1 与 B2 共用同一条核心处理链

---

## 2.10 `modules/channelHub/EventDeduplicator.js`

### 目标

实现入站事件幂等和重复检测。

### 建议导出

```js
class EventDeduplicator {
  constructor(options) {}

  async checkAndMark(envelope) {}
  async buildDedupKeys(envelope) {}
  async cleanupExpiredEntries() {}
}

module.exports = EventDeduplicator;
```

### TODO

- 构造主键和次键
- 支持 TTL 清理
- 支持命中后返回重复原因

### 依赖

- `StateStore.js`
- `utils.js`

### 完成标准

- 重放消息不会重复触发 runtime
- 审计日志能看到重复命中情况

---

## 2.11 `modules/channelHub/MessageNormalizer.js`

### 目标

把平台消息内容统一转换成 runtime 可消费的 content parts。

### 建议导出

```js
class MessageNormalizer {
  normalizeMessages(envelope) {}
  normalizeContentPart(part, adapter) {}
}

module.exports = MessageNormalizer;
```

### TODO

- 统一 text/image/file/audio 输入
- 把平台附件字段映射成标准 part
- 处理空文本和混合消息
- 预留 mention、quote、thread 元素

### 完成标准

- 不同平台的消息都能归一化成同一套消息结构
- `RuntimeGateway` 不再关心平台原始 payload

---

## 2.12 `modules/channelHub/SessionBindingStore.js`

### 目标

统一管理 `bindingKey`、`externalSessionKey`、`topicId`、`agentId` 的映射关系。

### 建议导出

```js
class SessionBindingStore {
  constructor(options) {}

  async resolveBinding(envelope) {}
  async bindSession(record) {}
  async rebindSession(bindingKey, patch) {}
  async queryBindings(filter) {}
}

module.exports = SessionBindingStore;
```

### TODO

- 首次消息建立绑定记录
- 根据 bindingKey 解析现有 topic
- 支持手工重绑
- 支持按平台、会话、用户检索

### 依赖

- `StateStore.js`

### 完成标准

- 新平台不再各自发明 session 映射规则
- topic / history / agent 路由可共享同一套存储

---

## 2.13 `modules/channelHub/IdentityMappingStore.js`

### 目标

记录平台用户身份与 VCP 内部身份的映射关系。

### 建议导出

```js
class IdentityMappingStore {
  constructor(options) {}

  async getIdentity(key) {}
  async linkIdentity(record) {}
  async unlinkIdentity(key) {}
  async queryIdentities(filter) {}
}

module.exports = IdentityMappingStore;
```

### TODO

- 先支持平台用户主键映射
- 预留同人跨平台合并能力
- 支持人工修正映射

### 完成标准

- 用户在不同渠道的身份信息可独立保存
- 后续要做跨端连续上下文时有基础支点

---

## 2.14 `modules/channelHub/AgentRoutingPolicy.js`

### 目标

统一决定本次事件应该进入哪个 agent、topic、model 和运行时配置。

### 建议导出

```js
class AgentRoutingPolicy {
  constructor(options) {}

  async resolveRoute(envelope, bindingRecord) {}
  async resolveAgent(envelope) {}
  async resolveTopic(envelope, bindingRecord) {}
  async resolveRuntimeOverrides(envelope) {}
}

module.exports = AgentRoutingPolicy;
```

### TODO

- 支持固定 agent
- 支持按 adapter / 平台 / 来源群组路由
- 支持 topic hint 与当前 topic 选择
- 支持 runtime override 合并

### 依赖

- `SessionBindingStore.js`
- 现有 agent 配置系统

### 完成标准

- channel 路由逻辑与具体平台解耦
- 路由判断可以被审计记录复盘

---

## 2.15 `modules/channelHub/RuntimeGateway.js`

### 目标

把 `ChannelHub` 事件桥接到现有 VCP runtime。

### 背景

当前旧桥接直接伪造 `req.body` 并覆盖 `res.write/res.json/res.end`。证据：`server.js:904-1021`

### 建议导出

```js
class RuntimeGateway {
  constructor(options) {}

  async invoke(envelope, routeDecision) {}
  buildRuntimeRequest(envelope, routeDecision) {}
  async invokeLegacyChatHandler(runtimeRequest) {}
}

module.exports = RuntimeGateway;
```

### TODO

- 构造标准 `ChannelRuntimeRequest`
- 第一阶段封装旧 `chatCompletionHandler`
- 第二阶段预留无 HTTP 的内部调用入口
- 返回结构化 `ChannelRuntimeReply`

### 依赖

- `MessageNormalizer.js`
- `ReplyNormalizer.js`
- 现有 `ChatCompletionHandler`

### 完成标准

- 核心服务不再在路由层直接操作 `req/res`
- runtime 输出统一成为结构化对象

---

## 2.16 `modules/channelHub/ReplyNormalizer.js`

### 目标

把 runtime 的原始输出统一整理成 `ChannelRuntimeReply`。

### 建议导出

```js
class ReplyNormalizer {
  normalize(rawRuntimeOutput, context) {}
  normalizeTextReply(rawRuntimeOutput) {}
  normalizeStructuredReply(rawRuntimeOutput) {}
}

module.exports = ReplyNormalizer;
```

### TODO

- 兼容文本回复
- 兼容未来结构化富回复
- 统一填充 `meta`、`usage`、`topic`

### 完成标准

- 上层永远拿到统一 reply shape
- 为能力降级和多平台投递提供稳定输入

---

## 2.17 `modules/channelHub/CapabilityRegistry.js`

### 目标

统一管理平台能力矩阵。

### 建议导出

```js
class CapabilityRegistry {
  constructor(options) {}

  getProfile(adapterId) {}
  mergeProfile(adapterProfile, defaults) {}
  supports(adapterId, capabilityName) {}
}

module.exports = CapabilityRegistry;
```

### TODO

- 定义标准 capability profile
- 支持 adapter 自定义覆盖
- 提供简单能力查询

### 完成标准

- 降级逻辑不需要手写平台 if/else
- 平台能力差异都可从 profile 获取

---

## 2.18 `modules/channelHub/CapabilityDowngrader.js`

### 目标

把统一 reply 转成平台可投递的消息列表。

### 建议导出

```js
class CapabilityDowngrader {
  constructor(options) {}

  degrade(reply, capabilityProfile, context) {}
  degradeText(reply, capabilityProfile) {}
  degradeMedia(reply, capabilityProfile) {}
  degradeActions(reply, capabilityProfile) {}
}

module.exports = CapabilityDowngrader;
```

### TODO

- 文本长度裁剪
- 图片/文件降级成链接
- 按钮组降级成文本选项
- 不支持卡片的平台降级成富文本摘要

### 依赖

- `CapabilityRegistry.js`
- `MediaGateway.js`

### 完成标准

- 同一回复可以在不同平台得到不同但语义一致的交付形态
- 平台差异集中在一处实现

---

## 2.19 `modules/channelHub/MediaGateway.js`

### 目标

负责媒体资源的接收、转存、预签名引用和平台上传前处理。

### 建议导出

```js
class MediaGateway {
  constructor(options) {}

  async ingestInboundMedia(parts, context) {}
  async prepareOutboundMedia(messageParts, adapter) {}
  async cacheRemoteMedia(url, options) {}
}

module.exports = MediaGateway;
```

### TODO

- 入站媒体落到本地 cache
- 为出站消息准备平台可识别的媒体引用
- 预留图片、文件、音频三类处理
- 预留大小与格式校验

### 完成标准

- 媒体处理不再散落在 adapter 内部
- 降级器和出站层都能统一使用媒体网关

---

## 2.20 `modules/channelHub/DeliveryOutbox.js`

### 目标

统一管理出站任务、重试、死信和状态查询。

### 建议导出

```js
class DeliveryOutbox {
  constructor(options) {}

  async enqueue(jobs) {}
  async process(job) {}
  async retry(jobId) {}
  async cancel(jobId) {}
  async markDelivered(jobId, receipt) {}
  async markFailed(jobId, error) {}
  async listJobs(filter) {}
}

module.exports = DeliveryOutbox;
```

### TODO

- 记录 pending / delivered / failed / dead-letter 状态
- 支持指数退避重试
- 支持手工补发
- 支持状态查询

### 依赖

- `StateStore.js`
- `AuditLogger.js`

### 完成标准

- 出站不再是“发完就算了”
- 平台投递失败可被追踪和补偿

---

## 2.21 `modules/channelHub/AuditLogger.js`

### 目标

记录入站、路由、runtime、出站、失败和重试的全链路审计。

### 建议导出

```js
class AuditLogger {
  constructor(options) {}

  async recordIngress(envelope, meta) {}
  async recordRoute(requestId, routeDecision) {}
  async recordRuntime(requestId, runtimeRequest, runtimeReply) {}
  async recordDelivery(job, result) {}
  async recordError(requestId, error, context) {}
  async queryAudit(filter) {}
}

module.exports = AuditLogger;
```

### TODO

- 定义审计记录格式
- 按天分桶写 JSONL
- 支持按 requestId 聚合查询
- 记录失败和重试事件

### 完成标准

- 能对一次消息完成全链路追踪
- AdminPanel 可按 requestId 拉完整轨迹

---

## 2.22 `modules/channelHub/MetricsCollector.js`

### 目标

汇总 `ChannelHub` 的吞吐、延迟、错误率和队列积压。

### 建议导出

```js
class MetricsCollector {
  constructor(options) {}

  recordIngress(event) {}
  recordRuntime(event) {}
  recordDelivery(event) {}
  getSnapshot() {}
}

module.exports = MetricsCollector;
```

### TODO

- 统计入站量
- 统计 runtime 耗时
- 统计投递成功率和失败率
- 统计 outbox 积压

### 完成标准

- 概览页能显示实时或准实时指标
- 不依赖 adapter 自己报表

---

## 2.23 `modules/channelHub/ChannelHubService.js`

### 目标

成为 `ChannelHub` 总编排入口。

### 建议导出

```js
class ChannelHubService {
  constructor(options) {}

  async initialize() {}
  async handleEvent(envelope, context = {}) {}
  async handleB1Request(body, headers, context = {}) {}
}

module.exports = ChannelHubService;
```

### 内部流程建议

1. adapter 鉴权
2. 签名校验
3. B1/B2 转换
4. schema 校验
5. 去重
6. 绑定解析
7. 路由决策
8. runtime 调用
9. 回复归一化
10. 能力降级
11. 出站队列或同步返回
12. 审计和指标记录

### TODO

- 组合所有子服务
- 定义统一处理链
- 定义错误处理与审计补偿
- 支持同步回复和异步投递两种模式

### 完成标准

- 所有通道请求都经由这一处编排
- 路由层只负责解析 HTTP，不再承担业务逻辑

---

## 3. Schema 文件 TODO

## 3.1 `modules/channelHub/schemas/channel-event-envelope.schema.json`

### 目标

定义 B2 入站事件协议。

### TODO

- 定义必填字段
- 定义 `client`、`sender`、`session`、`payload` 子对象
- 限制 `messages[].content[].type` 枚举

### 完成标准

- 任意 B2 请求都可由 schema 直接做基础校验

---

## 3.2 `modules/channelHub/schemas/channel-runtime-request.schema.json`

### 目标

定义 `RuntimeGateway` 的标准输入。

### TODO

- 定义 `agentId`
- 定义 `messages`
- 定义 `runtimeOverrides`
- 定义 `clientContext`

### 完成标准

- 运行时请求格式在代码层和文档层统一

---

## 3.3 `modules/channelHub/schemas/channel-runtime-reply.schema.json`

### 目标

定义 `RuntimeGateway` 输出给上层的标准回复。

### TODO

- 定义 `messages`
- 定义 `usage`
- 定义 `meta`
- 定义 `topic`

### 完成标准

- 上下游都能以 schema 验证回复结构

---

## 3.4 `modules/channelHub/schemas/channel-delivery-job.schema.json`

### 目标

定义出站任务结构。

### TODO

- 定义 job 状态枚举
- 定义 retry 字段
- 定义 target 和 messages 结构

### 完成标准

- outbox 中所有任务都有统一结构

---

## 3.5 `modules/channelHub/schemas/channel-capability.schema.json`

### 目标

定义平台能力矩阵结构。

### TODO

- 定义文本、媒体、卡片、回调、主动推送等能力位
- 定义消息长度和附件大小限制字段

### 完成标准

- 不同平台都能以同一 schema 表述能力差异

---

## 4. 路由层文件 TODO

## 4.1 `routes/internal/channelHub.js`

### 目标

提供正式 B2 入站接口和 B1 兼容入口。

### 建议导出

```js
const router = require('express').Router();
module.exports = router;
```

### TODO

- `POST /internal/channel-hub/events`
- `POST /internal/channel-hub/media/upload`
- `POST /internal/channel-hub/deliveries/:jobId/callback`
- `POST /internal/channel-ingest` 的兼容挂接

### 完成标准

- 路由层只做 HTTP 解析和错误映射
- 业务逻辑全部下沉到 `ChannelHubService`

---

## 4.2 `routes/admin/channelHub.js`

### 目标

提供 AdminPanel 使用的频道中间层运维接口。

### TODO

- 概览接口
- adapters 管理接口
- sessions / identities 查询接口
- outbox 查询和重试接口
- audit / trace 查询接口

### 依赖

- `ChannelHubService.js`
- `AdapterRegistry.js`
- `DeliveryOutbox.js`
- `AuditLogger.js`

### 完成标准

- AdminPanel 不需要直接读状态文件
- 所有运维动作都能走正式 admin API

---

## 5. AdminPanel 文件 TODO

## 5.1 `AdminPanel/channel-hub.html`

### 目标

作为频道中间层管理页面承载容器。

### TODO

- 概览区
- adapters tab
- sessions tab
- outbox tab
- audit tab
- platform matrix tab

### 完成标准

- 一页内能完成核心运维动作

---

## 5.2 `AdminPanel/js/channel-hub.js`

### 目标

作为页面主入口，负责 tab 初始化和公共状态管理。

### 建议导出

```js
window.ChannelHubPage = {
  initialize
};
```

### TODO

- 页面初始化
- tab 切换
- 公共通知和错误展示
- 首次加载概览

### 完成标准

- 其余子模块都通过这个入口统一挂载

---

## 5.3 `AdminPanel/js/channel-hub-adapters.js`

### 目标

负责适配器管理 UI。

### TODO

- 拉 adapter 列表
- 启停 adapter
- 编辑能力矩阵
- 测试签名或联通性

### 完成标准

- 不需要改配置文件即可管理 adapter

---

## 5.4 `AdminPanel/js/channel-hub-sessions.js`

### 目标

负责会话绑定和身份映射查询。

### TODO

- 搜索 bindingKey
- 查看 topic / agent / user 绑定
- 手工 rebind
- 查看 identity mapping

### 完成标准

- topic 错绑和会话串线问题可在界面定位

---

## 5.5 `AdminPanel/js/channel-hub-outbox.js`

### 目标

负责出站任务和死信管理。

### TODO

- 查看 pending / failed / dead-letter
- 手工 retry
- 手工 cancel
- 展示重试次数和最后错误

### 完成标准

- 平台投递失败能在界面直接处理

---

## 5.6 `AdminPanel/js/channel-hub-audit.js`

### 目标

负责 requestId 级别全链路追踪。

### TODO

- 按 requestId 查询
- 按 adapter / channel / 状态筛选
- 展示 ingress -> route -> runtime -> delivery 时间线

### 完成标准

- 运维排障时能看见完整链路，而不是只看零散日志

---

## 6. 推荐第一批开发文件

**状态：✅ 已全部完成**

如果现在开始真正落代码，最推荐先写下面 8 个文件：

1. ✅ `modules/channelHub/constants.js`
2. ✅ `modules/channelHub/errors.js`
3. ✅ `modules/channelHub/utils.js`
4. ✅ `modules/channelHub/StateStore.js`
5. ✅ `modules/channelHub/AdapterRegistry.js`
6. ✅ `modules/channelHub/EventSchemaValidator.js`
7. ✅ `modules/channelHub/B1CompatTranslator.js`
8. ✅ `modules/channelHub/ChannelHubService.js`

原因：
- 这 8 个文件能先把协议、状态和总入口固定下来
- 后续 `RuntimeGateway`、`DeliveryOutbox`、AdminPanel 都能在这个骨架上往前接

---

## 7. 第二批建议文件

第二批建议继续补：

1. `AdapterAuthManager.js`
2. `SignatureValidator.js`
3. `EventDeduplicator.js`
4. `SessionBindingStore.js`
5. `AgentRoutingPolicy.js`
6. `RuntimeGateway.js`
7. `ReplyNormalizer.js`

这批做完后，就能完成 B2 文本闭环。

---

## 8. 第三批建议文件

第三批建议补齐“平台化能力”：

1. `CapabilityRegistry.js`
2. `CapabilityDowngrader.js`
3. `MediaGateway.js`
4. `DeliveryOutbox.js`
5. `AuditLogger.js`
6. `MetricsCollector.js`
7. `routes/admin/channelHub.js`
8. `AdminPanel/*`

这批做完后，`ChannelHub` 才算真正进入“可运维、可复制到多平台”的阶段。

---

## 9. 验收口径

### 第一阶段验收

- B2 schema 固定
- B1 可转 B2
- 状态文件结构确定
- 总服务入口可接请求

### 第二阶段验收

- 文本事件可从入站到 runtime 再到统一 reply
- topic binding 可记录
- requestId 可追踪

### 第三阶段验收

- 富回复可降级
- 出站失败可重试
- AdminPanel 可观测
- 钉钉可完整迁移到 B2

---

## 10. 一句话建议

真正开工时，不要先写平台 adapter，而要先把下面四件事定稳：

- schema
- state
- service orchestration
- audit/outbox

这样后面接钉钉、企微、飞书、QQ 时，才是在复制能力，而不是复制临时桥接代码。
