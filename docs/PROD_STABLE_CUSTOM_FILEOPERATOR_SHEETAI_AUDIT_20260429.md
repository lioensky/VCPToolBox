# prod/stable custom FileOperator / SheetAI Audit - 2026-04-29

## Summary

Phase 4 scope: review `origin/custom` for a narrowly scoped FileOperator / SheetAI candidate without merging the branch wholesale.

Base reviewed:

- `origin/prod/stable`: `abb6ab5` (`Merge pull request #27`)
- `origin/custom`: `6f83d92` (`Update package dependencies and refactor system monitoring routes`)

Decision: do not absorb the `origin/custom` FileOperator / SheetAI slice into `prod/stable` as-is.

SheetAI is a useful product direction, but the custom implementation is not ready for the stable production line. It mixes source code, local runtime workbooks, desktop user-data paths, plugin private configuration, one-off test scripts, and broad `server.js` changes in one slice.

## Scope

Reviewed files and paths:

- `Plugin/FileOperator/FileOperator.js`
- `Plugin/FileOperator/plugin-manifest.json`
- `Plugin/FileOperator/config.env`
- `TVStxt/FileToolBox.txt`
- `routes/sheetAIRoutes.js`
- `routes/admin/sheetAI.js`
- `docs/VCP_SHEETAI_MVP.md`
- `server.js`
- `package.json`
- `sheetai/workbooks/*`
- `VCPChat/AppData/UserData/SheetAI/*`
- `test_sheetai_*.js`
- `test_sheetai_create.ps1`

## Findings

### FileOperator

The FileOperator code delta is small, but not an obvious stable-line upgrade:

- Changes the `WriteEscapedFile` escape markers from `ESCAPE` to `exp`.
- Adjusts Markdown table formatting in directory listings.
- Adds `Plugin/FileOperator/config.env`.

Assessment: do not absorb. The escape marker change is user-facing and may break existing prompts/docs. The added `config.env` is explicitly forbidden for stable production commits.

### SheetAI Routes

`routes/sheetAIRoutes.js` implements a local JSON workbook MVP:

- creates/list workbooks
- creates/list sheets
- imports and exports XLSX via `exceljs`
- updates cells
- stores workbook JSON under `SHEETAI_ROOT_PATH` or `process.cwd()/sheetai`

Risks:

- Workbook and sheet IDs from route params are joined into filesystem paths without an explicit resolved-path containment guard.
- The default root writes runtime data into `sheetai/` under the app working directory.
- There is no feature flag or stable production gate around the route.
- The MVP docs mention delete and AI endpoints, but the reviewed route does not implement the full documented surface.
- The route needs dedicated tests before production-line absorption.

Assessment: useful idea, not safe to absorb as-is.

### Runtime Data And Local Paths

`origin/custom` includes runtime/local data:

- `sheetai/workbooks/*`
- `VCPChat/AppData/UserData/SheetAI/*`
- `dailynote/*` FileOperator documentation exports

Assessment: do not absorb. These are runtime/user-data artifacts, not stable source.

### Test Scripts And Secret Safety

`origin/custom` includes ad hoc SheetAI test scripts:

- `test_sheetai_create.ps1`
- `test_sheetai_final.js`
- `test_sheetai_internal.js`
- `test_sheetai_native.js`

One script contains a hard-coded API key value. The value was not copied into this report.

Assessment: do not absorb. Stable-line validation should use committed tests with sanitized fixtures, not local penetration scripts or real credentials.

### Server Integration

The `server.js` diff is very large and unrelated to a narrow SheetAI migration. It also touches ChannelHub mounting and AdminPanel behavior.

Assessment: do not absorb. SheetAI should be introduced through a minimal, feature-gated route mount that preserves existing production defaults.

### Package Changes

The diff includes broad dependency churn in `package.json` / lockfile beyond the SheetAI need.

Assessment: do not absorb as a mixed change. If SheetAI is rebuilt, add only the minimum required dependency set in a dedicated PR.

## Decision

No code should be migrated from `origin/custom` for this Phase 4 slice.

## Safe Follow-Up Plan

If SheetAI should enter `prod/stable`, rebuild it as a new narrow PR instead of cherry-picking `origin/custom`:

1. Add a default-off feature flag such as `ENABLE_SHEETAI_ROUTE=false`.
2. Store data under an explicit local-only runtime directory, and keep sample workbooks out of Git.
3. Add resolved-path containment guards for workbook and sheet paths.
4. Reject invalid workbook and sheet IDs before filesystem access.
5. Add `tests/sheetai/*.test.js` with temporary directories and no real credentials.
6. Mount only `/admin_api/sheetai/*`, preserving existing auth behavior.
7. Avoid broad `server.js`, ChannelHub, AdminPanel, and dependency churn.

## Validation

This audit is based on read-only diffs plus local validation of this docs-only branch. No production flags were enabled, no deployment was performed, and no external service writes were introduced.
