# 火山方舟 Doubao Seedream 3.0 MCP 服务器

这是一个基于 Model Context Protocol (MCP) 的服务器，允许 AI 通过 MCP 协议使用火山方舟的 Doubao Seedream 3.0 模型进行图像生成。

此 MCP 工具暂未独立发布，仅作为 VCPToolBox 的一个插件被包含。

## 功能特点

- 允许 AI 助手通过 MCP 协议调用火山方舟的 Doubao Seedream 3.0 模型生成高质量图像
- 支持多种图像分辨率：1024x1024，864x1152，1152x864，1280x720，720x1280，832x1248，1248x832，1512x648
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

1. 在项目根目录创建或编辑 `.env` 文件
2. 添加您的火山方舟 API 密钥：

```
VOLCENGINE_API_KEY=您的API密钥
```

> **注意**：您需要自备火山方舟的 API 密钥才能使用此服务。另外，不同于其他平台，火山方舟中的模型需要激活才能使用。

### 公网与局域网配置切换

此插件默认为环境为局域网环境。若需要在公网使用，请在 `DoubaoGen.js` 中定位到 `accessibleImageUrl` 所在位置，将合成 HTTPS 路径的行的前面的 `// ` 删除，然后在合成 HTTP 路径的行的前面加上 `// `。

### MCP服务器配置

在您的MCP配置文件中添加以下内容：

```json
{
  "mcpServers": {
    "siliconflow-flux-mcp": {
      "command": "node",
      "args": ["路径/到/Doubao-Seedream3-mcp-server/build/index.js"],
      "env": {
        "VOLCENGINE_API_KEY": "您的API密钥"
      }
    }
  }
}
```

## 使用方法

配置完成后，AI 助手可以通过 MCP 协议调用此服务生成图像。服务提供了 `generate_image` 工具，接受以下参数：

- `prompt`：图像生成提示词（建议使用英文以获得最佳效果）
- `resolution`：图像分辨率，支持多种标准尺寸
- `seed`（可选）：随机种子，用于生成可重复的结果

作为 VCPToolBox 插件使用时，根据 VCP 变量命名规则，应在系统提示词中添加：`{{VCPDoubaoGen}}`。

## 开发者工具

您可以使用 MCP Inspector 工具来测试服务器：

```bash
npm run inspector
```

## 许可证

请参阅项目仓库中的许可证文件。