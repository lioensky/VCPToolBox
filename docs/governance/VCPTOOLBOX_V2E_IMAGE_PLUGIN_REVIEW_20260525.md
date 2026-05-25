# Package V2E Review: Image / Plugin Source

Review time: 2026-05-25 18:30 Asia/Shanghai.

Worktree reviewed: `A:/VCP/VCPToolBox`.

Baseline: current `origin/main` at `55b51ca`.

Scope:

- `Plugin/DeepWikiVCP/deepwiki_vcp.js`
- `Plugin/DeepWikiVCP/plugin-manifest.json`
- `Plugin/ZImageGen/ZImageGen.mjs`
- `Plugin/ZImageGen2/ZImageGen.mjs`
- `Plugin/vcp-onebot-adapter/README.md`

This was a read-only review. No image generation, plugin execution, external fetch, file write, or branch merge was performed.

## 1. Summary

Do not migrate Package V2E wholesale into current `main`.

The dirty worktree contains mixed plugin-source edits, but current `main` already has newer or more appropriate implementations in several areas.

## 2. DeepWikiVCP

Dirty worktree diff shape:

- Adds `Plugin/DeepWikiVCP/deepwiki_vcp.js`.
- Rewrites `Plugin/DeepWikiVCP/plugin-manifest.json` from current main's `DeepWikiVCP.js` API-oriented plugin to a simpler `deepwiki_vcp.js` scraper.

Current `main` state:

- Uses `Plugin/DeepWikiVCP/DeepWikiVCP.js`.
- Manifest version is `2.1.0`.
- Supports `wiki_structure`, `wiki_content`, and `wiki_ask`.
- Has proxy/token config schema fields.

Decision: reject migration.

Reason: the dirty worktree version would downgrade current `main` from the newer DeepWiki API/MCP-style plugin to a narrower scraper entrypoint with reduced capabilities and shorter timeout.

## 3. ZImageGen / ZImageGen2

Dirty worktree diff shape:

- Adds `createRequire`.
- Lazily loads `Plugin/ImageRatingManager/image-rating-manager.js`.
- Calls `initDatabase()`.
- After generating an image, calls `registerImage(...)` and `setRating(..., 0, '待评分')`.

Current `main` state:

- Already contains `Plugin/ImageRatingManager/**`.
- `ImageRatingManager` writes to `image_ratings.sqlite`.
- `ZImageGen` and `ZImageGen2` generate and save images, but do not automatically register images into the rating database.

Decision: defer, do not migrate as part of branch cleanup.

Reason: this is a real behavior change that adds runtime database writes during image generation. It may be useful, but it changes side effects and should be implemented as a separate reviewed package with tests around failure isolation and database/runtime paths.

Suggested future package:

- Add optional image-rating auto-registration behind an explicit config flag.
- Ensure image generation still succeeds if rating registration fails.
- Keep runtime sqlite files out of Git.
- Add tests with a temporary data root or mocked rating manager.

## 4. vcp-onebot-adapter README

Dirty worktree diff shape:

- Adds docs index link.
- Changes documented ChannelHub URL from `/internal/channelHub/events` to `/internal/channel-hub/events`.
- Adds docs for session binding, proactive sender, markdown conversion, examples, scripts, and tests.

Current `main` state:

- Tracks `Plugin/vcp-onebot-adapter/docs/**` already.
- Current code references `/internal/channelHub/events`, not `/internal/channel-hub/events`.

Decision: reject as-is, possibly cherry-pick docs-index idea later.

Reason: the README change includes a likely stale/incorrect route path and documents files/features that need verification against current adapter code. It should not be absorbed without a docs/code consistency pass.

## 5. Decision Table

| Area | Decision | Reason |
| --- | --- | --- |
| `DeepWikiVCP` scraper replacement | Reject | Downgrades current `DeepWikiVCP.js` capabilities and manifest. |
| `ZImageGen` rating auto-register | Defer | Adds runtime sqlite writes; needs explicit config and tests. |
| `ZImageGen2` rating auto-register | Defer | Same side-effect risk as `ZImageGen`. |
| `vcp-onebot-adapter` README | Reject as-is | Contains likely stale route path and unverified feature docs. |

## 6. Final Recommendation

Status: V2E complete.

Do not migrate V2E files from `A:/VCP/VCPToolBox` into current `main`.

Remaining useful ideas should become separate future packages:

- `ImageRating auto-register for ZImageGen/ZImageGen2`
- `OneBot README/current-code docs repair`

Neither should block branch/worktree governance.
