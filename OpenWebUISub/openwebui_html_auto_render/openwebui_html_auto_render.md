# OpenWebUI HTML Live Preview 脚本文档

此文档记录 OpenWebUI HTML Live Preview 系列脚本的技术说明与版本变更历史。

本项目由三个部分组成：
1. OpenWebUI Action 函数（Python，服务端）—— 负责从模型回复中提取 HTML 并通过 `HTMLResponse` 渲染到 iframe。v0.3.0 起支持多代码块合并渲染（用 `<section data-vcp-block>` 分隔）。
2. 油猴脚本（JavaScript，客户端）—— 负责在聊天流中自动检测 HTML 代码块，触发 Action 渲染，并将 iframe 原位替换到代码块位置（"遮点挪"）。v0.3.0 起支持多气泡拆分定位。

两者的依赖关系：油猴脚本依赖 Action 函数提供的 `HTMLResponse` → `embeds` → `FullHeightIframe` 渲染通道。多气泡场景下，从合并 iframe 的 `srcdoc` 中拆分出各代码块内容，为每个块创建独立 iframe。

---

## OpenWebUI Function 脚本

- 文件：`html_live_preview/html_live_preview_0.3.0.py`
- 类型：OpenWebUI Action Function（`class Action`）
- 最低版本要求：OpenWebUI 0.8.0+（依赖 PR #21294 为 Action 开放的 HTML rendering 能力）
- 作者：B3000Kcn & DBL1F7E5

### 工作原理

1. 用户点击消息下方的 "HTML Live Preview" Action 按钮（或由油猴脚本自动触发），调用 `action()` 方法。
2. 从 `body["messages"]` 中逆序查找最新的 `assistant` 回复。
3. 三层兜底提取 HTML 内容：
   - 优先匹配 ` ```html ` 标记的代码块。
   - 回退匹配包含 `<!DOCTYPE` 或 `<html` 的代码块。
   - 最终回退：若整条消息包含 `<html` 或 `<!doctype`，则取整条消息。
4. 多代码块合并渲染：每个匹配到的代码块用 `<section data-vcp-block="N">` 包裹（N 从 0 开始），合并进一个母文档。
5. 对不完整的 HTML 片段（不含 `<html>` 标签的）包裹基础样式容器。
6. 通过 `return HTMLResponse(content=html, headers={"Content-Disposition": "inline"})` 触发前端 `embeds` → `FullHeightIframe` 渲染通道。
7. 过程中通过 `__event_emitter__` 发送 `type: "status"` 消息反馈状态。

### CHANGELOG

#### v0.3.0（2026-02-23）
- 多代码块合并渲染：用 `<section data-vcp-block="N">` 包裹每个代码块，合并进统一母文档。
- 不完整 HTML 包裹逻辑从整体判断改为逐块判断。
- 技术决策记录：分隔标记选择 `data-vcp-block` 属性而非 HTML 注释，因为属性更容易用正则精确匹配，且不会被浏览器吞掉。
- 此版本为当前稳定版。

#### v0.2.0（2026-02-21）
- 核心突破：改用 `return HTMLResponse(content=html, headers={"Content-Disposition": "inline"})`。
- 技术决策记录：PR #21294 为 Action 开放的是 return 值走 `embeds` → `FullHeightIframe` 通道，而非 event emitter 通道。`__event_emitter__` 仅用于 `type: "status"` 状态反馈（此用法对 Action 有效）。
- 三层兜底 HTML 提取逻辑定型。
- 不完整 HTML 自动包裹逻辑定型。

#### v0.1.1（2026-02-21）
- 尝试在 event emitter payload 中补充 `role: "assistant"` 字段。
- 结果：仍然裸奔。确认 event emitter 路线对 Action 不可行。

#### v0.1.0（2026-02-21）
- 初版。尝试使用 `__event_emitter__` + `content_type: "html"` 渲染 HTML。
- 结果：代码裸奔显示，未触发 iframe 渲染。
- 技术决策记录：event emitter 的 `content_type: "html"` 是 Tools 的渲染通道，对 Action 无效。

---

## OpenWebUI HTML Auto-Render（遮点挪）油猴脚本

- 文件：`openwebui_html_auto_render/openwebui_html_auto_render_0.5.3.js`
- 类型：Tampermonkey 用户脚本（兼容非油猴环境，CSS/JS 可拆分复用）
- 依赖：Action函数 v0.3.0+（需要 `data-vcp-block` 分隔标记支持多气泡拆分）
- 外部依赖：dom-to-image-more v3（运行时从 jsDelivr CDN 动态加载，SVG foreignObject 截图引擎）
- 作者：B3000Kcn & DBL1F7E5

### 工作原理（"遮点挪"三步模型 — 多气泡版）

#### 架构变更：消息级协调

v0.3.0 将处理粒度从"代码块级独立流程"提升为"消息级协调流程"：
- 同一消息内的所有 `.language-html` 代码块归为一个 `TaskInfo` 任务。
- 一个任务只触发一次 Action 点击，产出一个合并 iframe。
- 合并 iframe 的 `srcdoc` 按 `data-vcp-block` 标记拆分，为每个代码块创建独立 iframe 并分别定位。

#### 遮（Cover）
- `MutationObserver` 监听 DOM 变化，检测 `.language-html` 容器出现。
- 通过 `findMsgContainer()` 定位消息容器，将代码块注册到对应的 `TaskInfo` 中。
- 对每个代码块执行越狱 + 软隐藏 + 插入占位卡片。
- 启动块级内容稳定监听和消息级流式输出监听。

#### Action 按钮监听（零延迟触发）
- v0.4.0 废弃了防抖计时器（`STREAM_SETTLE_MS` / `MSG_STREAM_SETTLE_MS`），改为监听 Action 按钮出现。
- OpenWebUI 在消息生成完毕后才渲染 Action 按钮，因此按钮出现 = 消息完成的精确信号。
- 遮阶段注册块后，立即检查 Action 按钮是否已存在：
  - 已存在：立即触发点击（历史消息/刷新场景）。
  - 不存在：启动 `MutationObserver` 监听消息容器，按钮一出现立即触发。
- 相比旧版盲等 2s 的防抖方案，延迟从 ~2-3s 降至接近零。

#### 点（Click）
- Action 按钮出现后立即触发点击，无需等待块内容稳定或流式结束。
- 若按钮尚未出现（理论上不会，因为监听会捕获），采用退避重试（初始 200ms，×1.2 退避，上限 2000ms）。
- 若 iframe 已存在（快速路径命中），跳过点击直接进入搬运。

#### 挪（Move）— 拆分定位
- 轮询查找消息容器内生成的 `iframe[title="Embedded Content"]`。
- 读取 iframe 的 `srcdoc` 属性，用正则按 `<section data-vcp-block="N">` 拆分出 N 段 HTML。
- 为每个代码块创建独立 iframe（`srcdoc` = 拆分出的对应段），替换各自的占位卡片。
- 独立 iframe 通过 `ResizeObserver` 监听内部内容高度变化，实现自适应高度。
- 隐藏原 embeds 容器，标记消息为已渲染。

#### 回退机制
- 单气泡场景：直接搬运原始 iframe，行为与 v0.2.5 一致。
- 拆分失败（srcdoc 块数与 DOM 块数不匹配，或旧版 Action 无分隔标记）：从 CodeMirror 读取源码，客户端自建 iframe 渲染。
- 晚到的块（任务已进入 clicking/moving 阶段后新出现的代码块）：重入任务并回滚到 collecting 阶段（v0.3.1 机制保留）。

#### 快速路径（Fast Path）
- 页面刷新时按消息容器分组批量扫描。
- v0.4.0 改进：优先检测 Action 按钮是否已存在（而非轮询等 iframe）。
  - 按钮已存在 + iframe 已存在：直接拆分搬运（纯前端，不触发 Action）。
  - 按钮已存在 + 无 iframe：先探测 iframe 是否即将出现（最多 2.25s），探测到则直接搬运；超时才点击 Action。
  - 按钮不存在：走正常流程（流式进行中）。
- `initialScanDone` 守卫：`initialScan()` 完成前 MO 不处理块，确保快速路径优先执行。
- 若 srcdoc 含 `data-vcp-block` 标记，拆分后分别定位。
- 若无标记（旧版），单气泡直接搬运，多气泡回退 CM 自渲染。

### 关键 DOM 选择器

| 用途 | 选择器 | 说明 |
|------|--------|------|
| HTML 代码块 | `.language-html` | CodeMirror 6 容器 |
| Action 按钮 | `button[aria-label="HTML Live Preview"]` | 稳定锚点，不依赖 DOM 层级 |
| 渲染 iframe | `iframe[title="Embedded Content"]` | 稳定锚点 |
| embeds 容器 | `div[id]` 匹配 `/^.+-embeds-\d+$/` | 系统生成的 iframe 宿主 |
| 消息根容器 | `div[id^="message-"]` | 作用域隔离边界 |

### 配置项（CONFIG）

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `CLICK_RETRY_INTERVAL` | 200 | 点击重试初始间隔（ms） |
| `MOVE_RETRY_INTERVAL` | 150 | 搬运重试初始间隔（ms） |
| `RETRY_BACKOFF` | 1.2 | 退避倍率 |
| `RETRY_MAX_INTERVAL` | 2000 | 重试间隔上限（ms） |
| `FAST_PROBE_INTERVAL` | 150 | 快速路径探测间隔（ms） |
| `FAST_PROBE_MAX` | 15 | 快速路径最大探测次数 |
| `DOMTOIMAGE_CDN` | jsDelivr URL | dom-to-image-more v3 动态加载地址 |
| `DOMTOIMAGE_LOAD_TIMEOUT_MS` | 12000 | dom-to-image-more 加载超时（ms） |
| `CAPTURE_SCALE` | 3 | 截图分辨率倍率（3x 超清；触屏设备自动降为 2x） |
| `TOAST_MS` | 1600 | toast 提示显示时长（ms） |
| `DEBUG` | true | 是否输出调试日志 |

### CHANGELOG

#### v0.5.3（2026-02-26）
- 截图引擎更换：html2canvas → dom-to-image-more v3（SVG foreignObject 方案）。- 根因：html2canvas 在 JS 中重新实现 CSS渲染，复杂特效（backdrop-filter、mix-blend-mode、CSS 变量、渐变、动画等）无法完整还原，导致导出图"特效不全"。
  - 新方案：dom-to-image-more 将 DOM 序列化为 SVG foreignObject，由浏览器自身渲染引擎绘制，CSS 特效 100% 保真。
- 智能内容区域检测（`findCaptureTarget`）：遍历 body 直接子元素，过滤掉 SCRIPT/STYLE/LINK/META/NOSCRIPT 及隐藏/零尺寸元素。单可见子元素→精确截取该元素（卡片区）；多可见子元素→截取 body；无可见子元素→回退 body。"有内容才算卡片区"。
- 内容裁切修复：使用 `Math.max(offsetWidth, scrollWidth, clientWidth)` 三取最大值作为截取尺寸，显式传入 dom-to-image-more 的 width/height 参数，防止 overflow 内容右边/下边被吃掉。
- 高分辨率输出：新增 `CAPTURE_SCALE: 3`（3x 超清），通过 `style.transform: scale(N)` + canvas尺寸=原始×N 的标准高DPI 方案。触屏设备自动降为 2x 避免内存压力。
- 圆角保留：不再对导出图做任何 border-radius 重置，保持 iframe 中看到的原始圆角效果。
- 代码清理：移除 html2canvas 全部相关代码（~200 行），包括 `html2canvasPromise`、`findHtml2Canvas()`、`ensureHtml2CanvasLoaded()`、`ensureHtml2CanvasLoadedInWindow()`、`waitFontsReady()`、`canvasToBlob()`、`trimTransparentEdges()`、`captureIframeToCanvas()`、`CAPTURE_RESET_CSS` 及所有 html2canvas CONFIG 常量。
- 此版本为当前稳定版。

#### v0.5.2（2026-02-26）
- 截图导出风格策略调整：导出时保留卡片背景与视觉特效（不再强制透明背景），使导出图更接近用户在 iframe 中看到的实际风格。
- 在导出克隆文档中仅移除外层圆角/去边框：`CAPTURE_RESET_CSS` 仅对 `html, body` 设置 `border-radius: 0` 与 `border: none`，保留卡片内部组件的圆角与视觉层次。
- 继续沿用 v0.5.1 的 onclone 方案：仅修改 html2canvas 克隆文档，不触碰真实 iframe DOM，避免复制/保存时页面抽搐。
- 此版本为当前稳定版。

#### v0.5.0（2026-02-23）
- 新增"复制/保存"悬浮工具栏：每个渲染出的 iframe 右上角显示"复制"和"保存"按钮，桌面端 hover 时浮现，触屏设备点击 iframe 区域切换工具栏显隐（不再常显，避免遮挡内容）。
- 截图导出：通过 html2canvas（运行时从 CDN 动态加载）对 iframe 内部 DOM 截图，生成 PNG。
- 油猴沙箱兼容：html2canvas 注入到页面 window 后，通过 `findHtml2Canvas()` 三级查找（`window` → `unsafeWindow` → `globalThis`）+ 轮询等待，解决 Firefox 油猴沙箱隔离问题。
- 导出质量优化：
  - 截图前临时注入 reset CSS（`html/body margin/padding/border-radius: 0`），导出后立即移除，不影响页面展示。
  - 透明边缘裁切（`trimTransparentEdges()`）：扫描 canvas 四周 alpha 通道，裁掉透明留白和圆角区域，只保留有内容的部分。
  - 桌面 scale=3（更清晰），触屏/移动端自动降到 2（防内存溢出）。
- 安卓剪贴板降级：`navigator.clipboard.write(image/png)` 失败时自动降级为下载 + toast 提示"剪贴板不可用，已保存到本地"。
- CSS 注入兼容：新增 `addStyle()` 函数，油猴环境用 `GM_addStyle`，非油猴环境用 `<style>` 注入，便于后续拆分为独立 CSS/JS 文件。
- 非油猴拆分注意事项：`addStyle()` 和 `ensureHtml2CanvasLoaded()` 均不依赖油猴 API，可直接抽出复用；`findHtml2Canvas()` 中的 `unsafeWindow` 分支在非油猴环境下会被 try-catch 静默跳过。
- iframe 滚动条修复（同日补丁）：
  - 根因：`createIframeFromHtml()` 的 `load` 回调中首次 `scrollHeight` 测量时字体/布局可能未完全稳定，导致高度偏矮几像素，产生"能滚但只滚一点"的滚动条。后续气泡因浏览器缓存不受影响。
  - 修复：iframe 加 `scrolling="no"` + CSS `overflow: hidden` 双层禁止滚动条；`resizeToContent()` 在 `load` 后额外延迟 50ms 和 200ms 各做一次二次测量；`scrollHeight` 取值改为 `Math.max(documentElement.scrollHeight, body.scrollHeight)` 更稳健。
- 刷新免点击修复（同日补丁）：
  - 根因：刷新时 Action 按钮先于 iframe 出现在 DOM 中，`triggerAction()` 检测到按钮已存在但 `findIframe()` 返回 null，直接走 `doClick()` 重新点击 Action，导致话题被后端标记为"已修改"并被顶上去。
  - 修复：`triggerAction()` 新增 `probeIframeThenClick()`，当按钮已存在但 iframe 未出现时，先轮询探测 iframe（150ms × 15 = 最多 2.25s）。探测到 iframe 则直接拆分搬运（纯前端，后端无感知）；超时后才真正点击 Action（流式新消息场景）。
  - 辅助修复：MO 回调加 `initialScanDone` 守卫，`initialScan()` 完成前 MO 不处理块，避免快速路径被 MO 抢占。
- 此版本为当前稳定版。

#### v0.4.0（2026-02-23）
- 零延迟渲染：废弃 `STREAM_SETTLE_MS`（1500ms）和 `MSG_STREAM_SETTLE_MS`（2000ms）防抖计时器，改为监听 Action 按钮出现即触发。
- 延迟根因：旧版流式结束后仍需盲等 2s 防抖才开始渲染，用户感知延迟 ~2-3s。
- 新机制：OpenWebUI 在消息生成完毕后才渲染 Action 按钮，按钮出现即为"消息完成"的精确信号。遮阶段注册块后立即检查按钮，已存在则立即触发，不存在则启动 MutationObserver 监听。
- 快速路径优化：刷新时优先检测 Action 按钮而非轮询等 iframe，按钮已存在则立即点击或搬运。
- TaskInfo 结构简化：移除 `settled[]`、`streamObserver`、`streamSettleTimer` 字段，新增 `btnObserver` 字段。
- CONFIG 简化：移除 `STREAM_SETTLE_MS` 和 `MSG_STREAM_SETTLE_MS`，降低 `CLICK_RETRY_INTERVAL`（300→200ms）和 `MOVE_RETRY_INTERVAL`（200→150ms）。
- 保留 v0.3.1 全部竞态保护机制（cancelToken、晚到块重入、expectedBlocks、pendingSplitBlocks）。
#### v0.3.1（2026-02-23）
- 修复流式竞态：消息级流式结束误判导致只收集到部分块就触发 Action 的问题。
- 修复点 A：`doSplitAndMove()` 发现母文档块数 > DOM 块数时，不再走"单气泡搬运母 iframe"，而是回滚到 collecting 阶段，设置 `expectedBlocks` 和 `pendingSplitBlocks`，等 DOM 追上后通过 `tryFinalizeWithPending()` 完成拆分定位。
- 修复点 B：晚到块（任务已进入 clicking/moving 阶段后新出现的代码块）不再走独立回退自渲染，而是重新加入任务并回滚 phase 到 collecting，通过 `cancelToken` 取消正在进行的 click/move 重试循环。
- 新增 `cancelToken` 机制：每次回滚时递增 token，click/move 循环在每次重试前检查 token 是否匹配，不匹配则静默退出。
- 新增 `tryFinalizeWithPending()`：当 pendingSplitBlocks 已就绪且 DOM 块数追上期望值时，直接用缓存的拆分结果完成定位，无需再次点击 Action。
- 此版本为当前稳定版。

#### v0.3.0（2026-02-23）
- 多气泡支持：从代码块级独立流程重构为消息级协调流程。
- 新增消息级流式输出检测：用 MutationObserver 监听消息容器 DOM 变化，替代固定收集窗口，只要消息还在生成就不关闭收集窗口。
- 新增 srcdoc 拆分定位：从合并 iframe 的 srcdoc 中按 `data-vcp-block` 标记拆分，为每个代码块创建独立 iframe。
- 新增客户端自建 iframe 能力：拆分失败时回退从 CodeMirror 读源码自渲染，含 `ResizeObserver` 自适应高度。
- 新增晚到块独立回退：任务已进入后续阶段时新出现的代码块，独立走 CM 自渲染。
- 快速路径升级：页面刷新时按消息分组批量扫描，支持多气泡拆分搬运。
- 技术决策记录：收集窗口从固定 2000ms 改为流式检测，解决两个代码块间隔长文字时误触发的问题。
- 此版本为当前稳定版。

#### v0.2.5（2026-02-23）
- 去除所有超时限制，改为无限退避重试（Action 按钮等待、iframe 等待均不再超时放弃）。
- 新增快速路径（Fast Path）：页面刷新时直接探测已有 iframe 并搬运，跳过 Action 触发，避免旧话题被顶。
- 技术决策记录：v0.2.4 的瞬时检测因 DOM 重建时序问题失败（iframe 异步后挂载），改为轮询探测（150ms × 15 次）解决。
- 退避策略：初始间隔 × 1.2 倍递增，上限 2000ms。
- MutationObserver 过滤优化：忽略占位卡片和 iframe wrapper 内部的 DOM 变化，减少无效扫描。

#### v0.2.2（2026-02-22）
- 修复样式残留问题，完善越狱 CSS 规则。
- 验证通过，确认原生级 UI 融合效果。

#### v0.2.0（2026-02-22）
- 引入"样式越狱"机制，强制清除 CodeMirror 6 和 Tailwind 的干扰样式。
- 技术决策记录：现代前端框架的虚拟 DOM 和 Tailwind 样式层叠极大增加了外部脚本注入难度，采用"借力打力"策略——不自建渲染器，利用原生 Action 按钮 + DOM 空间转移实现原生级融合。
- CM6 编辑器改为"软隐藏"（透明化 + 脱离文档流），保持存活接收流式数据。
- 占位卡片交互优化（spinner + 状态文本）。

#### v0.1.0（2026-02-22）
- 初版"遮点挪"原型。
- 基本流程跑通，但存在选择器失效、布局重叠等问题。
