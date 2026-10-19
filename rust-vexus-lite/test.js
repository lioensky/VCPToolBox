'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { VexusIndex } = require('./index.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-tdb-smoke-'));
const asset = path.join(root, 'standalone.vec');

try {
    const index = new VexusIndex(3, 16);
    index.addBatch([1, 2, 3], new Float32Array([
        3, 0, 0,
        0, 4, 0,
        -5, 0, 0
    ]));
    const query = new Float32Array([2, 0, 0]);
    assert.deepEqual(index.search(query, 3), [
        { id: 1, score: 1 },
        { id: 2, score: 0 },
        { id: 3, score: -1 }
    ]);
    assert.throws(() => index.addBatch(
        [1, 4], new Float32Array([0, 1, 0, NaN, 0, 0])
    ));
    assert.equal(index.stats().totalVectors, 3);
    assert.equal(index.search(query, 1)[0].id, 1);

    index.add(1, new Float32Array([0, 0, 7]));
    index.remove(3);
    const expected = index.search(new Float32Array([0, 0, 2]), 10);
    assert.deepEqual(expected, [{ id: 1, score: 1 }, { id: 2, score: 0 }]);
    index.save(asset);
    assert.equal(fs.readFileSync(asset).subarray(0, 8).toString(), 'VCPVEC01');

    const restored = VexusIndex.load(asset, null, 3, 16);
    assert.deepEqual(restored.search(new Float32Array([0, 0, 2]), 10), expected);
    assert.equal(restored.stats().totalVectors, 2);
    assert.throws(() => VexusIndex.load(asset, null, 2, 16));
    console.log('TDB native smoke: cosine, atomic validation, update/delete and snapshot passed.');
} finally {
    // Windows permits unlink of these read-only mappings; never truncate a
    // mapped asset. Keep the directory if a host still denies deferred cleanup.
    try {
        fs.rmSync(root, { recursive: true, force: true });
    } catch (error) {
        console.warn(`Temporary asset cleanup deferred: ${root}: ${error.message}`);
    }
}