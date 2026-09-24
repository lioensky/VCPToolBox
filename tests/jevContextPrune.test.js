'use strict';

/**
 * 上下文剪枝 Jev 化的离线测试（stub 客户端，不发网络）
 * 覆盖：contextManager.pruneMessagesSmart 的策略 + modules/jevContextPruner.js 的边界
 * 运行：node tests/jevContextPrune.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const contextManager = require(path.join(__dirname, '..', 'modules', 'contextManager.js'));

const ENV_KEYS = [
    'JevContextPrune', 'JevContextPruneChunk', 'JevContextPruneMaxChunks',
    'JevContextPruneChars', 'JevContextPruneTimeoutMs'
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

/** 按"消息正文里包含哪个关键词"决定概率的 stub */
function makeClient(probByText = {}, opts = {}) {
    const calls = [];
    return {
        calls,
        isConfigured: () => opts.configured !== false,
        decide: async (state, questions, options) => {
            calls.push({ state, questionCount: Object.keys(questions).length, options });
            if (opts.fail) {
                const err = new Error(opts.failMessage || 'boom');
                err.code = opts.failCode || 'JEV_REQUEST_FAILED';
                throw err;
            }
            const answers = {};
            for (const qid of Object.keys(questions)) {
                if (opts.skipQids && opts.skipQids(state, qid)) continue; // 模拟该题缺分数
                const i = Number(qid.slice(2));
                const text = (state.messages[i] && state.messages[i].text) || '';
                let prob = opts.defaultProb === undefined ? 0.5 : opts.defaultProb;
                for (const [kw, p] of Object.entries(probByText)) {
                    if (text.includes(kw)) { prob = p; break; }
                }
                answers[qid] = { type: 'noul', noul: prob };
            }
            return { model: 'jev-test', answers, usage: { input_tokens: 50, output_tokens: 5 } };
        }
    };
}

// 一条"老但关键"的任务定义 + 若干闲聊；索引 0 是 system，最后两条不可删
function makeMessages() {
    return [
        { role: 'system', content: '你是助手' },                                                  // 0 不可删
        { role: 'user', content: '任务定义：重构登录模块，约束是不能改数据库 schema' },              // 1 老但关键
        { role: 'assistant', content: '收到' },                                                     // 2
        { role: 'user', content: '今天天气不错啊' },                                                 // 3 闲聊
        { role: 'assistant', content: '是的呢' },                                                    // 4
        { role: 'user', content: '顺便讲个笑话吧' },                                                 // 5 闲聊
        { role: 'assistant', content: '哈哈' },                                                      // 6
        { role: 'user', content: '现在继续' },                                                       // 7 不可删(倒数第二)
        { role: 'user', content: '最后一条消息' }                                                    // 8 不可删(最后)
    ];
}

const PROB_BY_TEXT = {
    '任务定义': 0.95,
    '天气': 0.02,
    '笑话': 0.03,
    '收到': 0.10,
    '是的呢': 0.10,
    '哈哈': 0.10
};

test('默认关闭：与位置规则完全一致（会删掉最老的关键消息）', async () => {
    const saved = setEnv({});
    try {
        const msgs = makeMessages();
        const limit = contextManager.estimateTokens(msgs) - 1; // 逼它删且只删一条
        const smart = await contextManager.pruneMessagesSmart(msgs, limit, false, { client: makeClient(PROB_BY_TEXT) });
        const positional = contextManager.pruneMessages(msgs, limit);
        assert.deepEqual(smart, positional);
        // 位置规则删的是索引 1——那条任务定义，这正是要修的缺陷
        assert.ok(!smart.some(m => String(m.content).includes('任务定义')), '位置规则应当删掉最老的任务定义');
    } finally {
        restoreEnv(saved);
    }
});

test('开启后按"最没用"删：保住老的任务定义，删掉闲聊', async () => {
    const saved = setEnv({ JevContextPrune: 'true' });
    const client = makeClient(PROB_BY_TEXT);
    try {
        const msgs = makeMessages();
        const limit = contextManager.estimateTokens(msgs) - 1;
        const out = await contextManager.pruneMessagesSmart(msgs, limit, false, { client });
        assert.equal(out.length, msgs.length - 1, '只应删一条');
        assert.ok(out.some(m => String(m.content).includes('任务定义')), '关键的老消息必须保住');
        assert.ok(!out.some(m => String(m.content).includes('今天天气不错啊')), '应先删概率最低的闲聊');
        assert.equal(client.calls.length, 1);
        // 热路径必须禁重试、超时收紧、state 只带参照系与消息
        assert.equal(client.calls[0].options.maxRetries, 0);
        assert.deepEqual(Object.keys(client.calls[0].state).sort(), ['current_request', 'messages']);
        assert.equal(client.calls[0].state.current_request, '最后一条消息');
    } finally {
        restoreEnv(saved);
    }
});

test('不变量：system 与最后两条即使打 0 分也绝不被删', async () => {
    const saved = setEnv({ JevContextPrune: 'true' });
    const client = makeClient({}, { defaultProb: 0 });
    try {
        const msgs = makeMessages();
        const limit = contextManager.estimateTokens(msgs) - 1;
        const out = await contextManager.pruneMessagesSmart(msgs, limit, false, { client });
        assert.ok(out.some(m => m.role === 'system'), 'system 必须在');
        assert.equal(out[out.length - 1].content, '最后一条消息');
        assert.equal(out[out.length - 2].content, '现在继续');
    } finally {
        restoreEnv(saved);
    }
});

test('预算满足即停止，不多删', async () => {
    const saved = setEnv({ JevContextPrune: 'true' });
    const client = makeClient(PROB_BY_TEXT);
    try {
        const msgs = makeMessages();
        const total = contextManager.estimateTokens(msgs);
        const out = await contextManager.pruneMessagesSmart(msgs, total - 1, false, { client });
        assert.equal(out.length, msgs.length - 1);
        assert.ok(contextManager.estimateTokens(out) <= total - 1);
    } finally {
        restoreEnv(saved);
    }
});

test('未超预算：原样返回且一次请求都不发', async () => {
    const saved = setEnv({ JevContextPrune: 'true' });
    const client = makeClient(PROB_BY_TEXT);
    try {
        const msgs = makeMessages();
        const out = await contextManager.pruneMessagesSmart(msgs, 999999, false, { client });
        assert.equal(out.length, msgs.length);
        assert.equal(client.calls.length, 0);
    } finally {
        restoreEnv(saved);
    }
});

test('Jev 请求失败：回退位置规则，结果与 pruneMessages 一致', async () => {
    const saved = setEnv({ JevContextPrune: 'true' });
    const client = makeClient({}, { fail: true, failCode: 'ETIMEDOUT' });
    try {
        const msgs = makeMessages();
        const limit = contextManager.estimateTokens(msgs) - 1;
        const out = await contextManager.pruneMessagesSmart(msgs, limit, false, { client });
        assert.deepEqual(out, contextManager.pruneMessages(msgs, limit));
    } finally {
        restoreEnv(saved);
    }
});

test('未配置 API Key：不发请求，回退位置规则', async () => {
    const saved = setEnv({ JevContextPrune: 'true' });
    const client = makeClient(PROB_BY_TEXT, { configured: false });
    try {
        const msgs = makeMessages();
        const limit = contextManager.estimateTokens(msgs) - 1;
        const out = await contextManager.pruneMessagesSmart(msgs, limit, false, { client });
        assert.equal(client.calls.length, 0);
        assert.deepEqual(out, contextManager.pruneMessages(msgs, limit));
    } finally {
        restoreEnv(saved);
    }
});

test('消息数超过 chunk*maxChunks：不打分，回退位置规则', async () => {
    const saved = setEnv({ JevContextPrune: 'true', JevContextPruneChunk: 1, JevContextPruneMaxChunks: 2 });
    const client = makeClient(PROB_BY_TEXT);
    try {
        const msgs = makeMessages(); // 可删 6 条 > 1*2
        const limit = contextManager.estimateTokens(msgs) - 1;
        const out = await contextManager.pruneMessagesSmart(msgs, limit, false, { client });
        assert.equal(client.calls.length, 0);
        assert.deepEqual(out, contextManager.pruneMessages(msgs, limit));
    } finally {
        restoreEnv(saved);
    }
});

test('分块并发：可删消息超过单块容量时按块发多次请求，且全部打到分', async () => {
    const saved = setEnv({ JevContextPrune: 'true', JevContextPruneChunk: 2, JevContextPruneMaxChunks: 4 });
    const client = makeClient(PROB_BY_TEXT);
    try {
        const msgs = makeMessages(); // 可删 6 条 → 3 块
        const limit = contextManager.estimateTokens(msgs) - 1;
        const out = await contextManager.pruneMessagesSmart(msgs, limit, false, { client });
        assert.equal(client.calls.length, 3);
        assert.ok(out.some(m => String(m.content).includes('任务定义')));
    } finally {
        restoreEnv(saved);
    }
});

test('缺分数的消息按"保留"处理：优先删有低分的', async () => {
    const saved = setEnv({ JevContextPrune: 'true' });
    // 让"任务定义"那条拿不到分数（视为未知→保留），闲聊仍拿低分
    const client = makeClient(PROB_BY_TEXT, {
        skipQids: (state, qid) => {
            const i = Number(qid.slice(2));
            const text = (state.messages[i] && state.messages[i].text) || '';
            return text.includes('任务定义');
        }
    });
    try {
        const msgs = makeMessages();
        const limit = contextManager.estimateTokens(msgs) - 1;
        const out = await contextManager.pruneMessagesSmart(msgs, limit, false, { client });
        assert.ok(out.some(m => String(m.content).includes('任务定义')), '未打分的消息必须保留');
        assert.ok(!out.some(m => String(m.content).includes('今天天气不错啊')));
    } finally {
        restoreEnv(saved);
    }
});
