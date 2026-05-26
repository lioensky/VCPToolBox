# Validation Log

## 2026-05-26 Asia/Shanghai

Checks performed:

- `git status -sb`
- `git log --oneline --decorate --graph -n 8`
- `git fetch origin main codex/absorb-upstream-main-20260526`
- `git merge-base --is-ancestor origin/codex/absorb-upstream-main-20260526 origin/main`
- `git branch -r --merged origin/main`
- `git branch -r --no-merged origin/main`
- `git branch --merged main`
- `git branch --no-merged main`
- `git rev-list --left-right --count origin/main...<remote-branch>` for unmerged remote branches
- `git worktree list --porcelain`

Verified:

- `main` / `origin/main`: `b5fd3a3385fd6439a2d0462c6442d253201b7c24`.
- `origin/codex/absorb-upstream-main-20260526` is an ancestor of `origin/main`.
- `A:/VCP/VCPToolBox-prod-stable` was clean before this evidence update.
- Several remote branches are now merged into `origin/main` and are cleanup candidates only after explicit approval.
- Old `backup-*`, `custom*`, `feature-2026-04-19`, `feature/latest-updates`, photo-studio guide, and `safe-upstream-main-*` remote lines remain unmerged and are not safe wholesale absorption candidates.

Not validated:

- No service functional test was run for branch classification.
- `git remote prune origin --dry-run` timed out and produced no actionable prune result.
- No branch deletion was performed.
- No remote write was performed during this follow-up classification.

Remote cleanup execution:

- User approved deleting the explicitly listed remote branch cleanup package.
- Corrected preflight count: the list contained 31 branches, not 32.
- Recorded each target branch and pre-deletion commit hash locally in command output.
- Ran `git push origin --delete` for exactly those 31 branch names.
- Ran `git fetch origin --prune`.
- Verified `deleted_ref_count=31` and `still_present_count=0`.
- Verified these protected/excluded refs still exist: `origin/main`, `origin/prod/stable`, `origin/codex/photo-studio-baserow-provider-batch`, `origin/feature/ai-image-agent-clean-pr`, and `origin/feature/latest-updates`.

Not validated after remote cleanup:

- No service functional test was run because only remote branch refs changed.
- The local governance evidence commit is not pushed yet.

Local cleanup execution:

- User approved deleting `backup/absorb-upstream-main-20260526-merge` and `feature/ai-image-agent-clean-pr`.
- Preflight verified both were listed by `git branch --merged main`.
- Preflight verified neither was occupied by a registered worktree.
- Ran `git branch -d backup/absorb-upstream-main-20260526-merge feature/ai-image-agent-clean-pr`.
- Verified `git branch --list backup/absorb-upstream-main-20260526-merge feature/ai-image-agent-clean-pr` returned no refs.
- Verified `main` remained synchronized with `origin/main` and worktree status stayed clean.
- Classified remaining local branches with `git rev-list --left-right --count main...<branch>`, `git merge-base --is-ancestor`, `git cherry`, and `git worktree list --porcelain`.
- Verified no remaining non-protected local branch is both an ancestor of `main` and free of worktree concerns.
- Classified remaining remote branches with `git branch -r --no-merged origin/main`, `git branch -r --merged origin/main`, `git rev-list --left-right --count origin/main...<branch>`, and `git cherry origin/main <branch>`.
- Verified remaining unmerged remote old lines still have positive cherry deltas and are not safe merge-cleanup candidates.
- Drafted branch retention policy packages P0-P5 in `docs/governance/BRANCH_RETENTION_POLICY_PACKAGES_20260526.md`.
- Prepared EP1/EP2 execution packages with exact branch names, hashes, post-checks, and rollback commands.

EP1 execution:

- Pushed `1ca9cb0` to `origin/main`.
- Verified `main...origin/main = 0 / 0` before EP1 deletion.
- Verified all EP1 branches pointed to `546b684e4f4f69003006aadd5ab968c4bffebae8`.
- Verified EP1 branches were not registered worktree branches.
- Ran `git branch -D feature/ai-image-pipeline-dgp-refactor feature/ai-image-pipeline-dgp-v2`.
- Verified `git branch --contains 546b684` now lists only `rescue/ai-image-pipeline-mixed-20260427_195303`.
- Verified worktree status remained clean and synchronized with `origin/main`.
- Prepared EP2 as retain-by-default and confirmed no branch action was taken.
- Prepared EP3 old remote line archive policy with current remote branch hashes and ahead/behind counts; confirmed no remote action was taken.
- Audited P1 worktrees with `git status -sb`, `git status --short`, `git cherry -v main HEAD`, `git rev-list --left-right --count main...HEAD`, and `git diff --stat main...HEAD`.
- Confirmed `A:/VCP/VCPToolBox` is dirty/protected, `integration/latest-updates-selective-absorb` is clean and patch-equivalent, and the two photo-studio/codex memory worktrees retain positive cherry deltas.
- Audited P4 branches with `git log --oneline main..<branch>`, `git diff --stat main...<branch>`, and `git cherry -v main <branch>`.
- Confirmed P4 branches are not safe merge-cleanup candidates; no deletion or merge was performed.

Residual merged remote cleanup:

- Verified `origin/feature/ai-image-agent-clean-pr` existed at `fca8f44a70009498b3e8b1873a3dec57b90b27c7`.
- Verified no local `feature/ai-image-agent-clean-pr` branch existed.
- Verified it was an ancestor of `origin/main`.
- Ran `git push origin --delete feature/ai-image-agent-clean-pr`.
- Ran `git fetch origin --prune`.
- Verified `remote_still_present=no`.
- Verified `main...origin/main = 0 / 0` and `prod/stable...origin/prod/stable = 0 / 0`.

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

## 2026-05-25 20:15 Asia/Shanghai

Checks performed:

- Resolved `A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429` and verified it was inside `A:/VCP/`.
- Verified the residual folder had no `.git` marker.
- Verified the residual folder no longer appeared in `git worktree list`.
- Verified `stash@{0}` still preserved the Package R3 detached preflight dist snapshot.
- Verified `main` / `origin/main` were synchronized at `ed24a54b3414a88c490350bbe481946d43b429bb` before deletion.
- Verified `prod/stable` / `origin/prod/stable` were synchronized at `a1870b398fc82eb34c5764a9c60de9e127548494`.
- Executed raw recursive deletion only after explicit user approval.
- Verified `Test-Path A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429` returned `False`.

Not validated:

- No service functional test was run.
- No additional remote write was performed after the residual cleanup evidence update.
