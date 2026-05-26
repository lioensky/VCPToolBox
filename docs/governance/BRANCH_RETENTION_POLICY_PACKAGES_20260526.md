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

### P1 Audit - 2026-05-26

Read-only audit result:

| Worktree | Branch | Status | Finding | Recommendation |
| --- | --- | --- | --- | --- |
| `A:/VCP/VCPToolBox` | `feature/latest-updates` | dirty, ahead 10 / behind 15 | Expanded dirty count observed as 261 entries; includes config, sqlite/runtime, deleted manifests, source/docs/tests, and untracked state paths. | Protect. Do not reset, remove, delete, or archive without a separate backup/retention decision. |
| `A:/VCP/VCPToolBox/.agent_board/worktrees/latest-updates-selective-absorb` | `integration/latest-updates-selective-absorb` | clean | `git cherry -v main HEAD` reports the single commit as patch-equivalent (`- 0e2890e`). | Local worktree/branch cleanup candidate, but only after explicit worktree removal approval because it is a registered worktree. |
| `A:/VCP/VCPToolBox-photo-studio-export` | `lane10-codex-memory-intake-20260425` | clean | Two positive cherry commits remain: Codex memory recall analytics and RAG diary wiring. | Retain pending feature/archive review. |
| `A:/VCP/VCPToolBox-photo-studio-next` | `codex/photo-studio-baserow-provider-batch` | clean, ahead 12 of upstream | Multiple positive cherry commits remain, including RAGDiary expand, GitSearch, VSearch config, and prompt/template changes. | Retain pending feature/archive review. |

Prepared P1 follow-up:

- P1A: protect `A:/VCP/VCPToolBox`; no action.
- P1B: optional cleanup candidate for `integration/latest-updates-selective-absorb` worktree and local branch after explicit approval.
- P1C: retain `lane10-codex-memory-intake-20260425`.
- P1D: retain `codex/photo-studio-baserow-provider-batch`.

P1B expected command shape only after explicit approval:

```powershell
git worktree remove A:/VCP/VCPToolBox/.agent_board/worktrees/latest-updates-selective-absorb
git branch -d integration/latest-updates-selective-absorb
```

P1B rollback:

```powershell
git worktree add A:/VCP/VCPToolBox/.agent_board/worktrees/latest-updates-selective-absorb integration/latest-updates-selective-absorb
```

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

### P4 Audit - 2026-05-26

Read-only audit result:

| Branch | Head | Finding | Recommendation |
| --- | --- | --- | --- |
| `feature/photo-studio-guide-contract-migration` | `1e1b0caa3629f8714540593be83b55121c409431` | 10 positive cherry commits remain. Diff is broad and includes legacy ChannelHub UI, adapter plugins, sqlite/runtime-like files, photo-studio guide migration, Codex memory material, and docs. | Retain as historical feature/archive label. Do not merge wholesale. |
| `feature/photo-studio-next-guide-contract` | `5d012125a6faf9dad6321facd4264077e2567da9` | Contains the guide migration plus newer DingTalk/live publish commits. Some commits are patch-equivalent to current `main`, but 10 positive cherry commits remain and diff is still broad. | Retain as historical feature/archive label. Do not merge wholesale. |
| `integration/main-absorb-prod-stable-upstream-20260525` | `562e9078b67a8378edba644a8c76666a55d12875` | Contains old governance evidence commits. Current `main` now has newer governance documents and `.agent_board` records, but this branch is not patch-equivalent by `git cherry`. | Retain as local historical governance label unless a future explicit non-merged local branch deletion policy is chosen. |

P4 prepared decision:

- No branch deletion recommended by default.
- No wholesale merge recommended.
- If future migration is desired, review by domain and cherry-pick only narrowly scoped current-value files.
- If future deletion is desired, record exact branch heads and use an explicit non-merged local branch deletion approval.

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

## Residual Merged Remote Cleanup - 2026-05-26

Status: completed.

Branch:

- `origin/feature/ai-image-agent-clean-pr`

Facts before deletion:

- Head was `fca8f44a70009498b3e8b1873a3dec57b90b27c7`.
- It was merged into `origin/main`.
- The local `feature/ai-image-agent-clean-pr` branch no longer existed.
- No local branch tracked it.

Executed action:

```powershell
git push origin --delete feature/ai-image-agent-clean-pr
```

Verification:

- `git fetch origin --prune`
- `refs/remotes/origin/feature/ai-image-agent-clean-pr` was absent.
- `main...origin/main = 0 / 0`
- `prod/stable...origin/prod/stable = 0 / 0`

Rollback:

```powershell
git push origin fca8f44a70009498b3e8b1873a3dec57b90b27c7:refs/heads/feature/ai-image-agent-clean-pr
```

## Recommended Next Policy Order

1. Push this policy document and `.agent_board` updates to `origin/main` after review.
2. Leave P0 and P1 untouched.
3. Decide P2 as a small local-only cleanup package.
4. Decide P3 as a separate local topology cleanup package.
5. Treat P4 and P5 as retention/archive decisions, not cleanup chores.

## Prepared Execution Package EP1 - Local Duplicate Label Cleanup

Status: completed locally on 2026-05-26.

Executed action: deleted duplicate feature labels and kept the rescue label.

Delete:

- `feature/ai-image-pipeline-dgp-refactor` - deleted
- `feature/ai-image-pipeline-dgp-v2` - deleted

Keep:

- `rescue/ai-image-pipeline-mixed-20260427_195303` - retained

Reason:

- All three local branches point to the same commit: `546b684e4f4f69003006aadd5ab968c4bffebae8`.
- None of the three is occupied by a worktree.
- Keeping the `rescue/` label preserves the historical recovery handle while removing duplicate feature names.
- This still requires explicit approval because the commit is not an ancestor of `main`; ordinary `git branch -d` is expected to refuse.

Expected command shape after explicit approval:

```powershell
git branch -D feature/ai-image-pipeline-dgp-refactor feature/ai-image-pipeline-dgp-v2
```

Execution result:

- `feature/ai-image-pipeline-dgp-refactor` deleted at `546b684`.
- `feature/ai-image-pipeline-dgp-v2` deleted at `546b684`.
- `rescue/ai-image-pipeline-mixed-20260427_195303` remains the local label containing `546b684`.
- `main` remained synchronized with `origin/main`.
- Registered worktrees were unchanged.

Post-check:

```powershell
git branch --contains 546b684
git branch --list feature/ai-image-pipeline-dgp-refactor feature/ai-image-pipeline-dgp-v2 rescue/ai-image-pipeline-mixed-20260427_195303
```

Rollback:

```powershell
git branch feature/ai-image-pipeline-dgp-refactor 546b684e4f4f69003006aadd5ab968c4bffebae8
git branch feature/ai-image-pipeline-dgp-v2 546b684e4f4f69003006aadd5ab968c4bffebae8
```

## Prepared Execution Package EP2 - Local Topology Evidence Branch

Status: prepared; no action taken.

Recommended action: retain unless the user wants a stricter local branch list.

Branch:

- `governance/origin-main-topology-bridge-preview`

Reason:

- It has no positive cherry delta relative to `main`.
- It is not occupied by a worktree.
- It is topology/history evidence, not active feature work.
- Deletion requires explicit non-merged local branch deletion approval because it is not an ancestor of `main`.

Expected command shape only if deletion is explicitly approved:

```powershell
git branch -D governance/origin-main-topology-bridge-preview
```

Rollback:

```powershell
git branch governance/origin-main-topology-bridge-preview c5ce5d933560081650e55b160433b37283c1f506
```

## Prepared Execution Package EP3 - Old Remote Line Archive Policy

Status: prepared; no remote action taken.

Recommended action: retain these remote branches as archive refs for now.

Reason:

- They are not merged into `origin/main`.
- They have positive cherry deltas.
- They are hundreds of commits behind current `origin/main`.
- Some local branches still track old remote lines.
- Deleting or renaming them would be a remote write and should be a separate explicit archive policy decision.

Current remote heads:

| Remote branch | Head | `origin/main...branch` | Current interpretation |
| --- | --- | --- | --- |
| `origin/backup-20260409` | `d7935ace74765b39c8629138a3c022a88f7d7893` | `595 / 4` | archive candidate, not merge cleanup |
| `origin/backup-merged-20260408210007` | `4628ac28b5c917cd023b12407a854cc69285dcd0` | `595 / 3` | archive candidate, not merge cleanup |
| `origin/custom` | `6f83d92cd9e6143344d24559132dd85ec5292f5f` | `600 / 24` | archive candidate, not merge cleanup |
| `origin/custom-20260408205646` | `d7935ace74765b39c8629138a3c022a88f7d7893` | `595 / 4` | archive candidate, not merge cleanup |
| `origin/feature-2026-04-19` | `a9525a1e33ce8cdd516b2bb0eb42733f2ce8b9d7` | `516 / 6` | archive candidate, not merge cleanup |
| `origin/feature/latest-updates` | `eba0969a156a24b498255778f539e0a08ee10f37` | `553 / 19` | retain while local dirty worktree tracks related line |
| `origin/feature/photo-studio-guide-contract-migration` | `1e1b0caa3629f8714540593be83b55121c409431` | `553 / 11` | retain while local tracking branch exists |
| `origin/feature/photo-studio-next-guide-contract` | `5d012125a6faf9dad6321facd4264077e2567da9` | `553 / 17` | retain while local tracking branch exists |
| `origin/safe-upstream-main-20260407` | `702bc4e7cf3dbdf42306c38a150058c674060fdc` | `600 / 2` | archive candidate, not merge cleanup |
| `origin/safe-upstream-main-20260408205646` | `d7935ace74765b39c8629138a3c022a88f7d7893` | `595 / 4` | archive candidate, not merge cleanup |
| `origin/safe-upstream-main-20260409` | `659daad3917b540eb4d96decd1eac263ecc62d49` | `581 / 9` | archive candidate, not merge cleanup |

If a future archive rename is desired, choose a naming convention first. Example:

```text
archive/2026-05-26/<original-branch-name>
```

Renaming on GitHub is a create-new-ref plus delete-old-ref operation, so it requires
explicit remote write approval and a branch-by-branch rollback list.

If a future deletion is desired, record the exact head hashes above in the approval
note and delete only the explicitly named remote branches.

Rollback for deleted remote branches:

```powershell
git push origin <hash>:refs/heads/<branch-name>
```
