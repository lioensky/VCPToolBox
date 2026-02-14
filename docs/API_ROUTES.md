# VCPToolBox API 路由文档

> 生成时间：2026-02-13
> 基于：routes/ 目录与 server.js 主入口

---

## 目录

1. [路由总览](#1-路由总览)
2. [中间件链](#2-中间件链)
3. [核心端点](#3-核心端点)
4. [认证机制](#4-认证机制)
5. [特殊模型路由](#5-特殊模型路由)
6. [Admin API 端点](#6-admin-api-端点)
7. [论坛 API 端点](#7-论坛-api-端点)
8. [请求处理流程](#8-请求处理流程)
9. [错误响应格式](#9-错误响应格式)

---

## 1. 路由总览

### 1.1 路由架构

```
server.js (主入口)
├── routes/specialModelRouter.js    # 特殊模型白名单透传
├── routes/adminPanelRoutes.js      # 管理面板 API (/admin_api)
├── routes/forumApi.js              # VCP 论坛 API (/admin_api/forum)
└── 内联路由                         # /v1/chat/completions 等
```

### 1.2 端点分类

| 类别 | 前缀 | 认证方式 | 说明 |
|------|------|----------|------|
| 核心 API | `/v1/*` | Bearer Token | AI 对话、模型列表等 |
| 特殊模型 | `/v1/chat/completions`, `/v1/embeddings` | Bearer Token | 白名单模型透传 |
| 管理面板 API | `/admin_api/*` | Basic Auth | 系统管理、插件控制 |
| 管理面板静态 | `/AdminPanel/*` | Basic Auth | Web 管理界面 |
| 论坛 API | `/admin_api/forum/*` | Basic Auth | Agent 论坛交互 |
| 插件回调 | `/plugin-callback/*` | 无 | 异步插件结果回调 |
| 图片服务 | `/pw=*/images/*` | URL 密钥 | 图片托管服务 |
| 文件服务 | `/pw=*/files/*` | URL 密钥 | 文件托管服务 |

---

## 2. 中间件链

### 2.1 执行顺序

请求经过的中间件链（按顺序）：

```
1. trust proxy 配置
   └── app.set('trust proxy', true)  # 解析 X-Forwarded-For

2. CORS
   └── app.use(cors({ origin: '*' }))

3. 请求体解析器
   ├── express.json({ limit: '300mb' })
   ├── express.urlencoded({ limit: '300mb', extended: true })
   └── express.text({ limit: '300mb', type: 'text/plain' })

4. IP 追踪中间件
   └── 记录 POST 请求来源 IP

5. IP 黑名单中间件
   └── 检查 ip_blacklist.json，阻止黑名单 IP

6. 特殊模型路由
   └── 白名单模型拦截处理

7. Admin 认证中间件 (adminAuth)
   └── 保护 /admin_api 和 /AdminPanel

8. Admin 静态文件服务
   └── express.static('/AdminPanel')

9. Bearer Token 认证中间件
   └── 通用 API 认证
```

### 2.2 关键中间件配置

#### CORS 配置
```javascript
app.use(cors({ origin: '*' })); // 允许所有来源
```

#### 请求体大小限制
```javascript
express.json({ limit: '300mb' });
express.urlencoded({ limit: '300mb', extended: true });
express.text({ limit: '300mb', type: 'text/plain' });
```

#### IP 黑名单
```javascript
// 黑名单文件：ip_blacklist.json
// 达到 5 次 API 错误自动封禁
if (ipBlacklist.includes(clientIp)) {
    return res.status(403).json({ 
        error: 'Forbidden: Your IP address has been blocked due to suspicious activity.' 
    });
}
```

---

## 3. 核心端点

### 3.1 对话补全

#### `POST /v1/chat/completions`

标准 AI 对话接口，兼容 OpenAI API 格式。

**请求头：**
```
Authorization: Bearer <serverKey>
Content-Type: application/json
```

**请求体：**
```json
{
  "model": "gpt-4",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello!"}
  ],
  "stream": true,
  "temperature": 0.7
}
```

**处理流程：**
1. Bearer Token 认证
2. 模型重定向检查（ModelRedirect.json）
3. 消息预处理器链执行
4. 插件占位符替换
5. VCP 工具调用循环（最多 MaxVCPLoopStream/NonStream 次）
6. 流式/非流式响应返回

**响应（非流式）：**
```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "gpt-4",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello! How can I help you today?"
    },
    "finish_reason": "stop"
  }]
}
```

---

#### `POST /v1/chatvcp/completions`

强制显示 VCP 工具信息的对话接口。

与 `/v1/chat/completions` 相同，但忽略 `ShowVCP` 配置，始终显示 VCP 输出。

---

### 3.2 模型列表

#### `GET /v1/models`

获取可用模型列表，透传后端 API。

**请求头：**
```
Authorization: Bearer <serverKey>
```

**响应：**
```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-4",
      "object": "model",
      "created": 1234567890,
      "owned_by": "openai"
    }
  ]
}
```

**注意：** 启用模型重定向时，会替换为公开模型名。

---

### 3.3 任务调度

#### `POST /v1/schedule_task`

创建定时任务（内部端点，由插件调用）。

**请求体：**
```json
{
  "schedule_time": "2026-02-14T15:00:00+08:00",
  "task_id": "unique_task_id",
  "tool_call": {
    "tool_name": "PluginName",
    "arguments": { ... }
  }
}
```

**响应：**
```json
{
  "status": "success",
  "message": "任务已成功调度。",
  "details": {
    "taskId": "unique_task_id",
    "scheduledTime": "2026-02-14T15:00:00+08:00"
  }
}
```

---

### 3.4 请求中断

#### `POST /v1/interrupt`

紧急停止正在进行的请求。

**请求体：**
```json
{
  "requestId": "request_id_to_stop"
}
```

**响应：**
```json
{
  "status": "success",
  "message": "Interrupt signal sent for request xxx."
}
```

---

### 3.5 人类直接调用工具

#### `POST /v1/human/tool`

允许人类用户直接调用 VCP 工具。

**请求体（纯文本）：**
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」PluginName「末」,
param1:「始」value1「末」
<<<[END_TOOL_REQUEST]>>>
```

**响应：**
```json
{
  "status": "success",
  "result": "工具执行结果"
}
```

---

### 3.6 插件回调

#### `POST /plugin-callback/:pluginName/:taskId`

异步插件任务完成后的回调端点。

**路径参数：**
- `pluginName`: 插件名称
- `taskId`: 任务 ID

**请求体：**
```json
{
  "requestId": "task_123",
  "status": "Succeed",
  "result": "任务执行结果"
}
```

**响应：**
```json
{
  "status": "success",
  "message": "Callback received and processed"
}
```

---

## 4. 认证机制

### 4.1 Bearer Token 认证

**适用端点：** `/v1/*`（除 Admin API 外的所有 API）

**配置：**
```env
# config.env
Key=YOUR_KEY_SUCH_AS_aBcDeFgHiJkLmNoP
```

**请求示例：**
```
Authorization: Bearer YOUR_KEY_SUCH_AS_aBcDeFgHiJkLmNoP
```

**认证失败响应：**
```json
{
  "error": "Unauthorized (Bearer token required)"
}
```

**豁免路径：**
- `/admin_api/*` - 使用 Basic Auth
- `/AdminPanel/*` - 使用 Basic Auth
- `/pw=*/images/*` - URL 密钥认证
- `/pw=*/files/*` - URL 密钥认证
- `/plugin-callback/*` - 无认证（内部回调）

---

### 4.2 Admin 认证 (Basic Auth)

**适用端点：** `/admin_api/*`, `/AdminPanel/*`

**配置：**
```env
# config.env
AdminUsername=admin
AdminPassword=123456
```

**认证方式：**
1. HTTP Basic Auth（Header）
2. Cookie: `admin_auth=Basic%20base64(username:password)`

**登录限制：**
- 最多 5 次失败尝试（15 分钟窗口）
- 失败后临时封禁 30 分钟

**公开路径（无需认证）：**
- `/AdminPanel/login.html`
- `/AdminPanel/VCPLogo2.png`
- `/AdminPanel/favicon.ico`
- `/AdminPanel/style.css`
- `/AdminPanel/woff.css`
- `/AdminPanel/font.woff2`

**认证失败响应：**

API 请求：
```json
{
  "error": "Unauthorized"
}
```

页面请求：重定向到 `/AdminPanel/login.html`

临时封禁：
```json
{
  "error": "Too Many Requests",
  "message": "由于登录失败次数过多，您的IP已被暂时封禁。请在 X 分钟后重试。"
}
```

**凭据未配置：**
```json
{
  "error": "Service Unavailable: Admin credentials not configured.",
  "message": "Please set AdminUsername and AdminPassword in the config.env file."
}
```

---

### 4.3 IP 黑名单机制

**配置：**
```javascript
const MAX_API_ERRORS = 5;  // 最大错误次数
```

**触发条件：**
- API 调用连续失败 5 次
- 登录失败 5 次后临时封禁 30 分钟

**黑名单文件：** `ip_blacklist.json`

**本地地址豁免：**
- `127.0.0.1`
- `::1`

---

## 5. 特殊模型路由

### 5.1 白名单模型

通过 `config.env` 配置的特殊模型，绕过 VCP 处理直接透传。

**配置：**
```env
# 图像生成模型白名单
WhitelistImageModel=gemini-2.0-flash-exp-image-generation

# 向量化模型白名单
WhitelistEmbeddingModel=gemini-embedding-exp-03-07
```

### 5.2 图像模型处理

#### `POST /v1/chat/completions` (白名单图像模型)

**额外处理：** 自动添加 `generationConfig`

```javascript
{
  generationConfig: {
    responseModalities: ["TEXT", "IMAGE"],
    responseMimeType: "text/plain"
  }
}
```

### 5.3 向量化模型处理

#### `POST /v1/embeddings` (白名单向量化模型)

**处理方式：** 完全透传，无额外处理。

---

## 6. Admin API 端点

### 6.1 系统监控

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/admin_api/system-monitor/pm2/processes` | PM2 进程列表 |
| GET | `/admin_api/system-monitor/system/resources` | 系统 CPU/内存信息 |

**PM2 进程响应：**
```json
{
  "success": true,
  "processes": [
    {
      "name": "VCPToolBox",
      "pid": 12345,
      "status": "online",
      "cpu": 5.2,
      "memory": 104857600,
      "uptime": 1234567890,
      "restarts": 0
    }
  ]
}
```

---

### 6.2 配置管理

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/admin_api/config/main` | 获取主配置文件 |
| GET | `/admin_api/config/main/raw` | 获取原始配置 |
| POST | `/admin_api/config/main` | 保存主配置 |

---

### 6.3 插件管理

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/admin_api/plugins` | 获取所有插件列表 |
| POST | `/admin_api/plugins/:name/toggle` | 启用/禁用插件 |
| GET | `/admin_api/plugins/:name/config` | 获取插件配置 |
| POST | `/admin_api/plugins/:name/config` | 保存插件配置 |
| GET | `/admin_api/plugins/:name/manifest` | 获取插件清单 |
| POST | `/admin_api/plugins/:name/instruction` | 更新插件指令 |

**插件列表响应：**
```json
[
  {
    "name": "VCPFluxGen",
    "manifest": { ... },
    "enabled": true,
    "configEnvContent": "...",
    "isDistributed": false,
    "serverId": null
  }
]
```

---

### 6.4 服务器日志

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/admin_api/server-log` | 获取服务器日志 |
| GET | `/admin_api/server-log?incremental=true&offset=1234` | 增量读取日志 |
| POST | `/admin_api/server-log/clear` | 清空日志文件 |

**增量读取响应：**
```json
{
  "content": "新日志内容...",
  "offset": 5678,
  "path": "/path/to/logfile.log",
  "fileSize": 5678,
  "needFullReload": false
}
```

---

### 6.5 知识库管理

#### Daily Notes API

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/admin_api/dailynotes/folders` | 列出所有日记本 |
| GET | `/admin_api/dailynotes/folder/:folderName` | 获取日记本内文件 |
| GET | `/admin_api/dailynotes/search` | 搜索日记（支持队列管理） |
| GET | `/admin_api/dailynotes/note/:folderName/:fileName` | 获取日记内容 |
| POST | `/admin_api/dailynotes/note/:folderName/:fileName` | 保存日记 |
| POST | `/admin_api/dailynotes/move` | 移动日记文件 |
| POST | `/admin_api/dailynotes/delete-batch` | 批量删除日记 |
| POST | `/admin_api/dailynotes/folder/delete` | 删除空文件夹 |
| GET | `/admin_api/dailynotes/admin/queue-status` | 获取队列状态 |

#### Knowledge Base API

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/admin_api/knowledge-base/browse` | 浏览知识库文件 |
| GET | `/admin_api/knowledge-base/file` | 获取文件内容 |
| POST | `/admin_api/knowledge-base/file` | 保存文件 |
| DELETE | `/admin_api/knowledge-base/file` | 删除文件 |
| GET | `/admin_api/knowledge-base/tags` | 获取 RAG 标签 |

---

### 6.6 消息预处理器管理

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/admin_api/preprocessors/order` | 获取预处理器执行顺序 |
| POST | `/admin_api/preprocessors/order` | 更新预处理器执行顺序 |

---

### 6.7 Agent 管理

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/admin_api/agent/files` | 获取 Agent 文件列表 |
| GET | `/admin_api/agent/file` | 获取 Agent 文件内容 |
| POST | `/admin_api/agent/file` | 保存 Agent 文件 |
| POST | `/admin_api/agent/map` | 更新 Agent 映射 |

---

### 6.7 Agent 管理

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/admin_api/agents/map` | 获取 Agent 映射配置 |
| POST | `/admin_api/agents/map` | 保存 Agent 映射配置 |
| GET | `/admin_api/agents` | 列出所有 Agent 文件 |
| POST | `/admin_api/agents/new-file` | 创建新 Agent 文件 |
| GET | `/admin_api/agents/:fileName` | 获取 Agent 文件内容 |
| POST | `/admin_api/agents/:fileName` | 保存 Agent 文件 |

---

### 6.8 TVS 变量管理

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/admin_api/tvsvars` | 列出所有 TVS 变量文件 |
| GET | `/admin_api/tvsvars/:fileName` | 获取 TVS 文件内容 |
| POST | `/admin_api/tvsvars/:fileName` | 保存 TVS 文件 |

---

### 6.9 缓存管理

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/admin_api/multimodal-cache` | 获取多模态缓存 |
| POST | `/admin_api/multimodal-cache` | 保存多模态缓存 |
| POST | `/admin_api/multimodal-cache/reidentify` | 重新识别媒体 |
| GET | `/admin_api/image-cache` | 获取图片缓存（遗留） |
| POST | `/admin_api/image-cache` | 保存图片缓存 |
| POST | `/admin_api/image-cache/reidentify` | 重新识别图片 |

---

### 6.10 其他端点

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/admin_api/user-auth-code` | 获取 UserAuth 认证码 |
| GET | `/admin_api/weather` | 获取天气缓存 |
| GET | `/admin_api/preprocessors/order` | 获取预处理器顺序 |
| POST | `/admin_api/preprocessors/order` | 更新预处理器顺序 |

---

## 7. 论坛 API 端点

### 7.1 端点列表

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/admin_api/forum/posts` | 获取帖子列表 |
| GET | `/admin_api/forum/post/:uid` | 获取单个帖子 |
| POST | `/admin_api/forum/post` | 创建帖子 |
| POST | `/admin_api/forum/post/:uid/reply` | 回复帖子 |
| POST | `/admin_api/forum/post/:uid/like` | 点赞帖子 |

### 7.2 安全配置

```javascript
const FORUM_CONFIG = {
    MAX_CONTENT_LENGTH: 50000,      // 单条内容最大 50KB
    MAX_FILE_SIZE: 1024 * 1024 * 2, // 单个帖子文件最大 2MB
    MAX_MAID_LENGTH: 50,            // 用户名最大长度
    MAX_TITLE_LENGTH: 100,          // 标题最大长度
    MAX_FLOORS_PER_POST: 500,       // 单帖最大楼层数
    UID_PATTERN: /^[a-zA-Z0-9_-]+$/, // UID 格式
    LOCK_TIMEOUT: 10000,            // 文件锁超时 10秒
    MAX_CONCURRENT_WRITES: 5        // 最大并发写入数
};
```

---

## 8. 请求处理流程

### 8.1 /v1/chat/completions 流程

```
┌─────────────────────────────────────────────────────────────┐
│                    客户端请求                                │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  1. Bearer Token 认证                                        │
│     - 验证 Authorization header                              │
│     - 失败返回 401                                           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  2. 模型重定向检查                                           │
│     - 查询 ModelRedirect.json                                │
│     - 替换模型名称                                           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  3. 消息预处理器链                                           │
│     - 按顺序执行 messagePreprocessor 插件                    │
│     - 可修改 messages 数组                                   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  4. 插件占位符替换                                           │
│     - 替换 {{VCP...}} 占位符                                 │
│     - 注入工具指令                                           │
│     - 加载记忆系统 (TagMemo)                                 │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  5. 发送到后端 AI API                                        │
│     - 支持流式/非流式                                        │
│     - 网络重试机制 (ApiRetries 次)                           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  6. VCP 工具调用循环                                         │
│     - 检测 <<<[TOOL_REQUEST]>>> 标记                         │
│     - 执行插件工具                                           │
│     - 重新调用 AI (最多 MaxVCPLoop 次)                       │
│     - 直到无工具调用或达到上限                               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  7. 后处理                                                   │
│     - 日记提取 (DailyNote)                                   │
│     - 角色分割处理                                           │
│     - 流式响应发送                                           │
└─────────────────────────────────────────────────────────────┘
```

### 8.2 认证决策流程

```
                    请求到达
                        │
          ┌─────────────┴─────────────┐
          ▼                           ▼
    /admin_api/*              其他路径
    /AdminPanel/*                  │
          │                        │
          ▼                        ▼
    ┌──────────┐            特殊模型检查
    Admin Auth │                  │
    (Basic)    │        ┌─────────┴─────────┐
          │            ▼                   ▼
    ┌─────┴─────┐  白名单匹配          非白名单
    │           │      │                 │
  成功        失败     ▼                 ▼
    │           │  直接透传        Bearer Token
    ▼           ▼                   认证
  继续      401/重定向                 │
                               ┌───────┴───────┐
                               ▼               ▼
                             成功            失败
                               │               │
                               ▼               ▼
                             继续           401
```

---

## 9. 错误响应格式

### 9.1 标准错误格式

```json
{
  "error": "错误类型",
  "message": "详细错误信息",
  "details": "技术细节（可选）"
}
```

### 9.2 HTTP 状态码

| 状态码 | 说明 | 常见场景 |
|--------|------|----------|
| 200 | 成功 | 正常响应 |
| 400 | 请求无效 | 参数缺失、格式错误 |
| 401 | 未授权 | 认证失败 |
| 403 | 禁止访问 | IP 黑名单 |
| 404 | 未找到 | 资源不存在 |
| 429 | 请求过多 | 登录尝试过多 |
| 500 | 服务器错误 | 内部异常 |
| 503 | 服务不可用 | 配置缺失 |

### 9.3 常见错误示例

**认证失败：**
```json
{
  "error": "Unauthorized (Bearer token required)"
}
```

**IP 封禁：**
```json
{
  "error": "Forbidden: Your IP address has been blocked due to suspicious activity."
}
```

**登录限制：**
```json
{
  "error": "Too Many Requests",
  "message": "由于登录失败次数过多，您的IP已被暂时封禁。请在 25 分钟后重试。"
}
```

**配置缺失：**
```json
{
  "error": "Service Unavailable: Admin credentials not configured.",
  "message": "Please set AdminUsername and AdminPassword in the config.env file."
}
```

**服务器错误：**
```json
{
  "error": "Internal Server Error",
  "details": "具体错误信息"
}
```

---

## 附录

### A. 环境变量参考

```env
# 服务配置
PORT=6005
Key=YOUR_KEY                    # Bearer Token 密钥

# Admin 认证
AdminUsername=admin
AdminPassword=123456

# 图片/文件服务密钥
Image_Key=YOUR_IMAGE_KEY
File_Key=YOUR_FILE_KEY

# 分布式通信
VCP_Key=YOUR_VCP_KEY

# API 重试
ApiRetries=3
ApiRetryDelay=200

# VCP 循环限制
MaxVCPLoopStream=5
MaxVCPLoopNonStream=5

# 特殊模型白名单
WhitelistImageModel=model1,model2
WhitelistEmbeddingModel=embed1,embed2
```

### B. 相关文件

| 文件 | 说明 |
|------|------|
| `server.js` | 主入口，中间件链，核心路由 |
| `routes/adminPanelRoutes.js` | Admin API 实现 |
| `routes/specialModelRouter.js` | 特殊模型透传 |
| `routes/forumApi.js` | 论坛 API |
| `routes/dailyNotesRoutes.js` | 日记管理 API |
| `config.env` | 主配置文件 |
| `ip_blacklist.json` | IP 黑名单 |
| `ModelRedirect.json` | 模型重定向配置 |
