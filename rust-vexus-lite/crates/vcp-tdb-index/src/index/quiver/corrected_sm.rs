//! 校正2-bit SM与无训练重建L2平图查询内核。
//!
//! 从已验证的FLAGS95研究实现迁移。数据库编码沿用BQ的f32阈值及严格比较，
//! 查询编码沿用研究实现的f64阈值及非严格比较，两者不能混用。
//! 默认无训练重建L2模式仅在末尾精排读取FP32；显式校正模式额外读取固定锚点。
//! 调用方提供按内部节点顺序排列的同一向量库。

use super::{Bitset, FlatAdj, NonNanF32, QuIVer, QuIVerSearchConfig};
use crate::index::bq::Bq2Signature;
use std::cell::RefCell;
use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::io::{self, Read, Write};
use std::path::Path;

const DIM: usize = 768;
const MAX_DEGREE: usize = 64;
const MAGIC: &[u8; 8] = b"QSM76801";

#[path = "corrected_sm/build.rs"]
mod build;

#[path = "corrected_sm/dynamic.rs"]
mod dynamic;
use dynamic::DynamicSm;

#[path = "corrected_sm/production.rs"]
mod production;

// VCP-PATCH: persist default routing without touching cold FP32 vectors.
#[path = "corrected_sm/routing_snapshot.rs"]
mod routing_snapshot;

#[cfg(test)]
#[path = "corrected_sm/production_tests.rs"]
mod production_tests;

pub use build::SmBuildConfig;

#[cfg(test)]
#[path = "corrected_sm/l2_tests.rs"]
mod l2_tests;

#[cfg(test)]
#[path = "corrected_sm/native_l2_tests.rs"]
mod native_l2_tests;

#[derive(Clone)]
#[repr(C, align(64))]
struct SmRow {
    pos: [u64; 12],
    strong: [u64; 12],
    weak: f32,
    delta: f32,
    coefficient: f32,
    // 复用第四个浮点槽存重建范数；校正模式为零，避免宽载入碰到整数计数。
    reconstructed_norm: f32,
    strong_count: u16,
}

struct SmQuery {
    pos: [u64; 16],
    strong: [u64; 16],
    weak: f32,
    delta: f32,
    count: f32,
}

/// 参考模式独立逐字段计数；组合模式启用已验证的FLAGS95构件。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SmSearchMode {
    Reference,
    Combined,
}

/// 查询评分属于运行期状态，旧持久化格式不自动恢复该选择。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SmScoring {
    CorrectedInnerProduct,
    ReconstructedL2,
    /// 保留原始幅值及零向量；最终分数为负平方欧氏距离，越大越近。
    NativeL2,
}

/// 调试轨迹不在普通查询路径分配。
#[derive(Default, Debug, PartialEq, Eq)]
pub struct SmTrace {
    pub expanded: Vec<u32>,
    pub scored: Vec<u32>,
    pub candidates: Vec<u32>,
    pub exact: Vec<u32>,
}

#[derive(Debug)]
pub struct SmSearchOutput {
    /// 返回实际外部节点ID及FP32分数；原生欧氏模式返回负平方距离。
    pub neighbors: Vec<(u64, f32)>,
    /// 展开数、SM评分数、保留字段、访问边数、唯一FP32精算数。
    pub counts: [usize; 5],
    pub trace: SmTrace,
}

struct Storage {
    queue: BinaryHeap<Reverse<(NonNanF32, u32)>>,
    results: BinaryHeap<(NonNanF32, u32)>,
    candidates: Vec<(NonNanF32, u32)>,
    exact: Vec<(u32, f32)>,
    exact_ids: Vec<u32>,
}

impl Storage {
    fn new(ef: usize) -> Self {
        Self {
            queue: BinaryHeap::with_capacity(ef.saturating_mul(2)),
            results: BinaryHeap::with_capacity(ef + 1),
            candidates: Vec::with_capacity(ef),
            exact: Vec::with_capacity(64),
            exact_ids: Vec::with_capacity(64),
        }
    }

    fn reset(&mut self, ef: usize) {
        self.queue.clear();
        self.results.clear();
        self.candidates.clear();
        self.exact.clear();
        self.exact_ids.clear();
        self.queue.reserve(ef.saturating_mul(2));
        self.results.reserve(ef + 1);
        self.candidates.reserve(ef);
    }
}

struct Scratch {
    visited: Bitset,
    storage: Storage,
}

thread_local! {
    static SCRATCH: RefCell<Scratch> = RefCell::new(Scratch {
        visited: Bitset::new(0), storage: Storage::new(0),
    });
    // 与搜索工作区分开借用，复用四个冷向量缓冲，不物化整库FP32。
    static EXACT_BUFFERS: RefCell<[Vec<f32>; 4]> = RefCell::new(
        std::array::from_fn(|_| Vec::with_capacity(DIM))
    );
}

trait ExactSource {
    fn one(&mut self, q: &[f32], id: usize) -> io::Result<Option<f32>>;
    fn four(&mut self, q: &[f32], ids: [usize; 4]) -> io::Result<[Option<f32>; 4]>;
}

struct SliceSource<'a>(&'a [f32]);
impl ExactSource for SliceSource<'_> {
    fn one(&mut self, q: &[f32], id: usize) -> io::Result<Option<f32>> {
        Ok(Some(dot(q, &self.0[id * DIM..(id + 1) * DIM])))
    }
    fn four(&mut self, q: &[f32], ids: [usize; 4]) -> io::Result<[Option<f32>; 4]> {
        Ok(dot4(q, ids.map(|id| &self.0[id * DIM..(id + 1) * DIM])).map(Some))
    }
}

struct CallbackSource<'a, F> {
    fill: F,
    buffers: &'a mut [Vec<f32>; 4],
    scales: &'a [f32],
}
impl<F: FnMut(usize, &mut Vec<f32>) -> bool> CallbackSource<'_, F> {
    fn fill(&mut self, id: usize, slot: usize) -> io::Result<bool> {
        self.buffers[slot].clear();
        if !(self.fill)(id, &mut self.buffers[slot]) {
            return Ok(false);
        }
        if self.buffers[slot].len() != DIM {
            return Err(corrupt("冷向量维度不匹配"));
        }
        production::prepare_exact_buffer(
            &mut self.buffers[slot],
            self.scales.get(id).copied().unwrap_or(1.),
        );
        Ok(true)
    }
}
impl<F: FnMut(usize, &mut Vec<f32>) -> bool> ExactSource for CallbackSource<'_, F> {
    fn one(&mut self, q: &[f32], id: usize) -> io::Result<Option<f32>> {
        Ok(if self.fill(id, 0)? {
            Some(
                dot(q, &self.buffers[0])
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
        if present.iter().all(|&v| v) {
            let values = dot4(q, std::array::from_fn(|k| self.buffers[k].as_slice()));
            return Ok(std::array::from_fn(|k| {
                Some(
                    values[k]
                        * production::exact_scale(self.scales.get(ids[k]).copied().unwrap_or(1.)),
                )
            }));
        }
        Ok(std::array::from_fn(|k| {
            present[k].then(|| {
                dot(q, &self.buffers[k])
                    * production::exact_scale(self.scales.get(ids[k]).copied().unwrap_or(1.))
            })
        }))
    }
}

/// 不可变的SM模型与平图快照，可在线程间共享；搜索工作区为线程局部。
/// 支持TDB的全部合法BQ维度；768维保留专用内核，导航按至多64条边分批评分。
pub struct CorrectedSmIndex {
    rows: Vec<SmRow>,
    graph: FlatAdj,
    ids: Vec<u64>,
    entry: u32,
    anchor: u32,
    base_crc: u32,
    // 仅运行期TDB路由需要：原冷向量非单位长度时的精算归一化，不写静态SM文件。
    exact_scales: Vec<f32>,
    scoring: SmScoring,
    dynamic: Option<DynamicSm>,
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn corrupt(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

impl QuIVer {
    /// 安装SM时新增的保守峰值估计：归一化输入、对齐码行、临时邻接及ID映射。
    pub fn sm_install_peak_extra_bytes(&self) -> usize {
        let row_bytes = (self.dim.div_ceil(64).saturating_mul(2).saturating_add(3))
            .div_ceil(8)
            .saturating_mul(64);
        let per_node = self
            .dim
            .saturating_mul(4)
            .saturating_add(row_bytes)
            .saturating_add(self.layer0.stride.saturating_mul(8))
            .saturating_add(128);
        self.n.saturating_mul(per_node)
    }

    /// 在已有快速图上安装查询校正；vectors采用内部节点顺序，校正不重新选边。
    /// 安装后search使用按slot取回冷向量的组合路径；增删或重建使校正失效。
    /// 此查询派生状态不写入旧BQ持久化格式，重载后需要显式重新安装。
    pub fn enable_corrected_sm(&mut self, vectors: &[f32], coefficients: &[f32]) -> io::Result<()> {
        dynamic::check_dimension(self.dim)?;
        if vectors.chunks(self.dim).any(|row| {
            let norm = row.iter().map(|&x| (x as f64).powi(2)).sum::<f64>();
            !norm.is_finite() || (norm - 1.).abs() > 1e-5
        }) {
            return Err(invalid(
                "校正SM直接安装要求单位向量；按slot安装入口会显式归一化",
            ));
        }
        let mut model = self.corrected_sm_snapshot(vectors, coefficients)?;
        // 丢弃快照的临时图副本，查询直接借用原图；保留原stride以支持后续增量更新。
        model.graph = FlatAdj::new(1);
        self.corrected_sm = Some(model);
        Ok(())
    }

    /// 按稳定外部节点ID绑定系数，并从实际slot回调一次性读取安装所需向量。
    /// coefficients为空表示关闭校正项；非空时必须覆盖全部当前活跃节点。
    pub fn enable_corrected_sm_with_vectors<F>(
        &mut self,
        coefficients: &[(u64, f32)],
        mut fill: F,
    ) -> io::Result<()>
    where
        F: FnMut(usize, &mut Vec<f32>) -> bool,
    {
        dynamic::check_dimension(self.dim)?;
        if self.n == 0 || self.tombstones.iter().any(|&x| x) {
            return Err(invalid("SM安装要求合法维度、非空且没有墓碑的快速图"));
        }
        let mut by_id = std::collections::HashMap::with_capacity(coefficients.len());
        for &(id, value) in coefficients {
            if !value.is_finite() || by_id.insert(id, value).is_some() {
                return Err(invalid("校正系数包含重复节点或非有限数值"));
            }
        }
        let values = if coefficients.is_empty() {
            Vec::new()
        } else {
            if by_id.len() != self.n {
                return Err(invalid("校正系数没有覆盖当前图节点"));
            }
            self.ids
                .iter()
                .map(|id| {
                    by_id
                        .get(id)
                        .copied()
                        .ok_or_else(|| invalid("校正系数节点身份不符"))
                })
                .collect::<io::Result<Vec<_>>>()?
        };
        let mut base = Vec::with_capacity(
            self.n
                .checked_mul(self.dim)
                .ok_or_else(|| invalid("向量容量溢出"))?,
        );
        let mut buffer = Vec::with_capacity(self.dim);
        let mut scales = Vec::with_capacity(self.n);
        for &slot in &self.slot_indices {
            buffer.clear();
            if !fill(slot, &mut buffer) || buffer.len() != self.dim {
                return Err(invalid("安装校正时无法读取当前节点向量"));
            }
            let norm = buffer.iter().map(|&x| (x as f64).powi(2)).sum::<f64>();
            if !norm.is_finite() || norm <= 0. {
                return Err(invalid("校正SM安装拒绝非有限或零向量"));
            }
            let scale = if (norm - 1.).abs() <= 1e-5 {
                1.
            } else {
                (1. / norm.sqrt()) as f32
            };
            scales.push(scale);
            base.extend(buffer.iter().map(|&x| x * scale));
        }
        self.enable_corrected_sm(&base, &values)?;
        if scales.iter().any(|&s| s != 1.) {
            self.corrected_sm.as_mut().unwrap().exact_scales = scales;
        }
        Ok(())
    }

    /// 查询当前对象是否已启用校正SM；修改图或向量后会自动变为false。
    pub fn corrected_sm_enabled(&self) -> bool {
        self.corrected_sm
            .as_ref()
            .is_some_and(|m| m.scoring == SmScoring::CorrectedInnerProduct)
    }

    /// 安装不需要查询训练、系数或锚点精算的重建L2评分；不改变原图。
    pub fn enable_sm_l2(&mut self, vectors: &[f32]) -> io::Result<()> {
        self.enable_corrected_sm(vectors, &[])?;
        self.corrected_sm.as_mut().unwrap().use_reconstructed_l2();
        Ok(())
    }

    /// 默认状态已就绪时取消显式覆盖；否则按slot安装，不保留完整FP32副本。
    pub fn enable_sm_l2_with_vectors<F>(&mut self, fill: F) -> io::Result<()>
    where
        F: FnMut(usize, &mut Vec<f32>) -> bool,
    {
        if self.default_sm.as_ref().is_some_and(|m| m.len() == self.n) {
            self.corrected_sm = None;
            return Ok(());
        }
        self.enable_corrected_sm_with_vectors(&[], fill)?;
        self.corrected_sm.as_mut().unwrap().use_reconstructed_l2();
        Ok(())
    }

    pub fn sm_l2_enabled(&self) -> bool {
        self.corrected_sm
            .as_ref()
            .or(self.default_sm.as_ref())
            .is_some_and(|m| matches!(m.scoring, SmScoring::ReconstructedL2 | SmScoring::NativeL2))
    }

    /// 显式安装原生欧氏路由，不归一化、不排除零向量；旧图格式不保存该运行期选择。
    pub fn enable_sm_native_l2(&mut self, vectors: &[f32]) -> io::Result<()> {
        dynamic::check_dimension(self.dim)?;
        if self.n == 0
            || self.tombstones.iter().any(|&x| x)
            || self.n.checked_mul(self.dim) != Some(vectors.len())
        {
            return Err(invalid("原生欧氏SM要求完整、非空且无墓碑的当前图和向量"));
        }
        let rows = (0..self.n)
            .map(|u| self.layer0.neighbors(u as u32).to_vec())
            .collect();
        let mut model = CorrectedSmIndex::from_native_l2_vectors_and_graph(
            self.dim,
            vectors,
            rows,
            self.ids.clone(),
            self.entry_point,
        )?;
        model.graph = FlatAdj::new(1);
        self.corrected_sm = Some(model);
        Ok(())
    }

    /// 按实际slot读取原始幅值，安装完成后不保留完整FP32副本。
    pub fn enable_sm_native_l2_with_vectors<F>(&mut self, mut fill: F) -> io::Result<()>
    where
        F: FnMut(usize, &mut Vec<f32>) -> bool,
    {
        dynamic::check_dimension(self.dim)?;
        let mut base = Vec::with_capacity(
            self.n
                .checked_mul(self.dim)
                .ok_or_else(|| invalid("向量容量溢出"))?,
        );
        let mut buffer = Vec::with_capacity(self.dim);
        for &slot in &self.slot_indices {
            buffer.clear();
            if !fill(slot, &mut buffer) || buffer.len() != self.dim {
                return Err(invalid("安装原生欧氏SM时无法读取当前节点向量"));
            }
            base.extend_from_slice(&buffer);
        }
        self.enable_sm_native_l2(&base)
    }

    pub fn sm_native_l2_enabled(&self) -> bool {
        self.corrected_sm
            .as_ref()
            .is_some_and(|m| m.scoring == SmScoring::NativeL2)
    }

    /// 关闭显式覆盖，恢复默认无训练SM-L2；图的边及入口不变。
    pub fn disable_corrected_sm(&mut self) {
        self.corrected_sm = None;
    }

    /// 校正路由的拥有数组与共享图分项，原BQ签名仍保留以支持回退和后续更新。
    pub fn corrected_sm_memory_components(&self) -> Option<serde_json::Value> {
        self.corrected_sm.as_ref().or(self.default_sm.as_ref()).map(|model| {
            serde_json::json!({
                "sm_owned_bytes": self.corrected_sm.as_ref().map_or(0, |m| m.routing_owned_bytes()) + self.default_sm.as_ref().map_or(0, |m| m.routing_owned_bytes()),
                "default_sm_owned_bytes": self.default_sm.as_ref().map_or(0, |m| m.routing_owned_bytes()),
                "explicit_sm_owned_bytes": self.corrected_sm.as_ref().map_or(0, |m| m.routing_owned_bytes()),
                "shared_graph_bytes": self.layer0.data.capacity() * 4,
                "raw_bq_signature_bytes": self.bq_store.hot_bytes(),
                "external_ids_bytes": self.ids.capacity() * 8,
                "slot_mapping_bytes": self.slot_indices.capacity() * std::mem::size_of::<usize>(),
                "exact_norm_scales_bytes": model.exact_scales.capacity() * 4,
                "reconstructed_norms_bytes": 0,
                "inline_reconstructed_norms_bytes": model.inline_reconstructed_norms_bytes(),
                "inline_reconstructed_norms_included_in_sm_rows": true,
                "scoring": format!("{:?}", model.scoring),
                "native_squared_l2": model.scoring == SmScoring::NativeL2,
                "logical_rerank_fp32_bytes": self.n * self.dim * 4,
                "dimension": self.dim,
                "visited_bytes_per_thread": self.n.div_ceil(64) * 8,
                "runtime_note": "不包含动态线程堆、分配器和原QuIVer其他管理结构；共享图仅计一次"
            })
        })
    }

    /// 将当前零层图转换为校正SM快照；vectors必须采用内部节点顺序。
    /// 转换不改动原索引，也不自动继承高层贪心导航。
    pub fn corrected_sm_snapshot(
        &self,
        vectors: &[f32],
        coefficients: &[f32],
    ) -> io::Result<CorrectedSmIndex> {
        dynamic::check_dimension(self.dim)?;
        if self.tombstones.iter().any(|&x| x) {
            return Err(invalid("SM快照仅接受合法维度且没有墓碑的索引"));
        }
        let rows = (0..self.n)
            .map(|u| self.layer0.neighbors(u as u32).to_vec())
            .collect();
        CorrectedSmIndex::from_parts_with_dimension(
            self.dim,
            vectors,
            coefficients,
            rows,
            self.ids.clone(),
            self.entry_point,
            0,
        )
    }
}

impl CorrectedSmIndex {
    pub(super) fn routing_owned_bytes(&self) -> usize {
        self.rows.capacity() * std::mem::size_of::<SmRow>()
            + self.dynamic.as_ref().map_or(0, DynamicSm::owned_bytes)
            + self.ids.capacity() * 8
            + self.graph.data.capacity() * 4
            + self.exact_scales.capacity() * 4
    }

    fn inline_reconstructed_norms_bytes(&self) -> usize {
        if matches!(
            self.scoring,
            SmScoring::ReconstructedL2 | SmScoring::NativeL2
        ) {
            self.len() * std::mem::size_of::<f32>()
        } else {
            0
        }
    }

    /// 切换至无训练重建L2；范数只依赖现有两位码及每向量幅值。
    pub fn use_reconstructed_l2(&mut self) {
        if let Some(model) = &mut self.dynamic {
            model.install_norms();
        }
        for row in &mut self.rows {
            let high = row.weak + row.delta;
            row.reconstructed_norm = (DIM - row.strong_count as usize) as f32 * row.weak * row.weak
                + row.strong_count as f32 * high * high;
        }
        self.scoring = SmScoring::ReconstructedL2;
    }
    fn from_parts(
        base: &[f32],
        coefficients: &[f32],
        graph_rows: Vec<Vec<u32>>,
        ids: Vec<u64>,
        entry: u32,
        anchor: u32,
    ) -> io::Result<Self> {
        let n = base.len() / DIM;
        if n == 0
            || !base.len().is_multiple_of(DIM)
            || n > u32::MAX as usize
            || ids.len() != n
            || graph_rows.len() != n
            || (!coefficients.is_empty() && coefficients.len() != n)
            || entry as usize >= n
            || anchor as usize >= n
            || !base.iter().all(|x| x.is_finite())
            || !coefficients.iter().all(|x| x.is_finite())
        {
            return Err(invalid("SM向量、系数或图形状无效"));
        }
        let degree = graph_rows.iter().map(Vec::len).max().unwrap_or(0);
        if degree > MAX_DEGREE || graph_rows.iter().flatten().any(|&v| v as usize >= n) {
            return Err(invalid("SM图出度超过64或邻居编号越界"));
        }
        let rows = base
            .as_chunks::<DIM>()
            .0
            .iter()
            .enumerate()
            .map(|(id, x)| {
                let sig = Bq2Signature::from_vector(x);
                let mut sums = [0f64; 2];
                let mut counts = [0usize; 2];
                for (j, &v) in x.iter().enumerate() {
                    let group = ((sig.strong[j / 64] >> (j % 64)) & 1) as usize;
                    sums[group] += v.abs() as f64;
                    counts[group] += 1;
                }
                let weak = if counts[0] > 0 {
                    (sums[0] / counts[0] as f64) as f32
                } else {
                    0.
                };
                let high = if counts[1] > 0 {
                    (sums[1] / counts[1] as f64) as f32
                } else {
                    0.
                };
                SmRow {
                    pos: sig.pos[..12].try_into().unwrap(),
                    strong: sig.strong[..12].try_into().unwrap(),
                    weak,
                    delta: high - weak,
                    coefficient: coefficients.get(id).copied().unwrap_or(0.),
                    reconstructed_norm: 0.,
                    strong_count: counts[1] as u16,
                }
            })
            .collect::<Vec<_>>();
        if rows
            .iter()
            .any(|r| !r.weak.is_finite() || !r.delta.is_finite())
        {
            return Err(invalid("SM幅值溢出"));
        }
        let mut graph = FlatAdj::new(degree + 1);
        graph.reset_full(n);
        for (u, row) in graph_rows.iter().enumerate() {
            graph.set_neighbors(u as u32, row);
        }
        Ok(Self {
            rows,
            graph,
            ids,
            entry,
            anchor,
            base_crc: crc32fast::hash(bytemuck::cast_slice(base)),
            exact_scales: Vec::new(),
            scoring: SmScoring::CorrectedInnerProduct,
            dynamic: None,
        })
    }

    /// 导入冻结研究图格式，仅复用图，不触发建图或拟合；默认外部ID为零起始行号。
    pub fn from_research_graph(
        path: &Path,
        base: &[f32],
        coefficients: &[f32],
    ) -> io::Result<Self> {
        let bytes = std::fs::read(path)?;
        let mut input = bytes.as_slice();
        let n = read_u32(&mut input)? as usize;
        if n == 0 || !base.len().is_multiple_of(n) || bytes.len() < 4 + n * 4 {
            return Err(corrupt("研究图与向量库形状不符"));
        }
        let mut rows = Vec::with_capacity(n);
        for _ in 0..n {
            let degree = read_u32(&mut input)? as usize;
            if degree > MAX_DEGREE || input.len() < degree * 4 {
                return Err(corrupt("研究图行度数或长度无效"));
            }
            let mut row = Vec::with_capacity(degree);
            for _ in 0..degree {
                row.push(read_u32(&mut input)?);
            }
            rows.push(row);
        }
        if !input.is_empty() {
            return Err(corrupt("研究图存在多余尾部"));
        }
        Self::from_parts_with_dimension(
            base.len() / n,
            base,
            coefficients,
            rows,
            (0..n as u64).collect(),
            0,
            0,
        )
    }

    pub fn len(&self) -> usize {
        self.dynamic
            .as_ref()
            .map_or(self.rows.len(), DynamicSm::len)
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// 实际向量维度；超出TDB安全上限的输入在构建或安装时明确拒绝。
    pub fn dimension(&self) -> usize {
        self.dynamic.as_ref().map_or(DIM, DynamicSm::dimension)
    }

    /// 实际拥有数组的容量小计，搜索工作区与外部精排向量分别报告。
    pub fn memory_components(&self) -> serde_json::Value {
        serde_json::json!({
            "sm_rows_bytes": self.rows.capacity() * std::mem::size_of::<SmRow>() + self.dynamic.as_ref().map_or(0, DynamicSm::owned_bytes),
            "graph_bytes": self.graph.data.capacity() * 4,
            "ids_bytes": self.ids.capacity() * 8,
            "reconstructed_norms_bytes": 0,
            "inline_reconstructed_norms_bytes": self.inline_reconstructed_norms_bytes(),
            "inline_reconstructed_norms_included_in_sm_rows": true,
            "scoring": format!("{:?}", self.scoring),
            "logical_rerank_fp32_bytes": self.len() * self.dimension() * 4,
            "visited_bytes_per_thread": self.len().div_ceil(64) * 8,
            "row_stride_bytes": self.dynamic.as_ref().map_or(std::mem::size_of::<SmRow>(), DynamicSm::row_bytes),
            "runtime_note": "线程堆和候选容量、分配器及外部向量驻留另计",
            "dimension": self.dimension(), "nodes": self.len(), "entry": self.entry, "anchor": self.anchor,
            "simd_available": simd_available(),
        })
    }

    /// 校正SM查询；base必须与构造或载入模型时绑定的向量库及内部顺序一致。
    pub fn search(
        &self,
        query: &[f32],
        base: &[f32],
        config: &QuIVerSearchConfig,
        mode: SmSearchMode,
    ) -> io::Result<SmSearchOutput> {
        if self.dynamic.is_some() {
            return self.dynamic_slice_search(query, base, config, mode, false);
        }
        if base.len() != self.len() * DIM {
            return Err(invalid("SM外部向量库形状不符"));
        }
        let mut source = SliceSource(base);
        match mode {
            SmSearchMode::Reference => {
                self.search_impl::<false, false, _>(query, &self.graph, &mut source, config)
            }
            SmSearchMode::Combined => {
                self.search_impl::<false, true, _>(query, &self.graph, &mut source, config)
            }
        }
    }

    /// 仅诊断使用，额外保存完整展开、评分、候选及精排顺序。
    pub fn search_traced(
        &self,
        query: &[f32],
        base: &[f32],
        config: &QuIVerSearchConfig,
        mode: SmSearchMode,
    ) -> io::Result<SmSearchOutput> {
        if self.dynamic.is_some() {
            return self.dynamic_slice_search(query, base, config, mode, true);
        }
        if base.len() != self.len() * DIM {
            return Err(invalid("SM外部向量库形状不符"));
        }
        let mut source = SliceSource(base);
        match mode {
            SmSearchMode::Reference => {
                self.search_impl::<true, false, _>(query, &self.graph, &mut source, config)
            }
            SmSearchMode::Combined => {
                self.search_impl::<true, true, _>(query, &self.graph, &mut source, config)
            }
        }
    }

    /// 静态快照的冷热分离入口；回调参数为内部行号，不是外部节点ID。
    pub fn search_with_vectors<F>(
        &self,
        query: &[f32],
        config: &QuIVerSearchConfig,
        mode: SmSearchMode,
        fill: F,
    ) -> io::Result<SmSearchOutput>
    where
        F: FnMut(usize, &mut Vec<f32>) -> bool,
    {
        self.search_callback(query, &self.graph, config, mode, fill)
    }

    pub(super) fn search_routed<F>(
        &self,
        query: &[f32],
        graph: &FlatAdj,
        config: &QuIVerSearchConfig,
        fill: F,
    ) -> io::Result<SmSearchOutput>
    where
        F: FnMut(usize, &mut Vec<f32>) -> bool,
    {
        self.search_callback(query, graph, config, SmSearchMode::Combined, fill)
    }

    fn search_callback<F>(
        &self,
        query: &[f32],
        graph: &FlatAdj,
        config: &QuIVerSearchConfig,
        mode: SmSearchMode,
        fill: F,
    ) -> io::Result<SmSearchOutput>
    where
        F: FnMut(usize, &mut Vec<f32>) -> bool,
    {
        if self.dynamic.is_some() {
            return self.dynamic_callback_search(query, graph, config, mode, fill);
        }
        EXACT_BUFFERS.with(|cell| {
            let mut buffers = cell.borrow_mut();
            let mut source = CallbackSource {
                fill,
                buffers: &mut buffers,
                scales: &self.exact_scales,
            };
            match mode {
                SmSearchMode::Reference => {
                    self.search_impl::<false, false, _>(query, graph, &mut source, config)
                }
                SmSearchMode::Combined => {
                    self.search_impl::<false, true, _>(query, graph, &mut source, config)
                }
            }
        })
    }

    fn search_impl<const TRACE: bool, const OPTIMIZED: bool, S: ExactSource>(
        &self,
        q: &[f32],
        graph: &FlatAdj,
        source: &mut S,
        cfg: &QuIVerSearchConfig,
    ) -> io::Result<SmSearchOutput> {
        let budget = cfg.rerank_limit.unwrap_or(64);
        let ef = cfg.ef_search.min(self.len());
        if q.len() != DIM
            || !q.iter().all(|x| x.is_finite())
            || cfg.top_k == 0
            || cfg.top_k > budget
            || budget > ef
        {
            return Err(invalid("SM查询维度、候选或精排预算无效"));
        }
        let optimized = OPTIMIZED;
        let sq = if optimized && simd_available() {
            query_simd(q)
        } else {
            query_scalar(q)
        };
        let uses_anchor = self.scoring == SmScoring::CorrectedInnerProduct;
        let anchor = if uses_anchor {
            source
                .one(q, self.anchor as usize)?
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "搜索锚点冷向量不可读取"))?
        } else {
            0.
        };
        let error = if uses_anchor {
            anchor - self.score(&sq, self.anchor as usize, optimized)
        } else {
            0.
        };
        let high = sq.weak + sq.delta;
        let query_norm = (DIM as f32 - sq.count) * sq.weak * sq.weak + sq.count * high * high;
        let first =
            1. - self.navigation_score(&sq, self.entry as usize, error, query_norm, optimized);
        if !first.is_finite() || !anchor.is_finite() {
            return Err(invalid("SM查询分数溢出"));
        }
        SCRATCH.with(|cell| {
            let mut scratch = cell.borrow_mut();
            let Scratch { visited, storage } = &mut *scratch;
            if visited.len < self.len() {
                visited.grow(self.len());
            }
            visited.clear();
            let mut fresh;
            let st = if optimized {
                storage.reset(ef);
                storage
            } else {
                fresh = Storage::new(ef);
                &mut fresh
            };
            let mut trace = SmTrace::default();
            let mut counts = [0usize, 1 + usize::from(uses_anchor), 0, 0, 0];
            visited.set(self.entry as usize);
            st.queue.push(Reverse((NonNanF32(first), self.entry)));
            st.results.push((NonNanF32(first), self.entry));
            while let Some(&Reverse((distance, u))) = st.queue.peek() {
                if st.results.len() >= ef && distance > st.results.peek().unwrap().0 {
                    break;
                }
                st.queue.pop();
                counts[0] += 1;
                if TRACE {
                    trace.expanded.push(u);
                }
                let neighbors = graph.neighbors(u);
                counts[3] += neighbors.len();
                for neighbors in neighbors.chunks(MAX_DEGREE) {
                    let mut ids = [0u32; MAX_DEGREE];
                    let mut values = [0f32; MAX_DEGREE];
                    let mut len = 0;
                    if optimized {
                        for &v in neighbors {
                            if visited.test(v as usize) {
                                continue;
                            }
                            visited.set(v as usize);
                            ids[len] = v;
                            len += 1;
                            self.prefetch(v as usize);
                            if TRACE {
                                trace.scored.push(v);
                            }
                        }
                        // 保留已验证组合的四候选评分顺序，整批预取后再访问模型。
                        let mut j = 0;
                        while j + 4 <= len {
                            values[j] = self.navigation_score(
                                &sq,
                                ids[j] as usize,
                                error,
                                query_norm,
                                true,
                            );
                            values[j + 1] = self.navigation_score(
                                &sq,
                                ids[j + 1] as usize,
                                error,
                                query_norm,
                                true,
                            );
                            values[j + 2] = self.navigation_score(
                                &sq,
                                ids[j + 2] as usize,
                                error,
                                query_norm,
                                true,
                            );
                            values[j + 3] = self.navigation_score(
                                &sq,
                                ids[j + 3] as usize,
                                error,
                                query_norm,
                                true,
                            );
                            j += 4;
                        }
                        while j < len {
                            values[j] = self.navigation_score(
                                &sq,
                                ids[j] as usize,
                                error,
                                query_norm,
                                true,
                            );
                            j += 1;
                        }
                        counts[1] += len;
                        // 检查整批分数，所有候选仍执行有限值校验。
                        let invalid_score = values[..len]
                            .iter()
                            .fold(false, |invalid, value| invalid | !value.is_finite());
                        if invalid_score {
                            return Err(invalid("SM候选分数溢出"));
                        }
                    } else {
                        for &v in neighbors {
                            if !visited.test(v as usize) {
                                self.prefetch(v as usize);
                            }
                        }
                    }
                    let iteration = if optimized { &ids[..len] } else { neighbors };
                    for (j, &v) in iteration.iter().enumerate() {
                        let value = if optimized {
                            values[j]
                        } else {
                            if visited.test(v as usize) {
                                continue;
                            }
                            visited.set(v as usize);
                            counts[1] += 1;
                            if TRACE {
                                trace.scored.push(v);
                            }
                            self.navigation_score(&sq, v as usize, error, query_norm, false)
                        };
                        if !optimized && !value.is_finite() {
                            return Err(invalid("SM候选分数溢出"));
                        }
                        let next = NonNanF32(1. - value);
                        if st.results.len() < ef || next < st.results.peek().unwrap().0 {
                            st.queue.push(Reverse((next, v)));
                            if optimized && st.results.len() == ef {
                                *st.results.peek_mut().unwrap() = (next, v);
                            } else {
                                st.results.push((next, v));
                                if st.results.len() > ef {
                                    st.results.pop();
                                }
                            }
                        }
                    }
                }
            }
            st.candidates.extend(st.results.drain());
            st.candidates.sort_unstable();
            #[cfg(feature = "test-hooks")]
            crate::test_hooks::hit(crate::test_hooks::ConcurrencyPoint::QuiverCandidateProduced);
            if TRACE {
                trace.candidates.extend(st.candidates.iter().map(|x| x.1));
            }
            if uses_anchor {
                st.exact.push((self.anchor, anchor));
            }
            for &(_, v) in &st.candidates {
                if !uses_anchor || v != self.anchor {
                    st.exact_ids.push(v);
                }
            }
            #[cfg(feature = "test-hooks")]
            crate::test_hooks::hit(crate::test_hooks::ConcurrencyPoint::BeforeVectorRerank);
            let mut j = 0;
            let count = st.exact_ids.len();
            while j < count && st.exact.len() < budget {
                if optimized
                    && j + 4 <= count
                    && budget - st.exact.len() >= 4
                    && dot_simd_available()
                {
                    let values =
                        source.four(q, std::array::from_fn(|k| st.exact_ids[j + k] as usize))?;
                    for k in 0..4 {
                        if let Some(value) = values[k] {
                            st.exact.push((st.exact_ids[j + k], value));
                        }
                    }
                    j += 4;
                } else {
                    let id = st.exact_ids[j];
                    if let Some(value) = source.one(q, id as usize)? {
                        st.exact.push((id, value));
                    }
                    j += 1;
                }
            }
            if st.exact.iter().any(|x| !x.1.is_finite()) {
                return Err(invalid("SM精排分数溢出"));
            }
            counts[4] = st.exact.len();
            if TRACE {
                trace.exact.extend(st.exact.iter().map(|x| x.0));
            }
            st.exact
                .sort_unstable_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
            let neighbors = st
                .exact
                .iter()
                .take(cfg.top_k)
                .map(|&(id, score)| (self.ids[id as usize], score))
                .collect();
            Ok(SmSearchOutput {
                neighbors,
                counts,
                trace,
            })
        })
    }

    #[inline]
    fn corrected_score(&self, q: &SmQuery, id: usize, error: f32, optimized: bool) -> f32 {
        self.score(q, id, optimized) + self.rows[id].coefficient * error
    }

    #[inline]
    fn navigation_score(
        &self,
        q: &SmQuery,
        id: usize,
        error: f32,
        query_norm: f32,
        optimized: bool,
    ) -> f32 {
        match self.scoring {
            SmScoring::CorrectedInnerProduct => self.corrected_score(q, id, error, optimized),
            SmScoring::ReconstructedL2 | SmScoring::NativeL2 => {
                1. - (query_norm + self.rows[id].reconstructed_norm
                    - 2. * self.score(q, id, optimized))
            }
        }
    }

    #[inline]
    fn score(&self, q: &SmQuery, id: usize, optimized: bool) -> f32 {
        if optimized && simd_available() {
            packed_score(&self.rows[id], q)
        } else {
            scalar_score(&self.rows[id], q)
        }
    }

    #[inline]
    fn prefetch(&self, id: usize) {
        #[cfg(target_arch = "x86_64")]
        unsafe {
            use std::arch::x86_64::{_MM_HINT_T0, _MM_HINT_T1, _mm_prefetch};
            let p = &self.rows[id] as *const SmRow as *const i8;
            if self.scoring == SmScoring::ReconstructedL2 {
                for offset in [0, 64, 128, 192] {
                    _mm_prefetch(p.add(offset), _MM_HINT_T1);
                }
            } else {
                for offset in [0, 64, 128, 192] {
                    _mm_prefetch(p.add(offset), _MM_HINT_T0);
                }
            }
        }
        #[cfg(not(target_arch = "x86_64"))]
        let _ = id;
    }

    /// 保存SM模型、校正系数、ID及图，不嵌入FP32精排库；文件尾CRC覆盖全部内容。
    /// 768维保留旧格式及显式恢复评分模式的契约；跨维度且保留模式请用save_portable。
    pub fn save(&self, path: &Path) -> io::Result<()> {
        if self.dynamic.is_some() {
            return self.save_portable(path);
        }
        let mut payload = Vec::with_capacity(32 + self.len() * 220 + self.graph.data.len() * 4);
        payload.extend_from_slice(MAGIC);
        payload.extend_from_slice(&(self.len() as u64).to_le_bytes());
        for v in [
            self.entry,
            self.anchor,
            (self.graph.stride - 1) as u32,
            self.base_crc,
        ] {
            payload.extend_from_slice(&v.to_le_bytes());
        }
        for (u, r) in self.rows.iter().enumerate() {
            payload.extend_from_slice(&self.ids[u].to_le_bytes());
            for v in r.pos.iter().chain(r.strong.iter()) {
                payload.extend_from_slice(&v.to_le_bytes());
            }
            for v in [r.weak, r.delta, r.coefficient] {
                payload.extend_from_slice(&v.to_le_bytes());
            }
            payload.extend_from_slice(&(r.strong_count as u32).to_le_bytes());
            let row = self.graph.neighbors(u as u32);
            payload.extend_from_slice(&(row.len() as u32).to_le_bytes());
            for v in row {
                payload.extend_from_slice(&v.to_le_bytes());
            }
        }
        let checksum = crc32fast::hash(&payload);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        file.write_all(&payload)?;
        file.write_all(&checksum.to_le_bytes())?;
        file.sync_all()
    }

    /// 载入前验证节点数、长度、CRC及外部向量身份，拒绝系数或图混配。
    pub fn load(path: &Path, base: &[f32]) -> io::Result<Self> {
        let mut file = std::fs::File::open(path)?;
        let mut magic = [0u8; 8];
        file.read_exact(&mut magic)?;
        if &magic == dynamic::PORTABLE_MAGIC {
            return Self::load_portable(path, base);
        }
        use std::io::{Seek, SeekFrom};
        file.seek(SeekFrom::Start(0))?;
        let mut header = [0u8; 32];
        file.read_exact(&mut header)?;
        let n = u64::from_le_bytes(header[8..16].try_into().unwrap());
        let degree = u32::from_le_bytes(header[24..28].try_into().unwrap()) as usize;
        if &header[..8] != MAGIC
            || n == 0
            || n != (base.len() / DIM) as u64
            || !base.len().is_multiple_of(DIM)
            || degree > MAX_DEGREE
            || n > u32::MAX as u64
        {
            return Err(corrupt("SM文件头与外部向量库不符"));
        }
        let expected_min = 36 + n * 220;
        let length = file.metadata()?.len();
        if length < expected_min || length > expected_min + n * degree as u64 * 4 {
            return Err(corrupt("SM文件长度超出声明范围"));
        }
        let mut payload = Vec::with_capacity(length as usize);
        payload.extend_from_slice(&header);
        file.read_to_end(&mut payload)?;
        let checksum = u32::from_le_bytes(payload[payload.len() - 4..].try_into().unwrap());
        if crc32fast::hash(&payload[..payload.len() - 4]) != checksum {
            return Err(corrupt("SM文件CRC不符"));
        }
        let base_crc = u32::from_le_bytes(header[28..32].try_into().unwrap());
        if crc32fast::hash(bytemuck::cast_slice(base)) != base_crc {
            return Err(corrupt("SM外部向量库身份不符"));
        }
        let entry = u32::from_le_bytes(header[16..20].try_into().unwrap());
        let anchor = u32::from_le_bytes(header[20..24].try_into().unwrap());
        if entry as u64 >= n || anchor as u64 >= n {
            return Err(corrupt("SM入口或锚点越界"));
        }
        let mut input = &payload[32..payload.len() - 4];
        let mut rows = Vec::with_capacity(n as usize);
        let mut ids = Vec::with_capacity(n as usize);
        let mut graph = FlatAdj::new(degree + 1);
        graph.reset_full(n as usize);
        for u in 0..n as usize {
            ids.push(read_u64(&mut input)?);
            let mut pos = [0u64; 12];
            let mut strong = [0u64; 12];
            for v in pos.iter_mut().chain(strong.iter_mut()) {
                *v = read_u64(&mut input)?;
            }
            let weak = f32::from_bits(read_u32(&mut input)?);
            let delta = f32::from_bits(read_u32(&mut input)?);
            let coefficient = f32::from_bits(read_u32(&mut input)?);
            let strong_count = read_u32(&mut input)?;
            if !weak.is_finite()
                || !delta.is_finite()
                || !coefficient.is_finite()
                || strong_count > DIM as u32
                || strong.iter().map(|x| x.count_ones()).sum::<u32>() != strong_count
            {
                return Err(corrupt("SM幅值、系数或位计数无效"));
            }
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
            graph.set_neighbors(u as u32, &neighbors);
            rows.push(SmRow {
                pos,
                strong,
                weak,
                delta,
                coefficient,
                reconstructed_norm: 0.,
                strong_count: strong_count as u16,
            });
        }
        if !input.is_empty() {
            return Err(corrupt("SM文件存在多余数据"));
        }
        Ok(Self {
            rows,
            graph,
            ids,
            entry,
            anchor,
            base_crc,
            exact_scales: Vec::new(),
            scoring: SmScoring::CorrectedInnerProduct,
            dynamic: None,
        })
    }
}

fn read_u32(input: &mut &[u8]) -> io::Result<u32> {
    let mut b = [0; 4];
    input.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}
fn read_u64(input: &mut &[u8]) -> io::Result<u64> {
    let mut b = [0; 8];
    input.read_exact(&mut b)?;
    Ok(u64::from_le_bytes(b))
}

fn query_scalar(q: &[f32]) -> SmQuery {
    let threshold = q.iter().map(|v| v.abs() as f64).sum::<f64>() / DIM as f64;
    let mut out = SmQuery {
        pos: [0; 16],
        strong: [0; 16],
        weak: 0.,
        delta: 0.,
        count: 0.,
    };
    let mut sums = [0f64; 2];
    let mut counts = [0usize; 2];
    for (j, &v) in q.iter().enumerate() {
        let group = usize::from(v.abs() as f64 >= threshold);
        sums[group] += v.abs() as f64;
        counts[group] += 1;
        if v >= 0. {
            out.pos[j / 64] |= 1u64 << (j % 64);
        }
        if group == 1 {
            out.strong[j / 64] |= 1u64 << (j % 64);
        }
    }
    out.weak = if counts[0] > 0 {
        (sums[0] / counts[0] as f64) as f32
    } else {
        0.
    };
    let high = if counts[1] > 0 {
        (sums[1] / counts[1] as f64) as f32
    } else {
        0.
    };
    out.delta = high - out.weak;
    out.count = counts[1] as f32;
    out
}

fn combine_counts(row: &SmRow, q: &SmQuery, s: [u32; 5]) -> f32 {
    let s = s.map(|v| v as f32);
    let x = DIM as f32 - 2. * s[0];
    let y = row.strong_count as f32 - 2. * s[1];
    let z = q.count - 2. * s[2];
    let w = s[3] - 2. * s[4];
    q.weak * (row.weak * x + row.delta * y) + q.delta * (row.weak * z + row.delta * w)
}

fn scalar_score(row: &SmRow, q: &SmQuery) -> f32 {
    let mut s = [0u32; 5];
    for j in 0..12 {
        let diff = row.pos[j] ^ q.pos[j];
        let both = row.strong[j] & q.strong[j];
        let values = [
            diff,
            diff & row.strong[j],
            diff & q.strong[j],
            both,
            diff & both,
        ];
        for k in 0..5 {
            s[k] += values[k].count_ones();
        }
    }
    combine_counts(row, q, s)
}

fn simd_available() -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        // VCP-PATCH: ablation must also cover SM counting kernels.
        #[cfg(not(coverage))]
        if *crate::index::bq::FORCE_NO_AVX512 {
            return false;
        }
        std::is_x86_feature_detected!("avx512f")
            && std::is_x86_feature_detected!("avx512vpopcntdq")
            && std::is_x86_feature_detected!("avx2")
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        false
    }
}
fn dot_simd_available() -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        // VCP-PATCH: use the same runtime ablation for exact SM dot kernels.
        #[cfg(not(coverage))]
        if *crate::index::bq::FORCE_NO_AVX512 {
            return false;
        }
        std::is_x86_feature_detected!("avx512f") && std::is_x86_feature_detected!("fma")
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        false
    }
}

fn query_simd(q: &[f32]) -> SmQuery {
    #[cfg(target_arch = "x86_64")]
    unsafe {
        query_avx512(q)
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        query_scalar(q)
    }
}
fn packed_score(row: &SmRow, q: &SmQuery) -> f32 {
    #[cfg(target_arch = "x86_64")]
    unsafe {
        packed_avx512(row, q)
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        scalar_score(row, q)
    }
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx512f,avx512vpopcntdq")]
unsafe fn packed_avx512(row: &SmRow, q: &SmQuery) -> f32 {
    use std::arch::x86_64::*;
    unsafe {
        let mut a = [_mm512_setzero_si512(); 5];
        for chunk in 0..2 {
            let mask = if chunk == 0 { 0xff } else { 0x0f };
            let xp = _mm512_maskz_loadu_epi64(mask, row.pos.as_ptr().add(chunk * 8) as *const i64);
            let xs =
                _mm512_maskz_loadu_epi64(mask, row.strong.as_ptr().add(chunk * 8) as *const i64);
            let qp = _mm512_loadu_si512(q.pos.as_ptr().add(chunk * 8) as *const __m512i);
            let qs = _mm512_loadu_si512(q.strong.as_ptr().add(chunk * 8) as *const __m512i);
            let diff = _mm512_xor_si512(xp, qp);
            let both = _mm512_and_si512(xs, qs);
            let v = [
                diff,
                _mm512_and_si512(diff, xs),
                _mm512_and_si512(diff, qs),
                both,
                _mm512_and_si512(diff, both),
            ];
            for j in 0..5 {
                a[j] = _mm512_add_epi64(a[j], _mm512_popcnt_epi64(v[j]));
            }
        }
        // 本版本固定768维，五个10位字段不会发生相邻进位。
        let p0 = _mm512_or_si512(a[0], _mm512_slli_epi64::<10>(a[1]));
        let p1 = _mm512_or_si512(_mm512_slli_epi64::<20>(a[2]), _mm512_slli_epi64::<30>(a[3]));
        let packed = _mm512_or_si512(_mm512_or_si512(p0, p1), _mm512_slli_epi64::<40>(a[4]));
        let sum = _mm512_reduce_add_epi64(packed) as u64;
        combine_counts(
            row,
            q,
            std::array::from_fn(|j| ((sum >> (j * 10)) & 1023) as u32),
        )
    }
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx512f,avx2")]
unsafe fn query_avx512(q: &[f32]) -> SmQuery {
    use std::arch::x86_64::*;
    let threshold = q.iter().map(|v| v.abs() as f64).sum::<f64>() / DIM as f64;
    let mut out = SmQuery {
        pos: [0; 16],
        strong: [0; 16],
        weak: 0.,
        delta: 0.,
        count: 0.,
    };
    let mut sums = [0f64; 2];
    let mut count = 0usize;
    unsafe {
        let limit = _mm512_set1_pd(threshold);
        let zero = _mm256_setzero_ps();
        let abs_mask = _mm256_castsi256_ps(_mm256_set1_epi32(0x7fffffff));
        for i in (0..DIM).step_by(8) {
            let values = _mm256_loadu_ps(q.as_ptr().add(i));
            let abs = _mm256_and_ps(values, abs_mask);
            let signs = _mm256_movemask_ps(_mm256_cmp_ps::<_CMP_GE_OQ>(values, zero)) as u64;
            let groups = _mm512_cmp_pd_mask::<_CMP_GE_OQ>(_mm512_cvtps_pd(abs), limit) as u64;
            out.pos[i / 64] |= signs << (i % 64);
            out.strong[i / 64] |= groups << (i % 64);
            count += groups.count_ones() as usize;
            // 保持参考实现每个幅值组的f64加法顺序。
            for j in 0..8 {
                let v = q[i + j].abs() as f64;
                let g = (groups >> j) & 1;
                sums[0] += if g == 0 { v } else { 0. };
                sums[1] += if g == 1 { v } else { 0. };
            }
        }
    }
    out.weak = if count < DIM {
        (sums[0] / (DIM - count) as f64) as f32
    } else {
        0.
    };
    let high = if count > 0 {
        (sums[1] / count as f64) as f32
    } else {
        0.
    };
    out.delta = high - out.weak;
    out.count = count as f32;
    out
}

fn dot(q: &[f32], x: &[f32]) -> f32 {
    #[cfg(target_arch = "x86_64")]
    if dot_simd_available() {
        return unsafe { dot_avx512(q, x) };
    }
    // 回退路径保留16条FMA累加链，跨ISA只要求数值容差，不宣称位级一致。
    let mut sums = [0f32; 16];
    for i in (0..DIM).step_by(16) {
        for j in 0..16 {
            sums[j] = q[i + j].mul_add(x[i + j], sums[j]);
        }
    }
    for j in 0..8 {
        sums[j] += sums[j + 8];
    }
    for j in 0..4 {
        sums[j] += sums[j + 4];
    }
    (sums[0] + sums[2]) + (sums[1] + sums[3])
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx512f,fma")]
unsafe fn dot_avx512(q: &[f32], x: &[f32]) -> f32 {
    use std::arch::x86_64::*;
    unsafe {
        let mut sum = _mm512_setzero_ps();
        for i in (0..DIM).step_by(16) {
            sum = _mm512_fmadd_ps(
                _mm512_loadu_ps(q.as_ptr().add(i)),
                _mm512_loadu_ps(x.as_ptr().add(i)),
                sum,
            );
        }
        _mm512_reduce_add_ps(sum)
    }
}

fn dot4(q: &[f32], x: [&[f32]; 4]) -> [f32; 4] {
    #[cfg(target_arch = "x86_64")]
    unsafe {
        dot4_avx512(q, x)
    }
    #[cfg(not(target_arch = "x86_64"))]
    x.map(|v| dot(q, v))
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx512f,fma")]
unsafe fn dot4_avx512(q: &[f32], x: [&[f32]; 4]) -> [f32; 4] {
    use std::arch::x86_64::*;
    unsafe {
        let mut sum = [_mm512_setzero_ps(); 4];
        for i in (0..DIM).step_by(16) {
            let query = _mm512_loadu_ps(q.as_ptr().add(i));
            for k in 0..4 {
                sum[k] = _mm512_fmadd_ps(query, _mm512_loadu_ps(x[k].as_ptr().add(i)), sum[k]);
            }
        }
        sum.map(|v| _mm512_reduce_add_ps(v))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(n: usize) -> (Vec<f32>, CorrectedSmIndex) {
        let base = (0..n * DIM)
            .map(|j| ((j.wrapping_mul(7919) % 997) as f32 - 498.) / 16000.)
            .collect::<Vec<_>>();
        let graph = (0..n)
            .map(|u| (1..=8.min(n - 1)).map(|j| ((u + j) % n) as u32).collect())
            .collect();
        let coeff = (0..n).map(|j| (j % 7) as f32 / 10.).collect::<Vec<_>>();
        let index = CorrectedSmIndex::from_parts(
            &base,
            &coeff,
            graph,
            (1000..1000 + n as u64).collect(),
            3,
            0,
        )
        .unwrap();
        (base, index)
    }

    fn same(a: &SmSearchOutput, b: &SmSearchOutput) {
        assert_eq!(a.trace, b.trace, "完整搜索轨迹发生变化");
        assert_eq!(a.counts, b.counts, "工作量发生变化");
        assert_eq!(
            a.neighbors
                .iter()
                .map(|x| (x.0, x.1.to_bits()))
                .collect::<Vec<_>>(),
            b.neighbors
                .iter()
                .map(|x| (x.0, x.1.to_bits()))
                .collect::<Vec<_>>(),
            "标签或分数位发生变化"
        );
    }

    #[test]
    fn reference_combined_and_thread_scratch_agree() {
        let (base, index) = fixture(128);
        let cfg = QuIVerSearchConfig {
            top_k: 10,
            ef_search: 80,
            rerank_limit: Some(64),
        };
        let expected = (0..8)
            .map(|j| {
                index
                    .search_traced(
                        &base[j * DIM..(j + 1) * DIM],
                        &base,
                        &cfg,
                        SmSearchMode::Reference,
                    )
                    .unwrap()
            })
            .collect::<Vec<_>>();
        std::thread::scope(|scope| {
            let handles = (0..8)
                .map(|j| {
                    let index = &index;
                    let base = &base;
                    let cfg = &cfg;
                    scope.spawn(move || {
                        index
                            .search_traced(
                                &base[j * DIM..(j + 1) * DIM],
                                base,
                                cfg,
                                SmSearchMode::Combined,
                            )
                            .unwrap()
                    })
                })
                .collect::<Vec<_>>();
            for (a, h) in expected.iter().zip(handles) {
                same(a, &h.join().unwrap());
            }
        });
        let (_, small) = fixture(16);
        let short = QuIVerSearchConfig {
            top_k: 3,
            ef_search: 8,
            rerank_limit: Some(8),
        };
        let small_base = fixture(16).0;
        small
            .search(
                &small_base[..DIM],
                &small_base,
                &short,
                SmSearchMode::Combined,
            )
            .unwrap();
        same(
            &expected[0],
            &index
                .search_traced(&base[..DIM], &base, &cfg, SmSearchMode::Combined)
                .unwrap(),
        );
        assert!(expected[0].neighbors.iter().all(|x| x.0 >= 1000));
    }

    #[test]
    fn simd_counts_and_query_boundaries_match_reference() {
        let (base, index) = fixture(16);
        assert_eq!(std::mem::size_of::<SmRow>(), 256);
        assert_eq!(std::mem::offset_of!(SmRow, strong_count), 208);
        let cases = [
            vec![0.; DIM],
            vec![-0.; DIM],
            vec![f32::from_bits(1); DIM],
            vec![1.; DIM],
            vec![-1.; DIM],
            (0..DIM)
                .map(|j| if j % 2 == 0 { 1. } else { -1. })
                .collect(),
            base[..DIM].to_vec(),
        ];
        for q in cases {
            let reference = query_scalar(&q);
            if simd_available() {
                let vector = query_simd(&q);
                assert_eq!(reference.pos, vector.pos);
                assert_eq!(reference.strong, vector.strong);
                assert_eq!(
                    [
                        reference.weak.to_bits(),
                        reference.delta.to_bits(),
                        reference.count.to_bits()
                    ],
                    [
                        vector.weak.to_bits(),
                        vector.delta.to_bits(),
                        vector.count.to_bits()
                    ]
                );
                for row in &index.rows {
                    assert_eq!(
                        scalar_score(row, &reference).to_bits(),
                        packed_score(row, &vector).to_bits()
                    );
                }
                // 对全位平面和交错平面检查十位字段的极端计数，不借助实现本身生成期望。
                for pattern in [0, u64::MAX, 0xaaaaaaaaaaaaaaaa, 0x5555555555555555] {
                    let row = SmRow {
                        pos: [pattern; 12],
                        strong: [!pattern; 12],
                        weak: 0.1,
                        delta: 0.2,
                        coefficient: 0.,
                        reconstructed_norm: 0.,
                        strong_count: ((!pattern).count_ones() * 12) as u16,
                    };
                    assert_eq!(
                        scalar_score(&row, &reference).to_bits(),
                        packed_score(&row, &reference).to_bits()
                    );
                }
            }
        }
        if dot_simd_available() {
            for j in 0..12 {
                let vectors = std::array::from_fn(|k| &base[(j + k) * DIM..(j + k + 1) * DIM]);
                let values = dot4(&base[..DIM], vectors);
                for k in 0..4 {
                    assert_eq!(values[k].to_bits(), dot(&base[..DIM], vectors[k]).to_bits());
                }
            }
        }
    }

    #[test]
    fn persistence_rejects_corruption_and_wrong_vectors() {
        let (base, index) = fixture(128);
        let path = std::env::temp_dir().join(format!(
            "trivium-sm-{}-{}.bin",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        index.save(&path).unwrap();
        assert!(index.save(&path).is_err());
        let restored = CorrectedSmIndex::load(&path, &base).unwrap();
        let cfg = QuIVerSearchConfig {
            top_k: 10,
            ef_search: 80,
            rerank_limit: Some(64),
        };
        same(
            &index
                .search_traced(&base[..DIM], &base, &cfg, SmSearchMode::Combined)
                .unwrap(),
            &restored
                .search_traced(&base[..DIM], &base, &cfg, SmSearchMode::Reference)
                .unwrap(),
        );
        let mut wrong = base.clone();
        wrong[0] += 0.001;
        assert!(CorrectedSmIndex::load(&path, &wrong).is_err());
        let mut bytes = std::fs::read(&path).unwrap();
        bytes[64] ^= 1;
        std::fs::write(&path, &bytes).unwrap();
        assert!(CorrectedSmIndex::load(&path, &base).is_err());
        std::fs::write(&path, &bytes[..20]).unwrap();
        assert!(CorrectedSmIndex::load(&path, &base).is_err());
        std::fs::remove_file(path).unwrap();
        let mut q = base[..DIM].to_vec();
        q[0] = f32::NAN;
        assert!(
            index
                .search(&q, &base, &cfg, SmSearchMode::Combined)
                .is_err()
        );
        assert!(
            index
                .search(&base[..DIM - 1], &base, &cfg, SmSearchMode::Combined)
                .is_err()
        );
        let invalid = QuIVerSearchConfig {
            top_k: 10,
            ef_search: 80,
            rerank_limit: Some(81),
        };
        assert!(
            index
                .search(&base[..DIM], &base, &invalid, SmSearchMode::Combined)
                .is_err()
        );
    }

    #[test]
    fn cold_callback_and_extended_budget_match_slice() {
        let (base, index) = fixture(128);
        for budget in [16, 64, 96] {
            let cfg = QuIVerSearchConfig {
                top_k: 10,
                ef_search: 112,
                rerank_limit: Some(budget),
            };
            for mode in [SmSearchMode::Reference, SmSearchMode::Combined] {
                let expected = index.search(&base[..DIM], &base, &cfg, mode).unwrap();
                let mut touched = Vec::new();
                let actual = index
                    .search_with_vectors(&base[..DIM], &cfg, mode, |id, buffer| {
                        touched.push(id);
                        buffer.extend_from_slice(&base[id * DIM..(id + 1) * DIM]);
                        true
                    })
                    .unwrap();
                same(&expected, &actual);
                assert_eq!(touched.len(), budget, "锚点应占精算总预算的一个名额");
                assert_eq!(
                    touched
                        .iter()
                        .copied()
                        .collect::<std::collections::HashSet<_>>()
                        .len(),
                    budget
                );
            }
        }
    }

    #[test]
    fn fast_routing_preserves_graph_slots_and_invalidates_on_write() {
        let (mut base, _) = fixture(128);
        for row in base.as_chunks_mut::<DIM>().0.iter_mut() {
            let norm = row.iter().map(|&v| (v as f64).powi(2)).sum::<f64>().sqrt();
            for v in row {
                *v = (*v as f64 / norm) as f32;
            }
        }
        let ids = (0..128).map(|u| 1000 + 3 * u as u64).collect::<Vec<_>>();
        let slots = (0..128).map(|u| 7 + 2 * u).collect::<Vec<_>>();
        let coeff = (0..128).map(|u| (u % 7) as f32 / 10.).collect::<Vec<_>>();
        let config = super::super::QuIVerConfig {
            m: 8,
            ef_construction: 32,
            alpha: 1.2,
        };
        let mut raw = QuIVer::new(DIM, &config);
        rayon::ThreadPoolBuilder::new()
            .num_threads(2)
            .build()
            .unwrap()
            .install(|| raw.batch_build_experimental_v2(&base, &ids, &slots));
        let before = raw.layer0.data.clone();
        let entry = raw.entry_point;
        let snapshot = raw.corrected_sm_snapshot(&base, &coeff).unwrap();
        raw.enable_corrected_sm(&base, &coeff).unwrap();
        assert_eq!(before, raw.layer0.data);
        assert_eq!(entry, raw.entry_point);
        assert_eq!(
            raw.corrected_sm.as_ref().unwrap().graph.data.capacity(),
            0,
            "不应常驻第二张图"
        );
        assert!(raw.enable_corrected_sm(&base, &coeff[..127]).is_err());
        assert!(raw.corrected_sm_enabled(), "无效安装不得破坏现有模型");
        for budget in [64, 96] {
            let cfg = QuIVerSearchConfig {
                top_k: 10,
                ef_search: 112,
                rerank_limit: Some(budget),
            };
            let expected = snapshot
                .search(&base[..DIM], &base, &cfg, SmSearchMode::Combined)
                .unwrap();
            let mut touched = Vec::new();
            let actual = raw.search(
                &base[..DIM],
                |slot, buffer| {
                    touched.push(slot);
                    let u = (slot - 7) / 2;
                    buffer.extend_from_slice(&base[u * DIM..(u + 1) * DIM]);
                    true
                },
                &cfg,
            );
            assert_eq!(
                actual
                    .iter()
                    .map(|v| (v.0, v.1.to_bits()))
                    .collect::<Vec<_>>(),
                expected
                    .neighbors
                    .iter()
                    .map(|v| (v.0, v.1.to_bits()))
                    .collect::<Vec<_>>()
            );
            assert_eq!(touched.len(), budget);
        }
        let cfg = QuIVerSearchConfig {
            top_k: 10,
            ef_search: 80,
            rerank_limit: Some(64),
        };
        let filtered = |slot: usize, buffer: &mut Vec<f32>| {
            if slot == 7 {
                return false;
            }
            let u = (slot - 7) / 2;
            buffer.extend_from_slice(&base[u * DIM..(u + 1) * DIM]);
            true
        };
        let expected = raw
            .default_sm
            .as_ref()
            .unwrap()
            .search_routed(&base[..DIM], &raw.layer0, &cfg, |internal, buffer| {
                filtered(raw.slot_indices[internal], buffer)
            })
            .unwrap()
            .neighbors;
        let actual = raw.search(&base[..DIM], filtered, &cfg);
        assert_eq!(actual, expected, "锚点被过滤时应使用默认无锚点SM");
        assert!(raw.soft_delete(ids[7]));
        assert!(!raw.corrected_sm_enabled());
        assert!(raw.enable_corrected_sm(&base, &coeff).is_err());
        assert!(
            raw.search(&base[..DIM], filtered, &cfg)
                .iter()
                .all(|v| v.0 != ids[7])
        );
        raw.batch_build_experimental_v2(&base, &ids, &slots);
        raw.enable_corrected_sm(&base, &coeff).unwrap();
        let mut seed = 20261017;
        raw.insert(&base[..DIM], 99999, 999, &mut seed);
        assert!(!raw.corrected_sm_enabled(), "插入后不能使用旧的校正模型");
    }

    #[test]
    fn memtable_routing_handles_reused_slots_and_nonunit_vectors() {
        // VCP-PATCH: simulate caller-owned cold storage with reusable slots.
        let (mut base, _) = fixture(128);
        for row in base.as_chunks_mut::<DIM>().0.iter_mut() {
            let norm = row.iter().map(|&v| (v as f64).powi(2)).sum::<f64>().sqrt();
            for v in row {
                *v = (*v as f64 / norm * 3.) as f32;
            }
        }
        let mut ids = (1..=128).collect::<Vec<u64>>();
        let deleted = ids[16];
        ids[16] = 1000;
        let mut raw = QuIVer::new(DIM, &super::super::QuIVerConfig {
            m: 8, ef_construction: 32, alpha: 1.2,
        });
        raw.batch_build_experimental_v2(
            &base, &ids, &(0..128).collect::<Vec<_>>(),
        );
        let coefficients = ids.iter().rev().map(|&id| (id, 0.)).collect::<Vec<_>>();
        raw.enable_corrected_sm_with_vectors(&coefficients, |slot, out| {
            out.clear();
            out.extend_from_slice(&base[slot * DIM..(slot + 1) * DIM]);
            true
        }).unwrap();
        assert!(raw.corrected_sm_enabled());
        let cfg = QuIVerSearchConfig {
            top_k: 10,
            ef_search: 128,
            rerank_limit: Some(128),
        };
        let out = raw.search(
            &base[16 * DIM..17 * DIM],
            |slot, buffer| {
                buffer.clear();
                buffer.extend_from_slice(&base[slot * DIM..(slot + 1) * DIM]);
                true
            },
            &cfg,
        );
        assert_eq!(out[0].0, ids[16]);
        assert!((out[0].1 - 1.).abs() < 1e-5);
        assert!(out.iter().all(|v| v.0 != deleted));
        raw.soft_delete(ids[5]);
        let mut seed = 42;
        raw.insert(&base[..DIM], ids[5], 5, &mut seed);
        assert!(!raw.corrected_sm_enabled());
    }

    #[test]
    fn database_api_uses_fast_graph_and_accepts_large_candidate_pool() {
        // VCP-PATCH: validate the kernel API, not the excluded database wrapper.
        let directory = std::env::temp_dir().join(format!(
            "tdb-fast-sm-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("快速校正验证.tdb");
        let mut raw = QuIVer::new(DIM, &super::super::QuIVerConfig {
            m: 8, ef_construction: 32, alpha: 1.2,
        });
        let (base, _) = fixture(128);
        let ids = (1..=128).collect::<Vec<_>>();
        raw.batch_build_experimental_v2(
            &base, &ids, &(0..128).collect::<Vec<_>>(),
        );
        raw.enable_corrected_sm_with_vectors(&[], |slot, out| {
            out.clear();
            out.extend_from_slice(&base[slot * DIM..(slot + 1) * DIM]);
            true
        }).unwrap();
        assert!(raw.corrected_sm_enabled());
        let hits = raw.search_flat(&base[16 * DIM..17 * DIM], &base,
            &QuIVerSearchConfig { top_k: 10, ef_search: 128, rerank_limit: Some(128) });
        assert_eq!(hits.len(), 10);
        assert_eq!(hits[0].0, ids[16]);
        assert!((hits[0].1 - 1.).abs() < 1e-4);
        raw.save_to_file(&path).unwrap();
        drop(raw);
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
