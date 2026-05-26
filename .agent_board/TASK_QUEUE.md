# VCPToolBox Governance Task Queue

Updated: 2026-05-26 Asia/Shanghai.

## Done

- `origin/main` has been pushed and verified at `e8b0c1de621bb2353e073eff8f3d8a14422b1bb0`.
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
- D4B completed locally: repaired OneBot operational docs/config template to use `/internal/channelHub/events` and reject stale `/internal/channel-hub/events`.
- D4C completed locally: added current-main `docs/INTERACTION_MIDDLEWARE.md` and linked it from the documentation index.
- D4E completed locally: locked CodexMemoryBridge knowledge-write API response fields and rejected direct `.new.js` i18n replacement.
- D4F completed locally: documented `Agent/Noir Architect.txt` as a candidate-only new-agent proposal and did not add or enable it.
- D4D completed locally: documented `vcp-panel-extension/**` as a standalone editor-extension product proposal and did not add extension source.
- D4A completed locally: rewired `Plugin/DingTalkTable` through `DingTalkCLI` dry-run/gray-stage gates with mocked no-real-write tests.
- Post-D4A validation hardening completed locally: root `npm test` now includes the DingTalkTable compatibility test and passes.
- Post-D4A push closure completed: `0d6c210` pushed to `origin/main` and verified synchronized.
- Post-D4 local governance refresh completed: no new safe automatic branch/worktree cleanup candidate was found.
- Post-D4 next-decision package drafted in `docs/governance/POST_D4_GOVERNANCE_NEXT_DECISIONS_20260526.md`.
- Post-D4 next-decision package push/sync closure completed locally: explicit
  `git push origin main` returned `Everything up-to-date`, and `main` /
  `origin/main` were reverified at `e8b0c1de621bb2353e073eff8f3d8a14422b1bb0`.
- Post-sync local plan-state refresh completed locally: at that checkpoint, the
  N1-N5 decision document reflected `origin/main=e8b0c1d`, local
  `main=6db847b`, and ahead/behind `1 / 0`.
- N2 dirty worktree read-only refresh completed locally: `A:/VCP/VCPToolBox`
  still has `260` dirty entries (`41` tracked, `219` untracked), remains
  `10 / 15` against `origin/feature/latest-updates`, and still carries
  conflict-marker plus secret/config-like risk signals.
- N5 clean worktree feature-line audit completed locally: both
  `lane10-codex-memory-intake-20260425` and
  `codex/photo-studio-baserow-provider-batch` are clean but carry substantive
  non-cleanup deltas, so they remain retained feature/archive review lines.
- N3 topology branch audit completed locally: `governance/origin-main-topology-bridge-preview`
  still has no file delta by `git cherry`/`diff --stat`, but remains a
  non-ancestor topology label, so retain by default unless EP2 deletion is
  explicitly approved.
- N4 remote old-line refresh completed locally: `11` current remote-tracking
  refs remain unmerged into `origin/main`; current `git ls-remote` hashes match
  local `origin/*` tracking hashes, and the lines remain archive/retention refs
  rather than wholesale merge candidates.

## In Progress

- None.

## Remaining Explicit Decisions

1. Optional EP2 deletion only if a stricter local branch list is desired.
2. Optional EP3 remote archive rename/delete only with explicit remote approval.
3. Do not touch `A:/VCP/VCPToolBox` without a separate backup/retention decision.
4. Decide whether to execute any preservation, archive, or cleanup package for `A:/VCP/VCPToolBox`.
5. D4A-D4F packages and post-D4 decision docs have remote closure on
   `origin/main`; local checkpoint/plan-state records are ahead until
   explicitly pushed.
6. Remaining governance actions are explicit next-decision packages N1-N5 or a separately scoped new task.
7. Any N5 intake must be separately scoped as feature/archive review; do not
   treat either clean worktree line as a branch cleanup candidate.

## Blocked / Needs Explicit Approval

- Deleting any branch.
- Force-removing dirty files or runtime directories.
- Any additional remote write.
- Any action touching real secrets or runtime state without a separate approval.
