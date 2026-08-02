console.log('[VCP Popup] 🚀 popup.js 脚本已加载！');

document.addEventListener('DOMContentLoaded', () => {
    console.log('[VCP Popup] 📱 DOMContentLoaded 事件触发');
    
    // UI元素
    const monitorStatusBadge = document.getElementById('monitor-status');
    const vcpStatusBadge = document.getElementById('vcp-status');
    const toggleMonitorBtn = document.getElementById('toggleMonitor');
    const toggleVCPBtn = document.getElementById('toggleVCP');
    const toggleClientModeBtn = document.getElementById('toggleClientMode');
    const clientModeStatusBadge = document.getElementById('client-mode-status');
    const refreshButton = document.getElementById('refreshPage');
    const copyGroundedMarkdownButton = document.getElementById('copyGroundedMarkdown');
    const copyStatusDiv = document.getElementById('copy-status');
    const settingsToggle = document.getElementById('settings-toggle');
    const settingsDiv = document.getElementById('settings');
    const serverUrlInput = document.getElementById('serverUrl');
    const vcpKeyInput = document.getElementById('vcpKey');
    const redactSensitiveDomInput = document.getElementById('redactSensitiveDom');
    const saveSettingsButton = document.getElementById('saveSettings');
    const pageInfoDiv = document.getElementById('page-info');
    const pageTitleDiv = document.getElementById('page-title');
    const pageUrlDiv = document.getElementById('page-url');

    let isMonitoringEnabled = false;
    let isVCPConnected = false;
    let currentClientKind = 'user';

    // 更新监控状态UI
    function updateMonitorUI(enabled) {
        isMonitoringEnabled = enabled;
        if (enabled) {
            monitorStatusBadge.textContent = '开启';
            monitorStatusBadge.className = 'status-badge badge-on';
            toggleMonitorBtn.textContent = '关闭监控';
        } else {
            monitorStatusBadge.textContent = '关闭';
            monitorStatusBadge.className = 'status-badge badge-off';
            toggleMonitorBtn.textContent = '开启监控';
        }
    }

    // 更新VCP连接状态UI
    function updateVCPUI(connected) {
        isVCPConnected = connected;
        if (connected) {
            vcpStatusBadge.textContent = '已连接';
            vcpStatusBadge.className = 'status-badge badge-on';
            toggleVCPBtn.textContent = '断开VCP';
        } else {
            vcpStatusBadge.textContent = '未连接';
            vcpStatusBadge.className = 'status-badge badge-off';
            toggleVCPBtn.textContent = '连接VCP';
        }
    }

    function updateClientModeUI(clientKind) {
        currentClientKind = clientKind === 'agent' ? 'agent' : 'user';
        if (currentClientKind === 'agent') {
            clientModeStatusBadge.textContent = 'Agent';
            clientModeStatusBadge.className = 'status-badge badge-on';
            toggleClientModeBtn.textContent = '切换为 User 模式';
        } else {
            clientModeStatusBadge.textContent = 'User';
            clientModeStatusBadge.className = 'status-badge badge-off';
            toggleClientModeBtn.textContent = '切换为 Agent 模式';
        }
    }

    // 更新页面信息显示
    function updatePageInfo(data) {
        console.log('[VCP Popup] updatePageInfo调用，数据:', data);
        if (data && data.title && data.url) {
            console.log('[VCP Popup] ✅ 显示页面信息:', data.title);
            pageTitleDiv.textContent = data.title;
            pageTitleDiv.style.color = '#333';
            pageUrlDiv.textContent = data.url;
            
            // 存储到本地
            chrome.storage.local.set({ lastPageInfo: data });
        } else {
            console.log('[VCP Popup] ⚠️ 数据无效，显示占位文本');
            pageTitleDiv.textContent = '等待监控...';
            pageTitleDiv.style.color = '#999';
            pageUrlDiv.textContent = '';
        }
    }

    async function writeTextToClipboard(text) {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return;
        }
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        textarea.remove();
        if (!copied) throw new Error('浏览器拒绝写入剪贴板');
    }

    function setCopyStatus(message, isError = false) {
        copyStatusDiv.textContent = message;
        copyStatusDiv.style.color = isError ? '#b42318' : '#6d5a8f';
    }

    async function requestCurrentGroundedMarkdown() {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tab = tabs[0];
        if (!tab?.id || !/^https?:/i.test(tab.url || '')) {
            throw new Error('当前标签页不是可解析的 HTTP/HTTPS 页面');
        }
        return new Promise((resolve, reject) => {
            chrome.tabs.sendMessage(tab.id, { type: 'GET_GROUNDED_PAGE_INFO' }, (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(`无法连接页面解析器：${chrome.runtime.lastError.message}`));
                    return;
                }
                const markdown = response?.markdown || response?.pageInfo?.agentView?.markdown;
                if (!response?.success || !markdown) {
                    reject(new Error(response?.pageInfo?.error || '页面解析器未返回 Grounded Markdown'));
                    return;
                }
                resolve({ markdown, pageInfo: response.pageInfo });
            });
        });
    }

    // 加载已保存的设置
    function loadSettings() {
        chrome.storage.local.get(['serverUrl', 'vcpKey', 'clientKind', 'managedRuntime', 'managedToken', 'redactSensitiveDom'], (result) => {
            if (result.serverUrl) {
                serverUrlInput.value = result.serverUrl;
            }
            if (result.vcpKey) {
                vcpKeyInput.value = result.vcpKey;
            }
            // 缺省值必须为 true，确保升级安装和首次安装都默认脱敏。
            redactSensitiveDomInput.checked = result.redactSensitiveDom !== false;
            if (result.redactSensitiveDom === undefined) {
                chrome.storage.local.set({ redactSensitiveDom: true });
            }
            updateClientModeUI(result.clientKind);
            if (result.managedRuntime === true) {
                settingsToggle.textContent = '⚙️ 设置（managed）';
                if (!vcpKeyInput.value && result.managedToken) {
                    vcpKeyInput.placeholder = 'managed runtime 已注入 VCP Key';
                }
            }
        });
    }

    // 从background获取最新页面信息
    function loadLastPageInfo() {
        console.log('[VCP Popup] 正在请求最新页面信息...');
        chrome.runtime.sendMessage({ type: 'GET_LATEST_PAGE_INFO' }, (response) => {
            console.log('[VCP Popup] 收到background响应:', response);
            if (response) {
                console.log('[VCP Popup] 使用background的数据更新UI');
                updatePageInfo(response);
            } else {
                console.log('[VCP Popup] background没有数据，尝试从storage读取');
                chrome.storage.local.get(['lastPageInfo'], (result) => {
                    console.log('[VCP Popup] storage数据:', result.lastPageInfo);
                    if (result.lastPageInfo) {
                        updatePageInfo(result.lastPageInfo);
                    } else {
                        console.log('[VCP Popup] ❌ 没有找到任何页面信息');
                    }
                });
            }
        });
    }

    // 初始化：加载设置和状态
    loadSettings();
    loadLastPageInfo();
    
    // 从background获取当前状态
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
        if (chrome.runtime.lastError) {
            console.log("Could not establish connection. Background script might be initializing.");
            updateMonitorUI(false);
            updateVCPUI(false);
        } else {
            updateMonitorUI(response.isMonitoringEnabled || false);
            updateVCPUI(response.isConnected || false);
            updateClientModeUI(response.clientKind);
    
            if (response.serverUrl && !serverUrlInput.value) {
                serverUrlInput.value = response.serverUrl;
            }
            if (response.vcpKeyPresent && !vcpKeyInput.value) {
                vcpKeyInput.placeholder = response.managedRuntime
                    ? 'managed runtime 已注入 VCP Key'
                    : 'VCP Key 已保存';
            }
            if (response.managedRuntime) {
                settingsToggle.textContent = `⚙️ 设置（managed/${response.clientKind || 'unknown'}）`;
            }
        }
    });

    // 监控开关按钮
    toggleMonitorBtn.addEventListener('click', () => {
        console.log('[VCP Popup] 🔄 切换监控状态');
        chrome.runtime.sendMessage({ type: 'TOGGLE_MONITORING' }, (response) => {
            if (response) {
                updateMonitorUI(response.isMonitoringEnabled);
                // 如果开启监控，立即加载页面信息
                if (response.isMonitoringEnabled) {
                    setTimeout(loadLastPageInfo, 500);
                }
            }
        });
    });

    // VCP连接开关按钮
    toggleVCPBtn.addEventListener('click', () => {
        console.log('[VCP Popup] 🔄 切换VCP连接');
        chrome.runtime.sendMessage({ type: 'TOGGLE_CONNECTION' });
    });

    toggleClientModeBtn.addEventListener('click', () => {
        const nextMode = currentClientKind === 'agent' ? 'user' : 'agent';
        chrome.runtime.sendMessage({ type: 'SET_CLIENT_MODE', mode: nextMode }, (response) => {
            if (response) {
                updateClientModeUI(response.clientKind);
            }
        });
    });

    // 手动刷新按钮
    refreshButton.addEventListener('click', () => {
        console.log('[VCP Popup] 🔄 手动刷新按钮被点击');
        refreshButton.textContent = '⏳ 刷新中...';
        refreshButton.disabled = true;
        
        chrome.runtime.sendMessage({ type: 'MANUAL_REFRESH' }, (response) => {
            console.log('[VCP Popup] 手动刷新响应:', response);
            
            if (chrome.runtime.lastError) {
                console.log('[VCP Popup] ❌ 手动刷新错误:', chrome.runtime.lastError);
                refreshButton.textContent = '❌ 刷新失败';
            } else if (response && response.success) {
                console.log('[VCP Popup] ✅ 手动刷新成功');
                refreshButton.textContent = '✅ 已刷新';
                // 延迟加载最新信息
                setTimeout(loadLastPageInfo, 300);
            } else {
                console.log('[VCP Popup] ❌ 手动刷新失败');
                refreshButton.textContent = '❌ 刷新失败';
            }
            
            // 恢复按钮状态
            setTimeout(() => {
                refreshButton.textContent = '🔄 手动刷新';
                refreshButton.disabled = false;
            }, 1500);
        });
    });

    copyGroundedMarkdownButton.addEventListener('click', async () => {
        const originalText = copyGroundedMarkdownButton.textContent;
        copyGroundedMarkdownButton.disabled = true;
        copyGroundedMarkdownButton.textContent = '⏳ 正在编译页面图...';
        setCopyStatus('正在从当前活动标签页生成最新 Grounded Markdown…');
        try {
            const { markdown, pageInfo } = await requestCurrentGroundedMarkdown();
            await writeTextToClipboard(markdown);
            copyGroundedMarkdownButton.textContent = '✅ 已复制';
            setCopyStatus(
                `已复制 ${markdown.length.toLocaleString()} 字符；Snapshot ${pageInfo.snapshotId}，${pageInfo.elementCount} 个操作目标。`
            );
        } catch (error) {
            console.error('[VCP Popup] 复制 Grounded Markdown 失败:', error);
            copyGroundedMarkdownButton.textContent = '❌ 复制失败';
            setCopyStatus(error.message || String(error), true);
        } finally {
            setTimeout(() => {
                copyGroundedMarkdownButton.textContent = originalText;
                copyGroundedMarkdownButton.disabled = false;
            }, 1800);
        }
    });

    // 设置按钮
    settingsToggle.addEventListener('click', () => {
        if (settingsDiv.style.display === 'none' || !settingsDiv.style.display) {
            settingsDiv.style.display = 'block';
            settingsToggle.textContent = '⚙️ 隐藏设置';
        } else {
            settingsDiv.style.display = 'none';
            settingsToggle.textContent = '⚙️ 设置';
        }
    });

    // 保存设置按钮
    saveSettingsButton.addEventListener('click', () => {
        const serverUrl = serverUrlInput.value;
        const vcpKey = vcpKeyInput.value;
        const redactSensitiveDom = redactSensitiveDomInput.checked;
        chrome.storage.local.set({ serverUrl, vcpKey, redactSensitiveDom }, () => {
            console.log('Settings saved.');
            chrome.runtime.sendMessage({
                type: 'PRIVACY_SETTINGS_CHANGED',
                redactSensitiveDom
            });
            saveSettingsButton.textContent = '✅ 已保存!';
            setTimeout(() => {
                saveSettingsButton.textContent = '保存设置';
            }, 1500);
        });
    });

    // 监听来自background的状态更新广播
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.type === 'STATUS_UPDATE') {
            console.log('[VCP Popup] 收到状态更新:', request);
            updateMonitorUI(request.isMonitoringEnabled || false);
            updateVCPUI(request.isConnected || false);
            updateClientModeUI(request.clientKind);
            chrome.storage.local.get(['serverUrl', 'vcpKey', 'managedRuntime'], (result) => {
                if (result.serverUrl && !serverUrlInput.value) {
                    serverUrlInput.value = result.serverUrl;
                }
                if ((request.managedRuntime || result.managedRuntime) && !vcpKeyInput.value) {
                    vcpKeyInput.placeholder = 'managed runtime 已注入 VCP Key';
                }
            });
        } else if (request.type === 'PAGE_INFO_BROADCAST') {
            console.log('[VCP Popup] 收到页面信息广播:', request.data);
            updatePageInfo(request.data);
        }
    });
});