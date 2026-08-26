# MediaRenderer

MediaRenderer 包含两条彼此独立的生成路径：

- 使用 VCP 托管 Chrome 与服务器全局 FFmpeg，将 AI 编写的 HTML/SVG 渲染为静态图片、GIF 或视频。
- 在独立 Node.js 子进程中运行 AI 编写的音乐合成 JavaScript，直接生成 WAV/PCM16；此路径不启动浏览器，也不需要 FFmpeg 或额外 npm 依赖。

图形渲染不通过 ChromeBridge 传输源码或截图，而是直接调用根层浏览器运行时，取得 DevTools WebSocket Endpoint 后创建独立浏览器上下文。音乐合成则完全绕过浏览器运行时。

## 功能范围

当前版本支持：

- HTML → PNG、JPG、WebP
- SVG → PNG、JPG、WebP
- 宽高各 64-4096 像素
- 最大总像素 4096×4096
- PNG/WebP 透明背景
- JPG 自定义底色
- 最多 16 步串行批量渲染
- HTML/CSS/SVG 源码直接引用 Data URI、HTTP/HTTPS 和 `file://` 图片、视频、字体等资源
- Node.js 侧安全预取源码资源并改写为 Data URI
- ImageFileServer 图床 URL
- 可选 Base64 多模态返回
- 除源码明确引用并通过校验的资源外，页面运行时网络请求全部阻断
- HTML JavaScript 默认关闭，动画或内置库模式自动开启
- GIF、MP4、WebM 确定性逐帧渲染
- 透明 GIF 与透明 WebM
- Anime.js 3.2.2、Three.js r160 常见 CDN 标签自动重定向到本地版本
- 本地、内网和公网图片/音频/视频/字体素材
- 通过直接 `audioUrl` 进行 MP4/WebM 音频混流
- AI 自由 JavaScript 程序音乐/音效合成
- 方波、脉冲波、三角波、锯齿波、正弦波与确定性噪声辅助 API
- 固定时长、单/双声道 PCM16 WAV 输出
- 独立子进程、执行超时与进程树回收

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

`GenerateAudio` 只依赖当前 Node.js 运行时。只生成 WAV 时，不要求启用托管浏览器，也不要求安装 FFmpeg。

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

## 在源码中直接引用图片、视频和字体

推荐把资源 URL 直接写进 HTML/CSS/SVG，不需要创建 `assets` JSON，也不需要资源 id 或占位符。

支持的常见位置：

- `<img src>`、`<video src>`、`<audio src>`、`<source src>` 和 `poster`
- `<img srcset>`
- SVG `href`、`xlink:href`
- CSS `url(...)`，包括 `@font-face`
- `data:`、`file://`、HTTP/HTTPS 和 VCP ImageFileServer URL

插件先在 Node.js 侧提取 URL，逐跳检查远程重定向和目标地址，再读取或下载资源并改写成 Data URI。Chromium 不直接访问本地文件系统，也不能任意联网。

下面直接引用本地图片，并用 CSS 添加饱和度、霓虹投影、圆角和边框光效：

```text
<<<[TOOL_REQUEST]>>>
maid:「始」Nova「末」,
tool_name:「始」MediaRenderer「末」,
command:「始」RenderImage「末」,
html:「始」<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:#080b16}.stage{position:relative;width:100%;height:100%;display:grid;place-items:center;overflow:hidden}.source{width:78%;height:78%;object-fit:cover;border-radius:12%;filter:saturate(1.35) contrast(1.1) drop-shadow(0 0 28px #22d3eeaa)}.glow{position:absolute;inset:8%;border:4px solid #67e8f9;border-radius:15%;mix-blend-mode:screen;box-shadow:0 0 50px #06b6d4}</style><div class="stage"><img class="source" src="file:///D:/media/source.png"><div class="glow"></div></div>「末」,
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

旧版 `sourceImage + {{SOURCE_IMAGE}}` 和 `assets + {{ASSET:id}}` 仍兼容，但新调用不再推荐使用。提供旧版 `sourceImage` 却没有相应占位符时，插件仍会拒绝请求。

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

## 程序化音乐生成

`GenerateAudio` 接受 AI 编写的 JavaScript 合成代码，在专用子进程中生成 WAV。调用必须带有用户提供的 6 位管理员验证码：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」MediaRenderer「末」,
command:「始」GenerateAudio「末」,
requireAdmin:「始」用户提供的6位管理员验证码「末」,
durationMs:「始」8000「末」,
sampleRate:「始」44100「末」,
channels:「始」2「末」,
tempo:「始」160「末」,
seed:「始」42「末」,
code:「始」function synthesize(api) {
    const notes = ['C5', 'E5', 'G5', 'C6', 'G5', 'E5', 'D5', 'G4'];
    for (let step = 0; step < 32; step++) {
        api.addNote({
            note: notes[step % notes.length],
            start: step * 0.25,
            duration: 0.2,
            wave: 'square',
            duty: 0.25,
            volume: 0.2,
            pan: step % 2 ? 0.2 : -0.2,
            attack: 0.005,
            release: 0.04
        });
    }
}「末」,
fileName:「始」eight-bit-theme「末」
<<<[END_TOOL_REQUEST]>>>
```

`code` 必须声明 `synthesize(api)`，可以同步或异步执行。插件预先分配固定长度的 `Float32Array` 声道：

```js
function synthesize(api) {
    for (let frame = 0; frame < api.left.length; frame++) {
        const time = frame / api.sampleRate;
        const phase = time * 220 % 1;
        const sample = phase < 0.25 ? 0.15 : -0.15;
        api.left[frame] += sample;
        api.right[frame] += sample;
    }
}
```

可用 API：

| 成员 | 说明 |
|---|---|
| `sampleRate`、`duration`、`durationMs` | 固定音频时间轴 |
| `channels`、`channelData`、`left`、`right` | 声道和采样数组；单声道时 right 与 left 指向同一数组 |
| `tempo`、`secondsPerBeat`、`beatToSeconds()` | 节拍辅助 |
| `seed`、`random()`、`noise()` | 可复现随机数与白噪声 |
| `noteToFrequency()` | 将 C4、F#5、Bb3 等音符转换为 Hz |
| `oscillator()` | sine、square/pulse、triangle、saw/sawtooth |
| `envelope()` | ADSR 包络计算 |
| `addNote()` | 快速叠加带波形、包络、音量和声像的音符 |
| `Math` | 标准 JavaScript 数学对象 |

代码也可以完全忽略便捷 API，自行实现振荡器、滤波、延迟、混响、鼓机、Tracker、算法作曲或其他 DSP。可信 Worker 最后统一处理非有限值、峰值归一化、主音量、尾部淡出和 WAV 编码。

音乐参数：

| 参数 | 必需 | 默认值 | 说明 |
|---|---|---|---|
| command | 是 | - | `GenerateAudio` |
| requireAdmin | 是 | - | 用户提供的 6 位管理员验证码 |
| code | 是 | - | 声明 `synthesize(api)` 的 JavaScript，最大 1MB |
| durationMs | 否 | 10000 | 100ms 至管理员配置的最大时长 |
| sampleRate | 否 | 44100 | 8000-48000 Hz |
| channels | 否 | 2 | 1 或 2 |
| tempo | 否 | 120 | 20-400 BPM |
| seed | 否 | 1 | 0 至 2147483647 |
| masterVolume | 否 | 0.8 | 0-1 |
| fadeOutMs | 否 | 30 | 尾部淡出时间 |
| timeoutMs | 否 | 30000 | 不得超过 `AudioSynthesisTimeoutMs` |
| fileName | 否 | generated-audio | 输出文件名主体 |

输出固定为 WAV、16-bit PCM。需要 MP3/AAC/Opus 时，可后续通过其他转码流程处理；音乐合成自身不依赖压缩编码器。

## 参数说明

| 参数 | 必需 | 默认值 | 说明 |
|---|---|---|---|
| html | 二选一 | - | HTML 源码 |
| svg | 二选一 | - | SVG 源码 |
| sourceImage | 否 | - | 旧版单底图兼容参数；新调用优先直接在源码写 URL |
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
| libraries | 否 | - | 兼容参数；源码使用受支持 CDN 标签时可省略 |
| assets | 否 | [] | 旧版占位符/音频兼容参数，普通素材无需使用 |
| durationMs | 动画 | 5000 | 动画时长，100-60000ms |
| fps | 动画 | 30 | 每秒帧数，1-60 |
| readyMode | 否 | 动画为 auto | load、auto、signal |
| audioUrl | 否 | - | 直接混入 MP4/WebM 的音频 URL，支持 data/file/HTTP(S) |
| audioAssetId | 否 | - | 旧版兼容：选择 assets 中的音频 id |

## 安全策略

AI 提供的 HTML/SVG 按不可信输入处理：

1. 默认禁用 HTML JavaScript；动画、显式内置库或受支持 CDN 标签模式自动开启。
2. 源码中的静态资源 URL、`audioUrl`、旧版 `sourceImage/assets` 都由 Node.js 预取。
3. 通过校验的资源会改写为 Data URI；页面运行时新增的任意 HTTP/HTTPS/file 请求仍被阻断。
4. `file://` 素材由 Node.js 读取，Chromium 不直接访问本地文件系统。
5. 默认允许显式内网素材；可通过 `AllowPrivateNetworkAssets=false` 禁止。
6. 云元数据地址始终禁止，重定向后的每个 URL 都重新校验。
7. 单素材最大 50MB、总素材最大 100MB，每份 HTML/SVG 源码最多 2MB。
8. 宽高、总像素数、时长、FPS 和总帧数受限。
9. 每一步使用独立浏览器上下文和页面。
10. 页面完成后立即关闭，逐帧临时目录无论成功失败都会清理。
11. FFmpeg 使用参数数组启动，不通过 shell 拼接用户输入。
12. 文件名会移除路径分隔符及危险字符。
13. 图片/GIF 仅写入 image/media-renderer；MP4/WebM/WAV 仅写入 file/media-renderer。
14. GenerateAudio 在启动 Worker 前强制比对用户提交的 `requireAdmin` 与 PluginManager 服务端注入的解密验证码。
15. 合成代码运行在独立 Node.js 子进程；超时会终止进程树，主服务不会执行 AI 合成代码。
16. 合成代码大小、时长、采样率、声道数、总声道采样数、Worker 输出及 WAV 文件大小均有限制。
17. Worker 结束后由主进程重新校验 WAV 头、PCM 格式、采样率、声道数、数据长度和实际时长。

普通字体、图片和视频可以直接在源码中使用 Data URI、`file://` 或 HTTP/HTTPS。旧版 `assets` 与 `sourceImage` 仅用于兼容已有调用。

## 输出

生成物保存到：

```text
image/media-renderer/   # PNG/JPG/WebP/GIF
file/media-renderer/    # MP4/WebM/WAV
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

## Anime.js 与 Three.js 的 CDN 本地重定向

AI 可以直接输出熟悉的传统全局 CDN 标签：

```html
<script src="https://cdn.jsdelivr.net/npm/animejs@3.2.2/lib/anime.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js"></script>
```

插件识别 jsDelivr、unpkg、cdnjs 上路径匹配的 Anime.js/Three.js，移除远程标签并注入本地文件，完全不会请求 CDN：

- Anime.js 提供全局 `window.anime`，本地版本 3.2.2。
- Three.js 提供全局 `window.THREE`，本地版本 r160。
- 其他外部脚本一律拒绝执行。
- ES Module 形式的 Three.js/import map 当前不支持，请使用传统 `three.min.js` 全局脚本。

旧的 `libraries: anime,three` 参数继续兼容。依赖直接复用 `AdminPanel-Vue/vendor`，不复制到插件目录。

## 旧版 assets 兼容

普通素材应直接写在源码中。仅旧调用需要继续使用 `assets` 数组或 JSON 字符串：

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

新调用通过 URL 直接指定 MP4/WebM 音轨：

```text
audioUrl: file:///D:/media/music.mp3
```

旧调用仍可使用 `audioAssetId: music`。音频由 Node.js 安全读取或下载，再交给 FFmpeg 临时文件混流，不依赖浏览器自动播放。GIF 不包含音频。

默认允许显式声明的 localhost、局域网和公网 HTTP/HTTPS 素材。页面未声明的网络访问仍会被阻断，云元数据地址始终禁止。

## Windows 鼠标主题生成

`GenerateCursorTheme` 从一份完整 HTML 生成 Windows CUR/ANI 鼠标主题 ZIP，并复用 MediaRenderer 已有的托管浏览器、Anime.js 本地注入、素材预取、页面隔离与网络阻断能力。

完整输入协议见 [CURSOR_THEME_PROTOCOL.md](./CURSOR_THEME_PROTOCOL.md)。

### 为什么采用一份 HTML

输入按以下层次组织：

1. 一个全局 `<style>`，通过 CSS 变量统一颜色、描边、阴影和发光。
2. 一个公共 SVG `<defs>`，使用 `<symbol>` 定义视觉原型。
3. 15 个显式的核心角色 `<svg data-cursor="...">` 插槽。
4. 一个可选的共享确定性动画函数 `window.__CURSOR_THEME__.setRenderer()`。

该结构让 AI 只绘制少量原型，再通过 `<use>` 组合完整主题；插件负责角色校验、逐帧截图、多尺寸生成、Windows 字段映射和安装包打包。

### 核心角色

必须恰好各声明一次：

```text
arrow
help
appstarting
wait
crosshair
text
handwriting
unavailable
vertical
horizontal
diagonal1
diagonal2
move
alternate
link
```

可选扩展角色：

```text
pin
person
```

扩展角色缺失时，Windows 安装映射会回退到 `arrow`。核心角色不会被插件静默补齐。

### 角色声明

```html
<svg
  data-cursor="arrow"
  data-hotspot="3,2"
  viewBox="0 0 64 64"
>
  <use href="#base-arrow"/>
</svg>
```

属性：

| 属性 | 说明 |
|---|---|
| `data-cursor` | 语义角色名 |
| `data-hotspot` | 可选热点，使用 viewBox 坐标 |
| `data-duration` | 可选动画周期毫秒；大于 0 时输出 ANI |
| `data-fps` | 可选动画 FPS，默认 24 |
| `viewBox` | 必需，推荐统一为 `0 0 64 64` |

默认输出 32、48、64 像素三档。插件将三档 PNG 和各自换算后的热点写入同一个 CUR；ANI 的每个逻辑帧同样是多尺寸 CUR。AI 不需要重复提供多份 SVG。

### 共享动画

简单 CSS/Web Animations 动画无需 JavaScript 渲染器，插件会按逻辑时间冻结动画。

复杂动画使用一个共享入口：

```html
<script>
window.__CURSOR_THEME__.setRenderer((role, timeMs, root) => {
  const spinner = root.querySelector('[data-part="spinner"]');
  if (spinner) {
    const degrees = (timeMs % 1200) / 1200 * 360;
    spinner.setAttribute("transform", `rotate(${degrees} 32 32)`);
  }
});

window.__CURSOR_THEME__.setReady();
</script>
```

动画必须由 `role`、`timeMs` 和当前 `root` 确定，不依赖真实时钟、`setInterval` 或实时帧累加。

Anime.js 推荐建立 `autoplay: false` 的时间线，再在共享渲染器中调用 `timeline.seek(timeMs)`。常见可信 CDN 标签仍会被改写成本地内置 Anime.js，不会访问 CDN。

### 调用参数

| 参数 | 必需 | 默认值 | 说明 |
|---|---:|---|---|
| command | 是 | - | `GenerateCursorTheme` |
| html | 是 | - | 完整主题 HTML，最大 2MB |
| themeName | 否 | VCP Cursor Theme | Windows 主题名称 |
| author | 否 | VCPToolBox AI | 作者 |
| sizes | 否 | 32,48,64 | 1-8 个尺寸，范围 16-256 |
| libraries | 否 | 自动识别 | 可设为 `anime` |
| readyMode | 否 | auto | 异步初始化推荐 `signal` |
| timeoutMs | 否 | 45000 | 1000-120000ms |
| waitMs | 否 | 0 | 截图前额外等待，最大 10000ms |
| assets | 否 | [] | 旧版素材占位符兼容参数 |

### 输出与安装包

ZIP 保存到：

```text
file/media-renderer/
```

总览图保存到：

```text
image/media-renderer/
```

ZIP 内包含：

```text
ThemeName/
├─ cursors/
│  ├─ arrow.cur
│  ├─ wait.ani
│  └─ ...
├─ preview.png
├─ source.html
├─ theme.json
├─ install.inf
├─ install.cmd
├─ uninstall.cmd
└─ README.txt
```

插件同时返回 ZIP 下载 URL 和总览图 URL。总览图显示所有角色的第一帧、热点、静态/动画标记及可选角色回退信息。

### 限制与安全

- 15 个核心角色必须恰好各出现一次。
- 单角色最多 120 个逻辑帧。
- 整套主题最多 240 个逻辑帧。
- 每个逻辑帧按所有请求尺寸截图。
- HTML JavaScript 只在隔离的 Chromium BrowserContext 中执行。
- 页面运行时网络默认阻断。
- 外部脚本仅允许被识别并替换为本地版本的 Anime.js/Three.js。
- CUR/ANI/ZIP 编码在 Node.js 中处理受控 Buffer，不执行 AI 提供的 Node.js 代码。
- 安装脚本只复制光标文件并修改当前用户的 Windows 光标注册表字段。
- `source.html` 仅供二次编辑，不参与安装执行。