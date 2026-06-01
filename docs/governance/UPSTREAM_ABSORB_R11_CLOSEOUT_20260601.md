# Upstream Absorb R11 Closeout - 2026-06-01

本文件记录 R11 阶段对 `upstream/main` 新增差异的最终核销结论。

本批只做台账更新，不修改运行逻辑。

## 1. 基线

| 项目 | 值 |
|------|----|
| 本地目标 | `origin/prod/stable` |
| 本地目标 commit | `efb70c17 Merge pull request #96 from JENN2046/upstream-absorb-r11d-ragtuning-ui-range-20260601` |
| main 同步 commit | `e1ce1680 Merge pull request #97 from JENN2046/sync/prod-stable-to-main-96-20260601` |
| upstream 来源 | `https://github.com/lioensky/VCPToolBox` |
| upstream ref | `upstream/main` |
| upstream commit | `2aa92f49 修复面板ui的小bug` |
| 核销范围 | `077eee57..upstream/main` |
| 本地分支 | `upstream-absorb-r11e-closeout-ledger-20260601` |

只读核对命令：

```powershell
git log --oneline --no-merges 077eee575abe1758d0259b473c07584d71bb9924..upstream/main
git log --oneline --decorate -n 12 origin/prod/stable
git log --oneline --decorate -n 12 origin/main
git rev-list --left-right --count origin/main...origin/prod/stable
git rev-list --left-right --count origin/prod/stable...upstream/main
```

核对结果：

- `origin/prod/stable` 已到 `efb70c17`。
- `origin/main` 已到 `e1ce1680`。
- `origin/main...origin/prod/stable = 35 / 0`，说明 `prod/stable` 已被同步进 `main`。
- `origin/prod/stable...upstream/main = 501 / 71`，不能按提交数判断未吸收；本地采用拆包吸收，不 raw cherry-pick upstream commit。

## 2. R11 核销项

| upstream commit | 主题 | 结论 | 本地落点 | 验证/说明 |
|-----------------|------|------|----------|-----------|
| `1aa2223f` | 上架 VCPBridgeServer | 已安全化吸收 | `#88` / `0468f3de`，后续 `#90` / `390b9f57` | 本地实现了 VCPBridgeServer loopback/protocol bridge，并经过多轮 review 修复响应 schema、SSE 转换和 key 泄漏风险。不是 raw cherry-pick。 |
| `0077d079` | VCPBridgeServer 配置优化 | 已安全化吸收 | `#90` / `390b9f57`，同步 `#91` / `0aa606ac` | 本地默认指向本地 VCP 主服务，但保留外部上游显式 key / caller-header fallback，避免把 VCP server key 泄漏给外部 upstream。 |
| `519baa76` | RAG fuzzy cache 性能 | 已安全化吸收 | `#92` / `f6b59589`，同步 `#93` / `5f7f9652` | 上游实现会把 fuzzy 命中写成当前文本精确缓存；本地改为 opt-in read-only fuzzy hit，默认路径继续请求精确向量，避免污染 SemanticGroup/query 缓存。 |
| `0e56830d` | Docker 初始化优化 | 已吸收关键行为 | `#94` / `47cce58d`，同步 `#95` / `3d3ad08f` | 本地 Docker build stage 现编 `rust-vexus-lite`，final image 只复制运行必需文件；PM2 主进程内存可通过 `VCP_MAIN_MAX_MEMORY` 覆盖，默认仍保持 `1500M`。 |
| `9984da04` | Alpine x64 Rust `.node` 二进制更新 | 明确不单独吸收 | 不适用 | 不提交单个平台预编译二进制。R11C 通过 Docker 内源码现编 musl `.node` 覆盖 stale binary，避免二进制漂移。 |
| `cf598a68` | Docker CI 流程优化 | 部分吸收，CI publish 改动不吸收 | `#94` / `47cce58d` | Dockerfile cache/现编方向已吸收；`.github/workflows/ci.yml` 的 `workflow_dispatch` / Docker publish 输入未吸收，因为本地已有 `prod/stable` 保护分支、PR 变更检测和不推镜像策略，发布能力需单独审。`docs/DOCKER_RELEASE_WORKFLOW.md` 未吸收。 |
| `2aa92f49` | RagTuning UI 小 bug | 已吸收源码修复 | `#96` / `efb70c17`，同步 `#97` / `e1ce1680` | 只吸收 `AdminPanel-Vue/src/features/rag-tuning/metadata.ts` 和 `AdminPanel-Vue/src/views/RagTuning.vue`；不吸收 `AdminPanel-Vue/dist/*`。review 后保持 `fuzzyEmbedding.threshold` range 包含现有默认值 `0.96`。 |

## 3. 明确排除

以下内容不进入 R11：

- `AdminPanel-Vue/dist/*` 构建产物。
- `rust-vexus-lite/*.node` 单独二进制更新。
- `.github/workflows/ci.yml` 中的 Docker publish / `workflow_dispatch` 发布能力。
- `docs/DOCKER_RELEASE_WORKFLOW.md`，因为本地 CI 策略与 upstream 不同，不能直接套上游发布说明。
- 任何 `.env`、`config.env`、`state/`、`cache/`、`image/`、真实 token/key/socket 文件。

## 4. 为什么仍会看到 upstream 正差异

R11 继续采用稳定线策略：

- 不 raw merge `upstream/main`。
- 不 raw cherry-pick 混合提交。
- 对可取行为按本地生产线拆包实现、review 修复、单独验证。

因此：

- `git cherry -v origin/prod/stable upstream/main` 仍可能显示这些 upstream commit 为 `+`。
- `git diff origin/prod/stable..upstream/main` 仍会显示大量历史、生成产物、二进制、运行态和本地私有功能差异。
- 判断是否已吸收必须以本台账、PR merge commit、目标文件行为和验证记录为准。

## 5. 当前 R11 状态

| 项目 | 状态 |
|------|------|
| VCPBridgeServer | 已吸收并同步到 `main` |
| RAG fuzzy cache 性能 | 已吸收并同步到 `main` |
| Docker/Rust native addon image | 已吸收并同步到 `main` |
| RagTuning nested range UI | 已吸收并同步到 `main` |
| Alpine `.node` binary | 明确不单独吸收 |
| Docker publish workflow | 明确不吸收，后续若需要单独开 CI/release 设计包 |

R11 结论：`077eee57..2aa92f49` 这段新增 upstream 差异已完成稳定线核销。当前没有必须继续吸收的 R11 项。

## 6. 后续建议

如继续 upstream 吸收，下一步应先重新 fetch `upstream/main`，只读列出 `2aa92f49..upstream/main` 的新增提交。没有新增 upstream commit 时，不继续从旧差异里重复排包。

固定只读命令：

```powershell
git fetch upstream main
git log --oneline --no-merges 2aa92f4970a7633d30ddc703c766274c5c15c96f..upstream/main
git diff --name-status origin/prod/stable..upstream/main
```

