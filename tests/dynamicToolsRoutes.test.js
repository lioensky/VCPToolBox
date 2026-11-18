'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const registry = require('../modules/dynamicToolRegistry');
const createRouter = require('../routes/admin/dynamicTools');

const clone = value => JSON.parse(JSON.stringify(value));
function merge(base, patch) {
    const next = clone(base);
    for (const [key, value] of Object.entries(patch)) {
        next[key] = value && typeof value === 'object' && !Array.isArray(value)
            ? merge(next[key] || {}, value) : clone(value);
    }
    return next;
}
function configFixture() {
    return merge(registry.DEFAULT_CONFIG, {
        version: 2,
        summary: { lightListTokenBudget: 15, briefTokenBudget: 6, minBriefTokenBudget: 3 },
        classification: { maxCategories: 3, embeddingThreshold: 0.34, categoryRules: [{ category: 'web_search', parent: 'search', description: 'Search web pages', keywords: ['web'] }] },
        smallModel: { enabled: true, model: 'fixture-model', maxRetries: 2, retryDelayMs: 250, maxTokens: 2048, temperature: 0.1 },
        manualOverrides: { excludedOriginKeys: ['local:hidden'], pinnedOriginKeys: ['local:pinned'], categoryAliases: { web: 'web_search' }, descriptionOverrides: { 'local:x': { brief: 'Search', fullDescription: 'Search pages', categories: ['web_search'], keywords: ['web'] } } }
    });
}
async function fixture(t) {
    let current = configFixture();
    let writes = 0;
    let failWrite = false;
    t.mock.method(registry, 'getAdminState', () => ({ config: clone(current), records: [], snapshotId: writes }));
    t.mock.method(registry, 'updateConfig', async patch => {
        if (failWrite) throw new Error('fixture write failure');
        current = merge(current, patch);
        writes++;
        return clone(current);
    });
    t.mock.method(registry, '_mutateConfig', async makePatch => registry.updateConfig(registry.validateConfigPatch(makePatch(clone(current)))));
    const app = express();
    app.use(express.json({ strict: false }));
    app.use('/admin_api', createRouter({}));
    const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}/admin_api/dynamic-tools`;
    return {
        get: async path => { const response = await fetch(base + path); return { status: response.status, body: await response.json() }; },
        post: async (path, body) => { const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; },
        current: () => clone(current), writes: () => writes, fail: () => { failWrite = true; }
    };
}

test('dynamic tools HTTP keeps complete v2 patch and partial nested fields', async t => {
    const f = await fixture(t);
    const payload = configFixture();
    delete payload.placeholder;
    payload.summary = { lightListTokenBudget: 22, briefTokenBudget: 9, minBriefTokenBudget: 4 };
    payload.smallModel.maxTokens = 1024;
    const full = await f.post('/config', payload);
    assert.equal(full.status, 200);
    assert.deepEqual(full.body.config.summary, payload.summary);
    assert.deepEqual(full.body.config.classification, payload.classification);
    assert.equal(full.body.config.smallModel.maxTokens, 1024);
    const partial = await f.post('/config', { smallModel: { model: 'next-model' }, manualOverrides: { categoryAliases: { 网页: 'web_search' } } });
    assert.equal(partial.status, 200);
    assert.equal(partial.body.config.smallModel.enabled, true);
    assert.equal(partial.body.config.smallModel.maxTokens, 1024);
    assert.equal(partial.body.config.smallModel.model, 'next-model');
    assert.deepEqual(partial.body.config.manualOverrides.pinnedOriginKeys, ['local:pinned']);
    assert.deepEqual(partial.body.config.manualOverrides.descriptionOverrides, payload.manualOverrides.descriptionOverrides);
});

test('dynamic tools HTTP rejects invalid types/ranges/arrays with 400 before update', async t => {
    const f = await fixture(t);
    const before = f.current();
    const invalid = [null, [], true, { enabled: 'false' }, { useRagEmbeddings: 1 }, { maxBriefListItems: '2' }, { maxExpandedPlugins: 0.5 }, { classifierTimeoutMs: null }, { maxInjectionChars: -1 }, { unknown: true }, { summary: { briefTokenBudget: 0 } }, { classification: { maxCategories: 100, categoryRules: [] } }, { classification: { embeddingThreshold: 2 } }, { classification: { categoryRules: [{ category: 'x', description: 'x', keywords: [2] }] } }, { smallModel: { enabled: 'yes' } }, { smallModel: { maxRetries: 8 } }, { smallModel: { maxTokens: 0 } }, { smallModel: { temperature: 9 } }, { manualOverrides: { pinnedOriginKeys: [5] } }, { manualOverrides: { descriptionOverrides: { x: { categories: 'not-array' } } } }];
    for (const payload of invalid) {
        const result = await f.post('/config', payload);
        assert.equal(result.status, 400, JSON.stringify(payload));
    }
    assert.equal(f.writes(), 0);
    assert.deepEqual(f.current(), before);
});

test('override route keeps unrelated overrides and rejects invalid booleans/arrays', async t => {
    const f = await fixture(t);
    const invalid = await f.post('/override', { originKey: 'local:x', pinned: 'true' });
    assert.equal(invalid.status, 400);
    assert.equal((await f.post('/override', { originKey: '', pinned: true })).status, 400);
    assert.equal((await f.post('/override', { manualOverrides: { excludedOriginKeys: [7] } })).status, 400);
    const result = await f.post('/override', { originKey: 'local:x', pinned: true });
    assert.equal(result.status, 200);
    assert.ok(result.body.config.manualOverrides.pinnedOriginKeys.includes('local:x'));
    assert.deepEqual(result.body.config.manualOverrides.excludedOriginKeys, ['local:hidden']);
    const partial = await f.post('/override', { manualOverrides: { categoryAliases: { 中文: 'web_search' } } });
    assert.equal(partial.status, 200);
    assert.deepEqual(partial.body.config.manualOverrides.pinnedOriginKeys, result.body.config.manualOverrides.pinnedOriginKeys);
});

test('legacy endpoint/key fields never return and write failure preserves active config', async t => {
    const f = await fixture(t);
    const secret = 'fixture-secret-do-not-echo';
    const result = await f.post('/config', { smallModel: { endpoint: 'https://private.invalid', apiKey: secret, apiKeyEnv: 'PRIVATE_API_KEY', useMainConfig: false, model: 'public-model' } });
    assert.equal(result.status, 200);
    for (const body of [result.body, (await f.get('/config')).body, (await f.get('/state')).body]) {
        const json = JSON.stringify(body);
        assert.ok(!json.includes(secret));
        assert.ok(!json.includes('private.invalid'));
        for (const key of ['apiKey', 'apiKeyEnv', 'endpoint', 'useMainConfig']) assert.ok(!Object.hasOwn(body.config.smallModel, key), key);
    }
    const before = f.current();
    f.fail();
    const failed = await f.post('/config', { smallModel: { model: 'failed-model' } });
    assert.equal(failed.status, 500);
    assert.deepEqual(f.current(), before);
});

async function realFixture(t, onRequest = null) {
    const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-dynamic-routes-real-'));
    const runtime = new registry.DynamicToolRegistry();
    await runtime.initialize({ projectBasePath: root, watchConfigFiles: false, pluginManager: { plugins: new Map() }, config: { classificationDebounceMs: 60000, useRagEmbeddings: false } });
    t.mock.method(registry, 'getAdminState', runtime.getAdminState.bind(runtime));
    t.mock.method(registry, 'updateConfig', runtime.updateConfig.bind(runtime));
    if (typeof runtime.updateOverride === 'function') t.mock.method(registry, 'updateOverride', runtime.updateOverride.bind(runtime));
    const app = express(); app.use(express.json());
    if (onRequest) app.use(onRequest);
    app.use('/admin_api', createRouter({}));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); clearTimeout(runtime.classificationTimer); await runtime.writePromise.catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
    return { runtime, fs, post: async (route, payload) => { const res = await fetch(`http://127.0.0.1:${server.address().port}/admin_api/dynamic-tools${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); return { status: res.status, body: await res.json() }; } };
}

test('review-1 committed config returns success even when post-commit catalog sync fails', async (t) => {
    const f = await realFixture(t);
    t.mock.method(f.runtime, '_writeCatalog', async () => { throw new Error('catalog private failure'); });
    const result = await f.post('/config', { maxBriefListItems: 17 });
    assert.equal(result.status, 200); assert.equal(result.body.config.maxBriefListItems, 17);
    assert.equal(JSON.parse(await f.fs.readFile(f.runtime.configPath, 'utf8')).maxBriefListItems, 17);
    assert.match(f.runtime.lastError, /配置已保存.*同步失败/); assert.doesNotMatch(f.runtime.lastError, /private failure/);
    t.mock.method(f.runtime, '_writeJsonAtomic', async () => { throw new Error('write failed'); });
    const failed = await f.post('/config', { maxBriefListItems: 19 }); assert.equal(failed.status, 500);
    assert.equal(f.runtime.config.maxBriefListItems, 17);
});

test('review-1 later successful sync clears commit warning without exposing the previous raw failure', async (t) => {
    const f = await realFixture(t); const original = f.runtime._writeCatalog.bind(f.runtime); let fail = true;
    t.mock.method(f.runtime, '_writeCatalog', async () => { if (fail) { fail = false; throw new Error('private catalog failure'); } return original(); });
    assert.equal((await f.post('/config', { maxBriefListItems: 17 })).status, 200);
    assert.match(f.runtime.lastError, /配置已保存/);
    assert.equal((await f.post('/config', { maxBriefListItems: 18 })).status, 200);
    assert.equal(f.runtime.lastError, null);
});

test('review-2 concurrent HTTP pin updates preserve both memberships inside config mutation queue', async (t) => {
    let releaseWrite, signalWrite; const writeStarted = new Promise((resolve) => { signalWrite = resolve; });
    let count = 0;
    const f = await realFixture(t, (_req, _res, next) => { count++; next(); if (count === 2) setImmediate(() => releaseWrite()); });
    const original = f.runtime._writeJsonAtomic.bind(f.runtime); let blocked = false;
    t.mock.method(f.runtime, '_writeJsonAtomic', async (...args) => {
        if (!blocked && args[0] === f.runtime.configPath) { blocked = true; signalWrite(); await new Promise((resolve) => { releaseWrite = resolve; }); }
        return original(...args);
    });
    const first = f.post('/override', { originKey: 'local:A', pinned: true }); await writeStarted;
    const second = f.post('/override', { originKey: 'local:B', pinned: true });
    const results = await Promise.all([first, second]); assert.deepEqual(results.map((r) => r.status), [200, 200]);
    assert.deepEqual(f.runtime.config.manualOverrides.pinnedOriginKeys, ['local:A', 'local:B']);
    assert.deepEqual(JSON.parse(await f.fs.readFile(f.runtime.configPath, 'utf8')).manualOverrides.pinnedOriginKeys, ['local:A', 'local:B']);
    const mixed = await Promise.all([
        f.post('/override', { originKey: 'local:C', pinned: true }),
        f.post('/config', { smallModel: { model: 'mixed-config' }, manualOverrides: { categoryAliases: { web: 'search/web' } } })
    ]);
    assert.deepEqual(mixed.map((r) => r.status), [200, 200]);
    assert.deepEqual(f.runtime.config.manualOverrides.pinnedOriginKeys, ['local:A', 'local:B', 'local:C']);
    assert.equal(f.runtime.config.smallModel.model, 'mixed-config');
    assert.deepEqual(f.runtime.config.manualOverrides.categoryAliases, { web: 'search/web' });
});
