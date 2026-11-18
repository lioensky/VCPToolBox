'use strict';

// 对决 rules shared by the round, the random-trader benchmark and the tests: price limits, the per-round ledger and
// the fill step. Fill prices, fees and limit checks come from the execution slot, as in simulated trading.
const { createHash } = require('node:crypto');
const { check, integer } = require('./data.cjs');
const { invokeSync } = require('./slots.cjs');

const LEVELS = Object.freeze([0, 25, 50, 75, 100]);
const STOPS = Object.freeze([0, 5, 8, 10]);
const HISTORY = 120;
const PROFILE = 'a-share-demo';

// Deterministic random numbers from a text seed, so a problem or a benchmark can be replayed.
function random(seed) {
    let counter = 0;
    const pool = [];
    return () => {
        if (!pool.length) {
            const digest = createHash('sha256').update(`${seed}:${counter++}`).digest();
            for (let i = 0; i < 32; i += 4) pool.push(digest.readUInt32BE(i) / 4294967296);
        }
        return pool.shift();
    };
}
// Calendar day in China, for the daily challenge and daily goals.
function localDate(now) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(p => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
}
// Daily price limits by board; ST names have 5%. ChiNext moved from 10% to 20% on 2020-08-24.
function limitRate(security, day) {
    if (security.kind === 'index') return null;
    if (/ST/i.test(security.name)) return 0.05;
    if (security.board === 'star') return 0.2;
    if (security.board === 'chinext') return day >= '2020-08-24' ? 0.2 : 0.1;
    if (security.board === 'bse') return 0.3;
    return 0.1;
}
// Limits from the previous close; widened when un-adjusted data crosses them (ex-rights days).
function withLimits(security, bars) {
    return bars.map((bar, i) => {
        const rate = limitRate(security, bar.date);
        if (rate === null || i === 0) return { ...bar };
        const previous = bars[i - 1].closeCents;
        return { ...bar, limitUpCents: Math.max(bar.highCents, Math.round(previous * (1 + rate))),
            limitDownCents: Math.min(bar.lowCents, Math.round(previous * (1 - rate))) };
    });
}

function ledger(cash) { return { cashCents: cash, shares: 0, costCents: 0, target: 0, stopPct: 0, unfilled: false }; }
function fee(costs, notional) { return Math.max(costs.minFeeCents, Math.ceil(notional * costs.feeBps / 10000)); }
// The bar a decision made on round day `day` fills at: the next day's open, or the decision day's close.
const fillIndex = (round, day) => round.settings.fill === 'open' ? HISTORY + day : HISTORY - 1 + day;
// Price for one side at the fill bar, or the reason it cannot fill. "open" asks the execution slot (next day's open
// with its slippage and limit rule); "close" fills at the decision day's close unless it closed at the limit against
// the order.
function quote(model, profile, fill, side, bar) {
    if (!bar || bar.volume === 0) return { rejected: '停牌或无成交量' };
    if (fill === 'close') {
        if (side === 'buy' && bar.limitUpCents !== undefined && bar.closeCents >= bar.limitUpCents) return { rejected: '收盘涨停，买入未成交' };
        if (side === 'sell' && bar.limitDownCents !== undefined && bar.closeCents <= bar.limitDownCents) return { rejected: '收盘跌停，卖出未成交' };
        return { priceCents: bar.closeCents };
    }
    const decision = invokeSync('execution', profile, () => model.settle({ side, quantity: 100, bar: { ...bar } }));
    if (decision?.rejected !== undefined) return { rejected: side === 'buy' ? '涨停开盘，买入未成交' : '跌停开盘，卖出未成交' };
    check(integer(decision?.priceCents, 1, 100000000), 'PROVIDER_FAILED', '撮合规则没有返回有效价格。');
    return { priceCents: decision.priceCents };
}
// Moves one ledger to its target position at the fill bar, in whole lots sized at the actual fill price.
// Holding a level never rebalances; callers only execute when the target changed or an order did not fill.
function execute(round, seat, target, index, model) {
    const book = seat.book, bar = round.bars[index], costs = model.costs, fill = round.settings.fill;
    const day = index - HISTORY + 1;
    // Stocks trade in lots of 100 shares; an index problem trades single units, like a fund that tracks it.
    const lot = round.lot ?? 100;
    const wanted = price => Math.floor((book.cashCents + book.shares * price) * target / 100 / price / lot) * lot;
    const reference = fill === 'open' ? bar.openCents : bar.closeCents;
    if (wanted(reference) === book.shares) return null;
    const side = wanted(reference) > book.shares ? 'buy' : 'sell';
    const priced = quote(model, round.profile, fill, side, bar);
    if (priced.rejected) return { day, index, side, failed: true, reason: priced.rejected };
    const price = priced.priceCents, want = wanted(price);
    if (side === 'buy') {
        let quantity = want - book.shares;
        while (quantity > 0 && quantity * price + fee(costs, quantity * price) > book.cashCents) quantity -= lot;
        if (quantity <= 0) return null;
        const paid = quantity * price + fee(costs, quantity * price);
        book.shares += quantity; book.costCents += paid; book.cashCents -= paid;
        return { day, index, side, quantity, priceCents: price, feeCents: paid - quantity * price };
    }
    if (want >= book.shares) return null;
    const quantity = book.shares - want, notional = quantity * price, charged = fee(costs, notional);
    const cost = Math.round(book.costCents * quantity / book.shares);
    book.shares -= quantity; book.costCents -= cost; book.cashCents += notional - charged;
    if (!book.shares) book.costCents = 0;
    return { day, index, side, quantity, priceCents: price, feeCents: charged, profitCents: notional - charged - cost };
}
function equityOf(book, bar) { return book.cashCents + book.shares * bar.closeCents; }

module.exports = { LEVELS, STOPS, HISTORY, PROFILE, random, localDate, limitRate, withLimits, ledger, fee, fillIndex, quote, execute, equityOf };
