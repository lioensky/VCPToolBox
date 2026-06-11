## AnySearch - 实时搜索插件

调用 [AnySearch](https://anysearch.com) JSON-RPC API，提供**垂直领域搜索、通用搜索、批量并行搜索、子领域目录查询和网页 Markdown 正文提取**能力。

### 设计要点

- **子领域目录直接内嵌在工具描述里**：AI 无需先调 `get_sub_domains` 就能直接选 `domain` + `sub_domain` 发起垂直搜索，省一次工具调用往返。`get_sub_domains` 仍保留，用于查询某子领域的参数定义（`params_schema`）。
- **目录维护脚本 `sync.js`**（手动执行，非插件入口）：

  ```bash
  node Plugin/AnySearch/sync.js
  ```

  匿名调用一次 `get_sub_domains` 全量目录，与描述中「领域目录」区块做**语义比对**，只有目录真实变化才以「临时文件 + 原子改名」改写该区块——幂等，不会重复堆积，也不会动区块之外的任何人工内容。写入后由 VCP 服务器自身的清单热重载机制刷新工具描述，脚本不做任何主动热更新。
- **零运行时开销、零竞态、零工具泄露**：`sync.js` 没有独立 manifest，不被 PluginManager 加载、不出现在 AI 工具列表、不参与服务器启动；AnySearch 的常规调用也没有任何描述生成副作用。改写动作只有人工执行脚本这一个入口。
- **人工可接管**：手动编辑 `plugin-manifest.json` 描述同样会被服务器热重载；删除「领域目录(domain: 子领域):」或「调用格式:」锚行即可让 `sync.js` 永久停写。

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

**1. 垂直搜索**（domain 与 sub_domain 直接取自工具描述中的目录）：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AnySearch「末」,
command:「始」search「末」,
query:「始」Apple 最新公司新闻「末」,
domain:「始」finance「末」,
sub_domain:「始」finance.news「末」,
sub_domain_params:「始」{"type":"stock","symbol":"AAPL"}「末」,
max_results:「始」5「末」
<<<[END_TOOL_REQUEST]>>>
```

**2. 查询子领域参数定义**（仅当需要某子领域的必填参数时）：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AnySearch「末」,
command:「始」get_sub_domains「末」,
domain:「始」finance「末」
<<<[END_TOOL_REQUEST]>>>
```

**3. 通用搜索**：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AnySearch「末」,
command:「始」search「末」,
query:「始」what is photosynthesis「末」,
max_results:「始」3「末」
<<<[END_TOOL_REQUEST]>>>
```

**4. 批量搜索**（顶层共享参数注入每条，1-5 条）：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AnySearch「末」,
command:「始」batch_search「末」,
domain:「始」finance「末」,
sub_domain:「始」finance.news「末」,
sub_domain_params:「始」{"type":"general"}「末」,
max_results:「始」3「末」,
queries:「始」["AI 芯片需求 2026", "全球 EV 市场展望"]「末」
<<<[END_TOOL_REQUEST]>>>
```

**5. 网页正文提取**：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AnySearch「末」,
command:「始」extract「末」,
url:「始」https://example.com/article「末」
<<<[END_TOOL_REQUEST]>>>
```

### 参数说明

| 参数 | 别名 | 必需 | 说明 |
|------|------|------|------|
| command | action, tool, mode | 否（默认 search） | `search` / `get_sub_domains` / `batch_search` / `extract` |
| query | q, text | `search` 必需 | 搜索词 |
| domain | - | 垂直搜索必填 | 目录中的领域；只传 domain 不传 sub_domain 等同通用搜索 |
| sub_domain | subDomain, subdomain | 垂直搜索必填 | 目录中的「domain.子项」，如 `finance.news` |
| sub_domain_params | sdp, subDomainParams | 按 `params_schema` | JSON 对象；必填键无适用值传 `""` |
| max_results | maxResults | 否 | 结果数量，范围 1-10 |
| domains | - | `get_sub_domains` 与 domain 二选一 | 领域数组或逗号分隔字符串，最多 5 个 |
| queries | query_items | `batch_search` 必需 | 1-5 个字符串或对象；顶层共享参数注入每条 |
| url | URL, link | `extract` 必需 | 要提取正文的网页 URL |

### 领域与子领域目录

工具描述内嵌的目录与此一致，可随时用 `node sync.js` 保鲜：

| 领域 | 子领域 |
|------|--------|
| general | general |
| finance | fundamental, quote, screen, macro, calendar, news |
| academic | search, dataset, preprint, citation, biomedical |
| security | noise, intel, scan, vuln |
| business | trade, company, jobs, people |
| legal | legislation, case, statute |
| health | drug, trial, stats |
| code | doc, snippet |
| energy | production, electricity |
| travel | flight, flight_status |
| gaming | store, esports |
| resource | image |
| social_media | social_media |
| ip | global |
| environment | aqi |
| agriculture | fao |
| film | torrent |

### 依赖

- Node.js >= 14.0.0
- 无第三方 npm 依赖
