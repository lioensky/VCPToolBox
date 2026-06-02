# Upstream Absorb R13 Closeout - 2026-06-03

本文件记录 R13 阶段对 upstream `567cf29b 整理目录` 的核销结论。

本批只做台账更新，不修改运行逻辑。

## 1. 基线

| 项目 | 值 |
|------|----|
| 本地目标 | `origin/main` |
| 本地目标 commit | `17c4ca26 Merge pull request #113 from JENN2046/codex/r13b2-diary-semantic-classifier-relocation-20260603` |
| upstream 来源 | `https://github.com/lioensky/VCPToolBox` |
| R13 upstream commit | `567cf29b 整理目录` |
| 当前 fetched upstream | `fb08623c Merge pull request #343 from DerstedtCasper/baijinmiao/dynamic-tools-auto-manager` |
| 当前本地分支 | `main` |
| 当前工作树 | clean |

只读核对命令：

```powershell
git status -sb
git log --oneline --decorate -n 6
git diff --find-renames=60% --name-status 567cf29b^ 567cf29b
git diff --name-status --find-renames=60% main 567cf29b -- '*.js' '*.py' '*.md'
rg -n "diary-tag-batch-processor\.js|rebuild_tag_index_custom\.js|rebuild_vector_indexes\.js|repair_database\.js|sync_missing_tags\.js|test-units\.js|timeline整理器\.py" -S . --glob '!node_modules/**' --glob '!.git/**' --glob '!AdminPanel-Vue/dist/**'
```

核对结果：

- `567cf29b` 是目录整理提交，不适合 raw absorb。
- R13 已按稳定线拆成三个可回滚小包吸收安全子集。
- 当前 `git cherry -v main upstream/main` 仍会显示 `567cf29b` 为正差异，因为本地有意只吸收安全子集，拒绝 raw cherry-pick。

## 2. R13 已吸收项

| 本地包 | PR / commit | 结论 | 内容 | 验证 |
|--------|-------------|------|------|------|
| R13A docs relocation | `#111` / `e9b3670a docs: relocate r13 docs into docs directory` | absorbed | 将低风险根目录文档迁移到 `docs/`，修正 `ChangeLog.md` 与 `NEWAPI_MONITOR_前端接入与配置说明.md` 的有效引用。保留 `README For VCPChat.md` 根目录兼容，不移动脚本。 | `git diff --cached --check`；路径存在性检查；PR CI 通过。 |
| R13B1 low-risk helper scripts | `#112` / `a6925878 docs: relocate low-risk helper scripts` | absorbed | 将 `check_tagmemo_status.js` 与 `example.test.js` 迁移到 `scripts/`，更新 `docs/FILE_INVENTORY.md`，修正 TagMemo 状态检查脚本的 `VectorStore` 相对路径。 | `node --check scripts/check_tagmemo_status.js`；`node --check scripts/example.test.js`；`git diff --cached --check`；PR CI 通过。 |
| R13B2 diary semantic classifier relocation | `#113` / `e1a898b6 docs: relocate diary semantic classifier script` | absorbed | 将 `diary-semantic-classifier.js` 与 `diary-semantic-classifier-guide.md` 成对迁移到 `scripts/`，修正 `config.env`、`EmbeddingUtils`、`rust-vexus-lite`、`VectorStore`、`dailynote` 的 root 路径解析，并更新命令示例。 | `node --check scripts/diary-semantic-classifier.js`；`git diff --cached --check`；PR CI 通过。 |

## 3. R13 拒绝项

| upstream 动作 | 结论 | 原因 |
|---------------|------|------|
| 删除 `README For VCPChat.md` | rejected | 本地 `dailynote/VCP知识/*` 与 `dailynote/VCP百科全书/*` 多处把它作为信源/出处引用；删除会破坏知识来源兼容。 |
| raw cherry-pick / raw merge `567cf29b` | rejected | 该提交混合文档移动、脚本移动、删除文档和换行差异；会一次性改变用户命令入口并删除兼容文件。 |
| 一次性移动所有剩余脚本到 `scripts/` | rejected | 剩余脚本包含 package/bin 入口、运维命令、数据库/索引写入、SSH/插件执行测试和用户文件输出脚本，不属于安全目录整理。 |

## 4. R13 延后项

| 剩余项 | 结论 | 说明 |
|--------|------|------|
| `diary-tag-batch-processor.js => scripts/diary-tag-batch-processor.js` | defer | `diary-tag-processor-package.json` 的 `main`、`scripts.start`、`scripts.process`、`bin.tag-processor` 全指向根目录；`docs/DIARY_TAG_BATCH_PROCESSOR.md`、`tag-processor-config.env.example` 和知识条目也使用根命令。未来若迁移，需要 root wrapper 或 package/doc 兼容方案。 |
| `rebuild_vector_indexes.js => scripts/rebuild_vector_indexes.js` | defer | 运维入口脚本，会删除并重建 `.usearch` 索引；知识库运维文档仍引用根命令。 |
| `rebuild_tag_index_custom.js => scripts/rebuild_tag_index_custom.js` | defer | 会改写数据库标签并重建 tag index；不适合目录整理小包。 |
| `repair_database.js => scripts/repair_database.js` | defer | 数据库修复脚本，会操作 SQLite 和索引；移动需要 root wrapper 与更强验证。 |
| `sync_missing_tags.js => scripts/sync_missing_tags.js` | defer | 会写入 `dailynote/TagSyncTrigger/...` 并触发 KnowledgeBaseManager embedding 流程；不适合目录整理小包。 |
| `test-units.js => scripts/test-units.js` | defer | 包含真实 SSH 连接、远端命令和插件执行路径；移动后需改多处 `require/cwd`，且不能安全运行验证。 |
| `timeline整理器.py => scripts/timeline整理器.py` | defer | 忽略 CRLF/行尾差异后无语义变化；移动会改变用户运行入口，脚本运行会创建目录并写输出文件，收益不足。 |

## 5. R13C 内容差异结论

| 文件 | 上游表现 | 结论 |
|------|----------|------|
| `emergency_stop_frontend_guide.md => docs/emergency_stop_frontend_guide.md` | `R097` | R13A 已以本地内容保持方式迁移，忽略 CRLF/行尾差异后无可吸收功能差异。 |
| `timeline整理器.py => scripts/timeline整理器.py` | `R097` | 忽略 CRLF/行尾差异后无可吸收功能差异；位置迁移因入口兼容和写文件风险延后。 |

## 6. 明确排除

以下内容不进入 R13：

- `AdminPanel-Vue/dist/*` 构建产物。
- TDB、RAG、知识库位置迁移或其它 upstream 大包。
- `.env`、`config.env`、真实凭据、运行态、缓存、日志、图片输出、用户数据。
- 真实数据库修复、向量重建、标签同步、SSH 连接、插件执行或外部调用验证。
- 删除 `README For VCPChat.md`。

## 7. 当前 R13 状态

| 项目 | 状态 |
|------|------|
| 文档迁移 | 已吸收并合并到 `main` |
| 低风险辅助脚本迁移 | 已吸收并合并到 `main` |
| 日记语义分类脚本迁移 | 已吸收并合并到 `main` |
| 根目录兼容 README | 保留，拒绝删除 |
| package/bin 或运维入口脚本迁移 | 延后 |
| 数据库/索引/标签写入脚本迁移 | 延后 |
| SSH/插件执行测试迁移 | 延后 |
| timeline 工具迁移 | 延后 |

R13 结论：`567cf29b` 的目录整理价值已按稳定线吸收安全子集；剩余内容不再适合继续拆“安全目录整理”小包。R13 可以收尾。

## 8. 后续建议

如未来仍要推进脚本目录治理，应另开专项而非继续 R13：

1. 先设计 root wrapper 或 package scripts 兼容策略。
2. 先更新运维文档、知识条目和命令示例。
3. 对数据库/向量/标签脚本只做静态检查或 fake workspace dry-run，不执行真实写入。
4. 对 `test-units.js` 先拆除真实 SSH/插件执行依赖，再考虑迁移。
