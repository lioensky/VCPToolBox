// modules/notificationRenderer.js

/**
 * @typedef {Object} VCPLogStatus
 * @property {'open'|'closed'|'error'|'connecting'} status
 * @property {string} message
 */

/**
 * @typedef {Object} VCPLogData
 * @property {string} type - e.g., 'vcp_log', 'daily_note_created', 'connection_ack'
 * @property {Object|string} data - The actual log data or message content
 * @property {string} [message] - A general message if data is not the primary content
 */

/**
 * Updates the VCPLog connection status display.
 * @param {VCPLogStatus} statusUpdate - The status object.
 * @param {HTMLElement} vcpLogConnectionStatusDiv - The DOM element for status display.
 */
function updateVCPLogStatus(statusUpdate, vcpLogConnectionStatusDiv) {
    if (!vcpLogConnectionStatusDiv) return;
    const prefix = statusUpdate.source || 'VCPLog';
    vcpLogConnectionStatusDiv.textContent = `${prefix}: ${statusUpdate.message}`;
    vcpLogConnectionStatusDiv.className = `notifications-status status-${statusUpdate.status}`;
}

/**
 * Renders a VCPLog notification in the notifications list.
 * @param {VCPLogData|string} logData - The parsed JSON log data or a raw string message.
 * @param {string|null} originalRawMessage - The original raw string message from WebSocket, if available.
 * @param {HTMLElement} notificationsListUl - The UL element for the persistent notifications sidebar.
 * @param {Object} themeColors - An object containing theme colors (largely unused now with CSS variables).
 */
function renderVCPLogNotification(logData, originalRawMessage = null, notificationsListUl, themeColors = {}) {
    // Suppress the generic English connection success message for VCPLog
    if (logData && typeof logData === 'object' && logData.type === 'connection_ack' && logData.message === 'WebSocket connection successful for VCPLog.') {
        return; // Do not render this notification
    }

    const toastContainer = document.getElementById('floating-toast-notifications-container');

    const textToCopy = originalRawMessage !== null ? originalRawMessage :
                       (typeof logData === 'object' && logData !== null ? JSON.stringify(logData, null, 2) : String(logData));

    let titleText = 'VCP 通知:';
    let mainContent = '';
    let contentIsPreformatted = false;

    // --- Content Parsing Logic (adapted from original renderer.js) ---
    if (logData && typeof logData === 'object' && logData.type === 'vcp_log' && logData.data && typeof logData.data === 'object') {
        const vcpData = logData.data;
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
                        if (typeof parsedInnerContent.original_plugin_output === 'object' && parsedInnerContent.original_plugin_output !== null) {
                            mainContent = JSON.stringify(parsedInnerContent.original_plugin_output, null, 2);
                            // contentIsPreformatted is already true (from line 52) and should remain true for JSON display
                        } else {
                            mainContent = String(parsedInnerContent.original_plugin_output);
                            contentIsPreformatted = false; // If it's not an object, treat as plain text
                        }
                    }
                } catch (e) {
                    // console.warn('VCP Notifier: Could not parse vcpData.content as JSON:', e, rawContentString);
                }
            } else {
                mainContent = '(无内容)';
            }
        } else if (vcpData.source === 'DistPluginManager' && vcpData.content) {
            titleText = '分布式服务器:';
            mainContent = vcpData.content;
            contentIsPreformatted = false;
        } else {
            titleText = 'VCP 日志条目:';
            mainContent = JSON.stringify(vcpData, null, 2);
            contentIsPreformatted = true;
        }
    } else if (logData && typeof logData === 'object' && logData.type === 'video_generation_status' && logData.data && typeof logData.data === 'object') {
        titleText = '视频生成状态:';
        if (logData.data.original_plugin_output && typeof logData.data.original_plugin_output.message === 'string') {
            mainContent = logData.data.original_plugin_output.message;
            contentIsPreformatted = false;
        } else if (logData.data.original_plugin_output) { // If original_plugin_output exists but not its message, stringify it
            mainContent = JSON.stringify(logData.data.original_plugin_output, null, 2);
            contentIsPreformatted = true;
        } else { // Fallback to stringify the whole data part
            mainContent = JSON.stringify(logData.data, null, 2);
            contentIsPreformatted = true;
        }
        // Attempt to add timestamp to title
        if (logData.data.timestamp && typeof logData.data.timestamp === 'string' && logData.data.timestamp.length >= 16) {
            const timePart = logData.data.timestamp.substring(11, 16);
            titleText += ` (@ ${timePart})`;
        }
    } else if (logData && typeof logData === 'object' && logData.type === 'daily_note_created' && logData.data && typeof logData.data === 'object') {
        const noteData = logData.data;
        titleText = `日记: ${noteData.maidName || 'N/A'} (${noteData.dateString || 'N/A'})`;
        if (noteData.status === 'success') {
            mainContent = noteData.message || '日记已成功创建。';
        } else {
            mainContent = noteData.message || `日记处理状态: ${noteData.status || '未知'}`;
        }
    } else if (logData && typeof logData === 'object' && logData.type === 'connection_ack' && logData.message) {
        titleText = 'VCP 连接:';
        mainContent = String(logData.message);
    } else if (logData && typeof logData === 'object' && logData.type && logData.message) { // Generic type + message
        titleText = `类型: ${logData.type}`;
        mainContent = String(logData.message);
        if (logData.data) {
            mainContent += `\n数据: ${JSON.stringify(logData.data, null, 2)}`;
            contentIsPreformatted = true;
        }
    } else { // Fallback for other structures or plain string
        titleText = 'VCP 消息:';
        mainContent = typeof logData === 'object' && logData !== null ? JSON.stringify(logData, null, 2) : String(logData);
        contentIsPreformatted = typeof logData === 'object';
    }
    // --- End Content Parsing ---

    // Function to populate a notification element (either toast or list item)
    const populateNotificationElement = (element, isToast) => {
        const strongTitle = document.createElement('strong');
        strongTitle.textContent = titleText;
        element.appendChild(strongTitle);

        const contentDiv = document.createElement('div');
        contentDiv.classList.add('notification-content');
        if (mainContent) {
            if (contentIsPreformatted) {
                const pre = document.createElement('pre');
                pre.textContent = mainContent.substring(0, 300) + (mainContent.length > 300 ? '...' : '');
                pre.style.overflowWrap = 'break-word'; //  处理长文本换行
                pre.style.whiteSpace = 'pre-wrap'; //  确保<pre>标签也能自动换行
                contentDiv.appendChild(pre);
            } else {
                const p = document.createElement('p');
                p.textContent = mainContent.substring(0, 300) + (mainContent.length > 300 ? '...' : '');
                p.style.overflowWrap = 'break-word'; //  处理长文本换行
                contentDiv.appendChild(p);
            }
        }
        element.appendChild(contentDiv);

        const timestampSpan = document.createElement('span');
        timestampSpan.classList.add('notification-timestamp');
        timestampSpan.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        element.appendChild(timestampSpan);

        if (isToast) {
            // const closeButton = document.createElement('button'); // Removed close button
            // closeButton.classList.add('toast-close-btn');
            // closeButton.innerHTML = '&times;';
            // closeButton.title = '关闭通知';
            // closeButton.onclick = (e) => {
            //     e.stopPropagation();
            //     closeToastNotification(element);
            // };
            // element.appendChild(closeButton);
            element.onclick = () => {
                // 清除自动消失的timeout
                if (element.dataset.autoDismissTimeout) {
                    clearTimeout(parseInt(element.dataset.autoDismissTimeout));
                }
                closeToastNotification(element);
            }; // Click on bubble itself still closes it
        } else { // For persistent list item
            const copyButton = document.createElement('button');
            copyButton.className = 'notification-copy-btn';
            copyButton.textContent = '📋';
            copyButton.title = '复制消息到剪贴板';
            copyButton.onclick = (e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(textToCopy).then(() => {
                    const originalText = copyButton.textContent;
                    copyButton.textContent = '已复制!';
                    copyButton.disabled = true;
                    setTimeout(() => {
                        copyButton.textContent = originalText;
                        copyButton.disabled = false;
                    }, 1500);
                }).catch(err => {
                    console.error('通知复制失败: ', err);
                    const originalText = copyButton.textContent;
                    copyButton.textContent = '错误!';
                    setTimeout(() => {
                        copyButton.textContent = originalText;
                    }, 1500);
                });
            };
            element.appendChild(copyButton);
            // Click to dismiss for list items
            element.onclick = () => {
                element.style.opacity = '0';
                element.style.transform = 'translateX(100%)'; // Assuming this is the desired animation for list items
                setTimeout(() => {
                    if (element.parentNode) {
                        element.parentNode.removeChild(element);
                    }
                }, 500); // Match CSS transition for .notification-item
            };
        }
    };

    const closeToastNotification = (toastElement) => {
        toastElement.classList.add('exiting');
        
        // 设置一个fallback timeout，确保元素一定会被移除
        const fallbackTimeout = setTimeout(() => {
            if (toastElement.parentNode) {
                toastElement.parentNode.removeChild(toastElement);
            }
        }, 500); // 500ms后强制移除，即使transition没有完成
        
        toastElement.addEventListener('transitionend', () => {
            clearTimeout(fallbackTimeout); // 如果transition正常完成，清除fallback
            if (toastElement.parentNode) {
                toastElement.parentNode.removeChild(toastElement);
            }
        }, { once: true });
    };

    // 初始化焦点清理机制
    initializeFocusCleanup();

    // Render Floating Toast only if the sidebar is not already active
    const notificationsSidebarElement = document.getElementById('notificationsSidebar');
    if (toastContainer && (!notificationsSidebarElement || !notificationsSidebarElement.classList.contains('active'))) {
        const toastBubble = document.createElement('div');
        toastBubble.classList.add('floating-toast-notification');
        // 添加创建时间戳
        toastBubble.dataset.createdAt = Date.now().toString();
        populateNotificationElement(toastBubble, true);
        toastContainer.prepend(toastBubble);
        setTimeout(() => toastBubble.classList.add('visible'), 50);
        
        // 增强自动消失逻辑
        const autoDismissTimeout = setTimeout(() => {
            if (toastBubble.parentNode && toastBubble.classList.contains('visible') && !toastBubble.classList.contains('exiting')) {
                closeToastNotification(toastBubble);
            }
        }, 7000); // Auto-dismiss after 7 seconds
        
        // 保存timeout ID，以便在手动关闭时清除
        toastBubble.dataset.autoDismissTimeout = autoDismissTimeout.toString();
    } else if (toastContainer && notificationsSidebarElement && notificationsSidebarElement.classList.contains('active')) {
        // console.log('Notification sidebar is active, suppressing floating toast.');
    } else if (!toastContainer) {
        console.warn('Floating toast container not found. Toast not displayed.');
    }

    // Render to Persistent Notification Sidebar List
    if (notificationsListUl) {
        const listItemBubble = document.createElement('li'); // Use 'li' for the list
        listItemBubble.classList.add('notification-item'); // Existing class for list items
        populateNotificationElement(listItemBubble, false);
        notificationsListUl.prepend(listItemBubble);
        // Apply 'visible' class for potential animations on list items if defined in CSS
        setTimeout(() => listItemBubble.classList.add('visible'), 50);
    } else {
        console.warn('Notifications sidebar UL not found. Persistent notification not added.');
    }
}

// 添加窗口焦点变化监听，清理残留的通知元素
let focusCleanupInitialized = false;

function initializeFocusCleanup() {
    if (focusCleanupInitialized) return;
    focusCleanupInitialized = true;

    // 当窗口重新获得焦点时，清理所有可能残留的通知元素
    window.addEventListener('focus', () => {
        const toastContainer = document.getElementById('floating-toast-notifications-container');
        if (toastContainer) {
            // 查找所有添加了 exiting 类但仍在 DOM 中的元素
            const exitingToasts = toastContainer.querySelectorAll('.floating-toast-notification.exiting');
            exitingToasts.forEach(toast => {
                if (toast.parentNode) {
                    console.log('[NotificationRenderer] 清理残留的通知元素');
                    toast.parentNode.removeChild(toast);
                }
            });
            
            // 清理超时的通知元素（显示超过10秒的）
            const allToasts = toastContainer.querySelectorAll('.floating-toast-notification');
            allToasts.forEach(toast => {
                // 检查元素创建时间，如果没有时间戳则设置一个
                if (!toast.dataset.createdAt) {
                    toast.dataset.createdAt = Date.now().toString();
                } else {
                    const createdAt = parseInt(toast.dataset.createdAt);
                    const now = Date.now();
                    if (now - createdAt > 10000) { // 超过10秒
                        console.log('[NotificationRenderer] 清理超时的通知元素');
                        if (toast.parentNode) {
                            toast.parentNode.removeChild(toast);
                        }
                    }
                }
            });
        }
    });

    // 定期清理机制，每30秒检查一次
    setInterval(() => {
        const toastContainer = document.getElementById('floating-toast-notifications-container');
        if (toastContainer) {
            const allToasts = toastContainer.querySelectorAll('.floating-toast-notification');
            allToasts.forEach(toast => {
                if (toast.dataset.createdAt) {
                    const createdAt = parseInt(toast.dataset.createdAt);
                    const now = Date.now();
                    if (now - createdAt > 15000) { // 超过15秒强制清理
                        console.log('[NotificationRenderer] 定期清理超时的通知元素');
                        if (toast.parentNode) {
                            toast.parentNode.removeChild(toast);
                        }
                    }
                }
            });
        }
    }, 30000); // 每30秒检查一次
}

// Expose functions to be used by renderer.js
window.notificationRenderer = {
    updateVCPLogStatus,
    renderVCPLogNotification,
    initializeFocusCleanup
};