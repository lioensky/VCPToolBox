# Dirty Worktree Audit: A:/VCP/VCPToolBox

Audit time: 2026-05-25 17:35 Asia/Shanghai.

Scope: read-only audit of `A:/VCP/VCPToolBox`.

This document does not authorize deleting files, resetting the worktree, removing the worktree, deleting branches, or pushing remote refs.

## 1. Summary

`A:/VCP/VCPToolBox` is not the latest `main` worktree.

Verified state:

- Worktree path: `A:/VCP/VCPToolBox`
- Branch: `feature/latest-updates`
- HEAD: `a82c8f2`
- Upstream: `origin/feature/latest-updates`
- Upstream comparison: behind/ahead `15/10`
- Dirty entries from `git status --short -uall`: `254`
- Tracked modified entries: `28`
- Tracked deleted entries: `13`
- Untracked entries: `213`

Conclusion: treat this worktree as user-owned and high-risk. Do not delete, reset, clean, switch branches, or overwrite files before a separate preservation decision.

## 2. Top-Level Dirty Distribution

Largest affected top-level areas:

| Area | Entries | Initial classification |
| --- | ---: | --- |
| `Plugin/` | 118 | mixed: configs, runtime data, plugin source, manifests, generated logs |
| `docs/` | 32 | likely docs/reports, needs review |
| `VectorStore_bge1024/` | 21 | runtime/vector database, do not delete without backup decision |
| `VectorStore_bge1024_backup_20260422-123654/` | 21 | local backup/runtime data, do not delete without backup decision |
| `state/` | 17 | runtime state, do not delete without backup decision |
| `.claude/` | 10 | local agent memory/settings, user-owned |
| `VCPChat/` | 5 | user/runtime data |
| `vcp-panel-extension/` | 4 | untracked local project/module |
| `AdminPanel/` | 3 | tracked frontend edits |
| `tests/` | 3 | tracked/untracked test edits |

## 3. High-Risk / Sensitive Paths

The audit saw path names only; file contents were not read.

Treat these as sensitive or user-owned:

- `Plugin/DailyNote/config.env`
- `Plugin/DailyNoteWrite/config.env`
- `Plugin/FileOperator/config.env`
- `Plugin/UserAuth/code.bin`
- `Plugin/ImageProcessor/*.sqlite*`
- `Plugin/ImageRatingManager/*.sqlite*`
- `VectorStore_bge1024/**`
- `VectorStore_bge1024_backup_20260422-123654/**`
- `VCPChat/AppData/**`
- `state/**`
- `.claude/**`
- `Plugin/DailyNote/dailynote/**`
- `Plugin/DingTalkCLI/state/**`
- `Plugin/FlashDeepSearch/log/**`

Governance rule: these paths should not be printed in full content, copied into docs, committed, deleted, or overwritten without a dedicated approval and backup/ignore decision.

## 4. Source / Candidate Code Changes

Tracked code or doc changes that may contain real work and deserve review:

- `AdminPanel/index.html`
- `AdminPanel/script.js`
- `AdminPanel/style.css`
- `EmbeddingUtils.js`
- `KnowledgeBaseManager.js`
- `Plugin/DeepWikiVCP/deepwiki_vcp.js`
- `Plugin/DeepWikiVCP/plugin-manifest.json`
- `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js`
- `Plugin/ZImageGen/ZImageGen.mjs`
- `Plugin/ZImageGen2/ZImageGen.mjs`
- `Plugin/vcp-onebot-adapter/README.md`
- `diary-semantic-classifier.js`
- `docs/ADMINPANEL_DEVELOPMENT.md`
- `plugins/custom/reporting/sync_to_external_sheet_or_notion/src/index.js`
- `server.js`
- `tests/photo-studio/external-sync.test.js`
- `start_server.bat`

Notable untracked code/project candidates:

- `Plugin/DingTalkTable/**`
- `Plugin/CodexMemoryBridge/*.js`
- `modules/toolExecution.js`
- `routes/toolExecutionRoutes.js`
- `tests/channelHub-hardening.test.js`
- `tests/messageProcessor.test.js`
- `vcp-panel-extension/**`
- `scripts/rebuild_kb_once.js`
- `fix_session_store.js`

These should be compared against current `origin/main` before deciding whether to migrate, archive, or discard.

## 5. Plugin Manifest Toggles

There are tracked deletions and untracked opposite manifest/block files, suggesting local plugin enable/disable toggles.

Tracked deletions include:

- `Plugin/DailyNoteManager/plugin-manifest.json.block`
- `Plugin/GeminiImageGen/plugin-manifest.json`
- `Plugin/GoogleSearch/plugin-manifest.json`
- `Plugin/GrokVideo/plugin-manifest.json`
- `Plugin/JapaneseHelper/plugin-manifest.json`
- `Plugin/NanoBananaGen2/plugin-manifest.json`
- `Plugin/NanoBananaGenOR/plugin-manifest.json`
- `Plugin/NovelAIGen/plugin-manifest.json`
- `Plugin/PyCameraCapture/plugin-manifest.json`
- `Plugin/SnowBridge/plugin-manifest.json`
- `Plugin/SunoGen/plugin-manifest.json`
- `Plugin/SynapsePusher/plugin-manifest.json.block`
- `Plugin/ToolBoxFoldMemo/plugin-manifest.json.block`

Related untracked files include corresponding `.block` or unblocked manifests for several plugins.

Governance rule: do not normalize these manifest toggles automatically. Plugin enablement can affect runtime capability and must be handled as a separate reviewed package.

## 6. Recommended Handling Packages

Package V1: preserve-only snapshot plan

- Goal: decide whether to archive this worktree before cleanup.
- Action type: planning/read-only unless explicitly approved.
- Suggested output: list of candidate files to save, ignore, migrate, or drop.

Package V2: source-diff review

- Compare source candidates against `origin/main`.
- Exclude configs, databases, vector stores, logs, and state.
- Decide which source changes are already absorbed, still valuable, or obsolete.

Package V3: sensitive/runtime quarantine

- Classify config/env, auth, sqlite, vector store, state, logs, and chat data.
- Decide backup location or retention rule.
- Requires explicit approval before moving or deleting anything.

Package V4: plugin manifest toggle review

- Review manifest/block flips as runtime capability changes.
- Decide whether they belong in main, local config, or a local operator profile.

Package V5: worktree closure

- Only after V1-V4 are complete.
- Requires explicit approval.
- Preferred deletion path, if approved later: preserve needed files first, then use Git worktree tooling rather than raw folder deletion.

## 7. Current Recommendation

Do not delete `A:/VCP/VCPToolBox` now.

Next safe action: run Package V2 source-diff review while explicitly excluding sensitive/runtime paths.

## 8. 2026-05-26 Read-Only Refresh

Refresh time: 2026-05-26 Asia/Shanghai.

Scope stayed read-only for `A:/VCP/VCPToolBox`; no files were edited, deleted, moved, reset, cleaned, or checked out in that worktree.

Verified state:

- Worktree path: `A:/VCP/VCPToolBox`
- Branch: `feature/latest-updates`
- HEAD: `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`
- Upstream: `origin/feature/latest-updates`
- Upstream comparison: ahead/behind `10/15`
- Dirty entries from `git status --short -uall`: `260`
- Tracked entries: `41`
- Untracked entries: `219`
- Modified-like entries: `28`
- Deleted-like entries: `13`

Largest affected top-level areas:

| Area | Entries | 2026-05-26 handling |
| --- | ---: | --- |
| `Plugin/` | 118 | mixed; includes source, manifests, examples, caches, logs, and plugin state |
| `docs/` | 32 | review as documentation artifacts, not as implementation proof |
| `VectorStore_bge1024_backup_20260422-123654/` | 21 | preserve/quarantine only |
| `VectorStore_bge1024/` | 21 | preserve/quarantine only |
| `state/` | 17 | runtime state; preserve/quarantine only |
| `.claude/` | 10 | local agent/user-owned state |
| `.agent_board/` | 6 | historical local work rail |
| `VCPChat/` | 5 | user/runtime data |
| `vcp-panel-extension/` | 4 | separate untracked local module candidate |
| `AdminPanel/` | 3 | tracked UI changes already need source-diff review before any intake |
| `tests/` | 3 | mixed tracked/untracked test edits |

Additional read-only checks:

- Conflict marker scan found unresolved merge markers in `plugins/custom/reporting/sync_to_external_sheet_or_notion/src/index.js` and `tests/photo-studio/external-sync.test.js`.
- `git diff --check` over non-runtime/non-database paths failed on trailing whitespace plus those conflict markers.
- Secret-like key patterns were detected in config example files, including `Plugin/FlashDeepSearch/config.env.example`; values must not be copied into docs or migrated as-is.
- Line-ending warnings were observed on several tracked files; do not treat those dirty diffs as clean implementation changes without a separate review.

2026-05-26 intake decision:

- Do not absorb the dirty worktree wholesale.
- Do not absorb external reporting/photo-studio sync files as-is because they contain conflict markers.
- Do not absorb config examples as-is until all key-like values are sanitized to placeholders.
- Do not normalize plugin manifest toggles automatically.
- Treat vector stores, sqlite files, auth binaries, chat data, `.claude/`, logs, caches, and `state/` as preserve/quarantine material, not source migration material.
- Treat `vcp-panel-extension/`, `Plugin/DingTalkTable/`, `Plugin/CodexMemoryBridge/*.js`, and related docs as separate candidate packages only if a later scoped review is requested.

Current recommendation after refresh:

1. Keep `A:/VCP/VCPToolBox` untouched.
2. If continuing locally, produce a preservation manifest that classifies files into `preserve`, `candidate-review`, `reject-as-is`, and `quarantine-sensitive`.
3. Any copy, archive, deletion, reset, branch movement, or remote write still requires explicit approval.
