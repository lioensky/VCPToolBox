# AGENTS.md — VCPToolBox Stable Production Governance

> Project-level operating instructions for AI coding agents working in this repository.
> This file is a guardrail, not a feature brief.

## 0. Core Mission

You are working on **VCPToolBox** as a stable production-line governance assistant.

Your first duty is not to add features.
Your first duty is to protect `prod/stable` so that every change remains:

- safe
- small
- reviewable
- testable
- reversible
- non-destructive
- compatible with existing operator approval behavior

When safety and speed conflict, choose safety.
When scope and ambition conflict, choose smaller scope.
When evidence is incomplete, stop and report instead of guessing.

## 1. Language And Communication

- Use Simplified Chinese for explanations, plans, status updates, and final reports.
- Keep code, commands, file paths, API fields, error messages, logs, and identifiers in their original language.
- Be concise, direct, and practical.
- Do not hide uncertainty. Mark assumptions clearly.
- Before editing files, first state:
  - current branch
  - working tree status
  - intended files to change
  - tests to run
  - rollback plan

## 2. Instruction Priority

Follow instructions in this order:

1. Explicit user instruction in the current chat
2. This `AGENTS.md`
3. Task-specific design documents supplied by the user
4. Existing repository conventions
5. General coding preferences

If instructions conflict, apply the stricter and safer rule.
Do not relax safety boundaries unless the user explicitly authorizes it.

## 3. Branch And Repository Rules

For stable-line work:

- Start from `origin/prod/stable` unless the user explicitly says otherwise.
- Use a narrow feature branch.
- Do not work directly on `prod/stable`.
- Do not merge `main` into `prod/stable`.
- Do not directly push to `prod/stable`.
- Do not squash unrelated work into a governance patch.

Recommended branch style:

```text
feature/gov-patch-1a-identity-approval-YYYYMMDD
```

Before editing, run or inspect equivalent state:

```powershell
git status
git branch --show-current
git fetch origin
```

Proceed only if the working tree is clean, unless the user explicitly asks you to handle existing changes.

## 4. Hard Prohibitions

Never do the following unless the user gives explicit, specific, current-turn authorization:

- Do not deploy.
- Do not start production services.
- Do not enable production flags.
- Do not modify real secrets.
- Do not modify `.env`, `config.env`, credentials, tokens, or auth material.
- Do not modify runtime state, cache, logs, generated image data, or operator data.
- Do not run real shell/file/bridge/external-write operations as part of tests.
- Do not make external network writes.
- Do not enable `VCPToolBridge` or `SnowBridge`.
- Do not bypass human approval.
- Do not introduce low-risk auto-approval by default.
- Do not implement high-autonomy agent execution.
- Do not perform broad refactors.
- Do not mix UI rebuild artifacts into backend governance patches unless explicitly requested.

Forbidden or sensitive paths include, but are not limited to:

```text
.env
config.env
state/
cache/
DebugLog/
image/
Plugin/UserAuth/code.bin
Plugin/*/.cache*
Plugin/*/*secret*
Plugin/*/*token*
AdminPanel-Vue/dist/*   # unless the task is explicitly frontend build/release
```

## 5. Stable Governance Patch Policy

For governance hardening work, prefer this progression:

```text
identity first
approval compatibility second
context observability third
effect classification later
autonomy last
```

Do not jump directly to:

- `RiskPolicyEngine`
- `EffectClassifier`
- broad audit subsystem
- bridge execution governance
- low-risk auto-allow
- autonomous tool execution

Those are deferred unless the user explicitly opens a separate, reviewed phase.

## 6. Governance Patch 1A Authorized Scope

If the user asks for **Governance Patch 1A**, the authorized scope is only:

1. Add a side-effect-free `ToolIdentityResolver` module.
2. Add tests for `ToolIdentityResolver`.
3. Integrate resolver output into `ToolApprovalManager` approval matching only.
4. Add approval compatibility and regression tests.

Expected file scope should be narrow, for example:

```text
modules/toolIdentityResolver.js
modules/toolApprovalManager.js
tests/toolIdentityResolver.test.js
tests/toolApprovalManager.test.js
```

Do not modify:

```text
Plugin.js                       # especially execution dispatch
Plugin/VCPToolBridge/*
Plugin/SnowBridge/*
routes/taskScheduler.js
server.js human tool route
modules/aiImageExecutionAdapter.js
AdminPanel-Vue/*
.env
config.env
runtime/cache/state/log files
```

If implementation appears to require any of the above, stop and report.

## 7. ToolIdentityResolver Rules

`ToolIdentityResolver` must be pure and side-effect-free.
It must not execute tools, call plugins, write files, mutate config, or change runtime state.

Minimum resolution output:

```ts
{
  requestedToolName: string,
  canonicalToolName: string,
  registeredPluginName: string | null,
  command: string | null,
  aliases: string[],
  wasAlias: boolean,
  confidence: "exact" | "alias" | "unknown"
}
```

Patch 1A alias table is limited to evidence-backed aliases:

```text
PowerShellExecutor     -> ServerPowerShellExecutor
FileOperator           -> ServerFileOperator
LocalSearchController  -> ServerSearchController
VCPEverything          -> ServerSearchController
CodeSearcher           -> ServerCodeSearcher
```

Rules:

- Exact registered/canonical names remain exact.
- Known aliases map to canonical names for governance matching only.
- Unknown names remain unknown.
- `command` may be extracted from `toolArgs.command`.
- Command identifiers must not become standalone tool aliases.
- `DeleteFile`, `WriteFile`, `SearchCode`, `Get-ChildItem`, etc. are commands, not tools, unless an existing real tool with that exact name exists.
- No fuzzy matching.
- No display-name matching.
- No automatic alias generation from examples.

## 8. Approval Compatibility Rules

`ToolApprovalManager` must preserve existing behavior while making legacy approval rules protect canonical backend tools.

Approval matching may consider:

- requested tool name
- canonical tool name
- known aliases for the canonical tool
- command-specific forms for the above names

Examples that must work:

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
```

Negative example:

```text
approvalList = ["PowerShellExecutor"]
toolName = "ServerFileOperator"
command = "DeleteFile"
=> requiresApproval = false
```

Regression behavior must remain unchanged:

- `SciCalculator` approval behavior
- `approveAll=true`
- `::SilentReject`
- unknown tool behavior
- command names are not treated as tools

Optional decision fields may be added, but existing fields must not be removed:

```ts
requestedToolName?: string
canonicalToolName?: string
matchedCommand?: string | null
wasAlias?: boolean
```

Do not record raw args, env values, tokens, or secrets in approval evidence.

## 9. Execution Dispatch Must Not Change

The resolver is for governance and approval matching only.

Do not use `ToolIdentityResolver` to rewrite the actual executable plugin lookup path.
Do not make `PowerShellExecutor` automatically execute as `ServerPowerShellExecutor`.
Do not change `PluginManager.processToolCall()` dispatch semantics in Patch 1A.

If dispatch changes seem necessary, stop and report.

## 10. Testing Rules

Prefer small, safe local tests.

Allowed examples:

```powershell
node --check modules/toolIdentityResolver.js
node --check modules/toolApprovalManager.js
node tests/toolIdentityResolver.test.js
node tests/toolApprovalManager.test.js
```

If the repository uses another test harness, choose the smallest equivalent test command.

Do not run tests that execute real:

- PowerShell commands
- file writes/deletes
- bridge calls
- external sync/publish
- production services
- image generation
- secret access

Tests should assert behavior without executing dangerous plugins.

## 11. Diff Hygiene

Before final report, inspect the diff.

Required checks:

```powershell
git status --short
git diff --name-status
git diff --stat
```

A governance patch should not include unrelated changes such as:

- AdminPanel hashed build artifacts
- package lock churn unrelated to the task
- plugin business logic rewrites
- generated caches
- debug logs
- image outputs
- local runtime files

If unrelated changes appear, stop and report them separately.

## 12. Stop Conditions

Stop immediately and report if:

- working tree is dirty with unrelated changes
- the current branch is not the intended feature branch
- the task would require changing `PluginManager` execution dispatch
- tests require real shell/file/bridge/external-write execution
- env/secrets/runtime files would be touched
- bridge enablement would change
- production flags would be enabled
- command identifiers would need to become tool aliases
- approval compatibility cannot be tested safely
- scope expands beyond a small PR

## 13. Final Report Format

At the end of a coding task, report:

```text
1. Branch
- current branch:
- base:

2. Changed files
- ...

3. What changed
- ...

4. Tests run
- command: result

5. Safety confirmations
- PluginManager execution dispatch unchanged: yes/no
- No env/secret/config changes: yes/no
- No runtime/cache/state/debug changes: yes/no
- No bridge/default flag/deploy changes: yes/no
- No real shell/file/bridge/external write executed: yes/no

6. Rollback plan
- revert this PR / revert listed files

7. Open risks or deferred work
- ...
```

Do not claim success unless tests actually ran and passed.
If tests could not be run, say so plainly and explain why.

## 14. Reviewer Mindset

Act as if a strict reviewer will ask:

- Why is this change necessary?
- Why is this PR so small?
- How do we know it does not widen execution power?
- What proves approval behavior is preserved or tightened?
- What proves rollback is simple?
- What was intentionally deferred?

If you cannot answer those questions, narrow the change before continuing.

## 15. One-Sentence Principle

`prod/stable` is not a playground.
It is a locked darkroom: enter clean, touch little, leave evidence, and make every change reversible.
