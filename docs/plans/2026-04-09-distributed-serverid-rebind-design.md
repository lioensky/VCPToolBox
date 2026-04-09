# 分布式节点重连绑定修复设计

## 背景

当前 `VCPToolBox` 的分布式节点 `serverId` 是连接级临时 ID，每次 WebSocket 重连都会变化。这本身不是问题，问题出在主服务将分布式工具的绑定直接缓存为 `serverId`，并在同名工具重新注册时直接按“重名冲突”跳过。

本次故障中，`DesktopRemote` 连续被发往旧节点 `dist-mnonf8se-et6ywyd`，而在线的新节点已经能够正常持续发送 `update_static_placeholders`。这说明故障核心不是 `DesktopRemote` 插件本体，也不是所有分布式链路都断了，而是：

- 旧节点绑定没有及时失效
- 新节点注册没有覆盖旧绑定
- 后续请求仍然路由到失效的旧 `serverId`

同时，当前本地工作区可能存在未提交修改。本设计明确以**已提交代码行为**为准，不将本地未提交改动视为真实基线。

## 目标

在尽量小改动的前提下，修复“同一个逻辑分布式节点重连后，主服务仍将请求发往旧 `serverId`”的问题，并恢复分布式超时诊断日志，确保后续问题可观察、可定位。

本设计目标包含两部分：

1. 修复分布式工具对旧 `serverId` 的残留绑定
2. 重新应用分布式超时诊断日志方案，并增加本次修复专用日志

## 非目标

本次设计不处理以下问题：

- 不将 `serverId` 改造成稳定 ID
- 不重构整个分布式协议
- 不支持多个同名 `serverName` 节点同时在线并提供同名工具
- 不修复 Windows 侧 `DesktopRemote`、renderer 或其他插件本体的真实执行性能问题
- 不处理本地未提交代码造成的行为差异

## 现状判断

### 已知事实

1. `serverId` 在主服务端按每次连接动态生成，格式为 `dist-<clientId>`
2. `PluginManager` 在注册分布式工具时，将 `toolManifest.serverId = serverId`
3. 工具调用时，`processToolCall()` 直接使用缓存的 `plugin.serverId`
4. 同名分布式工具再次注册时，当前逻辑直接 `Skipping`
5. `VCPChat/VCPDistributedServer/config.env` 中的 `ServerName` 当前提交代码并未真正读取
6. `main.js` 中实际传入的 `serverName` 仍为硬编码值 `VCP-Desktop-Client-Distributed-Server`

### 根因

根因不是“节点 ID 会变化”，而是：

- `serverId` 是临时连接 ID，却被当成长期稳定绑定使用
- 同一逻辑节点重连后，旧工具绑定没有被新连接接管
- 服务端插件注册表没有对同逻辑节点的重连做覆盖更新

## 方案对比

### 方案 A：同名分布式工具重连时按 `serverName` 覆盖旧绑定

做法：

- 保留当前连接级 `serverId`
- 分布式工具注册时额外记录稳定的 `serverName`
- 若同名工具已存在，且旧记录也是分布式工具，且 `serverName` 相同，则更新其 `serverId` 为新连接

优点：

- 改动最小
- 主要集中在 `Plugin.js` 和 `WebSocketServer.js`
- 不需要重写执行路径
- 直接对症本次故障

缺点：

- 依赖 `serverName` 稳定
- 默认不支持多个同名 `serverName` 节点同时在线

### 方案 B：调用时改为按 `serverName` 动态选路

做法：

- `processToolCall()` 不再使用缓存的 `serverId`
- 调用时优先按稳定 `serverName` 在当前在线连接中查找节点

优点：

- 更符合逻辑身份与连接实例分离的设计

缺点：

- 改动面更大
- 会影响主调用路径与执行语义
- 对“最小修复”要求不够友好

### 方案 C：仅增强断链清理

做法：

- 强化 `unregisterAllDistributedTools()` 和断线清理
- 确保旧节点断开后工具一定从注册表中移除

优点：

- 修改简单

缺点：

- 不能解决“新连接先到、旧连接后断”这类竞态
- 无法保证覆盖本次故障模式

## 推荐方案

推荐采用 **方案 A**。

理由：

- 与本次故障模式完全对应
- 实现最小，符合 YAGNI
- 不需要调整协议和主执行模型
- 能够与已有的超时诊断日志一起落地

## 设计细节

### 1. 身份模型

保留两层身份：

- `serverId`：连接级临时 ID，继续由主服务在连接建立时生成
- `serverName`：逻辑节点稳定身份，用于判断“是否同一节点重连”

设计原则：

- `serverId` 允许变化
- `serverName` 应稳定
- 分布式工具绑定更新以 `serverName` 为判断条件

### 2. 注册逻辑

当前：

- 同名工具若已存在，直接冲突跳过

修改后：

- 若同名工具不存在，按现有逻辑注册
- 若同名工具存在，但旧记录不是分布式工具，则仍冲突拒绝
- 若同名工具存在，且旧记录是分布式工具：
  - `serverName` 相同：执行重绑定，更新 `serverId`
  - `serverName` 不同：仍冲突拒绝

### 3. 调用逻辑

保持当前最小调用路径：

- `processToolCall()` 继续读取 `plugin.serverId`
- 不改 `executeDistributedTool()` 的主入口签名

这意味着只要注册时已经把 `plugin.serverId` 更新为最新连接，请求自然会发到新节点。

### 4. `serverName` 来源

优先级：

1. 当前连接对象中已保存的 `serverName`
2. `register_tools` / `report_ip` / `update_static_placeholders` 消息中的 `serverName`
3. 回退到 `serverId`

同时，当前提交代码中 `VCPChat/main.js` 仍对 `serverName` 使用硬编码值。本次最小修复可以先保留该行为，因为它已经足以为单节点重连提供稳定逻辑名。

如果后续需要真正可配置，再单独处理 `VCPDistributedServer/config.env` 的接入。

## 日志设计

### 1. 恢复原有诊断日志

保留并重新应用以下日志：

- `[DistTool]`
  - `tool_call_started`
  - `distributed_tool_sent`
  - `tool_result_received`
  - `tool_call_completed`
- `[DistToolPending]`
  - `pending_request_added`
  - `pending_request_removed`
  - `unmatched_tool_result`
- `[DistToolTimeout]`
  - `distributed_tool_timeout`
  - `tool_call_failed`
- `[DistToolRuntime]`
  - `runtime_snapshot`
  - `runtime_pressure_warning`

### 2. 新增重绑定日志

新增事件：

- `[DistTool] {"event":"distributed_tool_rebound", ... }`

建议字段：

- `toolName`
- `serverName`
- `oldServerId`
- `newServerId`
- `reboundAt`

作用：

- 直接证明旧绑定已被新连接接管
- 为本次修复提供一眼可见的验证信号

## 数据流

修复后的重连流程如下：

1. 旧节点 `dist-A` 注册 `DesktopRemote`
2. 主服务记录：
   - `toolName = DesktopRemote`
   - `serverId = dist-A`
   - `serverName = VCP-Desktop-Client-Distributed-Server`
3. 客户端断线重连，主服务生成新 `serverId = dist-B`
4. 新连接重新上报工具注册
5. 主服务发现：
   - 同名工具已存在
   - 旧记录也是分布式工具
   - `serverName` 相同
6. 执行重绑定：
   - 旧 `serverId = dist-A`
   - 新 `serverId = dist-B`
7. 后续工具调用继续走现有逻辑，但请求目标已变为新连接

## 错误处理

保守规则如下：

1. 若没有可靠 `serverName`，不自动覆盖旧绑定
2. 若同名工具来自不同 `serverName`，继续视为冲突
3. 若旧工具是本地工具，不允许被分布式工具覆盖
4. 超时与 pending 清理逻辑继续沿用现有机制

## 测试设计

### 验证 1：正常基线

- 节点在线时调用一次 `DesktopRemote`
- 应看到完整的调用生命周期日志

### 验证 2：重连修复

- 不重启 `VCPToolBox`
- 让 `VCPChat` 分布式节点断开后重连
- 再次调用 `DesktopRemote`
- 期望看到：
  - 新节点连接日志
  - `distributed_tool_rebound`
  - `distributed_tool_sent` 指向新 `serverId`
  - 成功返回

### 验证 3：超时日志恢复

- 制造无回包场景
- 期望看到：
  - `pending_request_added`
  - `distributed_tool_timeout`
  - `tool_call_failed`
  - 超时后 pending 数量被清理

## 风险

1. 若 `serverName` 不稳定，本方案效果会退化
2. 多个同名 `serverName` 节点同时在线时，本方案存在歧义
3. 本次不处理 Windows 侧执行真实超时，因此仍可能存在其他类型的超时

## 验收标准

1. 同一逻辑节点重连后，无需重启 `VCPToolBox`，`DesktopRemote` 恢复成功
2. 日志可见 `distributed_tool_rebound`
3. 请求后续发往新的 `serverId`
4. 分布式诊断日志可完整恢复

## 结论

本设计将问题限定为：

> 同逻辑分布式节点重连后，主服务未将工具绑定从旧 `serverId` 刷新到新连接

通过在主服务侧引入基于 `serverName` 的最小重绑定机制，并恢复原有分布式超时诊断日志，可以在较小改动下直接修复本次故障模式，并显著提升后续问题排查能力。
