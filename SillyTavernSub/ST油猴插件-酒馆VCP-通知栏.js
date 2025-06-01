// ==UserScript==
// @name         ST-VCP通知栏 (带动画与边框修复)
// @namespace    http://tampermonkey.net/
// @version      0.3
// @description  Displays VCP messages as pop-up notifications in SillyTavern, below the floating clock, with animations and fixed border rendering.
// @author       Your Name (Based on User Request, Enhanced by AI)
// @match        *://localhost:8000/*
// @match        *://127.0.0.1:8000/*
// @match        *://*/*:8000/*
// @include      /^https?:\/\/.*:8000\//
// @grant        GM_addStyle
// @run-at       document_idle
// ==/UserScript==

(function() {
    'use strict';

    // --- Configuration ---
    const VCP_KEY = '123456'; // Replace with your actual VCP Key if different
    const WS_SERVER_HOST = 'Your IP:5890'; // Replace with your actual server host and port
    const WS_URL = `ws://${WS_SERVER_HOST}/VCPlog/VCP_Key=${VCP_KEY}`;
    const NOTIFICATION_TIMEOUT = 7000; // milliseconds (7 seconds)
    const CLOCK_ELEMENT_ID = 'st-floating-container'; // ID of the clock/button container from the other script
    const NOTIFICATION_AREA_ID = 'vcp-notification-area';

    let ws;
    // let notificationQueue = []; // Not directly used for removal logic anymore
    const MAX_VISIBLE_NOTIFICATIONS = 5; // Max notifications shown at once

    console.log('SillyTavern VCP Notifier (Animated with Border Fix): Script started.');

    // --- Styles ---
    GM_addStyle(`
        /* Keyframes for animations */
        @keyframes vcp-shimmer-bg {
            0% { background-position: 150% 0; } /* Start shimmer off-screen to the right */
            100% { background-position: -150% 0; } /* End shimmer off-screen to the left */
        }

        @keyframes vcp-flow-border {
            0% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; } /* Adjusted for more visible travel on shorter cycle */
            100% { background-position: 0% 50%; }
        }

        #${NOTIFICATION_AREA_ID} {
            position: fixed;
            top: 60px; /* Default, will be adjusted below the clock */
            right: 10px;
            z-index: 9998; /* Below clock (9999), above most other things */
            width: 300px;
            display: flex;
            flex-direction: column;
            align-items: flex-end; /* Notifications align to the right */
        }
        .vcp-notification-bubble {
            position: relative; /* For positioning the copy button AND the ::before pseudo-element */
            backdrop-filter: blur(5px);
            -webkit-backdrop-filter: blur(5px);
            color: white;
            padding: 10px 15px;
            padding-right: 35px; /* Make space for the copy button */
            border-radius: 10px; /* Slightly increased for a softer look with the border */
            margin-bottom: 8px;
            font-size: 0.9em;
            box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            opacity: 0;
            transform: translateX(100%);
            transition: opacity 0.5s ease, transform 0.5s ease;
            width: 100%;
            box-sizing: border-box;
            cursor: pointer; /* To allow manual dismissal */
            overflow: hidden; /* Important for containing the ::before and for bg animations */

            /* Animated Shimmer Background */
            background-image: linear-gradient(
                110deg,
                rgba(60, 60, 70, 0.85) 0%, /* Base color */
                rgba(60, 60, 70, 0.85) 40%,
                rgba(85, 85, 95, 0.92) 50%, /* Shimmer highlight - slightly lighter and more opaque */
                rgba(60, 60, 70, 0.85) 60%,
                rgba(60, 60, 70, 0.85) 100% /* Base color */
            );
            background-size: 250% 100%; /* Make gradient wider than element for sweep effect */
            animation: vcp-shimmer-bg 7s linear infinite; /* Slower shimmer */
        }

        .vcp-notification-bubble::before {
            content: "";
            position: absolute;
            box-sizing: border-box; /* Crucial fix for full border rendering */
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            border-radius: inherit; /* Match parent's border-radius */
            padding: 2px; /* This creates the border thickness */
            background: linear-gradient( /* Animated gradient for the border */
                60deg,
                #76c4f7, /* Light, vibrant blue */
                #a8d8ff, /* User's strong color reference */
                #d0eaff, /* Lighter, almost white-blue */
                #a8d8ff,
                #76c4f7
            );
            background-size: 250% 250%; /* For a smooth flow */
            animation: vcp-flow-border 5s linear infinite; /* Slightly slower border flow */
            -webkit-mask: /* Mask to show gradient only as border */
                linear-gradient(#fff 0 0) content-box,
                linear-gradient(#fff 0 0);
            mask:
                linear-gradient(#fff 0 0) content-box, /* Transparent center (where content is) */
                linear-gradient(#fff 0 0); /* Opaque border area */
            -webkit-mask-composite: xor; /* Standard for hollowing out */
            mask-composite: exclude; /* Standard for hollowing out */
            z-index: 0; /* Above bubble's background, below content/button */
            opacity: 0; /* Start hidden, controlled by .visible */
            transition: opacity 0.45s ease 0.05s; /* Slightly delayed fade-in for effect */
            pointer-events: none; /* Ensure it doesn't interfere with clicks */
        }

        .vcp-notification-bubble.visible::before {
            opacity: 0.75; /* Border intensity, adjust as needed */
        }

        .vcp-notification-copy-btn {
            position: absolute;
            top: 5px;
            right: 5px;
            background: rgba(255,255,255,0.1);
            color: white;
            border: 1px solid rgba(255,255,255,0.3);
            border-radius: 4px;
            padding: 2px 5px;
            font-size: 0.8em;
            cursor: pointer;
            opacity: 0.7;
            transition: opacity 0.2s, background-color 0.2s;
            z-index: 1; /* Ensure copy button is above the ::before pseudo-element's border */
        }
        .vcp-notification-copy-btn:hover {
            opacity: 1;
            background: rgba(255,255,255,0.2);
        }
        .vcp-notification-bubble.visible {
            opacity: 1;
            transform: translateX(0);
        }
        .vcp-notification-bubble strong {
            color:rgba(168, 216, 255, 0.49); /* Light blue for titles */
            position: relative; /* Ensure text is above the ::before pseudo-element */
            z-index: 1;
        }
        /* Ensure direct text nodes within bubble are also above the border */
        .vcp-notification-bubble > br,
        .vcp-notification-bubble > pre,
        .vcp-notification-bubble > span /* If any other direct children are added */
         {
            position: relative;
            z-index: 1;
        }
    `);

    function getNotificationArea() {
        let area = document.getElementById(NOTIFICATION_AREA_ID);
        if (!area) {
            area = document.createElement('div');
            area.id = NOTIFICATION_AREA_ID;
            document.body.appendChild(area);
            adjustNotificationAreaPosition();
        }
        return area;
    }

    function adjustNotificationAreaPosition() {
        const area = document.getElementById(NOTIFICATION_AREA_ID);
        if (!area) return;

        const clockElement = document.getElementById(CLOCK_ELEMENT_ID);
        if (clockElement) {
            const clockRect = clockElement.getBoundingClientRect();
            area.style.top = `${clockRect.bottom + 10}px`; // 10px below the clock
        } else {
            // Fallback if clock is not found
            area.style.top = '70px';
            console.warn('VCP Notifier: Clock element not found, using default top position for notifications.');
        }
    }


    function showNotification(dataOrString, explicitType = null, originalRawMessage = null) {
        const notificationArea = getNotificationArea();
        if (!notificationArea) return;

        const bubble = document.createElement('div');
        bubble.className = 'vcp-notification-bubble';
        // Content will be added below, ensuring it's above the ::before pseudo-element due to z-index on children

        const textToCopy = originalRawMessage !== null ? originalRawMessage :
                           (typeof dataOrString === 'object' && dataOrString !== null ? JSON.stringify(dataOrString, null, 2) : String(dataOrString));

        let titleText = 'VCP Info:';
        let mainContent = '';
        let contentIsPreformatted = false;

        if (explicitType === 'connection') {
            titleText = 'Connection:';
            mainContent = String(dataOrString);
        } else if (explicitType === 'error') {
            titleText = 'Error:';
            mainContent = String(dataOrString);
        } else if (typeof dataOrString === 'object' && dataOrString !== null) {
            if (dataOrString.type === 'vcp_log' && dataOrString.data && typeof dataOrString.data === 'object') {
                const vcpData = dataOrString.data;
                if (vcpData.tool_name && vcpData.status) {
                    titleText = `${vcpData.tool_name} ${vcpData.status}`;
                    if (typeof vcpData.content !== 'undefined') {
                        let rawContentString = String(vcpData.content);
                        mainContent = rawContentString;
                        contentIsPreformatted = true;

                        try {
                            const parsedInnerContent = JSON.parse(rawContentString);
                            let titleSuffix = '';
                            if (parsedInnerContent.MaidName) {
                                titleSuffix += ` by ${parsedInnerContent.MaidName}`;
                            }
                            if (parsedInnerContent.timestamp && typeof parsedInnerContent.timestamp === 'string' && parsedInnerContent.timestamp.length >= 16) {
                                const timePart = parsedInnerContent.timestamp.substring(11, 16);
                                titleSuffix += `${parsedInnerContent.MaidName ? ' ' : ''}@ ${timePart}`;
                            }
                            if (titleSuffix) {
                                titleText += ` (${titleSuffix.trim()})`;
                            }
                            if (typeof parsedInnerContent.original_plugin_output !== 'undefined') {
                                mainContent = String(parsedInnerContent.original_plugin_output);
                            }
                        } catch (e) {
                            console.warn('VCP Notifier: Could not parse vcpData.content as JSON:', e, rawContentString);
                        }
                    } else {
                        mainContent = '(No content provided)';
                    }
                } else {
                    titleText = 'VCP Log Entry:';
                    mainContent = JSON.stringify(vcpData, null, 2);
                    contentIsPreformatted = true;
                }
            } else if (dataOrString.type === 'daily_note_created' && dataOrString.data && typeof dataOrString.data === 'object') {
                const noteData = dataOrString.data;
                titleText = `日记: ${noteData.maidName || 'N/A'} (${noteData.dateString || 'N/A'})`;
                if (noteData.status === 'success') {
                    mainContent = noteData.message || '日记已成功创建。';
                } else {
                    mainContent = noteData.message || `日记处理状态: ${noteData.status || '未知'}`;
                }
            } else if (dataOrString.type === 'connection_ack' && dataOrString.message) {
                titleText = 'VCP Info:';
                mainContent = String(dataOrString.message);
            } else if (dataOrString.tool_name && dataOrString.status) {
                titleText = `${dataOrString.tool_name} ${dataOrString.status}`;
                if (dataOrString.content) {
                    mainContent = String(dataOrString.content);
                    contentIsPreformatted = true;
                } else {
                    mainContent = '(No further content details)';
                }
            } else {
                titleText = 'VCP Data:';
                mainContent = JSON.stringify(dataOrString, null, 2);
                contentIsPreformatted = true;
            }
        } else {
            titleText = 'VCP Message:';
            mainContent = String(dataOrString);
        }

        const strongTitle = document.createElement('strong');
        strongTitle.textContent = titleText;
        bubble.appendChild(strongTitle);

        if (mainContent) {
            const brElement = document.createElement('br');
            // brElement.style.position = 'relative'; // Ensure z-index applies if needed, though usually not for br
            // brElement.style.zIndex = '1';
            bubble.appendChild(brElement);

            if (contentIsPreformatted) {
                const pre = document.createElement('pre');
                pre.style.whiteSpace = 'pre-wrap';
                pre.style.margin = '0';
                pre.style.fontFamily = 'inherit';
                pre.style.fontSize = 'inherit';
                // pre.style.position = 'relative'; // Ensure z-index applies
                // pre.style.zIndex = '1';
                pre.textContent = mainContent.substring(0, 300) + (mainContent.length > 300 ? '...' : '');
                bubble.appendChild(pre);
            } else {
                // For plain text, wrap it in a span to apply z-index if necessary,
                // or rely on the parent bubble's children stacking context.
                // Direct text nodes don't have z-index.
                // However, the CSS rule `.vcp-notification-bubble > span` should cover this if we wrap.
                // For simplicity, if direct text nodes are fine with default stacking, no need to wrap.
                // Let's test without explicit span wrapping first.
                const textNode = document.createTextNode(mainContent.substring(0, 300) + (mainContent.length > 300 ? '...' : ''));
                const textSpan = document.createElement('span'); // Wrap text node in span to apply z-index via CSS
                textSpan.appendChild(textNode);
                bubble.appendChild(textSpan);

            }
        }

        const copyButton = document.createElement('button');
        copyButton.className = 'vcp-notification-copy-btn';
        copyButton.textContent = '📋';
        copyButton.title = 'Copy message to clipboard';
        copyButton.onclick = (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(textToCopy).then(() => {
                const originalText = copyButton.textContent;
                copyButton.textContent = 'Copied!';
                copyButton.disabled = true;
                setTimeout(() => {
                    copyButton.textContent = originalText;
                    copyButton.disabled = false;
                }, 1500);
            }).catch(err => {
                console.error('VCP Notifier: Failed to copy text: ', err);
                const originalText = copyButton.textContent;
                copyButton.textContent = 'Error!';
                setTimeout(() => {
                    copyButton.textContent = originalText;
                }, 1500);
            });
        };
        bubble.appendChild(copyButton);

        bubble.onclick = () => {
            bubble.style.opacity = '0';
            bubble.style.transform = 'translateX(100%)';
            setTimeout(() => {
                if (bubble.parentNode) {
                    bubble.parentNode.removeChild(bubble);
                }
                updateNotificationDisplay();
            }, 500);
        };

        notificationArea.appendChild(bubble);
        setTimeout(() => bubble.classList.add('visible'), 50);

        const timeoutId = setTimeout(() => {
            if (bubble && bubble.parentNode) {
                bubble.onclick();
            }
        }, NOTIFICATION_TIMEOUT);
        bubble.dataset.timeoutId = timeoutId;

        updateNotificationDisplay();
    }

    function updateNotificationDisplay() {
        const notificationArea = document.getElementById(NOTIFICATION_AREA_ID);
        if (!notificationArea) return;

        const visibleBubbles = Array.from(notificationArea.children);

        while (visibleBubbles.length > MAX_VISIBLE_NOTIFICATIONS) {
            const oldestBubble = visibleBubbles.shift();
            if (oldestBubble) {
                clearTimeout(oldestBubble.dataset.timeoutId);
                if (oldestBubble.parentNode) {
                   oldestBubble.onclick();
                }
            }
        }
    }

    function connectWebSocket() {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            console.log('VCP Notifier: WebSocket already open or connecting.');
            return;
        }

        console.log(`VCP Notifier: Connecting to ${WS_URL}`);
        ws = new WebSocket(WS_URL);

        ws.onopen = function(event) {
            console.log('VCP Notifier: WebSocket Connection Opened.');
            showNotification('VCP Notifier Connected!', 'connection');
        };

        ws.onmessage = function(event) {
            const originalMessageString = event.data;
            console.log('VCP Notifier: Received Message:', originalMessageString);
            let messagePayload;
            try {
                messagePayload = JSON.parse(originalMessageString);
            } catch (e) {
                messagePayload = originalMessageString;
            }
            showNotification(messagePayload, null, originalMessageString);
        };

        ws.onclose = function(event) {
            console.log('VCP Notifier: WebSocket Connection Closed. Reconnecting in 3s...');
            ws = null;
            setTimeout(connectWebSocket, 3000);
        };

        ws.onerror = function(error) {
            console.error('VCP Notifier: WebSocket Error:', error);
            showNotification('VCP Notifier WebSocket error.', 'error');
        };
    }

    function initialize() {
        console.log('VCP Notifier: Initializing...');
        getNotificationArea();
        connectWebSocket();
        setInterval(adjustNotificationAreaPosition, 5000);
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initialize();
    } else {
        window.addEventListener('DOMContentLoaded', initialize);
    }

})();
