'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { exactScan } = require('../scripts/lain-geometry/scalar-reference.cjs');

test('both endpoints inclusive; singleton window; stable ties at k=1 and k=N', () => {
    const ids = BigUint64Array.of(4294967303n, 7n, 52n);
    const matrix = Float32Array.of(-1, 2, 1, 2, 0, 3);
    const lo = Float64Array.of(-1, 2), hi = Float64Array.of(1, 2);
    const expected = [{ score: 2, id: 7 }, { score: 2, id: 4294967303 }, { score: 1, id: 52 }];
    const all = exactScan(ids, matrix, lo, hi, 3);
    assert.deepEqual([...all.scores], [2, 2, 1]);
    assert.deepEqual(all.topK, expected);
    assert.deepEqual(exactScan(ids, matrix, lo, hi, 1).topK, expected.slice(0, 1));
});

test('two points expose different dimensions: no point gets two votes', () => {
    const zero = Float32Array.of(0, 0);
    const out = exactScan([11, 9], Float32Array.of(0, 1, 1, 0), zero, zero, 2);
    assert.deepEqual(out.topK, [{ score: 1, id: 9 }, { score: 1, id: 11 }]);
});

test('FP64 lower bound above 1 is not rounded down onto FP32 raw value', () => {
    const out = exactScan([1], Float32Array.of(1), Float64Array.of(1 + 2 ** -30), Float64Array.of(2), 1);
    assert.equal(out.scores[0], 0);
});

test('invalid inputs cannot produce a ranking', () => {
    const raw = Float32Array.of(0), lo = Float32Array.of(0), hi = Float32Array.of(1);
    for (const k of [0, 2, 0.5]) assert.throws(() => exactScan([1], raw, lo, hi, k), /k <= N/);
    assert.throws(() => exactScan([1], raw, hi, lo, 1), /window/);
    assert.throws(() => exactScan([1], Float32Array.of(NaN), lo, hi, 1), /raw value/);
    assert.throws(() => exactScan([2n ** 53n], raw, lo, hi, 1), /stable id/);
});