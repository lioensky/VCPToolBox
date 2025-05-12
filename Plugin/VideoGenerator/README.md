# Wan2.1VideoGen 插件 (视频生成器)

这是一个同步插件，用于通过 SiliconFlow (万兴) 的 Wan2.1 API 进行文本到视频 (Text-to-Video, t2v) 和图像到视频 (Image-to-Video, i2v) 的生成。它通过标准输入/输出 (stdio) 与 Python 脚本 ([`video_handler.py`](Plugin/VideoGenerator/video_handler.py)) 交互。

## 功能

*   **提交生成任务**:
    *   支持 **文本到视频 (t2v)**: 根据用户提供的文本提示词 (prompt) 和指定分辨率生成视频。
    *   支持 **图像到视频 (i2v)**: 根据用户提供的图片 URL 和可选的指导性提示词生成视频。插件会自动下载、处理图片（调整大小、裁剪、编码为 WebP Base64）以适应 API 要求。
    *   提交成功后返回一个唯一的任务 ID (`requestId`)。
*   **查询任务状态**:
    *   根据 `requestId` 查询已提交任务的生成状态。
    *   返回状态可能为 `InProgress` (进行中), `Succeed` (成功), 或 `Failed` (失败)。
    *   成功时，结果中会包含生成的视频 URL。
*   **异步流程**: 视频生成是一个耗时的过程。插件的工作流程是先提交任务，获取 ID，然后（可能在一段时间后）使用 ID 查询结果。

## 工作方式

1.  插件管理器启动 `python video_handler.py` 进程。
2.  AI 助手根据 [`plugin-manifest.json`](Plugin/VideoGenerator/plugin-manifest.json) 中的 `invocationCommands` 格式，将包含 `command` (`submit` 或 `query`) 及相应参数的 JSON 字符串发送到脚本的标准输入。
3.  [`video_handler.py`](Plugin/VideoGenerator/video_handler.py) 解析输入：
    *   **加载配置**: 从插件目录下的 [`config.env`](Plugin/VideoGenerator/config.env.example) 文件读取 API 密钥和模型名称。
    *   **处理 `submit`**:
        *   如果是 `i2v`，下载并处理图片。
        *   调用 SiliconFlow 的 `/video/submit` API。
        *   返回包含 `requestId` 的成功 JSON，并附带提示 AI 告知用户任务已提交、需要等待并稍后查询的 `messageForAI`。
    *   **处理 `query`**:
        *   调用 SiliconFlow 的 `/video/status` API。
        *   返回包含 API 完整响应（状态、结果 URL 等）的成功 JSON，并根据查询到的状态附带相应的 `messageForAI` (例如，提示用户仍在进行中、提供 URL 或告知失败原因)。
4.  脚本将结果或错误封装成 JSON 对象写入标准输出。
5.  插件管理器读取 JSON 输出并处理结果，包括将 `messageForAI` 的内容呈现给 AI。

## 配置

需要在插件目录下创建一个名为 `config.env` 的文件，并包含以下内容（参考 [`config.env.example`](Plugin/VideoGenerator/config.env.example)）：

```env
Wan_API_Key="YOUR_SILICONFLOW_API_KEY"
Image2VideoModelName="Wan-AI/Wan2.1-I2V-14B-720P-Turbo" # 或其他支持的 i2v 模型
Text2VideoModelName="Wan-AI/Wan2.1-T2V-14B-Turbo"   # 或其他支持的 t2v 模型
# DebugMode=True # 可选，启用详细日志
```

*   将 `YOUR_SILICONFLOW_API_KEY` 替换为你的实际 API 密钥。
*   模型名称可以根据需要修改为 SiliconFlow 支持的其他模型。

## 依赖

*   **Python**: 版本 >= 3.7 (建议)
*   **Python 库**:
    *   `requests`
    *   `python-dotenv`
    *   `Pillow`
    (这些库在 [`requirements.txt`](Plugin/VideoGenerator/requirements.txt) 中列出，可以使用 `pip install -r requirements.txt` 安装。)

## 日志

插件运行时的详细操作、API 请求/响应摘要以及错误信息会记录在插件目录下的 [`VideoGenHistory.log`](Plugin/VideoGenerator/VideoGenHistory.log) 文件中，便于调试和追踪问题。

## 使用说明 (供 AI 参考)

AI 助手必须严格按照 [`plugin-manifest.json`](Plugin/VideoGenerator/plugin-manifest.json) 中为 `submit` 和 `query` 命令定义的格式来调用此工具。

**关键点**:

*   **区分命令**: 必须明确指定 `command` 是 `submit` 还是 `query`。
*   **参数准确**: 严格按照 manifest 中列出的参数和顺序提供，不要包含额外的参数。所有值用 `「始」` 和 `「末」` 包裹。
*   **提交 (`submit`)**:
    *   必须包含 `mode` (`t2v` 或 `i2v`)。
    *   根据 `mode` 提供必需的参数 (`prompt`, `resolution` 或 `image_url`)。
    *   **重要**: 提交成功后，AI 应根据返回的 `messageForAI` 告知用户任务已提交，ID 是多少，并强调生成需要时间，稍后需要使用 `query` 命令查询结果。
*   **查询 (`query`)**:
    *   必须包含 `request_id`。
    *   **重要**: 查询后，AI 应根据返回的 `messageForAI` 和 `result` 中的状态向用户传达结果（进行中、成功并提供 URL、或失败及原因）。

**示例调用**: (详见 [`plugin-manifest.json`](Plugin/VideoGenerator/plugin-manifest.json) 中的 `example` 字段)

## 错误处理

脚本会捕获常见的错误，如：

*   无效的 JSON 输入。
*   缺少必要的配置（API 密钥）。
*   无效的命令或模式。
*   缺少必要的参数。
*   图片下载或处理失败。
*   API 请求失败（网络错误、认证失败、API 内部错误）。

错误信息会包含在输出 JSON 的 `error` 字段中。