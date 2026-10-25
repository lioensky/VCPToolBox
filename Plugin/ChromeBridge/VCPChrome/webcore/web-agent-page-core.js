(function initWebAgentPageCore(globalScope, factory) {
    const api = factory(globalScope);
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (globalScope) {
        globalScope.VCPWebAgentPageCore = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createModule(globalScope) {
    'use strict';

    const VERSION = '0.1.1';
    const SENSITIVE_FIELD_PATTERN = /pass(word)?|passwd|pwd|token|access.?token|refresh.?token|authorization|auth|cookie|secret|api.?key|session.?id|credit.?card|card.?number|cvv|cvc|security.?code/i;
    const INTERACTIVE_SELECTOR = [
        'a', 'button', 'input', 'textarea', 'select', 'option',
        '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
        '[role="menuitem"]', '[role="tab"]', '[role="switch"]', '[role="option"]',
        '[role="treeitem"]', '[role="searchbox"]', '[role="textbox"]', '[role="combobox"]',
        '[contenteditable]', '[onclick]', '[tabindex]'
    ].join(',');

    function computeTextSimilarity(a, b) {
        const normalize = value => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const left = normalize(a), right = normalize(b);
        if (!left || !right) return 0;
        if (left === right) return 1;
        const overlap = (x, y) => {
            const common = [...x].filter(item => y.has(item)).length;
            return Math.max(common / Math.max(x.size, y.size, 1),
                common / Math.max(x.size + y.size - common, 1));
        };
        let score = overlap(new Set(left.split(/\s+/)), new Set(right.split(/\s+/)));
        if (left.includes(right) || right.includes(left)) {
            score = Math.max(score, Math.min(left.length, right.length) / Math.max(left.length, right.length));
        }
        if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(left + right)) {
            const bigrams = text => {
                const chars = Array.from(text.replace(/\s+/g, ''));
                return new Set(chars.length < 2 ? chars : chars.slice(1).map((char, i) => chars[i] + char));
            };
            score = Math.max(score, overlap(bigrams(left), bigrams(right)));
        }
        return score;
    }

    function createWebAgentPageCore(environment = {}, options = {}) {
        const windowObject = environment.window || globalScope?.window;
        const documentObject = environment.document || windowObject?.document || globalScope?.document;
        const NodeObject = environment.Node || windowObject?.Node || globalScope?.Node;
        if (!windowObject || !documentObject || !NodeObject) {
            throw new Error('VCP Web Agent Page Core 需要 window、document 与 Node DOM 环境');
        }

        let redactSensitiveDom = options.redactSensitiveDom !== false;

        function makeStructuredError(code, message, details = {}) {
            const error = new Error(message);
            error.code = code;
            error.details = details;
            return error;
        }

        function normalizeAttribute(value) {
            return String(value || '').replace(/\s+/g, ' ').trim();
        }

        function normalizeText(text) {
            return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
        }

        function simpleHash(input) {
            const text = String(input || '');
            let hash = 2166136261;
            for (let index = 0; index < text.length; index++) {
                hash ^= text.charCodeAt(index);
                hash = Math.imul(hash, 16777619);
            }
            return (hash >>> 0).toString(36);
        }

        function safeCssEscape(value) {
            if (windowObject.CSS && typeof windowObject.CSS.escape === 'function') {
                return windowObject.CSS.escape(String(value));
            }
            return String(value).replace(/["\\]/g, '\\$&');
        }

        function getTextFromIdRefs(refs) {
            return String(refs || '')
                .split(/\s+/)
                .map(id => documentObject.getElementById(id))
                .filter(Boolean)
                .map(element => normalizeAttribute(
                    element.innerText ||
                    element.textContent ||
                    element.getAttribute('aria-label') ||
                    element.title ||
                    ''
                ))
                .filter(Boolean)
                .join(' ');
        }

        function findLabelForInput(inputElement) {
            if (!inputElement) return '';
            if (inputElement.id) {
                const label = documentObject.querySelector(`label[for="${safeCssEscape(inputElement.id)}"]`);
                if (label) return normalizeAttribute(label.innerText || label.textContent);
            }
            const parentLabel = inputElement.closest?.('label');
            return parentLabel ? normalizeAttribute(parentLabel.innerText || parentLabel.textContent) : '';
        }

        function getAccessibleName(element) {
            if (!element || element.nodeType !== NodeObject.ELEMENT_NODE) return '';
            const labelledBy = getTextFromIdRefs(element.getAttribute('aria-labelledby'));
            if (labelledBy) return labelledBy;
            return normalizeAttribute(
                element.getAttribute('aria-label') ||
                findLabelForInput(element) ||
                element.getAttribute('placeholder') ||
                element.getAttribute('title') ||
                element.getAttribute('name') ||
                element.id ||
                getTextFromIdRefs(element.getAttribute('aria-describedby'))
            );
        }

        function inferInputSemanticLabel(element) {
            if (!element || element.nodeType !== NodeObject.ELEMENT_NODE) return '';
            const tagName = element.tagName.toLowerCase();
            const role = element.getAttribute('role');
            const type = (element.getAttribute('type') || element.type || '').toLowerCase();
            const form = element.closest?.('form');
            const combined = [
                getAccessibleName(element),
                element.getAttribute('aria-label'),
                getTextFromIdRefs(element.getAttribute('aria-labelledby')),
                element.getAttribute('placeholder'),
                element.getAttribute('name'),
                element.id,
                element.className,
                element.getAttribute('autocomplete'),
                element.getAttribute('aria-controls'),
                element.getAttribute('aria-owns')
            ].map(normalizeAttribute).filter(Boolean).join(' ');
            const searchHints = [
                type === 'search',
                role === 'searchbox',
                /(^|[_\-\s])(q|query|search|keyword|wd|s)($|[_\-\s])/i.test(combined),
                /搜索|搜尋|搜寻|search|query|keyword|关键词|關鍵詞|bing|google|baidu|duckduckgo/i.test(combined),
                tagName === 'input' && form &&
                    /search|sb_form|搜索|搜尋/i.test(`${form.id || ''} ${form.className || ''} ${form.getAttribute('role') || ''}`)
            ];
            if (searchHints.some(Boolean)) {
                const accessibleName = getAccessibleName(element);
                return accessibleName && !/^(q|wd|s)$/i.test(accessibleName) ? accessibleName : '搜索框';
            }
            return getAccessibleName(element);
        }

        function isSensitiveElement(element) {
            if (!element || element.nodeType !== NodeObject.ELEMENT_NODE) return false;
            if ((element.getAttribute('type') || element.type || '').toLowerCase() === 'password') return true;
            const identity = [
                element.id,
                element.getAttribute('name'),
                element.getAttribute('autocomplete'),
                element.getAttribute('aria-label'),
                element.getAttribute('placeholder'),
                element.getAttribute('data-testid')
            ].map(normalizeAttribute).filter(Boolean).join(' ');
            return SENSITIVE_FIELD_PATTERN.test(identity);
        }

        function shouldRedactElementValue(element) {
            return redactSensitiveDom && isSensitiveElement(element);
        }

        function isContentEditableElement(element) {
            if (!element || element.nodeType !== NodeObject.ELEMENT_NODE) return false;
            const attribute = element.getAttribute('contenteditable');
            const explicitlyEditable = element.hasAttribute('contenteditable') &&
                ['', 'true', 'plaintext-only'].includes(String(attribute || '').trim().toLowerCase());
            return explicitlyEditable || element.isContentEditable === true;
        }

        function getSafeElementValue(element) {
            if (!element) return '';
            const value = isContentEditableElement(element) ? (element.textContent || '') : (element.value ?? '');
            return shouldRedactElementValue(element) ? '[REDACTED]' : String(value);
        }

        function redactHtmlWithMetadata(html) {
            const source = String(html || '');
            if (!redactSensitiveDom) {
                return { html: source, enabled: false, applied: false, redactedFieldCount: 0 };
            }
            const container = documentObject.createElement('template');
            container.innerHTML = source;
            let redactedFieldCount = 0;
            container.content.querySelectorAll('input, textarea, [contenteditable]').forEach(element => {
                if (!isInputLikeElement(element) || !isSensitiveElement(element)) return;
                redactedFieldCount++;
                if (element.hasAttribute('value')) element.setAttribute('value', '[REDACTED]');
                element.textContent = '';
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

        function isInputLikeElement(element) {
            if (!element || element.nodeType !== NodeObject.ELEMENT_NODE) return false;
            const tagName = element.tagName.toLowerCase();
            const role = (element.getAttribute('role') || '').toLowerCase();
            if (tagName === 'textarea') return true;
            if (tagName === 'input') {
                return !['button', 'submit', 'reset', 'hidden', 'checkbox', 'radio', 'file', 'image', 'range', 'color']
                    .includes((element.type || '').toLowerCase());
            }
            if (isContentEditableElement(element)) return true;
            return ['textbox', 'searchbox', 'combobox'].includes(role);
        }

        function isClickableLikeElement(element) {
            if (!element || element.nodeType !== NodeObject.ELEMENT_NODE) return false;
            const tagName = element.tagName.toLowerCase();
            const role = element.getAttribute('role');
            return (tagName === 'input' && ['submit', 'button', 'reset'].includes(
                (element.getAttribute('type') || element.type || '').toLowerCase())) ||
                ['a', 'button', 'summary', 'label', 'option', 'select'].includes(tagName) ||
                ['button', 'link', 'checkbox', 'radio', 'menuitem', 'tab', 'switch', 'option', 'treeitem'].includes(role) ||
                element.hasAttribute('onclick') ||
                element.hasAttribute('tabindex') ||
                windowObject.getComputedStyle(element).cursor === 'pointer';
        }

        function getElementKind(element) {
            if (!element || element.nodeType !== NodeObject.ELEMENT_NODE) return 'interactive';
            const tagName = element.tagName.toLowerCase();
            const role = (element.getAttribute('role') || '').toLowerCase();
            const type = (element.getAttribute('type') || element.type || '').toLowerCase();
            if ((tagName === 'input' && type === 'search') || role === 'searchbox' ||
                (isInputLikeElement(element) && inferInputSemanticLabel(element) === '搜索框')) return 'searchbox';
            if (tagName === 'textarea') return 'textarea';
            if (tagName === 'input' && type === 'checkbox') return 'checkbox';
            if (tagName === 'input' && type === 'radio') return 'radio';
            if (tagName === 'input' && !['button', 'submit', 'reset', 'hidden', 'checkbox', 'radio', 'file', 'image'].includes(type)) return 'input';
            if (tagName === 'button' || role === 'button' || (tagName === 'input' && ['button', 'submit', 'reset'].includes(type))) return 'button';
            if (tagName === 'a' && element.href) return 'link';
            if (tagName === 'select') return 'select';
            if (tagName === 'option' || role === 'option') return 'option';
            if (role === 'tab') return 'tab';
            if (role === 'switch') return 'switch';
            if (role === 'menuitem') return 'menuitem';
            if (['textbox', 'combobox'].includes(role) || isContentEditableElement(element)) return 'input';
            return 'interactive';
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

        function getDomPath(element) {
            const parts = [];
            let node = element;
            while (node && node.nodeType === NodeObject.ELEMENT_NODE &&
                node !== documentObject.body && node !== documentObject.documentElement) {
                const parent = node.parentElement;
                if (!parent) break;
                const siblings = Array.from(parent.children).filter(child => child.tagName === node.tagName);
                const index = siblings.indexOf(node) + 1;
                parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${Math.max(index, 1)})`);
                node = parent;
                if (parts.length >= 8) break;
            }
            return parts.join(' > ');
        }

        function buildCssSelector(element) {
            if (!element || element.nodeType !== NodeObject.ELEMENT_NODE) return '';
            if (element.id) return `#${safeCssEscape(element.id)}`;
            const tagName = element.tagName.toLowerCase();
            const attributes = [
                ['name', true],
                ['aria-label', true],
                ['placeholder', true],
                ['role', false]
            ];
            for (const [attribute] of attributes) {
                const value = element.getAttribute(attribute);
                if (value) return `${tagName}[${attribute}="${safeCssEscape(value)}"]`;
            }
            return getDomPath(element);
        }

        function createLocatorHints(element) {
            const hints = [];
            const tagName = element.tagName.toLowerCase();
            const definitions = [
                ['id', element.id, value => `#${safeCssEscape(value)}`, true],
                ['name', element.getAttribute('name'), value => `${tagName}[name="${safeCssEscape(value)}"]`, true],
                ['aria-label', element.getAttribute('aria-label'), value => `${tagName}[aria-label="${safeCssEscape(value)}"]`, true],
                ['placeholder', element.getAttribute('placeholder'), value => `${tagName}[placeholder="${safeCssEscape(value)}"]`, true],
                ['title', element.getAttribute('title'), value => `${tagName}[title="${safeCssEscape(value)}"]`, false],
                ['role', element.getAttribute('role'), value => `${tagName}[role="${safeCssEscape(value)}"]`, false]
            ];
            for (const [type, value, build, strong] of definitions) {
                if (value) hints.push({ type, selector: build(value), strong });
            }
            const cssSelector = buildCssSelector(element);
            if (cssSelector) hints.push({ type: 'css-path', selector: cssSelector, strong: false });
            return hints;
        }

        function getElementTextForSignature(element) {
            const tagName = element?.tagName?.toLowerCase?.() || '';
            const role = (element?.getAttribute?.('role') || '').toLowerCase();
            const inputLike = tagName === 'input' || tagName === 'textarea' ||
                ['combobox', 'searchbox', 'textbox'].includes(role) || isContentEditableElement(element);
            if (inputLike) {
                return normalizeAttribute(
                    inferInputSemanticLabel(element) ||
                    getSafeElementValue(element) ||
                    element.innerText ||
                    element.textContent
                );
            }
            return normalizeAttribute(
                getAccessibleName(element) ||
                element.innerText ||
                element.textContent ||
                element.value ||
                element.placeholder ||
                element.title
            );
        }

        function createElementSignature(element) {
            const rect = element.getBoundingClientRect();
            const container = element.closest?.('form,header,nav,main,aside,footer,dialog,[role="dialog"],[role="search"]');
            const svg = element.querySelector?.('svg');
            const path = svg?.querySelector?.('path');
            const use = svg?.querySelector?.('use');
            const buttons = Array.from(documentObject.querySelectorAll('button,a,[role="button"],input[type="submit"],input[type="button"]'));
            const siblingButtonHint = buttons.some(button => {
                if (button === element) return false;
                if (button.parentElement === element.parentElement) return true;
                const other = button.getBoundingClientRect();
                return (other.left >= rect.right && other.left - rect.right <= 80 &&
                    other.top <= rect.bottom + 80 && other.bottom >= rect.top) ||
                    (other.top >= rect.bottom && other.top - rect.bottom <= 80 &&
                    other.left <= rect.right + 80 && other.right >= rect.left);
            });
            const centerY = (rect.top + rect.height / 2) / Math.max(1, windowObject.innerHeight);
            const signature = {
                containerKind: container ? (container.getAttribute('role') || container.tagName.toLowerCase()) : '',
                siblingButtonHint,
                svgHint: svg ? `${svg.getAttribute('viewBox') || ''}|${use?.getAttribute('href') || use?.getAttribute('xlink:href') || simpleHash((path?.getAttribute('d') || '').slice(0, 24))}` : '',
                viewportZone: centerY < 1 / 3 ? 'top' : centerY > 2 / 3 ? 'bottom' : 'center',
                tagName: element.tagName.toLowerCase(),
                type: normalizeAttribute(element.getAttribute('type') || element.type),
                role: normalizeAttribute(element.getAttribute('role')),
                id: normalizeAttribute(element.id),
                name: normalizeAttribute(element.getAttribute('name')),
                ariaLabel: normalizeAttribute(element.getAttribute('aria-label')),
                ariaLabelledBy: normalizeAttribute(element.getAttribute('aria-labelledby')),
                accessibleName: getAccessibleName(element),
                placeholder: normalizeAttribute(element.getAttribute('placeholder')),
                title: normalizeAttribute(element.getAttribute('title')),
                text: getElementTextForSignature(element).slice(0, 160),
                href: normalizeAttribute(element.getAttribute('href')),
                cssSelector: buildCssSelector(element),
                domPath: getDomPath(element),
                isInputLike: isInputLikeElement(element),
                isClickableLike: isClickableLikeElement(element),
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

        function validateElementAgainstSignature(element, signature, validationOptions = {}) {
            if (!element || !signature) return { valid: false, score: 0, reason: '缺少元素或签名' };
            if (!element.isConnected) return { valid: false, score: 0, reason: '元素已脱离 DOM' };
            const current = createElementSignature(element);
            let score = 0;
            let total = 0;
            const add = (fraction, weight) => {
                total += weight;
                score += Number(fraction) * weight;
            };
            const functionalRole = sig => {
                if (sig.isInputLike || ['textarea'].includes(sig.tagName) ||
                    ['searchbox', 'textbox', 'combobox'].includes(sig.role) ||
                    (sig.tagName === 'input' && !['submit', 'button', 'checkbox', 'radio', 'hidden'].includes(sig.type))) return 'input';
                if (['button', 'a'].includes(sig.tagName) || sig.role === 'button' ||
                    (sig.tagName === 'input' && ['submit', 'button'].includes(sig.type))) return 'click';
                return '';
            };
            const equivalent = functionalRole(signature) && functionalRole(signature) === functionalRole(current);
            const weights = { tagName: 4, type: 1, role: 1, id: 4, name: 3, ariaLabel: 3,
                ariaLabelledBy: 2, accessibleName: 2, placeholder: 3, title: 1, href: 2, text: 1 };
            for (const [field, weight] of Object.entries(weights)) {
                if (typeof signature[field] !== 'string' || !signature[field].trim()) continue;
                const match = current[field] === signature[field] ? 1 :
                    field === 'tagName' && equivalent ? 0.85 :
                    ['text', 'accessibleName', 'ariaLabel', 'placeholder'].includes(field)
                        ? computeTextSimilarity(current[field], signature[field]) : 0;
                add(match, weight);
            }
            if (validationOptions.requireInputLike) add(current.isInputLike === true, 5);
            if (validationOptions.requireClickableLike) add(current.isClickableLike || current.isInputLike, 3);
            const ratio = total > 0 ? score / total : 0;
            const valid = ratio >= (validationOptions.minScore ?? 0.62);
            return {
                valid,
                score: ratio,
                reason: valid ? '签名匹配' : `元素签名不匹配，score=${ratio.toFixed(2)}`,
                current
            };
        }

        function isInteractive(element) {
            if (!element || element.nodeType !== NodeObject.ELEMENT_NODE) return false;
            const style = windowObject.getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden' ||
                Number.parseFloat(style.opacity || '1') <= 0 ||
                style.height === '0px' || style.width === '0px') return false;
            const tagName = element.tagName.toLowerCase();
            const role = (element.getAttribute('role') || '').toLowerCase();
            if (isInputLikeElement(element)) return true;
            if (['a', 'button', 'input', 'textarea', 'select', 'option'].includes(tagName)) return true;
            if (role && ['button', 'link', 'checkbox', 'radio', 'menuitem', 'tab', 'switch', 'option',
                'treeitem', 'searchbox', 'textbox', 'combobox'].includes(role)) return true;
            if (element.hasAttribute('onclick')) return true;
            if (element.hasAttribute('tabindex') && element.getAttribute('tabindex') !== '-1') return true;
            if (style.cursor === 'pointer') {
                if (tagName === 'body' || tagName === 'html') return false;
                if (!normalizeAttribute(element.innerText) && element.children.length > 0 && !role) return false;
                return true;
            }
            return false;
        }

        function getInteractiveElements(kind) {
            const normalizedKind = kind ? normalizeElementKind(kind) : null;
            return Array.from(documentObject.querySelectorAll(INTERACTIVE_SELECTOR))
                .filter(element => isInteractive(element) && (!normalizedKind || getElementKind(element) === normalizedKind));
        }

        function captureElementActionState(element) {
            if (!element) return null;
            const sensitive = isSensitiveElement(element);
            const value = isContentEditableElement(element) ? (element.textContent || '') : (element.value ?? '');
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
                url: documentObject.URL,
                active: documentObject.activeElement === element,
                connected: element.isConnected,
                rect: {
                    x: Math.round(rect.x),
                    y: Math.round(rect.y),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height)
                }
            };
        }

        function verifyInputAction(element, expectedText, beforeState, afterState, backendUsed = 'dom') {
            const expected = String(expectedText ?? '');
            const actual = isContentEditableElement(element) ? (element.textContent || '') : String(element.value ?? '');
            const sensitive = isSensitiveElement(element);
            return {
                attempted: true,
                verified: actual === expected,
                verificationType: sensitive ? 'sensitive-value-length-and-equality' : 'value-readback',
                beforeState,
                afterState,
                expected: sensitive && redactSensitiveDom ? { length: expected.length } : expected,
                actual: sensitive && redactSensitiveDom ? { length: actual.length, redacted: true } : actual,
                backendUsed,
                fallbackUsed: false,
                requiresFreshSnapshot: true
            };
        }

        function verifyClickAction(element, beforeState, afterState, backendUsed = 'dom') {
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
                backendUsed,
                fallbackUsed: false,
                requiresFreshSnapshot: true
            };
        }

        function setRedactionEnabled(enabled) {
            redactSensitiveDom = enabled !== false;
            return redactSensitiveDom;
        }

        function getCapabilities() {
            return {
                version: VERSION,
                accessibleName: true,
                classification: true,
                signatures: true,
                locatorHints: true,
                redaction: true,
                actionState: true,
                actionVerification: true
            };
        }

        return Object.freeze({
            version: VERSION,
            makeStructuredError,
            normalizeAttribute,
            normalizeText,
            simpleHash,
            computeTextSimilarity,
            safeCssEscape,
            getTextFromIdRefs,
            findLabelForInput,
            getAccessibleName,
            inferInputSemanticLabel,
            isSensitiveElement,
            shouldRedactElementValue,
            isContentEditableElement,
            getSafeElementValue,
            redactHtml,
            redactHtmlWithMetadata,
            isInputLikeElement,
            isClickableLikeElement,
            getElementKind,
            normalizeElementKind,
            createKindCounters,
            getDomPath,
            buildCssSelector,
            createLocatorHints,
            getElementTextForSignature,
            createElementSignature,
            validateElementAgainstSignature,
            isInteractive,
            getInteractiveElements,
            captureElementActionState,
            verifyInputAction,
            verifyClickAction,
            setRedactionEnabled,
            getCapabilities
        });
    }

    return Object.freeze({
        VERSION,
        SENSITIVE_FIELD_PATTERN,
        INTERACTIVE_SELECTOR,
        computeTextSimilarity,
        createWebAgentPageCore
    });
});