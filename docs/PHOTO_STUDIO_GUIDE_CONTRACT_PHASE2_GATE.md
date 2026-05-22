# Photo Studio Guide Contract Phase 2 Gate

This note records the `prod/stable` runtime gate for the first Photo Studio guide-contract absorption batch.

## Enabled Scope

The first stable-line cut enables only the P0/P1/P2 local-only workflow:

- `create_customer_record`
- `create_project_record`
- `update_project_status`
- `create_project_tasks`
- `generate_client_reply_draft`
- `create_followup_reminder`
- `create_delivery_tasks`
- `create_selection_notice`
- `archive_project_assets`
- `sync_calendar_event`

These plugins write only to the configured Photo Studio local data root and keep the migrated `plugins/custom/.../plugin.json` contract shape.

## Deferred Scope

The following contracts stay present for code review and tests but are disabled in `plugins/registry.json`, so `PluginManager` does not runtime-discover them on `prod/stable`:

- P3 audit/reporting and external sync:
  - `check_missing_project_fields`
  - `generate_weekly_project_digest`
  - `sync_to_external_sheet_or_notion`
- P5 external delivery queue:
  - `process_external_delivery_queue`
- P6 reporting:
  - `generate_delivery_operator_report`
  - `inspect_delivery_audit_trail`
- P7 scheduling:
  - `generate_delivery_queue_schedule`
  - `prioritize_pending_delivery_actions`

## Safety Rule

Do not enable deferred plugins in `prod/stable` without a separate PR that proves:

- default behavior remains local-only or dry-run
- live external writes require explicit runtime configuration
- no credentials, runtime state, database files, or external delivery outputs are committed
- `npm run test:baseline`, `npm test`, `npm run test:photo-studio`, and Docker build pass
