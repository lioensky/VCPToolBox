'use strict';

/**
 * 将 SQLite BLOB 或现有 Float32Array 安全解码为指定维度的 Float32Array。
 * 对未对齐的 Buffer 先复制，避免 TypedArray 构造时抛出 RangeError。
 *
 * @param {Buffer|Float32Array|ArrayBufferView|null|undefined} blob
 * @param {number} dimension
 * @param {string} [label='vector']
 * @param {object} [options]
 * @param {string} [options.logPrefix='KnowledgeBase']
 * @returns {Float32Array|null}
 */
function decodeVectorBlob(blob, dimension, label = 'vector', options = {}) {
    const dim = Number(dimension);
    if (!Number.isSafeInteger(dim) || dim <= 0) {
        return null;
    }

    if (blob instanceof Float32Array) {
        return blob.length === dim ? blob : null;
    }
    if (!blob || typeof blob.length !== 'number') {
        return null;
    }

    const expectedBytes = dim * Float32Array.BYTES_PER_ELEMENT;
    if (blob.length !== expectedBytes) {
        const logPrefix = options.logPrefix || 'KnowledgeBase';
        console.warn(`[${logPrefix}] ⚠️ Invalid ${label} blob length: expected ${expectedBytes}, got ${blob.length}`);
        return null;
    }

    if (blob.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0) {
        return new Float32Array(blob.buffer, blob.byteOffset, dim);
    }

    const copied = Buffer.from(blob);
    return new Float32Array(copied.buffer, copied.byteOffset, dim);
}

/**
 * 将向量转换为只覆盖实际视图范围的 Buffer。
 *
 * @param {Float32Array|Array<number>|ArrayBufferView} vector
 * @returns {Buffer}
 */
function encodeVectorBlob(vector) {
    const floatVector = vector instanceof Float32Array
        ? vector
        : new Float32Array(vector);
    return Buffer.from(
        floatVector.buffer,
        floatVector.byteOffset,
        floatVector.byteLength
    );
}

module.exports = {
    decodeVectorBlob,
    encodeVectorBlob
};