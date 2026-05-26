# Dirty Worktree Archive Preflight - 2026-05-26

Scope: A2 preflight for dirty worktree `A:/VCP/VCPToolBox`.

This document is a dry-run/preflight artifact only. It does not authorize
creating an archive, copying files, hashing contents, deleting files, cleaning
the worktree, changing branches, pushing, or touching production/runtime state.

## Current Verified State

- Control worktree: `A:/VCP/VCPToolBox-prod-stable`
- Control branch: `main`
- Control `main` / `origin/main`: synchronized at
  `f09cbccbeada55c8bad3ea8060c7b9272f6a148e`
- Dirty worktree: `A:/VCP/VCPToolBox`
- Dirty branch: `feature/latest-updates`
- Dirty HEAD: `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`
- Dirty upstream comparison: `10 / 15`
- A1 archive candidates reviewed: `56`
- A1 archive candidates existing on disk: `56`
- A1 archive candidates missing on disk: `0`

## Preflight Result

Result: A2 execution is not approved and should not run yet.

Reasons:

- `8` A1 candidates matched sensitive/config-like patterns.
- `2` A1 candidates had path/status matching ambiguity.
- One candidate appears in both blocked categories, so the unique excluded set
  is `9` paths.
- The strict executable inclusion set is therefore reduced to `47` paths.
- Destination remains a proposal only and has not been approved.

## Proposed Destination

Not approved yet:

```text
A:/VCP/_archives/VCPToolBox/dirty-feature-latest-updates-20260526/
```

Execution must not create this directory until the user explicitly approves A2
with destination, inclusion list, exclusion rules, dry-run count, scan results,
and rollback.

## Strict Include List For A2

Dry-run count: `47`

These are the only paths that passed this preflight's path-level filters.

```text
.agent_board/CHECKPOINT.md
.agent_board/DECISIONS.md
.agent_board/HANDOFF.md
.agent_board/RUN_STATE.md
.agent_board/TASK_QUEUE.md
.agent_board/VALIDATION_LOG.md
Agent/Noir Architect.txt
Agent/Nova.txt
diary-semantic-classifier.js
docs/ADMINPANEL_DEVELOPMENT.md
docs/interaction-middleware/VCPToolBox to dingtalk-workspace-cli.md
docs/interaction-middleware/VCPToolBox to dingtalk-workspace-cli11.md
docs/VCPToolBox to dingtalk-workspace-cli.md
fix_session_store.js
KnowledgeBaseManager.js
modules/toolExecution.js
Plugin/_PluginDocTemplate/docs/01-quickstart.md
Plugin/_PluginDocTemplate/docs/02-config.md
Plugin/_PluginDocTemplate/docs/03-release-checklist.md
Plugin/_PluginDocTemplate/README.md
Plugin/AIGentPrompt/test_rag_result.md
Plugin/CodexMemoryBridge/codex-memory-bridge.fixed.js
Plugin/CodexMemoryBridge/codex-memory-bridge.new.js
Plugin/DeepWikiVCP/deepwiki_vcp.js
Plugin/DingTalkTable/DingTalkTable.js
Plugin/DingTalkTable/lpan.txt
Plugin/DingTalkTable/plan.md
Plugin/DingTalkTable/README.md
Plugin/vcp-dingtalk-adapter/src/adapters/vcp/client.js.patch
Plugin/vcp-onebot-adapter/docs/00-index.md
Plugin/vcp-onebot-adapter/docs/01-quickstart.md
Plugin/vcp-onebot-adapter/docs/02-config.md
Plugin/vcp-onebot-adapter/docs/03-release-checklist.md
Plugin/vcp-onebot-adapter/README.md
Plugin/ZImageGen/ZImageGen.mjs
Plugin/ZImageGen2/ZImageGen.mjs
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

## Blocked A1 Candidates

These candidates must be excluded from A2 unless a later review explicitly
clears or sanitizes them.

Sensitive/config-like pattern matches:

```text
AdminPanel/index.html
AdminPanel/script.js
AdminPanel/style.css
EmbeddingUtils.js
Plugin/DeepWikiVCP/package-lock.json
Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js
Plugin/vcp-dingtalk-adapter/CUsers617Desktoptools_response.json
server.js
```

Path/status ambiguity:

```text
Plugin/vcp-dingtalk-adapter/CUsers617Desktoptools_response.json
一键启动服务器start_server.bat
```

`Plugin/vcp-dingtalk-adapter/CUsers617Desktoptools_response.json` appears in
both blocked categories above; unique blocked paths total `9`.

No candidate in the strict include list had conflict markers in this preflight.

## Exclusion Rules

A2 must exclude these classes:

```text
**/config.env
.env and env-like files
*.sqlite*
VectorStore_*
state/**
.claude/**
VCPChat/**
Plugin/*/state/**
Plugin/*/log/**
Plugin/*/dailynote/**
__pycache__/**
generated DingTalk reports
plugin manifest toggle pairs
files with unresolved conflict markers
files matching sensitive/config-like patterns unless separately sanitized
paths with status/path encoding ambiguity
```

## Rollback Plan

If A2 is later approved and produces a bad archive artifact:

1. Verify the archive path is outside both repositories.
2. Verify the archive path equals the explicitly approved destination.
3. Delete only that generated archive directory or archive file.
4. Do not delete anything inside `A:/VCP/VCPToolBox`.
5. Re-run `git status --short --untracked-files=all` in both worktrees.

## A2 Approval Template

Required wording for execution:

```text
批准执行 A2 归档：
destination = A:/VCP/_archives/VCPToolBox/dirty-feature-latest-updates-20260526/
include = docs/governance/DIRTY_WORKTREE_ARCHIVE_PREFLIGHT_20260526.md strict include list
exclude = docs/governance/DIRTY_WORKTREE_ARCHIVE_PREFLIGHT_20260526.md exclusion rules
dry-run count = 47
rollback = delete only the generated archive artifact at the approved destination
```

Without that explicit approval, stop at this preflight.
