# VCPBridgeServer

VCPBridgeServer is a loopback-only API proxy for local CLI tools that cannot edit their system prompt directly. It can inject or replace system messages and map model names before forwarding requests to an upstream OpenAI-compatible, Anthropic, Gemini, or Responses API.

This stable-line version is intentionally conservative: the service is disabled by default and refuses non-loopback bind hosts.

## Enable

Copy the example file only when you intentionally want the proxy:

```bash
cd Plugin/VCPBridgeServer
cp config.env.example config.env
```

Minimal local configuration:

```env
BRIDGE_ENABLED=true
BRIDGE_BIND_HOST=127.0.0.1
BRIDGE_PORT=3100
BRIDGE_UPSTREAM_URL=https://api.openai.com
BRIDGE_UPSTREAM_TYPE=chat
BRIDGE_MODEL=gpt-4.1-mini
BRIDGE_SYSTEM_PROMPT=my_rules.txt
BRIDGE_HIJACK_MODE=prepend
```

`BRIDGE_UPSTREAM_KEY` is optional. If it is empty, the proxy passes through the caller's protocol-specific auth header (`Authorization`, `x-api-key`, or `x-goog-api-key`).

## ChatGPT Codex OAuth Provider Split

The bridge does not own OAuth credentials. When Codex needs ChatGPT/Codex
OAuth, keep the bridge pointed at the VCPToolBox main service and enable the
provider on the main service:

```env
# VCPToolBox main service
VCP_OAUTH_AUTH_CENTER_ENABLED=true
VCP_OAUTH_TOKEN_ENCRYPTION_KEY=YOUR_LOCAL_OAUTH_LOCK_PASSWORD
VCP_RESPONSES_PROVIDER=codex_oauth

# VCPBridgeServer
BRIDGE_ENABLED=true
BRIDGE_BIND_HOST=127.0.0.1
BRIDGE_PORT=3100
BRIDGE_UPSTREAM_URL=
BRIDGE_UPSTREAM_TYPE=responses
BRIDGE_MODEL=gpt-5.5
BRIDGE_HIJACK_MODE=append
BRIDGE_SYSTEM_PROMPT=your_rules.txt
BRIDGE_CLIENT_KEY=<REDACTED_CLIENT_KEY>
```

With this split:

- downstream client calls `POST /v1/responses` on VCPBridgeServer.
- the bridge injects the configured prompt policy and forwards a Responses
  request to VCPToolBox main service `POST /v1/responses`.
- the main service provider calls `OAuthAuthManager.getValidToken('codex_oauth')`
  and forwards to `https://chatgpt.com/backend-api/codex/responses`.

This preserves the bridge design: no token storage, no OAuth refresh, no
provider-specific account selection in the bridge process.

Operational flow:

1. Set `VCP_OAUTH_AUTH_CENTER_ENABLED=true` and choose your own local `VCP_OAUTH_TOKEN_ENCRYPTION_KEY` string.
2. Restart or reload the AdminPanel backend so the OAuth Auth Center route is mounted.
3. Open VCPToolBox AdminPanel -> OAuth Auth Center.
4. Log in to `ChatGPT / Codex OAuth`.
5. In the same Codex card, enable `VCP Responses Provider`.
6. Use `测试 Provider` to run a read-only upstream model-catalog check.
7. Configure VCPBridgeServer with `BRIDGE_UPSTREAM_TYPE=responses` and leave
   `BRIDGE_UPSTREAM_URL` empty unless the main service is on a non-default URL.

Model selection:

- The main service first asks the Codex OAuth upstream model catalog.
- If that catalog is unavailable, `VCP_CODEX_OAUTH_MODELS` is used as the local
  fallback list.
- If `VCP_CODEX_OAUTH_MODELS` is empty, the built-in fallback list is exposed.
- Set `BRIDGE_MODEL` to one of the models exposed by the main service
  `GET /v1/models` response. `BRIDGE_MODEL_MAP` can still rewrite downstream
  model aliases before the bridge forwards the request.

Codex client config:

```toml
model_provider = "vcp_bridge"
model = "gpt-5.5"

[model_providers.vcp_bridge]
name = "VCP Bridge"
base_url = "http://127.0.0.1:3100/v1"
env_key = "VCP_BRIDGE_KEY"
wire_api = "responses"
```

Set `VCP_BRIDGE_KEY` to the same value as `BRIDGE_CLIENT_KEY` in your local
VCPBridgeServer config. Do not paste the key into this file or commit it:

```powershell
[Environment]::SetEnvironmentVariable("VCP_BRIDGE_KEY", "<your BRIDGE_CLIENT_KEY>", "User")
```

Restart Codex, or open a fresh Codex session, after changing the config or
environment variable. Use a model exposed by the local VCPToolBox
`GET /v1/models` response; when `codex_oauth` is enabled, `gpt-5.5` routes
through the ChatGPT/Codex OAuth provider.

`VCP_RESPONSES_PROVIDER` is a VCPToolBox main-service setting, not a bridge
setting. The main `/v1/responses` provider route reads the current
`config.env` cascade when handling requests, so saving this key from the
admin Base Config page is enough for this route to observe the provider choice.
Long-running callers may still need to reload their own client-side bridge
configuration if they changed bridge keys or ports.

Troubleshooting:

- `401` from the main service usually means the caller did not provide the VCP
  main-service key when calling the main service directly.
- `codex_oauth_provider_failed` with `404` usually means no local Codex OAuth
  account is available or the configured account id no longer exists.
- `codex_oauth_provider_failed` with `400` can mean the upstream rejected the
  request body. The main provider supplies default `instructions` for bridge
  Responses requests; keep `BRIDGE_UPSTREAM_TYPE=responses` when routing Codex
  OAuth through the bridge.
- `codex_oauth_provider_failed` with `502` usually means token refresh,
  upstream network, timeout, or non-JSON upstream failure. Re-run `测试
  Provider` in AdminPanel to confirm the OAuth account and upstream model
  catalog before testing the bridge again.
- `VCP_CODEX_OAUTH_UPSTREAM_TIMEOUT_MS` controls the main-service Codex OAuth
  upstream timeout. `BRIDGE_UPSTREAM_TIMEOUT_MS` controls the bridge-to-main
  request timeout.

## Supported Downstream Endpoints

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `POST /v1beta/models/:model:generateContent`
- `POST /v1beta/models/:model:streamGenerateContent`

All request bodies are normalized into messages, the configured system prompt policy is applied, then the request is rebuilt for the configured upstream protocol. When `BRIDGE_UPSTREAM_TYPE=responses`, the bridge rebuilds the request as a Responses request and forwards it to the configured upstream Responses API, typically the local VCPToolBox main service.

## Hijack Modes

- `off`: no prompt injection
- `replace`: remove existing system messages and insert the configured prompt
- `prepend`: add the configured prompt before all existing messages
- `append`: add the configured prompt after the last existing system message

## Model Map

Use `BRIDGE_MODEL_MAP` to rewrite model names:

```env
BRIDGE_MODEL_MAP=gpt-4o:claude-sonnet-4,gpt-4.1-mini:gemini-2.5-flash
```

## Safety Notes

- The proxy does not start unless `BRIDGE_ENABLED=true`.
- Only `127.0.0.1`, `localhost`, and `::1` are accepted as bind hosts.
- Secret values are not printed by the plugin.
- `BRIDGE_SYSTEM_PROMPT` may be inline text or a `.txt` filename in this plugin directory. Arbitrary paths are not loaded.
