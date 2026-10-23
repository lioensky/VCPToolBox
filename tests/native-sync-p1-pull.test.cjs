'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const express = require('express');
const { CentralStore } = require('../Plugin/NativeSync/sync/centralStore');
const { createSyncHttpService } = require('../Plugin/NativeSync/sync/httpService');
const auth = require('../modules/apiBearerAuth');
const scope = JSON.stringify(['agent', 'allowed-owner', 'topic']);

async function fixture(t, last = true) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-sync-pull-'));
    const store = new CentralStore(path.join(root, 'central.sqlite'));
    const op = (id, ownerId = 'allowed-owner') => ({ ownerType: 'agent', ownerId, topicId: 'topic', msgId: id, deviceId: 'producer', opId: 'put-' + id, action: 'upsert', baseHash: null, message: { id, role: 'user', content: ownerId === 'allowed-owner' ? 'synthetic authorized' : 'DENIED_CONTENT_MARKER', timestamp: 1 } });
    store.apply(op('first'));
    let prior;
    for (let seq = 2; seq <= 150; seq++) {
        if (seq % 2 === 0) { const raw = op('denied-' + seq, 'denied-owner'); prior = { raw, ack: store.apply(raw) }; }
        else store.apply({ ...prior.raw, opId: 'delete-' + seq, action: 'delete', baseHash: prior.ack.hash, message: null });
    }
    if (last) store.apply(op('last'));
    const app = express(), service = createSyncHttpService(store);
    app.use(auth('synthetic-key'));
    // A host-owned grant supplies the same scoped route context as V1.
    app.use((req, _res, next) => { req.nativeSyncTopics = [scope]; next(); });
    app.use('/api/v1/sync', service.handle);
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await service.close(); await fs.rm(root, { recursive: true, force: true }); });
    const request = query => fetch(`http://127.0.0.1:${server.address().port}/api/v1/sync/pull?${query}`, { headers: { Authorization: 'Bearer synthetic-key' } });
    return { store, request };
}

test('scoped pagination crosses an empty scan window and reaches authorized seq151', async t => {
    const { store, request } = await fixture(t);
    const first = await (await request('after_seq=0&limit=1')).json();
    assert.equal(first.events[0].msgId, 'first'); assert.equal(first.nextSeq, 1);
    const response = await request('after_seq=1&limit=100'), raw = await response.text(), empty = JSON.parse(raw);
    assert.equal(response.status, 200); assert.deepEqual(empty.events, []);
    assert.equal(empty.nextSeq, 101); assert.equal(empty.headSeq, 151); assert.equal(empty.hasMore, true);
    assert.equal(/DENIED_CONTENT_MARKER|denied-owner|denied-/.test(raw), false);
    const final = await (await request('after_seq=101&limit=100')).json();
    assert.deepEqual(final.events.map(e => e.msgId), ['last']); assert.equal(final.nextSeq, 151); assert.equal(final.hasMore, false);
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('full terminal and empty terminal pages report the scanned cursor without jumping', async t => {
    const { store, request } = await fixture(t, false);
    const full = store.pull(50, 100); assert.equal(full.events.length, 100); assert.equal(full.nextSeq, 150); assert.equal(full.hasMore, false);
    const filtered = await (await request('after_seq=50&limit=100')).json();
    assert.deepEqual(filtered.events, []); assert.equal(filtered.nextSeq, 150); assert.equal(filtered.hasMore, false);
    const terminal = await (await request('after_seq=150&limit=100')).json();
    assert.deepEqual(terminal.events, []); assert.equal(terminal.nextSeq, 150); assert.equal(terminal.hasMore, false);
});

test('filtering precedes unauthorized payload parsing and invalid cursors fail explicitly', async t => {
    const { store, request } = await fixture(t);
    store.db.prepare("UPDATE journal SET message_json='invalid private payload' WHERE owner_id='denied-owner'").run();
    const page = await (await request('after_seq=1&limit=100')).json(); assert.deepEqual(page.events, []); assert.equal(page.nextSeq, 101);
    for (const query of ['after_seq=-1', 'after_seq=1.5', 'limit=0', 'limit=501', 'after_seq=NaN']) {
        const response = await request(query); assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'INVALID_CURSOR');
    }
    assert.throws(() => store.pull(0, 100, 'invalid'), error => error.code === 'INVALID_TOPIC_SCOPE');
});
