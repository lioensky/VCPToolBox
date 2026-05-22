# prod/stable 生产稳定线基线

**适用范围：** `prod/stable` 分支、面向 `prod/stable` 的 PR、生产发布前本地预检
**最近基线检查：** 2026-04-28
**原则：** 默认安全、无真实密钥、无运行态污染、验证先于发布、生产 Flag 显式确认后才可开启

---

## 1. 稳定线边界

`prod/stable` 不是实验分支，也不是运行实例的工作目录快照。进入稳定线的内容应当是可复现源码、模板配置、文档、测试、构建脚本和必要的静态资源。

禁止把下列内容作为稳定线源码提交：

- 真实配置：`config.env`、`.env*`、插件私有 `config.env`
- 运行日志：`logs/`、`DebugLog/`、`*.log`
- 运行数据库和索引：`*.sqlite`、`*.db`、`VectorStore/`、`data/*cache*.json`
- 运行态记忆和日记：`dailynote/`，除明确保留的稳定知识目录外
- 插件状态和缓存：`Plugin/*/state/`、插件生成 cache 文件、`Plugin/UserAuth/code.bin`
- 生成图片和媒体：`image/fluxgen/`

证据：

- `.gitignore` 定义运行态、真实配置、插件状态、生成图片的忽略规则。
- `scripts/check-prod-baseline.js` 在 CI 中检查已跟踪文件，发现上述禁入内容即失败。
- `.github/PULL_REQUEST_TEMPLATE.md` 将生产边界和验证项显性化。

---

## 2. 项目结构基线

已确认的稳定线结构：

| 区域 | 作用 | 稳定线处理 |
|------|------|------------|
| 根目录 `server.js` / `Plugin.js` / `modules/` / `routes/` | Node.js 主服务、插件调度、路由与内部模块 | 作为核心源码管理 |
| `Plugin/` | 多语言插件生态 | manifest、源码、模板配置可跟踪；运行态配置和状态不可跟踪 |
| `AdminPanel/` | 内嵌静态管理前端 | 作为运行面板资源管理 |
| `AdminPanel-Vue/` | Vue 管理前端工程 | 源码、测试和必要构建配置可管理 |
| `rust-vexus-lite/` | Rust N-API 向量组件 | 源码和 `Cargo.lock` 可管理；`target/` 不可跟踪 |
| `dailynote/` | 运行期记忆/知识内容 | 默认不可跟踪，只有明确稳定知识白名单可例外 |
| `image/` | 运行期媒体资源 | 默认不可跟踪，少量明确静态素材可例外 |

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

面向 `main` 和 `prod/stable` 的 push / PR 必须先通过快门禁：

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

任何面向生产的发布、合并、部署或 Flag 开启前，必须先给出：

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
2. 当前稳定锚点已打 tag：`prod-stable-2026-04-28-baseline`。
3. 服务区部署流程已沉淀到 [PROD_STABLE_DEPLOYMENT_RUNBOOK.md](./PROD_STABLE_DEPLOYMENT_RUNBOOK.md)。

近期优先级：

1. 将 `scripts/check-prod-baseline.js` 作为 `prod/stable` PR 必过门禁。
2. 将真实配置迁移到部署环境或密钥管理，不再跟随源码目录流转。
3. 定期复查 `dailynote/` 白名单，确认哪些内容是真正稳定知识，哪些只是运行记忆。
4. 把 Docker 大范围 bind mount 和 root 用户运行风险列入生产部署复盘，不在基线 PR 中扩大变更范围。
5. 在发布流程中复用 PR 模板和人工 preflight，覆盖 Flag、外部写入、回滚和验证证据。

剩余风险：

- 当前测试体系仍不是完整生产验收，只能证明核心路径和门控未明显失守。
- Docker 生产运行策略仍保留历史权衡，需要单独治理。
- 插件生态较大，单次基线检查不能替代逐插件生产审计。
