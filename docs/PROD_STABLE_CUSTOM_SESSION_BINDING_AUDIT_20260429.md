# prod/stable custom SessionBinding / AdapterContract Audit - 2026-04-29

## Summary

Phase 4 scope: review `origin/custom` for a narrowly scoped ChannelHub SessionBinding / AdapterContract candidate without merging the branch wholesale.

Base reviewed:

- `origin/prod/stable`: `c9145dc` (`Merge pull request #25`)
- `origin/custom`: `6f83d92` (`Update package dependencies and refactor system monitoring routes`)

Decision: do not absorb the `origin/custom` SessionBinding / AdapterContract slice into `prod/stable`.

The stable line already contains the useful SessionBinding and AdapterContract behavior, while the `origin/custom` slice introduces regressions in adapter identity resolution, endpoint compatibility, media transcode behavior, and repository hygiene.

## Scope

Reviewed files:

- `modules/channelHub/AdapterContract.js`
- `modules/channelHub/SessionBindingStore.js`
- `modules/channelHub/AdapterAuthManager.js`
- `modules/channelHub/MediaGateway.js`
- `routes/internal/channelHub.js`
- `tests/channelHub-hardening.test.js`

Also noted but not absorbed:

- `modules/channelHub/SessionBindingStore.js.bak`
- `modules/channelHub/SessionBindingStore（33）.js`

## Findings

### AdapterContract

`AdapterContract.js` has no effective difference between `origin/prod/stable` and `origin/custom` when whitespace is ignored.

Assessment: no migration value.

### SessionBindingStore

`SessionBindingStore.js` has no effective behavioral difference when whitespace is ignored. The stable line already preserves:

- `bindingKey`
- `externalSessionKey`
- `sessionWebhook`
- `sessionWebhookExpiredTime`
- `topicId`
- `agentId`
- tombstone-style delete compatibility
- `findByExternal(adapterId, externalSessionKey)`

`origin/custom` also adds backup/duplicate files:

- `modules/channelHub/SessionBindingStore.js.bak`
- `modules/channelHub/SessionBindingStore（33）.js`

Assessment: no migration value, and the backup/duplicate files are repository pollution for `prod/stable`.

### Adapter Auth

`origin/custom` weakens stable auth handling by removing the case-insensitive `_getHeader()` helper and dropping some accepted secret / whitelist locations, including `credentials.*` and `webhook.ipWhitelist`.

Assessment: do not absorb. The stable implementation is more tolerant of real HTTP header casing and more compatible with existing adapter credential layouts.

### Internal ChannelHub Routes

`origin/custom` removes the stable adapter resolution path:

- `normalizeChannelName()`
- `inferChannelFromRequest()`
- `getExplicitAdapterId()`
- `isB1CompatRequest()`
- `resolveAdapterContext()`

It also replaces fail-closed behavior with defaults such as `${channel}-default` or `unknown-adapter`, and allows signature validation to continue when an adapter is not found.

Assessment: do not absorb. This would weaken the stable production boundary for adapter identity and ambiguous channel handling.

### Endpoint Rename

`origin/custom` changes references from:

- `/internal/channelHub/events`

to:

- `/internal/channel-hub/events`

This is a wider compatibility decision, not a SessionBinding feature. It would require a separate alias/migration plan if needed.

Assessment: do not absorb as part of this slice.

### MediaGateway

`origin/custom` removes the implemented transcode path and replaces it with a TODO that throws `MediaError('转码功能尚未实现')`.

Assessment: out of scope and regressive for stable.

### Tests

`origin/custom` adjusts tests to match the weaker adapter resolution behavior and endpoint rename. These test edits should not be migrated without a separate endpoint and security contract review.

## Decision

No code should be migrated from `origin/custom` for this Phase 4 slice.

Safe follow-up options:

1. Keep stable ChannelHub SessionBinding / AdapterContract unchanged.
2. If `/internal/channel-hub/*` compatibility is desired, design it as an additive alias PR that preserves `/internal/channelHub/*`, adapter resolution, raw body forwarding, and fail-closed security behavior.
3. Continue Phase 4 with the next candidate theme: SheetAI / FileOperator audit, using the same no-wholesale-merge policy.

## Validation

This audit is based on read-only diffs only. No production flags were enabled, no deployment was performed, and no external service writes were introduced.

