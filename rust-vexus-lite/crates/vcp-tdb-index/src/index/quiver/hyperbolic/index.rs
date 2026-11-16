//! Immutable sidecar experiment, deliberately separate from production lifecycle.
use super::*;
use super::beam::{bounded_beam, BeamBudget};
use super::routing::{pair_cosine, planes, query_cosine, PolarRouter};
use crate::index::bq::Bq2Store;
use super::super::asymmetric::{AsymKernel, AsymQuerySm};

#[derive(Clone, Copy, Debug)]
pub struct HyperbolicConfig {
    pub curvature: f64,
    pub degree: usize,
    pub construction_width: usize,
    pub alpha: f64,
    pub landmarks: Option<usize>,
}
impl Default for HyperbolicConfig {
    fn default() -> Self {
        Self { curvature: 1.0, degree: 32, construction_width: 128, alpha: 1.2, landmarks: None }
    }
}
#[derive(Clone, Copy, Debug)]
pub struct HyperbolicSearchConfig {
    pub top_k: usize,
    pub width: usize,
    pub rerank_limit: usize,
    pub max_visits: usize,
    pub max_expansions: usize,
    pub radial_bound: bool,
}
#[derive(Default, Debug)]
pub struct HyperbolicSearchStats {
    pub visited: usize,
    pub expanded: usize,
    pub excluded_expanded: usize,
    pub visit_limit_reached: bool,
    pub expansion_limit_reached: bool,
    pub valid_candidates: usize,
    pub asymmetric_evals: usize,
    pub cold_reads: usize,
    pub radial_rejections: usize,
    pub seeds: usize,
    pub converged: bool,
}
#[derive(Debug)]
pub struct HyperbolicOutput {
    /// True geodesic distances, ascending; NOT cosine scores.
    pub neighbors: Vec<(u64, f64)>,
    pub stats: HyperbolicSearchStats,
}

/// Owns only BQ planes, polar metadata, IDs/slots and adjacency. No originals.
/// Immutable: changes require constructing and publishing a replacement.
pub struct HyperbolicIndex {
    dim: usize,
    ids: Vec<u64>,
    slots: Vec<usize>,
    store: Bq2Store,
    router: PolarRouter,
    graph: Vec<Vec<u32>>,
    config: HyperbolicConfig,
}
impl HyperbolicIndex {
    pub fn directory_sizes(&self) -> (usize, usize) { self.router.directory_sizes() }

    pub fn connectivity(&self) -> (usize, usize) {
        let n = self.ids.len();
        if n == 0 { return (0, 0); }
        let mut seen = vec![false; n];
        let mut incoming = vec![0usize; n];
        for row in &self.graph { for &node in row { incoming[node as usize] += 1; } }
        let entry = self.router.hubs[0] as usize;
        let mut queue = std::collections::VecDeque::from([entry]);
        seen[entry] = true;
        while let Some(node) = queue.pop_front() {
            for &next in &self.graph[node] {
                if !seen[next as usize] { seen[next as usize] = true; queue.push_back(next as usize); }
            }
        }
        (seen.into_iter().filter(|&v| v).count(), incoming.into_iter().filter(|&v| v == 0).count())
    }

    #[cfg(feature = "ablation")]
    pub fn approximate_cosines(&self, query: &[f32]) -> io::Result<Vec<(u64, f64)>> {
        if query.len() != self.dim { return Err(invalid("diagnostic query dimension")); }
        let asym = AsymQuerySm::encode(query)?;
        Ok(self.ids.iter().enumerate().map(|(node, &id)| {
            let (p, h) = planes(&self.store, node);
            (id, asym.calibrated_cosine(p, h, self.router.meta[node].sm(), AsymKernel::Auto))
        }).collect())
    }

    pub fn build<F>(
        dim: usize, ids: &[u64], slots: &[usize], depths: &[f32],
        config: HyperbolicConfig, mut fill: F,
    ) -> io::Result<Self>
    where F: FnMut(usize, &mut Vec<f32>) -> bool {
        IndexMetric::Poincare { curvature: config.curvature }.validate()?;
        if dim == 0 || dim > crate::index::bq::MAX_BQ_DIM || ids.len() != slots.len()
            || ids.len() != depths.len() || ids.len() > u32::MAX as usize
            || config.degree < 2 || config.construction_width == 0
            || !config.alpha.is_finite() || config.alpha < 1.0
            || ids.iter().any(|&id| id == 0)
            || ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len()
            || slots.iter().collect::<std::collections::HashSet<_>>().len() != slots.len()
        { return Err(invalid("invalid hyperbolic build contract")); }
        // Validate all geometry before any source I/O.
        let points = depths.iter().map(|&d| PolarPoint::new(d as f64, config.curvature))
            .collect::<io::Result<Vec<_>>>()?;
        let mut store = Bq2Store::new(dim);
        store.reserve(ids.len());
        let mut meta = Vec::with_capacity(ids.len());
        let mut buffer = Vec::with_capacity(dim);
        for (&slot, point) in slots.iter().zip(points) {
            buffer.clear();
            if !fill(slot, &mut buffer) || buffer.len() != dim {
                return Err(invalid("cannot read original direction during build"));
            }
            let (header, signature) = PolarNodeMeta::encode(&buffer, point)?;
            store.push_sig(&signature);
            meta.push(header);
        }
        drop(buffer);
        let router = PolarRouter::build_with_landmarks(&store, meta, dim, config.landmarks);
        let mut index = Self { dim, ids: ids.to_vec(), slots: slots.to_vec(), store, router,
            graph: vec![Vec::new(); ids.len()], config };
        let mut order: Vec<u32> = (0..ids.len() as u32).collect();
        order.sort_unstable_by(|&a, &b| depths[a as usize].total_cmp(&depths[b as usize]).then(a.cmp(&b)));
        for &node in &order {
            let sig = index.store.get_sig(node as usize);
            let sm = index.router.meta[node as usize].sm();
            let depth = depths[node as usize] as f64;
            let seeds = index.router.query_seeds_budgeted(&index.store, &sig, sm, depth, dim,
                config.construction_width, config.construction_width.saturating_mul(32).min(ids.len()), config.curvature);
            let beam = bounded_beam(ids.len(), &seeds,
                BeamBudget { width: config.construction_width,
                    max_visits: config.construction_width.saturating_mul(32).min(ids.len()),
                    max_expansions: config.construction_width.saturating_mul(8).min(ids.len()) },
                |n| &index.graph[n as usize],
                |n| (index.proxy(node, n), 1.0 - index.cosine(node, n)
                    + 0.30 * (depth - depths[n as usize] as f64).abs()),
                |n| n != node);
            let mut pool = beam.candidates;
            pool.extend(seeds.into_iter().filter(|&n| n != node));
            // Deterministic bounded random coverage, matching upstream intent.
            for s in 0..16usize {
                let candidate = ((node as usize).wrapping_mul(7919).wrapping_add(s * 104729)) % ids.len().max(1);
                if candidate != node as usize { pool.push(candidate as u32); }
            }
            index.graph[node as usize] = index.prune(node, pool);
            let selected = index.graph[node as usize].clone();
            for neighbor in selected {
                let mut reverse = index.graph[neighbor as usize].clone();
                reverse.push(node);
                index.graph[neighbor as usize] = index.prune(neighbor, reverse);
            }
        }
        if let Some(&entry) = index.router.hubs.first() {
            construction::repair(&mut index.graph, entry, &order, config.degree)?;
        }
        Ok(index)
    }

    fn cosine(&self, a: u32, b: u32) -> f64 {
        pair_cosine(&self.store, &self.router.meta, a as usize, b as usize, self.dim)
    }
    fn proxy(&self, a: u32, b: u32) -> f64 {
        if a == b { return 0.0; }
        let ma = self.router.meta[a as usize];
        let mb = self.router.meta[b as usize];
        let pa = PolarPoint { radius: ma.radius as f64, factor: ma.boundary_factor as f64, depth: ma.depth as f64 };
        let pb = PolarPoint { radius: mb.radius as f64, factor: mb.boundary_factor as f64, depth: mb.depth as f64 };
        pa.proxy(pb, self.cosine(a, b))
    }
    fn prune(&self, target: u32, mut pool: Vec<u32>) -> Vec<u32> {
        pool.sort_unstable();
        pool.dedup();
        pool.retain(|&n| n != target);
        pool.sort_unstable_by(|&a, &b| self.proxy(target, a).total_cmp(&self.proxy(target, b)).then(a.cmp(&b)));
        construction::quadri_prune(target, &pool, self.config.degree, self.config.alpha,
            &self.router.meta, self.config.curvature, |a, b| self.proxy(a, b), |a, b| 1.0 - self.cosine(a, b))
    }

    pub fn hot_bytes(&self) -> usize {
        self.store.hot_bytes() + self.router.meta.len() * 32
            + self.ids.len() * 8 + self.slots.len() * std::mem::size_of::<usize>()
            + self.graph.iter().map(|row| row.capacity() * 4 + std::mem::size_of::<Vec<u32>>()).sum::<usize>()
            + self.router.hot_bytes_without_meta()
    }

    pub fn search<F, E>(
        &self, query: &[f32], depth: f32, config: HyperbolicSearchConfig,
        exclude: E, mut fill: F,
    ) -> io::Result<HyperbolicOutput>
    where F: FnMut(usize, &mut Vec<f32>) -> bool, E: Fn(u64) -> bool {
        if query.len() != self.dim || config.width == 0 || config.rerank_limit < config.top_k {
            return Err(invalid("invalid hyperbolic query controls"));
        }
        let point = PolarPoint::new(depth as f64, self.config.curvature)?;
        let (qmeta, sig) = PolarNodeMeta::encode(query, point)?;
        if config.top_k == 0 || self.ids.is_empty() {
            return Ok(HyperbolicOutput { neighbors: Vec::new(), stats: HyperbolicSearchStats::default() });
        }
        let seeds = self.router.query_seeds_budgeted(&self.store, &sig, qmeta.sm(), depth as f64,
            self.dim, config.width, config.max_visits, self.config.curvature);
        let beam = bounded_beam(self.ids.len(), &seeds,
            BeamBudget { width: config.width, max_visits: config.max_visits, max_expansions: config.max_expansions },
            |node| &self.graph[node as usize],
            |node| {
                let m = self.router.meta[node as usize];
                let cos = query_cosine(&self.store, &self.router.meta, node as usize, &sig, qmeta.sm(), self.dim);
                let p = PolarPoint { radius: m.radius as f64, factor: m.boundary_factor as f64, depth: m.depth as f64 };
                (point.proxy(p, cos), 1.0 - cos + 0.20 * (point.depth - p.depth).abs())
            },
            |node| !exclude(self.ids[node as usize]));
        let mut stats = HyperbolicSearchStats {
            visited: beam.stats.visited, expanded: beam.stats.expanded,
            excluded_expanded: beam.stats.excluded_expanded,
            visit_limit_reached: beam.stats.visit_limit_reached,
            expansion_limit_reached: beam.stats.expansion_limit_reached,
            valid_candidates: beam.candidates.len(), seeds: seeds.len(), converged: beam.stats.converged,
            ..Default::default()
        };
        let asym = AsymQuerySm::encode(query)?;
        let mut pool: Vec<_> = beam.candidates.into_iter().map(|node| {
            let (p, h) = planes(&self.store, node as usize);
            let meta = self.router.meta[node as usize];
            let cosine = asym.calibrated_cosine(p, h, meta.sm(), AsymKernel::Auto);
            let p = PolarPoint { radius: meta.radius as f64, factor: meta.boundary_factor as f64, depth: meta.depth as f64 };
            (point.proxy(p, cosine), node)
        }).collect();
        stats.asymmetric_evals = pool.len();
        pool.sort_unstable_by(|a, b| a.0.total_cmp(&b.0).then(self.ids[a.1 as usize].cmp(&self.ids[b.1 as usize])));
        let mut row = Vec::with_capacity(self.dim);
        let mut exact: Vec<(u64, f64)> = Vec::new();
        for (_, node) in pool.into_iter().take(config.rerank_limit) {
            let meta = self.router.meta[node as usize];
            if config.radial_bound && exact.len() >= config.top_k {
                let worst = exact.last().unwrap().1;
                if meta.radial_lower_bound(point) > worst {
                    stats.radial_rejections += 1;
                    continue;
                }
            }
            row.clear();
            stats.cold_reads += 1;
            if !fill(self.slots[node as usize], &mut row) { continue; }
            let proxy = exact_proxy(query, point, &row, meta.exact_point(self.config.curvature)?)?;
            exact.push((self.ids[node as usize], proxy));
            exact.sort_unstable_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
            exact.truncate(config.top_k);
        }
        for (_, proxy) in &mut exact { *proxy = geodesic_distance(*proxy, self.config.curvature); }
        Ok(HyperbolicOutput { neighbors: exact, stats })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(node: usize, dim: usize) -> Vec<f32> {
        (0..dim).map(|j| ((node * 71 + j * 17 + 1) as f32 * 0.37).sin()).collect()
    }

    #[test]
    fn streamed_sidecar_exact_truth_unique_reads_and_excluded_hubs() {
        for dim in [384, 768, 3072] {
            let n = 48usize;
            let ids: Vec<u64> = (1..=n as u64).collect();
            let slots: Vec<usize> = (0..n).map(|i| 10 + 3 * i).collect();
            let depths: Vec<f32> = (0..n).map(|i| 0.35 + 2.85 * i as f32 / (n - 1) as f32).collect();
            let mut build_reads = 0;
            let index = HyperbolicIndex::build(dim, &ids, &slots, &depths,
                HyperbolicConfig { degree: 12, construction_width: 64, ..Default::default() },
                |slot, out| {
                    build_reads += 1;
                    *out = row((slot - 10) / 3, dim);
                    true
                }).unwrap();
            assert_eq!(build_reads, n);
            let query = row(35, dim);
            let config = HyperbolicSearchConfig {
                top_k: 10, width: n, rerank_limit: n,
                max_visits: n, max_expansions: n, radial_bound: false,
            };
            let mut reads = std::collections::HashSet::new();
            let output = index.search(&query, depths[35], config, |id| id <= 16,
                |slot, out| {
                    assert!(slot >= slots[16], "excluded hubs must never read cold");
                    assert!(reads.insert(slot), "each source slot is read at most once");
                    *out = row((slot - 10) / 3, dim);
                    true
                }).unwrap();
            assert_eq!(output.stats.cold_reads, reads.len());
            assert_eq!(reads.len(), n - 16);
            assert_eq!(output.stats.excluded_expanded, 16);
            let qp = PolarPoint::new(depths[35] as f64, 1.0).unwrap();
            let mut truth: Vec<_> = (16..n).map(|i| {
                let proxy = exact_proxy(&query, qp, &row(i, dim),
                    PolarPoint::new(depths[i] as f64, 1.0).unwrap()).unwrap();
                (ids[i], geodesic_distance(proxy, 1.0))
            }).collect();
            truth.sort_unstable_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
            truth.truncate(10);
            assert_eq!(output.neighbors, truth);

            let none = index.search(&query, depths[35], config, |_| true,
                |_, _| panic!("all excluded must read zero originals")).unwrap();
            assert!(none.neighbors.is_empty());
            assert_eq!(none.stats.cold_reads, 0);
            assert_eq!(none.stats.visited, n);
            let capped = index.search(&query, depths[35],
                HyperbolicSearchConfig { max_visits: 7, max_expansions: 3, ..config },
                |_| true, |_, _| panic!("excluded")).unwrap();
            assert!(capped.stats.visited <= 7);
            assert!(capped.stats.expanded <= 3);
            assert!(capped.stats.visit_limit_reached);
        }
    }
}