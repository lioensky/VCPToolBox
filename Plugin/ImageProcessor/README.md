# ImageProcessor 插件 (图像信息提取器)

这是一个 `messagePreprocessor` 类型的插件，用于在将用户消息发送给大语言模型之前，自动处理消息中包含的图像。它会调用外部的多模态模型来提取图像信息，并将这些信息以文本形式插入或替换到原始消息中，同时维护一个图像描述的缓存以提高效率和减少 API 调用。

## 核心功能

*   **消息预处理**: 自动检测用户消息中的 Base64 编码的图像数据 (`data:image/...;base64,...`)。
*   **图像识别**: 对于检测到的图像：
    *   首先检查本地缓存 ([`image_cache.json`](Plugin/ImageProcessor/image_cache.json)) 中是否已有该图像的描述。
    *   如果缓存未命中，则调用在插件配置中指定的外部多模态 API 来获取图像的文本描述。
*   **缓存管理**:
    *   将成功获取的图像描述（以及图像的 Base64 数据作为键）存储在本地的 [`image_cache.json`](Plugin/ImageProcessor/image_cache.json) 文件中，包含描述、唯一 ID 和时间戳。
    *   缓存文件位于插件目录下。
*   **内容替换**: 将原始消息中的图像数据替换为 `[IMAGE<序号>Info: <图像描述>]` 格式的文本。可以通过配置 `ImageInsertPrompt` 在所有图像描述前添加统一的提示文本。
*   **API 调用**: 使用 `node-fetch` 与外部 API 进行通信，支持重试机制。

## 配置

此插件需要在其配置中设置以下字段 (参考 [`plugin-manifest.json`](Plugin/ImageProcessor/plugin-manifest.json)):

*   **`API_URL`**: (必需) 多模态模型的 API 端点 URL。
*   **`API_Key`**: (必需) 用于 API 认证的密钥。
*   **`ImageModel`**: (必需) 要使用的多模态模型名称。
*   **`ImagePrompt`**: (必需) 发送给模型以指导图像描述生成的提示文本。
*   `ImageModelOutputMaxTokens`: (可选) 限制模型输出描述的最大 token 数。
*   `ImageModelThinkingBudget`: (可选) 某些模型可能支持的思考预算参数。
*   `ImageModelAsynchronousLimit`: (可选) 并行处理图像的数量限制（默认为 1）。
*   `ImageInsertPrompt`: (可选) 在所有提取的图像信息前添加的文本，例如 `"[图像信息已提取:]"`。
*   `DebugMode`: (可选) 设为 `true` 以启用详细的调试日志输出。

## 缓存文件

*   **位置**: [`Plugin/ImageProcessor/image_cache.json`](Plugin/ImageProcessor/image_cache.json)
*   **格式**: 一个 JSON 对象，键是图像的纯 Base64 字符串，值是包含以下信息的对象：
    ```json
    {
      "base64_string_key...": {
        "id": "unique-uuid-string",
        "description": "图像的文本描述...",
        "timestamp": "ISO-8601-timestamp"
      },
      "...": {}
    }
    ```

## 辅助工具和脚本

该插件目录包含一些用于管理缓存的独立工具：

1.  **[`image_cache_editor.html`](Plugin/ImageProcessor/image_cache_editor.html)**
    *   **功能**: 一个本地 HTML 页面，用于可视化地查看、编辑缓存中的图像描述，以及删除缓存条目。
    *   **使用**: 在浏览器中直接打开此 HTML 文件。点击 "选择文件" 加载你的 [`image_cache.json`](Plugin/ImageProcessor/image_cache.json)。页面会显示图片预览和描述文本框。你可以编辑描述或点击红色 '×' 删除条目。
    *   **注意**: 编辑或删除后，点击 "保存更改到新文件" 会触发浏览器下载一个名为 `imagebase64_updated.json` 的新文件。**它不会直接修改原始的 `image_cache.json` 文件**，你需要手动替换旧文件。

2.  **[`purge_old_cache.js`](Plugin/ImageProcessor/purge_old_cache.js)**
    *   **功能**: 一个 Node.js 脚本，用于自动删除 [`image_cache.json`](Plugin/ImageProcessor/image_cache.json) 中超过指定天数（默认为 90 天）的旧缓存条目。
    *   **使用**: 在插件目录下运行 `node purge_old_cache.js`。
    *   **注意**: 此脚本会**直接修改并覆盖**原始的 [`image_cache.json`](Plugin/ImageProcessor/image_cache.json) 文件。请谨慎操作或提前备份。

3.  **[`reidentify_image.js`](Plugin/ImageProcessor/reidentify_image.js)**
    *   **功能**: 一个 Node.js 脚本，用于根据缓存条目的 ID 重新调用 API 获取图像描述，并更新缓存文件。
    *   **依赖**: 需要安装 `node-fetch` 和 `dotenv` (`npm install node-fetch dotenv`)。还需要在**项目根目录**下有一个包含 API 密钥等信息的 `config.env` 文件。
    *   **使用**: 在插件目录下运行 `node reidentify_image.js <缓存条目ID>`，例如 `node reidentify_image.js unique-uuid-string`。
    *   **注意**: 此脚本会**直接修改并覆盖**原始的 [`image_cache.json`](Plugin/ImageProcessor/image_cache.json) 文件。

## 依赖

*   核心插件 ([`image-processor.js`](Plugin/ImageProcessor/image-processor.js)) 内部使用 `node-fetch` (通过动态 `import()` 调用)。
*   [`reidentify_image.js`](Plugin/ImageProcessor/reidentify_image.js) 脚本需要额外安装 `node-fetch` 和 `dotenv`。