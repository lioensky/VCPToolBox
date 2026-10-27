'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { TradeService } = require('../core/service.cjs');
const { HISTORY, advance } = require('../core/duel.cjs');
const { gradeOf, score } = require('../core/duel-score.cjs');
const { levelOf } = require('../core/duel-career.cjs');

const DAYS = [];
for (let d = new Date('2023-01-02T00:00:00Z'); DAYS.length < 200; d.setUTCDate(d.getUTCDate() + 1)) {
    if (![0, 6].includes(d.getUTCDay())) DAYS.push(d.toISOString().slice(0, 10));
}
// A synthetic security: flat at 10.00 yuan for the history, then the given daily closes.
function source(edit = () => {}) {
    const bars = DAYS.map(date => ({ date, openCents: 1000, highCents: 1000, lowCents: 1000, closeCents: 1000, volume: 100000, amount: null }));
    edit(bars);
    const security = { symbol: 'sh600000', code: '600000', name: '合成样本', kind: 'stock', board: 'sh-main' };
    return { kind: 'test', async securities() { return [security]; }, async bars() { return bars.map(bar => ({ ...bar })); } };
}
const rising = bars => {
    for (let i = HISTORY; i < bars.length; i++) {
        const open = bars[i - 1].closeCents, close = Math.round(open * 1.01);
        bars[i] = { ...bars[i], openCents: open, highCents: close, lowCents: open, closeCents: close };
    }
};
async function setup(t, options = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vtrade-duel-score-'));
    const service = await new TradeService(directory, { prewarm: false, ...options }).initialize();
    t.after(async () => {
        await service.close();
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
        await fs.rm(directory, { recursive: true, force: true });
    });
    return service.duels;
}
const known = seats => ({ problem: { kind: 'known', symbol: 'sh600000', startDate: DAYS[HISTORY] }, seats });
const human = [{ kind: 'human' }], versusNova = [{ kind: 'human' }, { kind: 'agent', agent: 'Nova' }];
// Plays a whole round in memory with the same settle step the service uses, then scores and records it.
async function playOut(duels, input, plans, now = new Date('2026-10-27T04:00:00Z')) {
    const { round: { id } } = await duels.create(input);
    const round = await duels.read(id), model = duels.model();
    for (let day = 0; day < round.settings.lengthDays; day++) {
        round.pending = Object.fromEntries(round.seats.map((seat, k) => [seat.id, { target: plans[k](day) }]));
        advance(round, model);
    }
    round.result = score(round, model);
    round.result.rewards = await duels.career.record(round, now);
    return round;
}

test('grades and levels follow fixed thresholds', () => {
    assert.deepEqual([0.9, 0.8999, 0.75, 0.5, 0.25, 0.2499, 0].map(gradeOf), ['S', 'A', 'A', 'B', 'C', 'D', 'D']);
    assert.deepEqual([0, 99, 100, 299, 300].map(levelOf), [{ level: 1, into: 0, need: 100 }, { level: 1, into: 99, need: 100 },
        { level: 2, into: 0, need: 200 }, { level: 2, into: 199, need: 200 }, { level: 3, into: 0, need: 300 }]);
});

test('on a steady rise holding is graded S and staying out is graded D against random traders', async t => {
    const duels = await setup(t, { duelSource: source(rising) });
    const round = await playOut(duels, known(versusNova), [() => 100, () => 0]);
    const [held, out] = ['seat-1', 'seat-2'].map(id => round.result.seats[id]);
    assert.equal(held.grade, 'S');
    assert.equal(out.grade, 'D');
    assert.ok(held.percentile > 0.95 && out.percentile < 0.05);
    assert.equal(out.returnRate, 0);
    assert.ok(held.excess > -0.01 && held.excess < 0);
    assert.equal(held.bench.size, 1000);
    assert.equal(held.bench.histogram.counts.reduce((a, b) => a + b, 0), 1000);
    assert.ok(held.bench.quantiles.p10 <= held.bench.quantiles.p50 && held.bench.quantiles.p50 <= held.bench.quantiles.p90);
    assert.deepEqual([held.trades, held.sells, held.winRate, held.changes], [1, 0, null, 1]);
    assert.deepEqual(round.result.ranking, ['seat-1', 'seat-2']);
    assert.equal(round.result.winner, 'seat-1');
    assert.equal(held.moments.best.day, 1);
    assert.equal(held.moments.drawdown, null);
    assert.equal(out.moments.best, null);
    assert.ok(out.moments.missed.rise > 0.1 && out.moments.missed.held === 0);
    // The score is reproducible: the same decisions on the same problem give the same result.
    const again = await playOut(duels, known(versusNova), [() => 100, () => 0]);
    assert.deepEqual(again.result.seats, round.result.seats);
});

test('highlights mark riding a rise, stepping aside before a drop and overtaking, not sitting out', async t => {
    const duels = await setup(t, { duelSource: source(bars => {
        bars[HISTORY + 1] = { ...bars[HISTORY + 1], highCents: 1050, closeCents: 1050 };
        bars[HISTORY + 2] = { ...bars[HISTORY + 2], openCents: 1050, highCents: 1050, lowCents: 987, closeCents: 987 };
        for (let i = HISTORY + 3; i < bars.length; i++) bars[i] = { ...bars[i], openCents: 987, highCents: 987, lowCents: 987, closeCents: 987 };
    }) });
    const { round } = await duels.create(known(versusNova));
    const play = async (mine, nova) => {
        await duels.decide(round.id, { seatId: 'seat-2', target: nova });
        return (await duels.decide(round.id, { seatId: 'seat-1', target: mine })).settled.entries;
    };
    assert.deepEqual((await play(100, 0))['seat-1'].highlights, []);
    const day2 = await play(100, 0);
    assert.deepEqual(day2['seat-1'].highlights.map(h => h.kind), ['ride', 'overtake']);
    assert.equal(day2['seat-1'].highlights[1].text, '反超 Nova');
    assert.match(day2['seat-1'].highlights[0].text, /^满仓吃到 \+5\.0%$/);
    const day3 = await play(0, 0);
    assert.deepEqual(day3['seat-1'].highlights.map(h => h.kind), ['sidestep']);
    assert.match(day3['seat-1'].highlights[0].text, /^空仓躲过 -6\.0% 的大跌$/);
    assert.deepEqual(day3['seat-2'].highlights, []);
});

test('a finished round shows its score and rewards without leaking dates before the reveal', async t => {
    const duels = await setup(t);
    const { round } = await duels.create({ problem: { kind: 'blind', seed: 'career' }, seats: human });
    let view;
    for (let day = 0; day < 60; day++) view = (await duels.decide(round.id, { seatId: 'seat-1', target: [100, 50, 0][Math.floor(day / 20)] })).round;
    assert.equal(view.status, 'finished');
    const reward = view.result.rewards['seat-1'];
    assert.equal(reward.key, 'player');
    assert.ok(reward.achievements.includes('first'));
    assert.equal(reward.xp, reward.breakdown.reduce((sum, item) => sum + item.xp, 0));
    assert.equal(reward.breakdown[0].xp, Math.round(view.result.seats['seat-1'].percentile * 100));
    assert.doesNotMatch(JSON.stringify(view), /\d{4}-\d{2}-\d{2}/);
    const profile = await duels.profile();
    assert.equal(profile.xp, reward.xp);
    assert.deepEqual(profile.level, levelOf(reward.xp));
    assert.equal(profile.rounds, 1);
    assert.equal(profile.history[0].roundId, round.id);
    assert.ok(profile.achievements.find(a => a.id === 'first').got);
    assert.equal(profile.goals.find(g => g.id === 'blind-b').done, ['S', 'A', 'B'].includes(view.result.seats['seat-1'].grade));
    // Recording the same round again changes nothing and returns the stored rewards.
    const raw = await duels.read(round.id);
    assert.deepEqual(await duels.career.record(raw, new Date()), raw.result.rewards);
    assert.equal((await duels.profile()).xp, reward.xp);
});

test('shared rounds keep win streaks and head-to-head records for the player and the Agent', async t => {
    const duels = await setup(t, { duelSource: source(rising) });
    const rounds = [];
    for (let k = 0; k < 3; k++) rounds.push(await playOut(duels, known(versusNova), [() => 100, () => 0]));
    assert.deepEqual(rounds.map(r => r.result.rewards['seat-1'].streak), [1, 2, 3]);
    assert.ok(rounds[2].result.rewards['seat-1'].achievements.includes('streak3'));
    assert.ok(rounds[0].result.rewards['seat-1'].breakdown.some(item => item.label === '同场对决获胜' && item.xp === 30));
    assert.equal(rounds[0].result.rewards['seat-2'].outcome, 'loss');
    const player = await duels.profile('player'), nova = await duels.profile('agent:Nova');
    assert.deepEqual(player.versus['agent:Nova'], { label: 'Nova', wins: 3, losses: 0, draws: 0 });
    assert.deepEqual(nova.versus.player, { label: '玩家', wins: 0, losses: 3, draws: 0 });
    assert.equal(player.achievements.find(a => a.id === 'beat10').progress, 3);
    assert.deepEqual(nova.goals, []);
    assert.deepEqual((await duels.players()).map(p => p.key), ['player', 'agent:Nova']);
    await assert.rejects(duels.profile('someone'), { code: 'INVALID_ARGUMENT' });
});

test('the daily challenge streak counts consecutive days and its goal pays once a day', async t => {
    const duels = await setup(t);
    const daily = (date, n) => playOut(duels, { requestId: `daily-${n}`, problem: { kind: 'daily', date }, seats: human }, [() => 50],
        new Date(`${date}T04:00:00Z`));
    const first = await daily('2026-10-26', 1);
    const second = await daily('2026-10-27', 2);
    const repeat = await daily('2026-10-27', 3);
    const gap = await daily('2026-10-29', 4);
    assert.deepEqual([first, second, repeat, gap].map(r => r.result.rewards['seat-1'].dailyStreak), [1, 2, 2, 1]);
    const paid = r => r.result.rewards['seat-1'].breakdown.some(item => item.label === '今日目标：完成今天的每日挑战');
    assert.deepEqual([first, second, repeat, gap].map(paid), [true, true, false, true]);
    assert.deepEqual(second.bars, repeat.bars);
    const profile = await duels.career.profile('player', new Date('2026-10-29T04:00:00Z'));
    assert.deepEqual([profile.daily.streak, profile.daily.best, profile.daily.today], [1, 2, true]);
});
