# DoubaoGen - 火山引擎图像生成器 (v2.1.0)

## 简介

DoubaoGen 是基于火山引擎（VolcEngine Ark 方舟）API 的 VCP 图像生成插件。在保持原生 Node.js **零第三方依赖**与**智能多 Key 轮询池**特性的基础上，深度吸纳并融合了 `DMXDoubaoGen` 的强健健壮性设计：
- **全面支持订阅计划（Plan）端点**：原生支持火山方舟的套餐计划接口（`/api/plan/v3/images/generations`），支持在 `config.env` 中自定义请求 URL 与新一代模型（如 `doubao-seedream-5.0-lite`）。
- **极强鲁棒性的参数归一化与意图自愈**：全量移植别名容错（Prompt/text/size/image_size 等），支持 `image_1` / `image_2` 等展开式参数，并能根据图片传入数量自动自愈校正生成指令。
- **标准的 OpenAI 多模态返回格式**：严格遵循 `{ type: "text" }` 与按需 `{ type: "image_url" }` 规范，返回预制 HTML 渲染标签（`<img src="..." width="300">`），并提供 `showbase64` 开关按需控制，杜绝上下文爆 Token 隐患。
- **原生多模态与全模式覆盖**：文生图、图生图、多图融合、组图连续生成，以及模型动态发现。

---

## 快速配置

### 1. 配置文件

复制 `config.env.example` 为 `config.env`：

```env
# 火山引擎 API 密钥（支持逗号分隔多个，自动轮询与熔断降级）
VOLCENGINE_API_KEY=your_api_key_here

# 自定义 API 请求地址（核心：走订阅计划链接或第三方反代）
# 订阅套餐端点:
VOLCENGINE_API_URL=https://ark.cn-beijing.volces.com/api/plan/v3/images/generations

# 是否开启订阅计划路径（当未填写 VOLCENGINE_API_URL 时生效）
USE_PLAN_API=true

# 默认模型ID（订阅计划推荐 doubao-seedream-5.0-lite，标准按量如 doubao-seedream-5-0-260128）
SEEDREAM_MODEL_ID=doubao-seedream-5.0-lite

# 默认分辨率（支持 2K, 4K, 1K, adaptive 或 1024x1024 等）
DEFAULT_RESOLUTION=2K

# 输出格式 (png / jpeg)
DEFAULT_OUTPUT_FORMAT=png

# 是否默认添加水印
DEFAULT_WATERMARK=false

# 是否默认向大模型返回 Base64 图片（建议 false，节省 Token 消耗，可用 showbase64: true 单次临时开启）
DEFAULT_SHOW_BASE64=false
```

---

## 工具调用与参数说明

### 1. 核心命令与别名兼容

插件支持 VCP 经典格式与轻量简写，即使大模型弄错指令，系统也会根据图片输入数量自动自愈纠偏：

| 功能 | 常用指令 | 兼容别名 | 意图自愈规则 |
|---|---|---|---|
| **文生图** | `generate` | `DoubaoGenerateImage`, `text2image`, `t2i` | 未传图片时，自动识别为文生图 |
| **图生图** | `edit` | `DoubaoEditImage`, `image2image`, `i2i` | 传入 1 张图片且非文生图时，自动校正为图生图 |
| **多图融合** | `compose` | `DoubaoComposeImage`, `merge`, `fusion` | 传入 2 张及以上图片时，自动校正为多图融合 |
| **组图生成** | `group` | `sequential`, `series`, `DoubaoGroupImage` | 批量生成多张连续图片 |
| **模型查询** | `list_models` | `models` | 实时探测/查询方舟可用图像模型 |

### 2. 核心调用参数

- `prompt`: (必需) 提示词，兼容 `Prompt`, `text`, `description`。
- `resolution`: (可选) 分辨率，默认 `2K`。支持 `'2K'`, `'4K'`, `'1K'`, `'adaptive'`（图生图自适应），或者自定义宽高如 `'1024x1024'`, `'1280x720'`。兼容 `size`, `Size`, `image_size`。
- `model`: (可选) 模型 ID，如 `doubao-seedream-5.0-lite`。
- `output_format`: (可选) 图片格式，如 `png` 或 `jpeg`。
- `image`: (可选) 图片输入，支持三种形式：
  1. 公网可访问的 `https://` 链接；
  2. `data:image/...;base64,...`；
  3. 分布式本地路径 `file:///...`（支持 VCP 分布式远程文件透明拉取）。
  4. 多图融合时支持分列参数：`image_1`, `image_2`... 或 JSON 数组字符串。
- `showbase64`: (可选) 布尔值，设为 `true` 时向 AI 注入 Base64 图片供多模态直接审阅。默认 `false`。
- `watermark`: (可选) 布尔值，是否添加水印。
- `seed`: (可选) 整数种子，用于稳定复现。
- `guidance_scale`: (可选) 提示词引导系数 (0-10)。

---

## 调用示例

### 1. 基础文生图（走 2K 分辨率）
```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」DoubaoGen「末」,
command:「始」generate「末」,
prompt:「始」充满活力的特写编辑肖像，模特眼神犀利，头戴雕塑感帽子，具有Vogue杂志封面的美学风格「末」,
resolution:「始」2K「末」
<<<[END_TOOL_REQUEST]>>>
```

### 2. 图生图（自适应原图比例）
```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」DoubaoGen「末」,
command:「始」edit「末」,
prompt:「始」给这个女孩戴上一副酷炫的墨镜，背景换成黄昏的沙滩「末」,
image:「始」https://example.com/portrait.jpg「末」,
resolution:「始」adaptive「末」
<<<[END_TOOL_REQUEST]>>>
```

### 3. 多图融合（支持 image_1, image_2 规范）
```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」DoubaoGen「末」,
command:「始」compose「末」,
prompt:「始」将第一张图的角色置于第二张图的奇幻森林中「末」,
image_1:「始」https://example.com/character.png「末」,
image_2:「始」file:///h:/VCP/VCPMain/VCPToolBox/image/background.jpg「末」
<<<[END_TOOL_REQUEST]>>>
```

### 4. 组图生成
```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」DoubaoGen「末」,
command:「始」group「末」,
prompt:「始」一只柯基犬在雪地里玩耍的四格连环漫画「末」,
max_images:「始」4「末」
<<<[END_TOOL_REQUEST]>>>
```

---

## 升级亮点说明 (v2.1.0)

1. **官方订阅模式（Plan）全打通**：
   通过 `VOLCENGINE_API_URL` 或 `USE_PLAN_API=true`，可无缝对接火山引擎 `/api/plan/v3/images/generations` 订阅链接，享受 `doubao-seedream-5.0-lite` 的套餐计费红利。
2. **多模态与 Token 优化平衡**：
   返回结构严格遵循 OpenAI 多模态格式。默认返回持久化 URL 与直观的前端渲染 `<img src="..." width="300">` 标签；避免每次生成强制吐出数兆的 Base64 塞满上下文。若需 AI 自检画面，可按需指定 `showbase64: true`。
3. **强大的键值容错与指令自愈**：
   完美继承 DMX 插件的容错能力，无论大模型传入大小写变体、参数名简写或错误的命令，插件均能在底层完成平滑自愈与参数重组。
