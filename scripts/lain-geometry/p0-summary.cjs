'use strict';

// cuts: seven ascending (possibly equal) finite FP32 cuts per dimension.
// First/last intervals are unbounded. Callers validate cuts once at construction.
function bucket(x, cuts, at) {
    let b = 0;
    while (b < 7 && x >= cuts[at + b]) b++;
    return b;
}

function windowMask(lo, hi, cuts, at) {
    let mask = 0;
    for (let b = 0; b < 8; b++) {
        const left = b ? cuts[at + b - 1] : -Infinity;
        const right = b < 7 ? cuts[at + b] : Infinity;
        if (left < right && hi >= left && lo < right) mask |= 1 << b;
    }
    return mask;
}

// Packed rows for ONE nonempty tile, row-major. No padding for tail tiles.
function summarize(rows, d, cuts) {
    if (!Number.isSafeInteger(d) || d < 1 || !(rows instanceof Float32Array) ||
        !rows.length || rows.length % d || cuts.length !== 7*d) throw new Error('invalid summary shape');
    const min = new Float32Array(d).fill(Infinity), max = new Float32Array(d).fill(-Infinity);
    const occupied = new Uint8Array(d);
    for (let start = 0; start < rows.length; start += d) {
        for (let j = 0; j < d; j++) {
            const x = rows[start+j];
            if (!Number.isFinite(x)) throw new Error('non-finite raw row');
            if (x < min[j]) min[j] = x;
            if (x > max[j]) max[j] = x;
            occupied[j] |= 1 << bucket(x, cuts, 7*j);
        }
    }
    return { min, max, occupied };
}

function upperBounds(summary, lo, hi, masks) {
    const { min, max, occupied } = summary;
    let aabb = 0, bins = 0;
    for (let j = 0; j < min.length; j++) {
        if (min[j] <= hi[j] && max[j] >= lo[j]) aabb++;
        if (occupied[j] & masks[j]) bins++;
    }
    return { aabb, bins };
}

function slack(upper, exposed, best) {
    if (!(upper >= exposed && exposed >= best)) throw new Error('invalid U >= E >= M');
    return { env: upper - exposed, chimera: exposed - best };
}

function excludable(upper, minId, kth) {
    return upper < kth.score || (upper === kth.score && minId > kth.id);
}

module.exports = { bucket, windowMask, summarize, upperBounds, slack, excludable };