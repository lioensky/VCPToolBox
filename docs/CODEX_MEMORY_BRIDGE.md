# CodexMemoryBridge

**Version:** 1.1.1
**Last Updated:** 2026-04-26
**Scope:** `Plugin/CodexMemoryBridge/`

---

## 1. Purpose

`CodexMemoryBridge` is the policy gate for normal Codex memory writes.

- It enforces write-time rules at tool level (not only prompt-level guidance).
- It records every allow/reject decision for audit.
- It does not replace dream-channel persistence.

---

## 2. Write Targets

- `process`
- `knowledge`

`process` is for checkpoints, risks, todos, pending items, and stage conclusions.  
`knowledge` is for reusable and validated conclusions.

---

## 3. Policy Rules

### Shared Rules

- `title`, `content`, and `evidence` must all be present.
- Caller must be `agentAlias=Codex`.
- Any rule violation is handled as `fail-closed` (`decision=rejected`).

### `knowledge` Rules (strict)

- `validated=true` and `reusable=true` are both required.
- `sensitivity` must be exactly `none`.

### `process` Rules (relaxed on 2026-04-13)

- Content must include one of: `checkpoint`, `risk`, `todo`, `pending`, `stage-conclusion`.
- `sensitivity=none` is accepted.
- Non-`none` sensitivity is accepted unless it matches high-risk markers.
- High-risk markers are rejected, including:  
  `secret`, `unsafe`, `credential`, `password`, `token`, `api key`.

---

## 4. Execution Context

Bridge evaluation depends on execution context passed from tool execution:

- `VCP_EXECUTION_CONTEXT`
- `VCP_AGENT_ALIAS`
- `VCP_AGENT_ID`
- `VCP_REQUEST_SOURCE`

If context is missing or alias is not `Codex`, write is rejected.

---

## 5. Audit Log

Every bridge decision is appended to:

- `logs/codex-memory-bridge.jsonl`

Main fields:

- `timestamp`
- `agentAlias`
- `agentId`
- `decision`
- `target`
- `title`
- `memoryId`
- `reason`
- `filePath`

---

## 6. Storage and Recall Consistency

`knowledge` writes now target the canonical diary:

- write target maid: `[Codex的知识]Codex`
- diary folder: `dailynote/Codex的知识/`
- accepted result `targetDiary`: `Codex knowledge`
- accepted result `reason`: `written to Codex knowledge.`

`search_memory` for `target=knowledge` queries the same canonical diary name from:

- `modules/codexMemoryConstants.js`

This alignment prevents "accepted write but search miss" caused by mismatched diary names.

The storage diary name and the returned display/API fields are intentionally not
identical. The Chinese diary folder is the durable storage target; the English
`targetDiary` and `reason` strings are observable API contract fields used by
tests, audit readers, and tool callers. Do not localize those return fields
without a dedicated contract migration.

---

## 7. Admin Monitoring

Bridge runtime observability has a backend overview route:

- overview API: `GET /admin_api/codex-memory/overview`
- backend route: `routes/admin/codexMemory.js`

Current wiring:

- `adminServer.js` mounts `codexMemory` as a local admin module.
- `server.js` mounts the Codex memory MCP route at `/mcp/codex-memory`.
- `server.js` does not directly mount `routes/admin/codexMemory.js` into the
  main `adminPanelRoutes` router.

Current UI status:

- The legacy `AdminPanel/js/codex-memory-monitor.js` surface is not present in
  current `prod/stable`.
- The current admin frontend is Vue under `AdminPanel-Vue`.
- A native Vue Codex memory monitoring page has not been implemented yet.

If frontend monitoring is added, implement it in `AdminPanel-Vue` and call the
existing `GET /admin_api/codex-memory/overview` endpoint. Do not restore the old
`AdminPanel/js` module shape.

---

## 8. Codex Memory MCP Governance

The existing MCP route is the native Codex memory tool surface:

- HTTP route: `/mcp/codex-memory`
- router: `routes/codexMemoryMcp.js`
- tools: `record_memory`, `search_memory`, `memory_overview`

Authentication boundary:

- By default the main server bearer token protects `/mcp/codex-memory`.
- `ENABLE_CODEX_MEMORY_MCP_LOOPBACK=true` may allow loopback-only local MCP
  access without the bearer middleware.
- Do not expose this route on a non-loopback host without an explicit review.

Tool boundaries:

- `search_memory` is read-only semantic recall over the Codex process and
  knowledge diaries.
- `memory_overview` is read-only operational observability over audit and recall
  logs.
- `record_memory` is write-capable, but it does not bypass policy. It always
  calls `CodexMemoryBridge.record` through `executeToolCallWithContext()` with
  `agentAlias=Codex` and `requestSource=codex-desktop-mcp`.

Write approval boundary:

- `record_memory` is still subject to the same `CodexMemoryBridge` rejection
  rules as normal VCP tool execution.
- `knowledge` writes require `validated=true`, `reusable=true`, and
  `sensitivity=none`.
- `process` writes must include checkpoint/risk/todo/pending/stage-conclusion
  language and must not contain high-risk sensitivity markers.
- Secrets, credentials, tokens, raw env values, temporary logs, unverified
  guesses, and private one-off data are not valid long-term memory.

MCP client configuration example:

```json
{
  "mcpServers": {
    "vcp_codex_memory": {
      "url": "http://127.0.0.1:6005/mcp/codex-memory",
      "headers": {
        "Authorization": "Bearer <VCP_SERVER_KEY>"
      }
    }
  }
}
```

If loopback bypass is explicitly enabled for local development, omit the
`headers` block only for that local-only setup.

Per-tool approval recommendation:

- Allow `search_memory` and `memory_overview` as read-only tools.
- Keep `record_memory` visibly write-capable in the client UI or approval
  policy.
- Review `record_memory` arguments before use when the memory contains personal,
  project-sensitive, or long-lived operational information.

`memory_review` decision:

- Do not add a separate `memory_review` tool yet.
- Current write attempts are already dry-governed by `CodexMemoryBridge`: unsafe
  candidates return `decision=rejected` and are audited.
- Add `memory_review` only if future client UX needs a non-writing preflight
  distinct from a rejected write attempt.

Bridge relationship:

- `VCPBridgeServer` handles model requests entering VCPToolBox.
- `/mcp/codex-memory` exposes native memory tools to Codex-compatible MCP
  clients.
- Do not create a second duplicate memory MCP server unless the existing route
  cannot satisfy the client protocol after a dedicated compatibility review.

---

## 9. Related Files

- `Plugin/CodexMemoryBridge/plugin-manifest.json`
- `Plugin/CodexMemoryBridge/codex-memory-bridge.js`
- `modules/codexMemoryConstants.js`
- `modules/codexMemorySearch.js`
- `modules/vcpLoop/toolExecutor.js`
- `routes/codexMemoryMcp.js`
- `routes/admin/codexMemory.js`
- `adminServer.js`
- `AdminPanel-Vue/`

---

## 10. 2026-04-13 Change Notes

- Relaxed `process` sensitivity policy (no longer binary reject for all non-`none` values).
- Kept `knowledge` policy strict (`sensitivity=none` + `validated=true` + `reusable=true`).
- Fixed `knowledge` write path to canonical `Codex的知识` diary for search consistency.

## 11. 2026-05-26 Contract Review

- Reviewed the dirty-worktree `.new.js` i18n variant without copying it.
- Rejected direct replacement because it changes observable `targetDiary` and
  `reason` fields.
- Added regression coverage for the current knowledge-write response contract:
  `targetDiary=Codex knowledge`, `reason=written to Codex knowledge.`, and
  file path under `dailynote/Codex的知识/`.

## 12. 2026-06-01 MCP Governance Review

- Clarified MCP tool annotations: `search_memory` and `memory_overview` are
  read-only, while `record_memory` is write-capable.
- Clarified initialize instructions so MCP clients can distinguish recall,
  observability, and durable-memory writes.
- Documented bearer/loopback boundaries, per-tool approval recommendations, and
  the current decision not to add `memory_review`.
