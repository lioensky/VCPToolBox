# Branch / Worktree Governance Final Status

Updated: 2026-05-25 19:50 Asia/Shanghai.

This file records the current governance state after Package G2, R1, R2, R3, and V3 progress.

## 1. Main And Stable Branch Rules

- `main` is the most advanced/latest integration branch.
- `prod/stable` is the stable production line.
- `prod/stable` is permanently protected and must never be deleted.
- `main` contains `prod/stable`; `prod/stable` must not be overwritten by broad `main` changes.

## 2. Verified Heads

- `main` / `origin/main`: `39d860fa07bf55c07acb3eaed70dc9178e81716b`
- `prod/stable` / `origin/prod/stable`: `a1870b398fc82eb34c5764a9c60de9e127548494`

Package G2 result:

- Governance evidence was cherry-picked from `562e907` onto `main` as `39d860f`.
- `origin/main` was pushed and verified at `39d860f`.

## 3. Worktree Status

Current registered worktrees:

- `A:/VCP/VCPToolBox`: `feature/latest-updates`, dirty high-risk user-owned worktree.
- `A:/VCP/VCPToolBox-photo-studio-export`: `lane10-codex-memory-intake-20260425`.
- `A:/VCP/VCPToolBox-photo-studio-next`: `codex/photo-studio-baserow-provider-batch`, now clean after Package R2 stash.
- `A:/VCP/VCPToolBox-prod-stable`: `main`, current control worktree.

Removed from Git worktree registry:

- `A:/VCP/VCPToolBox-staging-custom-integration`
- `A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429`

Important residual:

- `A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429` still exists as a plain folder after `git worktree remove` failed to delete it because of Windows `Filename too long`.
- It no longer appears in `git worktree list`.
- It no longer has `.git`.
- Its dirty `AdminPanel-Vue/dist` build snapshot was preserved in `stash@{0}` before removal.
- Raw recursive directory deletion remains pending explicit approval.

## 4. Preserved Stashes

- `stash@{0}`: `Package R3 detached preflight dist snapshot 20260525`
- `stash@{1}`: `Package R2 photo-studio-next dirty tail 20260525`

These stashes preserve local dirty state before cleanup.

## 5. Remaining Governance Decisions

Do not delete:

- `prod/stable`
- `A:/VCP/VCPToolBox`

Pending explicit approval:

- Raw recursive cleanup of the residual folder `A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429`.
- Any branch deletion.
- Any cleanup of runtime/state/secret-bearing paths in `A:/VCP/VCPToolBox`.

Recommended future feature/doc packages:

- DingTalkTable compatibility shim on current `main`.
- interaction-middleware docs intake.
- OneBot adapter docs repair.
- optional ZImageGen/ZImageGen2 image-rating auto-registration behind explicit config.

## 6. Current Result

Branch/worktree governance is mostly complete, but not fully closed because one orphaned residual directory remains on disk and needs a separate long-path deletion action.
