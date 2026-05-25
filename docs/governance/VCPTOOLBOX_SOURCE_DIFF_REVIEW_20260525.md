# Source Diff Review: A:/VCP/VCPToolBox

Review time: 2026-05-25 17:40 Asia/Shanghai.

Scope: read-only source/documentation candidate review for `A:/VCP/VCPToolBox`.

Excluded from this review: `config.env`, auth files, sqlite databases, vector stores, runtime `state/`, chat/user data, generated logs, and local agent memory.

## 1. Current Branch State

- Worktree path: `A:/VCP/VCPToolBox`
- Branch: `feature/latest-updates`
- HEAD: `a82c8f2`
- Upstream: `origin/feature/latest-updates`
- Upstream comparison: behind/ahead `15/10`
- It is not the latest `main`; latest `origin/main` is `55b51ca`.

Local commits on this branch include feature isolation and photo-studio migration work:

- `13fd531` Codex memory MCP batch 1 candidate
- `472d6f3` dingtalk cli weeklyreport batch 2 candidate
- `f59fe27` AI image workflow batch 3 candidate
- `7c4e291` photo studio guide contract rebaseline
- `e8c00b3` photo studio p1a migration
- `341c1c7` photo studio p2 migration
- `30ed06a` photo studio p3 migration
- `941fc63` photo studio p5 migration
- `23c6364` photo studio p6 migration
- `a82c8f2` photo studio p7 migration

## 2. Tracked Source Candidates

The tracked source/doc subset contains 17 changed files:

| Area | Files | Size |
| --- | ---: | --- |
| `AdminPanel/*` | 3 | 95 changed lines |
| Core RAG/search files | 4 | 360 changed lines |
| Plugin/runtime source | 5 | 182 changed lines |
| Docs/tests/scripts | 5 | 286 changed lines |

Exact `git diff --stat` total for this source subset:

- 17 files changed
- 748 insertions
- 138 deletions

Tracked candidates:

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

Recommendation: do not migrate as one batch. Split by domain and compare each domain against current `origin/main`.

## 3. Untracked Source / Module Candidates

Potential source candidates outside runtime/sensitive paths:

| Path | File count | Initial classification |
| --- | ---: | --- |
| `Plugin/DingTalkTable/` | 7 | possible new plugin |
| `Plugin/CodexMemoryBridge/` | 4 | bridge/runtime candidate, review carefully |
| `modules/toolExecution.js` | 1 | possible backend execution route support |
| `routes/toolExecutionRoutes.js` | 1 | possible backend route support |
| `tests/channelHub-hardening.test.js` | 1 | possible test candidate |
| `tests/messageProcessor.test.js` | 1 | possible test candidate |
| `vcp-panel-extension/` | 4 | separate extension project |
| `scripts/rebuild_kb_once.js` | 1 | maintenance script candidate |
| `fix_session_store.js` | 1 | one-off repair script candidate |

Recommendation: keep these out of branch cleanup until each has a destination decision: migrate to `main`, archive outside Git, or discard.

## 4. Suggested Review Packages

Package V2A: RAG/search/runtime source review

- `EmbeddingUtils.js`
- `KnowledgeBaseManager.js`
- `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js`
- `diary-semantic-classifier.js`
- `scripts/rebuild_kb_once.js`

Package V2B: AdminPanel and operator UI review

- `AdminPanel/index.html`
- `AdminPanel/script.js`
- `AdminPanel/style.css`
- `docs/ADMINPANEL_DEVELOPMENT.md`
- `vcp-panel-extension/**`

Package V2C: external/reporting and DingTalk review

- `plugins/custom/reporting/sync_to_external_sheet_or_notion/src/index.js`
- `tests/photo-studio/external-sync.test.js`
- `Plugin/DingTalkTable/**`

Package V2D: tool execution route review

- `modules/toolExecution.js`
- `routes/toolExecutionRoutes.js`
- `tests/messageProcessor.test.js`
- `tests/channelHub-hardening.test.js`

Package V2E: image/plugin source review

- `Plugin/DeepWikiVCP/**`
- `Plugin/ZImageGen/ZImageGen.mjs`
- `Plugin/ZImageGen2/ZImageGen.mjs`
- `Plugin/vcp-onebot-adapter/README.md`

## 5. Current Recommendation

Do not delete `A:/VCP/VCPToolBox`.

Do not merge this worktree wholesale into `main`.

Recommended next safe task: Package V2A read-only comparison against current `origin/main`, because it touches core RAG/search runtime and may overlap with the already-updated main branch.
