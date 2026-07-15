'use strict';

const EMPTY_CONTENT = '[EMPTY_CONTENT]';

function prepareTextForEmbedding(text) {
    if (typeof text !== 'string') return EMPTY_CONTENT;

    const decorativeEmojis = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
    const cleaned = text
        .replace(decorativeEmojis, ' ')
        .replace(/<\|([^|]+)\|>/g, '$1')
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{2,}/g, '\n')
        .trim();

    return cleaned.length === 0 ? EMPTY_CONTENT : cleaned;
}

function extractTags(content, config = {}, options = {}) {
    if (typeof content !== 'string') return [];

    const tagLines = content.match(/Tag:\s*(.+)$/gim);
    if (!tagLines) return [];

    const allTags = [];
    for (const line of tagLines) {
        const tagContent = line.replace(/Tag:\s*/i, '');
        allTags.push(
            ...tagContent
                .split(/[,，、;|｜]/)
                .map(tag => tag.trim())
                .filter(Boolean)
        );
    }

    let tags = allTags
        .map(tag => prepareTextForEmbedding(
            tag.replace(/[。.]+$/g, '').trim()
        ))
        .filter(tag => tag !== EMPTY_CONTENT);

    const superBlacklist = Array.isArray(config.tagBlacklistSuper)
        ? config.tagBlacklistSuper.filter(Boolean)
        : [];
    if (superBlacklist.length > 0) {
        const superRegex = new RegExp(superBlacklist.join('|'), 'g');
        tags = tags.map(tag => tag.replace(superRegex, '').trim());
    }

    const blacklist = config.tagBlacklist instanceof Set
        ? config.tagBlacklist
        : new Set(config.tagBlacklist || []);
    tags = tags.filter(tag => !blacklist.has(tag) && tag.length > 0);

    const dateRegex = /(\d{4}年\d{1,2}月\d{1,2}日|\d{4}年\d{1,2}月|\d{1,2}月\d{1,2}日|\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{2}[-./]\d{1,2}[-./]\d{1,2}|\d{4}[-./]\d{1,2})/;
    tags = tags.filter(tag => {
        const isChinese = /[\u4e00-\u9fa5]/.test(tag);
        if (isChinese && tag.length > 15) return false;
        if (!isChinese && tag.length > 30) return false;
        return !dateRegex.test(tag);
    });

    const uniqueTags = [...new Set(tags)];
    const maxTags = Math.max(1, Number(options.maxTags) || 50);
    if (uniqueTags.length > maxTags) {
        const logPrefix = options.logPrefix || 'KnowledgeBase';
        console.warn(
            `[${logPrefix}] ⚠️ File has too many tags (${uniqueTags.length}). ` +
            `Truncating to top ${maxTags}.`
        );
        return uniqueTags.slice(0, maxTags);
    }

    return uniqueTags;
}

module.exports = {
    EMPTY_CONTENT,
    prepareTextForEmbedding,
    extractTags
};