
# AICodeWorker - AI 代码工程 Worker

让 VCP Agent 可以安全调度服务器本地的 [opencode](https://opencode.ai)（及可选的 antigravity/agy），作为下游代码分析、patch 生成、文件修改 Worker。核心理念：**把耗 Token 的代码读写任务交给免费的本地工具执行，VCP 模型只管下命令和看结果**。

## 最快上手：`run_and_wait` + 7 个预设（低算力模型直接抄）

日常 80% 的需求不用自己写任务书，填两三个参数即可：

```text
command: run_and_wait
preset: [预设名]
targetPath: [文件或目录的绝对路径]
```

| preset | 说明 | 必填参数 | 可选参数 |
|--------|------|---------|---------|
| `index` | 列出文件所有函数索引（行号·名称·功能） | targetPath | — |
| `read` | 读取文件完整内容并原文输出 | targetPath | — |
| `scan` | 扫描目录树 + 每个文件用途说明 | targetPath | depth |
| `bug` | 分析某个错误的根本原因 | targetPath, error | detail |
| `set` | 修改文件中某个配置项/变量的值 | targetPath, key, value | — |
| `append` | 在文件末尾追加内容 | targetPath, content | position |
| `create` | 创建或覆写一个文件 | targetPath, what | — |

示例（看文件函数索引）：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AICodeWorker「末」,
command:「始」run_and_wait「末」,
preset:「始」index「末」,
targetPath:「始」/app/VCPToolBox_new/Plugin/AICodeWorker/AICodeWorker.js「末」
<<<[END_TOOL_REQUEST]>>>
```

用户说的话怎么对应 preset？

| 用户说的话 | 选这个 preset |
|-----------|-------------|
| "看看这个文件/函数" | index |
| "读一下/给我看内容" | read |
| "扫一下目录" | scan |
| "查一下这个报错" | bug（+ error 参数） |
| "把XXX改成YYY" | set（+ key/value） |
| "在文件末尾加一行" | append（+ content） |
| "创建一个文件" | create（+ what） |

预设满足不了的复杂任务，自己写 `task` 参数（见下方「进阶」一节），`run_and_wait` 仍然同步等结果返回，不用走 query 轮询。**完整调用说明以 `plugin-manifest.json` 的 `invocationCommands.description` 为准**（任何算力的 agent 读插件本身就懂，这是单一真相源；本 README 是给人看的补充材料，可能滞后于 manifest）。

## 功能

- **analyze 模式**：只读分析代码结构、逻辑、bug，不修改任何文件
- **patch 模式**：以 unified diff 格式输出修改建议，人工审查后由 ServerFileOperator 落盘
- **write 模式**：opencode 直接修改/新增文件，完成后输出变更摘要（可含删除操作）
- **同步/异步两种调用方式**：`run_and_wait` 直接等结果返回（日常首选）；`run` 立即返回 jobId 不等待，配合 `query`/`listJobs`/`cancel` 用于特别耗时的任务
- **多 Worker**：默认 opencode（免费），复杂任务可点名 antigravity/agy（消耗 Gemini Pro 配额）

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

# 项目背景说明，自动注入每条任务书前面，省去 VCP AI 每次重复介绍项目背景（多项目共用本插件时建议留空）
PROJECT_CONTEXT=

# 大文件预检阈值(KB)，任务涉及文件超过此大小会在 warnings 里提醒缩小范围/分段处理（默认 200）
FILE_SIZE_WARN_KB=200

# ⚠️ 全局并发上限(opencode和antigravity共用同一计数)，默认1。超限的run/run_and_wait直接被拒绝
# (零资源开销，不spawn任何进程)。2026-06-27崩服务器事故后加的硬保险，不建议调大。
MAX_CONCURRENT_JOBS=1

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

# ⚠️ 2026-06-27起此开关已失效（保留仅兼容旧配置，填什么不影响行为）。
# 曾经只write模式自动跳过权限确认，analyze/patch不跳过——结果analyze模式一旦
# 触发opencode工具调用确认，因AICodeWorker是无人值守进程(stdin=ignore)，没人能点确认，
# 直接卡死到超时(2026-06-27实测：不加--dangerously-skip-permissions时日志0字节+timeout)。
# 现已改为三种模式恒自动批准——这是修复死锁bug，不是放宽安全。安全边界=mode=write门槛 + ALLOWED_PROJECT_ROOTS白名单 + 任务写明约束词。
ALLOW_DANGEROUS_SKIP_PERMISSIONS=false

# 脱敏输出中的密钥/Token（默认 true）
REDACT_SECRETS=true
```

## 进阶：异步工作流（run + query，不等结果立即返回）

日常任务直接用 `run_and_wait`（见顶部「最快上手」）就够了。以下 `run`/`query` 异步模式只在任务**特别耗时**、需要"先提交、过会再来看结果"时才用。

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

⚠️ **两条铁律**：
1. 并行的两个任务书必须操作【不相交的文件】，否则写冲突；有先后依赖的任务串行做。
2. **内存铁律**：每个 opencode/agy 实例启动后占用约 1.5~2G 内存，本服务器内存上限 6G。**严禁同时并发派出多个 AICodeWorker 任务**（哪怕一个 opencode 一个 agy 也不行），否则会撑爆内存导致服务器卡死——这不是假设，2026-06-26 真实发生过一次（两个 opencode 并发分析任务，内存被打到99%）。正确做法永远是：**串行调用**——等上一个 `run_and_wait`/`query` 返回结果后，再发下一个。上面这个"并行多协作"示例仅作历史参考，**当前不推荐这样用**，请改成串行执行。
   ⚠️ 2026-06-27此规则已升级为**代码强制**：超过 `MAX_CONCURRENT_JOBS`(默认1)时提交会被直接拒绝报错（不会排队、不会卡死，opencode和antigravity共用同一计数）。这是双重保险——子进程清理已修复（不会再堆积僵尸进程拖垮服务器），但并发任务瞬时资源冲击的风险仍存在，所以保留这道硬闸门。
