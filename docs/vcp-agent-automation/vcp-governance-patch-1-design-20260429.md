# VCP Governance Patch 1 Design

> Date: 2026-04-29
> Status: strategy design, not implementation
> Scope: first governance hardening patch for VCPToolBox
> Constraint: no code changes authorized by this document
> Parent strategy: `docs/vcp-agent-automation/vcp-agent-automation-governance-strategy-20260429.md`
> Evidence memo: `docs/vcp-agent-automation/vcp-agent-automation-molecular-recon-20260429.md`

## Purpose

Patch 1 should make VCP's existing tool execution path governable without
changing broad runtime behavior.

The patch is intentionally narrow:

```text
identity normalization
+ approval compatibility
+ execution context normalization
+ regression tests
```

It must not introduce full autonomous execution or broad risk scoring.

## Problem Statement

VCP currently has several local safety systems, but the central tool execution
path does not consistently know:

- the canonical tool identity
- the caller context
- whether an approval rule applies to the canonical tool
- whether a displayed or example tool name differs from the executable plugin
  name

This creates a governance gap:

```text
policy can match one name,
while execution uses another name.
```

The concrete verified example is:

```text
approvalList includes: PowerShellExecutor
registered plugin name: ServerPowerShellExecutor
current approval check for ServerPowerShellExecutor: not matched
```

## Design Goal

Patch 1 should make this statement true:

```text
Before approval is evaluated, every tool call has a requested name, a canonical
name, a command, and a normalized execution context.
```

## Non-Goals

Patch 1 does not:

- enable low-risk autonomous approval skipping
- implement a full `RiskPolicyEngine`
- change plugin business logic
- change bridge enablement defaults
- rewrite manifest format
- remove legacy tool names
- modify secrets or env files
- perform live external writes
- make VCPToolBridge or SnowBridge more permissive

## Proposed Components

### 1. ToolIdentityResolver

Add a small resolver module with no side effects.

Suggested contract:

```ts
type ToolIdentityResolution = {
  requestedToolName: string;
  canonicalToolName: string;
  registeredPluginName: string | null;
  command: string | null;
  aliases: string[];
  wasAlias: boolean;
  confidence: "exact" | "alias" | "unknown";
};

type ToolIdentityResolver = {
  resolve(input: {
    requestedToolName: string;
    toolArgs?: Record<string, unknown>;
    pluginRegistry?: Map<string, unknown>;
  }): ToolIdentityResolution;
};
```

Resolution rules:

1. If `requestedToolName` is registered, canonical equals requested.
2. If `requestedToolName` is a known alias, canonical becomes the mapped
   registered tool.
3. If unknown, canonical remains requested and confidence is `unknown`.
4. `command` is extracted from `toolArgs.command` only for Patch 1.
5. `command1`, `command2`, etc. remain approval-manager command matching
   inputs, but must not become standalone tool names.

### 2. Patch 1 Alias Table

Patch 1 should include only high-impact, evidence-backed aliases.

| Canonical tool | Accepted aliases | Notes |
| --- | --- | --- |
| `ServerPowerShellExecutor` | `PowerShellExecutor` | shell execution; current approval gap |
| `ServerFileOperator` | `FileOperator` | file read/write/delete surface |
| `ServerSearchController` | `LocalSearchController`, `VCPEverything` | search can feed file operations |
| `ServerCodeSearcher` | `CodeSearcher` | code search; lower risk but identity mismatch |

Rejected for Patch 1:

- mapping every command identifier to a tool
- broad fuzzy matching
- display-name matching
- automatic alias generation from examples

Those can be considered later after tests exist.

### 3. Approval Compatibility

Patch 1 should integrate identity resolution into approval matching.

Desired behavior:

```text
requestedToolName = PowerShellExecutor
canonicalToolName = ServerPowerShellExecutor
approval rule = PowerShellExecutor
decision = requires approval
```

Also:

```text
requestedToolName = ServerPowerShellExecutor
canonicalToolName = ServerPowerShellExecutor
approval rule = PowerShellExecutor
decision = requires approval
```

This preserves existing configs while making backend canonical calls protected.

Suggested approval decision shape:

```ts
type ApprovalDecision = {
  requiresApproval: boolean;
  notifyAiOnReject: boolean;
  matchedRule: string | null;
  matchedCommand: string | null;
  requestedToolName: string;
  canonicalToolName: string;
  wasAlias: boolean;
};
```

Rule matching should consider:

- exact requested tool name
- exact canonical tool name
- known aliases for canonical tool
- command-specific forms for the above names

Example command-specific compatibility:

```text
PowerShellExecutor:Get-ChildItem
ServerPowerShellExecutor:Get-ChildItem
```

Both should be able to protect the same canonical tool.

### 4. ExecutionContext Normalization

Patch 1 should introduce or standardize a context helper.

Suggested contract:

```ts
type NormalizedExecutionContext = {
  agentAlias: string | null;
  agentId: string | null;
  requestSource: string;
  operatorId?: string | null;
  bridgeId?: string | null;
  taskId?: string | null;
  invocationId?: string | null;
};
```

Minimum source mappings:

| Entry | `requestSource` |
| --- | --- |
| chat loop | `chatCompletionHandler` |
| Codex memory MCP | `codex-desktop-mcp` |
| human tool route | `human-tool-route` |
| task scheduler | `task-scheduler` |
| SnowBridge | `snowbridge` |
| VCPToolBridge | `vcp-tool-bridge` |
| AI Image pipeline | `ai-image-pipeline` |

Patch 1 should not decide trust from these labels. It only makes the labels
present and testable.

### 5. Direct Entrypoint Conversion

Patch 1 should convert direct calls to a shared helper where practical.

Priority:

1. AI Image adapter: fix `{ source }` to `{ requestSource }`.
2. `taskScheduler`: pass `taskId` and `requestSource=task-scheduler`.
3. human tool route: pass `requestSource=human-tool-route`.
4. SnowBridge: pass bridge metadata and `requestSource=snowbridge`.
5. VCPToolBridge: pass bridge metadata and `requestSource=vcp-tool-bridge`.

This order starts with the smallest safe correction, then moves toward
bridge-sensitive paths.

## Required Tests

### ToolIdentityResolver Tests

Required cases:

```text
PowerShellExecutor -> ServerPowerShellExecutor
ServerPowerShellExecutor -> ServerPowerShellExecutor
FileOperator -> ServerFileOperator
ServerFileOperator -> ServerFileOperator
LocalSearchController -> ServerSearchController
ServerSearchController -> ServerSearchController
CodeSearcher -> ServerCodeSearcher
ServerCodeSearcher -> ServerCodeSearcher
UnknownTool -> UnknownTool, confidence=unknown
DeleteFile -> DeleteFile, confidence=unknown
```

The `DeleteFile` case is important. It proves commands are not accidentally
promoted into standalone tools.

### Approval Compatibility Tests

Required cases:

```text
approvalList = ["PowerShellExecutor"]
toolName = "ServerPowerShellExecutor"
command = "Get-ChildItem"
=> requiresApproval = true
```

```text
approvalList = ["ServerPowerShellExecutor"]
toolName = "PowerShellExecutor"
command = "Get-ChildItem"
=> requiresApproval = true
```

```text
approvalList = ["PowerShellExecutor:Get-ChildItem"]
toolName = "ServerPowerShellExecutor"
command = "Get-ChildItem"
=> requiresApproval = true
matchedCommand = "Get-ChildItem"
```

```text
approvalList = ["PowerShellExecutor"]
toolName = "ServerFileOperator"
command = "DeleteFile"
=> requiresApproval = false
```

### Context Propagation Tests

Required cases:

- AI Image passes `requestSource=ai-image-pipeline`.
- task scheduler passes `requestSource=task-scheduler` and task id.
- human tool route passes `requestSource=human-tool-route`.
- SnowBridge passes `requestSource=snowbridge` plus bridge invocation metadata.
- VCPToolBridge passes `requestSource=vcp-tool-bridge` plus bridge server
  metadata.
- chat loop still passes `chatCompletionHandler`.
- Codex memory MCP still passes `codex-desktop-mcp`.

### Regression Guard Tests

Required guards:

- unknown tool names still fail normally
- command names are not treated as tools
- existing `SciCalculator` approval behavior remains unchanged
- `::SilentReject` behavior remains unchanged
- `approveAll=true` still overrides per-tool matching

## Rollout Strategy

Recommended rollout:

1. Add tests first for resolver and approval compatibility.
2. Add resolver with static alias table.
3. Wire resolver into approval matching only.
4. Add context helper and tests.
5. Convert low-risk context paths first.
6. Convert bridge paths after tests can assert metadata.
7. Leave autonomy disabled.

## Rollback Plan

Rollback should be simple:

- disable resolver usage in approval matching
- keep alias table but do not call it
- revert entrypoint context helper calls to previous direct calls
- keep tests as skipped or pending evidence if implementation is rolled back

No data migration should be required for Patch 1.

## Compatibility Policy

Patch 1 must preserve these behaviors:

- old prompts using `PowerShellExecutor` remain understandable
- old approval config using `PowerShellExecutor` remains protective
- canonical backend names become protectable
- existing plugin execution semantics remain unchanged
- no bridge becomes enabled by this patch

## Audit Shape For Patch 1

Patch 1 does not need a full audit subsystem, but approval logs should be ready
to carry:

```ts
{
  requestedToolName: string,
  canonicalToolName: string,
  command: string | null,
  requestSource: string,
  matchedRule: string | null,
  requiresApproval: boolean
}
```

This creates the minimum evidence needed for future autonomous decisions.

## Review Checklist

Before implementation starts, confirm:

- the alias table is limited to evidence-backed names
- command identifiers do not become tool aliases by default
- approval compatibility works in both requested-to-canonical and
  canonical-to-legacy directions
- bridge paths remain disabled unless already enabled by operator config
- missing context does not become a reason to auto-allow
- tests cover both positive and negative paths

## Final Recommendation

Patch 1 should be treated as a governance foundation patch, not an autonomy
feature.

The first successful outcome is not:

```text
the agent can do more without asking
```

The first successful outcome is:

```text
VCP can accurately tell what would be done,
by whom,
through which entrypoint,
under which approval rule.
```

That is the necessary base for safe autonomy later.
