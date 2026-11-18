'use strict';

const START = '<---VCP记忆思维区Start--->';
const END = '<---VCP记忆思维区End--->';

// Only explicit system messages are sources. Ordinary user/assistant text is never promoted.
function textSegments(content) {
    if (typeof content === 'string') return [{ text: content }];
    if (Array.isArray(content)) {
        return content.flatMap((part, index) =>
            part?.type === 'text' && typeof part.text === 'string'
                ? [{ text: part.text, index }] : []);
    }
    if (content && typeof content.text === 'string') return [{ text: content.text }];
    return [];
}

function extractTray(content) {
    const segments = textSegments(content);
    let offset = 0;
    for (const segment of segments) {
        segment.start = offset;
        offset += segment.text.length + 1;
    }
    const text = segments.map(segment => segment.text).join('\n');
    if (!text.includes(START) && !text.includes(END)) return null;

    const ranges = [];
    const bodies = [];
    let cursor = 0;
    while (cursor < text.length) {
        const start = text.indexOf(START, cursor);
        const strayEnd = text.indexOf(END, cursor);
        if (start === -1 && strayEnd === -1) break;
        if (start === -1 || (strayEnd !== -1 && strayEnd < start)) {
            throw new Error('结束标记前缺少起始标记');
        }
        const bodyStart = start + START.length;
        const end = text.indexOf(END, bodyStart);
        const nested = text.indexOf(START, bodyStart);
        if (end === -1 || (nested !== -1 && nested < end)) {
            throw new Error('托盘标记未闭合或存在嵌套');
        }
        ranges.push([start, end + END.length]);
        bodies.push(text.slice(bodyStart, end));
        cursor = end + END.length;
    }

    const cleanSegment = segment => {
        let cleaned = '';
        let position = 0;
        for (const [start, end] of ranges) {
            const left = Math.max(0, start - segment.start);
            const right = Math.min(segment.text.length, end - segment.start);
            if (left >= right) continue;
            cleaned += segment.text.slice(position, left);
            position = right;
        }
        return cleaned + segment.text.slice(position);
    };
    let cleanedContent;
    if (typeof content === 'string') {
        cleanedContent = cleanSegment(segments[0]);
    } else if (Array.isArray(content)) {
        const byIndex = new Map(segments.map(segment => [segment.index, segment]));
        cleanedContent = content.map((part, index) => byIndex.has(index)
            ? { ...part, text: cleanSegment(byIndex.get(index)) } : part);
    } else {
        cleanedContent = { ...content, text: cleanSegment(segments[0]) };
    }
    return { content: cleanedContent, bodies };
}

function markPrefixCacheBreakpoint(messages, insertionIndex) {
    for (let index = insertionIndex - 1; index >= 0; index--) {
        const message = messages[index];
        if (message?.role !== 'user' && message?.role !== 'assistant') continue;
        const content = message.content;
        if (typeof content === 'string' && content.trim()) {
            messages[index] = {
                ...message,
                content: [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }]
            };
            return index;
        }
        if (Array.isArray(content)) {
            for (let partIndex = content.length - 1; partIndex >= 0; partIndex--) {
                const part = content[partIndex];
                if (part?.type !== 'text' || typeof part.text !== 'string' || !part.text.trim()) continue;
                if (!part.cache_control) {
                    const parts = content.slice();
                    parts[partIndex] = { ...part, cache_control: { type: 'ephemeral' } };
                    messages[index] = { ...message, content: parts };
                }
                return index;
            }
        } else if (content && typeof content.text === 'string' && content.text.trim()) {
            if (!content.cache_control) {
                messages[index] = {
                    ...message,
                    content: { ...content, cache_control: { type: 'ephemeral' } }
                };
            }
            return index;
        }
    }
    return -1;
}

class MemoryThinkingTray {
    constructor() {
        this.config = {};
    }

    async initialize(config = {}) {
        this.config = { ...config };
    }

    async processMessages(messages, config = {}) {
        const effective = { ...this.config, ...config };
        if (!Array.isArray(messages)) return messages;

        const rawDepth = effective.MEMORY_THINKING_TRAY_DEPTH;
        const parsedDepth = rawDepth === undefined || String(rawDepth).trim() === ''
            ? NaN : Number(rawDepth);
        const depth = Number.isSafeInteger(parsedDepth) && parsedDepth >= 0 ? parsedDepth : 1;
        const replacements = new Map();
        const bodies = [];
        try {
            for (let index = 0; index < messages.length; index++) {
                if (messages[index]?.role !== 'system') continue;
                const result = extractTray(messages[index].content);
                if (!result) continue;
                replacements.set(index, { ...messages[index], content: result.content });
                bodies.push(...result.bodies);
            }
        } catch (error) {
            // Atomic rollback: never lose a valid earlier block because a later one is malformed.
            console.warn(`[MemoryThinkingTray] ${error.message}；本轮保留所有托盘原文。`);
            return messages;
        }
        if (replacements.size === 0) return messages;

        const output = messages.map((message, index) => replacements.get(index) || message);
        // Preserve request-local non-index array metadata without serializing it upstream.
        for (const key of Reflect.ownKeys(messages)) {
            if (typeof key === 'string' && /^(?:length|\d+)$/.test(key)) continue;
            Object.defineProperty(output, key, Object.getOwnPropertyDescriptor(messages, key));
        }
        const body = bodies.filter(value => value.trim()).join('\n\n');
        if (!body) return output;

        let leadingSystemCount = 0;
        while (output[leadingSystemCount]?.role === 'system') leadingSystemCount++;
        let index = Math.max(leadingSystemCount, output.length - depth);
        // Do not split native assistant tool_calls and their tool result sequence.
        while (index > leadingSystemCount && output[index]?.role === 'tool') index--;
        const cacheEnabled = String(effective.MEMORY_THINKING_TRAY_CACHE_BREAKPOINT).toLowerCase() === 'true';
        const cacheIndex = cacheEnabled ? markPrefixCacheBreakpoint(output, index) : -1;
        output.splice(index, 0, { role: 'user', content: `[系统提示:]\n${body}` });
        if (effective.DebugMode === true) {
            console.log(`[MemoryThinkingTray] 已搬移 ${bodies.length} 个托盘区，depth=${depth}, index=${index}, cacheIndex=${cacheIndex}`);
        }
        return output;
    }
}

module.exports = new MemoryThinkingTray();