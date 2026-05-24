## ZhihuSearch - 知乎搜索插件

调用知乎开放平台 API，支持**站内内容搜索**和**全局搜索**两种模式。

### 功能

- **站内搜索** (`zhihu_search`)：搜索知乎站内问答、文章等内容，返回标题、链接、作者、摘要、点赞数、评论数、编辑时间。
- **全局搜索** (`global_search`)：搜索更广泛的知乎关联内容，返回标题、链接、作者、摘要、编辑时间。
- 返回面向 AI 阅读的 Markdown 格式内容，同时提供结构化 JSON 数据。

### 配置

在 `config.env` 中配置：

```env
# 必填：知乎开放平台 Access Secret
ZHIHU_ACCESS_SECRET=your_access_secret_here

# 可选：知乎开放平台 Base URL（默认 https://developer.zhihu.com）
ZHIHU_OPENAPI_BASE_URL=https://developer.zhihu.com

# 可选：zhihu_search 完整 endpoint 覆盖地址
ZHIHU_ZHIHU_SEARCH_URL=

# 可选：global_search 完整 endpoint 覆盖地址
ZHIHU_GLOBAL_SEARCH_URL=

# 可选：HTTP 请求超时时间，单位秒，范围 1-60（默认 5）
ZHIHU_SEARCH_TIMEOUT_SECONDS=5
```

**获取 Access Secret**：前往 [知乎开放平台](https://developer.zhihu.com) 注册并申请 API 权限。

### 使用示例

**站内搜索**：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」ZhihuSearch「末」,
search_type:「始」zhihu_search「末」,
query:「始」AI Agent 应用实践「末」,
count:「始」5「末」
<<<[END_TOOL_REQUEST]>>>
```

**全局搜索**：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」ZhihuSearch「末」,
search_type:「始」global_search「末」,
query:「始」如何理解 rave 文化「末」,
count:「始」8「末」
<<<[END_TOOL_REQUEST]>>>
```

### 参数说明

| 参数 | 别名 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| query | q, text | ✅ | - | 搜索关键词 |
| search_type | type, scope, command | ❌ | zhihu_search | 搜索类型：`zhihu_search`（站内，1-10条）或 `global_search`（全局，1-20条） |
| count | max_results | ❌ | 10 | 返回结果数量 |

### 返回结构

- `content` / `message`：Markdown 格式搜索结果
- `sources`：统一来源列表
- `items`：完整结构化数据（标题、链接、作者、摘要等）
- `search_type`：实际使用的搜索类型
- `code` / `api_message`：知乎 API 原始状态

### 依赖

- Python >= 3.8
- 无第三方依赖（仅使用标准库）