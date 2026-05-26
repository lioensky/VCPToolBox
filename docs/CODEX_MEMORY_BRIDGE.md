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

## 8. Related Files

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

## 9. 2026-04-13 Change Notes

- Relaxed `process` sensitivity policy (no longer binary reject for all non-`none` values).
- Kept `knowledge` policy strict (`sensitivity=none` + `validated=true` + `reusable=true`).
- Fixed `knowledge` write path to canonical `Codex的知识` diary for search consistency.

## 10. 2026-05-26 Contract Review

- Reviewed the dirty-worktree `.new.js` i18n variant without copying it.
- Rejected direct replacement because it changes observable `targetDiary` and
  `reason` fields.
- Added regression coverage for the current knowledge-write response contract:
  `targetDiary=Codex knowledge`, `reason=written to Codex knowledge.`, and
  file path under `dailynote/Codex的知识/`.
