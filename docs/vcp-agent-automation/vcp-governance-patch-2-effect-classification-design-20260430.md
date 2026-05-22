# VCP Governance Patch 2 Effect Classification Design

> Date: 2026-04-30
> Status: design only
> Scope: define effect-classification evidence for VCP tool execution governance
> Constraint: no implementation authorization
> Stable baseline assumed: `origin/prod/stable @ 6ceb8a0`
> Depends on: `docs/vcp-agent-automation/vcp-governance-patch-1-closure-ledger-20260430.md`

## Purpose

Patch 2 should define how VCP classifies the likely effect of a tool call
before any future autonomy discussion.

This patch is intentionally narrow:

```text
effect classification
+ conservative evidence
+ explicit unknown fallback
```

It does not authorize:

- automatic allow
- approval skipping
- dispatch rewriting
- broad plugin manifest migration
- external writes
- autonomy rollout

## Why Patch 2 Exists

Patch 1 established a usable governance baseline:

- requested vs canonical identity
- normalized caller context
- approval compatibility
- sanitized approval evidence

That baseline can answer:

```text
who is calling what,
from which entrypoint,
under which approval rule
```

It still cannot answer:

```text
what kind of effect this call is likely to have
```

Without effect classification, later policy work would still be guessing.

## Design Goal

Patch 2 should make this statement true:

```text
Before any future autonomy decision is discussed,
VCP can attach a conservative effect class to a tool call
using stable identity, command context, and explicit overrides.
```

## Non-Goals

Patch 2 does not:

- allow any tool to bypass human approval
- implement a full `RiskPolicyEngine`
- introduce low-risk auto-allow
- infer trust from `requestSource`
- rewrite `PluginManager.processToolCall()` dispatch
- reclassify tools using fuzzy matching
- make unknown effects permissive
- widen bridge execution power

## Governing Principle

Patch 2 should classify effect evidence, not grant permission.

The safe output of Patch 2 is:

```text
we know more clearly what this call appears to do
```

The unsafe output of Patch 2 would be:

```text
we now let the call run without asking
```

Patch 2 must stop at the first statement.

## Minimal Contract

Suggested classifier output:

```ts
type EffectClass =
  | "read_local"
  | "read_external"
  | "write_local"
  | "write_external"
  | "execute_shell"
  | "delete_or_destructive"
  | "credential_or_secret_touch"
  | "network_publish"
  | "ui_or_notification"
  | "unknown";

type EffectClassification = {
  requestedToolName: string;
  canonicalToolName: string;
  command: string | null;
  effectClass: EffectClass;
  confidence: "explicit" | "derived" | "unknown";
  reasons: string[];
  evidenceSources: string[];
};
```

Notes:

- `requestedToolName`, `canonicalToolName`, and `command` should come from the
  already-stable Patch 1 identity path.
- `effectClass` is the conservative classification output.
- `confidence` describes how directly the class was determined.
- `reasons` should be human-readable summaries, not raw args dumps.
- `evidenceSources` should name which rule source was used.

## Initial Effect Classes

Patch 2 should start with a small, stable vocabulary:

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

These classes are intentionally broad.

Patch 2 should prefer a slightly coarse but stable class over a detailed but
fragile taxonomy.

## Classification Inputs

Patch 2 should classify effect from explicit, inspectable sources only:

1. canonical tool name
2. command
3. selected argument shape hints
4. plugin-local metadata if already present
5. static override table

Patch 2 should not depend on:

- prompt wording
- display names
- fuzzy command similarity
- runtime side effects
- hidden external state

## Classification Sources And Priority

Suggested priority order:

1. explicit static override
2. explicit plugin-local metadata
3. command-specific override under canonical tool
4. canonical tool default
5. fallback to `unknown`

This order is intentionally conservative.

If multiple sources disagree, choose the more restrictive interpretation.

Example:

```text
canonical tool default = write_local
command override = delete_or_destructive
=> final class = delete_or_destructive
```

## Static Override Table

Patch 2 should begin with a small, reviewable static table.

The first table should target only high-impact and already-understood tools.

Suggested initial focus:

- `ServerPowerShellExecutor`
- `ServerFileOperator`
- `ServerSearchController`
- `ServerCodeSearcher`
- bridge-sensitive execution surfaces

Suggested examples:

```text
ServerSearchController -> read_local
ServerCodeSearcher -> read_local
ServerPowerShellExecutor:Get-ChildItem -> execute_shell
ServerFileOperator:ReadFile -> read_local
ServerFileOperator:WriteFile -> write_local
ServerFileOperator:DeleteFile -> delete_or_destructive
```

Important:

- shell calls should still classify as `execute_shell` even if a command looks
  read-only, because the execution surface itself is powerful
- delete-like operations should prefer `delete_or_destructive`
- unknown commands under powerful tools should not inherit a permissive class

## Treatment Of Powerful Surfaces

Some surfaces should remain conservatively classified by default.

### Shell execution

Default:

```text
ServerPowerShellExecutor -> execute_shell
```

Reason:

- command strings are too flexible
- read-looking commands can still chain or expand into risky behavior later
- Patch 2 is not the place to decide command safety

### File mutation

Default:

```text
ServerFileOperator unknown write/delete command -> delete_or_destructive
```

Reason:

- file writes and deletes have high blast radius
- path sensitivity is not yet modeled centrally

### Bridge-originated execution

Bridge origin should not soften classification.

At most, bridge metadata should become extra evidence attached beside the
effect class.

### Secret-bearing operations

Any explicit credential/config manipulation should classify as:

```text
credential_or_secret_touch
```

Even if the underlying tool is otherwise low-risk.

## Unknown Fallback

Unknown must remain conservative.

Patch 2 should use:

```text
effectClass = unknown
confidence = unknown
```

When:

- the canonical tool has no explicit mapping
- the command has no explicit mapping
- metadata is ambiguous
- multiple rules conflict and no safe merge is available

Unknown must not be silently remapped to a lower-risk class.

## Evidence Shape

Patch 2 should produce effect evidence that is safe to log and inspect.

Suggested evidence shape:

```ts
type ToolEffectEvidence = {
  requestedToolName: string;
  canonicalToolName: string;
  command: string | null;
  effectClass: EffectClass;
  effectConfidence: "explicit" | "derived" | "unknown";
  effectReasons: string[];
  effectEvidenceSources: string[];
  requestSource: string;
  agentAlias: string | null;
  agentId: string | null;
  operatorId?: string;
  bridgeId?: string;
  taskId?: string;
  invocationId?: string;
};
```

Effect evidence should:

- reuse normalized Patch 1 execution context
- avoid raw arg values
- avoid env values
- avoid secret-bearing payloads
- remain stable enough for later policy review

## Recommended Integration Shape

Patch 2 implementation, when authorized later, should prefer additive
integration.

Safe integration candidates:

1. build effect evidence alongside approval evidence
2. attach effect evidence to approval UI payloads
3. expose effect evidence in debug or audit surfaces
4. leave current approval execution behavior unchanged

Unsafe integration candidates for Patch 2:

- changing whether approval is required
- auto-allow based on effect class
- changing plugin lookup behavior
- changing bridge enablement behavior

## Validation Requirements

Patch 2, when implemented later, should require narrow unit coverage first.

Minimum test themes:

- exact explicit mapping wins
- command override can be stricter than tool default
- unknown canonical tool becomes `unknown`
- unknown command under powerful tool remains conservative
- bridge metadata does not reduce effect class
- no raw args or secrets are copied into effect evidence

Suggested positive examples:

```text
ServerSearchController -> read_local
ServerCodeSearcher -> read_local
ServerFileOperator:ReadFile -> read_local
ServerFileOperator:DeleteFile -> delete_or_destructive
```

Suggested conservative examples:

```text
ServerPowerShellExecutor:Get-ChildItem -> execute_shell
UnknownTool -> unknown
ServerFileOperator:UnmappedCommand -> delete_or_destructive
```

## Explicit Deferrals

The following should remain out of scope until after Patch 2 evidence is stable:

- policy actions like `allow`, `reject`, or `dry_run_only`
- `matchedPolicyIds`
- operator-facing auto-allow explanations
- plugin-manifest standardization across the whole repo
- low-risk autonomy rollout
- route-specific permission relaxation

Those belong to a later policy slice, not this design.

## Exit Criteria

Patch 2 should only be considered complete when all of the following are true:

1. effect classes are defined in a small stable vocabulary
2. high-impact tools have explicit conservative mappings
3. unknown effect defaults are explicit and tested
4. effect evidence shape is defined without secret leakage
5. no approval behavior changes are bundled into the patch

## Recommended Next Step After This Design

After this design is reviewed, the next safe move is a very small
implementation PR with this boundary:

```text
introduce EffectClassifier
+ static mapping table
+ unit tests
+ optional evidence emission
- no auto-allow
- no approval bypass
- no dispatch change
```

That would keep Patch 2 reversible, reviewable, and production-safe.

## Final Position

Patch 2 should be treated as the missing evidence layer between:

```text
identity/context compatibility
```

and:

```text
future policy reasoning
```

If Patch 1 answered:

```text
who is calling what
```

Then Patch 2 should answer:

```text
what kind of effect this call appears likely to have
```

It should not yet answer:

```text
therefore let it run without asking
```
