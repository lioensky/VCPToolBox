# Handoff

Goal: continue VCPToolBox branch/worktree governance after `main` was pushed to `origin/main`.

Current safe state:

- Work is in `A:/VCP/VCPToolBox-prod-stable`.
- Branch is `integration/main-absorb-prod-stable-upstream-20260525`.
- Worktree was clean before adding these governance notes.
- `main` and `origin/main` are synchronized at `55b51ca`.
- `prod/stable` and `origin/prod/stable` are synchronized at `a1870b3`.

Critical distinctions:

- `A:/VCP/VCPToolBox-staging-custom-integration` is the latest clean main worktree.
- `A:/VCP/VCPToolBox` is not latest main; it is dirty `feature/latest-updates`.
- `prod/stable` is permanently protected and never a cleanup candidate.

Open risks:

- `A:/VCP/VCPToolBox` contains many local changes, including config/runtime-sensitive paths. Treat all as user-owned.
- `A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429` is detached and dirty.
- Temporary `6005/6006` test services have been stopped; existing `3000` service was left untouched.

Next safe action:

- After Package G-doc-commit, continue only with explicitly approved worktree removal/cleanup packages.
