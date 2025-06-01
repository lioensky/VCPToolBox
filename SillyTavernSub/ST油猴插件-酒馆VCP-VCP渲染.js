// ==UserScript==
// @name         VCP-ST渲染插件
// @namespace    http://tampermonkey.net/
// @version      1.2 // 版本更新，移除了时钟和VCP按钮，仅保留美化功能
// @description  Prettifies VCP-ToolUse blocks and Maid Diary blocks (hides copy button in VCP blocks) in SillyTavern.
// @author       Xiaoke & Ryan (Modified by Roo)
// @match        *://localhost:8000/*
// @match        *://127.0.0.1:8000/*
// @match        *://*/*:8000/*
// @include      /^https?:\/\/.*:8000\//
// @grant        GM_addStyle
// @run-at       document_idle
// ==/UserScript==

(function() {
    'use strict';

    // Debounce utility for prettifyBlock calls during streaming
    const debounceTimers = new WeakMap();
    const DEBOUNCE_DELAY = 400; // Milliseconds to wait after last text change for general blocks
    const DIARY_DEBOUNCE_DELAY = 3000; // 3 seconds delay for Maid Diary blocks

    console.log('VCPSub Prettifier: Script started.');

    // --- VCP ToolUse and Maid Diary Prettifier ---

    function createVcpPrettifierStyles() {
        GM_addStyle(`
            /* 主气泡样式 - VCP ToolUse */
            .vcp-tool-use-bubble {
                background: linear-gradient(145deg, #3a7bd5 0%, #00d2ff 100%) !important;
                border: 1px solid #2980b9 !important;
                border-radius: 10px !important;
                padding: 8px 15px 8px 35px !important; /* 左边padding加大，给图标留空间 */
                color: #ffffff !important;
                box-shadow: 0 4px 10px rgba(0, 0, 0, 0.3);
                margin-bottom: 10px !important;
                position: relative;
                overflow: visible;
                line-height: 1.5;
            }

            /* 内部 code 和 span 的重置 - VCP ToolUse */
            .vcp-tool-use-bubble code,
            .vcp-tool-use-bubble code span {
                background: none !important; border: none !important;
                padding: 0 !important; margin: 0 !important;
                box-shadow: none !important; color: inherit !important;
                display: inline !important;
                font-family: 'Consolas', 'Monaco', 'Courier New', monospace !important;
                font-size: 0.95em !important;
                vertical-align: baseline;
            }

            /* "VCP-ToolUse:" 标签 */
            .vcp-tool-use-bubble .vcp-tool-label {
                font-weight: bold; color: #f1c40f; margin-right: 6px;
            }

            /* 工具名高亮 - VCP ToolUse */
            .vcp-tool-use-bubble .vcp-tool-name-highlight {
                background-image: linear-gradient(to right,rgb(255, 200, 0), white,rgb(255, 200, 0)) !important;
                -webkit-background-clip: text !important;
                background-clip: text !important;
                -webkit-text-fill-color: transparent !important;
                text-fill-color: transparent !important;
                font-style: normal !important;
                font-weight: bold !important;
                padding: 2px 5px !important;
                border-radius: 4px !important;
            }

            /* 左上角齿轮图标 - VCP ToolUse */
            .vcp-tool-use-bubble::before {
                content: "⚙️";
                position: absolute;
                top: 12px;
                left: 12px;
                font-size: 14px;
                color: rgba(255, 255, 255, 0.75);
                z-index: 1;
                opacity: 0.9;
            }

            /* 隐藏 VCP 气泡内的复制按钮 */
            .vcp-tool-use-bubble code .code-copy {
                display: none !important;
            }

            /* 女仆日记气泡样式 */
            .maid-diary-bubble {
                background: linear-gradient(145deg, #fdeff2 0%, #fce4ec 100%) !important; /* 淡粉色系 */
                border: 1px solid #e91e63 !important; /* 粉色边框 */
                border-radius: 10px !important;
                padding: 8px 15px 8px 35px !important; /* 左边padding加大，给图标留空间 */
                color: #5d4037 !important; /* 深棕色文字 */
                box-shadow: 0 4px 10px rgba(0, 0, 0, 0.15);
                margin-bottom: 10px !important;
                position: relative;
                overflow: visible;
                line-height: 1.5;
            }

            /* 女仆日记气泡内部 code 和 span 的重置 */
            .maid-diary-bubble code,
            .maid-diary-bubble code span {
                background: none !important; border: none !important;
                padding: 0 !important; margin: 0 !important;
                box-shadow: none !important; color: inherit !important;
                display: inline !important;
                font-family: 'Georgia', 'Times New Roman', serif !important; /* 更古典的字体 */
                font-size: 0.98em !important;
                vertical-align: baseline;
            }

            /* 女仆日记气泡 "Maid" 标签 */
            .maid-diary-bubble .maid-label {
                font-weight: bold; color: #c2185b; margin-right: 6px; /* 深粉色 */
                font-family: 'Georgia', 'Times New Roman', serif !important; /* 保持字体一致性 */
            }

            /* 女仆日记气泡左上角图标 */
            .maid-diary-bubble::before {
                content: "🎀"; /* 蝴蝶结图标 */
                position: absolute;
                top: 10px; /* 向上微调 */
                left: 12px;
                font-size: 16px;
                color: rgba(227, 96, 140, 0.85); /* 粉色半透明 */
                z-index: 1;
                opacity: 0.9;
            }

            /* 隐藏女仆日记气泡内的复制按钮 */
            .maid-diary-bubble code .code-copy {
                display: none !important;
            }

            /* HTML5 音频播放器样式 */
            audio[controls] {
                background: linear-gradient(145deg, #3a7bd5 0%, #00d2ff 100%) !important;
                border: 1px solid #2980b9 !important;
                border-radius: 10px !important;
                padding: 10px 15px !important;
                color: #ffffff !important; /* 可能对默认控件影响不大，但保持一致 */
                box-shadow: 0 4px 10px rgba(0, 0, 0, 0.3);
                margin-bottom: 10px !important;
                display: block; /* 确保块级显示以应用边距和填充 */
                width: 350px; /* 设置一个固定的宽度，例如350px */
            }

            /* 尝试美化音频播放器内部控件的颜色，使其更搭主题 */
            audio[controls]::-webkit-media-controls-panel {
                background: #ffffff !important; /* 设置为白色内胆 */
                border-radius: 9px !important; /* 内部面板圆角，比外部容器略小一点避免溢出 */
                margin: 5px !important; /* 给白色内胆一点边距，让蓝色外框更明显 */
                padding: 5px !important; /* 给内胆一些内部填充 */
                box-sizing: border-box !important;
            }

            /* 将图标控件变为深色 */
            audio[controls]::-webkit-media-controls-play-button,
            audio[controls]::-webkit-media-controls-mute-button,
            /* audio[controls]::-webkit-media-controls-volume-slider, /* 滑块轨道单独处理 */
            audio[controls]::-webkit-media-controls-fullscreen-button,
            audio[controls]::-webkit-media-controls-overflow-button { /* 三个点也一起处理 */
                filter: brightness(0.3) contrast(1.5) !important; /* 使图标变深色且清晰一些 */
            }

            /* 将时间文字变为深色 */
            audio[controls]::-webkit-media-controls-current-time-display,
            audio[controls]::-webkit-media-controls-time-remaining-display {
                color: #181818 !important; /* 深灰色近黑色 */
                text-shadow: none !important;
            }

            /* 进度条样式调整 (适配白色背景) */
            audio[controls]::-webkit-media-controls-timeline {
                background-color:rgb(255, 255, 255) !important; /* 更浅的灰色轨道，接近白色 */
                border-radius: 4px !important;
                height: 6px !important;
                margin: 0 5px !important;
            }
            audio[controls]::-webkit-media-controls-timeline::-webkit-slider-thumb {
                 background-color: #555555 !important; /* 深灰色滑块 */
                 border: 1px solid rgba(0, 0, 0, 0.3) !important;
                 box-shadow: 0 0 2px rgba(0,0,0,0.3) !important;
                 height: 12px !important;
                 width: 12px !important;
                 border-radius: 50% !important;
            }
            /* Firefox 兼容 (适配白色背景) */
             audio[controls]::-webkit-media-controls-timeline::-moz-range-thumb {
                background-color: #555555 !important; /* 深灰色滑块 */
                border: 1px solid rgba(0, 0, 0, 0.3) !important;
                height: 12px !important;
                width: 12px !important;
                border-radius: 50% !important;
            }
             audio[controls]::-webkit-media-controls-timeline::-moz-range-track {
                background-color:rgb(255, 255, 255) !important; /* 更浅的灰色轨道，接近白色 */
                border-radius: 4px !important;
                height: 6px !important;
            }

            /* 音量滑块轨道 (适配白色背景) */
            audio[controls]::-webkit-media-controls-volume-slider {
                background-color:rgb(255, 255, 255) !important; /* 更浅的灰色轨道，接近白色 */
                border-radius: 3px !important;
                height: 4px !important;
                margin: 0 5px !important;
            }
            audio[controls]::-webkit-media-controls-volume-slider::-webkit-slider-thumb {
                background-color: #555555 !important; /* 深灰色滑块 */
                border: 1px solid rgba(0,0,0,0.3) !important;
                height: 10px !important;
                width: 10px !important;
                border-radius: 50% !important;
            }
        `);
    }

    function prettifyBlock(preElement) {
        // console.log('VCPSub Enhanced UI [Prettify]: Called for preElement:', preElement, 'innerHTML (sample):', preElement.innerHTML?.substring(0, 200));
        // Check if already processed to prevent re-processing
        if (preElement.dataset.vcpPrettified || preElement.dataset.maidDiaryPrettified) {
            // console.log('VCPSub Enhanced UI [Prettify]: Already prettified, skipping:', preElement);
            return;
        }

        let codeElement = preElement.querySelector('code.hljs'); // Try with .hljs class first
        // console.log('VCPSub Enhanced UI [Prettify]: Attempt 1: Found codeElement (with .hljs):', codeElement);

        if (!codeElement) {
            codeElement = preElement.querySelector('code'); // Fallback to any <code> element
            // console.log('VCPSub Enhanced UI [Prettify]: Attempt 2: Fallback - Found codeElement (any code tag):', codeElement);
        }

        if (!codeElement) {
            // console.log('VCPSub Enhanced UI [Prettify]: No code element (neither .hljs nor generic) found in preElement. Bailing out. preElement.textContent (sample):', preElement.textContent?.substring(0,100));
            return;
        }

        const textContent = codeElement.textContent || "";
        // console.log('VCPSub Enhanced UI [Prettify]: codeElement.textContent (sample):', textContent.substring(0, 100));
        let htmlContent = codeElement.innerHTML;

        // Remove copy button HTML first to prevent interference with regex
        htmlContent = htmlContent.replace(/<i class="fa-solid fa-copy code-copy.*?<\/i>/s, '');

        if (textContent.trim().startsWith('VCP-ToolUse:')) {
            // console.log('VCPSub Enhanced UI [Prettify]: VCP-ToolUse detected. textContent (sample):', textContent.substring(0, 50) + "...");
            preElement.classList.add('vcp-tool-use-bubble');

            // Add VCP label
            htmlContent = htmlContent.replace(/(VCP-ToolUse:)/, '<span class="vcp-tool-label">$1</span>');

            // Highlight VCP tool name
            // VCP Tool name is typically the first hljs-comment after the label
            const tempDivVcp = document.createElement('div');
            tempDivVcp.innerHTML = htmlContent;
            const vcpLabelElement = tempDivVcp.querySelector('span.vcp-tool-label');
            if (vcpLabelElement) {
                let sibling = vcpLabelElement.nextSibling;
                while(sibling && sibling.nodeType === Node.TEXT_NODE && sibling.textContent.trim() === '') {
                    sibling = sibling.nextSibling; // Skip empty text nodes
                }
                if (sibling && sibling.nodeType === Node.ELEMENT_NODE && sibling.matches('span.hljs-comment')) {
                     const toolNameSpan = sibling;
                     const newToolNameSpan = document.createElement('span');
                     newToolNameSpan.className = 'vcp-tool-name-highlight';
                     newToolNameSpan.innerHTML = toolNameSpan.innerHTML;
                     toolNameSpan.replaceWith(newToolNameSpan);
                }
            }
            codeElement.innerHTML = tempDivVcp.innerHTML;
            preElement.dataset.vcpPrettified = "true";

        } else if (textContent.trim().startsWith('Maid')) { // Primary check for Maid Diary based on text
            // console.log('VCPSub Enhanced UI [Prettify - Diary Check]: Detected Maid Diary by textContent.');
            preElement.classList.add('maid-diary-bubble');

            // Attempt to style the "Maid" label specifically
            const tempDivMaid = document.createElement('div');
            tempDivMaid.innerHTML = htmlContent; // htmlContent has copy button removed

            let maidLabelProcessed = false;
            const firstSpanAttribute = tempDivMaid.querySelector('span.hljs-attribute');
            if (firstSpanAttribute && firstSpanAttribute.textContent.trim() === 'Maid') {
                // console.log('VCPSub Enhanced UI [Prettify - Diary Check]: Found span.hljs-attribute for "Maid", replacing it.');
                const maidLabelSpan = document.createElement('span');
                maidLabelSpan.className = 'maid-label';
                maidLabelSpan.textContent = firstSpanAttribute.textContent;
                firstSpanAttribute.replaceWith(maidLabelSpan);
                codeElement.innerHTML = tempDivMaid.innerHTML;
                maidLabelProcessed = true;
            }

            // Fallback if the span.hljs-attribute wasn't found or "Maid" wasn't in it,
            // but we know it's a diary by textContent.
            // This tries to wrap the "Maid" text if it's at the beginning of the raw HTML content.
            if (!maidLabelProcessed && htmlContent.trimLeft().startsWith('Maid')) {
                // console.log('VCPSub Enhanced UI [Prettify - Diary Check]: Fallback - Wrapping "Maid" text directly from htmlContent.');
                // Regex to replace "Maid" only if it's at the start, possibly after some whitespace,
                // and not already within a span (very basic check, might need refinement if complex HTML occurs here)
                const maidRegex = /^(\s*Maid)(?![^<]*>)/;
                if (maidRegex.test(htmlContent)) {
                     htmlContent = htmlContent.replace(maidRegex, `<span class="maid-label">$1</span>`);
                     codeElement.innerHTML = htmlContent;
                } else {
                    // console.log('VCPSub Enhanced UI [Prettify - Diary Check]: Fallback - "Maid" text not at start of htmlContent or complex structure.');
                }
            }
            preElement.dataset.maidDiaryPrettified = "true";
        } else {
            // console.log('VCPSub Enhanced UI [Prettify]: Block not identified as VCP or Maid Diary.');
        }
    }

    function observeChatForBlocks() {
        const observerCallback = (mutationsList, observer) => {
            // console.log('VCPSub Enhanced UI [Observer]: Callback triggered. Number of mutations:', mutationsList.length);
            for (const mutation of mutationsList) {
                // console.log('VCPSub Enhanced UI [Observer]: Mutation type:', mutation.type, 'Target:', mutation.target);

                if (mutation.type === 'childList') {
                    // console.log('VCPSub Enhanced UI [Observer childList]: Added nodes:', mutation.addedNodes.length, 'Removed nodes:', mutation.removedNodes.length);
                    mutation.addedNodes.forEach(node => {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            if (node.matches && node.matches('pre')) {
                                // console.log('VCPSub Enhanced UI [Observer childList]: Direct PRE added, calling prettifyBlock:', node);
                                prettifyBlock(node);
                            }
                            const preElements = node.querySelectorAll('pre');
                            if (preElements.length > 0) {
                                // console.log('VCPSub Enhanced UI [Observer childList]: Found PRE elements in added node, count:', preElements.length);
                                preElements.forEach(preEl => {
                                    // console.log('VCPSub Enhanced UI [Observer childList]: Calling prettifyBlock for PRE in added node:', preEl);
                                    prettifyBlock(preEl);
                                });
                            }
                        }
                    });
                } else if (mutation.type === 'characterData') {
                    // console.log('VCPSub Enhanced UI [Observer characterData]: Target node:', mutation.target, 'New text (sample):', mutation.target.textContent?.substring(0, 50));
                    let targetNode = mutation.target;
                    let preParent = null;
                    while (targetNode && targetNode !== chatAreaObserverTarget && targetNode !== document.body) {
                        if (targetNode.nodeName === 'PRE') {
                            preParent = targetNode;
                            break;
                        }
                        if (!targetNode.parentNode) break;
                        targetNode = targetNode.parentNode;
                    }

                    if (preParent) {
                        let currentDelay = DEBOUNCE_DELAY;
                        // Check if the content of preParent (or its code child) suggests it's a Maid Diary
                        const preTextContent = preParent.textContent || "";
                        if (preTextContent.trim().startsWith('Maid')) {
                            currentDelay = DIARY_DEBOUNCE_DELAY;
                            // console.log(`VCPSub Enhanced UI [Observer characterData]: Maid Diary detected for preParent, using DIARY_DEBOUNCE_DELAY (${currentDelay}ms)`);
                        } else {
                            // console.log(`VCPSub Enhanced UI [Observer characterData]: General block detected for preParent, using DEBOUNCE_DELAY (${currentDelay}ms)`);
                        }

                        if (debounceTimers.has(preParent)) {
                            clearTimeout(debounceTimers.get(preParent));
                        }
                        debounceTimers.set(preParent, setTimeout(() => {
                            if (document.body.contains(preParent)) {
                                // console.log(`VCPSub Enhanced UI [Debounced Prettify]: Re-prettifying pre (delay: ${currentDelay}ms). InnerHTML (sample):`, preParent.innerHTML?.substring(0,100));
                                delete preParent.dataset.vcpPrettified;
                                delete preParent.dataset.maidDiaryPrettified;
                                prettifyBlock(preParent);
                            } else {
                                // console.log('VCPSub Enhanced UI [Debounced Prettify]: PreParent no longer in DOM.');
                            }
                            debounceTimers.delete(preParent);
                        }, currentDelay));
                    } else if (mutation.target.nodeType === Node.TEXT_NODE) {
                        // console.log('VCPSub Enhanced UI [Observer characterData]: Text node changed, but no <pre> parent found. Text (sample):', mutation.target.textContent?.substring(0,100));
                    }
                }
            }
        };

        const chatObserver = new MutationObserver(observerCallback);

        // Determine the target for the observer.
        const chatAreaSelectors = [
            '#chat',
            '#chat_messages_container',
            '.message-list',
            '#messages_container',
            '.chat_window .gm-scroll-view',
            '#chat_story',
            '.chatbox'
        ];
        let chatAreaObserverTarget = null;
        for (const selector of chatAreaSelectors) {
            chatAreaObserverTarget = document.querySelector(selector);
            if (chatAreaObserverTarget) break;
        }
        if (!chatAreaObserverTarget) {
            chatAreaObserverTarget = document.body;
            console.warn('VCPSub Enhanced UI: Could not find a specific chat container, observing document.body. This might have performance implications.');
        }

        if (chatAreaObserverTarget) {
            console.log('VCPSub Enhanced UI: Prettifier observing for VCP/Maid blocks in:', chatAreaObserverTarget.id || chatAreaObserverTarget.className || chatAreaObserverTarget.tagName);

            // Process existing elements within the determined target
            // This will be called when initializeScript runs, which checks document.readyState
            const existingPreElements = chatAreaObserverTarget.querySelectorAll('pre');
            existingPreElements.forEach(prettifyBlock);

            chatObserver.observe(chatAreaObserverTarget, {
                childList: true,    // For new messages and structural changes by hljs
                subtree: true,      // Observe all descendants
                characterData: true // For text content changes during streaming
            });
        } else {
            // This path should ideally not be reached if document.body is the ultimate fallback.
            console.error('VCPSub Enhanced UI: Observer target could not be determined. Prettifier will not run.');
        }
    }

    // --- Script Initialization ---
    function initializeScript() {
        createVcpPrettifierStyles();
        observeChatForBlocks(); // Updated function call
        console.log('VCPSub Prettifier: All components initialized.');
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initializeScript();
    } else {
        window.addEventListener('DOMContentLoaded', initializeScript);
    }

})();
