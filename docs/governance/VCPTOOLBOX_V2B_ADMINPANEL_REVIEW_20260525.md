# Package V2B Review: AdminPanel / Operator UI

Review time: 2026-05-25 17:55 Asia/Shanghai.

Worktree reviewed: `A:/VCP/VCPToolBox`.

Baseline: current `origin/main` at `55b51ca`.

Scope:

- `AdminPanel/index.html`
- `AdminPanel/script.js`
- `AdminPanel/style.css`
- `docs/ADMINPANEL_DEVELOPMENT.md`
- `vcp-panel-extension/**`

This was a read-only review. No files in `A:/VCP/VCPToolBox` were modified.

## 1. Summary

Do not migrate Package V2B wholesale into current `main`.

Reason: current `main` has already moved the operator frontend to `AdminPanel-Vue`, and the old static `AdminPanel/index.html`, `AdminPanel/script.js`, and `AdminPanel/style.css` are not present in `origin/main`.

The dirty worktree's tracked AdminPanel changes are therefore not small updates to the current UI. They would restore an old legacy UI surface.

## 2. Diff Shape

Compared with current `origin/main`:

| Path | Status | Size |
| --- | --- | ---: |
| `AdminPanel/index.html` | added relative to `origin/main` | 1788 lines |
| `AdminPanel/script.js` | added relative to `origin/main` | 329 lines |
| `AdminPanel/style.css` | added relative to `origin/main` | 4443 lines |
| `docs/ADMINPANEL_DEVELOPMENT.md` | modified | 16 changed lines |

Local dirty changes against the branch's own HEAD are small and focused on a legacy Codex Memory Monitor entry:

- Add `codex-memory-monitor` navigation entry.
- Import and initialize `initializeCodexMemoryMonitor()`.
- Add legacy CSS for Codex memory cards.
- Add documentation references to `AdminPanel/js/codex-memory-monitor.js`.

## 3. Current Main Already Has The Modern Surface

Current `main` contains the Vue implementation:

- `AdminPanel-Vue/src/app/routes/manifest.ts` has route id `codex-memory-monitor`.
- `AdminPanel-Vue/src/app/routes/components.ts` lazy-loads `@/views/CodexMemoryMonitor.vue`.
- `AdminPanel-Vue/src/api/codexMemory.ts` calls `GET /admin_api/codex-memory/overview`.
- `AdminPanel-Vue/src/views/CodexMemoryMonitor.vue` implements the page.
- `routes/admin/codexMemory.js` and `modules/codexMemoryOverview.js` already exist.

Current docs also explicitly warn that the legacy `AdminPanel/js/codex-memory-monitor.js` surface is not present in current main and should not be restored.

## 4. Decision By Area

| Area | Decision | Rationale |
| --- | --- | --- |
| `AdminPanel/index.html` | Reject migration | Restores legacy static AdminPanel that is absent from current main. |
| `AdminPanel/script.js` | Reject migration | Legacy loader; current UI is Vue route-based. |
| `AdminPanel/style.css` | Reject migration | Legacy CSS surface; current UI has Vue scoped/styles and built assets. |
| `docs/ADMINPANEL_DEVELOPMENT.md` changes | Reject as-is | It documents the legacy monitor path and would mislead future work. |
| `vcp-panel-extension/**` | Do not migrate into main as-is | Standalone VS Code extension prototype with hard-coded local default and API assumptions; needs separate product decision. |

## 5. vcp-panel-extension Notes

The untracked `vcp-panel-extension/` contains 4 files:

- `extension.js`
- `package.json`
- `README.md`
- `webview-ui/assets/icon.svg`

It appears to be a VS Code/VCPcode webview prototype for:

- Agent switching.
- Knowledge-base search.
- Knowledge-base stats.

Observed risk/fit notes:

- Default server URL is `http://localhost:5050`, not aligned with the recent local test ports or documented config-driven runtime.
- It calls `/api/agents/active`, `/api/agents/map`, `/api/agents/activate`, `/api/rag/search`, and `/api/rag/stats`; these need contract verification against current main before adoption.
- CSP permits inline script/style for the webview. That may be acceptable for a prototype but needs review before productizing.
- It is a separate extension product, not a branch-cleanup artifact to silently absorb into `main`.

Recommendation: archive or review as a separate extension proposal. Do not include it in branch cleanup or main migration by default.

## 6. Final Decision

Status: reject tracked V2B AdminPanel migration into current `main`.

Allowed follow-up:

- If operator UI docs need repair, write a fresh `AdminPanel-Vue`-oriented doc update against current `main`.
- If the VS Code panel is desired, open a separate extension design/review package with API contract validation.

Blocked actions:

- Do not copy legacy `AdminPanel/` static files into current `main`.
- Do not restore `AdminPanel/js/codex-memory-monitor.js`.
- Do not migrate `vcp-panel-extension/` without a separate approval and validation plan.

## 7. Next Recommendation

Continue with Package V2C: external reporting and DingTalk review.
