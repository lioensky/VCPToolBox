'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { TradeService } = require('../core/service.cjs');
const { completedDate } = require('../core/data.cjs');
const { start } = require('../preview.cjs');

const bar = (date, closeCents = 1000) => ({ date, openCents: 1000, highCents: 1100, lowCents: 900, closeCents, volume: 10000 });
const data = (bars = [bar('2025-01-06'), bar('2025-01-07')]) => ({ schemaVersion: 1,
    source: { kind: 'user', name: 'Synthetic daily sync', adjustment: 'none', currency: 'CNY', timezone: 'Asia/Shanghai', volumeUnit: 'shares' },
    securities: [{ symbol: 'TEST-SYNC', name: 'Synthetic instrument', bars }] });
async function setup(t, configure) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vtrade-sync-'));
    const sourcesFile = configure ? await configure(directory) : undefined;
    let service = await new TradeService(path.join(directory, 'store'), { sourcesFile }).initialize();
    t.after(async () => { await service.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); });
    return { directory, get service() { return service; },
        async reopen() { await service.close(); service = await new TradeService(path.join(directory, 'store'), { sourcesFile }).initialize(); } };
}
const ingest = (x, input, args = {}) => x.service.ingestDataset(input, { sourceId: 'feed-test', requestId: 'initial', completedThrough: '2025-01-07', ...args });
async function create(x, sourceId, requestId = 'continuous', dataMode = 'continuous') {
    return (await x.service.command({ command: 'CreateSession', requestId, sourceId, dataMode, rulesProfile: 'reference',
        ...(dataMode === 'snapshot' ? { startDate: '2025-01-06' } : {}) })).observation;
}
function bound(o, command, requestId, extra = {}) { return { command, sessionId: o.sessionId, expectedRevision: o.revision, observationId: o.observationId, requestId, ...extra }; }

test('latest completed day accepts plans and pending intents, waits without changing the ledger', async t => {
    const x = await setup(t); await ingest(x, data());
    let o = await create(x, 'feed-test');
    assert.equal(o.date, '2025-01-07'); assert.equal(o.waitingForData, true); assert.equal(o.finished, false); assert.equal(o.canAdvance, false);
    // A plan records research intent, even when the suggested quantity exceeds the available budget.
    o = (await x.service.command(bound(o, 'SavePlan', 'plan', { symbol: 'TEST-SYNC', side: 'buy', quantity: 100000 }))).observation;
    o = (await x.service.command(bound(o, 'SubmitOrder', 'intent', { symbol: 'TEST-SYNC', side: 'buy', quantity: 100 }))).observation;
    assert.equal(o.orders[0].status, 'pending'); assert.ok(o.account.reservedCents > 0);
    await assert.rejects(x.service.command(bound(o, 'AdvanceDay', 'wait')), { code: 'WAITING_DATA' });
    const after = (await x.service.command({ command: 'GetObservation', sessionId: o.sessionId })).observation;
    assert.deepEqual(after, o);
});
test('one-bar delta -> explicit attachment -> settlement -> restart is one ledger; frozen experiments stay unchanged', async t => {
    const x = await setup(t); const first = await ingest(x, data());
    let o = await create(x, first.sourceId); const frozen = await create(x, first.sourceId, 'frozen', 'snapshot');
    const manifest = (await x.service.command({ command: 'GetRunManifest', sessionId: frozen.sessionId })).manifest;
    o = (await x.service.command(bound(o, 'SubmitOrder', 'buy', { symbol: 'TEST-SYNC', side: 'buy', quantity: 300 }))).observation;
    const batch = data([bar('2025-01-08')]);
    const appendArgs = { requestId: 'append', completedThrough: '2025-01-08', expectedDataVersion: first.datasetId };
    const next = await ingest(x, batch, appendArgs); assert.equal(next.added, 1);
    const notAttached = (await x.service.command({ command: 'GetObservation', sessionId: o.sessionId })).observation;
    assert.deepEqual(notAttached, o);
    const attach = bound(o, 'SyncSessionData', 'attach', { datasetId: next.datasetId });
    o = (await x.service.command(attach)).observation;
    assert.equal(o.date, '2025-01-07'); assert.equal(o.canAdvance, true); assert.equal(o.orders[0].status, 'pending');
    const chart = (await x.service.command({ command: 'GetChart', sessionId: o.sessionId, symbol: 'TEST-SYNC' })).chart;
    assert.equal(chart.bars.length, 2); assert.equal(chart.asOf, '2025-01-07');
    const advance = bound(o, 'AdvanceDay', 'settle');
    o = (await x.service.command(advance)).observation;
    assert.equal(o.orders[0].status, 'filled'); assert.equal(o.account.positions[0].quantity, 300); assert.equal(o.waitingForData, true);
    const cash = o.account.cashCents;
    await x.reopen();
    assert.equal((await x.service.command(advance)).duplicate, true);
    const retried = await ingest(x, batch, appendArgs); assert.equal(retried.duplicate, true); assert.equal(retried.datasetId, next.datasetId);
    const restored = (await x.service.command({ command: 'GetObservation', sessionId: o.sessionId })).observation;
    assert.equal(restored.account.cashCents, cash); assert.equal(restored.orders.length, 1);
    const frozenAfter = (await x.service.command({ command: 'GetRunManifest', sessionId: frozen.sessionId })).manifest;
    assert.deepEqual(frozenAfter, manifest);
    await assert.rejects(x.service.command(bound(frozen, 'SyncSessionData', 'bad-attach')), { code: 'FROZEN_RUN' });
    const status = (await x.service.command({ command: 'GetDataStatus', sourceId: first.sourceId })).dataStatus;
    assert.equal(status.history.length, 2); assert.equal(status.history[1].parentDatasetId, first.datasetId); assert.equal(status.history[1].availableAt, null);
});
test('overlap is idempotent, old-price conflicts fail atomically, and competing batches use version checks', async t => {
    const x = await setup(t); const first = await ingest(x, data());
    const repeat = await ingest(x, data(), { requestId: 'repeat', expectedDataVersion: first.datasetId });
    assert.equal(repeat.changed, false); assert.equal(repeat.unchanged, 2); assert.equal(repeat.revision, 1);
    await assert.rejects(ingest(x, data([bar('2025-01-07', 1010), bar('2025-01-08')]), {
        requestId: 'conflict', completedThrough: '2025-01-08', expectedDataVersion: first.datasetId }), { code: 'HISTORICAL_CONFLICT' });
    assert.equal((await x.service.repository.status('feed-test')).datasetId, first.datasetId);
    const results = await Promise.allSettled(['2025-01-08', '2025-01-09'].map((day, i) => ingest(x, data([bar(day)]), {
        requestId: `concurrent-${i}`, completedThrough: day, expectedDataVersion: first.datasetId })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'STALE_DATA_VERSION');
    await assert.rejects(ingest(x, data([bar('2025-01-08')]), { requestId: 'initial', completedThrough: '2025-01-08' }), { code: 'REQUEST_CONFLICT' });
});
test('invalid deltas, source switches, new universe members and incomplete dates cannot replace a version', async t => {
    const x = await setup(t); const first = await ingest(x, data());
    const baseArgs = { requestId: 'bad', expectedDataVersion: first.datasetId, completedThrough: '2025-01-08' };
    await assert.rejects(ingest(x, data([bar('2025-01-08'), bar('2025-01-08')]), baseArgs), { code: 'INVALID_DATA' });
    await assert.rejects(ingest(x, data([bar('2025-01-09')]), baseArgs), { code: 'INCOMPLETE_BAR' });
    const switched = data([bar('2025-01-08')]); switched.source.kind = 'tdx';
    await assert.rejects(ingest(x, switched, baseArgs), { code: 'SOURCE_MISMATCH' });
    const added = data([bar('2025-01-08')]); added.securities[0].symbol = 'NEW';
    await assert.rejects(ingest(x, added, baseArgs), { code: 'UNKNOWN_SYMBOL' });
    await assert.rejects(ingest(x, data([bar('2099-01-01')]), { ...baseArgs, completedThrough: '2099-01-01' }), { code: 'INCOMPLETE_BAR' });
    assert.equal((await x.service.repository.status('feed-test')).datasetId, first.datasetId);
    await x.reopen(); assert.equal((await x.service.repository.status('feed-test')).datasetId, first.datasetId);
});
test('an incompatible historical feed cannot be attached to an existing continuous run', async t => {
    const x = await setup(t); const original = await x.service.importDataset(data());
    const o = (await x.service.command({ command: 'CreateSession', requestId: 'unbound', datasetId: original.datasetId,
        dataMode: 'continuous', rulesProfile: 'reference' })).observation;
    await ingest(x, data([bar('2025-01-06', 1010), bar('2025-01-07'), bar('2025-01-08')]), { completedThrough: '2025-01-08' });
    await assert.rejects(x.service.command(bound(o, 'SyncSessionData', 'rewrite', { sourceId: 'feed-test' })), { code: 'HISTORICAL_CONFLICT' });
    assert.deepEqual((await x.service.command({ command: 'GetObservation', sessionId: o.sessionId })).observation, o);
});
function tdxBytes(days) {
    const bytes = Buffer.alloc(days.length * 32);
    days.forEach((day, i) => { for (const [offset, value] of [[0, Number(day.replaceAll('-', ''))], [4, 1000], [8, 1100], [12, 900], [16, 1000], [24, 10000]]) bytes.writeUInt32LE(value, i * 32 + offset); });
    return bytes;
}
async function localConfig(directory, interval = 0) {
    await fs.mkdir(path.join(directory, 'vipdoc', 'sh', 'lday'), { recursive: true });
    await fs.writeFile(path.join(directory, 'vipdoc', 'sh', 'lday', 'sh000001.day'), tdxBytes(['2025-01-06', '2025-01-07']));
    const file = path.join(directory, 'sources.json');
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, sources: [{ id: 'feed-local', name: 'Synthetic local TDX', kind: 'tdx',
        directory: path.join(directory, 'vipdoc'), syncIntervalSeconds: interval, securities: [{ symbol: 'TEST-TDX', file: 'sh/lday/sh000001.day' }] }] }));
    return file;
}
test('configured TDX source reads only named files, keeps retry receipts after file changes, and survives restart', async t => {
    const x = await setup(t, localConfig);
    const config = await x.service.command({ command: 'GetSources' });
    assert.equal(config.configuredSources[0].sourceId, 'feed-local'); assert.ok(!JSON.stringify(config).includes(x.directory));
    const initialArgs = { command: 'SyncSource', sourceId: 'feed-local', requestId: 'read-1' };
    const first = (await x.service.command(initialArgs)).sync;
    const file = path.join(x.directory, 'vipdoc', 'sh', 'lday', 'sh000001.day');
    await fs.writeFile(file, tdxBytes(['2025-01-06', '2025-01-07', '2025-01-08']));
    const duplicate = (await x.service.command(initialArgs)).sync;
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.datasetId, first.datasetId);
    const next = (await x.service.command({ ...initialArgs, requestId: 'read-2', expectedDataVersion: first.datasetId })).sync;
    assert.equal(next.added, 1);
    await fs.appendFile(file, Buffer.from([1]));
    await assert.rejects(x.service.command({ ...initialArgs, requestId: 'partial', expectedDataVersion: next.datasetId }), { code: 'INVALID_DATA' });
    const status = (await x.service.command({ command: 'GetDataStatus', sourceId: 'feed-local' })).dataStatus;
    assert.equal(status.datasetId, next.datasetId); assert.equal(status.lastError, 'INVALID_DATA');
    await x.reopen();
    assert.equal((await x.service.command({ ...initialArgs, requestId: 'read-2', expectedDataVersion: first.datasetId })).sync.duplicate, true);
    await assert.rejects(x.service.command({ ...initialArgs, sourceId: 'feed-unconfigured' }), { code: 'SOURCE_UNAVAILABLE' });
});
test('security lines accept bare codes, market prefixes and names, and reject anything else', () => {
    const { parseSecurities } = require('../core/local-sources.cjs');
    assert.deepEqual(parseSecurities('SH.600000 甲\nsz000000\n920000\n430000 乙\n900000\n300000').map(s => [s.symbol, s.name, s.file]), [
        ['SH.600000', '甲', 'sh/lday/sh600000.day'], ['SZ.000000', '000000', 'sz/lday/sz000000.day'], ['BJ.920000', '920000', 'bj/lday/bj920000.day'],
        ['BJ.430000', '乙', 'bj/lday/bj430000.day'], ['SH.900000', '900000', 'sh/lday/sh900000.day'], ['SZ.300000', '300000', 'sz/lday/sz300000.day']]);
    for (const bad of ['', 'abc', '60000', '600000\nSH.600000', '../600000']) assert.throws(() => parseSecurities(bad), { code: 'INVALID_SOURCE' });
});
test('settings save a TDX source that tool calls cannot reach, keep synced securities fixed, and persist', async t => {
    const x = await setup(t, localConfig);
    const vipdoc = path.join(x.directory, 'vipdoc');
    await fs.mkdir(path.join(vipdoc, 'sz', 'lday'), { recursive: true });
    await fs.writeFile(path.join(vipdoc, 'sh', 'lday', 'sh600000.day'), tdxBytes(['2025-01-06', '2025-01-07', '2025-01-08']));
    await fs.writeFile(path.join(vipdoc, 'sz', 'lday', 'sz000000.day'), tdxBytes(['2025-01-06', '2025-01-07', '2025-01-08']));
    const probe = (await x.service.settings({ action: 'probe', directory: vipdoc, securities: '600000\n609999' })).probe;
    assert.deepEqual(probe, { counts: { sh: 2, sz: 1, bj: 0 }, securities: 2, missing: ['SH.609999'] });
    const input = { name: '设置页来源', directory: vipdoc, securities: '600000 合成甲\n000000', since: '2025-01-07', syncIntervalSeconds: 0 };
    const saved = (await x.service.settings({ action: 'saveSource', source: input })).source;
    assert.equal(saved.origin, 'settings'); assert.equal(saved.synced, false); assert.match(saved.id, /^feed-local-/);
    const listed = await x.service.command({ command: 'GetSources' });
    assert.ok(listed.configuredSources.some(s => s.sourceId === saved.id && s.origin === 'settings'));
    assert.ok(!JSON.stringify(listed).includes(vipdoc));
    await assert.rejects(x.service.command({ command: 'saveSource', source: input }), { code: 'UNKNOWN_COMMAND' });
    await assert.rejects(x.service.settings({ action: 'saveSource', source: { ...input, id: 'feed-local' } }), { code: 'SOURCE_READONLY' });
    const sync = (await x.service.command({ command: 'SyncSource', sourceId: saved.id, requestId: 'settings-1' })).sync;
    assert.equal(sync.added, 4);
    const coverage = (await x.service.repository.status(saved.id)).coverage;
    assert.deepEqual(coverage.map(c => [c.symbol, c.firstDate]), [['SH.600000', '2025-01-07'], ['SZ.000000', '2025-01-07']]);
    const moved = (await x.service.settings({ action: 'saveSource', source: { ...input, id: saved.id, name: '改名', syncIntervalSeconds: 3600 } })).source;
    assert.equal(moved.name, '改名'); assert.equal(moved.synced, true);
    for (const change of [{ securities: '600000' }, { since: '2025-01-06' }]) {
        await assert.rejects(x.service.settings({ action: 'saveSource', source: { ...input, id: saved.id, ...change } }), { code: 'SOURCE_LOCKED' });
    }
    await x.reopen();
    assert.equal((await x.service.settings({ action: 'sources' })).sources.find(s => s.id === saved.id).name, '改名');
    await x.service.settings({ action: 'removeSource', sourceId: saved.id });
    await assert.rejects(x.service.settings({ action: 'removeSource', sourceId: 'feed-local' }), { code: 'SOURCE_READONLY' });
    await x.reopen();
    const after = await x.service.command({ command: 'GetSources' });
    assert.ok(!after.configuredSources.some(s => s.sourceId === saved.id));
    assert.ok(after.dataFeeds.some(f => f.sourceId === saved.id));
});
test('enabled polling starts with one sync and shutdown drains an accepted manual file read', async t => {
    const x = await setup(t, d => localConfig(d, 60));
    const deadline = Date.now() + 3000;
    while (!x.service.repository.feeds.has('feed-local') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const current = await x.service.repository.status('feed-local'); assert.equal(current.revision, 1);
    const task = x.service.command({ command: 'SyncSource', sourceId: 'feed-local', requestId: 'drain', expectedDataVersion: current.datasetId });
    await x.service.close(); assert.equal((await task).sync.changed, false);
    await x.reopen(); assert.equal((await x.service.repository.status('feed-local')).revision, 1);
});
test('API delta import and VCP-like session commands share versioned data and do not leak future bars', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vtrade-sync-http-'));
    const preview = await start({ port: 0, directory });
    t.after(async () => { await preview.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); });
    const post = async (route, input) => (await fetch(`${preview.origin}/api/${route}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-VTrade-Request': '1', 'X-VTrade-Access': preview.token }, body: JSON.stringify(input) })).json();
    const first = await post('import', { format: 'json', dataset: data(), requestId: 'http-initial', completedThrough: '2025-01-07' });
    assert.equal(first.ok, true);
    let o = (await post('command', { command: 'CreateSession', requestId: 'http-continuous', sourceId: first.sourceId })).observation;
    assert.equal(o.waitingForData, true);
    o = (await post('command', bound(o, 'SavePlan', 'http-plan', { symbol: 'TEST-SYNC', side: 'buy', quantity: 100 }))).observation;
    const bytes = tdxBytes(['2025-01-08']);
    // A different source kind must be rejected rather than mixed into a JSON feed.
    const mismatch = await post('import', { format: 'tdx', symbol: 'TEST-SYNC', dataBase64: bytes.toString('base64'), requestId: 'http-mismatch',
        sourceId: first.sourceId, expectedDataVersion: first.datasetId, completedThrough: '2025-01-08' });
    assert.equal(mismatch.code, 'SOURCE_MISMATCH');
    const next = await post('import', { format: 'json', dataset: data([bar('2025-01-08')]), requestId: 'http-delta',
        sourceId: first.sourceId, expectedDataVersion: first.datasetId, completedThrough: '2025-01-08' });
    assert.equal(next.added, 1);
    o = (await post('command', bound(o, 'SyncSessionData', 'http-attach', { datasetId: next.datasetId }))).observation;
    const chart = await post('command', { command: 'GetChart', sessionId: o.sessionId, symbol: 'TEST-SYNC' });
    assert.equal(chart.chart.bars.at(-1).date, '2025-01-07'); assert.equal(o.date, '2025-01-07');
});
test('Shanghai completion cutoff does not depend on the server timezone or accept current morning bars', () => {
    assert.equal(completedDate(new Date('2025-01-07T09:59:00Z')), '2025-01-06');
    assert.equal(completedDate(new Date('2025-01-07T10:00:00Z')), '2025-01-07');
    assert.equal(completedDate(new Date('2025-01-01T00:00:00Z')), '2024-12-31');
});
test('daily versions persist only deltas and reconstruct after cache eviction and restart', async t => {
    const x = await setup(t); let head = await ingest(x, data()); const original = head.datasetId;
    for (let n = 8; n <= 22; n++) {
        const day = `2025-01-${String(n).padStart(2, '0')}`;
        head = await ingest(x, data([bar(day)]), { requestId: `daily-${n}`, completedThrough: day, expectedDataVersion: head.datasetId });
    }
    const datasets = await fs.readdir(path.join(x.directory, 'store', 'datasets'));
    const versions = await fs.readdir(path.join(x.directory, 'store', 'versions'));
    assert.equal(datasets.length, 1); assert.equal(versions.length, 15);
    const stored = JSON.parse(await fs.readFile(path.join(x.directory, 'store', 'versions', `${head.datasetId.slice(5)}.json`), 'utf8'));
    assert.equal(stored.delta.securities[0].bars.length, 1);
    await x.reopen();
    const rebuilt = await x.service.data(head.datasetId);
    assert.equal(rebuilt.dataset.securities[0].bars.length, 17);
    assert.equal(rebuilt.dataset.securities[0].bars.at(-1).date, '2025-01-22');
    assert.equal((await x.service.data(original)).dataset.securities[0].bars.length, 2);
});
test('a failed feed publication leaves its head and receipts unchanged; an orphan delta cannot attach itself', async t => {
    const x = await setup(t); const initial = await ingest(x, data());
    const feeds = path.join(x.directory, 'store', 'feeds'), saved = path.join(x.directory, 'store', 'feeds-saved');
    await fs.rename(feeds, saved); await fs.writeFile(feeds, 'synthetic I/O failure');
    try {
        await assert.rejects(ingest(x, data([bar('2025-01-08')]), { requestId: 'disk-failure', completedThrough: '2025-01-08', expectedDataVersion: initial.datasetId }));
        assert.equal(x.service.repository.feed('feed-test').datasetId, initial.datasetId);
        assert.equal(Object.hasOwn(x.service.repository.feed('feed-test').receipts, 'disk-failure'), false);
    } finally { await fs.unlink(feeds); await fs.rename(saved, feeds); }
    await x.reopen(); assert.equal((await x.service.repository.status('feed-test')).datasetId, initial.datasetId);
});
test('failed session attachment cannot change account history or advance its clock', async t => {
    const x = await setup(t); const initial = await ingest(x, data()); const o = await create(x, initial.sourceId);
    const head = await ingest(x, data([bar('2025-01-08')]), { requestId: 'next', completedThrough: '2025-01-08', expectedDataVersion: initial.datasetId });
    const write = x.service.store.write;
    x.service.store.write = async () => { throw Error('Synthetic save failure'); };
    try { await assert.rejects(x.service.command(bound(o, 'SyncSessionData', 'attach-failed', { datasetId: head.datasetId })), /Synthetic save failure/); }
    finally { x.service.store.write = write; }
    assert.deepEqual((await x.service.command({ command: 'GetObservation', sessionId: o.sessionId })).observation, o);
});
test('modified delta files fail validation and remain available for recovery', async t => {
    const x = await setup(t); const initial = await ingest(x, data());
    const head = await ingest(x, data([bar('2025-01-08')]), { requestId: 'next', completedThrough: '2025-01-08', expectedDataVersion: initial.datasetId });
    const file = path.join(x.directory, 'store', 'versions', `${head.datasetId.slice(5)}.json`);
    const stored = JSON.parse(await fs.readFile(file, 'utf8')); stored.delta.securities[0].bars[0].closeCents++;
    await fs.writeFile(file, JSON.stringify(stored));
    await assert.rejects(x.reopen(), { code: 'CORRUPT_DATA' });
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).delta.securities[0].bars[0].closeCents, 1001);
});
test('configured standard JSON accepts incremental AKShare-format data through the same source protocol', async t => {
    const x = await setup(t, async directory => {
        const initial = data(); initial.source.kind = 'akshare';
        await fs.writeFile(path.join(directory, 'daily.json'), JSON.stringify(initial));
        const file = path.join(directory, 'sources.json');
        await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, sources: [{ id: 'feed-json', kind: 'json', directory, file: 'daily.json' }] })); return file;
    });
    const first = (await x.service.command({ command: 'SyncSource', sourceId: 'feed-json', requestId: 'json-initial' })).sync;
    const patch = data([bar('2025-01-08')]); patch.source.kind = 'akshare';
    await fs.writeFile(path.join(x.directory, 'daily.json'), JSON.stringify(patch));
    const next = (await x.service.command({ command: 'SyncSource', sourceId: 'feed-json', requestId: 'json-next', expectedDataVersion: first.datasetId })).sync;
    assert.equal(next.added, 1); assert.equal((await x.service.data(next.datasetId)).dataset.source.kind, 'akshare');
});
test('actual VCP lifecycle supports configured-source sync, string arguments, continuous settlement and manifest recovery', async t => {
    const x = await setup(t, localConfig);
    const plugin = require('../VTrade.js');
    const config = { VTRADE_DATA_DIR: path.join(x.directory, 'plugin-store'), VTRADE_SOURCES_FILE: path.join(x.directory, 'sources.json') };
    const call = async args => {
        const result = await plugin.processToolCall(args);
        assert.equal(result.status, 'success', JSON.stringify(result));
        return JSON.parse(result.result.content[0].text);
    };
    await plugin.initialize(config);
    try {
        const initial = (await call({ command: 'SyncSource', sourceId: 'feed-local', requestId: 'vcp-sync' })).sync;
        let o = (await call({ command: 'CreateSession', sourceId: 'feed-local', requestId: 'vcp-run' })).observation;
        const args = bound(o, 'SubmitOrder', 'vcp-order', { symbol: 'TEST-TDX', side: 'buy', quantity: '100' });
        args.expectedRevision = String(args.expectedRevision);
        o = (await call(args)).observation;
        await fs.writeFile(path.join(x.directory, 'vipdoc', 'sh', 'lday', 'sh000001.day'), tdxBytes(['2025-01-06', '2025-01-07', '2025-01-08']));
        const next = (await call({ command: 'SyncSource', sourceId: 'feed-local', requestId: 'vcp-next', expectedDataVersion: initial.datasetId })).sync;
        o = (await call(bound(o, 'SyncSessionData', 'vcp-attach', { datasetId: next.datasetId }))).observation;
        assert.equal((await call({ command: 'GetChart', sessionId: o.sessionId, symbol: 'TEST-TDX', limit: '50' })).chart.bars.length, 2);
        o = (await call(bound(o, 'AdvanceDay', 'vcp-day'))).observation;
        assert.equal(o.account.positions[0].quantity, 100);
        const manifest = (await call({ command: 'GetRunManifest', sessionId: o.sessionId })).manifest;
        await plugin.shutdown(); await plugin.initialize(config);
        assert.deepEqual((await call({ command: 'GetRunManifest', sessionId: o.sessionId })).manifest, manifest);
        const duplicate = await call(args); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.observation.orders.length, 1);
    } finally { await plugin.shutdown(); }
});
test('unchanged automatic polls reuse their content receipt and still recover a source error', async t => {
    const x = await setup(t, localConfig);
    const first = await x.service.localSources.sync('feed-local', {}, { automatic: true });
    for (let i = 0; i < 5; i++) await x.service.localSources.sync('feed-local', { expectedDataVersion: first.datasetId }, { automatic: true });
    assert.equal(Object.keys(x.service.repository.feed('feed-local').receipts).length, 2);
    await x.service.repository.failure('feed-local', 'SYNTHETIC_FILE_BUSY');
    await x.service.localSources.sync('feed-local', { expectedDataVersion: first.datasetId }, { automatic: true });
    assert.equal((await x.service.repository.status('feed-local')).lastError, null);
    assert.equal(Object.keys(x.service.repository.feed('feed-local').receipts).length, 2);
});
test('partial multi-symbol updates keep an order pending until its next-day bar arrives', async t => {
    const x = await setup(t); const both = data();
    both.securities.push({ symbol: 'SECOND', name: 'Second synthetic instrument', bars: [bar('2025-01-06'), bar('2025-01-07')] });
    const first = await ingest(x, both); let o = await create(x, first.sourceId);
    o = (await x.service.command(bound(o, 'SubmitOrder', 'partial-buy', { symbol: 'TEST-SYNC', side: 'buy', quantity: 100 }))).observation;
    const partial = data([bar('2025-01-08')]); partial.securities[0].symbol = 'SECOND';
    const next = await ingest(x, partial, { requestId: 'second-only', completedThrough: '2025-01-08', expectedDataVersion: first.datasetId });
    o = (await x.service.command(bound(o, 'SyncSessionData', 'partial-attach', { datasetId: next.datasetId }))).observation;
    assert.equal(o.canAdvance, false); assert.equal(o.waitingForData, true);
    await assert.rejects(x.service.command(bound(o, 'AdvanceDay', 'partial-day')), { code: 'WAITING_DATA' });
    assert.equal(o.orders[0].status, 'pending'); assert.equal(o.date, '2025-01-07');
    const complete = await ingest(x, data([bar('2025-01-08')]), { requestId: 'first-ready', completedThrough: '2025-01-08', expectedDataVersion: next.datasetId });
    o = (await x.service.command(bound(o, 'SyncSessionData', 'complete-attach', { datasetId: complete.datasetId }))).observation;
    assert.equal(o.canAdvance, true);
    o = (await x.service.command(bound(o, 'AdvanceDay', 'complete-day'))).observation;
    assert.equal(o.orders[0].status, 'filled'); assert.equal(o.account.positions[0].quantity, 100);
});
