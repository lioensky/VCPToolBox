//! Instance/request-local Route 2 flat scan. No cold-vector callback exists here.
use super::*;
use crate::index::quiver::asymmetric::{AsymKernel, AsymQuerySm, SmCodeParams};
use crate::index::quiver::sketch::{AsymSketch256Query, pack_from_pos};

/// Temporary derived head-line cache; Stage 2B will colocate heads and bitplanes.
#[derive(Clone, Copy)]
#[repr(C, align(64))]
pub(super) struct FlatHeader {
    pub(super) sketch: [u64; 4],
    sm: SmCodeParams,
}

/// Explicit A/B controls. Existing callers retain legacy scoring by default.
#[derive(Clone, Copy, Debug, Default)]
pub struct FlatSearchConfig {
    pub enabled: bool,
    /// Opt-in statistical filter, never a proven upper bound.
    /// None disables loss from sketch filtering; accepted range is [0,2].
    pub sketch_margin: Option<f64>,
    pub kernel: AsymKernel,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct FlatSearchStats {
    pub admitted: usize,
    pub sketch_tested: usize,
    pub sketch_rejected: usize,
    pub symmetric_scored: usize,
    pub asymmetric_scored: usize,
    pub peak_pool: usize,
}

impl CorrectedSmIndex {
    fn flat_planes(&self, slot: usize) -> (&[u64], &[u64]) {
        if let Some(model) = &self.dynamic {
            let words = self.dimension().div_ceil(64);
            let row = model.row(slot);
            (&row[..words], &row[words..words * 2])
        } else {
            let row = &self.rows[slot];
            (&row.pos, &row.strong)
        }
    }

    pub(super) fn make_flat_header(&self, slot: usize) -> FlatHeader {
        let sm = if let Some(model) = &self.dynamic {
            let (weak, delta, _, norm, count) = model.metadata(slot);
            SmCodeParams { weak, delta, sigma: norm.sqrt(), strong_ones: count }
        } else {
            let row = &self.rows[slot];
            SmCodeParams { weak: row.weak, delta: row.delta,
                sigma: row.reconstructed_norm.sqrt(), strong_ones: row.strong_count as u32 }
        };
        let (pos, _) = self.flat_planes(slot);
        FlatHeader { sketch: pack_from_pos(pos, self.dimension()), sm }
    }

    /// Rebuild heads exclusively from existing codes. No snapshot layout change,
    /// no original vectors, and no SQLite access, including legacy snapshot restore.
    pub fn prepare_flat_headers(&mut self) -> io::Result<()> {
        if self.scoring != SmScoring::ReconstructedL2 {
            return Err(invalid("Route 2 flat scan requires default normalized routing"));
        }
        if self.flat_headers.is_none() {
            let mut rows = Vec::new();
            rows.try_reserve_exact(self.len()).map_err(io::Error::other)?;
            for slot in 0..self.len() { rows.push(self.make_flat_header(slot)); }
            self.flat_headers = Some(rows);
        }
        Ok(())
    }

    /// Returns approximate cosine for Route 2, legacy negative SM-L2 otherwise.
    /// Allowed is called exactly once per slot (unless limit=0 or input is invalid).
    pub fn search_flat_filtered_with_config<F>(
        &self, query: &[f32], limit: usize, config: &FlatSearchConfig, mut allowed: F,
    ) -> io::Result<(Vec<(u64, f32)>, FlatSearchStats)>
    where F: FnMut(usize, u64) -> bool {
        if config.sketch_margin.is_some_and(|m| !m.is_finite() || !(0.0..=2.0).contains(&m)) {
            return Err(invalid("sketch margin must be finite and within [0,2]"));
        }
        let mut stats = FlatSearchStats::default();
        if !config.enabled {
            if config.sketch_margin.is_some() {
                return Err(invalid("sketch filtering requires explicit Route 2 selection"));
            }
            let found = self.search_flat_filtered(query, limit, |slot, id| {
                let admit = allowed(slot, id);
                stats.admitted += usize::from(admit);
                admit
            })?;
            stats.symmetric_scored = stats.admitted;
            stats.peak_pool = found.len();
            return Ok((found, stats));
        }
        if query.len() != self.dimension() || query.iter().any(|v| !v.is_finite()) {
            return Err(invalid("invalid Route 2 query"));
        }
        if limit == 0 || self.is_empty() { return Ok((Vec::new(), stats)); }
        let heads = self.flat_headers.as_ref().filter(|h| h.len() == self.len())
            .ok_or_else(|| invalid("Route 2 flat heads not prepared"))?;
        let norm = crate::metric_math::norm_squared_f64(query).sqrt();
        let normalized: Vec<f32> = query.iter().map(|&v| if norm > 0. { (v as f64 / norm) as f32 } else { 0. }).collect();
        let code = Bq2Signature::from_vector(&normalized);
        let mut sums = [0f64; 2];
        let mut counts = [0usize; 2];
        for (j, &v) in normalized.iter().enumerate() {
            let group = ((code.strong[j / 64] >> (j % 64)) & 1) as usize;
            sums[group] += v.abs() as f64;
            counts[group] += 1;
        }
        let weak = if counts[0] == 0 { 0. } else { (sums[0] / counts[0] as f64) as f32 };
        let high = if counts[1] == 0 { 0. } else { (sums[1] / counts[1] as f64) as f32 };
        let query_sm = SmCodeParams { weak, delta: high - weak,
            sigma: (counts[0] as f64 * (weak as f64).powi(2)
                + counts[1] as f64 * (high as f64).powi(2)).sqrt() as f32,
            strong_ones: counts[1] as u32 };
        let asymmetric = AsymQuerySm::encode(query)?;
        let sketch = (self.len() >= 1024 && config.sketch_margin.is_some())
            .then(|| AsymSketch256Query::encode(query));
        // Never shrink below the caller's requested candidate count.
        let pool = limit.saturating_mul(2).min(1024).max(limit).min(self.len());
        let mut heap: BinaryHeap<(NonNanF32, u64, usize)> = BinaryHeap::with_capacity(pool + 1);
        for (slot, &id) in self.ids.iter().enumerate() {
            if !allowed(slot, id) { continue; }
            stats.admitted += 1;
            if stats.admitted >= 1024 && heap.len() == pool {
                if let Some(sketch) = &sketch {
                    stats.sketch_tested += 1;
                    let estimate = sketch.cosine_hat(&heads[slot].sketch);
                    let threshold = -heap.peek().unwrap().0.0 as f64;
                    let margin = AsymSketch256Query::effective_margin(
                        estimate, config.sketch_margin.unwrap(), self.dimension(),
                    );
                    if (estimate + margin).min(1.) < threshold {
                        stats.sketch_rejected += 1;
                        continue;
                    }
                }
            }
            let (pos, strong) = self.flat_planes(slot);
            let bits = crate::index::bq::sm_counts::counts(pos, strong, &code.pos, &code.strong, self.dimension());
            let score = heads[slot].sm.calibrated_cosine(query_sm, bits, self.dimension()) as f32;
            stats.symmetric_scored += 1;
            let candidate = (NonNanF32(-score), id, slot);
            if heap.len() < pool { heap.push(candidate); }
            else if candidate < *heap.peek().unwrap() { *heap.peek_mut().unwrap() = candidate; }
            stats.peak_pool = stats.peak_pool.max(heap.len());
        }
        let mut found = heap.into_iter().map(|(_, id, slot)| {
            let (pos, strong) = self.flat_planes(slot);
            let score = asymmetric.calibrated_cosine(pos, strong, heads[slot].sm, config.kernel) as f32;
            stats.asymmetric_scored += 1;
            (id, score)
        }).collect::<Vec<_>>();
        found.sort_unstable_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        found.truncate(limit);
        Ok((found, stats))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_route2_filter_budget_threads_and_legacy_restore_are_isolated() {
        assert_eq!(std::mem::size_of::<FlatHeader>(), 64);
        for dim in [65usize, 384, 768, 1536, 3072] {
            let mut index = CorrectedSmIndex::empty_flat(dim).unwrap();
            let query: Vec<f32> = (0..dim).map(|j| (j as f32 * 0.13).sin()).collect();
            for slot in 0..128 {
                let vector: Vec<f32> = query.iter().map(|v| if slot % 2 == 0 { *v } else { -*v }).collect();
                index.push_flat_vector(&vector, slot + 1).unwrap();
            }
            index.prepare_flat_headers().unwrap();
            let bytes = index.routing_snapshot_bytes().unwrap();
            let mut restored = CorrectedSmIndex::from_routing_snapshot_bytes(&bytes).unwrap();
            restored.prepare_flat_headers().unwrap();
            let config = FlatSearchConfig { enabled: true, ..Default::default() };
            let mut calls = 0;
            let (found, stats) = index.search_flat_filtered_with_config(&query, 10, &config, |_, id| {
                calls += 1; id > 32
            }).unwrap();
            assert_eq!(calls, 128);
            assert_eq!(stats.admitted, 96);
            assert_eq!(stats.peak_pool, 20);
            assert_eq!(stats.asymmetric_scored, 20);
            assert_eq!(found.iter().map(|v| v.0).collect::<Vec<_>>(), (33..53).step_by(2).collect::<Vec<_>>());
            assert_eq!(found, restored.search_flat_filtered_with_config(&query, 10, &config, |_, id| id > 32).unwrap().0);
            std::thread::scope(|scope| {
                for _ in 0..4 {
                    scope.spawn(|| {
                        assert_eq!(found, index.search_flat_filtered_with_config(&query, 10, &config, |_, id| id > 32).unwrap().0);
                    });
                }
            });
            let legacy = FlatSearchConfig::default();
            assert_eq!(index.search_flat_filtered(&query, 10, |_, _| true).unwrap(),
                index.search_flat_filtered_with_config(&query, 10, &legacy, |_, _| true).unwrap().0);
            index.push_flat_vector(&query, 129).unwrap();
            assert_eq!(index.flat_headers.as_ref().unwrap().len(), 129);
            assert!(index.search_flat_filtered_with_config(&query, 10, &config, |_, _| false).unwrap().0.is_empty());
            let (_, stats) = index.search_flat_filtered_with_config(&query, 2000, &config, |_, _| true).unwrap();
            assert_eq!(stats.asymmetric_scored, 129);
        }
    }

    #[test]
    fn sketch_opt_in_is_counted_and_invalid_controls_fail_before_filter_access() {
        let mut index = CorrectedSmIndex::empty_flat(65).unwrap();
        let query = vec![1.; 65];
        for id in 1..=2048 {
            index.push_flat_vector(&if id <= 32 { query.clone() } else { vec![-1.; 65] }, id).unwrap();
        }
        index.prepare_flat_headers().unwrap();
        let config = FlatSearchConfig { enabled: true, sketch_margin: Some(0.2), kernel: AsymKernel::Auto };
        let (found, stats) = index.search_flat_filtered_with_config(&query, 10, &config, |_, _| true).unwrap();
        assert_eq!(found.len(), 10);
        assert!(stats.sketch_rejected > 0);
        assert!(stats.sketch_tested <= stats.admitted - 1023);
        // Large physical table, sparse allowed rows; the heap fills but screening
        // must stay disabled because fewer than 1024 live rows were admitted.
        for live in [0usize, 10, 300, 600, 1023] {
            let mut calls = 0;
            let (small, metrics) = index.search_flat_filtered_with_config(&query, 10, &config, |_, id| {
                calls += 1;
                id as usize <= live
            }).unwrap();
            let unfiltered = FlatSearchConfig { sketch_margin: None, ..config };
            let (reference, _) = index.search_flat_filtered_with_config(&query, 10, &unfiltered,
                |_, id| id as usize <= live).unwrap();
            assert_eq!(calls, 2048);
            assert_eq!(small, reference);
            assert_eq!(metrics.sketch_tested, 0);
            assert_eq!(metrics.sketch_rejected, 0);
            assert_eq!(metrics.symmetric_scored, live);
        }
        assert_eq!(stats.admitted, stats.symmetric_scored + stats.sketch_rejected);
        for margin in [f64::NAN, -1., 2.1] {
            let bad = FlatSearchConfig { sketch_margin: Some(margin), ..config };
            assert!(index.search_flat_filtered_with_config(&query, 10, &bad, |_, _| panic!()).is_err());
        }
        assert!(index.search_flat_filtered_with_config(&query, 0, &config, |_, _| panic!()).unwrap().0.is_empty());
    }
}