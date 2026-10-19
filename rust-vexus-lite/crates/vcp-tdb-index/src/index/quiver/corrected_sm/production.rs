//! 默认余弦查询的流式SM状态；只保存紧凑位码与幅值，不复制全库冷向量。
use super::*;
// VCP-PATCH: cold-slot construction accepts the public graph configuration.
use crate::QuIVerConfig;

impl CorrectedSmIndex {
    pub(crate) fn empty_routing(dim: usize) -> io::Result<Self> {
        dynamic::check_dimension(dim)?;
        Ok(Self {
            rows: Vec::new(),
            graph: FlatAdj::new(1),
            ids: Vec::new(),
            entry: 0,
            anchor: 0,
            base_crc: 0,
            exact_scales: Vec::new(),
            scoring: SmScoring::ReconstructedL2,
            dynamic: if dim == DIM {
                None
            } else {
                Some(DynamicSm::empty(dim, 0)?)
            },
        })
    }

    pub(crate) fn reserve_routing(&mut self, n: usize) {
        self.ids.reserve(n);
        self.exact_scales.reserve(n);
        if let Some(model) = &mut self.dynamic {
            model.reserve_rows(n);
        } else {
            self.rows.reserve(n);
        }
    }

    /// 每次只转换一条向量；非单位输入按旧余弦语义归一化，零向量保持零。
    pub(crate) fn push_routing_vector(&mut self, vector: &[f32], id: u64) -> io::Result<()> {
        let dim = self.dimension();
        if vector.len() != dim || vector.iter().any(|x| !x.is_finite()) {
            return Err(invalid("默认SM向量维度或数值无效"));
        }
        let norm = vector.iter().map(|&x| (x as f64).powi(2)).sum::<f64>();
        let scale = if norm == 0. || (norm - 1.).abs() <= 1e-5 {
            1.
        } else {
            (1. / norm.sqrt()) as f32
        };
        let normalized;
        let x = if scale == 1. {
            vector
        } else {
            let inverse = 1. / norm.sqrt();
            normalized = vector
                .iter()
                .map(|&v| {
                    if extreme_scale(scale) {
                        (v as f64 * inverse) as f32
                    } else {
                        v * scale
                    }
                })
                .collect::<Vec<_>>();
            &normalized
        };
        if let Some(model) = &mut self.dynamic {
            model.push_vector(x)?;
        } else {
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
            let reconstructed_high = weak + delta;
            self.rows.push(SmRow {
                pos: code.pos[..12].try_into().unwrap(),
                strong: code.strong[..12].try_into().unwrap(),
                weak,
                delta,
                coefficient: 0.,
                reconstructed_norm: counts[0] as f32 * weak * weak
                    + counts[1] as f32 * reconstructed_high * reconstructed_high,
                strong_count: counts[1] as u16,
            });
        }
        self.ids.push(id);
        self.exact_scales.push(scale);
        Ok(())
    }

    pub(crate) fn set_routing_entry(&mut self, entry: u32) {
        self.entry = entry;
    }
}

/// 极端幅值先在已读取的单条冷向量上归一化，避免FP32点积上溢或下溢。
pub(super) fn extreme_scale(scale: f32) -> bool {
    !scale.is_finite() || !(1e-10..=1e10).contains(&scale)
}

pub(super) fn prepare_exact_buffer(buffer: &mut [f32], scale: f32) {
    if extreme_scale(scale) {
        let norm = buffer
            .iter()
            .map(|&x| (x as f64).powi(2))
            .sum::<f64>()
            .sqrt();
        if norm > 0. {
            for value in buffer {
                *value = (*value as f64 / norm) as f32;
            }
        }
    }
}

pub(super) fn exact_scale(scale: f32) -> f32 {
    if extreme_scale(scale) { 1. } else { scale }
}

impl QuIVer {
    /// VCP-PATCH: bind an embedded graph to the host's compact original rows.
    pub fn validate_compact_slots(&self, dimension: usize, ids: &[u64]) -> io::Result<()> {
        if self.dim != dimension || self.n != ids.len()
            || self.ids != ids
            || self.tombstones.iter().any(|deleted| *deleted)
            || self.slot_indices.iter().enumerate().any(|(slot, stored)| slot != *stored)
        {
            return Err(invalid("graph identity or slots do not match vector asset"));
        }
        Ok(())
    }

    /// VCP-PATCH: build from cold slots without allocating a full f32 matrix.
    /// The callback must expose the same frozen source during both passes.
    /// Publish only after graph and default SM preparation have both succeeded.
    pub fn rebuild_from_cold_slots<F>(
        &mut self,
        ids: &[u64],
        slots: &[usize],
        config: &QuIVerConfig,
        mut fill: F,
    ) -> io::Result<()>
    where
        F: FnMut(usize, &mut Vec<f32>) -> bool,
    {
        if ids.len() != slots.len()
            || ids.len() > u32::MAX as usize
            || ids.iter().any(|id| *id == 0)
            || ids.iter().copied().collect::<std::collections::HashSet<_>>().len() != ids.len()
            || slots.iter().copied().collect::<std::collections::HashSet<_>>().len() != slots.len()
            || config.m < 2
            || config.ef_construction == 0
            || !config.alpha.is_finite()
            || config.alpha < 1.0
        {
            return Err(invalid("invalid cold-slot build identities or configuration"));
        }
        dynamic::check_dimension(self.dim)?;
        let mut store = crate::index::bq::Bq2Store::new(self.dim);
        let mut buffer = Vec::with_capacity(self.dim);
        for &slot in slots {
            buffer.clear();
            if !fill(slot, &mut buffer)
                || buffer.len() != self.dim
                || buffer.iter().any(|value| !value.is_finite())
            {
                return Err(invalid("cold-slot build cannot read a valid source vector"));
            }
            store.push_sig(&Bq2Signature::from_vector(&buffer));
        }
        let mut replacement = QuIVer::new(self.dim, config);
        replacement.batch_build_from_store(ids, slots, store);
        // VCP-PATCH: quantization-collapsed dense clusters can be disconnected
        // after parallel pruning. Preserve all selected neighbors and use one
        // spare adjacency slot per node for a deterministic directed cycle.
        // This guarantees reachability, not approximate-search recall.
        if replacement.reachable_node_count() != ids.len() {
            for node in 0..ids.len() {
                let next = ((node + 1) % ids.len()) as u32;
                if !replacement.layer0.contains(node as u32, next) {
                    if replacement.layer0.degree(node as u32) + 1 >= replacement.layer0.stride {
                        return Err(invalid("no spare adjacency slot for connectivity repair"));
                    }
                    replacement.layer0.push_neighbor(node as u32, next);
                }
            }
            if replacement.reachable_node_count() != ids.len() {
                return Err(invalid("cold-slot graph connectivity repair failed"));
            }
        }
        replacement.prepare_default_sm(&mut fill)?;
        *self = replacement;
        Ok(())
    }

    /// VCP-PATCH: serialize default routing for the host's single-file asset.
    pub fn default_sm_snapshot_bytes(&self) -> io::Result<Vec<u8>> {
        self.default_sm.as_ref()
            .ok_or_else(|| invalid("default SM is not ready"))?
            .routing_snapshot_bytes()
    }

    /// VCP-PATCH: validate graph/model identity before publishing restored routing.
    pub fn restore_default_sm_snapshot(&mut self, bytes: &[u8]) -> io::Result<()> {
        let model = CorrectedSmIndex::from_routing_snapshot_bytes(bytes)?;
        if model.dimension() != self.dim || model.len() != self.n
            || model.ids != self.ids || model.scoring != SmScoring::ReconstructedL2
        {
            return Err(invalid("default SM does not match graph identities"));
        }
        self.set_default_sm(model);
        Ok(())
    }

    /// 旧BQ文件不含SM幅值；数据库发布索引前从实际slot流式恢复默认查询状态。
    // VCP-PATCH: expose streaming recovery to the SQL-authoritative host.
    pub fn prepare_default_sm<F>(&mut self, mut fill: F) -> io::Result<()>
    where
        F: FnMut(usize, &mut Vec<f32>) -> bool,
    {
        let mut model = CorrectedSmIndex::empty_routing(self.dim)?;
        model.reserve_routing(self.n);
        let mut buffer = Vec::with_capacity(self.dim);
        for (internal, &slot) in self.slot_indices.iter().enumerate() {
            buffer.clear();
            if self.tombstones[internal] {
                // 墓碑只参与图导航，不能从已复用slot读取新节点作为旧节点的向量。
                buffer.resize(self.dim, 0.);
            } else if !fill(slot, &mut buffer) {
                return Err(invalid("默认SM恢复时无法读取活跃节点向量"));
            }
            model.push_routing_vector(&buffer, self.ids[internal])?;
        }
        model.set_routing_entry(self.entry_point);
        self.default_sm = Some(model);
        Ok(())
    }

    // VCP-PATCH: restore persisted routing rows without rereading cold vectors.
    pub fn set_default_sm(&mut self, mut model: CorrectedSmIndex) {
        assert_eq!(model.dimension(), self.dim);
        assert_eq!(model.len(), self.n);
        model.set_routing_entry(self.entry_point);
        self.default_sm = Some(model);
    }

    pub(crate) fn rebuild_default_sm(&mut self, vectors: &[f32]) {
        // 批量追加入口沿用旧节点的紧凑行，新全量构建入口则从空模型开始。
        let mut model = self
            .default_sm
            .take()
            .unwrap_or_else(|| CorrectedSmIndex::empty_routing(self.dim).expect("合法SM维度"));
        let start = self.n - vectors.len() / self.dim;
        if model.len() != start {
            model = CorrectedSmIndex::empty_routing(self.dim).expect("合法SM维度");
            assert_eq!(start, 0, "追加构图缺少旧节点SM状态");
        }
        model.reserve_routing(self.n - start);
        for (i, vector) in vectors.chunks_exact(self.dim).enumerate() {
            model
                .push_routing_vector(vector, self.ids[start + i])
                .expect("构图向量必须合法");
        }
        self.set_default_sm(model);
    }

    /// 当前查询默认使用无训练SM-L2；校正和原生欧氏仅由显式安装覆盖。
    pub fn default_sm_l2_enabled(&self) -> bool {
        self.corrected_sm.is_none() && self.default_sm_ready()
    }

    // VCP-PATCH: the host must reject incomplete routing snapshots.
    pub fn default_sm_ready(&self) -> bool {
        self.default_sm.as_ref().is_some_and(|m| m.len() == self.n)
    }
}


#[cfg(test)]
mod cold_slot_build_tests {
    use super::*;

    #[test]
    fn streaming_build_uses_sparse_slots_and_failure_preserves_previous_index() {
        let dim = 65;
        let ids: Vec<u64> = (1..=40).collect();
        let slots: Vec<usize> = (0..40).map(|i| 7 + i * 3).collect();
        let rows: Vec<Vec<f32>> = (0..40).map(|i| {
            (0..dim).map(|j| ((i * 37 + j * 13 + 1) as f32).sin()).collect()
        }).collect();
        let config = crate::QuIVerConfig::default();
        let mut graph = QuIVer::new(dim, &config);
        let mut reads = 0;
        graph.rebuild_from_cold_slots(&ids, &slots, &config, |slot, buffer| {
            reads += 1;
            let Some(position) = slots.iter().position(|candidate| *candidate == slot) else {
                return false;
            };
            buffer.extend_from_slice(&rows[position]);
            true
        }).unwrap();
        assert_eq!(reads, ids.len() * 2);
        assert_eq!(graph.active_count(), ids.len());
        assert!(graph.default_sm_ready());
        let before = graph.default_sm_snapshot_bytes().unwrap();
        for failed_read in [0, ids.len(), ids.len() + 12] {
            let mut attempts = 0;
            let error = graph.rebuild_from_cold_slots(&ids, &slots, &config, |slot, buffer| {
                let current = attempts;
                attempts += 1;
                if current == failed_read { return false; }
                let position = slots.iter().position(|candidate| *candidate == slot).unwrap();
                buffer.extend_from_slice(&rows[position]);
                true
            });
            assert!(error.is_err());
            assert_eq!(graph.active_count(), ids.len());
            assert_eq!(before, graph.default_sm_snapshot_bytes().unwrap());
        }
        assert!(graph.rebuild_from_cold_slots(&[1, 1], &[1, 2], &config, |_, _| {
            panic!("duplicate identities must fail before source access")
        }).is_err());
    }
}
