'use strict';
// 共享文本工具：换行风格、编码探测、行范围、哈希、markdown 渲染。
// 所有行级逻辑统一在 LF 归一化后的文本上进行，写回时再恢复原换行风格。

const crypto = require('crypto');

function normalizeEol(str) {
    return String(str ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** 统计原文换行风格，取占多数者；无换行时默认 LF。 */
function detectLineEnding(content) {
    const text = String(content ?? '');
    const crlf = (text.match(/\r\n/g) || []).length;
    const lf = (text.match(/(^|[^\r])\n/g) || []).length;
    const cr = (text.match(/\r(?!\n)/g) || []).length;
    if (crlf > lf && crlf > cr) return '\r\n';
    if (cr > lf && cr > crlf) return '\r';
    return '\n';
}

function applyLineEnding(normalizedText, lineEnding) {
    if (lineEnding === '\n') return normalizedText;
    return normalizedText.replace(/\n/g, lineEnding);
}

function lineEndingName(lineEnding) {
    return lineEnding === '\r\n' ? 'CRLF' : lineEnding === '\r' ? 'CR' : 'LF';
}

/** 兼容 FileOperator 旧接口的换行助手。 */
function createLineEndingHelper(content) {
    const lineEnding = detectLineEnding(content);
    return {
        lineEnding,
        hasCRLF: /\r\n/.test(String(content ?? '')),
        normalize: normalizeEol,
        denormalize: str => applyLineEnding(normalizeEol(str), lineEnding),
        includes: (cnt, search) => normalizeEol(cnt).includes(normalizeEol(search)),
        safeReplace(originalContent, searchStr, replaceStr) {
            const normContent = normalizeEol(originalContent);
            const normSearch = normalizeEol(searchStr);
            if (!normContent.includes(normSearch)) {
                return { success: false, error: 'Search string not found after CRLF normalization' };
            }
            // 使用函数替换，避免 replaceStr 中的 $& / $1 等被当作替换模式。
            const result = normContent.replace(normSearch, () => normalizeEol(replaceStr));
            return { success: true, result: applyLineEnding(result, lineEnding) };
        },
        getDebugInfo: () => ({ chosen: lineEndingName(lineEnding), totalSize: String(content ?? '').length }),
    };
}

/**
 * 文件编码探测：BOM → chardet（若已安装）→ utf-8。
 */
function detectEncoding(buffer) {
    if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
        return { encoding: 'utf-8', bom: true, confidence: 'bom' };
    }
    if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
        return { encoding: 'utf-16le', bom: true, confidence: 'bom' };
    }
    if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
        return { encoding: 'utf-16be', bom: true, confidence: 'bom' };
    }
    try {
        const chardet = require('chardet');
        return { encoding: chardet.detect(buffer.subarray(0, 4096)) || 'utf-8', bom: false, confidence: 'chardet' };
    } catch (_e) {
        return { encoding: 'utf-8', bom: false, confidence: 'fallback' };
    }
}

/**
 * 解析行范围：head:N、tail:N、M-N、M:N、N。行号 1 起算。
 * 返回 null 表示未指定范围。
 */
function parseLineRange(linesSpec, totalLines) {
    if (linesSpec === undefined || linesSpec === null) return null;
    const requested = String(linesSpec).trim();
    if (!requested) return null;

    let start;
    let end;
    let match;
    if ((match = requested.match(/^head:(\d+)$/i))) {
        start = 1;
        end = parseInt(match[1], 10);
    } else if ((match = requested.match(/^tail:(\d+)$/i))) {
        start = Math.max(totalLines - parseInt(match[1], 10) + 1, 1);
        end = totalLines;
    } else if ((match = requested.match(/^(\d+)\s*[-:]\s*(\d+)$/))) {
        start = parseInt(match[1], 10);
        end = parseInt(match[2], 10);
    } else if ((match = requested.match(/^(\d+)$/))) {
        start = end = parseInt(match[1], 10);
    } else {
        throw new Error(`Invalid lines range: "${requested}". Supported formats: head:N, tail:N, M-N, M:N, N.`);
    }

    if (start < 1 || end < 1) {
        throw new Error(`Invalid lines range: "${requested}". Line numbers must be positive integers.`);
    }
    if (start > end) {
        throw new Error(`Invalid lines range: "${requested}". Start line must be less than or equal to end line.`);
    }

    const actualStart = totalLines === 0 ? 0 : Math.min(start, totalLines);
    const actualEnd = totalLines === 0 ? 0 : Math.min(end, totalLines);
    const selectedCount = actualStart === 0 || actualEnd < actualStart ? 0 : actualEnd - actualStart + 1;
    return { requested, start, end, actualStart, actualEnd, totalLines, selectedCount };
}

/**
 * 拆分为行数组。末尾换行不产生额外的空行，trailingNewline 单独记录，
 * 保证“文件有 N 行”与编辑器显示一致。
 */
function splitLines(text) {
    const norm = normalizeEol(text);
    if (norm === '') return { lines: [], trailingNewline: false };
    const trailingNewline = norm.endsWith('\n');
    const body = trailingNewline ? norm.slice(0, -1) : norm;
    return { lines: body.split('\n'), trailingNewline };
}

function joinLines(lines, trailingNewline) {
    if (lines.length === 0) return '';
    return lines.join('\n') + (trailingNewline ? '\n' : '');
}

function applyLineRangeToContent(content, linesSpec) {
    const { lines } = splitLines(content);
    const range = parseLineRange(linesSpec, lines.length);
    if (!range) return { content, lines: null };
    const selected = range.selectedCount > 0 ? lines.slice(range.actualStart - 1, range.actualEnd) : [];
    return { content: selected.join('\n'), lines: range };
}

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

/** 带自适应长度的 markdown 代码围栏，内容中含 ``` 时自动加长。 */
function markdownFence(content, language = '') {
    const text = String(content ?? '');
    const longest = Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1));
    const fence = '`'.repeat(longest);
    return `${fence}${language}\n${text}\n${fence}`;
}

/** 渲染带行号的代码行：`  12 | code`。startLine 为首行行号。 */
function numberLines(lines, startLine = 1, markLines = null) {
    const lastNo = startLine + Math.max(lines.length - 1, 0);
    const width = String(lastNo).length;
    return lines.map((line, i) => {
        const no = startLine + i;
        const mark = markLines && markLines.has(no) ? '>' : ' ';
        return `${mark}${String(no).padStart(width, ' ')} | ${line}`;
    }).join('\n');
}

const LINE_PREFIX_RE = /^[ >]?\s*\d+\s\|\s?/;

/**
 * AI 常把阅读结果里的 `  12 | code` 原样贴回。
 * 仅当所有非空行都带此前缀时才剥除，避免误伤真实内容（如 markdown 表格）。
 * 返回 { text, stripped }。
 */
function stripLineNumberPrefixes(text) {
    const norm = normalizeEol(text);
    const lines = norm.split('\n');
    const nonEmpty = lines.filter(line => line.trim() !== '');
    if (nonEmpty.length === 0 || !nonEmpty.every(line => LINE_PREFIX_RE.test(line))) {
        return { text: norm, stripped: false };
    }
    return {
        text: lines.map(line => (line.trim() === '' ? '' : line.replace(LINE_PREFIX_RE, ''))).join('\n'),
        stripped: true,
    };
}

const LANGUAGE_BY_EXT = {
    '.js': 'javascript', '.cjs': 'javascript', '.mjs': 'javascript', '.jsx': 'jsx',
    '.ts': 'typescript', '.tsx': 'tsx', '.json': 'json', '.html': 'html', '.htm': 'html',
    '.css': 'css', '.scss': 'scss', '.less': 'less', '.md': 'markdown', '.py': 'python',
    '.rs': 'rust', '.go': 'go', '.java': 'java', '.c': 'c', '.h': 'c', '.cpp': 'cpp',
    '.cs': 'csharp', '.sh': 'bash', '.ps1': 'powershell', '.bat': 'bat', '.yml': 'yaml',
    '.yaml': 'yaml', '.toml': 'toml', '.xml': 'xml', '.sql': 'sql', '.vue': 'vue',
};

function languageOf(filePath) {
    const ext = require('path').extname(String(filePath || '')).toLowerCase();
    return LANGUAGE_BY_EXT[ext] || '';
}

function formatFileSize(bytes) {
    if (!bytes) return '0 Bytes';
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1);
    return `${Math.round((bytes / 1024 ** i) * 100) / 100} ${sizes[i]}`;
}

module.exports = {
    normalizeEol,
    detectLineEnding,
    applyLineEnding,
    lineEndingName,
    createLineEndingHelper,
    detectEncoding,
    parseLineRange,
    splitLines,
    joinLines,
    applyLineRangeToContent,
    sha256,
    markdownFence,
    numberLines,
    stripLineNumberPrefixes,
    languageOf,
    formatFileSize,
};