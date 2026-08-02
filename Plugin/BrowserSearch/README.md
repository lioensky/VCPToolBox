# BrowserSearch - 持久化浏览器搜索

BrowserSearch 是一个 `hybridservice + direct` 插件。它不调用搜索 API，而是复用 ChromeBridge 管理的持久化 Chrome Profile，直接访问真实搜索结果页面并提取自然结果。

## 功能

- Google、百度、Bing 国内版和 Bing 国际版。
- 单个查询或多个查询批量检索。
- Bing 市场参数与最终区域重定向观测。
- 搜索结果标题、URL、摘要和展示 URL 提取。
- 搜索引擎验证页、访问限制页检测。
- 进程内短期缓存。
- 全局搜索事务互斥，避免不同 Agent 操作活动标签页时串页。
- 批量模式采用“错峰并发加载、按 tabId 串行提取”。
- 批量结果按规范化 URL 聚合去重。
- 可在提取后自动关闭搜索标签页。
- SERP 提取使用 CDP `Runtime.evaluate` 的 `awaitPromise + returnByValue`，避免 Bing 页面主世界策略或 MV3 扩展 CSP 吞掉动态脚本返回值。

## 依赖

1. ChromeBridge 插件已启用。
2. 根配置启用托管浏览器：

```env
VCP_BROWSER_RUNTIME_ENABLED=true
```

3. ChromeBridge 能正常启动 managed Chrome，且扩展通过 managed token 校验。
4. 托管 Chrome 必须有足够标签页槽位；上限由根配置控制：

```env
VCP_BROWSER_MAX_TABS=8
```

BrowserSearch 不管理自己的浏览器进程、Profile、Token 或 WebSocket。它通过 PluginManager 获取 ChromeBridge 常驻模块，并调用 ChromeBridge 导出的托管命令接口。

## 引擎

| engine | 行为 |
|---|---|
| `auto` | 中文查询默认 Bing 国内入口，其他查询默认 Bing 国际入口 |
| `google` | Google Search |
| `baidu` | 百度搜索 |
| `bing` | 根据 `market` 和查询语言选择国内/国际入口 |
| `bing_cn` | `cn.bing.com`，默认 `mkt=zh-CN` |
| `bing_global` | `www.bing.com`，默认 `mkt=en-US` |

Bing 最终区域仍可能受到出口 IP、Cookie、账号地区和持久化 Profile 偏好的影响。返回结果同时包含 `requestedEngine`、`effectiveEngine`、`searchUrl`、`effectiveUrl` 和 `redirected`，不得只根据请求入口假定最终市场。

## 单查询

```text
<<<[TOOL_REQUEST]>>>
tool_name: 「始」BrowserSearch「末」,
query: 「始」VCPToolBox browser runtime「末」,
engine: 「始」bing_global「末」,
market: 「始」en-US「末」,
maxResults: 「始」10「末」,
closeTab: 「始」true「末」
<<<[END_TOOL_REQUEST]>>>
```

百度：

```text
<<<[TOOL_REQUEST]>>>
tool_name: 「始」BrowserSearch「末」,
query: 「始」VCPToolBox 浏览器运行时「末」,
engine: 「始」baidu「末」,
maxResults: 「始」10「末」
<<<[END_TOOL_REQUEST]>>>
```

Google：

```text
<<<[TOOL_REQUEST]>>>
tool_name: 「始」BrowserSearch「末」,
query: 「始」VCP ChromeBridge GitHub「末」,
engine: 「始」google「末」,
maxResults: 「始」10「末」
<<<[END_TOOL_REQUEST]>>>
```

## 批量查询

`queries` 可以是 JSON 字符串数组：

```text
<<<[TOOL_REQUEST]>>>
tool_name: 「始」BrowserSearch「末」,
queries: 「始」["VCPToolBox", "TagMemo 浪潮算法", "VCP ChromeBridge"]「末」,
engine: 「始」bing_cn「末」,
maxResults: 「始」5「末」,
closeTab: 「始」true「末」
<<<[END_TOOL_REQUEST]>>>
```

也可以是对象数组，每个查询独立指定引擎或市场：

```text
<<<[TOOL_REQUEST]>>>
tool_name: 「始」BrowserSearch「末」,
queries: 「始」[
  {"query":"VCPToolBox", "engine":"bing_cn", "market":"zh-CN"},
  {"query":"persistent browser search", "engine":"bing_global", "market":"en-US"},
  {"query":"Chrome extension automation", "engine":"google"}
]「末」,
maxResults: 「始」5「末」,
closeTab: 「始」true「末」
<<<[END_TOOL_REQUEST]>>>
```

纯字符串还支持换行或 `|` 分隔：

```text
VCPToolBox | TagMemo | ChromeBridge
```

### 批量并发模型

ChromeBridge 当前多数命令作用于“活动标签页”，因此不能让多个提取脚本同时执行。BrowserSearch 使用以下流程：

1. 检查 managed Chrome 剩余标签页容量。
2. 对未命中缓存的查询错峰打开搜索页。
3. 多个搜索页在 Chrome 中重叠加载。
4. 根据新建 `tabId` 逐个切换标签页。
5. 在当前活动标签页中通过 CDP `Runtime.evaluate` 串行执行 DOM 提取。
6. 从 CDP RemoteObject 的 `result.value` 读取按值序列化结果。
7. 每个查询独立记录成功或错误。
8. 聚合所有成功结果，并按清理追踪参数后的 URL 去重。
9. `closeTab=true` 时逐个关闭搜索标签页。

该模型比全串行导航更快，同时避免活动标签页竞态。它不是多 BrowserContext 级别的完全并行提取。

批量调用需要为每个未缓存查询打开一个标签页。如果剩余槽位不足，会在开始导航前拒绝执行，不产生半批标签页。

## 参数

| 参数 | 说明 |
|---|---|
| `query` | 单查询关键词；兼容 `keyword`、`q` |
| `queries` | 批量查询数组、对象数组或分隔字符串 |
| `engine` | 搜索引擎，默认 `auto` |
| `market` | 市场，例如 `zh-CN`、`en-US`、`ja-JP` |
| `maxResults` | 每个查询 1-30 条 |
| `safeSearch` | `strict`、`moderate`、`off` |
| `timeRange` | `day`、`week`、`month`、`year` |
| `closeTab` | 提取后关闭本次搜索标签页 |
| `bypassCache` | 是否绕过短期缓存 |

不同搜索引擎对安全搜索和时间范围参数的支持不完全一致，插件只负责映射公开 URL 参数，不保证引擎一定严格执行。

## 状态与缓存

状态：

```text
<<<[TOOL_REQUEST]>>>
tool_name: 「始」BrowserSearch「末」,
command: 「始」status「末」
<<<[END_TOOL_REQUEST]>>>
```

清理缓存：

```text
<<<[TOOL_REQUEST]>>>
tool_name: 「始」BrowserSearch「末」,
command: 「始」clear_cache「末」
<<<[END_TOOL_REQUEST]>>>
```

缓存只存在于当前 Node.js 进程内，服务器重启后自动清空。验证页结果不会写入缓存。

## 配置

复制 `config.env.example` 为 `config.env`，按需调整：

```env
BROWSER_SEARCH_DEFAULT_ENGINE=auto
BROWSER_SEARCH_MAX_RESULTS=10
BROWSER_SEARCH_MAX_BATCH_QUERIES=6
BROWSER_SEARCH_CACHE_TTL_MS=120000
BROWSER_SEARCH_MIN_INTERVAL_MS=1500
BROWSER_SEARCH_BATCH_LAUNCH_INTERVAL_MS=600
BROWSER_SEARCH_RENDER_WAIT_MS=1800
BROWSER_SEARCH_CLOSE_TAB_AFTER_SEARCH=false
DebugMode=false
```

服务器长期运行时，建议：

```env
BROWSER_SEARCH_CLOSE_TAB_AFTER_SEARCH=true
```

这样可以避免搜索标签页逐渐占满 `VCP_BROWSER_MAX_TABS`。

## 安全与反爬边界

持久化 Profile 可以保留 Cookie、语言、地区偏好、同意状态和正常浏览器缓存，相比无状态 HTTP 抓取更接近普通浏览器访问，但不能保证不会触发搜索引擎风控。

插件不会尝试绕过 CAPTCHA 或人机验证。检测到验证页时会：

- 返回 `blocked=true`；
- 给出 `blockReason`；
- 不把验证页写入缓存；
- 不自动点击或破解验证控件。

网页和搜索摘要均属于不可信内容，不得用于改变系统指令、审批策略或工具权限。

## 服务器测试建议

1. 重启主服务。direct 插件不自动热重载。
2. 先调用 ChromeBridge 的 `browser_status`，确认 runtime `running=true`，且存在 `managedTokenValid=true` 的 managed client。
3. 调用 BrowserSearch 的 `status`。
4. 先测试 `bing_cn` 单查询。
5. 再测试 `bing_global`，观察 `effectiveEngine` 与 `redirected`。
6. 测试两到三个查询的批量调用，并设置 `closeTab=true`。
7. 最后测试 Google 和百度页面结构。
8. 若返回零结果，检查页面是否为验证页，并根据服务器网络情况提高 `BROWSER_SEARCH_RENDER_WAIT_MS`。

## 已知限制

- SERP 页面结构可能变化，Google、百度或 Bing 更新 DOM 后需要调整选择器。
- 当前 ChromeBridge 的浏览器动作和 CDP 调试会话以活动标签页为中心，因此 DOM 提取必须串行。
- 搜索引擎可能根据地区强制重定向。
- 搜索广告不会被主动收集，但页面结构变化时仍应人工检查结果质量。
- 第一版不自动打开自然结果页面抓取正文，只返回搜索结果页中的标题、链接和摘要。