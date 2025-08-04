# ComfyUI工作流模板转换系统

完全解耦的ComfyUI工作流自动替换符机制，支持前端界面和独立命令行使用。

## 🎯 功能特性

### 智能模板转换
- **自动节点识别**: 智能识别KSampler、EmptyLatentImage、WeiLinPromptToString等关键节点
- **占位符替换**: 自动插入{{MODEL}}、{{POSITIVE_PROMPT}}等标准占位符
- **节点保护**: 自动保留FaceDetailer、VAEDecode等无需修改的节点

### 完整LoRA支持
- **标准格式**: `<lora:概念/细节增强.safetensors:1:1>`
- **智能插入**: 自动插入到提示词正确位置
- **强度控制**: 支持模型强度和CLIP强度独立设置

### 智能提示词拼接
```
用户提示词 + LoRA + 质量增强词
"一个美丽女孩在花园中跳舞, <lora:概念/细节增强.safetensors:1:1>, masterpiece, best quality, high resolution, detailed"
```

## 📁 文件结构

```
VCPToolBox/Plugin/ComfyUIGen/
├── ComfyUIGen.js                    # 简化主脚本 (仅加载+填充)
├── WorkflowTemplateProcessor.js     # Node.js转换处理器
├── workflow_template_processor.py   # Python转换处理器
├── workflow-template-cli.js         # Node.js命令行工具
├── workflow_converter.bat           # Windows批处理工具
├── workflows/                       # 工作流模板文件夹
├── templates/                       # 模板备份文件夹
└── comfyui-settings.json           # 配置文件

VCPChat/ComfyUImodules/
├── comfyUIConfig.js                # 前端配置界面(含导入功能)
├── comfyUIHandlers.js              # IPC处理器(集成转换API)
├── PathResolver.js                 # 跨环境路径解析
└── comfyui.css                     # 样式文件
```

## 🚀 使用方法

### 1. 前端界面使用 (推荐)

1. 在VCPChat中打开ComfyUI配置界面
2. 切换到"导入工作流"标签页
3. 输入工作流名称
4. 粘贴ComfyUI导出的API格式JSON
5. 点击"转换并保存"

### 2. Python命令行使用

```bash
# 转换工作流为模板
python workflow_template_processor.py convert input.json output_template.json

# 使用配置填充模板
python workflow_template_processor.py fill template.json output.json --prompt "美丽女孩"

# 验证模板
python workflow_template_processor.py validate template.json

# 分析工作流结构
python workflow_template_processor.py analyze workflow.json
```

### 3. Windows批处理使用

双击 `workflow_converter.bat` 进入交互式菜单

### 4. Node.js命令行使用

```bash
# 转换工作流
node workflow-template-cli.js convert workflows/示例.json templates/示例-template.json

# 填充模板
node workflow-template-cli.js fill templates/示例-template.json comfyui-settings.json output/workflow.json "美丽女孩"

# 验证模板
node workflow-template-cli.js validate templates/示例-template.json
```

## ⚙️ 配置文件格式

`comfyui-settings.json`:
```json
{
  "defaultModel": "JANKUV4NSFWTrainedNoobaiEPS_v40.safetensors",
  "defaultWidth": 1024,
  "defaultHeight": 1024,
  "defaultSteps": 30,
  "defaultCfg": 6.5,
  "defaultSampler": "euler_ancestral",
  "defaultScheduler": "normal",
  "defaultSeed": -1,
  "defaultBatchSize": 1,
  "defaultDenoise": 1,
  "defaultLoRA": "概念/细节增强.safetensors",
  "defaultLoRAStrength": 1,
  "negativePrompt": "lowres, bad anatomy, bad hands, text, error..."
}
```

## 🔄 工作流程

1. **用户在ComfyUI中**: 设计工作流 → 导出API格式JSON
2. **转换处理**: 粘贴JSON → 自动解析节点 → 插入占位符 → 保存模板
3. **Agent调用**: 主脚本加载模板 → 填充用户参数 → 提交到ComfyUI

## 🛠️ 支持的节点类型

### 自动替换节点
- `KSampler`: seed, steps, cfg, sampler_name, scheduler, denoise
- `EmptyLatentImage`: width, height, batch_size  
- `CheckpointLoaderSimple`: ckpt_name
- `WeiLinPromptToString`: positive, negative
- `PrimitiveString`: value
- `easy comfyLoader`: ckpt_name, lora settings

### 保留原样节点
- `VAEDecode`, `SaveImage`, `UpscaleModelLoader`
- `UltralyticsDetectorProvider`, `SAMLoader`
- `FaceDetailer` 等高级功能节点

## 📝 占位符列表

- `{{MODEL}}`: 模型文件名
- `{{WIDTH}}`, `{{HEIGHT}}`: 图像尺寸  
- `{{STEPS}}`: 采样步数
- `{{CFG}}`: CFG引导强度
- `{{SAMPLER}}`, `{{SCHEDULER}}`: 采样器设置
- `{{SEED}}`: 随机种子
- `{{POSITIVE_PROMPT}}`: 正面提示词(含LoRA)
- `{{NEGATIVE_PROMPT}}`: 负面提示词
- `{{BATCH_SIZE}}`, `{{DENOISE}}`: 批次和降噪设置

## ✅ 测试验证

系统已通过完整测试:
- ✅ 工作流转换: 14个替换, 6个保留节点
- ✅ LoRA插入: `<lora:概念/细节增强.safetensors:1:1>`
- ✅ 提示词拼接: 用户词+LoRA+质量词
- ✅ 跨环境兼容: PathResolver自动寻址
- ✅ Python独立工具: 完整功能实现

## 🔧 故障排除

1. **模块找不到**: 确保PathResolver正确解析VCPToolBox路径
2. **中文乱码**: Python工具已处理Windows编码问题  
3. **路径问题**: 使用绝对路径或相对于工具目录的路径
4. **配置缺失**: 工具会自动查找comfyui-settings.json

## 📄 许可证

此工具为开源项目，遵循MIT许可证。