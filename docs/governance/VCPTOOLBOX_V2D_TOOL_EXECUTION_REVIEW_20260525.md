# Package V2D Review: Tool Execution Route

Review time: 2026-05-25 18:15 Asia/Shanghai.

Worktree reviewed: `A:/VCP/VCPToolBox`.

Baseline: current `origin/main` at `55b51ca`.

Scope:

- `modules/toolExecution.js`
- `routes/toolExecutionRoutes.js`
- `tests/messageProcessor.test.js`
- `tests/channelHub-hardening.test.js`
- related `server.js` / `modules/messageProcessor.js` diff shape

This was a read-only review. No tool execution route was invoked, no files in `A:/VCP/VCPToolBox` were modified, and no branch was merged.

## 1. Summary

Do not migrate Package V2D into current `main`.

Reason: the dirty worktree contains an alternate JSON tool execution route that would widen the direct tool execution surface if copied into current main.

Current `main` intentionally keeps `routes/toolExecutionRoutes.js` as a compatibility shim:

- `server.js` requires and mounts it so startup does not fail.
- The actual human tool route remains directly implemented in `server.js` at `/v1/human/tool`.
- The existing `/v1/human/tool` route tags calls with `{ requestSource: 'human-tool-route' }`.
- `tests/humanToolRouteExecutionContext.test.js` verifies that behavior.

## 2. Risk Finding

The dirty worktree has an untracked `routes/toolExecutionRoutes.js` that defines:

- `POST /v1/human/tool-with-context`
- JSON body fields: `toolName`, `toolArgs`, `executionContext`
- direct call to `executeToolCallWithContext(...)`

If copied into current `main`, this endpoint would be mounted by the existing:

```js
app.use(toolExecutionRoutes({ pluginManager }));
```

This creates a new direct execution surface. The route accepts caller-provided `executionContext`, which could allow spoofed `requestSource`, `agentAlias`, `operatorId`, `taskId`, or other governance evidence fields unless a separate policy layer normalizes and constrains it.

This is not a branch-cleanup migration. It is a security-sensitive API design change.

## 3. Current Main State

Current `main` already has the safe shared helper:

- `modules/toolExecution.js`
  - `getClientIp(req)`
  - `executeToolCallWithContext({ pluginManager, req, toolName, toolArgs, executionContext })`

Current `main` also has broader execution-context coverage:

- `modules/toolExecutionContext.js`
- `modules/vcpLoop/toolExecutor.js`
- `tests/toolExecutionContext.test.js`
- `tests/toolExecutorExecutionContext.test.js`
- `tests/humanToolRouteExecutionContext.test.js`
- bridge/task/AI image execution-context tests

Therefore the untracked V2D files are not needed to recover current main functionality.

## 4. Message Processor / Server Diff Notes

Against `origin/main`, the dirty worktree version of `modules/messageProcessor.js` and `server.js` is older and would remove current main-line behavior, including:

- dynamic tool injection support through `{{VCPDynamicTools}}`,
- `sarPromptManager`-based prompt resolution,
- broader async result placeholder compatibility,
- server lifecycle/draining/shutdown handling,
- current human tool route execution-context tagging.

The local dirty `server.js` hunk adds `/v1/embedding/fallback-stats`, which belongs to the already-reviewed V2A/RAG area, not V2D. It should not be migrated as part of tool execution route governance.

## 5. Decision Table

| Area | Decision | Reason |
| --- | --- | --- |
| `routes/toolExecutionRoutes.js` JSON endpoint | Reject | New direct tool execution route; accepts caller-supplied execution context; security/API design change. |
| `modules/toolExecution.js` | Already present in current main | No migration needed. |
| `tests/channelHub-hardening.test.js` | Already present in current main | No migration needed from dirty worktree. |
| `tests/messageProcessor.test.js` | Defer | Could be useful as tests, but must be adapted to current `messageProcessor.js` and reviewed separately. |
| `server.js` fallback-stats hunk | Reject for V2D | Belongs to V2A and should not be mixed into tool execution review. |

## 6. Final Recommendation

Status: reject V2D tool execution route migration into current `main`.

Allowed future package:

- If a JSON human-tool endpoint is desired, design it as a separate governance patch with:
  - explicit authentication/authorization boundary,
  - fixed server-side `requestSource`,
  - strict execution-context allowlist,
  - approval compatibility tests,
  - no real shell/file/bridge execution in tests.

Blocked actions:

- Do not copy dirty `routes/toolExecutionRoutes.js` into `main`.
- Do not expose `/v1/human/tool-with-context` from this dirty worktree.
- Do not accept caller-provided execution context without a separate policy design.

## 7. Next Recommendation

Continue with Package V2E: image/plugin source review.
