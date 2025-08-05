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
- 下述场景将“不会被替换/强制保留”（详见实现 [@/VCPToolBox/Plugin/ComfyUIGen/WorkflowTemplateProcessor.js](../WorkflowTemplateProcessor.js:1)）：
  1) 标题/名称含“不替换”语义关键字（多语言）：如 "no"、"not"、"none"、"skip"、"hold"、"keep"、"别动"、"不替换"、"保持"、"跳过"、"保留"（命中即跳过替换）。
  2) 罕见/未知 `class_type`（不在可替换白名单映射内）：默认保留，避免误改第三方/自定义节点。
  3) 显式保留的节点类型：如 `VAEDecode`、`SaveImage`、`UpscaleModelLoader`、`UltralyticsDetectorProvider`、`SAMLoader`、`FaceDetailer`。
  4) 特殊判定：`WeiLinPromptToString` 等承担 LoRA 处理的节点在特定标题语义下将保留原样（避免破坏 LoRA 管线）。
  5) 结构性字段：任何连线引用数组（如 `["4", 1]`）一律不替换，仅替换纯字符串/数值目标字段。

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

以下清单用于提交 PR 前的自检，覆盖端到端流程与替换逻辑。建议在本插件目录执行并保留最小验证素材。

A. 端到端（E2E）最小路径
- 配置直连（无前端）
  1. 修改 `comfyui-settings.json` 的以下关键字段并保存：
     - `workflow`、`defaultModel`、`defaultWidth`/`defaultHeight`、`defaultSteps`、`defaultCfg`
     - `defaultSampler`、`defaultScheduler`、`defaultSeed`（设为 -1 验证随机种子）、
       `defaultBatchSize`、`defaultDenoise`、`negativePrompt`
  2. 从 `workflows/WORKFLOW_NAME.json` 读取模板，执行一次生成，确认参数已生效。
  3. 切换到另一工作流模板，重复验证。

B. 占位符替换覆盖用例
- 基础替换项
  - MODEL / WIDTH / HEIGHT / POSITIVE_PROMPT / NEGATIVE_PROMPT
  - SEED / STEPS / CFG / SAMPLER / SCHEDULER / DENOISE
  - 可选：BATCH_SIZE（如模板中存在）
- LoRA 行为
  - 启用/禁用多个 LoRA；调整 strength/clipStrength 后应在结果提示词或节点参数中体现。
- 不应被替换的区域
  - 节点连线引用（例如 `["4", 1]`）必须保持原样。
- 未知键策略
  - 未在白名单映射中的键不应被替换。

C. 导入与模板转换
- 准备多份 ComfyUI “Save (API Format)” JSON，覆盖不同节点组合。
- 经由模板处理器转换为模板 → 写入 `workflows/NAME.json` → 执行生成 → 对比产出。
- 验证转换时的元数据（如果存在 `_template_metadata`）不会污染最终模板保存。

D. 可靠性与性能
- 不同目录布局（容器/便携/用户目录回退）下可正确发现并读写：
  - `comfyui-settings.json`、`workflows/`、`output/`
- 大模板、批量 LoRA 叠加时的替换耗时与内存占用可接受。

E. 回归与兼容
- 低版本 ComfyUI 的字段兼容性（采样器与调度器枚举差异）。
- 插件目录无写权限时的降级策略与报错可读性（回退至用户目录）。

F. PR 规范检查
- 仅提交必要的源码与文档变更；不包含依赖升级与生成产物。
- 分支命名与提交信息清晰，引用本 README 的章节用于说明验证范围。

--------------------------------

## 七、模板替换行为说明（命名可选项、强替换/不替换场景）

节点命名来源（用于定位与判定，按优先级）：
1) class_type（首选，稳定且与 ComfyUI 节点实现对齐）
2) 节点内部 ID/键（API JSON 的对象键，例如 "3"、"4"）
3) _meta.title/显示名（可选，用于歧义消解与“不替换”语义指示）

强替换定义：
- 仅对白名单占位符（如 `{{MODEL}}`、`{{WIDTH}}`、`{{HEIGHT}}`、`{{SEED}}`、`{{STEPS}}`、`{{CFG}}`、`{{SAMPLER}}`、`{{SCHEDULER}}`、`{{DENOISE}}`、`{{POSITIVE_PROMPT}}`、`{{NEGATIVE_PROMPT}}`、`{{BATCH_SIZE}}`）出现的已知输入键执行直接覆盖。
- 执行覆盖前进行类型/结构合理性检查；不匹配时拒绝替换并记录原因。

不会被替换（扩展版）：
- 标题/名称命中“不替换”关键字：见上文“自动识别与不替换规则”第 1 点。
- 未知/不常见类型：class_type 不在白名单映射中时默认保留。
- 被明确列入保留列表的节点类型：如 `SaveImage` 等。
- 连线/指针结构：如 `["4", 1]` 等始终不替换。
- 未在映射中的键：非白名单键不替换，避免误改。
- LoRA 处理专用节点：在特定标题标记（如包含 “lora”）下保留原样。

预编译与 mtime 缓存（即将引入/或已实现）：
- 处理器在首次加载模板时分析 JSON，记录占位符出现的确定性路径（如 nodes[i].inputs[key]）。
- 以“文件路径 + mtimeMs”为键缓存分析结果；mtime 变化时自动失效重建。
- 运行时仅按预编译路径直达替换，避免全量遍历，降低复杂度与耗时。
- 提供清缓存钩子（例如 `clearCache()`）以便测试。

示例：KSampler 与尺寸/模型替换路径请参考下文“术语与参数枚举统一”与“最小模板片段”。

## 八、术语与参数枚举统一（Sampler/Scheduler/Denoise）

为避免歧义，以下术语与取值与 ComfyUI 节点输入保持一致，尤其是 KSampler 节点的 inputs：
- Sampler（对应模板中的 `{{SAMPLER}}` → KSampler.inputs.sampler_name）
  - 常见值示例：`euler`、`euler_ancestral`、`dpmpp_2m`、`dpmpp_sde` 等
  - 枚举来源：ComfyUI `/object_info` 中 `KSampler`/相关节点的 `sampler_name` 输入候选
- Scheduler（对应模板中的 `{{SCHEDULER}}` → KSampler.inputs.scheduler）
  - 常见值示例：`normal`、`karras`、`exponential`、`simple`
  - 枚举来源：ComfyUI `/object_info` 中相应字段
- Denoise（对应模板中的 `{{DENOISE}}` → KSampler.inputs.denoise）
  - 取值范围：0.0–1.0（浮点，依工作流具体含义可能不同）
- Seed（对应模板中的 `{{SEED}}` → KSampler.inputs.seed）
  - 当配置中 `defaultSeed` 为 -1 时，运行时由后端生成非负随机种子（32-bit 无符号）
  - 参考实现：[@/VCPToolBox/Plugin/ComfyUIGen/ComfyUIGen.js](../ComfyUIGen.js:1)

建议实践
- 优先通过 `/object_info` 实时拉取可用枚举，避免硬编码。
- 若用户在 `comfyui-settings.json` 中填入不兼容的取值，执行前做一次映射校验或回退到默认值，并在日志中提示。
- 在模板中仅使用上述占位符，保持“替换白名单策略”，避免破坏节点连接指针。

--------------------------------

## 九、常见问题（FAQ）

- Q：不使用前端是否会缺失功能？
  - A：不会。前端只是图形界面。任何上层应用仅通过 `comfyui-settings.json` 与工作流模板即可完成完整的参数化生成。

- Q：如何为特殊节点增加新占位符？
  - A：在 `WorkflowTemplateProcessor.js` 扩展映射与替换逻辑，并为新占位符定义来源（配置/运行时），最后补测试用例。

- Q：工作流中存在自定义节点/第三方扩展怎么办？
  - A：只要确定它们的 inputs 结构与所需参数，即可在处理器中按相同方式加入可替换键。

--------------------------------

## 十、示例：最小工作流模板片段（占位符）

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

