# NovelAI 图片生成 VCP 插件

这是一个基于 VCP (Virtual Character Plugin) 架构的 NovelAI 图片生成插件，允许 AI 通过 VCP 协议调用 NovelAI API 生成高质量的动漫风格图片。

## 功能特点

- **高质量图片生成**：使用固定的 NAI Diffusion 4.5 Curated 模型生成高质量动漫风格图片
- **极简使用**：只需提供提示词，其他参数自动使用官方推荐的最佳配置
- **官方优化**：所有参数均使用 NovelAI 官方推荐的最佳默认设置，确保稳定性和最优效果
- **ZIP 文件处理**：自动解压 NovelAI 返回的 ZIP 格式图片包
- **本地缓存**：生成的图片保存到本地并提供访问链接
- **调试支持**：可选的调试模式，提供详细执行日志

## 系统要求

- Node.js v18.0.0 或更高版本
- VCP 工具箱环境

您可以通过以下命令验证Node.js安装：

```bash
node --version  # 应显示v18.0.0或更高版本
```

## 安装步骤

1. 确保插件文件位于 VCP 工具箱的 `Plugin/NovelAIGen/` 目录中

2. 安装依赖：

```bash
cd Plugin/NovelAIGen
npm install
```

## 配置说明

### API密钥配置

1. 在 NovelAI 网站 (https://novelai.net/) 注册账户并获取 API 密钥
2. 在项目根目录的 `.env` 文件中添加您的 NovelAI API 密钥：

```
NOVELAI_API_KEY=pst-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

> **注意**：您需要自备 NovelAI 的 API 密钥才能使用此服务。NovelAI 使用订阅制，不同订阅等级有不同的使用限制。

### 可选配置

在 `.env` 文件中可以添加以下可选配置：

```
# 调试模式（可选，默认false）
DebugMode=false
```

## 使用方法

### 作为 VCP 插件使用

在系统提示词中添加：`{{VCPNovelAIGen}}`

### 固定配置

为了确保最佳生成效果和稳定性，插件使用以下固定的官方推荐配置：

- **模型**: NAI Diffusion 4.5 Curated
- **尺寸**: 832x1216 (适合人物画像的纵向比例)
- **生成步数**: 28 (质量与速度的最佳平衡)
- **引导系数**: 5.0 (适中的提示词遵循度)
- **采样器**: k_euler (官方推荐)
- **随机种子**: 每次生成随机
- **生成数量**: 1张图片

### 参数说明

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| prompt | string | 是 | 图片生成提示词，支持中英文，推荐使用标签格式如"1girl, blue eyes, long hair" |

### 使用示例

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」NovelAIGen「末」,
prompt:「始」1girl, beautiful anime girl, blue eyes, long blonde hair, school uniform, cherry blossoms, spring, masterpiece, best quality「末」
<<<[END_TOOL_REQUEST]>>>
```

## 技术细节

### 官方推荐配置

本插件采用 NovelAI 官方推荐的最佳默认配置：

```json
{
  "model": "nai-diffusion-4-5-curated-preview",
  "width": 832,
  "height": 1216,
  "scale": 5.0,
  "sampler": "k_euler",
  "steps": 28,
  "n_samples": 1,
  "ucPreset": 0,
  "qualityToggle": true
}
```

这些配置经过 NovelAI 官方测试，能够在质量、速度和稳定性之间达到最佳平衡。

### ZIP 文件处理

NovelAI API 返回的是包含图片的 ZIP 文件，本插件会：

1. 接收 ZIP 格式的响应数据
2. 使用 `yauzl` 库解压 ZIP 文件
3. 提取其中的图片文件（支持 PNG、JPG、JPEG、WebP 格式）
4. 将图片保存到本地目录
5. 生成可访问的图片 URL

### 目录结构

生成的图片会保存在以下目录：
```
PROJECT_BASE_PATH/
  image/
    novelaigen/
      [UUID].png
      [UUID].jpg
      ...
```

## 优势

### 为什么选择固定配置？

1. **稳定性**: 避免了参数配置错误导致的生成失败
2. **最优效果**: 使用 NovelAI 官方推荐的最佳参数组合
3. **简化使用**: 用户只需专注于提示词创作，无需关心技术参数
4. **一致性**: 确保每次生成都使用相同的高质量标准

### 适用场景

- 快速原型设计
- 角色概念图生成
- 插画创作辅助
- 内容创作支持

## 故障排除

### 常见问题

1. **API 密钥错误**：确保在 `.env` 文件中正确设置了 `NOVELAI_API_KEY`
2. **网络连接问题**：检查网络连接，NovelAI API 需要稳定的网络连接
3. **ZIP 解压失败**：检查 Node.js 版本是否符合要求
4. **图片保存失败**：确保项目目录有写入权限

### 调试信息

启用调试模式后，插件会在控制台输出详细信息：
- 发送到 API 的请求参数
- 接收到的响应类型
- ZIP 文件解压过程
- 图片保存路径

启用调试模式：
```
DebugMode=true
```

## 许可证

本插件遵循 MIT 许可证。

## 贡献

欢迎提交 Issue 和 Pull Request 来改进这个插件。

## 相关链接

- [NovelAI 官网](https://novelai.net/)
- [VCP 工具箱](https://github.com/lioensky/VCPToolBox)
- [NovelAI API 文档](https://docs.novelai.net/) 