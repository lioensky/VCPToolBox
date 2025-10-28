# MultimediaProcessor 使用示例

本文档提供 MultimediaProcessor 插件的实际使用示例。

## 快速开始

### 1. 初始配置

首先，复制示例配置文件：

```bash
cd Plugin/MultimediaProcessor
cp presets.json.example presets.json
cp path-aliases.json.example path-aliases.json
cp config.env.example config.env
```

### 2. 配置路径别名

编辑 `path-aliases.json`，添加你的常用路径：

```json
{
  "images": "/Users/yourname/Pictures",
  "screenshots": "/Users/yourname/Desktop/Screenshots",
  "downloads": "/Users/yourname/Downloads",
  "project": "/path/to/your/project/assets"
}
```

### 3. 自定义预设（可选）

编辑 `presets.json` 添加你的自定义预设，可以指定不同的模型和参数：

```json
{
  "code_analysis": {
    "displayName": "代码分析",
    "prompt": "这是一个代码截图。请分析代码的功能、使用的编程语言、关键逻辑和可能的优化建议。",
    "model": "gpt-4-vision-preview",
    "maxTokens": 1500,
    "temperature": 0.3,
    "topP": 0.9,
    "thinkingBudget": 0
  },
  "ui_review": {
    "displayName": "UI 评审",
    "prompt": "这是一个 UI 设计。请从用户体验、视觉设计、信息架构角度进行评审。",
    "model": "claude-3-opus-20240229",
    "maxTokens": 2000,
    "temperature": 0.7,
    "topP": 1.0,
    "thinkingBudget": 0
  },
  "marketing_copy": {
    "displayName": "营销文案",
    "prompt": "基于这个图片，创作吸引人的营销文案，要有创意和感染力。",
    "model": "gpt-4o",
    "maxTokens": 1000,
    "temperature": 0.9,
    "topP": 0.95,
    "thinkingBudget": 0
  }
}
```

**预设设计技巧：**
- 技术分析用低温度（0.1-0.3）+ GPT-4 Vision
- 创意文案用高温度（0.8-1.0）+ Claude Opus
- 平衡场景用中等温度（0.5-0.7）+ 任意模型

## 实际应用场景

### 场景 1: 代码审查助手

**用户需求**: 审查多个代码截图

**系统提示词设置**:
```
你是一位资深代码审查专家。请根据以下截图进行代码审查：

{{OverBase64::code_analysis::screenshots}}

请提供：
1. 代码质量评估
2. 潜在问题识别
3. 优化建议
```

**工作流程**:
1. 将代码截图保存到 `~/Desktop/Screenshots/` 目录
2. AI 自动处理所有截图
3. 每个截图都会用 `code_analysis` 预设分析
4. AI 基于所有分析结果给出综合审查报告

### 场景 2: UI/UX 设计评审

**用户需求**: 对设计稿进行多维度评审

**系统提示词设置**:
```
你是一位 UI/UX 设计师。以下是本次评审的设计稿：

{{OverBase64::ui_review;technical::project/designs/homepage.png}}

请从用户体验和技术实现两个角度给出评审意见。
```

**说明**:
- 使用两个预设组合：`ui_review` 和 `technical`
- 一次调用获得两个维度的分析
- 可以添加 `::cache` 在迭代设计时复用之前的分析

### 场景 3: 批量图片说明生成

**用户需求**: 为产品目录生成图片说明

**用户消息**:
```
请为以下产品图片生成商品描述：

{{OverBase64::detailed::project/products::cache}}

要求：
- 突出产品特点
- 包含颜色、材质、设计风格
- 适合电商平台使用
```

**优势**:
- 批量处理整个文件夹
- 使用缓存避免重复处理相同图片
- AI 基于详细描述生成商品文案

### 场景 4: 多模态内容分析

**用户需求**: 分析项目中的各类媒体素材

**系统提示词设置**:
```
项目概况分析：

参考图片（简要概括）：
{{OverBase64::summary::project/references}}

设计稿（详细分析）：
{{OverBase64::detailed::project/designs/final.psd.png::cache}}

参考视频（技术分析）：
{{OverBase64::technical::project/videos/demo.mp4}}

请基于以上内容给出项目分析报告。
```

**特点**:
- 混合使用不同预设
- 针对不同类型的内容使用不同的分析深度
- 关键设计稿使用缓存提高效率

### 场景 5: 学习笔记助手

**用户需求**: 整理课程截图生成学习笔记

**用户消息**:
```
我上课记录了这些重要内容的截图，请帮我整理成学习笔记：

{{OverBase64::detailed;summary::downloads/class_notes}}

要求：
1. 提取关键概念（使用 summary 预设识别）
2. 详细说明（使用 detailed 预设展开）
3. 按逻辑顺序组织
```

### 场景 6: 社交媒体内容创作

**用户需求**: 基于照片生成社交媒体文案

**用户消息**:
```
请为这张照片写一段适合 Instagram 的文案：

{{OverBase64::emotional;detailed::images/vacation/sunset.jpg::cache}}

要求：
- 充满情感（emotional 预设）
- 描述生动（detailed 预设）
- 包含相关话题标签建议
```

## 高级用法

### 技巧 1: 预设链式组合

不同预设组合产生不同效果：

```
# 先总结后详述
{{OverBase64::summary;detailed::path}}

# 技术+艺术双重视角
{{OverBase64::technical;emotional::path}}

# 三重分析（简要、详细、技术）
{{OverBase64::summary;detailed;technical::path}}
```

### 技巧 2: 缓存策略

```
# 第一次分析（不使用缓存）
{{OverBase64::detailed::project/design.png}}

# 后续引用（使用缓存）
{{OverBase64::detailed::project/design.png::cache}}

# 文件夹缓存（批量处理后复用）
{{OverBase64::summary::project/screenshots::cache}}
```

### 技巧 3: 路径组织

建议的目录结构：

```
~/Pictures/
  ├── work/
  │   ├── designs/
  │   ├── screenshots/
  │   └── references/
  └── personal/
      ├── photos/
      └── memes/
```

对应的别名配置：

```json
{
  "work": "/Users/you/Pictures/work",
  "designs": "/Users/you/Pictures/work/designs",
  "personal": "/Users/you/Pictures/personal"
}
```

### 技巧 4: 与其他功能配合

结合 VCP 的其他功能：

```
# 结合 VCPTavern 动态注入
系统提示词中使用 {{VCPTavern::analysis_mode}}
然后使用 {{OverBase64::...}}

# 结合任务调度
AI 可以分析后自动创建定时任务提醒用户

# 结合 Agent 协作
不同 Agent 使用不同预设分析同一素材
```

## 性能优化建议

### 1. 合理使用缓存

```
开发阶段：不用 cache，随时获取最新结果
测试阶段：不用 cache，验证不同场景
生产阶段：使用 cache，节省成本和时间
迭代修改：文件变化后自动更新缓存
```

### 2. 控制并发数量

在 `config.env` 中设置：

```env
# 少量大文件
MultiModalModelAsynchronousLimit=1

# 大量小文件
MultiModalModelAsynchronousLimit=5

# 平衡设置
MultiModalModelAsynchronousLimit=3
```

### 3. 预设参数优化

```json
{
  "quick_scan": {
    "prompt": "一句话概括",
    "maxTokens": 100  // 快速但粗略
  },
  "deep_analysis": {
    "prompt": "详细分析所有细节",
    "maxTokens": 3000  // 慢但详尽
  }
}
```

## 故障排查示例

### 问题：路径找不到

```
错误信息: [错误: 未找到媒体文件]

排查步骤:
1. 检查路径是否正确
   {{OverBase64::test::/absolute/path/to/file.jpg}}

2. 检查别名配置
   打开 path-aliases.json 确认别名映射

3. 使用绝对路径测试
   {{OverBase64::test::/Users/you/Pictures/test.jpg}}

4. 查看插件日志（开启 DebugMode）
```

### 问题：API 调用失败

```
错误信息: [preset] 错误: API 调用失败

排查步骤:
1. 检查 API 配置（config.env）
2. 验证 API_Key 是否正确
3. 确认模型名称是否支持多模态
4. 检查网络连接
5. 查看详细错误日志
```

### 问题：缓存未生效

```
现象：每次都重新调用 API

排查步骤:
1. 确认使用了 ::cache 语法
2. 检查 multimedia_cache.json 是否存在
3. 验证文件内容是否改变
4. 清空缓存后重新测试
```

## 最佳实践

1. **预设命名规范**: 使用描述性名称，如 `code_review` 而不是 `preset1`
2. **路径别名组织**: 按项目或用途分类别名
3. **缓存管理**: 定期清理不再需要的缓存项
4. **批量处理**: 优先使用文件夹路径而非逐个文件
5. **预设组合**: 最多使用 3 个预设，避免结果过于冗长
6. **错误处理**: 在系统提示词中告知 AI 如何处理错误结果

## 与 ImageProcessor 对比

| 使用场景 | 推荐插件 | 原因 |
|---------|---------|------|
| 自动处理所有图片 | ImageProcessor | 无需额外语法 |
| 需要特定分析角度 | MultimediaProcessor | 支持自定义预设 |
| 批量处理文件夹 | MultimediaProcessor | 直接支持 |
| 简单图片识别 | ImageProcessor | 开箱即用 |
| 多维度分析 | MultimediaProcessor | 预设组合 |
| 控制缓存策略 | MultimediaProcessor | 显式缓存控制 |

## 总结

MultimediaProcessor 提供了比 ImageProcessor 更强大和灵活的多媒体处理能力，特别适合需要：
- 自定义分析角度的场景
- 批量处理大量文件的需求
- 多维度组合分析的应用
- 精确控制缓存的场合

合理使用预设、路径别名和缓存策略，可以大大提升工作效率和降低 API 使用成本。