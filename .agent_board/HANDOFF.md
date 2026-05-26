# Handoff

Goal: continue VCPToolBox branch/worktree governance after the 2026-05-26
upstream absorb, D4 value-package closure, and post-D4 N1-N5 governance
refresh.

Current safe state:

- Work is in `A:/VCP/VCPToolBox-prod-stable`.
- Branch is `main`.
- Worktree was clean before the latest local handoff refresh.
- `origin/main` is verified at `e8b0c1de621bb2353e073eff8f3d8a14422b1bb0`.
- Local `main` was `05c1cf99e256f7b9dc65f54a5fd1abeab3412831`
  before this handoff refresh, ahead of `origin/main` by `6 / 0`.
- Recheck `HEAD` before any approved push because each local evidence commit
  advances the local-only head.
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
- Branch retention policy packages P0-P5 are documented in `docs/governance/BRANCH_RETENTION_POLICY_PACKAGES_20260526.md`.
- Post-D4 next decisions N1-N5 are documented in
  `docs/governance/POST_D4_GOVERNANCE_NEXT_DECISIONS_20260526.md`.
- N2, N3, N4, and N5 have been rechecked read-only and recorded locally.
- Current local-only governance commits since `origin/main`:
  `6db847b`, `dc8beb4`, `2ef54db`, `70f13d4`, `53c3a1b`, and `05c1cf9`.
- These local records are not pushed yet.

Next safe action:

- Stop before A5 actions unless explicitly approved.
- The natural next A5 action is N1: push local governance checkpoint records to
  `origin/main`.
- Other explicit-decision actions remain blocked without approval: EP2 local
  topology branch deletion, EP3 remote old-line archive/delete, dirty worktree
  retention/archive/cleanup, merge/cherry-pick/intake from retained feature
  lines, tag, release, deploy, or production write.
