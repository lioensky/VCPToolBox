# AICodeWorker

让 VCP Agent 安全调度服务器本地的 [opencode](https://opencode.ai) 执行代码任务。

**核心理念**：VCP 付费模型负责理解需求、编写任务书、审查结果；opencode 免费模型负责实际执行——分工明确，大幅节省 Token。

## 版本

**v1.5.2** | 架构：同步外壳 + 异步 runner

## 功能

### 三种工作模式

| 模式 | 行为 | 适用场景 |
|------|------|---------|
| `analyze`（默认）| 只读分析，禁止修改任何文件 | 理解代码结构、排查 bug、读取文档 |
| `patch` | 输出 unified diff，不直接落盘 | 需要人工审查后再决定是否修改 |
| `write` | 直接修改 / 新增文件 | 需求明确、已信任 opencode 执行 |

### v1.5 核心：规范化报告输出

每次任务完成，opencode 必须在报告末尾输出两个固定锚点：

```
【读取文件清单】已读：<文件列表> | 跳过：<文件及原因>
【执行结果摘要】<60字以内结论>
```

插件自动提取这两个锚点，VCP Agent 无需重读完整输出即可做决策。

### 其他特性

- **任务书预检**（warnings）：提交前扫描模糊动词、缺绝对路径、缺操作约束等问题，带 `level: error/warn` 分级
- **项目上下文自动注入**：`PROJECT_CONTEXT` 配置一次，自动追加到每条任务书，省去重复说明
- **大文件预检**：任务书中提到的文件超过阈值时自动警告
- **探活缓存**：`opencode --version` 结果缓存 5 分钟，避免重复 spawn
- **危险操作自动补丁**：write 模式检测到删除 / 移动操作时，自动追加三步验证协议

## 前置条件

服务器需安装 [opencode CLI](https://opencode.ai)：

```bash
opencode --version   # 确认可用
```

## 安装

插件目录已包含所需文件，无需 `npm install`（仅使用 Node.js 内置模块）。

复制配置文件并按需修改：

```bash
cp config.env.example config.env
```

## 配置

`config.env` 完整说明：

```env
# ── Worker 开关 ────────────────────────────────
ENABLE_OPENCODE=true
ENABLE_MIMOCODE=false              # 预留，暂未实现

# ── opencode 可执行文件 ────────────────────────
OPENCODE_BIN=opencode              # 在 PATH 中则填 opencode

# ── 路由到自定义模型（留空使用 opencode 内置免费模型）──
OPENCODE_BASE_URL=
OPENCODE_API_KEY=
OPENCODE_MODEL=                    # 例：opencode/north-mini-code-free

# ── 安全白名单 ─────────────────────────────────
# projectPath 必须以这些路径开头，否则拒绝执行
ALLOWED_PROJECT_ROOTS=/app/VCPToolBox_new,/app/myproject

# ── 任务参数 ───────────────────────────────────
MAX_TASK_CHARS=20000               # task 最大字符数
DEFAULT_TIMEOUT_SEC=600            # 单次超时（秒）
ALLOW_DANGEROUS_SKIP_PERMISSIONS=false  # write 模式自动批准工具调用

# ── 输出处理 ───────────────────────────────────
REDACT_SECRETS=true                # 自动脱敏输出中的密钥 / Token
FILE_SIZE_WARN_KB=200              # 大文件预检阈值（KB）

# ── 项目上下文自动注入 ─────────────────────────
# 填写后自动追加到每条任务书开头，省去 VCP Agent 每次重复描述项目背景
# 支持 \n 换行
PROJECT_CONTEXT=本项目是 VCP AI 中间件系统（Node.js 18），主目录 /app/VCPToolBox_new。
```

## 使用方法

### 推荐：run_and_wait（一次调用等待完成）

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」AICodeWorker「末」,
command:「始」run_and_wait「末」,
worker:「始」opencode「末」,
projectPath:「始」/app/VCPToolBox_new「末」,
task:「始」请分析 Plugin/AICodeWorker/AICodeWorker.js 的整体结构，
列出所有函数名、行号、职责，不修改任何文件。
报告结构用 ▍01 · 标题 分节。「末」,
mode:「始」analyze「末」
<<<[END_TOOL_REQUEST]>>>
```

插件内部自动等待最长 7 分钟，完成即返回。

### 传统两步：run + query

```
# 第一步：提交
<<<[TOOL_REQUEST]>>>
tool_name:「始」AICodeWorker「末」,
command:「始」run「末」,
worker:「始」opencode「末」,
projectPath:「始」/app/VCPToolBox_new「末」,
task:「始」任务描述「末」,
mode:「始」analyze「末」
<<<[END_TOOL_REQUEST]>>>

# 第二步：查询（内部长轮询，单次最多等 7 分钟）
<<<[TOOL_REQUEST]>>>
tool_name:「始」AICodeWorker「末」,
command:「始」query「末」,
jobId:「始」job_20260621_020726_3605「末」
<<<[END_TOOL_REQUEST]>>>
```

`state=running` 时再调一次 query 即可，禁止快速连续调用。

## 命令参考

### run / run_and_wait

| 参数 | 必填 | 说明 |
|------|------|------|
| `worker` | 否 | 默认 `opencode` |
| `projectPath` | 是 | 必须在白名单内的绝对路径 |
| `task` | 是 | 任务描述，建议包含六要素（见下） |
| `mode` | 否 | `analyze`（默认）/ `patch` / `write` |
| `timeoutSec` | 否 | 超时秒数，默认 600 |
| `summaryHint` | 否 | 告诉插件从哪个关键词后提取摘要，提高精准度 |

### query

| 参数 | 必填 | 说明 |
|------|------|------|
| `jobId` | 是 | 任务 ID |

### listJobs

| 参数 | 必填 | 说明 |
|------|------|------|
| `limit` | 否 | 返回条数，默认 10，最多 50 |

### cancel / capabilities

无额外参数（cancel 需要 `jobId`）。

## 返回字段

| 字段 | 说明 | 读取建议 |
|------|------|---------|
| `warnings` | 任务书预检告警，含 `level: error/warn` | 优先读，error 级建议修任务书再跑 |
| `fileReadList` | opencode 读取的文件清单（v1.5 新增） | 判断覆盖范围是否足够 |
| `summary` | 从 `【执行结果摘要】` 锚点精准提取的结论 | 快速决策，通常无需读 output |
| `output` | opencode 完整输出（超 50KB 自动截断） | 需要细节时读取 |
| `outputFile` | 完整输出文件路径 | output 截断时用 ServerFileOperator 读取 |
| `state` | `completed` / `failed` / `running` / `timeout` / `cancelled` | — |

## 任务书六要素

好的任务书应包含：

```
What    做什么？动词要明确（分析 / 修改 / 新增 / 删除）
Where   操作哪个绝对路径？
Don't   禁止动什么？（禁止改其他文件 / 禁止装依赖）
Prove   怎么验证？（ls / cat / grep 看输出）
Report  报告格式？（附命令输出 / 输出摘要）
If Fail 失败怎么办？（回滚 / 保留原文件）
```

示例：

```
请修改 /app/VCPToolBox_new/Plugin/AICodeWorker/config.env，
将 DEFAULT_TIMEOUT_SEC 的值改为 900。
约束：只改这一行，禁止修改其他配置项，禁止修改 config.env.example。
验证：修改后 grep DEFAULT_TIMEOUT_SEC /app/VCPToolBox_new/Plugin/AICodeWorker/config.env 并在报告中附输出。
报告格式：修改前的值 → 修改后的值 + grep 输出。
```

## 安全机制

1. **路径白名单**：`projectPath` 必须在 `ALLOWED_PROJECT_ROOTS` 内
2. **任务长度限制**：超过 `MAX_TASK_CHARS` 拒绝执行
3. **密钥脱敏**：`REDACT_SECRETS=true` 时自动掩盖输出中的 API Key / Bearer Token / sk- 前缀密钥
4. **模式安全前缀**：每种模式都有强制注入的安全约束指令，opencode 必须遵守
5. **危险操作自动验证**：write 模式检测到 rm / mv / 删除时自动追加三步验证协议
6. **任务书预检**：提交前扫描常见任务书质量问题

## 架构

```
VCP Agent
    │ stdin JSON
    ▼
AICodeWorker.js（同步外壳）
    │ spawn（detached）
    ▼
runner.js（异步后台进程）
    │ spawn
    ▼
opencode CLI
    │ 输出写入
    ▼
jobs/
├── output/{jobId}.txt   opencode 完整输出
├── logs/{jobId}.log     runner 日志
├── patches/{jobId}.patch patch 模式输出
└── meta/{jobId}.json    任务状态元数据
```

## 依赖

- Node.js ≥ 16
- opencode CLI（需单独安装）
- 无 npm 额外依赖
