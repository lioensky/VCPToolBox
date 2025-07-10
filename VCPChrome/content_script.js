let lastPageContent = '';
let vcpIdCounter = 0;

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
        const ignoredTags = ['SCRIPT', 'STYLE', 'NAV', 'FOOTER', 'ASIDE', 'IFRAME', 'NOSCRIPT'];
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
    if (inputElement.id) {
        const label = document.querySelector(`label[for="${inputElement.id}"]`);
        if (label) return label.innerText.trim();
    }
    const parentLabel = inputElement.closest('label');
    if (parentLabel) return parentLabel.innerText.trim();
    return null;
}

function sendPageInfoUpdate() {
    const currentPageContent = pageToMarkdown();
    if (currentPageContent && currentPageContent !== lastPageContent) {
        lastPageContent = currentPageContent;
        chrome.runtime.sendMessage({
            type: 'PAGE_INFO_UPDATE',
            data: { markdown: currentPageContent }
        }, () => {
            // 检查 chrome.runtime.lastError 以优雅地处理上下文失效的错误
            if (chrome.runtime.lastError) {
                // console.log("Page info update failed, context likely invalidated.");
            }
        });
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'CLEAR_STATE') {
        lastPageContent = '';
    } else if (request.type === 'REQUEST_PAGE_INFO_UPDATE') {
        sendPageInfoUpdate();
    } else if (request.type === 'EXECUTE_COMMAND') {
        const { command, target, text, requestId, sourceClientId } = request.data;
        let result = {};

        try {
            let element = document.querySelector(`[vcp-id="${target}"]`);

            if (!element) {
                const allInteractiveElements = document.querySelectorAll('[vcp-id]');
                for (const el of allInteractiveElements) {
                    const elText = (el.innerText || el.value || el.placeholder || el.ariaLabel || el.title || '').trim().replace(/\s+/g, ' ');
                    if (elText === target) {
                        element = el;
                        break;
                    }
                }
            }

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

window.addEventListener('load', sendPageInfoUpdate);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        sendPageInfoUpdate();
    }
});

setInterval(sendPageInfoUpdate, 5000);

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