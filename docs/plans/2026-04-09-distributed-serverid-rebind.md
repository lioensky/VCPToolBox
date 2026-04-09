# Distributed ServerId Rebind Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复分布式节点重连后工具仍绑定旧 `serverId` 的问题，并恢复详细分布式超时诊断日志。

**Architecture:** 保留连接级临时 `serverId`，将稳定的 `serverName` 作为“同一逻辑节点”判断依据。在主服务注册分布式工具时，若同名工具来自同一 `serverName`，则用新连接覆盖旧 `serverId`。同时恢复 `DistTool` 系列诊断日志，并新增 `distributed_tool_rebound` 事件用于验证修复效果。

**Tech Stack:** Node.js, ws, Express, PM2, Docker Compose, VCPToolBox plugin runtime

---

### Task 1: 基线确认与代码定位

**Files:**
- Read: `Plugin.js`
- Read: `WebSocketServer.js`
- Read: `server.js`
- Read: `docs/plans/2026-04-09-distributed-serverid-rebind-design.md`

**Step 1: 确认当前 `serverId` 分配点**

Run: `rg -n "const serverId = \`dist-|authenticated and connected" "WebSocketServer.js"`
Expected: 能定位连接建立时 `serverId` 的生成位置。

**Step 2: 确认当前分布式工具绑定点**

Run: `rg -n "toolManifest.serverId|registerDistributedTools|unregisterAllDistributedTools" "Plugin.js"`
Expected: 能定位注册与注销逻辑。

**Step 3: 确认当前执行路径**

Run: `rg -n "plugin.serverId|executeDistributedTool|processToolCall" "Plugin.js" "WebSocketServer.js"`
Expected: 能定位工具调用仍然依赖缓存 `serverId` 的代码路径。

**Step 4: 人工记录当前约束**

写明：
- 以提交代码为准
- 本次不支持多个同名 `serverName`
- 本次不修改 Windows 侧执行链

### Task 2: 恢复分布式诊断日志

**Files:**
- Modify: `Plugin.js`
- Modify: `WebSocketServer.js`
- Modify: `server.js`

**Step 1: 在 `PluginManager.processToolCall()` 恢复工具生命周期日志**

需要恢复：
- `tool_call_started`
- `tool_call_completed`
- `tool_call_failed`

字段至少包含：
- `requestId`
- `toolName`
- `executionMode`
- `isDistributed`
- `pluginType`
- `protocol`
- `startedAt` / `finishedAt` / `failedAt`
- `durationMs`

**Step 2: 在 `WebSocketServer.executeDistributedTool()` 恢复请求级日志**

需要恢复：
- `distributed_tool_sent`
- `tool_result_received`
- `distributed_tool_timeout`

字段至少包含：
- `requestId`
- `toolName`
- `serverIdOrName`
- `effectiveTimeout`
- `pendingSize`
- `sentAt` / `receivedAt` / `timedOutAt`

**Step 3: 恢复 pending 状态日志**

需要恢复：
- `pending_request_added`
- `pending_request_removed`
- `unmatched_tool_result`

**Step 4: 在 `server.js` 恢复运行时快照开关**

恢复环境变量读取：
- `DIST_TOOL_DIAGNOSTICS_ENABLED`
- `DIST_TOOL_DIAGNOSTICS_INTERVAL_MS`

恢复输出：
- `runtime_snapshot`
- `runtime_pressure_warning`

**Step 5: 手工审查日志字段一致性**

Expected:
- 所有日志前缀保持可 grep
- JSON 字段命名一致
- 不引入重复低价值日志

### Task 3: 让主服务识别稳定的 `serverName`

**Files:**
- Modify: `WebSocketServer.js`

**Step 1: 在 `register_tools` 处理处提取稳定 `serverName`**

规则：
- 优先使用当前连接对象中已记录的 `serverInfo.serverName`
- 否则使用 `message.data.serverName`
- 最后回退到 `serverId`

**Step 2: 调整 `registerDistributedTools()` 调用签名**

把当前：
- `pluginManager.registerDistributedTools(serverId, externalTools)`

改为：
- `pluginManager.registerDistributedTools(serverId, resolvedServerName, externalTools)`

**Step 3: 确认 `report_ip` 流程仍可更新连接对象上的 `serverName`**

Expected:
- 后续注册与重连时，主服务具备稳定逻辑节点名

### Task 4: 实现同逻辑节点的重绑定

**Files:**
- Modify: `Plugin.js`

**Step 1: 调整 `registerDistributedTools()` 方法签名**

从：
- `registerDistributedTools(serverId, tools)`

改为：
- `registerDistributedTools(serverId, serverName, tools)`

**Step 2: 给分布式工具记录 `serverName`**

首次注册时写入：
- `toolManifest.isDistributed = true`
- `toolManifest.serverId = serverId`
- `toolManifest.serverName = serverName`

**Step 3: 处理同名工具重连覆盖**

规则：
- 若已有同名工具不存在，正常注册
- 若已有同名工具是本地工具，继续拒绝覆盖
- 若已有同名工具是分布式工具且 `serverName` 相同，则更新：
  - `serverId`
  - `serverName`
  - 其他必要元数据
- 若已有同名工具是分布式工具但 `serverName` 不同，则继续拒绝覆盖

**Step 4: 新增重绑定日志**

新增：
- `[DistTool] {"event":"distributed_tool_rebound", ... }`

字段至少包含：
- `toolName`
- `serverName`
- `oldServerId`
- `newServerId`
- `reboundAt`

**Step 5: 保持显示名称与已有描述构建逻辑兼容**

Expected:
- 不破坏现有插件展示名称
- 不破坏 `buildVCPDescription()` 的结果

### Task 5: 保持断线清理语义正确

**Files:**
- Modify: `Plugin.js`
- Read: `WebSocketServer.js`

**Step 1: 审查 `unregisterAllDistributedTools(serverId)`**

确认：
- 仍按旧 `serverId` 清理
- 不会误删已经重绑定到新 `serverId` 的工具

**Step 2: 必要时为重绑定后的工具增加保护**

规则：
- 若工具已经被重绑定到新 `serverId`，旧连接断开时不应再误删该工具

**Step 3: 保持静态占位符清理逻辑最小改动**

Expected:
- 不因工具重绑定而引入错误的 placeholder 清理

### Task 6: 恢复 `serverName` 配置接入

**Files:**
- Modify: `D:/VCP/VCPChat/main.js`
- Read: `D:/VCP/VCPChat/VCPDistributedServer/config.env`

**Step 1: 确认当前 `serverName` 来源为硬编码**

Run: `rg -n "serverName: 'VCP-Desktop-Client-Distributed-Server'" "D:/VCP/VCPChat/main.js"`
Expected: 能确认现状。

**Step 2: 读取 `VCPDistributedServer/config.env` 中的 `ServerName`**

实现原则：
- 若配置存在则优先使用
- 若缺失则继续回退为当前硬编码值

**Step 3: 保持行为向后兼容**

Expected:
- 老环境不配置 `ServerName` 也能继续工作
- 单节点环境默认行为不变

### Task 7: 验证与回归

**Files:**
- Test via logs: `DebugLog/ServerLog.txt`

**Step 1: 正常基线验证**

操作：
- 节点在线时调用一次 `DesktopRemote`

Expected:
- `tool_call_started`
- `distributed_tool_sent`
- `tool_result_received`
- `pending_request_removed`
- `tool_call_completed`

**Step 2: 重连覆盖验证**

操作：
- 不重启 `VCPToolBox`
- 让分布式节点断线重连
- 再调用一次 `DesktopRemote`

Expected:
- 出现新连接日志
- 出现 `distributed_tool_rebound`
- 后续 `distributed_tool_sent` 指向新的 `serverId`
- 调用成功

**Step 3: 超时路径验证**

操作：
- 制造一次无回包场景

Expected:
- `pending_request_added`
- `distributed_tool_timeout`
- `tool_call_failed`
- timeout 后 pending 数量回落

**Step 4: 运行时快照验证**

操作：
- 开启：
  - `DIST_TOOL_DIAGNOSTICS_ENABLED=true`
  - `DIST_TOOL_DIAGNOSTICS_INTERVAL_MS=60000`

Expected:
- 出现 `runtime_snapshot`
- 高压场景下出现 `runtime_pressure_warning` 或保持稳定

### Task 8: 文档同步

**Files:**
- Modify: `docs/DISTRIBUTED_ARCHITECTURE.md`
- Modify: `docs/分布式超时诊断说明.md`

**Step 1: 更新架构文档**

补充说明：
- `serverId` 是连接级临时 ID
- `serverName` 是逻辑节点名
- 同逻辑节点重连时允许重绑定

**Step 2: 更新诊断说明文档**

补充说明：
- 新增 `distributed_tool_rebound` 日志
- 如何判断请求是否仍然命中旧节点

**Step 3: 校对文档术语**

Expected:
- `serverId`
- `serverName`
- “重绑定”
- “连接级 ID / 逻辑节点名”

术语一致

### Task 9: 最终检查

**Files:**
- Read: `Plugin.js`
- Read: `WebSocketServer.js`
- Read: `server.js`
- Read: `D:/VCP/VCPChat/main.js`

**Step 1: 检查改动是否最小**

确认：
- 未重写协议
- 未改造执行主路径为名称路由
- 仅补足重绑定与诊断

**Step 2: 检查边界是否清晰**

确认：
- 不支持多个同名 `serverName`
- 不承诺修复 Windows 侧真实执行超时

**Step 3: 准备交付说明**

说明应包含：
- 修复范围
- 日志新增点
- 如何观察修复是否生效

**Step 4: 提交策略**

当前计划不包含 git 提交步骤。
原因：本轮用户明确要求不要关心本地未提交代码，并且未要求提交代码。
