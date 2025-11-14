// AdminPanel/js/utils.js

/**
 * 显示或隐藏加载覆盖层。
 * @param {boolean} show - 是否显示加载层
 */
export function showLoading(show) {
    const loadingOverlay = document.getElementById('loading-overlay');
    if (loadingOverlay) {
        loadingOverlay.classList.toggle('visible', show);
    }
}

/**
 * 显示一个消息弹窗。
 * @param {string} message - 要显示的消息
 * @param {string} [type='info'] - 消息类型 ('info', 'success', 'error')
 * @param {number} [duration=3500] - 显示时长（毫秒）
 */
export function showMessage(message, type = 'info', duration = 3500) {
    const messagePopup = document.getElementById('message-popup');
    if (messagePopup) {
        messagePopup.textContent = message;
        messagePopup.className = 'message-popup'; // Reset classes
        messagePopup.classList.add(type, 'show');
        setTimeout(() => {
            messagePopup.classList.remove('show');
        }, duration);
    }
}

/**
 * 封装的 fetch 请求函数。
 * @param {string} url - 请求的 URL
 * @param {object} [options={}] - fetch 的配置选项
 * @param {boolean} [showLoader=true] - 是否显示加载动画
 * @returns {Promise<any>} - 返回 Promise，解析为 JSON 或文本
 */
export async function apiFetch(url, options = {}, showLoader = true) {
    if (showLoader) showLoading(true);
    try {
        const defaultHeaders = {
            'Content-Type': 'application/json',
        };
        options.headers = { ...defaultHeaders, ...options.headers };

        const response = await fetch(url, options);
        if (!response.ok) {
            let errorData = { error: `HTTP error ${response.status}`, details: response.statusText };
            try {
                const jsonError = await response.json();
                errorData = { ...errorData, ...jsonError };
            } catch (e) { /* Ignore if response is not JSON */ }
            throw new Error(errorData.message || errorData.error || errorData.details || `HTTP error ${response.status}`);
        }
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
            return await response.json();
        } else {
            return await response.text();
        }
    } catch (error) {
        console.error('API Fetch Error:', error.message, error);
        showMessage(`操作失败: ${error.message}`, 'error');
        throw error;
    } finally {
        if (showLoader) showLoading(false);
    }
}