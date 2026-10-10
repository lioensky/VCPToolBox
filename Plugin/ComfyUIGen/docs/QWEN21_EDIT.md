# Qwen Image 2.1 编辑工作流

- `workflow: qwen21edit`：单图编辑，必填 `prompt`、`image`。
- `workflow: qwen21edit2in1`：双图联合编辑，必填 `prompt`、`image`、`image_2`。
- 图片参数支持 HTTP/HTTPS 直链或 ComfyUI input 目录中已上传文件名（可含子目录）。
- URL 由插件宿主下载再通过 `/upload/image` 上传；宿主必须能访问图床及 ComfyUI。
- 不支持 file://、data:、本地绝对路径。每图上限 20 MiB，下载/上传各 30 秒，至多 3 次重定向。
- 支持 PNG/JPEG/GIF/WebP；签名检查不等于完整解码校验，最终由 ComfyUI 解码。
- 内网图床是明确支持的用途；只在受信任的庄园工具环境使用，不作为公开匿名 URL 代理。
- 需要 Node 18+ 的 FormData/Blob（本环境 Node 22）；不新增 npm 依赖。

调用参数示例（JSON，供 stdio 或调用字段转换使用）：

```json
{
  "workflow": "qwen21edit",
  "prompt": "保留人物构图，将背景改为雨夜街道",
  "image": "http://your-image-server/input.png",
  "seed": -1
}
```

```json
{
  "workflow": "qwen21edit2in1",
  "prompt": "使用图1的人物和图2的场景，保持人物身份并统一光照",
  "image": "http://your-image-server/person.png",
  "image_2": "http://your-image-server/scene.png"
}
```

默认模型：
- UNet：qwen_image_2.1_turbo_int8_convrot.safetensors
- CLIP：qwen3vl_8b_int8_convrot.safetensors
- VAE：qwen_image_2.1_vae_bf16.safetensors

默认 steps=8、cfg=1、sampler=euler、scheduler=simple、denoise=1、resolution=0。
这些默认值优先于全局 SD 配置，单次调用 steps/cfg/sampler/scheduler/denoise/resolution 可以覆盖。
编辑指令不拼接全局质量词或 LoRA token；negative_prompt 支持单次传入。
resolution=0 保留原工作流编码器行为；使用其第3输出 latent，不启用原图关闭的 custom_size 分支。width/height/batch_size 不作用于这些模板。
保存用标准 SaveImage 输出 PNG，代替原来的 SaveImageAdvanced PNG 8-bit/sRGB。
双图按图1/图2顺序输入编码器，并非简单横向拼接。

依赖 ComfyUI 提供 TextEncodeQwenImage21、QwenImage21Cache 及所列模型。
编辑模板缺图或执行失败直接报错，不回退为文生图。
上传图保留在 ComfyUI input 目录，本插件不自动删除。

源码目录插件 manifest 当前是 .block，仍保持禁用；需将改动部署至实际运行节点并核对配置后才可调用。
本地测试：`node --test Plugin/ComfyUIGen/qwen-edit.test.js`。
本地模拟测试不代表真实 GPU 推理验收。