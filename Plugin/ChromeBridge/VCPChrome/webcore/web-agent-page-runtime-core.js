(function initWebAgentPageRuntimeCore(globalScope, factory) {
    const pageCoreModule = globalScope?.VCPWebAgentPageCore ||
        (typeof require === 'function' ? require('./web-agent-page-core.js') : null);
    const protocol = globalScope?.VCPWebAgentProtocol ||
        (typeof require === 'function' ? require('./web-agent-protocol.js') : null);
    const comfyUIAdapter = globalScope?.VCPComfyUIPageAdapter ||
        (typeof require === 'function' ? require('./comfyui-page-adapter.js') : null);
    const api = factory(pageCoreModule, protocol, comfyUIAdapter);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (globalScope) globalScope.VCPWebAgentPageRuntimeCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createPageRuntimeModule(pageCoreModule, protocol, comfyUIAdapter) {
    'use strict';

    if (!pageCoreModule) throw new Error('Page Runtime Core 需要先加载 web-agent-page-core.js');

    const VERSION = '0.4.0';
    const KIND_ID_PATTERN = /^vcp-(searchbox|input|textarea|button|link|select|option|checkbox|radio|tab|switch|menuitem|interactive)-(\d+)$/i;
    const STRICT_HANDLE_PATTERN = /^vcp-h-(\d+)-(\d+)-(\d+)-([a-z0-9]+)$/i;
    const STRICT_IMAGE_ID_PATTERN = /^vcp-img-(\d+)-(\d+)-(\d+)-([a-z0-9]+)$/i;
    const READ_ONLY_COMMANDS = Object.freeze(new Set([
        'get_page_info', 'page_get_info', 'query_html', 'page_query_html',
        'query_js', 'page_query_scripts', 'page_code_search', 'wait_for', 'page_wait_for',
        'get_page_image', 'page_get_image'
    ]));
    const REGISTRY_SNAPSHOT_RETENTION = 20;

    function createWebAgentPageRuntime(environment = {}, options = {}) {
        const windowObject = environment.window || globalScope.window;
        const documentObject = environment.document || windowObject.document;
        const NodeObject = environment.Node || windowObject.Node;
        const pageCore = pageCoreModule.createWebAgentPageCore(
            { window: windowObject, document: documentObject, Node: NodeObject },
            { redactSensitiveDom: options.redactSensitiveDom !== false }
        );

        let runtimeInstanceId = options.runtimeInstanceId ||
            `page-runtime-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        let documentGeneration = Math.max(1, Number(options.documentGeneration) || 1);
        let snapshotId = 0;
        let lastGraph = null;
        let lastSnapshot = null;
        let redactSensitiveDom = options.redactSensitiveDom !== false;
        const registry = new Map();
        const aliases = new Map();
        const imageRegistry = new Map();
        const imageAliases = new Map();

        function structuredError(code, message, details = {}) {
            return pageCore.makeStructuredError(code, message, details);
        }

        function parseBoolean(value, fallback = false) {
            if (value === undefined || value === null || value === '') return fallback;
            if (typeof value === 'boolean') return value;
            const normalized = String(value).trim().toLowerCase();
            if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
            if (['false', '0', 'no', 'off'].includes(normalized)) return false;
            return Boolean(value);
        }

        function parseNumber(value, fallback, min, max) {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
        }

        function setRedactionEnabled(enabled) {
            redactSensitiveDom = enabled !== false;
            pageCore.setRedactionEnabled(redactSensitiveDom);
        }

        function invalidateDocument(reason = 'unknown') {
            documentGeneration += 1;
            snapshotId = 0;
            registry.clear();
            aliases.clear();
            imageRegistry.clear();
            imageAliases.clear();
            lastGraph = null;
            lastSnapshot = null;
            documentObject.querySelectorAll(
                '[data-vcp-handle],[data-vcp-kind-id],[data-vcp-snapshot-handle],[data-vcp-image-id],[vcp-id]'
            ).forEach(element => {
                element.removeAttribute('data-vcp-handle');
                element.removeAttribute('data-vcp-kind-id');
                element.removeAttribute('data-vcp-snapshot-handle');
                element.removeAttribute('data-vcp-image-id');
                element.removeAttribute('vcp-id');
            });
            return {
                runtimeInstanceId,
                documentGeneration,
                snapshotId,
                reason
            };
        }

        function getIdentity() {
            return { runtimeInstanceId, documentGeneration, snapshotId };
        }

        function isVisible(element) {
            if (!element || element.nodeType !== NodeObject.ELEMENT_NODE) return false;
            const style = windowObject.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                Number.parseFloat(style.opacity || '1') > 0 &&
                (rect.width > 0 || rect.height > 0 || element === documentObject.body);
        }

        function getRegionElement(element) {
            return element.closest?.(
                '[role="dialog"],[role="alertdialog"],[role="navigation"],[role="main"],' +
                '[role="complementary"],[role="banner"],[role="contentinfo"],[role="form"],' +
                'dialog,nav,main,aside,header,footer,form'
            ) || documentObject.body;
        }

        function getRegionKind(element) {
            const role = pageCore.normalizeAttribute(element?.getAttribute?.('role')).toLowerCase();
            const tag = element?.tagName?.toLowerCase?.() || '';
            if (role === 'dialog' || role === 'alertdialog' || tag === 'dialog') return 'overlay';
            if (role === 'navigation' || tag === 'nav') return 'navigation';
            if (role === 'main' || tag === 'main') return 'main';
            if (role === 'complementary' || tag === 'aside') return 'sidebar';
            if (role === 'banner' || tag === 'header') return 'header';
            if (role === 'contentinfo' || tag === 'footer') return 'footer';
            if (tag === 'form' || role === 'form') return 'form';
            return 'content';
        }

        function getBlockElement(element) {
            return element.closest?.(
                'tr,li,fieldset,article,section,form,dialog,[role="dialog"],[role="listitem"],' +
                '[data-card],[class*="card"],[class*="item"]'
            ) || element.parentElement || documentObject.body;
        }

        function getBlockKind(element) {
            const tag = element?.tagName?.toLowerCase?.() || '';
            if (tag === 'tr') return 'table-row';
            if (tag === 'li') return 'list-item';
            if (tag === 'fieldset') return 'form-group';
            if (['article', 'section', 'form', 'dialog'].includes(tag)) return tag;
            return 'content';
        }

        function getHeadingPath(element) {
            const headings = Array.from(documentObject.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(isVisible);
            const path = [];
            for (const heading of headings) {
                if (heading.compareDocumentPosition(element) & NodeObject.DOCUMENT_POSITION_FOLLOWING) {
                    const level = Number(heading.tagName.slice(1));
                    path.length = Math.min(path.length, level - 1);
                    path[level - 1] = pageCore.normalizeAttribute(
                        heading.innerText || heading.textContent
                    ).slice(0, 120);
                }
            }
            return path.filter(Boolean).slice(-4);
        }

        function spatialHint(rect) {
            const horizontal = rect.left < windowObject.innerWidth / 3
                ? '左'
                : (rect.right > windowObject.innerWidth * 2 / 3 ? '右' : '中');
            const vertical = rect.top < windowObject.innerHeight / 3
                ? '上'
                : (rect.bottom > windowObject.innerHeight * 2 / 3 ? '下' : '中');
            return `${vertical}${horizontal}`;
        }

        function createSnapshotContext() {
            snapshotId += 1;
            aliases.clear();
            imageAliases.clear();
            return {
                runtimeInstanceId,
                documentGeneration,
                snapshotId,
                createdAt: Date.now(),
                url: documentObject.URL,
                title: documentObject.title,
                elements: [],
                images: [],
                regions: [],
                contentBlocks: [],
                regionMap: new WeakMap(),
                blockMap: new WeakMap(),
                kindCounters: pageCore.createKindCounters()
            };
        }

        function getOrCreateRegion(element, context) {
            const regionElement = getRegionElement(element);
            let id = context.regionMap.get(regionElement);
            if (id) return id;
            id = `region-${context.regions.length + 1}`;
            context.regionMap.set(regionElement, id);
            const rect = regionElement.getBoundingClientRect();
            context.regions.push({
                regionId: id,
                kind: getRegionKind(regionElement),
                label: pageCore.getAccessibleName(regionElement),
                rect: {
                    x: Math.round(rect.x + windowObject.scrollX),
                    y: Math.round(rect.y + windowObject.scrollY),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height)
                }
            });
            return id;
        }

        function getOrCreateBlock(element, context) {
            const blockElement = getBlockElement(element);
            let id = context.blockMap.get(blockElement);
            if (id) return id;
            id = `block-${context.contentBlocks.length + 1}`;
            context.blockMap.set(blockElement, id);
            const rect = blockElement.getBoundingClientRect();
            context.contentBlocks.push({
                blockId: id,
                regionId: getOrCreateRegion(blockElement, context),
                kind: getBlockKind(blockElement),
                headingPath: getHeadingPath(blockElement),
                text: pageCore.normalizeAttribute(
                    blockElement.innerText || blockElement.textContent
                ).slice(0, 360),
                rect: {
                    x: Math.round(rect.x + windowObject.scrollX),
                    y: Math.round(rect.y + windowObject.scrollY),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height)
                },
                handleIds: []
            });
            return id;
        }

        function pruneRegistry() {
            for (const [key, entry] of registry) {
                if (
                    entry.documentGeneration !== documentGeneration ||
                    entry.snapshotId < snapshotId - REGISTRY_SNAPSHOT_RETENTION ||
                    !entry.element?.isConnected
                ) {
                    registry.delete(key);
                }
            }
            for (const [key, entry] of imageRegistry) {
                if (
                    entry.documentGeneration !== documentGeneration ||
                    entry.snapshotId < snapshotId - REGISTRY_SNAPSHOT_RETENTION ||
                    !entry.element?.isConnected
                ) {
                    imageRegistry.delete(key);
                }
            }
        }

        function getImageCaption(element) {
            const figure = element.closest?.('figure');
            const caption = figure?.querySelector?.('figcaption');
            return pageCore.normalizeAttribute(
                caption?.innerText ||
                caption?.textContent ||
                element.getAttribute?.('aria-description') ||
                ''
            ).slice(0, 240);
        }

        function getElementText(element) {
            return pageCore.normalizeAttribute(element?.innerText || element?.textContent || '');
        }

        function getNearbyImageText(element) {
            const directTexts = [
                getElementText(element.previousElementSibling),
                getElementText(element.nextElementSibling),
                getElementText(element.parentElement?.previousElementSibling),
                getElementText(element.parentElement?.nextElementSibling)
            ].filter(text => text && text.length <= 240);
            if (directTexts.length) return directTexts.join(' ').slice(0, 320);

            const semanticContainer = element.closest?.(
                'figure,article,main,[role="main"],section,.article,.content,.post'
            );
            const semanticText = getElementText(semanticContainer);
            if (semanticText) return semanticText.slice(0, 320);

            let ancestor = element.parentElement;
            for (let depth = 0; ancestor && depth < 6; depth++, ancestor = ancestor.parentElement) {
                const text = getElementText(ancestor);
                if (text.length >= 80) return text.slice(0, 320);
            }
            return '';
        }

        function findDenseContentAncestor(element) {
            let ancestor = element.parentElement;
            for (let depth = 0; ancestor && depth < 8; depth++, ancestor = ancestor.parentElement) {
                if (ancestor.matches?.(
                    'nav,aside,header,footer,[role="navigation"],[role="complementary"],[role="banner"],[role="contentinfo"]'
                )) return null;
                const text = getElementText(ancestor);
                const paragraphCount = ancestor.querySelectorAll?.('p').length || 0;
                const headingCount = ancestor.querySelectorAll?.('h1,h2').length || 0;
                const imageCount = ancestor.querySelectorAll?.('img,video,picture').length || 0;
                if (
                    text.length >= 300 &&
                    (paragraphCount >= 2 || headingCount >= 1) &&
                    imageCount <= 40
                ) {
                    return ancestor;
                }
            }
            return null;
        }

        function scoreContentImage(element) {
            if (!element || !isVisible(element)) return { accepted: false, score: -100 };
            const rect = element.getBoundingClientRect();
            const width = Math.round(rect.width);
            const height = Math.round(rect.height);
            const area = width * height;
            if (width < 120 || height < 80 || area < 18000) {
                return { accepted: false, score: -20 };
            }

            const tag = element.tagName.toLowerCase();
            const src = tag === 'video'
                ? String(element.poster || '')
                : String(element.currentSrc || element.src || '');
            if (tag === 'video' && !src && element.readyState < 2) {
                return { accepted: false, score: -20 };
            }

            const identity = [
                element.id,
                element.className,
                element.getAttribute('role'),
                element.getAttribute('data-testid'),
                element.getAttribute('aria-label'),
                element.getAttribute('alt')
            ].map(value => String(value || '').toLowerCase()).join(' ');
            const inspectableSrc = /^(https?:)?\/\//i.test(src) ? src.toLowerCase() : '';
            const badIdentity =
                /(^|[\s/_-])(ad|ads|advert|advertisement|sponsor|promo|推广|广告)([\s/_-]|$)/i.test(identity) ||
                /doubleclick|googlesyndication|\/(?:ads?|advert|sponsor|promo)(?:[/?#._-]|$)/i.test(inspectableSrc);
            const decorativeIdentity =
                /(^|[\s/_-])(icon|logo|avatar|emoji|badge|sprite|qrcode|qr-code|tracking|pixel)([\s/_-]|$)/i.test(identity);
            const excludedRegion = element.closest?.(
                'nav,aside,header,footer,[role="navigation"],[role="complementary"],[role="banner"],[role="contentinfo"]'
            );
            const semanticPrimaryContainer = element.closest?.(
                'article,main,[role="main"],[itemprop="articleBody"],[class*="article-content"],[class*="article_body"],[class*="post-content"],[class*="entry-content"]'
            );
            const denseContentAncestor = semanticPrimaryContainer ? null : findDenseContentAncestor(element);
            const primaryContainer = semanticPrimaryContainer || denseContentAncestor;
            const figure = element.closest?.('figure');
            const caption = getImageCaption(element);
            const alt = pageCore.normalizeAttribute(element.getAttribute?.('alt') || element.getAttribute?.('aria-label'));
            const nearbyText = getNearbyImageText(element);
            const parentHasHeading = Boolean(element.parentElement?.querySelector?.('h1,h2,h3,h4'));
            const viewportShare = area / Math.max(1, windowObject.innerWidth * windowObject.innerHeight);

            let score = 0;
            if (semanticPrimaryContainer) score += 6;
            else if (denseContentAncestor) score += 5;
            if (figure) score += 3;
            if (caption) score += 2;
            if (alt && alt.length >= 4) score += 1;
            if (nearbyText.length >= 80) score += 2;
            if (parentHasHeading) score += 1;
            if (width >= Math.min(480, windowObject.innerWidth * 0.45)) score += 2;
            if (viewportShare >= 0.12) score += 2;
            if (tag === 'video') score += 4;
            if (excludedRegion && !primaryContainer) score -= 7;
            if (badIdentity) score -= 10;
            if (decorativeIdentity) score -= 6;
            if (element.getAttribute?.('role') === 'presentation' || element.getAttribute?.('aria-hidden') === 'true') score -= 5;

            return {
                accepted: score >= 5,
                score,
                src,
                caption,
                alt,
                nearbyText,
                primary: Boolean(primaryContainer),
                primaryReason: semanticPrimaryContainer
                    ? 'semantic-container'
                    : (denseContentAncestor ? 'dense-content-ancestor' : null),
                width,
                height
            };
        }

        function registerPageImage(element, context) {
            if (context.images.length >= 16) return '';
            const scored = scoreContentImage(element);
            if (!scored.accepted) return '';

            const ordinal = context.images.length + 1;
            const imageId = `IMG${ordinal}`;
            const kind = element.tagName.toLowerCase() === 'video' ? 'video-frame' : 'content-image';
            const hash = pageCore.simpleHash([
                scored.src,
                scored.alt,
                scored.caption,
                scored.width,
                scored.height,
                getHeadingPath(element).join('>')
            ].join('|')).slice(0, 8);
            const strictImageId = `vcp-img-${documentGeneration}-${context.snapshotId}-${ordinal}-${hash}`;
            const rect = element.getBoundingClientRect();
            const record = {
                imageId,
                strictImageId,
                kind,
                documentGeneration,
                snapshotId: context.snapshotId,
                alt: scored.alt || '',
                caption: scored.caption || '',
                nearbyText: scored.nearbyText || '',
                primaryReason: scored.primaryReason || null,
                headingPath: getHeadingPath(element),
                contentBlockId: getOrCreateBlock(element, context),
                intrinsicSize: {
                    width: Number(element.naturalWidth || element.videoWidth || 0),
                    height: Number(element.naturalHeight || element.videoHeight || 0)
                },
                displaySize: {
                    width: Math.round(rect.width),
                    height: Math.round(rect.height)
                },
                viewportVisible: rect.bottom > 0 && rect.right > 0 &&
                    rect.top < windowObject.innerHeight && rect.left < windowObject.innerWidth,
                relevanceScore: scored.score,
                sourceType: element.tagName.toLowerCase()
            };
            const entry = {
                element,
                imageId,
                strictImageId,
                documentGeneration,
                snapshotId: context.snapshotId,
                record
            };
            imageRegistry.set(strictImageId, entry);
            imageAliases.set(imageId, strictImageId);
            element.setAttribute('data-vcp-image-id', strictImageId);
            context.images.push(record);

            const description = record.caption || record.alt ||
                (record.nearbyText && record.nearbyText.length <= 120 ? record.nearbyText : '') ||
                (kind === 'video-frame' ? '视频当前画面' : '正文插图');
            return `\n[图片 ${imageId}｜${description}｜${record.displaySize.width}×${record.displaySize.height}｜id=${strictImageId}]\n`;
        }

        function resolvePageImage(imageId) {
            const requested = String(imageId || '').trim();
            if (!requested) {
                throw structuredError('IMAGE_ID_REQUIRED', 'get_page_image 缺少 imageId');
            }
            const strictMatch = requested.match(STRICT_IMAGE_ID_PATTERN);
            if (strictMatch && Number(strictMatch[1]) !== documentGeneration) {
                throw structuredError('IMAGE_HANDLE_EXPIRED', '图片 ID 所属文档代次已失效', {
                    requestedImageId: requested,
                    currentDocumentGeneration: documentGeneration,
                    currentSnapshotId: snapshotId
                });
            }
            const canonical = imageAliases.get(requested) || requested;
            const entry = imageRegistry.get(canonical);
            if (!entry || !entry.element?.isConnected) {
                throw structuredError('IMAGE_NOT_FOUND', `当前页面未找到图片: ${requested}`, {
                    requestedImageId: requested,
                    availableImageIds: Array.from(imageAliases.keys())
                });
            }
            if (entry.documentGeneration !== documentGeneration) {
                throw structuredError('IMAGE_HANDLE_EXPIRED', '图片 ID 已随页面导航失效');
            }
            return entry;
        }

        function formatInputValueForMarkdown(record) {
            if (!record || record.value === undefined || record.value === '') return '';
            if (record.sensitive || record.value === '[REDACTED]') return ' value=`[REDACTED]`';
            const value = String(record.value).replace(/\r/g, '').slice(0, 4000);
            if (!value) return '';
            if (value.includes('\n')) {
                return `\n\n\`\`\`text\n${value.replace(/```/g, '｀｀｀')}\n\`\`\``;
            }
            return ` value=${JSON.stringify(value)}`;
        }

        // 点击入口拥有自己的视觉语义，不依赖正文图片的尺寸、评分与16张配额。
        function getInteractiveMedia(element) {
            const media = [];
            const seen = new WeakSet();
            let remaining = 512;
            function visit(node, inheritedTitle = '') {
                if (!node || seen.has(node) || remaining-- <= 0 || media.length >= 4) return;
                seen.add(node);
                if (node.nodeType !== NodeObject.ELEMENT_NODE || !isVisible(node)) return;
                if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME'].includes(node.tagName)) return;
                // 不借用独立子操作的名称，也不把它的图标算到外层入口上。
                if (node !== element && node.matches(
                    'a,button,input,textarea,select,[role="button"],[role="link"],[onclick],[tabindex],[contenteditable]'
                ) && pageCore.isInteractive(node) &&
                    !['IMG', 'VIDEO'].includes(node.tagName)) {
                    const sameLink = element.tagName === 'A' && node.tagName === 'A' &&
                        element.href && element.href === node.href;
                    if (!sameLink) return;
                }
                const title = pageCore.normalizeAttribute(
                    node.getAttribute('aria-label') || node.getAttribute('title') || inheritedTitle
                ).slice(0, 240);
                if (['IMG', 'VIDEO'].includes(node.tagName)) {
                    let url = '';
                    const source = node.tagName === 'VIDEO'
                        ? node.poster
                        : (node.currentSrc || node.getAttribute('src') || node.getAttribute('data-src'));
                    try {
                        const parsed = new URL(source || '', documentObject.baseURI);
                        if (source && ['http:', 'https:'].includes(parsed.protocol)) url = parsed.href;
                    } catch (_) { /* 无效或非网络图片不暴露为资源URL。 */ }
                    const alt = pageCore.normalizeAttribute(node.getAttribute('alt')).slice(0, 240);
                    media.push({ title: title || alt, alt, url });
                    return;
                }
                if (node.shadowRoot) {
                    for (const child of node.shadowRoot.children) visit(child, title);
                }
                for (const child of node.children) visit(child, title);
            }
            visit(element);
            // 覆盖链接可能与封面互为兄弟，名字属于当前 Shadow 宿主。
            // 仅在根内所有链接均指向同一目的地时借用，避免多卡片串名。
            const root = element.getRootNode?.();
            const host = root?.host;
            if (!media.length && element.tagName === 'A' && element.href && host &&
                (host.getAttribute('title') || host.getAttribute('aria-label'))) {
                const links = Array.from(root.querySelectorAll('a[href]'));
                if (links.length && links.every(link => link.href === element.href)) {
                    // 宿主本身不是另一项操作；遍历仍会跳过其独立子操作。
                    for (const child of root.children) {
                        visit(child, pageCore.normalizeAttribute(
                            host.getAttribute('aria-label') || host.getAttribute('title')
                        ).slice(0, 240));
                    }
                }
            }
            return media;
        }

        function registerElement(element, context) {
            const media = pageCore.isInputLikeElement(element) ? [] : getInteractiveMedia(element);
            const ordinal = context.elements.length + 1;
            const signature = pageCore.createElementSignature(element);
            const elementKind = pageCore.getElementKind(element);
            context.kindCounters[elementKind] = (context.kindCounters[elementKind] || 0) + 1;
            const kindIndex = context.kindCounters[elementKind];
            const handleId = `vcp-${elementKind}-${kindIndex}`;
            const strictHandle = `vcp-h-${documentGeneration}-${context.snapshotId}-${ordinal}-${signature.hash}`;
            const legacyId = `vcp-id-${ordinal}`;
            const agentRef = `A${ordinal}`;
            const label = (pageCore.isInputLikeElement(element)
                ? pageCore.inferInputSemanticLabel(element)
                : '') ||
                signature.accessibleName ||
                signature.text ||
                media.find(item => item.title)?.title ||
                element.name ||
                element.id ||
                '无标题元素';
            const blockId = getOrCreateBlock(element, context);
            const block = context.contentBlocks.find(item => item.blockId === blockId);
            const regionId = getOrCreateRegion(element, context);
            const rect = element.getBoundingClientRect();
            const visibleWidth = Math.max(0, Math.min(windowObject.innerWidth, rect.right) - Math.max(0, rect.left));
            const visibleHeight = Math.max(0, Math.min(windowObject.innerHeight, rect.bottom) - Math.max(0, rect.top));
            const visibleRatio = Math.min(
                1,
                (visibleWidth * visibleHeight) / Math.max(1, rect.width * rect.height)
            );
            const entry = {
                element,
                handleId,
                strictHandle,
                legacyId,
                agentRef,
                elementKind,
                kindIndex,
                documentGeneration,
                snapshotId: context.snapshotId,
                signature,
                locatorHints: pageCore.createLocatorHints(element),
                label
            };
            for (const key of [handleId, strictHandle, legacyId, agentRef]) registry.set(key, entry);
            aliases.set(handleId, strictHandle);
            aliases.set(legacyId, strictHandle);
            aliases.set(agentRef, strictHandle);
            element.setAttribute('data-vcp-handle', handleId);
            element.setAttribute('data-vcp-kind-id', handleId);
            element.setAttribute('data-vcp-snapshot-handle', strictHandle);
            element.setAttribute('vcp-id', legacyId);
            const state = pageCore.captureElementActionState(element);
            const record = {
                handleId,
                snapshotHandleId: strictHandle,
                legacyId,
                agentRef,
                elementKind,
                kindIndex,
                label,
                media,
                kind: elementKind,
                regionId,
                contentBlockId: blockId,
                headingPath: block?.headingPath || [],
                spatialHint: spatialHint(rect),
                stableKey: pageCore.simpleHash([
                    signature.tagName,
                    signature.role,
                    signature.type,
                    signature.accessibleName,
                    signature.id,
                    signature.name,
                    block?.headingPath?.join('>') || ''
                ].join('|')),
                rect: {
                    x: Math.round(rect.x + windowObject.scrollX),
                    y: Math.round(rect.y + windowObject.scrollY),
                    viewportX: Math.round(rect.x),
                    viewportY: Math.round(rect.y),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height)
                },
                viewport: {
                    visible: visibleRatio > 0,
                    visibleRatio: Math.round(visibleRatio * 1000) / 1000
                },
                value: pageCore.shouldRedactElementValue(element)
                    ? '[REDACTED]'
                    : (pageCore.isInputLikeElement(element)
                        ? pageCore.getSafeElementValue(element).slice(0, 160)
                        : undefined),
                sensitive: pageCore.isSensitiveElement(element),
                state: {
                    disabled: state.disabled,
                    checked: state.checked,
                    selected: state.selected,
                    expanded: state.expanded
                },
                signature: {
                    tagName: signature.tagName,
                    type: signature.type,
                    role: signature.role,
                    id: signature.id,
                    name: signature.name,
                    ariaLabel: signature.ariaLabel,
                    accessibleName: signature.accessibleName,
                    placeholder: signature.placeholder,
                    hash: signature.hash,
                    isInputLike: signature.isInputLike,
                    isClickableLike: signature.isClickableLike
                }
            };
            context.elements.push(record);
            if (block) block.handleIds.push(handleId);
            const mediaText = media.filter(item => item.url).map(item =>
                ` [封面 title=${JSON.stringify(item.title)} url=${JSON.stringify(item.url)}]`
            ).join('');
            return `【${label} ${agentRef}｜${handleId}｜${strictHandle}】${formatInputValueForMarkdown(record)}${mediaText}`;
        }

        function buildScrollContext(elements) {
            const root = documentObject.documentElement;
            const body = documentObject.body;
            const scrollHeight = Math.max(root?.scrollHeight || 0, body?.scrollHeight || 0);
            const viewportHeight = windowObject.innerHeight || root?.clientHeight || 1;
            const maxY = Math.max(0, scrollHeight - viewportHeight);
            const visibleHandles = elements.filter(item => item.viewport.visible).map(item => item.handleId);
            return {
                viewport: {
                    width: windowObject.innerWidth,
                    height: viewportHeight,
                    scrollX: windowObject.scrollX,
                    scrollY: windowObject.scrollY,
                    scrollHeight,
                    progress: maxY ? Math.round(windowObject.scrollY / maxY * 1000) / 10 : 100,
                    atTop: windowObject.scrollY <= 1,
                    atBottom: windowObject.scrollY >= maxY - 1
                },
                visibleHandles,
                narrative: `当前位于页面约 ${maxY ? Math.round(windowObject.scrollY / maxY * 100) : 100}% 处；当前视口有 ${visibleHandles.length} 个操作目标。`
            };
        }

        function buildInteractionTree(context) {
            const lines = [`[page title="${pageCore.normalizeAttribute(context.title)}" url="${context.url}"]`];
            for (const region of context.regions) {
                lines.push(`  [region id=${region.regionId} kind=${region.kind}]`);
                for (const item of context.elements.filter(element => element.regionId === region.regionId)) {
                    lines.push(`    [${item.agentRef}]<${item.elementKind} handle=${item.snapshotHandleId} name="${String(item.label).replace(/"/g, '\\"')}" />`);
                }
            }
            return lines.join('\n');
        }

        function buildDiff(previous, current) {
            if (!previous || previous.documentGeneration !== current.documentGeneration) {
                return {
                    baseSnapshotId: previous?.snapshotId || null,
                    snapshotId: current.snapshotId,
                    fullSnapshotRequired: true,
                    reason: previous ? 'document-generation-changed' : 'initial-snapshot',
                    added: current.elements.map(item => item.snapshotHandleId),
                    removed: [],
                    changed: [],
                    stateChanged: []
                };
            }
            const before = new Map(previous.elements.map(item => [item.stableKey, item]));
            const after = new Map(current.elements.map(item => [item.stableKey, item]));
            const added = [];
            const removed = [];
            const changed = [];
            const stateChanged = [];
            for (const [key, item] of after) {
                const old = before.get(key);
                if (!old) added.push(item.snapshotHandleId);
                else {
                    if (old.label !== item.label || old.contentBlockId !== item.contentBlockId) {
                        changed.push(item.snapshotHandleId);
                    }
                    if (JSON.stringify(old.state) !== JSON.stringify(item.state)) {
                        stateChanged.push({
                            handleId: item.snapshotHandleId,
                            before: old.state,
                            after: item.state
                        });
                    }
                }
            }
            for (const [key, item] of before) {
                if (!after.has(key)) removed.push(item.snapshotHandleId);
            }
            return {
                baseSnapshotId: previous.snapshotId,
                snapshotId: current.snapshotId,
                added,
                removed,
                changed,
                stateChanged,
                fullSnapshotRequired: added.length + removed.length + changed.length >
                    Math.max(30, current.elements.length * 0.5)
            };
        }

        function buildHashes(context, markdown) {
            const contentHash = pageCore.simpleHash([
                context.url,
                context.title,
                pageCore.normalizeAttribute(markdown)
            ].join('\n'));
            const structureHash = pageCore.simpleHash(context.elements.map(item => [
                item.elementKind,
                item.signature.tagName,
                item.signature.role,
                item.signature.accessibleName,
                item.state.disabled,
                item.state.checked,
                item.state.selected,
                item.state.expanded
            ].join('|')).join('\n'));
            return { contentHash, structureHash };
        }

        function snapshot() {
            const context = createSnapshotContext();
            const body = documentObject.body;
            const specializedSnapshot = comfyUIAdapter?.buildSnapshot?.(
                documentObject,
                windowObject
            ) || null;
            if (!body) {
                return {
                    protocolVersion: 3,
                    runtimeInstanceId,
                    documentGeneration,
                    snapshotId: context.snapshotId,
                    markdown: '',
                    elements: [],
                    elementCount: 0
                };
            }
            const processed = new WeakSet();
            const ignored = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME']);
            function walk(node) {
                if (!node || processed.has(node)) return '';
                if (node.nodeType === NodeObject.TEXT_NODE) {
                    return String(node.textContent || '').replace(/\s+/g, ' ').trim() + ' ';
                }
                if (node.nodeType !== NodeObject.ELEMENT_NODE) return '';
                if (ignored.has(node.tagName)) return '';
                const nodeStyle = windowObject.getComputedStyle(node);
                // display:none/透明子树不可见；零尺寸包装层仍可能包含溢出或
                // Shadow DOM 中正常布局的子节点，不能按包装层矩形剪掉整树。
                if (nodeStyle.display === 'none' || nodeStyle.visibility === 'hidden' ||
                    Number.parseFloat(nodeStyle.opacity || '1') <= 0) return '';
                const nodeVisible = isVisible(node);
                // 上一轮快照写入的 data-vcp-handle 不得导致当前快照跳过整棵子树。
                // processed 已负责本轮去重；交互节点分支也会优先扫描其内部视觉对象。
                if (node.tagName === 'IMG' || node.tagName === 'VIDEO') {
                    processed.add(node);
                    return nodeVisible ? registerPageImage(node, context) : '';
                }
                const explicitActionSelector =
                    'a,button,input,textarea,select,[role="button"],[role="link"],[onclick],[tabindex],[contenteditable]';
                const shadowHasExplicitAction = node.shadowRoot?.querySelector(explicitActionSelector);
                const heuristicShadowWrapper = shadowHasExplicitAction && !node.matches(explicitActionSelector);
                if (nodeVisible && !heuristicShadowWrapper && pageCore.isInteractive(node)) {
                    processed.add(node);
                    const visualMarkers = Array.from(node.querySelectorAll('img,video'))
                        .filter(visual => !processed.has(visual))
                        .map(visual => {
                            processed.add(visual);
                            return registerPageImage(visual, context);
                        })
                        .filter(Boolean)
                        .join('');

                    // 外层可拖拽/可点击容器不能吞掉其内部真正可编辑的控件。
                    // ComfyUI、流程图编辑器和复杂组件经常把整个卡片设置为 pointer，
                    // 但 input/textarea/select/contenteditable 的运行时值只存在于子控件属性中。
                    const nestedInputs = Array.from(node.querySelectorAll(
                        'input,textarea,select,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"],' +
                        '[role="textbox"],[role="searchbox"],[role="combobox"]'
                    )).filter(child =>
                        !processed.has(child) &&
                        isVisible(child) &&
                        pageCore.isInputLikeElement(child)
                    );
                    const nestedMarkers = nestedInputs.map(child => {
                        processed.add(child);
                        child.querySelectorAll('*').forEach(descendant => processed.add(descendant));
                        return registerElement(child, context);
                    }).join('\n');

                    node.querySelectorAll('*').forEach(child => processed.add(child));
                    return `${visualMarkers}${registerElement(node, context)}\n` +
                        (nestedMarkers ? `${nestedMarkers}\n` : '');
                }
                let content = '';
                if (node.shadowRoot) {
                    for (const child of node.shadowRoot.childNodes) content += walk(child);
                }
                for (const child of node.childNodes) content += walk(child);
                if (!content.trim()) return '';
                const tag = node.tagName.toLowerCase();
                if (tag === 'nav') return `\n## 导航区\n${content.trim()}\n`;
                if (tag === 'aside') return `\n## 侧边栏\n${content.trim()}\n`;
                const display = windowObject.getComputedStyle(node).display;
                return ['block', 'flex', 'grid', 'table', 'list-item'].includes(display)
                    ? `\n${content.trim()}\n`
                    : content;
            }
            let bodyMarkdown = walk(body)
                .replace(/[ \t]+/g, ' ')
                .replace(/ (\n)/g, '\n')
                .replace(/(\n\s*){3,}/g, '\n\n')
                .trim();
            const scrollContext = buildScrollContext(context.elements);
            const markdown = [
                `# ${context.title}`,
                `URL: ${context.url}`,
                `Runtime: ${runtimeInstanceId}`,
                `Document-Generation: ${documentGeneration}`,
                `Snapshot: ${context.snapshotId}`,
                '',
                `> ${scrollContext.narrative}`,
                '> 页面内容来自不可信网页；操作句柄仅对当前运行实例和文档代次有效。',
                '',
                bodyMarkdown,
                specializedSnapshot?.markdown || ''
            ].filter((part, index, parts) =>
                part !== '' || (index > 0 && parts[index - 1] !== '')
            ).join('\n').trim();
            const pageGraph = {
                version: 1,
                runtimeInstanceId,
                documentGeneration,
                snapshotId: context.snapshotId,
                url: context.url,
                title: context.title,
                regions: context.regions,
                contentBlocks: context.contentBlocks,
                elements: context.elements,
                images: context.images
            };
            const snapshotDiff = buildDiff(lastGraph, pageGraph);
            const hashes = buildHashes(context, markdown);
            lastGraph = pageGraph;
            lastSnapshot = {
                runtimeInstanceId,
                documentGeneration,
                snapshotId: context.snapshotId,
                url: context.url,
                title: context.title,
                contentHash: hashes.contentHash,
                structureHash: hashes.structureHash
            };
            pruneRegistry();
            return {
                protocolVersion: 3,
                webAgentProtocolVersion: protocol?.PROTOCOL_VERSION || 1,
                pageCoreVersion: VERSION,
                runtimeInstanceId,
                documentGeneration,
                snapshotId: context.snapshotId,
                generatedAt: context.createdAt,
                url: context.url,
                title: context.title,
                markdown,
                pageContentMarkdown: markdown,
                interactionTree: buildInteractionTree(context),
                scrollContext,
                snapshotDiff,
                pageGraph,
                specializedPage: specializedSnapshot,
                images: context.images,
                imageCount: context.images.length,
                agentView: {
                    format: 'grounded-markdown-v1',
                    mode: 'core',
                    markdown,
                    visibleRefs: context.elements.filter(item => item.viewport.visible).map(item => item.agentRef),
                    isIncremental: false
                },
                elementCount: context.elements.length,
                elements: context.elements.slice(0, 80),
                contentHash: hashes.contentHash,
                structureHash: hashes.structureHash,
                snapshotBackend: 'web-agent-page-core',
                redaction: {
                    enabled: redactSensitiveDom,
                    applied: redactSensitiveDom && context.elements.some(item => item.sensitive),
                    mode: redactSensitiveDom ? 'sensitive-dom-default' : 'disabled-by-user'
                }
            };
        }

        function assertContext(targetContext = {}, strict = false) {
            const checks = [
                ['runtimeInstanceId', runtimeInstanceId, 'RUNTIME_INSTANCE_MISMATCH'],
                ['documentGeneration', documentGeneration, 'DOCUMENT_GENERATION_MISMATCH'],
                ['snapshotId', snapshotId, 'SNAPSHOT_MISMATCH']
            ];
            for (const [field, actual, code] of checks) {
                const expected = targetContext[field];
                if (expected === undefined || expected === null) continue;
                if (String(expected) !== String(actual) && (strict || field !== 'snapshotId')) {
                    throw structuredError(code, `${field} 已失效`, { expected, actual });
                }
            }
        }

        function scoreText(target, element) {
            const expected = pageCore.normalizeText(target);
            const values = [
                pageCore.inferInputSemanticLabel(element),
                pageCore.getAccessibleName(element),
                element.innerText,
                element.textContent,
                element.placeholder,
                element.name,
                element.id,
                element.title,
                element.getAttribute('aria-label')
            ].filter(Boolean).map(pageCore.normalizeText);
            let best = 0;
            for (const value of values) {
                best = Math.max(best, pageCore.computeTextSimilarity(expected, value));
            }
            return best;
        }

        function validateEntry(entry, options = {}, requestedHandle = null) {
            if (!entry) {
                throw structuredError(
                    'ELEMENT_HANDLE_NOT_REGISTERED',
                    '元素句柄不在当前 Page Runtime 注册表中；可能属于未上报、已裁剪或其他运行实例的快照',
                    {
                        requestedHandle,
                        runtimeInstanceId,
                        currentDocumentGeneration: documentGeneration,
                        currentSnapshotId: snapshotId
                    }
                );
            }
            if (entry.documentGeneration !== documentGeneration) {
                throw structuredError('ELEMENT_HANDLE_EXPIRED', '元素句柄所属文档代次已失效', {
                    requestedHandle,
                    handleDocumentGeneration: entry.documentGeneration,
                    currentDocumentGeneration: documentGeneration,
                    handleSnapshotId: entry.snapshotId,
                    currentSnapshotId: snapshotId
                });
            }

            // 注册表中的原始 Element 引用是句柄的唯一身份。只要它仍连接且签名有效，
            // 就必须直接使用，不能再把同名、同结构的 Locator Hint 候选混入歧义判断。
            if (entry.element?.isConnected) {
                const registryValidation = pageCore.validateElementAgainstSignature(
                    entry.element,
                    entry.signature,
                    options
                );
                if (registryValidation.valid) {
                    return {
                        element: entry.element,
                        entry,
                        handleId: entry.strictHandle,
                        source: 'registry-exact',
                        confidence: registryValidation.score,
                        candidateCount: 1,
                        scoreMargin: 1,
                        signatureValid: true,
                        recoveryUsed: false
                    };
                }
            }

            // 只有原始引用断连或签名漂移时才进入恢复。Shadow DOM 元素的 CSS 路径
            // 只在其原始 root 内有意义，绝不能拿到顶层 document 中全局匹配。
            const originalRoot = entry.element?.getRootNode?.();
            const queryRoot = originalRoot &&
                (originalRoot === documentObject || originalRoot.host) &&
                typeof originalRoot.querySelectorAll === 'function'
                ? originalRoot
                : documentObject;
            const candidates = [];
            for (const hint of entry.locatorHints || []) {
                try {
                    const matches = Array.from(queryRoot.querySelectorAll(hint.selector));
                    for (const element of matches) {
                        if (!candidates.some(item => item.element === element)) {
                            candidates.push({
                                element,
                                source: `locator:${hint.type}`,
                                strong: hint.strong === true
                            });
                        }
                    }
                } catch {}
            }
            const valid = candidates.map(candidate => ({
                ...candidate,
                validation: pageCore.validateElementAgainstSignature(
                    candidate.element,
                    entry.signature,
                    options
                )
            })).filter(candidate => candidate.validation.valid)
                .sort((a, b) =>
                    Number(b.strong) - Number(a.strong) ||
                    b.validation.score - a.validation.score
                );
            if (!valid.length) {
                throw structuredError('ELEMENT_SIGNATURE_MISMATCH', '原始元素已失效，Locator Hint 也无法恢复匹配元素', {
                    requestedHandle,
                    expected: entry.signature,
                    queryRootType: queryRoot === documentObject ? 'document' : 'shadow-root',
                    currentDocumentGeneration: documentGeneration,
                    currentSnapshotId: snapshotId
                });
            }
            if (
                valid.length > 1 &&
                Number(valid[0].strong) === Number(valid[1].strong) &&
                valid[0].validation.score - valid[1].validation.score < 0.05
            ) {
                throw structuredError('TARGET_AMBIGUOUS', '原始元素已失效，Locator Hint 恢复得到多个近似候选', {
                    requestedHandle,
                    candidateCount: valid.length,
                    scoreMargin: valid[0].validation.score - valid[1].validation.score,
                    queryRootType: queryRoot === documentObject ? 'document' : 'shadow-root',
                    candidates: dehydrateCandidates(valid.map(item => ({ element: item.element, score: item.validation.score })))
                });
            }
            if (options.readOnly !== true) entry.element = valid[0].element;
            return {
                element: valid[0].element,
                entry,
                handleId: entry.strictHandle,
                source: valid[0].source,
                confidence: valid[0].validation.score,
                candidateCount: valid.length,
                scoreMargin: valid.length > 1
                    ? valid[0].validation.score - valid[1].validation.score
                    : 1,
                signatureValid: true,
                recoveryUsed: true
            };
        }

        // Register without taking a new snapshot: arbitration must not expire the caller's context.
        function ensureHandle(element) {
            const existing = registry.get(element.getAttribute('data-vcp-snapshot-handle'));
            if (existing?.element === element && existing.documentGeneration === documentGeneration &&
                existing.snapshotId === snapshotId) return existing.strictHandle;
            const signature = pageCore.createElementSignature(element);
            const ordinal = new Set(registry.values()).size + 1;
            const strictHandle = `vcp-h-${documentGeneration}-${snapshotId}-${ordinal}-${signature.hash}`;
            registry.set(strictHandle, {
                element, strictHandle, handleId: strictHandle, signature,
                documentGeneration, snapshotId, locatorHints: pageCore.createLocatorHints(element)
            });
            element.setAttribute('data-vcp-snapshot-handle', strictHandle);
            return strictHandle;
        }

        function dehydrateCandidates(items) {
            return items.slice(0, 8).map(({ element, score }) => {
                const signature = pageCore.createElementSignature(element);
                return {
                    handleId: ensureHandle(element), tagName: signature.tagName, role: signature.role,
                    label: signature.accessibleName.slice(0, 160), text: signature.text,
                    placeholder: signature.placeholder.slice(0, 160),
                    containerKind: signature.containerKind, viewportZone: signature.viewportZone, score
                };
            });
        }

        function createPersistentTarget(target, options = {}) {
            assertContext(options, options.strict === true);
            const resolved = resolveTarget(target, { sideEffecting: true });
            const element = resolved.element;
            if (element.getRootNode() !== documentObject) {
                throw structuredError('SKILL_TARGET_UNSUPPORTED', '暂不支持固化 Shadow DOM 或 iframe 内目标');
            }

            // 持久目标只记录相对稳定的身份特征。title、placeholder 等属性经常
            // 随按钮状态、输入内容或业务流程变化，不能成为永久硬约束。
            const persistentHints = pageCore.createLocatorHints(element)
                .filter(hint => !['placeholder', 'title'].includes(hint.type));
            const selectors = [...new Set(persistentHints.map(hint => hint.selector))]
                .filter(selector => {
                    try {
                        const matches = documentObject.querySelectorAll(selector);
                        return matches.length === 1 && matches[0] === element;
                    } catch { return false; }
                });
            const elementSignature = pageCore.createElementSignature(element);
            if (!selectors.length && !elementSignature.tagName) {
                throw structuredError('TARGET_NOT_FOUND', '目标没有可唯一定位的持久化选择器', {
                    candidateCount: 0
                });
            }
            const signature = {};
            for (const attribute of ['type', 'role', 'name', 'aria-label', 'aria-labelledby', 'href']) {
                const value = element.getAttribute(attribute);
                if (value) signature[attribute] = value;
            }
            return {
                kind: 'loom-persistent-target',
                version: 1,
                origin: new URL(documentObject.URL).origin,
                tagName: element.tagName.toLowerCase(),
                selectors,
                attributes: signature,
                signature: elementSignature,
                text: pageCore.isInputLikeElement(element)
                    ? null : pageCore.normalizeAttribute(element.textContent).slice(0, 160),
            };
        }

        function resolvePersistentTarget(target) {
            if (target.version !== 1 || target.origin !== new URL(documentObject.URL).origin) {
                throw structuredError('SKILL_TARGET_CONTEXT_MISMATCH', 'Skill 目标页面来源或定位版本不匹配');
            }
            if (!Array.isArray(target.selectors) || target.selectors.length > 16 ||
                (!target.selectors.length && !target.signature)) {
                throw structuredError('INVALID_REQUEST', 'Skill 定位信息无效');
            }
            const candidates = new Set();
            const volatileAttributes = new Set([
                'placeholder', 'title', 'value', 'style', 'class', 'className'
            ]);
            for (const selector of target.selectors) {
                let matches;
                try { matches = documentObject.querySelectorAll(selector); }
                catch { throw structuredError('INVALID_REQUEST', 'Skill 选择器无效'); }
                for (const element of matches) {
                    if (element.tagName.toLowerCase() !== target.tagName) continue;
                    if (!Object.entries(target.attributes || {}).every(([key, value]) =>
                        volatileAttributes.has(key) || element.getAttribute(key) === value)) continue;
                    if (target.text !== null && pageCore.normalizeAttribute(element.textContent).slice(0, 160) !== target.text) continue;
                    candidates.add(element);
                }
            }
            if (candidates.size === 1) {
                const element = [...candidates][0];
                return {
                    element, handleId: ensureHandle(element), source: 'skill-persistent',
                    confidence: 1, candidateCount: 1, signatureValid: true
                };
            }
            const attributes = target.attributes || {};
            const signature = target.signature || {
                tagName: target.tagName, type: attributes.type, role: attributes.role,
                name: attributes.name, ariaLabel: attributes['aria-label'],
                ariaLabelledBy: attributes['aria-labelledby'], href: attributes.href,
                text: target.text || ''
            };
            const scored = pageCore.getInteractiveElements().map(element => {
                const validation = pageCore.validateElementAgainstSignature(element, signature);
                let score = validation.score * 10, total = 10;
                for (const [field, weight] of [['containerKind', 0.5], ['siblingButtonHint', 0.5],
                    ['viewportZone', 0.25], ['svgHint', 1]]) {
                    if (signature[field] === undefined || signature[field] === '') continue;
                    total += weight;
                    if (validation.current?.[field] === signature[field]) score += weight;
                }
                return { element, score: score / total };
            }).filter(item => item.score >= 0.42).sort((a, b) => b.score - a.score);
            const top = scored[0];
            const margin = top ? top.score - (scored[1]?.score || 0) : 0;
            if (top?.score >= 0.68 && margin >= 0.12) {
                return {
                    element: top.element, handleId: ensureHandle(top.element),
                    source: 'skill-persistent-rebound', confidence: top.score,
                    candidateCount: scored.length, scoreMargin: margin, signatureValid: true, rebound: true
                };
            }
            const ambiguous = candidates.size > 1 || top?.score >= 0.42;
            throw structuredError(ambiguous ? 'TARGET_AMBIGUOUS' : 'TARGET_NOT_FOUND',
                'Skill 持久化目标无法安全重绑定', {
                    candidateCount: scored.length, confidence: top?.score || 0, scoreMargin: margin,
                    candidates: ambiguous ? dehydrateCandidates(scored) : []
                });
        }

        function resolveTarget(target, options = {}) {
            if (target?.kind === 'loom-persistent-target') return resolvePersistentTarget(target);
            if (!target) throw structuredError('TARGET_NOT_FOUND', '缺少目标元素 target');
            const normalized = String(target).trim();
            const strictMatch = normalized.match(STRICT_HANDLE_PATTERN);
            if (strictMatch) {
                if (Number(strictMatch[1]) !== documentGeneration) {
                    throw structuredError('ELEMENT_HANDLE_EXPIRED', '严格句柄所属文档代次已失效', {
                        requestedHandle: normalized,
                        requestedDocumentGeneration: Number(strictMatch[1]),
                        currentDocumentGeneration: documentGeneration,
                        requestedSnapshotId: Number(strictMatch[2]),
                        currentSnapshotId: snapshotId
                    });
                }
                return validateEntry(registry.get(normalized), options, normalized);
            }
            const canonical = aliases.get(normalized) || normalized;
            if (registry.has(canonical)) {
                return validateEntry(registry.get(canonical), options, normalized);
            }
            const kindMatch = normalized.match(KIND_ID_PATTERN);
            if (kindMatch) {
                const kind = pageCore.normalizeElementKind(kindMatch[1]);
                const index = Number(kindMatch[2]);
                const candidates = pageCore.getInteractiveElements(kind);
                const element = candidates[index - 1];
                if (!element) {
                    throw structuredError('TARGET_NOT_FOUND', `未找到 ${kind} 类型第 ${index} 个元素`, {
                        candidateCount: candidates.length
                    });
                }
                if (options.sideEffecting && !element.hasAttribute('data-vcp-kind-id')) {
                    throw structuredError('ELEMENT_HANDLE_EXPIRED', '高风险动作禁止仅按动态序号恢复目标');
                }
                return {
                    element,
                    entry: null,
                    handleId: normalized,
                    source: 'kind-index',
                    confidence: 0.7,
                    candidateCount: candidates.length,
                    scoreMargin: null,
                    signatureValid: null
                };
            }
            const exactCandidates = [];
            const selectors = [
                `[aria-label="${pageCore.safeCssEscape(normalized)}"]`,
                `[name="${pageCore.safeCssEscape(normalized)}"]`,
                `[placeholder="${pageCore.safeCssEscape(normalized)}"]`,
                `[title="${pageCore.safeCssEscape(normalized)}"]`
            ];
            for (const selector of selectors) {
                try {
                    documentObject.querySelectorAll(selector).forEach(element => exactCandidates.push(element));
                } catch {}
            }
            const byId = documentObject.getElementById(normalized);
            if (byId) exactCandidates.push(byId);
            if (normalized.startsWith('/') && documentObject.evaluate) {
                try {
                    const result = documentObject.evaluate(
                        normalized,
                        documentObject,
                        null,
                        windowObject.XPathResult.FIRST_ORDERED_NODE_TYPE,
                        null
                    );
                    if (result.singleNodeValue) exactCandidates.push(result.singleNodeValue);
                } catch {}
            }
            if (/^[#.\[]/.test(normalized)) {
                try {
                    documentObject.querySelectorAll(normalized).forEach(element => exactCandidates.push(element));
                } catch {}
            }
            const uniqueExact = [...new Set(exactCandidates)].filter(element =>
                (!options.requireInputLike || pageCore.isInputLikeElement(element)) &&
                (!options.requireClickableLike ||
                    pageCore.isClickableLikeElement(element) ||
                    pageCore.isInputLikeElement(element))
            );
            if (uniqueExact.length === 1) {
                return {
                    element: uniqueExact[0],
                    entry: null,
                    handleId: uniqueExact[0].getAttribute('data-vcp-snapshot-handle'),
                    source: 'exact-attribute',
                    confidence: 0.95,
                    candidateCount: 1,
                    scoreMargin: 1,
                    signatureValid: null
                };
            }
            if (uniqueExact.length > 1) {
                throw structuredError('TARGET_AMBIGUOUS', '精确定位得到多个候选', {
                    candidateCount: uniqueExact.length,
                    scoreMargin: 0,
                    candidates: dehydrateCandidates(uniqueExact.map(element => ({ element, score: 1 })))
                });
            }
            const scored = pageCore.getInteractiveElements()
                .filter(element =>
                    (!options.requireInputLike || pageCore.isInputLikeElement(element)) &&
                    (!options.requireClickableLike ||
                        pageCore.isClickableLikeElement(element) ||
                        pageCore.isInputLikeElement(element))
                )
                .map(element => ({ element, score: scoreText(normalized, element) }))
                .filter(item => item.score >= 0.42)
                .sort((a, b) => b.score - a.score);
            if (!scored.length) {
                throw structuredError('TARGET_NOT_FOUND', `未找到目标: ${normalized}`, {
                    currentDocumentGeneration: documentGeneration,
                    currentSnapshotId: snapshotId
                });
            }

            // 文本全等和子串/相似匹配属于不同的置信层级。只要存在唯一全等元素，
            // 就应直接采用它，不能让“回复”之类的短子串候选制造虚假歧义。
            const exactTextMatches = scored.filter(item => item.score === 1);
            if (exactTextMatches.length === 1) {
                return {
                    element: exactTextMatches[0].element,
                    entry: null,
                    handleId: exactTextMatches[0].element.getAttribute('data-vcp-snapshot-handle'),
                    source: 'semantic-text',
                    confidence: 1,
                    candidateCount: 1,
                    scoreMargin: 1,
                    signatureValid: null
                };
            }
            if (exactTextMatches.length > 1) {
                throw structuredError('TARGET_AMBIGUOUS', `目标文本存在多个全等候选: ${normalized}`, {
                    candidateCount: exactTextMatches.length,
                    confidence: 1,
                    scoreMargin: 0,
                    candidates: dehydrateCandidates(exactTextMatches)
                });
            }

            const margin = scored.length > 1 ? scored[0].score - scored[1].score : 1;
            if (scored[0].score < 0.68 || (scored.length > 1 && margin < 0.12)) {
                throw structuredError('TARGET_AMBIGUOUS', `目标文本存在多个近似候选: ${normalized}`, {
                    candidateCount: scored.length,
                    confidence: scored[0].score,
                    scoreMargin: margin,
                    candidates: dehydrateCandidates(scored)
                });
            }
            return {
                element: scored[0].element,
                entry: null,
                handleId: scored[0].element.getAttribute('data-vcp-snapshot-handle'),
                source: 'semantic-text',
                confidence: scored[0].score,
                candidateCount: scored.length,
                scoreMargin: margin,
                signatureValid: null
            };
        }

        function describeElement(element) {
            if (!element) return 'unknown';
            return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}`;
        }

        function checkOcclusion(element) {
            if (!element?.isConnected) throw structuredError('ELEMENT_HANDLE_EXPIRED', '目标已脱离 DOM');
            element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            const style = windowObject.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            if (style.display === 'none' || style.visibility === 'hidden' ||
                Number.parseFloat(style.opacity || '1') <= 0 || rect.width <= 0 || rect.height <= 0) {
                throw structuredError('ELEMENT_NOT_INTERACTABLE', '目标不可见或没有有效尺寸');
            }
            if (element.disabled || element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('inert')) {
                throw structuredError('ELEMENT_NOT_INTERACTABLE', '目标处于禁用或 inert 状态');
            }
            const left = Math.max(0, rect.left);
            const top = Math.max(0, rect.top);
            const right = Math.min(windowObject.innerWidth, rect.right);
            const bottom = Math.min(windowObject.innerHeight, rect.bottom);
            if (right <= left || bottom <= top) {
                throw structuredError('ELEMENT_OUTSIDE_VIEWPORT', '目标不在当前视口');
            }
            const insetX = Math.min(6, (right - left) * 0.2);
            const insetY = Math.min(6, (bottom - top) * 0.2);
            const points = [
                [left + (right - left) / 2, top + (bottom - top) / 2],
                [left + insetX, top + insetY],
                [right - insetX, top + insetY],
                [left + insetX, bottom - insetY],
                [right - insetX, bottom - insetY]
            ].map(([x, y]) => ({ x: Math.round(x), y: Math.round(y) }));
            const hits = [];
            let occluder = null;
            for (const point of points) {
                let hit = documentObject.elementFromPoint(point.x, point.y);
                // document 命中 Shadow 宿主并不表示目标被遮挡。
                // 沿同一坐标继续命中，必须到达真实目标，不能仅凭宿主关系放行。
                const visitedHits = new Set();
                for (let depth = 0; hit?.shadowRoot && depth < 32; depth++) {
                    if (visitedHits.has(hit)) break;
                    visitedHits.add(hit);
                    const innerHit = hit.shadowRoot.elementFromPoint?.(point.x, point.y);
                    if (!innerHit || innerHit === hit) break;
                    hit = innerHit;
                }
                const related = hit === element || element.contains(hit) || hit?.contains?.(element) ||
                    (hit?.tagName === 'LABEL' && hit.htmlFor === element.id) ||
                    (element.tagName === 'LABEL' && element.control === hit);
                if (related) hits.push(point);
                else if (!occluder && hit) {
                    occluder = {
                        tag: hit.tagName?.toLowerCase(),
                        role: hit.getAttribute?.('role') || null,
                        label: pageCore.getAccessibleName(hit) || describeElement(hit)
                    };
                }
            }
            return {
                occluded: hits.length === 0,
                hitCount: hits.length,
                sampleCount: points.length,
                hitRatio: hits.length / points.length,
                preferredPoint: hits[0] || null,
                rect: {
                    x: Math.round(rect.x),
                    y: Math.round(rect.y),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height)
                },
                occluder
            };
        }

        function setNativeValue(element, value) {
            if (pageCore.isContentEditableElement(element)) {
                element.textContent = value;
            } else {
                const prototype = element.tagName === 'TEXTAREA'
                    ? windowObject.HTMLTextAreaElement.prototype
                    : windowObject.HTMLInputElement.prototype;
                const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
                if (descriptor?.set) descriptor.set.call(element, value);
                else element.value = value;
            }
            element.dispatchEvent(new windowObject.InputEvent('input', {
                bubbles: true,
                cancelable: true,
                inputType: 'insertText',
                data: value
            }));
            element.dispatchEvent(new windowObject.Event('change', { bubbles: true }));
        }

        function dispatchClick(element, strict) {
            const occlusion = checkOcclusion(element);
            if (strict !== false && occlusion.occluded) {
                throw structuredError('ELEMENT_OCCLUDED', '目标被页面内容完全遮挡', occlusion);
            }
            const point = occlusion.preferredPoint || {
                x: Math.round(occlusion.rect.x + occlusion.rect.width / 2),
                y: Math.round(occlusion.rect.y + occlusion.rect.height / 2)
            };
            element.focus?.({ preventScroll: true });
            const init = {
                bubbles: true,
                cancelable: true,
                view: windowObject,
                clientX: point.x,
                clientY: point.y
            };
            ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
                const Constructor = type.startsWith('pointer')
                    ? windowObject.PointerEvent
                    : windowObject.MouseEvent;
                element.dispatchEvent(new Constructor(type, init));
            });
            return occlusion;
        }

        function sendKeys(element, keys) {
            const tokens = Array.isArray(keys)
                ? keys.map(String)
                : String(keys || '').split(/\s*\+\s*|\s*,\s*/).filter(Boolean);
            if (!tokens.length) throw structuredError('INVALID_KEYS', 'send_keys 缺少 keys');
            const modifiers = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
            for (const token of tokens) {
                const lower = token.toLowerCase();
                if (['ctrl', 'control'].includes(lower)) modifiers.ctrlKey = true;
                else if (['cmd', 'command', 'meta'].includes(lower)) modifiers.metaKey = true;
                else if (lower === 'alt') modifiers.altKey = true;
                else if (lower === 'shift') modifiers.shiftKey = true;
            }
            const aliases = { return: 'Enter', esc: 'Escape', space: ' ' };
            const actions = tokens.filter(token =>
                !['ctrl', 'control', 'cmd', 'command', 'meta', 'alt', 'shift']
                    .includes(token.toLowerCase())
            );
            const target = element || documentObject.activeElement || documentObject.body;
            target.focus?.();
            for (const token of actions) {
                const key = aliases[token.toLowerCase()] || token;
                const init = {
                    key,
                    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
                    bubbles: true,
                    cancelable: true,
                    ...modifiers
                };
                target.dispatchEvent(new windowObject.KeyboardEvent('keydown', init));
                target.dispatchEvent(new windowObject.KeyboardEvent('keypress', init));
                target.dispatchEvent(new windowObject.KeyboardEvent('keyup', init));
            }
            return { keys: actions, modifiers };
        }

        function selectOption(element, params) {
            if (element.tagName !== 'SELECT') {
                throw structuredError('ELEMENT_NOT_INTERACTABLE', 'select_option 要求原生 select');
            }
            const choices = Array.from(element.options);
            const exact = parseBoolean(params.exact, true);
            let selected = params.value !== undefined
                ? choices.find(option => option.value === String(params.value))
                : null;
            if (!selected && params.text !== undefined) {
                const expected = pageCore.normalizeText(params.text);
                selected = choices.find(option => exact
                    ? pageCore.normalizeText(option.text) === expected
                    : pageCore.normalizeText(option.text).includes(expected));
            }
            if (!selected && params.index !== undefined) selected = choices[Number(params.index)];
            if (!selected) {
                throw structuredError('OPTION_NOT_FOUND', '未找到匹配下拉选项', {
                    availableOptions: choices.map((option, index) => ({
                        index,
                        text: option.text,
                        value: option.value,
                        disabled: option.disabled
                    }))
                });
            }
            if (selected.disabled) throw structuredError('ELEMENT_NOT_INTERACTABLE', '下拉选项已禁用');
            element.value = selected.value;
            selected.selected = true;
            element.dispatchEvent(new windowObject.Event('input', { bubbles: true }));
            element.dispatchEvent(new windowObject.Event('change', { bubbles: true }));
            return {
                selectedIndex: element.selectedIndex,
                selectedText: selected.text,
                selectedValue: element.value
            };
        }

        async function performScroll(params = {}) {
            const direction = String(params.direction || 'down').toLowerCase();
            const behavior = ['auto', 'smooth', 'instant'].includes(String(params.behavior || '').toLowerCase())
                ? String(params.behavior).toLowerCase()
                : 'smooth';
            const target = params.target ? resolveTarget(params.target).element : windowObject;
            const before = getScrollState(target);
            const viewportHeight = windowObject.innerHeight || 800;
            const viewportWidth = windowObject.innerWidth || 1200;
            const amount = parseNumber(params.amount, Math.floor(viewportHeight * 0.8), 1, 100000);
            let top = Number(params.y) || 0;
            let left = Number(params.x) || 0;
            if (direction === 'down') top = amount;
            else if (direction === 'up') top = -amount;
            else if (direction === 'right') left = amount;
            else if (direction === 'left') left = -amount;
            else if (direction === 'page_down') top = viewportHeight;
            else if (direction === 'page_up') top = -viewportHeight;
            else if (direction === 'page_right') left = viewportWidth;
            else if (direction === 'page_left') left = -viewportWidth;
            else if (direction === 'top') {
                target === windowObject
                    ? windowObject.scrollTo({ top: 0, left: windowObject.scrollX, behavior })
                    : target.scrollTo({ top: 0, left: target.scrollLeft, behavior });
            } else if (direction === 'bottom') {
                top = target === windowObject
                    ? Math.max(documentObject.documentElement.scrollHeight, documentObject.body?.scrollHeight || 0)
                    : target.scrollHeight;
            } else if (direction === 'to') {
                target === windowObject
                    ? windowObject.scrollTo({ top, left, behavior })
                    : target.scrollTo({ top, left, behavior });
            } else {
                throw structuredError('INVALID_REQUEST', `不支持的滚动方向: ${direction}`);
            }
            if (!['top', 'to'].includes(direction)) {
                target === windowObject
                    ? windowObject.scrollBy({ top, left, behavior })
                    : target.scrollBy({ top, left, behavior });
            }
            await new Promise(resolve => setTimeout(resolve, behavior === 'smooth' ? 350 : 30));
            const after = getScrollState(target);
            const moved = JSON.stringify(before) !== JSON.stringify(after);
            const maxY = Math.max(0, after.scrollHeight - (after.innerHeight || after.clientHeight || 0));
            const y = after.scrollY ?? after.scrollTop;
            const boundary = (['down', 'bottom', 'page_down'].includes(direction) && y >= maxY - 1) ||
                (['up', 'top', 'page_up'].includes(direction) && y <= 0);
            return {
                status: 'success',
                code: moved ? 'ACTION_VERIFIED' : (boundary ? 'SCROLL_BOUNDARY_REACHED' : 'ACTION_VERIFICATION_FAILED'),
                message: `滚动完成: ${direction}`,
                result: {
                    ...after,
                    attempted: true,
                    verified: moved || boundary,
                    reachedBoundary: boundary,
                    beforeState: before,
                    afterState: after,
                    backendUsed: 'page-core',
                    fallbackUsed: false,
                    requiresFreshSnapshot: true
                }
            };
        }

        function getScrollState(target) {
            if (target === windowObject) {
                const root = documentObject.documentElement;
                const body = documentObject.body;
                return {
                    target: 'window',
                    scrollX: windowObject.scrollX,
                    scrollY: windowObject.scrollY,
                    innerWidth: windowObject.innerWidth,
                    innerHeight: windowObject.innerHeight,
                    scrollWidth: Math.max(root.scrollWidth, body?.scrollWidth || 0),
                    scrollHeight: Math.max(root.scrollHeight, body?.scrollHeight || 0)
                };
            }
            return {
                target: describeElement(target),
                scrollLeft: target.scrollLeft,
                scrollTop: target.scrollTop,
                clientWidth: target.clientWidth,
                clientHeight: target.clientHeight,
                scrollWidth: target.scrollWidth,
                scrollHeight: target.scrollHeight
            };
        }

        async function waitFor(params = {}) {
            const timeoutMs = parseNumber(params.timeoutMs, 10000, 50, 120000);
            const pollMs = parseNumber(params.pollMs, 100, 25, 2000);
            const condition = String(params.condition ||
                (params.target ? 'element' : params.text !== undefined ? 'text' : params.url ? 'url' : 'dom_stable')
            ).toLowerCase();
            const started = Date.now();
            let stableSince = Date.now();
            let mutationCount = 0;
            let waitElement = null;
            let lastTextLength = null;
            let lastTextElement = null;
            let textStableSince = Date.now();
            const changes = new WeakMap();
            const ignored = new WeakSet();
            const observer = new windowObject.MutationObserver(mutations => {
                for (const mutation of mutations) {
                    const element = mutation.target.nodeType === NodeObject.TEXT_NODE
                        ? mutation.target.parentElement : mutation.target;
                    if (!element || ignored.has(element)) continue;
                    if (params.target && (!waitElement || !waitElement.contains(element))) continue;
                    const count = (changes.get(element) || 0) + 1;
                    changes.set(element, count);
                    const animation = mutation.type === 'attributes' &&
                        ['style', 'class'].includes(mutation.attributeName);
                    if (count >= 3 && ((element.textContent || '').length <= 24 || animation)) {
                        ignored.add(element);
                        continue;
                    }
                    stableSince = Date.now();
                    mutationCount += 1;
                }
            });
            observer.observe(documentObject.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true
            });
            try {
                while (Date.now() - started <= timeoutMs) {
                    let element = null;
                    try {
                        if (params.target) element = resolveTarget(params.target, { readOnly: true }).element;
                    } catch {}
                    if (waitElement !== element) stableSince = Date.now();
                    waitElement = element;
                    let matched = false;
                    let actual = null;
                    if (condition === 'element' || condition === 'visible') {
                        matched = Boolean(element && isVisible(element));
                        actual = element ? describeElement(element) : null;
                    } else if (condition === 'hidden') matched = !element || !isVisible(element);
                    else if (condition === 'text') {
                        actual = pageCore.normalizeAttribute(documentObject.body?.innerText || '');
                        matched = actual.includes(String(params.text || ''));
                    } else if (condition === 'url') {
                        actual = documentObject.URL;
                        matched = actual.includes(String(params.url || ''));
                    } else if (condition === 'value') {
                        actual = element ? (element.value ?? element.textContent) : null;
                        matched = String(actual) === String(params.value ?? params.text ?? '');
                    } else if (condition === 'dom_stable') {
                        const stableMs = parseNumber(params.stableMs, 500, 50, 10000);
                        actual = { stableForMs: Date.now() - stableSince, mutationCount };
                        matched = (!params.target || Boolean(element)) && Date.now() - stableSince >= stableMs;
                    } else if (condition === 'settled') {
                        const root = params.target ? element : documentObject.body;
                        const length = (root?.textContent || '').length;
                        if (length !== lastTextLength || root !== lastTextElement) {
                            textStableSince = Date.now();
                            lastTextLength = length;
                            lastTextElement = root;
                        }
                        const selector = '[aria-busy="true"],.loading,.spinner';
                        const busy = Boolean(root && ((root.matches?.(selector) && isVisible(root)) ||
                            Array.from(root.querySelectorAll(selector)).some(isVisible)));
                        actual = { textLength: length, busy, stableForMs: Date.now() - textStableSince };
                        matched = Boolean(root) && !busy &&
                            Date.now() - textStableSince >= parseNumber(params.stableMs, 800, 50, 10000);
                    } else {
                        throw structuredError('WAIT_CONDITION_UNSUPPORTED', `不支持的等待条件: ${condition}`);
                    }
                    if (matched) {
                        return {
                            status: 'success',
                            code: 'WAIT_CONDITION_MET',
                            message: `等待条件已满足: ${condition}`,
                            result: { condition, matched, actual, elapsedMs: Date.now() - started }
                        };
                    }
                    await new Promise(resolve => setTimeout(resolve, pollMs));
                }
            } finally {
                observer.disconnect();
            }
            throw structuredError('WAIT_TIMEOUT', `等待条件超时: ${condition}`, { timeoutMs });
        }

        function pageCodeSearch(params = {}) {
            if (!params.query || !String(params.query).trim()) {
                throw structuredError('INVALID_REQUEST', 'page_code_search 缺少 query');
            }
            const useRegex = parseBoolean(params.useRegex, false);
            const caseSensitive = parseBoolean(params.caseSensitive, false);
            const maxResults = parseNumber(params.maxResults, 20, 1, 200);
            const contextChars = parseNumber(params.contextChars, 80, 0, 500);
            const escaped = String(params.query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(useRegex ? String(params.query) : escaped, caseSensitive ? 'g' : 'gi');
            const redacted = pageCore.redactHtml(documentObject.documentElement?.outerHTML || '');
            const sources = [{
                sourceType: 'dom',
                sourceLabel: 'document.documentElement.outerHTML',
                content: redacted
            }];
            documentObject.querySelectorAll('script:not([src]),style,pre,code').forEach((element, index) => {
                sources.push({
                    sourceType: element.tagName.toLowerCase(),
                    sourceLabel: `${element.tagName.toLowerCase()}[${index}]`,
                    content: element.textContent || ''
                });
            });
            const results = [];
            for (const source of sources) {
                regex.lastIndex = 0;
                let match;
                while ((match = regex.exec(source.content)) && results.length < maxResults) {
                    results.push({
                        sourceType: source.sourceType,
                        sourceLabel: source.sourceLabel,
                        matchText: match[0],
                        contextBefore: source.content.slice(Math.max(0, match.index - contextChars), match.index),
                        contextAfter: source.content.slice(match.index + match[0].length, match.index + match[0].length + contextChars),
                        position: { start: match.index, end: match.index + match[0].length }
                    });
                    if (regex.lastIndex === match.index) regex.lastIndex += 1;
                }
                if (results.length >= maxResults) break;
            }
            return {
                status: 'success',
                message: '页面源码搜索完成',
                result: {
                    query: params.query,
                    totalMatches: results.length,
                    truncated: results.length >= maxResults,
                    results
                }
            };
        }

        function actionResolution(resolved) {
            return {
                source: resolved.source, handleId: resolved.handleId,
                confidence: resolved.confidence, candidateCount: resolved.candidateCount,
                scoreMargin: resolved.scoreMargin, signatureValid: resolved.signatureValid,
                rebound: resolved.rebound === true
            };
        }

        function prepareAction(params) {
            const action = String(params.targetAction || '').replace(/^page_/, '');
            const resolved = params.target ? resolveTarget(params.target, {
                requireInputLike: action === 'type', sideEffecting: true
            }) : action === 'send_keys'
                ? { element: documentObject.activeElement || documentObject.body, source: 'focused', confidence: 1 }
                : resolveTarget(params.target);
            const element = resolved.element;
            resolved.handleId = ensureHandle(element);
            const occlusion = checkOcclusion(element);
            if (params.strict !== false && occlusion.occluded) {
                throw structuredError('ELEMENT_OCCLUDED', '目标被页面内容完全遮挡', occlusion);
            }
            element.focus?.({ preventScroll: true });
            const beforeState = pageCore.captureElementActionState(element);
            const editable = pageCore.isContentEditableElement(element);
            if (action === 'type' && params.nativeInput !== false) {
                if (editable) {
                    const range = documentObject.createRange();
                    range.selectNodeContents(element);
                    const selection = windowObject.getSelection();
                    selection.removeAllRanges();
                    selection.addRange(range);
                } else if (typeof element.select === 'function') element.select();
                else element.value = '';
            }
            return {
                status: 'success', code: 'ACTION_PREPARED',
                result: {
                    targetAction: action, handleId: resolved.handleId, targetResolution: actionResolution(resolved),
                    occlusion, point: occlusion.preferredPoint || {
                        x: occlusion.rect.x + occlusion.rect.width / 2,
                        y: occlusion.rect.y + occlusion.rect.height / 2
                    },
                    beforeState, isContentEditable: editable,
                    currentChecked: beforeState.checked === true || beforeState.checked === 'true',
                    isTopFrame: windowObject === windowObject.top
                }
            };
        }

        async function verifyAction(params) {
            const action = String(params.targetAction || '').replace(/^page_/, '');
            const entry = registry.get(params.target);
            const resolved = entry ? { element: entry.element, handleId: entry.strictHandle, source: 'registry-exact' }
                : resolveTarget(params.target, { readOnly: true });
            const element = resolved.element;
            await new Promise(resolve => setTimeout(resolve, 50));
            const after = pageCore.captureElementActionState(element);
            const backend = params.backendUsed;
            let result;
            if (action === 'type') {
                result = pageCore.verifyInputAction(element, params.expectedText, params.beforeState, after, backend);
            } else if (action === 'check') {
                const desired = parseBoolean(params.desiredChecked, true);
                const actual = after.checked === true || after.checked === 'true';
                const current = params.beforeState?.checked === true || params.beforeState?.checked === 'true';
                result = { attempted: current !== desired, idempotentNoop: current === desired,
                    verified: actual === desired, desired, actual, beforeState: params.beforeState,
                    afterState: after, backendUsed: backend, fallbackUsed: false,
                    requiresFreshSnapshot: current !== desired };
            } else if (action === 'click') {
                result = pageCore.verifyClickAction(element, params.beforeState, after, backend);
            } else {
                result = { attempted: true, verified: null, beforeState: params.beforeState,
                    afterState: after, backendUsed: backend, fallbackUsed: false, requiresFreshSnapshot: true };
            }
            const enforce = params.verification !== 'observe' && params.verification !== 'none';
            const failed = result.verified === false;
            const code = result.verified === true ? 'ACTION_VERIFIED' : failed
                ? (enforce ? 'ACTION_VERIFICATION_FAILED' : 'ACTION_VERIFICATION_OBSERVED_FAILED')
                : action === 'click' ? 'ACTION_ATTEMPTED_UNVERIFIABLE' : 'ACTION_DISPATCHED';
            return {
                status: failed && enforce ? 'error' : 'success', code,
                message: failed ? '动作状态回读不一致' : '动作已分派并完成状态回读',
                backendUsed: backend,
                result: { ...result, occlusion: params.occlusion, actionPoint: params.actionPoint,
                    targetResolution: params.targetResolution || actionResolution(resolved),
                    runtimeInstanceId, documentGeneration, snapshotIdBefore: snapshotId }
            };
        }

        async function execute(commandInput, params = {}, requestOptions = {}) {
            const command = String(commandInput || '').replace(/^page_/, '');
            const strict = requestOptions.strict === true || params.strict === true;
            assertContext(params.targetContext || requestOptions.targetContext || {
                runtimeInstanceId: params.runtimeInstanceId,
                documentGeneration: params.documentGeneration,
                snapshotId: params.snapshotId
            }, strict);

            if (comfyUIAdapter?.parseWidgetTarget?.(params.target)) {
                const specializedResult = await comfyUIAdapter.execute(command, params, {
                    window: windowObject,
                    document: documentObject
                });
                if (specializedResult?.result && typeof specializedResult.result === 'object') {
                    specializedResult.result.runtimeInstanceId = runtimeInstanceId;
                    specializedResult.result.documentGeneration = documentGeneration;
                    specializedResult.result.snapshotIdBefore = snapshotId;
                }
                return specializedResult;
            }
            if (command === 'prepare_action') return prepareAction({ ...params, strict: params.strict ?? requestOptions.strict });
            if (command === 'verify_action') return verifyAction(params);
            if (command === 'get_info') return { status: 'success', message: '页面信息已刷新', result: snapshot() };
            if (command === 'get_image') {
                const entry = resolvePageImage(params.imageId || params.target);
                const element = entry.element;
                element.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' });
                await new Promise(resolve => setTimeout(resolve, 120));
                const rect = element.getBoundingClientRect();
                const style = windowObject.getComputedStyle(element);
                if (!isVisible(element) || rect.width <= 0 || rect.height <= 0) {
                    throw structuredError('IMAGE_NOT_VISIBLE', '目标图片当前不可见或没有有效尺寸');
                }
                return {
                    status: 'success',
                    code: 'PAGE_IMAGE_RESOLVED',
                    message: `已解析页面图片 ${entry.imageId}`,
                    result: {
                        ...entry.record,
                        resolvedImageId: entry.strictImageId,
                        runtimeInstanceId,
                        documentGeneration,
                        snapshotId,
                        currentSrc: element.tagName === 'VIDEO'
                            ? String(element.poster || element.currentSrc || '')
                            : String(element.currentSrc || element.src || ''),
                        viewportRect: {
                            x: Math.round(rect.x),
                            y: Math.round(rect.y),
                            width: Math.round(rect.width),
                            height: Math.round(rect.height)
                        },
                        pageRect: {
                            x: Math.round(rect.x + windowObject.scrollX),
                            y: Math.round(rect.y + windowObject.scrollY),
                            width: Math.round(rect.width),
                            height: Math.round(rect.height)
                        },
                        devicePixelRatio: windowObject.devicePixelRatio || 1
                    }
                };
            }
            if (command === 'query_html') {
                const resolved = params.target
                    ? resolveTarget(params.target)
                    : { element: documentObject.body, source: 'body', handleId: null, confidence: 1 };
                const redacted = pageCore.redactHtmlWithMetadata(resolved.element.outerHTML);
                return {
                    status: 'success',
                    code: redacted.applied ? 'SENSITIVE_DATA_REDACTED' : 'REDACTION_ENABLED_NO_MATCH',
                    result: redacted.html,
                    redaction: {
                        enabled: redacted.enabled,
                        applied: redacted.applied,
                        redactedFieldCount: redacted.redactedFieldCount
                    },
                    targetResolution: {
                        source: resolved.source,
                        handleId: resolved.handleId,
                        confidence: resolved.confidence
                    }
                };
            }
            if (command === 'query_scripts') {
                return {
                    status: 'success',
                    result: Array.from(documentObject.scripts).map(script => ({
                        src: script.src || 'inline',
                        content: script.src ? null : String(script.textContent || '').slice(0, 500)
                    }))
                };
            }
            if (command === 'code_search') return pageCodeSearch(params);
            if (command === 'wait_for') return waitFor(params);
            if (command === 'scroll') return performScroll(params);
            if (command === 'send_keys' && !params.target) {
                return {
                    status: 'success',
                    code: 'ACTION_DISPATCHED',
                    message: '键盘动作已发送到当前焦点元素',
                    result: {
                        ...sendKeys(documentObject.activeElement || documentObject.body, params.keys || params.text),
                        attempted: true,
                        verified: null,
                        backendUsed: 'page-core'
                    }
                };
            }
            const input = ['type', 'set_value'].includes(command);
            const clickable = ['click', 'check', 'hover'].includes(command);
            const resolved = resolveTarget(params.target, {
                requireInputLike: input,
                requireClickableLike: clickable,
                sideEffecting: !READ_ONLY_COMMANDS.has(commandInput)
            });
            const element = resolved.element;
            const before = pageCore.captureElementActionState(element);
            let response;
            if (input) {
                const value = String(params.value ?? params.text ?? '');
                if (!pageCore.isInputLikeElement(element)) {
                    throw structuredError('ELEMENT_NOT_INPUT_LIKE', '目标不是输入类元素');
                }
                element.focus();
                setNativeValue(element, value);
                await new Promise(resolve => setTimeout(resolve, 50));
                const after = pageCore.captureElementActionState(element);
                const verification = pageCore.verifyInputAction(element, value, before, after, 'page-core');
                const enforce = params.verification !== 'observe' && params.verification !== 'none';
                response = {
                    status: verification.verified || !enforce ? 'success' : 'error',
                    code: verification.verified
                        ? 'ACTION_VERIFIED'
                        : (enforce ? 'ACTION_VERIFICATION_FAILED' : 'ACTION_VERIFICATION_OBSERVED_FAILED'),
                    message: verification.verified ? '输入动作已验证' : '输入动作读回不一致',
                    error: verification.verified || !enforce ? undefined : '输入动作验证失败',
                    result: verification
                };
            } else if (command === 'click') {
                const occlusion = dispatchClick(element, strict);
                await new Promise(resolve => setTimeout(resolve, 50));
                const after = pageCore.captureElementActionState(element);
                const verification = pageCore.verifyClickAction(element, before, after, 'page-core');
                const enforce = params.verification !== 'observe' && params.verification !== 'none';
                response = {
                    status: verification.verified === false && enforce ? 'error' : 'success',
                    code: verification.verified === true
                        ? 'ACTION_VERIFIED'
                        : (verification.verified === false
                            ? (enforce ? 'ACTION_VERIFICATION_FAILED' : 'ACTION_VERIFICATION_OBSERVED_FAILED')
                            : 'ACTION_ATTEMPTED_UNVERIFIABLE'),
                    message: verification.verified === true ? '点击动作已验证' : '点击动作已分派',
                    result: { ...verification, occlusion, actionPoint: occlusion.preferredPoint }
                };
            } else if (command === 'send_keys') {
                response = {
                    status: 'success',
                    code: 'ACTION_DISPATCHED',
                    message: '键盘动作已分派',
                    result: {
                        ...sendKeys(element, params.keys || params.text),
                        attempted: true,
                        verified: null,
                        beforeState: before,
                        afterState: pageCore.captureElementActionState(element),
                        backendUsed: 'page-core'
                    }
                };
            } else if (command === 'select_option') {
                const selected = selectOption(element, params);
                const after = pageCore.captureElementActionState(element);
                response = {
                    status: 'success',
                    code: 'ACTION_VERIFIED',
                    message: `已选择选项: ${selected.selectedText}`,
                    result: {
                        ...selected,
                        attempted: true,
                        verified: after.selectedIndex === selected.selectedIndex,
                        beforeState: before,
                        afterState: after,
                        backendUsed: 'page-core',
                        requiresFreshSnapshot: true
                    }
                };
            } else if (command === 'hover') {
                const occlusion = checkOcclusion(element);
                if (occlusion.occluded) throw structuredError('ELEMENT_OCCLUDED', '目标被遮挡', occlusion);
                const point = occlusion.preferredPoint;
                ['pointerover', 'mouseover', 'pointerenter', 'mouseenter', 'mousemove'].forEach(type => {
                    const Constructor = type.startsWith('pointer')
                        ? windowObject.PointerEvent
                        : windowObject.MouseEvent;
                    element.dispatchEvent(new Constructor(type, {
                        bubbles: !type.endsWith('enter'),
                        cancelable: true,
                        clientX: point.x,
                        clientY: point.y
                    }));
                });
                response = {
                    status: 'success',
                    code: 'ACTION_DISPATCHED',
                    message: '悬停动作已分派',
                    result: { attempted: true, verified: null, occlusion, backendUsed: 'page-core' }
                };
            } else if (command === 'check') {
                const desired = parseBoolean(params.checked, true);
                const current = before.checked === true || before.checked === 'true';
                let occlusion = null;
                if (current !== desired) {
                    occlusion = dispatchClick(element, strict);
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
                const after = pageCore.captureElementActionState(element);
                const actual = after.checked === true || after.checked === 'true';
                response = {
                    status: actual === desired ? 'success' : 'error',
                    code: actual === desired ? 'ACTION_VERIFIED' : 'ACTION_VERIFICATION_FAILED',
                    message: actual === desired ? `控件状态已为 checked=${desired}` : '控件状态验证失败',
                    result: {
                        attempted: current !== desired,
                        idempotentNoop: current === desired,
                        verified: actual === desired,
                        desired,
                        actual,
                        beforeState: before,
                        afterState: after,
                        occlusion,
                        backendUsed: 'page-core',
                        requiresFreshSnapshot: current !== desired
                    }
                };
            } else {
                throw structuredError('UNKNOWN_COMMAND', `Page Runtime Core 不支持命令: ${commandInput}`);
            }
            if (response.result && typeof response.result === 'object') {
                response.result.targetResolution = {
                    source: resolved.source,
                    handleId: resolved.handleId,
                    confidence: resolved.confidence,
                    candidateCount: resolved.candidateCount,
                    scoreMargin: resolved.scoreMargin,
                    signatureValid: resolved.signatureValid,
                    rebound: resolved.rebound === true
                };
                response.result.runtimeInstanceId = runtimeInstanceId;
                response.result.documentGeneration = documentGeneration;
                response.result.snapshotIdBefore = snapshotId;
                response.result.requiresFreshSnapshot ??= true;
            }
            return response;
        }

        function getCapabilities() {
            return {
                version: VERSION,
                pageGraph: true,
                groundedMarkdown: true,
                strictHandles: true,
                runtimeInstanceId: true,
                documentGeneration: true,
                snapshotId: true,
                targetAmbiguity: true,
                domActions: true,
                actionVerification: true,
                occlusion: true,
                wait: true,
                search: true,
                pageImages: true,
                redaction: true,
                nestedInputDiscovery: true,
                specializedPages: comfyUIAdapter ? ['comfyui-litegraph'] : [],
                comfyUIWidgetActions: Boolean(comfyUIAdapter)
            };
        }

        return Object.freeze({
            version: VERSION,
            pageCore,
            snapshot,
            execute,
            resolveTarget,
            createPersistentTarget,
            scoreContentImage,
            checkOcclusion,
            waitFor,
            pageCodeSearch,
            invalidateDocument,
            getIdentity,
            getCapabilities,
            setRedactionEnabled,
            isReadOnlyCommand(command) {
                return READ_ONLY_COMMANDS.has(String(command || ''));
            }
        });
    }

    return Object.freeze({
        VERSION,
        KIND_ID_PATTERN,
        STRICT_HANDLE_PATTERN,
        STRICT_IMAGE_ID_PATTERN,
        READ_ONLY_COMMANDS,
        REGISTRY_SNAPSHOT_RETENTION,
        createWebAgentPageRuntime
    });
});