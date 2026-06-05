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
| R16B TagMemo 启动/自检轻量优化 | `3ceedf22`, `59f34856`, `0094f190` | `TagMemoEngine.js` | 可合并成一个小包 | 单文件，同一主题：启动后派生刷新、自检简化、日志降噪。核心路径，需手工适配和本地验证，不 raw cherry-pick。 |
| R16C VCPToolBridge manifest version | `1fc2b56c` | `Plugin/VCPToolBridge/index.js` | 已在本分支实施 | 只给导出的 plugin manifest 增加 `version: plugin.version || "1.0.0"`。不改变执行分发，见 `UPSTREAM_ABSORB_R16C_VCPTOOLBRIDGE_VERSION_20260605.md`。 |
| R16D NanoBananaGen2 public URL switch | `8977a56a` | `Plugin/NanoBananaGen2/NanoBananaGen.mjs`, `Plugin/NanoBananaGen2/config.env.example`, `Plugin/NanoBananaGen2/plugin-manifest.json`, `Plugin/NanoBananaGen2/README.md`, `tests/gptimagegen-safety.test.js` | 已在 R16D 分支实施 | 采用本地修正版：默认 `USE_PUBLIC_URL=false`，显式公网模式使用 `VarHttpsUrl`，并补 manifest、README 与静态回归。见 `UPSTREAM_ABSORB_R16D_NANOBANANA_PUBLIC_URL_20260605.md`。 |

## 3. 需要先做 preflight 的候选

| 建议包 | upstream commits | 范围 | 原因 |
|--------|------------------|------|------|
| R16E RAGDiary 用户输入块向量化流程 | `46250ad7` | `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js` | 单文件但影响 RAGDiary 召回/向量化语义，需先审行为和测试入口。 |
| R16F Bridge function tool 兼容 | `cca1c915`, `e01d05fb` | `Plugin/VCPBridgeServer/bridgeserver.js`, `routes/protocolBridge.js` | 主题集中但 diff 较大，协议桥接敏感，先 preflight。 |
| R16G 配置样例补齐 | `e9c98eaa`, possibly `70a49e08` | `config.env.example`, plugin `.example` | 只改 example 较安全，但需确认变量已有代码消费，避免文档过度承诺。 |
| R16H Agent 编辑器右侧栏 | `c2f3b1a9` | `AdminPanel-Vue/src/*`, `AdminPanel-Vue/dist/*` | 只能考虑源码部分，必须排除 `AdminPanel-Vue/dist/*`，需要前端验证。 |

## 4. 已覆盖或只需台账核销

| upstream commits | 结论 |
|------------------|------|
| `79764f12`, `7702a533`, `d3f58c7e` | R16A 已拆包吸收 ignore 安全子集并合并到 `main`。`Plugin/SkillBridge/skill-index.txt` 删除没有执行，需要单独确认。 |
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
2. R16B TagMemo 启动/自检轻量优化。
3. R16D NanoBananaGen2 public URL switch 的本地修正版。
4. R16E/R16F 先做 preflight。

## 7. 验证建议

候选实现包应按范围选择最小验证：

```powershell
git diff --check
node --check <changed-js-files>
node --test <targeted-tests>
```

不得运行真实桥接、插件外部调用、生图请求、数据库修复、向量重建、生产服务或任何 runtime/cache/state 写入验证。
