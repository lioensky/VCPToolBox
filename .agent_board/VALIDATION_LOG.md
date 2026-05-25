# Validation Log

## 2026-05-25 17:30 Asia/Shanghai

Read-only checks performed:

- `git branch --show-current`
- `git status -sb`
- `git worktree list --porcelain`
- `git rev-parse main`
- `git rev-parse origin/main`
- `git rev-parse prod/stable`
- `git rev-parse origin/prod/stable`
- `git rev-list --left-right --count origin/main...main`
- `git rev-list --left-right --count origin/prod/stable...prod/stable`
- `Get-NetTCPConnection` for ports `3000`, `6005`, `6006`

Verified:

- `main` / `origin/main`: `55b51ca07dd6635e3a4ecbaf1709dd1f053c7720`.
- `prod/stable` / `origin/prod/stable`: `a1870b398fc82eb34c5764a9c60de9e127548494`.
- `A:/VCP/VCPToolBox-staging-custom-integration` is clean latest main.
- `A:/VCP/VCPToolBox` is dirty `feature/latest-updates`, not latest main.
- `A:/VCP/VCPToolBox` dirty status count: 254 entries (`213` untracked, `28` modified, `13` deleted).
- `A:/VCP/VCPToolBox` source subset: 17 tracked files, 748 insertions, 138 deletions.
- Package V2A compared selected RAG/search files against `origin/main`; tracked changes were classified as unsafe to migrate because they would roll back current main-line safeguards.
- Package V2B compared legacy AdminPanel/operator UI files against `origin/main`; tracked changes were classified as unsafe to migrate because current main uses `AdminPanel-Vue` and already has a Vue CodexMemoryMonitor route.
- Package V2C found unresolved conflict markers in dirty external sync source/tests; current `main` already has provider-aware external sync implementation and tests.
- Package V2D found a dirty JSON `/v1/human/tool-with-context` route candidate; rejected because it would widen direct tool execution and accept caller-supplied execution context without a separate governance design.
- Package V2E rejected dirty DeepWiki scraper downgrade, deferred ZImageGen/ZImageGen2 rating auto-registration due runtime sqlite side effects, and rejected OneBot README changes as-is.
- `A:/VCP/VCPToolBox-photo-studio-next` dirty entries reviewed: DailyNoteManager write lock already superseded in current main, `280ed91.patch` already contained by main, `desktop.ini` cleanup candidate only.
- `A:/VCP/VCPToolBox-staging-custom-integration` verified clean latest `main` at `55b51ca`, ahead/behind `0/0`, removal-ready after approval.
- `A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429` verified detached at `43a6bbb` with 137 dirty generated `AdminPanel-Vue/dist` entries; removal requires explicit approval.
- Ports `6005` and `6006` were stopped and verified released; existing port `3000` remained listening and was not touched.

Not validated:

- No service functional test beyond earlier HTTP checks.
- No branch deletion/removal dry run yet.

## 2026-05-25 19:50 Asia/Shanghai

Checks performed:

- `git cherry-pick 562e9078b67a8378edba644a8c76666a55d12875` on `main`
- `git diff --check origin/main..main`
- `git push origin main`
- `git fetch origin main --prune`
- `git rev-list --left-right --count origin/main...main`
- `git worktree remove A:/VCP/VCPToolBox-staging-custom-integration`
- `git stash push -u` for Package R2 dirty tail
- `git stash push -u` for Package R3 detached preflight dist snapshot
- `git worktree remove A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429`
- `git worktree list --porcelain`
- `git status --short -uall` in reviewed worktrees

Verified:

- `main` / `origin/main`: `39d860fa07bf55c07acb3eaed70dc9178e81716b`.
- `A:/VCP/VCPToolBox-staging-custom-integration` was removed.
- `A:/VCP/VCPToolBox-photo-studio-next` is clean after `stash@{1}`.
- `stash@{1}` contains `Plugin/DailyNoteManager/daily-note-manager.js`, `280ed91.patch`, and `desktop.ini`.
- `stash@{0}` contains the detached preflight `AdminPanel-Vue/dist` generated build snapshot.
- `A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429` no longer appears in `git worktree list`.
- `A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429` still exists as a plain folder because Git failed to delete it with `Filename too long`.
- `A:/VCP/VCPToolBox` remains dirty `feature/latest-updates`, behind `15`, ahead `10`, with `254` dirty entries.
- V3 reviewed DingTalkTable compatibility shim, interaction-middleware docs, OneBot docs, and runtime/sensitive paths.

Not validated:

- No service functional test was run.
- No raw recursive deletion of the residual preflight folder was performed.
- No cleanup was performed inside `A:/VCP/VCPToolBox`.
