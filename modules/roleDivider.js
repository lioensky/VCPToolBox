// modules/roleDivider.js

/**
 * Role Divider Module
 * Handles splitting messages based on role divider tags:
 * <<<[ROLE_DIVIDE_SYSTEM]>>> ... <<<[END_ROLE_DIVIDE_SYSTEM]>>>
 * <<<[ROLE_DIVIDE_ASSISTANT]>>> ... <<<[END_ROLE_DIVIDE_ASSISTANT]>>>
 * <<<[ROLE_DIVIDE_USER]>>> ... <<<[END_ROLE_DIVIDE_USER]>>>
 */

const { createBatchStartScanner, findBatchEnd } = require('./toolResultBatch');

const TAGS = {
    SYSTEM: {
        START: '<<<[ROLE_DIVIDE_SYSTEM]>>>',
        END: '<<<[END_ROLE_DIVIDE_SYSTEM]>>>',
        ROLE: 'system'
    },
    ASSISTANT: {
        START: '<<<[ROLE_DIVIDE_ASSISTANT]>>>',
        END: '<<<[END_ROLE_DIVIDE_ASSISTANT]>>>',
        ROLE: 'assistant'
    },
    USER: {
        START: '<<<[ROLE_DIVIDE_USER]>>>',
        END: '<<<[END_ROLE_DIVIDE_USER]>>>',
        ROLE: 'user'
    }
};

/**
 * Helper to normalize text for ignore list matching.
 * Removes \n, \, and spaces.
 */
function normalizeForIgnore(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/[\\n\\\\ ]/g, '');
}

/**
 * Copy non-enumerable array metadata produced by upstream preprocessors.
 * OneRing attaches __oneRingMeta to the messages array itself; roleDivider may
 * return a new array, so metadata must be preserved explicitly.
 */
function copyArrayMetadata(source, target) {
    if (!Array.isArray(source) || !Array.isArray(target)) return target;

    for (const key of Object.getOwnPropertyNames(source)) {
        if (/^(?:length|\d+)$/.test(key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(source, key);
        if (!descriptor) continue;
        try {
            Object.defineProperty(target, key, descriptor);
        } catch (e) {
            // Keep role divider pure and non-fatal; metadata is best-effort.
        }
    }

    return target;
}

/**
 * Shield tool data before both disabled-tag cleanup and role parsing.
 * Scan text parts together so a block spanning multimodal parts stays opaque.
 * Restore each fragment afterwards without changing its original text.
 */
const ROLE_TAG_SIGNAL = 'ROLE_DIVIDE_';
const ROLE_START_PREFIX = '<<<[' + ROLE_TAG_SIGNAL;

const ENVELOPE_MARKERS = [
    { start: '<<<[' + 'TOOL_REQUEST]>>>', end: '<<<[' + 'END_TOOL_REQUEST]>>>', unclosedToEof: true, nested: true },
    { start: '<<<[' + 'TOOL_REQUEST_ESCAPE]>>>', end: '<<<[' + 'END_TOOL_REQUEST_ESCAPE]>>>', unclosedToEof: true, nested: true },
    { start: '[[VCP调用结果信息汇总:', end: 'VCP调用结果结束]]', unclosedToEof: true, nested: true },
    { start: '<!-- VCP_RAG_BLOCK_START', end: '<!-- VCP_RAG_BLOCK_END -->', unclosedToEof: false, nested: false },
    { start: '[--- TDB 冷知识库检索', end: '[--- 知识库检索结束 ---]', unclosedToEof: false, nested: false }
];

function extractConcatenatedText(message) {
    if (Array.isArray(message?.content)) {
        return message.content
            .filter(part => part?.type === 'text' && typeof part.text === 'string')
            .map(part => part.text)
            .join('');
    }
    return typeof message?.content === 'string' ? message.content : '';
}

function maskMessageRanges(message, ranges, label) {
    if (!ranges || ranges.length === 0) {
        return { message, restore: messages => messages };
    }
    const isArray = Array.isArray(message.content);
    const fullText = extractConcatenatedText(message);
    let prefix = `\uE000VCP_${label}_LITERAL_`;
    while (fullText.includes(prefix)) prefix += '_';

    const fragments = [];
    let offset = 0;
    const mask = value => {
        const partStart = offset;
        offset += value.length;
        let result = '';
        let localCursor = 0;
        for (const range of ranges) {
            const start = Math.max(range.start, partStart) - partStart;
            const end = Math.min(range.end, offset) - partStart;
            if (end <= start) continue;
            result += value.slice(localCursor, start);
            const token = `${prefix}${fragments.length}\uE001`;
            fragments.push({ token, value: value.slice(start, end) });
            result += token;
            localCursor = end;
        }
        return result + value.slice(localCursor);
    };

    const maskedContent = isArray
        ? message.content.map(part => part?.type === 'text' && typeof part.text === 'string'
            ? { ...part, text: mask(part.text) } : part)
        : mask(message.content);

    const unmask = value => {
        for (const fragment of fragments) {
            value = value.split(fragment.token).join(fragment.value);
        }
        return value;
    };

    return {
        message: { ...message, content: maskedContent },
        restore: messages => messages.map(msg => ({
            ...msg,
            content: typeof msg.content === 'string'
                ? unmask(msg.content)
                : (Array.isArray(msg.content) ? msg.content.map(part =>
                    part?.type === 'text' && typeof part.text === 'string'
                        ? { ...part, text: unmask(part.text) } : part) : msg.content)
        }))
    };
}

function findEnvelopeRanges(text) {
    const ranges = [];
    const batchScanner = createBatchStartScanner();
    let cursor = 0;

    while (cursor < text.length) {
        batchScanner.lastIndex = cursor;
        const batch = batchScanner.exec(text);
        let selected = null;
        let start = -1;

        for (const marker of ENVELOPE_MARKERS) {
            const candidate = text.indexOf(marker.start, cursor);
            if (candidate === -1) continue;
            if (!marker.unclosedToEof && text.indexOf(marker.end, candidate + marker.start.length) === -1) {
                continue;
            }
            if (start === -1 || candidate < start) {
                selected = marker;
                start = candidate;
            }
        }

        if (batch && (start === -1 || batch.index <= start)) {
            const end = findBatchEnd(text, batch);
            ranges.push({ start: batch.index, end });
            cursor = end;
            continue;
        }
        if (!selected) break;

        if (!selected.nested) {
            const endIdx = text.indexOf(selected.end, start + selected.start.length);
            const end = endIdx === -1 ? text.length : endIdx + selected.end.length;
            ranges.push({ start, end });
            cursor = end;
            continue;
        }

        // Balance nested blocks; an incomplete tool block protects the remainder.
        let depth = 1;
        let end = start + selected.start.length;
        while (depth > 0) {
            const nextStart = text.indexOf(selected.start, end);
            const nextEnd = text.indexOf(selected.end, end);
            if (nextEnd === -1) {
                end = text.length;
                break;
            }
            if (nextStart !== -1 && nextStart < nextEnd) {
                depth++;
                end = nextStart + selected.start.length;
            } else {
                depth--;
                end = nextEnd + selected.end.length;
            }
        }
        ranges.push({ start, end });
        cursor = end;
    }

    return ranges;
}

function isBrokenAcrossOuterRole(text, openRoleTag, innerStart, innerEnd, afterEnd) {
    if (!openRoleTag) return false;
    const inner = text.slice(innerStart, innerEnd);
    const firstEnd = inner.indexOf(openRoleTag.END);
    if (firstEnd === -1) return false;

    const firstStart = inner.indexOf(openRoleTag.START);
    if (firstStart !== -1 && firstStart < firstEnd) {
        const lastStart = inner.lastIndexOf(openRoleTag.START);
        const lastEnd = inner.lastIndexOf(openRoleTag.END);
        if (lastEnd > lastStart) return false;
    }

    if (inner.indexOf(openRoleTag.START, firstEnd + openRoleTag.END.length) !== -1) {
        return true;
    }

    const nextOuterEnd = text.indexOf(openRoleTag.END, afterEnd);
    if (nextOuterEnd === -1) return true;
    const nextOuterStart = text.indexOf(openRoleTag.START, afterEnd);
    return nextOuterStart !== -1 && nextOuterStart < nextOuterEnd;
}

function matchFenceLinePrefix(text, lineStart, lineEnd) {
    let pos = lineStart;
    while (pos < lineEnd) {
        let spaces = 0;
        while (pos + spaces < lineEnd && (text[pos + spaces] === ' ' || text[pos + spaces] === '\t') && spaces < 3) {
            spaces++;
        }
        if (pos + spaces < lineEnd && text[pos + spaces] === '>') {
            pos += spaces + 1;
            if (pos < lineEnd && (text[pos] === ' ' || text[pos] === '\t')) pos++;
        } else {
            pos += spaces;
            break;
        }
    }
    return pos;
}

function findCodeLiteralRanges(text) {
    const ranges = [];
    const roleTagList = Object.values(TAGS);
    const preCloseRe = /<\/pre\s*>/gi;
    let openRoleTag = null;
    let cursor = 0;

    while (cursor < text.length) {
        // 1. Track top-level unquoted ROLE_DIVIDE scopes so broken half-fences inside them cannot swallow outer END tags.
        if (openRoleTag && text.startsWith(openRoleTag.END, cursor)) {
            const endTagLength = openRoleTag.END.length;
            openRoleTag = null;
            cursor += endTagLength;
            continue;
        }
        if (!openRoleTag && text[cursor] === '<' && text.startsWith(ROLE_START_PREFIX, cursor)) {
            const matchedRole = roleTagList.find(cfg => text.startsWith(cfg.START, cursor));
            if (matchedRole && text.indexOf(matchedRole.END, cursor + matchedRole.START.length) !== -1) {
                openRoleTag = matchedRole;
                cursor += matchedRole.START.length;
                continue;
            }
        }
        // 2. Fenced code blocks (``` or ~~~, >=3 chars, optional blockquote > prefix, CommonMark §4.5).
        if (cursor === 0 || text[cursor - 1] === '\n') {
            let lineEnd = text.indexOf('\n', cursor);
            if (lineEnd === -1) lineEnd = text.length;
            const trimmedLineEnd = lineEnd > cursor && text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
            const fencePos = matchFenceLinePrefix(text, cursor, trimmedLineEnd);
            const ch = text[fencePos];
            if (ch === '`' || ch === '~') {
                let fenceLen = 0;
                while (fencePos + fenceLen < trimmedLineEnd && text[fencePos + fenceLen] === ch) {
                    fenceLen++;
                }
                if (fenceLen >= 3) {
                    const infoString = text.slice(fencePos + fenceLen, trimmedLineEnd);
                    if (ch !== '`' || !infoString.includes('`')) {
                        let searchLineStart = lineEnd < text.length ? lineEnd + 1 : text.length;
                        let closeRangeEnd = -1;
                        let closeLineStart = -1;
                        while (searchLineStart < text.length) {
                            const nextNl = text.indexOf('\n', searchLineStart);
                            const nextLineEnd = nextNl === -1 ? text.length : nextNl + 1;
                            const rawEnd = nextNl === -1
                                ? text.length
                                : (nextNl > searchLineStart && text[nextNl - 1] === '\r' ? nextNl - 1 : nextNl);
                            const closePos = matchFenceLinePrefix(text, searchLineStart, rawEnd);
                            if (text[closePos] === ch) {
                                let closeLen = 0;
                                while (closePos + closeLen < rawEnd && text[closePos + closeLen] === ch) {
                                    closeLen++;
                                }
                                if (closeLen >= fenceLen && /^[ \t]*$/.test(text.slice(closePos + closeLen, rawEnd))) {
                                    closeLineStart = searchLineStart;
                                    closeRangeEnd = rawEnd;
                                    break;
                                }
                            }
                            searchLineStart = nextLineEnd;
                        }

                        if (
                            closeRangeEnd !== -1 &&
                            !isBrokenAcrossOuterRole(text, openRoleTag, lineEnd, closeLineStart, closeRangeEnd)
                        ) {
                            if (text.slice(cursor, closeRangeEnd).includes(ROLE_TAG_SIGNAL)) {
                                ranges.push({ start: cursor, end: closeRangeEnd });
                            }
                            cursor = closeRangeEnd;
                            continue;
                        }
                        cursor = fencePos + fenceLen;
                        continue;
                    }
                }
            }
        }

        // 3. HTML <pre>...</pre> and single-line <code>...</code> blocks (rich UI bubbles).
        if (text[cursor] === '<') {
            if (/^<pre(?:\s|>)/i.test(text.slice(cursor, cursor + 6))) {
                const openTagEnd = text.indexOf('>', cursor + 4);
                if (openTagEnd !== -1) {
                    preCloseRe.lastIndex = openTagEnd + 1;
                    const closeMatch = preCloseRe.exec(text);
                    if (closeMatch) {
                        const closeStart = closeMatch.index;
                        const closeEnd = closeStart + closeMatch[0].length;
                        if (!isBrokenAcrossOuterRole(text, openRoleTag, openTagEnd + 1, closeStart, closeEnd)) {
                            if (text.slice(cursor, closeEnd).includes(ROLE_TAG_SIGNAL)) {
                                ranges.push({ start: cursor, end: closeEnd });
                            }
                            cursor = closeEnd;
                            continue;
                        }
                    }
                }
            } else if (/^<code(?:\s|>)/i.test(text.slice(cursor, cursor + 7))) {
                let lineEnd = text.indexOf('\n', cursor);
                if (lineEnd === -1) lineEnd = text.length;
                const openTagEnd = text.indexOf('>', cursor + 5);
                if (openTagEnd !== -1 && openTagEnd < lineEnd) {
                    const closeMatch = /<\/code\s*>/i.exec(text.slice(openTagEnd + 1, lineEnd));
                    if (closeMatch) {
                        const closeStart = openTagEnd + 1 + closeMatch.index;
                        const closeEnd = closeStart + closeMatch[0].length;
                        if (!isBrokenAcrossOuterRole(text, openRoleTag, openTagEnd + 1, closeStart, closeEnd)) {
                            if (text.slice(cursor, closeEnd).includes(ROLE_TAG_SIGNAL)) {
                                ranges.push({ start: cursor, end: closeEnd });
                            }
                            cursor = closeEnd;
                            continue;
                        }
                    }
                }
            }
        }

        // 4. Single-line inline backtick code spans (`...`, ``...``, CommonMark §6.1 with single-line bound).
        if (text[cursor] === '`') {
            let backslashes = 0;
            for (let b = cursor - 1; b >= 0 && text[b] === '\\'; b--) backslashes++;
            let tickLen = 0;
            while (cursor + tickLen < text.length && text[cursor + tickLen] === '`') tickLen++;

            if (backslashes % 2 === 1) {
                cursor += 1;
                continue;
            }

            let lineEnd = text.indexOf('\n', cursor + tickLen);
            if (lineEnd === -1) lineEnd = text.length;
            if (lineEnd > cursor && text[lineEnd - 1] === '\r') lineEnd--;

            let scan = cursor + tickLen;
            let closeStart = -1;
            let closeEnd = -1;
            while (scan < lineEnd) {
                if (text[scan] === '`') {
                    let runLen = 0;
                    while (scan + runLen < lineEnd && text[scan + runLen] === '`') runLen++;
                    if (runLen === tickLen) {
                        closeStart = scan;
                        closeEnd = scan + runLen;
                        break;
                    }
                    scan += runLen;
                } else {
                    scan++;
                }
            }

            if (
                closeEnd !== -1 &&
                !isBrokenAcrossOuterRole(text, openRoleTag, cursor + tickLen, closeStart, closeEnd)
            ) {
                if (text.slice(cursor, closeEnd).includes(ROLE_TAG_SIGNAL)) {
                    ranges.push({ start: cursor, end: closeEnd });
                }
                cursor = closeEnd;
                continue;
            }

            cursor += tickLen;
            continue;
        }

        cursor++;
    }

    return ranges;
}

function protectToolContent(message) {
    const text = extractConcatenatedText(message);
    if (/^\s*<!-- VCP_TOOL_PAYLOAD -->/.test(text)) {
        return { message, restore: messages => messages, skip: true };
    }
    if (!text.includes(ROLE_TAG_SIGNAL)) {
        return { message, restore: messages => messages, skip: false };
    }

    const envelopeRanges = findEnvelopeRanges(text);
    const stage1 = maskMessageRanges(message, envelopeRanges, 'TOOL');
    const stage1Text = envelopeRanges.length > 0 ? extractConcatenatedText(stage1.message) : text;

    if (!stage1Text.includes(ROLE_TAG_SIGNAL)) {
        return {
            message: stage1.message,
            skip: false,
            restore: stage1.restore
        };
    }

    const codeRanges = findCodeLiteralRanges(stage1Text);
    if (codeRanges.length === 0) {
        return {
            message: stage1.message,
            skip: false,
            restore: stage1.restore
        };
    }

    const stage2 = maskMessageRanges(stage1.message, codeRanges, 'CODE');
    return {
        message: stage2.message,
        skip: false,
        restore: messages => stage1.restore(stage2.restore(messages))
    };
}

/**
 * Process a single message content and split it into multiple messages if tags are present.
 * @param {Object} message - The original message object {role, content}.
 * @param {Object} options - Configuration options.
 * @param {Array<string>} options.ignoreList - List of content strings to ignore (keep tags as is).
 * @param {Object} options.switches - Granular switches { system: bool, assistant: bool, user: bool }.
 * @param {Object} options.scanSwitches - Scan switches { system: bool, assistant: bool, user: bool }.
 * @returns {Array<Object>} - Array of resulting messages.
 */
function processSingleMessage(message, { ignoreList = [], switches = { system: true, assistant: true, user: true }, scanSwitches = { system: true, assistant: true, user: true }, removeDisabledTags = true } = {}) {
    // Handle array content (multi-modal)
    if (Array.isArray(message.content)) {
        return processArrayMessage(message, { ignoreList, switches, scanSwitches, removeDisabledTags });
    }

    if (typeof message.content !== 'string') {
        return [message];
    }

    let text = message.content;

    // Step 0: Remove tags of disabled roles from the entire text before any other processing
    if (removeDisabledTags) {
        for (const key in TAGS) {
            const tagConfig = TAGS[key];
            if (!switches[tagConfig.ROLE]) {
                text = text.replaceAll(tagConfig.START, "").replaceAll(tagConfig.END, "");
            }
        }
    }

    // Check if this message's role should be scanned
    if (!scanSwitches[message.role]) {
        return [{ ...message, content: text }];
    }

    const baseRole = message.role;
    const resultMessages = [];
    let currentTextBuffer = "";
    let cursor = 0;

    // Identify protected TOOL_REQUEST blocks.
    const protectedBlocks = [];
    const blockMarkers = [
        { start: '<<<[TOOL_REQUEST]>>>', end: '<<<[END_TOOL_REQUEST]>>>' }
    ];

    for (const marker of blockMarkers) {
        let searchPos = 0;
        while (true) {
            const startIdx = text.indexOf(marker.start, searchPos);
            if (startIdx === -1) break;
            const endIdx = text.indexOf(marker.end, startIdx + marker.start.length);
            if (endIdx === -1) {
                searchPos = startIdx + marker.start.length;
                continue;
            }
            protectedBlocks.push({ start: startIdx, end: endIdx + marker.end.length });
            searchPos = endIdx + marker.end.length;
        }
    }

    // Sort protected blocks by start index
    protectedBlocks.sort((a, b) => a.start - b.start);

    const normalizedIgnoreList = ignoreList.map(normalizeForIgnore);

    // Pre-scan for all valid (non-protected) tags to support refined robustness logic
    const allValidTags = [];
    for (const key in TAGS) {
        const tagConfig = TAGS[key];
        if (!switches[tagConfig.ROLE]) continue;

        // Find all START tags
        let sIdx = 0;
        while ((sIdx = text.indexOf(tagConfig.START, sIdx)) !== -1) {
            if (!protectedBlocks.some(b => sIdx >= b.start && sIdx < b.end)) {
                allValidTags.push({ type: 'START', index: sIdx, config: tagConfig });
            }
            sIdx += tagConfig.START.length;
        }

        // Find all END tags
        let eIdx = 0;
        while ((eIdx = text.indexOf(tagConfig.END, eIdx)) !== -1) {
            if (!protectedBlocks.some(b => eIdx >= b.start && eIdx < b.end)) {
                allValidTags.push({ type: 'END', index: eIdx, config: tagConfig });
            }
            eIdx += tagConfig.END.length;
        }
    }
    allValidTags.sort((a, b) => a.index - b.index);

    while (cursor < text.length) {
        // Check if current cursor is inside a protected block
        const currentBlock = protectedBlocks.find(b => cursor >= b.start && cursor < b.end);
        if (currentBlock) {
            currentTextBuffer += text.substring(cursor, currentBlock.end);
            cursor = currentBlock.end;
            continue;
        }

        // Find the first occurrence of ANY start OR end tag after cursor, but not inside protected blocks
        let firstTag = null;
        let firstTagIndex = -1;
        let isEndTag = false;

        for (const key in TAGS) {
            const tagConfig = TAGS[key];
            
            // If this role's switch is off, we will remove its tags later in the loop
            // but we don't consider them as "valid tags" for splitting.
            if (!switches[tagConfig.ROLE]) continue;

            // Check for START tag
            let searchIdxStart = cursor;
            while (true) {
                const index = text.indexOf(tagConfig.START, searchIdxStart);
                if (index === -1) break;
                if (protectedBlocks.some(b => index >= b.start && index < b.end)) {
                    searchIdxStart = index + tagConfig.START.length;
                    continue;
                }
                if (firstTagIndex === -1 || index < firstTagIndex) {
                    firstTagIndex = index;
                    firstTag = tagConfig;
                    isEndTag = false;
                }
                break;
            }

            // Check for END tag (Robustness: handle END without START)
            let searchIdxEnd = cursor;
            while (true) {
                const index = text.indexOf(tagConfig.END, searchIdxEnd);
                if (index === -1) break;
                if (protectedBlocks.some(b => index >= b.start && index < b.end)) {
                    searchIdxEnd = index + tagConfig.END.length;
                    continue;
                }
                if (firstTagIndex === -1 || index < firstTagIndex) {
                    firstTagIndex = index;
                    firstTag = tagConfig;
                    isEndTag = true;
                }
                break;
            }
        }

        // If no more tags found, append remaining text and break
        if (firstTagIndex === -1) {
            currentTextBuffer += text.substring(cursor);
            break;
        }

        // Append text before the tag to buffer
        currentTextBuffer += text.substring(cursor, firstTagIndex);

        if (isEndTag) {
            // Robustness Case 1: END tag found without a preceding START tag in this scan
            // Refined Logic: Only trigger if NO START tags exist before this index in the entire message
            const hasStartBefore = allValidTags.some(t => t.type === 'START' && t.index < firstTagIndex);
            
            if (!hasStartBefore) {
                const innerContent = currentTextBuffer;
                currentTextBuffer = "";

                const normalizedInner = normalizeForIgnore(innerContent);
                if (normalizedInner.length > 0 && !ignoreList.map(normalizeForIgnore).includes(normalizedInner)) {
                    resultMessages.push({ role: firstTag.ROLE, content: innerContent });
                } else {
                    currentTextBuffer = innerContent + firstTag.END;
                }
                cursor = firstTagIndex + firstTag.END.length;
            } else {
                // Treat as normal text if there was a START tag somewhere before (even if already processed)
                currentTextBuffer += firstTag.END;
                cursor = firstTagIndex + firstTag.END.length;
            }
        } else {
            // Normal Case: START tag found
            const contentStartIndex = firstTagIndex + firstTag.START.length;
            const endTagIndex = text.indexOf(firstTag.END, contentStartIndex);

            // Check if the found endTagIndex is protected
            let validEndTagIndex = endTagIndex;
            while (validEndTagIndex !== -1 && protectedBlocks.some(b => validEndTagIndex >= b.start && validEndTagIndex < b.end)) {
                validEndTagIndex = text.indexOf(firstTag.END, validEndTagIndex + firstTag.END.length);
            }

            if (validEndTagIndex === -1) {
                // Robustness Case 2: START tag found without a following END tag
                // Refined Logic: Only trigger if NO END tags exist after this index in the entire message
                const hasEndAfter = allValidTags.some(t => t.type === 'END' && t.index > firstTagIndex);

                if (!hasEndAfter) {
                    const innerContent = text.substring(contentStartIndex);
                    
                    if (currentTextBuffer.trim().length > 0) {
                        resultMessages.push({ ...message, role: baseRole, content: currentTextBuffer });
                    }
                    currentTextBuffer = "";

                    if (innerContent.trim().length > 0) {
                        resultMessages.push({ role: firstTag.ROLE, content: innerContent });
                    }
                    
                    cursor = text.length;
                } else {
                    // Treat as normal text if there is an END tag somewhere after
                    currentTextBuffer += firstTag.START;
                    cursor = contentStartIndex;
                }
            } else {
                // Matching end tag found
                const innerContent = text.substring(contentStartIndex, endTagIndex);

                // Check ignore list with strict matching (normalized)
                const normalizedInner = normalizeForIgnore(innerContent);
                if (normalizedIgnoreList.includes(normalizedInner)) {
                    // If ignored, treat the whole block (tags + content) as normal text
                    currentTextBuffer += firstTag.START + innerContent + firstTag.END;
                    cursor = endTagIndex + firstTag.END.length;
                } else {
                    // Valid split block
                    
                    // 1. Push accumulated buffer as base role message (if not empty or just whitespace)
                    if (currentTextBuffer.trim().length > 0) {
                        resultMessages.push({ ...message, role: baseRole, content: currentTextBuffer });
                    }
                    currentTextBuffer = "";

                    // 2. Push inner content as new role message
                    resultMessages.push({ role: firstTag.ROLE, content: innerContent });

                    // 3. Move cursor past the end tag
                    cursor = endTagIndex + firstTag.END.length;
                }
            }
        }
    }

    // Push any remaining text in buffer (if not empty or just whitespace)
    if (currentTextBuffer.trim().length > 0) {
        resultMessages.push({ ...message, role: baseRole, content: currentTextBuffer });
    }

    // If the result is empty (e.g. original was empty or only contained tags), return original
    if (resultMessages.length === 0) {
        return [message];
    }

    return resultMessages;
}

/**
 * Process a message with array content (multi-modal).
 */
function processArrayMessage(message, { ignoreList = [], switches = { system: true, assistant: true, user: true }, scanSwitches = { system: true, assistant: true, user: true }, removeDisabledTags = true } = {}) {
    const baseRole = message.role;
    const originalParts = message.content;
    const resultMessages = [];
    let currentPartsBuffer = [];

    for (const part of originalParts) {
        if (part.type !== 'text' || typeof part.text !== 'string') {
            currentPartsBuffer.push(part);
            continue;
        }

        // Process the text part using the string logic
        const tempMsg = { role: baseRole, content: part.text };
        const splitResults = processSingleMessage(tempMsg, { ignoreList, switches, scanSwitches, removeDisabledTags });

        if (splitResults.length === 1) {
            // No split occurred in this text part; preserve part metadata such as cache_control
            currentPartsBuffer.push({ ...part, type: 'text', text: splitResults[0].content });
        } else {
            // Split occurred!
            
            // 1. The first part of splitResults belongs to the current buffer
            if (splitResults[0].content.trim().length > 0) {
                currentPartsBuffer.push({ type: 'text', text: splitResults[0].content });
            }
            
            // 2. Push the accumulated buffer as a message
            if (currentPartsBuffer.length > 0) {
                resultMessages.push({ ...message, role: baseRole, content: currentPartsBuffer });
                currentPartsBuffer = [];
            }

            // 3. Middle parts are new roles (they are always pure text)
            for (let i = 1; i < splitResults.length - 1; i++) {
                resultMessages.push(splitResults[i]);
            }

            // 4. The last part becomes the new start of the buffer
            const lastSplitPart = splitResults[splitResults.length - 1];
            if (lastSplitPart.content.trim().length > 0) {
                currentPartsBuffer.push({ type: 'text', text: lastSplitPart.content });
            }
        }
    }

    // Push remaining buffer
    if (currentPartsBuffer.length > 0) {
        resultMessages.push({ ...message, role: baseRole, content: currentPartsBuffer });
    }

    return resultMessages.length > 0 ? resultMessages : [message];
}

/**
 * Process an array of messages.
 * @param {Array<Object>} messages - Array of message objects.
 * @param {Object} options - Configuration options.
 * @param {Array<string>} options.ignoreList - List of content strings to ignore.
 * @param {Object} options.switches - Granular switches { system: bool, assistant: bool, user: bool }.
 * @param {Object} options.scanSwitches - Scan switches { system: bool, assistant: bool, user: bool }.
 * @param {number} options.skipCount - Number of initial messages to skip (e.g. SystemPrompt).
 * @returns {Array<Object>} - New array of processed messages.
 */
function process(messages, { ignoreList = [], switches = { system: true, assistant: true, user: true }, scanSwitches = { system: true, assistant: true, user: true }, removeDisabledTags = true, skipCount = 0 } = {}) {
    if (!Array.isArray(messages)) {
        return messages;
    }

    const newMessages = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (i < skipCount) {
            newMessages.push(msg);
            continue;
        }
        const protection = protectToolContent(msg);
        if (protection.skip) {
            newMessages.push(msg);
            continue;
        }
        const processed = processSingleMessage(protection.message, { ignoreList, switches, scanSwitches, removeDisabledTags });
        newMessages.push(...protection.restore(processed));
    }
    return copyArrayMetadata(messages, newMessages);
}

module.exports = {
    process
};
