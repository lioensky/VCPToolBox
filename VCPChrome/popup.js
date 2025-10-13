console.log('[VCP Popup] 🚀 popup.js 脚本已加载！');

document.addEventListener('DOMContentLoaded', () => {
    console.log('[VCP Popup] 📱 DOMContentLoaded 事件触发');
    
    // UI元素
    const monitorStatusBadge = document.getElementById('monitor-status');
    const vcpStatusBadge = document.getElementById('vcp-status');
    const toggleMonitorBtn = document.getElementById('toggleMonitor');
    const toggleVCPBtn = document.getElementById('toggleVCP');
    const refreshButton = document.getElementById('refreshPage');
    const settingsToggle = document.getElementById('settings-toggle');
    const settingsDiv = document.getElementById('settings');
    const serverUrlInput = document.getElementById('serverUrl');
    const vcpKeyInput = document.getElementById('vcpKey');
    const saveSettingsButton = document.getElementById('saveSettings');
    const pageInfoDiv = document.getElementById('page-info');
    const pageTitleDiv = document.getElementById('page-title');
    const pageUrlDiv = document.getElementById('page-url');

    let isMonitoringEnabled = false;
    let isVCPConnected = false;

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

    // 加载已保存的设置
    function loadSettings() {
        chrome.storage.local.get(['serverUrl', 'vcpKey'], (result) => {
            if (result.serverUrl) {
                serverUrlInput.value = result.serverUrl;
            }
            if (result.vcpKey) {
                vcpKeyInput.value = result.vcpKey;
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
        chrome.storage.local.set({ serverUrl, vcpKey }, () => {
            console.log('Settings saved.');
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
        } else if (request.type === 'PAGE_INFO_BROADCAST') {
            console.log('[VCP Popup] 收到页面信息广播:', request.data);
            updatePageInfo(request.data);
        }
    });
});