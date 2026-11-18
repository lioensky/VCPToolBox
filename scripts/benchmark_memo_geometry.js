'use strict';

// Only disposable ags-benchmark-* databases; no source-copy writes or content output.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { VexusIndex, NativeKnowledgeRuntime } = require('../rust-vexus-lite');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const average = values => values.reduce((s, x) => s + x, 0) / Math.max(1, values.length);
const normalize = values => {
    const norm = Math.hypot(...values);
    return Float32Array.from(values, x => norm > 1e-12 ? x / norm : 0);
};

async function main() {
    const db = path.resolve(process.argv[2] || '');
    const reportPath = process.argv[3] && path.resolve(process.argv[3]);
    const round = process.argv[4] || 'round2';
    const selectedMix = Number(process.argv[5] || '0.8');
    assert(['round1', 'round2', 'stage3'].includes(round));
    assert(Number.isFinite(selectedMix) && selectedMix >= 0 && selectedMix <= 1);
    if (!process.argv[2] || !path.basename(db).startsWith('ags-benchmark-')) {
        throw new Error('Refusing non-benchmark database; filename must start with ags-benchmark-');
    }
    const config = require('../rag_params.json').KnowledgeBaseManager;
    let reader = new Database(db, { readonly: true, fileMustExist: true });
    const dimensions = reader.prepare(
        'SELECT DISTINCT length(vector)/4 dim FROM tags WHERE vector IS NOT NULL'
    ).all();
    assert.equal(dimensions.length, 1);
    const dim = dimensions[0].dim;
    const tagCount = reader.prepare('SELECT COUNT(*) n FROM tags').get().n;
    const fileCount = reader.prepare('SELECT COUNT(*) n FROM files').get().n;
    const relationCount = reader.prepare('SELECT COUNT(*) n FROM file_tags').get().n;
    // Fixed, evenly spaced Tag vectors are smoke probes, NOT labeled real queries.
    const queries = [];
    const rowAt = reader.prepare('SELECT vector FROM tags WHERE vector IS NOT NULL ORDER BY id LIMIT 1 OFFSET ?');
    for (let i = 0; i < Math.min(24, tagCount); i++) {
        const bytes = rowAt.get(Math.floor(i * tagCount / Math.min(24, tagCount))).vector;
        queries.push(normalize(Array.from({ length: dim }, (_, d) => bytes.readFloatLE(d * 4))));
    }
    let seed = 0x12345678;
    const random = Array.from({ length: dim }, () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0x100000000 - 0.5;
    });
    const outsideProbe = normalize(random);
    const backgroundQueries = [outsideProbe];
    for (let i = 1; i < 24; i++) {
        backgroundQueries.push(normalize(Array.from({ length: dim }, () => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return seed / 0x100000000 - 0.5;
        })));
    }
    reader.close();
    reader = null;
    const index = new VexusIndex(dim, tagCount + 16);
    const runtime = new NativeKnowledgeRuntime(index);
    const report = { round, dimension: dim, tagCount, fileCount, relationCount,
        build: 'release', queryProbeCount: queries.length, cases: [] };
    let peakRss = process.memoryUsage().rss;
    const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
    const started = performance.now();
    try {
        let begin = performance.now();
        report.store = runtime.openAndInitStore(db);
        report.openMs = performance.now() - begin;
        begin = performance.now();
        report.recoveredVectors = await index.recoverFromSqlite(db, 'tags');
        report.recoveryMs = performance.now() - begin;
        reader = new Database(db, { readonly: true, fileMustExist: true });
        const version = () => reader.prepare(
            "SELECT value FROM kbm_runtime_meta WHERE key='derived_geometry'"
        ).get().value;
        const cases = round === 'round1' ? [
            ['legacy-anchor-knee', { candidateMode: 'anchor', priorMode: 'residual', kneeDelta: 0.005 }],
            ['anchor-residual-32', { candidateMode: 'anchor', priorMode: 'residual', kneeDelta: 0 }],
            ['anchor-support-32', { candidateMode: 'anchor', priorMode: 'support', kneeDelta: 0 }],
            ['star-support-mix05', { candidateMode: 'star', priorMode: 'support', starMix: 0.5, kneeDelta: 0 }],
            ['star-support-mix08', { candidateMode: 'star', priorMode: 'support', starMix: 0.8, kneeDelta: 0 }],
            ['star-explained-mix05', { candidateMode: 'star', priorMode: 'explained', starMix: 0.5, kneeDelta: 0 }],
        ] : [
            ['selected-repeat1', { candidateMode: 'star', priorMode: 'support', starMix: selectedMix, kneeDelta: 0 }],
            ['selected-repeat2', { candidateMode: 'star', priorMode: 'support', starMix: selectedMix, kneeDelta: 0 }],
        ];
        if (round === 'stage3') cases.splice(1);
        for (const [name, override] of cases) {
            const geometryConfig = structuredClone(config.geometry);
            Object.assign(geometryConfig.global, override);
            const entry = { name, global: geometryConfig.global };
            report.cases.push(entry);
            entry.geometry = await index.computeMemoGeometry(db, 'ags-benchmark-model',
                JSON.stringify({ ...geometryConfig, forceRecompute: true }));
            const before = version();
            entry.cacheHit = await index.computeMemoGeometry(db, 'ags-benchmark-model', JSON.stringify(geometryConfig));
            assert.equal(version(), before);
            assert.equal(entry.cacheHit.skippedCount, tagCount);
            assert.equal(entry.cacheHit.artifactSig, entry.geometry.artifactSig);
            const cache = JSON.parse(reader.prepare("SELECT value FROM kv_store WHERE key='epa_basis_cache'").get().value);
            delete cache.timestamp;
            entry.geometryValueHash = digest(JSON.stringify(cache));
            entry.fullCoverage = cache.fullCoverage;
            entry.coverageAt = Object.fromEntries([8, 9, 16, 32].map(k => [k, cache.fullCoverage[k - 1] ?? null]));
            entry.statusCounts = reader.prepare(
                `SELECT status,COUNT(*) count FROM (
                    SELECT status FROM tag_intrinsic_residuals
                    UNION ALL SELECT status FROM tag_intrinsic_residual_status
                ) GROUP BY status`
            ).all();
            assert.equal(entry.statusCounts.reduce((s, r) => s + r.count, 0), tagCount);
            assert.equal(reader.prepare("SELECT COUNT(*) n FROM tag_intrinsic_residual_status WHERE status='computed'").get().n, 0);
            const localHash = crypto.createHash('sha256');
            for (const row of reader.prepare(
                'SELECT tag_id,raw_residual_ratio,v9_anchor_gain,neighbor_count FROM tag_intrinsic_residuals ORDER BY tag_id'
            ).iterate()) localHash.update(JSON.stringify(row));
            entry.localValueHash = localHash.digest('hex');
            const bases = cache.basis.map(v => {
                const bytes = Buffer.from(v, 'base64');
                return Array.from({ length: dim }, (_, i) => bytes.readFloatLE(i * 4));
            });
            let error = 0;
            for (let i = 0; i < bases.length; i++) for (let j = 0; j <= i; j++) {
                const dot = bases[i].reduce((s, x, d) => s + x * bases[j][d], 0);
                error = Math.max(error, Math.abs(dot - Number(i === j)));
            }
            entry.maxOrthogonalityError = error;
            assert(error < 1e-6);
            assert(cache.fullCoverage.every((c, i, all) => c >= 0 && c <= 1 && (!i || c >= all[i - 1])));
            entry.artifact = await index.rebuildMemoArtifact(db,
                JSON.stringify({ modelSig: 'ags-benchmark-model', effectiveConfig: config }));
            const analyze = async (query, id, epaGateMode = 'absolute') => {
                const pipeline = await index.runMemoPipeline(db, entry.artifact.artifactSig,
                    JSON.stringify({ queryId: id, config: { maxLevels: 1, epaGateMode } }), query, new Float32Array());
                const { epa, effectiveTagBoost } = JSON.parse(pipeline.metadataJson);
                assert.equal(epa.cacheAvailable, true);
                assert(epa.logicDepth <= epa.inDomainGate + 1e-9);
                return { outOfDomain: epa.outOfDomain, entropy: epa.entropy,
                    logicDepth: epa.logicDepth, semanticExplainedRatio: epa.semanticExplainedRatio,
                    inDomainGate: epa.inDomainGate, baselineCoverage: epa.baselineCoverage,
                    backgroundRatio: epa.backgroundRatio, effectiveTagBoost };
            };
            entry.queryProbes = [];
            for (let i = 0; i < queries.length; i++) entry.queryProbes.push(await analyze(queries[i], `probe-${i}`));
            entry.queryMean = Object.fromEntries(Object.keys(entry.queryProbes[0]).map(
                key => [key, average(entry.queryProbes.map(v => v[key]))]));
            entry.randomProbe = await analyze(outsideProbe, 'random-probe');
            if (round === 'stage3') {
                entry.calibration = {};
                const summarize = probes => {
                    const stats = {};
                    for (const key of Object.keys(probes[0])) {
                        const values = probes.map(p => p[key]).sort((a,b) => a-b);
                        stats[key] = { min: values[0], mean: average(values),
                            median: values[Math.floor(values.length / 2)], max: values.at(-1) };
                    }
                    stats.floorFraction = probes.filter(p => p.effectiveTagBoost <= 0.18 + 1e-9).length / probes.length;
                    stats.logicBelowPointOne = probes.filter(p => p.logicDepth < 0.1).length / probes.length;
                    return stats;
                };
                for (const mode of ['absolute', 'relativeLinear', 'relativeSqrt', 'backgroundRelative']) {
                    const inside = [], outside = [];
                    for (let i=0;i<queries.length;i++) inside.push(await analyze(queries[i], `inside-${i}`, mode));
                    for (let i=0;i<backgroundQueries.length;i++) outside.push(await analyze(backgroundQueries[i], `outside-${i}`, mode));
                    entry.calibration[mode] = { inside: summarize(inside), outside: summarize(outside), insideProbes: inside, outsideProbes: outside };
                    console.log(`gate=${mode}: insideDepth=${average(inside.map(p=>p.logicDepth)).toFixed(4)} outsideMax=${Math.max(...outside.map(p=>p.logicDepth)).toFixed(4)} floor=${entry.calibration[mode].inside.floorFraction}`);
                }
                const hot = await analyze(queries[0], 'cold-check');
                index.clearMemoRuntime();
                const coldStarted=performance.now();
                const cold = await analyze(queries[0], 'cold-check');
                entry.coldPipelineMs=performance.now()-coldStarted;
                assert.deepEqual(cold,hot);
                entry.coldReloadIdentical=true;
                assert.equal(reader.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='idx_intrinsic_residual_artifact'").get().n,0);
            }
            if (round === 'round2' || round === 'stage3') {
                const second = await index.rebuildMemoArtifact(db,
                    JSON.stringify({ modelSig: 'ags-benchmark-model', effectiveConfig: config }));
                assert.equal(second.graphGeneration, entry.artifact.graphGeneration);
                assert.equal(second.provenanceGeneration, entry.artifact.provenanceGeneration);
                entry.artifactRepeat = second;
            }
            console.log(`${name}: geometry=${entry.geometry.elapsedMs.toFixed(1)}ms publish=${entry.geometry.phaseSummary} coverage32=${entry.coverageAt[32]} artifact=${entry.artifact.elapsedMs.toFixed(1)}ms`);
            if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
        }
        const localHashes = new Set(report.cases.map(c => c.localValueHash));
        assert.equal(localHashes.size, 1, 'Global strategy must not change local residual values');
        if (round === 'round2') {
            assert.equal(report.cases[0].geometryValueHash, report.cases[1].geometryValueHash);
            assert.equal(report.cases[0].geometry.artifactSig, report.cases[1].geometry.artifactSig);
            assert.equal(report.cases[0].artifact.graphGeneration, report.cases[1].artifact.graphGeneration);
            assert.deepEqual(report.cases[0].queryProbes, report.cases[1].queryProbes);
        }
        assert.equal(reader.prepare(
            "SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('tag_pair_similarity','tag_pair_similarity_status')"
        ).get().n, 0);
        report.success = true;
    } finally {
        reader?.close();
        runtime.shutdown();
        clearInterval(sampler);
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        report.totalMs = performance.now() - started;
        report.peakRssMiB = peakRss / 1048576;
        report.resourceMaxRssMiB = process.resourceUsage().maxRSS / 1024;
        if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    }
    console.log(`Completed ${round}: ${report.totalMs.toFixed(1)}ms, peak RSS ${report.peakRssMiB.toFixed(1)}MiB`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });