# VCP Agent Automation Governance Strategy

> Date: 2026-04-29
> Status: strategy draft
> Scope: VCPToolBox agent automation governance direction
> Constraint: strategy only; no implementation authorization
> Evidence base: `docs/vcp-agent-automation/vcp-agent-automation-molecular-recon-20260429.md`

## Decision

VCP should not jump directly into "high-autonomy agent execution."

The next strategic direction should be:

```text
governed automation before autonomous automation
```

That means VCP first builds a small, reliable governance spine around existing
tool execution:

```text
canonical tool identity
+ normalized caller context
+ approval compatibility
+ effect classification
+ audit evidence
```

Only after those layers are observable and tested should VCP allow agents to
skip human approval for low-risk operations.

## Strategic Thesis

VCP does not primarily lack agent intelligence.

It lacks a stable execution contract that can answer four questions before a
tool runs:

1. What exact tool is being called?
2. Who or what is calling it?
3. What effect can this call have?
4. What policy decision and audit evidence should attach to it?

Until those questions are answered consistently, "automatic low-risk approval"
would be premature.

## Current Reality

VCP already has useful safety ingredients:

- static manual approval via `ToolApprovalManager`
- plugin-local safety models such as AI Image pipeline safety
- DingTalk gray-stage and dry-run behavior
- LinuxShellExecutor read/safe/write/danger command levels
- CodexMemoryBridge context-gated memory writes
- bridge-level controls in SnowBridge

But those controls are not yet composed into a single runtime governance layer.

The current weak points are:

- tool names are not canonical across examples, command identifiers, display
  names, and `manifest.name`
- approval rules match raw names instead of canonical identity
- several direct execution entrypoints do not pass `executionContext`
- manifest-level effect metadata is mostly absent
- tests focus on plugin-local policy, not central execution governance

## Governing Principles

### 1. Identity Before Risk

Do not build risk scoring on top of unstable names.

VCP must first distinguish:

- `requestedToolName`
- `canonicalToolName`
- `registeredPluginName`
- `displayName`
- `command`
- `commandIdentifier`

Example:

```text
requestedToolName = PowerShellExecutor
canonicalToolName = ServerPowerShellExecutor
command = Get-ChildItem
```

Policy decisions must run against canonical identity while preserving requested
identity for compatibility and audit.

### 2. Context Before Autonomy

No execution entrypoint should call `PluginManager.processToolCall()` without a
normalized context object.

Minimum context:

```ts
{
  agentAlias: string | null,
  agentId: string | null,
  requestSource: string,
  operatorId?: string | null,
  bridgeId?: string | null,
  taskId?: string | null,
  invocationId?: string | null
}
```

Calls without context must default to conservative policy.

### 3. Compatibility Before Cleanup

Legacy names should not be deleted abruptly.

Examples:

- `PowerShellExecutor` should remain accepted as an alias for
  `ServerPowerShellExecutor`.
- `FileOperator` should remain accepted as an alias for `ServerFileOperator`.
- `LocalSearchController` should remain accepted as an alias for
  `ServerSearchController`.
- `CodeSearcher` should remain accepted as an alias for `ServerCodeSearcher`.

Compatibility should be explicit and audited, not hidden in prompt text.

### 4. Evidence Before Trust

Every automatic decision must produce evidence.

Minimum decision evidence:

```ts
{
  decisionId: string,
  requestedToolName: string,
  canonicalToolName: string,
  command: string | null,
  requestSource: string,
  agentAlias: string | null,
  action: "allow" | "dry_run_only" | "require_approval" | "reject" | "step_back",
  risk: "low" | "medium" | "high" | "critical" | "unknown",
  reasons: string[],
  matchedPolicyIds: string[]
}
```

No evidence means no autonomy.

### 5. Local Autonomy Before Global Autonomy

VCP should not immediately make global decisions for every plugin.

Start with narrow, high-confidence domains:

- read-only local search
- dry-run previews
- explicitly safe command classes
- plugin-local low-risk writes that already have tests

Keep shell execution, file mutation, bridge execution, and external writes
behind stricter gates until evidence improves.

## Strategic Phases

### Phase A: Identity And Context Baseline

Goal:

```text
Every tool call has canonical identity and normalized caller context.
```

Scope:

- introduce `ToolIdentityResolver`
- resolve high-impact aliases
- preserve requested vs canonical names
- route all direct entrypoints through a context helper
- fix AI Image `source` vs `requestSource`

Minimum alias table:

| Canonical | Aliases |
| --- | --- |
| `ServerPowerShellExecutor` | `PowerShellExecutor` |
| `ServerFileOperator` | `FileOperator` |
| `ServerSearchController` | `VCPEverything`, `LocalSearchController` |
| `ServerCodeSearcher` | `CodeSearcher` |

Exit criteria:

- approval can match canonical and legacy names
- all direct execution entrypoints pass `requestSource`
- tests cover alias resolution and context propagation

### Phase B: Approval Compatibility Layer

Goal:

```text
Old approval rules keep working while policy decisions move to canonical names.
```

Scope:

- `ToolApprovalManager` accepts resolved identity
- approval result records requested and canonical tool names
- old config entries such as `PowerShellExecutor` still protect
  `ServerPowerShellExecutor`
- command-level rules remain command-level, not tool aliases

Exit criteria:

- existing `PowerShellExecutor` rule protects the registered backend tool
- no command such as `DeleteFile` becomes a standalone tool by accident
- approval UI can display both requested and canonical names when they differ

### Phase C: Effect Classification

Goal:

```text
VCP can classify what a call is likely to do before deciding whether to ask.
```

Initial effect classes:

- `read_local`
- `read_external`
- `write_local`
- `write_external`
- `execute_shell`
- `delete_or_destructive`
- `credential_or_secret_touch`
- `network_publish`
- `ui_or_notification`
- `unknown`

Inputs:

- canonical tool name
- command
- selected args
- manifest hints
- plugin-local metadata
- static override table

Exit criteria:

- high-impact tools have explicit effect mapping
- unknown effect defaults to conservative policy
- effect classification has unit tests

### Phase D: Low-Risk Autonomy

Goal:

```text
Allow agents to skip human approval only for narrow, evidenced low-risk cases.
```

Initial allow candidates:

- read-only search
- read-only file metadata
- dry-run preview
- safe local status checks
- plugin-local low-risk writes with existing dry-run or gray-stage controls

Hard exclusions for early autonomy:

- shell execution
- file delete/write outside allowlisted roots
- bridge-originated execution without source metadata
- external publish/sync
- credential or secret access
- unknown tool or unknown effect

Exit criteria:

- every auto-allow decision emits audit evidence
- operator can review why approval was skipped
- low-risk allowlist is explicit and tested

### Phase E: Governance Evidence And Review

Goal:

```text
Every governed execution can be reviewed after the fact.
```

Evidence should answer:

- requested tool and canonical tool
- caller context
- effect class
- policy action
- approval status
- dry-run vs real execution
- result summary
- failure class, if any

Exit criteria:

- audit records exist for allow, approval, reject, dry-run, and step-back paths
- evidence can support release review or incident investigation
- governance evidence is separate from raw secret-bearing logs

## Non-Goals

This strategy is not:

- a rewrite of VCPToolBox
- a replacement for OpenAI Codex governance
- a new multi-agent command center
- a new plugin business workflow
- a broad risk-scoring engine as the first patch
- permission to enable bridge execution or external writes

## Stop Conditions

Pause strategy-to-implementation if:

- identity resolution would change public tool behavior broadly
- approval compatibility cannot be tested safely
- bridge execution requires live external writes to validate
- secrets or raw env values appear in planned evidence
- a command-level identifier would be treated as a tool name
- a low-risk rule cannot explain why it is low risk

## Review Questions

Before implementation begins, reviewers should answer:

1. Is the alias table small enough for a first patch?
2. Are requested and canonical tool names both preserved in evidence?
3. Which entrypoints must be blocked if context is missing?
4. Should `VCPToolBridge` remain disabled until context propagation exists?
5. Which effect classes are safe enough for Phase D auto-allow?
6. What audit data is necessary without exposing secrets?

## Recommended First Strategy Artifact

Create a patch design document, not code, with this shape:

```text
VCP Governance Patch 1 Design

1. ToolIdentityResolver contract
2. Alias table
3. Approval compatibility behavior
4. ExecutionContext normalization behavior
5. Tests required
6. Rollback plan
7. Explicit non-goals
```

That design should be reviewed before any VCP implementation begins.

## Final Position

The strategic path is:

```text
stabilize identity
stabilize context
preserve approval compatibility
classify effect
then grant narrow autonomy
```

VCP should earn autonomy through evidence, not assume it from agent confidence.
