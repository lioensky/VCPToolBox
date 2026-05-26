# VCPToolBox Governance Run State

Status: active branch governance follow-up.
Workspace: `A:/VCP/VCPToolBox-prod-stable`.
Current branch: `main`.
Worktree status at last check: clean.

Current verified heads:

- `main` / `origin/main`: `b5fd3a3385fd6439a2d0462c6442d253201b7c24`.
- `prod/stable` / `origin/prod/stable`: `a1870b398fc82eb34c5764a9c60de9e127548494`.
- `origin/codex/absorb-upstream-main-20260526` is an ancestor of `origin/main`.

Important worktrees:

- `A:/VCP/VCPToolBox`: dirty `feature/latest-updates`, not latest main.
- `A:/VCP/VCPToolBox-photo-studio-next`: clean after Package R2 stash.
- `A:/VCP/VCPToolBox-staging-custom-integration`: removed.
- `A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429`: removed from Git worktree registry, then raw-deleted after explicit approval because Windows long paths had blocked normal deletion.

Preserved local state:

- `stash@{0}`: Package R3 detached preflight dist snapshot.
- `stash@{1}`: Package R2 photo-studio-next dirty tail.

Running local services:

- Main test service on port `6005`: stopped.
- Admin test service on port `6006`: stopped.
- Existing unrelated service: port `3000`, left untouched.

Hard rules:

- `main` is the most advanced/latest integration branch.
- `prod/stable` is the stable production line and must never be deleted.
- Do not delete worktrees, branches, runtime files, or remote refs without explicit approval.

2026-05-26 branch governance follow-up:

- Read-only branch classification completed after `origin/main` was pushed to `b5fd3a3`.
- Remote branches already merged into `origin/main` include the 2026-05-26 absorb branch, prod-stable codex branches, gov-patch branches, photo-studio p0-p7 branches, `origin/feature/ai-image-agent-clean-pr`, `origin/prod/stable`, and `origin/revert/pr-35-identity-evidence-20260430`.
- Remote branches still not merged into `origin/main`: old `backup-*`, `custom*`, `feature-2026-04-19`, `feature/latest-updates`, `feature/photo-studio-guide-contract-migration`, `feature/photo-studio-next-guide-contract`, and old `safe-upstream-main-*` lines.
- These unmerged remote branches are hundreds of commits behind current `main`; do not absorb them wholesale.
- Next remote cleanup or branch deletion requires explicit approval.

2026-05-26 remote cleanup execution:

- User approved deleting the explicitly listed remote cleanup package.
- Preflight count correction: the explicit list contained 31 branches, not 32.
- Deleted those 31 merged remote branches with `git push origin --delete`.
- Verified all 31 deleted refs are absent after `git fetch origin --prune`.
- Verified protected/excluded refs still exist: `origin/main`, `origin/prod/stable`, `origin/codex/photo-studio-baserow-provider-batch`, `origin/feature/ai-image-agent-clean-pr`, and `origin/feature/latest-updates`.
