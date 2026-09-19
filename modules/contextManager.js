/**
 * 上下文管理器 - 处理 VCP 特有的 contextTokenLimit 参数
 */

const jevContextPruner = require('./jevContextPruner.js');

/**
 * 估算消息的 Token 数量 (仅计算文本内容，排除 Base64 等多媒体数据)
 * @param {Array} messages
 * @returns {number}
 */
function estimateTokens(messages) {
    let textLength = 0;
    for (const msg of messages) {
        if (typeof msg.content === 'string') {
            textLength += msg.content.length;
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part.type === 'text' && typeof part.text === 'string') {
                    textLength += part.text.length;
                }
                // 忽略 image_url 等非文本类型，因为它们的 Token 计算逻辑完全不同
            }
        }
    }
    return textLength;
}

/**
 * 计算"绝对不能删"的消息下标集合。
 * 抽出来是为了让位置规则与 Jev 打分两条路径共用同一套不变量——
 * 无论用哪种排序删消息，这三条规则都必须一模一样地生效。
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
    // 通常是最后两条消息
    mustKeepIndices.add(totalLen - 1);
    if (totalLen >= 2) {
        mustKeepIndices.add(totalLen - 2);
    }

    return mustKeepIndices;
}

/**
 * 根据限制修剪消息历史
 * @param {Array} messages 原始消息数组
 * @param {number} limit Token 限制 (字符数估算)
 * @param {boolean} debugMode 是否开启调试日志
 * @returns {Array} 修剪后的消息数组
 */
function pruneMessages(messages, limit, debugMode = false) {
    if (!limit || !Array.isArray(messages) || messages.length <= 2) {
        return messages;
    }

    const totalLen = messages.length;
    const mustKeepIndices = computeMustKeepIndices(messages);

    let currentEstimatedTokens = estimateTokens(messages);
    if (debugMode) {
        console.log(`[ContextManager] 初始估算长度: ${currentEstimatedTokens}, 限制: ${limit}`);
    }

    if (currentEstimatedTokens <= limit) {
        return messages;
    }

    // 复制一份索引数组用于操作
    let resultIndices = [];
    for (let i = 0; i < totalLen; i++) {
        resultIndices.push(i);
    }

    // 从前往后尝试删除不在 mustKeepIndices 中的消息
    // 注意：我们从索引 0 开始遍历原始消息
    for (let i = 0; i < totalLen; i++) {
        if (currentEstimatedTokens <= limit) break;

        // 如果不是必须保留的消息，则从结果中移除
        if (!mustKeepIndices.has(i)) {
            const indexInResult = resultIndices.indexOf(i);
            if (indexInResult !== -1) {
                resultIndices.splice(indexInResult, 1);
                // 重新计算当前估算长度
                const currentMessages = resultIndices.map(idx => messages[idx]);
                currentEstimatedTokens = estimateTokens(currentMessages);
                
                if (debugMode) {
                    console.log(`[ContextManager] 已移除索引为 ${i} 的消息。剩余估算长度: ${currentEstimatedTokens}`);
                }
            }
        }
    }

    return resultIndices.map(idx => messages[idx]);
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

    // estimateTokens 是逐条求和，所以每条消息的贡献可加：一次算完，
    // 避免原实现"每删一条就重扫整个数组"的 O(n²)。
    const weights = messages.map(msg => estimateTokens([msg]));
    let remaining = weights.reduce((sum, w) => sum + w, 0);

    // 删除顺序：概率升序（越没用越先删）；没打到分的按 1 处理，即最后才考虑；
    // 同分按原始位置升序——与原位置规则一致，老的先走。
    const order = deletable.slice().sort((a, b) => {
        const pa = decision.scores.has(a) ? decision.scores.get(a) : 1;
        const pb = decision.scores.has(b) ? decision.scores.get(b) : 1;
        if (pa !== pb) return pa - pb;
        return a - b;
    });

    const dropped = new Set();
    for (const idx of order) {
        if (remaining <= limit) break;
        dropped.add(idx);
        remaining -= weights[idx];
    }

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
    pruneMessages,
    pruneMessagesSmart,
    computeMustKeepIndices,
    estimateTokens
};