const test = require('node:test');
const assert = require('node:assert/strict');
const Deduplicator = require('../ResultDeduplicator');

function adjacent(value, up) {
    if (value === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
    const f = new Float64Array([value]), bits = new BigUint64Array(f.buffer);
    bits[0] += (value > 0) === up ? 1n : -1n;
    return f[0];
}

test('bounded cosine matches the original predicate at exact and adjacent thresholds', () => {
    let seed = 17;
    for (const n of [1, 255, 256, 511, 512, 513, 767, 768, 769, 1536, 3071, 3072, 4096]) {
        const d = new Deduplicator(null, { dimension: n });
        const x = Float32Array.from({ length: n }, () => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return seed / 0xffffffff - 0.5;
        });
        for (let mode = 0; mode < 5; mode++) {
            const y = Float32Array.from(x, (v, i) => mode === 0 ? v : mode === 1 ? -v
                : mode === 2 ? (i % 3 ? v : -v) : mode === 3 ? v + (i % 7 - 3) * .001 : x[(i + Math.floor(n / 2)) % n]);
            const a = d._createVectorDescriptor(x), b = d._createVectorDescriptor(y);
            const exact = d._cosineSimilarityPrepared(a, b);
            for (const threshold of [-1, 0, .88, .92, .97, 1, exact, adjacent(exact, true), adjacent(exact, false)]) {
                assert.equal(d._cosineAtLeast(a, b, threshold), exact >= threshold, `n=${n}, mode=${mode}, threshold=${threshold}`);
            }
        }
    }
});

test('full semantic selection keeps source priority, missing vectors, scores and order', () => {
    const d = new Deduplicator(null, { dimension: 3072 });
    const reference = new Deduplicator(null, { dimension: 3072 });
    reference._cosineAtLeast = (a, b, t) => reference._cosineSimilarityPrepared(a, b) >= t;
    const candidates = Array.from({ length: 80 }, (_, i) => ({
        id: i + 1, score: (i % 7) / 7, source: ['rag', 'time', 'bm25_body', 'associate'][i % 4],
        vector: i % 13 ? Float32Array.from({ length: 3072 }, (_, j) => Math.sin((i % 11 + 1) * (j + 1))) : null
    }));
    const query = candidates[1].vector;
    for (const threshold of [-1, 0, .88, .92, .97, 1]) for (const max of [1, 8, 300]) {
        assert.deepEqual(d._semanticDeduplicate(candidates, query, threshold, max),
            reference._semanticDeduplicate(candidates, query, threshold, max));
    }
});

test('bound budget is gated for small results and reset for each request', () => {
    const d = new Deduplicator(null, { dimension: 3072 });
    const candidates = Array.from({ length: 12 }, (_, i) => ({
        id: i + 1, score: 12 - i, source: 'rag',
        vector: Float32Array.from({ length: 3072 }, (_, j) => j === i ? 1 : 0)
    }));
    const calls = [];
    d._cosineAtLeast = (left, right, threshold, budget) => {
        calls.push(budget);
        budget.remaining = 0;
        return d._cosineSimilarityPrepared(left, right) >= threshold;
    };
    d._semanticDeduplicate(candidates, candidates[0].vector, 0.92, 8);
    assert.equal(calls.length, 0, 'eight results must use the original predicate');
    for (let request = 0; request < 2; request++) {
        d._semanticDeduplicate(candidates, candidates[0].vector, 0.92, 12);
        assert.equal(calls.length, request + 1, 'exhausted budget stops further bound calls');
    }
    assert.notEqual(calls[0], calls[1], 'each request owns a fresh budget');
});

test('bound matches exact comparison around the million-dimension cutoff', () => {
    for (const n of [999999, 1000000, 1000001]) {
        const d = new Deduplicator(null, { dimension: n });
        const x = new Float32Array(n).fill(1);
        const y = x.slice();
        y[n - 1] = -1;
        const a = d._createVectorDescriptor(x), b = d._createVectorDescriptor(y);
        const exact = d._cosineSimilarityPrepared(a, b);
        for (const threshold of [adjacent(exact, false), exact, adjacent(exact, true), 1]) {
            assert.equal(d._cosineAtLeast(a, b, threshold), exact >= threshold, `n=${n}`);
        }
    }
});
