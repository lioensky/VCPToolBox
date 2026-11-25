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

// 压缩较早的工具结果时保留的开头 / 结尾字符数，以及多长的结果才压缩。
// 可用 ContextSlimHeadChars / ContextSlimTailChars / ContextSlimMinChars 调整。
function slimSetting(name, fallback, min, max) {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
const slimHeadChars = () => slimSetting('ContextSlimHeadChars', 500, 100, 100000);
const slimTailChars = () => slimSetting('ContextSlimTailChars', 200, 0, 100000);
const slimMinChars = () => Math.max(
    slimSetting('ContextSlimMinChars', 1500, 500, 1000000),
    slimHeadChars() + slimTailChars() + 200
);
/** 紧凑档：离现在远的历史。 */
const compactSizes = () => ({ head: slimHeadChars(), tail: slimTailChars(), min: slimMinChars() });
/** 宽裕档：最近几轮的历史，留得多一些，模型回头看刚读过的内容时不必再调一次工具。 */
function recentSizes() {
    const head = slimSetting('ContextSlimRecentHeadChars', 6000, 100, 100000);
    const tail = slimSetting('ContextSlimRecentTailChars', 2000, 0, 100000);
    return { head, tail, min: head + tail + 1000 };
}
const slimRecentTurns = () => slimSetting('ContextSlimRecentTurns', 3, 0, 1000);
/** 当前轮里较早几步的工具结果：先用这一档，与跨话题引用的截断尺寸一致。 */
const CURRENT_TURN_SIZES = { head: 18000, tail: 6000, min: 25000 };
const TOOL_PAYLOAD_HEADER = '<!-- VCP_TOOL_PAYLOAD -->';
const TOOL_PAYLOAD_FOOTER = '<!-- VCP_TOOL_PAYLOAD_END -->';
// 历史消息里持久化的工具结果块（写在 assistant 正文中）。
const RESULT_BLOCK_START = '[[VCP调用结果信息汇总:';
const RESULT_BLOCK_END = 'VCP调用结果结束]]';
const RECORD_ID_PATTERN = /tcr-[0-9A-Za-z-]{8,}/;
// 角色分割把历史回复里的工具批次拆成独立 user 消息后，外面可能还带着这些壳。
const BATCH_SHELL_PATTERNS = [
    /^<<<\[VCP_TOOL_BATCH_START:[^\]\r\n]+\]>>>\s*/,
    /\s*<<<\[VCP_TOOL_BATCH_END:[^\]\r\n]+\]>>>$/,
    /^【工具返回批次开始[^】\r\n]*】\s*/,
    /\s*【工具返回批次结束[^】\r\n]*】$/,
];
const BATCH_SUMMARY_START = '[本轮工具调用摘要:]';
// 由系统替用户说的话（续写提示、话题唤醒、邀请指令），不是一轮对话的起点。
const VIRTUAL_USER_PREFIXES = ['[系统提示:]', '[系统邀请指令:]'];
const IMAGE_HEAVY_SHARE = 0.25;
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

function countImageParts(body) {
    let count = 0;
    for (const message of Array.isArray(body?.messages) ? body.messages : []) {
        if (!Array.isArray(message?.content)) continue;
        for (const part of message.content) {
            if (part && (part.type === 'image_url' || part.type === 'image' || part.type === 'input_image')) count++;
        }
    }
    return count;
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

/**
 * 历史回复里持久化的工具批次，被角色分割拆出来之后的样子：一条 user 消息，
 * 去掉批次外壳和尾部的调用摘要后，从头到尾就是一个或多个工具结果块。
 */
function isPersistedToolBatchText(text) {
    if (typeof text !== 'string' || !text.includes(RESULT_BLOCK_START)) return false;
    let body = text.trim();
    for (const pattern of BATCH_SHELL_PATTERNS) body = body.replace(pattern, '');
    const summaryAt = body.lastIndexOf(BATCH_SUMMARY_START);
    if (summaryAt > 0 && body.lastIndexOf(RESULT_BLOCK_END) < summaryAt) body = body.slice(0, summaryAt);
    body = body.trim();
    return body.startsWith(RESULT_BLOCK_START) && body.endsWith(RESULT_BLOCK_END);
}

function firstText(message) {
    if (typeof message.content === 'string') return message.content;
    return Array.isArray(message.content) && typeof message.content[0]?.text === 'string' ? message.content[0].text : null;
}

function isRuntimeToolPayloadMessage(message) {
    return isToolPayloadText(firstText(message));
}

function isToolResultMessage(message) {
    if (!message || typeof message !== 'object') return false;
    if (message.role === 'tool' || message.role === 'function') return true;
    const text = firstText(message);
    if (isToolPayloadText(text)) return true;
    return message.role === 'user' && isPersistedToolBatchText(text);
}

/** 一条 user 消息是不是用户真正说的话（不是工具结果，也不是系统替用户说的提示）。 */
function isRealUserMessage(message) {
    if (!message || message.role !== 'user' || message.__vcpMetaThinkingV3__) return false;
    if (isToolResultMessage(message)) return false;
    const text = firstText(message);
    if (typeof text === 'string') {
        const trimmed = text.trimStart();
        if (VIRTUAL_USER_PREFIXES.some(prefix => trimmed.startsWith(prefix))) return false;
    }
    return true;
}

function omissionNotice(omitted, recordId) {
    return `[…较早的工具结果已省略 ${omitted} 个字符以节省上下文${recordId ? `，完整内容见调用记录 ${recordId}` : ''}…]`;
}

function defuseMarkers(fragment) {
    return fragment.split(RESULT_BLOCK_START).join('[嵌套的工具结果:').split(RESULT_BLOCK_END).join('嵌套结果结束]');
}

/** 只在合法的 UTF-16 边界切：不把一个代理对（emoji、生僻字）劈成两半。 */
function edge(text, size, fromEnd) {
    if (size <= 0) return '';
    if (size >= text.length) return text;
    let cut = fromEnd ? text.length - size : size;
    const next = text.charCodeAt(cut);
    const prev = text.charCodeAt(cut - 1);
    if (next >= 0xDC00 && next <= 0xDFFF && prev >= 0xD800 && prev <= 0xDBFF) cut += fromEnd ? 1 : -1;
    return fromEnd ? text.slice(cut) : text.slice(0, cut);
}

const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})([^\r\n]*)/gm;

/**
 * 代码围栏状态机：扫过 text 的 [from, to)，返回扫完时还开着的围栏（没有则为 null）。
 * 只认行首的围栏；关闭它的必须是同一种符号、不短于开头、后面没有别的字。
 * 行内的反引号、四个反引号包三个反引号都不会把状态弄反。
 */
function fenceStateAfter(text, from, to, open) {
    if (to <= from) return open;
    FENCE_LINE.lastIndex = from;
    for (let match = FENCE_LINE.exec(text); match && match.index < to; match = FENCE_LINE.exec(text)) {
        if (match.index > 0 && text.charCodeAt(match.index - 1) !== 10 && text.charCodeAt(match.index - 1) !== 13) continue;
        const marker = match[1];
        if (!open) open = marker;
        else if (marker[0] === open[0] && marker.length >= open.length && !match[2].trim()) open = null;
    }
    return open;
}

/**
 * 压缩正文里持久化的工具结果块：每个足够长的块保留开头（工具名、状态）和结尾，中间换成省略说明。
 * 按起止标记配对扫描（支持嵌套），不用正则；写在代码围栏里的示例、没有结束标记的残块都不动。
 * @returns {string} 没有可压缩的块时返回原字符串本身
 */
function slimToolResultBlocks(text, sizes = compactSizes()) {
    const { min: minChars, head: headChars, tail: tailChars } = sizes;
    if (typeof text !== 'string' || text.length < minChars || !text.includes(RESULT_BLOCK_START)) return text;
    let out = '';
    let cursor = 0;
    let fenceScanFrom = 0;
    let openFence = null;
    while (cursor < text.length) {
        const start = text.indexOf(RESULT_BLOCK_START, cursor);
        if (start === -1) break;
        openFence = fenceStateAfter(text, fenceScanFrom, start, openFence);
        fenceScanFrom = start;
        if (openFence) {
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
        if (inner.length < minChars) {
            out += inner;
        } else {
            const head = edge(inner, headChars, false);
            const tail = edge(inner, tailChars, true);
            // 调用记录编号写在块的开头几行，只在开头找，不扫整块。
            const recordId = inner.slice(0, 2000).match(RECORD_ID_PATTERN)?.[0];
            // 头尾片段里如果切到了嵌套块的半边标记，要抹掉，否则压缩后的起止标记不成对。
            out += `${defuseMarkers(head)}\n${omissionNotice(inner.length - head.length - tail.length, recordId)}\n${defuseMarkers(tail)}`;
        }
        out += RESULT_BLOCK_END;
        cursor = end + RESULT_BLOCK_END.length;
        fenceScanFrom = cursor;
    }
    if (cursor === 0) return text;
    out += text.slice(cursor);
    return out.length < text.length ? out : text;
}

function slimText(text, sizes = compactSizes()) {
    if (typeof text !== 'string') return text;
    const hasFooter = text.trimEnd().endsWith(TOOL_PAYLOAD_FOOTER);
    const body = hasFooter ? text.slice(0, text.lastIndexOf(TOOL_PAYLOAD_FOOTER)).trimEnd() : text;
    if (body.length < sizes.min) return text;
    const head = edge(body, sizes.head, false);
    const tail = edge(body, sizes.tail, true);
    const recordId = body.slice(0, 2000).match(RECORD_ID_PATTERN)?.[0];
    return `${head}\n${omissionNotice(body.length - head.length - tail.length, recordId)}\n${tail}`
        + (hasFooter ? `\n${TOOL_PAYLOAD_FOOTER}` : '');
}

/**
 * 当前轮的起点：最后一条真正的用户发言的下标。工具结果、系统替用户说的提示
 * （续写、话题唤醒等）都不算。整段对话里找不到真正的发言时，退回到最后一条
 * 不是工具结果的 user 消息；还没有则为 -1。
 */
function lastRealUserIndex(messages) {
    if (!Array.isArray(messages)) return -1;
    let fallback = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (isRealUserMessage(message)) return i;
        if (fallback === -1 && message && message.role === 'user' && !isToolResultMessage(message)) fallback = i;
    }
    return fallback;
}

/**
 * 把 protectFrom 之前的工具结果压成「开头 + 省略说明 + 结尾」。两种形态都处理：
 * 独立的工具回执消息，以及写在 assistant 正文里的历史工具结果块。
 * 不删消息、不动角色顺序、保留起止标记；系统消息、protectFrom 及之后（当前轮）原样保留。
 * 被压缩的消息换成新对象，不改调用方之外可能还持有的原对象。
 * @returns {number} 被压缩的消息数
 */
function slimEarlierToolResults(messages, protectFrom, { from = 0, sizes = compactSizes() } = {}) {
    if (!Array.isArray(messages)) return 0;
    let slimmed = 0;
    const end = Math.min(messages.length, Math.max(0, protectFrom));
    for (let i = Math.max(0, from); i < end; i++) {
        const message = messages[i];
        if (!message || typeof message !== 'object' || message.role === 'system') continue;
        // 循环内的工具回执整条压头尾；历史里的工具结果块（不管还在回复正文里，
        // 还是已经被角色分割拆成独立消息）逐块压，保留每一块的工具名和状态。
        const slimPart = message.role === 'tool' || message.role === 'function' || isRuntimeToolPayloadMessage(message)
            ? slimText : slimToolResultBlocks;
        if (typeof message.content === 'string') {
            const next = slimPart(message.content, sizes);
            if (next !== message.content) { messages[i] = { ...message, content: next }; slimmed++; }
        } else if (Array.isArray(message.content)) {
            let changed = false;
            const content = message.content.map((part, index) => {
                if (!part || typeof part.text !== 'string') return part;
                // 工具回执的第一段是起始标记所在段，原样保留。
                if (slimPart === slimText && index === 0) return part;
                const next = slimPart(part.text, sizes);
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
 * 超预算时的分级压缩，每一级之后用 isOver() 复查，够了就停：
 *   1. 远的历史压成紧凑存根，最近几轮的历史留宽裕的头尾；
 *   2. 最近几轮的历史也压成紧凑存根；
 *   3. 当前轮里较早几步的工具结果（roundStartIndex 之前）留宽裕的头尾；
 *   4. 当前轮较早几步也压成紧凑存根。
 * 当前轮最新一步的结果、用户和助手说的话始终不动，消息条数和角色顺序不变。
 * 出站前（还没进入工具循环）不传 roundStartIndex，只做前两级。
 * @returns {number} 被压缩的消息数（同一条消息在不同级里各算一次）
 */
function slimToFit(messages, roundStartIndex, isOver) {
    const historyEnd = lastRealUserIndex(messages);
    let slimmed = 0;
    if (historyEnd > 0) {
        let recentStart = historyEnd;
        for (let i = historyEnd - 1, turns = slimRecentTurns(); i >= 0 && turns > 0; i--) {
            if (isRealUserMessage(messages[i])) { recentStart = i; turns--; }
        }
        slimmed += slimEarlierToolResults(messages, recentStart);
        slimmed += slimEarlierToolResults(messages, historyEnd, { from: recentStart, sizes: recentSizes() });
        if (slimmed > 0 && !isOver()) return slimmed;
        const compacted = slimEarlierToolResults(messages, historyEnd, { from: recentStart });
        slimmed += compacted;
        if (compacted > 0 && !isOver()) return slimmed;
    }
    if (Number.isInteger(roundStartIndex) && roundStartIndex > Math.max(0, historyEnd)) {
        const from = Math.max(0, historyEnd);
        const roomy = slimEarlierToolResults(messages, roundStartIndex, { from, sizes: CURRENT_TURN_SIZES });
        slimmed += roomy;
        if (roomy > 0 && !isOver()) return slimmed;
        slimmed += slimEarlierToolResults(messages, roundStartIndex, { from });
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
    let lastRequestImageHeavy = false;

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
            if (!active) return;
            lastRawEstimate = estimateBodyTokens(body);
            // 图片的真实开销随分辨率变化很大，图片占比高的请求算出来的比例不能代表纯文本。
            lastRequestImageHeavy = countImageParts(body) * IMAGE_PART_TOKENS > lastRawEstimate * IMAGE_HEAVY_SHARE;
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
        /**
         * @param {object} usage 上游返回的用量
         * @param {string} [actualModel] 实际应答的模型（容灾链换过模型时与请求的模型不同）
         */
        noteUsage(usage, actualModel) {
            if (!active || !lastRawEstimate) return;
            const promptTokens = promptTokensFromUsage(usage);
            if (promptTokens === null) return;
            const rawEstimate = lastRawEstimate;
            lastRawEstimate = 0;
            if (rawEstimate < MIN_CALIBRATION_ESTIMATE) return;
            ratio = clampRatio(promptTokens / rawEstimate);
            // 图片多的请求只校准本请求后续轮次，不写进这个模型的长期比例。
            // 换过模型时比例记在实际应答的模型名下，不改最初那个模型的。
            if (!lastRequestImageHeavy) rememberModelRatio(actualModel || model, ratio);
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
    isRealUserMessage,
    slimEarlierToolResults,
    createBudgetGuard,
    exceededMessage,
    resetModelRatios,
};
