# VCPLog 插件使用说明

## 1. 简介

VCPLog 插件通过 WebSocket 提供一个实时的 VCP (Voice Conversion Plugin / Variable Common Placeholder) 调用信息推送服务。它允许客户端连接并接收 VCP 工具调用的相关日志，同时这些日志也会被记录在服务器端的文件中。

## 2. 配置

插件的行为依赖于以下配置：

*   **`VCP_Key`**: 用于 WebSocket 连接认证的密钥。此密钥需要在您的主 `config.env` 文件中设置，或者在插件自己的 `Plugin/VCPLog/config.env` 文件中定义（如果存在）。插件的 `plugin-manifest.json` 通过 `configSchema` 指定了此配置项。

    示例 (`config.env`):
    ```env
    VCP_Key=your_secret_vcp_key_here
    ```

## 3. 客户端连接

### 3.1. WebSocket 端点与认证

客户端应连接到以下 WebSocket 端点，并将 `VCP_Key` 作为 URL 的一部分：

*   **URL 格式**: `ws://<your_server_address>:<port>/VCPlog/VCP_Key=<your_vcp_key>`
*   如果您的服务器通过反向代理（如 Cloudflare）并启用了 SSL/TLS，则 URL 格式为: `wss://your_domain.com/VCPlog/VCP_Key=<your_vcp_key>`

    **示例**:
    *   如果服务器运行在 `localhost:5890` 且 `VCP_Key` 为 `123456`，则 URL 为:
        `ws://localhost:5890/VCPlog/VCP_Key=123456`
    *   如果通过 Cloudflare 托管在 `your_domain.com` 且 `VCP_Key` 为 `123456`，则 URL 为:
        `wss://your_domain.com/VCPlog/VCP_Key=123456`

如果 `VCP_Key` 不正确或缺失，服务器将拒绝连接。

### 3.2. 客户端连接示例 (JavaScript)

```javascript
// 替换为您的服务器地址和 VCP Key
const vcpKey = 'your_secret_vcp_key_here'; // 从您的配置中获取
// const websocketUrl = `ws://localhost:5890/VCPlog/VCP_Key=${vcpKey}`;
const websocketUrl = `wss://your_domain.com/VCPlog/VCP_Key=${vcpKey}`; // 使用 wss 如果通过 HTTPS 代理

const ws = new WebSocket(websocketUrl);

ws.onopen = function() { // 使用 onopen 标准事件处理
  console.log('Connected to VCPLog WebSocket server!');
  // ws.send('Hello Server!'); // 通常客户端不需要向此服务发送消息
};

ws.onmessage = function(event) { // 使用 onmessage 标准事件处理
  try {
    const message = JSON.parse(event.data);
    console.log('Received from server:', message);
    // 处理服务器推送的消息
    // message.type 会是 'vcp_log' 或 'connection_ack'
    // message.data (对于 vcp_log) 或 message.message (对于 connection_ack) 包含具体内容
    if (message.type === 'vcp_log') {
      // message.data 包含 { tool_name, status, content, source }
      console.log('VCP Log:', message.data);
    } else if (message.type === 'connection_ack') {
      console.log('Connection Acknowledged:', message.message);
    }
  } catch (e) {
    console.error('Error parsing message or message format unexpected:', event.data, e);
  }
};

ws.onclose = function(event) { // 使用 onclose 标准事件处理
  console.log('Disconnected from VCPLog WebSocket server.');
  if (event.wasClean) {
    console.log(`Connection closed cleanly, code=${event.code} reason=${event.reason}`);
  } else {
    // e.g. server process killed or network down
    // event.code is usually 1006 in this case
    console.error('Connection died');
  }
};

ws.onerror = function(error) { // 使用 onerror 标准事件处理
  console.error('WebSocket error:', error.message || error);
};

```
这个示例使用了标准的浏览器 `WebSocket` API，它直接支持通过 URL 传递参数，因此与当前的服务器认证方式兼容，也适用于 HTML 推送的场景。

## 4. 服务器推送消息格式

服务器会向已连接并认证的客户端推送 JSON 格式的消息。

### 4.1. 连接确认

连接成功并认证后，服务器会发送一条确认消息：
```json
{
  "type": "connection_ack",
  "message": "VCPLog connection successful."
}
```

### 4.2. VCP 日志推送

当有 VCP 工具调用相关信息时，服务器会推送以下格式的消息：
```json
{
  "type": "vcp_log",
  "data": {
    "tool_name": "NameOfTheTool", // 工具名称
    "status": "success", // 或 "error"
    "content": "Actual log content or error message from the tool.", // 日志内容
    "source": "stream_loop" // 信息来源的标识
  }
}
```
`data.source` 可以帮助区分日志的上下文，例如：
*   `stream_loop`: 来自流式响应中的工具调用。
*   `stream_loop_error`: 来自流式响应中工具调用的错误。
*   `stream_loop_not_found`: 流式响应中工具未找到。
*   (以及非流式对应的 `non_stream_...` 等)

## 5. 日志文件

所有通过 WebSocket 推送的 VCP 调用信息（以及连接/断开事件）也会被记录在服务器端。
*   **日志文件路径**: `Plugin/VCPLog/log/VCPlog.txt` (相对于项目根目录)
*   **格式**: 每条日志前会带有时间戳。

请确保服务器进程对该路径有写入权限。日志目录和文件会在插件首次加载时自动创建。