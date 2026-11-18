'use strict';

// Disposable synthetic fixture only; never opens the production knowledge store.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const Database = require('better-sqlite3');
// Independent parallel graph builds can differ after pruning. Pin the default
// fixture to one worker; callers may override it to investigate that variability.
process.env.RAYON_NUM_THREADS ||= '1';
const binding = process.env.TDB_NATIVE_BINDING
    ? require(path.resolve(process.env.TDB_NATIVE_BINDING)) : require('../rust-vexus-lite');
const dimension = Number(process.env.TDB_TEST_DIMENSION || 65);
const count = Number(process.env.TDB_TEST_COUNT || 128);
const queryCount = Number(process.env.TDB_TEST_QUERIES || 4);
assert(Number.isInteger(dimension) && dimension > 0 && dimension <= 4096);
assert(Number.isInteger(count) && count >= 10 && count <= 10000);
assert(Number.isInteger(queryCount) && queryCount > 0 && queryCount <= 100);
let seed = 918273;
const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296 * 2 - 1;
};
const unit = () => {
    const row = Float32Array.from({ length: dimension }, random);
    const norm = Math.hypot(...row);
    return Float32Array.from(row, value => value / norm);
};
const cosine = (a, b) => {
    let dot = 0, aa = 0, bb = 0;
    for (let d = 0; d < dimension; d++) {
        dot += a[d] * b[d]; aa += a[d] * a[d]; bb += b[d] * b[d];
    }
    return dot / Math.sqrt(aa * bb);
};
async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-sql-routing-quality-'));
    const dbPath = path.join(root, 'test.sqlite');
    const asset = path.join(root, 'standalone.vec');
    const rows = Array.from({ length: count }, unit);
    const queries = Array.from({ length: queryCount }, unit);
    const index = new binding.VexusIndex(dimension, count + 16);
    const runtime = new binding.NativeKnowledgeRuntime(index);
    let db;
    try {
        runtime.openAndInitStore(dbPath);
        db = new Database(dbPath);
        db.transaction(() => {
            const insert = db.prepare('INSERT INTO tags(id,name,vector) VALUES (?,?,?)');
            rows.forEach((row, i) => insert.run(i + 1, String(i + 1), Buffer.from(row.buffer)));
        })();
        db.close(); db = null;
        console.log(`[routing-quality] dimension=${dimension}, count=${count}, workers=${process.env.RAYON_NUM_THREADS}: building SQL memory routing`);
        const began = performance.now();
        const restored = JSON.parse(await runtime.restoreGlobalTagIndex(
            dbPath, path.join(root, 'tags_a.vec'), 'quality', count + 16));
        const buildMs = performance.now() - began;
        console.log(`[routing-quality] SQL routing complete: ${buildMs.toFixed(1)}ms; mode=${count < 2048 ? 'exact-flat' : 'graph'}`);
        assert.equal(restored.vectorCount, count);
        assert.equal(index.stats().mmapBytes, 0);
        assert(!fs.readdirSync(root).some(name => name.includes('.vec')));
        const standalone = new binding.VexusIndex(dimension, count + 16);
        const vectors = new Float32Array(count * dimension);
        rows.forEach((row, i) => vectors.set(row, i * dimension));
        standalone.addBatch(rows.map((_, i) => i + 1), vectors);
        console.log('[routing-quality] building standalone snapshot routing');
        const saveStarted = performance.now();
        standalone.save(asset);
        console.log(`[routing-quality] standalone save: ${(performance.now() - saveStarted).toFixed(1)}ms`);
        console.log('[routing-quality] standalone snapshot complete; comparing queries');
        const mapped = binding.VexusIndex.load(asset, null, dimension, count + 16);
        const latencies = [], referenceLatencies = [];
        let hits = 0, referenceHits = 0;
        const k = 10;
        for (const query of queries) {
            const truth = new Set(rows.map((row, i) => ({ id: i + 1, score: cosine(query, row) }))
                .sort((a, b) => b.score - a.score || a.id - b.id).slice(0, k).map(row => row.id));
            let started = performance.now();
            const results = JSON.parse(await runtime.searchGlobalTags(query, k));
            latencies.push(performance.now() - started);
            started = performance.now();
            const reference = mapped.search(query, k);
            referenceLatencies.push(performance.now() - started);
            assert.equal(results.length, k);
            hits += results.filter(hit => truth.has(Number(hit.tag))).length;
            referenceHits += reference.filter(hit => truth.has(hit.id)).length;
            for (const hit of results) {
                assert(Math.abs(hit.score - cosine(query, rows[Number(hit.tag) - 1])) <= 1e-6);
            }
        }
        assert.equal(index.stats().mmapBytes, 0);
        assert.deepEqual(fs.readdirSync(root).filter(name => name.includes('.vec')), ['standalone.vec']);
        const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)];
        console.log(JSON.stringify({
            fixture: 'seeded-unit-random-v1', dimension, count, queryCount,
            sqlRecall: hits / (queryCount * k), snapshotRecall: referenceHits / (queryCount * k),
            buildMs, sqlP50Ms: percentile(latencies, 0.5), sqlMaxMs: Math.max(...latencies),
            snapshotP50Ms: percentile(referenceLatencies, 0.5), stats: index.stats()
        }, null, 2));
        assert(hits >= referenceHits, 'SQL memory routing recall regressed against TDB snapshot routing');

        // Isolate original-vector access from graph-construction variability:
        // both queries below consume the exact same endorsed routing.
        console.log('[routing-quality] publishing authorized SQL baseline for same-routing comparison');
        const baselinePath = path.join(root, 'tags_a.vec');
        const checkpointStarted = performance.now();
        assert.equal(JSON.parse(await runtime.checkpointGlobalTagIndex(
            dbPath, baselinePath, 'quality', 0.05, false, true)).published, true);
        console.log(`[routing-quality] checkpoint complete: ${(performance.now() - checkpointStarted).toFixed(1)}ms`);
        await runtime.restoreGlobalTagIndex(dbPath, baselinePath, 'quality', count + 16);
        const sameRouting = binding.VexusIndex.load(baselinePath, null, dimension, count + 16);
        console.log('[routing-quality] baseline restored; comparing identical routing');
        for (const query of queries) {
            const sql = JSON.parse(await runtime.searchGlobalTags(query, k));
            const snapshot = sameRouting.search(query, k);
            assert.deepEqual(sql.map(hit => Number(hit.tag)), snapshot.map(hit => hit.id),
                'same routing must return identical IDs from SQL and snapshot originals');
            sql.forEach((hit, i) => assert(Math.abs(hit.score - snapshot[i].score) <= 1e-6));
        }
        assert.equal(index.stats().mmapBytes, 0);
    } finally {
        db?.close();
        console.log('[routing-quality] draining Runtime and removing disposable fixture');
        runtime.shutdown();
        fs.rmSync(root, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });