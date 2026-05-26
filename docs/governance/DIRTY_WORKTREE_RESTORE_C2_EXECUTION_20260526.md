# Dirty Worktree Restore C2 Execution - 2026-05-26

Scope: A3-C2 approved tracked restore execution for dirty worktree
`A:/VCP/VCPToolBox`.

This record documents the approved restore of `8` tracked modified files only.
It did not perform `git reset`, broad checkout, broad restore, deletion,
recursive cleanup, branch changes, worktree removal, push, deploy, or
production/runtime changes.

## Source

- Target worktree: `A:/VCP/VCPToolBox`
- Target branch: `feature/latest-updates`
- Target HEAD: `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`
- Target upstream comparison after execution: `10 / 15`
- Dirty status count before execution: `221`
- Dirty status count after execution: `213`

## Stale Lock Handling

The first restore attempt was blocked by:

```text
A:/VCP/VCPToolBox/.git/index.lock
```

Verified before removing it:

- No `git`, `ssh`, or `gpg` related processes remained after waiting.
- Lock timestamp was `2026-05-25 10:26:18`.
- The C2 files were still all tracked modified before lock removal.

After explicit approval, the stale lock file was removed, and the A3-C2 gate
was rerun before restore.

## Archive Evidence

A2 archive artifact:

```text
A:/VCP/_archives/VCPToolBox/dirty-feature-latest-updates-20260526/
```

A2 manifest:

```text
A:/VCP/_archives/VCPToolBox/dirty-feature-latest-updates-20260526/ARCHIVE_MANIFEST.json
```

Verified after execution:

- Archive exists: `true`
- Manifest copied-file count: `47`
- Manifest hash mismatch count: `0`
- Manifest SHA256:
  `56612B88F302E9573D1D8D946451B4842A025FBC709C02831913EED50331A8FE`

## Pre-Restore Gate

Before restore, each C2 path was checked for:

- full path inside `A:/VCP/VCPToolBox`
- tracked modified status
- file exists on disk
- membership in A2 manifest
- matching archive file exists
- current SHA256 equals A2 manifest SHA256
- no overlap with A2 blocked paths

Gate result:

```text
Dirty status count          221
C2 count                   8
Unique C2 count             8
Inside workspace count      8
Tracked modified count      8
Exists count                8
In manifest count           8
Archive exists count        8
Hash match count            8
Blocked overlap count       0
Failure count               0
Expected dirty after restore 213
```

## Restored Paths

These exact paths were restored with targeted `git restore -- <path>` commands:

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

## Post-Execution Verification

Verified:

- Restored count: `8`
- C2 paths still present in dirty status: `0`
- Dirty status count after execution: `213`
- Dirty worktree branch remained `feature/latest-updates`
- Dirty worktree HEAD remained
  `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`
- Dirty upstream comparison remained `10 / 15`
- A2 archive artifact remains available for rollback.

Not performed:

- No untracked file was deleted.
- No A2 blocked path was touched.
- No protected secret/runtime/data file was touched.
- No generated report/log/cache bucket was touched.
- No plugin manifest toggle file was touched.
- No branch, tag, release, deploy, remote ref, live DingTalk/MCP/DWS command, or
  production write was performed.

## Rollback

To rollback A3-C2 only:

1. Copy only the `8` restored paths from:
   `A:/VCP/_archives/VCPToolBox/dirty-feature-latest-updates-20260526/`
2. Preserve relative paths under `A:/VCP/VCPToolBox`.
3. Recompute SHA256 for restored dirty copies against `ARCHIVE_MANIFEST.json`.
4. Re-run `git status --short --untracked-files=all` in the dirty worktree.

Rollback should not touch A3-C1 deleted paths unless performing a separate C1
rollback.
