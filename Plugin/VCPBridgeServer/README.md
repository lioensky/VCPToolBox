# VCPBridgeServer - System Prompt 劫持代理

独立端口运行的透明 API 代理，专为**前端不能修改 System Prompt 的 CLI 工具**设计。

## 解决什么问题

Codex CLI、Claude Code、Cursor、Kiro 等 AI 编程工具都有自己内置的 system prompt，用户无法修改。但你可能需要：

- 注入项目规范（AGENTS.md、编码规范等）
- 替换工具自带的行为约束
- 把请求偷偷转发到不同的模型（模型映射）
- 统一管理所有 CLI 工具的 system prompt

VCPBridgeServer 作为中间代理，拦截这些工具的请求，在转发到真正的上游 API 之前注入或替换 system prompt。

## 工作原理

```
CLI 工具 (Codex/Claude Code/Cursor)
    │
    ▼ 请求发到 Bridge Server (端口 3100)
┌─────────────────────────────┐
│  VCPBridgeServer            │
│  1. 提取 messages 数组       │
│  2. 应用 system prompt 劫持  │
│  3. 模型名映射               │
│  4. 转发到上游 API           │
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

```bash
cd Plugin/VCPBridgeServer
cp config.env.example config.env
```

编辑 `config.env`：

```env
BRIDGE_PORT=3100
BRIDGE_UPSTREAM_URL=https://api.openai.com
BRIDGE_UPSTREAM_KEY=sk-your-key-here
BRIDGE_UPSTREAM_TYPE=chat
BRIDGE_MODEL=gpt-4.1-mini
BRIDGE_SYSTEM_PROMPT=my_rules.txt
BRIDGE_HIJACK_MODE=replace
```

### 2. 创建 System Prompt 文件

在插件目录下创建 `my_rules.txt`：

```text
你是一个严格遵循以下项目规范的编程助手：

1. 所有代码必须使用 TypeScript
2. 遵循 SOLID 原则
3. 每个函数必须有 JSDoc 注释
4. 禁止使用 any 类型
...
```

### 3. 配置 CLI 工具

将 CLI 工具的 API Base URL 指向 Bridge Server：

**Codex CLI：**
```bash
export OPENAI_BASE_URL=http://127.0.0.1:3100/v1
export OPENAI_API_KEY=your-key  # 会被透传到上游
codex "帮我重构这个函数"
```

**Claude Code：**
```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:3100
claude "分析这个项目结构"
```

### 4. 启动

插件会随 VCP 主服务器自动启动（service 类型插件）。也可以独立验证：

```bash
curl http://127.0.0.1:3100/health
```

## 配置详解

### 劫持模式 (`BRIDGE_HIJACK_MODE`)

| 模式 | 行为 | 适用场景 |
|------|------|---------|
| `replace` | 移除原有所有 system 消息，替换为你的 prompt | 完全控制 AI 行为 |
| `prepend` | 在所有消息最前面插入你的 prompt | 优先级最高的规则注入 |
| `append` | 在最后一条 system 消息后面追加 | 补充规则，不破坏原有行为 |
| `off` | 不劫持，纯透传 | 仅用模型映射功能 |

### 模型映射 (`BRIDGE_MODEL_MAP`)

CLI 工具请求模型 A，实际转发到模型 B：

```env
BRIDGE_MODEL_MAP=gpt-4o:claude-sonnet-4,gpt-4.1-mini:gemini-2.5-flash
```

### System Prompt 来源 (`BRIDGE_SYSTEM_PROMPT`)

- **直接写文本**：`BRIDGE_SYSTEM_PROMPT=你是一个严格的代码审查员...`
- **从文件加载**：`BRIDGE_SYSTEM_PROMPT=my_rules.txt`（从插件目录读取）

## 与 protocolBridge 的区别

VCP 主服务器上还有一个 `routes/protocolBridge.js`，它们的定位不同：

| | VCPBridgeServer（本插件） | protocolBridge（主服务器路由） |
|---|---|---|
| 端口 | 独立端口 3100 | 主服务器端口 |
| 走 VCP 链路 | ❌ 直接转发上游 | ✅ 完整走插件/RAG/角色分割 |
| Prompt 劫持 | ✅ replace/prepend/append | ❌ |
| 模型映射 | ✅ 独立配置 | 用 VCP 语义路由 |
| 用途 | 给 CLI 工具注入规范 | 让 CLI 工具用上 VCP 全部能力 |

**选择建议：**
- 想让 CLI 工具享受 VCP 的 RAG、插件等能力 → 用 `protocolBridge`（指向主服务器端口）
- 只想给 CLI 工具注入 system prompt / 做模型映射 → 用本插件（指向 3100 端口）
- 两者可以串联：CLI → BridgeServer(劫持prompt) → VCP主服务器(走完整链路) → 上游API

## 串联用法（高级）

让 BridgeServer 的上游指向 VCP 主服务器，实现"先劫持 prompt，再走 VCP 完整链路"：

```env
BRIDGE_PORT=3100
BRIDGE_UPSTREAM_URL=http://127.0.0.1:5890
BRIDGE_UPSTREAM_KEY=your-vcp-server-key
BRIDGE_UPSTREAM_TYPE=chat
BRIDGE_SYSTEM_PROMPT=project_rules.txt
BRIDGE_HIJACK_MODE=prepend
```

这样 CLI 工具的请求会：
1. 先经过 BridgeServer 注入项目规范
2. 再经过 VCP 主服务器走完整的插件/RAG/角色分割链路
3. 最终到达真正的上游 AI API