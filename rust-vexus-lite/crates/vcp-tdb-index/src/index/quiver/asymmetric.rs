//! Pelorus-derived asymmetric query × two-bit SM operators (Apache-2.0).
//! Copyright 2024 TriviumDB Authors (https://github.com/YoKONCy).
//! VCP changes: self-validated normalization, instance-local kernel selection,
//! no research globals, checked shapes and independent overflow tests.
use std::io;

pub(crate) const SCALE: f64 = 8100.0;

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct SmCodeParams {
    pub weak: f32,
    pub delta: f32,
    pub sigma: f32,
    pub strong_ones: u32,
}
impl SmCodeParams {
    pub fn reconstructed_dot(self, other: Self, counts: [u32; 5], dim: usize) -> f64 {
        let x = dim as f64 - 2. * counts[0] as f64;
        let a = self.strong_ones as f64 - 2. * counts[1] as f64;
        let b = other.strong_ones as f64 - 2. * counts[2] as f64;
        let ab = counts[3] as f64 - 2. * counts[4] as f64;
        self.weak as f64 * (other.weak as f64 * x + other.delta as f64 * b)
            + self.delta as f64 * (other.weak as f64 * a + other.delta as f64 * ab)
    }

    pub fn calibrated_cosine(self, other: Self, counts: [u32; 5], dim: usize) -> f64 {
        let denom = self.sigma as f64 * other.sigma as f64;
        if denom <= 0. { return 0.; }
        let cosine = (self.reconstructed_dot(other, counts, dim) / denom).clamp(-1., 1.);
        let kappa = denom.clamp(0.5, 1.);
        (cosine / (kappa + (1. - kappa) * cosine * cosine)).clamp(-1., 1.)
    }
}

/// Per-query choice; unsupported ISA requests safely fall back to scalar.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AsymKernel {
    #[default]
    Auto,
    Scalar,
    Avx2,
    Avx2Lut,
}

pub(crate) struct AsymQuerySm {
    values: Vec<i16>,
    sum: i64,
    chunks: usize,
}
impl AsymQuerySm {
    pub fn encode(query: &[f32]) -> io::Result<Self> {
        if query.is_empty() || query.iter().any(|v| !v.is_finite()) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid asymmetric query"));
        }
        let norm = crate::metric_math::norm_squared_f64(query).sqrt();
        let mut values = vec![0i16; query.len().div_ceil(64) * 64];
        let mut sum = 0;
        if norm > 0. {
            for (dst, &value) in values.iter_mut().zip(query) {
                *dst = (value as f64 / norm * SCALE).round() as i16;
                sum += *dst as i64;
            }
        }
        Ok(Self { values, sum, chunks: query.len().div_ceil(64) })
    }

    pub fn masked_sums(&self, pos: &[u64], strong: &[u64], kernel: AsymKernel) -> [i32; 3] {
        assert!(pos.len() >= self.chunks && strong.len() >= self.chunks);
        #[cfg(target_arch = "x86_64")]
        if kernel != AsymKernel::Scalar && avx2_available() {
            return unsafe { self.avx2(pos, strong, kernel == AsymKernel::Avx2Lut) };
        }
        self.scalar(pos, strong)
    }

    fn scalar(&self, pos: &[u64], strong: &[u64]) -> [i32; 3] {
        let mut sums = [0; 3];
        for c in 0..self.chunks {
            for (k, mut mask) in [pos[c], strong[c], pos[c] & strong[c]].into_iter().enumerate() {
                while mask != 0 {
                    let bit = mask.trailing_zeros() as usize;
                    sums[k] += self.values[c * 64 + bit] as i32;
                    mask &= mask - 1;
                }
            }
        }
        sums
    }

    pub fn calibrated_cosine(&self, pos: &[u64], strong: &[u64], sm: SmCodeParams, kernel: AsymKernel) -> f64 {
        if sm.sigma <= 0. { return 0.; }
        let [p, s, ps] = self.masked_sums(pos, strong, kernel);
        let sign = (2. * p as f64 - self.sum as f64) / SCALE;
        let high = (2. * ps as f64 - s as f64) / SCALE;
        ((sm.weak as f64 * sign + sm.delta as f64 * high)
            / (sm.sigma as f64 * sm.sigma as f64).max(0.25)).clamp(-1., 1.)
    }

    #[cfg(target_arch = "x86_64")]
    #[target_feature(enable = "avx2")]
    unsafe fn avx2(&self, pos: &[u64], strong: &[u64], lut: bool) -> [i32; 3] {
        use std::arch::x86_64::*;
        unsafe {
            let bits = _mm256_setr_epi16(1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, -32768);
            let mut totals = [_mm256_setzero_si256(); 3];
            for start in (0..self.chunks).step_by(4) {
                let mut acc = [_mm256_setzero_si256(); 3];
                for c in start..(start + 4).min(self.chunks) {
                    for part in 0..4 {
                        let q = _mm256_loadu_si256(self.values.as_ptr().add(c * 64 + part * 16).cast());
                        let expand = |word: u64| {
                            let mask = (word >> (part * 16)) as u16;
                            if lut {
                                _mm256_cvtepi8_epi16(_mm_set_epi64x(
                                    MASK8[(mask >> 8) as usize] as i64,
                                    MASK8[(mask & 255) as usize] as i64,
                                ))
                            } else {
                                _mm256_cmpeq_epi16(_mm256_and_si256(_mm256_set1_epi16(mask as i16), bits), bits)
                            }
                        };
                        let p = expand(pos[c]);
                        let s = expand(strong[c]);
                        let selected = [_mm256_and_si256(q, p), _mm256_and_si256(q, s),
                            _mm256_and_si256(_mm256_and_si256(q, p), s)];
                        for k in 0..3 { acc[k] = _mm256_add_epi16(acc[k], selected[k]); }
                    }
                }
                // At most 16 entries/lane: 8100*sqrt(16)+8 = 32408 < 32767.
                for k in 0..3 {
                    totals[k] = _mm256_add_epi32(totals[k], _mm256_madd_epi16(acc[k], _mm256_set1_epi16(1)));
                }
            }
            totals.map(|v| {
                let s = _mm_add_epi32(_mm256_castsi256_si128(v), _mm256_extracti128_si256(v, 1));
                let s = _mm_add_epi32(s, _mm_srli_si128(s, 8));
                _mm_cvtsi128_si32(_mm_add_epi32(s, _mm_srli_si128(s, 4)))
            })
        }
    }
}

#[cfg(target_arch = "x86_64")]
pub(crate) fn avx2_available() -> bool {
    static AVAILABLE: std::sync::LazyLock<bool> =
        std::sync::LazyLock::new(|| is_x86_feature_detected!("avx2"));
    *AVAILABLE
}

#[cfg(target_arch = "x86_64")]
const MASK8: [u64; 256] = {
    let mut lut = [0; 256];
    let mut i = 0;
    while i < 256 {
        let mut bit = 0;
        while bit < 8 {
            if (i >> bit) & 1 != 0 { lut[i] |= 255u64 << (bit * 8); }
            bit += 1;
        }
        i += 1;
    }
    lut
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masked_sums_scalar_avx2_and_lut_are_integer_identical() {
        let mut seed = 0x91ac_3f17u64;
        for dim in [1usize, 65, 384, 768, 1536, 3072, 4096] {
            for case in 0..64 {
                let mut query = (0..dim).map(|_| {
                    seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17;
                    (seed as i32) as f32
                }).collect::<Vec<_>>();
                if case < 3 {
                    query.fill(0.);
                    for j in (0..dim.min(256)).step_by(16) {
                        query[j] = if case == 1 { -1. } else { 1. };
                    }
                    if case == 2 { query.fill(0.); }
                }
                let q = AsymQuerySm::encode(&query).unwrap();
                let pos = (0..q.chunks).map(|_| {
                    seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; seed
                }).collect::<Vec<_>>();
                let strong = pos.iter().map(|v| v.rotate_left(13)).collect::<Vec<_>>();
                let expected = q.masked_sums(&pos, &strong, AsymKernel::Scalar);
                for kernel in [AsymKernel::Auto, AsymKernel::Avx2, AsymKernel::Avx2Lut] {
                    assert_eq!(q.masked_sums(&pos, &strong, kernel), expected, "{dim} {case} {kernel:?}");
                }
                // Check the absolute worst-case sum of every lane before i32 widening.
                for start in (0..q.values.len()).step_by(256) {
                    for lane in 0..16 {
                        let total: i32 = q.values[start..q.values.len().min(start + 256)]
                            .iter().skip(lane).step_by(16).map(|&v| (v as i32).abs()).sum();
                        assert!(total <= 32408, "dim={dim} lane={lane} sum={total}");
                    }
                }
            }
        }
        assert!(AsymQuerySm::encode(&[f32::NAN]).is_err());
        assert!(AsymQuerySm::encode(&[]).is_err());
    }

    #[test]
    fn calibrated_cosine_handles_zero_and_sparse_orthogonal_vectors() {
        let a = SmCodeParams { weak: 0., delta: 1., sigma: 1., strong_ones: 1 };
        assert_eq!(a.calibrated_cosine(a, [2, 1, 1, 0, 0], 65), 0.);
        let q = AsymQuerySm::encode(&[1., 0.]).unwrap();
        assert_eq!(q.calibrated_cosine(&[2], &[2], a, AsymKernel::Auto), 0.);
        assert_eq!(q.calibrated_cosine(&[1], &[1], a, AsymKernel::Auto), 1.);
    }
}