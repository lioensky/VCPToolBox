// content.js for VCP SynchroVision Eye

// --- Markdown Extraction Logic (Adapted from VCPChrome) ---

let vcpIdCounter = 0;

function isInteractive(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;

    const tagName = node.tagName.toLowerCase();
    const role = node.getAttribute('role');

    if (['a', 'button', 'input', 'textarea', 'select', 'option'].includes(tagName)) return true;
    if (role && ['button', 'link', 'checkbox', 'radio', 'menuitem', 'tab', 'switch', 'option', 'searchbox', 'textbox'].includes(role)) return true;
    if (node.hasAttribute('onclick')) return true;
    if (style.cursor === 'pointer' && tagName !== 'body' && tagName !== 'html') return true;

    return false;
}

function formatInteractiveElement(el) {
    if (el.hasAttribute('vcp-id')) return '';

    vcpIdCounter++;
    const vcpId = `vcp-id-${vcpIdCounter}`;
    el.setAttribute('vcp-id', vcpId);

    let text = (el.innerText || el.value || el.placeholder || el.ariaLabel || el.title || '').trim().replace(/\s+/g, ' ');
    const tagName = el.tagName.toLowerCase();

    if (tagName === 'a' && el.href) return `[Link: ${text || 'Untitled'}](${el.href})`;
    if (tagName === 'button') return `[Button: ${text || 'Untitled'}]`;
    if (tagName === 'input') return `[Input: ${text || 'Untitled'}]`;

    return text ? `[${text}]` : '';
}

function pageToMarkdown() {
    try {
        document.querySelectorAll('[vcp-id]').forEach(el => el.removeAttribute('vcp-id'));
        vcpIdCounter = 0;
        const body = document.body;
        if (!body) return '';

        let markdown = `# ${document.title}\nURL: ${document.URL}\n\n`;
        const ignoredTags = ['SCRIPT', 'STYLE', 'FOOTER', 'IFRAME', 'NOSCRIPT', 'NAV'];
        const processedNodes = new WeakSet();

        function processNode(node) {
            if (!node || processedNodes.has(node)) return '';

            if (node.nodeType === Node.ELEMENT_NODE) {
                const style = window.getComputedStyle(node);
                if (style.display === 'none' || style.visibility === 'hidden') return '';
                if (ignoredTags.includes(node.tagName)) return '';
            }

            if (isInteractive(node)) {
                const interactiveMd = formatInteractiveElement(node);
                if (interactiveMd) {
                    processedNodes.add(node);
                    node.querySelectorAll('*').forEach(child => processedNodes.add(child));
                    return interactiveMd + ' ';
                }
            }

            if (node.nodeType === Node.TEXT_NODE) {
                return node.textContent.replace(/\s+/g, ' ').trim() + ' ';
            }

            let childContent = '';
            node.childNodes.forEach(child => {
                childContent += processNode(child);
            });

            if (node.nodeType === Node.ELEMENT_NODE && childContent.trim()) {
                const style = window.getComputedStyle(node);
                if (style.display === 'block' || style.display === 'flex' || style.display === 'grid' || node.tagName === 'P' || node.tagName === 'DIV') {
                    return '\n' + childContent.trim() + '\n';
                }
            }

            return childContent;
        }

        markdown += processNode(body);
        return markdown.replace(/\n\s*\n/g, '\n\n').trim();
    } catch (e) {
        return `# ${document.title}\n\n[Error processing page: ${e.message}]`;
    }
}

// --- Message Handling ---

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'GET_PAGE_INFO') {
        const md = pageToMarkdown();
        sendResponse({
            url: document.location.href,
            title: document.title,
            content: md
        });
    } else if (request.type === 'CHECK_ARCHIVE_WORTHINESS') {
        const md = pageToMarkdown();
        // Simple logic: worth archiving if > 500 chars and not just a login page (heuristic)
        const isWorthy = md.length > 500 && !md.toLowerCase().includes('login') && !md.toLowerCase().includes('sign in');
        sendResponse({
            worthy: isWorthy,
            url: document.location.href,
            title: document.title,
            content: md
        });
    }
});
