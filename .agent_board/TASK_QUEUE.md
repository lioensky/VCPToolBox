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
- EP1 completed locally: duplicate AI image feature labels deleted, rescue label retained.
- EP2 prepared as retain-by-default; no action taken.
- EP3 prepared for old remote line archive policy; no remote action taken.
- P1 worktree audit completed; only `integration/latest-updates-selective-absorb` is an optional cleanup candidate after explicit worktree removal approval.
- P4 local unmerged branch audit completed; retain all P4 branches as historical feature/governance labels by default.
- Residual merged remote branch `origin/feature/ai-image-agent-clean-pr` deleted and verified absent.
- P1B cleanup completed: `integration/latest-updates-selective-absorb` worktree and local branch removed.
- 2026-05-26 dirty worktree read-only refresh completed for `A:/VCP/VCPToolBox`: verified `260` dirty entries, `41` tracked entries, `219` untracked entries, unresolved conflict markers in external sync files, and secret-like patterns in config examples.
- 2026-05-26 dirty worktree preservation manifest drafted in `docs/governance/DIRTY_WORKTREE_PRESERVATION_MANIFEST_20260526.md`.
- Dirty candidate review C1 completed: old root `AdminPanel/` static Codex Memory edits rejected because current `main` already carries the Vue admin implementation and backend/test coverage.
- Dirty candidate review C2 completed: dirty `Agent/Nova.txt` rejected as a downgrade/fork risk; `Agent/Noir Architect.txt` retained as candidate-only new-agent draft.
- Dirty candidate review C3 completed: `Plugin/CodexMemoryBridge/*.js` has no immediate source absorption; `.fixed.js` is format-only, `.new.js` is candidate-only for i18n/API-contract review.
- Dirty candidate review C4 completed: `Plugin/DingTalkTable/**` compatibility-layer direction is valuable but deferred; do not absorb the untracked directory as-is.
- Dirty candidate review C5 completed: plugin doc template, OneBot docs, tool execution route, and `vcp-panel-extension/**` have no direct absorption path; only docs/product/security follow-up packages remain.
- Dirty candidate review C6 completed: generated DingTalk reports, interaction-middleware docs, standalone helper scripts/docs, and manifest toggles have no direct absorption path.
- 2026-05-26 dirty worktree strategy package drafted in `docs/governance/DIRTY_WORKTREE_STRATEGY_PACKAGES_20260526.md`; direct source absorption is closed, and remaining actions are preservation/archive/cleanup decisions or future rewrite packages.

## In Progress

- None.

## Remaining Explicit Decisions

1. Optional EP2 deletion only if a stricter local branch list is desired.
2. Optional EP3 remote archive rename/delete only with explicit remote approval.
3. Do not touch `A:/VCP/VCPToolBox` without a separate backup/retention decision.
4. Decide whether to execute any preservation, archive, or cleanup package for `A:/VCP/VCPToolBox`.
5. If implementation value is desired, select one future rewrite package from D4A-D4F and build it from current `main`.

## Blocked / Needs Explicit Approval

- Deleting any branch.
- Force-removing dirty files or runtime directories.
- Any additional remote write.
- Any action touching real secrets or runtime state without a separate approval.
