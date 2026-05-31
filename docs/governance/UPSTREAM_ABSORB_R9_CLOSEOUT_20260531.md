# Upstream Absorb R9 Closeout - 2026-05-31

本文件记录第 9 批 upstream 差异核销与回归锁定结论。

## 1. 基线

| 项目 | 值 |
|------|----|
| 本地目标 | `origin/prod/stable` |
| 目标 commit | `f0889569 Merge pull request #71 from JENN2046/upstream-absorb-r8-image-showbase64-20260531` |
| upstream 来源 | `https://github.com/lioensky/VCPToolBox` |
| upstream ref | `upstream/main` |
| upstream commit | `3f59348e 优化一个安全漏洞` |
| 分支 | `upstream-absorb-r9-diff-closeout-20260531` |

## 2. 本批原则

- 不 raw merge upstream。
- 不吸收生成产物、运行态文件、真实配置、密钥或本地缓存。
- 不触碰 `Plugin.js` 执行主链路，除非有新的未覆盖安全缺口。
- 对已经等效吸收的行为写明证据，并用静态回归锁定。
- 高风险多模块改动另开独立包。

## 3. 核销项

| upstream commit | 主题 | 结论 | 证据 | 后续 |
|-----------------|------|------|------|------|
| `3f59348e` | 优化一个安全漏洞 | 已覆盖 | `Plugin.js` 已在 admin-required stdio 和 hybrid direct 两条路径缺少 auth code 时拒绝执行；`tests/plugin-admin-auth-deny.test.js` 覆盖拒绝和不调用 service module。 | 本批不改执行链路，只加 closeout regression。 |
| `951b4e6b` + `b2f2a778` | DailyNote 返回字段优化 | 保留本地兼容形态，不直接吸收 upstream 形态 | 本地 `create` 同时保留 legacy top-level `message` 和结构化 `result`；`update` 保留 legacy string `result`、top-level `message` 和结构化 `details`。直接套 upstream 会收窄返回契约。 | 如后续要调整 DailyNote schema，需要单独评估调用方兼容性。 |
| `6e26fbcb` | GPTImageGen chat endpoint 兼容 | 已覆盖 | `Plugin/GPTImageGen/GPTImageGen.js` 已实现 `USE_CHAT_COMPLETIONS_MODE`、`/v1/chat/completions`、`image_generation` tool fallback；`tests/gptimagegen-safety.test.js` 已覆盖静态行为。 | 本批只补 closeout regression。 |
| `788a4da1` | GPTImageGen 数组/输出兼容 | 部分覆盖并保留本地文案 | 本地已保留 `savedBuffers`，且只在 `showBase64` 显式开启时返回 base64 image_url；编辑输入数组安全检查已有测试。upstream 的文本输出压缩属于展示文案，不作为本批必吸收项。 | 如需要统一输出文案，单独开 UI/文案兼容包。 |
| `47d201a1` | Linux 工具插件 hybridservice direct | 延后 | 涉及 `Plugin.js`、LinuxShell、SSH、LogMonitor、docs 和 module state，属于高风险多模块行为改动。 | 另开 Linux hybrid direct 设计/验证包。 |
| `95db5644` | connection pool persistence merge | 延后 | merge commit 影响 `Plugin.js`，需拆出具体行为再审。 | 不进入 R9。 |
| `bba50bc1` | TVS 文本相关 merge | 延后 | merge commit 未直接呈现窄源码补丁，且 TVS 文本资源需要单独产品确认。 | 不进入 R9。 |

## 4. 明确排除

以下 upstream 差异不进入第 9 批：

- `AdminPanel-Vue/dist/*`
- `image/*`
- `state/*`
- `cache/*`
- `Plugin/*/config.env`
- `Plugin/UserAuth/code.bin`
- `Plugin/DoubaoGen/.doubao_api_cache.json`
- 大规模删除本地治理文档、测试、agent board 或 channel/codex memory/photo studio 模块的 diff

## 5. 本批改动边界

本批只做：

- 新增本 closeout 文档。
- 新增静态回归测试，锁定已经覆盖或明确保留的行为。

本批不做：

- 不修改 `Plugin.js`。
- 不修改插件运行逻辑。
- 不修改 `.env`、`config.env`、`state/`、`cache/`、`image/`。
- 不执行真实插件文件写入、桥接、外部调用或生产服务。

## 6. 下一批建议

如继续吸收 upstream，建议下一批单独处理：

1. `Linux hybrid direct` 设计包：先只读审查 `47d201a1` 的每个文件行为，列出执行链路、SSH/log monitor token 注入、回滚点和测试夹具。
2. `DailyNote schema` 兼容包：只有在调用方确认不依赖 legacy 字段后，再考虑收窄返回格式。
3. `GPTImageGen response copy` 文案包：只处理展示文案，不混入端点或安全逻辑。
