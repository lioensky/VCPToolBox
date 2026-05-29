# TicktickManager

滴答清单 / TickTick / Dida365 VCP 混合服务插件。同时提供：

- **同步调用**：AI 可显式创建、更新、完成、删除、搜索、读取任务。
- **静态注入**：定时（默认每 15 秒）拉取白名单项目快照，注入 `{{VCPTicktickTasks}}` 系统提示词占位符。
- **权限边界**：通过配置区分"仅可创建任务"和"全权限"项目，防止 AI 越权操作。

### 占位符说明

本插件使用两个占位符，分别承载不同内容：

| 占位符                   | 内容               | 用途                                                                                                            |
| ------------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `{{VCPTicktickTasks}}`   | 白名单项目任务快照 | 静态注入：按项目 → 任务 → 子任务结构展示全部白名单项目。由 VCP cron 定时刷新。                                  |
| `{{VCPTicktickManager}}` | 同步调用命令说明   | 同步插件提示词：AI 调用本插件时，VCP 根据 `invocationCommands` 自动生成。包含全部可用命令的参数说明和调用示例。 |

> 在 VCP 系统提示词中**同时**设置这两个占位符，AI 才能既看到任务快照、又能调用同步命令。

---

## 目录

1. [前置准备](#1-前置准备)
2. [获取 Access Token](#2-获取-access-token)
3. [获取收集箱真实 ID（可选）](#3-获取收集箱真实-id可选)
4. [配置 config.env](#4-配置-configenv)
5. [部署到 VCP](#5-部署到-vcp)
6. [AI 可用命令](#6-ai-可用命令)
7. [权限模型](#7-权限模型)
8. [轮询与刷新](#8-轮询与刷新)
9. [排障](#9-排障)

---

## 1. 前置准备

### 1.1 注册滴答清单账号

如果你还没有，先在 [dida365.com](https://dida365.com)（国内版）或 [ticktick.com](https://ticktick.com)（国际版）注册账号。

### 1.2 注册开发者账号并创建应用

1. 访问 **TickTick Developer Center**：  
   国际版 [developer.ticktick.com](https://developer.ticktick.com/manage)  
   国内版 [developer.dida365.com](https://developer.dida365.com/manage)

2. 创建一个新应用。

3. **回调 URL** 必须与 `TICKTICK_REDIRECT_URI` 一致（默认为 `http://localhost:8000/callback`）。

4. 记录下 **Client ID** 和 **Client Secret**，下一步需要用到。

---

## 2. 获取 Access Token

Token 必须在**能打开浏览器的本地机器**上获取。获取后复制到 VCP 部署机器即可。

### 2.1 填写 OAuth 凭据

打开插件根目录的 `config.env`，填入上一步获得的 Client ID 和 Client Secret：

```env
TICKTICK_CLIENT_ID=你的ClientID
TICKTICK_CLIENT_SECRET=你的ClientSecret
TICKTICK_REDIRECT_URI=http://localhost:8000/callback
```

> 国内版用户可将 `TICKTICK_BASE_URL` 改为 `https://api.dida365.com/open/v1`，其余端点会自动推导。也可显式设置 `TICKTICK_AUTH_URL`、`TICKTICK_TOKEN_URL`。

### 2.2 运行授权脚本

```bash
# 国际版（默认）
node auth-cli.js

# 国内版
node auth-cli.js --domestic

# 自定义回调端口
node auth-cli.js --port 3000
```

1. 脚本会启动本地 HTTP 回调服务器并自动打开浏览器。
2. 在浏览器中登录滴答清单并授权。
3. 授权成功后，**完整 access token 会同时打印到终端并写入 `config.env`**。
4. 复制终端中显示的完整 `TICKTICK_ACCESS_TOKEN` 到 VCP 部署机器的 `config.env` 中。

> **为什么没有 TICKTICK_REFRESH_TOKEN？**
>
> 根据滴答清单当前政策，OAuth 授权流程**不再下发 refresh token**，仅返回 access token。
> 因此本插件也不读取 `TICKTICK_REFRESH_TOKEN` 字段，不提供自动刷新能力。
>
> TICKTICK_ACCESS_TOKEN **有效期约为半年**。过期后需重新运行 `auth-cli.js` 获取新 token，并填入 `config.env` 后重启 VCPToolBox。
>
> 如果静态快照中出现"AUTH_ERROR"或"需要更新 TICKTICK_ACCESS_TOKEN"的提示，说明 token 已失效，按上述流程重新获取即可。

---

## 3. 获取收集箱真实 ID（可选）

滴答清单 OpenAPI 的 `GET /project` **不返回收集箱**。如果需要将收集箱纳入任务快照，必须获取它的真实 ID（格式为 `inbox` + 数字串）。

### 只读扫描（默认）

```bash
node get-inbox-project-id.js
```

仅尝试从 API 返回数据中读取 inbox ID。由于 OpenAPI 限制，只读扫描几乎一定失败，并会提示使用 `--write-probe`。

### 写入探测（推荐）

```bash
node get-inbox-project-id.js --write-probe
```

**执行流程**：

1. 创建一个临时任务（不指定 `projectId`，自动落入收集箱）。
2. 从返回数据中提取 `inbox+数字`。
3. **立即删除**该临时任务。

探测成功后，终端会输出类似：

```
临时任务 6a194xxxxxxxxx4d633 已创建并删除，探测到收集箱 ID：inbox10xxxxxx13
TICKTICK_INBOX_PROJECT_ID=inbox10xxxxxx13
```

将该值填入 `config.env` 的 `TICKTICK_INBOX_PROJECT_ID`，并在项目清单中加入 `"收集箱"`。

---

## 4. 配置 config.env

编辑插件根目录的 `config.env`。参考模板为 `config.env.example`。

```env
# ── 基础必填 ──────────────────────────────────
# 国际版：https://api.ticktick.com/open/v1
# 国内版：https://api.dida365.com/open/v1
TICKTICK_BASE_URL=https://api.dida365.com/open/v1

# 滴答清单 access token。由 auth-cli.js 获取。
TICKTICK_ACCESS_TOKEN=你的AccessToken

# ── OAuth 凭据（供 auth-cli.js 使用）────────────
TICKTICK_CLIENT_ID=
TICKTICK_CLIENT_SECRET=
TICKTICK_REDIRECT_URI=http://localhost:8000/callback
TICKTICK_OAUTH_SCOPE="tasks:read tasks:write"

# ── 收集箱（可选）──────────────────────────────
# 由 get-inbox-project-id.js 获取，格式为 inbox+数字串。
# 留空则跳过收集箱。
TICKTICK_INBOX_PROJECT_ID=inbox10xxxxxx13

# ── 项目清单 ───────────────────────────────────
# 每项必须用英文双引号包裹，英文逗号分隔。
# 支持项目 ID 或唯一项目名称；长期建议使用项目 ID。

# 仅允许创建任务和子任务
TICKTICK_CREATE_ONLY_PROJECTS="收集箱","某个只准新增的清单ID"

# 允许创建、更新、完成、删除、读取、搜索
TICKTICK_FULL_ACCESS_PROJECTS="工作","某个全权限清单ID"

# ── 调试 ───────────────────────────────────────
DebugMode=false
```

### 项目列表格式说明

```env
TICKTICK_CREATE_ONLY_PROJECTS="收集箱","项目名称","项目ID"
TICKTICK_FULL_ACCESS_PROJECTS="工作","另一个项目ID"
```

- 每个项目项**必须**使用英文双引号包裹。
- 项目项之间**必须**使用英文逗号分隔。
- 支持**项目 ID**（推荐）或**唯一项目名称**进行匹配。
- 如果某项目同时出现在两个清单中，**全权限优先**并输出警告。

---

## 5. 部署到 VCP

将整个插件目录复制到 VCP ToolBox 的 `Plugin/` 下，目录名为 `TicktickManager`。

```
VCPToolBox/
└── Plugin/
    └── TicktickManager/
        ├── plugin-manifest.json
        ├── TicktickManager.js
        ├── config.env              ← 必须填写
        ├── config.env.example      ← 模板，可删除
        ├── auth-cli.js              ← 本地授权脚本
        ├── get-inbox-project-id.js  ← 收集箱 ID 探测脚本
        ├── ticktick_static.md       ← 由插件自动生成
        └── .docs/                   ← 文档，可删除
```

确保以下字段已在 `config.env` 中正确填写：

- `TICKTICK_BASE_URL`
- `TICKTICK_ACCESS_TOKEN`

重启 VCPToolBox。启动后插件会：

1. 注册静态 cron 代理，开始按 `refreshIntervalCron`（默认每 15 秒）定时刷新。
2. 首次刷新完成后，`{{VCPTicktickTasks}}` 占位符即开始注入任务快照。

---

## 6. AI 可用命令

AI 通过 `<<<[TOOL_REQUEST]>>>` 调用 TicktickManager，`tool_name` 为 `TicktickManager`。

| 命令                 | 说明                             | 权限要求                  |
| -------------------- | -------------------------------- | ------------------------- |
| `create_task`        | 创建单个任务                     | create_only / full_access |
| `batch_create_tasks` | 批量创建任务                     | create_only / full_access |
| `create_subtask`     | 在父任务下创建子任务             | create_only / full_access |
| `update_task`        | 更新任务                         | full_access               |
| `complete_task`      | 完成任务                         | full_access               |
| `delete_task`        | 删除任务                         | full_access               |
| `search_tasks`       | 搜索任务                         | create_only / full_access |
| `get_project`        | 获取项目详情                     | create_only / full_access |
| `get_task`           | 获取任务详情（含四象限、子任务） | create_only / full_access |

**priority 枚举**：`0` = None，`1` = Low，`3` = Medium，`5` = High。

所有写操作成功后**立即刷新**静态快照，无需等待下一次定时轮询。

---

## 7. 权限模型

| 功能               | create_only | full_access | 非白名单 |
| ------------------ | ----------- | ----------- | -------- |
| create_task        | ✅          | ✅          | ❌       |
| batch_create_tasks | ✅          | ✅          | ❌       |
| create_subtask     | ✅          | ✅          | ❌       |
| update_task        | ❌          | ✅          | ❌       |
| complete_task      | ❌          | ✅          | ❌       |
| delete_task        | ❌          | ✅          | ❌       |
| search_tasks       | ✅ 读取     | ✅ 读取     | 不搜索   |
| get_project        | ✅ 读取     | ✅ 读取     | ❌       |
| get_task           | ✅ 读取     | ✅ 读取     | ❌       |
| 静态注入           | ✅ 注入     | ✅ 注入     | 不注入   |

---

## 8. 轮询与刷新

### 定时刷新

静态任务快照由 VCP 的 `refreshIntervalCron` 驱动，默认每 15 秒通过 `node TicktickManager.js --static-refresh` 刷新一次。

可在 `plugin-manifest.json` 中调整：

```json
"refreshIntervalCron": "* * * * *"        // 每 1 分钟
"refreshIntervalCron": "*/15 * * * * *"   // 每 15 秒
"refreshIntervalCron": "*/30 * * * * *"   // 每 30 秒
```

### ⚠️ 请求速率限制

滴答清单 OpenAPI **限制请求频率为 60 次/分钟**。每次静态刷新产生的 API 请求数为：

> **白名单项目数 + 1**

其中 `+1` 对应 `GET /project`（获取项目列表），其余请求为每个白名单项目的 `GET /project/{id}/data`。

以默认 15 秒轮询为例，每分钟刷新 4 次，每轮请求数 ≤ `60 ÷ 4 = 15`。扣除 `GET /project` 后，**白名单项目 ≤ 14 个即为安全**。

| 轮询间隔                  | 每分钟次数 | 安全白名单项目数 |
| ------------------------- | ---------- | ---------------- |
| `*/15 * * * * *`（15 秒） | 4          | ≤ 14             |
| `*/10 * * * * *`（10 秒） | 6          | ≤ 9              |
| `* * * * *`（60 秒）      | 1          | ≤ 59             |

> 免费账号的项目总数上限为 **9 个**。因此在默认 15 秒轮询下永远不会超出限制，无需额外调整。如果调快了轮询间隔，请注意控制白名单项目数。

### 写后刷新

任何写操作（create / update / complete / delete 等）成功后，插件会**立即刷新**受影响的项目的快照，无需等待定时轮询。

---

## 9. 排障

| 现象                                  | 可能原因                                                                       | 解决                                         |
| ------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------- |
| `{{VCPTicktickTasks}}` 显示"正在等待" | 首次刷新尚未完成，或 VCP 静态插件未调度                                        | 等待 15 秒后检查 `ticktick_static.md`        |
| 静态快照显示 AUTH_ERROR               | access token 过期或无效                                                        | 重新运行 `auth-cli.js` 获取新 token          |
| 项目列表为空                          | `config.env` 中项目清单未配置或格式错误                                        | 检查项目项是否用双引号包裹、逗号分隔         |
| 收集箱不出现                          | 未填写 `TICKTICK_INBOX_PROJECT_ID`                                             | 运行 `get-inbox-project-id.js --write-probe` |
| 轮询不工作                            | `refreshIntervalCron` cron 表达式格式不合法                                    | 检查 `plugin-manifest.json` 中的 cron 值     |
| API 返回 401                          | token 过期                                                                     | 重新授权                                     |
| 非白名单项目拒绝                      | 项目不在 `TICKTICK_CREATE_ONLY_PROJECTS` 或 `TICKTICK_FULL_ACCESS_PROJECTS` 中 | 将项目 ID 或名称加入白名单                   |

### 验证静态刷新

```bash
# 手动触发一次刷新，观察 stdout 输出
node TicktickManager.js --static-refresh
```

如果输出正常 Markdown 任务快照 → 刷新逻辑正常工作。如果报错 → 检查 token 和网络。
