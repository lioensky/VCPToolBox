# DailyNoteWrite 插件

## 功能

`DailyNoteWrite` 是一个同步插件，负责接收新的日记条目数据，并将其写入到项目 `dailynote/` 目录下对应的角色文件夹中。

## 工作方式

-   插件类型：`synchronous`
-   执行入口：`node daily-note-write.js`
-   **输入**: 该插件通过标准输入 (stdin) 接收一个 JSON 字符串。该 JSON 字符串应能解析为一个包含以下键的对象：
    -   `maidName` (string): 日记作者的角色名。
    -   `dateString` (string): 日记的日期字符串 (例如 "YYYY.MM.DD")。
    -   `contentText` (string): 日记的主要内容。
    ```json
    {
      "maidName": "小克",
      "dateString": "2025.05.13",
      "contentText": "今天天气真好！"
    }
    ```
-   **处理**: 插件脚本解析输入数据后，会：
    1.  在 `PROJECT_BASE_PATH/dailynote/` 目录下找到或创建以 `maidName` 命名的子文件夹。
    2.  根据 `dateString` 和当前时间生成一个唯一的 `.txt` 文件名 (例如 `2025.05.13-11_20_30.txt`)。
    3.  将日记内容格式化为 `[日期] - 角色名\n日记内容` 并写入文件。
-   **输出**: 操作完成后，插件通过标准输出 (stdout) 返回一个 JSON 字符串，表明操作结果，例如：
    -   成功: `{"status":"success","message":"Diary saved to dailynote/小克/2025.05.13-11_20_30.txt"}`
    -   失败: `{"status":"error","message":"错误信息描述"}`

## 调用方式

通常由服务器主逻辑 (例如 [`server.js`](../../../server.js) 中的 `handleDiaryFromAIResponse` 函数) 在解析到 AI 生成的日记内容后，通过 `pluginManager.executePlugin("DailyNoteWrite", diaryDataJsonString)` 来调用此插件。

## 配置

-   **`DebugMode`**: (boolean) 可在插件的 `.env` 文件或全局 `config.env` 中配置，启用后会在 `stderr` 输出详细的调试日志。

## 注意事项

-   确保 `PROJECT_BASE_PATH` 环境变量被正确设置，以便插件能找到 `dailynote` 目录。
-   输入给插件的 JSON 数据必须符合预期的结构。
-   日记文件以 UTF-8 编码保存。