# Dirty Worktree Generated Artifacts Preflight - 2026-05-26

Scope: read-only preflight for generated artifacts remaining in dirty worktree
`A:/VCP/VCPToolBox`.

This document is evidence and planning only. It does not authorize deleting,
archiving, restoring, resetting, cleaning, changing branches, pushing, or
touching production/runtime state.

## Current Verified State

- Control worktree: `A:/VCP/VCPToolBox-prod-stable`
- Control branch: `main`
- Control `main` / `origin/main`: synchronized at
  `64f9f994f9b5d00cbd65dd5c8570101f3f6d27e3`
- Dirty worktree: `A:/VCP/VCPToolBox`
- Dirty branch: `feature/latest-updates`
- Dirty HEAD: `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`
- Dirty upstream comparison: `10 / 15`
- Dirty status count: `213`

## Scope Decision

The generated-artifacts package is strictly limited to the G1 bucket from:

```text
docs/governance/DIRTY_WORKTREE_REMAINING_213_REASSESSMENT_20260526.md
```

Strict G1 includes:

```text
docs/dingtalk-cli/reports/**
Plugin/FlashDeepSearch/log/**
Plugin/DoubaoGen/.doubao_api_cache.json
Plugin/Randomness/__pycache__/**
```

A broader `cache` scan also matched runtime/protected paths such as
`Plugin/DingTalkCLI/state/**`, `state/channelHub/**`, SQLite cache/database
files, and vector/runtime state. Those remain excluded from this package.

## Strict G1 Summary

```text
Strict G1 count              41
Tracked entries             0
Untracked entries           41
Existing files              41
Total bytes                 1,568,688
Excluded runtime/cache-like 63
```

Prefix counts:

```text
docs-dingtalk-reports       28   1,548,415 bytes
flashdeepsearch-logs        11   1,397 bytes
doubao-cache                1    284 bytes
python-bytecode-cache       1    18,592 bytes
```

## Sensitive Pattern Scan

Scan over the strict `41` G1 candidates produced:

```text
Sensitive-pattern files     4
Sensitive-pattern matches   28
```

No matching secret values are recorded in this document.

Files with sensitive/config-like pattern matches:

```text
docs/dingtalk-cli/reports/capability-matrix-2026-04-13T14-18-34-977Z.json
docs/dingtalk-cli/reports/capability-matrix-2026-04-13T14-24-34-009Z.json
docs/dingtalk-cli/reports/capability-matrix-2026-04-13T14-25-49-209Z.json
docs/dingtalk-cli/reports/capability-matrix-latest.json
```

These files are not approved for cleanup or archival in this package without a
separate sanitize/quarantine decision.

## G1A - Non-Sensitive Generated Cleanup Candidates

Dry-run count: `37`

These are untracked generated artifacts with no sensitive-pattern matches in
this preflight.

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

G1A is eligible for a future generated-artifact archive/delete plan, but not for
execution from this preflight alone.

## G1B - Sensitive-Pattern Generated Reports

Dry-run count: `4`

```text
docs/dingtalk-cli/reports/capability-matrix-2026-04-13T14-18-34-977Z.json
docs/dingtalk-cli/reports/capability-matrix-2026-04-13T14-24-34-009Z.json
docs/dingtalk-cli/reports/capability-matrix-2026-04-13T14-25-49-209Z.json
docs/dingtalk-cli/reports/capability-matrix-latest.json
```

G1B requires a separate sanitize/quarantine decision before archive/delete.

## Explicit Exclusions

The following classes remain excluded from generated-artifact cleanup:

```text
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
```

One runtime SQLite file was actively in use during read-only probing, which
reinforces that runtime/protected cache-like paths must remain outside this
package.

## Recommended Next Packages

1. G1A archive preflight:
   Prepare an archive destination and manifest for the `37` non-sensitive
   generated artifacts.
2. G1A delete execution:
   Only after G1A archive exists and hashes are verified.
3. G1B sanitize/quarantine review:
   Inspect or sanitize the `4` sensitive-pattern report files without recording
   sensitive values.

## Approval Template For G1A Archive Preflight

```text
批准执行 G1A generated artifacts archive preflight：
target = A:/VCP/VCPToolBox
include = docs/governance/DIRTY_WORKTREE_GENERATED_ARTIFACTS_PREFLIGHT_20260526.md G1A list
count = 37
exclude = G1B sensitive-pattern reports and all explicit exclusions
rollback = delete only the generated archive artifact if created
```

This template authorizes only archive preflight, not deletion.
