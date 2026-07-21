'use strict';

const crypto = require('crypto');

function stableSerialize(value) {
    if (value === null || value === undefined) return JSON.stringify(value);
    if (typeof value === 'number') {
        return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
    }
    if (typeof value === 'bigint') return JSON.stringify(value.toString());
    if (typeof value !== 'object') return JSON.stringify(value);

    if (ArrayBuffer.isView(value)) {
        return `[${Array.from(value, item => stableSerialize(item)).join(',')}]`;
    }
    if (Array.isArray(value)) {
        return `[${value.map(item => stableSerialize(item)).join(',')}]`;
    }
    if (value instanceof Set) {
        return stableSerialize([...value].sort(compareStable));
    }
    if (value instanceof Map) {
        const entries = [...value.entries()]
            .sort((left, right) => compareStable(left[0], right[0]));
        return `{${entries.map(([key, item]) =>
            `${stableSerialize(String(key))}:${stableSerialize(item)}`
        ).join(',')}}`;
    }

    const keys = Object.keys(value).sort();
    return `{${keys.map(key =>
        `${JSON.stringify(key)}:${stableSerialize(value[key])}`
    ).join(',')}}`;
}

function compareStable(left, right) {
    const a = typeof left === 'number' ? left : String(left);
    const b = typeof right === 'number' ? right : String(right);
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b));
}

function hashStable(value, length = 32) {
    return crypto.createHash('sha256')
        .update(stableSerialize(value))
        .digest('hex')
        .slice(0, Math.max(8, Math.min(64, Number(length) || 32)));
}

function immutableSnapshot(value, seen = new WeakMap()) {
    if (value === null || value === undefined || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);

    if (ArrayBuffer.isView(value)) {
        return Object.freeze(Array.from(value, item => immutableSnapshot(item, seen)));
    }
    if (Array.isArray(value)) {
        const output = [];
        seen.set(value, output);
        for (const item of value) output.push(immutableSnapshot(item, seen));
        return Object.freeze(output);
    }
    if (value instanceof Map) {
        const entries = [...value.entries()]
            .sort((left, right) => compareStable(left[0], right[0]))
            .map(([key, item]) => Object.freeze([
                immutableSnapshot(key, seen),
                immutableSnapshot(item, seen)
            ]));
        const view = createReadonlyMapView(entries);
        seen.set(value, view);
        return view;
    }
    if (value instanceof Set) {
        const items = [...value].sort(compareStable)
            .map(item => immutableSnapshot(item, seen));
        const view = Object.freeze({
            size: items.length,
            has(item) {
                return items.includes(item);
            },
            values() {
                return items[Symbol.iterator]();
            },
            toArray() {
                return items.slice();
            },
            [Symbol.iterator]() {
                return items[Symbol.iterator]();
            }
        });
        seen.set(value, view);
        return view;
    }

    const output = {};
    seen.set(value, output);
    for (const key of Object.keys(value).sort()) {
        output[key] = immutableSnapshot(value[key], seen);
    }
    return Object.freeze(output);
}

function createReadonlyMapView(inputEntries = []) {
    const entries = inputEntries.map(entry => Object.freeze([entry[0], entry[1]]));
    const lookup = new Map(entries);
    return Object.freeze({
        size: entries.length,
        has(key) {
            return lookup.has(key);
        },
        get(key) {
            return lookup.get(key);
        },
        entries() {
            return entries[Symbol.iterator]();
        },
        keys() {
            return entries.map(entry => entry[0])[Symbol.iterator]();
        },
        values() {
            return entries.map(entry => entry[1])[Symbol.iterator]();
        },
        forEach(callback, thisArg = undefined) {
            for (const [key, value] of entries) callback.call(thisArg, value, key, this);
        },
        toArray() {
            return entries.map(entry => [entry[0], entry[1]]);
        },
        [Symbol.iterator]() {
            return entries[Symbol.iterator]();
        }
    });
}

function createReadonlyCsr(sourceMatrix) {
    const sourceIds = [...sourceMatrix.keys()]
        .map(Number)
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    const nodeIds = new Set(sourceIds);
    for (const edges of sourceMatrix.values()) {
        if (!(edges instanceof Map)) continue;
        for (const targetId of edges.keys()) {
            const numeric = Number(targetId);
            if (Number.isFinite(numeric)) nodeIds.add(numeric);
        }
    }

    const orderedNodeIds = [...nodeIds].sort((a, b) => a - b);
    const indexById = new Map(orderedNodeIds.map((id, index) => [id, index]));
    const rowOffsets = new Uint32Array(orderedNodeIds.length + 1);
    const targetIndices = [];
    const weights = [];
    let maxRowMass = 0;

    for (let rowIndex = 0; rowIndex < orderedNodeIds.length; rowIndex++) {
        const sourceId = orderedNodeIds[rowIndex];
        const rawEdges = sourceMatrix.get(sourceId) || sourceMatrix.get(String(sourceId));
        const sortedEdges = rawEdges instanceof Map
            ? [...rawEdges.entries()]
                .map(([targetId, weight]) => [Number(targetId), Number(weight)])
                .filter(([targetId, weight]) =>
                    Number.isFinite(targetId) && Number.isFinite(weight) && weight > 0
                )
                .sort((left, right) => left[0] - right[0])
            : [];
        let rowMass = 0;
        for (const [targetId, weight] of sortedEdges) {
            const targetIndex = indexById.get(targetId);
            if (targetIndex === undefined) continue;
            targetIndices.push(targetIndex);
            weights.push(weight);
            rowMass += weight;
        }
        maxRowMass = Math.max(maxRowMass, rowMass);
        rowOffsets[rowIndex + 1] = targetIndices.length;
    }

    const targetArray = Uint32Array.from(targetIndices);
    const weightArray = Float64Array.from(weights);
    const contentSig = hashStable({
        nodeIds: orderedNodeIds,
        rowOffsets,
        targetIndices: targetArray,
        weights: weightArray
    }, 48);

    const nodeIdAt = index => orderedNodeIds[index];
    const nodeIndexOf = id => indexById.get(Number(id));

    return Object.freeze({
        schema: 'tagmemo-v10-alpha-csr-v1',
        nodeCount: orderedNodeIds.length,
        edgeCount: targetArray.length,
        maxRowMass,
        contentSig,
        nodeIdAt,
        nodeIndexOf,
        hasNode(id) {
            return indexById.has(Number(id));
        },
        rowMass(sourceId) {
            const rowIndex = nodeIndexOf(sourceId);
            if (rowIndex === undefined) return 0;
            let mass = 0;
            for (let cursor = rowOffsets[rowIndex]; cursor < rowOffsets[rowIndex + 1]; cursor++) {
                mass += weightArray[cursor];
            }
            return mass;
        },
        edgeWeight(sourceId, targetId) {
            const rowIndex = nodeIndexOf(sourceId);
            const wantedTarget = nodeIndexOf(targetId);
            if (rowIndex === undefined || wantedTarget === undefined) return 0;
            for (let cursor = rowOffsets[rowIndex]; cursor < rowOffsets[rowIndex + 1]; cursor++) {
                if (targetArray[cursor] === wantedTarget) return weightArray[cursor];
            }
            return 0;
        },
        forEachEdge(sourceId, callback) {
            const rowIndex = nodeIndexOf(sourceId);
            if (rowIndex === undefined) return;
            for (let cursor = rowOffsets[rowIndex]; cursor < rowOffsets[rowIndex + 1]; cursor++) {
                callback(nodeIdAt(targetArray[cursor]), weightArray[cursor], cursor);
            }
        },
        forEachRow(callback) {
            for (let rowIndex = 0; rowIndex < orderedNodeIds.length; rowIndex++) {
                callback(orderedNodeIds[rowIndex], rowIndex);
            }
        },
        apply(input, output = new Float64Array(orderedNodeIds.length)) {
            if (!input || input.length !== orderedNodeIds.length) {
                throw new RangeError(`CSR input length must be ${orderedNodeIds.length}`);
            }
            if (!output || output.length !== orderedNodeIds.length) {
                throw new RangeError(`CSR output length must be ${orderedNodeIds.length}`);
            }
            output.fill(0);
            for (let rowIndex = 0; rowIndex < orderedNodeIds.length; rowIndex++) {
                const sourceMass = Number(input[rowIndex]) || 0;
                if (sourceMass === 0) continue;
                for (let cursor = rowOffsets[rowIndex]; cursor < rowOffsets[rowIndex + 1]; cursor++) {
                    output[targetArray[cursor]] += sourceMass * weightArray[cursor];
                }
            }
            return output;
        },
        exportDigest() {
            return Object.freeze({
                schema: 'tagmemo-v10-alpha-csr-v1',
                nodeCount: orderedNodeIds.length,
                edgeCount: targetArray.length,
                maxRowMass,
                contentSig
            });
        }
    });
}

module.exports = {
    stableSerialize,
    hashStable,
    immutableSnapshot,
    createReadonlyMapView,
    createReadonlyCsr
};