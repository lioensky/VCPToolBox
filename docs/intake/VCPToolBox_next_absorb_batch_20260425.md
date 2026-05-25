# VCPToolBox 下一批吸收线整理

> 历史记录：本文记录 2026-04-25 的分支吸收复核结论。
> 当前主线已经在后续整合中前进，本文中的提交号和工作区仅作为分支考古参考。
>
> 当时基线
> - 整合主线: `main` @ `e89cddf`
> - 本地稳定线: `prod/stable` @ `e89cddf`
> - 当时口径: 先看 `git cherry -v main <branch>`，再用目录级 diff 验证是否真的是前向增量

## 1. Lane 9 验证结论

### `feature/photo-studio-next-guide-contract`

这条线已经按原计划开了 intake 分支:

- intake branch: `lane9-photo-studio-next-guide-contract-intake-20260425`
- worktree: `<local-worktree>\VCPToolBox-photo-studio-export`

但 2026-04-25 的复核结果是: 当前证据不支持继续把它当作 photo studio 的直接吸收源。

已验证事实:

- `git cherry -v main feature/photo-studio-next-guide-contract` 仍显示 10 个 `+` 提交
- 但 `git diff --stat feature/photo-studio-next-guide-contract..main -- plugins/custom tests/photo-studio plugins/registry.json package.json Plugin.js`
  显示当前 `main` 反而比该分支多出:
  - `1683 insertions`
  - `85 deletions`
- 当前 `main` 已含该分支缺失的关键资产:
  - `plugins/custom/shared/photo_studio_data/BaserowPublishAdapter.js`
  - `tests/photo-studio/content-pool.test.js`
  - `tests/photo-studio/customer-record.test.js`
  - `tests/photo-studio/project-record.test.js`
  - `tests/photo-studio/status-tasks-reply.test.js`
- 已实际试过对 guide-contract 相关提交做 cherry-pick，保留当前 `main` 版本后会塌成空补丁

当前判断:

- `Lane 9` 已开
- 但 `feature/photo-studio-next-guide-contract` 当前更像历史迁移线 / 对照线
- 在没有逐提交、逐文件证明缺口之前，不建议继续从这条线直接 merge 或大段 cherry-pick

### `feature/photo-studio-guide-contract-migration`

这条线当前阶段的结论和上面基本一致。

已验证事实:

- `git cherry -v main feature/photo-studio-guide-contract-migration` 也显示同组 guide-contract 正向提交
- 但 `git diff --stat feature/photo-studio-guide-contract-migration..main -- plugins/custom tests/photo-studio plugins/registry.json package.json Plugin.js`
  显示当前 `main` 比该分支多出:
  - `3374 insertions`
  - `92 deletions`

当前判断:

- 这条线保留为对照线
- 不再作为 `Lane 9` 的直接吸收源

## 2. Lane 10 验证结论

### `codex memory lane`

已从 `Lane 9` 中拆出独立 memory intake 线:

- intake branch: `lane10-codex-memory-intake-20260425`
- worktree: `<local-worktree>\VCPToolBox-photo-studio-export`

已验证事实:

- `801d8dc` 已被 Git 明确判定为空补丁:
  - `git cherry-pick --continue` 返回 `The previous cherry-pick is now empty`
  - 后续已 `git cherry-pick --skip`
- `b3ce069` 经净吸收后落成提交 `551f017`
- 为补齐运行时缺口，又追加提交:
  - `fb17dd0` `fix: wire codex recall audit into rag diary runtime`
- 当前相对 `main` 的有效净增量为:
  - `AdminPanel/js/codex-memory-monitor.js`
  - `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js`
  - `tests/codex-memory-recall.test.js`
  - `docs/MEMORY_SYSTEM.md`
  - `docs/Markdown_Output_Guideline.md`
  - `docs/PLUGIN_ECOSYSTEM.md`
  - `rag_params.json`
- 定向验证已通过:
  - `node --check Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js`
  - `node --check AdminPanel/js/codex-memory-monitor.js`
  - `node --test tests/codex-memory-recall.test.js tests/codex-memory-admin.test.js tests/codex-memory-adaptive.test.js tests/codex-memory-bridge.test.js tests/codex-memory-e2e.test.js`
  - 结果: `11/11` 通过

当前判断:

- `Lane 10` 是当前已经验证完成、可继续集成的独立候选线
- 这条线比 `Lane 9` 更适合优先推进

## 3. 后续可吸收补丁包

### `codex/photo-studio-baserow-provider-batch`

这条线仍保留为下一批更可执行的候选，但建议拆包吸收。

已知未吸收补丁:

- `5cbdfff` `fix: apply upstream admin auth redirect hardening`
- `a1d7707` `feat: add associate discovery to rag diary`
- `b92796e` `fix: add truncation threshold config to GitSearch`
- `36bfbfd` `fix: restore GitSearch entry files for intake`
- `3bbe4d8` `fix(VSearch): prefer config.env SearchMode default`
- `ae777d7` `chore: prompt tuning`
- `79911d5` `feat(RAGDiary): add ::Expand full-document expansion support`

建议拆成 3 个小包:

1. `admin auth redirect hardening`
2. `RAGDiary / GitSearch / VSearch`
3. `prompt tuning`

## 4. 不建议作为直接吸收源

### `feature/latest-updates`

这条线仍只适合考古，不适合直接 merge 或整支 cherry-pick。

原因:

- 混有 `photo_studio`
- 混有 `codex memory`
- 混有 `weekly report / dingtalk cli`
- 与其他分支重叠太多

## 5. 已实质吸收, 不再排批次

以下分支虽然提交号不同，但 `git cherry` 已显示补丁实质进入主线:

- `codex/vcptoolbox-channelhub-core-20260425`
- `codex/vcptoolbox-dingtalk-adapters-20260425`
- `codex/vcptoolbox-memory-rag-governance-20260425`

## 6. 当前推荐顺序

1. 保留 `Lane 9`，但状态为已验证、不继续直接吸收 photo studio guide-contract 源分支
2. 优先推进 `Lane 10`，因为它已验证完成
3. `Lane 11` 处理 `codex/photo-studio-baserow-provider-batch` 的第一个小包
4. `feature/latest-updates` 继续只做考古参考
