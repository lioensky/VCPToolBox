
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

# 进阶：把 opencode 的模型请求路由到 VCP 主链路（留空使用 opencode 内置模型）
OPENCODE_BASE_URL=
OPENCODE_API_KEY=
OPENCODE_MODEL=opencode/north-mini-code-free

# 单次任务最大字符数（默认 20000）
MAX_TASK_CHARS=20000

# 默认超时（秒，默认 600）
DEFAULT_TIMEOUT_SEC=600

# write 模式自动批准所有工具调用（默认 false，建议开启才能正常执行写操作）
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
