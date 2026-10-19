'use strict';

// Read-only hot-path benchmark. Offline exact-search pyramid proxy, NOT native ANN.
// node scripts/memo_pyramid_csr_probe.js [--samples 24] [--json]
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { gunzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const root = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const pos = argv.indexOf('--samples');
const samples = pos < 0 ? 24 : Number(argv[pos + 1]);
assert(Number.isInteger(samples) && samples >= 2 && samples <= 100);
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'rag_params.json'), 'utf8'))
    .KnowledgeBaseManager.spikeRouting;
const dot = (a, b) => {
    let sum = 0;
    for (let d = 0; d < a.length; d++) sum += a[d] * b[d];
    return sum;
};
function decode(bytes) {
    if (!bytes || bytes.length % 4) return null;
    const v = new Float32Array(bytes.length / 4);
    for (let d = 0; d < v.length; d++) v[d] = bytes.readFloatLE(d * 4);
    const norm = Math.sqrt(dot(v, v));
    return Number.isFinite(norm) && norm > 1e-12 ? { v, norm } : null;
}
const started = performance.now();
const db = new Database(path.join(root, 'VectorStore', 'knowledge_base.sqlite'),
    { readonly: true, fileMustExist: true });
let data;
try {
    db.pragma('query_only=ON');
    data = db.transaction(() => {
        const asset = db.prepare(`SELECT artifact_sig,payload,payload_checksum,payload_codec
            FROM rivermemo_artifacts WHERE status='ready' AND payload IS NOT NULL
            ORDER BY updated_at DESC,artifact_sig LIMIT 1`).get();
        assert(asset);
        const tags = [];
        for (const r of db.prepare('SELECT id,name,vector FROM tags ORDER BY id').iterate()) {
            const v = decode(r.vector);
            if (v) tags.push({ id: r.id, name: r.name, ...v });
        }
        const ids = db.prepare('SELECT id FROM chunks WHERE vector IS NOT NULL ORDER BY id').all();
        const get = db.prepare('SELECT vector FROM chunks WHERE id=?');
        const chunks = Array.from({ length: Math.min(samples, ids.length) }, (_, i) => {
            const id = ids[Math.floor(i * ids.length / Math.min(samples, ids.length))].id;
            const v = decode(get.get(id).vector);
            assert(v);
            return { id, ...v };
        });
        return { asset, tags, chunks };
    })();
} finally { db.close(); }
const { asset, tags, chunks } = data;
assert.equal(asset.payload_codec, 'gzip-json-v1');
const raw = gunzipSync(asset.payload, { maxOutputLength: 536870912 });
assert.equal(createHash('sha256').update(raw).digest('hex'), asset.payload_checksum);
const graph = JSON.parse(raw).sharedTransport;
const byId = new Map(tags.map(t => [t.id, t]));
const index = new Map(graph.nodeIds.map((id, i) => [id, i]));
const dimension = tags[0].v.length;
assert(tags.every(t => t.v.length === dimension));
assert(chunks.every(t => t.v.length === dimension));
const loadMs = performance.now() - started;
function pyramid(chunk) {
    let residual = chunk.v.slice();
    const originalEnergy = dot(residual, residual);
    const levels = [];
    for (let level = 0; level < 3; level++) {
        const norm = Math.sqrt(dot(residual, residual));
        if (norm <= 1e-12) break;
        const candidates = tags.map(t => ({ id: t.id, similarity: dot(residual, t.v) / (norm * t.norm) }))
            .sort((a, b) => b.similarity - a.similarity || a.id - b.id).slice(0, 10);
        // Gram-Schmidt and f32 projection accumulation mirror the production outline.
        const basis = [];
        const coefficients = [];
        for (const tag of candidates) {
            const v = Float64Array.from(byId.get(tag.id).v);
            for (const axis of basis) {
                const p = dot(v, axis);
                for (let d = 0; d < dimension; d++) v[d] -= p * axis[d];
            }
            const n = Math.sqrt(dot(v, v));
            if (n <= 1e-12) { coefficients.push(0); continue; }
            for (let d = 0; d < dimension; d++) v[d] /= n;
            coefficients.push(Math.abs(dot(residual, v)));
            basis.push(v);
        }
        const projection = new Float32Array(dimension);
        for (const axis of basis) {
            const coefficient = dot(residual, axis);
            for (let d = 0; d < dimension; d++) {
                projection[d] = Math.fround(projection[d] + Math.fround(coefficient * axis[d]));
            }
        }
        levels.push({ level, residual, norm,
            candidates: candidates.map((t, i) => ({ ...t, contribution: coefficients[i] })) });
        residual = Float32Array.from(residual, (v, d) => v - projection[d]);
        if (dot(residual, residual) / originalEnergy < 0.1) break;
    }
    return levels;
}
const prepareStarted = performance.now();
const prepared = chunks.map(chunk => ({ chunkId: chunk.id, levels: pyramid(chunk) }));
const pyramidProxyMs = performance.now() - prepareStarted;
const k = cfg.maxNeighborsPerNode ?? 20;
const threshold = 0.2;
const minimumCurrent = cfg.minimumInjectedCurrent ?? 0.01;
const wormholeDecay = cfg.wormholeDecay ?? 0.7;
const jobs = [];
const examples = [];
let scannedEdges = 0;
let tailMatches = 0;
let matched = 0;
let passedCurrentAtUnitEnergy = 0;
let passedCurrentAtPyramidEnergy = 0;
const candidateIds = new Set();
for (const query of prepared) {
    for (const level of query.levels) {
        for (const candidate of level.candidates) candidateIds.add(`${query.chunkId}:${candidate.id}`);
        const support = new Map();
        for (const other of query.levels) {
            // Only deeper residual branches support this source layer.
            if (other.level <= level.level) continue;
            for (const tag of other.candidates) {
                if (tag.similarity >= threshold) {
                    support.set(tag.id, Math.max(support.get(tag.id) ?? 0, tag.similarity));
                }
            }
        }
        // Keep all source rows, even when the deeper shortlist has no qualifying
        // candidate. Full-neighbor evaluation must not inherit shortlist gating.
        if (!query.levels.some(other => other.level > level.level)) continue;
        for (const seed of level.candidates) {
            const source = index.get(seed.id);
            if (source === undefined) continue;
            const row = [];
            for (let c = graph.rowOffsets[source]; c < graph.rowOffsets[source + 1]; c++) {
                if (graph.weights[c] > 0) row.push({
                    id: graph.nodeIds[graph.targetIndices[c]], c: graph.weights[c]
                });
            }
            row.sort((a, b) => b.c - a.c || a.id - b.id);
            const rawIds = new Set(row.slice(0, k).map(e => e.id));
            const job = { row, support, seed, chunkId: query.chunkId, level: level.level,
                deeper: query.levels.filter(l => l.level > level.level) };
            jobs.push(job);
            scannedEdges += row.length;
            for (let rank = 0; rank < row.length; rank++) {
                const edge = row[rank];
                if (!support.has(edge.id)) continue;
                matched++;
                const tail = !rawIds.has(edge.id);
                tailMatches += Number(tail);
                const current = edge.c * wormholeDecay;
                const seedEnergy = seed.contribution * 0.7 ** level.level;
                passedCurrentAtUnitEnergy += Number(current >= minimumCurrent);
                // No language/core gates: this is a simplified pre-gate energy proxy.
                passedCurrentAtPyramidEnergy += Number(seedEnergy * current >= minimumCurrent);
                if (tail) examples.push({
                    chunkId: query.chunkId, source: byId.get(seed.id)?.name,
                    target: byId.get(edge.id)?.name, rawRank: rank + 1,
                    resonance: support.get(edge.id), currentAtUnitEnergy: current
                });
            }
        }
    }
}
function intersection() {
    let count = 0, checksum = 0;
    for (const job of jobs) {
        for (const edge of job.row) {
            const score = job.support.get(edge.id);
            if (score !== undefined) { count++; checksum += score; }
        }
    }
    return { count, checksum };
}
function localDots() {
    let count = 0, checksum = 0;
    for (const job of jobs) {
        for (const edge of job.row) {
            const target = byId.get(edge.id);
            if (!target) continue;
            let score = 0;
            for (const level of job.deeper) {
                score = Math.max(score, dot(level.residual, target.v) / (level.norm * target.norm));
            }
            if (score >= threshold) { count++; checksum += score; }
        }
    }
    return { count, checksum };
}
const oracle = jobs.reduce((sum, job) =>
    sum + job.row.filter(e => job.support.has(e.id)).length, 0);
assert.equal(intersection().count, oracle);
for (let i = 0; i < 20; i++) intersection();
function benchmark(fn, repeats) {
    const times = [];
    let result;
    for (let i = 0; i < repeats; i++) {
        const begin = performance.now();
        result = fn();
        times.push(performance.now() - begin);
    }
    times.sort((a, b) => a - b);
    return { repeats, medianBatchMs: times[Math.floor(times.length / 2)],
        medianPerChunkMs: times[Math.floor(times.length / 2)] / chunks.length, result };
}
const sparse = benchmark(intersection, 101);
localDots();
const dense = benchmark(localDots, 9);

// Each invocation builds a fresh request-local cache. The timing INCLUDES cache
// construction and score computation, not merely lookup into a prebuilt cache.
// Same residual layer + same target is computed once across all source rows.
function cachedScores(global = false) {
    const caches = new Map();
    let dotProducts = 0;
    let count = 0, checksum = 0, tail = 0, tailFired = 0;
    let newlyDiscoveredTargets = 0;
    let selected = 0, selectedTail = 0, selectedTailFired = 0;
    const discovered = new Set();
    function score(chunkId, level, target) {
        const key = `${chunkId}:${level.level}`;
        let cache = caches.get(key);
        if (!cache) { cache = new Map(); caches.set(key, cache); }
        if (!cache.has(target.id)) {
            cache.set(target.id, Math.max(0,
                dot(level.residual, target.v) / (level.norm * target.norm)));
            dotProducts++;
        }
        return cache.get(target.id);
    }
    if (global) {
        // Exhaustive reference: evaluate every Tag before filtering by graph.
        // No global Top-K truncation, so local-vs-global equality is meaningful.
        const layers = new Map();
        for (const job of jobs) for (const level of job.deeper) {
            layers.set(`${job.chunkId}:${level.level}`, { chunkId: job.chunkId, level });
        }
        for (const { chunkId, level } of layers.values()) {
            for (const target of tags) score(chunkId, level, target);
        }
    }
    for (const job of jobs) {
        const qualified = [];
        for (let rank = 0; rank < job.row.length; rank++) {
            const edge = job.row[rank];
            const target = byId.get(edge.id);
            if (!target) continue;
            let resonance = 0;
            for (const level of job.deeper) {
                resonance = Math.max(resonance, score(job.chunkId, level, target));
            }
            if (resonance < threshold) continue;
            count++; checksum += resonance;
            tail += Number(rank >= k);
            tailFired += Number(rank >= k && edge.c * wormholeDecay >= minimumCurrent);
            const identity = `${job.chunkId}:${edge.id}`;
            if (!candidateIds.has(identity) && !discovered.has(identity)) {
                discovered.add(identity); newlyDiscoveredTargets++;
            }
            qualified.push({ id: edge.id, c: edge.c, rank, resonance });
        }
        // Historical existence is the gate; resonance determines ranking.
        qualified.sort((a, b) => b.resonance - a.resonance || b.c - a.c || a.id - b.id);
        const retained = qualified.slice(0, k);
        selected += retained.length;
        selectedTail += retained.filter(e => e.rank >= k).length;
        selectedTailFired += retained.filter(e =>
            e.rank >= k && e.c * wormholeDecay >= minimumCurrent).length;
    }
    return { count, checksum, dotProducts, tail, tailFired, newlyDiscoveredTargets,
        selected, selectedTail, selectedTailFired };
}
cachedScores();
const cached = benchmark(() => cachedScores(false), 9);
const globalReference = benchmark(() => cachedScores(true), 1);
const expected = globalReference.result;
const actual = cached.result;
for (const key of ['count', 'tail', 'tailFired', 'newlyDiscoveredTargets',
    'selected', 'selectedTail', 'selectedTailFired']) {
    assert.equal(actual[key], expected[key], `Local/global mismatch: ${key}`);
}
assert(Math.abs(actual.checksum - expected.checksum) < 1e-9);
assert.equal(actual.count, dense.result.count);
assert(Math.abs(actual.checksum - dense.result.checksum) < 1e-9);
const extraLocal = dense.result.count - oracle;
const report = {
    scope: 'Warm in-memory JS hot-path benchmark using offline exact-search pyramid proxy; not native analyze_pyramid execution.',
    data: { tags: tags.length, chunks: chunks.length, dimension, artifact: asset.artifact_sig,
        levels: prepared.map(q => q.levels.length), jobs: jobs.length, scannedEdges },
    settings: { k, threshold, layers: 3, pyramidTopK: 10, minimumCurrent, wormholeDecay },
    timings: { loadMs, pyramidProxyMs, sparse, dense, cached, globalReference,
        measuredHotPathRatio: dense.medianBatchMs / sparse.medianBatchMs,
        cachedVsGlobalRatio: globalReference.medianBatchMs / cached.medianBatchMs,
        cachedVsRepeatedDotsRatio: dense.medianBatchMs / cached.medianBatchMs },
    exactness: {
        matchedGlobalHistoricalEdges: true,
        scoreChecksumAbsoluteDifference: Math.abs(actual.checksum - expected.checksum),
        dotProductReduction: 1 - actual.dotProducts / expected.dotProducts,
        note: 'Same residuals, threshold, graph and Top-K; equality to exhaustive cosine after historical-edge filtering, NOT a relevance-quality claim.'
    },
    results: { matched, tailMatches, passedCurrentAtUnitEnergy, passedCurrentAtPyramidEnergy,
        newlyDiscoveredNodes: 0, extraMatchesWithLocalDots: extraLocal,
        explanation: 'Every sparse target was already a deeper-layer candidate: transitions, not new node discovery.' },
    examples: examples.sort((a, b) => b.rawRank - a.rawRank).slice(0, 12),
    caveats: [
        'Candidate generation uses full-corpus exact cosine, not production search_sql; its time is reported separately.',
        'Sparse lookup is exact only within the retained pyramid shortlist; local dots examine a broader candidate set.',
        'Sparse/dense timings exclude SQL, graph preparation, support-map construction and Top-K selection.',
        'Cached/global timings include fresh score-cache construction and resonance Top-K sorting, but exclude SQL vector fetch/decode and graph preparation.',
        'All vectors are preloaded. This measures warm compute, NOT cold production latency.',
        'All source rows with deeper residuals are included, even with an empty qualifying shortlist; this expands trials relative to the earlier probe.',
        'Global reference has one timed run; ratios are indicative, not a stable native performance benchmark.',
        'Rows are object arrays prepared from real CSR; Rust CSR timings are NOT measured.',
        'Pyramid energy proxy omits language/core gates, so it is not production seed energy.',
        'No momentum consumption on qualified edges does not bypass current or firing thresholds.',
        'Persisted graph may lag current facts; no production artifact rebuild was performed.'
    ]
};
assert.equal(matched, sparse.result.count);
if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
    console.log(report.scope);
    console.log(JSON.stringify({ ...report, examples: undefined }, null, 2));
    console.table(report.examples);
}