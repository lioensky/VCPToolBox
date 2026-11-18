'use strict';

// VTrade 对决: people and Agents trade the same historical problem one day at a time. Every seat decides a target
// position after the day's close; when all seats have decided, the round settles every seat and shows the next day.
// A round keeps its own small ledger (one security, whole lots, target positions) and takes fill prices, fees and
// limit rules from the execution slot, so its costs follow the same rules as simulated trading.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { check, hash, text, date, workbenchDemoDataset } = require('./data.cjs');
const { atomicWrite } = require('./store.cjs');
const { LEVELS, STOPS, HISTORY, PROFILE, random, localDate, limitRate, withLimits, ledger, fillIndex, execute, equityOf } = require('./duel-rules.cjs');
const { highlights, score } = require('./duel-score.cjs');
const { Career } = require('./duel-career.cjs');
const { financials } = require('./builtins.cjs');
const { turnText, decisionText, resultText, guideText, invitationText } = require('./duel-text.cjs');

const LENGTHS = Object.freeze([60]);
const CASH = Object.freeze([1000000, 10000000, 100000000]);
const DEFAULTS = Object.freeze({ lengthDays: 60, initialCashCents: 10000000, fill: 'open', strict: false, challenge: false });
const MAX_SEATS = 4;
const LISTED_BARS = 250;
const ID = /^duel-[a-f0-9]{16}$/;
const SEAT = /^seat-[1-4]$/;
const AGENT = /^[\p{L}\p{N}][\p{L}\p{N} _.·-]{0,39}$/u;
// Agent avatars the orchestrator sends: small PNG, JPEG or WebP data URLs.
const AVATAR = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const AVATAR_MAX = 96 * 1024;
// The orchestrator polls invites every few seconds; longer silence means Chat is not inviting Agents.
const ORCHESTRATOR_QUIET_MS = 15000;
// Agents are asked for a one- or two-sentence conclusion and write their analysis in the reply itself; this bound
// only keeps a runaway reason from flooding the page, cutting at the last clause that fits rather than mid-word.
const REASON_MAX = 600;
// A reason as players read it: without the quote marks models wrap it in.
function reasonText(value, fallback = '') {
    const clean = text(value, fallback, 2000).replace(/^[「『“"'\s]+|[」』”"'\s]+$/g, '');
    if (clean.length <= REASON_MAX) return clean;
    const head = clean.slice(0, REASON_MAX), cut = Math.max(...['。', '；', '！', '？', '，', ';', ',', '、'].map(mark => head.lastIndexOf(mark)));
    return cut >= REASON_MAX / 2 ? head.slice(0, cut + 1) : head;
}
const TICKET = /^(duel-[a-f0-9]{16})\.(seat-[1-4])\.(\d{1,3})\.([a-f0-9]{24})$/;
const TOOL_COMMANDS = new Set(['GetDuelGuide', 'GetDuelTurn', 'SubmitDuelDecision', 'GetDuelResult']);
const KINDS = ['blind', 'daily', 'known', 'classic'];
// 名局重现: well-known stretches of the main indices, offered only when the local data covers them and played blind.
// Names describe the situation visible before the start, never what happens next.
const CLASSICS = Object.freeze([
    { id: 'after-rally-2015', name: '大涨一年之后', symbol: 'SH.000001', startDate: '2015-06-15' },
    { id: 'growth-2015', name: '成长股连涨之中', symbol: 'SZ.399006', startDate: '2015-04-01' },
    { id: 'after-fall-2018', name: '高位回落之后', symbol: 'SH.000001', startDate: '2018-06-01' },
    { id: 'after-bear-2019', name: '下跌一年之后', symbol: 'SH.000001', startDate: '2019-01-04' },
    { id: 'calm-2020', name: '平静之中', symbol: 'SH.000001', startDate: '2020-01-13' },
    { id: 'bluechip-2017', name: '蓝筹温和上行', symbol: 'SH.000016', startDate: '2017-03-01' },
    { id: 'slump-2024', name: '持续低迷之中', symbol: 'SH.000001', startDate: '2024-08-26' },
]);

// Problems come from the local TDX directory when one is set, otherwise from the synthetic demo dataset.
function directorySource(directory) {
    return {
        kind: 'tdx',
        async securities() { return (await directory.securities()).filter(s => s.kind === 'stock' || s.kind === 'index'); },
        async bars(security) {
            const cents = (value, scale) => Math.round(value * 100 / scale);
            return (await directory.bars(security.symbol, 20000)).bars.map(bar => ({ date: bar.date,
                openCents: cents(bar.open, bar.scale), highCents: cents(bar.high, bar.scale), lowCents: cents(bar.low, bar.scale),
                closeCents: cents(bar.close, bar.scale), volume: bar.volume, amount: bar.amount ?? null }));
        },
    };
}
// The market to compare against: 沪深 300 over the round's days, from the same directory. Each round bar takes the
// index close on its date, or the last one before it; a round before the index existed, or a source without it (the
// demo data), has none.
const BENCHMARK = Object.freeze({ symbol: 'SH.000300', name: '沪深 300' });
async function benchmarkFor(source, bars) {
    const index = (await source.securities()).find(s => s.symbol === BENCHMARK.symbol);
    if (!index) return null;
    const series = await source.bars(index);
    const closes = [];
    let k = 0, last = null;
    for (const bar of bars) {
        while (k < series.length && series[k].date <= bar.date) last = series[k++].closeCents;
        closes.push(last);
    }
    return closes[HISTORY - 1] ? { name: BENCHMARK.name, closes } : null;
}
function demoSource() {
    const data = workbenchDemoDataset();
    const list = data.securities.map(s => ({ symbol: s.symbol, code: s.symbol, name: s.name, kind: 'stock', board: 'demo', bars: s.bars }));
    return {
        kind: 'demo',
        async securities() { return list; },
        async bars(security) { return security.bars.map(({ limitUpCents, limitDownCents, suspended, ...bar }) => ({ ...bar, amount: null })); },
    };
}
// Fundamentals from the administrator's financial file (tools.financials, as written by scripts/vtrade_download.py).
// A round keeps the reports of its own security announced by its last day; each day shows the latest one announced
// by then. Market values use that report's share counts and the day's close.
const METRICS = ['totalShare', 'liqaShare', 'epsTTM', 'bps', 'roeAvg', 'roe', 'YOYNI', 'netProfitYoY'];
function fundamentalsAt(round, day) {
    if (!round.reports?.length) return null;
    const bar = round.bars[HISTORY - 1 + day], report = round.reports.filter(r => r.publishedAt <= bar.date).at(-1);
    if (!report) return null;
    const m = report.metrics, close = bar.closeCents, value = (x, f) => (Number.isFinite(x) && x !== 0 ? f(x) : null);
    return { period: report.period,
        marketCapCents: value(m.totalShare, x => Math.round(x * close)), floatCapCents: value(m.liqaShare, x => Math.round(x * close)),
        pe: value(m.epsTTM, x => Math.round(close / 100 / x * 100) / 100), pb: value(m.bps, x => Math.round(close / 100 / x * 100) / 100),
        roe: m.roeAvg ?? (Number.isFinite(m.roe) ? m.roe / 100 : null), profitGrowth: m.YOYNI ?? (Number.isFinite(m.netProfitYoY) ? m.netProfitYoY / 100 : null) };
}
function maxGapDays(bars) {
    let gap = 0;
    for (let i = 1; i < bars.length; i++) gap = Math.max(gap, (Date.parse(bars[i].date) - Date.parse(bars[i - 1].date)) / 86400000);
    return gap;
}
// A window of HISTORY bars before the start plus lengthDays bars to play.
function windowAt(security, bars, start, lengthDays) {
    const slice = bars.slice(start - HISTORY, start + lengthDays);
    return { symbol: security.symbol, code: security.code, name: security.name, board: security.board,
        startDate: slice[HISTORY].date, endDate: slice.at(-1).date, bars: withLimits(security, slice) };
}
async function randomProblem(source, seed, settings) {
    const next = random(seed);
    const pool = (await source.securities()).filter(s => s.kind === 'stock' && !/ST|退/.test(s.name));
    check(pool.length, 'MARKET_UNAVAILABLE', '没有可出题的股票。');
    const listed = source.kind === 'demo' ? 0 : LISTED_BARS;
    for (let attempt = 0; attempt < 80; attempt++) {
        const security = pool[Math.floor(next() * pool.length)];
        const bars = await source.bars(security).catch(() => []);
        const first = listed + HISTORY, last = bars.length - settings.lengthDays;
        if (last < first) continue;
        const start = first + Math.floor(next() * (last - first + 1));
        const problem = windowAt(security, bars, start, settings.lengthDays);
        const affordable = problem.bars[HISTORY - 1].closeCents * 100 <= settings.initialCashCents * 0.9;
        if (affordable && maxGapDays(problem.bars) <= 14) return problem;
    }
    check(false, 'MARKET_UNAVAILABLE', '没有找到合适的题目：需要上市满一年、停牌不多、起始资金买得起一手的股票。');
}
async function knownProblem(source, symbol, startDate, settings) {
    const security = (await source.securities()).find(s => s.symbol === symbol);
    check(security, 'UNKNOWN_SYMBOL', '数据中没有该股票。');
    const bars = await source.bars(security);
    const start = bars.findIndex(bar => bar.date >= startDate);
    check(start >= HISTORY && start + settings.lengthDays <= bars.length, 'INVALID_ARGUMENT',
        `起始日前需要 ${HISTORY} 根日线，之后需要 ${settings.lengthDays} 根日线。`);
    return { ...windowAt(security, bars, start, settings.lengthDays), kind: security.kind };
}
async function availableClassics(source) {
    const out = [];
    for (const classic of CLASSICS) {
        const ok = await knownProblem(source, classic.symbol, classic.startDate, { lengthDays: DEFAULTS.lengthDays }).then(() => true, () => false);
        if (ok) out.push({ id: classic.id, name: classic.name });
    }
    return out;
}

function normalizeSettings(input = {}) {
    check(input !== null && typeof input === 'object' && !Array.isArray(input), 'INVALID_ARGUMENT', '对局设置须为对象。');
    const settings = { ...DEFAULTS, ...input };
    check(LENGTHS.includes(settings.lengthDays), 'INVALID_ARGUMENT', `局长目前只支持 ${LENGTHS.join('、')} 个交易日。`);
    check(typeof settings.challenge === 'boolean', 'INVALID_ARGUMENT', 'challenge 须为布尔值。');
    // A 资金挑战 round starts with the challenge balance, set when the round is created.
    check(settings.challenge || CASH.includes(settings.initialCashCents), 'INVALID_ARGUMENT', '起始资金只能是 1 万、10 万或 100 万元。');
    check(['open', 'close'].includes(settings.fill), 'INVALID_ARGUMENT', '成交价须为 open（次日开盘）或 close（当天收盘）。');
    check(typeof settings.strict === 'boolean', 'INVALID_ARGUMENT', 'strict 须为布尔值。');
    return { lengthDays: settings.lengthDays, initialCashCents: settings.initialCashCents, fill: settings.fill, strict: settings.strict,
        ...(settings.challenge ? { challenge: true } : {}) };
}
function normalizeSeats(input) {
    check(Array.isArray(input) && input.length >= 1 && input.length <= MAX_SEATS, 'INVALID_ARGUMENT', `需要 1 至 ${MAX_SEATS} 个座位。`);
    check(input.filter(s => s?.kind === 'human').length <= 1, 'INVALID_ARGUMENT', '一局最多一位玩家。');
    const agents = new Set();
    return input.map((seat, i) => {
        check(seat && ['human', 'agent'].includes(seat.kind), 'INVALID_ARGUMENT', '座位类型须为 human 或 agent。');
        if (seat.kind === 'agent') {
            check(typeof seat.agent === 'string' && AGENT.test(seat.agent) && !agents.has(seat.agent),
                'INVALID_ARGUMENT', 'Agent 名称无效或重复。');
            agents.add(seat.agent);
        }
        return { id: `seat-${i + 1}`, kind: seat.kind, ...(seat.kind === 'agent' ? { agent: seat.agent } : {}),
            label: text(seat.label, seat.kind === 'human' ? '玩家' : seat.agent, 40) };
    });
}
const modeOf = seats => seats.some(s => s.kind === 'human') ? (seats.length === 1 ? 'solo' : 'duel') : seats.length === 1 ? 'watch' : 'duel';

// The settle step: every seat applies its sealed decision, then the next day becomes visible with its highlights.
function advance(round, model) {
    const seen = HISTORY - 1 + round.day, next = seen + 1, at = fillIndex(round, round.day);
    const row = { day: round.day + 1, entries: {} };
    for (const seat of round.seats) {
        const book = seat.book, decided = round.pending[seat.id] || { target: book.target, reason: '' };
        let target = decided.target, reason = decided.reason || '', stopped = false;
        if (decided.stopPct !== undefined) book.stopPct = decided.stopPct;
        if (book.stopPct && book.shares && round.bars[seen].closeCents * book.shares <= book.costCents * (1 - book.stopPct / 100)) {
            target = 0; stopped = true; reason = `收盘价较成本跌超 ${book.stopPct}%，触发止损`;
        }
        const before = book.target;
        book.target = target;
        const fill = target !== before || book.unfilled || stopped ? execute(round, seat, target, at, model) : null;
        book.unfilled = Boolean(fill?.failed);
        if (fill) seat.fills.push(fill);
        const equity = equityOf(book, round.bars[next]);
        seat.equity.push(equity);
        seat.positions.push(round.bars[next].closeCents * book.shares / equity);
        row.entries[seat.id] = { before, target, reason, stopped, ...(fill ? { fill } : {}), equityCents: equity };
    }
    for (const seat of round.seats) row.entries[seat.id].highlights = highlights(round, seat, row.entries[seat.id]);
    const hold = round.hold;
    hold.push(Math.round(hold[0] * round.bars[next].closeCents / round.holdPriceCents));
    round.log.push(row);
    round.pending = {};
    round.day++;
    if (round.day >= round.settings.lengthDays) round.status = 'finished';
    return row;
}

// What a seat may see: bars up to the current day; the security and dates only once revealed; strict blind rebases
// prices to 100 at the start and shows volume relative to its 20-day average.
function project(round, { revealAll = false } = {}) {
    const revealed = revealAll || round.revealed || round.problem.kind === 'known';
    const visible = round.bars.slice(0, HISTORY + round.day);
    const base = round.bars[HISTORY - 1].closeCents, strict = round.settings.strict && !revealed;
    const price = value => value === undefined ? undefined : strict ? Math.round(value * 10000 / base) : value;
    const label = i => revealed ? round.bars[i].date : i < HISTORY ? `前${HISTORY - i}` : `第${i - HISTORY + 1}天`;
    const bars = visible.map((bar, i) => {
        const volumes = round.bars.slice(Math.max(0, i - 19), i + 1).map(b => b.volume);
        return { key: label(i), ...(revealed ? { date: bar.date } : {}),
            openCents: price(bar.openCents), highCents: price(bar.highCents), lowCents: price(bar.lowCents), closeCents: price(bar.closeCents),
            ...(strict ? { relativeVolume: Math.round(bar.volume / (volumes.reduce((a, b) => a + b, 0) / volumes.length) * 100) / 100 }
                : { volume: bar.volume, amount: bar.amount }),
            ...(bar.limitUpCents === undefined ? {} : { limitUpCents: price(bar.limitUpCents), limitDownCents: price(bar.limitDownCents) }) };
    });
    const seats = round.seats.map(seat => ({ id: seat.id, kind: seat.kind, ...(seat.agent ? { agent: seat.agent } : {}), label: seat.label,
        equityCents: seat.equity.at(-1), returnRate: seat.equity.at(-1) / seat.equity[0] - 1,
        position: seat.positions.at(-1), target: seat.book.target, shares: seat.book.shares, cashCents: seat.book.cashCents,
        costCents: seat.book.costCents, stopPct: seat.book.stopPct, decided: Boolean(round.pending[seat.id]),
        equity: [...seat.equity], positions: seat.positions.map(p => Math.round(p * 10000) / 10000),
        fills: seat.fills.map(f => ({ ...f })) }));
    const classic = round.problem.kind === 'classic' ? { classic: round.problem.classic, classicName: round.problem.classicName } : {};
    // Strict blind hides fundamentals too; a blind round hides the report period, which would date the problem.
    const facts = strict ? null : fundamentalsAt(round, round.day);
    // 沪深 300 up to the current day as returns since the start, without levels or dates, so it cannot date the problem.
    const marketBase = round.benchmark?.closes[HISTORY - 1];
    const market = marketBase ? { name: round.benchmark.name, returns: Array.from({ length: round.day + 1 }, (_, d) => {
        const close = round.benchmark.closes[HISTORY - 1 + d];
        return close ? Math.round((close / marketBase - 1) * 1e6) / 1e6 : null;
    }) } : null;
    const fundamentals = facts && (revealed ? facts : (({ period, ...rest }) => rest)(facts));
    const problem = revealed ? { kind: round.problem.kind, symbol: round.problem.symbol, code: round.problem.code, name: round.problem.name,
        board: round.problem.board, startDate: round.problem.startDate, endDate: round.problem.endDate, ...classic }
        : { kind: round.problem.kind, label: round.problem.kind === 'classic' ? '指数 A' : '证券 A', ...classic };
    return { id: round.id, revision: round.revision, mode: round.mode, status: round.status, day: round.day,
        paused: Boolean(round.paused), ...(round.pauseAt === undefined ? {} : { pauseAt: round.pauseAt }),
        lengthDays: round.settings.lengthDays, settings: { ...round.settings }, source: round.source, revealed, lot: round.lot ?? 100,
        ...(round.challenge ? { challenge: { ...round.challenge } } : {}), ...(fundamentals ? { fundamentals } : {}),
        ...(market ? { benchmark: market } : {}),
        strict, problem, bars, seats, hold: [...round.hold],
        log: round.log.map(row => ({ day: row.day, entries: structuredClone(row.entries) })),
        ...(round.result ? { result: structuredClone(round.result) } : {}),
        notice: '虚拟资金和历史行情，不连接券商，不构成投资建议。理财有风险，投资需谨慎。' };
}

// Decision tickets: each Agent seat gets a fresh one every turn. The orchestrator reads them through the
// authenticated page interface and hands each to its own Agent; tool calls cannot list them, so an Agent can only
// decide for the seat it was invited to, in that turn.
function mint(round) {
    round.tickets = {};
    if (round.status !== 'active') return;
    for (const seat of round.seats) if (seat.kind === 'agent') round.tickets[seat.id] = randomBytes(12).toString('hex');
}
const ticketOf = (round, seatId) => round.tickets?.[seatId] ? `${round.id}.${seatId}.${round.day}.${round.tickets[seatId]}` : null;
function parseTicket(value) {
    const match = typeof value === 'string' && TICKET.exec(value.trim());
    check(match, 'INVALID_TICKET', '决策票据格式不对。请原样复制编排器给你的 ticket。');
    return { id: match[1], seatId: match[2], day: Number(match[3]), token: match[4] };
}
function checkTicket(round, ticket) {
    const seat = round.seats.find(s => s.id === ticket.seatId), stored = round.tickets?.[ticket.seatId];
    check(round.status === 'active', 'FINISHED', '本局已结束，用 GetDuelResult 看成绩。');
    check(ticket.day === round.day, 'STALE_TICKET', '这张票据属于已经过去的回合。请等编排器的新邀请，不要沿用旧票据。');
    check(seat?.kind === 'agent' && stored && timingSafeEqual(Buffer.from(stored), Buffer.from(ticket.token)),
        'INVALID_TICKET', '决策票据和这一局的座位不符。');
    return seat;
}

class DuelService {
    constructor(trade) {
        this.trade = trade;
        this.directory = path.join(trade.store.directory, 'duels');
        this.career = new Career(this.directory, (key, operation) => trade.store.serial(key, operation));
        this.orchestratorSeenAt = null;
        // When the orchestrator last handed each Agent seat its invitation, per round and day (memory only).
        this.invitations = new Map();
    }
    async open() { await fs.mkdir(this.directory, { recursive: true }); }
    file(id) {
        check(typeof id === 'string' && ID.test(id), 'INVALID_ROUND', '对局标识不合法。');
        return path.join(this.directory, `${id}.json`);
    }
    async read(id) {
        try { return JSON.parse(await fs.readFile(this.file(id), 'utf8')); }
        catch (error) {
            check(error.code !== 'ENOENT', 'NOT_FOUND', '对局不存在。');
            check(false, 'CORRUPT_SAVE', '对局存档不可读取，已保留原文件。');
        }
    }
    async write(round) {
        await atomicWrite(this.file(round.id), round);
        if (this.activeIds) { if (round.status === 'active') this.activeIds.add(round.id); else this.activeIds.delete(round.id); }
    }
    // Ids of the rounds still being played: read from disk once, then kept up to date by write(), so the orchestrator's
    // polling stays cheap however many finished rounds are kept.
    async activeRounds() {
        if (!this.activeIds) {
            const ids = new Set();
            for (const name of await fs.readdir(this.directory).catch(() => [])) {
                if (!/^duel-[a-f0-9]{16}\.json$/.test(name)) continue;
                const round = await this.read(name.slice(0, -5)).catch(() => null);
                if (round?.status === 'active') ids.add(round.id);
            }
            this.activeIds ??= ids;
        }
        return [...this.activeIds];
    }
    serial(id, operation) { return this.trade.store.serial(`duel:${id}`, operation); }
    source() {
        if (this.trade.options.duelSource) return this.trade.options.duelSource;
        const directory = this.trade.marketDirectory(false);
        return directory ? directorySource(directory) : demoSource();
    }
    // Stocks use the A-share demo rules (limits, lots); index problems have no limits and use the reference rules.
    model(profile = PROFILE) { return this.trade.registry.get('execution', profile); }
    now() { return this.trade.options.now?.() ?? new Date(); }
    async reports(symbol, endDate) {
        const { options, readFile } = this.trade.localSources.toolContext('financials');
        if (!readFile || typeof options.file !== 'string') return null;
        try {
            const data = financials(JSON.parse((await readFile(options.file, 16 * 1024 * 1024)).toString('utf8')));
            return (data.securities.get(symbol) || []).filter(r => r.publishedAt && r.publishedAt <= endDate)
                .map(r => ({ period: r.period, publishedAt: r.publishedAt,
                    metrics: Object.fromEntries(METRICS.filter(k => Number.isFinite(r.metrics[k])).map(k => [k, r.metrics[k]])) }));
        } catch { return null; }
    }

    // input: { requestId?, problem: { kind: 'blind' | 'daily' | 'known', symbol?, startDate?, seed?, date? }, settings?, seats }
    async create(input) {
        check(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_ARGUMENT', '参数须为对象。');
        const settings = normalizeSettings(input.settings), seats = normalizeSeats(input.seats);
        const kind = input.problem?.kind ?? 'blind';
        check(KINDS.includes(kind), 'INVALID_ARGUMENT', '出题方式须为 blind、daily、known 或 classic。');
        check(!settings.challenge || seats.length === 1 && seats[0].kind === 'human', 'INVALID_ARGUMENT', '资金挑战只用于单练。');
        const key = input.requestId === undefined ? randomBytes(16).toString('hex') : text(input.requestId, '', 100);
        check(/^[A-Za-z0-9_-]{1,100}$/.test(key), 'INVALID_REQUEST', 'requestId 须为 1 至 100 字符的字母、数字、下划线或连字符。');
        const id = `duel-${hash(['duel', key]).slice(0, 16)}`;
        return this.serial(id, async () => {
            const existing = await this.read(id).catch(error => error.code === 'NOT_FOUND' ? null : Promise.reject(error));
            const signature = hash({ settings, seats, problem: input.problem ?? null });
            if (existing) {
                check(existing.signature === signature, 'REQUEST_CONFLICT', '同一建局请求不能更换设置。');
                return { duplicate: true, round: project(existing) };
            }
            const source = this.source();
            const day = kind === 'daily' ? date(input.problem?.date ?? localDate(this.now())) : null;
            const seed = day ? `daily:${day}` : text(input.problem?.seed, key, 100);
            const classic = kind === 'classic' ? CLASSICS.find(c => c.id === input.problem?.classic) : null;
            check(kind !== 'classic' || classic, 'INVALID_ARGUMENT', '没有这一局名局重现。');
            // The challenge balance is reserved for this round first, so two rounds cannot spend it twice.
            const challenge = settings.challenge ? await this.career.beginChallenge(id, this.now()) : null;
            if (challenge) settings.initialCashCents = challenge.cashCents;
            let problem;
            try {
                problem = classic ? await knownProblem(source, classic.symbol, classic.startDate, settings)
                    : kind === 'known' ? await knownProblem(source, input.problem.symbol, input.problem.startDate, settings)
                        : await randomProblem(source, seed, settings);
            } catch (error) {
                if (challenge) await this.career.cancelChallenge(id);
                throw error;
            }
            const profile = problem.kind === 'index' ? 'reference' : PROFILE;
            const reports = problem.kind === 'index' ? null : await this.reports(problem.symbol, problem.endDate);
            const benchmark = await benchmarkFor(source, problem.bars).catch(() => null);
            this.model(profile);
            const cash = settings.initialCashCents;
            const holdPriceCents = settings.fill === 'open' ? problem.bars[HISTORY].openCents : problem.bars[HISTORY - 1].closeCents;
            const { bars, kind: securityKind, ...identity } = problem;
            const round = { schemaVersion: 1, id, signature, revision: 0, createdAt: this.now().toISOString(),
                mode: modeOf(seats), status: 'active', day: 0, settings, profile, lot: securityKind === 'index' ? 1 : 100, source: source.kind,
                problem: { kind, seed: classic ? `classic:${classic.id}` : seed, ...(day ? { date: day } : {}),
                    ...(classic ? { classic: classic.id, classicName: classic.name } : {}), ...identity }, bars,
                ...(challenge ? { challenge: { run: challenge.run, round: challenge.round, startCents: challenge.cashCents } } : {}),
                ...(reports?.length ? { reports } : {}), ...(benchmark ? { benchmark } : {}),
                seats: seats.map(seat => ({ ...seat, book: ledger(cash), equity: [cash], positions: [0], fills: [] })),
                pending: {}, log: [], hold: [cash], holdPriceCents, revealed: false, turnAt: this.now().toISOString() };
            mint(round);
            await this.write(round);
            return { duplicate: false, round: project(round) };
        });
    }
    async view(id) { return project(await this.read(id)); }
    // Seals one seat's decision for the current day; the round settles when every seat has decided. The last day
    // scores the round and records it in the career. guard(round) runs first and names the seat (ticket checks).
    // A timeout keeps the seat's current target.
    async decide(id, input, guard = null) {
        check(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_ARGUMENT', '参数须为对象。');
        return this.serial(id, async () => {
            const round = await this.read(id);
            const guarded = guard?.(round);
            check(round.status === 'active', 'FINISHED', '本局已结束。');
            check(input.day === undefined || input.day === round.day, 'STALE_DAY', '回合已变化，请重新读取局面。');
            const seat = guarded || round.seats.find(s => s.id === input.seatId);
            check(seat && SEAT.test(seat.id), 'INVALID_SEAT', '座位不存在。');
            if (input.timeout) input = { ...input, target: seat.book.target };
            check(LEVELS.includes(input.target), 'INVALID_ARGUMENT', '目标仓位 target 只能是 0、25、50、75 或 100。');
            check(input.stopPct === undefined || STOPS.includes(input.stopPct), 'INVALID_ARGUMENT', '止损 stopPct 只能是 0、5、8 或 10，不设可省略。');
            check(!round.pending[seat.id], 'ALREADY_DECIDED', '这一回合已经决定过了。');
            round.pending[seat.id] = { target: input.target, ...(input.stopPct === undefined ? {} : { stopPct: input.stopPct }),
                reason: reasonText(input.reason), at: this.now().toISOString(), ...(input.timeout ? { timeout: true } : {}) };
            let settled = null;
            if (round.seats.every(s => round.pending[s.id])) {
                const model = this.model(round.profile);
                settled = advance(round, model);
                round.turnAt = this.now().toISOString();
                mint(round);
                // "推进一天" ends here: the round pauses again once the day it was stepped to has settled.
                if (round.pauseAt !== undefined && round.day >= round.pauseAt) { round.paused = true; delete round.pauseAt; }
                if (round.status === 'finished') {
                    round.result = score(round, model);
                    round.result.rewards = await this.career.record(round, this.now());
                }
            }
            round.revision++;
            await this.write(round);
            return { settled: settled ? { day: settled.day, entries: structuredClone(settled.entries) } : null, round: project(round),
                seatId: seat.id, ticket: ticketOf(round, seat.id) };
        });
    }
    // Pausing stops inviting Agents; a decision already on its way is still accepted. Stepping lets the Agents play one
    // more day and pauses again. Only rounds with Agent seats pause: a player alone simply stops deciding.
    pause(id, how) {
        return this.serial(id, async () => {
            const round = await this.read(id);
            check(round.status === 'active', 'FINISHED', '本局已结束。');
            check(round.seats.some(s => s.kind === 'agent'), 'INVALID_ARGUMENT', '只有 Agent 参加的对局才能暂停。');
            if (how === 'pause') { round.paused = true; delete round.pauseAt; }
            else if (how === 'resume') { round.paused = false; delete round.pauseAt; }
            else { round.paused = false; round.pauseAt = round.day + 1; }
            round.revision++;
            await this.write(round);
            return { round: this.withOrchestrator(project(round)) };
        });
    }
    async reveal(id) {
        return this.serial(id, async () => {
            const round = await this.read(id);
            check(round.status === 'finished', 'NOT_FINISHED', '对局结束后才能揭晓。');
            if (!round.revealed) { round.revealed = true; round.revision++; await this.write(round); }
            return { round: project(round) };
        });
    }
    async list() {
        const rounds = [];
        for (const name of await fs.readdir(this.directory).catch(() => [])) {
            if (!/^duel-[a-f0-9]{16}\.json$/.test(name)) continue;
            const round = await this.read(name.slice(0, -5)).catch(() => null);
            if (round) rounds.push({ id: round.id, mode: round.mode, status: round.status, day: round.day, createdAt: round.createdAt,
                paused: Boolean(round.paused), awaiting: round.status === 'active' ? [...new Set(round.seats.filter(s => !round.pending[s.id]).map(s => s.kind))] : [],
                lengthDays: round.settings.lengthDays, kind: round.problem.kind, strict: round.settings.strict,
                seats: round.seats.map(s => ({ id: s.id, kind: s.kind, label: s.label,
                    ...(round.result ? { grade: round.result.seats[s.id].grade, returnRate: round.result.seats[s.id].returnRate } : {}) })) });
        }
        return rounds.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    profile(key = 'player') { return this.career.profile(key, this.now()); }
    players() { return this.career.players(); }

    // Agent seats waiting for a decision, with their tickets, for the orchestrator. Each call also tells the page that
    // an orchestrator is running.
    async invites() {
        this.orchestratorSeenAt = Date.now();
        const out = [];
        for (const id of await this.activeRounds()) {
            const round = await this.read(id).catch(() => null);
            if (round?.status !== 'active' || round.paused) continue;
            for (const seat of round.seats) {
                if (seat.kind !== 'agent' || round.pending[seat.id]) continue;
                out.push({ roundId: round.id, seatId: seat.id, agent: seat.agent, label: seat.label, mode: round.mode, day: round.day,
                    lengthDays: round.settings.lengthDays, turnAt: round.turnAt, ticket: ticketOf(round, seat.id) });
            }
        }
        return out.sort((a, b) => a.turnAt.localeCompare(b.turnAt));
    }
    // The turn for one seat; for an Agent seat waiting to decide, also the invitation the orchestrator sends it.
    async turn(id, seatId, { reminder = false } = {}) {
        const round = await this.read(id), seat = round.seats.find(s => s.id === seatId);
        check(seat, 'INVALID_SEAT', '座位不存在。');
        const view = project(round), ticket = ticketOf(round, seat.id);
        if (ticket) {
            const key = `${round.id}:${seatId}:${round.day}`, previous = this.invitations.get(key);
            this.invitations.set(key, { at: Date.now(), count: (previous?.count ?? 0) + 1 });
        }
        return { roundId: round.id, seatId, day: round.day, status: round.status, decided: Boolean(round.pending[seatId]), ticket,
            text: turnText(view, seatId, ticket), ...(ticket ? { invitation: invitationText(view, seatId, ticket, { reminder }) } : {}) };
    }
    // Whether an orchestrator (VCPChat's game hall) has asked for invites recently; without one Agent seats wait.
    orchestrator() {
        const quietMs = this.orchestratorSeenAt === null ? null : Date.now() - this.orchestratorSeenAt;
        return { connected: quietMs !== null && quietMs < ORCHESTRATOR_QUIET_MS, quietMs };
    }
    // For rounds with Agent seats: the orchestrator's state, and for each Agent seat still deciding today, how long ago
    // it was invited and how many invitations it has had.
    withOrchestrator(view) {
        if (!view.seats.some(s => s.kind === 'agent')) return view;
        const invited = {};
        for (const seat of view.seats) {
            const sent = seat.kind === 'agent' && !seat.decided && this.invitations.get(`${view.id}:${seat.id}:${view.day}`);
            if (sent) invited[seat.id] = { sinceMs: Date.now() - sent.at, count: sent.count };
        }
        return { ...view, orchestrator: { ...this.orchestrator(), invited } };
    }
    // The Chat Agents the orchestrator offers, with small avatars, so the page lists them however it was opened.
    async syncRoster(input) {
        check(Array.isArray(input.agents) && input.agents.length <= 200, 'INVALID_ARGUMENT', 'agents 须为不超过 200 项的数组。');
        const agents = [];
        for (const agent of input.agents) {
            const name = typeof agent?.name === 'string' ? agent.name.trim() : '';
            if (!AGENT.test(name) || agents.some(a => a.name === name)) continue;
            const avatar = typeof agent.avatar === 'string' && agent.avatar.length <= AVATAR_MAX && AVATAR.test(agent.avatar) ? agent.avatar : null;
            agents.push({ name, ...(avatar ? { avatar } : {}) });
        }
        const roster = { updatedAt: this.now().toISOString(), agents };
        await atomicWrite(path.join(this.directory, 'roster.json'), roster);
        return { updatedAt: roster.updatedAt, count: agents.length };
    }
    async roster() {
        const saved = await fs.readFile(path.join(this.directory, 'roster.json'), 'utf8').then(JSON.parse).catch(() => null);
        return { agents: Array.isArray(saved?.agents) ? saved.agents : [], updatedAt: saved?.updatedAt ?? null, orchestrator: this.orchestrator() };
    }
    // An Agent that did not answer in time keeps its position for the day.
    hold(id, input) {
        check(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_ARGUMENT', '参数须为对象。');
        return this.decide(id, { day: input.day, reason: reasonText(input.reason, '超时未提交，维持原仓位'), timeout: true }, round => {
            const seat = round.seats.find(s => s.id === input.seatId);
            check(seat?.kind === 'agent', 'INVALID_SEAT', '只有 Agent 座位可以在超时后维持原仓位。');
            return seat;
        });
    }

    // VCP tool commands for Agents. Answers are plain text.
    async tool(args) {
        const command = args.command;
        check(TOOL_COMMANDS.has(command), 'UNKNOWN_COMMAND', '未知的对决命令。');
        if (command === 'GetDuelGuide') return { text: guideText() };
        if (command === 'GetDuelResult') {
            const round = await this.read(args.roundId);
            check(round.status === 'finished', 'NOT_FINISHED', '本局还没结束。');
            return { text: resultText(project(round)) };
        }
        const ticket = parseTicket(args.ticket);
        if (command === 'GetDuelTurn') {
            const round = await this.read(ticket.id);
            checkTicket(round, ticket);
            return { text: turnText(project(round), ticket.seatId, ticketOf(round, ticket.seatId)) };
        }
        const number = value => value === '' ? undefined : typeof value === 'string' && /^\s*\d+(?:\.\d+)?\s*%?\s*$/.test(value) ? Number(value.replace(/[\s%]/g, '')) : value;
        const result = await this.decide(ticket.id, { target: number(args.target), stopPct: number(args.stopPct), reason: args.reason },
            round => {
                const seat = checkTicket(round, ticket);
                check(typeof args.reason === 'string' && args.reason.trim(), 'INVALID_ARGUMENT',
                    'reason 必填，没有收到：请在工具块里单独写一行 reason:「始」一句理由「末」（仓位不变也要写），「始」「末」不能省略，否则参数不会送达。');
                return seat;
            });
        const parts = [decisionText(result.round, ticket.seatId, result.settled)];
        if (result.settled && result.round.status === 'active') parts.push(turnText(result.round, ticket.seatId, result.ticket));
        if (result.round.status === 'finished') parts.push(resultText(result.round));
        return { text: parts.join('\n\n') };
    }
    // The authenticated page interface: the player's own decisions, round setup and the orchestrator's calls.
    async page(input) {
        check(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_ARGUMENT', '参数须为对象。');
        const strip = ({ round, settled }) => ({ round: this.withOrchestrator(round), settled });
        switch (input.action) {
        case 'create': return this.create(input);
        case 'view': return { round: this.withOrchestrator(await this.view(input.roundId)) };
        case 'decide': return strip(await this.decide(input.roundId, input, round => {
            const seat = round.seats.find(s => s.id === input.seatId);
            check(seat?.kind === 'human', 'INVALID_SEAT', '页面只能替玩家座位交决定。');
            return seat;
        }));
        case 'hold': return strip(await this.hold(input.roundId, input));
        case 'reveal': return this.reveal(input.roundId);
        case 'pause': case 'resume': case 'step': return this.pause(input.roundId, input.action);
        case 'list': return { rounds: await this.list() };
        case 'profile': return { profile: await this.profile(input.key) };
        case 'players': return { players: await this.players() };
        case 'invites': return { invites: await this.invites() };
        case 'roster': return { roster: await this.roster() };
        case 'syncRoster': return { roster: await this.syncRoster(input) };
        case 'classics': return { classics: await availableClassics(this.source()) };
        case 'challenge': return { challenge: await this.career.challenge(this.now()) };
        case 'challengeReset': return { challenge: await this.career.resetChallenge(this.now()) };
        case 'turn': return { turn: await this.turn(input.roundId, input.seatId, { reminder: input.reminder === true }) };
        default: check(false, 'INVALID_ARGUMENT', '未知的对决操作。');
        }
    }
}

module.exports = { DuelService, TOOL_COMMANDS, CLASSICS, LEVELS, STOPS, HISTORY, LENGTHS, CASH, DEFAULTS, limitRate, withLimits, project, advance, random };
