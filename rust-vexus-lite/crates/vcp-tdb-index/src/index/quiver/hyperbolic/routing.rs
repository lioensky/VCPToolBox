//! Hot-only cone/shell routing adapted from Pelorus (Apache-2.0).
//! Copyright 2024 TriviumDB Authors. No NativeSpace or global settings.
use super::*;
use crate::index::bq::{sm_counts, Bq2Store};

pub(crate) fn planes(store: &Bq2Store, node: usize) -> (&[u64], &[u64]) {
    let start = node * store.chunks();
    let end = start + store.chunks();
    (&store.pos_data()[start..end], &store.strong_data()[start..end])
}
pub(crate) fn pair_cosine(store: &Bq2Store, meta: &[PolarNodeMeta], a: usize, b: usize, dim: usize) -> f64 {
    if a == b { return 1.0; }
    let (ap, ah) = planes(store, a);
    let (bp, bh) = planes(store, b);
    meta[a].sm().calibrated_cosine(meta[b].sm(), sm_counts::counts(ap, ah, bp, bh, dim), dim)
}
pub(crate) fn query_cosine(
    store: &Bq2Store, meta: &[PolarNodeMeta], node: usize,
    signature: &Bq2Signature, sm: SmCodeParams, dim: usize,
) -> f64 {
    let (p, h) = planes(store, node);
    sm.calibrated_cosine(meta[node].sm(),
        sm_counts::counts(&signature.pos[..store.chunks()], &signature.strong[..store.chunks()], p, h, dim), dim)
}

pub(crate) struct PolarRouter {
    pub meta: Vec<PolarNodeMeta>,
    pub landmarks: Vec<u32>,
    pub hubs: Vec<u32>,
    pub edges: [f32; 7],
    pub min_depth: f32,
    pub max_depth: f32,
    cells: Vec<Vec<u32>>,
    coarse: Vec<Vec<u16>>,
}
impl PolarRouter {
    pub fn hot_bytes_without_meta(&self) -> usize {
        self.landmarks.capacity() * 4 + self.hubs.capacity() * 4
            + self.cells.capacity() * std::mem::size_of::<Vec<u32>>()
            + self.cells.iter().map(|cell| cell.capacity() * 4).sum::<usize>()
            + self.coarse.capacity() * std::mem::size_of::<Vec<u16>>()
            + self.coarse.iter().map(|row| row.capacity() * 2).sum::<usize>()
    }

    pub fn band(&self, depth: f32) -> usize {
        self.edges.partition_point(|edge| depth >= *edge)
    }

    #[cfg(test)]
    pub fn build(store: &Bq2Store, meta: Vec<PolarNodeMeta>, dim: usize) -> Self {
        Self::build_with_landmarks(store, meta, dim, None)
    }

    pub fn build_with_landmarks(store: &Bq2Store, meta: Vec<PolarNodeMeta>, dim: usize, requested: Option<usize>) -> Self {
        let n = meta.len();
        let mut order: Vec<u32> = (0..n as u32).collect();
        order.sort_unstable_by(|&a, &b| meta[a as usize].depth.total_cmp(&meta[b as usize].depth).then(a.cmp(&b)));
        let min_depth = order.first().map_or(0.0, |&id| meta[id as usize].depth);
        let max_depth = order.last().map_or(0.0, |&id| meta[id as usize].depth);
        let mut edges = [0.0; 7];
        // Eight actual quantile bands, including small and hollow-shell fixtures.
        for (i, edge) in edges.iter_mut().enumerate() {
            *edge = if n == 0 { 0.0 } else { meta[order[(n - 1) * (i + 1) / 8] as usize].depth };
        }
        let hubs = order.iter().take(16).copied().collect();
        let target = requested.unwrap_or((n / 100).clamp(64, 2048)).clamp(1, 2048).min(n);
        let sample_count = (target * 5).clamp(512, 6144).min(n);
        let samples: Vec<usize> = (0..sample_count)
            .map(|i| i * n.saturating_sub(1) / sample_count.saturating_sub(1).max(1)).collect();
        let mut landmarks = Vec::with_capacity(target);
        let mut maximum = vec![f64::NEG_INFINITY; sample_count];
        if let Some(&first) = samples.first() { landmarks.push(first as u32); }
        while landmarks.len() < target {
            let last = *landmarks.last().unwrap() as usize;
            let mut chosen = None;
            for (i, &node) in samples.iter().enumerate() {
                maximum[i] = maximum[i].max(pair_cosine(store, &meta, last, node, dim));
                if chosen.is_none_or(|best| maximum[i] < maximum[best]) {
                    chosen = Some(i);
                }
            }
            let Some(best) = chosen else { break; };
            if maximum[best] >= 0.9999 { break; }
            landmarks.push(samples[best] as u32);
        }
        let mut router = Self { meta, landmarks, hubs, edges, min_depth, max_depth,
            cells: Vec::new(), coarse: Vec::new() };
        router.cells.resize_with(router.landmarks.len() * 8, Vec::new);
        // Persist 64 -> at most 128 fine-cone shortlists, not FP32 landmarks.
        if router.landmarks.len() > 256 {
            for &coarse in router.landmarks.iter().take(64) {
                let mut scores: Vec<_> = router.landmarks.iter().enumerate().map(|(i, &fine)|
                    (pair_cosine(store, &router.meta, coarse as usize, fine as usize, dim), i as u16)).collect();
                scores.sort_unstable_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
                router.coarse.push(scores.into_iter().take(128).map(|(_, i)| i).collect());
            }
        }
        // One bounded score buffer, reused across nodes; no original matrix.
        let mut scores = Vec::with_capacity(router.landmarks.len());
        for node in 0..n {
            scores.clear();
            for (cone, &landmark) in router.landmarks.iter().enumerate() {
                scores.push((pair_cosine(store, &router.meta, node, landmark as usize, dim), cone));
            }
            scores.sort_unstable_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
            let band = router.band(router.meta[node].depth);
            for &(_, cone) in scores.iter().take(2) {
                let cell = &mut router.cells[cone * 8 + band];
                cell.push(node as u32);
                let landmark = router.landmarks[cone] as usize;
                cell.sort_unstable_by(|&a, &b|
                    pair_cosine(store, &router.meta, b as usize, landmark, dim)
                        .total_cmp(&pair_cosine(store, &router.meta, a as usize, landmark, dim)).then(a.cmp(&b)));
                cell.truncate(8);
            }
        }
        router
    }

    pub fn directory_sizes(&self) -> (usize, usize) {
        (self.landmarks.len(), self.coarse.len())
    }

    #[cfg(test)]
    pub fn query_seeds(
        &self, store: &Bq2Store, signature: &Bq2Signature,
        sm: SmCodeParams, depth: f64, dim: usize, width: usize,
    ) -> Vec<u32> {
        self.query_seeds_budgeted(store, signature, sm, depth, dim, width, usize::MAX, 1.0)
    }

    pub fn query_seeds_budgeted(
        &self, store: &Bq2Store, signature: &Bq2Signature,
        sm: SmCodeParams, depth: f64, dim: usize, width: usize,
        max_visits: usize, curvature: f64,
    ) -> Vec<u32> {
        let seed_cap = (width / 2).min(max_visits / 4);
        if seed_cap == 0 { return Vec::new(); }
        let mut considered = vec![false; self.landmarks.len()];
        let mut cones = Vec::new();
        let mut evaluate = |cone: usize| {
            if !considered[cone] {
                considered[cone] = true;
                cones.push((query_cosine(store, &self.meta, self.landmarks[cone] as usize, signature, sm, dim), cone));
            }
        };
        if self.coarse.is_empty() {
            for c in 0..self.landmarks.len() { evaluate(c); }
        } else {
            let mut coarse_scores: Vec<_> = (0..self.coarse.len()).map(|c|
                (query_cosine(store, &self.meta, self.landmarks[c] as usize, signature, sm, dim), c)).collect();
            coarse_scores.sort_unstable_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
            for &(_, c) in coarse_scores.iter().take(8) {
                evaluate(c);
                for &fine in &self.coarse[c] { evaluate(fine as usize); }
            }
        }
        cones.sort_unstable_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
        let mut seeds = self.hubs.clone();
        for &(cosine, cone) in cones.iter().take((width / 2).clamp(8, 80)) {
            let apex = (depth.tanh() * cosine.max(0.0)).clamp(0.0, 1.0 - f64::EPSILON)
                .atanh().clamp(self.min_depth as f64, self.max_depth as f64);
            let apex_band = self.band(apex as f32);
            let query_band = self.band(depth as f32);
            for band in 0usize..8 {
                if band.abs_diff(apex_band) > 1 && band.abs_diff(query_band) > 1 { continue; }
                for &node in &self.cells[cone * 8 + band] {
                    if !seeds.contains(&node) { seeds.push(node); }
                }
            }
        }
        let query = PolarPoint::new(depth, curvature).expect("validated query geometry");
        let mut ranked: Vec<_> = seeds.into_iter().map(|node| {
            let meta = self.meta[node as usize];
            let point = PolarPoint { radius: meta.radius as f64, factor: meta.boundary_factor as f64, depth: meta.depth as f64 };
            let cosine = query_cosine(store, &self.meta, node as usize, signature, sm, dim);
            (query.proxy(point, cosine), node)
        }).collect();
        ranked.sort_unstable_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        ranked.into_iter().take(seed_cap).map(|(_, node)| node).collect()
    }
}