# Dirty Worktree Archive Plan - 2026-05-26

Scope: A1 archive planning for dirty worktree `A:/VCP/VCPToolBox`.

This is a path-level plan only. It does not authorize creating an archive,
copying files, hashing contents, deleting files, cleaning the worktree, changing
branches, pushing, or touching production/runtime state.

## Current Verified State

- Control worktree: `A:/VCP/VCPToolBox-prod-stable`
- Control branch: `main`
- Control `main` / `origin/main`: synchronized at
  `79a9ea420e458b41b8fa6bee1119c2a30dec6ec4`
- Dirty worktree: `A:/VCP/VCPToolBox`
- Dirty branch: `feature/latest-updates`
- Dirty HEAD: `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`
- Dirty upstream: `origin/feature/latest-updates`
- Dirty upstream comparison: `10 / 15`
- Dirty entries: `260`
- Tracked dirty entries: `41`
- Untracked entries: `219`
- Files with conflict markers by filename scan: `4`
- Files matching sensitive/config-like patterns by filename-only scan: `73`

## A1 Classification Summary

| Class | Count | Meaning |
| --- | ---: | --- |
| archive candidate | `56` | source/doc-looking paths that may be considered later |
| manual review | `40` | manifest toggles, config examples, conflict-marked files, binaries, or unusual assets |
| default exclude | `164` | runtime/state/generated/cache/database/vector/report paths |

Risk category counts from the path/status scan:

| Category | Count |
| --- | ---: |
| env/config-like paths | `6` |
| sqlite database paths | `12` |
| vector-store paths | `42` |
| runtime/user-state paths | `75` |
| log/cache paths | `19` |
| plugin manifest toggles | `28` |
| generated report paths | `28` |
| source/doc-looking paths | `180` |

## Proposed Archive Destination Template

No destination is approved yet.

If A2 is later approved, use a destination outside both repositories:

```text
A:/VCP/_archives/VCPToolBox/dirty-feature-latest-updates-20260526/
```

The final destination must be confirmed explicitly before any archive command is
run.

## Archive Candidate Paths

These paths may be candidates for a later A2 archive only after exact inclusion
approval and a sensitive-pattern scan over the inclusion list.

```text
.agent_board/CHECKPOINT.md
.agent_board/DECISIONS.md
.agent_board/HANDOFF.md
.agent_board/RUN_STATE.md
.agent_board/TASK_QUEUE.md
.agent_board/VALIDATION_LOG.md
AdminPanel/index.html
AdminPanel/script.js
AdminPanel/style.css
Agent/Noir Architect.txt
Agent/Nova.txt
diary-semantic-classifier.js
docs/ADMINPANEL_DEVELOPMENT.md
docs/interaction-middleware/VCPToolBox to dingtalk-workspace-cli.md
docs/interaction-middleware/VCPToolBox to dingtalk-workspace-cli11.md
docs/VCPToolBox to dingtalk-workspace-cli.md
EmbeddingUtils.js
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
Plugin/DeepWikiVCP/package-lock.json
Plugin/DingTalkTable/DingTalkTable.js
Plugin/DingTalkTable/lpan.txt
Plugin/DingTalkTable/plan.md
Plugin/DingTalkTable/README.md
Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js
Plugin/vcp-dingtalk-adapter/CUsers617Desktoptools_response.json
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
server.js
start_server.bat
tests/channelHub-hardening.test.js
tests/messageProcessor.test.js
update.sh
VCP_ANALYSIS.md
VCP_ARCHITECTURE_MASTER.md
vcp-panel-extension/extension.js
vcp-panel-extension/package.json
vcp-panel-extension/README.md
一键启动服务器start_server.bat
```

Notes:

- `.agent_board/**` is a candidate only for preserving local dirty-worktree
  governance context, not for source intake.
- The VCP panel extension remains a product proposal candidate, not a direct
  source intake.
- Tool execution route files remain security-sensitive and should not be used
  for implementation without a separate design review.

## Manual Review Paths

These paths are not automatically includable. They require an exact decision
before A2.

```text
config.env.example
Plugin/DailyNoteManager/plugin-manifest.json
Plugin/DailyNoteManager/plugin-manifest.json.block
Plugin/DailyNoteWrite/config.env
Plugin/DeepWikiVCP/plugin-manifest.json
Plugin/DingTalkTable/config.env.example
Plugin/DingTalkTable/plugin-manifest.json
Plugin/FileOperator/config.env
Plugin/FlashDeepSearch/config.env.example
Plugin/GeminiImageGen/plugin-manifest.json
Plugin/GeminiImageGen/plugin-manifest.json.block
Plugin/GoogleSearch/plugin-manifest.json
Plugin/GoogleSearch/plugin-manifest.json.block
Plugin/GrokVideo/plugin-manifest.json
Plugin/GrokVideo/plugin-manifest.json.block
Plugin/JapaneseHelper/plugin-manifest.json
Plugin/JapaneseHelper/plugin-manifest.json.block
Plugin/NanoBananaGen2/plugin-manifest.json
Plugin/NanoBananaGen2/plugin-manifest.json.block
Plugin/NanoBananaGenOR/plugin-manifest.json
Plugin/NanoBananaGenOR/plugin-manifest.json.block
Plugin/NovelAIGen/plugin-manifest.json
Plugin/NovelAIGen/plugin-manifest.json.block
Plugin/PyCameraCapture/plugin-manifest.json
Plugin/PyCameraCapture/plugin-manifest.json.block
Plugin/SnowBridge/plugin-manifest.json
Plugin/SnowBridge/plugin-manifest.json.block
Plugin/SunoGen/plugin-manifest.json
Plugin/SunoGen/plugin-manifest.json.block
Plugin/SynapsePusher/plugin-manifest.json
Plugin/SynapsePusher/plugin-manifest.json.block
Plugin/ToolBoxFoldMemo/plugin-manifest.json
Plugin/ToolBoxFoldMemo/plugin-manifest.json.block
Plugin/UserAuth/code.bin
plugins/custom/reporting/sync_to_external_sheet_or_notion/src/index.js
server.js.bak_before_restore_channelhub
tests/photo-studio/external-sync.test.js
TVStxt/supertool.txt
TVStxt/ToolList.txt
vcp-panel-extension/webview-ui/assets/icon.svg
```

Manual-review reasons:

- Manifest toggle pairs can change enabled capabilities.
- `config.env` and config examples require separate sanitization review.
- Conflict-marked files must not be archived as implementation evidence.
- Binary/auth-like files are excluded unless a backup-specific approval says
  otherwise.
- Unusual static assets require exact inclusion approval.

## Default Exclusion Rules

Exclude these classes by default:

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
```

Representative excluded groups:

```text
.claude/**
docs/dingtalk-cli/reports/**
Plugin/DailyNote/config.env
Plugin/DailyNote/dailynote/**
Plugin/DingTalkCLI/state/**
Plugin/FlashDeepSearch/log/**
Plugin/ImageProcessor/*.sqlite*
Plugin/ImageRatingManager/*.sqlite*
state/**
VCPChat/**
VectorStore_bge1024/**
VectorStore_bge1024_backup_20260422-123654/**
```

## A2 Preconditions

A2 archive execution remains blocked until all of these are explicitly
approved:

1. Exact destination path.
2. Exact inclusion list.
3. Exact exclusion rules.
4. Dry-run file count.
5. Sensitive-pattern scan result over the inclusion list.
6. Rollback path for removing a bad archive artifact.

## Non-Goals

- Do not use this plan to merge dirty files into `main`.
- Do not use this plan to clean the dirty worktree.
- Do not use this plan to delete branches or remote refs.
- Do not use this plan to preserve secrets, runtime databases, logs, or user
  state unless a separate backup decision explicitly approves that scope.
