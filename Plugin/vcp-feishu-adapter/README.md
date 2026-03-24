# VCP 飞书适配器

本适配器用于将飞书的消息桥接到 VCPToolBox 统一多端接入中台。

## 功能特性

- 支持飞书回调模式接收消息
- 支持文本、图片、文件、语音等消息类型
- 支持群聊和单聊
- 支持消息回复
- 支持互动卡片
- 支持与 VCP ChannelHub B2 协议集成

## 环境配置

```env
# 飞书配置
FEISHU_APP_ID=your_app_id
FEISHU_APP_SECRET=your_app_secret
# 可选：回调服务器配置
FEISHU_CALLBACK_URL=http://your-server:6091/webhook

# VCP ChannelHub 配置（优先使用 B2 协议）
VCP_CHANNEL_HUB_URL=http://127.0.0.1:6010/internal/channel-hub/events
VCP_CHANNEL_ADAPTER_ID=feishu-main
VCP_CHANNEL_BRIDGE_KEY=your_adapter_secret

# 回退配置
VCP_USE_CHANNEL_BRIDGE=true
VCP_CHANNEL_BRIDGE_URL=http://127.0.0.1:6010/internal/channel-ingest

# VCP 基础配置
VCP_BASE_URL=http://127.0.0.1:6005
VCP_CHAT_PATH=/v1/chat/completions
VCP_API_KEY=your_vcp_api_key
VCP_MODEL=your_model
VCP_TIMEOUT_MS=120000

# Agent 配置
VCP_AGENT_NAME=your_agent_id
VCP_AGENT_DISPLAY_NAME=YourAgent

# 日志
LOG_LEVEL=info
```

## 启动方式

```bash
cd vcp-feishu-adapter
npm install
npm start
```

## 飞书配置步骤

1. 登录飞书开放平台
2. 创建企业自建应用
3. 获取 app_id 和 app_secret
4. 配置应用权限（消息相关权限）
5. 创建事件订阅（接收消息权限）
6. 设置回调地址

## 消息映射

| 飞书消息类型 | VCP 消息格式 |
|-------------|-------------|
| text | text |
| image | image_url |
| file | file |
| audio | audio_url |
| interactive | 卡片交互 |

## 调试

设置环境变量启用调试：

```env
LOG_LEVEL=debug
VCP_DEBUG_RAW_RESPONSE=true
```