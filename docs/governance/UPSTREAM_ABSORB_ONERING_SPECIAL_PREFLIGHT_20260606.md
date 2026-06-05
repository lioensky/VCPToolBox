# Upstream Absorb OneRing Special Preflight - 2026-06-06

本文件记录 OneRing upstream 专项的只读 preflight 评估。

本专项不属于 R16 普通小包吸收。本 preflight 不吸收代码，不新增 `Plugin/OneRing/*`，不修改 handlers，不启动服务，不创建 OneRing SQLite 数据库。

## 1. Scope

| Item | Value |
|------|-------|
| Local target | `main` |
| Upstream commits | `e4205294`, `ad92d9b6`, `5b26680a`, `d558e20a`, `64d9edcf`, `481835ea`, `be74076d`, `64cee8fc`, `e628d98b` |
| Upstream theme | OneRing unified context system |
| Local state | `Plugin/OneRing` not present |
| Proposed local change in this package | Documentation preflight only |

## 2. Upstream Payload

Combined upstream range touches these areas:

| Area | Files |
|------|-------|
| New plugin | `Plugin/OneRing/OneRing.js`, `OneRingDB.js`, `OneRingFuzzy.js`, `OneRingSnapshot.js`, `README.md`, `config.env.example`, `plugin-manifest.json` |
| Existing preprocessor compatibility | `Plugin/ContextFoldingV2/ContextFoldingV2.js` |
| Request/response handlers | `modules/handlers/nonStreamHandler.js`, `modules/handlers/streamHandler.js` |
| Top-level docs | `README.md` |

Approximate combined diff:

```text
Plugin/OneRing/*                         +2043 lines
Plugin/ContextFoldingV2/ContextFoldingV2.js  +17 / -3
modules/handlers/nonStreamHandler.js         +29 / -5
modules/handlers/streamHandler.js            +23 / -1
README.md                                    +36
```

The upstream series is not a single clean feature commit. It includes the initial OneRing import plus multiple follow-up fixes around timestamp normalization, parsing, fuzzy logic, snapshot handling, and edge cases.

## 3. Runtime Behavior Observed From Static Review

OneRing is a `messagePreprocessor` triggered by system-prompt syntax such as:

```text
[[OneRing::AgentName::Frontend]]
[[OneRing::AgentName::Frontend::Only]]
```

Static review shows the system is intended to:

- parse agent/frontend identity from the prompt trigger;
- append `[OneRing通知:...]` tail markers to message content;
- record user/assistant messages into per-agent SQLite databases;
- use fuzzy matching and timestamps to detect edited/replayed context;
- optionally patch cross-frontend context into the message list;
- save/restore snapshots;
- record final assistant output from both stream and non-stream handlers after the upstream response completes;
- strip OneRing tail markers from ContextFoldingV2 hashing/vectorization paths.

The upstream `config.env.example` includes defaults such as:

```env
ONERING_ENABLED=true
ONERING_RECORD_ONLY=false
ONERING_ALLOW_CONTEXT_PATCH=true
ONERING_TIME_INSERT=true
ONERING_MAX_DB_RECORDS=100
```

Those defaults are not safe to import as local defaults without a separate operator-facing design decision.

## 4. Risk Assessment

This is a system-level feature, not a small plugin.

Primary risks:

- **Context mutation risk**: OneRing can append markers and optionally insert cross-frontend historical messages into the active request context.
- **Persistence risk**: OneRing writes per-agent SQLite databases under `Plugin/OneRing/data`.
- **Handler coupling risk**: stream and non-stream handlers need to call OneRing after assistant responses finish, which touches shared response paths.
- **Reasoning leakage risk**: upstream stream handling includes a specific fix to avoid storing `reasoning_content`; that protection must be preserved if implemented locally.
- **Preprocessor ordering risk**: OneRing interacts with `ContextFoldingV2` and `preprocessor_order.json`; order must be explicit and tested.
- **Tail-marker contamination risk**: downstream RAG/folding/hash/vector paths must not treat OneRing source markers as semantic content.
- **Config default risk**: upstream defaults include active context patching; local stable behavior should default to off or record-only.
- **Runtime data risk**: SQLite files, WAL files, logs, and snapshots are runtime state and must never be committed.

## 5. Recommended Absorption Strategy

Do not raw-merge the upstream OneRing commit range.

Recommended staged专项:

1. **Design doc only**
   - Define desired local OneRing semantics.
   - Decide default-off versus record-only default.
   - Define runtime data paths and cleanup/backup policy.

2. **Pure parser/fuzzy unit package**
   - Extract trigger parsing, tail marker parsing, sender/source classification, fuzzy diff helpers.
   - Add tests without SQLite writes or handler integration.

3. **SQLite store package**
   - Introduce a OneRing store behind a temp/test path.
   - Test schema, retention, close behavior, and path containment.
   - Keep real `Plugin/OneRing/data` out of tests.

4. **Record-only plugin package**
   - Add the plugin default-off or record-only.
   - No cross-frontend patching.
   - No handler changes until the plugin path is proven safe.

5. **Handler integration package**
   - Add stream/non-stream post-response recording.
   - Preserve `reasoning_content` exclusion.
   - Add targeted tests for no reasoning persistence and no response-shape regression.

6. **Context patching package**
   - Only after explicit approval.
   - Add strict opt-in flags and tests for preprocessor ordering, tail marker stripping, and unknown-ratio behavior.

## 6. Stop Conditions

Stop before implementation if any package requires:

- enabling OneRing by default;
- writing real `Plugin/OneRing/data` or runtime SQLite files;
- committing `config.env`;
- changing `preprocessor_order.json` without explicit order design;
- mutating stream/non-stream shared handlers without targeted regression tests;
- storing reasoning content;
- enabling cross-frontend context patching without explicit operator approval.

## 7. Validation Performed

Read-only commands used:

```powershell
git show --stat --name-status --oneline e4205294 ad92d9b6 5b26680a d558e20a 64d9edcf 481835ea be74076d 64cee8fc e628d98b
git diff --stat e4205294^ e628d98b -- Plugin/OneRing Plugin/ContextFoldingV2 README.md modules/handlers/nonStreamHandler.js modules/handlers/streamHandler.js
git diff --unified=60 e4205294^ e628d98b -- modules/handlers/nonStreamHandler.js modules/handlers/streamHandler.js Plugin/ContextFoldingV2/ContextFoldingV2.js
git show e4205294:Plugin/OneRing/plugin-manifest.json
git show e4205294:Plugin/OneRing/config.env.example
Test-Path Plugin\OneRing
rg -n "OneRing|ContextFoldingV2|onering|context folding" Plugin modules README.md docs\governance
```

No service startup, plugin execution, admin API call, SQLite creation, database migration, vector rebuild, runtime write, or external call was run.

## 8. Preflight Result

OneRing should remain a dedicated专项 track.

This preflight package should only add this document. It must not add `Plugin/OneRing/*`, must not edit handlers, and must not create runtime database files.
