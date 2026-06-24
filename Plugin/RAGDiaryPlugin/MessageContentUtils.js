'use strict';

/**
 * 提取 OpenAI/VCP message.content 中的文本内容。
 * 兼容 string / content parts array / { text } 三种常见形态。
 *
 * @param {string|Array|object|null|undefined} content
 * @returns {string}
 */
function extractTextFromContent(content) {
    if (typeof content === 'string') return content;

    if (Array.isArray(content)) {
        return content
            .filter(part => part && part.type === 'text' && typeof part.text === 'string')
            .map(part => part.text)
            .join('\n')
            .trim();
    }

    if (content && typeof content === 'object' && typeof content.text === 'string') {
        return content.text;
    }

    return '';
}

/**
 * 替换 OpenAI/VCP message.content 中的文本内容。
 * 兼容 string / content parts array / { text } 三种常见形态。
 *
 * @param {string|Array|object|null|undefined} content
 * @param {(text:string)=>string} replacer
 * @returns {string|Array|object|null|undefined}
 */
function replaceTextInContent(content, replacer) {
    if (typeof replacer !== 'function') return content;

    if (typeof content === 'string') {
        return replacer(content);
    }

    if (Array.isArray(content)) {
        const textIndices = [];
        const textValues = [];

        content.forEach((part, index) => {
            if (part && part.type === 'text' && typeof part.text === 'string') {
                textIndices.push(index);
                textValues.push(part.text);
            }
        });

        const mergedText = textValues.join('\n').trim();
        const replacedText = replacer(mergedText);

        if (textIndices.length > 0) {
            const firstIndex = textIndices[0];
            const newContent = content.map((part, index) => {
                if (!textIndices.includes(index)) return part;
                if (index === firstIndex) {
                    return { ...part, text: replacedText };
                }
                return null;
            }).filter(Boolean);
            return newContent;
        }

        return [...content, { type: 'text', text: replacedText }];
    }

    if (content && typeof content === 'object' && typeof content.text === 'string') {
        return { ...content, text: replacer(content.text) };
    }

    return content;
}

module.exports = {
    extractTextFromContent,
    replaceTextInContent
};