# Upstream Absorb R15C Geodesic Tuning Preflight - 2026-06-03

## Scope

This preflight reviews the backend geodesic tuning portion of upstream commit `d6f051f5 统一浪潮调参传入方式`.

Local target:

- Repository: `JENN2046/VCPToolBox`
- Branch: `main`
- Baseline: `c0a7a32f Merge pull request #119 from JENN2046/codex/r15b-ragdiary-safe-path-display-20260603`
- Upstream source commit: `d6f051f5 统一浪潮调参传入方式`

This document is read-only classification plus split guidance. It does not absorb code.

## Already Absorbed

| Package | Status | Notes |
| --- | --- | --- |
| R15A RAGDiary time date display | `absorbed` via #118 | Local implementation includes review fixes for parsed-date sort keys and unbracketed diary dates. |
| R15B safe RAGDiary path display | `absorbed` via #119 | Local implementation is formatter-only and suppresses unsafe paths, including control-character injection. |

R15C must not overwrite or regress the R15A/R15B formatter changes in `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js`.

## Read-Only Commands Used

```powershell
git status -sb
git branch --show-current
git log --oneline --decorate -n 8
git show --stat --name-status --find-renames --format=fuller d6f051f5
git show --numstat --format=oneline d6f051f5
git show --unified=80 --format=medium d6f051f5 -- KnowledgeBaseManager.js Plugin/LightMemo/LightMemo.js Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js TagMemoEngine.js
git show --unified=40 --format=medium d6f051f5 -- AdminPanel-Vue/src/features/rag-tuning/metadata.ts AdminPanel-Vue/src/views/RagTuning.vue
rg -n "geodesicRerank|alpha|minGeoSamples" rag_params.json config.env.example docs tests KnowledgeBaseManager.js TagMemoEngine.js Plugin\LightMemo\LightMemo.js Plugin\RAGDiaryPlugin\RAGDiaryPlugin.js
```

## Upstream Surface

`d6f051f5` touches:

- `KnowledgeBaseManager.js`
- `Plugin/LightMemo/LightMemo.js`
- `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js`
- `TagMemoEngine.js`
- `AdminPanel-Vue/src/features/rag-tuning/metadata.ts`
- `AdminPanel-Vue/src/views/RagTuning.vue`
- many `AdminPanel-Vue/dist/*` hashed build artifacts

The meaningful backend behavior is:

- Route `KnowledgeBaseManager.geodesicRerank.alpha` and `minGeoSamples` from `rag_params.json` through RAGDiary, LightMemo, and KnowledgeBaseManager entry points.
- Let `TagMemoEngine.geodesicRerank()` read configured geodesic defaults from `ragParams` when explicit options are absent.
- Treat missing invalid geodesic tuning values as a safe fallback to original candidate order.

## Existing Local Foundation

Current local state:

- `rag_params.json` already contains `KnowledgeBaseManager.geodesicRerank.alpha = 0.5`.
- `rag_params.json` already contains `KnowledgeBaseManager.geodesicRerank.minGeoSamples = 4`.
- `RAGDiaryPlugin` already reads `this.ragParams?.KnowledgeBaseManager?.geodesicRerank`.
- `LightMemo` already reads `this.vectorDBManager.ragParams?.KnowledgeBaseManager?.geodesicRerank`.
- `KnowledgeBaseManager` already exposes `geodesicRerank(candidates, options = {})`.
- `TagMemoEngine` is a class export and can be tested with stub DB/tag index state.

This means a backend-only adapted package can avoid frontend and dist files.

## Risk Notes

- Raw `d6f051f5` mixes backend runtime changes, frontend source UI, and built assets. It is too broad for direct absorb.
- Removing hardcoded `0.3/4` defaults changes missing-config behavior. That behavior must be explicit and covered by tests.
- If `TagMemoEngine.geodesicRerank()` falls back to original order on invalid config, callers must not treat that as an error or mutate candidates.
- RAGDiary, LightMemo, and KnowledgeBaseManager must all pass geodesic tuning consistently; changing only one path would create split behavior.
- The frontend geodesic tuning panel is useful but belongs to a separate package, because it changes UI and includes build-artifact pressure.
- `AdminPanel-Vue/dist/*` must remain out of R15C.

## Classification

| Item | Decision | Reason |
| --- | --- | --- |
| Raw upstream `d6f051f5` | `reject raw absorb` | It mixes backend, frontend source, and dist artifacts. |
| Backend-only geodesic tuning propagation | `allow narrow adapted package` | The configuration exists locally and the code change can be isolated to backend runtime plus targeted tests. |
| Frontend geodesic tuning UI source | `defer` | UI work should be a separate package with frontend validation. |
| `AdminPanel-Vue/dist/*` artifacts | `reject` | Build artifacts are not part of backend governance intake. |

## Recommended R15C Package Shape

If R15C proceeds, keep it backend-only:

Scope:

- `KnowledgeBaseManager.js`
- `Plugin/LightMemo/LightMemo.js`
- `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js`
- `TagMemoEngine.js`
- targeted tests only

Keep out:

- `AdminPanel-Vue/*`
- `AdminPanel-Vue/dist/*`
- `rag_params.json`
- real `.env`, `config.env`, runtime cache, state, logs, generated artifacts, or operator data
- unrelated RAG, path display, date display, or frontend tuning changes

Implementation guidance:

- Preserve R15A/R15B formatter behavior.
- Prefer explicit caller options when provided.
- Fall back to `ragParams.KnowledgeBaseManager.geodesicRerank` when explicit options are absent.
- If `alpha` or `minGeoSamples` is missing or invalid inside `TagMemoEngine.geodesicRerank()`, return candidates in original order.
- Clamp valid `alpha` to `[0, 1]`.
- Floor and bound valid `minGeoSamples` to at least `1`.
- Do not mutate `rag_params.json`.

Suggested targeted tests:

- `KnowledgeBaseManager.geodesicRerank()` passes configured defaults to `tagMemoEngine`.
- Explicit `alpha` / `geoAlpha` options override configured defaults.
- Search-path geodesic calls pass configured defaults when search options omit them.
- `TagMemoEngine.geodesicRerank()` falls back to original candidate order when config is missing or invalid.
- `TagMemoEngine.geodesicRerank()` clamps valid alpha and normalizes `minGeoSamples`.
- RAGDiary and LightMemo option construction no longer hardcode `0.3/4`.

Suggested validation:

```powershell
node --check KnowledgeBaseManager.js
node --check TagMemoEngine.js
node --check Plugin\LightMemo\LightMemo.js
node --check Plugin\RAGDiaryPlugin\RAGDiaryPlugin.js
node --test tests\knowledge-base-vector-reuse.test.js
git diff --check
```

## Decision

Do not directly absorb upstream `d6f051f5`.

Proceed with an adapted backend-only R15C narrow branch if the implementation follows the package shape above.

If backend behavior cannot be tested without real vector databases, external embedding calls, frontend work, or dist artifacts, reclassify R15C as `defer`.

## Stop Conditions

Stop and reclassify as `defer` if implementation requires:

- touching frontend source or build artifacts
- modifying `rag_params.json` or private config
- changing RAGDiary/R15A/R15B result formatting
- starting services or using real embedding providers
- reading or writing runtime/cache/state/log/operator data
- broad geodesic algorithm changes beyond parameter propagation and validation
- untested changes to search behavior
