console.log('[VCP Background] 🚀 VCPChrome background.js loaded.');
let ws = null;
let isConnected = false;
let isMonitoringEnabled = false; // 页面监控开关
let heartbeatIntervalId = null;
let latestPageInfo = null;
let currentActiveTabId = null;
let attachedTabId = null;
let networkLogs = new Map(); // requestId -> { request, response, body }
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
                    
                    // 如果命令请求等待页面信息，则不立即发送成功响应
                    const shouldWaitForPageInfo = commandData.wait_for_page_info === true;
                    
                    chrome.tabs.create({ url: fullUrl, active: true }, (tab) => {
                        if (chrome.runtime.lastError) {
                            const errorMessage = `创建标签页失败: ${chrome.runtime.lastError.message}`;
                            console.error('Error creating tab:', errorMessage);
                            if (ws && ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({
                                    type: 'command_result',
                                    data: {
                                        requestId: commandData.requestId,
                                        sourceClientId: commandData.sourceClientId,
                                        status: 'error',
                                        error: errorMessage
                                    }
                                }));
                            }
                        } else {
                            console.log('Tab created successfully. Tab ID:', tab.id, 'URL:', tab.url);
                            
                            // 如果不需要等待页面信息，立即发送成功响应
                            if (!shouldWaitForPageInfo && ws && ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({
                                    type: 'command_result',
                                    data: {
                                        requestId: commandData.requestId,
                                        sourceClientId: commandData.sourceClientId,
                                        status: 'success',
                                        message: `成功打开URL: ${commandData.url}`
                                    }
                                }));
                            } else {
                                // 需要等待页面信息，监听标签页加载完成
                                console.log(`[VCP Background] ⏳ 等待新标签页 [ID:${tab.id}] 加载完成...`);
                                
                                const tabUpdateListener = (tabId, changeInfo, updatedTab) => {
                                    if (tabId === tab.id && changeInfo.status === 'complete') {
                                        console.log(`[VCP Background] ✅ 新标签页 [ID:${tab.id}] 加载完成`);
                                        
                                        // 移除监听器
                                        chrome.tabs.onUpdated.removeListener(tabUpdateListener);
                                        
                                        // 现在发送成功响应
                                        if (ws && ws.readyState === WebSocket.OPEN) {
                                            ws.send(JSON.stringify({
                                                type: 'command_result',
                                                data: {
                                                    requestId: commandData.requestId,
                                                    sourceClientId: commandData.sourceClientId,
                                                    status: 'success',
                                                    message: `成功打开URL: ${commandData.url}`
                                                }
                                            }));
                                        }
                                        
                                        // 等待一小段时间让页面内容稳定，然后请求页面信息
                                        setTimeout(() => {
                                            chrome.tabs.sendMessage(tab.id, {
                                                type: 'REQUEST_PAGE_INFO_UPDATE'
                                            }).catch(e => {
                                                console.log('[VCP Background] ⚠️ 请求新标签页信息失败:', e.message);
                                            });
                                        }, 500);
                                    }
                                };
                                
                                // 添加监听器
                                chrome.tabs.onUpdated.addListener(tabUpdateListener);
                                
                                // 设置超时保护（30秒）
                                setTimeout(() => {
                                    chrome.tabs.onUpdated.removeListener(tabUpdateListener);
                                    console.log('[VCP Background] ⚠️ 等待新标签页加载超时');
                                }, 30000);
                            }
                        }
                    });
                } else {
                    console.log('Handling command:', commandData.command);
                    handleIncomingCommand(commandData);
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
    } else if (request.type === 'VERIFY_ACTIVE_TAB') {
        // 新增：验证发送者是否为当前活动标签页
        const senderTabId = sender.tab?.id;
        const isActive = senderTabId === currentActiveTabId;
        console.log(`[VCP Background] 🔍 验证标签页 [发送者:${senderTabId}] [活动:${currentActiveTabId}] [结果:${isActive}]`);
        sendResponse({ isActive: isActive });
        return true;
    } else if (request.type === 'TOGGLE_MONITORING') {
        // 切换页面监控状态
        isMonitoringEnabled = !isMonitoringEnabled;
        console.log('[VCP Background] 📡 页面监控状态:', isMonitoringEnabled ? '开启' : '关闭');
        
        // 保存状态
        chrome.storage.local.set({ isMonitoringEnabled: isMonitoringEnabled });
        
        // 广播状态更新
        broadcastStatusUpdate();
        broadcastMonitoringStatusToTabs();
        
        // 如果开启监控，立即请求当前活动标签页的信息
        if (isMonitoringEnabled && currentActiveTabId) {
            chrome.tabs.sendMessage(currentActiveTabId, {
                type: 'REQUEST_PAGE_INFO_UPDATE',
                isMonitoringEnabled: true
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
        const senderTabId = sender.tab?.id;
        
        // 检查1：只接受来自当前活动标签页的更新
        if (senderTabId !== currentActiveTabId) {
            console.log(`[VCP Background] ⚠️ 忽略非活动标签页的更新 [来源ID:${senderTabId} vs 活动ID:${currentActiveTabId}]`);
            return true;
        }
        
        // 检查2：监控未开启时忽略自动页面更新，避免关闭监控后仍持续刷新日志。
        // 手动刷新和命令执行后的显式更新可通过 force=true 绕过该限制。
        const isForcedUpdate = request.data?.force === true;
        if (!isMonitoringEnabled && !isForcedUpdate) {
            console.log('[VCP Background] ⚠️ 页面监控未开启，忽略自动页面更新');
            return true;
        }
        
        console.log(`[VCP Background] ✅ 接受活动标签页 [ID:${senderTabId}] 的${isForcedUpdate ? '强制' : '自动'}更新`);
        
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

async function handleIncomingCommand(commandData) {
    const { command, requestId, sourceClientId } = commandData;
    
    // 某些指令由 background 直接处理 (CDP 相关 / 主世界脚本执行 / 标签页管理)
    if (command.startsWith('cdp_') || command === 'execute_script' || command === 'list_tabs' || command === 'switch_tab' || command === 'close_tab') {
        try {
            let result;
            if (command === 'execute_script') {
                result = await executeScriptInMainWorld(commandData);
            } else if (command === 'list_tabs') {
                result = await listTabs();
            } else if (command === 'switch_tab') {
                result = await switchTab(commandData);
            } else if (command === 'close_tab') {
                result = await closeTab(commandData);
            } else {
                result = await processCdpCommand(commandData);
            }
            sendResponseToWs({
                type: 'command_result',
                data: { requestId, sourceClientId, status: 'success', ...result }
            });
        } catch (error) {
            sendResponseToWs({
                type: 'command_result',
                data: { requestId, sourceClientId, status: 'error', error: error.message }
            });
        }
        return;
    }

    // 其他指令转发给 content_script
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, {
                type: 'EXECUTE_COMMAND',
                data: commandData
            }).catch(err => {
                sendResponseToWs({
                    type: 'command_result',
                    data: { requestId, sourceClientId, status: 'error', error: '无法连接到页面脚本: ' + err.message }
                });
            });
        } else {
            sendResponseToWs({
                type: 'command_result',
                data: { requestId, sourceClientId, status: 'error', error: '没有活动的标签页' }
            });
        }
    });
}

function sendResponseToWs(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
}

function parseJsonParam(value, fallback = {}) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'object') return value;
    if (typeof value === 'string') {
        try {
            return JSON.parse(value);
        } catch (error) {
            throw new Error(`JSON 参数解析失败: ${error.message}`);
        }
    }
    throw new Error('JSON 参数必须是对象或 JSON 字符串');
}

function parseBooleanParam(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
    }
    return Boolean(value);
}

function parseNumberParam(value, defaultValue, minValue, maxValue) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return defaultValue;
    return Math.min(Math.max(parsed, minValue), maxValue);
}

async function ensureDebuggerAttached(tabId) {
    if (attachedTabId === tabId) return;
    if (attachedTabId) await detachDebugger(attachedTabId);
    await attachDebugger(tabId);
}

function sendCdpCommand(tabId, method, params = {}) {
    return new Promise((resolve, reject) => {
        chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(result || {});
        });
    });
}

async function executeScriptInMainWorld(commandData) {
    const tabId = currentActiveTabId;
    const code = commandData.text || '';
    if (!tabId) throw new Error('没有活动的标签页');
    if (!code.trim()) throw new Error('execute_script 缺少 text 代码内容');

    const injectionResults = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async (userCode) => {
            const fn = new Function(`return (async () => {\n${userCode}\n})()`);
            return await fn();
        },
        args: [code]
    });

    return {
        message: '脚本执行成功',
        result: injectionResults?.[0]?.result
    };
}

function listTabs() {
    return new Promise((resolve) => {
        chrome.tabs.query({}, (tabs) => {
            const tabList = tabs.map(tab => ({
                id: tab.id,
                title: tab.title,
                url: tab.url,
                active: tab.active
            }));
            resolve({
                message: '获取标签页列表成功',
                result: tabList
            });
        });
    });
}

function switchTab(commandData) {
    const target = commandData.target;
    if (!target) {
        throw new Error('switch_tab 缺少 target 参数');
    }
    return new Promise((resolve, reject) => {
        chrome.tabs.query({}, (tabs) => {
            let targetTab = null;
            
            // 1. 尝试作为 tabId 匹配
            const tabId = parseInt(target, 10);
            if (!isNaN(tabId)) {
                targetTab = tabs.find(t => t.id === tabId);
            }
            
            // 2. 如果没找到，尝试模糊匹配标题或 URL
            if (!targetTab) {
                const normalizedTarget = target.toLowerCase();
                targetTab = tabs.find(t =>
                    (t.title && t.title.toLowerCase().includes(normalizedTarget)) ||
                    (t.url && t.url.toLowerCase().includes(normalizedTarget))
                );
            }
            
            if (!targetTab) {
                return reject(new Error(`未找到匹配的标签页: ${target}`));
            }
            
            chrome.tabs.update(targetTab.id, { active: true }, (tab) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(`切换标签页失败: ${chrome.runtime.lastError.message}`));
                } else {
                    currentActiveTabId = targetTab.id;
                    resolve({
                        message: `成功切换到标签页: ${targetTab.title || targetTab.url}`,
                        result: { id: targetTab.id, title: targetTab.title, url: targetTab.url }
                    });
                }
            });
        });
    });
}

function closeTab(commandData) {
    const target = commandData.target;
    return new Promise((resolve, reject) => {
        chrome.tabs.query({}, (tabs) => {
            let targetTab = null;
            
            if (!target) {
                targetTab = tabs.find(t => t.active);
            } else {
                // 1. 尝试作为 tabId 匹配
                const tabId = parseInt(target, 10);
                if (!isNaN(tabId)) {
                    targetTab = tabs.find(t => t.id === tabId);
                }
                
                // 2. 如果没找到，尝试模糊匹配标题或 URL
                if (!targetTab) {
                    const normalizedTarget = target.toLowerCase();
                    targetTab = tabs.find(t =>
                        (t.title && t.title.toLowerCase().includes(normalizedTarget)) ||
                        (t.url && t.url.toLowerCase().includes(normalizedTarget))
                    );
                }
            }
            
            if (!targetTab) {
                return reject(new Error(`未找到要关闭的标签页: ${target || '当前活动标签页'}`));
            }
            
            chrome.tabs.remove(targetTab.id, () => {
                if (chrome.runtime.lastError) {
                    reject(new Error(`关闭标签页失败: ${chrome.runtime.lastError.message}`));
                } else {
                    resolve({
                        message: `成功关闭标签页: ${targetTab.title || targetTab.url}`,
                        result: { id: targetTab.id, title: targetTab.title, url: targetTab.url }
                    });
                }
            });
        });
    });
}

async function processCdpCommand(commandData) {
    const {
        command,
        urlIncludes,
        cdpRequestId,
        expression,
        selector,
        nodeId,
        depth,
        pierce,
        headers,
        userAgent,
        acceptLanguage,
        platform,
        timezoneId,
        locale,
        width,
        height,
        deviceScaleFactor,
        mobile,
        origin,
        storageTypes,
        cdpParams
    } = commandData;
    const tabId = currentActiveTabId;

    if (!tabId) throw new Error('没有活动的标签页');

    switch (command) {
        case 'cdp_start':
            if (attachedTabId === tabId) return { message: 'CDP 已在该标签页启动' };
            if (attachedTabId) await detachDebugger(attachedTabId);
            await attachDebugger(tabId);
            return { message: 'CDP 启动成功' };

        case 'cdp_stop':
            if (attachedTabId) await detachDebugger(attachedTabId);
            return { message: 'CDP 已停止' };

        case 'cdp_network_query':
            const logs = Array.from(networkLogs.values()).filter(log => {
                if (urlIncludes && !log.request.url.includes(urlIncludes)) return false;
                return true;
            });
            return { result: logs };

        case 'cdp_get_response_body':
            if (!attachedTabId) throw new Error('CDP 未启动');
            return { result: await sendCdpCommand(attachedTabId, 'Network.getResponseBody', { requestId: cdpRequestId }) };

        case 'cdp_clear_network':
            networkLogs.clear();
            return { message: '网络日志已清空' };

        case 'cdp_runtime_evaluate':
            await ensureDebuggerAttached(tabId);
            if (!expression || !String(expression).trim()) throw new Error('cdp_runtime_evaluate 缺少 expression 参数');
            return {
                message: 'Runtime.evaluate 执行成功',
                result: await sendCdpCommand(tabId, 'Runtime.evaluate', {
                    expression: String(expression),
                    awaitPromise: true,
                    returnByValue: true,
                    ...parseJsonParam(cdpParams, {})
                })
            };

        case 'cdp_dom_get_document':
            await ensureDebuggerAttached(tabId);
            return {
                message: 'DOM.getDocument 执行成功',
                result: await sendCdpCommand(tabId, 'DOM.getDocument', {
                    depth: parseNumberParam(depth, 1, -1, 100),
                    pierce: parseBooleanParam(pierce, false),
                    ...parseJsonParam(cdpParams, {})
                })
            };

        case 'cdp_dom_query_selector':
            await ensureDebuggerAttached(tabId);
            if (!selector || !String(selector).trim()) throw new Error('cdp_dom_query_selector 缺少 selector 参数');
            let rootNodeId = Number(nodeId);
            if (!Number.isFinite(rootNodeId) || rootNodeId <= 0) {
                const documentResult = await sendCdpCommand(tabId, 'DOM.getDocument', { depth: 1, pierce: true });
                rootNodeId = documentResult.root?.nodeId;
            }
            if (!rootNodeId) throw new Error('无法获取 DOM 根节点 nodeId');
            return {
                message: 'DOM.querySelector 执行成功',
                result: await sendCdpCommand(tabId, 'DOM.querySelector', {
                    nodeId: rootNodeId,
                    selector: String(selector),
                    ...parseJsonParam(cdpParams, {})
                })
            };

        case 'cdp_network_set_extra_http_headers':
            await ensureDebuggerAttached(tabId);
            return {
                message: 'Network.setExtraHTTPHeaders 执行成功',
                result: await sendCdpCommand(tabId, 'Network.setExtraHTTPHeaders', {
                    headers: parseJsonParam(headers || cdpParams, {})
                })
            };

        case 'cdp_network_set_user_agent_override':
            await ensureDebuggerAttached(tabId);
            if (!userAgent || !String(userAgent).trim()) throw new Error('cdp_network_set_user_agent_override 缺少 userAgent 参数');
            return {
                message: 'Network.setUserAgentOverride 执行成功',
                result: await sendCdpCommand(tabId, 'Network.setUserAgentOverride', {
                    userAgent: String(userAgent),
                    ...(acceptLanguage ? { acceptLanguage: String(acceptLanguage) } : {}),
                    ...(platform ? { platform: String(platform) } : {}),
                    ...parseJsonParam(cdpParams, {})
                })
            };

        case 'cdp_emulation_set_timezone_override':
            await ensureDebuggerAttached(tabId);
            if (!timezoneId || !String(timezoneId).trim()) throw new Error('cdp_emulation_set_timezone_override 缺少 timezoneId 参数');
            return {
                message: 'Emulation.setTimezoneOverride 执行成功',
                result: await sendCdpCommand(tabId, 'Emulation.setTimezoneOverride', { timezoneId: String(timezoneId) })
            };

        case 'cdp_emulation_set_locale_override':
            await ensureDebuggerAttached(tabId);
            if (!locale || !String(locale).trim()) throw new Error('cdp_emulation_set_locale_override 缺少 locale 参数');
            return {
                message: 'Emulation.setLocaleOverride 执行成功',
                result: await sendCdpCommand(tabId, 'Emulation.setLocaleOverride', { locale: String(locale) })
            };

        case 'cdp_emulation_set_device_metrics_override':
            await ensureDebuggerAttached(tabId);
            return {
                message: 'Emulation.setDeviceMetricsOverride 执行成功',
                result: await sendCdpCommand(tabId, 'Emulation.setDeviceMetricsOverride', {
                    width: parseNumberParam(width, 1280, 1, 10000),
                    height: parseNumberParam(height, 720, 1, 10000),
                    deviceScaleFactor: parseNumberParam(deviceScaleFactor, 1, 0, 10),
                    mobile: parseBooleanParam(mobile, false),
                    ...parseJsonParam(cdpParams, {})
                })
            };

        case 'cdp_storage_get_cookies':
            await ensureDebuggerAttached(tabId);
            return {
                message: 'Storage.getCookies 执行成功',
                result: await sendCdpCommand(tabId, 'Storage.getCookies', parseJsonParam(cdpParams, {}))
            };

        case 'cdp_storage_clear_data_for_origin':
            await ensureDebuggerAttached(tabId);
            if (!origin || !String(origin).trim()) throw new Error('cdp_storage_clear_data_for_origin 缺少 origin 参数');
            return {
                message: 'Storage.clearDataForOrigin 执行成功',
                result: await sendCdpCommand(tabId, 'Storage.clearDataForOrigin', {
                    origin: String(origin),
                    storageTypes: String(storageTypes || 'cookies,local_storage,session_storage,cache_storage,indexeddb')
                })
            };

        default:
            throw new Error('未知的 CDP 指令: ' + command);
    }
}

function attachDebugger(tabId) {
    return new Promise((resolve, reject) => {
        chrome.debugger.attach({ tabId }, "1.3", () => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            attachedTabId = tabId;
            chrome.debugger.sendCommand({ tabId }, "Network.enable", {}, () => {
                if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
                console.log('[VCP Background] CDP Network enabled');
                resolve();
            });
        });
    });
}

function detachDebugger(tabId) {
    return new Promise((resolve) => {
        chrome.debugger.detach({ tabId }, () => {
            attachedTabId = null;
            networkLogs.clear();
            resolve();
        });
    });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
    if (method === "Network.requestWillBeSent") {
        networkLogs.set(params.requestId, {
            requestId: params.requestId,
            request: params.request,
            timestamp: params.timestamp,
            resourceType: params.type
        });
    } else if (method === "Network.responseReceived") {
        let log = networkLogs.get(params.requestId);
        if (log) {
            log.response = params.response;
        }
    }
});

chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId === attachedTabId) {
        attachedTabId = null;
        networkLogs.clear();
        console.log('[VCP Background] CDP Detached');
    }
});

function broadcastMonitoringStatusToTabs() {
    chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }, (tabs) => {
        tabs.forEach(tab => {
            chrome.tabs.sendMessage(tab.id, {
                type: 'MONITORING_STATUS_CHANGED',
                isMonitoringEnabled
            }).catch(e => {
                if (!e.message.includes("Could not establish connection")) {
                    console.log("[VCP Background] ⚠️ 同步监控状态到标签页失败:", e.message);
                }
            });
        });
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
    const previousTabId = currentActiveTabId;
    currentActiveTabId = activeInfo.tabId;
    
    console.log(`[VCP Background] 🔄 标签页切换 [从:${previousTabId}] [到:${activeInfo.tabId}]`);
    
    // 获取标签页详细信息并打印
    chrome.tabs.get(activeInfo.tabId, (tab) => {
        if (chrome.runtime.lastError) {
            console.log('[VCP Background] 📍 标签页切换，新活动标签页 ID:', activeInfo.tabId);
        } else {
            console.log(`[VCP Background] 🎯 当前激活标签页 [ID:${tab.id}] 标题:《${tab.title}》 URL:${tab.url}`);
        }
    });
    
    // 只有在监控开启时才请求更新
    if (isMonitoringEnabled) {
        // 使用重试机制发送更新请求，因为content script可能还未完全准备好
        const sendUpdateRequest = (retryCount = 0) => {
            chrome.tabs.sendMessage(activeInfo.tabId, { type: 'REQUEST_PAGE_INFO_UPDATE', isMonitoringEnabled: true }, (response) => {
                if (chrome.runtime.lastError) {
                    if (retryCount < 2) { // 最多重试2次
                        console.log(`[VCP Background] ⚠️ 发送更新请求失败，${200 * (retryCount + 1)}ms后重试 (${retryCount + 1}/2)`);
                        setTimeout(() => sendUpdateRequest(retryCount + 1), 200 * (retryCount + 1));
                    } else if (!chrome.runtime.lastError.message.includes("Could not establish connection")) {
                        console.log("[VCP Background] ❌ 发送更新请求最终失败:", chrome.runtime.lastError.message);
                    }
                } else {
                    console.log(`[VCP Background] ✅ 成功发送更新请求到标签页 ${activeInfo.tabId}`);
                }
            });
        };
        
        // 立即发送第一次，如果失败会自动重试
        sendUpdateRequest();
    }
});

// 监听标签页URL变化或加载状态变化
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // 当导航开始时，清除内容脚本的状态以防止内容累积
    if (changeInfo.status === 'loading' && tab.active) {
        console.log(`[VCP Background] 🔄 活动标签页开始加载 [ID:${tabId}]`);
        chrome.tabs.sendMessage(tabId, { type: 'CLEAR_STATE' }).catch(e => {
            if (!e.message.includes("Could not establish connection")) {
                console.log("Error sending CLEAR_STATE:", e.message);
            }
        });
    }
    
    // 只在活动标签页加载完成时请求更新
    if (changeInfo.status === 'complete' && tab.active) {
        currentActiveTabId = tabId;
        console.log(`[VCP Background] ✅ 活动标签页加载完成 [ID:${tab.id}] 标题:《${tab.title}》`);
        
        if (isMonitoringEnabled) {
            // 页面加载完成后，稍微延迟一下再请求，让页面内容更稳定
            setTimeout(() => {
                const sendUpdateRequest = (retryCount = 0) => {
                    chrome.tabs.sendMessage(tabId, { type: 'REQUEST_PAGE_INFO_UPDATE', isMonitoringEnabled: true }, (response) => {
                        if (chrome.runtime.lastError) {
                            if (retryCount < 3) { // 页面加载后可以多重试几次
                                console.log(`[VCP Background] ⚠️ 页面加载完成后请求失败，${300 * (retryCount + 1)}ms后重试 (${retryCount + 1}/3)`);
                                setTimeout(() => sendUpdateRequest(retryCount + 1), 300 * (retryCount + 1));
                            } else if (!chrome.runtime.lastError.message.includes("Could not establish connection")) {
                                console.log("[VCP Background] ❌ 页面加载后更新请求最终失败:", chrome.runtime.lastError.message);
                            }
                        } else {
                            console.log(`[VCP Background] ✅ 成功请求页面加载后的更新 [ID:${tabId}]`);
                        }
                    });
                };
                sendUpdateRequest();
            }, 300); // 等待300ms让页面更稳定
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
        broadcastMonitoringStatusToTabs();
    }
});

// 初始化图标状态
updateIcon();