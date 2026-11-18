'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../frontend/chart-model.mjs');
const bars = [
    { date: '2024-12-30', openCents: 1000, highCents: 1040, lowCents: 990, closeCents: 1030, volume: 100 },
    { date: '2024-12-31', openCents: 1020, highCents: 1050, lowCents: 1010, closeCents: 1040, volume: 200 },
    { date: '2025-01-02', openCents: 1030, highCents: 1060, lowCents: 1000, closeCents: 1050, volume: 300 },
    { date: '2025-01-03', openCents: 1040, highCents: 1080, lowCents: 1030, closeCents: 1070, volume: 400 },
    { date: '2025-01-06', openCents: 1070, highCents: 1100, lowCents: 1060, closeCents: 1090, volume: 500 },
];
test('weekly OHLCV uses actual observed sessions across calendar years', async () => {
    const { aggregateBars, weekKey } = await load();
    assert.equal(weekKey('2025-01-02'), '2024-12-30');
    const weekly = aggregateBars(bars, 'week', '2025-01-02');
    assert.equal(weekly.length, 1);
    assert.deepEqual([weekly[0].openCents, weekly[0].highCents, weekly[0].lowCents,
        weekly[0].closeCents, weekly[0].volume, weekly[0].endDate], [1000, 1060, 990, 1050, 600, '2025-01-02']);
    assert.equal(aggregateBars(bars, 'week', '2025-01-06').length, 2);
});
test('daily and weekly models cannot see future prices or executions', async () => {
    const { chartModel } = await load();
    const quote = { symbol: 'TEST', bars };
    const orders = [{ id: 'order-1', symbol: 'TEST', side: 'buy', status: 'filled', date: '2024-12-31', priceCents: 1021, quantity: 300 },
        { id: 'order-2', symbol: 'TEST', side: 'sell', status: 'filled', date: '2025-01-03', priceCents: 1039, quantity: 100 },
        { id: 'order-3', symbol: 'TEST', side: 'sell', status: 'pending', plannedDate: '2025-01-02', quantity: 100 }];
    for (const period of ['day', 'week']) {
        const m = chartModel(quote, orders, null, period, '2025-01-02');
        assert.ok(m.bars.every(b => b.endDate <= '2025-01-02'));
        assert.deepEqual(m.markers.map(o => o.id), ['order-1']);
        assert.ok(m.max < 1080);
    }
});
test('partial reductions remain separate events within a weekly candle', async () => {
    const { chartModel } = await load();
    const orders = ['2024-12-31', '2025-01-02', '2025-01-03'].map((date, i) => ({ id: `order-${i + 1}`,
        symbol: 'TEST', status: 'filled', side: i ? 'sell' : 'buy', date, priceCents: 1030, quantity: i ? 100 : 300 }));
    const original = JSON.stringify({ bars, orders });
    const m = chartModel({ symbol: 'TEST', bars }, orders, { quantity: 100, costCents: 103033 }, 'week', '2025-01-03');
    assert.equal(m.bars.length, 1); assert.equal(m.markers.length, 3);
    assert.deepEqual(m.markers.map(o => o.date), orders.map(o => o.date));
    assert.equal(m.averageCostCents, 1030.33);
    assert.equal(JSON.stringify({ bars, orders }), original);
});
const scale = () => import('../frontend/chart-scale.mjs');
test('time scale maps bars to pixels, zooms about the pointer and keeps bars in view', async () => {
    const { TimeScale } = await scale();
    const t = new TimeScale({ minSpacing: 0.5, maxSpacing: 48 });
    t.width = 600; t.count = 200; t.set(100, 160);
    assert.equal(t.spacing, 10); assert.equal(t.x(100), 5); assert.equal(t.nearest(t.x(130)), 130);
    assert.deepEqual(t.visible(), [100, 159]);
    const anchor = t.position(450);
    t.zoom(0.5, 450);
    assert.ok(Math.abs(t.position(450) - anchor) < 1e-9); assert.equal(t.spacing, 20);
    t.zoom(0.001, 300); assert.equal(t.spacing, 48);
    t.zoom(1e6, 300); assert.equal(t.spacing, 0.5);
    t.set(100, 160); t.pan(1e6);
    assert.equal(t.to, 1); assert.deepEqual(t.visible(), [0, 0]);
    t.set(100, 160); t.pan(-1e6);
    assert.equal(t.from, 199);
    t.set(100, 160); t.resize(300);
    assert.equal(t.to, 160); assert.equal(t.spacing, 10);
});
test('price ticks use round steps inside the range and keep the step precision', async () => {
    const { priceTicks, niceStep, decimalsOf, paddedRange } = await scale();
    assert.deepEqual([0.7, 3, 4.2, 7, 23].map(niceStep), [1, 5, 5, 10, 25]);
    assert.equal(decimalsOf(0.25), 2); assert.equal(decimalsOf(50), 0);
    assert.deepEqual(priceTicks(34.12, 41.3, 4), [36, 38, 40]);
    assert.deepEqual(priceTicks(9.98, 10.02, 4), [9.98, 9.99, 10, 10.01, 10.02]);
    assert.deepEqual(priceTicks(5, 5, 4), []);
    assert.deepEqual(paddedRange(10, 20, 0.1, 0.1), { min: 8.75, max: 21.25 });
    const flat = paddedRange(100000, 100000, 0, 0);
    assert.ok(flat.min < 100000 && flat.max > 100000);
});
test('time labels prefer year and month starts and keep their spacing', async () => {
    const { timeLabels, formatVolume } = await scale();
    const keys = ['2025-12-29', '2025-12-30', '2025-12-31', '2026-01-02', '2026-01-05', '2026-01-06', '2026-02-02', '2026-02-03'];
    const labels = timeLabels(keys, 1, keys.length - 1, i => i * 20, 50);
    assert.deepEqual(labels.map(l => l.text), ['2026', '2月']);
    assert.ok(labels.every((l, i) => !i || l.x - labels[i - 1].x >= 50));
    assert.deepEqual(timeLabels(keys, 4, 5, i => i * 100, 50).map(l => l.text), ['5日', '6日']);
    assert.deepEqual([980, 12345, 3456789, 123456789].map(formatVolume), ['980', '1.2万', '346万', '1.23亿']);
});
test('blind rounds label counted days: the first played day first, then every tenth day', async () => {
    const { timeLabels } = await scale();
    const keys = [...Array.from({ length: 40 }, (_, i) => `前${40 - i}`), ...Array.from({ length: 25 }, (_, i) => `第${i + 1}天`)];
    const labels = timeLabels(keys, 0, keys.length - 1, i => i * 10, 60);
    assert.ok(labels.some(l => l.text === '第1天'));
    assert.ok(labels.some(l => l.text === '前40' || l.text === '前20'));
    assert.ok(labels.every(l => l.text === '第1天' || Number(l.text.replace(/\D/g, '')) % 5 === 0), labels.map(l => l.text).join(' '));
    assert.ok(labels.every((l, i) => !i || l.x - labels[i - 1].x >= 60));
});
test('month, quarter and year bars start at their period and averages use the full history', async () => {
    const { periodKey, aggregateBars, chartModel } = await load();
    assert.deepEqual(['month', 'quarter', 'year'].map(p => periodKey('2025-08-14', p)), ['2025-08-01', '2025-07-01', '2025-01-01']);
    const yearly = aggregateBars(bars, 'year', '2025-01-06');
    assert.deepEqual(yearly.map(b => [b.key, b.openCents, b.closeCents, b.volume]), [['2024-01-01', 1000, 1040, 300], ['2025-01-01', 1030, 1090, 1200]]);
    const m = chartModel({ symbol: 'TEST', bars }, [], null, 'day', '2025-01-06', 2);
    assert.equal(m.bars.length, 2); assert.equal(m.averages[5][1], 1056); assert.equal(m.averages[10][1], null);
});
test('daily candles retain all OHLC fields and MA5 uses observed closes', async () => {
    const { chartModel } = await load();
    const m = chartModel({ symbol: 'TEST', bars }, [], null, 'day', '2025-01-06');
    assert.deepEqual(m.bars.map(b => [b.openCents, b.highCents, b.lowCents, b.closeCents]),
        bars.map(b => [b.openCents, b.highCents, b.lowCents, b.closeCents]));
    assert.deepEqual(m.movingAverage, [null, null, null, null, 1056]);
});
