//! Pelorus 98136b2, Apache-2.0. Copyright 2024 TriviumDB Authors.
//! Hot-only wave construction; protected bounded-degree repair.
use rayon::prelude::*;
use std::cmp::{Ordering, Reverse};
use std::collections::BinaryHeap;
#[derive(Clone, Copy, PartialEq)]
struct OrdDist(f64);

impl Eq for OrdDist {}

impl PartialOrd for OrdDist {
    #[inline]
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for OrdDist {
    #[inline]
    fn cmp(&self, other: &Self) -> Ordering {
        self.0.total_cmp(&other.0)
    }
}
/// 确定性 PCG/LCG 伪随机数生成器，用于独立可复现的合成数据集生成。
struct DetRng(u64);

impl DetRng {
    fn new(seed: u64) -> Self {
        Self(seed | 1)
    }

    #[inline]
    fn next_u64(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0
    }

}
#[inline(always)]
fn visit_check_set(words: &mut [u64], idx: usize) -> bool {
    let word = &mut words[idx >> 6];
    let mask = 1u64 << (idx & 63);
    let was = (*word & mask) != 0;
    *word |= mask;
    was
}

/// 黎曼四向罗盘剪枝几何上下文（提供多径向 Stem-Excess 下界与纯球面角度损失）。
pub(super) struct QuadriPruneSpec<'a> {
    pub(super) depths: &'a [f64],
    pub(super) radial_dist_fn: &'a (dyn Fn(usize, usize) -> f64 + Sync),
    pub(super) angular_loss_fn: &'a (dyn Fn(usize, usize) -> f64 + Sync),
    pub(super) iso_tol: f64,
    pub(super) elev_min: f64,
    pub(super) elev_step: f64,
    pub(super) geo_fraction: f64,
    pub(super) ang_guard_delta: f64,
    pub(super) elev_ang_delta: f64,
    pub(super) iso_score_uses_geodesic: bool,
    pub(super) bridge_cap: usize,
}

/// 通用 L0 单层导航图。
pub struct VarGraph {
    pub neighbors: Vec<Vec<u32>>,
}

impl VarGraph {
    pub(super) fn build_with_quadri<F>(
        n: usize,
        m_max: usize,
        ef_construction: usize,
        alpha: f64,
        entry_points: Vec<u32>,
        dist_fn: F,
        quadri: Option<&QuadriPruneSpec<'_>>,
    ) -> std::io::Result<Self>
    where
        F: Fn(usize, usize) -> f64 + Sync,
    {
        if n == 0 {
            return Ok(Self {
                neighbors: Vec::new(),
            });
        }

        let entries: Vec<u32> = if entry_points.is_empty() {
            vec![0]
        } else {
            entry_points
        };

        // Deterministic bounded-degree random skeleton. Connectivity is NOT
        // guaranteed here; the protected repair below enforces the postcondition.
        let mut order: Vec<usize> = (0..n).collect();
        let mut rng = DetRng::new(0x5EED_CAFE);
        for i in (1..n).rev() {
            let j = (rng.next_u64() as usize) % (i + 1);
            order.swap(i, j);
        }
        let deg_init = m_max.min(n - 1);
        let mut adj: Vec<Vec<u32>> = (0..n)
            .map(|u| {
                let mut edges = Vec::with_capacity(deg_init);
                let mut attempts = 0usize;
                while edges.len() < deg_init && attempts < deg_init * 4 {
                    let cand = (rng
                        .next_u64()
                        .wrapping_add((u as u64).wrapping_mul(2654435761))
                        % (n as u64)) as usize;
                    attempts += 1;
                    if cand != u && !edges.contains(&(cand as u32)) {
                        edges.push(cand as u32);
                    }
                }
                edges
            })
            .collect();

        // 增量波次在随机骨架上做局部到全局平滑细化（α = 1.0 + 双向回插）
        let mut cursor = 0usize;
        let mut batch_cap = 1024usize;
        while cursor < n {
            let end = (cursor + batch_cap).min(n);
            let batch = &order[cursor..end];
            let updates: Vec<(usize, Vec<u32>)> = batch
                .par_iter()
                .map(|&node| {
                    let local_seeds = &adj[node][..adj[node].len().min(4)];
                    let mut cands = beam_collect_internal(
                        &adj,
                        &entries,
                        local_seeds,
                        ef_construction,
                        n,
                        Some(node),
                        |other| dist_fn(node, other),
                    );
                    for &nb in &adj[node] {
                        if nb as usize != node {
                            cands.push((OrdDist(dist_fn(node, nb as usize)), nb));
                        }
                    }
                    cands.sort_unstable_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
                    cands.dedup_by_key(|x| x.1);
                    let pruned = prune_dispatch(node, &cands, m_max, 1.0, &dist_fn, quadri);
                    (node, pruned)
                })
                .collect();

            let mut touched: Vec<(usize, Vec<u32>)> = Vec::new();
            for (node, list) in updates {
                for &nb in &list {
                    touched.push((nb as usize, vec![node as u32]));
                }
                adj[node] = list;
            }
            // 按目标节点聚合反向边
            touched.sort_unstable_by_key(|x| x.0);
            let mut reverse_groups: Vec<(usize, Vec<u32>)> = Vec::new();
            for (dst, srcs) in touched {
                if let Some(last) = reverse_groups.last_mut()
                    && last.0 == dst
                {
                    last.1.extend_from_slice(&srcs);
                } else {
                    reverse_groups.push((dst, srcs));
                }
            }
            let rev_pruned: Vec<(usize, Vec<u32>)> = reverse_groups
                .into_par_iter()
                .map(|(v, srcs)| {
                    let mut merged = adj[v].clone();
                    merged.extend_from_slice(&srcs);
                    merged.sort_unstable();
                    merged.dedup();
                    if merged.len() <= m_max {
                        return (v, merged);
                    }
                    let mut cands: Vec<(OrdDist, u32)> = merged
                        .into_iter()
                        .filter(|&x| x as usize != v)
                        .map(|x| (OrdDist(dist_fn(v, x as usize)), x))
                        .collect();
                    cands.sort_unstable_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
                    let pruned = prune_dispatch(v, &cands, m_max, 1.0, &dist_fn, quadri);
                    (v, pruned)
                })
                .collect();
            for (v, list) in rev_pruned {
                adj[v] = list;
            }
            cursor = end;
            batch_cap = (batch_cap * 2).min(8_192);
        }

        // Pass 2：全图成型后以 α 做一次全局并行细化 + 双向回插
        let next_lists: Vec<Vec<u32>> = (0..n)
            .into_par_iter()
            .map(|node| {
                let local_seeds = &adj[node][..adj[node].len().min(4)];
                let mut cands = beam_collect_internal(
                    &adj,
                    &entries,
                    local_seeds,
                    ef_construction,
                    n,
                    Some(node),
                    |other| dist_fn(node, other),
                );
                for &nb in &adj[node] {
                    if nb as usize != node {
                        cands.push((OrdDist(dist_fn(node, nb as usize)), nb));
                    }
                }
                cands.sort_unstable_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
                cands.dedup_by_key(|x| x.1);
                prune_dispatch(node, &cands, m_max, alpha, &dist_fn, quadri)
            })
            .collect();
        adj = next_lists;

        let mut reverse_buckets: Vec<Vec<u32>> = vec![Vec::new(); n];
        for (u, nbs) in adj.iter().enumerate() {
            for &v in nbs {
                reverse_buckets[v as usize].push(u as u32);
            }
        }
        adj = (0..n)
            .into_par_iter()
            .map(|node| {
                let mut merged = adj[node].clone();
                merged.extend_from_slice(&reverse_buckets[node]);
                merged.sort_unstable();
                merged.dedup();
                if merged.len() <= m_max {
                    return merged;
                }
                let mut cands: Vec<(OrdDist, u32)> = merged
                    .into_iter()
                    .filter(|&v| v as usize != node)
                    .map(|v| (OrdDist(dist_fn(node, v as usize)), v))
                    .collect();
                cands.sort_unstable_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
                prune_dispatch(node, &cands, m_max, alpha, &dist_fn, quadri)
            })
            .collect();

        super::connectivity::repair(&mut adj, entries[0], &(0..n as u32).collect::<Vec<_>>(), m_max)?;

        Ok(Self {
            neighbors: adj,
        })
    }
}
fn beam_collect_internal<F>(
    adj: &[Vec<u32>],
    seeds: &[u32],
    extra_seeds: &[u32],
    ef: usize,
    n: usize,
    skip_node: Option<usize>,
    dist_fn: F,
) -> Vec<(OrdDist, u32)>
where
    F: Fn(usize) -> f64,
{
    let mut visited = vec![0u64; n.div_ceil(64)];
    if let Some(sk) = skip_node
        && sk < n
    {
        visit_check_set(&mut visited, sk);
    }
    let mut candidates: BinaryHeap<Reverse<(OrdDist, u32)>> = BinaryHeap::with_capacity(ef * 2);
    let mut results: BinaryHeap<(OrdDist, u32)> = BinaryHeap::with_capacity(ef + 1);
    for &seed in seeds.iter().chain(extra_seeds.iter()) {
        let s = seed as usize;
        if s < n && !visit_check_set(&mut visited, s) {
            let d = OrdDist(dist_fn(s));
            candidates.push(Reverse((d, seed)));
            results.push((d, seed));
            if results.len() > ef {
                results.pop();
            }
        }
    }
    while let Some(Reverse((cand_d, cur))) = candidates.pop() {
        if results.len() >= ef && cand_d > results.peek().unwrap().0 {
            break;
        }
        for &nb in &adj[cur as usize] {
            let ni = nb as usize;
            if visit_check_set(&mut visited, ni) {
                continue;
            }
            let d = OrdDist(dist_fn(ni));
            if results.len() < ef || d < results.peek().unwrap().0 {
                candidates.push(Reverse((d, nb)));
                results.push((d, nb));
                if results.len() > ef {
                    results.pop();
                }
            }
        }
    }
    let mut out = results.into_vec();
    out.sort_unstable_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    out
}

fn prune_dispatch<F>(
    target: usize,
    candidates: &[(OrdDist, u32)],
    limit: usize,
    alpha: f64,
    dist_fn: &F,
    quadri: Option<&QuadriPruneSpec<'_>>,
) -> Vec<u32>
where
    F: Fn(usize, usize) -> f64,
{
    if let Some(spec) = quadri {
        quadri_prune_candidates(target, candidates, limit, alpha, dist_fn, spec)
    } else {
        prune_candidates(target, candidates, limit, alpha * alpha, dist_fn)
    }
}

/// 广义四向黎曼罗盘剪枝（Stem-Excess 测地主干 + 等深球面环 + 双向径向升降梯 + 补边）。
fn quadri_prune_candidates<F>(
    target: usize,
    candidates: &[(OrdDist, u32)],
    limit: usize,
    alpha: f64,
    dist_fn: &F,
    spec: &QuadriPruneSpec<'_>,
) -> Vec<u32>
where
    F: Fn(usize, usize) -> f64,
{
    let geo_limit = (((limit as f64) * spec.geo_fraction).round() as usize).clamp(1, limit);
    let alpha_sq = alpha * alpha;
    let depth_t = spec.depths[target];
    let elev_dom = spec.elev_min * 0.5;
    let mut selected: Vec<(u32, f64)> = Vec::with_capacity(limit);

    // 1. 测地纤维主干配额（Stem-Excess 消去共享径向干细胞遮蔽 + 球面角单调过滤）
    for &(OrdDist(d_sq), cand) in candidates {
        let ci = cand as usize;
        if ci == target {
            continue;
        }
        if selected.len() >= geo_limit {
            break;
        }
        let d_tc = d_sq.max(0.0).sqrt();
        let r_tc = (spec.radial_dist_fn)(target, ci);
        let ang_tc = (spec.angular_loss_fn)(target, ci);
        let occluded = selected.iter().any(|&(sel, _)| {
            let si = sel as usize;
            let ang_sc = (spec.angular_loss_fn)(ci, si);
            if ang_sc > ang_tc {
                return false;
            }
            let r_sc = (spec.radial_dist_fn)(si, ci);
            let stem_excess = (r_tc - r_sc).max(0.0);
            let eff_target = (d_tc - stem_excess).max(0.0);
            if alpha * r_sc > eff_target {
                return false;
            }
            alpha_sq * dist_fn(ci, si) <= eff_target * eff_target
        });
        if !occluded {
            selected.push((cand, spec.depths[ci]));
        }
    }

    // 紧致单空间残差锥簇下已由全配额 Stem-Excess 测地主干涵盖，仅需测地保底补边；连续各向同性或多块乘积流形启用等深环与双向升降梯
    if selected.len() < limit && spec.geo_fraction < 0.999 {
        struct PoolItem {
            ang_tc: f64,
            rad_tc: f64,
            d_tc: f64,
            d_sq: f64,
            cand: u32,
            depth_c: f64,
        }
        let mut pool: Vec<PoolItem> = Vec::with_capacity(candidates.len());
        let mut min_ang = f64::INFINITY;
        for &(OrdDist(d_sq), cand) in candidates {
            let ci = cand as usize;
            if ci == target || selected.iter().any(|&(s, _)| s == cand) {
                continue;
            }
            let ang_tc = (spec.angular_loss_fn)(target, ci);
            if ang_tc < min_ang {
                min_ang = ang_tc;
            }
            pool.push(PoolItem {
                ang_tc,
                rad_tc: (spec.radial_dist_fn)(target, ci),
                d_tc: d_sq.max(0.0).sqrt(),
                d_sq,
                cand,
                depth_c: spec.depths[ci],
            });
        }
        let ang_guard = min_ang + spec.ang_guard_delta;

        // 2a. 共形/等深极限球面环（Horosphere / Iso-Shell Ring）
        let iso_local_target = if spec.bridge_cap > 0 {
            ((limit * 3) / 4).max(selected.len()).min(limit)
        } else {
            ((limit * 7) / 8).max(selected.len()).min(limit)
        };
        pool.sort_unstable_by(|a, b| {
            let (sa, sb) = if spec.iso_score_uses_geodesic {
                (a.ang_tc + 0.08 * a.d_tc, b.ang_tc + 0.08 * b.d_tc)
            } else {
                (a.ang_tc + 0.45 * a.rad_tc, b.ang_tc + 0.45 * b.rad_tc)
            };
            sa.total_cmp(&sb)
                .then_with(|| a.d_sq.total_cmp(&b.d_sq))
                .then_with(|| a.cand.cmp(&b.cand))
        });
        let is_iso_occluded = |ci: usize, ang_tc: f64, selected: &[(u32, f64)]| -> bool {
            selected.iter().any(|&(nb, _)| {
                (spec.radial_dist_fn)(nb as usize, ci) <= spec.iso_tol
                    && alpha_sq * (spec.angular_loss_fn)(ci, nb as usize) <= ang_tc
            })
        };
        for item in &pool {
            if selected.len() >= iso_local_target {
                break;
            }
            if item.ang_tc > ang_guard {
                continue;
            }
            if !is_iso_occluded(item.cand as usize, item.ang_tc, &selected) {
                selected.push((item.cand, item.depth_c));
            }
        }

        // 2b. 可选多块乘积跨聚簇角桥（严格按 bridge_cap 封顶，防孤立聚簇困死）
        if spec.bridge_cap > 0 {
            let iso_bridge_target = (selected.len() + spec.bridge_cap)
                .min(((limit * 7) / 8).max(selected.len()))
                .min(limit);
            for item in &pool {
                if selected.len() >= iso_bridge_target {
                    break;
                }
                if selected.iter().any(|&(s, _)| s == item.cand) {
                    continue;
                }
                if !is_iso_occluded(item.cand as usize, item.ang_tc, &selected) {
                    selected.push((item.cand, item.depth_c));
                }
            }
        }

        // 3. 双向径向升降梯（向内 + 向外各自半数残余名额）
        let rem = limit.saturating_sub(selected.len());
        let elev_ang_guard = min_ang + spec.elev_ang_delta;
        if rem > 0 {
            let inward_target = selected.len() + rem / 2;
            for &(is_outward, target_len) in &[(false, inward_target), (true, limit)] {
                let signed_gap = |d_c: f64| {
                    if is_outward {
                        d_c - depth_t
                    } else {
                        depth_t - d_c
                    }
                };
                pool.sort_unstable_by(|a, b| {
                    let sa = a.ang_tc + 0.15 * (signed_gap(a.depth_c) - spec.elev_step).abs();
                    let sb = b.ang_tc + 0.15 * (signed_gap(b.depth_c) - spec.elev_step).abs();
                    sa.total_cmp(&sb)
                        .then_with(|| a.d_sq.total_cmp(&b.d_sq))
                        .then_with(|| a.cand.cmp(&b.cand))
                });
                for item in &pool {
                    if selected.len() >= target_len {
                        break;
                    }
                    let valid_shell = if is_outward {
                        item.depth_c > depth_t + spec.elev_min
                    } else {
                        item.depth_c < depth_t - spec.elev_min
                    };
                    if item.ang_tc > elev_ang_guard
                        || !valid_shell
                        || selected.iter().any(|&(s, _)| s == item.cand)
                    {
                        continue;
                    }
                    let ci = item.cand as usize;
                    let occluded = selected.iter().any(|&(nb, d_nb)| {
                        let dom_shell = if is_outward {
                            d_nb > depth_t + elev_dom
                        } else {
                            d_nb < depth_t - elev_dom
                        };
                        dom_shell
                            && alpha_sq * (spec.angular_loss_fn)(ci, nb as usize) <= item.ang_tc
                    });
                    if !occluded {
                        selected.push((item.cand, item.depth_c));
                    }
                }
            }
        }
    }

    // 4. 测地近邻保底补满至 limit
    if selected.len() < limit {
        for &(OrdDist(_), cand) in candidates {
            if selected.len() >= limit {
                break;
            }
            let ci = cand as usize;
            if ci != target && !selected.iter().any(|&(s, _)| s == cand) {
                selected.push((cand, spec.depths[ci]));
            }
        }
    }

    selected.into_iter().map(|(c, _)| c).collect()
}

fn prune_candidates<F>(
    target: usize,
    candidates: &[(OrdDist, u32)],
    limit: usize,
    alpha_eff: f64,
    dist_fn: &F,
) -> Vec<u32>
where
    F: Fn(usize, usize) -> f64,
{
    let mut selected: Vec<u32> = Vec::with_capacity(limit);
    for &(OrdDist(d), cand) in candidates {
        let ci = cand as usize;
        if ci == target {
            continue;
        }
        if selected.len() >= limit {
            break;
        }
        let occluded = selected
            .iter()
            .any(|&sel| dist_fn(ci, sel as usize) * alpha_eff < d);
        if !occluded {
            selected.push(cand);
        }
    }
    if selected.len() < limit {
        for &(OrdDist(_), cand) in candidates {
            if selected.len() >= limit {
                break;
            }
            if cand as usize != target && !selected.contains(&cand) {
                selected.push(cand);
            }
        }
    }
    selected
}
