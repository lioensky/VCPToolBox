# Branch Retention Policy Packages - 2026-05-26

This document converts the remaining branch and worktree state into explicit
retention, archive, and deletion policy packages. It is a planning artifact only;
it does not authorize deletion, force deletion, worktree removal, reset, merge, or
push.

Current baseline:

- Control worktree: `A:/VCP/VCPToolBox-prod-stable`
- Current branch: `main`
- `main` / `origin/main`: `765e2fa`
- Worktree status during this classification: clean

Hard protections:

- Keep `main`.
- Keep `prod/stable`; it is the stable production line and is permanently protected.
- Do not touch dirty/user-owned worktree `A:/VCP/VCPToolBox` without a separate backup or retention decision.
- Do not delete any branch occupied by a registered worktree unless that worktree is handled first.
- Do not delete remote branches without explicit remote deletion approval.

## Package P0 - Protected Branches

Action: retain.

Branches:

- `main`
- `prod/stable`
- `origin/main`
- `origin/prod/stable`

Reason:

- `main` is the current integration line.
- `prod/stable` is the protected production/stable line.

Validation:

- `git status -sb`
- `git rev-list --left-right --count main...origin/main`

Rollback:

- Not applicable; no action recommended.

## Package P1 - Worktree-Occupied Branches

Action: retain for now; require separate worktree retention/removal plan before any branch cleanup.

Branches and worktrees:

- `feature/latest-updates` at `A:/VCP/VCPToolBox`
- `integration/latest-updates-selective-absorb` at `A:/VCP/VCPToolBox/.agent_board/worktrees/latest-updates-selective-absorb`
- `lane10-codex-memory-intake-20260425` at `A:/VCP/VCPToolBox-photo-studio-export`
- `codex/photo-studio-baserow-provider-batch` at `A:/VCP/VCPToolBox-photo-studio-next`

Reason:

- These branches are actively registered in the Git worktree registry.
- `feature/latest-updates` is known dirty/user-owned.
- Removing these branches first would fail or risk losing worktree context.

Validation:

- `git worktree list --porcelain`
- Per-worktree `git status --short` before any future action.

Rollback:

- If a worktree cleanup is later approved, preserve dirty state first with a named stash,
  patch export, or archive plan before branch deletion.

## Package P2 - Duplicate Local AI Image Heads

Action options:

1. Retain as historical local labels.
2. Delete all three local labels under an explicit non-merged-branch deletion policy.
3. Keep one canonical label and delete the other duplicate labels under the same explicit policy.

Branches:

- `feature/ai-image-pipeline-dgp-refactor`
- `feature/ai-image-pipeline-dgp-v2`
- `rescue/ai-image-pipeline-mixed-20260427_195303`

Facts:

- All three point to `546b684`.
- They are not ancestors of `main`.
- They are not occupied by worktrees.
- They have no remote upstream.
- They show the same AI Image Agent branch content.

Risk:

- Ordinary `git branch -d` is expected to refuse because the head is not merged into `main`.
- Deletion would require an explicit policy allowing deletion of non-merged local labels.
- If deleted, the commit may still be reachable for a while by reflog, but branch-name
  recovery should not rely on reflog as long-term storage.

Suggested if cleanup is desired:

- Keep no local labels only if the user agrees the AI image branch content is no longer
  needed as a named branch.
- Otherwise keep `rescue/ai-image-pipeline-mixed-20260427_195303` as the historical label
  and delete the two feature duplicates.

Validation:

- `git rev-parse <branch>`
- `git branch --contains 546b684`
- `git branch --list <branch>`

Rollback:

```powershell
git branch <branch-name> 546b684
```

## Package P3 - Patch-Equivalent Topology Local Branch

Action options:

1. Retain as topology evidence.
2. Delete under explicit non-merged-branch deletion policy.

Branch:

- `governance/origin-main-topology-bridge-preview`

Facts:

- Head: `c5ce5d9`
- `git cherry main governance/origin-main-topology-bridge-preview` has no positive delta.
- It is not an ancestor of `main`.
- It is not occupied by a worktree.

Risk:

- This is likely topology/history evidence only.
- Ordinary `git branch -d` is expected to refuse because it is not topologically merged.

Validation:

- `git cherry main governance/origin-main-topology-bridge-preview`
- `git diff main...governance/origin-main-topology-bridge-preview`

Rollback:

```powershell
git branch governance/origin-main-topology-bridge-preview c5ce5d9
```

## Package P4 - Substantive Unmerged Local Branches

Action: retain pending separate feature/archive review.

Branches:

- `feature/photo-studio-guide-contract-migration`
- `feature/photo-studio-next-guide-contract`
- `integration/main-absorb-prod-stable-upstream-20260525`

Reason:

- These branches have positive cherry deltas relative to `main`.
- They are not ordinary cleanup candidates.
- They may contain historical plans, feature work, or already-rejected migration material.

Risk:

- Deleting without review could lose useful branch labels.
- Merging wholesale would roll back or conflict with current `main`.

Validation before future decisions:

- `git log --oneline main..<branch>`
- `git diff --stat main...<branch>`
- Domain-specific file review against current `main`.

Rollback:

- Preserve branch heads before deletion by recording hashes in the approval note.

## Package P5 - Old Unmerged Remote Lines

Action options:

1. Retain as remote archive branches.
2. Rename/archive in a separate remote operation if a naming convention is chosen.
3. Delete only with explicit approval that these unmerged remote lines are no longer needed.

Branches:

- `origin/backup-20260409`
- `origin/backup-merged-20260408210007`
- `origin/custom`
- `origin/custom-20260408205646`
- `origin/feature-2026-04-19`
- `origin/feature/latest-updates`
- `origin/feature/photo-studio-guide-contract-migration`
- `origin/feature/photo-studio-next-guide-contract`
- `origin/safe-upstream-main-20260407`
- `origin/safe-upstream-main-20260408205646`
- `origin/safe-upstream-main-20260409`

Facts:

- All remain unmerged into `origin/main`.
- All have positive cherry deltas.
- They are hundreds of commits behind current `origin/main`.
- They are not safe wholesale merge candidates.

Risk:

- Remote deletion is a remote write and needs explicit approval.
- Remote renaming is also remote write: create replacement ref, then delete old ref.
- Some local branches still track remote old lines, especially `feature/latest-updates`
  and photo-studio guide branches.

Validation before future decisions:

- `git rev-list --left-right --count origin/main...<remote-branch>`
- `git cherry origin/main <remote-branch>`
- `git diff --stat origin/main...<remote-branch>`
- `git for-each-ref --format='%(refname:short) %(upstream:short)' refs/heads`

Rollback:

- Before deleting, record each remote branch head hash.
- Recreate with:

```powershell
git push origin <hash>:refs/heads/<branch-name>
```

## Recommended Next Policy Order

1. Push this policy document and `.agent_board` updates to `origin/main` after review.
2. Leave P0 and P1 untouched.
3. Decide P2 as a small local-only cleanup package.
4. Decide P3 as a separate local topology cleanup package.
5. Treat P4 and P5 as retention/archive decisions, not cleanup chores.
