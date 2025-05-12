# SiliconFlow Flux MCP 服务器

这是一个基于Model Context Protocol (MCP)的服务器，允许AI通过MCP协议使用SiliconFlow的Flux模型进行图像生成。

## 功能特点

- 允许AI助手通过MCP协议调用SiliconFlow的Flux模型生成高质量图像
- 支持多种图像分辨率：1024x1024, 960x1280, 768x1024, 720x1440, 720x1280
- 可自定义生成参数，如随机种子等
- 缓存最近的图像生成结果

## 系统要求

- Node.js v18.0.0 或更高版本

您可以通过以下命令验证Node.js安装：

```bash
node --version  # 应显示v18.0.0或更高版本
```

## 安装步骤

1. 克隆仓库：

```bash
git clone 本项目
```

2. 安装依赖：

```bash
npm install
```

3. 构建项目：

```bash
npm run build
```

## 配置说明

### API密钥配置

在使用前，您需要：

1. 在项目根目录创建或编辑`.env`文件
2. 添加您的SiliconFlow API密钥：

```
SILICONFLOW_API_KEY=您的API密钥
```

> **注意**：您需要自备SiliconFlow的API密钥才能使用此服务。

### MCP服务器配置

在您的MCP配置文件中添加以下内容：

```json
{
  "mcpServers": {
    "siliconflow-flux-mcp": {
      "command": "node",
      "args": ["路径/到/siliconflow-flux-mcp-server/build/index.js"],
      "env": {
        "SILICONFLOW_API_KEY": "您的API密钥"
      }
    }
  }
}
```

## 使用方法

配置完成后，AI助手可以通过MCP协议调用此服务生成图像。服务提供了`generate_image`工具，接受以下参数：

- `prompt`：图像生成提示词（建议使用英文以获得最佳效果）
- `resolution`：图像分辨率，支持多种标准尺寸
- `seed`（可选）：随机种子，用于生成可重复的结果

## 开发者工具

您可以使用MCP Inspector工具来测试服务器：

```bash
npm run inspector
```

## 许可证

请参阅项目仓库中的许可证文件。