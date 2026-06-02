# Upstream Absorb R12 Closeout - 2026-06-02

本文件记录 R12 阶段对 `upstream/main` 新增差异的核销结论。

本批只做台账更新，不修改运行逻辑。

## 1. 基线

| 项目 | 值 |
|------|----|
| 本地目标 | `origin/main` |
| 本地目标 commit | `2fb8bb1a Merge pull request #110 from JENN2046/codex/r12-dailynotepanel-auth-20260602` |
| upstream 来源 | `https://github.com/lioensky/VCPToolBox` |
| R12 upstream 起点 | `2aa92f49 修复面板ui的小bug` |
| R12 upstream 终点 | `72f6cb20 优化开机自检更严格的幽灵向量检查` |
| R12 核销范围 | `2aa92f49..72f6cb20` |
| 当前 fetched upstream | `567cf29b 整理目录` |
| 当前本地分支 | `main` |

只读核对命令：

```powershell
git fetch upstream
git log --oneline --no-merges --reverse 2aa92f4970a7633d30ddc703c766274c5c15c96f..72f6cb204309f9a0cba19bc856d2238c62a88d44
git log --oneline --no-merges --reverse 72f6cb204309f9a0cba19bc856d2238c62a88d44..upstream/main
git log --oneline --decorate --all --grep='DailyNotePanel\|dailynote panel\|UrlFetch\|urlfetch\|KnowledgeBaseManager\|vector reuse'
```

核对结果：

- `origin/main` 已到 `2fb8bb1a`。
- R12 原范围内共有 8 个 no-merge upstream commit。
- `upstream/main` 已在 R12 终点之后新增 `567cf29b`；该提交不纳入 R12，单独列为 R13 候选。
- 当前本地工作树在生成本台账前为 clean。

## 2. R12 核销项

| upstream commit | 主题 | 结论 | 本地落点 | 验证/说明 |
|-----------------|------|------|----------|-----------|
| `bb33d9a8` | 日记面板适配新版鉴权 | 已覆盖 | `#110` / `8fe834cd fix: harden dailynote panel auth routing` | 本地只吸收 DailyNotePanel admin auth route hoist 与 service worker API cache bypass。明确不吸收 upstream 夹带的大块 UI/style/workbench 改动，也不吸收浏览器本地保存 fallback 账号密码逻辑。验证：`node --test tests\dailynote-panel-auth.test.js` 4/4，PR CI 全绿。 |
| `d6ab3819` | 迁移知识库位置 | 拒绝 | 不适用 | 该提交移动/删除/新增大量 `dailynote/` 与 `knowledge/` 内容文件，`git show --stat` 显示 518 files changed。属于内容库重排和知识资产搬迁，不是稳定线可回滚窄包。 |
| `96998889` | 新增 TDB 知识库引入，新增冷热分离，记忆知识双重索引 | 延后 | 不适用 | 该提交包含 `AdminPanel-Vue/dist/*`、`Plugin.js`、`TDBKnowledge.js`、`Plugin/LightMemo/*`、DailyNote routes、Rust binary、`config.env.example`、`package-lock.json` 等跨模块变更。不能 raw cherry-pick，需拆 TDB 设计/安全包。 |
| `c0d5a95b` | 上架 `[[知识库]]` 相关语法，UrlFetch 新增保存网页为 Markdown | 已覆盖 | `#109` / `1468739a feat: add urlfetch markdown download safeguards`，后续 review fixes `e1b6bf9b`、`5449f993`、`28dd2f30`、`d75125c1`、`7dfecaf6` | 本地只吸收 UrlFetch download/save Markdown 与 provenance/no-overwrite/symlink/concurrency/proxy fallback 安全行为。明确避开 `AdminPanel-Vue/dist`、TDB/RAG 大包和宽改动。 |
| `5ce93331` | 优化写入功能 | 已覆盖 | `#109` / `1468739a` 及后续 review fixes | 本地实现 Markdown 保存防覆盖、目标目录安全检查、symlink 拒绝、并发目录创建容错和实际 fetch mode 记录。 |
| `9201749f` | 优化 TDB 数据库内存管理 | 延后 | 不适用 | 该提交只改 `TDBKnowledge.js` 和 `config.env.example`，但当前本地没有 `TDBKnowledge.js`，它依赖 `96998889` 的 TDB 大包。不能单独吸收。 |
| `6dc74742` | 优化文件移动时不需要二次向量化 | 已覆盖 | `#108` / `cd9b6a53 fix: harden knowledge base vector reuse` | 本地以 opt-in vector reuse 小包吸收，保留默认关闭和完整 stored vector 校验，避免无效/缺失 chunk vector 复用。 |
| `72f6cb20` | 优化开机自检更严格的幽灵向量检查 | 已覆盖 | `#108` / `cd9b6a53 fix: harden knowledge base vector reuse` | 与 `6dc74742` 同一 KnowledgeBaseManager 小包处理，补 targeted tests 锁定 reuse 与 ghost/vector 完整性相关行为。 |

## 3. 明确排除

以下内容不进入 R12：

- `AdminPanel-Vue/dist/*` 构建产物。
- TDB 冷热知识库大包和 `TDBKnowledge.js`，除非后续单独开设计包。
- `dailynote/`、`knowledge/` 大规模内容迁移。
- `config.env`、真实 `.env`、运行态、缓存、日志、图片输出、真实 token/key/socket 文件。
- `Plugin.js` 执行调度宽改动。
- Rust `.node` 单独二进制漂移。

## 4. 为什么仍会看到 upstream 正差异

R12 继续采用稳定线策略：

- 不 raw merge `upstream/main`。
- 不 raw cherry-pick 混合提交。
- 对可取行为按本地生产线拆包实现、review 修复、单独验证。

因此：

- `git cherry -v main upstream/main` 仍可能把已覆盖的 upstream commit 显示为 `+`。
- `git diff main..upstream/main` 仍会显示大量历史、生成产物、内容迁移、TDB 大包和上游目录整理差异。
- 判断是否已吸收必须以本台账、PR merge commit、目标文件行为和验证记录为准。

## 5. 当前 R12 状态

| 项目 | 状态 |
|------|------|
| DailyNotePanel auth routing | 已吸收并合并到 `main` |
| UrlFetch Markdown download/no-overwrite | 已吸收并合并到 `main` |
| KnowledgeBaseManager vector reuse | 已吸收并合并到 `main` |
| 知识库位置迁移 | 拒绝进入 R12 |
| TDB 冷热知识库大包 | 延后 |
| TDB 内存管理 | 延后，等待 TDB 大包设计结论 |

R12 结论：`2aa92f49..72f6cb20` 这段 upstream 差异已完成稳定线核销。当前没有适合继续从 R12 原范围直接开窄包的剩余项。

## 6. R13 候选

`upstream/main` 当前已新增：

| upstream commit | 主题 | 初步分类 | 说明 |
|-----------------|------|----------|------|
| `567cf29b` | 整理目录 | 需另开 R13 只读分类 | 主要将根目录文档移入 `docs/`、脚本移入 `scripts/`，并删除根目录旧路径。`git show --stat` 显示 41 files changed。属于目录重排，不应混入 R12 closeout。 |

## 7. 后续建议

如继续 upstream intake，下一步应先只读分类 R13：

```powershell
git fetch upstream
git log --oneline --no-merges --reverse 72f6cb204309f9a0cba19bc856d2238c62a88d44..upstream/main
git show --name-status --no-renames 567cf29b
```

R13 不应自动吸收目录整理提交；若要处理，建议先判断本地根目录文档和脚本是否有治理意义、是否已有引用路径依赖，再决定是否拆成 `docs relocation` 和 `scripts relocation` 两个可回滚小包。
