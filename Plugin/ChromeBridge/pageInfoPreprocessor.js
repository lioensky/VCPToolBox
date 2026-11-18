'use strict';

const PLACEHOLDER = '{{VCPChromePageInfo}}';

function textSlots(messages) {
    const slots = [];
    for (const message of messages) {
        if (!message || !['system', 'user'].includes(message.role)) continue;
        const parts = typeof message.content === 'string'
            ? [{ owner: message, key: 'content' }]
            : Array.isArray(message.content)
                ? message.content.filter(part => part?.type === 'text' && typeof part.text === 'string')
                    .map(part => ({ owner: part, key: 'text' }))
                : [];
        const text = parts.map(({ owner, key }) => owner[key]).join('\n');
        if (message.role === 'user' && !/^\s*\[系统[^\]]*\]/u.test(text)) continue;
        slots.push(...parts.filter(({ owner, key }) => owner[key].includes(PLACEHOLDER)));
    }
    return slots;
}

async function preprocessPageInfo(messages, fetchSnapshot) {
    if (!Array.isArray(messages)) return messages;
    // Freeze all original replacement sites before fetching. Never rescan page content.
    const slots = textSlots(messages);
    if (!slots.length) return messages;
    let markdown;
    try {
        markdown = await fetchSnapshot();
        if (typeof markdown !== 'string' || !markdown.trim()) {
            throw new Error('浏览器未返回页面正文');
        }
    } catch (error) {
        markdown = `[ChromeBridge 页面采样失败：${error.message || String(error)}]`;
    }
    // A page may literally contain the trigger; do not let it become a future trigger.
    markdown = markdown.replaceAll(PLACEHOLDER, 'VCPChromePageInfo');
    let injected = false;
    for (const { owner, key } of slots) {
        owner[key] = owner[key].replaceAll(PLACEHOLDER, () => {
            if (injected) return '';
            injected = true;
            return markdown;
        });
    }
    return messages;
}

module.exports = { preprocessPageInfo };