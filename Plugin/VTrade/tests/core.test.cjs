'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { TradeService } = require('../core/service.cjs');
const { demoDataset, workbenchDemoDataset, normalizeDataset, fromTdx } = require('../core/data.cjs');

function fixture() {
    return { schemaVersion: 1, source: { kind: 'user', name: 'Synthetic test fixture', adjustment: 'none',
        currency: 'CNY', timezone: 'Asia/Shanghai', volumeUnit: 'shares' },
    securities: [{ symbol: 'TEST-A', name: 'Test instrument', bars: [
        ['2025-01-03', 1000, 1000], ['2025-01-06', 1010, 1020],
        ['2025-01-07', 1030, 1040], ['2025-01-08', 1040, 1050],
    ].map(([date, openCents, closeCents]) => ({ date, openCents, closeCents,
        lowCents: Math.min(openCents, closeCents) - 10, highCents: Math.max(openCents, closeCents) + 10,
        volume: 10000, limitUpCents: 1200, limitDownCents: 800 })) }] };
}
async function setup(t, data = fixture()) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vtrade-test-'));
    let service = await new TradeService(directory).initialize();
    t.after(async () => {
        await service.close();
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
        await fs.rm(directory, { recursive: true, force: true });
    });
    const imported = await service.importDataset(data);
    let o = (await service.command({ command: 'CreateSession', requestId: 'create-1',
        datasetId: imported.datasetId, startDate: '2025-01-03', rulesProfile: 'a-share-demo' })).observation;
    return { directory, get service() { return service; }, get o() { return o; },
        async read() { o = (await service.command({ command: 'GetObservation', sessionId: o.sessionId })).observation; return o; },
        args(command, extra = {}) { return { command, requestId: randomUUID(), sessionId: o.sessionId,
            observationId: o.observationId, expectedRevision: o.revision, ...extra }; },
        async write(command, extra = {}) {
            const result = await service.command(this.args(command, extra)); o = result.observation; return result;
        },
        async reopen() { await service.close(); service = await new TradeService(directory).initialize(); return this.read(); } };
}
const buy = { symbol: 'TEST-A', side: 'buy', quantity: 100 };

test('long synthetic demo is deterministic, bounded by the observation date and stable after restart', async t => {
    const data = workbenchDemoDataset();
    assert.deepEqual(data, workbenchDemoDataset());
    assert.equal(data.securities.length, 8);
    assert.ok(data.securities.every(s => s.bars.length === 320));
    assert.equal(data.source.kind, 'demo');
    const x = await setup(t);
    const o = (await x.service.command({ command: 'CreateSession', requestId: 'long-demo',
        datasetId: 'demo-workbench', startDate: '2025-05-05', rulesProfile: 'a-share-demo' })).observation;
    assert.equal(o.quotes.length, 8);
    const input = { command: 'GetChart', sessionId: o.sessionId, symbol: 'DEMO-A', limit: 2000 };
    const first = (await x.service.command(input)).chart;
    assert.equal(first.bars.length, 241);
    assert.equal(first.bars.at(-1).date, '2025-05-05');
    assert.ok(first.bars.every(b => b.date <= o.date));
    await x.reopen();
    assert.deepEqual((await x.service.command(input)).chart, first);
});

test('plan -> pending -> next-session fill -> holding -> sell -> review survives restart', async t => {
    const x = await setup(t);
    assert.equal(x.o.quotes[0].bars.length, 1);
    const plan = await x.write('SavePlan', { ...buy, note: 'Test preparation' });
    const preview = await x.service.command(x.args('PreviewOrder', buy));
    assert.equal(preview.observation.revision, 1);
    await x.write('SubmitOrder', { ...buy, planId: plan.receipt.planId });
    assert.equal(x.o.orders[0].status, 'pending');
    assert.equal(x.o.account.positions.length, 0);
    assert.equal(x.o.account.reservedCents, 110100);
    await x.write('AdvanceDay');
    assert.equal(x.o.date, '2025-01-06');
    assert.equal(x.o.orders[0].priceCents, 1011);
    assert.equal(x.o.account.cashCents, 9898800);
    assert.equal(x.o.account.equityCents, 10000800);
    assert.equal(x.o.account.positions[0].sellableQuantity, 0);
    await x.write('SubmitOrder', { symbol: 'TEST-A', side: 'sell', quantity: 100 });
    await x.write('AdvanceDay');
    assert.equal(x.o.account.cashCents, 10001600);
    assert.equal(x.o.account.realizedCents, 1600);
    assert.equal(x.o.account.positions.length, 0);
    await x.write('SaveReview', { note: 'Review of synthetic run' });
    const before = x.o;
    assert.deepEqual(await x.reopen(), before);
});
test('bracket conditions use one OCO position, stop first on an ambiguous daily bar, and persist', async t => {
    const x = await setup(t);
    await x.write('SubmitOrder', { ...buy, stopLossCents: 1025, takeProfitCents: 1040 });
    await x.write('AdvanceDay');
    assert.equal(x.o.conditionals.length, 2);
    assert.equal(x.o.account.positions[0].reservedQuantity, 100);
    await x.write('AdvanceDay');
    assert.equal(x.o.conditionals[0].status, 'triggered');
    assert.equal(x.o.conditionals[1].status, 'cancelled');
    assert.equal(x.o.orders[1].priceCents, 1025);
    assert.equal(x.o.account.positions.length, 0);
    assert.deepEqual(await x.reopen(), x.o);
});
test('manual conditions support OCO, trailing close watermark, cancellation and gap price', async t => {
    const x = await setup(t);
    await x.write('SubmitOrder', buy);
    await x.write('AdvanceDay');
    await x.write('PlaceConditional', { type: 'stop-loss', symbol: 'TEST-A', quantity: 100,
        triggerPriceCents: 1030, groupId: 'pair-1' });
    await x.write('PlaceConditional', { type: 'take-profit', symbol: 'TEST-A', quantity: 100,
        triggerPriceCents: 1040, groupId: 'pair-1' });
    assert.equal(x.o.account.positions[0].reservedQuantity, 100);
    await x.write('AdvanceDay');
    assert.equal(x.o.orders.at(-1).priceCents, 1030);
    assert.equal(x.o.conditionals[1].status, 'cancelled');
});
test('identical retries return durable receipt; conflicting reuse is rejected', async t => {
    const x = await setup(t);
    const args = x.args('SubmitOrder', buy);
    const a = await x.service.command(args);
    const b = await x.service.command(args);
    assert.deepEqual(b.receipt, a.receipt);
    assert.equal(b.duplicate, true);
    assert.equal(b.observation.orders.length, 1);
    await assert.rejects(x.service.command({ ...args, quantity: 200 }), { code: 'REQUEST_CONFLICT' });
    await x.reopen();
    assert.equal((await x.service.command(args)).duplicate, true);
});
test('two concurrent decisions cannot spend the same revision or cash twice', async t => {
    const x = await setup(t);
    const results = await Promise.allSettled([x.service.command(x.args('SubmitOrder', buy)),
        x.service.command(x.args('SubmitOrder', buy))]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'STALE_OBSERVATION');
    await x.read(); assert.equal(x.o.orders.length, 1);
});
test('cancel releases funds and over-allocation / overselling cannot commit', async t => {
    const x = await setup(t);
    await assert.rejects(x.write('SubmitOrder', { ...buy, quantity: 100000 }), { code: 'INSUFFICIENT_CASH' });
    await assert.rejects(x.write('SubmitOrder', { ...buy, side: 'sell' }), { code: 'INSUFFICIENT_POSITION' });
    await x.write('SubmitOrder', buy);
    await x.write('CancelOrder', { orderId: x.o.orders[0].id });
    assert.equal(x.o.account.reservedCents, 0);
    await x.write('AdvanceDay');
    assert.equal(x.o.account.positions.length, 0);
});
test('limit, missing data and unavailable exchange limits produce unfilled records', async t => {
    for (const scenario of ['limit', 'missing', 'rules']) {
        const data = fixture();
        if (scenario === 'missing') data.securities[0].bars[1].suspended = true;
        if (scenario === 'rules') delete data.securities[0].bars[1].limitUpCents;
        const x = await setup(t, data);
        await x.write('SubmitOrder', { ...buy, ...(scenario === 'limit' ? { limitPriceCents: 1000 } : {}) });
        await x.write('AdvanceDay');
        assert.equal(x.o.orders[0].status, 'unfilled');
        assert.equal(x.o.account.cashCents, 10000000);
        assert.equal(x.o.account.reservedCents, 0);
    }
});
test('pause blocks mutations that advance simulation; restore does not run anything', async t => {
    const x = await setup(t);
    await x.write('PauseSession');
    await assert.rejects(x.write('AdvanceDay'), { code: 'PAUSED' });
    await assert.rejects(x.write('SubmitOrder', buy), { code: 'PAUSED' });
    await x.reopen(); assert.equal(x.o.paused, true);
    await x.write('ResumeSession'); await x.write('AdvanceDay');
    assert.equal(x.o.date, '2025-01-06');
});
test('future bars never appear in observation; data-end is explicit', async t => {
    const x = await setup(t);
    const chart = await x.service.command({ command: 'GetChart', sessionId: x.o.sessionId, symbol: 'TEST-A' });
    assert.equal(chart.chart.bars.length, 1);
    assert.equal(chart.chart.asOf, x.o.date);
    assert.equal(chart.chart.revision, x.o.revision);
    chart.chart.bars[0].closeCents = 99999;
    assert.equal((await x.read()).quotes[0].closeCents, 1000);
    await assert.rejects(x.service.command({ command: 'GetChart', sessionId: x.o.sessionId, symbol: 'OTHER' }), { code: 'UNKNOWN_SYMBOL' });
    await assert.rejects(x.service.command({ command: 'GetChart', sessionId: x.o.sessionId, symbol: 'TEST-A', limit: 5001 }), { code: 'INVALID_ARGUMENT' });
    for (let i = 0; i < 3; i++) {
        assert.ok(x.o.quotes[0].bars.every(b => b.date <= x.o.date));
        await x.write('AdvanceDay');
    }
    assert.equal(x.o.finished, true);
    const tail = await x.service.command({ command: 'GetChart', sessionId: x.o.sessionId, symbol: 'TEST-A', limit: 2 });
    assert.equal(tail.chart.bars.length, 2); assert.equal(tail.chart.truncated, true);
    await assert.rejects(x.write('AdvanceDay'), { code: 'FINISHED' });
    await assert.rejects(x.write('SubmitOrder', buy), { code: 'FINISHED' });
});
test('a plan without note says so and a review without note names the VCP parameter format', async t => {
    const x = await setup(t);
    const plan = await x.write('SavePlan', buy);
    assert.match(plan.receipt.hint, /note:「始」/);
    assert.equal((await x.write('SavePlan', { ...buy, note: 'reason' })).receipt.hint, undefined);
    await assert.rejects(x.write('SaveReview'), { code: 'INVALID_ARGUMENT', message: /缺少复盘正文 note.*「始」/ });
    await assert.rejects(x.write('SaveReview', { note: 'x'.repeat(2001) }), { code: 'INVALID_ARGUMENT', message: /2001 字/ });
    await assert.rejects(x.service.command({ command: 'CreateSession', requestId: 'wrong-source', sourceId: 'demo' }),
        { code: 'SOURCE_UNAVAILABLE', message: /datasetId/ });
});
test('failed disk commit leaves funds and revision unchanged', async t => {
    const x = await setup(t);
    const write = x.service.store.write;
    x.service.store.write = async () => { throw new Error('Injected write failure'); };
    await assert.rejects(x.write('SubmitOrder', buy), /Injected/);
    x.service.store.write = write;
    await x.read();
    assert.equal(x.o.revision, 0); assert.equal(x.o.orders.length, 0);
});
test('broken saves and other writer ownership are never treated as an empty account', async t => {
    const x = await setup(t);
    const other = new TradeService(x.directory);
    await assert.rejects(other.initialize(), { code: 'STORE_LOCKED' });
    await fs.writeFile(x.service.store.file(x.o.sessionId), '{broken', 'utf8');
    await assert.rejects(x.read(), { code: 'CORRUPT_SAVE' });
    const listed = await x.service.store.list(); assert.equal(listed.unavailable.length, 1);
});
test('a lock left by an exited writer is taken over; a live or unreadable owner still blocks', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vtrade-lock-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const lock = path.join(directory, 'writer.lock');
    const exited = require('node:child_process').spawnSync(process.execPath, ['-e', '0']).pid;
    await fs.writeFile(lock, String(exited));
    const service = await new TradeService(directory).initialize();
    assert.equal(await fs.readFile(lock, 'utf8'), String(process.pid));
    await service.close();
    for (const owner of [String(process.pid), '']) {
        await fs.writeFile(lock, owner);
        await assert.rejects(new TradeService(directory).initialize(), { code: 'STORE_LOCKED' });
    }
});
test('data validation rejects duplicate dates, adjustment ambiguity and noninteger prices', () => {
    for (const alter of [d => { d.source.adjustment = 'qfq'; },
        d => { d.securities[0].bars[1].date = d.securities[0].bars[0].date; },
        d => { d.securities[0].bars[0].openCents = 10.1; },
        d => { d.securities[0].symbol = '__proto__'; }]) {
        const d = fixture(); alter(d);
        assert.throws(() => normalizeDataset(d), { code: 'INVALID_DATA' });
    }
    assert.equal(demoDataset().source.kind, 'demo');
});
test('TDX reader uses the 32-byte daily layout and keeps prices in cents, volume in shares', () => {
    const bytes = Buffer.alloc(64);
    for (let i = 0; i < 2; i++) {
        const offset = i * 32;
        for (const [position, value] of [[0, 20250106 + i], [4, 1000], [8, 1100], [12, 900], [16, 1050], [24, 12345]]) bytes.writeUInt32LE(value, offset + position);
    }
    const imported = fromTdx(bytes, 'TEST-A');
    assert.equal(imported.securities[0].bars[0].closeCents, 1050);
    assert.equal(imported.securities[0].bars[0].volume, 12345);
    assert.throws(() => fromTdx(bytes.subarray(0, 63), 'TEST-A'), { code: 'INVALID_DATA' });
});

module.exports = { fixture };
