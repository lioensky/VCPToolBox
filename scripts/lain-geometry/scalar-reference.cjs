'use strict';

// Offline oracle only. No tile ids, summaries, online heap or reusable scoring kernel.
function exactScan(ids, matrix, lo, hi, k) {
    const n = ids.length;
    if (!Number.isSafeInteger(k) || k < 1 || k > n) throw new RangeError('expected 1 <= k <= N');
    if (!(lo instanceof Float32Array || lo instanceof Float64Array) ||
        !(hi instanceof Float32Array || hi instanceof Float64Array) ||
        !lo.length || hi.length !== lo.length) throw new TypeError('invalid window shape');
    const d = lo.length;
    if (!(matrix instanceof Float32Array) || matrix.length !== n * d) throw new TypeError('invalid raw matrix');
    for (let j = 0; j < d; j++) {
        if (!Number.isFinite(lo[j]) || !Number.isFinite(hi[j]) || lo[j] > hi[j]) {
            throw new RangeError(`invalid closed window at dimension ${j}`);
        }
    }
    const seen = new Set();
    const scores = new Uint32Array(n);
    const ranking = [];
    for (let i = 0; i < n; i++) {
        // Frozen ids.u64le may be loaded directly as BigUint64Array.
        const id = typeof ids[i] === 'bigint' ? Number(ids[i]) : ids[i];
        if (!Number.isSafeInteger(id) || id < 0 || seen.has(id)) throw new RangeError(`invalid stable id at slot ${i}`);
        seen.add(id);
        let score = 0;
        for (let j = 0; j < d; j++) {
            const value = matrix[i * d + j];
            if (!Number.isFinite(value)) throw new RangeError(`invalid raw value at slot ${i}, dim ${j}`);
            if (lo[j] <= value && value <= hi[j]) score++;
        }
        scores[i] = score;
        ranking.push({ score, id });
    }
    ranking.sort((a, b) => b.score - a.score || a.id - b.id);
    return { scores, topK: ranking.slice(0, k) };
}

module.exports = { exactScan };