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
 * 检查当前认证状态（通过后端验证）
 * @returns {Promise<boolean>} - 是否已认证
 */
export async function checkAuthStatus() {
    try {
        const response = await fetch('/admin_api/check-auth', {
            method: 'GET',
            credentials: 'same-origin'
        });
        return response.ok;
    } catch (error) {
        console.error('Auth check failed:', error);
        return false;
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
        options.credentials = options.credentials || 'same-origin';

        const response = await fetch(url, options);
        if (!response.ok) {
            if (response.status === 401) {
                // 认证失效，跳转登录页（防止重复跳转）
                if (!window.location.pathname.includes('login.html')) {
                    console.warn('401 Unauthorized, redirecting to login...');
                    window.location.href = '/AdminPanel/login.html';
                }
                return new Promise(() => {}); // 中断后续逻辑
            }
            
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

/**
 * 转义 HTML 字符串以防止注入。
 * @param {string} str - 需要转义的字符串
 * @returns {string} - 转义后的字符串
 */
export function escapeHTML(str) {
    if (!str) return '';
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return str.toString().replace(/[&<>"']/g, function(m) { return map[m]; });
}