// AdminPanel/js/log-viewer.js
import { apiFetch, showMessage } from './utils.js';

const API_BASE_URL = '/admin_api';
let serverLogIntervalId = null;
let originalLogContent = '';

/**
 * 初始化服务器日志查看器。
 */
export async function initializeServerLogViewer() {
    console.log('Initializing Server Log Viewer...');
    if (serverLogIntervalId) {
        clearInterval(serverLogIntervalId);
        serverLogIntervalId = null;
    }

    const serverLogContentPre = document.getElementById('server-log-content');
    const serverLogFilterInput = document.getElementById('server-log-filter');
    
    if (serverLogContentPre) serverLogContentPre.textContent = '正在加载日志...';
    if (serverLogFilterInput) serverLogFilterInput.value = '';

    setupEventListeners();
    await loadServerLog();

    if (!serverLogIntervalId) {
        serverLogIntervalId = setInterval(loadServerLog, 2000);
        console.log('Started server log auto-refresh interval.');
    }
}

/**
 * 停止服务器日志的自动刷新。
 */
export function stopServerLogUpdates() {
    if (serverLogIntervalId) {
        clearInterval(serverLogIntervalId);
        serverLogIntervalId = null;
        console.log('Server log auto-refresh stopped.');
    }
}

/**
 * 设置日志查看器部分的事件监听器。
 */
function setupEventListeners() {
    const copyServerLogButton = document.getElementById('copy-server-log-button');
    const serverLogFilterInput = document.getElementById('server-log-filter');

    if (copyServerLogButton && !copyServerLogButton.dataset.listenerAttached) {
        copyServerLogButton.addEventListener('click', copyServerLogToClipboard);
        copyServerLogButton.dataset.listenerAttached = 'true';
    }
    if (serverLogFilterInput && !serverLogFilterInput.dataset.listenerAttached) {
        serverLogFilterInput.addEventListener('input', filterAndHighlightLog);
        serverLogFilterInput.dataset.listenerAttached = 'true';
    }
}

async function loadServerLog() {
    const serverLogContentPre = document.getElementById('server-log-content');
    const serverLogStatusSpan = document.getElementById('server-log-status');
    const serverLogPathDisplay = document.getElementById('server-log-path-display');
    const serverLogFilterInput = document.getElementById('server-log-filter');

    if (!serverLogContentPre || !serverLogStatusSpan || !serverLogPathDisplay) {
        console.error('Server log display elements not found.');
        return;
    }
    serverLogStatusSpan.textContent = '正在加载日志...';
    serverLogStatusSpan.className = 'status-message info';
    try {
        const data = await apiFetch(`${API_BASE_URL}/server-log`);
        originalLogContent = data.content || '日志内容为空或加载失败。';
        serverLogPathDisplay.textContent = `当前日志文件: ${data.path || '未知'}`;
        serverLogStatusSpan.textContent = '日志已加载。';
        serverLogStatusSpan.className = 'status-message success';
        
        filterAndHighlightLog();

        if (!serverLogFilterInput.value.trim()) {
            serverLogContentPre.scrollTop = serverLogContentPre.scrollHeight;
        }
    } catch (error) {
        originalLogContent = `加载服务器日志失败: ${error.message}`;
        serverLogContentPre.textContent = originalLogContent;
        serverLogPathDisplay.textContent = `当前日志文件: 未知`;
        serverLogStatusSpan.textContent = `加载失败: ${error.message}`;
        serverLogStatusSpan.className = 'status-message error';
    }
}

function filterAndHighlightLog() {
    const serverLogContentPre = document.getElementById('server-log-content');
    const serverLogFilterInput = document.getElementById('server-log-filter');
    if (!serverLogContentPre || !serverLogFilterInput) return;

    const filterValue = serverLogFilterInput.value.trim().toLowerCase();
    
    if (!filterValue) {
        serverLogContentPre.textContent = originalLogContent;
        return;
    }

    const lines = originalLogContent.split('\n');
    const filteredLines = [];
    const escapedFilterValue = filterValue.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const highlightRegex = new RegExp(escapedFilterValue, 'gi');

    for (const line of lines) {
        if (line.toLowerCase().includes(filterValue)) {
            const highlightedLine = line.replace(highlightRegex, (match) => `<span class="highlight">${match}</span>`);
            filteredLines.push(highlightedLine);
        }
    }

    if (filteredLines.length > 0) {
        serverLogContentPre.innerHTML = filteredLines.join('\n');
    } else {
        serverLogContentPre.textContent = `没有找到包含 "${serverLogFilterInput.value}" 的日志条目。`;
    }
}

async function copyServerLogToClipboard() {
    const serverLogContentPre = document.getElementById('server-log-content');
    const serverLogStatusSpan = document.getElementById('server-log-status');
    if (!serverLogContentPre) {
        showMessage('日志内容元素未找到。', 'error');
        return;
    }
    const logContent = serverLogContentPre.textContent;
    if (!logContent || logContent.startsWith('正在加载') || logContent.startsWith('加载失败')) {
        showMessage('没有可复制的日志内容。', 'info');
        return;
    }

    const showSuccess = () => {
        showMessage('日志内容已复制到剪贴板！', 'success');
        if (serverLogStatusSpan) {
            serverLogStatusSpan.textContent = '日志已复制!';
            serverLogStatusSpan.className = 'status-message success';
            setTimeout(() => {
                if (serverLogStatusSpan.textContent === '日志已复制!') {
                    serverLogStatusSpan.textContent = '日志已加载。';
                }
            }, 3000);
        }
    };

    const showError = (err, type = '') => {
        console.error(`无法复制日志${type}: `, err);
        showMessage('无法自动复制日志。请手动复制。', 'error');
        if (serverLogStatusSpan) {
            serverLogStatusSpan.textContent = '复制失败';
            serverLogStatusSpan.className = 'status-message error';
        }
    };

    // Modern clipboard API
    if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
            await navigator.clipboard.writeText(logContent);
            showSuccess();
        } catch (err) {
            showError(err);
        }
        return;
    }

    // Fallback for non-secure contexts
    const textArea = document.createElement('textarea');
    textArea.value = logContent;
    textArea.style.position = 'fixed';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
        const successful = document.execCommand('copy');
        if (successful) {
            showSuccess();
        } else {
            throw new Error('document.execCommand failed');
        }
    } catch (err) {
        showError(err, ' (fallback)');
    } finally {
        document.body.removeChild(textArea);
    }
}