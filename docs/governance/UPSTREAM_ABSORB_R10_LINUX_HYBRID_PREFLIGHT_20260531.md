# Upstream Absorb R10 Linux Hybrid Direct Preflight - 2026-05-31

本文件记录第 10 批 `Linux hybrid direct` 上游吸收预审结论。

本批只做预审，不修改运行逻辑。

## 1. 基线

| 项目 | 值 |
|------|----|
| 本地目标 | `origin/prod/stable` |
| 本地目标 commit | `76bd1553 Merge pull request #73 from JENN2046/upstream-absorb-r9-diff-closeout-20260531` |
| upstream 来源 | `https://github.com/lioensky/VCPToolBox` |
| upstream commit | `47d201a1 feat: 将 Linux 工具插件改为 hybridservice direct` |
| 本地分支 | `upstream-absorb-r10-linux-hybrid-preflight-20260531` |

## 2. 上游改动范围

`47d201a1` 是高风险跨模块改动，不能 raw cherry-pick。

文件范围：

| 类别 | 文件 |
|------|------|
| 执行调度 | `Plugin.js` |
| Linux shell 插件 | `Plugin/LinuxShellExecutor/LinuxShellExecutor.js`、`Plugin/LinuxShellExecutor/plugin-manifest.json`、`Plugin/LinuxShellExecutor/README.md` |
| Linux log 插件 | `Plugin/LinuxLogMonitor/LinuxLogMonitor.js`、`Plugin/LinuxLogMonitor/plugin-manifest.json`、`Plugin/LinuxLogMonitor/README.md`、`Plugin/LinuxLogMonitor/core/*` |
| 常驻服务 | `Plugin/SSHManagerService/SSHManagerService.js`、`Plugin/LinuxLogMonitorServer/LinuxLogMonitorServer.js` |
| 共享模块 | `modules/SSHManager/*`、`modules/LogMonitor/index.js` |
| 文档 | `docs/FILE_INVENTORY.md`、`docs/PLUGIN_ECOSYSTEM.md` |
| 不可吸收运行态 | `Plugin/LinuxShellExecutor/config.env`、`Plugin/LinuxLogMonitor/state/*`、`modules/SSHManager/hosts.json` 删除/迁移 |

## 3. 本地当前状态

当前 `prod/stable` 已有部分基础设施：

- `Plugin.js` 已支持 `hybridservice + direct` 加载。
- `Plugin.js` 已对 admin-required direct 插件缺少 auth code 执行拒绝。
- `Plugin.js` 已有 `SSH_MANAGER_ENV_PLUGIN_ALLOWLIST` 和 `LOG_MONITOR_ENV_PLUGIN_ALLOWLIST`。
- `LinuxShellExecutor` 当前仍是 `synchronous + stdio`，且 `requiresAdmin: true`。
- `LinuxLogMonitor` 当前仍是 `asynchronous + stdio`。
- `modules/SSHManager/hosts.json` 仍存在。
- `Plugin/LinuxShellExecutor/hosts.json` 存在。
- `Plugin/LinuxShellExecutor/config.env` 不存在。
- `Plugin/LinuxLogMonitor/state/active-monitors.json` 不存在。

重要差异：

- upstream `47d201a1` 的 `Plugin.js` 片段会在 admin-required hybrid direct 缺少 auth code 时只 warn 并继续执行。
- 本地 `prod/stable` 已经更严格：缺少 auth code 时直接拒绝执行。
- 后续实现必须保留本地拒绝语义，不能套回 upstream 的 warn-and-continue 行为。

## 4. 预审结论

第 10 批结论：可以继续做后续实现包，但必须拆分，不能一次吸收。

### 4.1 可以考虑吸收的行为

| 行为 | 价值 | 条件 |
|------|------|------|
| LinuxShellExecutor direct 常驻模块入口 | 减少每次工具调用 spawn 子进程，利于 SSH 连接池复用 | 必须保留 `requiresAdmin` 拒绝语义，且 direct 调用要有 timeout/abort 测试 |
| LinuxLogMonitor direct 常驻模块入口 | 让 `start/status/stop` 共享同一 MonitorManager 生命周期 | 必须避免自动恢复真实监控任务，测试只能使用 fake manager |
| SSHManagerService UDS proxy | 让 stdio 子进程复用主进程 SSH 连接池 | token 注入必须限白名单，socket/global 状态必须能 shutdown 清理 |
| SSH 命令队列和 abort/timeout | 降低 SSH 并发认证冲击，避免超时后脏连接复用 | 必须用 fake SSH client 测试，不连真实主机 |
| 默认 hosts 模板熔断 | 避免仓库默认 hosts 模板启用远程 SSH | 不能提交真实 `hosts.json`、密码、私钥路径或运行状态 |
| 日志降噪 | 减少普通输出泄露命令细节 | DebugMode 行为要有静态或单元测试覆盖 |

### 4.2 必须排除的内容

以下内容不得进入 stable 实现包：

- `Plugin/LinuxShellExecutor/config.env`
- `Plugin/LinuxLogMonitor/state/active-monitors.json`
- `Plugin/LinuxLogMonitor/state/failed_callbacks.jsonl`
- `Plugin/LinuxLogMonitor/state/stop-requests.json`
- 任何真实 SSH host、password、private key path、token、socket path 的配置文件
- 对 `modules/SSHManager/hosts.json` 的简单删除，除非同时提供迁移说明和测试
- 启动真实 SSH、shell、log monitor、bridge 或生产服务的测试

## 5. 主要风险

| 风险 | 严重度 | 说明 | 必要控制 |
|------|--------|------|----------|
| 执行权限扩大 | 高 | 把 shell 插件从 stdio 改为常驻 direct 后，生命周期和上下文从短进程变成长驻模块。 | `requiresAdmin` 缺失必须拒绝；审批链路和命令安全分级必须保持。 |
| timeout 语义变化 | 高 | 当前 direct 调用路径可能没有统一 timeout 包裹；上游新增 `_executeDirectToolCallWithTimeout`，但不能回退 admin deny。 | 先做 PluginManager direct timeout 小包，测试 timeout/abort，不混入 Linux 插件。 |
| 真实 SSH 配置污染 | 高 | upstream 删除共享 hosts 并引入模板熔断，同时存在示例 host/password 历史。 | 只提交 sanitized `.example` 或逻辑；不提交真实配置。 |
| UDS token 泄露或误注入 | 高 | `SSH_MANAGER_TOKEN`、`LOG_MONITOR_TOKEN` 会进入插件 env 或 global。 | 注入必须限白名单；测试非白名单不注入；日志不得打印 token。 |
| 连接池脏连接复用 | 中高 | 超时或 abort 后若未断开 SSH 连接，后续命令可能污染。 | fake client 测试超时断连和 queue 清理。 |
| MonitorManager 自动恢复任务 | 中高 | direct 常驻后可能在初始化时恢复真实监控任务。 | 初始化默认 readonly；start 才 full；测试用 fake state。 |
| Windows 兼容 | 中 | UDS 在 Windows 走 named pipe，路径和 cleanup 不同。 | 单测覆盖 path builder，不启动真实 pipe 服务。 |
| 回滚复杂 | 中 | 多模块一起改会让回滚困难。 | 拆成小 PR，每包只改一个层级。 |

## 6. 推荐拆包顺序

### R10A: PluginManager direct call guard

目标：

- 在 `Plugin.js` 中为 hybrid direct 调用补 timeout/abort 保护。
- 保留现有 admin-required 缺少 auth code 时拒绝执行的行为。
- 不修改 LinuxShellExecutor/LinuxLogMonitor manifest。

目标文件：

- `Plugin.js`
- `tests/plugin-admin-auth-deny.test.js`
- 新增或扩展 direct timeout 测试

验证：

- fake hybrid service 超时会 reject。
- fake admin-required hybrid service 缺 auth code 不会调用 `processToolCall`。
- fake service 收到 `decryptedAuthCode` 和 `signal`。

### R10B: SSHManager config safety and proxy preconditions

目标：

- 只吸收默认 hosts 模板熔断、local-only fallback、proxy token 参数化等安全前置逻辑。
- 不启用 LinuxShellExecutor direct。
- 不删除或提交真实 `hosts.json`，除非先给迁移策略。

目标文件：

- `modules/SSHManager/index.js`
- `modules/SSHManager/proxy.js`
- `tests/*ssh-manager*.test.js`

验证：

- 默认模板只启用 local。
- 缺配置时只启用 local。
- proxy token 不出现在日志和错误文本。

### R10C: LinuxShellExecutor hybrid direct

目标：

- 将 LinuxShellExecutor 改为可 direct 加载，但默认仍必须经过 admin-required 上下文。
- 保留 stdio fallback 或至少保留 CLI 入口。
- 只用 fake SSHManager 验证，不执行真实 shell/SSH。

目标文件：

- `Plugin/LinuxShellExecutor/LinuxShellExecutor.js`
- `Plugin/LinuxShellExecutor/plugin-manifest.json`
- `tests/linux-shell-executor-direct.test.js`

验证：

- `initialize()` 不执行命令。
- `processToolCall()` 缺 auth code 时不会绕过 PluginManager。
- fake command options 正确传递 `signal`、`usePool`、`bypassWhitelist`。
- 不创建 `config.env`、`state/*`、真实 host 文件。

### R10D: LinuxLogMonitor hybrid direct

目标：

- 将 LinuxLogMonitor 改为 direct 常驻，但默认 readonly 初始化。
- `start` 才进入 full mode。
- 不恢复真实监控任务，不写真实 state。

目标文件：

- `Plugin/LinuxLogMonitor/LinuxLogMonitor.js`
- `Plugin/LinuxLogMonitor/plugin-manifest.json`
- `Plugin/LinuxLogMonitor/core/*`
- `tests/linux-log-monitor-direct.test.js`

验证：

- `initialize()` 只 readonly。
- `status/list_rules/searchLog/lastErrors/logStats` 不启动持久监控。
- `start` 使用 fake manager 进入 full mode。
- `shutdown()` 调用 fake `stopAll()`。

### R10E: Service UDS integration

目标：

- 单独接入 `SSHManagerService` 和 `LinuxLogMonitorServer` 的 socket/global/token 生命周期。
- 不在测试中启动真实 SSH 或日志任务。

目标文件：

- `Plugin/SSHManagerService/SSHManagerService.js`
- `Plugin/LinuxLogMonitorServer/LinuxLogMonitorServer.js`
- `Plugin.js` allowlist 测试

验证：

- 初始化设置 global sock/token。
- shutdown 清理 global sock/token。
- 非白名单插件不注入 env。
- token 不打印。

## 7. 停止条件

后续任一实现包遇到以下情况应停止：

- 需要提交真实 `config.env`、`hosts.json`、`state/*`、token、password 或 private key path。
- 需要运行真实 SSH、shell、bridge、log monitor、生产服务或外部写入。
- 需要弱化 `requiresAdmin` 缺失时的拒绝语义。
- 需要把 LinuxShellExecutor 改为低风险自动允许。
- 需要一次性改 `Plugin.js`、LinuxShell、LogMonitor、SSHManager、两个 service 和 manifest。

## 8. R10 结论

`47d201a1` 有吸收价值，但不是一个可直接合入 stable 的补丁。

下一步应先做 `R10A PluginManager direct call guard`，因为它是后续 direct 化的安全前置层。只有在 direct timeout、abort、admin deny 和上下文传递被测试锁住后，才适合继续拆 `LinuxShellExecutor` 和 `LinuxLogMonitor`。
