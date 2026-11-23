'use strict';

const { createHash } = require('node:crypto');
const { endianness } = require('node:os');
const { parseChunkField } = require('../../Plugin/WarpedFieldAtlas/lib/snapshot.js');
const { computeLayout } = require('../../Plugin/WarpedFieldAtlas/lib/layout.js');

const DIM = 3072;

function requireFiniteF32(values, length, label) {
    if (!(values instanceof Float32Array) || values.length !== length) {
        throw new Error(`${label}: expected Float32Array[${length}], got length ${values?.length ?? 'missing'}`);
    }
    for (let i = 0; i < length; i++) {
        if (!Number.isFinite(values[i])) throw new Error(`${label}[${i}]: non-finite`);
    }
    return values;
}

function validateIndex(index) {
    const { ids, dimension, radius, offsets, graph, entries, directionLandmarks, shellLandmarks } = index;
    const n = ids.length;
    if (!n || dimension !== DIM) throw new Error(`unexpected index shape: ${n} x ${dimension}`);
    const seen = new Set();
    for (const id of ids) {
        if (!Number.isSafeInteger(id) || id < 0 || seen.has(id)) throw new Error(`invalid or duplicate chunks.id: ${id}`);
        seen.add(id);
    }
    requireFiniteF32(radius, n, 'radius');
    if (!(offsets instanceof Uint32Array) || offsets.length !== n + 1 ||
        offsets[0] !== 0 || offsets[n] !== graph.length) throw new Error('invalid CSR endpoints');
    for (let i = 0; i < n; i++) {
        if (offsets[i] > offsets[i + 1]) throw new Error(`decreasing CSR offset at slot ${i}`);
    }
    for (const [label, list] of Object.entries({ graph, entries, directionLandmarks, shellLandmarks })) {
        if (!(list instanceof Uint32Array)) throw new Error(`${label}: expected Uint32Array`);
        for (let i = 0; i < list.length; i++) {
            if (list[i] >= n) throw new Error(`${label}[${i}]: slot ${list[i]} outside [0, ${n})`);
        }
    }
}

function readPlate(bytes) {
    if (endianness() !== 'LE') throw new Error('Atlas typed-array decoder requires a little-endian host');
    const { index, model, facts, rule } = parseChunkField(bytes);
    validateIndex(index);
    const { ids, radius, offsets, graph, entries, directionLandmarks, shellLandmarks } = index;
    // parseChunkField already bounded this header and verified the payload digest.
    const end = 16 + Number(bytes.readBigUInt64LE(8));
    const { versions } = JSON.parse(bytes.toString('utf8', 16, end));
    if (!versions || Array.isArray(versions) || typeof versions !== 'object' ||
        Object.keys(versions).length !== ids.length) throw new Error('missing or incomplete training version baseline');
    for (const id of ids) {
        const pair = versions[id];
        if (!Object.hasOwn(versions, id) || !Array.isArray(pair) || pair.length !== 2 ||
            !pair.every(Number.isSafeInteger)) throw new Error(`invalid training version for chunks.id=${id}`);
    }
    const { angle } = computeLayout(ids.length, offsets, graph);
    requireFiniteF32(angle, ids.length, 'angle');
    return {
        snapshotSha256: createHash('sha256').update(bytes).digest('hex'),
        model, facts, rule, versions, ids, radius, angle, offsets, graph, entries, directionLandmarks, shellLandmarks,
    };
}

// Consume synchronously in snapshot order; never use slot as the SQLite key.
function* rawRows(ids, readChunkById) {
    for (let slot = 0; slot < ids.length; slot++) {
        const id = ids[slot];
        const values = requireFiniteF32(readChunkById(id), DIM, `chunks.id=${id} (slot ${slot})`);
        yield { slot, id, values };
    }
}

module.exports = { DIM, validateIndex, readPlate, rawRows };