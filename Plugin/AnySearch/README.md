## AnySearch - 实时搜索插件

调用 [AnySearch](https://anysearch.com) JSON-RPC API，提供**通用搜索、垂直领域搜索、批量并行搜索、领域目录查询和网页正文提取**五大能力。

### 功能

1. **通用搜索** (`search`)：网页搜索，支持内容类型过滤、时间范围、地区定向。
2. **垂直领域搜索**：针对金融、学术、安全、代码、法律等 22 个垂直领域深度搜索。
3. **批量并行搜索** (`batch_search`)：一次提交 1-5 个查询并行执行。
4. **领域目录查询** (`list_domains`)：查看垂直领域的子领域、查询格式和参数约束。
5. **网页正文提取** (`extract`)：从 URL 提取网页正文内容。

### 配置

在 `config.env` 中配置：

```env
# 可选：API Key。不配置时使用匿名访问，额度较低。
# 获取地址：https://anysearch.com/settings/api-keys
ANYSEARCH_API_KEY=

# 可选：JSON-RPC endpoint 覆盖（默认 https://api.anysearch.com/mcp）
ANYSEARCH_ENDPOINT=https://api.anysearch.com/mcp

# 可选：HTTP 请求超时，单位毫秒，范围 1000-120000（默认 30000）
ANYSEARCH_TIMEOUT_MS=30000
```

### 使用示例

**通用搜索**：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AnySearch「末」,
command:「始」search「末」,
query:「始」AI regulation 2026「末」,
content_types:「始」news「末」,
freshness:「始」week「末」,
max_results:「始」5「末」
<<<[END_TOOL_REQUEST]>>>
```

**垂直领域搜索**（先查目录，再搜索）：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AnySearch「末」,
command:「始」list_domains「末」,
domain:「始」finance「末」
<<<[END_TOOL_REQUEST]>>>
```

**批量搜索**：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AnySearch「末」,
command:「始」batch_search「末」,
queries:「始」["AI agents", "LLM safety", "transformer architecture"]「末」
<<<[END_TOOL_REQUEST]>>>
```

**网页正文提取**：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AnySearch「末」,
command:「始」extract「末」,
url:「始」https://example.com/article「末」
<<<[END_TOOL_REQUEST]>>>
```

### 参数说明

| 参数 | 别名 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| command | action, tool, mode | ❌ | search | 命令：search / list_domains / batch_search / extract |
| query | q, text | search 必需 | - | 搜索词 |
| domain | - | 垂直搜索可选 | - | 垂直领域（finance, academic, security, code 等） |
| sub_domain | - | 垂直搜索建议 | - | 子领域路由（如 finance.us_stock） |
| content_types | - | ❌ | - | 内容类型：web, news, code, doc, academic, data, image, video, audio |
| freshness | - | ❌ | - | 时间范围：day, week, month, year |
| zone | - | ❌ | - | 地区：cn 或 intl |
| max_results | - | ❌ | - | 结果数量，范围 1-100 |
| queries | - | batch 必需 | - | 批量查询，1-5 个字符串或对象 |
| url | - | extract 必需 | - | 要提取正文的网页 URL |

### 可用垂直领域

code, tech, fashion, travel, home, ecommerce, gaming, film, music, finance, academic, legal, business, ip, security, education, health, religion, geo, environment, energy, ugc

> 垂直搜索前建议先调用 `list_domains` 获取子领域、查询格式和参数约束。

### 依赖

- Node.js >= 14.0.0
- 无第三方 npm 依赖