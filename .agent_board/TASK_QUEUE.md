# VCPToolBox Governance Task Queue

Updated: 2026-05-25 19:50 Asia/Shanghai.

## Done

- `origin/main` has been pushed and verified at `39d860fa07bf55c07acb3eaed70dc9178e81716b`.
- `prod/stable` protection rule is documented: stable production line, permanently retained, never a cleanup candidate.
- Package G2 completed: governance evidence from `562e907` was cherry-picked to `main` as `39d860f` and pushed to `origin/main`.
- Package R1 completed: `A:/VCP/VCPToolBox-staging-custom-integration` was removed by non-force `git worktree remove`.
- Package R2 completed: `A:/VCP/VCPToolBox-photo-studio-next` dirty tail was preserved in `stash@{1}` and the worktree is now clean.
- Package R3 partially completed: detached preflight dirty dist was preserved in `stash@{0}` and removed from Git worktree registry; plain residual folder remains due Windows long path deletion failure.
- Branch cleanup audit has a Package M post-state addendum.
- `A:/VCP/VCPToolBox` dirty worktree has a read-only classification audit.
- `A:/VCP/VCPToolBox` source candidate review has been split into V2A-V2E packages.
- Package V2A tracked RAG/search changes rejected for migration into current `main`.
- Package V2B legacy AdminPanel/operator UI changes rejected for migration into current `main`.
- Package V2C external reporting/DingTalk review completed; external sync conflict-marked files rejected, DingTalkTable replacement deferred.
- Package V2D tool execution route review completed; JSON human-tool route rejected as a security-sensitive API expansion.
- Package V2E image/plugin source review completed; DeepWiki downgrade rejected, ZImageGen rating writes deferred, OneBot docs rejected as-is.
- `A:/VCP/VCPToolBox` V3 remaining high-risk dirty review completed.

## In Progress

- Branch-Final closeout evidence update.

## Next Safe Local Tasks

1. Commit this V3 / Branch-Final evidence update locally.
2. Request explicit approval before raw recursive deletion of the residual preflight folder.
3. Do not touch `A:/VCP/VCPToolBox` without a separate backup/retention decision.

## Blocked / Needs Explicit Approval

- Raw recursive deletion of `A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429`.
- Deleting any branch.
- Force-removing dirty files or runtime directories.
- Any additional remote write.
- Any action touching real secrets or runtime state without a separate approval.
