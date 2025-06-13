# VCP ComfyUI 插件 (VCPComfyUIPlugin)

## 概述

VCP ComfyUI 插件允许 AI 助手通过 VCP (Voice Control Panel) 与本地或远程的 ComfyUI 实例进行交互。它支持列出工作流、发现 ComfyUI 环境资源、根据现有工作流生成图像，以及根据 AI 提供的抽象描述动态生成新的 ComfyUI 工作流。

## 功能特性 / 命令

本插件支持以下命令：

1. __`list_workflows`__

   - 描述：列出在插件配置的 ComfyUI 工作流目录中所有可用的 `.json` 工作流文件。
   - 参数：无。

2. __`discover_environment`__

   - 描述：从 ComfyUI 实例发现可用的资源，例如节点类型、加载的模型（Checkpoints）、采样器（Samplers）、调度器（Schedulers）、LoRAs、VAEs 等。
   - 参数：无。

3. __`generate_image`__

   - 描述：使用指定的 ComfyUI 工作流生成图像，并允许覆盖工作流中的参数。

   - 主要参数：

     - `workflow_id` (字符串, 可选): 工作流文件名 (例如 `my_workflow.json`)。如果提供了 `workflow_json`，则此参数可选。
     - `workflow_json` (字符串, 可选): 代表 ComfyUI 工作流 API 格式的 JSON 字符串。如果提供了 `workflow_id`，则此参数可选。
     - `prompt` (字符串, 可选): 要覆盖的正向提示词。
     - `negative_prompt` (字符串, 可选): 要覆盖的负向提示词。
     - `model_name` (字符串, 可选): 要覆盖的检查点模型名称 (例如 `model.safetensors`)。
     - `seed` (整数, 可选): KSampler 的种子。
     - `steps` (整数, 可选): KSampler 的步数。
     - `cfg` (浮点数, 可选): KSampler 的 CFG 值。
     - `sampler_name` (字符串, 可选): KSampler 的采样器名称。
     - `scheduler` (字符串, 可选): KSampler 的调度器名称。
     - `custom_params` (字符串, 可选): JSON 字符串，用于覆盖特定节点的特定输入。格式: `'{"node_id": {"input_name": value, ...}, ...}'`。

4. __`generate_workflow`__

   - 描述：根据 AI 提供的抽象描述（JSON 格式）生成一个 ComfyUI 工作流的 JSON 定义。
   - 主要参数：
     - `ai_workflow_description` (字符串, 必需): 一个 JSON 字符串，描述要生成的节点及其连接。它应包含一个 `nodes` 列表，每个节点包含 `ai_node_id` (AI内部使用的唯一ID), `class_type` (ComfyUI节点类型), `display_name` (可选, 节点显示名称) 和 `inputs` (一个字典，包含输入参数及其值或连接到其他节点的引用，格式为 `["引用的ai_node_id", 输出索引]`)。

## 安装与配置

1. __ComfyUI 设置__:

   - 确保您的 ComfyUI 实例正在运行，并且可以从运行 VCPToolBox 的机器上通过网络访问。
   - 记下 ComfyUI 的基础 URL (例如 `http://127.0.0.1:8188` — 注意：ComfyUI 默认端口通常是 8188，但此插件在 `main.py` 中的硬编码后备默认值为 `8001`，`plugin-manifest.json` 中为 VCP 配置界面提供的默认值也是 `8001`。请务必根据您的实际 ComfyUI 访问地址进行配置)。

2. __插件配置 (`config.env`)__: 在插件目录 (`Plugin/VCPComfyUIPlugin/`) 下，您需要创建一个 `config.env` 文件。您可以复制同目录下的 `config.env.example` 文件并重命名为 `config.env`，然后修改其内容。 该文件用于配置以下环境变量：

   - __`COMFYUI_BASE_URL`__

     - 描述：ComfyUI 服务器的基础 URL。
     - 示例：`COMFYUI_BASE_URL=http://127.0.0.1:8188`
     - 默认值 (如果未在 `config.env` 中设置，或通过 VCP 配置界面设置)：`http://127.0.0.1:8001` (请根据您的实际 ComfyUI 地址修改)

   - __`COMFYUI_WORKFLOWS_PATH`__

     - 描述：相对于插件目录 (`Plugin/VCPComfyUIPlugin/`) 的路径，指向包含 ComfyUI API 工作流 `.json` 文件的文件夹。
     - 示例：`COMFYUI_WORKFLOWS_PATH=workflows` (这意味着工作流文件应放在 `Plugin/VCPComfyUIPlugin/workflows/` 目录下)
     - 默认值：`workflows`

   - __`COMFYUI_OUTPUT_IMAGE_TYPE`__

     - 描述：指定 `generate_image` 命令返回图像数据的类型。

       - `url`: 返回 ComfyUI 输出目录中图像的直接 URL。
       - `base64`: 返回 base64 编码的图像数据。

     - 示例：`COMFYUI_OUTPUT_IMAGE_TYPE=url`

     - 默认值：`url`

   - __`COMFYUI_REQUEST_TIMEOUT_SECONDS`__

     - 描述：与 ComfyUI 服务器进行通信（例如，轮询历史记录、获取图像）时的超时时间（秒）。
     - 示例：`COMFYUI_REQUEST_TIMEOUT_SECONDS=120`
     - 默认值：`120`

   __`config.env` 文件示例内容__:

   ```env
   COMFYUI_BASE_URL=http://127.0.0.1:8188
   COMFYUI_WORKFLOWS_PATH=my_comfy_workflows
   COMFYUI_OUTPUT_IMAGE_TYPE=base64
   COMFYUI_REQUEST_TIMEOUT_SECONDS=180
   ```

## 使用示例

有关每个命令的具体调用示例，请参考插件的 `plugin-manifest.json` 文件中各命令的 `example` 字段。AI 助手将根据这些示例格式来调用插件。

## 故障排查

- 如果插件执行出错，可以首先检查 VCPToolBox 的控制台输出或 VCP 的插件日志界面。
- 插件会在其目录 (`Plugin/VCPComfyUIPlugin/`) 下生成一个 `debug_log.txt` 文件，其中记录了更详细的执行信息，包括接收到的输入和关键步骤的日志，可用于问题诊断。
- 确保 `config.env` 中的 `COMFYUI_BASE_URL` 正确指向了正在运行的 ComfyUI 实例，并且网络可达。
- 对于 `list_workflows`，请确保 `COMFYUI_WORKFLOWS_PATH` 指定的目录存在于 `Plugin/VCPComfyUIPlugin/` 目录下，并且其中包含有效的 `.json` 工作流文件。
