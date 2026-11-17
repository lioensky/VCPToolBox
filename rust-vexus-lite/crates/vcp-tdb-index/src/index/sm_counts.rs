//! Shared zero-copy SM five-count kernels.
//! Adapted from Pelorus quantization/reconstruction.rs (Apache-2.0).
//! Copyright 2024 TriviumDB Authors (https://github.com/YoKONCy).
//! VCP modifications: checked slice boundary, shared fixed/dynamic dispatch,
//! independent counters, exact-size loads and arbitrary dirty-tail tests.

#[cfg(target_arch = "x86_64")]
use super::{X86_BIT_KERNEL, X86BitKernel};

/// Counts are [diff, diff & strong_a, diff & strong_b, both, diff & both].
#[inline]
pub(crate) fn counts(a: &[u64], sa: &[u64], b: &[u64], sb: &[u64], dim: usize) -> [u32; 5] {
    let words = dim.div_ceil(64);
    assert!(a.len() >= words && sa.len() >= words && b.len() >= words && sb.len() >= words);
    #[cfg(target_arch = "x86_64")]
    unsafe {
        match *X86_BIT_KERNEL {
            #[cfg(not(coverage))]
            X86BitKernel::Avx512Vpopcnt => return avx512(a, sa, b, sb, dim),
            X86BitKernel::Avx2Popcnt => {
                if dim < 512 {
                    return popcnt(a, sa, b, sb, dim);
                }
                return avx2_popcnt(a, sa, b, sb, dim);
            }
            X86BitKernel::Avx2Only => return avx2(a, sa, b, sb, dim),
            X86BitKernel::Popcnt => return popcnt(a, sa, b, sb, dim),
            X86BitKernel::Scalar => {}
        }
    }
    scalar(a, sa, b, sb, dim)
}

#[inline]
pub(crate) fn scalar(a: &[u64], sa: &[u64], b: &[u64], sb: &[u64], dim: usize) -> [u32; 5] {
    let mut sums = [0; 5];
    for i in 0..dim.div_ceil(64) {
        let mask = if i == dim / 64 && dim % 64 != 0 { (1u64 << (dim % 64)) - 1 } else { u64::MAX };
        let m = (a[i] ^ b[i]) & mask;
        let both = sa[i] & sb[i] & mask;
        let values = [m, m & sa[i], m & sb[i], both, m & both];
        for k in 0..5 {
            sums[k] += values[k].count_ones();
        }
    }
    sums
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "popcnt")]
unsafe fn popcnt(a: &[u64], sa: &[u64], b: &[u64], sb: &[u64], dim: usize) -> [u32; 5] {
    // Keep the loop inside the target-feature boundary so LLVM emits POPCNT.
    let mut sums = [0; 5];
    for i in 0..dim.div_ceil(64) {
        let mask = if i == dim / 64 && dim % 64 != 0 { (1u64 << (dim % 64)) - 1 } else { u64::MAX };
        let m = (a[i] ^ b[i]) & mask;
        let both = sa[i] & sb[i] & mask;
        sums[0] += m.count_ones();
        sums[1] += (m & sa[i]).count_ones();
        sums[2] += (m & sb[i]).count_ones();
        sums[3] += both.count_ones();
        sums[4] += (m & both).count_ones();
    }
    sums
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2,popcnt")]
unsafe fn avx2_popcnt(a: &[u64], sa: &[u64], b: &[u64], sb: &[u64], dim: usize) -> [u32; 5] {
    let full = dim / 256 * 256;
    let mut sums = unsafe { avx2(a, sa, b, sb, full) };
    let start = full / 64;
    let tail = unsafe { popcnt(&a[start..], &sa[start..], &b[start..], &sb[start..], dim - full) };
    for k in 0..5 { sums[k] += tail[k]; }
    sums
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn avx2(a: &[u64], sa: &[u64], b: &[u64], sb: &[u64], dim: usize) -> [u32; 5] {
    use std::arch::x86_64::*;
    unsafe {
        let rounds = dim / 256;
        let mut acc = [_mm256_setzero_si256(); 5];
        let load = |r: usize| {
            let offset = r * 4;
            let pa = _mm256_loadu_si256(a.as_ptr().add(offset).cast());
            let ha = _mm256_loadu_si256(sa.as_ptr().add(offset).cast());
            let pb = _mm256_loadu_si256(b.as_ptr().add(offset).cast());
            let hb = _mm256_loadu_si256(sb.as_ptr().add(offset).cast());
            let m = _mm256_xor_si256(pa, pb);
            let both = _mm256_and_si256(ha, hb);
            [m, _mm256_and_si256(m, ha), _mm256_and_si256(m, hb), both, _mm256_and_si256(m, both)]
        };
        let mut r = 0;
        while r + 3 <= rounds {
            let x = load(r);
            let y = load(r + 1);
            let z = load(r + 2);
            for k in 0..5 {
                // Three inputs -> ones + 2*twos; 15 popcounts become 10.
                let t = _mm256_xor_si256(x[k], y[k]);
                let ones = _mm256_xor_si256(t, z[k]);
                let twos = _mm256_or_si256(_mm256_and_si256(x[k], y[k]), _mm256_and_si256(t, z[k]));
                let total = _mm256_add_epi64(super::popcnt256(ones), _mm256_slli_epi64(super::popcnt256(twos), 1));
                acc[k] = _mm256_add_epi64(acc[k], total);
            }
            r += 3;
        }
        while r < rounds {
            let values = load(r);
            for k in 0..5 { acc[k] = _mm256_add_epi64(acc[k], super::popcnt256(values[k])); }
            r += 1;
        }
        let mut sums = acc.map(|v| {
            let s = _mm_add_epi64(_mm256_castsi256_si128(v), _mm256_extracti128_si256(v, 1));
            _mm_cvtsi128_si64(_mm_add_epi64(s, _mm_srli_si128(s, 8))) as u32
        });
        let start = rounds * 4;
        let tail = scalar(&a[start..], &sa[start..], &b[start..], &sb[start..], dim - rounds * 256);
        for k in 0..5 { sums[k] += tail[k]; }
        sums
    }
}

#[cfg(all(target_arch = "x86_64", not(coverage)))]
#[target_feature(enable = "avx512f,avx512vpopcntdq,popcnt")]
unsafe fn avx512(a: &[u64], sa: &[u64], b: &[u64], sb: &[u64], dim: usize) -> [u32; 5] {
    use std::arch::x86_64::*;
    unsafe {
        let rounds = dim / 512;
        let mut acc = [_mm512_setzero_si512(); 5];
        for r in 0..rounds {
            let offset = r * 8;
            let pa = _mm512_loadu_si512(a.as_ptr().add(offset).cast());
            let ha = _mm512_loadu_si512(sa.as_ptr().add(offset).cast());
            let pb = _mm512_loadu_si512(b.as_ptr().add(offset).cast());
            let hb = _mm512_loadu_si512(sb.as_ptr().add(offset).cast());
            let m = _mm512_xor_si512(pa, pb);
            let both = _mm512_and_si512(ha, hb);
            let values = [m, _mm512_and_si512(m, ha), _mm512_and_si512(m, hb), both, _mm512_and_si512(m, both)];
            for k in 0..5 { acc[k] = _mm512_add_epi64(acc[k], _mm512_popcnt_epi64(values[k])); }
        }
        let mut sums = acc.map(|v| _mm512_reduce_add_epi64(v) as u32);
        let start = rounds * 8;
        let tail = popcnt(&a[start..], &sa[start..], &b[start..], &sb[start..], dim - rounds * 512);
        for k in 0..5 { sums[k] += tail[k]; }
        sums
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_available_kernel_matches_independent_bit_oracle() {
        let mut state = 0x91ac_3f17_1234_5678u64;
        for dim in [0usize, 1, 63, 65, 255, 256, 257, 384, 511, 512, 767, 768, 769, 1536, 3072, 4095, 4096] {
            for case in 0..128 {
                // Exact-length allocations; dirty padding must be ignored.
                let planes: [Vec<u64>; 4] = std::array::from_fn(|_| {
                    (0..dim.div_ceil(64)).map(|_| {
                        state ^= state << 13; state ^= state >> 7; state ^= state << 17;
                        match case { 0 => 0, 1 => u64::MAX, _ => state }
                    }).collect()
                });
                let [a, sa, b, sb] = &planes;
                let mut expected = [0; 5];
                for bit in 0..dim {
                    let get = |p: &[u64]| (p[bit / 64] >> (bit % 64)) & 1 != 0;
                    let diff = get(a) != get(b);
                    let ha = get(sa); let hb = get(sb);
                    let values = [diff, diff && ha, diff && hb, ha && hb, diff && ha && hb];
                    for k in 0..5 { expected[k] += u32::from(values[k]); }
                }
                assert_eq!(scalar(a, sa, b, sb, dim), expected);
                assert_eq!(counts(a, sa, b, sb, dim), expected);
                #[cfg(target_arch = "x86_64")]
                unsafe {
                    if is_x86_feature_detected!("popcnt") {
                        assert_eq!(popcnt(a, sa, b, sb, dim), expected);
                    }
                    if is_x86_feature_detected!("avx2") {
                        assert_eq!(avx2(a, sa, b, sb, dim), expected);
                        if is_x86_feature_detected!("popcnt") {
                            assert_eq!(avx2_popcnt(a, sa, b, sb, dim), expected);
                        }
                    }
                    #[cfg(not(coverage))]
                    if !*super::super::FORCE_NO_AVX512
                        && is_x86_feature_detected!("avx512f")
                        && is_x86_feature_detected!("avx512vpopcntdq")
                        && is_x86_feature_detected!("popcnt")
                    {
                        assert_eq!(avx512(a, sa, b, sb, dim), expected);
                    }
                }
            }
        }
        #[cfg(target_arch = "x86_64")]
        eprintln!("SM_BIT_KERNEL={:?}", *X86_BIT_KERNEL);
    }
}