# VCP OneBot Adapter

VCP ChannelHub 的 QQ 机器人适配器，通过 OneBot 11 协议连接 QQ。

## 支持的 OneBot 实现

- [go-cqhttp](https://github.com/Mrs4s/go-cqhttp) (推荐)
- [NapCat](https://github.com/NapNeko/NapCatQQ)
- [LLOneBot](https://github.com/LLOneBot/LLOneBot)
- [Lagrange.OneBot](https://github.com/LagrangeDev/Lagrange.Core)

## 功能特性

- ✅ 私聊消息收发
- ✅ 群聊消息收发 (需 @机器人)
- ✅ 图片消息支持
- ✅ 文件消息支持
- ✅ 语音消息支持
- ✅ B2 协议集成 (ChannelEventEnvelope)
- ✅ 自动重连
- ✅ 会话管理

## 快速开始

### 1. 安装依赖

```bash
cd Plugin/vcp-onebot-adapter
npm install
```

### 2. 配置

复制配置模板：

```bash
cp .env.example .env
```

编辑 `.env` 文件，配置 OneBot 连接信息和 VCP ChannelHub 地址：

```env
# OneBot WebSocket 地址
ONEBOT_WS_URL=ws://127.0.0.1:3001

# VCP ChannelHub 地址
VCP_CHANNEL_HUB_URL=http://127.0.0.1:6010/internal/channel-hub/events

# 适配器 ID
VCP_ADAPTER_ID=onebot-qq-main

# ChannelHub 桥接密钥
VCP_CHANNEL_BRIDGE_KEY=your-bridge-key
```

### 3. 启动 OneBot 实现

以 go-cqhttp 为例：

1. 下载并运行 go-cqhttp
2. 配置 `config.yml`，启用 WebSocket 服务：

```yaml
servers:
  - ws:
      host: 127.0.0.1
      port: 3001
```

### 4. 启动适配器

```bash
npm start
```

## 配置说明

### OneBot 连接配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `ONEBOT_WS_URL` | OneBot WebSocket 地址 | `ws://127.0.0.1:3001` |
| `ONEBOT_ACCESS_TOKEN` | access_token (可选) | 空 |

### VCP ChannelHub 配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `VCP_CHANNEL_HUB_URL` | ChannelHub B2 事件入口 | `http://127.0.0.1:6010/internal/channel-hub/events` |
| `VCP_ADAPTER_ID` | 适配器唯一标识 | `onebot-qq-main` |
| `VCP_CHANNEL_BRIDGE_KEY` | 桥接密钥 | 空 |

### Agent 配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `VCP_AGENT_NAME` | 默认 Agent 名称 | `Nova` |
| `VCP_AGENT_DISPLAY_NAME` | Agent 显示名称 | `Nova` |

### 平台能力配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `ONEBOT_SUPPORTS_IMAGE` | 是否支持图片 | `true` |
| `ONEBOT_SUPPORTS_FILE` | 是否支持文件直发 | `false` |
| `ONEBOT_SUPPORTS_AUDIO` | 是否支持语音 | `true` |
| `ONEBOT_MAX_MESSAGE_LENGTH` | 最大消息长度 | `4500` |

## 架构

```
┌─────────────────┐     WebSocket      ┌──────────────────┐
│   OneBot 实现    │◄──────────────────►│  OneBot Client   │
│ (go-cqhttp/     │                    │  (client.js)     │
│  NapCat/...)    │                    └────────┬─────────┘
└─────────────────┘                             │
                                                ▼
┌─────────────────┐     HTTP/B2        ┌──────────────────┐
│  VCPToolBox     │◄──────────────────►│  VCP Channel     │
│  ChannelHub     │                    │  Client          │
└─────────────────┘                    │  (channelClient.js)│
                                       └──────────────────┘
```

## 消息流程

1. **入站消息**
   - OneBot 实现接收 QQ 消息
   - 通过 WebSocket 推送到适配器
   - 适配器转换为 `ChannelEventEnvelope` (B2 协议)
   - 发送到 VCP ChannelHub
   - ChannelHub 调用 AI 运行时处理
   - 返回 `ChannelRuntimeReply`
   - 适配器将回复发送回 QQ

2. **消息格式转换**
   - OneBot 消息段 → B2 content parts
   - 文本、图片、文件、语音等类型自动转换

## 开发

### 项目结构

```
Plugin/vcp-onebot-adapter/
├── src/
│   ├── index.js              # 入口
│   ├── adapters/
│   │   ├── onebot/
│   │   │   └── client.js     # OneBot WebSocket 客户端
│   │   └── vcp/
│   │       └── channelClient.js  # VCP ChannelHub 客户端
│   ├── core/
│   │   └── pipeline.js       # 消息处理管道
│   └── utils/
│       └── logger.js         # 日志工具
├── plugin-manifest.json      # 插件清单
├── package.json
├── .env.example
└── README.md
```

### 运行测试

```bash
npm test
```

### 调试模式

设置日志级别：

```env
LOG_LEVEL=debug
```

## 注意事项

1. **群消息触发**: 群聊中需要 @机器人 才会触发回复
2. **消息长度**: QQ 消息有长度限制 (约 4500 字)，超长消息会被截断
3. **图片限制**: 单次回复最多发送 5 张图片
4. **文件支持**: QQ 不太支持直接发送文件，会转换为文本链接

## 故障排查

### 连接失败

1. 检查 OneBot 实现是否正常运行
2. 检查 WebSocket 地址是否正确
3. 检查 access_token 是否匹配

### 消息无响应

1. 检查群消息是否 @ 了机器人
2. 检查 VCP ChannelHub 是否正常运行
3. 查看日志中的错误信息

## License

MIT
