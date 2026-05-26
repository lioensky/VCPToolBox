# Interaction Middleware / ChannelHub Operations

Updated: 2026-05-26 Asia/Shanghai.

This document describes the current implemented interaction middleware surface in
`main`. It is rewritten from current source behavior and does not import content
from the dirty `A:/VCP/VCPToolBox` worktree.

## Current Status

Implemented:

- ChannelHub service initialization during server startup.
- B2 inbound event endpoint: `POST /internal/channelHub/events`.
- Platform webhook endpoints under `/internal/channelHub/*`.
- Frozen B1 compatibility endpoints with migration headers.
- Adapter-level authentication and optional signature observation/enforcement.
- Event deduplication, message normalization, session binding, identity mapping,
  agent routing, runtime dispatch, reply normalization, delivery outbox, metrics,
  and audit logging modules.
- Admin observation and management routes under `/admin_api/channelHub/*`.

Not implemented here:

- A separate interaction-middleware runtime outside ChannelHub.
- A new public `/api/*` surface for external panels.
- Live platform provisioning, deployment, or secret management.
- Automatic migration of dirty worktree docs or generated reports.

Evidence:

- `server.js`: mounts `/internal/channelHub` and `/admin_api/channelHub`, then
  initializes `ChannelHubService` before injecting it into both route modules.
- `modules/channelHub/ChannelHubService.js`: documents and implements the main
  inbound/outbound pipeline.
- `routes/internal/channelHub.js`: defines B2, webhook, platform callback, B1
  compatibility, auth, signature, and deduplication route behavior.
- `routes/admin/channelHub.js`: defines admin health, adapter, binding, outbox,
  metrics, audit, identity, routing, and capability endpoints.
- `modules/channelHub/schemas/*.schema.json`: stores B2 event, runtime reply,
  adapter config, capability, and session binding schemas.
- `tests/channelHub-hardening.test.js`: covers hardening and compatibility
  behavior for ChannelHub paths.

## Inbound Route Map

Canonical B2 event path:

```text
POST /internal/channelHub/events
```

Use this path for new adapters. Requests should provide:

- `x-channel-adapter-id`: adapter id, recommended whenever more than one adapter
  can exist for the same channel.
- `x-channel-bridge-key`: adapter secret or bridge key accepted by
  `AdapterAuthManager`.
- JSON body shaped as a `ChannelEventEnvelope` or adapter-specific payload that
  the registered adapter can decode.

Other supported internal paths:

| Path | Status | Notes |
| --- | --- | --- |
| `GET /internal/channelHub/health` | Implemented | Internal health endpoint. |
| `POST /internal/channelHub/webhook/:channel` | Implemented | Generic webhook entry; resolves adapter by explicit id or unique enabled channel adapter. |
| `POST /internal/channelHub/dingtalk/callback` | Implemented | Platform callback with channel preset and signature middleware. |
| `POST /internal/channelHub/wecom/callback` | Implemented | Platform callback with channel preset and signature middleware. |
| `POST /internal/channelHub/feishu/callback` | Implemented | Platform callback with channel preset and signature middleware. |
| `POST /internal/channelHub/qq/callback` | Implemented | Platform callback with channel preset and signature middleware. |
| `POST /internal/channelHub/wechat/callback` | Implemented | Platform callback with channel preset and signature middleware. |
| `POST /internal/channelHub/b1/ingest` | Frozen compatibility | Adds B1 compatibility headers; migrate to B2. |
| `POST /internal/channelHub/channel-ingest` | Frozen compatibility | Historical alias for B1 compatibility. |

Important boundary:

- Do not use `/internal/channel-hub/events`; the current route mount is
  `/internal/channelHub`.

## Processing Flow

Current inbound flow:

```text
Express raw-body capture
  -> internal ChannelHub route
  -> request tracer
  -> service guard
  -> adapter auth
  -> optional signature middleware for platform callbacks
  -> optional event deduplication
  -> ChannelHubService.handleInboundEvent
  -> B1 translation if needed
  -> event schema validation
  -> adapter decode for non-B2 platform payloads
  -> message normalization
  -> session binding and identity mapping
  -> agent routing
  -> RuntimeGateway
  -> ReplyNormalizer
  -> DeliveryOutbox
```

Evidence:

- `server.js` stores raw request bytes through `captureRawBody` before JSON/body
  parsing, which signature validation depends on.
- `routes/internal/channelHub.js` resolves adapter context, authenticates, runs
  signature middleware for platform callbacks, and dispatches to
  `handleInboundEvent`.
- `ChannelHubService.handleInboundEvent` coordinates translation, validation,
  deduplication, normalization, binding, routing, runtime dispatch, reply
  normalization, and outbox enqueueing.

## Admin / Operations Surface

Admin prefix:

```text
/admin_api/channelHub
```

All admin routes use the existing Admin Basic Auth middleware from the main
server. They are operational controls, not public adapter ingress paths.

Implemented route groups:

| Group | Representative paths | Purpose |
| --- | --- | --- |
| Health | `/health`, `/health/ready`, `/health/live`, `/health/detailed` | Service and module readiness. |
| Adapters | `/adapters`, `/adapters/:id`, `/adapters/:id/enable`, `/adapters/:id/disable`, `/adapters/:id/test`, `/adapters/:id/health` | Adapter registry and lifecycle. |
| Bindings | `/bindings`, `/bindings/by-external/:adapterId/:externalSessionKey`, `/bindings/:id` | Session binding inspection and maintenance. |
| Outbox | `/outbox`, `/outbox/:id`, `/outbox/:id/retry`, `/outbox/:id/cancel`, `/outbox/stats`, `/outbox/dead-letters`, `/outbox/retry-batch`, `/outbox/cleanup` | Delivery queue visibility and retry/cancel operations. |
| Dead letter | `/dead-letter/stats`, `/dead-letter/cleanup`, `/dead-letter/retry-channel` | Dead-letter inspection and replay controls. |
| Metrics | `/metrics`, `/metrics/summary`, `/metrics/realtime`, `/metrics/channel/:channel`, `/metrics/adapter/:adapterId`, `/metrics/events/distribution`, `/metrics/errors` | Metrics snapshots. |
| Audit | `/audit-logs` | Audit log query. |
| Identity | `/identities`, `/identities/:id` | External identity mapping. |
| Routing | `/routing` | Agent routing policies. |
| Capabilities | `/capabilities`, `/capabilities/:channel` | Capability profile inspection and patching. |

Operational caution:

- Adapter deletion, disabling, capability patching, outbox retry, dead-letter
  replay, and identity/routing updates can affect live message flow. Treat them
  as operational writes.
- `/outbox/cleanup` is currently non-destructive in the route implementation; do
  not document it as deleting jobs unless the implementation changes.

## Security Boundaries

Current boundaries:

- `/internal/channelHub/*` does not use normal `/v1/*` Bearer auth. It uses
  adapter-level auth through `AdapterAuthManager`.
- Platform callback signature validation uses raw request body bytes where
  available.
- `CHANNEL_HUB_SIGNATURE_MODE=enforce` is required to reject invalid signatures;
  otherwise invalid signatures are observed and annotated.
- B1 endpoints are frozen compatibility paths. They add headers recommending
  `/internal/channelHub/events`.
- If more than one enabled adapter exists for a channel, requests should provide
  `x-channel-adapter-id`; otherwise adapter resolution can fail.

Do not document real adapter secrets, bridge keys, webhook signing secrets, or
captured platform payloads in repository docs.

## State And Files

Default runtime state is stored under `state/channelHub` unless config overrides
the base/state paths.

Important files:

- `modules/channelHub/constants.js`: default state directory and protocol
  constants.
- `modules/channelHub/StateStore.js`: persisted state access.
- `modules/channelHub/AdapterRegistry.js`: adapter records and capability
  profiles.
- `modules/channelHub/SessionBindingStore.js`: external conversation to VCP
  session binding.
- `modules/channelHub/IdentityMappingStore.js`: external user identity mapping.
- `modules/channelHub/DeliveryOutbox.js`: outbound delivery queue and dead-letter
  handling.
- `modules/channelHub/AuditLogger.js`: audit log writing/query support.

Runtime state should not be committed as source.

## Validation

Local static validation for this document:

- Search current source for route mounts and endpoint names.
- Compare route names against `routes/internal/channelHub.js` and
  `routes/admin/channelHub.js`.
- Run the ChannelHub hardening test when changing behavior, routes, or
  compatibility expectations:

```powershell
node --test tests/channelHub-hardening.test.js
```

This documentation checkpoint did not start live platform services or send live
webhooks.
