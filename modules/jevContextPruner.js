'use strict';

/**
 * Jev 上下文剪枝打分器
 *
 * 背景：contextManager.pruneMessages 原本是纯位置规则——保住 system、保住 [系统提示:] 前缀、
 * 保住最后两条，然后**从索引 0 往后删**到预算内。也就是说它删的是"最老的"，不是"最没用的"：
 * 一条很早但定义了整个任务的消息，会和一条昨天的闲聊同等对待。
 *
 * 本模块只做一件事：给每条可删消息打一个"是否还有用"的 Noul 概率。**删多少、删到哪、
 * 哪些绝对不能删，全部留在 contextManager 的代码里**——预算是硬约束，不变量是硬规则，
 * 模型只提供排序依据。
 *
 * 设计约束：
 * - state 极简：只放"当前要处理的请求"+ 本块消息正文。官方明确 Jev 有 context rot。
 * - 分块并发：每块独立一次请求（state 各自只含本块），块间无依赖所以并发发出；
 *   受 maxChunks 上限保护，超了就不打分、直接回退位置规则。
 * - 打分失败的消息视为"保留"（概率当 1 处理），绝不因为没问到就删它。
 * - 任何整体失败都返回 applied=false，由调用方回退到原位置规则。
 *
 * 配置（根 config.env，全部可选，默认关闭）：
 *   JevContextPrune=true|false      总开关，默认 false
 *   JevContextPruneChunk=24         每次请求打分的消息条数
 *   JevContextPruneMaxChunks=4      最多分几块（24*4=96 条），超出回退位置规则
 *   JevContextPruneChars=400        state 里每条消息的截断长度
 *   JevContextPruneTimeoutMs=6000   单块硬超时；热路径不做重试
 */

const {
    readBool,
    readNumber,
    truncate,
    askNouls,
    probabilityOf
} = require('./jevScorer');

const DEFAULTS = Object.freeze({
    enabled: false,
    chunkSize: 24,
    maxChunks: 4,
    maxMessageChars: 400,
    goalChars: 600,
    timeoutMs: 6000
});

function getConfig() {
    return {
        enabled: readBool('JevContextPrune', DEFAULTS.enabled),
        chunkSize: Math.round(readNumber('JevContextPruneChunk', DEFAULTS.chunkSize, 1, 200)),
        maxChunks: Math.round(readNumber('JevContextPruneMaxChunks', DEFAULTS.maxChunks, 1, 32)),
        maxMessageChars: Math.round(readNumber('JevContextPruneChars', DEFAULTS.maxMessageChars, 40, 4000)),
        goalChars: DEFAULTS.goalChars,
        timeoutMs: readNumber('JevContextPruneTimeoutMs', DEFAULTS.timeoutMs, 500, 60000)
    };
}

function isEnabled() {
    return getConfig().enabled;
}

/** 多模态 content 数组里只取文本部分，与 contextManager.estimateTokens 的口径保持一致 */
function extractText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    let out = '';
    for (const part of content) {
        if (part && part.type === 'text' && typeof part.text === 'string') out += part.text;
    }
    return out;
}

const messageQuestion = i =>
    `消息 \`messages[${i}]\` 提供的信息，对继续处理 \`current_request\` 或紧随其后的对话是否仍有用？` +
    '（只判断这条消息本身是否还需要被看到，不要推测它是否已被别的消息覆盖）';

/**
 * 给指定下标的消息打"是否还有用"的概率。
 *
 * @param {Object} p
 * @param {Array}  p.messages        完整消息数组（原样，不截断）
 * @param {number[]} p.indices       要打分的下标（调用方已排除不可删的）
 * @param {string} p.currentRequest  当前要处理的请求文本（判断"还有用"的参照系）
 * @param {boolean}[p.debug]
 * @param {Object} [p.client]        注入用（测试）
 * @returns {Promise<{applied:boolean, reason?:string, scores?:Map<number,number>,
 *                    asked?:number, failedChunks?:number, latencyMs?:number}>}
 */
async function scoreMessages(p = {}) {
    const cfg = getConfig();
    if (!cfg.enabled) return { applied: false, reason: 'disabled' };

    const messages = Array.isArray(p.messages) ? p.messages : [];
    const indices = (Array.isArray(p.indices) ? p.indices : []).filter(i => Number.isInteger(i) && i >= 0 && i < messages.length);
    if (indices.length === 0) return { applied: false, reason: 'no_candidates' };

    if (indices.length > cfg.chunkSize * cfg.maxChunks) {
        // 太长就不打分：分太多块既慢又贵，位置规则至少是可预期的
        return { applied: false, reason: 'too_many_messages', asked: indices.length };
    }

    const client = p.client || require('./jevClient');
    if (!client || typeof client.decide !== 'function') {
        return { applied: false, reason: 'jev_client_unavailable' };
    }
    if (typeof client.isConfigured === 'function' && !client.isConfigured()) {
        return { applied: false, reason: 'jev_not_configured' };
    }

    const goal = truncate(String(p.currentRequest || ''), cfg.goalChars);

    // 分块
    const chunks = [];
    for (let i = 0; i < indices.length; i += cfg.chunkSize) {
        chunks.push(indices.slice(i, i + cfg.chunkSize));
    }

    const scores = new Map();
    let failedChunks = 0;
    let asked = 0;
    const startedAt = Date.now();

    // 块间无依赖 → 并发发出（官方：独立问题应一起问；这里是独立请求，同理并发）
    const results = await Promise.all(chunks.map(async (chunk, chunkNo) => {
        const state = {
            current_request: goal || '(未提供)',
            messages: chunk.map((msgIndex, i) => ({
                role: String(messages[msgIndex] && messages[msgIndex].role || 'unknown'),
                text: truncate(extractText(messages[msgIndex] && messages[msgIndex].content), cfg.maxMessageChars)
            }))
        };
        const questions = {};
        chunk.forEach((msgIndex, i) => {
            questions[`m_${i}`] = { type: 'noul', instructions: messageQuestion(i) };
        });

        try {
            const res = await askNouls({
                client,
                state,
                questions,
                timeoutMs: cfg.timeoutMs,
                debug: p.debug,
                label: `JevPrune chunk${chunkNo}`
            });
            asked += chunk.length;
            chunk.forEach((msgIndex, i) => {
                const prob = probabilityOf(res.answers, `m_${i}`);
                // 缺分数的消息不进 scores → 调用方按"保留"处理
                if (prob !== null) scores.set(msgIndex, prob);
            });
        } catch (e) {
            failedChunks += 1;
            if (p.debug) {
                console.log(`[JevPrune] chunk${chunkNo} 打分失败，该块消息一律保留：${(e && e.code) || ''} ${(e && e.message) || e}`);
            }
        }
    }));
    void results;

    if (scores.size === 0) {
        return { applied: false, reason: 'no_scores', failedChunks, latencyMs: Date.now() - startedAt };
    }

    return {
        applied: true,
        scores,
        asked,
        failedChunks,
        latencyMs: Date.now() - startedAt
    };
}

module.exports = {
    scoreMessages,
    isEnabled,
    getConfig,
    extractText,
    _internals: { extractText, DEFAULTS, messageQuestion }
};
