//! QuIVer 使用的二值/多比特量化签名与 Hamming 预筛。
//!
//! 编码只保存紧凑近似信号，最终排序仍读取原始向量精排。位布局和 chunk 数属于磁盘
//! 契约，维度上限与尾部掩码必须在编码前验证，避免移位溢出或跨版本误读。

use crate::VectorType;
use bytemuck::{Pod, Zeroable};

/// 环境变量 `TRIVIUM_NO_AVX512=1` 时强制禁用 AVX-512 路径（用于消融实验）
#[cfg(all(target_arch = "x86_64", not(coverage)))]
pub(crate) static FORCE_NO_AVX512: std::sync::LazyLock<bool> =
    std::sync::LazyLock::new(|| std::env::var("TRIVIUM_NO_AVX512").is_ok_and(|v| v == "1"));
pub(crate) static FORCE_NO_384_KERNEL: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| {
    std::env::var("TRIVIUM_DISABLE_384_KERNEL").is_ok_and(|value| value == "1")
});

/// BQ 签名最大 chunks 数量（每个 u64 chunk 覆盖 64 维）
/// 48 chunks × 64 bits = 3072 维上限
const MAX_BQ_CHUNKS: usize = 48;
pub const MAX_BQ_DIM: usize = MAX_BQ_CHUNKS * 64;

/// 二进制量化指纹 (Binary Quantization Fingerprint)
///
/// 标准 1-bit LSH 实现，将 f32 向量降维到位向量。
/// 使用 XOR + Popcount 计算 Hamming 距离。
///
/// 最大支持 3072 维（48 × 64 bits）。
#[repr(C)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct BqSignature {
    pub data: [u64; MAX_BQ_CHUNKS],
}

impl Default for BqSignature {
    fn default() -> Self {
        Self {
            data: [0u64; MAX_BQ_CHUNKS],
        }
    }
}

impl BqSignature {
    /// 最大 chunks 数量
    pub const MAX_CHUNKS: usize = MAX_BQ_CHUNKS;

    /// 预分配一个全零签名
    pub fn empty() -> Self {
        Self::default()
    }

    /// 1-bit 二值量化：> 0.0 的维度置为 1
    pub fn from_vector<T: VectorType>(vec: &[T]) -> Self {
        let mut data = [0u64; MAX_BQ_CHUNKS];
        let chunks = vec.len().div_ceil(64).min(MAX_BQ_CHUNKS);
        for i in 0..chunks {
            let mut chunk_bits = 0u64;
            for j in 0..64 {
                let idx = i * 64 + j;
                if idx < vec.len() && vec[idx].to_f32() > 0.0 {
                    chunk_bits |= 1u64 << j;
                }
            }
            data[i] = chunk_bits;
        }
        Self { data }
    }

    /// Hamming 距离
    #[inline]
    pub fn hamming_distance(&self, other: &Self) -> u32 {
        self.data
            .iter()
            .zip(other.data.iter())
            .map(|(a, b)| (a ^ b).count_ones())
            .sum()
    }
}

// ═════════════════════════════════════════════════════════════
//  2-bit Sign-Magnitude BQ 签名
// ═════════════════════════════════════════════════════════════

#[repr(C)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Pod, Zeroable)]
pub struct Bq2Signature {
    pub pos: [u64; MAX_BQ_CHUNKS],
    pub strong: [u64; MAX_BQ_CHUNKS],
}

impl Default for Bq2Signature {
    fn default() -> Self {
        Self {
            pos: [0u64; MAX_BQ_CHUNKS],
            strong: [0u64; MAX_BQ_CHUNKS],
        }
    }
}

impl Bq2Signature {
    /// 最大 chunks 数量
    pub const MAX_CHUNKS: usize = MAX_BQ_CHUNKS;

    pub fn empty() -> Self {
        Self::default()
    }

    pub fn from_vector<T: crate::VectorType>(vec: &[T]) -> Self {
        let mut pos = [0u64; MAX_BQ_CHUNKS];
        let mut strong = [0u64; MAX_BQ_CHUNKS];

        let mut sum_abs = 0.0;
        for v in vec {
            sum_abs += v.to_f32().abs();
        }
        let alpha = if vec.is_empty() {
            0.0
        } else {
            sum_abs / vec.len() as f32
        };

        let chunks = vec.len().div_ceil(64).min(MAX_BQ_CHUNKS);
        for i in 0..chunks {
            let mut chunk_pos = 0u64;
            let mut chunk_strong = 0u64;
            for j in 0..64 {
                let idx = i * 64 + j;
                if idx < vec.len() {
                    let val = vec[idx].to_f32();
                    if val > 0.0 {
                        chunk_pos |= 1u64 << j;
                    }
                    if val.abs() > alpha {
                        chunk_strong |= 1u64 << j;
                    }
                }
            }
            pos[i] = chunk_pos;
            strong[i] = chunk_strong;
        }
        Self { pos, strong }
    }

    /// 2-bit 加权 Hamming 距离
    ///
    /// 运行时自动选择最优实现：
    ///   x86: AVX-512 VPOPCNTDQ → AVX2 (nibble-lookup) → 标量
    ///   ARM: NEON (vcntq_u8) → 标量
    #[inline]
    pub fn distance(&self, other: &Self, dim: usize) -> u32 {
        if !dim.is_multiple_of(64) {
            return self.distance_scalar(other, dim);
        }
        #[cfg(target_arch = "x86_64")]
        {
            #[cfg(not(coverage))]
            if !*FORCE_NO_AVX512
                && is_x86_feature_detected!("avx512vpopcntdq")
                && is_x86_feature_detected!("avx512f")
            {
                return unsafe { self.distance_avx512(other, dim) };
            }
            if is_x86_feature_detected!("avx2") {
                return unsafe {
                    bq2_distance_raw_avx2(
                        self.pos.as_ptr(),
                        self.strong.as_ptr(),
                        other.pos.as_ptr(),
                        other.strong.as_ptr(),
                        dim,
                    )
                };
            }
        }
        #[cfg(all(target_arch = "aarch64", not(coverage)))]
        {
            unsafe {
                bq2_distance_raw_neon(
                    self.pos.as_ptr(),
                    self.strong.as_ptr(),
                    other.pos.as_ptr(),
                    other.strong.as_ptr(),
                    dim,
                )
            }
        }
        #[cfg(any(not(target_arch = "aarch64"), coverage))]
        self.distance_scalar(other, dim)
    }

    /// 标量回退路径（所有平台通用）
    #[inline]
    fn distance_scalar(&self, other: &Self, dim: usize) -> u32 {
        let chunks = dim.div_ceil(64);
        let valid_bits_last = if dim.is_multiple_of(64) {
            !0u64
        } else {
            (1u64 << (dim % 64)) - 1
        };

        let mut dot = 0i32;
        for i in 0..chunks {
            let mask = if i == chunks - 1 {
                valid_bits_last
            } else {
                !0u64
            };
            let a1 = self.pos[i] & mask;
            let b1 = self.strong[i] & mask;
            let a2 = other.pos[i] & mask;
            let b2 = other.strong[i] & mask;

            let same = !(a1 ^ a2) & mask;
            let diff = (a1 ^ a2) & mask;
            let both_strong = b1 & b2 & mask;
            let one_strong = (b1 ^ b2) & mask;
            let both_weak = !(b1 | b2) & mask;

            let w4_pos = same & both_strong;
            let w4_neg = diff & both_strong;
            let w2_pos = same & one_strong;
            let w2_neg = diff & one_strong;
            let w1_pos = same & both_weak;
            let w1_neg = diff & both_weak;

            dot += 4 * w4_pos.count_ones() as i32;
            dot -= 4 * w4_neg.count_ones() as i32;
            dot += 2 * w2_pos.count_ones() as i32;
            dot -= 2 * w2_neg.count_ones() as i32;
            dot += w1_pos.count_ones() as i32;
            dot -= w1_neg.count_ones() as i32;
        }

        let max_dot = 4 * dim as i32;
        (max_dot - dot) as u32
    }

    /// AVX-512 VPOPCNTDQ 加速路径
    ///
    /// 核心思路：每次处理 8 个 u64（512 bit），用硬件 popcount 指令
    /// 将 12 个 chunk（dim=768）的循环压缩到 2 轮 512-bit 操作。
    ///
    /// 6 类权重的 popcount 结果分别累加到 __m512i 寄存器中，
    /// 最后做一次水平求和。
    #[cfg(all(target_arch = "x86_64", not(coverage)))]
    #[target_feature(enable = "avx512f,avx512vpopcntdq")]
    unsafe fn distance_avx512(&self, other: &Self, dim: usize) -> u32 {
        unsafe {
            use std::arch::x86_64::*;

            let chunks = dim.div_ceil(64);
            let full_rounds = chunks / 8;
            let remainder = chunks % 8;

            let mut acc_w4_pos = _mm512_setzero_si512();
            let mut acc_w4_neg = _mm512_setzero_si512();
            let mut acc_w2_pos = _mm512_setzero_si512();
            let mut acc_w2_neg = _mm512_setzero_si512();
            let mut acc_w1_pos = _mm512_setzero_si512();
            let mut acc_w1_neg = _mm512_setzero_si512();

            let ones_mask = _mm512_set1_epi64(-1i64);

            for r in 0..full_rounds {
                let off = r * 8;
                let a1 = _mm512_loadu_si512(self.pos.as_ptr().add(off) as *const _);
                let b1 = _mm512_loadu_si512(self.strong.as_ptr().add(off) as *const _);
                let a2 = _mm512_loadu_si512(other.pos.as_ptr().add(off) as *const _);
                let b2 = _mm512_loadu_si512(other.strong.as_ptr().add(off) as *const _);

                let xor_ab = _mm512_xor_si512(a1, a2);
                let same = _mm512_xor_si512(xor_ab, ones_mask);
                let diff = xor_ab;

                let both_strong = _mm512_and_si512(b1, b2);
                let one_strong = _mm512_xor_si512(b1, b2);
                let b_or = _mm512_or_si512(b1, b2);
                let both_weak = _mm512_xor_si512(b_or, ones_mask);

                acc_w4_pos = _mm512_add_epi64(
                    acc_w4_pos,
                    _mm512_popcnt_epi64(_mm512_and_si512(same, both_strong)),
                );
                acc_w4_neg = _mm512_add_epi64(
                    acc_w4_neg,
                    _mm512_popcnt_epi64(_mm512_and_si512(diff, both_strong)),
                );
                acc_w2_pos = _mm512_add_epi64(
                    acc_w2_pos,
                    _mm512_popcnt_epi64(_mm512_and_si512(same, one_strong)),
                );
                acc_w2_neg = _mm512_add_epi64(
                    acc_w2_neg,
                    _mm512_popcnt_epi64(_mm512_and_si512(diff, one_strong)),
                );
                acc_w1_pos = _mm512_add_epi64(
                    acc_w1_pos,
                    _mm512_popcnt_epi64(_mm512_and_si512(same, both_weak)),
                );
                acc_w1_neg = _mm512_add_epi64(
                    acc_w1_neg,
                    _mm512_popcnt_epi64(_mm512_and_si512(diff, both_weak)),
                );
            }

            let hsum = |v: __m512i| -> i64 { _mm512_reduce_add_epi64(v) };

            let mut dot = 0i64;
            dot += 4 * hsum(acc_w4_pos);
            dot -= 4 * hsum(acc_w4_neg);
            dot += 2 * hsum(acc_w2_pos);
            dot -= 2 * hsum(acc_w2_neg);
            dot += hsum(acc_w1_pos);
            dot -= hsum(acc_w1_neg);

            // 余数部分（标量）
            if remainder > 0 {
                let start = full_rounds * 8;
                let valid_bits_last = if dim.is_multiple_of(64) {
                    !0u64
                } else {
                    (1u64 << (dim % 64)) - 1
                };
                for i in start..chunks {
                    let mask = if i == chunks - 1 {
                        valid_bits_last
                    } else {
                        !0u64
                    };
                    let a1 = self.pos[i] & mask;
                    let b1 = self.strong[i] & mask;
                    let a2 = other.pos[i] & mask;
                    let b2 = other.strong[i] & mask;

                    let same = !(a1 ^ a2) & mask;
                    let diff = (a1 ^ a2) & mask;
                    let both_strong = b1 & b2 & mask;
                    let one_strong = (b1 ^ b2) & mask;
                    let both_weak = !(b1 | b2) & mask;

                    dot += 4 * (same & both_strong).count_ones() as i64;
                    dot -= 4 * (diff & both_strong).count_ones() as i64;
                    dot += 2 * (same & one_strong).count_ones() as i64;
                    dot -= 2 * (diff & one_strong).count_ones() as i64;
                    dot += (same & both_weak).count_ones() as i64;
                    dot -= (diff & both_weak).count_ones() as i64;
                }
            }

            let max_dot = 4 * dim as i64;
            (max_dot - dot) as u32
        }
    }
}

/// 零拷贝距离计算：直接在 pos/strong 指针上计算 2-bit 加权 Hamming 距离
///
/// 这是所有 BQ2 距离计算的核心热路径，避免 Bq2Signature 临时对象的创建。
/// 分发：AVX-512 VPOPCNTDQ → AVX2 → NEON → 标量
#[inline]
fn bq2_distance_raw(
    pos_a: *const u64,
    strong_a: *const u64,
    pos_b: *const u64,
    strong_b: *const u64,
    dim: usize,
) -> u32 {
    if !dim.is_multiple_of(64) {
        return bq2_distance_raw_scalar(pos_a, strong_a, pos_b, strong_b, dim);
    }
    #[cfg(target_arch = "x86_64")]
    {
        #[cfg(not(coverage))]
        if !*FORCE_NO_AVX512
            && is_x86_feature_detected!("avx512vpopcntdq")
            && is_x86_feature_detected!("avx512f")
        {
            return unsafe { bq2_distance_raw_avx512(pos_a, strong_a, pos_b, strong_b, dim) };
        }
        if is_x86_feature_detected!("avx2") {
            return unsafe { bq2_distance_raw_avx2(pos_a, strong_a, pos_b, strong_b, dim) };
        }
    }
    #[cfg(all(target_arch = "aarch64", not(coverage)))]
    {
        return unsafe { bq2_distance_raw_neon(pos_a, strong_a, pos_b, strong_b, dim) };
    }
    #[allow(unreachable_code)]
    bq2_distance_raw_scalar(pos_a, strong_a, pos_b, strong_b, dim)
}

#[cfg(all(target_arch = "x86_64", test))]
#[target_feature(enable = "popcnt")]
unsafe fn bq2_distance_raw_popcnt_384(
    pos_a: *const u64,
    strong_a: *const u64,
    pos_b: *const u64,
    strong_b: *const u64,
) -> u32 {
    let mut dot = 0i32;
    for index in 0..6 {
        let a1 = unsafe { *pos_a.add(index) };
        let b1 = unsafe { *strong_a.add(index) };
        let a2 = unsafe { *pos_b.add(index) };
        let b2 = unsafe { *strong_b.add(index) };
        let diff = a1 ^ a2;
        let same = !diff;
        let both_strong = b1 & b2;
        let one_strong = b1 ^ b2;
        let both_weak = !(b1 | b2);
        dot += 4 * (same & both_strong).count_ones() as i32;
        dot -= 4 * (diff & both_strong).count_ones() as i32;
        dot += 2 * (same & one_strong).count_ones() as i32;
        dot -= 2 * (diff & one_strong).count_ones() as i32;
        dot += (same & both_weak).count_ones() as i32;
        dot -= (diff & both_weak).count_ones() as i32;
    }

    (1536 - dot) as u32
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "popcnt")]
unsafe fn bq2_distance_cheap_popcnt_384(
    pos_a: *const u64,
    strong_a: *const u64,
    pos_b: *const u64,
    strong_b: *const u64,
) -> u32 {
    let mut distance = 0u32;
    for index in 0..6 {
        distance += (unsafe { *pos_a.add(index) } ^ unsafe { *pos_b.add(index) }).count_ones();
        distance +=
            (unsafe { *strong_a.add(index) } ^ unsafe { *strong_b.add(index) }).count_ones();
    }
    distance
}

#[inline]
fn bq2_distance_raw_scalar(
    pos_a: *const u64,
    strong_a: *const u64,
    pos_b: *const u64,
    strong_b: *const u64,
    dim: usize,
) -> u32 {
    let chunks = dim.div_ceil(64);
    let valid_bits_last = if dim.is_multiple_of(64) {
        !0u64
    } else {
        (1u64 << (dim % 64)) - 1
    };

    let mut dot = 0i32;
    for i in 0..chunks {
        let mask = if i == chunks - 1 {
            valid_bits_last
        } else {
            !0u64
        };
        let a1 = unsafe { *pos_a.add(i) } & mask;
        let b1 = unsafe { *strong_a.add(i) } & mask;
        let a2 = unsafe { *pos_b.add(i) } & mask;
        let b2 = unsafe { *strong_b.add(i) } & mask;

        let same = !(a1 ^ a2) & mask;
        let diff = (a1 ^ a2) & mask;
        let both_strong = b1 & b2 & mask;
        let one_strong = (b1 ^ b2) & mask;
        let both_weak = !(b1 | b2) & mask;

        dot += 4 * (same & both_strong).count_ones() as i32;
        dot -= 4 * (diff & both_strong).count_ones() as i32;
        dot += 2 * (same & one_strong).count_ones() as i32;
        dot -= 2 * (diff & one_strong).count_ones() as i32;
        dot += (same & both_weak).count_ones() as i32;
        dot -= (diff & both_weak).count_ones() as i32;
    }
    let max_dot = 4 * dim as i32;
    (max_dot - dot) as u32
}

#[cfg(all(target_arch = "x86_64", not(coverage)))]
#[target_feature(enable = "avx512f,avx512vpopcntdq")]
unsafe fn bq2_distance_raw_avx512(
    pos_a: *const u64,
    strong_a: *const u64,
    pos_b: *const u64,
    strong_b: *const u64,
    dim: usize,
) -> u32 {
    unsafe {
        use std::arch::x86_64::*;

        let chunks = dim.div_ceil(64);
        let full_rounds = chunks / 8;
        let remainder = chunks % 8;

        let mut acc_w4_pos = _mm512_setzero_si512();
        let mut acc_w4_neg = _mm512_setzero_si512();
        let mut acc_w2_pos = _mm512_setzero_si512();
        let mut acc_w2_neg = _mm512_setzero_si512();
        let mut acc_w1_pos = _mm512_setzero_si512();
        let mut acc_w1_neg = _mm512_setzero_si512();
        let ones_mask = _mm512_set1_epi64(-1i64);

        for r in 0..full_rounds {
            let off = r * 8;
            let a1 = _mm512_loadu_si512(pos_a.add(off) as *const _);
            let b1 = _mm512_loadu_si512(strong_a.add(off) as *const _);
            let a2 = _mm512_loadu_si512(pos_b.add(off) as *const _);
            let b2 = _mm512_loadu_si512(strong_b.add(off) as *const _);

            let xor_ab = _mm512_xor_si512(a1, a2);
            let same = _mm512_xor_si512(xor_ab, ones_mask);
            let diff = xor_ab;
            let both_strong = _mm512_and_si512(b1, b2);
            let one_strong = _mm512_xor_si512(b1, b2);
            let b_or = _mm512_or_si512(b1, b2);
            let both_weak = _mm512_xor_si512(b_or, ones_mask);

            acc_w4_pos = _mm512_add_epi64(
                acc_w4_pos,
                _mm512_popcnt_epi64(_mm512_and_si512(same, both_strong)),
            );
            acc_w4_neg = _mm512_add_epi64(
                acc_w4_neg,
                _mm512_popcnt_epi64(_mm512_and_si512(diff, both_strong)),
            );
            acc_w2_pos = _mm512_add_epi64(
                acc_w2_pos,
                _mm512_popcnt_epi64(_mm512_and_si512(same, one_strong)),
            );
            acc_w2_neg = _mm512_add_epi64(
                acc_w2_neg,
                _mm512_popcnt_epi64(_mm512_and_si512(diff, one_strong)),
            );
            acc_w1_pos = _mm512_add_epi64(
                acc_w1_pos,
                _mm512_popcnt_epi64(_mm512_and_si512(same, both_weak)),
            );
            acc_w1_neg = _mm512_add_epi64(
                acc_w1_neg,
                _mm512_popcnt_epi64(_mm512_and_si512(diff, both_weak)),
            );
        }

        let hsum = |v: __m512i| -> i64 { _mm512_reduce_add_epi64(v) };
        let mut dot = 0i64;
        dot += 4 * hsum(acc_w4_pos);
        dot -= 4 * hsum(acc_w4_neg);
        dot += 2 * hsum(acc_w2_pos);
        dot -= 2 * hsum(acc_w2_neg);
        dot += hsum(acc_w1_pos);
        dot -= hsum(acc_w1_neg);

        if remainder > 0 {
            let start = full_rounds * 8;
            let valid_bits_last = if dim.is_multiple_of(64) {
                !0u64
            } else {
                (1u64 << (dim % 64)) - 1
            };
            for i in start..chunks {
                let mask = if i == chunks - 1 {
                    valid_bits_last
                } else {
                    !0u64
                };
                let a1 = *pos_a.add(i) & mask;
                let b1 = *strong_a.add(i) & mask;
                let a2 = *pos_b.add(i) & mask;
                let b2 = *strong_b.add(i) & mask;
                let same = !(a1 ^ a2) & mask;
                let diff = (a1 ^ a2) & mask;
                let both_strong = b1 & b2 & mask;
                let one_strong = (b1 ^ b2) & mask;
                let both_weak = !(b1 | b2) & mask;
                dot += 4 * (same & both_strong).count_ones() as i64;
                dot -= 4 * (diff & both_strong).count_ones() as i64;
                dot += 2 * (same & one_strong).count_ones() as i64;
                dot -= 2 * (diff & one_strong).count_ones() as i64;
                dot += (same & both_weak).count_ones() as i64;
                dot -= (diff & both_weak).count_ones() as i64;
            }
        }
        let max_dot = 4 * dim as i64;
        (max_dot - dot) as u32
    }
}

// ═════════════════════════════════════════════════════════════
//  AVX2 BQ2 距离（nibble-lookup popcount）
// ═════════════════════════════════════════════════════════════

/// AVX2 软件 popcount：nibble 查表法，返回每个 64-bit lane 的 popcount
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
#[inline]
unsafe fn popcnt256(v: std::arch::x86_64::__m256i) -> std::arch::x86_64::__m256i {
    use std::arch::x86_64::*;
    {
        let low_mask = _mm256_set1_epi8(0x0F);
        // 每个 nibble (0-15) 的 popcount 查找表
        let lookup = _mm256_setr_epi8(
            0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4, 0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2,
            3, 3, 4,
        );
        let lo = _mm256_and_si256(v, low_mask);
        let hi = _mm256_and_si256(_mm256_srli_epi16(v, 4), low_mask);
        let cnt = _mm256_add_epi8(
            _mm256_shuffle_epi8(lookup, lo),
            _mm256_shuffle_epi8(lookup, hi),
        );
        // 字节级 popcount → 每 64-bit lane 求和（sad_epu8 对零做差的绝对值求和）
        _mm256_sad_epu8(cnt, _mm256_setzero_si256())
    }
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn bq2_distance_raw_avx2(
    pos_a: *const u64,
    strong_a: *const u64,
    pos_b: *const u64,
    strong_b: *const u64,
    dim: usize,
) -> u32 {
    use std::arch::x86_64::*;
    unsafe {
        let chunks = dim.div_ceil(64);
        let full_rounds = chunks / 4;
        let remainder = chunks % 4;

        let mut acc_w4_pos = _mm256_setzero_si256();
        let mut acc_w4_neg = _mm256_setzero_si256();
        let mut acc_w2_pos = _mm256_setzero_si256();
        let mut acc_w2_neg = _mm256_setzero_si256();
        let mut acc_w1_pos = _mm256_setzero_si256();
        let mut acc_w1_neg = _mm256_setzero_si256();
        let ones = _mm256_set1_epi64x(-1i64);

        for r in 0..full_rounds {
            let off = r * 4;
            let a1 = _mm256_loadu_si256(pos_a.add(off) as *const __m256i);
            let b1 = _mm256_loadu_si256(strong_a.add(off) as *const __m256i);
            let a2 = _mm256_loadu_si256(pos_b.add(off) as *const __m256i);
            let b2 = _mm256_loadu_si256(strong_b.add(off) as *const __m256i);

            let xor_ab = _mm256_xor_si256(a1, a2);
            let same = _mm256_xor_si256(xor_ab, ones);
            let diff = xor_ab;
            let both_strong = _mm256_and_si256(b1, b2);
            let one_strong = _mm256_xor_si256(b1, b2);
            let both_weak = _mm256_xor_si256(_mm256_or_si256(b1, b2), ones);

            acc_w4_pos =
                _mm256_add_epi64(acc_w4_pos, popcnt256(_mm256_and_si256(same, both_strong)));
            acc_w4_neg =
                _mm256_add_epi64(acc_w4_neg, popcnt256(_mm256_and_si256(diff, both_strong)));
            acc_w2_pos =
                _mm256_add_epi64(acc_w2_pos, popcnt256(_mm256_and_si256(same, one_strong)));
            acc_w2_neg =
                _mm256_add_epi64(acc_w2_neg, popcnt256(_mm256_and_si256(diff, one_strong)));
            acc_w1_pos = _mm256_add_epi64(acc_w1_pos, popcnt256(_mm256_and_si256(same, both_weak)));
            acc_w1_neg = _mm256_add_epi64(acc_w1_neg, popcnt256(_mm256_and_si256(diff, both_weak)));
        }

        // 水平归约：4 个 i64 lane 求和
        let hsum = |v: __m256i| -> i64 {
            let hi = _mm256_extracti128_si256(v, 1);
            let lo = _mm256_castsi256_si128(v);
            let s = _mm_add_epi64(lo, hi);
            let hi64 = _mm_srli_si128(s, 8);
            _mm_cvtsi128_si64(_mm_add_epi64(s, hi64))
        };

        let mut dot = 0i64;
        dot += 4 * hsum(acc_w4_pos);
        dot -= 4 * hsum(acc_w4_neg);
        dot += 2 * hsum(acc_w2_pos);
        dot -= 2 * hsum(acc_w2_neg);
        dot += hsum(acc_w1_pos);
        dot -= hsum(acc_w1_neg);

        // 余数（标量）
        if remainder > 0 {
            let start = full_rounds * 4;
            let valid_bits_last = if dim.is_multiple_of(64) {
                !0u64
            } else {
                (1u64 << (dim % 64)) - 1
            };
            for i in start..chunks {
                let mask = if i == chunks - 1 {
                    valid_bits_last
                } else {
                    !0u64
                };
                let a1 = *pos_a.add(i) & mask;
                let b1 = *strong_a.add(i) & mask;
                let a2 = *pos_b.add(i) & mask;
                let b2 = *strong_b.add(i) & mask;
                let same = !(a1 ^ a2) & mask;
                let diff = (a1 ^ a2) & mask;
                let both_strong = b1 & b2 & mask;
                let one_strong = (b1 ^ b2) & mask;
                let both_weak = !(b1 | b2) & mask;
                dot += 4 * (same & both_strong).count_ones() as i64;
                dot -= 4 * (diff & both_strong).count_ones() as i64;
                dot += 2 * (same & one_strong).count_ones() as i64;
                dot -= 2 * (diff & one_strong).count_ones() as i64;
                dot += (same & both_weak).count_ones() as i64;
                dot -= (diff & both_weak).count_ones() as i64;
            }
        }
        let max_dot = 4 * dim as i64;
        (max_dot - dot) as u32
    }
}

// ═════════════════════════════════════════════════════════════
//  NEON BQ2 距离（vcntq_u8 硬件 popcount）
// ═════════════════════════════════════════════════════════════

#[cfg(all(target_arch = "aarch64", not(coverage)))]
#[target_feature(enable = "neon")]
unsafe fn bq2_distance_raw_neon(
    pos_a: *const u64,
    strong_a: *const u64,
    pos_b: *const u64,
    strong_b: *const u64,
    dim: usize,
) -> u32 {
    use std::arch::aarch64::*;
    unsafe {
        let chunks = dim.div_ceil(64);

        // NEON popcount：字节级 vcnt → 逐级宽化求和 → 得到每 64-bit lane 的 popcount
        let popcnt128 = |v: uint64x2_t| -> int64x2_t {
            let bytes = vcntq_u8(vreinterpretq_u8_u64(v)); // 每字节 popcount
            let h16 = vpaddlq_u8(bytes); // u8→u16 对加
            let h32 = vpaddlq_u16(h16); // u16→u32 对加
            vreinterpretq_s64_u64(vpaddlq_u32(h32)) // u32→u64 对加
        };

        let mut dot = 0i64;
        let valid_bits_last = if dim.is_multiple_of(64) {
            !0u64
        } else {
            (1u64 << (dim % 64)) - 1
        };

        // 每次处理 2 个 u64 chunk
        let full_rounds = if dim.is_multiple_of(64) {
            chunks / 2
        } else {
            chunks.saturating_sub(1) / 2
        };
        let mut acc_w4_pos = vdupq_n_s64(0);
        let mut acc_w4_neg = vdupq_n_s64(0);
        let mut acc_w2_pos = vdupq_n_s64(0);
        let mut acc_w2_neg = vdupq_n_s64(0);
        let mut acc_w1_pos = vdupq_n_s64(0);
        let mut acc_w1_neg = vdupq_n_s64(0);

        for r in 0..full_rounds {
            let off = r * 2;
            let a1 = vld1q_u64(pos_a.add(off));
            let b1 = vld1q_u64(strong_a.add(off));
            let a2 = vld1q_u64(pos_b.add(off));
            let b2 = vld1q_u64(strong_b.add(off));

            let xor_ab = veorq_u64(a1, a2);
            let ones = vdupq_n_u64(!0u64);
            let same = veorq_u64(xor_ab, ones);
            let diff = xor_ab;
            let both_strong = vandq_u64(b1, b2);
            let one_strong = veorq_u64(b1, b2);
            let both_weak = veorq_u64(vorrq_u64(b1, b2), ones);

            acc_w4_pos = vaddq_s64(acc_w4_pos, popcnt128(vandq_u64(same, both_strong)));
            acc_w4_neg = vaddq_s64(acc_w4_neg, popcnt128(vandq_u64(diff, both_strong)));
            acc_w2_pos = vaddq_s64(acc_w2_pos, popcnt128(vandq_u64(same, one_strong)));
            acc_w2_neg = vaddq_s64(acc_w2_neg, popcnt128(vandq_u64(diff, one_strong)));
            acc_w1_pos = vaddq_s64(acc_w1_pos, popcnt128(vandq_u64(same, both_weak)));
            acc_w1_neg = vaddq_s64(acc_w1_neg, popcnt128(vandq_u64(diff, both_weak)));
        }

        // 水平归约
        let hsum = |v: int64x2_t| -> i64 { vaddvq_s64(v) };
        dot += 4 * hsum(acc_w4_pos);
        dot -= 4 * hsum(acc_w4_neg);
        dot += 2 * hsum(acc_w2_pos);
        dot -= 2 * hsum(acc_w2_neg);
        dot += hsum(acc_w1_pos);
        dot -= hsum(acc_w1_neg);

        // 余数（标量）
        let start = full_rounds * 2;
        for i in start..chunks {
            let mask = if i == chunks - 1 {
                valid_bits_last
            } else {
                !0u64
            };
            let a1 = *pos_a.add(i) & mask;
            let b1 = *strong_a.add(i) & mask;
            let a2 = *pos_b.add(i) & mask;
            let b2 = *strong_b.add(i) & mask;
            let same = !(a1 ^ a2) & mask;
            let diff = (a1 ^ a2) & mask;
            let both_strong = b1 & b2 & mask;
            let one_strong = (b1 ^ b2) & mask;
            let both_weak = !(b1 | b2) & mask;
            dot += 4 * (same & both_strong).count_ones() as i64;
            dot -= 4 * (diff & both_strong).count_ones() as i64;
            dot += 2 * (same & one_strong).count_ones() as i64;
            dot -= 2 * (diff & one_strong).count_ones() as i64;
            dot += (same & both_weak).count_ones() as i64;
            dot -= (diff & both_weak).count_ones() as i64;
        }
        let max_dot = 4 * dim as i64;
        (max_dot - dot) as u32
    }
}

#[cfg(all(target_arch = "x86_64", not(coverage)))]
#[target_feature(enable = "avx512f,avx512vpopcntdq")]
unsafe fn bq2_distance_cheap_avx512_768(
    pos_a: *const u64,
    strong_a: *const u64,
    pos_b: *const u64,
    strong_b: *const u64,
) -> u32 {
    unsafe {
        use std::arch::x86_64::*;

        let pa0 = _mm512_loadu_si512(pos_a as *const _);
        let qa0 = _mm512_loadu_si512(pos_b as *const _);
        let sa0 = _mm512_loadu_si512(strong_a as *const _);
        let qs0 = _mm512_loadu_si512(strong_b as *const _);
        let pa1 = _mm256_loadu_si256(pos_a.add(8) as *const _);
        let qa1 = _mm256_loadu_si256(pos_b.add(8) as *const _);
        let sa1 = _mm256_loadu_si256(strong_a.add(8) as *const _);
        let qs1 = _mm256_loadu_si256(strong_b.add(8) as *const _);

        let acc512 = _mm512_add_epi64(
            _mm512_popcnt_epi64(_mm512_xor_si512(pa0, qa0)),
            _mm512_popcnt_epi64(_mm512_xor_si512(sa0, qs0)),
        );
        let acc256 = _mm256_add_epi64(
            _mm256_popcnt_epi64(_mm256_xor_si256(pa1, qa1)),
            _mm256_popcnt_epi64(_mm256_xor_si256(sa1, qs1)),
        );

        let acc256_as512 = _mm512_castsi256_si512(acc256);
        (_mm512_reduce_add_epi64(acc512) + _mm512_reduce_add_epi64(acc256_as512)) as u32
    }
}

#[cfg(all(target_arch = "x86_64", not(coverage)))]
#[target_feature(enable = "avx512f,avx512vpopcntdq")]
unsafe fn bq2_distance_cheap_avx512(
    pos_a: *const u64,
    strong_a: *const u64,
    pos_b: *const u64,
    strong_b: *const u64,
    dim: usize,
) -> u32 {
    unsafe {
        use std::arch::x86_64::*;

        let chunks = dim.div_ceil(64);
        let full_rounds = chunks / 8;
        let remainder = chunks % 8;
        let mut acc_pos = _mm512_setzero_si512();
        let mut acc_strong = _mm512_setzero_si512();

        for r in 0..full_rounds {
            let off = r * 8;
            let pa = _mm512_loadu_si512(pos_a.add(off) as *const _);
            let qa = _mm512_loadu_si512(pos_b.add(off) as *const _);
            let sa = _mm512_loadu_si512(strong_a.add(off) as *const _);
            let qs = _mm512_loadu_si512(strong_b.add(off) as *const _);
            acc_pos = _mm512_add_epi64(acc_pos, _mm512_popcnt_epi64(_mm512_xor_si512(pa, qa)));
            acc_strong =
                _mm512_add_epi64(acc_strong, _mm512_popcnt_epi64(_mm512_xor_si512(sa, qs)));
        }

        let mut pos_dist = _mm512_reduce_add_epi64(acc_pos) as u32;
        let mut strong_dist = _mm512_reduce_add_epi64(acc_strong) as u32;

        if remainder > 0 {
            let start = full_rounds * 8;
            for i in start..chunks {
                pos_dist += (*pos_a.add(i) ^ *pos_b.add(i)).count_ones();
                strong_dist += (*strong_a.add(i) ^ *strong_b.add(i)).count_ones();
            }
        }

        pos_dist + strong_dist
    }
}

// ═════════════════════════════════════════════════════════════
//  紧凑型 BQ2 签名存储（Struct-of-Arrays）
// ═════════════════════════════════════════════════════════════

/// 紧凑型 BQ2 签名存储
///
/// 将 N 个签名存储为两个 flat `Vec<u64>` 数组，
/// 每个签名只占用 `chunks × 8` 字节，消除固定大小结构体的零填充浪费。
pub struct Bq2Store {
    pos: Vec<u64>,
    strong: Vec<u64>,
    /// 每个签名的 u64 chunk 数量（= dim.div_ceil(64)）
    chunks: usize,
    /// 已存储的签名数量
    n: usize,
}

impl Bq2Store {
    /// 创建空的紧凑存储
    pub fn new(dim: usize) -> Self {
        let chunks = if dim == 0 { 1 } else { dim.div_ceil(64) };
        Self {
            pos: Vec::new(),
            strong: Vec::new(),
            chunks,
            n: 0,
        }
    }

    pub fn chunks(&self) -> usize {
        self.chunks
    }
    pub fn len(&self) -> usize {
        self.n
    }
    pub fn is_empty(&self) -> bool {
        self.n == 0
    }

    /// 预分配空间
    pub fn reserve(&mut self, additional: usize) {
        self.pos.reserve(additional * self.chunks);
        self.strong.reserve(additional * self.chunks);
    }

    /// 从向量直接编码并追加（紧凑路径）
    pub fn push_from_vector<T: crate::VectorType>(&mut self, vec: &[T]) {
        let mut sum_abs = 0.0f32;
        for v in vec {
            sum_abs += v.to_f32().abs();
        }
        let alpha = if vec.is_empty() {
            0.0
        } else {
            sum_abs / vec.len() as f32
        };

        for i in 0..self.chunks {
            let mut cp = 0u64;
            let mut cs = 0u64;
            for j in 0..64 {
                let idx = i * 64 + j;
                if idx < vec.len() {
                    let val = vec[idx].to_f32();
                    if val > 0.0 {
                        cp |= 1u64 << j;
                    }
                    if val.abs() > alpha {
                        cs |= 1u64 << j;
                    }
                }
            }
            self.pos.push(cp);
            self.strong.push(cs);
        }
        self.n += 1;
    }

    /// 追加已有的 Bq2Signature（兼容路径）
    pub fn push_sig(&mut self, sig: &Bq2Signature) {
        self.pos.extend_from_slice(&sig.pos[..self.chunks]);
        self.strong.extend_from_slice(&sig.strong[..self.chunks]);
        self.n += 1;
    }

    /// 重建完整的 Bq2Signature（栈上临时对象）
    #[inline]
    pub fn get_sig(&self, idx: usize) -> Bq2Signature {
        let mut sig = Bq2Signature::empty();
        let off = idx * self.chunks;
        sig.pos[..self.chunks].copy_from_slice(&self.pos[off..off + self.chunks]);
        sig.strong[..self.chunks].copy_from_slice(&self.strong[off..off + self.chunks]);
        sig
    }

    /// 预取第 idx 个签名到 L1 cache（减少 beam search 中的 cache miss）
    #[inline]
    pub fn prefetch_sig(&self, idx: usize) {
        let off = idx * self.chunks;
        // 预取 pos 和 strong 的起始 cache line（64 bytes = 8 个 u64）
        // 对 768-d (12 chunks)，pos 96B = 2 cache lines，strong 96B = 2 cache lines
        unsafe {
            #[cfg(target_arch = "x86_64")]
            {
                use std::arch::x86_64::*;
                let pos_ptr = self.pos.as_ptr().add(off) as *const i8;
                let strong_ptr = self.strong.as_ptr().add(off) as *const i8;
                _mm_prefetch(pos_ptr, _MM_HINT_T0);
                _mm_prefetch(strong_ptr, _MM_HINT_T0);
                // 对高维向量（>512-d = >8 chunks），预取第二条 cache line
                if self.chunks > 8 {
                    _mm_prefetch(pos_ptr.add(64), _MM_HINT_T0);
                    _mm_prefetch(strong_ptr.add(64), _MM_HINT_T0);
                }
            }
            #[cfg(target_arch = "aarch64")]
            {
                // ARM64 使用 prefetch hint
                let pos_ptr = self.pos.as_ptr().add(off);
                let strong_ptr = self.strong.as_ptr().add(off);
                std::arch::asm!("prfm pldl1keep, [{0}]", in(reg) pos_ptr, options(nostack, preserves_flags));
                std::arch::asm!("prfm pldl1keep, [{0}]", in(reg) strong_ptr, options(nostack, preserves_flags));
            }
        }
    }

    /// 计算存储中第 idx 个签名与外部签名的距离（零拷贝）
    #[inline]
    pub fn distance_to_sig(&self, idx: usize, other: &Bq2Signature, dim: usize) -> u32 {
        let off = idx * self.chunks;
        bq2_distance_raw(
            self.pos[off..].as_ptr(),
            self.strong[off..].as_ptr(),
            other.pos.as_ptr(),
            other.strong.as_ptr(),
            dim,
        )
    }

    #[inline]
    pub fn distance_to_sig_cheap(&self, idx: usize, other: &Bq2Signature, dim: usize) -> u32 {
        let off = idx * self.chunks;
        #[cfg(all(target_arch = "x86_64", not(coverage)))]
        {
            if !*FORCE_NO_AVX512
                && is_x86_feature_detected!("avx512vpopcntdq")
                && is_x86_feature_detected!("avx512f")
            {
                return unsafe {
                    if dim == 768 {
                        bq2_distance_cheap_avx512_768(
                            self.pos[off..].as_ptr(),
                            self.strong[off..].as_ptr(),
                            other.pos.as_ptr(),
                            other.strong.as_ptr(),
                        )
                    } else {
                        bq2_distance_cheap_avx512(
                            self.pos[off..].as_ptr(),
                            self.strong[off..].as_ptr(),
                            other.pos.as_ptr(),
                            other.strong.as_ptr(),
                            dim,
                        )
                    }
                };
            }
        }
        let chunks = dim.div_ceil(64);
        let mut acc = 0u32;
        for i in 0..chunks {
            acc += (self.pos[off + i] ^ other.pos[i]).count_ones();
            acc += (self.strong[off + i] ^ other.strong[i]).count_ones();
        }
        acc
    }

    #[inline]
    pub(crate) fn distance_to_sig_cheap_384(&self, idx: usize, other: &Bq2Signature) -> u32 {
        #[cfg(target_arch = "x86_64")]
        {
            let off = idx * 6;
            unsafe {
                bq2_distance_cheap_popcnt_384(
                    self.pos.as_ptr().add(off),
                    self.strong.as_ptr().add(off),
                    other.pos.as_ptr(),
                    other.strong.as_ptr(),
                )
            }
        }
        #[cfg(not(target_arch = "x86_64"))]
        {
            self.distance_to_sig_cheap(idx, other, 384)
        }
    }

    /// 计算两个存储中签名的距离（零拷贝）
    #[inline]
    pub fn distance(&self, i: usize, j: usize, dim: usize) -> u32 {
        let off_i = i * self.chunks;
        let off_j = j * self.chunks;
        bq2_distance_raw(
            self.pos[off_i..].as_ptr(),
            self.strong[off_i..].as_ptr(),
            self.pos[off_j..].as_ptr(),
            self.strong[off_j..].as_ptr(),
            dim,
        )
    }

    /// 紧凑 hot 内存占用（字节）
    pub fn hot_bytes(&self) -> usize {
        (self.pos.len() + self.strong.len()) * 8
    }

    /// 底层数据访问（序列化用）
    pub fn pos_data(&self) -> &[u64] {
        &self.pos
    }
    pub fn strong_data(&self) -> &[u64] {
        &self.strong
    }

    /// 从裸数据恢复（反序列化用）
    pub fn from_raw(pos: Vec<u64>, strong: Vec<u64>, chunks: usize) -> Self {
        assert_eq!(pos.len(), strong.len(), "pos/strong 长度必须一致");
        let n = pos.len().checked_div(chunks).unwrap_or(0);
        Self {
            pos,
            strong,
            chunks,
            n,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_arch = "x86_64")]
    fn next_u64(state: &mut u64) -> u64 {
        *state ^= *state << 13;
        *state ^= *state >> 7;
        *state ^= *state << 17;
        *state
    }

    #[test]
    fn test_bq2_signature_creation() {
        let vec = vec![0.0f32, 1.0, -1.0, 2.0, -2.0, 0.5, -0.5];
        let sig = Bq2Signature::from_vector(&vec);
        assert_ne!(sig, Bq2Signature::empty());
        let sig2 = Bq2Signature::from_vector(&[1.0f32, -1.0]);
        assert_ne!(sig, sig2);
    }

    #[test]
    fn test_bq2_distance() {
        let v1 = vec![1.0f32, 1.0, -1.0, -1.0];
        let v2 = vec![1.0f32, -1.0, 1.0, -1.0];
        let sig1 = Bq2Signature::from_vector(&v1);
        let sig2 = Bq2Signature::from_vector(&v2);
        let dist = sig1.distance(&sig2, 4);
        assert!(dist > sig1.distance(&sig1, 4));
    }

    #[test]
    fn test_bq2_distance_raw_scalar() {
        let v1 = vec![1.0f32, 1.0, -1.0, -1.0];
        let v2 = vec![1.0f32, -1.0, 1.0, -1.0];
        let sig1 = Bq2Signature::from_vector(&v1);
        let sig2 = Bq2Signature::from_vector(&v2);

        let dist = bq2_distance_raw_scalar(
            sig1.pos.as_ptr(),
            sig1.strong.as_ptr(),
            sig2.pos.as_ptr(),
            sig2.strong.as_ptr(),
            4,
        );
        assert_eq!(dist, sig1.distance(&sig2, 4));

        let raw_dist = bq2_distance_raw(
            sig1.pos.as_ptr(),
            sig1.strong.as_ptr(),
            sig2.pos.as_ptr(),
            sig2.strong.as_ptr(),
            4,
        );
        assert_eq!(dist, raw_dist);
    }

    #[cfg(target_arch = "x86_64")]
    #[test]
    fn dim384专用完整距离与通用标量位级一致() {
        if !is_x86_feature_detected!("popcnt") {
            return;
        }
        let mut state = 0x9E37_79B9_7F4A_7C15;
        for _ in 0..100_000 {
            let mut pos_a = [0u64; 6];
            let mut strong_a = [0u64; 6];
            let mut pos_b = [0u64; 6];
            let mut strong_b = [0u64; 6];
            for index in 0..6 {
                pos_a[index] = next_u64(&mut state);
                strong_a[index] = next_u64(&mut state);
                pos_b[index] = next_u64(&mut state);
                strong_b[index] = next_u64(&mut state);
            }
            let expected = bq2_distance_raw_scalar(
                pos_a.as_ptr(),
                strong_a.as_ptr(),
                pos_b.as_ptr(),
                strong_b.as_ptr(),
                384,
            );
            let actual = unsafe {
                bq2_distance_raw_popcnt_384(
                    pos_a.as_ptr(),
                    strong_a.as_ptr(),
                    pos_b.as_ptr(),
                    strong_b.as_ptr(),
                )
            };
            assert_eq!(actual, expected);
        }
    }

    #[cfg(target_arch = "x86_64")]
    #[test]
    fn dim384专用廉价距离与通用循环位级一致() {
        if !is_x86_feature_detected!("popcnt") {
            return;
        }
        let mut state = 0xD1B5_4A32_D192_ED03;
        for _ in 0..100_000 {
            let mut pos_a = [0u64; 6];
            let mut strong_a = [0u64; 6];
            let mut pos_b = [0u64; 6];
            let mut strong_b = [0u64; 6];
            for index in 0..6 {
                pos_a[index] = next_u64(&mut state);
                strong_a[index] = next_u64(&mut state);
                pos_b[index] = next_u64(&mut state);
                strong_b[index] = next_u64(&mut state);
            }
            let expected = (0..6)
                .map(|index| {
                    (pos_a[index] ^ pos_b[index]).count_ones()
                        + (strong_a[index] ^ strong_b[index]).count_ones()
                })
                .sum::<u32>();
            let actual = unsafe {
                bq2_distance_cheap_popcnt_384(
                    pos_a.as_ptr(),
                    strong_a.as_ptr(),
                    pos_b.as_ptr(),
                    strong_b.as_ptr(),
                )
            };
            assert_eq!(actual, expected);
        }
    }

    #[test]
    fn dim384紧凑存储最后节点距离安全() {
        let vectors = (0..7)
            .map(|row| {
                (0..384)
                    .map(|column| (((row * 389 + column * 17) % 101) as f32 - 50.0) / 50.0)
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        let mut store = Bq2Store::new(384);
        for vector in &vectors {
            store.push_from_vector(vector);
        }
        let query = Bq2Signature::from_vector(&vectors[0]);
        let expected = bq2_distance_raw_scalar(
            store.pos_data()[36..].as_ptr(),
            store.strong_data()[36..].as_ptr(),
            query.pos.as_ptr(),
            query.strong.as_ptr(),
            384,
        );
        assert_eq!(store.distance_to_sig(6, &query, 384), expected);
        let expected_cheap = (0..6)
            .map(|index| {
                (store.pos_data()[36 + index] ^ query.pos[index]).count_ones()
                    + (store.strong_data()[36 + index] ^ query.strong[index]).count_ones()
            })
            .sum::<u32>();
        assert_eq!(store.distance_to_sig_cheap(6, &query, 384), expected_cheap);
    }

    #[test]
    fn 非384维保持通用距离语义() {
        for dim in [383, 385, 512, 768, 1024, 1536] {
            let left = (0..dim)
                .map(|index| (index as f32 * 0.17).sin())
                .collect::<Vec<_>>();
            let right = (0..dim)
                .map(|index| (index as f32 * 0.31).cos())
                .collect::<Vec<_>>();
            let left = Bq2Signature::from_vector(&left);
            let right = Bq2Signature::from_vector(&right);
            let expected = bq2_distance_raw_scalar(
                left.pos.as_ptr(),
                left.strong.as_ptr(),
                right.pos.as_ptr(),
                right.strong.as_ptr(),
                dim,
            );
            assert_eq!(
                bq2_distance_raw(
                    left.pos.as_ptr(),
                    left.strong.as_ptr(),
                    right.pos.as_ptr(),
                    right.strong.as_ptr(),
                    dim,
                ),
                expected
            );
        }
    }

    #[test]
    fn 非完整尾块在所有奇偶chunk组合下保持标量语义() {
        for dim in [1, 2, 63, 65, 127, 129, 191, 193, 255, 257, 319, 383, 385] {
            let left = (0..dim)
                .map(|index| (index as f32 * 0.13).sin())
                .collect::<Vec<_>>();
            let right = (0..dim)
                .map(|index| (index as f32 * 0.29).cos())
                .collect::<Vec<_>>();
            let left = Bq2Signature::from_vector(&left);
            let right = Bq2Signature::from_vector(&right);
            let expected = bq2_distance_raw_scalar(
                left.pos.as_ptr(),
                left.strong.as_ptr(),
                right.pos.as_ptr(),
                right.strong.as_ptr(),
                dim,
            );
            let actual = bq2_distance_raw(
                left.pos.as_ptr(),
                left.strong.as_ptr(),
                right.pos.as_ptr(),
                right.strong.as_ptr(),
                dim,
            );
            assert_eq!(actual, expected, "维度 {dim} 的尾块掩码语义不一致");
        }
    }

    #[test]
    fn test_bq2_store() {
        let mut store = Bq2Store::new(4);
        assert!(store.is_empty());
        assert_eq!(store.len(), 0);

        store.reserve(10);

        store.push_from_vector(&[1.0f32, 2.0, 3.0, 4.0]);
        assert_eq!(store.len(), 1);

        store.push_from_vector(&[-1.0f32, -2.0, -3.0, -4.0]);
        assert_eq!(store.len(), 2);

        let dist01 = store.distance(0, 1, 4);
        let dist00 = store.distance(0, 0, 4);
        assert!(dist01 > dist00);
    }

    #[test]
    fn test_bq2_store_long_vector() {
        let mut store = Bq2Store::new(128);
        let v1 = vec![1.0f32; 128];
        let v2 = vec![-1.0f32; 128];
        store.push_from_vector(&v1);
        store.push_from_vector(&v2);

        assert!(store.distance(0, 0, 128) < store.distance(0, 1, 128));
    }
}
