# VCPBridgeServer - System Prompt 劫持代理

独立端口运行的透明 API 代理，专为**前端不能修改 System Prompt 的 CLI 工具**设计。

## 解决什么问题

Codex CLI、Claude Code、Cursor、Kiro 等 AI 编程工具都有自己内置的 system prompt，用户无法修改。但你可能需要：

- 注入项目规范（AGENTS.md、编码规范等）
- 替换工具自带的行为约束
- 把请求偷偷转发到不同的模型（模型映射）
- 统一管理所有 CLI 工具的 system prompt
- **为不同分身/场景配置独立的人格结晶**（多 Profile 系统）

VCPBridgeServer 作为中间代理，拦截这些工具的请求，在转发到真正的上游 API 之前注入或替换 system prompt。

## 工作原理

```
CLI 工具 (Codex/Claude Code/Cursor)
    │
    ▼ 请求发到 Bridge Server (端口 6003)
┌─────────────────────────────┐
│  VCPBridgeServer            │
│  1. 解析 Profile（按请求） │
│  2. 提取 messages 数组       │
│  3. 应用 system prompt 劫持  │
│  4. 模型名映射               │
│  5. 转发到上游 API           │
└─────────────────────────────┘
    │
    ▼ 转发到真正的上游 (OpenAI/Anthropic/Gemini)
上游 API
    │
    ▼ 响应原样透传回 CLI 工具
CLI 工具收到响应
```

## 支持的协议

| 入口端点 | 协议 | 典型客户端 |
|---------|------|-----------|
| `POST /v1/chat/completions` | OpenAI Chat | 大多数工具 |
| `POST /v1/responses` | OpenAI Responses API | Codex CLI |
| `POST /v1/messages` | Anthropic Messages | Claude Code |
| `POST /v1beta/models/:model:generateContent` | Gemini | Google SDK |

所有入口的请求都会被统一提取为 messages 数组，应用劫持后，按配置的上游类型转发。

## 快速开始

### 1. 配置

首次启动时会自动从 `config.env` / `config.env.example` 迁移生成 `bridge-config.json`。后续所有配置通过 JSON 文件管理。

也可以通过 AdminPanel 网页面板（端口 6006）在线配置。

### 2. 创建 System Prompt 文件

在插件目录或 `presets/` 子目录下创建 `.txt` 文件：

```text
你是一个严格遵循以下项目规范的编程助手：

1. 所有代码必须使用 TypeScript
2. 遵循 SOLID 原则
3. 每个函数必须有 JSDoc 注释
...
```

System Prompt 支持两种来源：
- **文件名**：填写 `.txt` 文件名（自动从插件目录和 `presets/` 子目录搜索）
- **直接文本**：直接填写提示词内容

### 3. 配置 CLI 工具

将 CLI 工具的 API Base URL 指向 Bridge Server：

**Codex CLI：**
```bash
export OPENAI_BASE_URL=http://127.0.0.1:6003/v1
codex "帮我重构这个函数"
```

**Claude Code：**
```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:6003
claude "分析这个项目结构"
```

### 4. 启动

插件随 VCP 主服务器自动启动（service 类型插件）。验证：

```bash
curl http://127.0.0.1:6003/health
```

## 多 Profile 系统

### 概念

每个 Profile 是一组独立的 `systemPrompt + hijackMode + modelOverride` 配置。CLI 工具通过 URL 路径前缀自动选择 Profile，实现**单端口多分身**。

### 创建 Profile

**方式一：AdminPanel GUI**

打开 `http://localhost:6006/AdminPanel/` → 前端劫持配置 → 多 Profile 管理 → 新建

**方式二：直接创建 JSON 文件**

在 `profiles/` 目录下创建 `research.json`：

```json
{
  "name": "research",
  "displayName": "科研环境",
  "systemPrompt": "Research_Rule.txt",
  "hijackMode": "replace",
  "modelOverride": "",
  "description": "深度科研场景"
}
```

**方式三：Admin REST API**

```bash
curl -u user:pass -X POST -H "Content-Type: application/json" \
  -d '{"displayName":"科研环境","systemPrompt":"Research_Rule.txt","hijackMode":"replace"}' \
  http://127.0.0.1:6006/admin_api/bridge-profiles/research
```

### 请求级 Profile 选择

CLI 工具选择 Profile 的三种方式（按优先级排列）：

| 方式 | 示例 | 说明 |
|------|------|------|
| URL 路径前缀 | `base_url: http://127.0.0.1:6003/v1/research` | **推荐**。所有 CLI 工具都支持自定义 base_url |
| HTTP Header | `X-Bridge-Profile: research` | 适合支持自定义 header 的工具 |
| Model 名称前缀 | `model: "research/gemini-3.5-flash"` | 兜底方案。Profile 名会从 model 中剥离 |

**使用示例：**

```bash
# 默认环境
export OPENAI_BASE_URL=http://127.0.0.1:6003/v1
codex "日常编程"

# 科研环境（不同的 system prompt）
export OPENAI_BASE_URL=http://127.0.0.1:6003/v1/research
codex "深度分析论文"
```

### Profile 优先级

```
请求到达 → URL path 提取 profile name
         → 未命中 → 检查 X-Bridge-Profile header
         → 未命中 → 检查 model 名是否含 /（前缀作为 profile）
         → 未命中 → 使用 bridge-config.json 的 defaultProfile
         → 未命中 → 回退到全局 systemPrompt + hijackMode
```

### 热重载

`profiles/` 目录由 chokidar 监控——新增、修改、删除 Profile 文件后自动生效，无需重启。

## 配置详解

### 劫持模式 (`hijackMode`)

| 模式 | 行为 | 适用场景 |
|------|------|---------|
| `replace` | 移除原有所有 system 消息，替换为你的 prompt | 完全控制 AI 行为 |
| `prepend` | 在所有消息最前面插入你的 prompt | 优先级最高的规则注入 |
| `append` | 在最后一条 system 消息后面追加 | 补充规则，不破坏原有行为 |
| `merge` | 合并所有 system 消息为一条置顶 system | 整合多来源规则 |
| `off` | 不劫持，纯透传 | 仅用模型映射功能 |

### 模型映射 (`modelMap`)

CLI 工具请求模型 A，实际转发到模型 B：

```json
{
  "modelMap": {
    "gpt-4o": "claude-sonnet-4",
    "gpt-4.1-mini": "gemini-2.5-flash"
  }
}
```

### System Prompt 搜索路径

填写 `.txt` 文件名时，按以下顺序搜索：
1. 插件根目录（`Plugin/VCPBridgeServer/`）
2. `presets/` 子目录（`Plugin/VCPBridgeServer/presets/`）

## Admin REST API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/admin_api/bridge-profiles` | GET | 列出所有 Profile |
| `/admin_api/bridge-profiles/:name` | GET | 读取单个 Profile |
| `/admin_api/bridge-profiles/:name` | POST | 创建/更新 Profile |
| `/admin_api/bridge-profiles/:name` | DELETE | 删除 Profile |
| `/admin_api/bridge-profiles/:name/activate` | POST | 设为默认 Profile |
| `/admin_api/bridge-profiles/deactivate` | POST | 清除默认 Profile |

## 与 protocolBridge 的区别

| | VCPBridgeServer（本插件） | protocolBridge（主服务器路由） |
|---|---|---|
| 端口 | 独立端口 | 主服务器端口 |
| 走 VCP 链路 | ❌ 直接转发上游 | ✅ 完整走插件/RAG/角色分割 |
| Prompt 劫持 | ✅ replace/prepend/append/merge | ❌ |
| 模型映射 | ✅ 独立配置 | 用 VCP 语义路由 |
| 多 Profile | ✅ 请求级切换 | ❌ |
| 用途 | 给 CLI 工具注入规范 | 让 CLI 工具用上 VCP 全部能力 |

**选择建议：**
- 想让 CLI 工具享受 VCP 的 RAG、插件等能力 → 用 `protocolBridge`
- 只想给 CLI 工具注入 system prompt / 做模型映射 → 用本插件
- 两者可以串联：CLI → BridgeServer(劫持prompt) → VCP主服务器(走完整链路) → 上游API

## 向后兼容性

- 不配置 `defaultProfile`、不创建 profiles 目录 → 行为与旧版完全一致
- 旧版 `bridge-config.json` 自动兼容（缺失的 `defaultProfile` 字段默认为空字符串）
- 标准路由 `/v1/chat/completions` 不受 Profile 路由影响（通过 `next()` fallthrough）