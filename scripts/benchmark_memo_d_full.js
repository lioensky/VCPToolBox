'use strict';
// Run only against disposable ags-benchmark-* copies. Never copies a live SQLite file.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function stats(values) {
    if (!values.length) return { n: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    return {
        n: sorted.length,
        mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
        ...Object.fromEntries([0, 50, 95, 99, 100].map(p => [
            `p${p}`, sorted[Math.floor((sorted.length - 1) * p / 100)]
        ]))
    };
}
async function main() {
    const [dbArg, binaryArg, outArg, mode] = process.argv.slice(2);
    assert(dbArg && binaryArg && outArg && ['C', 'D'].includes(mode));
    const db = path.resolve(dbArg);
    assert(path.basename(db).startsWith('ags-benchmark-'), 'disposable DB required');
    assert(fs.existsSync(db), 'DB must already exist');
    const binary = path.resolve(binaryArg);
    const native = require(binary);
    const config = structuredClone(require('../rag_params.json').KnowledgeBaseManager.geometry);
    let reader = new Database(db, { readonly: true, fileMustExist: true });
    const dims = reader.prepare('SELECT DISTINCT length(vector)/4 AS d FROM tags WHERE vector IS NOT NULL').all();
    assert.equal(dims.length, 1);
    const tags = reader.prepare('SELECT COUNT(*) AS n FROM tags').get().n;
    const facts = reader.prepare("SELECT key,value FROM kbm_runtime_meta WHERE key='memo_tag_facts'").all();
    reader.close();
    reader = null;
    const index = new native.VexusIndex(dims[0].d, tags + 16);
    const runtime = new native.NativeKnowledgeRuntime(index);
    const report = {
        mode, binarySha256: hash(fs.readFileSync(binary)), tags, dimensions: dims[0].d,
        facts, cases: [], limits: [
            'Full geometry build, not retrieval quality or end-to-end graph construction.',
            'Warm sequential cases; order and OS caching can influence timing.',
            'RSS includes Node, native storage, workspaces and SQLite; not a pure kernel measurement.'
        ]
    };
    const save = () => fs.writeFileSync(path.resolve(outArg), JSON.stringify(report, null, 2) + '\n');
    try {
        runtime.openAndInitStore(db);
        reader = new Database(db, { readonly: true, fileMustExist: true });
        const cases = mode === 'C'
            ? [[48, 4], [96, 24]]
            : [[48, 4], [48, 24], [96, 24], [96, 32], [96, 24]];
        let baseline;
        for (const [neighbors, axes] of cases) {
            const geometry = structuredClone(config);
            Object.assign(geometry.local, { maxNeighbors: neighbors, maxBasis: axes });
            const result = await index.computeMemoGeometry(db, 'memo-D-full-benchmark',
                JSON.stringify({ ...geometry, forceRecompute: true }));
            assert.equal(result.success, true);
            const rows = reader.prepare(
                'SELECT tag_id,raw_residual_ratio,v9_anchor_gain,neighbor_count FROM tag_intrinsic_residuals ORDER BY tag_id'
            ).all();
            const rawCache = JSON.parse(reader.prepare("SELECT value FROM kv_store WHERE key='epa_basis_cache'").get().value);
            const { artifactSig, timestamp, ...mathCache } = rawCache;
            assert.equal(artifactSig, result.artifactSig);
            if (!baseline) baseline = new Map(rows.map(r => [r.tag_id, r]));
            const gainDeltas = rows.filter(r => baseline.has(r.tag_id))
                .map(r => r.v9_anchor_gain - baseline.get(r.tag_id).v9_anchor_gain);
            const status = reader.prepare(
                'SELECT status,COUNT(*) AS n FROM tag_intrinsic_residual_status GROUP BY status'
            ).all();
            assert.equal(rows.length + status.reduce((s, r) => s + r.n, 0), tags);
            assert(rows.every(r => Number.isFinite(r.raw_residual_ratio)
                && r.raw_residual_ratio >= 0 && r.raw_residual_ratio <= 1
                && r.v9_anchor_gain >= .5 && r.v9_anchor_gain <= 2));
            const cached = await index.computeMemoGeometry(db, 'memo-D-full-benchmark', JSON.stringify(geometry));
            assert.equal(cached.computedCount, 0);
            assert.equal(cached.artifactSig, result.artifactSig);
            const entry = {
                neighbors, axes, result, status,
                globalMathHash: hash(JSON.stringify(mathCache)),
                localHash: hash(JSON.stringify(rows)),
                residual: stats(rows.map(r => r.raw_residual_ratio)),
                gain: stats(rows.map(r => r.v9_anchor_gain)),
                gainDeltaFirstCase: stats(gainDeltas),
                cacheHit: cached.phaseSummary,
                resourceMaxRssMiB: process.resourceUsage().maxRSS / 1024,
                rows
            };
            report.cases.push(entry);
            save();
            console.log(JSON.stringify({
                mode, neighbors, axes, elapsedMs: result.elapsedMs,
                phases: result.phaseSummary, globalMathHash: entry.globalMathHash,
                residualMean: entry.residual.mean, gainMean: entry.gain.mean
            }));
        }
        if (mode === 'D') {
            assert.equal(report.cases[2].localHash, report.cases[4].localHash);
            assert.equal(report.cases[2].globalMathHash, report.cases[4].globalMathHash);
        }
        report.success = true;
    } finally {
        reader?.close();
        runtime.shutdown();
        save();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });