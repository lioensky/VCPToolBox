// ==UserScript==
// @name         OpenWebUI VCP Tool Call Display Enhancer
// @version      1.0.3
// @description  Provides a graphical interface in OpenWebUI for the formatted toolcall output from VCPToolBox, developed for OpenWebUI v0.6.11. VCPToolBox project repository: https://github.com/lioensky/VCPToolBox
// @author       B3000Kcn
// @match        https://openwebui.b3000k.cn/*
// @run-at       document-idle
// @grant        GM_addStyle
// @license      MIT
// @namespace    https://greasyfork.org/users/1474401
// ==/UserScript==

(function() {
    'use strict';

    function GM_addStyle(cssRules) {
        const head = document.head || document.getElementsByTagName('head')[0];
        if (head) {
            const styleElement = document.createElement('style');
            styleElement.type = 'text/css';
            if (styleElement.styleSheet) {
                styleElement.styleSheet.cssText = cssRules;
            } else {
                styleElement.appendChild(document.createTextNode(cssRules));
            }
            head.appendChild(styleElement);
        } else {
            console.error("Custom GM_addStyle: Could not find <head> element to inject CSS.");
        }
    }

    const SCRIPT_NAME = 'OpenWebUI VCP Tool Call Display Enhancer';
    const SCRIPT_VERSION = '1.0.3';
    const TARGET_P_DEPTH = 24;
    const START_MARKER = "<<<[TOOL_REQUEST]>>>";
    const END_MARKER = "<<<[END_TOOL_REQUEST]>>>";

    const PLACEHOLDER_CLASS = "tool-request-placeholder-custom-style";
    const HIDDEN_TEXT_WRAPPER_CLASS = "tool-request-hidden-text-wrapper";

    const pElementStates = new WeakMap();

    function getElementDepth(element) {
        let depth = 0; let el = element;
        while (el) { depth++; el = el.parentElement; }
        return depth;
    }

    function injectStyles() {
        GM_addStyle(`
            .${PLACEHOLDER_CLASS} {
                display: flex;
                align-items: center;
                justify-content: space-between;
                border: 1px solid #c5c5c5;
                border-radius: 6px;
                padding: 6px 10px;
                margin: 8px 0; /* Will apply if placeholder is block/flex, careful if p has its own margin */
                background-color: #e6e6e6;
                font-family: sans-serif;
                font-size: 0.9em;
                color: #1a1a1a;
                line-height: 1.4;
                width: 400px; /* Or consider width: 100% or fitting to parent p's width */
                box-sizing: border-box;
            }
            .${PLACEHOLDER_CLASS} .trp-icon {
                margin-right: 8px;
                font-size: 1.1em;
                color: #1a1a1a;
                flex-shrink: 0;
            }
            .${PLACEHOLDER_CLASS} .trp-info {
                flex-grow: 1;
                margin-right: 8px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                color: #1a1a1a;
            }
            .${PLACEHOLDER_CLASS} .trp-info .trp-name {
                font-weight: 600;
                color: #1a1a1a;
            }
            .${PLACEHOLDER_CLASS} .trp-copy-btn {
                display: flex;
                align-items: center;
                background-color: #d7d7d7;
                color: #1a1a1a;
                border: 1px solid #b0b0b0;
                border-radius: 4px;
                padding: 4px 8px;
                font-size: 0.9em;
                cursor: pointer;
                margin-left: auto;
                flex-shrink: 0;
                transition: background-color 0.2s;
            }
            .${PLACEHOLDER_CLASS} .trp-copy-btn:hover {
                background-color: #c8c8c8;
            }
            .${PLACEHOLDER_CLASS} .trp-copy-btn:disabled {
                background-color: #c0e0c0;
                color: #336033;
                cursor: default;
                opacity: 0.9;
                border-color: #a0c0a0;
            }
            .${PLACEHOLDER_CLASS} .trp-copy-btn svg {
                margin-right: 4px;
                stroke-width: 2.5;
                stroke: #1a1a1a;
            }
            .${HIDDEN_TEXT_WRAPPER_CLASS} {
                display: none !important;
            }
        `);
    }

    function parseToolName(rawText) {
        const toolNameMatch = rawText.match(/tool_name:\s*「始」(.*?)「末」/);
        return (toolNameMatch && toolNameMatch[1]) ? toolNameMatch[1].trim() : null;
    }

    function createOrUpdatePlaceholder(pElement, state) { // pElement is passed for context but not directly used if state.placeholderNode exists
        if (!state.placeholderNode) {
            // This case should ideally not be hit if placeholderNode is created in processParagraph
            // However, keeping it as a safeguard or for potential future refactoring
            state.placeholderNode = document.createElement('div');
            state.placeholderNode.className = PLACEHOLDER_CLASS;
             // If placeholder is created here, it needs to be inserted into the DOM appropriately
        }

        const parsedToolName = parseToolName(state.hiddenContentBuffer || "");
        if (parsedToolName) {
            state.toolName = parsedToolName;
        }

        let displayName = "Loading...";
        if (state.toolName) {
            displayName = state.toolName;
        } else if (state.isComplete) {
            displayName = "Tool Call";
        }

        const copyIconSvg = `
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>`;

        state.placeholderNode.innerHTML = `
            <span class="trp-icon">⚙️</span>
            <span class="trp-info">
                VCP Tool Call: <strong class="trp-name">${displayName}</strong>
            </span>
            <button type="button" class="trp-copy-btn" title="Copy raw tool request content">
                ${copyIconSvg}
                <span>Copy</span>
            </button>
        `;

        const copyButton = state.placeholderNode.querySelector('.trp-copy-btn');
        if (copyButton) {
            copyButton.onclick = async (event) => {
                event.stopPropagation();
                let contentToCopy = state.hiddenContentBuffer || "";
                if (contentToCopy.includes(START_MARKER) && contentToCopy.includes(END_MARKER)) {
                    const startIndex = contentToCopy.indexOf(START_MARKER) + START_MARKER.length;
                    const endIndex = contentToCopy.lastIndexOf(END_MARKER);
                    if (endIndex > startIndex) {
                        contentToCopy = contentToCopy.substring(startIndex, endIndex).trim();
                    } else {
                        contentToCopy = contentToCopy.replace(START_MARKER, "").replace(END_MARKER, "").trim();
                    }
                } else {
                    contentToCopy = contentToCopy.replace(START_MARKER, "").replace(END_MARKER, "").trim();
                }

                if (contentToCopy) {
                    try {
                        await navigator.clipboard.writeText(contentToCopy);
                        const originalButtonSpan = copyButton.querySelector('span');
                        const originalText = originalButtonSpan.textContent;
                        originalButtonSpan.textContent = 'Copied!';
                        copyButton.disabled = true;
                        setTimeout(() => {
                            if (copyButton.isConnected) { // Check if button is still in DOM
                                originalButtonSpan.textContent = originalText;
                                copyButton.disabled = false;
                            }
                        }, 2000);
                    } catch (err) {
                        console.error(`${SCRIPT_NAME}: Failed to copy: `, err);
                        const originalButtonSpan = copyButton.querySelector('span');
                        const originalText = originalButtonSpan.textContent;
                        originalButtonSpan.textContent = 'Error!';
                        setTimeout(() => {
                            if (copyButton.isConnected) {
                                originalButtonSpan.textContent = originalText;
                            }
                        }, 2000);
                    }
                } else {
                    const originalButtonSpan = copyButton.querySelector('span');
                    const originalText = originalButtonSpan.textContent;
                    originalButtonSpan.textContent = 'Empty!';
                    setTimeout(() => {
                        if (copyButton.isConnected) {
                            originalButtonSpan.textContent = originalText;
                        }
                    }, 2000);
                }
            };
        }
        // No return needed as state.placeholderNode is modified directly
    }

    // --- MODIFIED processParagraph Function (New Approach) ---
    function processParagraph(pElement) {
        // Initial checks for target element (depth, tag, attributes)
        if (getElementDepth(pElement) !== TARGET_P_DEPTH || pElement.tagName !== 'P' || !pElement.matches('p[dir="auto"]')) {
            return;
        }

        let state = pElementStates.get(pElement);
        const currentFullText = pElement.textContent || "";

        // Case 1: New paragraph containing START_MARKER, not yet processed
        if (!state && currentFullText.includes(START_MARKER)) {
            console.log(`${SCRIPT_NAME}: Processing new paragraph with START_MARKER`, pElement);
            state = {
                isActive: true,
                isComplete: false,
                placeholderNode: document.createElement('div'),
                hiddenWrapperNode: document.createElement('span'),
                hiddenContentBuffer: "",
                toolName: null
            };
            state.placeholderNode.className = PLACEHOLDER_CLASS;
            state.hiddenWrapperNode.className = HIDDEN_TEXT_WRAPPER_CLASS;
            pElementStates.set(pElement, state);

            // DOM Manipulation: Prepend placeholder and hidden wrapper, then move original content
            try {
                pElement.prepend(state.hiddenWrapperNode);   // Hidden wrapper first, then placeholder before it
                pElement.prepend(state.placeholderNode);     // Placeholder will be the first child visually

                // Move all *other* original children of pElement into the hiddenWrapperNode
                const nodesToMove = [];
                Array.from(pElement.childNodes).forEach(child => {
                    if (child !== state.placeholderNode && child !== state.hiddenWrapperNode) {
                        nodesToMove.push(child);
                    }
                });
                nodesToMove.forEach(node => {
                    state.hiddenWrapperNode.appendChild(node);
                });
            } catch (e) {
                console.error(`${SCRIPT_NAME}: Error during initial DOM manipulation in processParagraph:`, e, pElement);
                pElementStates.delete(pElement); // Clean up state if setup failed
                // Optionally, restore pElement to its original state if possible (complex)
                return;
            }

            // Update buffer from the now populated hiddenWrapperNode and update placeholder
            state.hiddenContentBuffer = state.hiddenWrapperNode.textContent || "";
            createOrUpdatePlaceholder(pElement, state); // Pass pElement for context if needed by CoUP

            if (state.hiddenContentBuffer.includes(END_MARKER)) {
                state.isComplete = true;
                createOrUpdatePlaceholder(pElement, state); // Update for completeness
            }
            return; // Initial processing done for this pElement
        }

        // Case 2: Paragraph already being processed, check for updates
        if (state && state.isActive && !state.isComplete) {
            // Content is now inside hiddenWrapperNode, so we get text from there
            const newRawHiddenText = state.hiddenWrapperNode.textContent || "";

            if (newRawHiddenText !== state.hiddenContentBuffer) {
                // console.log(`${SCRIPT_NAME}: Content update in hidden wrapper for`, pElement);
                state.hiddenContentBuffer = newRawHiddenText;
                createOrUpdatePlaceholder(pElement, state);

                if (state.hiddenContentBuffer.includes(END_MARKER)) {
                    state.isComplete = true;
                    createOrUpdatePlaceholder(pElement, state); // Final update
                }
            }
        }
    }

    const observer = new MutationObserver(mutationsList => {
        for (const mutation of mutationsList) {
            const processTarget = (target) => {
                if (!target) return;

                // If target itself is a P element matching criteria
                if (target.nodeType === Node.ELEMENT_NODE && target.tagName === 'P' &&
                    getElementDepth(target) === TARGET_P_DEPTH && target.matches('p[dir="auto"]')) {
                    processParagraph(target);
                }
                // If target is an element, also check its P descendants that match depth (but not dir="auto" here, as that's specific to the target paragraph)
                // The querySelectorAll below is more robust for finding relevant children.
                else if (target.nodeType === Node.ELEMENT_NODE && typeof target.querySelectorAll === 'function') {
                    target.querySelectorAll('p[dir="auto"]').forEach(pNode => {
                        if (getElementDepth(pNode) === TARGET_P_DEPTH) {
                            processParagraph(pNode);
                        }
                    });
                }
            };

            if (mutation.type === 'childList') {
                mutation.addedNodes.forEach(addedNode => {
                    processTarget(addedNode); // Process the added node itself
                    // If the added node is an element, also check its children
                    if (addedNode.nodeType === Node.ELEMENT_NODE && typeof addedNode.querySelectorAll === 'function') {
                        addedNode.querySelectorAll('p[dir="auto"]').forEach(pNode => {
                             if (getElementDepth(pNode) === TARGET_P_DEPTH) processParagraph(pNode);
                        });
                    }
                });
                // Also re-process the mutation target if it's relevant (e.g. children reordered, some removed)
                // This can be redundant if addedNodes covers it, but sometimes useful.
                 processTarget(mutation.target);

            } else if (mutation.type === 'characterData') {
                // Target of characterData mutation is the Text node itself.
                // We need to process its parent P element.
                if (mutation.target && mutation.target.parentNode) {
                    processTarget(mutation.target.parentNode);
                }
            }
        }
    });

    function activateScript() {
        console.log(`${SCRIPT_NAME} v${SCRIPT_VERSION} activating...`);
        injectStyles();

        // Initial scan for already present elements
        document.querySelectorAll('p[dir="auto"]').forEach(pElement => {
            if (getElementDepth(pElement) === TARGET_P_DEPTH) {
                processParagraph(pElement);
            }
        });

        // IMPORTANT: Consider observing a more specific container if possible, instead of document.body
        // For example: const chatArea = document.querySelector('#your-chat-area-id');
        // if (chatArea) { observer.observe(chatArea, { childList: true, subtree: true, characterData: true }); }
        // else { observer.observe(document.body, { childList: true, subtree: true, characterData: true }); }
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        console.log(`${SCRIPT_NAME} v${SCRIPT_VERSION} activated and observing.`);
    }

    // --- New Script Activation Logic ---
    function waitForPageReady(callback) {
        // !!! IMPORTANT: Replace '#chat-messages-container-id' with the actual selector
        // for a stable parent element in OpenWebUI that contains the chat messages.
        // This element should exist when the chat interface is ready.
        const chatContainerSelector = 'body'; // Fallback to body, but a specific selector is MUCH better.
                                                // Example: 'main', '.chat-area', 'div[role="log"]' etc.
                                                // Please inspect OpenWebUI's DOM to find a suitable one.

        let attempts = 0;
        const maxAttempts = 60; // Approx 6 seconds (60 * 100ms)

        function check() {
            const chatContainer = document.querySelector(chatContainerSelector);
            // Check for readyState and the presence of the specific container
            if (document.readyState === 'complete' && chatContainer) {
                console.log(`${SCRIPT_NAME}: Page is complete and chat container ('${chatContainerSelector}') found. Activating script.`);
                callback();
            } else if (attempts < maxAttempts) {
                attempts++;
                setTimeout(check, 100);
            } else {
                console.warn(`${SCRIPT_NAME}: Page ready check timed out or chat container ('${chatContainerSelector}') not found. Attempting to activate anyway.`);
                // Fallback to activating anyway, or you could choose not to.
                callback();
            }
        }
        // Initial check, in case already ready
        if (document.readyState === 'complete') {
            check(); // Perform the container check directly if document is already complete
        } else {
            window.addEventListener('load', check, { once: true }); // Prefer 'load' over 'DOMContentLoaded' for more "idle" state
        }
    }

    waitForPageReady(activateScript);

})();