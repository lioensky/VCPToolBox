[根目录](../../../CLAUDE.md) > [Plugin](../) > **ImageProcessor**

# ImageProcessor 插件

## 面包屑导航
[根目录](../../../CLAUDE.md) > [Plugin](../) > **ImageProcessor**

## 模块职责

ImageProcessor（图像信息提取器）是一个消息预处理器插件，专门用于分析用户输入中的图像内容。它能够识别图片中的文字、物体、场景等信息，并将这些信息转换为文本描述，然后替换原始消息中的图像，使AI能够理解和处理图像内容。

## 入口与启动

- **入口文件**: `image-processor.js`
- **启动命令**: 自动作为消息预处理器加载
- **插件类型**: 消息预处理器
- **通信协议**: stdio
- **处理流程**: 在AI处理消息前自动执行

## 对外接口

### 处理命令
- **图像识别**: 自动检测并处理消息中的图像
- **图像缓存**: 通过base64键管理图像缓存
- **图像重识别**: 支持通过缓存键重新识别已处理图像

## 关键依赖与配置

### 配置文件
- **插件清单**: `plugin-manifest.json`
- **配置文件**: `config.env.example` (需要复制为`config.env`并填写实际值)

### 依赖项
- Node.js 环境
- 图像处理相关npm包

### 配置项
通常需要配置AI模型API相关参数，用于图像识别：
```env
API_Key=YOUR_API_KEY_SUCH_AS_sk-xxxxxxxxxxxxxxxxxxxxxxxx
API_URL=NEWAPI_URL_SUCH_AS_http://127.0.0.1:3000
MultiModalModel=gemini-2.5-flash
```

## 数据模型

### 图像缓存系统
- **image_cache.json**: 存储图像识别结果的缓存文件
  - 键: 图像的base64编码
  - 值: 图像识别的文本描述

### 处理流程
1. 检测消息中的图像
2. 将图像转换为base64编码
3. 查询缓存，如未处理则调用AI模型识别
4. 将识别结果存储到缓存
5. 用文本描述替换原始消息中的图像

## 测试与质量

### 测试/工具文件
- `reidentify_image.js`: 图像重识别工具
- `purge_old_cache.js`: 清理旧缓存的工具脚本
- `image_cache_editor.html`: 图像缓存可视化编辑器

### 质量工具
- 支持缓存清理和管理
- 可视化缓存编辑器

## 常见问题 (FAQ)

1. **如何处理图像识别失败？**
   - 检查API_Key和API_URL配置是否正确
   - 确认MultiModalModel是否支持图像识别
   - 查看服务器日志获取详细错误信息

2. **图像缓存占用空间过大怎么办？**
   - 使用purge_old_cache.js清理旧缓存
   - 定期清理image_cache.json文件

3. **如何手动重新识别图像？**
   - 使用reidentify_image.js工具
   - 通过AdminPanel的图像缓存编辑器

4. **支持哪些图像格式？**
   - 支持常见的Web图像格式（JPEG、PNG、GIF等）

## 相关文件清单

```
Plugin/ImageProcessor/
├── image-processor.js          # 主入口文件
├── plugin-manifest.json       # 插件清单
├── config.env.example         # 配置文件模板
├── image_cache.json           # 图像识别结果缓存
├── reidentify_image.js        # 图像重识别工具
├── purge_old_cache.js         # 缓存清理工具
├── image_cache_editor.html    # 缓存可视化编辑器
└── README.md                  # 插件说明
```

## 变更记录 (Changelog)

### 2025-09-30 20:07:41 - AI上下文初始化
- 创建ImageProcessor插件文档
- 添加导航面包屑
- 完善插件功能和配置说明