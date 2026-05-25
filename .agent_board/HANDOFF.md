# Handoff

Goal: continue VCPToolBox branch/worktree governance after Package G2/R1/R2/R3/V3 progress.

Current safe state:

- Work is in `A:/VCP/VCPToolBox-prod-stable`.
- Branch is `main`.
- Worktree was clean before adding the V3 / Branch-Final notes.
- `main` and `origin/main` are synchronized at `39d860f`.
- `prod/stable` and `origin/prod/stable` are synchronized at `a1870b3`.

Critical distinctions:

- `A:/VCP/VCPToolBox-staging-custom-integration` was removed.
- `A:/VCP/VCPToolBox` is not latest main; it is dirty `feature/latest-updates`.
- `prod/stable` is permanently protected and never a cleanup candidate.
- `A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429` no longer appears in `git worktree list` and the plain residual folder has been raw-deleted after explicit approval.

Open risks:

- `A:/VCP/VCPToolBox` contains many local changes, including config/runtime-sensitive paths. Treat all as user-owned.
- Temporary `6005/6006` test services have been stopped; existing `3000` service was left untouched.

Next safe action:

- Commit the final residual-cleanup evidence update, then request explicit approval before any additional remote write.
