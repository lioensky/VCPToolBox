'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const native = require('../../../rust-vexus-lite');

test('tracked platform native artifact exposes the Gen-USearch key64 ABI without rebuilding', () => {
    assert.equal(typeof native.VexusIndex, 'function');
    for (const name of [
        'addKey64',
        'addBatchKey64',
        'containsKey64',
        'removeKey64',
        'searchKey64',
        'applyChunkDeltaKey64'
    ]) {
        assert.equal(
            typeof native.VexusIndex.prototype[name],
            'function',
            name
        );
    }
});
