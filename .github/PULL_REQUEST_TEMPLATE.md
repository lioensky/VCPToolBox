## Summary

<!-- Describe the change. -->

## Scope

- [ ] Source / docs / tests only
- [ ] No real `config.env`, `.env*`, token, key, or credential changes
- [ ] No logs, sqlite/db, vector store, plugin state, auth code, or other hard-deny runtime artifacts added
- [ ] If touching `dailynote/`, `image/`, `AdminPanel-Vue/dist/`, `.agent_board/`, or `docs/governance/`, the reason is explained in Notes
- [ ] No production Flag enabled by default

## Validation

- [ ] `npm run test:baseline`
- [ ] `npm test`
- [ ] `npm run test:photo-studio`
- [ ] `npm run test:dingtalk-cli`
- [ ] Docker build checked or intentionally deferred

## Production Boundary

- [ ] No deployment
- [ ] No image push / package publish
- [ ] No `dws:*` real-service script run
- [ ] No external service write
- [ ] Rollback path is clear

## Notes

<!-- Add risks, deferrals, reviewer context, and any explanation for stable-sensitive tracked areas. -->
