# DeepWikiVCP

> 通过 DeepWiki 官方 MCP API，为 VCP 伙伴提供 GitHub 仓库的 AI 生成文档检索与智能问答能力。

## 概述

DeepWikiVCP 是一个 VCP 同步插件，通过调用 [DeepWiki](https://deepwiki.com) 的官方 MCP (Model Context Protocol) 服务器，让 AI伙伴能够：

- **📚 浏览文档结构** — 获取任意 GitHub 公开仓库的 AI 生成文档目录
- **📖 阅读完整文档** — 获取仓库的完整 wiki 文档内容
- **🤖 智能问答** — 向 DeepWiki AI 提问，获取基于仓库代码的深度回答

## 特性

- ✅ **零依赖** — 仅使用 Node.js 18+ 内置 `fetch()`，无需 `npm install`
- ✅ **零配置** — 无需 API Key，DeepWiki 对公开仓库完全免费
- ✅ **智能解析** — 支持 `owner/repo`、GitHub URL、DeepWiki URL 等多种输入格式
- ✅ **内容截断** — 自动将超长文档截断至80K 字符，防止 token爆炸
- ✅ **参数容错** — command 大小写不敏感，支持多种同义词和参数名
- ✅ **优雅降级** — 不存在的仓库、空输入等边界情况均有友好错误提示

## 技术架构

```
┌─────────────┐    JSON-RPC 2.0     ┌──────────────────────┐
│  VCP Server  │ ──── stdin/stdout ──→ │  DeepWikiVCP.js      │
│  (Plugin.js) │ ←── JSON result ──── │  (零依赖 Node.js)    │
└─────────────┘                └──────────┬───────────┘
                                                │ fetch()
                                                  ▼
                                       ┌──────────────────────┐
                                       │ mcp.deepwiki.com/mcp │
                                       │ (MCP over HTTP)      │
                                       └──────────────────────┘
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

### 3. 智能问答

向 DeepWiki AI 提问关于仓库的具体问题：

```
tool_name: DeepWikiVCP
command: wiki_ask
url: lioensky/VCPToolBox
question: 插件系统是如何工作的？
```

## URL 格式支持

以下格式均可被正确解析：

| 输入格式 | 示例 |
|---------|------|
| owner/repo | `lioensky/VCPToolBox` |
| GitHub URL | `https://github.com/lioensky/VCPToolBox` |
| DeepWiki URL | `https://deepwiki.com/lioensky/VCPToolBox` |
| 带尾部斜杠 | `lioensky/VCPToolBox/` |
| 带额外路径 | `https://deepwiki.com/lioensky/VCPToolBox/some/page` |

## Command 同义词

| 指令 | 同义词 |
|------|--------|
| wiki_structure | structure, list, list_pages |
| wiki_content | content, read, read_page, fetch |
| wiki_ask | ask, question, search |

## ToolBox 折叠配置

在 `TVStxt/SearchToolBox.txt` 中添加以下段落即可启用上下文折叠：

```
[===vcp_fold:0.45::desc:DeepWiki仓库文档检索===]
## 7. DeepWiki 仓库文档检索 (DeepWikiVCP)
通过 DeepWiki 官方 API 获取 GitHub 仓库的 AI 生成文档。
tool_name: DeepWikiVCP
command: wiki_structure / wiki_content / wiki_ask
url: owner/repo 格式
question: (仅 wiki_ask) 你的问题
```

## 文件结构

```
Plugin/DeepWikiVCP/
├── DeepWikiVCP.js          # 插件主体(~9KB, 零依赖)
├── plugin-manifest.json    # VCP 插件描述
├── package.json            # 极简 package (无依赖)
└── README.md               # 本文件
```

## API 参考

### MCP 端点

- **URL**: `https://mcp.deepwiki.com/mcp`
- **协议**: JSON-RPC 2.0 over Streamable HTTP
- **认证**: 公开仓库无需认证

### MCP 工具

| 工具名 | 参数 | 说明 |
|--------|------|------|
| read_wiki_structure | repoName | 获取文档目录 |
| read_wiki_contents | repoName | 获取完整文档 |
| ask_question | repoName, question | AI 问答 |

## 测试记录

两轮 16 项测试全部通过（2026-04-19）：
- 3 个核心指令功能验证 ✅
- 5 种 URL 格式解析 ✅
- command 大小写/同义词/参数名容错 ✅
- 空输入/缺参数/不存在仓库/未知指令边界测试 ✅
- 8 发并发压力测试 ✅
- 353K 字符内容截断验证 ✅

## License

MIT