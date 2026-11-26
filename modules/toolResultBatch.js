'use strict';

const { guardMarkdownDataImagesForUpstream } = require('./markdownDataImageGuard.js');
const { projectNativeToolResultMedia } = require('./nativeToolResultMedia.js');

let lastTimestampMs = 0;
const START_PREFIX = '<<<[VCP_TOOL_BATCH_START:';
const END_PREFIX = '<<<[VCP_TOOL_BATCH_END:';
const timestampPattern = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}(?:Z|[+-]\\d{2}:\\d{2})';
let cachedTimezone;
let cachedFormatter;

/** Use the project's configured timezone, including DST and fractional offsets. */
function formatBatchTimestamp(date) {
    const timezone = process.env.DEFAULT_TIMEZONE || 'Asia/Shanghai';
    if (!cachedFormatter || cachedTimezone !== timezone) {
        const options = {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            fractionalSecondDigits: 3, hourCycle: 'h23', timeZoneName: 'longOffset'
        };
        try {
            cachedFormatter = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: timezone });
        } catch (error) {
            console.warn(`[ToolResultBatch] Invalid DEFAULT_TIMEZONE="${timezone}", using Asia/Shanghai: ${error.message}`);
            cachedFormatter = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'Asia/Shanghai' });
        }
        cachedTimezone = timezone;
    }
    const parts = Object.fromEntries(cachedFormatter.formatToParts(date).map(part => [part.type, part.value]));
    const offset = parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName.replace(/^GMT/, '');
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${offset}`;
}

/** Build only after collecting the batch, so delimiter collisions can be checked. */
function formatToolResultBatch(parts, enableRoleDivider = true) {
    const body = parts.join('');
    if (!body) return '';
    let timestamp;
    let start;
    let end;
    do {
        lastTimestampMs = Math.max(Date.now(), lastTimestampMs + 1);
        timestamp = formatBatchTimestamp(new Date(lastTimestampMs));
        start = `${START_PREFIX}${timestamp}]>>>`;
        end = `${END_PREFIX}${timestamp}]>>>`;
    } while (body.includes(start) || body.includes(end));
    const batch = `\n${start}\n${body}\n${end}\n`;
    return enableRoleDivider
        ? `\n<<<[ROLE_DIVIDE_USER]>>>\n${batch}\n<<<[END_ROLE_DIVIDE_USER]>>>\n`
        : batch;
}

/** A fresh scanner per call; quoted batches are opaque, never recursively parsed. */
function createBatchStartScanner() {
    return new RegExp(`${START_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(${timestampPattern})\\]>>>`, 'g');
}

function findBatchEnd(text, match) {
    const marker = `${END_PREFIX}${match[1]}]>>>`;
    const index = text.indexOf(marker, match.index + match[0].length);
    return index === -1 ? text.length : index + marker.length;
}

/**
 * Project only wrapper boundaries, never protocol-looking text inside a payload.
 * This is structural recognition, not authentication of server origin.
 */
function projectBatchWrapperText(text, role) {
    if (!['assistant', 'user'].includes(role) ||
        typeof text !== 'string' || /^\s*<!-- VCP_TOOL_PAYLOAD -->/.test(text)) return text;
    const scanner = createBatchStartScanner();
    const edits = [];
    let cursor = 0;
    while (cursor < text.length) {
        scanner.lastIndex = cursor;
        const match = scanner.exec(text);
        if (!match) break;
        const endMarker = `${END_PREFIX}${match[1]}]>>>`;
        const endIndex = text.indexOf(endMarker, match.index + match[0].length);
        if (endIndex === -1) break;
        const end = endIndex + endMarker.length;
        const before = text.slice(cursor, match.index);
        const after = text.slice(end);
        const wrapped = /<<<\[ROLE_DIVIDE_USER\]>>>\s*$/.test(before) &&
            /^\s*<<<\[END_ROLE_DIVIDE_USER\]>>>/.test(after);
        const wholeUserBatch = role === 'user' && cursor === 0 &&
            /^\s*$/.test(before) && /^\s*$/.test(after);
        if (wrapped || wholeUserBatch) {
            const date = new Date(match[1]);
            const displayTimestamp = Number.isNaN(date.getTime()) ? match[1] : formatBatchTimestamp(date);
            edits.push({ start: match.index, end: match.index + match[0].length,
                value: `【工具返回批次开始｜时间：${displayTimestamp}】` });
            edits.push({ start: endIndex, end,
                value: `【工具返回批次结束｜时间：${displayTimestamp}】` });
        }
        // Even unprojected batches are opaque: do not rewrite nested quotations.
        cursor = end;
    }
    for (let i = edits.length - 1; i >= 0; i--) {
        const edit = edits[i];
        text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
    }
    return text;
}

const DISPLAY_NAME_ROLES = new Set(['system', 'developer', 'user', 'assistant']);

/** Request-only projection. Preserve native tool/function names and internal history. */
function projectToolBatchForUpstream(body) {
    if (!body || !Array.isArray(body.messages)) return body;
    const projected = guardMarkdownDataImagesForUpstream(projectBatchWrappersForUpstream(body));
    let changed = false;
    const messages = projected.messages.map(message => {
        if (!message || !DISPLAY_NAME_ROLES.has(message.role) || !Object.hasOwn(message, 'name')) {
            return message;
        }
        const outboundMessage = { ...message };
        delete outboundMessage.name;
        changed = true;
        return outboundMessage;
    });
    return projectNativeToolResultMedia(changed ? { ...projected, messages } : projected);
}

function projectBatchWrappersForUpstream(body) {
    return {
        ...body,
        messages: body.messages.map(message => {
            if (!message) return message;
            const content = message.content;
            if (typeof content === 'string') {
                const projected = projectBatchWrapperText(content, message.role);
                return projected === content ? message : { ...message, content: projected };
            }
            // Only a single text part can be established as a complete wrapper.
            // Ambiguous cross-part wrappers are deliberately left unchanged.
            if (Array.isArray(content)) {
                const texts = content.filter(part => part?.type === 'text' && typeof part.text === 'string');
                if (texts.length !== 1) return message;
                const projected = projectBatchWrapperText(texts[0].text, message.role);
                if (projected === texts[0].text) return message;
                return { ...message, content: content.map(part =>
                    part === texts[0] ? { ...part, text: projected } : part) };
            }
            return message;
        })
    };
}

async function buildToolPayloadMessage(groups, translateMedia) {
    const header = '<!-- VCP_TOOL_PAYLOAD -->\nResults:';
    const footer = '<!-- VCP_TOOL_PAYLOAD_END -->';
    const label = (group, index) => `[${index + 1}] ${String(group.name || '工具').replace(/[\r\n]+/g, ' ')}`;
    const plainText = groups.every(group =>
        group.parts.every(part => part?.type === 'text' && typeof part.text === 'string'));
    if (plainText) {
        const sections = groups.map((group, index) => {
            const text = group.parts.map(part => part.text).join('\n\n');
            return groups.length > 1 ? `${label(group, index)}\n${text}` : text;
        });
        const text = sections.join('\n\n');
        const separator = groups.length > 1 ? '\n' : ' ';
        return { role: 'user', content: `${header}${text ? separator + text : ''}\n${footer}` };
    }
    const parts = [{ type: 'text', text: header }, ...groups.flatMap((group, index) =>
        groups.length > 1 ? [{ type: 'text', text: label(group, index) }, ...group.parts] : group.parts)];
    const translated = translateMedia ? await translateMedia(parts) : parts;
    return { role: 'user', content: [...translated, { type: 'text', text: footer }] };
}

module.exports = {
    formatToolResultBatch, createBatchStartScanner, findBatchEnd, projectToolBatchForUpstream, buildToolPayloadMessage
};