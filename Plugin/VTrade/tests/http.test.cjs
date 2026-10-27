'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { start } = require('../preview.cjs');
const { createHandler } = require('../http.cjs');
const plugin = require('../VTrade.js');

async function temporary(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vtrade-http-'));
    return directory;
}
async function removeTemporary(directory) {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
}
test('loopback preview serves UI and runs the command protocol with source and origin checks', async t => {
    const directory = await temporary(t);
    const preview = await start({ port: 0, directory });
    t.after(async () => { await preview.close(); await removeTemporary(directory); });
    const root = await fetch(preview.origin, { redirect: 'manual' });
    assert.equal(root.status, 302); assert.equal(root.headers.get('Location'), 'workspace/');
    const page = await fetch(preview.origin);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /VTrade 工作台/);
    assert.match(page.headers.get('Content-Security-Policy'), /script-src 'self'/);
    for (const asset of ['candle-chart.mjs', 'chart-engine.mjs', 'chart-model.mjs', 'chart-scale.mjs', 'indicators.mjs', 'indicator-layer.mjs',
        'indicator-editor.mjs', 'indicator-ui.css', 'theme.css', 'vendor/vcp-ui/vcp-ui.js',
        'vendor/vcp-ui/component-manifest.js', 'vendor/vcp-ui/tokens.css', 'vendor/vcp-ui/components.css', 'vendor/vcp-ui/appearance.css',
        'vendor/vcp-ui/lucide-adapter.js', 'vendor/lucide/lucide-subset.js', 'workspace/app.mjs', 'workspace/dock.mjs', 'workspace/notice.mjs',
        'workspace/panels.mjs', 'workspace/presets.mjs', 'workspace/settings.mjs', 'workspace/store.mjs', 'workspace/workspace.css']) {
        const response = await fetch(`${preview.origin}/${asset}`);
        assert.equal(response.status, 200, asset);
        assert.match(response.headers.get('Content-Type'), /text\/(javascript|css)/);
    }
    const bare = await fetch(`${preview.origin}/workspace`, { redirect: 'manual' });
    assert.equal(bare.status, 302); assert.equal(bare.headers.get('Location'), '/workspace/');
    assert.equal((await fetch(`${preview.origin}/app.js`)).status, 404);
    // The chart engine draws on canvas; no inline style or third-party chart bundle is served.
    assert.match(page.headers.get('Content-Security-Policy'), /style-src 'self';/);
    assert.equal((await fetch(`${preview.origin}/vendor/lightweight-charts/lightweight-charts.mjs`)).status, 404);
    const request = (args, extra = {}) => fetch(`${preview.origin}/api/command`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-VTrade-Request': '1',
            'X-VTrade-Access': preview.token, ...extra }, body: JSON.stringify(args) });
    const noToken = await request({ command: 'GetSources' }, { 'X-VTrade-Access': '' });
    assert.equal(noToken.status, 403);
    // Source settings have their own endpoint behind the same access check; tool commands cannot reach them.
    const settings = (body, token = preview.token) => fetch(`${preview.origin}/api/settings`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-VTrade-Request': '1', 'X-VTrade-Access': token }, body: JSON.stringify(body) });
    assert.equal((await settings({ action: 'sources' }, '')).status, 403);
    assert.deepEqual((await (await settings({ action: 'sources' })).json()).sources, []);
    assert.equal((await (await settings({ action: 'probe', directory: 'relative/vipdoc' })).json()).code, 'INVALID_SOURCE');
    const cross = await request({ command: 'GetSources' }, { Origin: 'https://other.invalid' });
    assert.equal(cross.status, 403);
    const created = await (await request({ command: 'CreateSession', requestId: 'http-create' })).json();
    assert.equal(created.observation.mode, 'simulation');
    const o = created.observation;
    const fill = await (await request({ command: 'SubmitOrder', sessionId: o.sessionId,
        observationId: o.observationId, expectedRevision: o.revision, requestId: 'http-intent',
        symbol: 'DEMO-A', side: 'buy', quantity: 100 })).json();
    assert.equal(fill.receipt.status, 'pending');
    const dataset = {
        schemaVersion: 1, source: { kind: 'user', name: 'Synthetic HTTP import', adjustment: 'none',
            currency: 'CNY', timezone: 'Asia/Shanghai', volumeUnit: 'shares' },
        securities: [{ symbol: 'IMPORT-A', bars: ['2025-01-06', '2025-01-07'].map(date => ({
            date, openCents: 1000, closeCents: 1000, highCents: 1001, lowCents: 999, volume: 10000 })) }],
    };
    const importedResponse = await fetch(`${preview.origin}/api/import`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-VTrade-Request': '1', 'X-VTrade-Access': preview.token },
        body: JSON.stringify({ format: 'json', dataset }) });
    const imported = await importedResponse.json();
    assert.equal(imported.ok, true);
    const own = await (await request({ command: 'CreateSession', requestId: 'own-data-create', datasetId: imported.datasetId })).json();
    assert.equal(own.observation.source.name, 'Synthetic HTTP import');
    assert.equal(own.observation.rulesProfile, 'reference');
    assert.equal(own.observation.quotes[0].symbol, 'IMPORT-A');
    const malformed = await fetch(`${preview.origin}/api/import`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-VTrade-Request': '1', 'X-VTrade-Access': preview.token },
        body: '{broken' });
    assert.equal((await malformed.json()).code, 'INVALID_JSON');
    const traversal = await fetch(`${preview.origin}/core/data.cjs`);
    assert.equal(traversal.status, 404);
});
test('plugin lifecycle and string-valued VCP arguments use the same durable service', async t => {
    const directory = await temporary(t);
    await plugin.initialize({ VTRADE_DATA_DIR: directory });
    let server;
    t.after(async () => {
        if (server) await new Promise(resolve => server.close(resolve));
        await plugin.shutdown(); await removeTemporary(directory);
    });
    const call = async args => JSON.parse((await plugin.processToolCall(args)).result.content[0].text);
    const created = await call({ command: 'CreateSession', requestId: 'tool-create', symbols: '["DEMO-A"]',
        initialCashCents: '10000000' });
    assert.equal(created.ok, true);
    const o = created.observation;
    const submit = await call({ command: 'SubmitOrder', sessionId: o.sessionId, observationId: o.observationId,
        expectedRevision: '0', requestId: 'tool-submit', symbol: 'DEMO-A', quantity: '100', side: 'buy' });
    assert.equal(submit.ok, true);
    assert.equal(submit.receipt.status, 'pending');
    const invalid = await call({ command: 'CreateSession', requestId: 'bad-tool', symbols: 'not-json' });
    assert.equal(invalid.code, 'INVALID_ARGUMENT');
    const invalidEnvelope = await plugin.processToolCall({ command: 'CreateSession', requestId: 'bad-tool', symbols: 'not-json' });
    assert.equal(invalidEnvelope.status, 'error');
    assert.equal(invalidEnvelope.code, 'INVALID_ARGUMENT');
    let mounted;
    plugin.registerRoutes({}, { use(route, handler) { mounted = { route, handler }; } }, {}, directory);
    assert.equal(mounted.route, '/vtrade');
    assert.equal(plugin.registerRoutes.length, 4);
    assert.throws(() => createHandler({}), { code: 'INVALID_HOST' });
    // Exercise the actual mounted handler, supplying the inherited-auth boundary explicitly.
    server = http.createServer((req, res) => {
        req.originalUrl = `/admin_api/vtrade${req.url}`;
        mounted.handler(req, res);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/command`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-VTrade-Request': '1' },
        body: JSON.stringify({ command: 'GetObservation', sessionId: o.sessionId }) });
    assert.equal((await response.json()).observation.orders.length, 1);
    // The admin panel serves on another port and forwards to the main one over loopback, so Origin and Host differ;
    // the browser's Sec-Fetch-Site decides, and a forwarded request without it is not compared by Origin.
    // A request that reached the main port directly must still carry a matching Origin.
    const write = headers => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/command', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-VTrade-Request': '1', Origin: 'http://127.0.0.1:1', ...headers } },
        res => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject); req.end(JSON.stringify({ command: 'GetSources' }));
    });
    assert.equal(await write({ 'Sec-Fetch-Site': 'same-origin' }), 200);
    assert.equal(await write({ 'Sec-Fetch-Site': 'same-site' }), 403);
    assert.equal(await write({ 'Sec-Fetch-Site': 'cross-site', Origin: `http://127.0.0.1:${server.address().port}` }), 403);
    assert.equal(await write({}), 200);
    assert.equal(await write({ Host: 'vtrade.example:8080' }), 403);
    assert.equal(await write({ Host: 'vtrade.example:8080', Origin: 'http://vtrade.example:8080' }), 200);
});

test('user TDX import -> VCP preparation and trades -> mounted HTTP journal -> restart is one ledger', async t => {
    const directory = await temporary(t);
    await plugin.initialize({ VTRADE_DATA_DIR: directory });
    let server, mounted;
    t.after(async () => {
        if (server) await new Promise(resolve => server.close(resolve));
        await plugin.shutdown(); await removeTemporary(directory);
    });
    plugin.registerRoutes({}, { use(route, handler) { mounted = handler; } }, {}, directory);
    server = http.createServer((req, res) => {
        req.originalUrl = req.url;
        req.url = req.url.replace(/^\/admin_api\/vtrade/, '') || '/';
        mounted(req, res);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const post = async (route, args) => (await fetch(`${origin}/admin_api/vtrade/api/${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-VTrade-Request': '1' },
        body: JSON.stringify(args) })).json();
    const call = async args => {
        const envelope = await plugin.processToolCall(args);
        assert.equal(envelope.status, 'success', JSON.stringify(envelope));
        return JSON.parse(envelope.result.content[0].text);
    };
    const bytes = Buffer.alloc(8 * 32);
    for (let i = 0; i < 8; i++) {
        for (const [offset, value] of [[0, 20250106 + i], [4, 1001], [8, 1002], [12, 1001], [16, 1001], [24, 10000]]) {
            bytes.writeUInt32LE(value, i * 32 + offset);
        }
    }
    const imported = await post('import', { format: 'tdx', dataBase64: bytes.toString('base64'), symbol: 'TEST-TDX' });
    assert.equal(imported.ok, true);
    let o = (await call({ command: 'CreateSession', requestId: 'tdx-create', datasetId: imported.datasetId,
        startDate: '2025-01-06', symbols: '["TEST-TDX"]' })).observation;
    let sequence = 0;
    const write = async (command, extra = {}) => {
        const args = { command, sessionId: o.sessionId, expectedRevision: String(o.revision),
            observationId: o.observationId, requestId: `tdx-write-${++sequence}`, ...extra };
        const result = await call(args); assert.equal(result.ok, true, JSON.stringify(result));
        o = result.observation; return { result, args };
    };
    const plan = await write('SavePlan', { symbol: 'TEST-TDX', side: 'buy', quantity: '300', note: 'Synthetic plan' });
    const submit = await write('SubmitOrder', { symbol: 'TEST-TDX', side: 'buy', quantity: '300',
        planId: plan.result.receipt.planId });
    const retry = await call(submit.args);
    assert.equal(retry.duplicate, true); assert.deepEqual(retry.receipt, submit.result.receipt);
    await write('AdvanceDay');
    await write('SubmitOrder', { symbol: 'TEST-TDX', side: 'sell', quantity: '100' });
    await write('AdvanceDay');
    const web = await post('command', { command: 'GetObservation', sessionId: o.sessionId });
    assert.deepEqual(web.observation, o);
    assert.equal(o.account.positions[0].quantity, 200);
    assert.equal(o.account.positions[0].costCents, 200467);
    await write('SubmitOrder', { symbol: 'TEST-TDX', side: 'sell', quantity: '200' });
    await write('AdvanceDay');
    await write('SaveReview', { note: 'Synthetic completed review' });
    await write('PauseSession');
    assert.equal(o.account.cashCents, 9999100);
    assert.equal(o.account.realizedCents, -900);
    assert.equal(o.account.positions.length, 0);
    const page = await call({ command: 'GetJournal', sessionId: o.sessionId, limit: '2' });
    assert.equal(page.journal.events.length, 2); assert.equal(page.journal.hasMore, true);
    const before = o;
    await plugin.shutdown(); await plugin.initialize({ VTRADE_DATA_DIR: directory });
    plugin.registerRoutes({}, { use(route, handler) { mounted = handler; } }, {}, directory);
    assert.deepEqual((await post('command', { command: 'GetObservation', sessionId: o.sessionId })).observation, before);
    assert.equal((await call(submit.args)).duplicate, true);
    assert.equal((await post('import', { format: 'unknown' })).code, 'INVALID_DATA');
    assert.equal((await post('import', { format: 'tdx', dataBase64: 'invalid!' })).code, 'INVALID_DATA');
});
