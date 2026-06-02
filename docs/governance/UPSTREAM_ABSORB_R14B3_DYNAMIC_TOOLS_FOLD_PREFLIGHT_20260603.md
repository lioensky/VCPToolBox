# Upstream Absorb R14B3 Dynamic Tools Fold Preflight - 2026-06-03

## Scope

This preflight reviews the remaining fold block expansion portion of upstream commit `eba80f5f Optimize dynamic tool auto management` after R14B1 and R14B2 have already been absorbed into `main`.

Local target:

- Repository: `JENN2046/VCPToolBox`
- Branch: `main`
- Baseline: `0e04178c Merge pull request #116 from JENN2046/codex/r14b2-dynamictools-description-overrides-20260603`
- Upstream source commit: `eba80f5f Optimize dynamic tool auto management`

This document is read-only classification plus split guidance. It does not absorb code.

## Already Absorbed

| Package | Status | Notes |
| --- | --- | --- |
| R14B1 config hot reload | `absorbed` via #115 | Local implementation includes extra safety for transient parse failures and transient missing config. |
| R14B2 description overrides | `absorbed` via #116 | Local implementation applies overrides as a derived display/injection layer and avoids mutating classification cache. |

Because local `main` contains safer adapted R14B1/R14B2 behavior, raw `0e04178c..eba80f5f` diffs include reverse deltas that must not be copied back.

## Read-Only Commands Used

```powershell
git status -sb
git branch --show-current
git log --oneline --decorate -n 8
git diff --name-status 0e04178c..eba80f5f -- modules/dynamicToolRegistry.js tests/dynamicToolRegistry.test.js docs/CONFIGURATION.md
git diff --stat 0e04178c..eba80f5f -- modules/dynamicToolRegistry.js tests/dynamicToolRegistry.test.js docs/CONFIGURATION.md
git diff 0e04178c..eba80f5f -- modules/dynamicToolRegistry.js
git diff 0e04178c..eba80f5f -- tests/dynamicToolRegistry.test.js
git diff 0e04178c..eba80f5f -- docs/CONFIGURATION.md
```

## Remaining Upstream Surface

`eba80f5f` still differs from local `main` in:

- `modules/dynamicToolRegistry.js`
- `tests/dynamicToolRegistry.test.js`
- `docs/CONFIGURATION.md`

The meaningful remaining feature is DynamicTools fold block expansion:

- Parse `vcp_fold` markers and JSON `vcp_dynamic_fold` objects from expanded tool descriptions.
- Select fold blocks based on the current message context.
- Reuse RAG embeddings and optional vector DB cache for block similarity.
- Document that DynamicTools can expand only relevant fold blocks.

## Existing Local Foundation

The repository already has related primitives:

- `modules/foldProtocol.js` exports `parseFoldBlocks`, `hasFoldMarkers`, and `buildDynamicFoldObject`.
- `modules/messageProcessor.js` already handles `vcp_dynamic_fold` through `resolveDynamicFoldProtocol`.
- `modules/toolboxManager.js` already builds `toolbox_block_similarity` fold objects.
- R14B2 already lets `manualOverrides.descriptionOverrides[originKey].fullDescription` override the full injection text without mutating classifier cache.

This means R14B3 should reuse local fold semantics instead of copying a second near-duplicate fold resolver into `DynamicToolRegistry`.

## Risk Notes

- Fold expansion changes prompt injection semantics. A tool that previously injected full usage text may inject only selected blocks.
- The upstream implementation embeds user query text and block descriptions during injection. Tests must stub embeddings and must not call external providers.
- The upstream implementation has cache-key behavior that differs from current local RAG classification vector reuse. That cache-key behavior should be reviewed separately and not silently bundled.
- The upstream diff would regress local R14B1/R14B2 safety if copied directly, including hot reload watcher cleanup and description override cache handling.
- Documentation must not claim fold behavior until the implementation lands and is validated.
- Token growth and fallback behavior must be explicit: no RAG provider, no user query, invalid fold JSON, empty blocks, and embedding failure all need deterministic safe fallbacks.

## Classification

| Item | Decision | Reason |
| --- | --- | --- |
| Raw upstream fold expansion from `eba80f5f` | `reject raw absorb` | It is tangled with reverse diffs against local R14B1/R14B2 safety work and duplicates nearby fold logic. |
| R14B3 fold expansion as a narrow adapted package | `defer until preflight-approved implementation` | The feature is useful, but must be implemented against current local semantics and tests. |
| Upstream docs wording for fold behavior | `defer` | Docs should land only with the adapted implementation. |

## Recommended R14B3 Package Shape

If R14B3 proceeds, keep it narrow:

Scope:

- `modules/dynamicToolRegistry.js`
- `tests/dynamicToolRegistry.test.js`
- `docs/CONFIGURATION.md` only after behavior is implemented

Keep out:

- `routes/admin/dynamicTools.js`
- `AdminPanel-Vue/*`
- `ToolConfigs/dynamic_tool_bridge.config.json`
- `AdminPanel-Vue/dist/*`
- unrelated vector-cache refactors
- any real `.env`, `config.env`, runtime cache, state, logs, or generated artifacts

Implementation guidance:

- Preserve R14B2 `descriptionOverrides` derived-layer behavior.
- Add a fold-aware injection helper that first resolves `this._descriptionForInjection(record)`.
- Prefer reusing `foldProtocol` parsing and mirroring `messageProcessor` fold semantics.
- Treat fold expansion as an injection-time transform only. It must not rewrite catalog records or classification cache.
- Use deterministic fallbacks:
  - no fold markers or invalid fold object: return normal full description
  - no RAG provider: return baseline/fallback block
  - no user query: return baseline/fallback block
  - embedding/vector failure: return baseline/fallback block and record `lastError`
- Keep tests fully local with stubbed embeddings and temp project roots.

Suggested targeted tests:

- `vcp_fold` marker descriptions expand only relevant blocks with stub embeddings.
- JSON `vcp_dynamic_fold` objects are accepted.
- Legacy blocks without descriptions follow existing `messageProcessor`-compatible fallback behavior.
- Full-description overrides containing fold markers are folded at injection time.
- Removing a full-description override restores ordinary injection text.
- No RAG provider returns the baseline block without error.
- Embedding failure returns the fallback block and does not throw.
- No external embedding/network calls are made in tests.

Suggested validation:

```powershell
node --check modules/dynamicToolRegistry.js
node --test tests/dynamicToolRegistry.test.js
git diff --check
```

## Decision

Do not end DynamicTools intake yet.

Do not directly absorb the upstream R14B3 fold code.

The safest next action is to open an adapted R14B3 narrow branch only if the implementation follows the package shape above. If that package cannot preserve R14B1/R14B2 behavior and reuse local fold semantics cleanly, classify R14B3 as `defer`.

## Stop Conditions

Stop and reclassify as `defer` if implementation requires:

- touching frontend files or build artifacts
- changing admin route/config schema
- changing real private config or runtime/cache/state files
- calling real embedding providers during tests
- broad vector-cache key changes beyond fold block vectors
- replacing existing `messageProcessor` fold semantics
- mutating catalog or classification cache during fold expansion
