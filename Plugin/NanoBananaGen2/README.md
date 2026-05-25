# NanoBananaGen2 — Gemini/NanoBanana 图像生成插件（自定义渠道）

> **Author:** lionsky (更新: infinite-vector)  
> **Version:** 1.1.0  
> **License:** MIT  
> **Runtime:** Node.js ≥ 18

VCPToolBox 同步插件，通过 OpenAI Chat Completions 兼容接口（`/v1/chat/completions`）调用 Gemini/NanoBanana 系列图像生成模型。支持 **文生图**、**图生图** 和 **多图合成** 三种模式。

本版本重点修复原版 NanoBananaGen2 的 manifest / configSchema / 示例工具名不一致问题，并显式开放自定义渠道能力。

---

## 概述

NanoBananaGen2 适用于以下场景：

- 使用 OpenRouter / NewAPI / OneAPI / 反重力 / Gemini 官方兼容层等 `/v1/chat/completions` 兼容渠道调用图像模型
- 在同一渠道内随机轮询多个模型名
- 在多个渠道之间随机轮询，并保持 URL + KEY + 模型池绑定
- 通过 VCP 工具调用完成文生图、图生图、多图合成
- 自动保存图片到本地并通过 ImageServer 返回可访问 URL

---

## ✨ 功能亮点

| 功能 | 说明 |
|------|------|
| **文生图** (`generate`) | 从文字描述生成图片，支持 1K/2K/4K 尺寸选择 |
| **图生图** (`edit`) | 以已有图片为参考，按描述修改 / 转风格 / 增强 |
| **多图合成** (`compose`) | 将多张图片按指令合成新图（如：图1的背景 + 图2的角色） |
| **自定义渠道** | 支持任何兼容 `/v1/chat/completions` 的服务端点 |
| **单渠道多模型轮询** | 一个 URL + 一个 KEY 下配置多个模型名，每次随机选择 |
| **多渠道绑定轮询** | 每个渠道独立绑定 URL + KEY + 多模型池 |
| **四级响应解析** | 自动适配 Markdown 嵌图 / `message.images` / 结构化 content / 裸 data URI |
| **安全过滤绕过** | 内置 `BLOCK_NONE` 安全设置 + prompt 尾部注入 |
| **分布式图床降级** | `file://` 路径本地读取失败时可触发远程获取流程 |
| **ImageServer URL 修复** | 增加多变量名 fallback，避免返回 `pw=undefined` |

---

## 📦 安装

1. 将 `NanoBananaGen2` 文件夹放入 VCPToolBox 的 `Plugin/` 目录
2. 复制 `config.env.example` 为 `config.env`
3. 填入你的 API 地址、密钥和模型名
4. 重启 VCPToolBox 后端

```bash
cd Plugin/NanoBananaGen2
cp config.env.example config.env
# 编辑 config.env 填入你的配置
```

Windows PowerShell:

```powershell
cd Plugin\NanoBananaGen2
Copy-Item config.env.example config.env
notepad config.env
```

---

## ⚙️ 配置项

> **重要：** `API_URL` 请填写到 `/v1` 为止，插件会自动拼接 `/chat/completions`。

正确示例：

```env
API_URL=https://openrouter.ai/api/v1
API_URL=https://your-newapi.example.com/v1
API_URL=https://generativelanguage.googleapis.com/v1beta/openai
API_URL=http://127.0.0.1:3106/v1
```

错误示例：

```env
# 不要填到 /chat/completions
API_URL=https://openrouter.ai/api/v1/chat/completions
```

### 单渠道模式（默认）

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `API_URL` | ✅ | `http://127.0.0.1:3106/v1` | API 地址（填到 `/v1` 为止） |
| `API_KEY` | ❌ | — | API 密钥；不需要鉴权则留空 |
| `NANO_BANANA_MODEL` | ❌ | `hyb-Optimal/antigravity/gemini-3-pro-image` | 模型名称；多个用英文逗号隔开，每次调用随机选一个 |

单渠道示例：

```env
API_URL=https://openrouter.ai/api/v1
API_KEY=sk-or-v1-your-key
NANO_BANANA_MODEL=google/gemini-2.5-flash-image-preview,google/gemini-2.0-flash-image-preview
```

### 多渠道模式（进阶）

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `MULTI_CHANNEL` | ❌ | `false` | 设为 `true` 启用多渠道模式 |
| `API_CHANNELS` | ❌ | — | 渠道列表，格式为 `URL|KEY|MODEL1,MODEL2;URL|KEY|MODEL3` |

`API_CHANNELS` 格式：

```env
URL|KEY|MODEL1,MODEL2;URL|KEY|MODEL3,MODEL4
```

说明：

- 分号 `;` 隔开多个渠道
- 每个渠道内用竖线 `|` 分隔：`URL|KEY|MODEL`
- `MODEL` 支持逗号分隔多个，每次在该渠道内随机选一个
- `KEY` 为空则保留空位：`URL||MODEL`

多渠道示例：

```env
MULTI_CHANNEL=true
API_CHANNELS=https://openrouter.ai/api/v1|sk-or-key|google/gemini-2.5-flash-image-preview,google/gemini-2.0-flash-image-preview;https://antigravity.example.com/v1|ag-key|hyb-Optimal/antigravity/gemini-3-pro-image
```

### 通用配置

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `NanoBananaProxy` | ❌ | — | 代理地址，如 `http://127.0.0.1:7890` |
| `DIST_IMAGE_SERVERS` | ❌ | — | 分布式图床地址，用于 `file://` 路径降级处理 |

---

## 🎨 使用方式

### 文生图

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」NanoBananaGen2「末」,
command:「始」generate「末」,
prompt:「始」A beautiful sunset over mountains with dramatic clouds「末」,
image_size:「始」4K「末」
<<<[END_TOOL_REQUEST]>>>
```

### 图生图（编辑）

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」NanoBananaGen2「末」,
command:「始」edit「末」,
prompt:「始」Add a rainbow in the sky and make the colors more vibrant「末」,
image_url:「始」https://example.com/landscape.jpg「末」,
image_size:「始」2K「末」
<<<[END_TOOL_REQUEST]>>>
```

### 多图合成

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」NanoBananaGen2「末」,
command:「始」compose「末」,
prompt:「始」Use the background from the first image and the character from the second image to create a fantasy scene「末」,
image_url_1:「始」https://example.com/background.jpg「末」,
image_url_2:「始」https://example.com/character.png「末」,
image_size:「始」1K「末」
<<<[END_TOOL_REQUEST]>>>
```

---

## 📌 参数说明

| 参数 | 适用命令 | 必需 | 说明 |
|------|----------|:---:|------|
| `prompt` | 全部 | ✅ | 图像生成 / 编辑 / 合成提示词，建议英文 |
| `image_size` | 全部 | ❌ | 输出尺寸：`1K` / `2K` / `4K` |
| `image_url` | edit | ✅ | 要编辑的图片 URL，支持 http/https/file:// |
| `image_url_1` ~ `image_url_N` | compose | ✅ | 多张参考图片 URL，至少 1 张 |
| `image_base64` | edit | ❌ | base64 data URI，优先级高于 `image_url` |
| `image_base64_1` ~ `image_base64_N` | compose | ❌ | 多图合成时的 base64 data URI |

---

## 🔧 技术架构

```
┌─────────────┐      stdio JSON       ┌───────────────────────┐
│ VCP Server  │ ────────────────────→ │ NanoBananaGen.mjs     │
│ Plugin.js   │ ←── JSON result ───── │ (synchronous plugin)  │
└─────────────┘                       └──────────┬────────────┘
                                                 │
                                  /v1/chat/completions
                                                 │
                                                 ▼
                           ┌───────────────────────────────┐
                           │ OpenAI-compatible relay       │
                           │ OpenRouter / NewAPI / etc.    │
                           └───────────────────────────────┘

图片保存:
  API image data → image/nanobananagen/*.jpeg/png → ImageServer URL
```

### API 协议

- 使用 OpenAI Chat Completions 兼容格式
- 请求端点：`{API_URL}/chat/completions`
- 图片输入：`messages[].content[].image_url`
- 模型名：由配置动态注入到请求体 `model`
- 支持 `image_config.image_size`

### 请求结构示意

```json
{
  "model": "your-image-model",
  "stream": false,
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "prompt..." },
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/jpeg;base64,..."
          }
        }
      ]
    }
  ],
  "image_config": {
    "image_size": "1K"
  }
}
```

### 四级响应解析 Fallback

不同中转站返回图片的格式不统一，插件按以下优先级逐级尝试：

| 级别 | 图像位置 | 典型来源 |
|------|----------|----------|
| 1 | `message.content` 中的 Markdown data URI：`![...](data:image/...)` | 某些中转站 / Vercel |
| 2 | `message.images[0].image_url.url` | OpenRouter / LiteLLM |
| 3 | `message.content` 结构化数组：`[{type:"image_url", image_url:{url:"data:..."}}]` | 部分兼容层 |
| 4 | `message.content` 字符串中的裸 data URI | 其他中转实现 |

### 渠道选择逻辑

```
单渠道模式：
  固定 URL + KEY
  从 NANO_BANANA_MODEL 模型池随机选一个

多渠道模式：
  随机选一个渠道（URL + KEY 绑定）
  从该渠道的模型池随机选一个
```

---

## 📁 文件结构

```
Plugin/NanoBananaGen2/
├── NanoBananaGen.mjs       # 插件主体 (~19KB)
├── plugin-manifest.json    # VCP 插件清单
├── config.env.example      # 配置模板 (复制为 config.env 使用)
└── README.md               # 本文件
```

---

## 🧪 测试记录

### 已通过测试 (v1.1.0, 2026-05-08)

**核心功能 (6项)**:

- ✅ 工具名 `NanoBananaGen2` 正确识别（不再误调 `NanoBananaGenOR`）
- ✅ `generate` 文生图：单渠道模式，1K 尺寸，图片成功生成并返回
- ✅ `generate` 文生图：第二次调用，不同提示词，稳定返回
- ✅ `edit` 图生图：基于已生成图片进行场景编辑，图片成功返回
- ✅ `compose` 多图合成：传入 `image_url_1` / `image_url_2`，图片成功返回
- ✅ ImageServer URL 构建正确（`pw=` 字段不再为 `undefined`）

**配置与请求 (4项)**:

- ✅ 单渠道模式：`API_URL` + `API_KEY` + `NANO_BANANA_MODEL` 正确加载
- ✅ URL 拼接：`{API_URL}/chat/completions` 格式正确
- ✅ `image_size=1K` 参数正常传递
- ✅ 生成图片保存到 `image/nanobananagen/`

**响应解析 (1项)**:

- ✅ 四级 fallback 至少命中一种当前渠道返回格式

### 实测输出样例

| 命令 | 结果 URL |
|------|----------|
| generate | `image/nanobananagen/451945d6-325c-46e0-b943-546dcab9a940.jpeg` |
| edit | `image/nanobananagen/12b08ef0-66fc-426e-a3a2-a15b62a4d298.jpeg` |
| compose | `image/nanobananagen/cdbf90ad-87c8-4b23-9273-18e6e63a782e.jpeg` |

### 待测试

| 测试项 | 说明 | 状态 |
|--------|------|:----:|
| 多渠道模式 | `MULTI_CHANNEL=true` + `API_CHANNELS` | 🔒 缺少多渠道环境 |
| 多模型随机 | 单渠道多模型逗号分隔轮询 | 🔒 需配置多模型名 |
| `image_base64` 输入 | 直接传入 base64 data URI | 🔒 待测 |
| `file://` 路径 | 本地文件读取 + 分布式图床降级 | 🔒 待测 |
| OpenRouter 渠道 | 验证 `message.images` 解析路径 | 🔒 待测 |
| Gemini 官方兼容层 | 验证结构化 content 数组解析 | 🔒 待测 |
| NewAPI 中转站 | 验证 Markdown data URI / 其他返回结构 | 🔒 待测 |
| 无效 `image_size` | 警告日志是否正确输出 | 🔒 待测 |
| API 鉴权失败 | 错误消息是否正确标识为 NanoBananaGen2 | 🔒 待测 |

> 💡 **欢迎社区测试**：如果你有不同的中转站渠道，请测试并反馈响应格式是否能被四级 fallback 正确解析。

---

## 当前限制与注意事项

- 多渠道模式尚未在真实多渠道环境下验证
- 不同中转站的 Gemini/NanoBanana 图像返回格式可能存在差异
- `image_size` 是否生效取决于后端渠道是否支持 `image_config`
- 安全绕过参数不保证所有渠道均接受
- 若某些中转站要求不同的额外字段，后续可根据反馈扩展配置项

---

## ToolBox 折叠配置

可在系统提示词的多媒体工具箱区域添加：

```
## NanoBananaGen2 图像生成插件（自定义渠道）
通过 OpenAI Chat Completions 兼容接口调用 Gemini/NanoBanana 图像模型。支持文生图、图生图、多图合成，支持自定义 API_URL 与多模型轮询。

### 文生图
tool_name:「始」NanoBananaGen2「末」,
command:「始」generate「末」,
prompt:「始」用于图片生成的详细提示词，建议英文。「末」,
image_size:「始」1K / 2K / 4K「末」

### 图生图
tool_name:「始」NanoBananaGen2「末」,
command:「始」edit「末」,
prompt:「始」描述如何修改图片。「末」,
image_url:「始」图片 URL，支持 http/https/file://。「末」,
image_size:「始」1K / 2K / 4K「末」

### 多图合成
tool_name:「始」NanoBananaGen2「末」,
command:「始」compose「末」,
prompt:「始」描述如何合成多张图片。「末」,
image_url_1:「始」第一张图片 URL。「末」,
image_url_2:「始」第二张图片 URL。「末」
```

---

## 📝 更新日志

### v1.1.0 (2026-05-08) — by infinite-vector

- **🔧 修复 manifest**：工具名从错误的 `NanoBananaGenOR` 改为 `NanoBananaGen2`
- **🔧 修复 configSchema**：暴露 `API_URL`、`API_KEY`、`NANO_BANANA_MODEL`、`MULTI_CHANNEL`、`API_CHANNELS`
- **✨ 新增自定义渠道**：`API_URL` 可配置任意 `/v1/chat/completions` 兼容端点
- **✨ 新增多模型随机轮询**：`NANO_BANANA_MODEL` 支持逗号分隔多个模型名
- **✨ 新增多渠道绑定模式**：`MULTI_CHANNEL=true` + `API_CHANNELS` 实现 URL + KEY + 多模型绑定
- **✨ 新增四级响应解析**：覆盖 Markdown / images 数组 / 结构化数组 / 裸 data URI 四种返回格式
- **✨ 新增 config.env.example**：完整配置模板
- **✨ 新增 README.md**：完整使用文档与测试记录
- **🔧 修复 URL 拼接**：统一到 `/v1`，插件只拼 `/chat/completions`
- **🔧 修复日志和错误消息**：全部统一为 `[NanoBananaGen2]`
- **🔧 修复 ImageServer key**：增加多变量名 fallback，避免 `pw=undefined`
- **🔧 提取 `buildCommonPayloadFields()`**：消除三个命令函数的重复代码
- **🔧 增强 `image_size` 校验**：无效值输出 warning 而非静默忽略

### v1.0.0 — by lionsky

- 初始版本，支持 generate / edit / compose
- 入口实现完整，但 manifest 存在复制粘贴污染
- 工具名、configSchema、示例均误指向 `NanoBananaGenOR`

---

## 🤝 贡献

本插件原始版本由 **lionsky** 开发。  
v1.1.0 魔改由 **infinite-vector** 基于源码审计完成。

Bug 修复与功能改进欢迎提交 PR。

## 📄 许可

MIT License