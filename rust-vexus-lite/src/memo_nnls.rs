use nalgebra::{DMatrix, DVector};
use serde::Serialize;

const DUAL_TOL: f64 = 1e-10;
const RANK_TOL: f64 = 1e-12;
const CHECK_TOL: f64 = 2e-8;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Diagnostics {
    pub(crate) iterations: usize,
    pub(crate) active_tags: usize,
    pub(crate) dual_violation: f64,
    pub(crate) stationarity_error: f64,
    pub(crate) complementarity_error: f64,
    pub(crate) energy_closure_error: f64,
    pub(crate) residual_ratio: f64,
}

pub(crate) struct Solution {
    pub(crate) projection: Vec<f32>,
    pub(crate) residual: Vec<f32>,
    // Unit-Tag coefficients divided by input query norm.
    pub(crate) contributions: Vec<f64>,
    pub(crate) diagnostics: Diagnostics,
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(x,y)| x*y).sum()
}

fn reconstruct(columns: &[Vec<f64>], x: &[f64], dimension: usize) -> Vec<f64> {
    let mut p = vec![0.0; dimension];
    for (column, &weight) in columns.iter().zip(x) {
        if weight != 0.0 {
            for (value, &axis) in p.iter_mut().zip(column) { *value += weight * axis; }
        }
    }
    p
}

fn reconstruct_into(columns: &[f64], x: &[f64], p: &mut [f64]) {
    p.fill(0.0);
    let dimension = p.len();
    for (column, &weight) in columns.chunks_exact(dimension).zip(x) {
        if weight != 0.0 {
            for (value, &axis) in p.iter_mut().zip(column) { *value += weight * axis; }
        }
    }
}

/// Entries are (stable Tag ID, original vector). Sorting only controls exact
/// ties and nonunique coefficient allocation; projection solves the original cone.
pub(crate) fn solve(query: &[f32], tags: &[(i64, &[f32])]) -> Result<Solution, String> {
    if tags.len() > 128 {
        return Err("MEMO_NNLS_INVALID_TAGS".into());
    }
    let query64: Vec<f64> = query.iter().map(|&x| x as f64).collect();
    let columns: Vec<f64> = tags.iter()
        .flat_map(|(_, v)| v.iter().map(|&x| x as f64)).collect();
    // Keep each original length so malformed inputs reach the solver's checks.
    let mut offset = 0;
    let refs: Vec<_> = tags.iter().map(|(id, v)| {
        let start = offset;
        offset += v.len();
        (*id, &columns[start..offset])
    }).collect();
    let result = solve_f64(&query64, &refs)?;
    let projection: Vec<f32> = result.projection.iter().map(|&x| x as f32).collect();
    let residual: Vec<f32> = result.residual.iter().map(|&x| x as f32).collect();
    if projection.iter().chain(&residual).any(|x| !x.is_finite()) {
        return Err("MEMO_NNLS_OUTPUT_OVERFLOW".into());
    }
    Ok(Solution { projection, residual, contributions: result.contributions,
        diagnostics: result.diagnostics })
}

pub(crate) struct Solution64 {
    pub(crate) projection: Vec<f64>,
    pub(crate) residual: Vec<f64>,
    pub(crate) contributions: Vec<f64>,
    pub(crate) diagnostics: Diagnostics,
}

/// Same active-set/SVD solver without a lossy FP32 round trip.
/// Normalizes original generators, never QR-coordinate columns implicitly.
pub(crate) fn solve_f64(query: &[f64], tags: &[(i64, &[f64])]) -> Result<Solution64, String> {
    let dimension = query.len();
    if dimension == 0 || query.iter().any(|v| !v.is_finite()) {
        return Err("MEMO_NNLS_INVALID_QUERY".into());
    }
    if tags.len() > 256 || tags.iter().any(|(_, v)|
        v.len() != dimension || v.iter().any(|x| !x.is_finite())) {
        return Err("MEMO_NNLS_INVALID_TAGS".into());
    }
    let norm = query.iter().map(|&v| (v as f64).powi(2)).sum::<f64>().sqrt();
    let mut entries: Vec<_> = tags.iter().enumerate().collect();
    entries.sort_by_key(|(slot, (id, _))| (*id, *slot));
    let mut columns = Vec::with_capacity(tags.len() * dimension);
    let mut slots = Vec::new();
    for (slot, (_, vector)) in entries {
        let n = vector.iter().map(|&v| (v as f64).powi(2)).sum::<f64>().sqrt();
        if n > 0.0 {
            columns.extend(vector.iter().map(|&v| v as f64 / n));
            slots.push(slot);
        }
    }
    let y: Vec<f64> = query.iter().map(|&v| if norm > 0.0 { v as f64 / norm } else { 0.0 }).collect();
    let count = slots.len();
    let mut x = vec![0.0_f64; count];
    let mut passive = vec![false; count];
    let mut iterations = 0;
    let limit = 32 * count.max(1) + 128;
    let mut p = vec![0.0; dimension];
    let mut r = vec![0.0; dimension];
    let mut z = vec![0.0; count];
    let mut indices = Vec::with_capacity(count);
    let y_vec = DVector::from_column_slice(&y);
    loop {
        reconstruct_into(&columns, &x, &mut p);
        for ((r, a), b) in r.iter_mut().zip(&y).zip(&p) { *r = a-b; }
        let mut best = None;
        let mut maximum = DUAL_TOL;
        for i in 0..count {
            if passive[i] { continue; }
            let w = dot(&columns[i * dimension..(i + 1) * dimension], &r);
            if w > maximum { maximum = w; best = Some(i); }
        }
        let Some(entering) = best else { break };
        passive[entering] = true;
        loop {
            iterations += 1;
            if iterations > limit {
                return Err(format!("MEMO_NNLS_ITERATION_LIMIT: {limit}"));
            }
            indices.clear();
            indices.extend((0..count).filter(|&i| passive[i]));
            let mut matrix = DMatrix::zeros(dimension, indices.len());
            for (column, &i) in matrix.as_mut_slice().chunks_exact_mut(dimension).zip(&indices) {
                column.copy_from_slice(&columns[i * dimension..(i + 1) * dimension]);
            }
            // SVD on original columns avoids squaring the condition number.
            let svd = nalgebra::linalg::SVD::try_new(matrix, true, true,
                f64::EPSILON * 8.0, 4096)
                .ok_or_else(|| "MEMO_NNLS_SVD_ITERATION_LIMIT".to_string())?;
            let fitted = svd.solve(&y_vec, RANK_TOL)
                .map_err(|e| format!("MEMO_NNLS_SVD: {e}"))?;
            z.fill(0.0);
            for (&i, &value) in indices.iter().zip(fitted.iter()) {
                if !value.is_finite() { return Err("MEMO_NNLS_NONFINITE_FIT".into()); }
                z[i] = value;
            }
            if indices.iter().all(|&i| z[i] > 0.0) { x.copy_from_slice(&z); break; }
            let mut alpha = 1.0_f64;
            for &i in &indices {
                if z[i] <= 0.0 {
                    let denominator = x[i] - z[i];
                    if denominator > 0.0 { alpha = alpha.min(x[i] / denominator); }
                    else { alpha = 0.0; }
                }
            }
            for i in 0..count {
                x[i] += alpha * (z[i] - x[i]);
            }
            // Remove all boundary hits, relative to the current coefficient scale.
            let boundary = 32.0 * f64::EPSILON * x.iter().copied().fold(1.0_f64, f64::max);
            for i in 0..count {
                if passive[i] && x[i] <= boundary {
                    x[i] = 0.0;
                    passive[i] = false;
                }
            }
        }
    }
    reconstruct_into(&columns, &x, &mut p);
    for ((r, a), b) in r.iter_mut().zip(&y).zip(&p) { *r = a-b; }
    let mut dual = 0.0_f64;
    let mut stationarity = 0.0_f64;
    let mut complementarity = 0.0_f64;
    for i in 0..count {
        let w = dot(&columns[i * dimension..(i + 1) * dimension], &r);
        dual = dual.max(w.max(0.0));
        if x[i] > 0.0 { stationarity = stationarity.max(w.abs()); }
        complementarity = complementarity.max((x[i]*w).abs());
    }
    let closure = (dot(&y,&y) - dot(&p,&p) - dot(&r,&r)).abs();
    if x.iter().any(|a| !a.is_finite() || *a < 0.0)
        || dual > CHECK_TOL || stationarity > CHECK_TOL
        || complementarity > CHECK_TOL || closure > CHECK_TOL
        || dot(&r,&r) > dot(&y,&y) + CHECK_TOL {
        return Err(format!("MEMO_NNLS_KKT: dual={dual:e} stationarity={stationarity:e} complementarity={complementarity:e} closure={closure:e}"));
    }
    let mut contributions = vec![0.0; tags.len()];
    for (&slot, &a) in slots.iter().zip(&x) { contributions[slot] = a; }
    let projection: Vec<f64> = p.iter().map(|v| v*norm).collect();
    let residual: Vec<f64> = r.iter().map(|v| v*norm).collect();
    if projection.iter().chain(&residual).any(|v| !v.is_finite()) {
        return Err("MEMO_NNLS_OUTPUT_OVERFLOW".into());
    }
    Ok(Solution64 { projection, residual, contributions,
        diagnostics: Diagnostics {
            iterations, active_tags: x.iter().filter(|&&a| a > 0.0).count(),
            dual_violation: dual, stationarity_error: stationarity,
            complementarity_error: complementarity, energy_closure_error: closure,
            residual_ratio: dot(&r,&r),
        } })
}

/// All supplied rays remain columns of R, including dependent rays.
/// QR changes coordinates; nonnegativity still constrains original Tag weights.
pub(crate) fn solve_qr_f64(query: &[f64], tags: &[(i64, &[f64])])
    -> Result<Solution64, String>
{
    let dimension = query.len();
    if dimension == 0 || query.iter().any(|x| !x.is_finite()) {
        return Err("MEMO_CONE_INVALID_QUERY".into());
    }
    if tags.len() > 256 || tags.iter().any(|(_, v)|
        v.len() != dimension || v.iter().any(|x| !x.is_finite())) {
        return Err("MEMO_CONE_INVALID_COLUMNS".into());
    }
    let norm = dot(query, query).sqrt();
    if !norm.is_finite() {
        return Err("MEMO_CONE_QUERY_OVERFLOW".into());
    }
    if norm == 0.0 || tags.is_empty() { return solve_f64(query, tags); }
    let y: Vec<_> = query.iter().map(|x| x / norm).collect();
    let mut entries: Vec<_> = tags.iter().enumerate().collect();
    entries.sort_by_key(|(slot, (id, _))| (*id, *slot));
    let mut columns = Vec::new();
    let mut slots = Vec::new();
    let mut ids = Vec::new();
    for (slot, (id, v)) in entries {
        let n = dot(v, v).sqrt();
        if !n.is_finite() { return Err("MEMO_CONE_COLUMN_OVERFLOW".into()); }
        if n > 0.0 {
            columns.push(v.iter().map(|x| x/n).collect::<Vec<_>>());
            slots.push(slot);
            ids.push(*id);
        }
    }
    if columns.is_empty() { return solve_f64(query, tags); }
    let matrix = DMatrix::from_fn(dimension, columns.len(), |i,j| columns[j][i]);
    let qr = matrix.qr();
    let q = qr.q();
    let r = qr.r();
    let z = q.transpose() * DVector::from_column_slice(&y);
    let z_norm = z.norm();
    let compressed: Vec<Vec<f64>> = (0..columns.len())
        .map(|j| r.column(j).iter().copied().collect()).collect();
    let refs: Vec<_> = ids.iter().zip(&compressed)
        .map(|(&id,v)| (id,v.as_slice())).collect();
    let small = solve_f64(z.as_slice(), &refs)?;
    // The common solver normalizes both query and columns: undo those scales.
    let x: Vec<_> = compressed.iter().zip(&small.contributions).map(|(v,c)| {
        let n = dot(v,v).sqrt();
        if n > 0.0 { c*z_norm/n } else { 0.0 }
    }).collect();
    let p = reconstruct(&columns, &x, dimension);
    let residual: Vec<_> = y.iter().zip(&p).map(|(a,b)| a-b).collect();
    let mut dual = 0.0_f64;
    let mut stationarity = 0.0_f64;
    let mut complementarity = 0.0_f64;
    for (v,&c) in columns.iter().zip(&x) {
        let w = dot(v,&residual);
        dual = dual.max(w.max(0.0));
        if c > 0.0 { stationarity = stationarity.max(w.abs()); }
        complementarity = complementarity.max((c*w).abs());
    }
    let energy = dot(&residual,&residual);
    let closure = (dot(&y,&y)-dot(&p,&p)-energy).abs();
    if x.iter().any(|c| !c.is_finite() || *c < 0.0)
        || !energy.is_finite() || energy > 1.0+CHECK_TOL
        || dual > CHECK_TOL || stationarity > CHECK_TOL
        || complementarity > CHECK_TOL || closure > CHECK_TOL {
        return Err(format!("MEMO_CONE_ORIGINAL_KKT: dual={dual:e} stationarity={stationarity:e} complementarity={complementarity:e} closure={closure:e}"));
    }
    let mut contributions = vec![0.0; tags.len()];
    for (&slot,&c) in slots.iter().zip(&x) { contributions[slot] = c; }
    Ok(Solution64 {
        projection: p.iter().map(|x| x*norm).collect(),
        residual: residual.iter().map(|x| x*norm).collect(),
        contributions,
        diagnostics: Diagnostics {
            iterations: small.diagnostics.iterations,
            active_tags: x.iter().filter(|&&c| c>0.0).count(),
            dual_violation: dual, stationarity_error: stationarity,
            complementarity_error: complementarity, energy_closure_error: closure,
            residual_ratio: energy,
        },
    })
}
#[cfg(test)]
mod tests {
    use super::*;

    fn check(q: &[f32], tags: &[(i64, &[f32])]) -> Solution {
        let s = solve(q,tags).unwrap();
        let energy = q.iter().map(|&v| (v as f64).powi(2)).sum::<f64>();
        let mut p2 = 0.0; let mut r2 = 0.0; let mut pr = 0.0;
        for ((&q,&p),&r) in q.iter().zip(&s.projection).zip(&s.residual) {
            assert!((q as f64-p as f64-r as f64).abs() <= 2e-6*energy.sqrt().max(1e-30));
            p2 += (p as f64).powi(2); r2 += (r as f64).powi(2);
            pr += p as f64*r as f64;
        }
        assert!((energy-p2-r2).abs() <= 2e-6*energy.max(1e-30));
        assert!(pr.abs() <= 2e-6*energy.max(1e-30));
        assert!(s.contributions.iter().all(|v| v.is_finite() && *v >= 0.0));
        s
    }

    #[test]
    fn cone_preserves_opposite_secondary_direction() {
        let a = [1.0,0.0]; let b = [0.94,-0.342];
        let s = check(&[0.94,0.342], &[(1,&a),(2,&b)]);
        assert!(s.residual[1] > 0.34);
        assert_eq!(s.contributions[1],0.0);
        let opposite = check(&[-1.0,0.0], &[(1,&a)]);
        assert_eq!(opposite.projection,vec![0.0,0.0]);
    }

    #[test]
    fn initially_negative_tag_can_be_required_by_joint_fit() {
        let a = [1.0,1.0]; let b = [0.0,-1.0];
        let s = check(&[1.0,0.1], &[(1,&a),(2,&b)]);
        assert!(s.contributions[1] > 0.8);
        assert!(s.residual.iter().all(|v| v.abs() < 1e-6));
    }

    #[test]
    fn scale_duplicates_zero_and_permutations() {
        for scale in [1e-6_f32,1.0,1e6] {
            let a = [scale,0.0,0.0]; let b = [0.0,scale,0.0]; let z = [0.0;3];
            let first = check(&[0.3*scale,0.4*scale,0.5*scale],
                &[(30,&a),(10,&a),(20,&b),(40,&z)]);
            let second = check(&[0.3*scale,0.4*scale,0.5*scale],
                &[(40,&z),(20,&b),(10,&a),(30,&a)]);
            assert_eq!(first.projection,second.projection);
            assert_eq!(first.contributions[0],0.0);
            assert_eq!(first.contributions[1],second.contributions[2]);
        }
        check(&[0.0,0.0],&[]);
        check(&[1.0,0.0],&[]);
        assert!(solve(&[f32::NAN],&[]).is_err());
        assert!(solve(&[1.0],&[(1,&[1.0,0.0])]).is_err());
    }

    #[test]
    fn near_collinear_cone_does_not_invent_unbounded_cancellation() {
        for epsilon in [1e-7_f32,1e-4] {
            let a = [0.6,0.8,0.0]; let b = [0.6,0.8,epsilon];
            let s = check(&[0.0,0.0,1.0], &[(1,&a),(2,&b)]);
            assert!(s.residual[2] > 0.99);
            assert!(s.contributions.iter().all(|v| *v < 0.001));
        }
    }
}

#[cfg(test)]
mod reference_tests {
    use super::*;

    #[test]
    fn planar_cones_match_independent_ray_and_pair_enumeration() {
        // In R2, projection is zero, on a generating ray, or q itself when
        // q belongs to a nonnegative pair. No SVD is used by this reference.
        for seed in 0..160 {
            let q = [((seed * 37 % 97) as f32 - 48.0) / 31.0,
                ((seed * 53 % 89) as f32 - 44.0) / 29.0];
            let vectors: Vec<[f32;2]> = (0..6).map(|i| {
                let angle = (seed * 13 + i * 67) as f64 * 0.071;
                [angle.cos() as f32, angle.sin() as f32]
            }).collect();
            let tags: Vec<_> = vectors.iter().enumerate()
                .map(|(i,v)| (i as i64, v.as_slice())).collect();
            let solved = solve(&q,&tags).unwrap();
            let q64 = [q[0] as f64,q[1] as f64];
            let mut best = dot(&q64,&q64);
            for a in &vectors {
                let a = [a[0] as f64,a[1] as f64];
                let amplitude = (dot(&a,&q64)/dot(&a,&a)).max(0.0);
                let r = [q64[0]-amplitude*a[0],q64[1]-amplitude*a[1]];
                best = best.min(dot(&r,&r));
            }
            for a in &vectors {
                for b in &vectors {
                    let (ax,ay,bx,by) = (a[0] as f64,a[1] as f64,b[0] as f64,b[1] as f64);
                    let determinant = ax*by-ay*bx;
                    if determinant.abs() > 1e-10 {
                        let x = (q64[0]*by-q64[1]*bx)/determinant;
                        let y = (ax*q64[1]-ay*q64[0])/determinant;
                        if x >= 0.0 && y >= 0.0 { best = 0.0; }
                    }
                }
            }
            let actual = solved.residual.iter().map(|&v| (v as f64).powi(2)).sum::<f64>();
            assert!((actual-best).abs() < 2e-6, "seed={seed} actual={actual} best={best}");
            let reverse: Vec<_> = tags.iter().copied().rev().collect();
            let reordered = solve(&q,&reverse).unwrap();
            assert_eq!(solved.projection,reordered.projection);
        }
    }

    #[test]
    fn high_dimensional_128_candidate_budget_is_finite_and_deterministic() {
        let dimension = 3072;
        let vectors: Vec<Vec<f32>> = (0..128).map(|i| {
            let mut v = vec![0.0;dimension];
            v[i] = 1.0;
            v[256+i%7] = 0.2;
            v
        }).collect();
        let tags: Vec<_> = vectors.iter().enumerate()
            .map(|(i,v)| (i as i64,v.as_slice())).collect();
        let mut query = vec![0.0;dimension];
        for i in 0..10 { query[i] = (i+1) as f32 * 0.01; }
        query[3000] = 0.3;
        let began = std::time::Instant::now();
        let first = solve(&query,&tags).unwrap();
        let elapsed = began.elapsed();
        let second = solve(&query,&tags).unwrap();
        assert_eq!(first.projection,second.projection);
        assert_eq!(first.contributions,second.contributions);
        assert!(first.diagnostics.active_tags <= 128);
        assert!(first.residual[3000] > 0.29);
        eprintln!("NNLS 3072d/128 candidates: elapsed={elapsed:?}, iterations={}, active={}",
            first.diagnostics.iterations,first.diagnostics.active_tags);
    }
}

#[cfg(test)]
mod dense_stress_tests {
    use super::*;

    #[test]
    fn dense_128_active_columns_close_energy() {
        let dimension = 3072;
        let vectors: Vec<Vec<f32>> = (0..128).map(|i| {
            let mut v = vec![0.0; dimension];
            v[i] = 1.0;
            v[256] = 0.05;
            v
        }).collect();
        let tags: Vec<_> = vectors.iter().enumerate()
            .map(|(i,v)| (i as i64,v.as_slice())).collect();
        let mut query = vec![0.0_f32;dimension];
        for (i,v) in vectors.iter().enumerate() {
            let amplitude = 0.01 + i as f32 * 0.0001;
            for (q,&axis) in query.iter_mut().zip(v) { *q += amplitude*axis; }
        }
        query[3000] = 0.2;
        let began = std::time::Instant::now();
        let solution = solve(&query,&tags).unwrap();
        let elapsed = began.elapsed();
        assert_eq!(solution.diagnostics.active_tags,128);
        assert_eq!(solution.diagnostics.iterations,128);
        assert!((solution.residual[3000]-0.2).abs() < 1e-6);
        assert!(solution.residual[..3000].iter().all(|v| v.abs() < 1e-6));
        eprintln!("NNLS dense 3072d/128 active: elapsed={elapsed:?}, iterations={}",
            solution.diagnostics.iterations);
    }
}

#[cfg(test)]
mod default_scale_performance_tests {
    use super::*;

    #[test]
    fn default_and_extended_dense_candidate_costs() {
        for count in [10_usize, 32] {
            let dimension = 3072;
            let vectors: Vec<Vec<f32>> = (0..count).map(|i| {
                let mut v = vec![0.0; dimension];
                v[i] = 1.0;
                v[256] = 0.05;
                v
            }).collect();
            let tags: Vec<_> = vectors.iter().enumerate()
                .map(|(i,v)| (i as i64,v.as_slice())).collect();
            let mut query = vec![0.0_f32; dimension];
            for (i,v) in vectors.iter().enumerate() {
                let amplitude = 0.01 + i as f32 * 0.0001;
                for (q,&axis) in query.iter_mut().zip(v) {
                    *q += amplitude*axis;
                }
            }
            query[3000] = 0.2;
            // Warm once, then report several solves; no machine-specific
            // timing assertion is used as a correctness criterion.
            solve(&query, &tags).unwrap();
            let mut times = Vec::new();
            for _ in 0..5 {
                let began = std::time::Instant::now();
                let solution = solve(&query, &tags).unwrap();
                times.push(began.elapsed().as_secs_f64() * 1000.0);
                assert_eq!(solution.diagnostics.active_tags, count);
                assert!(solution.diagnostics.dual_violation <= CHECK_TOL);
                assert!((solution.residual[3000] - 0.2).abs() < 1e-6);
            }
            times.sort_by(f64::total_cmp);
            eprintln!("NNLS dense 3072d/{count} active: min_ms={:.3}, median_ms={:.3}, max_ms={:.3}",
                times[0], times[2], times[4]);
        }
    }
}

#[cfg(test)]
mod offline_qr_tests {
    use super::*;

    fn compare(y: &[f64], tags: &[(i64, &[f64])]) -> Solution64 {
        let direct = solve_f64(y, tags).unwrap();
        let small = solve_qr_f64(y, tags).unwrap();
        for (a,b) in direct.projection.iter().zip(&small.projection) {
            assert!((a-b).abs() < 2e-8, "projection {a} != {b}");
        }
        assert!((direct.diagnostics.residual_ratio-small.diagnostics.residual_ratio).abs()<2e-8);
        assert!(small.contributions.iter().all(|x| x.is_finite() && *x>=0.0));
        small
    }

    #[test]
    fn qr_constrains_original_rays_not_orthogonal_axes() {
        let a = [1.0,0.0]; let b = [0.94,-0.342];
        let s = compare(&[0.94,0.342], &[(1,&a),(2,&b)]);
        assert!(s.residual[1] > 0.34);
        assert_eq!(s.contributions[1],0.0);
        compare(&[-1.0,0.0], &[(1,&a)]);
    }

    #[test]
    fn qr_keeps_linearly_dependent_cone_necessary_rays() {
        let a=[1.0,1.0]; let b=[0.0,-1.0]; let c=[-1.0,0.0];
        // Three rays in R2: linear dependence does not permit deleting a ray.
        let s=compare(&[-1.0,0.0], &[(1,&a),(2,&b),(3,&c)]);
        assert!(s.residual.iter().all(|x|x.abs()<1e-8));
        assert!(s.contributions[2]>0.9);
        let joint=compare(&[1.0,0.1], &[(1,&a),(2,&b)]);
        assert!(joint.contributions[1]>0.8);
    }

    #[test]
    fn qr_preserves_external_residual_scale_duplicates_and_zero_columns() {
        let a=[1.0,0.0,0.0]; let z=[0.0;3];
        let s=compare(&[0.3,0.0,0.4], &[(3,&a),(1,&a),(2,&z)]);
        assert!((s.diagnostics.residual_ratio-0.64).abs()<1e-10);
        compare(&[0.0,1.0,0.0], &[(1,&a)]);
        compare(&[0.0;3], &[(1,&a)]);
        compare(&[1.0,0.0,0.0], &[]);
        assert!(solve_qr_f64(&[f64::NAN],&[]).is_err());
    }

    #[test]
    fn qr_randomized_and_near_collinear_match_original_space() {
        let mut state=20261114_u64;
        let mut next=|| {
            state=state.wrapping_mul(6364136223846793005).wrapping_add(1);
            ((state>>11) as f64)/(1_u64<<53) as f64-0.5
        };
        for round in 0..24 {
            let columns:Vec<Vec<f64>>=(0..8).map(|_|(0..16).map(|_|next()).collect()).collect();
            let mut columns=columns;
            if round%3==0 { columns[1]=columns[0].clone(); columns[1][0]+=1e-7; }
            let y:Vec<_>=(0..16).map(|_|next()).collect();
            let refs:Vec<_>=columns.iter().enumerate().map(|(i,v)|(i as i64,v.as_slice())).collect();
            compare(&y,&refs);
        }
    }
}