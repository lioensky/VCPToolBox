# Dirty Worktree Remaining 213 Reassessment - 2026-05-26

Scope: read-only reassessment after A3-C1 cleanup and A3-C2 tracked restore for
dirty worktree `A:/VCP/VCPToolBox`.

This document is evidence and planning only. It does not authorize deleting,
restoring, resetting, cleaning, archiving, changing branches, pushing, or
touching production/runtime state.

## Current Verified State

- Control worktree: `A:/VCP/VCPToolBox-prod-stable`
- Control branch: `main`
- Control `main` / `origin/main`: synchronized at
  `a62d637614a63d34dc37e3f525832916c05d8ae5`
- Dirty worktree: `A:/VCP/VCPToolBox`
- Dirty branch: `feature/latest-updates`
- Dirty HEAD: `a82c8f20631b8a6dff32e237e73b313c2ea5cb60`
- Dirty upstream comparison: `10 / 15`
- Dirty status count after A3-C1 and A3-C2: `213`

## Recent Closed Packages

- A2 archive created and verified.
- A3-C1 deleted `39` archived untracked files.
- A3-C2 restored `8` archived tracked modified files.
- After those packages, no C1/C2 path remains in dirty status.

## Status Summary

Parsed with `git status --porcelain=v1 -z --untracked-files=all`.

```text
Total dirty entries 213
Tracked entries     33
Untracked entries   180
Deleted entries     13
Modified entries    20
```

Status code counts:

```text
 D 13
 M 20
?? 180
```

## Category Counts

```text
protected-secret-runtime-data 128
generated-report-log-cache    41
manifest-toggle-review        28
blocked-a2-excluded           9
retain-review-unarchived      7
```

There is no remaining low-risk archived-untracked or archived-tracked cleanup
bucket from A2. Further cleanup requires new package-specific decisions.

## Blocked B1 - A2 Excluded Paths

Count: `9`

These remain blocked because they were excluded from A2 archive or had
path/status ambiguity. Do not clean them automatically.

```text
 M 一键启动服务器start_server.bat
 M AdminPanel/index.html
 M AdminPanel/script.js
 M AdminPanel/style.css
 M EmbeddingUtils.js
?? Plugin/DeepWikiVCP/package-lock.json
 M Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js
?? Plugin/vcp-dingtalk-adapter/CUsers617Desktoptools_response.json
 M server.js
```

Suggested next handling: source/security review only. Do not delete or restore
without a new dedicated plan.

## Protected P1 - Secret, Config, Runtime, And Data

Count: `128`

This bucket includes env/config-like paths, `.claude/**`, `state/**`,
`dailynote/**`, `VCPChat/**`, SQLite files, and vector-store files. It remains
protected from automatic cleanup.

Largest prefixes:

```text
Plugin/DingTalkCLI/state/**                         34
state/channelHub/**                                 16
.claude/**                                          10
Plugin/DailyNote/dailynote/**                       9
VCPChat/**                                          5
Plugin/ImageRatingManager/*.sqlite*                 3
Plugin/ImageProcessor/*.sqlite*                     3
VectorStore_bge1024/**                              multiple single-file entries
VectorStore_bge1024_backup_20260422-123654/**       multiple single-file entries
```

Suggested next handling: no cleanup unless there is a separate runtime-data
retention or backup policy.

## Generated G1 - Reports, Logs, And Cache

Count: `41`

```text
docs/dingtalk-cli/reports/**        28
Plugin/FlashDeepSearch/log/**       11
Plugin/DoubaoGen/.doubao_api_cache.json
Plugin/Randomness/__pycache__/**
```

Suggested next handling: a future generated-artifact cleanup package could be
prepared, but it needs either an archive policy or a regenerate policy first.

## Manifest M1 - Plugin Manifest Toggle Review

Count: `28`

These are plugin enable/disable state changes and must not be cleaned
mechanically.

```text
?? Plugin/DailyNoteManager/plugin-manifest.json
 D Plugin/DailyNoteManager/plugin-manifest.json.block
 M Plugin/DeepWikiVCP/plugin-manifest.json
?? Plugin/DingTalkTable/plugin-manifest.json
 D Plugin/GeminiImageGen/plugin-manifest.json
?? Plugin/GeminiImageGen/plugin-manifest.json.block
 D Plugin/GoogleSearch/plugin-manifest.json
?? Plugin/GoogleSearch/plugin-manifest.json.block
 D Plugin/GrokVideo/plugin-manifest.json
?? Plugin/GrokVideo/plugin-manifest.json.block
 D Plugin/JapaneseHelper/plugin-manifest.json
?? Plugin/JapaneseHelper/plugin-manifest.json.block
 D Plugin/NanoBananaGen2/plugin-manifest.json
?? Plugin/NanoBananaGen2/plugin-manifest.json.block
 D Plugin/NanoBananaGenOR/plugin-manifest.json
?? Plugin/NanoBananaGenOR/plugin-manifest.json.block
 D Plugin/NovelAIGen/plugin-manifest.json
?? Plugin/NovelAIGen/plugin-manifest.json.block
 D Plugin/PyCameraCapture/plugin-manifest.json
?? Plugin/PyCameraCapture/plugin-manifest.json.block
 D Plugin/SnowBridge/plugin-manifest.json
?? Plugin/SnowBridge/plugin-manifest.json.block
 D Plugin/SunoGen/plugin-manifest.json
?? Plugin/SunoGen/plugin-manifest.json.block
?? Plugin/SynapsePusher/plugin-manifest.json
 D Plugin/SynapsePusher/plugin-manifest.json.block
?? Plugin/ToolBoxFoldMemo/plugin-manifest.json
 D Plugin/ToolBoxFoldMemo/plugin-manifest.json.block
```

Suggested next handling: plugin-by-plugin enable/disable policy review. Do not
bulk restore or delete.

## Retain Review R1 - Manual Review

Count: `7`

These are not covered by A2 archive and do not fit runtime/generated/manifest
buckets.

```text
 M Plugin/UserAuth/code.bin
 M plugins/custom/reporting/sync_to_external_sheet_or_notion/src/index.js
?? server.js.bak_before_restore_channelhub
 M tests/photo-studio/external-sync.test.js
 M TVStxt/supertool.txt
?? TVStxt/ToolList.txt
?? vcp-panel-extension/webview-ui/assets/icon.svg
```

Suggested next handling: retain by default until a dedicated intake/reject
review is approved.

## Recommended Next Packages

1. Generated artifact package:
   Review whether `docs/dingtalk-cli/reports/**`,
   `Plugin/FlashDeepSearch/log/**`, Doubao cache, and `__pycache__` can be
   archived or regenerated. No action until that policy exists.
2. Manifest toggle package:
   Review each plugin manifest toggle as a behavior decision. No bulk action.
3. Manual retain-review package:
   Review the `7` R1 paths one by one for intake, archive, or reject.
4. Protected/runtime package:
   Leave protected data untouched unless a separate retention/backup policy is
   approved.

## Stop Conditions

Stop before any of:

- deleting or restoring files in `A:/VCP/VCPToolBox`
- `git clean`, `git reset`, broad checkout, or broad restore
- touching env/config/runtime/data paths
- changing plugin manifest toggles
- branch deletion or worktree removal
- push, tag, release, deploy, live DingTalk/MCP/DWS command, or production write
