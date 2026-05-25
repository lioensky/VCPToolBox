# ObsidianBridge

通过 Obsidian 官方 CLI (v1.12+) 桥接 VCP 与 Obsidian 笔记库，让 AI 伙伴直接读写、搜索、管理你的 Obsidian 知识库。

## 概述

ObsidianBridge 是一个 VCP 同步插件，通过调用 Obsidian 官方命令行接口（CLI），让 AI 伙伴能够：

- 📖 **读写笔记** — 读取、创建、追加、前插笔记内容
- 🔍 **全文搜索** — 支持普通搜索和带上下文的语义搜索
- 📅 **每日笔记** — 读取/追加/前插今日 Daily Note，获取路径
- 🏷️ **标签与属性** — 统计标签、读写 frontmatter Properties
- 🔗 **链接关系** — 查询出站链接和反向链接
- 📐 **结构分析** — 大纲查看、字数统计、文件/文件夹浏览
- ✅ **任务管理** — 获取待办任务，支持按文件/每日/全库筛选
- 📋 **模板列表** — 列出 vault 中已配置的模板

## 前置要求

### 1. Obsidian v1.12+ 及官方 CLI

ObsidianBridge 依赖 Obsidian 2026 年推出的官方 CLI。**它不是一个独立的命令行工具**，而是 Obsidian 桌面端内置的功能。

**安装步骤：**

1. 确保 Obsidian 已更新至 **v1.12.0** 或更高版本
2. 打开 Obsidian → 设置 → 常规 (General/About)
3. 找到 **Command Line Interface (CLI)** 选项
4. 点击 **Register CLI** / **注册**
5. 如果提示 Installer 过旧，请前往 [obsidian.md/download](https://obsidian.md/download) 下载最新安装包并覆盖安装

**验证安装：**

```bash
# Windows (PowerShell)
obsidian version

# 如果返回版本号（如 1.12.7），说明 CLI 已就绪
# 如果提示找不到命令，检查 PATH 或使用完整路径：
# D:\你的Obsidian安装路径\Obsidian.com version
```

> ⚠️ **注意**：v1.12.7 的 Changelog 明确提到 "Obsidian Installer is now bundled with a new binary file for using the CLI"。如果你是从旧版本自动升级的，可能需要重新下载安装包覆盖安装，以获取最新的 CLI 二进制文件。

### 2. 运行时要求

- **Node.js 18+**（VCP 环境自带）
- **使用 CLI 时必须保持 Obsidian 桌面端打开**（CLI 通过 IPC 与运行中的 Obsidian 通信）

## 特性

✅ **22 项命令** — 覆盖笔记读写、搜索、每日笔记、标签、属性、链接、任务、模板等
✅ **零依赖** — 仅使用 Node.js 内置 `child_process`、`path`、`fs`
✅ **可配置 CLI 路径** — 通过 `config.env` 指定 Obsidian CLI 路径，未配置时自动使用系统 PATH
✅ **参数校验** — 无效 scope 值自动拦截，缺少必需参数明确报错
✅ **Frontmatter 安全** — `prepend` 命令自动插入到 YAML `---` 之后，不破坏元数据
✅ **多行内容** — `create` / `append` / `prepend` 支持 `\n` 换行
✅ **VCP 标准接口** — 支持 stdio 和 `handleRequest()` 双入口

## 技术架构

```
┌─────────────┐    JSON (stdin/stdout)    ┌────────────────────────┐
│  VCP Server  │ ────── tool call ──────→  │  obsidian_bridge.js    │
│  (Plugin.js) │ ←──── JSON result ──────  │  (Node.js, 零依赖)     │
└─────────────┘                           └──────────┬─────────────┘
                                                     │ execSync()
                                                     │ (shell command)
                                                     ▼
                                          ┌──────────────────────┐
                                          │  Obsidian CLI         │
                                          │  (Obsidian.com/exe)   │
                                          └──────────┬───────────┘
                                                     │ IPC
                                                     ▼
                                          ┌──────────────────────┐
                                          │  Obsidian Desktop     │
                                          │  (运行中的 vault)      │
                                          └──────────────────────┘
```

## 命令参考

### 笔记读写

| 命令 | 说明 | 必需参数 | 可选参数 |
|------|------|----------|----------|
| `read` | 读取笔记完整内容 | `file` 或 `path` | `vault` |
| `create` | 创建新笔记 | `name` | `content`, `folder`, `template`, `overwrite`, `vault` |
| `append` | 向笔记末尾追加内容 | `file`/`path` + `content` | `vault` |
| `prepend` | 向笔记开头插入内容 | `file`/`path` + `content` | `inline`, `vault` |

### 每日笔记

| 命令 | 说明 | 必需参数 | 可选参数 |
|------|------|----------|----------|
| `daily_read` | 读取今日每日笔记 | 无 | `vault` |
| `daily_append` | 向今日笔记末尾追加 | `content` | `vault` |
| `daily_prepend` | 向今日笔记开头插入 | `content` | `inline`, `vault` |
| `daily_path` | 获取今日笔记路径 | 无 | `vault` |

### 搜索

| 命令 | 说明 | 必需参数 | 可选参数 |
|------|------|----------|----------|
| `search` | 全文搜索 | `query` | `limit`, `folder`, `vault` |
| `search_context` | 带上下文搜索（返回匹配行周围内容） | `query` | `limit`, `folder`, `case_sensitive`, `vault` |

### 标签与属性

| 命令 | 说明 | 必需参数 | 可选参数 |
|------|------|----------|----------|
| `tags` | 统计 vault 所有标签及使用次数 | 无 | `vault` |
| `property_set` | 设置笔记 frontmatter 属性 | `file`/`path` + `name` + `value` | `type`, `vault` |
| `property_read` | 读取笔记某个属性值 | `name` | `file`/`path`, `vault` |
| `properties` | 列出 vault 或文件的所有属性 | 无 | `file`/`path`, `format`, `total`, `counts`, `sort`, `vault` |

### 链接关系

| 命令 | 说明 | 必需参数 | 可选参数 |
|------|------|----------|----------|
| `links` | 查询笔记的出站链接 | `file` 或 `path` | `total`, `vault` |
| `backlinks` | 查询笔记的反向链接 | `file` 或 `path` | `vault` |

### 结构与统计

| 命令 | 说明 | 必需参数 | 可选参数 |
|------|------|----------|----------|
| `files` | 列出 vault 中的文件 | 无 | `folder`, `ext`, `total`, `vault` |
| `folders` | 列出 vault 中的文件夹 | 无 | `folder`, `total`, `vault` |
| `outline` | 显示笔记标题大纲 | 无 | `file`/`path`, `format` (tree/md/json), `total`, `vault` |
| `wordcount` | 字数和字符数统计 | 无 | `file`/`path`, `words`, `characters`, `vault` |

### 任务管理

| 命令 | 说明 | 必需参数 | 可选参数 |
|------|------|----------|----------|
| `tasks` | 获取待办任务 | 无 | `file`/`path`, `scope` (daily/all), `done`, `status`, `vault` |

> **scope 说明**：指定 `file`/`path` 时自动查该文件任务；未指定时默认 `daily`（今日每日笔记）；可设为 `all`（全库）。无效 scope 值会被拦截并报错。

### 模板

| 命令 | 说明 | 必需参数 | 可选参数 |
|------|------|----------|----------|
| `templates` | 列出 vault 可用模板 | 无 | `total`, `vault` |

> **前提**：需要在 Obsidian 设置中配置 Templates 核心插件的模板文件夹。

## 参数说明

- **`file`**：按笔记名解析（类似 wikilink），如 `file=中心思想`
- **`path`**：精确相对路径，如 `path=分析/复分析/核心与主干/中心思想.md`
- **`vault`**：可选，指定 vault 名称（多 vault 环境下使用）
- **`content`**：支持 `\n` 换行，`\t` 制表符
- **`format`**：部分命令支持输出格式选择（`json`, `yaml`, `tsv`, `tree`, `md` 等）

## 安装

1. 将 `ObsidianBridge` 文件夹放入 VCPToolBox 的 `Plugin` 目录
2. 将 `config.env.example` 复制为 `config.env`，根据需要填写 Obsidian CLI 路径（详见下方配置章节）
3. 重启 VCPToolBox 后端（或等待插件热重载）
4. 确认 Obsidian 桌面端已打开并已注册 CLI

## 配置

### Obsidian CLI 路径（可选）

默认情况下，插件使用系统 PATH 中的 `obsidian` 命令。如果你的 Obsidian CLI 不在 PATH 中，或需要指定特定安装路径：

1. 将 `config.env.example` 复制为 `config.env`
2. 设置 `OBSIDIAN_CLI_PATH` 为你的 Obsidian CLI 完整路径

```bash
# Windows 示例
OBSIDIAN_CLI_PATH=D:\Obsidian\ObProgram\Obsidian.com

# macOS 示例
OBSIDIAN_CLI_PATH=/Applications/Obsidian.app/Contents/MacOS/Obsidian
```

> 如果 `config.env` 不存在或 `OBSIDIAN_CLI_PATH` 为空，插件自动使用 `obsidian` 命令。

如需支持 `templates` 命令，请在 Obsidian 中配置：
- 设置 → 核心插件 → Templates → 模板文件夹位置

如需支持 `daily_*` 系列命令，请在 Obsidian 中配置：
- 设置 → 核心插件 → Daily Notes → 新文件存放位置 + 模板文件位置

## 安全策略

以下 Obsidian CLI 命令存在破坏性风险，**本插件不提供 handler**：

| 命令 | 风险 |
|------|------|
| `delete` | 永久删除文件 |
| `move` / `rename` | 可能破坏内链结构 |
| `eval` | 在 Obsidian 中执行任意 JS 代码 |
| `dev:*` | 开发者工具，权限过大 |
| `plugin:install/uninstall` | 改变 Obsidian 运行环境 |
| `history:restore` | 可能覆盖当前文件内容 |

> 如需这些能力，请通过 Obsidian 桌面端或命令行手动执行。

## 文件结构

```
Plugin/ObsidianBridge/
├── obsidian_bridge.js      # 插件主体 (~17KB, 零依赖)
├── config.env.example      # CLI 路径配置模板
├── plugin-manifest.json    # VCP 插件清单 (22 命令)
└── README.md               # 本文件
```

## 测试记录

v1.2.0 配置化测试（2026-05-08）：

**config.env 配置化加载（2项）**：
- `OBSIDIAN_CLI_PATH` 填写绝对路径 → 正确加载并调用成功 ✅
- `OBSIDIAN_CLI_PATH` 为空 → 正确 fallback 到系统 PATH 中的 `obsidian` ✅

v1.1.2 共 23 项测试全部通过（2026-05-02）：

**核心读写（6项）**：
- `read` 读取笔记完整内容 ✅
- `create` 创建笔记（含多行 content + YAML frontmatter）✅
- `append` 多行追加 ✅
- `prepend` 前插（自动插入 YAML 之后，不破坏 frontmatter）✅
- `daily_read` 读取今日每日笔记 ✅
- `daily_append` / `daily_prepend` / `daily_path` ✅

**搜索（2项）**：
- `search` 全文搜索 ✅
- `search_context` 带上下文搜索 ✅

**标签与属性（4项）**：
- `tags` 标签统计 ✅
- `property_set` 设置属性 ✅
- `property_read` 读取属性 ✅
- `properties` 列出属性（format=json/yaml）✅

**链接关系（2项）**：
- `links` 出站链接 ✅
- `backlinks` 反向链接 ✅

**结构与统计（4项）**：
- `files` / `folders` 文件/文件夹列表 ✅
- `outline` 标题大纲（format=tree/md）✅
- `wordcount` 字数统计 ✅

**任务管理（3项）**：
- `tasks scope=daily` 今日任务 ✅
- `tasks scope=all` 全库任务 ✅
- `tasks path=指定文件` 指定文件任务 ✅

**防御性测试（1项）**：
- `tasks scope=monthly` → 正确返回 `scope invalid: monthly. Use: daily, all` ✅

**模板（1项）**：
- `templates` 列出已配置模板 ✅

## 已知限制

1. **依赖运行中的 Obsidian**：CLI 通过 IPC 与 Obsidian 通信，桌面端必须保持打开
2. **命令拼接方式**：当前使用 `execSync` 字符串拼接。对于包含特殊 shell 字符的 content，理论上存在边缘风险。未来计划迁移至 `execFileSync` 参数数组
3. **单 vault**：默认操作当前打开的 vault。多 vault 环境需通过 `vault` 参数指定

## 版本历史

- **v1.2.0** (2026-05-08): 新增 `config.env` 配置文件支持，CLI 路径不再硬编码；未配置时自动 fallback 到系统 PATH 中的 `obsidian` 命令
- **v1.1.2** (2026-05-02): 修复 `tasks` 忽略 `file`/`path` 参数的问题；新增 `scope` 值白名单校验；版本号同步
- **v1.1.1** (2026-05-02): 修复多行 `content` 写入时字面量 `\n` 被过度转义导致换行失效的问题
- **v1.1.0** (2026-05-01): 新增 12 个命令（`files`/`folders`/`prepend`/`daily_prepend`/`daily_path`/`search_context`/`wordcount`/`outline`/`property_read`/`properties`/`links`/`templates`）；修复 `create` 的 `.md` 双重后缀和无效 `silent` flag
- **v1.0.0** : 初始版本，10 个核心命令

## 贡献者

- **Nova & 水野小夜** — 原始架构设计与 v1.0.0 实现。将 Obsidian 官方 CLI 封装为 VCP 插件的创意和基本的完整功能来自他们，可谓是奠基作者。
- **infinite-vector** — v1.1.x~v1.2.x 系列扩展：命令扩展、转义修复、任务修复、scope 校验、配置化 CLI 路径、单元测试、README

## License

MIT