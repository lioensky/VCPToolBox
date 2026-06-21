# VCPClawMail

VCPClawMail 是面向 claw.163.com / ClawEmail 的 VCPToolBox 混合插件。

它采用 `hybridservice` 形态：

- 常驻服务：优先使用 WebSocket 即达推送监听新邮件，并用低频轮询兜底更新 `{{VCPClawMailInbox}}` 占位符。
- 同步工具：允许 AI 调用 `list_recent`、`read_mail`、`send_mail`、`reply_mail`、`download_attachment`。
- 附件链路：AI 可以在正文或 `attachments` 参数里直接写 `https://...` 或 `file://...`，插件会尽量下载/归一化为 SDK 可发送的附件对象。
- 读取链路：读邮件时返回正文、HTML 转 Markdown、图片 URL、附件元数据；后续图片/文档解析可继续交给 VCP 现有工具链处理。
- 即达链路：SDK 的 `client.ws.onMessage()` 收到 `mailId` 后立刻触发缓存刷新，并输出服务器日志，便于后续扩展“邮件抵达自动唤醒 Agent”。

## 关键事实

官方文档里的：

```bash
npx "@clawemail/claw-setup@latest" --auth-url "..."
```

这里的 `auth-url` 是一键安装/授权流程中的临时 URL，不等同于插件配置中的 `ClawMailKey`。

本插件需要的是最终能被 `@clawemail/node-sdk` 使用的 API Key，并写入：

```env
ClawMailKey=...
```

已确认的 SDK 能力边界：

- `@clawemail/node-sdk@0.2.4` 没有传统 HTTP webhook / callback URL 注册接口。
- SDK 有 WebSocket 即达推送能力：`client.ws.onMessage(async ({ mailId }) => ...)` + `await client.ws.connect()`。
- WebSocket 底层是 WuKongIM 长连接，默认地址为 `wss://claw.126.net:5210`，可通过 `wsUrl` 覆盖。
- 推送事件只携带 `mailId`，业务侧需要再调用 `client.mail.read({ id: mailId })` 或刷新列表。
- SDK 自身不做自动重连；插件侧已实现指数退避重连，并保留低频轮询兜底。

## 安装

在插件目录安装依赖，不污染根项目依赖：

Windows：

```bat
Plugin\VCPClawMail\install.bat
```

Linux/macOS：

```bash
sh Plugin/VCPClawMail/install.sh
```

或手动：

```bash
cd Plugin/VCPClawMail
npm install
```

## 配置

复制：

```bash
cp Plugin/VCPClawMail/config.env.example Plugin/VCPClawMail/config.env
```

填写：

```env
ClawMailKey=你的 ClawEmail API Key
ClawMailUsers=bot@claw.163.com,notice@claw.163.com
ClawMailDefaultUser=bot@claw.163.com

# WebSocket 即达推送，默认启用；禁用后仅保留低频轮询兜底。
ClawMailRealtimeEnabled=true

# 可选：覆盖 SDK 默认 WuKongIM WebSocket 地址，通常无需填写。
# ClawMailWsUrl=wss://claw.126.net:5210

# 低频兜底轮询间隔。代码会强制不低于 5 分钟，默认 10 分钟。
ClawMailFallbackPollIntervalMs=600000

# 兼容旧配置名；若未填写 ClawMailFallbackPollIntervalMs，会读取此项。
ClawMailPollIntervalMs=600000

ClawMailPollLimit=20
ClawMailAutoMarkRead=false
DebugMode=false
```

## 系统提示词占位符

插件加载后会维护：

```text
{{VCPClawMailInbox}}
```

内容包含最近邮件摘要、发件人、主题、时间、预览和 `mailId`。

## 工具调用示例

### 列出最近邮件

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」VCPClawMail「末」,
command:「始」list_recent「末」,
limit:「始」10「末」
<<<[END_TOOL_REQUEST]>>>
```

### 读取邮件

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」VCPClawMail「末」,
command:「始」read_mail「末」,
mailId:「始」邮件ID「末」,
markRead:「始」false「末」
<<<[END_TOOL_REQUEST]>>>
```

### 发送邮件

正文里可以直接写 URL：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」VCPClawMail「末」,
command:「始」send_mail「末」,
to:「始」someone@example.com「末」,
subject:「始」测试邮件「末」,
body:「始」你好，图片在这里：https://example.com/a.png「末」
<<<[END_TOOL_REQUEST]>>>
```

也可以显式传附件：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」VCPClawMail「末」,
command:「始」send_mail「末」,
to:「始」someone@example.com「末」,
subject:「始」带附件测试「末」,
body:「始」请查收附件。「末」,
attachments:「始」https://example.com/report.pdf,file:///H:/VCP/VCPToolBox/image/test.png「末」
<<<[END_TOOL_REQUEST]>>>
```

### 回复邮件

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」VCPClawMail「末」,
command:「始」reply_mail「末」,
mailId:「始」邮件ID「末」,
body:「始」已收到，我会尽快处理。「末」
<<<[END_TOOL_REQUEST]>>>
```

`reply_mail` 会在回复前强制读取并标记原邮件为已读，不再让 AI 选择 `markRead`。原因是只要执行回复，就代表当前邮件已经进入处理流程。

### 下载附件

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」VCPClawMail「末」,
command:「始」download_attachment「末」,
mailId:「始」邮件ID「末」,
attachmentId:「始」附件ID「末」
<<<[END_TOOL_REQUEST]>>>
```

返回的 `file://...` 可继续交给后续工具处理。

## WebSocket 即达与低频轮询兜底

当前实现采用“WebSocket 即达 + 低频轮询兜底”：

1. 初始化时为每个 `ClawMailUsers` 用户创建 `MailClient`。
2. 若 `ClawMailRealtimeEnabled` 未设为 `false`，插件调用 `client.ws.onMessage()` 注册新邮件回调，再调用 `client.ws.connect()` 建立长连接。
3. 收到 `{ mailId }` 后，插件输出日志：

```text
[VCPClawMail] 收到新邮件推送: user=..., mailId=..., time=...
```

4. 推送到达后立即调用 `pollOnce()` 刷新 `{{VCPClawMailInbox}}` 缓存。
5. 若 WebSocket 断开，插件会按 `1s → 2s → 5s → 10s → 30s → 60s` 指数退避重连。
6. 低频轮询仍会运行，用于兜底处理断线、漏消息、进程重启后的状态校准。

### 二次开发：邮件即达自动唤醒 Agent

后续如果要做“mail 即达自动唤醒 Agent”，建议以当前 WebSocket 回调为入口，而不是再加高频轮询：

- 入口位置：`refreshAfterMailPush(user, mailId)`。
- 推荐流程：
  1. 收到 `mailId`。
  2. 调用 `client.mail.read({ id: mailId, markRead: false })` 读取摘要或完整正文。
  3. 做发件人白名单、主题规则、正文指令解析、附件安全检查。
  4. 写入任务队列或调用 VCP 内部 Agent 调度接口。
  5. 由 Agent 决定是否回复、转发、调用工具或仅记录。
- 安全建议：
  - 自动唤醒只应默认读取，不应默认发送邮件。
  - 自动回复、转发、外部命令执行应接入工具审核。
  - 对附件和正文中的 URL 需要做来源校验，避免邮件触发 SSRF / 任意文件访问链路。
  - 对重复 `mailId` 做幂等去重，避免断线重连或服务端重复推送导致重复执行。

## SDK 不确定性处理

`@clawemail/node-sdk` 当前文档不足。本插件采用防御式候选方法调用：

- 列表：`mail.list`、`mail.search`、`list`、`search`、`emails.list`、`messages.list`
- 读取：`mail.read`、`read`、`emails.read`、`messages.read`、`mail.get`、`get`
- 发送：`mail.send`、`send`、`emails.send`、`messages.send`、`compose.send`
- 回复：`mail.reply`、`reply`、`emails.reply`、`messages.reply`
- 附件：`mail.getAttachment`、`mail.attachment`、`mail.downloadAttachment`、`read.attachment`、`attachments.get`、`attachments.download`

如实际 SDK 方法名不同，请在插件目录运行：

```bash
npm run inspect:sdk
```

然后按输出微调 `VCPClawMail.js` 的候选方法列表或参数结构。

## 设计建议

实际生产中建议采用混合模式：

- 90% 邮件只作为数据：占位符摘要、列表、按需读、按规则下载附件。
- 10% 邮件作为指令：AI 读取正文后决定是否回复、转发、调用外部工具。
- 发邮件属于高风险动作，可在 VCPToolBox 的工具审核配置里为 `VCPClawMail` 增加人工确认规则。