'use strict';

/**
 * Jev 通用调用层
 *
 * 把"配置读取 + 批量 Noul 提问 + 热路径超时/禁重试 + 响应校验 + 记忆化"收敛到一处，
 * 供折叠二次过滤（jevFoldFilter）、上下文剪枝（jevContextPruner）、river 重排
 * （jevRiverReranker）等热路径复用，避免三份各自演化的超时与回退逻辑。
 *
 * 铁律：本层**不吞错、不返回半成品**。任何失败（未配置/超时/网络/响应异常）一律抛出，
 * 由调用方决定回退到什么——因为每处的安全回退点不同（折叠回退到 embedding 结果、
 * 剪枝回退到位置规则、river 回退到 last:N）。
 */

const crypto = require('crypto');

function readBool(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function readNumber(name, fallback, min, max) {
    const parsed = Number.parseFloat(process.env[name]);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function isValidProbability(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function truncate(text, max) {
    const s = String(text === undefined || text === null ? '' : text);
    return s.length > max ? s.slice(0, max) : s;
}

function sha256(text) {
    return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function fail(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

/**
 * 带 TTL 与容量上限的记忆化缓存。
 * 用途：同一轮对话里多个调用点（例如 7 个工具箱占位符）共用一次 Jev 请求。
 */
function createTurnCache({ ttlMs = 120000, maxEntries = 32 } = {}) {
    const store = new Map();

    function prune() {
        const now = Date.now();
        for (const [key, entry] of store) {
            if (now - entry.at > ttlMs) store.delete(key);
        }
        while (store.size > maxEntries) {
            const oldest = store.keys().next().value;
            if (oldest === undefined) break;
            store.delete(oldest);
        }
    }

    return {
        get(key) {
            const entry = store.get(key);
            if (!entry) return undefined;
            if (Date.now() - entry.at > ttlMs) {
                store.delete(key);
                return undefined;
            }
            return entry.value;
        },
        set(key, value) {
            store.set(key, { at: Date.now(), value });
            prune();
        },
        touch(key) {
            const entry = store.get(key);
            if (entry) entry.at = Date.now();
        },
        clear() {
            store.clear();
        },
        get size() {
            return store.size;
        }
    };
}

/**
 * 发一次 Jev 请求并校验响应。
 *
 * @param {Object} p
 * @param {Object} p.client        jevClient（或测试注入的 stub），需有 decide()
 * @param {*}      p.state         极简 state；官方明确 Jev 有 context rot，只放必要字段
 * @param {Object} p.questions     { qid: { type:'noul', instructions } }
 * @param {number}[p.timeoutMs]    热路径硬超时，默认 4000
 * @param {boolean}[p.debug]
 * @param {string}[p.label]        日志前缀
 * @returns {Promise<{answers:Object, latencyMs:number, usage:Object, questionCount:number}>}
 */
async function askNouls(p = {}) {
    const { client, state, questions } = p;
    const timeoutMs = Number.isFinite(p.timeoutMs) ? p.timeoutMs : 4000;
    const label = p.label || 'Jev';

    if (!client || typeof client.decide !== 'function') {
        throw fail('JEV_CLIENT_UNAVAILABLE', 'jevClient 不可用');
    }
    if (typeof client.isConfigured === 'function' && !client.isConfigured()) {
        throw fail('JEV_NOT_CONFIGURED', 'Jev 未配置（缺 JEV_API_KEY）');
    }
    if (!questions || typeof questions !== 'object' || Object.keys(questions).length === 0) {
        throw fail('JEV_NO_QUESTIONS', '没有可提的问题');
    }

    const options = { timeoutMs, maxRetries: 0 };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        // 硬保险：即使底层超时未生效也在此刻中止，绝不拖住调用方的关键路径
        options.signal = AbortSignal.timeout(timeoutMs + 500);
    }

    const startedAt = Date.now();
    const response = await client.decide(state, questions, options);
    const latencyMs = Date.now() - startedAt;

    const answers = response && response.answers;
    if (!answers || typeof answers !== 'object') {
        throw fail('JEV_INVALID_RESPONSE', '响应缺少 answers 对象');
    }

    if (p.debug) {
        const usage = response.usage || {};
        console.log(
            `[${label}] 提问 ${Object.keys(questions).length} 题 / ${latencyMs}ms / ` +
            `input_tokens=${usage.input_tokens === undefined ? '?' : usage.input_tokens}`
        );
    }

    return {
        answers,
        latencyMs,
        usage: response.usage || {},
        questionCount: Object.keys(questions).length
    };
}

/** 从 answers 里安全取一个 Noul 概率；缺失或非法一律返回 null（调用方应视为"未知"并保守处理） */
function probabilityOf(answers, qid) {
    const a = answers && answers[qid];
    const p = a && a.noul;
    return isValidProbability(p) ? p : null;
}

module.exports = {
    readBool,
    readNumber,
    isValidProbability,
    truncate,
    sha256,
    fail,
    createTurnCache,
    askNouls,
    probabilityOf
};
