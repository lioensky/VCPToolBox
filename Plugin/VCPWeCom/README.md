# VCPWeCom — VCP 企业微信桥接插件

> 随 VCP 主进程常驻内存，通过 `@wecom/aibot-node-sdk` 维护企微 WebSocket 长连接，收到消息后自动唤醒指定的 AgentAssistant Agent 生成回复并推回企微。复用 VCP 全套基建（会话历史、占线锁、占位符替换、临时工具注入、思维链清理）。

## 功能概览

| 能力 | 说明 |
|---|---|
| **常驻长连接** | 基于 `@wecom/aibot-node-sdk`，SDK 自带认证、心跳保活(30s)、断线重连(指数退避) |
| **消息→Agent 闭环** | 收到企微消息 → 自动唤醒 `config.env` 指定 Agent → 回复推回企微 |
| **多消息类型** | 文本、图片、文件、语音、图文混排(mixed) 均已实现 |
| **引用消息解析** | 群聊中引用图片/文件/文本再 @机器人，自动下载解析被引用内容 |
| **表情包推送** | Agent 回复中包含图片引用(`<img>`/`[图片]`/`![]()`)时，自动下载并通过 `uploadMedia` + `sendMediaMessage` 推送 |
| **两段式流式回复** | 先发"正在思考中…"再发全文，规避 AgentAssistant `stream:false` 硬限制 |
| **工具调用清理** | 自动清理回复中的 `TOOL_REQUEST` 块和工具调用摘要，替换为简洁标记 |
| **主动推送工具** | 提供 `WeComSend` 工具，供其他 Agent 主动向企微用户/群推送消息 |
| **白名单** | 可限制只有指定 userid 能触发 Agent |
| **超时保护** | Agent 推理超时自动回退提示语 |
| **欢迎语** | 用户进入会话时自动发送欢迎语 |

## 架构

```
企微用户 → 企微服务器 →[WS推送]→ VCPWeCom (hybridservice + direct)
                                        ↓ lazy require
                                  AgentAssistant.processToolCall
                                        ↓ HTTP
                              VCP /v1/chat/completions (绑定 agent)
                                        ↓
                                   agent 生成回复
                                        ↓
                              VCPWeCom replyStream 推回企微
                              (+ uploadMedia/sendMediaMessage 推表情包)
```

**协议**：`hybridservice + direct` — VCP 主进程 `require()` 进同进程，零 IPC，随主进程常驻。

## 目录结构

```
VCPWeCom/
├── VCPWeCom.js              # 主入口（~1500 行）
├── plugin-manifest.json     # 插件清单
├── package.json             # 依赖声明
├── config.env               # 真实配置（.gitignore，不提交）
├── config.env.example       # 配置模板
├── README.md                # 本文件
├── .gitignore
└── node_modules/            # 本地依赖
```

## 安装

### 1. 放置插件

将整个 `VCPWeCom` 目录放入 VCP 插件目录（通常为 `VCPToolBox/Plugin/`）：

```bash
cp -r VCPWeCom /path/to/VCPToolBox/Plugin/VCPWeCom
```

### 2. 安装依赖

```bash
cd /path/to/VCPToolBox/Plugin/VCPWeCom
npm install --no-audit --no-fund
```

这会安装 `@wecom/aibot-node-sdk`。

### 3. 文件解析库（可选，处理文件消息需要）

插件通过 `try-require` 从 VCP 根 `node_modules` 加载以下库（不在本插件 package.json 中，避免版本冲突）：

| 库 | 用途 | 安装位置 |
|---|---|---|
| `pdf-parse` | 解析 PDF 文件 | VCP 根 `node_modules` |
| `mammoth` | 解析 Word (.docx) 文件 | VCP 根 `node_modules` |
| `exceljs` | 解析 Excel (.xlsx) 文件 | VCP 根 `node_modules` |
| `mime-types` | MIME 类型推断 | VCP 根 `node_modules` |

如果这些库未安装，文件消息会回退为"暂不支持解析此格式"提示，不影响其他功能。

### 4. 配置 config.env

复制 `config.env.example` 为 `config.env`，填写必填项：

```bash
cp config.env.example config.env
```

```env
WeComBotId=你的机器人ID
WeComBotSecret=你的机器人Secret
WeComBindAgent=你的Agent名称
```

详见下方 [config.env 参数表](#configenv-参数表)。

### 5. 重启 VCP 主进程

VCP 加载时会 `require()` 本插件并调用 `initialize()`。日志出现以下内容即成功：

```
[VCPWeCom] 企微 WebSocket 认证成功
```

## config.env 参数表

### 必填

| 字段 | 说明 |
|---|---|
| `WeComBotId` | 企业微信智能机器人后台获取的 botId |
| `WeComBotSecret` | 企业微信智能机器人后台获取的 secret |
| `WeComBindAgent` | AgentAssistant `config.json` 中某个 agent 的 `chineseName`（精确匹配） |

### 连接与重连

| 字段 | 默认值 | 说明 |
|---|---|---|
| `WeComMaxReconnect` | `-1` | WS 最大重连次数，-1 = 无限重连（生产常驻推荐） |
| `WeComHeartbeatInterval` | `30000` | 心跳间隔毫秒 |

### 回复策略

| 字段 | 默认值 | 说明 |
|---|---|---|
| `WeComStreamReply` | `true` | 两段式流式回复开关（先发提示再发全文） |
| `WeComStreamHint` | `正在思考中…` | 流式中间提示语 |
| `WeComAgentTimeoutMs` | `120000` | Agent 推理超时毫秒，超时回退提示语 |
| `WeComWelcomeText` | (空) | 用户进入会话时的欢迎语，留空不发 |

### 会话与工具

| 字段 | 默认值 | 说明 |
|---|---|---|
| `WeComSessionPrefix` | `wecom` | 传给 AgentAssistant 的 session_id 前缀 |
| `WeComInjectTools` | `VCPWeCom` | 唤醒 Agent 时临时注入的工具组，逗号分隔 |
| `WeComAllowedUsers` | (空) | userid 白名单，逗号分隔；留空 = 不限制 |

### 图片/文件处理

| 字段 | 默认值 | 说明 |
|---|---|---|
| `WeComMaxImageBytes` | `10485760` | 图片大小上限字节(10MB)，超限拒绝处理 |
| `WeComMaxFileBytes` | `26214400` | 文件大小上限字节(25MB)，超限拒绝处理 |
| `WeComFileParseTimeoutMs` | `30000` | 文件解析超时毫秒 |

### 调试

| 字段 | 默认值 | 说明 |
|---|---|---|
| `DebugMode` | `false` | 调试模式，输出详细日志 |

## 消息类型支持

| 消息类型 | 处理方式 |
|---|---|
| **文本** (text) | 直接传给 Agent，群聊自动清理 @机器人 前缀 |
| **图片** (image) | SDK 下载解密 → base64 data URL → 多模态 prompt 喂给 Agent |
| **文件** (file) | SDK 下载解密 → 按类型解析为文本(PDF/Word/Excel/纯文本) → 文本 prompt；图片扩展名走图片路径 |
| **语音** (voice) | SDK 已转文本 → 当文本处理 |
| **图文混排** (mixed) | 遍历子项，文本拼接 + 图片转 data URL → 多模态 prompt |
| **视频** (video) | 暂不支持，回复提示语 |

### 引用消息（群聊场景）

群聊中用户可以引用一条历史消息再 @机器人。插件会自动解析 `body.quote` 字段：

| 引用类型 | 处理方式 |
|---|---|
| 文本引用 | 下载文本 → 拼入 prompt |
| 图片引用 | 下载解密图片 → 多模态 prompt |
| 文件引用 | 下载解密 → 解析为文本 → 拼入 prompt |
| 图文混排引用 | 遍历子项分别处理 → 多模态 prompt |
| 语音引用 | 取 SDK 转写的文本 → 拼入 prompt |

> **注意**：企微引用消息的 url + aeskey 有 5 分钟有效期，超时后下载会失败并提示用户。

## 表情包推送

当 Agent 回复中包含图片引用时，插件会自动下载图片并推送到企微。

### 支持的图片引用格式

插件识别 Agent 输出中的三种图片引用格式：

```
1. <img src="http://example.com/img/emoji.png" width="150">
2. [图片]http://example.com/img/emoji.png
3. ![alt文本](http://example.com/img/emoji.png)
```

### 处理流程

1. 正则匹配所有图片引用
2. 并行下载图片（支持 http/https，自动处理中文路径编码）
3. 文本部分通过 `replyStream` 发送（finish=true）
4. 图片部分通过 `uploadMedia` + `sendMediaMessage` 主动推送

> **为什么图片不用 `replyStream` 的 `msgItem`？** 实测发现两段式流式回复（先 finish=false 再 finish=true）时，企微服务端会丢弃第二段的 `msg_item`，导致图片不显示。因此改为文本走 `replyStream`、图片走主动推送的方式。

### 限制

- 单条消息最多 10 张图片（企微限制）
- 仅支持 JPG/PNG，GIF/WebP/BMP 会被跳过
- 单张图片 ≤ 10MB
- 下载失败的图片会替换为 `[表情包加载失败]` 文本

### 配合 VCP ImageServer

如果 VCP 配置了 ImageServer 插件（静态文件服务），Agent 可以在回复中输出类似以下格式的图片引用：

```
<img src="{{VarHttpUrl}}:{{Port}}/pw={{Image_Key}}/images/表情包目录/表情文件.png">
```

VCP 变量替换后变为实际 URL，插件下载图片并推送到企微。

## 工具调用清理

Agent 回复中可能残留 VCP 内部协议语法，插件会自动清理：

| 原文 | 替换为 |
|---|---|
| `<<<[TOOL_REQUEST]>>>...<<<[END_TOOL_REQUEST]>>>` | `【调用 xxx 工具】`（提取 tool_name）或 `【工具调用】` |
| `[本轮工具调用摘要:]...[本轮工具调用摘要结束]`（含"失败/错误/异常"） | `❎️调用失败` |
| `[本轮工具调用摘要:]...[本轮工具调用摘要结束]`（成功） | `✅️调用成功` |

## 主动推送工具

### WeComSend

其他 Agent 可通过 tool_request 调用本插件主动推送消息：

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」VCPWeCom「末」,
command:「始」WeComSend「末」,
target:「始」zhangsan「末」,
content:「始」这是一条来自 VCP 的主动推送消息。「末」
<<<[END_TOOL_REQUEST]>>>
```

- `target`：企微 userid（单聊）或 chatid（群聊）
- `content`：消息内容，支持 Markdown

### status

查询插件运行状态：

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」VCPWeCom「末」,
command:「始」status「末」
<<<[END_TOOL_REQUEST]>>>
```

返回 WS 连接状态、消息收发统计、AgentAssistant 加载状态、文件解析库可用性等。

## 消息处理流程

以文本消息为例：

1. 企微用户发文本消息 → SDK 触发 `message.text` 事件
2. `handleTextMessage(frame)`：
   - 白名单过滤（不在白名单的忽略）
   - 若 `WeComStreamReply=true`：先 `replyStream(frame, streamId, "正在思考中…", false)`
   - 若有引用消息(`body.quote`)：下载解析被引用内容，拼入 prompt
3. lazy `require('../AgentAssistant/AgentAssistant.js')`，调 `processToolCall({agent_name, prompt, maid, session_id, inject_tools})`
4. AgentAssistant 内部：加载会话历史 → 拼 system prompt → 调 VCP `/v1/chat/completions`（stream:false）→ 清理思维链 → 返回文本
5. `sendReply(frame, streamId, replyText, runtimeConfig)`：
   - 清理 `TOOL_REQUEST` 块和工具调用摘要
   - 提取并下载图片引用 → 剥离图片标签
   - `replyStream(frame, streamId, 全文, true)` 推文本
   - `uploadMedia` + `sendMediaMessage` 推图片（如有）

### 会话隔离

| 场景 | session_id |
|---|---|
| 单聊 | `wecom_<userid>` |
| 群聊 | `wecom_group_<chatid>` |

前缀可通过 `WeComSessionPrefix` 配置。

### 自动复用的 AgentAssistant 基建

- ✅ 会话历史（按 session_id 隔离）
- ✅ 占线锁（同一 Agent 同时只处理一个请求）
- ✅ `{{MaidName}}` / `{{Date}}` 占位符替换
- ✅ `inject_tools` 临时工具注入
- ✅ 思维链清理（`removeVCPThinkingChain`）
- ✅ Agent 配置（systemPrompt、modelId、temperature、maxOutputTokens）

## 故障排查

| 现象 | 排查 |
|---|---|
| 启动日志无 `认证成功` | 检查 `WeComBotId`/`WeComBotSecret` 是否正确；检查网络能否访问 `wss://openws.work.weixin.qq.com` |
| 启动日志报 `配置缺失` | `config.env` 必填项未填（WeComBotId/WeComBotSecret/WeComBindAgent） |
| 启动日志报 `加载 @wecom/aibot-node-sdk 失败` | 在插件目录运行 `npm install` |
| 启动日志报 `文件解析库均未加载` | 在 VCP 根目录安装 pdf-parse/mammoth/exceljs/mime-types（可选，仅影响文件消息） |
| 消息无回复 | 查 `WeComAllowedUsers` 白名单；查日志是否报 `AgentAssistant 服务未就绪` |
| 回复很慢/超时 | 调大 `WeComAgentTimeoutMs`；查 AgentAssistant 该 Agent 的占线锁是否被占 |
| 表情包不显示 | 查日志 `图片推送失败`；确认图片 URL 在 VCP 服务器上可访问；确认格式是 JPG/PNG |
| 引用消息提示"链接已过期" | 企微引用 url+aeskey 有 5 分钟有效期，超时无法下载 |
| WS 反复断连重连 | 检查是否有其他程序用同一个 botId 抢连接（一个 bot 只能维持一个 WS 连接） |

## 已知限制

- **非原生流式**：AgentAssistant `processToolCall` 内部 `stream:false`，本插件用两段式 replyStream 规避。原生流式需改 AgentAssistant 源码。
- **单条回复 ≤20480 字节**：超长截断到 20000 字节并加后缀提示。
- **单 Agent 绑定**：所有消息都唤醒同一个 Agent。多 Agent 路由需扩展 `WeComBindAgent` 为路由规则。
- **单 bot 连接**：`@wecom/aibot-node-sdk` 维护单 bot 长连接，同一 botId 不能被两个进程同时使用。
- **视频消息**：暂不支持，只回复提示语。

## 技术参考

- [@wecom/aibot-node-sdk](https://github.com/WecomTeam/aibot-node-sdk) — 企业微信官方 Node.js SDK
- VCP 插件开发手册 — `hybridservice + direct` 协议规范
- AgentAssistant `processToolCall` 接口 — Agent 唤醒与会话管理

## License

MIT
