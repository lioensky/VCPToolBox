# VCPClawMail

VCPClawMail 是面向 claw.163.com / ClawEmail 的 VCPToolBox 混合插件。

它采用 `hybridservice` 形态：

- 常驻服务：周期轮询邮箱，更新 `{{VCPClawMailInbox}}` 占位符。
- 同步工具：允许 AI 调用 `list_recent`、`read_mail`、`send_mail`、`reply_mail`、`download_attachment`。
- 附件链路：AI 可以在正文或 `attachments` 参数里直接写 `https://...` 或 `file://...`，插件会尽量下载/归一化为 SDK 可发送的附件对象。
- 读取链路：读邮件时返回正文、HTML 转 Markdown、图片 URL、附件元数据；后续图片/文档解析可继续交给 VCP 现有工具链处理。

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
ClawMailPollIntervalMs=60000
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