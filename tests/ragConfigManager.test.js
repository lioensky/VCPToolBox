'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const configManager = require('../Plugin/RAGDiaryPlugin/RAGConfigManager.js');
const ragSingleton = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js');

test('RAG params reload invalidates the query cache only when the content changes', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-rag-config-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const paramsPath = path.join(root, 'rag_params.json');
    const rag = new ragSingleton.constructor();
    const cleared = [];
    rag.cacheManager.clear = name => cleared.push(name);

    const first = { RAGDiaryPlugin: { mainSearchWeights: [0.7, 0.3] } };
    await fs.writeFile(paramsPath, JSON.stringify(first));
    await configManager.loadRagParams(rag, root);
    assert.deepEqual(rag.ragParams, first);
    assert.deepEqual(cleared, ['query']);

    await fs.writeFile(paramsPath, JSON.stringify(first, null, 2));
    await configManager.loadRagParams(rag, root);
    assert.deepEqual(cleared, ['query']);

    const next = { RAGDiaryPlugin: { mainSearchWeights: [0.8, 0.2] } };
    await fs.writeFile(paramsPath, JSON.stringify(next));
    await configManager.loadRagParams(rag, root);
    assert.deepEqual(rag.ragParams, next);
    assert.deepEqual(cleared, ['query', 'query']);
});

test('RAG watcher shutdown cancels scheduled reloads and closes both watchers once', async () => {
    const calls = [];
    const host = {
        ragParamsReloadTimer: setTimeout(() => calls.push('params reload'), 0),
        ragTagsReloadTimer: setTimeout(() => calls.push('tags reload'), 0),
        ragParamsWatcher: { close: () => calls.push('params close') },
        ragTagsWatcher: { close: () => calls.push('tags close') }
    };

    configManager.stopWatchers(host);
    configManager.stopWatchers(host);
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual(calls, ['params close', 'tags close']);
    assert.ok(Object.values(host).every(value => value === null));
});