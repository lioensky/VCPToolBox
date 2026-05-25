# VCPToolBox Governance Task Queue

Updated: 2026-05-25 17:30 Asia/Shanghai.

## Done

- `origin/main` has been pushed and verified at `55b51ca07dd6635e3a4ecbaf1709dd1f053c7720`.
- `main` and `origin/main` are `0/0` ahead/behind in `A:/VCP/VCPToolBox-staging-custom-integration`.
- `prod/stable` protection rule is documented: stable production line, permanently retained, never a cleanup candidate.
- Branch cleanup audit has a Package M post-state addendum.
- `A:/VCP/VCPToolBox` dirty worktree has a read-only classification audit.
- `A:/VCP/VCPToolBox` source candidate review has been split into V2A-V2E packages.
- Package V2A tracked RAG/search changes rejected for migration into current `main`.
- Package V2B legacy AdminPanel/operator UI changes rejected for migration into current `main`.
- Package V2C external reporting/DingTalk review completed; external sync conflict-marked files rejected, DingTalkTable replacement deferred.
- Package V2D tool execution route review completed; JSON human-tool route rejected as a security-sensitive API expansion.
- Package V2E image/plugin source review completed; DeepWiki downgrade rejected, ZImageGen rating writes deferred, OneBot docs rejected as-is.
- `A:/VCP/VCPToolBox-photo-studio-next` 3 dirty entries reviewed; no migration needed, cleanup requires approval.
- Latest clean `main` worktree removal preflight written for `A:/VCP/VCPToolBox-staging-custom-integration`.
- Detached preflight worktree risk plan written for `A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429`.

## In Progress

- Package G-doc-commit: fix governance evidence into local Git history.

## Next Safe Local Tasks

1. Stop local test services on `6005/6006` when they are no longer needed for testing.
2. Await approval for any actual worktree removal or cleanup.
3. Continue with cleanup packages only after explicit approval.

## Blocked / Needs Explicit Approval

- Deleting any worktree or branch.
- Force-removing dirty files or runtime directories.
- Any remote write beyond already completed `origin/main` push.
- Any action touching real secrets or runtime state without a separate approval.
