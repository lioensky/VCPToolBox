'use strict';

// 双曲场的精确距离，照上游 rust-vexus-lite/crates/vcp-tdb-index/src/index/quiver/hyperbolic/warped_geometry.rs
// 的 throat_distance_with 原样移到 JS（运算顺序不变）。上游建场时把同一个函数在 64×64×65 个格点上的结果存进了快照，
// selfCheck 拿它逐位核对；对不上就不能用这里的距离。
//
// 度量：ds² = dR² + φ(R)² dΩ²，φ(R) = κ·(φ0 + R + αR³)。φ0 > 0 时 R = 0 处是一圈半径 κ·φ0 的“管腰”，不是一个点。

const GL_X = [0.09501250983763744, 0.2816035507792589, 0.4580167776572274, 0.6178762444026438,
    0.755404408355003, 0.8656312023878318, 0.9445750230732326, 0.9894009349916499];
const GL_W = [0.1894506104550685, 0.18260341504492358, 0.16915651939500254, 0.14959598881657674,
    0.12462897125553388, 0.09515851168249279, 0.062253523938647894, 0.027152459411754096];
const PANELS = [[0, 0.01], [0.01, 0.04], [0.04, 0.09], [0.09, 0.16], [0.16, 0.30], [0.30, 0.45], [0.45, 0.70], [0.70, 1.0]];
const U2 = new Float64Array(128);
const WU2 = new Float64Array(128);
PANELS.forEach(([u0, u1], panel) => {
    const mid = 0.5 * (u0 + u1);
    const half = 0.5 * (u1 - u0);
    for (let k = 0; k < 8; k++) {
        const w = GL_W[k] * half;
        const dx = half * GL_X[k];
        const ua = mid - dx;
        const ub = mid + dx;
        const i = panel * 16 + k * 2;
        U2[i] = ua * ua;
        WU2[i] = 2 * w * ua;
        U2[i + 1] = ub * ub;
        WU2[i + 1] = 2 * w * ub;
    }
});

const TABLE_RADII = 64;
const TABLE_ANGLES = 65;

function solveMonotone(lo, hi, fLo, fHi, target, f) {
    let a = lo;
    let b = hi;
    let fa = fLo - target;
    let fb = fHi - target;
    if (Math.abs(fa) < 1e-12) return a;
    if (Math.abs(fb) < 1e-12) return b;
    if (Math.sign(fa) === Math.sign(fb)) return Math.abs(fa) <= Math.abs(fb) ? a : b;
    let c = a;
    let fc = fa;
    let d = b - a;
    let e = d;
    for (let step = 0; step < 48; step++) {
        if (fb === 0) break;
        if (Math.sign(fc) === Math.sign(fb)) { c = a; fc = fa; d = b - a; e = d; }
        if (Math.abs(fc) < Math.abs(fb)) { a = b; b = c; c = a; fa = fb; fb = fc; fc = fa; }
        const tol = 2 * 1e-12 * Math.max(Math.abs(b), 1);
        const m = 0.5 * (c - b);
        if (Math.abs(m) <= tol || fb === 0) break;
        if (Math.abs(e) >= tol && Math.abs(fa) > Math.abs(fb)) {
            const s = fb / fa;
            let p;
            let q;
            if (Math.abs(a - c) < 1e-15) {
                p = 2 * m * s;
                q = 1 - s;
            } else {
                const q0 = fa / fc;
                const r = fb / fc;
                p = s * (2 * m * q0 * (q0 - r) - (b - a) * (r - 1));
                q = (q0 - 1) * (r - 1) * (s - 1);
            }
            if (p > 0) q = -q; else p = -p;
            if (2 * p < Math.min(3 * m * q - Math.abs(tol * q), Math.abs(e * q))) { e = d; d = p / q; } else { d = m; e = m; }
        } else {
            d = m;
            e = m;
        }
        a = b;
        fa = fb;
        b += Math.abs(d) > tol ? d : (m < 0 ? -tol : tol);
        fb = f(b) - target;
    }
    return b;
}

/**
 * @param {{profileKind:number, profile:number[], config:object}} index 快照里的剖面与参数
 * @returns 距离函数集合；剖面不是“带管腰的 Softening”时返回 { supported:false, reason }
 */
function createGeometry(index) {
    const alpha = index.profile[0];
    const phi0 = index.config.throatPhi0;
    const kappa = index.config.angularScaleKappa;
    const identityCosine = index.config.angularTau === 0 && index.config.angularEta === 1;
    if (index.profileKind !== 1 || !(phi0 > 0) || !identityCosine) {
        return { supported: false, reason: '这份快照的几何剖面不是本工具支持的那一种（带管腰的 Softening），不显示距离。' };
    }
    const phi = r => kappa * (phi0 + r + alpha * r * r * r);
    const base = phi(0);
    function quad(a, b, momentum, angle) {
        const span = b - a;
        if (span <= 0) return 0;
        const pa = phi(a);
        let sum = 0;
        for (let i = 0; i < 128; i++) {
            const delta = span * U2[i];
            const r = a + delta;
            const p = phi(r);
            const increment = kappa * delta * (1 + alpha * (r * r + r * a + a * a));
            const root = Math.sqrt(Math.max(Math.max(increment + (pa - momentum), 0) * (p + momentum), 1e-30));
            sum += WU2[i] * (angle ? 1 / (p * root) : p / root);
        }
        return sum * span;
    }
    const sweep = (a, b, momentum) => quad(a, b, momentum, true) * momentum;
    const length = (a, b, momentum) => quad(a, b, momentum, false);
    /** 从半径 r 贴着管腰切线下去：扫过的角度和走过的长度。只和 r 有关，可以按节点预先算好。 */
    const leg = r => ({ angle: sweep(0, r, base), length: length(0, r, base) });

    /** 与上游 throat_distance_with 相同的三段：单调、折返、贴管腰。theta 为两方向的夹角（弧度）。 */
    function distance(rq, rv, theta, legQ = null, legV = null) {
        if (theta === 0) return Math.abs(rq - rv);
        const lo = Math.min(rq, rv);
        const hi = Math.max(rq, rv);
        const a = legQ || leg(rq);
        const b = legV || leg(rv);
        const maximum = a.angle + b.angle;
        // 贴管腰段：上游先判单调段，但单调段的上限角小于 maximum，所以 theta ≥ maximum 时可以直接走这里。
        if (theta >= maximum) return a.length + b.length + base * (theta - maximum);
        const lmax = phi(lo);
        const critical = sweep(lo, hi, lmax);
        if (theta <= critical && hi > lo) {
            const l = solveMonotone(0, lmax, 0, critical, theta, x => sweep(lo, hi, x));
            return length(lo, hi, l);
        }
        const turn = solveMonotone(0, lo, maximum, critical, theta, r => {
            if (r === 0) return maximum;
            const l = phi(r);
            return sweep(r, lo, l) + sweep(r, hi, l);
        });
        const l = phi(turn);
        return length(turn, lo, l) + length(turn, hi, l);
    }

    function regime(rq, rv, theta, legQ = null, legV = null) {
        const a = legQ || leg(rq);
        const b = legV || leg(rv);
        if (theta >= a.angle + b.angle) return 'throat';
        const lo = Math.min(rq, rv);
        const hi = Math.max(rq, rv);
        return theta <= sweep(lo, hi, phi(lo)) && hi > lo ? 'monotone' : 'dip';
    }

    /** 等距离线：给定查询半径和距离，在每个节点半径上解出夹角。距离随夹角单调增，二分即可。 */
    function contour(rq, level, radii) {
        const legQ = leg(rq);
        return radii.map(r => {
            const legV = leg(r);
            if (distance(rq, r, 0, legQ, legV) >= level) return null;
            if (distance(rq, r, Math.PI, legQ, legV) <= level) return null;
            let lo = 0;
            let hi = Math.PI;
            for (let i = 0; i < 48; i++) {
                const mid = 0.5 * (lo + hi);
                if (distance(rq, r, mid, legQ, legV) < level) lo = mid; else hi = mid;
            }
            return 0.5 * (lo + hi);
        });
    }

    /** 用快照自带的距离表核对：表里存的是 f32(max(d² − (ri−rj)², 0))，由上游 Rust 算出。 */
    function selfCheck(table, radiusMax) {
        if (table.length !== TABLE_RADII * TABLE_RADII * TABLE_ANGLES) {
            return { ok: false, compared: 0, identical: 0, maxDifference: null, reason: '距离表大小不对。' };
        }
        const stepR = radiusMax / (TABLE_RADII - 1);
        const stepU = 1 / (TABLE_ANGLES - 1);
        const legs = Array.from({ length: TABLE_RADII }, (_, i) => leg(i * stepR));
        let compared = 0;
        let identical = 0;
        let maxDifference = 0;
        for (let i = 0; i < TABLE_RADII; i++) {
            for (let j = i; j < TABLE_RADII; j++) {
                const ri = i * stepR;
                const rj = j * stepR;
                const radial = (ri - rj) * (ri - rj);
                for (let k = 0; k < TABLE_ANGLES; k++) {
                    const cosine = Math.min(1, Math.max(-1, 1 - 2 * (k * stepU)));
                    const d = distance(ri, rj, Math.acos(cosine), legs[i], legs[j]);
                    const mine = Math.fround(Math.max(d * d - radial, 0));
                    const theirs = table[(i * TABLE_RADII + j) * TABLE_ANGLES + k];
                    compared++;
                    if (mine === theirs) identical++;
                    else maxDifference = Math.max(maxDifference, Math.abs(mine - theirs));
                }
            }
        }
        return { ok: identical === compared, compared, identical, maxDifference };
    }

    return { supported: true, alpha, phi0, kappa, base, phi, leg, distance, regime, contour, selfCheck };
}

module.exports = { createGeometry };
