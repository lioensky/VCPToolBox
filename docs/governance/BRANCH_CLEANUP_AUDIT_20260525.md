# VCPToolBox 本地分支清理审计表

> 审计日期：2026-05-25
>
> 审计基准：`main` @ `973723f`
>
> 本文只记录本地分支和 worktree 状态，不授权删除分支、删除 worktree、推送远端或修改远端分支。

## 0. 分类口径

本审计把本地分支按清理风险分成三类，并采用互斥优先级：

1. 占用 worktree 待处理：分支当前被某个 worktree checkout，不能直接删除。即使已经并入 `main`，也需要先处理 worktree。
2. 未并入需复核：未被 worktree 占用，且 `git branch --no-merged main` 仍显示未并入。删除前必须逐项复核。
3. 已并入可清理：未被 worktree 占用，且 `git branch --merged main` 显示已并入。可作为本地分支删除候选，但仍建议先确认远端/用途。

注意：

- 本文的“可清理”只指本地分支候选，不代表可删除远端分支。
- `ahead / behind` 口径为相对当前 `main`，格式为 `分支独有提交数 / main 独有提交数`。
- `dirty files` 是 `git status --short` 的行数，用来提示该 worktree 是否有未提交或未跟踪改动。

## 1. 总览

| 类别 | 数量 | 操作建议 |
| --- | ---: | --- |
| 占用 worktree 待处理 | 13 | 先检查对应目录状态，再决定保留、合并、归档或删除 worktree |
| 未并入需复核（未占用 worktree） | 12 | 逐分支做 `git log main..branch` / `git diff main...branch` 审查 |
| 已并入可清理（未占用 worktree） | 49 | 可作为本地分支删除候选，删除前确认无需保留本地标签/引用 |

## 2. 占用 worktree 待处理

| 分支 | HEAD | 合并状态 | dirty files | worktree |
| --- | --- | --- | ---: | --- |
| `feature/latest-updates` | `a82c8f2` | 未并入 | 94 | `A:/VCP/VCPToolBox` |
| `codex/vcptoolbox-channelhub-core-20260425` | `9f00142` | 未并入 | 0 | `A:/VCP/VCPToolBox-channelhub-core` |
| `codex/vcptoolbox-dingtalk-adapters-20260425` | `e41f243` | 未并入 | 0 | `A:/VCP/VCPToolBox-dingtalk-adapters` |
| `feature/photo-studio-p7-queue-scheduler` | `12b9b4a` | 已并入 | 0 | `A:/VCP/VCPToolBox-main` |
| `codex/vcptoolbox-memory-rag-governance-20260425` | `5e9274e` | 未并入 | 0 | `A:/VCP/VCPToolBox-memory-rag-governance` |
| `lane10-codex-memory-intake-20260425` | `fb17dd0` | 未并入 | 0 | `A:/VCP/VCPToolBox-photo-studio-export` |
| `codex/photo-studio-baserow-provider-batch` | `79911d5` | 未并入 | 3 | `A:/VCP/VCPToolBox-photo-studio-next` |
| `integration/main-absorb-prod-stable-upstream-20260525` | `80ee923` | 已并入 | 0 | `A:/VCP/VCPToolBox-prod-stable` |
| `feature/gov-patch-1a-identity-approval-20260429` | `ba79d73` | 已并入 | 0 | `A:/VCP/VCPToolBox-prod-stable-clean` |
| `feature/gov-patch-2b-effect-classification-20260430` | `5309dd9` | 已并入 | 0 | `A:/VCP/VCPToolBox-prod-stable-phase3-run-clean` |
| `(detached)` | `43a6bbb` | detached | 137 | `A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429` |
| `codex/prod-stable-closeout-check-20260513` | `fe586ce` | 已并入 | 0 | `A:/VCP/VCPToolBox-prod-stable-upstream-gptimagegen-20260429` |
| `main` | `973723f` | 当前基准 | 0 | `A:/VCP/VCPToolBox-staging-custom-integration` |

### Worktree 处理建议

- `feature/latest-updates`：dirty files 为 94，且未并入。先审查工作树改动，禁止直接删除。
- `codex/photo-studio-baserow-provider-batch`：dirty files 为 3，且未并入。先查看这 3 项改动，再决定是否吸收或归档。
- detached worktree `A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429`：dirty files 为 137，风险最高。先单独做状态审计，避免丢失预检产物或本地记录。
- 已并入且干净的 worktree 分支，可以在确认不再需要目录后，先移除 worktree，再删除本地分支。

## 3. 未并入需复核

以下分支未被 worktree 占用，但仍有相对 `main` 的独有提交。删除前必须确认这些提交已被其他路径吸收，或确认为废弃。

| 分支 | HEAD | 日期 | ahead / behind | upstream |
| --- | --- | --- | --- | --- |
| `feature/ai-image-agent-clean-pr` | `fca8f44` | 2026-04-28 | +17 / -374 | `origin/feature/ai-image-agent-clean-pr` |
| `feature/ai-image-pipeline-dgp-refactor` | `546b684` | 2026-04-27 | +2 / -285 |  |
| `feature/ai-image-pipeline-dgp-v2` | `546b684` | 2026-04-27 | +2 / -285 |  |
| `feature/gov-patch-1b-ai-image-request-source-20260430` | `26a43ce` | 2026-04-30 | +1 / -203 | `origin/prod/stable` |
| `feature/gov-patch-1b-execution-context-helper-20260430` | `ba6fce7` | 2026-04-30 | +1 / -203 | `origin/prod/stable` |
| `feature/gov-patch-1b-human-tool-request-source-20260430` | `129fddf` | 2026-04-30 | +1 / -203 | `origin/prod/stable` |
| `feature/gov-patch-1b-snowbridge-request-source-20260430` | `46ac065` | 2026-04-30 | +1 / -203 | `origin/prod/stable` |
| `feature/gov-patch-1b-task-scheduler-request-source-20260430` | `2fa86f2` | 2026-04-30 | +1 / -203 | `origin/prod/stable` |
| `feature/gov-patch-1b-vcptoolbridge-request-source-20260430` | `87505fc` | 2026-04-30 | +1 / -203 | `origin/prod/stable` |
| `feature/photo-studio-guide-contract-migration` | `1e1b0ca` | 2026-04-22 | +11 / -457 | `origin/feature/photo-studio-guide-contract-migration` |
| `feature/photo-studio-next-guide-contract` | `5d01212` | 2026-04-22 | +17 / -457 | `origin/feature/photo-studio-next-guide-contract` |
| `rescue/ai-image-pipeline-mixed-20260427_195303` | `546b684` | 2026-04-27 | +2 / -285 |  |

### 未并入分支复核建议

- `feature/photo-studio-guide-contract-migration` 与 `feature/photo-studio-next-guide-contract` 已在历史 intake 文档中标注为对照线，仍建议再做一次 `git cherry -v main <branch>` 和目录级 diff，确认没有遗留净增量。
- `feature/gov-patch-1b-*` 多数 upstream 指向 `origin/prod/stable`，可能是阶段性切片分支。建议按提交内容与当前治理模块逐项比对。
- `feature/ai-image-pipeline-dgp-refactor`、`feature/ai-image-pipeline-dgp-v2`、`rescue/ai-image-pipeline-mixed-20260427_195303` 指向同一提交 `546b684`，可能可合并成一个复核对象。

## 4. 已并入可清理

以下分支未被 worktree 占用，并且已经并入当前 `main`。它们是本地分支清理候选。

| 分支 | HEAD | 日期 | upstream |
| --- | --- | --- | --- |
| `codex/pr25-adaptive-cache-key-fix` | `c04d860` | 2026-04-29 | `origin/codex/prod-stable-codex-memory-analytics` |
| `codex/prod-stable-actions-node24-20260429` | `f6a71e9` | 2026-04-29 | `origin/codex/prod-stable-actions-node24-20260429` |
| `codex/prod-stable-baseline-hardening` | `03527b8` | 2026-04-28 | `origin/codex/prod-stable-baseline-hardening` |
| `codex/prod-stable-ci-fast-gate` | `6b3bfc1` | 2026-04-29 | `origin/codex/prod-stable-ci-fast-gate` |
| `codex/prod-stable-codex-memory-analytics` | `32fd63d` | 2026-04-29 | `origin/codex/prod-stable-codex-memory-analytics` |
| `codex/prod-stable-custom-fileoperator-sheetai-audit` | `03cdac3` | 2026-04-29 | `origin/codex/prod-stable-custom-fileoperator-sheetai-audit` |
| `codex/prod-stable-custom-session-binding-audit` | `0039861` | 2026-04-29 | `origin/prod/stable` |
| `codex/prod-stable-custom-system-monitoring-audit` | `2b45a91` | 2026-04-29 | `origin/codex/prod-stable-custom-system-monitoring-audit` |
| `codex/prod-stable-deploy-runbook` | `a8d0219` | 2026-04-29 | `origin/codex/prod-stable-deploy-runbook` |
| `codex/prod-stable-dynamic-placeholder-index-20260513` | `10e8dfc` | 2026-05-13 | `origin/prod/stable` |
| `codex/prod-stable-gptimagegen-array-compat-20260513` | `415469f` | 2026-05-13 | `origin/prod/stable` |
| `codex/prod-stable-photo-studio-guide-contract-phase1` | `1a88849` | 2026-04-29 | `origin/codex/prod-stable-photo-studio-guide-contract-phase1` |
| `codex/prod-stable-plugin-registry-route-20260513` | `da9f3dc` | 2026-05-13 | `origin/codex/prod-stable-plugin-registry-route-20260513` |
| `codex/prod-stable-prompt-quote-fix-20260513` | `ff98279` | 2026-05-13 | `origin/codex/prod-stable-prompt-quote-fix-20260513` |
| `codex/prod-stable-upstream-audit-20260513` | `3dec801` | 2026-05-13 | `origin/codex/prod-stable-upstream-audit-20260513` |
| `codex/prod-stable-upstream-gptimagegen-20260429` | `54969d6` | 2026-04-29 | `origin/codex/prod-stable-upstream-gptimagegen-20260429` |
| `codex/prod-stable-upstream-history-anchor-20260429` | `0c1e479` | 2026-04-29 | `origin/codex/prod-stable-upstream-history-anchor-20260429` |
| `codex/prod-stable-upstream-ignore-docs-20260513` | `b678ec5` | 2026-05-13 | `origin/prod/stable` |
| `codex/prod-stable-upstream-safe-sync-20260429` | `724604b` | 2026-04-29 | `origin/codex/prod-stable-upstream-safe-sync-20260429` |
| `codex/prod-stable-upstream-tail-20260429` | `a0f12a4` | 2026-04-29 | `origin/codex/prod-stable-upstream-tail-20260429` |
| `codex/prod-stable-vcptavern-privacy-time-identity-20260513` | `dcd7cbb` | 2026-05-13 | `origin/codex/prod-stable-vcptavern-privacy-time-identity-20260513` |
| `codex/prod-stable-vsearch-network-robustness-20260513` | `4e9221c` | 2026-05-13 | `origin/prod/stable` |
| `feature/ai-image-pipeline-dgp-clean-20260427_195303` | `408462a` | 2026-04-28 | `origin/feature/ai-image-pipeline-dgp-clean-20260427_195303` |
| `feature/gov-1a-identity-approval` | `32fd63d` | 2026-04-29 |  |
| `feature/gov-patch-1a-identity-approval-clean-20260429` | `f815677` | 2026-04-29 | `origin/feature/gov-patch-1a-identity-approval-clean-20260429` |
| `feature/gov-patch-1b-context-observability-rollup-20260430` | `d6b62eb` | 2026-04-30 | `origin/feature/gov-patch-1b-context-observability-rollup-20260430` |
| `feature/gov-patch-1c-approval-evidence-20260430` | `ffafff9` | 2026-04-30 | `origin/feature/gov-patch-1c-approval-evidence-20260430` |
| `feature/gov-patch-1d-identity-evidence-20260430` | `951fcc3` | 2026-04-30 | `origin/feature/gov-patch-1d-identity-evidence-20260430` |
| `feature/gov-patch-1e-approval-args-preview-20260430` | `528af70` | 2026-04-30 | `origin/feature/gov-patch-1e-approval-args-preview-20260430` |
| `feature/gov-patch-1f-execution-context-metadata-20260430` | `e797ff9` | 2026-04-30 | `origin/feature/gov-patch-1f-execution-context-metadata-20260430` |
| `feature/gov-patch-1g-bridge-context-metadata-20260430` | `f4f04cc` | 2026-04-30 | `origin/feature/gov-patch-1g-bridge-context-metadata-20260430` |
| `feature/gov-patch-1h-tool-executor-context-metadata-20260430` | `d048de6` | 2026-04-30 | `origin/feature/gov-patch-1h-tool-executor-context-metadata-20260430` |
| `feature/gov-patch-agents-override-20260430` | `89c4e60` | 2026-04-30 | `origin/prod/stable` |
| `feature/photo-studio-p0-contract-alignment` | `ec5901c` | 2026-04-20 | `origin/feature/photo-studio-p0-contract-alignment` |
| `feature/photo-studio-p0-records` | `b47c8ce` | 2026-04-20 |  |
| `feature/photo-studio-p1-content-pool` | `1d6d2ff` | 2026-04-21 | `origin/feature/photo-studio-p1-content-pool` |
| `feature/photo-studio-p1-ops-closure` | `69a8069` | 2026-04-21 | `origin/feature/photo-studio-p1-ops-closure` |
| `feature/photo-studio-p2-asset-lifecycle` | `bc27b38` | 2026-04-21 | `origin/feature/photo-studio-p2-asset-lifecycle` |
| `feature/photo-studio-p2-calendar-sync` | `acacd8b` | 2026-04-21 | `origin/feature/photo-studio-p2-calendar-sync` |
| `feature/photo-studio-p3-weekly-digest` | `bfb011e` | 2026-04-21 | `origin/feature/photo-studio-p3-weekly-digest` |
| `feature/photo-studio-p4-external-delivery` | `fd3e3f9` | 2026-04-21 | `origin/feature/photo-studio-p4-external-delivery` |
| `feature/photo-studio-p5-delivery-ops` | `84638e7` | 2026-04-21 | `origin/feature/photo-studio-p5-delivery-ops` |
| `feature/photo-studio-p6-operator-reporting` | `26b8996` | 2026-04-21 | `origin/feature/photo-studio-p6-operator-reporting` |
| `lane8/upstream-intake-20260425` | `d523782` | 2026-04-25 | `origin/main` |
| `lane9-photo-studio-next-guide-contract-intake-20260425` | `e89cddf` | 2026-04-25 |  |
| `main-upstream-absorb-20260420` | `37db901` | 2026-04-20 |  |
| `prod/stable` | `a1870b3` | 2026-05-23 | `origin/prod/stable` |
| `revert/pr-35-identity-evidence-20260430` | `a300839` | 2026-04-30 | `origin/revert/pr-35-identity-evidence-20260430` |
| `staging/vcptoolbox-custom-integration-20260425` | `947fa6e` | 2026-04-25 | `origin/main` |

## 5. 推荐清理顺序

1. 先处理 dirty worktree：
   - `A:/VCP/VCPToolBox`
   - `A:/VCP/VCPToolBox-photo-studio-next`
   - `A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429`
2. 再处理已并入且干净的 worktree 分支：
   - `integration/main-absorb-prod-stable-upstream-20260525`
   - `feature/gov-patch-1a-identity-approval-20260429`
   - `feature/gov-patch-2b-effect-classification-20260430`
   - `codex/prod-stable-closeout-check-20260513`
   - `feature/photo-studio-p7-queue-scheduler`
3. 对未并入分支做复核，不直接删除。
4. 最后批量删除“已并入可清理”本地分支。

## 6. 建议使用的只读复核命令

```powershell
git status --short
git worktree list
git branch --merged main
git branch --no-merged main
git rev-list --left-right --count main...<branch>
git log --oneline --decorate main..<branch>
git diff --stat main...<branch>
```

删除本地分支或 worktree 前，应再次确认目标路径和分支名；远端删除需要单独授权。
