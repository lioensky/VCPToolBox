# NativeSync Service Plugin

Optional VCPToolBox `service` / `direct` plugin for a message-level SQLite journal
and a small text-only mobile PWA. It uses the existing PluginManager lifecycle,
AgentManager and `/v1/chat/completions` execution path. There is no second model
router or history database.

## Enable explicitly

The plugin is disabled unless `NativeSyncEnabled=true`. Disabled loading does not
import SQLite or create storage, including on the existing Node 20 host. Enabling
requires **Node.js 24 or later**; older runtimes fail before creating storage.
This change does not upgrade the repository's Docker image or production runtime.

Use the existing global/plugin configuration mechanism and the accompanying
`config.env.example`. `NativeSyncDataDir` must be an explicit, dedicated absolute
directory. The plugin creates `central.sqlite` and SQLite WAL/SHM files there;
symbolic-link paths and hard-linked databases are rejected. Keep this directory
separate from knowledge-base and other application databases.

Native routes retain the host's existing Bearer authentication:

- `/api/v1/sync/{push,pull,status}`
- `/api/plugins/NativeSync/sync/{push,pull,status}`

The host owns listening and authentication. `SERVER_BIND_HOST=127.0.0.1`
can bind an explicitly private/isolated host; other explicit values are rejected. An unset value preserves existing
listen behavior. The plugin opens no listener of its own.

## Optional mobile UI

See [mobile configuration](mobile/README.md). Install the declared UI packages
with `npm ci --prefix apps/mobile`, then run `npm run build:mobile`. The build
requires a fresh/empty output directory; an optional output path can be passed
after `--`. Generated `mobile-dist` and `node_modules` are not source artifacts.
Configure a trusted HTTPS origin and the existing host/reverse proxy before use.
No particular domain, port, Agent or Topic is built into the feature.

The PWA reads explicitly configured Agent/Topic identities and catalog metadata.
It does not discover or migrate all local VCPChat histories. Initial history
publication and client opt-in remain explicit operations using existing NativeSync
identities; a compatible desktop client is required for desktop synchronization.
No private deployment gateway, SSH provisioning or live configuration is included.

## Persistence and limits

Messages retain their IDs, canonical hashes, revision checks and tombstones.
Pull scans bounded global windows before topic filtering: `nextSeq` is the scanned
position, including empty filtered pages, and is not replaced by `headSeq`.

Mobile requests are durably accepted before execution. Default concurrency is 4
(configurable 1–64), with one execution per Topic and no head-of-line blocking
between Topics. Cancellation retains the Topic lock until cleanup. Shutdown
drains/aborts work through the existing lifecycle and waits for in-flight cleanup.
Queued work and durable preparing/publishing intents recover. Interrupted or
timed-out work with uncertain external effects requires review and is not retried
automatically. Exactly-once external tool effects are not promised.

The timeout defaults to 120000 ms and accepts 1000–300000 ms. Context construction
includes completed predecessor replies and excludes later user submissions.
Canonical/hash provenance is recorded in `SOURCE_PROVENANCE.json`.

This version supports text and explicitly configured Agent topics, not mobile
group execution, attachment transfer or full Agent/model configuration sync.

## Validate

On Node 24+, run `npm run test:native-sync`. Tests use synthetic credentials,
temporary databases and loopback servers. The host integration test copies the
unchanged upstream PluginManager into an isolated fixture with only NativeSync,
and checks HTTPS sessions, native routes, persistence, concurrency and context.
No adjacent VCPChat checkout or historical snapshot commit is required.
