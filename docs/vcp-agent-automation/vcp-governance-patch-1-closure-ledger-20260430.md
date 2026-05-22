# VCP Governance Patch 1 Closure Ledger

> Date: 2026-04-30
> Scope: Patch 1A-1H closure review for VCP tool execution governance
> Branch reality checked against: `origin/prod/stable @ 6ceb8a0`
> Related design: `docs/vcp-agent-automation/vcp-governance-patch-1-design-20260429.md`
> Related strategy: `docs/vcp-agent-automation/vcp-agent-automation-governance-strategy-20260429.md`

## Purpose

This note records what Patch 1 of VCP tool execution governance has actually
landed on `prod/stable`, what was reverted, what remains intentionally deferred,
and what the next safe step should be.

This is a closure ledger, not a new design document.

## Executive Snapshot

Patch 1 is substantially complete as a governance foundation.

What is now true on `prod/stable`:

- tool identity can be normalized for approval matching
- caller context is normalized across the main direct entrypoints
- approval compatibility works across canonical and legacy names
- approval requests can carry sanitized evidence and arg-shape preview
- bridge and tool-executor paths now preserve more execution metadata

What is not yet true:

- VCP does not yet have effect classification
- VCP does not yet have a central risk engine
- VCP does not yet grant narrow autonomy based on governance evidence
- Patch 1 identity evidence extras from `1D` are not active on `prod/stable`

Conclusion:

```text
Patch 1 is a usable governance baseline,
not a finished autonomy system.
```

## Patch 1A-1H Status

| Patch | Stable status | PR / merge state | Current assessment |
| --- | --- | --- | --- |
| `1A` identity + approval compatibility | active | PR `#26` merged | complete for Patch 1 baseline |
| `1B` request-source context rollout | active | PR `#33` merged | complete for intended direct entrypoints |
| `1C` approval evidence | active | PR `#34` merged | complete for approval request evidence baseline |
| `1D` extra identity evidence fields | reverted | PR `#35` merged, then reverted by PR `#36` | not active on stable; requires separate re-justification |
| `1E` args preview evidence | active | PR `#37` merged | complete for sanitized arg-shape preview |
| `1F` shared execution-context helper | active | PR `#38` merged | complete for shared normalization helper |
| `1G` bridge metadata propagation | active | PR `#39` merged | complete for bridge-origin metadata baseline |
| `1H` ToolExecutor metadata propagation | active | PR `#40` merged | complete for tool-executor path alignment |

## Landed Capabilities

### 1. Identity normalization exists and is narrow

Stable line now contains a side-effect-free resolver in
`modules/toolIdentityResolver.js`.

Current alias table is still narrow and evidence-backed:

- `PowerShellExecutor` -> `ServerPowerShellExecutor`
- `FileOperator` -> `ServerFileOperator`
- `LocalSearchController` -> `ServerSearchController`
- `VCPEverything` -> `ServerSearchController`
- `CodeSearcher` -> `ServerCodeSearcher`

Current behavior remains conservative:

- exact registered names stay exact
- known aliases map to canonical names for governance matching
- unknown names remain unknown
- `toolArgs.command` can be extracted as command context
- command identifiers do not become standalone tool aliases

Primary implementation:

- `modules/toolIdentityResolver.js`
- `tests/toolIdentityResolver.test.js`

### 2. Approval compatibility now protects canonical backend tools

`modules/toolApprovalManager.js` now resolves identity before approval matching.

Current approval matching can consider:

- requested tool name
- canonical tool name
- known aliases for the canonical tool
- command-specific forms of those names

Regression-sensitive legacy behavior remains present:

- `approveAll`
- `::SilentReject`
- exact matching for unknown tools
- command names are not promoted into tools
- unrelated tool families do not cross-match

Primary implementation:

- `modules/toolApprovalManager.js`
- `tests/toolApprovalManager.test.js`

### 3. Execution context is normalized across the main governance path

Stable line now has shared context normalization in
`modules/toolExecutionContext.js`.

Current normalized shape supports:

- `agentAlias`
- `agentId`
- `requestSource`
- `operatorId`
- `bridgeId`
- `taskId`
- `invocationId`

Known direct-entry source tags now present in stable code:

- `chatCompletionHandler`
- `codex-desktop-mcp`
- `human-tool-route`
- `task-scheduler`
- `snowbridge`
- `vcp-tool-bridge`
- `ai-image-pipeline`

Primary implementation:

- `modules/toolExecutionContext.js`
- `tests/toolExecutionContext.test.js`
- `modules/chatCompletionHandler.js`
- `routes/taskScheduler.js`
- `server.js`
- `routes/codexMemoryMcp.js`
- `Plugin/SnowBridge/index.js`
- `Plugin/VCPToolBridge/index.js`
- `modules/aiImageExecutionAdapter.js`

### 4. Approval evidence now exists and is sanitized

Stable line approval requests now carry structured evidence built by
`modules/toolApprovalEvidence.js`.

Current evidence baseline includes:

- `requestedToolName`
- `canonicalToolName`
- `matchedRule`
- `matchedCommand`
- `wasAlias`
- `requestSource`
- `agentAlias`
- `agentId`
- `requiresApproval`
- `notifyAiOnReject`
- optional `operatorId`
- optional `bridgeId`
- optional `taskId`
- optional `invocationId`
- optional `argsPreview`

Current safety property:

- raw args are not copied into evidence
- secret-like arg keys are marked in preview, not exposed by value
- preview records arg shape only

Primary implementation:

- `modules/toolApprovalEvidence.js`
- `tests/toolApprovalEvidence.test.js`
- `Plugin.js`

### 5. ToolExecutor path is now aligned with shared context normalization

Stable line now reuses `normalizeExecutionContext()` inside
`modules/vcpLoop/toolExecutor.js` instead of carrying a separate local shape.

This means the tool-executor path no longer strips the newer optional metadata
fields introduced by the shared governance context.

Primary implementation:

- `modules/vcpLoop/toolExecutor.js`
- `tests/toolExecutorExecutionContext.test.js`

## Reverted Or Not In Stable State

### Patch 1D is not part of the current stable baseline

`PR #35` added extra identity evidence fields:

- `registeredPluginName`
- `identityConfidence`

Those changes were reverted by `PR #36`.

That means the current stable line still has:

- requested tool identity
- canonical tool identity
- alias flag

But it does not currently expose the extra identity evidence fields that `1D`
briefly introduced.

This should be treated as:

```text
designed and attempted,
but not accepted into the active stable baseline.
```

Reintroduction, if desired later, should happen as a separate small review
slice with a clear reason for why the reverted fields are needed.

## Explicitly Deferred Beyond Patch 1

The following items should still be considered deferred, not partially done:

- `EffectClassifier`
- `RiskPolicyEngine`
- low-risk default auto-allow
- global risk scoring
- manifest-wide effect metadata cleanup
- autonomy based on governance evidence
- execution dispatch rewriting based on canonical identity

Stable line should still follow this order:

```text
stabilize identity
stabilize context
preserve approval compatibility
classify effect
then grant narrow autonomy
```

## Current Gaps And Residual Risk

1. Patch 1 evidence is still approval-centric.

It is strong enough to support manual review and compatibility checks, but not
yet a complete central decision record for automated allow / reject policy.

2. Some governance evidence was intentionally kept minimal.

The stable line avoids carrying raw args, env values, or secret-bearing data,
which is correct for safety, but it also means later autonomy work will need a
carefully designed evidence model rather than simply reusing approval payloads.

3. `1D` shows that identity evidence detail is not yet settled.

The stable line knows enough to protect canonical tools with legacy rules, but
it has not finalized how much identity metadata should be surfaced in audit
evidence by default.

4. Patch 1 does not prove effect safety.

It proves who is calling what, from where, and under which approval matching
surface. It does not yet prove what the tool can safely do without approval.

## Recommended Next Step

The safest next move is not `Patch 2` implementation yet.

The safest next move is a small design-only closure follow-up with this shape:

1. confirm that Patch 1A-1H is the accepted baseline except for reverted `1D`
2. decide whether `registeredPluginName` and `identityConfidence` should return
3. define a minimal `EffectClassifier` contract without enabling autonomy
4. define what evidence is required before any low-risk auto-allow is discussed

Suggested framing for the next design slice:

```text
Patch 2 should classify effect evidence,
not grant automatic permission.
```

## Final Position

As of `origin/prod/stable @ 6ceb8a0`, VCP tool execution governance has a real
foundation layer in production history.

That foundation is now strong enough to say:

```text
VCP can usually tell
what tool was requested,
what canonical tool it maps to,
which entrypoint invoked it,
and which approval rule matched.
```

It is not yet strong enough to say:

```text
VCP can safely skip human approval for low-risk operations.
```

That boundary should remain explicit.
