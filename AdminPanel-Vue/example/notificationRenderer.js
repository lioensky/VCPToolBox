// modules/notificationRenderer.js

var notificationRendererApi = window.chatAPI || window.electronAPI;

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
    if (!vcpLogConnectionStatusDiv || !statusUpdate) return; // 增加对 statusUpdate 自身的检查

    // 安全地从 statusUpdate 对象中提取数据，无论其内部结构如何
    const source = statusUpdate.source;
    const message = statusUpdate.message;
    const status = statusUpdate.status;

    const prefix = source || 'VCPLog';
    vcpLogConnectionStatusDiv.textContent = `${prefix}: ${message || '状态未知'}`;
    vcpLogConnectionStatusDiv.className = `notifications-status status-${status || 'unknown'}`;
}

const handledToolApprovalRequestIds = new Set();

function sendToolApprovalResponse(requestId, approved, reason = '') {
    if (!requestId || !notificationRendererApi || typeof notificationRendererApi.sendVCPLogMessage !== 'function') {
        return false;
    }

    const responseData = {
        requestId,
        approved: approved === true
    };

    const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
    if (trimmedReason) {
        responseData.reason = trimmedReason;
    }

    notificationRendererApi.sendVCPLogMessage({
        type: 'tool_approval_response',
        data: responseData
    });
    return true;
}

/**
 * Renders a VCPLog notification in the notifications list.
 * @param {VCPLogData|string} logData - The parsed JSON log data or a raw string message.
 * @param {string|null} originalRawMessage - The original raw string message from WebSocket, if available.
 * @param {HTMLElement} notificationsListUl - The UL element for the persistent notifications sidebar.
 * @param {Object} themeColors - An object containing theme colors (largely unused now with CSS variables).
 */
function renderVCPLogNotification(logData, originalRawMessage = null, notificationsListUl, themeColors = {}) {
    if (logData && typeof logData === 'object' && logData.type === 'tool_approval_request' && logData.data && typeof logData.data === 'object') {
        const autoApprovalResult = window.filterManager?.checkToolAutoApproval?.(logData.data);
        if (autoApprovalResult && autoApprovalResult.action === 'approve') {
            const sent = sendToolApprovalResponse(logData.data.requestId, true);
            const autoApprovalLog = {
                type: 'tool_auto_approval',
                data: {
                    toolName: logData.data.toolName,
                    maid: logData.data.maid,
                    requestId: logData.data.requestId,
                    ruleName: autoApprovalResult.rule?.name || '未命名规则',
                    sent,
                    timestamp: new Date().toISOString()
                }
            };

            if (notificationsListUl) {
                renderVCPLogNotification(autoApprovalLog, JSON.stringify(autoApprovalLog), notificationsListUl, themeColors);
            }

            console.log('[NotificationRenderer] 工具调用已按规则自动允许:', autoApprovalLog.data);
            return;
        }
    }

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

                // Handle common error pattern: "执行错误: {"plugin_error": "..."}"
                if (vcpData.status === 'error' && rawContentString.includes('{')) {
                    const jsonStart = rawContentString.indexOf('{');
                    const prefix = rawContentString.substring(0, jsonStart);
                    const jsonPart = rawContentString.substring(jsonStart);
                    try {
                        const parsed = JSON.parse(jsonPart);
                        const displayError = parsed.plugin_error || parsed.error || parsed.message;
                        if (displayError) {
                            mainContent = prefix.trim() + (prefix.trim().endsWith(':') ? ' ' : ': ') + displayError;
                            contentIsPreformatted = false;
                        }
                    } catch (e) {
                        // Not valid JSON or parsing failed, keep raw content
                    }
                }

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
                        const pluginOutput = parsedInnerContent.original_plugin_output;
                        if (typeof pluginOutput === 'object' && pluginOutput !== null) {
                            // DailyNote 插件返回带有 status 和 message 字段，优先显示友好消息
                            if (vcpData.tool_name === 'DailyNote' && pluginOutput.message) {
                                const statusIcon = pluginOutput.status === 'success' ? '✅' : '❌';
                                mainContent = `${statusIcon} ${pluginOutput.message}`;
                                contentIsPreformatted = false;
                            } else if (pluginOutput.message && typeof pluginOutput.message === 'string') {
                                // 通用处理：如果插件输出包含 message 字段，优先显示
                                mainContent = pluginOutput.message;
                                contentIsPreformatted = false;
                            } else {
                                mainContent = JSON.stringify(pluginOutput, null, 2);
                                // contentIsPreformatted is already true (from line 52) and should remain true for JSON display
                            }
                        } else {
                            mainContent = String(pluginOutput);
                            contentIsPreformatted = false; // If it's not an object, treat as plain text
                        }
                    } else if (vcpData.tool_name === 'DailyNote') {
                        // DailyNote 新格式：content 直接包含 message/folder/fileName/MaidName/timestamp
                        // 也兼容旧格式（无 message 字段时显示默认文本）
                        const statusIcon = vcpData.status === 'success' ? '✅' : '❌';
                        if (parsedInnerContent.message) {
                            mainContent = `${statusIcon} ${parsedInnerContent.message}`;
                        } else {
                            mainContent = `${statusIcon} 日记内容已成功记录到本地知识库。`;
                        }
                        contentIsPreformatted = false;
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
    } else if (logData && typeof logData === 'object' && logData.type === 'tool_auto_approval' && logData.data && typeof logData.data === 'object') {
        const approvalLog = logData.data;
        titleText = `✅ 已自动允许: ${approvalLog.toolName || '未知工具'}`;
        mainContent = `助手: ${approvalLog.maid || '未知'}\n规则: ${approvalLog.ruleName || '未命名规则'}\n请求ID: ${approvalLog.requestId || 'N/A'}\n状态: ${approvalLog.sent ? '已发送允许响应' : '发送失败'}`;
        contentIsPreformatted = true;
    } else if (logData && typeof logData === 'object' && logData.type && logData.message) { // Generic type + message
        titleText = `类型: ${logData.type}`;
        mainContent = String(logData.message);
        if (logData.data) {
            mainContent += `\n数据: ${JSON.stringify(logData.data, null, 2)}`;
            contentIsPreformatted = true;
        }
    } else if (logData && typeof logData === 'object' && logData.type === 'tool_approval_request' && logData.data && typeof logData.data === 'object') {
        const approvalData = logData.data;
        titleText = `🛠️ 审核请求: ${approvalData.toolName}`;
        mainContent = `助手: ${approvalData.maid}\n命令: ${approvalData.args?.command || JSON.stringify(approvalData.args)}\n时间: ${approvalData.timestamp}`;
        contentIsPreformatted = true;
    } else { // Fallback for other structures or plain string
        titleText = 'VCP 消息:';
        mainContent = typeof logData === 'object' && logData !== null ? JSON.stringify(logData, null, 2) : String(logData);
        contentIsPreformatted = typeof logData === 'object';
    }
    // --- End Content Parsing ---

    const isToolApprovalRequest = logData && logData.type === 'tool_approval_request';

    // Function to populate a notification element (either toast or list item)
    const populateNotificationElement = (element, isToast) => {
        if (isToolApprovalRequest) {
            element.dataset.protectedNotification = 'tool-approval';
            element.dataset.toolApprovalRequestId = logData.data?.requestId || '';
            element.classList.add('notification-protected', 'notification-tool-approval');
        }

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

        // Special handling for approval requests - Moved here to be before timestamp
        if (isToolApprovalRequest) {
            const approvalReasonWrapper = document.createElement('div');
            approvalReasonWrapper.classList.add('notification-approval-reason');

            const reasonInput = document.createElement('textarea');
            reasonInput.classList.add('notification-approval-reason-input');
            reasonInput.placeholder = '可选：告诉 AI 为什么通过或拒绝';
            reasonInput.maxLength = 1000;
            reasonInput.rows = isToast ? 2 : 3;
            reasonInput.addEventListener('click', (e) => e.stopPropagation());
            reasonInput.addEventListener('keydown', (e) => e.stopPropagation());

            const reasonHint = document.createElement('div');
            reasonHint.classList.add('notification-approval-reason-hint');
            reasonHint.textContent = '拒绝时建议填写可执行的修正建议，最多 1000 字。';

            approvalReasonWrapper.appendChild(reasonInput);
            approvalReasonWrapper.appendChild(reasonHint);
            element.appendChild(approvalReasonWrapper);

            const approvalActions = document.createElement('div');
            approvalActions.classList.add('notification-actions');

            const finishApproval = (approved) => {
                const requestId = logData.data.requestId;
                if (handledToolApprovalRequestIds.has(requestId)) return;

                const sent = sendToolApprovalResponse(requestId, approved, reasonInput.value);
                if (!sent) return;

                handledToolApprovalRequestIds.add(requestId);
                dismissToolApprovalNotifications(requestId);
            };

            const allowBtn = document.createElement('button');
            allowBtn.textContent = '允许';
            allowBtn.classList.add('vcp-btn', 'vcp-btn-success');
            allowBtn.onclick = (e) => {
                e.stopPropagation();
                finishApproval(true);
            };

            const rejectBtn = document.createElement('button');
            rejectBtn.textContent = '拒绝';
            rejectBtn.classList.add('vcp-btn', 'vcp-btn-danger');
            rejectBtn.onclick = (e) => {
                e.stopPropagation();
                finishApproval(false);
            };

            approvalActions.appendChild(allowBtn);
            approvalActions.appendChild(rejectBtn);
            element.appendChild(approvalActions);
        }

        const timestampSpan = document.createElement('span');
        timestampSpan.classList.add('notification-timestamp');
        timestampSpan.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        element.appendChild(timestampSpan);

        if (isToast) {
            if (isToolApprovalRequest) {
                // 审核请求防误触：悬浮通知本体点击不关闭，必须点“允许/拒绝”。
                element.onclick = null;
            } else {
                element.onclick = () => {
                    // 清除自动消失的timeout（如果有的话）
                    if (element.dataset.autoDismissTimeout) {
                        clearTimeout(parseInt(element.dataset.autoDismissTimeout));
                    }
                    closeToastNotification(element);
                }; // Click on bubble itself still closes it
            }
        } else { // For persistent list item
            const copyButton = document.createElement('button');
            copyButton.className = 'notification-copy-btn';
            copyButton.textContent = '📋';
            copyButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>';
            copyButton.title = '复制消息到剪贴板';
            copyButton.onclick = (e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(textToCopy).then(() => {
                    const originalText = copyButton.textContent;
                    const originalMarkup = copyButton.innerHTML;
                    copyButton.textContent = '已复制!';
                    copyButton.disabled = true;
                    setTimeout(() => {
                        copyButton.textContent = originalText;
                        copyButton.innerHTML = originalMarkup;
                        copyButton.disabled = false;
                    }, 1500);
                }).catch(err => {
                    console.error('通知复制失败: ', err);
                    const originalText = copyButton.textContent;
                    const originalMarkup = copyButton.innerHTML;
                    copyButton.textContent = '错误!';
                    setTimeout(() => {
                        copyButton.textContent = originalText;
                        copyButton.innerHTML = originalMarkup;
                    }, 1500);
                });
            };
            element.appendChild(copyButton);

            // Click to dismiss for list items
            element.onclick = () => {
                // If it's an approval request, don't dismiss on body click to avoid misoperation
                if (logData && logData.type === 'tool_approval_request') return;

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

    const dismissToolApprovalNotifications = (requestId) => {
        if (!requestId) return;

        const escapedRequestId = CSS.escape(String(requestId));
        const approvalElements = document.querySelectorAll(`.notification-tool-approval[data-tool-approval-request-id="${escapedRequestId}"]`);

        approvalElements.forEach((approvalElement) => {
            approvalElement.querySelectorAll('button, textarea').forEach((control) => {
                control.disabled = true;
            });

            if (approvalElement.classList.contains('floating-toast-notification')) {
                closeToastNotification(approvalElement);
            } else {
                approvalElement.style.opacity = '0';
                approvalElement.style.transform = 'translateX(100%)';
                setTimeout(() => approvalElement.remove(), 500);
            }
        });
    };

    // 初始化焦点清理机制
    initializeFocusCleanup();

    // Render Floating Toast only if the sidebar is not already active and filter allows it
    const notificationsSidebarElement = document.getElementById('notificationsSidebar');

    // Check if message should be filtered
    const filterResult = checkMessageFilter(titleText);

    // 如果过滤总开关未启用，或者明确匹配白名单规则，则显示通知
    const shouldShowNotification = !filterResult || (filterResult.action === 'show');

    if (toastContainer && (!notificationsSidebarElement || !notificationsSidebarElement.classList.contains('active')) && shouldShowNotification) {
        const toastBubble = document.createElement('div');
        toastBubble.classList.add('floating-toast-notification');
        // 添加创建时间戳
        toastBubble.dataset.createdAt = Date.now().toString();
        populateNotificationElement(toastBubble, true);

        toastContainer.prepend(toastBubble);
        setTimeout(() => toastBubble.classList.add('visible'), 50);
        
        // 增强自动消失逻辑，支持自定义停留时间
        let autoDismissDelay = 7000; // 默认7秒

        // 审核类通知永不自动消失
        if (isToolApprovalRequest) {
            autoDismissDelay = Infinity;
        } else if (typeof window.checkMessageFilter === 'function') {
            const filterResult = window.checkMessageFilter(titleText);
            if (filterResult && filterResult.duration !== undefined) {
                autoDismissDelay = filterResult.duration === 0 ? Infinity : filterResult.duration * 1000;
            }
        }

        let autoDismissTimeout;
        if (autoDismissDelay === Infinity) {
            // 永久显示，不设置自动消失定时器
            autoDismissTimeout = null;
        } else {
            autoDismissTimeout = setTimeout(() => {
                if (toastBubble.parentNode && toastBubble.classList.contains('visible') && !toastBubble.classList.contains('exiting')) {
                    closeToastNotification(toastBubble);
                }
            }, autoDismissDelay);
        }
        
        // 保存timeout ID，以便在手动关闭时清除（如果有的话）
        if (autoDismissTimeout) {
            toastBubble.dataset.autoDismissTimeout = autoDismissTimeout.toString();
        }
    } else if (toastContainer && notificationsSidebarElement && notificationsSidebarElement.classList.contains('active')) {
        // console.log('Notification sidebar is active, suppressing floating toast.');
    } else if (filterResult && filterResult.action === 'hide') {
        console.log('Message filtered out by rule:', filterResult.rule?.name || 'default blacklist', 'Action:', filterResult.action);
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
                if (toast.dataset.protectedNotification === 'tool-approval') return;

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
                if (toast.dataset.protectedNotification === 'tool-approval') return;

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

// Make globalSettings accessible for do not disturb mode check
if (typeof window.globalSettings === 'undefined') {
    window.globalSettings = {};
}
