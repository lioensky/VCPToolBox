# ComfyUI插件后端功能介绍

## 📋 概述

ComfyUI插件为VCP聊天系统提供专业级AI图像生成功能，支持文本到图像、图像到图像等多种生成模式。该插件采用模块化设计，支持自定义工作流和灵活的参数配置。

## 🚀 主要功能

### 1. 图像生成核心功能
- **文本到图像**: 基于自然语言描述生成高质量图像
- **工作流引擎**: 支持ComfyUI标准工作流格式
- **参数化配置**: 灵活的生成参数控制
- **批量生成**: 支持多张图像同时生成

### 2. 工作流管理
- **内置模板**: 提供常用的基础工作流模板
- **自定义工作流**: 支持用户自定义和编辑工作流
- **模板系统**: 支持占位符替换，动态参数注入
- **版本管理**: 工作流文件版本控制和备份

### 3. Agent集成
- **标准工具调用**: 兼容VCP工具调用格式
- **智能参数解析**: 自动解析Agent提供的生成参数
- **上下文感知**: 支持对话上下文中的图像生成请求
- **多Agent支持**: 同时为多个Agent提供服务

## 🔧 技术架构

### 核心组件
```
ComfyUIGen/
├── ComfyUIGen.js           # 主插件文件
├── placeholder-processor.js # 占位符处理器
├── workflows/              # 工作流模板目录
├── comfyui-settings.json   # 用户配置文件
└── plugin-manifest.json    # 插件清单
```

### 配置系统
插件采用三层配置优先级：
1. **comfyui-settings.json** (最高优先级) - 用户自定义配置
2. **config.env** (中等优先级) - 环境配置文件
3. **默认配置** (最低优先级) - 内置默认值

### 工作流引擎
- **模板加载**: 动态加载JSON格式工作流模板
- **占位符替换**: 支持`{{VARIABLE}}`格式的动态参数
- **参数验证**: 自动验证和转换参数类型
- **错误处理**: 完善的错误捕获和用户反馈

## 📝 支持的参数

### 基础参数
- `prompt`: 正面提示词
- `negative_prompt`: 负面提示词 (可选)
- `width`: 图像宽度
- `height`: 图像高度
- `steps`: 采样步数
- `cfg`: CFG Scale值
- `seed`: 随机种子 (可选)
- `sampler`: 采样器类型
- `model`: 使用的模型

### 高级参数
- `workflow`: 指定工作流模板
- `batch_size`: 批量生成数量
- `denoise`: 去噪强度 (img2img)

## 🔌 API接口

### 工具调用格式
```javascript
<<<[TOOL_REQUEST]>>>
tool_name:「始」ComfyUIGen「末」,
prompt:「始」一只可爱的小猫，坐在花园里「末」,
negative_prompt:「始」模糊，低质量「末」,
width:「始」1024「末」,
height:「始」1024「末」,
steps:「始」30「末」,
cfg:「始」7.5「末」,
seed:「始」12345「末」
<<<[END_TOOL_REQUEST]>>>
```

### 返回格式
```json
{
  "success": true,
  "images": [
    {
      "filename": "ComfyUI_00001_123456789.png",
      "path": "/output/images/ComfyUI_00001_123456789.png",
      "url": "http://localhost:8188/view?filename=ComfyUI_00001_123456789.png"
    }
  ],
  "metadata": {
    "prompt": "一只可爱的小猫，坐在花园里",
    "steps": 30,
    "cfg": 7.5,
    "seed": 12345,
    "model": "sd_xl_base_1.0.safetensors"
  }
}
```

## 🛠️ 安装和配置

### 环境要求
- Node.js 16+
- ComfyUI服务器 (本地或远程)
- VCP插件系统

### 配置步骤
1. **ComfyUI服务器**: 确保ComfyUI服务器正常运行
2. **插件配置**: 编辑`comfyui-settings.json`配置文件
3. **工作流**: 在`workflows/`目录添加自定义工作流
4. **Agent配置**: 更新Agent系统提示词

### 配置示例
```json
{
  "serverUrl": "http://localhost:8188",
  "apiKey": "",
  "defaultModel": "sd_xl_base_1.0.safetensors",
  "defaultWidth": 1024,
  "defaultHeight": 1024,
  "defaultSteps": 30,
  "defaultCfg": 7.5,
  "defaultSampler": "dpmpp_2m"
}
```

## 🔄 工作流系统

### 内置工作流
- **text2img_basic**: 基础文本到图像工作流
- **img2img_basic**: 基础图像到图像工作流

### 自定义工作流
用户可以创建自定义工作流模板：
```json
{
  "displayName": "自定义工作流",
  "description": "用户自定义的工作流模板",
  "version": "1.0",
  "workflow": {
    // ComfyUI工作流节点定义
  }
}
```

### 占位符系统
支持的占位符变量：
- `{{MODEL}}`: 模型文件名
- `{{POSITIVE_PROMPT}}`: 正面提示词
- `{{NEGATIVE_PROMPT}}`: 负面提示词
- `{{WIDTH}}`: 图像宽度
- `{{HEIGHT}}`: 图像高度
- `{{STEPS}}`: 采样步数
- `{{CFG}}`: CFG Scale
- `{{SEED}}`: 随机种子
- `{{SAMPLER}}`: 采样器

## 🚨 错误处理

### 常见错误
- **连接错误**: ComfyUI服务器不可达
- **模型错误**: 指定的模型文件不存在
- **参数错误**: 无效的生成参数
- **工作流错误**: 工作流文件格式错误

### 调试模式
设置`DEBUG_MODE: true`启用详细日志输出：
```bash
[ComfyUI] Loading workflow: text2img_basic
[ComfyUI] Processing parameters: {"prompt": "...", "steps": 30}
[ComfyUI] Queuing prompt to ComfyUI server
[ComfyUI] Generation completed: image_001.png
```

## 📈 性能优化

### 缓存机制
- **模型缓存**: 避免重复加载相同模型
- **工作流缓存**: 缓存已解析的工作流模板
- **参数优化**: 智能参数默认值管理

### 并发控制
- **队列管理**: 智能队列调度，避免服务器过载
- **超时处理**: 合理的超时设置和重试机制
- **资源监控**: 监控GPU内存和生成状态

## 🔐 安全特性

### 输入验证
- **参数过滤**: 严格的参数类型和范围验证
- **注入防护**: 防止恶意代码注入
- **资源限制**: 限制生成图像的尺寸和数量

### 访问控制
- **API密钥**: 支持ComfyUI服务器认证
- **权限管理**: 基于Agent的权限控制
- **审计日志**: 完整的操作日志记录

## 📦 部署建议

### 生产环境
- 使用专用的ComfyUI服务器
- 配置适当的资源限制
- 启用日志记录和监控
- 定期备份工作流和配置

### 开发环境
- 启用调试模式
- 使用测试工作流
- 配置开发专用的模型和参数

---

**版本**: v0.2.0  
**更新日期**: 2025-08-03  
**维护者**: VCP开发团队