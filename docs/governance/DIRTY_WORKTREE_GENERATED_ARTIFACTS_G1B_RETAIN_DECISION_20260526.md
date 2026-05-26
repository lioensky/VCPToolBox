# Dirty Worktree Generated Artifacts G1B Retain Decision - 2026-05-26

Scope: user-selected retain decision for G1B sensitive-pattern generated
reports in dirty worktree `A:/VCP/VCPToolBox`.

This document records the decision only. It did not copy, archive, delete,
restore, reset, clean, change branches, push, or touch production/runtime
state.

## Decision

User decision:

```text
保留
```

Decision package: `G1B-R0 retain in dirty worktree`.

Meaning:

- Keep the four G1B generated report files in `A:/VCP/VCPToolBox`.
- Do not copy raw G1B content into `main`.
- Do not archive raw G1B content.
- Do not delete G1B files.
- Do not print or record matching sensitive/config-like values.
- Revisit only if the user later chooses a separate quarantine or delete
  package.

## Current Verified State

- Control worktree: `A:/VCP/VCPToolBox-prod-stable`
- Control branch: `main`
- Control local `main` before this record: `b712562`
- Control `main` / `origin/main`: `2 / 0`
- Latest verified `origin/main`: `f72e543c089db599a3bbe65702e79a3851bd6b78`
- Dirty worktree: `A:/VCP/VCPToolBox`
- Dirty branch: `feature/latest-updates`
- Dirty HEAD: `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`
- Dirty upstream comparison: `10 / 15`
- Dirty status count: `176`

## Retained G1B Files

The retained files are still untracked and still present:

```text
docs/dingtalk-cli/reports/capability-matrix-2026-04-13T14-18-34-977Z.json
docs/dingtalk-cli/reports/capability-matrix-2026-04-13T14-24-34-009Z.json
docs/dingtalk-cli/reports/capability-matrix-2026-04-13T14-25-49-209Z.json
docs/dingtalk-cli/reports/capability-matrix-latest.json
```

Verification summary:

```text
G1B count       4
Existing count  4
Untracked count 4
```

Per-file metadata:

```text
docs/dingtalk-cli/reports/capability-matrix-2026-04-13T14-18-34-977Z.json
  status: ??
  bytes: 92412
  sha256: 49FFF371FDE0D71212ACF32C64CCF434C65943E38FA7D7E37FD3AE341C4C702B

docs/dingtalk-cli/reports/capability-matrix-2026-04-13T14-24-34-009Z.json
  status: ??
  bytes: 102747
  sha256: 7125D9FAB34443DD5E0E4EF065EE07340072E3D50C4DEA84C97CE14BA45B24B3

docs/dingtalk-cli/reports/capability-matrix-2026-04-13T14-25-49-209Z.json
  status: ??
  bytes: 102793
  sha256: D592E50EA20906683D717E17C49BCF0FE81A43CE196DE1038F58332F660F94B0

docs/dingtalk-cli/reports/capability-matrix-latest.json
  status: ??
  bytes: 102793
  sha256: D592E50EA20906683D717E17C49BCF0FE81A43CE196DE1038F58332F660F94B0
```

## Boundary

This decision does not authorize:

- quarantine archive creation
- raw file copying
- raw file deletion
- generated report sanitization
- rollback archive creation
- branch deletion
- push or any remote write
- live DingTalk/MCP/DWS command
- production/runtime state change

## Future Reopen Conditions

G1B can be reopened only with a new explicit instruction such as:

```text
批准执行 G1B-Q1 quarantine archive preflight
```

or:

```text
批准执行 G1B-D0 delete without raw archive
```

Until then, the four G1B files remain retained in the dirty worktree.
