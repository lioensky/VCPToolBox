# LinuxLogMonitorServer（已废弃 / DEPRECATED）

> 自 LinuxShellExecutor v2.x 起，日志监控职责已由执行器的任务哨兵机制接管，本服务不再被任何活跃插件使用。

## 当前状态

- `plugin-manifest.json.block`：插件管理器不会加载本服务。
- 常驻 UDS 日志监控入口已停用；`global.__vcp_log_monitor_sock` 不会被设置。
- 仅保留源码与历史数据用于审计，可安全删除。

## 为什么废弃

本服务原本作为 `LinuxLogMonitor` 的常驻后端：

- 通过 UDS 持有 watcher、内存缓冲和规则检测器；
- `LinuxLogMonitor` 通过 `modules/LogMonitor/proxy.js` 调用。

v2.x 后：

- `LinuxShellExecutor` 使用 `core/TaskStore.js` 的 POSIX 哨兵（`/tmp/vcp_{taskId}.log/.json/.pid`）直接查询长任务；
- `LinuxLogMonitor` 已 `.block` 并标记废弃；
- 因此本服务失去唯一调用方。

## 历史

- 2026-05-17 `90bfc649`：随 `feature/connection-pool-persistence` 引入 SSH 连接池与日志监控服务。
- 2026-05-20 `6a74a54e`：PR #322 合入主线。
- 2026-05-31 `95db5644`：PR #337 后续更新。
- 2026-06-26 `e7306fd5`：批量禁用/移除插件时转为 `.block`。

## 替代方案

- 长任务查询：`LinuxShellExecutor` 的 `queryTask` / `listTasks` / `cancelTask`。
- 日志查看：直接执行 `tail` / `journalctl`，或读取任务日志哨兵。
- 如未来需要独立日志监控服务，应重新设计消费者与生命周期，不要直接取消 `.block`。

## 相关目录

- `Plugin/LinuxLogMonitor/`：同样已废弃，见其 `DEPRECATED.md`。
- `modules/LogMonitor/`：旧版 UDS 客户端，当前无活跃调用方。
- `Plugin.js` 中的 `LOG_MONITOR_SOCK` 注入逻辑可随后续清理移除。
