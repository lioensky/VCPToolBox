'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { TradeService } = require('../core/service.cjs');
const { HISTORY, limitRate } = require('../core/duel.cjs');

const DAYS = [];
for (let d = new Date('2023-01-02T00:00:00Z'); DAYS.length < 200; d.setUTCDate(d.getUTCDate() + 1)) {
    if (![0, 6].includes(d.getUTCDay())) DAYS.push(d.toISOString().slice(0, 10));
}
// One synthetic security at a flat 10.00 yuan; edit() rewrites chosen bars by source index.
function source(edit = () => {}) {
    const bars = DAYS.map(date => ({ date, openCents: 1000, highCents: 1010, lowCents: 990, closeCents: 1000,
        volume: 100000, amount: 100000000 }));
    edit(bars);
    const security = { symbol: 'sh600000', code: '600000', name: '合成样本', kind: 'stock', board: 'sh-main' };
    return { kind: 'test', async securities() { return [security]; }, async bars() { return bars.map(bar => ({ ...bar })); } };
}
const flat = (bars, i, price, extra = {}) => {
    bars[i] = { ...bars[i], openCents: price, highCents: price, lowCents: price, closeCents: price, ...extra };
};
async function setup(t, options = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vtrade-duel-'));
    const make = () => new TradeService(directory, { prewarm: false, ...options }).initialize();
    let service = await make();
    t.after(async () => {
        await service.close();
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
        await fs.rm(directory, { recursive: true, force: true });
    });
    return { get duels() { return service.duels; }, async reopen() { await service.close(); service = await make(); } };
}
const known = (extra = {}) => ({ problem: { kind: 'known', symbol: 'sh600000', startDate: DAYS[HISTORY] },
    seats: [{ kind: 'human' }], ...extra });

test('a blind round hides the security and every date until it is revealed', async t => {
    const { duels } = await setup(t);
    const { round } = await duels.create({ problem: { kind: 'blind', seed: 'blind-1' }, seats: [{ kind: 'human' }] });
    assert.equal(round.source, 'demo');
    assert.equal(round.mode, 'solo');
    assert.deepEqual(round.problem, { kind: 'blind', label: '证券 A' });
    assert.equal(round.bars.length, HISTORY);
    assert.deepEqual([round.bars[0].key, round.bars.at(-1).key], [`前${HISTORY}`, '前1']);
    assert.ok(round.bars.every(bar => bar.volume > 0 && bar.date === undefined));
    assert.doesNotMatch(JSON.stringify(round), /\d{4}-\d{2}-\d{2}|云帆|青禾|远山|星河|澄明|北辰|海岚|新原/);
    await assert.rejects(duels.reveal(round.id), { code: 'NOT_FINISHED' });
    const next = await duels.decide(round.id, { seatId: 'seat-1', target: 50 });
    assert.equal(next.round.bars.at(-1).key, '第1天');
    assert.doesNotMatch(JSON.stringify(next), /\d{4}-\d{2}-\d{2}/);
});

test('the same seed gives the same problem; the daily challenge seeds by date', async t => {
    const { duels } = await setup(t);
    const make = (requestId, problem) => duels.create({ requestId, problem, seats: [{ kind: 'human' }] }).then(r => r.round);
    const [a, b, c] = await Promise.all([make('a', { kind: 'blind', seed: 's1' }), make('b', { kind: 'blind', seed: 's1' }),
        make('c', { kind: 'blind', seed: 's2' })]);
    assert.notEqual(a.id, b.id);
    assert.deepEqual(a.bars, b.bars);
    assert.notDeepEqual(a.bars, c.bars);
    const [d1, d2] = await Promise.all([make('d1', { kind: 'daily', date: '2026-10-27' }), make('d2', { kind: 'daily', date: '2026-10-27' })]);
    assert.deepEqual(d1.bars, d2.bars);
    await assert.rejects(make('d3', { kind: 'daily', date: '2026-02-30' }), { code: 'INVALID_DATA' });
});

test('creating twice with one request id returns the first round and refuses changed settings', async t => {
    const { duels } = await setup(t, { duelSource: source() });
    const first = await duels.create({ requestId: 'same', ...known() });
    const again = await duels.create({ requestId: 'same', ...known() });
    assert.equal(again.duplicate, true);
    assert.equal(again.round.id, first.round.id);
    await assert.rejects(duels.create({ requestId: 'same', ...known({ settings: { fill: 'close' } }) }), { code: 'REQUEST_CONFLICT' });
});

test('settings and seats are validated', async t => {
    const { duels } = await setup(t, { duelSource: source() });
    for (const settings of [{ lengthDays: 120 }, { initialCashCents: 5000000 }, { fill: 'vwap' }, { strict: 'yes' }]) {
        await assert.rejects(duels.create(known({ settings })), { code: 'INVALID_ARGUMENT' });
    }
    for (const seats of [[], [{ kind: 'human' }, { kind: 'human' }], [{ kind: 'agent', agent: 'Nova' }, { kind: 'agent', agent: 'Nova' }],
        Array.from({ length: 5 }, (_, i) => ({ kind: 'agent', agent: `A${i}` })), [{ kind: 'robot' }]]) {
        await assert.rejects(duels.create(known({ seats })), { code: 'INVALID_ARGUMENT' });
    }
    const modes = [];
    for (const seats of [[{ kind: 'human' }], [{ kind: 'agent', agent: 'Nova' }], [{ kind: 'human' }, { kind: 'agent', agent: 'Nova' }],
        [{ kind: 'agent', agent: 'Nova' }, { kind: 'agent', agent: 'Kerr' }]]) modes.push((await duels.create(known({ seats }))).round.mode);
    assert.deepEqual(modes, ['solo', 'watch', 'duel', 'duel']);
    await assert.rejects(duels.create({ problem: { kind: 'known', symbol: 'sh600000', startDate: DAYS[HISTORY - 1] },
        seats: [{ kind: 'human' }] }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(duels.create({ problem: { kind: 'known', symbol: 'sz000000', startDate: DAYS[HISTORY] },
        seats: [{ kind: 'human' }] }), { code: 'UNKNOWN_SYMBOL' });
});

test('a full position fills at the next open in whole lots, with slippage and fees', async t => {
    const { duels } = await setup(t, { duelSource: source() });
    const { round } = await duels.create(known());
    assert.equal(round.revealed, true);
    assert.equal(round.bars.at(-1).date, DAYS[HISTORY - 1]);
    const { settled, round: after } = await duels.decide(round.id, { seatId: 'seat-1', target: 100, reason: '试一下', day: 0 });
    const fill = settled.entries['seat-1'].fill;
    // 10 万元 at 10.01 (open plus 5bp slippage, rounded up): 99 lots, because 100 lots and the fee exceed the cash.
    assert.deepEqual(fill, { day: 1, index: HISTORY, side: 'buy', quantity: 9900, priceCents: 1001, feeCents: 2973 });
    const seat = after.seats[0];
    assert.equal(seat.cashCents, 10000000 - 9900 * 1001 - 2973);
    assert.equal(seat.equityCents, seat.cashCents + 9900 * 1000);
    assert.equal(seat.target, 100);
    assert.equal(after.hold[1], 10000000);
    assert.equal(after.log[0].entries['seat-1'].reason, '试一下');
    // Holding the level never rebalances.
    const held = await duels.decide(round.id, { seatId: 'seat-1', target: 100 });
    assert.equal(held.settled.entries['seat-1'].fill, undefined);
    const half = await duels.decide(round.id, { seatId: 'seat-1', target: 50 });
    const sold = half.settled.entries['seat-1'].fill;
    assert.equal(sold.side, 'sell');
    assert.equal(sold.priceCents, 999);
    assert.equal(sold.quantity % 100, 0);
    assert.ok(sold.profitCents < 0);
});

test('a buy at a limit-up open does not fill and is retried the next day', async t => {
    const { duels } = await setup(t, { duelSource: source(bars => { flat(bars, HISTORY, 1100); flat(bars, HISTORY + 1, 1100); }) });
    const { round } = await duels.create(known());
    const first = await duels.decide(round.id, { seatId: 'seat-1', target: 100 });
    assert.deepEqual(first.settled.entries['seat-1'].fill, { day: 1, index: HISTORY, side: 'buy', failed: true, reason: '涨停开盘，买入未成交' });
    assert.equal(first.round.seats[0].shares, 0);
    const second = await duels.decide(round.id, { seatId: 'seat-1', target: 100 });
    const fill = second.settled.entries['seat-1'].fill;
    assert.equal(fill.side, 'buy');
    assert.equal(fill.index, HISTORY + 1);
    assert.equal(fill.priceCents, 1101);
});

test('the close setting fills at the decision day close unless it closed at the limit', async t => {
    const { duels } = await setup(t, { duelSource: source(bars => {
        bars[HISTORY] = { ...bars[HISTORY], highCents: 1100, closeCents: 1100 };
    }) });
    const { round } = await duels.create(known({ settings: { fill: 'close' } }));
    assert.equal(round.settings.fill, 'close');
    const first = await duels.decide(round.id, { seatId: 'seat-1', target: 50 });
    assert.deepEqual(first.settled.entries['seat-1'].fill, { day: 0, index: HISTORY - 1, side: 'buy', quantity: 5000, priceCents: 1000, feeCents: 1500 });
    assert.equal(first.round.hold[1], 11000000);
    const second = await duels.decide(round.id, { seatId: 'seat-1', target: 100 });
    assert.deepEqual(second.settled.entries['seat-1'].fill, { day: 1, index: HISTORY, side: 'buy', failed: true, reason: '收盘涨停，买入未成交' });
});

test('decisions stay sealed until every seat has decided', async t => {
    const { duels } = await setup(t, { duelSource: source() });
    const { round } = await duels.create(known({ seats: [{ kind: 'human' }, { kind: 'agent', agent: 'Nova' }] }));
    const one = await duels.decide(round.id, { seatId: 'seat-2', target: 100, reason: '均线向上' });
    assert.equal(one.settled, null);
    assert.equal(one.round.day, 0);
    assert.deepEqual(one.round.seats.map(s => [s.decided, s.target]), [[false, 0], [true, 0]]);
    assert.doesNotMatch(JSON.stringify(one.round), /均线向上/);
    await assert.rejects(duels.decide(round.id, { seatId: 'seat-2', target: 0 }), { code: 'ALREADY_DECIDED' });
    await assert.rejects(duels.decide(round.id, { seatId: 'seat-3', target: 0 }), { code: 'INVALID_SEAT' });
    await assert.rejects(duels.decide(round.id, { seatId: 'seat-1', target: 30 }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(duels.decide(round.id, { seatId: 'seat-1', target: 0, day: 1 }), { code: 'STALE_DAY' });
    const two = await duels.decide(round.id, { seatId: 'seat-1', target: 0 });
    assert.equal(two.round.day, 1);
    assert.equal(two.settled.entries['seat-2'].reason, '均线向上');
    assert.equal(two.round.seats[1].shares, 9900);
    assert.equal(two.round.seats[0].shares, 0);
    assert.deepEqual(two.round.seats.map(s => s.decided), [false, false]);
});

test('a stop sells the whole position after the close falls below the stop', async t => {
    const { duels } = await setup(t, { duelSource: source(bars => {
        bars[HISTORY + 1] = { ...bars[HISTORY + 1], lowCents: 900, closeCents: 940 };
        flat(bars, HISTORY + 2, 940);
    }) });
    const { round } = await duels.create(known());
    await duels.decide(round.id, { seatId: 'seat-1', target: 100, stopPct: 5 });
    const calm = await duels.decide(round.id, { seatId: 'seat-1', target: 100 });
    assert.equal(calm.settled.entries['seat-1'].stopped, false);
    const hit = await duels.decide(round.id, { seatId: 'seat-1', target: 100 });
    const entry = hit.settled.entries['seat-1'];
    assert.equal(entry.stopped, true);
    assert.equal(entry.target, 0);
    assert.match(entry.reason, /止损/);
    assert.deepEqual([entry.fill.side, entry.fill.quantity, entry.fill.index], ['sell', 9900, HISTORY + 2]);
    assert.equal(hit.round.seats[0].shares, 0);
    assert.equal(hit.round.seats[0].target, 0);
});

test('strict blind rebases prices to 100 and shows relative volume', async t => {
    const { duels } = await setup(t);
    const { round } = await duels.create({ problem: { kind: 'blind', seed: 'strict' }, settings: { strict: true }, seats: [{ kind: 'human' }] });
    assert.equal(round.strict, true);
    assert.equal(round.bars.at(-1).closeCents, 10000);
    assert.ok(round.bars.every(bar => bar.volume === undefined && bar.amount === undefined && bar.relativeVolume > 0));
});

test('a scripted round plays 60 days, keeps the ledger consistent, and reveals at the end', async t => {
    const context = await setup(t);
    const { round } = await context.duels.create({ problem: { kind: 'blind', seed: 'full' },
        seats: [{ kind: 'human' }, { kind: 'agent', agent: 'Nova' }] });
    const plan = [0, 25, 50, 75, 100, 100, 50, 0, 100, 25];
    let view = round;
    for (let day = 0; day < 60; day++) {
        if (day === 30) { await context.reopen(); view = await context.duels.view(round.id); assert.equal(view.day, 30); }
        await context.duels.decide(round.id, { seatId: 'seat-2', target: plan[(day * 3) % plan.length], day });
        view = (await context.duels.decide(round.id, { seatId: 'seat-1', target: plan[day % plan.length], day })).round;
    }
    assert.equal(view.status, 'finished');
    assert.equal(view.log.length, 60);
    assert.equal(view.hold.length, 61);
    await assert.rejects(context.duels.decide(round.id, { seatId: 'seat-1', target: 0 }), { code: 'FINISHED' });
    const { round: shown } = await context.duels.reveal(round.id);
    assert.equal(shown.revealed, true);
    assert.equal(shown.bars.length, HISTORY + 60);
    assert.match(shown.bars[0].key, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(shown.problem.name && shown.problem.startDate === shown.bars[HISTORY].date);
    for (const seat of shown.seats) {
        assert.equal(seat.equity.length, 61);
        assert.ok(seat.fills.length > 0);
        assert.ok(seat.fills.every(f => f.failed || f.quantity > 0 && f.quantity % 100 === 0));
        assert.ok(seat.cashCents >= 0 && seat.shares >= 0);
        assert.equal(seat.equityCents, seat.cashCents + seat.shares * shown.bars.at(-1).closeCents);
    }
    const listed = await context.duels.list();
    assert.deepEqual(listed.map(r => [r.id, r.status, r.day]), [[round.id, 'finished', 60]]);
});

test('daily limits follow the board', () => {
    assert.equal(limitRate({ kind: 'stock', board: 'sh-main', name: '合成' }, '2024-01-02'), 0.1);
    assert.equal(limitRate({ kind: 'stock', board: 'star', name: '合成' }, '2024-01-02'), 0.2);
    assert.equal(limitRate({ kind: 'stock', board: 'chinext', name: '合成' }, '2020-08-21'), 0.1);
    assert.equal(limitRate({ kind: 'stock', board: 'chinext', name: '合成' }, '2020-08-24'), 0.2);
    assert.equal(limitRate({ kind: 'stock', board: 'bse', name: '合成' }, '2024-01-02'), 0.3);
    assert.equal(limitRate({ kind: 'stock', board: 'sz-main', name: '*ST合成' }, '2024-01-02'), 0.05);
});
