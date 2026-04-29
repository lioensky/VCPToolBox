# GPTImageGen — GPT Image 2 图像生成插件

> **Author:** 小飒 (Xiaosa) & infinite-vector  
> **Version:** 1.1.0  
> **License:** MIT  
> **Runtime:** Node.js ≥ 18（零外部依赖）

VCPToolBox 同步插件，通过 OpenAI 兼容 API 调用 `gpt-image-2` 模型，支持 **文生图** 和 **图生图（垫图/风格转换）** 两种模式。

---

## ✨ 功能亮点

| 功能                            | 说明                                                         |
| ------------------------------- | ------------------------------------------------------------ |
| **文生图** (`GPTGenerateImage`) | 从文字描述生成高质量图片，支持自定义分辨率（最高 4K 3840px）、质量、背景模式、批量生成 |
| **图生图** (`GPTEditImage`)     | 以已有图片为参考，按描述修改/转风格/增强。支持 URL、base64、本地路径输入，可传入多张参考图（最多 16 张） |
| 零依赖                          | 仅使用 Node.js 原生模块（http/https/fs/path/crypto），无需 npm install |
| 自动保存                        | 生成的图片自动保存到 `image/gptimagegen/` 目录，并返回可访问的 HTTP URL |
| 兼容反代                        | 支持 OpenAI 官方 API 及任意兼容反代（CPA 等）                |
| 自动重试                        | 内置 429/503 指数退避重试机制，应对 API 限流                 |

---

## 📦 安装

1. 将 `GPTImageGen` 文件夹放入 VCPToolBox 的 `Plugin/` 目录
2. 复制 `config.env.example` 为 `config.env`，填入 API 密钥和反代地址
3. 重启 VCPToolBox 或等待插件热重载

```bash
cd Plugin/GPTImageGen
cp config.env.example config.env
# 编辑 config.env 填入你的配置
```

---

## ⚙️ 配置项

| 变量                      | 必需 | 默认值                   | 说明                                                         |
| ------------------------- | ---- | ------------------------ | ------------------------------------------------------------ |
| `OPENAI_API_KEY`          | ✅    | —                        | OpenAI 兼容 API 密钥                                         |
| `OPENAI_BASE_URL`         | ✅    | `https://api.openai.com` | API 基础地址（官方或反代）                                   |
| `GPT_IMAGE_MODEL`         | ❌    | `gpt-image-2`            | 模型名称，支持版本快照如 `gpt-image-2-2026-04-21`            |
| `DEFAULT_SIZE`            | ❌    | `1024x1024`              | 默认尺寸（WIDTHxHEIGHT），支持纯数字简写如 `1024`            |
| `DEFAULT_QUALITY`         | ❌    | `auto`                   | 默认质量：`low`（快速低成本）/ `medium` / `high`（精细高成本）/ `auto` |
| `DEFAULT_RESPONSE_FORMAT` | ❌    | `b64_json`               | 返回格式：`b64_json`（推荐，无过期）/ `url`（60分钟内有效）  |
| `DEFAULT_BACKGROUND`      | ❌    | `auto`                   | 默认背景：`opaque` / `auto`（见下方注意事项）                |
| `MAX_RETRIES`             | ❌    | `2`                      | API 请求失败（429/503）时的最大重试次数                      |
| `RETRY_BASE_DELAY_MS`     | ❌    | `2000`                   | 重试基础延迟（毫秒），按指数退避递增                         |
| `DebugMode`               | ❌    | `false`                  | 调试模式，开启后在 stderr 输出详细日志                       |

> ⚠️ **关于 `transparent` 背景**：gpt-image-2 官方 API 目前不支持透明背景（`transparent`），参数验证中保留该选项以兼容部分反代实现，但实际效果取决于您的 API 端点。如需透明背景，建议使用 GPT Image 1.5 或后期处理。

---

## 🎨 使用方式

### 文生图

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」GPTImageGen「末」,
command:「始」GPTGenerateImage「末」,
prompt:「始」A cute cat wearing a tiny astronaut helmet, floating in space with stars and nebula in the background, digital art style「末」,
size:「始」1024x1024「末」,
quality:「始」high「末」
<<<[END_TOOL_REQUEST]>>>
```

### 图生图（垫图/风格转换）

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」GPTImageGen「末」,
command:「始」GPTEditImage「末」,
prompt:「始」Transform this photo into a Studio Ghibli anime style illustration with soft watercolor textures「末」,
image:「始」http://example.com/photo.png「末」,
size:「始」1536x1024「末」,
quality:「始」high「末」
<<<[END_TOOL_REQUEST]>>>
```

### 参数说明

**文生图参数：**
- `prompt`（必需）：图像生成提示词，建议英文。不支持负面提示词参数，可在 prompt 中用 "Avoid: ..." 模拟
- `size`（可选）：WIDTHxHEIGHT，最短边≥256，最长边≤3840。也支持纯数字简写（如 `1024` 自动转为 `1024x1024`）
- `quality`（可选）：low（快速低成本）/ medium / high（精细高成本）/ auto
- `background`（可选）：opaque / auto
- `n`（可选）：生成数量 1-4

**图生图参数：**
- `prompt`（必需）：描述如何修改图片
- `image`（必需）：原始图片来源（**单张≤4MB**），支持：
  - HTTP/HTTPS URL
  - base64 data URI（`data:image/png;base64,...`）
  - 本地文件路径（相对于项目根目录，如 `image/gptimagegen/xxx.png`）
  - 图片数组（可同时传入多张，最多 16 张）
- `size`（可选）：输出尺寸
- `quality`（可选）：图片质量

### 常用尺寸参考

| 尺寸        | 说明            |
| ----------- | --------------- |
| `1024x1024` | 1K 正方形       |
| `1536x1024` | 横版            |
| `1024x1536` | 竖版            |
| `2048x2048` | 2K              |
| `3840x2160` | 4K 横版（Beta） |
| `2160x3840` | 4K 竖版（Beta） |

> 💡 4K 分辨率（3840px）目前为 OpenAI Beta 特性，生产环境建议使用 2K。

---

## 🔧 技术细节

- **文生图** 使用 `/v1/images/generations` 端点，JSON 格式请求
- **图生图** 使用 `/v1/images/edits` 端点，**multipart/form-data 格式请求**（OpenAI 要求，零依赖手动构建 multipart body）
- 图片根据 API 返回的 Content-Type 自动推断格式（PNG/JPEG/WebP/GIF），保存到 `image/gptimagegen/` 目录
- 通过 VCP 的 ImageServer 插件提供 HTTP 访问 URL
- 支持图片 URL 自动下载、base64 解码、本地文件读取三种输入方式
- gpt-image-2 无需手动遮罩，通过文本指令即可引导区域编辑
- 建议生产环境使用模型版本快照（如 `gpt-image-2-2026-04-21`）锁定行为一致性

---

## 📝 更新日志

### v1.0.2 (2026-04-29) — by infinite-vector
- **🔒 安全性**：修复源码中 `OPENAI_BASE_URL` 默认值硬编码为开发用反代地址的问题
- **🔄 自动重试**：新增 `httpRequestWithRetry()` 包装器，对 429/503 自动指数退避重试（可配置 `MAX_RETRIES` / `RETRY_BASE_DELAY_MS`）
- **✅ 输入校验**：图生图输入图片新增 4MB 大小校验，支持 data URI / URL / 本地文件三种来源
- **✅ Size 兼容**：纯数字 size 参数自动转为正方形（如 `1024` → `1024x1024`）
- **🎨 扩展名推断**：`downloadImage()` 返回 Content-Type，`saveImageToLocal()` 据此推断文件扩展名，不再硬编码 .png
- **📝 Manifest 完善**：更新 configSchema 为带描述的对象格式，补充 quality 档位、transparent 限制、4MB 限制等说明

### v1.0.1 (2025-04-25) — by 小飒
- **🐛 修复图生图功能**：`callEditAPI()` 从错误的 `application/json` 格式改为 OpenAI 要求的 `multipart/form-data` 格式
- **✨ 新增 `buildMultipartBody()`**：零依赖的 multipart/form-data 请求体构建器
- **✨ 新增 `parseDataURI()`**：data URI → Buffer + MIME 类型解析器
- 图片以二进制文件字段 `image[]` 上传，支持多图
- 文生图功能不受影响

### v1.0.0
- 初始版本，支持文生图（GPTGenerateImage）
- 图生图功能因 API 请求格式错误无法使用

---

## 🤝 贡献

本插件由 **小飒 (Xiaosa)** 开发，**infinite-vector** 进行鲁棒性增强与文档完善。  
Bug 修复与功能改进欢迎提交 PR。

## 📄 许可

MIT License
