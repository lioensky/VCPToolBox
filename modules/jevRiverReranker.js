'use strict';

/**
 * Jev river 上下文重排（级联第二阶段）
 *
 * 背景：工具调用的 river `semantic:N` 模式原本是"把工具参数拼成 query → 逐条消息向量化 →
 * 余弦排序取 Top-N"。余弦量的是词汇/语义邻近，结构上分不清"词汇重合"和"真的用得上"。
 * 本模块在 embedding 排出 Top-K 之后，让 Jev 在 K 内重排并取 N：embedding 负责"别漏"，
 * Jev 负责"别滥"。
 *
 * 为什么是级联而不是替换：river 在**每次工具调用**都跑，一轮可能多次，属最热的路径；
 * 让 embedding 先把候选压到 K 条，Jev 的题数与 token 都可控。
 *
 * 设计约束：
 * - 只重排、不扩充：最终条数仍是 N，不会因为 Jev 而给工具塞更多上下文。
 * - 打分缺失的候选排到最后，仅在还有名额时按 embedding 序补位（不凭空丢弃，
 *   但也不保证一定入选）；整个请求失败则返回 applied=false，调用方保留 embedding 的 Top-N。
 * - state 极简：只放工具任务描述 + 候选消息正文（各自截断）。
 * - 任何失败都返回 applied=false，由调用方保留 embedding 的 Top-N。
 *
 * 配置（根 config.env，全部可选，默认关闭）：
 *   JevRiverRerank=true|false   总开关，默认 false
 *   JevRiverK=3                 候选放大倍率：K = max(N*倍率, N+JevRiverMargin)
 *   JevRiverMargin=8            候选放大的绝对余量
 *   JevRiverChars=600           state 里每条消息的截断长度
 *   JevRiverTimeoutMs=4000      单次请求硬超时；热路径不做重试
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
    kMultiplier: 3,
    kMargin: 8,
    maxMessageChars: 600,
    taskChars: 600,
    timeoutMs: 4000
});

function getConfig() {
    return {
        enabled: readBool('JevRiverRerank', DEFAULTS.enabled),
        kMultiplier: readNumber('JevRiverK', DEFAULTS.kMultiplier, 1, 20),
        kMargin: Math.round(readNumber('JevRiverMargin', DEFAULTS.kMargin, 0, 200)),
        maxMessageChars: Math.round(readNumber('JevRiverChars', DEFAULTS.maxMessageChars, 40, 4000)),
        taskChars: DEFAULTS.taskChars,
        timeoutMs: readNumber('JevRiverTimeoutMs', DEFAULTS.timeoutMs, 200, 60000)
    };
}

function isEnabled() {
    return getConfig().enabled;
}

const itemQuestion = i =>
    `消息 \`messages[${i}]\` 的内容，对完成 \`task\` 所描述的这次工具调用是否有帮助？` +
    '（只判断这条消息本身是否值得作为上下文提供给该工具）';

/**
 * 在 embedding 排好序的候选里重排出 Top-N。
 *
 * @param {Object} p
 * @param {string} p.queryText  工具调用参数拼出的任务描述
 * @param {Array}  p.items      [{ index, role, text, score }]，**已按 score 降序**
 * @param {number} p.n          最终要保留的条数
 * @param {boolean}[p.debug]
 * @param {Object} [p.client]   注入用（测试）
 * @returns {Promise<{applied:boolean, reason?:string, selected?:Array, latencyMs?:number, k?:number}>}
 */
async function rerankTopN(p = {}) {
    const cfg = getConfig();
    if (!cfg.enabled) return { applied: false, reason: 'disabled' };

    const items = Array.isArray(p.items) ? p.items : [];
    const n = Number.isFinite(p.n) ? Math.max(1, Math.floor(p.n)) : 1;
    if (items.length <= n) return { applied: false, reason: 'no_need', k: items.length };

    const k = Math.min(items.length, Math.max(n * cfg.kMultiplier, n + cfg.kMargin));
    const shortlist = items.slice(0, k);

    const client = p.client || require('./jevClient');
    if (!client || typeof client.decide !== 'function') {
        return { applied: false, reason: 'jev_client_unavailable' };
    }
    if (typeof client.isConfigured === 'function' && !client.isConfigured()) {
        return { applied: false, reason: 'jev_not_configured' };
    }

    const taskText = truncate(String(p.queryText || ''), cfg.taskChars) || '(未提供)';
    const state = {
        task: taskText,
        messages: shortlist.map(item => ({
            role: String((item && item.role) || 'unknown'),
            text: truncate((item && item.text) || '', cfg.maxMessageChars)
        }))
    };
    const questions = {};
    shortlist.forEach((item, i) => {
        questions[`m_${i}`] = { type: 'noul', instructions: itemQuestion(i) };
    });

    let answers;
    const startedAt = Date.now();
    try {
        const res = await askNouls({
            client,
            state,
            questions,
            timeoutMs: cfg.timeoutMs,
            debug: p.debug,
            label: 'JevRiver'
        });
        answers = res.answers;
    } catch (e) {
        if (p.debug) {
            console.log(`[JevRiver] 重排失败，保留 embedding 的 Top-${n}：${(e && e.code) || ''} ${(e && e.message) || e}`);
        }
        return { applied: false, reason: `jev_error:${(e && (e.code || e.message)) || 'unknown'}`, k };
    }
    const latencyMs = Date.now() - startedAt;

    // 概率降序；同分用 embedding 分数做 tiebreak；再同则按原始顺序（稳定）
    const ranked = shortlist
        .map((item, i) => ({ item, i, prob: probabilityOf(answers, `m_${i}`) }))
        .sort((a, b) => {
            const pa = a.prob === null ? -1 : a.prob;
            const pb = b.prob === null ? -1 : b.prob;
            if (pa !== pb) return pb - pa;
            const sa = Number.isFinite(a.item && a.item.score) ? a.item.score : 0;
            const sb = Number.isFinite(b.item && b.item.score) ? b.item.score : 0;
            if (sa !== sb) return sb - sa;
            return a.i - b.i;
        });

    const selected = ranked.slice(0, n).map(entry => entry.item);
    const scored = ranked.filter(entry => entry.prob !== null).length;

    if (p.debug) {
        console.log(
            `[JevRiver] 候选 ${items.length} → K=${k} → 选中 ${selected.length} / ` +
            `有效打分 ${scored} / ${latencyMs}ms`
        );
    }

    return { applied: true, selected, latencyMs, k, scored };
}

module.exports = {
    rerankTopN,
    isEnabled,
    getConfig,
    _internals: { DEFAULTS, itemQuestion }
};
