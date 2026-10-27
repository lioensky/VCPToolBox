'use strict';

// 对决 career: experience, levels, achievements, daily goals and records for the local player and for each Agent.
// Experience follows the percentile and good decisions, never the raw profit or the number of trades.
const fs = require('node:fs/promises');
const path = require('node:path');
const { check } = require('./data.cjs');
const { atomicWrite } = require('./store.cjs');
const { HISTORY, localDate } = require('./duel-rules.cjs');

const XP = Object.freeze({ finish: 20, win: 30, achievement: 10 });
const GOALS = Object.freeze([
    { id: 'daily', text: '完成今天的每日挑战', xp: 50 },
    { id: 'blind-b', text: '打一局盲测拿到 B 级以上', xp: 30 },
    { id: 'highlights', text: '一局里拿到 3 次高光', xp: 20 },
]);
const ACHIEVEMENTS = Object.freeze([
    { id: 'first', mark: '初', name: '初次对决', text: '打完第一局对决' },
    { id: 'dodge', mark: '躲', name: '躲过下跌', text: '在 15% 以上的下跌开始前降到两成五以下' },
    { id: 'bottom', mark: '低', name: '抄在低位', text: '一次加仓五成以上，买入价在之后 20 天最低价的 1% 以内' },
    { id: 'ride', mark: '升', name: '吃到主升', text: '在一段 15% 以上的上涨里平均仓位八成以上' },
    { id: 'grade-s', mark: 'S', name: 'S 级', text: '单局评级 S' },
    { id: 'strict', mark: '严', name: '严格盲测', text: '严格盲测拿到 B 级以上' },
    { id: 'streak3', mark: '连', name: '三连胜', text: '同场对决连胜三局', goal: 3 },
    { id: 'beat10', mark: '十', name: '十胜', text: '同场对决战胜同一位对手十次', goal: 10 },
    { id: 'daily7', mark: '日', name: '每日不缺', text: '连续 7 天参加每日挑战', goal: 7 },
    { id: 'billion', mark: '亿', name: '一万到一亿', text: '资金挑战从 1 万元做到 1 亿元' },
]);
// 资金挑战: one balance per player, from 1 万 to 1 亿 over as many solo rounds as it takes. Crossing 10 万, 100 万 and
// 1000 万 is marked once per run; 1 亿 clears the run, a balance under 500 元 ends it; either way a new run starts.
const CHALLENGE = Object.freeze({ startCents: 1000000, goalCents: 10000000000, bustCents: 50000,
    marks: Object.freeze([10000000, 100000000, 1000000000]) });
const RUNS_KEPT = 20;
const NEXT_GRADE = [[0.25, 'C'], [0.5, 'B'], [0.75, 'A'], [0.9, 'S']];
const HISTORY_KEPT = 200;
const REWARDS_KEPT = 500;
const good = grade => ['S', 'A', 'B'].includes(grade);
const average = values => values.reduce((a, b) => a + b, 0) / values.length;

// Level n takes 100 × n experience to finish.
function levelOf(xp) {
    let level = 1, into = xp;
    while (into >= level * 100) { into -= level * 100; level++; }
    return { level, into, need: level * 100 };
}
const keyOf = seat => seat.kind === 'human' ? 'player' : `agent:${seat.agent}`;
function freshRun(run, now) {
    return { run, rounds: 0, cashCents: CHALLENGE.startCents, peakCents: CHALLENGE.startCents, marks: [], startedAt: now.toISOString(), activeRoundId: null };
}
function blank(seat) {
    return { key: keyOf(seat), kind: seat.kind, label: seat.label, xp: 0, rounds: 0, grades: { S: 0, A: 0, B: 0, C: 0, D: 0 },
        best: null, streak: 0, bestStreak: 0, daily: { last: null, streak: 0, best: 0 }, goals: { date: null, done: [] },
        versus: {}, achievements: {}, history: [] };
}
// Achievements one round can earn on its own; the cumulative ones are checked against the updated record.
function earned(round, seat, stats) {
    const length = round.day, close = n => round.bars[HISTORY - 1 + n].closeCents, held = seat.positions, out = [];
    for (let a = 0; a < length && !out.includes('dodge'); a++) {
        const low = Math.min(...Array.from({ length: Math.min(10, length - a) }, (_, k) => close(a + k + 1)));
        if (low / close(a) - 1 <= -0.15 && held[a] <= 0.25 && Math.max(...held.slice(Math.max(0, a - 10), a + 1)) >= 0.5) out.push('dodge');
    }
    for (const row of round.log) {
        const { fill, before, target } = row.entries[seat.id];
        if (!fill || fill.failed || fill.side !== 'buy' || target - before < 50 || fill.index + 19 >= round.bars.length) continue;
        const low = Math.min(...round.bars.slice(fill.index, fill.index + 20).map(bar => bar.lowCents));
        if (fill.priceCents <= low * 1.01) { out.push('bottom'); break; }
    }
    ride: for (let a = 0; a < length; a++) {
        for (let b = a + 5; b <= length; b++) {
            if (close(b) / close(a) - 1 >= 0.15 && average(held.slice(a, b + 1)) >= 0.8) { out.push('ride'); break ride; }
        }
    }
    if (stats.grade === 'S') out.push('grade-s');
    if (round.settings.strict && round.problem.kind !== 'known' && good(stats.grade)) out.push('strict');
    return out;
}
function progress(record, id) {
    if (id === 'streak3') return record.bestStreak;
    if (id === 'beat10') return Math.max(0, ...Object.values(record.versus).map(v => v.wins));
    if (id === 'daily7') return record.daily.best;
    return null;
}

class Career {
    constructor(directory, serial) { this.file = path.join(directory, 'career.json'); this.serial = operation => serial('duel:career', operation); }
    async read() {
        try { return JSON.parse(await fs.readFile(this.file, 'utf8')); }
        catch (error) {
            if (error.code === 'ENOENT') return { schemaVersion: 1, players: {}, rewards: {} };
            check(false, 'CORRUPT_SAVE', '对决战绩不可读取，已保留原文件。');
        }
    }
    // Records a finished, scored round once and returns each seat's rewards; a repeat returns the stored rewards.
    record(round, now) {
        return this.serial(async () => {
            const career = await this.read();
            if (career.rewards[round.id]) return career.rewards[round.id].seats;
            const today = localDate(now), yesterday = localDate(new Date(now.getTime() - 86400000)), result = round.result, rewards = {};
            for (const seat of round.seats) {
                const stats = result.seats[seat.id], key = keyOf(seat);
                const record = career.players[key] ||= blank(seat);
                record.label = seat.label;
                const breakdown = [{ label: `超过 ${Math.round(stats.percentile * 100)}% 的随机操作者`, xp: Math.round(stats.percentile * 100) },
                    { label: '完成一局', xp: XP.finish }];
                const before = levelOf(record.xp), previousBest = record.best;
                record.rounds++; record.grades[stats.grade]++;
                const personalBest = { percentile: Boolean(previousBest && stats.percentile > previousBest.percentile),
                    returnRate: Boolean(previousBest && stats.returnRate > previousBest.returnRate) };
                record.best = { percentile: Math.max(previousBest?.percentile ?? -1, stats.percentile),
                    returnRate: Math.max(previousBest?.returnRate ?? -Infinity, stats.returnRate) };
                let outcome = null;
                if (round.seats.length > 1) {
                    outcome = result.winner === seat.id ? 'win' : result.winner ? 'loss' : 'draw';
                    if (outcome === 'win') { record.streak++; breakdown.push({ label: '同场对决获胜', xp: XP.win }); }
                    if (outcome === 'loss') record.streak = 0;
                    record.bestStreak = Math.max(record.bestStreak, record.streak);
                    for (const other of round.seats.filter(o => o !== seat)) {
                        const versus = record.versus[keyOf(other)] ||= { label: other.label, wins: 0, losses: 0, draws: 0 };
                        const mine = seat.equity.at(-1), theirs = other.equity.at(-1);
                        versus[mine > theirs ? 'wins' : mine < theirs ? 'losses' : 'draws']++;
                        versus.label = other.label;
                    }
                }
                const daily = round.problem.kind === 'daily' && round.problem.date === today;
                if (daily && record.daily.last !== today) {
                    record.daily.streak = record.daily.last === yesterday ? record.daily.streak + 1 : 1;
                    record.daily.last = today;
                    record.daily.best = Math.max(record.daily.best, record.daily.streak);
                }
                if (seat.kind === 'human') {
                    if (record.goals.date !== today) record.goals = { date: today, done: [] };
                    const met = { daily, 'blind-b': round.problem.kind !== 'known' && good(stats.grade), highlights: stats.highlights >= 3 };
                    for (const goal of GOALS) {
                        if (!met[goal.id] || record.goals.done.includes(goal.id)) continue;
                        record.goals.done.push(goal.id);
                        breakdown.push({ label: `今日目标：${goal.text}`, xp: goal.xp });
                    }
                }
                const fresh = [];
                let challenge = null;
                const run = record.challenge;
                if (round.challenge && seat.kind === 'human' && run?.activeRoundId === round.id) {
                    const before = run.cashCents, after = seat.equity.at(-1);
                    const crossed = CHALLENGE.marks.filter(mark => before < mark && after >= mark && !run.marks.includes(mark));
                    run.rounds++; run.cashCents = after; run.peakCents = Math.max(run.peakCents, after); run.marks.push(...crossed);
                    run.activeRoundId = null;
                    const result = after >= CHALLENGE.goalCents ? 'cleared' : after < CHALLENGE.bustCents ? 'bust' : null;
                    challenge = { run: run.run, round: run.rounds, beforeCents: before, afterCents: after, crossed, result };
                    if (result) {
                        record.challengeRuns = [{ run: run.run, result, rounds: run.rounds, endCents: after, peakCents: run.peakCents,
                            startedAt: run.startedAt, endedAt: now.toISOString() }, ...record.challengeRuns || []].slice(0, RUNS_KEPT);
                        record.challenge = freshRun(run.run + 1, now);
                    }
                }
                const unlock = id => {
                    if (record.achievements[id]) return;
                    record.achievements[id] = { at: now.toISOString(), roundId: round.id };
                    fresh.push(id);
                    const { name } = ACHIEVEMENTS.find(a => a.id === id);
                    breakdown.push({ label: `成就：${name}`, xp: XP.achievement });
                };
                unlock('first');
                for (const id of earned(round, seat, stats)) unlock(id);
                for (const { id, goal } of ACHIEVEMENTS) if (goal && progress(record, id) >= goal) unlock(id);
                if (challenge?.result === 'cleared') unlock('billion');
                const xp = breakdown.reduce((sum, item) => sum + item.xp, 0);
                record.xp += xp;
                const after = levelOf(record.xp);
                const next = NEXT_GRADE.find(([floor]) => stats.percentile < floor);
                const near = next && next[0] - stats.percentile <= 0.06 ? { grade: next[1], gap: Math.round((next[0] - stats.percentile) * 1e6) / 1e6 } : null;
                record.history.unshift({ roundId: round.id, at: now.toISOString(), mode: round.mode, kind: round.problem.kind,
                    strict: round.settings.strict, lengthDays: round.settings.lengthDays, fill: round.settings.fill, grade: stats.grade,
                    percentile: stats.percentile, returnRate: stats.returnRate, excess: stats.excess,
                    rank: result.ranking.indexOf(seat.id) + 1, of: round.seats.length,
                    opponents: round.seats.filter(o => o !== seat).map(o => o.label), outcome, xp });
                record.history.length = Math.min(record.history.length, HISTORY_KEPT);
                rewards[seat.id] = { key, xp, breakdown, before, after, levelUp: after.level > before.level, achievements: fresh,
                    personalBest, streak: record.streak, dailyStreak: record.daily.streak, near, outcome, ...(challenge ? { challenge } : {}) };
            }
            career.rewards[round.id] = { at: now.toISOString(), seats: rewards };
            const ids = Object.keys(career.rewards);
            for (const id of ids.slice(0, Math.max(0, ids.length - REWARDS_KEPT))) delete career.rewards[id];
            await atomicWrite(this.file, career);
            return rewards;
        });
    }
    // Reserves the player's challenge balance for one solo round; only one challenge round runs at a time.
    beginChallenge(roundId, now) {
        return this.serial(async () => {
            const career = await this.read();
            const record = career.players.player ||= blank({ kind: 'human', label: '玩家' });
            const run = record.challenge ||= freshRun(1, now);
            check(!run.activeRoundId || run.activeRoundId === roundId, 'CHALLENGE_ACTIVE', '资金挑战已有一局在进行，请先打完这一局，或重置挑战。');
            run.activeRoundId = roundId;
            await atomicWrite(this.file, career);
            return { cashCents: run.cashCents, run: run.run, round: run.rounds + 1 };
        });
    }
    cancelChallenge(roundId) {
        return this.serial(async () => {
            const career = await this.read(), run = career.players.player?.challenge;
            if (run?.activeRoundId !== roundId) return;
            run.activeRoundId = null;
            await atomicWrite(this.file, career);
        });
    }
    // Ends the current run (kept in the records) and starts again from 1 万. A round still being played no longer counts.
    resetChallenge(now) {
        return this.serial(async () => {
            const career = await this.read();
            const record = career.players.player ||= blank({ kind: 'human', label: '玩家' });
            const run = record.challenge;
            if (run && (run.rounds || run.activeRoundId)) {
                record.challengeRuns = [{ run: run.run, result: 'reset', rounds: run.rounds, endCents: run.cashCents, peakCents: run.peakCents,
                    startedAt: run.startedAt, endedAt: now.toISOString() }, ...record.challengeRuns || []].slice(0, RUNS_KEPT);
            }
            record.challenge = freshRun((run?.run ?? 0) + 1, now);
            await atomicWrite(this.file, career);
            return challengeView(record, now);
        });
    }
    async challenge(now) {
        const record = (await this.read()).players.player;
        return challengeView(record || {}, now);
    }
    // One record with its level, today's goals and every achievement with progress.
    async profile(key, now) {
        check(typeof key === 'string' && /^(player|agent:.{1,40})$/u.test(key), 'INVALID_ARGUMENT', '战绩标识无效。');
        const career = await this.read(), today = localDate(now);
        const record = career.players[key] || blank(key === 'player' ? { kind: 'human', label: '玩家' } : { kind: 'agent', agent: key.slice(6), label: key.slice(6) });
        const done = record.goals.date === today ? record.goals.done : [];
        return { key: record.key, kind: record.kind, label: record.label, xp: record.xp, level: levelOf(record.xp), rounds: record.rounds,
            grades: { ...record.grades }, best: record.best, streak: record.streak, bestStreak: record.bestStreak,
            daily: { ...record.daily, today: record.daily.last === today },
            goals: record.kind === 'human' ? GOALS.map(goal => ({ ...goal, done: done.includes(goal.id) })) : [],
            versus: structuredClone(record.versus),
            achievements: ACHIEVEMENTS.map(a => ({ ...a, got: Boolean(record.achievements[a.id]), at: record.achievements[a.id]?.at ?? null,
                ...(a.goal ? { progress: Math.min(a.goal, progress(record, a.id)) } : {}) })),
            history: record.history.slice(0, 50), challenge: challengeView(record, now) };
    }
    // The local leaderboard: everyone who has finished a round, by experience.
    async players() {
        const career = await this.read();
        return Object.values(career.players).map(r => ({ key: r.key, kind: r.kind, label: r.label, xp: r.xp, level: levelOf(r.xp).level,
            rounds: r.rounds, best: r.best, grades: { ...r.grades },
            averagePercentile: r.history.length ? Math.round(average(r.history.map(h => h.percentile)) * 1e4) / 1e4 : null }))
            .sort((a, b) => b.xp - a.xp || a.label.localeCompare(b.label));
    }
}

function challengeView(record, now) {
    const run = record.challenge || freshRun(1, now), runs = record.challengeRuns || [];
    const cleared = runs.filter(r => r.result === 'cleared');
    return { ...run, ...CHALLENGE, runs, best: cleared.length ? Math.min(...cleared.map(r => r.rounds)) : null };
}

module.exports = { Career, GOALS, ACHIEVEMENTS, CHALLENGE, XP, levelOf, keyOf };
