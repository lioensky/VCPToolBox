# ComfyUIGen 插件后端说明（工作流程 / 占位符替换 / 无前端接入）

本指南面向开发者与集成方，介绍 ComfyUIGen 插件在后端的工作方式，包括：
- 如何仅依赖配置文件完成接入（无需任何前端）
- 工作流模板与占位符替换的机制与扩展
- 目录结构与读写约定
- 提交 PR 前的验证清单（含端到端与替换逻辑用例）



--------------------------------

## 一、目录结构与关键路径

插件根目录：`VCPToolBox/Plugin/ComfyUIGen/`

- 配置文件（可独立使用）：`comfyui-settings.json`
- 工作流目录：`workflows/`
- 模板目录：`templates/`
- 输出目录：`output/`
- 模板处理脚本（自动替换核心）：[@/VCPToolBox/Plugin/ComfyUIGen/WorkflowTemplateProcessor.js](./WorkflowTemplateProcessor.js:1)
- 可能的工具脚本（如存在）：`workflow_template_processor.py`（辅助工具，实际以 JS 版为准）

说明：
- 前端 UI 仅提供可视化的配置与管理，但不是必需品。你可以只读写 `comfyui-settings.json` 来驱动整个生图流程。
- 工作流以 JSON 存储在 `workflows/` 下；导入 ComfyUI API JSON 后会转换为“模板友好格式”。

--------------------------------

## 二、无需前端的接入方式（最简方式）

任何应用只需读写一个 JSON 文件即可集成 ComfyUIGen：

配置文件位置：
- `VCPToolBox/Plugin/ComfyUIGen/comfyui-settings.json`

示例字段（实际以生成时为准）：
```json
{
  "serverUrl": "http://localhost:8188",
  "apiKey": "",
  "workflow": "text2img_basic",
  "defaultModel": "sd_xl_base_1.0.safetensors",
  "defaultWidth": 1024,
  "defaultHeight": 1024,
  "defaultSteps": 30,
  "defaultCfg": 7.5,
  "defaultSampler": "dpmpp_2m",
  "defaultScheduler": "normal",
  "defaultSeed": -1,
  "defaultBatchSize": 1,
  "defaultDenoise": 1.0,
  "negativePrompt": "lowres, bad anatomy, ...",
  "loras": [
    { "name": "some-lora.safetensors", "strength": 0.8, "clipStrength": 0.8, "enabled": true }
  ],
  "qualityTags": "masterpiece, best quality",
  "version": "1.0.0",
  "lastUpdated": "2025-01-08T00:00:00Z"
}
```

集成步骤：
1) 读取 JSON，获得 ComfyUI 服务地址、默认生成参数、工作流名称等。
2) 从 `workflows/WORKFLOW_NAME.json` 读取工作流模板。
3) 使用“模板处理/占位符替换”（见下一章）将模板中的占位符替换为 `comfyui-settings.json` 中的实际值与调用时输入（正/负面提示词、LoRA、尺寸等）。
4) 将替换后的工作流 JSON 提交至 ComfyUI（通常走 /prompt 等接口，具体按你的调用链）。
5) 生成文件默认由 ComfyUI 保存（例如 SaveImage 节点）；若需要同步输出目录，可在你的生成脚本中处理结果文件转存到 `output/`。

注意：
- 你可以完全不运行前端 UI，仍然具备全功能的参数化与模板化工作流生成能力。
- 上层应用（例如 Agent 或 Web 服务）只需对 `comfyui-settings.json` 做写入即可改变生成参数。

--------------------------------

## 三、工作流模板与占位符替换

核心脚本：[@/VCPToolBox/Plugin/ComfyUIGen/WorkflowTemplateProcessor.js](./WorkflowTemplateProcessor.js:1)

作用：
- 将 ComfyUI API 导出的原始工作流 JSON 转换为“带占位符的模板”
- 在执行前，将模板中的占位符替换为“配置 + 运行时参数”的实际值
- 自动识别可替换与保留字段，避免误替换关键节点连接

常用占位符（约定范例）：
- `{{MODEL}}`：Checkpoint 模型（对应 CheckpointLoaderSimple 的 ckpt_name）
- `{{WIDTH}}` / `{{HEIGHT}}`：图像尺寸（EmptyLatentImage 等节点的 width/height）
- `{{POSITIVE_PROMPT}}` / `{{NEGATIVE_PROMPT}}`：正面/负面提示词（CLIPTextEncode 节点 text）
- `{{SEED}}` / `{{STEPS}}` / `{{CFG}}` / `{{SAMPLER}}` / `{{SCHEDULER}}` / `{{DENOISE}}`：采样相关
- 可按需要引入更多占位符（例如 `{{BATCH_SIZE}}` 等）

自动识别与不替换规则（示例思路）：
- 处理器会扫描节点结构与 `class_type` 和 `inputs` 字段，对“已知可替换键”进行替换
- 不会替换节点 ID、连线引用（如 ["4", 1] 这种指针）
- 对未知键采取“白名单”策略：只有在内置或扩展的替换映射中出现的键才会替换

如何扩展替换规则（示意步骤）：
1) 在 WorkflowTemplateProcessor 中扩展“可替换映射”（如将某 class_type 的某 input 键关联到一个占位符）
2) 为新占位符定义参数来源（来自配置文件、或来自运行时调用参数）
3) 补充单元测试用例：提供最小工作流片段 + 期望替换结果

导入流程（从 API JSON → 模板 JSON）：
- 前端 UI 中“导入工作流”会调用主进程 IPC，将 API JSON 交给 WorkflowTemplateProcessor 生成模板化版本
- 生成的模板会写入 `workflows/NAME.json`
- 你也可以在后端直接调用处理器，跳过前端

--------------------------------

## 四、运行时合成的提示词与 LoRA

建议做法：
- 正面提示词 = 用户输入 + `qualityTags` + 已启用的 LoRA 提示（如 `<lora:xxx:strength>` 的拼接，具体按你的调用约定）
- 负面提示词 = `comfyui-settings.json` 的 `negativePrompt` + 可能的运行时追加
- LoRA 具体注入方式：
  - 方案 A：通过文本提示追加 token（依赖工作流中对应注入方式）
  - 方案 B：通过在模板中加入 LoRA 节点（如 LoraLoader），并用占位符列表替换
- 如果你的工作流以“LoraLoader 节点”形式出现，建议定义 `{{LORA_LIST}}` 占位符以及“列表型展开逻辑”

--------------------------------

## 五、API 交互（参考）

ComfyUI 常见接口（不同版本可能略有差异）：
- GET `/system_stats`：连通测试与资源查看
- GET `/object_info`：可用模型、LoRA、采样器等信息
- POST `/prompt`：提交工作流生成请求（请按你的版本文档对接）

你的服务端在执行时序上通常是：
1) 读取 `comfyui-settings.json`
2) 读取 `workflows/NAME.json`（模板）
3) 通过处理器生成“实际工作流 JSON”
4) POST 至 ComfyUI
5) 收集结果（如输出路径、文件名），回传给上层应用

--------------------------------

## 六、测试与 PR 验证清单

1) 配置文件直连（无前端）
- 修改 `comfyui-settings.json` 的 `workflow`、`defaultModel`、尺寸、Steps/CFG、负面词
- 读取模板并执行一次生成，确认参数生效
- 切换到另一工作流模板，重复验证

2) 占位符替换覆盖用例
- 基础替换：MODEL/WIDTH/HEIGHT/POSITIVE/NEGATIVE/SEED/STEPS/CFG/SAMPLER/SCHEDULER/DENOISE
- LoRA：启用/禁用多个 LoRA，强度变化是否体现在替换结果里
- 不替换区域：节点连线（["id", index]）必须保持原样
- 未知键：在未列入映射时不应替换

3) 导入转换
- 准备多份 ComfyUI API JSON（含不同节点组合）
- 导入 → 生成模板 → 读取模板执行 → 产出结果对比

4) 可靠性/性能
- 在不同目录布局（含容器/便携/用户目录回退）下读取与写入是否正常
- 大模板或多 LoRA 叠加时替换耗时是否可接受

5) 回归与兼容
- 低版本 ComfyUI 的接口字段兼容性（如采样器别名、调度器枚举不同）
- 插件目录无写权限时的报错与降级处理（例如回退到用户目录）

--------------------------------

## 七、常见问题（FAQ）

- Q：不使用前端是否会缺失功能？
  - A：不会。前端只是图形界面。任何上层应用仅通过 `comfyui-settings.json` 与工作流模板即可完成完整的参数化生成。

- Q：如何为特殊节点增加新占位符？
  - A：在 `WorkflowTemplateProcessor.js` 扩展映射与替换逻辑，并为新占位符定义来源（配置/运行时），最后补测试用例。

- Q：工作流中存在自定义节点/第三方扩展怎么办？
  - A：只要确定它们的 inputs 结构与所需参数，即可在处理器中按相同方式加入可替换键。

--------------------------------

## 八、示例：最小工作流模板片段（占位符）

```json
{
  "3": {
    "class_type": "KSampler",
    "inputs": {
      "seed": "{{SEED}}",
      "steps": "{{STEPS}}",
      "cfg": "{{CFG}}",
      "sampler_name": "{{SAMPLER}}",
      "scheduler": "{{SCHEDULER}}",
      "denoise": "{{DENOISE}}",
      "model": ["4", 0],
      "positive": ["6", 0],
      "negative": ["7", 0],
      "latent_image": ["5", 0]
    }
  },
  "4": {
    "class_type": "CheckpointLoaderSimple",
    "inputs": {
      "ckpt_name": "{{MODEL}}"
    }
  },
  "5": {
    "class_type": "EmptyLatentImage",
    "inputs": {
      "width": "{{WIDTH}}",
      "height": "{{HEIGHT}}",
      "batch_size": 1
    }
  },
  "6": {
    "class_type": "CLIPTextEncode",
    "inputs": {
      "text": "{{POSITIVE_PROMPT}}",
      "clip": ["4", 1]
    }
  },
  "7": {
    "class_type": "CLIPTextEncode",
    "inputs": {
      "text": "{{NEGATIVE_PROMPT}}",
      "clip": ["4", 1]
    }
  }
}
```

执行前，处理器会用 `comfyui-settings.json` 与运行时参数替换这些占位符。

--------------------------------

