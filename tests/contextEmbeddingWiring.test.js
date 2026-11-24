'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const ragSingleton = require('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');
const FoldingStore = require('../Plugin/RAGDiaryPlugin/FoldingStore');

const { getTokenCount } = require('../TextChunker');

test('long context shares one upstream request and the same exact cache entry', async () => {
    const rag = new ragSingleton.constructor();
    rag.cacheManager.createCache('embedding');
    const bridge = rag.getContextBridge();
    const question = '最终问题：定位这批记录的失败原因。';
    const text = '附件正文。'.repeat(18000);
    const content = [{ type: 'text', text }, { type: 'text', text: question }];
    const message = { role: 'user', content };
    const clean = rag.sanitizeForEmbedding(`${text}\n${question}`, 'user');
    const calls = [];
    let complete;
    rag.getSingleEmbedding = input => {
        calls.push(input);
        return new Promise(resolve => { complete = resolve; });
    };

    assert.equal(bridge.getEmbeddingFromCache(clean, 'user'), null);
    assert.equal(calls.length, 0);
    const route = rag.getSingleEmbeddingCached(clean, { contextRole: 'user' });
    const timeline = bridge.embedText(clean, { contextRole: 'user' });
    const vector = [1, 0];
    assert.equal(calls.length, 1);
    assert.ok(getTokenCount(calls[0]) <= 5000);
    assert.ok(calls[0].endsWith(question));
    complete(vector);
    assert.strictEqual(await route, vector);
    assert.strictEqual(await timeline, vector);
    assert.strictEqual(bridge.getEmbeddingFromCache(clean, 'user'), vector);
    await rag.contextVectorManager.updateContext([message, { role: 'user', content: 'new user message' }]);
    assert.strictEqual(rag.contextVectorManager.historyUserVectors[0], vector);
    assert.equal(calls.length, 1);
});

test('legacy FoldingStore migrates existing summaries and updates vectors without eviction', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-fold-projection-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, 'store.db');
    const old = new Database(dbPath);
    old.exec(`
        CREATE TABLE folding_entries (
            content_hash TEXT PRIMARY KEY, text_preview TEXT NOT NULL, vector BLOB,
            summary TEXT DEFAULT '', summary_status TEXT DEFAULT 'none', retry_count INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        INSERT INTO folding_entries VALUES ('full-message-hash', 'preview', NULL, 'keep me', 'ready', 2, 1, 1);
    `);
    old.close();
    const store = new FoldingStore(dbPath, { maxEntries: 1, evictCount: 1 });
    try {
        assert.equal(store.getEntry('full-message-hash').vector_input_hash, null);
        store.upsertVector('full-message-hash', { vector: [0.5, 0.25], vectorInputHash: 'projected-input-hash' });
        const updated = store.getEntry('full-message-hash');
        assert.equal(updated.vector_input_hash, 'projected-input-hash');
        assert.deepEqual(Array.from(updated.vector), [0.5, 0.25]);
        assert.equal(updated.summary, 'keep me');
        assert.equal(updated.summary_status, 'ready');
        assert.equal(updated.retry_count, 2);
    } finally {
        store.shutdown();
    }
});