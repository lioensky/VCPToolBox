'use strict';

// Read-only real chunk / historical-link probe. Exact-search pyramid proxy, not native ANN.
// node scripts/memo_cached_links_probe.js [--samples 12] [--json]
// Text report: scripts/reports/memo_cached_links_report.md
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { gunzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const Database = require('better-sqlite3');
const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
    const i = args.indexOf(name);
    return i < 0 ? fallback : Number(args[i + 1]);
};
const samples = option('--samples', 12);
assert(Number.isInteger(samples) && samples >= 2 && samples <= 100);
const spike = JSON.parse(fs.readFileSync(path.join(root, 'rag_params.json'), 'utf8'))
    .KnowledgeBaseManager.spikeRouting;
const settings = {
    samples, levels: 3, pyramidK: 10, sourceK: option('--source-k', 3), outputK: 20,
    threshold: option('--threshold', 0.2), energy: 1,
    minimumCurrent: spike.minimumInjectedCurrent ?? 0.01,
    wormholeDecay: spike.wormholeDecay ?? 0.7
};
assert(Number.isInteger(settings.sourceK) && settings.sourceK >= 1 && settings.sourceK <= 10);
assert(Number.isFinite(settings.threshold) && settings.threshold >= 0 && settings.threshold <= 1);
function dot(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
    return sum;
}
function decode(bytes) {
    if (!bytes || bytes.length % 4) return null;
    const vector = new Float32Array(bytes.length / 4);
    for (let i = 0; i < vector.length; i++) vector[i] = bytes.readFloatLE(i * 4);
    const norm = Math.sqrt(dot(vector, vector));
    return norm > 1e-12 && Number.isFinite(norm) ? { vector, norm } : null;
}
const brief = (text, n = 220) => String(text ?? '').replace(/\s+/g, ' ').slice(0, n);
const started = performance.now();
const db = new Database(path.join(root, 'VectorStore', 'knowledge_base.sqlite'),
    { readonly: true, fileMustExist: true });
db.pragma('query_only=ON');
try {
    const input = db.transaction(() => {
        const asset = db.prepare(`SELECT artifact_sig,payload,payload_checksum,payload_codec
            FROM rivermemo_artifacts WHERE status='ready' AND payload IS NOT NULL
            ORDER BY updated_at DESC,artifact_sig LIMIT 1`).get();
        assert(asset);
        const tags = [];
        for (const row of db.prepare('SELECT id,name,vector FROM tags ORDER BY id').iterate()) {
            const v = decode(row.vector);
            if (v) tags.push({ id: row.id, name: row.name, ...v });
        }
        const ids = db.prepare('SELECT id FROM chunks WHERE vector IS NOT NULL ORDER BY id').all();
        const get = db.prepare('SELECT id,file_id,content,vector FROM chunks WHERE id=?');
        const chunks = Array.from({ length: Math.min(samples, ids.length) }, (_, i) => {
            const row = get.get(ids[Math.floor(i * ids.length / Math.min(samples, ids.length))].id);
            const v = decode(row.vector);
            assert(v);
            return { id: row.id, fileId: row.file_id, text: brief(row.content, 320), ...v };
        });
        const dependencies = db.prepare(`SELECT d.dependency_key,d.dependency_version,m.value AS current
            FROM kbm_artifact_dependencies d LEFT JOIN kbm_runtime_meta m ON m.key=d.dependency_key
            WHERE d.artifact_sig=?`).all(asset.artifact_sig);
        return { asset, tags, chunks, dependencies };
    })();
    const { tags, chunks, asset } = input;
    assert.equal(asset.payload_codec, 'gzip-json-v1');
    const raw = gunzipSync(asset.payload, { maxOutputLength: 536870912 });
    assert.equal(createHash('sha256').update(raw).digest('hex'), asset.payload_checksum);
    const graph = JSON.parse(raw).sharedTransport;
    const byId = new Map(tags.map(t => [t.id, t]));
    const index = new Map(graph.nodeIds.map((id, i) => [id, i]));
    const dim = tags[0].vector.length;
    assert(tags.every(t => t.vector.length === dim));
    assert(chunks.every(c => c.vector.length === dim));
    const loadMs = performance.now() - started;
    function pyramid(chunk) {
        let residual = chunk.vector.slice();
        const original = dot(residual, residual);
        const levels = [];
        for (let level = 0; level < settings.levels; level++) {
            const norm = Math.sqrt(dot(residual, residual));
            if (norm <= 1e-12) break;
            const candidates = tags.map(t => ({
                id: t.id, similarity: dot(residual, t.vector) / (norm * t.norm)
            })).sort((a, b) => b.similarity - a.similarity || a.id - b.id)
                .slice(0, settings.pyramidK);
            const basis = [];
            for (const t of candidates) {
                const axis = Float64Array.from(byId.get(t.id).vector);
                for (const b of basis) {
                    const p = dot(axis, b);
                    for (let d = 0; d < dim; d++) axis[d] -= p * b[d];
                }
                const n = Math.sqrt(dot(axis, axis));
                if (n > 1e-12) {
                    for (let d = 0; d < dim; d++) axis[d] /= n;
                    basis.push(axis);
                }
            }
            levels.push({ residual, norm, candidates });
            const projection = new Float32Array(dim);
            for (const axis of basis) {
                const p = dot(residual, axis);
                for (let d = 0; d < dim; d++) {
                    projection[d] = Math.fround(projection[d] + Math.fround(p * axis[d]));
                }
            }
            residual = Float32Array.from(residual, (v, d) => v - projection[d]);
            if (dot(residual, residual) / original < 0.1) break;
        }
        return levels;
    }
    const pyramidStarted = performance.now();
    const queries = chunks.map(chunk => ({ chunk, levels: pyramid(chunk) }));
    const pyramidProxyMs = performance.now() - pyramidStarted;
    const preparationStarted = performance.now();
    for (const q of queries) {
        q.seedIds = new Set(q.levels.flatMap(l => l.candidates.map(t => t.id)));
        q.jobs = [];
        for (let level = 0; level + 1 < q.levels.length; level++) {
            const deeper = q.levels.slice(level + 1);
            for (const seed of q.levels[level].candidates.slice(0, settings.sourceK)) {
                const source = index.get(seed.id);
                if (source === undefined) continue;
                const row = [];
                for (let c = graph.rowOffsets[source]; c < graph.rowOffsets[source + 1]; c++) {
                    const id = graph.nodeIds[graph.targetIndices[c]];
                    if (graph.weights[c] > 0 && byId.has(id)) row.push({ id, weight: graph.weights[c] });
                }
                row.sort((a, b) => b.weight - a.weight || a.id - b.id);
                q.jobs.push({ source: seed.id, level, deeper,
                    row: row.map((e, i) => ({ ...e, rawRank: i + 1 })) });
            }
        }
    }
    const rowPreparationMs = performance.now() - preparationStarted;
    function run(q, mode) {
        // Request-local raw-vector pool: starts with vectors already used by pyramid.
        const pool = new Map([...q.seedIds].map(id => [id, byId.get(id)]));
        const scores = q.levels.map(l => new Map(l.candidates.map(t => [t.id, t.similarity])));
        let fetchMs = 0, fetched = 0, sqlBatches = 0, dots = 0, cacheHits = 0;
        const start = performance.now();
        if (mode !== 'sparse') {
            const missing = [...new Set(q.jobs.flatMap(j => j.row.map(e => e.id)))]
                .filter(id => !pool.has(id)).sort((a, b) => a - b);
            const begin = performance.now();
            for (let i = 0; i < missing.length; i += 128) {
                const batch = missing.slice(i, i + 128);
                const rows = db.prepare(`SELECT id,vector FROM tags WHERE id IN (${batch.map(() => '?').join(',')})`)
                    .all(...batch);
                sqlBatches++;
                for (const r of rows) {
                    const decoded = decode(r.vector);
                    if (decoded && decoded.vector.length === dim) {
                        pool.set(r.id, decoded);
                        fetched++;
                    }
                }
            }
            fetchMs = performance.now() - begin;
        }
        const links = [];
        for (const job of q.jobs) {
            const accepted = [];
            for (const edge of job.row) {
                if (edge.id === job.source) continue;
                const target = pool.get(edge.id);
                let resonance = 0;
                for (let level = job.level + 1; level < q.levels.length; level++) {
                    let score;
                    if (mode !== 'full' && scores[level].has(edge.id)) {
                        score = scores[level].get(edge.id);
                        cacheHits++;
                    } else if (mode !== 'sparse' && target) {
                        const l = q.levels[level];
                        score = dot(l.residual, target.vector) / (l.norm * target.norm);
                        dots++;
                        if (mode === 'cached') scores[level].set(edge.id, score);
                    } else continue;
                    resonance = Math.max(resonance, score);
                }
                if (resonance < settings.threshold) continue;
                accepted.push({
                    source: job.source, target: edge.id, level: job.level,
                    rawRank: edge.rawRank, resonance, weight: edge.weight,
                    score: edge.weight * resonance ** 4,
                    current: settings.energy * edge.weight * settings.wormholeDecay,
                    newNode: !q.seedIds.has(edge.id)
                });
            }
            accepted.sort((a, b) => b.score - a.score || a.target - b.target);
            links.push(...accepted.slice(0, settings.outputK));
        }
        return { links, elapsedMs: performance.now() - start, fetchMs, fetched, sqlBatches, dots, cacheHits };
    }
    const evidenceStmt = db.prepare(`SELECT f.id,f.path,
        (SELECT c.content FROM chunks c WHERE c.file_id=f.id ORDER BY c.chunk_index LIMIT 1) AS content,
        (SELECT COUNT(*) FROM file_tags a JOIN file_tags b ON a.file_id=b.file_id
            WHERE a.tag_id=? AND b.tag_id=?) AS sharedFiles
        FROM files f JOIN file_tags a ON a.file_id=f.id JOIN file_tags b ON b.file_id=f.id
        WHERE a.tag_id=? AND b.tag_id=? ORDER BY f.id LIMIT 1`);
    const totals = Object.fromEntries(['sparse', 'full', 'cached'].map(mode => [mode, {
        elapsedMs: 0, fetchMs: 0, fetched: 0, sqlBatches: 0, dots: 0, cacheHits: 0,
        selected: 0, tail: 0, tailInjected: 0, newNodes: 0
    }]));
    const textCases = [];
    const timingQueries = [];
    db.transaction(() => {
        for (const q of queries) {
            const results = {};
            // Rotate order to reduce systematic warm-page/JIT advantage.
            const modes = textCases.length % 2 ? ['cached', 'full', 'sparse'] : ['full', 'sparse', 'cached'];
            for (const mode of modes) {
                const result = run(q, mode);
                results[mode] = result;
                const t = totals[mode];
                for (const key of ['elapsedMs', 'fetchMs', 'fetched', 'sqlBatches', 'dots', 'cacheHits']) {
                    t[key] += result[key];
                }
                t.selected += result.links.length;
                t.tail += result.links.filter(l => l.rawRank > settings.outputK).length;
                t.tailInjected += result.links.filter(l => l.rawRank > settings.outputK
                    && l.current >= settings.minimumCurrent).length;
                t.newNodes += result.links.filter(l => l.newNode).length;
            }
            const canonical = r => [...r.links].sort((a, b) =>
                a.level - b.level || a.source - b.source || a.target - b.target);
            const full = canonical(results.full), cached = canonical(results.cached);
            assert.equal(full.length, cached.length);
            for (let i = 0; i < full.length; i++) {
                assert.equal(full[i].source, cached[i].source);
                assert.equal(full[i].target, cached[i].target);
                assert(Math.abs(full[i].resonance - cached[i].resonance) < 1e-10);
            }
            const best = [...results.cached.links].sort((a, b) =>
                Number(b.rawRank > settings.outputK) - Number(a.rawRank > settings.outputK)
                || b.score - a.score);
            const seen = new Set();
            const links = best.filter(l => {
                const key = `${l.source}:${l.target}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            }).slice(0, 6).map(l => {
                const proof = evidenceStmt.get(l.source, l.target, l.source, l.target);
                return { ...l, sourceName: byId.get(l.source)?.name, targetName: byId.get(l.target)?.name,
                    injected: l.current >= settings.minimumCurrent,
                    evidence: proof ? { fileId: proof.id, path: proof.path,
                        sharedFiles: proof.sharedFiles, text: brief(proof.content) } : null };
            });
            timingQueries.push(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.elapsedMs])));
            textCases.push({ chunkId: q.chunk.id, input: q.chunk.text, links });
        }
    })();
    for (const mode of Object.keys(totals)) {
        totals[mode].meanPerChunkMs = totals[mode].elapsedMs / queries.length;
        const times = timingQueries.map(t => t[mode]).sort((a, b) => a - b);
        totals[mode].medianPerChunkMs = times[Math.floor(times.length / 2)];
    }
    const report = {
        scope: 'Read-only one-hop proxy; full and cached selections asserted equivalent.',
        settings, artifact: asset.artifact_sig, dependencies: input.dependencies,
        timing: { loadMs, pyramidProxyMs, rowPreparationMs, modes: totals },
        caveats: [
            'Pyramid uses offline exact cosine, not native analyze_pyramid or ANN.',
            'Scoring is conductance * resonance^4; shortlisted qualified edges cost zero momentum.',
            'Each source uses energy=1; this is not production gated seed energy.',
            'SQL fetch/decode and scoring/selection included per mode; row preparation reported separately.',
            'Pyramid proxy loads all vectors for candidate generation, so OS/SQLite pages may already be warm.',
            'Single pass with rotated mode order, not a statistically controlled native benchmark.',
            'Evidence is current file-level cooccurrence; first chunk excerpt may not contain both tag names.',
            'Graph and current facts can differ; missing evidence is displayed, never fabricated.',
            'Counts are edge events, not unique nodes. No held-out retrieval quality claim.'
        ],
        cases: textCases
    };
    const lines = [
        '# 残差 × 历史连接：完整精算与请求级缓存对照',
        '',
        `图资产：${asset.artifact_sig}`,
        '',
        '只读真实库；输入为真实 chunk 向量。不是生产多跳检索结果。',
        '',
        '## 分阶段耗时',
        '',
        `加载 ${loadMs.toFixed(2)} ms；离线金字塔代理 ${pyramidProxyMs.toFixed(2)} ms；CSR 行准备 ${rowPreparationMs.toFixed(2)} ms。`,
        '',
        '| 模式 | 平均 ms/chunk | 中位 ms/chunk | SQL 读取 ms | 点积数 | 缓存命中 | 入选 | 尾部入选 | 尾部注入 | 非金字塔目标边次 |',
        '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
    ];
    for (const [mode, t] of Object.entries(totals)) lines.push(
        `| ${mode} | ${t.meanPerChunkMs.toFixed(4)} | ${t.medianPerChunkMs.toFixed(4)} | ${t.fetchMs.toFixed(3)} | ${t.dots} | ${t.cacheHits} | ${t.selected} | ${t.tail} | ${t.tailInjected} | ${t.newNodes} |`);
    lines.push('', '## 实际连接文本', '');
    for (const c of textCases) {
        lines.push(`### 输入 chunk ${c.chunkId}`, '', `> ${c.input}`, '');
        if (!c.links.length) lines.push('此输入没有满足阈值的历史连接。', '');
        for (const l of c.links) {
            lines.push(
                `- **${l.sourceName} → ${l.targetName}**：静态第 ${l.rawRank} 名；残差共鸣 ${l.resonance.toFixed(4)}；电流 ${l.current.toFixed(6)}；${l.injected ? '达到注入阈值' : '未达注入阈值'}；${l.newNode ? '金字塔名单外目标' : '金字塔已召回目标'}。`,
                l.evidence
                    ? `  - 历史事实：共同出现于 ${l.evidence.sharedFiles} 个文件；示例 ${l.evidence.path}（file ${l.evidence.fileId}）。`
                    : '  - 当前事实表未找到共同文件：需检查资产与事实版本差异。',
                l.evidence ? `  - 历史摘录：${l.evidence.text}` : '',
                '');
        }
    }
    lines.push('## 限制', '', ...report.caveats.map(n => `- ${n}`));
    const reportDir = path.join(__dirname, 'reports');
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, 'memo_cached_links_report.md'), lines.join('\n') + '\n');
    if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else {
        console.log(lines.join('\n'));
        console.log('\nReport: scripts/reports/memo_cached_links_report.md; equivalence assertions passed.');
    }
} finally {
    db.close();
}