'use strict';

// Offline, read-only measurements. No production scoring, embedding calls or DB writes.
// node scripts/memo_wormhole_gate_probe.js [--db path] [--artifact signature]
// Optional --queries path: JSON object { huawei: [actual query vector], ... }.
// JSON goes to stdout. Redirect it to a local report if desired.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const CASES = [
    {
        key: 'huawei', query: '华为汽车幽默操作',
        anchors: [40770, 40783, 2985, 36808],
        lexical: [40770, 40783, 2985],
        routes: [[40770, 39492], [40770, 40774], [2985, 5504], [2985, 30149]],
        chunks: [10640, 10460, 11124, 11129, 4620, 11220]
    },
    {
        key: 'lunarium', query: 'Lunarium 星之旅游戏有大问题',
        anchors: [41604, 40117, 40089, 40081, 12563, 20632],
        lexical: [41604, 40117, 40089],
        routes: [[40081, 40082], [41604, 41611], [41604, 41606], [40117, 40118]],
        chunks: [11385, 11384, 10764, 8882, 5104, 4857]
    },
    {
        key: 'iran', query: '伊朗重创美军',
        anchors: [29251, 23943, 11735, 14578, 11796, 14163, 23889, 29682, 14544],
        lexical: [],
        routes: [[11796, 11797], [23889, 23890], [14163, 25340],
            [29682, 29683], [14163, 14453], [14163, 14454], [29251, 29252]],
        chunks: [9889, 8094, 7121, 8999, 9002, 8897, 5310, 7124]
    }
];
function option(name, fallback) {
    const i = process.argv.indexOf(name);
    if (i < 0) return fallback;
    assert(process.argv[i + 1] && !process.argv[i + 1].startsWith('--'), `${name} requires a value`);
    return process.argv[i + 1];
}
function dot(a, b) {
    assert.equal(a.length, b.length, 'vector dimension mismatch');
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
    return sum;
}
function unit(v) {
    assert(v.length && v.every(Number.isFinite), 'invalid vector');
    const n = Math.sqrt(dot(v, v));
    assert(n > 1e-10, 'zero vector');
    return v.map(x => x / n);
}
function decode(bytes) {
    assert(Buffer.isBuffer(bytes) && bytes.length % 4 === 0, 'missing or malformed vector');
    return unit(Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readFloatLE(i * 4)));
}
function reject(v, source) {
    const p = dot(v, source);
    return v.map((x, i) => x - p * source[i]);
}
function conditional(anchor, source, target) {
    const a = reject(anchor, source), t = reject(target, source);
    const ae = dot(a, a), te = dot(t, t);
    // Do not normalize a nearly annihilated vector into spurious evidence.
    const valid = ae > 1e-10 && te > 1e-10;
    const projection = valid ? dot(a, t) / Math.sqrt(te) : 0;
    return {
        anchorResidualEnergy: ae, targetResidualEnergy: te,
        conditionalCosine: valid ? projection / Math.sqrt(ae) : null,
        positiveAddedExplainedEnergy: valid ? Math.max(0, projection) ** 2 : 0
    };
}
const dbPath = path.resolve(option('--db', path.join(__dirname, '../VectorStore/knowledge_base.sqlite')));
const signature = option('--artifact', '9bdf6e9a1f5644c345cec7e8f93c8bfcbf77b739241fcbbb');
const queriesPath = option('--queries', null);
const queries = queriesPath ? JSON.parse(fs.readFileSync(queriesPath, 'utf8')) : {};
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
try {
    db.pragma('query_only=ON');
    const report = db.transaction(() => {
        const row = db.prepare(`SELECT artifact_sig,payload_codec,payload_checksum,payload,
            model_sig,database_generation FROM rivermemo_artifacts
            WHERE artifact_sig=? AND status='ready'`).get(signature);
        assert(row, 'requested ready artifact missing; refusing a different snapshot');
        assert.equal(row.payload_codec, 'gzip-json-v1');
        const raw = zlib.gunzipSync(row.payload, { maxOutputLength: 512 * 1024 * 1024 });
        assert.equal(crypto.createHash('sha256').update(raw).digest('hex'), row.payload_checksum);
        const artifact = JSON.parse(raw);
        const csr = artifact.sharedTransport;
        assert.equal(csr.rowOffsets.length, csr.nodeIds.length + 1);
        const index = new Map(csr.nodeIds.map((id, i) => [id, i]));
        const wormholes = new Set(artifact.wormholeView);
        const provenance = new Map(artifact.provenanceView.edges);
        const vectors = new Map(), fileSets = new Map(), neighbors = new Map();
        const tagStatement = db.prepare('SELECT id,name,vector FROM tags WHERE id=?');
        const filesStatement = db.prepare('SELECT file_id FROM file_tags WHERE tag_id=? ORDER BY file_id');
        function tag(id) {
            if (!vectors.has(id)) {
                const t = tagStatement.get(id);
                assert(t, `missing tag ${id}`);
                vectors.set(id, { id, name: t.name, vector: decode(t.vector) });
            }
            return vectors.get(id);
        }
        function files(id) {
            if (!fileSets.has(id)) fileSets.set(id, new Set(filesStatement.all(id).map(x => x.file_id)));
            return fileSets.get(id);
        }
        function outgoing(id) {
            if (!neighbors.has(id)) {
                const i = index.get(id), edges = new Map();
                if (i !== undefined) for (let k = csr.rowOffsets[i]; k < csr.rowOffsets[i + 1]; k++) {
                    assert(Number.isFinite(csr.weights[k]) && csr.weights[k] >= 0);
                    edges.set(csr.nodeIds[csr.targetIndices[k]], csr.weights[k]);
                }
                neighbors.set(id, edges);
            }
            return neighbors.get(id);
        }
        function graphPair(a, b, excludedFiles = new Set()) {
            let twoHopMass = 0, twoHopPaths = 0;
            for (const [mid, first] of outgoing(a)) {
                if (mid === a || mid === b) continue;
                const second = outgoing(mid).get(b) || 0;
                if (first > 0 && second > 0) { twoHopMass += first * second; twoHopPaths++; }
            }
            const fa = files(a), fb = files(b);
            const common = [...fa].filter(id => fb.has(id));
            return {
                forward: outgoing(a).get(b) || 0, reverse: outgoing(b).get(a) || 0,
                twoHopMass, twoHopPaths,
                filesA: fa.size, filesB: fb.size, commonFiles: common.length,
                commonFilesOutsideRouteProvenance: common.filter(id => !excludedFiles.has(id)).length,
                fileJaccard: common.length / Math.max(1, fa.size + fb.size - common.length)
            };
        }
        const cases = CASES.map(c => {
            const q = queries[c.key] ? unit(queries[c.key]) : null;
            const routes = c.routes.map(([sourceId, targetId]) => {
                const source = tag(sourceId), target = tag(targetId);
                const origin = provenance.get(`${sourceId}:${targetId}`) || [];
                const originFiles = new Set(origin.map(x => x[0]));
                return {
                    sourceId, source: source.name, targetId, target: target.name,
                    persistedWormhole: wormholes.has(`${sourceId}:${targetId}`),
                    sourceLexicalInProvidedReport: c.lexical.includes(sourceId),
                    sourceTargetCosine: dot(source.vector, target.vector),
                    routeGraph: graphPair(sourceId, targetId),
                    provenanceFileIds: [...originFiles],
                    actualQuery: q ? {
                        sourceCosine: dot(q, source.vector), targetCosine: dot(q, target.vector),
                        ...conditional(q, source.vector, target.vector)
                    } : null,
                    anchors: c.anchors.map(id => {
                        const a = tag(id);
                        return {
                            id, name: a.name, lexicalInProvidedReport: c.lexical.includes(id),
                            isRouteSource: id === sourceId,
                            sourceCosine: dot(a.vector, source.vector),
                            targetCosine: dot(a.vector, target.vector),
                            ...conditional(a.vector, source.vector, target.vector),
                            graph: graphPair(id, targetId, originFiles)
                        };
                    }),
                    candidates: c.chunks.map(id => {
                        const chunk = db.prepare('SELECT file_id,vector FROM chunks WHERE id=?').get(id);
                        assert(chunk, `missing chunk ${id}`);
                        const body = decode(chunk.vector);
                        const tags = db.prepare(`SELECT t.id,t.name,t.vector FROM file_tags ft
                            JOIN tags t ON t.id=ft.tag_id WHERE ft.file_id=? ORDER BY ft.position,t.id`)
                            .all(chunk.file_id);
                        return {
                            id, fileId: chunk.file_id,
                            endpointBodyCosine: dot(target.vector, body),
                            exactTargetTag: tags.some(t => t.id === targetId),
                            edgeSourceFile: originFiles.has(chunk.file_id),
                            nearestTags: tags.filter(t => t.vector).map(t => ({
                                id: t.id, name: t.name, cosine: dot(target.vector, decode(t.vector))
                            })).sort((a, b) => b.cosine - a.cosine || a.id - b.id).slice(0, 3)
                        };
                    })
                };
            });
            return { key: c.key, queryLabel: c.query, actualQueryVectorProvided: !!q, routes };
        });
        return {
            schema: 'memo-wormhole-gate-probe-v1',
            artifact: { signature, model: row.model_sig, builtDatabaseGeneration: row.database_generation },
            currentMeta: db.prepare(`SELECT key,value FROM kbm_runtime_meta WHERE key IN
                ('database_generation','memo_tag_facts','derived_geometry') ORDER BY key`).all(),
            limitations: [
                'Diagnostic case IDs selected from user reports, not production rules or relevance labels.',
                'No original query residual unless --queries supplies that case vector.',
                'Persisted graph and current vector/file facts can differ in age; identities reported, no rebuild.',
                'Cooccurrence and two-hop weights are association, not entailment or independent relevance.',
                'Two-hop mass is unfiltered CSR transport, not replayed observed flow.',
                'Outside-route provenance count excludes files only; shared graph evidence can still leak.',
                'Ordinary routes are controls. No gate fitted, no ANN replay, no database writes.'
            ],
            cases
        };
    })();
    console.log(JSON.stringify(report, null, 2));
} finally {
    db.close();
}