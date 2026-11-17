//! Protected spanning-tree repair for the production warped navigation graph.
//! Adapted from Pelorus (Apache-2.0), Copyright 2024 TriviumDB Authors.
use super::{invalid, io};
use std::collections::VecDeque;

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
    // Consider every reachable host before rejecting a repair.
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
        assert!(graph[0].contains(&1) && graph[0].contains(&2));
        let mut reached = vec![false; 5];
        let mut queue = VecDeque::from([0]);
        reached[0] = true;
        while let Some(u) = queue.pop_front() {
            for &v in &graph[u] {
                if !reached[v as usize] { reached[v as usize] = true; queue.push_back(v as usize); }
            }
        }
        assert!(reached.iter().all(|&v| v));
        for node in 0..5 { assert!(graph.iter().any(|row| row.contains(&node))); }
    }

    #[test]
    fn impossible_repair_reports_failure_instead_of_overfilling() {
        let mut graph = vec![vec![1], vec![], vec![]];
        assert!(repair(&mut graph, 0, &[0, 1, 2], 0).is_err());
    }
}