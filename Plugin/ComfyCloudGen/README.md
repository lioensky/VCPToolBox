# ☁️ ComfyCloudGen

**Comfy Cloud 云端图像/视频生成器** — VCP 插件

通过 [Comfy Cloud](https://cloud.comfy.org) 云端 GPU 生成图像和视频。数据驱动架构，自动匹配模型生态，支持 895+ 云端模型。

> **免费额度**：400 积分/月（约 200 张图片），无需本地 GPU。

## ✨ 特性

- 🧠 **智能生态匹配** — 传入模型名自动识别生态、匹配最佳参数
- 🎨 **18 种模型生态** — Z-Image / Flux / SDXL / Wan Video / LTX Video / Chroma / HiDream 等
- 🎬 **图像 + 视频** — 5 种 Pipeline 拓扑，覆盖图像和视频生成
- 🔧 **三种工作模式** — auto / template / raw，从零代码到完全控制
- ⚡ **LoRA 动态注入** — 自动插入 LoRA 节点并重连数据流
- 📦 **工作流缓存** — 构建一次，反复使用
- ✅ **COMBO 参数校验** — 自动验证采样器/调度器/CLIP类型合法性

## 📁 文件结构

```
ComfyCloudGen/
├── ComfyCloudGen.js          # 主入口：输入解析、模式判定、调度
├── EcosystemResolver.js      # 模型→生态匹配、参数三层合并
├── PipelineFactory.js         # 5 种 Pipeline 拓扑构建、LoRA 注入
├── ComfyCloudAuth.js          # Firebase refresh_token → JWT 刷新
├── ComfyCloudNetwork.js       # 提交工作流、轮询任务、下载图片
├── CacheManager.js            # 工作流缓存（FIFO 淘汰）
├── setup.js                   # 一键浏览器认证脚本
├── plugin-manifest.json       # VCP 插件清单
├── config.env                 # 认证凭证与代理配置
├── data/
│   ├── ecosystems.json        # 18 个模型生态定义
│   ├── cloud_models.json      # 云端模型列表（按 loader 分类）
│   ├── cloud_node_defs.json   # 节点默认值（参数兜底）
│   └── cloud_workflow_params.json  # COMBO 参数校验表
├── workflows/                 # template 模式的工作流模板
└── cache/                     # 工作流缓存目录
```

## 🚀 快速开始

### 1. 配置代理（国内必需）

复制示例配置文件并填写代理地址：

```bash
cp config.env.example config.env
```

编辑 `config.env`，设置你的 HTTP 代理：

```env
COMFY_PROXY=http://127.0.0.1:7890
```

### 2. 一键认证

**Windows 用户**（推荐）：

```bash
setup.bat
```

**或直接运行**：

```bash
node setup.js
```

脚本会自动打开 Edge 浏览器 → 你完成 Google 登录 → 凭证自动写入 `config.env`。

### 3. 开始生图

在 VCP 中调用即可，最简只需一个 prompt：

```
ComfyCloudGen → GenerateImage
prompt: a beautiful anime girl with pink hair, masterpiece quality
```

默认使用 Z-Image Base 模型（阿里通义），~20 秒出图。

## 📖 三种工作模式

### Auto 模式（默认） ⭐推荐

传入模型名，自动匹配生态和最佳参数。全缺省时默认使用 Z-Image。

```
prompt: cyberpunk city at night, neon lights
```

指定模型：

```
unet: flux1-dev-fp8_e4m3fn.safetensors
prompt: a dreamy watercolor landscape
```

### Template 模式

使用已有的工作流模板文件，可覆盖部分参数。适合复杂工作流微调。

```
workflow: z_image_base
prompt: a beautiful sunset over the ocean
steps: 30
cfg: 5
```

### Raw 模式

传入完整的工作流 JSON 直接提交，不做任何修改。适合从 ComfyUI 编辑器导出的工作流。

```
workflow_json: {"1":{"inputs":{...},"class_type":"CLIPLoader"}, ...}
```

**模式判定优先级**：`raw` > `template` > `auto`

## 🌐 支持的模型生态

### 图像生成

| 生态 | 模型 | Pipeline | 默认参数 | 特点 |
|------|------|----------|----------|------|
| **z_image** | Z-Image (阿里通义) | ucv_auraflow | 25步, cfg=4 | 🏆 最快(~20s)，动漫/写实通用 |
| **flux1** | Flux.1 (BFL) | ucv | 20步, cfg=1 | 创意性强，色彩浓郁 |
| **flux2** | Flux 2 (BFL) | ucv | 20步, cfg=3.5 | Flux 新一代 |
| **qwen_image** | Qwen-Image (阿里) | ucv | 30步, cfg=5 | 支持编辑/分层 |
| **chroma** | Chroma | ucv | 20步, cfg=1 | 轻量高效 |
| **hidream** | HiDream | ucv | 28步, cfg=5 | 高清梦境 |
| **sdxl** | SDXL/Pony/Illustrious | checkpoint | 30步, cfg=7 | 生态最成熟 |
| **sd15** | SD 1.5 | checkpoint | 25步, cfg=7, 512x512 | 经典模型 |
| **longcat** | LongCat Image | ucv | 25步, cfg=4 | — |
| **ovis** | Ovis Image | ucv | 25步, cfg=4 | — |
| **omnigen2** | OmniGen2 | ucv | 30步, cfg=5 | — |
| **newbie** | NewBie Image | ucv | 25步, cfg=4 | — |
| **cosmos** | Cosmos | ucv | 30步, cfg=7 | — |

### 视频生成

| 生态 | 模型 | Pipeline | 默认参数 | 特点 |
|------|------|----------|----------|------|
| **wan_video** | Wan 2.1/2.2 | wan_video | 30步, cfg=6 | 国产视频生成 |
| **hunyuan_video** | HunyuanVideo | wan_video | 30步, cfg=6 | 混元视频 |
| **ltx_video** | LTX Video | ltx_video | 30步, cfg=3 | 快速视频 |
| **mochi** | Mochi Video | ucv | 30步, cfg=4.5 | — |

### 音频

| 生态 | 模型 | Pipeline | 默认参数 | 特点 |
|------|------|----------|----------|------|
| **ace_step** | ACE-Step | checkpoint | 50步, cfg=3 | AI 音乐生成 |

## ⚙️ 完整参数表

| 参数 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `prompt` | string | auto/template | — | 英文正面提示词 |
| `negative_prompt` | string | 否 | `""` | 英文负面提示词 |
| `unet` | string | 否 | `z_image_bf16` | UNet 模型名，触发 auto 模式 |
| `checkpoint` | string | 否 | — | Checkpoint 模型名，触发 auto 模式 |
| `workflow` | string | 否 | — | 模板名称，触发 template 模式 |
| `workflow_json` | string | 否 | — | 完整工作流 JSON，触发 raw 模式 |
| `steps` | number | 否 | 生态默认 | 采样步数 |
| `cfg` | number | 否 | 生态默认 | CFG 引导强度 |
| `sampler` | string | 否 | 生态默认 | 采样器名称 |
| `scheduler` | string | 否 | 生态默认 | 调度器名称 |
| `width` | number | 否 | `1024` | 图像宽度 |
| `height` | number | 否 | `1024` | 图像高度 |
| `seed` | number | 否 | 随机 | 随机种子，-1 为随机 |
| `lora` | string | 否 | — | LoRA 模型文件名 |
| `lora_strength` | number | 否 | `0.8` | LoRA 强度 (0.0-1.0) |
| `weight_dtype` | string | 否 | `default` | UNet 精度 (fp8_e4m3fn 等) |
| `num_frames` | number | 否 | `81` | 视频帧数 |
| `fps` | number | 否 | `16` | 视频帧率 |
| `save_as` | string | 否 | — | 保存工作流到缓存 |
| `load_cached` | string | 否 | — | 从缓存加载工作流 |

## 🏗️ 架构设计

### 数据驱动 + 拓扑硬编码

```
用户传参
    ↓
ComfyCloudGen.js (模式判定)
    ↓ auto模式
EcosystemResolver.js
    ├── cloud_models.json → 判断模型 loader 类型 (unet/checkpoint)
    ├── ecosystems.json → 前缀匹配生态 + variant 继承
    └── 三层参数合并: node_defs默认 < 生态推荐 < 用户传参
    ↓
PipelineFactory.js
    ├── 选择 pipeline 拓扑 (ucv/checkpoint/wan_video/ltx_video)
    ├── 硬编码构建节点 + 连接
    ├── LoRA 动态注入
    └── COMBO 参数校验 (cloud_workflow_params.json)
    ↓
ComfyCloudNetwork.js
    ├── ComfyCloudAuth.js → JWT 刷新
    ├── POST /api/prompt → 提交
    ├── GET /api/jobs → 轮询 (~3s 间隔)
    └── GET /api/view → 下载 (302 重定向到 CDN)
    ↓
图片保存到本地 → 返回 URL
```

### 5 种 Pipeline 拓扑

| Pipeline | 节点链 | 适用生态 |
|----------|--------|----------|
| `ucv` | CLIP→UNet→VAE→KSampler→Decode→Save | Flux, Chroma, HiDream 等 |
| `ucv_auraflow` | ucv + ModelSamplingAuraFlow | Z-Image |
| `checkpoint` | CheckpointLoader→KSampler→Decode→Save | SDXL, SD1.5 |
| `wan_video` | CLIP→UNet→VAE→WanVideoSampler→Decode→SaveWEBP | Wan, HunyuanVideo |
| `ltx_video` | CLIP→UNet→VAE→KSampler→Decode→SaveWEBP | LTX Video |

### 生态匹配流程

1. 从 `cloud_models.json` 查找模型的 loader 类型 (unet/checkpoint)
2. 遍历 `ecosystems.json`，用 `detect` 数组前缀匹配模型文件名
3. variant 优先匹配 → 继承父级参数 → 覆盖差异项
4. 无匹配则走 fallback

## 🔧 添加新生态

在 `data/ecosystems.json` 中添加约 10 行即可：

```json
{
  "id": "my_model",
  "name": "My Custom Model",
  "detect": ["my_model_prefix"],
  "loader": "unet",
  "pipeline": "ucv",
  "clip": "some_clip.safetensors",
  "clip_type": "sd3",
  "vae": "ae.safetensors",
  "defaults": {
    "steps": 20, "cfg": 4,
    "sampler_name": "euler", "scheduler": "simple"
  }
}
```

## 📋 工作流缓存

```
# 生成并缓存
prompt: a beautiful scene
save_as: my_preset

# 复用缓存（换 prompt 即可）
load_cached: my_preset
prompt: a different scene
```

缓存存放在 `cache/` 目录，FIFO 淘汰（默认上限 10 个）。

## 🔐 认证原理

Comfy Cloud 使用 Firebase Authentication (Google OAuth)：

1. `setup.js` 启动真实 Edge 浏览器
2. 用户在浏览器中完成 Google 登录
3. 脚本从 `localStorage` 提取 `refreshToken` 和 `apiKey`
4. 写入 `config.env`

运行时 `ComfyCloudAuth.js` 用 `refresh_token` 调用 Google `securetoken.googleapis.com` 刷新短期 JWT，JWT 缓存在内存中提前 60 秒续期。

## ⚠️ 注意事项

- **代理必需**：国内无法直连 Google 和 Comfy Cloud，必须配置 `COMFY_PROXY`
- **免费额度**：400 积分/月，图像约 2 积分/张，视频更多
- **API 格式**：raw 模式只支持 ComfyUI API 格式（节点 ID 为 key），不支持编辑器格式
- **英文 Prompt**：所有模型对英文效果最佳

## 📊 性能参考

| 生态 | 典型耗时 |
|------|----------|
| Z-Image | ~20s |
| Flux.1 | ~32s |
| SDXL | ~32s |
| Wan Video (81帧) | ~120s |

