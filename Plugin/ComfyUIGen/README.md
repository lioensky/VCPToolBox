# ComfyUIGen 后端使用简明说明

面向后端/集成使用的最小文档。若需完整细节与扩展点，请阅读更全面的说明文档：[@/VCPToolBox/Plugin/ComfyUIGen/docs/README_PLUGIN_CN.md](docs/README_PLUGIN_CN.md:1)

一、零前端集成（仅配置）
1) 配置文件位置：`VCPToolBox/Plugin/ComfyUIGen/comfyui-settings.json`
2) 关键字段示例：
```json
{
  "serverUrl": "http://localhost:8188",
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
  "negativePrompt": "lowres, bad anatomy ..."
}
```
3) 调用步骤（最少流程）：
- 读取 comfyui-settings.json 获取默认参数与 workflow 名称
- 读取 `workflows/WORKFLOW_NAME.json` 模板
- 使用模板处理器将占位符替换为“配置+运行时参数”
- 将替换结果 POST 至 ComfyUI `/prompt` 接口
- 输出文件按工作流设置保存（如 SaveImage 节点指向的目录）

二、模板与占位符
- 模板位于 `workflows/`，由导入的 ComfyUI API JSON 转换生成
- 常用占位符：`{{MODEL}}`、`{{WIDTH}}`、`{{HEIGHT}}`、`{{SEED}}`、`{{STEPS}}`、`{{CFG}}`、`{{SAMPLER}}`、`{{SCHEDULER}}`、`{{DENOISE}}`、`{{POSITIVE_PROMPT}}`、`{{NEGATIVE_PROMPT}}`
- 处理器脚本：[@/VCPToolBox/Plugin/ComfyUIGen/WorkflowTemplateProcessor.js](WorkflowTemplateProcessor.js:1)

三、LoRA与提示词
- 正面提示词 = 运行时输入 + 质量词（如 `qualityTags`）+ 启用的 LoRA token
- LoRA 注入可走两种策略：
  1) 文本 token：`<lora:xxx.safetensors:strength:clipStrength>`
  2) 节点法：在模板中使用 LoraLoader 类节点并以占位符替换
- 负面提示词通常来自 comfyui-settings.json 的 `negativePrompt`

四、随机种子处理
- 当 `defaultSeed = -1`（随机器）时，运行时将自动生成合法的 32 位无符号随机种子并替换，避免 KSampler 拒绝负数种子
- 逻辑实现在主执行脚本：[@/VCPToolBox/Plugin/ComfyUIGen/ComfyUIGen.js](ComfyUIGen.js:1)

五、最小可执行清单
- 必备文件：
  - `comfyui-settings.json`
  - `workflows/<你的工作流>.json`（模板）
- 可选文件：
  - `templates/`（模板备份）
  - `output/`（结果转存目录，如需二次管理）

六、常见问题
- 无前端也可完整运行：仅通过配置与模板即可生成
- 不要改动模板中的节点连线引用（如 ["4", 1]），那是图结构索引
- 新占位符或新节点字段：扩展 WorkflowTemplateProcessor 的映射

更多细节、目录结构说明、测试与 PR 校验清单，请参考完整文档：[@/VCPToolBox/Plugin/ComfyUIGen/docs/README_PLUGIN_CN.md](docs/README_PLUGIN_CN.md:1)

## Anima 生图增强

[AnimaEZGen 工作流](workflows/AnimaEZGen.json) 已按增强版重写：生图 → AnimeSharp 缩放 → FaceDetailer 面部重绘 → 保存，调用名称仍为 AnimaEZGen。

- 放大倍率参数 [resize_scale](ComfyUIGen.js:119)：可选，默认 1（保持原尺寸），可传 1.5、2 等正数。倍率为 1 时仍执行 AnimeSharp 增强再缩回原尺寸，不是跳过增强节点。
- 面部重绘提示词参数 [face_prompt](ComfyUIGen.js:126)：可选，默认 `detailed glassy eyes, smooth porcelain skin`，独立于主画面提示词；显式传空字符串则使用空面部提示词。
- 保留主画面提示词、尺寸、步数、种子以及 LoRA 覆盖能力；主采样默认 24 步、CFG 4、Euler Ancestral / Normal，面部重绘沿用增强版固定参数。
- 需要原增强工作流对应的 FaceDetailer、UltralyticsDetectorProvider、UpscaleImageByModelThenResize 节点，以及 Anima 模型、LoRA、face_yolov8m 检测模型和 AnimeSharp 放大模型。

调用示例：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」ComfyUIGen「末」,
workflow:「始」AnimaEZGen「末」,
prompt:「始」1girl, silver hair, blue eyes, cinematic anime illustration「末」,
resize_scale:「始」2「末」,
face_prompt:「始」detailed blue eyes, delicate face, gentle smile「末」
<<<[END_TOOL_REQUEST]>>>
```

仅需默认效果时，省略放大倍率和面部重绘提示词这两行即可。