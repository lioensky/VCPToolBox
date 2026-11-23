'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { trueTiles, shuffledTiles } = require('../scripts/lain-geometry/tiles.cjs');

test('wedge before radius order; ids break angular and radial ties', () => {
    const ids = Array.from({ length: 65 }, (_, i) => BigInt(65 - i));
    const angle = new Float32Array(65), radius = new Float32Array(65);
    // All angles tie. ID=65 falls in the second wedge despite having smallest radius.
    radius.fill(1); radius[0] = 0; radius[1] = 0;
    const t = trueTiles(ids, angle, radius);
    assert.deepEqual(t.map(a => a.length), [16,16,16,16,1]);
    assert.deepEqual(t[0].map(s => ids[s]), [64n, ...Array.from({length:15}, (_, i) => BigInt(i+1))]);
    assert.deepEqual(t[4], [0]);
});

test('actual plate size: tail, coverage and deterministic same-capacity shuffles', () => {
    const n = 6849;
    const seq = Array.from({ length: n }, (_, i) => i);
    const t = trueTiles(seq, seq, seq);
    assert.equal(t.length, 429);
    assert.deepEqual(t.map(x => x.length), [...Array(428).fill(16), 1]);
    const seen = new Set();
    for (const seed of [1,2,3,4,5]) {
        const s = shuffledTiles(t, seed);
        assert.deepEqual(s, shuffledTiles(t, seed));
        assert.deepEqual(s.map(x => x.length), t.map(x => x.length));
        assert.deepEqual(s.flat().sort((a,b) => a-b), seq);
        seen.add(JSON.stringify(s));
    }
    assert.equal(seen.size, 5);
});