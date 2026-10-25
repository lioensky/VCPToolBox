//! 通用维度SM路径：紧凑对齐行、独立整数计数、尾部掩码与版本化静态快照。
use super::*;
use crate::index::bq::MAX_BQ_DIM;

pub(super) const PORTABLE_MAGIC: &[u8; 8] = b"QSMGEN02";

pub(super) fn check_dimension(dim: usize) -> io::Result<()> {
    if dim == 0 || dim > MAX_BQ_DIM {
        return Err(invalid(&format!("SM维度必须在TDB支持的1至{MAX_BQ_DIM}范围内")));
    }
    Ok(())
}

#[derive(Clone, Copy)]
#[repr(C, align(64))]
struct Block([u64; 8]);

pub(super) struct DynamicSm {
    dim: usize,
    words: usize,
    blocks_per_row: usize,
    data: Vec<Block>,
    n: usize,
}

impl DynamicSm {
    pub(super) fn empty(dim: usize, n: usize) -> io::Result<Self> {
        check_dimension(dim)?;
        let words = dim.div_ceil(64);
        let blocks_per_row = (words * 2 + 3).div_ceil(8);
        let len = n
            .checked_mul(blocks_per_row)
            .ok_or_else(|| invalid("SM行容量溢出"))?;
        let mut data = Vec::new();
        data.try_reserve_exact(len)
            .map_err(|_| invalid("无法分配SM位码行"))?;
        data.resize(len, Block([0; 8]));
        Ok(Self {
            dim,
            words,
            blocks_per_row,
            data,
            n,
        })
    }
    pub(super) fn dimension(&self) -> usize {
        self.dim
    }
    pub(super) fn len(&self) -> usize {
        self.n
    }
    pub(super) fn row_bytes(&self) -> usize {
        self.blocks_per_row * 64
    }
    pub(super) fn owned_bytes(&self) -> usize {
        self.data.capacity() * 64
    }

    pub(super) fn reserve_rows(&mut self, n: usize) {
        self.data.reserve(n * self.blocks_per_row);
    }

    pub(super) fn push_vector(&mut self, x: &[f32]) -> io::Result<()> {
        let code = Bq2Signature::from_vector(x);
        let mut sums = [0f64; 2];
        let mut counts = [0usize; 2];
        for (j, &v) in x.iter().enumerate() {
            let group = ((code.strong[j / 64] >> (j % 64)) & 1) as usize;
            sums[group] += v.abs() as f64;
            counts[group] += 1;
        }
        let weak = if counts[0] == 0 {
            0.
        } else {
            (sums[0] / counts[0] as f64) as f32
        };
        let high = if counts[1] == 0 {
            0.
        } else {
            (sums[1] / counts[1] as f64) as f32
        };
        let delta = high - weak;
        if !weak.is_finite() || !delta.is_finite() {
            return Err(invalid("默认SM幅值溢出"));
        }
        let id = self.n;
        self.data
            .resize(self.data.len() + self.blocks_per_row, Block([0; 8]));
        self.n += 1;
        let words = self.words;
        let row = self.row_mut(id);
        row[..words].copy_from_slice(&code.pos[..words]);
        row[words..words * 2].copy_from_slice(&code.strong[..words]);
        let reconstructed_high = weak + delta;
        let norm = counts[0] as f32 * weak * weak
            + counts[1] as f32 * reconstructed_high * reconstructed_high;
        self.write_metadata(id, weak, delta, 0., norm, counts[1] as u32);
        Ok(())
    }
    // VCP-PATCH: sibling routing serializer needs field-wise access.
    pub(super) fn row(&self, id: usize) -> &[u64] {
        assert!(id < self.n);
        // Block连续且恰有八个u64，行起点保持64字节对齐。
        unsafe {
            std::slice::from_raw_parts(
                self.data.as_ptr().add(id * self.blocks_per_row).cast(),
                self.blocks_per_row * 8,
            )
        }
    }
    pub(super) fn row_mut(&mut self, id: usize) -> &mut [u64] {
        assert!(id < self.n);
        unsafe {
            std::slice::from_raw_parts_mut(
                self.data.as_mut_ptr().add(id * self.blocks_per_row).cast(),
                self.blocks_per_row * 8,
            )
        }
    }
    pub(super) fn metadata(&self, id: usize) -> (f32, f32, f32, f32, u32) {
        let row = self.row(id);
        let p = self.words * 2;
        (
            f32::from_bits(row[p] as u32),
            f32::from_bits((row[p] >> 32) as u32),
            f32::from_bits(row[p + 1] as u32),
            f32::from_bits((row[p + 1] >> 32) as u32),
            row[p + 2] as u32,
        )
    }
    pub(super) fn write_metadata(
        &mut self,
        id: usize,
        weak: f32,
        delta: f32,
        coefficient: f32,
        norm: f32,
        count: u32,
    ) {
        let p = self.words * 2;
        let row = self.row_mut(id);
        row[p] = weak.to_bits() as u64 | ((delta.to_bits() as u64) << 32);
        row[p + 1] = coefficient.to_bits() as u64 | ((norm.to_bits() as u64) << 32);
        row[p + 2] = count as u64;
    }
    fn encode(dim: usize, base: &[f32], coefficients: &[f32]) -> io::Result<Self> {
        let mut model = Self::empty(dim, base.len() / dim)?;
        let words = model.words;
        for (id, x) in base.chunks_exact(dim).enumerate() {
            let code = Bq2Signature::from_vector(x);
            let mut sums = [0f64; 2];
            let mut counts = [0usize; 2];
            for (j, &v) in x.iter().enumerate() {
                let group = ((code.strong[j / 64] >> (j % 64)) & 1) as usize;
                sums[group] += v.abs() as f64;
                counts[group] += 1;
            }
            let weak = if counts[0] == 0 {
                0.
            } else {
                (sums[0] / counts[0] as f64) as f32
            };
            let high = if counts[1] == 0 {
                0.
            } else {
                (sums[1] / counts[1] as f64) as f32
            };
            if !weak.is_finite() || !(high - weak).is_finite() {
                return Err(invalid("SM幅值溢出"));
            }
            let row = model.row_mut(id);
            row[..words].copy_from_slice(&code.pos[..words]);
            row[words..words * 2].copy_from_slice(&code.strong[..words]);
            model.write_metadata(
                id,
                weak,
                high - weak,
                coefficients.get(id).copied().unwrap_or(0.),
                0.,
                counts[1] as u32,
            );
        }
        Ok(model)
    }
    pub(super) fn install_norms(&mut self) {
        for id in 0..self.n {
            let (weak, delta, coefficient, _, count) = self.metadata(id);
            let high = weak + delta;
            let norm =
                (self.dim - count as usize) as f32 * weak * weak + count as f32 * high * high;
            self.write_metadata(id, weak, delta, coefficient, norm, count);
        }
    }
    fn score(&self, q: &DynamicQuery, id: usize, optimized: bool) -> f32 {
        let row = self.row(id);
        let counts = if optimized && simd_available() {
            #[cfg(target_arch = "x86_64")]
            {
                unsafe { self.counts_avx512(q, id) }
            }
            #[cfg(not(target_arch = "x86_64"))]
            {
                self.counts_scalar(q, row)
            }
        } else {
            self.counts_scalar(q, row)
        };
        let (weak, delta, _, _, count) = self.metadata(id);
        let s = counts.map(|x| x as f32);
        let x = self.dim as f32 - 2. * s[0];
        let y = count as f32 - 2. * s[1];
        let z = q.count - 2. * s[2];
        let w = s[3] - 2. * s[4];
        q.weak * (weak * x + delta * y) + q.delta * (weak * z + delta * w)
    }
    fn counts_scalar(&self, q: &DynamicQuery, row: &[u64]) -> [u32; 5] {
        let mut sums = [0; 5];
        for j in 0..self.words {
            let diff = row[j] ^ q.pos[j];
            let both = row[self.words + j] & q.strong[j];
            let values = [
                diff,
                diff & row[self.words + j],
                diff & q.strong[j],
                both,
                diff & both,
            ];
            for k in 0..5 {
                sums[k] += values[k].count_ones();
            }
        }
        sums
    }
    #[cfg(target_arch = "x86_64")]
    #[target_feature(enable = "avx512f,avx512vpopcntdq")]
    unsafe fn counts_avx512(&self, q: &DynamicQuery, id: usize) -> [u32; 5] {
        use std::arch::x86_64::*;
        unsafe {
            let row = self.row(id);
            let mut sums = [_mm512_setzero_si512(); 5];
            for j in (0..self.words).step_by(8) {
                let valid = (self.words - j).min(8);
                let mask = ((1u16 << valid) - 1) as u8;
                let pos = _mm512_maskz_loadu_epi64(mask, row.as_ptr().add(j).cast());
                let strong =
                    _mm512_maskz_loadu_epi64(mask, row.as_ptr().add(self.words + j).cast());
                let qp = _mm512_loadu_si512(q.pos.as_ptr().add(j).cast());
                let qs = _mm512_loadu_si512(q.strong.as_ptr().add(j).cast());
                let diff = _mm512_xor_si512(pos, qp);
                let both = _mm512_and_si512(strong, qs);
                let values = [
                    diff,
                    _mm512_and_si512(diff, strong),
                    _mm512_and_si512(diff, qs),
                    both,
                    _mm512_and_si512(diff, both),
                ];
                for k in 0..5 {
                    sums[k] = _mm512_add_epi64(sums[k], _mm512_popcnt_epi64(values[k]));
                }
            }
            // 各字段独立求和，不依赖768维十位打包，也不会在1536或3072维串位。
            sums.map(|x| _mm512_reduce_add_epi64(x) as u32)
        }
    }
    fn prefetch(&self, id: usize, l2: bool) {
        #[cfg(target_arch = "x86_64")]
        unsafe {
            use std::arch::x86_64::{_MM_HINT_T0, _MM_HINT_T1, _mm_prefetch};
            let row = self
                .data
                .as_ptr()
                .add(id * self.blocks_per_row)
                .cast::<i8>();
            for j in 0..self.blocks_per_row {
                if l2 {
                    _mm_prefetch(row.add(j * 64), _MM_HINT_T1);
                } else {
                    _mm_prefetch(row.add(j * 64), _MM_HINT_T0);
                }
            }
        }
        #[cfg(not(target_arch = "x86_64"))]
        let _ = (id, l2);
    }
}

#[derive(Default)]
struct DynamicQuery {
    pos: Vec<u64>,
    strong: Vec<u64>,
    weak: f32,
    delta: f32,
    count: f32,
}
impl DynamicQuery {
    fn encode(&mut self, q: &[f32], optimized: bool) {
        let padded = q.len().div_ceil(64).div_ceil(8) * 8;
        self.pos.resize(padded, 0);
        self.strong.resize(padded, 0);
        self.pos.fill(0);
        self.strong.fill(0);
        let threshold = q.iter().map(|x| x.abs() as f64).sum::<f64>() / q.len() as f64;
        let mut sums = [0f64; 2];
        let mut count = 0usize;
        let mut start = 0;
        #[cfg(target_arch = "x86_64")]
        if optimized && simd_available() {
            unsafe {
                start = self.encode_avx512(q, threshold, &mut sums, &mut count);
            }
        }
        #[cfg(not(target_arch = "x86_64"))]
        let _ = optimized;
        for (j, &v) in q.iter().enumerate().skip(start) {
            let group = usize::from(v.abs() as f64 >= threshold);
            count += group;
            sums[0] += if group == 0 { v.abs() as f64 } else { 0. };
            sums[1] += if group == 1 { v.abs() as f64 } else { 0. };
            if v >= 0. {
                self.pos[j / 64] |= 1 << (j % 64);
            }
            if group == 1 {
                self.strong[j / 64] |= 1 << (j % 64);
            }
        }
        self.weak = if count == q.len() {
            0.
        } else {
            (sums[0] / (q.len() - count) as f64) as f32
        };
        let high = if count == 0 {
            0.
        } else {
            (sums[1] / count as f64) as f32
        };
        self.delta = high - self.weak;
        self.count = count as f32;
    }
    #[cfg(target_arch = "x86_64")]
    #[target_feature(enable = "avx512f,avx2")]
    unsafe fn encode_avx512(
        &mut self,
        q: &[f32],
        threshold: f64,
        sums: &mut [f64; 2],
        count: &mut usize,
    ) -> usize {
        use std::arch::x86_64::*;
        unsafe {
            let end = q.len() / 8 * 8;
            let limit = _mm512_set1_pd(threshold);
            for j in (0..end).step_by(8) {
                let values = _mm256_loadu_ps(q.as_ptr().add(j));
                let abs = _mm256_and_ps(values, _mm256_castsi256_ps(_mm256_set1_epi32(0x7fffffff)));
                let signs =
                    _mm256_movemask_ps(_mm256_cmp_ps::<_CMP_GE_OQ>(values, _mm256_setzero_ps()))
                        as u64;
                let groups = _mm512_cmp_pd_mask::<_CMP_GE_OQ>(_mm512_cvtps_pd(abs), limit) as u64;
                self.pos[j / 64] |= signs << (j % 64);
                self.strong[j / 64] |= groups << (j % 64);
                *count += groups.count_ones() as usize;
                for k in 0..8 {
                    let v = q[j + k].abs() as f64;
                    let group = (groups >> k) & 1;
                    sums[0] += if group == 0 { v } else { 0. };
                    sums[1] += if group == 1 { v } else { 0. };
                }
            }
            end
        }
    }
}
thread_local! { static QUERY: RefCell<DynamicQuery> = RefCell::new(DynamicQuery::default()); }

struct DynamicSlice<'a> {
    base: &'a [f32],
    dim: usize,
    native_l2: bool,
}
impl ExactSource for DynamicSlice<'_> {
    fn one(&mut self, q: &[f32], id: usize) -> io::Result<Option<f32>> {
        Ok(Some(exact_score(
            q,
            &self.base[id * self.dim..(id + 1) * self.dim],
            self.native_l2,
        )))
    }
    fn four(&mut self, q: &[f32], ids: [usize; 4]) -> io::Result<[Option<f32>; 4]> {
        Ok(exact_four_scored(
            q,
            ids.map(|id| &self.base[id * self.dim..(id + 1) * self.dim]),
            self.native_l2,
        )
        .map(Some))
    }
}
struct DynamicCallback<'a, F> {
    fill: F,
    buffers: &'a mut [Vec<f32>; 4],
    scales: &'a [f32],
    dim: usize,
    native_l2: bool,
}
impl<F: FnMut(usize, &mut Vec<f32>) -> bool> DynamicCallback<'_, F> {
    fn fill(&mut self, id: usize, slot: usize) -> io::Result<bool> {
        self.buffers[slot].clear();
        if !(self.fill)(id, &mut self.buffers[slot]) {
            return Ok(false);
        }
        if self.buffers[slot].len() != self.dim {
            return Err(corrupt("冷向量维度不匹配"));
        }
        if !self.native_l2 {
            production::prepare_exact_buffer(
                &mut self.buffers[slot],
                self.scales.get(id).copied().unwrap_or(1.),
            );
        }
        Ok(true)
    }
}
impl<F: FnMut(usize, &mut Vec<f32>) -> bool> ExactSource for DynamicCallback<'_, F> {
    fn one(&mut self, q: &[f32], id: usize) -> io::Result<Option<f32>> {
        Ok(if self.fill(id, 0)? {
            Some(
                exact_score(q, &self.buffers[0], self.native_l2)
                    * production::exact_scale(self.scales.get(id).copied().unwrap_or(1.)),
            )
        } else {
            None
        })
    }
    fn four(&mut self, q: &[f32], ids: [usize; 4]) -> io::Result<[Option<f32>; 4]> {
        let mut present = [false; 4];
        for k in 0..4 {
            present[k] = self.fill(ids[k], k)?;
        }
        if present.iter().all(|x| *x) {
            let values = exact_four_scored(
                q,
                std::array::from_fn(|k| self.buffers[k].as_slice()),
                self.native_l2,
            );
            Ok(std::array::from_fn(|k| {
                Some(
                    values[k]
                        * production::exact_scale(self.scales.get(ids[k]).copied().unwrap_or(1.)),
                )
            }))
        } else {
            Ok(std::array::from_fn(|k| {
                present[k].then(|| {
                    exact_score(q, &self.buffers[k], self.native_l2)
                        * production::exact_scale(self.scales.get(ids[k]).copied().unwrap_or(1.))
                })
            }))
        }
    }
}
fn exact_dot(q: &[f32], x: &[f32]) -> f32 {
    #[cfg(target_arch = "x86_64")]
    if dot_simd_available() {
        return unsafe { dot_any_avx512::<false>(q, [x, x, x, x], false)[0] };
    }
    let mut sums = [0f32; 16];
    for (i, (&a, &b)) in q.iter().zip(x).enumerate() {
        sums[i % 16] = a.mul_add(b, sums[i % 16]);
    }
    for i in 0..8 {
        sums[i] += sums[i + 8];
    }
    for i in 0..4 {
        sums[i] += sums[i + 4];
    }
    (sums[0] + sums[2]) + (sums[1] + sums[3])
}
fn exact_four(q: &[f32], x: [&[f32]; 4]) -> [f32; 4] {
    #[cfg(target_arch = "x86_64")]
    if dot_simd_available() {
        return unsafe { dot_any_avx512::<false>(q, x, true) };
    }
    x.map(|row| exact_dot(q, row))
}

fn exact_score(q: &[f32], x: &[f32], native_l2: bool) -> f32 {
    if !native_l2 {
        return exact_dot(q, x);
    }
    #[cfg(target_arch = "x86_64")]
    if dot_simd_available() {
        return unsafe { dot_any_avx512::<true>(q, [x, x, x, x], false)[0] };
    }
    let mut sums = [0f32; 16];
    for (i, (&a, &b)) in q.iter().zip(x).enumerate() {
        let delta = a - b;
        sums[i % 16] = delta.mul_add(delta, sums[i % 16]);
    }
    for i in 0..8 {
        sums[i] += sums[i + 8];
    }
    for i in 0..4 {
        sums[i] += sums[i + 4];
    }
    -((sums[0] + sums[2]) + (sums[1] + sums[3]))
}

fn exact_four_scored(q: &[f32], x: [&[f32]; 4], native_l2: bool) -> [f32; 4] {
    if !native_l2 {
        return exact_four(q, x);
    }
    #[cfg(target_arch = "x86_64")]
    if dot_simd_available() {
        return unsafe { dot_any_avx512::<true>(q, x, true) };
    }
    x.map(|row| exact_score(q, row, true))
}
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx512f,fma")]
unsafe fn dot_any_avx512<const NATIVE_L2: bool>(q: &[f32], x: [&[f32]; 4], four: bool) -> [f32; 4] {
    use std::arch::x86_64::*;
    unsafe {
        let mut sums = [_mm512_setzero_ps(); 4];
        let lanes = if four { 4 } else { 1 };
        let end = q.len() / 16 * 16;
        for j in (0..end).step_by(16) {
            let query = _mm512_loadu_ps(q.as_ptr().add(j));
            for k in 0..lanes {
                let row = _mm512_loadu_ps(x[k].as_ptr().add(j));
                let left = if NATIVE_L2 {
                    _mm512_sub_ps(query, row)
                } else {
                    query
                };
                let right = if NATIVE_L2 { left } else { row };
                sums[k] = _mm512_fmadd_ps(left, right, sums[k]);
            }
        }
        if end < q.len() {
            let mask = ((1u32 << (q.len() - end)) - 1) as u16;
            let query = _mm512_maskz_loadu_ps(mask, q.as_ptr().add(end));
            for k in 0..lanes {
                let row = _mm512_maskz_loadu_ps(mask, x[k].as_ptr().add(end));
                let left = if NATIVE_L2 {
                    _mm512_sub_ps(query, row)
                } else {
                    query
                };
                let right = if NATIVE_L2 { left } else { row };
                sums[k] = _mm512_fmadd_ps(left, right, sums[k]);
            }
        }
        sums.map(|v| {
            let value = _mm512_reduce_add_ps(v);
            if NATIVE_L2 { -value } else { value }
        })
    }
}

impl CorrectedSmIndex {
    /// VCP-PATCH: graph-free streaming encoder for the global Chunk table.
    pub fn empty_flat(dim: usize) -> io::Result<Self> {
        Self::empty_routing(dim)
    }

    pub fn push_flat_vector(&mut self, vector: &[f32], id: u64) -> io::Result<()> {
        if id == 0 {
            return Err(invalid("flat SM identity must be positive"));
        }
        self.push_routing_vector(vector, id)
    }

    /// Score only admitted rows, retaining bounded Top-M without touching FP32.
    /// Returned scores are approximate negative reconstructed squared L2, not cosine.
    pub fn search_flat_filtered<F>(
        &self,
        query: &[f32],
        limit: usize,
        mut allowed: F,
    ) -> io::Result<Vec<(u64, f32)>>
    where
        F: FnMut(usize, u64) -> bool,
    {
        if query.len() != self.dimension() || query.iter().any(|v| !v.is_finite()) {
            return Err(invalid("flat SM query dimension or values invalid"));
        }
        if limit == 0 || self.is_empty() {
            return Ok(Vec::new());
        }
        let norm = query.iter().map(|&v| (v as f64).powi(2)).sum::<f64>().sqrt();
        let normalized = query.iter()
            .map(|&v| if norm > 0. { (v as f64 / norm) as f32 } else { 0. })
            .collect::<Vec<_>>();
        let mut dynamic_query = DynamicQuery::default();
        dynamic_query.encode(&normalized, true);
        let fixed_query = (self.dynamic.is_none()).then(|| query_scalar(&normalized));
        let high = dynamic_query.weak + dynamic_query.delta;
        let query_norm = (self.dimension() as f32 - dynamic_query.count)
            * dynamic_query.weak * dynamic_query.weak
            + dynamic_query.count * high * high;
        let mut heap = BinaryHeap::with_capacity(limit.min(self.len()) + 1);
        for (slot, &id) in self.ids.iter().enumerate() {
            if !allowed(slot, id) {
                continue;
            }
            let score = if self.dynamic.is_some() {
                self.dynamic_navigation_score(&dynamic_query, slot, 0., query_norm, true) - 1.
            } else {
                self.navigation_score(fixed_query.as_ref().unwrap(), slot, 0., query_norm, true) - 1.
            };
            if !score.is_finite() {
                return Err(invalid("flat SM score overflow"));
            }
            // Worst score / largest identity stays at the top.
            heap.push((NonNanF32(-score), id));
            if heap.len() > limit {
                heap.pop();
            }
        }
        let mut output = heap.into_iter()
            .map(|(distance, id)| (id, -distance.0)).collect::<Vec<_>>();
        output.sort_unstable_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        Ok(output)
    }

    /// 从明确维度、位于同一内部顺序的向量和图建立SM快照。
    pub fn from_vectors_and_graph(
        dim: usize,
        base: &[f32],
        graph: Vec<Vec<u32>>,
        ids: Vec<u64>,
        entry: u32,
    ) -> io::Result<Self> {
        let mut model = Self::from_parts_with_dimension(dim, base, &[], graph, ids, entry, 0)?;
        model.use_reconstructed_l2();
        Ok(model)
    }

    /// 原始幅值的重建L2导航及负平方L2精排；允许合法零向量。
    pub fn from_native_l2_vectors_and_graph(
        dim: usize,
        base: &[f32],
        graph: Vec<Vec<u32>>,
        ids: Vec<u64>,
        entry: u32,
    ) -> io::Result<Self> {
        let mut model = Self::from_parts_with_scoring(
            dim,
            base,
            &[],
            graph,
            ids,
            entry,
            0,
            SmScoring::NativeL2,
        )?;
        model.use_reconstructed_l2();
        model.scoring = SmScoring::NativeL2;
        Ok(model)
    }
    pub(super) fn from_parts_with_dimension(
        dim: usize,
        base: &[f32],
        coefficients: &[f32],
        graph_rows: Vec<Vec<u32>>,
        ids: Vec<u64>,
        entry: u32,
        anchor: u32,
    ) -> io::Result<Self> {
        Self::from_parts_with_scoring(
            dim,
            base,
            coefficients,
            graph_rows,
            ids,
            entry,
            anchor,
            SmScoring::CorrectedInnerProduct,
        )
    }

    fn from_parts_with_scoring(
        dim: usize,
        base: &[f32],
        coefficients: &[f32],
        graph_rows: Vec<Vec<u32>>,
        ids: Vec<u64>,
        entry: u32,
        anchor: u32,
        scoring: SmScoring,
    ) -> io::Result<Self> {
        check_dimension(dim)?;
        if dim == DIM && scoring != SmScoring::NativeL2 {
            return Self::from_parts(base, coefficients, graph_rows, ids, entry, anchor);
        }
        let n = base.len() / dim;
        if n == 0
            || !base.len().is_multiple_of(dim)
            || n > u32::MAX as usize
            || ids.len() != n
            || graph_rows.len() != n
            || entry as usize >= n
            || anchor as usize >= n
            || (!coefficients.is_empty() && coefficients.len() != n)
            || base.iter().chain(coefficients).any(|x| !x.is_finite())
        {
            return Err(invalid("SM向量、系数或图形状无效"));
        }
        if ids.iter().collect::<std::collections::HashSet<_>>().len() != n {
            return Err(invalid("SM外部节点ID重复"));
        }
        let degree = graph_rows.iter().map(Vec::len).max().unwrap_or(0);
        if degree > MAX_DEGREE || graph_rows.iter().flatten().any(|&v| v as usize >= n) {
            return Err(invalid("SM图出度超过64或邻居编号越界"));
        }
        let dynamic = DynamicSm::encode(dim, base, coefficients)?;
        let mut graph = FlatAdj::new(degree + 1);
        graph.reset_full(n);
        for (u, row) in graph_rows.iter().enumerate() {
            graph.set_neighbors(u as u32, row);
        }
        Ok(Self {
            rows: Vec::new(),
            graph,
            ids,
            entry,
            anchor,
            base_crc: crc32fast::hash(bytemuck::cast_slice(base)),
            exact_scales: Vec::new(),
            scoring,
            dynamic: Some(dynamic),
        })
    }
    pub(super) fn dynamic_slice_search(
        &self,
        q: &[f32],
        base: &[f32],
        cfg: &QuIVerSearchConfig,
        mode: SmSearchMode,
        traced: bool,
    ) -> io::Result<SmSearchOutput> {
        let dim = self.dimension();
        if base.len()
            != self
                .len()
                .checked_mul(dim)
                .ok_or_else(|| invalid("向量库长度溢出"))?
        {
            return Err(invalid("SM外部向量库形状不符"));
        }
        let mut source = DynamicSlice {
            base,
            dim,
            native_l2: self.scoring == SmScoring::NativeL2,
        };
        match (traced, mode) {
            (true, SmSearchMode::Reference) => {
                self.search_dynamic::<true, false, _>(q, &self.graph, &mut source, cfg)
            }
            (true, SmSearchMode::Combined) => {
                self.search_dynamic::<true, true, _>(q, &self.graph, &mut source, cfg)
            }
            (false, SmSearchMode::Reference) => {
                self.search_dynamic::<false, false, _>(q, &self.graph, &mut source, cfg)
            }
            (false, SmSearchMode::Combined) => {
                self.search_dynamic::<false, true, _>(q, &self.graph, &mut source, cfg)
            }
        }
    }
    pub(super) fn dynamic_callback_search<F: FnMut(usize, &mut Vec<f32>) -> bool>(
        &self,
        q: &[f32],
        graph: &FlatAdj,
        cfg: &QuIVerSearchConfig,
        mode: SmSearchMode,
        fill: F,
    ) -> io::Result<SmSearchOutput> {
        EXACT_BUFFERS.with(|cell| {
            let mut buffers = cell.borrow_mut();
            let mut source = DynamicCallback {
                fill,
                buffers: &mut buffers,
                scales: &self.exact_scales,
                dim: self.dimension(),
                native_l2: self.scoring == SmScoring::NativeL2,
            };
            match mode {
                SmSearchMode::Reference => {
                    self.search_dynamic::<false, false, _>(q, graph, &mut source, cfg)
                }
                SmSearchMode::Combined => {
                    self.search_dynamic::<false, true, _>(q, graph, &mut source, cfg)
                }
            }
        })
    }
    pub(super) fn dynamic_callback_filtered<F, E>(
        &self, q: &[f32], graph: &FlatAdj, cfg: &QuIVerSearchConfig,
        exclude: &E, fill: F,
    ) -> io::Result<SmSearchOutput>
    where F: FnMut(usize, &mut Vec<f32>) -> bool, E: Fn(u64) -> bool,
    {
        if q.len() != self.dimension() || q.iter().any(|x| !x.is_finite()) {
            return Err(invalid("SM查询维度或数值无效"));
        }
        EXACT_BUFFERS.with(|cell| {
            let mut buffers = cell.borrow_mut();
            let mut source = DynamicCallback { fill, buffers: &mut buffers,
                scales: &self.exact_scales, dim: self.dimension(), native_l2: self.scoring == SmScoring::NativeL2 };
            QUERY.with(|cell| {
                let mut query = cell.borrow_mut();
                query.encode(q, true);
                self.dynamic_encoded_filtered::<false, true, _, _>(q, graph, &mut source, cfg, &query, Some(exclude))
            })
        })
    }
    fn search_dynamic<const TRACE: bool, const OPTIMIZED: bool, S: ExactSource>(
        &self,
        q: &[f32],
        graph: &FlatAdj,
        source: &mut S,
        cfg: &QuIVerSearchConfig,
    ) -> io::Result<SmSearchOutput> {
        if q.len() != self.dimension() || q.iter().any(|x| !x.is_finite()) {
            return Err(invalid("SM查询维度或数值无效"));
        }
        QUERY.with(|cell| {
            let mut query = cell.borrow_mut();
            query.encode(q, OPTIMIZED);
            self.dynamic_encoded::<TRACE, OPTIMIZED, _>(q, graph, source, cfg, &query)
        })
    }
    #[inline]
    fn dynamic_navigation_score(
        &self,
        q: &DynamicQuery,
        id: usize,
        error: f32,
        norm: f32,
        optimized: bool,
    ) -> f32 {
        let model = self.dynamic.as_ref().unwrap();
        let score = model.score(q, id, optimized);
        let (_, _, coefficient, row_norm, _) = model.metadata(id);
        match self.scoring {
            SmScoring::ReconstructedL2 | SmScoring::NativeL2 => 1. - (norm + row_norm - 2. * score),
            SmScoring::CorrectedInnerProduct => score + coefficient * error,
        }
    }
    #[inline]
    fn dynamic_prefetch(&self, id: usize) {
        self.dynamic.as_ref().unwrap().prefetch(
            id,
            matches!(
                self.scoring,
                SmScoring::ReconstructedL2 | SmScoring::NativeL2
            ),
        );
    }

    /// 通用快照携带维度与评分模式，读取仍兼容旧768维QSM76801格式。
    /// TDB旧图文件不自动启用运行期SM派生状态；此入口用于显式SM静态快照。
    pub fn save_portable(&self, path: &Path) -> io::Result<()> {
        if self.scoring == SmScoring::NativeL2 {
            return Err(invalid(
                "原生欧氏SM为运行期模式；请保存QuIVer图并在加载后显式重新安装",
            ));
        }
        if !self.exact_scales.is_empty() || self.graph.data.is_empty() {
            return Err(invalid("请先生成绑定单位向量和完整图的静态SM快照"));
        }
        let dim = self.dimension();
        let words = dim.div_ceil(64);
        let mut payload = Vec::new();
        payload.extend_from_slice(PORTABLE_MAGIC);
        payload.extend_from_slice(&(dim as u32).to_le_bytes());
        payload.extend_from_slice(
            &u32::from(self.scoring == SmScoring::ReconstructedL2).to_le_bytes(),
        );
        payload.extend_from_slice(&(self.len() as u64).to_le_bytes());
        for v in [
            self.entry,
            self.anchor,
            (self.graph.stride - 1) as u32,
            self.base_crc,
        ] {
            payload.extend_from_slice(&v.to_le_bytes());
        }
        for id in 0..self.len() {
            payload.extend_from_slice(&self.ids[id].to_le_bytes());
            let (pos, strong, weak, delta, coefficient, count) = if let Some(m) = &self.dynamic {
                let r = m.row(id);
                let (w, d, c, _, n) = m.metadata(id);
                (&r[..words], &r[words..words * 2], w, d, c, n)
            } else {
                let r = &self.rows[id];
                (
                    &r.pos[..],
                    &r.strong[..],
                    r.weak,
                    r.delta,
                    r.coefficient,
                    r.strong_count as u32,
                )
            };
            for &v in pos.iter().chain(strong) {
                payload.extend_from_slice(&v.to_le_bytes());
            }
            for v in [weak, delta, coefficient] {
                payload.extend_from_slice(&v.to_le_bytes());
            }
            payload.extend_from_slice(&count.to_le_bytes());
            let neighbors = self.graph.neighbors(id as u32);
            payload.extend_from_slice(&(neighbors.len() as u32).to_le_bytes());
            for &v in neighbors {
                payload.extend_from_slice(&v.to_le_bytes());
            }
        }
        let crc = crc32fast::hash(&payload);
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        f.write_all(&payload)?;
        f.write_all(&crc.to_le_bytes())?;
        f.sync_all()
    }
    pub(super) fn load_portable(path: &Path, base: &[f32]) -> io::Result<Self> {
        let mut f = std::fs::File::open(path)?;
        let mut header = [0u8; 40];
        f.read_exact(&mut header)?;
        let dim = u32::from_le_bytes(header[8..12].try_into().unwrap()) as usize;
        check_dimension(dim).map_err(|_| corrupt("SM文件维度无效"))?;
        let mode = u32::from_le_bytes(header[12..16].try_into().unwrap());
        let n = u64::from_le_bytes(header[16..24].try_into().unwrap());
        let entry = u32::from_le_bytes(header[24..28].try_into().unwrap());
        let anchor = u32::from_le_bytes(header[28..32].try_into().unwrap());
        let degree = u32::from_le_bytes(header[32..36].try_into().unwrap()) as usize;
        let base_crc = u32::from_le_bytes(header[36..40].try_into().unwrap());
        if &header[..8] != PORTABLE_MAGIC
            || mode > 1
            || n == 0
            || n > u32::MAX as u64
            || (n as usize).checked_mul(dim) != Some(base.len())
            || degree > MAX_DEGREE
            || entry as u64 >= n
            || anchor as u64 >= n
        {
            return Err(corrupt("SM通用文件头与外部向量库不符"));
        }
        let words = dim.div_ceil(64);
        let minimum = 44 + n * (28 + words as u64 * 16);
        let length = f.metadata()?.len();
        if length < minimum || length > minimum + n * degree as u64 * 4 {
            return Err(corrupt("SM通用文件长度超出声明范围"));
        }
        if crc32fast::hash(bytemuck::cast_slice(base)) != base_crc {
            return Err(corrupt("SM外部向量库身份不符"));
        }
        let mut bytes = Vec::with_capacity(length as usize);
        bytes.extend_from_slice(&header);
        f.read_to_end(&mut bytes)?;
        let checksum = u32::from_le_bytes(bytes[bytes.len() - 4..].try_into().unwrap());
        if crc32fast::hash(&bytes[..bytes.len() - 4]) != checksum {
            return Err(corrupt("SM通用文件CRC不符"));
        }
        let mut model = DynamicSm::empty(dim, n as usize)?;
        let mut graph = FlatAdj::new(degree + 1);
        graph.reset_full(n as usize);
        let mut ids = Vec::with_capacity(n as usize);
        let mut input = &bytes[40..bytes.len() - 4];
        for id in 0..n as usize {
            ids.push(read_u64(&mut input)?);
            let row = model.row_mut(id);
            for v in &mut row[..words * 2] {
                *v = read_u64(&mut input)?;
            }
            let weak = f32::from_bits(read_u32(&mut input)?);
            let delta = f32::from_bits(read_u32(&mut input)?);
            let coefficient = f32::from_bits(read_u32(&mut input)?);
            let count = read_u32(&mut input)?;
            let mask = if dim.is_multiple_of(64) {
                u64::MAX
            } else {
                (1u64 << (dim % 64)) - 1
            };
            if !weak.is_finite()
                || !delta.is_finite()
                || !coefficient.is_finite()
                || count > dim as u32
                || row[words..words * 2]
                    .iter()
                    .map(|x| x.count_ones())
                    .sum::<u32>()
                    != count
                || row[words - 1] & !mask != 0
                || row[words * 2 - 1] & !mask != 0
            {
                return Err(corrupt("SM通用行数值、尾位或计数无效"));
            }
            model.write_metadata(id, weak, delta, coefficient, 0., count);
            let count = read_u32(&mut input)? as usize;
            if count > degree {
                return Err(corrupt("SM邻接行超过声明容量"));
            }
            let mut neighbors = Vec::with_capacity(count);
            for _ in 0..count {
                let v = read_u32(&mut input)?;
                if v as u64 >= n {
                    return Err(corrupt("SM邻居越界"));
                }
                neighbors.push(v);
            }
            graph.set_neighbors(id as u32, &neighbors);
        }
        if !input.is_empty()
            || ids.iter().collect::<std::collections::HashSet<_>>().len() != n as usize
        {
            return Err(corrupt("SM通用文件尾部或外部ID无效"));
        }
        let rows = if dim == DIM {
            (0..n as usize)
                .map(|id| {
                    let r = model.row(id);
                    let (weak, delta, coefficient, _, strong_count) = model.metadata(id);
                    SmRow {
                        pos: r[..12].try_into().unwrap(),
                        strong: r[words..words * 2].try_into().unwrap(),
                        weak,
                        delta,
                        coefficient,
                        reconstructed_norm: 0.,
                        strong_count: strong_count as u16,
                    }
                })
                .collect()
        } else {
            Vec::new()
        };
        let mut result = Self {
            rows,
            graph,
            ids,
            entry,
            anchor,
            base_crc,
            exact_scales: Vec::new(),
            scoring: SmScoring::CorrectedInnerProduct,
            dynamic: if dim == DIM { None } else { Some(model) },
        };
        if mode == 1 {
            result.use_reconstructed_l2();
        }
        Ok(result)
    }
}

#[path = "dynamic_search.rs"]
mod search;

#[cfg(test)]
#[path = "dynamic_tests.rs"]
mod tests;
