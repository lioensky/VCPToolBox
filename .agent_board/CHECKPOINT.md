# Checkpoint

Time: 2026-05-26 Asia/Shanghai.

Completed:

- Refreshed the read-only audit for dirty worktree `A:/VCP/VCPToolBox`.
- Verified it remains on `feature/latest-updates` at `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`.
- Verified upstream comparison is ahead/behind `10/15`.
- Verified `260` dirty entries: `41` tracked, `219` untracked, `28` modified-like, `13` deleted-like.
- Scanned only path names and targeted marker/key patterns; did not modify the dirty worktree.
- Found unresolved conflict markers in `plugins/custom/reporting/sync_to_external_sheet_or_notion/src/index.js` and `tests/photo-studio/external-sync.test.js`.
- Detected secret-like patterns in config examples; values were not copied into docs.
- Drafted `docs/governance/DIRTY_WORKTREE_PRESERVATION_MANIFEST_20260526.md` with path-level buckets: `quarantine-sensitive-runtime`, `candidate-review`, `manifest-toggle-review`, `preserve-path-only-review-later`, and `reject-as-is`.
- Completed candidate review C1 for old root `AdminPanel/` static edits and rejected migration into `main`; current `main` already has `AdminPanel-Vue` Codex Memory Monitor implementation plus backend route/test coverage.
- Completed candidate review C2 for `Agent/*`: rejected dirty `Agent/Nova.txt` as-is and retained `Agent/Noir Architect.txt` as a candidate-only new-agent draft.
- Completed candidate review C3 for `Plugin/CodexMemoryBridge/*.js`: no immediate source absorption; `.fixed.js` is format-only, `.new.js` requires dedicated i18n/API-contract review.
- Completed candidate review C4 for `Plugin/DingTalkTable/**`: deferred the DingTalkTable-to-DingTalkCLI compatibility-layer direction, rejected dirty planning notes, and kept no direct source absorption.
- Completed candidate review C5 for plugin documentation templates, OneBot docs, tool execution draft route, and `vcp-panel-extension/**`; none should be copied directly into `main`.

Not completed:

- No dirty worktree files were copied, edited, archived, reset, cleaned, or deleted.
- No branch, worktree, or remote ref was changed.

Next:

1. Keep `A:/VCP/VCPToolBox` untouched until a separate backup/retention action is approved.
2. If continuing, choose one package only: generated DingTalk docs/reports, interaction-middleware docs, standalone helper scripts/docs, preservation/archive plan, or manifest toggle review.
3. Do not absorb conflict-marked files or config examples as-is.

Time: 2026-05-26 Asia/Shanghai.

Completed:

- Pushed `origin/main` to `b5fd3a3385fd6439a2d0462c6442d253201b7c24`.
- Verified `origin/codex/absorb-upstream-main-20260526` is an ancestor of `origin/main`.
- Ran read-only branch classification against `origin/main`.
- Identified many already-merged remote cleanup candidates.
- Identified unmerged old lines that should not be absorbed wholesale: `backup-*`, `custom*`, `feature-2026-04-19`, `feature/latest-updates`, `feature/photo-studio-guide-contract-migration`, `feature/photo-studio-next-guide-contract`, and `safe-upstream-main-*`.
- After explicit approval, deleted the explicitly listed merged remote cleanup package.
- Corrected the preflight count: 31 branches were listed and deleted, not 32.
- Verified all 31 deleted remote refs are absent.
- Deleted two fully merged local branches with ordinary `git branch -d`: `backup/absorb-upstream-main-20260526-merge` and `feature/ai-image-agent-clean-pr`.
- Verified both deleted local branches are absent and all registered worktrees are unchanged.

Not completed:

- No unlisted branch was deleted.
- No worktree was removed.

Next:

1. If continuing, review remaining unmerged old remote lines as separate archival/retention decisions.
2. Keep `prod/stable` protected.
3. Keep dirty/user-owned `A:/VCP/VCPToolBox` untouched unless a separate retention plan is approved.

Time: 2026-05-25 19:50 Asia/Shanghai.

Completed:

- Verified `origin/main` points to `39d860fa07bf55c07acb3eaed70dc9178e81716b`.
- Package G2: cherry-picked governance evidence from `562e907` onto `main` as `39d860f` and pushed `origin/main`.
- Package R1: removed `A:/VCP/VCPToolBox-staging-custom-integration`.
- Package R2: stashed photo-studio-next dirty tail in `stash@{1}` and left that worktree clean.
- Package R3: stashed detached preflight `AdminPanel-Vue/dist` build snapshot in `stash@{0}`, removed the Git worktree registry entry, then raw-deleted the plain residual folder after explicit approval.
- Verified `A:/VCP/VCPToolBox` is not latest main; it is `feature/latest-updates` and has many local changes.
- Verified `prod/stable` remains synchronized with `origin/prod/stable`.
- Added current-state governance notes to `docs/governance/BRANCH_CLEANUP_AUDIT_20260525.md`.
- Added read-only dirty worktree audit for `A:/VCP/VCPToolBox`.
- Added source-diff review package split for `A:/VCP/VCPToolBox`.
- Completed Package V2A tracked RAG/search comparison and rejected migration into current `main`.
- Completed Package V2B legacy AdminPanel/operator UI comparison and rejected migration into current `main`.
- Completed Package V2C external reporting/DingTalk comparison; rejected conflict-marked external sync files and deferred DingTalkTable compatibility-layer idea.
- Completed Package V2D tool execution route comparison; rejected dirty JSON human-tool route as a security-sensitive API expansion.
- Completed Package V2E image/plugin source comparison; rejected DeepWiki downgrade, deferred ZImageGen rating writes, rejected OneBot README as-is.
- Reviewed `A:/VCP/VCPToolBox-photo-studio-next` dirty entries; no migration needed.
- Completed Package V3 remaining high-risk dirty worktree review for `A:/VCP/VCPToolBox`.
- Wrote remove preflight for clean latest-main worktree `A:/VCP/VCPToolBox-staging-custom-integration`.
- Wrote risk plan for detached dirty preflight worktree `A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429`.
- Stopped temporary local test services on ports `6005` and `6006`; existing port `3000` service was left untouched.

Not completed:

- No branch was deleted.
- Local test services on `6005/6006` have been stopped.

Next:

1. Commit final residual-cleanup evidence update.
2. Continue only with separate packages for `A:/VCP/VCPToolBox` ideas.
3. Request explicit approval before any additional remote write.
