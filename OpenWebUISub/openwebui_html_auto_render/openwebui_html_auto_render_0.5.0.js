// ==UserScript==
// @name         OpenWebUI HTML Auto-Render(遮点挪)
// @namespace    http(s)://your.openwebui.url/*
// @version      0.5.3
// @description  自动将 HTML 代码块原位渲染为 iframe 预览。v0.5.3: 截图引擎替换为 dom-to-image-more（SVG foreignObject），特效100%保真；智能内容区域检测，精确截取卡片区；圆角保留。
// @author       B3000Kcn & DBL1F7E5
// @match        http(s)://your.openwebui.url/*
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

        // v0.5.3: dom-to-image-more (SVG foreignObject 截图引擎)
        DOMTOIMAGE_CDN: 'https://cdn.jsdelivr.net/npm/dom-to-image-more@3/dist/dom-to-image-more.min.js',
        DOMTOIMAGE_LOAD_TIMEOUT_MS: 12000,

        //截图分辨率倍率(2=2x高清, 3=3x超清; 触屏设备自动降1级)
        CAPTURE_SCALE: 3,

        TOAST_MS: 1600,
        DEBUG: true,
    };

    function log(...args) {
        if (CONFIG.DEBUG) console.log('[遮点挪]', ...args);
    }

    // ========== CSS 注入(兼容油猴/非油猴) ==========

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
            box-shadow: none !important;padding: 0 !important;
            margin: 16px 0 8px 0 !important;min-height: auto !important;
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
            min-height: auto !important;}
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

        /* ===== v0.5.0+: iframe 右上角工具栏 ===== */
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
            pointer-events: none;
        }
        .vcp-html-iframe-wrapper:hover .vcp-iframe-toolbar {
            opacity: 1;
            transform: translateY(0);
            pointer-events: auto;
        }
        @media (hover: none) {
            .vcp-iframe-toolbar {
                opacity: 0;
                transform: translateY(-2px);
                pointer-events: none;
            }
            .vcp-html-iframe-wrapper.vcp-toolbar-visible .vcp-iframe-toolbar {
                opacity: 0.85;
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

    // ========== dom-to-image-more 动态加载 (顶层页面) ==========

    let domToImagePromise = null;

    function findDomToImage() {
        if (typeof window.domtoimage === 'object' && window.domtoimage) return window.domtoimage;
        try { if (typeof unsafeWindow !== 'undefined' && unsafeWindow.domtoimage) return unsafeWindow.domtoimage; } catch (_) {}
        try { if (typeof globalThis !== 'undefined' && globalThis.domtoimage) return globalThis.domtoimage; } catch (_) {}
        return null;
    }

    function ensureDomToImageLoaded() {
        const existing = findDomToImage();
        if (existing) return Promise.resolve(existing);
        if (domToImagePromise) return domToImagePromise;

        domToImagePromise = new Promise((resolve, reject) => {
            const existingTag = document.querySelector('script[data-vcp-domtoimage="1"]');
            if (existingTag) {
                let polls = 0;
                const poll = () => {
                    const fn = findDomToImage();
                    if (fn) return resolve(fn);
                    if (++polls > 40) return reject(new Error('dom-to-image-more poll timeout'));
                    setTimeout(poll, 300);
                };
                poll();return;
            }

            const script = document.createElement('script');
            script.async = true;
            script.src = CONFIG.DOMTOIMAGE_CDN;
            script.setAttribute('data-vcp-domtoimage', '1');

            const timeout = setTimeout(() => reject(new Error('dom-to-image-more load timeout')), CONFIG.DOMTOIMAGE_LOAD_TIMEOUT_MS);

            script.onload = () => {
                clearTimeout(timeout);
                let polls = 0;
                const poll = () => {
                    const fn = findDomToImage();
                    if (fn) {
                        log('dom-to-image-more(顶层) 加载成功');
                        return resolve(fn);
                    }
                    if (++polls > 20) return reject(new Error('dom-to-image-more loaded but not found on any window'));
                    setTimeout(poll, 100);
                };
                poll();
            };
            script.onerror = () => {
                clearTimeout(timeout);
                reject(new Error('dom-to-image-more load error'));
            };

            (document.head || document.documentElement).appendChild(script);
        }).catch((err) => {
            domToImagePromise = null;
            throw err;
        });

        return domToImagePromise;
    }

    // ========== v0.5.3: 优先在 iframe 自己的 window 内加载 dom-to-image-more ==========

    function ensureDomToImageLoadedInWindow(win, doc) {
        return new Promise((resolve, reject) => {
            try {
                if (win && typeof win.domtoimage === 'object' && win.domtoimage) return resolve(win.domtoimage);} catch (_) { /* ignore */ }

            if (!win || !doc) {
                reject(new Error('no iframe window/doc'));
                return;
            }

            const existing = doc.querySelector('script[data-vcp-domtoimage="1"]');
            if (!existing) {
                const script = doc.createElement('script');
                script.async = true;
                script.src = CONFIG.DOMTOIMAGE_CDN;
                script.setAttribute('data-vcp-domtoimage', '1');

                const timeout = setTimeout(() => reject(new Error('iframe dom-to-image-more load timeout')), CONFIG.DOMTOIMAGE_LOAD_TIMEOUT_MS);

                script.onload = () => {
                    clearTimeout(timeout);
                    let polls = 0;
                    const poll = () => {
                        try {
                            if (typeof win.domtoimage === 'object' && win.domtoimage) {
                                log('dom-to-image-more(iframe) 加载成功');
                                return resolve(win.domtoimage);
                            }
                        } catch (_) { /* ignore */ }
                        if (++polls > 30) return reject(new Error('iframe dom-to-image-more loaded but not found'));
                        setTimeout(poll, 100);
                    };
                    poll();
                };
                script.onerror = () => {
                    clearTimeout(timeout);
                    reject(new Error('iframe dom-to-image-more load error'));
                };

                (doc.head || doc.documentElement).appendChild(script);
                return;
            }

            // script已存在：轮询等对象出现
            let polls = 0;
            const poll = () => {
                try {
                    if (typeof win.domtoimage === 'object' && win.domtoimage) return resolve(win.domtoimage);
                } catch (_) { /* ignore */ }
                if (++polls > 60) return reject(new Error('iframe dom-to-image-more poll timeout'));
                setTimeout(poll, 100);
            };
            poll();
        });
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
            toast.classList.remove('vcp-show');
            toast.offsetHeight;
            toast.classList.add('vcp-show');

            setTimeout(() => toast.classList.remove('vcp-show'), CONFIG.TOAST_MS);
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
                    resolve();return;
                }
            } catch (_) {}

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

    // ========== v0.5.3: 智能内容区域检测 ==========

    function findCaptureTarget(doc) {
        const body = doc.body;
        if (!body) return doc.documentElement || body;

        const view = doc.defaultView;
        if (!view) return body;

        // 过滤出可见的、有内容的子元素
        const visible = Array.from(body.children).filter(el => {
            //跳过非内容元素
            const tag = el.tagName;
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK' || tag === 'META' || tag === 'NOSCRIPT') return false;

            // 跳过隐藏元素
            try {
                const s = view.getComputedStyle(el);
                if (s.display === 'none' || s.visibility === 'hidden') return false;
            } catch (_) { return false; }

            // 跳过零尺寸元素
            if (el.offsetWidth <= 0 && el.offsetHeight <= 0) return false;

            return true;
        });

        if (visible.length === 1) {
            // 最常见场景：body 下只有一个卡片容器
            // 直接截取它→ 精确到卡片边缘，body padding 自然排除，圆角保留
            log('findCaptureTarget: 单容器模式, 精确截取', visible[0].tagName, visible[0].className || '');
            return visible[0];
        }

        if (visible.length === 0) {
            log('findCaptureTarget: 无可见子元素, 回退 body');
            return body;
        }

        // 多个可见子元素 → 截取 body
        log('findCaptureTarget: 多容器(', visible.length, '个), 截取 body');
        return body;
    }

    // ========== v0.5.3: 截取 iframe 内容为Blob ==========

    async function captureIframeToBlob(wrapper) {
        const iframe = wrapper && wrapper.querySelector && wrapper.querySelector('iframe');
        if (!iframe) throw new Error('iframe not found');

        try { await waitForIframeReady(iframe,6000); } catch (_) {}

        const doc = getIframeDocument(iframe);
        if (!doc) throw new Error('cannot access iframe document (sandbox/origin?)');

        // 优先在 iframe 内加载 dom-to-image-more（确保样式计算在同一 window 上下文）
        let dti = null;
        try {
            dti = await ensureDomToImageLoadedInWindow(iframe.contentWindow, doc);
        } catch (e) {
            log('iframe 内加载 dom-to-image-more 失败，fallback 顶层:', e);
            dti = await ensureDomToImageLoaded();
        }

        // 智能选择截取目标：有内容才算卡片区
        const target = findCaptureTarget(doc);

        //使用 scrollWidth/scrollHeight 防止内容被裁切（解决右边/下边被吃掉的问题）
        const contentWidth = Math.max(target.offsetWidth || 0, target.scrollWidth || 0, target.clientWidth || 0);
        const contentHeight = Math.max(target.offsetHeight || 0, target.scrollHeight || 0, target.clientHeight || 0);

        // 高分辨率缩放：触屏设备降1 级避免内存压力
        let scale = CONFIG.CAPTURE_SCALE;
        try {
            if (window.matchMedia && window.matchMedia('(hover: none)').matches) {
                scale = Math.max(1, scale - 1);
            }
        } catch (_) {}

        log('capture: target=', target.tagName, (target.className || ''),
            'size=', contentWidth, 'x', contentHeight, 'scale=', scale);

        // dom-to-image-more 高DPI 标准方案:
        //   style.transform: scale(N) →内容放大 N 倍
        //   style.width/height: 固定原始尺寸防止 reflow
        //   width/height: 输出canvas 尺寸 = 原始 × N
        const blob = await dti.toBlob(target, {
            width: contentWidth * scale,
            height: contentHeight * scale,
            style: {
                'transform': 'scale(' + scale + ')',
                'transform-origin': 'top left',
                'width': contentWidth + 'px',
                'height': contentHeight + 'px',},
        });

        if (!blob) throw new Error('dom-to-image-more toBlob returned null');

        return blob;
    }

    // ========== 下载/复制 ==========

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
        const item = new ClipboardItem({'image/png': blob });
        await navigator.clipboard.write([item]);
    }

    async function onCopyImage(wrapper, btn) {
        const oldText = btn.textContent;
        btn.disabled = true;
        btn.textContent = '复制中';

        try {
            const blob = await captureIframeToBlob(wrapper);
            await copyImageBlobToClipboard(blob);
            showToast(wrapper, '已复制');
        } catch (e) {
            log('copy failed, fallback to download:', e);
            try {
                const blob = await captureIframeToBlob(wrapper);
                await downloadPngBlob(blob, `html-preview-${Date.now()}.png`);
                showToast(wrapper, '剪贴板不可用,已保存到本地');
            } catch (e2) {
                log('fallback download failed:', e2);
                showToast(wrapper, '复制失败: ' + (e2.message || e2));
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
            const blob = await captureIframeToBlob(wrapper);
            await downloadPngBlob(blob, `html-preview-${Date.now()}.png`);
            showToast(wrapper, '已保存');
        } catch (e) {
            log('save failed:', e);
            showToast(wrapper, '保存失败: ' + (e.message || e));
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

        try {
            const isTouch = window.matchMedia && window.matchMedia('(hover: none)').matches;
            if (isTouch) {
                wrapper.addEventListener('click', (e) => {
                    if (e.target.closest('.vcp-iframe-toolbar')) return;
                    wrapper.classList.toggle('vcp-toolbar-visible');
                });
            }
        } catch (_) { /* ignore */ }
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
            btnObserver: null,
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
            blocks.push({ index: parseInt(match[1]), html: match[2].trim() });
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

    // ========== 快速路径(刷新/历史消息) ==========

    function tryFastPath(msgContainer, blocks) {
        return new Promise((resolve) => {
            const btn = findActionBtn(msgContainer);
            if (!btn) {
                log('快速路径: Action按钮不存在, 走正常流程');
                resolve(false);
                return;
            }

            const iframe = findIframe(msgContainer);
            if (iframe) {
                log('快速路径: iframe 已存在,尝试拆分搬运');
                const success = doFastSplit(msgContainer, blocks, iframe);
                resolve(success);
                return;
            }

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
            log('快速路径: 母文档块数', splitBlocks.length, '大于 DOM 块数', blocks.length, ',放弃快速路径');
            return false;
        }

        if (splitBlocks.length >0 && splitBlocks.length === blocks.length) {
            log('快速路径: srcdoc 拆分成功,', splitBlocks.length, '个块');
            for (let i = 0; i < blocks.length; i++) {
                applyJailbreak(blocks[i]);if (!blocks[i].querySelector('.vcp-html-iframe-wrapper')) {
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
            log('快速路径: 无分隔标记或数量不匹配, 回退到 CM源码自渲染');
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
        if (embedsContainer) embedsContainer.classList.add('vcp-html-embeds-emptied');

        markAsRendered(msgContainer);
        log('快速路径: 完成');
        return true;
    }

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
            task.placeholders[i].remove();}

        const embedsContainer = findEmbedsContainer(task.msgContainer);
        if (embedsContainer) embedsContainer.classList.add('vcp-html-embeds-emptied');

        markAsRendered(task.msgContainer);
        task.phase = 'done';
        task.expectedBlocks = null;
        task.pendingSplitBlocks = null;
        log('Finalize: 完成! 共处理', task.blocks.length, '个气泡');
        return true;
    }

    // ========== 第一步: 遮(消息级收集) ==========

    function phase1_cover(langContainer) {
        if (processedBlocks.has(langContainer)) return;
        processedBlocks.add(langContainer);

        const msgContainer = findMsgContainer(langContainer);
        if (!msgContainer) {
            log('遮: 找不到消息容器,跳过');
            return;
        }

        if (msgContainer.getAttribute(CONFIG.MSG_RENDERED_ATTR) === 'true') {
            log('遮: 消息已标记渲染完成, 跳过');
            return;
        }

        const task = getOrCreateTask(msgContainer);

        if (task.phase !== 'collecting') {
            log('遮: 任务已在', task.phase, '阶段, 新块重入任务并回滚到 collecting');
            cancelInFlight(task, 'late block rejoin');
            task.phase = 'collecting';}

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

        if (tryFinalizeWithPending(task)) return;

        const existingBtn = findActionBtn(msgContainer);
        if (existingBtn) {
            log('遮: Action 按钮已存在, 立即触发');
            triggerAction(task);
            return;
        }

        startBtnWatch(task);
    }

    // ========== Action 按钮出现监听 ==========

    function startBtnWatch(task) {
        if (task.phase !== 'collecting') return;
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

                if (needMoreBlocks(task)) {
                    log('按钮出现但仍缺块: 期望', task.expectedBlocks, '当前', task.blocks.length);
                    return;
                }

                if (tryFinalizeWithPending(task)) return;
                triggerAction(task);
            }
        });

        task.btnObserver.observe(task.msgContainer, { childList: true, subtree: true });
    }

    function cleanupBtnWatch(task) {
        if (task.btnObserver) {
            task.btnObserver.disconnect();
            task.btnObserver = null;
        }
    }

    // ========== 第二步: 点(统一触发 Action) ==========

    function triggerAction(task) {
        if (task.phase !== 'collecting') return;

        if (needMoreBlocks(task)) {
            log('点: 检测到仍缺块(期望', task.expectedBlocks, '当前', task.blocks.length,'),延迟点击');
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

        const iframe = findIframe(task.msgContainer);
        if (iframe) {
            log('点: iframe 已存在, 跳过点击直接搬运');
            task.phase = 'moving';
            doSplitAndMove(task, iframe, token);
            return;
        }

        probeIframeThenClick(task, token);
    }

    function probeIframeThenClick(task, token) {
        let probes = 0;
        const maxProbes = CONFIG.FAST_PROBE_MAX;

        const probe = () => {
            if (task.cancelToken !== token) return;
            if (task.phase !== 'clicking') return;

            const iframe = findIframe(task.msgContainer);
            if (iframe) {
                log('点: 探测到 iframe 已存在(刷新场景), 跳过点击直接搬运');
                task.phase = 'moving';
                doSplitAndMove(task, iframe, token);
                return;
            }
            if (++probes < maxProbes) {
                setTimeout(probe, CONFIG.FAST_PROBE_INTERVAL);
                return;
            }
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
                if (retries % 10 === 0) log('点: 等待 Action 按钮...重试', retries, '间隔', Math.round(interval) +'ms');
                interval = Math.min(interval * CONFIG.RETRY_BACKOFF, CONFIG.RETRY_MAX_INTERVAL);
                setTimeout(tryClick, interval);
            }
        };

        tryClick();
    }

    // ========== 第三步:挪(拆分 + 分别定位) ==========

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

        if (splitBlocks.length > 0 && splitBlocks.length > task.blocks.length) {
            log('挪: 母文档块数', splitBlocks.length, '大于 DOM 块数', task.blocks.length, '→ 回滚到 collecting等DOM 追上');
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
            }} else if (task.blocks.length === 1) {
            log('挪: 单气泡模式, 直接搬运');
            const wrapper = document.createElement('div');
            wrapper.className = 'vcp-html-iframe-wrapper';
            wrapper.appendChild(iframe);
            attachToolbar(wrapper);
            task.blocks[0].insertBefore(wrapper, task.placeholders[0]);
            task.placeholders[0].remove();
        } else {
            log('挪: 拆分失败 (srcdoc块数:', splitBlocks.length, ', DOM块数:', task.blocks.length,'), 回退CM 自渲染');
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
        if (embedsContainer) embedsContainer.classList.add('vcp-html-embeds-emptied');

        markAsRendered(task.msgContainer);
        task.phase = 'done';
        task.expectedBlocks = null;
        task.pendingSplitBlocks = null;
        log('挪: 完成! 共处理', task.blocks.length, '个气泡');
    }

    // ========== MutationObserver ==========

    let initialScanDone = false;

    function scanForHtmlBlocks() {
        if (!initialScanDone) return;
        const containers = document.querySelectorAll(CONFIG.CODE_SELECTOR);
        for (const el of containers) {
            if (!processedBlocks.has(el)) {
                if (el.querySelector('.cm-content')) {
                    phase1_cover(el);
                }}
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

        initialScanDone = true;scanForHtmlBlocks();
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

    observer.observe(document.body, { childList: true, subtree: true });
    initialScan();

    log('脚本已启动 v0.5.3(截图引擎: dom-to-image-more SVG foreignObject | 智能内容区域检测 | 圆角保留)');
})();
