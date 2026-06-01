# VCPBridgeServer

VCPBridgeServer is a loopback-only API proxy for local CLI tools that cannot edit their system prompt directly. It can inject or replace system messages and map model names before forwarding requests to an upstream OpenAI-compatible, Anthropic, or Gemini API.

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

## Codex + VCPToolBox Memory Gateway

Use this profile when Codex should send model requests into the local VCPToolBox main service, so VCPToolBox can apply its memory, RAG, plugin prompt, context, and model-routing pipeline.

```env
BRIDGE_ENABLED=true
BRIDGE_PROFILE=codex-vcp-memory
BRIDGE_BIND_HOST=127.0.0.1
BRIDGE_PORT=3100
BRIDGE_UPSTREAM_URL=
BRIDGE_UPSTREAM_TYPE=chat
BRIDGE_HIJACK_MODE=append
BRIDGE_SYSTEM_PROMPT=prompts/codex_vcp_memory.strict.txt
BRIDGE_REQUIRE_VCP_UPSTREAM=true
BRIDGE_CLIENT_KEY=<REDACTED_CLIENT_KEY>
```

Leaving `BRIDGE_UPSTREAM_URL` empty forwards to the local VCPToolBox main server inferred from `PORT`, for example `http://127.0.0.1:${PORT}`. Set an explicit URL only when the main server runs on a different port, such as `http://127.0.0.1:5890`.

The profile defaults to `append`, not `replace`, so Codex keeps its native coding-agent instructions while the VCP memory policy is added as a supplemental system message.

Memory prompt profiles:

- `prompts/codex_vcp_memory.strict.txt`: default for this profile. Use for normal work; writes long-term memory only when durability, reuse, and sensitivity checks all pass.
- `prompts/codex_vcp_memory.balanced.txt`: allows more proactive recall and handoff support, while keeping the same memory contamination firewall.
- `prompts/codex_vcp_memory.aggressive.txt`: high-risk experimental mode. It must be chosen explicitly and does not weaken approval, secret, or verification boundaries.

Memory write boundary:

- The bridge can add memory policy to model requests, but it does not directly write memory.
- Durable memory writes still belong to the existing VCPToolBox/Codex memory tool path and its approval, validation, and sensitivity rules.
- Temporary logs, unverified guesses, raw command output, secrets, and private one-off data should stay out of long-term memory.
- Recalled memory is context, not authority; verify it against current files, user instructions, or observed command output before acting on it.

This mode is still a model-request gateway:

- It is not a native Codex plugin.
- It is not an MCP server.
- It does not expose all VCP plugins as Codex tools.
- Use the existing Codex memory MCP route for native memory tools when needed.

For native memory tool access, configure Codex-compatible MCP clients to use the
existing `/mcp/codex-memory` route. Keep `record_memory` approval-visible because
it can write durable memory through `CodexMemoryBridge`; `search_memory` and
`memory_overview` are read-only.

## Supported Downstream Endpoints

- `GET /health`
- `GET /doctor`
- `GET /doctor/codex-config`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `POST /v1beta/models/:model:generateContent`
- `POST /v1beta/models/:model:streamGenerateContent`

All request bodies are normalized into messages, the configured system prompt policy is applied, then the request is rebuilt for the configured upstream protocol.

For `POST /v1/responses`, the bridge uses both top-level `instructions` and `input` when constructing upstream chat messages. It maps `max_output_tokens` to chat `max_tokens` and preserves `stream_options` for chat-compatible upstreams.

The bridge does not emulate the full Responses API. Unsupported top-level fields such as `tools`, `tool_choice`, `parallel_tool_calls`, `previous_response_id`, `truncation`, and `reasoning` are not forwarded. When present, they are reported through `X-VCP-Bridge-Dropped-Fields`; in debug mode they are also logged.

## Doctor

`GET /doctor` returns a sanitized diagnostic report for the bridge profile, bind address, upstream URL, prompt status, Codex base URL, and warnings. It does not return keys.

When an upstream key is available and the upstream type is `chat`, the doctor can probe `GET /v1/models` to check reachability. If it cannot prove the upstream is VCPToolBox, it reports a warning instead of pretending compatibility is guaranteed.

`GET /doctor/codex-config` returns a TOML snippet for Codex:

```toml
model_provider = "vcp_bridge"
model = "gpt-4.1-mini"

[model_providers.vcp_bridge]
name = "VCP Bridge"
base_url = "http://127.0.0.1:3100/v1"
env_key = "VCP_BRIDGE_KEY"
wire_api = "responses"
```

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
- If `BRIDGE_CLIENT_KEY` is set, downstream requests must send it as `Authorization: Bearer ...` or `x-api-key`.
- Requests with an `Origin` header are rejected by default unless the origin matches the bridge itself.
- `BRIDGE_RATE_LIMIT_RPM` limits requests per client per minute; set `0` to disable.
- `BRIDGE_MAX_BODY_MB` controls the JSON body limit.
- Startup refuses configurations where `BRIDGE_UPSTREAM_URL` points back to the bridge itself.
- Secret values are not printed by the plugin.
- `BRIDGE_SYSTEM_PROMPT` may be inline text, a `.txt` filename, or a safe relative `.txt` path inside this plugin directory. Arbitrary paths are not loaded.

## Timeout Policy

Prefer split upstream timeouts for long-running VCPToolBox work:

```env
BRIDGE_UPSTREAM_CONNECT_TIMEOUT_MS=15000
BRIDGE_UPSTREAM_TOTAL_TIMEOUT_MS=0
BRIDGE_UPSTREAM_IDLE_TIMEOUT_MS=180000
```

- `CONNECT_TIMEOUT` covers connecting to the upstream and receiving response headers.
- `TOTAL_TIMEOUT` covers the whole upstream request; `0` disables the total cap.
- `IDLE_TIMEOUT` interrupts response/SSE reads when the upstream stops sending data.
- `BRIDGE_UPSTREAM_TIMEOUT_MS` is retained as a legacy fallback.

## Validation

Local checks:

```powershell
node --check Plugin\VCPBridgeServer\bridgeserver.js
node --test tests\vcp-bridge-server.test.js
npm test
npm run test:baseline
```

Manual loopback smoke, after starting the bridge in a local test configuration:

```powershell
curl http://127.0.0.1:3100/health
curl http://127.0.0.1:3100/doctor
curl http://127.0.0.1:3100/doctor/codex-config
```

If `BRIDGE_CLIENT_KEY` is configured, include `Authorization: Bearer <REDACTED_CLIENT_KEY>` or `x-api-key: <REDACTED_CLIENT_KEY>` in the smoke requests.

Common self-loop mistake:

```env
BRIDGE_PORT=3100
BRIDGE_UPSTREAM_URL=http://127.0.0.1:3100
```

The upstream must be the VCPToolBox main server or an external API provider, not the bridge port.
