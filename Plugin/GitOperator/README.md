# GitOperator — VCP Git 仓库管理插件

> **版本**: v1.0.1 | **作者**: Nova & hjhjd | **日期**: 2026-03-02

## 📌 这是什么？

GitOperator 是一个为 VCP 系统设计的 **配置档驱动 (Profile-Driven)** Git 仓库管理插件。它解决了一个常见的痛点：

**当你的项目是从别人的仓库 fork 来的时候**，`git pull` 拉的是自己仓库的代码，而不是上游的最新更新。每次想同步上游都得手动配置 remote，非常麻烦。

GitOperator 让你把所有仓库地址、凭证、上下游关系写在一个配置文件里，然后通过 AI 对话就能完成拉取、推送、同步等所有 Git 操作。

---

## 🚀 核心特性

- **多仓库管理**：通过 `repos.json` 配置多个仓库档案（Profile），随时切换操作目标
- **一键上游同步**：`SyncUpstream` 命令自动完成 fetch → stash → merge → push 全流程
- **凭证安全注入**：GitHub Token 仅在推送时临时注入 URL，不会写入 `.git/config`
- **输出自动脱敏**：所有返回给 AI 的内容会自动将 Token 替换为 `ghp_xxxx****xxxx` 格式
- **危险操作保护**：5 条危险指令需要通过 `captchaDecoder` 模块实时校验真实验证码
- **冲突智能处理**：Merge / Rebase / SyncUpstream 遇冲突自动 abort 恢复干净状态
- **串行调用**：支持一次请求执行多个 Git 操作（如 Add → Commit → Push），遇错自动中断
- **路径白名单**：所有文件操作限制在 `config.env` 的 `PLUGIN_WORK_PATHS` 范围内
- **配置兼容**：同时支持嵌套结构（`push.url`）和扁平结构（`pushUrl`），自动归一化

---

## 📂 文件结构

```
Plugin/GitOperator/
├── GitOperator.js          # 主脚本（异步入口，~650行）
├── plugin-manifest.json    # 插件清单（25条指令定义）
├── config.env              # 运行配置（路径白名单、日志开关）
├── config.env.example      # 配置模板
├── repos.json              # 仓库配置档（⚠️ 含凭证，勿提交）
├── repos.json.example      # 仓库配置示例
├── debug.log               # 运行时调试日志（自动生成）
└── README.md               # 本文档
```

---

## ⚙️ 快速开始

### 第一步：配置 config.env

打开 `config.env`，根据需要修改：

```env
# 插件工作路径白名单（逗号分隔，支持多个路径）
PLUGIN_WORK_PATHS=../../

# 日志开关（true/false）
ENABLE_LOGGING=true
```

> `PLUGIN_WORK_PATHS` 默认是 `../../`（VCP 项目根目录）。路径会被 `path.resolve` 解析为绝对路径后做前缀匹配。如果要管理其他位置的仓库，把路径加进来即可。

### 第二步：配置 repos.json

这是最重要的配置文件。GitOperator 同时支持**嵌套结构**和**扁平结构**两种写法，推荐使用嵌套结构（更清晰）：

#### 推荐写法（嵌套结构）

```json
{
  "defaultProfile": "VCPToolBox",
  "profiles": {
    "VCPToolBox": {
      "localPath": "../../",
      "push": {
        "remote": "origin",
        "url": "https://github.com/你的用户名/VCPToolBox.git",
        "branch": "main"
      },
      "pull": {
        "remote": "upstream",
        "url": "https://github.com/lioensky/VCPToolBox.git",
        "branch": "main"
      },
      "credentials": {
        "email": "你的邮箱",
        "username": "你的GitHub用户名",
        "token": "ghp_你的PersonalAccessToken"
      },
      "mergeStrategy": "merge"
    }
  }
}
```

#### 兼容写法（扁平结构）

```json
{
  "defaultProfile": "my-repo",
  "profiles": {
    "my-repo": {
      "localPath": "../../",
      "pushUrl": "https://github.com/你的用户名/Repo.git",
      "pushRemote": "origin",
      "pushBranch": "main",
      "pullUrl": "https://github.com/上游用户名/Repo.git",
      "pullRemote": "upstream",
      "pullBranch": "main",
      "email": "你的邮箱",
      "username": "你的GitHub用户名",
      "token": "ghp_你的Token",
      "mergeStrategy": "merge"
    }
  }
}
```

> 插件内部会自动归一化：嵌套字段优先，缺失时回落到扁平字段。两种格式混用也没问题。

**字段说明**：

| 字段 | 说明 |
|------|------|
| `defaultProfile` | 不指定 profile 参数时默认使用的档案名称 |
| `localPath` | 本地仓库路径（支持相对路径，会被 `path.resolve` 转为绝对路径） |
| `push.remote` / `pushRemote` | 推送目标 remote 名称（默认 `origin`） |
| `push.url` / `pushUrl` | 推送目标 URL（你自己的仓库） |
| `push.branch` / `pushBranch` | 推送目标分支（默认 `main`） |
| `pull.remote` / `pullRemote` | 拉取来源 remote 名称（默认 `upstream`） |
| `pull.url` / `pullUrl` | 拉取来源 URL（上游仓库） |
| `pull.branch` / `pullBranch` | 拉取来源分支（默认 `main`） |
| `credentials.token` / `token` | GitHub Personal Access Token |
| `credentials.email` / `email` | Git 提交邮箱 |
| `credentials.username` / `username` | Git 提交用户名 |
| `mergeStrategy` | 同步合并策略：`merge`（默认）或 `rebase` |

> ⚠️ **安全提醒**：`repos.json` 包含你的 GitHub Token，请确保它已加入 `.gitignore`，**绝对不要**提交到仓库！

### 第三步：重启 VCP 服务

配置完成后重启 VCP 服务器，GitOperator 插件会自动加载。首次调用时会自动校准 remote（`ensureRemotes`）。

---

## 📋 全部指令一览

GitOperator 共提供 **25 条指令**，分为 5 个类别：

### 只读查询（8条）

| 指令 | 功能 | 关键参数 |
|------|------|----------|
| `Status` | 查看仓库状态（工作区 + 暂存区） | `profile`（可选） |
| `Log` | 查看提交历史（返回结构化 JSON） | `maxCount`（默认20）、`branch`（可指定远程分支） |
| `Diff` | 查看变更差异，输出自动截断 | `target`（如 `upstream/main`、`HEAD~3`）、`maxLines`（默认200） |
| `BranchList` | 列出所有本地和远程分支 | — |
| `RemoteInfo` | 查看远程仓库信息（自动脱敏） | — |
| `StashList` | 查看 stash 暂存列表 | — |
| `TagList` | 查看标签列表 | — |
| `ProfileList` | 列出所有仓库配置档（不含敏感凭证） | 无需 profile |

### 常规写操作（7条）

| 指令 | 功能 | 关键参数 |
|------|------|----------|
| `Add` | 暂存文件到索引 | `files`（必需，`"."` = 全部，多个文件空格分隔） |
| `Commit` | 提交暂存区变更 | `message`（必需） |
| `Pull` | 拉取代码，默认走 `pull` 配置（上游仓库） | `source`（可选，`"pull"` = 上游，`"push"` = 自己仓库） |
| `Push` | 推送代码，走 `push` 配置，自动注入凭证 | — |
| `Fetch` | 获取远程引用（不合并） | `source`（可选，`"pull"` = 上游，`"push"` = 自己仓库） |
| `Clone` | 克隆远程仓库到本地 | `url`（必需）、`localPath`（必需）、`profile`（可选，自动创建） |
| `SyncUpstream` ⭐ | 一键同步上游仓库 | — |

### 分支管理（3条）

| 指令 | 功能 | 关键参数 |
|------|------|----------|
| `BranchCreate` | 创建新本地分支 | `branchName`（必需）、`startPoint`（可选，默认 HEAD） |
| `Checkout` | 切换到指定分支 | `branch`（必需） |
| `Merge` | 将指定分支合并到当前分支 | `branch`（必需） |

### 🔒 危险操作（5条，需验证码）

| 指令 | 功能 | 关键参数 |
|------|------|----------|
| `ForcePush` | 强制推送（`git push --force`） | `requireAdmin`（必需，6位验证码） |
| `ResetHard` | 硬重置到指定提交 | `target`（可选，默认 HEAD）、`requireAdmin`（必需） |
| `BranchDelete` | 删除本地分支（`git branch -D`） | `branchName`（必需）、`requireAdmin`（必需） |
| `Rebase` | 变基当前分支（冲突自动 abort） | `onto`（必需）、`requireAdmin`（必需） |
| `CherryPick` | 摘取指定提交（冲突自动 abort） | `commitHash`（必需）、`requireAdmin`（必需） |

> **验证码机制**：危险操作调用时需提供 `requireAdmin` 参数。插件会通过 VCP 系统的 `captchaDecoder` 模块实时读取 `UserAuth/code.bin`，解码出真实验证码进行比对。**错误的验证码**或**缺失参数**都会被直接拒绝，不会执行任何 Git 命令。

### 配置管理（3条）

| 指令 | 功能 | 关键参数 |
|------|------|----------|
| `ProfileAdd` | 添加新仓库配置档（自动配置 remote） | `profileName`（必需）、`localPath`（必需）及其他可选字段 |
| `ProfileEdit` | 编辑已有配置档（只传需修改的字段） | `profileName`（必需）及需修改的字段 |
| `ProfileRemove` | 删除仓库配置档 | `profileName`（必需） |

---

## ⭐ SyncUpstream 详解

这是 GitOperator 最核心的功能。一条命令完成从上游仓库的完整同步：

```
执行流程：
1. git fetch <pullRemote>                          — 获取上游最新引用
2. git status --porcelain                          — 检查未提交更改
3. git stash push -m "VCP-auto-stash"              — 有更改则自动暂存保护
4. git merge/rebase <pullRemote>/<pullBranch>      — 执行合并（策略取决于配置）
   ├─ 成功 → 继续
   └─ 冲突 → 自动 abort + stash pop + 返回冲突文件列表
5. git stash pop                                   — 恢复暂存的本地更改
6. git push <pushRemote> <pushBranch>              — 推送到自己的远程仓库
```

**使用场景**：你 fork 了 lioensky/VCPToolBox，想把上游的最新更新同步到你自己的仓库。只需告诉 AI "同步一下上游"，GitOperator 会自动完成全部步骤。

---

## 🔗 串行调用

支持在一次请求中执行多个连续操作，非常适合 "Add → Commit → Push" 这样的常见工作流。

AI 会自动构造带数字后缀的参数，例如：

```
command1: "Add",      files1: "."
command2: "Commit",   message2: "feat: 新功能"
command3: "Push"
```

**串行行为**：
- 所有指令按顺序执行，共享 `profile` 参数
- 任一指令执行失败 → 后续指令**自动中止**，返回已执行的结果 + 中止原因
- 单条指令（只有 `command` 没有 `command1`）自动走单指令路径，无额外开销

---

## 🛡️ 安全架构

GitOperator 采用 **多层安全防护**：

| 层级 | 机制 | 说明 |
|------|------|------|
| 1 | **路径白名单** | 所有操作的 `localPath` 必须在 `PLUGIN_WORK_PATHS` 的前缀范围内 |
| 2 | **凭证脱敏** | 输出中的 Token 自动替换为 `ghp_xxxx****xxxx` 格式 |
| 3 | **凭证仅内存注入** | Token 只在 push URL 中临时拼接，不写入 `.git/config` 或日志 |
| 4 | **Auth 验证码守卫** | 5 条危险指令通过 `captchaDecoder` 实时校验 `code.bin` 中的真实验证码 |
| 5 | **参数存在性检查** | 危险操作缺失 `requireAdmin` 参数时，在校验前就直接拒绝 |
| 6 | **冲突自动中止** | Merge / Rebase / SyncUpstream 遇冲突自动 `--abort`，不留半成品 |
| 7 | **safe.directory** | `ProfileAdd` 时自动配置 `git config --global --add safe.directory` |

---

## 🔧 自动校准机制（ensureRemotes）

通过 `ProfileAdd` 创建 Profile 时，插件会自动执行以下校准：

1. 检查 `pushRemote`（默认 `origin`）→ 存在则 `set-url`，否则不新增（Git 默认已有 origin）
2. 检查 `pullRemote`（默认 `upstream`）→ 不存在则 `remote add`，URL 不匹配则 `set-url`
3. 自动设置 `user.email` 和 `user.name`
4. 自动添加 `safe.directory` 白名单

**这意味着你只需要在 repos.json 里填好地址，第一次创建 Profile 时它会自动把所有 remote 配好。**

---

## 💡 常见使用场景

### 场景 1：日常开发提交
> "Nova，帮我把改动都提交了，备注'修复登录bug'，然后推上去"

AI 执行：`Add(".")` → `Commit("修复登录bug")` → `Push`

### 场景 2：同步上游更新
> "Nova，从上游仓库同步一下最新代码"

AI 执行：`SyncUpstream`（自动 fetch → merge → push）

### 场景 3：查看远程更新了什么
> "Nova，看看远程仓库更新了啥"

AI 执行：`Fetch` → `Log(branch: "upstream/main")` → `Diff(target: "upstream/main")`

### 场景 4：创建功能分支
> "Nova，帮我创建一个 feature/dark-mode 分支并切过去"

AI 执行：`BranchCreate("feature/dark-mode")` → `Checkout("feature/dark-mode")`

### 场景 5：危险操作（需验证码）
> "Nova，强制推送一下，验证码 123456"

AI 执行：`ForcePush(requireAdmin: "123456")` → 插件读取 code.bin 校验 → 匹配则执行，不匹配则拒绝

---

## ❓ FAQ

**Q：我没有上游仓库怎么办？**
A：`pull` 配置中的 `url` 留空或不配置 `pull` 对象即可。Pull 指令会自动使用 push 配置的 remote。

**Q：Token 会不会泄露？**
A：不会。Token 只在推送时临时注入到内存中的 URL 里，不会写入 `.git/config`。所有返回给 AI 的输出都会经过 `sanitizeOutput()` 自动脱敏。

**Q：遇到合并冲突怎么办？**
A：GitOperator 会自动中止合并（`git merge --abort` 或 `git rebase --abort`），恢复到干净状态，并返回冲突文件列表。你可以手动解决冲突后再次尝试。

**Q：可以管理多个仓库吗？**
A：可以！在 `repos.json` 的 `profiles` 里添加多个配置即可。调用时指定 `profile` 参数切换目标仓库。不指定则使用 `defaultProfile`。

**Q：嵌套结构和扁平结构可以混用吗？**
A：可以。插件的 `resolveProfile()` 会自动归一化：优先读取嵌套字段（`push.url`），缺失时回落到扁平字段（`pushUrl`）。

**Q：验证码从哪里来？**
A：验证码由 VCP 系统的 `UserAuth` 模块管理，存储在 `Plugin/UserAuth/code.bin` 中。GitOperator 通过 `captchaDecoder` 模块实时解码。验证码是动态的，每次都需要获取最新的。

---

## 📜 许可

本插件作为 VCP 系统的一部分，遵循 VCP 项目的开源协议。

---

*Built with ❤️ by Nova & hjhjd — 2026.03.02*