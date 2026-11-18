# LinuxLogMonitor（已废弃 / DEPRECATED）

> 自 LinuxShellExecutor v2.0 起，本插件已被**任务哨兵机制**取代，不再被任何代码引用。

## 为什么废弃

旧架构中，`LinuxShellExecutor` 通过 `MonitorManager`（本插件）接管 `tail -f` 与长待机任务：

- 依赖插件间的逻辑注入，启动链路脆弱；
- 监控状态落在本插件自己的 `state/*.json`，与执行器生命周期不一致；
- 日志回传依赖回调和第三方轮询，无法覆盖 SSH 断线、进程脱钩等场景。

v2.0 改为由目标机原生 POSIX 闭包直接落盘：

| 文件 | 作用 |
| :--- | :--- |
| `/tmp/vcp_{taskId}.log` | 持续输出，可直接 tail / 增量读取 |
| `/tmp/vcp_{taskId}.json` | 原子回执（`.tmp` + `mv`），包含 exit / ts |
| `/tmp/vcp_{taskId}.pid` | 后台任务 PID，用于 cancelTask |

执行器通过 `core/TaskStore.js` 注册任务，使用 `action: 'queryTask' / 'listTasks' / 'cancelTask'` 查询与取消，**不再需要本插件**。

## 现状

- `plugin-manifest.json.block` 保持禁用状态；
- `LinuxShellExecutor.js` 内已删除全部 `MonitorManager` 引用；
- 目录保留仅用于历史审计与数据回溯，可安全删除。

如需恢复旧行为，请从 Git 历史中检出 v1.2.x 版本，并自行承担插件间的耦合风险。
