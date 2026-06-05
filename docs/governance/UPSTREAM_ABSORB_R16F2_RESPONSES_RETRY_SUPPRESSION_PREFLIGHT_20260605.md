# Upstream Absorb R16F2 Responses Retry Suppression Preflight - 2026-06-05

本文件只做设计/preflight，不实现代码，不 raw merge `upstream/main`。

## 1. 目标

评估 upstream `cca1c915` 中剩余的 Responses retry suppression 是否适合吸收。

R16F1 已由 #130 吸收 function tools 字段保护。本轮只评估剩余的重复 Responses 请求抑制逻辑。

## 2. 上游行为摘要

`cca1c915` 在 `routes/protocolBridge.js` 中增加了：

- `PROTOCOL_BRIDGE_RETRY_SUPPRESSION_MS` 配置，默认 `15000`
- `buildStableRequestId(prefix, payload)`，按请求 payload 生成稳定 ID
- `recentResponsesRequests` 内存 Map
- 短窗口内相同 `/v1/responses` 请求直接返回一个 immediate Responses payload
- streaming 模式也返回完整 Responses SSE 终态事件

目的：降低客户端短时间自动重试导致的重复预处理、重复 RAG、重复上游转发。

## 3. 本地现状

本地没有 `routes/protocolBridge.js`。

相关代码位于：

- `Plugin/VCPBridgeServer/bridgeserver.js`
- `tests/vcp-bridge-server.test.js`

本地 `VCPBridgeServer` 是 loopback proxy：

- 默认 disabled
- 只绑定 loopback
- `/v1/responses` 当前直接提取 input 为 messages 后调用 `proxyRequest`
- 已有 JSON/SSE schema 转换测试
- #130 已补 protected function tool fields，不涉及 retry suppression

## 4. 风险判断

不建议直接吸收上游实现。

原因：

- 上游实现针对 `routes/protocolBridge.js`，本地不存在该文件。
- retry suppression 会改变客户端重试语义。
- 短窗口内相同请求会返回 synthetic success，而不是再次访问 upstream。
- 如果误判重复请求，用户可能看到 suppression 文案而不是真实模型结果。
- 内存 Map 会引入新的状态面，需要 TTL 清理和测试。
- 对 streaming clients 必须保证 Responses SSE 终态完整，否则 Codex 类客户端可能误判断流。

## 5. 建议实现边界

若继续实现，建议开独立 R16F2 小包，范围限定：

- `Plugin/VCPBridgeServer/bridgeserver.js`
- `tests/vcp-bridge-server.test.js`

不碰：

- `routes/*`
- `server.js`
- 真实 env / `config.env`
- OAuth provider 路由
- VCP 主 chat pipeline
- bridge 默认启用状态

建议策略：

- 默认关闭。
- 新增 opt-in 配置，例如 `BRIDGE_RESPONSES_RETRY_SUPPRESSION_MS=0` 表示关闭。
- 只作用于 `VCPBridgeServer` 的 `/v1/responses` endpoint。
- 只在 request body 未显式提供 `requestId` / `messageId` 时生成 stable id。
- stable id 必须包含 model、normalized messages/input、stream、temperature、top_p、max_tokens/max_output_tokens、tool fields 等影响输出的字段。
- suppression 命中时返回明确 synthetic Responses payload，不能伪装成 upstream payload。
- streaming 命中必须发送 `response.created`、delta/done、`response.completed` 和 `data: [DONE]`。
- Map 清理必须有 bounded TTL，不能无限增长。

## 6. 测试建议

只用本地 fake fetch / loopback 测试，不访问真实 upstream。

建议新增测试：

- 默认关闭时，相同 `/v1/responses` 请求会转发两次。
- 开启 suppression 后，短窗口内相同 non-stream 请求只转发一次，第二次返回 synthetic Responses JSON。
- 开启 suppression 后，短窗口内相同 stream 请求只转发一次，第二次返回完整 synthetic Responses SSE。
- 不同 model/input/tool fields 不应互相抑制。
- 窗口过期后应再次转发。
- 显式不同 `requestId` / `messageId` 不应互相抑制。

验证命令：

```powershell
node --check Plugin\VCPBridgeServer\bridgeserver.js
node --check tests\vcp-bridge-server.test.js
node --test tests\vcp-bridge-server.test.js
git diff --check
```

## 7. 结论

R16F2 值得继续做，但必须作为独立设计实现包。

本 preflight 不建议 raw cherry-pick `cca1c915`。推荐先实现默认关闭的 opt-in suppression，并用本地 fake fetch 测试锁定重复请求、streaming 终态和非重复请求边界。
