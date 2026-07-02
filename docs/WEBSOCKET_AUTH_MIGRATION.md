# WebSocket 鉴权方式迁移开发文档

## 1. 背景

当前 VCPToolBox 的 WebSocket 鉴权主要通过 URL 路径携带 `VCP_Key` 完成，例如：

```text
/VCPlog/VCP_Key=<VCP_Key>
/vcpinfo/VCP_Key=<VCP_Key>
/vcp-distributed-server/VCP_Key=<VCP_Key>
/vcp-chrome-control/VCP_Key=<VCP_Key>
/vcp-chrome-observer/VCP_Key=<VCP_Key>
/vcp-admin-panel/VCP_Key=<VCP_Key>
```

这种方式实现简单，但密钥会出现在 URL 中，容易进入浏览器历史、反向代理访问日志、调试面板、报错堆栈和监控系统。后续应迁移到标准 WebSocket 握手鉴权方式：**URL 不再包含密钥，密钥通过 Header 或 WebSocket 子协议传递**。

本文件定义新的 WebSocket 鉴权规范，用于一次性迁移 VCP 自研的桌面端、移动端、浏览器端、脚本端、Chrome 扩展和分布式节点。

## 2. 目标

### 2.1 安全目标

- `VCP_Key` 不再出现在 WebSocket URL 路径或查询字符串中。
- 连接 URL 可安全出现在日志中，不泄露密钥。
- 服务端统一从握手请求中提取认证信息。
- 旧 URL 鉴权方式可在迁移期保留兼容，最终可通过配置禁用。

### 2.2 兼容目标

- 所有现有 WebSocket 通道继续保留。
- 消息协议不变。
- 分布式工具注册、远程调用、回调转发协议不变。
- VCPLog 离线补发的 `deviceName` 机制不变。
- 新旧客户端可短期共存。

## 3. WebSocket 通道清单

服务端当前统一入口位于 `WebSocketServer.js`。

| 通道 | 旧路径 | 新路径 | 客户端类型 |
|---|---|---|---|
| VCPLog 通知 | `/VCPlog/VCP_Key=<key>` | `/VCPlog` | `VCPLog` |
| VCPInfo 信息 | `/vcpinfo/VCP_Key=<key>` | `/vcpinfo` | `VCPInfo` |
| 分布式节点 | `/vcp-distributed-server/VCP_Key=<key>` | `/vcp-distributed-server` | `DistributedServer` |
| Chrome 控制 | `/vcp-chrome-control/VCP_Key=<key>` | `/vcp-chrome-control` | `ChromeControl` |
| Chrome 观察者 | `/vcp-chrome-observer/VCP_Key=<key>` | `/vcp-chrome-observer` | `ChromeObserver` |
| 管理面板专用通道 | `/vcp-admin-panel/VCP_Key=<key>` | `/vcp-admin-panel` | `AdminPanel` |

## 4. 新鉴权规范

### 4.1 首选方式：Authorization Bearer

所有非浏览器受限运行时优先使用：

```http
Authorization: Bearer <VCP_Key>
```

适用客户端：

- Node.js 脚本
- 桌面端主进程
- 移动端原生 WebSocket 客户端
- 分布式 VCPToolBox 节点
- 后端内部桥接器
- CLI 工具

示例 URL：

```text
ws://127.0.0.1:6005/VCPlog?deviceName=VCPChat-Desktop
```

示例握手 Header：

```http
Authorization: Bearer vcp_xxxxxxxxxxxxxxxxx
```

### 4.2 兼容方式：x-vcp-key

部分 WebSocket 库设置 `Authorization` 不方便时，可使用：

```http
x-vcp-key: <VCP_Key>
```

服务端应将其视为与 `Authorization: Bearer` 等价。

### 4.3 浏览器标准 WebSocket 限制

浏览器原生 `WebSocket` 构造函数不能自定义 HTTP Header，因此浏览器类客户端不能直接发送 `Authorization` 或 `x-vcp-key`。

浏览器可选方案：

1. 通过后端会话 Cookie 鉴权后，由同源后端签发短期 WS token。
2. 使用 `Sec-WebSocket-Protocol` 子协议携带一次性 token。
3. 在迁移期继续使用旧 URL key，直到短期 token 方案落地。

由于 VCP 的六大前端均为自研，推荐最终统一为：

```text
前端登录态 / 管理端接口 -> 获取 wsUrl + wsToken -> WebSocket 子协议携带 token
```

### 4.4 浏览器推荐方式：Sec-WebSocket-Protocol

浏览器可以这样连接：

```js
const ws = new WebSocket(wsUrl, ["vcp.auth", `vcp.token.${wsToken}`]);
```

服务端从 `Sec-WebSocket-Protocol` 中提取 `vcp.token.<token>` 并校验。

注意：

- 不建议直接把长期 `VCP_Key` 放入子协议。
- 推荐放短期 token。
- 短期 token 可由 `/admin_api/notifications/connection` 或专门的 WS token 接口返回。
- 服务端响应时只应选择安全的业务子协议，例如 `vcp.auth`，不应把 token 原样返回给客户端。

## 5. 服务端认证提取优先级

服务端建议统一实现 `extractWebSocketAuth(request, parsedUrl, legacyPathKey)`。

认证来源优先级：

1. `Authorization: Bearer <key>`
2. `x-vcp-key: <key>`
3. `Sec-WebSocket-Protocol` 中的 `vcp.token.<token>`
4. Cookie / Session 派生的短期 token
5. 旧路径中的 `VCP_Key=<key>`，仅迁移期兼容

返回结构建议：

```js
{
  ok: true,
  key: "...",
  source: "authorization" | "x-vcp-key" | "subprotocol" | "cookie-token" | "legacy-url"
}
```

失败时：

```js
{
  ok: false,
  source: null,
  reason: "missing" | "invalid" | "expired"
}
```

## 6. 服务端路径匹配建议

旧路径正则应拆成两类：

### 6.1 新路径

```js
const vcpLogPathRegex = /^\/VCPlog\/?$/;
const vcpInfoPathRegex = /^\/vcpinfo\/?$/;
const distServerPathRegex = /^\/vcp-distributed-server\/?$/;
const chromeControlPathRegex = /^\/vcp-chrome-control\/?$/;
const chromeObserverPathRegex = /^\/vcp-chrome-observer\/?$/;
const adminPanelPathRegex = /^\/vcp-admin-panel\/?$/;
```

### 6.2 旧路径兼容

```js
const legacyVcpLogPathRegex = /^\/VCPlog\/VCP_Key=(.+)$/;
const legacyVcpInfoPathRegex = /^\/vcpinfo\/VCP_Key=(.+)$/;
const legacyDistServerPathRegex = /^\/vcp-distributed-server\/VCP_Key=(.+)$/;
const legacyChromeControlPathRegex = /^\/vcp-chrome-control\/VCP_Key=(.+)$/;
const legacyChromeObserverPathRegex = /^\/vcp-chrome-observer\/VCP_Key=(.+)$/;
const legacyAdminPanelPathRegex = /^\/vcp-admin-panel\/VCP_Key=(.+)$/;
```

### 6.3 兼容开关

建议增加环境变量：

```text
ALLOW_LEGACY_WS_URL_KEY=true
```

迁移完成后可切换为：

```text
ALLOW_LEGACY_WS_URL_KEY=false
```

当旧路径命中时，服务端应输出弃用日志：

```text
[WebSocketServer] Deprecated URL VCP_Key auth used: clientType=VCPLog ip=...
```

## 7. 通道 URL 迁移示例

### 7.1 VCPLog

旧：

```text
ws://host:6005/VCPlog/VCP_Key=<key>
```

新：

```text
ws://host:6005/VCPlog?deviceName=<deviceName>
```

Header：

```http
Authorization: Bearer <key>
```

或：

```http
x-vcp-key: <key>
```

浏览器短期 token 子协议：

```js
new WebSocket("ws://host:6005/VCPlog?deviceName=AdminPanel-Vue-Notifications", [
  "vcp.auth",
  `vcp.token.${wsToken}`
]);
```

### 7.2 VCPInfo

旧：

```text
ws://host:6005/vcpinfo/VCP_Key=<key>
```

新：

```text
ws://host:6005/vcpinfo
```

### 7.3 分布式节点

旧：

```text
ws://host:6005/vcp-distributed-server/VCP_Key=<key>
```

新：

```text
ws://host:6005/vcp-distributed-server
```

Header：

```http
Authorization: Bearer <key>
```

分布式节点完成握手后，后续消息协议保持不变：

```json
{ "type": "register_tools", "data": { "tools": [] } }
```

```json
{ "type": "report_ip", "data": { "localIPs": [], "publicIP": null, "serverName": "node-a" } }
```

```json
{ "type": "tool_result", "data": { "requestId": "...", "status": "success", "result": "..." } }
```

### 7.4 ChromeObserver

旧：

```text
ws://host:6005/vcp-chrome-observer/VCP_Key=<key>
```

新：

```text
ws://host:6005/vcp-chrome-observer
```

浏览器扩展后台脚本若使用 Chrome Extension WebSocket，也受浏览器 Header 限制，建议使用短期 token 子协议。

## 8. 六大前端迁移清单

### 8.1 桌面端

推荐：

- URL 移除 `VCP_Key`。
- 使用 `Authorization: Bearer <VCP_Key>`。
- VCPLog 通道继续追加 `deviceName`。
- 本地持久化 `deviceName` 或实例 ID。

### 8.2 移动端

推荐：

- 使用原生 WebSocket 库设置 `Authorization`。
- 如运行在 WebView 原生 `WebSocket` 中，改用短期 token 子协议。
- VCPLog 通道继续追加 `deviceName`。

### 8.3 管理面板浏览器端

推荐：

- 后端接口返回无 key `wsUrl`。
- 后端接口额外返回短期 `wsToken`。
- 浏览器通过 `Sec-WebSocket-Protocol` 携带 token。
- `deviceName=AdminPanel-Vue-Notifications` 保持不变。

### 8.4 SillyTavern / 油猴脚本

推荐：

- 若脚本运行环境不能设置 Header，使用短期 token 子协议。
- 由配置界面或接口获取短期 `wsToken`。
- URL 不再携带长期 `VCP_Key`。
- 设置独立 `deviceName=SillyTavern-NotificationBar`。

### 8.5 Chrome 扩展

推荐：

- Background 脚本连接无 key URL。
- 使用短期 token 子协议。
- Observer 和 Control 通道分别迁移。
- 如果需要区分多个浏览器实例，可追加 `deviceName` 或后续增加 `clientName`。

### 8.6 分布式节点

推荐：

- Node.js WebSocket 客户端直接设置 `Authorization: Bearer <VCP_Key>`。
- URL 改为 `/vcp-distributed-server`。
- 分布式节点无需 `deviceName`，因为它不走 VCPLog 离线补发设备表。
- 保持 `serverName` 上报，用于节点识别和提示词快照。

## 9. Node.js WebSocket 客户端示例

```js
const WebSocket = require("ws");

const ws = new WebSocket("ws://127.0.0.1:6005/vcp-distributed-server", {
  headers: {
    Authorization: `Bearer ${process.env.VCP_Key}`
  }
});

ws.on("open", () => {
  ws.send(JSON.stringify({
    type: "register_tools",
    data: {
      serverName: "node-a",
      tools: []
    }
  }));
});
```

## 10. 浏览器 WebSocket 客户端示例

```js
const ws = new WebSocket(
  "ws://127.0.0.1:6005/VCPlog?deviceName=AdminPanel-Vue-Notifications",
  ["vcp.auth", `vcp.token.${wsToken}`]
);

ws.onmessage = (event) => {
  const payload = JSON.parse(event.data);
  console.log(payload);
};
```

## 11. 服务端校验行为

### 11.1 成功

当认证通过时，继续现有逻辑：

- 生成 `clientId`。
- 设置 `ws.clientType`。
- 设置 `ws.clientIp`。
- 设置 `ws.deviceName`。
- 对 VCPLog 注册离线补发设备。
- 发送 `connection_ack`。

### 11.2 失败

当认证失败时：

- 不调用 `handleUpgrade`。
- 直接 `socket.destroy()`。
- 不在日志中打印完整 key。
- 只打印认证来源和客户端类型。

建议日志：

```text
[WebSocketServer] WebSocket auth failed: clientType=VCPLog source=missing ip=...
```

### 11.3 旧认证命中

当旧 URL key 命中时：

```text
[WebSocketServer] Deprecated WebSocket URL key auth used: clientType=VCPLog ip=...
```

## 12. 短期 wsToken 建议

如果要支持浏览器无 URL key，可以增加一个短期 token 管理器。

### 12.1 token 内容

```js
{
  token: "...",
  clientType: "VCPLog",
  deviceName: "AdminPanel-Vue-Notifications",
  expiresAt: 1710000000000
}
```

### 12.2 token TTL

建议：

```text
60 秒 - 5 分钟
```

### 12.3 token 使用规则

- token 只用于 WebSocket 握手。
- token 一次性使用或短 TTL 多次使用均可。
- token 不应进入 URL。
- token 可通过 `Sec-WebSocket-Protocol` 传递。

## 13. 验收标准

### 13.1 URL 安全

服务端日志、浏览器 DevTools URL、反代访问日志中不应出现长期 `VCP_Key`。

### 13.2 通道可用

以下通道均可完成连接：

- `/VCPlog`
- `/vcpinfo`
- `/vcp-distributed-server`
- `/vcp-chrome-control`
- `/vcp-chrome-observer`
- `/vcp-admin-panel`

### 13.3 兼容期

在 `ALLOW_LEGACY_WS_URL_KEY=true` 时，旧路径仍可连接，但会输出弃用日志。

### 13.4 禁用旧认证

在 `ALLOW_LEGACY_WS_URL_KEY=false` 时，旧路径应被拒绝。

### 13.5 分布式协议不变

分布式节点迁移新鉴权后，以下功能必须保持正常：

- 工具注册。
- IP 上报。
- 静态占位符更新。
- 远程工具执行。
- `tool_result` 返回。
- `plugin_callback_forward` 转发。
- 分布式音乐播放列表同步。

## 14. 推荐实施顺序

1. 服务端在 `WebSocketServer.js` 增加统一鉴权提取器。
2. 服务端支持新无 key 路径。
3. 服务端保留旧路径兼容和弃用日志。
4. Node.js 后端类客户端先迁移到 `Authorization: Bearer`。
5. 浏览器类客户端接入短期 `wsToken` + `Sec-WebSocket-Protocol`。
6. 分布式节点迁移到 `/vcp-distributed-server` + `Authorization: Bearer`。
7. 全部自研前端迁移完成后，将 `ALLOW_LEGACY_WS_URL_KEY=false`。
8. 确认无旧认证日志后，后续版本移除旧路径正则。