# VCP Panel Extension Product Proposal - 2026-05-26

Scope: D4D follow-up for the dirty worktree candidate
`A:/VCP/VCPToolBox/vcp-panel-extension/**`.

This is a product/governance proposal only. It does not add, enable, package,
publish, copy, archive, delete, or modify any VS Code extension source.

## Verified Current State

- Control worktree: `A:/VCP/VCPToolBox-prod-stable`
- Control branch: `main`
- Current `main` does not contain `vcp-panel-extension/**`.
- Current admin APIs are mounted under `/admin_api`.
- Current Agent admin APIs include:
  - `GET /admin_api/agents`
  - `GET /admin_api/agents/map`
  - `POST /admin_api/agents/map`
  - `GET /admin_api/agents/:fileName`
  - `POST /admin_api/agents/:fileName`
  - `POST /admin_api/agents/new-file`
- Current RAG/admin tuning APIs include `/admin_api/rag-params`,
  `/admin_api/rag-tags`, `/admin_api/available-clusters`, semantic-group
  routes, thinking-chain routes, and daily-note search routes.

## Dirty Candidate Read-Only Check

Dirty candidate files observed:

- `vcp-panel-extension/package.json`
- `vcp-panel-extension/extension.js`
- `vcp-panel-extension/README.md`
- `vcp-panel-extension/webview-ui/assets/icon.svg`

Observed prototype traits:

- VS Code extension manifest uses `main=extension.js` and contributes a webview
  view under `vcp-panel-container`.
- Default server URL is `http://localhost:5050`.
- README and inline webview calls reference `/api/agents/active`,
  `/api/agents/activate`, `/api/agents/map`, `/api/rag/search`, and
  `/api/rag/stats`.
- Current `main` does not expose those `/api/agents/*` and `/api/rag/*` routes
  as documented by the prototype.
- The webview CSP permits local HTTP connections and inline script/style.
- No unresolved conflict marker or real secret-like value was found in the
  targeted dirty candidate scan.

No dirty extension source body was copied into this proposal.

## Decision

Do not add `vcp-panel-extension/**` to `main` automatically.

Reason:

- This is a standalone editor-extension product surface, not a branch-cleanup or
  source-absorption artifact.
- The prototype assumes API paths that do not match the current `main` admin
  route contract.
- Publishing or installing an editor extension would create user-visible and
  external-tooling side effects.
- The webview security posture, packaging model, auth model, and endpoint
  contract require a dedicated review before adoption.

## Future Product Requirements

If a VCP editor panel is desired, treat it as a separate product package:

1. Decide whether the target is VS Code, VCPcode, or both.
2. Define the supported server URL configuration model.
3. Map all extension calls to current `main` APIs or introduce approved
   compatibility routes deliberately.
4. Decide how admin authentication, cookies, tokens, or local trust are handled.
5. Replace `/api/agents/*` and `/api/rag/*` assumptions with verified contracts.
6. Review webview CSP, command registration, local network access, and message
   passing.
7. Add a build/package validation path for the extension.
8. Add a no-live-server test or mocked API contract test before source intake.
9. Require explicit approval before adding extension source, installing it into
   a user editor profile, publishing it, or pushing a related commit.

## Validation Notes

Local checks performed for this proposal:

- Listed dirty candidate files under `A:/VCP/VCPToolBox/vcp-panel-extension`.
- Inspected the dirty `package.json` metadata.
- Searched the dirty candidate for API-path, localhost, webview, and CSP usage.
- Searched current `main` for mounted admin, Agent, RAG, ChannelHub, and tool
  execution routes.
- Ran a targeted conflict-marker and secret-like pattern scan on the dirty
  candidate path.

Not validated:

- No VS Code extension host was started.
- No extension package was built.
- No webview was rendered.
- No live VCP server was called.
- No dirty worktree file was modified.
- No remote write was performed.
