# VCPToolBox Governance Run State

Status: active local governance.
Workspace: `A:/VCP/VCPToolBox-prod-stable`.
Current branch: `integration/main-absorb-prod-stable-upstream-20260525`.
Worktree status at last check: clean.

Current verified heads:

- `main` / `origin/main`: `55b51ca07dd6635e3a4ecbaf1709dd1f053c7720`.
- `prod/stable` / `origin/prod/stable`: `a1870b398fc82eb34c5764a9c60de9e127548494`.

Important worktrees:

- `A:/VCP/VCPToolBox-staging-custom-integration`: clean `main`, latest verified main.
- `A:/VCP/VCPToolBox`: dirty `feature/latest-updates`, not latest main.
- `A:/VCP/VCPToolBox-photo-studio-next`: dirty `codex/photo-studio-baserow-provider-batch`.
- `A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429`: dirty detached worktree.

Running local services:

- Main test service on port `6005`: stopped.
- Admin test service on port `6006`: stopped.
- Existing unrelated service: port `3000`, left untouched.

Hard rules:

- `main` is the most advanced/latest integration branch.
- `prod/stable` is the stable production line and must never be deleted.
- Do not delete worktrees, branches, runtime files, or remote refs without explicit approval.
