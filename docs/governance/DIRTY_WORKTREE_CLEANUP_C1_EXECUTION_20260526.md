# Dirty Worktree Cleanup C1 Execution - 2026-05-26

Scope: A3-C1 approved cleanup execution for dirty worktree
`A:/VCP/VCPToolBox`.

This record documents the approved deletion of archived untracked files only.
It did not perform tracked restore, `git clean`, `git reset`, recursive
deletion, branch changes, worktree removal, push, deploy, or production/runtime
changes.

## Source

- Target worktree: `A:/VCP/VCPToolBox`
- Target branch: `feature/latest-updates`
- Target HEAD: `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`
- Target upstream comparison after execution: `10 / 15`
- Dirty status count before execution: `260`
- Dirty status count after execution: `221`

## Archive Evidence

A2 archive artifact:

```text
A:/VCP/_archives/VCPToolBox/dirty-feature-latest-updates-20260526/
```

A2 manifest:

```text
A:/VCP/_archives/VCPToolBox/dirty-feature-latest-updates-20260526/ARCHIVE_MANIFEST.json
```

Verified after execution:

- Archive exists: `true`
- Manifest copied-file count: `47`
- Manifest hash mismatch count: `0`
- Manifest SHA256:
  `56612B88F302E9573D1D8D946451B4842A025FBC709C02831913EED50331A8FE`

## Pre-Delete Gate

Before deletion, each C1 path was checked for:

- full path inside `A:/VCP/VCPToolBox`
- untracked status
- file exists on disk
- membership in A2 manifest
- current SHA256 equals A2 manifest SHA256
- no overlap with A2 blocked paths
- no overlap with A3-C2 tracked-revert paths

Gate result:

```text
C1 count                  39
Unique C1 count           39
Inside workspace count    39
Status matched untracked  39
Exists count              39
In manifest count         39
Hash match count          39
Blocked overlap count     0
C2 overlap count          0
Failure count             0
```

## Execution

Deleted `39` exact file paths from `A:/VCP/VCPToolBox` using literal file paths.

The execution did not use:

- `git clean`
- `git reset`
- recursive deletion
- wildcard deletion
- branch checkout
- stash
- tracked restore

## Deleted Paths

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

## Post-Execution Verification

Verified:

- Deleted count: `39`
- C1 paths still existing on disk: `0`
- C1 paths still present in dirty status: `0`
- Dirty status count after execution: `221`
- Dirty worktree branch remained `feature/latest-updates`
- Dirty worktree HEAD remained
  `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`
- Dirty upstream comparison remained `10 / 15`
- A2 archive artifact remains available for rollback.

Not performed:

- No tracked modified file was restored.
- No A2 blocked path was touched.
- No protected secret/runtime/data file was touched.
- No generated report/log/cache bucket was touched.
- No plugin manifest toggle file was touched.
- No branch, tag, release, deploy, remote ref, live DingTalk/MCP/DWS command, or
  production write was performed.

## Rollback

To rollback A3-C1 only:

1. Restore only the `39` deleted paths from:
   `A:/VCP/_archives/VCPToolBox/dirty-feature-latest-updates-20260526/`
2. Preserve relative paths under `A:/VCP/VCPToolBox`.
3. Recompute SHA256 for restored files against `ARCHIVE_MANIFEST.json`.
4. Re-run `git status --short --untracked-files=all` in the dirty worktree.

Rollback should not touch tracked modified files, blocked paths, protected
runtime/data paths, generated report/log/cache paths, or manifest toggles.
