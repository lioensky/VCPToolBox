# Dirty Worktree Generated Artifacts G1B Sanitize Quarantine Preflight - 2026-05-26

Scope: read-only sanitize/quarantine preflight for G1B sensitive-pattern
generated reports in dirty worktree `A:/VCP/VCPToolBox`.

This document is evidence and an approval template only. It does not authorize
copying, archiving, deleting, restoring, resetting, cleaning, changing branches,
pushing, or touching production/runtime state.

## Current Verified State

- Control worktree: `A:/VCP/VCPToolBox-prod-stable`
- Control branch: `main`
- Control local `main`: `d42725b`
- Control `main` / `origin/main`: `1 / 0`
- Latest verified `origin/main`: `f72e543c089db599a3bbe65702e79a3851bd6b78`
- Dirty worktree: `A:/VCP/VCPToolBox`
- Dirty branch: `feature/latest-updates`
- Dirty HEAD: `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`
- Dirty upstream comparison: `10 / 15`
- Dirty status count after G1A delete: `176`

## G1B Scope

G1B is the sensitive-pattern subset left out of the G1A archive/delete package.
All G1A non-sensitive generated artifacts were already deleted after archive
verification.

G1B count: `4`

```text
docs/dingtalk-cli/reports/capability-matrix-2026-04-13T14-18-34-977Z.json
docs/dingtalk-cli/reports/capability-matrix-2026-04-13T14-24-34-009Z.json
docs/dingtalk-cli/reports/capability-matrix-2026-04-13T14-25-49-209Z.json
docs/dingtalk-cli/reports/capability-matrix-latest.json
```

## Read-Only Check Result

No matching values were recorded.

```text
G1B count                      4
Existing count                 4
Untracked count                4
Valid JSON count               4
Sensitive-pattern line count   28
Sensitive-pattern match count  32
Sensitive-like JSON key paths  0
Dirty status count             176
```

Per-file metadata:

```text
docs/dingtalk-cli/reports/capability-matrix-2026-04-13T14-18-34-977Z.json
  status: ??
  bytes: 92412
  sha256: 49FFF371FDE0D71212ACF32C64CCF434C65943E38FA7D7E37FD3AE341C4C702B
  sensitive-pattern lines: 7
  sensitive-pattern matches: 8

docs/dingtalk-cli/reports/capability-matrix-2026-04-13T14-24-34-009Z.json
  status: ??
  bytes: 102747
  sha256: 7125D9FAB34443DD5E0E4EF065EE07340072E3D50C4DEA84C97CE14BA45B24B3
  sensitive-pattern lines: 7
  sensitive-pattern matches: 8

docs/dingtalk-cli/reports/capability-matrix-2026-04-13T14-25-49-209Z.json
  status: ??
  bytes: 102793
  sha256: D592E50EA20906683D717E17C49BCF0FE81A43CE196DE1038F58332F660F94B0
  sensitive-pattern lines: 7
  sensitive-pattern matches: 8

docs/dingtalk-cli/reports/capability-matrix-latest.json
  status: ??
  bytes: 102793
  sha256: D592E50EA20906683D717E17C49BCF0FE81A43CE196DE1038F58332F660F94B0
  sensitive-pattern lines: 7
  sensitive-pattern matches: 8
```

The timestamped `2026-04-13T14-25-49-209Z` file and `latest` file have the
same SHA256 and appear to be duplicate generated outputs.

## Risk Interpretation

G1B files are still generated artifacts, but they cannot be treated like G1A
because the content matched sensitive/config-like patterns.

Important boundaries:

- Do not commit the raw G1B files to `main`.
- Do not copy raw G1B content into governance documentation.
- Do not archive raw G1B files into a normal non-sensitive archive package.
- Do not delete G1B files until a separate approval chooses a rollback strategy.
- Do not print matching lines or matching values in terminal summaries,
  governance docs, memory, issues, PRs, or commit messages.

## User Decision

The user selected:

```text
保留
```

This closes the current G1B decision as `G1B-R0 retain in dirty worktree`.
No G1B file was copied, archived, deleted, sanitized, restored, reset, cleaned,
or checked out.

## Recommended Strategy

Recommended next package: `G1B-Q1` quarantined raw archive preflight.

Rationale:

- The files are untracked generated reports and likely disposable.
- The files may contain sensitive/config-like values or value-shaped strings.
- Raw preservation, if needed, should happen outside the repository and outside
  ordinary generated-artifact archives.
- A delete package should come only after either explicit no-archive approval or
  explicit quarantine approval and verification.

Prepared options:

```text
G1B-R0 retain in dirty worktree
  No file operation. Keep the 4 files as-is until manual review.

G1B-Q1 quarantined raw archive preflight
  Propose a separate destination outside repo worktrees, create only a manifest
  plan first, and require explicit approval before copying raw files.

G1B-D0 delete without raw archive
  Delete the 4 untracked generated reports only if the user explicitly accepts
  no raw rollback copy. Rollback would be unavailable except regeneration.

G1B-D1 delete after quarantined raw archive
  Delete the 4 paths only after a separately approved quarantine archive exists
  and hashes are verified.
```

## Proposed Quarantine Destination

No directory was created.

If `G1B-Q1` is later approved, use a destination outside both worktrees:

```text
A:/VCP/_archives/VCPToolBox/generated-artifacts-g1b-sensitive-quarantine-20260526/
```

The quarantine manifest should contain only:

- relative path
- byte count
- SHA256
- untracked status
- copied/hash-match status, if a later copy is approved
- sanitized sensitive-pattern counts

The manifest must not contain matching lines or matching values.

## Explicit Exclusions

This G1B package must not touch:

```text
G1A deleted paths
Plugin/DingTalkCLI/state/**
state/channelHub/**
state/embedding-fallback-stats.json
Plugin/ImageProcessor/*.sqlite*
Plugin/ImageRatingManager/*.sqlite*
VectorStore_bge1024/**
VectorStore_bge1024_backup_20260422-123654/**
config/env-like files outside the 4 listed G1B reports
manifest toggles
A2 blocked paths
manual retain-review paths
tracked files
```

## Approval Templates

Quarantine preflight only:

```text
批准执行 G1B-Q1 quarantine archive preflight：
target = A:/VCP/VCPToolBox
include = docs/governance/DIRTY_WORKTREE_GENERATED_ARTIFACTS_G1B_SANITIZE_QUARANTINE_PREFLIGHT_20260526.md G1B Scope
destination = A:/VCP/_archives/VCPToolBox/generated-artifacts-g1b-sensitive-quarantine-20260526/
count = 4
mode = preflight only, no copy, no delete
secret handling = do not print matching values; manifest metadata only
```

Delete without archive:

```text
批准执行 G1B-D0 delete without raw archive：
target = A:/VCP/VCPToolBox
delete = docs/governance/DIRTY_WORKTREE_GENERATED_ARTIFACTS_G1B_SANITIZE_QUARANTINE_PREFLIGHT_20260526.md G1B Scope
count = 4
precheck = each file remains untracked and SHA256 matches this preflight
rollback = no raw rollback copy; regenerate if needed
```

Delete after quarantine:

```text
批准执行 G1B-D1 delete after quarantine：
target = A:/VCP/VCPToolBox
delete = docs/governance/DIRTY_WORKTREE_GENERATED_ARTIFACTS_G1B_SANITIZE_QUARANTINE_PREFLIGHT_20260526.md G1B Scope
count = 4
precheck = each file remains untracked and SHA256 matches approved quarantine manifest
rollback = restore only deleted G1B files from approved quarantine archive
```

Without one of these explicit approvals, stop at this preflight.
