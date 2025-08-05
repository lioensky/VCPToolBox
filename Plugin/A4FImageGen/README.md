# A4F 图像生成 MCP 服务器

这是一个基于 Model Context Protocol (MCP) 的服务器，允许 AI 通过 MCP 协议使用 A4F.co 提供的模型（例如 Qwen-Image, Imagen-4) 进行图像生成。

此 MCP 工具暂未独立发布，仅作为 VCPToolBox 的一个插件被包含。

## 功能特点

- 允许 AI 助手通过 MCP 协议调用 A4F 的图像生成模型生成高质量图像。
- 支持多种模型和对应的分辨率。
- 可自定义生成参数。

## 系统要求

- Node.js v18.0.0 或更高版本

## 配置说明

### API密钥配置

在使用前，您需要：

1. 在插件目录下创建或编辑 `config.env` 文件 (`Plugin/A4FImageGen/config.env`)。
2. 添加您的 A4F URL 和 API Key：

```
a4furl=https://api.a4f.co
a4fkey=YOUR_A4F_API_KEY
```

> **注意**：请将 `YOUR_A4F_API_KEY` 替换为您的真实 A4F API 密钥。

## 使用方法

配置完成后，AI 助手可以通过 MCP 协议调用此服务生成图像。服务提供了 `A4FQwenGenerateImage` 和 `A4FImagenGenerateImage` 两个工具 (在 `plugin-manifest.json` 中定义)。