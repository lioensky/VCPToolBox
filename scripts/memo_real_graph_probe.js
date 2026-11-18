'use strict';

// Read-only persisted-graph experiment, NOT native execution or retrieval evaluation.
// node scripts/memo_real_graph_probe.js
// node scripts/memo_real_graph_probe.js --json
const Database = require('better-sqlite3');
const { gunzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'rag_params.json'), 'utf8'))
    .KnowledgeBaseManager.spikeRouting;
const settings = {
    k: Math.max(1, config.maxNeighborsPerNode ?? 20),
    baseDecay: config.baseDecay ?? 0.25,
    wormholeDecay: config.wormholeDecay ?? 0.7,
    tensionThreshold: config.tensionThreshold ?? 1,
    minimumCurrent: config.minimumInjectedCurrent ?? 0.01,
    firingThreshold: config.firingThreshold ?? 0.1
};
const db = new Database(path.join(root, 'VectorStore', 'knowledge_base.sqlite'), {
    readonly: true, fileMustExist: true
});
let snapshot;
try {
    db.pragma('query_only = ON');
    snapshot = db.transaction(() => {
        const asset = db.prepare(`SELECT artifact_sig, payload_codec, payload_checksum,
            payload, node_count, edge_count, database_generation, updated_at
            FROM rivermemo_artifacts WHERE status = 'ready' AND payload IS NOT NULL
            ORDER BY updated_at DESC, artifact_sig ASC LIMIT 1`).get();
        assert(asset, 'No ready persisted graph; do not rebuild production data for this probe.');
        const dependencies = db.prepare(`SELECT d.dependency_key, d.dependency_version,
            m.value AS current_version FROM kbm_artifact_dependencies d
            LEFT JOIN kbm_runtime_meta m ON m.key = d.dependency_key
            WHERE d.artifact_sig = ? ORDER BY d.dependency_key`).all(asset.artifact_sig);
        return {
            asset, dependencies,
            tagCount: db.prepare('SELECT COUNT(*) AS n FROM tags').get().n,
            names: new Map(db.prepare('SELECT id, name FROM tags').all().map(r => [r.id, r.name]))
        };
    })();
} finally {
    db.close();
}
const { asset, names } = snapshot;
assert.equal(asset.payload_codec, 'gzip-json-v1');
const raw = gunzipSync(asset.payload, { maxOutputLength: 512 * 1024 * 1024 });
assert.equal(createHash('sha256').update(raw).digest('hex'), asset.payload_checksum,
    'Persisted graph checksum mismatch');
const payload = JSON.parse(raw);
const graph = payload.sharedTransport;
assert(graph);
const ids = graph.nodeIds;
const offsets = graph.rowOffsets;
const targets = graph.targetIndices;
const weights = graph.weights;
assert.equal(offsets.length, ids.length + 1);
assert.equal(offsets[0], 0);
assert.equal(offsets.at(-1), targets.length);
assert.equal(weights.length, targets.length);
assert.equal(new Set(ids).size, ids.length);
assert(ids.every(id => Number.isSafeInteger(id) && id > 0));
assert(offsets.every((n, i) => Number.isSafeInteger(n) && n >= 0
    && (i === 0 || n >= offsets[i - 1])));
assert(targets.every(t => Number.isSafeInteger(t) && t >= 0 && t < ids.length));
assert(weights.every(w => Number.isFinite(w) && w >= 0));
const wormholes = new Set(payload.wormholeView ?? []);
const gains = new Map(payload.anchorGainView ?? []);
const rawOrder = (a, b) => b.weight - a.weight || a.target - b.target;
const effectiveOrder = (a, b) => b.effective - a.effective || rawOrder(a, b);
const variants = [
    { name: 'raw/0', effective: false, slots: 0 },
    { name: 'raw/2', effective: false, slots: 2 },
    { name: 'effective/0', effective: true, slots: 0 },
    { name: 'effective/2', effective: true, slots: 2 }
];
const energies = [0.25, 1, 4];
const records = energies.flatMap(energy => variants.map(variant => ({
    energy, variant: variant.name, changedRows: 0, fired: 0, wormholesFired: 0,
    promoted: 0, rowsWithPromotion: 0, onwardEligibleStates: 0,
    injectedMass: 0, displacedFired: 0, displacedMass: 0,
    addedMass: 0, rowsWithLessMass: 0
})));
const degrees = [];
const examples = [];
let dynamicOnly = 0;
let classifiedWormholes = 0;
let highDegree = 0;
const started = performance.now();

for (let source = 0; source < ids.length; source++) {
    const row = [];
    for (let cursor = offsets[source]; cursor < offsets[source + 1]; cursor++) {
        const weight = weights[cursor];
        if (weight <= 0) continue;
        const target = ids[targets[cursor]];
        const explicit = wormholes.has(`${ids[source]}:${target}`);
        const isWormhole = explicit || weight * (gains.get(target) ?? 1) >= settings.tensionThreshold;
        classifiedWormholes += Number(isWormhole);
        dynamicOnly += Number(isWormhole && !explicit);
        row.push({
            target, weight, wormhole: isWormhole,
            effective: weight * (isWormhole ? settings.wormholeDecay : settings.baseDecay)
        });
    }
    // Equivalent to NativeArtifact::prepared ordering, computed once per source.
    row.sort(rawOrder);
    degrees.push(row.length);
    highDegree += Number(row.length > settings.k);
    const rawSelected = row.slice(0, settings.k);
    const rawIds = new Set(rawSelected.map(e => e.target));
    const effectiveRanked = [...row].sort(effectiveOrder);
    const rankedWormholes = effectiveRanked.filter(e => e.wormhole);
    for (const energy of energies) {
        const baselineFired = rawSelected.filter(e => energy * e.effective >= settings.minimumCurrent);
        const baselineMass = baselineFired.reduce((sum, e) => sum + energy * e.effective, 0);
        // Same assumptions as first probe: no previous node, positive momentum,
        // source energy already passed firing gate, no destination state truncation.
        const eligible = rankedWormholes.filter(e => energy * e.effective >= settings.minimumCurrent);
        for (const variant of variants) {
            const stats = records.find(r => r.energy === energy && r.variant === variant.name);
            const reserved = eligible.slice(0, Math.min(variant.slots, settings.k));
            const reservedIds = new Set(reserved.map(e => e.target));
            const ranked = variant.effective ? effectiveRanked : row;
            const selected = [...reserved, ...ranked.filter(e => !reservedIds.has(e.target))]
                .slice(0, settings.k);
            assert(selected.length <= settings.k);
            const selectedIds = new Set(selected.map(e => e.target));
            const fired = selected.filter(e => energy * e.effective >= settings.minimumCurrent);
            const promoted = fired.filter(e => e.wormhole && !rawIds.has(e.target));
            const displaced = baselineFired.filter(e => !selectedIds.has(e.target));
            const added = fired.filter(e => !rawIds.has(e.target));
            const mass = fired.reduce((sum, e) => sum + energy * e.effective, 0);
            stats.changedRows += Number(selected.some(e => !rawIds.has(e.target)));
            stats.fired += fired.length;
            stats.wormholesFired += fired.filter(e => e.wormhole).length;
            stats.promoted += promoted.length;
            stats.rowsWithPromotion += Number(promoted.length > 0);
            stats.onwardEligibleStates += fired.filter(e => energy * e.effective >= settings.firingThreshold).length;
            stats.injectedMass += mass;
            stats.displacedFired += displaced.length;
            stats.displacedMass += displaced.reduce((sum, e) => sum + energy * e.effective, 0);
            stats.addedMass += added.reduce((sum, e) => sum + energy * e.effective, 0);
            stats.rowsWithLessMass += Number(mass < baselineMass - 1e-12);
            if (energy === 4 && variant.name === 'effective/0') {
                for (const edge of promoted) {
                    examples.push({
                        sourceId: ids[source], source: names.get(ids[source]),
                        targetId: edge.target, target: names.get(edge.target),
                        degree: row.length, rawRank: row.findIndex(e => e.target === edge.target) + 1,
                        conductance: edge.weight, injectedAtEnergy4: energy * edge.effective,
                        minimumSourceEnergy: settings.minimumCurrent / edge.effective,
                        onwardEligible: energy * edge.effective >= settings.firingThreshold
                    });
                }
            }
        }
    }
}
degrees.sort((a, b) => a - b);
const quantile = p => degrees[Math.floor((degrees.length - 1) * p)];
for (const energy of energies) {
    const rawStats = records.find(r => r.energy === energy && r.variant === 'raw/0');
    const effectiveStats = records.find(r => r.energy === energy && r.variant === 'effective/0');
    assert(effectiveStats.injectedMass >= rawStats.injectedMass - 1e-8);
    for (const r of records.filter(r => r.energy === energy)) {
        r.massDeltaVsRaw = r.injectedMass - rawStats.injectedMass;
        r.wormholesDeltaVsEffective0 = r.wormholesFired - effectiveStats.wormholesFired;
    }
}
examples.sort((a, b) => b.injectedAtEnergy4 - a.injectedAtEnergy4 || a.sourceId - b.sourceId || a.targetId - b.targetId);
const report = {
    scope: 'Read-only real persisted CSR; exhaustive independent one-hop source trials, NOT a multi-hop query or retrieval-quality benchmark.',
    assumptions: [
        'Each source is independently supplied the specified energy; totals are not one real query.',
        'No immediate-return penalty, negative momentum, state cap, FIR, or multi-seed confluence.',
        'Reservation is an orthogonal within-K quota; raw/2 deliberately does not mean legacy behavior.',
        'Onward eligibility is per accepted destination state, not a guarantee of another injected edge.',
        'JS timing includes validation/assertions and statistics; not a Rust performance comparison.'
    ],
    settings,
    asset: {
        signature: asset.artifact_sig, databaseGeneration: asset.database_generation,
        updatedAt: asset.updated_at, checksumVerified: true,
        tags: snapshot.tagCount, nodes: ids.length, edges: targets.length,
        explicitWormholeRecords: wormholes.size, classifiedWormholes, dynamicOnly,
        dependencies: snapshot.dependencies
    },
    degrees: { p50: quantile(0.5), p90: quantile(0.9), p99: quantile(0.99), max: degrees.at(-1), aboveK: highDegree },
    trials: records,
    strongestPromotedExamplesAtEnergy4: examples.slice(0, 12),
    elapsedMs: performance.now() - started
};
if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
} else {
    console.log(report.scope);
    console.log('Asset:', report.asset);
    console.log('Settings:', settings, 'Degrees:', report.degrees);
    console.table(records.map(r => Object.fromEntries(Object.entries(r).map(([key, value]) =>
        [key, typeof value === 'number' ? Number(value.toFixed(6)) : value]))));
    console.table(report.strongestPromotedExamplesAtEnergy4);
    for (const assumption of report.assumptions) console.log('-', assumption);
    console.log('Elapsed ms:', report.elapsedMs.toFixed(1), 'Assertions passed.');
}