# VCPToolBox Governance Run State

Status: active local governance closeout.
Workspace: `A:/VCP/VCPToolBox-prod-stable`.
Current branch: `main`.
Worktree status at last check: clean.

Current verified heads:

- `main` / `origin/main`: `39d860fa07bf55c07acb3eaed70dc9178e81716b`.
- `prod/stable` / `origin/prod/stable`: `a1870b398fc82eb34c5764a9c60de9e127548494`.

Important worktrees:

- `A:/VCP/VCPToolBox`: dirty `feature/latest-updates`, not latest main.
- `A:/VCP/VCPToolBox-photo-studio-next`: clean after Package R2 stash.
- `A:/VCP/VCPToolBox-staging-custom-integration`: removed.
- `A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429`: removed from Git worktree registry, but a plain residual folder remains because Windows long paths blocked deletion.

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
