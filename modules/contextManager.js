/**
 * 上下文管理器 - 处理 VCP 特有的 contextTokenLimit 参数
 */

const jevContextPruner = require('./jevContextPruner.js');
const { readBool } = require('./jevScorer');
const contextBudget = require('./contextBudget.js');

// 服务端总开关，默认关闭；客户端 contextTokenLimit 不能绕过此开关。
function isPruningEnabled() {
    return readBool('ContextPruneEnabled', false);
}

/**
 * 裁剪的步长。1 = 刚好不超就停，每一轮裁剪边界都会往后挪一点；
 * 调低（如 0.8）后按「上限 × (1 − 比例)」为一档成档地删：对话在同一档内增长时，
 * 被删掉的是同一批最老的消息，发给上游的前缀不变，提示缓存可以持续命中。
 */
function pruneTargetRatio() {
    const ratio = Number(process.env.ContextPruneTargetRatio);
    return Number.isFinite(ratio) && ratio >= 0.5 && ratio <= 1 ? ratio : 1;
}

/**
 * 估算消息的 Token 数量。与出站预算检查同一套算法：文本按「汉字 2、其余 1，除以 3」，
 * 图片按固定值，原生工具调用的参数也计入；不把 Base64 当文本数。
 * @param {Array} messages
 * @returns {number}
 */
function estimateTokens(messages) {
    return contextBudget.estimateMessagesTokens(messages);
}

/**
 * 计算"绝对不能删"的消息下标集合。
 * 抽出来是为了让位置规则与 Jev 打分两条路径共用同一套不变量。
 * @param {Array} messages
 * @returns {Set<number>}
 */
function computeMustKeepIndices(messages) {
    const totalLen = messages.length;
    const mustKeepIndices = new Set();

    // --- 规则 1 & 2: 系统提示词和特定前缀的 User 消息必须保留 ---
    for (let i = 0; i < totalLen; i++) {
        const msg = messages[i];
        if (msg.role === 'system') {
            mustKeepIndices.add(i);
        } else if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.startsWith('[系统提示:]')) {
            mustKeepIndices.add(i);
        }
    }

    // --- 规则 3: 至少保存最后一组 AI 和用户的讨论 ---
    mustKeepIndices.add(totalLen - 1);
    if (totalLen >= 2) {
        mustKeepIndices.add(totalLen - 2);
    }

    // --- 规则 4: 当前轮完整保留 ---
    // 从最后一条真正的用户发言（不是工具回执）到末尾，是模型正在处理的这一轮；
    // 工具链进行到一半时，末尾可能是好几条工具结果，只保最后两条会把发起调用的那条删掉。
    // 起点的判定和出站压缩共用一处：续写提示这类系统替用户说的话不算一轮的开始。
    const turnStart = contextBudget.lastRealUserIndex(messages);
    for (let i = totalLen - 1; i >= Math.max(0, turnStart); i--) mustKeepIndices.add(i);

    return mustKeepIndices;
}

/**
 * 把消息划成"同进同退"的删除单元：发起工具调用的 assistant 消息和紧随其后的工具结果
 * 是一个单元，要么都留、要么都删，否则上游会因为孤立的工具结果直接拒绝请求。
 * 单元里只要有一条必须保留，整个单元都不可删。
 * @returns {Array<number[]>} 可删单元（各自的消息下标，升序）
 */
function computeDeletableUnits(messages, mustKeepIndices) {
    const units = [];
    let i = 0;
    while (i < messages.length) {
        const unit = [i];
        const msg = messages[i];
        if (msg && msg.role === 'assistant') {
            let j = i + 1;
            while (j < messages.length && contextBudget.isToolResultMessage(messages[j])) unit.push(j++);
        } else if (contextBudget.isToolResultMessage(msg)) {
            // 前面没有发起调用的 assistant（历史本身就是残缺的）：和后续连续的工具结果一起处理。
            let j = i + 1;
            while (j < messages.length && contextBudget.isToolResultMessage(messages[j])) unit.push(j++);
        }
        i = unit[unit.length - 1] + 1;
        if (!unit.some(index => mustKeepIndices.has(index))) units.push(unit);
    }
    return units;
}

// --- 裁剪水位：同一段对话的裁剪边界只进不退 ---
// 客户端每次都带完整历史，而每轮的总量会小幅波动（记忆注入长短不一、估算比例在校准）。
// 只按当轮总量算「删多少」的话，边界会在档位附近来回跳：上一轮删掉的消息下一轮又回来，
// 上游的提示缓存连续失效。这里在内存里按对话记住上次的边界，下一轮至少删到同一位置。
// 不落盘：进程重启后最多重新对齐一次。对话被改写（边界消息找不到了）或明显变短时自动作废。
const MAX_TRACKED_CONVERSATIONS = 200;
const WATERMARK_RELEASE_RATIO = 0.7;
const pruneWatermarks = new Map();

function messageHead(message, size) {
    const text = jevContextPruner.extractText(message && message.content) || '';
    return `${message && message.role}|${text.slice(0, size)}`;
}

function conversationKey(messages) {
    const first = messages.find(msg => msg && msg.role !== 'system');
    return first ? messageHead(first, 200) : null;
}

/** 边界 = 留下来的第一条非系统消息；用它和下一条的开头一起当指纹，避免「好的」这类短句重复。 */
function boundaryFingerprint(messages, index) {
    return `${messageHead(messages[index], 120)}\u0000${messageHead(messages[index + 1], 120)}`;
}

function findWatermarkIndex(messages, fingerprint) {
    for (let i = 0; i < messages.length - 1; i++) {
        if (messages[i] && messages[i].role !== 'system' && boundaryFingerprint(messages, i) === fingerprint) return i;
    }
    return -1;
}

function rememberWatermark(key, fingerprint) {
    pruneWatermarks.delete(key);
    pruneWatermarks.set(key, fingerprint);
    if (pruneWatermarks.size > MAX_TRACKED_CONVERSATIONS) pruneWatermarks.delete(pruneWatermarks.keys().next().value);
}

function resetPruneWatermarks() {
    pruneWatermarks.clear();
}

/**
 * 按给定顺序删除单元，直到估算不超过上限；返回被删下标集合。
 * 「删多少」把超出量向上取整到档位的整数倍，一次腾出一档；floorIndex（上次的裁剪边界）
 * 之前的单元无论如何都删，保证边界不后退。
 */
function dropUnitsUntilFits(messages, orderedUnits, limit, mustKeepIndices, floorIndex = -1) {
    const weights = messages.map(msg => estimateTokens([msg]));
    const total = weights.reduce((sum, w) => sum + w, 0);
    const dropped = new Set();
    if (total <= limit && floorIndex <= 0) return dropped;
    const step = limit * (1 - pruneTargetRatio());
    const over = Math.max(0, total - limit);
    const required = step >= 1 ? Math.ceil(over / step) * step : over;
    let removed = 0;
    for (const unit of orderedUnits) {
        if (removed >= required && unit[unit.length - 1] >= floorIndex) break;
        for (const index of unit) {
            dropped.add(index);
            removed += weights[index];
        }
    }
    dropLeadingOrphans(messages, dropped, mustKeepIndices);
    return dropped;
}

/**
 * 裁剪后，留下来的第一条非系统消息如果是 assistant 或工具结果，它回应的那条用户发言已经被删了：
 * 模型读到的是没头的半句，部分上游还会因为对话不是从用户开始而拒绝。把这些开头的残段一并删掉。
 */
function dropLeadingOrphans(messages, dropped, mustKeepIndices) {
    if (!mustKeepIndices || dropped.size === 0) return;
    for (let i = 0; i < messages.length; i++) {
        if (dropped.has(i)) continue;
        const msg = messages[i];
        if (msg && msg.role === 'system') continue;
        const isOrphan = msg && (msg.role === 'assistant' || contextBudget.isToolResultMessage(msg));
        if (!isOrphan || mustKeepIndices.has(i)) return;
        dropped.add(i);
    }
}

/**
 * 根据限制修剪消息历史
 * @param {Array} messages 原始消息数组
 * @param {number} limit Token 限制（本地估算）
 * @param {boolean} debugMode 是否开启调试日志
 * @returns {Array} 修剪后的消息数组
 */
function pruneMessages(messages, limit, debugMode = false) {
    limit = contextBudget.normalizeLimit(limit);
    if (!isPruningEnabled() || !limit || !Array.isArray(messages) || messages.length <= 2) {
        return messages;
    }

    const mustKeepIndices = computeMustKeepIndices(messages);
    const units = computeDeletableUnits(messages, mustKeepIndices);
    // 上次的裁剪边界：对话没被改写、也没有明显变短时沿用。
    const total = estimateTokens(messages);
    const key = conversationKey(messages);
    let floorIndex = -1;
    if (key && pruneWatermarks.has(key)) {
        floorIndex = total > limit * WATERMARK_RELEASE_RATIO ? findWatermarkIndex(messages, pruneWatermarks.get(key)) : -1;
        if (floorIndex === -1) pruneWatermarks.delete(key);
    }
    // 位置规则：从最老的单元开始删。
    const dropped = dropUnitsUntilFits(messages, units, limit, mustKeepIndices, floorIndex);
    if (key && dropped.size > 0) {
        const boundary = messages.findIndex((msg, i) => !dropped.has(i) && msg && msg.role !== 'system');
        if (boundary !== -1 && boundary < messages.length - 1) rememberWatermark(key, boundaryFingerprint(messages, boundary));
    }
    if (debugMode) {
        console.log(`[ContextManager] 估算 ${total}，限制 ${limit}，移除 ${dropped.size} 条消息`);
    }
    if (dropped.size === 0) return messages;
    return messages.filter((msg, i) => !dropped.has(i));
}

/**
 * 取最后一条有正文的 user 消息，作为"当前要处理的请求"——判断某条历史消息
 * 是否还有用的参照系。必须是参照系而不是全部历史：Jev 有 context rot，
 * state 里塞越多无关内容准确率越低。
 */
function findLastUserText(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (!msg || msg.role !== 'user') continue;
        const text = jevContextPruner.extractText(msg.content);
        if (text && text.trim()) return text.trim();
    }
    return '';
}

/**
 * 智能修剪：位置规则（原行为）+ 可选的 Jev 语义排序。
 *
 * 与 pruneMessages 的唯一区别是**删除顺序**：原来从最老开始删，开启后从"最没用"开始删。
 * 预算上限、不可删不变量（system / [系统提示:] / 最后两条）全部留在代码里，模型只提供排序。
 * Jev 未开启、未配置、超时、打分全失败——一律回退到 pruneMessages 的原位置规则。
 *
 * @param {Array} messages
 * @param {number} limit
 * @param {boolean} debugMode
 * @param {Object} [options]  测试注入用：{ client }；生产调用方不传
 * @returns {Promise<Array>}
 */
async function pruneMessagesSmart(messages, limit, debugMode = false, options = {}) {
    // 必须先检查总开关，关闭时不估算、不打分、不删除，原样返回。
    if (!isPruningEnabled()) {
        return messages;
    }
    limit = contextBudget.normalizeLimit(limit);
    if (!jevContextPruner.isEnabled()) {
        return pruneMessages(messages, limit, debugMode);
    }
    if (!limit || !Array.isArray(messages) || messages.length <= 2) {
        return messages;
    }
    // 没超预算就一条都不删，也不打任何请求
    if (estimateTokens(messages) <= limit) {
        return messages;
    }

    const mustKeepIndices = computeMustKeepIndices(messages);
    const deletable = [];
    for (let i = 0; i < messages.length; i++) {
        if (!mustKeepIndices.has(i)) deletable.push(i);
    }
    if (deletable.length === 0) return messages;

    let decision;
    try {
        decision = await jevContextPruner.scoreMessages({
            messages,
            indices: deletable,
            currentRequest: findLastUserText(messages),
            debug: debugMode,
            client: options && options.client
        });
    } catch (e) {
        if (debugMode) console.log(`[ContextManager] Jev 打分异常，回退位置规则: ${e && e.message}`);
        return pruneMessages(messages, limit, debugMode);
    }

    if (!decision || !decision.applied) {
        if (debugMode) {
            console.log(`[ContextManager] Jev 剪枝未生效(${decision && decision.reason})，回退位置规则`);
        }
        return pruneMessages(messages, limit, debugMode);
    }

    // 删除顺序：概率升序（越没用越先删）；没打到分的按 1 处理，即最后才考虑；
    // 同分按原始位置升序——与位置规则一致，老的先走。
    // 工具调用和它的结果是一个单元：单元里只要有一条还有用（取最高分），整个单元就靠后。
    const scoreOf = index => (decision.scores.has(index) ? decision.scores.get(index) : 1);
    const units = computeDeletableUnits(messages, mustKeepIndices)
        .map(unit => ({ unit, score: Math.max(...unit.map(scoreOf)) }))
        .sort((a, b) => (a.score !== b.score ? a.score - b.score : a.unit[0] - b.unit[0]))
        .map(entry => entry.unit);
    const dropped = dropUnitsUntilFits(messages, units, limit, mustKeepIndices);

    if (debugMode) {
        console.log(
            `[ContextManager] Jev 剪枝: 可删 ${deletable.length} / 打分 ${decision.scores.size} / ` +
            `实删 ${dropped.size} / ${decision.latencyMs}ms` +
            (decision.failedChunks ? ` / 失败块 ${decision.failedChunks}` : '')
        );
    }

    if (dropped.size === 0) return messages;
    return messages.filter((msg, i) => !dropped.has(i));
}

module.exports = {
    isPruningEnabled,
    resetPruneWatermarks,
    pruneMessages,
    pruneMessagesSmart,
    computeMustKeepIndices,
    computeDeletableUnits,
    estimateTokens
};