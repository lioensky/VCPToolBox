'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DIM, validateIndex, rawRows } = require('../scripts/lain-geometry/freeze-core.cjs');

const u32 = (...xs) => Uint32Array.from(xs);
function plate() {
    return {
        ids: [104, 7, 52], dimension: DIM, radius: Float32Array.of(0.2, 0.4, 0.6),
        offsets: u32(0, 1, 2, 3), graph: u32(1, 2, 0), entries: u32(2),
        directionLandmarks: u32(0), shellLandmarks: u32(1),
    };
}

test('raw payload is requested by stable SQLite id in snapshot order', () => {
    const p = plate();
    validateIndex(p);
    const requested = [];
    const rows = [...rawRows(p.ids, id => {
        requested.push(id);
        const v = new Float32Array(DIM);
        v[0] = id;
        return v;
    })];
    assert.deepEqual(requested, [104, 7, 52]);
    assert.deepEqual(rows.map(({ slot, id, values }) => [slot, id, values[0]]),
        [[0, 104, 104], [1, 7, 7], [2, 52, 52]]);
});

for (const [label, value] of [
    ['missing', null], ['short', new Float32Array(DIM - 1)], ['wrong dtype', new Uint32Array(DIM)],
    ...[NaN, Infinity, -Infinity].map(x => {
        const values = new Float32Array(DIM);
        values[DIM - 1] = x;
        return [String(x), values];
    }),
]) {
    test(`reject raw payload: ${label}`, () => {
        assert.throws(() => [...rawRows([104], () => value)], /chunks\.id=104 \(slot 0\)/);
    });
}

for (const [patch, reason] of [
    [{ ids: [104, 7, 104] }, /duplicate/],
    [{ dimension: DIM - 1 }, /shape/],
    [{ radius: Float32Array.of(0, NaN, 0) }, /radius/],
    [{ offsets: u32(1, 1, 2, 3) }, /endpoints/],
    [{ offsets: u32(0, 1, 2, 2) }, /endpoints/],
    [{ offsets: u32(0, 2, 1, 3) }, /decreasing/],
    ...['graph', 'entries', 'directionLandmarks', 'shellLandmarks'].map(key =>
        [{ [key]: key === 'graph' ? u32(1, 2, 104) : u32(104) }, new RegExp(`${key}\\[`)]),
]) {
    test(`reject malformed plate: ${Object.keys(patch)[0]} (${reason.source})`, () => {
        assert.throws(() => validateIndex(Object.assign(plate(), patch)), reason);
    });
}