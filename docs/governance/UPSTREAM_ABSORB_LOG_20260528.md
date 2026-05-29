# Upstream 吸收总表 - 2026-05-28

本文件是 `upstream/main` 吸收工作的正式台账。

用途：

- 记录什么时间审查了哪个 upstream commit。
- 记录哪些内容已经吸收到 JENN2046 的 `main`。
- 记录吸收到哪个本地 commit。
- 记录哪些 upstream commit 没有吸收，以及明确原因。
- 解释为什么 `git cherry -v main upstream/main` 仍可能显示 `+`。

## 0. 状态定义

| 状态 | 含义 |
|------|------|
| 已吸收并已推送 | 功能或文档已进入本地 `main`，并且已经推送到 `origin/main`。 |
| 已吸收但未推送 | 功能或文档已进入本地 `main`，但还没有推送到 `origin/main`。 |
| 已审未吸收 | 已经看过 upstream commit，本轮明确不吸收。 |
| 需另开包 | upstream commit 里有可取内容，但它不是一个安全的窄包；以后需要用户明确指定再开新包。 |
| 不可 raw merge | 不能直接 cherry-pick 或 merge upstream commit，因为会带入生成产物、运行态、配置样例、旧实现覆盖、或大量与本地线冲突的改动。 |

## 1. 本次台账创建时基线

以下状态记录的是创建本台账时的工作区事实，用于解释本轮吸收账目。

| 项目 | 值 |
|------|----|
| 台账更新时间 | 2026-05-28 Asia/Shanghai |
| 工作目录 | `A:/VCP/VCPToolBox` |
| upstream 源 | `upstream/main` = `https://github.com/lioensky/VCPToolBox` |
| 本地主线目标 | `main` |
| 远端主线目标 | `origin/main` = `https://github.com/JENN2046/VCPToolBox` |
| 当前本地 `main` | `0d0adc0a feat: add embedding model resilience` |
| 当前 `origin/main` | `e034131d feat: add semantic model router runtime and admin editor` |
| 本地领先远端 | `main...origin/main [ahead 3]` |
| tracked 工作树 | 干净 |
| 未跟踪文件 | 本台账文件：`docs/governance/UPSTREAM_ABSORB_LOG_20260528.md` |
| ignored 本地环境目录 | `rust-vexus-lite/node_modules/`、`rust-vexus-lite/target/` |

注意：

- 这 3 个本地 ahead commit 是：`56232b6d`、`cc63628b`、`0d0adc0a`。
- 这 3 个 commit 尚未推送到 `origin/main`。
- 本表只记录本地审查与吸收结果，不代表已经完成远端同步。

## 2. 已吸收记录

| 吸收时间 | upstream commit | upstream 时间 | upstream 主题 | 本地落点 | 本地落点时间 | 当前状态 | 验证记录 | 准确说明 |
|----------|-----------------|---------------|---------------|----------|--------------|----------|----------|----------|
| 2026-05-28 18:00:44 +08:00 | `9338e01e` | 2026-05-27 20:37:59 +08:00 | 上架 vcp 智能模型路由器 | `e034131d feat: add semantic model router runtime and admin editor` | 2026-05-28 18:00:44 +08:00 | 已吸收并已推送 | `.agent_board/CHECKPOINT.md`、`.agent_board/VALIDATION_LOG.md` | 这是拆包吸收，不是 raw cherry-pick。`git cherry` 仍可能显示 `9338e01e` 为 `+`，因为本地 commit hash 和 upstream commit hash 不同。 |
| 2026-05-26 01:40:53 +08:00 | `13ddefe9` | 2026-05-25 22:53:04 +08:00 | 修复某些情况下边界库的冷启动初始容错问题 | `debfa1da chore: absorb upstream urlfetch and vexus fixes` | 2026-05-26 01:40:53 +08:00 | 已吸收并已推送 | 2026-05-28 复核：`rust-vexus-lite/src/lib.rs` 和 `rust-vexus-lite/vexus-lite.win32-x64-msvc.node` 与 upstream `13ddefe9` Git object 一致 | 本轮没有替换 `.node` 二进制，因为当前二进制已经与 upstream 一致。 |
| 2026-05-28 18:59:45 +08:00 | `13ddefe9` 后续测试修正 | 2026-05-25 22:53:04 +08:00 | Rust/Vexus native refresh 运行态测试 | `cc63628b test: update rust vexus lite smoke test` | 2026-05-28 18:59:45 +08:00 | 已吸收但未推送 | `node rust-vexus-lite/test.js`；NAPI build 到 `rust-vexus-lite/target/napi-build-check`；fresh build binary smoke；`cargo test --manifest-path rust-vexus-lite/Cargo.toml --locked` | 只修正 `rust-vexus-lite/test.js`，让测试匹配当前 `add/addBatch/search/remove/stats` API；没有改生产 `.node`。 |
| 2026-05-28 19:17:37 +08:00 | `2ae8a9d0` | 2026-05-28 18:42:46 +08:00 | 新增向量容灾系统 | `0d0adc0a feat: add embedding model resilience` | 2026-05-28 19:17:37 +08:00 | 已吸收但未推送 | `node --test tests/embedding-model-fallback.test.js`；`node --check EmbeddingUtils.js KnowledgeBaseManager.js TagMemoEngine.js tests/embedding-model-fallback.test.js`；`node rust-vexus-lite/test.js`；`git diff --check` | 保留本地已有 backend fallback 机制，新增同一 embedding backend 内的模型候选切换，并接入 `EmbeddingModelSig`。没有调用真实 embedding 服务。 |
| 2026-05-28 18:30:23 +08:00 | upstream continuation audit | 不适用 | 记录剩余 upstream 正差异审查结论 | `56232b6d docs: checkpoint upstream continuation audit` | 2026-05-28 18:30:23 +08:00 | 已记录但未推送 | `git cherry -v main upstream/main`、文件范围审查 | 这是审计记录提交，不是功能吸收提交。 |
| 2026-05-29 11:21:53 +08:00 | `fad82a91` | 2026-05-28 20:23:42 +08:00 | 优化布尔值兼容 | `f857d86c 优化布尔值兼容` | 2026-05-29 11:21:53 +08:00 | 已吸收但未推送 | `node --check Plugin/LightMemo/LightMemo.js`；LightMemo helper inline assertions；`node tests/gptimagegen-safety.test.js` | 原样 cherry-pick 上游单文件补丁。规范化 `search_all_knowledge_bases`、`k`、`tag_boost`、`core_tags`、`core_boost_factor`，避免字符串 `"false"` 被 JS 当作真值。 |

## 3. 已审但本轮没有吸收的 upstream commit

这些 commit 已经审查过。本轮不直接吸收它们。后续如果要吸收，必须按表中“后续动作”重新开包。

| upstream commit | upstream 时间 | 主题 | 改动文件 | 本轮决定 | 明确原因 | 后续动作 |
|-----------------|---------------|------|----------|----------|----------|----------|
| `18728628` | 2026-05-25 13:55:33 +08:00 | FileOperator 路径回退、README、EmojiListGenerator 文档、VSearch 错误提示 | `Plugin/EmojiListGenerator/README.md`；`Plugin/FileOperator/FileOperator.js`；`Plugin/FileOperator/README.md`；`Plugin/FileOperator/config.env.example`；`Plugin/VSearch/VSearch.js` | 已审未吸收 | 一个 commit 混合 3 个主题：FileOperator 行为、文档、VSearch 错误提示。不能作为单一安全窄包 raw cherry-pick。 | 如需要，拆成 `FileOperator path fallback`、`VSearch error message`、`Emoji docs` 三个独立包。 |
| `973e2bdd` | 2026-05-25 23:16:00 +08:00 | fixKBDRebuild 方法 + 优化 UrlFetch 返回格式 | `KnowledgeBaseManager.js`；`Plugin/UrlFetch/UrlFetch.js` | 已审未吸收 | 与已经存在的本地 `debfa1da` UrlFetch/Vexus 吸收线重叠；raw cherry-pick 会重新覆盖当前 `KnowledgeBaseManager.js` 和 `UrlFetch.js` 的本地治理形态。 | 如需要，只能重新开 `UrlFetch return format` 窄包，对当前文件做手工补丁。 |
| `09fdab2a` | 2026-05-25 23:41:23 +08:00 | 为 URLFetch 引入 JinA 鉴权访问模式 | `Plugin/UrlFetch/UrlFetch.js`；`Plugin/UrlFetch/config.env.example`；`Plugin/UrlFetch/plugin-manifest.json` | 已审未吸收 | 改动涉及插件行为、配置样例和 manifest。当前本地 UrlFetch 已有不同实现线，不能 raw cherry-pick 覆盖。 | 如用户需要 JinA 鉴权，单独开 `UrlFetch JinA auth` 包，并做配置兼容审查。 |
| `b30dbf7e` | 2026-05-25 23:47:51 +08:00 | 优化逻辑 | `Plugin/UrlFetch/UrlFetch.js` | 已审未吸收 | 主题描述过窄且不说明行为边界；文件与当前本地 UrlFetch 线冲突。 | 需要先做 `git show b30dbf7e -- Plugin/UrlFetch/UrlFetch.js` 行为审查，再决定是否手工移植。 |
| `3a95a1e3` | 2026-05-26 13:12:43 +08:00 | 引入缓存 Fuzzy 可调参机制 | `AdminPanel-Vue/dist/*`；`AdminPanel-Vue/src/features/rag-tuning/metadata.ts`；`Plugin/ContextFoldingV2/ContextFoldingV2.js`；`Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js`；`modules/messageProcessor.js`；`rag_params.json` | 已审未吸收 | 包含前端构建产物、RAG 参数、插件行为和 message processor 运行逻辑，风险面过宽。 | 如需要，开 `RAG fuzzy tuning` 设计包，先审 `rag_params.json` 是否属于运行参数。 |
| `07c9994e` | 2026-05-26 21:47:45 +08:00 | 统一图片生成类工具格式调用 | `Plugin/DMXDoubaoGen/DoubaoGen.js`；`Plugin/GPTImageGen/GPTImageGen.js`；`Plugin/NanoBananaGen2/NanoBananaGen.mjs`；`Plugin/ZImageTurboGen/ZImageTurboGen.mjs`；`TVStxt/MediaToolBox.txt` | 已审未吸收 | 同时修改多个生图插件和 TVS 文本提示资源。当前项目正在单独讨论 Codex 内置 `image_gen` 接入，不能把这条作为普通 raw absorb。 | 需要单独开 `image tool format unification` 包，逐插件验证。 |
| `0c45a35a` | 2026-05-27 04:27:35 +08:00 | 补齐重要参数的浪潮可调参 | `AdminPanel-Vue/dist/*`；`AdminPanel-Vue/src/features/rag-tuning/metadata.ts`；`Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js`；`rag_params.json` | 已审未吸收 | 和 `3a95a1e3` 同类，包含构建产物和 RAG 运行参数，不能 raw cherry-pick。 | 如需要，合并到同一个 `RAG fuzzy tuning` 包处理。 |
| `696e3a9f` | 2026-05-28 04:41:42 +08:00 | 更新说明 | `README.md` | 已审未吸收 | 只有 README 更新；内容未作为本地主线说明采用。 | 如需要，开文档同步包，逐段比对 README，不直接覆盖本地 README。 |

## 4. 为什么 `git cherry` 还会显示 `+`

当前策略是“拆包吸收 / 手工移植”，不是“把 upstream commit 原样 cherry-pick”。

因此会出现这种情况：

- 功能已经进入本地 `main`；
- 但本地 commit hash 与 upstream commit hash 不同；
- `git cherry -v main upstream/main` 仍显示 upstream commit 为 `+`。

已知例子：

| upstream commit | 本地解释 |
|-----------------|----------|
| `9338e01e` | 功能已由 `e034131d` 吸收，但不是原样 cherry-pick。 |
| `13ddefe9` | Rust/Vexus 文件已由 `debfa1da` 覆盖，测试修正由 `cc63628b` 补齐。 |
| `2ae8a9d0` | 功能已由 `0d0adc0a` 手工吸收，保留本地 fallback backend 机制。 |

结论：

- 不得只根据 `git cherry` 的 `+` 判断“还没吸收”。
- 必须结合本表、本地 commit、文件范围和验证结果判断。

## 5. 当前明确剩余项

截至 2026-05-29，本表没有标记“必须继续吸收”的 upstream commit。

当前剩余项只有两类：

| 类别 | 内容 | 处理 |
|------|------|------|
| 已审未吸收 | 第 3 节列出的 upstream commit | 不自动吸收；需要用户明确指定后单独开包。 |
| 本地未推送 | `f857d86c` 以及本次台账更新提交 | 如果要让 `origin/main` 获得这轮结果，需要用户明确批准 push。 |

## 6. 下次审查固定流程

只读检查：

```powershell
git fetch upstream
git status --short --branch
git cherry -v main upstream/main
git diff --name-status main..upstream/main
```

分类规则：

| 分类 | 标准 |
|------|------|
| `absorb` | 小、当前有效、可验证、不会覆盖本地主线治理形态。 |
| `covered` | 行为已由本地 commit 实现，但 hash 不同。必须写明本地 commit。 |
| `defer` | 有价值，但需要设计包或跨模块验证。 |
| `reject` | stale、生成产物、运行态、真实配置、密钥风险、或会删除本地治理资产。 |
