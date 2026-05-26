# Dirty Worktree Archive Execution - 2026-05-26

Scope: A2 approved archive execution for dirty worktree `A:/VCP/VCPToolBox`.

This record documents the local archive artifact created after explicit approval
of destination, include list, exclusion rules, dry-run count, and rollback.

## Source

- Source worktree: `A:/VCP/VCPToolBox`
- Source branch: `feature/latest-updates`
- Source HEAD: `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`
- Source upstream comparison: `10 / 15`
- Source dirty status count after execution: `260`

No source file was edited, deleted, moved, reset, cleaned, stashed, checked out,
or otherwise modified by this archive execution.

## Destination

Approved destination:

```text
A:/VCP/_archives/VCPToolBox/dirty-feature-latest-updates-20260526/
```

Destination properties verified before execution:

- Destination did not already exist.
- Destination is outside `A:/VCP/VCPToolBox`.
- Destination is outside `A:/VCP/VCPToolBox-prod-stable`.

## Include And Exclude

The execution used the strict include list from:

```text
docs/governance/DIRTY_WORKTREE_ARCHIVE_PREFLIGHT_20260526.md
```

Counts:

- A1 candidates: `56`
- Unique blocked candidates: `9`
- Strict include files copied: `47`
- Generated manifest files: `1`
- Total files in archive directory after execution: `48`

Blocked candidates remained excluded:

- `8` sensitive/config-like pattern matches.
- `2` path/status ambiguity entries.
- `1` candidate appears in both blocked categories.

## Manifest

Generated archive manifest:

```text
A:/VCP/_archives/VCPToolBox/dirty-feature-latest-updates-20260526/ARCHIVE_MANIFEST.json
```

Manifest SHA256:

```text
56612B88F302E9573D1D8D946451B4842A025FBC709C02831913EED50331A8FE
```

The manifest contains relative path, byte count, source SHA256, archived SHA256,
and hash-match status for each of the `47` copied files.

## Validation

Checks performed:

- Dry-run path and destination preflight.
- Confirmed include count is `47`.
- Confirmed missing include count is `0`.
- Confirmed blocked-in-include count is `0`.
- Confirmed duplicate include count is `0`.
- Copied only the strict include list.
- Generated `ARCHIVE_MANIFEST.json`.
- Verified copied-file hash mismatch count is `0`.
- Verified archive total file count is `48`.
- Ran sensitive-token pattern scan over the archive directory.
- Rechecked control worktree status.
- Rechecked dirty worktree branch, HEAD, upstream comparison, and dirty status
  count.

Verified:

- Archive artifact was created at the approved destination.
- `47` source files were copied.
- `0` manifest hash mismatches were reported.
- Sensitive-token pattern scan over the archive directory produced no matches.
- Control worktree remained otherwise clean before this evidence record.
- Dirty worktree remained on `feature/latest-updates` at
  `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`.
- Dirty worktree status count remained `260`.

Not performed:

- No dirty worktree cleanup.
- No source file deletion.
- No branch deletion.
- No remote write or push.
- No tag, release, deploy, live DingTalk/MCP/DWS command, or production write.

## Rollback

If this archive artifact must be rolled back:

1. Verify the target is exactly:
   `A:/VCP/_archives/VCPToolBox/dirty-feature-latest-updates-20260526/`
2. Delete only that generated archive directory.
3. Do not delete anything inside `A:/VCP/VCPToolBox`.
4. Re-run `git status --short --untracked-files=all` in both worktrees.

Any dirty worktree cleanup after this archive remains a separate explicit
approval decision.
