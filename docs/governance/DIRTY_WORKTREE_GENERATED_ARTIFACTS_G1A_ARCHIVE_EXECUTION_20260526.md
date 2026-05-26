# Dirty Worktree Generated Artifacts G1A Archive Execution - 2026-05-26

Scope: approved G1A archive execution for non-sensitive generated artifacts in
dirty worktree `A:/VCP/VCPToolBox`.

This record documents archive creation only. It did not delete source files,
restore files, reset, clean, change branches, push, deploy, or touch
production/runtime state.

## Source

- Source worktree: `A:/VCP/VCPToolBox`
- Source branch: `feature/latest-updates`
- Source HEAD: `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`
- Source upstream comparison after execution: `10 / 15`
- Dirty status count after execution: `213`

## Destination

Approved destination:

```text
A:/VCP/_archives/VCPToolBox/generated-artifacts-g1a-20260526/
```

Destination properties verified before execution:

- Destination did not already exist.
- Destination is outside `A:/VCP/VCPToolBox`.
- Destination is outside `A:/VCP/VCPToolBox-prod-stable`.

## Pre-Copy Gate

Before archive copy, each G1A path was checked for:

- untracked status
- file exists on disk
- no sensitive-pattern match
- no G1B overlap
- approved destination outside both worktrees
- approved destination did not already exist

Gate result:

```text
G1A count              37
Unique G1A count       37
Untracked count        37
Exists count           37
Sensitive match files  0
G1B overlap count      0
Total bytes            1,167,943
Failure count          0
Destination exists     false
```

## Archive Result

Generated archive manifest:

```text
A:/VCP/_archives/VCPToolBox/generated-artifacts-g1a-20260526/ARCHIVE_MANIFEST.json
```

Counts:

```text
Copied source files       37
Generated manifest files  1
Total archive files       38
Hash mismatch count       0
Total copied bytes        1,167,943
```

Manifest SHA256:

```text
3F9460394991FD91BFF4BBF8E617E249D524753535C4B1B394A01C39BA6EB3DB
```

The manifest contains relative path, byte count, source SHA256, archived
SHA256, and hash-match status for each copied file.

## Validation

Verified:

- Archive artifact was created at the approved destination.
- `37` source files were copied.
- `0` manifest hash mismatches were reported.
- Archive total file count is `38`.
- Sensitive-pattern scan over the archive directory produced no matches.
- Dirty worktree remained on `feature/latest-updates` at
  `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`.
- Dirty status count remained `213`.

Not performed:

- No source file deletion.
- No generated artifact cleanup.
- No tracked restore.
- No protected/runtime path touch.
- No branch, tag, release, deploy, remote ref, live DingTalk/MCP/DWS command, or
  production write.

## Rollback

If this archive artifact must be rolled back:

1. Verify the target is exactly:
   `A:/VCP/_archives/VCPToolBox/generated-artifacts-g1a-20260526/`
2. Delete only that generated archive directory.
3. Do not delete anything inside `A:/VCP/VCPToolBox`.
4. Re-run `git status --short --untracked-files=all` in both worktrees.

Any G1A source cleanup/delete remains a separate explicit approval decision.
