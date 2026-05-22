# VCP Agent Automation Molecular Recon

> Date: 2026-04-29
> Scope: VCPToolBox stable production-line read-only investigation
> Source workspace: `A:\VCP\VCPToolBox-prod-stable-clean`
> Target project context: `codex-router` direction pivot
> Status: evidence memo, not implementation plan

## Summary

VCPToolBox has partial agent automation self-awareness, but it is not yet a
unified agent governance system.

The current shape is:

```text
tool parser / scheduler / bridge
  -> PluginManager.processToolCall
  -> static ToolApprovalManager gate
  -> plugin-local safety islands
  -> plugin execution
```

The strongest conclusion from the molecular pass is:

```text
VCP can already automate some low-risk work inside specific plugins,
but it cannot yet make a reliable global "low risk, skip human approval"
decision across the whole tool ecosystem.
```

The blocker is not only missing risk scoring. The deeper blocker is identity and
context: the runtime does not yet have one canonical answer for "which tool is
being called, by which agent, from which source, with what effect."

## Source State

Read-only inspection target:

- `A:\VCP\VCPToolBox-prod-stable-clean`
- Branch: `codex/prod-stable-photo-studio-guide-contract-phase1`
- Worktree: clean during inspection
- Head observed: `e935d35 chore: gate photo studio guide contracts for prod stable`

No VCPToolBox files were modified.

## Main Finding 1: Tool Identity Is Not Canonical

`PluginManager` registers local plugins by `manifest.name`:

- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin.js:549`
- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin.js:550`

`processToolCall()` then looks up the incoming `toolName` exactly:

- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin.js:812`
- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin.js:813`

But several high-impact tools expose different names across manifest identity,
directory name, and examples:

| Manifest file | Registered name | Example `tool_name` | Command identifier |
| --- | --- | --- | --- |
| `Plugin\PowerShellExecutor\plugin-manifest.json` | `ServerPowerShellExecutor` | `PowerShellExecutor` | `PowerShellExecutor` |
| `Plugin\FileOperator\plugin-manifest.json` | `ServerFileOperator` | `FileOperator` | multiple file commands |
| `Plugin\VCPEverything\plugin-manifest.json` | `ServerSearchController` | `LocalSearchController` | `search` |
| `Plugin\CodeSearcher\plugin-manifest.json` | `ServerCodeSearcher` | `CodeSearcher` | `SearchCode` |

Local toolbox docs also describe a front/back split:

- `PowerShellExecutor` vs `ServerPowerShellExecutor`
- `FileOperator` vs `ServerFileOperator`
- `LocalSearchController` vs `ServerSearchController`
- `CodeSearcher` vs `ServerCodeSearcher`

This suggests VCP has an intended alias model, but the central execution path
does not yet expose a single `ToolIdentityResolver`.

### Implication

Any global approval, risk, audit, or automation policy that matches raw
`toolName` can miss the real tool.

The immediate concrete risk observed:

```text
toolApprovalConfig.json approvalList = SciCalculator, PowerShellExecutor
registered backend plugin name = ServerPowerShellExecutor
```

Based on source inspection, `PowerShellExecutor` is likely not enough to protect
calls made as `ServerPowerShellExecutor`. This was not runtime-tested, so it
should be treated as a high-priority hypothesis, not a proven exploit.

## Main Finding 2: Approval Is Static, Not Risk-Aware

`ToolApprovalManager` currently supports:

- global enable / disable
- `approveAll`
- exact tool-level rules
- exact `toolName:command` rules
- `::SilentReject`

Evidence:

- `A:\VCP\VCPToolBox-prod-stable-clean\modules\toolApprovalManager.js:8`
- `A:\VCP\VCPToolBox-prod-stable-clean\modules\toolApprovalManager.js:114`
- `A:\VCP\VCPToolBox-prod-stable-clean\modules\toolApprovalManager.js:164`
- `A:\VCP\VCPToolBox-prod-stable-clean\modules\toolApprovalManager.js:169`

Current sanitized config observation:

```text
enabled = true
approveAll = false
timeoutMinutes = 5
approvalList = SciCalculator, PowerShellExecutor
```

There is no central semantic classifier for:

- filesystem read vs write
- local-only effect vs external write
- shell execution
- network mutation
- destructive action
- rollback availability
- dry-run support
- caller trust

### Implication

VCP cannot yet safely answer:

```text
"This operation is low-risk, so skip human approval."
```

It can only answer:

```text
"This raw tool name or raw tool+command string is listed for approval."
```

That is useful, but it is not agent self-governance.

## Main Finding 3: Execution Context Is Partial

The standard chat path builds an execution context:

- `A:\VCP\VCPToolBox-prod-stable-clean\modules\chatCompletionHandler.js:104`
- `A:\VCP\VCPToolBox-prod-stable-clean\modules\chatCompletionHandler.js:112`
- `A:\VCP\VCPToolBox-prod-stable-clean\modules\chatCompletionHandler.js:115`

The normal loop executor passes normalized context into `PluginManager`:

- `A:\VCP\VCPToolBox-prod-stable-clean\modules\vcpLoop\toolExecutor.js:262`
- `A:\VCP\VCPToolBox-prod-stable-clean\modules\vcpLoop\toolExecutor.js:275`

`PluginManager` recognizes only:

- `agentAlias`
- `agentId`
- `requestSource`

Evidence:

- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin.js:817`
- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin.js:825`
- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin.js:1107`
- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin.js:1120`

Several entrypoints call `processToolCall()` without execution context:

- `A:\VCP\VCPToolBox-prod-stable-clean\server.js:1242`
- `A:\VCP\VCPToolBox-prod-stable-clean\routes\taskScheduler.js:42`
- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin\VCPToolBridge\index.js:220`
- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin\SnowBridge\index.js:1037`

AI Image currently passes:

```js
{ source: 'ai-image-pipeline' }
```

Evidence:

- `A:\VCP\VCPToolBox-prod-stable-clean\modules\aiImageExecutionAdapter.js:314`
- `A:\VCP\VCPToolBox-prod-stable-clean\modules\aiImageExecutionAdapter.js:318`

But `PluginManager` expects `requestSource`, so that source becomes `unknown`.

### Implication

Global governance cannot reliably distinguish:

- normal chat-originated tool calls
- human direct tool calls
- scheduled tasks
- bridge-originated calls
- AI Image pipeline execution
- Codex memory MCP calls

Without source identity, low-risk automation cannot be made reliably contextual.

## Main Finding 4: Plugin-Local Safety Islands Are Real

VCP already contains several strong local governance patterns.

### AI Image Pipeline

`pipelineSafetyGate` uses explicit risk and action levels:

- `low`
- `medium`
- `high`
- `critical`

Actions:

- `allow`
- `dry_run_only`
- `require_approval`
- `step_back`
- `abort`

Evidence:

- `A:\VCP\VCPToolBox-prod-stable-clean\modules\pipelineSafetyGate.js:14`
- `A:\VCP\VCPToolBox-prod-stable-clean\modules\pipelineSafetyGate.js:22`
- `A:\VCP\VCPToolBox-prod-stable-clean\modules\pipelineSafetyGate.js:137`
- `A:\VCP\VCPToolBox-prod-stable-clean\modules\pipelineSafetyGate.js:183`
- `A:\VCP\VCPToolBox-prod-stable-clean\tests\pipelineSafetyGate.test.js`

This is the closest existing VCP shape to a real `RiskPolicyEngine`.

### DingTalkCLI

DingTalkCLI has:

- default `query_only`
- `low_risk_write`
- `full_write`
- write detection
- default dry-run for writes
- `apply=true` to perform real writes
- audit logging

Evidence:

- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin\DingTalkCLI\lib\security-handler.js:102`
- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin\DingTalkCLI\lib\security-handler.js:146`
- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin\DingTalkCLI\lib\security-handler.js:256`
- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin\DingTalkCLI\lib\runtime.js:327`
- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin\DingTalkCLI\lib\runtime.js:365`
- `A:\VCP\VCPToolBox-prod-stable-clean\tests\dingtalk-cli\security-handler.test.js`

This proves VCP can implement scoped low-risk write automation, but currently
inside a single plugin domain.

### LinuxShellExecutor

LinuxShellExecutor has command classes:

- `read`
- `safe`
- `write`
- `danger`

It auto-allows `read` and `safe`, requires confirmation for `write`, and double
confirmation for `danger`.

Evidence:

- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin\LinuxShellExecutor\securityLevels.json:5`
- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin\LinuxShellExecutor\securityLevels.json:41`
- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin\LinuxShellExecutor\securityLevels.json:64`
- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin\LinuxShellExecutor\LinuxShellExecutor.js:2158`
- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin\LinuxShellExecutor\LinuxShellExecutor.js:2191`
- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin\LinuxShellExecutor\LinuxShellExecutor.js:2215`

This is a good model for command-level risk classification, but it is not
connected to the global approval manager.

## Main Finding 5: Manifest Governance Metadata Is Mostly Absent

Across `Plugin` and `plugins` manifests, governance-like metadata is sparse.

Observed manifest field counts:

```text
permissions = 2
dry_run = 1
execution_mode = 1
```

No broad use was observed for fields such as:

- `risk`
- `effect`
- `side_effects`
- `approval`
- `requiredApprovals`
- `governance`
- `policy`
- `rollback`
- `audit`

### Implication

The policy engine cannot yet rely on manifest-declared semantics. It would need
to begin with heuristic classification plus explicit overrides, then migrate
toward manifest-owned policy metadata.

## Test Coverage Observation

Observed test coverage is uneven:

```text
pipelineSafetyGate tests: present
DingTalkCLI safety tests: present
CodexMemoryBridge policy tests: present
ToolApprovalManager direct tests: not found
PowerShellExecutor approval/name tests: not found
ServerPowerShellExecutor approval/name tests: not found
FileOperator approval/name tests: not found
SnowBridge/VCPToolBridge context tests: not found
LinuxShellExecutor central approval integration tests: not found
```

This matters because the most important risk is now integration shape, not only
plugin-local behavior.

## Design Implications For VCP

Before VCP can support highly self-aware agent automation, it needs a central
policy seam before or inside `PluginManager.processToolCall()`.

Recommended minimum architecture:

```text
raw tool call
  -> ToolIdentityResolver
  -> ExecutionContextNormalizer
  -> EffectClassifier
  -> RiskPolicyEngine
  -> approval / dry-run / allow / reject / step-back
  -> PluginManager execution
  -> audit event
```

### ToolIdentityResolver

Must produce:

- `canonicalName`
- `registeredName`
- `requestedName`
- `displayName`
- `directoryName`
- `commandIdentifier`
- `aliases`

It should know that these may point to the same capability:

- `PowerShellExecutor` / `ServerPowerShellExecutor`
- `FileOperator` / `ServerFileOperator`
- `LocalSearchController` / `ServerSearchController`
- `CodeSearcher` / `ServerCodeSearcher`

### ExecutionContextNormalizer

Must ensure every entrypoint passes a normalized context:

- `agentAlias`
- `agentId`
- `requestSource`
- `channel`
- `bridgeId`
- `schedulerTaskId`
- `operatorMode`

Immediate bug-shaped item:

```text
AI Image should pass requestSource: "ai-image-pipeline",
not source: "ai-image-pipeline".
```

### EffectClassifier

Minimum effect classes:

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

### RiskPolicyEngine

Minimum output:

```ts
{
  action: "allow" | "dry_run_only" | "require_approval" | "reject" | "step_back",
  risk: "low" | "medium" | "high" | "critical",
  reasons: string[],
  matchedPolicyIds: string[],
  auditRequired: boolean
}
```

## Decision For codex-router

This reinforces the project pivot:

```text
codex-router should not become another VCP router or OpenAI Codex command center.
It should become a governance/evidence harness that can verify host execution
boundaries, approvals, low-risk automation decisions, and audit records.
```

VCP contributes the field pattern:

- plugin-local dry-run gates are useful
- gray-stage rollout works
- explicit source context is essential
- policy without canonical identity is fragile
- audit logs must be tied to real execution identity

OpenAI and VCP remain separate systems. VCP should own its local tool governance;
`codex-router` can learn from it, but should keep implementation generic.

## Near-Term Action List

For VCP investigation:

1. Runtime-test whether `PowerShellExecutor` vs `ServerPowerShellExecutor`
   actually hits approval as expected.
2. Trace whether any hidden alias mapping exists outside the inspected central
   path.
3. Add direct tests for `ToolApprovalManager` rule matching.
4. Add bridge context propagation tests for `SnowBridge` and `VCPToolBridge`.
5. Add a failing test for AI Image `source` vs `requestSource` mismatch.

For `codex-router` direction:

1. Keep this as field evidence, not copied business logic.
2. Model `ToolIdentityResolver` and `RiskPolicyEngine` as generic governance
   concepts.
3. Treat VCP plugin metadata gaps as evidence for why a host governance harness
   needs observed execution evidence, not only declared manifest metadata.

## Open Questions

- Does a runtime path outside `PluginManager.processToolCall()` rewrite example
  names such as `PowerShellExecutor` into registered names such as
  `ServerPowerShellExecutor`?
- Should VCP keep front/back tool names as aliases, or migrate to one canonical
  name plus explicit `scope=frontend/backend`?
- Which VCP entrypoints are allowed to perform real writes without a normalized
  `executionContext` today?
- Should low-risk automation be plugin-owned first, or centralized first?

## Bottom Line

VCP is close to the right ingredients, but not yet the right composition.

The next valuable move is not more broad feature work. It is to introduce a
small central governance spine:

```text
canonical tool identity
+ normalized caller context
+ effect classification
+ policy decision
+ audit evidence
```

Once that exists, VCP can safely start making limited autonomous low-risk
decisions without depending on broad human approval.

---

## Phase 2 Verification Pass

> Time: 2026-04-29
> Mode: read-only source and non-executing policy checks
> VCPToolBox result: no files modified

Phase 2 tested the Phase 1 hypotheses without executing real tools.

### Verified: Approval Alias Miss

Directly calling `ToolApprovalManager.getApprovalDecision()` confirmed the
approval alias issue.

Observed decisions:

```text
PowerShellExecutor + command=Get-ChildItem
  -> requiresApproval=true
  -> matchedRule=PowerShellExecutor

ServerPowerShellExecutor + command=Get-ChildItem
  -> requiresApproval=false
  -> matchedRule=null

SciCalculator + command=SciCalculatorRequest
  -> requiresApproval=true
  -> matchedRule=SciCalculator

ServerFileOperator + command=DeleteFile
  -> requiresApproval=false

FileOperator + command=DeleteFile
  -> requiresApproval=false
```

This did not execute PowerShell or FileOperator. It only exercised the approval
decision function.

### Verified: Parser Does Not Normalize Tool Names

`ToolCallParser.parseBlock()` assigns the parsed `tool_name` directly to
`toolName` and returns it as `name`.

Evidence:

- `A:\VCP\VCPToolBox-prod-stable-clean\modules\vcpLoop\toolCallParser.js:92`
- `A:\VCP\VCPToolBox-prod-stable-clean\modules\vcpLoop\toolCallParser.js:107`

This means a request using:

```text
tool_name: PowerShellExecutor
```

will remain `PowerShellExecutor` unless some later layer rewrites it.

### Verified: PluginManager Still Uses Exact Lookup

The execution entrypoint remains exact-name based:

- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin.js:812`
- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin.js:813`

No central pre-execution alias resolver was found between parser and
`PluginManager.processToolCall()`.

### Verified: Dynamic Tool Registry Is Not Execution Normalization

`DynamicToolRegistry` can match user text against:

- `pluginName`
- `displayName`
- `commandIdentifiers`

Evidence:

- `A:\VCP\VCPToolBox-prod-stable-clean\modules\dynamicToolRegistry.js:651`
- `A:\VCP\VCPToolBox-prod-stable-clean\modules\dynamicToolRegistry.js:956`
- `A:\VCP\VCPToolBox-prod-stable-clean\modules\dynamicToolRegistry.js:1013`

But this layer expands prompt/tool descriptions. It does not rewrite the actual
`toolName` passed into `PluginManager.processToolCall()`.

### New Finding: Tool List Editor Also Blurs Identity

The admin tool list endpoint exposes each command as:

```js
name: cmd.commandIdentifier || pluginName
pluginName: pluginName
```

Evidence:

- `A:\VCP\VCPToolBox-prod-stable-clean\routes\admin\toolListEditor.js:27`
- `A:\VCP\VCPToolBox-prod-stable-clean\routes\admin\toolListEditor.js:28`
- `A:\VCP\VCPToolBox-prod-stable-clean\routes\admin\toolListEditor.js:144`

The Vue editor preview renders `tool.name` as the visible heading and example
tool list:

- `A:\VCP\VCPToolBox-prod-stable-clean\AdminPanel-Vue\src\views\ToolListEditor.vue:125`
- `A:\VCP\VCPToolBox-prod-stable-clean\AdminPanel-Vue\src\views\ToolListEditor.vue:137`

This means command identifiers can be presented to operators or prompts as if
they were tool names. That is useful for display, but dangerous for governance
unless `pluginName` and `commandIdentifier` are kept separate in the contract.

### Verified: Example Tool Name Mismatches Are Limited But Important

Across 145 manifest files, 10 had example `tool_name` values that differ from
the manifest `name`.

Important examples:

| Manifest `name` | Example `tool_name` | Command identifiers |
| --- | --- | --- |
| `ServerPowerShellExecutor` | `PowerShellExecutor` | `PowerShellExecutor` |
| `ServerFileOperator` | `FileOperator` | file operation commands |
| `ServerSearchController` | `LocalSearchController` | `search` |
| `ServerCodeSearcher` | `CodeSearcher` | `SearchCode` |
| `AIGentPrompt` | `GenerateImagePrompt`, `SearchPromptTemplates` | same as examples |
| `AIGentWorkflow` | `ExecuteWorkflow`, `ListTemplates` | same as examples |
| `DMXDoubaoGen` | `DoubaoGen` | Doubao image commands |
| `NanoBananaGen2` | `NanoBananaGenOR` | NanoBanana image commands |
| `ZImageGen2` | `ZImageGen` | `ZImageGenerate` |
| `DingTalkTable` | `DingTalkTable`, `add_record` | DingTalk table commands |

The risky group is not merely cosmetic. It includes shell execution and file
operation surfaces.

### Verified: Entry Context Coverage Is Uneven

Observed `processToolCall()` entrypoints:

| Entry | Context status | Evidence |
| --- | --- | --- |
| chat loop | present | `modules\vcpLoop\toolExecutor.js:262` |
| Codex memory MCP | present | `routes\codexMemoryMcp.js:151` |
| human tool route | missing | `server.js:1242` |
| task scheduler | missing | `routes\taskScheduler.js:42` |
| VCPToolBridge | missing | `Plugin\VCPToolBridge\index.js:220` |
| SnowBridge | missing | `Plugin\SnowBridge\index.js:1037` |
| AI Image adapter | wrong field: `source` | `modules\aiImageExecutionAdapter.js:318` |

The positive path is clear:

- `routes\codexMemoryMcp.js` uses `executeToolCallWithContext()`.
- It passes `agentAlias: "Codex"`, `agentId: "codex-desktop"`,
  `requestSource: "codex-desktop-mcp"`.
- `modules\toolExecution.js` passes that context into `PluginManager`.

The negative paths show the missing abstraction:

```text
executeToolCallWithContext exists,
but is not yet used by all host-side entrypoints.
```

### Verified: Plugin Env Context Is Useful But Narrowly Consumed

`PluginManager.executePlugin()` injects context into child-process env:

- `VCP_EXECUTION_CONTEXT`
- `VCP_REQUEST_SOURCE`
- `VCP_AGENT_ALIAS`
- `VCP_AGENT_ID`

Evidence:

- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin.js:1120`
- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin.js:1121`
- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin.js:1123`
- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin.js:1126`

Only a small set of plugins was observed consuming these fields:

- `CodexMemoryBridge`
- `DingTalkCLI`

Evidence:

- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin\CodexMemoryBridge\codex-memory-bridge.js:49`
- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin\DingTalkCLI\lib\runtime.js:368`

Several hybrid plugins accept `executionContext` in their function signature but
do not appear to use it yet.

### Phase 2 Conclusion

The core failure mode is now sharper:

```text
VCP has local policy gates,
but the runtime contract does not guarantee canonical identity or caller context
before the policy gate runs.
```

Therefore the next safe implementation direction is:

1. Add a non-invasive `ToolIdentityResolver` and tests.
2. Normalize `PowerShellExecutor` / `ServerPowerShellExecutor` and similar pairs
   before approval matching.
3. Route all direct `processToolCall()` callers through
   `executeToolCallWithContext()`.
4. Fix AI Image context from `{ source }` to `{ requestSource }`.
5. Keep display labels, command identifiers, and executable plugin names as
   separate fields in admin tooling and prompt injection.

This is more urgent than a full risk-scoring engine. A risk engine built before
identity normalization would make confident decisions about unstable names.

---

## Phase 3 Patch Readiness Validation

> Time: 2026-04-29
> Mode: implementation-prep validation
> Constraint: no real tool execution, no VCP file edits

Phase 3 converted the investigation into a patch-readiness checklist. It
validated which assumptions are ready to become implementation work.

### Runtime Registration Matrix

`PluginManager` keeps plugins in a `Map` and registers local plugins by
`manifest.name`.

Evidence:

- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin.js:25`
- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin.js:549`
- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin.js:550`

Observed registration matrix:

| Requested/display name | Registered executable tool? | Example of | Command of |
| --- | --- | --- | --- |
| `PowerShellExecutor` | no | `ServerPowerShellExecutor` | `ServerPowerShellExecutor` |
| `ServerPowerShellExecutor` | yes | - | - |
| `FileOperator` | no | `ServerFileOperator` | - |
| `ServerFileOperator` | yes | - | - |
| `LocalSearchController` | no | `ServerSearchController` | - |
| `ServerSearchController` | yes | - | - |
| `CodeSearcher` | no | `ServerCodeSearcher` | - |
| `ServerCodeSearcher` | yes | - | - |
| `GenerateImagePrompt` | no | `AIGentPrompt` | `AIGentPrompt` |
| `AIGentPrompt` | yes | - | - |
| `ExecuteWorkflow` | no | `AIGentWorkflow` | `AIGentWorkflow` |
| `AIGentWorkflow` | yes | - | - |

This confirms that the high-risk file/shell/search examples use names that are
not executable registry names in the central plugin map.

### Approval Migration Readiness

Current approval config:

```json
{
  "enabled": true,
  "approveAll": false,
  "timeoutMinutes": 5,
  "approvalList": ["SciCalculator", "PowerShellExecutor"]
}
```

Migration interpretation:

| Existing rule | Canonical target | Needs migration |
| --- | --- | --- |
| `SciCalculator` | `SciCalculator` | no |
| `PowerShellExecutor` | `ServerPowerShellExecutor` | yes |

Implementation implication:

```text
Do not simply replace old rules and risk breaking old prompts.
Resolve aliases before approval matching, and optionally record both requested
and canonical names in approval/audit data.
```

### Minimum ToolIdentityResolver Table

First patch should cover the high-impact identity pairs only.

| Canonical name | Aliases | Commands |
| --- | --- | --- |
| `ServerPowerShellExecutor` | `PowerShellExecutor` | `PowerShellExecutor` |
| `ServerFileOperator` | `FileOperator` | `ListAllowedDirectories`, `ReadFile`, `WriteFile`, `AppendFile`, `EditFile`, `DeleteFile`, `ApplyDiff`, etc. |
| `ServerSearchController` | `VCPEverything`, `LocalSearchController` | `search` |
| `ServerCodeSearcher` | `CodeSearcher` | `SearchCode` |

Important design note:

```text
Commands must not blindly become tool aliases.
```

For `ServerFileOperator`, command identifiers such as `DeleteFile` and
`WriteFile` describe operations under a tool. They should be preserved as
`command`, not accepted as standalone executable tool names unless there is an
explicit compatibility rule.

### Entry Context Patch Priority

Observed priority list:

| Priority | Entry | Current state | Proposed context |
| --- | --- | --- | --- |
| P0 | `VCPToolBridge` | missing context | `requestSource=vcp-tool-bridge`, include `serverId` / bridge metadata |
| P1 | `SnowBridge` | missing context | `requestSource=snowbridge`, include `serverId`, `requestId`, `invocationId` |
| P1 | `taskScheduler` | missing context | `requestSource=task-scheduler`, include `taskId`, scheduled marker |
| P1 | human tool route | missing context | `requestSource=human-tool-route`, include operator/auth identity if available |
| P2 | AI Image adapter | uses `{ source }` | change to `requestSource=ai-image-pipeline` |
| baseline | chat loop | context present | keep |
| baseline | Codex memory MCP | context present | keep |

Bridge risk note:

- `SnowBridge` has stronger built-in controls: allowlist, exclusions, request
  headers, token, rate limit, allowed modes.
- `VCPToolBridge` defaults disabled, but its manifest only exposes
  `Bridge_Enabled` and `Excluded_Tools`.

Evidence:

- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin\SnowBridge\plugin-manifest.json`
- `A:\VCP\VCPToolBox-prod-stable-clean\Plugin\VCPToolBridge\plugin-manifest.json`

This makes `VCPToolBridge` the highest priority context-hardening target if it
is ever enabled.

### Tests Needed Before Implementation

Minimum regression tests:

1. `ToolIdentityResolver` resolves requested names:
   - `PowerShellExecutor -> ServerPowerShellExecutor`
   - `FileOperator -> ServerFileOperator`
   - `LocalSearchController -> ServerSearchController`
   - `CodeSearcher -> ServerCodeSearcher`

2. Approval matching uses canonical identity:
   - existing rule `PowerShellExecutor` still causes
     `ServerPowerShellExecutor` to require approval.
   - approval result exposes `requestedToolName` and `canonicalToolName`.

3. `PluginManager.processToolCall()` rejects unknown names after resolution:
   - unknown tool remains unknown.
   - command names such as `DeleteFile` do not become standalone tools unless
     explicitly mapped.

4. Context propagation tests:
   - `server.js` human tool path calls `processToolCall()` with
     `requestSource=human-tool-route`.
   - `taskScheduler` calls with `requestSource=task-scheduler`.
   - `SnowBridge` calls with `requestSource=snowbridge`.
   - `VCPToolBridge` calls with `requestSource=vcp-tool-bridge`.
   - AI Image passes `requestSource=ai-image-pipeline`.

5. Existing positive paths remain stable:
   - chat loop still passes `chatCompletionHandler` context.
   - Codex memory MCP still passes `agentAlias=Codex`,
     `agentId=codex-desktop`, and `requestSource=codex-desktop-mcp`.

### Patch Order Recommendation

Recommended order:

1. Add `ToolIdentityResolver` as a small standalone module.
2. Add resolver unit tests with the high-impact alias table.
3. Integrate resolver into approval matching, not plugin execution first.
4. Add approval regression tests for `PowerShellExecutor` legacy rule.
5. Add normalized context object helper or extend `executeToolCallWithContext()`.
6. Convert direct entrypoints one by one:
   - AI Image field fix
   - task scheduler
   - human tool route
   - SnowBridge
   - VCPToolBridge
7. Only after identity and context are stable, add a broader `RiskPolicyEngine`.

### Phase 3 Decision

Implementation is ready to start, but the first patch should be narrow:

```text
Identity normalization + approval compatibility + context propagation tests.
```

Do not start with a full autonomous risk engine. The evidence says the system
first needs stable names and stable caller context.
