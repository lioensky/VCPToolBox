# Dirty Worktree Final Classification Closure - 2026-05-26

Scope: final classification closure for dirty worktree `A:/VCP/VCPToolBox`.

This document is a governance closure record only. It does not authorize
copying, archiving, deleting, restoring, resetting, cleaning, changing branches,
pushing, or touching production/runtime state.

## Current Verified State

- Control worktree: `A:/VCP/VCPToolBox-prod-stable`
- Control branch: `main`
- Control `main` / `origin/main`: synchronized at
  `b0e2426cee4b891b37e7a7cf009bf31f23f48b90`
- Dirty worktree: `A:/VCP/VCPToolBox`
- Dirty branch: `feature/latest-updates`
- Dirty HEAD: `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`
- Dirty upstream comparison: `10 / 15`
- Dirty status count: `176`

## Closure Result

All remaining dirty entries are classified.

```text
Dirty entries             176
Classified entries        176
Unclassified entries        0
```

Final buckets:

```text
G1B retained generated reports          4
M1 manifest toggles                    28
R1 manual retain-review                 7
B1 blocked/excluded paths               9
P1 protected/runtime retention        128
```

## Closed Or Classified Packages

### G1A - Completed Cleanup

G1A non-sensitive generated artifacts were archived, verified, and deleted
after explicit approval.

Evidence:

```text
docs/governance/DIRTY_WORKTREE_GENERATED_ARTIFACTS_G1A_ARCHIVE_EXECUTION_20260526.md
docs/governance/DIRTY_WORKTREE_GENERATED_ARTIFACTS_G1A_DELETE_EXECUTION_20260526.md
```

Result:

```text
Deleted paths       37
Dirty count change  213 -> 176
Archive hash mismatches 0
```

### G1B - Retain

G1B contains four generated reports with sensitive-pattern matches. The user
selected retain.

Evidence:

```text
docs/governance/DIRTY_WORKTREE_GENERATED_ARTIFACTS_G1B_SANITIZE_QUARANTINE_PREFLIGHT_20260526.md
docs/governance/DIRTY_WORKTREE_GENERATED_ARTIFACTS_G1B_RETAIN_DECISION_20260526.md
```

Policy:

```text
G1B-R0 retain in dirty worktree
```

### M1 - Manifest Toggles

M1 contains behavior-affecting plugin enable/disable and manifest-version
changes.

Evidence:

```text
docs/governance/DIRTY_WORKTREE_MANIFEST_TOGGLES_PREFLIGHT_20260526.md
```

Policy:

```text
Retain by default. Do not bulk restore, delete, or import.
Reopen only through explicit plugin-level decision packages.
```

### R1 - Manual Retain Review

R1 contains auth/binary-named state, conflict-marked source/test files,
sensitive-pattern text files, large tool-list text, and a standalone extension
asset.

Evidence:

```text
docs/governance/DIRTY_WORKTREE_MANUAL_RETAIN_REVIEW_R1_PREFLIGHT_20260526.md
```

Policy:

```text
Retain by default. Do not bulk archive, delete, restore, or import.
Reopen only through explicit path/package decisions.
```

### B1 - Blocked A2 Exclusions

B1 contains source/runtime/admin/startup paths, dependency-lock-like data, and
a path-ambiguous response artifact.

Evidence:

```text
docs/governance/DIRTY_WORKTREE_BLOCKED_B1_PREFLIGHT_20260526.md
```

Policy:

```text
Remain blocked. Do not bulk archive, delete, restore, or import.
Reopen only through explicit source/security or retain decisions.
```

### P1 - Protected Runtime

P1 contains env/config-like paths, SQLite/WAL/SHM, vector stores, runtime state,
`.claude/**`, VCPChat data, and daily-note data.

Evidence:

```text
docs/governance/DIRTY_WORKTREE_PROTECTED_RUNTIME_P1_RETENTION_PREFLIGHT_20260526.md
```

Policy:

```text
Retain by default. Not a cleanup bucket.
Reopen only through explicit backup/quarantine/delete/retain policy.
```

## Default Policy

The remaining `176` dirty entries should remain in place by default.

Do not perform any broad action against the dirty worktree:

- no `git clean`
- no `git reset`
- no broad checkout or broad restore
- no bulk archive
- no bulk delete
- no bulk import into `main`
- no plugin manifest normalization
- no runtime data copying
- no production or live-service action

## Future Explicit Packages

Safe future package names:

```text
G1B-Q1 quarantine archive preflight
G1B-D0 delete without raw archive
M1-R0 retain manifest toggles
M1-P1 plugin-by-plugin reject/restore plan
M1-I1 candidate intake review
R1-R0 retain manual-review bucket
R1-Q1 quarantine-sensitive preflight
R1-P1 conflict-source review
B1-R0 retain blocked bucket
B1-S1 source/security review
B1-Q1 quarantine-sensitive artifact preflight
P1-R0 retain protected/runtime bucket
P1-Q1 quarantine/backup preflight
P1-S1 selective source-safe extraction
```

Destructive packages such as `M1-D0`, `R1-D0`, `B1-D0`, or `P1-D0` require:

- exact path list
- include/exclude list
- rollback story
- current preflight
- explicit approval

## Closure Statement

Dirty worktree governance classification is closed for this phase.

No remaining dirty entry is an unclassified cleanup candidate. Future work is a
policy decision, source/security review, quarantine/backup preflight, or
explicit cleanup package.

No file in `A:/VCP/VCPToolBox` was edited, copied, archived, deleted, restored,
reset, cleaned, checked out, or imported into `main` while producing this
closure record.
