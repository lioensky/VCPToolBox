# Codex OAuth Provider 配置与排错

本文档说明 `codex_oauth` 如何把 AdminPanel 中授权的 ChatGPT / Codex OAuth 账号接入 VCP 的 Responses Provider 路由。

## 作用边界

`codex_oauth` 是 VCP 主服务内的 OAuth token consumer。启用后，主服务会在以下入口接管匹配的 Codex OAuth 模型请求：

- `POST /v1/responses`
- `POST /v1/chat/completions`
- `POST /v1/chatvcp/completions`

请求被接管后，主服务会通过 `OAuthAuthManager.getValidToken('codex_oauth')` 获取有效 token，再转发到 Codex Responses 上游。

`VCPBridgeServer` 不直接读取、刷新或持有 OAuth token。它只应把请求代理到 VCP 主服务或临时测试中的 provider route，由主服务完成 OAuth 认证与上游转发。

## 配置项

配置位于根目录 `config.env`，也可通过 AdminPanel 的 OAuth 认证中心写入启用状态。

| 配置项 | 说明 |
| --- | --- |
| `VCP_OAUTH_AUTH_CENTER_ENABLED` | 是否启用 OAuth 认证中心管理面能力。 |
| `VCP_OAUTH_TOKEN_ENCRYPTION_KEY` | 本地 OAuth token 落盘加密口令。更换后旧账号通常需要重新登录。 |
| `VCP_RESPONSES_PROVIDER` | 设置为 `codex_oauth` 时启用 Codex OAuth Responses Provider；留空则不接管。 |
| `VCP_CODEX_OAUTH_ACCOUNT_ID` | 指定要使用的 OAuth 账号；为空时使用默认账号。 |
| `VCP_CODEX_OAUTH_UPSTREAM_BASE_URL` | Codex Responses 上游基础地址。 |
| `VCP_CODEX_OAUTH_CLIENT_VERSION` | 发送给上游的客户端版本。 |
| `VCP_CODEX_OAUTH_UPSTREAM_TIMEOUT_MS` | Codex OAuth 上游请求超时。streaming body 消费也应受此超时保护。 |
| `VCP_CODEX_OAUTH_MODELS` | 可选模型列表，逗号分隔；为空时使用内置 fallback 列表，若上游模型目录可用则优先使用上游返回。 |

## 启用步骤

1. 在 `config.env` 设置 `VCP_OAUTH_AUTH_CENTER_ENABLED=true` 和稳定的 `VCP_OAUTH_TOKEN_ENCRYPTION_KEY`。
2. 重启 VCP 主服务，让 OAuth 认证中心和加密口令生效。
3. 打开 AdminPanel -> OAuth 认证中心 -> ChatGPT / Codex OAuth，完成登录授权。
4. 确认账号列表出现账号，并设置默认账号，或选择要写入的 provider account。
5. 点击启用 Provider。AdminPanel 会写入 `VCP_RESPONSES_PROVIDER=codex_oauth` 和账号配置。
6. 使用模型列表中的 Codex OAuth 模型发起请求。

## 模型选择

运行时模型列表按以下顺序生效：

1. 如果上游模型目录请求成功，优先使用上游返回的模型。
2. 如果上游模型目录不可用且配置了 `VCP_CODEX_OAUTH_MODELS`，使用配置列表。
3. 如果上游模型目录不可用且未配置本地模型，使用内置 fallback 模型列表。

AdminPanel 的 Provider 面板显示的是本地兜底模型来源和数量，例如 `models=configured:n` 或 `models=fallback:n`。实际请求时，如果上游模型目录可用，运行时仍会优先采用上游返回的模型目录。如果没有有效模型，测试 Provider 按钮会被禁用。

## Bridge / Proxy 接入

推荐接入方式是让 `VCPBridgeServer` 的上游指向 VCP 主服务，而不是让 bridge 自己消费 OAuth。

示例关系：

```text
VCP agent/client
  -> VCPBridgeServer
  -> VCP main service /v1/responses or /v1/chat/completions
  -> codex_oauth provider route
  -> OAuthAuthManager token consumer
  -> Codex Responses upstream
```

这样 bridge 保持代理职责，OAuth token 的存储、刷新、脱敏错误返回都集中在主服务内。

## 常见错误

| 错误码 | 含义 | 处理方式 |
| --- | --- | --- |
| `codex_oauth_account_missing` | 没有可用账号，或配置账号已被移除。 | 在 AdminPanel 重新登录账号，并设置默认账号或重新启用 Provider。 |
| `codex_oauth_unauthorized` | 上游拒绝当前 OAuth 授权。 | 重新授权账号；如仍失败，确认 ChatGPT/Codex 账号状态。 |
| `codex_oauth_refresh_unavailable` | refresh token 不可用或无法刷新。 | 移除该账号后重新登录。 |
| `codex_oauth_rate_limited` | 上游限流。 | 稍后重试，或切换账号/模型。 |
| `codex_oauth_request_rejected` | 上游拒绝请求格式或模型。 | 检查模型名、请求体和是否发送了不支持字段。 |
| `codex_oauth_upstream_timeout` | 上游请求超时。 | 检查网络，必要时调整 `VCP_CODEX_OAUTH_UPSTREAM_TIMEOUT_MS`。 |
| `codex_oauth_upstream_failed` | 通用上游失败。 | 检查账号、模型配置、网络和上游可用性。 |

streaming 请求在 headers 已发送后失败时，provider 会向下游补一个脱敏 SSE error 事件并结束流，避免客户端一直卡在思考中。

## 验证建议

最小验证顺序：

1. AdminPanel OAuth 认证中心能看到已授权账号。
2. Provider 状态显示 enabled，account configured，且有有效模型数量。
3. AdminPanel 的测试 Provider 可以返回成功。
4. `/v1/models` 能看到 Codex OAuth 模型。
5. 通过 `/v1/responses` 或 `/v1/chat/completions` 发起 streaming 请求，确认返回 200 且收到内容 delta。
6. 如果经过 bridge/proxy，再确认请求路径是 bridge -> VCP 主服务 -> provider route，而不是 bridge 直接消费 token。

验证和日志中不要输出 token、加密口令、账号原始标识或完整认证头。
