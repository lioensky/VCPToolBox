# KarakeepSearch VCP Plugin

This document provides instructions for setting up and using the KarakeepSearch VCP plugin.

---

## English Instructions

### 1. Setup

1.  **Place the Plugin**: Copy the entire `KarakeepSearch` directory into the `Plugin` directory of your VCPToolBox instance.

2.  **Configuration**: Create a `config.env` file inside this directory by copying `config.env.example`. Then, fill in your Karakeep server details:
    ```env
    # plugins/KarakeepSearch/config.env
    KARAKEEP_API_ADDR=https://your-karakeep.example.com
    KARAKEEP_API_KEY=sk-xxxxxxx
    ```

The VCP server will automatically detect and load the plugin based on the `plugin-manifest.json` file.

### 2. Usage

To use the plugin, an AI agent needs to generate a `TOOL_REQUEST` block as described in the manifest.

-   **Tool**: `SearchBookmarks`
-   **Description**: Searches bookmarks in Karakeep.
-   **Parameters**:
    -   `query` (string, required): The search query. Supports advanced syntax like `is:fav`, `#tag`, etc.
    -   `limit` (number, optional, default: 10): The number of results to return.
    -   `nextCursor` (string, optional): The cursor for pagination, obtained from a previous search result.

#### Example VCP Call

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」KarakeepSearch「末」,
query:「始」machine learning is:fav「末」,
limit:「始」5「末」
<<<[END_TOOL_REQUEST]>>>
```

#### Response Format

-   **Success**:
    ```json
    {
      "status": "success",
      "result": {
        "content": [{"type": "text", "text": "Bookmark details..."}],
        "nextCursor": "a_cursor_string_or_null"
      }
    }
    ```
-   **Error**:
    ```json
    {
      "status": "error",
      "code": "ERROR_CODE",
      "error": "A descriptive error message."
    }
    ```

---

## 中文说明

### 1. 设置

1.  **放置插件**: 将整个 `KarakeepSearch` 文件夹复制到你的 VCPToolBox 实例的 `Plugin` 目录下。

2.  **配置**: 在此目录中，通过复制 `config.env.example` 来创建一个 `config.env` 文件。然后，填入你的 Karakeep 服务器详细信息：
    ```env
    # plugins/KarakeepSearch/config.env
    KARAKEEP_API_ADDR=https://your-karakeep.example.com
    KARAKEEP_API_KEY=sk-xxxxxxx
    ```

VCP 服务器将根据 `plugin-manifest.json` 文件自动检测并加载插件。

### 2. 使用方法

要使用此插件，AI 代理需要生成一个如清单文件中所述的 `TOOL_REQUEST` 块。

-   **工具**: `SearchBookmarks`
-   **描述**: 在 Karakeep 中搜索书签。
-   **参数**:
    -   `query` (字符串, 必需): 搜索查询。支持高级语法，如 `is:fav`, `#tag` 等。
    -   `limit` (数字, 可选, 默认: 10): 返回的结果数量。
    -   `nextCursor` (字符串, 可选): 用于分页的光标，从上一次搜索结果中获取。

#### VCP 调用示例

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」KarakeepSearch「末」,
query:「始」machine learning is:fav「末」,
limit:「始」5「末」
<<<[END_TOOL_REQUEST]>>>
```

#### 响应格式

-   **成功**:
    ```json
    {
      "status": "success",
      "result": {
        "content": [{"type": "text", "text": "书签详情..."}],
        "nextCursor": "分页光标字符串或 null"
      }
    }
    ```
-   **错误**:
    ```json
    {
      "status": "error",
      "code": "错误代码",
      "error": "详细的错误信息。"
    }