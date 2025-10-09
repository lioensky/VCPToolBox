console.log('[VCP Popup] 🚀 popup.js 脚本已加载！');

document.addEventListener('DOMContentLoaded', () => {
    console.log('[VCP Popup] 📱 DOMContentLoaded 事件触发');
    const statusDiv = document.getElementById('status');
    const toggleButton = document.getElementById('toggleConnection');
    const settingsToggle = document.getElementById('settings-toggle');
    const settingsDiv = document.getElementById('settings');
    const serverUrlInput = document.getElementById('serverUrl');
    const vcpKeyInput = document.getElementById('vcpKey');
    const saveSettingsButton = document.getElementById('saveSettings');
    
    // 新增：页面信息相关元素
    const pageInfoDiv = document.getElementById('page-info');
    const pageTitleDiv = document.getElementById('page-title');
    const pageUrlDiv = document.getElementById('page-url');
    const refreshButton = document.getElementById('refreshPage');

    // 更新UI的函数
    function updateUI(isConnected) {
        if (isConnected) {
            statusDiv.textContent = '已连接到 VCP 服务器';
            statusDiv.className = 'connected';
            toggleButton.textContent = '断开连接';
        } else {
            statusDiv.textContent = '已断开连接';
            statusDiv.className = 'disconnected';
            toggleButton.textContent = '连接';
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

    // 页面加载时
    // 1. 加载设置
    loadSettings();
    // 2. 向background script请求当前状态
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
        if (chrome.runtime.lastError) {
            console.log("Could not establish connection. Background script might be initializing.");
            updateUI(false);
        } else {
            updateUI(response.isConnected);
        }
    });

    // 处理连接/断开按钮点击
    toggleButton.addEventListener('click', () => {
        // 只发送指令，不处理响应
        chrome.runtime.sendMessage({ type: 'TOGGLE_CONNECTION' });
    });

    // 监听来自background script的状态广播
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.type === 'STATUS_UPDATE') {
            console.log('[VCP Popup] 收到状态更新:', request.isConnected);
            updateUI(request.isConnected);
        } else if (request.type === 'PAGE_INFO_BROADCAST') {
            console.log('[VCP Popup] 收到页面信息广播:', request.data);
            // 更新页面信息显示
            updatePageInfo(request.data);
        }
    });
    
    // 新增：更新页面信息的函数
    function updatePageInfo(data) {
        console.log('[VCP Popup] updatePageInfo调用，数据:', data);
        if (data && data.title && data.url) {
            console.log('[VCP Popup] ✅ 显示页面信息:', data.title);
            pageTitleDiv.textContent = data.title;
            pageTitleDiv.style.color = '#000'; // 恢复正常颜色
            pageUrlDiv.textContent = data.url;
            
            // 存储到本地，以便下次打开时显示
            chrome.storage.local.set({ lastPageInfo: data });
        } else {
            console.log('[VCP Popup] ⚠️ 数据无效，显示占位文本');
            pageTitleDiv.textContent = '暂无页面信息';
            pageTitleDiv.style.color = '#999';
            pageUrlDiv.textContent = '';
        }
    }
    
    // 关键修复：每次打开popup时，从background获取最新的页面信息
    function loadLastPageInfo() {
        console.log('[VCP Popup] 正在请求最新页面信息...');
        // 优先从background的内存中获取
        chrome.runtime.sendMessage({ type: 'GET_LATEST_PAGE_INFO' }, (response) => {
            console.log('[VCP Popup] 收到background响应:', response);
            if (response) {
                console.log('[VCP Popup] 使用background的数据更新UI');
                updatePageInfo(response);
            } else {
                console.log('[VCP Popup] background没有数据，尝试从storage读取');
                // 如果background还没有信息，则从storage读取
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
    loadLastPageInfo(); // 立即执行一次
    
    // 新增：手动刷新按钮处理
    refreshButton.addEventListener('click', () => {
        console.log('[VCP Popup] 🔄 手动刷新按钮被点击');
        chrome.runtime.sendMessage({ type: 'MANUAL_REFRESH' }, (response) => {
            console.log('[VCP Popup] 手动刷新响应:', response);
            if (chrome.runtime.lastError) {
                console.log('[VCP Popup] ❌ 手动刷新错误:', chrome.runtime.lastError);
            }
            if (response && response.success) {
                console.log('[VCP Popup] ✅ 手动刷新成功');
                // 显示刷新成功提示
                refreshButton.textContent = '✅ 已更新';
                setTimeout(() => {
                    refreshButton.textContent = '🔄 手动更新页面';
                }, 1500);
            } else {
                console.log('[VCP Popup] ❌ 手动刷新失败');
                refreshButton.textContent = '❌ 更新失败';
                setTimeout(() => {
                    refreshButton.textContent = '🔄 手动更新页面';
                }, 1500);
            }
        });
    });

    // 处理设置按钮点击
    settingsToggle.addEventListener('click', () => {
        if (settingsDiv.style.display === 'none') {
            settingsDiv.style.display = 'block';
            settingsToggle.textContent = '隐藏设置';
        } else {
            settingsDiv.style.display = 'none';
            settingsToggle.textContent = '设置';
        }
    });

    // 处理保存设置按钮点击
    saveSettingsButton.addEventListener('click', () => {
        const serverUrl = serverUrlInput.value;
        const vcpKey = vcpKeyInput.value;
        chrome.storage.local.set({ serverUrl, vcpKey }, () => {
            console.log('Settings saved.');
            // 可选：给用户一个保存成功的提示
            saveSettingsButton.textContent = '已保存!';
            setTimeout(() => {
                saveSettingsButton.textContent = '保存设置';
            }, 1500);
        });
    });
});