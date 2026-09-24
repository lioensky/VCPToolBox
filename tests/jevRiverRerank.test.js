'use strict';

/**
 * river semantic:N 的 Jev 重排离线测试（stub 客户端，不发网络）
 * 运行：node tests/jevRiverRerank.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const reranker = require(path.join(__dirname, '..', 'modules', 'jevRiverReranker.js'));

const ENV_KEYS = ['JevRiverRerank', 'JevRiverK', 'JevRiverMargin', 'JevRiverChars', 'JevRiverTimeoutMs'];

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

function makeClient(probByText = {}, opts = {}) {
    const calls = [];
    return {
        calls,
        isConfigured: () => opts.configured !== false,
        decide: async (state, questions, options) => {
            calls.push({ state, questionCount: Object.keys(questions).length, options });
            if (opts.fail) {
                const err = new Error('boom');
                err.code = opts.failCode || 'JEV_REQUEST_FAILED';
                throw err;
            }
            const answers = {};
            for (const qid of Object.keys(questions)) {
                if (opts.skipQids && opts.skipQids(state, qid)) continue;
                const i = Number(qid.slice(2));
                const text = (state.messages[i] && state.messages[i].text) || '';
                let prob = opts.defaultProb === undefined ? 0.5 : opts.defaultProb;
                for (const [kw, p] of Object.entries(probByText)) {
                    if (text.includes(kw)) { prob = p; break; }
                }
                answers[qid] = { type: 'noul', noul: prob };
            }
            return { model: 'jev-test', answers, usage: { input_tokens: 40, output_tokens: 4 } };
        }
    };
}

// embedding 已按 score 降序；但排在前面的是"词汇重合却没用"的消息
function makeItems() {
    return [
        { index: 4, role: 'user', text: '无关的闲聊：今天吃了什么', score: 0.91 },
        { index: 2, role: 'assistant', text: '无关的客套话', score: 0.85 },
        { index: 7, role: 'user', text: '部署步骤：先停服再合并', score: 0.70 },
        { index: 1, role: 'assistant', text: '部署注意事项：合并前要跑测试', score: 0.62 },
        { index: 9, role: 'user', text: '完全跑题的内容', score: 0.55 }
    ];
}

const PROB = {
    '部署步骤': 0.93,
    '部署注意事项': 0.81,
    '无关的闲聊': 0.04,
    '无关的客套话': 0.05,
    '完全跑题': 0.02
};

test('默认关闭：applied=false，不发请求', async () => {
    const saved = setEnv({});
    const client = makeClient(PROB);
    try {
        const res = await reranker.rerankTopN({ queryText: '部署服务', items: makeItems(), n: 2, client });
        assert.equal(res.applied, false);
        assert.equal(res.reason, 'disabled');
        assert.equal(client.calls.length, 0);
    } finally {
        restoreEnv(saved);
    }
});

test('候选数不超过 N：无需重排，不发请求', async () => {
    const saved = setEnv({ JevRiverRerank: 'true' });
    const client = makeClient(PROB);
    try {
        const res = await reranker.rerankTopN({ queryText: '部署服务', items: makeItems().slice(0, 2), n: 2, client });
        assert.equal(res.applied, false);
        assert.equal(res.reason, 'no_need');
        assert.equal(client.calls.length, 0);
    } finally {
        restoreEnv(saved);
    }
});

test('重排改变选择：embedding 的高分无关项被换成语义真正相关的', async () => {
    const saved = setEnv({ JevRiverRerank: 'true' });
    const client = makeClient(PROB);
    try {
        const items = makeItems();
        const res = await reranker.rerankTopN({ queryText: '部署服务', items, n: 2, client });
        assert.equal(res.applied, true);
        assert.equal(res.selected.length, 2);
        const texts = res.selected.map(x => x.text);
        assert.ok(texts.some(t => t.includes('部署步骤')), '应选中部署步骤');
        assert.ok(texts.some(t => t.includes('部署注意事项')), '应选中部署注意事项');
        assert.ok(!texts.some(t => t.includes('无关的闲聊')), '不应选中 embedding 排第一的无关项');
        // 对照：embedding 原序的 Top-2 恰好是两条无关项
        const embeddingTop2 = items.slice(0, 2).map(x => x.text);
        assert.ok(embeddingTop2.every(t => t.startsWith('无关')), 'embedding 原序前二确实都是无关项');
        // 热路径禁重试
        assert.equal(client.calls[0].options.maxRetries, 0);
        // state 只带任务与候选消息
        assert.deepEqual(Object.keys(client.calls[0].state).sort(), ['messages', 'task']);
        assert.equal(client.calls[0].state.task, '部署服务');
    } finally {
        restoreEnv(saved);
    }
});

test('K 的计算：K = min(候选数, max(N*倍率, N+余量))', async () => {
    const saved = setEnv({ JevRiverRerank: 'true', JevRiverK: 3, JevRiverMargin: 8 });
    const client = makeClient({}, { defaultProb: 0.5 });
    try {
        const items = Array.from({ length: 20 }, (_, i) => ({ index: i, role: 'user', text: '消息' + i, score: 1 - i * 0.01 }));
        const res = await reranker.rerankTopN({ queryText: 'q', items, n: 2, client });
        assert.equal(res.applied, true);
        // max(2*3, 2+8) = 10，候选 20 → K=10
        assert.equal(res.k, 10);
        assert.equal(client.calls[0].questionCount, 10);
        assert.equal(res.selected.length, 2);
    } finally {
        restoreEnv(saved);
    }
});

test('请求失败：applied=false，调用方据此保留 embedding 的 Top-N', async () => {
    const saved = setEnv({ JevRiverRerank: 'true' });
    const client = makeClient({}, { fail: true, failCode: 'ETIMEDOUT' });
    try {
        const res = await reranker.rerankTopN({ queryText: '部署服务', items: makeItems(), n: 2, client });
        assert.equal(res.applied, false);
        assert.match(res.reason, /^jev_error:/);
        assert.equal(res.selected, undefined);
    } finally {
        restoreEnv(saved);
    }
});

test('未配置 API Key：不发请求', async () => {
    const saved = setEnv({ JevRiverRerank: 'true' });
    const client = makeClient(PROB, { configured: false });
    try {
        const res = await reranker.rerankTopN({ queryText: '部署服务', items: makeItems(), n: 2, client });
        assert.equal(res.applied, false);
        assert.equal(res.reason, 'jev_not_configured');
        assert.equal(client.calls.length, 0);
    } finally {
        restoreEnv(saved);
    }
});

test('缺分数的候选排到最后但不丢：仍有名额时按 embedding 序补位', async () => {
    const saved = setEnv({ JevRiverRerank: 'true' });
    // 两条"部署"消息拿不到分数，其余正常
    const client = makeClient(PROB, {
        skipQids: (state, qid) => {
            const i = Number(qid.slice(2));
            const text = (state.messages[i] && state.messages[i].text) || '';
            return text.includes('部署');
        }
    });
    try {
        // n=4：三条有分数的（都是无关项）占前三，第四名由缺分数的按 embedding 序补上
        const res = await reranker.rerankTopN({ queryText: '部署服务', items: makeItems(), n: 4, client });
        assert.equal(res.applied, true);
        assert.equal(res.selected.length, 4);
        assert.equal(res.scored, 3, '只有 3 条拿到分数');
        assert.ok(res.selected.some(x => x.text.includes('部署步骤')), '缺分数的应按 embedding 序补进来');
        assert.equal(res.selected[3].text.includes('部署步骤'), true, '补位发生在最后一名');
    } finally {
        restoreEnv(saved);
    }
});

test('消息正文按 JevRiverChars 截断后进 state（且有 40 字下限）', async () => {
    const saved = setEnv({ JevRiverRerank: 'true', JevRiverChars: 45 });
    const client = makeClient({}, { defaultProb: 0.5 });
    try {
        const items = [
            { index: 0, role: 'user', text: 'x'.repeat(500), score: 0.9 },
            { index: 1, role: 'user', text: 'y'.repeat(500), score: 0.8 },
            { index: 2, role: 'user', text: 'z'.repeat(500), score: 0.7 }
        ];
        const res = await reranker.rerankTopN({ queryText: 'q'.repeat(2000), items, n: 1, client });
        assert.equal(res.applied, true);
        assert.equal(client.calls[0].state.messages[0].text.length, 45);
        assert.equal(client.calls[0].state.task.length, 600, 'task 有独立上限');
    } finally {
        restoreEnv(saved);
    }
});

test('JevRiverChars 低于下限时被钳到 40，不会被配成荒谬的小值', async () => {
    const saved = setEnv({ JevRiverRerank: 'true', JevRiverChars: 5 });
    try {
        assert.equal(reranker.getConfig().maxMessageChars, 40);
    } finally {
        restoreEnv(saved);
    }
});
