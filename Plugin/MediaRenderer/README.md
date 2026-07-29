# MediaRenderer

MediaRenderer 使用 VCP 已有的托管 Chrome 运行时和服务器全局 FFmpeg，通过 Puppeteer/CDP 将 AI 编写的 HTML 或 SVG 渲染为静态图片、GIF 或视频。

插件不通过 ChromeBridge 传输源码或截图，而是直接调用根层浏览器运行时，取得 DevTools WebSocket Endpoint 后创建独立浏览器上下文。

## 功能范围

当前版本支持：

- HTML → PNG、JPG、WebP
- SVG → PNG、JPG、WebP
- 宽高各 64-4096 像素
- 最大总像素 4096×4096
- PNG/WebP 透明背景
- JPG 自定义底色
- 最多 16 步串行批量渲染
- 使用现有图片作为底图添加 CSS/SVG/Canvas 特效
- 支持 Data URI、HTTP/HTTPS 和 `file://` 底图
- ImageFileServer 图床 URL
- 可选 Base64 多模态返回
- 除显式底图/素材外的页面外部资源请求阻断
- HTML JavaScript 默认关闭，动画或内置库模式自动开启
- GIF、MP4、WebM 确定性逐帧渲染
- 透明 GIF 与透明 WebM
- 内置 Anime.js 3.2.2、Three.js r160
- 本地、内网和公网图片/音频/字体/模型素材
- MP4/WebM 音频混流

## 运行前提

根配置必须启用托管浏览器：

```env
VCP_BROWSER_RUNTIME_ENABLED=true
```

服务器需具备 Chrome、Chromium 或 Edge。也可以通过根配置显式指定可执行文件：

```env
VCP_BROWSER_EXECUTABLE_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
```

插件复用根项目已经安装的 Puppeteer、Sharp 和 mime-types，不需要在插件目录单独安装依赖。GIF/视频还要求系统 PATH 中存在 FFmpeg；也可以通过 `FfmpegPath` 配置绝对路径。

## 透明图标怎么实现

JPEG 不支持 Alpha 透明通道，因此透明图标必须输出 PNG 或 WebP。

调用时设置：

```text
format: png
transparent: true
```

当 transparent 为 true 且请求 format=jpg 时，插件会自动把格式调整为 PNG，避免透明信息丢失。

透明模式会把 HTML 的根画布设为透明，但不会删除普通元素自己绘制的背景。例如下面的 body 没有背景，只有圆角方块有渐变背景，所以方块以外的区域保持透明：

```html
<!doctype html>
<html>
<head>
<style>
html, body {
    width: 100%;
    height: 100%;
    margin: 0;
}
.stage {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
}
.icon {
    width: 75%;
    height: 75%;
    border-radius: 24%;
    background: linear-gradient(135deg, #7c3aed, #06b6d4);
    box-shadow: 0 18px 48px rgba(76, 29, 149, 0.35);
}
</style>
</head>
<body>
    <div class="stage">
        <div class="icon"></div>
    </div>
</body>
</html>
```

如果 HTML 内有一个铺满画布并带背景色的元素，该元素仍会正常遮住透明画布。这适合壁纸，但不适合要求四周透明的图标。

## 单张图片调用

```text
<<<[TOOL_REQUEST]>>>
maid:「始」Nova「末」,
tool_name:「始」MediaRenderer「末」,
command:「始」RenderImage「末」,
html:「始」<!doctype html><style>html,body{width:100%;height:100%;margin:0}.stage{height:100%;display:grid;place-items:center}.icon{width:72%;height:72%;border-radius:28%;background:linear-gradient(135deg,#8b5cf6,#22d3ee)}</style><div class="stage"><div class="icon"></div></div>「末」,
width:「始」512「末」,
height:「始」512「末」,
format:「始」png「末」,
transparent:「始」true「末」,
fileName:「始」gradient-icon「末」
<<<[END_TOOL_REQUEST]>>>
```

## 基于已有图片添加代码特效

通过 `sourceImage` 传入底图，并在 HTML 或 SVG 源码中使用 `{{SOURCE_IMAGE}}` 占位符。插件会在渲染前把占位符替换为经过验证的素材地址。

`sourceImage` 支持：

- `data:image/...;base64,...`
- HTTP/HTTPS 图片 URL
- `file://` 本地图片
- VCP ImageFileServer 图片 URL

对于 `file://`，插件会在 Node.js 侧读取并验证图片，然后转成 Data URI；Chromium 不会直接获得本地文件访问权限。

下面使用 CSS 给已有图片增加饱和度、霓虹投影、圆角和边框光效：

```text
<<<[TOOL_REQUEST]>>>
maid:「始」Nova「末」,
tool_name:「始」MediaRenderer「末」,
command:「始」RenderImage「末」,
sourceImage:「始」file:///path/to/source.png「末」,
html:「始」<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:#080b16}.stage{position:relative;width:100%;height:100%;display:grid;place-items:center;overflow:hidden}.source{width:78%;height:78%;object-fit:cover;border-radius:12%;filter:saturate(1.35) contrast(1.1) drop-shadow(0 0 28px #22d3eeaa)}.glow{position:absolute;inset:8%;border:4px solid #67e8f9;border-radius:15%;mix-blend-mode:screen;box-shadow:0 0 50px #06b6d4}</style><div class="stage"><img class="source" src="{{SOURCE_IMAGE}}"><div class="glow"></div></div>「末」,
width:「始」1024「末」,
height:「始」1024「末」,
format:「始」png「末」,
fileName:「始」neon-effect「末」
<<<[END_TOOL_REQUEST]>>>
```

可使用的浏览器图像能力包括：

- CSS `filter`
- `mix-blend-mode`
- `mask-image`
- `clip-path`
- 渐变、阴影、边框和文字覆盖层
- SVG filter
- CSS 变换和透视
- Canvas；使用 Canvas 时需显式设置 `allowJavaScript=true`

如果提供了 `sourceImage`，但源码中没有 `{{SOURCE_IMAGE}}`，插件会拒绝请求，避免素材参数被静默忽略。

## 壁纸调用

壁纸通常不需要透明通道，推荐使用 JPG：

```text
<<<[TOOL_REQUEST]>>>
maid:「始」Nova「末」,
tool_name:「始」MediaRenderer「末」,
html:「始」<!doctype html><style>html,body{width:100%;height:100%;margin:0}.wallpaper{width:100%;height:100%;background:radial-gradient(circle at 20% 20%,#38bdf8,transparent 34%),radial-gradient(circle at 80% 70%,#a78bfa,transparent 38%),linear-gradient(135deg,#020617,#312e81)}</style><div class="wallpaper"></div>「末」,
width:「始」3840「末」,
height:「始」2160「末」,
format:「始」jpg「末」,
quality:「始」94「末」,
background:「始」#020617「末」,
fileName:「始」night-wallpaper「末」
<<<[END_TOOL_REQUEST]>>>
```

## 串行批量渲染

数字后缀从 1 开始连续编号：

- command1、html1、sourceImage1、width1、height1
- command2、svg2、sourceImage2、width2、height2
- 依次类推

没有数字后缀的参数是公共默认值。每一步的后缀参数会覆盖公共默认值。公共 `sourceImage` 也可以被所有步骤继承，以便对同一底图连续生成多套不同特效。

下面的 format、transparent、width、height 对所有步骤生效：

```text
<<<[TOOL_REQUEST]>>>
maid:「始」Nova「末」,
tool_name:「始」MediaRenderer「末」,
format:「始」png「末」,
transparent:「始」true「末」,
width:「始」512「末」,
height:「始」512「末」,
command1:「始」RenderImage「末」,
svg1:「始」<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><circle cx="256" cy="256" r="210" fill="#8b5cf6"/></svg>「末」,
fileName1:「始」purple-circle「末」,
command2:「始」RenderImage「末」,
html2:「始」<!doctype html><style>html,body{width:100%;height:100%;margin:0}.stage{height:100%;display:grid;place-items:center}.shape{width:70%;height:70%;background:#22d3ee;clip-path:polygon(50% 0,100% 100%,0 100%)}</style><div class="stage"><div class="shape"></div></div>「末」,
fileName2:「始」cyan-triangle「末」
<<<[END_TOOL_REQUEST]>>>
```

插件会严格按照步骤顺序执行，并在一个结果中返回所有图片 URL。批量上限为 16 张，以避免一次调用长期占用浏览器和内存。

## 参数说明

| 参数 | 必需 | 默认值 | 说明 |
|---|---|---|---|
| html | 二选一 | - | HTML 源码 |
| svg | 二选一 | - | SVG 源码 |
| sourceImage | 否 | - | 底图；支持 Data URI、HTTP/HTTPS、`file://` |
| width | 是 | - | 64-4096 |
| height | 是 | - | 64-4096 |
| format | 否 | 透明时 PNG，否则 JPG | png、jpg、webp、gif、mp4、webm |
| transparent | 否 | false | 保留 Alpha 通道 |
| background | 否 | #ffffff | 非透明输出的 Alpha 合成底色 |
| quality | 否 | 90 | JPG/WebP 质量，1-100 |
| showBase64 | 否 | false | 是否额外返回 Data URI |
| allowJavaScript | 否 | false | 是否运行 HTML 脚本 |
| waitMs | 否 | 0 | 截图前额外等待，最大 10000ms |
| timeoutMs | 否 | 45000 | 单步超时，最大 120000ms |
| fileName | 否 | UUID | 文件名主体 |
| libraries | 否 | - | `anime`、`three` 或逗号分隔组合 |
| assets | 否 | [] | JSON 素材数组，每项包含 id、type、source |
| durationMs | 动画 | 5000 | 动画时长，100-60000ms |
| fps | 动画 | 30 | 每秒帧数，1-60 |
| readyMode | 否 | 动画为 auto | load、auto、signal |
| audioAssetId | 否 | - | 混入 MP4/WebM 的音频素材 id |

## 安全策略

AI 提供的 HTML/SVG 按不可信输入处理：

1. 默认禁用 HTML JavaScript；动画或显式内置库模式自动开启。
2. `sourceImage` 和 `assets` 是外部素材的显式入口。
3. 页面自身的任意 HTTP/HTTPS/file 请求仍被阻断；assets 由 Node.js 获取后转为 Data URI。
4. `file://` 素材由 Node.js 读取，Chromium 不直接访问本地文件系统。
5. 默认允许显式内网素材；可通过 `AllowPrivateNetworkAssets=false` 禁止。
6. 云元数据地址始终禁止，重定向后的每个 URL 都重新校验。
7. 单素材最大 50MB、总素材最大 100MB，每份 HTML/SVG 源码最多 2MB。
8. 宽高、总像素数、时长、FPS 和总帧数受限。
9. 每一步使用独立浏览器上下文和页面。
10. 页面完成后立即关闭，逐帧临时目录无论成功失败都会清理。
11. FFmpeg 使用参数数组启动，不通过 shell 拼接用户输入。
12. 文件名会移除路径分隔符及危险字符。
13. 图片/GIF 仅写入 image/media-renderer；MP4/WebM 仅写入 file/media-renderer。

普通字体和附加图片可以使用系统字体、内联 SVG、Data URI，或通过 `assets` 显式声明。需要编辑的主图片可继续使用便捷的 `sourceImage` 参数。

## 输出

生成物保存到：

```text
image/media-renderer/   # PNG/JPG/WebP/GIF
file/media-renderer/    # MP4/WebM
```

返回结果包括：

- 图片访问 URL
- 文件名
- 服务器相对路径
- 宽高
- 格式
- MIME 类型
- 是否透明
- 文件大小
- 批量任务的每步结果

默认只返回 URL。只有静态图片设置 showBase64=true 时才额外返回图片 Data URI；GIF/视频不内联 Base64。

## GIF 与视频调用

动画使用逻辑时间逐帧渲染，不是让浏览器实时录屏。对于 `durationMs=5000`、`fps=30`，插件生成 150 帧；每一帧都以绝对时间调用页面帧函数，所以机器负载不会改变动画进度。

页面使用以下协议：

```html
<script>
window.__MEDIA_RENDERER__.setFrameRenderer(async (timeMs, frameIndex, fps) => {
    const seconds = timeMs / 1000;
    // 根据绝对时间更新 DOM、Canvas、Anime.js 或 Three.js 场景。
});

window.__MEDIA_RENDERER__.setReady();
</script>
```

异步加载字体、模型或纹理时，应在全部初始化完成后调用 `setReady()`，并传入：

```text
readyMode: signal
```

如果没有注册帧函数，插件会暂停 Web Animations API/CSS 动画并设置其 `currentTime`。复杂 Anime.js、Canvas 和 Three.js 动画应显式注册帧函数，避免依赖真实时钟或 `requestAnimationFrame` 的累计增量。

### 透明 GIF 示例

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」MediaRenderer「末」,
command:「始」RenderAnimation「末」,
html:「始」<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:transparent}.stage{width:100%;height:100%;display:grid;place-items:center}.dot{width:96px;height:96px;border-radius:50%;background:#22d3ee;box-shadow:0 0 30px #06b6d4}</style><div class="stage"><div class="dot"></div></div><script>const dot=document.querySelector('.dot');window.__MEDIA_RENDERER__.setFrameRenderer((timeMs)=>{const p=(timeMs%2000)/2000;dot.style.transform=`translateX(${Math.sin(p*Math.PI*2)*170}px)`;});window.__MEDIA_RENDERER__.setReady();</script>「末」,
width:「始」640「末」,
height:「始」360「末」,
format:「始」gif「末」,
transparent:「始」true「末」,
durationMs:「始」2000「末」,
fps:「始」24「末」,
readyMode:「始」signal「末」,
fileName:「始」moving-dot「末」
<<<[END_TOOL_REQUEST]>>>
```

GIF 只有索引透明色，不具备 PNG 那样的 8-bit 半透明通道。发光、阴影和抗锯齿边缘会被量化；复杂半透明动画优先使用透明 WebM。

## 内置 Anime.js 与 Three.js

通过 `libraries` 加载受信任的本地版本，不需要 CDN：

```text
libraries: anime,three
```

- `anime` 注入全局 `window.anime`，版本 3.2.2。
- `three` 注入全局 `window.THREE`，版本 r160。

依赖直接复用 `AdminPanel-Vue/vendor`，不复制到插件目录，也不会把第三方源码放进 AI 上下文。

## 通用素材

`assets` 可以传数组，也可以传 JSON 字符串：

```json
[
  {
    "id": "music",
    "type": "audio",
    "source": "file:///path/to/music.mp3"
  },
  {
    "id": "titleFont",
    "type": "font",
    "source": "http://192.168.1.20/assets/title.woff2"
  }
]
```

源码中通过占位符使用素材：

```css
@font-face {
    font-family: TitleFont;
    src: url("{{ASSET:titleFont}}") format("woff2");
}
```

MP4/WebM 音频混流通过素材 id 指定：

```text
audioAssetId: music
```

音频由 FFmpeg 直接读取插件临时文件并混流，不依赖浏览器自动播放。GIF 不包含音频。

默认允许显式声明的 localhost、局域网和公网 HTTP/HTTPS 素材。页面未声明的网络访问仍会被阻断，云元数据地址始终禁止。