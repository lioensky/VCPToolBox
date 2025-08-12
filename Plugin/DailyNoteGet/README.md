# DailyNoteGet 插件

## 功能

`DailyNoteGet` 是一个静态插件，负责定期读取项目中 `dailynote/` 目录下所有角色的日记内容。

## 工作方式

-   插件类型：`static`
-   执行入口：`node daily-note-get.js`
-   该脚本会扫描 `PROJECT_BASE_PATH/dailynote/` 目录下的所有角色子文件夹。
-   对于每个角色，它会读取其子文件夹内所有的 `.txt` 文件，并将它们的内容按照时间顺序（文件名排序）合并成一个单一的字符串（每篇日记之间用 `\n\n---\n\n` 分隔）。
-   所有角色的日记数据会被组织成一个 JSON 对象，其中键是角色名，值是对应角色的合并日记内容字符串。
-   最终，该脚本会将这个 JSON 对象转换为字符串，并通过标准输出 (stdout) 返回。

## 提供的占位符

此插件通过 `PluginManager` 提供以下系统占位符：

-   **`{{AllCharacterDiariesData}}`**:
    -   **内容**: 一个 JSON 字符串。
    -   **解析后**: 解析该字符串会得到一个对象，例如：
        ```json
        {
          "角色A": "角色A的日记内容1\n\n---\n\n角色A的日记内容2...",
          "角色B": "角色B的日记内容1..."
        }
        ```
    -   **用途**: 服务器端的 `replaceCommonVariables` 函数会使用此数据来支持传统的 `{{角色名日记本}}` 占位符的解析。例如，当遇到 `{{角色A日记本}}` 时，它会从 `{{AllCharacterDiariesData}}` 提供的 JSON 中查找键为 "角色A" 的值并进行替换。
-   **`{{XX日记本}}`**:
  -   根据角色的独立日记本内容。   

## 配置

-   **`refreshIntervalCron`**: 在 `plugin-manifest.json` 中定义，用于设置插件自动刷新的频率（默认为每5分钟）。
-   **`DebugMode`**: (boolean) 可在插件的 `.env` 文件或全局 `config.env` 中配置，启用后会在 `stderr` 输出详细的调试日志。

## 注意事项

-   确保 `PROJECT_BASE_PATH` 环境变量被正确设置，以便插件能找到 `dailynote` 目录。
-   日记文件应为 UTF-8 编码。
