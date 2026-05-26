# Post-D4 Governance Next Decisions - 2026-05-26

This document records the current post-D4 governance state and the remaining
explicit decision packages. It is a planning artifact only. It does not
authorize pushing, deleting branches, removing worktrees, archiving, cleaning,
tagging, releasing, deploying, or touching production/runtime state.

## Current Verified State

- Control worktree: `A:/VCP/VCPToolBox-prod-stable`
- Control branch: `main`
- Latest verified `origin/main`: `e8b0c1de621bb2353e073eff8f3d8a14422b1bb0`
- At the latest N2 read-only refresh start, local `main` had checkpoint record
  `dc8beb4` ahead of `origin/main`.
- Ahead/behind at latest N2 read-only refresh start:
  `HEAD...origin/main = 2 / 0`.
- At the latest N5 read-only refresh start, local `main` had checkpoint record
  `2ef54db` ahead of `origin/main`.
- Ahead/behind at latest N5 read-only refresh start:
  `HEAD...origin/main = 3 / 0`.
- At the latest N3 read-only refresh start, local `main` had checkpoint record
  `70f13d4` ahead of `origin/main`.
- Ahead/behind at latest N3 read-only refresh start:
  `HEAD...origin/main = 4 / 0`.
- At the latest N4 read-only refresh start, local `main` had checkpoint record
  `53c3a1b` ahead of `origin/main`.
- Ahead/behind at latest N4 read-only refresh start:
  `HEAD...origin/main = 5 / 0`.
- Recheck `HEAD` before any approved push because each local evidence commit
  advances the local-only head.
- Control worktree was clean at the read-only refresh.
- Dirty worktree `A:/VCP/VCPToolBox` remains on `feature/latest-updates`.
- Dirty worktree upstream comparison: `10 / 15` against
  `origin/feature/latest-updates`.
- Dirty worktree status count: `260` entries.
- Latest N2 read-only refresh: `41` tracked dirty entries, `219` untracked
  entries, `4` files with conflict markers, and `73` files matching
  secret/config-like patterns by filename-only scan.
- No new automatically safe branch or worktree cleanup candidate was found.

## Decision N1 - Push Local Checkpoint Records

Default: pause until explicit push approval.

Facts:

- Local `main` contains local governance checkpoint commits beyond
  `origin/main`.
- Local-only checkpoint head at latest N2 refresh start: `dc8beb4`.
- Pushing is a remote write and remains an A5 boundary.

Minimum preflight before push:

```powershell
git status --short
git log --oneline --decorate -n 8
git rev-list --left-right --count HEAD...origin/main
```

Post-check after approved push:

```powershell
git fetch origin main --prune
git rev-parse HEAD
git rev-parse origin/main
git rev-list --left-right --count HEAD...origin/main
```

## Decision N2 - Dirty Worktree Retention

Default: retain untouched.

Facts:

- `A:/VCP/VCPToolBox` is dirty and user-owned by policy.
- Reviewed dirty source candidates C1-C6 have no direct absorption path.
- D4A-D4F value packages have been completed or turned into proposal records
  from current `main`, not by copying dirty files.
- Latest read-only refresh confirms the dirty tree still contains conflict
  markers and secret/config-like risk signals, so retention remains the safest
  default.

Allowed without new approval:

- Read-only status refresh.
- Path-only governance records.
- Sanitized findings only.

Blocked without explicit approval:

- Reset, clean, delete, move, stash, archive, or copy dirty worktree files.
- Copy runtime/config/state material into `main`.
- Touch `.env`, `config.env`, sqlite/vector stores, logs, caches, generated
  reports, or runtime state.

## Decision N3 - Optional EP2 Local Topology Branch

Default: retain.

Branch:

- `governance/origin-main-topology-bridge-preview`

Current interpretation:

- Current head: `c5ce5d933560081650e55b160433b37283c1f506`.
- Patch-equivalent by `git cherry` count: `0` rows, `0` positive, `0`
  patch-equivalent/reapplied.
- `git diff --stat main...governance/origin-main-topology-bridge-preview`
  produces no file changes, though Git reports multiple merge bases.
- The branch is still not a topological ancestor of `main`.
- Branch-side log contains one topology record commit:
  `c5ce5d9 Record origin main topology closure without content changes`.
- Not occupied by a worktree.
- Deletion is still branch deletion and needs explicit approval.

Interpretation:

- Retain by default because it is harmless and deleting it is still destructive
  local branch cleanup.
- If a strict local branch list is desired, delete only as a separately
  approved EP2 package.

If deletion is approved, expected command:

```powershell
git branch -D governance/origin-main-topology-bridge-preview
```

Rollback:

```powershell
git branch governance/origin-main-topology-bridge-preview c5ce5d933560081650e55b160433b37283c1f506
```

## Decision N4 - Remote Old Lines

Default: retain as archive/retention refs.

Facts:

- Remaining old remote lines are still unmerged into `origin/main`.
- Current read-only count: `11` remote-tracking refs are not merged into
  `origin/main`.
- `git ls-remote --heads origin` confirms `14` current remote heads, and every
  local `origin/*` tracking hash matches the corresponding remote head hash.
- The unmerged old lines have positive cherry deltas and/or large file deltas.
- They are not safe wholesale merge candidates.
- Remote rename or deletion is a remote write and requires explicit approval.

Current unmerged old remote line summary:

| Remote ref | Behind / ahead vs `origin/main` | Cherry + / - | Diff files |
| --- | ---: | ---: | ---: |
| `origin/backup-20260409` | `621 / 4` | `3 / 0` | `219` |
| `origin/backup-merged-20260408210007` | `621 / 3` | `2 / 0` | `2` |
| `origin/custom` | `626 / 24` | `21 / 0` | `246` |
| `origin/custom-20260408205646` | `621 / 4` | `3 / 0` | `219` |
| `origin/feature-2026-04-19` | `542 / 6` | `4 / 0` | `181` |
| `origin/feature/latest-updates` | `579 / 19` | `10 / 6` | `337` |
| `origin/feature/photo-studio-guide-contract-migration` | `579 / 11` | `10 / 0` | `335` |
| `origin/feature/photo-studio-next-guide-contract` | `579 / 17` | `10 / 6` | `337` |
| `origin/safe-upstream-main-20260407` | `626 / 2` | `2 / 0` | `2` |
| `origin/safe-upstream-main-20260408205646` | `621 / 4` | `3 / 0` | `219` |
| `origin/safe-upstream-main-20260409` | `607 / 9` | `5 / 0` | `234` |

No automatic action is recommended.

## Decision N5 - Clean Worktree Feature Lines

Default: retain pending separate feature/archive review.

Branches:

- `lane10-codex-memory-intake-20260425`
- `codex/photo-studio-baserow-provider-batch`

Facts:

- Their worktrees are clean.
- Both still have substantive deltas relative to current `main`.
- `lane10-codex-memory-intake-20260425` is clean, has no upstream configured,
  has `2` positive cherry commits, is not an ancestor of `main`, and touches
  Codex memory/RAG/admin/test documentation surfaces across `7` files.
- `codex/photo-studio-baserow-provider-batch` is clean, tracks
  `origin/codex/photo-studio-baserow-provider-batch`, is ahead of that upstream
  by `12`, has `7` positive and `5` patch-equivalent/reapplied cherry entries
  relative to `main`, is not an ancestor of `main`, and touches Agent,
  GitSearch, RAG, VSearch, admin, and note surfaces across `21` files.
- Neither is an automatic cleanup candidate.

Interpretation:

- Treat both as retained feature/archive lines.
- Any future action should be a separate feature/archive review, not branch
  cleanup.

## Recommended Next Order

1. Decide whether to push local governance checkpoint records to `origin/main`.
2. Keep `A:/VCP/VCPToolBox` untouched unless a separate retention/archive/cleanup
   action is explicitly approved.
3. If a local cleanup is desired, decide EP2 as a small isolated branch-deletion
   package.
4. Keep old remote lines as archive refs unless a separate remote archive/delete
   policy is explicitly approved.
5. Treat any feature work from clean worktree lines as separate feature/archive
   review, not branch cleanup.
