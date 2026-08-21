importScripts(
    'webcore/web-agent-protocol.js',
    'webcore/adapter-contract.js',
    'webcore/web-agent-runtime-core.js',
    'webcore/chrome-adapter.js'
);

if (
    !globalThis.VCPWebAgentProtocol ||
    !globalThis.VCPWebAgentAdapterContract ||
    !globalThis.VCPWebAgentRuntimeCore ||
    !globalThis.VCPChromeWebAgentAdapter
) {
    throw new Error('VCP Web Agent Runtime Core 加载失败');
}

console.log('[VCP Background] 🚀 VCPChrome background.js loaded.');
let ws = null;
let isConnected = false;
const pendingUrlFetchCookieSync = new Map();
let isMonitoringEnabled = false; // 页面监控开关
let redactSensitiveDom = true; // 浏览器内隐私开关：默认开启，用户可在 Popup 显式关闭
let heartbeatIntervalId = null;
let latestPageInfo = null;
let currentActiveTabId = null;
const pageImageCache = new Map();
const PAGE_IMAGE_CACHE_MAX_ENTRIES = 24;
const PAGE_IMAGE_CACHE_TTL_MS = 10 * 60 * 1000;
const HEARTBEAT_INTERVAL = 30 * 1000;
const defaultServerUrl = 'ws://localhost:8088';
const defaultVcpKey = 'your_secret_key';
let runtimeIdentity = {
    protocolVersion: 3,
    clientKind: 'user',
    managedRuntime: false,
    manualManagedSelection: false,
    managedToken: null,
    managedTokenCreatedAt: 0,
    stageGeneration: null,
    sourceManifestHash: null,
    stagedManifestHash: null,
    runtimeConfigGeneratedAt: null,
    maxTabs: 8,
    snapshotBackends: ['content-script'],
    actionBackends: ['content-script', 'cdp-input', 'main-world'],
    capabilities: [
        'pageInfo', 'tabs', 'script', 'cdp', 'storage', 'networkBody', 'snapshotHandles',
        'structuredErrors', 'screenshot', 'stableSnapshotHash', 'actionVerification',
        'sensitiveDomRedaction', 'cdpInput', 'occlusionCheck', 'sendKeys', 'setValue',
        'selectOption', 'hover', 'check', 'waitFor', 'unifiedPageGraph',
        'groundedMarkdown', 'interactionTree', 'scrollContext', 'snapshotDiff',
        'pageImages', 'pageImageCapture'
    ]
};

let runtimeConnectionConfig = {
    serverUrl: null,
    vcpKey: null
};
let reconnectTimerId = null;
let connectionEnabled = true;

const chromeWebAgentAdapter = globalThis.VCPChromeWebAgentAdapter.createChromeWebAgentAdapter(chrome, {
    currentActiveTabId
});
const webAgentRuntime = globalThis.VCPWebAgentRuntimeCore.createWebAgentRuntime(chromeWebAgentAdapter, {
    audit(event) {
        if (event.phase === 'error') {
            console.warn('[VCP Background] Web Agent Core audit:', event);
        }
    }
});

function getCoreTargetContext(commandData = {}) {
    const targetId = commandData.targetId ?? currentActiveTabId;
    const documentState = targetId === null || targetId === undefined
        ? {}
        : chromeWebAgentAdapter.documentStates.get(String(targetId)) || {};
    return {
        adapter: 'chrome',
        targetId,
        appId: null,
        runtimeInstanceId: chromeWebAgentAdapter.runtimeInstanceId,
        documentGeneration: commandData.documentGeneration ?? documentState.documentGeneration ?? null,
        snapshotId: commandData.snapshotId ?? documentState.snapshotId ?? null
    };
}

async function executeLegacyCommandThroughCore(commandData = {}) {
    chromeWebAgentAdapter.setActiveTargetId(currentActiveTabId);
    const request = globalThis.VCPWebAgentRuntimeCore.normalizeLegacyChromeCommand(
        commandData,
        getCoreTargetContext(commandData)
    );
    const response = await webAgentRuntime.execute(request);
    const legacy = globalThis.VCPWebAgentRuntimeCore.formatLegacyChromeResult(response);
    if (legacy.status === 'error') {
        const error = new Error(legacy.error || 'Web Agent Core 命令执行失败');
        error.code = legacy.code;
        error.details = legacy.details;
        throw error;
    }
    return legacy;
}

function applyRuntimeConfig(config, source = 'unknown') {
    if (!config || config.managedRuntime !== true || !config.managedToken) return null;

    // 用户在 Popup 中明确选择的模式优先；自动 staging 配置只能补全自动模式，
    // 不能在 MV3 service worker 重启后覆盖人工选择。
    if (runtimeIdentity.manualManagedSelection) return null;

    runtimeIdentity = {
        ...runtimeIdentity,
        clientKind: 'managed',
        managedRuntime: true,
        manualManagedSelection: false,
        managedToken: String(config.managedToken),
        managedTokenCreatedAt: Number(config.tokenCreatedAt) || 0,
        stageGeneration: config.stageGeneration || null,
        sourceManifestHash: config.sourceManifestHash || null,
        stagedManifestHash: config.stagedManifestHash || null,
        runtimeConfigGeneratedAt: config.generatedAt || null,
        maxTabs: Math.max(1, Number.parseInt(config.maxTabs, 10) || runtimeIdentity.maxTabs)
    };

    runtimeConnectionConfig = {
        serverUrl: config.serverUrl || defaultServerUrl,
        vcpKey: config.vcpKey || defaultVcpKey
    };

    connectionEnabled = true;
    chrome.storage.local.set({
        serverUrl: runtimeConnectionConfig.serverUrl,
        vcpKey: runtimeConnectionConfig.vcpKey,
        clientKind: 'managed',
        managedRuntime: true,
        manualManagedSelection: false,
        managedToken: runtimeIdentity.managedToken,
        managedTokenCreatedAt: runtimeIdentity.managedTokenCreatedAt,
        stageGeneration: runtimeIdentity.stageGeneration,
        sourceManifestHash: runtimeIdentity.sourceManifestHash,
        stagedManifestHash: runtimeIdentity.stagedManifestHash,
        runtimeConfigGeneratedAt: runtimeIdentity.runtimeConfigGeneratedAt,
        maxTabs: runtimeIdentity.maxTabs,
        connectionEnabled: true
    });

    if (runtimeIdentity.managedRuntime) {
        isMonitoringEnabled = true;
        chrome.storage.local.set({ isMonitoringEnabled: true });
    }

    console.log(`[VCP Background] ✅ 已加载 managed runtime 配置，source=${source}`);
    return config;
}

function getStorageRuntimeConfig() {
    return new Promise(resolve => {
        chrome.storage.local.get([
            'serverUrl', 'vcpKey', 'clientKind', 'managedRuntime', 'managedToken',
            'managedTokenCreatedAt', 'stageGeneration', 'sourceManifestHash',
            'stagedManifestHash', 'runtimeConfigGeneratedAt', 'maxTabs'
        ], (result) => {
            if (result && result.managedRuntime === true && result.managedToken) {
                resolve({
                    serverUrl: result.serverUrl,
                    vcpKey: result.vcpKey,
                    clientKind: result.clientKind,
                    managedRuntime: result.managedRuntime,
                    managedToken: result.managedToken,
                    tokenCreatedAt: result.managedTokenCreatedAt,
                    stageGeneration: result.stageGeneration,
                    sourceManifestHash: result.sourceManifestHash,
                    stagedManifestHash: result.stagedManifestHash,
                    generatedAt: result.runtimeConfigGeneratedAt,
                    maxTabs: result.maxTabs
                });
                return;
            }
            resolve(null);
        });
    });
}

async function loadManagedRuntimeConfig() {
    try {
        const response = await fetch(chrome.runtime.getURL('managed-runtime-config.json'), { cache: 'no-store' });
        if (response.ok) {
            const config = await response.json();
            const applied = applyRuntimeConfig(config, 'web_accessible_resource');
            if (applied) return applied;
        }
    } catch (error) {
        console.log('[VCP Background] managed-runtime-config.json 读取失败，尝试 storage fallback:', error.message);
    }

    const storedConfig = await getStorageRuntimeConfig();
    if (storedConfig) {
        return applyRuntimeConfig(storedConfig, 'chrome.storage.local');
    }

    console.log('[VCP Background] 未检测到 managed runtime 配置，按 user Chrome 运行');
    return null;
}

function sendClientHello() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const hello = {
        type: 'clientHello',
        data: {
            protocolVersion: runtimeIdentity.protocolVersion,
            clientKind: runtimeIdentity.clientKind,
            extensionVersion: chrome.runtime.getManifest()?.version || 'unknown',
            capabilities: runtimeIdentity.capabilities,
            snapshotBackends: runtimeIdentity.snapshotBackends,
            actionBackends: runtimeIdentity.actionBackends,
            featureSettings: {
                redactSensitiveDom
            },
            managedRuntime: runtimeIdentity.managedRuntime,
            manualManagedSelection: runtimeIdentity.manualManagedSelection,
            managedToken: runtimeIdentity.managedToken,
            managedTokenCreatedAt: runtimeIdentity.managedTokenCreatedAt,
            stageGeneration: runtimeIdentity.stageGeneration,
            sourceManifestHash: runtimeIdentity.sourceManifestHash,
            stagedManifestHash: runtimeIdentity.stagedManifestHash,
            runtimeConfigGeneratedAt: runtimeIdentity.runtimeConfigGeneratedAt,
            maxTabs: runtimeIdentity.maxTabs,
            userAgent: navigator.userAgent,
            platform: navigator.platform,
            timestamp: Date.now()
        }
    };

    ws.send(JSON.stringify(hello));
    console.log('[VCP Background] Sent clientHello:', hello.data);
}

function shouldAutoReconnect() {
    return runtimeIdentity.managedRuntime || runtimeIdentity.clientKind === 'agent';
}

function scheduleReconnect(delayMs = 2000) {
    if (!shouldAutoReconnect()) return;
    if (reconnectTimerId) return;
    reconnectTimerId = setTimeout(() => {
        reconnectTimerId = null;
        if (!isConnected && (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING)) {
            console.log('[VCP Background] 尝试重新连接 VCP WebSocket...');
            loadManagedRuntimeConfig().finally(() => connect());
        }
    }, delayMs);
}

function queryAllTabs() {
    return new Promise((resolve) => {
        chrome.tabs.query({}, (tabs) => resolve(Array.isArray(tabs) ? tabs : []));
    });
}

async function ensureTabBudgetForOpenUrl() {
    if (!runtimeIdentity.managedRuntime) return;
    const maxTabs = Math.max(1, Number.parseInt(runtimeIdentity.maxTabs, 10) || 8);
    const tabs = await queryAllTabs();
    if (tabs.length >= maxTabs) {
        throw new Error(`managed Chrome 标签页数量已达到上限 ${maxTabs}，已拒绝继续打开新标签页以保护服务器内存。`);
    }
}

function connect(options = {}) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.log('WebSocket is already connected.');
        return;
    }

    // 从 storage 获取连接参数。发布文件已经确立 managed 身份后，storage 中的旧
    // agent/user 字段不得反向覆盖本次启动代次的 Token 与身份。
    chrome.storage.local.get(['serverUrl', 'vcpKey', 'clientKind', 'managedRuntime', 'managedToken', 'maxTabs', 'connectionEnabled'], (result) => {
        if (result.connectionEnabled !== undefined) connectionEnabled = result.connectionEnabled === true;
        if (!runtimeIdentity.managedRuntime) {
            if (result.clientKind) runtimeIdentity.clientKind = result.clientKind;
            if (result.managedRuntime === true) runtimeIdentity.managedRuntime = true;
            if (result.managedToken) runtimeIdentity.managedToken = result.managedToken;
        }
        if (result.maxTabs) runtimeIdentity.maxTabs = Math.max(1, Number.parseInt(result.maxTabs, 10) || runtimeIdentity.maxTabs);

        if (!options.force && !connectionEnabled && !shouldAutoReconnect()) {
            console.log('[VCP Background] 用户模式连接已关闭，跳过自动连接。');
            broadcastStatusUpdate();
            return;
        }

        const serverUrlToUse = runtimeConnectionConfig.serverUrl || result.serverUrl || defaultServerUrl;
        const keyToUse = runtimeConnectionConfig.vcpKey || result.vcpKey || defaultVcpKey;
        
        const fullUrl = `${serverUrlToUse}/vcp-chrome-observer/VCP_Key=${keyToUse}`;
        console.log('Connecting to:', fullUrl);

        ws = new WebSocket(fullUrl);

        ws.onopen = () => {
            console.log('WebSocket connection established.');
            isConnected = true;
            if (reconnectTimerId) {
                clearTimeout(reconnectTimerId);
                reconnectTimerId = null;
            }
            sendClientHello();
            updateIcon();
            broadcastStatusUpdate(); // 广播最新状态
            // 启动心跳包
            heartbeatIntervalId = setInterval(() => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'heartbeat',
                        timestamp: Date.now(),
                        clientKind: runtimeIdentity.clientKind,
                        managedRuntime: runtimeIdentity.managedRuntime
                    }));
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
            } else if (message.type === 'urlfetch_cookie_sync_result') {
                const requestId = message.data?.requestId;
                const pending = pendingUrlFetchCookieSync.get(requestId);
                if (!pending) return;
                pendingUrlFetchCookieSync.delete(requestId);
                clearTimeout(pending.timeoutId);
                pending.sendResponse(message.data || {
                    requestId,
                    status: 'error',
                    error: '服务端返回了无效的 Cookie 同步响应'
                });
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
                    
                    ensureTabBudgetForOpenUrl().then(() => chrome.tabs.create({ url: fullUrl, active: true }, (tab) => {
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
                                        
                                        // 搜索页/SPA 页面在 load complete 后仍会异步渲染结果，等待内容稳定后再请求页面信息。
                                                                                setTimeout(() => {
                                                                                    chrome.tabs.sendMessage(tab.id, {
                                                                                        type: 'REQUEST_PAGE_INFO_UPDATE',
                                                                                        force: true
                                                                                    }).catch(e => {
                                                                                        console.log('[VCP Background] ⚠️ 请求新标签页信息失败:', e.message);
                                                                                    });
                                                                                }, 2500);
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
                    })).catch(error => {
                        const errorMessage = error.message || String(error);
                        console.error('[VCP Background] open_url 被拒绝:', errorMessage);
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
            rejectPendingUrlFetchCookieSync('VCP WebSocket 已断开');
            updateIcon();
            broadcastStatusUpdate(); // 广播最新状态
            if (heartbeatIntervalId) {
                clearInterval(heartbeatIntervalId);
                heartbeatIntervalId = null;
            }
            if (shouldAutoReconnect()) {
                scheduleReconnect();
            }
        };

        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            isConnected = false;
            ws = null;
            rejectPendingUrlFetchCookieSync('VCP WebSocket 发生错误');
            updateIcon();
            broadcastStatusUpdate(); // 广播最新状态
            if (heartbeatIntervalId) {
                clearInterval(heartbeatIntervalId);
                heartbeatIntervalId = null;
            }
        };
    });
}

function disconnect(options = {}) {
    if (options.manual === true) {
        connectionEnabled = false;
        chrome.storage.local.set({ connectionEnabled: false });
        if (reconnectTimerId) {
            clearTimeout(reconnectTimerId);
            reconnectTimerId = null;
        }
    }
    if (ws) {
        ws.close();
    } else {
        isConnected = false;
        broadcastStatusUpdate();
    }
}

function updateIcon() {
    const iconPath = isConnected ? 'icons/icon48.png' : 'icons/icon_disconnected.png'; // 你需要创建一个断开连接的图标
    // 为了简单起见，我们先只改变徽章
    chrome.action.setBadgeText({ text: isConnected ? 'On' : 'Off' });
    chrome.action.setBadgeBackgroundColor({ color: isConnected ? '#00C853' : '#FF5252' });
}

async function applyClientMode(mode) {
    const normalizedMode = String(mode || '').trim().toLowerCase();

    if (normalizedMode === 'managed') {
        // 人工 Managed 是用户在扩展 UI 中的明确授权，不依赖 Chromium
        // 是否允许读取动态 staging 文件或接受 Profile storage 预注入。
        runtimeIdentity = {
            ...runtimeIdentity,
            clientKind: 'managed',
            managedRuntime: true,
            manualManagedSelection: true,
            managedToken: null,
            managedTokenCreatedAt: 0
        };
        connectionEnabled = true;
        isMonitoringEnabled = true;
        await chrome.storage.local.set({
            clientKind: 'managed',
            agentMode: false,
            managedRuntime: true,
            manualManagedSelection: true,
            managedToken: null,
            managedTokenCreatedAt: 0,
            isMonitoringEnabled: true,
            connectionEnabled: true
        });
    } else {
        const clientKind = normalizedMode === 'agent' ? 'agent' : 'user';
        runtimeIdentity = {
            ...runtimeIdentity,
            clientKind,
            managedRuntime: false,
            manualManagedSelection: false,
            managedToken: null,
            managedTokenCreatedAt: 0
        };
        connectionEnabled = clientKind === 'agent' ? true : connectionEnabled;
        await chrome.storage.local.set({
            clientKind,
            agentMode: clientKind === 'agent',
            managedRuntime: false,
            manualManagedSelection: false,
            managedToken: null,
            managedTokenCreatedAt: 0,
            connectionEnabled
        });
    }

    if (reconnectTimerId && !shouldAutoReconnect()) {
        clearTimeout(reconnectTimerId);
        reconnectTimerId = null;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        sendClientHello();
    } else if (shouldAutoReconnect()) {
        connect();
    }
    broadcastMonitoringStatusToTabs();
    broadcastStatusUpdate();
    return {
        success: true,
        clientKind: runtimeIdentity.clientKind,
        managedRuntime: runtimeIdentity.managedRuntime,
        agentMode: runtimeIdentity.clientKind === 'agent',
        isConnected
    };
}

// 监听来自popup和content_script的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'GET_STATUS') {
        sendResponse({
            isConnected: isConnected,
            isMonitoringEnabled: isMonitoringEnabled,
            protocolVersion: runtimeIdentity.protocolVersion,
            redactSensitiveDom,
            clientKind: runtimeIdentity.clientKind,
            agentMode: runtimeIdentity.clientKind === 'agent',
            managedRuntime: runtimeIdentity.managedRuntime,
            managedTokenPresent: !!runtimeIdentity.managedToken,
            connectionEnabled,
            serverUrl: runtimeConnectionConfig.serverUrl || defaultServerUrl,
            vcpKeyPresent: !!(runtimeConnectionConfig.vcpKey || defaultVcpKey)
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
                isMonitoringEnabled: true,
                force: true
            }).catch(e => {
                if (!e.message.includes("Could not establish connection")) {
                    console.log("Error requesting page info:", e.message);
                }
            });
        }
        
        sendResponse({ isMonitoringEnabled: isMonitoringEnabled });
        return true;
    } else if (request.type === 'SET_CLIENT_MODE') {
        applyClientMode(request.mode)
            .then(sendResponse)
            .catch(error => sendResponse({
                success: false,
                error: error.message || String(error),
                clientKind: runtimeIdentity.clientKind,
                managedRuntime: runtimeIdentity.managedRuntime,
                isConnected
            }));
        return true;
    } else if (request.type === 'PRIVACY_SETTINGS_CHANGED') {
        redactSensitiveDom = request.redactSensitiveDom !== false;
        chrome.storage.local.set({ redactSensitiveDom });
        broadcastPrivacySettingsToTabs();
        if (ws && ws.readyState === WebSocket.OPEN) {
            sendClientHello();
        }
        sendResponse({ redactSensitiveDom });
        return true;
    } else if (request.type === 'TOGGLE_CONNECTION') {
        if (isConnected) {
            disconnect({ manual: true });
        } else {
            connectionEnabled = true;
            chrome.storage.local.set({ connectionEnabled: true });
            connect({ force: true });
        }
        // 不再立即返回状态，而是等待广播
        // sendResponse({ isConnected: !isConnected });
    } else if (request.type === 'SYNC_URLFETCH_COOKIES') {
        requestUrlFetchCookieSync(sendResponse);
        return true;
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
        
        const groundedMarkdown = request.data.agentView?.markdown ||
            request.data.pageContentMarkdown ||
            request.data.markdown ||
            '';
        if (senderTabId !== null && senderTabId !== undefined) {
            chromeWebAgentAdapter.updateDocumentState(senderTabId, {
                documentGeneration: request.data.documentGeneration,
                snapshotId: request.data.snapshotId,
                pageRuntimeInstanceId: request.data.runtimeInstanceId || null
            });
        }

        const outboundPageInfo = {
            protocolVersion: request.data.protocolVersion || runtimeIdentity.protocolVersion,
            webAgentProtocolVersion: request.data.webAgentProtocolVersion || 1,
            runtimeInstanceId: request.data.runtimeInstanceId || chromeWebAgentAdapter.runtimeInstanceId,
            documentGeneration: request.data.documentGeneration,
            markdown: groundedMarkdown,
            pageContentMarkdown: request.data.pageContentMarkdown || groundedMarkdown,
            interactionTree: request.data.interactionTree || '',
            scrollContext: request.data.scrollContext || null,
            snapshotDiff: request.data.snapshotDiff || null,
            pageGraph: request.data.pageGraph || null,
            images: Array.isArray(request.data.images) ? request.data.images : [],
            imageCount: Number(request.data.imageCount) || (Array.isArray(request.data.images) ? request.data.images.length : 0),
            agentView: request.data.agentView || {
                format: 'grounded-markdown-v1',
                mode: 'auto',
                markdown: groundedMarkdown
            },
            snapshotId: request.data.snapshotId,
            generatedAt: request.data.generatedAt,
            url: request.data.url,
            title: request.data.title,
            elementCount: request.data.elementCount,
            elements: request.data.elements,
            contentHash: request.data.contentHash,
            structureHash: request.data.structureHash,
            snapshotBackend: request.data.snapshotBackend || 'content-script',
            redaction: request.data.redaction,
            performance: request.data.performance,
            force: isForcedUpdate,
            error: request.data.error
        };

        // 服务端未连接时仍更新 Popup/内存观测状态；WebSocket 只负责额外转发。
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'pageInfoUpdate',
                data: outboundPageInfo
            }));
        }

        const lines = groundedMarkdown.split('\n');
        const parsedTitle = (lines[0] || '').replace(/^#\s*/, '').trim();
        const urlLine = lines.find(line => /^URL:\s*/i.test(line));
        const parsedUrl = urlLine ? urlLine.replace(/^URL:\s*/i, '').trim() : '';
        const pageInfoSummary = {
            title: request.data.title || parsedTitle || '未知页面',
            url: request.data.url || parsedUrl || '未知URL',
            snapshotId: request.data.snapshotId,
            elementCount: request.data.elementCount,
            generatedAt: request.data.generatedAt,
            agentViewFormat: outboundPageInfo.agentView.format,
            groundedMarkdownLength: groundedMarkdown.length,
            timestamp: Date.now()
        };
        latestPageInfo = {
            ...pageInfoSummary,
            markdown: groundedMarkdown,
            pageContentMarkdown: outboundPageInfo.pageContentMarkdown,
            interactionTree: outboundPageInfo.interactionTree,
            scrollContext: outboundPageInfo.scrollContext,
            snapshotDiff: outboundPageInfo.snapshotDiff,
            images: outboundPageInfo.images,
            imageCount: outboundPageInfo.imageCount,
            agentView: outboundPageInfo.agentView
        };
        console.log('[VCP Background] 📄 已缓存 Grounded 页面信息:', pageInfoSummary);

        chrome.storage.local.set({ lastPageInfo: pageInfoSummary }, () => {
            console.log('[VCP Background] 💾 已存储页面摘要到 storage');
        });

        chrome.runtime.sendMessage({
            type: 'PAGE_INFO_BROADCAST',
            data: pageInfoSummary
        }).catch(error => {
            if (!error.message.includes("Could not establish connection")) {
                console.error("[VCP Background] ❌ 广播失败:", error);
            }
        });
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
                        files: [
                            'webcore/web-agent-protocol.js',
                            'webcore/web-agent-page-core.js',
                            'webcore/web-agent-page-runtime-core.js',
                            'content_script.js'
                        ]
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

function waitForTabLoadComplete(tabId, timeoutMs = 10000) {
    return new Promise((resolve) => {
        let settled = false;
        const cleanup = () => {
            chrome.tabs.onUpdated.removeListener(listener);
        };
        const finish = (reason, tab = null) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({ reason, tab });
        };
        const listener = (updatedTabId, changeInfo, tab) => {
            if (updatedTabId !== tabId) return;
            if (changeInfo.status === 'complete') {
                finish('complete', tab);
            }
        };

        chrome.tabs.onUpdated.addListener(listener);

        chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError) return;
            if (tab && tab.status === 'complete') {
                // 当前可能还没来得及进入 loading，给浏览器一个短窗口捕获随后发生的导航。
                setTimeout(() => {
                    if (!settled) finish('already_complete', tab);
                }, 600);
            }
        });

        setTimeout(() => finish('timeout'), timeoutMs);
    });
}

function requestPageInfoWithRetry(tabId, retryCount = 0) {
    chrome.tabs.sendMessage(tabId, {
        type: 'REQUEST_PAGE_INFO_UPDATE',
        force: true
    }, () => {
        if (chrome.runtime.lastError) {
            if (retryCount < 5) {
                setTimeout(() => requestPageInfoWithRetry(tabId, retryCount + 1), 300 * (retryCount + 1));
            } else if (!chrome.runtime.lastError.message.includes("Could not establish connection")) {
                console.log('[VCP Background] ❌ 导航后请求页面信息最终失败:', chrome.runtime.lastError.message);
            }
        } else {
            console.log(`[VCP Background] ✅ 导航后页面信息请求已发送 [ID:${tabId}]`);
        }
    });
}

function isExpectedNavigationChannelClose(error) {
    const message = String(error?.message || error || '');
    return /back\/forward cache|message channel is closed|Extension context invalidated|Receiving end does not exist|Could not establish connection/i.test(message);
}

function shouldTreatChannelCloseAsNavigation(commandData, error) {
    const navigationProneCommands = new Set(['click', 'check']);
    return navigationProneCommands.has(commandData?.command) && isExpectedNavigationChannelClose(error);
}

function isSafeContentScriptRetryCommand(command) {
    return new Set([
        'wait_for',
        'get_page_info',
        'get_page_image',
        'page_get_image',
        'query_html',
        'query_js',
        'page_code_search'
    ]).has(String(command || ''));
}

function sendCommandToContentScript(tabId, commandData) {
    return chrome.tabs.sendMessage(tabId, {
        type: 'EXECUTE_COMMAND',
        data: commandData
    });
}

async function sendSafeCommandAfterNavigation(tabId, commandData, initialError) {
    if (!isSafeContentScriptRetryCommand(commandData?.command) || !isExpectedNavigationChannelClose(initialError)) {
        throw initialError;
    }

    const loadResult = await waitForTabLoadComplete(
        tabId,
        Math.min(Math.max(Number(commandData.timeoutMs) || 10000, 3000), 15000)
    );

    let lastError = initialError;
    for (let attempt = 1; attempt <= 8; attempt++) {
        try {
            const response = await sendCommandToContentScript(tabId, commandData);
            console.log(`[VCP Background] ✅ 导航后只读命令重试成功: ${commandData.command}, attempt=${attempt}`);
            return {
                response,
                retry: {
                    applied: true,
                    attempts: attempt,
                    loadReason: loadResult.reason,
                    initialError: String(initialError?.message || initialError)
                }
            };
        } catch (error) {
            lastError = error;
            if (!isExpectedNavigationChannelClose(error)) throw error;
            await new Promise(resolve => setTimeout(resolve, Math.min(250 * attempt, 1000)));
        }
    }

    const error = new Error(`导航已发生，但新页面 content script 在安全重试窗口内仍未就绪: ${lastError?.message || lastError}`);
    error.code = 'CONTENT_SCRIPT_NOT_READY_AFTER_NAVIGATION';
    error.details = {
        command: commandData.command,
        tabId,
        loadReason: loadResult.reason,
        attempts: 8,
        initialError: String(initialError?.message || initialError),
        lastError: String(lastError?.message || lastError)
    };
    throw error;
}

async function resolveActionTargetInPage(tabId, target) {
    if (!target) {
        return {
            found: true,
            target: null,
            rect: null,
            point: null,
            tagName: null,
            type: null,
            value: null,
            checked: null
        };
    }
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        func: (targetValue) => {
            const escapeValue = value => {
                if (globalThis.CSS?.escape) return CSS.escape(String(value));
                return String(value).replace(/["\\]/g, '\\$&');
            };
            const targetText = String(targetValue || '').trim();
            let element = document.querySelector(`[data-vcp-kind-id="${escapeValue(targetText)}"],[data-vcp-handle="${escapeValue(targetText)}"],[data-vcp-snapshot-handle="${escapeValue(targetText)}"],[vcp-id="${escapeValue(targetText)}"]`);
            if (!element) {
                try {
                    if (targetText.startsWith('#') || targetText.startsWith('.') || targetText.includes('[')) {
                        element = document.querySelector(targetText);
                    }
                } catch {}
            }
            if (!element) element = document.getElementById(targetText);
            if (!element) element = document.querySelector(`[name="${escapeValue(targetText)}"],[aria-label="${escapeValue(targetText)}"],[placeholder="${escapeValue(targetText)}"]`);
            if (!element) return { found: false, target: targetText };

            element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            const viewportWidth = innerWidth || document.documentElement.clientWidth;
            const viewportHeight = innerHeight || document.documentElement.clientHeight;
            const visibleLeft = Math.max(0, rect.left);
            const visibleTop = Math.max(0, rect.top);
            const visibleRight = Math.min(viewportWidth, rect.right);
            const visibleBottom = Math.min(viewportHeight, rect.bottom);
            const visibleWidth = Math.max(0, visibleRight - visibleLeft);
            const visibleHeight = Math.max(0, visibleBottom - visibleTop);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) <= 0 || visibleWidth <= 0 || visibleHeight <= 0) {
                return { found: true, interactable: false, code: 'ELEMENT_OUTSIDE_VIEWPORT', rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
            }
            if (element.disabled || element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('inert')) {
                return { found: true, interactable: false, code: 'ELEMENT_NOT_INTERACTABLE' };
            }

            const points = [
                [visibleLeft + visibleWidth / 2, visibleTop + visibleHeight / 2],
                [visibleLeft + Math.min(6, visibleWidth * 0.2), visibleTop + Math.min(6, visibleHeight * 0.2)],
                [visibleRight - Math.min(6, visibleWidth * 0.2), visibleTop + Math.min(6, visibleHeight * 0.2)],
                [visibleLeft + Math.min(6, visibleWidth * 0.2), visibleBottom - Math.min(6, visibleHeight * 0.2)],
                [visibleRight - Math.min(6, visibleWidth * 0.2), visibleBottom - Math.min(6, visibleHeight * 0.2)]
            ];
            let point = null;
            let hitCount = 0;
            let occluder = null;
            for (const [x, y] of points) {
                const hit = document.elementFromPoint(x, y);
                const related = hit === element || element.contains(hit) || hit?.contains?.(element) ||
                    (hit?.tagName === 'LABEL' && hit.htmlFor === element.id);
                if (related) {
                    hitCount++;
                    if (!point) point = { x: Math.round(x), y: Math.round(y) };
                } else if (!occluder && hit) {
                    occluder = {
                        tag: hit.tagName?.toLowerCase(),
                        role: hit.getAttribute?.('role'),
                        label: hit.getAttribute?.('aria-label') || hit.textContent?.trim().slice(0, 80)
                    };
                }
            }
            return {
                found: true,
                interactable: hitCount > 0,
                code: hitCount > 0 ? null : 'ELEMENT_OCCLUDED',
                target: targetText,
                point,
                hitCount,
                sampleCount: points.length,
                hitRatio: hitCount / points.length,
                occluder,
                tagName: element.tagName.toLowerCase(),
                type: element.getAttribute('type') || '',
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                value: element.type === 'password' ? undefined : (element.value ?? element.textContent ?? ''),
                valueLength: String(element.value ?? element.textContent ?? '').length,
                checked: typeof element.checked === 'boolean' ? element.checked : element.getAttribute('aria-checked'),
                selectedIndex: typeof element.selectedIndex === 'number' ? element.selectedIndex : null
            };
        },
        args: [target]
    });
    return results?.[0]?.result || { found: false, target };
}

async function focusActionTarget(tabId, target) {
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        func: (targetValue) => {
            const escaped = globalThis.CSS?.escape ? CSS.escape(String(targetValue)) : String(targetValue).replace(/["\\]/g, '\\$&');
            const element = document.querySelector(`[data-vcp-kind-id="${escaped}"],[data-vcp-handle="${escaped}"],[data-vcp-snapshot-handle="${escaped}"],[vcp-id="${escaped}"]`) ||
                document.getElementById(String(targetValue));
            if (!element) return false;
            element.focus({ preventScroll: true });
            return document.activeElement === element;
        },
        args: [target]
    });
    return results?.[0]?.result === true;
}

function normalizeCdpKeys(keys) {
    if (Array.isArray(keys)) return keys.map(String);
    return String(keys || '').split(/\s*\+\s*|\s*,\s*/).filter(Boolean);
}

function getCdpKeyDescriptor(rawKey) {
    const aliases = {
        esc: 'Escape',
        return: 'Enter',
        space: ' ',
        arrowup: 'ArrowUp',
        arrowdown: 'ArrowDown',
        arrowleft: 'ArrowLeft',
        arrowright: 'ArrowRight',
        pageup: 'PageUp',
        pagedown: 'PageDown'
    };
    const key = aliases[String(rawKey || '').toLowerCase()] || String(rawKey || '');
    const specialKeys = {
        Enter: { code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' },
        Tab: { code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, text: '\t' },
        Escape: { code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
        Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
        Delete: { code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 },
        ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
        ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
        ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
        ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
        PageUp: { code: 'PageUp', windowsVirtualKeyCode: 33, nativeVirtualKeyCode: 33 },
        PageDown: { code: 'PageDown', windowsVirtualKeyCode: 34, nativeVirtualKeyCode: 34 },
        Home: { code: 'Home', windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36 },
        End: { code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 },
        ' ': { code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, text: ' ' }
    };
    if (specialKeys[key]) return { key, location: 0, ...specialKeys[key] };

    const character = key.slice(0, 1);
    const upper = character.toUpperCase();
    return {
        key: character,
        code: /^[a-z]$/i.test(character) ? `Key${upper}` : (/^\d$/.test(character) ? `Digit${character}` : character),
        windowsVirtualKeyCode: upper.charCodeAt(0) || 0,
        nativeVirtualKeyCode: upper.charCodeAt(0) || 0,
        location: 0,
        text: character
    };
}

async function dispatchCdpKeySequence(tabId, keys) {
    const tokens = normalizeCdpKeys(keys);
    if (!tokens.length) throw new Error('send_keys 缺少 keys 参数');
    const modifiersMap = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
    let modifiers = 0;
    const actionKeys = [];
    for (const token of tokens) {
        const lower = token.toLowerCase();
        if (modifiersMap[lower]) modifiers |= modifiersMap[lower];
        else actionKeys.push(token);
    }

    const descriptors = [];
    for (const rawKey of actionKeys) {
        const descriptor = getCdpKeyDescriptor(rawKey);
        descriptors.push(descriptor);
        const common = {
            key: descriptor.key,
            code: descriptor.code,
            modifiers,
            location: descriptor.location,
            windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
            nativeVirtualKeyCode: descriptor.nativeVirtualKeyCode
        };
        await sendCdpCommand(tabId, 'Input.dispatchKeyEvent', {
            type: descriptor.text && modifiers === 0 ? 'keyDown' : 'rawKeyDown',
            ...common
        });
        if (descriptor.text && modifiers === 0) {
            await sendCdpCommand(tabId, 'Input.dispatchKeyEvent', {
                type: 'char',
                ...common,
                text: descriptor.text,
                unmodifiedText: descriptor.text
            });
        }
        await sendCdpCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...common });
    }
    return { keys: actionKeys, modifiers, descriptors };
}

function summarizeTabState(tabs) {
    return (Array.isArray(tabs) ? tabs : []).map(tab => ({
        id: tab.id,
        url: tab.url || '',
        title: tab.title || '',
        active: tab.active === true
    }));
}

function detectKeyboardPageTransition(beforeTabs, afterTabs, sourceTabId) {
    const beforeById = new Map(beforeTabs.map(tab => [tab.id, tab]));
    const afterSource = afterTabs.find(tab => tab.id === sourceTabId) || null;
    const beforeSource = beforeById.get(sourceTabId) || null;
    const createdTabs = afterTabs.filter(tab => !beforeById.has(tab.id));
    const sourceNavigated = !!beforeSource && !!afterSource && beforeSource.url !== afterSource.url;
    return {
        observed: sourceNavigated || createdTabs.length > 0,
        sourceNavigated,
        createdTabs,
        beforeSource,
        afterSource,
        tabCountBefore: beforeTabs.length,
        tabCountAfter: afterTabs.length
    };
}

async function waitForKeyboardPageTransition(beforeTabs, sourceTabId, timeoutMs = 3000) {
    const startedAt = Date.now();
    let transition = detectKeyboardPageTransition(
        beforeTabs,
        summarizeTabState(await queryAllTabs()),
        sourceTabId
    );

    while (!transition.observed && Date.now() - startedAt < timeoutMs) {
        await new Promise(resolve => setTimeout(resolve, 150));
        transition = detectKeyboardPageTransition(
            beforeTabs,
            summarizeTabState(await queryAllTabs()),
            sourceTabId
        );
    }

    return {
        ...transition,
        observationMs: Date.now() - startedAt,
        observationTimedOut: !transition.observed
    };
}

async function executeCdpAction(commandData, tabId) {
    await ensureDebuggerAttached(tabId);
    const command = commandData.command;
    const tabsBefore = command === 'send_keys' ? summarizeTabState(await queryAllTabs()) : null;
    const targetState = await resolveActionTargetInPage(tabId, commandData.target);
    if (commandData.target && !targetState.found) {
        const error = new Error(`CDP Input 无法解析目标: ${commandData.target}`);
        error.code = 'ELEMENT_HANDLE_EXPIRED';
        throw error;
    }
    if (commandData.target && !targetState.interactable) {
        const error = new Error(targetState.code === 'ELEMENT_OCCLUDED' ? '目标元素被遮挡' : '目标元素不可交互');
        error.code = targetState.code || 'ELEMENT_NOT_INTERACTABLE';
        error.details = targetState;
        throw error;
    }

    if (command === 'click') {
        const { x, y } = targetState.point;
        await sendCdpCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await sendCdpCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await sendCdpCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    } else if (command === 'hover') {
        const { x, y } = targetState.point;
        await sendCdpCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    } else if (command === 'type' || command === 'set_value') {
        await focusActionTarget(tabId, commandData.target);
        await dispatchCdpKeySequence(tabId, ['Ctrl', 'a']);
        await dispatchCdpKeySequence(tabId, ['Backspace']);
        await sendCdpCommand(tabId, 'Input.insertText', { text: String(commandData.value ?? commandData.text ?? '') });
    } else if (command === 'send_keys') {
        if (commandData.target) await focusActionTarget(tabId, commandData.target);
        await dispatchCdpKeySequence(tabId, commandData.keys || commandData.text);
    } else if (command === 'scroll') {
        const x = targetState.point?.x ??  Math.round((commandData.x ?? 0) || 0);
        const y = targetState.point?.y ?? Math.round((commandData.y ?? 0) || 0);
        const amount = parseNumberParam(commandData.amount, 600, 1, 100000);
        const direction = String(commandData.direction || 'down').toLowerCase();
        const deltaY = ['up', 'page_up'].includes(direction) ? -amount : (['down', 'page_down'].includes(direction) ? amount : 0);
        const deltaX = ['left', 'page_left'].includes(direction) ? -amount : (['right', 'page_right'].includes(direction) ? amount : 0);
        await sendCdpCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
    } else {
        throw new Error(`CDP Input 不支持动作: ${command}`);
    }

    const dispatchedKeys = command === 'send_keys'
        ? normalizeCdpKeys(commandData.keys || commandData.text).map(key => String(key).toLowerCase())
        : [];
    const enterOnInput = command === 'send_keys' &&
        dispatchedKeys.some(key => key === 'enter' || key === 'return') &&
        !!commandData.target &&
        ['input', 'textarea'].includes(targetState?.tagName);
    await new Promise(resolve => setTimeout(resolve, 120));

    let afterState = null;
    try {
        afterState = commandData.target ? await resolveActionTargetInPage(tabId, commandData.target) : null;
    } catch (error) {
        // 导航后旧文档句柄不可解析本身属于页面迁移证据，后续由标签状态确权。
        afterState = { unavailableAfterDispatch: true, reason: error.message };
    }

    const expectedValue = String(commandData.value ?? commandData.text ?? '');
    let verified = (command === 'type' || command === 'set_value')
        ? (afterState?.type === 'password' ? afterState?.valueLength === expectedValue.length : String(afterState?.value ?? '') === expectedValue)
        : null;
    let verificationType = verified === null ? 'cdp-dispatch-observed' : 'value-readback';
    let keyboardTransition = null;

    if (enterOnInput) {
        keyboardTransition = await waitForKeyboardPageTransition(tabsBefore || [], tabId, 3000);
        // 未在有限观察窗中看到导航不能证明 Enter 无效；站点可能延迟创建标签
        // 或先执行异步校验。此时标记“尚未确认”，不得把已生效动作包装成错误。
        verified = keyboardTransition.observed ? true : null;
        verificationType = keyboardTransition.observed
            ? 'enter-submit-page-transition'
            : 'enter-dispatched-transition-unconfirmed';
    }

    return {
        message: enterOnInput && verified === null
            ? 'Enter 已通过 CDP Input 发送；观察窗内尚未确认页面迁移，后续应通过 URL、标签页或页面快照确权'
            : `动作已通过 CDP Input 执行: ${command}`,
        code: verified === false
            ? 'ACTION_VERIFICATION_FAILED'
            : (verified === true
                ? 'ACTION_VERIFIED'
                : (enterOnInput ? 'ACTION_DISPATCHED_UNCONFIRMED' : 'ACTION_DISPATCHED')),
        result: {
            attempted: true,
            verified,
            verificationType,
            beforeState: targetState,
            afterState,
            keyboardTransition,
            targetResolution: targetState,
            backendUsed: 'cdp-input',
            fallbackUsed: false,
            requiresFreshSnapshot: true
        }
    };
}

async function blobToDataUrl(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const chunkSize = 0x8000;
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

async function captureResolvedPageImage(tab, resolved, commandData = {}) {
    const rect = resolved?.viewportRect;
    if (!rect || rect.width <= 0 || rect.height <= 0) {
        const error = new Error('页面图片没有有效的视口矩形');
        error.code = 'IMAGE_INVALID_RECT';
        throw error;
    }

    const requestedFormat = String(commandData.format || commandData.imageFormat || 'jpeg').toLowerCase();
    const format = requestedFormat === 'png' ? 'png' : 'jpeg';
    const quality = parseNumberParam(commandData.quality, 85, 1, 100);
    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(
        tab.windowId,
        format === 'jpeg' ? { format: 'jpeg', quality } : { format: 'png' }
    );
    if (!screenshotDataUrl) {
        const error = new Error('Chrome 未返回页面截图');
        error.code = 'PAGE_IMAGE_CAPTURE_FAILED';
        throw error;
    }

    const sourceBlob = await (await fetch(screenshotDataUrl)).blob();
    const bitmap = await createImageBitmap(sourceBlob);
    const dpr = Math.max(0.1, Number(resolved.devicePixelRatio) || 1);
    const sourceX = Math.max(0, Math.round(rect.x * dpr));
    const sourceY = Math.max(0, Math.round(rect.y * dpr));
    const sourceWidth = Math.min(bitmap.width - sourceX, Math.max(1, Math.round(rect.width * dpr)));
    const sourceHeight = Math.min(bitmap.height - sourceY, Math.max(1, Math.round(rect.height * dpr)));

    if (sourceWidth <= 0 || sourceHeight <= 0) {
        bitmap.close();
        const error = new Error('图片区域超出当前可视截图范围');
        error.code = 'IMAGE_OUTSIDE_CAPTURE';
        throw error;
    }

    const maxWidth = parseNumberParam(commandData.maxWidth, 1600, 64, 4096);
    const resizeScale = Math.min(1, maxWidth / sourceWidth);
    const outputWidth = Math.max(1, Math.round(sourceWidth * resizeScale));
    const outputHeight = Math.max(1, Math.round(sourceHeight * resizeScale));
    const canvas = new OffscreenCanvas(outputWidth, outputHeight);
    const context = canvas.getContext('2d', { alpha: format === 'png' });
    context.drawImage(
        bitmap,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        0,
        0,
        outputWidth,
        outputHeight
    );
    bitmap.close();

    const outputBlob = await canvas.convertToBlob({
        type: `image/${format}`,
        quality: format === 'jpeg' ? quality / 100 : undefined
    });
    const dataUrl = await blobToDataUrl(outputBlob);
    return {
        dataUrl,
        mimeType: outputBlob.type || `image/${format}`,
        format,
        byteLength: outputBlob.size,
        width: outputWidth,
        height: outputHeight,
        sourceWidth,
        sourceHeight,
        capturedAt: new Date().toISOString()
    };
}

function prunePageImageCache() {
    const now = Date.now();
    for (const [key, entry] of pageImageCache) {
        if (now - entry.cachedAt > PAGE_IMAGE_CACHE_TTL_MS) {
            pageImageCache.delete(key);
        }
    }
    while (pageImageCache.size > PAGE_IMAGE_CACHE_MAX_ENTRIES) {
        const oldestKey = pageImageCache.keys().next().value;
        if (oldestKey === undefined) break;
        pageImageCache.delete(oldestKey);
    }
}

function getCachedPageImage(cacheKey) {
    prunePageImageCache();
    const entry = pageImageCache.get(cacheKey);
    if (!entry) return null;
    pageImageCache.delete(cacheKey);
    pageImageCache.set(cacheKey, entry);
    return {
        ...entry.value,
        cache: {
            hit: true,
            cachedAt: new Date(entry.cachedAt).toISOString(),
            ttlMs: PAGE_IMAGE_CACHE_TTL_MS
        }
    };
}

function cachePageImage(cacheKey, value) {
    pageImageCache.delete(cacheKey);
    pageImageCache.set(cacheKey, {
        cachedAt: Date.now(),
        value
    });
    prunePageImageCache();
}

async function executePageImageCommand(commandData = {}) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.id) {
        const error = new Error('没有活动的标签页');
        error.code = 'NO_ACTIVE_TAB';
        throw error;
    }

    const resolvedResponse = await chrome.tabs.sendMessage(tab.id, {
        type: 'EXECUTE_CORE_COMMAND',
        data: {
            command: 'page_get_image',
            imageId: commandData.imageId || commandData.target,
            runtimeInstanceId: commandData.runtimeInstanceId,
            documentGeneration: commandData.documentGeneration,
            snapshotId: commandData.snapshotId,
            strict: commandData.strict === true
        }
    });
    if (!resolvedResponse || resolvedResponse.status === 'error') {
        const error = new Error(resolvedResponse?.error || '页面图片解析失败');
        error.code = resolvedResponse?.code || 'PAGE_IMAGE_RESOLVE_FAILED';
        error.details = resolvedResponse?.details || null;
        throw error;
    }

    const resolved = resolvedResponse.result;
    const strictImageId = resolved.strictImageId || resolved.resolvedImageId;
    const format = String(commandData.format || commandData.imageFormat || 'jpeg').toLowerCase() === 'png'
        ? 'png'
        : 'jpeg';
    const quality = parseNumberParam(commandData.quality, 85, 1, 100);
    const maxWidth = parseNumberParam(commandData.maxWidth, 1600, 64, 4096);
    const cacheKey = [
        tab.id,
        resolved.runtimeInstanceId,
        resolved.documentGeneration,
        strictImageId,
        format,
        quality,
        maxWidth
    ].join('|');
    const cached = getCachedPageImage(cacheKey);
    if (cached) {
        return {
            status: 'success',
            code: 'PAGE_IMAGE_CACHE_HIT',
            message: `已从缓存获取页面图片 ${resolved.imageId || commandData.imageId || commandData.target}`,
            result: cached
        };
    }

    const captured = await captureResolvedPageImage(tab, resolved, {
        ...commandData,
        format,
        quality,
        maxWidth
    });
    const result = {
        ...captured,
        imageId: resolved.imageId,
        strictImageId,
        kind: resolved.kind,
        alt: resolved.alt,
        caption: resolved.caption,
        headingPath: resolved.headingPath,
        contentBlockId: resolved.contentBlockId,
        runtimeInstanceId: resolved.runtimeInstanceId,
        documentGeneration: resolved.documentGeneration,
        snapshotId: resolved.snapshotId,
        sourceMode: 'rendered',
        cache: {
            hit: false,
            ttlMs: PAGE_IMAGE_CACHE_TTL_MS
        }
    };
    cachePageImage(cacheKey, result);
    return {
        status: 'success',
        code: 'PAGE_IMAGE_CAPTURED',
        message: `已获取页面图片 ${resolved.imageId || commandData.imageId || commandData.target}`,
        result
    };
}

async function handleIncomingCommand(commandData) {
    const { command, requestId, sourceClientId } = commandData;

    if (command === 'get_page_image' || command === 'page_get_image') {
        try {
            const result = await executePageImageCommand(commandData);
            sendResponseToWs({
                type: 'command_result',
                data: { requestId, sourceClientId, ...result }
            });
        } catch (error) {
            sendResponseToWs({
                type: 'command_result',
                data: {
                    requestId,
                    sourceClientId,
                    status: 'error',
                    code: error.code || 'PAGE_IMAGE_CAPTURE_FAILED',
                    error: error.message,
                    details: error.details || null
                }
            });
        }
        return;
    }

    const cdpInputCommands = new Set(['click', 'type', 'set_value', 'send_keys', 'hover', 'scroll']);
    const wantsCdpInput = cdpInputCommands.has(command) &&
        (commandData.actionBackend === 'cdp-input' || commandData.actionBackend === 'auto') &&
        (runtimeIdentity.managedRuntime || runtimeIdentity.clientKind === 'agent');

    if (wantsCdpInput) {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs[0]?.id;
        if (!tabId) {
            sendResponseToWs({
                type: 'command_result',
                data: { requestId, sourceClientId, status: 'error', code: 'NO_ACTIVE_TAB', error: '没有活动的标签页' }
            });
            return;
        }
        try {
            const cdpResult = await executeCdpAction(commandData, tabId);
            sendResponseToWs({
                type: 'command_result',
                data: {
                    requestId,
                    sourceClientId,
                    status: cdpResult.code === 'ACTION_VERIFICATION_FAILED' ? 'error' : 'success',
                    ...cdpResult
                }
            });
            setTimeout(() => requestPageInfoWithRetry(tabId), 350);
            return;
        } catch (cdpError) {
            if (commandData.allowFallback === false || commandData.actionBackend === 'cdp-input') {
                sendResponseToWs({
                    type: 'command_result',
                    data: {
                        requestId,
                        sourceClientId,
                        status: 'error',
                        code: cdpError.code || 'CDP_BACKEND_UNAVAILABLE',
                        error: cdpError.message,
                        details: cdpError.details || null
                    }
                });
                return;
            }
            console.warn(`[VCP Background] CDP Input ${command} 失败，回退 content script:`, cdpError.message);
            try {
                await sendCommandToContentScript(tabId, {
                    ...commandData,
                    actionBackend: 'content-script',
                    fallbackUsed: true,
                    fallbackReason: cdpError.code || cdpError.message
                });
                return;
            } catch (fallbackError) {
                sendResponseToWs({
                    type: 'command_result',
                    data: {
                        requestId,
                        sourceClientId,
                        status: 'error',
                        code: fallbackError.code || 'ACTION_DISPATCH_FAILED',
                        error: fallbackError.message,
                        details: {
                            cdpError: cdpError.message,
                            fallbackError: fallbackError.message
                        }
                    }
                });
                return;
            }
        }
    }
    
    // 特权命令统一进入载体无关 Runtime Core，再由 Chrome Adapter 调用真实 Chrome API。
    if (command.startsWith('cdp_') || command === 'execute_script' || command === 'list_tabs' || command === 'switch_tab' || command === 'close_tab' || isScreenshotCommand(command)) {
        try {
            const result = await executeLegacyCommandThroughCore(commandData);
            sendResponseToWs({
                type: 'command_result',
                data: { requestId, sourceClientId, ...result }
            });
        } catch (error) {
            sendResponseToWs({
                type: 'command_result',
                data: {
                    requestId,
                    sourceClientId,
                    status: 'error',
                    code: error.code || 'BACKGROUND_COMMAND_ERROR',
                    error: error.message,
                    details: error.details || null
                }
            });
        }
        return;
    }

    // 其他指令转发给 content_script。导航后只允许重试无副作用查询/等待命令；
    // click/type/send_keys 等动作绝不自动重放，避免重复提交。
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];
    if (!activeTab) {
        sendResponseToWs({
            type: 'command_result',
            data: { requestId, sourceClientId, status: 'error', code: 'NO_ACTIVE_TAB', error: '没有活动的标签页' }
        });
        return;
    }

    try {
        await sendCommandToContentScript(activeTab.id, commandData);
    } catch (err) {
        if (shouldTreatChannelCloseAsNavigation(commandData, err)) {
            console.log('[VCP Background] 🔄 点击触发导航导致 content script 通道关闭，等待标签页完成加载:', err.message);
            const loadResult = await waitForTabLoadComplete(activeTab.id, 12000);
            sendResponseToWs({
                type: 'command_result',
                data: {
                    requestId,
                    sourceClientId,
                    status: 'success',
                    code: 'NAVIGATION_COMPLETED_OR_STABLE',
                    message: `点击已触发页面导航，已等待标签页状态: ${loadResult.reason}，随后请求新页面信息。`,
                    result: {
                        navigationInProgress: false,
                        navigationWaitReason: loadResult.reason,
                        tab: loadResult.tab ? {
                            id: loadResult.tab.id,
                            title: loadResult.tab.title,
                            url: loadResult.tab.url,
                            status: loadResult.tab.status
                        } : null,
                        originalChannelError: err.message
                    }
                }
            });
            // 必须在 command_result 之后请求 page_info：服务端收到结果后才会将 pending 标记为已执行。
            setTimeout(() => requestPageInfoWithRetry(activeTab.id), 2500);
            return;
        }

        try {
            await sendSafeCommandAfterNavigation(activeTab.id, commandData, err);
            // content script 会自行通过 COMMAND_RESULT 回传原命令结果，此处不能重复发送。
            return;
        } catch (retryError) {
            sendResponseToWs({
                type: 'command_result',
                data: {
                    requestId,
                    sourceClientId,
                    status: 'error',
                    code: retryError.code || 'CONTENT_SCRIPT_CONTEXT_LOST',
                    error: '无法连接到页面脚本: ' + retryError.message,
                    details: retryError.details || null
                }
            });
        }
    }
}

function sendResponseToWs(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
}

function rejectPendingUrlFetchCookieSync(errorMessage) {
    pendingUrlFetchCookieSync.forEach((pending, requestId) => {
        clearTimeout(pending.timeoutId);
        pending.sendResponse({
            status: 'error',
            code: 'VCP_NOT_CONNECTED',
            error: errorMessage
        });
        pendingUrlFetchCookieSync.delete(requestId);
    });
}

function createRequestId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}

function requestUrlFetchCookieSync(sendResponse) {
    if (!isConnected || !ws || ws.readyState !== WebSocket.OPEN) {
        sendResponse({ status: 'error', code: 'VCP_NOT_CONNECTED', error: 'VCP WebSocket 尚未连接' });
        return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) {
            sendResponse({
                status: 'error',
                code: 'ACTIVE_TAB_QUERY_FAILED',
                error: `无法获取当前活动标签页：${chrome.runtime.lastError.message}`
            });
            return;
        }

        const tab = tabs?.[0];
        const pageUrl = String(tab?.url || '');
        let url;
        try {
            url = new URL(pageUrl);
        } catch (_) {
            sendResponse({ status: 'error', code: 'INVALID_PAGE_URL', error: '当前标签页不是有效网页' });
            return;
        }

        if (!['http:', 'https:'].includes(url.protocol)) {
            sendResponse({
                status: 'error',
                code: 'UNSUPPORTED_PAGE',
                error: '当前标签页不是 HTTP/HTTPS 页面，无法读取 Cookie'
            });
            return;
        }

        const siteKey = url.hostname.toLowerCase().replace(/\.$/, '');
        const validSiteKey = siteKey.length > 0 &&
            siteKey.length <= 253 &&
            !siteKey.includes(':') &&
            siteKey.split('.').every(label =>
                label.length > 0 &&
                label.length <= 63 &&
                /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
            );
        if (!validSiteKey) {
            sendResponse({
                status: 'error',
                code: 'INVALID_PAGE_URL',
                error: '当前页面主机名格式不受支持'
            });
            return;
        }

        chrome.cookies.getAll({ url: pageUrl }, (cookies) => {
            if (chrome.runtime.lastError) {
                sendResponse({
                    status: 'error',
                    code: 'COOKIE_QUERY_FAILED',
                    error: `读取当前站点 Cookie 失败：${chrome.runtime.lastError.message}`
                });
                return;
            }
            if (!Array.isArray(cookies) || cookies.length === 0) {
                sendResponse({
                    status: 'error',
                    code: 'NO_COOKIES',
                    error: '当前页面没有可用 Cookie'
                });
                return;
            }

            const requestId = createRequestId();
            const timeoutId = setTimeout(() => {
                const pending = pendingUrlFetchCookieSync.get(requestId);
                if (!pending) return;
                pendingUrlFetchCookieSync.delete(requestId);
                pending.sendResponse({
                    status: 'error',
                    code: 'URLFETCH_COOKIE_SYNC_TIMEOUT',
                    error: '服务端写入 UrlFetch Cookie 超时'
                });
            }, 30000);

            pendingUrlFetchCookieSync.set(requestId, { sendResponse, timeoutId });
            try {
                ws.send(JSON.stringify({
                    type: 'urlfetch_cookie_sync',
                    data: {
                        requestId,
                        siteKey,
                        pageUrl,
                        cookies: cookies.map(cookie => ({
                            name: cookie.name,
                            value: cookie.value
                        }))
                    }
                }));
            } catch (error) {
                clearTimeout(timeoutId);
                pendingUrlFetchCookieSync.delete(requestId);
                sendResponse({
                    status: 'error',
                    code: 'COOKIE_SYNC_SEND_FAILED',
                    error: `发送 Cookie 到 VCP 服务端失败：${error.message || error}`
                });
            }
        });
    });
}

function parseNumberParam(value, defaultValue, minValue, maxValue) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return defaultValue;
    return Math.min(Math.max(parsed, minValue), maxValue);
}

async function ensureDebuggerAttached(tabId) {
    await chromeWebAgentAdapter.ensureDebugger(tabId);
}

async function sendCdpCommand(tabId, method, params = {}) {
    const response = await chromeWebAgentAdapter.sendDebuggerCommand(
        method,
        params,
        { targetId: tabId }
    );
    return response?.result || {};
}

function isScreenshotCommand(command) {
    return ['capture_screenshot', 'get_screenshot', 'screenshot'].includes(String(command || '').trim().toLowerCase());
}

function broadcastPrivacySettingsToTabs() {
    chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }, (tabs) => {
        tabs.forEach(tab => {
            chrome.tabs.sendMessage(tab.id, {
                type: 'PRIVACY_SETTINGS_CHANGED',
                redactSensitiveDom
            }).catch(() => {
                // 页面脚本尚未注入或页面已销毁时无需重试。
            });
        });
    });
}

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
        isMonitoringEnabled: isMonitoringEnabled,
        clientKind: runtimeIdentity.clientKind,
        agentMode: runtimeIdentity.clientKind === 'agent',
        managedRuntime: runtimeIdentity.managedRuntime,
        managedTokenPresent: !!runtimeIdentity.managedToken,
        connectionEnabled
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
    chromeWebAgentAdapter.setActiveTargetId(activeInfo.tabId);
    
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
            chrome.tabs.sendMessage(activeInfo.tabId, { type: 'REQUEST_PAGE_INFO_UPDATE', isMonitoringEnabled: true, force: true }, (response) => {
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
    // 主框架导航开始即提升文档代次；旧文档句柄与缓存不得跨代恢复。
    if (changeInfo.status === 'loading') {
        chromeWebAgentAdapter.noteDocumentGeneration(tabId, 'chrome.tabs.onUpdated:loading');
        for (const key of pageImageCache.keys()) {
            if (key.startsWith(`${tabId}|`)) pageImageCache.delete(key);
        }
    }
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
        chromeWebAgentAdapter.setActiveTargetId(tabId);
        console.log(`[VCP Background] ✅ 活动标签页加载完成 [ID:${tab.id}] 标题:《${tab.title}》`);
        
        if (isMonitoringEnabled) {
                        // 页面加载完成后，搜索结果/SPA 内容仍可能异步渲染；延迟请求，避免只抓到顶部导航。
                        setTimeout(() => {
                            const sendUpdateRequest = (retryCount = 0) => {
                                chrome.tabs.sendMessage(tabId, { type: 'REQUEST_PAGE_INFO_UPDATE', isMonitoringEnabled: true, force: true }, (response) => {
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
            }, 2500); // 等待搜索结果/动态内容稳定
        }
    }
});

// 初始化：获取当前活动标签页和监控状态
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
        currentActiveTabId = tabs[0].id;
        chromeWebAgentAdapter.setActiveTargetId(tabs[0].id);
        chromeWebAgentAdapter.updateDocumentState(tabs[0].id, {
            documentGeneration: 1,
            snapshotId: null
        });
        console.log(`[VCP Background] 🎯 初始化：检测到当前激活标签页 [ID:${tabs[0].id}] 标题:《${tabs[0].title}》 URL:${tabs[0].url}`);
    }
});

// 从storage恢复监控与隐私状态。隐私设置未出现时按 true 初始化。
chrome.storage.local.get(['isMonitoringEnabled', 'redactSensitiveDom'], (result) => {
    if (result.isMonitoringEnabled !== undefined) {
        isMonitoringEnabled = result.isMonitoringEnabled;
        console.log('[VCP Background] 📡 恢复监控状态:', isMonitoringEnabled ? '开启' : '关闭');
        broadcastMonitoringStatusToTabs();
    }
    redactSensitiveDom = result.redactSensitiveDom !== false;
    if (result.redactSensitiveDom === undefined) {
        chrome.storage.local.set({ redactSensitiveDom: true });
    }
    broadcastPrivacySettingsToTabs();
});

// 初始化图标状态
updateIcon();

if (chrome.alarms && chrome.alarms.onAlarm) {
    chrome.alarms.create('vcp-managed-keepalive', { periodInMinutes: 1 });
    chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === 'vcp-managed-keepalive' && shouldAutoReconnect() && !isConnected) {
            scheduleReconnect(0);
        }
    });
}

// 恢复用户明确选择的模式。人工 Managed 优先于自动 staging 探测。
chrome.storage.local.get(['connectionEnabled', 'clientKind', 'managedRuntime', 'manualManagedSelection'], (result) => {
    if (result.connectionEnabled !== undefined) connectionEnabled = result.connectionEnabled === true;
    if (result.clientKind === 'agent') runtimeIdentity.clientKind = 'agent';
    if (
        result.clientKind === 'managed' &&
        result.managedRuntime === true &&
        result.manualManagedSelection === true
    ) {
        runtimeIdentity.clientKind = 'managed';
        runtimeIdentity.managedRuntime = true;
        runtimeIdentity.manualManagedSelection = true;
        runtimeIdentity.managedToken = null;
        runtimeIdentity.managedTokenCreatedAt = 0;
    }

    loadManagedRuntimeConfig().finally(() => {
        if (runtimeIdentity.managedRuntime || runtimeIdentity.clientKind === 'agent') {
            connectionEnabled = true;
            isMonitoringEnabled = true;
            chrome.storage.local.set({ isMonitoringEnabled: true, connectionEnabled: true });
            broadcastMonitoringStatusToTabs();
        }
        if (connectionEnabled || shouldAutoReconnect()) {
            connect();
        } else {
            console.log('[VCP Background] 初始化：用户模式连接已关闭，不自动连接。');
            broadcastStatusUpdate();
        }
    });
});
