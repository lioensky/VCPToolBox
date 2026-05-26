# Dirty Worktree Manifest Toggles Preflight - 2026-05-26

Scope: read-only preflight for plugin manifest toggle entries remaining in dirty
worktree `A:/VCP/VCPToolBox`.

This document is evidence and planning only. It does not authorize deleting,
restoring, moving, copying, archiving, resetting, cleaning, changing plugin
enablement, changing branches, pushing, or touching production/runtime state.

## Current Verified State

- Control worktree: `A:/VCP/VCPToolBox-prod-stable`
- Control branch: `main`
- Control `main` / `origin/main`: synchronized at
  `3d3046149a885d88d4db960ad300f702c33de04d`
- Dirty worktree: `A:/VCP/VCPToolBox`
- Dirty branch: `feature/latest-updates`
- Dirty HEAD: `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`
- Dirty upstream comparison: `10 / 15`
- Dirty status count: `176`

## Scope

The manifest-toggle scope is the M1 bucket from:

```text
docs/governance/DIRTY_WORKTREE_REMAINING_213_REASSESSMENT_20260526.md
```

M1 candidate count: `28`

These entries are behavior-affecting plugin enable/disable or manifest-version
changes. They must not be normalized mechanically.

## Read-Only Check Result

Parsed with `git status --porcelain=v1 -z --untracked-files=all` and
literal-path checks.

```text
Candidate count              28
Dirty status count           28
Existing file count          15
Deleted status count         13
Modified status count        1
Untracked status count       14
Valid JSON existing count    15
Exists in current main count 14
Sensitive-pattern files      0
Sensitive-pattern matches    0
```

No file was copied, modified, restored, deleted, checked out, or archived.

## Candidate List

```text
?? Plugin/DailyNoteManager/plugin-manifest.json
 D Plugin/DailyNoteManager/plugin-manifest.json.block
 M Plugin/DeepWikiVCP/plugin-manifest.json
?? Plugin/DingTalkTable/plugin-manifest.json
 D Plugin/GeminiImageGen/plugin-manifest.json
?? Plugin/GeminiImageGen/plugin-manifest.json.block
 D Plugin/GoogleSearch/plugin-manifest.json
?? Plugin/GoogleSearch/plugin-manifest.json.block
 D Plugin/GrokVideo/plugin-manifest.json
?? Plugin/GrokVideo/plugin-manifest.json.block
 D Plugin/JapaneseHelper/plugin-manifest.json
?? Plugin/JapaneseHelper/plugin-manifest.json.block
 D Plugin/NanoBananaGen2/plugin-manifest.json
?? Plugin/NanoBananaGen2/plugin-manifest.json.block
 D Plugin/NanoBananaGenOR/plugin-manifest.json
?? Plugin/NanoBananaGenOR/plugin-manifest.json.block
 D Plugin/NovelAIGen/plugin-manifest.json
?? Plugin/NovelAIGen/plugin-manifest.json.block
 D Plugin/PyCameraCapture/plugin-manifest.json
?? Plugin/PyCameraCapture/plugin-manifest.json.block
 D Plugin/SnowBridge/plugin-manifest.json
?? Plugin/SnowBridge/plugin-manifest.json.block
 D Plugin/SunoGen/plugin-manifest.json
?? Plugin/SunoGen/plugin-manifest.json.block
?? Plugin/SynapsePusher/plugin-manifest.json
 D Plugin/SynapsePusher/plugin-manifest.json.block
?? Plugin/ToolBoxFoldMemo/plugin-manifest.json
 D Plugin/ToolBoxFoldMemo/plugin-manifest.json.block
```

## Grouped Interpretation

### Already Resolved In Current Main

These dirty toggles overlap behavior that current `main` already resolved or
superseded. They are not source-intake candidates from the dirty worktree.

```text
DailyNoteManager      dirty unblocks a manifest, but current main already has a tracked manifest
DingTalkTable         dirty has an untracked manifest, but current main already has the validated plugin
SynapsePusher         dirty unblocks a manifest, but current main already has a tracked manifest
```

`DailyNoteManager` and `DeepWikiVCP` were previously classified as downgrade
risk in governance review. `DingTalkTable` was separately rebuilt through the
current-main DingTalkCLI compatibility path, not by importing the dirty
untracked manifest.

### Dirty Disables Plugins That Current Main Keeps Enabled

These are paired `D` active manifest plus `??` blocked manifest entries. They
would disable plugins relative to current `main` and must not be applied as
cleanup.

```text
GeminiImageGen
GoogleSearch
GrokVideo
JapaneseHelper
NanoBananaGen2
NanoBananaGenOR
NovelAIGen
PyCameraCapture
SnowBridge
SunoGen
```

### Modified Manifest Requiring Separate Review

```text
DeepWikiVCP
```

Dirty `Plugin/DeepWikiVCP/plugin-manifest.json` is a modified tracked manifest
and was previously rejected as a downgrade path. Do not restore, import, or
reapply without a new plugin-specific review.

### Candidate-Only Dirty Enablement

```text
ToolBoxFoldMemo
```

The dirty worktree has an untracked active manifest and deleted tracked block
file, while current `main` has neither path. Treat this as a candidate-only
enablement proposal, not a cleanup item.

## Recommended Policy

Recommended current decision: retain-by-default for M1.

Reasoning:

- Manifest toggles change runtime capability and plugin enablement.
- Several dirty entries would disable plugins that current `main` keeps enabled.
- Several dirty entries are already superseded by current-main implementation
  work.
- One dirty entry is candidate-only enablement and needs plugin-level review.
- Bulk restore/delete would hide behavior decisions inside cleanup.

## Future Packages

Prepared safe follow-ups:

```text
M1-R0 retain manifest toggles
  No file operation. Keep the 28 entries in the dirty worktree for manual
  context only.

M1-P1 plugin-by-plugin reject/restore plan
  Prepare a per-plugin restore/delete plan only after deciding each plugin's
  target enablement state in current main.

M1-I1 candidate intake review
  Review only ToolBoxFoldMemo, or another named plugin, as a feature proposal.

M1-D0 cleanup to current-main state
  Destructive cleanup package. Requires exact path list, plugin-level
  decisions, rollback strategy, and explicit approval.
```

## Hard Boundaries

Do not perform any of the following without explicit approval:

- deleting untracked `.block` or active manifest files
- restoring deleted active manifests or `.block` manifests
- applying dirty manifest contents to `main`
- changing plugin enablement
- broad checkout, broad restore, `git clean`, or `git reset`
- touching env/config/runtime/data paths
- branch deletion or worktree removal
- push, tag, release, deploy, live DingTalk/MCP/DWS command, or production write

## Approval Template For Future Retain Decision

```text
批准执行 M1-R0 retain manifest toggles：
target = A:/VCP/VCPToolBox
scope = docs/governance/DIRTY_WORKTREE_MANIFEST_TOGGLES_PREFLIGHT_20260526.md M1 candidate list
count = 28
action = retain only; no file operation
```

Without a future explicit approval, stop at this preflight.
