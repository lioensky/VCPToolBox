# Handoff

Goal: continue VCPToolBox branch/worktree governance after Package G2/R1/R2/R3/V3 progress and the 2026-05-26 upstream absorb.

Current safe state:

- Work is in `A:/VCP/VCPToolBox-prod-stable`.
- Branch is `main`.
- Worktree was clean before the 2026-05-26 branch governance evidence update.
- `main` and `origin/main` are synchronized at `b5fd3a3`.
- `prod/stable` and `origin/prod/stable` are synchronized at `a1870b3`.
- `origin/codex/absorb-upstream-main-20260526` was absorbed into `origin/main` and then deleted during the approved remote cleanup package.

Critical distinctions:

- `A:/VCP/VCPToolBox-staging-custom-integration` was removed.
- `A:/VCP/VCPToolBox` is not latest main; it is dirty `feature/latest-updates`.
- `prod/stable` is permanently protected and never a cleanup candidate.
- `A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429` no longer appears in `git worktree list` and the plain residual folder has been raw-deleted after explicit approval.

Open risks:

- `A:/VCP/VCPToolBox` contains many local changes, including config/runtime-sensitive paths. Treat all as user-owned.
- Temporary `6005/6006` test services have been stopped; existing `3000` service was left untouched.
- Unmerged old remote lines are hundreds of commits behind current `main`; do not merge them wholesale.
- Remote branch deletion is a remote write and needs explicit approval with branch names.
- 31 explicitly listed merged remote branches were deleted after user approval and verified absent.
- Two fully merged local branches were deleted after user approval: `backup/absorb-upstream-main-20260526-merge` and `feature/ai-image-agent-clean-pr`.
- Remaining local branch classification is recorded in `RUN_STATE.md`; there are no remaining ordinary `git branch -d` cleanup candidates except protected `prod/stable`.

Next safe action:

- Continue only with explicit retention/deletion decisions for non-merged local branches, occupied worktrees, or unmerged old remote lines.
