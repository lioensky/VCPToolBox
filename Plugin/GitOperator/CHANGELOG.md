# GitOperator 变更日志

## [1.0.0] - 2026-03-02

### 阶段 1 - 核心基础设施 & 只读指令
- 初始插件骨架搭建: manifest, config.env, repos.json, CHANGELOG
- 核心工具函数: `loadEnvConfig()`, `loadRepos()`, `saveRepos()`, `resolveProfile()`, `buildAllowedPaths()`, `validatePath()`, `sanitizeOutput()`, `execGit()`, `ensureRemotes()`
- 通过 `parseSerialCommands()` 实现 `commandN` 语法的串行调用支持
- 只读指令: **Status**, **Log** (结构化 JSON 输出), **Diff** (自动截断), **BranchList**, **RemoteInfo**, **StashList**, **TagList**, **ProfileList**
- 写操作指令: **Add**, **Commit**
- 配置档管理: **ProfileAdd**, **ProfileEdit**, **ProfileRemove**

### 阶段 2 - 远程协作 & 凭证注入
- 凭证注入: `injectCredentials()` — Token 仅在内存中注入到 HTTPS URL，不会写入 `.git/config`
- 远程仓库路由: `resolveSourceRemote()` — 根据 `source` 参数路由到 pull/push 配置
- 远程协作指令: **Pull**, **Push**, **Fetch**, **Clone** (60秒超时)
- 一键上游同步: **SyncUpstream** ⭐ — 6步流水线: 获取 → 暂存 → 合并/变基 → 冲突检测 → 恢复暂存 → 推送
- 所有输出通过 `sanitizeOutput()` 进行 Token 脱敏

### 阶段 3 - 分支管理
- 分支管理指令: **BranchCreate** (支持可选的 startPoint 起点), **Checkout**, **Merge**
- 合并冲突检测，冲突时自动执行 `--abort` 以保持干净的工作区

### 阶段 4 - 危险操作 & Auth 守卫
- Auth 守卫: `requireAuth()` — 对照环境变量 `DECRYPTED_AUTH_CODE` 验证 `authCode`，三重拦截（环境未配置 / 未传验证码 / 验证码错误）
- 受保护指令 (🔒): **ForcePush**, **ResetHard** (含恢复提示), **BranchDelete** (当前分支保护 + 可选远程分支删除), **Rebase** (冲突自动中止), **CherryPick** (冲突自动中止)
- `DANGEROUS_COMMANDS` Set 集合，用于程序化识别危险操作

### 安全架构
- **路径白名单**: `PLUGIN_WORK_PATHS` 约束所有文件系统操作
- **Token 脱敏**: `sanitizeOutput()` 拦截所有包含凭证的输出
- **凭证隔离**: Token 仅存在于内存中的 URL 对象，不会持久化到 git 配置
- **Auth 验证**: 5 个危险指令需要 6 位数验证码
- **冲突安全**: Merge/Rebase/SyncUpstream/CherryPick 在冲突时自动中止
- **分支保护**: BranchDelete 拒绝删除当前所在分支
- **恢复提示**: ResetHard/Rebase 输出 `recoveryHint` 用于回滚

---

**总计: 22 条 Git 指令 + 3 条配置档管理指令 = 25 条调用指令**
**作者: Nova & hjhjd**