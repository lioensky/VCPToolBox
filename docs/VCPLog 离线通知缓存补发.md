# VCPLog 离线通知缓存补发(一期 — 基于 IP 的设备识别)实施完成

## 一、新增模块

**[`modules/vcpLogReplayManager.js`](modules/vcpLogReplayManager.js:1)**(单例)集中维护:

- 全局缓存 `cache[]`:最多 **100 条**,每条最长保留 **24 小时**;`tool_approval_request` 类型的缓存条目额外以 `approvalTtlMs` 提前过期。
- 设备表 `devices: Map<deviceKey, DeviceState>`:**断线不删,只标记离线**;同一 IP 反复上下线被视为同一设备。
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

在 [`WebSocketServer.js`](WebSocketServer.js:1) 做了 4 处修改:

1. **顶部引入** [`vcpLogReplayManager`](modules/vcpLogReplayManager.js:1)。
2. **handleUpgrade 中**([`WebSocketServer.js:215`](WebSocketServer.js:215)):提前从 `x-forwarded-for` / `socket.remoteAddress` 解析 `clientIp`(标准化掉 `::ffff:` 前缀),挂到 `ws.clientIp`;对 `clientType === 'VCPLog'` 的连接,以 IP(或回退 `noip-<clientId>`)作为 `deviceKey`,调用 `registerOnline` 注册并注入 `sendFn`。
3. **ws.on('close') 中**([`WebSocketServer.js:489`](WebSocketServer.js:489)):VCPLog 连接关闭时调用 `handleOffline`,设备状态保留但置为离线、清掉稳定窗口计时器。
4. **broadcast() 中**([`WebSocketServer.js:519`](WebSocketServer.js:519)):**仅当** `targetClientType === 'VCPLog'` 时调用 `enqueue` 入缓存;在线投递成功的客户端通过 `recordDelivered(deviceKey, entryId)` 记录已投递,防止该设备重连后重复补发。注意没有动 `broadcastVCPInfo` / `broadcastToAdminPanel` 等其它通道,符合"VCPInfo 即时消息,过期无意义"的设计。
5. **module.exports** 暴露 `cancelVcpLogApprovalCache(requestId)` / `getVcpLogReplayStats()`,后者可用于今后接入监控面板。

## 三、Plugin.js 接入点

[`Plugin.js`](Plugin.js:1) 两处改动:

1. **审核请求广播**([`Plugin.js:989`](Plugin.js:989)附近):`approvalRequest.data` 中带上 `approvalTtlMs = toolApprovalManager.getTimeoutMs()`,模块据此为审核缓存条目设置短 TTL,确保超时后自动清除、不再补发。
2. **handleApprovalResponse**([`Plugin.js:1459`](Plugin.js:1459)):用户审核响应到达时(approve / reject / silentReject 任一情况),先调用 `this.webSocketServer.cancelVcpLogApprovalCache(requestId)` 清除对应缓存条目,然后再 resolve / reject 业务 Promise。这样掉线后再上线的 VCPChat 不会收到"已经处理完"的过期审核请求。

## 四、关键设计决策回顾

| 决策 | 选择 |
|---|---|
| 设备识别 | 一期 IP-based,模块对外用 `deviceKey` 抽象;二期换 client 上报 deviceId 时只改 WebSocketServer 的 `deviceKey` 来源即可 |
| 覆盖广播通道 | 仅 `targetClientType === 'VCPLog'`(VCPInfo / AdminPanel 不缓存) |
| 上线补发触发 | 重连后启动 3s `setTimeout`,期间若再次断线 → `clearTimeout` 取消 |
| 补发方式 | 逐条原 type 重发,客户端无需改造;条间 80ms 节流 |
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

## 六、为二期(client 上报 deviceId)预留的扩展点

只需在 [`WebSocketServer.js:215`](WebSocketServer.js:215) 附近 URL parse 出 `deviceId`(或在 ack 之后由客户端的首条消息上报),把:

```js
const deviceKey = ws.clientIp || `noip-${clientId}`;
```

替换为:

```js
const deviceKey = ws.deviceId || ws.clientIp || `noip-${clientId}`;
```

`vcpLogReplayManager` 不需要任何改动即可平滑过渡;deviceId 持久化在 VCPChat 端即可。