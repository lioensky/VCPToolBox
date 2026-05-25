# EmojiListGenerator 插件

## 功能

`EmojiListGenerator` 是一个静态插件，负责扫描项目根目录下的 `image/` 文件夹中所有以 "表情包" 结尾的子目录，并为每个子目录在插件自身的 `generated_lists/` 文件夹内生成对应的 `.txt` 列表文件。

例如，如果存在 `PROJECT_BASE_PATH/image/通用表情包/`，此插件会生成 `Plugin/EmojiListGenerator/generated_lists/通用表情包.txt`。

## 工作方式

-   插件类型：`static`
-   执行入口：`node emoji-list-generator.js`
-   该脚本会：
    1.  定位到 `PROJECT_BASE_PATH/image/` 目录。
    2.  查找所有名为 `xx表情包` 的子文件夹。
    3.  对于每个找到的表情包文件夹，它会读取其中所有图片文件（`.jpg`, `.jpeg`, `.png`, `.gif`）。
    4.  将这些图片文件名用 `|` 符号连接成一个字符串。
    5.  在插件目录下的 `generated_lists/` 子文件夹中，创建一个与表情包文件夹同名的 `.txt` 文件 (例如 `通用表情包.txt`)，并将生成的列表字符串写入该文件。
-   插件执行完毕后，会通过标准输出 (stdout) 返回一个 JSON 字符串，包含执行摘要（例如成功生成的文件数量）。

## 服务器集成

-   服务器 ([`server.js`](../../../server.js)) 在初始化 (`initialize` 函数) 过程中会调用 `pluginManager.executePlugin("EmojiListGenerator")` 来执行此插件，确保所有表情包的 `.txt` 列表文件在插件的 `generated_lists/` 目录中是最新的。
-   随后，[`server.js`](../../../server.js) 会读取这些位于 `Plugin/EmojiListGenerator/generated_lists/` 下的 `.txt` 文件，并将它们的内容加载到内存中的 `cachedEmojiLists` 缓存。
-   最终，当处理文本中的 `{{xx表情包}}` 占位符时，服务器会从 `cachedEmojiLists` 中获取对应的列表进行替换。

## 目录结构

-   **源图片目录**: `PROJECT_BASE_PATH/image/xx表情包/`
-   **生成的列表文件目录**: `PROJECT_BASE_PATH/Plugin/EmojiListGenerator/generated_lists/xx表情包.txt`

## 配置

-   **`DebugMode`**: (boolean) 可在插件的 `.env` 文件或全局 `config.env` 中配置，启用后会在 `stderr` 输出详细的调试日志。

## 注意事项

-   `PROJECT_BASE_PATH` 由 VCP 的 `server.js` 在启动时自动设置为 VCPToolBox 根目录，通常无需手动配置。
-   插件会覆盖 `generated_lists/` 目录中已存在的同名 `.txt` 文件。

## 前端表情包修复器

VCPChat 前端内置了 AI 表情包 URL 修复器（`emoticonUrlFixer`），能自动修复 AI 生成的错误表情包 URL。

### 数据流

1. **后端启动时**：本插件扫描 `image/` 目录，生成 `generated_lists/*.txt` 文件
2. **后端缓存**：`server.js` 读取这些 `.txt` 文件，加载到内存中的 `cachedEmojiLists` 缓存
3. **前端获取**：前端 `emoticonHandlers.js` 通过 `fetch` 请求后端 `/admin_api/emojis/list` 端点获取表情包列表
4. **修复器工作**：`emoticonUrlFixer` 使用获取到的列表作为匹配知识库，自动修复 AI 生成的错误 URL

### 配置

前端只需确保 VCPChat 的 `settings.json` 中 `fileKey` 字段填写了正确的图床密码（与 VCPToolBox 根目录 `config.env` 中的 `Image_Key` 一致）。无需手动复制任何文件。

### 验证（可选）

启动 VCPChat 后，打开开发者工具（`Ctrl+Shift+I`）→ Console，搜索 `EmoticonFixer`：
- 成功：`[EmoticonFixer] Library loaded with N items.`
- 失败：`[EmoticonFixer] Library unavailable, fixer running in degraded passthrough mode.`

> **注意**：如果看到 `Library unavailable`，请检查：(1) VCPToolBox 后端是否正常运行；(2) `fileKey` 是否正确配置；(3) 前端 `emoticonHandlers.js` 是否为最新版本（应通过 API 获取数据，而非读取本地文件）。

## 表情包 URL 修复器工作原理

当 AI 生成的表情包 URL 存在错误时（文件夹名错误、文件格式错误、文件名拼写错误等），前端修复器会自动尝试修复：

### 修复机制（按优先级）

1. **完美匹配检查**：URL 与库中某项完全一致 → 直接通过，不做修改
2. **精确文件名匹配**：剥离扩展名后进行精确比对，忽略文件夹差异和格式差异。当 AI 写对了文件名但文件夹或格式错误时，能准确跨文件夹匹配到正确的表情包
3. **模糊匹配**（降级方案）：使用编辑距离算法计算加权相似度（70% 文件夹名权重 + 30% 文件名权重），选择得分最高且超过阈值（0.6）的结果

### 注意事项

- 新增表情包目录后需**重启 VCPToolBox 后端**，本插件才会重新扫描生成列表，后端 API 会自动返回最新数据
- 也可通过 `/admin_api/emojis/list/rebuild` 端点手动触发重新生成，无需重启
- 修复器在库为空时自动降级为直通模式（passthrough），不做任何 URL 修改
- 后端 ImageServer 提供了额外的图片格式回退机制（`.png`↔`.jpg`↔`.webp` 等），作为前端修复器的补充防御层