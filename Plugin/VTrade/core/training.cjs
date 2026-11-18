'use strict';

const { check, hash } = require('./data.cjs');

function choose(m, { symbols, startDate, rangeFrom, rangeThrough, randomSeed }) {
    const pool = symbols ?? m.dataset.securities.map(item => item.symbol);
    check(Array.isArray(pool) && pool.length > 0 && pool.length <= 100
        && pool.every(symbol => m.bySymbol.has(symbol)), 'INVALID_ARGUMENT', '训练股票池无效。');
    const candidates = m.days.filter((date, index) => index >= 5 && index < m.days.length - 1
        && (!rangeFrom || date >= rangeFrom) && (!rangeThrough || date <= rangeThrough));
    check(candidates.length > 0, 'INVALID_ARGUMENT', '所选范围没有可训练的起始日。');
    if (startDate) check(candidates.includes(startDate), 'INVALID_ARGUMENT', '训练起始日不在所选范围。');
    const seed = String(randomSeed || 'training');
    const bits = hash(seed);
    const date = startDate || candidates[parseInt(bits.slice(0, 8), 16) % candidates.length];
    const available = pool.filter(symbol => m.bySymbol.get(symbol).bars.some(bar => bar.date === date));
    check(available.length > 0, 'INVALID_ARGUMENT', '所选日期没有股票池行情。');
    const symbol = available[parseInt(bits.slice(8, 16), 16) % available.length];
    return { date, symbol, seed };
}
function blindDataset(m, symbol, date) {
    const selected = m.bySymbol.get(symbol);
    const startIndex = selected.bars.findIndex(bar => bar.date === date);
    check(startIndex >= 0, 'INVALID_ARGUMENT', '所选证券在起始日没有日线。');
    const base = selected.bars[startIndex].closeCents;
    const scale = value => Math.max(1, Math.round(value * 10000 / base));
    let day = new Date('2000-01-03T00:00:00Z');
    const dates = selected.bars.map(() => {
        while ([0, 6].includes(day.getUTCDay())) day.setUTCDate(day.getUTCDate() + 1);
        const result = day.toISOString().slice(0, 10);
        day.setUTCDate(day.getUTCDate() + 1);
        return result;
    });
    const bars = selected.bars.map((bar, index) => ({ date: dates[index], openCents: scale(bar.openCents),
        highCents: scale(bar.highCents), lowCents: scale(bar.lowCents), closeCents: scale(bar.closeCents),
        volume: bar.volume,
        ...(bar.limitUpCents === undefined ? {} : { limitUpCents: scale(bar.limitUpCents) }),
        ...(bar.limitDownCents === undefined ? {} : { limitDownCents: scale(bar.limitDownCents) }) }));
    return { startDate: dates[startIndex], dataset: { schemaVersion: 1,
        source: { kind: 'training-blind', name: '匿名训练行情', adjustment: 'none',
            currency: 'CNY', timezone: 'Asia/Shanghai', volumeUnit: 'shares' },
        securities: [{ symbol: 'BLIND-A', name: '证券 A', bars }] } };
}
function result(state, m) {
    const first = state.equity[0], last = state.equity.at(-1);
    let peak = first.equityCents, maxDrawdown = 0;
    for (const row of state.equity) {
        peak = Math.max(peak, row.equityCents);
        maxDrawdown = Math.max(maxDrawdown, (peak - row.equityCents) / peak);
    }
    const sells = state.orders.filter(order => order.status === 'filled' && order.side === 'sell'
        && Number.isSafeInteger(order.realizedProfitCents));
    const wins = sells.filter(order => order.realizedProfitCents > 0);
    const gain = wins.reduce((sum, order) => sum + order.realizedProfitCents, 0);
    const loss = -sells.filter(order => order.realizedProfitCents < 0)
        .reduce((sum, order) => sum + order.realizedProfitCents, 0);
    const symbol = state.symbols[0], bars = m.bySymbol.get(symbol).bars;
    const start = bars.find(bar => bar.date === first.date), end = bars.filter(bar => bar.date <= last.date).at(-1);
    return { sessionId: state.id, asOf: last.date, days: state.equity.length - 1,
        totalReturn: (last.equityCents - first.equityCents) / first.equityCents,
        maxDrawdown, closedTrades: sells.length, winRate: sells.length ? wins.length / sells.length : null,
        profitLossRatio: loss > 0 ? gain / loss : null,
        averageHoldDays: sells.length ? sells.reduce((sum, order) => sum + (order.heldDays || 0), 0) / sells.length : null,
        buyHoldReturn: start && end ? end.closeCents / start.closeCents - 1 : null,
        stale: last.stale, revealed: state.training?.revealed || false,
        ...(state.training?.revealed ? { original: { symbol: state.training.originalSymbol,
            startDate: state.training.originalStartDate } } : {}) };
}
module.exports = { choose, blindDataset, result };
