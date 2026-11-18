'use strict';

const { JSDOM, VirtualConsole } = require('jsdom');
const { Readability } = require('@mozilla/readability');

// Match semantic structures, not hostnames. Multiple independent entries must not
// be collapsed to the single highest-scoring Readability candidate.
const DISCUSSION = 'b-issue-description, b-history-event, [itemprop="comment"], [role="feed"], .timeline-comment, .comment-body';
const REMOVE = 'script, style, noscript, template, svg, canvas, [hidden], [aria-hidden="true"]';
const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DETAILS|DIV|DL|DT|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|SECTION|TABLE|TBODY|TD|TH|THEAD|TR|UL)$/;

function safeUrl(value, base) {
    try {
        const url = new URL(value, base);
        return /^(https?:|mailto:)$/.test(url.protocol) ? url.href : '';
    } catch {
        return '';
    }
}

function render(root, base) {
    const code = [];
    function walk(node) {
        if (node.nodeType === 3) return node.nodeValue.replace(/\s+/g, ' ');
        if (node.nodeType !== 1 || node.matches(REMOVE)) return '';
        const tag = node.tagName;
        if (tag === 'PRE' || tag === 'CODE') {
            const raw = node.textContent.replace(/\r\n/g, '\n');
            const fence = '`'.repeat(Math.max(3, ...Array.from(raw.matchAll(/`+/g), m => m[0].length + 1)));
            const value = tag === 'PRE' ? `\n\n${fence}\n${raw}\n${fence}\n\n` : raw;
            const token = `\uE000URLFETCH_CODE_${code.length}\uE001`;
            code.push(value);
            return token;
        }
        if (tag === 'BR') return '\n';
        if (tag === 'IMG') {
            const src = safeUrl(node.getAttribute('src'), base);
            return src ? ` [图片: ${node.getAttribute('alt') || ''}](${src}) ` : '';
        }
        let text = Array.from(node.childNodes, walk).join('');
        if (tag === 'A') {
            const href = safeUrl(node.getAttribute('href'), base);
            if (href) text = `[${text.trim() || href}](${href})`;
        }
        if (tag === 'LI') {
            const parent = node.parentElement;
            const number = parent?.tagName === 'OL'
                ? `${Array.from(parent.children).indexOf(node) + Number(parent.getAttribute('start') || 1)}. `
                : '- ';
            text = number + text.trim();
        }
        // Custom components also delimit independent entries / metadata fields.
        const block = BLOCK.test(tag) || tag.includes('-');
        return block ? `\n${text}\n` : text;
    }
    const output = walk(root).replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n')
        .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return output.replace(/\uE000URLFETCH_CODE_(\d+)\uE001/g, (_, i) => code[Number(i)]);
}

function extractHtml(html, url) {
    // CSS parsing diagnostics are not extraction failures; do not log full
    // third-party stylesheets (or parse any executable resources).
    const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() });
    try {
        const doc = dom.window.document;
        doc.querySelectorAll(REMOVE).forEach(node => node.remove());
        const body = doc.body;
        const appRoots = Array.from(doc.querySelectorAll('app-root, app-root-body, #root, #app, #__next'));
        if (appRoots.length && appRoots.every(root => render(root, url).replace(/\s/g, '').length < 80)) {
            throw new Error('页面只有应用壳或正文尚未加载，需要浏览器渲染');
        }
        const baseline = render(body, url);
        if (baseline.replace(/\s/g, '').length < 80) {
            throw new Error('页面只有应用壳或正文尚未加载，需要浏览器渲染');
        }
        const discussion = Boolean(doc.querySelector(DISCUSSION));
        let text;
        let strategy;
        if (discussion) {
            // Keep metadata outside <main> too; issue sidebars carry status,
            // priority and ownership. Only remove explicit navigation chrome.
            body.querySelectorAll('nav, [role="navigation"]').forEach(node => node.remove());
            text = render(body, url);
            strategy = 'discussion-dom';
        } else {
            // Readability mutates its input, so always parse an independent clone.
            const article = new Readability(doc.cloneNode(true)).parse();
            const main = doc.querySelector('main, [role="main"], article');
            const mainText = main ? render(main, url) : baseline;
            if (article?.content) {
                const content = new JSDOM(article.content, { url, virtualConsole: new VirtualConsole() });
                try { text = render(content.window.document.body, url); }
                finally { content.window.close(); }
            }
            // A semantic main region is a useful lower bound: reject a tiny
            // selected fragment rather than silently losing most of the page.
            if (!text || text.length < 80 || (main && text.length < mainText.length * 0.65)) {
                text = mainText;
                strategy = 'semantic-dom';
            } else {
                strategy = 'readability';
            }
        }
        if (!text || text.replace(/\s/g, '').length < 80) {
            throw new Error('未提取到有效正文');
        }
        return {
            text: `标题: ${doc.title || url}\n来源: ${url}\n提取: ${strategy}（当前已加载 DOM；不保证未展开、分页及附件内容）\n\n${text}`,
            strategy,
            entries: doc.querySelectorAll('b-issue-description, b-history-event').length
        };
    } finally {
        dom.window.close();
    }
}

async function preparePage(page) {
    // Content readiness is distinct from networkidle. In particular, an SPA
    // may have finished navigation while its issue RPC has not populated DOM.
    await page.waitForFunction(() => {
        const body = document.body;
        if (!body || body.innerText.trim().length < 80) return false;
        const issue = document.querySelector('issue-details-wrapper');
        return !issue || Boolean(document.querySelector('b-issue-description b-note-container'));
    }, { timeout: 10000, polling: 250 });

    let previous = '';
    let stable = 0;
    for (let step = 0; step < 8; step++) {
        const state = await page.evaluate(() => {
            const candidates = [document.scrollingElement,
                ...document.querySelectorAll('main, article, [role="main"], [role="feed"], [cdkscrollable]')];
            const unique = Array.from(new Set(candidates.filter(Boolean)));
            const scrollables = unique.filter(el => el.clientHeight > 100 && el.scrollHeight > el.clientHeight + 20);
            for (const el of scrollables) el.scrollTop = el.scrollHeight;
            return JSON.stringify({
                text: document.body.innerText,
                heights: scrollables.map(el => el.scrollHeight)
            });
        });
        stable = state === previous ? stable + 1 : 0;
        previous = state;
        if (stable >= 2) return;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    console.error('UrlFetch: 有界滚动预算耗尽，仅提取当前已加载 DOM');
}

async function extractPage(page) {
    return extractHtml(await page.content(), page.url()).text;
}

module.exports = { extractHtml, render, preparePage, extractPage };