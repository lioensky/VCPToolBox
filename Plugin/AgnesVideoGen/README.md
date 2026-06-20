# AgnesVideoGen - Agnes AI 视频生成插件

调用 [Agnes Video V2.0 API](https://apihub.agnes-ai.com) 生成视频。两步命令模式：`submit` 提交任务（秒级返回 task_id），`query` 查询结果（完成后返回视频链接）。支持文生视频、图生视频、多图视频、关键帧动画，以及多段视频拼接。

## 功能

| 模式 | 触发条件 | 用途 |
|------|---------|------|
| 文生视频 | 不提供图片 | 纯文字描述生成视频 |
| 图生视频 | 提供 `image`（单张 URL） | 将静态图片动起来 |
| 多图视频 | 提供 `images`（多张 URL 数组） | 多图融合生成视频 |
| 关键帧动画 | 提供 `images` + `mode: keyframes` | 关键帧之间自动补间动画 |
| 视频拼接 | `concat` 命令 | 将多段视频合并为一个长视频 |

单次生成最长约 18 秒（441 帧 @ 24fps），更长视频可分段生成后用 `concat` 合并。

## 配置

`config.env`（复制 `config.env.example` 修改）：

```env
# Agnes API 密钥（必填）
# 获取地址：https://apihub.agnes-ai.com
AGNES_VIDEO_API_KEY=your_api_key_here

# 可选：视频生成模型（默认 agnes-video-v2.0）
AGNES_VIDEO_MODEL=agnes-video-v2.0

# 可选：默认视频尺寸（默认 1152x768）
AGNES_VIDEO_DEFAULT_WIDTH=1152
AGNES_VIDEO_DEFAULT_HEIGHT=768

# 可选：默认帧数，必须满足 8n+1（默认 121，约 5 秒 @ 24fps）
# 参考：121≈5秒 / 241≈10秒 / 441≈18秒
AGNES_VIDEO_DEFAULT_NUM_FRAMES=121

# 可选：默认帧率（默认 24fps）
AGNES_VIDEO_DEFAULT_FRAME_RATE=24

# 可选：视频链接使用公网地址（true）还是内网地址（false，默认）
USE_PUBLIC_URL=false

# 可选：调试模式（默认 false）
DebugMode=false
```

## 使用示例

### 第一步：提交任务

**文生视频：**

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AgnesVideoGen「末」,
command:「始」submit「末」,
prompt:「始」A cyberpunk cat walking through neon-lit rainy streets, slow cinematic tracking shot, dramatic lighting「末」,
num_frames:「始」121「末」,
frame_rate:「始」24「末」
<<<[END_TOOL_REQUEST]>>>
```

**图生视频：**

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AgnesVideoGen「末」,
command:「始」submit「末」,
prompt:「始」The character gently turns their head and smiles, soft natural lighting「末」,
image:「始」https://example.com/portrait.png「末」,
num_frames:「始」121「末」
<<<[END_TOOL_REQUEST]>>>
```

**关键帧动画：**

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AgnesVideoGen「末」,
command:「始」submit「末」,
prompt:「始」Smooth transition between scenes with cinematic motion「末」,
images:「始」["https://example.com/frame1.png", "https://example.com/frame2.png"]「末」,
mode:「始」keyframes「末」,
num_frames:「始」121「末」
<<<[END_TOOL_REQUEST]>>>
```

### 第二步：查询结果

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AgnesVideoGen「末」,
command:「始」query「末」,
task_id:「始」task_YOUR_TASK_ID_HERE「末」
<<<[END_TOOL_REQUEST]>>>
```

状态：`queued` / `in_progress` → 继续等待；`completed` → 视频链接已返回；`failed` → 返回失败原因

### 拼接多段视频（concat）

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AgnesVideoGen「末」,
command:「始」concat「末」,
video_url1:「始」http://host:port/pw=KEY/files/agnesvideogen/clip1.mp4「末」,
video_url2:「始」http://host:port/pw=KEY/files/agnesvideogen/clip2.mp4「末」
<<<[END_TOOL_REQUEST]>>>
```

也支持数组写法：`videos: ["url1", "url2", "url3"]`

## submit 参数说明

| 参数 | 必需 | 说明 |
|------|------|------|
| `prompt` | 是 | 视频内容描述，建议英文。推荐格式：主体+动作+场景+镜头+光线+风格 |
| `image` | 图生视频必需 | 单张图片 URL |
| `images` | 多图/关键帧必需 | 图片 URL 的 JSON 数组 |
| `mode` | 否 | 填 `keyframes` 启用关键帧动画 |
| `num_frames` | 否 | 帧数，必须满足 `8n+1` 且 ≤441 |
| `frame_rate` | 否 | 帧率，默认 24 |
| `width` / `height` | 否 | 视频尺寸，默认 1152×768 |
| `negative_prompt` | 否 | 不想出现的内容 |
| `seed` | 否 | 固定随机种子以复现结果 |

## 依赖

- Node.js >= 16（ESM 模块，.mjs 格式）
- ffmpeg（`concat` 命令需要，用于视频合并重编码）
- 无 npm 额外依赖
