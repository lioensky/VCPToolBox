'use strict';

const cheerio = require('cheerio');
const crypto = require('crypto');

const SANITIZE_CACHE_MAX_SIZE = 512;
const DIRECT_KEY_MAX_CHARS = 65536;
const SANITIZE_VALUE_MAX_CHARS = 5000000;
const stripHtmlCache = new Map();
const sanitizeEmbeddingCache = new Map();

function toBoundedCacheKey(rawKey) {
    if (typeof rawKey !== 'string' || rawKey.length === 0) return '';
    if (rawKey.length <= DIRECT_KEY_MAX_CHARS) return rawKey;
    const digest = crypto.createHash('sha256').update(rawKey).digest('hex');
    return `__sha256:${rawKey.length}:${digest}`;
}

function getLruCache(map, rawKey) {
    const key = toBoundedCacheKey(rawKey);
    if (!key) return undefined;
    const val = map.get(key);
    if (val !== undefined) {
        map.delete(key);
        map.set(key, val);
    }
    return val;
}

function setLruCache(map, rawKey, val) {
    if (typeof rawKey !== 'string' || rawKey.length === 0) return;
    if (typeof val === 'string' && val.length > SANITIZE_VALUE_MAX_CHARS) return;
    const key = toBoundedCacheKey(rawKey);
    if (map.has(key)) {
        map.delete(key);
    } else if (map.size >= SANITIZE_CACHE_MAX_SIZE) {
        const oldestKey = map.keys().next().value;
        if (oldestKey !== undefined) map.delete(oldestKey);
    }
    map.set(key, val);
}

/**
 * 状态感知顶层平衡 JSON 扫描器；最多尝试八个候选起点。
 * @returns {{ match: string, index: number, parsed: any } | null}
 */
function findFirstBalancedJsonSlice(text) {
    if (!text || typeof text !== 'string' || text.length <= 50) return null;
    const len = text.length;
    let attempts = 0;
    const MAX_ATTEMPTS = 8;

    for (let start = 0; start < len - 50 && attempts < MAX_ATTEMPTS; start++) {
        const firstChar = text[start];
        if (firstChar !== '{' && firstChar !== '[') continue;

        attempts++;
        const stack = [firstChar];
        let inString = false;
        let escaped = false;

        for (let i = start + 1; i < len; i++) {
            const ch = text[i];
            if (escaped) {
                escaped = false;
                continue;
            }
            if (inString) {
                if (ch === '\\') escaped = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') {
                inString = true;
                continue;
            }

            if (ch === '{' || ch === '[') {
                stack.push(ch);
            } else if (ch === '}' || ch === ']') {
                const top = stack[stack.length - 1];
                const expectedClose = top === '{' ? '}' : ']';
                if (ch !== expectedClose) {
                    break;
                }
                stack.pop();
                if (stack.length === 0) {
                    const sliceLen = i - start + 1;
                    if (sliceLen > 50) {
                        const candidateStr = text.substring(start, i + 1);
                        try {
                            const parsed = JSON.parse(candidateStr);
                            return { match: candidateStr, index: start, parsed };
                        } catch (_) {
                            // 平衡但非合法 JSON，继续尝试内部候选起点。
                        }
                    } else {
                        start = i;
                    }
                    break;
                }
            }
        }
    }
    return null;
}

/** 移除 HTML 标签并提取纯文本。 */
function stripHtml(html) {
    if (!html) return '';
    if (typeof html !== 'string') {
        return String(html);
    }

    const cached = getLruCache(stripHtmlCache, html);
    if (cached !== undefined) return cached;

    if (!/<[a-zA-Z!/]|&#?[a-zA-Z0-9]+;/.test(html)) {
        const fastPlain = html
            .replace(/^[ \t]+/gm, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        setLruCache(stripHtmlCache, html, fastPlain);
        return fastPlain;
    }

    try {
        const $ = cheerio.load(html);
        $('style, script').remove();
        const plainText = $.text();
        const cleaned = plainText
            .replace(/^[ \t]+/gm, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        setLruCache(stripHtmlCache, html, cleaned);
        return cleaned;
    } catch (e) {
        console.error('[RAGDiaryPlugin] _stripHtml error:', e);
        return html;
    }
}

/** 移除 emoji 和特殊符号。 */
function stripEmoji(text) {
    if (!text || typeof text !== 'string') {
        return text;
    }
    return text.replace(/[\u{1F600}-\u{1F64F}]/gu, '')
        .replace(/[\u{1F300}-\u{1F5FF}]/gu, '')
        .replace(/[\u{1F680}-\u{1F6FF}]/gu, '')
        .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '')
        .replace(/[\u{2600}-\u{26FF}]/gu, '')
        .replace(/[\u{2700}-\u{27BF}]/gu, '')
        .replace(/[\u{1F900}-\u{1F9FF}]/gu, '')
        .replace(/[\u{1FA00}-\u{1FA6F}]/gu, '')
        .replace(/[\u{1FA70}-\u{1FAFF}]/gu, '')
        .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
        .replace(/[\u{200D}]/gu, '')
        .trim();
}

/** 移除工具调用技术标记，保留语义内容。 */
function stripToolMarkers(text) {
    if (!text || typeof text !== 'string') return text;

    if (!text.includes('<<<') && !/[「」『』]/.test(text)) {
        return text
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    const blacklistedKeys = ['tool_name', 'command', 'archery', 'maid'];
    const blacklistedValues = ['dailynote', 'update', 'create', 'no_reply'];

    let processed = text.replace(/(?:<<<\[?TOOL_REQUEST_ESCAPE\]?>>>([\s\S]*?)<<<\[?END_TOOL_REQUEST_ESCAPE\]?>>>|<<<\[?TOOL_REQUEST\]?>>>([\s\S]*?)<<<\[?END_TOOL_REQUEST\]?>>>)/gi, (match, escapedBlock, normalBlock) => {
        const block = escapedBlock ?? normalBlock;
        const results = [];
        const regex = /(\w+):\s*(?:[「『]始ESCAPE[」』]([\s\S]*?)[「『]末ESCAPE[」』]|[「『]始[」』]([\s\S]*?)[「『]末[」』])/gi;
        let m;

        while ((m = regex.exec(block)) !== null) {
            const key = m[1].toLowerCase();
            const val = (m[2] ?? m[3]).trim();
            const valLower = val.toLowerCase();
            const isTechKey = blacklistedKeys.includes(key);
            const isTechVal = blacklistedValues.some(bv => valLower.includes(bv));
            if (!isTechKey && !isTechVal && val.length > 1) {
                results.push(val);
            }
        }

        if (results.length === 0) {
            return block.split('\n')
                .map(line => {
                    const cleanLine = line
                        .replace(/\w+:\s*(?:[「『]始ESCAPE[」』]|[「『]始[」』])/gi, '')
                        .replace(/(?:[「『]末ESCAPE[」』]|[「『]末[」』])/gi, '')
                        .trim();
                    const lower = cleanLine.toLowerCase();
                    if (blacklistedValues.some(bv => lower.includes(bv))) return '';
                    return cleanLine;
                })
                .filter(l => l.length > 0)
                .join('\n');
        }
        return results.join('\n');
    });

    return processed
        .replace(/<<<\[?(?:TOOL_REQUEST|TOOL_REQUEST_ESCAPE)\]?>>>/gi, '')
        .replace(/<<<\[?(?:END_TOOL_REQUEST|END_TOOL_REQUEST_ESCAPE)\]?>>>/gi, '')
        .replace(/[「」『』]始(?:ESCAPE)?[「」『』]/gi, '')
        .replace(/[「」『』]末(?:ESCAPE)?[「」『』]/gi, '')
        .replace(/[「」『』]/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function stripSystemNotification(text) {
    if (!text || typeof text !== 'string') return text;
    return text.replace(/\[系统通知\][\s\S]*?\[系统通知结束\]/g, '').trim();
}

function stripClawMailInjectedPrompt(text) {
    if (!text || typeof text !== 'string') return text;

    const mailContentBlocks = [];
    const contentRegex = /<<<\[VCP_CLAWMAIL_MAIL_CONTENT\]>>>([\s\S]*?)<<<\[END_VCP_CLAWMAIL_MAIL_CONTENT\]>>>/gi;
    let match;
    while ((match = contentRegex.exec(text)) !== null) {
        const block = match[1].trim();
        if (block) mailContentBlocks.push(block);
    }
    if (mailContentBlocks.length > 0) {
        return mailContentBlocks.join('\n\n').trim();
    }
    return text
        .replace(/<<<\[VCP_CLAWMAIL_INJECTED_PROMPT\]>>>[\s\S]*?<<<\[END_VCP_CLAWMAIL_INJECTED_PROMPT\]>>>/gi, '')
        .replace(/<<<\[VCP_CLAWMAIL_MAIL_CONTENT\]>>>/gi, '')
        .replace(/<<<\[END_VCP_CLAWMAIL_MAIL_CONTENT\]>>>/gi, '')
        .trim();
}

/** 向量化缓存哈希一致性的公共净化入口。 */
function sanitizeForEmbedding(content, role) {
    if (!content || typeof content !== 'string') return '';

    const cacheKey = `${role || ''}::${content}`;
    const cached = getLruCache(sanitizeEmbeddingCache, cacheKey);
    if (cached !== undefined) return cached;

    let processed = content;
    processed = stripClawMailInjectedPrompt(processed);
    if (role === 'user') {
        processed = stripSystemNotification(processed);
    } else if (role === 'assistant') {
        // V4.3: 不剔除 @tag，将其视为正常上下文语义的一部分。
    }

    processed = stripHtml(processed);
    processed = stripEmoji(processed);
    processed = stripToolMarkers(processed);
    processed = processed.replace(/<\|([^|]+)\|>/g, '$1');

    const finalResult = processed.trim();
    setLruCache(sanitizeEmbeddingCache, cacheKey, finalResult);
    return finalResult;
}

function isLikelyBase64(str) {
    if (!str || str.length < 100) return false;
    const sample = str.substring(0, 200);
    if (!/^[A-Za-z0-9+/=]+$/.test(sample)) return false;
    if (str.length % 4 !== 0 && str.length % 4 !== 2 && str.length % 4 !== 3) return false;
    const uniqueChars = new Set(sample).size;
    if (uniqueChars > 50) return true;
    return str.length > 500;
}

function jsonToMarkdown(obj, depth = 0) {
    if (obj === null || obj === undefined) return '';
    if (typeof obj !== 'object') return String(obj);

    let md = '';
    const indent = '  '.repeat(depth);

    if (Array.isArray(obj)) {
        for (const item of obj) {
            if (item && typeof item === 'object' && item.type === 'text' && item.text) {
                let textContent = item.text;
                const jsonMatch = textContent.match(/:\s*\n(\{[\s\S]*?\}|\[[\s\S]*?\])\s*$/);
                if (jsonMatch) {
                    try {
                        const nestedJson = JSON.parse(jsonMatch[1]);
                        const prefix = textContent.substring(0, jsonMatch.index + 1).trim();
                        const nestedMd = jsonToMarkdown(nestedJson, depth + 1);
                        md += `${prefix}\n${nestedMd}\n`;
                        continue;
                    } catch (e) {
                        console.debug('[RAGDiaryPlugin] Failed to parse nested JSON in text content:', e.message);
                    }
                }

                const inlineJsonSlice = findFirstBalancedJsonSlice(textContent);
                if (inlineJsonSlice) {
                    const inlineJson = inlineJsonSlice.parsed;
                    const beforeJson = textContent.substring(0, inlineJsonSlice.index).trim();
                    const afterJson = textContent.substring(inlineJsonSlice.index + inlineJsonSlice.match.length).trim();
                    const inlineMd = jsonToMarkdown(inlineJson, depth + 1);
                    md += `${beforeJson}\n${inlineMd}`;
                    if (afterJson) md += `\n${afterJson}`;
                    md += '\n';
                    continue;
                }

                md += `${textContent}\n`;
            } else if (typeof item !== 'object') {
                md += `${indent}- ${item}\n`;
            } else {
                md += `${jsonToMarkdown(item, depth)}\n`;
            }
        }
    } else {
        for (const [key, value] of Object.entries(obj)) {
            if (value === null || value === undefined) continue;
            if (typeof value === 'object') {
                const subContent = jsonToMarkdown(value, depth + 1);
                if (subContent.trim()) {
                    md += `${indent}# ${key}:\n${subContent}`;
                }
            } else {
                const valStr = String(value);
                if (valStr.length > 200 && (valStr.includes('base64') || isLikelyBase64(valStr))) {
                    md += `${indent}* **${key}**: [Data Omitted]\n`;
                    continue;
                }

                if (valStr.length > 100 && (valStr.includes('{') || valStr.includes('['))) {
                    const nestedJsonMatch = valStr.match(/^(.*?)(\{[\s\S]*\}|\[[\s\S]*\])(.*)$/);
                    if (nestedJsonMatch) {
                        try {
                            const nestedJson = JSON.parse(nestedJsonMatch[2]);
                            const prefix = nestedJsonMatch[1].trim();
                            const suffix = nestedJsonMatch[3].trim();
                            const nestedMd = jsonToMarkdown(nestedJson, depth + 1);
                            md += `${indent}* **${key}**: `;
                            if (prefix) md += `${prefix} `;
                            md += `\n${nestedMd}`;
                            if (suffix) md += `${indent}  ${suffix}\n`;
                            continue;
                        } catch (e) {
                            console.debug(`[RAGDiaryPlugin] Failed to parse nested JSON in field "${key}":`, e.message);
                        }
                    }
                }
                md += `${indent}* **${key}**: ${valStr}\n`;
            }
        }
    }
    return md;
}

module.exports = {
    stripHtml,
    stripEmoji,
    stripToolMarkers,
    stripSystemNotification,
    stripClawMailInjectedPrompt,
    sanitizeForEmbedding,
    isLikelyBase64,
    jsonToMarkdown
};