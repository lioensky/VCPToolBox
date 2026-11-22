'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { once } = require('node:events');
const express = require('express');
const { mountMemorySearch } = require('../routes/memorySearch');

const token = randomBytes(32).toString('hex');
const hash = createHash('sha256').update(token).digest('hex');
const grants = JSON.stringify({ [hash]: ['notes', 'other'] });

test('opt-in only; invalid policy and reuse of the server key are rejected at startup', () => {
    const app = { post: () => assert.fail('route should not be mounted') };
    for (const empty of [undefined, '', '{}']) mountMemorySearch(app, { grants: empty });
    for (const invalid of ['[]', '{"raw-token":["notes"]}', JSON.stringify({ [hash]: [] })]) {
        assert.throws(() => mountMemorySearch(app, { grants: invalid }), /Invalid MEMORY_READ_GRANTS/);
    }
    assert.throws(() => mountMemorySearch(app, { grants, serverKey: token }), /Invalid MEMORY_READ_GRANTS/);
});

test('scoped RiverMemo HTTP search', async t => {
    const app = express();
    app.use(express.json());
    const calls = [];
    let bridge = {
        embedText: async text => { calls.push(text); return [1]; },
        retrieveDiary: async options => {
            calls.push(options);
            return { results: [
                { diaryName: 'notes', sourceFile: 'folder/note.md', text: 'fixture', score: 0.8, vector: [1] },
                { diaryName: 'other', text: 'authorized but not requested' },
                { diaryName: 'outside', text: 'out of scope' }
            ] };
        }
    };
    mountMemorySearch(app, { grants, getBridge() { calls.push('bridge'); return bridge; } });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const post = (body, credential = token) => fetch(`http://127.0.0.1:${server.address().port}/v1/memory/search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + credential }, body: JSON.stringify(body)
    });
    const query = { query: 'fixture', diaries: ['notes', 'notes'], k: 3 };
    assert.equal((await post(query, 'not-the-read-token')).status, 401);
    assert.equal((await post({ ...query, diaries: ['notes', 'outside'] })).status, 403);
    for (const malformed of [{ ...query, diaries: [] }, { ...query, k: 0 }, { ...query, query: ' ' }]) {
        assert.equal((await post(malformed)).status, 400);
    }
    assert.deepEqual(calls, []);
    const res = await post(query);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { direct: [{ diary: 'notes', file: 'note.md', text: 'fixture', score: 0.8, scoreSource: 'retrieval' }] });
    assert.deepEqual(calls, ['bridge', 'fixture', { diaryNames: ['notes'], queryText: 'fixture', queryVector: [1], k: 3, engine: 'rivermemo', fallback: 'none' }]);
    bridge = null;
    assert.equal((await post(query)).status, 503);
});
