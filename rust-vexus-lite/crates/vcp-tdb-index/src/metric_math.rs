//! FP64 arithmetic with legacy left-to-right accumulation.
//!
//! SIMD parallelizes conversion and multiplication, NOT reduction. In particular,
//! do not introduce FMA or horizontal reductions into these compatibility kernels.
//! Geometry reference: Pelorus (Apache-2.0), Copyright 2024 TriviumDB Authors.
//! This adaptation deliberately retains VCP's existing accumulation order.
use std::sync::LazyLock;

#[derive(Clone, Copy, Debug)]
enum Kernel {
    Scalar,
    #[cfg(target_arch = "x86_64")]
    Avx2,
    #[cfg(all(target_arch = "x86_64", not(coverage)))]
    Avx512,
}

static KERNEL: LazyLock<Kernel> = LazyLock::new(|| {
    #[cfg(target_arch = "x86_64")]
    {
        #[cfg(not(coverage))]
        if !*crate::index::bq::FORCE_NO_AVX512
            && std::arch::is_x86_feature_detected!("avx512f")
        {
            return Kernel::Avx512;
        }
        if std::arch::is_x86_feature_detected!("avx2") {
            return Kernel::Avx2;
        }
    }
    Kernel::Scalar
});

/// Selected immutable hardware capability; not an experiment configuration.
pub fn kernel_name() -> &'static str {
    match *KERNEL {
        Kernel::Scalar => "ScalarOrderedF64",
        #[cfg(target_arch = "x86_64")]
        Kernel::Avx2 => "Avx2OrderedF64",
        #[cfg(all(target_arch = "x86_64", not(coverage)))]
        Kernel::Avx512 => "Avx512OrderedF64",
    }
}

/// Exact FP32-to-FP64 conversion before squaring; old sequential sum order.
pub fn norm_squared_f64(vector: &[f32]) -> f64 {
    // Iterator Sum<f64> starts at -0.0; preserve its empty-input bit pattern.
    if vector.is_empty() { -0.0 } else { evaluate::<0>(vector, vector)[0] }
}

/// Direct FP64 coordinate differences, avoiding norm/dot cancellation.
/// Like zip, evaluates only the common prefix of unequal inputs.
pub fn delta_squared_f64(a: &[f32], b: &[f32]) -> f64 {
    evaluate::<1>(a, b)[0]
}

/// FP64 cosine with the same prefix, zero, clamp and rounding semantics as
/// the historical engine implementation. Callers validate finite input.
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    finish(evaluate::<2>(a, b))
}

fn finish([dot, a, b]: [f64; 3]) -> f32 {
    if a == 0.0 || b == 0.0 { 0.0 }
    else { (dot / (a.sqrt() * b.sqrt())).clamp(-1.0, 1.0) as f32 }
}

fn evaluate<const MODE: u8>(a: &[f32], b: &[f32]) -> [f64; 3] {
    match *KERNEL {
        #[cfg(target_arch = "x86_64")]
        Kernel::Avx2 => unsafe { avx2::<MODE>(a, b) },
        #[cfg(all(target_arch = "x86_64", not(coverage)))]
        Kernel::Avx512 => unsafe { avx512::<MODE>(a, b) },
        Kernel::Scalar => scalar::<MODE>(a, b),
    }
}

fn scalar<const MODE: u8>(a: &[f32], b: &[f32]) -> [f64; 3] {
    let mut sums = [0.0; 3];
    tail::<MODE>(a, b, 0, &mut sums);
    sums
}

fn tail<const MODE: u8>(a: &[f32], b: &[f32], start: usize, sums: &mut [f64; 3]) {
    for i in start..a.len().min(b.len()) {
        let (x, y) = (a[i] as f64, b[i] as f64);
        if MODE == 0 { sums[0] += x * x; }
        else if MODE == 1 { let d = x - y; sums[0] += d * d; }
        else {
            sums[0] += x * y;
            sums[1] += x * x;
            sums[2] += y * y;
        }
    }
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn avx2<const MODE: u8>(a: &[f32], b: &[f32]) -> [f64; 3] {
    use std::arch::x86_64::*;
    unsafe {
        let end = a.len().min(b.len()) / 4 * 4;
        let mut sums = [0.0; 3];
        for i in (0..end).step_by(4) {
            let x = _mm256_cvtps_pd(_mm_loadu_ps(a.as_ptr().add(i)));
            let y = if MODE == 0 { x } else {
                _mm256_cvtps_pd(_mm_loadu_ps(b.as_ptr().add(i)))
            };
            let d = if MODE == 1 { _mm256_sub_pd(x, y) } else { x };
            let product = _mm256_mul_pd(d, if MODE == 1 { d } else { y });
            let mut p = [0.0; 4];
            _mm256_storeu_pd(p.as_mut_ptr(), product);
            for v in p { sums[0] += v; }
            if MODE == 2 {
                let (mut aa, mut bb) = ([0.0; 4], [0.0; 4]);
                _mm256_storeu_pd(aa.as_mut_ptr(), _mm256_mul_pd(x, x));
                _mm256_storeu_pd(bb.as_mut_ptr(), _mm256_mul_pd(y, y));
                for v in aa { sums[1] += v; }
                for v in bb { sums[2] += v; }
            }
        }
        tail::<MODE>(a, b, end, &mut sums);
        sums
    }
}

#[cfg(all(target_arch = "x86_64", not(coverage)))]
#[target_feature(enable = "avx512f")]
unsafe fn avx512<const MODE: u8>(a: &[f32], b: &[f32]) -> [f64; 3] {
    use std::arch::x86_64::*;
    unsafe {
        let end = a.len().min(b.len()) / 8 * 8;
        let mut sums = [0.0; 3];
        for i in (0..end).step_by(8) {
            let x = _mm512_cvtps_pd(_mm256_loadu_ps(a.as_ptr().add(i)));
            let y = if MODE == 0 { x } else {
                _mm512_cvtps_pd(_mm256_loadu_ps(b.as_ptr().add(i)))
            };
            let d = if MODE == 1 { _mm512_sub_pd(x, y) } else { x };
            let product = _mm512_mul_pd(d, if MODE == 1 { d } else { y });
            let mut p = [0.0; 8];
            _mm512_storeu_pd(p.as_mut_ptr(), product);
            for v in p { sums[0] += v; }
            if MODE == 2 {
                let (mut aa, mut bb) = ([0.0; 8], [0.0; 8]);
                _mm512_storeu_pd(aa.as_mut_ptr(), _mm512_mul_pd(x, x));
                _mm512_storeu_pd(bb.as_mut_ptr(), _mm512_mul_pd(y, y));
                for v in aa { sums[1] += v; }
                for v in bb { sums[2] += v; }
            }
        }
        tail::<MODE>(a, b, end, &mut sums);
        sums
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(a: &[f32], b: &[f32]) {
        // Independent old engine recurrence, no shared helper.
        let (mut dot, mut aa, mut bb, mut dd) = (0f64, 0f64, 0f64, 0f64);
        for (&x, &y) in a.iter().zip(b) {
            let (x, y) = (x as f64, y as f64);
            dot += x * y; aa += x * x; bb += y * y;
            let d = x - y; dd += d * d;
        }
        let expected = if aa == 0. || bb == 0. { 0. }
            else { (dot / (aa.sqrt() * bb.sqrt())).clamp(-1., 1.) as f32 };
        assert_eq!(cosine(a, b).to_bits(), expected.to_bits());
        assert_eq!(delta_squared_f64(a, b).to_bits(), dd.to_bits());
        let norm = a.iter().map(|&v| (v as f64).powi(2)).sum::<f64>();
        assert_eq!(norm_squared_f64(a).to_bits(), norm.to_bits());
        macro_rules! kernels {
            ($mode:literal) => {{
                let reference = scalar::<$mode>(a, b).map(f64::to_bits);
                assert_eq!(evaluate::<$mode>(a, b).map(f64::to_bits), reference);
                #[cfg(target_arch = "x86_64")]
                if std::arch::is_x86_feature_detected!("avx2") {
                    assert_eq!(unsafe { avx2::<$mode>(a, b) }.map(f64::to_bits), reference);
                }
                #[cfg(all(target_arch = "x86_64", not(coverage)))]
                if !*crate::index::bq::FORCE_NO_AVX512
                    && std::arch::is_x86_feature_detected!("avx512f") {
                    assert_eq!(unsafe { avx512::<$mode>(a, b) }.map(f64::to_bits), reference);
                }
            }};
        }
        kernels!(0); kernels!(1); kernels!(2);
    }

    #[test]
    fn ordered_f64_preserves_legacy_bits_all_tails_and_extremes() {
        let mut seed = 0x917a_321f_5678_9abcu64;
        for dim in (0..=80).chain([384, 768, 1536, 3072, 4096]) {
            let a: Vec<f32> = (0..dim).map(|_| {
                seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17;
                f32::from_bits((seed as u32 & 0x807f_ffff) | (((seed >> 32) as u32 % 254 + 1) << 23))
            }).collect();
            let b: Vec<f32> = a.iter().rev().copied().collect();
            check(&a, &b);
            check(&a, &a);
            check(&a, &vec![0.; dim]);
            check(&vec![f32::MAX; dim], &vec![-f32::MAX; dim]);
            check(&vec![f32::from_bits(1); dim], &vec![0.; dim]);
            if dim > 0 { check(&a, &b[..dim - 1]); }
        }
    }

    #[test]
    fn direct_delta_retains_near_neighbor_difference() {
        let a = vec![1f32; 3072];
        let mut b = a.clone();
        b[3071] = f32::from_bits(1f32.to_bits() + 1);
        assert_eq!(delta_squared_f64(&a, &b), 2f64.powi(-46));
        check(&a, &b);
    }
}