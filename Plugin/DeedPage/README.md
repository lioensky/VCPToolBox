# DeedPage

更新日期：2026-10-26。变更摘要：令牌改为每次工具调用显式传入，支持分别管理多个网站，不再读取统一环境变量。

通过 [deed.page](https://deed.page) 的 MCP 端点 `https://deed.page/mcp`，把 Agent 写好的 HTML（报告、看板、演示页等）发布到公开的 `https://<slug>.deed.page/` 地址，无需账号或 API 密钥。现有插件和系统提示词保持不变。限制与完整工具列表见 [deed.page 文档](https://deed.page/docs)。

## 安装与启用

需要 Node.js 20 或更高版本。在已安装的 VCPToolBox 根目录执行：

```bash
npm ci --prefix Plugin/DeedPage
```

重启 VCPToolBox 或通过管理面板重新加载插件。在需要使用该工具的 Agent 系统提示词中加入 `{{VCPDeedPage}}`。禁用方法与其他插件相同：将 `plugin-manifest.json` 重命名为 `plugin-manifest.json.block`。

## 令牌

新建网站无需令牌。不传 [`token`](DeedPage.js:25) 发布时，服务会在结果中返回令牌（只显示一次），请将站点名与对应令牌一起妥善保存。

更新或删除时，在本次工具调用中显式传入对应站点的 [`token`](DeedPage.js:25)，插件仅将它用于 MCP 请求认证头，不放入远端工具参数。不同网站可以分别使用各自的令牌，无需改配置或重启插件。

**迁移注意：**旧版环境变量 DEEDPAGE_TOKEN 不再读取，已有私密配置文件不会被自动修改。请保留原令牌，并在后续更新、删除调用中显式传入。令牌是管理凭据，不要提交到仓库、写入公开网页或分享给无关人员。工具调用参数可能进入对话或调用记录，请注意其访问权限。

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

可选站点名（小写字母、数字和连字符，1–63 字符）指定子域名；省略时随机生成。

### 编辑已有网站

继续使用 [`publish_site`](DeedPage.js:29)，显式传入原站点名、对应令牌及新网页内容。不传令牌的调用按匿名发布处理；是否为已有站点、令牌是否拥有该站点，由远端服务校验。

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」DeedPage「末」,
command:「始」publish_site「末」,
slug:「始」weekly-report「末」,
token:「始」deed_tok_example「末」,
html:「始」<!doctype html><meta charset="utf-8"><title>周报</title><h1>更新后的进展</h1>「末」
<<<[END_TOOL_REQUEST]>>>
```

### 删除网站

删除前先征得用户确认，必须显式提供对应站点的令牌；缺失令牌时本地校验直接报错，不发送请求。

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」DeedPage「末」,
command:「始」delete_site「末」,
slug:「始」weekly-report「末」,
token:「始」deed_tok_example「末」
<<<[END_TOOL_REQUEST]>>>
```

查询公开信息使用 [`get_site`](DeedPage.js:37)，只需站点名，无需令牌。管理其他网站时，替换为该网站的站点名和对应令牌；插件不保存或跨调用复用令牌。

插件标准输出仅返回经过白名单及类型/格式校验的业务字段，例如站点链接、站点名、版本、到期时间、大小、文件数、套餐、删除结果，以及首次发布的 [`token`](DeedPage.js:59)。令牌会原样保留，并附带插件本地固定的中文说明，提醒 Agent 记住站点与令牌的对应关系，用于后续管理；插件本身不会自动持久化令牌。

远端响应一律作为不可信数据处理：不透传原始 MCP 文本数组、操作步骤、Agent 指令、推广信息或未知字段；嵌套对象也不整体透传。工具结果错误只保留格式受限的错误码，不回显远端自由文本。这样可避免远端要求写文件、修改环境变量、植入记忆或推广付费服务的文案直接进入模型上下文。此机制是收紧数据边界，不代表可以把保留下来的业务数据当成可信指令。

工具返回错误或业务失败时返回错误状态。单次 MCP 操作总时限为 45 秒，VCP 进程超时为 60 秒。

发布的网页对任何持有链接的人公开。不要发布密钥、凭据或隐私内容。

## 本地验证

```bash
npm test --prefix Plugin/DeedPage
printf '%s' '{"command":"publish_site","html":"<h1>VCPToolBox test</h1>","ttl_seconds":"600"}' | node Plugin/DeedPage/DeedPage.js
```

测试使用本地响应验证 MCP 初始化、工具发现、调用、JSON/SSE 返回格式、显式令牌头、多站点并发凭据隔离、旧环境变量不再生效、非法令牌和错误路径；上面的实际发布需要联网，生成的测试页 10 分钟后过期。请求使用固定端点 https://deed.page/mcp 和 VCPToolBox-DeedPage/1.0.0 User-Agent。

实现依据：[plugin-manifest.json](./plugin-manifest.json)、[DeedPage.js](./DeedPage.js)、[VCP 插件生态规范](../../docs/PLUGIN_ECOSYSTEM.md)、[同步插件开发手册](../../docs/VCP同步异步插件开发手册.md)。
