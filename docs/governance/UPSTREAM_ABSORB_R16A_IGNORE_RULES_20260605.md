# Upstream Absorb R16A Ignore Rules - 2026-06-05

本文件记录 R16A 对 upstream 小型 ignore 规则变更的拆包吸收结论。

本批只吸收本地安全的 ignore 规则，不吸收 upstream 大型 Docker/Rust/TDB/EPA/OneRing/前端/插件包。

## 1. 基线

| 项目 | 值 |
|------|----|
| 本地目标 | `main` |
| 本地目标 commit | `1a275573 Merge pull request #121 from JENN2046/codex/secretless-serum-live-channel` |
| upstream 来源 | `https://github.com/lioensky/VCPToolBox` |
| upstream ref | `upstream/main` |
| fetched upstream commit | `aa7e2e0e Merge pull request #350 from miaotouy/main` |
| 本地分支 | `codex/r16a-upstream-ignore-rules-20260605` |

## 2. Upstream 候选

| upstream commit | 主题 | 结论 | 说明 |
|-----------------|------|------|------|
| `79764f12` | `chore(SkillBridge): 移除 skill-index.txt 并添加 .gitignore 忽略规则` | 部分覆盖 / 不直接吸收 | 本地根 `.gitignore` 已有 `Plugin/SkillBridge/skill-index.txt`。删除已跟踪 `Plugin/SkillBridge/skill-index.txt` 属于文件删除动作，本批不自动执行。 |
| `7702a533` | `chore(Agent): 为Agent目录添加.gitignore规则` | 已适配吸收 | 新增 `Agent/.gitignore`，但白名单按本地已跟踪 Agent 配置文件完整适配，避免照搬 upstream 只列 8 个文件的较窄规则。 |
| `d3f58c7e` | `chore: 忽略 B站截图图片目录` | 已吸收 | 在根 `.gitignore` 增加 `image/bilibili/`，避免截图生成物误入状态。 |

## 3. 明确排除

- 不 raw merge `upstream/main`。
- 不 cherry-pick upstream 大包。
- 不删除 `Plugin/SkillBridge/skill-index.txt`。
- 不吸收 `AdminPanel-Vue/dist/*`、Rust `.node` 二进制、运行态、缓存、日志、图片输出或真实配置。
- 不触碰 `.env`、`config.env`、真实 token/key、operator 数据。

## 4. 验证计划

```powershell
git diff --check
git status --short --untracked-files=all
git check-ignore -v Agent/local-test.tmp image/bilibili/local-test.png
```

## 5. 结论

R16A 是一个纯 ignore 规则小包。

它只降低本地噪音文件误提交风险，不改变运行逻辑、插件执行、桥接行为、配置语义、构建产物或生产状态。
