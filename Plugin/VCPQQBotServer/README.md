# VCPQQBotServer

VCPQQBotServer 是一个 VCP `hybridservice` 插件，用于把腾讯 QQBot 单聊接入 VCP 主服务器。

当前版本优先实现 **QQ 单聊 C2C 闭环**：

```text
QQ 用户单聊
  -> QQBot Gateway WebSocket
  -> VCPQQBotServer
  -> VCP 主服务器 /v1/chat/completions 非流请求
  -> VCP 工具循环 / 记忆 / RAG / 预处理器
  -> AI 普通自然语言回复
  -> VCPQQBotServer 自动拆分文本与图片
  -> QQ 单聊文本 / 图片消息
```

AI 不需要通过工具调用来“回复 QQ”。AI 只要正常输出自然语言即可；插件会自动把非流式回复发送回 QQ 用户。

---

## 文件结构

```text
Plugin/VCPQQBotServer/
├── plugin-manifest.json      # VCP 插件声明
├── VCPQQBotServer.js         # 主实现：QQ Gateway + VCP Chat 桥接 + QQ 回复发送
├── config.env.example        # 配置模板
├── ws链接qqbot文档.md        # QQBot WebSocket 官方文档摘录
└── bot-node-sdk-main/        # 腾讯官方 Node SDK 源码参考
```

---

## 已实现能力

### 1. QQ 单聊 Gateway 接入

插件启动后会：

1. 读取 `QQAppID` 与 `QQAppSecret` / `QQBotToken`。
2. 请求 QQBot Gateway 地址。
3. 建立 WebSocket。
4. 处理 `Hello`、`Identify`、`Heartbeat`、`Heartbeat ACK`、`Reconnect`、`Invalid Session`。
5. 监听 `C2C_MESSAGE_CREATE` 单聊事件。

### 2. 直接调用 VCP 主服务器聊天入口

收到 QQ 单聊消息后，插件会直接访问本机 VCP 主服务器：

```text
POST http://127.0.0.1:${PORT}/v1/chat/completions
Authorization: Bearer ${Key}
```

其中 `PORT` 和 `Key` 由 VCP 插件系统自动注入，不需要在插件配置中重复填写。

请求固定为非流式：

```json
{
  "messages": [],
  "stream": false,
  "user": "qq_c2c_${openid}"
}
```

这意味着 QQ 单聊可以直接使用 VCP 原有能力，包括：

- VCP 工具协议文本解析
- 同步 / 异步工具调用
- 记忆与 RAG
- 消息预处理器
- 占位符系统
- 模型路由与主服务器配置

### 3. AI 普通回复自动转 QQ 消息

AI 正常输出文本即可，例如：

```text
已经完成了，这是生成结果：

![图片](http://127.0.0.1:5890/pw=xxx/images/demo.png)

如果还需要修改风格，我可以继续处理。
```

插件会自动切成：

1. QQ 文本消息：`已经完成了，这是生成结果：`
2. QQ 图片消息：`demo.png`
3. QQ 文本消息：`如果还需要修改风格，我可以继续处理。`

### 4. 图片 URL 自动识别

非流式 AI 回复中会识别三类图片写法：

#### 裸 URL

```text
http://127.0.0.1:5890/pw=xxx/images/a.png
```

#### Markdown 图片

```markdown
![图](http://127.0.0.1:5890/pw=xxx/images/a.png)
```

#### HTML 图片

```html
<img src="http://127.0.0.1:5890/pw=xxx/images/a.png">
```

支持的图片扩展名：

- `.png`
- `.jpg`
- `.jpeg`
- `.gif`
- `.webp`
- `.bmp`

默认策略是调用 QQ C2C 文件接口上传图片 URL，再发送 QQ 图片消息。若 QQ 图片接口失败，会自动回退为文本 URL。

### 5. 文本分段

QQ 文本回复会按 `QQBotMaxReplyChars` 自动分段。

切分优先级：

1. 双换行段落
2. 单换行
3. 中文 / 英文句号、问号、感叹号
4. 硬切字符

连续发送会按 `QQBotSendDelayMs` 间隔等待，降低触发 QQ 频控的概率。

---

## 配置方法

复制配置模板：

```bash
cp Plugin/VCPQQBotServer/config.env.example Plugin/VCPQQBotServer/config.env
```

然后编辑：

```env
QQAppID=
QQAppSecret=
QQBotToken=
QQBotAuthMode=bot_app_token
QQBotSandbox=false
QQBotIntents=GROUP_AND_C2C_EVENT
QQBotModel=
QQBotSystemPrompt=你是接入 QQ 单聊的 VCPQQBot。你正在通过 VCP 主服务器与 QQ 用户聊天。你可以自然聊天，也可以使用 VCP 工具协议完成任务。若回复中包含图片 URL、Markdown 图片或 HTML img 标签，系统会自动转成 QQ 图片发送。回复应适合 QQ 聊天场景，避免一次性输出过长文本。
QQBotAllowList=
QQBotHistoryTurns=8
QQBotMaxReplyChars=1200
QQBotSendDelayMs=800
QQBotRequestTimeoutMs=300000
QQBotImageMode=upload
QQBotUploadImages=true
DebugMode=false
```

---

## 关键配置说明

| 配置项 | 说明 |
|---|---|
| `QQAppID` | QQBot AppID |
| `QQAppSecret` | QQBot Secret 或 Token，默认会参与 `Bot {QQAppID}.{Token}` 鉴权 |
| `QQBotToken` | 可选，填写后优先于 `QQAppSecret` |
| `QQBotAuthMode` | `bot_app_token` 或 `access_token` |
| `QQBotSandbox` | 是否使用沙箱 Gateway 与 API |
| `QQBotIntents` | 单聊至少需要 `GROUP_AND_C2C_EVENT` |
| `QQBotModel` | 发送到 VCP 主服务器的模型名，留空则使用主服务器默认策略 |
| `QQBotSystemPrompt` | QQ 单聊入口专用系统提示词 |
| `QQBotAllowList` | 允许自动聊天的 QQ 用户 openid，逗号分隔；留空允许全部 |
| `QQBotHistoryTurns` | 每个 QQ 单聊会话保留最近多少轮上下文 |
| `QQBotMaxReplyChars` | QQ 文本消息最大分段字符数 |
| `QQBotSendDelayMs` | 连续发送文本 / 图片之间的延迟 |
| `QQBotRequestTimeoutMs` | 调用 VCP 主服务器非流聊天的超时时间 |
| `QQBotImageMode` | `upload` 为尝试转 QQ 图片；`text` 为只发送 URL 文本 |
| `DebugMode` | 输出调试日志 |

---

## 鉴权模式说明

### bot_app_token

默认模式：

```text
Authorization: Bot {QQAppID}.{QQBotToken或QQAppSecret}
Identify token: Bot {QQAppID}.{QQBotToken或QQAppSecret}
```

适用于当前本地官方 SDK 参考实现。

### access_token

```text
Authorization: QQBot {QQBotToken或QQAppSecret}
Identify token: QQBot {QQBotToken或QQAppSecret}
```

如果 QQ 开放平台当前应用要求 AccessToken 模式，可以切换为：

```env
QQBotAuthMode=access_token
QQBotToken=你的AccessToken
```

---

## QQ 开放平台权限

单聊能力依赖：

```text
GROUP_AND_C2C_EVENT
```

对应 intent：

```text
1 << 25
```

如果应用没有该权限，Gateway 可能返回无权限 intent 或直接断开。遇到连接失败时，请先减少 `QQBotIntents`，确认开放平台已开通对应事件订阅权限。

---

## 图片发送说明

当前实现使用新版 QQ C2C 风格接口：

```text
POST /v2/users/{openid}/files
POST /v2/users/{openid}/messages
```

图片发送流程：

1. 从 AI 回复中识别图片 URL。
2. 调用 `/v2/users/{openid}/files`，传入 `file_type=1`、`url`、`srv_send_msg=false`。
3. 从返回中读取 `file_info`。
4. 调用 `/v2/users/{openid}/messages`，使用 `msg_type=7` 和 `media.file_info` 发送图片。
5. 如失败，回退发送 `图片：URL` 文本。

如果腾讯接口字段变化，需要重点检查 `uploadC2CImageByUrl()` 和 `sendC2CImage()`。

---

## 与 VCP 工具调用的关系

QQBot 插件不把“回复 QQ”暴露成必须调用的 VCP 工具。

正确行为：

```text
QQ 用户：帮我生成一张猫猫图
AI：好的，我来生成。
AI：<<<[TOOL_REQUEST]>>> ... 调用生图工具 ...
AI：生成好了：![图](http://...)
插件：自动把文本和图片发回 QQ
```

也就是说：

- 工具调用仍然由 VCP 主服务器文本协议处理。
- QQ 回复由插件在非流式最终结果阶段自动完成。
- AI 不需要显式调用 `VCPQQBotServer` 来发消息。

---

## 状态查看

插件提供动态占位符：

```text
{{VCPQQBotStatus}}
{{VCPQQRecentMessages}}
```

也提供一个只读状态工具：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」VCPQQBotServer「末」,
command:「始」status「末」
<<<[END_TOOL_REQUEST]>>>
```

这个工具仅用于排障查看状态，不用于正常聊天回复。

---

## 常见问题

### 1. 插件启动但不连接 Gateway

检查：

- `QQAppID` 是否填写。
- `QQAppSecret` 或 `QQBotToken` 是否填写。
- `QQBotAuthMode` 是否符合当前开放平台鉴权方式。
- `QQBotSandbox` 是否和应用环境一致。

### 2. Gateway 报 invalid intents 或断开

检查：

- `QQBotIntents` 是否只保留已授权事件。
- 单聊是否已开通 `GROUP_AND_C2C_EVENT`。
- 可先只配置：

```env
QQBotIntents=GROUP_AND_C2C_EVENT
```

### 3. QQ 用户发消息后没有 AI 回复

检查：

- VCP 主服务器是否已启动。
- 插件状态中 `VCP 端口` 是否存在。
- 插件状态中 `VCP Key` 是否为 `FOUND`。
- `QQBotAllowList` 是否限制了当前用户 openid。
- VCP 主服务器 `/v1/chat/completions` 是否能正常非流响应。

### 4. AI 回复了图片 URL，但 QQ 没发图

检查：

- `QQBotImageMode` 是否为 `upload`。
- 图片 URL 是否能被 VCP 服务器本机访问。
- QQ C2C 文件接口是否返回 `file_info`。
- 腾讯接口是否变更了字段或路径。

失败时插件会自动回退发送图片 URL 文本。

### 5. 为什么不是流式回复

当前单聊优先稳定闭环，使用非流式是为了：

- 等 VCP 工具循环完整结束。
- 一次性拿到最终 AI 回复。
- 统一解析文本、Markdown 图片、HTML 图片和裸 URL。
- 按 QQ 消息类型有序发送文本与图片。

后续如果需要“边生成边发 QQ”，可以另做流式适配，但图片解析与工具循环完成时机要更谨慎。

---

## 开发与校验

语法检查：

```bash
node --check Plugin/VCPQQBotServer/VCPQQBotServer.js
```

Manifest 校验：

```bash
node -e "JSON.parse(require('fs').readFileSync('Plugin/VCPQQBotServer/plugin-manifest.json','utf8')); console.log('manifest ok')"
```

重启 VCP 主服务器后，插件会自动被加载。

---

## 当前边界

当前版本聚焦单聊：

- 已实现 `C2C_MESSAGE_CREATE`。
- 暂未实现群聊 `GROUP_AT_MESSAGE_CREATE` 自动回复。
- 暂未实现频道 `AT_MESSAGE_CREATE` 自动回复。
- 暂未实现用户发来的 QQ 图片转 VCP 多模态输入，仅会把附件元数据写入用户消息。
- QQ 图片发送接口按当前新版 C2C 文档经验实现，如平台字段变动需按真实返回调整。

---

## 推荐上线步骤

1. 填写 `config.env`。
2. 确认 QQ 开放平台启用单聊事件。
3. 先设置 `DebugMode=true`。
4. 重启 VCP 主服务器。
5. 通过状态工具或占位符确认 Gateway 已连接。
6. 用白名单 openid 单聊测试纯文本。
7. 测试 VCP 工具调用，例如搜索、文件、图片生成。
8. 测试 AI 回复中的裸图片 URL、Markdown 图片、HTML 图片。
9. 稳定后设置 `DebugMode=false`。