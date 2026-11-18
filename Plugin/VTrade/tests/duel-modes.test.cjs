'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { TradeService } = require('../core/service.cjs');
const { HISTORY } = require('../core/duel.cjs');

const businessDays = (from, count) => {
    const days = [];
    for (let d = new Date(`${from}T00:00:00Z`); days.length < count; d.setUTCDate(d.getUTCDate() + 1)) {
        if (![0, 6].includes(d.getUTCDay())) days.push(d.toISOString().slice(0, 10));
    }
    return days;
};
// An index at 3000 points and a stock, flat before 2015-06-15 and then moving `daily` per day.
function source({ daily = 0.01, stockDaily = daily, stockBase = 1000, market = null } = {}) {
    const days = businessDays('2014-06-02', 420);
    const series = (base, rate) => {
        let close = base;
        return days.map(date => {
            const open = close;
            close = date >= '2015-06-15' ? Math.round(open * (1 + rate)) : open;
            return { date, openCents: open, highCents: Math.max(open, close), lowCents: Math.min(open, close), closeCents: close, volume: 1e8, amount: null };
        });
    };
    const securities = [
        { symbol: 'SH.000001', code: '000001', name: '合成指数', kind: 'index', board: 'index', bars: series(300000, daily) },
        { symbol: 'SH.600000', code: '600000', name: '合成样本', kind: 'stock', board: 'sh-main', bars: series(stockBase, stockDaily) },
        ...(market === null ? [] : [{ symbol: 'SH.000300', code: '000300', name: '合成大盘', kind: 'index', board: 'index', bars: series(400000, market) }]),
    ];
    return { kind: 'test', async securities() { return securities; }, async bars(security) { return security.bars.map(bar => ({ ...bar })); } };
}
async function setup(t, options) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vtrade-duel-modes-'));
    const service = await new TradeService(directory, { prewarm: false, ...options }).initialize();
    t.after(async () => {
        await service.close();
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
        await fs.rm(directory, { recursive: true, force: true });
    });
    return service;
}
async function play(service, roundId, target = 100) {
    let { round } = await service.duel({ action: 'view', roundId });
    while (round.status === 'active') round = (await service.duel({ action: 'decide', roundId, seatId: 'seat-1', target, day: round.day })).round;
    return round;
}
async function setBalance(service, cents) {
    await service.duel({ action: 'challengeReset' });
    const file = service.duels.career.file, career = JSON.parse(await fs.readFile(file, 'utf8'));
    career.players.player.challenge.cashCents = cents;
    await fs.writeFile(file, JSON.stringify(career));
}

test('名局重现 plays an index period blind, in single units under the reference rules', async t => {
    const service = await setup(t, { duelSource: source() });
    const { classics } = await service.duel({ action: 'classics' });
    assert.deepEqual(classics.map(c => c.id), ['after-rally-2015']);
    const { round } = await service.duel({ action: 'create', problem: { kind: 'classic', classic: 'after-rally-2015' }, seats: [{ kind: 'human' }] });
    assert.deepEqual(round.problem, { kind: 'classic', label: '指数 A', classic: 'after-rally-2015', classicName: '大涨一年之后' });
    assert.equal(round.lot, 1);
    assert.doesNotMatch(JSON.stringify(round), /\d{4}-\d{2}-\d{2}|合成指数/);
    const { settled } = await service.duel({ action: 'decide', roundId: round.id, seatId: 'seat-1', target: 100 });
    const fill = settled.entries['seat-1'].fill;
    assert.equal(fill.failed, undefined);
    assert.ok(fill.quantity > 0 && fill.quantity % 100 !== 0, `bought ${fill.quantity} units`);
    await assert.rejects(service.duel({ action: 'create', problem: { kind: 'classic', classic: 'nope' }, seats: [{ kind: 'human' }] }),
        { code: 'INVALID_ARGUMENT' });
    const finished = await play(service, round.id);
    const { round: shown } = await service.duel({ action: 'reveal', roundId: finished.id });
    assert.equal(shown.problem.startDate, '2015-06-15');
    assert.equal(shown.problem.name, '合成指数');
});

test('fundamentals use the latest report announced by each day, without the report period in a blind round', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vtrade-duel-fin-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const report = (period, publishedAt, epsTTM) => ({ period, publishedAt, metrics: { totalShare: 1e9, liqaShare: 6e8, epsTTM, bps: 5 } });
    await fs.writeFile(path.join(directory, 'financials.json'), JSON.stringify({ schemaVersion: 1, kind: 'financials', source: { name: '合成财务' },
        fields: {}, securities: [{ symbol: 'SH.600000', reports: [report('2014-12-31', '2015-03-20', 0.4), report('2015-06-30', '2015-08-20', 0.5),
            report('2015-09-30', '2016-01-10', 9)] }] }));
    const sourcesFile = path.join(directory, 'sources.json');
    await fs.writeFile(sourcesFile, JSON.stringify({ schemaVersion: 1, sources: [], tools: { financials: { directory, file: 'financials.json' } } }));
    const service = await setup(t, { duelSource: source({ stockDaily: 0 }), sourcesFile });
    const { round } = await service.duel({ action: 'create', problem: { kind: 'known', symbol: 'SH.600000', startDate: '2015-06-15' }, seats: [{ kind: 'human' }] });
    assert.deepEqual(round.fundamentals, { period: '2014-12-31', marketCapCents: 1e12, floatCapCents: 6e11, pe: 25, pb: 2, roe: null, profitGrowth: null });
    const turn = (await service.duels.turn(round.id, 'seat-1')).text;
    assert.match(turn, /总市值 100 亿元，流通市值 60 亿元，市盈率（TTM）25\.0，市净率 2\.00/);
    // Later in the round the August report is announced; the one published after the round never appears.
    const raw = await service.duels.read(round.id);
    assert.deepEqual(raw.reports.map(r => r.period), ['2014-12-31', '2015-06-30']);
    raw.settings.strict = true; raw.problem.kind = 'blind';
    const { project } = require('../core/duel.cjs');
    assert.equal(project(raw).fundamentals, undefined);
    raw.settings.strict = false;
    raw.day = 50;
    const later = project(raw).fundamentals;
    assert.equal(later.pe, 20);
    assert.equal(later.period, undefined);
});

test('资金挑战 starts at 1 万, carries the balance between solo rounds and allows one round at a time', async t => {
    const service = await setup(t, { duelSource: source() });
    const known = { kind: 'known', symbol: 'SH.600000', startDate: '2015-06-15' };
    const { round } = await service.duel({ action: 'create', problem: known, settings: { challenge: true }, seats: [{ kind: 'human' }] });
    assert.equal(round.settings.initialCashCents, 1000000);
    assert.deepEqual(round.challenge, { run: 1, round: 1, startCents: 1000000 });
    await assert.rejects(service.duel({ action: 'create', problem: known, settings: { challenge: true }, seats: [{ kind: 'human' }] }),
        { code: 'CHALLENGE_ACTIVE' });
    await assert.rejects(service.duel({ action: 'create', problem: known, settings: { challenge: true },
        seats: [{ kind: 'human' }, { kind: 'agent', agent: 'Nova' }] }), { code: 'INVALID_ARGUMENT' });
    const done = await play(service, round.id);
    const reward = done.result.rewards['seat-1'].challenge;
    assert.equal(reward.beforeCents, 1000000);
    assert.equal(reward.afterCents, done.seats[0].equityCents);
    assert.ok(reward.afterCents > 1500000);
    const { challenge } = await service.duel({ action: 'challenge' });
    assert.deepEqual([challenge.run, challenge.rounds, challenge.cashCents, challenge.activeRoundId], [1, 1, reward.afterCents, null]);
    const next = (await service.duel({ action: 'create', problem: known, settings: { challenge: true }, seats: [{ kind: 'human' }] })).round;
    assert.equal(next.settings.initialCashCents, reward.afterCents);
    assert.equal(next.challenge.round, 2);
});

test('资金挑战 marks 10 万 once, clears at 1 亿 with an achievement and starts a new run; a reset keeps the record', async t => {
    const service = await setup(t, { duelSource: source() });
    const known = { kind: 'known', symbol: 'SH.600000', startDate: '2015-06-15' };
    await setBalance(service, 9000000);
    let round = await play(service, (await service.duel({ action: 'create', problem: known, settings: { challenge: true }, seats: [{ kind: 'human' }] })).round.id);
    assert.deepEqual(round.result.rewards['seat-1'].challenge.crossed, [10000000]);
    await setBalance(service, 6000000000);
    round = await play(service, (await service.duel({ action: 'create', problem: known, settings: { challenge: true }, seats: [{ kind: 'human' }] })).round.id);
    const reward = round.result.rewards['seat-1'];
    assert.equal(reward.challenge.result, 'cleared');
    assert.ok(reward.achievements.includes('billion'));
    let { challenge } = await service.duel({ action: 'challenge' });
    assert.deepEqual([challenge.cashCents, challenge.rounds, challenge.runs[0].result, challenge.best], [1000000, 0, 'cleared', 1]);
    const runBefore = challenge.run;
    const active = (await service.duel({ action: 'create', problem: known, settings: { challenge: true }, seats: [{ kind: 'human' }] })).round;
    challenge = (await service.duel({ action: 'challengeReset' })).challenge;
    assert.equal(challenge.run, runBefore + 1);
    assert.equal(challenge.runs[0].result, 'reset');
    const finished = await play(service, active.id);
    assert.equal(finished.result.rewards['seat-1'].challenge, undefined);
    assert.equal((await service.duel({ action: 'challenge' })).challenge.cashCents, 1000000);
});

test('资金挑战 ends a run when the balance falls under 500 元', async t => {
    const service = await setup(t, { duelSource: source({ stockDaily: -0.05, stockBase: 100 }) });
    await setBalance(service, 60000);
    const known = { kind: 'known', symbol: 'SH.600000', startDate: '2015-06-15' };
    const { round } = await service.duel({ action: 'create', problem: known, settings: { challenge: true }, seats: [{ kind: 'human' }] });
    assert.equal(round.settings.initialCashCents, 60000);
    const done = await play(service, round.id);
    assert.equal(done.result.rewards['seat-1'].challenge.result, 'bust');
    const { challenge } = await service.duel({ action: 'challenge' });
    assert.deepEqual([challenge.cashCents, challenge.runs[0].result], [1000000, 'bust']);
});

test('rounds compare against 沪深 300 up to the current day only, as returns, and Agents read the same line', async t => {
    const service = await setup(t, { duelSource: source({ stockDaily: 0, market: 0.02 }) });
    const { round } = await service.duel({ action: 'create', problem: { kind: 'known', symbol: 'SH.600000', startDate: '2015-06-15' },
        seats: [{ kind: 'human' }, { kind: 'agent', agent: 'Nova' }] });
    assert.deepEqual(round.benchmark, { name: '沪深 300', returns: [0] });
    assert.doesNotMatch(JSON.stringify(round), /closes|400000/);
    let view = round;
    for (let day = 0; day < 3; day++) {
        await service.duel({ action: 'hold', roundId: round.id, seatId: 'seat-2', day });
        view = (await service.duel({ action: 'decide', roundId: round.id, seatId: 'seat-1', target: 0, day })).round;
    }
    assert.equal(view.benchmark.returns.length, 4);
    assert.ok(Math.abs(view.benchmark.returns[3] - (1.02 ** 3 - 1)) < 1e-4, String(view.benchmark.returns));
    const { turn } = await service.duel({ action: 'turn', roundId: round.id, seatId: 'seat-2' });
    assert.match(turn.text, /大盘（沪深 300）：开局以来 \+6\.1%，近 5 日 \+6\.1%。/);
    // Without the index in the source a round simply has no market line.
    const plain = await setup(t, { duelSource: source() });
    const other = (await plain.duel({ action: 'create', problem: { kind: 'known', symbol: 'SH.600000', startDate: '2015-06-15' }, seats: [{ kind: 'human' }] })).round;
    assert.equal(other.benchmark, undefined);
});
