# VCP × 钉钉 Adapter

一个用于连接 **钉钉企业内部应用机器人（Stream 模式）** 与 **VCPChat / VCP 后端运行时** 的轻量桥接服务。

当前项目已经不只是最初的“一问一答文本转发器”，而是进入了 **B1 Bridge 模式**：

> **钉钉收消息 → 本地 Adapter → VCPChat 本地 bridge → Topic / History / Runtime → sessionWebhook 回钉钉**

这意味着钉钉现在可以被视作 **VCP 的另一个外部前端入口**。

---

## 1. 当前状态概览

### 已实现
- 使用 **钉钉 Stream 模式** 接收机器人消息
- 支持 **单聊 / 群聊**
- 群聊中仅处理 **@机器人** 的文本消息
- 使用 **本地 bridge（B1）** 而不是旧的纯 OpenAI 兼容入口
- 已接入 VCPChat 主进程运行时：
  - topic binding
  - history 持久化
  - 话题上下文续聊
- 已验证：
  - **续聊记忆**
  - **新建话题**
  - **切换话题**
- 已支持区分：
  - `agentId`（真实内部身份）
  - `agentName` / `agentDisplayName`（展示名）

### 当前仍未完全收口
- `DailyNote` 触发状态回传仍在补强中

### 已完成（2026-03-20）
- ✅ sessionWebhook 失效后的 OpenAPI 主动发送兜底（单聊 `privateMessages/send`）
- ✅ 单聊图片/文件发送（`sendSingleImage` / `sendSingleFile`，使用 OpenAPI `privateMessages/send`）
- ✅ 互动卡片发送与回调处理（`sendInteractiveCard` + `onCardAction`）
  - VCP 返回 `options` 时自动展示按钮卡片
  - 用户点击按钮后作为回复转发给 VCP
  - 支持多轮选项交互
- ✅ **图片/文件消息接收与转发**（新增）
  - 支持接收钉钉用户发送的图片消息（`picture` 类型）
  - 支持接收钉钉用户发送的文件消息（`file` 类型）
  - 支持接收钉钉用户发送的语音消息（`voice` 类型）
  - 自动提取 `picURL` / `downloadCode` 并转发给 VCP
  - VCP 可识别多模态内容并处理

---

## 2. 当前链路架构

### 2.1 B1 Bridge 模式（当前主路径）

```text
钉钉用户发消息
   ↓
钉钉 Stream SDK
   ↓
streamReceiver.js
   ↓
normalizer.js
   ↓
pipeline.js
   ↓
src/adapters/vcp/client.js
   ↓
POST http://127.0.0.1:6010/internal/channel-ingest
   ↓
VCPChat LocalChannelBridgeServer
   ↓
ChannelBridgeHandler
   ↓
ChatRuntimeService
   ↓
Topic / History / Binding / Runtime
   ↓
结构化 reply
   ↓
sender.js
   ↓
sessionWebhook 回复当前钉钉会话
```

### 2.2 旧模式（保留为回退）
仍保留旧的兼容方式：

```text
VCP_BASE_URL + VCP_CHAT_PATH
```

但现在默认推荐且优先使用的是：

```text
VCP_USE_CHANNEL_BRIDGE=true
```

---

## 3. 当前能力边界

### 3.1 已验证成功的能力
- **文本输入 / 文本输出**
- **会话绑定**
  - `dingtalk:group:{conversationId}:{senderStaffId}`
- **话题持久化**
- **当前 topic 历史写入**
- **续聊记忆**
- **新建话题**
- **切换到已有话题**
- **列出话题（bridge 侧已具备基础支持）**
- **身份归一化**
  - 避免把显示名错误当成真实 `agentId`

### 3.2 当前记忆策略
当前表现更接近：

> **宽松记忆型多话题系统**

也就是：
- 当前会话会绑定到一个明确的 topic
- 但模型仍可能“记得以前别的话题发生过什么”

这是一种更接近真人的交互表现，而不是绝对隔离的无记忆切页。

---

## 4. 目录结构

```text
vcp-dingtalk-adapter/
├─ package.json
├─ .env
├─ .env.example
├─ .gitignore
├─ README.md
└─ src/
   ├─ index.js
   ├─ adapters/
   │  ├─ dingtalk/
   │  │  ├─ streamReceiver.js
   │  │  └─ sender.js
   │  └─ vcp/
   │     └─ client.js
   └─ core/
      ├─ normalizer.js
      └─ pipeline.js
```

---

## 5. 运行前提

### 5.1 钉钉侧
你需要准备一个 **企业内部应用机器人**，并开启：

- 机器人能力
- **Stream 模式**
- 将机器人加入测试群

你需要从钉钉开放平台获取：

- `DING_APP_KEY`
- `DING_APP_SECRET`

### 5.2 VCPChat 侧
你需要运行一个带本地 bridge 的 **VCPChat 主进程**。

当前 bridge 健康检查地址为：

```text
GET http://127.0.0.1:6010/healthz
```

正常返回：

```json
{"ok": true}
```

---

## 6. 环境要求

- Node.js >= 18
- npm 可用
- VCPChat 主进程已启动
- 钉钉应用已正确配置 Stream 机器人能力

---

## 7. 安装

进入项目目录：

```bash
cd ../../Plugin/vcp-dingtalk-adapter
```

安装依赖：

```bash
npm install
```

如果没有装钉钉 Stream SDK，请确认安装：

```bash
npm install dingtalk-stream
```

---

## 8. 配置

复制环境变量模板：

```bash
copy .env.example .env
```

或手动创建 `.env`。

### 当前推荐 `.env` 示例

```env
DING_APP_KEY=your_app_key
DING_APP_SECRET=your_app_secret

# 官方 npm 包
DING_STREAM_SDK_PACKAGE=dingtalk-stream

# 优先使用 VCPChat 本地 bridge（B1）
VCP_USE_CHANNEL_BRIDGE=true
VCP_CHANNEL_BRIDGE_URL=http://127.0.0.1:6010/internal/channel-ingest
VCP_CHANNEL_BRIDGE_KEY=

# 真实 agentId（重要：这里应填 VCPChat 内部真实 agentId，而不是显示名）
VCP_AGENT_NAME=_Agent_1773759150841_1773759150841

# 展示名（可选，但推荐填写）
VCP_AGENT_DISPLAY_NAME=Coffee

# 回退配置 / bridge 内部回源配置
VCP_BASE_URL=http://127.0.0.1:6005
VCP_CHAT_PATH=/v1/chat/completions
VCP_API_KEY=your_vcp_api_key
VCP_MODEL=gemini-3-flash
VCP_TIMEOUT_MS=120000

DING_DEBUG_RAW_EVENT=false
VCP_DEBUG_RAW_RESPONSE=false
VCP_DEBUG_RICH_REPLY=false
LOG_LEVEL=info
```

---

## 9. 一个关键概念：agentId 与 agentName

这次接入中最重要的经验之一：

### `agentId`
用于：
- 找 `Agents/{agentId}/config.json`
- 找 `UserData/{agentId}/topics/...`
- 进行 topic / history / binding 持久化

### `agentName` / `agentDisplayName`
用于：
- 展示
- 输出中的人格称呼
- 钉钉端的人类可读名称

### 错误示例
把：

```text
Coffee
```

直接拿去当 `agentId`

会导致：
- 找不到真实配置
- 生成影子 Agent
- 出现两个同名 Coffee
- 历史写错目录

### 正确示例
```env
VCP_AGENT_NAME=_Agent_1773759150841_1773759150841
VCP_AGENT_DISPLAY_NAME=Coffee
```

---

## 10. 启动

开发模式：

```bash
npm run dev
```

生产模式：

```bash
npm start
```

如果一切正常，你会看到类似：

```text
[INFO] vcp-dingtalk-adapter started
connect success
```

---

## 11. 当前消息流与数据形态

### 标准化后的内部消息
```js
{
  messageId,
  conversationId,
  conversationTitle,
  userId,
  senderNick,
  senderCorpId,
  isAdmin,
  chatType,               // single | group
  messageType,
  text,
  isAt,
  isFromSelf,
  robotCode,
  sessionWebhook,
  sessionWebhookExpiredTime,
  raw
}
```

### Bridge 请求中的关键字段
```json
{
  "channel": "dingtalk",
  "agentId": "_Agent_1773759150841_1773759150841",
  "agentName": "Coffee",
  "itemType": "agent",
  "itemId": "_Agent_1773759150841_1773759150841",
  "topicControl": {
    "bindingKey": "dingtalk:group:cidxxx:useryyy"
  }
}
```

---

## 12. 当前已验证通过的行为

### 12.1 续聊
后续提问会接着同一话题上下文回答。

### 12.2 新建话题
例如：

```text
我们新开一个“钉钉接入调试”话题
```

已验证：
- 创建新 topic
- 更新 binding
- 写入新 topic 的 history

### 12.3 切回已有话题
例如：

```text
切回“主要对话”话题
```

已验证：
- binding 切回 `default`
- 后续消息写回 `default/history.json`

---

## 13. 当前约束与已知限制

### 13.1 群消息约束
当前逻辑中：

- 单聊：直接处理
- 群聊：只有 `isInAtList === true` 时才处理

这样可以避免机器人在群里乱回复。

### 13.2 当前以文本为主
当前已稳定：
- 文本输入
- 文本输出

多媒体桥接仍在后续阶段。

### 13.3 sessionWebhook 优先 + OpenAPI 兜底
当前回复依赖：

- `sessionWebhook`（优先，快速路径）
- `sessionWebhookExpiredTime`

如果 webhook 失效，已实现 OpenAPI 主动发送兜底（单聊 `privateMessages/send`）。

### 13.4 DailyNote 状态回传仍在补强
当前 bridge 已开始尝试检测 `DailyNote` 是否触发，但状态回传仍属于增强中能力。

---

## 14. 常见问题

### Q1：收不到消息
请检查：

- 机器人是否是 **企业内部应用机器人**
- 是否开启了 **Stream 模式**
- 是否已经把机器人加入群
- 群里是否真的 **@ 了机器人**
- `DING_APP_KEY / DING_APP_SECRET` 是否正确

### Q2：bridge 连不上
请检查：

```text
http://127.0.0.1:6010/healthz
```

如果返回 `ERR_CONNECTION_REFUSED`，说明：
- VCPChat 主进程没启动
- 或本地 bridge 没成功加载

### Q3：出现两个同名 Agent
大概率是把显示名误当 `agentId` 使用导致的。

请检查：
- `VCP_AGENT_NAME` 是否填了真实 agentId
- 是否误生成了影子目录：
  - `AppData/Agents/Coffee`
  - `AppData/UserData/Coffee`

### Q4：新建话题口头成功但实际没切
现在这个问题已经修复过。若再次出现，请优先检查：
- `channel_bindings/dingtalk.json`
- 真实 `topics/` 目录里是否产生新 topic
- adapter 是否仍在用真实 `agentId`

---

## 15. 当前成果总结

当前钉钉接入已经不再是最初的一期 MVP 文本转发，而是一个：

> **可工作的 VCP 外部前端入口雏形**

它已经具备：
- 钉钉接入
- 本地 bridge
- 话题绑定
- history 落盘
- 续聊记忆
- 新建话题
- 切换话题
- 身份归一化
- 钉钉风格输出收敛

---

## 16. 下一阶段计划

### 下一步优先级
1. **补全 DailyNote 状态回传**
2. **把"列出/切换已有话题"能力做得更完整**
3. ~~**补图片 / 文件 → 钉钉附件桥接**~~ ✅ 已完成（2026-03-20）
4. ~~**补 sessionWebhook 失效兜底**~~ ✅ 已完成
5. ~~**补互动卡片**~~ ✅ 已完成

---

## 17. 推荐当前测试指令

你可以直接在钉钉里测试：

```text
列出一下所有话题
```

```text
切回“主要对话”话题
```

```text
我们新开一个“钉钉接入调试”话题
```

```text
你还记得之前钉钉接入调试话题里的内容吗？
```

---

## 18. 说明

这个项目现在的定位是：

```text
钉钉 ←→ Adapter ←→ VCPChat Local Bridge ←→ Runtime / Topic / History
```

它已经不是单纯的 HTTP 文本转发器，而是**VCP 多前端体系中的一个外部渠道前端**。

如需继续推进，推荐下一步：

> **继续做话题列表 / 切换体验增强，再补 DailyNote 可观测性。**