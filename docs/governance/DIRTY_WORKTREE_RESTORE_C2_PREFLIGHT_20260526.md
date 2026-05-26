# Dirty Worktree Restore C2 Preflight - 2026-05-26

Scope: A3-C2 restore preflight for dirty worktree `A:/VCP/VCPToolBox`.

This is a preflight and approval-template document only. It does not authorize
or perform tracked restore, `git checkout`, `git restore`, `git reset`,
deletion, branch changes, worktree removal, push, deploy, or production/runtime
changes.

## Current Verified State

- Control worktree: `A:/VCP/VCPToolBox-prod-stable`
- Control branch: `main`
- Control `main` / `origin/main`: synchronized at
  `2d3ea6ff23903b86a9dcde974afc01e039f7fedf`
- Dirty worktree: `A:/VCP/VCPToolBox`
- Dirty branch: `feature/latest-updates`
- Dirty HEAD: `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`
- Dirty upstream comparison: `10 / 15`
- Dirty status count after A3-C1: `221`

## Source Documents

- A2 execution record:
  `docs/governance/DIRTY_WORKTREE_ARCHIVE_EXECUTION_20260526.md`
- A3 cleanup preflight:
  `docs/governance/DIRTY_WORKTREE_CLEANUP_PREFLIGHT_20260526.md`
- A3-C1 execution record:
  `docs/governance/DIRTY_WORKTREE_CLEANUP_C1_EXECUTION_20260526.md`
- A2 archive manifest:
  `A:/VCP/_archives/VCPToolBox/dirty-feature-latest-updates-20260526/ARCHIVE_MANIFEST.json`

## A3-C2 Preflight Result

Result: A3-C2 is eligible for explicit restore approval, but should not execute
without a separate approval because it discards tracked working-tree
modifications.

Read-only checks over the C2 list:

```text
Dirty status count        221
C2 count                  8
Unique C2 count           8
Tracked modified count    8
Exists count              8
In manifest count         8
Archive exists count      8
Hash match count          8
Blocked overlap count     0
Failure count             0
Expected dirty after C2   213
```

Interpretation:

- All C2 candidates are still tracked modified files in
  `A:/VCP/VCPToolBox`.
- All C2 candidates still exist on disk.
- All C2 candidates are present in the A2 archive manifest.
- The archived copy exists for every C2 candidate.
- Current C2 file hashes still match the archived SHA256 values.
- No C2 candidate overlaps with A2 blocked paths.

## Candidate C2 Restore List

Restore count after explicit approval: `8`

```text
Agent/Nova.txt
diary-semantic-classifier.js
docs/ADMINPANEL_DEVELOPMENT.md
KnowledgeBaseManager.js
Plugin/DeepWikiVCP/deepwiki_vcp.js
Plugin/vcp-onebot-adapter/README.md
Plugin/ZImageGen/ZImageGen.mjs
Plugin/ZImageGen2/ZImageGen.mjs
```

If A3-C2 is later executed and no intervening dirty worktree changes occur, the
expected dirty status count should drop from `221` to `213`.

## Execution Boundary

A3-C2, if later explicitly approved, must:

- Restore only the `8` paths listed above.
- Use exact literal paths under `A:/VCP/VCPToolBox`.
- Recheck each path is tracked modified before restore.
- Recheck each current SHA256 equals the A2 manifest SHA256 before restore.
- Recheck the matching archive file exists before restore.
- Stop immediately on any mismatch, missing path, non-modified status, or
  blocked overlap.

A3-C2 must not:

- Touch untracked files.
- Touch A2 blocked files.
- Touch protected secret/runtime/data files.
- Touch generated report/log/cache buckets.
- Touch plugin manifest toggle files.
- Run `git reset`, broad `git checkout`, broad `git restore`, `git clean`, or
  recursive deletion.
- Push, tag, release, deploy, or write to live services.

## Rollback

Because A3-C2 would restore tracked files to the index/HEAD version, rollback
must use the A2 archive artifact as the source of the pre-restore dirty content:

1. Copy only the `8` C2 paths from:
   `A:/VCP/_archives/VCPToolBox/dirty-feature-latest-updates-20260526/`
2. Preserve relative paths under `A:/VCP/VCPToolBox`.
3. Recompute SHA256 for restored dirty copies against `ARCHIVE_MANIFEST.json`.
4. Re-run `git status --short --untracked-files=all` in the dirty worktree.

Rollback must not touch C1 deleted paths unless performing a separate C1
rollback.

## Required Approval For Actual Restore

Actual tracked restore still requires this explicit approval:

```text
批准执行 A3-C2 tracked还原：
target = A:/VCP/VCPToolBox
restore = docs/governance/DIRTY_WORKTREE_RESTORE_C2_PREFLIGHT_20260526.md C2 list
count = 8
precheck = each file remains tracked modified and current SHA256 matches A2 ARCHIVE_MANIFEST.json
rollback = restore only C2 dirty copies from A2 archive artifact
```

Without that approval, stop at this preflight.
