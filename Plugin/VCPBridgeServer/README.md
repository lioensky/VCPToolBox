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

## Supported Downstream Endpoints

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `POST /v1beta/models/:model:generateContent`
- `POST /v1beta/models/:model:streamGenerateContent`

All request bodies are normalized into messages, the configured system prompt policy is applied, then the request is rebuilt for the configured upstream protocol.

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
