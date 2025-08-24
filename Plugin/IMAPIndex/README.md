# IMAPIndex Static Plugin

English documentation. 中文文档见下方“中文说明”。

## Overview

IMAPIndex is a VCP static plugin that:
- Connects to your IMAP server
- Fetches emails from a whitelist of senders within a recent time window
- Stores raw emails (.eml) locally and converts them to Markdown (.md)
- Concatenates all Markdown emails into a single index and writes:
  - The full index to stdout (for VCP placeholder injection)
  - A cache file at ./mail_store/vcp_index.md

Only the IMAP network path supports an optional HTTP(S) CONNECT proxy to bypass outbound blocks on 993. The proxy is not applied to anything else.

## Current Status

- Plugin type: static
- Entry: [IMAPIndex.js](IMAPIndex.js:1)
- Manifest: [plugin-manifest.json](plugin-manifest.json:1) (cron: every 30 minutes, "*/30 * * * *")
- Example env file: [.env.example](.env.example:1)
- Proxy tunneling implementation: [proxy/ImapHttpTunnel.js](proxy/ImapHttpTunnel.js:1)

## Repository Structure

- [IMAPIndex.js](IMAPIndex.js:1) — Static plugin main script; fetch, convert, index, and print
- [proxy/ImapHttpTunnel.js](proxy/ImapHttpTunnel.js:1) — HTTP(S) CONNECT tunnel builder for IMAP only
- [plugin-manifest.json](plugin-manifest.json:1) — Static plugin manifest for VCP host
- [.env.example](.env.example:1) — Environment variable template
- [mail_store/](mail_store) — Local storage for .eml, .md, vcp_index.md

## Install

```bash
npm install
```

## Configure

Create a .env based on [.env.example](.env.example:1):

```
# IMAP
IMAP_USER=your_email@example.com
IMAP_PASS=your_password
IMAP_HOST=imap.example.com
IMAP_PORT=993
IMAP_TLS=true

# Fetch window (days) and local store
TIME_LIMIT_DAYS=3
STORAGE_PATH=./mail_store

# Whitelist senders (comma separated)
WHITELIST=alice@example.com,bob@example.com,charlie@example.com

# Optional: IMAP-only proxy
IMAP_PROXY_ENABLED=false
# http://host:port or https://user:pass@host:port
IMAP_PROXY_URL=
IMAP_PROXY_TIMEOUT_MS=10000
IMAP_PROXY_TLS_REJECT_UNAUTHORIZED=true

# Optional: Post-execution scripts
# A '|' separated list of scripts to run after the main process.
# Use '@/' for the project root.
# Example: POST_RUN_SCRIPTS=@/storkapp_dailynote/extract_stork_links.js
POST_RUN_SCRIPTS=
```

Notes:
- IMAP_TLS=true targets implicit TLS on 993
- TIME_LIMIT_DAYS controls SINCE date for searches
- WHITELIST empty: skip fetch to avoid dumping the entire mailbox
- Proxy affects IMAP only. Other modules do not use the proxy
- POST_RUN_SCRIPTS triggers other workflows, like the Stork dailynote pipeline.

## Run Locally (standalone)

Run the static plugin to produce the index to stdout:

```bash
node IMAPIndex.js
```

Artifacts:
- Combined index on stdout
- Cache file at ./mail_store/vcp_index.md
- Individual .md files per email under ./mail_store/<sender>/

## Use with VCP Host (static plugin)

The host invokes this plugin per the manifest [plugin-manifest.json](plugin-manifest.json:1):
- communication.protocol: stdio
- entryPoint.command: node IMAPIndex.js
- capabilities.systemPromptPlaceholders:
  - Placeholder: {{IMAPIndex}}
- refreshIntervalCron: "*/30 * * * *" (every 30 minutes, 5-field cron)

Typical host behavior:
1) Execute the plugin on schedule
2) Capture stdout
3) Replace the placeholder {{IMAPIndex}} in the system prompt with the stdout content

## Proxy Details (IMAP only)

- Implementation: [proxy/ImapHttpTunnel.js](proxy/ImapHttpTunnel.js:1)
- Flow:
  1) Build an HTTP(S) CONNECT tunnel to the proxy
  2) Perform TLS handshake to the IMAP server over the tunnel
  3) Hand off the secure TLSSocket to node-imap
- Configure with IMAP_PROXY_* variables only if your environment blocks 993
- If you use a self-signed server certificate, set IMAP_PROXY_TLS_REJECT_UNAUTHORIZED=false

## Troubleshooting

- No emails found:
  - Verify WHITELIST and TIME_LIMIT_DAYS
  - Check stderr logs for search counts and dates
- Proxy timeouts:
  - Confirm IMAP_PROXY_URL is reachable
  - Check that the proxy permits CONNECT to port 993
  - Increase IMAP_PROXY_TIMEOUT_MS if needed
- Cert errors:
  - Set IMAP_PROXY_TLS_REJECT_UNAUTHORIZED=false only if you accept the risk

---

# IMAPIndex 静态插件（中文说明）

IMAPIndex 是一个 VCP 静态插件：
- 连接 IMAP 服务器
- 按发件人白名单与时间窗口抓取邮件
- 本地保存 .eml 并转换为 .md
- 将所有 .md 拼接为全文索引，并：
  - 输出到 stdout（供 VCP 占位符注入）
  - 写入缓存文件 ./mail_store/vcp_index.md

仅“邮件链路”支持 HTTP(S) CONNECT 代理（可选），其他模块不走代理。

## 当前状态

- 插件类型：static
- 入口文件：[IMAPIndex.js](IMAPIndex.js:1)
- 清单文件：[plugin-manifest.json](plugin-manifest.json:1)（Cron：每 30 分钟，"*/30 * * * *"）
- 环境变量模板：[.env.example](.env.example:1)
- 代理隧道实现：[proxy/ImapHttpTunnel.js](proxy/ImapHttpTunnel.js:1)

## 仓库结构

- [IMAPIndex.js](IMAPIndex.js:1)：静态插件主程序，抓取/转换/生成索引/打印
- [proxy/ImapHttpTunnel.js](proxy/ImapHttpTunnel.js:1)：仅 IMAP 使用的 HTTP(S) CONNECT 隧道
- [plugin-manifest.json](plugin-manifest.json:1)：静态插件清单
- [.env.example](.env.example:1)：环境变量样例
- [mail_store/](mail_store)：本地存储目录

## 安装

```bash
npm install
```

## 配置

参照 [.env.example](.env.example:1) 创建 .env：

```
IMAP_USER=your_email@example.com
IMAP_PASS=your_password
IMAP_HOST=imap.example.com
IMAP_PORT=993
IMAP_TLS=true

TIME_LIMIT_DAYS=3
STORAGE_PATH=./mail_store
WHITELIST=alice@example.com,bob@example.com,charlie@example.com

IMAP_PROXY_ENABLED=false
IMAP_PROXY_URL=
IMAP_PROXY_TIMEOUT_MS=10000
IMAP_PROXY_TLS_REJECT_UNAUTHORIZED=true

# 可选: 后置执行脚本
# 主流程成功后要顺序执行的脚本列表，用 '|' 分隔
# 使用 '@/' 代表项目根目录
# 示例: POST_RUN_SCRIPTS=@/storkapp_dailynote/extract_stork_links.js
POST_RUN_SCRIPTS=
```

说明：
- 默认使用 993 隐式 TLS（IMAP_TLS=true）
- TIME_LIMIT_DAYS 控制搜索的起始日期（SINCE）
- WHITELIST 为空将跳过抓取，避免全量
- 代理仅作用于 IMAP 链路
- POST_RUN_SCRIPTS 可用于触发其他工作流，例如 Stork 子流程

## 本地运行（独立）

```bash
node IMAPIndex.js
```

输出与文件：
- stdout：完整索引文本
- ./mail_store/vcp_index.md：索引缓存
- ./mail_store/<sender>/：按发件人归档的 .md 文件

## 在 VCP 主机中使用（静态插件）

根据 [plugin-manifest.json](plugin-manifest.json:1)：
- communication.protocol: stdio
- entryPoint.command: node IMAPIndex.js
- capabilities.systemPromptPlaceholders：
  - 占位符：{{IMAPIndex}}
- refreshIntervalCron: "*/30 * * * *"（每 30 分钟）

典型流程：
1) 主机按计划执行插件
2) 捕获 stdout
3) 用 stdout 内容替换系统提示词中的 {{IMAPIndex}} 占位符

## 代理细节（仅 IMAP）

- 隧道：先与代理建立 CONNECT 隧道，再在隧道上对 IMAP 服务器发起 TLS 握手
- 配置：使用 IMAP_PROXY_* 变量。若目标服务器证书为自签，可设置 IMAP_PROXY_TLS_REJECT_UNAUTHORIZED=false

## 常见问题

- 没有匹配邮件：
  - 检查 WHITELIST 与 TIME_LIMIT_DAYS
  - 查看 stderr 日志的日期与命中统计
- 代理连接超时：
  - 检查 IMAP_PROXY_URL 可达性与 CONNECT 是否允许 993
  - 适当增大 IMAP_PROXY_TIMEOUT_MS
- 证书错误：
  - 仅在可接受风险时将 IMAP_PROXY_TLS_REJECT_UNAUTHORIZED=false