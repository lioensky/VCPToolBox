# VCPToolBox 前端组件文档

**生成时间：** 2026-02-13
**版本：** VCP 6.4

---

## 目录

1. [概述](#1-概述)
2. [AdminPanel 管理面板](#2-adminpanel-管理面板)
3. [VCPChrome 浏览器扩展](#3-vcpchrome-浏览器扩展)
4. [OpenWebUISub 用户脚本](#4-openwebuisub-用户脚本)
5. [前后端通信协议](#5-前后端通信协议)
6. [构建与部署](#6-构建与部署)
7. [安全注意事项](#7-安全注意事项)

---

## 1. 概述

VCPToolBox 前端生态由三个核心组件构成：

| 组件 | 类型 | 主要功能 | 技术栈 |
|------|------|----------|--------|
| AdminPanel | 内嵌静态前端 | 服务器管理、配置、监控 | 原生 JS/CSS、EasyMDE |
| VCPChrome | Chrome 扩展 | 浏览器控制、页面信息采集 | Manifest V3、Service Worker |
| OpenWebUISub | 用户脚本 | 前端增强、VCP 协议渲染 | Tampermonkey/Greasemonkey |

### 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户界面层                                │
├─────────────────┬───────────────────┬───────────────────────────┤
│   AdminPanel    │    VCPChrome      │    OpenWebUISub           │
│   (管理面板)     │   (浏览器扩展)     │    (用户脚本)              │
│                 │                   │                           │
│  - 系统监控      │  - 页面监控        │  - ToolCall 渲染          │
│  - 配置管理      │  - 远程控制        │  - DailyNote 渲染         │
│  - 插件管理      │  - 信息采集        │  - 图片渲染增强            │
│  - 知识库编辑    │                   │  - 侧边栏面板              │
└────────┬────────┴─────────┬─────────┴──────────────┬────────────┘
         │                  │                        │
         │ HTTP/WS          │ WebSocket              │ GM_xmlhttpRequest
         │ /admin_api       │ /vcp-chrome-*          │ 跨域代理
         ▼                  ▼                        ▼
┌─────────────────────────────────────────────────────────────────┐
│                    VCPToolBox 后端服务                           │
│                    (Node.js + Express)                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. AdminPanel 管理面板

### 2.1 架构概览

AdminPanel 是由后端直接托管的内嵌静态前端，**并非独立 SPA 工程**。采用原生 JavaScript 模块化设计，无需前端打包工具。

### 2.2 目录结构

```
AdminPanel/
├── index.html              # 主页面、布局与第三方资源引入
├── login.html              # 登录页面
├── script.js               # 前端入口与分区路由
├── style.css               # 主样式文件（CSS 变量驱动）
├── woff.css                # 字体样式
│
├── js/                     # 前端业务模块
│   ├── utils.js            # 通用工具函数（apiFetch、showMessage）
│   ├── config.js           # 配置解析与表单构建
│   ├── dashboard.js        # 仪表盘模块（系统监控）
│   ├── plugins.js          # 插件列表与配置管理
│   ├── notes-manager.js    # 日记知识库管理
│   ├── agent-manager.js    # Agent 映射管理
│   ├── agent-assistant-config.js  # AgentAssistant 配置
│   ├── tvs-editor.js       # 高级变量编辑器
│   ├── log-viewer.js       # 服务器日志查看
│   ├── preprocessor-manager.js    # 预处理器顺序管理
│   ├── semantic-groups-editor.js  # 语义组编辑器
│   ├── thinking-chains-editor.js  # 思维链编辑器
│   ├── forum.js            # VCP 论坛模块
│   ├── schedule-manager.js # 日程管理
│   └── rag-tuning.js       # RAG 算法调参
│
├── vcptavern_editor.*      # VCPTavern 预设编辑器（独立页面）
├── tool_list_editor.*      # 工具列表配置编辑器（独立页面）
├── rag_tags_editor.*       # RAG 标签编辑器（独立页面）
├── image_cache_editor.*    # 多媒体缓存编辑器（独立页面）
│
├── easymde.min.js          # EasyMDE Markdown 编辑器
├── easymde.min.css         # EasyMDE 样式
├── marked.min.js           # Markdown 渲染器
├── font.woff2              # 自定义字体
├── woff.css                # 字体声明
├── favicon.ico             # 网站图标
└── VCPLogo2.png            # VCP Logo
```

### 2.3 模块职责

#### 2.3.1 核心入口 (`script.js`)

```javascript
// 模块导入
import { apiFetch, showMessage, checkAuthStatus } from './js/utils.js';
import { loadPluginList, loadPluginConfig } from './js/plugins.js';
import { initializeDashboard, stopDashboardUpdates } from './js/dashboard.js';
// ... 其他模块

// API 基础路径
const API_BASE_URL = '/admin_api';

// 导航路由
function navigateTo(dataTarget) {
    // 停止可能正在运行的定时器
    stopDashboardUpdates();
    stopServerLogUpdates();
    
    // 根据 sectionId 初始化对应的模块
    switch (sectionIdToActivate) {
        case 'dashboard-section':
            initializeDashboard();
            break;
        case 'daily-notes-manager-section':
            initializeDailyNotesManager();
            break;
        // ... 其他模块
    }
}
```

#### 2.3.2 工具函数 (`js/utils.js`)

| 函数 | 用途 |
|------|------|
| `apiFetch(url, options, showLoader)` | 封装的 fetch 请求，自动处理认证失效跳转 |
| `showMessage(message, type, duration)` | 消息弹窗显示 |
| `showLoading(show)` | 加载覆盖层控制 |
| `checkAuthStatus()` | 验证当前认证状态 |

```javascript
// apiFetch 核心实现
export async function apiFetch(url, options = {}, showLoader = true) {
    const defaultHeaders = { 'Content-Type': 'application/json' };
    options.headers = { ...defaultHeaders, ...options.headers };
    options.credentials = options.credentials || 'same-origin';
    
    const response = await fetch(url, options);
    if (response.status === 401) {
        window.location.href = '/AdminPanel/login.html';
        return new Promise(() => {}); // 中断后续逻辑
    }
    // ... 错误处理与响应解析
}
```

#### 2.3.3 仪表盘 (`js/dashboard.js`)

| 功能 | API 端点 | 更新频率 |
|------|----------|----------|
| CPU/内存监控 | `/admin_api/system-monitor/system/resources` | 5s |
| PM2 进程状态 | `/admin_api/system-monitor/pm2/processes` | 5s |
| 用户认证码 | `/admin_api/user-auth-code` | 5s |
| 天气预报 | `/admin_api/weather` | 5s |
| 日程挂件 | 本地数据 | 5s |
| 活动图表 | `/admin_api/server-log` | 5s |

### 2.4 API 通信

所有 AdminPanel API 请求都通过 `/admin_api` 前缀：

| 端点 | 方法 | 用途 |
|------|------|------|
| `/check-auth` | GET | 验证认证状态 |
| `/config/main` | GET/POST | 读取/保存全局配置 |
| `/server-log` | GET | 获取服务器日志 |
| `/server/restart` | POST | 重启服务器 |
| `/user-auth-code` | GET | 获取用户认证码 |
| `/weather` | GET | 获取天气数据 |
| `/system-monitor/*` | GET | 系统监控数据 |
| `/forum/*` | * | 论坛相关操作 |

### 2.5 主题系统

采用 CSS 变量驱动，支持亮色/暗色主题切换：

```css
/* style.css 中的核心变量 */
:root {
    --primary-color: #8ab4f8;
    --background-color: #0d0d0d;
    --background-color-light: #1a1a1a;
    --text-color-primary: #e5e7eb;
    --text-color-secondary: #9ca3af;
    --border-color: #333333;
}

[data-theme="light"] {
    --primary-color: #1a73e8;
    --background-color: #ffffff;
    --background-color-light: #f9fafb;
    --text-color-primary: #1f2937;
    --text-color-secondary: #6b7280;
    --border-color: #e5e7eb;
}
```

### 2.6 认证机制

采用 HTTP Basic Auth + Cookie Session：

1. **登录流程**：`login.html` → 提交凭据 → 服务器设置 HttpOnly Cookie
2. **状态验证**：前端调用 `/admin_api/check-auth` 验证 Cookie 有效性
3. **失效处理**：401 响应自动重定向到登录页

```javascript
// 登录验证（后端 routes/adminPanelRoutes.js）
adminApiRouter.get('/check-auth', (req, res) => {
    // 通过 HTTP Basic Auth 或 Session Cookie 验证
    if (isAuthenticated) {
        res.status(200).json({ authenticated: true });
    } else {
        res.status(401).json({ authenticated: false });
    }
});
```

扩展管理面板（新增分区、接口、模块）的步骤与约定见 [ADMINPANEL_DEVELOPMENT.md](./ADMINPANEL_DEVELOPMENT.md)。

---

## 3. VCPChrome 浏览器扩展

### 3.1 架构概览

VCPChrome 是一个 Manifest V3 Chrome 扩展，提供浏览器远程控制和页面信息采集能力。

### 3.2 目录结构

```
VCPChrome/
├── manifest.json            # 扩展清单
├── background.js            # Service Worker（后台脚本）
├── content_script.js        # 内容脚本（注入页面）
├── popup.html               # 弹窗页面
├── popup.js                 # 弹窗脚本
└── icons/
    ├── icon16.png
    ├── icon48.png
    ├── icon128.png
    └── icon_disconnected.png
```

### 3.3 manifest.json 配置

```json
{
    "manifest_version": 3,
    "name": "VCP Chrome Control",
    "version": "1.0.0",
    "description": "连接到VCP服务器，允许AI代理与您的浏览器交互。",
    
    "permissions": [
        "storage",      // 存储配置和状态
        "activeTab",    // 访问当前标签页
        "scripting"     // 动态脚本注入
    ],
    
    "host_permissions": [
        "<all_urls>"    // 访问所有网站
    ],
    
    "background": {
        "service_worker": "background.js"  // Manifest V3 后台脚本
    },
    
    "action": {
        "default_popup": "popup.html",
        "default_icon": { /* ... */ }
    },
    
    "content_scripts": [
        {
            "matches": ["<all_urls>"],
            "js": ["content_script.js"]
        }
    ]
}
```

### 3.4 权限说明

| 权限 | 用途 | 风险等级 |
|------|------|----------|
| `storage` | 存储服务器URL、VCP_Key、监控状态 | 低 |
| `activeTab` | 访问当前活动标签页内容 | 中 |
| `scripting` | 动态注入 content_script | 中 |
| `<all_urls>` | 在所有网站运行 content_script | 高 |

### 3.5 核心组件

#### 3.5.1 Background Service Worker (`background.js`)

**核心职责**：
- WebSocket 连接管理
- 消息路由（Chrome ↔ VCP 服务器）
- 标签页事件监听
- 心跳保活

```javascript
// WebSocket 连接
function connect() {
    const serverUrlToUse = result.serverUrl || 'ws://localhost:8088';
    const keyToUse = result.vcpKey || 'your_secret_key';
    const fullUrl = `${serverUrlToUse}/vcp-chrome-observer/VCP_Key=${keyToUse}`;
    
    ws = new WebSocket(fullUrl);
    
    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === 'command') {
            // 处理服务器指令
            handleCommand(message.data);
        }
    };
}

// 消息监听
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'PAGE_INFO_UPDATE') {
        // 转发页面信息到服务器
        ws.send(JSON.stringify({
            type: 'pageInfoUpdate',
            data: { markdown: request.data.markdown }
        }));
    }
});
```

#### 3.5.2 Content Script (`content_script.js`)

**核心职责**：
- 页面内容转换为 Markdown
- 可交互元素标记与定位
- 命令执行（点击、输入）
- 页面变化监听

```javascript
// 页面转 Markdown
function pageToMarkdown() {
    let markdown = `# ${document.title}\nURL: ${document.URL}\n\n`;
    markdown += processNode(document.body);
    return markdown;
}

// 可交互元素检测
function isInteractive(node) {
    const tagName = node.tagName.toLowerCase();
    if (['a', 'button', 'input', 'textarea', 'select'].includes(tagName)) {
        return true;
    }
    // ARIA 角色检测
    const role = node.getAttribute('role');
    if (['button', 'link', 'checkbox', ...].includes(role)) {
        return true;
    }
    // cursor: pointer 检测
    const style = window.getComputedStyle(node);
    if (style.cursor === 'pointer') return true;
    return false;
}

// 元素定位器（多策略）
function findElement(target) {
    // 策略1: vcp-id 精确匹配
    let element = document.querySelector(`[vcp-id="${target}"]`);
    if (element) return element;
    
    // 策略2: ARIA 标签匹配
    element = document.querySelector(`[aria-label="${target}"]`);
    
    // 策略3-9: XPath、CSS选择器、模糊文本、name、id、placeholder、title
    // ...
    return element;
}
```

### 3.6 消息传递协议

```
┌──────────────┐     chrome.runtime      ┌──────────────┐
│ Content      │ ◄──────────────────────► │ Background   │
│ Script       │                         │ Service      │
│              │                         │ Worker       │
└──────────────┘                         └──────┬───────┘
                                                │
                                                │ WebSocket
                                                ▼
                                         ┌──────────────┐
                                         │ VCP Server   │
                                         │ (主服务器)    │
                                         └──────────────┘
```

**消息类型**：

| 类型 | 方向 | 用途 |
|------|------|------|
| `PAGE_INFO_UPDATE` | Content → Background | 页面信息更新 |
| `REQUEST_PAGE_INFO_UPDATE` | Background → Content | 请求页面更新 |
| `FORCE_PAGE_UPDATE` | Background → Content | 强制刷新页面 |
| `EXECUTE_COMMAND` | Background → Content | 执行命令 |
| `COMMAND_RESULT` | Content → Background | 命令执行结果 |
| `CLEAR_STATE` | Background → Content | 清除状态 |
| `GET_STATUS` | Popup → Background | 获取连接状态 |
| `TOGGLE_CONNECTION` | Popup → Background | 切换连接 |
| `TOGGLE_MONITORING` | Popup → Background | 切换监控 |

### 3.7 安装与配置

1. **加载扩展**：
   - 打开 `chrome://extensions/`
   - 启用「开发者模式」
   - 点击「加载已解压的扩展程序」
   - 选择 `VCPChrome` 目录

2. **配置服务器**：
   - 点击扩展图标打开弹窗
   - 输入服务器 WebSocket 地址（如 `ws://localhost:8088`）
   - 输入 VCP_Key
   - 点击「连接」

---

## 4. OpenWebUISub 用户脚本

### 4.1 概述

OpenWebUISub 包含多个 Tampermonkey/Greasemonkey 用户脚本，用于在 OpenWebUI 等 LLM 前端中增强 VCP 协议的显示和交互。

### 4.2 脚本列表

| 脚本 | 用途 |
|------|------|
| `VCP_DailyNote_SidePanel.user.js` | 侧边栏嵌入 VCP 日记面板 |
| `OpenWebUI VCP Tool Call Display Enhancer.user.js` | VCP 工具调用可视化渲染 |
| `OpenWebUI Force HTML Image Renderer with Lightbox.user.js` | 图片渲染增强与灯箱效果 |

### 4.3 Metadata 格式

```javascript
// ==UserScript==
// @name         VCP DailyNote SidePanel
// @namespace    http://tampermonkey.net/
// @version      0.2.1
// @description  在侧边栏嵌入 VCP 日记面板
// @author       B3000Kcn & DBL1F7E5
// @match        http(s)://your.openwebui.url:port/*
// @connect      your.vcptoolbox.url
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==
```

**关键指令说明**：

| 指令 | 用途 |
|------|------|
| `@match` | 脚本匹配的 URL 模式 |
| `@connect` | 允许跨域请求的域名 |
| `@grant` | 声明使用的 GM_* API |
| `@run-at` | 脚本注入时机 |
| `@require` | 外部依赖（如 marked.js） |

### 4.4 VCP Tool Call Display Enhancer

#### 4.4.1 核心功能

1. **主引擎**：渲染代码块包裹的 ToolCall（```VCPToolCall）
2. **兜底引擎**：渲染裸露的 ToolCall 文本

#### 4.4.2 渲染卡片结构

```html
<div class="vcp-tool-card" data-status="running|done">
    <div class="vcp-header">
        <div class="vcp-title">
            <span>⚙️</span>
            <span>VCP Tool Call:</span>
            <span class="vcp-name-text">PluginName</span>
        </div>
        <button class="vcp-btn copy-btn">Copy</button>
    </div>
    <div class="vcp-body">
        <div class="vcp-table-grid">
            <div class="vcp-key">参数名</div>
            <div class="vcp-val">参数值</div>
        </div>
    </div>
</div>
```

#### 4.4.3 协议解析

```javascript
// VCP ToolCall 协议格式
const START_MARKER = "<<<[TOOL_REQUEST]>>>";
const END_MARKER = "<<<[END_TOOL_REQUEST]>>>";

// DailyNote 协议格式
const DAILY_START = "<<<DailyNoteStart>>>";
const DAILY_END = "<<<DailyNoteEnd>>>";

// 参数解析正则
const paramRegex = /^(\s*)([^:"']+?)(:\s*)(.*)$/;
const toolNameRegex = /tool_name:\s*「始」(.*?)「末」/;
```

### 4.5 VCP DailyNote SidePanel

#### 4.5.1 架构设计

采用「特洛伊木马」模式：
1. 通过 `GM_xmlhttpRequest` 下载面板 HTML/CSS/JS
2. 使用 `srcdoc` 将内容注入 iframe
3. 劫持 iframe 内的 `fetch` 实现跨域代理

```javascript
// 跨域代理注入
async function startProxyInjection() {
    // 1. 挂载代理到 unsafeWindow
    targetWindow.__VCP_FETCH_PROXY__ = async (url, options) => {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: options.method || "GET",
                url: url,
                headers: {
                    ...(options.headers || {}),
                    "Authorization": "Basic " + btoa(AUTH_USER + ":" + AUTH_PASS),
                    "Content-Type": "application/json"
                },
                data: options.body,
                onload: (res) => resolve({
                    ok: res.status >= 200 && res.status < 300,
                    status: res.status,
                    json: () => Promise.resolve(JSON.parse(res.responseText))
                })
            });
        });
    };
    
    // 2. 下载静态资源
    let html = await download(PANEL_URL);
    let cssContent = await download(baseUrl + "style.css");
    let jsContent = await download(baseUrl + "script.js");
    
    // 3. 组装 srcdoc HTML（内联 CSS 和 JS）
    const finalHtml = `<!DOCTYPE html>...`;
    
    // 4. 初始化 UI
    initUI(finalHtml);
}
```

#### 4.5.2 配置项

```javascript
// 配置区域
const PANEL_URL = "https://your.vcptoolbox.url:port/AdminPanel/DailyNotePanel/";
const PANEL_WIDTH = "260px";
const PANEL_ZOOM = 0.8;           // 缩放比例
const SIDEBAR_WIDTH = "51px";     // 切掉的侧边栏宽度
const BUTTON_BOTTOM = "20px";     // 按钮距底部距离
const DEFAULT_VIEW = "stream";    // 默认视图

// 鉴权信息
const AUTH_USER = "xxxxxxx";
const AUTH_PASS = "xxxxxxxxxxxxxxxxxx";
```

### 4.6 Force HTML Image Renderer

#### 4.6.1 核心功能

- 自动修复 VCP 图片 URL
- 高级灯箱效果（缩放、平移、捏合）
- 分段 HTML 标签渲染

#### 4.6.2 URL 修复逻辑

```javascript
const VCP_CONFIG = {
    BASE_URL: "https://aaa.bbb.ccc",
    KEY: "xxxxxxxxxxxxxxxxxxxxxxxxx"
};

function fixVcpUrl(originalSrc) {
    const anchor = "/images/";
    const index = originalSrc.indexOf(anchor);
    if (index === -1) return originalSrc;
    
    const pathPart = originalSrc.substring(index);
    let cleanBase = VCP_CONFIG.BASE_URL.replace(/\/+$/, "");
    return `${cleanBase}/pw=${VCP_CONFIG.KEY}${pathPart}`;
}
```

### 4.7 Tampermonkey 兼容性

| API | Tampermonkey | Violentmonkey | Greasemonkey 4 |
|-----|--------------|---------------|----------------|
| `GM_addStyle` | ✅ | ✅ | ❌ |
| `GM_xmlhttpRequest` | ✅ | ✅ | ✅ |
| `GM_setValue/getValue` | ✅ | ✅ | ✅ |
| `unsafeWindow` | ✅ | ✅ | ⚠️ 有限 |
| `GM_registerMenuCommand` | ✅ | ✅ | ❌ |

---

## 5. 前后端通信协议

### 5.1 HTTP API 协议

#### 5.1.1 认证方式

| 端点类型 | 认证方式 | 说明 |
|----------|----------|------|
| `/admin_api/*` | HTTP Basic Auth + Cookie | 管理面板专用 |
| `/v1/*` | Bearer Token (VCP_Key) | AI 对话 API |
| `/dailynote_api/*` | Bearer Token | 日记操作 API |

#### 5.1.2 请求格式

```javascript
// 标准 API 请求
fetch('/admin_api/config/main', {
    method: 'GET',
    headers: {
        'Content-Type': 'application/json'
    },
    credentials: 'same-origin'  // 携带 Cookie
});

// 带认证的请求
fetch('/v1/chat/completions', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer YOUR_VCP_KEY'
    },
    body: JSON.stringify({ /* ... */ })
});
```

#### 5.1.3 响应格式

```javascript
// 成功响应
{
    "success": true,
    "data": { /* ... */ }
}

// 错误响应
{
    "success": false,
    "error": "错误描述",
    "details": "详细错误信息"
}
```

### 5.2 WebSocket 协议

#### 5.2.1 连接路径

| 路径 | 客户端类型 | 用途 |
|------|------------|------|
| `/VCPlog/VCP_Key=xxx` | VCPLog | 日志推送 |
| `/vcpinfo/VCP_Key=xxx` | VCPInfo | 信息推送 |
| `/vcp-chrome-observer/VCP_Key=xxx` | ChromeObserver | 浏览器观察 |
| `/vcp-chrome-control/VCP_Key=xxx` | ChromeControl | 浏览器控制 |
| `/vcp-admin-panel/VCP_Key=xxx` | AdminPanel | 管理面板实时更新 |
| `/vcp-distributed-server/VCP_Key=xxx` | DistributedServer | 分布式节点 |

#### 5.2.2 消息格式

```javascript
// 心跳
{ "type": "heartbeat", "timestamp": 1707812345678 }

// 心跳确认
{ "type": "heartbeat_ack", "timestamp": 1707812345680 }

// 页面信息更新（ChromeObserver → Server）
{
    "type": "pageInfoUpdate",
    "data": {
        "markdown": "# Page Title\nURL: https://...\n\nContent..."
    }
}

// 命令执行（Server → ChromeObserver）
{
    "type": "command",
    "data": {
        "command": "click",
        "target": "vcp-id-1",
        "requestId": "req_abc123",
        "sourceClientId": "client_xyz"
    }
}

// 命令结果（ChromeObserver → Server）
{
    "type": "command_result",
    "data": {
        "requestId": "req_abc123",
        "sourceClientId": "client_xyz",
        "status": "success",
        "message": "成功点击了元素"
    }
}
```

#### 5.2.3 认证流程

```
客户端                           服务器
  │                               │
  │──── WebSocket Upgrade ───────►│
  │    /vcp-chrome-observer/      │
  │    VCP_Key=xxx                │
  │                               │
  │◄─── 验证 VCP_Key ─────────────│
  │                               │
  │◄─── connection_ack ───────────│
  │    { type: 'connection_ack' } │
  │                               │
  │◄─── heartbeat/ack ───────────►│
  │    (每30秒)                   │
```

### 5.3 VCP 工具调用协议

#### 5.3.1 基本格式

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」PluginName「末」,
param1:「始」value1「末」,
param2:「始」value2「末」
<<<[END_TOOL_REQUEST]>>>
```

#### 5.3.2 高级控制指令

| 指令 | 用途 |
|------|------|
| `archery:「始」no_reply「末」 | 异步射箭，不等待结果 |
| `ink:「始」mark_history「末」 | 强制持久化到对话历史 |

#### 5.3.3 串语法支持

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」FileOperator「末」,

command1:「始」CreateFile「末」,
filePath1:「始」/path/to/file.txt「末」,

command2:「始」AppendFile「末」,
filePath2:「始」/path/to/file.txt「末」,
content2:「始」要追加的内容「末」
<<<[END_TOOL_REQUEST]>>>
```

---

## 6. 构建与部署

### 6.1 AdminPanel 部署

AdminPanel 是纯静态文件，无需构建：

```bash
# 直接由 server.js 托管
node server.js

# 访问
http://localhost:5890/AdminPanel
http://localhost:5890/AdminPanel/login.html
```

**Nginx 反向代理示例**：

```nginx
location /AdminPanel {
    proxy_pass http://localhost:5890;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

### 6.2 VCPChrome 安装

1. 打开 Chrome，访问 `chrome://extensions/`
2. 启用「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `VCPChrome` 目录
5. 配置服务器地址和 VCP_Key

### 6.3 OpenWebUISub 安装

1. 安装 Tampermonkey 扩展
2. 创建新脚本
3. 粘贴脚本内容
4. 修改 `@match` 和配置项
5. 保存并启用

### 6.4 Docker 部署

```yaml
# docker-compose.yml
services:
  vcptoolbox:
    build: .
    ports:
      - "5890:5890"      # HTTP API
      - "8088:8088"      # WebSocket
    volumes:
      - ./config.env:/app/config.env
      - ./dailynote:/app/dailynote
      - ./Plugin:/app/Plugin
```

---

## 7. 安全注意事项

### 7.1 认证安全

| 组件 | 认证方式 | 安全建议 |
|------|----------|----------|
| AdminPanel | HTTP Basic Auth | 使用强密码，启用 HTTPS |
| VCPChrome | VCP_Key | 定期更换密钥，限制 IP |
| OpenWebUISub | HTTP Basic Auth | 不要在脚本中硬编码凭据 |

### 7.2 敏感信息保护

```javascript
// ❌ 错误：硬编码凭据
const AUTH_USER = "admin";
const AUTH_PASS = "123456";

// ✅ 正确：使用配置或环境变量
const AUTH_USER = process.env.VCP_ADMIN_USER;
const AUTH_PASS = process.env.VCP_ADMIN_PASS;
```

### 7.3 跨域安全

```javascript
// GM_xmlhttpRequest 的 @connect 白名单
// @connect your.vcptoolbox.url

// 限制允许的域名，避免 SSRF
```

### 7.4 内容安全策略 (CSP)

AdminPanel 作为静态资源托管，后端应配置适当的 CSP：

```javascript
// server.js
app.use('/AdminPanel', express.static(adminPanelPath, {
    setHeaders: (res) => {
        res.setHeader('Content-Security-Policy', 
            "default-src 'self'; " +
            "script-src 'self' 'unsafe-inline'; " +
            "style-src 'self' 'unsafe-inline';"
        );
    }
}));
```

### 7.5 VCPChrome 权限风险

| 权限 | 风险 | 缓解措施 |
|------|------|----------|
| `<all_urls>` | 可访问所有网站数据 | 仅在需要时启用监控 |
| `scripting` | 可注入任意脚本 | 审查扩展代码 |
| `activeTab` | 可读取当前页面 | 敏感页面禁用扩展 |

### 7.6 日志安全

- 不要在前端日志中输出 VCP_Key
- 不要在 API 响应中暴露服务器路径
- 敏感字段应在后端过滤

### 7.7 用户脚本安全

- 仅从可信来源安装脚本
- 定期审查脚本更新
- 不要在公共电脑上保存敏感配置

---

## 附录

### A. 常见问题

**Q: AdminPanel 登录后仍然跳转到登录页？**
A: 检查 Cookie 是否被正确设置（HttpOnly、SameSite），以及浏览器是否阻止了第三方 Cookie。

**Q: VCPChrome 无法连接到服务器？**
A: 确认 WebSocket 端口（默认 8088）已开放，VCP_Key 与服务器配置一致。

**Q: 用户脚本中的跨域请求失败？**
A: 检查 `@connect` 指令是否包含目标域名。

### B. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0 | 2026-02-13 | 初始文档 |

---

**文档维护者：** VCP 开发团队
**最后更新：** 2026-02-13
