# VCPClawMail

VCPClawMail 是面向 claw.163.com / ClawEmail 的 VCPToolBox 混合插件。

它采用 `hybridservice` 形态：

- 常驻服务：优先使用 WebSocket 即达推送监听新邮件，并用低频轮询兜底更新 `{{VCPClawMailInbox}}`、`{{VCPClawMailInboxMail1}}` 到 `{{VCPClawMailInboxMail4}}` 占位符。
- 同步工具：允许 AI 调用 `list_recent`、`read_mail`、`send_mail`、`reply_mail`、`download_attachment`、`list_folders`、`move_to_trash`。
- 多邮箱分布：保留公共邮箱作为默认邮箱，同时支持 `mail1`、`mail2`、`mail3`、`mail4` 四组 Agent 子邮箱。
- 附件链路：AI 可以在正文或 `attachments` 参数里直接写 `https://...` 或 `file://...`，插件会尽量下载/归一化为 SDK 可发送的附件对象。
- 读取链路：读邮件时返回正文、HTML 转 Markdown、图片 URL、附件元数据；图片附件会尽量转 OpenAI 多模态 `image_url`，文档附件会尽量解析为文本。
- 即达链路：公共邮箱收到 `mailId` 后刷新缓存；子邮箱收到 `mailId` 后会自动读信、处理附件，并通过 AgentAssistant 正常通讯分支投递给绑定 Agent，保留 AA 上下文。

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

# 4 个 Agent 子邮箱：每组同时配置 User 和 Agent 才会启用。
# 子邮箱收到 WebSocket 新邮件后，会自动读取邮件并通过 AgentAssistant 正常通讯分支联系绑定 Agent。
ClawMailSubMail1User=vcp.x1@claw.163.com
ClawMailSubMail1Agent=小助手一
ClawMailSubMail2User=vcp.x2@claw.163.com
ClawMailSubMail2Agent=小助手二
# ClawMailSubMail3User=vcp.x3@claw.163.com
# ClawMailSubMail3Agent=小助手三
# ClawMailSubMail4User=vcp.x4@claw.163.com
# ClawMailSubMail4Agent=小助手四

# 子邮箱自动投递 Agent 时的附件处理上限，以及重复推送幂等保留数量。
ClawMailSubMailAutoMaxAttachments=8
ClawMailSubMailProcessedKeep=500

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
{{VCPClawMailInboxMail1}}
{{VCPClawMailInboxMail2}}
{{VCPClawMailInboxMail3}}
{{VCPClawMailInboxMail4}}
```

`{{VCPClawMailInbox}}` 内容包含公共邮箱与已配置子邮箱的最近邮件摘要、发件人、主题、时间、预览和 `mailId`。

`{{VCPClawMailInboxMail1}}` 到 `{{VCPClawMailInboxMail4}}` 是子邮箱专用占位符，内容包含：

- 子邮箱槽位，例如 `mail1`。
- 绑定 Agent 名称。
- 子邮箱地址。
- 最近邮件摘要。
- 针对该子邮箱调用 `VCPClawMail` 时必须携带的 `mailbox` 参数示例。

## 工具调用示例

### 列出最近邮件

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」VCPClawMail「末」,
command:「始」list_recent「末」,
mailbox:「始」mail1「末」,
limit:「始」10「末」
<<<[END_TOOL_REQUEST]>>>
```

### 读取邮件

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」VCPClawMail「末」,
command:「始」read_mail「末」,
mailbox:「始」mail1「末」,
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
mailbox:「始」mail1「末」,
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
mailbox:「始」mail1「末」,
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
mailbox:「始」mail1「末」,
mailId:「始」邮件ID「末」,
body:「始」已收到，我会尽快处理。「末」,
attachments:「始」https://example.com/sticker.png,file:///H:/VCP/VCPToolBox/image/demo.png「末」
<<<[END_TOOL_REQUEST]>>>
```

`reply_mail` 会在回复前强制读取并标记原邮件为已读，不再让 AI 选择 `markRead`。原因是只要执行回复，就代表当前邮件已经进入处理流程。

`attachments` 是可选字段。如果 AI 想随回复发送表情包、图片、PDF、文档或其他文件，可以把公网 URL 或 `file://` 路径放到 `attachments` 中；多个附件用英文逗号分隔，或使用 JSON 数组。

### 下载附件

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」VCPClawMail「末」,
command:「始」download_attachment「末」,
mailbox:「始」mail1「末」,
mailId:「始」邮件ID「末」,
attachmentId:「始」附件ID「末」
<<<[END_TOOL_REQUEST]>>>
```

返回的 `file://...` 可继续交给后续工具处理。

### 移入垃圾箱

`move_to_trash` 是软删除：它会先通过 `list_folders` 识别真实垃圾箱/已删除文件夹，再调用底层 `client.transport.moveMessages()` 移动邮件。无法稳定识别垃圾箱时会拒绝执行。

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」VCPClawMail「末」,
command:「始」move_to_trash「末」,
mailbox:「始」mail1「末」,
mailId:「始」邮件ID「末」,
confirm:「始」true「末」
<<<[END_TOOL_REQUEST]>>>
```

也可以先查看文件夹：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」VCPClawMail「末」,
command:「始」list_folders「末」,
mailbox:「始」mail1「末」
<<<[END_TOOL_REQUEST]>>>
```

## 管理面板 Agent 信箱

服务器管理面板已新增「Agent & 内容」分类下的「Agent 信箱」页面：

- 查看 VCPClawMail 已配置的公共邮箱与 `mail1` 到 `mail4` 子邮箱。
- 手动刷新邮箱缓存。
- 按邮箱列出最近邮件，可切换数量与“仅未读”。
- 点击邮件读取详情，默认不标记已读、不自动解析附件正文，避免面板查看产生额外副作用。
- 点击“移入垃圾箱”会弹出人工确认，再调用后端软删除接口。
- 面板后端接口位于 `/admin_api/claw-mail/*`，依赖 VCPClawMail 插件已加载。

## 多邮箱与子邮箱自动 Agent 通讯

公共邮箱仍由 `ClawMailUsers` / `ClawMailDefaultUser` 控制；所有工具调用不传 `mailbox` 时都会走公共默认邮箱。

子邮箱由 4 组配置控制：

```env
ClawMailSubMail1User=vcp.x1@claw.163.com
ClawMailSubMail1Agent=小助手一
ClawMailSubMail2User=vcp.x2@claw.163.com
ClawMailSubMail2Agent=小助手二
ClawMailSubMail3User=vcp.x3@claw.163.com
ClawMailSubMail3Agent=小助手三
ClawMailSubMail4User=vcp.x4@claw.163.com
ClawMailSubMail4Agent=小助手四
```

兼容简写变量名，如 `Mail1` / `mail1` + `AgentName1` / `agentname1`，但推荐使用 `ClawMailSubMail*` 命名。

对子邮箱操作时，AI 可以使用以下参数选择具体邮箱：

```text
mailbox:「始」mail1「末」
```

也兼容 `mailAlias`、`mailSlot`、`mail`。如果同时传入 `mailbox` 与 `user`，优先使用 `mailbox` 解析出的真实邮箱。

子邮箱 WebSocket 收到新邮件后，插件会：

1. 刷新公共缓存与子邮箱占位符。
2. 检查该 `mailId` 是否已处理，避免重连/重复推送重复唤醒 Agent。
3. 调用 `read_mail` 内部逻辑读取正文。
4. 将图片附件转为 OpenAI 多模态 `image_url`。
5. 将 TXT、Markdown、CSV、JSON、XML、PDF、DOCX、XLSX 等文档附件尽量解析成文本。
6. 调用 `AgentAssistant.processToolCall()` 的正常通讯分支，不设置 `temporary_contact`，不设置 `task_delegation`，并指定稳定 `session_id`：`vcpclawmail_mailX_AgentName`。
7. AA 因此会自行管理上下文，实现同一子邮箱与同一 Agent 的连续通讯。

自动投递给 Agent 的提示词会包含回复示例：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」VCPClawMail「末」,
command:「始」reply_mail「末」,
mailbox:「始」mail1「末」,
mailId:「始」原邮件ID「末」,
body:「始」你的回复正文「末」,
attachments:「始」https://example.com/sticker.png,file:///H:/VCP/VCPToolBox/image/demo.png「末」
<<<[END_TOOL_REQUEST]>>>
```

其中 `attachments` 是可选字段。Agent 如果想把表情包、图片、生成文件、PDF 或其他文档随回复发给用户，可以把资源 URL 或 `file://` 路径放入 `attachments`。

注意：插件只负责自动读信和投递给 Agent，不会自动发送邮件。是否回复由 Agent 显式调用 `reply_mail` 决定。

## WebSocket 即达与低频轮询兜底

当前实现采用“WebSocket 即达 + 低频轮询兜底”：

1. 初始化时为每个 `ClawMailUsers` 用户创建 `MailClient`。
2. 若 `ClawMailRealtimeEnabled` 未设为 `false`，插件调用 `client.ws.onMessage()` 注册新邮件回调，再调用 `client.ws.connect()` 建立长连接。
3. 收到 `{ mailId }` 后，插件输出日志：

```text
[VCPClawMail] 收到新邮件推送: user=..., mailId=..., time=...
```

4. 推送到达后立即调用 `pollOnce()` 刷新 `{{VCPClawMailInbox}}` 和子邮箱占位符缓存。
5. 如果推送所属邮箱匹配 `mail1` 到 `mail4` 子邮箱配置，会自动进入 Agent 投递链路。
6. 若 WebSocket 断开，插件会按 `1s → 2s → 5s → 10s → 30s → 60s` 指数退避重连。
7. 低频轮询仍会运行，用于兜底处理断线、漏消息、进程重启后的状态校准。

### 邮件即达自动唤醒 Agent 的安全边界

当前“子邮箱即达自动唤醒 Agent”已经实现，入口位置仍为 `refreshAfterMailPush(user, mailId)`。

安全边界：

- 自动唤醒默认只读信、解析附件、投递给 Agent。
- 自动回复、转发、外部命令执行仍必须由 Agent 显式工具调用触发。
- 对重复 `mailId` 做幂等去重，状态保存在 `Plugin/VCPClawMail/data/submail-processed.json`。
- 对子邮箱回复必须带 `mailbox=mail1` 这类槽位参数，避免误用公共邮箱。
- 建议在生产环境继续通过 VCPToolBox 工具审核规则控制高风险发信行为。

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

## 补充调查：删除邮件能力

当前已安装并检查的 SDK 版本为 `@clawemail/node-sdk@0.2.4`。结论是：SDK 没有公开的高级 `delete_mail` / `deleteMessage` / `trashMessage` 邮件删除接口。本插件已实现面向“移入垃圾箱”的 `move_to_trash` 软删除命令与管理面板确认入口。

已确认事实：

- 公开邮件资源 `client.mail` 只提供 `read`、`getAttachment`、`send`、`reply`。
- 运行时检查 `client.mail` 原型方法，也只有 `read`、`getAttachment`、`send`、`reply`，没有 `delete` / `remove` / `trash`。
- 底层 `client.transport` 存在 `moveMessages(ids, target, folder?)`，因此理论上可以通过“移动到垃圾箱文件夹”实现软删除。
- SDK 类型中还出现过 `remove(uid)`，但它属于底层 Ajax/token 相关接口，不是邮件删除 API，不能当作删除邮件能力使用。

已实现方向：

1. 不命名为硬删除；功能名为 `move_to_trash`，兼容别名 `trash_mail` / `trash`。
2. 先调用 `client.transport.listFolders()` 获取真实文件夹列表，查找类似 `Trash`、`Deleted`、`已删除`、`垃圾箱` 的文件夹 id。
3. 找到垃圾箱 folder id 后，再调用 `client.transport.moveMessages([mailId], trashFolderId, sourceFolderId?)`。
4. 如果无法稳定识别垃圾箱 id，会拒绝执行，而不是猜测删除目标。
5. 该功能属于高风险动作；工具调用必须传入 `confirm=true`，管理面板入口也会弹出人工确认。
6. 对自动唤醒 Agent 场景，默认仍只读信和投递，不自动删除；删除必须由显式工具调用或面板用户操作触发。

推荐后续命令设计：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」VCPClawMail「末」,
command:「始」move_to_trash「末」,
user:「始」bot@claw.163.com「末」,
mailId:「始」邮件ID「末」,
confirm:「始」true「末」
<<<[END_TOOL_REQUEST]>>>
```

推荐返回内容应包含：

- 被处理邮箱。
- 被移动的 `mailId`。
- 源文件夹 id。
- 目标垃圾箱 folder id。
- SDK 调用结果。
- 是否刷新了 `{{VCPClawMailInbox}}` 缓存。