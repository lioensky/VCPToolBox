# SunoGen - VCP 音乐生成插件

本插件集成 `docs.sunoapi.org` 风格的 Suno API，允许通过 VCP (Variable & Command Protocol) 工具箱生成原创歌曲或继续扩写已有歌曲片段。

## ✨ 特性

*   通过 VCP 插件系统与 Suno API 交互。
*   支持多种创作模式：
    *   **自定义模式**: 提供歌词、风格标签和歌曲标题。
    *   **灵感模式**: 提供对歌曲的整体描述。
    *   **继续生成模式**: 继续之前生成的歌曲片段。
*   插件会处理与新 SunoAPI 的异步交互（提交任务、轮询状态），并同步返回最终结果文本。
*   可配置的 API Key (`SunoKey` 在 `Plugin/SunoGen/config.env` 中设置)。
*   支持旧参数 `mv` 到新协议 `model` 的内部映射。

## 🔌 集成到 VCP 工具箱

`SunoGen` 作为一个 `synchronous` 类型的插件，由主 VCP 服务器的 `PluginManager` (`Plugin.js`) 自动加载和管理。

*   **配置文件 (`Plugin/SunoGen/config.env`)**:
    *   `SunoKey` (必需): 您的 Suno API 密钥。
    *   `SunoApiBaseUrl` (可选): Suno API 的基础 URL。默认为 `'https://api.sunoapi.org'`。
    *   `SunoCallbackUrl` (必需): docs.sunoapi.org 新协议要求的回调地址，插件会自动注入，不需要 AI 在工具调用中传入。
    *   `SunoPollingIntervalMs` (可选): 轮询间隔，默认 `5000`。
    *   `SunoMaxPollingAttempts` (可选): 最大轮询次数，默认 `60`。
*   **入口脚本**: 插件的执行入口是 `Plugin/SunoGen/SunoGen.mjs`。
*   **调用规范**: AI 需要按照 `Plugin/SunoGen/plugin-manifest.json` 中定义的格式，通过 `<<<[TOOL_REQUEST]>>>` 指令调用 `SunoGen` 插件的 `generate_song` 命令。

## 🔄 新协议说明

当前实现对接的是 `docs.sunoapi.org` 风格的新协议，核心接口为：

*   `POST /api/v1/generate`
*   `POST /api/v1/generate/extend`
*   `GET /api/v1/generate/record-info?taskId=...`

旧的 `/suno/submit/music` 与 `/suno/fetch/{taskId}` 不再作为目标协议。

## 🛠️ 工具调用说明 (`generate_song` 命令)

请参考 `Plugin/SunoGen/plugin-manifest.json` 文件中 `capabilities.invocationCommands` 下 `generate_song` 命令的 `description` 字段。该字段详细说明了：

*   **重要提示**: 关于生成时间和如何向用户呈现结果（包括HTML `<audio>` 标签建议）。
*   **参数格式**: 严格的参数要求，包括通用参数 (`tool_name`, `command`) 和三种模式（自定义、灵感、继续生成）下的特定参数及其选项。
*   **禁止额外参数**。
*   **成功和失败时返回说明**。
*   **详细的调用示例**。

**简要参数概览:**

*   **自定义模式**: 需要 `prompt` (歌词), `tags` (风格), `title` (标题)。
*   **灵感模式**: 需要 `gpt_description_prompt` (歌曲描述)。
*   **继续生成模式**: 需要 `task_id`, `continue_at`, `continue_clip_id`。
*   **可选通用参数**: `mv` (模型版本), `make_instrumental` (是否纯音乐)。

## 📦 返回行为

需要注意：当前插件成功时返回的是**文本字符串**，而不是稳定结构化 JSON 对象。

成功文本中通常包含：

*   音频链接
*   标题
*   风格信息
*   封面图链接（如有）
*   后台下载提示

插件在返回结果后，会异步调用 `Downloader.mjs` 将 mp3 下载到 `file/music/`。

## ⚙️ 依赖与运行

*   **Node.js 依赖**: `SunoGen.mjs` 依赖 `axios` 和 `dotenv`。这些应通过项目根目录的 `package.json` 和 `npm install` 进行管理，或者如果 `SunoGen` 插件有自己的 `package.json`，则在其目录内安装。
*   **VCP 服务器运行**: 启动主 VCP 服务器 (`node server.js`) 后，`SunoGen` 插件即可被 AI 调用。

## 📄 许可证

本插件作为 VCP 工具箱项目的一部分，遵循项目根目录 `LICENSE` 文件中定义的许可证条款 (当前为 CC BY-NC-SA 4.0)。
