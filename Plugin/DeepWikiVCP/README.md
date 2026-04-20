# DeepWikiVCP

通过DeepWiki 官方 MCP API，为 VCP 伙伴提供 GitHub 仓库的 AI 生成文档检索与智能问答能力。

## 概述

DeepWikiVCP 是一个 VCP 同步插件，通过调用 DeepWiki 的官方 MCP (Model Context Protocol) 服务器，让 AI伙伴能够：

-📚 **浏览文档结构** — 获取任意GitHub 公开仓库的 AI 生成文档目录
- 📖 **阅读完整文档** — 获取仓库的完整 wiki 文档内容
- 🤖 **智能问答** — 向 DeepWiki AI 提问，获取基于仓库代码的深度回答
- 🔬 **深度研究** — 多轮迭代检索（最多5轮），适合复杂架构分析
- 🌐 **多仓库联合查询** — 一次查询最多10个仓库，AI 综合多个代码库回答

## 特性

✅ **零依赖** — 仅使用 Node.js 18+ 内置 `fetch()` 和 `undici`，无需 npm install
✅ **零配置** — 无需 API Key，DeepWiki 对公开仓库完全免费
✅ **智能解析** — 支持 `owner/repo`、GitHub/GitLab/DeepWiki URL 等多种输入格式
✅ **内容截断** — 自动将超长文档截断至80K 字符，防止 token爆炸
✅ **参数容错** — command 大小写不敏感，支持多种同义词和参数名
✅ **智能代理** — 仅读显式配置的 `DEEPWIKI_PROXY`，不劫持系统代理
✅ **代理回退** — 代理请求 15秒快速失败，自动回退直连（180 秒超时）
✅ **优雅降级** — 不存在的仓库、空输入等边界情况均有友好错误提示

## 技术架构

```
┌─────────────┐    JSON-RPC 2.0     ┌──────────────────────────┐
│  VCP Server  │ ──── stdin/stdout ──→ │  DeepWikiVCP.js│
│  (Plugin.js) │ ←── JSON result ──── │  (零依赖 Node.js 18+)     │
└─────────────┘                └──────────┬───────────────┘
                                │ fetch()
                                                  │ + undici.ProxyAgent
                                                  ▼
                                       ┌──────────────────────┐
                                       │ mcp.deepwiki.com/mcp │
                                       │ (MCP over HTTP+SSE)  │
                                       └──────────────────────┘

代理策略:DEEPWIKI_PROXY 已配置 → ProxyAgent(15秒超时) → 失败回退直连(180秒)
  DEEPWIKI_PROXY 未配置 → 直连(与v2.0 行为一致)
```

## 使用方法

### 1. 获取文档目录结构

查看某个 GitHub 仓库在 DeepWiki 上的文档组织方式：

```
tool_name: DeepWikiVCP
command: wiki_structure
url: lioensky/VCPToolBox
```

### 2. 阅读完整文档

获取仓库的完整 AI 生成文档（内容较长时自动截断）：

```
tool_name: DeepWikiVCP
command: wiki_content
url: facebook/react
```

>⚠️ **注意**: `wiki_content` 返回整个仓库文档，数据量可能非常大（数万字符）。
> 大量内容可能导致上下文 token 溢出或流式渲染不稳定。
> **建议优先使用 `wiki_ask` 针对具体主题提问。**

### 3. 智能问答

向 DeepWiki AI 提问关于仓库的具体问题：

```
tool_name: DeepWikiVCP
command: wiki_ask
url: lioensky/VCPToolBox
question: 插件系统是如何工作的？
```

### 4. 深度研究模式

AI 进行多轮迭代检索（最多5轮），从核心逻辑、依赖关系、交互流等多维度深入分析：

```
tool_name: DeepWikiVCP
command: wiki_ask
url: lioensky/VCPToolBox
question: 详细分析 RAG 记忆系统的完整架构
deep_research: true
```

### 5. 多仓库联合查询

同时查询多个仓库（最多10个），AI 综合多个代码库的上下文回答。适合分析前后端协作、微服务架构等跨仓库场景。超过10个显示被截断的个数：

```
tool_name: DeepWikiVCP
command: wiki_ask
url: lioensky/VCPToolBox, lioensky/VCPChat
question: 前后端是如何通过 WebSocket 通信的？
```

### 6. 深度研究 + 多仓库（组合使用）

```
tool_name: DeepWikiVCP
command: wiki_ask
url: owner1/repo1, owner2/repo2
question: 详细分析这两个项目的完整通信架构
deep_research: true
```

## URL 格式支持

以下格式均可被正确解析：

| 输入格式 | 示例 |
|---------|------|
| owner/repo | `lioensky/VCPToolBox` |
| GitHub URL | `https://github.com/lioensky/VCPToolBox` |
| GitLab URL | `https://gitlab.com/owner/repo` |
| Bitbucket URL | `https://bitbucket.org/owner/repo` |
| DeepWiki URL | `https://deepwiki.com/lioensky/VCPToolBox` |
| 带尾部斜杠 | `lioensky/VCPToolBox/` |
| 带额外路径 | `https://deepwiki.com/lioensky/VCPToolBox/some/page` |
| 多仓库（逗号分隔） | `owner1/repo1, owner2/repo2` |

## Command 同义词

| 指令 | 同义词 |
|------|--------|
| wiki_structure | structure, list, list_pages |
| wiki_content | content, read, read_page, fetch |
| wiki_ask | ask, question, search |

## wiki_ask 参数表

| 参数 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `url` | 字符串 | ✅ | 仓库标识。单仓库: `owner/repo`。多仓库: 逗号分隔，最多10个 |
| `question` | 字符串 | ✅ | 你想问的问题，支持自然语言 |
| `deep_research` | 布尔| ❌ | 设为 `true` 启用深度研究模式（多轮迭代，耗时较长） |

## 配置指南

>公开仓库无需任何配置即可使用。以下配置均为可选。

### 代理配置

如果你的网络无法直连 `mcp.deepwiki.com`（例如被防火墙阻断），复制`config.env.example` 为 `config.env`，配置代理：

```env
DEEPWIKI_PROXY=http://127.0.0.1:7890
```

**代理策略说明**:

- **仅读取`DEEPWIKI_PROXY`**: 不会自动读取系统级`HTTP_PROXY` 环境变量，避免劫持系统代理导致不稳定
- **15秒快速失败**: 代理请求使用 15 秒超时，无响应则自动回退直连（180 秒超时）
- **未配置时**: 与 v2.0.0 行为完全一致 — 直接使用默认网络
- **HTTP/2 已禁用**: 通过 `allowH2: false` 避免部分代理的 HTTP/2 兼容性问题

### GitHub 令牌获取

如需查询私有仓库（预留功能，当前 MCP 协议暂不支持透传），在 `config.env` 中配置令牌：

1. 打开 [GitHub Token 设置页](https://github.com/settings/tokens)
2. 点击 **"Generate new token"** →选择 **"Fine-grained, repo-scoped"**（推荐）
3. **Permissions**: Contents: Read-only ✅ + Metadata: Read-only ✅（其他保持默认）
4. 复制令牌填入 `config.env` 的 `DEEPWIKI_GITHUB_TOKEN=`

>⚠️ 安全提示: 只需Contents和 Metadata 只读权限。令牌泄露时权限越小越安全。

### GitLab 令牌获取

1. 打开 [GitLab Token 设置页](https://gitlab.com/-/user_settings/personal_access_tokens)
2.勾选 **read_api** ✅ 和 **read_repository** ✅
3. 复制令牌填入 `config.env` 的 `DEEPWIKI_GITLAB_TOKEN=`

> 💡 **什么是 GitLab？** 类似 GitHub 的代码托管平台，核心优势是 CI/CD 流水线和免费自托管。很多企业和学术机构使用自建GitLab 实例。

## 当前限制与未来计划

### MCP 协议参数限制

DeepWiki 官方 MCP 的`ask_question` 工具仅接受 `repoName`（string或 string[]）和 `question`（string）。以下高级参数**当前无法通过 MCP 使用**：

| 参数 | 说明 | 状态 |
|------|------|:---:|
| `language` | 语言选择 (zh/en/ja/es/kr/vi) | 🔒 代码已预留 |
| `filePath` | 文件聚焦 | 🔒 代码已预留 |
| `token` | 私有仓库令牌 | 🔒 config.env 已支持存储 |
| `type` | 多平台 (gitlab/bitbucket) | 🔒 代码已预留 |
| `provider` / `model` | 模型选择 | 🔒 代码已预留 |
| `excluded_dirs` | 目录过滤 | 🔒 代码已预留 |

这些参数已在代码中预留了完整的收集器（`collectAdvancedParams`），待以下任一条件满足时可快速启用：

### 未来扩展路线

1. **DeepWiki 官方扩展 MCP 参数白名单** — 最理想，零改动启用
2. **集成 DeepWiki REST API** — 自部署 `deepwiki-open` 后使用全部参数
3. **VCP 异步插件模式** — 利用 VCP 的 requestId + 占位符机制解决 Deep Research 超时

## ToolBox 折叠配置

在系统提示词的工具箱折叠区域添加以下段落：

```
## 7. DeepWiki仓库文档检索 (DeepWikiVCP)
通过 DeepWiki 官方 MCP API 获取任意 GitHub 公开仓库的 AI 生成文档。支持查看文档结构、阅读完整文档、以及基于仓库代码的AI智能问答。零配置，无需 API Key。
### 查看文档目录
tool_name:「始」DeepWikiVCP「末」,
command:「始」wiki_structure「末」,
url:「始」owner/repo 格式，如lioensky/VCPToolBox「末」
### 阅读完整文档
tool_name:「始」DeepWikiVCP「末」,
command:「始」wiki_content「末」,
url:「始」owner/repo「末」
### 智能问答
tool_name:「始」DeepWikiVCP「末」,
command:「始」wiki_ask「末」,
url:「始」owner/repo「末」,
question:「始」你想问的问题「末」
### 深度研究模式
tool_name:「始」DeepWikiVCP「末」,
command:「始」wiki_ask「末」,
url:「始」owner/repo「末」,
question:「始」详细分析项目架构「末」,
deep_research:「始」true「末」
### 多仓库联合查询（最多10个，逗号分隔）
tool_name:「始」DeepWikiVCP「末」,
command:「始」wiki_ask「末」,
url:「始」owner1/repo1, owner2/repo2「末」,
question:「始」这两个项目如何协作？「末」
```

## 文件结构

```
Plugin/DeepWikiVCP/
├── DeepWikiVCP.js          # 插件主体(~14KB, 零依赖)
├── plugin-manifest.json# VCP 插件清单
├── config.env.example      # 配置模板 (复制为 config.env 使用)
├── package.json            # 极简 package (无依赖)
└── README.md               # 本文件
```

## API 参考

### MCP 端点

- **URL**: `https://mcp.deepwiki.com/mcp`
- **协议**: JSON-RPC 2.0 over Streamable HTTP (支持 JSON 和 SSE 响应)
- **认证**: 公开仓库无需认证

### MCP 工具

| 工具名 | 参数 | 说明 |
|--------|------|------|
| read_wiki_structure | repoName | 获取文档目录 |
| read_wiki_contents | repoName | 获取完整文档 |
| ask_question | repoName (string\|string[]), question | AI 问答（支持多仓库） |

### 超时与截断

| 配置项 | 值 | 说明 |
|--------|------|------|
| 直连超时 | 180 秒 | Deep Research 需要更长时间 |
| 代理超时 | 15 秒 | 快速失败后回退直连 |
| 内容截断 | 80000 字符 | 优先在换行符处截断 |

## 测试记录

v2.1.0 共20 项测试全部通过（2026-04-20）：

**v2.0继承功能（12项）**:
- 3 个核心指令功能验证 ✅
- 5 种 URL 格式解析（GitHub/GitLab/DeepWiki/owner-repo/带路径）✅
- command 大小写/同义词/参数名容错 ✅
- 智能猜测（无command 有 question时自动路由）✅
- SSE 流式响应解析 ✅
- 80000 字符智能截断验证 ✅
- 空输入/缺参数/不存在仓库/未知指令边界测试 ✅
- JSON解析容错 ✅

**v2.1 新增功能（8项）**:
- Deep Research 深度研究模式 ✅
- 多仓库联合查询（string[]）✅
- 代理配置（config.env DEEPWIKI_PROXY）✅
- 代理回退直连 ✅
- 15秒代理快速失败 ✅
- 令牌持久化（GitHub/GitLab PAT）✅
- 高级参数预留（collectAdvancedParams）✅
- GitLab/Bitbucket URL 解析 ✅

## 版本历史

- **v2.1.0** (2026-04-20): Deep Research 深度研究 / 多仓库联合查询 / 智能代理配置+回退 / 令牌持久化 / 高级参数预留
- **v2.0.0** (2026-04-19): 零依赖重写，MCP 协议，SSE 流式支持，16 项测试全通过
- **v1.0.0**: 初始版本 (Lionsky)

## 作者

**infinite-vector** — 基于 Lionsky 的初始版本重写

## License

MIT