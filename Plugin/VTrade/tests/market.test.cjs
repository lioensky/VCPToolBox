'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { MarketDirectory } = require('../core/market-directory.cjs');
const { TradeService } = require('../core/service.cjs');

// .day records: date, open, high, low, close (1/scale yuan), amount (float), volume.
function day(rows) {
    const bytes = Buffer.alloc(rows.length * 32);
    rows.forEach(([date, open, high, low, close, amount, volume], i) => {
        const o = i * 32;
        bytes.writeUInt32LE(Number(date.replaceAll('-', '')), o);
        [open, high, low, close].forEach((v, j) => bytes.writeUInt32LE(v, o + 4 + j * 4));
        bytes.writeFloatLE(amount, o + 20); bytes.writeUInt32LE(volume, o + 24);
    });
    return bytes;
}
// Name records: code at 0, GBK name at 31, pinyin abbreviation at 329.
function tnf(entries) {
    const bytes = Buffer.alloc(50 + entries.length * 360);
    entries.forEach(([code, name, abbr], i) => {
        const o = 50 + i * 360;
        bytes.write(code, o, 'ascii'); Buffer.from(name).copy(bytes, o + 31); bytes.write(abbr, o + 329, 'ascii');
    });
    return bytes;
}
const SHI_LI = [0xca, 0xbe, 0xc0, 0xfd]; // 示例 in GBK
async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vtrade-market-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const vipdoc = path.join(root, 'vipdoc'), names = path.join(root, 'T0002', 'hq_cache');
    for (const dir of ['sh/lday', 'sz/lday', 'bj/lday']) await fs.mkdir(path.join(vipdoc, dir), { recursive: true });
    await fs.mkdir(names, { recursive: true });
    const write = (file, rows) => fs.writeFile(path.join(vipdoc, file), day(rows));
    await write('sh/lday/sh600000.day', [['2025-01-06', 1000, 1100, 950, 1050, 1e7, 100000], ['2025-01-07', 1050, 1080, 1000, 1000, 2e7, 200000]]);
    await write('sh/lday/sh510000.day', [['2025-01-06', 3500, 3600, 3400, 3550, 5e6, 10000], ['2025-01-07', 3550, 3700, 3500, 3650, 6e6, 12000]]);
    await write('sh/lday/sh110000.day', [['2025-01-07', 10000, 10100, 9900, 10050, 1e5, 10]]);
    await write('sh/lday/sh000000.day', [['2025-01-07', 300000, 301000, 299000, 300500, 1e9, 1e6]]);
    await write('sz/lday/sz300000.day', [['2025-01-07', 2000, 2100, 1900, 2050, 3e6, 15000]]);
    await write('bj/lday/bj920000.day', [['2025-01-07', 800, 820, 790, 810, 1e5, 1000]]);
    await fs.writeFile(path.join(names, 'shs.tnf'), tnf([['600000', Buffer.from(SHI_LI), 'SL'], ['510000', Buffer.from('ETF-A'), 'ETFA']]));
    return { root, vipdoc, names };
}

test('the market directory lists securities with TDX names and abbreviations, classifies boards and leaves out bonds', async t => {
    const { vipdoc } = await fixture(t);
    const m = new MarketDirectory(vipdoc);
    const list = await m.securities();
    assert.deepEqual(list.map(s => [s.symbol, s.kind, s.board, s.scale]), [
        ['BJ.920000', 'stock', 'bse', 100], ['SH.000000', 'index', 'index', 100], ['SH.510000', 'fund', 'fund', 1000],
        ['SH.600000', 'stock', 'sh-main', 100], ['SZ.300000', 'stock', 'chinext', 100]]);
    assert.deepEqual((await m.securitiesAsOf('2025-01-06')).map(s => s.symbol), ['SH.510000', 'SH.600000']);
    const named = list.find(s => s.symbol === 'SH.600000');
    assert.equal(named.name, '示例'); assert.equal(named.abbr, 'SL');
    assert.equal(list.find(s => s.symbol === 'SZ.300000').name, '300000');
    const [q] = await m.quotes(['SH.600000']);
    assert.deepEqual([q.date, q.close, q.previousClose, q.high, q.amount, q.volume], ['2025-01-07', 1000, 1050, 1080, 2e7, 200000]);
    const bars = await m.bars('SH.510000', 1);
    assert.equal(bars.bars.length, 1); assert.equal(bars.truncated, true); assert.equal(bars.scale, 1000);
    await assert.rejects(m.bars('SH.110000'), { code: 'UNKNOWN_SYMBOL' });
    await assert.rejects(m.bars('../secrets'), { code: 'UNKNOWN_SYMBOL' });
    assert.throws(() => m.file('../secrets'), { code: 'INVALID_ARGUMENT' });
    const status = await m.status();
    assert.deepEqual([status.stocks, status.indices, status.funds, status.namesFound], [3, 1, 1, true]);
});

test('quotes are cached across restarts until the day file changes', async t => {
    const { root, vipdoc } = await fixture(t);
    const cacheFile = path.join(root, 'cache', 'quotes.json');
    const first = new MarketDirectory(vipdoc, { cacheFile });
    await first.prewarm();
    const saved = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    assert.equal(saved.quotes['SH.600000'].quote.close, 1000);
    const second = new MarketDirectory(vipdoc, { cacheFile });
    await second.loadCache();
    assert.equal(second.quoteCache.size, 5);
    await fs.appendFile(path.join(vipdoc, 'sh/lday/sh600000.day'), day([['2025-01-08', 1000, 1200, 990, 1150, 3e7, 300000]]));
    const [q] = await second.quotes(['SH.600000']);
    assert.deepEqual([q.date, q.close, q.previousClose], ['2025-01-08', 1150, 1000]);
});

test('browsing is reachable only through its own endpoint and follows the settings or the first TDX source', async t => {
    const { root, vipdoc } = await fixture(t);
    const sources = path.join(root, 'sources.json');
    await fs.writeFile(sources, JSON.stringify({ schemaVersion: 1, sources: [{ id: 'feed-local', kind: 'tdx', directory: vipdoc,
        securities: [{ symbol: 'SH.600000', file: 'sh/lday/sh600000.day' }] }] }));
    const service = await new TradeService(path.join(root, 'store'), { sourcesFile: sources }).initialize();
    try { await browsing(service, root, vipdoc); } finally { await service.close(); }
});
test('a directory account discovers stocks by date and trades without a preselected pool', async t => {
    const { root, vipdoc } = await fixture(t);
    const service = await new TradeService(path.join(root, 'store'), { prewarm: false }).initialize();
    try {
        await service.settings({ action: 'saveMarket', directory: vipdoc });
        const created = (await service.command({ command: 'CreateSession', requestId: 'directory-market-test',
            marketMode: 'directory', startDate: '2025-01-06', initialCashCents: 10000000 })).observation;
        const initialManifest = (await service.command({ command: 'GetRunManifest', sessionId: created.sessionId })).manifest;
        assert.deepEqual(created.quotes, []);
        const list = (await service.command({ command: 'GetSessionSecurities', sessionId: created.sessionId })).sessionSecurities;
        assert.deepEqual(list.securities.map(security => security.symbol), ['SH.600000']);
        await assert.rejects(service.command({ command: 'GetSessionQuotes', sessionId: created.sessionId,
            symbols: ['SH.510000'] }), { code: 'UNKNOWN_SYMBOL' });
        await assert.rejects(service.command({ command: 'GetChart', sessionId: created.sessionId,
            symbol: 'SZ.300000' }), { code: 'UNKNOWN_SYMBOL' });
        const placed = (await service.command({ command: 'SubmitOrder', sessionId: created.sessionId,
            observationId: created.observationId, expectedRevision: created.revision,
            requestId: 'directory-buy', symbol: 'SH.600000', side: 'buy', quantity: 100 })).observation;
        const next = (await service.command({ command: 'AdvanceDay', sessionId: created.sessionId,
            observationId: placed.observationId, expectedRevision: placed.revision,
            requestId: 'directory-advance' })).observation;
        assert.equal(next.account.positions[0].symbol, 'SH.600000');
        const laterManifest = (await service.command({ command: 'GetRunManifest', sessionId: created.sessionId })).manifest;
        assert.equal(laterManifest.configHash, initialManifest.configHash);
        assert.deepEqual(laterManifest.symbols, ['SH.600000']);
        assert.equal((await service.command({ command: 'GetSessionSecurities', sessionId: created.sessionId })).sessionSecurities.total, 3);
        await fs.writeFile(path.join(vipdoc, 'sh/lday/sh600000.day'), day([
            ['2025-01-06', 1000, 1100, 950, 1060, 1e7, 100000],
            ['2025-01-07', 1050, 1080, 1000, 1000, 2e7, 200000],
        ]));
        await assert.rejects(service.command({ command: 'GetObservation', sessionId: created.sessionId }),
            { code: 'SOURCE_CHANGED' });
    } finally { await service.close(); }
});
async function browsing(service, root, vipdoc) {
    await assert.rejects(service.command({ command: 'browse', action: 'list' }), { code: 'UNKNOWN_COMMAND' });
    assert.equal((await service.browse({ action: 'list' })).securities.length, 5);
    assert.equal((await service.settings({ action: 'market' })).market.origin, 'source');
    await assert.rejects(service.settings({ action: 'saveMarket', directory: 'relative/vipdoc' }), { code: 'INVALID_SOURCE' });
    await assert.rejects(service.settings({ action: 'saveMarket', directory: path.join(root, 'missing') }), { code: 'MARKET_UNAVAILABLE' });
    const saved = (await service.settings({ action: 'saveMarket', directory: vipdoc })).market;
    assert.deepEqual([saved.directory, saved.origin], [vipdoc, 'settings']);
    const chart = (await service.browse({ action: 'bars', symbol: 'SZ.300000' })).chart;
    assert.equal(chart.name, '300000'); assert.equal(chart.bars.length, 1);
    assert.equal((await service.browse({ action: 'status' })).status.origin, 'settings');
}
