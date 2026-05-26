# VCPToolBox Governance Task Queue

Updated: 2026-05-26 Asia/Shanghai.

## Done

- `origin/main` has been pushed and verified at `39d860fa07bf55c07acb3eaed70dc9178e81716b`.
- `prod/stable` protection rule is documented: stable production line, permanently retained, never a cleanup candidate.
- Package G2 completed: governance evidence from `562e907` was cherry-picked to `main` as `39d860f` and pushed to `origin/main`.
- Package R1 completed: `A:/VCP/VCPToolBox-staging-custom-integration` was removed by non-force `git worktree remove`.
- Package R2 completed: `A:/VCP/VCPToolBox-photo-studio-next` dirty tail was preserved in `stash@{1}` and the worktree is now clean.
- Package R3 completed: detached preflight dirty dist was preserved in `stash@{0}`, removed from Git worktree registry, and the plain residual folder was raw-deleted after explicit approval.
- Branch cleanup audit has a Package M post-state addendum.
- `A:/VCP/VCPToolBox` dirty worktree has a read-only classification audit.
- `A:/VCP/VCPToolBox` source candidate review has been split into V2A-V2E packages.
- Package V2A tracked RAG/search changes rejected for migration into current `main`.
- Package V2B legacy AdminPanel/operator UI changes rejected for migration into current `main`.
- Package V2C external reporting/DingTalk review completed; external sync conflict-marked files rejected, DingTalkTable replacement deferred.
- Package V2D tool execution route review completed; JSON human-tool route rejected as a security-sensitive API expansion.
- Package V2E image/plugin source review completed; DeepWiki downgrade rejected, ZImageGen rating writes deferred, OneBot docs rejected as-is.
- `A:/VCP/VCPToolBox` V3 remaining high-risk dirty review completed.
- `origin/main` has absorbed and pushed `origin/codex/absorb-upstream-main-20260526` as merge commit `b5fd3a3`.
- 2026-05-26 read-only remote branch classification completed.
- 2026-05-26 remote cleanup package executed: 31 explicitly listed merged remote branches deleted and verified absent.
- 2026-05-26 local cleanup package executed: two fully merged local branches deleted with ordinary `git branch -d`.
- 2026-05-26 remaining local branches classified by protection/worktree/substantive-unmerged/duplicate-head status.
- 2026-05-26 remaining remote old lines classified as archival/retention decisions rather than merge cleanup candidates.
- 2026-05-26 branch retention policy packages drafted in `docs/governance/BRANCH_RETENTION_POLICY_PACKAGES_20260526.md`.

## In Progress

- Post-cleanup evidence update.

## Next Safe Local Tasks

1. Review policy packages P0-P5 in `docs/governance/BRANCH_RETENTION_POLICY_PACKAGES_20260526.md`.
2. Decide P2 duplicate local AI image branch policy.
3. Decide P3 topology-only local branch policy.
4. Decide P5 old unmerged remote line retention/archive policy.
5. Do not touch `A:/VCP/VCPToolBox` without a separate backup/retention decision.
6. Request explicit approval before deleting any local or remote branch.
7. Request explicit approval before any additional remote write.

## Blocked / Needs Explicit Approval

- Deleting any branch.
- Force-removing dirty files or runtime directories.
- Any additional remote write.
- Any action touching real secrets or runtime state without a separate approval.
