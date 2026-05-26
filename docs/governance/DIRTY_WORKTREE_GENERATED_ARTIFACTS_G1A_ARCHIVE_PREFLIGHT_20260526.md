# Dirty Worktree Generated Artifacts G1A Archive Preflight - 2026-05-26

Scope: archive preflight for G1A non-sensitive generated artifacts in dirty
worktree `A:/VCP/VCPToolBox`.

This document is a preflight and approval-template artifact only. It does not
authorize creating an archive, copying files, deleting files, cleaning,
restoring, resetting, changing branches, pushing, or touching production/runtime
state.

## Current Verified State

- Control worktree: `A:/VCP/VCPToolBox-prod-stable`
- Control branch: `main`
- Control `main` / `origin/main`: synchronized at
  `a465fadd4786e249bc433d4218ed92f28e771f3e`
- Dirty worktree: `A:/VCP/VCPToolBox`
- Dirty branch: `feature/latest-updates`
- Dirty HEAD: `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`
- Dirty upstream comparison: `10 / 15`
- Dirty status count: `213`

## Source Document

G1A source list:

```text
docs/governance/DIRTY_WORKTREE_GENERATED_ARTIFACTS_PREFLIGHT_20260526.md
```

## Proposed Destination

Not approved yet:

```text
A:/VCP/_archives/VCPToolBox/generated-artifacts-g1a-20260526/
```

Destination state:

```text
Destination exists: false
```

Execution must not create this directory until the user explicitly approves G1A
archive execution with destination, include list, exclusions, dry-run count, and
rollback.

## Preflight Result

Result: G1A archive execution is eligible after explicit archive approval.

Read-only checks:

```text
G1A count              37
Unique G1A count       37
Untracked count        37
Exists count           37
Sensitive match files  0
G1B overlap count      0
Total bytes            1,167,943
Failure count          0
```

Prefix counts:

```text
docs-dingtalk-reports  24
flashdeepsearch-logs   11
doubao-cache           1
python-bytecode-cache  1
```

## G1A Include List

Dry-run count: `37`

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

## Exclusions

The archive must exclude:

```text
G1B sensitive-pattern generated reports
Plugin/DingTalkCLI/state/**
state/channelHub/**
state/embedding-fallback-stats.json
Plugin/ImageProcessor/*.sqlite*
Plugin/ImageRatingManager/*.sqlite*
VectorStore_bge1024/**
VectorStore_bge1024_backup_20260422-123654/**
config/env-like files
manifest toggles
A2 blocked paths
manual retain-review paths
protected/runtime/data paths
```

## Archive Execution Requirements

If G1A archive execution is later approved:

1. Recheck all `37` paths are still untracked.
2. Recheck all `37` paths still exist.
3. Re-run sensitive-pattern scan over all `37` paths.
4. Stop if any sensitive-pattern match appears.
5. Create only the approved destination outside both worktrees.
6. Copy only the G1A include list.
7. Generate a manifest containing relative path, byte count, source SHA256, and
   archived SHA256.
8. Verify source and archived SHA256 match for all `37` files.
9. Do not delete any source file.

## Rollback

If a future G1A archive execution creates a bad artifact:

1. Verify the archive path is exactly the approved destination.
2. Delete only that generated archive directory.
3. Do not delete anything inside `A:/VCP/VCPToolBox`.
4. Re-run `git status --short --untracked-files=all` in both worktrees.

## Required Approval For Archive Execution

```text
批准执行 G1A generated artifacts archive：
destination = A:/VCP/_archives/VCPToolBox/generated-artifacts-g1a-20260526/
include = docs/governance/DIRTY_WORKTREE_GENERATED_ARTIFACTS_G1A_ARCHIVE_PREFLIGHT_20260526.md G1A include list
exclude = docs/governance/DIRTY_WORKTREE_GENERATED_ARTIFACTS_G1A_ARCHIVE_PREFLIGHT_20260526.md exclusions
dry-run count = 37
rollback = delete only the generated archive artifact at the approved destination
```

Without that explicit approval, stop at this preflight.
