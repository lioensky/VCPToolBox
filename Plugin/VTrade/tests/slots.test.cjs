'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { TradeService } = require('../core/service.cjs');
const { createRegistry } = require('../core/builtins.cjs');
const { TradeError } = require('../core/data.cjs');
const tencent = require('../adapters/tencent-intraday.cjs');
const examples = require('../examples/extensions.cjs');

const bar = (date, closeCents = 1000, extra = {}) => ({ date, openCents: 1000, highCents: 1100, lowCents: 900, closeCents, volume: 10000, ...extra });
const dataset = (bars, symbol = 'TEST-SLOT') => ({ schemaVersion: 1,
    source: { kind: 'example-feed', name: 'Synthetic slot fixture', adjustment: 'none', currency: 'CNY', timezone: 'Asia/Shanghai', volumeUnit: 'shares' },
    securities: [{ symbol, name: 'Synthetic instrument', bars }] });
async function setup(t, { sources, registry = createRegistry(), ...options } = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vtrade-slots-'));
    let sourcesFile;
    if (sources) {
        sourcesFile = path.join(directory, 'sources.json');
        await fs.writeFile(sourcesFile, JSON.stringify(await sources(directory)));
    }
    const open = () => new TradeService(path.join(directory, 'store'), { registry, sourcesFile, ...options }).initialize();
    let service = await open();
    t.after(async () => { await service.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); });
    return { directory, registry, get service() { return service; },
        command(args) { return service.command(args); },
        async reopen() { await service.close(); service = await open(); } };
}
const bound = (o, command, requestId, extra = {}) => ({ command, sessionId: o.sessionId, expectedRevision: o.revision,
    observationId: o.observationId, requestId, ...extra });
const demo = async (x, extra = {}) => (await x.command({ command: 'CreateSession', requestId: 'demo-run', datasetId: 'demo', ...extra })).observation;

test('registry enforces each slot contract, rejects duplicates and only removes external registrations', () => {
    const registry = createRegistry();
    const invalid = { code: 'INVALID_PROVIDER' };
    assert.throws(() => registry.register('strategy', 'x-y', { description: 'x', run() {} }), invalid);
    assert.throws(() => registry.register('market', 'Bad_Id', { description: 'x', load() {} }), invalid);
    assert.throws(() => registry.register('market', 'no-load', { description: 'x' }), invalid);
    assert.throws(() => registry.register('analysis', 'no-type', { description: 'x', compute() {} }), invalid);
    assert.throws(() => registry.register('broker', 'no-caps', { description: 'x' }), invalid);
    assert.throws(() => registry.register('tool', 'v2', { description: 'x', contractVersion: 2, run() {} }), invalid);
    assert.throws(() => registry.register('market', 'tdx', { description: 'x', load() {} }), { code: 'DUPLICATE_PROVIDER' });
    const dispose = registry.register('tool', 'my-tool', { description: 'Synthetic tool', run: () => ({}) });
    assert.equal(registry.list().tool.find(t => t.id === 'my-tool').network, false);
    dispose(); assert.equal(registry.has('tool', 'my-tool'), false); dispose();
    registry.register('tool', 'my-tool', { description: 'Synthetic tool', run: () => ({}) });
    registry.removeExternal();
    assert.equal(registry.has('tool', 'my-tool'), false); assert.equal(registry.has('tool', 'financials'), true);
    assert.throws(() => registry.get('execution', 'missing'), { code: 'PROVIDER_UNAVAILABLE' });
    const listed = registry.list();
    assert.deepEqual(Object.keys(listed), ['market', 'analysis', 'universe', 'execution', 'broker', 'tool']);
    assert.deepEqual(listed.broker, [{ id: 'none', builtin: true, description: listed.broker[0].description, live: false }]);
});

test('plugin entry accepts registrations before initialize, loads no adapter by default and drops extensions on shutdown', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vtrade-plugin-'));
    const plugin = require('../VTrade.js');
    t.after(async () => { await plugin.shutdown(); await fs.rm(directory, { recursive: true, force: true }); });
    plugin.register('analysis', 'early-signal', { type: 'signal', description: 'Registered before VTrade starts', compute: () => ({ signals: [] }) });
    await plugin.initialize({ VTRADE_DATA_DIR: directory });
    const call = async args => JSON.parse((await plugin.processToolCall(args)).result.content[0].text);
    const listed = (await call({ command: 'ListExtensions' })).extensions;
    assert.ok(listed.analysis.some(a => a.id === 'early-signal' && !a.builtin));
    assert.ok(!listed.tool.some(t => t.id === 'tencent-intraday'));
    const o = (await call({ command: 'CreateSession', requestId: 'plugin-run', datasetId: 'demo' })).observation;
    const result = await call({ command: 'GetAnalysis', sessionId: o.sessionId, symbol: 'DEMO-A', analysis: 'ma', options: '{"period":3}', limit: '2' });
    assert.equal(result.analysis.series.length, 2); assert.deepEqual(result.analysis.options, { period: 3 });
    assert.equal((await call({ command: 'GetAnalysis', sessionId: o.sessionId, symbol: 'DEMO-A', options: '{bad' })).code, 'INVALID_ARGUMENT');
    await plugin.shutdown();
    await plugin.initialize({ VTRADE_DATA_DIR: directory, VTRADE_ADAPTERS: 'tencent-intraday' });
    const reloaded = (await call({ command: 'ListExtensions' })).extensions;
    assert.ok(!reloaded.analysis.some(a => a.id === 'early-signal'));
    assert.ok(reloaded.tool.some(t => t.id === 'tencent-intraday' && t.network));
    await plugin.shutdown();
    await assert.rejects(plugin.initialize({ VTRADE_DATA_DIR: directory, VTRADE_ADAPTERS: '../core/service' }), /adapter name/);
});

test('a registered market implementation feeds versioned sources; a missing one fails closed without fallback', async t => {
    let bars = [bar('2025-01-06'), bar('2025-01-07')];
    const seen = [];
    const registry = createRegistry();
    registry.register('market', 'example-feed', { description: 'Synthetic market implementation',
        load(request) { seen.push(request); return dataset(bars); } });
    const x = await setup(t, { registry, sources: () => ({ schemaVersion: 1,
        sources: [{ id: 'feed-example', kind: 'example-feed', name: 'Example', options: { token: 'synthetic' } }] }) });
    const first = (await x.command({ command: 'SyncSource', sourceId: 'feed-example', requestId: 's1' })).sync;
    assert.equal(seen[0].config.options.token, 'synthetic'); assert.equal(seen[0].readFile, undefined);
    assert.ok(seen[0].signal instanceof AbortSignal); assert.equal(typeof seen[0].completedThrough, 'string');
    let o = (await x.command({ command: 'CreateSession', requestId: 'feed-run', sourceId: 'feed-example', rulesProfile: 'reference' })).observation;
    o = (await x.command(bound(o, 'SubmitOrder', 'o1', { symbol: 'TEST-SLOT', side: 'buy', quantity: 100 }))).observation;
    bars = [...bars, bar('2025-01-08')];
    const next = (await x.command({ command: 'SyncSource', sourceId: 'feed-example', requestId: 's2', expectedDataVersion: first.datasetId })).sync;
    assert.equal(next.added, 1);
    o = (await x.command(bound(o, 'SyncSessionData', 'attach', { datasetId: next.datasetId }))).observation;
    o = (await x.command(bound(o, 'AdvanceDay', 'day'))).observation;
    assert.equal(o.orders[0].status, 'filled');
    x.registry.removeExternal();
    await assert.rejects(x.command({ command: 'SyncSource', sourceId: 'feed-example', requestId: 's3', expectedDataVersion: next.datasetId }), { code: 'PROVIDER_UNAVAILABLE' });
    assert.equal((await x.command({ command: 'GetDataStatus', sourceId: 'feed-example' })).dataStatus.datasetId, next.datasetId);
    await x.reopen();
    assert.equal((await x.command({ command: 'GetObservation', sessionId: o.sessionId })).observation.date, '2025-01-08');
    x.registry.register('market', 'example-feed', { description: 'Broken', load() { throw new Error('internal-detail-xyz'); } });
    const error = await x.command({ command: 'SyncSource', sourceId: 'feed-example', requestId: 's4', expectedDataVersion: next.datasetId }).catch(e => e);
    assert.equal(error.code, 'PROVIDER_FAILED'); assert.ok(!error.message.includes('internal-detail-xyz'));
});

test('analysis implementations see only observed bars; future output, bad shapes and slow calls are rejected', async t => {
    const registry = createRegistry();
    let latest;
    registry.register('analysis', 'peek', { type: 'signal', description: 'Synthetic signal', compute: ({ bars, asOf }) => {
        latest = bars.at(-1).date; assert.equal(latest, asOf);
        return { signals: [{ date: asOf, action: 'watch', strength: 0.5, note: ' synthetic ' }] };
    } });
    registry.register('analysis', 'future', { type: 'indicator', description: 'Synthetic', compute: () => ({ series: [{ date: '2099-01-01', values: { x: 1 } }] }) });
    registry.register('analysis', 'shape', { type: 'indicator', description: 'Synthetic', compute: () => ({ series: [{ date: '2024-06-03', values: { x: 'NaN' } }] }) });
    registry.register('analysis', 'slow', { type: 'signal', description: 'Synthetic', compute: ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
    }) });
    const x = await setup(t, { registry, providerTimeoutMs: 50 });
    const o = await demo(x, { datasetId: 'demo-workbench', startDate: '2024-09-02' });
    const ask = extra => x.command({ command: 'GetAnalysis', sessionId: o.sessionId, symbol: 'DEMO-A', ...extra });
    const ma = (await ask({ options: { period: 5 }, limit: 3 })).analysis;
    const chart = (await x.command({ command: 'GetChart', sessionId: o.sessionId, symbol: 'DEMO-A', limit: 5 })).chart.bars;
    assert.equal(ma.series.at(-1).date, o.date);
    assert.equal(ma.series.at(-1).values.ma, Math.round(chart.reduce((a, b) => a + b.closeCents, 0) / 5));
    const cross = (await ask({ analysis: 'ma-cross', options: { fast: 3, slow: 8 }, limit: 1000 })).analysis;
    assert.ok(cross.signals.length > 0 && cross.signals.every(s => s.date <= o.date && ['buy', 'sell'].includes(s.action)));
    assert.deepEqual((await ask({ analysis: 'peek' })).analysis.signals, [{ date: o.date, action: 'watch', strength: 0.5, note: 'synthetic' }]);
    await assert.rejects(ask({ analysis: 'future' }), { code: 'FUTURE_DATA' });
    await assert.rejects(ask({ analysis: 'shape' }), { code: 'PROVIDER_FAILED' });
    await assert.rejects(ask({ analysis: 'slow' }), { code: 'PROVIDER_TIMEOUT' });
    await assert.rejects(ask({ analysis: 'ma', options: { period: 1 } }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(ask({ analysis: 'missing' }), { code: 'PROVIDER_UNAVAILABLE' });
    await assert.rejects(ask({ symbol: 'DEMO-Z' }), { code: 'UNKNOWN_SYMBOL' });
});

test('built-in indicators work on long real-length histories (more than 5000 observed bars)', async t => {
    const x = await setup(t);
    const bars = [];
    for (let d = new Date('2000-01-03T00:00:00Z'); bars.length < 6000; d.setUTCDate(d.getUTCDate() + 1)) {
        if (![0, 6].includes(d.getUTCDay())) bars.push(bar(d.toISOString().slice(0, 10), 1000 + bars.length % 50));
    }
    const imported = await x.service.importDataset(dataset(bars));
    const o = (await x.command({ command: 'CreateSession', requestId: 'long', datasetId: imported.datasetId, startDate: bars.at(-2).date })).observation;
    const ma = (await x.command({ command: 'GetAnalysis', sessionId: o.sessionId, symbol: 'TEST-SLOT', options: { period: 20 }, limit: 3 })).analysis;
    assert.deepEqual(ma.series.map(s => s.date), bars.slice(-4, -1).map(b => b.date));
});
test('universe groups choose the session pool at its start date and are recorded in the run manifest', async t => {
    const registry = createRegistry();
    let asked;
    registry.register('universe', 'example-pools', { description: 'Synthetic groups', groups: ({ asOf, securities }) => {
        asked = asOf;
        return { groups: [{ id: 'first', name: 'First two', symbols: [securities[0].symbol, securities[1].symbol, 'NOT-IN-DATA'] },
            { id: 'third', symbols: [securities[2].symbol] }] };
    } });
    const x = await setup(t, { registry });
    const view = (await x.command({ command: 'GetUniverse', datasetId: 'demo', universe: 'example-pools', asOf: '2025-01-10' })).universe;
    assert.equal(asked, '2025-01-10');
    assert.deepEqual(view.groups[0], { id: 'first', name: 'First two', symbols: ['DEMO-A', 'DEMO-B'], missing: 1 });
    assert.deepEqual((await x.command({ command: 'GetUniverse', datasetId: 'demo' })).universe.groups[0].symbols, ['DEMO-A', 'DEMO-B', 'DEMO-C']);
    await assert.rejects(demo(x, { universe: 'example-pools' }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(x.command({ command: 'CreateSession', requestId: 'both', datasetId: 'demo', universe: 'all', symbols: ['DEMO-A'] }), { code: 'INVALID_ARGUMENT' });
    const o = (await x.command({ command: 'CreateSession', requestId: 'pool', datasetId: 'demo', universe: 'example-pools', group: 'first' })).observation;
    assert.equal(asked, o.date);
    assert.deepEqual(o.quotes.map(q => q.symbol), ['DEMO-A', 'DEMO-B']);
    assert.deepEqual(o.universe, { id: 'example-pools', group: 'first', asOf: o.date });
    const manifest = (await x.command({ command: 'GetRunManifest', sessionId: o.sessionId })).manifest;
    assert.deepEqual(manifest.universe, o.universe); assert.deepEqual(manifest.symbols, ['DEMO-A', 'DEMO-B']);
});

test('execution implementations price fills; the ledger still enforces range, limit, budget and synchronous rules', async t => {
    const registry = createRegistry();
    let mode = 'close';
    registry.register('execution', 'example-close', { description: 'Synthetic close fill', costs: { feeCents: 0 },
        settle: ({ bar }) => mode === 'close' ? { priceCents: bar.closeCents, feeCents: 0 }
            : mode === 'cheap' ? { priceCents: bar.lowCents - 1, feeCents: 0 }
                : mode === 'async' ? Promise.resolve({ rejected: 'later' }) : { rejected: '  synthetic rule  ' } });
    const x = await setup(t, { registry });
    let o = await demo(x, { rulesProfile: 'example-close' });
    assert.deepEqual(o.rules, { lotSize: 100, feeCents: 0, sellDelay: 1 });
    const order = (o, id, extra = {}) => x.command(bound(o, 'SubmitOrder', id, { symbol: 'DEMO-A', side: 'buy', quantity: 100, ...extra }));
    o = (await order(o, 'b1')).observation;
    o = (await x.command(bound(o, 'AdvanceDay', 'd1'))).observation;
    const close = (await x.command({ command: 'GetChart', sessionId: o.sessionId, symbol: 'DEMO-A', limit: 2 })).chart.bars.at(-1).closeCents;
    assert.equal(o.orders[0].priceCents, close); assert.equal(o.orders[0].feeCents, 0);
    mode = 'cheap'; o = (await order(o, 'b2')).observation; o = (await x.command(bound(o, 'AdvanceDay', 'd2'))).observation;
    assert.equal(o.orders[1].status, 'unfilled'); assert.match(o.orders[1].reason, /最低或最高/);
    mode = 'close'; o = (await order(o, 'b3', { limitPriceCents: 1 })).observation; o = (await x.command(bound(o, 'AdvanceDay', 'd3'))).observation;
    assert.equal(o.orders[2].reason, '参考价不满足限价。');
    mode = 'reject'; o = (await order(o, 'b4')).observation; o = (await x.command(bound(o, 'AdvanceDay', 'd4'))).observation;
    assert.equal(o.orders[3].reason, 'synthetic rule');
    mode = 'async'; o = (await order(o, 'b5')).observation;
    await assert.rejects(x.command(bound(o, 'AdvanceDay', 'd5')), { code: 'PROVIDER_FAILED' });
    const after = (await x.command({ command: 'GetObservation', sessionId: o.sessionId })).observation;
    assert.equal(after.revision, o.revision); assert.equal(after.orders[4].status, 'pending');
    x.registry.removeExternal();
    await x.reopen();
    const orphan = (await x.command({ command: 'GetObservation', sessionId: o.sessionId })).observation;
    assert.equal(orphan.executionUnavailable, true);
    await assert.rejects(x.command(bound(orphan, 'AdvanceDay', 'd6')), { code: 'PROVIDER_UNAVAILABLE' });
    await assert.rejects(x.command({ command: 'CreateSession', requestId: 'new-run', datasetId: 'demo', rulesProfile: 'example-close' }),
        { code: 'PROVIDER_UNAVAILABLE' });
});

test('the default broker is inert and the core never calls a registered broker', async t => {
    const registry = createRegistry();
    const calls = [];
    registry.register('broker', 'spy-broker', { description: 'Synthetic broker', capabilities: { live: true },
        submit: (...a) => calls.push(a), cancel: (...a) => calls.push(a), status: (...a) => calls.push(a) });
    const x = await setup(t, { registry });
    let o = await demo(x);
    o = (await x.command(bound(o, 'SubmitOrder', 'b', { symbol: 'DEMO-A', side: 'buy', quantity: 100 }))).observation;
    o = (await x.command(bound(o, 'AdvanceDay', 'd'))).observation;
    assert.equal(o.orders[0].status, 'filled'); assert.deepEqual(calls, []);
    assert.ok((await x.command({ command: 'ListExtensions' })).extensions.broker.some(b => b.id === 'spy-broker' && b.live));
});

test('tools are read-only, bounded to observed bars and to their own arguments; financials are point-in-time', async t => {
    const registry = createRegistry();
    let received;
    registry.register('tool', 'echo', { description: 'Synthetic tool', run: (context, args) => {
        received = { args, last: context.bars('DEMO-A').at(-1).date, asOf: context.asOf, options: context.options };
        assert.throws(() => context.bars('DEMO-Z'), { code: 'UNKNOWN_SYMBOL' });
        return { ok: true };
    } });
    registry.register('tool', 'huge', { description: 'Synthetic tool', run: () => ({ text: 'x'.repeat(70000) }) });
    const financials = { schemaVersion: 1, kind: 'financials', source: { name: 'Synthetic financials' },
        fields: { roe: 'synthetic ratio' }, securities: [{ symbol: 'DEMO-A', reports: [
            { period: '2024-09-30', publishedAt: '2024-10-28', metrics: { roe: 0.05 } },
            { period: '2024-12-31', publishedAt: '2025-03-20', metrics: { roe: 0.08 } },
            { period: '2024-06-30', publishedAt: null, metrics: { roe: 0.03 } }] }] };
    const x = await setup(t, { registry, sources: async directory => {
        await fs.mkdir(path.join(directory, 'fin'));
        await fs.writeFile(path.join(directory, 'fin', 'financials.json'), JSON.stringify(financials));
        return { schemaVersion: 1, sources: [], tools: { financials: { directory: path.join(directory, 'fin'), file: 'financials.json' },
            echo: { mode: 'synthetic' } } };
    } });
    const o = await demo(x);
    const before = o.revision;
    const echo = (await x.command({ command: 'CallTool', sessionId: o.sessionId, tool: 'echo', requestId: 'r', maid: 'm', symbol: 'DEMO-A' })).tool;
    assert.deepEqual(received, { args: { symbol: 'DEMO-A' }, last: o.date, asOf: o.date, options: { mode: 'synthetic' } });
    assert.deepEqual(echo.result, { ok: true }); assert.equal(echo.network, false);
    await assert.rejects(x.command({ command: 'CallTool', sessionId: o.sessionId, tool: 'huge' }), { code: 'PROVIDER_FAILED' });
    const fin = (await x.command({ command: 'CallTool', sessionId: o.sessionId, tool: 'financials', symbol: 'DEMO-A' })).tool.result;
    assert.deepEqual(fin.reports.map(r => r.period), ['2024-09-30']);
    assert.equal(fin.withheld, 2); assert.ok(!JSON.stringify(fin).includes(x.directory));
    assert.equal((await x.command({ command: 'GetObservation', sessionId: o.sessionId })).observation.revision, before);
    const bare = await setup(t);
    const p = await demo(bare);
    await assert.rejects(bare.command({ command: 'CallTool', sessionId: p.sessionId, tool: 'financials', symbol: 'DEMO-A' }), { code: 'NOT_CONFIGURED' });
});

test('Tencent intraday adapter parses exact units, refuses future days and labels itself as unofficial', async t => {
    assert.equal(tencent.tencentCode('SH.000000'), 'sh000000'); assert.equal(tencent.tencentCode('000000.SZ'), 'sz000000');
    assert.equal(tencent.tencentCode('DEMO-A'), null);
    const registry = createRegistry();
    let day = '20250110', status = 200, requested;
    const fetch = async url => { requested = url; return { ok: status === 200, status, text: async () => JSON.stringify({ code: 0, data: { sh000000: { data: {
        date: day, data: ['0930 10.00 100 100000.00', '0931 10.05 300 301500.5', '1500 10.10 900 907200'] } } } }) }; };
    tencent.register({ register: (...a) => registry.register(...a), TradeError }, { fetch });
    const securities = ['SH.000000', 'SZ.000000'].map(symbol => ({ symbol, name: symbol, bars: [bar('2025-01-09'), bar('2025-01-10')] }));
    const x = await setup(t, { registry });
    const imported = await x.service.importDataset({ ...dataset([]), securities });
    const o = (await x.command({ command: 'CreateSession', requestId: 'tc', datasetId: imported.datasetId, startDate: '2025-01-09' })).observation;
    const ask = symbol => x.command({ command: 'CallTool', sessionId: o.sessionId, tool: 'tencent-intraday', symbol });
    day = '20250109';
    const result = (await ask('SH.000000')).tool;
    assert.equal(requested, 'https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=sh000000');
    assert.equal(result.network, true); assert.match(result.result.source, /非公开接口/);
    assert.deepEqual(result.result.points[1], { time: '09:31', priceCents: 1005, cumulativeVolume: 30000, cumulativeAmountCents: 30150050 });
    day = '20991231';
    await assert.rejects(ask('SH.000000'), { code: 'FUTURE_DATA' });
    status = 503;
    await assert.rejects(ask('SH.000000'), { code: 'PROVIDER_UNAVAILABLE' });
    await assert.rejects(ask('BJ.000000'), { code: 'UNKNOWN_SYMBOL' });
    assert.equal(tencent.parse({ code: 0, data: { sh000000: { data: { date: '20250110', data: ['0930 10.005 1 1'] } } } }, 'sh000000'), null);
});

test('README examples: a CSV market source and a breakout signal run end to end', async t => {
    const registry = createRegistry();
    examples.register({ register: (...a) => registry.register(...a), TradeError });
    const rows = ['date,open,high,low,close,volume'];
    for (let i = 0; i < 8; i++) {
        const close = (10 + i * 0.1 + (i === 6 ? 1 : 0)).toFixed(2);
        rows.push(`2025-01-${String(6 + i).padStart(2, '0')},10.00,${(Number(close) + 0.2).toFixed(2)},9.80,${close},${10000 + i}`);
    }
    const x = await setup(t, { registry, sources: async directory => {
        await fs.mkdir(path.join(directory, 'csv'));
        await fs.writeFile(path.join(directory, 'csv', 'EXAMPLE.csv'), rows.join('\n'));
        return { schemaVersion: 1, sources: [{ id: 'feed-csv', kind: 'example-csv', directory: path.join(directory, 'csv'),
            securities: [{ symbol: 'EXAMPLE', name: 'Synthetic CSV', file: 'EXAMPLE.csv' }] }] };
    } });
    const sync = (await x.command({ command: 'SyncSource', sourceId: 'feed-csv', requestId: 'csv-1', completedThrough: '2025-01-13' })).sync;
    assert.equal(sync.added, 8);
    const o = (await x.command({ command: 'CreateSession', requestId: 'csv-run', sourceId: 'feed-csv', dataMode: 'snapshot', startDate: '2025-01-12' })).observation;
    const signals = (await x.command({ command: 'GetAnalysis', sessionId: o.sessionId, symbol: 'EXAMPLE', analysis: 'example-breakout', options: { days: 3 } })).analysis.signals;
    assert.deepEqual(signals.map(s => [s.date, s.action]), [['2025-01-12', 'buy']]);
});
