# Installation and operations

## Requirements

Use Node 20.20.2 or Node 22.21.1 (or compatible releases in those major versions), and a VCP host with Host Integration v1. This PR includes the required host hooks. The complete media implementation requires Linux/Docker directory handles and /proc/self/fd. Native Windows supports the covered text/local-image paths but rejects new resource staging; do not enable portable test options in production.

## First installation

1. Install the host changes and copy Plugin/TelegramBridge into the host plugin directory.
2. Run npm ci --omit=dev inside the plugin directory on the actual execution platform. Never copy native node_modules between Windows and Linux.
3. Copy config.env.example to config.env only if it does not exist. Replace ExampleAgent with an Agent actually configured on your host; set allowed user IDs, Bot Token and the loopback VCP endpoint/key privately.
4. Set TELEGRAM_MODE=probe and restart/reload the host. Check the plugin status for healthy SQLite, host capability, Telegram identity/webhook and VCP connectivity.
5. Stop any other consumer of this Bot, then set TELEGRAM_MODE=enabled and restart/reload. There must be exactly one enabled poller.
6. Complete ACCEPTANCE.md before treating the installation as ready for daily use.

The plugin is disabled by default and does not need credentials or SQLite to load in that mode. The example Agent name is not a bundled persona. No Agent files, model credentials or private media catalog are included.

## Update and rollback

Stop the plugin and confirm no active requests/deliveries before backing up config.env and the whole state directory, including SQLite WAL files and inbox/outbox. Keep backups private. Preserve configuration and state when replacing code. Install dependencies on the target platform and start in probe mode before enabling polling.

Database migrations are additive but rollback to an older executable is not automatically safe after a schema change. Keep a consistent pre-update backup and use a matching code/state snapshot after reviewing possible external effects. Never automatically replay uncertain requests or overwrite current state with an old archive.

## Troubleshooting

- HOST_INTEGRATION_CONFIG_INVALID / HOST_INTEGRATION_UNAVAILABLE: required host hooks are missing or incompatible.
- Telegram conflict: another poller or webhook is active. Stop it before retrying.
- Native SQLite load failure: install the exact locked dependency on the runtime platform.
- Media rejected: inspect the platform restriction, allowed root, MIME, actual size and DNS/IP checks; do not bypass containment checks.
- needs_review: a request or delivery may already have produced an external effect. Check it manually before retrying.

Do not post tokens, VCP keys, Auth codes, user/chat IDs, chat text, private paths or database dumps in issues. Report fixed diagnostic codes and sanitized reproduction steps.
