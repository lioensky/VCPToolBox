# Dirty Worktree Manual Retain Review R1 Preflight - 2026-05-26

Scope: read-only preflight for the R1 manual retain-review bucket remaining in
dirty worktree `A:/VCP/VCPToolBox`.

This document is evidence and planning only. It does not authorize deleting,
restoring, moving, copying, archiving, resetting, cleaning, changing branches,
pushing, or touching production/runtime state.

## Current Verified State

- Control worktree: `A:/VCP/VCPToolBox-prod-stable`
- Control branch: `main`
- Control local `main`: `08c33ee`
- Control `main` / `origin/main`: `1 / 0`
- Latest verified `origin/main`: `3d3046149a885d88d4db960ad300f702c33de04d`
- Dirty worktree: `A:/VCP/VCPToolBox`
- Dirty branch: `feature/latest-updates`
- Dirty HEAD: `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`
- Dirty upstream comparison: `10 / 15`
- Dirty status count: `176`

## Scope

The R1 scope is the manual retain-review bucket from:

```text
docs/governance/DIRTY_WORKTREE_REMAINING_213_REASSESSMENT_20260526.md
```

R1 count: `7`

```text
 M Plugin/UserAuth/code.bin
 M plugins/custom/reporting/sync_to_external_sheet_or_notion/src/index.js
?? server.js.bak_before_restore_channelhub
 M tests/photo-studio/external-sync.test.js
 M TVStxt/supertool.txt
?? TVStxt/ToolList.txt
?? vcp-panel-extension/webview-ui/assets/icon.svg
```

## Read-Only Check Result

No matching secret-like values were recorded.

```text
R1 count                       7
Dirty status count             7
Tracked modified count         4
Untracked count                3
Existing count                 7
Binary-content count           0
Sensitive-pattern files        3
Sensitive-pattern matches      6
Conflict-marker files          4
Conflict-marker lines          11
```

Tracked diff summary:

```text
Plugin/UserAuth/code.bin                                          1 insert / 1 delete
TVStxt/supertool.txt                                           3695 inserts / 0 deletes
plugins/custom/reporting/sync_to_external_sheet_or_notion/src/index.js 70 inserts / 7 deletes
tests/photo-studio/external-sync.test.js                        134 inserts / 0 deletes
```

`git diff --check` over the tracked text candidates reported trailing
whitespace in `TVStxt/supertool.txt` and leftover conflict markers in
`plugins/custom/reporting/sync_to_external_sheet_or_notion/src/index.js` and
`tests/photo-studio/external-sync.test.js`.

## Per-Path Metadata

```text
Plugin/UserAuth/code.bin
  status: M
  tracked: true
  bytes: 88
  sha256: 3A4ABE4B3F01090700F4D58FA981E9F52C4C8E768FF33981663A80166F8E6AF4
  line count: 1
  sensitive-pattern matches: 0
  conflict-marker lines: 0
  interpretation: auth/binary-named state; protected from automatic intake or cleanup

plugins/custom/reporting/sync_to_external_sheet_or_notion/src/index.js
  status: M
  tracked: true
  bytes: 17691
  sha256: ABB63A21AD0BF7B5C1713F3FA2068D89B7EC19AC83D380B707A6120519E81EB6
  line count: 515
  sensitive-pattern matches: 0
  conflict-marker lines: 6
  interpretation: unresolved conflict markers; reject direct absorption as-is

server.js.bak_before_restore_channelhub
  status: ??
  tracked: false
  bytes: 66023
  sha256: 1840D2AA8B05198AA48AE8F11E9DBDA08038E6F19A1500596756B02AB2C15EAB
  line count: 1427
  sensitive-pattern matches: 2
  conflict-marker lines: 0
  interpretation: backup file with sensitive-pattern matches; do not commit or normal-archive

tests/photo-studio/external-sync.test.js
  status: M
  tracked: true
  bytes: 14601
  sha256: 0045284F31D3074495F9EE16C4C8FD209724C5234A86D70A4EAF6C3ADA456813
  line count: 371
  sensitive-pattern matches: 0
  conflict-marker lines: 3
  interpretation: unresolved conflict markers; reject direct absorption as-is

TVStxt/supertool.txt
  status: M
  tracked: true
  bytes: 153678
  sha256: 3E60C8053840D295DFBCA1A0071BC8056D04B9BBFDF15575B26D2CD2805FF377
  line count: 3710
  sensitive-pattern matches: 2
  conflict-marker lines: 1
  interpretation: large operational tool-list text; not a direct migration candidate

TVStxt/ToolList.txt
  status: ??
  tracked: false
  bytes: 151934
  sha256: CE46C280E557F288A85A1B4280D4635304A3F657C212EBCA97AEAC2B1981B103
  line count: 3706
  sensitive-pattern matches: 2
  conflict-marker lines: 1
  interpretation: large generated/operational tool-list text; retain, do not commit

vcp-panel-extension/webview-ui/assets/icon.svg
  status: ??
  tracked: false
  bytes: 300
  sha256: 74818F569DBB11E04588B693B7A6043FD1F108CCAB1B9040AB37BFDDE12A9F26
  line count: 5
  sensitive-pattern matches: 0
  conflict-marker lines: 0
  interpretation: standalone extension asset, already covered by D4D proposal-only review
```

## Risk Interpretation

R1 remains manual-review-only.

Reasons:

- `Plugin/UserAuth/code.bin` is auth/binary-named state.
- `server.js.bak_before_restore_channelhub`, `TVStxt/supertool.txt`, and
  `TVStxt/ToolList.txt` matched sensitive/config-like patterns.
- `plugins/custom/reporting/sync_to_external_sheet_or_notion/src/index.js`,
  `tests/photo-studio/external-sync.test.js`, `TVStxt/supertool.txt`, and
  `TVStxt/ToolList.txt` contain conflict-marker lines.
- `TVStxt/supertool.txt` and `TVStxt/ToolList.txt` are large operational
  tool-list texts rather than clean source deltas.
- `vcp-panel-extension/**` was already documented as a standalone product
  proposal and must not be absorbed as-is.

## Recommended Policy

Recommended current decision: retain-by-default for R1.

Do not bulk archive, delete, restore, or import this bucket.

Prepared follow-ups:

```text
R1-R0 retain manual-review bucket
  No file operation. Keep all 7 paths in the dirty worktree for context.

R1-Q1 quarantine-sensitive preflight
  Prepare a separate quarantine plan only for paths with sensitive-pattern
  matches, without printing matching values.

R1-P1 conflict-source review
  Review only the conflict-marked source/test files as source proposals after
  deciding whether external sync changes are still relevant.

R1-D0 cleanup to current-main state
  Destructive cleanup package. Requires exact path list, rollback strategy, and
  explicit approval.
```

## Hard Boundaries

Do not perform any of the following without explicit approval:

- deleting or restoring any R1 path
- copying raw sensitive-pattern files into governance docs or normal archives
- importing dirty code/test/tool-list contents into `main`
- broad checkout, broad restore, `git clean`, or `git reset`
- touching env/config/runtime/data paths outside this read-only preflight
- branch deletion or worktree removal
- push, tag, release, deploy, live DingTalk/MCP/DWS command, or production write

## Approval Template For Future Retain Decision

```text
批准执行 R1-R0 retain manual-review bucket：
target = A:/VCP/VCPToolBox
scope = docs/governance/DIRTY_WORKTREE_MANUAL_RETAIN_REVIEW_R1_PREFLIGHT_20260526.md R1 list
count = 7
action = retain only; no file operation
```

Without a future explicit approval, stop at this preflight.
