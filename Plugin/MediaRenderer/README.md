# MediaRenderer

MediaRenderer 使用 VCP 已有的托管 Chrome 运行时，通过 Puppeteer/CDP 将 AI 编写的 HTML 或 SVG 渲染为静态图片。

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
- 除显式底图外的外部资源请求阻断
- HTML JavaScript 默认关闭

当前版本暂不包含 GIF 和 MP4，但渲染器的输出目录及部署环境可在后续接入全局 FFmpeg 编码器。

## 运行前提

根配置必须启用托管浏览器：

```env
VCP_BROWSER_RUNTIME_ENABLED=true
```

服务器需具备 Chrome、Chromium 或 Edge。也可以通过根配置显式指定可执行文件：

```env
VCP_BROWSER_EXECUTABLE_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
```

插件复用根项目已经安装的 Puppeteer 和 Sharp，不需要在插件目录单独安装依赖。

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
| format | 否 | 透明时 PNG，否则 JPG | png、jpg、webp |
| transparent | 否 | false | 保留 Alpha 通道 |
| background | 否 | #ffffff | 非透明输出的 Alpha 合成底色 |
| quality | 否 | 90 | JPG/WebP 质量，1-100 |
| showBase64 | 否 | false | 是否额外返回 Data URI |
| allowJavaScript | 否 | false | 是否运行 HTML 脚本 |
| waitMs | 否 | 0 | 截图前额外等待，最大 10000ms |
| timeoutMs | 否 | 45000 | 单步超时，最大 120000ms |
| fileName | 否 | UUID | 文件名主体 |

## 安全策略

AI 提供的 HTML/SVG 按不可信输入处理：

1. 默认禁用 HTML JavaScript。
2. 只有显式声明的 `sourceImage` 可以作为外部图片素材。
3. HTTP/HTTPS 模式只放行与 `sourceImage` 完全相同的 URL；页面中的其他网络请求继续被阻断。
4. `file://` 底图由 Node.js 读取并转换为 Data URI，Chromium 不直接访问本地文件系统。
5. 未声明底图时，仅允许 about:blank、Data URI 和 Blob URL。
6. 本地或内联底图最大 25MB，每份 HTML/SVG 源码最多 2MB。
7. 宽高和总像素数受限。
8. 每一步使用独立浏览器上下文和页面。
9. 页面完成后立即关闭。
10. 文件名会移除路径分隔符及危险字符。
11. 输出只能写入 image/media-renderer。

普通字体和附加图片仍应使用系统字体、内联 SVG、Data URI 或 CSS 绘制。需要编辑的主图片应通过 `sourceImage` 显式声明，而不是在 HTML 中任意引用网络或本地地址。

## 输出

生成物保存到：

```text
image/media-renderer/
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

默认只返回 URL。只有 showBase64=true 时才额外返回图片 Data URI。