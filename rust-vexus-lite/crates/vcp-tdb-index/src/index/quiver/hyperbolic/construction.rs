//! QuadriPrune and protected spanning-tree repair.
//! Adapted from Pelorus (Apache-2.0), Copyright 2024 TriviumDB Authors.
use super::*;
use std::collections::VecDeque;

/// All callbacks consume hot codes only. Candidates must be unique and sorted
/// by proxy, then node id. Geodesic ratios use actual dimensionless distances.
pub(crate) fn quadri_prune<P, A>(
    target: u32, candidates: &[u32], limit: usize, alpha: f64,
    meta: &[PolarNodeMeta], curvature: f64, proxy: P, angular: A,
) -> Vec<u32>
where P: Fn(u32, u32) -> f64, A: Fn(u32, u32) -> f64 {
    if limit == 0 { return Vec::new(); }
    let depth = |node: u32| meta[node as usize].depth as f64;
    let dt = depth(target);
    let mut selected = Vec::<u32>::with_capacity(limit);
    let distance = |a, b| geodesic_distance(proxy(a, b), curvature) * curvature.sqrt();
    for &candidate in candidates {
        if candidate == target || selected.len() >= (limit * 3 / 8).max(1) { continue; }
        let dc = depth(candidate);
        let target_distance = distance(target, candidate);
        let ac = angular(target, candidate);
        let dominated = selected.iter().any(|&neighbor| {
            if angular(candidate, neighbor) > ac { return false; }
            let dn = depth(neighbor);
            let excess = ((dt - dc).abs() - (dn - dc).abs()).max(0.0);
            let effective = (target_distance - excess).max(0.0);
            alpha * (dn - dc).abs() <= effective
                && alpha * distance(candidate, neighbor) <= effective
        });
        if !dominated { selected.push(candidate); }
    }
    let mut pool: Vec<u32> = candidates.iter().copied().filter(|&c| c != target && !selected.contains(&c)).collect();
    let sort_pool = |pool: &mut Vec<u32>, phase: usize| {
        let key = |node| {
            let d = depth(node);
            angular(target, node) + match phase {
                0 => 0.85 * (dt - d).abs(),
                1 => 0.15 * ((dt - d) - 0.65).abs(),
                2 => 0.15 * ((d - dt) - 0.65).abs(),
                _ => 0.25 * (dt - d).abs(),
            }
        };
        pool.sort_unstable_by(|&a, &b| key(a).total_cmp(&key(b))
            .then_with(|| proxy(target, a).total_cmp(&proxy(target, b))).then(a.cmp(&b)));
    };
    sort_pool(&mut pool, 0);
    let iso_target = (limit * 7 / 8).max(selected.len()).min(limit);
    for &candidate in &pool {
        if selected.len() >= iso_target { break; }
        let ac = angular(target, candidate);
        if !selected.iter().any(|&n| (depth(n) - depth(candidate)).abs() <= 0.60
            && alpha * angular(candidate, n) <= ac)
        { selected.push(candidate); }
    }
    let inward_target = selected.len() + limit.saturating_sub(selected.len()) / 2;
    for phase in 1..=3 {
        sort_pool(&mut pool, phase);
        let cap = if phase == 1 { inward_target } else { limit };
        for &candidate in &pool {
            if selected.len() >= cap { break; }
            if selected.contains(&candidate) { continue; }
            let dc = depth(candidate);
            if phase == 1 && dc >= dt - 0.18 || phase == 2 && dc <= dt + 0.18 { continue; }
            let ac = angular(target, candidate);
            let dominated = selected.iter().any(|&n| {
                let dn = depth(n);
                let same_region = match phase {
                    1 => dn < dt - 0.10,
                    2 => dn > dt + 0.10,
                    _ => (dn - dc).abs() <= 1.0,
                };
                same_region && alpha * angular(candidate, n) <= ac
            });
            if !dominated { selected.push(candidate); }
        }
    }
    for &candidate in &pool {
        if selected.len() >= limit { break; }
        if !selected.contains(&candidate) { selected.push(candidate); }
    }
    selected
}

/// Repair without losing any existing BFS-tree edge or the last incoming edge.
/// O(N + E) metadata, no cold vectors. Failure remains explicit and unpublished.
pub(crate) fn repair(
    graph: &mut [Vec<u32>], entry: u32, order: &[u32], degree_cap: usize,
) -> io::Result<()> {
    let n = graph.len();
    if n <= 1 { return Ok(()); }
    let missing = u32::MAX;
    let root = missing - 1;
    let mut indegree = vec![0usize; n];
    for (u, row) in graph.iter().enumerate() {
        if row.len() > degree_cap { return Err(invalid("graph degree exceeds repair budget")); }
        let mut seen = std::collections::HashSet::new();
        for &v in row {
            if v as usize >= n || v as usize == u || !seen.insert(v) {
                return Err(invalid("invalid adjacency before connectivity repair"));
            }
            indegree[v as usize] += 1;
        }
    }
    let mut parent = vec![missing; n];
    parent[entry as usize] = root;
    let mut queue = VecDeque::from([entry]);
    fn flood(graph: &[Vec<u32>], parent: &mut [u32], queue: &mut VecDeque<u32>) {
        while let Some(u) = queue.pop_front() {
            for &v in &graph[u as usize] {
                if parent[v as usize] == u32::MAX {
                    parent[v as usize] = u;
                    queue.push_back(v);
                }
            }
        }
    }
    flood(graph, &mut parent, &mut queue);
    // Unlike the upstream fixed 256-prefix fallback, consider every reachable
    // host before rejecting a repair. This favors correctness over build speed.
    for target in order.iter().copied().chain(std::iter::once(entry)) {
        if parent[target as usize] != missing && indegree[target as usize] > 0 { continue; }
        let mut chosen = None;
        for &host in order {
            if host == target || parent[host as usize] == missing || graph[host as usize].contains(&target) { continue; }
            let row = &graph[host as usize];
            if row.len() < degree_cap { chosen = Some((host, None)); break; }
            if let Some(slot) = (0..row.len()).rev().find(|&slot| {
                let old = row[slot];
                parent[old as usize] != host && indegree[old as usize] >= 2
            }) { chosen = Some((host, Some(slot))); break; }
        }
        let Some((host, slot)) = chosen else {
            return Err(invalid("cannot repair connectivity without violating protected edges"));
        };
        if let Some(slot) = slot {
            let old = graph[host as usize][slot];
            indegree[old as usize] -= 1;
            graph[host as usize][slot] = target;
        } else { graph[host as usize].push(target); }
        indegree[target as usize] += 1;
        if parent[target as usize] == missing {
            parent[target as usize] = host;
            queue.push_back(target);
            flood(graph, &mut parent, &mut queue);
        }
    }
    if parent.contains(&missing) || indegree.contains(&0) {
        return Err(invalid("connectivity repair failed its postcondition"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repair_preserves_tree_degree_and_every_incoming_edge() {
        let mut graph = vec![vec![1, 2], vec![2, 0], vec![0, 1], vec![4], vec![3]];
        repair(&mut graph, 0, &[0, 1, 2, 3, 4], 2).unwrap();
        assert!(graph.iter().all(|row| row.len() <= 2));
        // Initial BFS tree 0->1 and 0->2 must survive the chord exchange.
        assert!(graph[0].contains(&1) && graph[0].contains(&2));
        let mut parent = vec![false; 5];
        let mut queue = VecDeque::from([0]);
        parent[0] = true;
        while let Some(u) = queue.pop_front() {
            for &v in &graph[u] {
                if !parent[v as usize] { parent[v as usize] = true; queue.push_back(v as usize); }
            }
        }
        assert!(parent.iter().all(|&v| v));
        for node in 0..5 { assert!(graph.iter().any(|row| row.contains(&node))); }
    }

    #[test]
    fn impossible_repair_reports_failure_instead_of_overfilling() {
        let mut graph = vec![vec![1], vec![], vec![]];
        assert!(repair(&mut graph, 0, &[0, 1, 2], 0).is_err());
    }
}