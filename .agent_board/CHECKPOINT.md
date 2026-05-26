# Checkpoint

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
