# LinuxShellExecutor v2.1.0

给 VCP Agent 提供本地 / 多机 Linux 命令执行、长任务后台脱钩与虚拟终端交互的 `hybridservice` 插件。

- **多机并发**：`hostId` 使用逗号分隔字符串（如 `"local,nas,server"`），支持标签；单机故障不影响其余主机。
- **统一回显**：命令执行、任务与终端结果统一收敛为 `<host> [status, meta]:` + 代码块，不再返回嵌套 JSON。
- **超时脱钩**：命令超过同步等待阈值后自动转后台，不杀进程、不断 SSH 连接。
- **虚拟终端**：按 `hostId::terminalId` 隔离 Channel，支持 Ctrl+C、stdin 注入与画面查看。
- **安全管控**：黑名单 / 白名单 / 灰名单 / 特殊操作符 / AST / 审计统一接入执行入口。

## 快速开始

### 1. 安装依赖

在项目根目录执行：

```bash
npm install ssh2 dotenv
```

本地交互终端优先使用 util-linux 的 `script` 创建 PTY；缺失时回退到 `bash -i` + 信号模拟。

### 2. 配置主机

编辑 `Plugin/LinuxShellExecutor/hosts.json`：

```json
{
  "hosts": {
    "local": {
      "name": "本地执行",
      "type": "local",
      "enabled": true
    },
    "dev": {
      "name": "开发机",
      "type": "ssh",
      "enabled": true,
      "host": "192.168.1.100",
      "port": 22,
      "username": "dev",
      "authMethod": "key",
      "privateKeyPath": "~/.ssh/id_rsa",
      "tags": ["dev", "linux"]
    }
  },
  "defaultHost": "local"
}
```

> `hosts.json` 仍是仓库默认模板时（MD5 匹配），插件只启用 `local`，不会连接任何远程主机。写入真实主机并重启插件/服务后生效。

私钥路径支持绝对路径、`~` 展开，或相对于 `Plugin/LinuxShellExecutor/` 的相对路径。

### 3. 调用

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」LinuxShellExecutor「末」,
command:「始」uname -srm「末」,
hostId:「始」local「末」
<<<[END_TOOL_REQUEST]>>>
```

## 工具参数

| 参数 | 类型 | 说明 |
| :--- | :--- | :--- |
| `command` | string | 要执行的命令，或 `preset:预设名?参数`。执行类 Action 必需 |
| `hostId` | string | 逗号分隔的主机 ID，如 `"local,nas,server"`；也支持 `@tag` / `tag:xxx`；默认 `defaultHost` |
| `terminalId` | string | 虚拟终端 ID。显式指定时命令在持久终端中前台运行 |
| `timeout` | number | 同步等待阈值（ms），默认 `30000`，最大 `55000` |
| `isLongRunning` | boolean | `true` 时立即转后台脱钩，不进行同步等待 |
| `interactive` | boolean | 显式 `terminalId` 时是否启用交互终端，默认 `true` |
| `forceNewChannel` | boolean | 强制派生新的子终端 Channel |
| `securityLevel` | string | `basic` / `standard` / `high` / `maximum`；默认取主机配置或 `DEFAULT_SECURITY_LEVEL` |
| `requireAdmin` | string | 管理员验证码（6位），用于灰名单与未知命令授权 |
| `doubleConfirm` | boolean | critical 灰名单 / 高危预设的二次确认标志 |
| `outputFormat` | string | 兼容旧参数；v2.0 统一输出 Markdown |
| `taskId` | string | `queryTask` / `cancelTask` / `queryVisible` 使用 |
| `lines` | number | `queryTask` 默认 50 行，`queryVisible` 默认 20 行 |
| `key` | string | `sendKey` 的按键名，如 `ctrl+c` |
| `repeat` | number | `sendKey` 重复次数，默认 1，最大 50 |
| `text` | string | `pasteText` 要写入 stdin 的文本 |
| `submit` | boolean | `pasteText` 是否追加回车，默认 `true` |
| `status` | string | `listTasks` 状态过滤，可逗号分隔 |
| `limit` | number | `listTasks` 返回数量，默认 20 |
| `startDelayMs` | number | `runInTerminal` 启动后返回的等待时间，默认 500 |

## Actions

| Action | 关键参数 | 说明 |
| :--- | :--- | :--- |
| 默认 / `execute` | `command`, `hostId` | 执行命令；显式 `terminalId` 时进入交互终端 |
| `runInTerminal` | `command`, `terminalId` | 在虚拟终端启动命令，通常返回 `running` |
| `queryTask` | `taskId`, `lines` | 查询脱钩任务状态与尾部日志 |
| `listTasks` | `hostId`, `status`, `limit` | 列出登记任务 |
| `cancelTask` | `taskId` | 终止进程树并清理哨兵文件 |
| `sendKey` / `sendInteractiveKey` | `terminalId`, `key`, `repeat` | 注入控制键 |
| `pasteText` / `pasteInteractiveText` | `terminalId`, `text`, `submit` | 向 stdin 写入文本 |
| `queryVisible` | `terminalId` 或 `taskId`, `lines` | 查看终端画面 / 任务日志尾部 |
| `listTerminals` | — | 列出活跃虚拟终端 |
| `listHosts` | — | 列出主机 |
| `testConnection` | `hostId` | 测试主机连接 |
| `getStatus` | — | 连接状态 |
| `listPresets` | — | 预设命令列表 |

`sendKey` 支持：`ctrl+c`、`ctrl+d`、`ctrl+z`、`ctrl+l`、`ctrl+u`、`enter`、`esc`、`tab`、`up`、`down`、`left`、`right`、`home`、`end`、`pageup`、`pagedown`、`backspace`、`space`。

## 使用示例

### 本地执行

```javascript
{
  command: "df -h && free -h",
  hostId: "local"
}
```

### 多机并发

```javascript
{
  command: "uname -srm",
  hostId: "local,nas,server"    // 只支持逗号分隔字符串；数组形式已移除
}
```

单台主机不可达时只返回该主机的 `[error]` 块，其余主机正常输出。

### 标签批量执行

```javascript
{
  command: "uptime",
  hostId: "@linux"              // 或 "tag:linux"
}
```

### 长任务脱钩与查询

```javascript
// 1. 超过 3 秒仍未结束 -> 返回 detached + taskId
{
  command: "for i in $(seq 1 8); do echo tick_$i; sleep 1; done",
  hostId: "local",
  timeout: 3000
}

// 2. 查询进度
{ action: "queryTask", taskId: "task_local_...", lines: 20 }

// 3. 主动取消
{ action: "cancelTask", taskId: "task_local_..." }
```

### 交互终端：Ctrl+C 中断

```javascript
// 1. 在指定终端启动阻塞命令
{
  action: "runInTerminal",
  command: "ping 127.0.0.1",
  hostId: "local",
  terminalId: "debug-term"
}

// 2. 查看当前画面
{ action: "queryVisible", hostId: "local", terminalId: "debug-term", lines: 20 }

// 3. 注入 Ctrl+C
{ action: "sendKey", hostId: "local", terminalId: "debug-term", key: "ctrl+c" }

// 4. 再次查看，确认进程已退出
{ action: "queryVisible", hostId: "local", terminalId: "debug-term", lines: 20 }
```

### 交互终端：写入 stdin

```javascript
// 命令等待输入
{
  action: "runInTerminal",
  command: "read -p \"Confirm? [y/N]: \" ans; echo \"ANSWER=$ans\"",
  hostId: "local",
  terminalId: "input-term"
}

// 写入 y 并回车
{
  action: "pasteText",
  hostId: "local",
  terminalId: "input-term",
  text: "y",
  submit: true
}
```

### 预设命令

调用格式：

```text
command:「始」preset:<预设名>「末」
command:「始」preset:checkService?serviceName=nginx&logLines=100「末」
```

当前内置 17 个预设：

| 预设 | 说明 | 参数 |
| :--- | :--- | :--- |
| `quickDiag` | 快速系统诊断 | — |
| `checkMemory` | 内存占用、Swap、Top 内存进程 | — |
| `checkCpu` | CPU 信息、平均负载、Top CPU 进程 | — |
| `checkDisk` | 磁盘详细检查 | — |
| `checkDiskUsage` | 分区 / inode / 常见目录占用速查 | — |
| `checkPerformance` | CPU / 内存 / IO 性能分析 | `interval`, `count` |
| `checkPorts` | 监听端口与 Established 连接 | — |
| `checkProcesses` | 进程总数、Top CPU/内存、僵尸进程 | — |
| `checkService` | 服务状态与最近日志 | `serviceName`, `logLines` |
| `netDiag` | 网络连接与端口诊断 | — |
| `checkDocker` | Docker 容器 / 镜像状态 | `containerName` |
| `checkLogs` | 系统与应用日志 | `logFile`, `lines`, `keyword` |
| `checkSecurity` | 登录记录与安全检查 | — |
| `checkMysql` | MySQL 状态 | `host`, `user` |
| `checkRedis` | Redis 状态 | `host`, `port` |
| `checkNginx` | Nginx 状态 | — |
| `pingTest` | 网络连通性测试 | `target`, `count` |

> 预设命令由管理员在 `presets.json` 中维护，属于可信模板：执行时跳过黑/白/灰名单、特殊操作符与 AST 文本检查，仅保留提权前置拦截、预设 `securityLevel` 验证与审计。

```javascript
{ command: "preset:quickDiag", hostId: "local" }
{ command: "preset:checkService?serviceName=nginx&logLines=100" }
{ action: "listPresets" }
```

### 灰名单与未知命令授权

```javascript
// 灰名单：需要管理员验证码；critical 风险还需 doubleConfirm
{
  command: "systemctl restart nginx",
  hostId: "local",
  requireAdmin: "123456"
}

// 不在任何名单中的命令：有效验证码可授权执行
{
  command: "custom-tool --flag",
  hostId: "local",
  requireAdmin: "123456"
}
```

## 输出格式

统一格式：

````text
<hostId> [status, meta]:
```
输出内容
```
````

常见 meta：

| 场景 | 输出 |
| :--- | :--- |
| 正常完成 | `<local> [exit: 0, 45ms]:` |
| 超时脱钩 | `<local> [detached, taskId: task_local_...]:` |
| 任务运行中 | `<local> [running, taskId: task_local_..., elapsed: 5200ms]:` |
| 交互终端运行中 | `<local> [running, terminalId: debug-term, elapsed: 800ms]:` |
| 查询已完成任务 | `<local> [completed, exit: 0, totalDuration: 8027ms]:` |
| 按键注入 | `<local> [signal: SIGINT, terminalId: debug-term, 8ms]:` |
| stdin 注入 | `<local> [stdin_injected, terminalId: debug-term, 5ms]:` |
| 终端画面 | `<local> [visible_buffer, terminalId: debug-term]:` |
| 错误 | `<local> [error, 25ms]:` |

工具返回同时包含 `content: [{ type: "text", text }]`，AI 侧直接读取 Markdown 文本。

> 管理类 Action（`listHosts` / `testConnection` / `getStatus` / `listPresets`）返回结构化对象，不使用上述主机块格式。

## 任务哨兵

脱钩任务在目标机写入三个文件：

| 文件 | 用途 |
| :--- | :--- |
| `/tmp/vcp_{taskId}.log` | 持续输出，可 tail |
| `/tmp/vcp_{taskId}.json` | 原子回执，包含 `exit` 与 `ts` |
| `/tmp/vcp_{taskId}.pid` | 后台进程 PID，`cancelTask` 使用 |

任务元数据持久化在 `Plugin/LinuxShellExecutor/state/tasks.json`，进程重启后仍可用 `queryTask` 查询。主进程每 3 秒静默巡检一次，任务完成或 30 分钟后自动停止巡检。

> 不再需要 `LinuxLogMonitor` 插件。

## 虚拟终端

- 显式传入 `terminalId` 时，命令在该终端的持久 PTY / SSH Channel 中前台运行。
- 默认终端忙碌时，未显式指定终端的请求会自动派生 `default_sub_*` 子 Channel。
- 终端会话保存在插件进程内；交互场景需保持同一 direct / proxy 服务进程。
- 完成判据使用唯一 `PS1` 哨兵，不会把完成标记误写入等待 stdin 的程序。

## hosts.json 常用字段

| 字段 | 说明 |
| :--- | :--- |
| `type` | `local` 或 `ssh` |
| `enabled` | 是否启用，默认 `true` |
| `host` / `port` / `username` | SSH 连接信息 |
| `authMethod` | `key` 或 `password` |
| `privateKeyPath` / `passphrase` | 密钥认证 |
| `password` | 密码认证 |
| `jumpHost` | 跳板机 hostId |
| `tags` | 标签数组，供 `@tag` 使用 |
| `timeout` / `keepAliveInterval` | 连接超时与保活 |

`globalSettings` 可配置 `maxConcurrentConnections`、`enableExecutionQueue`、`maxExecutionQueueLength` 等连接层参数。

## 安全管控

所有执行入口（普通命令、脱钩任务、虚拟终端、预设）在进入执行队列前统一经过以下校验：

1. **提权前置拦截**：`sudo` / `su` / `pkexec` / `doas` 直接拒绝。
2. **特殊操作符硬护栏**：禁止 `;`、后台 `&`、子 shell `$()` / 反引号；`&&` / `||` 按安全级别放行。
3. **黑名单**：`config.env` 中的 `FORBIDDEN_PATTERNS` / `FORBIDDEN_COMMANDS`。
4. **白名单**：命中白名单且参数、路径、管道合法时免费放行。
5. **灰名单**：需要 `requireAdmin` 验证码；`critical` 风险还需 `doubleConfirm: true`。
6. **未知命令**：不在任何名单中时必须提供有效管理员验证码才能执行。
7. **AST 语义分析**：命令注入、路径遍历、编码载荷、网络外泄、提权等 critical 风险直接拒绝。
8. **审计**：`maximum` 级别记录成功执行；拦截事件始终记录到 `AUDIT_LOG_DIR`。

### 审核顺序

`提权拦截 → 特殊操作符 → 黑名单 → 白名单 → 灰名单(验证码) → 未知命令(验证码) → AST → 审计`

- **黑名单先于白名单**：黑名单是绝对拒绝，白名单不能覆盖。
- **预设命令**：管理员在 `presets.json` 维护的可信模板，跳过黑/白/灰名单、特殊操作符与 AST，仅保留提权前置拦截、预设 `securityLevel` 验证与审计。

安全级别由 `hosts.json` 的 `securityLevel`、请求参数 `securityLevel` 或 `DEFAULT_SECURITY_LEVEL` 决定：

| 级别 | 启用层 |
| :--- | :--- |
| `basic` | 黑名单 |
| `standard` | 黑名单 + 白名单/灰名单 + AST |
| `high` | 黑名单 + 白名单/灰名单 + AST |
| `maximum` | 上述 + 审计 |

常用安全配置（`config.env`）：

| 变量 | 说明 |
| :--- | :--- |
| `FORBIDDEN_PATTERNS` / `FORBIDDEN_COMMANDS` | 黑名单正则 / 精确命令 |
| `DEFAULT_SECURITY_LEVEL` | 默认安全级别 |
| `AUDIT_LOG_DIR` | 审计日志目录（相对路径基于 VCP 工作目录） |
| `ALERT_WEBHOOK` / `ALERT_THRESHOLD` | 安全事件告警 |
| `TIMEOUT_MS` | 默认同步等待阈值，实际限制在 1000-55000ms |
| `MAX_OUTPUT_LINES` / `MAX_OUTPUT_SIZE` | 单次输出行数 / 字节数上限 |

> `plugin-manifest.json` 的 `requiresAdmin` 为 `true` 时，VCP 主进程会把解密后的管理员验证码注入执行上下文；`DECRYPTED_AUTH_CODE` 不需要写死在 `config.env`。
>
> `SANDBOX_BACKEND` / `RLIMIT_*` 及对应的 `SandboxManager` 已从 v2 执行路径移除；如需强隔离，请在主机或容器层部署。

> 生产环境仍建议在网关层增加调用方鉴权与命令审核。

## 回归测试

```bash
node Plugin/LinuxShellExecutor/test/run_suite.js
```

覆盖多机广播、故障隔离、超时脱钩、`queryTask` 生命周期、`cancelTask`、Ctrl+C 穿透、stdin 注入、忙碌终端自动升轨、安全授权管线、预设命令共 10 项用例。

## 目录结构

```text
Plugin/LinuxShellExecutor/
├── LinuxShellExecutor.js      # 插件入口与 Action 路由
├── core/
│   ├── TaskStore.js           # 任务注册表 + POSIX 哨兵包装
│   └── OutputFormatter.js     # 统一 Markdown 渲染
├── test/run_suite.js          # 10 项端到端回归
├── hosts.json                 # 主机配置
├── config.env                 # 黑名单/审计/默认安全级别等配置
├── presets.json               # 预设命令
└── plugin-manifest.json       # 插件清单
```

## 版本

- **v2.1.0**：`hostId` 改为逗号分隔字符串；新增 checkMemory / checkCpu / checkDiskUsage / checkPorts / checkProcesses 预设；预设模板跳过黑/白/灰名单、特殊操作符与 AST；整理 config.env、恢复 requiresAdmin 验证码注入；移除 SandboxManager/RlimitManager 等死代码。
- **v2.0.2**：恢复黑名单/白名单/灰名单/特殊操作符/AST/审计授权管线；新增 TC-09 安全回归。
- **v2.0.1**：README 精简与文档对齐；`LinuxLogMonitor` 清单保持 `.block` 禁用。
- **v2.0.0**：多机广播、超时脱钩、任务哨兵、虚拟终端、统一 Markdown 回显。

## 许可证

MIT License
