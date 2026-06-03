# Upstream Absorb R15B RAGDiary Path Display Preflight - 2026-06-03

## Scope

This preflight reviews upstream commit `fcfcc918 优化路径显示` after R15A has already absorbed the preceding RAGDiary time date display robustness work.

Local target:

- Repository: `JENN2046/VCPToolBox`
- Branch: `main`
- Baseline: `6c5a8a1f Merge pull request #118 from JENN2046/codex/r15a-ragdiary-date-format-20260603`
- Upstream source commit: `fcfcc918 优化路径显示`

This document is read-only classification plus split guidance. It does not absorb code.

## Already Absorbed

| Package | Status | Notes |
| --- | --- | --- |
| R15A RAGDiary time date display | `absorbed` via #118 | Local implementation includes parsed-date sorting fallback and unbracketed diary date parsing fixes from review. |

Because local `main` contains safer adapted R15A behavior, raw diffs around `formatCombinedTimeAwareResults()` must not be copied back without reconciling those review fixes.

## Read-Only Commands Used

```powershell
git status -sb
git branch --show-current
git log --oneline --decorate -n 8
git show --stat --name-status --find-renames --format=fuller fcfcc918
git show --unified=120 --format=medium fcfcc918 -- Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js
rg -n "fullPath|sourceFile|path:|_cleanResultsForBroadcast|formatStandardResults|formatCombinedTimeAwareResults|formatGroupRAGResults|_buildCodexRecallAuditPayload" Plugin\RAGDiaryPlugin\RAGDiaryPlugin.js tests\codex-memory-recall.test.js
rg -n "fullPath|sourceFile|filePath|path:" KnowledgeBaseManager.js Plugin\RAGDiaryPlugin\RAGDiaryPlugin.js TagMemoEngine.js tests\knowledge-base-vector-reuse.test.js tests\codex-memory-recall.test.js
```

## Upstream Surface

`fcfcc918` changes only:

- `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js`

The meaningful upstream behavior is:

- Add `_formatResultPathLine(result)`.
- Add `_formatMemoryEntry(result, options)`.
- Append a path line to standard, time-aware, and group RAG formatted memory entries.
- Preserve `fullPath` and `sourceFile` in `_cleanResultsForBroadcast()`.

## Existing Local Foundation

Current local path-related behavior:

- `KnowledgeBaseManager._searchSpecificIndex()` hydrates `fullPath` from `files.path`, which is normally a knowledge-base-relative path.
- `KnowledgeBaseManager._searchSpecificIndex()` also sets `sourceFile` to `path.basename(row.sourceFile)`.
- `KnowledgeBaseManager._searchAllIndices()` currently exposes only the basename in `sourceFile`, not `fullPath`.
- `KnowledgeBaseManager.getChunksByFilePaths()` exposes `sourceFile` as `f.path`, a knowledge-base-relative path used by `::Time`.
- `RAGDiaryPlugin._extractRecallSourceFiles()` already supports `fullPath`, `sourceFile`, `filePath`, and `path` for Codex recall audit payloads, but that audit payload is scoped to Codex memory logging rather than general prompt output.

This means an adapted package can display useful relative source paths for some result types, but it must not assume all candidate path fields are safe or equally specific.

## Risk Notes

- The raw upstream formatter emits `file:///...` links. If a future result supplies an absolute path, this exposes local filesystem layout directly in model-visible memory output.
- The raw upstream formatter treats `result.path` as equivalent to `fullPath` and `sourceFile`, which broadens the accepted input surface without validating that it is knowledge-base-relative.
- The raw upstream change also adds `fullPath` and `sourceFile` to `_cleanResultsForBroadcast()`, expanding VCP Info payload behavior beyond a display-only package.
- `sourceFile` is sometimes only a basename. Displaying it as a path can be misleading unless the formatter prefers `fullPath` and only falls back to safe relative `sourceFile` values.
- R15A review fixes changed `formatCombinedTimeAwareResults()` date parsing and sorting; any R15B implementation must preserve those fixes.
- A path-display feature changes prompt contents and may affect model behavior. It needs targeted formatter tests.

## Classification

| Item | Decision | Reason |
| --- | --- | --- |
| Raw upstream `fcfcc918` | `reject raw absorb` | It emits `file:///` path lines and expands broadcast payload fields without path-boundary validation. |
| Display-only adapted R15B | `allow narrow adapted package` | The user-visible feature is useful if restricted to sanitized knowledge-base-relative paths and tested locally. |
| `_cleanResultsForBroadcast()` path payload expansion | `reject for R15B` | This is not required for prompt display and broadens the data surface. |
| `file://` link generation | `reject for R15B` | It can expose local filesystem shape; display should use plain sanitized relative paths only. |

## Recommended R15B Package Shape

If R15B proceeds, keep it narrow:

Scope:

- `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js`
- `tests/codex-memory-recall.test.js` or a dedicated RAGDiary formatter test file

Keep out:

- `KnowledgeBaseManager.js`
- `TagMemoEngine.js`
- `AdminPanel-Vue/*`
- `AdminPanel-Vue/dist/*`
- `_cleanResultsForBroadcast()` payload changes
- real `.env`, `config.env`, runtime cache, state, logs, generated artifacts, or operator data

Implementation guidance:

- Add a private formatter helper that appends at most one path line to memory entries.
- Prefer `result.fullPath` over `result.sourceFile`; only use `sourceFile` when it is clearly a relative knowledge-base path, not just a basename unless basename-only display is explicitly accepted.
- Normalize path separators to `/`.
- Reject or suppress paths that are absolute, begin with `file://`, contain `..` traversal segments, or cannot be treated as repository/operator-safe relative paths.
- Do not generate clickable `file://` links.
- Render plain text such as `    [路径: ProcessDiary/2026-06-01.md]`.
- Preserve R15A date display behavior in `formatCombinedTimeAwareResults()`.
- Treat missing or unsafe paths as no path line, not as an error.
- Keep path display as formatter-only behavior; do not mutate result objects.

Suggested targeted tests:

- `formatStandardResults()` appends a sanitized relative path line for safe `fullPath`.
- `formatCombinedTimeAwareResults()` preserves R15A parsed date sorting and appends a sanitized relative path line.
- `formatGroupRAGResults()` appends a sanitized relative path line.
- Absolute paths are suppressed.
- `file://` paths are suppressed.
- `../` traversal paths are suppressed.
- Missing path fields preserve current output shape.
- `_cleanResultsForBroadcast()` does not gain `fullPath` or `sourceFile` fields in R15B.

Suggested validation:

```powershell
node --check Plugin\RAGDiaryPlugin\RAGDiaryPlugin.js
node --test tests\codex-memory-recall.test.js
git diff --check
```

## Decision

Do not directly absorb upstream `fcfcc918`.

Proceed only with an adapted R15B narrow branch if the implementation stays display-only and uses sanitized knowledge-base-relative paths.

If safe relative-path detection cannot be implemented without changing upstream data contracts or broadening broadcast payloads, classify `fcfcc918` as `defer`.

## Stop Conditions

Stop and reclassify as `defer` if implementation requires:

- exposing absolute paths or `file://` links
- changing `_cleanResultsForBroadcast()` payload shape
- changing KnowledgeBaseManager hydration contracts
- touching frontend files or build artifacts
- adding external path lookup, filesystem probing, or live file reads
- touching env/secrets/runtime/cache/state/log files
- changing R15A date parsing/sorting behavior
- broad prompt formatting rewrites outside RAGDiary result entry formatting
