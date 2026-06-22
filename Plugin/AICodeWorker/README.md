
# AICodeWorker - AI 代码工程 Worker

让 VCP Agent 可以安全调度服务器本地的 [opencode](https://opencode.ai)，作为下游代码分析、patch 生成、文件修改 Worker。支持三种模式，采用"同步外壳 + 异步 runner"架构，主插件立即返回 jobId，实际工作在后台 runner.js 中执行。

## 功能

- **analyze 模式**：只读分析代码结构、逻辑、bug，不修改任何文件
- **patch 模式**：以 unified diff 格式输出修改建议，人工审查后由 ServerFileOperator 落盘
- **write 模式**：opencode 直接修改/新增文件，完成后输出变更摘要（可含删除操作）
- **任务管理**：查询、列出历史任务、取消进行中任务

## 前置条件

服务器上需安装 [opencode CLI](https://opencode.ai)，安装后确认 `opencode --version` 可用。
未安装时 `capabilities` 命令会返回 `available: false`，此时不可调用 run。

## 配置

`config.env`：

```env
# opencode 可执行文件路径（在 PATH 中则填 opencode）
OPENCODE_BIN=opencode

# 允许操作的项目根目录白名单（逗号分隔），projectPath 必须在其中
ALLOWED_PROJECT_ROOTS=/app/VCPToolBox_new,/app/myproject

# 模型：BASE_URL/API_KEY 都留空 = 用 opencode 自带【免费】模型（不烧你的 token）。
# 但 OPENCODE_MODEL 别留空（留空会回退到付费默认模型），填一个 opencode/ 开头的免费模型：
#   opencode/deepseek-v4-flash-free（推荐，代码强）/ opencode/north-mini-code-free（轻量）
#   / opencode/mimo-v2.5-free / opencode/big-pickle
# 用 `opencode models | grep opencode/` 看最新清单。
# 若要改用自有模型：把 BASE_URL 和 API_KEY 都填上即切换（会消耗你的 token，且别用推理模型）。
OPENCODE_BASE_URL=
OPENCODE_API_KEY=
OPENCODE_MODEL=opencode/deepseek-v4-flash-free

# 单次任务最大字符数（默认 20000）
MAX_TASK_CHARS=20000

# 默认超时（秒，默认 600）
DEFAULT_TIMEOUT_SEC=600

# ALLOW_DANGEROUS_SKIP_PERMISSIONS：仅影响 analyze/patch 是否也跳过权限确认。
# write 模式无论此项如何都自动跳过权限（代码恒加 --dangerously-skip-permissions），
# edit/create/delete/shell 均可正常执行（实测确认）。安全边界=mode=write + ALLOWED_PROJECT_ROOTS白名单 + 任务写明约束词。
ALLOW_DANGEROUS_SKIP_PERMISSIONS=false

# 脱敏输出中的密钥/Token（默认 true）
REDACT_SECRETS=true
```

## 工作流

### 1. 提交任务（run）

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AICodeWorker「末」,
command:「始」run「末」,
worker:「始」opencode「末」,
projectPath:「始」/app/VCPToolBox_new「末」,
task:「始」请分析 Plugin/AICodeWorker/AICodeWorker.js 的整体结构，说明主要函数的作用，不要修改任何文件。「末」,
mode:「始」analyze「末」
<<<[END_TOOL_REQUEST]>>>
```
### 2. 查询结果（query）

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AICodeWorker「末」,
command:「始」query「末」,
jobId:「始」job_20260620_001910_172286「末」
<<<[END_TOOL_REQUEST]>>>
```

state 含义：`running` 进行中 / `completed` 成功 / `failed` 失败 / `timeout` 超时

## 命令速查

| 命令 | 说明 | 关键参数 |
|------|------|---------|
| `capabilities` | 查询 opencode 可用状态 | 无 |
| `run` | 提交任务，立即返回 jobId | `worker` `projectPath` `task` `mode` `timeoutSec` |
| `query` | 查询任务结果 | `jobId` |
| `listJobs` | 列出历史任务 | `limit`（默认10） |
| `cancel` | 取消进行中任务 | `jobId` |

## 模式选择指南

| 场景 | 推荐模式 |
|------|---------|
| 理解代码结构/排查 bug | `analyze` |
| 需要人工审查再决定是否修改 | `patch` |
| 已明确需求，直接让 AI 实现 | `write` |

## 安全机制

- `projectPath` 必须在 `ALLOWED_PROJECT_ROOTS` 白名单内，否则拒绝执行
- `task` 内容长度上限由 `MAX_TASK_CHARS` 控制
- `REDACT_SECRETS=true` 时自动脱敏输出中的 API Key / Token

## 依赖

- Node.js >= 16
- opencode CLI（需单独安装）
- 无 npm 额外依赖


## 多 Worker：opencode（免费）/ antigravity（agy，复杂任务）

用 `worker` 参数选择由谁执行：

| worker | 底层模型 | 成本 | 适用 |
|--------|---------|------|------|
| `opencode`（默认） | 自带免费 zen 模型 | 免费、基本无限 | 常规/批量/简单代码活 |
| `antigravity`（即 agy） | Gemini 3.x / Claude 4.6 等 | 吃 Gemini Pro 配额(约1500/天,60/分钟) | 复杂、需严谨设计、点名 agy 的任务 |

- 需 `config.env` 设 `ENABLE_ANTIGRAVITY=true` 才有 antigravity；未开启则只用 opencode（行为同以前）。
- agy 依赖 `AGY_BIN`（建议绝对路径）和 `AGY_PROXY`（连 Google 的代理，墙内必填）。详见 config.env.example。

### agy 可用模型（填 AGY_MODEL 或调用时传 model；用 label 全名含括号）
- `Gemini 3.5 Flash (High)`（默认,快）/ `(Medium)` / `(Low)`
- `Gemini 3.1 Pro (High)`（最强,啃硬骨头）/ `(Low)`
- `Claude Opus 4.6 (Thinking)` / `Claude Sonnet 4.6 (Thinking)` / `GPT-OSS 120B (Medium)`
- 查最新清单：`agy models`

### 抄作业①：点名用 agy（低算力模型直接照填）
<<<[TOOL_REQUEST]>>>
tool_name:「始」AICodeWorker「末」,
command:「始」run_and_wait「末」,
worker:「始」antigravity「末」,
projectPath:「始」/app/VCPToolBox_new「末」,
task:「始」分析 server.js 的请求处理流程，指出潜在并发问题，不修改任何文件。「末」,
mode:「始」analyze「末」
<<<[END_TOOL_REQUEST]>>>
（要用最强模型做最难的活，再加一行）  model:「始」Gemini 3.1 Pro (High)「末」

### 抄作业②：多协作（opencode 干粗活 + agy 啃硬骨头，并行）
第1步 简单部分派 opencode（用 run 异步，记下返回 jobId）：
<<<[TOOL_REQUEST]>>>
tool_name:「始」AICodeWorker「末」,
command:「始」run「末」,
worker:「始」opencode「末」,
projectPath:「始」/app/VCPToolBox_new「末」,
task:「始」统计 modules 目录有哪些文件、各自行数。「末」,
mode:「始」analyze「末」
<<<[END_TOOL_REQUEST]>>>
第2步 复杂部分派 agy（用 run 异步，记下 jobId）：
<<<[TOOL_REQUEST]>>>
tool_name:「始」AICodeWorker「末」,
command:「始」run「末」,
worker:「始」antigravity「末」,
projectPath:「始」/app/VCPToolBox_new「末」,
task:「始」分析 modules/vcpLoop 的工具调用解析逻辑，评估健壮性与边界处理。「末」,
mode:「始」analyze「末」
<<<[END_TOOL_REQUEST]>>>
第3步 分别用 query 查这两个 jobId 的结果，收齐后综合成一份报告回复。
⚠️ 铁律：并行的两个任务书必须操作【不相交的文件】，否则写冲突；有先后依赖的任务串行做。
