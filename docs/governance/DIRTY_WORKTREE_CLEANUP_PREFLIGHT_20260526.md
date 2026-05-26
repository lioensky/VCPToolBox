# Dirty Worktree Cleanup Preflight - 2026-05-26

Scope: A3 cleanup preflight for dirty worktree `A:/VCP/VCPToolBox`.

This is a preflight document only. It does not authorize deleting files,
restoring tracked files, running `git clean`, running `git reset`, changing
branches, removing worktrees, pushing, or touching production/runtime state.

## Current Verified State

- Control worktree: `A:/VCP/VCPToolBox-prod-stable`
- Control branch: `main`
- Control `main` / `origin/main`: synchronized at
  `4c0b0a68015bb4c36bbeece102bd4adf90c5bd79`
- Dirty worktree: `A:/VCP/VCPToolBox`
- Dirty branch: `feature/latest-updates`
- Dirty HEAD: `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`
- Dirty upstream comparison: `10 / 15`
- Dirty status count: `260`
- Tracked dirty entries: `41`
- Untracked dirty entries: `219`

## Archive Evidence

A2 archive artifact:

```text
A:/VCP/_archives/VCPToolBox/dirty-feature-latest-updates-20260526/
```

A2 manifest:

```text
A:/VCP/_archives/VCPToolBox/dirty-feature-latest-updates-20260526/ARCHIVE_MANIFEST.json
```

Verified:

- Manifest copied-file count: `47`
- Archive total file count: `48`
- Manifest hash mismatch count: `0`
- Manifest SHA256:
  `56612B88F302E9573D1D8D946451B4842A025FBC709C02831913EED50331A8FE`
- All `47` archived source paths still exist in dirty status.
- Current source hash still matches archived hash for all `47` archived paths.

## A3 Classification

Classification was generated from `git status --porcelain=v1 -z
--untracked-files=all`, the A2 manifest, and the A2 blocked list.

```text
candidate-delete-archived-untracked 39
candidate-revert-archived-tracked   8
blocked-a2-excluded                 9
protected-secret-runtime-data       128
generated-report-log-cache          41
manifest-toggle-review              28
retain-review-unarchived            7
```

These buckets cover all `260` dirty entries.

## Candidate C1 - Delete Archived Untracked Files

Dry-run count: `39`

These paths are untracked, currently hash-matched to the archive, and can be
considered for a future delete-only cleanup package after explicit approval.

```text
.agent_board/CHECKPOINT.md
.agent_board/DECISIONS.md
.agent_board/HANDOFF.md
.agent_board/RUN_STATE.md
.agent_board/TASK_QUEUE.md
.agent_board/VALIDATION_LOG.md
Agent/Noir Architect.txt
docs/interaction-middleware/VCPToolBox to dingtalk-workspace-cli.md
docs/interaction-middleware/VCPToolBox to dingtalk-workspace-cli11.md
docs/VCPToolBox to dingtalk-workspace-cli.md
fix_session_store.js
modules/toolExecution.js
Plugin/_PluginDocTemplate/docs/01-quickstart.md
Plugin/_PluginDocTemplate/docs/02-config.md
Plugin/_PluginDocTemplate/docs/03-release-checklist.md
Plugin/_PluginDocTemplate/README.md
Plugin/AIGentPrompt/test_rag_result.md
Plugin/CodexMemoryBridge/codex-memory-bridge.fixed.js
Plugin/CodexMemoryBridge/codex-memory-bridge.new.js
Plugin/DingTalkTable/DingTalkTable.js
Plugin/DingTalkTable/lpan.txt
Plugin/DingTalkTable/plan.md
Plugin/DingTalkTable/README.md
Plugin/vcp-dingtalk-adapter/src/adapters/vcp/client.js.patch
Plugin/vcp-onebot-adapter/docs/00-index.md
Plugin/vcp-onebot-adapter/docs/01-quickstart.md
Plugin/vcp-onebot-adapter/docs/02-config.md
Plugin/vcp-onebot-adapter/docs/03-release-checklist.md
routes/toolExecutionRoutes.js
scripts/rebuild_kb_once.js
start_server.bat
tests/channelHub-hardening.test.js
tests/messageProcessor.test.js
update.sh
VCP_ANALYSIS.md
VCP_ARCHITECTURE_MASTER.md
vcp-panel-extension/extension.js
vcp-panel-extension/package.json
vcp-panel-extension/README.md
```

If only C1 is executed later, expected dirty status count would drop from `260`
to `221`, assuming no intervening changes.

Rollback for C1, if later approved and executed:

1. Restore only the deleted C1 paths from the A2 archive artifact.
2. Preserve relative paths under `A:/VCP/VCPToolBox`.
3. Recompute SHA256 for restored files against `ARCHIVE_MANIFEST.json`.
4. Re-run `git status --short --untracked-files=all`.

## Candidate C2 - Revert Archived Tracked Modifications

Dry-run count: `8`

These paths are tracked modified files, currently hash-matched to the archive.
Cleaning them would require discarding working-tree changes, not deleting
untracked files. Treat this as a separate high-risk decision.

```text
Agent/Nova.txt
diary-semantic-classifier.js
docs/ADMINPANEL_DEVELOPMENT.md
KnowledgeBaseManager.js
Plugin/DeepWikiVCP/deepwiki_vcp.js
Plugin/vcp-onebot-adapter/README.md
Plugin/ZImageGen/ZImageGen.mjs
Plugin/ZImageGen2/ZImageGen.mjs
```

If C1 and C2 are both executed later, expected dirty status count would drop
from `260` to `213`, assuming no intervening changes.

Do not execute C2 with a broad command. It requires an exact path list, fresh
hash verification, and explicit approval to discard these tracked modifications.

## Blocked B1 - A2 Excluded Paths

Dry-run count: `9`

These were excluded from A2 archive or had path/status ambiguity. Do not clean
them automatically.

```text
AdminPanel/index.html
AdminPanel/script.js
AdminPanel/style.css
EmbeddingUtils.js
Plugin/DeepWikiVCP/package-lock.json
Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js
Plugin/vcp-dingtalk-adapter/CUsers617Desktoptools_response.json
server.js
一键启动服务器start_server.bat
```

## Protected P1 - Secret, Config, Runtime, And Data

Dry-run count: `128`

This bucket includes config/env-like files, `.claude/**`, `state/**`,
`dailynote/**`, `VCPChat/**`, SQLite files, and vector-store files. It is not a
cleanup target in A3.

Representative prefixes:

```text
Plugin/DingTalkCLI/state/**
state/channelHub/**
.claude/**
Plugin/DailyNote/dailynote/**
VCPChat/**
Plugin/ImageRatingManager/*.sqlite*
Plugin/ImageProcessor/*.sqlite*
VectorStore_bge1024/**
VectorStore_bge1024_backup_20260422-123654/**
```

## Generated G1 - Reports, Logs, And Cache

Dry-run count: `41`

This bucket is mostly generated reports/logs/cache. It is not covered by A2
archive and should not be cleaned as part of C1.

```text
docs/dingtalk-cli/reports/**        28
Plugin/FlashDeepSearch/log/**       11
Plugin/DoubaoGen/.doubao_api_cache.json
Plugin/Randomness/__pycache__/**
```

Future handling, if desired, should be a separate generated-artifact cleanup
package with its own archive or regenerate policy.

## Manifest M1 - Plugin Manifest Toggle Review

Dry-run count: `28`

This bucket contains plugin enable/disable marker changes such as
`plugin-manifest.json` and `plugin-manifest.json.block`. These are behavioral
switches and must not be cleaned mechanically.

## Retain Review R1 - Unarchived Manual Review

Dry-run count: `7`

These paths are not covered by A2 archive and do not fit the generated/runtime
or manifest buckets. Retain until separately reviewed.

```text
Plugin/UserAuth/code.bin
plugins/custom/reporting/sync_to_external_sheet_or_notion/src/index.js
server.js.bak_before_restore_channelhub
tests/photo-studio/external-sync.test.js
TVStxt/supertool.txt
TVStxt/ToolList.txt
vcp-panel-extension/webview-ui/assets/icon.svg
```

## Cleanup Approval Template

Required wording for C1 only:

```text
批准执行 A3-C1 清理：
target = A:/VCP/VCPToolBox
delete = docs/governance/DIRTY_WORKTREE_CLEANUP_PREFLIGHT_20260526.md C1 list
count = 39
precheck = current file SHA256 must match A2 ARCHIVE_MANIFEST.json
rollback = restore only deleted C1 files from A2 archive artifact
```

Required wording for C2 only:

```text
批准执行 A3-C2 tracked还原：
target = A:/VCP/VCPToolBox
restore = docs/governance/DIRTY_WORKTREE_CLEANUP_PREFLIGHT_20260526.md C2 list
count = 8
precheck = current file SHA256 must match A2 ARCHIVE_MANIFEST.json
rollback = restore C2 files from A2 archive artifact
```

Without explicit approval for a named package, do not clean anything.
