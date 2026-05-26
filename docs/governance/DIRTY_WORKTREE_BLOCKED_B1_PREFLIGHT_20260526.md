# Dirty Worktree Blocked B1 Preflight - 2026-05-26

Scope: read-only preflight for the B1 A2 blocked/excluded paths remaining in
dirty worktree `A:/VCP/VCPToolBox`.

This document is evidence and planning only. It does not authorize deleting,
restoring, moving, copying, archiving, resetting, cleaning, changing branches,
pushing, or touching production/runtime state.

## Current Verified State

- Control worktree: `A:/VCP/VCPToolBox-prod-stable`
- Control branch: `main`
- Control `main` / `origin/main`: synchronized at
  `db1d40feda0a9b5fc0dceee7b510771042ec1420`
- Dirty worktree: `A:/VCP/VCPToolBox`
- Dirty branch: `feature/latest-updates`
- Dirty HEAD: `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`
- Dirty upstream comparison: `10 / 15`
- Dirty status count: `176`

## Scope

The B1 scope is the A2 blocked/excluded bucket from:

```text
docs/governance/DIRTY_WORKTREE_REMAINING_213_REASSESSMENT_20260526.md
```

B1 count: `9`

```text
 M 一键启动服务器start_server.bat
 M AdminPanel/index.html
 M AdminPanel/script.js
 M AdminPanel/style.css
 M EmbeddingUtils.js
?? Plugin/DeepWikiVCP/package-lock.json
 M Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js
?? Plugin/vcp-dingtalk-adapter/CUsers617Desktoptools_response.json
 M server.js
```

These paths were excluded from A2 archive/cleanup because they are
source/security-sensitive, path-ambiguous, dependency-lock-like, or otherwise
not safe for mechanical cleanup.

## Read-Only Check Result

No matching secret-like values were recorded.

```text
B1 count                       9
Dirty status count             9
Tracked modified count         7
Untracked count                2
Existing count                 9
Binary-content count           0
Valid JSON count               1
Sensitive-pattern files        8
Sensitive-pattern matches      30
Conflict-marker files          0
Conflict-marker lines          0
```

Tracked diff summary:

```text
AdminPanel/index.html                         19 inserts / 3 deletes
AdminPanel/script.js                           4 inserts / 0 deletes
AdminPanel/style.css                          62 inserts / 7 deletes
EmbeddingUtils.js                            179 inserts / 75 deletes
Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js       70 inserts / 26 deletes
server.js                                     13 inserts / 0 deletes
一键启动服务器start_server.bat                 95 inserts / 4 deletes
```

`git diff --check` over the tracked B1 paths reported no whitespace or conflict
marker errors. This is only a diff hygiene check, not a functional validation.

## Per-Path Metadata

```text
一键启动服务器start_server.bat
  status: M
  tracked: true
  bytes: 4278
  sha256: 65C5ABF97CC80A3A95C089FD3AF169249499C9443E09CB1C84BB42121E45455D
  line count: 130
  sensitive-pattern matches: 0
  conflict-marker lines: 0
  interpretation: launch script; do not import/restore without startup-policy review

AdminPanel/index.html
  status: M
  tracked: true
  bytes: 84148
  sha256: 917704C57CE56061BFAA069D6ACC9EB10057DEC8A6E2FA2FA5665E879585D615
  line count: 1788
  sensitive-pattern matches: 8
  conflict-marker lines: 0
  interpretation: legacy static AdminPanel edit; previously rejected for direct migration

AdminPanel/script.js
  status: M
  tracked: true
  bytes: 14877
  sha256: 9B46A50B8C8EA432E6A3F1F6514A6F0134D6D9971D36BA06A6696EF9F1612AAE
  line count: 329
  sensitive-pattern matches: 2
  conflict-marker lines: 0
  interpretation: legacy static AdminPanel edit; current main uses newer admin surfaces

AdminPanel/style.css
  status: M
  tracked: true
  bytes: 108587
  sha256: 365531BF8A9BF0CB687A0B5ECC9ACA572ECF61C53DC2054878FC70F9B56F250F
  line count: 4443
  sensitive-pattern matches: 5
  conflict-marker lines: 0
  interpretation: legacy static AdminPanel style edit; not a direct intake candidate

EmbeddingUtils.js
  status: M
  tracked: true
  bytes: 12891
  sha256: CED2D051C873858F30AA5FC8A020DBEF02C4FF1522F8FD18FC8B63F4A9864DEA
  line count: 333
  sensitive-pattern matches: 1
  conflict-marker lines: 0
  interpretation: shared embedding utility; requires source/security review

Plugin/DeepWikiVCP/package-lock.json
  status: ??
  tracked: false
  bytes: 73931
  sha256: 46F0F84ED086E4C2A9A2A5FDED323C2D41CD8EBCC09C62FAB68F138B0C8A97EA
  line count: 1871
  valid JSON: false
  sensitive-pattern matches: 8
  conflict-marker lines: 0
  interpretation: dependency-lock-like untracked file; invalid JSON and not approved for dependency intake

Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js
  status: M
  tracked: true
  bytes: 199429
  sha256: EAB59695E8F453B42D6EE8DCA5A299F067D8C13631903F19F6CB097868F30B4F
  line count: 4171
  sensitive-pattern matches: 2
  conflict-marker lines: 0
  interpretation: large core plugin source; requires dedicated source/security review

Plugin/vcp-dingtalk-adapter/CUsers617Desktoptools_response.json
  status: ??
  tracked: false
  bytes: 230461
  sha256: 4347D45A6655C6938F143C24525EA9EFB916199E47860ECB77F1A4123CD5A60D
  line count: 1
  valid JSON: true
  sensitive-pattern matches: 2
  conflict-marker lines: 0
  interpretation: path-ambiguous tool response artifact; do not commit or normal-archive

server.js
  status: M
  tracked: true
  bytes: 67036
  sha256: 34AB11C88CB34BEB5874CF47844402613C46F7F9E7B8A5105B02BDB57A32F072
  line count: 1489
  sensitive-pattern matches: 2
  conflict-marker lines: 0
  interpretation: primary server entrypoint; requires dedicated source/security review
```

## Risk Interpretation

B1 remains blocked.

Reasons:

- `server.js`, `EmbeddingUtils.js`, and `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js`
  affect shared runtime or core plugin behavior.
- `AdminPanel/**` is legacy static admin UI and was previously rejected for
  direct migration because current `main` carries newer admin implementation
  surfaces.
- `Plugin/DeepWikiVCP/package-lock.json` is dependency-lock-like, untracked,
  invalid JSON in this read-only parse, and not approved for dependency intake.
- `Plugin/vcp-dingtalk-adapter/CUsers617Desktoptools_response.json` is a large
  untracked tool response artifact with a path-ambiguous filename.
- `一键启动服务器start_server.bat` changes startup behavior and needs a
  startup-policy review before intake.
- Sensitive-pattern matches exist in `8` files, so raw content should not be
  copied into governance docs, issues, PRs, memory, or normal archives.

## Recommended Policy

Recommended current decision: retain blocked status for B1.

Do not bulk archive, delete, restore, or import this bucket.

Prepared follow-ups:

```text
B1-R0 retain blocked bucket
  No file operation. Keep all 9 paths in the dirty worktree for context.

B1-S1 source/security review
  Review named source paths one at a time, starting with either server.js or
  EmbeddingUtils.js, against current main.

B1-Q1 quarantine-sensitive artifact preflight
  Prepare a separate quarantine plan only for untracked sensitive-pattern
  artifacts, without printing matching values.

B1-D0 cleanup to current-main state
  Destructive cleanup package. Requires exact path list, rollback strategy, and
  explicit approval.
```

## Hard Boundaries

Do not perform any of the following without explicit approval:

- deleting or restoring any B1 path
- copying raw sensitive-pattern files into governance docs or normal archives
- importing dirty source/runtime/admin/startup contents into `main`
- accepting dependency-lock changes
- broad checkout, broad restore, `git clean`, or `git reset`
- touching env/config/runtime/data paths outside this read-only preflight
- branch deletion or worktree removal
- push, tag, release, deploy, live DingTalk/MCP/DWS command, or production write

## Approval Template For Future Retain Decision

```text
批准执行 B1-R0 retain blocked bucket：
target = A:/VCP/VCPToolBox
scope = docs/governance/DIRTY_WORKTREE_BLOCKED_B1_PREFLIGHT_20260526.md B1 list
count = 9
action = retain only; no file operation
```

Without a future explicit approval, stop at this preflight.
