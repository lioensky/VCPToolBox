'use strict';

/**
 * modules/jevFoldFilter.js 的离线单元测试（不发任何网络请求，Jev 客户端由 stub 注入）
 * 运行：node tests/jevFoldFilter.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const jevFoldFilter = require(path.join(__dirname, '..', 'modules', 'jevFoldFilter.js'));

const ENV_KEYS = [
    'JevFoldFilter', 'JevFoldGate', 'JevFoldIntentGate', 'JevFoldMinChars', 'JevFoldTimeoutMs'
];

function setEnv(vars) {
    const saved = {};
    for (const k of ENV_KEYS) {
        saved[k] = process.env[k];
        delete process.env[k];
    }
    for (const [k, v] of Object.entries(vars)) process.env[k] = String(v);
    return saved;
}

function restoreEnv(saved) {
    for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
}

/** 造一个按"问题文本里包含哪个 desc"来决定概率的 stub 客户端 */
function makeClient(probByDesc = {}, opts = {}) {
    const calls = [];
    return {
        calls,
        isConfigured: () => opts.configured !== false,
        decide: async (state, questions, options) => {
            calls.push({
                state,
                questionCount: Object.keys(questions).length,
                timeoutMs: options && options.timeoutMs,
                maxRetries: options && options.maxRetries
            });
            if (opts.fail) {
                const err = new Error(opts.failMessage || 'boom');
                err.code = opts.failCode || 'JEV_REQUEST_FAILED';
                throw err;
            }
            if (opts.emptyAnswers) return { model: 'jev-test', usage: {} };

            const answers = {};
            for (const [qid, q] of Object.entries(questions)) {
                if (qid === 'turn_intent') {
                    answers[qid] = { type: 'noul', noul: opts.intent === undefined ? 0.9 : opts.intent };
                    continue;
                }
                let prob = opts.defaultProb === undefined ? 0.05 : opts.defaultProb;
                for (const [desc, p] of Object.entries(probByDesc)) {
                    if (String(q.instructions).includes(desc)) { prob = p; break; }
                }
                answers[qid] = { type: 'noul', noul: prob };
            }
            return { model: 'jev-test', answers, usage: { input_tokens: 100, output_tokens: 10 } };
        }
    };
}

const UNIVERSE = ['能力A 查找文件', '能力B 播放音乐', '能力C 生成图片'];
const candidates = (n) => Array.from({ length: n }, (_, i) => ({
    description: `能力${String.fromCharCode(65 + i)} 占位描述`,
    content: 'x'.repeat(600)
}));

test('默认关闭：不调用 Jev，也不动候选', async () => {
    jevFoldFilter.clearTurnCache();
    const saved = setEnv({});
    const client = makeClient({}, {});
    try {
        const res = await jevFoldFilter.filterCandidates({
            userContent: '帮我找个文件',
            candidates: [{ description: UNIVERSE[0], content: 'x'.repeat(5000) }],
            client,
            universe: UNIVERSE
        });
        assert.equal(res.applied, false);
        assert.equal(res.reason, 'disabled');
        assert.equal(client.calls.length, 0);
    } finally {
        restoreEnv(saved);
    }
});

test('候选内容总字符低于 JevFoldMinChars：跳过调用', async () => {
    jevFoldFilter.clearTurnCache();
    const saved = setEnv({ JevFoldFilter: 'true', JevFoldMinChars: 5000 });
    const client = makeClient({}, {});
    try {
        const res = await jevFoldFilter.filterCandidates({
            userContent: '帮我找个文件',
            candidates: [{ description: UNIVERSE[0], content: 'short' }],
            client,
            universe: UNIVERSE
        });
        assert.equal(res.applied, false);
        assert.equal(res.reason, 'below_min_chars');
        assert.equal(client.calls.length, 0);
    } finally {
        restoreEnv(saved);
    }
});

test('按门槛过滤：低概率折叠、高概率保留，droppedIndices 指向正确候选', async () => {
    jevFoldFilter.clearTurnCache();
    const saved = setEnv({ JevFoldFilter: 'true', JevFoldMinChars: 0, JevFoldGate: 0.5 });
    const client = makeClient({ [UNIVERSE[0]]: 0.91, [UNIVERSE[1]]: 0.12, [UNIVERSE[2]]: 0.49 }, {});
    try {
        const cands = [
            { description: UNIVERSE[0], content: 'a'.repeat(700) },
            { description: UNIVERSE[1], content: 'b'.repeat(700) },
            { description: UNIVERSE[2], content: 'c'.repeat(700) }
        ];
        const res = await jevFoldFilter.filterCandidates({
            userContent: '帮我找一下上周下载的那个视频文件',
            candidates: cands,
            client,
            universe: UNIVERSE
        });
        assert.equal(res.applied, true);
        assert.equal(res.reason, 'gate');
        assert.deepEqual(res.droppedIndices, [1, 2]);
        assert.deepEqual(res.probabilities, [0.91, 0.12, 0.49]);
        assert.equal(res.intent, 0.9);
        // 热路径必须收紧超时且禁用重试
        assert.equal(client.calls[0].maxRetries, 0);
        assert.ok(client.calls[0].timeoutMs <= 4000);
        // state 只放用户消息，避免 context rot
        assert.deepEqual(Object.keys(client.calls[0].state), ['user_message']);
    } finally {
        restoreEnv(saved);
    }
});

test('轮级意图过低（纯闲聊）：候选全部折叠', async () => {
    jevFoldFilter.clearTurnCache();
    const saved = setEnv({ JevFoldFilter: 'true', JevFoldMinChars: 0, JevFoldIntentGate: 0.15 });
    const client = makeClient({}, { intent: 0.04, defaultProb: 0.9 });
    try {
        const res = await jevFoldFilter.filterCandidates({
            userContent: '今天心情不太好，有点累',
            candidates: [
                { description: UNIVERSE[0], content: 'a'.repeat(700) },
                { description: UNIVERSE[1], content: 'b'.repeat(700) }
            ],
            client,
            universe: UNIVERSE
        });
        assert.equal(res.applied, true);
        assert.equal(res.reason, 'low_intent');
        assert.deepEqual(res.droppedIndices, [0, 1]);
    } finally {
        restoreEnv(saved);
    }
});

test('Jev 请求失败：applied=false，候选一个都不动', async () => {
    jevFoldFilter.clearTurnCache();
    const saved = setEnv({ JevFoldFilter: 'true', JevFoldMinChars: 0 });
    const client = makeClient({}, { fail: true, failCode: 'ETIMEDOUT', failMessage: 'timeout' });
    try {
        const res = await jevFoldFilter.filterCandidates({
            userContent: '帮我找个文件',
            candidates: [{ description: UNIVERSE[0], content: 'a'.repeat(2000) }],
            client,
            universe: UNIVERSE
        });
        assert.equal(res.applied, false);
        assert.match(res.reason, /^jev_error:/);
        assert.equal(res.droppedIndices, undefined);
    } finally {
        restoreEnv(saved);
    }
});

test('响应缺少 answers：视为失败并回退', async () => {
    jevFoldFilter.clearTurnCache();
    const saved = setEnv({ JevFoldFilter: 'true', JevFoldMinChars: 0 });
    const client = makeClient({}, { emptyAnswers: true });
    try {
        const res = await jevFoldFilter.filterCandidates({
            userContent: '帮我找个文件',
            candidates: [{ description: UNIVERSE[0], content: 'a'.repeat(2000) }],
            client,
            universe: UNIVERSE
        });
        assert.equal(res.applied, false);
        assert.match(res.reason, /^jev_error:/);
    } finally {
        restoreEnv(saved);
    }
});

test('未配置 API Key：不调用，直接回退', async () => {
    jevFoldFilter.clearTurnCache();
    const saved = setEnv({ JevFoldFilter: 'true', JevFoldMinChars: 0 });
    const client = makeClient({}, { configured: false });
    try {
        const res = await jevFoldFilter.filterCandidates({
            userContent: '帮我找个文件',
            candidates: [{ description: UNIVERSE[0], content: 'a'.repeat(2000) }],
            client,
            universe: UNIVERSE
        });
        assert.equal(res.applied, false);
        assert.equal(res.reason, 'jev_not_configured');
        assert.equal(client.calls.length, 0);
    } finally {
        restoreEnv(saved);
    }
});

test('每轮记忆化：7 个占位符共用一次 Jev 请求', async () => {
    jevFoldFilter.clearTurnCache();
    const saved = setEnv({ JevFoldFilter: 'true', JevFoldMinChars: 0, JevFoldGate: 0.5 });
    const client = makeClient({ [UNIVERSE[0]]: 0.91 }, { defaultProb: 0.1 });
    try {
        const userContent = '同一条用户消息';
        let firstApplied = null;
        for (let i = 0; i < 7; i++) {
            const res = await jevFoldFilter.filterCandidates({
                userContent,
                candidates: [{ description: UNIVERSE[i % UNIVERSE.length], content: 'z'.repeat(2000) }],
                client,
                universe: UNIVERSE
            });
            assert.equal(res.applied, true);
            if (i === 0) firstApplied = res;
        }
        assert.equal(client.calls.length, 1, '同一轮内只应发出一次请求');
        assert.equal(firstApplied.cached, false);
    } finally {
        restoreEnv(saved);
    }
});

test('不同用户消息各自发一次请求', async () => {
    jevFoldFilter.clearTurnCache();
    const saved = setEnv({ JevFoldFilter: 'true', JevFoldMinChars: 0 });
    const client = makeClient({}, { defaultProb: 0.9 });
    try {
        for (const msg of ['消息一', '消息二']) {
            await jevFoldFilter.filterCandidates({
                userContent: msg,
                candidates: [{ description: UNIVERSE[0], content: 'z'.repeat(2000) }],
                client,
                universe: UNIVERSE
            });
        }
        assert.equal(client.calls.length, 2);
    } finally {
        restoreEnv(saved);
    }
});

test('不在提问集内的描述：保守保留，不折叠', async () => {
    jevFoldFilter.clearTurnCache();
    const saved = setEnv({ JevFoldFilter: 'true', JevFoldMinChars: 0, JevFoldGate: 0.5 });
    // universe 只含 A；候选里有一个 desc 不属于任何提问集（模拟异常/被截断的描述）
    const client = makeClient({ [UNIVERSE[0]]: 0.02 }, { defaultProb: 0.02 });
    try {
        const res = await jevFoldFilter.filterCandidates({
            userContent: '帮我找个文件',
            candidates: [
                { description: UNIVERSE[0], content: 'a'.repeat(1000) },
                { description: '', content: 'legacy 区块不该被问' .repeat(60) }
            ],
            client,
            universe: [UNIVERSE[0]]
        });
        assert.equal(res.applied, true);
        // 第 0 个概率 0.02 < 0.5 被折叠；第 1 个无 desc → 无概率 → 保留
        assert.deepEqual(res.droppedIndices, [0]);
        assert.equal(res.probabilities[1], null);
    } finally {
        restoreEnv(saved);
    }
});
