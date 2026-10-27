'use strict';

// 对决 scoring. A seat is graded by its percentile among random traders who change their target as often as it did,
// on the same problem with the same fill rules; highlights mark good decisions. Neither rewards trading more, and
// the raw profit only decides who won a shared round.
const { LEVELS, HISTORY, random, ledger, fillIndex, execute, equityOf } = require('./duel-rules.cjs');

const BENCH = 1000;
const EPS = 1e-9;
const GRADES = Object.freeze([[0.9, 'S'], [0.75, 'A'], [0.5, 'B'], [0.25, 'C'], [0, 'D']]);
const LEAD_MARKS = Object.freeze([5, 10, 20, 40]);
const gradeOf = percentile => GRADES.find(([floor]) => percentile >= floor)[1];
const round6 = value => Math.round(value * 1e6) / 1e6;
const percent = value => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
const average = values => values.reduce((a, b) => a + b, 0) / values.length;
function drawdown(series) {
    let peak = series[0], worst = 0;
    for (const value of series) { peak = Math.max(peak, value); worst = Math.max(worst, 1 - value / peak); }
    return worst;
}

// Highlights for one seat on the day just settled; the caller has pushed today's equity and position.
// Sitting out earns nothing: a sidestep counts only after holding at least half a position in the last five days.
function highlights(round, seat, entry) {
    const n = seat.equity.length - 1, seen = HISTORY - 2 + n;
    const change = round.bars[seen + 1].closeCents / round.bars[seen].closeCents - 1;
    const exposure = seat.positions[n], out = [];
    if (change <= -0.04 && exposure <= 0.25 && Math.max(...seat.positions.slice(Math.max(0, n - 5), n)) >= 0.5) {
        out.push({ kind: 'sidestep', text: `${exposure < 0.01 ? '空仓' : '轻仓'}躲过 ${percent(change)} 的大跌` });
    }
    if (change >= 0.04 && exposure >= 0.75) out.push({ kind: 'ride', text: `${exposure > 0.97 ? '满仓' : '重仓'}吃到 ${percent(change)}` });
    if (entry.stopped && entry.fill && !entry.fill.failed) out.push({ kind: 'stop', text: '按纪律止损，执行到位' });
    const equity = seat.equity[n];
    if (equity >= (seat.highMark ?? seat.equity[0]) * 1.05) {
        seat.highMark = equity;
        out.push({ kind: 'high', text: `净值创本局新高：${percent(equity / seat.equity[0] - 1)}` });
    }
    const others = round.seats.filter(other => other !== seat);
    for (const other of others) {
        if (equity > other.equity[n] && seat.equity[n - 1] < other.equity[n - 1]) out.push({ kind: 'overtake', text: `反超 ${other.label}` });
    }
    if (others.length) {
        let streak = 0;
        for (let k = n; k > 0 && others.every(other => seat.equity[k] > other.equity[k]); k--) streak++;
        if (LEAD_MARKS.includes(streak)) out.push({ kind: 'lead', text: `连续 ${streak} 天领先` });
    }
    return out;
}

// Final returns of BENCH random traders. Each picks a random level on day one, then changes to a random level with a
// chance matching the seat's own rate of changes; orders fill under the round's own rules.
function benchmark(round, model, changes) {
    const length = round.settings.lengthDays, cash = round.settings.initialCashCents;
    const next = random(['bench', round.problem.symbol, round.problem.startDate, round.settings.fill, cash, changes].join('|'));
    const chance = Math.min(0.5, Math.max(0.04, changes / length)), last = round.bars[HISTORY - 1 + length];
    const returns = [];
    for (let k = 0; k < BENCH; k++) {
        const seat = { book: ledger(cash) };
        for (let day = 0; day < length; day++) {
            if (day === 0 || next() < chance) {
                const target = LEVELS[Math.floor(next() * LEVELS.length)];
                if (target !== seat.book.target) { seat.book.target = target; seat.book.unfilled = true; }
            }
            if (seat.book.unfilled) seat.book.unfilled = Boolean(execute(round, seat, seat.book.target, fillIndex(round, day), model)?.failed);
        }
        returns.push(equityOf(seat.book, last) / cash - 1);
    }
    return returns;
}
function summary(returns, changes) {
    const sorted = [...returns].sort((a, b) => a - b), at = q => round6(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
    const min = sorted[0], max = sorted.at(-1), width = (max - min) / 24 || 1, counts = Array(24).fill(0);
    for (const value of sorted) counts[Math.min(23, Math.floor((value - min) / width))]++;
    return { size: returns.length, changes, quantiles: { p10: at(0.1), p25: at(0.25), p50: at(0.5), p75: at(0.75), p90: at(0.9) },
        histogram: { min: round6(min), max: round6(max), counts } };
}
// Review points: the decision that helped most over the next ten days, the largest ten-day rise held below 30%, and
// the deepest equity drawdown. Days are round days; day 0 is the close before the first played day.
function moments(round, seat) {
    const length = round.day, close = n => round.bars[HISTORY - 1 + n].closeCents;
    let best = null;
    for (const row of round.log) {
        const entry = row.entries[seat.id];
        if (entry.target === entry.before || !entry.fill || entry.fill.failed) continue;
        const end = Math.min(length, row.day + 10), move = close(end) / entry.fill.priceCents - 1;
        const gain = (entry.target - entry.before) / 100 * move;
        if (gain > 0 && (!best || gain > best.gain)) best = { day: row.day, end, from: entry.before, to: entry.target, move: round6(move), gain: round6(gain) };
    }
    let missed = null;
    for (let a = 0; a + 10 <= length; a++) {
        const rise = close(a + 10) / close(a) - 1, held = average(seat.positions.slice(a, a + 11));
        if (held < 0.3 && rise > 0.04 && (!missed || rise > missed.rise)) missed = { from: a, to: a + 10, rise: round6(rise), held: round6(held) };
    }
    let peak = 0, deepest = null;
    seat.equity.forEach((value, n) => {
        if (value > seat.equity[peak]) peak = n;
        const depth = 1 - value / seat.equity[peak];
        if (depth > 0.01 && (!deepest || depth > deepest.depth)) deepest = { from: peak, to: n, depth: round6(depth) };
    });
    return { best, missed, drawdown: deepest };
}
function score(round, model) {
    const holdReturn = round.hold.at(-1) / round.hold[0] - 1, seats = {};
    for (const seat of round.seats) {
        const fills = seat.fills.filter(f => !f.failed), sells = fills.filter(f => f.side === 'sell');
        const changes = round.log.filter(row => row.entries[seat.id].target !== row.entries[seat.id].before).length;
        const returns = benchmark(round, model, changes), returnRate = seat.equity.at(-1) / seat.equity[0] - 1;
        const below = returns.filter(v => v < returnRate - EPS).length, ties = returns.filter(v => Math.abs(v - returnRate) <= EPS).length;
        const percentile = round6((below + ties / 2) / returns.length);
        seats[seat.id] = { returnRate: round6(returnRate), excess: round6(returnRate - holdReturn), maxDrawdown: round6(drawdown(seat.equity)),
            trades: fills.length, sells: sells.length, winRate: sells.length ? round6(sells.filter(f => f.profitCents > 0).length / sells.length) : null,
            changes, percentile, grade: gradeOf(percentile),
            // A lead streak is a standing, not a decision, so it does not count towards the highlight goal.
            highlights: round.log.reduce((sum, row) => sum + (row.entries[seat.id].highlights?.filter(h => h.kind !== 'lead').length ?? 0), 0),
            bench: summary(returns, changes), moments: moments(round, seat) };
    }
    const ranking = [...round.seats].sort((a, b) => b.equity.at(-1) - a.equity.at(-1)).map(s => s.id);
    const top = round.seats.filter(s => s.equity.at(-1) === round.seats.find(x => x.id === ranking[0]).equity.at(-1));
    return { hold: { returnRate: round6(holdReturn), maxDrawdown: round6(drawdown(round.hold)) }, seats, ranking,
        winner: round.seats.length > 1 && top.length === 1 ? top[0].id : null };
}

module.exports = { BENCH, GRADES, gradeOf, drawdown, highlights, benchmark, moments, score };
