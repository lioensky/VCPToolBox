## AnySearch - 实时搜索插件

调用 [AnySearch](https://anysearch.com) API，提供**垂直领域搜索、通用搜索、批量并行搜索、自由路线编排、子领域目录查询和网页 Markdown 正文提取**能力。

### v3.0.1 对齐要点

- **能力级隐式路由**：普通搜索和批量搜索固定走结构化 REST `/v1/search`，便于插件本地做字段选择、跨路线 URL/摘要去重和输出预算控制；`get_sub_domains`、`extract` 和维护同步固定走 MCP `/mcp`。路由由插件能力决定，不暴露传输开关，也不做跨传输自动回退。
- **自由路线编排**：支持 `query1..query5` / `sub_domain1..sub_domain5` / `params1..params5` / `max_results1..max_results5` 编号字段，每路继承顶层默认值；1–5 路请求在一次同步插件调用内用非阻塞 I/O 真并发执行。
- **高信噪比输出**：REST 结果仅按 canonical URL 做跨路线硬去重；同一 URL 合并来源路线并保留更完整摘要，不同 URL 即使摘要近似也保留；搜索最终文本严格不超过 20,000 字符。
- **安全输出**：`X-Anysearch-Client: vcp-anysearch/3.0.1` 客户端标识；错误文本不回显完整 headers/Authorization/响应体；非 JSON 响应做 token 脱敏。

### 设计要点

- **极简调用**：`command` 可省略（有 `query` 即搜索、有 `queries` 即批量、有 `url` 即提取）；`domain` 可省略（自动取 `sub_domain` 的「域.」前缀）；子领域参数用纯文本 `k=v,k2=v2`、`{k:v}` 或 JSON 对象。
- **紧凑目录内嵌在工具描述里**：目录每行 `域: 子域(Required 标记)`，AI 可直接选择垂直子域；部分 Required 字段受 `type` 等条件约束，不适用时不要传。`get_sub_domains` 实时返回官方完整 Markdown schema，包括全部参数名、Required、描述、枚举、格式和条件规则。
- **目录维护脚本 `sync.js`**（手动执行，非插件入口）：

  ```bash
  node Plugin/AnySearch/sync.js
  ```

  经 `tools/list` 读取服务端声明的领域 enum（新领域自动发现），按每批 ≤5 个域拉全子域与必填参数，与描述中目录区块做**语义比对**（域、子域、必填参数集合，与顺序无关）；仅当真实变化才以「临时文件 + 原子改名」改写该区块——幂等，不会动区块之外的任何人工内容。写入后由 VCP 服务器自身的清单热重载机制刷新工具描述。

- **零运行时开销、零竞态、零工具泄露**：`sync.js` 没有独立 manifest，不被 PluginManager 加载、不出现在 AI 工具列表、不参与服务器启动；AnySearch 常规调用没有任何描述生成副作用。
- **人工可接管**：手动编辑 `plugin-manifest.json` 同样被服务器热重载；删除「目录(域: 子域(必填参数)):」或「调用格式:」锚行即可让 `sync.js` 永久停写。
- **文档权威边界**：`plugin-manifest.json` 是 `sync.js` 维护的机器领域目录；`SearchToolBox.txt` 只保留稳定调用语义与领域选择指引；本 README 面向开发者。动态上游参数不在三处重复维护。
- **返回形态**：成功时输出 `{status:"success", result:{content:[{type:"text", text:<Markdown>}]}}`，走 VCP 富内容路径，AI 直接收到干净的 Markdown 结果文本。

### 配置

`config.env`（均为可选）：

```env
# API Key。不配置时匿名访问（额度较低）。支持多个 Key 用英文逗号分隔，每次请求随机选用一个。
# 获取地址：https://anysearch.com/console/api-keys
ANYSEARCH_API_KEY=

# 搜索 endpoint（默认 https://api.anysearch.com/v1/search）
# 普通搜索和批量搜索走这个 endpoint，返回结构化 JSON 便于结果裁剪。
ANYSEARCH_SEARCH_ENDPOINT=https://api.anysearch.com/v1/search

# MCP endpoint（默认 https://api.anysearch.com/mcp）
# get_sub_domains、extract 和维护同步走这个 endpoint。
ANYSEARCH_MCP_ENDPOINT=https://api.anysearch.com/mcp

# 兼容别名，等同于 ANYSEARCH_MCP_ENDPOINT。新配置建议用 ANYSEARCH_MCP_ENDPOINT。
# ANYSEARCH_ENDPOINT=https://api.anysearch.com/mcp

# HTTP 请求超时，单位毫秒，范围 1000-40000（默认 30000）
# VCP 宿主在 45000ms 终止同步插件，内部上限保留进程清理余量。
ANYSEARCH_TIMEOUT_MS=30000
```

`sync.js` 仅识别 `ANYSEARCH_MCP_ENDPOINT`（或兼容别名 `ANYSEARCH_ENDPOINT`），匿名调用，不读取 Key。

### 使用示例

**1. 垂直搜索**（4 行：目录选 `sub_domain`，括号内是官方 Required 标记；具体条件以实时 schema 为准）：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AnySearch「末」,
query:「始」Apple 最新公司新闻「末」,
sub_domain:「始」finance.news「末」,
params:「始」type=stock,symbol=AAPL「末」
<<<[END_TOOL_REQUEST]>>>
```

**2. 复杂垂直搜索**（多个深参数仍用自然的 `k=v` 文本，不需要嵌套 JSON）：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AnySearch「末」,
query:「始」Jinja2 2.4.1 已知漏洞与修复建议「末」,
sub_domain:「始」security.vuln「末」,
params:「始」type=package,value=PyPI:jinja2@2.4.1「末」,
max_results:「始」5「末」
<<<[END_TOOL_REQUEST]>>>
```

**3. 通用搜索**（2 行）：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AnySearch「末」,
query:「始」what is photosynthesis「末」
<<<[END_TOOL_REQUEST]>>>
```

**4. 区域搜索**（`zone` 仅支持 `cn` 或 `intl`，不是 `us`、`jp` 等国家代码）：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AnySearch「末」,
query:「始」人工智能最新动态「末」,
zone:「始」cn「末」
<<<[END_TOOL_REQUEST]>>>
```

**5. 批量并行搜索**（顶层 `sub_domain`/`zone`/`params`/`max_results` 注入每条，1-5 条）：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AnySearch「末」,
sub_domain:「始」finance.news「末」,
params:「始」type=general「末」,
queries:「始」AI 芯片需求 2026|全球 EV 市场展望「末」
<<<[END_TOOL_REQUEST]>>>
```

**5. 自由路线编排**（同一问题并发查多个方向，编号字段继承顶层默认值）：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AnySearch「末」,
query:「始」Go 1.26 有哪些重要变化「末」,
sub_domain1:「始」code.doc「末」,
params1:「始」library=golang「末」,
query2:「始」Go 1.26 new APIs examples「末」,
sub_domain2:「始」code.snippet「末」,
sub_domain3:「始」general「末」,
max_results:「始」3「末」
<<<[END_TOOL_REQUEST]>>>
```

**6. 网页正文提取**（2 行）：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AnySearch「末」,
url:「始」https://example.com/article「末」
<<<[END_TOOL_REQUEST]>>>
```

**7. 查询子领域参数含义**（仅当需要参数说明/可选值时）：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AnySearch「末」,
command:「始」get_sub_domains「末」,
domain:「始」finance「末」
<<<[END_TOOL_REQUEST]>>>
```

### 参数说明

| 参数                       | 别名                   | 必需                               | 说明                                                                                   |
| -------------------------- | ---------------------- | ---------------------------------- | -------------------------------------------------------------------------------------- |
| command                    | action, tool, mode     | 通常省略                           | 按参数自动推断；显式可用 `search` / `get_sub_domains` / `batch_search` / `extract`     |
| query                      | q, text                | 搜索必需                           | 搜索词                                                                                 |
| sub_domain                 | subDomain, subdomain   | 垂直搜索必需                       | 目录中的「域.子域」，如 `finance.news`；不带即通用搜索                                 |
| zone                       | Zone                   | 否                                 | **仅** `cn`（中国大陆）或 `intl`（国际）；插件会校验并传给 API。批量搜索由顶层注入每条，自由路线可由 `zone1..zone5` 覆盖 |
| domain                     | -                      | 通常省略                           | 自动取 `sub_domain` 前缀；显式给出且与前缀矛盾时报错                                   |
| params                     | sub_domain_params, sdp | 按所选子域                         | 文本 `k=v,k2=v2`、`{k:v}` 或 JSON 对象；不适用参数不要传，完整规则查 `get_sub_domains` |
| max_results                | maxResults             | 否                                 | 结果数量，范围 1-10                                                                    |
| queries                    | query_items            | 批量必需                           | 1-5 条，`\|` 分隔；也接受 JSON 数组；顶层共享参数注入每条                              |
| query1..query5             | q1..q5, text1..text5   | 自由路线                           | 编号字段，每路继承顶层默认值；与 `queries` 不能混用                                    |
| sub_domain1..sub_domain5   | subDomain1..5          | 自由路线                           | 每路子域覆盖                                                                           |
| zone1..zone5               | -                      | 自由路线                           | 每路搜索区域覆盖                                                                       |
| params1..params5           | sdp1..5                | 自由路线                           | 每路深参数覆盖                                                                         |
| max_results1..max_results5 | maxResults1..5         | 自由路线                           | 每路结果数覆盖                                                                         |
| domains                    | -                      | `get_sub_domains` 与 domain 二选一 | 领域数组或逗号分隔字符串，最多 5 个                                                    |
| url                        | URL, link              | 提取必需                           | 要提取正文的网页 URL                                                                   |

### 领域与子领域目录

与工具描述内嵌目录一致（括号内为官方 Required 标记，可能包含条件必填字段），可随时用 `node sync.js` 保鲜；完整参数语义以实时 `get_sub_domains` 为准：

```text
general: general
finance: news(type) quote(type,symbol,cn_code) fundamental(type,symbol,cn_code) macro(type) calendar(type) screen(type)
academic: search dataset preprint citation(id) biomedical
legal: legislation case statute
health: drug(type) trial stats
business: trade company jobs people
security: intel(ioc) scan(ioc) vuln(type,value) noise(ip)
code: doc(library) snippet
energy: production electricity
travel: flight(departure,arrival,date) flight_status(departure,arrival,date)
gaming: store esports(type)
resource: image
social_media: social_media
ip: global
environment: aqi
agriculture: fao
film: torrent
```

### 依赖

- Node.js >= 14.0.0
- 无第三方 npm 依赖
