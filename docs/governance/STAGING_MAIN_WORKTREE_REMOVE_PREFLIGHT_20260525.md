# Remove Preflight: A:/VCP/VCPToolBox-staging-custom-integration

Preflight time: 2026-05-25 18:50 Asia/Shanghai.

Target worktree: `A:/VCP/VCPToolBox-staging-custom-integration`.

This is a preflight only. The worktree was not removed.

## 1. Verified State

- Branch: `main`
- HEAD: `55b51ca07dd6635e3a4ecbaf1709dd1f053c7720`
- `origin/main`: `55b51ca07dd6635e3a4ecbaf1709dd1f053c7720`
- Ahead/behind vs `origin/main`: `0/0`
- `git status --short -uall`: clean
- Temporary local test services `6005` and `6006`: stopped
- Existing unrelated port `3000`: left untouched

## 2. Important Context

This worktree is the latest verified clean `main` worktree used during governance.

Removing it would not delete the `main` branch and would not change `origin/main`.

However, removing the directory may also remove ignored/local runtime artifacts under the worktree directory if Git accepts the removal. Observed runtime-like directories include:

- `.file_cache`
- `DebugLog`
- `image`
- `state`
- `Plugin`

`git status --short -uall` is clean, so no Git-tracked or untracked source changes are currently pending in this worktree.

## 3. Recommended Removal Command

Only after explicit approval:

```powershell
git -C A:\VCP\VCPToolBox-prod-stable worktree remove A:\VCP\VCPToolBox-staging-custom-integration
```

Do not use `--force` on the first attempt.

If Git refuses because ignored/runtime files remain, stop and decide whether those files should be archived or explicitly removed.

## 4. Decision

Status: removal-ready after approval.

Blocked until explicit approval:

- actual `git worktree remove`
- any forced removal
- any raw folder deletion
