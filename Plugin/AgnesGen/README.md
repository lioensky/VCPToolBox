# AgnesGen - Agnes AI 图像生成插件

调用 [Agnes Image 2.1 Flash](https://apihub.agnes-ai.com) 模型进行文生图和图生图。对高信息密度图像、复杂构图、创意设计和营销素材进行了优化，支持风格迁移、重新打光和背景转换。

## 功能

- **文生图**：纯文字描述生成图片
- **图生图（单图）**：基于参考图像进行风格迁移、局部编辑、背景替换等
- **多图参考/合成**：提供多张参考图，模型进行融合创作
- 支持自定义分辨率、代理配置、base64 返回

## 配置

`config.env`（复制 `config.env.example` 修改）：

```env
# Agnes/Sapiens AI API Bearer Token（必填）
# 获取地址：https://apihub.agnes-ai.com
AGNES_API_KEY=your_agnes_or_sapiens_api_key

# 可选：覆盖 API Endpoint（默认 https://apihub.agnes-ai.com/v1/images/generations）
AGNES_API_ENDPOINT=https://apihub.agnes-ai.com/v1/images/generations

# 可选：覆盖模型名称（默认 agnes-image-2.1-flash）
AGNES_MODEL_ID=agnes-image-2.1-flash

# 可选：默认输出尺寸（默认 1024x1024）
AGNES_DEFAULT_SIZE=1024x1024

# 可选：网络代理（被墙环境填写，如 http://127.0.0.1:7890）
HTTP_PROXY=

# 可选：图片链接是否使用公网地址（true=VAR_HTTPS_URL，false=VAR_HTTP_URL 局域网）
USE_PUBLIC_URL=false
```

## 使用示例

### 文生图

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AgnesGen「末」,
command:「始」generate「末」,
prompt:「始」A luminous floating city above a misty canyon at sunrise, cinematic realism, wide-angle composition, rich architectural details, soft golden light「末」,
size:「始」1024x768「末」
<<<[END_TOOL_REQUEST]>>>
```

### 图生图（风格迁移）

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AgnesGen「末」,
command:「始」edit「末」,
prompt:「始」Transform the scene into a rain-soaked cyberpunk night with neon reflections while preserving the original composition and main subject layout.「末」,
image:「始」https://example.com/input-image.png「末」,
size:「始」1024x768「末」
<<<[END_TOOL_REQUEST]>>>
```

### 多图参考合成

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AgnesGen「末」,
command:「始」compose「末」,
prompt:「始」Combine the character from image1 with the background scene from image2, maintain lighting consistency.「末」,
image:「始」["https://example.com/char.png", "https://example.com/bg.png"]「末」
<<<[END_TOOL_REQUEST]>>>
```

## 参数说明

| 参数 | 必需 | 说明 |
|------|------|------|
| `command` | 否 | `generate`（文生图）/ `edit`（图生图）/ `compose`（多图合成）；无图时自动文生图 |
| `prompt` | 是 | 图片描述，支持中英文。推荐结构：主体 + 场景 + 风格 + 光照 + 构图 + 质量要求 |
| `size` | 否 | 输出尺寸，也兼容 `resolution`、`image_size`。可选值：`1024x1024`、`1024x768`、`768x1024`、`1536x1024`、`adaptive` |
| `image` | 图生图必需 | 单图 URL / base64 / data URI，或图片 URL 数组（JSON 格式）。也兼容 `image_url`、`image_1`、`image_url_1`、`image_base64_1` 等字段 |
| `showbase64` | 否 | 是否在返回结果中附带 base64 数据（默认 `false`） |

## 提示

- AgnesGen **不支持** `negative_prompt` 专用字段；如需规避内容，直接写入 `prompt`，例如 `"avoid blurry details, distorted hands"`
- 生成完成后，请用 Markdown `![](url)` 或 HTML `<img>` 标签展示图片，不要只描述内容

## 依赖

- Node.js >= 16（ESM 模块，.mjs 格式）
- 无 npm 额外依赖（使用内置 fetch API）
