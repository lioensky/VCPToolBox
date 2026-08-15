# SynBiliVision

SynBiliVision 是一个同步 `stdio` 插件，用于查询当前登录 B 站账号的公开活动摘要：账号信息、浏览历史、收藏夹、最近收藏、投币记录和观看偏好。

## 能力

- `info`: 当前账号信息。
- `history`: 浏览历史，支持 `limit` 和 `days`。
- `favorites`: 收藏夹及内容预览。
- `recent_fav`: 跨收藏夹聚合最近收藏。
- `coins`: 最近投币视频。
- `all`: 综合报告（默认动作）。

示例：

```text
<<<[TOOL_REQUEST]>>>
tool_name: SynBiliVision
action: history
limit: 10
days: 3
<<<[END_TOOL_REQUEST]>>>
```

## 配置与 Cookie 安全

复制 `config.env.example` 为 `config.env`，按需设置 `BILIBILI_COOKIE`、`BILIBILI_COOKIE_FILE` 或 `BILIBILI_MID`。Cookie 来源优先级为：运行时 `input.config`、环境变量/配置文件、同目录 Netscape Cookie 文件。推荐使用 `BILIBILI_COOKIE_FILE` 指向本机导出的 Cookie 文件，避免把明文 Cookie 写入配置。

至少需要有效的 `SESSDATA` 才能访问登录态接口。Cookie 文件、日志、测试输入和更新脚本均属于本机数据，不要提交到 Git。

可选调优项：`SYNBILIVISION_TIMEOUT_MS`、`SYNBILIVISION_REQUEST_TIMEOUT_MS`、`SYNBILIVISION_SUBTITLE_TIMEOUT_MS`、`SYNBILIVISION_HISTORY_ENRICH`。插件会限制超时和返回数量，减少请求失控风险。

## 安装与测试

需要 Node.js 18 或更高版本，以及 VCPToolBox 根目录提供的 `dotenv` 依赖。

```powershell
'{"action":"all","limit":5,"days":3}' | node SynBiliVision.js
```

接口测试需要本机 Cookie，未配置时应验证清晰的认证错误，而不是把 Cookie 写进测试文件。
