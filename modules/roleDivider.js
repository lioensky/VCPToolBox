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
    return text.replace(/[\n\\ ]/g, '');
}

/**
 * Copy non-enumerable array metadata produced by upstream preprocessors.
 * OneRing attaches __oneRingMeta to the messages array itself; roleDivider may
 * return a new array, so metadata (including Symbols) must be preserved explicitly.
 * Uses Reflect.ownKeys to guarantee Symbol metadata is not lost.
 */
function copyArrayMetadata(source, target) {
    if (!Array.isArray(source) || !Array.isArray(target)) return target;

    for (const key of Reflect.ownKeys(source)) {
        if (typeof key === 'string' && /^(?:length|\d+)$/.test(key)) continue;
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
const CODE_PROTECT_SIGNAL = /(?:ROLE_DIVIDE_|TOOL_REQUEST|VCP_TOOL_BATCH_|\[\[VCP调用结果|[「{][始末]|<!-- VCP_RAG|\[--- TDB)/;

const ENVELOPE_MARKERS = [
    { start: '<<<[' + 'TOOL_REQUEST]>>>', end: '<<<[' + 'END_TOOL_REQUEST]>>>', unclosedToEof: false, nested: false },
    { start: '<<<[' + 'TOOL_REQUEST_ESCAPE]>>>', end: '<<<[' + 'END_TOOL_REQUEST_ESCAPE]>>>', unclosedToEof: false, nested: false },
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
        ? copyArrayMetadata(message.content, message.content.map(part => part?.type === 'text' && typeof part.text === 'string'
            ? { ...part, text: mask(part.text) } : part))
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
                : (Array.isArray(msg.content)
                    ? copyArrayMetadata(msg.content, msg.content.map(part =>
                        part?.type === 'text' && typeof part.text === 'string'
                            ? { ...part, text: unmask(part.text) } : part))
                    : msg.content)
        }))
    };
}

/**
 * Scan a single tool request block starting at startIdx.
 * Properly recognizes parameter delimiters (「始ESCAPE」...「末ESCAPE」, 「始」...「末」),
 * skips fake closing tags or literal role tags inside parameters,
 * and stops (brakes) immediately if the block is unclosed and encounters a top-level wall.
 */
function isFuzzyToolMatchingEnabled(options) {
    if (options && options.fuzzyToolMatching !== undefined) {
        const val = options.fuzzyToolMatching;
        if (typeof val === 'string') {
            const lower = val.trim().toLowerCase();
            if (lower === 'false' || lower === '0' || lower === 'off' || lower === 'no') return false;
            if (lower === 'true' || lower === '1' || lower === 'on' || lower === 'yes') return true;
        }
        return Boolean(val);
    }
    try {
        const matcher = require('./vcpLoop/toolMarkerFuzzyMatcher');
        return Boolean(matcher?.isEnabled?.());
    } catch (_) {
        return false;
    }
}

function scanToolBlock(text, startIdx, isEscape, options, customStartLen) {
    const fuzzy = isFuzzyToolMatchingEnabled(options);
    const startMarker = isEscape ? '<<<[TOOL_REQUEST_ESCAPE]>>>' : '<<<[TOOL_REQUEST]>>>';
    const endMarker = isEscape ? '<<<[END_TOOL_REQUEST_ESCAPE]>>>' : '<<<[END_TOOL_REQUEST]>>>';
    let pos = startIdx + (typeof customStartLen === 'number' ? customStartLen : startMarker.length);
    const roleTagList = Object.values(TAGS);

    function findEndMarkerAtOrAfter(fromIdx) {
        if (!fuzzy) {
            const idx = text.indexOf(endMarker, fromIdx);
            return idx === -1 ? null : { index: idx, length: endMarker.length };
        }
        const re = isEscape ? /<{2,4}\[END_TOOL_REQUEST_ESCAPE\]>{2,4}/gi : /<{2,4}\[END_TOOL_REQUEST\]>{2,4}/gi;
        re.lastIndex = fromIdx;
        const m = re.exec(text);
        return m ? { index: m.index, length: m[0].length } : null;
    }

    function findNextToolOpenAtOrAfter(fromIdx) {
        if (!fuzzy) return text.indexOf('<<<[TOOL_REQUEST', fromIdx);
        const re = /<{2,4}\[TOOL_REQUEST/gi;
        re.lastIndex = fromIdx;
        const m = re.exec(text);
        return m ? m.index : -1;
    }

    function findAnyToolEndAtOrAfter(fromIdx) {
        if (!fuzzy) {
            const idx = text.indexOf('<<<[END_TOOL_REQUEST', fromIdx);
            if (idx === -1) return null;
            const len = text.startsWith('<<<[END_TOOL_REQUEST_ESCAPE]>>>', idx)
                ? '<<<[END_TOOL_REQUEST_ESCAPE]>>>'.length
                : (text.startsWith('<<<[END_TOOL_REQUEST]>>>', idx) ? '<<<[END_TOOL_REQUEST]>>>'.length : '<<<[END_TOOL_REQUEST'.length);
            return { index: idx, length: len };
        }
        const re = /<{2,4}\[END_TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/gi;
        re.lastIndex = fromIdx;
        const m = re.exec(text);
        return m ? { index: m.index, length: m[0].length } : null;
    }

    function createWallRegex() {
        return fuzzy
            ? /(?:<<<\[(?:END_)?ROLE_DIVIDE_|<<<\[VCP_TOOL_BATCH_START:|\[\[VCP调用结果信息汇总:|<!-- VCP_RAG_BLOCK_START|\[--- TDB 冷知识库检索|<{2,4}\[[Tt][Oo][Oo][Ll]_[Rr][Ee][Qq][Uu][Ee][Ss][Tt])/g
            : /(?:<<<\[(?:END_)?ROLE_DIVIDE_|<<<\[VCP_TOOL_BATCH_START:|\[\[VCP调用结果信息汇总:|<!-- VCP_RAG_BLOCK_START|\[--- TDB 冷知识库检索|<<<\[TOOL_REQUEST)/g;
    }

    // 辅助判定：在候选参数结束标记 afterIdx 之后，当前工具块是否拥有合法闭标
    function hasValidEndMarker(afterIdx, valStartIdx) {
        const endInfo = findEndMarkerAtOrAfter(afterIdx);
        const nextEnd = endInfo ? endInfo.index : -1;
        if (nextEnd === -1) return false;
        // 若在 afterIdx 与 nextEnd 之间启动了另一个顶层工具，说明 nextEnd 属于后续工具
        const nextTool = findNextToolOpenAtOrAfter(afterIdx);
        if (nextTool !== -1 && nextTool < nextEnd) return false;
        // 若在 afterIdx 与 nextEnd 之间出现顶层角色标签（START 或 END），说明 nextEnd 属于下游回执或后续轮次
        const nextRole = text.indexOf('<<<[ROLE_DIVIDE_', afterIdx);
        if (nextRole !== -1 && nextRole < nextEnd) return false;
        const nextEndRole = text.indexOf('<<<[END_ROLE_DIVIDE_', afterIdx);
        if (nextEndRole !== -1 && nextEndRole < nextEnd) return false;
        // 补齐批处理与汇总刹车墙 (VULN-R17-06)
        const nextBatch = text.indexOf('<<<[VCP_TOOL_BATCH_START:', afterIdx);
        if (nextBatch !== -1 && nextBatch < nextEnd) return false;
        const nextSummary = text.indexOf('[[VCP调用结果信息汇总:', afterIdx);
        if (nextSummary !== -1 && nextSummary < nextEnd) return false;
        // 补齐记忆信封刹车墙 (VULN-R18-04)
        const nextRag = text.indexOf('<!-- VCP_RAG_BLOCK_START', afterIdx);
        if (nextRag !== -1 && nextRag < nextEnd) return false;
        const nextTdb = text.indexOf('[--- TDB 冷知识库检索', afterIdx);
        if (nextTdb !== -1 && nextTdb < nextEnd) return false;
        return true;
    }

    function isValidParamContinuation(afterEndIdx, isClosedBlock = true) {
        const remaining = text.slice(afterEndIdx);
        if (isClosedBlock) {
            const closeMatch = (fuzzy
                ? remaining.match(/^\s*(?:\}\s*[,，]?|[,，]?)\s*(?:<{2,4}\[END_TOOL_REQUEST(?:_ESCAPE)?\]>{2,4})/i)
                : remaining.match(/^\s*(?:\}\s*[,，]?|[,，]?)\s*(?:<<<\[END_TOOL_REQUEST(?:_ESCAPE)?\]>>>)/))
                || remaining.match(/^\s*\}/);
            if (closeMatch) return true;
            const nextParamMatch = remaining.match(/^[ \t\r\n,，]*[a-zA-Z0-9_-]+[ \t]*:[ \t]*[「{]始/);
            if (nextParamMatch) return true;
        } else {
            if (remaining.match(/^\s*\}\s*$/)) return true;
            if (remaining.match(/^[ \t]*[,，][ \t]*[a-zA-Z0-9_-]+[ \t]*:[ \t]*[「{]始/)) return true;
        }
        const wallContinuationMatch = remaining.match(/^\s*(?:<<<\[(?:END_)?ROLE_DIVIDE_|<<<\[VCP_TOOL_BATCH_START:|\[\[VCP调用结果信息汇总:|<!-- VCP_RAG_BLOCK_START|\[--- TDB 冷知识库检索)/);
        if (wallContinuationMatch) return true;
        return false;
    }

    // 辅助判定：在 valStart 与 candidateEnd 之间检测到的 wall 标是否为参数内部自包含的合法字面量
    function isSelfContainedLiteral(wallIdx, candidateEnd, wallType, valStart, endMarkerLen) {
        if (wallType === 'role') {
            const isEndTag = text.startsWith('<<<[END_ROLE_DIVIDE_', wallIdx);
            const matchedRole = roleTagList.find(cfg => text.startsWith(isEndTag ? cfg.END : cfg.START, wallIdx));
            if (!matchedRole) return { isLiteral: false };
            if (isEndTag) {
                const lastStart = text.lastIndexOf(matchedRole.START, startIdx);
                const lastEnd = text.lastIndexOf(matchedRole.END, startIdx);
                if (lastStart !== -1 && lastStart > lastEnd) {
                    return { isLiteral: false };
                }
                if (hasValidEndMarker(candidateEnd, valStart)) {
                    return { isLiteral: true, skipTo: wallIdx + matchedRole.END.length };
                }
                return { isLiteral: false };
            }

            const firstEnd = text.indexOf(matchedRole.END, wallIdx + matchedRole.START.length);
            const nextStart = text.indexOf(matchedRole.START, wallIdx + matchedRole.START.length);
            const isPaired = firstEnd !== -1 && (nextStart === -1 || firstEnd < nextStart);
            const endTagIdx = isPaired ? firstEnd : -1;

            // 若角色块闭标位于 candidateEnd 之后，说明 candidateEnd 本身处于该角色块内部（借尾），必然是墙
            if (endTagIdx !== -1 && endTagIdx >= candidateEnd) {
                return { isLiteral: false };
            }

            const endLen = typeof endMarkerLen === 'number' ? endMarkerLen : 1;
            const remaining = text.slice(candidateEnd + endLen);

            // 若工具块自身未闭合 (!hasValidEndMarker)：
            if (!hasValidEndMarker(candidateEnd, valStart)) {
                // 1. 若以 } 结尾，严禁借用下游散文中的「末」}逃逸吞噬 (VULN-R19-01, VULN-R19-05)
                // 仅当参数紧贴定界符且位于 EOF 时作为容错保留 (Test 45, 46, 47)
                const closeMatch = remaining.match(fuzzy ? /^\s*\}(?:\s*(?:<{2,4}\[END_TOOL_REQUEST(?:_ESCAPE)?\]>{2,4})?)/i : /^\s*\}(?:\s*(?:<<<\[END_TOOL_REQUEST(?:_ESCAPE)?\]>>>)?)/);
                if (closeMatch) {
                    const textAfter = remaining.slice(closeMatch[0].length).trim();
                    if (textAfter.length > 0 || valStart !== wallIdx) {
                        return { isLiteral: false };
                    }
                } else if (!isValidParamContinuation(candidateEnd + endLen, false)) {
                    return { isLiteral: false };
                }
            }

            // 若角色块在 candidateEnd 之前完整闭合：
            if (endTagIdx !== -1 && endTagIdx < candidateEnd) {
                if (!isValidParamContinuation(candidateEnd + endLen, hasValidEndMarker(candidateEnd, valStart))) {
                    return { isLiteral: false };
                }

                const nextTool = findNextToolOpenAtOrAfter(wallIdx);
                if (nextTool !== -1 && nextTool < candidateEnd) {
                    const innerEndInfo = findAnyToolEndAtOrAfter(nextTool);
                    if (!innerEndInfo || innerEndInfo.index >= candidateEnd) {
                        return { isLiteral: false };
                    }
                }

                if (!hasValidEndMarker(candidateEnd, valStart)) {
                    const roleBetween = text.slice(endTagIdx + matchedRole.END.length, candidateEnd);
                    if (roleBetween.includes('<<<[ROLE_DIVIDE_') || roleBetween.includes('<<<[END_ROLE_DIVIDE_')) {
                        return { isLiteral: false };
                    }
                    if (roleBetween.trim().length > 0) {
                        return { isLiteral: false };
                    }
                    if (text.slice(valStart, wallIdx).trim().length > 0) {
                        return { isLiteral: false };
                    }
                }

                return { isLiteral: true, skipTo: endTagIdx + matchedRole.END.length };
            }

            // 若为单开标签（无配对闭标）：
            if (endTagIdx === -1) {
                if (hasValidEndMarker(candidateEnd, valStart)) {
                    return { isLiteral: true };
                }
                const closeMatch = remaining.match(fuzzy ? /^\s*\}(?:\s*(?:<{2,4}\[END_TOOL_REQUEST(?:_ESCAPE)?\]>{2,4})?)/i : /^\s*\}(?:\s*(?:<<<\[END_TOOL_REQUEST(?:_ESCAPE)?\]>>>)?)/);
                if (closeMatch && remaining.slice(closeMatch[0].length).trim().length === 0 && valStart === wallIdx) {
                    return { isLiteral: true };
                }
                return { isLiteral: false };
            }
            return { isLiteral: false };
        }

        if (wallType === 'tool') {
            if (!hasValidEndMarker(candidateEnd, valStart)) {
                return { isLiteral: false };
            }
            const innerEndInfo = findAnyToolEndAtOrAfter(wallIdx);
            if (innerEndInfo && innerEndInfo.index < candidateEnd) {
                return { isLiteral: true, skipTo: innerEndInfo.index + innerEndInfo.length };
            }
            const hasInnerParamStart = /[「{]始/i.test(text.slice(wallIdx, candidateEnd));
            if (!hasInnerParamStart) {
                return { isLiteral: true };
            }
            return { isLiteral: false };
        }

        if (wallType === 'batch') {
            if (!hasValidEndMarker(candidateEnd, valStart)) {
                return { isLiteral: false };
            }
            const batchMatch = text.slice(wallIdx).match(/^<<<\[VCP_TOOL_BATCH_START:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2}))\]>>>/);
            if (batchMatch) {
                const batchEndMarker = `<<<[VCP_TOOL_BATCH_END:${batchMatch[1]}]>>>`;
                const batchEndIdx = text.indexOf(batchEndMarker, wallIdx + batchMatch[0].length);
                if (batchEndIdx !== -1 && batchEndIdx < candidateEnd) {
                    return { isLiteral: true, skipTo: batchEndIdx + batchEndMarker.length };
                }
            }
            return { isLiteral: false };
        }

        if (wallType === 'summary') {
            if (!hasValidEndMarker(candidateEnd, valStart)) {
                return { isLiteral: false };
            }
            const summaryEndIdx = text.indexOf('VCP调用结果结束]]', wallIdx + '[[VCP调用结果信息汇总:'.length);
            if (summaryEndIdx !== -1 && summaryEndIdx < candidateEnd) {
                return { isLiteral: true, skipTo: summaryEndIdx + 'VCP调用结果结束]]'.length };
            }
            return { isLiteral: false };
        }

        if (wallType === 'rag' || wallType === 'tdb') {
            return { isLiteral: false };
        }

        return { isLiteral: false };
    }

    while (pos < text.length) {
        // 1. 在当前位置检查闭合标记
        if (!fuzzy && text.startsWith(endMarker, pos)) {
            return {
                start: startIdx,
                end: pos + endMarker.length,
                closed: true
            };
        }
        if (fuzzy) {
            const curEndRe = isEscape ? /^<{2,4}\[END_TOOL_REQUEST_ESCAPE\]>{2,4}/i : /^<{2,4}\[END_TOOL_REQUEST\]>{2,4}/i;
            const curEndM = curEndRe.exec(text.slice(pos));
            if (curEndM) {
                return {
                    start: startIdx,
                    end: pos + curEndM[0].length,
                    closed: true
                };
            }
        }

        // 2a. ESCAPE 参数解析
        const escStartMatch = /^[「{]始(?:ESCAPE|escape)[」}]/i.exec(text.slice(pos));
        if (escStartMatch) {
            const valStart = pos + escStartMatch[0].length;
            const escEndRegex = /[「{]末(?:ESCAPE|escape)[」}]/gi;
            escEndRegex.lastIndex = valStart;
            const escEndMatch = escEndRegex.exec(text);

            if (escEndMatch) {
                let wallHit = null;
                const wallRe = createWallRegex();
                wallRe.lastIndex = valStart;
                let m;
                while ((m = wallRe.exec(text)) !== null) {
                    if (m.index >= escEndMatch.index) break;
                    const wallIdx = m.index;
                    let wallType = 'tool';
                    if (text.startsWith('<<<[ROLE_DIVIDE_', wallIdx) || text.startsWith('<<<[END_ROLE_DIVIDE_', wallIdx)) wallType = 'role';
                    else if (text.startsWith('<<<[VCP_TOOL_BATCH_START:', wallIdx)) wallType = 'batch';
                    else if (text.startsWith('[[VCP调用结果信息汇总:', wallIdx)) wallType = 'summary';
                    else if (text.startsWith('<!-- VCP_RAG_BLOCK_START', wallIdx)) wallType = 'rag';
                    else if (text.startsWith('[--- TDB 冷知识库检索', wallIdx)) wallType = 'tdb';

                    const res = isSelfContainedLiteral(wallIdx, escEndMatch.index, wallType, valStart, escEndMatch[0].length);
                    if (!res.isLiteral) {
                        wallHit = wallIdx;
                        break;
                    }
                    if (res.skipTo) {
                        wallRe.lastIndex = res.skipTo;
                    }
                }

                if (wallHit !== null) {
                    return {
                        start: startIdx,
                        end: wallHit,
                        closed: false
                    };
                }

                pos = escEndMatch.index + escEndMatch[0].length;
                continue;
            } else {
                const wallMatch = createWallRegex().exec(text.slice(valStart));
                return {
                    start: startIdx,
                    end: wallMatch ? valStart + wallMatch.index : text.length,
                    closed: false
                };
            }
        }

        // 2b. 普通参数解析
        const normStartMatch = (fuzzy ? /^[「{]始(?!ESCAPE)(?:[^\r\n「{]*?[」}])/i : /^[「{]始[」}]/).exec(text.slice(pos));
        if (normStartMatch) {
            const valStart = pos + normStartMatch[0].length;
            const normEndRegex = fuzzy ? /[「{]末(?!ESCAPE)(?:[^\r\n「{]*?[」}])/gi : /[「{]末[」}]/g;
            normEndRegex.lastIndex = valStart;
            const normEndMatch = normEndRegex.exec(text);

            if (normEndMatch) {
                let wallHit = null;
                const wallRe = createWallRegex();
                wallRe.lastIndex = valStart;
                let m;
                while ((m = wallRe.exec(text)) !== null) {
                    if (m.index >= normEndMatch.index) break;
                    const wallIdx = m.index;
                    let wallType = 'tool';
                    if (text.startsWith('<<<[ROLE_DIVIDE_', wallIdx) || text.startsWith('<<<[END_ROLE_DIVIDE_', wallIdx)) wallType = 'role';
                    else if (text.startsWith('<<<[VCP_TOOL_BATCH_START:', wallIdx)) wallType = 'batch';
                    else if (text.startsWith('[[VCP调用结果信息汇总:', wallIdx)) wallType = 'summary';
                    else if (text.startsWith('<!-- VCP_RAG_BLOCK_START', wallIdx)) wallType = 'rag';
                    else if (text.startsWith('[--- TDB 冷知识库检索', wallIdx)) wallType = 'tdb';

                    const res = isSelfContainedLiteral(wallIdx, normEndMatch.index, wallType, valStart, normEndMatch[0].length);
                    if (!res.isLiteral) {
                        wallHit = wallIdx;
                        break;
                    }
                    if (res.skipTo) {
                        wallRe.lastIndex = res.skipTo;
                    }
                }

                if (wallHit !== null) {
                    return {
                        start: startIdx,
                        end: wallHit,
                        closed: false
                    };
                }

                pos = normEndMatch.index + normEndMatch[0].length;
                continue;
            } else {
                const wallMatch = createWallRegex().exec(text.slice(valStart));
                return {
                    start: startIdx,
                    end: wallMatch ? valStart + wallMatch.index : text.length,
                    closed: false
                };
            }
        }

        // 3. 顶层刹车墙
        if (text.startsWith('<<<[END_ROLE_DIVIDE_', pos)) {
            for (const [role, cfg] of Object.entries(TAGS)) {
                if (text.startsWith(cfg.END, pos)) {
                    const lastStart = text.lastIndexOf(cfg.START, startIdx);
                    const lastEnd = text.lastIndexOf(cfg.END, startIdx);
                    if (lastStart !== -1 && lastStart > lastEnd) {
                        return {
                            start: startIdx,
                            end: pos,
                            closed: false
                        };
                    }
                    break;
                }
            }
        }

        if (text.startsWith('<<<[ROLE_DIVIDE_', pos)) {
            const switches = options?.switches;
            let isActive = true;
            if (switches) {
                for (const [role, cfg] of Object.entries(TAGS)) {
                    if (text.startsWith(cfg.START, pos)) {
                        isActive = switches[cfg.ROLE] !== false;
                        break;
                    }
                }
            }
            if (isActive) {
                return {
                    start: startIdx,
                    end: pos,
                    closed: false
                };
            }
        }

        if (
            text.startsWith('<<<[VCP_TOOL_BATCH_START:', pos) ||
            text.startsWith('[[VCP调用结果信息汇总:', pos) ||
            text.startsWith('<!-- VCP_RAG_BLOCK_START', pos) ||
            text.startsWith('[--- TDB 冷知识库检索', pos) ||
            (fuzzy ? /^<{2,4}\[TOOL_REQUEST/i.test(text.slice(pos)) : (text.startsWith('<<<[TOOL_REQUEST', pos) && !text.startsWith(endMarker, pos)))
        ) {
            return {
                start: startIdx,
                end: pos,
                closed: false
            };
        }

        pos++;
    }

    return {
        start: startIdx,
        end: text.length,
        closed: false
    };
}
function getActiveOuterRole(text, pos) {
    let activeRole = null;
    let latestStartPos = -1;
    for (const cfg of Object.values(TAGS)) {
        const lastStart = text.lastIndexOf(cfg.START, pos);
        const lastEnd = text.lastIndexOf(cfg.END, pos);
        if (lastStart !== -1 && lastStart > lastEnd) {
            if (lastStart > latestStartPos) {
                latestStartPos = lastStart;
                activeRole = cfg;
            }
        }
    }
    return activeRole;
}

function findSummaryWallBrake(text, searchOffset, activeRole, fuzzy = false) {
    const wallSlice = text.slice(searchOffset);
    let wallRe;
    if (activeRole && activeRole.ROLE === 'user') {
        wallRe = /(?:<<<\[(?:ROLE_DIVIDE_|TOOL_REQUEST|VCP_TOOL_BATCH_START:|END_ROLE_DIVIDE_USER\]>>>)|\[\[VCP调用结果信息汇总:|<!-- VCP_RAG_BLOCK_START|\[--- TDB 冷知识库检索)/g;
    } else if (activeRole && activeRole.ROLE === 'system') {
        wallRe = /(?:<<<\[(?:ROLE_DIVIDE_|TOOL_REQUEST|VCP_TOOL_BATCH_START:|END_ROLE_DIVIDE_SYSTEM\]>>>)|\[\[VCP调用结果信息汇总:|<!-- VCP_RAG_BLOCK_START|\[--- TDB 冷知识库检索)/g;
    } else if (activeRole && activeRole.ROLE === 'assistant') {
        wallRe = /(?:<<<\[(?:ROLE_DIVIDE_|TOOL_REQUEST|VCP_TOOL_BATCH_START:|END_ROLE_DIVIDE_ASSISTANT\]>>>)|\[\[VCP调用结果信息汇总:|<!-- VCP_RAG_BLOCK_START|\[--- TDB 冷知识库检索)/g;
    } else {
        wallRe = /(?:<<<\[(?:ROLE_DIVIDE_|TOOL_REQUEST|VCP_TOOL_BATCH_START:)|\[\[VCP调用结果信息汇总:|<!-- VCP_RAG_BLOCK_START|\[--- TDB 冷知识库检索)/g;
    }

    const m = wallRe.exec(wallSlice);
    let minIdx = m ? m.index : -1;
    if (fuzzy) {
        const fuzzyOpenRe = /<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/gi;
        const fm = fuzzyOpenRe.exec(wallSlice);
        if (fm && (minIdx === -1 || fm.index < minIdx)) {
            minIdx = fm.index;
        }
    }
    return minIdx;
}

function findSummaryEnvelopeEnd(text, startPos, activeRole, fuzzy = false) {
    const startMarker = '[[VCP调用结果信息汇总:';
    const endMarker = 'VCP调用结果结束]]';
    let depth = 1;
    let scanPos = startPos + startMarker.length;

    while (depth > 0) {
        const nextStart = text.indexOf(startMarker, scanPos);
        const nextEnd = text.indexOf(endMarker, scanPos);

        if (nextEnd === -1) {
            return -1;
        }

        if (nextStart !== -1 && nextStart < nextEnd) {
            const slice = text.slice(scanPos, nextStart);
            if (
                slice.includes('<<<[ROLE_DIVIDE_') ||
                (fuzzy ? /<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/i.test(slice) : slice.includes('<<<[TOOL_REQUEST')) ||
                slice.includes('<<<[VCP_TOOL_BATCH_START:') ||
                slice.includes('<!-- VCP_RAG_BLOCK_START') ||
                slice.includes('[--- TDB 冷知识库检索')
            ) {
                return -1;
            }
            depth++;
            scanPos = nextStart + startMarker.length;
        } else {
            const slice = text.slice(scanPos, nextEnd);
            // 1. 若外层存在活动角色，不能越界吞噬外层角色的闭标
            if (activeRole && activeRole.END && slice.includes(activeRole.END)) {
                const afterEnd = nextEnd + endMarker.length;
                if (text.indexOf(activeRole.END, afterEnd) === -1) {
                    return -1;
                }
            }
            // 2. 不能包含顶层工具请求、批处理开标或其他信封开标 (VULN-R19-04)
            if (
                (fuzzy ? /<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/i.test(slice) : slice.includes('<<<[TOOL_REQUEST')) ||
                slice.includes('<<<[VCP_TOOL_BATCH_START:') ||
                slice.includes('<!-- VCP_RAG_BLOCK_START') ||
                slice.includes('[--- TDB 冷知识库检索')
            ) {
                return -1;
            }
            // 3. 角色代数对称性 (VULN-R20-04): 任何独立行角色标均破坏助手信封
            for (const cfg of Object.values(TAGS)) {
                let s = scanPos;
                while ((s = text.indexOf(cfg.START, s)) !== -1 && s < nextEnd) {
                    const lineStart = text.lastIndexOf('\n', s);
                    const prefixOnLine = text.slice(lineStart === -1 ? 0 : lineStart + 1, s).trim();
                    if (prefixOnLine.length === 0) {
                        return -1;
                    }
                    const e = text.indexOf(cfg.END, s + cfg.START.length);
                    if (e === -1 || e >= nextEnd) {
                        return -1;
                    }
                    s = e + cfg.END.length;
                }
            }

            depth--;
            scanPos = nextEnd + endMarker.length;
            if (depth === 0) {
                return scanPos;
            }
        }
    }
    return -1;
}

function isValidNonNestedEnd(text, otherSelected, otherStart, endIdx, activeRole, fuzzy = false) {
    if (endIdx === -1) return false;
    const searchOffset = otherStart + otherSelected.start.length;
    const slice = text.slice(searchOffset, endIdx);

    // 1. 信封间互斥刹车墙 (VULN-R19-04, VULN-R21-01): 不能包含任何信封开标（包括同类型与不同类型）
    const ALL_ENVELOPE_STARTS = [
        '<!-- VCP_RAG_BLOCK_START',
        '[--- TDB 冷知识库检索',
        '[[VCP调用结果信息汇总:'
    ];
    for (const envStart of ALL_ENVELOPE_STARTS) {
        if (otherSelected.start.startsWith('<<<[VCP_TOOL_BATCH_START:') && envStart === '[[VCP调用结果信息汇总:') {
            let sumIdx = searchOffset;
            while ((sumIdx = text.indexOf(envStart, sumIdx)) !== -1 && sumIdx < endIdx) {
                const sumEnd = text.indexOf('VCP调用结果结束]]', sumIdx + envStart.length);
                if (sumEnd === -1 || sumEnd >= endIdx) return false;
                sumIdx = sumEnd + 'VCP调用结果结束]]'.length;
            }
            continue;
        }
        if (slice.includes(envStart)) return false;
    }

    // 2. 不能包含顶层独立工具请求或批处理开标
    const hasTopToolOpen = fuzzy ? /<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/i.test(slice) : slice.includes('<<<[TOOL_REQUEST');
    if (hasTopToolOpen || slice.includes('<<<[VCP_TOOL_BATCH_START:')) return false;

    // 3. 外层活动角色闭标跨界判定：若包含 activeRole.END，且之后无外层闭标，则不合法
    if (activeRole && activeRole.END && slice.includes(activeRole.END)) {
        const afterEnd = endIdx + otherSelected.end.length;
        if (text.indexOf(activeRole.END, afterEnd) === -1) return false;
    }

    // 4. 角色代数对称性 (VULN-R20-04): 任何独立行角色标均破坏助手信封
    for (const cfg of Object.values(TAGS)) {
        let s = searchOffset;
        while ((s = text.indexOf(cfg.START, s)) !== -1 && s < endIdx) {
            const lineStart = text.lastIndexOf('\n', s);
            const prefixOnLine = text.slice(lineStart === -1 ? 0 : lineStart + 1, s).trim();
            if (prefixOnLine.length === 0) {
                return false;
            }
            const e = text.indexOf(cfg.END, s + cfg.START.length);
            if (e === -1 || e >= endIdx) {
                return false;
            }
            s = e + cfg.END.length;
        }
    }

    return true;
}

function findStandaloneLineMarker(text, searchOffset, marker) {
    let idx = searchOffset;
    while (idx < text.length) {
        const hit = text.indexOf(marker, idx);
        if (hit === -1) return -1;
        const lineStart = hit === 0 ? 0 : text.lastIndexOf('\n', hit - 1) + 1;
        const before = text.slice(lineStart, hit);
        const afterStart = hit + marker.length;
        const nextNl = text.indexOf('\n', afterStart);
        const lineEnd = nextNl === -1 ? text.length : nextNl;
        const after = text.slice(afterStart, lineEnd);
        if (/^[ \t\r]*$/.test(before) && /^[ \t\r]*$/.test(after)) {
            return hit;
        }
        idx = afterStart;
    }
    return -1;
}

function findEnvelopeRanges(text, options) {
    const ranges = [];
    const batchScanner = createBatchStartScanner();
    let cursor = 0;

    while (cursor < text.length) {
        batchScanner.lastIndex = cursor;
        const batch = batchScanner.exec(text);

        const fuzzyMode = isFuzzyToolMatchingEnabled(options);
        let nextToolStart = -1;
        let isEscapeTool = false;
        let nextToolStartLen = undefined;
        if (fuzzyMode) {
            const fuzzyToolRe = /<{2,4}\[(TOOL_REQUEST(?:_ESCAPE)?)\]>{2,4}/gi;
            fuzzyToolRe.lastIndex = cursor;
            const fm = fuzzyToolRe.exec(text);
            if (fm) {
                nextToolStart = fm.index;
                isEscapeTool = /_ESCAPE$/i.test(fm[1]);
                nextToolStartLen = fm[0].length;
            }
        } else {
            const nextToolReq = text.indexOf('<<<[TOOL_REQUEST]>>>', cursor);
            const nextToolReqEsc = text.indexOf('<<<[TOOL_REQUEST_ESCAPE]>>>', cursor);
            if (nextToolReq !== -1 && (nextToolReqEsc === -1 || nextToolReq <= nextToolReqEsc)) {
                nextToolStart = nextToolReq;
                isEscapeTool = false;
            } else if (nextToolReqEsc !== -1) {
                nextToolStart = nextToolReqEsc;
                isEscapeTool = true;
            }
        }

        let otherSelected = null;
        let otherStart = -1;
        for (const marker of ENVELOPE_MARKERS) {
            if (marker.start.startsWith('<<<[TOOL_REQUEST')) continue;
            const candidate = text.indexOf(marker.start, cursor);
            if (candidate === -1) continue;
            if (!marker.unclosedToEof && text.indexOf(marker.end, candidate + marker.start.length) === -1) {
                continue;
            }
            if (otherStart === -1 || candidate < otherStart) {
                otherSelected = marker;
                otherStart = candidate;
            }
        }

        let earliestType = null;
        let earliestPos = text.length + 1;

        if (batch && batch.index < earliestPos) {
            earliestType = 'batch';
            earliestPos = batch.index;
        }
        if (nextToolStart !== -1 && nextToolStart < earliestPos) {
            earliestType = 'tool';
            earliestPos = nextToolStart;
        }
        if (otherSelected && otherStart < earliestPos) {
            earliestType = 'other';
            earliestPos = otherStart;
        }

        if (!earliestType) break;

        if (earliestType === 'batch') {
            const batchEndMarker = `<<<[VCP_TOOL_BATCH_END:${batch[1]}]>>>`;
            const searchOffset = batch.index + batch[0].length;
            const endIdx = text.indexOf(batchEndMarker, searchOffset);
            let end;
            if (endIdx !== -1) {
                end = endIdx + batchEndMarker.length;
            } else {
                const activeRole = getActiveOuterRole(text, batch.index);
                const brakeMarker = (activeRole && activeRole.END) ? activeRole.END : TAGS.USER.START;
                const brakeHit = findStandaloneLineMarker(text, searchOffset, brakeMarker);
                end = brakeHit !== -1 ? brakeHit : text.length;
            }
            ranges.push({ start: batch.index, end });
            cursor = Math.max(end, batch.index + 1);
            continue;
        }

        if (earliestType === 'tool') {
            const block = scanToolBlock(text, nextToolStart, isEscapeTool, options, nextToolStartLen);
            ranges.push({ start: block.start, end: block.end });
            cursor = Math.max(block.end, block.start + 1);
            continue;
        }

        if (earliestType === 'other') {
            const searchOffset = otherStart + otherSelected.start.length;
            const activeRole = getActiveOuterRole(text, otherStart);
            if (!otherSelected.nested) {
                const endIdx = text.indexOf(otherSelected.end, searchOffset);
                let end;
                if (endIdx !== -1 && isValidNonNestedEnd(text, otherSelected, otherStart, endIdx, activeRole, fuzzyMode)) {
                    end = endIdx + otherSelected.end.length;
                } else {
                    const brakeIdx = findSummaryWallBrake(text, searchOffset, activeRole, fuzzyMode);
                    if (brakeIdx !== -1) {
                        end = searchOffset + brakeIdx;
                    } else {
                        end = text.length;
                    }
                }
                ranges.push({ start: otherStart, end });
                cursor = Math.max(end, otherStart + 1);
                continue;
            }

            const validEnd = findSummaryEnvelopeEnd(text, otherStart, activeRole, fuzzyMode);
            let end;
            if (validEnd !== -1) {
                end = validEnd;
            } else {
                const brakeIdx = findSummaryWallBrake(text, searchOffset, activeRole, fuzzyMode);
                if (brakeIdx !== -1) {
                    end = searchOffset + brakeIdx;
                } else {
                    end = text.length;
                }
            }
            ranges.push({ start: otherStart, end });
            cursor = Math.max(end, otherStart + 1);
            continue;
        }
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

function isBrokenAcrossBoundaries(text, openRoleTag, fenceStart, fenceEnd, fuzzy = false) {
    if (isBrokenAcrossOuterRole(text, openRoleTag, fenceStart, fenceEnd, fenceEnd)) {
        return true;
    }

    const firstNl = text.indexOf("\n", fenceStart);
    const isHtmlBlock = text.slice(fenceStart, fenceStart + 4).toLowerCase() === "<pre" || text.slice(fenceStart, fenceStart + 5).toLowerCase() === "<code";

    const roleTagList = Object.values(TAGS);
    for (const cfg of roleTagList) {
        let sIdx = fenceStart;
        while ((sIdx = text.indexOf(cfg.START, sIdx)) !== -1 && sIdx < fenceEnd) {
            const firstEnd = text.indexOf(cfg.END, sIdx + cfg.START.length);
            const nextStart = text.indexOf(cfg.START, sIdx + cfg.START.length);
            const isPaired = firstEnd !== -1 && (nextStart === -1 || firstEnd < nextStart);
            const nextEnd = isPaired ? firstEnd : -1;
            if (nextEnd !== -1 && nextEnd >= fenceEnd) {
                return true;
            }

            const lineStart = text.lastIndexOf('\n', sIdx);
            const prefixOnLine = text.slice(lineStart === -1 ? 0 : lineStart + 1, sIdx).trim();
            const codeBefore = (firstNl !== -1 && firstNl < sIdx) ? text.slice(firstNl + 1, sIdx) : '';
            const afterEnd = nextEnd !== -1 ? nextEnd + cfg.END.length : sIdx + cfg.START.length;
            const afterContent = text.slice(afterEnd, fenceEnd);

            // 双端闭合代数不变量 (VULN-R21-02): 成对闭合且定界符双端同时为奇数，剔除子围栏行
            const isInsideString = nextEnd !== -1 && (
                ((codeBefore.match(/"""/g) || []).length % 2 === 1 && (afterContent.match(/"""/g) || []).length % 2 === 1) ||
                ((codeBefore.match(/'''/g) || []).length % 2 === 1 && (afterContent.match(/'''/g) || []).length % 2 === 1) ||
                ((codeBefore.replace(/^[ \t]*[`~]{3,}.*$/gm, '').match(/`/g) || []).length % 2 === 1 &&
                 (afterContent.replace(/^[ \t]*[`~]{3,}.*$/gm, '').match(/`/g) || []).length % 2 === 1)
            );

            // 嵌套子围栏检查
            const fenceCodeBefore = firstNl !== -1 && firstNl < sIdx ? text.slice(firstNl + 1, sIdx).trim() : "";
            const lastNl = afterContent.lastIndexOf("\n");
            const fenceCodeAfter = lastNl !== -1 ? afterContent.slice(0, lastNl).trim() : "";
            const cleanBefore = fenceCodeBefore.replace(/^[ \t]*>[ \t]*/gm, "").trim();
            const cleanAfter = fenceCodeAfter.replace(/^[ \t]*>[ \t]*/gm, "").trim();
            const isSubFence = /^[`~]{3,}/.test(cleanBefore) && /[`~]{3,}$/.test(cleanAfter);

            if (!isHtmlBlock && prefixOnLine.length === 0 && !isInsideString && !isSubFence) {
                return true;
            }

            sIdx += cfg.START.length;
        }
    }
    if (fuzzy) {
        const beforeFence = text.slice(0, fenceStart);
        const openRe = /<{2,4}\[TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/gi;
        const closeRe = /<{2,4}\[END_TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/gi;
        let lastToolStart = -1;
        let lastToolEnd = -1;
        let om;
        while ((om = openRe.exec(beforeFence)) !== null) lastToolStart = om.index;
        let cm;
        while ((cm = closeRe.exec(beforeFence)) !== null) lastToolEnd = cm.index;
        if (lastToolStart !== -1 && lastToolStart > lastToolEnd) {
            const afterCloseRe = /<{2,4}\[END_TOOL_REQUEST(?:_ESCAPE)?\]>{2,4}/gi;
            afterCloseRe.lastIndex = fenceStart;
            const am = afterCloseRe.exec(text);
            if (am && am.index < fenceEnd) {
                return true;
            }
        }
    } else {
        const lastToolStart = text.lastIndexOf("<<<[TOOL_REQUEST", fenceStart);
        const lastToolEnd = text.lastIndexOf("<<<[END_TOOL_REQUEST", fenceStart);
        if (lastToolStart !== -1 && lastToolStart > lastToolEnd) {
            const toolEndAfter = text.indexOf("<<<[END_TOOL_REQUEST", fenceStart);
            if (toolEndAfter !== -1 && toolEndAfter < fenceEnd) {
                return true;
            }
        }
    }
    return false;
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

function findCodeLiteralRanges(text, fuzzy = false) {
    const ranges = [];
    const roleTagList = Object.values(TAGS);
    const preCloseRe = /<\/pre\s*>/gi;
    let openRoleTag = null;
    let cursor = 0;

    while (cursor < text.length) {
        // 1. Track top-level unquoted ROLE_DIVIDE scopes
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

        // 2. Fenced code blocks
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
                            !isBrokenAcrossBoundaries(text, openRoleTag, cursor, closeRangeEnd, fuzzy)
                        ) {
                            if (CODE_PROTECT_SIGNAL.test(text.slice(cursor, closeRangeEnd))) {
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

        // 3. HTML <pre>...</pre> and single-line <code>...</code> blocks
        if (text[cursor] === '<') {
            if (/^<pre(?:\s|>)/i.test(text.slice(cursor, cursor + 6))) {
                const openTagEnd = text.indexOf('>', cursor + 4);
                if (openTagEnd !== -1) {
                    preCloseRe.lastIndex = openTagEnd + 1;
                    const closeMatch = preCloseRe.exec(text);
                    if (closeMatch) {
                        const closeStart = closeMatch.index;
                        const closeEnd = closeStart + closeMatch[0].length;
                        if (!isBrokenAcrossBoundaries(text, openRoleTag, cursor, closeEnd, fuzzy)) {
                            if (CODE_PROTECT_SIGNAL.test(text.slice(cursor, closeEnd))) {
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
                        if (!isBrokenAcrossBoundaries(text, openRoleTag, cursor, closeEnd, fuzzy)) {
                            if (CODE_PROTECT_SIGNAL.test(text.slice(cursor, closeEnd))) {
                                ranges.push({ start: cursor, end: closeEnd });
                            }
                            cursor = closeEnd;
                            continue;
                        }
                    }
                }
            }
        }

        // 4. Single-line inline backtick code spans
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
                !isBrokenAcrossBoundaries(text, openRoleTag, cursor, closeEnd, fuzzy)
            ) {
                if (CODE_PROTECT_SIGNAL.test(text.slice(cursor, closeEnd))) {
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

function protectToolContent(message, options) {
    const text = extractConcatenatedText(message);
    if (/^\s*<!-- VCP_TOOL_PAYLOAD -->/.test(text)) {
        return { message, restore: messages => messages, skip: true };
    }
    const fuzzy = isFuzzyToolMatchingEnabled(options);
    const hasToolSignal = fuzzy ? /<{2,4}\[TOOL_REQUEST/i.test(text) : text.includes('<<<[TOOL_REQUEST');
    if (!text.includes(ROLE_TAG_SIGNAL) && !hasToolSignal) {
        return { message, restore: messages => messages, skip: false };
    }

    // Stage 0: Identify closed code literal ranges (fences, <pre>, <code>, inline ticks)
    const codeRanges = findCodeLiteralRanges(text, fuzzy);
    const stage0 = maskMessageRanges(message, codeRanges, 'CODE');
    const stage0Text = codeRanges.length > 0 ? extractConcatenatedText(stage0.message) : text;

    // Stage 1: Identify tool envelope ranges on the Stage 0 masked text
    const envelopeRanges = findEnvelopeRanges(stage0Text, options); 
    if (envelopeRanges.length === 0) {
        return {
            message: stage0.message,
            skip: false,
            restore: stage0.restore
        };
    }

    const stage1 = maskMessageRanges(stage0.message, envelopeRanges, 'TOOL');
    return {
        message: stage1.message,
        skip: false,
        restore: messages => stage0.restore(stage1.restore(messages))
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
function processSingleMessage(message, { ignoreList = [], switches = { system: true, assistant: true, user: true }, scanSwitches = { system: true, assistant: true, user: true }, removeDisabledTags = true, fuzzyToolMatching } = {}) {
    // Handle array content (multi-modal)
    if (Array.isArray(message.content)) {
        return processArrayMessage(message, { ignoreList, switches, scanSwitches, removeDisabledTags, fuzzyToolMatching });
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

    // Identify protected blocks using unified delimiter-aware scanner
    const protectedBlocks = findEnvelopeRanges(text, { switches, scanSwitches, fuzzyToolMatching });

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
                const hasEndAfter = allValidTags.some(t => t.type === 'END' && t.config.ROLE === firstTag.ROLE && t.index > firstTagIndex);

                if (!hasEndAfter) {
                    const nextTag = allValidTags.find(t => t.index > firstTagIndex);
                    const nextTagIndex = nextTag ? nextTag.index : text.length;
                    const innerContent = text.substring(contentStartIndex, nextTagIndex);
                    
                    if (currentTextBuffer.trim().length > 0) {
                        resultMessages.push({ ...message, role: baseRole, content: currentTextBuffer });
                    }
                    currentTextBuffer = "";

                    if (innerContent.trim().length > 0) {
                        resultMessages.push({ role: firstTag.ROLE, content: innerContent });
                    }
                    
                    cursor = nextTagIndex;
                } else {
                    // Treat as normal text if there is an END tag somewhere after
                    currentTextBuffer += firstTag.START;
                    cursor = contentStartIndex;
                }
            } else {
                // Matching end tag found
                const innerContent = text.substring(contentStartIndex, validEndTagIndex);

                // Check ignore list with strict matching (normalized)
                const normalizedInner = normalizeForIgnore(innerContent);
                if (normalizedIgnoreList.includes(normalizedInner)) {
                    // If ignored, treat the whole block (tags + content) as normal text
                    currentTextBuffer += firstTag.START + innerContent + firstTag.END;
                    cursor = validEndTagIndex + firstTag.END.length;
                } else {
                    // Valid split block
                    
                    // 1. Push accumulated buffer as base role message (if not empty or just whitespace)
                    if (currentTextBuffer.trim().length > 0) {
                        resultMessages.push({ ...message, role: baseRole, content: currentTextBuffer });
                    }
                    currentTextBuffer = "";

                    // 2. Push inner content as new role message
                    if (innerContent.trim().length > 0) {
                        resultMessages.push({ role: firstTag.ROLE, content: innerContent });
                    }

                    // 3. Move cursor past the end tag
                    cursor = validEndTagIndex + firstTag.END.length;
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
function processArrayMessage(message, { ignoreList = [], switches = { system: true, assistant: true, user: true }, scanSwitches = { system: true, assistant: true, user: true }, removeDisabledTags = true, fuzzyToolMatching } = {}) {
    const baseRole = message.role;
    const originalParts = message.content;
    const resultMessages = [];
    let currentPartsBuffer = [];

    const flushBaseBuffer = () => {
        if (currentPartsBuffer.length > 0) {
            resultMessages.push({ ...message, role: baseRole, content: copyArrayMetadata(originalParts, currentPartsBuffer) });
            currentPartsBuffer = [];
        }
    };

    for (const part of originalParts) {
        if (part.type !== 'text' || typeof part.text !== 'string') {
            currentPartsBuffer.push(part);
            continue;
        }

        // Process the text part using the string logic
        const tempMsg = { role: baseRole, content: part.text };
        const splitResults = processSingleMessage(tempMsg, { ignoreList, switches, scanSwitches, removeDisabledTags, fuzzyToolMatching });

        if (splitResults.length === 1) {
            if (splitResults[0].role === baseRole) {
                // No split occurred in this text part; preserve part metadata such as cache_control
                currentPartsBuffer.push({ ...part, type: 'text', text: splitResults[0].content });
            } else {
                flushBaseBuffer();
                resultMessages.push(splitResults[0]);
            }
        } else {
            // Split occurred!

            // 1. Handle the first part: keep in baseRole buffer only if it actually belongs to baseRole
            const firstSplitPart = splitResults[0];
            let basePartInherited = false;
            if (firstSplitPart.role === baseRole) {
                if (firstSplitPart.content.trim().length > 0) {
                    currentPartsBuffer.push({ ...part, type: 'text', text: firstSplitPart.content });
                    basePartInherited = true;
                }
                flushBaseBuffer();
            } else {
                flushBaseBuffer();
                resultMessages.push(firstSplitPart);
            }

            // 2. Middle parts are new roles (they are always pure text)
            for (let i = 1; i < splitResults.length - 1; i++) {
                resultMessages.push(splitResults[i]);
            }

            // 3. The last part becomes the new start of the buffer only if it belongs to baseRole
            const lastSplitPart = splitResults[splitResults.length - 1];
            if (lastSplitPart.role === baseRole) {
                if (lastSplitPart.content.trim().length > 0) {
                    if (!basePartInherited) {
                        currentPartsBuffer.push({ ...part, type: 'text', text: lastSplitPart.content });
                    } else {
                        const { cache_control, ...partRest } = part;
                        currentPartsBuffer.push({ ...partRest, type: 'text', text: lastSplitPart.content });
                    }
                }
            } else {
                resultMessages.push(lastSplitPart);
            }
        }
    }

    // Push remaining buffer
    flushBaseBuffer();

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
function process(messages, { ignoreList = [], switches = { system: true, assistant: true, user: true }, scanSwitches = { system: true, assistant: true, user: true }, removeDisabledTags = true, skipCount = 0, fuzzyToolMatching } = {}) {
    if (!Array.isArray(messages)) {
        return messages;
    }

    const newMessages = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (i < skipCount || msg?.role === 'tool' || msg?.role === 'function' ||
            (msg?.role === 'assistant' && (msg.tool_calls?.length || msg.function_call))) {
            newMessages.push(msg);
            continue;
        }
        const protection = protectToolContent(msg, { switches, scanSwitches, fuzzyToolMatching });
        if (protection.skip) {
            newMessages.push(msg);
            continue;
        }
         const processed = processSingleMessage(protection.message, { ignoreList, switches, scanSwitches, removeDisabledTags, fuzzyToolMatching });
        newMessages.push(...protection.restore(processed));
    }
    return copyArrayMetadata(messages, newMessages);
}

module.exports = {
    process,
    _findEnvelopeRanges: findEnvelopeRanges
};
