# ParallelSearch

更新日期：2026-10-11。变更摘要：新增可选的 Parallel Search MCP 同步插件，提供免密钥网页搜索和页面提取。

通过 [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp) 提供免费网页搜索（Fast 模式）和页面提取，无需账号或 API 密钥。免费服务适合轻量使用，有速率限制。现有搜索插件和系统提示词保持不变。

## 安装与启用

需要 Node.js 20 或更高版本。在已安装的 VCPToolBox 根目录执行：

```bash
npm ci --prefix Plugin/ParallelSearch
```

重启 VCPToolBox 或通过管理面板重新加载插件。在需要使用该工具的 Agent 系统提示词中加入 `{{VCPParallelSearch}}`。本插件按需执行，不替换 TavilySearch、AnySearch 等现有工具。禁用方法与其他插件相同：将 `plugin-manifest.json` 重命名为 `plugin-manifest.json.block`。

## VCP 调用

网页搜索：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」ParallelSearch「末」,
command:「始」web_search「末」,
objective:「始」查找 Node.js 的官方发布信息「末」,
search_queries:「始」["Node.js official release schedule"]「末」
<<<[END_TOOL_REQUEST]>>>
```

页面提取：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」ParallelSearch「末」,
command:「始」web_fetch「末」,
urls:「始」["https://nodejs.org/en/about/previous-releases"]「末」,
objective:「始」提取版本支持周期「末」
<<<[END_TOOL_REQUEST]>>>
```

`search_queries` 和 `urls` 使用 JSON 字符串数组。搜索需要非空 `objective` 和至少一个查询；页面提取接受 1–20 个 HTTP/HTTPS URL，可选 `objective`（最多 200 字符）、`search_queries` 和 `full_content`（`true`/`false`，默认 `false`）。优先使用搜索摘录，仅在需要具体页面内容时提取。完整内容可能很大。

两种命令均接受可选 `session_id`（最多 100 字符）。同一会话应复用稳定的 ID；未传入时，服务返回的 `session_id` 可用于后续 VCP 调用。插件标准输出将 MCP 的 `content` 数组和结构化数据一起放在 `result` 中（来源 URL、标题、摘录及提取错误）。VCP 插件管理器解包后直接返回这些字段，后续调用可读取 `session_id`。MCP 工具错误返回 `status: "error"`；批量提取的部分失败保留在 `result.errors`，调用方需检查（VCP 返回值中为 `errors`）。单次 MCP 操作总时限为 45 秒，VCP 进程超时为 60 秒。

## 本地验证

```bash
npm test --prefix Plugin/ParallelSearch
printf '%s' '{"command":"web_search","objective":"Find Node.js official release information","search_queries":["Node.js official release schedule"]}' | node Plugin/ParallelSearch/ParallelSearch.js
printf '%s' '{"command":"web_fetch","urls":["https://nodejs.org/en/about/previous-releases"],"objective":"Extract version support schedule"}' | node Plugin/ParallelSearch/ParallelSearch.js
```

测试使用本地响应验证 MCP 初始化、工具发现、调用、JSON/SSE 返回格式和错误路径；上面两条实际调用需要联网。请求使用固定的匿名端点 `https://search.parallel.ai/mcp` 和 `VCPToolBox-ParallelSearch/1.0.0` User-Agent，不读取 Parallel 密钥或保存的认证信息。

实现依据：[plugin-manifest.json](./plugin-manifest.json)、[ParallelSearch.js](./ParallelSearch.js)、[VCP 插件生态规范](../../docs/PLUGIN_ECOSYSTEM.md)、[同步插件开发手册](../../docs/VCP同步异步插件开发手册.md)。
