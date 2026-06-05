# Upstream Absorb R16 Candidate Classification - 2026-06-05

本文件记录 R16 后续 upstream 候选的只读分类结果。

本文件只做候选分类，不吸收代码，不 raw merge `upstream/main`。

## 1. 基线

| 项目 | 值 |
|------|----|
| 本地目标 | `main` |
| 本地目标 commit | `ea2be412 Merge pull request #122 from JENN2046/codex/r16a-upstream-ignore-rules-20260605` |
| upstream 来源 | `https://github.com/lioensky/VCPToolBox` |
| 本地已抓取 upstream | `aa7e2e0e Merge pull request #350 from miaotouy/main` |
| 工作树 | clean before this classification |
| 注意 | 2026-06-05 本轮重试 `git fetch upstream main` 时出现 TLS handshake failure，本分类基于已抓取的 `upstream/main`。 |

## 2. 可以合并吸收的小包候选

| 建议包 | upstream commits | 范围 | 结论 | 说明 |
|--------|------------------|------|------|------|
| R16C VCPToolBridge manifest version | `1fc2b56c` | `Plugin/VCPToolBridge/index.js` | 已在本分支实施 | 只给导出的 plugin manifest 增加 `version: plugin.version || "1.0.0"`。不改变执行分发，见 `UPSTREAM_ABSORB_R16C_VCPTOOLBRIDGE_VERSION_20260605.md`。 |
| R16D NanoBananaGen2 public URL switch | `8977a56a` | `Plugin/NanoBananaGen2/NanoBananaGen.mjs`, `Plugin/NanoBananaGen2/config.env.example`, `Plugin/NanoBananaGen2/plugin-manifest.json`, `Plugin/NanoBananaGen2/README.md`, `tests/gptimagegen-safety.test.js` | 已在 R16D 分支实施 | 采用本地修正版：默认 `USE_PUBLIC_URL=false`，显式公网模式使用 `VarHttpsUrl`，并补 manifest、README 与静态回归。见 `UPSTREAM_ABSORB_R16D_NANOBANANA_PUBLIC_URL_20260605.md`。 |

## 3. 需要先做 preflight 的候选

| 建议包 | upstream commits | 范围 | 原因 |
|--------|------------------|------|------|

## 4. 已覆盖或只需台账核销

| upstream commits | 结论 |
|------------------|------|
| `79764f12`, `7702a533`, `d3f58c7e` | R16A 已拆包吸收 ignore 安全子集并合并到 `main`。`Plugin/SkillBridge/skill-index.txt` 删除没有执行，需要单独确认。 |
| `3ceedf22`, `59f34856`, `0094f190` | R16B 已由 #125 本地延迟派生刷新实现覆盖并合并到 `main`。本地实现将 TagMemo 启动期 EPA / pairwise / intrinsic residual / matrix 等派生刷新改为 post-startup 延迟路径，避免初始化时阻塞；P1 fallback matrix 修正已包含在 #125 中，cold-start 或 modelSig 变更且 pairwise similarity 为空时不暴露由 `SEM_LOW_FALLBACK` 构建的 degraded matrix，改为延迟到派生刷新完成后再建矩阵。验证：`node --check TagMemoEngine.js KnowledgeBaseManager.js`；`git diff --check`；PR CI 通过。合并提交：`d112e4bd`。 |
| `46250ad7` | R16E 已拆成 #127 和 #128 吸收并合并到 `main`：#127 引入 split single embedding 的 token-weighted merge；#128 补 single embedding 输入 trim/normalization。保留本地更严格的 partial failure 拒绝策略，不吸收上游对部分 chunk 失败仍返回向量的宽松行为。合并提交：`cd2f68f0`, `291802e0`。 |
| `e01d05fb` | R16F1 已由 #130 吸收并合并到 `main`：`Plugin/VCPBridgeServer/bridgeserver.js` 保留 `tools` / `functions` / `tool_choice` / `parallel_tool_calls` 为受保护字段，只在构建 chat/Anthropic/Gemini upstream body 时加回，不进入 `messages` / RAG 文本流。验证：`node --test tests/vcp-bridge-server.test.js`，23/23。合并提交：`afadc7cd`。 |
| `cca1c915` partial | R16F2 已由本地默认关闭 opt-in retry suppression 实现覆盖并合并到 `main`。#132 先做 preflight；#133 在 `Plugin/VCPBridgeServer/bridgeserver.js` 增加 `BRIDGE_RESPONSES_RETRY_SUPPRESSION_MS`，默认 `0` 关闭，仅作用于 `/v1/responses`，显式 `requestId` / `messageId` 跳过，命中时返回带 `metadata.vcp_bridge_suppressed_duplicate=true` 的 synthetic Responses JSON/SSE；P2 修正为仅在上游成功后记录 suppression key，避免失败重试被 synthetic 200 掩盖。验证：`node --test tests/vcp-bridge-server.test.js`，29/29；CI `build_and_test (20.x)` / `detect_docker_changes` / `docker_build` 通过。合并提交：`d9fcfd9a`。 |
| `e9c98eaa`, `70a49e08` | R16G 配置样例补齐已核销：`e9c98eaa` 中 RAGDiaryPlugin 的 `FOLDING_STORE_MAX_ENTRIES` / `FOLDING_STORE_EVICT_COUNT` 已由 #126 吸收并合并到 `main`，且代码消费点在 `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js`；根 `config.env.example` 中 `KNOWLEDGEBASE_REUSE_CHUNK_VECTORS` 已由 #129 覆盖并合并到 `main`，消费点在 `KnowledgeBaseManager.js`。剩余上游 `VarUserName` 与 `TAGMEMO_INTRINSIC_RESIDUAL_FORCE_RECOMPUTE` 当前没有本地代码消费点，暂不写入 example，避免配置样例承诺未实现行为。 |
| `c2f3b1a9` | R16H Agent 编辑器右侧栏已由 #137 preflight + #138 source-only 实现覆盖并合并到 `main`。只吸收 `AdminPanel-Vue/src/views/AgentFilesEditor.vue` 和 `AdminPanel-Vue/src/views/AgentFilesEditor/DiarySyntaxEditorModal.vue`，继续排除 `AdminPanel-Vue/dist/*`；#138 增加 Agent 编辑器常用占位符侧栏，复用 `placeholderApi` / `toolboxApi`，并保留 `fileDirty`、保存与离开确认行为。验证：`AdminPanel-Vue` 下 `npm run build` 通过；CI `build_and_test (20.x)` / `detect_docker_changes` / `docker_build` 通过。合并提交：`4d27af13`, `62483687`。 |
| `ef4a458d`, `fcfcc918`, `d6f051f5` | R15A/R15B/R15C 已通过本地安全改写吸收。`git cherry` 仍显示 `+` 是 hash 不同，不代表未吸收。 |
| `567cf29b` | R13 已核销目录整理安全子集，剩余不继续按目录整理吸收。 |
| `631076b4` | 删除临时文件。若本地没有该文件，可台账核销，不需要代码包。 |

## 5. 暂缓或拒绝 raw merge

| upstream commits | 原因 |
|------------------|------|
| `7e81eeb8`, `720bdd27`, `dcfeb30e`, `1287c4e6`, `e6e74868`, `05494743`, `2c4411dd`, `7a4d11db`, `e5feeddc` | Docker/Rust/TDB/EPA/TagMemo 大包，含 `.node` 二进制、Rust、数据库/索引语义、配置样例。必须专项设计，不直接吸收。 |
| `344833a0`, `6b8e4892`, `0af2d18b` | 新 Agnes 图片插件并改 ZImageTurboGen，属于新能力/生图插件面，需单独设计和安全审查。 |
| `f3aa67ee` | 新增 `preprocessor_order.json`，属于运行顺序配置，不应直接提交默认运行态配置。 |
| `e4205294`, `ad92d9b6`, `5b26680a`, `d558e20a`, `64d9edcf`, `481835ea`, `be74076d`, `64cee8fc`, `e628d98b` | OneRing 新系统大包，涉及新插件、handlers、ContextFolding、README、后续多轮 bugfix。不能混入普通吸收。 |
| `7eac079d` | 文档/算法说明更新，可能有参考价值，但不是优先代码吸收项。 |

## 6. 推荐顺序

1. R16C VCPToolBridge manifest version。
2. R16D NanoBananaGen2 public URL switch 的本地修正版。

R16B 已由 #125 核销，不再作为后续实现候选。

## 7. 验证建议

候选实现包应按范围选择最小验证：

```powershell
git diff --check
node --check <changed-js-files>
node --test <targeted-tests>
```

不得运行真实桥接、插件外部调用、生图请求、数据库修复、向量重建、生产服务或任何 runtime/cache/state 写入验证。
