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
| 已并入可清理（未占用 worktree） | 5 | Package D 已删除 43 个；剩余 5 个因 `git branch -d` 停止规则或尚未执行而保留 |
| 永久保护分支 | 1 | `prod/stable` 永久保留，永不清理 |

## 1.0 当前治理执行状态

状态：审计覆盖已完成，治理执行未完成。

已完成：

- `main` 已明确为最先进、最新整合状态的主分支。
- `prod/stable` 已明确为稳定生产线永久保护分支，不进入任何清理候选。
- dirty worktree、release-preflight 前端构建产物、未并入分支、worktree 占用分支、`origin/main` 本地引用差异均已做本地只读复核并记录。
- 当前 `git branch --no-merged main` 显示的 19 个分支均已在本文中有记录。
- 执行包 B 已完成：4 个已并入且干净的 worktree 已移除，对应 4 个本地分支已用 `git branch -d` 删除。
- 执行包 D 已部分执行：获批后使用 `git branch -d` 删除 43 个本地分支；在 `lane8/upstream-intake-20260425` 被 Git 拒绝删除时按规则停止，未使用 `git branch -D`。

未完成：

- 执行包 D 剩余 5 个已并入且未占用 worktree 的本地分支未删除。
- 除执行包 B 外，尚未删除其他 worktree。
- 未 push，未修改远端。
- `feature/latest-updates` dirty worktree 仍有 94 行 `git status --short` 状态，展开未跟踪文件后为 254 行。
- `codex/photo-studio-baserow-provider-batch` dirty worktree 仍有 3 项状态。
- detached release-preflight worktree 仍有 137 项 `AdminPanel-Vue/dist` 构建产物状态。

因此本文不是“治理已完成”证明，而是继续执行治理前的控制台账。

### 2026-05-25 目标完成度审计

本节用于逐条核对当前 `/goal`，不是清理授权，也不是远端同步授权。Package D 后续已在当前回合获批并部分执行；除此之外，未执行 push、fetch 后合并、merge、cherry-pick、reset、clean、worktree remove 或远端修改。

当前事实基线：

- 当前工作区：`A:/VCP/VCPToolBox-staging-custom-integration`。
- 当前分支：`main`，复核时 `git status --short -uall` 为空。
- 当前 `main` 复核前 HEAD：`808c13f`。
- worktree 数量：9。
- 本地分支数量：26。
- 已并入且未占用 worktree 的本地清理候选：5；候选中不包含 `main`，不包含 `prod/stable`。
- `git branch --no-merged main`：19 个，其中 7 个占用 worktree，12 个未占用 worktree。
- 当前本地引用关系：`prod/stable`、`origin/prod/stable`、`upstream/main` 均为 `main` 的祖先；`origin/main` 仍不是 `main` 的祖先。
- 当前 left/right：`main...prod/stable = 169 / 0`，`main...origin/prod/stable = 169 / 0`，`main...upstream/main = 271 / 0`，`main...origin/main = 408 / 18`。

逐条核对：

| 目标要求 | 当前证据 | 状态 |
| --- | --- | --- |
| 以 `main` 作为最先进最新主分支 | 项目 `AGENTS.md` 和本文头部均已声明；当前 `prod/stable`、`origin/prod/stable`、`upstream/main` 均为 `main` 祖先 | 已记录并验证当前本地 refs |
| 永久保护 `prod/stable` 稳定生产线 | 本文第 0 节、第 1.1 节和候选复核均明确 `prod/stable` 永不清理；当前候选检查显示 `prod/stable_in_merged_unoccupied=0` | 已记录并验证候选排除 |
| 只做本地审计、文档记录和安全小补丁 | 当前治理提交均为本地文档记录；本轮未做远端、删除、reset、clean 或生产线动作 | 满足当前授权范围 |
| 持续更新本治理文档 | Package B、A1、A2、A3、未并入分支、占用 worktree、引用差异、密钥卫生检查均已写入本文 | 已执行 |
| 复核 release-preflight 前端构建产物 | 第 2 节和第 5.1.2 节记录 detached release-preflight worktree 的 137 项 `AdminPanel-Vue/dist` 产物，结论是不迁移、不吸收 | 已完成只读审查 |
| 复核未并入分支 | 第 3 节、第 3.1 节、第 5.4 节记录 12 个未占用未并入分支；第 2 节和占用 worktree 补充记录 7 个占用未并入分支 | 已完成只读分组 |
| 复核剩余 worktree | 第 2 节和占用 worktree 复核补充记录当前 9 个 worktree；其中 dirty、高风险和 patch-equivalent/superseded 均已分类 | 已完成只读分组 |
| dirty worktree、疑似密钥、运行态数据、构建产物、冲突标记先审查归类 | A1/A2/A3、release-preflight、occupied worktree 复核和密钥卫生检查已记录；疑似 `sk-*` 样式值只保留为风险描述，未记录原值 | 已完成审查归类 |
| 不直接吸收或清理高风险内容 | `feature/latest-updates`、`codex/photo-studio-baserow-provider-batch`、release-preflight dist、AI Image / Photo Studio 对照线均记录为冻结或专项复核 | 已遵守 |
| 禁止 push、删除分支、删除 worktree、修改远端、force、reset/clean、触碰真实密钥 | Package D 分支删除已获当前回合明确批准并使用 `git branch -d` 部分执行；未 push、未删除 worktree、未修改远端、未 force、未 reset/clean，未触碰 `.env` / `config.env`，未记录真实密钥值 | 已遵守当前阶段 |
| 任何清理、删除、远端同步或生产线动作必须单独明确批准 | Package D 已获得当前回合批准并部分执行；Package C/E 和远端同步仍记录为待批准 | D 已部分执行，其余等待单独批准 |

完成度结论：

- 本地审计和文档覆盖已经达到当前 goal 的审查记录要求。
- 治理执行仍未完成，因为 Package D 剩余项、Package C/E、真实未吸收对照线拆分、`origin/main` 拓扑闭合或远端同步都需要后续单独明确批准或复核。
- 因此当前不能把整个治理 goal 标记为完成；下一步只能在获得具体批准后继续 Package D 剩余项、执行 Package C/E，或进入某条未吸收对照线的专项小任务。

### 2026-05-25 下一执行门槛复核

本节用于把后续可批准动作拆清楚，避免把“可执行 preflight”误认为“已授权执行”。复核时当前分支为 `main`，HEAD 为 `02cce0c`，工作树干净。

Package C：占用 worktree 的 patch-equivalent / superseded 分支。

| 分支 | worktree | dirty | 当前证据 | 门槛 |
| --- | --- | ---: | --- | --- |
| `codex/vcptoolbox-channelhub-core-20260425` | `A:/VCP/VCPToolBox-channelhub-core` | 0 | `cherry_plus=0 / cherry_minus=1`，内容已等价进入 `main`，但拓扑未并入且占用 worktree | 需单独批准后，先移除对应 worktree，再尝试 `git branch -d` |
| `codex/vcptoolbox-dingtalk-adapters-20260425` | `A:/VCP/VCPToolBox-dingtalk-adapters` | 0 | `cherry_plus=0 / cherry_minus=1`，内容已等价进入 `main`，但拓扑未并入且占用 worktree | 需单独批准后，先移除对应 worktree，再尝试 `git branch -d` |
| `codex/vcptoolbox-memory-rag-governance-20260425` | `A:/VCP/VCPToolBox-memory-rag-governance` | 0 | `cherry_plus=0 / cherry_minus=1`，内容已等价进入 `main`，但拓扑未并入且占用 worktree | 需单独批准后，先移除对应 worktree，再尝试 `git branch -d` |
| `integration/main-absorb-prod-stable-upstream-20260525` | `A:/VCP/VCPToolBox-prod-stable` | 0 | `cherry_plus=4 / cherry_minus=0`，且该路径承载 `prod/stable` 工作环境 | 不列入 Package C 清理；继续保留，除非用户单独批准重建该工作环境 |

Package D：未占用且已并入本地分支。

- 执行前候选数量为 48；Package D 已部分执行，当前剩余候选数量为 5。
- 候选中不包含 `main`、`prod/stable` 或任何占用 worktree 的分支。
- 只能在单独批准后逐项或批量执行 `git branch -d <branch-name>`。
- 如果 `git branch -d` 拒绝删除，必须停止复核，不能升级为 `git branch -D`。

Package E：未占用、拓扑未并入但 patch-equivalent 的本地分支。

- 当前候选数量仍为 6。
- 6 个 `feature/gov-patch-1b-*` 分支均为 `cherry_plus=0 / cherry_minus=1`。
- 这些分支未占用 worktree，且不包含 `main`、`prod/stable`、dirty worktree 或远端分支。
- 只能在单独批准后尝试 `git branch -d <branch-name>`；若 Git 因拓扑未并入拒绝删除，必须停止，不得强删。

推荐批准顺序：

1. Package D：已获批并部分执行；剩余 5 个需重新复核后再单独批准。
2. Package E：内容等价但拓扑未并入；当前不再建议作为普通温和删除包，需另行决定保留或高风险本地强删除授权。
3. Package C：涉及 worktree 移除，必须逐目录确认路径和 clean 状态；`integration/main-absorb-prod-stable-upstream-20260525` 不纳入清理。

### 2026-05-25 候选清单一致性复核

本轮只读复核当前 Git 现实与本文候选清单是否一致，未执行删除、push、reset、clean、merge、cherry-pick 或 worktree remove。

当前基线：

- worktree 数量：9。
- `git branch --no-merged main`：19 个。
- 未并入且占用 worktree：7 个，均已在第 2 节和占用 worktree 复核补充中记录。
- 未并入且未占用 worktree：12 个，其中 6 个 Governance Patch 1B 分支为执行包 E 候选，其余 6 个为真实未吸收或高风险混合对照线。
- 已并入且未占用 worktree：5 个，为执行包 D 剩余候选。
- `prod/stable` 不在任何清理候选中；即使它已被 `main` 包含，也仍是永久保护稳定生产线。

执行状态：Package B 已执行；Package D 已获批并部分执行，删除 43 个本地分支后在 Git 拒绝删除项处停止；Package A1/A2/A3、占用 worktree、未占用未并入分支均已完成只读复核。Package C/E 和 Package D 剩余项仍只是候选或 preflight 记录，任何继续清理都需要后续单独明确批准。

### 2026-05-25 当前交接快照

本快照用于后续接手治理，不是清理授权。

已被当前证据覆盖：

- `main` 是当前本地治理口径下的最新整合主线。
- `prod/stable` 是永久保护稳定生产线，不进入任何清理候选。
- Package B 已执行完成，且仅包含 4 个已并入且干净的 worktree 与对应本地分支。
- Package A1/A2/A3 已完成只读审查；相关 dirty worktree、疑似密钥样式值、运行态数据、构建产物和冲突标记文件均不得直接吸收或清理。
- 未并入分支已按“占用 worktree / 未占用 worktree / patch-equivalent / 真实未吸收或高风险混合”分组。
- Package D 已部分执行；Package E 已完成可执行性复核，结论是不适合作为普通 `git branch -d` 清理包。

仍需单独明确批准的动作：

- 继续处理 Package D 剩余 5 个已并入且未占用 worktree 的本地分支。
- 决定 Package E 的 6 个 patch-equivalent 本地分支是继续保留，还是另行授权高风险本地强删除。
- 处理 Package C 中仍占用 worktree 的 patch-equivalent / superseded 分支。
- 对 `feature/latest-updates`、`codex/photo-studio-baserow-provider-batch`、`lane10-codex-memory-intake-20260425` 等真实未吸收对照线做专项小主题实现。
- 任何 `origin/main` / `origin/prod/stable` / `upstream/main` 相关同步、merge、push 或远端操作。

### 2026-05-25 当前剩余治理队列

本节是当前行动队列，不是授权。复核时当前分支为 `main`，HEAD 为 `808c13f`，工作树干净。

| 队列 | 对象 | 当前证据 | 下一步门槛 |
| --- | --- | --- | --- |
| D2-safe | `lane9-photo-studio-next-guide-contract-intake-20260425`、`main-upstream-absorb-20260420`、`revert/pr-35-identity-evidence-20260430` | 均为 `main` 祖先，未占用 worktree；前两者无 upstream，`revert/pr-35-identity-evidence-20260430` 已并入其 upstream | 可在单独批准后继续用 `git branch -d`，失败即停 |
| D2-upstream-blocked | `lane8/upstream-intake-20260425`、`staging/vcptoolbox-custom-integration-20260425` | 均为 `main` 祖先且未占用 worktree，但 upstream 指向 `origin/main`，未并入该 upstream | 建议保留，除非单独批准修改本地 upstream 配置后再尝试温和删除；仍不得 `git branch -D` |
| E-historical | 6 个 `feature/gov-patch-1b-*` 分支 | `cherry_plus=0 / cherry_minus=1`，内容等价；但不是 `main` 祖先，且 upstream 均为 `origin/prod/stable` | 不作为普通清理包；保留，或另行授权高风险本地强删除 |
| C-worktree-clean | `codex/vcptoolbox-channelhub-core-20260425`、`codex/vcptoolbox-dingtalk-adapters-20260425`、`codex/vcptoolbox-memory-rag-governance-20260425` | worktree 干净，`cherry_plus=0 / cherry_minus=1`，但仍占用 worktree | 单独批准后才可先移除对应 worktree，再尝试 `git branch -d` |
| C-protected-worktree | `integration/main-absorb-prod-stable-upstream-20260525` | worktree 干净，但路径 `A:/VCP/VCPToolBox-prod-stable` 承载 `prod/stable` 工作环境；`cherry_plus=4` | 不纳入清理；继续保留，除非单独批准重建该工作环境 |
| F-frozen-dirty | `feature/latest-updates`、`codex/photo-studio-baserow-provider-batch`、detached release-preflight | dirty / 构建产物 / 疑似密钥样式值 / 冲突标记等风险已归类 | 继续冻结，不吸收、不清理、不 reset/clean |
| F-true-unabsorbed | `lane10-codex-memory-intake-20260425` 及 AI Image / Photo Studio guide-contract 对照线 | 仍有正向提交或宽 diff | 不整分支 merge；只允许后续按专项小主题重新实现 |

### 2026-05-25 Package C-worktree-clean preflight

本轮只读复核 3 个干净但仍占用 worktree 的 patch-equivalent 分支；未删除分支、未移除 worktree、未 push、未修改远端。

共同事实：

- 3 个 worktree 的 `git status --short` 和 `git status --short -uall` 均为空。
- 3 个 worktree 当前 checkout 分支均与目标分支一致。
- 3 个分支均为 `cherry_plus=0 / cherry_minus=1`，说明内容已等价进入当前 `main`。
- 3 个分支拓扑上仍不是 `main` 的祖先，`main...branch` 右侧计数均为 1。
- `git diff --stat main...branch` 仍展示各自历史切片的大块文件改动；这不代表需要吸收 diff，治理判断以 patch-equivalence 和当前 `main` 文件现实为准。

| 分支 | worktree | dirty | upstream | `main...branch` | 切片范围 | 判断 |
| --- | --- | ---: | --- | --- | --- | --- |
| `codex/vcptoolbox-channelhub-core-20260425` | `A:/VCP/VCPToolBox-channelhub-core` | 0 |  | `407 / 1` | `modules/channelHub/*`、`routes/admin/channelHub.js`、`routes/internal/channelHub.js`、`tests/channelHub-hardening.test.js` 等 34 个文件 | 可作为 C2-safe 候选；仅在单独批准后先移除该 worktree，再尝试 `git branch -d` |
| `codex/vcptoolbox-dingtalk-adapters-20260425` | `A:/VCP/VCPToolBox-dingtalk-adapters` | 0 |  | `408 / 1` | DingTalk / WeeklyReport / WorkLog 插件与 adapter 文件等 28 个文件 | 可作为 C2-safe 候选；仅在单独批准后先移除该 worktree，再尝试 `git branch -d` |
| `codex/vcptoolbox-memory-rag-governance-20260425` | `A:/VCP/VCPToolBox-memory-rag-governance` | 0 | `origin/main` | `409 / 1` | `EmbeddingUtils.js`、`KnowledgeBaseManager.js`、`Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js`、`server.js` 等 5 个文件 | worktree 干净且 patch-equivalent，但 upstream 指向 `origin/main`；若后续 `git branch -d` 被 upstream 保护拦截，必须停止，不得 `git branch -D` |

执行门槛：

- 当前未授权移除这些 worktree。
- 执行前必须再次确认每个 worktree 路径精确匹配上表，且 dirty 仍为 0。
- 只能先 `git worktree remove <path>`，再尝试 `git branch -d <branch>`。
- 如果 `git worktree remove` 或 `git branch -d` 失败，停止并记录，不得 reset、clean、force 或 `git branch -D`。

### 2026-05-25 lane10 true-unabsorbed recheck

本轮只读复核 `lane10-codex-memory-intake-20260425`，未修改 worktree，未 cherry-pick，未 merge，未删除分支。

当前事实：

- worktree：`A:/VCP/VCPToolBox-photo-studio-export`。
- HEAD：`fb17dd0`。
- dirty：`git status --short` 和 `git status --short -uall` 均为空。
- `main...lane10-codex-memory-intake-20260425 = 358 / 2`。
- `git cherry -v main lane10-codex-memory-intake-20260425` 显示 2 个正向提交：`551f017 feat: add Codex memory recall analytics and adaptive tuning`、`fb17dd0 fix: wire codex recall audit into rag diary runtime`。
- diff 范围：7 个文件、800 insertions、53 deletions，涉及 `AdminPanel/js/codex-memory-monitor.js`、`Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js`、`rag_params.json`、记忆系统文档和 `tests/codex-memory-recall.test.js`。

结论：`lane10-codex-memory-intake-20260425` 是真实未吸收对照线，不是清理候选，也不能整体 merge。后续若要吸收，只能拆成 Codex memory monitor、RAGDiary recall audit、adaptive tuning 参数、文档和测试几个小主题，在当前 `main` 上重新实现并单独验证。

### 2026-05-25 frozen dirty worktree refresh

本轮只读刷新冻结对象状态，未读取真实配置或密钥内容，未修改、删除、reset、clean 或移除任何 worktree。复核时当前 `main` HEAD 为 `e028aa3`。

| worktree | 分支 / 状态 | 当前状态 | 风险归类 | 结论 |
| --- | --- | --- | --- | --- |
| `A:/VCP/VCPToolBox` | `feature/latest-updates` @ `a82c8f2` | `git status --short = 94`，`git status --short -uall = 254`；41 项 tracked，213 项 untracked | 仍包含本地配置、疑似密钥样式风险、运行态数据、SQLite、插件启停、用户数据和源码混合改动 | 继续冻结；不吸收、不清理、不 reset/clean，只能按小主题重新实现 |
| `A:/VCP/VCPToolBox-photo-studio-next` | `codex/photo-studio-baserow-provider-batch` @ `79911d5` | `git status --short = 3`，`git status --short -uall = 3` | `DailyNoteManager` 未提交代码改动、`280ed91.patch`、`desktop.ini` | 继续冻结；A2 已判断不迁移旧版 DailyNoteManager 改动 |
| `A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429` | detached `43a6bbb` | `git status --short = 137`，`git status --short -uall = 137`；100 项 tracked，37 项 untracked | 全部位于 `AdminPanel-Vue/dist`，属于前端构建产物替换痕迹 | 继续冻结；不吸收 dist，不删除 worktree，除非单独批准处理构建残留 |

结论：三个冻结对象状态与前次治理记录一致，未出现可直接清理或可直接吸收的新证据。

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

### 2026-05-25 审计文档敏感信息卫生检查

本轮只检查治理审计文档本身，未读取 dirty worktree 中的真实配置或密钥内容。

检查结果：

- 严格长 token 模式 `sk-[A-Za-z0-9]{20,}` 未命中。
- `API_KEY` / `API_Key` / `TOKEN` / `PASSWORD` / `SECRET` 的直接赋值样式未命中。
- 文档只记录了“疑似真实 `sk-*` 密钥样式值”这一风险事实，没有复制具体值。

结论：当前 `docs/governance/BRANCH_CLEANUP_AUDIT_20260525.md` 未发现原始密钥值。后续继续维护本文时，仍只能记录脱敏事实和占位符，不能粘贴 dirty worktree 中的真实值。

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

### 2026-05-25 占用 worktree 未并入分支当前复核补充

本轮只读复核 7 个仍占用 worktree 且未并入 `main` 的本地分支。未执行删除、checkout、reset、clean、merge、cherry-pick 或 worktree remove。

| 分支组 | 当前证据 | 治理结论 |
| --- | --- | --- |
| `codex/vcptoolbox-channelhub-core-20260425`、`codex/vcptoolbox-dingtalk-adapters-20260425`、`codex/vcptoolbox-memory-rag-governance-20260425` | 3 个 worktree 均干净；`git cherry -v main` 均为 `cherry_plus=0 / cherry_minus=1`；提交已 patch-equivalent | 不需要吸收。仍占用 worktree，不能直接删除；如后续清理，需单独批准处理 worktree 和本地分支 |
| `lane10-codex-memory-intake-20260425` | worktree 干净；`cherry_plus=2 / cherry_minus=0`；正向提交为 `feat: add Codex memory recall analytics and adaptive tuning` 与 `fix: wire codex recall audit into rag diary runtime`；diff 为 7 files、800 insertions、53 deletions，涉及 `AdminPanel/js/codex-memory-monitor.js`、`Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js`、`rag_params.json`、记忆系统文档和测试 | 真实未吸收对照线。不能整体 merge，不能清理；如需保留，只能拆成 Codex memory monitor、RAG diary recall audit、adaptive tuning、文档和测试几个小主题逐项实现 |
| `integration/main-absorb-prod-stable-upstream-20260525` | worktree 干净；`cherry_plus=4 / cherry_minus=0`；diff 为 3 个治理文档文件、214 insertions，涉及 `AGENTS.md`、`docs/PROD_STABLE_BASELINE.md`、`docs/governance/BRANCH_CLEANUP_AUDIT_20260525.md` | 不作为当前 `main` 的吸收来源；当前 `main` 已有更新的治理审计记录。该 worktree 路径承载 `prod/stable` 工作环境，继续保留；任何移除或重建都需另行明确批准 |
| `codex/photo-studio-baserow-provider-batch` | worktree 仍有 3 项 dirty；`cherry_plus=7 / cherry_minus=5`；A2 已确认 `DailyNoteManager` 未提交写锁改动不迁移 | 继续冻结，不清理、不整体吸收 |
| `feature/latest-updates` | worktree 仍有 254 项 dirty；`cherry_plus=12 / cherry_minus=1`；A1 已发现疑似真实密钥样式值、冲突标记、运行态数据、插件启停和大范围 mixed diff | 继续冻结，不清理、不整体吸收；只能从明确小主题重新实现 |

结论：占用 worktree 的 7 个未并入分支已按当前 `main` 补充复核。3 个 20260425 分支是 patch-equivalent 但仍占用 worktree；`lane10`、`codex/photo-studio-baserow-provider-batch`、`feature/latest-updates` 属于真实未吸收或高风险混合对照线；`integration/main-absorb-prod-stable-upstream-20260525` 继续作为稳定线工作环境保留。

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
| `feature/ai-image-agent-clean-pr` | `fca8f44` | 2026-04-28 | +17 / -395 | `origin/feature/ai-image-agent-clean-pr` |
| `feature/ai-image-pipeline-dgp-refactor` | `546b684` | 2026-04-27 | +2 / -306 |  |
| `feature/ai-image-pipeline-dgp-v2` | `546b684` | 2026-04-27 | +2 / -306 |  |
| `feature/gov-patch-1b-ai-image-request-source-20260430` | `26a43ce` | 2026-04-30 | +1 / -224 | `origin/prod/stable` |
| `feature/gov-patch-1b-execution-context-helper-20260430` | `ba6fce7` | 2026-04-30 | +1 / -224 | `origin/prod/stable` |
| `feature/gov-patch-1b-human-tool-request-source-20260430` | `129fddf` | 2026-04-30 | +1 / -224 | `origin/prod/stable` |
| `feature/gov-patch-1b-snowbridge-request-source-20260430` | `46ac065` | 2026-04-30 | +1 / -224 | `origin/prod/stable` |
| `feature/gov-patch-1b-task-scheduler-request-source-20260430` | `2fa86f2` | 2026-04-30 | +1 / -224 | `origin/prod/stable` |
| `feature/gov-patch-1b-vcptoolbridge-request-source-20260430` | `87505fc` | 2026-04-30 | +1 / -224 | `origin/prod/stable` |
| `feature/photo-studio-guide-contract-migration` | `1e1b0ca` | 2026-04-22 | +11 / -478 | `origin/feature/photo-studio-guide-contract-migration` |
| `feature/photo-studio-next-guide-contract` | `5d01212` | 2026-04-22 | +17 / -478 | `origin/feature/photo-studio-next-guide-contract` |
| `rescue/ai-image-pipeline-mixed-20260427_195303` | `546b684` | 2026-04-27 | +2 / -306 |  |

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

当前本地 `main` 已包含 `prod/stable`、`origin/prod/stable` 与 `upstream/main`：只读检查显示它们均为 `main` 的祖先。但本地 `origin/main` 引用仍显示 `main` ahead 398 / behind 18。

这 18 个 `origin/main` 提交是 AI Image Agent PR 线。`git cherry -v main origin/main` 显示其中大部分已 patch-equivalent，仅剩 3 个正向提交和 1 个 merge commit：

- `c4290fe Mount AI image agents route behind env flag`
- `84e9007 build(admin): bundle AdminPanel assets for AI image agent`
- `fca8f44 fix: restore dynamicToolRegistry bootstrap module`
- `ee2d324 feat: add AI Image Agent pipeline with guarded real execution (#17)`

当前 `main` 已存在 `ENABLE_AI_IMAGE_AGENTS_ROUTE` 路由门、`routes/admin/aiImageAgents.js`、`modules/dynamicToolRegistry.js`、AI image pipeline / executor / safety 模块、AdminPanel-Vue AI image source 和相关测试。结论与 `feature/ai-image-agent-clean-pr` 一致：不要为了消除拓扑 behind 而整体 merge `origin/main`，否则会混入旧前端 dist hash 和旧源文件差异。若后续需要使远端拓扑完全闭合，应先做专门的 AI Image Agent current-main 对照审查，再由人工明确批准 merge / push。

### 2026-05-25 main / prod-stable / upstream 当前引用复核

本轮未执行 `git fetch`，只基于当前本地 remote-tracking refs 做只读复核。下表 left/right 为记录写入前观测值；后续本地审计提交会继续增加 `main` 左侧计数，但不改变祖先关系和保护结论。

| 引用 | HEAD | 是否为 `main` 祖先 | `main...ref` left/right |
| --- | --- | --- | --- |
| `prod/stable` | `a1870b3` | 是 | `160 / 0` |
| `origin/prod/stable` | `a1870b3` | 是 | `160 / 0` |
| `upstream/main` | `8b8a71d` | 是 | `262 / 0` |
| `origin/main` | `ee2d324` | 否 | `399 / 18` |

结论：本地 `main` 仍是当前本地治理口径下的最新整合主线；`prod/stable` 与 `origin/prod/stable` 已被 `main` 包含但仍永久保护。`origin/main` 的 18 个右侧提交仍是 AI Image Agent PR 线，不能为了消除拓扑差异而直接 merge 或 push。

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

### 2026-05-25 未占用未并入分支当前复核补充

本轮只读复核 `git branch --no-merged main --format='%(refname:short)|%(worktreepath)'`，确认未占用 worktree 且未并入 `main` 的本地分支仍为 12 个。未执行删除、checkout、reset、clean、merge 或 cherry-pick。

当前分组：

- Governance Patch 1B：6 个 `feature/gov-patch-1b-*` 分支均为 `cherry_plus=0 / cherry_minus=1`，即 patch-equivalent；仍只作为执行包 E 候选，删除需单独批准。
- AI Image clean-pr：`feature/ai-image-agent-clean-pr` 当前 `cherry_plus=3 / cherry_minus=14`，`git diff --shortstat main...feature/ai-image-agent-clean-pr` 为 63 files、2906 insertions、1387 deletions；主要涉及 `AdminPanel-Vue/dist`、`AdminPanel-Vue/src`、AI Image pipeline 模块、路由、`server.js` 和测试。保留为历史对照线，不整体吸收。
- AI Image DGP 同头组：`feature/ai-image-pipeline-dgp-refactor`、`feature/ai-image-pipeline-dgp-v2`、`rescue/ai-image-pipeline-mixed-20260427_195303` 均指向 `546b684`，当前 `cherry_plus=1 / cherry_minus=1`，diff 为 73 files、5740 insertions、1780 deletions；主要涉及 `AdminPanel-Vue/dist`、`AdminPanel-Vue/src`、`AdminPanel-Vue/public`、AI Image pipeline 模块、路由、`package.json`、测试和文档。作为一个对象复核，不重复处理。
- Photo Studio guide-contract：`feature/photo-studio-guide-contract-migration` 当前 `cherry_plus=10 / cherry_minus=0`，`feature/photo-studio-next-guide-contract` 当前 `cherry_plus=10 / cherry_minus=6`；两者 diff 超过 335 个文件，主要涉及 `plugins/custom`、ChannelHub、OneBot/DingTalk/WeCom/Feishu adapters、Photo Studio 测试、AdminPanel 旧页面、interaction middleware 文档、sheetai workbook 和运行态相关路径。不能整体 merge，不能清理；只允许后续按 `plugins/custom`、`tests/photo-studio` 等小主题重新切片。

结论：12 个未占用未并入分支已按组复核。只有 6 个 Governance Patch 1B 分支是 patch-equivalent 清理候选；其余 6 个属于真实未吸收或高风险混合对照线，不进入清理候选。

## 4. 已并入可清理

以下为 Package D 执行前快照：这些分支当时未被 worktree 占用，并且已经并入当前 `main`。Package D 已在获批后删除其中 43 个；当前剩余候选见第 5.3.1 节。

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

除已记录执行完成的 Package B 和已部分执行的 Package D 外，以下执行包都不是自动授权。任何继续删除、移除 worktree、push、远端同步都必须单独明确批准。

| 执行包 | 范围 | 当前状态 | 建议 |
| --- | --- | --- | --- |
| A. dirty worktree 冻结处理 | `A:/VCP/VCPToolBox`、`A:/VCP/VCPToolBox-photo-studio-next`、`A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429` | A1/A2/A3 已只读复核，仍冻结 | 不直接吸收，不清理；只能按小主题重新实现或在另行批准后处理本地工作树 |
| B. 已并入且干净的 worktree | `feature/gov-patch-1a-identity-approval-20260429`、`feature/gov-patch-2b-effect-classification-20260430`、`codex/prod-stable-closeout-check-20260513`、`feature/photo-studio-p7-queue-scheduler` | 已执行 | 已移除 4 个 worktree，并删除对应 4 个本地分支 |
| C. patch-equivalent / superseded 但仍占用 worktree | `codex/vcptoolbox-channelhub-core-20260425`、`codex/vcptoolbox-dingtalk-adapters-20260425`、`codex/vcptoolbox-memory-rag-governance-20260425`、`integration/main-absorb-prod-stable-upstream-20260525` | 已补充复核，仍占用 worktree | 先保留；若清理，必须先确认 worktree 用途，再逐项批准移除 |
| D. 未占用且已并入本地分支 | 第 4 节为执行前 48 个分支快照；当前剩余 5 个见第 5.3.1 节 | 已部分执行 | 继续前需重新复核 upstream 与用途；仍只能使用 `git branch -d` |
| E. 未并入但 patch-equivalent 的本地分支 | `feature/gov-patch-1b-*` 相关分支 | 拓扑未并入，但内容已等价 | 不再建议作为普通 `git branch -d` 清理包；保留或另行授权高风险本地强删除 |
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

### 5.1.2 执行包 A3 决策记录：release-preflight 前端构建产物

执行日期：2026-05-25。

范围：

- worktree：`A:/VCP/VCPToolBox-prod-stable-release-preflight-20260429`
- 状态：detached `43a6bbb`
- dirty 状态：137 项，全部位于 `AdminPanel-Vue/dist`

只读证据：

- 路径分布：137/137 均为 `AdminPanel-Vue/dist`。
- 扩展名分布：91 个 `.js`、45 个 `.css`、1 个 `.html`。
- 状态分布：63 个 tracked 修改、37 个 tracked 删除、37 个未跟踪新 hash 资源。
- 未发现 `AdminPanel-Vue/src`、`package.json`、lockfile、Vite 配置、`.env` 或后端源码混入。
- `AdminPanel-Vue/dist/index.html` 仅表现为引用 hash 资源变化，例如入口 JS 与 dashboard calendar chunk 的 hash 替换。

审查结论：不迁移、不吸收、不手工提交这些 `dist` 产物到当前 `main`。

理由：

- 该 worktree 呈现典型前端构建产物替换形态：旧 hash 资源删除、新 hash 资源出现、`dist/index.html` 更新引用。
- 缺少对应源码改动与构建命令证据，不能证明这些产物可复现。
- 直接吸收 `dist` 会把不可审查的构建输出混入主线，破坏治理可回滚性。

后续处理建议：

- 继续冻结该 detached worktree，不执行 reset、clean、删除或 worktree remove。
- 如需保留这批前端状态，必须找到对应 `AdminPanel-Vue/src` 源码变更，在当前 `main` 上重新构建、验证，再单独提交。
- 如确认只是本地构建残留，仍需另行明确批准后才可丢弃或移除 worktree。

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

本节为 Package D 执行前 preflight 记录；执行结果见第 5.3.1 节。

- 候选数量：48。
- 来源命令口径：`git branch --merged main --format='%(refname:short)|%(objectname:short)|%(worktreepath)'`，排除 `main`、`prod/stable` 和仍占用 worktree 的分支。
- 保护检查：候选清单不包含 `main`，不包含 `prod/stable`，不包含任何 worktree 占用分支。
- 候选明细：见第 4 节“已并入可清理”。

执行命令形态：

```powershell
git branch -d <branch-name>
```

执行规则：

- 只允许使用 `git branch -d`，不使用 `git branch -D`。
- 如果 Git 拒绝删除，停止并复核，不强删。
- 不删除远端分支。
- 删除前再次运行保护检查，确认 `prod/stable` 不在候选清单内。

#### 5.3.1 执行包 D 执行记录：未占用且已并入本地分支

执行日期：2026-05-25。

授权来源：用户当前回合明确批准 Package D。

执行前保护检查：

- 候选数量：48。
- 候选中 `main=0`。
- 候选中 `prod/stable=0`。
- 候选中占用 worktree 的分支数量为 0。
- 当前分支为 `main`，执行前工作树干净。

执行结果：

- 成功使用 `git branch -d` 删除 43 个本地分支。
- 在 `lane8/upstream-intake-20260425` 处停止：Git 提示该分支虽然已 merged to `HEAD`，但未 merged to `refs/remotes/origin/main`，因此 `git branch -d` 拒绝删除。
- 已按规则停止；未使用 `git branch -D`，未删除远端分支，未删除 worktree，未 push。
- 执行后本地分支数量：26。
- 执行后已并入且未占用 worktree 的剩余候选：5。
- 执行后 worktree 数量仍为 9。

已删除本地分支：

```text
codex/pr25-adaptive-cache-key-fix
codex/prod-stable-actions-node24-20260429
codex/prod-stable-baseline-hardening
codex/prod-stable-ci-fast-gate
codex/prod-stable-codex-memory-analytics
codex/prod-stable-custom-fileoperator-sheetai-audit
codex/prod-stable-custom-session-binding-audit
codex/prod-stable-custom-system-monitoring-audit
codex/prod-stable-deploy-runbook
codex/prod-stable-dynamic-placeholder-index-20260513
codex/prod-stable-gptimagegen-array-compat-20260513
codex/prod-stable-photo-studio-guide-contract-phase1
codex/prod-stable-plugin-registry-route-20260513
codex/prod-stable-prompt-quote-fix-20260513
codex/prod-stable-upstream-audit-20260513
codex/prod-stable-upstream-gptimagegen-20260429
codex/prod-stable-upstream-history-anchor-20260429
codex/prod-stable-upstream-ignore-docs-20260513
codex/prod-stable-upstream-safe-sync-20260429
codex/prod-stable-upstream-tail-20260429
codex/prod-stable-vcptavern-privacy-time-identity-20260513
codex/prod-stable-vsearch-network-robustness-20260513
feature/ai-image-pipeline-dgp-clean-20260427_195303
feature/gov-1a-identity-approval
feature/gov-patch-1a-identity-approval-clean-20260429
feature/gov-patch-1b-context-observability-rollup-20260430
feature/gov-patch-1c-approval-evidence-20260430
feature/gov-patch-1d-identity-evidence-20260430
feature/gov-patch-1e-approval-args-preview-20260430
feature/gov-patch-1f-execution-context-metadata-20260430
feature/gov-patch-1g-bridge-context-metadata-20260430
feature/gov-patch-1h-tool-executor-context-metadata-20260430
feature/gov-patch-agents-override-20260430
feature/photo-studio-p0-contract-alignment
feature/photo-studio-p0-records
feature/photo-studio-p1-content-pool
feature/photo-studio-p1-ops-closure
feature/photo-studio-p2-asset-lifecycle
feature/photo-studio-p2-calendar-sync
feature/photo-studio-p3-weekly-digest
feature/photo-studio-p4-external-delivery
feature/photo-studio-p5-delivery-ops
feature/photo-studio-p6-operator-reporting
```

剩余候选：

| 分支 | HEAD | upstream | 状态 |
| --- | --- | --- | --- |
| `lane8/upstream-intake-20260425` | `d523782` | `origin/main` | `git branch -d` 拒绝删除；需重新复核，不强删 |
| `lane9-photo-studio-next-guide-contract-intake-20260425` | `e89cddf` |  | 尚未执行，因前一项失败后停止 |
| `main-upstream-absorb-20260420` | `37db901` |  | 尚未执行，因前一项失败后停止 |
| `revert/pr-35-identity-evidence-20260430` | `a300839` | `origin/revert/pr-35-identity-evidence-20260430` | 尚未执行，因前一项失败后停止 |
| `staging/vcptoolbox-custom-integration-20260425` | `947fa6e` | `origin/main` | 尚未执行，因前一项失败后停止 |

后续规则：

- 这 5 个分支不自动继续删除。
- 如要继续，只能在再次复核 upstream 与用途后获得单独明确批准。
- 仍不得使用 `git branch -D`。

#### 5.3.2 执行包 D 剩余 5 个分支复核

本轮只读复核 Package D 剩余项，未继续删除分支、未删除 worktree、未 push、未修改远端。

共同事实：

- 5 个分支均未占用 worktree。
- 5 个分支均为当前 `main` 的祖先，即 `main...branch` 右侧计数均为 0。
- `git cherry -v main <branch>` 对这 5 个分支均无输出，说明相对当前 `main` 没有正向提交。
- `prod/stable` 不在剩余清单中。

| 分支 | HEAD | upstream | `main...branch` | upstream 关系 | 判断 |
| --- | --- | --- | --- | --- | --- |
| `lane8/upstream-intake-20260425` | `d523782` | `origin/main` | `367 / 0` | 未并入 `origin/main`，`upstream...branch = 367 / 18` | `git branch -d` 已拒绝；不强删。若继续，需要单独批准是否允许解除 upstream 或使用仍然温和的删除路径 |
| `lane9-photo-studio-next-guide-contract-intake-20260425` | `e89cddf` |  | `354 / 0` | 无 upstream | 可作为 D2 温和删除候选；仍需单独批准 |
| `main-upstream-absorb-20260420` | `37db901` |  | `483 / 0` | 无 upstream | 可作为 D2 温和删除候选；仍需单独批准 |
| `revert/pr-35-identity-evidence-20260430` | `a300839` | `origin/revert/pr-35-identity-evidence-20260430` | `223 / 0` | 已并入其 upstream，`upstream...branch = 223 / 0` | 可作为 D2 温和删除候选；仍需单独批准 |
| `staging/vcptoolbox-custom-integration-20260425` | `947fa6e` | `origin/main` | `357 / 0` | 未并入 `origin/main`，`upstream...branch = 357 / 18` | 预计 `git branch -d` 也可能因 upstream 规则拒绝；不强删。若继续，需要单独批准是否允许解除 upstream 或跳过 |

建议拆成 D2：

1. D2-safe：先只处理 3 个不会被 upstream 保护拦截的候选：`lane9-photo-studio-next-guide-contract-intake-20260425`、`main-upstream-absorb-20260420`、`revert/pr-35-identity-evidence-20260430`。
2. D2-upstream-blocked：`lane8/upstream-intake-20260425` 和 `staging/vcptoolbox-custom-integration-20260425` 保留，除非单独批准修改本地 upstream 配置后再用 `git branch -d`，或决定继续保留为本地历史引用。
3. 仍不得使用 `git branch -D`，不得删除远端分支。

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

#### 5.4.1 执行包 E 可执行性复核

本轮只读复核 Package E，未删除分支、未改 upstream、未 push、未修改远端。

共同事实：

- 6 个分支均未占用 worktree。
- 6 个分支均不是当前 `main` 的祖先，`main...branch` 均为 `236 / 1`。
- 6 个分支的 upstream 均为 `origin/prod/stable`。
- 6 个分支均为 `cherry_plus=0 / cherry_minus=1`，说明内容已等价进入当前 `main`。
- `git diff --stat main...branch` 仍会显示该单独切片提交的原始文件改动，这是拓扑差异造成的历史视角；是否吸收以当前 `main` 文件现实和 `git cherry` 为准。

| 分支 | HEAD | 原始切片范围 | 拓扑状态 | 判断 |
| --- | --- | --- | --- | --- |
| `feature/gov-patch-1b-ai-image-request-source-20260430` | `26a43ce` | `modules/aiImageExecutionAdapter.js`、对应测试 | 不是 `main` 祖先，patch-equivalent | 不建议作为普通 `git branch -d` 清理；保留或另行批准强删除策略 |
| `feature/gov-patch-1b-execution-context-helper-20260430` | `ba6fce7` | `Plugin.js`、`modules/toolExecutionContext.js`、对应测试 | 不是 `main` 祖先，patch-equivalent | 不建议作为普通 `git branch -d` 清理；保留或另行批准强删除策略 |
| `feature/gov-patch-1b-human-tool-request-source-20260430` | `129fddf` | `server.js`、对应测试 | 不是 `main` 祖先，patch-equivalent | 不建议作为普通 `git branch -d` 清理；保留或另行批准强删除策略 |
| `feature/gov-patch-1b-snowbridge-request-source-20260430` | `46ac065` | `Plugin/SnowBridge/index.js`、对应测试 | 不是 `main` 祖先，patch-equivalent | 不建议作为普通 `git branch -d` 清理；保留或另行批准强删除策略 |
| `feature/gov-patch-1b-task-scheduler-request-source-20260430` | `2fa86f2` | `routes/taskScheduler.js`、对应测试 | 不是 `main` 祖先，patch-equivalent | 不建议作为普通 `git branch -d` 清理；保留或另行批准强删除策略 |
| `feature/gov-patch-1b-vcptoolbridge-request-source-20260430` | `87505fc` | `Plugin/VCPToolBridge/index.js`、对应测试 | 不是 `main` 祖先，patch-equivalent | 不建议作为普通 `git branch -d` 清理；保留或另行批准强删除策略 |

结论：

- Package E 不是“普通温和删除包”。在当前治理规则下，`git branch -d` 很可能因拓扑未并入而拒绝。
- 如继续坚持“不使用 `git branch -D`”，Package E 应保留为 patch-equivalent 历史切片分支，不再作为当前清理执行包。
- 如要删除 Package E，必须另开一个高风险本地分支删除授权，明确允许删除拓扑未并入但 patch-equivalent 的本地分支；仍不得删除远端分支。

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
