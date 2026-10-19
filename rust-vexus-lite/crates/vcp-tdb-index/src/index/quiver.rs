//! QuIVer — QUantized Index for Vector Retrieval
//!
//! BQ-native Vamana 图索引，论文核心实现。
//! 支持 rayon 并行批量构建（batch_build）。
//!
//! 核心架构：
//!   - 2-bit Sign-Magnitude 量化 (pos + strong)
//!   - Vamana α-diversity 剪枝构图
//!   - 默认无训练SM-L2位运算导航 + 原始向量余弦精排
//!
//! 设计要点：
//!   - Bitset visited: 可复用位向量，2.5KB/20K 节点
//!   - Flat 邻接表: 连续内存，固定步长
//!   - BQ 签名连续存储: SoA 布局，预取友好

use crate::index::bq::{Bq2Signature, Bq2Store};
use crate::vector::{
    cosine_query_norm_f32_384, cosine_similarity_f32, cosine_similarity_f32_384_with_query_norm,
};
use rayon::prelude::*;
use std::cell::UnsafeCell;
use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// 默认SM-L2查询内核，以及可显式选择的校正与原生欧氏模式。
#[path = "quiver/corrected_sm.rs"]
pub mod corrected_sm;

#[derive(Debug, Copy, Clone, PartialEq)]
pub struct NonNanF32(pub f32);

impl Eq for NonNanF32 {}
impl PartialOrd for NonNanF32 {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for NonNanF32 {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0
            .partial_cmp(&other.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    }
}

/// 查询时导航评分器。评分越小，候选越优先；该抽象不参与 QuIVer 建图或裁边。
pub trait NavigationScorer {
    fn score(&mut self, node_id: u64, bq_distance: u32) -> u32;

    fn accept_result(&mut self, _node_id: u64) -> bool {
        true
    }
}

/// 与历史 QuIVer 查询完全等价的纯 BQ 导航评分器。
#[derive(Debug, Default, Clone, Copy)]
pub struct BqNavigationScorer;

impl NavigationScorer for BqNavigationScorer {
    #[inline(always)]
    fn score(&mut self, _node_id: u64, bq_distance: u32) -> u32 {
        bq_distance
    }
}

// ── Bitset ──

struct Bitset {
    data: Vec<u64>,
    len: usize,
}

impl Bitset {
    fn new(n: usize) -> Self {
        Self {
            data: vec![0u64; n.div_ceil(64)],
            len: n,
        }
    }
    #[inline(always)]
    fn set(&mut self, i: usize) {
        self.data[i >> 6] |= 1u64 << (i & 63);
    }
    #[inline(always)]
    fn test(&self, i: usize) -> bool {
        (self.data[i >> 6] >> (i & 63)) & 1 != 0
    }
    fn clear(&mut self) {
        self.data.iter_mut().for_each(|x| *x = 0);
    }
    fn grow(&mut self, new_n: usize) {
        let need = new_n.div_ceil(64);
        if need > self.data.len() {
            self.data.resize(need, 0);
        }
        self.len = new_n;
    }
}

struct SparseBitset {
    data: Vec<u64>,
    touched_words: Vec<usize>,
}

struct SearchScratch384 {
    visited: SparseBitset,
    candidates: BinaryHeap<Reverse<(NonNanF32, u32)>>,
    results: BinaryHeap<(NonNanF32, u32)>,
    vector: Vec<f32>,
    scored: Vec<(f32, u32)>,
}

impl SearchScratch384 {
    fn new() -> Self {
        Self {
            visited: SparseBitset::new(0),
            candidates: BinaryHeap::new(),
            results: BinaryHeap::new(),
            vector: Vec::with_capacity(384),
            scored: Vec::new(),
        }
    }
}

impl SparseBitset {
    fn new(n: usize) -> Self {
        Self {
            data: vec![0; n.div_ceil(64)],
            touched_words: Vec::new(),
        }
    }

    fn begin(&mut self) {
        for word in self.touched_words.drain(..) {
            self.data[word] = 0;
        }
    }

    #[inline(always)]
    fn set(&mut self, index: usize) {
        let word = index >> 6;
        if self.data[word] == 0 {
            self.touched_words.push(word);
        }
        self.data[word] |= 1u64 << (index & 63);
    }

    #[inline(always)]
    fn test(&self, index: usize) -> bool {
        (self.data[index >> 6] >> (index & 63)) & 1 != 0
    }

    fn grow(&mut self, new_n: usize) {
        let words = new_n.div_ceil(64);
        if words > self.data.len() {
            self.data.resize(words, 0);
        }
    }
}

trait SearchVisited {
    fn begin(&mut self);
    fn set(&mut self, index: usize);
    fn test(&self, index: usize) -> bool;
}

impl SearchVisited for Bitset {
    fn begin(&mut self) {
        self.clear();
    }

    fn set(&mut self, index: usize) {
        self.set(index);
    }

    fn test(&self, index: usize) -> bool {
        self.test(index)
    }
}

impl SearchVisited for SparseBitset {
    fn begin(&mut self) {
        self.begin();
    }

    fn set(&mut self, index: usize) {
        self.set(index);
    }

    fn test(&self, index: usize) -> bool {
        self.test(index)
    }
}

// ── Flat neighbor list ──
// Layer 0: 每节点最多 m0 个邻居，存为 [degree, n0, n1, ..., n_{m0-1}] stride = m0+1
// Upper layers: 用 Vec<Vec<u32>>（节点少，性能不敏感）

const EMPTY_NB: u32 = u32::MAX;

struct FlatAdj {
    data: Vec<u32>, // n * stride 个 u32
    stride: usize,  // m0 + 1 (第一个元素是度数)
}

struct SpinLockGuard<'a> {
    lock: &'a AtomicBool,
}

impl Drop for SpinLockGuard<'_> {
    fn drop(&mut self) {
        self.lock.store(false, Ordering::Release);
    }
}

#[repr(transparent)]
struct NodeGuard<'a>((u32, SpinLockGuard<'a>));

impl NodeGuard<'_> {
    #[inline(always)]
    fn node(&self) -> u32 {
        self.0.0
    }
}

struct StripedSpinLocks {
    locks: Vec<AtomicBool>,
    mask: usize,
}

impl StripedSpinLocks {
    fn new(nodes: usize, m: usize) -> Self {
        // 96核时需要足够的条纹数减少争用；每核至少 256 条纹
        let desired = nodes.clamp(256, 65536).max(m * 64);
        let count = desired.next_power_of_two();
        let locks = (0..count).map(|_| AtomicBool::new(false)).collect();
        Self {
            locks,
            mask: count - 1,
        }
    }

    #[inline(always)]
    fn stripe(&self, node: u32) -> usize {
        const FIB: usize = 0x9E3779B97F4A7C15usize;
        (node as usize).wrapping_mul(FIB) & self.mask
    }

    #[inline(always)]
    fn lock(&self, node: u32) -> NodeGuard<'_> {
        let lock = &self.locks[self.stripe(node)];
        while lock
            .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            std::hint::spin_loop();
        }
        NodeGuard((node, SpinLockGuard { lock }))
    }

    /// 计时版加锁：返回自旋等待耗时(ns)，用于构图性能探针
    #[inline(always)]
    fn lock_timed(&self, node: u32) -> (NodeGuard<'_>, u64) {
        let lock = &self.locks[self.stripe(node)];
        let t0 = Instant::now();
        let mut spun = false;
        while lock
            .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            spun = true;
            std::hint::spin_loop();
        }
        // 仅在确实自旋等待时计入耗时，避免无争用时 Instant 噪声主导
        let wait = if spun {
            t0.elapsed().as_nanos() as u64
        } else {
            0
        };
        (NodeGuard((node, SpinLockGuard { lock })), wait)
    }
}

/// 构图性能探针：通过环境变量 TRIVIUM_BUILD_PROFILE=1 启用，默认零开销。
/// 分段累计纳秒，定位 spin-lock 弱扩展的真正主因。
struct BuildProfile {
    enabled: bool,
    bitset_ns: AtomicU64,   // 每节点 Bitset 分配耗时
    beam_ns: AtomicU64,     // beam search 寻路耗时
    fwd_ns: AtomicU64,      // 前向候选准备+vamana_select+写自身边
    rev_wait_ns: AtomicU64, // 反向剪枝的自旋锁等待耗时
    rev_work_ns: AtomicU64, // 反向剪枝的锁内做活耗时(去掉等待)
    nodes: AtomicU64,       // 处理节点数
}

impl BuildProfile {
    fn new() -> Self {
        let enabled = std::env::var("TRIVIUM_BUILD_PROFILE").as_deref() == Ok("1");
        Self {
            enabled,
            bitset_ns: AtomicU64::new(0),
            beam_ns: AtomicU64::new(0),
            fwd_ns: AtomicU64::new(0),
            rev_wait_ns: AtomicU64::new(0),
            rev_work_ns: AtomicU64::new(0),
            nodes: AtomicU64::new(0),
        }
    }

    #[inline(always)]
    fn add(&self, counter: &AtomicU64, ns: u64) {
        if self.enabled {
            counter.fetch_add(ns, Ordering::Relaxed);
        }
    }

    fn report(&self, wall_secs: f64, threads: usize) {
        if !self.enabled {
            return;
        }
        let nodes = self.nodes.load(Ordering::Relaxed).max(1);
        let ms = |c: &AtomicU64| c.load(Ordering::Relaxed) as f64 / 1e6;
        let per = |c: &AtomicU64| c.load(Ordering::Relaxed) as f64 / nodes as f64;
        let total_cpu_ms = ms(&self.bitset_ns)
            + ms(&self.beam_ns)
            + ms(&self.fwd_ns)
            + ms(&self.rev_wait_ns)
            + ms(&self.rev_work_ns);
        tracing::info!(
            nodes,
            threads,
            wall_seconds = wall_secs,
            total_cpu_ms,
            "构图性能探针完成 (Graph build profiler completed)"
        );
        let line = |name: &str, c: &AtomicU64| {
            let cpu_ms = ms(c);
            let pct = if total_cpu_ms > 0.0 {
                cpu_ms / total_cpu_ms * 100.0
            } else {
                0.0
            };
            tracing::info!(
                stage = name,
                cpu_ms,
                percent = pct,
                per_node_ns = per(c),
                "构图阶段性能 (Graph build stage profile)"
            );
        };
        line("Bitset分配/allocate", &self.bitset_ns);
        line("束搜索寻路/beam search", &self.beam_ns);
        line("前向选边/forward select", &self.fwd_ns);
        line("反向剪枝锁等待/reverse wait", &self.rev_wait_ns);
        line("反向剪枝工作/reverse work", &self.rev_work_ns);
    }
}

impl FlatAdj {
    fn new(stride: usize) -> Self {
        Self {
            data: Vec::new(),
            stride,
        }
    }

    /// 为新节点追加空邻居列表
    fn push_empty(&mut self) {
        self.data.push(0); // degree = 0
        for _ in 1..self.stride {
            self.data.push(EMPTY_NB);
        }
    }

    #[inline(always)]
    fn degree(&self, node: u32) -> usize {
        self.data[node as usize * self.stride] as usize
    }

    #[inline(always)]
    fn neighbors(&self, node: u32) -> &[u32] {
        let base = node as usize * self.stride;
        let deg = self.data[base] as usize;
        &self.data[base + 1..base + 1 + deg]
    }

    /// 追加一条边（不检查重复，调用方保证）
    fn push_neighbor(&mut self, node: u32, nb: u32) {
        let base = node as usize * self.stride;
        let deg = self.data[base] as usize;
        if deg + 1 < self.stride {
            self.data[base + 1 + deg] = nb;
            self.data[base] = (deg + 1) as u32;
        }
    }

    /// 替换整个邻居列表
    fn set_neighbors(&mut self, node: u32, nbs: &[u32]) {
        let base = node as usize * self.stride;
        let count = nbs.len().min(self.stride - 1);
        self.data[base] = count as u32;
        for i in 0..count {
            self.data[base + 1 + i] = nbs[i];
        }
        for i in count..(self.stride - 1) {
            self.data[base + 1 + i] = EMPTY_NB;
        }
    }

    fn contains(&self, node: u32, nb: u32) -> bool {
        self.neighbors(node).contains(&nb)
    }

    fn reset_full(&mut self, nodes: usize) {
        self.data.clear();
        self.data.resize(nodes * self.stride, EMPTY_NB);
        for node in 0..nodes {
            self.data[node * self.stride] = 0;
        }
    }
}

// ── BQ-Vamana 图 ──

struct ConcurrentFlatAdj {
    data: Box<[UnsafeCell<u32>]>,
    stride: usize,
    nodes: usize,
}

unsafe impl Sync for ConcurrentFlatAdj {}

impl ConcurrentFlatAdj {
    fn new(nodes: usize, stride: usize) -> Self {
        let len = nodes.checked_mul(stride).expect("并发邻接表容量溢出");
        let mut data = Vec::with_capacity(len);
        for i in 0..len {
            let value = if i % stride == 0 { 0 } else { EMPTY_NB };
            data.push(UnsafeCell::new(value));
        }
        Self {
            data: data.into_boxed_slice(),
            stride,
            nodes,
        }
    }

    #[inline(always)]
    fn check_node(&self, node: u32) {
        debug_assert!((node as usize) < self.nodes);
        debug_assert!((node as usize + 1) * self.stride <= self.data.len());
    }

    fn neighbors_locked(&self, node: u32, locks: &StripedSpinLocks) -> Vec<u32> {
        let guard = locks.lock(node);
        self.neighbors_with_guard(&guard)
    }

    fn neighbors_raw(&self, node: u32) -> Vec<u32> {
        self.check_node(node);
        unsafe {
            let base = node as usize * self.stride;
            let deg = *self.data[base].get() as usize;
            debug_assert!(deg < self.stride);
            let mut out = Vec::with_capacity(deg);
            for i in 0..deg.min(self.stride - 1) {
                let nb = *self.data[base + 1 + i].get();
                if nb != EMPTY_NB && (nb as usize) < self.nodes {
                    out.push(nb);
                }
            }
            out
        }
    }

    /// 邻接表单节点容量（不含度数槽）
    #[inline(always)]
    fn capacity(&self) -> usize {
        self.stride - 1
    }

    /// 读取节点当前度数（需持锁调用，惰性剪枝用）
    #[inline(always)]
    fn degree_raw(&self, node: u32) -> usize {
        self.check_node(node);
        unsafe { (*self.data[node as usize * self.stride].get() as usize).min(self.stride - 1) }
    }

    /// 判断节点邻居中是否已含 nb（需持锁调用，惰性剪枝用）
    fn contains_raw(&self, node: u32, nb: u32) -> bool {
        self.check_node(node);
        unsafe {
            let base = node as usize * self.stride;
            let deg = (*self.data[base].get() as usize).min(self.stride - 1);
            for i in 0..deg {
                if *self.data[base + 1 + i].get() == nb {
                    return true;
                }
            }
            false
        }
    }

    /// 追加一条边（不剪枝，调用方保证未满且无重复，需持锁调用）
    #[inline(always)]
    fn push_neighbor_raw(&self, node: u32, nb: u32) {
        self.check_node(node);
        unsafe {
            let base = node as usize * self.stride;
            let deg = *self.data[base].get() as usize;
            if deg + 1 < self.stride {
                *self.data[base + 1 + deg].get() = nb;
                *self.data[base].get() = (deg + 1) as u32;
            }
        }
    }

    fn neighbors_with_guard(&self, guard: &NodeGuard<'_>) -> Vec<u32> {
        self.neighbors_raw(guard.node())
    }

    fn set_neighbors_raw(&self, node: u32, nbs: &[u32]) {
        self.check_node(node);
        unsafe {
            let base = node as usize * self.stride;
            let count = nbs.len().min(self.stride - 1);
            *self.data[base].get() = count as u32;
            for i in 0..count {
                debug_assert!((nbs[i] as usize) < self.nodes);
                *self.data[base + 1 + i].get() = nbs[i];
            }
            for i in count..(self.stride - 1) {
                *self.data[base + 1 + i].get() = EMPTY_NB;
            }
        }
    }

    fn set_neighbors_with_guard(&self, guard: &NodeGuard<'_>, nbs: &[u32]) {
        self.set_neighbors_raw(guard.node(), nbs);
    }

    fn set_neighbors_locked(&self, node: u32, nbs: &[u32], locks: &StripedSpinLocks) {
        let guard = locks.lock(node);
        self.set_neighbors_with_guard(&guard, nbs);
    }

    fn set_neighbors_locked_fast(&self, node: u32, nbs: &[u32], locks: &StripedSpinLocks) {
        let _guard = locks.lock(node);
        self.set_neighbors_raw(node, nbs);
    }

    fn freeze_into_flat(self, dst: &mut FlatAdj) {
        dst.data.clear();
        dst.data.reserve(self.data.len());
        for cell in self.data.iter() {
            unsafe {
                dst.data.push(*cell.get());
            }
        }
        dst.stride = self.stride;
    }
}

struct ExperimentalBuildView<'a> {
    adj: &'a ConcurrentFlatAdj,
    n: usize,
    dim: usize,
    m0: usize,
    ef: usize,
    alpha: f32,
    sigs: &'a Bq2Store,
    locks: &'a StripedSpinLocks,
    profile: &'a BuildProfile,
    /// 反向剪枝模式：true=旧的"每条边全量剪枝"(A/B对照用)，false=惰性剪枝(默认)
    eager: bool,
}

impl ExperimentalBuildView<'_> {
    fn beam_search_l0_locked(
        &self,
        q_sig: &Bq2Signature,
        entry: u32,
        ef: usize,
        visited: &mut Bitset,
    ) -> Vec<(NonNanF32, u32)> {
        use std::cmp::Reverse;
        use std::collections::BinaryHeap;

        visited.clear();

        let mut candidates: BinaryHeap<Reverse<(NonNanF32, u32)>> =
            BinaryHeap::with_capacity(ef * 2);
        let mut results: BinaryHeap<(NonNanF32, u32)> = BinaryHeap::with_capacity(ef + 1);

        let d = NonNanF32(self.sigs.distance_to_sig(entry as usize, q_sig, self.dim) as f32);
        visited.set(entry as usize);
        candidates.push(Reverse((d, entry)));
        results.push((d, entry));

        while let Some(Reverse((cd, cur))) = candidates.pop() {
            if results.len() >= ef && cd > results.peek().unwrap().0 {
                break;
            }

            let nbs = self.adj.neighbors_locked(cur, self.locks);

            // 批量预取未访问邻居的 BQ 签名
            for &nb in &nbs {
                if !visited.test(nb as usize) {
                    self.sigs.prefetch_sig(nb as usize);
                }
            }

            for nb in nbs {
                if visited.test(nb as usize) {
                    continue;
                }
                visited.set(nb as usize);

                let nd = NonNanF32(self.sigs.distance_to_sig(nb as usize, q_sig, self.dim) as f32);
                if results.len() < ef || nd < results.peek().unwrap().0 {
                    candidates.push(Reverse((nd, nb)));
                    results.push((nd, nb));
                    if results.len() > ef {
                        results.pop();
                    }
                }
            }
        }

        let mut res: Vec<(NonNanF32, u32)> = results.into_vec();
        res.sort_unstable_by(|a, b| a.0.cmp(&b.0));
        res
    }

    fn connect_node_checked(&self, idx: u32, visited: &mut Bitset) {
        if idx == 0 {
            return;
        }

        let my_sig = self.sigs.get_sig(idx as usize);
        let candidates_sym = self.beam_search_l0_locked(&my_sig, 0, self.ef, visited);
        let mut candidates: Vec<(u32, u32)> = candidates_sym
            .into_iter()
            .filter(|&(_, id)| id != idx)
            .map(|(_, id)| (self.sigs.distance(idx as usize, id as usize, self.dim), id))
            .collect();

        let samples = self.ef.min(128).max(self.m0 * 2);
        let mut state = (idx as usize)
            .wrapping_mul(0x9E3779B97F4A7C15usize)
            .wrapping_add(0xBF58476D1CE4E5B9usize);
        for _ in 0..samples {
            state ^= state >> 30;
            state = state.wrapping_mul(0xBF58476D1CE4E5B9usize);
            state ^= state >> 27;
            state = state.wrapping_mul(0x94D049BB133111EBusize);
            state ^= state >> 31;
            let id = (state % self.n) as u32;
            if id != idx {
                candidates.push((self.sigs.distance(idx as usize, id as usize, self.dim), id));
            }
        }

        candidates.sort_unstable_by_key(|&(_, id)| id);
        candidates.dedup_by_key(|&mut (_, id)| id);
        candidates.sort_unstable_by_key(|&(d, _)| d);

        if candidates.is_empty() {
            candidates.push((self.sigs.distance(idx as usize, 0, self.dim), 0));
        }

        let selected =
            QuIVer::vamana_select(self.sigs, idx, &candidates, self.m0, self.dim, self.alpha);
        self.adj.set_neighbors_locked(idx, &selected, self.locks);

        for &nb in &selected {
            let guard = self.locks.lock(nb);
            let mut current = self.adj.neighbors_with_guard(&guard);
            if !current.contains(&idx) {
                current.push(idx);
            }
            let mut nb_candidates: Vec<(u32, u32)> = current
                .into_iter()
                .filter(|&n| n != nb)
                .map(|n| (self.sigs.distance(nb as usize, n as usize, self.dim), n))
                .collect();
            nb_candidates.sort_unstable_by_key(|&(_, id)| id);
            nb_candidates.dedup_by_key(|&mut (_, id)| id);
            nb_candidates.sort_unstable_by_key(|&(d, _)| d);
            let pruned =
                QuIVer::vamana_select(self.sigs, nb, &nb_candidates, self.m0, self.dim, self.alpha);
            self.adj.set_neighbors_with_guard(&guard, &pruned);
        }
    }

    fn connect_node_fast(&self, idx: u32, visited: &mut Bitset) {
        if idx == 0 {
            return;
        }

        let prof = self.profile.enabled;
        let my_sig = self.sigs.get_sig(idx as usize);
        let t_beam = if prof { Some(Instant::now()) } else { None };
        let candidates_sym = self.beam_search_l0_locked(&my_sig, 0, self.ef, visited);
        if let Some(t) = t_beam {
            self.profile
                .add(&self.profile.beam_ns, t.elapsed().as_nanos() as u64);
        }
        let t_fwd = if prof { Some(Instant::now()) } else { None };
        let mut candidates: Vec<(u32, u32)> = candidates_sym
            .into_iter()
            .filter(|&(_, id)| id != idx)
            .map(|(_, id)| (self.sigs.distance(idx as usize, id as usize, self.dim), id))
            .collect();

        let samples = self.ef.min(128).max(self.m0 * 2);
        let mut state = (idx as usize)
            .wrapping_mul(0x9E3779B97F4A7C15usize)
            .wrapping_add(0xBF58476D1CE4E5B9usize);
        for _ in 0..samples {
            state ^= state >> 30;
            state = state.wrapping_mul(0xBF58476D1CE4E5B9usize);
            state ^= state >> 27;
            state = state.wrapping_mul(0x94D049BB133111EBusize);
            state ^= state >> 31;
            let id = (state % self.n) as u32;
            if id != idx {
                candidates.push((self.sigs.distance(idx as usize, id as usize, self.dim), id));
            }
        }

        candidates.sort_unstable_by_key(|&(_, id)| id);
        candidates.dedup_by_key(|&mut (_, id)| id);
        candidates.sort_unstable_by_key(|&(d, _)| d);

        if candidates.is_empty() {
            candidates.push((self.sigs.distance(idx as usize, 0, self.dim), 0));
        }

        let selected =
            QuIVer::vamana_select(self.sigs, idx, &candidates, self.m0, self.dim, self.alpha);
        self.adj
            .set_neighbors_locked_fast(idx, &selected, self.locks);
        if let Some(t) = t_fwd {
            self.profile
                .add(&self.profile.fwd_ns, t.elapsed().as_nanos() as u64);
        }

        let cap = self.adj.capacity();
        for &nb in &selected {
            let (_guard, wait_ns) = self.locks.lock_timed(nb);
            self.profile.add(&self.profile.rev_wait_ns, wait_ns);
            let t_work = if prof { Some(Instant::now()) } else { None };

            // 惰性剪枝：邻居表未满则直接追加(O(deg))，仅当容量用尽才触发一次完整剪枝。
            // 邻接表 stride=m0*2+1 留有 2× headroom，使昂贵的 vamana_select(O(deg²))
            // 从"每条反向边都跑"降为"约每 m0 条才跑一次"，砍掉构图主成本。
            // eager=true 时恢复旧的"每条边全量剪枝"行为，用于 recall A/B 对照。
            if self.eager {
                let mut current = self.adj.neighbors_raw(nb);
                if !current.contains(&idx) {
                    current.push(idx);
                }
                let mut nb_candidates: Vec<(u32, u32)> = current
                    .into_iter()
                    .filter(|&n| n != nb)
                    .map(|n| (self.sigs.distance(nb as usize, n as usize, self.dim), n))
                    .collect();
                nb_candidates.sort_unstable_by_key(|&(_, id)| id);
                nb_candidates.dedup_by_key(|&mut (_, id)| id);
                nb_candidates.sort_unstable_by_key(|&(d, _)| d);
                let pruned = QuIVer::vamana_select(
                    self.sigs,
                    nb,
                    &nb_candidates,
                    self.m0,
                    self.dim,
                    self.alpha,
                );
                self.adj.set_neighbors_raw(nb, &pruned);
            } else if !self.adj.contains_raw(nb, idx) {
                if self.adj.degree_raw(nb) < cap {
                    self.adj.push_neighbor_raw(nb, idx);
                } else {
                    let mut current = self.adj.neighbors_raw(nb);
                    current.push(idx);
                    let mut nb_candidates: Vec<(u32, u32)> = current
                        .into_iter()
                        .filter(|&n| n != nb)
                        .map(|n| (self.sigs.distance(nb as usize, n as usize, self.dim), n))
                        .collect();
                    nb_candidates.sort_unstable_by_key(|&(_, id)| id);
                    nb_candidates.dedup_by_key(|&mut (_, id)| id);
                    nb_candidates.sort_unstable_by_key(|&(d, _)| d);
                    let pruned = QuIVer::vamana_select(
                        self.sigs,
                        nb,
                        &nb_candidates,
                        self.m0,
                        self.dim,
                        self.alpha,
                    );
                    self.adj.set_neighbors_raw(nb, &pruned);
                }
            }

            if let Some(t) = t_work {
                self.profile
                    .add(&self.profile.rev_work_ns, t.elapsed().as_nanos() as u64);
            }
        }
        self.profile.nodes.fetch_add(1, Ordering::Relaxed);
    }

    /// 构图后 final-prune：把惰性追加导致 deg>m0 的节点并行收敛到 m0。
    /// 每节点最多剪一次，O(n) 单次剪枝，相对原"每边重剪"成本可忽略。
    fn final_prune(&self, node: u32) {
        let deg = self.adj.degree_raw(node);
        if deg <= self.m0 {
            return;
        }
        let current = self.adj.neighbors_raw(node);
        let mut cand: Vec<(u32, u32)> = current
            .into_iter()
            .filter(|&n| n != node)
            .map(|n| (self.sigs.distance(node as usize, n as usize, self.dim), n))
            .collect();
        cand.sort_unstable_by_key(|&(_, id)| id);
        cand.dedup_by_key(|&mut (_, id)| id);
        cand.sort_unstable_by_key(|&(d, _)| d);
        let pruned = QuIVer::vamana_select(self.sigs, node, &cand, self.m0, self.dim, self.alpha);
        self.adj.set_neighbors_raw(node, &pruned);
    }
}

const DEFAULT_PREFILTER_SLOT_CACHE_BYTES: usize = 64 * 1024 * 1024;

type PrefilterSlotPosting = Arc<Vec<(u64, u32)>>;

struct PrefilterSlotCacheEntry {
    posting: PrefilterSlotPosting,
    bytes: usize,
    last_used: u64,
}

struct PrefilterSlotCacheState {
    entries: std::collections::HashMap<(u64, u64), PrefilterSlotCacheEntry>,
    bytes: usize,
    max_bytes: usize,
    clock: u64,
}

impl PrefilterSlotCacheState {
    fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
    }

    fn get(&mut self, key: (u64, u64)) -> Option<PrefilterSlotPosting> {
        self.clock = self.clock.wrapping_add(1);
        let entry = self.entries.get_mut(&key)?;
        entry.last_used = self.clock;
        Some(Arc::clone(&entry.posting))
    }

    fn insert(&mut self, key: (u64, u64), posting: PrefilterSlotPosting) {
        let bytes = posting
            .len()
            .saturating_mul(std::mem::size_of::<(u64, u32)>());
        if bytes > self.max_bytes {
            return;
        }
        if let Some(previous) = self.entries.remove(&key) {
            self.bytes = self.bytes.saturating_sub(previous.bytes);
        }
        while self.bytes.saturating_add(bytes) > self.max_bytes {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(key, _)| *key)
            else {
                break;
            };
            if let Some(removed) = self.entries.remove(&oldest) {
                self.bytes = self.bytes.saturating_sub(removed.bytes);
            }
        }
        self.clock = self.clock.wrapping_add(1);
        self.entries.insert(
            key,
            PrefilterSlotCacheEntry {
                posting,
                bytes,
                last_used: self.clock,
            },
        );
        self.bytes = self.bytes.saturating_add(bytes);
    }
}

impl Default for PrefilterSlotCacheState {
    fn default() -> Self {
        Self {
            entries: std::collections::HashMap::new(),
            bytes: 0,
            max_bytes: DEFAULT_PREFILTER_SLOT_CACHE_BYTES,
            clock: 0,
        }
    }
}

type PrefilterSlotCache = Mutex<PrefilterSlotCacheState>;

pub struct QuIVer {
    dim: usize,
    n: usize,
    m: usize,
    m0: usize,
    ef_construction: usize,
    ml: f64,
    alpha: f32,

    // Hot（常驻内存）
    bq_store: Bq2Store,
    // 显式安装的查询校正；复用layer0，结构或向量变化后失效。
    corrected_sm: Option<corrected_sm::CorrectedSmIndex>,
    // 默认无训练SM-L2；增量插入追加位码，删除仅屏蔽精排，旧文件由向量池恢复。
    default_sm: Option<corrected_sm::CorrectedSmIndex>,
    layer0: FlatAdj,
    upper_layers: Vec<Vec<Vec<u32>>>,
    node_max_layer: Vec<u8>,

    // ID 映射
    ids: Vec<u64>,                                       // internal_index → NodeId
    slot_indices: Vec<usize>, // internal_index → MemTable slot_index（精排用）
    id_to_internal: std::collections::HashMap<u64, u32>, // NodeId → internal_index（增量操作用）

    entry_point: u32,
    max_level: usize,

    // 增量管理
    tombstones: Vec<bool>, // internal_index → 是否已删除
    dirty_count: usize,    // 增量变更计数（tombstone + 追加节点）

    // 当前 QuIVer 实例范围内的属性 posting → internal slot 派生缓存。
    // QuIVer 重建会替换整个实例；增量变更会清空缓存，不参与持久化或建图。
    prefilter_slot_cache: PrefilterSlotCache,

    visited: Bitset, // 建图期间复用，搜索时每次新建
}

pub struct QuIVerConfig {
    pub m: usize,
    pub ef_construction: usize,
    /// Vamana α 参数：1.0=严格剪枝，1.2=推荐值，越大图越密
    pub alpha: f32,
}

impl Default for QuIVerConfig {
    fn default() -> Self {
        Self {
            m: 16,
            ef_construction: 128,
            alpha: 1.2,
        }
    }
}

pub struct QuIVerSearchConfig {
    pub top_k: usize,
    pub ef_search: usize,
    pub rerank_limit: Option<usize>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct QuIVerPrefilterMetrics {
    pub posting_lookup_ns: u64,
    pub node_mapping_ns: u64,
    pub bq_heap_scan_ns: u64,
    pub output_sort_ns: u64,
    pub cache_hit: bool,
    pub mapped_candidates: usize,
}

fn elapsed_ns(started: Instant) -> u64 {
    started.elapsed().as_nanos().min(u64::MAX as u128) as u64
}

impl QuIVerSearchConfig {
    #[inline]
    fn rerank_limit(&self) -> usize {
        self.rerank_limit.unwrap_or(self.ef_search).max(self.top_k)
    }
}

impl QuIVer {
    pub fn new(dim: usize, config: &QuIVerConfig) -> Self {
        assert!(
            dim <= crate::index::bq::MAX_BQ_DIM,
            "QuIVer 维度超过安全上限"
        );
        let m = config.m;
        let m0 = m * 2;
        Self {
            dim,
            n: 0,
            m,
            m0,
            ef_construction: config.ef_construction,
            ml: 1.0 / (m as f64).ln(),
            alpha: config.alpha,
            bq_store: Bq2Store::new(dim),
            corrected_sm: None,
            default_sm: if dim == 0 {
                None
            } else {
                Some(corrected_sm::CorrectedSmIndex::empty_routing(dim).expect("合法SM维度"))
            },
            layer0: FlatAdj::new(m0 * 2 + 1),
            upper_layers: Vec::new(),
            node_max_layer: Vec::new(),
            ids: Vec::new(),
            slot_indices: Vec::new(),
            id_to_internal: std::collections::HashMap::new(),
            entry_point: 0,
            max_level: 0,
            tombstones: Vec::new(),
            dirty_count: 0,
            prefilter_slot_cache: Mutex::new(PrefilterSlotCacheState::default()),
            visited: Bitset::new(0),
        }
    }

    fn random_level(&self, lcg: &mut u64) -> usize {
        *lcg = lcg
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let r = ((*lcg >> 33) as f64 / (1u64 << 31) as f64).max(1e-15);
        (-r.ln() * self.ml).floor() as usize
    }

    pub fn insert(&mut self, vector: &[f32], id: u64, slot_index: usize, lcg: &mut u64) {
        self.corrected_sm = None;
        assert_eq!(vector.len(), self.dim);
        let idx = self.n as u32;

        let sig = Bq2Signature::from_vector(vector);
        self.bq_store.push_sig(&sig);
        self.ids.push(id);
        self.slot_indices.push(slot_index);
        self.id_to_internal.insert(id, idx);
        self.tombstones.push(false);

        let level = self.random_level(lcg);
        self.node_max_layer.push(level as u8);

        // 扩展 layer0
        self.layer0.push_empty();

        // 扩展 upper layers
        while self.upper_layers.len() < level {
            // upper_layers[0] = layer 1, [1] = layer 2, ...
            self.upper_layers.push(vec![Vec::new(); self.n]);
        }
        for ul in self.upper_layers.iter_mut() {
            ul.push(Vec::new());
        }

        self.n += 1;

        if let Some(model) = &mut self.default_sm {
            model
                .push_routing_vector(vector, id)
                .expect("插入向量必须合法");
        }

        // 确保 visited bitset 够大
        self.visited.grow(self.n);

        if self.n == 1 {
            self.entry_point = 0;
            self.max_level = level;
            return;
        }

        let my_sig = self.bq_store.get_sig(idx as usize);
        let mut cur_node = self.entry_point;

        // ── 高层贪心下降（BQ 距离，不需要 f32 向量） ──
        for l in ((level + 1)..=self.max_level).rev() {
            let ul_idx = l - 1;
            if ul_idx < self.upper_layers.len() {
                loop {
                    let mut changed = false;
                    let cur_d = self
                        .bq_store
                        .distance(idx as usize, cur_node as usize, self.dim);
                    let mut best_d = cur_d;

                    for &nb in &self.upper_layers[ul_idx][cur_node as usize] {
                        let nd = self.bq_store.distance(idx as usize, nb as usize, self.dim);
                        if nd < best_d {
                            cur_node = nb;
                            best_d = nd;
                            changed = true;
                        }
                    }
                    if !changed {
                        break;
                    }
                }
            }
        }

        // 3. 高层搜索
        let mut visited = Bitset::new(self.n);
        for l in (level..=self.max_level).rev() {
            let res = self.beam_search_upper(&my_sig, l, cur_node, 1, &mut visited);
            if !res.is_empty() {
                cur_node = res[0].1;
            }
        }

        // 4. 新节点插入各层
        for l in (0..=level).rev() {
            let ef = self.ef_construction;
            let candidates_sym = if l == 0 {
                self.beam_search_l0(&my_sig, cur_node, ef, &mut visited)
            } else {
                self.beam_search_upper(&my_sig, l, cur_node, ef, &mut visited)
            };
            let candidates: Vec<(u32, u32)> = candidates_sym
                .into_iter()
                .map(|(_, id)| {
                    (
                        self.bq_store.distance(idx as usize, id as usize, self.dim),
                        id,
                    )
                })
                .collect();

            let max_nb = if l == 0 { self.m0 } else { self.m };
            let selected = self.select_neighbors(idx, &candidates, max_nb);

            if l == 0 {
                // 正向边：idx → selected
                for &nb in &selected {
                    if !self.layer0.contains(idx, nb) {
                        self.layer0.push_neighbor(idx, nb);
                    }
                }

                // ── Vamana 双向剪枝（核心）──
                // 对于每个被选中的邻居 nb，将 idx 加入 nb 的候选集，
                // 然后用 vamana_select 重新决定 nb 应该保留哪些邻居。
                // 这保证了反向边也经过多样性剪枝，而不是盲目堆积。
                for &nb in &selected {
                    // 收集 nb 的当前邻居 + 新候选 idx
                    let mut nb_candidates: Vec<(u32, u32)> = self
                        .layer0
                        .neighbors(nb)
                        .iter()
                        .map(|&n| (self.bq_store.distance(nb as usize, n as usize, self.dim), n))
                        .collect();

                    // 如果 idx 还不在 nb 的邻居中，加入候选
                    if !self.layer0.contains(nb, idx) {
                        let d = self.bq_store.distance(nb as usize, idx as usize, self.dim);
                        nb_candidates.push((d, idx));
                    }

                    // 按距离排序后做 Vamana 剪枝
                    nb_candidates.sort_unstable_by_key(|&(d, _)| d);
                    let pruned = Self::vamana_select(
                        &self.bq_store,
                        nb,
                        &nb_candidates,
                        self.m0,
                        self.dim,
                        self.alpha,
                    );
                    self.layer0.set_neighbors(nb, &pruned);
                }
            } else {
                let ul = l - 1;
                // 正向边
                for &nb in &selected {
                    if !self.upper_layers[ul][idx as usize].contains(&nb) {
                        self.upper_layers[ul][idx as usize].push(nb);
                    }
                }

                // 双向剪枝（上层）
                for &nb in &selected {
                    let mut nb_candidates: Vec<(u32, u32)> = self.upper_layers[ul][nb as usize]
                        .iter()
                        .map(|&n| (self.bq_store.distance(nb as usize, n as usize, self.dim), n))
                        .collect();

                    if !self.upper_layers[ul][nb as usize].contains(&idx) {
                        let d = self.bq_store.distance(nb as usize, idx as usize, self.dim);
                        nb_candidates.push((d, idx));
                    }

                    nb_candidates.sort_unstable_by_key(|&(d, _)| d);
                    let pruned = Self::vamana_select(
                        &self.bq_store,
                        nb,
                        &nb_candidates,
                        self.m,
                        self.dim,
                        self.alpha,
                    );
                    self.upper_layers[ul][nb as usize] = pruned;
                }
            }

            if !candidates.is_empty() {
                cur_node = candidates[0].1;
            }
        }

        if level > self.max_level {
            self.entry_point = idx;
            self.max_level = level;
        }
        if let Some(model) = &mut self.default_sm {
            model.set_routing_entry(self.entry_point);
        }
    }

    /// Vamana 选边
    fn select_neighbors(&self, target: u32, candidates: &[(u32, u32)], max_k: usize) -> Vec<u32> {
        Self::vamana_select(
            &self.bq_store,
            target,
            candidates,
            max_k,
            self.dim,
            self.alpha,
        )
    }

    /// Layer 0 搜索：cheap BQ 导航后用完整 2-bit BQ 距离重排候选
    fn beam_search_l0<V: SearchVisited>(
        &self,
        q_sig: &Bq2Signature,
        entry: u32,
        ef: usize,
        visited: &mut V,
    ) -> Vec<(NonNanF32, u32)> {
        let mut scorer = BqNavigationScorer;
        self.beam_search_l0_with_scorer(q_sig, entry, ef, visited, &mut scorer)
    }

    fn beam_search_l0_with_scorer<V: SearchVisited, S: NavigationScorer>(
        &self,
        q_sig: &Bq2Signature,
        entry: u32,
        ef: usize,
        visited: &mut V,
        scorer: &mut S,
    ) -> Vec<(NonNanF32, u32)> {
        #[cfg(target_arch = "x86_64")]
        if self.dim == 384
            && !*crate::index::bq::FORCE_NO_384_KERNEL
            && is_x86_feature_detected!("popcnt")
        {
            return self.beam_search_l0_impl::<true, V, S>(q_sig, entry, ef, visited, scorer);
        }
        self.beam_search_l0_impl::<false, V, S>(q_sig, entry, ef, visited, scorer)
    }

    fn beam_search_l0_impl<const DIM_384: bool, V: SearchVisited, S: NavigationScorer>(
        &self,
        q_sig: &Bq2Signature,
        entry: u32,
        ef: usize,
        visited: &mut V,
        scorer: &mut S,
    ) -> Vec<(NonNanF32, u32)> {
        use std::cmp::Reverse;
        use std::collections::BinaryHeap;

        visited.begin();

        let mut candidates: BinaryHeap<Reverse<(NonNanF32, u32)>> =
            BinaryHeap::with_capacity(ef * 2);
        let mut results: BinaryHeap<(NonNanF32, u32)> = BinaryHeap::with_capacity(ef + 1);

        let cheap_distance = |node: u32| -> u32 {
            #[cfg(target_arch = "x86_64")]
            if DIM_384 {
                return self
                    .bq_store
                    .distance_to_sig_cheap_384(node as usize, q_sig);
            }
            self.bq_store
                .distance_to_sig_cheap(node as usize, q_sig, self.dim)
        };
        let d = NonNanF32(scorer.score(self.ids[entry as usize], cheap_distance(entry)) as f32);
        visited.set(entry as usize);
        candidates.push(Reverse((d, entry)));
        results.push((d, entry));

        while let Some(Reverse((cd, cur))) = candidates.pop() {
            if results.len() >= ef && cd > results.peek().unwrap().0 {
                break;
            }

            let nbs = self.layer0.neighbors(cur);

            for &nb in nbs {
                if !visited.test(nb as usize) {
                    self.bq_store.prefetch_sig(nb as usize);
                }
            }

            for &nb in nbs {
                if visited.test(nb as usize) {
                    continue;
                }
                visited.set(nb as usize);

                let nd = NonNanF32(scorer.score(self.ids[nb as usize], cheap_distance(nb)) as f32);
                if results.len() < ef || nd < results.peek().unwrap().0 {
                    candidates.push(Reverse((nd, nb)));
                    results.push((nd, nb));
                    if results.len() > ef {
                        results.pop();
                    }
                }
            }
        }

        let mut res: Vec<(NonNanF32, u32)> = results.into_vec();
        for item in &mut res {
            item.0 = NonNanF32(
                self.bq_store
                    .distance_to_sig(item.1 as usize, q_sig, self.dim) as f32,
            );
        }
        res.sort_unstable_by(|a, b| a.0.cmp(&b.0));
        res
    }

    fn beam_search_l0_dual<S: NavigationScorer>(
        &self,
        q_sig: &Bq2Signature,
        entry: u32,
        ef: usize,
        scorer: &mut S,
        signal_quota_ppm: u32,
        signal_seed_ids: &[u64],
    ) -> Vec<(NonNanF32, u32)> {
        let mut discovered = Bitset::new(self.n);
        let mut expanded = Bitset::new(self.n);
        let mut vector_queue = BinaryHeap::with_capacity(ef.saturating_mul(2));
        let mut signal_queue = BinaryHeap::with_capacity(ef.saturating_mul(2));
        let mut vector_results = BinaryHeap::with_capacity(ef.saturating_add(1));
        let mut signal_results = BinaryHeap::with_capacity(ef.saturating_add(1));
        let distance = |node: u32| {
            self.bq_store
                .distance_to_sig_cheap(node as usize, q_sig, self.dim)
        };
        let add = |node: u32,
                   discovered: &mut Bitset,
                   vector_queue: &mut BinaryHeap<Reverse<(NonNanF32, u32)>>,
                   signal_queue: &mut BinaryHeap<Reverse<(NonNanF32, u32)>>,
                   vector_results: &mut BinaryHeap<(NonNanF32, u32)>,
                   signal_results: &mut BinaryHeap<(NonNanF32, u32)>,
                   scorer: &mut S| {
            if discovered.test(node as usize) {
                return;
            }
            discovered.set(node as usize);
            let vector_distance = NonNanF32(distance(node) as f32);
            let signal_distance =
                NonNanF32(scorer.score(self.ids[node as usize], vector_distance.0 as u32) as f32);
            vector_queue.push(Reverse((vector_distance, node)));
            signal_queue.push(Reverse((signal_distance, node)));
            vector_results.push((vector_distance, node));
            signal_results.push((signal_distance, node));
            if vector_results.len() > ef {
                vector_results.pop();
            }
            if signal_results.len() > ef {
                signal_results.pop();
            }
        };
        add(
            entry,
            &mut discovered,
            &mut vector_queue,
            &mut signal_queue,
            &mut vector_results,
            &mut signal_results,
            scorer,
        );
        for &id in signal_seed_ids {
            if let Some(&node) = self.id_to_internal.get(&id)
                && !self.tombstones[node as usize]
            {
                add(
                    node,
                    &mut discovered,
                    &mut vector_queue,
                    &mut signal_queue,
                    &mut vector_results,
                    &mut signal_results,
                    scorer,
                );
            }
        }

        let mut quota_accumulator = 0u64;
        loop {
            while vector_queue
                .peek()
                .is_some_and(|Reverse((_, node))| expanded.test(*node as usize))
            {
                vector_queue.pop();
            }
            while signal_queue
                .peek()
                .is_some_and(|Reverse((_, node))| expanded.test(*node as usize))
            {
                signal_queue.pop();
            }
            let vector_available = vector_queue.peek().is_some_and(|Reverse((score, _))| {
                vector_results.len() < ef || *score <= vector_results.peek().unwrap().0
            });
            let signal_available = signal_queue.peek().is_some_and(|Reverse((score, _))| {
                signal_results.len() < ef || *score <= signal_results.peek().unwrap().0
            });
            if !vector_available && !signal_available {
                break;
            }
            quota_accumulator = quota_accumulator.saturating_add(u64::from(signal_quota_ppm));
            let prefer_signal = quota_accumulator >= 1_000_000;
            if prefer_signal {
                quota_accumulator -= 1_000_000;
            }
            let current = if prefer_signal && signal_available || !vector_available {
                signal_queue.pop().map(|Reverse((_, node))| node)
            } else {
                vector_queue.pop().map(|Reverse((_, node))| node)
            };
            let Some(current) = current else {
                break;
            };
            if expanded.test(current as usize) {
                continue;
            }
            expanded.set(current as usize);
            let neighbors = self.layer0.neighbors(current);
            for &neighbor in neighbors {
                if !discovered.test(neighbor as usize) {
                    self.bq_store.prefetch_sig(neighbor as usize);
                }
            }
            for &neighbor in neighbors {
                add(
                    neighbor,
                    &mut discovered,
                    &mut vector_queue,
                    &mut signal_queue,
                    &mut vector_results,
                    &mut signal_results,
                    scorer,
                );
            }
        }

        let mut vector = vector_results.into_vec();
        let mut signal = signal_results.into_vec();
        vector.sort_unstable_by(|left, right| left.0.cmp(&right.0));
        signal.sort_unstable_by(|left, right| left.0.cmp(&right.0));
        let mut selected = Bitset::new(self.n);
        let mut candidates = Vec::with_capacity(ef);
        let mut vector_index = 0usize;
        let mut signal_index = 0usize;
        let mut merge_accumulator = 0u64;
        while candidates.len() < ef && (vector_index < vector.len() || signal_index < signal.len())
        {
            merge_accumulator = merge_accumulator.saturating_add(u64::from(signal_quota_ppm));
            let prefer_signal = merge_accumulator >= 1_000_000;
            if prefer_signal {
                merge_accumulator -= 1_000_000;
            }
            let source =
                if prefer_signal && signal_index < signal.len() || vector_index >= vector.len() {
                    let item = signal[signal_index];
                    signal_index += 1;
                    item
                } else {
                    let item = vector[vector_index];
                    vector_index += 1;
                    item
                };
            if selected.test(source.1 as usize) {
                continue;
            }
            selected.set(source.1 as usize);
            candidates.push(source);
        }
        for candidate in &mut candidates {
            candidate.0 = NonNanF32(self.bq_store.distance_to_sig(
                candidate.1 as usize,
                q_sig,
                self.dim,
            ) as f32);
        }
        candidates.sort_unstable_by(|left, right| left.0.cmp(&right.0));
        candidates
    }

    fn beam_search_l0_384_with_scorer<S: NavigationScorer>(
        &self,
        q_sig: &Bq2Signature,
        entry: u32,
        ef: usize,
        scratch: &mut SearchScratch384,
        scorer: &mut S,
    ) -> Vec<(NonNanF32, u32)> {
        scratch.visited.begin();
        scratch.candidates.clear();
        scratch.results.clear();
        scratch.candidates.reserve(ef.saturating_mul(2));
        scratch.results.reserve(ef.saturating_add(1));

        let distance = |scorer: &mut S, node: u32| -> NonNanF32 {
            let bq_distance = self
                .bq_store
                .distance_to_sig_cheap_384(node as usize, q_sig);
            NonNanF32(scorer.score(self.ids[node as usize], bq_distance) as f32)
        };
        let initial_distance = distance(scorer, entry);
        scratch.visited.set(entry as usize);
        scratch.candidates.push(Reverse((initial_distance, entry)));
        scratch.results.push((initial_distance, entry));

        while let Some(Reverse((candidate_distance, current))) = scratch.candidates.pop() {
            if scratch.results.len() >= ef && candidate_distance > scratch.results.peek().unwrap().0
            {
                break;
            }
            let neighbors = self.layer0.neighbors(current);
            for &neighbor in neighbors {
                if !scratch.visited.test(neighbor as usize) {
                    self.bq_store.prefetch_sig(neighbor as usize);
                }
            }
            for &neighbor in neighbors {
                if scratch.visited.test(neighbor as usize) {
                    continue;
                }
                scratch.visited.set(neighbor as usize);
                let neighbor_distance = distance(scorer, neighbor);
                if scratch.results.len() < ef
                    || neighbor_distance < scratch.results.peek().unwrap().0
                {
                    scratch
                        .candidates
                        .push(Reverse((neighbor_distance, neighbor)));
                    scratch.results.push((neighbor_distance, neighbor));
                    if scratch.results.len() > ef {
                        scratch.results.pop();
                    }
                }
            }
        }

        let mut candidates = scratch.results.drain().collect::<Vec<_>>();
        for candidate in &mut candidates {
            candidate.0 = NonNanF32(
                self.bq_store
                    .distance_to_sig(candidate.1 as usize, q_sig, 384) as f32,
            );
        }
        candidates.sort_unstable_by(|left, right| left.0.cmp(&right.0));
        candidates
    }

    /// Upper layer Symmetric beam search
    fn beam_search_upper(
        &self,
        q_sig: &Bq2Signature,
        layer: usize,
        entry: u32,
        ef: usize,
        visited: &mut Bitset,
    ) -> Vec<(NonNanF32, u32)> {
        use std::cmp::Reverse;
        use std::collections::BinaryHeap;

        if layer == 0 {
            return Vec::new();
        }
        let ul = layer - 1;
        if ul >= self.upper_layers.len() {
            return Vec::new();
        }

        visited.clear();
        let mut candidates: BinaryHeap<Reverse<(NonNanF32, u32)>> = BinaryHeap::new();
        let mut results: BinaryHeap<(NonNanF32, u32)> = BinaryHeap::with_capacity(ef + 1);

        let d = NonNanF32(
            self.bq_store
                .distance_to_sig(entry as usize, q_sig, self.dim) as f32,
        );
        visited.set(entry as usize);
        candidates.push(Reverse((d, entry)));
        results.push((d, entry));

        while let Some(Reverse((cd, cur))) = candidates.pop() {
            if results.len() >= ef && cd > results.peek().unwrap().0 {
                break;
            }

            let nbs: Vec<u32> = self.upper_layers[ul][cur as usize].clone();
            for nb in nbs {
                if visited.test(nb as usize) {
                    continue;
                }
                visited.set(nb as usize);
                let nd =
                    NonNanF32(self.bq_store.distance_to_sig(nb as usize, q_sig, self.dim) as f32);
                if results.len() < ef || nd < results.peek().unwrap().0 {
                    candidates.push(Reverse((nd, nb)));
                    results.push((nd, nb));
                    if results.len() > ef {
                        results.pop();
                    }
                }
            }
        }

        let mut res: Vec<(NonNanF32, u32)> = results.into_vec();
        res.sort_unstable_by(|a, b| a.0.cmp(&b.0));
        res
    }

    /// Vamana Robust Prune (带有 alpha 放宽因子的 Heuristic)
    fn vamana_select(
        sigs: &Bq2Store,
        target: u32,
        candidates: &[(u32, u32)],
        max_k: usize,
        dim: usize,
        alpha: f32,
    ) -> Vec<u32> {
        let mut selected: Vec<u32> = Vec::with_capacity(max_k);

        for &(dist_to_target, cid) in candidates {
            if cid == target {
                continue;
            }
            if selected.len() >= max_k {
                break;
            }

            // Vamana Prune: dist_to_selected < alpha * dist_to_target
            let dominated = selected.iter().any(|&s| {
                let dist_to_selected = sigs.distance(cid as usize, s as usize, dim);
                (dist_to_selected as f32) < alpha * (dist_to_target as f32)
            });

            if !dominated {
                selected.push(cid);
            }
        }

        if selected.len() < max_k {
            for &(_, cid) in candidates {
                if cid == target {
                    continue;
                }
                if selected.len() >= max_k {
                    break;
                }
                if !selected.contains(&cid) {
                    selected.push(cid);
                }
            }
        }

        selected
    }

    /// 两阶段搜索：默认无训练SM-L2导航 + 原始向量按需余弦精排。
    ///
    /// # 冷热分离
    /// - **Hot（Stage 1）**：默认导航访问紧凑SM位码、幅值、重建范数和图拓扑。
    /// - **Cold（Stage 2）**：按有效精排预算通过 `get_vec_f32` 回调读取原始向量。
    ///   未指定预算时默认为64，受候选宽度限制，并至少覆盖top_k。
    /// - 显式校正模式可以读取锚点；显式原生L2返回负平方距离。
    ///   尚未绑定原始向量的独立旧索引保留BQ兼容路径，数据库加载会恢复默认SM状态。
    ///
    /// `get_vec_f32(slot, buf)`：把 `slot` 对应节点的向量以 f32 写入 `buf`，
    /// 成功返回 `true`。调用方按需从向量池或mmap冷层读取，
    /// 默认查询无需传入或常驻第二份全量f32数组。
    pub fn search<F>(
        &self,
        query: &[f32],
        mut get_vec_f32: F,
        config: &QuIVerSearchConfig,
    ) -> Vec<(u64, f32)>
    where
        F: FnMut(usize, &mut Vec<f32>) -> bool,
    {
        if query.len() != self.dim
            || query.iter().any(|x| !x.is_finite())
            || self.n == 0
            || config.top_k == 0
        {
            return Vec::new();
        }
        if let Some(model) = self.corrected_sm.as_ref().or(self.default_sm.as_ref()) {
            let native_l2 = self.sm_native_l2_enabled();
            let norm = query.iter().map(|&x| (x as f64).powi(2)).sum::<f64>();
            let normalized;
            let sm_query = if !native_l2 && norm > 0. && (norm - 1.).abs() > 1e-5 {
                let scale = 1. / norm.sqrt();
                normalized = query
                    .iter()
                    .map(|&x| (x as f64 * scale) as f32)
                    .collect::<Vec<_>>();
                &normalized[..]
            } else {
                query
            };
            let top_k = config.top_k.min(self.n);
            let ef = config.ef_search.max(top_k).min(self.n);
            // 精排预算为上限；低宽度及top_k大于64时仍使用SM，不静默回退BQ。
            let budget = config.rerank_limit.unwrap_or(64).max(top_k).min(ef);
            let sm_config = QuIVerSearchConfig {
                top_k,
                ef_search: ef,
                rerank_limit: Some(budget),
            };
            let mut fill = |internal: usize, buffer: &mut Vec<f32>| {
                !self.tombstones[internal] && get_vec_f32(self.slot_indices[internal], buffer)
            };
            let mut output = model.search_routed(sm_query, &self.layer0, &sm_config, &mut fill);
            if output
                .as_ref()
                .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
                && self.corrected_sm_enabled()
                && let Some(default) = &self.default_sm
            {
                // 属性过滤屏蔽显式校正锚点时，使用无锚点默认SM，仍保持余弦精排。
                output = default.search_routed(sm_query, &self.layer0, &sm_config, &mut fill);
            }
            return match output {
                Ok(output) => output.neighbors,
                Err(error) => {
                    tracing::warn!(%error, "SM查询失败，拒绝切换评分或精排度量");
                    Vec::new()
                }
            };
        }
        // 仅缺少原始向量的独立旧sidecar仍使用BQ；数据库加载时会流式补齐SM。
        let mut scorer = BqNavigationScorer;
        self.search_with_scorer(query, get_vec_f32, config, &mut scorer)
    }

    /// 估算指定属性候选在 BQ2 空间中的相对密度。
    ///
    /// 返回“候选集合平均成对距离 / 全局平均成对距离”。小于 1 表示候选更聚集。
    /// 采样按排序后等距抽取，且仅比较相邻样本，保证成本有界与结果确定。
    pub fn vector_density_skew(
        &self,
        candidate_ids: &[u64],
        max_samples: usize,
    ) -> Option<(f64, usize)> {
        fn sample_slots(index: &QuIVer, ids: &[u64], limit: usize) -> Vec<usize> {
            let mut slots = ids
                .iter()
                .filter_map(|id| index.id_to_internal.get(id).copied())
                .map(|slot| slot as usize)
                .filter(|slot| !index.tombstones.get(*slot).copied().unwrap_or(true))
                .collect::<Vec<_>>();
            slots.sort_unstable();
            slots.dedup();
            if slots.len() > limit {
                let last = slots.len() - 1;
                slots = (0..limit)
                    .map(|position| slots[position * last / (limit - 1)])
                    .collect();
            }
            slots
        }

        fn mean_adjacent_distance(index: &QuIVer, slots: &[usize]) -> Option<f64> {
            let (sum, count) = slots.windows(2).fold((0u64, 0usize), |(sum, count), pair| {
                (
                    sum.saturating_add(u64::from(
                        index.bq_store.distance(pair[0], pair[1], index.dim),
                    )),
                    count + 1,
                )
            });
            (count > 0).then_some(sum as f64 / count as f64)
        }

        let limit = max_samples.clamp(2, 256);
        let candidate_slots = sample_slots(self, candidate_ids, limit);
        let all_ids = self
            .ids
            .iter()
            .copied()
            .filter(|id| self.id_to_internal.contains_key(id))
            .collect::<Vec<_>>();
        let global_slots = sample_slots(self, &all_ids, limit);
        let candidate_mean = mean_adjacent_distance(self, &candidate_slots)?;
        let global_mean = mean_adjacent_distance(self, &global_slots)?;
        if global_mean <= f64::EPSILON {
            return Some((1.0, candidate_slots.len()));
        }
        Some((
            (candidate_mean / global_mean).clamp(0.25, 4.0),
            candidate_slots.len(),
        ))
    }

    /// 对指定 NodeId 候选集合执行纯 BQ2 粗排，不访问原始向量。
    ///
    /// 该接口仅复用现有 BQ2 签名和 NodeId 映射，不修改 Vamana 图或建边语义。
    pub fn prefilter_candidates(
        &self,
        query: &[f32],
        candidate_ids: &[u64],
        limit: usize,
    ) -> Vec<(u64, u32)> {
        self.prefilter_candidates_profiled(query, candidate_ids, 0, 0, limit)
            .0
    }

    /// 使用当前 QuIVer 实例范围内的 internal slot posting 缓存执行 BQ2 粗排，
    /// 并返回可供 benchmark 分解的阶段耗时。缓存不落盘，也不参与 Vamana 建图。
    pub fn prefilter_candidates_profiled(
        &self,
        query: &[f32],
        candidate_ids: &[u64],
        posting_identity: u64,
        property_generation: u64,
        limit: usize,
    ) -> (Vec<(u64, u32)>, QuIVerPrefilterMetrics) {
        if query.len() != self.dim || limit == 0 {
            return (Vec::new(), QuIVerPrefilterMetrics::default());
        }
        let lookup_started = Instant::now();
        let cache_key = (posting_identity, property_generation);
        let cached = self
            .prefilter_slot_cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(cache_key);
        let posting_lookup_ns = elapsed_ns(lookup_started);
        let cache_hit = cached.is_some();
        let mapping_started = Instant::now();
        let slots = cached.unwrap_or_else(|| {
            let mapped = candidate_ids
                .iter()
                .map(|id| {
                    (
                        *id,
                        self.id_to_internal.get(id).copied().unwrap_or(u32::MAX),
                    )
                })
                .collect::<Vec<_>>();
            let mapped = Arc::new(mapped);
            self.prefilter_slot_cache
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .insert(cache_key, Arc::clone(&mapped));
            mapped
        });
        let node_mapping_ns = elapsed_ns(mapping_started);
        let signature = Bq2Signature::from_vector(query);
        let scan_started = Instant::now();
        let mut best = BinaryHeap::with_capacity(limit.min(slots.len()));
        let mut mapped_candidates = 0usize;
        for &(id, internal) in slots.iter() {
            let internal = internal as usize;
            if internal == u32::MAX as usize
                || self.tombstones.get(internal).copied().unwrap_or(true)
            {
                continue;
            }
            mapped_candidates += 1;
            let candidate = (
                self.bq_store
                    .distance_to_sig(internal, &signature, self.dim),
                id,
            );
            if best.len() < limit {
                best.push(candidate);
            } else if best.peek().is_some_and(|worst| candidate < *worst) {
                best.pop();
                best.push(candidate);
            }
        }
        let bq_heap_scan_ns = elapsed_ns(scan_started);
        let sort_started = Instant::now();
        let mut scored = best
            .into_iter()
            .map(|(distance, id)| (id, distance))
            .collect::<Vec<_>>();
        scored.sort_unstable_by(|left, right| {
            left.1.cmp(&right.1).then_with(|| left.0.cmp(&right.0))
        });
        let output_sort_ns = elapsed_ns(sort_started);
        (
            scored,
            QuIVerPrefilterMetrics {
                posting_lookup_ns,
                node_mapping_ns,
                bq_heap_scan_ns,
                output_sort_ns,
                cache_hit,
                mapped_candidates,
            },
        )
    }

    /// 实验性双队列联合导航。纯向量入口不会调用此方法。
    pub fn search_dual_queue<F, S>(
        &self,
        query: &[f32],
        mut get_vec_f32: F,
        config: &QuIVerSearchConfig,
        scorer: &mut S,
        signal_quota_ppm: u32,
        signal_seed_ids: &[u64],
    ) -> Vec<(u64, f32)>
    where
        F: FnMut(usize, &mut Vec<f32>) -> bool,
        S: NavigationScorer,
    {
        if self.n == 0 {
            return Vec::new();
        }
        assert_eq!(query.len(), self.dim);
        let query_signature = Bq2Signature::from_vector(query);
        let mut entry = self.entry_point;
        for layer in (1..=self.max_level).rev() {
            let upper = layer - 1;
            if upper >= self.upper_layers.len() {
                continue;
            }
            loop {
                let mut changed = false;
                let mut best =
                    self.bq_store
                        .distance_to_sig(entry as usize, &query_signature, self.dim);
                for &neighbor in &self.upper_layers[upper][entry as usize] {
                    let distance = self.bq_store.distance_to_sig(
                        neighbor as usize,
                        &query_signature,
                        self.dim,
                    );
                    if distance < best {
                        entry = neighbor;
                        best = distance;
                        changed = true;
                    }
                }
                if !changed {
                    break;
                }
            }
        }
        let candidates = self.beam_search_l0_dual(
            &query_signature,
            entry,
            config.ef_search,
            scorer,
            signal_quota_ppm,
            signal_seed_ids,
        );
        let rerank_limit = config.rerank_limit().min(candidates.len());
        let mut buffer = Vec::with_capacity(self.dim);
        let mut scored = Vec::with_capacity(rerank_limit);
        for &(_, internal) in candidates.iter().take(rerank_limit) {
            if self.tombstones[internal as usize]
                || !scorer.accept_result(self.ids[internal as usize])
            {
                continue;
            }
            let slot = self.slot_indices[internal as usize];
            if get_vec_f32(slot, &mut buffer) && buffer.len() == self.dim {
                scored.push((cosine_similarity_f32(query, &buffer), internal));
            }
        }
        scored.sort_unstable_by(|left, right| {
            right
                .0
                .partial_cmp(&left.0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.1.cmp(&right.1))
        });
        scored
            .into_iter()
            .take(config.top_k)
            .map(|(score, internal)| (self.ids[internal as usize], score))
            .collect()
    }

    /// 使用自定义查询时评分器搜索。仅显式联合查询应调用此入口。
    pub fn search_with_scorer<F, S>(
        &self,
        query: &[f32],
        mut get_vec_f32: F,
        config: &QuIVerSearchConfig,
        scorer: &mut S,
    ) -> Vec<(u64, f32)>
    where
        F: FnMut(usize, &mut Vec<f32>) -> bool,
        S: NavigationScorer,
    {
        if self.n == 0 {
            return Vec::new();
        }
        assert_eq!(query.len(), self.dim);
        let dim = self.dim;

        let q_sig = Bq2Signature::from_vector(query);
        let mut cur_node = self.entry_point;

        // 高层贪心下降
        for l in (1..=self.max_level).rev() {
            let ul = l - 1;
            if ul < self.upper_layers.len() {
                loop {
                    let mut changed = false;
                    let cur_d = self
                        .bq_store
                        .distance_to_sig(cur_node as usize, &q_sig, dim);
                    let mut best_d = cur_d;
                    for &nb in &self.upper_layers[ul][cur_node as usize] {
                        let nd = self.bq_store.distance_to_sig(nb as usize, &q_sig, dim);
                        if nd < best_d {
                            cur_node = nb;
                            best_d = nd;
                            changed = true;
                        }
                    }
                    if !changed {
                        break;
                    }
                }
            }
        }

        // Stage 1: Symmetric BQ beam search
        // 使用 thread_local Bitset 复用，避免每次查询 heap alloc
        thread_local! {
            static VISITED: std::cell::RefCell<Bitset> = std::cell::RefCell::new(Bitset::new(0));
            static SCRATCH_384: std::cell::RefCell<SearchScratch384> = std::cell::RefCell::new(SearchScratch384::new());
        }
        let use_384 =
            dim == 384 && !*crate::index::bq::FORCE_NO_384_KERNEL && cfg!(target_arch = "x86_64");
        if use_384 {
            return SCRATCH_384.with(|cell| {
                let mut scratch = cell.borrow_mut();
                scratch.visited.grow(self.n);
                let bq_candidates = self.beam_search_l0_384_with_scorer(
                    &q_sig,
                    cur_node,
                    config.ef_search,
                    &mut scratch,
                    scorer,
                );
                #[cfg(feature = "test-hooks")]
                crate::test_hooks::hit(
                    crate::test_hooks::ConcurrencyPoint::QuiverCandidateProduced,
                );
                #[cfg(feature = "test-hooks")]
                crate::test_hooks::hit(crate::test_hooks::ConcurrencyPoint::BeforeVectorRerank);
                self.rerank_candidates_384(
                    query,
                    &bq_candidates,
                    config,
                    &mut get_vec_f32,
                    &mut scratch,
                    scorer,
                )
            });
        }
        let bq_candidates = VISITED.with(|cell| {
            let mut visited = cell.borrow_mut();
            if visited.len < self.n {
                visited.grow(self.n);
            }
            self.beam_search_l0_with_scorer(
                &q_sig,
                cur_node,
                config.ef_search,
                &mut *visited,
                scorer,
            )
        });
        #[cfg(feature = "test-hooks")]
        crate::test_hooks::hit(crate::test_hooks::ConcurrencyPoint::QuiverCandidateProduced);

        // Stage 2: f32 按需精排（跳过 tombstone，通过 slot_indices 映射到冷存储）
        // 复用单个缓冲区，避免每个候选 heap alloc；冷向量按需取回仅触达 ~ef 个候选。
        #[cfg(feature = "test-hooks")]
        crate::test_hooks::hit(crate::test_hooks::ConcurrencyPoint::BeforeVectorRerank);
        let rerank_limit = config.rerank_limit().min(bq_candidates.len());
        let mut buf: Vec<f32> = Vec::with_capacity(dim);
        let mut scored: Vec<(f32, u32)> = Vec::with_capacity(rerank_limit);
        for &(_, nid) in bq_candidates.iter().take(rerank_limit) {
            if self.tombstones[nid as usize] || !scorer.accept_result(self.ids[nid as usize]) {
                continue;
            }
            let slot = self.slot_indices[nid as usize];
            if get_vec_f32(slot, &mut buf) && buf.len() == dim {
                scored.push((cosine_similarity_f32(query, &buf), nid));
            }
        }
        scored.sort_unstable_by(|a, b| b.0.partial_cmp(&a.0).unwrap());

        scored
            .iter()
            .take(config.top_k)
            .map(|&(sim, nid)| (self.ids[nid as usize], sim))
            .collect()
    }

    fn rerank_candidates_384<F, S>(
        &self,
        query: &[f32],
        bq_candidates: &[(NonNanF32, u32)],
        config: &QuIVerSearchConfig,
        get_vec_f32: &mut F,
        scratch: &mut SearchScratch384,
        scorer: &mut S,
    ) -> Vec<(u64, f32)>
    where
        F: FnMut(usize, &mut Vec<f32>) -> bool,
        S: NavigationScorer,
    {
        let rerank_limit = config.rerank_limit().min(bq_candidates.len());
        scratch.scored.clear();
        if scratch.scored.capacity() < rerank_limit {
            scratch
                .scored
                .reserve(rerank_limit - scratch.scored.capacity());
        }
        let query_norm = cosine_query_norm_f32_384(query).unwrap_or_default();
        for &(_, nid) in bq_candidates.iter().take(rerank_limit) {
            if self.tombstones[nid as usize] || !scorer.accept_result(self.ids[nid as usize]) {
                continue;
            }
            let slot = self.slot_indices[nid as usize];
            if get_vec_f32(slot, &mut scratch.vector) && scratch.vector.len() == 384 {
                scratch.scored.push((
                    cosine_similarity_f32_384_with_query_norm(query, &scratch.vector, query_norm),
                    nid,
                ));
            }
        }
        scratch
            .scored
            .sort_unstable_by(|left, right| right.0.partial_cmp(&left.0).unwrap());
        scratch
            .scored
            .iter()
            .take(config.top_k)
            .map(|&(score, nid)| (self.ids[nid as usize], score))
            .collect()
    }

    /// 便捷封装：从连续 f32 数组（按 slot 偏移）精排。
    ///
    /// 主要用于纯内存场景与单元测试。生产检索路径应直接调用 `search`
    /// 并传入按需读取 mmap 冷存储的回调，以保持冷热分离。
    pub fn search_flat(
        &self,
        query: &[f32],
        ext_vectors: &[f32],
        config: &QuIVerSearchConfig,
    ) -> Vec<(u64, f32)> {
        let dim = self.dim;
        self.search(
            query,
            |slot, buf| {
                let offset = slot * dim;
                if offset + dim <= ext_vectors.len() {
                    buf.clear();
                    buf.extend_from_slice(&ext_vectors[offset..offset + dim]);
                    true
                } else {
                    false // slot 越界（不应发生，防御性跳过）
                }
            },
            config,
        )
    }

    /// ═══ 并行批量构建（rayon 加速）═══
    ///
    /// 利用 rayon 并行计算 BQ 签名，预分配所有数据结构，
    /// 然后顺序插入建图。相比逐个 insert 减少了：
    ///   - BQ 签名计算时间（并行化）
    ///   - 动态扩容开销（一次性预分配）
    ///   - Visited bitset 重复分配（复用）
    pub fn batch_build(&mut self, vectors: &[f32], ids: &[u64], slot_idxs: &[usize]) {
        self.corrected_sm = None;
        let n = ids.len();
        let dim = self.dim;
        assert_eq!(vectors.len(), n * dim);
        assert_eq!(slot_idxs.len(), n);

        // ── Phase 1: 并行计算 BQ 签名 ──
        let sigs: Vec<Bq2Signature> = vectors
            .par_chunks(dim)
            .map(Bq2Signature::from_vector)
            .collect();

        // ── Phase 2: 预分配所有数据结构 ──
        self.bq_store.reserve(n);
        self.ids.reserve(n);
        self.slot_indices.reserve(n);
        self.tombstones.reserve(n);
        self.node_max_layer.reserve(n);

        // 预先计算所有层级
        let mut lcg: u64 = 12345;
        let mut levels = Vec::with_capacity(n);
        for _ in 0..n {
            levels.push(self.random_level(&mut lcg));
        }
        let _max_level = *levels.iter().max().unwrap_or(&0);

        // 预分配 Layer 0
        self.layer0.data.reserve(n * self.layer0.stride);

        // ── Phase 3: 逐个插入建图 ──
        // 使用预计算的签名，避免重复计算
        let mut visited = Bitset::new(0);
        for i in 0..n {
            let _v = &vectors[i * dim..(i + 1) * dim];
            let idx = self.n as u32;

            // 直接使用预计算的签名
            self.bq_store.push_sig(&sigs[i]);
            self.ids.push(ids[i]);
            self.slot_indices.push(slot_idxs[i]);
            self.id_to_internal.insert(ids[i], idx);
            self.tombstones.push(false);

            let level = levels[i];
            self.node_max_layer.push(level as u8);

            self.layer0.push_empty();
            while self.upper_layers.len() < level {
                self.upper_layers.push(vec![Vec::new(); self.n]);
            }
            for ul in self.upper_layers.iter_mut() {
                ul.push(Vec::new());
            }

            self.n += 1;
            visited.grow(self.n);

            if self.n == 1 {
                self.entry_point = 0;
                self.max_level = level;
                continue;
            }

            let my_sig = self.bq_store.get_sig(idx as usize);
            let mut cur_node = self.entry_point;

            // 高层贪心下降（BQ 距离）
            for l in ((level + 1)..=self.max_level).rev() {
                let ul_idx = l - 1;
                if ul_idx < self.upper_layers.len() {
                    loop {
                        let mut changed = false;
                        let cur_d = self.bq_store.distance(idx as usize, cur_node as usize, dim);
                        let mut best_d = cur_d;
                        for &nb in &self.upper_layers[ul_idx][cur_node as usize] {
                            let nd = self.bq_store.distance(idx as usize, nb as usize, dim);
                            if nd < best_d {
                                cur_node = nb;
                                best_d = nd;
                                changed = true;
                            }
                        }
                        if !changed {
                            break;
                        }
                    }
                }
            }

            // 高层搜索
            for l in (level..=self.max_level).rev() {
                let res = self.beam_search_upper(&my_sig, l, cur_node, 1, &mut visited);
                if !res.is_empty() {
                    cur_node = res[0].1;
                }
            }

            // 各层插入
            for l in (0..=level).rev() {
                let ef = self.ef_construction;
                let candidates_sym = if l == 0 {
                    self.beam_search_l0(&my_sig, cur_node, ef, &mut visited)
                } else {
                    self.beam_search_upper(&my_sig, l, cur_node, ef, &mut visited)
                };
                let candidates: Vec<(u32, u32)> = candidates_sym
                    .into_iter()
                    .map(|(_, id)| (self.bq_store.distance(idx as usize, id as usize, dim), id))
                    .collect();

                let max_nb = if l == 0 { self.m0 } else { self.m };
                let selected = self.select_neighbors(idx, &candidates, max_nb);

                if l == 0 {
                    for &nb in &selected {
                        if !self.layer0.contains(idx, nb) {
                            self.layer0.push_neighbor(idx, nb);
                        }
                    }
                    // Vamana 双向剪枝
                    for &nb in &selected {
                        let mut nb_candidates: Vec<(u32, u32)> = self
                            .layer0
                            .neighbors(nb)
                            .iter()
                            .map(|&n| (self.bq_store.distance(nb as usize, n as usize, dim), n))
                            .collect();
                        if !self.layer0.contains(nb, idx) {
                            let d = self.bq_store.distance(nb as usize, idx as usize, dim);
                            nb_candidates.push((d, idx));
                        }
                        nb_candidates.sort_unstable_by_key(|&(d, _)| d);
                        let pruned = Self::vamana_select(
                            &self.bq_store,
                            nb,
                            &nb_candidates,
                            max_nb,
                            dim,
                            self.alpha,
                        );
                        self.layer0.set_neighbors(nb, &pruned);
                    }
                } else {
                    let ul = l - 1;
                    for &nb in &selected {
                        if !self.upper_layers[ul][idx as usize].contains(&nb) {
                            self.upper_layers[ul][idx as usize].push(nb);
                        }
                        if !self.upper_layers[ul][nb as usize].contains(&idx) {
                            self.upper_layers[ul][nb as usize].push(idx);
                        }
                    }
                }

                if !candidates.is_empty() {
                    cur_node = candidates[0].1;
                }
            }

            if level > self.max_level {
                self.entry_point = idx;
                self.max_level = level;
            }
        }
        self.rebuild_default_sm(vectors);
    }

    pub fn batch_build_experimental_v2_checked(
        &mut self,
        vectors: &[f32],
        ids: &[u64],
        slot_idxs: &[usize],
    ) {
        self.batch_build_experimental_v2_impl(vectors, ids, slot_idxs, true);
    }

    pub fn batch_build_experimental_v2(
        &mut self,
        vectors: &[f32],
        ids: &[u64],
        slot_idxs: &[usize],
    ) {
        self.batch_build_experimental_v2_impl(vectors, ids, slot_idxs, false);
    }

    /// 使用外部流式编码得到的 BQ2 签名构建图，不保留全量 FP32 向量副本。
    pub(crate) fn batch_build_from_store(
        &mut self,
        ids: &[u64],
        slot_idxs: &[usize],
        store: Bq2Store,
    ) {
        self.corrected_sm = None;
        self.default_sm = None;
        let n = ids.len();
        let dim = self.dim;
        assert_eq!(slot_idxs.len(), n);
        assert_eq!(store.len(), n, "Bq2Store 长度必须与 ids 长度一致");
        if n == 0 {
            return;
        }

        // 直接使用外部 store，不做内部编码
        let mut lcg: u64 = 12345;
        let mut levels = Vec::with_capacity(n);
        for _ in 0..n {
            levels.push(self.random_level(&mut lcg) as u8);
        }

        self.n = n;
        self.bq_store = store;
        self.ids.clear();
        self.ids.extend_from_slice(ids);
        self.slot_indices.clear();
        self.slot_indices.extend_from_slice(slot_idxs);
        self.id_to_internal.clear();
        for (i, &id) in ids.iter().enumerate() {
            self.id_to_internal.insert(id, i as u32);
        }
        self.tombstones = vec![false; n];
        self.dirty_count = 0;
        self.node_max_layer = levels;
        self.entry_point = 0;
        self.max_level = 0;
        self.upper_layers.clear();
        self.visited = Bitset::new(n);
        self.layer0.reset_full(n);

        let locks = StripedSpinLocks::new(n, self.m0);
        let concurrent_adj = ConcurrentFlatAdj::new(n, self.layer0.stride);
        let profile = BuildProfile::new();
        let view = ExperimentalBuildView {
            adj: &concurrent_adj,
            n,
            dim,
            m0: self.m0,
            ef: self.ef_construction,
            alpha: self.alpha,
            sigs: &self.bq_store,
            locks: &locks,
            profile: &profile,
            eager: std::env::var("TRIVIUM_EAGER_PRUNE").as_deref() == Ok("1"),
        };

        let t_build = Instant::now();
        let chunk = 256usize;
        let rounds = n.div_ceil(chunk);
        for round in 0..rounds {
            let start = round * chunk;
            let end = ((round + 1) * chunk).min(n);
            (start..end).into_par_iter().for_each(|i| {
                let prof = profile.enabled;
                let t_bs = if prof { Some(Instant::now()) } else { None };
                let mut visited = Bitset::new(n);
                if let Some(t) = t_bs {
                    profile.add(&profile.bitset_ns, t.elapsed().as_nanos() as u64);
                }
                view.connect_node_fast(i as u32, &mut visited);
            });
        }
        // final-prune：把惰性追加导致 deg>m0 的节点并行收敛到 m0
        (0..n as u32)
            .into_par_iter()
            .for_each(|node| view.final_prune(node));
        profile.report(
            t_build.elapsed().as_secs_f64(),
            rayon::current_num_threads(),
        );

        concurrent_adj.freeze_into_flat(&mut self.layer0);
    }

    /// 使用外部预构建签名的实验兼容入口。
    #[cfg(feature = "ablation")]
    pub fn batch_build_with_store(
        &mut self,
        _vectors: &[f32],
        ids: &[u64],
        slot_idxs: &[usize],
        store: Bq2Store,
    ) {
        self.batch_build_from_store(ids, slot_idxs, store);
    }

    /// 获取 Layer 0 节点的邻居列表（**仅限实验**）。
    #[cfg(feature = "ablation")]
    pub fn layer0_neighbors(&self, node: u32) -> &[u32] {
        self.layer0.neighbors(node)
    }

    /// 获取图的入口节点索引（**仅限实验**）。
    #[cfg(feature = "ablation")]
    pub fn ablation_entry_point(&self) -> u32 {
        self.entry_point
    }

    fn batch_build_experimental_v2_impl(
        &mut self,
        vectors: &[f32],
        ids: &[u64],
        slot_idxs: &[usize],
        checked: bool,
    ) {
        self.corrected_sm = None;
        self.default_sm = None;
        let n = ids.len();
        let dim = self.dim;
        assert_eq!(vectors.len(), n * dim);
        assert_eq!(slot_idxs.len(), n);
        if n == 0 {
            return;
        }

        let mut store = Bq2Store::new(dim);
        store.reserve(n);
        for chunk in vectors.chunks(dim) {
            store.push_from_vector(chunk);
        }

        let mut lcg: u64 = 12345;
        let mut levels = Vec::with_capacity(n);
        for _ in 0..n {
            levels.push(self.random_level(&mut lcg) as u8);
        }

        self.n = n;
        self.bq_store = store;
        self.ids.clear();
        self.ids.extend_from_slice(ids);
        self.slot_indices.clear();
        self.slot_indices.extend_from_slice(slot_idxs);
        self.id_to_internal.clear();
        for (i, &id) in ids.iter().enumerate() {
            self.id_to_internal.insert(id, i as u32);
        }
        self.tombstones = vec![false; n];
        self.dirty_count = 0;
        self.node_max_layer = levels;
        self.entry_point = 0;
        self.max_level = 0;
        self.upper_layers.clear();
        self.visited = Bitset::new(n);
        self.layer0.reset_full(n);

        let locks = StripedSpinLocks::new(n, self.m0);
        let concurrent_adj = ConcurrentFlatAdj::new(n, self.layer0.stride);
        let profile = BuildProfile::new();
        let view = ExperimentalBuildView {
            adj: &concurrent_adj,
            n,
            dim,
            m0: self.m0,
            ef: self.ef_construction,
            alpha: self.alpha,
            sigs: &self.bq_store,
            locks: &locks,
            profile: &profile,
            eager: std::env::var("TRIVIUM_EAGER_PRUNE").as_deref() == Ok("1"),
        };

        let t_build = Instant::now();
        let chunk = 256usize;
        let rounds = n.div_ceil(chunk);
        for round in 0..rounds {
            let start = round * chunk;
            let end = ((round + 1) * chunk).min(n);
            (start..end).into_par_iter().for_each(|i| {
                let prof = profile.enabled;
                let t_bs = if prof { Some(Instant::now()) } else { None };
                let mut visited = Bitset::new(n);
                if let Some(t) = t_bs {
                    profile.add(&profile.bitset_ns, t.elapsed().as_nanos() as u64);
                }
                if checked {
                    view.connect_node_checked(i as u32, &mut visited);
                } else {
                    view.connect_node_fast(i as u32, &mut visited);
                }
            });
        }
        // final-prune：fast 路径惰性追加后收敛到 m0；checked 路径 deg≤m0 时为空操作
        (0..n as u32)
            .into_par_iter()
            .for_each(|node| view.final_prune(node));
        profile.report(
            t_build.elapsed().as_secs_f64(),
            rayon::current_num_threads(),
        );

        concurrent_adj.freeze_into_flat(&mut self.layer0);
        if cfg!(debug_assertions)
            || std::env::var("TRIVIUM_BQ_VAMANA_VALIDATE").as_deref() == Ok("1")
        {
            self.validate_layer0();
        }
        self.rebuild_default_sm(vectors);
    }

    pub fn batch_build_experimental(&mut self, vectors: &[f32], ids: &[u64], slot_idxs: &[usize]) {
        self.corrected_sm = None;
        let n = ids.len();
        let dim = self.dim;
        assert_eq!(vectors.len(), n * dim);
        assert_eq!(slot_idxs.len(), n);

        let sigs: Vec<Bq2Signature> = vectors
            .par_chunks(dim)
            .map(Bq2Signature::from_vector)
            .collect();

        self.bq_store.reserve(n);
        self.ids.reserve(n);
        self.slot_indices.reserve(n);
        self.tombstones.reserve(n);
        self.node_max_layer.reserve(n);

        let mut lcg: u64 = 12345;
        let mut levels = Vec::with_capacity(n);
        for _ in 0..n {
            levels.push(self.random_level(&mut lcg));
        }

        self.layer0.data.reserve(n * self.layer0.stride);

        let mut visited = Bitset::new(0);
        for i in 0..n {
            let _v = &vectors[i * dim..(i + 1) * dim];
            let idx = self.n as u32;

            self.bq_store.push_sig(&sigs[i]);
            self.ids.push(ids[i]);
            self.slot_indices.push(slot_idxs[i]);
            self.id_to_internal.insert(ids[i], idx);
            self.tombstones.push(false);

            let level = levels[i];
            self.node_max_layer.push(level as u8);

            self.layer0.push_empty();
            while self.upper_layers.len() < level {
                self.upper_layers.push(vec![Vec::new(); self.n]);
            }
            for ul in self.upper_layers.iter_mut() {
                ul.push(Vec::new());
            }

            self.n += 1;
            visited.grow(self.n);

            if self.n == 1 {
                self.entry_point = 0;
                self.max_level = level;
                continue;
            }

            let my_sig = self.bq_store.get_sig(idx as usize);
            let mut cur_node = self.entry_point;

            for l in ((level + 1)..=self.max_level).rev() {
                let ul_idx = l - 1;
                if ul_idx < self.upper_layers.len() {
                    loop {
                        let mut changed = false;
                        let cur_d = self.bq_store.distance(idx as usize, cur_node as usize, dim);
                        let mut best_d = cur_d;
                        for &nb in &self.upper_layers[ul_idx][cur_node as usize] {
                            let nd = self.bq_store.distance(idx as usize, nb as usize, dim);
                            if nd < best_d {
                                cur_node = nb;
                                best_d = nd;
                                changed = true;
                            }
                        }
                        if !changed {
                            break;
                        }
                    }
                }
            }

            for l in (level..=self.max_level).rev() {
                let res = self.beam_search_upper(&my_sig, l, cur_node, 1, &mut visited);
                if !res.is_empty() {
                    cur_node = res[0].1;
                }
            }

            for l in (0..=level).rev() {
                let ef = self.ef_construction;
                let candidates_sym = if l == 0 {
                    self.beam_search_l0(&my_sig, cur_node, ef, &mut visited)
                } else {
                    self.beam_search_upper(&my_sig, l, cur_node, ef, &mut visited)
                };
                let candidates: Vec<(u32, u32)> = candidates_sym
                    .into_iter()
                    .map(|(_, id)| (self.bq_store.distance(idx as usize, id as usize, dim), id))
                    .collect();

                let max_nb = if l == 0 { self.m0 } else { self.m };
                let selected = self.select_neighbors(idx, &candidates, max_nb);

                if l == 0 {
                    for &nb in &selected {
                        if !self.layer0.contains(idx, nb) {
                            self.layer0.push_neighbor(idx, nb);
                        }
                    }

                    let this_addr = self as *mut Self as usize;
                    selected.par_iter().for_each(|&nb| unsafe {
                        let this = &mut *(this_addr as *mut Self);
                        let mut nb_candidates: Vec<(u32, u32)> = this
                            .layer0
                            .neighbors(nb)
                            .iter()
                            .map(|&n| (this.bq_store.distance(nb as usize, n as usize, dim), n))
                            .collect();
                        if !this.layer0.contains(nb, idx) {
                            let d = this.bq_store.distance(nb as usize, idx as usize, dim);
                            nb_candidates.push((d, idx));
                        }
                        nb_candidates.sort_unstable_by_key(|&(d, _)| d);
                        let pruned = Self::vamana_select(
                            &this.bq_store,
                            nb,
                            &nb_candidates,
                            max_nb,
                            dim,
                            this.alpha,
                        );
                        this.layer0.set_neighbors(nb, &pruned);
                    });
                } else {
                    let ul = l - 1;
                    for &nb in &selected {
                        if !self.upper_layers[ul][idx as usize].contains(&nb) {
                            self.upper_layers[ul][idx as usize].push(nb);
                        }
                        if !self.upper_layers[ul][nb as usize].contains(&idx) {
                            self.upper_layers[ul][nb as usize].push(idx);
                        }
                    }
                }

                if !candidates.is_empty() {
                    cur_node = candidates[0].1;
                }
            }

            if level > self.max_level {
                self.entry_point = idx;
                self.max_level = level;
            }
        }
        self.rebuild_default_sm(vectors);
    }

    fn validate_layer0(&self) {
        if self.n == 0 {
            return;
        }
        debug_assert_eq!(self.layer0.data.len(), self.n * self.layer0.stride);
        for node in 0..self.n {
            let base = node * self.layer0.stride;
            let deg = self.layer0.data[base] as usize;
            assert!(
                deg < self.layer0.stride,
                "L0 节点 {} 度数 {} 超过 stride {}",
                node,
                deg,
                self.layer0.stride
            );
            let mut seen = Vec::with_capacity(deg);
            for i in 0..deg {
                let nb = self.layer0.data[base + 1 + i];
                assert!(nb != EMPTY_NB, "L0 节点 {} 有效邻居区出现空槽", node);
                assert!(
                    (nb as usize) < self.n,
                    "L0 节点 {} 邻居 {} 越界，n={}",
                    node,
                    nb,
                    self.n
                );
                assert!(nb as usize != node, "L0 节点 {} 出现自环", node);
                seen.push(nb);
            }
            seen.sort_unstable();
            for pair in seen.windows(2) {
                assert!(
                    pair[0] != pair[1],
                    "L0 节点 {} 出现重复邻居 {}",
                    node,
                    pair[0]
                );
            }
            for i in deg..(self.layer0.stride - 1) {
                assert!(
                    self.layer0.data[base + 1 + i] == EMPTY_NB,
                    "L0 节点 {} 无效邻居区出现非空槽",
                    node
                );
            }
        }
    }

    pub fn stats(&self) -> QuIVerStats {
        let hot_bq = self.bq_store.hot_bytes();
        let hot_l0 = self.layer0.data.len() * 4;
        let hot_upper: usize = self
            .upper_layers
            .iter()
            .map(|l| l.iter().map(|adj| adj.len() * 4 + 24).sum::<usize>())
            .sum();
        let tombstone_count = self.tombstones.iter().filter(|&&t| t).count();

        QuIVerStats {
            n: self.n,
            max_level: self.max_level,
            hot_bytes: hot_bq
                + hot_l0
                + hot_upper
                + self
                    .corrected_sm
                    .as_ref()
                    .map_or(0, |model| model.routing_owned_bytes())
                + self
                    .default_sm
                    .as_ref()
                    .map_or(0, |model| model.routing_owned_bytes()),
            tombstone_count,
            dirty_count: self.dirty_count,
            avg_degree_l0: if self.n > 0 {
                (0..self.n)
                    .map(|i| self.layer0.degree(i as u32))
                    .sum::<usize>() as f64
                    / self.n as f64
            } else {
                0.0
            },
        }
    }

    /// VCP-PATCH: structural reachability, independent of navigation scoring
    /// and rerank budgets. Tombstones remain traversable intermediate nodes.
    pub fn reachable_node_count(&self) -> usize {
        if self.n == 0 { return 0; }
        let mut visited = vec![false; self.n];
        let mut queue = std::collections::VecDeque::new();
        visited[self.entry_point as usize] = true;
        queue.push_back(self.entry_point);
        let mut count = 1;
        while let Some(node) = queue.pop_front() {
            for &neighbor in self.layer0.neighbors(node) {
                if !visited[neighbor as usize] {
                    visited[neighbor as usize] = true;
                    queue.push_back(neighbor);
                    count += 1;
                }
            }
        }
        count
    }

    /// 图连通性诊断
    pub fn debug_connectivity(&self) {
        // 度数分布
        let mut deg0 = 0usize;
        let mut min_deg = usize::MAX;
        let mut max_deg = 0usize;
        for i in 0..self.n {
            let d = self.layer0.degree(i as u32);
            if d == 0 {
                deg0 += 1;
            }
            min_deg = min_deg.min(d);
            max_deg = max_deg.max(d);
        }
        tracing::debug!(
            min_degree = min_deg,
            max_degree = max_deg,
            isolated_nodes = deg0,
            nodes = self.n,
            "QuIVer L0 度数诊断 (QuIVer L0 degree diagnostics)"
        );

        // BFS 从入口点测可达性
        let mut visited = vec![false; self.n];
        let mut queue = std::collections::VecDeque::new();
        visited[self.entry_point as usize] = true;
        queue.push_back(self.entry_point);
        let mut reached = 1usize;
        while let Some(cur) = queue.pop_front() {
            for &nb in self.layer0.neighbors(cur) {
                if !visited[nb as usize] {
                    visited[nb as usize] = true;
                    queue.push_back(nb);
                    reached += 1;
                }
            }
        }
        tracing::debug!(
            reached,
            nodes = self.n,
            reachable_percent = 100.0 * reached as f64 / self.n as f64,
            "QuIVer 入口点可达性 (QuIVer entry-point reachability)"
        );

        // 入口点邻居数
        tracing::debug!(
            entry_point = self.entry_point,
            degree = self.layer0.degree(self.entry_point),
            "QuIVer 入口点诊断 (QuIVer entry-point diagnostics)"
        );
    }

    // ── 增量管理接口 ──

    /// 软删除：标记 tombstone，搜索时跳过（节点仍参与图遍历作为中转）
    pub fn soft_delete(&mut self, id: u64) -> bool {
        if let Some(&idx) = self.id_to_internal.get(&id) {
            if !self.tombstones[idx as usize] {
                self.corrected_sm = None;
                self.tombstones[idx as usize] = true;
                self.dirty_count += 1;
                self.prefilter_slot_cache
                    .get_mut()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clear();
            }
            true
        } else {
            false
        }
    }

    /// 是否需要全量重建（增量变更超过 25%）
    #[inline]
    pub fn needs_rebuild(&self) -> bool {
        self.n > 0 && self.dirty_count * 4 > self.n
    }

    /// 活跃节点数（总数 - tombstone 数）
    #[inline]
    pub fn active_count(&self) -> usize {
        self.n - self.tombstones.iter().filter(|&&t| t).count()
    }

    /// 节点总数（含 tombstone）
    #[inline]
    pub fn total_count(&self) -> usize {
        self.n
    }

    /// 递增增量变更计数（增量追加节点时调用）
    #[inline]
    pub fn dirty_count_inc(&mut self) {
        self.dirty_count += 1;
    }

    // ── 持久化 ──

    const QUIVER_MAGIC: &'static [u8; 4] = b"QUIV";
    pub const QUIVER_VERSION: u32 = 1;

    /// 将 QuIVer 索引保存到文件（POD memcpy 格式）
    ///
    /// 文件结构：
    /// ```text
    /// [Magic "QUIV" 4B] [Version 4B] [Header 40B]
    /// [BQ Signatures: n × 128B]
    /// [Layer0 FlatAdj: n × stride × 4B]
    /// [Tombstones: n × 1B]
    /// [IDs: n × 8B]
    /// [SlotIndices: n × 8B]
    /// [NodeMaxLayer: n × 1B]
    /// [Upper Layers: 变长编码]
    /// ```
    /// VCP-PATCH: embed graph bytes in the host snapshot; never publish files here.
    pub fn write_to<W: std::io::Write>(&self, mut w: W) -> std::io::Result<()> {
        w.write_all(Self::QUIVER_MAGIC)?;
        w.write_all(&Self::QUIVER_VERSION.to_le_bytes())?;
        for value in [
            self.dim as u32, self.n as u32, self.m as u32, self.m0 as u32,
            self.ef_construction as u32, self.alpha.to_bits(), self.entry_point,
            self.max_level as u32, self.dirty_count as u32, 0,
        ] {
            w.write_all(&value.to_le_bytes())?;
        }
        w.write_all(&(self.bq_store.chunks() as u32).to_le_bytes())?;
        for value in self.bq_store.pos_data().iter().chain(self.bq_store.strong_data()) {
            w.write_all(&value.to_le_bytes())?;
        }
        for value in &self.layer0.data {
            w.write_all(&value.to_le_bytes())?;
        }
        for &deleted in &self.tombstones {
            w.write_all(&[u8::from(deleted)])?;
        }
        for value in &self.ids {
            w.write_all(&value.to_le_bytes())?;
        }
        for &slot in &self.slot_indices {
            w.write_all(&(slot as u64).to_le_bytes())?;
        }
        w.write_all(&self.node_max_layer)?;
        w.write_all(&(self.upper_layers.len() as u32).to_le_bytes())?;
        for layer in &self.upper_layers {
            w.write_all(&(layer.len() as u32).to_le_bytes())?;
            for neighbors in layer {
                w.write_all(&(neighbors.len() as u16).to_le_bytes())?;
                for neighbor in neighbors {
                    w.write_all(&neighbor.to_le_bytes())?;
                }
            }
        }
        Ok(())
    }

    pub fn save_to_file(&self, path: &std::path::Path) -> std::io::Result<()> {
        use std::io::{BufWriter, Write};

        let tmp_path = path.with_extension("quiver.tmp");
        let file = std::fs::File::create(&tmp_path)?;
        let mut w = BufWriter::new(file);

        // Magic + Version
        w.write_all(Self::QUIVER_MAGIC)?;
        w.write_all(&Self::QUIVER_VERSION.to_le_bytes())?;

        // Header (40 bytes)
        w.write_all(&(self.dim as u32).to_le_bytes())?;
        w.write_all(&(self.n as u32).to_le_bytes())?;
        w.write_all(&(self.m as u32).to_le_bytes())?;
        w.write_all(&(self.m0 as u32).to_le_bytes())?;
        w.write_all(&(self.ef_construction as u32).to_le_bytes())?;
        w.write_all(&self.alpha.to_le_bytes())?;
        w.write_all(&self.entry_point.to_le_bytes())?;
        w.write_all(&(self.max_level as u32).to_le_bytes())?;
        w.write_all(&(self.dirty_count as u32).to_le_bytes())?;
        w.write_all(&[0u8; 4])?; // 保留字段

        // BQ Signatures（紧凑格式：chunks + pos + strong）
        let chunks = self.bq_store.chunks();
        w.write_all(&(chunks as u32).to_le_bytes())?;
        w.write_all(bytemuck::cast_slice(self.bq_store.pos_data()))?;
        w.write_all(bytemuck::cast_slice(self.bq_store.strong_data()))?;

        // Layer0 FlatAdj (POD memcpy)
        w.write_all(bytemuck::cast_slice(&self.layer0.data))?;

        // Tombstones
        let tomb_bytes: Vec<u8> = self
            .tombstones
            .iter()
            .map(|&t| if t { 1 } else { 0 })
            .collect();
        w.write_all(&tomb_bytes)?;

        // IDs
        for &id in &self.ids {
            w.write_all(&id.to_le_bytes())?;
        }

        // SlotIndices
        for &si in &self.slot_indices {
            w.write_all(&(si as u64).to_le_bytes())?;
        }

        // NodeMaxLayer
        w.write_all(&self.node_max_layer)?;

        // Upper Layers (变长编码)
        w.write_all(&(self.upper_layers.len() as u32).to_le_bytes())?;
        for layer in &self.upper_layers {
            w.write_all(&(layer.len() as u32).to_le_bytes())?;
            for adj in layer {
                w.write_all(&(adj.len() as u16).to_le_bytes())?;
                for &nb in adj {
                    w.write_all(&nb.to_le_bytes())?;
                }
            }
        }

        w.flush()?;
        let file = w.into_inner().map_err(|e| e.into_error())?;
        file.sync_all()?;
        drop(file);

        // 原子替换
        #[cfg(windows)]
        {
            // Windows: 需要先删除目标文件
            if path.exists() {
                std::fs::remove_file(path)?;
            }
        }
        std::fs::rename(&tmp_path, path)?;

        tracing::info!(
            "QuIVer 索引已持久化 (QuIVer index persisted)：{} 个节点，dim={}，max_level={}",
            self.n,
            self.dim,
            self.max_level
        );
        Ok(())
    }

    /// 从文件加载 QuIVer 索引
    pub fn load_from_file(path: &std::path::Path) -> std::io::Result<Self> {
        let file = std::fs::File::open(path)?;
        let data = unsafe { memmap2::MmapOptions::new().map(&file)? };
        Self::load_from_bytes(&data)
    }

    pub fn load_from_bytes(bytes: &[u8]) -> std::io::Result<Self> {
        fn invalid(message: impl Into<String>) -> std::io::Error {
            std::io::Error::new(std::io::ErrorKind::InvalidData, message.into())
        }

        fn checked_end(
            offset: usize,
            count: usize,
            width: usize,
            name: &str,
        ) -> std::io::Result<usize> {
            count
                .checked_mul(width)
                .and_then(|bytes| offset.checked_add(bytes))
                .ok_or_else(|| invalid(format!("{name} 长度溢出")))
        }

        if bytes.len() < 52 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "QuIVer 文件太小 (QuIVer file too small)",
            ));
        }

        // Magic
        if &bytes[0..4] != Self::QUIVER_MAGIC {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "无效的 QuIVer magic (Invalid QuIVer magic): {:?}",
                    &bytes[0..4]
                ),
            ));
        }

        // Version
        let version = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
        if version != Self::QUIVER_VERSION {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "不支持的 QuIVer 版本 (Unsupported QuIVer version): {}",
                    version
                ),
            ));
        }

        // Header
        let mut off = 8;
        let dim = u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap()) as usize;
        off += 4;
        if dim == 0 || dim > crate::index::bq::MAX_BQ_DIM {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "QuIVer 维度 {} 超出安全范围 1..={} ",
                    dim,
                    crate::index::bq::MAX_BQ_DIM
                ),
            ));
        }
        let n = u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap()) as usize;
        off += 4;
        let m = u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap()) as usize;
        off += 4;
        let m0 = u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap()) as usize;
        off += 4;
        let ef_construction = u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap()) as usize;
        off += 4;
        let alpha = f32::from_le_bytes(bytes[off..off + 4].try_into().unwrap());
        off += 4;
        let entry_point = u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap());
        off += 4;
        let max_level = u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap()) as usize;
        off += 4;
        let dirty_count = u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap()) as usize;
        off += 4;
        off += 4; // 保留字段

        if n == 0 || m == 0 || m0 == 0 || !alpha.is_finite() || alpha <= 0.0 {
            return Err(invalid("QuIVer 头部参数非法"));
        }
        if entry_point as usize >= n || max_level > n {
            return Err(invalid("QuIVer 入口或层级超出节点范围"));
        }

        // BQ Signatures（紧凑格式）
        let chunks = u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap()) as usize;
        off += 4;
        let expected_chunks = dim.div_ceil(64);
        if chunks != expected_chunks {
            return Err(invalid(format!(
                "QuIVer BQ chunks 不匹配: 期望 {expected_chunks}，实际 {chunks}"
            )));
        }
        let pos_end = checked_end(
            off,
            n,
            chunks
                .checked_mul(8)
                .ok_or_else(|| invalid("BQ 单签名长度溢出"))?,
            "BQ pos",
        )?;
        let strong_end = checked_end(
            pos_end,
            n,
            chunks
                .checked_mul(8)
                .ok_or_else(|| invalid("BQ 单签名长度溢出"))?,
            "BQ strong",
        )?;
        if strong_end > bytes.len() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "BQ 签名数据不完整 (BQ signature data incomplete)",
            ));
        }
        let pos_data: Vec<u64> = bytes[off..pos_end]
            .as_chunks::<8>()
            .0
            .iter()
            .map(|chunk| u64::from_le_bytes(*chunk))
            .collect();
        let strong_data: Vec<u64> = bytes[pos_end..strong_end]
            .as_chunks::<8>()
            .0
            .iter()
            .map(|chunk| u64::from_le_bytes(*chunk))
            .collect();
        let bq_store = Bq2Store::from_raw(pos_data, strong_data, chunks);
        off = strong_end;

        // Layer0 FlatAdj
        let stride = m0
            .checked_mul(2)
            .and_then(|value| value.checked_add(1))
            .ok_or_else(|| invalid("Layer0 stride 溢出"))?;
        let l0_end = checked_end(
            off,
            n,
            stride
                .checked_mul(4)
                .ok_or_else(|| invalid("Layer0 单节点长度溢出"))?,
            "Layer0",
        )?;
        if l0_end > bytes.len() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Layer0 数据不完整 (Layer0 data incomplete)",
            ));
        }
        let l0_data: Vec<u32> = bytes[off..l0_end]
            .as_chunks::<4>()
            .0
            .iter()
            .map(|chunk| u32::from_le_bytes(*chunk))
            .collect();
        off = l0_end;

        // Tombstones
        let tomb_end = checked_end(off, n, 1, "Tombstone")?;
        if tomb_end > bytes.len() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Tombstone 数据不完整 (Tombstone data incomplete)",
            ));
        }
        let tombstones: Vec<bool> = bytes[off..tomb_end].iter().map(|&b| b != 0).collect();
        off = tomb_end;

        // IDs
        let ids_end = checked_end(off, n, 8, "IDs")?;
        if ids_end > bytes.len() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "IDs 数据不完整 (IDs data incomplete)",
            ));
        }
        let ids: Vec<u64> = bytes[off..ids_end]
            .as_chunks::<8>()
            .0
            .iter()
            .map(|chunk| u64::from_le_bytes(*chunk))
            .collect();
        off = ids_end;

        // SlotIndices
        let si_end = checked_end(off, n, 8, "SlotIndices")?;
        if si_end > bytes.len() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "SlotIndices 数据不完整 (SlotIndices data incomplete)",
            ));
        }
        let slot_indices: Vec<usize> = bytes[off..si_end]
            .as_chunks::<8>()
            .0
            .iter()
            .map(|chunk| u64::from_le_bytes(*chunk) as usize)
            .collect();
        off = si_end;

        // NodeMaxLayer
        let nml_end = checked_end(off, n, 1, "NodeMaxLayer")?;
        if nml_end > bytes.len() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "NodeMaxLayer 数据不完整 (NodeMaxLayer data incomplete)",
            ));
        }
        let node_max_layer: Vec<u8> = bytes[off..nml_end].to_vec();
        off = nml_end;

        // Upper Layers
        if off + 4 > bytes.len() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Upper Layers header 不完整 (Upper Layers header incomplete)",
            ));
        }
        let num_upper = u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap()) as usize;
        off += 4;
        if num_upper != max_level {
            return Err(invalid("QuIVer upper layer 数量与 max_level 不一致"));
        }

        let mut upper_layers = Vec::with_capacity(num_upper);
        for _ in 0..num_upper {
            if off + 4 > bytes.len() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Upper layer 节点数不完整 (Upper layer node count incomplete)",
                ));
            }
            let layer_nodes = u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap()) as usize;
            off += 4;
            if layer_nodes != n {
                return Err(invalid("QuIVer upper layer 节点数与索引节点数不一致"));
            }

            let mut layer = Vec::with_capacity(layer_nodes);
            for _ in 0..layer_nodes {
                if off + 2 > bytes.len() {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "Upper adj 度数不完整 (Upper adj degree incomplete)",
                    ));
                }
                let deg = u16::from_le_bytes(bytes[off..off + 2].try_into().unwrap()) as usize;
                off += 2;

                let neighbors_end = checked_end(off, deg, 4, "Upper adj")?;
                if neighbors_end > bytes.len() {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "Upper adj 邻居列表不完整 (Upper adj neighbor list incomplete)",
                    ));
                }
                let mut adj = Vec::with_capacity(deg);
                for _ in 0..deg {
                    let neighbor = u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap());
                    if neighbor as usize >= n {
                        return Err(invalid("QuIVer upper layer 邻居越界"));
                    }
                    adj.push(neighbor);
                    off += 4;
                }
                layer.push(adj);
            }
            upper_layers.push(layer);
        }

        // VCP-PATCH: updates retain historical tombstones with the same ID.
        // Only live identities must be unique; deletion must resolve the live node.
        if off != bytes.len() {
            return Err(invalid("QuIVer 文件存在多余尾部"));
        }
        let mut id_to_internal = std::collections::HashMap::with_capacity(n);
        for (i, &id) in ids.iter().enumerate() {
            if id == 0 {
                return Err(invalid("QuIVer 节点 ID 为 0"));
            }
            if !tombstones[i] && id_to_internal.insert(id, i as u32).is_some() {
                return Err(invalid("QuIVer 活跃节点 ID 重复"));
            }
        }

        for node in 0..n {
            let base = node * stride;
            let degree = l0_data[base] as usize;
            if degree > stride - 1 {
                return Err(invalid("QuIVer Layer0 degree 越界"));
            }
            for &neighbor in &l0_data[base + 1..base + 1 + degree] {
                if neighbor as usize >= n {
                    return Err(invalid("QuIVer Layer0 邻居越界"));
                }
            }
        }

        tracing::info!(
            "QuIVer 索引从磁盘加载完成 (QuIVer index loaded from disk)：{} 个节点，dim={}，max_level={}，tombstone={}",
            n,
            dim,
            max_level,
            tombstones.iter().filter(|&&t| t).count()
        );

        Ok(Self {
            dim,
            n,
            m,
            m0,
            ef_construction,
            ml: 1.0 / (m as f64).ln(),
            alpha,
            bq_store,
            corrected_sm: None,
            default_sm: None,
            layer0: FlatAdj {
                data: l0_data,
                stride,
            },
            upper_layers,
            node_max_layer,
            ids,
            slot_indices,
            id_to_internal,
            entry_point,
            max_level,
            tombstones,
            dirty_count,
            prefilter_slot_cache: Mutex::new(PrefilterSlotCacheState::default()),
            visited: Bitset::new(n),
        })
    }
}

pub struct QuIVerStats {
    pub n: usize,
    pub max_level: usize,
    pub hot_bytes: usize,
    pub tombstone_count: usize,
    pub dirty_count: usize,
    pub avg_degree_l0: f64,
}

#[inline]
pub fn cosine_sim(a: &[f32], b: &[f32]) -> f32 {
    let (mut dot, mut na, mut nb) = (0.0f32, 0.0f32, 0.0f32);
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    dot / (na.sqrt() * nb.sqrt()).max(1e-30)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造 N 个正交基向量（dim 维），每个向量只在第 i%dim 维为 1.0
    #[allow(dead_code)] // 测试辅助函数，保留备用
    fn make_orthogonal_vectors(n: usize, dim: usize) -> Vec<f32> {
        let mut vecs = vec![0.0f32; n * dim];
        for i in 0..n {
            vecs[i * dim + (i % dim)] = 1.0;
        }
        vecs
    }

    /// 构造随机向量（确定性 LCG）
    fn make_random_vectors(n: usize, dim: usize, seed: u64) -> Vec<f32> {
        let mut vecs = vec![0.0f32; n * dim];
        let mut lcg = seed;
        for v in vecs.iter_mut() {
            lcg = lcg.wrapping_mul(6364136223846793005).wrapping_add(1);
            *v = ((lcg >> 33) as f32 / (1u32 << 31) as f32) * 2.0 - 1.0;
        }
        vecs
    }

    #[derive(Default)]
    struct RecordingBqScorer {
        visited_ids: Vec<u64>,
    }

    impl NavigationScorer for RecordingBqScorer {
        fn score(&mut self, node_id: u64, bq_distance: u32) -> u32 {
            self.visited_ids.push(node_id);
            bq_distance
        }
    }

    fn legacy_beam_search_l0(
        index: &QuIVer,
        q_sig: &Bq2Signature,
        entry: u32,
        ef: usize,
    ) -> (Vec<(NonNanF32, u32)>, Vec<u64>) {
        let mut visited = Bitset::new(index.n);
        visited.clear();
        let mut candidates = BinaryHeap::with_capacity(ef * 2);
        let mut results = BinaryHeap::with_capacity(ef + 1);
        let distance = |node: u32| {
            index
                .bq_store
                .distance_to_sig_cheap(node as usize, q_sig, index.dim)
        };
        let mut sequence = vec![index.ids[entry as usize]];
        let initial = NonNanF32(distance(entry) as f32);
        visited.set(entry as usize);
        candidates.push(Reverse((initial, entry)));
        results.push((initial, entry));
        while let Some(Reverse((candidate_distance, current))) = candidates.pop() {
            if results.len() >= ef && candidate_distance > results.peek().unwrap().0 {
                break;
            }
            for &neighbor in index.layer0.neighbors(current) {
                if visited.test(neighbor as usize) {
                    continue;
                }
                visited.set(neighbor as usize);
                sequence.push(index.ids[neighbor as usize]);
                let neighbor_distance = NonNanF32(distance(neighbor) as f32);
                if results.len() < ef || neighbor_distance < results.peek().unwrap().0 {
                    candidates.push(Reverse((neighbor_distance, neighbor)));
                    results.push((neighbor_distance, neighbor));
                    if results.len() > ef {
                        results.pop();
                    }
                }
            }
        }
        let mut output = results.into_vec();
        for item in &mut output {
            item.0 = NonNanF32(
                index
                    .bq_store
                    .distance_to_sig(item.1 as usize, q_sig, index.dim) as f32,
            );
        }
        output.sort_unstable_by(|left, right| left.0.cmp(&right.0));
        (output, sequence)
    }

    #[test]
    fn bq_有界预筛与全量排序结果逐项一致() {
        for dim in [64, 400, 768] {
            let n = 257;
            let vectors = make_random_vectors(n, dim, 0xB0_0DED + dim as u64);
            let ids = (20_000..20_000 + n as u64).collect::<Vec<_>>();
            let slots = (0..n).collect::<Vec<_>>();
            let mut index = QuIVer::new(dim, &QuIVerConfig::default());
            index.batch_build(&vectors, &ids, &slots);
            index.soft_delete(ids[31]);

            let query = &vectors[17 * dim..18 * dim];
            let signature = Bq2Signature::from_vector(query);
            let candidates = ids
                .iter()
                .rev()
                .copied()
                .chain([u64::MAX])
                .collect::<Vec<_>>();
            let mut expected = candidates
                .iter()
                .filter_map(|id| {
                    let internal = *index.id_to_internal.get(id)? as usize;
                    (!index.tombstones[internal]).then(|| {
                        (
                            *id,
                            index
                                .bq_store
                                .distance_to_sig(internal, &signature, index.dim),
                        )
                    })
                })
                .collect::<Vec<_>>();
            expected.sort_unstable_by(|left, right| {
                left.1.cmp(&right.1).then_with(|| left.0.cmp(&right.0))
            });

            for limit in [1, 7, 64, n, n + 20] {
                let mut wanted = expected.clone();
                wanted.truncate(limit);
                assert_eq!(
                    index.prefilter_candidates(query, &candidates, limit),
                    wanted
                );
            }
        }
    }

    #[test]
    fn bq_internal_slot_cache_严格遵守字节预算并按最近使用淘汰() {
        let posting = |start: u64| {
            Arc::new(
                (0..4)
                    .map(|offset| (start + offset, offset as u32))
                    .collect::<Vec<_>>(),
            )
        };
        let entry_bytes = 4 * std::mem::size_of::<(u64, u32)>();
        let mut cache = PrefilterSlotCacheState {
            max_bytes: entry_bytes * 2,
            ..PrefilterSlotCacheState::default()
        };
        cache.insert((1, 1), posting(10));
        cache.insert((2, 1), posting(20));
        assert!(cache.get((1, 1)).is_some());
        cache.insert((3, 1), posting(30));
        assert!(cache.bytes <= cache.max_bytes);
        assert!(cache.get((1, 1)).is_some());
        assert!(cache.get((2, 1)).is_none());
        assert!(cache.get((3, 1)).is_some());

        let oversized = Arc::new(vec![(1, 1); 9]);
        cache.insert((4, 1), oversized);
        assert!(cache.get((4, 1)).is_none());
        assert!(cache.bytes <= cache.max_bytes);
    }

    #[test]
    fn bq_internal_slot_posting_命中缓存且增量变更后安全失效() {
        let dim = 64;
        let vectors = make_random_vectors(24, dim, 0x5107_CA5E);
        let ids = (500..524).collect::<Vec<_>>();
        let slots = (0..24).collect::<Vec<_>>();
        let mut index = QuIVer::new(dim, &QuIVerConfig::default());
        index.batch_build(&vectors, &ids, &slots);
        let query = &vectors[..dim];

        let (cold, cold_metrics) = index.prefilter_candidates_profiled(query, &ids, 11, 1, 8);
        let (warm, warm_metrics) = index.prefilter_candidates_profiled(query, &ids, 11, 1, 8);
        assert_eq!(cold, warm);
        assert!(!cold_metrics.cache_hit);
        assert!(warm_metrics.cache_hit);
        assert_eq!(warm_metrics.mapped_candidates, ids.len());

        index.soft_delete(ids[3]);
        let (after_delete, delete_metrics) =
            index.prefilter_candidates_profiled(query, &ids, 11, 2, 8);
        assert!(!delete_metrics.cache_hit);
        assert_eq!(delete_metrics.mapped_candidates, ids.len() - 1);
        assert!(after_delete.iter().all(|(id, _)| *id != ids[3]));

        let new_id = 900;
        let mut lcg = 7;
        index.insert(&vectors[dim..dim * 2], new_id, 24, &mut lcg);
        let mut extended = ids.clone();
        extended.push(new_id);
        let (_, insert_metrics) = index.prefilter_candidates_profiled(query, &extended, 11, 3, 8);
        assert!(!insert_metrics.cache_hit);
        assert_eq!(insert_metrics.mapped_candidates, ids.len());
    }

    #[test]
    fn bq_有界预筛边界输入安全且排序确定() {
        let dim = 64;
        let vectors = make_random_vectors(8, dim, 0xB0_0E00);
        let ids = (100..108).collect::<Vec<_>>();
        let slots = (0..8).collect::<Vec<_>>();
        let mut index = QuIVer::new(dim, &QuIVerConfig::default());
        index.batch_build(&vectors, &ids, &slots);
        let query = &vectors[..dim];

        assert!(index.prefilter_candidates(query, &ids, 0).is_empty());
        assert!(
            index
                .prefilter_candidates(&query[..dim - 1], &ids, 4)
                .is_empty()
        );
        let first = index.prefilter_candidates(query, &ids, 4);
        let second = index.prefilter_candidates(query, &ids, 4);
        assert_eq!(first, second);
        assert!(first.windows(2).all(|pair| {
            pair[0].1 < pair[1].1 || (pair[0].1 == pair[1].1 && pair[0].0 < pair[1].0)
        }));
    }

    #[test]
    fn c1a_bq_scorer_与历史算法访问序列和候选逐项一致() {
        for dim in [64, 384, 768, 1536, 3072] {
            let n = 96;
            let vectors = make_random_vectors(n, dim, 0xC1A0_0000 + dim as u64);
            let ids = (10_000..10_000 + n as u64).collect::<Vec<_>>();
            let slots = (0..n).collect::<Vec<_>>();
            let mut index = QuIVer::new(
                dim,
                &QuIVerConfig {
                    m: 12,
                    ef_construction: 32,
                    alpha: 1.2,
                },
            );
            index.batch_build(&vectors, &ids, &slots);
            let query = &vectors[17 * dim..18 * dim];
            let query_signature = Bq2Signature::from_vector(query);
            let (legacy, legacy_sequence) =
                legacy_beam_search_l0(&index, &query_signature, index.entry_point, 48);
            let mut visited = Bitset::new(n);
            let mut scorer = RecordingBqScorer::default();
            let scored = index.beam_search_l0_impl::<false, Bitset, RecordingBqScorer>(
                &query_signature,
                index.entry_point,
                48,
                &mut visited,
                &mut scorer,
            );
            assert_eq!(scorer.visited_ids, legacy_sequence, "维度 {dim}");
            assert_eq!(scored, legacy, "维度 {dim}");
        }
    }

    #[test]
    fn c1a_公开纯向量搜索使用默认_sm_l2() {
        for dim in [64, 384, 768, 1536, 3072] {
            let n = 128;
            let vectors = make_random_vectors(n, dim, 0xC1A1_0000 + dim as u64);
            let ids = (20_000..20_000 + n as u64).collect::<Vec<_>>();
            let slots = (0..n).collect::<Vec<_>>();
            let mut index = QuIVer::new(
                dim,
                &QuIVerConfig {
                    m: 12,
                    ef_construction: 32,
                    alpha: 1.2,
                },
            );
            index.batch_build(&vectors, &ids, &slots);
            let query = &vectors[29 * dim..30 * dim];
            let config = QuIVerSearchConfig {
                top_k: 20,
                ef_search: 64,
                rerank_limit: Some(48),
            };
            let get_vector = |slot: usize, buffer: &mut Vec<f32>| {
                buffer.clear();
                buffer.extend_from_slice(&vectors[slot * dim..(slot + 1) * dim]);
                true
            };
            assert!(index.default_sm_l2_enabled());
            let actual = index.search(query, get_vector, &config);
            let norm = query
                .iter()
                .map(|&x| (x as f64).powi(2))
                .sum::<f64>()
                .sqrt();
            let normalized = query
                .iter()
                .map(|&x| (x as f64 / norm) as f32)
                .collect::<Vec<_>>();
            let reference = index
                .default_sm
                .as_ref()
                .unwrap()
                .search_routed(&normalized, &index.layer0, &config, get_vector)
                .unwrap();
            assert_eq!(actual, reference.neighbors, "维度 {dim}");
        }
    }

    #[test]
    fn sparse_bitset跨查询不串扰并支持扩容() {
        let mut visited = SparseBitset::new(2);
        visited.begin();
        visited.set(0);
        assert!(visited.test(0));
        assert!(!visited.test(1));
        visited.begin();
        assert!(!visited.test(0));
        visited.set(1);
        visited.grow(1000);
        assert!(visited.test(1));
        assert!(!visited.test(999));
        visited.set(999);
        assert!(visited.test(999));
    }

    #[test]
    fn dim384专用搜索与通用路径结果一致() {
        let dim = 384;
        let n = 256;
        let vectors = make_random_vectors(n, dim, 0xD1B5_4A32_D192_ED03);
        let ids = (0..n as u64).collect::<Vec<_>>();
        let slots = (0..n).collect::<Vec<_>>();
        let mut index = QuIVer::new(
            dim,
            &QuIVerConfig {
                m: 16,
                ef_construction: 64,
                alpha: 1.2,
            },
        );
        index.batch_build(&vectors, &ids, &slots);
        let config = QuIVerSearchConfig {
            top_k: 10,
            ef_search: 64,
            rerank_limit: None,
        };
        let query = &vectors[17 * dim..18 * dim];
        let specialized = index.search_flat(query, &vectors, &config);
        let q_sig = Bq2Signature::from_vector(query);
        let mut visited = Bitset::new(n);
        let mut scorer = BqNavigationScorer;
        let candidates = index.beam_search_l0_impl::<false, Bitset, BqNavigationScorer>(
            &q_sig,
            index.entry_point,
            config.ef_search,
            &mut visited,
            &mut scorer,
        );
        let mut generic = candidates
            .iter()
            .take(config.rerank_limit())
            .map(|&(_, node)| {
                let slot = index.slot_indices[node as usize];
                let vector = &vectors[slot * dim..(slot + 1) * dim];
                (
                    index.ids[node as usize],
                    cosine_similarity_f32(query, vector),
                )
            })
            .collect::<Vec<_>>();
        generic.sort_unstable_by(|left, right| right.1.partial_cmp(&left.1).unwrap());
        generic.truncate(config.top_k);
        assert_eq!(
            specialized.iter().map(|hit| hit.0).collect::<Vec<_>>(),
            generic.iter().map(|hit| hit.0).collect::<Vec<_>>()
        );
    }

    #[test]
    fn test_quiver_基础建图与搜索() {
        let config = QuIVerConfig {
            m: 16,
            ef_construction: 32,
            alpha: 1.2,
        };
        let mut quiver = QuIVer::new(4, &config);

        let vectors = vec![
            1.0f32, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ];
        let ids = vec![10, 20, 30, 40];
        let slots = vec![0, 1, 2, 3];

        quiver.batch_build_experimental_v2(&vectors, &ids, &slots);

        assert_eq!(quiver.active_count(), 4);
        assert_eq!(quiver.total_count(), 4);

        let query = vec![1.0f32, 0.0, 0.0, 0.0];
        let search_config = QuIVerSearchConfig {
            top_k: 2,
            ef_search: 10,
            rerank_limit: None,
        };

        let results = quiver.search_flat(&query, &vectors, &search_config);
        assert!(!results.is_empty());
        assert_eq!(results[0].0, 10);

        // 测试软删除
        quiver.soft_delete(10);
        assert_eq!(quiver.active_count(), 3);

        let results_after = quiver.search_flat(&query, &vectors, &search_config);
        if !results_after.is_empty() {
            assert_ne!(results_after[0].0, 10);
        }

        let stats = quiver.stats();
        assert_eq!(stats.n, 4);
        assert_eq!(stats.tombstone_count, 1);

        assert!(!quiver.needs_rebuild());
    }

    #[test]
    fn test_quiver_多路径建图与序列化() {
        let config = QuIVerConfig {
            m: 16,
            ef_construction: 32,
            alpha: 1.2,
        };
        let mut quiver = QuIVer::new(4, &config);

        let vectors = vec![
            1.0f32, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ];
        let ids = vec![10, 20, 30, 40];
        let slots = vec![0, 1, 2, 3];

        // 测试批量建图
        quiver.batch_build(&vectors, &ids, &slots);
        assert_eq!(quiver.total_count(), 4);

        // 测试追加式批量建图
        quiver.batch_build_experimental(&vectors, &[50, 60, 70, 80], &[4, 5, 6, 7]);
        assert_eq!(quiver.total_count(), 8);

        // 测试带校验的批量建图（会重置图）
        quiver.batch_build_experimental_v2_checked(&vectors, &ids, &slots);
        assert_eq!(quiver.total_count(), 4);

        // 测试单节点增量插入
        let mut lcg = 12345;
        let v5 = vec![0.5, 0.5, 0.0, 0.0];
        quiver.insert(&v5, 50, 4, &mut lcg);
        assert_eq!(quiver.total_count(), 5);

        quiver.dirty_count_inc();
        quiver.dirty_count_inc();
        assert!(quiver.needs_rebuild());

        quiver.debug_connectivity();

        // 测试序列化与反序列化
        let path = std::path::Path::new("test_quiver_ser.quiv");
        quiver.save_to_file(path).unwrap();

        let loaded = QuIVer::load_from_file(path).unwrap();
        assert_eq!(loaded.total_count(), 5);
        assert_eq!(loaded.active_count(), 5);
        assert_eq!(loaded.dim, 4);
        assert_eq!(loaded.entry_point, quiver.entry_point);
        assert_eq!(loaded.ids, vec![10, 20, 30, 40, 50]);

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn test_quiver_中等规模搜索() {
        // 50 个节点，8 维，测试更完整的 beam search 路径
        let dim = 8;
        let n = 50;
        let config = QuIVerConfig {
            m: 8,
            ef_construction: 32,
            alpha: 1.2,
        };
        let mut quiver = QuIVer::new(dim, &config);

        let vectors = make_random_vectors(n, dim, 42);
        let ids: Vec<u64> = (0..n as u64).collect();
        let slots: Vec<usize> = (0..n).collect();

        quiver.batch_build_experimental_v2(&vectors, &ids, &slots);
        assert_eq!(quiver.total_count(), n);

        let stats = quiver.stats();
        assert!(stats.avg_degree_l0 > 0.0);
        assert!(stats.hot_bytes > 0);

        // 用第 0 号向量自身做查询，应该能搜到自己
        let query = vectors[0..dim].to_vec();
        let search_config = QuIVerSearchConfig {
            top_k: 5,
            ef_search: 32,
            rerank_limit: Some(20),
        };
        let results = quiver.search_flat(&query, &vectors, &search_config);
        assert!(!results.is_empty());
        assert_eq!(results[0].0, 0); // 自身应为 Top-1

        // 删除一半节点再搜索
        for i in 0..n / 2 {
            quiver.soft_delete(i as u64);
        }
        assert_eq!(quiver.active_count(), n - n / 2);
        let results2 = quiver.search_flat(&query, &vectors, &search_config);
        for (id, _) in &results2 {
            assert!(*id >= n as u64 / 2, "已删除节点不应出现在结果中");
        }
    }

    #[test]
    fn test_quiver_空图搜索() {
        let config = QuIVerConfig::default();
        let quiver = QuIVer::new(4, &config);
        assert_eq!(quiver.total_count(), 0);
        assert_eq!(quiver.active_count(), 0);

        let query = vec![1.0f32, 0.0, 0.0, 0.0];
        let search_config = QuIVerSearchConfig {
            top_k: 5,
            ef_search: 10,
            rerank_limit: None,
        };
        let results = quiver.search_flat(&query, &[], &search_config);
        assert!(results.is_empty());
    }

    #[test]
    fn test_quiver_单节点图() {
        let config = QuIVerConfig::default();
        let mut quiver = QuIVer::new(4, &config);

        let vectors = vec![1.0f32, 0.0, 0.0, 0.0];
        quiver.batch_build_experimental_v2(&vectors, &[42], &[0]);
        assert_eq!(quiver.total_count(), 1);

        let search_config = QuIVerSearchConfig {
            top_k: 1,
            ef_search: 10,
            rerank_limit: None,
        };
        let results = quiver.search_flat(&[1.0, 0.0, 0.0, 0.0], &vectors, &search_config);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, 42);
    }

    #[test]
    fn test_quiver_soft_delete_不存在的id() {
        let config = QuIVerConfig::default();
        let mut quiver = QuIVer::new(4, &config);
        let vectors = vec![1.0, 0.0, 0.0, 0.0];
        quiver.batch_build_experimental_v2(&vectors, &[1], &[0]);

        // 删除不存在的 ID
        assert!(!quiver.soft_delete(999));
        // 删除存在的 ID
        assert!(quiver.soft_delete(1));
        // 重复删除（已经是 tombstone）
        assert!(quiver.soft_delete(1));
    }

    #[test]
    fn test_quiver_序列化错误路径() {
        // 加载不存在的文件
        let result = QuIVer::load_from_file(std::path::Path::new("nonexistent.quiv"));
        assert!(result.is_err());
    }

    #[test]
    fn sidecar入口节点越界时安全拒绝() {
        let dir = std::env::temp_dir().join("triviumdb_quiver_invalid_entry");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("index.quiver");
        let vectors = make_orthogonal_vectors(4, 4);
        let ids = vec![1, 2, 3, 4];
        let slots = vec![0, 1, 2, 3];
        let mut index = QuIVer::new(4, &QuIVerConfig::default());
        index.batch_build(&vectors, &ids, &slots);
        index.save_to_file(&path).unwrap();
        let mut bytes = std::fs::read(&path).unwrap();
        bytes[32..36].copy_from_slice(&u32::MAX.to_le_bytes());
        let result = std::panic::catch_unwind(|| QuIVer::load_from_bytes(&bytes));
        assert!(result.is_ok());
        assert!(result.unwrap().is_err());
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn sidecar畸形计数不得触发panic或巨量分配() {
        let mut bytes = vec![0u8; 64];
        bytes[0..4].copy_from_slice(QuIVer::QUIVER_MAGIC);
        bytes[4..8].copy_from_slice(&QuIVer::QUIVER_VERSION.to_le_bytes());
        bytes[8..12].copy_from_slice(&4u32.to_le_bytes());
        bytes[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
        bytes[16..20].copy_from_slice(&16u32.to_le_bytes());
        bytes[20..24].copy_from_slice(&32u32.to_le_bytes());
        bytes[24..28].copy_from_slice(&128u32.to_le_bytes());
        bytes[28..32].copy_from_slice(&1.2f32.to_le_bytes());
        bytes[48..52].copy_from_slice(&1u32.to_le_bytes());
        let result = std::panic::catch_unwind(|| QuIVer::load_from_bytes(&bytes));
        assert!(result.is_ok());
        assert!(result.unwrap().is_err());
    }

    #[test]
    fn sidecar固定头部逐字节截断不得触发panic() {
        let mut bytes = [0u8; 52];
        bytes[0..4].copy_from_slice(QuIVer::QUIVER_MAGIC);
        bytes[4..8].copy_from_slice(&QuIVer::QUIVER_VERSION.to_le_bytes());
        bytes[8..12].copy_from_slice(&1u32.to_le_bytes());
        bytes[12..16].copy_from_slice(&1u32.to_le_bytes());
        bytes[16..20].copy_from_slice(&1u32.to_le_bytes());
        bytes[20..24].copy_from_slice(&1u32.to_le_bytes());
        bytes[24..28].copy_from_slice(&1u32.to_le_bytes());
        bytes[28..32].copy_from_slice(&1.0f32.to_le_bytes());
        bytes[48..52].copy_from_slice(&1u32.to_le_bytes());

        for length in 0..52 {
            let result = std::panic::catch_unwind(|| QuIVer::load_from_bytes(&bytes[..length]));
            assert!(result.is_ok(), "固定头部截断至 {length} 字节时发生 panic");
            assert!(result.unwrap().is_err());
        }
    }

    #[test]
    fn fuzz发现的四十八字节样本不得触发panic() {
        let bytes = [
            81, 85, 73, 86, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 130, 130, 130, 130, 130, 130, 81, 85,
            73, 86, 1, 0, 142, 0, 1, 99, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 153,
            93,
        ];
        let result = std::panic::catch_unwind(|| QuIVer::load_from_bytes(&bytes));
        assert!(result.is_ok());
        assert!(result.unwrap().is_err());
    }

    #[test]
    fn test_cosine_sim_函数() {
        let a = [1.0f32, 0.0, 0.0];
        let b = [1.0f32, 0.0, 0.0];
        assert!((cosine_sim(&a, &b) - 1.0).abs() < 1e-5);

        let c = [0.0f32, 1.0, 0.0];
        assert!(cosine_sim(&a, &c).abs() < 1e-5);

        let d = [-1.0f32, 0.0, 0.0];
        assert!((cosine_sim(&a, &d) + 1.0).abs() < 1e-5);
    }

    #[test]
    fn test_quiver_config_default() {
        let config = QuIVerConfig::default();
        assert_eq!(config.m, 16);
        assert_eq!(config.ef_construction, 128);
        assert!((config.alpha - 1.2).abs() < 1e-5);
    }

    #[test]
    fn test_quiver_search_config_rerank_limit() {
        let cfg = QuIVerSearchConfig {
            top_k: 10,
            ef_search: 50,
            rerank_limit: None,
        };
        assert_eq!(cfg.rerank_limit(), 50); // 默认取 ef_search

        let cfg2 = QuIVerSearchConfig {
            top_k: 10,
            ef_search: 50,
            rerank_limit: Some(30),
        };
        assert_eq!(cfg2.rerank_limit(), 30);

        let cfg3 = QuIVerSearchConfig {
            top_k: 100,
            ef_search: 50,
            rerank_limit: Some(30),
        };
        assert_eq!(cfg3.rerank_limit(), 100); // max(rerank_limit, top_k)
    }
}
