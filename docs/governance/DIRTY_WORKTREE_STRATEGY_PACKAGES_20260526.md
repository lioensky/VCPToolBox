# Dirty Worktree Strategy Packages - 2026-05-26

This document converts the reviewed dirty worktree state into explicit
preservation, archive, cleanup, and future rewrite packages.

It is a governance planning and checkpoint artifact only. It does not authorize
copying, archiving, deleting, resetting, cleaning, merging, pushing, or touching
the dirty worktree.

Baseline:

- Control worktree: `A:/VCP/VCPToolBox-prod-stable`
- Control branch: `main`
- `main` / `origin/main`: `32cdf26`
- Dirty worktree: `A:/VCP/VCPToolBox`
- Dirty branch: `feature/latest-updates`
- Dirty HEAD: `a82c8f2`
- Upstream comparison: `10 ahead / 15 behind`
- Expanded dirty entries: `260`
- Dirty tracked entries: `41`
- Dirty untracked entries: `219`

Hard protections:

- Do not modify `A:/VCP/VCPToolBox` without a separate retention decision.
- Do not copy runtime state, env files, databases, vector stores, logs, or
  generated reports into `main`.
- Do not normalize plugin manifest toggles as source cleanup.
- Do not absorb conflict-marked files or config examples as-is.
- Do not perform branch, worktree, or remote operations without explicit
  approval for that operation.

## Package D0 - Current Decision

Action: stop direct source absorption from the dirty worktree.

Reason:

- Candidate reviews C1-C6 found no remaining direct intake candidate.
- Useful ideas are either already represented in current `main`, need rewrite
  against current `main`, or are runtime/generated/sensitive artifacts.
- The dirty worktree is a mixed preservation object, not a clean merge source.

Validation before changing this decision:

- Re-run path-level dirty audit.
- Re-run targeted source diff for the specific candidate group.
- Confirm no unresolved conflict markers or secret-like values are present.

## Package D1 - Path-Only Preservation

Action: retain a path-only checkpoint and keep the worktree untouched.

Allowed without touching the dirty worktree:

- Maintain path-level governance docs.
- Record counts, branch heads, and handling policies.
- Record sanitized findings only.

Not allowed:

- Copy file contents from quarantine-sensitive paths.
- Commit generated reports, runtime data, env/config files, sqlite files, vector
  stores, logs, caches, or user state.
- Delete, reset, stash, clean, move, or archive the dirty worktree.

Success criteria:

- `A:/VCP/VCPToolBox` remains on `feature/latest-updates`.
- Dirty entry count is treated as evidence, not as a cleanup target.
- Governance docs describe handling policy without exposing sensitive content.

## Package D2 - Archive Planning

Action: prepare an archive plan only if preservation beyond Git status evidence
is required.

Default recommendation: no archive action yet.

Archive plan requirements before execution:

- Define destination path outside source-intake areas.
- Exclude env/config files, secrets, sqlite databases, vector stores, logs,
  caches, generated DingTalk reports, and runtime/user state by default.
- Use path-only manifests for excluded material.
- Record checksums only for allowed non-sensitive artifacts if needed.
- Treat archive creation as a separate local filesystem write requiring an
  explicit action request.

Rollback:

- Delete the generated archive only after verifying it is outside the repo and
  does not contain sensitive/runtime material.

## Package D3 - Cleanup Planning

Action: no cleanup by default.

Cleanup is blocked until all of these are true:

- A retention or archive decision exists.
- The exact paths, worktree, or branches to remove are listed.
- The approval names the destructive operation.
- The rollback path is documented.

Forbidden as automatic cleanup:

- `git reset --hard`
- `git clean -fd` or `git clean -fdx`
- Recursive delete of dirty worktree paths.
- Deleting `feature/latest-updates` while the dirty worktree exists.
- Deleting remote archive branches by implication.

Minimum preflight before any future cleanup:

- `git worktree list --porcelain`
- `git -C A:/VCP/VCPToolBox status --short --untracked-files=all`
- Exact target path/ref list.
- Explicit rollback or recreation commands.

## Package D4 - Future Rewrite Packages

Action: rewrite valuable ideas against current `main`; do not copy dirty files.

Prepared future packages:

| Package | Direction | Default decision |
| --- | --- | --- |
| `D4A` | DingTalkTable compatibility layer through DingTalkCLI policy gates | Future implementation package only |
| `D4B` | OneBot operational docs repair against current route names | Future docs package only |
| `D4C` | Interaction middleware documentation intake | Future docs merge with implemented/future labels |
| `D4D` | VS Code panel / `vcp-panel-extension` product review | Proposal completed; do not absorb as-is |
| `D4E` | CodexMemoryBridge `.new.js` i18n/API contract review | Future targeted code review with tests |
| `D4F` | `Agent/Noir Architect.txt` new-agent proposal | Proposal completed; no automatic enablement |

Shared requirements:

- Start from current `main`.
- Implement one package at a time.
- Avoid copying dirty worktree files wholesale.
- Add targeted validation for any runtime or user-facing behavior.
- Require explicit approval before live DingTalk/MCP calls, plugin enablement,
  deployment, remote writes, or secret/config changes.

## Recommended Next Order

1. Keep `A:/VCP/VCPToolBox` untouched.
2. If the user wants only governance closure, update checkpoint docs and commit
   this strategy package locally.
3. If the user wants preservation beyond docs, draft a separate archive
   execution plan with exclusions.
4. If the user wants implementation value, pick exactly one D4 rewrite package
   and build it on current `main`.
5. If the user wants cleanup, first produce an exact destructive-operation
   preflight and wait for explicit approval.

## D4B Execution - OneBot Operational Docs Repair

Status: completed locally on 2026-05-26.

Action:

- Corrected `Plugin/vcp-onebot-adapter/.env.example` to use the current
  ChannelHub B2 endpoint `/internal/channelHub/events`.
- Added a README troubleshooting note that warns against the stale
  `/internal/channel-hub/events` path.

Validation:

- Current source default, plugin manifest, README, and tests all use
  `/internal/channelHub/events`.
- The dirty worktree was not used as a content source.

Remaining risk:

- No live OneBot or ChannelHub service was started.
- This package only repairs documentation/config template accuracy.

## D4C Execution - Interaction Middleware Documentation Intake

Status: completed locally on 2026-05-26.

Action:

- Added `docs/INTERACTION_MIDDLEWARE.md` as a current-main ChannelHub operations
  map.
- Linked it from `docs/DOCUMENTATION_INDEX.md`.
- Documented implemented-vs-not-implemented boundaries for inbound routes,
  admin operations, security, state, and validation.

Validation:

- Rewritten from current `server.js`, `modules/channelHub/**`,
  `routes/internal/channelHub.js`, `routes/admin/channelHub.js`, schemas, and
  tests.
- `node --test tests/channelHub-hardening.test.js` passed locally.
- Dirty worktree interaction-middleware docs were not copied.

Remaining risk:

- No live platform webhook or ChannelHub runtime call was made.
- This package is documentation-only.

## D4E Execution - CodexMemoryBridge i18n/API Contract Review

Status: completed locally on 2026-05-26.

Action:

- Rejected direct intake of the dirty-worktree `.new.js` i18n variant.
- Documented the current knowledge-write response contract in
  `docs/CODEX_MEMORY_BRIDGE.md`.
- Added regression assertions to `tests/codex-memory-bridge.test.js` for
  `targetDiary=Codex knowledge`, `reason=written to Codex knowledge.`, and the
  canonical storage path under `dailynote/Codex的知识/`.

Decision:

- Keep the durable storage diary localized as `Codex的知识`.
- Keep observable `targetDiary` and `reason` return strings in their current
  English form unless a future explicit API migration is approved.

Validation:

- Dirty worktree sidecar files were not copied.
- Codex memory bridge/e2e/MCP/admin tests passed locally.

Remaining risk:

- No live Codex memory write was performed outside the test temp directory.

## D4F Execution - Noir Architect New-Agent Proposal

Status: completed locally on 2026-05-26.

Action:

- Reviewed current `main` Agent discovery and admin Agent file behavior.
- Confirmed `Agent/Noir Architect.txt` is not present in current `main`.
- Confirmed the dirty candidate exists only in `A:/VCP/VCPToolBox` as an
  untracked prompt draft.
- Added `docs/governance/NOIR_ARCHITECT_AGENT_PROPOSAL_20260526.md` as a
  candidate-only adoption proposal.

Decision:

- Do not add or enable `Agent/Noir Architect.txt` automatically.
- Treat any future adoption as a dedicated user-facing capability package with
  explicit decisions for prompt text, display name, alias registration, safety
  review, UI/listing behavior, and validation.

Validation:

- Current `main` Agent directory, `modules/agentManager.js`,
  `routes/admin/agents.js`, and `agent_map.json` absence were checked.
- Dirty candidate was scanned only for conflict markers and secret-like
  patterns; no prompt body was copied.

Remaining risk:

- No live Agent/admin server validation was run.
- No new Agent file was created.

## D4D Execution - VCP Panel Extension Product Proposal

Status: completed locally on 2026-05-26.

Action:

- Reviewed current `main` admin/Agent/RAG route shape.
- Confirmed `vcp-panel-extension/**` is absent from current `main`.
- Confirmed the dirty candidate is a 4-file VS Code webview prototype under
  `A:/VCP/VCPToolBox/vcp-panel-extension/**`.
- Added `docs/governance/VCP_PANEL_EXTENSION_PRODUCT_PROPOSAL_20260526.md` as
  a standalone product proposal.

Decision:

- Do not add `vcp-panel-extension/**` automatically.
- Treat any future adoption as a separate editor-extension product package with
  explicit API contract, auth, webview CSP, packaging, and validation decisions.

Validation:

- Dirty candidate files, package metadata, localhost/API-path assumptions,
  webview/CSP references, and current `main` admin route prefixes were checked.
- Dirty candidate was scanned only for conflict markers and secret-like
  patterns; no extension source body was copied.

Remaining risk:

- No VS Code extension host was started.
- No extension package was built or installed.
- No live VCP server was called.
