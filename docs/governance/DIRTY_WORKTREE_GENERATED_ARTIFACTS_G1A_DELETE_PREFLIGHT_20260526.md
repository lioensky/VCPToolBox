# Dirty Worktree Generated Artifacts G1A Delete Preflight - 2026-05-26

Scope: delete preflight for G1A generated artifacts in dirty worktree
`A:/VCP/VCPToolBox`.

This document is a preflight and approval-template artifact only. It does not
authorize deleting files, restoring files, resetting, cleaning, changing
branches, pushing, or touching production/runtime state.

## Current Verified State

- Control worktree: `A:/VCP/VCPToolBox-prod-stable`
- Control branch: `main`
- Control `main` / `origin/main`: synchronized at
  `3dd22fe238b38cc4bd5b3b1a21af5853e30a7b91`
- Dirty worktree: `A:/VCP/VCPToolBox`
- Dirty branch: `feature/latest-updates`
- Dirty HEAD: `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`
- Dirty upstream comparison: `10 / 15`
- Dirty status count: `213`

## Archive Evidence

G1A archive artifact:

```text
A:/VCP/_archives/VCPToolBox/generated-artifacts-g1a-20260526/
```

G1A manifest:

```text
A:/VCP/_archives/VCPToolBox/generated-artifacts-g1a-20260526/ARCHIVE_MANIFEST.json
```

Verified:

- Manifest copied-file count: `37`
- Manifest hash mismatch count: `0`
- Manifest SHA256:
  `3F9460394991FD91BFF4BBF8E617E249D524753535C4B1B394A01C39BA6EB3DB`

## Delete Preflight Result

Result: G1A delete is eligible after explicit delete approval.

Read-only checks over the G1A archive manifest list:

```text
Dirty status count          213
G1A count                   37
Unique G1A count            37
Inside workspace count      37
Untracked count             37
Exists count                37
Hash match count            37
Sensitive match files       0
Failure count               0
Expected dirty after delete 176
```

Interpretation:

- All `37` G1A source paths still exist in `A:/VCP/VCPToolBox`.
- All `37` G1A source paths are still untracked.
- All `37` current source hashes still match the G1A archive manifest.
- No G1A source file matched the sensitive-pattern scan.
- The archive artifact remains available for rollback.

## Delete Candidate List

Delete count after explicit approval: `37`

```text
docs/dingtalk-cli/reports/baseline-2026-04-13T13-37-28-894Z.json
docs/dingtalk-cli/reports/baseline-2026-04-13T13-39-00-225Z.json
docs/dingtalk-cli/reports/baseline-2026-04-13T13-44-03-057Z.json
docs/dingtalk-cli/reports/baseline-2026-04-13T13-56-14-623Z.json
docs/dingtalk-cli/reports/baseline-2026-04-13T14-18-04-850Z.json
docs/dingtalk-cli/reports/baseline-latest.json
docs/dingtalk-cli/reports/baseline-latest.md
docs/dingtalk-cli/reports/capability-matrix-2026-04-13T13-37-36-323Z.json
docs/dingtalk-cli/reports/capability-matrix-2026-04-13T13-39-00-286Z.json
docs/dingtalk-cli/reports/capability-matrix-2026-04-13T13-40-33-368Z.json
docs/dingtalk-cli/reports/capability-matrix-2026-04-13T13-46-16-108Z.json
docs/dingtalk-cli/reports/capability-matrix-2026-04-13T13-51-23-225Z.json
docs/dingtalk-cli/reports/capability-matrix-2026-04-13T13-53-44-676Z.json
docs/dingtalk-cli/reports/capability-matrix-latest.md
docs/dingtalk-cli/reports/workflow-e2e-2026-04-13T13-37-36-311Z.json
docs/dingtalk-cli/reports/workflow-e2e-2026-04-13T13-39-00-265Z.json
docs/dingtalk-cli/reports/workflow-e2e-2026-04-13T13-40-31-433Z.json
docs/dingtalk-cli/reports/workflow-e2e-2026-04-13T13-44-10-939Z.json
docs/dingtalk-cli/reports/workflow-e2e-2026-04-13T13-54-01-767Z.json
docs/dingtalk-cli/reports/workflow-e2e-2026-04-13T13-55-30-563Z.json
docs/dingtalk-cli/reports/workflow-e2e-2026-04-13T14-18-36-868Z.json
docs/dingtalk-cli/reports/workflow-e2e-2026-04-13T14-25-05-337Z.json
docs/dingtalk-cli/reports/workflow-e2e-latest.json
docs/dingtalk-cli/reports/workflow-e2e-latest.md
Plugin/DoubaoGen/.doubao_api_cache.json
Plugin/FlashDeepSearch/log/log_2026-04-16T06-53-32-824Z.txt
Plugin/FlashDeepSearch/log/log_2026-04-16T07-01-54-330Z.txt
Plugin/FlashDeepSearch/log/log_2026-04-16T09-02-10-205Z.txt
Plugin/FlashDeepSearch/log/log_2026-04-16T09-04-17-397Z.txt
Plugin/FlashDeepSearch/log/log_2026-04-16T09-54-03-502Z.txt
Plugin/FlashDeepSearch/log/log_2026-04-16T12-13-00-093Z.txt
Plugin/FlashDeepSearch/log/log_2026-04-16T12-39-44-732Z.txt
Plugin/FlashDeepSearch/log/log_2026-04-16T13-03-39-513Z.txt
Plugin/FlashDeepSearch/log/log_2026-04-16T13-11-47-608Z.txt
Plugin/FlashDeepSearch/log/log_2026-04-16T13-11-59-520Z.txt
Plugin/FlashDeepSearch/log/log_2026-04-16T13-15-21-999Z.txt
Plugin/Randomness/__pycache__/dice_roller.cpython-311.pyc
```

If G1A delete is later executed and no intervening changes occur, dirty status
count should drop from `213` to `176`.

## Execution Boundary

If G1A delete is later approved:

- Delete only the `37` literal paths listed above.
- Recheck each path is untracked before delete.
- Recheck each path still exists before delete.
- Recheck each current SHA256 equals the G1A archive manifest SHA256 before
  delete.
- Re-run sensitive-pattern scan and stop on any match.
- Do not use `git clean`, recursive delete, wildcard delete, broad restore, or
  reset.

G1A delete must not touch:

- G1B sensitive-pattern reports.
- Runtime/protected cache-like paths.
- Config/env-like files.
- Manifest toggles.
- A2 blocked paths.
- Manual retain-review paths.
- Any tracked file.

## Rollback

If G1A delete is later approved and executed:

1. Restore only the deleted `37` paths from:
   `A:/VCP/_archives/VCPToolBox/generated-artifacts-g1a-20260526/`
2. Preserve relative paths under `A:/VCP/VCPToolBox`.
3. Recompute SHA256 for restored files against `ARCHIVE_MANIFEST.json`.
4. Re-run `git status --short --untracked-files=all` in the dirty worktree.

## Required Approval For Actual Delete

```text
批准执行 G1A generated artifacts delete：
target = A:/VCP/VCPToolBox
delete = docs/governance/DIRTY_WORKTREE_GENERATED_ARTIFACTS_G1A_DELETE_PREFLIGHT_20260526.md delete candidate list
count = 37
precheck = each file remains untracked and current SHA256 matches G1A ARCHIVE_MANIFEST.json
rollback = restore only deleted G1A files from G1A archive artifact
```

Without that explicit approval, stop at this preflight.
