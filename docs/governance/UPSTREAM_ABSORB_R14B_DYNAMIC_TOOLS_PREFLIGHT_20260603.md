# Upstream Absorb R14B Dynamic Tools Preflight - 2026-06-03

## Scope

This preflight reviews upstream commit `eba80f5f Optimize dynamic tool auto management` and decides whether it can be absorbed as a small DynamicTools package.

Local target:

- Repository: `JENN2046/VCPToolBox`
- Branch: `main`
- Baseline: `db751d51 Merge pull request #114 from JENN2046/codex/r14a-vcp-memory-timeline-doc-20260603`
- Upstream source commit: `eba80f5f Optimize dynamic tool auto management`

This document is read-only classification plus split guidance. It does not absorb code.

## Read-Only Commands Used

```powershell
git status -sb
git branch --show-current
git log --oneline --decorate -n 6
git show --name-status --find-renames=60% --oneline eba80f5f
git diff --stat eba80f5f^ eba80f5f -- modules/dynamicToolRegistry.js routes/admin/dynamicTools.js AdminPanel-Vue/src/api/dynamicTools.ts AdminPanel-Vue/src/views/DynamicToolsManager.vue ToolConfigs/dynamic_tool_bridge.config.json docs/CONFIGURATION.md tests/dynamicToolRegistry.test.js
```

## Upstream Change Surface

`eba80f5f` changes 7 files with about 619 added lines:

| Area | Files | Observed upstream behavior |
| --- | --- | --- |
| Dynamic tool registry | `modules/dynamicToolRegistry.js` | Adds config watchers, reload from disk, manual description overrides, fold-block expansion, and small-model endpoint normalization. |
| Admin route | `routes/admin/dynamicTools.js` | Accepts and sanitizes `manualOverrides.descriptionOverrides`. |
| Frontend config shape | `AdminPanel-Vue/src/api/dynamicTools.ts`, `AdminPanel-Vue/src/views/DynamicToolsManager.vue` | Adds `descriptionOverrides` to the DynamicTools config type and default normalization. |
| Default config | `ToolConfigs/dynamic_tool_bridge.config.json` | Adds an empty `descriptionOverrides` object. |
| Docs | `docs/CONFIGURATION.md` | Documents hot reload, manual description overrides, and fold block expansion. |
| Tests | `tests/dynamicToolRegistry.test.js` | Adds targeted coverage for hot reload, description overrides, classification cache refresh, fold expansion, and vector-cache reuse. |

## Classification

| Upstream commit | Decision | Reason |
| --- | --- | --- |
| `eba80f5f` | `defer raw absorb`; split into smaller packages | The commit combines config lifecycle behavior, prompt-injection content behavior, API/config schema changes, frontend config normalization, docs, and large tests. A direct absorb would be too broad for a stable-line review. |

## Risk Notes

- Config hot reload changes runtime lifecycle: file watchers are added for public config and private config paths. This needs focused review around duplicate watchers, watcher cleanup, debounce behavior, and secret redaction.
- `descriptionOverrides` changes operator-editable tool descriptions. This is useful, but it changes prompt-visible content and must keep route sanitization narrow.
- Fold-block expansion changes the actual injected tool usage text. It also interacts with `foldProtocol`, embedding/vector-cache behavior, token budget, and fallback behavior. This is higher risk than plain config shape support.
- The docs update should not land before the corresponding behavior lands. Otherwise the repository would claim hot reload or fold expansion behavior before local code supports it.
- The frontend diff only adds config type/default handling. It does not, by itself, prove that the admin UI has a complete editor for overrides.
- `Plugin/DynamicToolBridge/config.env` must not be modified. Any private-config tests must use temporary fixtures only.

## Recommended Split

### R14B1: DynamicTools Config Hot Reload

Recommended first package if R14B proceeds.

Scope:

- `modules/dynamicToolRegistry.js`
- `tests/dynamicToolRegistry.test.js`
- Possibly `docs/CONFIGURATION.md` only for the hot-reload behavior actually implemented

Keep out:

- `descriptionOverrides`
- fold-block expansion
- frontend UI/config shape changes unless strictly required
- `AdminPanel-Vue/dist/*`
- real `Plugin/DynamicToolBridge/config.env`

Validation:

```powershell
node --check modules/dynamicToolRegistry.js
node --test tests/dynamicToolRegistry.test.js
git diff --check
```

### R14B2: Manual Description Overrides

Defer until R14B1 is merged or explicitly skipped.

Scope:

- `modules/dynamicToolRegistry.js`
- `routes/admin/dynamicTools.js`
- `ToolConfigs/dynamic_tool_bridge.config.json`
- `tests/dynamicToolRegistry.test.js`
- Optional frontend type/default update if the admin config payload requires it

Keep out:

- fold-block expansion
- vector-cache changes
- broad frontend rebuild artifacts

Validation:

```powershell
node --check modules/dynamicToolRegistry.js routes/admin/dynamicTools.js
node --test tests/dynamicToolRegistry.test.js
git diff --check
```

### R14B3: Dynamic Fold Block Expansion

Defer for a separate preflight.

Scope:

- `modules/dynamicToolRegistry.js`
- `tests/dynamicToolRegistry.test.js`
- docs only after behavior is locally absorbed

Reason to defer:

- It changes prompt-injection semantics and may call embedding/vector-cache paths.
- It needs focused review for token growth, cache keys, fallback behavior, and no unintended external calls during tests.

## Decision

Do not directly absorb `eba80f5f`.

Proceed only by split package. The safest next implementation candidate is `R14B1 DynamicTools config hot reload`, because it is useful, testable, and can be kept mostly backend-local. `descriptionOverrides` and fold-block expansion should remain deferred until their own narrow package reviews.

## Stop Conditions For Any R14B Package

- The change touches `AdminPanel-Vue/dist/*`.
- The change writes or edits real `.env`, `config.env`, secrets, runtime state, cache, logs, or generated artifacts.
- The change starts services or executes real bridge/file/shell operations.
- The change requires production deployment or direct stable-branch modification.
- The change mixes hot reload, overrides, fold expansion, and frontend rebuild output in one PR.

## Current Local Notes

- Existing unrelated `routes/admin/aiImageAgents.js` stashes remain isolated and are not part of R14B.
- No R14B implementation branch has been opened yet.
- This preflight document is intended to be committed separately before implementation, if the user chooses to keep the intake ledger on `main`.
