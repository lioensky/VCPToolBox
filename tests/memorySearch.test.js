'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { once } = require('node:events');
const express = require('express');
const { mountMemorySearch } = require('../routes/memorySearch');

const token = randomBytes(32).toString('hex');
const hash = createHash('sha256').update(token).digest('hex');
const grants = JSON.stringify({ [hash]: ['notes', 'other', 'star-pool'] });

test('opt-in only; invalid policy and reuse of the server key are rejected at startup', () => {
    const app = { post: () => assert.fail('route should not be mounted') };
    for (const empty of [undefined, '', '{}']) mountMemorySearch(app, { grants: empty });
    for (const invalid of ['[]', '{"raw-token":["notes"]}', JSON.stringify({ [hash]: [] })]) {
        assert.throws(() => mountMemorySearch(app, { grants: invalid }), /Invalid MEMORY_READ_GRANTS/);
    }
    assert.throws(() => mountMemorySearch(app, { grants, serverKey: token }), /Invalid MEMORY_READ_GRANTS/);
    assert.throws(() => mountMemorySearch(app, { grants, ranking: 'client-side-choice' }), /Invalid MEMORY_SEARCH_RANKING/);
    for (const valid of [undefined, '', 'river', 'jev', 'rerank']) {
        assert.doesNotThrow(() => mountMemorySearch({ post: () => {} }, { grants, ranking: valid }));
    }
});

async function serve(t, bridge, options = {}) {
    const app = express();
    app.use(express.json());
    mountMemorySearch(app, { grants, getBridge: () => bridge, ...options });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    return (body, credential = token) => fetch(`http://127.0.0.1:${server.address().port}/v1/memory/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + credential },
        body: JSON.stringify(body)
    });
}

function fakeBridge(result = { direct: [] }) {
    return {
        calls: [],
        async recallMemory(options) {
            this.calls.push(options);
            return typeof result === 'function' ? result(options) : result;
        },
        resolveStarPoolDiaries(pool) {
            return pool ? pool.split('|').map(s => s.trim()).filter(Boolean) : ['star-pool'];
        }
    };
}

const query = { query: 'what did we decide?', diaries: ['notes'], k: 5 };

test('authentication, scope and shape validation run before any bridge lookup', async t => {
    const post = await serve(t, null, { getBridge: null });
    // re-mount with a counting bridge lookup
    const counting = fakeBridge();
    const post2 = await serve(t, counting);
    assert.equal((await post2(query, 'wrong-token')).status, 401);
    assert.equal((await post2({ ...query, diaries: ['notes', 'outside'] })).status, 403);
    for (const malformed of [
        { ...query, diaries: [] },
        { ...query, k: 0 },
        { ...query, k: 101 },
        { ...query, k: 2.5 },
        { ...query, query: ' ' },
        { ...query, associate: 'yes' },
        { ...query, modifiers: '::Expand' },     // unknown key rejected
        { ...query, engine: 'knn' },             // clients never pick the backend
        { ...query, coreTags: 'not-an-array' },
        { ...query, coreTags: [''] },
        { ...query, conversation: 'nope' },
        { ...query, conversation: [] },
        { ...query, conversation: [{ role: 'user', content: query.query, extra: 1 }] },
        { ...query, metaThinking: { pool: 42 } },
        { ...query, metaThinking: { group: 'yes' } }
    ]) {
        assert.equal((await post2(malformed)).status, 400, JSON.stringify(malformed));
    }
    assert.equal(counting.calls.length, 0);
    assert.equal((await post(query)).status, 503); // bridge null
});

test('minimal request stays backward compatible and forwards structured response', async t => {
    const payload = { direct: [{ rank: 1, diary: 'notes', file: 'note.md', text: 'fixture', score: 0.8, scoreSource: 'retrieval' }] };
    const bridge = fakeBridge(payload);
    const post = await serve(t, bridge);
    const res = await post(query);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), payload);
    assert.equal(bridge.calls.length, 1);
    const call = bridge.calls[0];
    assert.equal(call.query, query.query);
    assert.deepEqual(call.diaries, ['notes']);
    assert.equal(call.k, 5);
    assert.equal(call.associate, false);
    assert.equal(call.rankModifiers, '');
    assert.equal(call.metaThinking, null);
    assert.equal(call.conversation, undefined);
});

test('diaries are deduplicated and ranking is a server-side policy', async t => {
    const bridge = fakeBridge();
    const post = await serve(t, bridge, { ranking: 'jev' });
    const res = await post({ ...query, diaries: ['notes', 'notes'] });
    assert.equal(res.status, 200);
    assert.deepEqual(bridge.calls[0].diaries, ['notes']);
    assert.equal(bridge.calls[0].rankModifiers, '::Jev');
});

test('conversation must end with the current user message and is passed through', async t => {
    const bridge = fakeBridge();
    const post = await serve(t, bridge);
    const conversation = [
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
        { role: 'user', content: query.query }
    ];
    // last entry must be role user with content identical to query
    assert.equal((await post({ ...query, conversation: conversation.slice(0, 2) })).status, 400);
    assert.equal((await post({ ...query, conversation: [...conversation.slice(0, 2), { role: 'user', content: 'different' }] })).status, 400);
    assert.equal((await post({ ...query, conversation: [...conversation.slice(0, 2), { role: 'assistant', content: query.query }] })).status, 400);
    const res = await post({ ...query, conversation });
    assert.equal(res.status, 200);
    assert.deepEqual(bridge.calls[0].conversation, conversation);
});

test('coreTags and associate are passed through; associated results survive', async t => {
    const payload = {
        direct: [{ rank: 1, diary: 'notes', file: 'a.md', text: 'main', score: 0.9, scoreSource: 'retrieval' }],
        associated: [{ rank: 1, diary: 'notes', file: 'b.md', text: 'co-occurring', score: 0.5, scoreSource: 'retrieval', seedCount: 3 }]
    };
    const bridge = fakeBridge(payload);
    const post = await serve(t, bridge);
    const res = await post({ ...query, coreTags: ['返身性闭环'], associate: true });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), payload);
    assert.deepEqual(bridge.calls[0].coreTags, ['返身性闭环']);
    assert.equal(bridge.calls[0].associate, true);
});

test('metaThinking pool scope is enforced before retrieval; out-of-scope pool is 403', async t => {
    const payload = { direct: [], metaFormula: '$$formula$$' };
    const bridge = fakeBridge(payload);
    const post = await serve(t, bridge);
    // default pool resolves to 'star-pool', which is in scope
    const ok = await post({ ...query, metaThinking: true });
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).metaFormula, '$$formula$$');
    assert.deepEqual(bridge.calls[0].metaThinking, { pool: undefined, group: false });
    // explicit in-scope pool with group flag
    const ok2 = await post({ ...query, metaThinking: { pool: 'notes|star-pool', group: true } });
    assert.equal(ok2.status, 200);
    assert.deepEqual(bridge.calls[1].metaThinking, { pool: 'notes|star-pool', group: true });
    // out-of-scope pool is rejected before any bridge call
    const before = bridge.calls.length;
    assert.equal((await post({ ...query, metaThinking: { pool: 'star-pool|secret-pool' } })).status, 403);
    assert.equal(bridge.calls.length, before);
});

test('bridge without recallMemory is a clean 503, exceptions stay generic', async t => {
    const legacy = { embedText: async () => [1], retrieveDiary: async () => ({ results: [] }) };
    const post = await serve(t, legacy);
    assert.equal((await post(query)).status, 503);
    const throwing = fakeBridge();
    throwing.recallMemory = async () => { throw new Error('sensitive internals'); };
    const post2 = await serve(t, throwing);
    const res = await post2(query);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'Memory search unavailable' });
});

test('disabled when no grants configured', async t => {
    const app = express();
    app.use(express.json());
    mountMemorySearch(app, { grants: undefined, getBridge: () => assert.fail() });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/memory/search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(query)
    });
    assert.equal(res.status, 404);
});
