// modules/contextBudget.js
//
// 上下文预算：统一的 token 计量和出站前检查。
// ----------------------------------------------------------------
// - 计量不跑分词器（同步分词每 MB 文本要 100ms 以上，会卡住事件循环）。本地估算是
//   「汉字按 2 个字符、其余按 1 个字符，再除以 3」，与「最终上下文」面板同一套算法；
//   上游返回 usage.prompt_tokens 后，用它校准同一请求后续轮次和同一模型之后的估算。
// - 预算来自请求里的 contextTokenLimit；config.env 的 ContextBudgetHardCap 是服务端硬上限，
//   两者取小。请求没带预算、也没配硬上限时不检查。
// - config.env 的 ContextBudgetGuard 控制行为：
//     off      不计量、不检查
//     observe  只在超预算时打一行日志（默认）
//     enforce  超预算时先把历史里较早的工具结果压成摘要，仍超才不发往上游并返回明确的错误；
//              工具循环中同样先压缩、仍超则停止循环

const ESTIMATED_TOKEN_CHAR_DIVISOR = 3;
const MESSAGE_OVERHEAD_TOKENS = 4;
const IMAGE_PART_TOKENS = 765;
const OPAQUE_PART_TOKENS = 256;
const MIN_RATIO = 0.4;
const MAX_RATIO = 2.5;
const RATIO_SMOOTHING = 0.3;
const MAX_TRACKED_MODELS = 200;

const SLIM_MIN_CHARS = 1500;
const SLIM_HEAD_CHARS = 500;
const SLIM_TAIL_CHARS = 200;
const TOOL_PAYLOAD_HEADER = '<!-- VCP_TOOL_PAYLOAD -->';
const TOOL_PAYLOAD_FOOTER = '<!-- VCP_TOOL_PAYLOAD_END -->';
// 历史消息里持久化的工具结果块（写在 assistant 正文中）。
const RESULT_BLOCK_START = '[[VCP调用结果信息汇总:';
const RESULT_BLOCK_END = 'VCP调用结果结束]]';
const RECORD_ID_PATTERN = /tcr-[0-9A-Za-z-]{8,}/;
// 本地估算太小时不拿它校准：固定开销占比大，算出来的比例没有代表性。
const MIN_CALIBRATION_ESTIMATE = 2000;

const modelRatios = new Map();

function guardMode() {
    const raw = String(process.env.ContextBudgetGuard || '').trim().toLowerCase();
    return raw === 'off' || raw === 'enforce' ? raw : 'observe';
}

function normalizeLimit(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const limit = Number(value);
    return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null;
}

/** 服务端硬上限（ContextBudgetHardCap）。没配或配得不合法就是没有。 */
function hardCap() {
    return normalizeLimit(process.env.ContextBudgetHardCap);
}

/** 请求预算和服务端硬上限取小；都没有时为 null。 */
function effectiveLimit(requestLimit) {
    const requested = normalizeLimit(requestLimit);
    const cap = hardCap();
    if (requested === null) return cap;
    return cap === null ? requested : Math.min(requested, cap);
}

/** 上游用量里的输入 token 数。Anthropic 风格的 input_tokens 不含缓存部分，要加回来。 */
function promptTokensFromUsage(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const openAiStyle = Number(usage.prompt_tokens);
    if (Number.isFinite(openAiStyle) && openAiStyle > 0) return openAiStyle;
    const input = Number(usage.input_tokens);
    if (!Number.isFinite(input) || input < 0) return null;
    const cacheRead = Number(usage.cache_read_input_tokens);
    const cacheWrite = Number(usage.cache_creation_input_tokens);
    const total = input
        + (Number.isFinite(cacheRead) && cacheRead > 0 ? cacheRead : 0)
        + (Number.isFinite(cacheWrite) && cacheWrite > 0 ? cacheWrite : 0);
    return total > 0 ? total : null;
}

function estimateTextTokens(text) {
    if (typeof text !== 'string' || text.length === 0) return 0;
    let chinese = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code >= 0x4e00 && code <= 0x9fff) chinese++;
    }
    return Math.ceil((chinese + text.length) / ESTIMATED_TOKEN_CHAR_DIVISOR);
}

function estimatePartTokens(part) {
    if (typeof part === 'string') return estimateTextTokens(part);
    if (!part || typeof part !== 'object') return 0;
    if (typeof part.text === 'string') return estimateTextTokens(part.text);
    if (part.type === 'image_url' || part.type === 'image' || part.type === 'input_image') return IMAGE_PART_TOKENS;
    return OPAQUE_PART_TOKENS;
}

function estimateToolCallTokens(message) {
    let total = 0;
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const call of calls) {
        total += estimateTextTokens(call?.function?.name) + estimateTextTokens(
            typeof call?.function?.arguments === 'string'
                ? call.function.arguments
                : JSON.stringify(call?.function?.arguments ?? '')
        );
    }
    if (message.function_call) {
        total += estimateTextTokens(message.function_call.name) + estimateTextTokens(String(message.function_call.arguments ?? ''));
    }
    return total;
}

function estimateMessageTokens(message) {
    if (!message || typeof message !== 'object') return 0;
    let total = MESSAGE_OVERHEAD_TOKENS;
    if (typeof message.content === 'string') total += estimateTextTokens(message.content);
    else if (Array.isArray(message.content)) for (const part of message.content) total += estimatePartTokens(part);
    return total + estimateToolCallTokens(message);
}

function estimateMessagesTokens(messages) {
    if (!Array.isArray(messages)) return 0;
    let total = 0;
    for (const message of messages) total += estimateMessageTokens(message);
    return total;
}

/** 整个请求体的本地估算：消息 + 工具定义。 */
function estimateBodyTokens(body) {
    if (!body || typeof body !== 'object') return 0;
    let total = estimateMessagesTokens(body.messages);
    for (const key of ['tools', 'functions']) {
        if (Array.isArray(body[key]) && body[key].length > 0) total += estimateTextTokens(JSON.stringify(body[key]));
    }
    return total;
}

function clampRatio(ratio) {
    return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

function modelRatio(model) {
    return modelRatios.get(String(model || '')) ?? 1;
}

function rememberModelRatio(model, ratio) {
    const key = String(model || '');
    const previous = modelRatios.get(key);
    modelRatios.delete(key);
    modelRatios.set(key, previous === undefined ? ratio : previous + (ratio - previous) * RATIO_SMOOTHING);
    if (modelRatios.size > MAX_TRACKED_MODELS) modelRatios.delete(modelRatios.keys().next().value);
}

function isToolPayloadText(text) {
    return typeof text === 'string' && text.trimStart().startsWith(TOOL_PAYLOAD_HEADER);
}

function isToolResultMessage(message) {
    if (!message || typeof message !== 'object') return false;
    if (message.role === 'tool' || message.role === 'function') return true;
    if (typeof message.content === 'string') return isToolPayloadText(message.content);
    return Array.isArray(message.content) && isToolPayloadText(message.content[0]?.text);
}

function omissionNotice(omitted, recordId) {
    return `[…较早的工具结果已省略 ${omitted} 个字符以节省上下文${recordId ? `，完整内容见调用记录 ${recordId}` : ''}…]`;
}

function defuseMarkers(fragment) {
    return fragment.split(RESULT_BLOCK_START).join('[嵌套的工具结果:').split(RESULT_BLOCK_END).join('嵌套结果结束]');
}

function isInsideCodeFence(text, from, to) {
    let fences = 0;
    for (let at = text.indexOf('```', from); at !== -1 && at < to; at = text.indexOf('```', at + 3)) fences++;
    return fences % 2 === 1;
}

/**
 * 压缩正文里持久化的工具结果块：每个足够长的块保留开头（工具名、状态）和结尾，中间换成省略说明。
 * 按起止标记配对扫描（支持嵌套），不用正则；写在代码围栏里的示例、没有结束标记的残块都不动。
 * @returns {string} 没有可压缩的块时返回原字符串本身
 */
function slimToolResultBlocks(text) {
    if (typeof text !== 'string' || text.length < SLIM_MIN_CHARS || !text.includes(RESULT_BLOCK_START)) return text;
    let out = '';
    let cursor = 0;
    let fenceScanFrom = 0;
    let insideFence = false;
    while (cursor < text.length) {
        const start = text.indexOf(RESULT_BLOCK_START, cursor);
        if (start === -1) break;
        if (isInsideCodeFence(text, fenceScanFrom, start)) insideFence = !insideFence;
        fenceScanFrom = start;
        if (insideFence) {
            out += text.slice(cursor, start + RESULT_BLOCK_START.length);
            cursor = start + RESULT_BLOCK_START.length;
            continue;
        }
        // 找与这个起始标记配对的结束标记。
        let depth = 1;
        let scan = start + RESULT_BLOCK_START.length;
        let end = -1;
        while (depth > 0) {
            const nextEnd = text.indexOf(RESULT_BLOCK_END, scan);
            if (nextEnd === -1) break;
            const nextStart = text.indexOf(RESULT_BLOCK_START, scan);
            if (nextStart !== -1 && nextStart < nextEnd) {
                depth++;
                scan = nextStart + RESULT_BLOCK_START.length;
            } else {
                depth--;
                scan = nextEnd + RESULT_BLOCK_END.length;
                if (depth === 0) end = nextEnd;
            }
        }
        if (end === -1) break;
        const innerStart = start + RESULT_BLOCK_START.length;
        const inner = text.slice(innerStart, end);
        out += text.slice(cursor, innerStart);
        if (inner.length < SLIM_MIN_CHARS) {
            out += inner;
        } else {
            const omitted = inner.length - SLIM_HEAD_CHARS - SLIM_TAIL_CHARS;
            const recordId = inner.match(RECORD_ID_PATTERN)?.[0];
            // 头尾片段里如果切到了嵌套块的半边标记，要抹掉，否则压缩后的起止标记不成对。
            out += `${defuseMarkers(inner.slice(0, SLIM_HEAD_CHARS))}\n${omissionNotice(omitted, recordId)}\n${defuseMarkers(inner.slice(-SLIM_TAIL_CHARS))}`;
        }
        out += RESULT_BLOCK_END;
        cursor = end + RESULT_BLOCK_END.length;
        fenceScanFrom = cursor;
    }
    if (cursor === 0) return text;
    out += text.slice(cursor);
    return out.length < text.length ? out : text;
}

function slimText(text) {
    if (typeof text !== 'string') return text;
    const hasFooter = text.trimEnd().endsWith(TOOL_PAYLOAD_FOOTER);
    const body = hasFooter ? text.slice(0, text.lastIndexOf(TOOL_PAYLOAD_FOOTER)).trimEnd() : text;
    if (body.length < SLIM_MIN_CHARS) return text;
    const omitted = body.length - SLIM_HEAD_CHARS - SLIM_TAIL_CHARS;
    const recordId = body.match(RECORD_ID_PATTERN)?.[0];
    return `${body.slice(0, SLIM_HEAD_CHARS)}\n${omissionNotice(omitted, recordId)}\n${body.slice(-SLIM_TAIL_CHARS)}`
        + (hasFooter ? `\n${TOOL_PAYLOAD_FOOTER}` : '');
}

/** 最后一条真正的用户发言（不是工具回执）的下标；没有则为 -1。 */
function lastRealUserIndex(messages) {
    if (!Array.isArray(messages)) return -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message && message.role === 'user' && !isToolResultMessage(message)) return i;
    }
    return -1;
}

/**
 * 把 protectFrom 之前的工具结果压成「开头 + 省略说明 + 结尾」。两种形态都处理：
 * 独立的工具回执消息，以及写在 assistant 正文里的历史工具结果块。
 * 不删消息、不动角色顺序、保留起止标记；系统消息、protectFrom 及之后（当前轮）原样保留。
 * 被压缩的消息换成新对象，不改调用方之外可能还持有的原对象。
 * @returns {number} 被压缩的消息数
 */
function slimEarlierToolResults(messages, protectFrom) {
    if (!Array.isArray(messages)) return 0;
    let slimmed = 0;
    const end = Math.min(messages.length, Math.max(0, protectFrom));
    for (let i = 0; i < end; i++) {
        const message = messages[i];
        if (!message || typeof message !== 'object' || message.role === 'system') continue;
        const slimPart = isToolResultMessage(message) ? slimText : slimToolResultBlocks;
        if (typeof message.content === 'string') {
            const next = slimPart(message.content);
            if (next !== message.content) { messages[i] = { ...message, content: next }; slimmed++; }
        } else if (Array.isArray(message.content)) {
            let changed = false;
            const content = message.content.map((part, index) => {
                if (!part || typeof part.text !== 'string') return part;
                // 工具回执的第一段是起始标记所在段，原样保留。
                if (slimPart === slimText && index === 0) return part;
                const next = slimPart(part.text);
                if (next === part.text) return part;
                changed = true;
                return { ...part, text: next };
            });
            if (changed) { messages[i] = { ...message, content }; slimmed++; }
        }
    }
    return slimmed;
}

/**
 * 超预算时的分级压缩：先压历史（最后一条用户发言之前）的工具结果，
 * 还超再压当前轮里较早几步的工具结果（roundStartIndex 之前）。每一级之后用 isOver() 复查。
 * @returns {number} 被压缩的消息数
 */
function slimToFit(messages, roundStartIndex, isOver) {
    const historyEnd = lastRealUserIndex(messages);
    let slimmed = historyEnd > 0 ? slimEarlierToolResults(messages, historyEnd) : 0;
    if (Number.isInteger(roundStartIndex) && roundStartIndex > Math.max(0, historyEnd) && (slimmed === 0 || isOver())) {
        slimmed += slimEarlierToolResults(messages, roundStartIndex);
    }
    return slimmed;
}

/** 请求体各部分的本地估算（未校准），用于报错时说明体积花在哪。 */
function estimateBreakdown(body) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const turnStart = lastRealUserIndex(messages);
    const parts = { system: 0, history: 0, currentTurn: 0, tools: 0 };
    messages.forEach((message, index) => {
        const tokens = estimateMessageTokens(message);
        if (message?.role === 'system') parts.system += tokens;
        else if (turnStart !== -1 && index >= turnStart) parts.currentTurn += tokens;
        else parts.history += tokens;
    });
    for (const key of ['tools', 'functions']) {
        if (Array.isArray(body?.[key]) && body[key].length > 0) parts.tools += estimateTextTokens(JSON.stringify(body[key]));
    }
    return parts;
}

/**
 * 单个请求的预算守卫。主流程和工具循环共用一个实例：
 *   noteRequest(body)   记下即将发往上游的请求体的本地估算
 *   noteUsage(usage)    上游返回用量后校准（本请求后续轮次立即生效，并更新该模型的长期比例）
 *   check(body)         → { estimated, limit, over, mode }
 */
function createBudgetGuard({ limit, model, requestId } = {}) {
    const mode = guardMode();
    const normalizedLimit = effectiveLimit(limit);
    const active = mode !== 'off' && normalizedLimit !== null;
    let ratio = modelRatio(model);
    let lastRawEstimate = 0;

    function estimate(body) {
        return Math.ceil(estimateBodyTokens(body) * ratio);
    }

    return {
        mode,
        limit: normalizedLimit,
        active,
        enforcing: active && mode === 'enforce',
        estimate,
        /** 把一个未校准的本地估算换算成当前比例下的 token 数。 */
        scale(rawEstimate) {
            return Math.ceil(rawEstimate * ratio);
        },
        noteRequest(body) {
            if (active) lastRawEstimate = estimateBodyTokens(body);
        },
        /**
         * 给只会按消息做本地估算的裁剪器用的预算：把上限换算回未校准的口径，并扣掉工具定义。
         */
        messageBudget(body) {
            if (normalizedLimit === null) return null;
            let tools = 0;
            for (const key of ['tools', 'functions']) {
                if (Array.isArray(body?.[key]) && body[key].length > 0) tools += estimateTextTokens(JSON.stringify(body[key]));
            }
            return Math.max(1, Math.floor(normalizedLimit / ratio) - tools);
        },
        breakdown(body) {
            const parts = estimateBreakdown(body);
            for (const key of Object.keys(parts)) parts[key] = Math.ceil(parts[key] * ratio);
            return parts;
        },
        noteUsage(usage) {
            if (!active || !lastRawEstimate) return;
            const promptTokens = promptTokensFromUsage(usage);
            if (promptTokens === null) return;
            const rawEstimate = lastRawEstimate;
            lastRawEstimate = 0;
            if (rawEstimate < MIN_CALIBRATION_ESTIMATE) return;
            ratio = clampRatio(promptTokens / rawEstimate);
            rememberModelRatio(model, ratio);
        },
        check(body, stage = 'outbound', { silent = false } = {}) {
            if (!active) return { estimated: 0, limit: normalizedLimit, over: false, mode };
            const estimated = estimate(body);
            const over = estimated > normalizedLimit;
            if (over && !silent) {
                console.warn(`[ContextBudget] ${mode === 'enforce' ? '已拦截' : '超出预算(仅观测)'} stage=${stage} requestId=${requestId || 'none'} model=${model || 'unknown'} estimated=${estimated} limit=${normalizedLimit}`);
            }
            return { estimated, limit: normalizedLimit, over, mode };
        },
    };
}

function describeBreakdown(parts) {
    if (!parts) return '';
    const labels = [['system', '系统提示'], ['history', '历史对话'], ['currentTurn', '本轮内容'], ['tools', '工具定义']];
    const text = labels.filter(([key]) => parts[key] > 0).map(([key, label]) => `${label}约 ${parts[key]}`).join('、');
    return text ? `（其中${text}）` : '';
}

function exceededMessage({ estimated, limit }, stage = 'outbound', breakdown = null) {
    const detail = describeBreakdown(breakdown);
    return stage === 'tool_loop'
        ? `上下文估算 ${estimated} token${detail}，超过上限 ${limit}。已压缩较早的工具结果仍无法容纳，工具循环在此停止；请压缩或新开话题后继续。`
        : `本次请求展开后估算 ${estimated} token${detail}，超过上下文上限 ${limit}，未发送给模型。请压缩上下文、缩短内容或调高上限。`;
}

function resetModelRatios() {
    modelRatios.clear();
}

module.exports = {
    guardMode,
    normalizeLimit,
    hardCap,
    effectiveLimit,
    promptTokensFromUsage,
    lastRealUserIndex,
    slimToolResultBlocks,
    slimToFit,
    estimateBreakdown,
    estimateTextTokens,
    estimateMessageTokens,
    estimateMessagesTokens,
    estimateBodyTokens,
    isToolResultMessage,
    slimEarlierToolResults,
    createBudgetGuard,
    exceededMessage,
    resetModelRatios,
};
