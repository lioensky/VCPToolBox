'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { VexusIndex } = require('../../../rust-vexus-lite');

test('Gen-USearch Vexus ABI preserves adjacent signed-int64 keys above JS safe integer', () => {
    const index = new VexusIndex(4, 32);
    const a = '9007199254740992';
    const b = '9007199254740993';
    const max = '9223372036854775807';

    const va = new Float32Array([1, 0, 0, 0]);
    const vb = new Float32Array([0, 1, 0, 0]);
    const vm = new Float32Array([0, 0, 1, 0]);

    index.addBatchKey64(
        [a, b],
        new Float32Array([...va, ...vb])
    );
    index.addKey64(max, vm);

    assert.equal(index.searchKey64(va, 3)[0].id, a);
    assert.equal(index.searchKey64(vb, 3)[0].id, b);
    assert.equal(index.searchKey64(vm, 3)[0].id, max);

    const ids = index.searchKey64(
        new Float32Array([0.5, 0.5, 0.5, 0]),
        8
    ).map(row => row.id).sort();

    assert.deepEqual(ids, [a, b, max].sort());
    assert.notEqual(a, b);

    index.removeKey64(b);
    const afterRemove = index.searchKey64(vb, 8)
        .map(row => row.id);
    assert.equal(afterRemove.includes(b), false);
    assert.equal(afterRemove.includes(a), true);
});

test('Gen-USearch Vexus ABI rejects noncanonical or out-of-range keys', () => {
    const index = new VexusIndex(4, 8);
    const vector = new Float32Array([1, 0, 0, 0]);

    for (const id of [
        '',
        '0',
        '01',
        '-1',
        'abc',
        '9223372036854775808'
    ]) {
        assert.throws(
            () => index.addKey64(id, vector),
            /canonical positive decimal|string|signed-int64 range/
        );
    }
});

test('legacy numeric Vexus API remains intact', () => {
    const index = new VexusIndex(4, 8);
    const vector = new Float32Array([1, 0, 0, 0]);

    index.add(42, vector);
    const result = index.search(vector, 1)[0];
    assert.equal(result.id, 42);
    assert.equal(typeof result.id, 'number');
});
