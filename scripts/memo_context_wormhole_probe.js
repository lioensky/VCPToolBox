'use strict';

// Read-only chunk-vector mechanism probe. No embedding API, native runtime or DB writes.
// node scripts/memo_context_wormhole_probe.js [--samples 12] [--json]
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { gunzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const Database = require('better-sqlite3');
const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const countArg = args.indexOf('--samples');
const samples = countArg < 0 ? 12 : Number(args[countArg + 1]);
assert(Number.isInteger(samples) && samples >= 2 && samples <= 100);
const spike = JSON.parse(fs.readFileSync(path.join(root, 'rag_params.json'), 'utf8'))
    .KnowledgeBaseManager.spikeRouting;
const config = {
    samples, seeds: 3, k: spike.maxNeighborsPerNode ?? 20,
    resonanceThresholds: [0.1, 0.2, 0.3], resonancePower: 4,
    energy: 1, minimumCurrent: spike.minimumInjectedCurrent ?? 0.01,
    firingThreshold: spike.firingThreshold ?? 0.1,
    baseDecay: spike.baseDecay ?? 0.25, wormholeDecay: spike.wormholeDecay ?? 0.7
};
function dot(a, b) {
    assert.equal(a.length, b.length);
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
    return sum;
}
function unit(v) {
    const norm = Math.sqrt(dot(v, v));
    if (!Number.isFinite(norm) || norm < 1e-10) return null;
    return Float32Array.from(v, x => x / norm);
}
function decode(bytes) {
    if (!bytes || bytes.length % 4) return null;
    const v = new Float32Array(bytes.length / 4);
    for (let i = 0; i < v.length; i++) v[i] = bytes.readFloatLE(i * 4);
    return unit(v);
}
const started = performance.now();
const db = new Database(path.join(root, 'VectorStore', 'knowledge_base.sqlite'),
    { readonly: true, fileMustExist: true });
let snapshot;
try {
    db.pragma('query_only=ON');
    snapshot = db.transaction(() => {
        const asset = db.prepare(`SELECT artifact_sig,payload,payload_codec,payload_checksum
            FROM rivermemo_artifacts WHERE status='ready' AND payload IS NOT NULL
            ORDER BY updated_at DESC,artifact_sig LIMIT 1`).get();
        assert(asset);
        const tags = [];
        for (const row of db.prepare('SELECT id,name,vector FROM tags ORDER BY id').iterate()) {
            const vector = decode(row.vector);
            if (vector) tags.push({ id: row.id, name: row.name, vector });
        }
        const chunkIds = db.prepare('SELECT id FROM chunks WHERE vector IS NOT NULL ORDER BY id').all();
        const chunkStmt = db.prepare('SELECT id,file_id,vector FROM chunks WHERE id=?');
        const fileStmt = db.prepare('SELECT tag_id FROM file_tags WHERE file_id=?');
        const chunks = Array.from({ length: Math.min(samples, chunkIds.length) }, (_, i) => {
            const id = chunkIds[Math.floor(i * chunkIds.length / Math.min(samples, chunkIds.length))].id;
            const row = chunkStmt.get(id);
            return { id, fileId: row.file_id, vector: decode(row.vector),
                reference: new Set(fileStmt.all(row.file_id).map(t => t.tag_id)) };
        });
        const dependencies = db.prepare(`SELECT d.dependency_key,d.dependency_version,m.value AS current
            FROM kbm_artifact_dependencies d LEFT JOIN kbm_runtime_meta m ON m.key=d.dependency_key
            WHERE d.artifact_sig=?`).all(asset.artifact_sig);
        return { asset, tags, chunks, dependencies, availableChunks: chunkIds.length };
    })();
} finally { db.close(); }
const { asset, tags, chunks } = snapshot;
assert.equal(asset.payload_codec, 'gzip-json-v1');
const raw = gunzipSync(asset.payload, { maxOutputLength: 536870912 });
assert.equal(createHash('sha256').update(raw).digest('hex'), asset.payload_checksum);
const payload = JSON.parse(raw);
const graph = payload.sharedTransport;
const index = new Map(graph.nodeIds.map((id, i) => [id, i]));
const byId = new Map(tags.map(t => [t.id, t]));
const flags = new Set(payload.wormholeView ?? []);
const gain = new Map(payload.anchorGainView ?? []);
assert(chunks.every(c => c.vector && c.vector.length === tags[0].vector.length));
assert(tags.every(t => t.vector.length === tags[0].vector.length));
function rowFor(id) {
    const source = index.get(id);
    if (source === undefined) return [];
    const row = [];
    for (let i = graph.rowOffsets[source]; i < graph.rowOffsets[source + 1]; i++) {
        const target = graph.nodeIds[graph.targetIndices[i]];
        if (graph.weights[i] > 0 && byId.has(target)) row.push({
            id: target, c: graph.weights[i],
            staticWormhole: flags.has(`${id}:${target}`)
                || graph.weights[i] * (gain.get(target) ?? 1) >= (spike.tensionThreshold ?? 1)
        });
    }
    row.sort((a, b) => b.c - a.c || a.id - b.id);
    return row.map((e, i) => ({ ...e, rawRank: i + 1 }));
}
const summaries = new Map();
const examples = [];
const queryResults = [];
function record(key, selected, source, chunk, threshold, control) {
    if (!summaries.has(key)) summaries.set(key, {
        mode: key, trials: 0, selected: 0, tailSelected: 0, dynamicWormholes: 0,
        fired: 0, tailFired: 0, onwardEligible: 0, fileTagHits: 0, cosineSum: 0,
        momentumCost: 0
    });
    const s = summaries.get(key);
    s.trials++;
    for (const e of selected) {
        const dynamic = (e.r ?? 0) >= threshold;
        const wormhole = e.staticWormhole || dynamic;
        const current = config.energy * e.c * (wormhole ? config.wormholeDecay : config.baseDecay);
        const fired = current >= config.minimumCurrent;
        s.selected++;
        s.tailSelected += Number(e.rawRank > config.k);
        s.dynamicWormholes += Number(dynamic);
        s.fired += Number(fired);
        s.tailFired += Number(fired && e.rawRank > config.k);
        s.onwardEligible += Number(fired && current >= config.firingThreshold);
        s.fileTagHits += Number(chunk.reference.has(e.id));
        s.cosineSum += dot(chunk.vector, byId.get(e.id).vector);
        s.momentumCost += Number(fired && !wormhole);
        if (!control && key === 'residual:adjacency@0.1' && e.rawRank > config.k) {
            examples.push({
                chunkId: chunk.id, source: byId.get(source).name, target: byId.get(e.id).name,
                rawRank: e.rawRank, resonance: e.r, conductance: e.c, current,
                fired, fileTagHit: chunk.reference.has(e.id)
            });
        }
    }
}
for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    // Exact full-corpus cosine scan: semantic baseline, NOT an ANN speed/recall test.
    const nearest = tags.map(t => ({ id: t.id, sim: dot(chunk.vector, t.vector) }))
        .sort((a, b) => b.sim - a.sim || a.id - b.id);
    const seeds = nearest.filter(t => index.has(t.id)).slice(0, config.seeds);
    const seedSet = new Set(seeds.map(s => s.id));
    const annTop = nearest.filter(t => !seedSet.has(t.id)).slice(0, config.k);
    const unionNeighbors = new Set(seeds.flatMap(s => rowFor(s.id).map(e => e.id)));
    queryResults.push({
        chunkId: chunk.id, seeds: seeds.map(s => byId.get(s.id).name),
        vectorTop20WithoutSeed: annTop.length,
        vectorTop20WithNoSeedEdge: annTop.filter(t => !unionNeighbors.has(t.id)).length,
        vectorTop20FileTagHits: annTop.filter(t => chunk.reference.has(t.id)).length
    });
    for (const seed of seeds) {
        const row = rowFor(seed.id);
        record('static-topK', row.slice(0, config.k), seed.id, chunk, Infinity, false);
        for (const control of [false, true]) {
            const query = control ? chunks[(ci + 1) % chunks.length].vector : chunk.vector;
            const source = byId.get(seed.id).vector;
            const projection = dot(query, source);
            const residualRaw = Float32Array.from(query, (v, d) => v - projection * source[d]);
            const residualNorm = Math.sqrt(dot(residualRaw, residualRaw));
            const residual = unit(residualRaw);
            for (const direction of ['context', 'residual']) {
                // Avoid unit-normalization amplifying a near-zero residual.
                const vector = direction === 'context' ? query : residual;
                const annotated = row.map(e => ({
                    ...e, r: vector && (direction !== 'residual' || residualNorm >= 0.05)
                        ? Math.max(0, dot(vector, byId.get(e.id).vector)) : 0
                }));
                for (const threshold of config.resonanceThresholds) {
                    const qualified = annotated.filter(e => e.r >= threshold);
                    for (const policy of ['conductance', 'adjacency']) {
                        const ranked = qualified.map(e => ({
                            ...e, score: (policy === 'conductance' ? e.c : 1)
                                * e.r ** config.resonancePower
                        })).sort((a, b) => b.score - a.score || b.c - a.c || a.id - b.id);
                        // Gate first, then Top-K: no fallback fills below-threshold slots.
                        const selected = ranked.slice(0, config.k);
                        assert(selected.every(e => e.c > 0 && e.r >= threshold));
                        record(`${control ? 'shuffled-' : ''}${direction}:${policy}@${threshold}`,
                            selected, seed.id, chunk, threshold, control);
                    }
                }
            }
        }
    }
}
const summary = [...summaries.values()].map(s => ({
    ...s,
    meanQueryCosine: s.selected ? s.cosineSum / s.selected : null,
    fileTagHitRate: s.selected ? s.fileTagHits / s.selected : null
}));
examples.sort((a, b) => b.rawRank - a.rawRank || b.resonance - a.resonance);
const report = {
    scope: 'Real chunk-vector one-hop dynamic-wormhole mechanism probe; not production or held-out retrieval evaluation.',
    config, artifact: asset.artifact_sig, dependencies: snapshot.dependencies,
    data: { tags: tags.length, availableChunks: snapshot.availableChunks, sampledChunks: chunks.length,
        dimension: tags[0].vector.length },
    definitions: {
        residual: 'unit(q - dot(q,source)*source); one-anchor residual, NOT production EPA residual',
        conductance: 'c * max(0,cos(direction,target))^4, gated by resonance threshold',
        adjacency: '1[historical edge] * max(0,cos(direction,target))^4',
        dynamicWormhole: 'qualified historical edge; momentum cost=0, current=energy*c*wormholeDecay',
        shuffled: 'next sampled chunk supplies context; original seeds and file references unchanged'
    },
    limitations: [
        'Stored chunk vectors are inputs; no query contains an expected target tag vector.',
        'History is constrained to persisted CSR, not all possible file cooccurrences.',
        'File-tag hits are weak in-sample references: the same files contributed to graph construction.',
        'No-edge vector neighbors are unsupported by this graph, NOT proven hallucinations.',
        'Full-corpus cosine is an exact vector baseline, not the native ANN implementation.',
        'Thresholds/power are experimental; more tail selections are not automatically better.',
        'One-hop only; zero momentum cost does not bypass minimum current or firing thresholds.'
    ],
    summary, queryResults, tailExamples: examples.slice(0, 16),
    elapsedMs: performance.now() - started
};
if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
    console.log(report.scope, report.data, 'asset=', report.artifact);
    console.log('Config:', config, 'Dependencies:', report.dependencies);
    console.table(summary.map(({ cosineSum, ...s }) => ({
        ...s, meanQueryCosine: s.meanQueryCosine?.toFixed(4), fileTagHitRate: s.fileTagHitRate?.toFixed(4)
    })));
    console.table(queryResults);
    console.table(report.tailExamples);
    for (const note of report.limitations) console.log('-', note);
    console.log('Elapsed ms:', report.elapsedMs.toFixed(1), 'Assertions passed.');
}