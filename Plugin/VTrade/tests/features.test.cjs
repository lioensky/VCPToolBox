'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TradeService } = require('../core/service.cjs');
const { createRegistry } = require('../core/builtins.cjs');
const { aggregate } = require('../core/minutes.cjs');

async function serviceFor(t, options = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vtrade-features-'));
    const service = await new TradeService(directory, { prewarm: false, ...options }).initialize();
    t.after(async () => { await service.close(); await fs.rm(directory, { recursive: true, force: true }); });
    return service;
}
test('directory simulation searches all securities and adds a discovered stock only when used', async t => {
    const service = await serviceFor(t);
    const dates = ['2020-01-02', '2020-01-03', '2020-01-06'];
    const securities = [
        { symbol: 'SH.000001', code: '000001', name: '合成指数', kind: 'index', scale: 100 },
        { symbol: 'SH.600001', code: '600001', name: '合成甲', kind: 'stock', scale: 100 },
        { symbol: 'SZ.000002', code: '000002', name: '合成乙', kind: 'stock', scale: 100 },
    ];
    service.marketDirectory = () => ({ root: path.join(os.tmpdir(), 'synthetic-vtrade-directory'),
        async securities() { return securities; },
        async securitiesAsOf() { return securities; },
        async bars(symbol) {
            assert.ok(securities.some(security => security.symbol === symbol));
            return { symbol, bars: dates.map((date, index) => ({ date,
                open: 1000 + 10 * index, high: 1030 + 10 * index, low: 990 + 10 * index,
                close: 1010 + 10 * index, volume: 100000 })) };
        } });
    const created = (await service.command({ command: 'CreateSession', marketMode: 'directory',
        requestId: 'directory-run', startDate: dates[0], initialCashCents: 10000000 })).observation;
    assert.equal(created.marketDirectory, true);
    assert.deepEqual(created.quotes, []);
    const search = (await service.command({ command: 'GetSessionSecurities', sessionId: created.sessionId,
        query: '000002' })).sessionSecurities;
    assert.deepEqual(search.securities.map(security => security.symbol), ['SZ.000002']);
    const before = (await service.command({ command: 'GetSessionQuotes', sessionId: created.sessionId,
        symbols: ['SZ.000002'] })).sessionQuotes.quotes[0];
    assert.equal(before.bars.at(-1).date, dates[0]);
    assert.equal((await service.command({ command: 'GetChart', sessionId: created.sessionId,
        symbol: 'SH.600001' })).chart.bars.at(-1).date, dates[0]);
    await assert.rejects(service.command({ command: 'PreviewOrder', sessionId: created.sessionId,
        expectedRevision: created.revision, observationId: created.observationId,
        symbol: 'SH.000001', side: 'buy', quantity: 100 }), { code: 'UNKNOWN_SYMBOL' });
    const preview = (await service.command({ command: 'PreviewOrder', sessionId: created.sessionId,
        expectedRevision: created.revision, observationId: created.observationId,
        symbol: 'SZ.000002', side: 'buy', quantity: 100 })).preview;
    assert.equal(preview.symbol, 'SZ.000002');
    const placed = (await service.command({ command: 'SubmitOrder', sessionId: created.sessionId,
        expectedRevision: created.revision, observationId: created.observationId,
        requestId: 'directory-order', symbol: 'SZ.000002', side: 'buy', quantity: 100 })).observation;
    assert.deepEqual(placed.quotes.map(quote => quote.symbol), ['SZ.000002']);
    const advanced = (await service.command({ command: 'AdvanceDay', sessionId: created.sessionId,
        expectedRevision: placed.revision, observationId: placed.observationId,
        requestId: 'directory-next' })).observation;
    assert.equal(advanced.date, dates[1]);
    assert.equal(advanced.account.positions[0].symbol, 'SZ.000002');
    assert.equal((await service.command({ command: 'GetSessionQuotes', sessionId: created.sessionId,
        symbols: ['SH.600001'] })).sessionQuotes.quotes[0].bars.at(-1).date, dates[1]);
    const screened = (await service.command({ command: 'ScreenBoard', sessionId: created.sessionId,
        boardId: 'all', analysis: 'ma', field: 'MA', operator: 'gt', value: 0,
        options: { period: 2 }, offset: 0, limit: 1 })).screening;
    assert.equal(screened.total, 2);
    assert.equal(screened.hasMore, true);
    assert.equal(screened.symbols.length, 1);
});
test('boards persist, share with universe and screen using only observed classic indicators', async t => {
    const service = await serviceFor(t);
    const added = (await service.command({ command: 'ChangeBoard', action: 'save', requestId: 'board-1',
        expectedRevision: 0, name: 'Synthetic pool', symbols: ['DEMO-A', 'DEMO-B'] })).boardState;
    assert.equal(added.boards.length, 1);
    const boardId = added.boardId;
    const universe = (await service.command({ command: 'GetUniverse', datasetId: 'demo-workbench', universe: 'boards' })).universe;
    assert.deepEqual(universe.groups.find(group => group.id === boardId).symbols, ['DEMO-A', 'DEMO-B']);
    const observation = (await service.command({ command: 'CreateSession', requestId: 'board-run',
        datasetId: 'demo-workbench', startDate: '2024-07-15', universe: 'boards', group: boardId })).observation;
    const selected = (await service.command({ command: 'ScreenBoard', sessionId: observation.sessionId,
        boardId, analysis: 'rsi', field: 'RSI', operator: 'gte', value: 0 })).screening;
    assert.equal(selected.asOf, observation.date);
    assert.ok(selected.symbols.every(symbol => ['DEMO-A', 'DEMO-B'].includes(symbol)));
    assert.equal((await service.command({ command: 'ListBoards' })).boardState.boards[0].name, 'Synthetic pool');
});
test('shared favorites become a simulation universe and survive run removal', async t => {
    const service = await serviceFor(t);
    await service.command({ command: 'ChangeBoard', action: 'favorites', requestId: 'favorites-1',
        expectedRevision: 0, symbols: ['DEMO-B', 'DEMO-A'] });
    const observation = (await service.command({ command: 'CreateSession', requestId: 'favorite-run',
        datasetId: 'demo-workbench', universe: 'boards', group: 'favorites' })).observation;
    assert.deepEqual(observation.quotes.map(quote => quote.symbol), ['DEMO-B', 'DEMO-A']);
    await assert.rejects(service.settings({ action: 'deleteSession', sessionId: observation.sessionId,
        expectedRevision: observation.revision + 1 }), { code: 'STALE_REVISION' });
    const removed = await service.settings({ action: 'deleteSession', sessionId: observation.sessionId,
        expectedRevision: observation.revision });
    assert.equal(removed.deletedSessionId, observation.sessionId);
    assert.equal((await service.command({ command: 'ListSessions' })).sessions.length, 0);
    assert.deepEqual((await service.command({ command: 'ListBoards' })).boardState.favorites, ['DEMO-B', 'DEMO-A']);
    await assert.rejects(service.command({ command: 'GetObservation', sessionId: observation.sessionId }), { code: 'NOT_FOUND' });
});
test('optional intraday points are browseable without a TDX directory and are never minute OHLCV', async t => {
    const registry = createRegistry();
    registry.register('tool', 'tencent-intraday', { description: 'Synthetic intraday points', network: true,
        async run({ asOf, session }, { symbol }) {
            assert.match(asOf, /^\d{4}-\d{2}-\d{2}$/); assert.deepEqual(session.symbols, [symbol]);
            return { symbol, date: '2025-01-10', source: 'Synthetic intraday',
                points: [{ time: '09:30', priceCents: 1000, cumulativeVolume: 100,
                    cumulativeAmountCents: 100000 }] };
        } });
    const service = await serviceFor(t, { registry });
    const result = (await service.browse({ action: 'intraday', symbol: 'SH.000000' })).intraday;
    assert.equal(result.points.length, 1);
    assert.equal(result.points[0].openCents, undefined);
});
test('minute imports aggregate inside sessions and simulation reads stop at its date', async t => {
    const service = await serviceFor(t);
    const data = { schemaVersion: 1, sourceId: 'minute-synthetic', dailyRef: 'demo-workbench',
        securities: [{ symbol: 'DEMO-A', bars: [
            ['2024-06-03T09:30', 1000], ['2024-06-03T09:31', 1010], ['2024-06-03T09:32', 1020],
            ['2024-06-03T13:00', 1030], ['2024-06-04T09:30', 1040],
        ].map(([timestamp, closeCents]) => ({ timestamp, openCents: closeCents, highCents: closeCents,
            lowCents: closeCents, closeCents, volume: 100 })) }] };
    const first = await service.ingestMinutes({ ...data, requestId: 'minute-1' });
    assert.equal(first.added, 5);
    assert.equal((await service.browse({ action: 'minuteSources' })).minuteSources[0].sourceId, data.sourceId);
    assert.equal((await service.browse({ action: 'minuteChart', sourceId: data.sourceId,
        symbol: 'DEMO-A', period: 5 })).minuteChart.bars.length, 3);
    const observation = (await service.command({ command: 'CreateSession', requestId: 'minute-run',
        datasetId: 'demo-workbench', startDate: '2024-06-03', symbols: ['DEMO-A'] })).observation;
    const chart = (await service.command({ command: 'GetMinuteChart', sessionId: observation.sessionId,
        sourceId: data.sourceId, symbol: 'DEMO-A', period: 5 })).minuteChart;
    assert.equal(chart.bars.length, 2);
    assert.equal(chart.bars[0].closeCents, 1020);
    assert.equal(chart.bars[1].timestamp, '2024-06-03T13:00');
    assert.equal(chart.bars.some(bar => bar.timestamp.startsWith('2024-06-04')), false);
    await assert.rejects(service.ingestMinutes({ ...data, requestId: 'minute-2', expectedVersion: 'bad' }),
        { code: 'STALE_DATA_VERSION' });
});
test('missing one-minute samples never mark a larger candle complete', () => {
    const bars = ['09:30', '09:31', '09:33', '09:34'].map((clock, index) => ({
        timestamp: `2025-01-10T${clock}`, openCents: 1000 + index,
        highCents: 1000 + index, lowCents: 1000 + index, closeCents: 1000 + index, volume: 100 }));
    const output = aggregate(bars, 5);
    assert.equal(output.length, 1);
    assert.equal(output[0].complete, false);
    assert.equal(output[0].volume, 400);
});
test('CSV minute import preserves source version and rejects a changed historical sample', async t => {
    const service = await serviceFor(t);
    const csv = 'symbol,timestamp,openCents,highCents,lowCents,closeCents,volume\nDEMO-A,2025-01-10T09:30,1000,1010,990,1005,100';
    const args = { format: 'csv', schemaVersion: 1, sourceId: 'minute-csv-synthetic', dailyRef: 'demo',
        csv, requestId: 'minute-csv-1' };
    const first = await service.ingestMinutes(args);
    assert.equal(first.added, 1);
    assert.equal((await service.ingestMinutes(args)).duplicate, true);
    await assert.rejects(service.ingestMinutes({ ...args, requestId: 'minute-csv-2', expectedVersion: first.version,
        csv: csv.replace('1005', '1006') }), { code: 'SOURCE_MISMATCH' });
});
test('classic indicator values match constant-price reference cases', async () => {
    const { calculateIndicator } = await import('../frontend/indicators.mjs');
    const bars = Array.from({ length: 40 }, (_, index) => ({ date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
        openCents: 1000, highCents: 1000, lowCents: 1000, closeCents: 1000, volume: 100 }));
    const value = id => calculateIndicator(id, bars).at(-1).values;
    assert.deepEqual(value('ma'), { MA: 1000 });
    assert.deepEqual(value('ema'), { EMA: 1000 });
    assert.deepEqual(value('boll'), { MID: 1000, UPPER: 1000, LOWER: 1000 });
    assert.deepEqual(value('macd'), { DIF: 0, DEA: 0, MACD: 0 });
    assert.deepEqual(value('kdj'), { K: 50, D: 50, J: 50 });
    assert.deepEqual(value('rsi'), { RSI: 100 });
});
test('chart indicator settings keep custom periods and reject invalid combinations', async () => {
    const { chartIndicatorSettings, calculateIndicator } = await import('../frontend/indicators.mjs');
    const settings = chartIndicatorSettings({ main: ['ma', 'ema', 'boll'], sub: ['macd', 'kdj', 'rsi'],
        params: { ma: { periods: [3, 8, 21] }, ema: { periods: [6, 13] },
            boll: { period: 10, multiplier: 2.5 }, macd: { fast: 6, slow: 19, signal: 5 },
            kdj: { period: 7, smoothK: 4, smoothD: 2 }, rsi: { period: 9 } } });
    assert.deepEqual(settings.params.ma.periods, [3, 8, 21]);
    assert.deepEqual(settings.params.ema.periods, [6, 13]);
    const bars = Array.from({ length: 24 }, (_, i) => ({ date: `2025-01-${String(i + 1).padStart(2, '0')}`,
        openCents: 1000 + i, highCents: 1000 + i, lowCents: 1000 + i, closeCents: 1000 + i, volume: 100 }));
    assert.equal(calculateIndicator('ma', bars, { period: settings.params.ma.periods[0] })[2].values.MA, 1001);
    assert.throws(() => chartIndicatorSettings({ params: { ma: { periods: [5, 5] } } }), /不能重复/);
    assert.throws(() => chartIndicatorSettings({ params: { macd: { fast: 26, slow: 12 } } }), /快线周期/);
});
test('chart indicator styles keep one valid colour and width per line, and hidden lists only shown indicators', async () => {
    const { chartIndicatorSettings, indicatorLines, LINE_COLORS } = await import('../frontend/indicators.mjs');
    const settings = chartIndicatorSettings({ main: ['ma'], sub: ['macd'], hidden: ['macd', 'rsi', 'macd'],
        params: { ma: { periods: [5, 10, 30] } },
        styles: { ma: [{ color: '#FF4FA3', width: 3 }, { color: 'url(x)', width: 9 }], macd: [{ color: 'accent', width: 2 }] } });
    assert.deepEqual(settings.styles.ma, [{ color: '#FF4FA3', width: 3 }, { color: LINE_COLORS[1], width: 1 }, { color: LINE_COLORS[2], width: 1 }]);
    assert.deepEqual(settings.styles.macd.map(s => s.color), ['accent', LINE_COLORS[1], LINE_COLORS[2]]);
    assert.deepEqual(settings.hidden, ['macd']);
    // Folding applies to shown sub-charts and the volume pane only.
    assert.deepEqual(chartIndicatorSettings({ sub: ['macd'], collapsed: ['macd', 'rsi', 'volume', 'ma', 'macd'] }).collapsed, ['macd', 'volume']);
    assert.deepEqual(indicatorLines('ma', settings.params.ma).map(l => l.key), ['MA5', 'MA10', 'MA30']);
    assert.deepEqual(indicatorLines('macd', settings.params.macd).map(l => [l.key, Boolean(l.bars)]), [['DIF', false], ['DEA', false], ['MACD', true]]);
    // Settings saved before line styles existed still load, with the default colours.
    assert.deepEqual(chartIndicatorSettings({ main: ['boll'], sub: [] }).styles.boll.map(s => s.color), LINE_COLORS.slice(0, 3));
});
test('classic indicators produce bounded, finite series', async t => {
    const service = await serviceFor(t);
    const observation = (await service.command({ command: 'CreateSession', requestId: 'classic-run',
        datasetId: 'demo-workbench', startDate: '2024-08-01', symbols: ['DEMO-A'] })).observation;
    for (const id of ['ema', 'boll', 'macd', 'kdj', 'rsi']) {
        const result = (await service.command({ command: 'GetAnalysis', sessionId: observation.sessionId,
            symbol: 'DEMO-A', analysis: id })).analysis;
        assert.ok(result.series.length > 0);
        assert.ok(result.series.every(row => row.date <= observation.date));
        assert.ok(result.series.every(row => Object.values(row.values).every(value => value === null || Number.isFinite(value))));
    }
});
test('blind training pair shares a reproducible start and reveals only on request', async t => {
    const service = await serviceFor(t);
    const input = { command: 'CreateTrainingPair', requestId: 'synthetic-pair', datasetId: 'demo-workbench',
        symbols: ['DEMO-A', 'DEMO-B'], randomSeed: 'seed-7', rangeFrom: '2024-07-01', rangeThrough: '2024-08-01', blind: true };
    const first = (await service.command(input)).trainingPair;
    assert.equal(first.human.date, first.agent.date);
    assert.equal(first.human.quotes[0].symbol, 'BLIND-A');
    assert.equal(first.human.quotes[0].name, '证券 A');
    assert.equal(first.human.training.revealed, false);
    const sessions = (await service.command({ command: 'ListSessions' })).sessions;
    assert.deepEqual(sessions.filter(item => item.training?.pairId === first.pairId)
        .map(item => item.training.role).sort(), ['agent', 'human']);
    assert.equal(JSON.stringify(first).includes('DEMO-A'), false);
    assert.equal(JSON.stringify(first).includes('DEMO-B'), false);
    const again = (await service.command(input)).trainingPair;
    assert.equal(again.duplicate, true);
    assert.equal(again.human.date, first.human.date);
    const chart = (await service.command({ command: 'GetChart', sessionId: first.human.sessionId,
        symbol: 'BLIND-A' })).chart;
    assert.ok(chart.bars.every(bar => bar.date <= first.human.date));
    const revealed = (await service.command({ command: 'RevealTraining', requestId: 'reveal-1',
        sessionId: first.human.sessionId, observationId: first.human.observationId,
        expectedRevision: first.human.revision })).observation;
    assert.ok(['DEMO-A', 'DEMO-B'].includes(revealed.training.original.symbol));
    const score = (await service.command({ command: 'GetTrainingResult', sessionId: first.human.sessionId })).trainingResult;
    assert.ok(Number.isFinite(score.totalReturn));
    assert.equal(score.revealed, true);
});
