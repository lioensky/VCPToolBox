# VCPToolBox 本地分支清理审计表

> 审计日期：2026-05-25
>
> 审计基准：`main` @ `current HEAD`
>
> 本文只记录本地分支和 worktree 状态，不授权删除分支、删除 worktree、推送远端或修改远端分支。
>
> 主干声明：`main` 是 VCPToolBox 永远保持最先进、最新整合状态的主分支，代表项目当前最完整状态。
>
> 强保护声明：`prod/stable` 是稳定生产线分支，必须永久保留。无论它是否已并入 `main`，都不能被列入清理候选，不能删除本地或远端分支。
>
> 职责边界：`main` 负责最新主线整合；`prod/stable` 负责稳定生产使用。二者职责不同，不能因为 `main` 已吸收 `prod/stable` 就清理或削弱 `prod/stable`。

## 0. 分类口径

本审计把本地分支按清理风险分成三类，并采用互斥优先级：

1. 占用 worktree 待处理：分支当前被某个 worktree checkout，不能直接删除。即使已经并入 `main`，也需要先处理 worktree。
2. 未并入需复核：未被 worktree 占用，且 `git branch --no-merged main` 仍显示未并入。删除前必须逐项复核。
3. 已并入可清理：未被 worktree 占用，且 `git branch --merged main` 显示已并入。可作为本地分支删除候选，但仍建议先确认远端/用途。
4. 永久保护分支：`prod/stable` 永远不进入清理候选。即使 Git 显示已合并，也只能视为受保护稳定线。

注意：

- 本文的“可清理”只指本地分支候选，不代表可删除远端分支。
- `main` 是最新主线基准，不是稳定生产部署线。
- `prod/stable` 是明确例外：它既不能删除本地分支，也不能删除远端分支。
- `ahead / behind` 口径为相对当前 `main`，格式为 `分支独有提交数 / main 独有提交数`。
- `dirty files` 是 `git status --short` 的行数，用来提示该 worktree 是否有未提交或未跟踪改动。

## 1. 总览

| 类别 | 数量 | 操作建议 |
| --- | ---: | --- |
| 占用 worktree 待处理 | 9 | 先检查对应目录状态，再决定保留、合并、归档或删除 worktree |
| 未并入需复核（未占用 worktree） | 12 | 逐分支做 `git log main..branch` / `git diff main...branch` 审查 |
| 已并入可清理（未占用 worktree） | 48 | 可作为本地分支删除候选，删除前确认无需保留本地标签/引用 |
| 永久保护分支 | 1 | `prod/stable` 永久保留，永不清理 |

## 1.0 当前治理执行状态

状态：审计覆盖已完成，治理执行未完成。

已完成：

- `main` 已明确为最先进、最新整合状态的主分支。
- `prod/stable` 已明确为稳定生产线永久保护分支，不进入任何清理候选。
- dirty worktree、release-preflight 前端构建产物、未并入分支、worktree 占用分支、`origin/main` 本地引用差异均已做本地只读复核并记录。
- 当前 `git branch --no-merged main` 显示的 19 个分支均已在本文中有记录。
- 执行包 B 已完成：4 个已并入且干净的 worktree 已移除，对应 4 个本地分支已用 `git branch -d` 删除。

未完成：

- 除执行包 B 外，尚未删除其他本地分支。
- 除执行包 B 外，尚未删除其他 worktree。
- 未 push，未修改远端。
- `feature/latest-updates` dirty worktree 仍有 94 行 `git status --short` 状态，展开未跟踪文件后为 254 行。
- `codex/photo-studio-baserow-provider-batch` dirty worktree 仍有 3 项状态。
- detached release-preflight worktree 仍有 137 项 `AdminPanel-Vue/dist` 构建产物状态。
- 48 个“已并入可清理（未占用 worktree）”本地分支仍未执行清理。

因此本文不是“治理已完成”证明，而是继续执行治理前的控制台账。

## 1.1 永久保护分支

| 分支 | HEAD | 日期 | upstream | 保护规则 |
| --- | --- | --- | --- | --- |
| `prod/stable` | `a1870b3` | 2026-05-23 | `origin/prod/stable` | 稳定生产线，永久保留，不得删除，不得列入清理候选 |

## 2. 占用 worktree 待处理

| 分支 | HEAD | 合并状态 | dirty files | worktree |
| --- | --- | --- | ---: | --- |
| `feature/latest-updates` | `a82c8f2` | 未并入 | 94 | `A:/VCP/VCPToolBox` |
| `codex/vcptoolbox-channelhub-core-20260425` | `9f00142` | 未并入 | 0 | `A:/VCP/VCPToolBox-channelhub-core` |
| `codex/vcptoolbox-dingtalk-adapters-20260425` | `e41f243` | 未并入 | 0 | `A:/VCP/VCPToolBox-dingtalk-adapters` |
| `codex/vcptoolbox-memory-rag-governance-20260425` | `5e9274e` | 未并入 | 0 | `A:/VCP/VCPToolBox-memory-rag-governance` |
| `lane10-codex-memory-intake-20260425` | `fb17dd0` | 未并入 | 0 | `A:/VCP/VCPToolBox-photo-studio-export` |
| `codex/photo-studio-baserow-provider-batch` | `79911d5` | 未并入 | 3 | `A:/VCP/VCPToolBox-photo-studio-next` |
| `integration/main-absorb-prod-stable-upstream-20260525` | `1e0a803` | 未并入 | 0 | `A:/VCP/VCPToolBox-prod-stable` |
| `(detached)` | `43a6bbb` | detached | 137 | `A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429` |
| `main` | `current HEAD` | 当前基准 | 0 | `A:/VCP/VCPToolBox-staging-custom-integration` |

### Worktree 处理建议

- `feature/latest-updates`：dirty files 为 94，且未并入。先审查工作树改动，禁止直接删除。
- `codex/photo-studio-baserow-provider-batch`：dirty files 为 3，且未并入。先查看这 3 项改动，再决定是否吸收或归档。
- detached worktree `A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429`：dirty files 为 137，风险最高。先单独做状态审计，避免丢失预检产物或本地记录。
- 执行包 B 中的 4 个已并入且干净 worktree 已移除，并已删除对应本地分支。

### 2026-05-25 dirty worktree 复核补充

本轮只做只读复核，未修改以下 worktree，未删除文件，未读取或记录真实密钥内容。

| worktree | 分支 / 状态 | 相对 `main` | 状态摘要 | 治理结论 |
| --- | --- | --- | --- | --- |
| `A:/VCP/VCPToolBox` | `feature/latest-updates` | `+461 / -14` | 254 项状态；41 项 tracked，213 项 untracked；含 28 项修改、13 项删除；命中 131 项敏感或运行态路径 | 高风险混合工作树。禁止直接清理；先按“源码候选 / 运行态数据 / 本地配置或密钥 / 生成产物 / 插件启停”分桶复核 |
| `A:/VCP/VCPToolBox-photo-studio-next` | `codex/photo-studio-baserow-provider-batch` | `+379 / -12` | 3 项状态；1 个代码改动，2 个未跟踪文件 | 小范围已复核。`daily-note-manager.js` 的写锁思路已存在于当前 `main`，无需吸收旧版文件改动；`280ed91.patch` 是作者线补丁文件；`desktop.ini` 是本地元数据候选 |
| `A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429` | detached `43a6bbb` | `+234 / -0` | 137 项状态；100 项 tracked，37 项 untracked，全部位于 `AdminPanel-Vue/dist` | 前端构建产物替换痕迹。不要手工混入主线；如需保留，应从对应源码重建并以专门前端构建 PR 处理 |

下一步优先级：

1. `feature/latest-updates` 先做路径级分桶，尤其隔离 `config.env`、`code.bin`、SQLite、`state/`、`VectorStore*`、日志、用户数据和运行态日记。
2. `codex/photo-studio-baserow-provider-batch` 的 `Plugin/DailyNoteManager/daily-note-manager.js` 写锁改动已复核：当前 `main` 已有 `withWriteLock()`，并将整个 `organize` 流程串行化，覆盖创建新日记和归档移动；该 worktree 中的旧版 `processDailyNotes` 写入器改动不再吸收。
3. detached release-preflight 只保留为前端构建参考，不作为源码吸收来源。

### 2026-05-25 `feature/latest-updates` 路径级分桶

本轮只读取 `git status --short -uall` 的路径和状态，不读取 `config.env`、`code.bin`、SQLite、`state/`、`VectorStore*`、日志、日记或用户数据内容。

| 分桶 | 数量 | 处理规则 |
| --- | ---: | --- |
| 本地配置或密钥 | 5 | 禁止吸收；包括 `config.env`、`code.bin`、`.claude/settings.local.json` 等 |
| 运行态数据 | 124 | 禁止吸收；包括 SQLite、`state/`、`VectorStore*`、日志、运行日记、用户数据等 |
| 插件启停 manifest | 28 | 高风险；不得批量照搬，需逐插件确认启停意图和稳定线默认安全态 |
| 源码候选 | 33 | 可后续逐文件审查；不得和运行态、密钥、manifest 启停混提交 |
| 文档 / 测试 / 脚本候选 | 43 | 可后续按主题审查；报告类生成文件需确认是否应归档或忽略 |
| 生成或本地产物 | 5 | 默认不吸收；如有价值，需找到对应源码或生成流程 |
| 其他待复核 | 16 | 先判定是否本地工具记忆、临时文件或真实源码，再决定处理 |

`feature/latest-updates` 结论：不能作为整体分支吸收或清理。下一步只允许从“源码候选”和“文档 / 测试 / 脚本候选”中挑选小主题；所有本地配置、密钥、运行态数据、用户数据、缓存、日志和批量插件启停改动必须排除。

### 2026-05-25 `feature/latest-updates` 源码候选审查补充

本轮只读抽查 tracked diff，不修改 `A:/VCP/VCPToolBox` 工作树，不读取真实运行态数据内容。

关键发现：

- `plugins/custom/reporting/sync_to_external_sheet_or_notion/src/index.js` 与 `tests/photo-studio/external-sync.test.js` 仍含 `<<<<<<< ours` / `>>>>>>> theirs` 冲突标记；该主题不能迁移，必须先在独立工作树中解决冲突并跑测试。
- `Plugin/FlashDeepSearch/config.env.example` 的 diff 中出现疑似真实 `sk-*` 密钥样式值；该文件改动禁止吸收，需后续用占位符重写或丢弃，不能把该值写入文档、提交或远端。
- `EmbeddingUtils.js`、`KnowledgeBaseManager.js`、`diary-semantic-classifier.js`、`Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js`、`server.js` 形成一个“embedding fallback / fallback stats endpoint”主题，但它会新增状态写入 `state/embedding-fallback-stats.json` 和公开统计接口，不能从 dirty worktree 直接吸收；如需保留，必须拆成单独设计包，审查接口权限、状态路径和回退密钥配置。
- `AdminPanel/index.html`、`AdminPanel/script.js`、`AdminPanel/style.css`、`docs/ADMINPANEL_DEVELOPMENT.md` 形成一个“Codex Memory Monitor 管理面板入口”主题，但缺少配套文件审查和后端接口完整性检查；不能单独迁移这几处。
- `Plugin/ZImageGen/ZImageGen.mjs` 与 `Plugin/ZImageGen2/ZImageGen.mjs` 形成“生成图片自动注册评分系统”主题，会触碰生成产物登记和评分数据库，属于运行态耦合变更，不能在当前治理清理中吸收。
- 多个 plugin manifest 删除属于插件启停/禁用行为，不能批量吸收，需逐插件确认稳定线默认安全态。
- `TVStxt/supertool.txt` 是 3695 行大文本改动，不适合作为治理合并输入；如有价值，需单独文档审查。

A1 决策：`feature/latest-updates` 仍保持冻结，不执行 reset、clean、merge、cherry-pick 或 worktree 删除。当前仅可从中提取明确的小主题重新实现；不得直接搬运 dirty diff。

### 2026-05-25 release-preflight 前端产物复核

`A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429` 是 detached `43a6bbb` 工作树。本轮只做只读复核：

- 137 项状态全部位于 `AdminPanel-Vue/dist`。
- 分布为 45 个 CSS 资源、91 个 JS 资源、1 个 `dist/index.html`。
- 未发现 `AdminPanel-Vue/src`、前端构建配置、`package.json` 或 lockfile 改动。
- `dist/index.html` 仅表现为引用的构建 hash 资源变化。

结论：这是构建产物替换，不作为源码吸收来源；后续如果需要该前端状态，必须找到对应源码变更，在 `main` 上从源码重新构建并单独验证。

### 2026-05-25 干净 worktree 占用分支复核

本轮只做只读复核，未切换分支，未删除 worktree，未修改这些 worktree 中的文件。

| 分支 | worktree | 当前证据 | 治理结论 |
| --- | --- | --- | --- |
| `codex/vcptoolbox-channelhub-core-20260425` | `A:/VCP/VCPToolBox-channelhub-core` | `git cherry -v main` 显示 `9f00142 feat: add channelhub core runtime` 已 patch-equivalent；当前 `main` 已存在 `modules/channelHub/`、`routes/admin/channelHub.js`、`routes/internal/channelHub.js`、`tests/channelHub-hardening.test.js` | 不需要吸收该分支。它仍占用 worktree，不能直接删；如后续清理，必须先获批处理 worktree，再删本地分支 |
| `codex/vcptoolbox-dingtalk-adapters-20260425` | `A:/VCP/VCPToolBox-dingtalk-adapters` | `git cherry -v main` 显示 `e41f243 feat: add dingtalk workspace adapters` 已 patch-equivalent；当前 `main` 已存在 `Plugin/DingTalkTable/`、`Plugin/WorkLogScheduler/`、`Plugin/vcp-dingtalk-adapter/src/adapter/contract.js`、DingTalk sender 等文件 | 不需要吸收该分支。该分支树比当前 `main` 旧，不能作为 merge 来源；清理仍需单独批准 |
| `codex/vcptoolbox-memory-rag-governance-20260425` | `A:/VCP/VCPToolBox-memory-rag-governance` | `git cherry -v main` 显示 `5e9274e feat: add embedding fallback governance` 已 patch-equivalent；当前差异集中在 `EmbeddingUtils.js`、`KnowledgeBaseManager.js`、`RAGDiaryPlugin`、`server.js` 等旧实现差异 | 不需要整体吸收。保留为历史对照线；如清理，先处理 worktree 并单独批准 |
| `lane10-codex-memory-intake-20260425` | `A:/VCP/VCPToolBox-photo-studio-export` | `git cherry -v main` 仍显示两个正向提交：`551f017`、`fb17dd0`；`git diff --stat main...lane10-codex-memory-intake-20260425` 涉及 `AdminPanel/js/codex-memory-monitor.js`、`RAGDiaryPlugin`、`rag_params.json`、文档和测试 | 不是清理候选，不能整体 merge。仍按历史结论拆分复核：Vue 监控页、运行时 recall audit、adaptive tuning、文档分别处理；运行时写日志行为必须单独设计和验证 |
| `integration/main-absorb-prod-stable-upstream-20260525` | `A:/VCP/VCPToolBox-prod-stable` | `git cherry -v main` 显示 4 个正向治理文档提交；但当前 `main` 已有更新的治理提交 `dde11f8`、`03c85b7`、`b6b4274`、`4143677`、`eb18584`、`a9579d7`、`67803bd`、`d255055`、`0d7e0fd` | 不作为当前 `main` 的吸收来源。该 worktree 路径承载稳定线工作环境，先保留；是否移除或重建必须另行明确批准 |

注意：前三个 20260425 分支虽然仍显示为 `git branch --no-merged main`，但当前证据表明是拓扑未合并、补丁已等价或已由后续实现覆盖；判断时不能只看 `--no-merged`，也不能把旧分支树整体 merge 回当前 `main`。

### 2026-05-25 `codex/photo-studio-baserow-provider-batch` 分支级复核

该分支当前占用 `A:/VCP/VCPToolBox-photo-studio-next`，worktree 仍有 3 项本地状态：

- `Plugin/DailyNoteManager/daily-note-manager.js`：写锁方向已单独复核，当前 `main` 已有更完整的 `withWriteLock()` 串行化实现，不吸收该旧改动。
- `280ed91.patch`：22,836 bytes，补丁标题为“将涟漪共现语法下沉到日记本dsl管理器”，涉及 `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js` 与 `dailynote.md`。
- `desktop.ini`：本地系统元数据，不吸收。

分支级复核结论：

| 证据 | 结果 |
| --- | --- |
| `git cherry -v main codex/photo-studio-baserow-provider-batch` | 12 个分支提交中，7 个仍显示为正向补丁，5 个显示 patch-equivalent |
| `git diff --stat main...codex/photo-studio-baserow-provider-batch` | 21 个文件，约 3,392 insertions / 139 deletions |
| 主要路径 | `Plugin/RAGDiaryPlugin/`、`Plugin/GitSearch/`、`Agent/`、`Plugin/FileOperator/`、`Plugin/VSearch/`、`TVStxt/Dailynote.txt`、`adminServer.js`、`dailynote.md` |
| 当前 `main` 现实 | 已存在 `Plugin/GitSearch/`、`Agent/MemoMaster.txt`、`RAGDiaryPlugin` 中的 `::Expand` / `associate` 相关实现、以及后续更新过的 RAG 日记逻辑 |

结论：该分支不是清理候选，也不能整体 merge。它混合了 RAGDiary 语法、GitSearch、Agent 提示词、FileOperator、VSearch、admin auth redirect 和本地 dirty 写锁改动；后续如需吸收，只能按主题做小范围复核，且必须以当前 `main` 代码为基线，不得从该 worktree 批量照搬。

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

### 2026-05-25 AI image pipeline 同头分支复核

以下三个分支指向同一 HEAD `546b684`，应作为一个复核对象，不应重复评估：

- `feature/ai-image-pipeline-dgp-refactor`
- `feature/ai-image-pipeline-dgp-v2`
- `rescue/ai-image-pipeline-mixed-20260427_195303`

`git cherry -v main feature/ai-image-pipeline-dgp-refactor` 显示 `511d82b docs: add durable project memory` 已等价进入 `main`，但 `546b684 feat: add AI Image Agent admin panel and runtime hardening` 仍未吸收。该提交涉及 AdminPanel-Vue 源码与 dist、AI Image Agent 后端路由、pipeline runtime 模块、`package.json`、测试和文档，变更面较大。

结论：这三个分支不是可清理候选，也不能整体 merge。后续若要吸收，只能作为独立 AI Image Agent 专项，先拆分源码、前端构建产物、runtime hardening、测试和文档，再逐项评估。

### 2026-05-25 Photo Studio guide-contract 分支复核

`feature/photo-studio-guide-contract-migration` 与 `feature/photo-studio-next-guide-contract` 已用当前 `main` 重新复核。

| 分支 | 复核结果 | 结论 |
| --- | --- | --- |
| `feature/photo-studio-guide-contract-migration` | `git cherry -v main` 仍显示 10 个正向提交；diff 涉及 ChannelHub、Codex memory、Photo Studio guide-contract、adapter、运行态 SQLite、`code.bin`、package 和大量新增文件 | 不能整体 merge，不能清理；只能作为 Photo Studio guide-contract 专项对照线 |
| `feature/photo-studio-next-guide-contract` | 包含同组 guide-contract 提交，另有 live publish / DingTalk 相关提交；其中 6 个后续提交已显示 patch-equivalent，但分支 diff 仍非常宽 | 不能整体 merge，不能清理；live publish / DingTalk 只能单独复核，不得随 guide-contract 一起吸收 |

历史结论仍成立：Photo Studio guide-contract 分支含有潜在有用工作，但分支级 diff 不安全，会混入旧 ChannelHub、Codex memory、运行态文件、适配器和前端/配置变更。后续吸收必须从 `plugins/custom/...`、`tests/photo-studio/...` 等小范围重新切片。

### 2026-05-25 AI image clean-pr 分支复核

`feature/ai-image-agent-clean-pr` 已用当前 `main` 复核：

- `git cherry -v main` 显示多数 AI image pipeline / safety / executor / admin dry-run 提交已等价进入 `main`。
- 仍有 3 个未等价提交：路由挂载方式、AdminPanel dist bundle、`dynamicToolRegistry` bootstrap 恢复。
- 当前 `main` 已存在 `ENABLE_AI_IMAGE_AGENTS_ROUTE` 路由门、`routes/admin/aiImageAgents.js`、`modules/dynamicToolRegistry.js`、AI image source 与相关测试。
- 剩余 diff 仍包含 `AdminPanel-Vue/dist` hash 产物和旧版本源码差异。

结论：该分支不是清理候选，也不需要整体吸收；保留为 AI Image Agent 历史对照线。后续若继续 AI image 专项，应以当前 `main` 实现为基线，只挑选明确缺口，不从该分支批量 cherry-pick 或照搬 dist。

### 2026-05-25 `origin/main` 本地引用差异复核

当前本地 `main` 已包含 `prod/stable`、`origin/prod/stable` 与 `upstream/main`：只读检查显示它们均为 `main` 的祖先。但本地 `origin/main` 引用仍显示 `main` ahead 387 / behind 18。

这 18 个 `origin/main` 提交是 AI Image Agent PR 线。`git cherry -v main origin/main` 显示其中大部分已 patch-equivalent，仅剩 3 个正向提交和 1 个 merge commit：

- `c4290fe Mount AI image agents route behind env flag`
- `84e9007 build(admin): bundle AdminPanel assets for AI image agent`
- `fca8f44 fix: restore dynamicToolRegistry bootstrap module`
- `ee2d324 feat: add AI Image Agent pipeline with guarded real execution (#17)`

当前 `main` 已存在 `ENABLE_AI_IMAGE_AGENTS_ROUTE` 路由门、`routes/admin/aiImageAgents.js`、`modules/dynamicToolRegistry.js`、AI image pipeline / executor / safety 模块、AdminPanel-Vue AI image source 和相关测试。结论与 `feature/ai-image-agent-clean-pr` 一致：不要为了消除拓扑 behind 而整体 merge `origin/main`，否则会混入旧前端 dist hash 和旧源文件差异。若后续需要使远端拓扑完全闭合，应先做专门的 AI Image Agent current-main 对照审查，再由人工明确批准 merge / push。

### 2026-05-25 Governance Patch 1B 分支复核

`feature/gov-patch-1b-*` 已按 patch-equivalence 复核：

| 分支组 | 复核结果 | 结论 |
| --- | --- | --- |
| `feature/gov-patch-1b-ai-image-request-source-20260430` | `git cherry -v main` 显示提交已等价吸收 | 可作为本地清理候选，删除仍需单独批准 |
| `feature/gov-patch-1b-execution-context-helper-20260430` | `git cherry -v main` 显示提交已等价吸收 | 可作为本地清理候选，删除仍需单独批准 |
| `feature/gov-patch-1b-human-tool-request-source-20260430` | `git cherry -v main` 显示提交已等价吸收 | 可作为本地清理候选，删除仍需单独批准 |
| `feature/gov-patch-1b-snowbridge-request-source-20260430` | `git cherry -v main` 显示提交已等价吸收 | 可作为本地清理候选，删除仍需单独批准 |
| `feature/gov-patch-1b-task-scheduler-request-source-20260430` | `git cherry -v main` 显示提交已等价吸收 | 可作为本地清理候选，删除仍需单独批准 |
| `feature/gov-patch-1b-vcptoolbridge-request-source-20260430` | `git cherry -v main` 显示提交已等价吸收 | 可作为本地清理候选，删除仍需单独批准 |
| `feature/gov-patch-1b-context-observability-rollup-20260430` | 对 `main` 无净增量 | 可作为本地清理候选，删除仍需单独批准 |

注意：这些分支仍可能被 `git branch --no-merged main` 列出，因为提交血缘不同；治理判断以 patch-equivalence 和当前 `main` 文件现实为准。

## 4. 已并入可清理

以下分支未被 worktree 占用，并且已经并入当前 `main`。它们是本地分支清理候选。

明确例外：`prod/stable` 虽然已并入当前 `main`，但它是稳定生产线永久保护分支，已从本表移出，不能清理。

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
| `revert/pr-35-identity-evidence-20260430` | `a300839` | 2026-04-30 | `origin/revert/pr-35-identity-evidence-20260430` |
| `staging/vcptoolbox-custom-integration-20260425` | `947fa6e` | 2026-04-25 | `origin/main` |

## 5. 推荐清理顺序

1. 先处理 dirty worktree：
   - `A:/VCP/VCPToolBox`
   - `A:/VCP/VCPToolBox-photo-studio-next`
   - `A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429`
2. 执行包 B 已完成：已移除 4 个已并入且干净的 worktree，并删除对应本地分支。
3. 对已复核为 patch-equivalent 或 superseded、但仍占用 worktree 的分支，只记录为“可在获批后处理 worktree 的候选”，不得自动删除：
   - `codex/vcptoolbox-channelhub-core-20260425`
   - `codex/vcptoolbox-dingtalk-adapters-20260425`
   - `codex/vcptoolbox-memory-rag-governance-20260425`
   - `integration/main-absorb-prod-stable-upstream-20260525`
4. 对仍有真实未吸收内容的未并入分支做拆分复核，不直接删除。
5. 最后批量删除“已并入可清理”本地分支。

## 5.1 后续执行包

以下执行包均未获授权，本文只记录建议顺序。任何删除、移除 worktree、push、远端同步都必须单独明确批准。

| 执行包 | 范围 | 当前状态 | 建议 |
| --- | --- | --- | --- |
| A. dirty worktree 冻结处理 | `A:/VCP/VCPToolBox`、`A:/VCP/VCPToolBox-photo-studio-next`、`A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429` | 有未提交或未跟踪内容 | 先只读复核并决定“保留 / 归档 / 丢弃 / 拆分吸收”；禁止自动删除 |
| B. 已并入且干净的 worktree | `feature/gov-patch-1a-identity-approval-20260429`、`feature/gov-patch-2b-effect-classification-20260430`、`codex/prod-stable-closeout-check-20260513`、`feature/photo-studio-p7-queue-scheduler` | 已执行 | 已移除 4 个 worktree，并删除对应 4 个本地分支 |
| C. patch-equivalent / superseded 但仍占用 worktree | `codex/vcptoolbox-channelhub-core-20260425`、`codex/vcptoolbox-dingtalk-adapters-20260425`、`codex/vcptoolbox-memory-rag-governance-20260425`、`integration/main-absorb-prod-stable-upstream-20260525` | 不需要吸收，但仍占用 worktree | 先保留；若清理，必须先确认 worktree 用途，再逐项批准移除 |
| D. 未占用且已并入本地分支 | 第 4 节 48 个分支 | 可清理候选 | 可批量生成删除预案；执行前再次确认 `prod/stable` 不在清单内 |
| E. 未并入但 patch-equivalent 的本地分支 | `feature/gov-patch-1b-*` 相关分支 | 拓扑未并入，但内容已等价 | 可作为本地清理候选；删除前需单独批准 |
| F. 真实未吸收对照线 | AI Image、Photo Studio guide-contract、lane10、`codex/photo-studio-baserow-provider-batch` 等 | 仍有真实未吸收或高风险混合内容 | 不清理，不整分支 merge；后续按专项拆分 |
| G. 远端同步 | `main` 与 `origin/main`、`origin/prod/stable`、`upstream/main` | 本地 `main` 已包含 `prod/stable`、`origin/prod/stable`、`upstream/main`；对 `origin/main` 仍拓扑分叉 | 不自动 push；如需远端主线同步，先做专门 preflight，再由人工批准 push |

### 5.1.1 执行包 A2 决策记录：photo-studio-next DailyNoteManager 小改动

执行日期：2026-05-25。

范围：

- worktree：`A:/VCP/VCPToolBox-photo-studio-next`
- 分支：`codex/photo-studio-baserow-provider-batch`
- dirty 状态：`Plugin/DailyNoteManager/daily-note-manager.js`、`280ed91.patch`、`desktop.ini`

审查结论：不迁移 `Plugin/DailyNoteManager/daily-note-manager.js` 的未提交小改动到当前 `main`。

理由：

- 该改动针对旧版 `processDailyNotes(inputContent)` 写入器，只是在 `fs.writeFile(filePath, content, 'utf-8')` 外层增加进程内 `withWriteLock()`。
- 当前 `main` 的 `Plugin/DailyNoteManager/daily-note-manager.js` 已不是这条旧入口；它是 `list / organize / associate` 命令式管理器。
- 当前 `main` 已有 `withWriteLock()`，并将整个 `organize` 流程串行化；实际创建新日记时还使用 `{ flag: 'wx' }`，避免覆盖同名文件。
- 因此旧版 dirty 改动的意图已被当前 `main` 的新结构覆盖，直接迁移会降低代码一致性，并可能把旧入口语义重新带回主线。

附带文件判断：

- `280ed91.patch` 对应提交 `280ed918ae6c65a1085afe9714ef1a11eaecd948` 已可被当前 `main` 覆盖；保留价值仅为本地历史归档。
- `desktop.ini` 是 Windows 本地目录元数据，不是项目源码。

后续处理建议：

- 不吸收该 worktree 的 `DailyNoteManager` 未提交改动。
- 不整分支 merge `codex/photo-studio-baserow-provider-batch`。
- 若后续目标是清理该 worktree，需另行明确批准后再处理本地未提交内容；不得自动丢弃用户工作树。

### 5.2 执行包 B 执行记录：已并入且干净的 worktree

执行日期：2026-05-25。

执行结果：已移除以下 4 个 worktree，并删除对应 4 个本地分支。

| worktree | 分支 | preflight 证据 | 执行结果 |
| --- | --- | --- | --- |
| `A:/VCP/VCPToolBox-prod-stable-clean` | `feature/gov-patch-1a-identity-approval-20260429` | `git status --short -uall` 为空；`HEAD` 是 `main` 的祖先 | `git worktree remove` 遇到 `Filename too long` 后留下非 Git 残留目录；该目录为批准目标，已清理；本地分支已用 `git branch -d` 删除 |
| `A:/VCP/VCPToolBox-prod-stable-phase3-run-clean` | `feature/gov-patch-2b-effect-classification-20260430` | `git status --short -uall` 为空；`HEAD` 是 `main` 的祖先 | worktree 已移除；本地分支已用 `git branch -d` 删除 |
| `A:/VCP/VCPToolBox-prod-stable-upstream-gptimagegen-20260429` | `codex/prod-stable-closeout-check-20260513` | `git status --short -uall` 为空；`HEAD` 是 `main` 的祖先 | worktree 已移除；本地分支已用 `git branch -d` 删除 |
| `A:/VCP/VCPToolBox-main` | `feature/photo-studio-p7-queue-scheduler` | `git status --short -uall` 为空；`HEAD` 是 `main` 的祖先 | worktree 已移除；本地分支已用 `git branch -d` 删除 |

执行命令形态：

```powershell
git worktree remove <worktree-path>
git branch -d <branch-name>
```

保护确认：

- 本执行包不包含 `prod/stable`。
- 本执行包不包含 dirty worktree。
- 本执行包不包含远端删除或 push。
- 分支删除使用 `git branch -d`，未使用 `git branch -D`。

### 5.3 执行包 D preflight：未占用且已并入本地分支

本节是待批准执行包，不是执行记录。当前只读复核结果：

- 候选数量：48。
- 来源命令口径：`git branch --merged main --format='%(refname:short)|%(objectname:short)|%(worktreepath)'`，排除 `main`、`prod/stable` 和仍占用 worktree 的分支。
- 保护检查：候选清单不包含 `main`，不包含 `prod/stable`，不包含任何 worktree 占用分支。
- 候选明细：见第 4 节“已并入可清理”。

建议命令形态，仅供批准后逐项或批量执行；当前未执行：

```powershell
git branch -d <branch-name>
```

执行规则：

- 只允许使用 `git branch -d`，不使用 `git branch -D`。
- 如果 Git 拒绝删除，停止并复核，不强删。
- 不删除远端分支。
- 删除前再次运行保护检查，确认 `prod/stable` 不在候选清单内。

### 5.4 执行包 E preflight：未并入但 patch-equivalent 的本地分支

本节是待批准执行包，不是执行记录。以下 6 个分支仍显示在 `git branch --no-merged main`，但 `git cherry -v main <branch>` 均显示为 `-`，即 patch-equivalent；且均未占用 worktree：

- `feature/gov-patch-1b-ai-image-request-source-20260430`
- `feature/gov-patch-1b-execution-context-helper-20260430`
- `feature/gov-patch-1b-human-tool-request-source-20260430`
- `feature/gov-patch-1b-snowbridge-request-source-20260430`
- `feature/gov-patch-1b-task-scheduler-request-source-20260430`
- `feature/gov-patch-1b-vcptoolbridge-request-source-20260430`

建议命令形态，仅供批准后逐项执行；当前未执行：

```powershell
git branch -d <branch-name>
```

执行规则：

- 只允许使用 `git branch -d`。
- 如果 Git 因拓扑未合并拒绝删除，停止并复核，不使用 `git branch -D`。
- 本执行包不包含 `prod/stable`、`main`、任何 dirty worktree 或远端分支。

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
