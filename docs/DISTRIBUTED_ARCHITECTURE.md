# VCP 分布式架构文档

> 本文档详细描述 VCPToolBox 的分布式网络架构，包括 WebSocket 协议、节点注册、分布式工具执行、文件传输机制以及 ChromeBridge 集成。

---

## 目录

1. [架构概览](#1-架构概览)
2. [客户端类型](#2-客户端类型)
3. [连接与认证](#3-连接与认证)
4. [节点注册流程](#4-节点注册流程)
5. [分布式工具执行](#5-分布式工具执行)
6. [文件传输机制](#6-文件传输机制)
7. [ChromeBridge 集成](#7-chromebridge-集成)
8. [心跳与连接管理](#8-心跳与连接管理)
9. [消息协议详解](#9-消息协议详解)
10. [错误处理与容错](#10-错误处理与容错)

---

## 1. 架构概览

VCP 分布式架构采用**星型网络拓扑**，由一个**主服务器 (VCPToolBox)** 和多个**分布式节点 (VCPDistributedServer)** 组成。

```
                    ┌─────────────────────────┐
                    │     VCP 主服务器         │
                    │   (WebSocketServer)     │
                    │                         │
                    │  - 路由与调度            │
                    │  - 插件管理              │
                    │  - 文件获取服务          │
                    └───────────┬─────────────┘
                                │
            ┌───────────────────┼───────────────────┐
            │                   │                   │
            ▼                   ▼                   ▼
    ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
    │  分布式节点 A  │   │  分布式节点 B  │   │ ChromeObserver │
    │  (GPU 服务器)  │   │ (文件服务器)   │   │  (浏览器插件)  │
    └───────────────┘   └───────────────┘   └───────────────┘
```

### 核心组件

| 组件 | 文件 | 职责 |
|------|------|------|
| WebSocket 服务器 | `WebSocketServer.js` | 连接管理、消息路由、工具调度 |
| 文件获取服务 | `FileFetcherServer.js` | 跨节点文件传输、缓存管理 |
| 插件管理器 | `Plugin.js` | 本地/远程插件注册与执行 |

---

## 2. 客户端类型

VCP 支持 **6 种客户端类型**，通过 WebSocket URL 路径区分：

### 2.1 VCPLog

**路径格式**: `/VCPlog/VCP_Key=<key>`

**用途**: 普通日志客户端，用于接收服务器广播的日志消息。

**存储位置**: `clients` Map

```javascript
// 连接确认消息
{ type: 'connection_ack', message: 'WebSocket connection successful for VCPLog.' }
```

### 2.2 VCPInfo

**路径格式**: `/vcpinfo/VCP_Key=<key>`

**用途**: 信息通道客户端，用于接收系统状态、插件状态等推送信息。

**存储位置**: `clients` Map

**专用广播函数**: `broadcastVCPInfo(data)`

```javascript
// 连接确认消息
{ type: 'connection_ack', message: 'WebSocket connection successful for VCPInfo.' }
```

### 2.3 DistributedServer

**路径格式**: `/vcp-distributed-server/VCP_Key=<key>`

**用途**: 分布式服务器节点，用于注册远程工具并执行主服务器下发的工具调用请求。

**存储位置**: 
- `distributedServers` Map - 键为 `serverId`，值为 `{ ws, tools, ips, serverName }`
- `distributedServerIPs` Map - 存储 IP 信息

**生成的 serverId 格式**: `dist-<clientId>`

```javascript
// 连接时初始化
distributedServers.set(serverId, { 
    ws,           // WebSocket 连接
    tools: [],    // 已注册的工具列表
    ips: {}       // IP 信息
});
```

### 2.4 ChromeObserver

**路径格式**: `/vcp-chrome-observer/VCP_Key=<key>`

**用途**: Chrome 浏览器扩展的观察者端，持续上报页面状态、接收并执行控制命令。

**存储位置**: `chromeObserverClients` Map

**关联模块**: 
- `ChromeBridge` (优先)
- `ChromeObserver` (回退)

```javascript
// 连接时自动调用模块处理
const chromeBridgeModule = pluginManager.getServiceModule('ChromeBridge');
if (chromeBridgeModule && typeof chromeBridgeModule.handleNewClient === 'function') {
    chromeBridgeModule.handleNewClient(ws);
}
```

### 2.5 ChromeControl

**路径格式**: `/vcp-chrome-control/VCP_Key=<key>`

**用途**: Chrome 浏览器扩展的控制端，用于发送控制命令并接收执行结果。

**存储位置**: `chromeControlClients` Map

**等待机制**: `waitingControlClients` Map - 存储等待页面信息更新的客户端

```javascript
// 典型消息流程
// 1. Control 发送命令
{ type: 'command', data: { requestId, command, wait_for_page_info } }

// 2. Observer 转发结果
{ type: 'command_result', data: { requestId, status, message/error } }
```

### 2.6 AdminPanel

**路径格式**: `/vcp-admin-panel/VCP_Key=<key>`

**用途**: Web 管理面板客户端，用于实时接收系统状态更新。

**存储位置**: `adminPanelClients` Map

**专用广播函数**: `broadcastToAdminPanel(data)`

---

## 3. 连接与认证

### 3.1 连接建立流程

```
客户端                           主服务器
   │                                │
   │──── HTTP Upgrade Request ─────►│
   │     (带 VCP_Key 的 URL)        │
   │                                │
   │◄─── 握手成功/拒绝 ────────────│
   │                                │
   │◄─── connection_ack ────────────│ (部分客户端)
   │                                │
```

### 3.2 认证机制

```javascript
// URL 路径正则匹配
const pathRegex = /^\/<client-type>\/VCP_Key=(.+)$/;

// 密钥验证
if (serverConfig.vcpKey && connectionKey === serverConfig.vcpKey) {
    isAuthenticated = true;
} else {
    // 认证失败，销毁连接
    socket.destroy();
    return;
}
```

### 3.3 客户端 ID 生成

```javascript
function generateClientId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 9)}`;
}

// 示例: "m5x2k9a-3h7j2n4"
```

---

## 4. 节点注册流程

### 4.1 工具注册 (register_tools)

分布式节点连接后，发送 `register_tools` 消息注册其提供的工具：

```javascript
// 节点发送
{
    type: 'register_tools',
    data: {
        tools: [
            {
                name: 'video_generator',
                description: '生成视频',
                // ... 其他工具元数据
            }
        ]
    }
}
```

**服务端处理**:

```javascript
case 'register_tools':
    const serverEntry = distributedServers.get(serverId);
    if (serverEntry && message.data && Array.isArray(message.data.tools)) {
        // 过滤内部工具
        const externalTools = message.data.tools.filter(
            t => t.name !== 'internal_request_file'
        );
        
        // 注册到插件管理器
        pluginManager.registerDistributedTools(serverId, externalTools);
        
        // 更新服务器记录
        serverEntry.tools = externalTools.map(t => t.name);
        distributedServers.set(serverId, serverEntry);
    }
    break;
```

### 4.2 IP 上报 (report_ip)

分布式节点上报其网络信息，用于文件溯源：

```javascript
// 节点发送
{
    type: 'report_ip',
    data: {
        localIPs: ['192.168.1.100', '10.0.0.5'],
        publicIP: '203.0.113.50',
        serverName: 'GPU-Server-01'
    }
}
```

**服务端处理**:

```javascript
case 'report_ip':
    const serverInfo = distributedServers.get(serverId);
    if (serverInfo && message.data) {
        const ipData = {
            localIPs: message.data.localIPs || [],
            publicIP: message.data.publicIP || null,
            serverName: message.data.serverName || serverId
        };
        
        // 存储 IP 映射
        distributedServerIPs.set(serverId, ipData);
        
        // 同步名称到连接记录
        serverInfo.serverName = ipData.serverName;
        distributedServers.set(serverId, serverInfo);
    }
    break;
```

### 4.3 静态占位符更新 (update_static_placeholders)

分布式节点可以推送静态占位符更新：

```javascript
// 节点发送
{
    type: 'update_static_placeholders',
    data: {
        serverName: 'Remote-Server',
        placeholders: {
            '{{RemoteWeather}}': '晴天 25°C',
            '{{RemoteStatus}}': '运行中'
        }
    }
}
```

---

## 5. 分布式工具执行

### 5.1 执行流程

```
主服务器                      分布式节点
    │                            │
    │── execute_tool ───────────►│
    │   { requestId,             │
    │     toolName,              │
    │     toolArgs }             │
    │                            │
    │◄── tool_result ────────────│
    │   { requestId,             │
    │     status,                │
    │     result/error }         │
    │                            │
```

### 5.2 请求消息格式

```javascript
// 主服务器发送
{
    type: 'execute_tool',
    data: {
        requestId: 'm5x2k9a-3h7j2n4',
        toolName: 'video_generator',
        toolArgs: {
            prompt: '生成一段日落视频',
            duration: 10
        }
    }
}
```

### 5.3 响应消息格式

```javascript
// 分布式节点返回 - 成功
{
    type: 'tool_result',
    data: {
        requestId: 'm5x2k9a-3h7j2n4',
        status: 'success',
        result: {
            videoUrl: 'http://...',
            duration: 10
        }
    }
}

// 分布式节点返回 - 失败
{
    type: 'tool_result',
    data: {
        requestId: 'm5x2k9a-3h7j2n4',
        status: 'error',
        error: 'GPU 内存不足'
    }
}
```

### 5.4 服务端执行函数

```javascript
async function executeDistributedTool(serverIdOrName, toolName, toolArgs, timeout) {
    // 获取超时配置
    const plugin = pluginManager.getPlugin(toolName);
    const defaultTimeout = plugin?.communication?.timeout || 60000;
    const effectiveTimeout = timeout ?? defaultTimeout;

    // 支持通过 ID 或名称查找服务器
    let server = distributedServers.get(serverIdOrName);
    if (!server) {
        for (const srv of distributedServers.values()) {
            if (srv.serverName === serverIdOrName) {
                server = srv;
                break;
            }
        }
    }

    if (!server || server.ws.readyState !== WebSocket.OPEN) {
        throw new Error(`Distributed server ${serverIdOrName} is not connected or ready.`);
    }

    const requestId = generateClientId();
    const payload = {
        type: 'execute_tool',
        data: { requestId, toolName, toolArgs }
    };

    return new Promise((resolve, reject) => {
        // 设置超时
        const timeoutId = setTimeout(() => {
            pendingToolRequests.delete(requestId);
            reject(new Error(`Request timed out after ${effectiveTimeout / 1000}s.`));
        }, effectiveTimeout);

        // 注册待处理请求
        pendingToolRequests.set(requestId, { resolve, reject, timeout: timeoutId });

        // 发送请求
        server.ws.send(JSON.stringify(payload));
    });
}
```

### 5.5 结果处理

```javascript
case 'tool_result':
    const pending = pendingToolRequests.get(message.data.requestId);
    if (pending) {
        clearTimeout(pending.timeout);
        if (message.data.status === 'success') {
            pending.resolve(message.data.result);
        } else {
            pending.reject(new Error(message.data.error || 'Distributed tool execution failed.'));
        }
        pendingToolRequests.delete(message.data.requestId);
    }
    break;
```

---

## 6. 文件传输机制

### 6.1 FileFetcherServer 概述

`FileFetcherServer.js` 提供跨节点文件获取能力，实现**透明远程文件访问**。

### 6.2 工作流程

```
插件请求                主服务器                    分布式节点
   │                      │                           │
   │── file://... ───────►│                           │
   │                      │                           │
   │                      │── internal_request_file ──►│
   │                      │   { fileUrl }             │
   │                      │                           │
   │                      │◄── Base64 Data ───────────│
   │                      │                           │
   │◄── Buffer/MIME ──────│                           │
   │                      │                           │
```

### 6.3 fetchFile 函数

```javascript
async function fetchFile(fileUrl, requestIp) {
    // 1. 快速循环检测
    const now = Date.now();
    if (recentRequests.has(fileUrl)) {
        const lastRequestTime = recentRequests.get(fileUrl);
        if (now - lastRequestTime < REQ_CACHE_EXPIRATION_MS) {
            throw new Error('检测到重复请求，防止无限循环');
        }
    }
    recentRequests.set(fileUrl, now);

    // 2. 检查本地缓存
    const cacheKey = crypto.createHash('sha256').update(fileUrl).digest('hex');
    const cachedFilePath = path.join(CACHE_DIR, cacheKey + extension);
    
    try {
        const buffer = await fs.readFile(cachedFilePath);
        return { buffer, mimeType };
    } catch (e) {
        // 缓存未命中，继续远程获取
    }

    // 3. 查找来源服务器
    const serverId = webSocketServer.findServerByIp(requestIp);
    if (!serverId) {
        throw new Error(`未找到 IP [${requestIp}] 对应的分布式服务器`);
    }

    // 4. 请求远程文件
    const result = await webSocketServer.executeDistributedTool(
        serverId, 
        'internal_request_file', 
        { fileUrl: fileUrl }, 
        60000
    );

    if (result && result.status === 'success' && result.fileData) {
        const buffer = Buffer.from(result.fileData, 'base64');
        
        // 5. 写入缓存
        await fs.writeFile(cachedFilePath, buffer);
        
        return { buffer, mimeType: result.mimeType };
    }
}
```

### 6.4 内部工具 (internal_request_file)

这是分布式节点上的内置工具，用于响应文件请求：

```javascript
// 节点处理 internal_request_file
{
    type: 'execute_tool',
    data: {
        requestId: 'xxx',
        toolName: 'internal_request_file',
        toolArgs: { fileUrl: 'file:///path/to/file.mp4' }
    }
}

// 节点响应
{
    type: 'tool_result',
    data: {
        requestId: 'xxx',
        status: 'success',
        fileData: '<Base64>',    // 文件内容
        mimeType: 'video/mp4'    // MIME 类型
    }
}
```

### 6.5 IP 查找函数

```javascript
function findServerByIp(ip) {
    for (const [serverId, ipInfo] of distributedServerIPs.entries()) {
        if (ipInfo.publicIP === ip || 
            (ipInfo.localIPs && ipInfo.localIPs.includes(ip))) {
            return ipInfo.serverName || serverId;
        }
    }
    return null;
}
```

### 6.6 缓存策略

| 缓存类型 | 位置 | 过期时间 | 用途 |
|----------|------|----------|------|
| 文件缓存 | `.file_cache/` | 永久 | 存储获取的文件 |
| 失败缓存 | `failedFetchCache` | 30秒 | 防止重复失败请求 |
| 请求缓存 | `recentRequests` | 5秒 | 防止循环请求 |

---

## 7. ChromeBridge 集成

### 7.1 Observer/Control 模式

ChromeBridge 采用**观察者-控制者**双角色模式：

```
┌─────────────────┐                    ┌─────────────────┐
│  ChromeObserver │                    │  ChromeControl  │
│  (持久连接)      │                    │  (临时连接)     │
└────────┬────────┘                    └────────┬────────┘
         │                                      │
         │         ┌──────────────┐             │
         └────────►│ 主服务器     │◄────────────┘
                   │ WebSocketServer │
                   └──────────────┘
```

### 7.2 ChromeObserver 职责

- 持续上报页面信息 (`pageInfoUpdate`)
- 接收并执行控制命令
- 返回命令执行结果

**消息类型**:

```javascript
// 心跳
{ type: 'heartbeat' }
// 响应: { type: 'heartbeat_ack', timestamp: Date.now() }

// 页面信息更新
{ type: 'pageInfoUpdate', data: { markdown: '...' } }

// 命令结果
{ type: 'command_result', data: { requestId, status, message/error, sourceClientId } }
```

### 7.3 ChromeControl 职责

- 发送控制命令
- 接收命令执行结果
- 可选等待页面信息更新

**消息类型**:

```javascript
// 发送命令
{
    type: 'command',
    data: {
        requestId: 'xxx',
        command: 'click',
        selector: '#submit-btn',
        wait_for_page_info: true  // 可选：等待页面更新
    }
}
```

### 7.4 消息路由机制

```javascript
// Control → Observer
if (parsedMessage.type === 'command') {
    const observerClient = Array.from(chromeObserverClients.values())[0];
    if (observerClient) {
        // 附加源客户端 ID
        parsedMessage.data.sourceClientId = ws.clientId;
        
        // 如果需要等待页面信息，注册等待
        if (parsedMessage.data.wait_for_page_info) {
            waitingControlClients.set(ws.clientId, parsedMessage.data.requestId);
        }
        
        observerClient.send(JSON.stringify(parsedMessage));
    }
}

// Observer → Control (结果返回)
if (parsedMessage.type === 'command_result' && parsedMessage.data.sourceClientId) {
    const sourceClientId = parsedMessage.data.sourceClientId;
    sendMessageToClient(sourceClientId, resultForClient);
}

// Observer → Control (页面信息转发)
if (parsedMessage.type === 'pageInfoUpdate') {
    waitingControlClients.forEach((requestId, clientId) => {
        sendMessageToClient(clientId, {
            type: 'page_info_update',
            data: { requestId, markdown: parsedMessage.data.markdown }
        });
        waitingControlClients.delete(clientId);
    });
}
```

---

## 8. 心跳与连接管理

### 8.1 心跳机制

ChromeObserver 客户端需要定期发送心跳：

```javascript
// 客户端发送
{ type: 'heartbeat' }

// 服务端响应
{ type: 'heartbeat_ack', timestamp: 1707849600000 }
```

### 8.2 连接关闭处理

```javascript
ws.on('close', () => {
    if (ws.clientType === 'DistributedServer') {
        // 注销所有分布式工具
        pluginManager.unregisterAllDistributedTools(ws.serverId);
        distributedServers.delete(ws.serverId);
        distributedServerIPs.delete(ws.serverId);
    } else if (ws.clientType === 'ChromeObserver') {
        chromeObserverClients.delete(ws.clientId);
    } else if (ws.clientType === 'ChromeControl') {
        chromeControlClients.delete(ws.clientId);
        waitingControlClients.delete(ws.clientId);
    } else if (ws.clientType === 'AdminPanel') {
        adminPanelClients.delete(ws.clientId);
    } else {
        clients.delete(ws.clientId);
    }
});
```

### 8.3 错误处理

```javascript
ws.on('error', (error) => {
    console.error(`[WebSocketServer] Error with client ${ws.clientId}:`, error);
    if (ws.clientId) clients.delete(ws.clientId);
});
```

---

## 9. 消息协议详解

### 9.1 消息类型汇总

| 类型 | 方向 | 发送者 | 说明 |
|------|------|--------|------|
| `connection_ack` | S→C | 服务器 | 连接确认 |
| `heartbeat` | C→S | Observer | 心跳请求 |
| `heartbeat_ack` | S→C | 服务器 | 心跳响应 |
| `register_tools` | C→S | Distributed | 注册工具 |
| `report_ip` | C→S | Distributed | 上报 IP |
| `update_static_placeholders` | C→S | Distributed | 更新占位符 |
| `execute_tool` | S→C | 服务器 | 执行工具请求 |
| `tool_result` | C→S | Distributed | 工具执行结果 |
| `command` | C→S | ChromeControl | 浏览器命令 |
| `command_result` | C→S | ChromeObserver | 命令结果 |
| `pageInfoUpdate` | C→S | ChromeObserver | 页面信息更新 |
| `page_info_update` | S→C | 服务器 | 转发页面信息 |

### 9.2 通用消息格式

```javascript
{
    type: '<message_type>',
    data: {
        // 消息特定数据
    }
}
```

### 9.3 广播函数

```javascript
// 通用广播
broadcast(data, targetClientType = null);

// VCPInfo 专用广播
broadcastVCPInfo(data);

// AdminPanel 专用广播
broadcastToAdminPanel(data);

// 发送给特定客户端
sendMessageToClient(clientId, data);
```

---

## 10. 错误处理与容错

### 10.1 认证失败

```javascript
if (serverConfig.vcpKey && connectionKey === serverConfig.vcpKey) {
    isAuthenticated = true;
} else {
    writeLog(`${clientType} connection denied. Invalid or missing VCP_Key.`);
    socket.destroy();
    return;
}
```

### 10.2 工具执行超时

```javascript
const timeoutId = setTimeout(() => {
    pendingToolRequests.delete(requestId);
    reject(new Error(`Request to distributed tool ${toolName} timed out after ${effectiveTimeout / 1000}s.`));
}, effectiveTimeout);
```

### 10.3 服务器不可达

```javascript
if (!server || server.ws.readyState !== WebSocket.OPEN) {
    throw new Error(`Distributed server ${serverIdOrName} is not connected or ready.`);
}
```

### 10.4 文件获取失败缓存

```javascript
// 30秒内防止重复失败请求
const cachedFailure = failedFetchCache.get(fileUrl);
if (cachedFailure && (Date.now() - cachedFailure.timestamp < CACHE_EXPIRATION_MS)) {
    throw new Error(`文件获取在短时间内已失败: ${cachedFailure.error}`);
}
```

### 10.5 循环请求检测

```javascript
// 5秒内重复请求视为潜在循环
if (recentRequests.has(fileUrl)) {
    const lastRequestTime = recentRequests.get(fileUrl);
    if (now - lastRequestTime < REQ_CACHE_EXPIRATION_MS) {
        throw new Error('检测到对同一文件的重复请求，防止无限循环');
    }
}
```

---

## 附录

### A. 数据结构

```javascript
// 客户端存储
const clients = new Map();                    // clientId → WebSocket
const distributedServers = new Map();         // serverId → { ws, tools, ips, serverName }
const chromeControlClients = new Map();       // clientId → WebSocket
const chromeObserverClients = new Map();      // clientId → WebSocket
const adminPanelClients = new Map();          // clientId → WebSocket
const pendingToolRequests = new Map();        // requestId → { resolve, reject, timeout }
const distributedServerIPs = new Map();       // serverId → { localIPs, publicIP, serverName }
const waitingControlClients = new Map();      // clientId → requestId
```

### B. URL 路径正则

```javascript
const vcpLogPathRegex = /^\/VCPlog\/VCP_Key=(.+)$/;
const vcpInfoPathRegex = /^\/vcpinfo\/VCP_Key=(.+)$/;
const distServerPathRegex = /^\/vcp-distributed-server\/VCP_Key=(.+)$/;
const chromeControlPathRegex = /^\/vcp-chrome-control\/VCP_Key=(.+)$/;
const chromeObserverPathRegex = /^\/vcp-chrome-observer\/VCP_Key=(.+)$/;
const adminPanelPathRegex = /^\/vcp-admin-panel\/VCP_Key=(.+)$/;
```

### C. 导出接口

```javascript
module.exports = {
    initialize,              // 初始化 WebSocket 服务器
    setPluginManager,        // 设置插件管理器引用
    broadcast,               // 广播消息
    broadcastVCPInfo,        // 广播给 VCPInfo 客户端
    broadcastToAdminPanel,   // 广播给管理面板
    sendMessageToClient,     // 发送给特定客户端
    executeDistributedTool,  // 执行分布式工具
    findServerByIp,          // 根据 IP 查找服务器
    shutdown                 // 关闭服务器
};
```

---

**文档版本**: 1.0  
**最后更新**: 2026-02-13  
**相关文件**: `WebSocketServer.js`, `FileFetcherServer.js`, `Plugin.js`
