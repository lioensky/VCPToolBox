'use strict';

// Read-only mechanism probe, NOT an end-to-end query replay or relevance evaluation.
// Optional --query-vector path supplies a JSON array from the actual query.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const unit = v => {
    const n = Math.sqrt(dot(v, v));
    assert(n > 1e-10 && Number.isFinite(n));
    return v.map(x => x / n);
};
const decode = b => unit(Array.from({ length: b.length / 4 }, (_, i) => b.readFloatLE(i * 4)));
function residual(vectors, index) {
    const basis = [];
    const remove = v => {
        for (let pass = 0; pass < 2; pass++) for (const b of basis) {
            const p = dot(v, b);
            v = v.map((x, i) => x - p * b[i]);
        }
        return v;
    };
    vectors.forEach((v, i) => {
        if (i === index) return;
        const r = remove([...v]);
        if (dot(r, r) > 1e-12) basis.push(unit(r));
    });
    const r = remove([...vectors[index]]);
    const energy = dot(r, r);
    return { energy, direction: energy > 1e-12 ? unit(r) : null };
}
function withoutBackground(vector, background) {
    const projection = dot(vector, background);
    const raw = vector.map((x, i) => x - projection * background[i]);
    const energy = dot(raw, raw);
    return { energy, direction: energy > 1e-12 ? unit(raw) : null };
}
const db = new Database(path.join(__dirname, '../VectorStore/knowledge_base.sqlite'),
    { readonly: true, fileMustExist: true });
try {
    db.pragma('query_only=ON');
    const report = db.transaction(() => {
        const seeds = [2985, 40770, 40783].map(id => {
            const row = db.prepare('SELECT id,name,vector FROM tags WHERE id=?').get(id);
            assert(row, `missing seed ${id}`);
            return { id, name: row.name, vector: decode(row.vector) };
        });
        const target = db.prepare('SELECT id,name,vector FROM tags WHERE id=?').get(39492);
        assert(target);
        target.vector = decode(target.vector);
        const option = process.argv.indexOf('--query-vector');
        const q = option >= 0
            ? unit(JSON.parse(fs.readFileSync(process.argv[option + 1], 'utf8')))
            : unit(seeds[0].vector.map((_, i) => seeds[1].vector[i] + seeds[2].vector[i]));
        assert.equal(q.length, target.vector.length);
        const axes = seeds.map((s, i) => {
            const r = residual(seeds.map(s => s.vector), i);
            return { id: s.id, name: s.name, residualEnergy: r.energy,
                queryExplanation: r.direction ? Math.max(0, dot(q, r.direction)) ** 2 : 0,
                sourceTargetCosine: dot(s.vector, target.vector) };
        });
        const total = axes.reduce((s, a) => s + a.queryExplanation, 0);
        axes.forEach(a => { a.queryWeight = total > 1e-12 ? a.queryExplanation / total : 1 / axes.length; });
        const candidates = [10640, 11124, 4620, 11220].map(id => {
            const row = db.prepare('SELECT id,file_id,vector FROM chunks WHERE id=?').get(id);
            assert(row, `missing chunk ${id}`);
            const body = decode(row.vector);
            const tags = db.prepare(`SELECT t.id,t.name,t.vector FROM file_tags ft
                JOIN tags t ON t.id=ft.tag_id WHERE ft.file_id=? ORDER BY t.id`).all(row.file_id)
                .filter(t => t.vector).map(t => {
                    const vector = decode(t.vector);
                    return { id: t.id, name: t.name, targetCosine: dot(target.vector, vector),
                        closure: Math.max(0, dot(body, vector)) };
                }).sort((a, b) => b.targetCosine - a.targetCosine || a.id - b.id);
            const bodyCosine = dot(target.vector, body);
            const grounding = Math.max(0.7 * Math.max(0, (bodyCosine - 0.45) / 0.55),
                ...tags.map(t => (t.id === target.id ? 1
                    : Math.max(0, (t.targetCosine - 0.48) / 0.52)) * t.closure));
            return { id, queryCosine: dot(q, body), endpointBodyCosine: bodyCosine,
                endpointGrounding: grounding, nearestTags: tags.slice(0, 3) };
        });
        // Fixed diagnostic controls only; IDs are not production ranking rules.
        const background = seeds[0].vector;
        const controls = [2985, 40784, 39492, 40789].map(id => {
            const row = db.prepare('SELECT id,name,vector FROM tags WHERE id=?').get(id);
            assert(row, `missing control ${id}`);
            const vector = decode(row.vector);
            const stripped = withoutBackground(vector, background);
            const comparisons = [10640, 11124, 4620, 11220].map(chunkId => {
                const chunk = db.prepare('SELECT file_id,vector FROM chunks WHERE id=?').get(chunkId);
                const body = decode(chunk.vector);
                const strippedBody = withoutBackground(body, background);
                const tags = db.prepare(`SELECT t.id,t.name,t.vector FROM file_tags ft
                    JOIN tags t ON t.id=ft.tag_id WHERE ft.file_id=? ORDER BY t.id`)
                    .all(chunk.file_id).filter(t => t.vector).map(tag => {
                        const tv = decode(tag.vector);
                        const strippedTag = withoutBackground(tv, background);
                        const similarity = dot(vector, tv);
                        const closure = Math.max(0, dot(body, tv));
                        return { id: tag.id, name: tag.name, similarity, closure,
                            tagCredit: (tag.id === id ? 1
                                : Math.max(0, (similarity - 0.48) / 0.52)) * closure,
                            backgroundRemovedCosine: stripped.direction && strippedTag.direction
                                ? dot(stripped.direction, strippedTag.direction) : null };
                    }).sort((a, b) => b.tagCredit - a.tagCredit || a.id - b.id);
                const bodyCosine = dot(vector, body);
                const bodyFallback = 0.7 * Math.max(0, (bodyCosine - 0.45) / 0.55);
                return { chunkId, bodyCosine, bodyFallback,
                    backgroundRemovedBodyCosine: stripped.direction && strippedBody.direction
                        ? dot(stripped.direction, strippedBody.direction) : null,
                    winningChannel: bodyFallback > (tags[0]?.tagCredit || 0) ? 'body' : 'tag',
                    strongestTagMatches: tags.slice(0, 3) };
            });
            return { id, name: row.name, backgroundCosine: dot(vector, background),
                remainingEnergy: stripped.energy, comparisons };
        });
        assert(controls[0].comparisons.every(c => c.backgroundRemovedBodyCosine === null),
            'a background vector stripped of itself must never normalize numerical noise');
        return { scope: 'read-only endpoint mechanism; no graph changes or relevance labels',
            querySource: option >= 0 ? 'provided actual query vector' : 'synthetic unit(humor+auto), NOT original query',
            target: { id: target.id, name: target.name }, axes, candidates, controls,
            limitations: ['File tags are in-sample evidence, not held-out relevance judgments.',
                'No native scoring replay, ANN recall measurement or external embedding call.'] };
    })();
    console.log(JSON.stringify(report, null, 2));
} finally {
    db.close();
}