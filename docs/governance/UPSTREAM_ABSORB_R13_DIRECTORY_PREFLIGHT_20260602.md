# Upstream Absorb R13 Directory Preflight - 2026-06-02

本文件记录 R13 对 upstream `567cf29b 整理目录` 的只读预审结论。

本批只做 preflight 台账，不修改运行逻辑，不移动文件，不开实现分支。

## 1. 基线

| 项目 | 值 |
|------|----|
| 本地目标 | `origin/main` |
| 本地目标 commit | `2b5f9042 docs: close out r12 upstream intake` |
| upstream 来源 | `https://github.com/lioensky/VCPToolBox` |
| R13 upstream commit | `567cf29b 整理目录` |
| 当前 fetched upstream | `fb08623c` |
| 当前本地分支 | `main` |
| 当前工作树 | clean |

只读核对命令：

```powershell
git fetch upstream
git log --oneline --no-merges --reverse 72f6cb204309f9a0cba19bc856d2238c62a88d44..upstream/main
git show --name-status --no-renames --oneline 567cf29b
git show --summary --find-renames=60% --oneline 567cf29b
git show --stat --find-renames=60% --oneline 567cf29b
rg -n "README For VCPChat\.md|diary-tag-batch-processor\.js|rebuild_vector_indexes\.js|repair_database\.js|sync_missing_tags\.js|test-units\.js|timeline整理器\.py" -S . --glob '!node_modules/**' --glob '!.git/**' --glob '!AdminPanel-Vue/dist/**'
```

核对结果：

- `72f6cb20..upstream/main` 的 no-merge 列表当前只包含 `567cf29b`。
- `upstream/main` 已前进到 `fb08623c`，但新增内容不改变本次对 `567cf29b` 的预审范围。
- 当前本地工作树在生成本台账前为 clean。

## 2. 上游改动范围

`567cf29b` 主要是目录整理：

| 类别 | upstream 动作 |
|------|---------------|
| 文档移动 | 根目录多份 `.md` 移入 `docs/` |
| 脚本移动 | 根目录维护脚本移入 `scripts/` |
| 文档删除 | 删除 `README For VCPChat.md` |
| 内容变化 | `emergency_stop_frontend_guide.md` 和 `timeline整理器.py` 不是 100% 纯 rename |

`git show --summary --find-renames=60% 567cf29b` 显示：

- `README For VCPChat.md` 被删除，没有对应 `docs/` 迁移目标。
- 多数文档为 `R100` 纯 rename。
- 多数脚本为 `R100` 纯 rename。
- `emergency_stop_frontend_guide.md => docs/emergency_stop_frontend_guide.md` 为 `R097`。
- `timeline整理器.py => scripts/timeline整理器.py` 为 `R097`。

## 3. 预审结论

结论：`567cf29b` 不适合直接吸收，分类为 `defer / reject raw absorb`。

原因：

1. 它会移动多个当前仍在根目录的命令行脚本，改变用户已有命令入口。
2. `diary-tag-processor-package.json` 仍指向根目录 `diary-tag-batch-processor.js`：
   - `main = diary-tag-batch-processor.js`
   - `scripts.start = node diary-tag-batch-processor.js`
   - `scripts.process = node diary-tag-batch-processor.js`
   - `bin.tag-processor = ./diary-tag-batch-processor.js`
3. 多份本地文档、知识文件和 `docs/FILE_INVENTORY.md` 仍引用根目录脚本路径。
4. `README For VCPChat.md` 在 upstream 中被删除，但本地知识文件仍把它作为信源/出处引用。
5. `emergency_stop_frontend_guide.md` 和 `timeline整理器.py` 不是纯路径移动，内容差异需要单独审查。
6. 本地 `scripts/` 当前已有自己的治理/验证脚本，直接搬迁会扩大回归面。

因此，不能把该提交当作“无行为影响的目录整理”直接 cherry-pick 或 raw merge。

## 4. 必须排除的 raw absorb 内容

以下内容不得在未拆包审查前直接吸收：

- 删除 `README For VCPChat.md`。
- 移动根目录脚本但不更新调用入口和文档引用。
- 一次性移动所有 docs 与 scripts。
- 未审查 `emergency_stop_frontend_guide.md` 的内容变化。
- 未审查 `timeline整理器.py` 的内容变化。
- 任何会顺手带入后续 upstream 大包、TDB、运行态、缓存、`AdminPanel-Vue/dist/*` 的操作。

## 5. 可拆包条件

如后续要吸收该方向，应拆成独立小包。

### R13A: docs relocation audit

目标：

- 只处理文档位置整理。
- 保留 `README For VCPChat.md`，除非另有产品/文档确认。
- 对移动后的文档补齐或更新引用路径。
- 不移动脚本。

候选范围：

- `ChangeLog.md => docs/ChangeLog.md`
- `DIARY_TAG_BATCH_PROCESSOR.md => docs/DIARY_TAG_BATCH_PROCESSOR.md`
- `NEWAPI_MONITOR_前端接入与配置说明.md => docs/...`
- `SQLITE_REFACTOR_SUMMARY.md => docs/SQLITE_REFACTOR_SUMMARY.md`
- `SpikeRouting_Params_Guide.md => docs/SpikeRouting_Params_Guide.md`
- `TAGMEMO_TUNING_GUIDE.md => docs/TAGMEMO_TUNING_GUIDE.md`
- `TIMEZONE_CHECK_REPORT.md => docs/TIMEZONE_CHECK_REPORT.md`
- `审核系统开发文档和适配说明.md => docs/...`

验证：

- `rg` 检查旧路径引用是否已更新或保留兼容说明。
- `git diff --check`。
- 不跑运行时测试，除非文档引用生成脚本被修改。

### R13B: scripts relocation audit

目标：

- 只处理脚本目录整理。
- 先更新入口和文档，再移动脚本。
- 保留用户可预期的命令说明，必要时提供兼容 wrapper 或明确不搬迁。

候选范围：

- `check_tagmemo_status.js => scripts/check_tagmemo_status.js`
- `diary-semantic-classifier.js => scripts/diary-semantic-classifier.js`
- `diary-tag-batch-processor.js => scripts/diary-tag-batch-processor.js`
- `rebuild_tag_index_custom.js => scripts/rebuild_tag_index_custom.js`
- `rebuild_vector_indexes.js => scripts/rebuild_vector_indexes.js`
- `repair_database.js => scripts/repair_database.js`
- `sync_missing_tags.js => scripts/sync_missing_tags.js`
- `test-units.js => scripts/test-units.js`
- `timeline整理器.py => scripts/timeline整理器.py`

必须同时审查：

- `diary-tag-processor-package.json`
- `docs/FILE_INVENTORY.md`
- 根目录和 docs 中的脚本命令示例。
- dailynote/knowledge 内容中是否需要保留旧路径作为历史信源。

验证：

- `node --check` 对移动后的 `.js` 脚本逐个检查。
- 对无外部写入风险的脚本只做 `--help` 或静态检查；不得执行真实数据库修复、向量重建、标签同步或文件写入。
- `git diff --check`。

### R13C: content-diff audit

目标：

- 单独审查 `emergency_stop_frontend_guide.md` 与 `timeline整理器.py` 的内容变化。
- 只在确认不是格式/编码误差或意外改写后才吸收。

验证：

- 对 Markdown 做内容 diff review。
- 对 Python 脚本做语法检查，必要时只用临时目录和 fake input 做 dry-run。

## 6. 停止条件

后续实现包遇到以下情况应停止：

- 需要删除 `README For VCPChat.md`。
- 需要一次性移动所有文档和所有脚本。
- 发现脚本路径被 package/bin、服务启动、运维文档或知识文件依赖但没有兼容方案。
- 需要执行真实数据库修复、向量重建、标签同步、外部调用或生产服务。
- 需要修改 `.env`、`config.env`、运行态、缓存、日志、图片输出或真实用户数据。
- 需要顺手处理 TDB、RAG、AdminPanel build artifact 或其它 upstream 大包。

## 7. R13 结论

`567cf29b` 有目录整理价值，但不是一个可直接合入 `main` 的安全窄包。

下一步如继续 R13，应先做 `R13A docs relocation audit` 的更小预审，或直接把 `567cf29b` 标记为 `defer`，等待后续文档/脚本目录治理专项。
