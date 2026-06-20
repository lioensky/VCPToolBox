## AnySearch - 实时搜索插件

调用 [AnySearch](https://anysearch.com) JSON-RPC API，提供**垂直领域搜索、通用搜索、批量并行搜索、子领域目录查询和网页 Markdown 正文提取**能力。

### 设计要点

- **极简调用**：`command` 可省略（有 `query` 即搜索、有 `queries` 即批量、有 `url` 即提取）；`domain` 可省略（自动取 `sub_domain` 的「域.」前缀）；子领域参数用纯文本 `k=v,k2=v2`。垂直搜索最少 4 行、通用搜索与网页提取各 2 行。
- **注记目录内嵌在工具描述里**：目录每行 `域: 子域(必填参数)`，AI 不需要先查目录就能直接发起带必填参数的垂直搜索；`get_sub_domains` 仅在需要参数含义/可选值时使用。
- **目录维护脚本 `sync.js`**（手动执行，非插件入口）：

  ```bash
  node Plugin/AnySearch/sync.js
  ```

  经 `tools/list` 读取服务端声明的领域 enum（新领域自动发现），按每批 ≤5 个域拉全子域与必填参数，与描述中目录区块做**语义比对**（域、子域、必填参数集合，与顺序无关）；仅当真实变化才以「临时文件 + 原子改名」改写该区块——幂等，不会动区块之外的任何人工内容。写入后由 VCP 服务器自身的清单热重载机制刷新工具描述。
- **零运行时开销、零竞态、零工具泄露**：`sync.js` 没有独立 manifest，不被 PluginManager 加载、不出现在 AI 工具列表、不参与服务器启动；AnySearch 常规调用没有任何描述生成副作用。
- **人工可接管**：手动编辑 `plugin-manifest.json` 同样被服务器热重载；删除「目录(域: 子域(必填参数)):」或「调用格式:」锚行即可让 `sync.js` 永久停写。
- **返回形态**：成功时输出 `{status:"success", result:{content:[{type:"text", text:<Markdown>}]}}`，走 VCP 富内容路径，AI 直接收到干净的 Markdown 结果文本。

### 配置

`config.env`（均为可选）：

```env
# API Key。不配置时匿名访问（额度较低）。支持多个 Key 用英文逗号分隔，每次请求随机选用一个。
# 获取地址：https://anysearch.com/console/api-keys
ANYSEARCH_API_KEY=

# JSON-RPC endpoint（默认 https://api.anysearch.com/mcp）
ANYSEARCH_ENDPOINT=https://api.anysearch.com/mcp

# HTTP 请求超时，单位毫秒，范围 1000-120000（默认 30000）
ANYSEARCH_TIMEOUT_MS=30000
```

`sync.js` 仅识别 `ANYSEARCH_ENDPOINT`（匿名调用，不读取 Key）。

### 使用示例

**1. 垂直搜索**（4 行：目录选 `sub_domain`，括号内必填参数写进 `params`）：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AnySearch「末」,
query:「始」Apple 最新公司新闻「末」,
sub_domain:「始」finance.news「末」,
params:「始」type=stock,symbol=AAPL「末」
<<<[END_TOOL_REQUEST]>>>
```

**2. 通用搜索**（2 行）：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AnySearch「末」,
query:「始」what is photosynthesis「末」
<<<[END_TOOL_REQUEST]>>>
```

**3. 批量并行搜索**（顶层 `sub_domain`/`params`/`max_results` 注入每条，1-5 条）：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AnySearch「末」,
sub_domain:「始」finance.news「末」,
params:「始」type=general「末」,
queries:「始」AI 芯片需求 2026|全球 EV 市场展望「末」
<<<[END_TOOL_REQUEST]>>>
```

**4. 网页正文提取**（2 行）：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AnySearch「末」,
url:「始」https://example.com/article「末」
<<<[END_TOOL_REQUEST]>>>
```

**5. 查询子领域参数含义**（仅当需要参数说明/可选值时）：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AnySearch「末」,
command:「始」get_sub_domains「末」,
domain:「始」finance「末」
<<<[END_TOOL_REQUEST]>>>
```

### 参数说明

| 参数 | 别名 | 必需 | 说明 |
|------|------|------|------|
| command | action, tool, mode | 通常省略 | 按参数自动推断；显式可用 `search` / `get_sub_domains` / `batch_search` / `extract` |
| query | q, text | 搜索必需 | 搜索词 |
| sub_domain | subDomain, subdomain | 垂直搜索必需 | 目录中的「域.子域」，如 `finance.news`；不带即通用搜索 |
| domain | - | 通常省略 | 自动取 `sub_domain` 前缀；显式给出且与前缀矛盾时报错 |
| params | sub_domain_params, sdp | 按目录括号 | 文本 `k=v,k2=v2`；必填项无适用值留空（`k=`）；也接受 JSON 对象 |
| max_results | maxResults | 否 | 结果数量，范围 1-10 |
| domains | - | `get_sub_domains` 与 domain 二选一 | 领域数组或逗号分隔字符串，最多 5 个 |
| queries | query_items | 批量必需 | 1-5 条，`\|` 分隔；也接受 JSON 数组；顶层共享参数注入每条 |
| url | URL, link | 提取必需 | 要提取正文的网页 URL |

### 领域与子领域目录

与工具描述内嵌目录一致（括号内为该子域必填参数），可随时用 `node sync.js` 保鲜：

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
