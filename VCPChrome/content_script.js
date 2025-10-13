let lastPageContent = '';
let vcpIdCounter = 0;
let isActiveTab = false; // 标记当前标签页是否为活动标签页

function isInteractive(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) {
        return false;
    }
    // 如果元素不可见，则它不是可交互的
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || style.height === '0' || style.width === '0') {
        return false;
    }

    const tagName = node.tagName.toLowerCase();
    const role = node.getAttribute('role');

    // 1. 标准的可交互元素
    if (['a', 'button', 'input', 'textarea', 'select', 'option'].includes(tagName)) {
        return true;
    }

    // 2. 常见的可交互ARIA角色
    if (role && ['button', 'link', 'checkbox', 'radio', 'menuitem', 'tab', 'switch', 'option', 'treeitem', 'searchbox', 'textbox', 'combobox'].includes(role)) {
        return true;
    }

    // 3. 通过JS属性明确可点击
    if (node.hasAttribute('onclick')) {
        return true;
    }

    // 4. 可聚焦的元素（非禁用）
    if (node.hasAttribute('tabindex') && node.getAttribute('tabindex') !== '-1') {
        return true;
    }
    
    // 5. 样式上被设计为可交互的元素
    if (style.cursor === 'pointer') {
        // 避免标记body或仅用于包裹的巨大容器
        if (tagName === 'body' || tagName === 'html') return false;
        // 如果一个元素没有文本内容但有子元素，它可能只是一个包装器
        if ((node.innerText || '').trim().length === 0 && node.children.length > 0) {
             // 但如果这个包装器有role属性，它可能是一个自定义组件
            if (!role) return false;
        }
        return true;
    }

    return false;
}


function pageToMarkdown() {
    try {
        // 为确保每次都是全新的抓取，先移除所有旧的vcp-id
        document.querySelectorAll('[vcp-id]').forEach(el => el.removeAttribute('vcp-id'));
        vcpIdCounter = 0; // 重置计数器
        const body = document.body;
        if (!body) {
            return '';
        }

        let markdown = `# ${document.title}\nURL: ${document.URL}\n\n`;
        const ignoredTags = ['SCRIPT', 'STYLE', 'FOOTER', 'IFRAME', 'NOSCRIPT']; // 移除 'NAV' 和 'ASIDE'
        const processedNodes = new WeakSet(); // 记录已处理过的节点，防止重复

        function processNode(node) {
            // 1. 基本过滤条件
            if (!node || processedNodes.has(node)) return '';

            if (node.nodeType === Node.ELEMENT_NODE) {
                const style = window.getComputedStyle(node);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                    return '';
                }
                if (ignoredTags.includes(node.tagName)) {
                    return '';
                }
            }

            // 如果父元素已经被标记为可交互元素并处理过，则跳过此节点
            if (node.parentElement && node.parentElement.closest('[vcp-id]')) {
                return '';
            }

            // 2. 优先处理可交互元素
            if (isInteractive(node)) {
                const interactiveMd = formatInteractiveElement(node);
                if (interactiveMd) {
                    // 标记此节点及其所有子孙节点为已处理
                    processedNodes.add(node);
                    node.querySelectorAll('*').forEach(child => processedNodes.add(child));
                    return interactiveMd + '\n';
                }
            }

            // 3. 处理文本节点
            if (node.nodeType === Node.TEXT_NODE) {
                // 用正则表达式替换多个空白为一个空格
                return node.textContent.replace(/\s+/g, ' ').trim() + ' ';
            }

            // 4. 递归处理子节点 (包括 Shadow DOM)
            let childContent = '';
            if (node.shadowRoot) {
                childContent += processNode(node.shadowRoot);
            }
            
            node.childNodes.forEach(child => {
                childContent += processNode(child);
            });

            // 新增代码开始
            if (node.nodeType === Node.ELEMENT_NODE && childContent.trim()) {
                const tagName = node.tagName.toLowerCase();
                if (tagName === 'nav') {
                    // 为导航区添加标题和代码块包裹
                    return '\n## 导航区\n```markdown\n' + childContent.trim() + '\n```\n\n';
                } else if (tagName === 'aside') {
                    // 为侧边栏添加标题和代码块包裹
                    return '\n## 侧边栏\n```markdown\n' + childContent.trim() + '\n```\n\n';
                }
            }
            // 新增代码结束

            // 5. 为块级元素添加换行以保持结构
            if (node.nodeType === Node.ELEMENT_NODE && childContent.trim()) {
                const style = window.getComputedStyle(node);
                if (style.display === 'block' || style.display === 'flex' || style.display === 'grid') {
                    return '\n' + childContent.trim() + '\n';
                }
            }

            return childContent;
        }

        markdown += processNode(body);
        
        // 清理最终的Markdown文本
        markdown = markdown.replace(/[ \t]+/g, ' '); // 合并多余空格
        markdown = markdown.replace(/ (\n)/g, '\n'); // 清理行尾空格
        markdown = markdown.replace(/(\n\s*){3,}/g, '\n\n'); // 合并多余空行
        markdown = markdown.trim();
        
        return markdown;
    } catch (e) {
        return `# ${document.title}\n\n[处理页面时出错: ${e.message}]`;
    }
}


function formatInteractiveElement(el) {
    // 避免重复标记同一个元素
    if (el.hasAttribute('vcp-id')) {
        return '';
    }

    vcpIdCounter++;
    const vcpId = `vcp-id-${vcpIdCounter}`;
    el.setAttribute('vcp-id', vcpId);

    let text = (el.innerText || el.value || el.placeholder || el.ariaLabel || el.title || '').trim().replace(/\s+/g, ' ');
    const tagName = el.tagName.toLowerCase();
    const role = el.getAttribute('role');

    if (role === 'combobox' || role === 'searchbox') {
        const label = findLabelForInput(el);
        return `[输入框: ${label || text || el.name || el.id || '无标题输入框'}](${vcpId})`;
    }

    if (tagName === 'a' && el.href) {
        return `[链接: ${text || '无标题链接'}](${vcpId})`;
    }

    if (tagName === 'button' || role === 'button' || (tagName === 'input' && ['button', 'submit', 'reset'].includes(el.type))) {
        return `[按钮: ${text || '无标题按钮'}](${vcpId})`;
    }

    if (tagName === 'input' && !['button', 'submit', 'reset', 'hidden'].includes(el.type)) {
        const label = findLabelForInput(el);
        return `[输入框: ${label || text || el.name || el.id || '无标题输入框'}](${vcpId})`;
    }

    if (tagName === 'textarea') {
        const label = findLabelForInput(el);
        return `[文本区域: ${label || text || el.name || el.id || '无标题文本区域'}](${vcpId})`;
    }

    if (tagName === 'select') {
        const label = findLabelForInput(el);
        return `[下拉选择: ${label || text || el.name || el.id || '无标题下拉框'}](${vcpId})`;
    }

    // 为其他所有可交互元素（如可点击的div，带角色的span等）提供通用处理
    if (text) {
        return `[可交互元素: ${text}](${vcpId})`;
    }

    // 如果元素没有文本但仍然是可交互的（例如，一个图标按钮），我们仍然需要标记它
    // 但我们不回退ID，而是将其标记为一个没有文本的元素
    const type = el.type || role || tagName;
    return `[可交互元素: 无文本 (${type})](${vcpId})`;
}

function findLabelForInput(inputElement) {
    if (!inputElement) return null;
    if (inputElement.id) {
        const label = document.querySelector(`label[for="${inputElement.id}"]`);
        if (label) return label.innerText.trim();
    }
    const parentLabel = inputElement.closest('label');
    if (parentLabel) return parentLabel.innerText.trim();
    return null;
}

/**
 * 多策略元素定位器
 * @param {string} target - 目标标识符
 * @returns {Element|null} 找到的元素
 */
function findElement(target) {
    if (!target) return null;

    // 策略1: 精确匹配 vcp-id
    let element = document.querySelector(`[vcp-id="${target}"]`);
    if (element) return element;

    // 策略2: ARIA 标签匹配
    element = document.querySelector(`[aria-label="${target}"]`);
    if (element) return element;

    // 策略3: XPath 查找（如果 target 看起来像 XPath）
    if (target.startsWith('/') || target.startsWith('//')) {
        element = findByXPath(target);
        if (element) return element;
    }

    // 策略4: CSS 选择器（如果 target 看起来像选择器）
    if (target.includes('#') || target.includes('.') || target.includes('[')) {
        try {
            element = document.querySelector(target);
            if (element) return element;
        } catch (e) {
            // 不是有效的选择器，继续尝试其他策略
        }
    }

    // 策略5: 模糊文本匹配
    element = findByFuzzyText(target);
    if (element) return element;

    // 策略6: Name 属性匹配
    element = document.querySelector(`[name="${target}"]`);
    if (element) return element;

    // 策略7: ID 匹配
    element = document.getElementById(target);
    if (element) return element;

    // 策略8: Placeholder 匹配
    element = document.querySelector(`[placeholder="${target}"]`);
    if (element) return element;

    // 策略9: Title 匹配
    element = document.querySelector(`[title="${target}"]`);
    if (element) return element;

    return null;
}

/**
 * XPath 查找
 * @param {string} xpath - XPath 表达式
 * @returns {Element|null}
 */
function findByXPath(xpath) {
    try {
        const result = document.evaluate(
            xpath,
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
        );
        return result.singleNodeValue;
    } catch (e) {
        console.warn('Invalid XPath:', xpath, e);
        return null;
    }
}

/**
 * 模糊文本匹配（支持部分匹配、忽略大小写、忽略多余空白）
 * @param {string} targetText - 目标文本
 * @returns {Element|null}
 */
function findByFuzzyText(targetText) {
    const normalizedTarget = normalizeText(targetText);
    
    // 优先查找可交互元素
    const interactiveElements = document.querySelectorAll(
        'a, button, input, textarea, select, [role="button"], [role="link"], [onclick], [tabindex]'
    );

    let bestMatch = null;
    let bestScore = 0;

    for (const el of interactiveElements) {
        // 跳过不可见元素
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') {
            continue;
        }

        // 获取元素的所有文本表示
        const texts = [
            el.innerText,
            el.textContent,
            el.value,
            el.placeholder,
            el.ariaLabel,
            el.title,
            el.alt,
            el.getAttribute('aria-label'),
            el.getAttribute('data-label')
        ].filter(Boolean);

        for (const text of texts) {
            const normalizedText = normalizeText(text);
            
            // 精确匹配
            if (normalizedText === normalizedTarget) {
                return el;
            }

            // 计算相似度分数
            const score = calculateSimilarity(normalizedTarget, normalizedText);
            if (score > bestScore && score > 0.6) { // 60% 相似度阈值
                bestScore = score;
                bestMatch = el;
            }
        }
    }

    return bestMatch;
}

/**
 * 文本标准化
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text) {
    if (!text) return '';
    return text
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * 计算文本相似度（简单版本）
 * @param {string} str1
 * @param {string} str2
 * @returns {number} 0-1 之间的相似度分数
 */
function calculateSimilarity(str1, str2) {
    // 包含匹配
    if (str2.includes(str1)) {
        return str1.length / str2.length;
    }
    if (str1.includes(str2)) {
        return str2.length / str1.length;
    }

    // Levenshtein 距离（编辑距离）
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.length === 0) {
        return 1.0;
    }

    const editDistance = levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
}

/**
 * Levenshtein 距离算法
 * @param {string} str1
 * @param {string} str2
 * @returns {number}
 */
function levenshteinDistance(str1, str2) {
    const matrix = [];

    for (let i = 0; i <= str2.length; i++) {
        matrix[i] = [i];
    }

    for (let j = 0; j <= str1.length; j++) {
        matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
        for (let j = 1; j <= str1.length; j++) {
            if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // 替换
                    matrix[i][j - 1] + 1,     // 插入
                    matrix[i - 1][j] + 1      // 删除
                );
            }
        }
    }

    return matrix[str2.length][str1.length];
}

/**
 * 增强版查找（带日志和回退）
 * @param {string} target
 * @returns {Element|null}
 */
function findElementWithLogging(target) {
    const strategies = [
        { name: 'vcp-id', fn: () => document.querySelector(`[vcp-id="${target}"]`) },
        { name: 'aria-label', fn: () => document.querySelector(`[aria-label="${target}"]`) },
        { name: 'xpath', fn: () => (target.startsWith('/') || target.startsWith('//')) ? findByXPath(target) : null },
        { name: 'css-selector', fn: () => {
            if (target.includes('#') || target.includes('.') || target.includes('[')) {
                try { return document.querySelector(target); } catch { return null; }
            }
            return null;
        }},
        { name: 'fuzzy-text', fn: () => findByFuzzyText(target) },
        { name: 'name', fn: () => document.querySelector(`[name="${target}"]`) },
        { name: 'id', fn: () => document.getElementById(target) },
        { name: 'placeholder', fn: () => document.querySelector(`[placeholder="${target}"]`) },
        { name: 'title', fn: () => document.querySelector(`[title="${target}"]`) },
    ];

    for (const strategy of strategies) {
        try {
            const element = strategy.fn();
            if (element) {
                console.log(`✅ Found element using strategy: ${strategy.name}`, element);
                return element;
            }
        } catch (e) {
            console.warn(`⚠️ Strategy ${strategy.name} failed:`, e);
        }
    }

    console.error(`❌ Could not find element: ${target}`);
    return null;
}

function sendPageInfoUpdate() {
    // 关键检查：只有活动标签页才发送更新
    if (!isActiveTab && !document.hidden) {
        console.log('[VCP Content] ⚠️ 当前非活动标签页，跳过更新');
        return;
    }
    
    const currentPageContent = pageToMarkdown();
    if (currentPageContent && currentPageContent !== lastPageContent) {
        lastPageContent = currentPageContent;
        console.log('[VCP Content] 📤 发送页面信息到background (活动标签页)');
        chrome.runtime.sendMessage({
            type: 'PAGE_INFO_UPDATE',
            data: { markdown: currentPageContent }
        }, () => {
            if (chrome.runtime.lastError) {
                // console.log("[VCP Content] Page info update failed, context likely invalidated.");
            } else {
                console.log('[VCP Content] ✅ 页面信息已发送');
            }
        });
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'CLEAR_STATE') {
        lastPageContent = '';
        isActiveTab = false; // 重置活动状态
    } else if (request.type === 'REQUEST_PAGE_INFO_UPDATE') {
        // 收到请求说明这是活动标签页
        console.log('[VCP Content] 📍 收到更新请求，标记为活动标签页');
        isActiveTab = true;
        sendPageInfoUpdate();
    } else if (request.type === 'FORCE_PAGE_UPDATE') {
        // 新增：强制更新页面信息（手动刷新）
        console.log('[VCP Content] 🔄 收到强制更新请求');
        lastPageContent = ''; // 清除缓存，强制重新生成
        const currentPageContent = pageToMarkdown();
        if (currentPageContent) {
            lastPageContent = currentPageContent;
            console.log('[VCP Content] 📤 发送强制更新的页面信息');
            chrome.runtime.sendMessage({
                type: 'PAGE_INFO_UPDATE',
                data: { markdown: currentPageContent }
            }, () => {
                if (chrome.runtime.lastError) {
                    console.log("[VCP Content] ❌ 强制更新失败:", chrome.runtime.lastError.message);
                    sendResponse({ success: false });
                } else {
                    console.log("[VCP Content] ✅ 强制更新成功");
                    sendResponse({ success: true });
                }
            });
        } else {
            console.log('[VCP Content] ❌ 无法获取页面内容');
            sendResponse({ success: false, error: '无法获取页面内容' });
        }
        return true; // 保持消息通道开放
    } else if (request.type === 'EXECUTE_COMMAND') {
        const { command, target, text, requestId, sourceClientId } = request.data;
        let result = {};

        try {
            let element = findElementWithLogging(target);

            if (!element) {
                throw new Error(`未能在页面上找到目标为 '${target}' 的元素。`);
            }

            if (command === 'type') {
                if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
                    element.value = text;
                    result = { status: 'success', message: `成功在ID为 '${target}' 的元素中输入文本。` };
                } else {
                    throw new Error(`ID为 '${target}' 的元素不是一个输入框。`);
                }
            } else if (command === 'click') {
                // 模拟真实用户点击，这对于处理使用现代前端框架（如React, Vue）构建的页面至关重要
                element.focus(); // 首先聚焦元素
                const clickEvent = new MouseEvent('click', {
                    bubbles: true,
                    cancelable: true,
                    view: window
                });
                element.dispatchEvent(clickEvent);
                result = { status: 'success', message: `成功点击了ID为 '${target}' 的元素。` };
            } else {
                throw new Error(`不支持的命令: ${command}`);
            }
        } catch (error) {
            result = { status: 'error', error: error.message };
        }

        chrome.runtime.sendMessage({
            type: 'COMMAND_RESULT',
            data: {
                requestId,
                sourceClientId,
                ...result
            }
        }, () => {
            // 捕获当页面跳转等原因导致上下文失效时的错误，这是正常现象
            if (chrome.runtime.lastError) {
                console.log("Could not send command result, context likely invalidated:", chrome.runtime.lastError.message);
            }
        });
        setTimeout(sendPageInfoUpdate, 500);
    }
});

const debouncedSendPageInfoUpdate = debounce(sendPageInfoUpdate, 500); // 降低延迟，提高响应速度

const observer = new MutationObserver((mutations) => {
    debouncedSendPageInfoUpdate();
});
observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true
});

document.addEventListener('click', debouncedSendPageInfoUpdate);
document.addEventListener('focusin', debouncedSendPageInfoUpdate);
document.addEventListener('scroll', debouncedSendPageInfoUpdate, true); // 监听滚动事件

window.addEventListener('load', () => {
    // 页面加载时检查是否为活动标签页
    isActiveTab = !document.hidden;
    console.log('[VCP Content] 📄 页面加载完成，活动状态:', isActiveTab);
    if (isActiveTab) {
        sendPageInfoUpdate();
    }
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        console.log('[VCP Content] 👁️ 标签页变为可见，标记为活动');
        isActiveTab = true;
        sendPageInfoUpdate();
    } else {
        console.log('[VCP Content] 🙈 标签页变为隐藏，取消活动标记');
        isActiveTab = false;
    }
});

// 定期更新，但只在活动标签页时发送
setInterval(() => {
    if (isActiveTab && !document.hidden) {
        sendPageInfoUpdate();
    }
}, 5000);

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}
