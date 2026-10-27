export const PERIODS = Object.freeze(['day', 'week', 'month', 'quarter', 'year']);
export const AVERAGES = Object.freeze([5, 10, 20, 60]);
export function weekKey(date) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
    return d.toISOString().slice(0, 10);
}
// The first day of the bar's period; bars are keyed by it.
export function periodKey(date, period) {
    if (period === 'day') return date;
    if (period === 'week') return weekKey(date);
    const month = Number(date.slice(5, 7));
    if (period === 'month') return `${date.slice(0, 7)}-01`;
    if (period === 'quarter') return `${date.slice(0, 4)}-${String(month - (month - 1) % 3).padStart(2, '0')}-01`;
    return `${date.slice(0, 4)}-01-01`;
}
export function aggregateBars(input, period, asOf) {
    if (!PERIODS.includes(period)) throw new Error('Unsupported chart period');
    const groups = new Map();
    for (const b of input) {
        if (b.date > asOf) continue;
        const key = periodKey(b.date, period);
        const previous = groups.get(key);
        if (previous) {
            previous.highCents = Math.max(previous.highCents, b.highCents);
            previous.lowCents = Math.min(previous.lowCents, b.lowCents);
            previous.closeCents = b.closeCents;
            previous.volume += b.volume;
            if (b.amount !== undefined) previous.amount = (previous.amount || 0) + b.amount;
            previous.endDate = b.date;
        } else {
            groups.set(key, { ...b, key, startDate: b.date, endDate: b.date });
        }
    }
    return [...groups.values()];
}
export function tradeMarkers(orders, symbol, period, asOf) {
    return orders.filter(o => o.symbol === symbol && o.status === 'filled' && o.date <= asOf)
        .map(o => ({ ...o, key: periodKey(o.date, period) }));
}
// Simple moving average of closes over the whole history, then cut to the shown bars.
function average(all, shown, n) {
    const out = [];
    let sum = 0;
    for (let i = 0; i < all.length; i++) {
        sum += all[i].closeCents;
        if (i >= n) sum -= all[i - n].closeCents;
        if (i >= all.length - shown) out.push(i + 1 >= n ? sum / n : null);
    }
    return out;
}
export function chartModel(quote, orders, position, period, asOf, count = 30) {
    const all = aggregateBars(quote.bars, period, asOf);
    const bars = all.slice(-count);
    const keys = new Set(bars.map(b => b.key));
    const markers = tradeMarkers(orders, quote.symbol, period, asOf).filter(o => keys.has(o.key));
    const averageCostCents = position?.quantity > 0 ? position.costCents / position.quantity : null;
    const levels = bars.flatMap(b => [b.lowCents, b.highCents]).concat(markers.map(o => o.priceCents));
    if (averageCostCents !== null) levels.push(averageCostCents);
    const rawMin = levels.length ? Math.min(...levels) : 0;
    const rawMax = levels.length ? Math.max(...levels) : 1;
    const padding = Math.max((rawMax - rawMin) * .16, rawMax * .002, 1);
    const averages = Object.fromEntries(AVERAGES.map(n => [n, average(all, bars.length, n)]));
    return { bars, markers, averageCostCents, min: rawMin - padding, max: rawMax + padding, averages, movingAverage: averages[5] };
}
