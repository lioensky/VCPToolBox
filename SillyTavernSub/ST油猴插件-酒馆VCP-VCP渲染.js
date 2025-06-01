// ==UserScript==
// @name         VCPSub Enhanced UI for SillyTavern (Animated Prettifier, Icon Animations, Border Fix, Slower Diary Border)
// @namespace    http://tampermonkey.net/
// @version      1.6
// @description  Prettifies VCP-ToolUse and Maid Diary blocks with animations (hides copy button, animates icons, fixes border rendering, slows down diary border animation).
// @author       Xiaoke & Ryan (Modified by Roo, Animations by AI)
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

    console.log('VCPSub Prettifier (Animated with Icon Animations, Border Fix, Slower Diary Border): Script started.');

    // --- VCP ToolUse and Maid Diary Prettifier ---

    function createVcpPrettifierStyles() {
        GM_addStyle(`
            /* Keyframes for animations */
            @keyframes vcp-bubble-background-flow-kf {
                0% { background-position: 0% 50%; }
                50% { background-position: 100% 50%; }
                100% { background-position: 0% 50%; }
            }

            @keyframes vcp-bubble-border-flow-kf {
                0% { background-position: 0% 50%; }
                50% { background-position: 200% 50%; } /* Adjusted for more color travel */
                100% { background-position: 0% 50%; }
            }

            @keyframes vcp-icon-rotate {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }

            @keyframes vcp-icon-heartbeat {
                0% { transform: scale(1); opacity: 0.6; }
                50% { transform: scale(1.15); opacity: 0.9; }
                100% { transform: scale(1); opacity: 0.6; }
            }

            /* 主气泡样式 - VCP ToolUse */
            .vcp-tool-use-bubble {
                background: linear-gradient(145deg, #3a7bd5 0%, #00d2ff 100%) !important;
                background-size: 200% 200% !important; /* Larger size for animation */
                animation: vcp-bubble-background-flow-kf 20s ease-in-out infinite;
                border-radius: 10px !important;
                padding: 8px 15px 8px 35px !important; /* 左边padding加大，给图标留空间 */
                color: #ffffff !important;
                box-shadow: 0 4px 10px rgba(0, 0, 0, 0.3);
                margin-bottom: 10px !important;
                position: relative;
                overflow: hidden; /* Changed to hidden for better animation containment */
                line-height: 1.5;
            }

            /* Animated Border for VCP ToolUse */
            .vcp-tool-use-bubble::after {
                content: "";
                position: absolute;
                box-sizing: border-box; /* Crucial fix for full border rendering */
                top: 0; left: 0; width: 100%; height: 100%;
                border-radius: inherit;
                padding: 2px; /* Border thickness */
                background: linear-gradient(60deg, #76c4f7, #00d2ff, #3a7bd5, #ffffff, #3a7bd5, #00d2ff, #76c4f7);
                background-size: 300% 300%;
                animation: vcp-bubble-border-flow-kf 7s linear infinite;
                -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
                mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
                -webkit-mask-composite: xor;
                mask-composite: exclude;
                z-index: 0; /* Below icon and content */
                pointer-events: none;
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
                position: relative; /* To ensure they are above the ::after pseudo-element */
                z-index: 1;
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
                color: rgba(255, 255, 255, 0.75); /* Base color for the gear */
                z-index: 2; /* Above animated border and content spans */
                animation: vcp-icon-rotate 4s linear infinite;
                transform-origin: center center; /* Ensures rotation is around the center */
            }

            /* 隐藏 VCP 气泡内的复制按钮 */
            .vcp-tool-use-bubble code .code-copy {
                display: none !important;
            }

            /* 女仆日记气泡样式 */
            .maid-diary-bubble {
                background: linear-gradient(145deg, #fdeff2 0%, #fce4ec 100%) !important; /* 淡粉色系 */
                background-size: 200% 200% !important; /* Larger size for animation */
                animation: vcp-bubble-background-flow-kf 14s ease-in-out infinite; /* Slower animation */
                border-radius: 10px !important;
                padding: 8px 15px 8px 35px !important; /* 左边padding加大，给图标留空间 */
                color: #5d4037 !important; /* 深棕色文字 */
                box-shadow: 0 4px 10px rgba(0, 0, 0, 0.15);
                margin-bottom: 10px !important;
                position: relative;
                overflow: hidden; /* Changed to hidden for better animation containment */
                line-height: 1.5;
            }

            /* Animated Border for Maid Diary */
            .maid-diary-bubble::after {
                content: "";
                position: absolute;
                box-sizing: border-box; /* Crucial fix for full border rendering */
                top: 0; left: 0; width: 100%; height: 100%;
                border-radius: inherit;
                padding: 2px; /* Border thickness */
                background: linear-gradient(60deg, #f8bbd0, #fce4ec, #e91e63, #ffffff, #e91e63, #fce4ec, #f8bbd0);
                background-size: 300% 300%;
                animation: vcp-bubble-border-flow-kf 20s linear infinite; /* Slowed down from 8s to 12s */
                -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
                mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
                -webkit-mask-composite: xor;
                mask-composite: exclude;
                z-index: 0; /* Below icon and content */
                pointer-events: none;
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
                position: relative; /* To ensure they are above the ::after pseudo-element */
                z-index: 1;
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
                color: rgba(227, 96, 140, 0.85); /* Base color for the butterfly */
                z-index: 2; /* Above animated border and content spans */
                animation: vcp-icon-heartbeat 2.5s ease-in-out infinite;
                transform-origin: center center; /* Ensures scaling is from the center */
            }

            /* 隐藏女仆日记气泡内的复制按钮 */
            .maid-diary-bubble code .code-copy {
                display: none !important;
            }

            /* HTML5 音频播放器样式 (No changes here, kept as original) */
            audio[controls] {
                background: linear-gradient(145deg, #3a7bd5 0%, #00d2ff 100%) !important;
                border: 1px solid #2980b9 !important;
                border-radius: 10px !important;
                padding: 10px 15px !important;
                color: #ffffff !important;
                box-shadow: 0 4px 10px rgba(0, 0, 0, 0.3);
                margin-bottom: 10px !important;
                display: block;
                width: 350px;
            }
            audio[controls]::-webkit-media-controls-panel {
                background: #ffffff !important;
                border-radius: 9px !important;
                margin: 5px !important;
                padding: 5px !important;
                box-sizing: border-box !important;
            }
            audio[controls]::-webkit-media-controls-play-button,
            audio[controls]::-webkit-media-controls-mute-button,
            audio[controls]::-webkit-media-controls-fullscreen-button,
            audio[controls]::-webkit-media-controls-overflow-button {
                filter: brightness(0.3) contrast(1.5) !important;
            }
            audio[controls]::-webkit-media-controls-current-time-display,
            audio[controls]::-webkit-media-controls-time-remaining-display {
                color: #181818 !important;
                text-shadow: none !important;
            }
            audio[controls]::-webkit-media-controls-timeline {
                background-color:rgb(255, 255, 255) !important;
                border-radius: 4px !important;
                height: 6px !important;
                margin: 0 5px !important;
            }
            audio[controls]::-webkit-media-controls-timeline::-webkit-slider-thumb {
                background-color: #555555 !important;
                border: 1px solid rgba(0, 0, 0, 0.3) !important;
                box-shadow: 0 0 2px rgba(0,0,0,0.3) !important;
                height: 12px !important;
                width: 12px !important;
                border-radius: 50% !important;
            }
            audio[controls]::-webkit-media-controls-timeline::-moz-range-thumb {
                background-color: #555555 !important;
                border: 1px solid rgba(0, 0, 0, 0.3) !important;
                height: 12px !important;
                width: 12px !important;
                border-radius: 50% !important;
            }
            audio[controls]::-webkit-media-controls-timeline::-moz-range-track {
                background-color:rgb(255, 255, 255) !important;
                border-radius: 4px !important;
                height: 6px !important;
            }
            audio[controls]::-webkit-media-controls-volume-slider {
                background-color:rgb(255, 255, 255) !important;
                border-radius: 3px !important;
                height: 4px !important;
                margin: 0 5px !important;
            }
            audio[controls]::-webkit-media-controls-volume-slider::-webkit-slider-thumb {
                background-color: #555555 !important;
                border: 1px solid rgba(0,0,0,0.3) !important;
                height: 10px !important;
                width: 10px !important;
                border-radius: 50% !important;
            }
        `);
    }

    function prettifyBlock(preElement) {
        // console.log('VCPSub Enhanced UI [Prettify]: Called for preElement:', preElement, 'innerHTML (sample):', preElement.innerHTML?.substring(0, 200));
        if (preElement.dataset.vcpPrettified || preElement.dataset.maidDiaryPrettified) {
            // console.log('VCPSub Enhanced UI [Prettify]: Already prettified, skipping:', preElement);
            return;
        }

        let codeElement = preElement.querySelector('code.hljs');
        if (!codeElement) {
            codeElement = preElement.querySelector('code');
        }

        if (!codeElement) {
            return;
        }

        const textContent = codeElement.textContent || "";
        let htmlContent = codeElement.innerHTML;
        htmlContent = htmlContent.replace(/<i class="fa-solid fa-copy code-copy.*?<\/i>/s, '');

        if (textContent.trim().startsWith('VCP-ToolUse:')) {
            preElement.classList.add('vcp-tool-use-bubble');
            htmlContent = htmlContent.replace(/(VCP-ToolUse:)/, '<span class="vcp-tool-label">$1</span>');
            const tempDivVcp = document.createElement('div');
            tempDivVcp.innerHTML = htmlContent;
            const vcpLabelElement = tempDivVcp.querySelector('span.vcp-tool-label');
            if (vcpLabelElement) {
                let sibling = vcpLabelElement.nextSibling;
                while(sibling && sibling.nodeType === Node.TEXT_NODE && sibling.textContent.trim() === '') {
                    sibling = sibling.nextSibling;
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

        } else if (textContent.trim().startsWith('Maid')) {
            preElement.classList.add('maid-diary-bubble');
            const tempDivMaid = document.createElement('div');
            tempDivMaid.innerHTML = htmlContent;
            let maidLabelProcessed = false;
            const firstSpanAttribute = tempDivMaid.querySelector('span.hljs-attribute');
            if (firstSpanAttribute && firstSpanAttribute.textContent.trim() === 'Maid') {
                const maidLabelSpan = document.createElement('span');
                maidLabelSpan.className = 'maid-label';
                maidLabelSpan.textContent = firstSpanAttribute.textContent;
                firstSpanAttribute.replaceWith(maidLabelSpan);
                codeElement.innerHTML = tempDivMaid.innerHTML;
                maidLabelProcessed = true;
            }
            if (!maidLabelProcessed && htmlContent.trimLeft().startsWith('Maid')) {
                const maidRegex = /^(\s*Maid)(?![^<]*>)/;
                if (maidRegex.test(htmlContent)) {
                    htmlContent = htmlContent.replace(maidRegex, `<span class="maid-label">$1</span>`);
                    codeElement.innerHTML = htmlContent;
                }
            }
            preElement.dataset.maidDiaryPrettified = "true";
        }
    }

    function observeChatForBlocks() {
        const observerCallback = (mutationsList, observer) => {
            for (const mutation of mutationsList) {
                if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach(node => {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            if (node.matches && node.matches('pre')) {
                                prettifyBlock(node);
                            }
                            const preElements = node.querySelectorAll('pre');
                            if (preElements.length > 0) {
                                preElements.forEach(prettifyBlock);
                            }
                        }
                    });
                } else if (mutation.type === 'characterData') {
                    let targetNode = mutation.target;
                    let preParent = null;
                    while (targetNode && targetNode !== chatAreaObserverTarget && targetNode !== document.body) {
                        if (targetNode.nodeName === 'PRE') {
                            preParent = targetNode;
                            break;
                        }
                        if (!targetNode.parentNode) break; // Should not happen in a valid DOM
                        targetNode = targetNode.parentNode;
                    }

                    if (preParent) {
                        let currentDelay = DEBOUNCE_DELAY;
                        const preTextContent = preParent.textContent || "";
                        if (preTextContent.trim().startsWith('Maid')) {
                            currentDelay = DIARY_DEBOUNCE_DELAY;
                        }

                        if (debounceTimers.has(preParent)) {
                            clearTimeout(debounceTimers.get(preParent));
                        }
                        debounceTimers.set(preParent, setTimeout(() => {
                            if (document.body.contains(preParent)) { // Check if element is still in DOM
                                delete preParent.dataset.vcpPrettified;
                                delete preParent.dataset.maidDiaryPrettified;
                                prettifyBlock(preParent);
                            }
                            debounceTimers.delete(preParent);
                        }, currentDelay));
                    }
                }
            }
        };

        const chatObserver = new MutationObserver(observerCallback);
        const chatAreaSelectors = [
            '#chat', '#chat_messages_container', '.message-list',
            '#messages_container', '.chat_window .gm-scroll-view',
            '#chat_story', '.chatbox'
        ];
        let chatAreaObserverTarget = null;
        for (const selector of chatAreaSelectors) {
            chatAreaObserverTarget = document.querySelector(selector);
            if (chatAreaObserverTarget) break;
        }
        if (!chatAreaObserverTarget) {
            chatAreaObserverTarget = document.body; // Fallback to document.body
            console.warn('VCPSub Enhanced UI: Could not find a specific chat container, observing document.body. This might have performance implications.');
        }

        if (chatAreaObserverTarget) {
            console.log('VCPSub Enhanced UI: Prettifier observing for VCP/Maid blocks in:', chatAreaObserverTarget.id || chatAreaObserverTarget.className || chatAreaObserverTarget.tagName);
            // Process existing elements within the determined target
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
        console.log('VCPSub Prettifier (Animated with Icon Animations, Border Fix, Slower Diary Border): All components initialized.');
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initializeScript();
    } else {
        window.addEventListener('DOMContentLoaded', initializeScript);
    }

})();
