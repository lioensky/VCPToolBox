// ==UserScript==
// @name         OpenWebUI HTML Auto-Render（遮点挪）
// @namespace    http(s)://your.openwebui.url/*
// @version      0.5.0
// @description  自动将 HTML 代码块原位渲染为 iframe 预览。v0.5.0: iframe 右上角加入“复制/保存”悬浮按钮（触屏常显），支持复制为图像/保存到本地；html2canvas 运行时动态加载，便于非油猴环境拆分复用。
// @author       B3000Kcn & DBL1F7E5
// @match        *://*/*
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        CODE_SELECTOR: '.language-html',
        ACTION_BTN_SELECTOR: 'button[aria-label="HTML Live Preview"]',
        IFRAME_SELECTOR: 'iframe[title="Embedded Content"]',
        EMBEDS_CONTAINER_PATTERN: /^.+-embeds-\d+$/,
        MSG_RENDERED_ATTR: 'data-vcp-html-rendered',

        CLICK_RETRY_INTERVAL: 200,
        MOVE_RETRY_INTERVAL: 150,
        RETRY_BACKOFF: 1.2,
        RETRY_MAX_INTERVAL: 2000,

        FAST_PROBE_INTERVAL: 150,
        FAST_PROBE_MAX: 15,

        // v0.5.0: 截图/复制/保存工具栏
        HTML2CANVAS_CDN: 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
        HTML2CANVAS_LOAD_TIMEOUT_MS: 12000,
        CAPTURE_MAX_CANVAS_DIM: 16384, // 常见浏览器 canvas 单边上限（不同实现略有差异）
        CAPTURE_MAX_SCALE: 3,          // 桌面尽量清晰；移动端会自动降到 2
        CAPTURE_TRIM_ALPHA_THRESHOLD: 8, // 导出时裁切透明边缘：alpha 阈值
        CAPTURE_TRIM_PADDING: 2,         // 裁切后保留像素边距，避免切掉抗锯齿
        TOAST_MS: 1600,

        DEBUG: true,
    };

    function log(...args) {
        if (CONFIG.DEBUG) console.log('[遮点挪]', ...args);
    }

    // ========== CSS 注入（兼容油猴/非油猴） ==========

    function addStyle(cssText) {
        try {
            if (typeof GM_addStyle === 'function') {
                GM_addStyle(cssText);
                return;
            }
        } catch (_) { /* ignore */ }

        const style = document.createElement('style');
        style.setAttribute('data-vcp-style', 'openwebui_html_auto_render');
        style.textContent = cssText;
        (document.head || document.documentElement).appendChild(style);
    }

    // ========== DOM 工具函数 ==========

    function getCodeMirrorText(cmContent) {
        const lines = cmContent.querySelectorAll('.cm-line');
        if (lines.length > 0) return Array.from(lines).map(l => l.textContent).join('\n');
        return cmContent.textContent || '';
    }

    function findMsgContainer(el) {
        let node = el;
        while (node && node !== document.body) {
            if (node.id && node.id.startsWith('message-')) return node;
            node = node.parentElement;
        }
        return el.closest('[class*="message"]') || el.closest('article') || el.closest('[data-message-id]');
    }

    function findActionBtn(msgContainer) {
        if (!msgContainer) return null;
        return msgContainer.querySelector(CONFIG.ACTION_BTN_SELECTOR);
    }

    function findIframe(msgContainer) {
        if (!msgContainer) return null;
        return msgContainer.querySelector(CONFIG.IFRAME_SELECTOR);
    }

    function findEmbedsContainer(msgContainer) {
        if (!msgContainer) return null;
        const allDivs = msgContainer.querySelectorAll('div[id]');
        for (const div of allDivs) {
            if (CONFIG.EMBEDS_CONTAINER_PATTERN.test(div.id)) return div;
        }
        return null;
    }

    // ========== 样式 ==========

    addStyle(`
        .vcp-html-placeholder {
            position: relative;
            border: 1px solid rgba(79, 172, 254, 0.3);
            border-radius: 12px;
            padding: 16px;
            margin: 8px 0;
            background: rgba(79, 172, 254, 0.05);
            min-height: 60px;
            overflow: hidden;
        }
        .dark .vcp-html-placeholder {
            background: rgba(79, 172, 254, 0.08);
            border-color: rgba(79, 172, 254, 0.25);
        }
        .vcp-html-placeholder .vcp-status {
            display: flex;
            align-items: center;
            gap: 8px;
            color: #4facfe;
            font-size: 13px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }
        .vcp-html-placeholder .vcp-spinner {
            width: 14px; height: 14px;
            border: 2px solid rgba(79,172,254,0.3);
            border-top-color: #4facfe;
            border-radius: 50%;
            animation: vcp-html-spin 0.8s linear infinite;
        }
        @keyframes vcp-html-spin {
            to { transform: rotate(360deg); }
        }

        .vcp-html-jailbroken {
            border: none !important;
            background: transparent !important;
            box-shadow: none !important;
            padding: 0 !important;
            margin: 16px 0 8px 0 !important;
            min-height: auto !important;
            overflow: visible !important;
        }
        .vcp-html-jailbroken,
        .vcp-html-jailbroken > * {
            transform: none !important;
        }
        .vcp-html-jailbroken {
            margin-top: 16px !important;
        }
        .vcp-html-jailbroken > *:not(.language-html) {
            display: none !important;
        }
        .vcp-html-jailbroken .language-html {
            position: relative !important;
            overflow: visible !important;
            margin: 0 !important;
            padding: 0 !important;
            border: none !important;
            background: transparent !important;
            min-height: auto !important;
        }
        .vcp-html-jailbroken .language-html > *:not(.vcp-html-placeholder):not(.vcp-html-iframe-wrapper):not(div[id^="code-textarea-"]) {
            display: none !important;
        }

        .vcp-html-cm-hidden {
            position: absolute !important;
            top: 0; left: 0;
            width: 100%; height: 100px;
            opacity: 0.001;
            pointer-events: none;
            z-index: -1;
            clip-path: inset(0 0 100% 0);
        }

        .vcp-html-embeds-emptied {
            display: none !important;
        }

        .vcp-html-iframe-wrapper {
            position: relative;
            margin: 8px 0;
            border-radius: 8px;
            overflow: hidden;
        }
        .vcp-html-iframe-wrapper iframe {
            width: 100%;
            border: none;
            display: block;
            overflow: hidden;
        }

        /* ===== v0.5.0: iframe 右上角工具栏 ===== */
        .vcp-iframe-toolbar {
            position: absolute;
            top: 8px;
            right: 8px;
            display: flex;
            gap: 6px;
            z-index: 9999;
            opacity: 0;
            transform: translateY(-2px);
            transition: opacity 120ms ease, transform 120ms ease;
            pointer-events: none; /* 默认不抢焦点，hover 时再开启 */
        }
        .vcp-html-iframe-wrapper:hover .vcp-iframe-toolbar {
            opacity: 1;
            transform: translateY(0);
            pointer-events: auto;
        }
        @media (hover: none) {
            /* 触屏设备没有 hover：常显但半透明 */
            .vcp-iframe-toolbar {
                opacity: 0.72;
                transform: translateY(0);
                pointer-events: auto;
            }
        }
        .vcp-iframe-toolbar button {
            appearance: none;
            border: 1px solid rgba(255,255,255,0.20);
            background: rgba(0,0,0,0.55);
            color: #fff;
            padding: 5px 10px;
            border-radius: 8px;
            font-size: 12px;
            line-height: 1;
            cursor: pointer;
            user-select: none;
            -webkit-tap-highlight-color: transparent;
            backdrop-filter: blur(8px);
        }
        .vcp-iframe-toolbar button:hover {
            background: rgba(0,0,0,0.70);
        }
        .vcp-iframe-toolbar button:active {
            background: rgba(0,0,0,0.78);
            transform: translateY(0.5px);
        }
        .vcp-iframe-toolbar button:disabled {
            opacity: 0.55;
            cursor: not-allowed;
        }

        .vcp-iframe-toast {
            position: absolute;
            top: 42px;
            right: 8px;
            z-index: 9999;
            padding: 6px 10px;
            border-radius: 10px;
            background: rgba(0,0,0,0.72);
            color: rgba(255,255,255,0.95);
            font-size: 12px;
            line-height: 1.2;
            border: 1px solid rgba(255,255,255,0.18);
            backdrop-filter: blur(10px);
            pointer-events: none;
            opacity: 0;
            transform: translateY(-2px);
            transition: opacity 120ms ease, transform 120ms ease;
        }
        .vcp-iframe-toast.vcp-show {
            opacity: 1;
            transform: translateY(0);
        }
    `);

    // ========== v0.5.0: html2canvas 动态加载 ==========
    // 油猴沙箱隔离说明：
    // Firefox Tampermonkey/Violentmonkey 的脚本运行在 moz-extension:// 沙箱中，
    // 通过 document.createElement('script') 注入的库会挂到页面 window 而非沙箱 window。
    // 因此需要通过 unsafeWindow（油猴提供）或页面 window 来访问。

    let html2canvasPromise = null;

    /** 从所有可能的全局对象上查找 html2canvas */
    function findHtml2Canvas() {
        // 1. 当前作用域 window（非油猴环境 / 油猴 @grant none 模式）
        if (typeof window.html2canvas === 'function') return window.html2canvas;
        // 2. 油猴 unsafeWindow（沙箱模式下页面真实 window）
        try { if (typeof unsafeWindow !== 'undefined' && typeof unsafeWindow.html2canvas === 'function') return unsafeWindow.html2canvas; } catch (_) {}
        // 3. globalThis 兜底
        try { if (typeof globalThis !== 'undefined' && typeof globalThis.html2canvas === 'function') return globalThis.html2canvas; } catch (_) {}
        return null;
    }

    function ensureHtml2CanvasLoaded() {
        const existing = findHtml2Canvas();
        if (existing) return Promise.resolve(existing);
        if (html2canvasPromise) return html2canvasPromise;

        html2canvasPromise = new Promise((resolve, reject) => {
            // 检查是否已有注入的 script 标签（避免重复注入）
            const existingTag = document.querySelector('script[data-vcp-html2canvas="1"]');
            if (existingTag) {
                // 标签存在但函数还没挂上，可能正在加载，轮询等待
                let polls = 0;
                const poll = () => {
                    const fn = findHtml2Canvas();
                    if (fn) return resolve(fn);
                    if (++polls > 40) return reject(new Error('html2canvas poll timeout'));
                    setTimeout(poll, 300);
                };
                poll();
                return;
            }

            const script = document.createElement('script');
            script.async = true;
            script.src = CONFIG.HTML2CANVAS_CDN;
            script.setAttribute('data-vcp-html2canvas', '1');

            const timeout = setTimeout(() => {
                reject(new Error('html2canvas load timeout'));
            }, CONFIG.HTML2CANVAS_LOAD_TIMEOUT_MS);

            script.onload = () => {
                clearTimeout(timeout);
                // 注入的脚本挂到页面 window，需要通过 unsafeWindow 或轮询获取
                let polls = 0;
                const poll = () => {
                    const fn = findHtml2Canvas();
                    if (fn) {
                        log('html2canvas 加载成功');
                        return resolve(fn);
                    }
                    if (++polls > 20) return reject(new Error('html2canvas loaded but not found on any window'));
                    setTimeout(poll, 100);
                };
                poll();
            };
            script.onerror = () => {
                clearTimeout(timeout);
                reject(new Error('html2canvas load error'));
            };

            (document.head || document.documentElement).appendChild(script);
        }).catch((err) => {
            // 允许后续重试
            html2canvasPromise = null;
            throw err;
        });

        return html2canvasPromise;
    }

    function showToast(wrapper, message) {
        try {
            if (!wrapper) return;
            let toast = wrapper.querySelector('.vcp-iframe-toast');
            if (!toast) {
                toast = document.createElement('div');
                toast.className = 'vcp-iframe-toast';
                wrapper.appendChild(toast);
            }
            toast.textContent = message;
            // 重触发动画
            toast.classList.remove('vcp-show');
            // eslint-disable-next-line no-unused-expressions
            toast.offsetHeight;
            toast.classList.add('vcp-show');

            setTimeout(() => {
                toast.classList.remove('vcp-show');
            }, CONFIG.TOAST_MS);
        } catch (_) { /* ignore */ }
    }

    function waitForIframeReady(iframe, timeoutMs = 8000) {
        return new Promise((resolve, reject) => {
            if (!iframe) return reject(new Error('no iframe'));

            const done = () => {
                cleanup();
                resolve();
            };
            const fail = (e) => {
                cleanup();
                reject(e);
            };
            const onLoad = () => done();

            let timer = setTimeout(() => fail(new Error('iframe load timeout')), timeoutMs);

            function cleanup() {
                clearTimeout(timer);
                timer = null;
                iframe.removeEventListener('load', onLoad);
            }

            try {
                const doc = iframe.contentDocument;
                if (doc && doc.readyState === 'complete') {
                    cleanup();
                    resolve();
                    return;
                }
            } catch (_) {
                // 访问被拒绝的情况交给后续 capture 处理
            }

            iframe.addEventListener('load', onLoad, { once: true });
        });
    }

    function getIframeDocument(iframe) {
        try {
            return iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document) || null;
        } catch (e) {
            return null;
        }
    }

    function canvasToBlob(canvas, type = 'image/png', quality) {
        return new Promise((resolve, reject) => {
            try {
                canvas.toBlob((blob) => {
                    if (blob) resolve(blob);
                    else reject(new Error('toBlob returned null (canvas may be tainted)'));
                }, type, quality);
            } catch (e) {
                reject(e);
            }
        });
    }

    // v0.5.0+: 导出时只保留“有内容的部分”
    // 通过扫描 alpha 裁切掉四周透明留白（同时能消除透明圆角）
    function trimTransparentEdges(canvas, alphaThreshold = 8, padding = 2) {
        try {
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) return canvas;

            const w = canvas.width;
            const h = canvas.height;
            if (w <= 2 || h <= 2) return canvas;

            const img = ctx.getImageData(0, 0, w, h);
            const data = img.data;

            const rowHasInk = (y) => {
                const rowStart = y * w * 4;
                for (let x = 0; x < w; x++) {
                    const a = data[rowStart + x * 4 + 3];
                    if (a > alphaThreshold) return true;
                }
                return false;
            };

            const colHasInk = (x) => {
                const colOffset = x * 4 + 3;
                for (let y = 0; y < h; y++) {
                    const a = data[y * w * 4 + colOffset];
                    if (a > alphaThreshold) return true;
                }
                return false;
            };

            let top = 0;
            while (top < h && !rowHasInk(top)) top++;

            let bottom = h - 1;
            while (bottom >= 0 && !rowHasInk(bottom)) bottom--;

            if (top >= bottom) return canvas; // 全透明或几乎无内容

            let left = 0;
            while (left < w && !colHasInk(left)) left++;

            let right = w - 1;
            while (right >= 0 && !colHasInk(right)) right--;

            // padding 防止切掉抗锯齿边缘
            top = Math.max(0, top - padding);
            left = Math.max(0, left - padding);
            right = Math.min(w - 1, right + padding);
            bottom = Math.min(h - 1, bottom + padding);

            const outW = right - left + 1;
            const outH = bottom - top + 1;

            if (outW <= 0 || outH <= 0) return canvas;
            if (outW === w && outH === h) return canvas;

            const out = document.createElement('canvas');
            out.width = outW;
            out.height = outH;
            const outCtx = out.getContext('2d');
            if (!outCtx) return canvas;

            outCtx.drawImage(canvas, left, top, outW, outH, 0, 0, outW, outH);
            return out;
        } catch (e) {
            log('trimTransparentEdges failed:', e);
            return canvas;
        }
    }

    async function captureIframeToCanvas(wrapper) {
        const iframe = wrapper && wrapper.querySelector && wrapper.querySelector('iframe');
        if (!iframe) throw new Error('iframe not found');

        // 尽量等 iframe ready（对自建 iframe 友好）
        try {
            await waitForIframeReady(iframe, 6000);
        } catch (_) { /* ignore */ }

        const doc = getIframeDocument(iframe);
        if (!doc) throw new Error('cannot access iframe document (sandbox/origin?)');

        const root = doc.documentElement;
        const body = doc.body;
        const view = doc.defaultView || window;

        // v0.5.1（行为仍属于 v0.5.0 的补丁）：
        // 为“导出图片”临时注入 reset CSS，去掉我们 wrapIncompleteHtml 带来的 padding，
        // 并尽可能移除圆角/边距（只影响导出，不影响页面展示；导出后立即移除）
        let resetStyle = null;
        try {
            resetStyle = doc.createElement('style');
            resetStyle.setAttribute('data-vcp-capture-reset', '1');
            resetStyle.textContent = `
                html, body {
                    margin: 0 !important;
                    padding: 0 !important;
                    border-radius: 0 !important;
                }
                html, body {
                    background: transparent !important;
                }
            `;
            (doc.head || root || body).appendChild(resetStyle);
        } catch (e) {
            log('capture: inject reset style failed:', e);
        }

        try {
            // 强制一次 layout，确保尺寸计算反映 reset CSS
            try { if (root) root.getBoundingClientRect(); } catch (_) {}

            const width = Math.max(
                root ? root.scrollWidth : 0,
                root ? root.clientWidth : 0,
                body ? body.scrollWidth : 0,
                body ? body.clientWidth : 0,
                1
            );
            const height = Math.max(
                root ? root.scrollHeight : 0,
                root ? root.clientHeight : 0,
                body ? body.scrollHeight : 0,
                body ? body.clientHeight : 0,
                1
            );

            // 提高清晰度：桌面尽量用更高 scale；触屏/移动端自动降到 2，避免内存爆炸
            const maxDim = CONFIG.CAPTURE_MAX_CANVAS_DIM;
            const maxScaleByDim = Math.min(maxDim / width, maxDim / height);

            let maxScale = CONFIG.CAPTURE_MAX_SCALE;
            try {
                const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
                const noHover = window.matchMedia && window.matchMedia('(hover: none)').matches;
                if (coarse || noHover) maxScale = Math.min(maxScale, 2);
            } catch (_) { /* ignore */ }

            const scale = Math.max(1, Math.min(maxScale, maxScaleByDim));

            const html2canvas = await ensureHtml2CanvasLoaded();

            // Debug：确认 padding/radius 来源（用于验证“边距/圆角来自 iframe 内部样式”这个假设）
            try {
                if (view && body) {
                    const csBody = view.getComputedStyle(body);
                    const csHtml = root ? view.getComputedStyle(root) : null;
                    log('capture styles:', {
                        bodyMargin: csBody.margin,
                        bodyPadding: csBody.padding,
                        bodyRadius: csBody.borderRadius,
                        htmlMargin: csHtml ? csHtml.margin : '',
                        htmlPadding: csHtml ? csHtml.padding : '',
                        htmlRadius: csHtml ? csHtml.borderRadius : '',
                    });
                }
            } catch (_) { /* ignore */ }

            log('capture: width=', width, 'height=', height, 'scale=', scale);

            // 注意：如果 iframe 内含跨域图片，canvas 可能 taint，toBlob 会失败（浏览器安全策略）
            const canvas = await html2canvas(body || root, {
                backgroundColor: null,
                useCORS: true,
                allowTaint: false,
                logging: !!CONFIG.DEBUG,
                scale,
                width,
                height,
                windowWidth: width,
                windowHeight: height,
                scrollX: 0,
                scrollY: 0,
            });

            // Debug：角落 alpha（如果出现圆角裁切，四角 alpha 往往会变小/为0）
            try {
                const ctx = canvas.getContext('2d');
                if (ctx) {
                    const w = canvas.width;
                    const h = canvas.height;
                    const alphaAt = (x, y) => ctx.getImageData(x, y, 1, 1).data[3];
                    log('capture corner alpha:', {
                        tl: alphaAt(0, 0),
                        tr: alphaAt(Math.max(0, w - 1), 0),
                        bl: alphaAt(0, Math.max(0, h - 1)),
                        br: alphaAt(Math.max(0, w - 1), Math.max(0, h - 1)),
                    });
                }
            } catch (_) { /* ignore */ }

            return canvas;
        } finally {
            if (resetStyle && resetStyle.parentNode) {
                resetStyle.parentNode.removeChild(resetStyle);
            }
        }
    }

    async function downloadPngBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename || `html-preview-${Date.now()}.png`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    async function copyImageBlobToClipboard(blob) {
        if (!navigator.clipboard || typeof window.ClipboardItem !== 'function') {
            throw new Error('Clipboard API not available');
        }
        const item = new ClipboardItem({ 'image/png': blob });
        await navigator.clipboard.write([item]);
    }

    async function onCopyImage(wrapper, btn) {
        const oldText = btn.textContent;
        btn.disabled = true;
        btn.textContent = '复制中';

        try {
            const canvas = await captureIframeToCanvas(wrapper);
            const trimmed = trimTransparentEdges(canvas, CONFIG.CAPTURE_TRIM_ALPHA_THRESHOLD, CONFIG.CAPTURE_TRIM_PADDING);
            const blob = await canvasToBlob(trimmed, 'image/png');
            await copyImageBlobToClipboard(blob);
            showToast(wrapper, '已复制');
        } catch (e) {
            // 移动端/部分环境下写剪贴板不稳定：降级为下载
            log('copy failed, fallback to download:', e);
            try {
                const canvas = await captureIframeToCanvas(wrapper);
                const trimmed = trimTransparentEdges(canvas, CONFIG.CAPTURE_TRIM_ALPHA_THRESHOLD, CONFIG.CAPTURE_TRIM_PADDING);
                const blob = await canvasToBlob(trimmed, 'image/png');
                await downloadPngBlob(blob, `html-preview-${Date.now()}.png`);
                showToast(wrapper, '剪贴板不可用，已保存到本地');
            } catch (e2) {
                log('fallback download failed:', e2);
                showToast(wrapper, '复制失败（可能含跨域资源）');
            }
        } finally {
            btn.disabled = false;
            btn.textContent = oldText;
        }
    }

    async function onSaveImage(wrapper, btn) {
        const oldText = btn.textContent;
        btn.disabled = true;
        btn.textContent = '保存中';

        try {
            const canvas = await captureIframeToCanvas(wrapper);
            const trimmed = trimTransparentEdges(canvas, CONFIG.CAPTURE_TRIM_ALPHA_THRESHOLD, CONFIG.CAPTURE_TRIM_PADDING);
            const blob = await canvasToBlob(trimmed, 'image/png');
            await downloadPngBlob(blob, `html-preview-${Date.now()}.png`);
            showToast(wrapper, '已保存');
        } catch (e) {
            log('save failed:', e);
            showToast(wrapper, '保存失败（可能含跨域资源）');
        } finally {
            btn.disabled = false;
            btn.textContent = oldText;
        }
    }

    function attachToolbar(wrapper) {
        if (!wrapper) return;
        if (wrapper.querySelector('.vcp-iframe-toolbar')) return;

        const bar = document.createElement('div');
        bar.className = 'vcp-iframe-toolbar';

        const btnCopy = document.createElement('button');
        btnCopy.type = 'button';
        btnCopy.textContent = '复制';
        btnCopy.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            onCopyImage(wrapper, btnCopy);
        });

        const btnSave = document.createElement('button');
        btnSave.type = 'button';
        btnSave.textContent = '保存';
        btnSave.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            onSaveImage(wrapper, btnSave);
        });

        bar.appendChild(btnCopy);
        bar.appendChild(btnSave);

        wrapper.appendChild(bar);
    }

    // ========== 消息级任务管理 ==========

    const processedBlocks = new WeakSet();
    const msgTasks = new Map(); // msgContainer → TaskInfo

    function getOrCreateTask(msgContainer) {
        if (msgTasks.has(msgContainer)) return msgTasks.get(msgContainer);
        const task = {
            msgContainer,
            blocks: [],
            placeholders: [],
            cmContents: [],
            phase: 'collecting',
            btnObserver: null,       // 监听 Action 按钮出现
            cancelToken: 0,
            expectedBlocks: null,
            pendingSplitBlocks: null,
        };
        msgTasks.set(msgContainer, task);
        return task;
    }

    function cancelInFlight(task, reason) {
        task.cancelToken++;
        log('取消进行中的 click/move 循环:', reason, 'token=', task.cancelToken);
    }

    function needMoreBlocks(task) {
        return typeof task.expectedBlocks === 'number' && task.blocks.length < task.expectedBlocks;
    }

    // ========== 越狱 ==========

    function applyJailbreak(langContainer) {
        const outerWrapper = langContainer.parentElement;
        if (outerWrapper && outerWrapper !== document.body) {
            outerWrapper.classList.add('vcp-html-jailbroken');
        }
        const editorContainer = langContainer.querySelector('div[id^="code-textarea-"]');
        if (editorContainer) {
            editorContainer.classList.add('vcp-html-cm-hidden');
        }
    }

    function markAsRendered(msgContainer) {
        if (msgContainer) {
            msgContainer.setAttribute(CONFIG.MSG_RENDERED_ATTR, 'true');
        }
    }

    // ========== srcdoc 拆分 ==========

    function parseSrcdocBlocks(srcdoc) {
        const regex = /<section data-vcp-block="(\d+)">([\s\S]*?)<\/section>/g;
        const blocks = [];
        let match;
        while ((match = regex.exec(srcdoc)) !== null) {
            blocks.push({
                index: parseInt(match[1]),
                html: match[2].trim()
            });
        }
        blocks.sort((a, b) => a.index - b.index);
        return blocks;
    }

    function wrapIncompleteHtml(html) {
        if (/<html/i.test(html)) return html;
        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:16px;margin:0;}</style>
</head>
<body>
${html}
</body>
</html>`;
    }

    function createIframeFromHtml(html) {
        const wrapper = document.createElement('div');
        wrapper.className = 'vcp-html-iframe-wrapper';
        const iframe = document.createElement('iframe');
        iframe.setAttribute('srcdoc', html);
        iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-forms allow-downloads');
        iframe.setAttribute('scrolling', 'no');
        iframe.style.width = '100%';
        iframe.style.border = 'none';
        iframe.style.display = 'block';
        iframe.style.overflow = 'hidden';

        iframe.addEventListener('load', () => {
            try {
                const doc = iframe.contentDocument || iframe.contentWindow.document;
                const resizeToContent = () => {
                    const h = Math.max(
                        doc.documentElement ? doc.documentElement.scrollHeight : 0,
                        doc.body ? doc.body.scrollHeight : 0
                    );
                    if (h > 0) iframe.style.height = h + 'px';
                };
                resizeToContent();
                // 延迟二次测量：等字体/布局稳定后再校准高度，消除首个气泡滚动条
                setTimeout(resizeToContent, 50);
                setTimeout(resizeToContent, 200);
                const ro = new ResizeObserver(resizeToContent);
                ro.observe(doc.documentElement);
            } catch (e) {
                iframe.style.height = '400px';
            }
        });

        wrapper.appendChild(iframe);
        attachToolbar(wrapper);
        return wrapper;
    }

    // ========== 快速路径（刷新/历史消息） ==========

    function tryFastPath(msgContainer, blocks) {
        return new Promise((resolve) => {
            // 快速路径核心改进：如果 Action 按钮已存在，说明消息已完成
            const btn = findActionBtn(msgContainer);
            if (!btn) {
                // 按钮不存在 = 可能是流式中，走正常流程
                log('快速路径: Action 按钮不存在, 走正常流程');
                resolve(false);
                return;
            }

            // 按钮已存在，先检查是否已有 iframe（之前点过 Action）
            const iframe = findIframe(msgContainer);
            if (iframe) {
                log('快速路径: iframe 已存在, 尝试拆分搬运');
                const success = doFastSplit(msgContainer, blocks, iframe);
                resolve(success);
                return;
            }

            // 按钮存在但没有 iframe：直接点击按钮，然后等 iframe 出现
            log('快速路径: Action 按钮已存在, 直接点击');
            btn.click();

            let probeCount = 0;
            const probeIframe = () => {
                const iframeNow = findIframe(msgContainer);
                if (iframeNow) {
                    log('快速路径: 点击后 iframe 出现');
                    const success = doFastSplit(msgContainer, blocks, iframeNow);
                    resolve(success);
                    return;
                }
                if (probeCount < CONFIG.FAST_PROBE_MAX) {
                    probeCount++;
                    setTimeout(probeIframe, CONFIG.FAST_PROBE_INTERVAL);
                    return;
                }
                log('快速路径: 点击后 iframe 未出现, 走正常流程');
                resolve(false);
            };
            probeIframe();
        });
    }

    function doFastSplit(msgContainer, blocks, iframe) {
        const srcdoc = iframe.getAttribute('srcdoc') || '';
        const splitBlocks = parseSrcdocBlocks(srcdoc);

        if (splitBlocks.length > 0 && splitBlocks.length > blocks.length) {
            log('快速路径: 母文档块数', splitBlocks.length, '大于 DOM 块数', blocks.length, '，放弃快速路径');
            return false;
        }

        if (splitBlocks.length > 0 && splitBlocks.length === blocks.length) {
            log('快速路径: srcdoc 拆分成功,', splitBlocks.length, '个块');
            for (let i = 0; i < blocks.length; i++) {
                applyJailbreak(blocks[i]);
                if (!blocks[i].querySelector('.vcp-html-iframe-wrapper')) {
                    const wrapper = createIframeFromHtml(wrapIncompleteHtml(splitBlocks[i].html));
                    blocks[i].appendChild(wrapper);
                }
            }
        } else if (blocks.length === 1) {
            log('快速路径: 单气泡模式, 直接搬运');
            applyJailbreak(blocks[0]);
            if (!blocks[0].querySelector('.vcp-html-iframe-wrapper')) {
                const wrapper = document.createElement('div');
                wrapper.className = 'vcp-html-iframe-wrapper';
                wrapper.appendChild(iframe);
                attachToolbar(wrapper);
                blocks[0].appendChild(wrapper);
            }
        } else {
            log('快速路径: 无分隔标记或数量不匹配, 回退到 CM 源码自渲染');
            for (const block of blocks) {
                applyJailbreak(block);
                if (!block.querySelector('.vcp-html-iframe-wrapper')) {
                    const cm = block.querySelector('.cm-content');
                    if (cm) {
                        const html = getCodeMirrorText(cm);
                        if (html.trim()) {
                            const wrapper = createIframeFromHtml(wrapIncompleteHtml(html));
                            block.appendChild(wrapper);
                        }
                    }
                }
            }
        }

        const embedsContainer = findEmbedsContainer(msgContainer);
        if (embedsContainer) {
            embedsContainer.classList.add('vcp-html-embeds-emptied');
        }
        markAsRendered(msgContainer);
        log('快速路径: 完成');
        return true;
    }

    // ========== finalize（用 pendingSplitBlocks 完成拆分定位） ==========

    function tryFinalizeWithPending(task) {
        if (task.phase !== 'collecting') return false;
        if (!task.pendingSplitBlocks) return false;

        const expected = task.pendingSplitBlocks.length;
        if (task.blocks.length !== expected) return false;

        log('Finalize: 使用 pendingSplitBlocks 完成拆分定位,', expected, '个块');

        for (let i = 0; i < task.blocks.length; i++) {
            const html = wrapIncompleteHtml(task.pendingSplitBlocks[i].html);
            const wrapper = createIframeFromHtml(html);
            task.blocks[i].insertBefore(wrapper, task.placeholders[i]);
            task.placeholders[i].remove();
        }

        const embedsContainer = findEmbedsContainer(task.msgContainer);
        if (embedsContainer) {
            embedsContainer.classList.add('vcp-html-embeds-emptied');
        }

        markAsRendered(task.msgContainer);
        task.phase = 'done';
        task.expectedBlocks = null;
        task.pendingSplitBlocks = null;
        log('Finalize: 完成! 共处理', task.blocks.length, '个气泡');
        return true;
    }

    // ========== 第一步: 遮（消息级收集） ==========

    function phase1_cover(langContainer) {
        if (processedBlocks.has(langContainer)) return;
        processedBlocks.add(langContainer);

        const msgContainer = findMsgContainer(langContainer);
        if (!msgContainer) {
            log('遮: 找不到消息容器, 跳过');
            return;
        }

        if (msgContainer.getAttribute(CONFIG.MSG_RENDERED_ATTR) === 'true') {
            log('遮: 消息已标记渲染完成, 跳过');
            return;
        }

        const task = getOrCreateTask(msgContainer);

        // v0.3.1 保留: 晚到块重入任务并回滚到 collecting
        if (task.phase !== 'collecting') {
            log('遮: 任务已在', task.phase, '阶段, 新块重入任务并回滚到 collecting');
            cancelInFlight(task, 'late block rejoin');
            task.phase = 'collecting';
        }

        const blockIndex = task.blocks.length;
        task.blocks.push(langContainer);

        const cmContent = langContainer.querySelector('.cm-content');
        task.cmContents.push(cmContent);

        applyJailbreak(langContainer);

        const placeholder = document.createElement('div');
        placeholder.className = 'vcp-html-placeholder';
        placeholder.innerHTML = `
            <div class="vcp-status">
                <div class="vcp-spinner"></div>
                <span class="vcp-status-text">HTML 预览加载中... (${blockIndex + 1})</span>
            </div>
        `;
        langContainer.appendChild(placeholder);
        task.placeholders.push(placeholder);

        log('遮: 注册块', blockIndex, '到消息任务, 当前共', task.blocks.length, '块');

        // 尝试 finalize（防止"先拿到母文档再补块"的竞态）
        if (tryFinalizeWithPending(task)) return;

        // v0.4.0 核心: 检查 Action 按钮是否已存在
        const existingBtn = findActionBtn(msgContainer);
        if (existingBtn) {
            // 按钮已存在 = 消息已完成，立即触发
            log('遮: Action 按钮已存在, 立即触发');
            triggerAction(task);
            return;
        }

        // 按钮不存在 = 流式进行中，启动按钮监听
        startBtnWatch(task);
    }

    // ========== v0.4.0 核心: Action 按钮出现监听 ==========

    function startBtnWatch(task) {
        if (task.phase !== 'collecting') return;

        // 已有监听器在跑，不重复创建
        if (task.btnObserver) return;

        log('启动 Action 按钮监听');

        task.btnObserver = new MutationObserver(() => {
            if (task.phase !== 'collecting') {
                cleanupBtnWatch(task);
                return;
            }

            const btn = findActionBtn(task.msgContainer);
            if (btn) {
                log('Action 按钮出现! 立即触发');
                cleanupBtnWatch(task);

                // v0.3.1 保留: 若缺块则不触发
                if (needMoreBlocks(task)) {
                    log('按钮出现但仍缺块: 期望', task.expectedBlocks, '当前', task.blocks.length);
                    return;
                }

                if (tryFinalizeWithPending(task)) return;

                triggerAction(task);
            }
        });

        task.btnObserver.observe(task.msgContainer, {
            childList: true,
            subtree: true,
        });
    }

    function cleanupBtnWatch(task) {
        if (task.btnObserver) {
            task.btnObserver.disconnect();
            task.btnObserver = null;
        }
    }

    // ========== 第二步: 点（统一触发 Action） ==========

    function triggerAction(task) {
        if (task.phase !== 'collecting') return;

        if (needMoreBlocks(task)) {
            log('点: 检测到仍缺块（期望', task.expectedBlocks, '当前', task.blocks.length, '），延迟点击');
            startBtnWatch(task);
            return;
        }

        task.phase = 'clicking';
        const token = ++task.cancelToken;

        log('点: 共', task.blocks.length, '块, 准备点击 Action token=', token);

        for (const ph of task.placeholders) {
            const statusText = ph.querySelector('.vcp-status-text');
            if (statusText) statusText.textContent = '正在渲染预览...';
        }

        // 先检查 iframe 是否已存在（刷新场景：后端保留了 Action 结果）
        const iframe = findIframe(task.msgContainer);
        if (iframe) {
            log('点: iframe 已存在, 跳过点击直接搬运');
            task.phase = 'moving';
            doSplitAndMove(task, iframe, token);
            return;
        }

        // iframe 不在，但可能正在异步渲染中（刷新时 Action 按钮先于 iframe 出现）
        // 先短暂探测 iframe，避免不必要地重新点击 Action
        probeIframeThenClick(task, token);
    }

    /** 短暂探测 iframe 是否即将出现；超时后才真正点击 Action */
    function probeIframeThenClick(task, token) {
        let probes = 0;
        const maxProbes = CONFIG.FAST_PROBE_MAX; // 150ms × 15 = 最多等 2.25s
        const probe = () => {
            if (task.cancelToken !== token) return;
            if (task.phase !== 'clicking') return;

            const iframe = findIframe(task.msgContainer);
            if (iframe) {
                log('点: 探测到 iframe 已存在（刷新场景）, 跳过点击直接搬运');
                task.phase = 'moving';
                doSplitAndMove(task, iframe, token);
                return;
            }
            if (++probes < maxProbes) {
                setTimeout(probe, CONFIG.FAST_PROBE_INTERVAL);
                return;
            }
            // 探测超时：iframe 确实不存在，需要点击 Action
            log('点: 探测超时, iframe 不存在, 执行点击');
            doClick(task, token);
        };
        probe();
    }

    function doClick(task, token) {
        let interval = CONFIG.CLICK_RETRY_INTERVAL;
        let retries = 0;

        const tryClick = () => {
            if (task.cancelToken !== token) return;
            if (task.phase !== 'clicking') return;

            const btn = findActionBtn(task.msgContainer);
            if (btn) {
                log('点: 找到 Action 按钮, 模拟点击');
                btn.click();
                task.phase = 'moving';
                phase3_moveIframe(task, token);
            } else {
                retries++;
                if (retries % 10 === 0) log('点: 等待 Action 按钮... 重试', retries, '间隔', Math.round(interval) + 'ms');
                interval = Math.min(interval * CONFIG.RETRY_BACKOFF, CONFIG.RETRY_MAX_INTERVAL);
                setTimeout(tryClick, interval);
            }
        };

        tryClick();
    }

    // ========== 第三步: 挪（拆分 + 分别定位） ==========

    function phase3_moveIframe(task, token) {
        let interval = CONFIG.MOVE_RETRY_INTERVAL;
        let retries = 0;

        const tryMove = () => {
            if (task.cancelToken !== token) return;
            if (task.phase !== 'moving') return;

            const iframe = findIframe(task.msgContainer);
            if (iframe) {
                log('挪: 找到 iframe, 开始拆分定位');
                doSplitAndMove(task, iframe, token);
            } else {
                retries++;
                if (retries % 10 === 0) log('挪: 等待 iframe... 重试', retries, '间隔', Math.round(interval) + 'ms');
                interval = Math.min(interval * CONFIG.RETRY_BACKOFF, CONFIG.RETRY_MAX_INTERVAL);
                setTimeout(tryMove, interval);
            }
        };

        tryMove();
    }

    function doSplitAndMove(task, iframe, token) {
        if (task.cancelToken !== token) return;

        const srcdoc = iframe.getAttribute('srcdoc') || '';
        const splitBlocks = parseSrcdocBlocks(srcdoc);

        // v0.3.1 保留: 若母文档块数 > DOM 块数，回滚收集
        if (splitBlocks.length > 0 && splitBlocks.length > task.blocks.length) {
            log('挪: 母文档块数', splitBlocks.length, '大于 DOM 块数', task.blocks.length, '→ 回滚到 collecting 等 DOM 追上');
            task.expectedBlocks = splitBlocks.length;
            task.pendingSplitBlocks = splitBlocks;

            cancelInFlight(task, 'splitBlocks > domBlocks rollback');
            task.phase = 'collecting';

            for (const ph of task.placeholders) {
                const statusText = ph.querySelector('.vcp-status-text');
                if (statusText) statusText.textContent = '等待更多代码块出现...';
            }

            startBtnWatch(task);
            return;
        }

        if (splitBlocks.length > 0 && splitBlocks.length === task.blocks.length) {
            log('挪: srcdoc 拆分成功,', splitBlocks.length, '个块');
            for (let i = 0; i < task.blocks.length; i++) {
                const html = wrapIncompleteHtml(splitBlocks[i].html);
                const wrapper = createIframeFromHtml(html);
                task.blocks[i].insertBefore(wrapper, task.placeholders[i]);
                task.placeholders[i].remove();
            }
        } else if (task.blocks.length === 1) {
            log('挪: 单气泡模式, 直接搬运');
            const wrapper = document.createElement('div');
            wrapper.className = 'vcp-html-iframe-wrapper';
            wrapper.appendChild(iframe);
            attachToolbar(wrapper);
            task.blocks[0].insertBefore(wrapper, task.placeholders[0]);
            task.placeholders[0].remove();
        } else {
            log('挪: 拆分失败 (srcdoc块数:', splitBlocks.length, ', DOM块数:', task.blocks.length, '), 回退 CM 自渲染');
            for (let i = 0; i < task.blocks.length; i++) {
                const cm = task.cmContents[i];
                if (cm) {
                    const html = getCodeMirrorText(cm);
                    if (html.trim()) {
                        const wrapper = createIframeFromHtml(wrapIncompleteHtml(html));
                        task.blocks[i].insertBefore(wrapper, task.placeholders[i]);
                    }
                }
                task.placeholders[i].remove();
            }
        }

        const embedsContainer = findEmbedsContainer(task.msgContainer);
        if (embedsContainer) {
            embedsContainer.classList.add('vcp-html-embeds-emptied');
        }

        markAsRendered(task.msgContainer);
        task.phase = 'done';
        task.expectedBlocks = null;
        task.pendingSplitBlocks = null;
        log('挪: 完成! 共处理', task.blocks.length, '个气泡');
    }

    // ========== MutationObserver ==========

    let initialScanDone = false; // 初始扫描完成前，MO 不处理块

    function scanForHtmlBlocks() {
        if (!initialScanDone) return; // 等 initialScan 跑完再接管
        const containers = document.querySelectorAll(CONFIG.CODE_SELECTOR);
        for (const el of containers) {
            if (!processedBlocks.has(el)) {
                if (el.querySelector('.cm-content')) {
                    phase1_cover(el);
                }
            }
        }
    }

    async function initialScan() {
        const containers = document.querySelectorAll(CONFIG.CODE_SELECTOR);
        if (containers.length === 0) {
            initialScanDone = true;
            return;
        }

        const msgGroups = new Map();
        for (const el of containers) {
            if (processedBlocks.has(el)) continue;
            if (!el.querySelector('.cm-content')) continue;
            const msg = findMsgContainer(el);
            if (!msg) continue;
            if (msg.getAttribute(CONFIG.MSG_RENDERED_ATTR) === 'true') continue;
            if (!msgGroups.has(msg)) msgGroups.set(msg, []);
            msgGroups.get(msg).push(el);
        }

        for (const [msgContainer, blocks] of msgGroups) {
            for (const b of blocks) processedBlocks.add(b);

            const fastHandled = await tryFastPath(msgContainer, blocks);
            if (!fastHandled) {
                for (const b of blocks) processedBlocks.delete(b);
                for (const b of blocks) phase1_cover(b);
            }
        }

        initialScanDone = true;
        // 初始扫描完成后，立即补扫一次（捕获扫描期间 MO 漏掉的新块）
        scanForHtmlBlocks();
    }

    const observer = new MutationObserver((mutations) => {
        let hasNewNodes = false;
        for (const m of mutations) {
            if (m.target.closest && m.target.closest('.vcp-html-placeholder')) continue;
            if (m.target.closest && m.target.closest('.vcp-html-iframe-wrapper')) continue;
            if (m.addedNodes.length > 0) {
                hasNewNodes = true;
                break;
            }
        }
        if (hasNewNodes) scanForHtmlBlocks();
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
    });

    initialScan();

    log('脚本已启动 v0.5.0（复制/保存工具栏 + html2canvas 动态加载）');
})();
