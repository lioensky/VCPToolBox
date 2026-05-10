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
-   随后，[`server.js`](../../../server.js) 会读取这些位于 `Plugin/EmojiListGenerator/generated_lists/` 下的 `.txt` 文件，并将它们的内加载到内存中的 `cachedEmojiLists` 缓存。
-   最终，当处理文本中的 `{{xx表情包}}` 占位符时，服务器会从 `cachedEmojiLists` 中获取对应的列表进行替换。

## 目录结构

-   **源图片目录**: `PROJECT_BASE_PATH/image/xx表情包/`
-   **生成的列表文件目录**: `PROJECT_BASE_PATH/Plugin/EmojiListGenerator/generated_lists/xx表情包.txt`

## 配置

-   **`DebugMode`**: (boolean) 可在插件的 `.env` 文件或全局 `config.env` 中配置，启用后会在 `stderr` 输出详细的调试日志。

## 注意事项

-   确保 `PROJECT_BASE_PATH` 环境变量被正确设置。
-   插件会覆盖 `generated_lists/` 目录中已存在的同名 `.txt` 文件。