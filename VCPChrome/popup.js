document.addEventListener('DOMContentLoaded', () => {
    const statusDiv = document.getElementById('status');
    const toggleButton = document.getElementById('toggleConnection');
    const settingsToggle = document.getElementById('settings-toggle');
    const settingsDiv = document.getElementById('settings');
    const serverUrlInput = document.getElementById('serverUrl');
    const vcpKeyInput = document.getElementById('vcpKey');
    const saveSettingsButton = document.getElementById('saveSettings');

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
            updateUI(request.isConnected);
        }
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