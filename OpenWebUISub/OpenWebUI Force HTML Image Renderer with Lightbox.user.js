// ==UserScript==
// @name           OpenWebUI Force HTML Image Renderer with Lightbox
// @version        1.2.4
// @description    Forces OpenWebUI to render HTML images (recognizes <img> tags), developed for OpenWebUI v0.6.11. Includes lightbox functionality. Uses self-contained style injection. Please update the @match URL to your OpenWebUI instance before use.
// @author         B3000Kcn
// @match          https://openwebui.b3000k.cn/*
// @run-at         document-idle
// @license        MIT
// ==/UserScript==

(function() {
    'use strict';

    const SCRIPT_NAME = 'OpenWebUI Force HTML Image Renderer with Lightbox';
    const SCRIPT_VERSION = '1.2.4';

    // --- Lightbox and interaction related variables and functions ---
    let lightboxInstance = null;
    let currentLightboxImage = null;
    let currentScale = 1.0;
    let currentTranslateX = 0;
    let currentTranslateY = 0;

    const ZOOM_STEP = 0.2;
    const MIN_SCALE = 0.1;
    const MAX_SCALE = 8.0;

    let isPanning = false;
    let panStartX = 0, panStartY = 0;
    let imageStartTranslateX = 0, imageStartTranslateY = 0;

    let isPinching = false;
    let initialPinchDistance = 0;
    let initialPinchScale = 1.0;

    function createLightboxStyles() {
        const css = `
            .gm-lightbox-overlay {
                position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                background-color: rgba(0, 0, 0, 0.88);
                display: flex; justify-content: center; align-items: center;
                z-index: 99999; cursor: pointer;
                opacity: 0; animation: gm-lightbox-fadein-overlay 0.25s forwards;
            }
            .gm-lightbox-image-container {
                position: relative;
                cursor: default;
                animation: gm-lightbox-fadein-content 0.25s forwards;
            }
            .gm-lightbox-image {
                max-width: 90vw; max-height: 90vh; display: block;
                box-shadow: 0 8px 30px rgba(0,0,0,0.7);
                border-radius: 3px;
                transition: transform 0.15s cubic-bezier(0.25, 0.1, 0.25, 1);
                transform-origin: center center;
                user-select: none;
                -webkit-user-drag: none;
            }
            @keyframes gm-lightbox-fadein-overlay { from { opacity: 0; } to { opacity: 1; } }
            @keyframes gm-lightbox-fadein-content {
                from { opacity: 0; transform: translate(${currentTranslateX}px, ${currentTranslateY}px) scale(0.9); }
                to { opacity: 1; transform: translate(${currentTranslateX}px, ${currentTranslateY}px) scale(1); }
            }
        `;
        const styleSheet = document.createElement("style");
        styleSheet.type = "text/css";
        styleSheet.textContent = css;
        document.head.appendChild(styleSheet);
    }

    function applyCurrentTransform() {
        if (currentLightboxImage) {
            currentLightboxImage.style.transform = `translate(${currentTranslateX}px, ${currentTranslateY}px) scale(${currentScale})`;
            if (!isPanning) {
                currentLightboxImage.style.cursor = (currentScale > 1.01) ? 'grab' : 'pointer';
            }
        }
    }

    function zoomImage(zoomIn) {
        if (!currentLightboxImage) return;
        const oldScale = currentScale;
        let newScale = zoomIn ? oldScale * (1 + ZOOM_STEP) : oldScale / (1 + ZOOM_STEP);
        currentScale = Math.max(MIN_SCALE, Math.min(newScale, MAX_SCALE));
        applyCurrentTransform();
    }

    function resetZoomAndPan() {
        if (!currentLightboxImage) return;
        currentScale = 1.0;
        currentTranslateX = 0;
        currentTranslateY = 0;
        applyCurrentTransform();
    }

    function handleImageWheelZoom(event) {
        if (!currentLightboxImage) return;
        event.preventDefault();
        event.stopPropagation();
        zoomImage(event.deltaY < 0);
    }

    function handleMouseDownPan(event) {
        if (event.button !== 0 || !currentLightboxImage || currentScale <= 1.01) return;
        isPanning = true;
        panStartX = event.clientX;
        panStartY = event.clientY;
        imageStartTranslateX = currentTranslateX;
        imageStartTranslateY = currentTranslateY;
        currentLightboxImage.style.cursor = 'grabbing';
        event.preventDefault();
        window.addEventListener('mousemove', handleMouseMovePan, { passive: false });
        window.addEventListener('mouseup', handleMouseUpPan, { passive: false });
    }

    function handleMouseMovePan(event) {
        if (!isPanning || !currentLightboxImage) return;
        event.preventDefault();
        const dx = event.clientX - panStartX;
        const dy = event.clientY - panStartY;
        currentTranslateX = imageStartTranslateX + dx;
        currentTranslateY = imageStartTranslateY + dy;
        applyCurrentTransform();
    }

    function handleMouseUpPan() {
        if (!isPanning) return;
        isPanning = false;
        if (currentLightboxImage) {
             applyCurrentTransform();
        }
        window.removeEventListener('mousemove', handleMouseMovePan);
        window.removeEventListener('mouseup', handleMouseUpPan);
    }

    function getTouchDistance(touch1, touch2) {
        return Math.hypot(touch1.clientX - touch2.clientX, touch1.clientY - touch2.clientY);
    }

    function handleTouchStart(event) {
        if (!currentLightboxImage) return;
        const touches = event.touches;
        if (touches.length === 2) {
            isPinching = true;
            isPanning = false;
            initialPinchDistance = getTouchDistance(touches[0], touches[1]);
            initialPinchScale = currentScale;
            event.preventDefault();
        } else if (touches.length === 1 && currentScale > 1.01) {
            if (!isPinching) {
                isPanning = true;
                panStartX = touches[0].clientX;
                panStartY = touches[0].clientY;
                imageStartTranslateX = currentTranslateX;
                imageStartTranslateY = currentTranslateY;
                event.preventDefault();
            }
        }
    }

    function handleTouchMove(event) {
        if (!currentLightboxImage) return;
        event.preventDefault();
        const touches = event.touches;
        if (isPinching && touches.length === 2) {
            const currentPinchDistance = getTouchDistance(touches[0], touches[1]);
            if (initialPinchDistance > 0) {
                let newScale = initialPinchScale * (currentPinchDistance / initialPinchDistance);
                currentScale = Math.max(MIN_SCALE, Math.min(newScale, MAX_SCALE));
                applyCurrentTransform();
            }
        } else if (isPanning && touches.length === 1) {
            const dx = touches[0].clientX - panStartX;
            const dy = touches[0].clientY - panStartY;
            currentTranslateX = imageStartTranslateX + dx;
            currentTranslateY = imageStartTranslateY + dy;
            applyCurrentTransform();
        }
    }

    function handleTouchEnd(event) {
        if (isPinching && event.touches.length < 2) {
            isPinching = false;
        }
        if (isPanning && event.touches.length < 1) {
            isPanning = false;
            if (currentLightboxImage) applyCurrentTransform();
        }
    }

    function showLightbox(imageUrl) {
        if (lightboxInstance) hideLightbox();

        currentScale = 1.0;
        currentTranslateX = 0;
        currentTranslateY = 0;

        const overlay = document.createElement('div');
        overlay.className = 'gm-lightbox-overlay';
        overlay.addEventListener('click', hideLightbox);

        const imageContainer = document.createElement('div');
        imageContainer.className = 'gm-lightbox-image-container';
        imageContainer.addEventListener('click', (e) => e.stopPropagation());

        const img = document.createElement('img');
        img.className = 'gm-lightbox-image';
        img.src = imageUrl;
        img.alt = 'Lightbox image';
        img.draggable = false;
        currentLightboxImage = img;
        applyCurrentTransform();

        img.onload = () => {
            applyCurrentTransform();
            img.addEventListener('wheel', handleImageWheelZoom, { passive: false });
            img.addEventListener('mousedown', handleMouseDownPan, { passive: false });
            imageContainer.addEventListener('touchstart', handleTouchStart, { passive: false });
            imageContainer.addEventListener('touchmove', handleTouchMove, { passive: false });
            imageContainer.addEventListener('touchend', handleTouchEnd);
            imageContainer.addEventListener('touchcancel', handleTouchEnd);
        };
        img.onerror = () => {
            console.warn(`${SCRIPT_NAME}: Lightbox image failed to load: ${imageUrl}`);
            hideLightbox();
        };

        imageContainer.appendChild(img);
        overlay.appendChild(imageContainer);
        document.body.appendChild(overlay);
        lightboxInstance = overlay;
        document.addEventListener('keydown', handleLightboxKeyDown);
    }

    function hideLightbox() {
        if (lightboxInstance) {
            if (currentLightboxImage) {
                currentLightboxImage = null;
            }
            window.removeEventListener('mousemove', handleMouseMovePan);
            window.removeEventListener('mouseup', handleMouseUpPan);
            lightboxInstance.remove();
            lightboxInstance = null;
            document.removeEventListener('keydown', handleLightboxKeyDown);
            currentScale = 1.0;
            currentTranslateX = 0;
            currentTranslateY = 0;
            isPanning = false;
            isPinching = false;
        }
    }

    function handleLightboxKeyDown(event) {
        if (!lightboxInstance) return;
        if (event.key === 'Escape') {
            hideLightbox();
        } else if (event.key === '+' || event.key === '=') {
            zoomImage(true); event.preventDefault();
        } else if (event.key === '-') {
            zoomImage(false); event.preventDefault();
        } else if (event.key === '0') {
            resetZoomAndPan(); event.preventDefault();
        }
    }

    // --- Core script constants and functions for image rendering ---
    const TARGET_DIV_DEPTH = 23;
    const PROCESSED_CLASS = `html-img-rendered-v1-2-4`; // Updated version
    const ALLOWED_CONTAINER_TAGS = ['P', 'SPAN', 'PRE', 'CODE', 'LI', 'BLOCKQUOTE', 'FIGCAPTION', 'LABEL', 'SMALL', 'STRONG', 'EM', 'B', 'I', 'U', 'SUB', 'SUP', 'MARK', 'DEL', 'INS', 'TD', 'TH', 'DT', 'DD'];
    const TAGS_TO_SKIP_PROCESSING = ['SCRIPT', 'STYLE', 'HEAD', 'META', 'LINK', 'TITLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'BUTTON', 'SELECT', 'FORM', 'IFRAME', 'VIDEO', 'AUDIO', 'CANVAS', 'SVG', 'IMG'];
    const escapedImgTagRegex = /&lt;img\s+(.*?)&gt;/gi;
    const directImgTagRegex = /<img\s+([^>]*)>/gi;

    function getElementDepth(element) {
        let depth = 0; let el = element;
        while (el) { depth++; el = el.parentElement; }
        return depth;
    }

    function getAttributeValue(attributesString, attributeName) {
        if (!attributesString || !attributeName) return null;
        try {
            let regex = new RegExp(`${attributeName}\\s*=\\s*(["'])(.*?)\\1`, 'i');
            let match = attributesString.match(regex);
            if (match && match[2] !== undefined) return match[2];
            regex = new RegExp(`${attributeName}\\s*=\\s*([^\\s"'<>]+)`, 'i');
            match = attributesString.match(regex);
            if (match && match[1] !== undefined) return match[1];
            return null;
        } catch (e) {
            return null;
        }
    }

    function processImageTag(match, attributesStringOriginal, isEscaped) {
        if (typeof match !== 'string' || match.length === 0) return match;
        if (!isEscaped && match.startsWith("<img") && match.includes('data-force-rendered="true"')) return match;

        const attributesString = attributesStringOriginal.trim();
        const src = getAttributeValue(attributesString, 'src');

        if (!src || (typeof src === 'string' && src.toLowerCase().startsWith('javascript:'))) {
            return match;
        }

        let width = getAttributeValue(attributesString, 'width');
        let height = getAttributeValue(attributesString, 'height');
        const styleString = getAttributeValue(attributesString, 'style');
        const alt = getAttributeValue(attributesString, 'alt');

        if ((!width || String(width).trim() === '') && styleString) {
            const styleWidthMatch = styleString.match(/width\s*:\s*([^;!]+)/i);
            if (styleWidthMatch && styleWidthMatch[1]) width = styleWidthMatch[1].trim();
        }
        if ((!height || String(height).trim() === '') && styleString) {
            const styleHeightMatch = styleString.match(/height\s*:\s*([^;!]+)/i);
            if (styleHeightMatch && styleHeightMatch[1]) height = styleHeightMatch[1].trim();
        }

        const img = document.createElement('img');
        img.src = src;
        img.alt = alt ? alt : `User HTML image (${isEscaped ? 'escaped' : 'direct'})`;
        img.setAttribute('data-force-rendered', 'true');

        if (width && String(width).trim() !== '') {
            const wStr = String(width).trim();
            if (wStr.includes('%') || wStr.match(/^[0-9.]+(em|rem|px|vw|vh|pt|cm|mm|in|auto)$/i)) {
                img.style.width = wStr;
            } else {
                img.setAttribute('width', wStr.replace(/px$/i, ''));
            }
        }
        if (height && String(height).trim() !== '') {
            const hStr = String(height).trim();
            if (hStr.includes('%') || hStr.match(/^[0-9.]+(em|rem|px|vw|vh|pt|cm|mm|in|auto)$/i)) {
                img.style.height = hStr;
            } else {
                img.setAttribute('height', hStr.replace(/px$/i, ''));
            }
        }

        img.style.maxWidth = '100%';
        img.style.display = 'block';
        const imgHTML = img.outerHTML;
        return `<p class="userscript-image-paragraph" style="margin: 0.5em 0; line-height: normal;">${imgHTML}</p>`;
    }

    function renderImagesInElement(element, forcedByObserver = false) {
        if (!element || typeof element.classList === 'undefined' || TAGS_TO_SKIP_PROCESSING.includes(element.tagName.toUpperCase()) || element.isContentEditable) {
            return;
        }
        const currentDepth = getElementDepth(element);
        if (currentDepth !== TARGET_DIV_DEPTH) {
            return;
        }
        const isAllowedTypeAtTargetDepth = (element.tagName.toUpperCase() === 'DIV') || ALLOWED_CONTAINER_TAGS.includes(element.tagName.toUpperCase());
        if (!isAllowedTypeAtTargetDepth) {
            return;
        }
        if (element.classList.contains(PROCESSED_CLASS)) {
            if (forcedByObserver) {
                element.classList.remove(PROCESSED_CLASS);
            } else {
                return;
            }
        }

        let madeChangeOverall = false;
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
        const textNodesToModify = [];
        let currentNodeWalker;

        while (currentNodeWalker = walker.nextNode()) {
            let parentCheck = currentNodeWalker.parentElement;
            let inSkippedSubtree = false;
            while (parentCheck && parentCheck !== element.parentElement) {
                if (parentCheck.tagName && TAGS_TO_SKIP_PROCESSING.includes(parentCheck.tagName.toUpperCase())) {
                    inSkippedSubtree = true;
                    break;
                }
                if (parentCheck === element) break;
                parentCheck = parentCheck.parentElement;
            }
            if (!inSkippedSubtree && currentNodeWalker.nodeValue && (currentNodeWalker.nodeValue.includes('&lt;img') || currentNodeWalker.nodeValue.includes('<img'))) {
                textNodesToModify.push(currentNodeWalker);
            }
        }

        for (const textNode of textNodesToModify) {
            if (!textNode.parentNode || !document.body.contains(textNode)) continue;
            const originalNodeValue = textNode.nodeValue;
            let newTextContent = originalNodeValue;
            let currentTextNodeMadeChange = false;

            const createReplacer = (isEscaped) => (match, attrs) => {
                const replacement = processImageTag(match, attrs, isEscaped);
                if (replacement !== match) currentTextNodeMadeChange = true;
                return replacement;
            };

            if (newTextContent.includes('&lt;img')) {
                newTextContent = newTextContent.replace(escapedImgTagRegex, createReplacer(true));
            }
            if (newTextContent.includes('<img')) {
                newTextContent = newTextContent.replace(directImgTagRegex, createReplacer(false));
            }

            if (currentTextNodeMadeChange) {
                madeChangeOverall = true;
                const fragmentToInsert = document.createDocumentFragment();
                const tempParsingDiv = document.createElement('div');
                tempParsingDiv.innerHTML = newTextContent;

                Array.from(tempParsingDiv.childNodes).forEach(parsedNode => {
                    const imagesToProcess = [];
                    if (parsedNode.nodeType === Node.ELEMENT_NODE) {
                        if (parsedNode.classList && parsedNode.classList.contains('userscript-image-paragraph')) {
                            const imgElement = parsedNode.querySelector('img[data-force-rendered="true"]');
                            if (imgElement) imagesToProcess.push(imgElement);
                        } else if (parsedNode.tagName === 'IMG' && parsedNode.getAttribute('data-force-rendered') === 'true') {
                           imagesToProcess.push(parsedNode);
                        } else {
                           parsedNode.querySelectorAll('img[data-force-rendered="true"]').forEach(imgElem => imagesToProcess.push(imgElem));
                        }
                    }
                    imagesToProcess.forEach(imgEl => {
                        imgEl.style.cursor = 'pointer';
                        imgEl.title = 'Click to view larger image (Scroll/pinch to zoom, Esc to close, Draggable)';
                        imgEl.addEventListener('click', function(e) {
                            e.preventDefault();
                            e.stopPropagation();
                            showLightbox(this.src);
                        });
                    });
                    fragmentToInsert.appendChild(parsedNode);
                });
                try {
                    if (textNode.parentNode) {
                        textNode.parentNode.replaceChild(fragmentToInsert, textNode);
                    }
                } catch (e) {
                    console.error(`${SCRIPT_NAME}: Error replacing text node:`, e, textNode, "with content:", newTextContent);
                }
            }
        }
        if (madeChangeOverall || (textNodesToModify.length > 0 && !element.classList.contains(PROCESSED_CLASS))) {
            if (!element.classList.contains(PROCESSED_CLASS)) {
                element.classList.add(PROCESSED_CLASS);
            }
        }
    }

    const observerCallback = (mutationsList) => {
        for (const mutation of mutationsList) {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        renderImagesInElement(node, true);
                        if (typeof node.querySelectorAll === 'function') {
                            const relevantChildSelectors = ALLOWED_CONTAINER_TAGS.join(',') + ',DIV';
                            node.querySelectorAll(relevantChildSelectors).forEach(child => {
                                if (child.nodeType === Node.ELEMENT_NODE) renderImagesInElement(child, true);
                            });
                        }
                    } else if (node.nodeType === Node.TEXT_NODE && node.parentElement) {
                        renderImagesInElement(node.parentElement, true);
                    }
                });
            } else if (mutation.type === 'characterData') {
                if (mutation.target && mutation.target.parentElement) {
                    renderImagesInElement(mutation.target.parentElement, true);
                }
            }
        }
    };
    const observer = new MutationObserver(observerCallback);
    const observerConfig = { childList: true, subtree: true, characterData: true };

    function initialScan() {
        const allRelevantSelectors = ALLOWED_CONTAINER_TAGS.join(',') + ',DIV';
        document.querySelectorAll(allRelevantSelectors).forEach(el => {
            if (el.offsetParent !== null || document.body.contains(el)) {
                renderImagesInElement(el, false);
            }
        });
    }

    function activateScript() {
        console.log(`${SCRIPT_NAME} v${SCRIPT_VERSION} activating...`);
        createLightboxStyles();
        initialScan();
        observer.observe(document.body, observerConfig);
        console.log(`${SCRIPT_NAME} v${SCRIPT_VERSION} activated and observing.`);
    }

    function waitForPageReady(callback) {
        const OPEWEBUI_CHAT_AREA_SELECTOR = 'body';

        let attempts = 0;
        const maxAttempts = 60;

        function check() {
            const chatArea = document.querySelector(OPEWEBUI_CHAT_AREA_SELECTOR);
            if (document.readyState === 'complete' && chatArea) {
                console.log(`${SCRIPT_NAME}: Page is complete and target area ('${OPEWEBUI_CHAT_AREA_SELECTOR}') found. Activating script.`);
                callback();
            } else if (attempts < maxAttempts) {
                attempts++;
                setTimeout(check, 100);
            } else {
                console.warn(`${SCRIPT_NAME}: Page ready check timed out or target area ('${OPEWEBUI_CHAT_AREA_SELECTOR}') not found. Attempting to activate anyway as a fallback.`);
                callback();
            }
        }
        if (document.readyState === 'complete') {
            check();
        } else {
            window.addEventListener('load', check, { once: true });
        }
    }

    waitForPageReady(activateScript);

})();