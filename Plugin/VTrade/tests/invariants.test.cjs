'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { TradeService } = require('../core/service.cjs');
const { normalizeDataset } = require('../core/data.cjs');

function dataset(symbol = 'TEST-A', price = 1001) {
    return { schemaVersion: 1, source: { kind: 'user', name: 'Synthetic invariant fixture',
        adjustment: 'none', currency: 'CNY', timezone: 'Asia/Shanghai', volumeUnit: 'shares' },
    securities: [{ symbol, bars: Array.from({ length: 8 }, (_, i) => ({ date: `2025-01-${String(6 + i).padStart(2, '0')}`,
        openCents: price, closeCents: price, highCents: price + 1, lowCents: price,
        volume: 10000 })) }] };
}
async function setup(t, data = dataset()) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vtrade-invariant-'));
    let service = await new TradeService(directory).initialize();
    t.after(async () => {
        await service.close();
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
        await fs.rm(directory, { recursive: true, force: true });
    });
    const imported = await service.importDataset(data);
    let o = (await service.command({ command: 'CreateSession', requestId: 'create-invariant',
        datasetId: imported.datasetId, startDate: '2025-01-06' })).observation;
    return { directory, imported, get service() { return service; }, get o() { return o; },
        async write(command, extra = {}) {
            const result = await service.command({ command, sessionId: o.sessionId,
                expectedRevision: o.revision, observationId: o.observationId, requestId: randomUUID(), ...extra });
            o = result.observation; return result;
        },
        async read() { return (await service.command({ command: 'GetObservation', sessionId: o.sessionId })).observation; },
        async reopen() { await service.close(); service = await new TradeService(directory).initialize(); } };
}

test('valid symbols that share Object prototype names can buy and sell', async t => {
    for (const symbol of ['toString', 'valueOf', 'hasOwnProperty']) {
        const x = await setup(t, dataset(symbol));
        await x.write('SubmitOrder', { symbol, side: 'buy', quantity: 100 });
        await x.write('AdvanceDay');
        assert.equal(x.o.account.positions[0].quantity, 100);
        await x.write('SubmitOrder', { symbol, side: 'sell', quantity: 100 });
        await x.write('AdvanceDay');
        assert.equal(x.o.account.positions.length, 0);
    }
});
test('partial reductions allocate every cent and conserve cash through restart', async t => {
    const x = await setup(t);
    await x.write('SubmitOrder', { symbol: 'TEST-A', side: 'buy', quantity: 300 });
    await x.write('AdvanceDay');
    assert.equal(x.o.account.positions[0].costCents, 300700);
    await x.write('SubmitOrder', { symbol: 'TEST-A', side: 'sell', quantity: 100 });
    await x.write('AdvanceDay');
    assert.equal(x.o.account.positions[0].costCents, 200467);
    assert.equal(x.o.account.realizedCents, -333);
    const before = x.o;
    await x.reopen(); assert.deepEqual(await x.read(), before);
    await x.write('SubmitOrder', { symbol: 'TEST-A', side: 'sell', quantity: 200 });
    await x.write('AdvanceDay');
    assert.equal(x.o.account.positions.length, 0);
    assert.equal(x.o.account.cashCents, 9999100);
    assert.equal(x.o.account.realizedCents, -900);
    assert.equal(x.o.journal.filter(e => e.kind === 'virtual-fill').length, 3);
});
test('API results cannot mutate the immutable market snapshot', async t => {
    const x = await setup(t);
    x.o.quotes[0].bars[0].closeCents = 999999;
    x.o.source.name = 'Changed by a caller';
    x.imported.source.name = 'Changed import result';
    const sources = await x.service.command({ command: 'GetSources' });
    sources.sources.find(s => s.datasetId === x.imported.datasetId).source.name = 'Changed source result';
    const o = await x.read();
    assert.equal(o.quotes[0].bars[0].closeCents, 1001);
    assert.equal(o.source.name, 'Synthetic invariant fixture');
});
test('invalid suspension flags and inconsistent price limits fail data validation', () => {
    for (const change of [d => { d.securities[0].bars[0].suspended = 'true'; },
        d => { d.securities[0].bars[0].limitUpCents = 900; },
        d => { d.securities[0].bars[0].limitDownCents = 1100; }]) {
        const data = dataset(); change(data);
        assert.throws(() => normalizeDataset(data), { code: 'INVALID_DATA' });
    }
});
test('sub-cent sell reference is unfilled, never a zero-price virtual fill', async t => {
    const x = await setup(t, dataset('TEST-A', 1));
    await x.write('SubmitOrder', { symbol: 'TEST-A', side: 'buy', quantity: 100, limitPriceCents: 2 });
    await x.write('AdvanceDay');
    await x.write('SubmitOrder', { symbol: 'TEST-A', side: 'sell', quantity: 100 });
    await x.write('AdvanceDay');
    assert.equal(x.o.orders[1].status, 'unfilled');
    assert.equal(x.o.account.positions[0].quantity, 100);
    assert.equal(x.o.account.cashCents, 9999700);
});
test('structurally valid JSON with a broken ledger is rejected and preserved', async t => {
    for (const corrupt of [s => { s.holdings = null; }, s => { s.cashCents = -1; },
        s => { s.symbols = []; }, s => { s.receipts = []; },
        s => { s.realizedCents = Number.MAX_SAFE_INTEGER + 1; }]) {
        const x = await setup(t);
        const file = x.service.store.file(x.o.sessionId);
        const saved = JSON.parse(await fs.readFile(file, 'utf8')); corrupt(saved);
        const bytes = JSON.stringify(saved); await fs.writeFile(file, bytes);
        await assert.rejects(x.read(), { code: 'CORRUPT_SAVE' });
        assert.equal(await fs.readFile(file, 'utf8'), bytes);
    }
});

test('all journal events are accessible after observation truncates its recent history', async t => {
    const x = await setup(t);
    for (let i = 0; i < 104; i++) await x.write('SaveReview', { note: `Synthetic review ${i}` });
    assert.equal(x.o.journal.length, 100);
    const events = [];
    let afterEventId;
    do {
        const { journal } = await x.service.command({ command: 'GetJournal', sessionId: x.o.sessionId,
            limit: 40, ...(afterEventId ? { afterEventId } : {}) });
        events.push(...journal.events);
        if (!journal.hasMore) break;
        afterEventId = journal.nextAfterEventId;
    } while (true);
    assert.equal(events.length, 104);
    assert.deepEqual(events.map(e => e.id), Array.from({ length: 104 }, (_, i) => `event-${i + 1}`));
    await assert.rejects(x.service.command({ command: 'GetJournal', sessionId: x.o.sessionId,
        afterEventId: 'event-105' }), { code: 'INVALID_ARGUMENT' });
});

test('shutdown drains queued imports before releasing writer ownership', async t => {
    const x = await setup(t);
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const held = x.service.store.serial('datasets', () => new Promise(resolve => { release = resolve; entered(); }));
    await started;
    const data = dataset('TEST-SECOND');
    const imported = x.service.importDataset(data);
    const closing = x.service.close();
    try {
        await fs.access(path.join(x.directory, 'writer.lock'));
        await assert.rejects(x.service.importDataset(data), { code: 'CLOSED' });
    } finally { release(); await held; await closing; }
    const receipt = await imported;
    await x.reopen();
    const sources = await x.service.command({ command: 'GetSources' });
    assert.ok(sources.sources.some(s => s.datasetId === receipt.datasetId));
});
