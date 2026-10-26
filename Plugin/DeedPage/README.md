# DeedPage

更新日期：2026-10-26。变更摘要：新增可选的 deed.page MCP 同步插件，把 Agent 生成的 HTML 发布为公开网页。

通过 [deed.page](https://deed.page) 的 MCP 端点 `https://deed.page/mcp`，把 Agent 写好的 HTML（报告、看板、演示页等）发布到公开的 `https://<slug>.deed.page/` 地址，无需账号或 API 密钥。现有插件和系统提示词保持不变。限制与完整工具列表见 [deed.page 文档](https://deed.page/docs)。

## 安装与启用

需要 Node.js 20 或更高版本。在已安装的 VCPToolBox 根目录执行：

```bash
npm ci --prefix Plugin/DeedPage
```

重启 VCPToolBox 或通过管理面板重新加载插件。在需要使用该工具的 Agent 系统提示词中加入 `{{VCPDeedPage}}`。禁用方法与其他插件相同：将 `plugin-manifest.json` 重命名为 `plugin-manifest.json.block`。

## 令牌

未配置令牌时，首次 `publish_site` 会在结果中返回 `token`（`deed_tok_...`，只显示一次）。把它保存到 `Plugin/DeedPage/config.env`（参考 `config.env.example`）：

```bash
DEEDPAGE_TOKEN=deed_tok_...
```

配置后插件以 `Authorization: Bearer` 发送该令牌，后续发布归属同一所有者，并可更新或删除站点。`config.env` 已被 `.gitignore` 忽略，不要提交令牌。

## VCP 调用

发布网页（`html` 作为 `index.html`；`ttl_seconds` 可选，省略则永久保留）：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」DeedPage「末」,
command:「始」publish_site「末」,
html:「始」<!doctype html><meta charset="utf-8"><title>周报</title><h1>本周进展</h1>「末」,
ttl_seconds:「始」86400「末」
<<<[END_TOOL_REQUEST]>>>
```

可选 `slug`（小写字母、数字和连字符，1–63 字符）指定子域名；省略时随机生成。对已拥有的 `slug` 再次发布即更新该站点。查询站点用 `get_site`，删除站点用 `delete_site`（两者都只需 `slug`，删除需要已配置的令牌）。

插件标准输出把 MCP 的 `content` 数组和解析后的 JSON 字段一起放在 `result` 中（例如 `url`、`slug`、`version`、`expires_at`、首次发布的 `token`）。工具返回错误或 `ok: false` 时返回 `status: "error"`。单次 MCP 操作总时限为 45 秒，VCP 进程超时为 60 秒。

发布的网页对任何持有链接的人公开。不要发布密钥、凭据或隐私内容。

## 本地验证

```bash
npm test --prefix Plugin/DeedPage
printf '%s' '{"command":"publish_site","html":"<h1>VCPToolBox test</h1>","ttl_seconds":"600"}' | node Plugin/DeedPage/DeedPage.js
```

测试使用本地响应验证 MCP 初始化、工具发现、调用、JSON/SSE 返回格式、令牌头和错误路径；上面的实际发布需要联网，生成的测试页 10 分钟后过期。请求使用固定端点 `https://deed.page/mcp` 和 `VCPToolBox-DeedPage/1.0.0` User-Agent。

实现依据：[plugin-manifest.json](./plugin-manifest.json)、[DeedPage.js](./DeedPage.js)、[VCP 插件生态规范](../../docs/PLUGIN_ECOSYSTEM.md)、[同步插件开发手册](../../docs/VCP同步异步插件开发手册.md)。
