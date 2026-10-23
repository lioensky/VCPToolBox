# NativeSync Mobile：受限会话与持久执行

默认关闭。`NativeMobileEnabled=true` 时要求 `NativeMobileOrigin` 为明确 HTTPS origin，`NativeMobileTopics` 为最多 8 个显式授权 Agent/Topic 的 JSON 数组，`NativeMobilePwaDir` 指向已构建的 PWA。条目示例（不含凭据；应替换为自己的既有身份，不重新生成历史ID）：

```json
[{"key":"selected-topic","ownerType":"agent","ownerId":"existing-agent-id","topicId":"existing-topic-id","agentAlias":"ExistingAgent","agentName":"ExistingAgent","topicName":"Selected history","model":"configured-model-name"}]
```

配对码由宿主 Bearer 鉴权保护的 `POST /api/plugins/NativeSync/mobile/pairing` 签发，3 分钟、一次性使用。也可明确配置 `NativeMobileBackendUrl` 并启用 `NativeMobileKeyExchangeEnabled`，让用户在同源 HTTPS 设置页临时输入宿主 Key 换取受限会话。配置地址仅表示服务器身份，不是任意 URL 转发。浏览器不持久保存 Key，后续使用默认 8 小时的不透明 HttpOnly/Secure/SameSite=Strict Cookie，Path=/mobile；数据库仅存会话凭据摘要。`NativeMobileSessionHours` 可设为 1–720。

移动入口要求直接 TLS 或本机可信 HTTPS 反向代理。只有真实 TLS 或来自回环地址的可信 HTTPS 转发会通过传输检查，远端伪造转发头不会通过。静态前端与 API 应同源，写请求还校验固定 Origin。

- `GET /mobile/api/conversations`：从显式许可配置及现有 messages 派生目录。
- `GET /mobile/api/conversations/:key?after=0`：同一 SQLite 的完整文本消息和执行状态；每页 200 条，可继续读取。
- `POST /mobile/api/conversations/:key/messages`：仅接受 requestId/text。相同会话内 requestId 重试必须同内容，持久接受后返回 202。
- `POST /mobile/api/executions/:id/cancel`：只能取消本会话拥有的非终态执行。

同一个 `central.sqlite` 保存认证元数据和执行意图，没有第二个聊天历史数据库。preparing/publishing 是可恢复的写前意图，消息始终调用原 `CentralStore.apply`，稳定 opId 防重，完成后清除临时 operation。用户消息及 queued 状态持久化后才返回 202。queued 可以恢复；异常中断的 running/cancelling 不自动重跑，结果不确定时明确标记需要复核。已持久保存的结果意图直接完成发布，不重新调用模型。

执行调用宿主原 `/v1/chat/completions`，提示读取原 AgentManager，模型路由、预处理、工具执行仍由原 ChatCompletionHandler 完成。手机 HTTP 连接结束不会取消任务；显式取消及宿主 drain 才会中止内部请求。取消先持久记录，再中止传输；发布最终结果后不能撤回。不承诺外部工具副作用恰好一次，不对失败或不确定任务自动补发。

默认全局并发 4，同 Topic 严格串行。上下文纳入前序任务已完成的回复，并排除后续输入及其他 Topic；上下文预算交给宿主模型执行链，200 条只是消息查询每页上限。仅支持文本和明确配置的 Agent 话题，不支持移动群聊、附件迁移或完整配置同步。前端只缓存公共 shell，API/聊天数据不进入 Service Worker cache。

使用根目录 `npm run test:native-sync` 运行独立合成测试，不需要相邻 VCPChat 仓库。TLS 私钥、一次性码、会话 Cookie、真实配置及聊天记录均不得进入源码或测试回执。
