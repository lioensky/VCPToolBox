'use strict';

/**
 * OutputFormatter - LinuxShellExecutor 统一 Markdown 输出器
 *
 * 单机与多机输出全部收敛为：
 *
 * <hostId> [status, meta]:
 * ```
 * output
 * ```
 *
 * 不再输出嵌套 JSON 或转义字符串，避免 AI 语义幻觉。
 */

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const DEFAULT_MAX_LINES = 100;
const DEFAULT_MAX_BYTES = 1024 * 1024;

function stripAnsi(text) {
    return String(text === undefined || text === null ? '' : text).replace(ANSI_PATTERN, '');
}

function normalizeOutput(text) {
    return stripAnsi(text)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\u0007/g, '')
        .replace(/\u0000/g, '');
}

function readPositiveIntEnv(name, fallback, min = 1) {
    const value = Number(process.env[name]);
    if (!Number.isFinite(value) || value < min) {
        return fallback;
    }
    return Math.floor(value);
}

function truncateOutput(text, options = {}) {
    const maxLines = Number.isFinite(Number(options.maxLines))
        ? Math.max(1, Number(options.maxLines))
        : readPositiveIntEnv('MAX_OUTPUT_LINES', DEFAULT_MAX_LINES, 1);
    const maxBytes = Number.isFinite(Number(options.maxBytes))
        ? Math.max(1024, Number(options.maxBytes))
        : readPositiveIntEnv('MAX_OUTPUT_SIZE', DEFAULT_MAX_BYTES, 1024);

    let output = normalizeOutput(text);
    let truncated = false;
    let originalLines = output ? output.split('\n').length : 0;

    if (output.length > maxBytes) {
        output = output.slice(0, maxBytes);
        truncated = true;
    }

    const lines = output.split('\n');
    if (lines.length > maxLines) {
        output = lines.slice(0, maxLines).join('\n');
        truncated = true;
    }

    if (truncated) {
        const shownLines = output ? output.split('\n').length : 0;
        output += `\n... 输出已截断（显示 ${shownLines}/${originalLines} 行）`;
    }

    return {
        output: output.replace(/\s+$/, ''),
        truncated,
        originalLines
    };
}

function pickFence(text) {
    const matches = String(text).match(/`{3,}/g);
    if (!matches || matches.length === 0) return '```';
    let longest = 3;
    for (const match of matches) {
        longest = Math.max(longest, match.length);
    }
    return '`'.repeat(longest + 1);
}

function buildMeta(options = {}) {
    if (options.meta) return String(options.meta);

    const {
        status,
        exitCode,
        durationMs,
        taskId,
        terminalId,
        signal,
        label
    } = options;

    const duration = Number.isFinite(Number(durationMs))
        ? Math.max(0, Math.round(Number(durationMs)))
        : 0;

    switch (status) {
        case 'completed':
            return `exit: ${exitCode === undefined || exitCode === null ? 0 : exitCode}, ${duration}ms`;
        case 'detached':
            return `detached, taskId: ${taskId}`;
        case 'running':
            if (taskId) return `running, taskId: ${taskId}, elapsed: ${duration}ms`;
            if (terminalId) return `running, terminalId: ${terminalId}, elapsed: ${duration}ms`;
            return `running, ${duration}ms`;
        case 'cancelled':
            return taskId ? `cancelled, taskId: ${taskId}` : 'cancelled';
        case 'error':
            return `error, ${duration}ms`;
        case 'interactive':
            return `interactive_input, ${duration}ms`;
        case 'signal':
            return `signal: ${signal || 'KEY'}, terminalId: ${terminalId || 'default'}, ${duration}ms`;
        case 'stdin_injected':
            return `stdin_injected, terminalId: ${terminalId || 'default'}, ${duration}ms`;
        case 'visible_buffer':
            return taskId
                ? `visible_buffer, taskId: ${taskId}`
                : `visible_buffer, terminalId: ${terminalId || 'default'}`;
        case 'submitted':
            return `submitted, terminalId: ${terminalId || 'default'}, ${duration}ms`;
        default:
            return label || String(status || 'unknown');
    }
}

/**
 * 渲染单个主机块。
 *
 * @param {Object} options
 * @param {string} options.hostId
 * @param {string} options.status completed|detached|running|error|cancelled|signal|...
 * @param {number} [options.exitCode]
 * @param {number} [options.durationMs]
 * @param {string} [options.output]
 * @param {string} [options.taskId]
 * @param {string} [options.terminalId]
 * @param {string} [options.signal]
 * @param {string} [options.note]
 * @param {string} [options.meta] 覆盖自动生成的 meta
 * @param {number} [options.maxLines]
 * @param {string} [options.emptyText]
 * @returns {string}
 */
function formatHostBlock(options = {}) {
    const hostId = String(options.hostId || 'local');
    const meta = buildMeta(options);

    const truncated = truncateOutput(options.output, {
        maxLines: options.maxLines,
        maxBytes: options.maxBytes
    });

    let body = truncated.output;
    if (!body) {
        body = options.emptyText === undefined
            ? '(无输出)'
            : String(options.emptyText);
    }

    if (options.note) {
        body = body ? `${body}\n\n${options.note}` : String(options.note);
    }

    const fence = pickFence(body);
    return `<${hostId}> [${meta}]:\n${fence}\n${body}\n${fence}\n`;
}

function renderBlocks(results = []) {
    return results
        .filter((item) => item && item.hostId !== undefined)
        .map((item) => formatHostBlock(item))
        .join('\n');
}

/**
 * 构造兼容 VCP 富内容协议的返回对象。
 * ToolExecutor 会优先读取 content 数组并原样交给模型。
 */
function buildToolResult(text, results = [], extra = {}) {
    const safeText = String(text || '');
    return {
        status: 'success',
        content: [{ type: 'text', text: safeText }],
        output: safeText,
        results,
        ...extra
    };
}

function formatErrorBlock({ hostId, message, durationMs = 0, note } = {}) {
    return formatHostBlock({
        hostId: hostId || 'local',
        status: 'error',
        durationMs,
        output: message || '未知错误',
        note
    });
}

module.exports = {
    stripAnsi,
    normalizeOutput,
    truncateOutput,
    formatHostBlock,
    renderBlocks,
    buildToolResult,
    formatErrorBlock,
    buildMeta
};
