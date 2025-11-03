[根目录](../../../CLAUDE.md) > [Plugin](../) > **ComfyUIGen**

# ComfyUIGen 插件

## 模块职责

ComfyUIGen 是一个专业的异步图像生成插件，基于 ComfyUI 框架实现高质量的AI图像生成。它支持通过工作流配置文件生成各种风格的图像，并提供丰富的自定义选项。

## 入口与启动

- **入口文件**: `main.py`
- **启动命令**: 通过VCP协议调用 `「始」ComfyUIGen「末」`
- **插件类型**: 异步插件
- **通信协议**: stdio
- **处理方式**: 非阻塞异步执行

## 对外接口

### 主要功能
- **图像生成**: 支持多种风格的AI图像生成
- **工作流管理**: 通过JSON工作流配置生成参数
- **自定义参数**: 支持prompt、negative_prompt、steps、cfg_scale等参数
- **结果返回**: 异步返回生成的图像base64编码

### 调用示例
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」ComfyUIGen「末」,
prompt:「始」a beautiful landscape, anime style「末」,
width:「始」512「末」,
height:「始」512「末」,
steps:「始」20「末」
<<<[END_TOOL_REQUEST]>>>
```

## 关键依赖与配置

### 依赖项
- Python 3.7+
- requests 库
- base64 编码库
- ComfyUI API访问权限

### 配置文件
- **插件清单**: `plugin-manifest.json`
- **配置文件**: `config.env` (需要配置ComfyUI服务地址)

### 配置项
```env
COMFYUI_URL=http://localhost:8188
COMFYUI_API_KEY=your_api_key_if_needed
TIMEOUT=300
```

## 数据模型

### 请求参数结构
- **prompt**: 正向提示词
- **negative_prompt**: 负向提示词
- **width/height**: 图像尺寸
- **steps**: 生成步数
- **cfg_scale**: 配置比例
- **seed**: 随机种子

### 响应结构
- **success**: 执行状态
- **image_data**: base64编码的图像数据
- **metadata**: 生成元数据

## 测试与质量

### 测试建议
1. 测试基本图像生成功能
2. 验证不同参数组合的效果
3. 测试异步执行稳定性
4. 验证错误处理机制

### 性能优化
- 支持批量图像生成
- 异步执行避免阻塞
- 结果缓存机制
- 超时控制

## 常见问题 (FAQ)

1. **ComfyUI连接失败怎么办？**
   - 检查ComfyUI服务是否正常运行
   - 验证COMFYUI_URL配置是否正确
   - 确认网络连接和防火墙设置

2. **图像生成时间过长？**
   - 调整steps参数减少生成时间
   - 检查ComfyUI硬件资源使用情况
   - 考虑使用较小的图像尺寸

3. **生成质量不满意？**
   - 优化prompt描述
   - 调整cfg_scale参数
   - 尝试不同的工作流配置

## 相关文件清单

```
Plugin/ComfyUIGen/
├── main.py                     # 主入口文件
├── plugin-manifest.json        # 插件清单
├── config.env.example          # 配置文件模板
├── workflows/                  # 工作流配置目录
│   ├── default_workflow.json   # 默认工作流
│   └── anime_workflow.json     # 动漫风格工作流
├── examples/                   # 示例配置
└── README.md                   # 插件说明
```

## 变更记录 (Changelog)

### 2025-10-30 20:05:05 - AI上下文初始化
- 创建ComfyUIGen插件文档
- 添加导航面包屑系统
- 完善插件接口和配置说明