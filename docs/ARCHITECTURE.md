# VCPToolBox 系统架构文档

**版本:** VCP 6.4  
**生成日期:** 2026-02-13  
**适用提交:** d09c49f

> **时效性提示（2026-05-01）：** 本文主体仍可用于理解旧版核心结构，但启动序列和管理面板描述已落后。当前启动链路还会初始化 `tvsManager`、`toolboxManager`、`sarPromptManager`、`dynamicToolRegistry`；管理面板由 `adminServer.js` 独立进程托管 `AdminPanel-Vue/dist`，主进程 `/AdminPanel` 负责重定向。最新校准见 [CURRENT_STATE_2026-05-01.md](./CURRENT_STATE_2026-05-01.md)。

---

## 目录

1. [系统总览](#1-系统总览)
2. [11步启动序列](#2-11步启动序列)
3. [核心三角架构](#3-核心三角架构)
4. [模块依赖图](#4-模块依赖图)
5. [核心组件详解](#5-核心组件详解)
6. [聊天请求完整流程](#6-聊天请求完整流程)
7. [分布式工具执行流程](#7-分布式工具执行流程)
8. [错误处理机制](#8-错误处理机制)
9. [关键设计决策](#9-关键设计决策)

---

## 1. 系统总览

VCPToolBox 是一个 Node.js 核心的 AI 中间层系统，采用**扁平化根目录运行结构**（无 `src/` 分层），通过插件驱动实现 AI 能力增强。

### 1.1 架构全景图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              客户端请求层                                     │
│         (VCPChat / SillyTavern / 自定义前端 / HTTP API / WebSocket)          │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          server.js - HTTP/SSE 入口                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │ Express App │  │ 中间件链    │  │ 路由层      │  │ ChatCompletionHandler│ │
│  │ :5890       │  │ (鉴权/CORS) │  │ (/v1/*)     │  │ (对话主流程)         │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
          │                           │                           │
          ▼                           ▼                           ▼
┌─────────────────┐       ┌─────────────────────┐       ┌─────────────────────┐
│ Plugin.js       │◄─────►│ WebSocketServer.js  │◄─────►│ KnowledgeBaseManager│
│ (插件生命周期)   │       │ (分布式通信骨架)     │       │ (向量库/RAG)         │
└─────────────────┘       └─────────────────────┘       └─────────────────────┘
          │                           │
          ▼                           ▼
┌─────────────────┐       ┌─────────────────────┐
│ Plugin/ 目录    │       │ 分布式节点集群        │
│ 70+ 本地插件    │       │ (VCPDistributedServer)│
└─────────────────┘       └─────────────────────┘
```

### 1.2 技术栈

| 层级 | 技术 | 文件位置 |
|------|------|----------|
| 运行时 | Node.js (CommonJS) | `server.js:1` |
| Web 框架 | Express.js | `server.js:231` |
| 向量索引 | Rust N-API (USearch/Vexus) | `rust-vexus-lite/` |
| 数据库 | SQLite (better-sqlite3) | `KnowledgeBaseManager.js:83` |
| WebSocket | ws | `WebSocketServer.js:46` |
| 文件监听 | chokidar | `KnowledgeBaseManager.js:901` |
| 进程管理 | pm2-runtime | `Dockerfile` |

### 1.3 主要子系统

1. **HTTP/SSE 服务层**: 请求鉴权、模型转发、流式错误代理、中断控制  
   📁 `server.js:465-493`, `server.js:636-745`, `modules/chatCompletionHandler.js:483-511`
2. **插件运行时**: manifest 发现/加载、六类插件执行、服务路由注册、热重载清理  
   📁 `Plugin.js:388-564`, `Plugin.js:632-720`, `Plugin.js:805-1030`
3. **WebSocket 通信骨架**: 客户端分型认证、消息分发、分布式工具调用闭环  
   📁 `WebSocketServer.js:52-57`, `WebSocketServer.js:400-465`, `WebSocketServer.js:467-509`
4. **知识库与 RAG 子系统**: SQLite + 全局 Tag 索引 + EPA + 残差金字塔 + 去重器  
   📁 `KnowledgeBaseManager.js:76-135`, `KnowledgeBaseManager.js:446-621`
5. **管理面板与运维入口**: `/AdminPanel` 静态页面、`/admin_api` 受控接口  
   📁 `server.js:316-460`, `WebSocketServer.js:521-534`

---

## 2. 11步启动序列

以下是 `node server.js` 执行时的完整启动序列，每步标注**阻塞点**和**文件位置**：

### Step 1: 环境配置加载 ⚠️ 阻塞
📁 `server.js:4`
```javascript
dotenv.config({ path: 'config.env' });
```
- **阻塞原因**: 同步读取配置文件，失败则进程退出
- **依赖**: `config.env` 必须存在

### Step 2: 日志系统初始化 ⚠️ 阻塞
📁 `server.js:20-22`
```javascript
const logger = require('./modules/logger.js');
logger.initializeServerLogger();
logger.overrideConsole();
```
- **阻塞原因**: 同步初始化日志目录和文件句柄
- **输出**: `DebugLog/archive/YYYY-MM-DD/Debug/`

### Step 3: Agent 目录路径解析 (同步)
📁 `server.js:27-66`
```javascript
function resolveAgentDir() {
    const configPath = process.env.AGENT_DIR_PATH;
    // ... 路径规范化逻辑
}
AGENT_DIR = resolveAgentDir();
```
- **非阻塞**: 纯同步计算

### Step 4: Express 应用创建
📁 `server.js:231`
```javascript
const app = express();
app.set('trust proxy', true);
app.use(cors({ origin: '*' }));
```

### Step 5: 中间件链挂载
📁 `server.js:236-456`
```javascript
app.use(express.json({ limit: '300mb' }));
app.use(express.urlencoded({ limit: '300mb', extended: true }));
// IP 追踪中间件 (241-258)
// IP 黑名单中间件 (292-303)
// Bearer Token 认证 (466-493)
```

### Step 6: 路由层注册
📁 `server.js:306-813`
```javascript
app.use(specialModelRouter);           // 特殊模型透传
app.get('/v1/models', ...);            // 模型列表
app.post('/v1/chat/completions', ...); // 主聊天端点
app.post('/v1/interrupt', ...);        // 中断控制
app.post('/v1/human/tool', ...);       // 人类直接调用工具
app.post('/plugin-callback/...', ...); // 插件回调
```

### Step 7: ChatCompletionHandler 实例化
📁 `server.js:749-785`
```javascript
const chatCompletionHandler = new ChatCompletionHandler({
    apiUrl, apiKey, modelRedirectHandler, pluginManager,
    activeRequests, writeDebugLog, webSocketServer,
    DEBUG_MODE, SHOW_VCP_OUTPUT, VCPToolCode, ...
});
```

### Step 8: initialize() 核心初始化 ⚠️ 阻塞
📁 `server.js:1076-1087`
```javascript
async function initialize() {
    console.log('开始初始化向量数据库...');
    await knowledgeBaseManager.initialize(); // ⚠️ 关键阻塞点
    console.log('向量数据库初始化完成。');

    pluginManager.setProjectBasePath(__dirname);
    pluginManager.setVectorDBManager(knowledgeBaseManager);
    
    console.log('开始加载插件...');
    await pluginManager.loadPlugins();        // ⚠️ 关键阻塞点
    console.log('插件加载完成。');
}
```

**KnowledgeBaseManager.initialize() 内部流程** (`KnowledgeBaseManager.js:76-134`):
1. 创建 `VectorStore/` 目录
2. 连接 SQLite 数据库 (`knowledge_base.sqlite`)
3. 加载 Rust Vexus 向量索引
4. 预热日记本名称向量缓存 (同步阻塞) 📁 `KnowledgeBaseManager.js:107-109`
5. 初始化 EPA 模块
6. 初始化残差金字塔模块
7. 启动文件监听器 (chokidar)

**PluginManager.loadPlugins() 内部流程** (`Plugin.js:388-563`):
1. 清理现有插件状态（保留分布式插件）
2. 遍历 `Plugin/` 目录发现所有 `plugin-manifest.json`
3. 解析插件配置并注入环境变量
4. 加载预处理器顺序 (`preprocessor_order.json`)
5. 初始化所有模块的 `initialize()` 方法
6. 构建 VCP 工具描述

### Step 9: 静态插件预热
📁 `server.js:1090-1093`
```javascript
await pluginManager.initializeStaticPlugins();
```
- **行为**: 为所有 `static` 类型插件设置定时刷新任务
- **位置**: `Plugin.js:221-258`

### Step 10: WebSocket 服务器初始化
📁 `server.js:1095-1098`
```javascript
webSocketServer.initialize(server, {
    debugMode: DEBUG_MODE,
    vcpKey: process.env.VCP_Key
});
```
- **位置**: `WebSocketServer.js:35-323`
- **行为**: 绑定 HTTP Server 的 `upgrade` 事件，处理 WebSocket 握手

### Step 11: startServer() 监听
📁 `server.js:1100-1105`
```javascript
function startServer() {
    server.listen(port, () => {
        console.log(`VCP服务器正在端口 ${port} 上运行`);
    });
}
startServer();
```

---

## 3. 核心三角架构

VCPToolBox 的运行时核心由三个相互依赖的模块组成：

```
                    ┌─────────────────────┐
                    │     server.js       │
                    │  (HTTP 入口 & 编排)  │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
    ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
    │  Plugin.js      │ │WebSocketServer.js│ │KnowledgeBase    │
    │  (插件管理器)    │ │ (通信骨架)       │ │Manager.js (RAG) │
    └────────┬────────┘ └────────┬────────┘ └─────────────────┘
             │                   │
             │   setWebSocketServer()  │
             │◄──────────────────────┤
             │                   │
             │  setPluginManager()     │
             ├──────────────────────►│
             │                   │
```

### 3.1 server.js ↔ PluginManager

**依赖注入点**: `server.js:73, 81-82`
```javascript
const pluginManager = require('./Plugin.js');
// ...
pluginManager.setProjectBasePath(__dirname);
pluginManager.setVectorDBManager(knowledgeBaseManager);
```

**调用关系**:
| 调用方 | 被调用方 | 方法 | 位置 |
|--------|----------|------|------|
| server.js | PluginManager | `loadPlugins()` | `server.js:1085` |
| server.js | PluginManager | `executePlugin()` | `server.js:948` |
| server.js | PluginManager | `processToolCall()` | `server.js:859` |
| ChatCompletionHandler | PluginManager | `messagePreprocessors.get()` | `chatCompletionHandler.js:394` |

### 3.2 PluginManager ↔ WebSocketServer

**双向注入**:
```javascript
// PluginManager 持有 WebSocketServer 引用
// Plugin.js:27, 33-36
this.webSocketServer = null;
setWebSocketServer(wss) {
    this.webSocketServer = wss;
}

// WebSocketServer 持有 PluginManager 引用
// WebSocketServer.js:6, 395-397
let pluginManager = null;
function setPluginManager(pm) {
    pluginManager = pm;
}
```

**初始化顺序** (`server.js:1081-1098`):
```javascript
// 1. 先设置 PluginManager 的 WebSocket 引用
pluginManager.setWebSocketServer(webSocketServer);
// 2. 再设置 WebSocketServer 的 PluginManager 引用
webSocketServer.setPluginManager(pluginManager);
```

### 3.3 分布式工具调用链

```
AI 响应含工具调用
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ PluginManager.processToolCall()                              │
│ 📁 Plugin.js:632-803                                         │
│                                                              │
│ if (plugin.isDistributed) {                                  │
│     resultFromPlugin = await this.webSocketServer            │
│         .executeDistributedTool(plugin.serverId, ...);       │
│ }                                                            │
└──────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ WebSocketServer.executeDistributedTool()                     │
│ 📁 WebSocketServer.js:467-509                                │
│                                                              │
│ server.ws.send(JSON.stringify({                              │
│     type: 'execute_tool',                                    │
│     data: { requestId, toolName, toolArgs }                  │
│ }));                                                         │
└──────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ 分布式节点 (VCPDistributedServer)                             │
│ ──WebSocket──► 执行本地插件 ──WebSocket──► 返回结果           │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. 模块依赖图

### 4.1 核心模块依赖

```text
server.js
  -> ChatCompletionHandler
       -> StreamHandler / NonStreamHandler
       -> ToolExecutor
            -> PluginManager.processToolCall()
                 -> (local stdio | hybrid direct | Chrome direct | distributed)
  -> PluginManager
       <-> WebSocketServer (setter 双向注入)
       -> message preprocessors / service modules / static placeholders
  -> KnowledgeBaseManager
       -> SQLite + Vexus index + EPA + ResidualPyramid + ResultDeduplicator
  -> FileFetcherServer
       -> WebSocketServer (跨节点文件回补)
```

📁 证据: `server.js:69-77`, `server.js:749-770`, `modules/chatCompletionHandler.js:590-608`

### 4.2 模块职责矩阵

| 模块 | 职责 | 导出类型 | 关键方法 |
|------|------|----------|----------|
| `server.js` | HTTP 入口、启动编排 | 无 (直接执行) | `initialize()`, `startServer()` |
| `Plugin.js` | 插件生命周期管理 | `PluginManager` 类 | `loadPlugins()`, `processToolCall()`, `executePlugin()` |
| `WebSocketServer.js` | 分布式通信、实时推送 | 函数对象 | `initialize()`, `broadcast()`, `executeDistributedTool()` |
| `KnowledgeBaseManager.js` | 向量索引、RAG 检索 | `KnowledgeBaseManager` 类 | `initialize()`, `search()`, `applyTagBoost()` |
| `chatCompletionHandler.js` | 对话主流程编排 | `ChatCompletionHandler` 类 | `handle()` |
| `messageProcessor.js` | 变量替换管线 | 函数对象 | `replaceAgentVariables()`, `replaceOtherVariables()` |
| `agentManager.js` | Agent 别名与文件管理 | 函数对象 | `isAgent()`, `getAgentPrompt()` |
| `roleDivider.js` | 角色分割转换 | 函数对象 | `process()` |

---

## 5. 核心组件详解

### 5.1 PluginManager (Plugin.js)

#### 5.1.1 插件类型支持

| 类型 | 执行方式 | 超时 | 位置 |
|------|----------|------|------|
| `static` | 定时执行，更新占位符 | 60s (可配置) | `Plugin.js:116-179` |
| `synchronous` | stdio 同步执行 | 60s | `Plugin.js:805-918` |
| `asynchronous` | stdio 初始响应 + HTTP 回调 | 30min | `Plugin.js:886-906` |
| `service` | 直接 require，常驻内存 | 无 | `Plugin.js:455-466` |
| `hybridservice` | 服务 + 工具调用 | 无 | `Plugin.js:683-693` |
| `messagePreprocessor` | 消息预处理管道 | 无 | `Plugin.js:324-345` |

#### 5.1.2 配置合并逻辑

📁 `Plugin.js:61-105`
```javascript
_getPluginConfig(pluginManifest) {
    const config = {};
    const globalEnv = process.env;
    const pluginSpecificEnv = pluginManifest.pluginSpecificEnvConfig || {};
    
    // 优先级: 插件私有配置 > 全局环境变量
    if (pluginSpecificEnv.hasOwnProperty(key)) {
        rawValue = pluginSpecificEnv[key];
    } else if (globalEnv.hasOwnProperty(key)) {
        rawValue = globalEnv[key];
    }
    // ... 类型转换
}
```

#### 5.1.3 分布式插件标记

📁 `Plugin.js:665-672`
```javascript
if (plugin.isDistributed) {
    resultFromPlugin = await this.webSocketServer
        .executeDistributedTool(plugin.serverId, toolName, pluginSpecificArgs);
}
```

### 5.2 WebSocketServer (WebSocketServer.js)

#### 5.2.1 客户端类型与路径

| 客户端类型 | WebSocket 路径正则 | 用途 |
|------------|-------------------|------|
| `VCPLog` | `/VCPlog/VCP_Key=(.+)` | 日志推送 |
| `VCPInfo` | `/vcpinfo/VCP_Key=(.+)` | 信息推送 |
| `DistributedServer` | `/vcp-distributed-server/VCP_Key=(.+)` | 分布式节点 |
| `ChromeObserver` | `/vcp-chrome-observer/VCP_Key=(.+)` | 浏览器插件观察者 |
| `ChromeControl` | `/vcp-chrome-control/VCP_Key=(.+)` | 浏览器插件控制器 |
| `AdminPanel` | `/vcp-admin-panel/VCP_Key=(.+)` | 管理面板 |

📁 `WebSocketServer.js:52-57`

#### 5.2.2 消息类型处理

📁 `WebSocketServer.js:400-465`
```javascript
handleDistributedServerMessage(serverId, message) {
    switch (message.type) {
        case 'register_tools':    // 注册分布式工具
        case 'report_ip':         // 上报 IP 信息
        case 'update_static_placeholders': // 更新静态占位符
        case 'tool_result':       // 工具执行结果
    }
}
```

### 5.3 KnowledgeBaseManager (KnowledgeBaseManager.js)

#### 5.3.1 多索引架构

```
VectorStore/
├── knowledge_base.sqlite     # SQLite 主数据库
├── index_global_tags.usearch # 全局 Tag 索引
├── index_diary_{hash}.usearch # 各日记本独立索引
└── ...
```

📁 `KnowledgeBaseManager.js:210-242`

#### 5.3.2 TagMemo V3.7 增强算法

📁 `KnowledgeBaseManager.js:443-731`

核心步骤:
1. **EPA 分析**: 逻辑深度与共振检测
2. **残差金字塔**: 新颖度与覆盖率分析
3. **动态增强**: 基于 EPA 结果调整 boost 因子
4. **世界观门控**: 过滤跨域噪音
5. **语言补偿**: 技术词汇惩罚
6. **核心 Tag 补全**: 确保关键锚点不丢失
7. **语义去重**: 消除冗余标签

```javascript
// 核心公式 (KnowledgeBaseManager.js:468-473)
const dynamicBoostFactor = (logicDepth * (1 + resonanceBoost) 
    / (1 + entropyPenalty * 0.5)) * activationMultiplier;
const effectiveTagBoost = baseTagBoost * Math.max(boostRange[0], 
    Math.min(boostRange[1], dynamicBoostFactor));
```

---

## 6. 聊天请求完整流程

### 6.1 流程图

```
POST /v1/chat/completions
           │
           ▼
┌─────────────────────────────────────────────────────────────┐
│ 1. 请求预处理                                                │
│    • 生成 requestId, 创建 AbortController                   │
│    • 注册到 activeRequests Map                              │
│    📁 chatCompletionHandler.js:289-300                      │
└─────────────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. 上下文控制 (可选)                                         │
│    • 检测 contextTokenLimit 参数                            │
│    • 调用 contextManager.pruneMessages()                    │
│    📁 chatCompletionHandler.js:307-325                      │
└─────────────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. 模型重定向                                                │
│    • modelRedirectHandler.redirectModelForBackend()         │
│    📁 chatCompletionHandler.js:328-346                      │
└─────────────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. 角色分割处理 (可选)                                       │
│    • roleDivider.process()                                  │
│    📁 chatCompletionHandler.js:353-364                      │
└─────────────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. VCPTavern 优先预处理                                      │
│    • pluginManager.executeMessagePreprocessor('VCPTavern')  │
│    📁 chatCompletionHandler.js:392-401                      │
└─────────────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────┐
│ 6. 统一变量替换管线                                          │
│    • messageProcessor.replaceAgentVariables()               │
│    • 递归展开 Agent、Tar*、Var* 占位符                       │
│    📁 chatCompletionHandler.js:414-444                      │
│    📁 messageProcessor.js:14-52                             │
└─────────────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────┐
│ 7. 媒体处理器                                                │
│    • MultiModalProcessor 或 ImageProcessor                  │
│    📁 chatCompletionHandler.js:448-460                      │
└─────────────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────┐
│ 8. 其他消息预处理器链                                        │
│    • 按顺序执行所有已注册的预处理器                          │
│    📁 chatCompletionHandler.js:463-473                      │
└─────────────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────┐
│ 9. 调用上游 AI API                                           │
│    • fetchWithRetry() 带重试机制                            │
│    📁 chatCompletionHandler.js:483-511                      │
└─────────────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────┐
│ 10. 响应处理                                                 │
│     • StreamHandler 或 NonStreamHandler                     │
│     • 检测工具调用、执行工具、递归调用                        │
│    📁 chatCompletionHandler.js:604-607                      │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 变量替换管线详解

📁 `messageProcessor.js`

```javascript
// 主入口函数
async function resolveAllVariables(text, model, role, context, processingStack) {
    // 1. 递归展开 Agent 变量 (检测循环依赖)
    // 2. 调用 replacePriorityVariables (表情包、日记本)
    // 3. 调用 replaceOtherVariables (Tar*, Var*, 时间, 静态插件占位符)
}
```

**变量优先级** (从高到低):
1. `{{agent:Alias}}` / `{{Alias}}` - Agent 别名展开
2. `{{Tar*}}` - 最高优先级模板变量
3. `{{Var*}}` - 通用自定义变量
4. `{{SarPrompt*}}` - 模型条件注入
5. `{{Date}}` / `{{Time}}` / `{{Festival}}` - 时间变量
6. `{{VCPPluginName}}` - 静态插件占位符
7. `{{VCPAllTools}}` - 全部工具描述聚合

### 6.3 VCP 工具调用协议

**请求格式** (AI 输出):
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」PluginName「末」,
param1:「始」value1「末」,
archery:「始」no_reply「末」,
ink:「始」mark_history「末」
<<<[END_TOOL_REQUEST]>>>
```

**解析位置**: `modules/vcpLoop/toolCallParser.js`

**高级指令**:
| 指令 | 效果 |
|------|------|
| `archery:「始」no_reply「末」` | 异步执行，不等待结果 |
| `ink:「始」mark_history「末」` | 强制将结果注入对话历史 |

---

## 7. 分布式工具执行流程

### 7.1 节点注册流程

```
分布式节点启动
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ VCPDistributedServer 连接到主服务器                           │
│ WebSocket 路径: /vcp-distributed-server/VCP_Key=xxx          │
└──────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ 发送 register_tools 消息                                      │
│ { type: 'register_tools', data: { tools: [...] } }           │
└──────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ WebSocketServer.handleDistributedServerMessage()             │
│ 📁 WebSocketServer.js:407-416                                │
│                                                              │
│ pluginManager.registerDistributedTools(serverId, tools);     │
│ // 为每个工具添加 [云端] 前缀和 isDistributed: true 标记     │
└──────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ 发送 report_ip 消息                                          │
│ { type: 'report_ip', data: { localIPs, publicIP, serverName } }│
└──────────────────────────────────────────────────────────────┘
```

### 7.2 工具执行流程

```
AI 请求执行云端工具
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ PluginManager.processToolCall()                              │
│ 📁 Plugin.js:665-672                                         │
│                                                              │
│ if (plugin.isDistributed) {                                  │
│     result = await this.webSocketServer                      │
│         .executeDistributedTool(plugin.serverId, ...);       │
│ }                                                            │
└──────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ WebSocketServer.executeDistributedTool()                     │
│ 📁 WebSocketServer.js:467-509                                │
│                                                              │
│ const requestId = generateClientId();                        │
│ pendingToolRequests.set(requestId, { resolve, reject });     │
│ server.ws.send(JSON.stringify({                              │
│     type: 'execute_tool', data: { requestId, toolName, args }│
│ }));                                                         │
└──────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ 分布式节点执行本地插件                                        │
│ (VCPDistributedServer 内部)                                  │
└──────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ 返回 tool_result 消息                                        │
│ { type: 'tool_result', data: { requestId, status, result } } │
└──────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ WebSocketServer.handleDistributedServerMessage()             │
│ 📁 WebSocketServer.js:450-460                                │
│                                                              │
│ const pending = pendingToolRequests.get(requestId);          │
│ if (status === 'success') pending.resolve(result);           │
│ else pending.reject(new Error(error));                       │
└──────────────────────────────────────────────────────────────┘
```

### 7.3 分布式文件解析 (VCPFileAPI v4.0)

📁 `Plugin.js:726-773`

```
工具调用参数含 file:// URL
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ 本地插件执行失败 (FILE_NOT_FOUND_LOCALLY)                    │
└──────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ FileFetcherServer.fetchFile(fileUrl, requestIp)              │
│ 1. 根据 IP 追踪来源服务器                                    │
│ 2. 通过 WebSocket 请求远程文件                               │
│ 3. 返回 Base64 编码数据                                      │
└──────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ 自动重试: 替换 file:// 为 data: URI                          │
│ newToolArgs.image_base64_1 = `data:${mimeType};base64,...`   │
│ return await this.processToolCall(toolName, newToolArgs);    │
└──────────────────────────────────────────────────────────────┘
```

---

## 8. 错误处理机制

### 8.1 请求中断机制

📁 `server.js:636-745`

```javascript
app.post('/v1/interrupt', (req, res) => {
    const context = activeRequests.get(id);
    if (context) {
        context.aborted = true;
        context.abortController.abort();
        // 根据请求类型发送适当的响应
        if (isStreamRequest) {
            // 流式请求: 发送 SSE 格式中止信号
        } else {
            // 非流式请求: 发送 JSON 响应
        }
    }
});
```

### 8.2 上游 API 错误处理

📁 `chatCompletionHandler.js:519-569`

```javascript
// 流式请求上游返回非 200 状态码
if (isOriginalRequestStreaming && upstreamStatus !== 200) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    // 将错误作为 SSE chunk 发送给客户端
    res.write(`data: ${JSON.stringify(errorPayload)}\n\n`);
    res.write('data: [DONE]\n\n');
}
```

### 8.3 重试机制

📁 `chatCompletionHandler.js:99-144`

```javascript
async function fetchWithRetry(url, options, { retries = 3, delay = 1000 }) {
    for (let i = 0; i < retries; i++) {
        const response = await fetch(url, options);
        if (response.status === 500 || response.status === 503 || response.status === 429) {
            await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
            continue; // 重试
        }
        return response;
    }
    throw new Error('Fetch failed after all retries.');
}
```

### 8.4 IP 黑名单机制

📁 `server.js:179-289`

```javascript
// 错误计数
function handleApiError(req) {
    const currentErrors = (apiErrorCounts.get(clientIp) || 0) + 1;
    if (currentErrors >= MAX_API_ERRORS) {
        ipBlacklist.push(clientIp);
        saveBlacklist();
    }
}

// 黑名单拦截中间件
app.use((req, res, next) => {
    if (ipBlacklist.includes(clientIp)) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
});
```

### 8.5 工具执行错误检测

📁 `chatCompletionHandler.js:19-68`

```javascript
function isToolResultError(result) {
    if (typeof result === 'object') {
        if (result.error === true || result.status === 'error') return true;
    }
    if (typeof result === 'string') {
        const errorPrefixes = ['[error]', '[错误]', '[失败]', 'error:'];
        for (const prefix of errorPrefixes) {
            if (result.toLowerCase().startsWith(prefix)) return true;
        }
    }
    return false;
}
```

---

## 9. 关键设计决策

### 9.1 扁平化目录结构

**决策**: 根目录直接放置核心模块，无 `src/` 分层。

**理由**:
- 降低模块导入复杂度
- 便于快速定位代码
- 适配插件生态的文件监听需求

**证据**: `server.js`、`Plugin.js`、`WebSocketServer.js` 均位于根目录

### 9.2 Rust N-API 向量索引

**决策**: 使用 Rust (USearch) 实现向量索引，通过 N-API 绑定到 Node.js。

**理由**:
- 纯 JS 向量搜索性能不足
- USearch 是业界最快的向量搜索引擎之一
- 支持磁盘映射 (mmap) 模式处理大规模数据

**证据**: `KnowledgeBaseManager.js:17-25`
```javascript
try {
    const vexusModule = require('./rust-vexus-lite');
    VexusIndex = vexusModule.VexusIndex;
    console.log('[KnowledgeBase] 🦀 Vexus-Lite Rust engine loaded');
} catch (e) {
    console.error('[KnowledgeBase] ❌ Critical: Vexus-Lite not found.');
    process.exit(1); // 无 Rust 组件则退出
}
```

### 9.3 分布式插件热注册

**决策**: 分布式节点通过 WebSocket 实时注册插件，断开自动注销。

**理由**:
- 支持动态扩缩容
- 无需重启主服务器
- 实现算力分布式调度

**证据**: `WebSocketServer.js:288-294`
```javascript
ws.on('close', () => {
    if (ws.clientType === 'DistributedServer') {
        pluginManager.unregisterAllDistributedTools(ws.serverId);
        distributedServers.delete(ws.serverId);
    }
});
```

### 9.4 VCP 自定义工具调用协议

**决策**: 不使用 OpenAI function-calling，采用自定义文本标记协议。

**理由**:
- 模型无关性：支持所有兼容 OpenAI API 格式的模型
- 协议透明：易于调试和日志追踪
- 支持高级指令 (archery, ink)

**证据**: README.md - "工具调用协议是 VCP 自定义块语法"

### 9.5 静态插件的 Cron 刷新

**决策**: 静态插件通过 cron 表达式定时执行，而非持续运行。

**理由**:
- 资源效率：只在需要时执行
- 灵活调度：支持任意时间间隔
- 超时保护：避免无限执行

**证据**: `Plugin.js:238-254`
```javascript
if (plugin.refreshIntervalCron) {
    const job = schedule.scheduleJob(plugin.refreshIntervalCron, () => {
        this._updateStaticPluginValue(plugin);
    });
    this.scheduledJobs.set(plugin.name, job);
}
```

### 9.6 多索引隔离架构

**决策**: 每个日记本使用独立的向量索引，而非全局单一索引。

**理由**:
- 检索隔离：避免跨日记本干扰
- 懒加载：只在访问时加载对应索引
- 故障隔离：单个索引损坏不影响其他

**证据**: `KnowledgeBaseManager.js:210-220`
```javascript
async _getOrLoadDiaryIndex(diaryName) {
    if (this.diaryIndices.has(diaryName)) {
        return this.diaryIndices.get(diaryName);
    }
    // 懒加载索引
    const idx = await this._loadOrBuildIndex(idxName, 50000, 'chunks', diaryName);
    this.diaryIndices.set(diaryName, idx);
    return idx;
}
```

### 9.7 循环依赖解决：Setter 注入

**决策**: PluginManager ↔ WebSocketServer 通过运行期 setter 注入，而非模块加载时强耦合。

**理由**:
- 降低模块加载期循环引用风险
- 保证初始化顺序可控
- 便于测试和替换实现

**证据**: `server.js:1092`, `server.js:1213`, `WebSocketServer.js:395-398`

---

## 附录 A: 文件定位索引

| 功能 | 文件 | 关键行号 |
|------|------|----------|
| 环境加载 | `server.js` | 4 |
| 日志初始化 | `server.js` | 20-22 |
| Express 创建 | `server.js` | 231 |
| IP 黑名单 | `server.js` | 179-303 |
| 管理员认证 | `server.js` | 317-456 |
| 聊天端点 | `server.js` | 788-813 |
| 中断端点 | `server.js` | 636-745 |
| 插件加载 | `Plugin.js` | 388-563 |
| 工具执行 | `Plugin.js` | 632-803 |
| 分布式调用 | `Plugin.js` | 665-672 |
| WebSocket 初始化 | `WebSocketServer.js` | 35-323 |
| 分布式消息处理 | `WebSocketServer.js` | 400-465 |
| 向量库初始化 | `KnowledgeBaseManager.js` | 76-134 |
| TagMemo V3 算法 | `KnowledgeBaseManager.js` | 443-731 |
| 对话主流程 | `chatCompletionHandler.js` | 254-712 |
| 变量替换 | `messageProcessor.js` | 14-239 |

---

## 附录 B: 配置文件依赖

| 配置文件 | 用途 | 加载位置 |
|----------|------|----------|
| `config.env` | 全局环境变量 | `server.js:4` |
| `Plugin/*/config.env` | 插件私有配置 | `Plugin.js:442-446` |
| `Plugin/*/plugin-manifest.json` | 插件清单 | `Plugin.js:435` |
| `preprocessor_order.json` | 预处理器顺序 | `Plugin.js:484-496` |
| `ip_blacklist.json` | IP 黑名单 | `server.js:179-193` |
| `Agent/agent_map.json` | Agent 别名映射 | `agentManager.js` |
| `rag_params.json` | RAG 热调控参数 | `KnowledgeBaseManager.js:140-149` |

---

## 附录 C: 边界条件与异常分支

- Agent 目录创建失败 -> 进程退出 📁 `server.js:49-65`
- Admin 凭据缺失 -> 管理面板禁用（503）📁 `server.js:345-357`
- 登录暴力尝试 -> 临时封禁 + Retry-After 📁 `server.js:361-369`
- 分布式目标节点离线 -> 抛错终止工具调用 📁 `WebSocketServer.js:485-487`
- 分布式工具超时 -> pending 清理 + reject 📁 `WebSocketServer.js:500-503`
- 插件 stdout 非法 JSON -> 同步插件按失败分支返回详细错误 📁 `Plugin.js:999-1013`
- 上游流式异常 -> SSE 错误帧兜底 📁 `chatCompletionHandler.js:619-651`

---

*文档结束*
