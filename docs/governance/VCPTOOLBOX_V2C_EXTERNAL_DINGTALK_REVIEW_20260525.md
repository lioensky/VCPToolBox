# Package V2C Review: External Reporting / DingTalk

Review time: 2026-05-25 18:05 Asia/Shanghai.

Worktree reviewed: `A:/VCP/VCPToolBox`.

Baseline: current `origin/main` at `55b51ca`.

Scope:

- `plugins/custom/reporting/sync_to_external_sheet_or_notion/src/index.js`
- `tests/photo-studio/external-sync.test.js`
- `Plugin/DingTalkCLI/**`
- `Plugin/DingTalkTable/**`
- `docs/dingtalk-cli/**`
- `docs/interaction-middleware/**`

This was a read-only review. No external writes, no DingTalk calls, no sync, and no files in `A:/VCP/VCPToolBox` were modified.

## 1. Summary

Do not migrate Package V2C wholesale into current `main`.

Reason: the dirty worktree contains a mix of:

- conflict-marked partial merge files,
- stale/deleted DingTalk docs and plugin files relative to current main,
- a potentially useful but untracked replacement `DingTalkTable` compatibility layer,
- broad interaction-middleware design docs that are not a direct branch-cleanup artifact.

This package is not safe to absorb as-is.

## 2. External Sync Plugin

Dirty tracked files:

- `plugins/custom/reporting/sync_to_external_sheet_or_notion/src/index.js`
- `tests/photo-studio/external-sync.test.js`

Hard finding: both files contain unresolved conflict markers.

`git diff --check` reports:

- `plugins/custom/reporting/sync_to_external_sheet_or_notion/src/index.js`: leftover conflict markers at multiple lines.
- `tests/photo-studio/external-sync.test.js`: leftover conflict markers at multiple lines.

Decision: reject migration.

Current `main` already has the provider-aware implementation:

- `SHEET_TARGET_PROVIDERS = ['dingtalk_ai_table', 'baserow']`
- `DEFAULT_SHEET_TARGET_PROVIDER = 'dingtalk_ai_table'`
- `_resolveTargetProvider(...)`
- provider-aware export key construction
- legacy export identity handling
- tests for separate `target_provider` identities, legacy sheet identity preservation, and invalid provider rejection

Therefore the dirty worktree version is stale/half-merged relative to current `main`.

## 3. DingTalkTable

Current `main` contains tracked `Plugin/DingTalkTable/**`.

The dirty worktree has an untracked `Plugin/DingTalkTable/` replacement that presents itself as:

- `DingTalk Table (Deprecated)`
- a backward-compatible AITable entry,
- internally forwarding requests to `DingTalkCLI`,
- adding deprecated/replacement metadata.

This direction may be valuable, because it aligns with the governance direction of routing writes through `DingTalkCLI` policy gates.

However, it must not be absorbed from the dirty worktree as-is:

- The dirty worktree diff against `origin/main` shows tracked DingTalkTable files as deleted, while a replacement exists as untracked files. That is not a clean migration diff.
- The directory also contains `config.env`, which is sensitive/local and must not be read, copied, committed, or migrated.
- DingTalk write behavior is production/side-effect sensitive and requires explicit design, no-write tests, and approval before implementation.

Decision: do not migrate now. Open a separate `Package V2C-DTTable` if this compatibility-layer idea should be implemented on top of current `main`.

Suggested future package:

- Reimplement the deprecated DingTalkTable-to-DingTalkCLI forwarding layer on current `main`.
- Exclude `config.env`.
- Use only `config.env.example` placeholders.
- Add/adjust tests with `apply=false` or mocked runtime only.
- Validate no real DingTalk/MCP write is executed.

## 4. DingTalkCLI And Docs

Diff against `origin/main` shows small DingTalkCLI/doc deltas and deletions, including:

- `Plugin/DingTalkCLI/README.md`
- `Plugin/DingTalkCLI/config.env.example`
- `Plugin/DingTalkCLI/lib/constants.js`
- `Plugin/DingTalkCLI/plugin-manifest.json`
- `docs/dingtalk-cli/06-integration-status-2026-04-26.md`
- `docs/dingtalk-cli/07-weeklyreport-cutover-checklist.md`
- `docs/dingtalk-cli/README.md`

Current `main` already contains the 2026-04-26 DingTalkCLI gray-stage / WeeklyReport boundary documentation and current DingTalkCLI files.

Decision: reject dirty worktree DingTalkCLI/doc migration unless a later focused diff proves a specific forward-only fix.

## 5. interaction-middleware Docs

The dirty worktree has a large docs-only batch under `docs/interaction-middleware/**`:

- design docs,
- user guide,
- schema,
- adapter config/binding templates,
- implementation plan,
- file TODOs,
- platform comparison notes.

These may be useful as historical design material, but they are broad and not specific to the external reporting/DingTalk cleanup decision.

Decision: do not migrate as part of V2C. If wanted, review as a separate docs intake package against current `ChannelHub` docs and current `modules/channelHub/**`.

## 6. Decision Table

| Area | Decision | Reason |
| --- | --- | --- |
| external sync source/tests | Reject | Contains unresolved conflict markers; current `main` already has provider-aware implementation and tests. |
| DingTalkTable untracked replacement | Defer | Potentially valuable compatibility direction, but high-risk external-write path and not a clean diff. |
| DingTalkCLI/doc small deltas | Reject by default | Current `main` already has gray-stage docs and current plugin state. |
| interaction-middleware docs | Defer | Broad ChannelHub design material; needs a separate docs intake review. |

## 7. Final Recommendation

Do not delete `A:/VCP/VCPToolBox` yet, because it still contains deferred items:

- possible `DingTalkTable` compatibility-layer idea,
- possible interaction-middleware design docs,
- other V2D/V2E source candidates not yet reviewed.

Next safe review package:

- Package V2D: tool execution route review, or
- Package V2E: image/plugin source review.
