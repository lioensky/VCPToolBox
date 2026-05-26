# Dirty Worktree Generated Artifacts G1A Delete Execution - 2026-05-26

Scope: approved G1A generated-artifacts delete for dirty worktree
`A:/VCP/VCPToolBox`.

This record documents the approved source cleanup only. It did not restore
tracked files, reset, clean, change branches, push this execution record,
deploy, or touch production/runtime state.

## Authorization And Remote Baseline

The user explicitly requested:

```text
push f72e543，再执行 G1A generated artifacts delete。
```

Before the delete, `f72e543` was pushed to `origin/main` and reverified:

```text
HEAD        f72e543c089db599a3bbe65702e79a3851bd6b78
origin/main f72e543c089db599a3bbe65702e79a3851bd6b78
ahead/behind 0 / 0
```

## Source State

- Source worktree: `A:/VCP/VCPToolBox`
- Source branch: `feature/latest-updates`
- Source HEAD: `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`
- Source upstream comparison before delete: `10 / 15`
- Dirty status count before delete: `213`

## Archive Evidence

Approved rollback/archive artifact:

```text
A:/VCP/_archives/VCPToolBox/generated-artifacts-g1a-20260526/
```

Verified archive manifest:

```text
A:/VCP/_archives/VCPToolBox/generated-artifacts-g1a-20260526/ARCHIVE_MANIFEST.json
```

Archive checks before and after delete:

```text
Archive exists      true
Copied file count   37
Hash mismatch count 0
Manifest SHA256     3F9460394991FD91BFF4BBF8E617E249D524753535C4B1B394A01C39BA6EB3DB
```

## Pre-Delete Gate

The delete was gated by the G1A archive manifest and current dirty status:

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

## Delete Execution

Deleted exactly the `37` approved G1A paths from the dirty worktree by literal
path.

Execution constraints:

- Used `Remove-Item -LiteralPath <path> -Force` for each approved path.
- Did not use `Remove-Item -Recurse`.
- Did not use wildcard deletion.
- Did not use `git clean`.
- Did not use `git reset`.
- Did not touch tracked files.

## Deleted Path List

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

## Post-Delete Validation

Verified after delete:

```text
Dirty status count before delete 213
Dirty status count after delete  176
G1A count                        37
Existing after delete            0
Still in git status              0
Source branch                    feature/latest-updates
Source HEAD                      a82c8f20631b8a6dff32e237e73b313c2ea5cb60
Source upstream comparison       10 / 15
```

Archive artifact was rechecked after delete:

```text
Archive exists      true
Copied file count   37
Hash mismatch count 0
Manifest SHA256     3F9460394991FD91BFF4BBF8E617E249D524753535C4B1B394A01C39BA6EB3DB
```

## Not Touched

This execution did not touch:

- G1B sensitive-pattern report files.
- Runtime/protected cache-like paths.
- Config/env-like files.
- Manifest toggles.
- A2 blocked paths.
- Manual retain-review paths.
- Any tracked file.
- Branch refs, tags, releases, deployments, or production/live services.

## Rollback

Rollback path if needed:

1. Restore only the deleted `37` G1A paths from:
   `A:/VCP/_archives/VCPToolBox/generated-artifacts-g1a-20260526/`
2. Preserve relative paths under `A:/VCP/VCPToolBox`.
3. Recompute SHA256 for restored files against `ARCHIVE_MANIFEST.json`.
4. Re-run `git status --short --untracked-files=all` in
   `A:/VCP/VCPToolBox`.

Do not restore G1B, runtime/protected paths, manifest toggles, blocked paths,
manual retain-review paths, or tracked files as part of this rollback.
