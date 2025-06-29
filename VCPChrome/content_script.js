
let lastPageContent = '';
let vcpIdCounter = 0;

function pageToMarkdown() {
    try {
        vcpIdCounter = 0; // Reset counter for each new scrape
        const body = document.body;
        if (!body) {
            return '';
        }

        let markdown = `# ${document.title}\n\n`;

        function processNode(node) {
            try {
                let textContent = '';
                const ignoredTags = ['SCRIPT', 'STYLE', 'NAV', 'FOOTER', 'ASIDE', 'FORM', 'IFRAME'];
                if (node.nodeType === Node.ELEMENT_NODE && ignoredTags.includes(node.tagName)) {
                    return '';
                }

                if (node.nodeType === Node.ELEMENT_NODE) {
                    const style = window.getComputedStyle(node);
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                        return '';
                    }
                }

                if (node.nodeType === Node.TEXT_NODE) {
                    const cleanedText = node.textContent.trim().replace(/\s+/g, ' ');
                    if (cleanedText) {
                        textContent += cleanedText + ' ';
                    }
                } else if (node.nodeType === Node.ELEMENT_NODE) {
                    const tagName = node.tagName.toLowerCase();
                    let childText = '';

                    if (['a', 'button', 'input', 'textarea', 'select'].includes(tagName) || node.hasAttribute('role')) {
                        const interactiveMd = formatInteractiveElement(node);
                        if (interactiveMd) {
                            return interactiveMd + '\n';
                        }
                    }

                    node.childNodes.forEach(child => {
                        childText += processNode(child);
                    });

                    if (childText.trim()) {
                        if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tagName)) {
                            const level = parseInt(tagName.charAt(1));
                            textContent += `${'#'.repeat(level)} ${childText.trim()}\n\n`;
                        } else if (tagName === 'p' || tagName === 'div' || tagName === 'span' || tagName === 'li') {
                            textContent += childText.trim() + '\n';
                        } else {
                            textContent += childText;
                        }
                    }
                }
                return textContent;
            } catch (e) {
                // In production, we might want to silently fail or log minimally
                return `[Error processing node: ${e.message}]`;
            }
        }

        markdown += processNode(body);
        markdown = markdown.replace(/(\n\s*){3,}/g, '\n\n').trim();
        return markdown;
    } catch (e) {
        return `# ${document.title}\n\n[Error processing page: ${e.message}]`;
    }
}


function formatInteractiveElement(el) {
    vcpIdCounter++;
    const vcpId = `vcp-id-${vcpIdCounter}`;
    el.setAttribute('vcp-id', vcpId);

    let text = (el.innerText || el.value || el.placeholder || el.ariaLabel || el.title || '').trim().replace(/\s+/g, ' ');
    const tagName = el.tagName.toLowerCase();

    if (tagName === 'a' && text && el.href) {
        return `[链接: ${text}](${vcpId})`;
    } else if (tagName === 'button' || el.getAttribute('role') === 'button' || (tagName === 'input' && ['button', 'submit'].includes(el.type))) {
        if (!text) text = "无标题按钮";
        return `[按钮: ${text}](${vcpId})`;
    } else if (tagName === 'input' || tagName === 'textarea') {
        const label = findLabelForInput(el);
        if (!text && label) text = label;
        if (!text) text = el.name || el.id || '无标题输入框';
        return `[输入框: ${text}](${vcpId})`;
    } else if (tagName === 'select') {
        const label = findLabelForInput(el);
        if (!text && label) text = label;
        if (!text) text = el.name || el.id || '无标题下拉框';
        return `[下拉选择: ${text}](${vcpId})`;
    }
    vcpIdCounter--;
    el.removeAttribute('vcp-id');
    return null;
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
                element.click();
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

const debouncedSendPageInfoUpdate = debounce(sendPageInfoUpdate, 1000);

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