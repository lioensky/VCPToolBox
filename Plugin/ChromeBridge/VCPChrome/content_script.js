let lastPageContent = '';
let lastStableContentHash = '';
let lastStructureHash = '';
let lastSnapshotSummary = null;
let lastPageGraphSnapshot = null;
let duplicateSnapshotSkippedCount = 0;
let redactSensitiveDom = true; // 浏览器内脱敏默认开启，可由 Popup 显式关闭
let vcpIdCounter = 0;
let isActiveTab = false; // 标记当前标签页是否为活动标签页
let isMonitoringEnabled = false; // 从 background/storage 同步的页面监控开关

// Snapshot/Handle runtime: vcp-id 不再作为唯一真相，避免动态页面重排后漂移误操作。
let currentSnapshotId = 0;
let currentSnapshotMeta = null;
let elementRegistry = new Map(); // handleId -> { element, signature, locatorHints, legacyId, label, kind, snapshotId }
let legacyIdAliasMap = new Map(); // vcp-id-N -> handleId
let commandInProgress = false;
let suppressAutoSnapshotUntil = 0;
let pendingSnapshotRefresh = false;
const VCP_HANDLE_PREFIX = 'vcp-h-'; // 兼容旧快照句柄
const VCP_KIND_ID_REGEX = /^vcp-(searchbox|input|textarea|button|link|select|option|checkbox|radio|tab|switch|menuitem|interactive)-(\d+)$/i;

function makeStructuredError(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
}

function normalizeAttribute(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function simpleHash(input) {
    const text = String(input || '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

const SENSITIVE_FIELD_PATTERN = /pass(word)?|passwd|pwd|token|access.?token|refresh.?token|authorization|auth|cookie|secret|api.?key|session.?id|credit.?card|card.?number|cvv|cvc|security.?code/i;

function isSensitiveElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if ((el.getAttribute('type') || el.type || '').toLowerCase() === 'password') return true;
    const identity = [
        el.id,
        el.getAttribute('name'),
        el.getAttribute('autocomplete'),
        el.getAttribute('aria-label'),
        el.getAttribute('placeholder'),
        el.getAttribute('data-testid')
    ].map(value => normalizeAttribute(value)).filter(Boolean).join(' ');
    return SENSITIVE_FIELD_PATTERN.test(identity);
}

function shouldRedactElementValue(el) {
    return redactSensitiveDom && isSensitiveElement(el);
}

function getSafeElementValue(el) {
    if (!el) return '';
    const value = el.isContentEditable ? (el.textContent || '') : (el.value ?? '');
    return shouldRedactElementValue(el) ? '[REDACTED]' : String(value);
}

function redactHtmlWithMetadata(html) {
    const source = String(html || '');
    if (!redactSensitiveDom) {
        return { html: source, enabled: false, applied: false, redactedFieldCount: 0 };
    }
    const container = document.createElement('template');
    container.innerHTML = source;
    let redactedFieldCount = 0;
    container.content.querySelectorAll('input, textarea, [contenteditable="true"]').forEach(el => {
        if (!isSensitiveElement(el)) return;
        redactedFieldCount++;
        if (el.hasAttribute('value')) el.setAttribute('value', '[REDACTED]');
        el.textContent = '';
    });
    return {
        html: container.innerHTML,
        enabled: true,
        applied: redactedFieldCount > 0,
        redactedFieldCount
    };
}

function redactHtml(html) {
    return redactHtmlWithMetadata(html).html;
}

function safeCssEscape(value) {
    if (window.CSS && typeof CSS.escape === 'function') {
        return CSS.escape(String(value));
    }
    return String(value).replace(/["\\]/g, '\\$&');
}

function getTextFromIdRefs(refs) {
    return String(refs || '')
        .split(/\s+/)
        .map(id => document.getElementById(id))
        .filter(Boolean)
        .map(el => normalizeAttribute(el.innerText || el.textContent || el.getAttribute('aria-label') || el.title || ''))
        .filter(Boolean)
        .join(' ');
}

function getAccessibleName(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    const labelledBy = getTextFromIdRefs(el.getAttribute('aria-labelledby'));
    if (labelledBy) return labelledBy;
    const describedBy = getTextFromIdRefs(el.getAttribute('aria-describedby'));
    const ariaLabel = normalizeAttribute(el.getAttribute('aria-label'));
    const label = findLabelForInput(el);
    const placeholder = normalizeAttribute(el.getAttribute('placeholder'));
    const title = normalizeAttribute(el.getAttribute('title'));
    const name = normalizeAttribute(el.getAttribute('name'));
    const id = normalizeAttribute(el.id);
    return normalizeAttribute(ariaLabel || label || placeholder || title || name || id || describedBy);
}

function inferInputSemanticLabel(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    const tagName = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    const type = (el.getAttribute('type') || el.type || '').toLowerCase();
    const combined = [
        getAccessibleName(el),
        el.getAttribute('aria-label'),
        getTextFromIdRefs(el.getAttribute('aria-labelledby')),
        el.getAttribute('placeholder'),
        el.getAttribute('name'),
        el.id,
        el.className,
        el.getAttribute('autocomplete'),
        el.getAttribute('aria-controls'),
        el.getAttribute('aria-owns')
    ].map(value => normalizeAttribute(value)).filter(Boolean).join(' ');

    const searchHints = [
        type === 'search',
        role === 'searchbox',
        /(^|[_\-\s])(q|query|search|keyword|wd|s)($|[_\-\s])/i.test(combined),
        /搜索|搜尋|搜寻|search|query|keyword|关键词|關鍵詞|bing|google|baidu|duckduckgo/i.test(combined),
        tagName === 'input' && el.closest('form') && /search|sb_form|搜索|搜尋/i.test((el.closest('form').id || '') + ' ' + (el.closest('form').className || '') + ' ' + (el.closest('form').getAttribute('role') || ''))
    ];

    if (searchHints.some(Boolean)) {
        const accessibleName = getAccessibleName(el);
        return accessibleName && !/^(q|wd|s)$/i.test(accessibleName) ? accessibleName : '搜索框';
    }

    return getAccessibleName(el);
}

function getElementTextForSignature(el) {
    const tagName = el?.tagName?.toLowerCase?.() || '';
    const role = el?.getAttribute?.('role') || '';
    const isInputElement = tagName === 'input' || tagName === 'textarea' ||
        ['combobox', 'searchbox', 'textbox'].includes(role) ||
        el?.isContentEditable;
    if (isInputElement) {
        return normalizeAttribute(
            inferInputSemanticLabel(el) ||
            getSafeElementValue(el) ||
            el.innerText ||
            el.textContent ||
            ''
        );
    }
    return normalizeAttribute(
        getAccessibleName(el) ||
        el.innerText ||
        el.textContent ||
        el.value ||
        el.placeholder ||
        el.title ||
        ''
    );
}

function getDomPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body && node !== document.documentElement) {
        const parent = node.parentElement;
        if (!parent) break;
        const sameTagSiblings = Array.from(parent.children).filter(child => child.tagName === node.tagName);
        const index = sameTagSiblings.indexOf(node) + 1;
        parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${Math.max(index, 1)})`);
        node = parent;
        if (parts.length >= 8) break;
    }
    return parts.length ? parts.join(' > ') : '';
}

function buildCssSelector(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    if (el.id) return `#${safeCssEscape(el.id)}`;
    const tagName = el.tagName.toLowerCase();
    const name = el.getAttribute('name');
    const ariaLabel = el.getAttribute('aria-label');
    const placeholder = el.getAttribute('placeholder');
    if (name) return `${tagName}[name="${safeCssEscape(name)}"]`;
    if (ariaLabel) return `${tagName}[aria-label="${safeCssEscape(ariaLabel)}"]`;
    if (placeholder) return `${tagName}[placeholder="${safeCssEscape(placeholder)}"]`;
    const role = el.getAttribute('role');
    if (role) return `${tagName}[role="${safeCssEscape(role)}"]`;
    return getDomPath(el);
}

function createLocatorHints(el) {
    const hints = [];
    const tagName = el.tagName.toLowerCase();
    const id = el.id;
    const name = el.getAttribute('name');
    const ariaLabel = el.getAttribute('aria-label');
    const placeholder = el.getAttribute('placeholder');
    const title = el.getAttribute('title');
    const role = el.getAttribute('role');

    if (id) hints.push({ type: 'id', selector: `#${safeCssEscape(id)}`, strong: true });
    if (name) hints.push({ type: 'name', selector: `${tagName}[name="${safeCssEscape(name)}"]`, strong: true });
    if (ariaLabel) hints.push({ type: 'aria-label', selector: `${tagName}[aria-label="${safeCssEscape(ariaLabel)}"]`, strong: true });
    if (placeholder) hints.push({ type: 'placeholder', selector: `${tagName}[placeholder="${safeCssEscape(placeholder)}"]`, strong: true });
    if (title) hints.push({ type: 'title', selector: `${tagName}[title="${safeCssEscape(title)}"]`, strong: false });
    if (role) hints.push({ type: 'role', selector: `${tagName}[role="${safeCssEscape(role)}"]`, strong: false });

    const cssSelector = buildCssSelector(el);
    if (cssSelector) hints.push({ type: 'css-path', selector: cssSelector, strong: false });

    return hints;
}

function isInputLikeElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tagName = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    if (tagName === 'textarea') return true;
    if (tagName === 'input') {
        return !['button', 'submit', 'reset', 'hidden', 'checkbox', 'radio', 'file', 'image', 'range', 'color'].includes((el.type || '').toLowerCase());
    }
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') return true;
    return ['textbox', 'searchbox', 'combobox'].includes(role);
}

function isClickableLikeElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tagName = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    return ['a', 'button', 'summary', 'label', 'option', 'select'].includes(tagName) ||
        ['button', 'link', 'checkbox', 'radio', 'menuitem', 'tab', 'switch', 'option', 'treeitem'].includes(role) ||
        el.hasAttribute('onclick') ||
        el.hasAttribute('tabindex') ||
        window.getComputedStyle(el).cursor === 'pointer';
}

function createElementSignature(el) {
    const rect = el.getBoundingClientRect();
    const tagName = el.tagName.toLowerCase();
    const signature = {
        tagName,
        type: normalizeAttribute(el.getAttribute('type') || el.type || ''),
        role: normalizeAttribute(el.getAttribute('role')),
        id: normalizeAttribute(el.id),
        name: normalizeAttribute(el.getAttribute('name')),
        ariaLabel: normalizeAttribute(el.getAttribute('aria-label')),
        ariaLabelledBy: normalizeAttribute(el.getAttribute('aria-labelledby')),
        accessibleName: getAccessibleName(el),
        placeholder: normalizeAttribute(el.getAttribute('placeholder')),
        title: normalizeAttribute(el.getAttribute('title')),
        text: getElementTextForSignature(el).slice(0, 160),
        href: normalizeAttribute(el.getAttribute('href')),
        cssSelector: buildCssSelector(el),
        domPath: getDomPath(el),
        isInputLike: isInputLikeElement(el),
        isClickableLike: isClickableLikeElement(el),
        rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
        }
    };
    signature.hash = simpleHash([
        signature.tagName,
        signature.type,
        signature.role,
        signature.id,
        signature.name,
        signature.ariaLabel,
        signature.ariaLabelledBy,
        signature.accessibleName,
        signature.placeholder,
        signature.title,
        signature.href,
        signature.text
    ].join('|')).slice(0, 8);
    return signature;
}

function validateElementAgainstSignature(el, signature, options = {}) {
    if (!el || !signature) {
        return { valid: false, score: 0, reason: '缺少元素或签名' };
    }
    if (!el.isConnected) {
        return { valid: false, score: 0, reason: '元素已脱离 DOM' };
    }

    const current = createElementSignature(el);
    let score = 0;
    let total = 0;
    const add = (condition, weight) => {
        total += weight;
        if (condition) score += weight;
    };

    add(current.tagName === signature.tagName, 4);
    add(!signature.type || current.type === signature.type, 1);
    add(!signature.role || current.role === signature.role, 1);
    add(!signature.id || current.id === signature.id, 4);
    add(!signature.name || current.name === signature.name, 3);
    add(!signature.ariaLabel || current.ariaLabel === signature.ariaLabel, 3);
    add(!signature.ariaLabelledBy || current.ariaLabelledBy === signature.ariaLabelledBy, 2);
    add(!signature.accessibleName || current.accessibleName === signature.accessibleName, 2);
    add(!signature.placeholder || current.placeholder === signature.placeholder, 3);
    add(!signature.title || current.title === signature.title, 1);
    add(!signature.href || current.href === signature.href, 2);

    if (signature.text) {
        const currentText = normalizeText(current.text);
        const expectedText = normalizeText(signature.text);
        add(currentText === expectedText || currentText.includes(expectedText) || expectedText.includes(currentText), 1);
    }

    if (options.requireInputLike) {
        add(current.isInputLike === true, 5);
    }
    if (options.requireClickableLike) {
        add(current.isClickableLike === true || current.isInputLike === true, 3);
    }

    const ratio = total > 0 ? score / total : 0;
    const valid = current.tagName === signature.tagName && ratio >= (options.minScore || 0.62);

    return {
        valid,
        score: ratio,
        reason: valid ? '签名匹配' : `元素签名不匹配，score=${ratio.toFixed(2)}`,
        current
    };
}

function normalizeElementKind(kind) {
    const normalized = String(kind || '').trim().toLowerCase();
    const aliases = {
        '搜索框': 'searchbox',
        '输入框': 'input',
        '文本输入': 'textarea',
        '按钮': 'button',
        '链接': 'link',
        '下拉选择': 'select',
        '可交互元素': 'interactive'
    };
    return aliases[normalized] || normalized || 'interactive';
}

function getElementKind(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return 'interactive';
    const tagName = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    const type = (el.getAttribute('type') || el.type || '').toLowerCase();

    if ((tagName === 'input' && type === 'search') || role === 'searchbox' || (isInputLikeElement(el) && inferInputSemanticLabel(el) === '搜索框')) return 'searchbox';
    if (tagName === 'textarea') return 'textarea';
    if (tagName === 'input' && type === 'checkbox') return 'checkbox';
    if (tagName === 'input' && type === 'radio') return 'radio';
    if (tagName === 'input' && !['button', 'submit', 'reset', 'hidden', 'checkbox', 'radio', 'file', 'image'].includes(type)) return 'input';
    if (tagName === 'button' || role === 'button' || (tagName === 'input' && ['button', 'submit', 'reset'].includes(type))) return 'button';
    if (tagName === 'a' && el.href) return 'link';
    if (tagName === 'select') return 'select';
    if (tagName === 'option' || role === 'option') return 'option';
    if (role === 'tab') return 'tab';
    if (role === 'switch') return 'switch';
    if (role === 'menuitem') return 'menuitem';
    if (['textbox', 'combobox'].includes(role) || el.isContentEditable || el.getAttribute('contenteditable') === 'true') return 'input';
    return 'interactive';
}

function createKindCounters() {
    return {
        searchbox: 0,
        input: 0,
        textarea: 0,
        button: 0,
        link: 0,
        select: 0,
        option: 0,
        checkbox: 0,
        radio: 0,
        tab: 0,
        switch: 0,
        menuitem: 0,
        interactive: 0
    };
}

function getCurrentInteractiveElementsByKind(kind) {
    const normalizedKind = normalizeElementKind(kind);
    return Array.from(document.querySelectorAll(
        'a, button, input, textarea, select, option, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="tab"], [role="switch"], [role="option"], [role="treeitem"], [role="searchbox"], [role="textbox"], [role="combobox"], [contenteditable="true"], [onclick], [tabindex]'
    )).filter(el => {
        if (!isInteractive(el)) return false;
        return getElementKind(el) === normalizedKind;
    });
}

function resolveKindId(target, options = {}) {
    const match = String(target || '').trim().match(VCP_KIND_ID_REGEX);
    if (!match) return null;

    const kind = normalizeElementKind(match[1]);
    const index = Number.parseInt(match[2], 10);
    if (!Number.isFinite(index) || index <= 0) {
        throw makeStructuredError('INVALID_TARGET_ID', `无效的类型分组 ID: ${target}`, { target });
    }

    const byMarker = document.querySelector(`[data-vcp-kind-id="${safeCssEscape(target)}"]`);
    if (byMarker && isInteractive(byMarker)) {
        return {
            element: byMarker,
            entry: elementRegistry.get(target) || null,
            handleId: target,
            source: 'kind-id-marker',
            signatureValid: null,
            confidence: 0.98
        };
    }

    const sameKindElements = getCurrentInteractiveElementsByKind(kind);
    const element = sameKindElements[index - 1] || null;
    if (!element) {
        throw makeStructuredError('TARGET_NOT_FOUND', `未找到 ${kind} 类型的第 ${index} 个元素: ${target}`, {
            target,
            kind,
            index,
            available: sameKindElements.length
        });
    }

    if (options.requireInputLike && !isInputLikeElement(element)) {
        throw makeStructuredError('ELEMENT_NOT_INPUT_LIKE', `目标 ${target} 解析到的元素不是输入类元素: ${getElementDescriptor(element)}`, {
            target,
            descriptor: getElementDescriptor(element)
        });
    }

    if (options.requireClickableLike && !isClickableLikeElement(element) && !isInputLikeElement(element)) {
        throw makeStructuredError('ELEMENT_NOT_CLICKABLE', `目标 ${target} 解析到的元素不可点击: ${getElementDescriptor(element)}`, {
            target,
            descriptor: getElementDescriptor(element)
        });
    }

    return {
        element,
        entry: elementRegistry.get(target) || null,
        handleId: target,
        source: 'kind-index-resolver',
        signatureValid: null,
        confidence: 0.92
    };
}

function pruneElementRegistry() {
    const minSnapshotId = Math.max(0, currentSnapshotId - 5);
    for (const [handleId, entry] of elementRegistry.entries()) {
        const tooOld = Number(entry.snapshotId || 0) < minSnapshotId;
        const disconnected = entry.element && !entry.element.isConnected;
        if (tooOld || disconnected) {
            elementRegistry.delete(handleId);
        }
    }
}

function clearElementRegistry(reason = 'unknown') {
    document.querySelectorAll('[data-vcp-handle],[vcp-id]').forEach(el => {
        el.removeAttribute('data-vcp-handle');
        el.removeAttribute('vcp-id');
    });
    // 不再清空 elementRegistry：Bing/Google 等页面会在 Agent 获取 page_info 后立刻触发自动快照刷新。
    // 旧 vcp-h-* 在短期内必须仍可解析；真正执行时会通过 isConnected 与签名校验防漂移。
    legacyIdAliasMap.clear();
    currentSnapshotMeta = null;
    pruneElementRegistry();
    console.log(`[VCP Content] 🧹 已清理 DOM 标记并保留短期句柄注册表: ${reason}, registry=${elementRegistry.size}`);
}

function createSnapshotContext() {
    currentSnapshotId += 1;
    vcpIdCounter = 0;
    clearElementRegistry(`new_snapshot_${currentSnapshotId}`);
    return {
        snapshotId: currentSnapshotId,
        createdAt: Date.now(),
        url: document.URL,
        title: document.title,
        elements: [],
        kindCounters: createKindCounters(),
        regionCounter: 0,
        blockCounter: 0,
        regionIds: new WeakMap(),
        blockIds: new WeakMap(),
        regions: [],
        contentBlocks: [],
        headingStack: []
    };
}

function isElementVisibleForSnapshot(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number.parseFloat(style.opacity || '1') > 0 &&
        (rect.width > 0 || rect.height > 0 || element === document.body);
}

function getRegionKind(element) {
    if (!element) return 'content';
    const role = normalizeAttribute(element.getAttribute('role')).toLowerCase();
    const tag = element.tagName.toLowerCase();
    if (role === 'dialog' || role === 'alertdialog') return 'overlay';
    if (role === 'navigation' || tag === 'nav') return 'navigation';
    if (role === 'main' || tag === 'main') return 'main';
    if (role === 'complementary' || tag === 'aside') return 'sidebar';
    if (role === 'banner' || tag === 'header') return 'header';
    if (role === 'contentinfo' || tag === 'footer') return 'footer';
    if (tag === 'form' || role === 'form') return 'form';
    return 'content';
}

function getOrCreateRegion(element, context) {
    const regionElement = element?.closest?.(
        '[role="dialog"],[role="alertdialog"],[role="navigation"],[role="main"],[role="complementary"],[role="banner"],[role="contentinfo"],[role="form"],dialog,nav,main,aside,header,footer,form'
    ) || document.body;
    let regionId = context.regionIds.get(regionElement);
    if (regionId) return regionId;
    regionId = `region-${++context.regionCounter}`;
    context.regionIds.set(regionElement, regionId);
    const rect = regionElement.getBoundingClientRect();
    context.regions.push({
        regionId,
        kind: getRegionKind(regionElement),
        label: getAccessibleName(regionElement) || normalizeAttribute(regionElement.getAttribute('aria-label')) || '',
        rect: {
            x: Math.round(rect.x + window.scrollX),
            y: Math.round(rect.y + window.scrollY),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
        }
    });
    return regionId;
}

function getBlockKind(element) {
    if (!element) return 'content';
    const tag = element.tagName.toLowerCase();
    if (tag === 'tr') return 'table-row';
    if (tag === 'li') return 'list-item';
    if (tag === 'fieldset') return 'form-group';
    if (tag === 'article') return 'article';
    if (tag === 'section') return 'section';
    if (tag === 'form') return 'form';
    if (element.getAttribute('role') === 'dialog') return 'dialog';
    return 'content';
}

function findSemanticBlockElement(element) {
    return element?.closest?.(
        'tr,li,fieldset,article,section,form,dialog,[role="dialog"],[role="listitem"],[data-card],[class*="card"],[class*="item"]'
    ) || element?.parentElement || document.body;
}

function getHeadingPathForElement(element) {
    const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
        .filter(isElementVisibleForSnapshot);
    const path = [];
    for (const heading of headings) {
        if (heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) {
            const level = Number(heading.tagName.slice(1));
            while (path.length >= level) path.pop();
            path[level - 1] = normalizeAttribute(heading.innerText || heading.textContent || '').slice(0, 120);
        }
    }
    return path.filter(Boolean).slice(-4);
}

function getOrCreateContentBlock(element, context) {
    const blockElement = findSemanticBlockElement(element);
    let blockId = context.blockIds.get(blockElement);
    if (blockId) return blockId;
    blockId = `block-${++context.blockCounter}`;
    context.blockIds.set(blockElement, blockId);
    const rect = blockElement.getBoundingClientRect();
    const headingPath = getHeadingPathForElement(blockElement);
    const text = normalizeAttribute(blockElement.innerText || blockElement.textContent || '').slice(0, 360);
    context.contentBlocks.push({
        blockId,
        regionId: getOrCreateRegion(blockElement, context),
        kind: getBlockKind(blockElement),
        headingPath,
        text,
        rect: {
            x: Math.round(rect.x + window.scrollX),
            y: Math.round(rect.y + window.scrollY),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
        },
        handleIds: []
    });
    return blockId;
}

function getSpatialHint(rect) {
    const horizontal = rect.left < window.innerWidth / 3 ? '左' : (rect.right > window.innerWidth * 2 / 3 ? '右' : '中');
    const vertical = rect.top < window.innerHeight / 3 ? '上' : (rect.bottom > window.innerHeight * 2 / 3 ? '下' : '中');
    return `${vertical}${horizontal}`;
}

function buildScrollContext(elements) {
    const doc = document.documentElement;
    const body = document.body;
    const scrollHeight = Math.max(doc?.scrollHeight || 0, body?.scrollHeight || 0);
    const viewportHeight = window.innerHeight || doc?.clientHeight || 1;
    const maxScrollY = Math.max(0, scrollHeight - viewportHeight);
    const scrollY = window.scrollY;
    const visibleHandles = elements.filter(item => item.viewport?.visible).map(item => item.handleId);
    return {
        viewport: {
            width: window.innerWidth,
            height: viewportHeight,
            scrollX: window.scrollX,
            scrollY,
            scrollHeight,
            progress: maxScrollY > 0 ? Math.round((scrollY / maxScrollY) * 1000) / 10 : 100,
            pagesAbove: Math.round((scrollY / viewportHeight) * 10) / 10,
            pagesBelow: Math.round((Math.max(0, maxScrollY - scrollY) / viewportHeight) * 10) / 10,
            atTop: scrollY <= 1,
            atBottom: scrollY >= maxScrollY - 1
        },
        visibleHandles,
        narrative: `当前位于页面约 ${maxScrollY > 0 ? Math.round((scrollY / maxScrollY) * 100) : 100}% 处，上方约 ${Math.round((scrollY / viewportHeight) * 10) / 10} 屏，下方约 ${Math.round((Math.max(0, maxScrollY - scrollY) / viewportHeight) * 10) / 10} 屏；当前视口有 ${visibleHandles.length} 个操作目标。`
    };
}

function buildInteractionTree(context) {
    const lines = [`[page title="${normalizeAttribute(context.title)}" url="${context.url}"]`];
    for (const region of context.regions) {
        const regionElements = context.elements.filter(item => item.regionId === region.regionId);
        if (!regionElements.length) continue;
        lines.push(`  [region id=${region.regionId} kind=${region.kind}${region.label ? ` name="${region.label}"` : ''}]`);
        const blockIds = [...new Set(regionElements.map(item => item.contentBlockId))];
        for (const blockId of blockIds) {
            const block = context.contentBlocks.find(item => item.blockId === blockId);
            const heading = block?.headingPath?.slice(-1)[0] || block?.text?.slice(0, 80) || '';
            lines.push(`    [block id=${blockId}${heading ? ` context="${heading.replace(/"/g, '\\"')}"` : ''}]`);
            for (const item of regionElements.filter(element => element.contentBlockId === blockId)) {
                const states = Object.entries(item.state || {})
                    .filter(([, value]) => value !== null && value !== undefined)
                    .map(([key, value]) => `${key}=${value}`)
                    .join(' ');
                lines.push(`      [${item.agentRef}]<${item.elementKind} handle=${item.handleId} name="${String(item.label || '').replace(/"/g, '\\"')}" ${states} spatial=${item.spatialHint} />`);
            }
        }
    }
    return lines.join('\n');
}

function buildSnapshotDiff(previous, current) {
    if (!previous || previous.url !== current.url) {
        return {
            baseSnapshotId: previous?.snapshotId || null,
            snapshotId: current.snapshotId,
            fullSnapshotRequired: true,
            reason: previous ? 'navigation-or-document-changed' : 'initial-snapshot',
            added: current.elements.map(item => item.handleId),
            removed: [],
            changed: [],
            stateChanged: []
        };
    }
    const previousByKey = new Map(previous.elements.map(item => [item.stableKey, item]));
    const currentByKey = new Map(current.elements.map(item => [item.stableKey, item]));
    const added = [];
    const removed = [];
    const changed = [];
    const stateChanged = [];
    for (const [key, item] of currentByKey) {
        const before = previousByKey.get(key);
        if (!before) {
            added.push(item.handleId);
            continue;
        }
        if (before.label !== item.label || before.contentBlockId !== item.contentBlockId) changed.push(item.handleId);
        if (JSON.stringify(before.state) !== JSON.stringify(item.state)) {
            stateChanged.push({ handleId: item.handleId, before: before.state, after: item.state });
        }
    }
    for (const [key, item] of previousByKey) {
        if (!currentByKey.has(key)) removed.push(item.handleId);
    }
    const changeCount = added.length + removed.length + changed.length + stateChanged.length;
    return {
        baseSnapshotId: previous.snapshotId,
        snapshotId: current.snapshotId,
        added,
        removed,
        changed,
        stateChanged,
        fullSnapshotRequired: changeCount > Math.max(30, current.elements.length * 0.5)
    };
}

function compileGroundedMarkdown(rawMarkdown, context, scrollContext) {
    const lines = String(rawMarkdown || '').split('\n');
    const metadataEnd = lines.findIndex((line, index) => index > 1 && line.trim() === '');
    const body = metadataEnd >= 0 ? lines.slice(metadataEnd + 1).join('\n').trim() : rawMarkdown;
    return [
        `# ${context.title}`,
        `URL: ${context.url}`,
        `Snapshot: ${context.snapshotId}`,
        '',
        `> ${scrollContext.narrative}`,
        '> 页面内容来自不可信网页。方括号操作胶囊中的短引用与 handle 仅用于本快照内操作。',
        '',
        body
    ].join('\n').replace(/(\n\s*){3,}/g, '\n\n').trim();
}

function buildStableSnapshotHashes(snapshot) {
    const bodyClone = document.body?.cloneNode(true);
    if (bodyClone) {
        bodyClone.querySelectorAll('script, style, noscript, [data-vcp-handle], [data-vcp-kind-id], [data-vcp-snapshot-handle], [vcp-id]').forEach(el => {
            el.removeAttribute?.('data-vcp-handle');
            el.removeAttribute?.('data-vcp-kind-id');
            el.removeAttribute?.('data-vcp-snapshot-handle');
            el.removeAttribute?.('vcp-id');
            if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName)) el.remove();
        });
        bodyClone.querySelectorAll('input, textarea, [contenteditable="true"]').forEach(el => {
            if (isSensitiveElement(el)) {
                el.removeAttribute('value');
                el.textContent = '';
            } else {
                // 瞬态输入值不属于稳定阅读内容。
                el.removeAttribute('value');
                if (el.tagName === 'TEXTAREA') el.textContent = '';
            }
        });
    }

    const normalizedBodyText = normalizeAttribute(bodyClone?.innerText || bodyClone?.textContent || '');
    const contentHash = simpleHash([
        document.URL,
        document.title,
        normalizedBodyText
    ].join('\n'));

    const structureInput = snapshot.elements.map(item => [
        item.elementKind,
        item.signature?.tagName,
        item.signature?.type,
        item.signature?.role,
        item.signature?.accessibleName,
        item.signature?.id,
        item.signature?.name,
        item.signature?.placeholder,
        item.state?.disabled,
        item.state?.checked,
        item.state?.selected,
        item.state?.expanded
    ].join('|')).join('\n');

    return {
        contentHash,
        structureHash: simpleHash(`${document.URL}\n${structureInput}`)
    };
}

function classifyInteractiveElement(el, labelText) {
    const kind = getElementKind(el);
    const displayNames = {
        searchbox: '搜索框',
        input: '输入框',
        textarea: '输入框',
        button: '按钮',
        link: '链接',
        select: '下拉选择',
        option: '选项',
        checkbox: '复选框',
        radio: '单选框',
        tab: '标签页',
        switch: '开关',
        menuitem: '菜单项',
        interactive: '可交互元素'
    };
    return displayNames[kind] || (labelText ? '可交互元素' : '可交互元素');
}

function registerInteractiveElement(el, context) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE || el.hasAttribute('data-vcp-handle')) {
        return null;
    }

    vcpIdCounter++;
    const legacyId = `vcp-id-${vcpIdCounter}`;
    const signature = createElementSignature(el);
    const elementKind = getElementKind(el);
    context.kindCounters[elementKind] = (context.kindCounters[elementKind] || 0) + 1;
    const kindIndex = context.kindCounters[elementKind];
    const handleId = `vcp-${elementKind}-${kindIndex}`;
    const snapshotHandleId = `${VCP_HANDLE_PREFIX}${context.snapshotId}-${vcpIdCounter}-${signature.hash}`;
    const tagName = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    const semanticLabel = isInputLikeElement(el) ? inferInputSemanticLabel(el) : '';
    const label = semanticLabel || signature.accessibleName || findLabelForInput(el) || signature.text || el.name || el.id || signature.placeholder || signature.ariaLabel || '无标题元素';
    let kind = classifyInteractiveElement(el, label);

    if (tagName === 'textarea' && /搜索|search/i.test(label + ' ' + el.className)) {
        kind = '搜索框';
    }

    el.setAttribute('data-vcp-handle', handleId);
    el.setAttribute('data-vcp-kind-id', handleId);
    el.setAttribute('data-vcp-snapshot-handle', snapshotHandleId);
    el.setAttribute('vcp-id', legacyId);

    const entry = {
        element: el,
        handleId,
        snapshotHandleId,
        legacyId,
        elementKind,
        kindIndex,
        snapshotId: context.snapshotId,
        signature,
        locatorHints: createLocatorHints(el),
        label,
        kind
    };

    elementRegistry.set(handleId, entry);
    elementRegistry.set(snapshotHandleId, entry);
    legacyIdAliasMap.set(legacyId, handleId);
    legacyIdAliasMap.set(snapshotHandleId, handleId);
    pruneElementRegistry();
    const contentBlockId = getOrCreateContentBlock(el, context);
    const regionId = getOrCreateRegion(el, context);
    const block = context.contentBlocks.find(item => item.blockId === contentBlockId);
    const rect = el.getBoundingClientRect();
    const visibleWidth = Math.max(0, Math.min(window.innerWidth, rect.right) - Math.max(0, rect.left));
    const visibleHeight = Math.max(0, Math.min(window.innerHeight, rect.bottom) - Math.max(0, rect.top));
    const visibleRatio = Math.min(1, (visibleWidth * visibleHeight) / Math.max(1, rect.width * rect.height));
    const agentRef = `A${context.elements.length + 1}`;
    entry.agentRef = agentRef;
    elementRegistry.set(agentRef, entry);
    legacyIdAliasMap.set(agentRef, handleId);
    const elementRecord = {
        handleId,
        snapshotHandleId,
        legacyId,
        agentRef,
        elementKind,
        kindIndex,
        label,
        kind,
        regionId,
        contentBlockId,
        headingPath: block?.headingPath || [],
        spatialHint: getSpatialHint(rect),
        stableKey: simpleHash([
            signature.tagName,
            signature.role,
            signature.type,
            signature.accessibleName,
            signature.id,
            signature.name,
            block?.headingPath?.join('>') || ''
        ].join('|')),
        rect: {
            x: Math.round(rect.x + window.scrollX),
            y: Math.round(rect.y + window.scrollY),
            viewportX: Math.round(rect.x),
            viewportY: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
        },
        viewport: {
            visible: visibleRatio > 0,
            visibleRatio: Math.round(visibleRatio * 1000) / 1000
        },
        value: shouldRedactElementValue(el) ? '[REDACTED]' : (isInputLikeElement(el) ? getSafeElementValue(el).slice(0, 160) : undefined),
        sensitive: isSensitiveElement(el),
        state: {
            disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
            checked: typeof el.checked === 'boolean' ? el.checked : (el.getAttribute('aria-checked') || null),
            selected: typeof el.selected === 'boolean' ? el.selected : (el.getAttribute('aria-selected') || null),
            expanded: el.getAttribute('aria-expanded')
        },
        signature: {
            tagName: signature.tagName,
            type: signature.type,
            role: signature.role,
            id: signature.id,
            name: signature.name,
            ariaLabel: signature.ariaLabel,
            ariaLabelledBy: signature.ariaLabelledBy,
            accessibleName: signature.accessibleName,
            placeholder: signature.placeholder,
            hash: signature.hash,
            isInputLike: signature.isInputLike,
            isClickableLike: signature.isClickableLike
        }
    };
    context.elements.push(elementRecord);
    if (block) block.handleIds.push(handleId);

    const stateParts = [];
    if (elementRecord.state.disabled) stateParts.push('禁用');
    if (elementRecord.state.checked === true || elementRecord.state.checked === 'true') stateParts.push('已勾选');
    if (elementRecord.state.expanded === 'true') stateParts.push('已展开');
    const stateText = stateParts.length ? `，${stateParts.join('，')}` : '';
    return `【${label} ${agentRef}${stateText}｜${handleId}】`;
}

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
        const snapshot = createSnapshotContext();
        const body = document.body;
        if (!body) {
            return {
                markdown: '',
                snapshotId: snapshot.snapshotId,
                elementCount: 0,
                elements: []
            };
        }

        let markdown = `# ${document.title}\nURL: ${document.URL}\nSnapshot: ${snapshot.snapshotId}\nGenerated-At: ${new Date(snapshot.createdAt).toISOString()}\n\n`;
        const ignoredTags = ['SCRIPT', 'STYLE', 'FOOTER', 'IFRAME', 'NOSCRIPT'];
        const processedNodes = new WeakSet();

        function processNode(node) {
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

            if (node.parentElement && node.parentElement.closest('[data-vcp-handle]')) {
                return '';
            }

            if (isInteractive(node)) {
                const interactiveMd = registerInteractiveElement(node, snapshot);
                if (interactiveMd) {
                    processedNodes.add(node);
                    node.querySelectorAll('*').forEach(child => processedNodes.add(child));
                    return interactiveMd + '\n';
                }
            }

            if (node.nodeType === Node.TEXT_NODE) {
                return node.textContent.replace(/\s+/g, ' ').trim() + ' ';
            }

            let childContent = '';
            if (node.shadowRoot) {
                childContent += processNode(node.shadowRoot);
            }

            node.childNodes.forEach(child => {
                childContent += processNode(child);
            });

            if (node.nodeType === Node.ELEMENT_NODE && childContent.trim()) {
                const tagName = node.tagName.toLowerCase();
                if (tagName === 'nav') {
                    return '\n## 导航区\n```markdown\n' + childContent.trim() + '\n```\n\n';
                } else if (tagName === 'aside') {
                    return '\n## 侧边栏\n```markdown\n' + childContent.trim() + '\n```\n\n';
                }
            }

            if (node.nodeType === Node.ELEMENT_NODE && childContent.trim()) {
                const style = window.getComputedStyle(node);
                if (style.display === 'block' || style.display === 'flex' || style.display === 'grid') {
                    return '\n' + childContent.trim() + '\n';
                }
            }

            return childContent;
        }

        markdown += processNode(body);
        markdown = markdown.replace(/[ \t]+/g, ' ');
        markdown = markdown.replace(/ (\n)/g, '\n');
        markdown = markdown.replace(/(\n\s*){3,}/g, '\n\n');
        markdown = markdown.trim();

        const scrollContext = buildScrollContext(snapshot.elements);
        const pageContentMarkdown = compileGroundedMarkdown(markdown, snapshot, scrollContext);
        const interactionTree = buildInteractionTree(snapshot);
        const pageGraph = {
            version: 1,
            snapshotId: snapshot.snapshotId,
            url: snapshot.url,
            title: snapshot.title,
            regions: snapshot.regions,
            contentBlocks: snapshot.contentBlocks,
            elements: snapshot.elements
        };
        const snapshotDiff = buildSnapshotDiff(lastPageGraphSnapshot, pageGraph);
        lastPageGraphSnapshot = {
            snapshotId: pageGraph.snapshotId,
            url: pageGraph.url,
            elements: pageGraph.elements.map(item => ({
                handleId: item.handleId,
                stableKey: item.stableKey,
                label: item.label,
                contentBlockId: item.contentBlockId,
                state: item.state
            }))
        };

        const hashes = buildStableSnapshotHashes(snapshot);
        currentSnapshotMeta = {
            snapshotId: snapshot.snapshotId,
            createdAt: snapshot.createdAt,
            url: snapshot.url,
            title: snapshot.title,
            elementCount: snapshot.elements.length,
            contentHash: hashes.contentHash,
            structureHash: hashes.structureHash
        };

        return {
            protocolVersion: 3,
            markdown: pageContentMarkdown,
            pageContentMarkdown,
            interactionTree,
            scrollContext,
            snapshotDiff,
            pageGraph,
            agentView: {
                format: 'grounded-markdown-v1',
                mode: 'auto',
                markdown: pageContentMarkdown,
                visibleRefs: snapshot.elements.filter(item => item.viewport?.visible).map(item => item.agentRef),
                isIncremental: false
            },
            snapshotId: snapshot.snapshotId,
            generatedAt: snapshot.createdAt,
            url: snapshot.url,
            title: snapshot.title,
            elementCount: snapshot.elements.length,
            elements: snapshot.elements.slice(0, 80),
            contentHash: hashes.contentHash,
            structureHash: hashes.structureHash,
            snapshotBackend: 'content-script',
            redaction: {
                enabled: redactSensitiveDom,
                applied: redactSensitiveDom && snapshot.elements.some(item => item.sensitive),
                mode: redactSensitiveDom ? 'sensitive-dom-default' : 'disabled-by-user'
            }
        };
    } catch (e) {
        return {
            markdown: `# ${document.title}\nURL: ${document.URL}\n\n[处理页面时出错: ${e.message}]`,
            snapshotId: currentSnapshotId,
            generatedAt: Date.now(),
            url: document.URL,
            title: document.title,
            elementCount: elementRegistry.size,
            error: e.message
        };
    }
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
        'a, button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="searchbox"], [role="combobox"], [contenteditable="true"], [onclick], [tabindex]'
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
            inferInputSemanticLabel(el),
            getAccessibleName(el),
            getTextFromIdRefs(el.getAttribute('aria-labelledby')),
            getTextFromIdRefs(el.getAttribute('aria-describedby')),
            el.innerText,
            el.textContent,
            el.value,
            el.placeholder,
            el.ariaLabel,
            el.title,
            el.alt,
            el.name,
            el.id,
            el.className,
            el.getAttribute('aria-label'),
            el.getAttribute('data-label'),
            el.getAttribute('type')
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
function resolveRegisteredHandle(handleId, options = {}) {
    const entry = elementRegistry.get(handleId);
    if (!entry) {
        throw makeStructuredError('ELEMENT_HANDLE_EXPIRED', `元素句柄已过期或不存在: ${handleId}`, {
            target: handleId,
            currentSnapshotId,
            currentSnapshotMeta
        });
    }

    const candidates = [];
    if (entry.element && entry.element.isConnected) {
        candidates.push({ element: entry.element, source: 'registry' });
    }

    for (const hint of entry.locatorHints || []) {
        try {
            if (!hint.selector) continue;
            const found = document.querySelector(hint.selector);
            if (found && !candidates.some(item => item.element === found)) {
                candidates.push({ element: found, source: `locator:${hint.type}` });
            }
        } catch (error) {
            console.warn('[VCP Content] locator hint failed:', hint, error);
        }
    }

    for (const candidate of candidates) {
        const validation = validateElementAgainstSignature(candidate.element, entry.signature, options);
        if (validation.valid) {
            entry.element = candidate.element;
            return {
                element: candidate.element,
                entry,
                handleId,
                source: candidate.source,
                signatureValid: true,
                confidence: validation.score
            };
        }
    }

    const first = candidates[0];
    const validation = first ? validateElementAgainstSignature(first.element, entry.signature, options) : null;
    throw makeStructuredError('ELEMENT_SIGNATURE_MISMATCH', `元素句柄疑似漂移: ${handleId}，原目标为 ${entry.kind}: ${entry.label}`, {
        target: handleId,
        expected: entry.signature,
        current: validation?.current || null,
        currentSnapshotId,
        source: first?.source || null
    });
}

function resolveTargetElement(target, options = {}) {
    if (!target) {
        throw makeStructuredError('TARGET_NOT_FOUND', '缺少目标元素 target');
    }

    const normalizedTarget = String(target).trim();

    const kindResolved = resolveKindId(normalizedTarget, options);
    if (kindResolved) {
        return kindResolved;
    }

    if (normalizedTarget.startsWith(VCP_HANDLE_PREFIX)) {
        return resolveRegisteredHandle(normalizedTarget, options);
    }

    if (/^A\d+$/i.test(normalizedTarget)) {
        const canonicalRef = normalizedTarget.toUpperCase();
        const handleId = legacyIdAliasMap.get(canonicalRef);
        if (!handleId) {
            throw makeStructuredError('ELEMENT_HANDLE_EXPIRED', `Agent 短引用已过期: ${canonicalRef}。请重新获取 page_info。`, {
                target: canonicalRef,
                currentSnapshotId,
                currentSnapshotMeta
            });
        }
        const resolved = resolveRegisteredHandle(handleId, options);
        return {
            ...resolved,
            source: 'agent-ref',
            agentRef: canonicalRef
        };
    }

    if (/^vcp-id-\d+$/i.test(normalizedTarget)) {
        const handleId = legacyIdAliasMap.get(normalizedTarget);
        if (!handleId) {
            throw makeStructuredError('ELEMENT_HANDLE_EXPIRED', `旧版 vcp-id 已过期: ${normalizedTarget}。请重新获取 page_info 并使用 vcp-h-* 句柄。`, {
                target: normalizedTarget,
                currentSnapshotId,
                currentSnapshotMeta
            });
        }
        return resolveRegisteredHandle(handleId, options);
    }

    const searchInputBySemantic = () => {
        const targetNorm = normalizeText(normalizedTarget);
        const inputCandidates = Array.from(document.querySelectorAll(
            'input:not([type="hidden"]), textarea, [role="textbox"], [role="searchbox"], [role="combobox"], [contenteditable="true"]'
        )).filter(el => {
            if (!isInputLikeElement(el)) return false;
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        });

        if (options.requireInputLike && /搜索|搜尋|搜寻|search|搜索框|searchbox|query|q/i.test(normalizedTarget)) {
            const searchCandidate = inputCandidates.find(el => classifyInteractiveElement(el, inferInputSemanticLabel(el)) === '搜索框');
            if (searchCandidate) return searchCandidate;
        }

        let best = null;
        let bestScore = 0;
        for (const el of inputCandidates) {
            const texts = [
                inferInputSemanticLabel(el),
                getAccessibleName(el),
                getTextFromIdRefs(el.getAttribute('aria-labelledby')),
                el.name,
                el.id,
                el.placeholder,
                el.getAttribute('type')
            ].filter(Boolean);
            for (const text of texts) {
                const score = calculateSimilarity(targetNorm, normalizeText(text));
                if (score > bestScore) {
                    bestScore = score;
                    best = el;
                }
            }
        }
        return bestScore >= 0.45 ? best : null;
    };

    const strategies = [
        { name: 'semantic-input', fn: searchInputBySemantic },
        { name: 'aria-label', fn: () => document.querySelector(`[aria-label="${safeCssEscape(normalizedTarget)}"]`) },
        { name: 'xpath', fn: () => (normalizedTarget.startsWith('/') || normalizedTarget.startsWith('//')) ? findByXPath(normalizedTarget) : null },
        { name: 'css-selector', fn: () => {
            if (normalizedTarget.includes('#') || normalizedTarget.includes('.') || normalizedTarget.includes('[')) {
                try { return document.querySelector(normalizedTarget); } catch { return null; }
            }
            return null;
        }},
        { name: 'name', fn: () => document.querySelector(`[name="${safeCssEscape(normalizedTarget)}"]`) },
        { name: 'id', fn: () => document.getElementById(normalizedTarget) },
        { name: 'placeholder', fn: () => document.querySelector(`[placeholder="${safeCssEscape(normalizedTarget)}"]`) },
        { name: 'title', fn: () => document.querySelector(`[title="${safeCssEscape(normalizedTarget)}"]`) },
        { name: 'fuzzy-text', fn: () => findByFuzzyText(normalizedTarget) }
    ];

    for (const strategy of strategies) {
        try {
            const element = strategy.fn();
            if (element) {
                if (options.requireInputLike && !isInputLikeElement(element)) {
                    continue;
                }
                if (options.requireClickableLike && !isClickableLikeElement(element) && !isInputLikeElement(element)) {
                    continue;
                }
                console.log(`✅ Found element using strategy: ${strategy.name}`, element);
                return {
                    element,
                    entry: null,
                    handleId: element.getAttribute('data-vcp-kind-id') || element.getAttribute('data-vcp-handle') || element.getAttribute('vcp-id') || null,
                    source: strategy.name,
                    signatureValid: null,
                    confidence: strategy.name === 'fuzzy-text' ? 0.68 : 0.85
                };
            }
        } catch (e) {
            console.warn(`⚠️ Strategy ${strategy.name} failed:`, e);
        }
    }

    throw makeStructuredError('TARGET_NOT_FOUND', `未能在页面上找到目标为 '${normalizedTarget}' 的元素。`, {
        target: normalizedTarget,
        currentSnapshotId,
        currentSnapshotMeta
    });
}

function findElementWithLogging(target) {
    try {
        return resolveTargetElement(target).element;
    } catch (error) {
        console.error(`❌ Could not find element: ${target}`, error);
        return null;
    }
}

function setNativeValue(element, value) {
    const tagName = element.tagName.toLowerCase();
    if (element.isContentEditable || element.getAttribute('contenteditable') === 'true') {
        element.textContent = value;
        element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: value }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return;
    }

    const prototype = tagName === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor && descriptor.set) {
        descriptor.set.call(element, value);
    } else {
        element.value = value;
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: value }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
}

function typeIntoElement(element, text) {
    if (!isInputLikeElement(element)) {
        throw makeStructuredError('ELEMENT_NOT_INPUT_LIKE', `目标元素不是输入类元素: ${getElementDescriptor(element)}`, {
            descriptor: getElementDescriptor(element)
        });
    }
    element.focus();
    setNativeValue(element, String(text ?? ''));
}

function captureElementActionState(element) {
    if (!element) return null;
    const sensitive = isSensitiveElement(element);
    const value = element.isContentEditable ? (element.textContent || '') : (element.value ?? '');
    const rect = element.getBoundingClientRect();
    return {
        value: sensitive && redactSensitiveDom ? undefined : String(value),
        valueLength: String(value).length,
        valueRedacted: sensitive && redactSensitiveDom,
        checked: typeof element.checked === 'boolean' ? element.checked : (element.getAttribute('aria-checked') || null),
        selected: typeof element.selected === 'boolean' ? element.selected : (element.getAttribute('aria-selected') || null),
        selectedIndex: typeof element.selectedIndex === 'number' ? element.selectedIndex : null,
        expanded: element.getAttribute('aria-expanded'),
        pressed: element.getAttribute('aria-pressed'),
        disabled: !!element.disabled || element.getAttribute('aria-disabled') === 'true',
        url: document.URL,
        active: document.activeElement === element,
        connected: element.isConnected,
        rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
        }
    };
}

function verifyInputAction(element, expectedText, beforeState, afterState) {
    const expected = String(expectedText ?? '');
    const actual = element.isContentEditable ? (element.textContent || '') : String(element.value ?? '');
    const sensitive = isSensitiveElement(element);
    const verified = actual === expected;
    return {
        attempted: true,
        verified,
        verificationType: sensitive ? 'sensitive-value-length-and-equality' : 'value-readback',
        beforeState,
        afterState,
        expected: sensitive && redactSensitiveDom ? { length: expected.length } : expected,
        actual: sensitive && redactSensitiveDom ? { length: actual.length, redacted: true } : actual,
        backendUsed: 'content-script',
        fallbackUsed: false,
        requiresFreshSnapshot: true
    };
}

function verifyClickAction(element, beforeState, afterState) {
    const kind = getElementKind(element);
    let verificationType = 'unverifiable-click';
    let verified = null;

    if (['checkbox', 'radio', 'switch'].includes(kind)) {
        verificationType = kind === 'switch' ? 'aria-checked-changed' : 'checked-changed';
        verified = beforeState?.checked !== afterState?.checked;
    } else if (beforeState?.expanded !== null || afterState?.expanded !== null) {
        verificationType = 'aria-expanded-changed';
        verified = beforeState?.expanded !== afterState?.expanded;
    } else if (kind === 'tab') {
        verificationType = 'aria-selected-changed';
        verified = beforeState?.selected !== afterState?.selected;
    } else if (kind === 'link') {
        verificationType = 'url-or-navigation-observed';
        verified = beforeState?.url !== afterState?.url ? true : null;
    }

    return {
        attempted: true,
        verified,
        verificationType,
        beforeState,
        afterState,
        backendUsed: 'content-script',
        fallbackUsed: false,
        requiresFreshSnapshot: true
    };
}

function describeOccluder(element) {
    if (!element) return null;
    return {
        tag: element.tagName?.toLowerCase?.() || '',
        role: element.getAttribute?.('role') || null,
        label: getAccessibleName(element) || getElementDescriptor(element)
    };
}

function isRelatedHitTarget(target, hit) {
    if (!target || !hit) return false;
    if (hit === target || target.contains(hit) || hit.contains(target)) return true;
    if (hit.tagName === 'LABEL' && hit.htmlFor && hit.htmlFor === target.id) return true;
    if (target.tagName === 'LABEL' && target.control === hit) return true;
    return false;
}

function checkElementOcclusion(element) {
    if (!element?.isConnected) {
        throw makeStructuredError('ELEMENT_HANDLE_EXPIRED', '目标元素已脱离 DOM');
    }
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const visibleLeft = Math.max(0, rect.left);
    const visibleTop = Math.max(0, rect.top);
    const visibleRight = Math.min(viewportWidth, rect.right);
    const visibleBottom = Math.min(viewportHeight, rect.bottom);
    const visibleWidth = Math.max(0, visibleRight - visibleLeft);
    const visibleHeight = Math.max(0, visibleBottom - visibleTop);
    const visibleArea = visibleWidth * visibleHeight;
    const totalArea = Math.max(1, rect.width * rect.height);
    const visibleRatio = visibleArea / totalArea;

    if (style.display === 'none' || style.visibility === 'hidden' || Number.parseFloat(style.opacity || '1') <= 0 || rect.width <= 0 || rect.height <= 0) {
        throw makeStructuredError('ELEMENT_NOT_INTERACTABLE', '目标元素不可见或没有有效尺寸', {
            descriptor: getElementDescriptor(element),
            rect: captureElementActionState(element)?.rect
        });
    }
    if (element.disabled || element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('inert')) {
        throw makeStructuredError('ELEMENT_NOT_INTERACTABLE', '目标元素处于禁用或 inert 状态', {
            descriptor: getElementDescriptor(element)
        });
    }
    if (visibleArea <= 0) {
        throw makeStructuredError('ELEMENT_OUTSIDE_VIEWPORT', '目标元素不在当前可操作视口', {
            rect: captureElementActionState(element)?.rect,
            viewport: { width: viewportWidth, height: viewportHeight }
        });
    }

    const insetX = Math.min(6, visibleWidth * 0.2);
    const insetY = Math.min(6, visibleHeight * 0.2);
    const points = [
        [visibleLeft + visibleWidth / 2, visibleTop + visibleHeight / 2],
        [visibleLeft + insetX, visibleTop + insetY],
        [visibleRight - insetX, visibleTop + insetY],
        [visibleLeft + insetX, visibleBottom - insetY],
        [visibleRight - insetX, visibleBottom - insetY]
    ].map(([x, y]) => ({
        x: Math.max(0, Math.min(viewportWidth - 1, Math.round(x))),
        y: Math.max(0, Math.min(viewportHeight - 1, Math.round(y)))
    }));

    let hitCount = 0;
    let firstOccluder = null;
    let preferredPoint = null;
    for (const point of points) {
        const hit = document.elementFromPoint(point.x, point.y);
        if (isRelatedHitTarget(element, hit)) {
            hitCount++;
            if (!preferredPoint) preferredPoint = point;
        } else if (!firstOccluder && hit) {
            firstOccluder = hit;
        }
    }

    return {
        occluded: hitCount === 0,
        hitRatio: hitCount / points.length,
        sampleCount: points.length,
        hitCount,
        visibleRatio,
        preferredPoint,
        rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
        },
        occluder: describeOccluder(firstOccluder)
    };
}

function ensureElementInteractable(element, options = {}) {
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const occlusion = checkElementOcclusion(element);
    if (occlusion.occluded && options.strict !== false) {
        throw makeStructuredError('ELEMENT_OCCLUDED', '目标元素被其他页面内容完全遮挡', occlusion);
    }
    return occlusion;
}

function clickElement(element, options = {}) {
    if (!element) throw makeStructuredError('TARGET_NOT_FOUND', '缺少点击目标元素');
    const occlusion = ensureElementInteractable(element, options);
    element.focus({ preventScroll: true });
    const rect = element.getBoundingClientRect();
    const actionPoint = occlusion.preferredPoint || {
        x: Math.floor(rect.left + rect.width / 2),
        y: Math.floor(rect.top + rect.height / 2)
    };
    const eventInit = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: actionPoint.x,
        clientY: actionPoint.y
    };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
        const event = type.startsWith('pointer')
            ? new PointerEvent(type, { ...eventInit, pointerId: 1, pointerType: 'mouse', isPrimary: true })
            : new MouseEvent(type, eventInit);
        element.dispatchEvent(event);
    });
    return occlusion;
}

function normalizeKeys(keys) {
    if (Array.isArray(keys)) return keys.map(String);
    return String(keys || '').split(/\s*\+\s*|\s*,\s*/).filter(Boolean);
}

function sendKeysToElement(element, keys) {
    const tokens = normalizeKeys(keys);
    if (tokens.length === 0) throw makeStructuredError('INVALID_KEYS', 'send_keys 缺少 keys 参数');
    const keyAliases = {
        esc: 'Escape',
        return: 'Enter',
        space: ' ',
        arrowup: 'ArrowUp',
        arrowdown: 'ArrowDown',
        arrowleft: 'ArrowLeft',
        arrowright: 'ArrowRight',
        pageup: 'PageUp',
        pagedown: 'PageDown'
    };
    const modifiers = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
    tokens.forEach(token => {
        const lower = token.toLowerCase();
        if (['ctrl', 'control'].includes(lower)) modifiers.ctrlKey = true;
        else if (['cmd', 'command', 'meta'].includes(lower)) modifiers.metaKey = true;
        else if (lower === 'alt') modifiers.altKey = true;
        else if (lower === 'shift') modifiers.shiftKey = true;
    });
    const actionKeys = tokens.filter(token => !['ctrl', 'control', 'cmd', 'command', 'meta', 'alt', 'shift'].includes(token.toLowerCase()));
    const target = element || document.activeElement || document.body;
    target.focus?.();
    actionKeys.forEach(rawKey => {
        const key = keyAliases[rawKey.toLowerCase()] || rawKey;
        const init = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true, ...modifiers };
        target.dispatchEvent(new KeyboardEvent('keydown', init));
        target.dispatchEvent(new KeyboardEvent('keypress', init));
        target.dispatchEvent(new KeyboardEvent('keyup', init));
    });
    return { keys: actionKeys, modifiers };
}

function selectOptionOnElement(element, params = {}) {
    if (element.tagName !== 'SELECT') {
        throw makeStructuredError('ELEMENT_NOT_INTERACTABLE', 'select_option 当前要求目标为原生 select 元素');
    }
    const options = Array.from(element.options);
    const exact = parseBooleanParam(params.exact, true);
    let selected = null;
    if (params.value !== undefined) selected = options.find(option => option.value === String(params.value));
    if (!selected && params.text !== undefined) {
        const expected = normalizeText(params.text);
        selected = options.find(option => exact ? normalizeText(option.text) === expected : normalizeText(option.text).includes(expected));
    }
    if (!selected && params.index !== undefined) selected = options[Number(params.index)] || null;
    if (!selected) {
        throw makeStructuredError('OPTION_NOT_FOUND', '未找到匹配的下拉选项', {
            availableOptions: options.slice(0, 100).map((option, index) => ({ index, text: option.text, value: option.value, disabled: option.disabled }))
        });
    }
    if (selected.disabled) throw makeStructuredError('ELEMENT_NOT_INTERACTABLE', '目标下拉选项已禁用');
    element.value = selected.value;
    selected.selected = true;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return {
        selectedIndex: element.selectedIndex,
        selectedText: selected.text,
        selectedValue: element.value,
        availableOptions: options.slice(0, 100).map((option, index) => ({ index, text: option.text, value: option.value, disabled: option.disabled }))
    };
}

function hoverElement(element) {
    const occlusion = ensureElementInteractable(element, { strict: true });
    const point = occlusion.preferredPoint;
    ['pointerover', 'mouseover', 'pointerenter', 'mouseenter', 'mousemove'].forEach(type => {
        const EventCtor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
        element.dispatchEvent(new EventCtor(type, {
            bubbles: !type.endsWith('enter'),
            cancelable: true,
            clientX: point.x,
            clientY: point.y,
            pointerId: 1,
            pointerType: 'mouse'
        }));
    });
    return occlusion;
}

async function waitForCondition(params = {}) {
    const timeoutMs = parseNumberParam(params.timeoutMs, 10000, 50, 120000);
    const pollMs = parseNumberParam(params.pollMs, 100, 25, 2000);
    const condition = String(params.condition || (params.target ? 'element' : params.text !== undefined ? 'text' : params.url ? 'url' : 'dom_stable')).toLowerCase();
    const startedAt = Date.now();
    let stableSince = Date.now();
    let lastMutationCount = 0;
    const mutationObserver = new MutationObserver(() => {
        lastMutationCount++;
        stableSince = Date.now();
    });
    mutationObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    try {
        while (Date.now() - startedAt <= timeoutMs) {
            let matched = false;
            let actual = null;
            let element = null;
            try {
                if (params.target) element = resolveTargetElement(params.target).element;
            } catch {
                element = null;
            }
            if (condition === 'element' || condition === 'visible') {
                matched = !!element && isInteractive(element) && element.getBoundingClientRect().width > 0;
                actual = element ? getElementDescriptor(element) : null;
            } else if (condition === 'hidden') {
                matched = !element || !isInteractive(element);
            } else if (condition === 'text') {
                actual = normalizeAttribute(document.body?.innerText || '');
                matched = actual.includes(String(params.text || ''));
            } else if (condition === 'url') {
                actual = document.URL;
                matched = params.url ? actual.includes(String(params.url)) : false;
            } else if (condition === 'value') {
                actual = element ? (element.value ?? element.textContent ?? '') : null;
                matched = element && String(actual) === String(params.value ?? params.text ?? '');
            } else if (condition === 'dom_stable') {
                const stableMs = parseNumberParam(params.stableMs, 500, 50, 10000);
                actual = { stableForMs: Date.now() - stableSince, mutationCount: lastMutationCount };
                matched = Date.now() - stableSince >= stableMs;
            } else {
                throw makeStructuredError('WAIT_CONDITION_UNSUPPORTED', `不支持的 wait_for 条件: ${condition}`);
            }
            if (matched) {
                return {
                    status: 'success',
                    code: 'WAIT_CONDITION_MET',
                    message: `等待条件已满足: ${condition}`,
                    result: { condition, matched: true, actual, elapsedMs: Date.now() - startedAt }
                };
            }
            await new Promise(resolve => setTimeout(resolve, pollMs));
        }
    } finally {
        mutationObserver.disconnect();
    }
    throw makeStructuredError('WAIT_TIMEOUT', `等待条件超时: ${condition}`, { condition, timeoutMs });
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
            content: redactHtml(document.documentElement?.outerHTML || ''),
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

async function performScroll(params = {}) {
    const direction = String(params.direction || 'down').toLowerCase();
    const behavior = ['auto', 'smooth', 'instant'].includes(String(params.behavior || '').toLowerCase())
        ? String(params.behavior).toLowerCase()
        : 'smooth';
    const amountParam = params.amount;
    const xParam = params.x;
    const yParam = params.y;
    const target = params.target;

    let scrollTarget = window;
    let targetLabel = 'window';

    if (target) {
        const element = findElementWithLogging(target);
        if (!element) throw new Error(`未找到滚动目标元素: ${target}`);
        scrollTarget = element;
        targetLabel = getElementDescriptor(element);
    }

    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 800;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1200;
    const defaultAmount = Math.floor(viewportHeight * 0.8);
    const amount = parseNumberParam(amountParam, defaultAmount, 1, 100000);
    let left = Number.isFinite(Number(xParam)) ? Number(xParam) : 0;
    let top = Number.isFinite(Number(yParam)) ? Number(yParam) : 0;

    if (direction === 'down') {
        top = amount;
    } else if (direction === 'up') {
        top = -amount;
    } else if (direction === 'right') {
        left = amount;
    } else if (direction === 'left') {
        left = -amount;
    } else if (direction === 'bottom') {
        if (scrollTarget === window) {
            top = Math.max(
                document.documentElement.scrollHeight,
                document.body?.scrollHeight || 0
            );
        } else {
            top = scrollTarget.scrollHeight;
        }
    } else if (direction === 'top') {
        if (scrollTarget === window) {
            window.scrollTo({ top: 0, left: window.scrollX, behavior });
        } else {
            scrollTarget.scrollTo({ top: 0, left: scrollTarget.scrollLeft, behavior });
        }
        await new Promise(resolve => setTimeout(resolve, behavior === 'smooth' ? 350 : 30));
        const afterState = getScrollState(scrollTarget, targetLabel);
        return buildVerifiedScrollResult('已滚动到顶部', targetLabel, direction, null, afterState);
    } else if (direction === 'to') {
        top = Number.isFinite(Number(yParam)) ? Number(yParam) : 0;
        left = Number.isFinite(Number(xParam)) ? Number(xParam) : 0;
        if (scrollTarget === window) {
            window.scrollTo({ top, left, behavior });
        } else {
            scrollTarget.scrollTo({ top, left, behavior });
        }
        await new Promise(resolve => setTimeout(resolve, behavior === 'smooth' ? 350 : 30));
        const afterState = getScrollState(scrollTarget, targetLabel);
        return buildVerifiedScrollResult('已滚动到指定坐标', targetLabel, direction, null, afterState);
    } else if (direction === 'page_down') {
        top = viewportHeight;
    } else if (direction === 'page_up') {
        top = -viewportHeight;
    } else if (direction === 'page_right') {
        left = viewportWidth;
    } else if (direction === 'page_left') {
        left = -viewportWidth;
    } else {
        throw new Error(`不支持的滚动方向: ${direction}`);
    }

    const beforeState = getScrollState(scrollTarget, targetLabel);
    if (scrollTarget === window) {
        window.scrollBy({ top, left, behavior });
    } else {
        scrollTarget.scrollBy({ top, left, behavior });
    }
    await new Promise(resolve => setTimeout(resolve, behavior === 'smooth' ? 350 : 30));
    const afterState = getScrollState(scrollTarget, targetLabel);
    return buildVerifiedScrollResult(`滚动完成: direction=${direction}, amount=${amount}`, targetLabel, direction, beforeState, afterState);
}

function buildVerifiedScrollResult(message, targetLabel, direction, beforeState, afterState) {
    const verticalPosition = state => state?.scrollY ?? state?.scrollTop ?? 0;
    const horizontalPosition = state => state?.scrollX ?? state?.scrollLeft ?? 0;
    const moved = beforeState === null ||
        verticalPosition(beforeState) !== verticalPosition(afterState) ||
        horizontalPosition(beforeState) !== horizontalPosition(afterState);
    const maxY = Math.max(0, (afterState.scrollHeight || 0) - (afterState.innerHeight || afterState.clientHeight || 0));
    const maxX = Math.max(0, (afterState.scrollWidth || 0) - (afterState.innerWidth || afterState.clientWidth || 0));
    const currentY = verticalPosition(afterState);
    const currentX = horizontalPosition(afterState);
    const reachedBoundary = (
        ['down', 'bottom', 'page_down'].includes(direction) && currentY >= maxY - 1
    ) || (
        ['up', 'top', 'page_up'].includes(direction) && currentY <= 0
    ) || (
        ['right', 'page_right'].includes(direction) && currentX >= maxX - 1
    ) || (
        ['left', 'page_left'].includes(direction) && currentX <= 0
    );

    return {
        status: 'success',
        code: moved ? 'ACTION_VERIFIED' : (reachedBoundary ? 'SCROLL_BOUNDARY_REACHED' : 'ACTION_VERIFICATION_FAILED'),
        message: `${message} (${targetLabel})`,
        result: {
            ...afterState,
            attempted: true,
            verified: moved || reachedBoundary,
            verificationType: reachedBoundary && !moved ? 'scroll-boundary' : 'scroll-position-changed',
            reachedBoundary,
            beforeState,
            afterState,
            backendUsed: 'content-script',
            fallbackUsed: false,
            requiresFreshSnapshot: true
        }
    };
}

function getScrollState(scrollTarget, targetLabel) {
    if (scrollTarget === window) {
        const doc = document.documentElement;
        const body = document.body;
        return {
            target: targetLabel,
            scrollX: window.scrollX,
            scrollY: window.scrollY,
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            scrollWidth: Math.max(doc?.scrollWidth || 0, body?.scrollWidth || 0),
            scrollHeight: Math.max(doc?.scrollHeight || 0, body?.scrollHeight || 0)
        };
    }

    return {
        target: targetLabel,
        scrollLeft: scrollTarget.scrollLeft,
        scrollTop: scrollTarget.scrollTop,
        clientWidth: scrollTarget.clientWidth,
        clientHeight: scrollTarget.clientHeight,
        scrollWidth: scrollTarget.scrollWidth,
        scrollHeight: scrollTarget.scrollHeight
    };
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

function sendPageInfoUpdate(options = {}) {
    const isForcedUpdate = options.force === true;

    if (!isForcedUpdate && (commandInProgress || Date.now() < suppressAutoSnapshotUntil)) {
        pendingSnapshotRefresh = true;
        return;
    }

    // 监控关闭时静默跳过自动更新，避免控制台持续刷新 VCP Content 日志。
    if (!isMonitoringEnabled && !isForcedUpdate) {
        return;
    }

    // 关键检查：只有活动标签页才发送更新（或页面刚加载完成时）
    if (!isActiveTab && document.hidden) {
        if (isMonitoringEnabled) {
            console.log('[VCP Content] ⚠️ 当前非活动标签页，跳过更新');
        }
        return;
    }
    
    const buildStartedAt = performance.now();
    const pageInfo = pageToMarkdown();
    const currentPageContent = pageInfo?.markdown || '';
    const stableChanged = pageInfo?.contentHash !== lastStableContentHash || pageInfo?.structureHash !== lastStructureHash;
    if (currentPageContent && (isForcedUpdate || stableChanged)) {
        lastPageContent = currentPageContent;
        lastStableContentHash = pageInfo.contentHash;
        lastStructureHash = pageInfo.structureHash;
        lastSnapshotSummary = {
            snapshotId: pageInfo.snapshotId,
            contentHash: pageInfo.contentHash,
            structureHash: pageInfo.structureHash,
            generatedAt: pageInfo.generatedAt
        };
        pageInfo.performance = {
            snapshotDurationMs: Math.round((performance.now() - buildStartedAt) * 100) / 100,
            duplicateSnapshotSkippedCount
        };
        console.log(`[VCP Content] 📤 发送${isForcedUpdate ? '强制' : '自动'}页面信息到background (活动标签页, snapshot=${pageInfo.snapshotId}, elements=${pageInfo.elementCount})`);
        chrome.runtime.sendMessage({
            type: 'PAGE_INFO_UPDATE',
            data: {
                ...pageInfo,
                force: isForcedUpdate
            }
        }, () => {
            if (chrome.runtime.lastError) {
                // console.log("[VCP Content] Page info update failed, context likely invalidated.");
            } else {
                console.log('[VCP Content] ✅ 页面信息已发送');
            }
        });
    } else if (!isForcedUpdate && currentPageContent) {
        duplicateSnapshotSkippedCount += 1;
        console.log(`[VCP Content] 🟰 稳定内容未变化，跳过重复上报 (content=${pageInfo.contentHash}, structure=${pageInfo.structureHash}, skipped=${duplicateSnapshotSkippedCount})`);
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'CLEAR_STATE') {
        lastPageContent = '';
        lastStableContentHash = '';
        lastStructureHash = '';
        lastSnapshotSummary = null;
        lastPageGraphSnapshot = null;
        isActiveTab = false; // 重置活动状态
        currentSnapshotId += 1;
        clearElementRegistry('navigation_clear_state');
    } else if (request.type === 'REQUEST_PAGE_INFO_UPDATE') {
        // 收到请求说明这是活动标签页
        isMonitoringEnabled = true;
        console.log('[VCP Content] 📍 收到更新请求，标记为活动标签页');
        isActiveTab = true;
        if (request.force === true) {
            lastPageContent = '';
        }
        sendPageInfoUpdate({ force: request.force === true });
    } else if (request.type === 'MONITORING_STATUS_CHANGED') {
        isMonitoringEnabled = request.isMonitoringEnabled === true;
        if (!isMonitoringEnabled) {
            isActiveTab = false;
        }
    } else if (request.type === 'PRIVACY_SETTINGS_CHANGED') {
        redactSensitiveDom = request.redactSensitiveDom !== false;
        lastStableContentHash = '';
        lastStructureHash = '';
        sendPageInfoUpdate({ force: true });
    } else if (request.type === 'GET_GROUNDED_PAGE_INFO') {
        // Popup 开发观测入口：即时编译当前页面，不依赖监控和 WebSocket 状态。
        // 返回完整页面图供开发诊断，但 Popup 默认只复制 agentView.markdown。
        const pageInfo = pageToMarkdown();
        sendResponse({
            success: !!pageInfo?.agentView?.markdown,
            pageInfo,
            markdown: pageInfo?.agentView?.markdown || pageInfo?.pageContentMarkdown || pageInfo?.markdown || ''
        });
        return true;
    } else if (request.type === 'FORCE_PAGE_UPDATE') {
        // 新增：强制更新页面信息（手动刷新）
        console.log('[VCP Content] 🔄 收到强制更新请求');
        lastPageContent = ''; // 清除缓存，强制重新生成
        const pageInfo = pageToMarkdown();
        const currentPageContent = pageInfo?.markdown || '';
        if (currentPageContent) {
            lastPageContent = currentPageContent;
            console.log('[VCP Content] 📤 发送强制更新的页面信息');
            chrome.runtime.sendMessage({
                type: 'PAGE_INFO_UPDATE',
                data: { ...pageInfo, force: true }
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
        const { command, target, text, requestId, sourceClientId, query, scope, useRegex, caseSensitive, contextChars, maxResults, searchMode, direction, amount, x, y, behavior, snapshotId, strict } = request.data;
        
        const handleCommand = async () => {
            let result = {};
            commandInProgress = true;
            suppressAutoSnapshotUntil = Date.now() + 1500;
            try {
                if (snapshotId && strict === true && Number(snapshotId) !== currentSnapshotId) {
                    throw makeStructuredError('ELEMENT_HANDLE_EXPIRED', `命令快照 ${snapshotId} 已过期，当前快照为 ${currentSnapshotId}，请重新获取 page_info。`, {
                        requestedSnapshotId: Number(snapshotId),
                        currentSnapshotId
                    });
                }

                if (command === 'query_html') {
                    const resolved = target ? resolveTargetElement(target) : { element: document.body, source: 'body' };
                    const element = resolved.element;
                    if (!element) throw makeStructuredError('TARGET_NOT_FOUND', `未找到目标元素: ${target}`);
                    const redacted = redactHtmlWithMetadata(element.outerHTML);
                    result = {
                        status: 'success',
                        code: redacted.applied
                            ? 'SENSITIVE_DATA_REDACTED'
                            : (redacted.enabled ? 'REDACTION_ENABLED_NO_MATCH' : null),
                        result: redacted.html,
                        redaction: {
                            enabled: redacted.enabled,
                            applied: redacted.applied,
                            redactedFieldCount: redacted.redactedFieldCount
                        },
                        targetResolution: { source: resolved.source, handleId: resolved.handleId, confidence: resolved.confidence }
                    };
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
                } else if (command === 'get_page_info') {
                    lastPageContent = '';
                    const pageInfo = pageToMarkdown();
                    result = { status: 'success', message: '页面信息已刷新', result: pageInfo };
                } else if (command === 'wait_for') {
                    result = await waitForCondition(request.data);
                } else if (command === 'send_keys' && !target) {
                    const keyResult = sendKeysToElement(document.activeElement || document.body, request.data.keys || text);
                    result = {
                        status: 'success',
                        code: 'ACTION_DISPATCHED',
                        message: '键盘动作已发送到当前焦点元素',
                        result: { ...keyResult, backendUsed: 'content-script', verified: null }
                    };
                } else if (command === 'scroll') {
                    result = await performScroll({
                        target,
                        direction,
                        amount,
                        x,
                        y,
                        behavior
                    });
                } else if (command === 'execute_script') {
                    throw new Error('execute_script 已迁移到 background 的 chrome.scripting MAIN world 执行路径');
                } else {
                    const inputCommands = new Set(['type']);
                    const clickableCommands = new Set(['click', 'check', 'hover']);
                    const resolved = resolveTargetElement(target, {
                        requireInputLike: inputCommands.has(command),
                        requireClickableLike: clickableCommands.has(command),
                        minScore: inputCommands.has(command) ? 0.72 : 0.62
                    });
                    const element = resolved.element;

                    if (command === 'type' || command === 'set_value') {
                        const requestedValue = request.data.value ?? text ?? '';
                        const beforeState = captureElementActionState(element);
                        if (command === 'set_value') {
                            const tagName = element.tagName.toLowerCase();
                            if (!['input', 'textarea'].includes(tagName) && !element.isContentEditable) {
                                throw makeStructuredError('ELEMENT_NOT_INPUT_LIKE', `set_value 不支持目标: ${getElementDescriptor(element)}`);
                            }
                            element.focus();
                            setNativeValue(element, String(requestedValue));
                        } else {
                            typeIntoElement(element, requestedValue);
                        }
                        await new Promise(resolve => setTimeout(resolve, 50));
                        const afterState = captureElementActionState(element);
                        const verification = verifyInputAction(element, requestedValue, beforeState, afterState);
                        const enforceVerification = request.data.verification !== 'observe' && request.data.verification !== 'none';
                        result = {
                            status: verification.verified || !enforceVerification ? 'success' : 'error',
                            code: verification.verified
                                ? 'ACTION_VERIFIED'
                                : (enforceVerification ? 'ACTION_VERIFICATION_FAILED' : 'ACTION_VERIFICATION_OBSERVED_FAILED'),
                            message: verification.verified
                                ? `已在目标 '${target}' 输入并读回验证。`
                                : (enforceVerification
                                    ? `目标 '${target}' 输入已发送，但实际值读回不一致。`
                                    : `目标 '${target}' 输入已发送；验证器观测到读回不一致，但兼容模式不改变旧调用结果。`),
                            error: verification.verified || !enforceVerification ? undefined : '输入动作验证失败',
                            result: {
                                ...verification,
                                snapshotIdBefore: currentSnapshotId,
                                targetResolution: {
                                    source: resolved.source,
                                    handleId: resolved.handleId,
                                    confidence: resolved.confidence,
                                    signatureValid: resolved.signatureValid
                                }
                            }
                        };
                    } else if (command === 'click') {
                        const beforeState = captureElementActionState(element);
                        const occlusion = clickElement(element, { strict: strict !== false });
                        await new Promise(resolve => setTimeout(resolve, 50));
                        const afterState = captureElementActionState(element);
                        const verification = verifyClickAction(element, beforeState, afterState);
                        const enforceVerification = request.data.verification !== 'observe' && request.data.verification !== 'none';
                        result = {
                            status: verification.verified === false && enforceVerification ? 'error' : 'success',
                            code: verification.verified === true
                                ? 'ACTION_VERIFIED'
                                : (verification.verified === false
                                    ? (enforceVerification ? 'ACTION_VERIFICATION_FAILED' : 'ACTION_VERIFICATION_OBSERVED_FAILED')
                                    : 'ACTION_ATTEMPTED_UNVERIFIABLE'),
                            message: verification.verified === true
                                ? `已点击目标 '${target}' 并验证状态变化。`
                                : (verification.verified === false
                                    ? (enforceVerification
                                        ? `已点击目标 '${target}'，但预期状态未变化。`
                                        : `已点击目标 '${target}'；验证器观测到状态未变化，但兼容模式不改变旧调用结果。`)
                                    : `已点击目标 '${target}'，该控件没有可识别的状态供验证。`),
                            error: verification.verified === false && enforceVerification ? '点击动作验证失败' : undefined,
                            result: {
                                ...verification,
                                occlusion,
                                actionPoint: occlusion.preferredPoint,
                                snapshotIdBefore: currentSnapshotId,
                                targetResolution: {
                                    source: resolved.source,
                                    handleId: resolved.handleId,
                                    confidence: resolved.confidence,
                                    signatureValid: resolved.signatureValid
                                }
                            }
                        };
                    } else if (command === 'send_keys') {
                        const beforeState = captureElementActionState(element);
                        const keyResult = sendKeysToElement(element, request.data.keys || text);
                        const afterState = captureElementActionState(element);
                        result = {
                            status: 'success',
                            code: 'ACTION_DISPATCHED',
                            message: `已向目标 '${target}' 发送键盘动作`,
                            result: {
                                ...keyResult,
                                attempted: true,
                                verified: null,
                                beforeState,
                                afterState,
                                backendUsed: 'content-script',
                                targetResolution: { source: resolved.source, handleId: resolved.handleId, confidence: resolved.confidence }
                            }
                        };
                    } else if (command === 'select_option') {
                        const beforeState = captureElementActionState(element);
                        const selected = selectOptionOnElement(element, request.data);
                        const afterState = captureElementActionState(element);
                        result = {
                            status: 'success',
                            code: 'ACTION_VERIFIED',
                            message: `已选择选项: ${selected.selectedText}`,
                            result: {
                                ...selected,
                                attempted: true,
                                verified: afterState.selectedIndex === selected.selectedIndex,
                                verificationType: 'selected-option-readback',
                                beforeState,
                                afterState,
                                backendUsed: 'content-script',
                                requiresFreshSnapshot: true
                            }
                        };
                    } else if (command === 'hover') {
                        const occlusion = hoverElement(element);
                        result = {
                            status: 'success',
                            code: 'ACTION_DISPATCHED',
                            message: `已悬停目标 '${target}'`,
                            result: { attempted: true, verified: null, occlusion, backendUsed: 'content-script', requiresFreshSnapshot: true }
                        };
                    } else if (command === 'check') {
                        const desired = parseBooleanParam(request.data.checked, true);
                        const beforeState = captureElementActionState(element);
                        const current = beforeState.checked === true || beforeState.checked === 'true';
                        let occlusion = null;
                        if (current !== desired) {
                            occlusion = clickElement(element, { strict: strict !== false });
                            await new Promise(resolve => setTimeout(resolve, 50));
                        }
                        const afterState = captureElementActionState(element);
                        const actual = afterState.checked === true || afterState.checked === 'true';
                        result = {
                            status: actual === desired ? 'success' : 'error',
                            code: actual === desired ? 'ACTION_VERIFIED' : 'ACTION_VERIFICATION_FAILED',
                            message: actual === desired ? `控件状态已为 checked=${desired}` : `控件未达到 checked=${desired}`,
                            error: actual === desired ? undefined : 'check 动作验证失败',
                            result: {
                                attempted: current !== desired,
                                idempotentNoop: current === desired,
                                verified: actual === desired,
                                verificationType: 'checked-target-state',
                                desired,
                                actual,
                                beforeState,
                                afterState,
                                occlusion,
                                backendUsed: 'content-script',
                                requiresFreshSnapshot: current !== desired
                            }
                        };
                    } else {
                        throw new Error(`不支持的命令: ${command}`);
                    }
                }
            } catch (error) {
                result = {
                    status: 'error',
                    code: error.code || 'COMMAND_EXECUTION_ERROR',
                    error: error.message,
                    details: error.details || null
                };
            } finally {
                commandInProgress = false;
            }

            if (request.data.fallbackUsed === true && result?.result && typeof result.result === 'object') {
                result.result.fallbackUsed = true;
                result.result.fallbackReason = request.data.fallbackReason || 'CDP_BACKEND_UNAVAILABLE';
                result.result.backendRequested = 'cdp-input';
            }

            chrome.runtime.sendMessage({
                type: 'COMMAND_RESULT',
                data: { requestId, sourceClientId, ...result }
            }, () => {
                if (chrome.runtime.lastError) {
                    console.log("Could not send command result:", chrome.runtime.lastError.message);
                }
            });
            setTimeout(() => {
                pendingSnapshotRefresh = false;
                sendPageInfoUpdate({ force: true });
            }, 500);
        };

        handleCommand();
        return true;
    }
});

const debouncedSendPageInfoUpdate = debounce(sendPageInfoUpdate, 500); // 降低延迟，提高响应速度

const observer = new MutationObserver((mutations) => {
    const hasStructuralMutation = mutations.some(mutation =>
        mutation.type === 'childList' ||
        (mutation.type === 'attributes' && ['role', 'aria-label', 'placeholder', 'name', 'id', 'type', 'href', 'style', 'class'].includes(mutation.attributeName))
    );
    if (!hasStructuralMutation && !isMonitoringEnabled) return;
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
    if (isMonitoringEnabled) {
        console.log('[VCP Content] 📄 页面加载完成，活动状态:', isActiveTab);
    }
    // 页面加载完成后尝试发送一次更新；监控关闭时会静默跳过
    sendPageInfoUpdate();
});

document.addEventListener('visibilitychange', () => {
    if (!isMonitoringEnabled) {
        isActiveTab = false;
        return;
    }

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
    if (!isMonitoringEnabled) {
        return;
    }

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

// 定期更新，但只在监控开启且活动标签页时发送
setInterval(() => {
    if (isMonitoringEnabled && isActiveTab && !document.hidden) {
        sendPageInfoUpdate();
    }
}, 5000);

chrome.storage.local.get(['isMonitoringEnabled', 'redactSensitiveDom'], (result) => {
    isMonitoringEnabled = result.isMonitoringEnabled === true;
    redactSensitiveDom = result.redactSensitiveDom !== false;
    if (result.redactSensitiveDom === undefined) {
        chrome.storage.local.set({ redactSensitiveDom: true });
    }
});

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
