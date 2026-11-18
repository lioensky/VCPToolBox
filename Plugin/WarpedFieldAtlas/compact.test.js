'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { encode, coarseCosine } = require('./lib/compact');

test('量化余弦的实际误差为正且落在上界内', t => {
    let seed = 20261119;
    const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 2 ** 31 - 1;
    };
    const normOf = vector => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    let minError = Infinity;
    let maxError = 0;
    let maxRandomRatio = 0;
    let maxRatio = 0;
    let checked = 0;
    for (const dim of [4, 8, 16, 32]) {
        for (let n = 0; n < 8; n++) {
            const unit = Float32Array.from({ length: dim }, random);
            const length = normOf(unit);
            for (let j = 0; j < unit.length; j++) unit[j] /= length;
            const norm = normOf(unit);
            const probe = Float32Array.from({ length: dim }, random);
            const codes = new Int8Array(dim + 2).fill(100);
            const { scale, slack } = encode(unit, norm, codes, 1);
            assert.equal(codes[0], 100);
            assert.equal(codes[codes.length - 1], 100);

            function cosineError(query) {
                const probeNorm = normOf(query);
                let exactDot = 0;
                for (let j = 0; j < dim; j++) exactDot += unit[j] * query[j];
                return Math.abs(exactDot / probeNorm / norm - coarseCosine(query, probeNorm, codes, 1, scale, norm));
            }
            const error = cosineError(probe);
            assert.ok(error > 0 && error <= slack, JSON.stringify([dim, n, error, slack]));
            minError = Math.min(minError, error);
            maxError = Math.max(maxError, error);
            maxRandomRatio = Math.max(maxRandomRatio, slack / error);

            // 随机探针可能恰好垂直于量化误差。沿最坏方向检查上界是否过松。
            const worstProbe = Float32Array.from(unit, (value, j) => value - codes[j + 1] * scale);
            const worstError = cosineError(worstProbe);
            assert.ok(worstError > 0 && worstError <= slack, JSON.stringify([dim, n, worstError, slack]));
            maxRatio = Math.max(maxRatio, slack / worstError);
            checked++;
        }
    }
    t.diagnostic(JSON.stringify([checked, minError, maxError, maxRandomRatio, maxRatio]));
    assert.ok(maxRatio <= 200, String(maxRatio));
});

test('重读的向量：没变的认得出，换了一个的也认得出', () => {
    const { matchesCode } = require('./lib/compact');
    let seed = 7;
    const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 2 ** 31 - 1;
    };
    const unitVector = dim => {
        const vector = Float32Array.from({ length: dim }, random);
        const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
        return vector.map(value => value / length);
    };
    const normOf = vector => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    for (const dim of [16, 64, 3072]) {
        const unit = unitVector(dim);
        const norm = normOf(unit);
        const codes = new Int8Array(dim);
        const { scale, slack } = encode(unit, norm, codes, 0);
        assert.equal(matchesCode(unit, norm, codes, 0, scale, slack), true, `没变的向量应当通过（${dim} 维）`);
        const other = unitVector(dim);
        assert.equal(matchesCode(other, normOf(other), codes, 0, scale, slack), false, `换了一个向量应当认出来（${dim} 维）`);
    }
});
