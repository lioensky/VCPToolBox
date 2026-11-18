# VCPLog 离线通知缓存补发(一期 — 支持 deviceName 设备名识别)实施完成

## 一、新增模块

**[`modules/vcpLogReplayManager.js`](modules/vcpLogReplayManager.js:1)**(单例)集中维护:

- 全局缓存 `cache[]`:最多 **100 条**,每条最长保留 **24 小时**;`tool_approval_request` 类型的缓存条目额外以 `approvalTtlMs` 提前过期。
- 设备表 `devices: Map<deviceKey, DeviceState>`:**断线不删,只标记离线**;优先使用前端上报的 `deviceName` 识别设备,未上报时回退到同一 IP 反复上下线视为同一设备。
- 每个设备的 `deliveredIds: Set` 记录"该设备在本次缓存生命周期内已成功收到的条目",作为补发差集依据。
- 上线后启动 **3 秒稳定窗口**(`onlineStabilityMs`),窗口结束时仍在线才触发补发。
- 逐条补发,条间 `replayIntervalMs=80ms` 间隔,避免突发拥塞;补发包附加 `_vcpReplay: true / _vcpReplayOriginalAt` 元数据。
- 周期性 `_sweep()`(每分钟一次):清理过期缓存、清理失效 deliveredIds 引用、回收长期不活动设备(默认 7 天 TTL)。

公开 API:
- `registerOnline({ deviceKey, clientIp, clientId, sendFn })`
- `handleOffline({ deviceKey, clientId })`
- `enqueue(payload)` / `recordDelivered(deviceKey, entryId)`
- `cancelApprovalCache(requestId)`(供 PluginManager 在用户响应审核后调用)
- `getStats()` / `reset()` / `shutdown()`

## 二、WebSocketServer.js 接入点

在 [`WebSocketServer.js`](WebSocketServer.js:1) 做了 5 处修改:

1. **顶部引入** [`vcpLogReplayManager`](modules/vcpLogReplayManager.js:1)。
2. **通用设备名规范化**:新增 `normalizeDeviceName(value)`,用于清洗前端通过 WebSocket URL 查询参数上报的 `deviceName`。
3. **handleUpgrade 中**([`WebSocketServer.js:215`](WebSocketServer.js:215)):提前从 `x-forwarded-for` / `socket.remoteAddress` 解析 `clientIp`(标准化掉 `::ffff:` 前缀),挂到 `ws.clientIp`;同时从 `parsedUrl.query.deviceName` / `device_name` / `devicename` 读取通用设备名,挂到 `ws.deviceName`。
4. **VCPLog 设备键生成**:对 `clientType === 'VCPLog'` 的连接,优先使用 `deviceName:<name>` 作为 `deviceKey`;未上报设备名时再回退到 IP(或 `noip-<clientId>`),调用 `registerOnline` 注册并注入 `sendFn`。这样同一 IP 下的网页端、桌面端、酒馆端不会互相污染 `deliveredIds`。
5. **ws.on('close') 中**([`WebSocketServer.js:489`](WebSocketServer.js:489)):VCPLog 连接关闭时调用 `handleOffline`,设备状态保留但置为离线、清掉稳定窗口计时器。
6. **broadcast() 中**([`WebSocketServer.js:519`](WebSocketServer.js:519)):**仅当** `targetClientType === 'VCPLog'` 时调用 `enqueue` 入缓存;在线投递成功的客户端通过 `recordDelivered(deviceKey, entryId)` 记录已投递,防止该设备重连后重复补发。注意没有动 `broadcastVCPInfo` / `broadcastToAdminPanel` 等其它通道,符合"VCPInfo 即时消息,过期无意义"的设计。
7. **module.exports** 暴露 `cancelVcpLogApprovalCache(requestId)` / `getVcpLogReplayStats()`,后者可用于今后接入监控面板。

## 三、Plugin.js 接入点

[`Plugin.js`](Plugin.js:1) 两处改动:

1. **审核请求广播**([`Plugin.js:989`](Plugin.js:989)附近):`approvalRequest.data` 中带上 `approvalTtlMs = toolApprovalManager.getTimeoutMs()`,模块据此为审核缓存条目设置短 TTL,确保超时后自动清除、不再补发。
2. **handleApprovalResponse**([`Plugin.js:1459`](Plugin.js:1459)):用户审核响应到达时(approve / reject / silentReject 任一情况),先调用 `this.webSocketServer.cancelVcpLogApprovalCache(requestId)` 清除对应缓存条目,然后再 resolve / reject 业务 Promise。这样掉线后再上线的 VCPChat 不会收到"已经处理完"的过期审核请求。

## 四、关键设计决策回顾

| 决策 | 选择 |
|---|---|
| 设备识别 | 优先使用前端上报的 `deviceName`;未上报时回退 IP-based;模块对外仍只感知抽象 `deviceKey` |
| 前端适配 | WebSocket URL 追加 `?deviceName=<稳定设备名>` 即可接入独立补发设备身份 |
| 覆盖广播通道 | 仅 `targetClientType === 'VCPLog'`(VCPInfo / AdminPanel 专用通道不缓存) |
| 上线补发触发 | 重连后启动 3s `setTimeout`,期间若再次断线 → `clearTimeout` 取消 |
| 补发方式 | 逐条原 type 重发,客户端无需改造;条间 80ms 节流 |
| 补发可观测性 | 稳定窗口结束、待补发数量、开始补发、补发结束均输出运行日志 |
| 审核类缓存 | 单条 TTL = `toolApprovalManager.getTimeoutMs()`;用户已响应 → PluginManager 主动取消 |
| 失败投递 | 重发过程中任一条 `send` 失败即视为掉线、停止后续重发,等待下次 stability 窗口 |
| 持久化 | 不持久化,主服务重启后重置;长期未活动设备 7 天后回收 |

## 五、行为示例

1. 某 VCPChat 连入(IP=192.168.1.50)→ device 表记录 `192.168.1.50`,在线。
2. 服务端有 5 条 VCPLog 通知广播 → 该设备每条都收到,deliveredIds 包含全部 5 个 id。
3. VCPChat 断线 → device 保留,标记 offline。
4. 服务端又广播 3 条 VCPLog 通知,其中包括 1 个工具审核请求 → 全部入 cache,该 device 的 deliveredIds 不变,新 id 没有进入。
5. 期间用户在另一台设备上点击"批准"该审核 → `handleApprovalResponse` 触发 `cancelVcpLogApprovalCache` → 缓存中那条审核被剔除。
6. VCPChat 重连(还是 192.168.1.50)→ device 重新置为在线,启动 3s stability 窗口。
7. 3s 内未再次断线 → 触发 replay,把"该 device 没收过 + 仍在 cache 内"的 **2 条**(审核那条已被取消)逐条按 80ms 间隔补发,客户端能据 `_vcpReplay: true` 区分。
8. 同设备又断线 / 再上线 → 重复 4–7。

## 六、前端适配开发说明:deviceName

### 6.1 适配目标

多个通知监听前端可能来自同一 IP,例如:

- AdminPanel 网页通知抽屉;
- VCPChat 桌面端通知栏;
- SillyTavern 油猴通知栏;
- 其它网页端或移动端监听器。

如果只按 IP 识别设备,同 IP 下某个客户端收到通知后会写入该 IP 的 `deliveredIds`,导致另一个客户端重新上线时被误判为"已经收到",从而不再补发。

因此前端应在连接 VCPLog WebSocket 时上报稳定 `deviceName`,让每个前端拥有独立补发状态。

### 6.2 WebSocket URL 约定

前端连接 VCPLog 通道时,在原 URL 后追加查询参数:

```text
/VCPlog/VCP_Key=<VCP_Key>?deviceName=<稳定设备名>
```

后端兼容以下参数名:

```text
deviceName
device_name
devicename
```

后端会把设备键解析为:

```text
deviceName:<稳定设备名>
```

未上报 `deviceName` 的旧客户端保持原兼容行为:继续按 IP 或 `noip-<clientId>` 识别。

### 6.3 AdminPanel 已内置适配

[`routes/admin/system.js`](routes/admin/system.js:295) 的 `/admin_api/notifications/connection` 已为 AdminPanel 通知抽屉生成专属设备名:

```text
AdminPanel-Vue-Notifications
```

返回的 `wsUrl` 形如:

```text
ws://<host>:<port>/VCPlog/VCP_Key=<key>?deviceName=AdminPanel-Vue-Notifications
```

因此 [`AdminPanel-Vue/src/stores/notifications.ts`](AdminPanel-Vue/src/stores/notifications.ts:403) 直接使用后端返回的 `wsUrl` 即可,无需前端额外拼接。

### 6.4 第三方前端建议

第三方前端应选择一个稳定且能区分客户端类型的名字,例如:

```text
VCPChat-Desktop
SillyTavern-NotificationBar
OpenWebUI-VCPLogPanel
Mobile-Web-Notifications
```

如果同一种前端可能在同一用户环境中打开多个独立实例,建议把本地持久化实例 ID 拼进去:

```text
VCPChat-Desktop:<localInstanceId>
SillyTavern-NotificationBar:<localInstanceId>
```

其中 `localInstanceId` 可保存在浏览器 `localStorage`、桌面端配置文件或客户端本地数据库中。

### 6.5 补发日志排查

VCPLog 客户端连接时,服务端会输出设备解析日志:

```text
[WebSocketServer] VCPLog replay device resolved: deviceKey=deviceName:AdminPanel-Vue-Notifications, deviceName=AdminPanel-Vue-Notifications, ip=127.0.0.1, clientId=...
```

稳定窗口结束后,补发系统会输出:

```text
[VcpLogReplay] device=deviceName:AdminPanel-Vue-Notifications ip=127.0.0.1 clientId=... 已检测到3000ms稳定，当前须补发通知0条。
```

或:

```text
[VcpLogReplay] device=deviceName:AdminPanel-Vue-Notifications ip=127.0.0.1 clientId=... 须补发通知3条，已开始补发。
[VcpLogReplay] device=deviceName:AdminPanel-Vue-Notifications ip=127.0.0.1 clientId=... 补发结束，成功补发3条。
```

若看到两个不同前端拥有不同 `deviceKey`,说明前端适配已生效。