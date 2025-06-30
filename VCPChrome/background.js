let ws = null;
let isConnected = false;
const defaultServerUrl = 'ws://localhost:8088'; // 默认服务器地址
const defaultVcpKey = 'your_secret_key'; // 默认密钥

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
        };

        ws.onmessage = (event) => {
            console.log('Message from server:', event.data);
            const message = JSON.parse(event.data);
            
            // 处理来自服务器的指令
            if (message.type === 'command') {
                const commandData = message.data;
                // 检查是否是 open_url 指令
                if (commandData.command === 'open_url' && commandData.url) {
                    let fullUrl = commandData.url;
                    if (!fullUrl.startsWith('http://') && !fullUrl.startsWith('https://')) {
                        fullUrl = 'https://' + fullUrl;
                    }
                    chrome.tabs.create({ url: fullUrl }, (tab) => {
                        if (chrome.runtime.lastError) {
                            // 如果创建失败，发送错误回执
                            const errorMessage = `创建标签页失败: ${chrome.runtime.lastError.message}`;
                            console.error(errorMessage);
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
                            // 向遥控插件发送成功回执
                            if (ws && ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({
                                    type: 'command_result',
                                    data: {
                                        requestId: commandData.requestId,
                                        status: 'success',
                                        message: `成功打开URL: ${commandData.url}`
                                    }
                                }));
                            }
                        }
                    });
                } else {
                    // 其他指令照常转发给内容脚本
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
        };

        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            isConnected = false;
            ws = null;
            updateIcon();
            broadcastStatusUpdate(); // 广播最新状态
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
        sendResponse({ isConnected: isConnected });
    } else if (request.type === 'TOGGLE_CONNECTION') {
        if (isConnected) {
            disconnect();
        } else {
            connect();
        }
        // 不再立即返回状态，而是等待广播
        // sendResponse({ isConnected: !isConnected });
    } else if (request.type === 'PAGE_INFO_UPDATE') {
        // 从content_script接收到页面信息，发送到服务器
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'pageInfoUpdate',
                data: { markdown: request.data.markdown }
            }));
        }
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
        isConnected: isConnected
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
    // 请求新激活的标签页更新信息
    chrome.tabs.sendMessage(activeInfo.tabId, { type: 'REQUEST_PAGE_INFO_UPDATE' }).catch(e => {
        if (!e.message.includes("Could not establish connection")) console.log("Error sending to content script on tab activation:", e.message);
    });
});

// 监听标签页URL变化或加载状态变化
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // 当导航开始时，清除内容脚本的状态以防止内容累积
    if (changeInfo.status === 'loading') {
        chrome.tabs.sendMessage(tabId, { type: 'CLEAR_STATE' }).catch(e => {
            // This error is expected if the content script hasn't been injected yet
            if (!e.message.includes("Could not establish connection")) console.log("Error sending CLEAR_STATE:", e.message);
        });
    }
    // 当页面加载完成时，或者URL变化后加载完成时，请求更新
    if (changeInfo.status === 'complete' && tab.active) {
        chrome.tabs.sendMessage(tabId, { type: 'REQUEST_PAGE_INFO_UPDATE' }).catch(e => {
            if (!e.message.includes("Could not establish connection")) console.log("Error sending to content script on tab update:", e.message);
        });
    }
});

// 初始化图标状态
updateIcon();