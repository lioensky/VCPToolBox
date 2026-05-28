# prod/stable 生产稳定线基线

**适用范围：** `prod/stable` 分支、面向 `prod/stable` 的 PR、生产发布前本地预检
**最近基线检查：** 2026-05-28
**原则：** `prod/stable` 直接跟随 `main` 的内容基线、分支永久保护、发布前显式人工确认、默认安全态不自动放开

> 2026-05-28 基线切换说明：
>
> `origin/prod/stable` 已在 2026-05-28 由 `a1870b3` 快进到 `main @ f84fb727`。
> 从这一天开始，`prod/stable` 不再维持一套比 `main` 更窄的独立内容白名单，
> 而是以当时被确认的 `main` 快照作为新的稳定线内容基线。
> 后续若要继续让 `prod/stable` 跟随 `main`，仍然需要明确人工确认和显式远端写入。

---

## 0. 主干与稳定线永久规则

`main` 是 VCPToolBox 永远保持最先进、最新整合状态的主分支。

- `main` 应吸收已经确认进入项目主线的最新代码、文档、治理记录和整合结果。
- 本地分支审计、作者线吸收、普通功能合流和后续主线维护，默认以 `main` 作为最新主线基准。
- `main` 代表项目当前最完整状态。

`prod/stable` 是 VCPToolBox 稳定生产使用的稳定生产线分支，必须永久保留。

- `prod/stable` 永远不能被删除，包括本地分支和远端分支。
- `prod/stable` 永远不能被列入本地分支清理候选或远端分支清理候选。
- 即使 `prod/stable` 已经被 `main` 吸收、显示为已合并、或当前没有独有提交，也仍然是受保护稳定线，不是可清理分支。
- 不得自动对 `prod/stable` 执行重置、强推、重命名、删除、保护规则放宽或历史改写。
- 任何涉及 `prod/stable` 的合并、发布、回滚、保护规则变更或远端写入，都必须先获得明确的当前回合人工授权。
- 2026-05-28 起，`prod/stable` 的内容基线直接取自被人工确认后的 `main` 快照，而不再单独维护一套与 `main` 长期分叉的窄内容线。

---

## 1. 稳定线边界

`prod/stable` 不是实验分支，也不是运行实例的工作目录快照。
但从 2026-05-28 起，它的内容边界不再通过“先排除大量 `main` 内容，再择优吸收”来定义，
而是通过“将已经确认的 `main` 快照提升为稳定线”来定义。

这意味着：

- 当前 `prod/stable` 中出现的内容，首先以当前 `main` 的实际跟踪结果为准。
- 不应再根据 2026-04-28 的旧窄稳定线假设，自动断言某些目录“必然不在 stable”。
- 如果未来要重新收紧稳定线内容，应优先在 `main` 上完成治理，再由人工确认是否同步到 `prod/stable`。

下列项目仍然属于高敏感或高噪音区域，进入未来稳定线变更时应重点复核，而不是默认自动放行：

- 真实配置：`config.env`、`.env*`、插件私有 `config.env`
- 运行日志：`logs/`、`DebugLog/`、`*.log`
- 运行数据库和索引：`*.sqlite`、`*.db`、`VectorStore/`、`data/*cache*.json`
- 运行态记忆和日记：`dailynote/`
- 插件状态和缓存：`Plugin/*/state/`、插件生成 cache 文件、`Plugin/UserAuth/code.bin`
- 生成图片和媒体：`image/`
- 构建产物：`AdminPanel-Vue/dist/`
- 治理证据与临时台账：`.agent_board/`、`docs/governance/`

证据：

- `main @ f84fb727` 当前已把 `dailynote/`、`docs/governance/`、`AdminPanel-Vue/dist/` 等内容带入稳定线快照。
- `scripts/check-prod-baseline.js` 已调整为“硬拦真正危险内容 + 检查默认安全态”，不再把 `dailynote/`、`image/`、`AdminPanel-Vue/dist/` 当作自动失败项；`.github/PULL_REQUEST_TEMPLATE.md` 也已改为要求说明这些敏感区域的变更理由。
- `.github/PULL_REQUEST_TEMPLATE.md` 将生产边界和验证项显性化。

---

## 2. 项目结构基线

已确认的稳定线结构：

| 区域 | 作用 | 稳定线处理 |
|------|------|------------|
| 根目录 `server.js` / `Plugin.js` / `modules/` / `routes/` | Node.js 主服务、插件调度、路由与内部模块 | 作为核心源码管理 |
| `Plugin/` | 多语言插件生态 | 以当前 `main` 快照为准；真实配置、缓存、状态文件仍应重点复核 |
| `AdminPanel/` | 内嵌静态管理前端 | 作为运行面板资源管理 |
| `AdminPanel-Vue/` | Vue 管理前端工程 | 源码、测试和当前已进入 `main` 的构建结果共同构成稳定线快照 |
| `rust-vexus-lite/` | Rust N-API 向量组件 | 源码和 `Cargo.lock` 可管理；`target/` 不可跟踪 |
| `dailynote/` | 记忆/知识内容 | 当前已随 `main` 纳入稳定线；后续如需收紧，先在 `main` 治理 |
| `image/` | 媒体资源 | 当前已随 `main` 纳入部分内容；后续按用途继续复核 |

---

## 3. 生产默认安全态

稳定线的默认状态必须保持“可启动但不主动执行生产副作用”：

- `config.env.example` 中 `DebugMode=false`。
- `config.env.example` 中 `CHAT_LOG_ENABLED=false`。
- AI Image Agent 管理路由必须由 `ENABLE_AI_IMAGE_AGENTS_ROUTE === 'true'` 显式开启。
- AI Image 真执行必须由 `ENABLE_AI_IMAGE_REAL_EXECUTION === 'true'` 显式开启。
- 图像流水线执行必须经过 `AIGENT_PIPELINE_ALLOW_EXECUTION` 安全门。
- AI Image 管理路由必须保留 dry-run 强制路径。
- `dws:*` 脚本属于真实/矩阵/校准类脚本，不进入自动 CI，不在基线阶段运行。
- Docker CI 只构建镜像，`push: false`，不发布。

证据：

- `config.env.example`
- `server.js`
- `routes/admin/aiImageAgents.js`
- `modules/pipelineSafetyGate.js`
- `package.json`
- `.github/workflows/ci.yml`

---

## 4. 可用脚本矩阵

| 脚本 | 用途 | 稳定线策略 |
|------|------|------------|
| `npm run test:baseline` | 禁入文件、默认安全态、关键门控检查 | PR 必跑 |
| `npm test` | 核心 Node 测试集合 | PR 必跑 |
| `npm run test:photo-studio` | Photo Studio 本地测试 | PR 必跑 |
| `npm run test:dingtalk-cli` | DingTalk CLI 本地测试 | PR 必跑 |
| `npm run test:dingtalk-cli:smoke` | DingTalk CLI smoke runner | 人工按需运行 |
| `npm run build:admin` | AdminPanel-Vue 构建 | 发布前建议运行 |
| `npm start` | 启动主服务 | 不作为 CI 验证，不在基线阶段启动生产 |
| `npm run start:admin` | 启动管理服务 | 不作为 CI 验证 |
| `npm run start:all` | 同时启动服务 | 不作为 CI 验证 |
| `npm run dws:baseline` | DingTalk 真实基线 | 外部写入/真实服务风险，必须人工确认 |
| `npm run dws:matrix` | DingTalk 能力矩阵 | 外部写入/真实服务风险，必须人工确认 |
| `npm run dws:workflow` | DingTalk E2E 工作流 | 外部写入/真实服务风险，必须人工确认 |
| `npm run dws:calibrate` | DingTalk schema 校准 | 外部写入/真实服务风险，必须人工确认 |

---

## 5. CI 验证矩阵

面向 `main` 和 `prod/stable` 的 push / PR，仍应优先通过快门禁：

1. `npm ci`
2. `npm run test:baseline`
3. `npm test`
4. `npm run test:photo-studio`
5. `npm run test:dingtalk-cli`

Docker build 是慢验证，策略如下：

- `push` 到 `main` 或 `prod/stable` 后必须执行 Docker build，且 `push: false`，只验证可构建性。
- PR 中只要包含非文档/非 PR 模板变更，就执行 Docker build。
- docs-only PR 可以跳过 Docker build，但仍必须通过快门禁。
- `prod/stable` 分支保护要求快门禁 check 通过，不要求人工等待 Docker 慢验证结束。

本地发布前建议补充：

1. `npm run build:admin`
2. `cd rust-vexus-lite && npm run build`
3. Docker build
4. 只读配置审计：确认没有真实 `config.env` 或 `.env*` 被跟踪
5. 生产 Flag 审计：确认本次发布是否明确需要开启，默认不开启

不要把 `dws:*`、部署、推送镜像、生产迁移、外部服务写入放入默认 CI。

---

## 6. 发布前治理门

任何面向生产的发布、合并、部署、`main -> prod/stable` 提升或 Flag 开启前，必须先给出：

- 当前分支和 worktree 状态
- 与 `prod/stable` 的 diff 摘要
- 将要开启的 Flag、服务、脚本或外部写入目标
- 已跑验证和未跑验证
- 回滚路径
- 明确人工确认

默认允许的工作：

- 只读检查
- 本地无副作用测试
- 文档、ignore、CI、基线脚本等可逆治理优化
- 从 Git 索引移除本地运行态文件，同时保留本地文件

默认禁止的工作：

- 自动开启生产 Flag
- 自动执行 `dws:*`
- 自动部署、发布、推送镜像
- 修改真实 env 或密钥
- 删除本地运行数据
- 强推、重置、清理工作树

---

## 7. 后续治理计划

已完成治理：

1. `prod/stable` 已配置分支保护，要求 PR 路径、`build_and_test (20.x)` 通过、conversation resolved，禁止 force push 和删除分支。
2. 2026-05-28 已明确将 `origin/prod/stable` 快进到 `main @ f84fb727`，并将该 `main` 快照定义为新的稳定线内容基线。
3. 历史稳定锚点 tag `prod-stable-2026-04-28-baseline` 仍保留，作为旧窄稳定线时期的参考锚点。
4. 服务区部署流程已沉淀到 [PROD_STABLE_DEPLOYMENT_RUNBOOK.md](./PROD_STABLE_DEPLOYMENT_RUNBOOK.md)。

近期优先级：

1. 将真实配置迁移到部署环境或密钥管理，不再跟随源码目录流转。
2. 对 `dailynote/`、`image/`、`AdminPanel-Vue/dist/`、`.agent_board/`、`docs/governance/` 做新的稳定线内容审计，决定哪些保留、哪些后续应先在 `main` 上治理。
3. 把 Docker 大范围 bind mount 和 root 用户运行风险列入生产部署复盘，不在基线 PR 中扩大变更范围。
4. 在后续 `main -> prod/stable` 提升流程中复用人工 preflight，覆盖 Flag、外部写入、回滚和验证证据。

剩余风险：

- 当前测试体系仍不是完整生产验收，只能证明核心路径和门控未明显失守。
- 2026-05-28 之后，部分基线文档、脚本和历史认知仍可能默认旧窄稳定线假设，需要继续统一。
- Docker 生产运行策略仍保留历史权衡，需要单独治理。
- 插件生态较大，单次基线检查不能替代逐插件生产审计。
