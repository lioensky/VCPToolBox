'use strict';

/**
 * Jev 折叠二次过滤（级联第二阶段）
 *
 * 背景：TVStxt 工具箱折叠原本只靠 embedding 余弦 vs 手工标定阈值（实测 90 个阈值挤在
 * 0.43~0.70、中位 0.53），阈值与具体 embedding 模型的中文相似度分布强绑定，曾发生
 * "阈值低于噪声地板导致全部展开"的线上事故。本模块在 embedding 选出候选之后再加一道
 * Jev 判断：embedding 负责"别漏"，Jev 负责"别滥"。
 *
 * 覆盖面：不只是 TVStxt 工具箱。插件返回带折叠标记的内容时，Plugin.js 同样走
 * buildDynamicFoldObject({strategy:'toolbox_block_similarity'}) → resolveDynamicFoldProtocol，
 * 因此"工具返回是否折叠"也经过本模块；提问集是 TVStxt 全集 ∪ 本次候选，插件自带的
 * desc 一样会被问到。
 *
 * 设计约束（均有官方文档或本机实测依据）：
 * - 只删不加：漏展开会让 Agent 不知道能力存在（任务失败），多展开只是浪费 token，
 *   两种错误不对称，所以本模块只会从候选里移除，且失败时一律不动。
 * - 一次请求问全部区块：官方与本机实测均表明题数不增加延迟（1题331ms/31题329ms/70题372ms），
 *   批量还比逐题便宜约 12 倍且答案不变。
 * - 每轮记忆化：按**送进 Jev 的那段文本**哈希缓存，同一轮内多个占位符共用一次调用。
 * - state 只放一个 `user_message` 字段：本轮请求 + 其前面的近若干轮对话（默认 1 轮，指涉消解用）。
 *   刻意把对话**拼进这个字符串**而不是新开 state 字段——69 条问题都引用 `user_message`，
 *   若把"如何理解指涉"的说明写进问题里会复制 69 份（约 +3.4K tokens，近乎翻倍）；
 *   写进 state 新字段则要多训一次模型对字段的注意力。拼进 user_message 只付一次内容成本。
 *   embedding 阶段本来就用 user+AI 混合向量（mainSearchWeights [0.7,0.3]），Jev 只看用户
 *   一句会读不懂"第二个改成红色"这类指涉，错砍的方向恰好是它唯一能犯的错。
 * - 官方明确 Jev 有 context rot，所以对话默认只取最近一轮、每条截断，不整段历史灌入。
 * - 问题措辞按官方"字面理解"告诫写成直接条件句，不藏复合判断。
 *
 * 配置（根 config.env，全部可选，默认关闭）：
 *   JevFoldFilter=true|false   总开关，默认 false
 *   JevFoldGate=0.35           区块概率低于此值即折叠（默认 0.35，实测依据见 DEFAULTS 注释）
 *   JevFoldIntentGate=0.15     轮级意图低于此值视为闲聊，候选全部折叠
 *   JevFoldMinChars=1200       候选内容总字符低于此值时跳过本轮调用（省下 350ms）
 *   JevFoldTimeoutMs=4000      单次请求硬超时；热路径不做重试
 *   JevFoldDialogueRounds=1    随请求附带的近几轮对话（0=关闭，上限 6）
 *   JevFoldDialogueMsgChars=300 对话里每条消息的截断长度
 */

const fsSync = require('fs');
const path = require('path');
const { parseFoldBlocks } = require('./foldProtocol');
const {
    readBool,
    readNumber,
    truncate,
    sha256,
    createTurnCache,
    askNouls,
    probabilityOf
} = require('./jevScorer');

const DEFAULTS = Object.freeze({
    enabled: false,
    // 0.35 是 2026-09-19 用真实中文消息实测定的：同一批 69 个区块描述，
    // "找上周下载的视频文件" 得 0.90(目录浏览)/0.41(AnySearch)/0.33(复制移动)，
    // "把网页表格抓下来存成文件" 得 0.93/0.92/0.87/0.74/0.73/0.66/0.64/0.57/0.53。
    // 门槛 0.5 会把 0.41 这类次相关区块也砍掉；而漏展开的代价（Agent 根本不知道能力存在）
    // 远大于多展开几千字符的 token 浪费，所以取更保守的 0.35。
    gate: 0.35,
    intentGate: 0.15,
    minChars: 1200,
    timeoutMs: 4000,
    maxUserChars: 1200,
    maxDescChars: 200,
    // 近若干轮对话随请求附带：解决"第二个改成红色"这类指涉——embedding 那侧本来就
    // 用了 user+AI 混合向量，Jev 只看用户一句会在方向上系统性错砍。
    // 默认 1 轮（一问一答两条）：成本实测 4303 -> 约 4600 tokens（+7%），一轮多六分之一美分。
    dialogueRounds: 1,
    dialogueMsgChars: 300
});

const INTENT_QUESTION = '用户消息 `user_message` 是否表达了要执行某个具体操作的意图（而不是纯闲聊或单纯追问）？';
const blockQuestion = desc => `用户想完成的事情，是否会用到下面这项能力？能力描述："${desc}"`;

// key(sha256(userContent)) -> { intent, probs: Map<normalizedDesc, number> }
const turnCache = createTurnCache({ ttlMs: 120000, maxEntries: 32 });

function getConfig() {
    return {
        enabled: readBool('JevFoldFilter', DEFAULTS.enabled),
        gate: readNumber('JevFoldGate', DEFAULTS.gate, 0, 1),
        intentGate: readNumber('JevFoldIntentGate', DEFAULTS.intentGate, 0, 1),
        minChars: readNumber('JevFoldMinChars', DEFAULTS.minChars, 0, Number.MAX_SAFE_INTEGER),
        timeoutMs: readNumber('JevFoldTimeoutMs', DEFAULTS.timeoutMs, 200, 60000),
        maxUserChars: DEFAULTS.maxUserChars,
        maxDescChars: DEFAULTS.maxDescChars,
        dialogueRounds: Math.round(readNumber('JevFoldDialogueRounds', DEFAULTS.dialogueRounds, 0, 6)),
        dialogueMsgChars: Math.round(readNumber('JevFoldDialogueMsgChars', DEFAULTS.dialogueMsgChars, 40, 2000))
    };
}

function isEnabled() {
    return getConfig().enabled;
}

function normalizeDesc(description) {
    return String(description || '').trim().replace(/\s+/g, ' ');
}

/**
 * TVStxt 里全部"带 desc 且阈值>0"的区块描述——即需要判定的全集。
 * 用文件指纹（目录 + 数量 + 最新 mtime）做失效判断，热改工具包后下一轮即生效。
 */
function loadDescUniverse(tvsDir) {
    let dir = tvsDir;
    if (!dir || typeof dir !== 'string') {
        try {
            dir = require('./toolboxManager').tvsDir;
        } catch (e) {
            dir = path.join(__dirname, '..', 'TVStxt');
        }
    }

    let files = [];
    try {
        files = fsSync.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.txt'));
    } catch (e) {
        return { fingerprint: 'unavailable', descs: [] };
    }

    let maxMtime = 0;
    for (const f of files) {
        try {
            const st = fsSync.statSync(path.join(dir, f));
            if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
        } catch (e) { /* 单个文件不可读则跳过 */ }
    }

    const descs = [];
    const seen = new Set();
    for (const f of files) {
        let blocks = [];
        try {
            blocks = parseFoldBlocks(fsSync.readFileSync(path.join(dir, f), 'utf8'));
        } catch (e) {
            continue;
        }
        for (const b of blocks) {
            if (!(b && b.threshold > 0)) continue;
            const d = normalizeDesc(b.description);
            if (!d || seen.has(d)) continue;
            seen.add(d);
            descs.push(d);
        }
    }

    return { fingerprint: `${dir}|${files.length}|${Math.round(maxMtime)}`, descs };
}

let universeCache = { fingerprint: null, descs: [] };

function getDescUniverse(tvsDir) {
    const fresh = loadDescUniverse(tvsDir);
    if (fresh.fingerprint !== universeCache.fingerprint) {
        universeCache = fresh;
    }
    return universeCache.descs;
}

/**
 * 把"近 N 轮对话"和"本轮请求"拼成送进 Jev 的那段文本。
 *
 * 为什么要拼：用户消息经常是指涉型的（"第二个改成红色"、"就按你说的办"），单看这一句
 * 没有信息量，Jev 会把概率整体打低并错砍区块。embedding 那侧用 user+AI 混合向量，本来就
 * 带着这段上下文；Jev 不带就是能力倒退。
 *
 * 为什么拼进 user_message 而不是新开 state 字段：69 条问题全部引用 `user_message`，
 * 说明性指令写进问题会复制 69 份（约 +3.4K tokens）；写进独立字段则要模型额外注意一个
 * 键。这里靠文本自带的标题说明，一份成本都不多付。
 *
 * @param {string} userText  本轮用户消息（已 sanitize）
 * @param {Array}  [recentMessages]  本轮之前的消息，时间升序 [{role, text}]
 * @param {Object} cfg
 * @returns {string} 送进 state.user_message 的文本
 */
function composeUserMessage(userText, recentMessages, cfg) {
    const request = truncate(String(userText || '').trim(), cfg.maxUserChars);
    const rounds = Number(cfg.dialogueRounds) || 0;
    if (rounds <= 0 || !Array.isArray(recentMessages) || recentMessages.length === 0) {
        return request;
    }

    // 一轮 = 一问一答两条消息；只留 user/assistant 且有正文的
    const usable = recentMessages
        .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
        .map(m => ({ role: m.role, text: String(m.text || '').trim() }))
        .filter(m => m.text);
    const window = usable.slice(-rounds * 2);
    if (window.length === 0) return request;

    const lines = window.map(m => `${m.role === 'user' ? '用户' : '助手'}：${truncate(m.text, cfg.dialogueMsgChars)}`);
    return `【近 ${window.length} 条对话，仅用于理解本轮请求里的指代】\n${lines.join('\n')}\n【本轮请求】\n${request}`;
}

/**
 * 就一批 desc 向 Jev 提问，返回 { intent, probs: Map<desc, number>, latencyMs }。
 * 任何异常都抛出，由 filterCandidates 转成 applied=false。
 */
async function askJev({ client, stateText, descs, cfg, debug, placeholderKey }) {
    const state = { user_message: stateText };
    const questions = {
        turn_intent: { type: 'noul', instructions: INTENT_QUESTION }
    };
    descs.forEach((d, i) => {
        questions[`blk_${i}`] = {
            type: 'noul',
            instructions: blockQuestion(truncate(d, cfg.maxDescChars))
        };
    });

    const { answers, latencyMs } = await askNouls({
        client,
        state,
        questions,
        timeoutMs: cfg.timeoutMs,
        debug,
        label: `JevFold ${placeholderKey || '-'}`
    });

    // 意图缺失时取 1：宁可少折叠，不可因缺字段而误判成闲聊把候选全砍
    const intentRaw = probabilityOf(answers, 'turn_intent');
    const intent = intentRaw === null ? 1 : intentRaw;

    const probs = new Map();
    descs.forEach((d, i) => {
        const p = probabilityOf(answers, `blk_${i}`);
        if (p !== null) probs.set(d, p);
    });

    return { intent, probs, latencyMs };
}

/**
 * 对"已通过 embedding 阶段"的候选区块做二次过滤。
 *
 * @param {Object}   p
 * @param {string}   p.userContent  当前用户消息（已 sanitize）
 * @param {Array}    p.candidates   [{ description, content }]，顺序即展开顺序
 * @param {Array}   [p.recentMessages]  本轮之前的对话，时间升序 [{role, text}]；用于消解指涉
 * @param {boolean} [p.debug]
 * @param {Object}  [p.client]      注入用（测试）；默认 require('./jevClient')
 * @param {string[]} [p.universe]   注入用（测试）；默认扫 TVStxt
 * @param {string}  [p.placeholderKey] 仅用于日志
 * @returns {Promise<{applied:boolean, reason?:string, droppedIndices?:number[],
 *                    probabilities?:Array<number|null>, intent?:number, gate?:number,
 *                    cached?:boolean, totalChars?:number}>}
 */
async function filterCandidates(p = {}) {
    const cfg = getConfig();
    if (!cfg.enabled) return { applied: false, reason: 'disabled' };

    const candidates = Array.isArray(p.candidates) ? p.candidates : [];
    if (candidates.length === 0) return { applied: false, reason: 'no_candidates' };

    const userText = String(p.userContent || '').trim();
    if (!userText) return { applied: false, reason: 'no_user_text' };

    // 近若干轮对话随请求一起送：指涉型消息单看没有信息量，会系统性错砍
    const stateText = composeUserMessage(userText, p.recentMessages, cfg);
    const totalChars = candidates.reduce((sum, c) => sum + String((c && c.content) || '').length, 0);
    // 缓存键必须是"实际送出去的那段文本"：同一句"改成红色"配上不同历史，答案是不同的
    const cacheKey = sha256(stateText);
    let entry = turnCache.get(cacheKey);
    const wasCached = Boolean(entry);

    // 提问集 = TVStxt 全集 ∪ 本次候选（插件自带的折叠块不在 TVStxt 里）
    const needed = new Set(candidates.map(c => normalizeDesc(c && c.description)).filter(Boolean));
    const universeDescs = Array.isArray(p.universe) ? p.universe.map(normalizeDesc).filter(Boolean) : getDescUniverse();
    universeDescs.forEach(d => needed.add(d));

    try {
        const client = p.client || require('./jevClient');
        if (!client || typeof client.decide !== 'function') {
            return { applied: false, reason: 'jev_client_unavailable' };
        }
        if (typeof client.isConfigured === 'function' && !client.isConfigured()) {
            // 没配 key 不是错误，别打请求也别刷错误日志
            return { applied: false, reason: 'jev_not_configured' };
        }
        if (!entry) {
            // 缓存未命中时才考虑成本闸门：候选太少就不值得为它多打一次外网
            if (totalChars < cfg.minChars) {
                return { applied: false, reason: 'below_min_chars', totalChars };
            }
            const result = await askJev({
                client,
                stateText,
                descs: [...needed],
                cfg,
                debug: p.debug,
                placeholderKey: p.placeholderKey
            });
            entry = { intent: result.intent, probs: result.probs };
            turnCache.set(cacheKey, entry);
        } else {
            // 命中缓存但缺某些 desc（例如随后才出现的插件折叠块）：只补问缺的那些
            const missing = [...needed].filter(d => !entry.probs.has(d));
            if (missing.length > 0) {
                const extra = await askJev({
                    client,
                    stateText,
                    descs: missing,
                    cfg,
                    debug: p.debug,
                    placeholderKey: p.placeholderKey
                });
                extra.probs.forEach((v, k) => entry.probs.set(k, v));
            }
            turnCache.touch(cacheKey);
        }
    } catch (e) {
        // 热路径铁律：Jev 出任何问题都退回 embedding 的原结果，绝不因过滤失败而少给工具文档
        if (p.debug) {
            console.log(`[JevFold] 跳过过滤（${(e && e.code) || ''} ${(e && e.message) || e}）`);
        }
        return { applied: false, reason: `jev_error:${(e && (e.code || e.message)) || 'unknown'}`, totalChars };
    }

    const lowIntent = entry.intent < cfg.intentGate;
    const droppedIndices = [];
    const probabilities = [];

    candidates.forEach((c, i) => {
        const desc = normalizeDesc(c && c.description);
        const prob = desc && entry.probs.has(desc) ? entry.probs.get(desc) : null;
        probabilities.push(prob);
        // 没有概率的（不在提问集里）一律保留——保守优先
        if (prob === null) return;
        if (lowIntent || prob < cfg.gate) droppedIndices.push(i);
    });

    return {
        applied: true,
        reason: lowIntent ? 'low_intent' : 'gate',
        droppedIndices,
        probabilities,
        intent: entry.intent,
        gate: cfg.gate,
        intentGate: cfg.intentGate,
        cached: wasCached,
        totalChars
    };
}

function clearTurnCache() {
    turnCache.clear();
}

module.exports = {
    filterCandidates,
    isEnabled,
    getConfig,
    clearTurnCache,
    // 供测试与诊断
    _internals: { normalizeDesc, loadDescUniverse, getDescUniverse, composeUserMessage, DEFAULTS, turnCache }
};
