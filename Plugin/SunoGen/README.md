# SunoGen - VCP 音乐生成插件

本插件集成了 Suno API，允许通过 VCP (Variable & Command Protocol) 工具箱生成原创歌曲。

## ✨ 特性

*   通过 VCP 插件系统与 Suno API 交互。
*   支持多种创作模式：
    *   **自定义模式**: 提供歌词、风格标签和歌曲标题。
    *   **灵感模式**: 提供对歌曲的整体描述。
    *   **继续生成模式**: 继续之前生成的歌曲片段。
*   插件会处理与 Suno API 的异步交互（提交任务、轮询状态），并同步返回最终结果（成功时包含音频链接等信息，失败时返回错误）。
*   可配置的 API Key (`SunoKey` 在 `Plugin/SunoGen/config.env` 中设置)。
*   可选择不同的 Suno 模型版本。

## 🔌 集成到 VCP 工具箱

`SunoGen` 作为一个 `synchronous` 类型的插件，由主 VCP 服务器的 `PluginManager` (`Plugin.js`) 自动加载和管理。

*   **配置文件 (`Plugin/SunoGen/config.env`)**:
    *   `SunoKey` (必需): 您的 Suno API 密钥。
    *   `SunoApiBaseUrl` (可选): Suno API 的基础 URL。如果您的 API 服务商使用非标准端点，请修改此项。默认为 `'https://gemini.mtysp.top'`。
*   **入口脚本**: 插件的执行入口是 `Plugin/SunoGen/SunoGen.js`。
*   **调用规范**: AI 需要按照 `Plugin/SunoGen/plugin-manifest.json` 中定义的格式，通过 `<<<[TOOL_REQUEST]>>>` 指令调用 `SunoGen` 插件的 `generate_song` 命令。

## 🛠️ 工具调用说明 (`generate_song` 命令)

请参考 `Plugin/SunoGen/plugin-manifest.json` 文件中 `capabilities.invocationCommands` 下 `generate_song` 命令的 `description` 字段。该字段详细说明了：

*   **重要提示**: 关于生成时间和如何向用户呈现结果（包括HTML `<audio>` 标签建议）。
*   **参数格式**: 严格的参数要求，包括通用参数 (`tool_name`, `command`) 和三种模式（自定义、灵感、继续生成）下的特定参数及其选项。
*   **禁止额外参数**。
*   **成功和失败时返回的 JSON 结构**。
*   **详细的调用示例**。

**简要参数概览:**

*   **自定义模式**: 需要 `prompt` (歌词), `tags` (风格), `title` (标题)。
*   **灵感模式**: 需要 `gpt_description_prompt` (歌曲描述)。
*   **继续生成模式**: 需要 `task_id`, `continue_at`, `continue_clip_id`。
*   **可选通用参数**: `mv` (模型版本), `make_instrumental` (是否纯音乐)。

## ⚙️ 依赖与运行

*   **Node.js 依赖**: `SunoGen.js` 依赖 `axios` 和 `dotenv`。这些应通过项目根目录的 `package.json` 和 `npm install` 进行管理，或者如果 `SunoGen` 插件有自己的 `package.json`，则在其目录内安装。
*   **VCP 服务器运行**: 启动主 VCP 服务器 (`node server.js`) 后，`SunoGen` 插件即可被 AI 调用。

## 📄 许可证

本插件作为 VCP 工具箱项目的一部分，遵循项目根目录 `LICENSE` 文件中定义的许可证条款 (当前为 CC BY-NC-SA 4.0)。