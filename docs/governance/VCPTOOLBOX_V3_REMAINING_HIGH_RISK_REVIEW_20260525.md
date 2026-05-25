# Package V3 Review: Remaining High-Risk Dirty Worktree Items

Review time: 2026-05-25 19:45 Asia/Shanghai.

Worktree reviewed: `A:/VCP/VCPToolBox`.

This was a read-only review. No files in `A:/VCP/VCPToolBox` were modified, reset, deleted, copied, or migrated.

## 1. Verified State

- Branch: `feature/latest-updates`
- HEAD: `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`
- Upstream comparison: behind `15`, ahead `10`
- Dirty entries: `254`
- Largest dirty areas:
  - `Plugin/`
  - `docs/`
  - `VectorStore_bge1024/`
  - `VectorStore_bge1024_backup_20260422-123654/`
  - `state/`
  - `.claude/`
  - `VCPChat/`

Conclusion: keep treating this worktree as user-owned and high risk. It is not the latest `main` worktree and must not be deleted, reset, or branch-switched as part of cleanup.

## 2. DingTalkTable Compatibility Layer

Observed dirty/untracked area:

- `Plugin/DingTalkTable/DingTalkTable.js`
- `Plugin/DingTalkTable/plugin-manifest.json`
- `Plugin/DingTalkTable/README.md`
- `Plugin/DingTalkTable/config.env.example`
- `Plugin/DingTalkTable/config.env`
- planning notes

The untracked implementation changes `DingTalkTable` into a deprecated compatibility layer that forwards legacy actions through `DingTalkCLI`.

Potential value:

- It moves old table writes toward the newer `DingTalkCLI` runtime.
- Write actions default `dry_run` to `true` unless explicitly disabled.
- `apply` is only true when the caller explicitly requests `apply === true`.
- Responses add deprecated/replacement metadata.

Risks:

- The directory contains `config.env`; it must not be read, copied, committed, or migrated.
- It directly loads local env via `config.env`.
- It touches an external-write-capable DingTalk path.
- It is an untracked replacement over a tracked current-main plugin, not a clean forward diff.

Decision: do not migrate from this dirty worktree as-is.

Recommended future package: reimplement a DingTalkTable compatibility shim on current `main`, exclude `config.env`, keep write behavior dry-run by default, and add mocked/no-write tests.

## 3. Interaction-Middleware Docs

Observed docs:

- `docs/interaction-middleware/README.md`
- `VCP_INTERACTION_MIDDLEWARE_TARGET.md`
- `VCP_INTERACTION_MIDDLEWARE_SCHEMA.md`
- `CHANNEL_MIDDLEWARE_DESIGN.md`
- `CHANNEL_MIDDLEWARE_IMPLEMENTATION_PLAN.md`
- `CHANNEL_MIDDLEWARE_FILE_TODOS.md`
- `CHANNEL_HUB_USER_GUIDE.md`
- adapter/binding templates
- DingTalk workspace CLI comparison docs

Potential value:

- The folder is a useful design snapshot for ChannelHub / interaction middleware.
- It includes schema, target, implementation plan, user guide, and adapter config templates.

Risks:

- It is broad design documentation, not a narrow branch-cleanup artifact.
- Some claims need verification against current `main` implementation before becoming canonical docs.
- It overlaps with current ChannelHub source and docs, so blind intake could overclaim.

Decision: do not migrate as part of dirty worktree cleanup.

Recommended future package: docs-only intake against current `main`, with explicit "implemented now" vs "future plan" labels.

## 4. OneBot Adapter Docs

Observed dirty/untracked area:

- `Plugin/vcp-onebot-adapter/README.md`
- `Plugin/vcp-onebot-adapter/docs/00-index.md`
- `Plugin/vcp-onebot-adapter/docs/01-quickstart.md`
- `Plugin/vcp-onebot-adapter/docs/02-config.md`
- `Plugin/vcp-onebot-adapter/docs/03-release-checklist.md`

Finding:

- Dirty README changes the ChannelHub route to `/internal/channel-hub/events`.
- Current `main` documents `/internal/channelHub/events`.
- A route-name change must not be accepted from docs without code/API verification.

Decision: reject dirty README as-is.

Potential future value:

- A docs index and release checklist may be useful.
- Any intake must first verify the current adapter route, env keys, and startup flow against code.

## 5. Runtime, State, And Sensitive Data

The dirty worktree still contains sensitive or user-owned local data paths:

- `Plugin/*/config.env`
- `Plugin/UserAuth/code.bin`
- `Plugin/ImageProcessor/*.sqlite*`
- `Plugin/ImageRatingManager/*.sqlite*`
- `Plugin/DingTalkCLI/state/**`
- `VectorStore_bge1024/**`
- `VectorStore_bge1024_backup_20260422-123654/**`
- `state/**`
- `VCPChat/AppData/**`
- `.claude/**`
- plugin logs and generated runtime files

Decision: none of these paths should be migrated, printed, deleted, or archived without a separate backup/retention decision.

## 6. Final V3 Decision

Do not absorb `A:/VCP/VCPToolBox` into `main`.

Do not remove or reset `A:/VCP/VCPToolBox` yet.

Remaining useful ideas should become separate future packages:

- DingTalkTable compatibility shim on current `main`
- interaction-middleware docs intake
- OneBot adapter docs repair against current code
- optional image-rating auto-registration behind explicit config

These ideas do not block branch/worktree governance.
