# VCP 企业微信适配器

本适配器用于将企业微信的消息桥接到 VCPToolBox 统一多端接入中台。

## 功能特性

- 支持企业微信回调模式接收消息
- 支持文本、图片、文件、语音等消息类型
- 支持群聊和单聊
- 支持消息回复
- 支持与 VCP ChannelHub B2 协议集成

## 环境配置

在 `.env` 文件中配置以下变量：

```env
# 企业微信配置
WECOM_CORP_ID=your_corp_id
WECOM_CORP_SECRET=your_corp_secret
WECOM_AGENT_ID=your_agent_id
# 可选：回调服务器配置
WECOM_CALLBACK_URL=http://your-server:6090/webhook
WECOM_CALLBACK_TOKEN=your_callback_token
WECOM_CALLBACK_ENCODING_AES_KEY=your_encoding_aes_key

# VCP ChannelHub 配置（优先使用 B2 协议）
VCP_CHANNEL_HUB_URL=http://127.0.0.1:6010/internal/channel-hub/events
VCP_CHANNEL_ADAPTER_ID=wecom-main
VCP_CHANNEL_BRIDGE_KEY=your_adapter_secret

# 回退配置（当 ChannelHub 不可用时使用）
VCP_USE_CHANNEL_BRIDGE=true
VCP_CHANNEL_BRIDGE_URL=http://127.0.0.1:6010/internal/channel-ingest

# VCP 基础配置（回退用）
VCP_BASE_URL=http://127.0.0.1:6005
VCP_CHAT_PATH=/v1/chat/completions
VCP_API_KEY=your_vcp_api_key
VCP_MODEL=your_model
VCP_TIMEOUT_MS=120000

# Agent 配置
VCP_AGENT_NAME=your_agent_id
VCP_AGENT_DISPLAY_NAME=YourAgent

# 日志级别
LOG_LEVEL=info
```

## 启动方式

```bash
cd vcp-wecom-adapter
npm install
npm start
```

## 企业微信配置步骤

1. 登录企业微信管理后台
2. 创建自建应用
3. 设置应用接收消息的回调 URL
4. 获取 corp_id、corp_secret、agent_id
5. 配置回调服务器的 token 和 encoding_aes_key

## 消息映射

| 企业微信消息类型 | VCP 消息格式 |
|----------------|-------------|
| text | text |
| image | image_url |
| file | file |
| voice | audio_url |
| event | 事件通知 |

## 调试

设置环境变量启用调试：

```env
LOG_LEVEL=debug
VCP_DEBUG_RAW_RESPONSE=true
```