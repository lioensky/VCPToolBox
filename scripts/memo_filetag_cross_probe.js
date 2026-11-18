'use strict';

// Read-only two-file hypergraph witnesses, not candidate-result validation.
// node scripts/memo_filetag_cross_probe.js > local-report.json
const path = require('node:path');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '../VectorStore/knowledge_base.sqlite'),
    { readonly: true, fileMustExist: true });
const cases = [
    { name: 'huawei', source: 40770, target: 39492, anchors: [40783, 36808, 2985] },
    { name: 'lunarium', source: 40081, target: 40082, anchors: [41604, 40117, 40089] },
    { name: 'iran-cloud', source: 11796, target: 11797, anchors: [29251, 23943, 14578, 14163] },
    { name: 'iran-talks', source: 23889, target: 23890, anchors: [29251, 23943, 14578, 14163] },
    { name: 'iran-operation', source: 29682, target: 29683, anchors: [29251, 23943, 14578, 14163] }
];
try {
    db.pragma('query_only=ON');
    const report = db.transaction(() => {
        // Preserve whole file-tag strings and positions. No semantic matching.
        const rows = db.prepare(`SELECT ft.file_id,ft.tag_id,ft.position,t.name
            FROM file_tags ft JOIN tags t ON t.id=ft.tag_id
            ORDER BY ft.file_id,ft.position,ft.tag_id`).all();
        const files = new Map(), tagFiles = new Map(), names = new Map();
        for (const r of rows) {
            if (!files.has(r.file_id)) files.set(r.file_id, []);
            files.get(r.file_id).push({ id: r.tag_id, position: r.position, name: r.name });
            if (!tagFiles.has(r.tag_id)) tagFiles.set(r.tag_id, new Set());
            tagFiles.get(r.tag_id).add(r.file_id);
            names.set(r.tag_id, r.name);
        }
        const metadata = new Map(db.prepare('SELECT id,path,diary_name FROM files').all()
            .map(f => [f.id, f]));
        const containing = id => [...(tagFiles.get(id) || [])];
        const describe = id => ({ ...metadata.get(id), tags: files.get(id) || [] });
        function measure(leftIds, anchor, source, target) {
            const rightIds = containing(anchor);
            let filePairs = 0, directTripleFiles = 0;
            const bridges = new Map();
            const examples = [];
            for (const left of leftIds) {
                const leftTags = files.get(left);
                if (leftTags.some(t => t.id === anchor)) directTripleFiles++;
                for (const right of rightIds) {
                    if (left === right) continue; // Two different diaries, not one fact counted twice.
                    const rightSet = new Set(files.get(right).map(t => t.id));
                    const shared = leftTags.filter(t => rightSet.has(t.id));
                    // The other focus itself in the first file is already direct support.
                    // Keep endpoint overlaps visible, but distinguish third-tag witnesses.
                    const thirdTags = shared.filter(t =>
                        ![source, target, anchor].includes(t.id));
                    if (!shared.length) continue;
                    filePairs++;
                    for (const t of shared) {
                        if (!bridges.has(t.id)) bridges.set(t.id, {
                            id: t.id, name: t.name, globalFileFrequency: containing(t.id).length,
                            endpointOrAnchor: [source, target, anchor].includes(t.id),
                            filePairCount: 0, examplePairs: []
                        });
                        const b = bridges.get(t.id);
                        b.filePairCount++;
                        if (b.examplePairs.length < 3) b.examplePairs.push([left, right]);
                    }
                    if (examples.length < 8 && thirdTags.length) examples.push({
                        leftFile: left, rightFile: right,
                        sharedTags: shared.map(t => ({ id: t.id, name: t.name })),
                        thirdTagCount: thirdTags.length
                    });
                }
            }
            return {
                leftFileCount: leftIds.length, anchorFileCount: rightIds.length,
                directAnchorInLeftFiles: directTripleFiles, intersectingDistinctFilePairs: filePairs,
                bridges: [...bridges.values()].sort((a, b) =>
                    a.globalFileFrequency - b.globalFileFrequency || a.id - b.id),
                examples
            };
        }
        const results = cases.map(c => {
            for (const id of [c.source, c.target, ...c.anchors]) assert(names.has(id), `missing tag ${id}`);
            const targetFiles = containing(c.target);
            const sourceFiles = new Set(containing(c.source));
            const routeFiles = targetFiles.filter(id => sourceFiles.has(id));
            return {
                case: c.name, source: { id: c.source, name: names.get(c.source) },
                target: { id: c.target, name: names.get(c.target) },
                routeFiles: routeFiles.map(describe),
                targetFiles: targetFiles.map(describe),
                anchors: c.anchors.map(id => ({
                    id, name: names.get(id),
                    routeFileCross: measure(routeFiles, id, c.source, c.target),
                    targetFileCross: measure(targetFiles, id, c.source, c.target)
                }))
            };
        });
        // Include full strings of witness files so every claimed crossing is auditable.
        const witnessIds = new Set();
        for (const c of results) for (const a of c.anchors)
            for (const m of [a.routeFileCross, a.targetFileCross])
                for (const b of m.bridges) for (const pair of b.examplePairs)
                    pair.forEach(id => witnessIds.add(id));
        return {
            schema: 'memo-filetag-cross-probe-v1',
            meta: db.prepare(`SELECT key,value FROM kbm_runtime_meta WHERE key IN
                ('database_generation','memo_tag_facts') ORDER BY key`).all(),
            definition: 'Two distinct file-tag strings intersect by exact Tag ID; no cosine or result scores.',
            limitations: [
                'Current SQLite file_tags, not replay of the published historical graph.',
                'Cooccurrence establishes association, not causal correctness or query relevance.',
                'Repeated/copied diaries are not guaranteed independent evidence.',
                'Examples per bridge are capped at three; counts are not capped.',
                'No gate fitted; no production changes; no query embedding.'
            ],
            results, witnessFiles: [...witnessIds].sort((a, b) => a - b).map(describe)
        };
    })();
    console.log(JSON.stringify(report, null, 2));
} finally {
    db.close();
}