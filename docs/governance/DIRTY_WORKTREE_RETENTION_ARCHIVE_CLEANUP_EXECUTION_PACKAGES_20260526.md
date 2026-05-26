# Dirty Worktree Retention / Archive / Cleanup Execution Packages - 2026-05-26

Scope: `A:/VCP/VCPToolBox`, currently a dirty `feature/latest-updates`
worktree.

This document is an execution-package plan only. It does not authorize copying,
archiving, deleting, resetting, cleaning, stashing, moving, pushing, merging, or
touching production/runtime state.

## Current Verified State

- Control worktree: `A:/VCP/VCPToolBox-prod-stable`
- Control branch: `main`
- Control `main` / `origin/main`: synchronized at
  `bb68b42e570af610394743de82d1b13affe05880`
- Dirty worktree: `A:/VCP/VCPToolBox`
- Dirty branch: `feature/latest-updates`
- Dirty HEAD: `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`
- Dirty upstream: `origin/feature/latest-updates`
- Dirty upstream comparison: `10 / 15`
- Dirty entries: `260`
- Tracked dirty entries: `41`
- Untracked entries: `219`
- Modified-like tracked entries: `28`
- Deleted-like tracked entries: `13`
- Files with conflict markers by filename scan: `4`
- Files matching secret/config-like patterns by filename-only scan: `73`

Largest top-level dirty groups:

| Group | Count |
| --- | ---: |
| `Plugin` | `118` |
| `docs` | `32` |
| `VectorStore_bge1024_backup_20260422-123654` | `21` |
| `VectorStore_bge1024` | `21` |
| `state` | `17` |
| `.claude` | `10` |
| `.agent_board` | `6` |
| `VCPChat` | `5` |
| `vcp-panel-extension` | `4` |
| `AdminPanel` | `3` |
| `tests` | `3` |
| `Agent` | `2` |

Risk category counts from path/status scan:

| Shape | Count |
| --- | ---: |
| env/config-like paths | `6` |
| sqlite database paths | `12` |
| vector-store paths | `42` |
| runtime/user-state paths | `75` |
| log/cache paths | `19` |
| plugin manifest toggles | `28` |
| generated report paths | `28` |
| source/doc-looking paths | `180` |

## Package R0 - Retain Untouched

Default decision: keep `A:/VCP/VCPToolBox` exactly as it is.

Allowed:

- Read-only status refresh.
- Path-only governance records.
- Sanitized counts and filename-level findings.

Blocked:

- Any edit inside `A:/VCP/VCPToolBox`.
- `git reset`, `git clean`, stash, move, delete, checkout, or branch switch in
  that worktree.
- Copying file contents into `main`, especially from runtime/config/state paths.

Success criteria:

- Dirty worktree remains on `feature/latest-updates`.
- Dirty files remain untouched.
- Governance records stay path-only and sanitized.

## Package R1 - Path-Only Preservation Manifest

Status: safe and already represented by existing governance docs.

Action:

- Preserve path names, counts, categories, and decisions in `main`.
- Do not preserve file contents.

Evidence sources:

- `docs/governance/DIRTY_WORKTREE_PRESERVATION_MANIFEST_20260526.md`
- `docs/governance/DIRTY_WORKTREE_STRATEGY_PACKAGES_20260526.md`
- This execution package document.

Validation:

- Confirm control `main` is clean before editing docs.
- Confirm no sensitive values appear in governance diffs.

## Package A0 - No Archive By Default

Default decision: do not create an archive yet.

Reason:

- The dirty worktree contains env/config paths, sqlite databases, vector stores,
  runtime state, logs, caches, generated reports, and conflict-marked files.
- A broad archive risks preserving secrets, private runtime data, or unstable
  generated output in the wrong location.

## Package A1 - Archive Planning Only

Action: produce a path-level archive manifest without copying files.

Allowed:

- List candidate source/doc paths by filename.
- List excluded paths by category and count.
- Define an archive destination outside source-intake areas.

Blocked:

- Creating zip/tar files.
- Copying dirty files.
- Hashing or reading contents of secret/runtime-heavy paths.

Required destination rule for any later archive:

- Destination must be outside `A:/VCP/VCPToolBox` and outside
  `A:/VCP/VCPToolBox-prod-stable`.
- Destination must be named explicitly before execution.

## Package A2 - Archive Execution

Status: blocked until explicitly approved.

Allowed inclusion set after approval:

- Candidate-only source/doc paths that pass conflict-marker and secret-pattern
  screening.
- Small standalone helper scripts or docs after exact path review.
- Product proposal material only when it is not runtime/generated/sensitive.

Default exclusion set:

- `**/config.env`
- `.env` and env-like files
- `*.sqlite*`
- `VectorStore_*`
- `state/**`
- `.claude/**`
- `VCPChat/**`
- `Plugin/*/state/**`
- `Plugin/*/log/**`
- `Plugin/*/dailynote/**`
- `__pycache__/**`
- generated DingTalk reports
- plugin manifest toggle pairs
- files with unresolved conflict markers
- files matching secret/config-like patterns unless separately sanitized

Minimum preflight before execution:

1. Exact destination path.
2. Exact inclusion path list.
3. Exact exclusion rules.
4. Dry-run file count.
5. Sensitive-pattern scan result over the inclusion list.
6. Rollback path for deleting the archive artifact if it is wrong.

## Package C0 - No Cleanup By Default

Default decision: delete nothing.

Reason:

- The worktree is user-owned by policy.
- The dirty set contains runtime data and possible secrets.
- Some paths are feature candidates, some are generated/runtime artifacts, and
  some are manifest toggles that affect capability enablement.

## Package C1 - Cleanup Preflight Only

Action: prepare an exact cleanup candidate list without deleting anything.

Allowed:

- Path-level cleanup candidate list.
- Per-path reason.
- Dependency on archive/retention decision.

Blocked:

- Removing files.
- Running `git clean`.
- Running `git reset`.
- Deleting branches or worktrees.

Cleanup candidate classes for future review:

- Generated reports if reproducible and explicitly excluded from preservation.
- Logs/caches if not needed and not secret-bearing.
- Sidecar experiment files already rejected by C1-C6/D4 reviews.
- Stale local helper scripts only after exact path approval.

Never-clean classes without separate high-confidence backup decision:

- env/config paths
- sqlite databases
- vector stores
- runtime state
- `.claude/**`
- `VCPChat/**`
- daily notes
- plugin state
- manifest toggles
- conflict-marked source files

## Package C2 - Cleanup Execution

Status: blocked until explicitly approved.

Required approval wording:

- Exact worktree path.
- Exact target paths or refs.
- Exact operation.
- Confirmation that archive/retention decision has been made.

Forbidden broad commands:

- `git reset --hard`
- `git clean -fd`
- `git clean -fdx`
- recursive deletion of the whole dirty worktree
- deleting `feature/latest-updates` while the dirty worktree exists

## Recommended Order

1. Keep `A:/VCP/VCPToolBox` untouched.
2. If more evidence is needed, run Package A1 archive planning only.
3. If preservation is required, approve Package A2 with exact destination and
   inclusion/exclusion lists.
4. Only after preservation, approve Package C1 cleanup preflight.
5. Only after C1 is reviewed, approve Package C2 cleanup execution with exact
   paths.

## Current Recommendation

Do not archive or clean yet.

The safest current state is:

- `main` / `origin/main` remains the source of truth.
- `A:/VCP/VCPToolBox` remains untouched as a dirty preservation object.
- Future value extraction happens as small rewrites against current `main`, not
  by copying dirty files.
