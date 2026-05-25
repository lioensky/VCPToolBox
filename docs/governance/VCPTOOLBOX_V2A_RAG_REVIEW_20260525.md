# Package V2A Review: RAG/Search Runtime

Review time: 2026-05-25 17:45 Asia/Shanghai.

Worktree reviewed: `A:/VCP/VCPToolBox`.

Baseline: current `origin/main` at `55b51ca`.

Scope:

- `EmbeddingUtils.js`
- `KnowledgeBaseManager.js`
- `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js`
- `diary-semantic-classifier.js`
- `scripts/rebuild_kb_once.js`

Sensitive/runtime paths were not read.

## 1. Comparison Result

Against current `origin/main`, the working tree differs in only three tracked RAG/search files:

| File | Comparison to `origin/main` |
| --- | --- |
| `EmbeddingUtils.js` | 12 insertions / 18 deletions |
| `KnowledgeBaseManager.js` | 85 insertions / 382 deletions |
| `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js` | 217 insertions / 647 deletions after ignoring EOL noise |

`diary-semantic-classifier.js` has no meaningful diff against `origin/main` in this V2A check.

`scripts/rebuild_kb_once.js` is untracked in `A:/VCP/VCPToolBox` and absent from this tracked-file diff. It can be reviewed separately as a one-off maintenance script.

## 2. Main Finding

Do not migrate the V2A tracked changes from `A:/VCP/VCPToolBox` into `main`.

Reason: current `origin/main` already contains newer RAG/search hardening. The V2A working-tree version would remove or weaken several newer main-line protections and integration points.

Observed downgrade risks:

- `EmbeddingUtils.js`
  - Removes `hasEmbeddingBackend` export used by current main-line RAG logic.
  - Loosens lower bounds around `TAG_VECTORIZE_CONCURRENCY` and `EMBEDDING_REQUEST_TIMEOUT_MS`.
  - Simplifies fallback hit recording compared with current main.
- `KnowledgeBaseManager.js`
  - Removes use of `hasEmbeddingBackend`.
  - Removes foreign-key cascade definitions from `pairwise_similarities`.
  - Removes vector blob decoding safeguards.
  - Removes chunked SQL helper usage and stale model cleanup blocks.
  - Reverts watcher/deferred embedding handling to an older shape.
  - Removes several deletion/index invalidation safeguards.
- `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js`
  - Large divergence from current main.
  - Removes current import of `getTargetForDiaryName` and replaces it with older/local embedding helper wiring.
  - Appears to roll back parts of Codex recall target handling and newer cache/embedding integration.

## 3. Decision

Status: reject tracked V2A migration into `main`.

Allowed follow-up:

- Review `scripts/rebuild_kb_once.js` as an isolated maintenance utility.
- If useful, port only the idea into current `main` with fresh implementation against `55b51ca`.

Blocked actions:

- Do not cherry-pick V2A files.
- Do not copy the working-tree versions over current `main`.
- Do not use this worktree as a source of truth for RAG/search runtime.

## 4. Next Recommendation

Continue with Package V2B or V2C:

- V2B: AdminPanel/operator UI review.
- V2C: external reporting and DingTalk review.

V2A can be considered closed for tracked files, with only `scripts/rebuild_kb_once.js` left as a low-priority isolated script review.
