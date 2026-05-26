# Post-D4 Governance Next Decisions - 2026-05-26

This document records the current post-D4 governance state and the remaining
explicit decision packages. It is a planning artifact only. It does not
authorize pushing, deleting branches, removing worktrees, archiving, cleaning,
tagging, releasing, deploying, or touching production/runtime state.

## Current Verified State

- Control worktree: `A:/VCP/VCPToolBox-prod-stable`
- Control branch: `main`
- Latest verified `origin/main`: `e8b0c1de621bb2353e073eff8f3d8a14422b1bb0`
- Local `main` currently has local checkpoint record
  `6db847b` ahead of `origin/main`.
- Current ahead/behind: `HEAD...origin/main = 1 / 0`.
- Control worktree was clean at the read-only refresh.
- Dirty worktree `A:/VCP/VCPToolBox` remains on `feature/latest-updates`.
- Dirty worktree upstream comparison: `10 / 15` against
  `origin/feature/latest-updates`.
- Dirty worktree status count: `260` entries.
- No new automatically safe branch or worktree cleanup candidate was found.

## Decision N1 - Push Local Checkpoint Records

Default: pause until explicit push approval.

Facts:

- Local `main` contains local governance checkpoint commits beyond
  `origin/main`.
- Current local-only checkpoint head: `6db847b`.
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

- Patch-equivalent by `git cherry` count, but not a topological ancestor of
  `main`.
- Not occupied by a worktree.
- Deletion is still branch deletion and needs explicit approval.

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
- They have positive cherry deltas.
- They are not safe wholesale merge candidates.
- Remote rename or deletion is a remote write and requires explicit approval.

No automatic action is recommended.

## Decision N5 - Clean Worktree Feature Lines

Default: retain pending separate feature/archive review.

Branches:

- `lane10-codex-memory-intake-20260425`
- `codex/photo-studio-baserow-provider-batch`

Facts:

- Their worktrees are clean.
- Both still have positive cherry deltas relative to current `main`.
- Neither is an automatic cleanup candidate.

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
