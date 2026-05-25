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

    const tagName = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    
    // 对于输入类元素，使用专门的文本获取逻辑
    const isInputElement = (tagName === 'input' || tagName === 'textarea' ||
                           role === 'combobox' || role === 'searchbox' || role === 'textbox');
    
    let text;
    if (isInputElement) {
        // 输入元素：优先级 placeholder > aria-label > title > name > id > value
        text = (el.placeholder || el.ariaLabel || el.title || el.name || el.id || el.value || '').trim().replace(/\s+/g, ' ');
    } else {
        // 非输入元素：保持原有逻辑
        text = (el.innerText || el.value || el.placeholder || el.ariaLabel || el.title || '').trim().replace(/\s+/g, ' ');
    }

    if (role === 'combobox' || role === 'searchbox') {
        const label = findLabelForInput(el);
        return `[搜索框: ${label || text || '搜索'}](${vcpId})`;
    }

    if (tagName === 'a' && el.href) {
        return `[链接: ${text || '无标题链接'}](${vcpId})`;
    }

    if (tagName === 'button' || role === 'button' || (tagName === 'input' && ['button', 'submit', 'reset'].includes(el.type))) {
        return `[按钮: ${text || '无标题按钮'}](${vcpId})`;
    }

    if (tagName === 'input' && !['button', 'submit', 'reset', 'hidden'].includes(el.type)) {
        const label = findLabelForInput(el);
        // 根据input类型决定显示名称
        const inputType = el.type || 'text';
        const typeName = inputType === 'search' ? '搜索框' : '输入框';
        return `[${typeName}: ${label || text || el.name || el.id || '无标题输入框'}](${vcpId})`;
    }

    if (tagName === 'textarea') {
        const label = findLabelForInput(el);
        // 检查是否可能是搜索框（通过 placeholder 或其他属性判断）
        const isSearchBox = /搜索|search/i.test(text) || /搜索|search/i.test(el.className);
        const typeName = isSearchBox ? '搜索框' : '输入框';
        return `[${typeName}: ${label || text || el.name || el.id || '文本输入'}](${vcpId})`;
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

function parseBooleanParam(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
    }
    return Boolean(value);
}

function parseNumberParam(value, defaultValue, minValue, maxValue) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return defaultValue;
    return Math.min(Math.max(parsed, minValue), maxValue);
}

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSearchRegex(query, useRegex, caseSensitive) {
    if (!query || !String(query).trim()) {
        throw new Error('page_code_search 缺少 query 参数');
    }

    const flags = caseSensitive ? 'g' : 'gi';
    return new RegExp(useRegex ? query : escapeRegExp(String(query)), flags);
}

function getElementDescriptor(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
        return 'unknown';
    }

    const tagName = element.tagName.toLowerCase();
    const idPart = element.id ? `#${element.id}` : '';
    const classPart = element.className && typeof element.className === 'string'
        ? '.' + element.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.')
        : '';
    const textPart = (element.innerText || element.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);

    return `${tagName}${idPart}${classPart}${textPart ? ` :: ${textPart}` : ''}`;
}

function normalizeSearchScope(scope) {
    if (!scope) {
        return ['dom', 'inline_script', 'style', 'codeblock'];
    }

    return String(scope)
        .split(',')
        .map(item => item.trim().toLowerCase())
        .filter(Boolean);
}

function collectSearchSources(scopeList) {
    const sources = [];

    if (scopeList.includes('dom')) {
        sources.push({
            sourceType: 'dom',
            sourceLabel: 'document.documentElement.outerHTML',
            content: document.documentElement?.outerHTML || '',
            selector: 'html'
        });
    }

    if (scopeList.includes('inline_script') || scopeList.includes('script')) {
        document.querySelectorAll('script').forEach((script, index) => {
            if (!script.src && script.textContent && script.textContent.trim()) {
                sources.push({
                    sourceType: 'inline_script',
                    sourceLabel: `inline_script[${index}]`,
                    content: script.textContent,
                    selector: getElementDescriptor(script)
                });
            }
        });
    }

    if (scopeList.includes('style')) {
        document.querySelectorAll('style').forEach((styleEl, index) => {
            if (styleEl.textContent && styleEl.textContent.trim()) {
                sources.push({
                    sourceType: 'style',
                    sourceLabel: `style[${index}]`,
                    content: styleEl.textContent,
                    selector: getElementDescriptor(styleEl)
                });
            }
        });
    }

    if (scopeList.includes('codeblock') || scopeList.includes('code') || scopeList.includes('pre')) {
        document.querySelectorAll('pre, code').forEach((codeEl, index) => {
            const content = codeEl.innerText || codeEl.textContent || '';
            if (content.trim()) {
                sources.push({
                    sourceType: 'codeblock',
                    sourceLabel: `${codeEl.tagName.toLowerCase()}[${index}]`,
                    content,
                    selector: getElementDescriptor(codeEl)
                });
            }
        });
    }

    return sources;
}

function searchInSource(source, regex, contextChars, maxResultsPerSource) {
    const results = [];
    const content = source.content || '';
    if (!content) return results;

    regex.lastIndex = 0;
    let match;

    while ((match = regex.exec(content)) !== null) {
        const matchText = match[0];
        const start = match.index;
        const end = start + matchText.length;
        const contextStart = Math.max(0, start - contextChars);
        const contextEnd = Math.min(content.length, end + contextChars);

        results.push({
            sourceType: source.sourceType,
            sourceLabel: source.sourceLabel,
            selector: source.selector,
            matchText,
            contextBefore: content.slice(contextStart, start),
            contextAfter: content.slice(end, contextEnd),
            position: {
                start,
                end
            }
        });

        if (results.length >= maxResultsPerSource) {
            break;
        }

        if (match.index === regex.lastIndex) {
            regex.lastIndex++;
        }
    }

    return results;
}

function pageCodeSearch(params = {}) {
    const requestedMode = String(params.searchMode || 'auto').toLowerCase();
    const effectiveMode = requestedMode === 'enhanced' ? 'light' : (requestedMode === 'light' ? 'light' : 'auto');
    const useRegex = parseBooleanParam(params.useRegex, false);
    const caseSensitive = parseBooleanParam(params.caseSensitive, false);
    const contextChars = parseNumberParam(params.contextChars, 80, 0, 500);
    const maxResults = parseNumberParam(params.maxResults, 20, 1, 200);
    const scopeList = normalizeSearchScope(params.scope);
    const regex = buildSearchRegex(params.query, useRegex, caseSensitive);
    const sources = collectSearchSources(scopeList);
    const results = [];
    const maxResultsPerSource = Math.max(5, Math.ceil(maxResults / Math.max(sources.length, 1)));

    for (const source of sources) {
        const sourceResults = searchInSource(source, regex, contextChars, maxResultsPerSource);
        for (const item of sourceResults) {
            results.push(item);
            if (results.length >= maxResults) {
                break;
            }
        }
        if (results.length >= maxResults) {
            break;
        }
    }

    return {
        status: 'success',
        result: {
            query: params.query,
            requestedMode,
            effectiveMode,
            fallbackApplied: requestedMode === 'enhanced',
            searchedSources: sources.map(source => ({
                sourceType: source.sourceType,
                sourceLabel: source.sourceLabel,
                selector: source.selector
            })),
            totalMatches: results.length,
            truncated: results.length >= maxResults,
            results
        },
        message: requestedMode === 'enhanced'
            ? 'enhanced 模式暂未接入资源级搜索，已自动降级为 light 模式'
            : '页面源码搜索完成'
    };
}

function sendPageInfoUpdate() {
    // 关键检查：只有活动标签页才发送更新（或页面刚加载完成时）
    if (!isActiveTab && document.hidden) {
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
        const { command, target, text, requestId, sourceClientId, query, scope, useRegex, caseSensitive, contextChars, maxResults, searchMode } = request.data;
        
        const handleCommand = async () => {
            let result = {};
            try {
                if (command === 'query_html') {
                    const element = target ? findElementWithLogging(target) : document.body;
                    if (!element) throw new Error(`未找到目标元素: ${target}`);
                    result = { status: 'success', result: element.outerHTML };
                } else if (command === 'query_js') {
                    const scripts = Array.from(document.scripts).map(s => ({
                        src: s.src || 'inline',
                        content: s.src ? null : s.textContent.substring(0, 500) + (s.textContent.length > 500 ? '...' : '')
                    }));
                    result = { status: 'success', result: scripts };
                } else if (command === 'page_code_search') {
                    result = pageCodeSearch({
                        query,
                        scope,
                        useRegex,
                        caseSensitive,
                        contextChars,
                        maxResults,
                        searchMode
                    });
                } else if (command === 'execute_script') {
                    throw new Error('execute_script 已迁移到 background 的 chrome.scripting MAIN world 执行路径');
                } else {
                    let element = findElementWithLogging(target);
                    if (!element) throw new Error(`未能在页面上找到目标为 '${target}' 的元素。`);

                    if (command === 'type') {
                        if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
                            element.value = text;
                            result = { status: 'success', message: `成功在ID为 '${target}' 的元素中输入文本。` };
                        } else {
                            throw new Error(`ID为 '${target}' 的元素不是一个输入框。`);
                        }
                    } else if (command === 'click') {
                        element.focus();
                        const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
                        element.dispatchEvent(clickEvent);
                        result = { status: 'success', message: `成功点击了ID为 '${target}' 的元素。` };
                    } else {
                        throw new Error(`不支持的命令: ${command}`);
                    }
                }
            } catch (error) {
                result = { status: 'error', error: error.message };
            }

            chrome.runtime.sendMessage({
                type: 'COMMAND_RESULT',
                data: { requestId, sourceClientId, ...result }
            }, () => {
                if (chrome.runtime.lastError) {
                    console.log("Could not send command result:", chrome.runtime.lastError.message);
                }
            });
            setTimeout(sendPageInfoUpdate, 500);
        };

        handleCommand();
        return true;
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
    // 页面加载完成后总是尝试发送一次更新
    sendPageInfoUpdate();
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        console.log('[VCP Content] 👁️ 标签页变为可见，标记为活动');
        isActiveTab = true;
        // 立即验证并发送更新
        chrome.runtime.sendMessage({ type: 'VERIFY_ACTIVE_TAB' }, (response) => {
            if (chrome.runtime.lastError) {
                console.log('[VCP Content] ⚠️ 验证活动状态失败:', chrome.runtime.lastError.message);
                return;
            }
            if (response && response.isActive) {
                console.log('[VCP Content] ✅ 确认为活动标签页，清除缓存并发送更新');
                lastPageContent = ''; // 清除缓存确保发送最新内容
                sendPageInfoUpdate();
            } else {
                console.log('[VCP Content] ⚠️ 非活动标签页，不发送更新');
                isActiveTab = false;
            }
        });
    } else {
        console.log('[VCP Content] 🙈 标签页变为隐藏，取消活动标记');
        isActiveTab = false;
    }
});

// 新增：窗口获得焦点时也检查并更新
window.addEventListener('focus', () => {
    console.log('[VCP Content] 🎯 窗口获得焦点，验证活动状态');
    chrome.runtime.sendMessage({ type: 'VERIFY_ACTIVE_TAB' }, (response) => {
        if (chrome.runtime.lastError) return;
        if (response && response.isActive && !isActiveTab) {
            console.log('[VCP Content] ✅ 焦点事件确认为活动标签页');
            isActiveTab = true;
            lastPageContent = '';
            sendPageInfoUpdate();
        }
    });
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
