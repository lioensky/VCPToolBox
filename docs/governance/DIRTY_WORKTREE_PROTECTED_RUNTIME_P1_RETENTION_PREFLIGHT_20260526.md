# Dirty Worktree Protected Runtime P1 Retention Preflight - 2026-05-26

Scope: read-only retention preflight for protected secret/config/runtime/data
entries remaining in dirty worktree `A:/VCP/VCPToolBox`.

This document is evidence and policy planning only. It does not authorize
copying, archiving, deleting, restoring, hashing contents, reading secret
values, resetting, cleaning, changing branches, pushing, or touching
production/runtime state.

## Current Verified State

- Control worktree: `A:/VCP/VCPToolBox-prod-stable`
- Control branch: `main`
- Control local `main`: `9f9e2bb`
- Control `main` / `origin/main`: `1 / 0`
- Latest verified `origin/main`: `db1d40feda0a9b5fc0dceee7b510771042ec1420`
- Dirty worktree: `A:/VCP/VCPToolBox`
- Dirty branch: `feature/latest-updates`
- Dirty HEAD: `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`
- Dirty upstream comparison: `10 / 15`
- Dirty status count: `176`

## Scope

P1 is the protected secret/config/runtime/data bucket from:

```text
docs/governance/DIRTY_WORKTREE_REMAINING_213_REASSESSMENT_20260526.md
```

The current P1 set was recalculated from the live dirty status after G1A
cleanup and G1B/M1/R1/B1 preflights.

## Read-Only Check Result

No file contents were copied into this document. No content hash was computed
for this P1 preflight.

```text
Dirty total entries        176
P1 protected entries       128
Existing entries           128
Tracked entries            8
Untracked entries          120
Modified status entries    8
Untracked status entries   120
Approx total bytes         267,320,880
Unclassified entries       0
```

The remaining non-P1 entries are already covered by:

```text
G1B retained generated reports        4
M1 manifest toggles                  28
R1 manual retain-review               7
B1 blocked/excluded paths             9
```

## Protected Prefix Counts

```text
Plugin/DingTalkCLI/state/**                      34
VectorStore_bge1024_backup_20260422-123654/**    21
VectorStore_bge1024/**                           21
state/channelHub/**                              16
.claude/**                                       10
Plugin/DailyNote/dailynote/**                     8
config/env-like                                   6
VCPChat/**                                        5
Plugin/ImageProcessor/*.sqlite*                   3
Plugin/ImageRatingManager/*.sqlite*               3
state/**                                          1
```

Approximate byte totals by prefix:

```text
VectorStore_bge1024_backup_20260422-123654/** 217,248,384
VectorStore_bge1024/**                         48,649,976
Plugin/DingTalkCLI/state/**                       803,901
state/channelHub/**                               288,727
.claude/**                                        135,604
Plugin/ImageRatingManager/*.sqlite*               106,496
Plugin/ImageProcessor/*.sqlite*                    49,152
config/env-like                                    29,207
VCPChat/**                                          7,909
Plugin/DailyNote/dailynote/**                       1,190
state/**                                             334
```

## Extension Shape

```text
.json          48
.usearch       36
.md            16
.jsonl          8
.sqlite         4
.sqlite-shm     4
.sqlite-wal     4
.env            3
.example        3
.gitkeep        1
.txt            1
```

## Risk Interpretation

P1 is not a cleanup bucket.

Reasons:

- It includes env/config-like files, some of which may contain or describe
  credentials.
- It includes SQLite databases and WAL/SHM files that may be live runtime or
  user data.
- It includes vector index files and vector-store databases.
- It includes channelHub/DingTalk workflow state and audit/session/task logs.
- It includes local agent/memory files under `.claude/**`.
- It includes user/application data under `VCPChat/**` and daily-note content.
- It contains large runtime artifacts where hashing, copying, or archiving
  content can create privacy, secret, or storage risk.

## Recommended Policy

Recommended current decision: retain-by-default for P1.

Do not bulk archive, delete, restore, or import this bucket.

Prepared follow-ups:

```text
P1-R0 retain protected/runtime bucket
  No file operation. Keep all 128 paths in the dirty worktree.

P1-Q1 quarantine/backup preflight
  Prepare a separate destination and manifest policy only if the user explicitly
  wants backup of protected runtime data. The preflight must specify whether to
  include or exclude env/config, SQLite/WAL, vector stores, logs, and user data.

P1-D0 cleanup to current-main state
  Destructive cleanup package. Requires exact path list, explicit rollback
  story, and approval that runtime/user data may be deleted or regenerated.

P1-S1 selective source-safe extraction
  Only for specific named non-secret docs/config examples, after confirming
  they are not runtime/user data and do not expose secrets.
```

## Hard Boundaries

Do not perform any of the following without explicit approval:

- deleting or restoring any P1 path
- copying env/config/runtime/user data into governance docs or normal archives
- hashing or reading content of secret/runtime-heavy paths as a blanket action
- importing dirty runtime/config/state content into `main`
- broad checkout, broad restore, `git clean`, or `git reset`
- touching database, vector-store, channelHub, dailynote, VCPChat, or `.claude`
  paths beyond read-only metadata
- branch deletion or worktree removal
- push, tag, release, deploy, live DingTalk/MCP/DWS command, or production write

## Approval Template For Future Retain Decision

```text
批准执行 P1-R0 retain protected/runtime bucket：
target = A:/VCP/VCPToolBox
scope = docs/governance/DIRTY_WORKTREE_PROTECTED_RUNTIME_P1_RETENTION_PREFLIGHT_20260526.md P1 protected entries
count = 128
action = retain only; no file operation
```

Without a future explicit approval, stop at this preflight.
