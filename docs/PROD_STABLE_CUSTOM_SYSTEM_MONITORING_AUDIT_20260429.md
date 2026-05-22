# prod/stable custom System Monitoring Audit - 2026-04-29

## Summary

Phase 4 scope: review `origin/custom` system monitoring route changes without merging the branch wholesale.

Base reviewed:

- `origin/prod/stable`: `d753d86` (`Merge pull request #28`)
- `origin/custom`: `6f83d92` (`Update package dependencies and refactor system monitoring routes`)

Decision: do not absorb the `origin/custom` system monitoring slice as-is.

The useful idea is to make process monitoring work when VCPToolBox is not launched under PM2. The stable implementation should preserve the existing PM2 contract and add a local read-only fallback, rather than replacing the endpoint or importing unrelated package, Docker, AdminPanel, plugin, and runtime data changes.

## Scope

Reviewed files and paths:

- `routes/admin/system.js`
- `AdminPanel/js/dashboard.js`
- `AdminPanel-Vue/src/api/system.ts`
- `AdminPanel-Vue/src/components/dashboard/ProcessCard.vue`
- `AdminPanel-Vue/src/composables/useDashboardState.ts`
- `package.json`
- `Dockerfile`
- `server.js`

## Findings

### System Route

`origin/custom` changes the process endpoint from `/system-monitor/pm2/processes` to `/system-monitor/processes` and returns a snapshot of the current Node process.

Assessment: useful direction, but not safe to copy directly. The endpoint rename would break the stable AdminPanel-Vue API client, which still calls `/admin_api/system-monitor/pm2/processes`.

### PM2 Dependency And Package Scripts

The custom `package.json` diff removes the stable test matrix scripts and removes `pm2`.

Assessment: do not absorb. The stable production line intentionally keeps `pm2` because the Docker runtime uses `pm2-runtime`, and the root test scripts are part of the prod/stable validation gate.

### AdminPanel Surface

The custom branch adds an older `AdminPanel/js/dashboard.js` file, while `prod/stable` uses the rebuilt `AdminPanel-Vue` surface.

Assessment: do not absorb. Any monitoring UI change should be made in `AdminPanel-Vue` and rebuilt from stable-line source.

### Mixed Commit Risk

The same custom commit also touches Dockerfile, IMAPIndex, RAGDiaryPlugin, WebSocketServer, dailynote runtime files, and broad dependency state.

Assessment: do not absorb. This is too mixed for a stable production line PR.

## Implemented Stable-Line Rebuild

This PR keeps the existing PM2 endpoint and adds a narrow, read-only fallback:

- Adds `/admin_api/system-monitor/processes` for the current VCP process snapshot.
- Keeps `/admin_api/system-monitor/pm2/processes` compatible.
- Falls back to the current VCP process snapshot when PM2 is unavailable or returns no process list.
- Does not remove `pm2`.
- Does not change Docker behavior.
- Does not change AdminPanel-Vue UI copy or build artifacts.
- Does not add external writes, production flags, or runtime data.

## Validation

Planned validation:

- `node --test tests/system-monitor-routes.test.js`
- `npm run test:baseline`
- `npm test`

No production flags were enabled, no deployment was performed, and no external service writes were introduced.
