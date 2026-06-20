# TinyFishBrowser - TinyFish 搜索与网页抓取插件

基于 [TinyFish API](https://docs.tinyfish.ai) 的 VCP 插件，提供**网络搜索**和**网页内容抓取**两大功能。

## 功能

### 1. 网络搜索 (`TinyFishSearch`)
- 使用 TinyFish Search API 进行网络搜索
- 返回结构化结果：标题、摘要、URL、来源站点
- 支持地理定位（国家代码）和语言过滤
- 支持分页

### 2. 网页内容抓取 (`TinyFishFetch`)
- 使用真实浏览器渲染页面（支持 JavaScript 重页面）
- 返回干净的 Markdown/HTML/JSON 格式内容
- 支持同时抓取最多 10 个 URL
- 可提取页面外链和图片链接
- 单个 URL 失败不影响其他 URL

## 配置

在 `config.env` 中配置：

```env
TINYFISH_API_KEY=your_api_key_here
```

从 [TinyFish API Keys](https://tinyfish.ai) 获取 API 密钥。

## 使用

### 搜索

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」TinyFishBrowser「末」,
command:「始」TinyFishSearch「末」,
q:「始」AI agent tools 2026「末」,
location:「始」US「末」,
language:「始」en「末」
<<<[END_TOOL_REQUEST]>>>
```

### 抓取

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」TinyFishBrowser「末」,
command:「始」TinyFishFetch「末」,
urls:「始」["https://example.com"]「末」,
format:「始」markdown「末」,
links:「始」true「末」
<<<[END_TOOL_REQUEST]>>>
```

## API 参考

### Search API
- **端点**: `https://api.search.tinyfish.ai/`
- **方法**: GET
- **认证**: `X-API-Key` 请求头

### Fetch API
- **端点**: `https://api.fetch.tinyfish.ai/v1/fetch`
- **方法**: POST
- **认证**: `X-API-Key` 请求头