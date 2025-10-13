console.log('[VCP Background] 🚀 VCPChrome background.js loaded.');
let ws = null;
let isConnected = false;
let isMonitoringEnabled = false; // 页面监控开关
let heartbeatIntervalId = null;
let latestPageInfo = null;
let currentActiveTabId = null;
const HEARTBEAT_INTERVAL = 30 * 1000;
const defaultServerUrl = 'ws://localhost:8088';
const defaultVcpKey = 'your_secret_key';

function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.log('WebSocket is already connected.');
        return;
    }

    // 从storage获取URL和Key
    chrome.storage.local.get(['serverUrl', 'vcpKey'], (result) => {
        const serverUrlToUse = result.serverUrl || defaultServerUrl;
        const keyToUse = result.vcpKey || defaultVcpKey;
        
        const fullUrl = `${serverUrlToUse}/vcp-chrome-observer/VCP_Key=${keyToUse}`;
        console.log('Connecting to:', fullUrl);

        ws = new WebSocket(fullUrl);

        ws.onopen = () => {
            console.log('WebSocket connection established.');
            isConnected = true;
            updateIcon();
            broadcastStatusUpdate(); // 广播最新状态
            // 启动心跳包
            heartbeatIntervalId = setInterval(() => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }));
                    console.log('Sent heartbeat.');
                }
            }, HEARTBEAT_INTERVAL);
        };

        ws.onmessage = (event) => {
            console.log('Message from server:', event.data);
            const message = JSON.parse(event.data);
            
            // 处理来自服务器的指令
            if (message.type === 'heartbeat_ack') {
                console.log('Received heartbeat acknowledgment.');
                // 可以选择更新一个时间戳来跟踪连接活跃度
            } else if (message.type === 'command') {
                const commandData = message.data;
                console.log('Received commandData:', commandData);
                // 检查是否是 open_url 指令
                if (commandData.command === 'open_url' && commandData.url) {
                    console.log('Handling open_url command. URL:', commandData.url);
                    let fullUrl = commandData.url;
                    if (!fullUrl.startsWith('http://') && !fullUrl.startsWith('https://')) {
                        fullUrl = 'https://' + fullUrl;
                    }
                    console.log('Attempting to create tab with URL:', fullUrl);
                    chrome.tabs.create({ url: fullUrl }, (tab) => {
                        if (chrome.runtime.lastError) {
                            const errorMessage = `创建标签页失败: ${chrome.runtime.lastError.message}`;
                            console.error('Error creating tab:', errorMessage);
                            if (ws && ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({
                                    type: 'command_result',
                                    data: {
                                        requestId: commandData.requestId,
                                        status: 'error',
                                        error: errorMessage
                                    }
                                }));
                            }
                        } else {
                            console.log('Tab created successfully. Tab ID:', tab.id, 'URL:', tab.url);
                            if (ws && ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({
                                    type: 'command_result',
                                    data: {
                                        requestId: commandData.requestId,
                                        sourceClientId: commandData.sourceClientId, // 确保返回 sourceClientId
                                        status: 'success',
                                        message: `成功打开URL: ${commandData.url}`
                                    }
                                }));
                            }
                        }
                    });
                } else {
                    console.log('Forwarding command to content script:', commandData);
                    forwardCommandToContentScript(commandData);
                }
            }
        };

        ws.onclose = () => {
            console.log('WebSocket connection closed.');
            isConnected = false;
            ws = null;
            updateIcon();
            broadcastStatusUpdate(); // 广播最新状态
            if (heartbeatIntervalId) {
                clearInterval(heartbeatIntervalId);
                heartbeatIntervalId = null;
            }
        };

        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            isConnected = false;
            ws = null;
            updateIcon();
            broadcastStatusUpdate(); // 广播最新状态
            if (heartbeatIntervalId) {
                clearInterval(heartbeatIntervalId);
                heartbeatIntervalId = null;
            }
        };
    });
}

function disconnect() {
    if (ws) {
        ws.close();
    }
}

function updateIcon() {
    const iconPath = isConnected ? 'icons/icon48.png' : 'icons/icon_disconnected.png'; // 你需要创建一个断开连接的图标
    // 为了简单起见，我们先只改变徽章
    chrome.action.setBadgeText({ text: isConnected ? 'On' : 'Off' });
    chrome.action.setBadgeBackgroundColor({ color: isConnected ? '#00C853' : '#FF5252' });
}

// 监听来自popup和content_script的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'GET_STATUS') {
        sendResponse({
            isConnected: isConnected,
            isMonitoringEnabled: isMonitoringEnabled
        });
    } else if (request.type === 'TOGGLE_MONITORING') {
        // 切换页面监控状态
        isMonitoringEnabled = !isMonitoringEnabled;
        console.log('[VCP Background] 📡 页面监控状态:', isMonitoringEnabled ? '开启' : '关闭');
        
        // 保存状态
        chrome.storage.local.set({ isMonitoringEnabled: isMonitoringEnabled });
        
        // 广播状态更新
        broadcastStatusUpdate();
        
        // 如果开启监控，立即请求当前活动标签页的信息
        if (isMonitoringEnabled && currentActiveTabId) {
            chrome.tabs.sendMessage(currentActiveTabId, {
                type: 'REQUEST_PAGE_INFO_UPDATE'
            }).catch(e => {
                if (!e.message.includes("Could not establish connection")) {
                    console.log("Error requesting page info:", e.message);
                }
            });
        }
        
        sendResponse({ isMonitoringEnabled: isMonitoringEnabled });
        return true;
    } else if (request.type === 'TOGGLE_CONNECTION') {
        if (isConnected) {
            disconnect();
        } else {
            connect();
        }
        // 不再立即返回状态，而是等待广播
        // sendResponse({ isConnected: !isConnected });
    } else if (request.type === 'PAGE_INFO_UPDATE') {
        // 检查1：监控是否开启
        if (!isMonitoringEnabled) {
            console.log('[VCP Background] ⚠️ 页面监控未开启，忽略更新');
            return true;
        }
        
        // 检查2：只接受来自当前活动标签页的更新
        const senderTabId = sender.tab?.id;
        
        if (senderTabId !== currentActiveTabId) {
            console.log(`[VCP Background] ⚠️ 忽略非活动标签页的更新 [来源ID:${senderTabId} vs 活动ID:${currentActiveTabId}]`);
            return true;
        }
        
        console.log(`[VCP Background] ✅ 接受活动标签页 [ID:${senderTabId}] 的更新`);
        
        // 发送到VCP服务器（如果已连接）
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'pageInfoUpdate',
                data: { markdown: request.data.markdown }
            }));
            
            // 新增：解析markdown获取标题和URL，并广播给popup
            const lines = request.data.markdown.split('\n');
            let title = '';
            let url = '';
            
            // 从markdown中提取标题和URL
            if (lines.length > 0) {
                // 第一行通常是 # 标题
                title = lines[0].replace(/^#\s*/, '').trim();
            }
            if (lines.length > 1) {
                // 第二行通常是 URL: xxx
                const urlMatch = lines[1].match(/^URL:\s*(.+)/);
                if (urlMatch) {
                    url = urlMatch[1].trim();
                }
            }
            
            const pageInfo = {
                title: title || '未知页面',
                url: url || '未知URL',
                timestamp: Date.now()
            };

            console.log('[VCP Background] 📄 解析到页面信息:', pageInfo);

            // 关键修复：无论popup是否打开，都立即存储最新信息
            latestPageInfo = pageInfo; // 缓存到内存
            console.log('[VCP Background] 💾 已存储到内存');
            
            chrome.storage.local.set({ lastPageInfo: pageInfo }, () => {
                console.log('[VCP Background] 💾 已存储到storage');
            });

            // 广播页面信息给popup（如果它打开了）
            chrome.runtime.sendMessage({
                type: 'PAGE_INFO_BROADCAST',
                data: pageInfo
            }).catch(error => {
                // popup未打开时会出错，这是正常的
                if (!error.message.includes("Could not establish connection")) {
                    console.error("[VCP Background] ❌ 广播失败:", error);
                }
            });
        }
    } else if (request.type === 'MANUAL_REFRESH') {
        // 手动刷新不受监控开关限制
        console.log('[VCP Background] 🔄 收到手动刷新请求');
        // 获取所有普通网页标签页（排除chrome://等特殊页面）
        chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }, (tabs) => {
            console.log('[VCP Background] 找到的网页标签页数量:', tabs.length);
            if (tabs.length === 0) {
                console.log('[VCP Background] ❌ 没有找到普通网页标签页');
                sendResponse({ success: false, error: '没有找到普通网页标签页' });
                return;
            }
            
            // 优先选择活动标签页，否则选择最后访问的标签页
            let targetTab = tabs.find(tab => tab.active) || tabs.sort((a, b) => b.id - a.id)[0];
            console.log(`[VCP Background] 🔄 手动刷新目标 [ID:${targetTab.id}] 标题:《${targetTab.title}》`);
            
            console.log('[VCP Background] 向content script发送强制更新请求');
            
            // 先尝试发送消息
            chrome.tabs.sendMessage(targetTab.id, {
                type: 'FORCE_PAGE_UPDATE'
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.log('[VCP Background] ⚠️ Content script未就绪，尝试重新注入');
                    // Content script未注入，先注入再发送
                    chrome.scripting.executeScript({
                        target: { tabId: targetTab.id },
                        files: ['content_script.js']
                    }, () => {
                        if (chrome.runtime.lastError) {
                            console.log('[VCP Background] ❌ 注入失败:', chrome.runtime.lastError.message);
                            sendResponse({ success: false, error: '无法注入脚本: ' + chrome.runtime.lastError.message });
                        } else {
                            console.log('[VCP Background] ✅ 脚本注入成功，重新发送请求');
                            // 等待一小段时间确保脚本完全加载
                            setTimeout(() => {
                                chrome.tabs.sendMessage(targetTab.id, {
                                    type: 'FORCE_PAGE_UPDATE'
                                }, (response) => {
                                    if (chrome.runtime.lastError) {
                                        console.log('[VCP Background] ❌ 重试发送失败:', chrome.runtime.lastError.message);
                                        sendResponse({ success: false, error: chrome.runtime.lastError.message });
                                    } else {
                                        console.log('[VCP Background] ✅ content script响应:', response);
                                        sendResponse({ success: true });
                                    }
                                });
                            }, 100);
                        }
                    });
                } else {
                    console.log('[VCP Background] ✅ content script响应:', response);
                    sendResponse({ success: true });
                }
            });
        });
        return true; // 保持消息通道开放
    } else if (request.type === 'GET_LATEST_PAGE_INFO') {
        // 新增：处理popup获取最新页面信息的请求
        console.log('[VCP Background] 📤 收到获取页面信息请求，返回:', latestPageInfo);
        sendResponse(latestPageInfo);
        return true;
    } else if (request.type === 'COMMAND_RESULT') {
        // 从content_script接收到命令执行结果，发送到服务器
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'command_result',
                data: request.data
            }));
        }
    }
    return true; // 保持消息通道开放以进行异步响应
});

function forwardCommandToContentScript(commandData) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, {
                type: 'EXECUTE_COMMAND',
                data: commandData
            });
        }
    });
}

function broadcastStatusUpdate() {
    chrome.runtime.sendMessage({
        type: 'STATUS_UPDATE',
        isConnected: isConnected,
        isMonitoringEnabled: isMonitoringEnabled
    }).catch(error => {
        // 捕获当popup未打开时发送消息产生的错误，这是正常现象
        if (error.message.includes("Could not establish connection. Receiving end does not exist.")) {
            // This is expected if the popup is not open.
        } else {
            console.error("Error broadcasting status:", error);
        }
    });
}

// 监听标签页切换
chrome.tabs.onActivated.addListener((activeInfo) => {
    currentActiveTabId = activeInfo.tabId;
    
    // 获取标签页详细信息并打印
    chrome.tabs.get(activeInfo.tabId, (tab) => {
        if (chrome.runtime.lastError) {
            console.log('[VCP Background] 📍 标签页切换，新活动标签页 ID:', activeInfo.tabId);
        } else {
            console.log(`[VCP Background] 🎯 检测到当前激活标签页 [ID:${tab.id}] 标题:《${tab.title}》 URL:${tab.url}`);
        }
    });
    
    // 只有在监控开启时才请求更新
    if (isMonitoringEnabled) {
        chrome.tabs.sendMessage(activeInfo.tabId, { type: 'REQUEST_PAGE_INFO_UPDATE' }).catch(e => {
            if (!e.message.includes("Could not establish connection")) {
                console.log("Error sending to content script on tab activation:", e.message);
            }
        });
    }
});

// 监听标签页URL变化或加载状态变化
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // 当导航开始时，清除内容脚本的状态以防止内容累积
    if (changeInfo.status === 'loading' && tab.active) {
        chrome.tabs.sendMessage(tabId, { type: 'CLEAR_STATE' }).catch(e => {
            if (!e.message.includes("Could not establish connection")) {
                console.log("Error sending CLEAR_STATE:", e.message);
            }
        });
    }
    // 只在活动标签页加载完成时请求更新（且监控已开启）
    if (changeInfo.status === 'complete' && tab.active) {
        currentActiveTabId = tabId;
        console.log(`[VCP Background] ✅ 活动标签页加载完成 [ID:${tab.id}] 标题:《${tab.title}》`);
        
        if (isMonitoringEnabled) {
            chrome.tabs.sendMessage(tabId, { type: 'REQUEST_PAGE_INFO_UPDATE' }).catch(e => {
                if (!e.message.includes("Could not establish connection")) {
                    console.log("Error sending to content script on tab update:", e.message);
                }
            });
        }
    }
});

// 初始化：获取当前活动标签页和监控状态
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
        currentActiveTabId = tabs[0].id;
        console.log(`[VCP Background] 🎯 初始化：检测到当前激活标签页 [ID:${tabs[0].id}] 标题:《${tabs[0].title}》 URL:${tabs[0].url}`);
    }
});

// 从storage恢复监控状态
chrome.storage.local.get(['isMonitoringEnabled'], (result) => {
    if (result.isMonitoringEnabled !== undefined) {
        isMonitoringEnabled = result.isMonitoringEnabled;
        console.log('[VCP Background] 📡 恢复监控状态:', isMonitoringEnabled ? '开启' : '关闭');
    }
});

// 初始化图标状态
updateIcon();