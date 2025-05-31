# VCPLog 插件使用说明

## 1. 简介

VCPLog 插件通过 WebSocket 提供一个实时的 VCP (Voice Conversion Plugin / Variable Common Placeholder) 调用信息推送服务。它允许客户端连接并接收 VCP 工具调用的相关日志，同时这些日志也会被记录在服务器端的文件中，并且可以选择性地推送到 Gotify 服务器以实现即时通知。

## 2. 配置

插件的行为依赖于以下配置项。这些配置项应在插件目录 `Plugin/VCPLog/`下的 `config.env` 文件中设置。你可以复制同目录下的 `config.env.example` 文件并修改。

*   **`VCP_Key`** (字符串, 必需)
    *   描述: 用于 WebSocket 连接认证的密钥。
    *   示例: `VCP_Key=your_secret_vcp_key_here`

*   **`Enable_Gotify_Push`** (布尔值, 可选, 默认为 `false`)
    *   描述: 是否启用 Gotify 推送功能。设置为 `true` 以启用。
    *   示例: `Enable_Gotify_Push=true`

*   **`Gotify_Url`** (字符串, 条件性必需)
    *   描述: 你的 Gotify 服务器的完整 URL。如果 `Enable_Gotify_Push` 设置为 `true`，则此项为必需。
    *   示例: `Gotify_Url=https://gotify.example.com` 或 `Gotify_Url=http://localhost:8080`

*   **`Gotify_App_Token`** (字符串, 条件性必需)
    *   描述: 你在 Gotify 中为此插件/应用生成的 App Token。如果 `Enable_Gotify_Push` 设置为 `true`，则此项为必需。
    *   示例: `Gotify_App_Token=Axxxxxxxxxxxxxx`

*   **`Gotify_Priority`** (整数, 可选)
    *   描述: 推送到 Gotify 消息的优先级。具体数值请参考 Gotify 文档。如果未设置，插件将使用默认优先级 (例如 2)。
    *   示例: `Gotify_Priority=5`

*   **`DebugMode`** (布尔值, 可选)
    *   描述: 此插件会遵循项目根目录 `config.env` 中的全局 `DebugMode` 设置。如果需要在插件级别覆盖此设置（不推荐，除非有特殊需求），可以在此插件的 `config.env` 中设置 `DebugMode=true` 或 `DebugMode=false`。

请参考 `Plugin/VCPLog/config.env.example` 文件获取详细的配置格式和说明。

## 3. 客户端连接

### 3.1. WebSocket 端点与认证

客户端应连接到以下 WebSocket 端点，并将 `VCP_Key` 作为 URL 的一部分：

*   **URL 格式**: `ws://<your_server_address>:<port>/VCPlog/VCP_Key=<your_vcp_key>`
*   如果您的服务器通过反向代理（如 Cloudflare）并启用了 SSL/TLS，则 URL 格式为: `wss://<your_domain>/VCPlog/VCP_Key=<your_vcp_key>`

    **示例**:
    *   如果服务器运行在 `localhost:5890` 且 `VCP_Key` 为 `123456`，则 URL 为:
        `ws://localhost:5890/VCPlog/VCP_Key=123456`
    *   如果通过 Cloudflare 托管在 `vcptoolbox.atrade.top` 且 `VCP_Key` 为 `123456`，则 URL 为:
        `wss://vcptoolbox.atrade.top/VCPlog/VCP_Key=123456`

如果 `VCP_Key` 不正确或缺失，服务器将拒绝连接。

### 3.2. 客户端连接示例 (JavaScript)

```javascript
// 替换为您的服务器地址和 VCP Key
const vcpKey = 'your_secret_vcp_key_here'; // 从您的配置中获取
// const websocketUrl = `ws://localhost:5890/VCPlog/VCP_Key=${vcpKey}`;
const websocketUrl = `wss://vcptoolbox.atrade.top/VCPlog/VCP_Key=${vcpKey}`; // 使用 wss 如果通过 HTTPS 代理

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

## 5. Gotify 推送 （可选）

如果启用了 Gotify 推送功能 (通过在 `config.env` 中设置 `Enable_Gotify_Push=true` 并配置好 `Gotify_Url` 和 `Gotify_App_Token`)，VCP 日志信息也会被发送到指定的 Gotify 服务器。

### 5.1. 消息格式

推送到 Gotify 的消息通常包含以下信息：

*   **标题 (Title)**: 通常格式为 `VCP Log: <Tool_Name_Or_Event>`，例如 `VCP Log: DoubaoGen` 或 `VCP Log: General Event`。
*   **消息体 (Message)**: 包含更详细的日志信息，通常包括：
    *   来源 (Source): 如 `stream_loop`, `non_stream_loop_error` 等。
    *   状态 (Status): 如 `success`, `error`。
    *   内容 (Content): 实际的日志内容或错误信息。

    示例消息体结构:
    ```
    Source: stream_loop
    Status: success
    Content: 图片已成功生成！...
    ```
*   **优先级 (Priority)**: 根据 `config.env` 中的 `Gotify_Priority` 设置，或使用插件的默认值。

### 5.2. 触发条件

每当 `pushVcpLog` 函数被调用时（即有新的 VCP 日志产生时），并且 Gotify 推送功能已启用且配置正确，相应的日志信息就会被尝试推送到 Gotify。

## 6. 日志文件

所有通过 WebSocket 推送的 VCP 调用信息（以及连接/断开事件，和 Gotify 推送尝试的结果）也会被记录在服务器端。
*   **日志文件路径**: `Plugin/VCPLog/log/VCPlog.txt` (相对于项目根目录)
*   **格式**: 每条日志前会带有时间戳。

请确保服务器进程对该路径有写入权限。日志目录和文件会在插件首次加载时自动创建。