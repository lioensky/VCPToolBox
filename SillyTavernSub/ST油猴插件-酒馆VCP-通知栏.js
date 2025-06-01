// ==UserScript==
// @name         ST-VCP通知栏
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Displays VCP messages as pop-up notifications in SillyTavern, below the floating clock.
// @author       Your Name (Based on User Request)
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
    const WS_SERVER_HOST = '192.168.2.179:5890'; // Replace with your actual server host and port
    const WS_URL = `ws://${WS_SERVER_HOST}/VCPlog/VCP_Key=${VCP_KEY}`;
    const NOTIFICATION_TIMEOUT = 7000; // milliseconds (7 seconds)
    const CLOCK_ELEMENT_ID = 'st-floating-container'; // ID of the clock/button container from the other script
    const NOTIFICATION_AREA_ID = 'vcp-notification-area';

    let ws;
    let notificationQueue = [];
    const MAX_VISIBLE_NOTIFICATIONS = 5; // Max notifications shown at once

    console.log('SillyTavern VCP Notifier: Script started.');

    // --- Styles ---
    GM_addStyle(`
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
            position: relative; /* For positioning the copy button */
            background-color: rgba(60, 60, 70, 0.85);
            backdrop-filter: blur(5px);
            -webkit-backdrop-filter: blur(5px);
            color: white;
            padding: 10px 15px;
            padding-right: 35px; /* Make space for the copy button */
            border-radius: 8px;
            margin-bottom: 8px;
            font-size: 0.9em;
            box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            opacity: 0;
            transform: translateX(100%);
            transition: opacity 0.5s ease, transform 0.5s ease;
            width: 100%;
            box-sizing: border-box;
            cursor: pointer; /* To allow manual dismissal */
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
            color: #a8d8ff; /* Light blue for titles */
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
        bubble.innerHTML = ''; // Clear any previous content

        // Determine the text to be copied
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
        } else if (typeof dataOrString === 'object' && dataOrString !== null) { // Parsed JSON from VCP
            if (dataOrString.type === 'vcp_log' && dataOrString.data && typeof dataOrString.data === 'object') {
                const vcpData = dataOrString.data;
                if (vcpData.tool_name && vcpData.status) {
                    titleText = `${vcpData.tool_name} ${vcpData.status}`;
                    if (typeof vcpData.content !== 'undefined') { // Check if content key exists
                        let rawContentString = String(vcpData.content);
                        mainContent = rawContentString; // Default mainContent to the raw string
                        contentIsPreformatted = true; // Content from VCP is often structured

                        try {
                            const parsedInnerContent = JSON.parse(rawContentString);
                            let titleSuffix = '';
                            if (parsedInnerContent.MaidName) {
                                titleSuffix += ` by ${parsedInnerContent.MaidName}`;
                            }
                            if (parsedInnerContent.timestamp && typeof parsedInnerContent.timestamp === 'string' && parsedInnerContent.timestamp.length >= 16) {
                                const timePart = parsedInnerContent.timestamp.substring(11, 16); // Extracts HH:MM
                                titleSuffix += `${parsedInnerContent.MaidName ? ' ' : ''}@ ${timePart}`; // Add space if MaidName was also added
                            }
                            if (titleSuffix) {
                                titleText += ` (${titleSuffix.trim()})`;
                            }

                            // Update mainContent if original_plugin_output is present
                            if (typeof parsedInnerContent.original_plugin_output !== 'undefined') {
                                mainContent = String(parsedInnerContent.original_plugin_output);
                            }
                            // If original_plugin_output is not present, mainContent remains rawContentString.
                        } catch (e) {
                            // Parsing failed, mainContent is already set to rawContentString.
                            console.warn('VCP Notifier: Could not parse vcpData.content as JSON:', e, rawContentString);
                        }
                    } else {
                        mainContent = '(No content provided)';
                    }
                } else { // It's a vcp_log but doesn't have tool_name/status in its data part as expected
                    titleText = 'VCP Log Entry:';
                    mainContent = JSON.stringify(vcpData, null, 2); // Show the 'data' part
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
                // contentIsPreformatted = false; // Typically, these messages are single lines or short.
            } else if (dataOrString.type === 'connection_ack' && dataOrString.message) {
                titleText = 'VCP Info:';
                mainContent = String(dataOrString.message);
            } else if (dataOrString.tool_name && dataOrString.status) { // Fallback for top-level tool_name/status (less likely for VCP logs now)
                titleText = `${dataOrString.tool_name} ${dataOrString.status}`;
                if (dataOrString.content) {
                    mainContent = String(dataOrString.content);
                    contentIsPreformatted = true;
                } else {
                    mainContent = '(No further content details)';
                }
            } else { // Fallback for other unhandled JSON objects
                titleText = 'VCP Data:';
                mainContent = JSON.stringify(dataOrString, null, 2);
                contentIsPreformatted = true;
            }
        } else { // Plain string from VCP or unparsed
            titleText = 'VCP Message:';
            mainContent = String(dataOrString);
        }

        const strongTitle = document.createElement('strong');
        strongTitle.textContent = titleText;
        bubble.appendChild(strongTitle);

        if (mainContent) {
            bubble.appendChild(document.createElement('br'));
            if (contentIsPreformatted) {
                const pre = document.createElement('pre');
                pre.style.whiteSpace = 'pre-wrap';
                pre.style.margin = '0';
                pre.style.fontFamily = 'inherit';
                pre.style.fontSize = 'inherit';
                pre.textContent = mainContent.substring(0, 300) + (mainContent.length > 300 ? '...' : '');
                bubble.appendChild(pre);
            } else {
                const textNode = document.createTextNode(mainContent.substring(0, 300) + (mainContent.length > 300 ? '...' : ''));
                bubble.appendChild(textNode);
            }
        }

        // Create and add copy button
        const copyButton = document.createElement('button');
        copyButton.className = 'vcp-notification-copy-btn';
        copyButton.textContent = '📋'; // Clipboard icon or "Copy"
        copyButton.title = 'Copy message to clipboard';
        copyButton.onclick = (e) => {
            e.stopPropagation(); // Prevent the bubble's click handler
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


        // Bubble click to dismiss
        bubble.onclick = () => {
            // Check if the click target is the copy button itself or its child
            // This is an extra precaution, stopPropagation should handle it.
            // if (event.target.classList.contains('vcp-notification-copy-btn')) {
            //     return;
            // }
            bubble.style.opacity = '0';
            bubble.style.transform = 'translateX(100%)';
            setTimeout(() => {
                if (bubble.parentNode) {
                    bubble.parentNode.removeChild(bubble);
                }
                updateNotificationDisplay();
            }, 500); // Match transition time
        };

        notificationArea.appendChild(bubble);
        notificationQueue.push(bubble);

        // Trigger animation
        setTimeout(() => bubble.classList.add('visible'), 50);

        // Auto-dismiss
        const timeoutId = setTimeout(() => {
            bubble.onclick(); // Trigger the click handler to fade out
        }, NOTIFICATION_TIMEOUT);
        bubble.dataset.timeoutId = timeoutId;

        updateNotificationDisplay();
    }

    function updateNotificationDisplay() {
        const notificationArea = document.getElementById(NOTIFICATION_AREA_ID);
        if (!notificationArea) return;

        const visibleBubbles = Array.from(notificationArea.children);

        // Remove oldest if exceeding max
        while (visibleBubbles.length > MAX_VISIBLE_NOTIFICATIONS) {
            const oldestBubble = visibleBubbles.shift(); // Get the first child (oldest)
            if (oldestBubble) {
                clearTimeout(oldestBubble.dataset.timeoutId); // Clear its auto-dismiss timer
                oldestBubble.onclick(); // Remove it
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
            const originalMessageString = event.data; // Keep the original raw string
            console.log('VCP Notifier: Received Message:', originalMessageString);
            let messagePayload;
            try {
                messagePayload = JSON.parse(originalMessageString);
            } catch (e) {
                messagePayload = originalMessageString; // It's a plain string or invalid JSON
            }
            // Pass both the payload for display logic and the original string for the copy button
            showNotification(messagePayload, null, originalMessageString);
        };

        ws.onclose = function(event) {
            console.log('VCP Notifier: WebSocket Connection Closed. Reconnecting in 3s...');
            ws = null; // Clear the instance
            setTimeout(connectWebSocket, 3000);
        };

        ws.onerror = function(error) {
            console.error('VCP Notifier: WebSocket Error:', error);
            showNotification('VCP Notifier WebSocket error.', 'error');
            // Don't set ws to null here, onclose will handle it
        };
    }

    // --- Initialization ---
    function initialize() {
        console.log('VCP Notifier: Initializing...');
        getNotificationArea(); // Create area and adjust position
        connectWebSocket();
        // Periodically check clock position in case it's added later or moves (e.g. if ST UI re-renders)
        setInterval(adjustNotificationAreaPosition, 5000);
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initialize();
    } else {
        window.addEventListener('DOMContentLoaded', initialize);
    }

})();
