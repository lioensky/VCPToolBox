# VCPToolBox 插件生态文档

**版本：** 1.0.0  
**最后更新：** 2026-02-13  
**适用版本：** VCPToolBox 6.4+

---

## 目录

1. [概述](#1-概述)
2. [插件类型详解](#2-插件类型详解)
3. [Manifest Schema 完整规范](#3-manifest-schema-完整规范)
4. [配置级联机制](#4-配置级联机制)
5. [插件生命周期](#5-插件生命周期)
6. [执行模式](#6-执行模式)
7. [静态插件占位符机制](#7-静态插件占位符机制)
8. [Python/Rust 集成](#8-pythonrust-集成)
9. [插件分类索引](#9-插件分类索引)
10. [开发者指南](#10-开发者指南)

---

## 1. 概述

VCPToolBox 插件生态是整个系统的核心能力扩展层。通过统一的 `plugin-manifest.json` 契约文件，系统支持 **6 种插件类型**，覆盖从被动数据注入到主动工具执行的完整能力谱系。

### 1.1 核心设计理念

- **Manifest 驱动**：所有插件行为由 `plugin-manifest.json` 声明式定义
- **协议无关**：支持 stdio、direct、distributed 多种通信协议
- **配置级联**：全局配置 → 插件专属配置 → Schema 默认值三层合并
- **热加载**：支持插件文件变更自动重载（direct 协议插件除外）
- **分布式原生**：插件可透明部署在分布式节点

### 1.2 插件目录结构

```
Plugin/
├── <PluginName>/
│   ├── plugin-manifest.json      # 启用态插件契约（必需）
│   ├── plugin-manifest.json.block # 禁用态标记
│   ├── config.env                 # 插件专属配置（私密，不提交）
│   ├── config.env.example         # 配置模板（提交到仓库）
│   ├── package.json               # Node.js 依赖（可选）
│   ├── requirements.txt           # Python 依赖（可选）
│   └── src/                       # 源码目录（Rust/原生）
```

### 1.3 插件统计

| 类型 | 数量 | 说明 |
|------|------|------|
| `synchronous` | ~45 | 同步工具执行 |
| `static` | ~10 | 静态数据注入 |
| `service` | ~8 | 常驻服务 |
| `hybridservice` | ~8 | 混合服务 |
| `messagePreprocessor` | ~5 | 消息预处理 |
| `asynchronous` | ~3 | 异步任务 |
| **总计** | **79** | 活跃插件 |

---

## 2. 插件类型详解

### 2.1 `static` - 静态插件

**用途**：周期性生成静态数据，通过占位符注入系统提示词。

**执行特征**：
- 通过 `cron` 表达式定时刷新
- 输出存储在 `staticPlaceholderValues` Map 中
- 不响应直接工具调用

**Manifest 示例**：
```json
{
  "manifestVersion": "1.0.0",
  "name": "DailyNoteGet",
  "version": "1.0.0",
  "displayName": "日记内容获取器 (静态)",
  "description": "定期读取所有角色的日记内容，并通过系统占位符提供给服务器。",
  "author": "System",
  "pluginType": "static",
  "entryPoint": {
    "type": "nodejs",
    "command": "node daily-note-get.js"
  },
  "communication": {
    "protocol": "stdio",
    "timeout": 10000
  },
  "capabilities": {
    "systemPromptPlaceholders": [
      {
        "placeholder": "{{AllCharacterDiariesData}}",
        "description": "所有角色日记内容的JSON字符串"
      }
    ]
  },
  "refreshIntervalCron": "*/5 * * * *"
}
```

**生命周期**：
1. 系统启动时立即触发首次执行（后台）
2. 按 `refreshIntervalCron` 周期调度
3. 超时不视为错误，返回已收集的输出

---

### 2.2 `synchronous` - 同步插件

**用途**：执行一次性工具任务，阻塞等待结果返回。

**执行特征**：
- 通过 VCP 指令协议调用
- 默认超时 60 秒
- 必须返回标准 JSON 格式

**Manifest 示例**：
```json
{
  "manifestVersion": "1.0.0",
  "name": "VSearch",
  "version": "1.0.0",
  "displayName": "VSearch 语义并发搜索器",
  "description": "利用小模型内置搜索能力进行深度检索。",
  "author": "VCP",
  "pluginType": "synchronous",
  "entryPoint": {
    "type": "nodejs",
    "command": "node VSearch.js"
  },
  "communication": {
    "protocol": "stdio",
    "timeout": 300000
  },
  "configSchema": {
    "VSearchKey": {
      "type": "string",
      "description": "API Key"
    },
    "VSearchUrl": {
      "type": "string",
      "description": "API 端点 URL"
    }
  },
  "capabilities": {
    "invocationCommands": [
      {
        "commandIdentifier": "VSearch",
        "description": "执行语义级并发搜索...",
        "example": "<<<[TOOL_REQUEST]>>>..."
      }
    ]
  }
}
```

**返回格式**：
```json
{
  "status": "success" | "error",
  "result": "成功时返回的内容或JSON对象",
  "error": "失败时的错误信息",
  "messageForAI": "可选，给AI的额外提示",
  "base64": "可选，Base64编码数据（如图片）"
}
```

---

### 2.3 `asynchronous` - 异步插件

**用途**：执行长时间任务，立即返回任务 ID，完成后通过回调通知。

**执行特征**：
- 立即返回初始响应（包含 `requestId`）
- 后台任务完成后 POST 到 `/plugin-callback/:pluginName/:taskId`
- 默认超时 30 分钟

**Manifest 示例**：
```json
{
  "manifestVersion": "1.0.0",
  "name": "VideoGenerator",
  "pluginType": "asynchronous",
  "entryPoint": {
    "type": "nodejs",
    "command": "node VideoGenerator.js"
  },
  "communication": {
    "protocol": "stdio",
    "timeout": 1800000
  }
}
```

**初始响应格式**：
```json
{
  "status": "success",
  "result": {
    "requestId": "unique_task_id_123",
    "message": "任务已提交，正在后台处理中。"
  },
  "messageForAI": "视频生成任务已提交，ID为 unique_task_id_123。"
}
```

**回调请求格式**：
```json
// POST /plugin-callback/VideoGenerator/unique_task_id_123
{
  "requestId": "unique_task_id_123",
  "status": "Succeed",
  "pluginName": "VideoGenerator",
  "videoUrl": "http://example.com/video.mp4",
  "message": "视频生成成功！"
}
```

---

### 2.4 `service` - 服务插件

**用途**：常驻内存，提供持续性服务（HTTP 路由、WebSocket 等）。

**执行特征**：
- 使用 `direct` 协议，直接 require 模块
- 必须导出 `initialize` 和可选 `shutdown` 函数
- 可通过 `registerApiRoutes` 注册 Express 路由

**Manifest 示例**：
```json
{
  "manifestVersion": "1.0.0",
  "name": "ImageServer",
  "version": "1.0.0",
  "displayName": "图床服务",
  "description": "提供受密码保护的静态图片服务。",
  "author": "SystemMigration",
  "pluginType": "service",
  "entryPoint": {
    "type": "nodejs",
    "script": "image-server.js"
  },
  "communication": {
    "protocol": "direct"
  },
  "configSchema": {
    "Image_Key": "string",
    "File_Key": "string",
    "DebugMode": "boolean"
  },
  "capabilities": {
    "services": [
      {
        "serviceName": "ProtectedImageHosting",
        "description": "通过 /pw=[Image_Key]/images/... 路径提供图片服务。"
      }
    ]
  }
}
```

**模块接口**：
```javascript
// image-server.js
module.exports = {
  async initialize(config, dependencies) {
    // 初始化服务
  },
  
  registerApiRoutes(router, config, projectBasePath, webSocketServer) {
    // 注册 API 路由到 /api/plugins/ImageServer/...
    router.get('/images/:key/*', (req, res) => { ... });
  },
  
  async shutdown() {
    // 清理资源
  }
};
```

---

### 2.5 `messagePreprocessor` - 消息预处理器

**用途**：在消息发送给 LLM 前进行预处理（如图像理解、格式转换）。

**执行特征**：
- 使用 `direct` 协议
- 必须导出 `processMessages` 函数
- 执行顺序可通过 `preprocessor_order.json` 配置

**Manifest 示例**：
```json
{
  "manifestVersion": "1.0.0",
  "name": "ImageProcessor",
  "version": "1.1.0",
  "displayName": "多模态数据提取器",
  "description": "处理用户消息中的多模态数据（图像、音频、视频）。",
  "author": "System",
  "pluginType": "messagePreprocessor",
  "entryPoint": {
    "type": "nodejs",
    "script": "image-processor.js"
  },
  "communication": {
    "protocol": "direct"
  },
  "configSchema": {
    "API_URL": "string",
    "API_Key": "string",
    "MultiModalModel": "string"
  },
  "lifecycle": {
    "loadCache": "initialize",
    "saveCache": "shutdown"
  }
}
```

**模块接口**：
```javascript
// image-processor.js
module.exports = {
  async initialize(config, dependencies) {
    // 加载缓存
  },
  
  async processMessages(messages, config) {
    // 处理消息数组
    return processedMessages;
  },
  
  async shutdown() {
    // 保存缓存
  }
};
```

---

### 2.6 `hybridservice` - 混合服务插件

**用途**：同时具备静态占位符、消息预处理和工具调用能力。

**执行特征**：
- 使用 `direct` 协议
- 可同时实现 `processMessages`、`processToolCall` 和占位符
- 最灵活的插件类型

**Manifest 示例**：
```json
{
  "name": "ChromeBridge",
  "displayName": "Chrome 浏览器桥接器",
  "version": "2.0.0",
  "description": "混合插件：既能提供页面信息，又能执行浏览器控制命令。",
  "pluginType": "hybridservice",
  "entryPoint": {
    "script": "ChromeBridge.js"
  },
  "communication": {
    "protocol": "direct",
    "timeout": 30000
  },
  "capabilities": {
    "systemPromptPlaceholders": [
      {
        "placeholder": "{{VCPChromePageInfo}}",
        "description": "当前Chrome浏览器活动标签页内容",
        "isDynamic": true
      }
    ],
    "invocationCommands": [
      {
        "commandIdentifier": "ChromeControl",
        "description": "执行浏览器控制命令..."
      }
    ]
  }
}
```

**模块接口**：
```javascript
// ChromeBridge.js
module.exports = {
  async initialize(config, dependencies) { },
  
  async processMessages(messages, config) {
    // 预处理：注入页面信息
    return messages;
  },
  
  async processToolCall(args) {
    // 工具调用：执行浏览器命令
    return { status: "success", result: "..." };
  },
  
  async shutdown() { }
};
```

---

## 3. Manifest Schema 完整规范

### 3.1 顶层字段

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `manifestVersion` | string | 推荐 | Manifest 版本，如 `"1.0.0"` |
| `name` | string | **必需** | 插件内部标识名（唯一） |
| `displayName` | string | 推荐 | 显示名称 |
| `version` | string | 推荐 | 插件版本 |
| `description` | string | 推荐 | 插件描述 |
| `author` | string | 可选 | 作者信息 |
| `pluginType` | string | **必需** | 插件类型：`static`/`synchronous`/`asynchronous`/`service`/`messagePreprocessor`/`hybridservice` |
| `entryPoint` | object | **必需** | 执行入口定义 |
| `communication` | object | 推荐 | 通信协议配置 |
| `configSchema` | object | 可选 | 配置项定义 |
| `capabilities` | object | 可选 | 能力声明 |
| `dependencies` | object | 可选 | 外部依赖声明 |
| `requiresAdmin` | boolean | 可选 | 是否需要管理员授权 |
| `hasApiRoutes` | boolean | 可选 | 是否注册 API 路由 |
| `refreshIntervalCron` | string | static 必需 | 刷新周期（cron 表达式） |
| `lifecycle` | object | 可选 | 生命周期钩子 |
| `compatibility` | object | 可选 | 兼容性要求 |
| `changelog` | object | 可选 | 变更日志 |
| `systemIntegration` | object | 可选 | 系统集成配置 |

### 3.2 entryPoint 字段

```json
{
  "entryPoint": {
    "type": "nodejs" | "python" | "native",
    "command": "node script.js",    // stdio 协议使用
    "script": "script.js"           // direct 协议使用
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string | 运行时类型：`nodejs`/`python`/`native` |
| `command` | string | 完整执行命令（stdio 协议） |
| `script` | string | 脚本文件名（direct 协议） |

### 3.3 communication 字段

```json
{
  "communication": {
    "protocol": "stdio" | "direct",
    "timeout": 60000
  }
}
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `protocol` | string | - | 通信协议：`stdio`（进程通信）/ `direct`（内存调用） |
| `timeout` | number | 60000 (sync) / 1800000 (async) | 超时时间（毫秒） |

### 3.4 configSchema 字段

支持两种格式：

**简化格式**：
```json
{
  "configSchema": {
    "API_KEY": "string",
    "DebugMode": "boolean",
    "MaxRetries": "integer"
  }
}
```

**完整格式**：
```json
{
  "configSchema": {
    "API_KEY": {
      "type": "string",
      "description": "API 密钥",
      "default": "",
      "required": true
    },
    "DebugMode": {
      "type": "boolean",
      "description": "调试模式",
      "default": false,
      "required": false
    },
    "MaxRetries": {
      "type": "integer",
      "description": "最大重试次数",
      "default": 3
    }
  }
}
```

**支持类型**：
- `string` - 字符串
- `integer` - 整数
- `boolean` - 布尔值

### 3.5 capabilities 字段

```json
{
  "capabilities": {
    "systemPromptPlaceholders": [
      {
        "placeholder": "{{PlaceholderName}}",
        "description": "占位符描述",
        "isDynamic": false
      }
    ],
    "invocationCommands": [
      {
        "commandIdentifier": "CommandName",
        "description": "命令描述（支持 Markdown）",
        "example": "调用示例"
      }
    ],
    "services": [
      {
        "serviceName": "ServiceName",
        "description": "服务描述"
      }
    ]
  }
}
```

### 3.6 dependencies 字段

```json
{
  "dependencies": {
    "npm": ["ssh2", "dotenv"],
    "pip": ["requests", "numpy"],
    "system": ["ffmpeg", "imagemagick"]
  }
}
```

### 3.7 lifecycle 字段

```json
{
  "lifecycle": {
    "loadCache": "initialize",
    "saveCache": "shutdown"
  }
}
```

### 3.8 compatibility 字段

```json
{
  "compatibility": {
    "vcpVersion": ">=1.0.0",
    "nodeVersion": ">=14.0.0",
    "pythonVersion": ">=3.8"
  }
}
```

---

## 4. 配置级联机制

VCPToolBox 采用 **三层配置级联** 机制，优先级从高到低：

```
插件专属配置 (config.env) > 全局配置 (config.env) > Schema 默认值
```

### 4.1 配置合并流程

```javascript
// Plugin.js - _getPluginConfig 方法
_getPluginConfig(pluginManifest) {
    const config = {};
    const globalEnv = process.env;                           // 第 2 优先级
    const pluginSpecificEnv = pluginManifest.pluginSpecificEnvConfig || {}; // 第 1 优先级
    
    if (pluginManifest.configSchema) {
        for (const key in pluginManifest.configSchema) {
            const schemaEntry = pluginManifest.configSchema[key];
            const expectedType = (typeof schemaEntry === 'object') 
                ? schemaEntry.type 
                : schemaEntry;
            
            let rawValue;
            if (pluginSpecificEnv.hasOwnProperty(key)) {
                rawValue = pluginSpecificEnv[key];     // 优先使用插件专属配置
            } else if (globalEnv.hasOwnProperty(key)) {
                rawValue = globalEnv[key];             // 回退到全局配置
            } else {
                continue;  // 都没有则跳过，使用代码中的默认值
            }
            
            // 类型转换
            let value = rawValue;
            if (expectedType === 'integer') {
                value = parseInt(value, 10);
            } else if (expectedType === 'boolean') {
                value = String(value).toLowerCase() === 'true';
            }
            config[key] = value;
        }
    }
    return config;
}
```

### 4.2 配置示例

**全局配置** (`config.env`)：
```env
DEBUG_MODE=false
API_TIMEOUT=30000
```

**插件专属配置** (`Plugin/VSearch/config.env`)：
```env
DEBUG_MODE=true
VSearchKey=sk-xxx
VSearchUrl=https://api.example.com
```

**最终合并结果**：
```javascript
{
    DEBUG_MODE: true,       // 插件专属覆盖全局
    API_TIMEOUT: 30000,     // 使用全局值
    VSearchKey: 'sk-xxx',   // 插件专属
    VSearchUrl: 'https://api.example.com'  // 插件专属
}
```

### 4.3 环境变量注入

插件执行时会自动注入以下环境变量：

| 变量名 | 说明 |
|--------|------|
| `PROJECT_BASE_PATH` | 项目根路径 |
| `PORT` | 服务器端口 |
| `SERVER_PORT` | 服务器端口（别名） |
| `PYTHONIOENCODING` | Python UTF-8 编码（固定为 `utf-8`） |
| `CALLBACK_BASE_URL` | 异步插件回调地址 |
| `PLUGIN_NAME_FOR_CALLBACK` | 异步插件名称 |
| `VCP_REQUEST_IP` | 请求来源 IP |
| `DECRYPTED_AUTH_CODE` | 管理员授权码（requiresAdmin 时） |
| `IMAGESERVER_IMAGE_KEY` | 图床服务密钥 |

---

## 5. 插件生命周期

### 5.1 生命周期阶段

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   发现      │ → │   加载      │ → │   初始化    │ → │   执行      │
│  Discovery  │    │   Loading   │    │ Initialize  │    │  Execution  │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
                                                              ↓
                                                         ┌─────────────┐
                                                         │   关闭      │
                                                         │  Shutdown   │
                                                         └─────────────┘
```

### 5.2 发现阶段 (Discovery)

```javascript
// 1. 扫描 Plugin/ 目录
const pluginFolders = await fs.readdir(PLUGIN_DIR, { withFileTypes: true });

// 2. 查找 plugin-manifest.json
for (const folder of pluginFolders) {
    if (folder.isDirectory()) {
        const manifestPath = path.join(pluginPath, 'plugin-manifest.json');
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
        
        // 3. 基础验证
        if (!manifest.name || !manifest.pluginType || !manifest.entryPoint) {
            continue; // 跳过无效插件
        }
        
        // 4. 加载插件专属配置
        try {
            const pluginEnvContent = await fs.readFile(
                path.join(pluginPath, 'config.env'), 'utf-8'
            );
            manifest.pluginSpecificEnvConfig = dotenv.parse(pluginEnvContent);
        } catch (e) { /* 无配置文件 */ }
        
        // 5. 存储到 plugins Map
        this.plugins.set(manifest.name, manifest);
    }
}
```

### 5.3 加载阶段 (Loading)

**stdio 协议插件**：
- 不预加载，按需 spawn 子进程

**direct 协议插件**：
```javascript
if (manifest.entryPoint.script && manifest.communication?.protocol === 'direct') {
    const scriptPath = path.join(pluginPath, manifest.entryPoint.script);
    const module = require(scriptPath);
    
    // 存储模块引用
    if (manifest.pluginType === 'service' || manifest.pluginType === 'hybridservice') {
        this.serviceModules.set(manifest.name, { manifest, module });
    }
    if (manifest.pluginType === 'messagePreprocessor' || manifest.pluginType === 'hybridservice') {
        this.messagePreprocessors.set(manifest.name, module);
    }
}
```

### 5.4 初始化阶段 (Initialize)

```javascript
// 按预处理器顺序初始化
for (const pluginName of initializationOrder) {
    const item = allModulesMap.get(pluginName);
    if (!item || typeof item.module.initialize !== 'function') continue;
    
    const { manifest, module } = item;
    const initialConfig = this._getPluginConfig(manifest);
    
    // 注入运行时配置
    initialConfig.PORT = process.env.PORT;
    initialConfig.Key = process.env.Key;
    initialConfig.PROJECT_BASE_PATH = this.projectBasePath;
    
    // 构建依赖注入对象
    const dependencies = { 
        vcpLogFunctions: this.getVCPLogFunctions() 
    };
    
    // 特殊依赖注入
    if (manifest.name === 'RAGDiaryPlugin') {
        dependencies.vectorDBManager = this.vectorDBManager;
    }
    
    await module.initialize(initialConfig, dependencies);
}
```

### 5.5 执行阶段 (Execution)

详见 [第 6 章 - 执行模式](#6-执行模式)。

### 5.6 关闭阶段 (Shutdown)

```javascript
async shutdownAllPlugins() {
    // 1. 关闭 VectorDBManager
    if (this.vectorDBManager) {
        await this.vectorDBManager.shutdown();
    }
    
    // 2. 关闭消息预处理器
    for (const [name, module] of this.messagePreprocessors) {
        if (typeof module.shutdown === 'function') {
            await module.shutdown();
        }
    }
    
    // 3. 关闭服务模块
    for (const [name, serviceData] of this.serviceModules) {
        if (serviceData.module && typeof serviceData.module.shutdown === 'function') {
            await serviceData.module.shutdown();
        }
    }
    
    // 4. 取消所有定时任务
    for (const job of this.scheduledJobs.values()) {
        job.cancel();
    }
    this.scheduledJobs.clear();
}
```

---

## 6. 执行模式

### 6.1 stdio 模式

**适用插件类型**：`synchronous`、`asynchronous`、`static`

**执行流程**：
```
┌──────────┐    stdin     ┌──────────────┐    stdout    ┌──────────┐
│ Plugin   │ ──────────→ │  子进程      │ ──────────→ │ Plugin   │
│ Manager  │   JSON参数   │ (spawn)      │   JSON结果   │ Manager  │
└──────────┘              └──────────────┘              └──────────┘
```

**代码实现**：
```javascript
async executePlugin(pluginName, inputData, requestIp = null) {
    const plugin = this.plugins.get(pluginName);
    const pluginConfig = this._getPluginConfig(plugin);
    
    // 构建环境变量
    const envForProcess = { ...process.env, ...pluginConfig };
    
    // spawn 子进程
    const [command, ...args] = plugin.entryPoint.command.split(' ');
    const pluginProcess = spawn(command, args, {
        cwd: plugin.basePath,
        shell: true,
        env: envForProcess,
        windowsHide: true
    });
    
    // 发送输入
    if (inputData) {
        pluginProcess.stdin.write(inputData.toString());
        pluginProcess.stdin.end();
    }
    
    // 收集输出
    let outputBuffer = '';
    pluginProcess.stdout.on('data', (data) => {
        outputBuffer += data;
    });
    
    // 超时处理
    const timeout = plugin.communication.timeout || 60000;
    setTimeout(() => {
        if (!processExited) {
            pluginProcess.kill('SIGKILL');
        }
    }, timeout);
    
    return new Promise((resolve, reject) => {
        pluginProcess.on('exit', (code) => {
            const result = JSON.parse(outputBuffer);
            resolve(result);
        });
    });
}
```

### 6.2 direct 模式

**适用插件类型**：`service`、`messagePreprocessor`、`hybridservice`

**执行流程**：
```
┌──────────┐    require   ┌──────────────┐    调用方法   ┌──────────┐
│ Plugin   │ ──────────→ │  模块实例    │ ──────────→ │ Plugin   │
│ Manager  │             │ (内存引用)   │             │ Manager  │
└──────────┘              └──────────────┘              └──────────┘
```

**代码实现**：
```javascript
async processToolCall(toolName, toolArgs, requestIp = null) {
    const plugin = this.plugins.get(toolName);
    
    if (plugin.pluginType === 'hybridservice' && plugin.communication?.protocol === 'direct') {
        const serviceModule = this.getServiceModule(toolName);
        if (typeof serviceModule.processToolCall !== 'function') {
            throw new Error(`Plugin "${toolName}" does not have processToolCall function.`);
        }
        return await serviceModule.processToolCall(toolArgs);
    }
}
```

### 6.3 distributed 模式

**适用插件类型**：所有类型（透明代理）

**执行流程**：
```
┌──────────┐    WebSocket    ┌──────────────┐    本地执行    ┌──────────┐
│   主     │ ─────────────→ │  分布式节点  │ ─────────────→ │ 插件     │
│ 服务器   │                │              │                │ 进程     │
└──────────┘ ←───────────── └──────────────┘ ←───────────── └──────────┘
              结果返回
```

**代码实现**：
```javascript
async processToolCall(toolName, toolArgs, requestIp = null) {
    const plugin = this.plugins.get(toolName);
    
    if (plugin.isDistributed) {
        // 分布式插件：通过 WebSocket 转发
        if (!this.webSocketServer) {
            throw new Error('WebSocketServer not initialized.');
        }
        return await this.webSocketServer.executeDistributedTool(
            plugin.serverId, 
            toolName, 
            toolArgs
        );
    }
}
```

### 6.4 执行模式对比

| 模式 | 协议 | 进程模型 | 适用场景 | 热加载 |
|------|------|----------|----------|--------|
| stdio | 子进程通信 | 独立进程 | 一次性任务 | ✅ 支持 |
| direct | 内存调用 | 同进程 | 常驻服务 | ❌ 禁用 |
| distributed | WebSocket | 远程进程 | 分布式部署 | ✅ 支持 |

---

## 7. 静态插件占位符机制

### 7.1 占位符工作流程

```
┌─────────────┐    定时执行    ┌──────────────┐    更新    ┌────────────────┐
│  Cron       │ ────────────→ │  插件脚本    │ ────────→ │ Placeholder    │
│  Scheduler  │               │  (stdio)     │           │ Values Map     │
└─────────────┘               └──────────────┘           └────────────────┘
                                                              ↓
┌─────────────┐    替换        ┌──────────────┐           ┌────────────────┐
│  系统       │ ←──────────── │  提示词模板  │ ←───────── │ {{Placeholder}}│
│  提示词     │               │              │           │                │
└─────────────┘               └──────────────┘           └────────────────┘
```

### 7.2 占位符格式

**标准格式**：`{{PlaceholderName}}`

**使用示例**（系统提示词）：
```
当前天气：{{VCPWeatherInfo}}
日记内容：{{AllCharacterDiariesData}}
浏览器页面：{{VCPChromePageInfo}}
```

### 7.3 占位符存储

```javascript
// 存储格式
this.staticPlaceholderValues.set(placeholderKey, {
    value: "实际内容",
    serverId: "local" | "distributed_node_id"
});

// 获取方法
getPlaceholderValue(placeholder) {
    let entry = this.staticPlaceholderValues.get(placeholder);
    if (entry === undefined) {
        entry = this.staticPlaceholderValues.get(`{{${placeholder}}}`);
    }
    if (entry === undefined) {
        return `[Placeholder ${placeholder} not found]`;
    }
    return entry.value;
}
```

### 7.4 动态占位符

`hybridservice` 插件可提供动态占位符（`isDynamic: true`）：

```json
{
  "placeholder": "{{VCPChromePageInfo}}",
  "description": "当前Chrome页面内容",
  "isDynamic": true
}
```

动态占位符在每次请求时实时计算，而非定时刷新。

---

## 8. Python/Rust 集成

### 8.1 Python 插件

**Manifest 配置**：
```json
{
  "entryPoint": {
    "type": "python",
    "command": "python mcpo_plugin.py"
  }
}
```

**插件代码模板**：
```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import sys
import json

def main():
    # 读取 stdin 输入
    input_data = sys.stdin.read()
    
    try:
        if input_data:
            args = json.loads(input_data)
        else:
            args = {}
        
        # 执行插件逻辑
        result = process_request(args)
        
        # 输出 JSON 结果
        output = {
            "status": "success",
            "result": result
        }
        print(json.dumps(output, ensure_ascii=False))
        
    except Exception as e:
        output = {
            "status": "error",
            "error": str(e)
        }
        print(json.dumps(output, ensure_ascii=False), file=sys.stderr)

def process_request(args):
    # 插件核心逻辑
    return {"message": "Hello from Python!"}

if __name__ == "__main__":
    main()
```

**环境变量**：
- 自动注入 `PYTHONIOENCODING=utf-8`
- 可通过 `configSchema` 读取自定义配置

### 8.2 Rust 插件

**项目结构**：
```
Plugin/MIDITranslator/
├── plugin-manifest.json
├── MIDITranslator.js      # Node.js 包装层
├── src/
│   ├── lib.rs             # Rust 核心逻辑
│   └── Cargo.toml
└── target/
    └── release/
        └── midi_translator.dll  # 编译产物
```

**Manifest 配置**：
```json
{
  "manifestVersion": "1.0.0",
  "name": "MIDITranslator",
  "pluginType": "hybridservice",
  "entryPoint": {
    "type": "nodejs",
    "script": "MIDITranslator.js"
  },
  "communication": {
    "protocol": "direct"
  }
}
```

**Node.js 包装层**：
```javascript
// MIDITranslator.js
const path = require('path');

// 加载 Rust N-API 模块
const nativeModule = require(path.join(__dirname, 'target', 'release', 'midi_translator.node'));

module.exports = {
    async initialize(config, dependencies) {
        // 初始化
    },
    
    async processToolCall(args) {
        // 调用 Rust 函数
        const result = nativeModule.translate_midi(args.input);
        return { status: "success", result };
    }
};
```

**Rust N-API 示例**：
```rust
// src/lib.rs
use neon::prelude::*;

fn translate_midi(mut cx: FunctionContext) -> JsResult<JsObject> {
    let input = cx.argument::<JsString>(0)?.value(&mut cx);
    
    // Rust 核心逻辑
    let result = process_midi(&input);
    
    let obj = cx.empty_object();
    let status = cx.string("success");
    obj.set(&mut cx, "status", status)?;
    
    let data = cx.string(result);
    obj.set(&mut cx, "result", data)?;
    
    Ok(obj)
}

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    cx.export_function("translate_midi", translate_midi)?;
    Ok(())
}
```

### 8.3 多运行时对比

| 运行时 | 入口类型 | 通信协议 | 性能 | 适用场景 |
|--------|----------|----------|------|----------|
| Node.js | nodejs | stdio/direct | 中 | 通用插件 |
| Python | python | stdio | 低 | AI/数据处理 |
| Rust | native | direct | 高 | 高性能计算 |
| Shell | native | stdio | 低 | 系统命令 |

---

## 9. 插件分类索引

### 9.1 多媒体生成 (15 个)

| 插件名 | 类型 | 功能 |
|--------|------|------|
| DoubaoGen | synchronous | 豆包文生图/图生图 |
| FluxGen | synchronous | Flux 风格图片生成 |
| ComfyUIGen | synchronous | ComfyUI 工作流图像生成 |
| WebUIGen | synchronous | WebUI 云算力生图 |
| NovelAIGen | synchronous | NovelAI 动漫图片生成 |
| QwenImageGen | synchronous | 通义千问图片生成 |
| GeminiImageGen | synchronous | Gemini 图片生成 |
| DMXDoubaoGen | synchronous | 豆包图像编辑 |
| NanoBananaGen2 | synchronous | 纳米香蕉图像编辑 |
| ZImageGen | synchronous | 通用图像生成 |
| ZImageGen2 | synchronous | 通用图像生成 v2 |
| SunoGen | synchronous | Suno AI 音乐生成 |
| VideoGenerator | asynchronous | 视频生成 |
| GrokVideo | synchronous | Grok 视频生成 |

### 9.2 信息检索 (12 个)

| 插件名 | 类型 | 功能 |
|--------|------|------|
| VSearch | synchronous | VCP 语义并发搜索 |
| TavilySearch | synchronous | Tavily 网页搜索 |
| GoogleSearch | synchronous | Google 搜索 |
| SerpSearch | synchronous | SERP 搜索 |
| UrlFetch | synchronous | 网页内容抓取 |
| BilibiliFetch | synchronous | Bilibili 视频/评论抓取 |
| PubMedSearch | synchronous | PubMed 论文搜索 |
| ArxivDailyPapers | static | Arxiv 每日论文 |
| CrossRefDailyPapers | static | CrossRef 每日论文 |
| DeepWikiVCP | synchronous | DeepWiki 知识检索 |
| KarakeepSearch | synchronous | Karakeep 搜索 |
| KEGGSearch | synchronous | KEGG 生物数据库 |

### 9.3 文件操作 (8 个)

| 插件名 | 类型 | 功能 |
|--------|------|------|
| FileOperator | synchronous | 文件编辑/创建/删除 |
| FileServer | service | 静态文件服务 |
| FileTreeGenerator | static | 文件树生成 |
| FileListGenerator | static | 文件列表生成 |
| CodeSearcher | synchronous | 代码搜索 |
| VCPEverything | synchronous | 全文检索 |
| EmojiListGenerator | static | 表情包列表 |
| ProjectAnalyst | synchronous | 项目分析 |

### 9.4 系统控制 (10 个)

| 插件名 | 类型 | 功能 |
|--------|------|------|
| LinuxShellExecutor | synchronous | Linux Shell 执行 |
| PowerShellExecutor | synchronous | PowerShell 执行 |
| ChromeBridge | hybridservice | Chrome 浏览器控制 |
| CapturePreprocessor | messagePreprocessor | 屏幕截图 |
| PyScreenshot | synchronous | Python 截图 |
| PyCameraCapture | synchronous | 摄像头捕获 |
| LinuxLogMonitor | service | Linux 日志监控 |
| ScheduleManager | service | 日程管理 |
| ScheduleBriefing | static | 日程摘要 |
| FRPSInfoProvider | static | FRP 状态 |

### 9.5 日记与记忆 (8 个)

| 插件名 | 类型 | 功能 |
|--------|------|------|
| DailyNote | synchronous | 日记统一管理 |
| DailyNoteWrite | synchronous | 日记写入 |
| DailyNoteGet | static | 日记内容获取 |
| DailyNotePanel | service | 日记面板 |
| RAGDiaryPlugin | messagePreprocessor | RAG 记忆检索 |
| LightMemo | synchronous | 轻量记忆 |
| ThoughtClusterManager | service | 思维聚类管理 |
| SemanticGroupEditor | service | 语义组编辑 |

### 9.6 通讯与消息 (6 个)

| 插件名 | 类型 | 功能 |
|--------|------|------|
| AgentAssistant | service | Agent 通讯总线 |
| AgentMessage | synchronous | Agent 消息推送 |
| VCPLog | service | VCP 日志推送 |
| SynapsePusher | service | Synapse 推送 |
| VCPTavern | service | Tavern 上下文注入 |
| UserAuth | service | 用户认证 |

### 9.7 计算工具 (6 个)

| 插件名 | 类型 | 功能 |
|--------|------|------|
| SciCalculator | synchronous | 科学计算器 |
| Randomness | synchronous | 随机数生成 |
| TarotDivination | synchronous | 塔罗占卜 |
| AnimeFinder | synchronous | 动漫搜索 |
| ArtistMatcher | synchronous | 画师匹配 |
| SVCardFinder | synchronous | SV 卡牌查询 |

### 9.8 其他工具 (14 个)

| 插件名 | 类型 | 功能 |
|--------|------|------|
| WeatherReporter | static | 天气预报 |
| WeatherInfoNow | static | 实时天气 |
| DailyHot | static | 热点新闻 |
| WorkspaceInjector | static | 工作区注入 |
| TencentCOSBackup | synchronous | 腾讯云备份 |
| NCBIDatasets | synchronous | NCBI 数据集 |
| PaperReader | synchronous | 论文阅读 |
| FlashDeepSearch | synchronous | 深度搜索 |
| VCPForum | synchronous | VCP 论坛 |
| VCPForumLister | static | 论坛列表 |
| ImageProcessor | messagePreprocessor | 图像处理 |
| ImageServer | service | 图床服务 |
| MagiAgent | hybridservice | Magi 三贤者 |
| MIDITranslator | hybridservice | MIDI 翻译器 |

---

## 10. 开发者指南

### 10.1 创建新插件

**步骤 1：创建目录**
```bash
mkdir Plugin/MyPlugin
cd Plugin/MyPlugin
```

**步骤 2：创建 Manifest**
```json
// plugin-manifest.json
{
  "manifestVersion": "1.0.0",
  "name": "MyPlugin",
  "displayName": "我的插件",
  "version": "1.0.0",
  "description": "插件描述",
  "author": "Your Name",
  "pluginType": "synchronous",
  "entryPoint": {
    "type": "nodejs",
    "command": "node MyPlugin.js"
  },
  "communication": {
    "protocol": "stdio",
    "timeout": 60000
  },
  "configSchema": {
    "MY_API_KEY": {
      "type": "string",
      "description": "API 密钥",
      "required": true
    }
  },
  "capabilities": {
    "invocationCommands": [
      {
        "commandIdentifier": "MyCommand",
        "description": "命令描述，支持 **Markdown** 格式。\n参数:\n- param1 (string, 必需): 参数说明"
      }
    ]
  }
}
```

**步骤 3：实现插件逻辑**
```javascript
// MyPlugin.js
const fs = require('fs');

async function main() {
    // 读取 stdin
    let inputData = '';
    process.stdin.setEncoding('utf8');
    
    for await (const chunk of process.stdin) {
        inputData += chunk;
    }
    
    const args = inputData ? JSON.parse(inputData) : {};
    
    // 读取配置（从环境变量）
    const apiKey = process.env.MY_API_KEY;
    
    try {
        // 执行核心逻辑
        const result = await doSomething(args);
        
        // 输出结果
        console.log(JSON.stringify({
            status: "success",
            result: result
        }));
    } catch (error) {
        console.log(JSON.stringify({
            status: "error",
            error: error.message
        }));
    }
}

async function doSomething(args) {
    return { message: "Hello from MyPlugin!" };
}

main();
```

**步骤 4：创建配置模板**
```env
# config.env.example
MY_API_KEY=your_api_key_here
```

**步骤 5：测试**
```bash
# 测试执行
echo '{"param1": "test"}' | node MyPlugin.js

# 重启服务器加载插件
```

### 10.2 调试技巧

**启用调试模式**：
```env
# config.env
DebugMode=true
```

**查看插件日志**：
```javascript
// 使用 stderr 输出调试信息
console.error('[MyPlugin] Debug message');
```

**测试特定插件**：
```bash
# 直接执行插件脚本
cd Plugin/MyPlugin
echo '{"test": "data"}' | node MyPlugin.js
```

### 10.3 最佳实践

1. **配置安全**：永远不要在 manifest 中硬编码密钥
2. **错误处理**：始终返回标准 JSON 格式，包含 `status` 字段
3. **超时管理**：设置合理的 `timeout` 值
4. **日志规范**：使用 stderr 输出调试信息，stdout 仅输出 JSON 结果
5. **类型验证**：在插件入口验证参数类型
6. **文档完善**：在 `description` 中提供详细的参数说明

---

## 附录

### A. 文件扩展名约定

| 扩展名 | 说明 |
|--------|------|
| `.json` | JSON 文件 |
| `.js` | JavaScript |
| `.mjs` | ES Module JavaScript |
| `.py` | Python |
| `.rs` | Rust |
| `.block` | 禁用标记 |

### B. 环境变量优先级

```
插件 config.env > 全局 config.env > Schema default
```

### C. 热加载触发条件

- `plugin-manifest.json` 文件变更
- `plugin-manifest.json.block` 文件变更
- **例外**：`direct` 协议插件不触发热加载

### D. 相关文件

| 文件 | 说明 |
|------|------|
| `Plugin.js` | 插件管理器核心 |
| `preprocessor_order.json` | 预处理器顺序配置 |
| `WebSocketServer.js` | 分布式通信 |
| `FileFetcherServer.js` | 跨节点文件获取 |

---

**文档版本**：1.0.0  
**维护者**：VCP Team
