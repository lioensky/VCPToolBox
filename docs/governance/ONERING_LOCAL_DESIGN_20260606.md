# OneRing Local Design - 2026-06-06

本文件定义 OneRing 专项在本地吸收前的设计边界。

本包只新增设计文档，不实现 OneRing，不新增 `Plugin/OneRing/*`，不修改 handlers，不修改 `preprocessor_order.json`，不创建 SQLite 或 runtime 数据。

## 1. Goal

OneRing 的本地目标不是“照搬 upstream 统一上下文系统”，而是先建立一个可审、可关、可回滚的上下文记录能力。

第一阶段目标：

- 默认关闭；
- 不主动改写请求上下文；
- 不跨前端补上下文；
- 不写真实运行库，除非 operator 显式启用并确认数据路径；
- 不存储 reasoning / hidden thinking 字段；
- 不改变现有 `RAGDiaryPlugin`、`ContextFoldingV2`、`CapturePreprocessor`、`WorkspaceInjector` 的默认行为。

非目标：

- 不在第一阶段实现 cross-frontend context patching；
- 不自动修改 `preprocessor_order.json`；
- 不把 OneRing 放入默认运行顺序；
- 不把 upstream `ONERING_RECORD_ONLY=false` 作为本地默认；
- 不引入不可回滚的数据库迁移。

## 2. Activation Semantics

OneRing 必须是显式 opt-in。

允许的触发语法设计：

```text
[[OneRing::AgentName::Frontend]]
[[OneRing::AgentName::Frontend::Only]]
```

本地默认语义：

| Mode | Behavior |
|------|----------|
| missing trigger | no-op |
| global disabled | no-op |
| normal trigger in phase 1 | record-only behavior only |
| `::Only` trigger | record-only behavior only |

第一阶段即使出现 normal trigger，也不得注入跨端历史消息。normal trigger 只为后续 patching 阶段预留语义，不在 record-only 阶段改变上下文。

## 3. Configuration Policy

本地配置必须默认保守。

Proposed local defaults:

```env
ONERING_ENABLED=false
ONERING_RECORD_ONLY=true
ONERING_ALLOW_CONTEXT_PATCH=false
ONERING_TIME_INSERT=false
ONERING_MAX_CONTEXT_BLOCKS=10
ONERING_MAX_UNKNOWN_RATIO=0.20
ONERING_DEDUP_SIMILARITY=0.92
ONERING_MAX_DB_RECORDS=100
```

Rules:

- Do not commit real `Plugin/OneRing/config.env`.
- `config.env.example` may document options, but must not imply active default behavior.
- Any future package that changes defaults must call out operator impact in the PR body.
- `ONERING_ALLOW_CONTEXT_PATCH=true` requires a separate implementation package and explicit approval.

## 4. Runtime Data Policy

OneRing runtime data is operator data.

Allowed runtime path after explicit enablement:

```text
Plugin/OneRing/data/
```

Rules:

- Never commit `Plugin/OneRing/data/*`.
- Never create real OneRing SQLite files during normal tests.
- Tests must use temp directories or in-memory/test-only paths.
- Store must support close/shutdown behavior.
- Retention must be bounded by `ONERING_MAX_DB_RECORDS` unless operator explicitly disables it.

Minimum ignore coverage required before any implementation:

```text
Plugin/OneRing/data/
Plugin/OneRing/*.db
Plugin/OneRing/*.db-wal
Plugin/OneRing/*.db-shm
```

## 5. Data Model

The store may record only visible conversation text and source metadata.

Allowed fields:

- `agentName`
- `role`
- `senderName`
- `frontendSource`
- `content`
- `timestamp`
- `postContextHash`

Forbidden fields:

- raw request headers;
- API keys or provider tokens;
- `reasoning_content`;
- hidden chain-of-thought or hidden reasoning;
- raw env values;
- full unredacted tool payloads unless they are already visible message content and explicitly allowed by design.

## 6. Handler Integration Rules

Handler integration is not part of the first implementation package.

When handler integration is eventually opened:

- stream and non-stream paths must be tested separately;
- `reasoning_content` must not be appended to the OneRing persisted assistant text;
- response shape must remain unchanged;
- failed upstream requests must not create successful assistant records;
- aborted streams may record only visible partial text if explicitly designed and tested;
- logging and diary behavior must remain unchanged unless explicitly scoped.

Current local risk to address:

```text
modules/handlers/streamHandler.js currently appends reasoning_content into collectedContentThisTurn.
modules/handlers/nonStreamHandler.js can compose fullContentFromAI with reasoning_content depending on hideReasoning.
```

OneRing must not consume those variables without a visible-content-only adapter.

## 7. Preprocessor Ordering

Do not modify `preprocessor_order.json` in the design or record-only plugin package.

Current local order:

```json
[
  "RAGDiaryPlugin",
  "ContextFoldingV2",
  "CapturePreprocessor",
  "WorkspaceInjector",
  "VCPTavern",
  "ImageProcessor"
]
```

If OneRing is later added to order, that must be a separate package with:

- before/after order diff;
- explanation of whether OneRing runs before or after `ContextFoldingV2`;
- tests proving tail markers do not pollute folding/vector/RAG semantics;
- rollback plan restoring prior order.

## 8. Package Plan

Recommended sequence:

1. **Parser and marker tests**
   - Trigger parser.
   - Tail marker parser/stripper.
   - Sender/source classifier.
   - No SQLite, no plugin registration.

2. **Fuzzy helper tests**
   - Isolate fuzzy matching from runtime store.
   - Test edit/replay detection with fixed fixtures.

3. **Store package**
   - Temp-path SQLite store.
   - Schema, insert, update, retention, close.
   - Path containment tests.

4. **Record-only plugin package**
   - Default disabled.
   - Explicit trigger + config enablement required.
   - No cross-frontend patching.
   - No handler changes.

5. **Handler adapter package**
   - Visible assistant text only.
   - Stream/non-stream regression tests.
   - No reasoning persistence.

6. **Context patching package**
   - Separate approval.
   - Strict opt-in.
   - Preprocessor ordering tests.
   - Unknown-ratio and max-block tests.

## 9. Validation Contract

Minimum validation before implementation may advance beyond design:

```powershell
git diff --check
node --check <changed-js-files>
node --test <targeted-tests>
```

Forbidden validation:

- starting production services;
- writing real `Plugin/OneRing/data`;
- calling external model/provider APIs;
- modifying real env files;
- running database migrations against operator data.

## 10. Open Decisions

These require explicit decision before implementation:

| Decision | Default until decided |
|----------|-----------------------|
| Should OneRing persist visible tool payloads? | no |
| Should aborted stream partials be recorded? | no |
| Should OneRing run before or after `ContextFoldingV2`? | no order change |
| Should cross-frontend patching ever be enabled by default? | no |
| Should snapshots be part of record-only phase? | no |

## 11. Design Result

Proceed only with parser/marker tests as the next implementation step.

Do not add `Plugin/OneRing/*`, do not edit handlers, and do not modify `preprocessor_order.json` until the smaller prerequisite packages are reviewed.
