# MediaRenderer 鼠标主题生成协议草案

## 1. 设计目标

`GenerateCursorTheme` 的输入应优先降低 AI 的上下文负担、重复劳动与结构性幻觉，而不是把 Windows 光标文件格式暴露给 AI。

AI 只负责：

1. 定义全局视觉变量。
2. 定义可复用的 SVG 符号。
3. 为光标角色声明 SVG 场景。
4. 仅在确实需要动画时注册一个共享的确定性渲染函数。

插件负责：

1. 校验角色、热点、尺寸、动画时长与帧率。
2. 依次显示并截取每个角色。
3. 将静态角色编码为 CUR。
4. 将动画角色编码为 ANI。
5. 生成 Windows 安装配置、卸载脚本、预览图和 ZIP。
6. 将 ZIP 保存到 ImageFileServer 文件服务并返回 URL。

## 2. 单文档模型

一次工具调用只提交一份 HTML，不提交十几组独立参数。

推荐结构：

```html
<!doctype html>
<html>
<head>
<style>
:root {
  --cursor-primary: #67e8f9;
  --cursor-secondary: #8b5cf6;
  --cursor-accent: #fef08a;
  --cursor-outline: #07111f;
  --cursor-shadow: rgba(34, 211, 238, 0.45);
  --cursor-stroke: 2.5;
}

.cursor {
  width: 100%;
  height: 100%;
  overflow: visible;
}

.outline {
  stroke: var(--cursor-outline);
  stroke-width: var(--cursor-stroke);
  stroke-linejoin: round;
  stroke-linecap: round;
}

.glow {
  filter: drop-shadow(0 0 4px var(--cursor-shadow));
}
</style>
</head>
<body>
  <svg class="cursor-definitions" aria-hidden="true">
    <defs>
      <!-- 公共 symbol、gradient、filter -->
    </defs>
  </svg>

  <!-- 每个 data-cursor 元素是一个角色场景 -->
</body>
</html>
```

## 3. 角色插槽

每个角色由一个顶层 SVG 表示：

```html
<svg
  class="cursor"
  data-cursor="arrow"
  data-hotspot="3,2"
  viewBox="0 0 64 64"
>
  <!-- 角色图形 -->
</svg>
```

角色属性：

| 属性 | 必需 | 说明 |
|---|---:|---|
| `data-cursor` | 是 | 插件定义的语义角色名 |
| `data-hotspot` | 否 | `x,y`，省略时使用角色默认热点 |
| `data-duration` | 否 | 动画周期毫秒；省略或 `0` 表示静态 |
| `data-fps` | 否 | 动画采样帧率；仅动画角色使用 |
| `viewBox` | 是 | 推荐统一为 `0 0 64 64` |

不要求 AI：

- 了解 Windows 注册表键名。
- 指定 `.cur` 或 `.ani` 文件名。
- 为每帧创建独立 SVG。
- 计算 RIFF、ICO/CUR 或 ZIP 二进制结构。
- 编写安装脚本。

## 4. 标准角色

### 4.1 核心角色

| 角色 | 用途 | 默认热点 |
|---|---|---|
| `arrow` | 正常选择 | `3,2` |
| `help` | 帮助选择 | `3,2` |
| `appstarting` | 后台运行 | `3,2` |
| `wait` | 忙碌 | 中心 |
| `crosshair` | 精确选择 | 中心 |
| `text` | 文本选择 | 中心 |
| `handwriting` | 手写 | 笔尖附近 |
| `unavailable` | 不可用 | 中心 |
| `vertical` | 垂直调整 | 中心 |
| `horizontal` | 水平调整 | 中心 |
| `diagonal1` | 西北—东南调整 | 中心 |
| `diagonal2` | 东北—西南调整 | 中心 |
| `move` | 移动 | 中心 |
| `alternate` | 候选选择 | `3,2` |
| `link` | 链接选择 | 食指尖 |

### 4.2 扩展角色

| 角色 | 用途 | 缺失回退 |
|---|---|---|
| `pin` | 位置选择 | `arrow` |
| `person` | 人员选择 | `arrow` |

插件将语义角色映射到 Windows Scheme 字段。该映射不进入 AI 调用协议。

## 5. 公共 SVG 符号库

推荐 AI 使用 `<symbol>` 和 `<use>`，避免重复绘制。

```html
<svg class="cursor-definitions" aria-hidden="true">
  <defs>
    <symbol id="base-arrow" viewBox="0 0 64 64">
      <path
        class="outline glow"
        fill="var(--cursor-primary)"
        d="M4 3 L4 47 L15 36 L24 57 L34 52 L25 32 L42 31 Z"
      />
    </symbol>

    <symbol id="loading-ring" viewBox="0 0 64 64">
      <circle
        cx="32"
        cy="32"
        r="20"
        fill="none"
        stroke="var(--cursor-secondary)"
        stroke-width="7"
        stroke-dasharray="82 44"
      />
    </symbol>
  </defs>
</svg>
```

角色通过组合生成：

```html
<svg class="cursor" data-cursor="arrow" data-hotspot="3,2" viewBox="0 0 64 64">
  <use href="#base-arrow"/>
</svg>

<svg
  class="cursor"
  data-cursor="appstarting"
  data-hotspot="3,2"
  data-duration="1200"
  data-fps="24"
  viewBox="0 0 64 64"
>
  <use href="#base-arrow"/>
  <g data-part="spinner" transform="translate(31 31) scale(.42) translate(-32 -32)">
    <use href="#loading-ring"/>
  </g>
</svg>
```

## 6. 共享确定性动画协议

静态主题不需要 JavaScript。

动画主题只注册一个共享函数，不为每个光标分别创建初始化器：

```html
<script>
window.__CURSOR_THEME__.setRenderer((role, timeMs, root) => {
  const progress = role === "wait" || role === "appstarting"
    ? (timeMs % 1200) / 1200
    : 0;

  const spinner = root.querySelector('[data-part="spinner"]');
  if (spinner) {
    spinner.style.transformOrigin = "32px 32px";
    spinner.style.transform = `rotate(${progress * 360}deg)`;
  }
});

window.__CURSOR_THEME__.setReady();
</script>
```

函数参数：

| 参数 | 说明 |
|---|---|
| `role` | 当前正在渲染的语义角色 |
| `timeMs` | 当前动画周期内的绝对逻辑时间 |
| `root` | 当前角色的顶层 SVG 元素 |

约束：

1. 函数必须只依据输入参数确定画面。
2. 不使用 `Date.now()`。
3. 不依赖实时 `requestAnimationFrame` 累加。
4. 不依赖 `setInterval`。
5. 不执行网络请求。
6. 不访问本地文件系统。
7. 每次调用应可重复，不能依赖上一次调用遗留状态。

## 7. Anime.js 模式

Anime.js 用于控制复杂 SVG 动画，但仍采用共享逻辑时间。

推荐创建暂停时间线并由插件传入的 `timeMs` 驱动：

```html
<script>
const timelines = {};

timelines.wait = anime.timeline({
  autoplay: false,
  loop: true
}).add({
  targets: '[data-cursor="wait"] [data-part="spinner"]',
  rotate: 360,
  duration: 1200,
  easing: "linear"
});

window.__CURSOR_THEME__.setRenderer((role, timeMs) => {
  const timeline = timelines[role];
  if (timeline) timeline.seek(timeMs % timeline.duration);
});

window.__CURSOR_THEME__.setReady();
</script>
```

插件继续复用 MediaRenderer 的本地 Anime.js，不从 CDN 执行脚本。

## 8. Canvas 定位

Canvas 是高级可选能力，不作为默认示例。

仅建议用于：

- 粒子效果。
- 程序噪声。
- 像素风动态纹理。
- 难以用 SVG 表达的程序图形。

使用 Canvas 时仍必须通过共享确定性渲染函数按绝对 `timeMs` 重绘。插件不会接受依赖真实时间的录屏式动画。

## 9. 缺失角色与严格校验

协议固定采用严格模式，不向 AI 暴露模式选择，避免模型在“少画一些角色”和“完整主题”之间产生不稳定决策。

1. 15 个核心角色必须全部显式声明。
2. `pin` 和 `person` 是可选扩展角色；缺失时 Windows 对应字段回退到 `arrow`，但不伪造额外的角色源文件。
3. 每个核心角色必须恰好出现一次。
4. 重复角色、未知角色、缺失核心角色和无效热点直接报错，并一次性返回全部结构错误。
5. 角色可以通过 `<symbol>`、`<use>` 和公共 CSS 复用视觉原型；“显式声明角色”不等于重复绘制路径。
6. 插件不使用内置图形偷偷补齐核心角色，保证最终主题完全来自 AI 提交且预览与安装结果一致。

## 10. 热点与多尺寸规则

1. 推荐所有角色统一使用 `viewBox="0 0 64 64"`。
2. 热点坐标使用 SVG `viewBox` 坐标，不使用最终 PNG 像素。
3. 插件默认生成 32、48、64 像素三档图像，并将它们写入同一个 CUR；AI 不需要重复提供多份 SVG。
4. ANI 的每个逻辑帧同样包含 32、48、64 像素三档图像。
5. 插件根据每档输出尺寸独立换算热点并采用最近整数；换算结果必须落在该档图像范围内。
6. 中心型角色省略热点时自动使用 `viewBox` 中心。
7. 尖端型角色使用角色默认热点，但 AI 显式值优先。
8. `viewBox` 必须包含四个有限数字，宽高必须为正数，热点必须落在其边界内。
9. ZIP 中的 `theme.json` 记录原始热点和每个输出尺寸的最终热点，便于排查。

## 11. 动画规则

1. 静态角色生成包含 32、48、64 像素图像的 CUR。
2. `data-duration > 0` 的角色生成 ANI；ANI 中的每帧都是一个多尺寸 CUR。
3. 默认动画帧率为 24 FPS。
4. 建议周期为 600-2000ms。
5. 每个角色最多 120 帧，整套主题最多 240 个逻辑帧。
6. 采样时间为 `frameIndex × duration / frameCount`，不采样与首帧重复的周期终点。
7. 动画首尾应构成无跳变循环。
8. 同一主题允许静态 CUR 与动画 ANI 混合。
9. `wait` 和 `appstarting` 推荐动画，其余角色动画应克制，避免干扰可用性。
10. ANI 帧延迟由周期和帧数自动换算为 Windows jiffy，AI 不需要填写底层时间单位。

## 12. 总览预览

插件在角色渲染完成后自动排版总览图，不要求 AI 提供额外预览 HTML。

预览图包含：

- 主题名称。
- 全部角色的 64 像素第一帧。
- 角色名。
- 静态或动画标记。
- 热点十字标记。
- 可选扩展角色缺失提示。
- 输出尺寸集合。
- 动画周期与 FPS。
- 透明棋盘格背景；棋盘格只用于预览，不进入 CUR/ANI。

插件返回：

1. ZIP 下载 URL。
2. 总览预览图 URL。
3. 角色数量。
4. CUR/ANI 数量。
5. 回退角色列表。
6. 警告列表。

## 13. ZIP 内容

建议生成：

```text
ThemeName/
├─ cursors/
│  ├─ arrow.cur
│  ├─ help.cur
│  ├─ appstarting.ani
│  └─ ...
├─ preview.png
├─ source.html
├─ theme.json
├─ install.inf
├─ install.cmd
├─ uninstall.cmd
└─ README.txt
```

`source.html` 保留原始主题源，方便用户或 AI 二次修改。

## 14. AI 最小工作模型

AI 的思考顺序应固定为：

1. 先确定主题故事与三到五个全局颜色。
2. 绘制公共基础箭头。
3. 绘制加载环、手形、I 型、十字、四向箭头等公共组件。
4. 用 `<use>` 组合 15 个核心角色。
5. 只为 `wait`、`appstarting` 等必要角色声明动画。
6. 检查每个角色的热点。
7. 一次提交完整 HTML。

该流程比逐角色独立提交 SVG/JavaScript 更短、更一致，也更容易由插件做结构化校验。