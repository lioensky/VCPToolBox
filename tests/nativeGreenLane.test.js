'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Database = require('better-sqlite3');
const { VexusIndex, NativeKnowledgeRuntime } = require('../rust-vexus-lite');

test('native green lane runs without Memo assets, filters scope and enforces HTTP deadline', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-green-'));
    const dbPath = path.join(root, 'test.sqlite');
    const runtime = new NativeKnowledgeRuntime(new VexusIndex(2, 16));
    const keys = ['JEV_API_URL', 'JEV_API_KEY', 'JEV_PROXY_URL', 'NativeRerankTimeoutMs'];
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    let delayed = false;
    let received = 0;
    const server = http.createServer(async (request, response) => {
        let raw = '';
        for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw);
        const criteria = body.questions.best_memory.criteria;
        received++;
        assert.equal(Object.keys(criteria).length, 2);
        assert(!JSON.stringify(criteria).includes('OUTSIDE'));
        if (delayed) return;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ answers: { best_memory: {
            type: 'choice', probabilities: { doc_000: 0.2, doc_001: 0.8 }
        } } }));
    });
    try {
        runtime.openAndInitStore(dbPath);
        const db = new Database(dbPath);
        try {
            db.prepare('INSERT INTO files(id,path,diary_name,checksum,mtime,size) VALUES (?,?,?,?,0,1)')
                .run(1, 'A/a.txt', 'A', 'fixture');
            db.prepare('INSERT INTO files(id,path,diary_name,checksum,mtime,size) VALUES (?,?,?,?,0,1)')
                .run(2, 'B/b.txt', 'B', 'fixture');
            const insert = db.prepare('INSERT INTO chunks(id,file_id,chunk_index,content,vector) VALUES (?,?,?,?,?)');
            insert.run(1, 1, 0, 'allowed one', Buffer.from(new Float32Array([1, 0]).buffer));
            insert.run(2, 1, 1, 'allowed two', Buffer.from(new Float32Array([0.8, 0.2]).buffer));
            insert.run(3, 2, 0, 'OUTSIDE', Buffer.from(new Float32Array([1, 0]).buffer));
        } finally {
            db.close();
        }
        const index = new VexusIndex(2, 16);
        await runtime.restoreDiaryIndex(dbPath, 'A', path.join(root, 'a.vec'), 'fixture', 16, index);
        runtime.registerDiaryIndex('A', index);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        process.env.JEV_API_URL = `http://127.0.0.1:${server.address().port}/jev`;
        process.env.JEV_API_KEY = 'fixture';
        process.env.JEV_PROXY_URL = '';
        process.env.NativeRerankTimeoutMs = '100';
        const plan = JSON.stringify({
            diaryNames: ['A'], useJev: true, topK: 2, candidateK: 16, externalK: 2,
            configPath: path.join(root, 'missing.env'),
            fileCandidates: [{ path: 'B/b.txt', normalizedBM25Score: 1 }],
            excludedPrefixes: []
        });
        const result = JSON.parse(await runtime.executeExternalRerank(plan, new Float32Array([1, 0])));
        assert.equal(result.diagnostics.nativeRerank.greenLane, true);
        assert.deepEqual(result.results.map(row => row.chunkId), [2, 1]);
        assert.equal(runtime.stats().memoRuntimeResident, false);
        delayed = true;
        await assert.rejects(runtime.executeExternalRerank(plan, new Float32Array([1, 0])), /RERANK_DEADLINE|RERANK_NETWORK_ERROR/);
        assert.equal(received, 2);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        runtime.shutdown();
        for (const key of keys) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key];
        }
        fs.rmSync(root, { recursive: true, force: true });
    }
});