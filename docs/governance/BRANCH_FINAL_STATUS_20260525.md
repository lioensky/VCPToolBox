# Branch / Worktree Governance Final Status

Updated: 2026-05-26 Asia/Shanghai.

This file records the current governance state after Package G2, R1, R2, R3, V3,
the 2026-05-26 upstream absorb, remote cleanup, local cleanup, and retention
policy packaging.

## 1. Main And Stable Branch Rules

- `main` is the most advanced/latest integration branch.
- `prod/stable` is the stable production line.
- `prod/stable` is permanently protected and must never be deleted.
- `main` contains `prod/stable`; `prod/stable` must not be overwritten by broad `main` changes.

## 2. Verified Heads

- `main` / `origin/main`: `d985622f5081b0bc95f9fed46d1a0b90f51c0f32` before the final local P1/P4 evidence commits.
- `prod/stable` / `origin/prod/stable`: `a1870b398fc82eb34c5764a9c60de9e127548494`

2026-05-26 main results:

- `origin/codex/absorb-upstream-main-20260526` was absorbed into `main` as merge commit `b5fd3a3`.
- 31 explicitly listed merged remote branches were deleted and verified absent.
- Residual merged remote branch `origin/feature/ai-image-agent-clean-pr` was later deleted after confirming it was merged and no local branch still tracked it.
- Duplicate local AI image feature labels were deleted; `rescue/ai-image-pipeline-mixed-20260427_195303` was retained.
- Branch retention policy packages are documented in `docs/governance/BRANCH_RETENTION_POLICY_PACKAGES_20260526.md`.
- P1 worktree audit and P4 local unmerged branch audit were completed locally.

## 3. Worktree Status

Current registered worktrees:

- `A:/VCP/VCPToolBox`: `feature/latest-updates`, dirty high-risk user-owned worktree.
- `A:/VCP/VCPToolBox/.agent_board/worktrees/latest-updates-selective-absorb`: `integration/latest-updates-selective-absorb`, clean and patch-equivalent to current `main`; optional cleanup candidate after explicit worktree removal approval.
- `A:/VCP/VCPToolBox-photo-studio-export`: `lane10-codex-memory-intake-20260425`.
- `A:/VCP/VCPToolBox-photo-studio-next`: `codex/photo-studio-baserow-provider-batch`, clean and ahead of its upstream.
- `A:/VCP/VCPToolBox-prod-stable`: `main`, current control worktree.

Removed from Git worktree registry:

- `A:/VCP/VCPToolBox-staging-custom-integration`
- `A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429`

Final residual cleanup:

- `A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429` no longer exists on disk.
- It was first removed from the Git worktree registry.
- It had no `.git` marker before raw deletion.
- Its dirty `AdminPanel-Vue/dist` build snapshot was preserved in `stash@{0}` before removal.
- The plain residual folder was raw-deleted only after explicit user approval, using PowerShell long-path handling and an `A:/VCP/` boundary check.

## 4. Preserved Stashes

- `stash@{0}`: `Package R3 detached preflight dist snapshot 20260525`
- `stash@{1}`: `Package R2 photo-studio-next dirty tail 20260525`

These stashes preserve local dirty state before cleanup.

## 5. Remaining Governance Decisions

Do not delete:

- `prod/stable`
- `A:/VCP/VCPToolBox`

Pending explicit approval:

- Optional cleanup of `integration/latest-updates-selective-absorb` worktree and local branch.
- Any non-merged local branch deletion, including `governance/origin-main-topology-bridge-preview`.
- Any old unmerged remote line rename or deletion.
- Any cleanup of runtime/state/secret-bearing paths in `A:/VCP/VCPToolBox`.

Recommended future feature/doc packages:

- DingTalkTable compatibility shim on current `main`.
- interaction-middleware docs intake.
- OneBot adapter docs repair.
- optional ZImageGen/ZImageGen2 image-rating auto-registration behind explicit config.

## 6. Current Result

Branch/worktree governance is closed to a documented retention state:

- Every remaining branch/worktree has a documented retain, archive, or explicit-approval path.
- No remaining branch is an unclassified cleanup candidate.
- The only remaining remote branch merged into `origin/main` outside protected refs is `origin/codex/photo-studio-baserow-provider-batch`, retained because a local worktree branch still tracks it.
- `prod/stable` remains protected.
- `A:/VCP/VCPToolBox` remains protected as dirty user-owned state.
- P1B is the only low-risk optional cleanup candidate, but still requires explicit approval because it removes a registered worktree.
