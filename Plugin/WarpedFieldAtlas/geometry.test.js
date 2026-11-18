'use strict';

// 距离函数的测试。真值不取自本模块：
// - alpha = 0 时这个度量就是“平面上绕开一个圆盘”的距离，有闭式（上游 warped_geometry.rs 的测试用的同一个式子）；
// - 真实快照里的距离表由上游 Rust 算出，逐位核对在 dev/check-native.js 和每次载入时的自检里做，这里不重复。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGeometry } = require('./lib/geometry');

const indexOf = (alpha, phi0, kappa, extra = {}) => ({
    profileKind: 1, profile: [alpha, 0, 0],
    config: { throatPhi0: phi0, angularScaleKappa: kappa, angularTau: 0, angularEta: 1, radiusMax: 0.65, ...extra },
});

test('alpha 为 0 时与平面绕圆盘的闭式距离一致', () => {
    let worst = 0;
    for (const phi0 of [0.8, 1.5]) {
        for (const kappa of [0.5, 0.75, 1, 1.5, 2]) {
            const geometry = createGeometry(indexOf(0, phi0, kappa));
            assert.equal(geometry.supported, true);
            for (const a of [0.01, 0.35, 0.65, 1.2]) {
                for (const b of [0.02, 0.35, 0.9, 1.2]) {
                    for (let i = 1; i <= 32; i++) {
                        const theta = Math.PI * i / 32;
                        const angle = kappa * theta;
                        const x = a + phi0;
                        const y = b + phi0;
                        const critical = Math.acos(phi0 / x) + Math.acos(phi0 / y);
                        const expected = angle <= critical
                            ? Math.sqrt((x - y) ** 2 + 4 * x * y * Math.sin(angle / 2) ** 2)
                            : Math.sqrt(x * x - phi0 * phi0) + Math.sqrt(y * y - phi0 * phi0) + phi0 * (angle - critical);
                        const got = geometry.distance(a, b, theta);
                        worst = Math.max(worst, Math.abs(got - expected));
                    }
                }
            }
        }
    }
    assert.ok(worst < 2e-8, `最大偏差 ${worst}`);
});

test('生产参数下：对称、同方向等于半径差、三角不等式', () => {
    const geometry = createGeometry(indexOf(0.15, 1.5, 2));
    assert.equal(geometry.distance(0.4, 0.6, 0), 0.2 - 0 > 0 ? Math.abs(0.4 - 0.6) : 0);
    for (let n = 0; n < 64; n++) {
        const angles = [0.013 * n, 0.47 + 0.019 * n, 1.2 + 0.023 * n];
        const radii = [0.35 + 0.004 * n, 0.65 - 0.004 * n, 0.4 + 0.003 * n];
        const d = (i, j) => geometry.distance(radii[i], radii[j], Math.abs(angles[i] - angles[j]));
        assert.ok(Math.abs(d(0, 1) - d(1, 0)) < 1e-12);
        assert.ok(d(0, 1) >= Math.abs(radii[0] - radii[1]) - 1e-9);
        assert.ok(d(0, 2) <= d(0, 1) + d(1, 2) + 1e-8);
    }
});

test('贴管腰走的一段：距离 = 两头各自的代价 + 管腰周长系数 × 夹角', () => {
    const geometry = createGeometry(indexOf(0.15, 1.5, 2));
    const cost = r => { const leg = geometry.leg(r); return leg.length - geometry.base * leg.angle; };
    for (const [rq, rv, theta] of [[0.35, 0.65, 1.0], [0.5, 0.5, 1.2], [0.42, 0.6, 1.6]]) {
        assert.equal(geometry.regime(rq, rv, theta), 'throat');
        assert.ok(Math.abs(geometry.distance(rq, rv, theta) - (cost(rq) + cost(rv) + geometry.base * theta)) < 1e-12);
    }
    assert.equal(geometry.regime(0.5, 0.5, 0.2), 'dip');
});

test('等距离线上的点，距离就是那个值', () => {
    const geometry = createGeometry(indexOf(0.15, 1.5, 2));
    const radii = [0.35, 0.45, 0.55, 0.65];
    const angles = geometry.contour(0.46, 3.9, radii);
    angles.forEach((theta, n) => {
        assert.ok(theta != null);
        assert.ok(Math.abs(geometry.distance(0.46, radii[n], theta) - 3.9) < 1e-9);
    });
    // 里圈的节点在同样的距离下可以离得更开。
    assert.ok(angles[0] > angles[3]);
});

test('不是带管腰的 Softening 剖面时明说不支持', () => {
    assert.equal(createGeometry(indexOf(0.15, 0, 1)).supported, false);
    assert.equal(createGeometry({ ...indexOf(0.15, 1.5, 2), profileKind: 2 }).supported, false);
    assert.equal(createGeometry(indexOf(0.15, 1.5, 2, { angularTau: 0.1 })).supported, false);
});
