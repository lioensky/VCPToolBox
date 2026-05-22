## Summary

<!-- Describe the change. -->

## Scope

- [ ] Source / docs / tests only
- [ ] No real `config.env`, `.env*`, token, key, or credential changes
- [ ] No runtime data, generated images, logs, cache, vector store, or plugin state added
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

<!-- Add risks, deferrals, or reviewer context. -->
