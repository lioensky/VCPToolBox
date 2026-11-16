//! Pelorus-derived strided 256-bit sketches (Apache-2.0).
//! Copyright 2024 TriviumDB Authors (https://github.com/YoKONCy).
//! VCP changes: finite-query validation, zero/empty handling and code-only restore.
//! Estimates are statistical, NOT rigorous upper bounds for arbitrary vectors.

pub(crate) fn pack_strided_sketch256(vector: &[f32]) -> [u64; 4] {
    let mut out = [0; 4];
    if vector.is_empty() { return out; }
    for k in 0..256 {
        if vector[k * vector.len() / 256] > 0. { out[k / 64] |= 1 << (k % 64); }
    }
    out
}

/// Database codes use strict >0, exactly like the original-vector sketch.
/// This permits rebuilding derived sketches from legacy snapshots without SQL reads.
pub(crate) fn pack_from_pos(pos: &[u64], dim: usize) -> [u64; 4] {
    let mut out = [0; 4];
    if dim == 0 { return out; }
    assert!(pos.len() >= dim.div_ceil(64));
    for k in 0..256 {
        let j = k * dim / 256;
        if (pos[j / 64] >> (j % 64)) & 1 != 0 { out[k / 64] |= 1 << (k % 64); }
    }
    out
}

#[repr(C, align(64))]
struct Weights([u8; 256]);

pub(crate) struct AsymSketch256Query {
    weights: Weights,
    signs: [u64; 4],
    total: i32,
    scale: f64,
    valid: bool,
}
impl AsymSketch256Query {
    pub fn encode(query: &[f32]) -> Self {
        let mut result = Self { weights: Weights([0; 256]), signs: [0; 4], total: 0, scale: 0., valid: false };
        if query.is_empty() || query.iter().any(|v| !v.is_finite()) { return result; }
        let sub: [f64; 256] = std::array::from_fn(|k| query[k * query.len() / 256] as f64);
        let norm = sub.iter().map(|v| v * v).sum::<f64>().sqrt();
        let max = sub.iter().map(|v| v.abs()).fold(0f64, f64::max);
        if norm <= 0. || max <= 0. { return result; }
        let factor = 255. / max;
        result.scale = 1. / (norm * factor * 12.766_152_972_845_851);
        for (k, &v) in sub.iter().enumerate() {
            if v >= 0. { result.signs[k / 64] |= 1 << (k % 64); }
            let weight = (v.abs() * factor).round() as u8;
            result.weights.0[k] = weight;
            result.total += weight as i32;
        }
        result.valid = true;
        result
    }

    pub fn agree_sum_scalar(&self, sketch: &[u64; 4]) -> i32 {
        let mut sum = 0;
        for k in 0..256 {
            if ((sketch[k / 64] ^ self.signs[k / 64]) >> (k % 64)) & 1 == 0 {
                sum += self.weights.0[k] as i32;
            }
        }
        sum
    }

    /// Conservative variance scaling adapted from Pelorus's isotropic guard.
    /// Repeated samples below 256D do not provide 256 independent observations.
    /// This remains a heuristic safety margin, NOT a lossless confidence bound.
    pub fn effective_margin(estimate: f64, base: f64, dim: usize) -> f64 {
        let angular = ((1. - estimate * estimate).max(0.).sqrt() / 0.555).clamp(1., 1.80);
        let repeated_samples = (256. / dim.clamp(1, 256) as f64).sqrt();
        (base * angular * repeated_samples).min(2.)
    }

    pub fn cosine_hat(&self, sketch: &[u64; 4]) -> f64 {
        if !self.valid { return 1.; }
        #[cfg(target_arch = "x86_64")]
        let sum = unsafe {
            match *KERNEL {
                #[cfg(not(coverage))]
                Kernel::Avx512 => self.agree_sum_avx512(sketch),
                Kernel::Avx2 => self.agree_sum_avx2(sketch),
                Kernel::Scalar => self.agree_sum_scalar(sketch),
            }
        };
        #[cfg(not(target_arch = "x86_64"))]
        let sum = self.agree_sum_scalar(sketch);
        ((2 * sum - self.total) as f64 * self.scale).clamp(-1., 1.)
    }

    #[cfg(target_arch = "x86_64")]
    #[target_feature(enable = "avx2")]
    unsafe fn agree_sum_avx2(&self, sketch: &[u64; 4]) -> i32 {
        use std::arch::x86_64::*;
        unsafe {
            let shuf = _mm256_setr_epi8(0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,2,2,2,2,2,2,2,2,3,3,3,3,3,3,3,3);
            let bits = _mm256_setr_epi8(1,2,4,8,16,32,64,-128,1,2,4,8,16,32,64,-128,1,2,4,8,16,32,64,-128,1,2,4,8,16,32,64,-128);
            let mut acc = _mm256_setzero_si256();
            for w in 0..4 {
                let agree = !(sketch[w] ^ self.signs[w]);
                for half in 0..2 {
                    let mask = _mm256_shuffle_epi8(_mm256_set1_epi32((agree >> (half * 32)) as i32), shuf);
                    let mask = _mm256_cmpeq_epi8(_mm256_and_si256(mask, bits), bits);
                    let weights = _mm256_load_si256(self.weights.0.as_ptr().add(w * 64 + half * 32).cast());
                    acc = _mm256_add_epi64(acc, _mm256_sad_epu8(_mm256_and_si256(weights, mask), _mm256_setzero_si256()));
                }
            }
            let s = _mm_add_epi64(_mm256_castsi256_si128(acc), _mm256_extracti128_si256(acc, 1));
            _mm_cvtsi128_si64(_mm_add_epi64(s, _mm_srli_si128(s, 8))) as i32
        }
    }

    #[cfg(all(target_arch = "x86_64", not(coverage)))]
    #[target_feature(enable = "avx512f,avx512bw")]
    unsafe fn agree_sum_avx512(&self, sketch: &[u64; 4]) -> i32 {
        use std::arch::x86_64::*;
        unsafe {
            let mut acc = _mm512_setzero_si512();
            for w in 0..4 {
                let weights = _mm512_load_si512(self.weights.0.as_ptr().add(w * 64).cast());
                let selected = _mm512_maskz_mov_epi8(!(sketch[w] ^ self.signs[w]), weights);
                acc = _mm512_add_epi64(acc, _mm512_sad_epu8(selected, _mm512_setzero_si512()));
            }
            _mm512_reduce_add_epi64(acc) as i32
        }
    }
}

#[cfg(target_arch = "x86_64")]
enum Kernel {
    Scalar,
    Avx2,
    #[cfg(not(coverage))]
    Avx512,
}
#[cfg(target_arch = "x86_64")]
static KERNEL: std::sync::LazyLock<Kernel> = std::sync::LazyLock::new(|| {
    #[cfg(not(coverage))]
    if !*crate::index::bq::FORCE_NO_AVX512
        && is_x86_feature_detected!("avx512f") && is_x86_feature_detected!("avx512bw") {
        return Kernel::Avx512;
    }
    if super::asymmetric::avx2_available() { Kernel::Avx2 } else { Kernel::Scalar }
});

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_and_bitcode_sketches_and_simd_integer_sums_agree() {
        let mut seed = 0x1234_5678_91ac_3f17u64;
        for dim in [1usize, 65, 384, 768, 1536, 3072] {
            let vector: Vec<f32> = (0..dim).map(|i| if i % 7 == 0 { 0. } else { (i as f32 * 0.13).sin() }).collect();
            let sig = crate::index::bq::Bq2Signature::from_vector(&vector);
            assert_eq!(pack_strided_sketch256(&vector), pack_from_pos(&sig.pos, dim));
            let query = AsymSketch256Query::encode(&vector);
            for _ in 0..128 {
                let sketch = std::array::from_fn(|_| {
                    seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; seed
                });
                let expected = query.agree_sum_scalar(&sketch);
                #[cfg(target_arch = "x86_64")]
                unsafe {
                    if super::super::asymmetric::avx2_available() {
                        assert_eq!(query.agree_sum_avx2(&sketch), expected);
                    }
                    #[cfg(not(coverage))]
                    if matches!(*KERNEL, Kernel::Avx512) {
                        assert_eq!(query.agree_sum_avx512(&sketch), expected);
                    }
                }
                assert!(query.cosine_hat(&sketch).is_finite());
            }
        }
        assert!(AsymSketch256Query::effective_margin(0., 0.2, 3072)
            > AsymSketch256Query::effective_margin(0.95, 0.2, 3072));
        assert!(AsymSketch256Query::effective_margin(0., 0.2, 65)
            > AsymSketch256Query::effective_margin(0., 0.2, 3072));
        assert_eq!(AsymSketch256Query::encode(&[0.; 65]).cosine_hat(&[0; 4]), 1.);
        assert_eq!(AsymSketch256Query::encode(&[f32::NAN]).cosine_hat(&[0; 4]), 1.);
    }
}