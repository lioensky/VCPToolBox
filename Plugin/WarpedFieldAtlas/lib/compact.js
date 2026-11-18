'use strict';

/** 逐向量量化。unit 是有限、非零的 Float32 向量，norm 是它的模长。 */
function encode(unit, norm, codes, at) {
    let top = 0;
    for (let j = 0; j < unit.length; j++) top = Math.max(top, Math.abs(unit[j]));
    const scale = Math.fround(top / 127);
    let lost = 0;
    for (let j = 0; j < unit.length; j++) {
        const code = Math.round(unit[j] / scale);
        codes[at + j] = code;
        const delta = unit[j] - codes[at + j] * scale;
        lost += delta * delta;
    }
    // 柯西不等式给出余弦误差上界。乘数和常量给浮点运算留余量。
    const slack = Math.sqrt(lost) / norm * (1 + 1e-6) + 1e-6;
    return { scale, slack };
}

/**
 * 现在读到的向量 unit 是否还是当初压缩的那一个：它与压缩后的向量（codes × scale）的差不超过当初记下的 slack × norm。
 * 没变的向量一定通过（slack 里留了余量）；通过的向量，粗算余弦的误差上界对它仍然成立。
 */
function matchesCode(unit, norm, codes, at, scale, slack) {
    let lost = 0;
    for (let j = 0; j < unit.length; j++) {
        const delta = unit[j] - codes[at + j] * scale;
        lost += delta * delta;
    }
    return Math.sqrt(lost) <= slack * norm;
}

function dotAt(probe, values, at) {
    let dot = 0;
    for (let j = 0; j < probe.length; j++) dot += probe[j] * values[at + j];
    return dot;
}

function coarseCosine(probe, probeNorm, codes, at, scale, norm) {
    return dotAt(probe, codes, at) * scale / probeNorm / norm;
}

const clampCosine = value => Math.min(1, Math.max(-1, value));

function parseExactMegabytes(value) {
    if (typeof value === 'string' && value.trim() !== '') value = Number(value);
    return Number.isFinite(value) ? value : undefined;
}

module.exports = { encode, matchesCode, dotAt, coarseCosine, clampCosine, parseExactMegabytes };
