//! Adapted from Pelorus 98136b2, Apache-2.0.
//! Copyright 2024 TriviumDB Authors (https://github.com/YoKONCy).
//! Numerical reference and bounded-domain interpolation, NOT conservative bounds.
use rayon::prelude::*;

/// 球对称翘曲乘积流形径向缩放剖面 φ(R)。
///
/// Original profiles have a regular collapsed origin. ThroatSoftening instead
/// defines a manifold with boundary when phi0>0, or a metric cone when kappa!=1.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum WarpedProfile {
    /// 常负曲率特例 φ(R) = sinh(sqrt(c)*R)/sqrt(c)，专用于验证 Clairaut 数值求积与闭式解一致。
    ConstantHyperbolic { curvature: f64 },
    /// 外层逐渐变平（核心强双曲、外围渐平）：φ(R) = R + α R^3，K_rad(R) = -6α / (1 + α R^2)
    Softening { alpha: f64 },
    /// 外层曲率逐渐变陡（双曲喇叭型）：φ(R) = R exp(α R^2)，K_rad(R) = -(6α + 4α^2 R^2)
    Steepening { alpha: f64 },
    /// Intrinsic length metric on [0,infinity) x S^(D-1), including boundary
    /// arcs at R=0 when phi0>0. If phi0=0 the boundary sphere collapses.
    ThroatSoftening { alpha: f64, phi0: f64, kappa: f64 },
}

impl WarpedProfile {
    #[inline]
    pub fn phi(self, r: f64) -> f64 {
        match self {
            Self::ConstantHyperbolic { curvature } => {
                let s = curvature.sqrt();
                (s * r).sinh() / s
            }
            Self::Softening { alpha } => r + alpha * r * r * r,
            Self::Steepening { alpha } => r * (alpha * r * r).exp(),
            Self::ThroatSoftening { alpha, phi0, kappa } =>
                kappa * (phi0 + r + alpha*r*r*r),
        }
    }

    #[inline]
    pub fn radial_curvature(self, r: f64) -> f64 {
        match self {
            Self::ConstantHyperbolic { curvature } => -curvature,
            Self::Softening { alpha } => -6.0 * alpha / (1.0 + alpha * r * r),
            Self::Steepening { alpha } => -(6.0 * alpha + 4.0 * alpha * alpha * r * r),
            Self::ThroatSoftening { alpha, phi0, .. } =>
                if r == 0.0 && phi0 == 0.0 { -6.0*alpha }
                else { -6.0*alpha*r/(phi0+r+alpha*r*r*r) },
        }
    }
}

/// 16 点 Gauss-Legendre 求积节点与权重（在 [0, 1] 上的对称半区间缩放至 [-1, 1]）。
const GL_X: [f64; 8] = [
    0.09501250983763744,
    0.2816035507792589,
    0.4580167776572274,
    0.6178762444026438,
    0.755404408355003,
    0.8656312023878318,
    0.9445750230732326,
    0.9894009349916499,
];
const GL_W: [f64; 8] = [
    0.1894506104550685,
    0.18260341504492358,
    0.16915651939500254,
    0.14959598881657674,
    0.12462897125553388,
    0.09515851168249279,
    0.062253523938647894,
    0.027152459411754096,
];

const PANELS: [(f64, f64); 8] = [
    (0.0, 0.01), (0.01, 0.04), (0.04, 0.09), (0.09, 0.16),
    (0.16, 0.30), (0.30, 0.45), (0.45, 0.70), (0.70, 1.0),
];
const QUAD_POINTS: usize = PANELS.len() * 16;

const fn build_clairaut_quad_table() -> ([f64; QUAD_POINTS], [f64; QUAD_POINTS]) {
    let mut u2 = [0.0f64; QUAD_POINTS];
    let mut wu2 = [0.0f64; QUAD_POINTS];
    let mut pi = 0usize;
    while pi < PANELS.len() {
        let (u0, u1) = PANELS[pi];
        let mid = 0.5 * (u0 + u1);
        let half = 0.5 * (u1 - u0);
        let mut k = 0usize;
        while k < 8 {
            let w = GL_W[k] * half;
            let dx = half * GL_X[k];
            let ua = mid - dx;
            let ub = mid + dx;
            let idx0 = pi * 16 + k * 2;
            u2[idx0] = ua * ua;
            wu2[idx0] = 2.0 * w * ua;
            u2[idx0 + 1] = ub * ub;
            wu2[idx0 + 1] = 2.0 * w * ub;
            k += 1;
        }
        pi += 1;
    }
    (u2, wu2)
}

const CLAIRAUT_QUAD: ([f64; QUAD_POINTS], [f64; QUAD_POINTS]) = build_clairaut_quad_table();

#[inline(always)]
fn clairaut_quad<F>(profile: WarpedProfile, a: f64, b: f64, ang_mom: f64, integrand: F) -> f64
where
    F: Fn(f64, f64) -> f64,
{
    let span = b - a;
    if span <= 0.0 {
        return 0.0;
    }
    let pa = profile.phi(a);
    let (u2_tbl, wu2_tbl) = &CLAIRAUT_QUAD;
    let mut sum = 0.0f64;
    for i in 0..QUAD_POINTS {
        let delta = span * u2_tbl[i];
        let r = a + delta;
        let p = profile.phi(r);
        let increment = match profile {
            WarpedProfile::ConstantHyperbolic { curvature } => {
                let s = curvature.sqrt();
                2.0 * (s * delta * 0.5).sinh() * (s * (r + a) * 0.5).cosh() / s
            }
            WarpedProfile::Softening { alpha } =>
                delta * (1.0 + alpha * (r*r + r*a + a*a)),
            WarpedProfile::Steepening { alpha } =>
                (alpha*a*a).exp() * (delta + r * (alpha*delta*(r+a)).exp_m1()),
            WarpedProfile::ThroatSoftening { alpha, kappa, .. } =>
                kappa * delta * (1.0 + alpha*(r*r+r*a+a*a)),
        };
        let root = ((increment + (pa - ang_mom)).max(0.0) * (p + ang_mom)).max(1e-30).sqrt();
        sum += wu2_tbl[i] * integrand(p, root);
    }
    sum * span
}

/// 仅计算角度积分项 Δθ（供 Brent 求根迭代内部调用，省去 30% 弧长浮点开销）。
#[inline]
fn clairaut_theta(profile: WarpedProfile, a: f64, b: f64, ang_mom: f64) -> f64 {
    clairaut_quad(profile, a, b, ang_mom, |p, root| 1.0 / (p * root)) * ang_mom
}

/// 仅计算测地弧长积分项（仅在根收敛后计算一次）。
#[inline]
fn clairaut_length(profile: WarpedProfile, a: f64, b: f64, ang_mom: f64) -> f64 {
    clairaut_quad(profile, a, b, ang_mom, |p, root| p / root)
}

/// 分段标量 Brent / 保护二分求根器：求解单调函数 f(x) = target 在 [lo, hi] 上的根。
fn solve_monotone<F>(lo: f64, hi: f64, f_lo: f64, f_hi: f64, target: f64, f: F) -> f64
where
    F: Fn(f64) -> f64,
{
    let mut a = lo;
    let mut b = hi;
    let mut fa = f_lo - target;
    let mut fb = f_hi - target;
    if fa.abs() < 1e-12 {
        return a;
    }
    if fb.abs() < 1e-12 {
        return b;
    }
    if fa.signum() == fb.signum() {
        return if fa.abs() <= fb.abs() { a } else { b };
    }
    let mut c = a;
    let mut fc = fa;
    let mut d = b - a;
    let mut e = d;
    for _ in 0..48 {
        if fb == 0.0 {
            break;
        }
        if fc.signum() == fb.signum() {
            c = a;
            fc = fa;
            d = b - a;
            e = d;
        }
        if fc.abs() < fb.abs() {
            a = b;
            b = c;
            c = a;
            fa = fb;
            fb = fc;
            fc = fa;
        }
        // Root tolerance; not a global quadrature-error guarantee.
        let tol = 2.0 * 1e-12 * b.abs().max(1.0);
        let m = 0.5 * (c - b);
        if m.abs() <= tol || fb == 0.0 {
            break;
        }
        if e.abs() >= tol && fa.abs() > fb.abs() {
            let s = fb / fa;
            let (mut p, mut q) = if (a - c).abs() < 1e-15 {
                (2.0 * m * s, 1.0 - s)
            } else {
                let q0 = fa / fc;
                let r = fb / fc;
                (
                    s * (2.0 * m * q0 * (q0 - r) - (b - a) * (r - 1.0)),
                    (q0 - 1.0) * (r - 1.0) * (s - 1.0),
                )
            };
            if p > 0.0 {
                q = -q;
            } else {
                p = -p;
            }
            if 2.0 * p < (3.0 * m * q - (tol * q).abs()).min((e * q).abs()) {
                e = d;
                d = p / q;
            } else {
                d = m;
                e = m;
            }
        } else {
            d = m;
            e = m;
        }
        a = b;
        fa = fb;
        b += if d.abs() > tol { d } else { tol.copysign(m) };
        fb = f(b) - target;
    }
    b
}

/// 利用 Clairaut 守恒积分计算径向变曲率翘曲乘积流形的精确黎曼测地距离。
pub fn clairaut_distance(profile: WarpedProfile, rq: f64, rv: f64, cos_theta: f64) -> f64 {
    if matches!(profile, WarpedProfile::ThroatSoftening { .. }) {
        return throat_distance(profile, rq, rv, cos_theta);
    }
    if rq <= 1e-12 {
        return rv.max(0.0);
    }
    if rv <= 1e-12 {
        return rq.max(0.0);
    }
    let cos_c = cos_theta.clamp(-1.0, 1.0);
    if cos_c >= 1.0 - 1e-14 {
        return (rq - rv).abs();
    }
    if cos_c <= -1.0 + 1e-14 {
        return rq + rv;
    }
    let theta = cos_c.acos();
    let (r_lo, r_hi) = if rq <= rv { (rq, rv) } else { (rv, rq) };
    let l_max = profile.phi(r_lo);

    // 单调分支最大角度（当 r_lo < r_hi 时从 r_lo 出发直达 r_hi）
    let theta_crit = if r_hi > r_lo + 1e-13 {
        clairaut_theta(profile, r_lo, r_hi, l_max)
    } else {
        0.0
    };

    if theta <= theta_crit && r_hi > r_lo + 1e-13 {
        // Case 1: 径向单调上升段 L ∈ [0, phi(r_lo)]
        let eval_theta = |ang_mom: f64| clairaut_theta(profile, r_lo, r_hi, ang_mom);
        let l_star = solve_monotone(0.0, l_max, 0.0, theta_crit, theta, eval_theta);
        return clairaut_length(profile, r_lo, r_hi, l_star);
    }

    // Case 2: 测地线先向内折返到近日点 r_* ∈ [0, r_lo]，再向外爬升经过 r_lo 至 r_hi
    if (theta - theta_crit).abs() <= 1e-14 {
        return clairaut_length(profile, r_lo, r_hi, l_max);
    }
    let eval_dip_theta = |r_turn: f64| -> f64 {
        if r_turn <= 1e-13 {
            return std::f64::consts::PI;
        }
        let l = profile.phi(r_turn);
        // Both legs start at the turning point, so the squared substitution
        // regularizes both endpoint singularities, including near-critical dips.
        clairaut_theta(profile, r_turn, r_lo, l)
            + clairaut_theta(profile, r_turn, r_hi, l)
    };
    let r_star = solve_monotone(
        0.0,
        r_lo,
        std::f64::consts::PI,
        theta_crit,
        theta,
        eval_dip_theta,
    );
    let l = profile.phi(r_star);
    clairaut_length(profile, r_star, r_lo, l)
        + clairaut_length(profile, r_star, r_hi, l)
}

/// Numerical length metric with an explicit reflecting obstacle boundary.
/// Positive throat: tangent legs may be joined by a nonzero boundary arc.
/// Zero throat and kappa!=1: a metric cone, NOT a smooth Euclidean origin.
fn throat_distance(profile: WarpedProfile, rq: f64, rv: f64, cosine: f64) -> f64 {
    throat_distance_with(profile, rq, rv, cosine, None)
}

/// Pair invariants for the table builder only. Online scoring computes the
/// same quantities on demand, including the original endpoint early exits.
struct ThroatGridPair {
    critical: f64,
    maximum: f64,
    leg_length_sum: f64,
}

impl ThroatGridPair {
    /// The table visits only i <= j, using the exact same radii as its distance inputs.
    fn new(profile: WarpedProfile, lo: f64, hi: f64, a: (f64, f64), b: (f64, f64)) -> Self {
        Self {
            critical: clairaut_theta(profile, lo, hi, profile.phi(lo)),
            maximum: a.0 + b.0,
            leg_length_sum: a.1 + b.1,
        }
    }
}

fn throat_distance_with(
    profile: WarpedProfile, rq: f64, rv: f64, cosine: f64, pair: Option<&ThroatGridPair>,
) -> f64 {
    let theta = cosine.clamp(-1.0, 1.0).acos();
    if theta == 0.0 { return (rq-rv).abs(); }
    let (lo, hi) = (rq.min(rv), rq.max(rv));
    let base = profile.phi(0.0);
    if base == 0.0 && lo == 0.0 { return hi; }
    let lmax = profile.phi(lo);
    let critical = pair.map_or_else(|| clairaut_theta(profile, lo, hi, lmax), |p| p.critical);
    if theta <= critical && hi > lo {
        let l = solve_monotone(0.0,lmax,0.0,critical,theta,
            |l|clairaut_theta(profile,lo,hi,l));
        return clairaut_length(profile,lo,hi,l);
    }
    let maximum = pair.map_or_else(|| {
        if base > 0.0 {
            clairaut_theta(profile,0.0,lo,base)+clairaut_theta(profile,0.0,hi,base)
        } else {
            match profile {
                WarpedProfile::ThroatSoftening { kappa, .. } => std::f64::consts::PI/kappa,
                _ => unreachable!(),
            }
        }
    }, |p| p.maximum);
    if theta >= maximum {
        if base == 0.0 { return rq+rv; }
        let leg_length_sum = pair.map_or_else(|| {
            clairaut_length(profile,0.0,lo,base)+clairaut_length(profile,0.0,hi,base)
        }, |p| p.leg_length_sum);
        return leg_length_sum+base*(theta-maximum);
    }
    let turn = solve_monotone(0.0,lo,maximum,critical,theta,|r| {
        if r == 0.0 { return maximum; }
        let l=profile.phi(r);
        clairaut_theta(profile,r,lo,l)+clairaut_theta(profile,r,hi,l)
    });
    let l=profile.phi(turn);
    clairaut_length(profile,turn,lo,l)+clairaut_length(profile,turn,hi,l)
}

/// Metric comparison: nonnegative cubic softening dominates the linear throat.
/// This is not an interpolated-table envelope. The floating-point retreat is
/// conservative engineering protection, not certified quadrature error analysis.
pub fn clairaut_lower_bound(profile: WarpedProfile, rq:f64, rv:f64, cosine:f64) -> f64 {
    if !rq.is_finite() || !rv.is_finite() || rq<0.0 || rv<0.0 || !cosine.is_finite() {
        return 0.0;
    }
    // Legacy Brent endpoint tolerance can collapse extremely near-aligned
    // equal-radius distances to zero. Disable pruning in that unresolved region
    // rather than changing the historical numerical target.
    if cosine>=1.0-1e-8 { return 0.0; }
    let radial=(rq-rv).abs();
    let raw=match profile {
        WarpedProfile::ThroatSoftening {alpha,phi0,kappa}
            if alpha>=0.0 && phi0>=0.0 && kappa>0.0 => {
            let theta=cosine.clamp(-1.0,1.0).acos();
            let angle=kappa*theta;
            let (x,y)=(rq+phi0,rv+phi0);
            let critical=if phi0==0.0 {std::f64::consts::PI} else {
                (phi0/x).clamp(0.0,1.0).acos()+(phi0/y).clamp(0.0,1.0).acos()
            };
            let linear=if angle<=critical {
                (radial*radial+4.0*x*y*(angle*0.5).sin().powi(2)).sqrt()
            } else {
                ((x-phi0)*(x+phi0)).max(0.0).sqrt()
                    +((y-phi0)*(y+phi0)).max(0.0).sqrt()
                    +phi0*(angle-critical)
            };
            let cylinder=(radial*radial+(kappa*phi0*theta).powi(2)).sqrt();
            linear.max(cylinder)
        },
        _ => radial,
    };
    let path_scale=1.0+raw.abs()+rq+rv
        +profile.phi(rq).abs()+profile.phi(rv).abs();
    let machine_guard=128.0*f64::EPSILON*path_scale;
    // Keep the historical quadrature retreat as well as the scale-aware
    // arithmetic guard: machine epsilon alone does not bound Brent/quadrature.
    let numerical_guard=1e-7*(1.0+raw+rq+rv);
    if raw.is_finite() && machine_guard.is_finite() {
        (raw-numerical_guard-machine_guard).max(0.0)
    } else {0.0}
}

#[cfg(test)]
mod envelope_tests {
    use super::*;
    #[test]
    fn hundred_thousand_full_dimension_boundary_pairs_have_zero_false_negatives() {
        let mut pairs=0usize;
        for dim in [65,384,768,1536,3072] {
            let q:Vec<f64>=(0..dim).map(|j|((j*17+3) as f64*0.013).sin()).collect();
            let axis:Vec<f64>=(0..dim).map(|j|((j*7+11) as f64*0.031).cos()).collect();
            let qn=q.iter().map(|x|x*x).sum::<f64>().sqrt();
            let dot=q.iter().zip(&axis).map(|(a,b)|a*b).sum::<f64>()/(qn*qn);
            let mut ortho:Vec<_>=axis.iter().zip(&q).map(|(a,b)|a-dot*b).collect();
            let on=ortho.iter().map(|x|x*x).sum::<f64>().sqrt();
            for x in &mut ortho {*x/=on;}
            for i in 0..20_000 {
                let theta=match i%5 {
                    0=>1e-12*(1+i%17) as f64,
                    1=>std::f64::consts::PI-1e-10*(1+i%13) as f64,
                    _=>std::f64::consts::PI*((i*7919%20000) as f64)/20000.,
                };
                let (s,c)=theta.sin_cos();
                let mut dp=0.;let mut vv=0.;
                for j in 0..dim {
                    let a=q[j]/qn;
                    let b=c*a+s*ortho[j];
                    dp+=a*b;vv+=b*b;
                }
                let cosine=dp/vv.sqrt();
                let rq=match i%7 {0=>0.,1=>1e-10,_=>0.35+(i%301) as f64*0.001};
                let rv=if i%11==0 {rq} else {0.35+(i*37%301) as f64*0.001};
                let profile=WarpedProfile::ThroatSoftening {
                    alpha:[0.,0.15,2.,32.][i%4],
                    phi0:[0.,0.8,1.5,16.][i/4%4],
                    kappa:[0.01,0.5,1.,2.][i/16%4],
                };
                profile.validate(0.65).unwrap();
                let lower=clairaut_lower_bound(profile,rq,rv,cosine);
                let exact=clairaut_distance(profile,rq,rv,cosine);
                assert!(lower.is_finite() && exact.is_finite() && lower<=exact,
                    "dim={dim} i={i} lower={lower} exact={exact} p={profile:?} rq={rq} rv={rv} c={cosine}");
                pairs+=1;
            }
        }
        assert_eq!(pairs,100_000);
    }

    #[test]
    fn analytic_comparison_never_exceeds_numerical_reference_on_boundary_grid() {
        for alpha in [0.0,0.15,0.35,2.0] {
            for phi0 in [0.0,0.8,1.5] {
                for kappa in [0.5,1.0,2.0] {
                    let p=WarpedProfile::ThroatSoftening {alpha,phi0,kappa};
                    for a in [0.0,1e-10,0.35,0.425,0.65,1.2] {
                        for b in [0.0,0.35,0.5,0.65,1.2] {
                            for c in [-1.0,-0.8,0.0,0.6,0.99,1.0-1e-14,1.0] {
                                let lb=clairaut_lower_bound(p,a,b,c);
                                let exact=clairaut_distance(p,a,b,c);
                                assert!(lb>=0.0 && lb<=exact,
                                    "a={a} b={b} c={c} lb={lb} exact={exact} p={p:?}");
                            }
                        }
                    }
                }
            }
        }
    }
}
/// 离线为特定 φ(R) 预校准的二维/三维径向-半正矢角表结构（驻留 L2/L1，彻底消除束搜索内的积分）。
///
/// 在横轴 `u = (1 - cos_theta) * 0.5 = sin^2(theta/2)` 上采样（近角区呈线性行为且热路径零开方）。
pub struct WarpedProxyTable {
    nr: usize,
    ns: usize,
    r_max: f64,
    inv_dr: f64,
    data: Vec<f32>,
}

/// 单条查询按给定 `R_q` 切出的 1D-径向 × 半正矢角 L1 常驻切片（~16 KB）。
pub struct QueryWarpedSlice {
    nr: usize,
    ns: usize,
    inv_dr: f32,
    r_max: f32,
    q_r: f32,
    slice: Vec<f32>,
}

fn prepare_throat_grid_legs(
    profile: WarpedProfile, step_r: f64, nr: usize,
) -> Vec<(f64, f64)> {
    let base = profile.phi(0.0);
    (0..nr).map(|i| {
        let r = i as f64 * step_r;
        (clairaut_theta(profile, 0.0, r, base), clairaut_length(profile, 0.0, r, base))
    }).collect()
}

impl WarpedProxyTable {
    pub fn build(profile: WarpedProfile, r_max: f64, nr: usize, ns: usize) -> Self {
        let reuse_throat_grid = matches!(profile, WarpedProfile::ThroatSoftening {
            alpha: 0.15, phi0: 1.5, kappa: 2.0
        }) && r_max == 0.65 && nr == 64 && ns == 65;
        Self::build_impl(profile, r_max, nr, ns, reuse_throat_grid)
    }

    pub(super) fn build_impl(profile: WarpedProfile, r_max: f64, nr: usize, ns: usize,
        reuse_throat_grid: bool) -> Self {
        let r_max = r_max.max(0.1);
        let mut pairs = Vec::with_capacity(nr * (nr + 1) / 2);
        for i in 0..nr {
            for j in i..nr {
                pairs.push((i, j));
            }
        }
        let step_r = r_max / ((nr - 1) as f64);
        let step_u = 1.0 / ((ns - 1) as f64);
        let legs = reuse_throat_grid.then(|| prepare_throat_grid_legs(profile, step_r, nr));
        let computed: Vec<(usize, usize, Vec<f32>)> = pairs
            .into_par_iter()
            .map(|(i, j)| {
                let ri = i as f64 * step_r;
                let rj = j as f64 * step_r;
                let radial_sq = (ri - rj) * (ri - rj);
                let pair = legs.as_ref().map(|legs| ThroatGridPair::new(profile, ri, rj, legs[i], legs[j]));
                let mut row = Vec::with_capacity(ns);
                for k in 0..ns {
                    let u = k as f64 * step_u;
                    let cos_t = (1.0 - 2.0 * u).clamp(-1.0, 1.0);
                    let d = match &pair {
                        Some(pair) => throat_distance_with(profile, ri, rj, cos_t, Some(pair)),
                        None => clairaut_distance(profile, ri, rj, cos_t),
                    };
                    row.push((d * d - radial_sq).max(0.0) as f32);
                }
                (i, j, row)
            })
            .collect();

        let mut data = vec![0.0f32; nr * nr * ns];
        for (i, j, row) in computed {
            let off_ij = (i * nr + j) * ns;
            let off_ji = (j * nr + i) * ns;
            data[off_ij..off_ij + ns].copy_from_slice(&row);
            data[off_ji..off_ji + ns].copy_from_slice(&row);
        }
        Self {
            nr,
            ns,
            r_max,
            inv_dr: ((nr - 1) as f64) / r_max,
            data,
        }
    }

    #[inline]
    pub fn eval(&self, rq: f64, rv: f64, cos_hat: f64) -> f64 {
        let u = ((1.0 - cos_hat) * 0.5).clamp(0.0, 1.0);
        let qi = (rq * self.inv_dr).clamp(0.0, (self.nr - 1) as f64);
        let vi = (rv * self.inv_dr).clamp(0.0, (self.nr - 1) as f64);
        let si = (u * ((self.ns - 1) as f64)).clamp(0.0, (self.ns - 1) as f64);
        let i0 = (qi.floor() as usize).min(self.nr - 2);
        let j0 = (vi.floor() as usize).min(self.nr - 2);
        let k0 = (si.floor() as usize).min(self.ns - 2);
        let fq = qi - i0 as f64;
        let fv = vi - j0 as f64;
        let fs = si - k0 as f64;

        let get = |ii: usize, jj: usize, kk: usize| -> f64 {
            f64::from(self.data[(ii * self.nr + jj) * self.ns + kk])
        };
        let interp_s = |ii: usize, jj: usize| -> f64 {
            let c0 = get(ii, jj, k0);
            let c1 = get(ii, jj, k0 + 1);
            c0 + fs * (c1 - c0)
        };
        let a00 = interp_s(i0, j0);
        let a01 = interp_s(i0, j0 + 1);
        let a10 = interp_s(i0 + 1, j0);
        let a11 = interp_s(i0 + 1, j0 + 1);
        let a0 = a00 + fv * (a01 - a00);
        let a1 = a10 + fv * (a11 - a10);
        let ang_excess = (a0 + fq * (a1 - a0)).max(0.0);
        let dr = rq - rv;
        dr * dr + ang_excess
    }

    /// 每次查询开始前沿 `R_q` 切出一段仅 `nr * ns` 项（~16 KB）的紧凑 L1 切片。
    pub fn slice_for_query(&self, rq: f64) -> QueryWarpedSlice {
        let qi = (rq * self.inv_dr).clamp(0.0, (self.nr - 1) as f64);
        let i0 = (qi.floor() as usize).min(self.nr - 2);
        let fq = (qi - i0 as f64) as f32;
        let row0 = &self.data[i0 * self.nr * self.ns..(i0 + 1) * self.nr * self.ns];
        let row1 = &self.data[(i0 + 1) * self.nr * self.ns..(i0 + 2) * self.nr * self.ns];
        let mut slice = Vec::with_capacity(self.nr * self.ns);
        for (&a, &b) in row0.iter().zip(row1.iter()) {
            slice.push(a + fq * (b - a));
        }
        QueryWarpedSlice {
            nr: self.nr,
            ns: self.ns,
            inv_dr: self.inv_dr as f32,
            r_max: self.r_max as f32,
            q_r: rq as f32,
            slice,
        }
    }
}

impl QueryWarpedSlice {
    #[inline]
    pub fn eval(&self, rv: f32, cos_hat: f64) -> f64 {
        let u = (((1.0 - cos_hat) * 0.5).clamp(0.0, 1.0)) as f32;
        let vi = (rv.clamp(0.0, self.r_max) * self.inv_dr).min((self.nr - 1) as f32);
        let si = (u * ((self.ns - 1) as f32)).min((self.ns - 1) as f32);
        let j0 = (vi.floor() as usize).min(self.nr - 2);
        let k0 = (si.floor() as usize).min(self.ns - 2);
        let fv = vi - j0 as f32;
        let fs = si - k0 as f32;

        let b0 = j0 * self.ns + k0;
        let b1 = (j0 + 1) * self.ns + k0;
        // SAFETY：j0 <= nr-2, k0 <= ns-2 均严格保证在 slice 边界内
        let (v00, v01, v10, v11) = unsafe {
            (
                *self.slice.get_unchecked(b0),
                *self.slice.get_unchecked(b0 + 1),
                *self.slice.get_unchecked(b1),
                *self.slice.get_unchecked(b1 + 1),
            )
        };
        let a0 = v00 + fs * (v01 - v00);
        let a1 = v10 + fs * (v11 - v10);
        let ang_excess = f64::from((a0 + fv * (a1 - a0)).max(0.0));
        let dr = f64::from(self.q_r - rv);
        dr * dr + ang_excess
    }
}



impl WarpedProfile {
    /// Restricted experimental domain; prevents overflow in quadrature and tables.
    pub fn validate(self, max_radius: f64) -> std::io::Result<()> {
        let valid = match self {
            Self::ConstantHyperbolic { curvature } => curvature.is_finite() && curvature > 0.0
                && curvature.sqrt() * max_radius <= 16.0,
            Self::Softening { alpha } | Self::Steepening { alpha } =>
                alpha.is_finite() && alpha >= 0.0 && alpha * max_radius * max_radius <= 32.0,
            Self::ThroatSoftening { alpha, phi0, kappa } =>
                alpha.is_finite() && alpha >= 0.0 && alpha*max_radius*max_radius <= 32.0
                && phi0.is_finite() && (0.0..=16.0).contains(&phi0)
                && kappa.is_finite() && kappa > 0.0 && kappa <= 2.0,
        };
        if !valid || !max_radius.is_finite() || max_radius <= 0.0 || max_radius > 16.0 {
            return Err(super::invalid("invalid warped profile or radius support"));
        }
        Ok(())
    }
}

impl WarpedProxyTable {
    pub fn try_build(profile: WarpedProfile, r_max: f64, nr: usize, ns: usize) -> std::io::Result<Self> {
        profile.validate(r_max)?;
        if !(2..=256).contains(&nr) || !(2..=257).contains(&ns) {
            return Err(super::invalid("invalid warped table resolution"));
        }
        Ok(Self::build(profile, r_max, nr, ns))
    }
    pub(super) fn snapshot_data(&self) -> &[f32] { &self.data }
    pub(super) fn from_snapshot(r_max: f64, data: Vec<f32>) -> std::io::Result<Self> {
        if !r_max.is_finite() || r_max <= 0.0 || r_max > 16.0
            || data.len() != 64 * 64 * 65
            || data.iter().any(|x| !x.is_finite() || *x < 0.0) {
            return Err(super::invalid("invalid warped table snapshot"));
        }
        Ok(Self { nr:64, ns:65, r_max, inv_dr:63.0/r_max, data })
    }
    pub fn hot_bytes(&self) -> usize { self.data.capacity() * std::mem::size_of::<f32>() }
    pub fn checked_slice(&self, radius: f64) -> std::io::Result<QueryWarpedSlice> {
        if !radius.is_finite() || radius < 0.0 || radius > self.r_max {
            return Err(super::invalid("warped query outside table support"));
        }
        Ok(self.slice_for_query(radius))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn throat_matches_independent_exterior_disk_and_scaled_cone() {
        for phi0 in [0.0_f64,0.8,1.5] {
            for kappa in [0.5_f64,0.75,1.0,1.5,2.0] {
                let profile=WarpedProfile::ThroatSoftening {alpha:0.0,phi0,kappa};
                for a in [0.0_f64,0.01,0.35,0.65,1.2] {
                    for b in [0.0_f64,0.02,0.35,0.9,1.2] {
                        for i in 0..=32 {
                            let theta=std::f64::consts::PI*i as f64/32.0;
                            let angle=kappa*theta;
                            let (x,y)=(a+phi0,b+phi0);
                            let critical=if phi0==0.0 {std::f64::consts::PI}
                                else {(phi0/x).acos()+(phi0/y).acos()};
                            let expected=if angle<=critical {
                                ((x-y).powi(2)+4.0*x*y*(angle*0.5).sin().powi(2)).sqrt()
                            } else {
                                (x*x-phi0*phi0).max(0.0).sqrt()
                                    +(y*y-phi0*phi0).max(0.0).sqrt()+phi0*(angle-critical)
                            };
                            let got=clairaut_distance(profile,a,b,theta.cos());
                            assert!((got-expected).abs()<2e-8,
                                "phi0={phi0} k={kappa} a={a} b={b} theta={theta} got={got} expected={expected}");
                        }
                    }
                }
            }
        }
    }
    #[test]
    fn numerical_clairaut_matches_independent_constant_curvature_closed_form() {
        let mut worst = 0.0_f64;
        for curvature in [0.25_f64, 1.0, 4.0] {
            let s = curvature.sqrt();
            for i in 0..=20 {
                for j in 0..=20 {
                    let (a,b) = (i as f64 * 0.16, j as f64 * 0.16);
                    for k in 0..=40 {
                        let cosine = 1.0 - k as f64 / 20.0;
                        // Stable hyperbolic law of cosines, independent of quadrature.
                        let half = (s*(a-b)*0.5).sinh().powi(2)
                            + (s*a).sinh()*(s*b).sinh()*(1.0-cosine)*0.5;
                        let expected = 2.0*half.max(0.0).sqrt().asinh()/s;
                        let got = clairaut_distance(WarpedProfile::ConstantHyperbolic {curvature},a,b,cosine);
                        let error = (got-expected).abs();
                        worst = worst.max(error);
                        assert!(error < 1e-9, "c={curvature} a={a} b={b} cos={cosine} error={error} worst={worst}");
                    }
                }
            }
        }
    }
    #[test]
    fn flat_limit_and_table_domain_are_explicit() {
        for profile in [WarpedProfile::Softening {alpha:0.0}, WarpedProfile::Steepening {alpha:0.0}] {
            for a in [0.0_f64,0.1,0.35,1.0,2.2] {
                for b in [0.0_f64,0.2,0.35,1.8,2.2] {
                    for c in [-1.0_f64,-0.99,0.0,0.5,0.99,1.0] {
                        let expected = ((a-b).powi(2)+2.0*a*b*(1.0-c)).sqrt();
                        let got = clairaut_distance(profile,a,b,c);
                        assert!((got-expected).abs()<1e-9,"a={a} b={b} c={c} got={got} expected={expected}");
                    }
                }
            }
        }
        assert!(WarpedProfile::Softening {alpha:-1.0}.validate(2.2).is_err());
        let table = WarpedProxyTable::try_build(WarpedProfile::Softening {alpha:0.35},2.2,8,9).unwrap();
        assert!(table.checked_slice(2.20001).is_err());
        assert!(table.checked_slice(f64::NAN).is_err());
        let slice = table.checked_slice(1.0).unwrap();
        assert!((slice.eval(1.8,0.5)-table.eval(1.0,1.8,0.5)).abs()<1e-5);
    }
}


#[cfg(test)]
mod throat_metric_tests {
    use super::*;
    #[test]
    fn throat_symmetry_boundary_arcs_triangle_and_zero_throat_limit() {
        for alpha in [0.15,0.35] {
            for phi0 in [0.0,0.8,1.5] {
                for kappa in [0.5,1.0,2.0] {
                    let p=WarpedProfile::ThroatSoftening {alpha,phi0,kappa};
                    p.validate(1.2).unwrap();
                    if phi0>0.0 {
                        let theta=1.2_f64;
                        let d=clairaut_distance(p,0.0,0.0,theta.cos());
                        assert!((d-kappa*phi0*theta).abs()<1e-10);
                        assert!(clairaut_distance(p,0.0,0.0,-1.0)>0.0);
                    }
                    for case in 0..64 {
                        // Three genuine directions on one great circle, not arbitrary
                        // pairwise cosines which need not form a valid Gram matrix.
                        let angles=[0.013*case as f64,0.47+0.019*case as f64,1.2+0.023*case as f64];
                        let radii=[0.35+0.007*case as f64,0.9-0.006*case as f64,0.4+0.009*case as f64];
                        let distance=|a:usize,b:usize|clairaut_distance(p,radii[a],radii[b],(angles[a]-angles[b]).cos());
                        let (ab,bc,ac)=(distance(0,1),distance(1,2),distance(0,2));
                        assert!((ab-distance(1,0)).abs()<1e-12);
                        assert!(ab.is_finite() && ab>=(radii[0]-radii[1]).abs()-1e-9);
                        assert!(ac<=ab+bc+1e-8,"triangle alpha={alpha} phi0={phi0} k={kappa}");
                    }
                }
            }
            for c in [-1.0,-0.8,0.0,0.55,0.99,1.0] {
                let old=clairaut_distance(WarpedProfile::Softening {alpha},0.4,0.9,c);
                let new=clairaut_distance(WarpedProfile::ThroatSoftening {alpha,phi0:0.0,kappa:1.0},0.4,0.9,c);
                assert!((old-new).abs()<1e-9);
            }
        }
        for (phi0,kappa) in [(-1.0,1.0),(f64::NAN,1.0),(0.8,0.0),(0.8,2.1)] {
            assert!(WarpedProfile::ThroatSoftening {alpha:0.15,phi0,kappa}.validate(1.2).is_err());
        }
    }
}


#[cfg(test)]
mod prepared_grid_tests {
    use super::*;

    const PROFILE: WarpedProfile =
        WarpedProfile::ThroatSoftening { alpha: 0.15, phi0: 1.5, kappa: 2.0 };
    const R_MAX: f64 = 0.65;
    const NR: usize = 64;
    const NS: usize = 65;

    #[test]
    fn prepared_throat_grid_matches_reference_bits() {
        let step_r = R_MAX / (NR - 1) as f64;
        let step_u = 1.0 / (NS - 1) as f64;
        let legs = prepare_throat_grid_legs(PROFILE, step_r, NR);
        let table = WarpedProxyTable::build(PROFILE, R_MAX, NR, NS);
        for i in 0..NR {
            let ri = i as f64 * step_r;
            for j in i..NR {
                let rj = j as f64 * step_r;
                let pair = ThroatGridPair::new(PROFILE, ri, rj, legs[i], legs[j]);
                let compare = |cosine: f64| {
                    let expected = clairaut_distance(PROFILE, ri, rj, cosine);
                    let got = throat_distance_with(PROFILE, ri, rj, cosine, Some(&pair));
                    assert_eq!(got.to_bits(), expected.to_bits(), "i={i} j={j} cos={cosine:.17}");
                    expected
                };
                let radial_sq = (ri - rj) * (ri - rj);
                for k in 0..NS {
                    let u = k as f64 * step_u;
                    let expected = compare((1.0 - 2.0 * u).clamp(-1.0, 1.0));
                    if k == 0 {
                        assert_eq!(expected.to_bits(), (ri - rj).abs().to_bits());
                    }
                    let bits = ((expected * expected - radial_sq).max(0.0) as f32).to_bits();
                    assert_eq!(table.data[(i * NR + j) * NS + k].to_bits(), bits);
                    assert_eq!(table.data[(j * NR + i) * NS + k].to_bits(), bits);
                }
                for angle in [pair.critical, pair.maximum] {
                    let c = angle.cos();
                    for cosine in [c.next_down(), c, c.next_up()] {
                        compare(cosine);
                    }
                }
            }
        }
    }

    #[test]
    #[ignore = "release-mode timing probe; run explicitly"]
    fn production_throat_grid_build_timing() {
        use std::{hint::black_box, time::Instant};
        let measure = |reuse| {
            let start = Instant::now();
            let table = black_box(WarpedProxyTable::build_impl(PROFILE, R_MAX, NR, NS, reuse));
            (table, start.elapsed().as_secs_f64() * 1000.0)
        };
        black_box(measure(true));
        let mut old_times = [0.0; 3];
        let mut new_times = [0.0; 3];
        for i in 0..3 {
            let ((old, old_ms), (new, new_ms)) = if i % 2 == 0 {
                (measure(false), measure(true))
            } else {
                let new = measure(true);
                (measure(false), new)
            };
            assert!(old.data.iter().zip(&new.data).all(|(a, b)| a.to_bits() == b.to_bits()));
            old_times[i] = old_ms;
            new_times[i] = new_ms;
        }
        eprintln!("table build ms: old={old_times:?} new={new_times:?}");
        old_times.sort_by(f64::total_cmp);
        new_times.sort_by(f64::total_cmp);
        eprintln!("median ms: old={:.3} new={:.3} speedup={:.2}x",
            old_times[1], new_times[1], old_times[1] / new_times[1]);
    }
}
