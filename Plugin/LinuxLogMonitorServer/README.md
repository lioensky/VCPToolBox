# LinuxLogMonitorServer v1.0.0

Linux 日志监控常驻服务，负责在 Direct 服务进程中统一管理远端日志 watcher、内存缓冲、异常检测和 UDS JSON-RPC 通知。

## 职责

- 通过 `modules/LogMonitor/proxy.js` 接收 `LinuxLogMonitor` 插件子进程的 UDS RPC 请求。
- 使用共享 `SSHManager` 启动远端 `tail -f` 流式会话，并保持 watcher 生命周期在服务端。
- 为 `searchLog`、`lastErrors`、`logStats`、`getStatus` 等查询提供常驻内存状态。
- 将异常、错误、停止等 watcher 事件广播给已订阅的客户端 socket。

## 本次提交维护记录

- ✅ **订阅链路补齐** - `LinuxLogMonitor` 在 `startMonitor` 成功后必须发送 `subscribe` RPC，服务端只向订阅集合包含对应 `taskId` 的客户端广播通知。
- ✅ **启动期通知不丢失** - `startMonitor` 会在启动 watcher 前把 owner socket 加入订阅集合；客户端也会在本地预注册回调，避免预读日志或首批异常通知丢失。
- ✅ **停止通知补齐** - `LogWatcherEngine.stopWatcher()` 停止 watcher 后会广播 `watcher.stopped`，让启动插件的进程同步更新本地任务状态。
- ✅ **错误通知协议对齐** - 服务端 watcher 错误使用 `watcher.error` 方法名，和 UDS 客户端 `LogMonitorProxy` 的通知分发逻辑一致。
- ✅ **启动失败清理** - 客户端订阅失败时会取消本地回调、尝试取消服务端订阅，并仅在服务端确认当前 socket 拥有 watcher 时停止任务，避免误停既有监控。
- ✅ **断连回收** - Server 记录 socket 拥有/订阅的 `taskId`，客户端异常退出或 UDS 断开后会停止无其他活跃客户端持有的 watcher。
- ✅ **查询契约对齐** - `searchLog`、`lastErrors`、`logStats` 在 UDS 模式下仍由客户端适配为 legacy 的 `success/hostId/logPath/stats/errors/executionTime` 等返回字段。
- ✅ **完整异常 payload** - `anomaly.detected` 会透传 `data.anomaly`，保留 `type`、`description`、`matchedText`、`extractedValue` 等诊断字段。
- ✅ **Server 侧去重** - `dedupeMode`、`dedupeWindow`、`maxHashes` 会传入 `LogWatcher`，Server 模式和 legacy 模式使用一致的日志行去重策略。
- ✅ **查询 fallback 对齐** - `searchLog`、`lastErrors`、`logStats` 在内存缓冲未覆盖请求范围或无命中时回退远端查询；`logStats` 远端 fallback 只返回聚合计数，远端失败但内存有命中时返回 `partial/fallbackError`。
- ✅ **UDS 安全加固** - `LOG_MONITOR_SOCK` 只注入 `LinuxLogMonitor` 白名单插件，并随请求携带 `LOG_MONITOR_TOKEN` 做服务端鉴权。
- ✅ **启动上下文预读** - 客户端未显式配置 `prefetchLines` 时使用 `contextLines` 预读，`0` 仍保持 `tail -n 0 -f`。
- ✅ **after-context 超时刷新** - 异常命中后最多等待 `afterContextTimeoutMs`（默认 5 秒）收集后文日志，日志停顿时仍会及时发送关键告警。
- ✅ **主进程退出调度** - 服务只保留 `exit` 同步清理，SIGINT/SIGTERM 由 `server.js` 的 `gracefulShutdown` 统一调用插件 `shutdown()`。

## UDS RPC

常用方法：

- `startMonitor`: 创建服务端 watcher，返回服务端 `taskId`。
- `subscribe`: 将当前 socket 加入指定 `taskId` 的通知订阅集合。
- `unsubscribe`: 从订阅集合移除当前 socket。
- `stopMonitor`: 停止 watcher，并触发 `watcher.stopped` 通知。
- `searchLog` / `lastErrors` / `logStats`: 优先查询服务端内存缓冲，缺失时回退远端命令查询；`logStats` 在远端完成聚合，避免拉取整份日志。
- `getStatus` / `getBufferStats`: 查询服务端 watcher 与缓冲区状态。

所有 RPC 请求必须携带由主进程注入的 `LOG_MONITOR_TOKEN`。未在白名单中的 stdio 插件不会获得 `LOG_MONITOR_SOCK` 或 token。

## 通知方法

- `anomaly.detected`: 检测到异常日志行。
- `watcher.error`: watcher 或流式会话发生错误。
- `watcher.stopped`: watcher 已停止，包含 `reason` 与统计信息。
- `log.rotation` / `log.truncation`: 日志轮转或截断事件。

## 依赖

- 共享模块：`modules/SSHManager`
- 服务入口：`Plugin/LinuxLogMonitorServer/LinuxLogMonitorServer.js`
- 核心 watcher：`Plugin/LinuxLogMonitorServer/core/LogWatcher.js`
- watcher 管理：`Plugin/LinuxLogMonitorServer/core/LogWatcherEngine.js`
