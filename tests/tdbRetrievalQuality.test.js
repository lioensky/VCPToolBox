'use strict';

// Run after building the isolated TDB release artifact. The default binding
// remains the pre-migration USearch baseline; neither artifact is overwritten.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const oldBinding = require(process.env.TDB_BASELINE_BINDING
    ? path.resolve(process.env.TDB_BASELINE_BINDING)
    : '../rust-vexus-lite');
const newBinding = require(process.env.TDB_NATIVE_BINDING
    ? path.resolve(process.env.TDB_NATIVE_BINDING)
    : '../rust-vexus-lite/target/tdb-validation/vexus-lite.win32-x64-msvc.node');
const oldProbe = new oldBinding.VexusIndex(3, 16);
const newProbe = new newBinding.VexusIndex(3, 16);
assert.equal(new oldBinding.NativeKnowledgeRuntime(oldProbe).capabilities()
    .capabilities.includes('index.tdb-vec.v1'), false,
    'Baseline is already TDB; specify a preserved USearch artifact with TDB_BASELINE_BINDING');
assert.equal(new newBinding.NativeKnowledgeRuntime(newProbe).capabilities()
    .capabilities.includes('index.tdb-vec.v1'), true,
    'Comparison artifact must expose the TDB backend capability');

const dimension = Number(process.env.TDB_TEST_DIMENSION || 65);
const count = Number(process.env.TDB_TEST_COUNT || 2304);
const queryCount = Number(process.env.TDB_TEST_QUERIES || 32);
assert(Number.isSafeInteger(dimension) && dimension > 0 && dimension <= 3072);
assert(Number.isSafeInteger(count) && count >= 2048 && count <= 100000);
assert(Number.isSafeInteger(queryCount) && queryCount > 0 && queryCount <= 1000);
const k = 10;
let seed = 918273;
function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296 * 2 - 1;
}
function unit(values) {
    const norm = Math.hypot(...values);
    return Float32Array.from(values, value => value / norm);
}
function cosine(a, b) {
    let dot = 0;
    let aa = 0;
    let bb = 0;
    for (let d = 0; d < dimension; d++) {
        dot += a[d] * b[d];
        aa += a[d] * a[d];
        bb += b[d] * b[d];
    }
    return dot / Math.sqrt(aa * bb);
}
const rows = Array.from({ length: count }, () =>
    unit(Array.from({ length: dimension }, random)));
const ids = rows.map((_, position) => position + 1);
const vectors = new Float32Array(count * dimension);
rows.forEach((row, position) => vectors.set(row, position * dimension));
const queries = Array.from({ length: queryCount }, () =>
    unit(Array.from({ length: dimension }, random)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-tdb-quality-'));
try {
    const oldIndex = new oldBinding.VexusIndex(dimension, count + 32);
    const newIndex = new newBinding.VexusIndex(dimension, count + 32);
    oldIndex.addBatch(ids, vectors);
    newIndex.addBatch(ids, vectors);
    const asset = path.join(root, 'graph.vec');
    const buildStarted = performance.now();
    newIndex.save(asset);
    const buildMs = performance.now() - buildStarted;
    const mapped = new newBinding.VexusIndex(dimension, 16);
    const loaded = newBinding.VexusIndex.load(asset, null, dimension, count + 32);
    assert(loaded.stats().mmapBytes > 0);
    assert.equal(mapped.stats().totalVectors, 0);
    assert.equal(fs.readFileSync(asset)[25], 1, 'fixture must exercise QuIVer, not flat scan');

    let oldHits = 0;
    let newHits = 0;
    const latencies = [];
    for (const query of queries) {
        const exact = rows.map((row, position) => ({
            id: position + 1, score: cosine(query, row)
        })).sort((a, b) => b.score - a.score || a.id - b.id).slice(0, k);
        const truth = new Set(exact.map(row => row.id));
        const previous = oldIndex.search(query, k);
        const started = performance.now();
        const current = loaded.search(query, k);
        latencies.push(performance.now() - started);
        oldHits += previous.filter(row => truth.has(row.id)).length;
        newHits += current.filter(row => truth.has(row.id)).length;
        assert.equal(current.length, k);
        for (const result of current) {
            assert(Math.abs(result.score - cosine(query, rows[result.id - 1])) <= 1e-6,
                'candidate score must equal original f32 cosine');
        }
    }
    latencies.sort((a, b) => a - b);
    const metrics = {
        fixture: 'seeded-unit-random-v1', dimension, count, queries: queries.length, k,
        oldRecall: oldHits / (queries.length * k),
        newRecall: newHits / (queries.length * k),
        buildMs,
        queryP50Ms: latencies[Math.floor(latencies.length * 0.5)],
        queryP99Ms: latencies[latencies.length - 1],
        stats: loaded.stats()
    };
    console.log(JSON.stringify(metrics, null, 2));
    assert(newHits >= oldHits, 'TDB recall regressed against the pre-migration artifact');
} finally {
    try {
        fs.rmSync(root, { recursive: true, force: true });
    } catch (error) {
        console.warn(`Temporary mmap cleanup deferred: ${error.message}`);
    }
}