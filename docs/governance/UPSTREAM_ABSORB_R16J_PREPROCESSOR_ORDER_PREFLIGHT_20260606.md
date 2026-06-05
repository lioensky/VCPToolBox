# Upstream Absorb R16J Preprocessor Order Preflight - 2026-06-06

本文件记录对 upstream commit `f3aa67ee 更新配置表` 的只读 preflight 评估。

本 preflight 不吸收代码，不提交 `preprocessor_order.json`，不启动服务，不触发插件热重载。

## 1. Scope

| Item | Value |
|------|-------|
| Local target | `main` |
| Upstream commit | `f3aa67ee5ed74ba53e91257a7d2d899bbc651ec3` |
| Upstream change | Add `preprocessor_order.json` |
| Local files inspected | `preprocessor_order.json`, `Plugin.js`, `routes/admin/plugins.js`, `Plugin/*/plugin-manifest.json` |
| Proposed local change in this package | Documentation only |

## 2. Upstream Payload

The upstream commit adds a root-level `preprocessor_order.json` with this order:

```json
[
  "VCPTavern",
  "ImageProcessor",
  "RAGDiaryPlugin",
  "OneRing",
  "ContextFoldingV2"
]
```

The commit contains no code changes and no tests.

## 3. Local Reality

The local repository already has `preprocessor_order.json`:

```json
[
  "RAGDiaryPlugin",
  "ContextFoldingV2",
  "CapturePreprocessor",
  "WorkspaceInjector",
  "VCPTavern",
  "ImageProcessor"
]
```

Local consumers:

| File | Behavior |
|------|----------|
| `Plugin.js` | Reads `preprocessor_order.json`, keeps entries that match available preprocessors, appends remaining available preprocessors sorted by name, then uses the final order for message preprocessors and module initialization. |
| `routes/admin/plugins.js` | `GET /admin_api/preprocessors/order` returns the active order; `POST /admin_api/preprocessors/order` writes `preprocessor_order.json` and hot-reloads plugins/order. |
| `AdminPanel-Vue/src/features/preprocessor-order-manager/usePreprocessorOrderManager.ts` | UI feature for reading/saving the order via admin APIs. |

Local plugin presence check:

| Plugin | Present locally |
|--------|-----------------|
| `RAGDiaryPlugin` | yes |
| `ContextFoldingV2` | yes |
| `CapturePreprocessor` | yes |
| `WorkspaceInjector` | yes |
| `VCPTavern` | yes |
| `ImageProcessor` | yes |
| `OneRing` | no |

## 4. Risk Assessment

`preprocessor_order.json` is runtime-order configuration, not a harmless example file.

Directly replacing the local file with the upstream payload would:

- remove local `CapturePreprocessor` and `WorkspaceInjector` from the explicit saved order;
- introduce `OneRing`, which is not present locally and belongs to the separately deferred OneRing upstream group;
- reorder `VCPTavern` and `ImageProcessor` before `RAGDiaryPlugin` / `ContextFoldingV2`;
- change plugin initialization order because `Plugin.js` reuses `preprocessorOrder` as the front of `initializationOrder`;
- create operator-visible behavior changes through admin preprocessor order APIs;
- write a default runtime state file, which is outside safe raw-merge scope.

Although `Plugin.js` filters unavailable names before applying the order, adding `OneRing` to the default file would still encode a dependency on a deferred system and make later OneRing absorption less explicit.

## 5. Recommendation

Do not raw-merge upstream `preprocessor_order.json`.

Recommended handling:

1. Keep the local `preprocessor_order.json` unchanged in this absorption lane.
2. Treat `f3aa67ee` as not directly absorbable because it is default runtime-order configuration.
3. If a future package needs to change preprocessor order, make it an explicit operator-facing design package with:
   - source plugin presence checks;
   - before/after order diff;
   - compatibility notes for `CapturePreprocessor` and `WorkspaceInjector`;
   - no implicit OneRing dependency unless OneRing itself has been accepted.
4. If documentation is desired, consider a separate example or admin guide note instead of committing a new default order.

## 6. Validation Performed

Read-only commands used:

```powershell
git show --stat --oneline f3aa67ee
git show --format=medium --name-status f3aa67ee
git show f3aa67ee:preprocessor_order.json
Test-Path preprocessor_order.json
rg -n "preprocessor_order|preprocessor order|preprocessorOrder|preprocessor.*order" .
```

Static code points inspected:

```powershell
Plugin.js
routes/admin/plugins.js
preprocessor_order.json
Plugin/*/plugin-manifest.json
```

No service startup, plugin hot reload, real admin API write, runtime write, database operation, vector rebuild, or external call was run.

## 7. Preflight Result

`f3aa67ee` should remain deferred for raw absorption.

This preflight package should only add this document. It must not stage or commit `preprocessor_order.json`.
