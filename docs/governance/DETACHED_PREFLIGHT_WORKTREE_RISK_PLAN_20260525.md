# Risk Plan: A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429

Review time: 2026-05-25 18:55 Asia/Shanghai.

Target worktree: `A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429`.

This is a read-only risk plan. No files were deleted, moved, reset, or cleaned.

## 1. Verified State

- Worktree state: detached HEAD
- HEAD: `43a6bbb`
- Commit: `Merge pull request #29 from JENN2046/codex/prod-stable-custom-system-monitoring-audit`
- Dirty entries: `137`
- Status mix:
  - modified: `63`
  - deleted: `37`
  - untracked: `37`
- Top-level affected area: `AdminPanel-Vue` only

## 2. Dirty Pattern

The dirty set appears to be generated frontend build output churn under:

- `AdminPanel-Vue/dist/assets/css/**`
- `AdminPanel-Vue/dist/assets/js/**`
- `AdminPanel-Vue/dist/index.html`

The pattern is hashed asset replacement:

- old hashed assets deleted,
- new hashed assets untracked,
- many generated CSS/JS files modified,
- `dist/index.html` changed to reference new hashes.

No source directories outside `AdminPanel-Vue` appeared in the dirty top-level summary.

## 3. Risk Assessment

This worktree is risky to remove without a decision because:

- it is detached, so local dirty output is not attached to a branch name;
- dirty count is high;
- frontend build artifacts may represent a release/preflight build snapshot;
- raw deletion would permanently discard that local build state.

It is lower source-code risk than `A:/VCP/VCPToolBox`, because the observed dirty area is generated `AdminPanel-Vue/dist` output only. Still, it requires explicit approval before removal.

## 4. Recommended Options

Option A: preserve build snapshot, then remove

- Archive `AdminPanel-Vue/dist` outside the repo into a dated backup directory.
- Then run `git worktree remove`.
- Requires explicit approval and a named backup target.

Option B: discard build output and remove

- Treat `AdminPanel-Vue/dist` churn as disposable generated output.
- Attempt `git worktree remove`.
- If Git refuses, decide whether to force/remove generated files.
- Requires explicit approval.

Option C: keep worktree

- Leave the detached worktree untouched.
- Mark as retained preflight artifact.
- No destructive action.

## 5. Recommendation

Default recommendation: Option C until the user confirms whether the preflight build snapshot has value.

If cleanup is desired, use Option A for maximum reversibility.

Blocked until explicit approval:

- archive/move generated files,
- delete generated files,
- `git worktree remove`,
- forced removal,
- raw folder deletion.
