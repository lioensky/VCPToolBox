//! Exclusion contracts, written before integrating hyperbolic geometry.
use super::*;

fn run(
    edges: &[Vec<u32>],
    seeds: &[u32],
    excluded: &[u32],
    width: usize,
    visits: usize,
    expansions: usize,
) -> BeamOutput {
    bounded_beam(
        edges.len(),
        seeds,
        BeamBudget { width, max_visits: visits, max_expansions: expansions },
        |node| &edges[node as usize],
        |node| (node as f64, node as f64),
        |node| !excluded.contains(&node),
    )
}

#[test]
fn excluded_previous_layer_hub_is_the_only_bridge_after_valid_pool_fills() {
    // Node 1 fills width=1 first. Worse-scored excluded node 2 must still
    // expand to expose the only path to node 3.
    let graph = vec![vec![1, 2], vec![], vec![3], vec![]];
    let out = bounded_beam(
        graph.len(), &[0],
        BeamBudget { width: 1, max_visits: 4, max_expansions: 4 },
        |node| &graph[node as usize],
        |node| { let loss = if node == 3 { -1.0 } else { node as f64 }; (loss, loss) },
        |node| node == 1 || node == 3,
    );
    assert_eq!(out.stats.visited, 4);
    assert_eq!(out.stats.excluded_expanded, 2);
    assert_eq!(out.stats.expanded, 4);
    assert_eq!(out.candidates, vec![3]);
}

#[test]
fn excluded_entry_and_all_router_seeds_remain_navigable() {
    let graph = vec![vec![2], vec![3], vec![], vec![]];
    let out = run(&graph, &[0, 1, 0], &[0, 1], 2, 4, 4);
    assert_eq!(out.candidates, vec![2, 3]);
    assert_eq!(out.stats.visited, 4);
    assert_eq!(out.stats.excluded_expanded, 2);
}

#[test]
fn cumulative_multilayer_exclusions_do_not_disconnect_the_tail() {
    let graph = vec![vec![1], vec![2], vec![3], vec![4], vec![]];
    for layer in 1..=4 {
        let excluded = (0..layer).collect::<Vec<_>>();
        let out = run(&graph, &[0], &excluded, 5, 5, 5);
        assert_eq!(out.candidates, (layer..5).collect::<Vec<_>>());
        assert_eq!(out.stats.visited, 5);
        assert_eq!(out.stats.excluded_expanded, layer as usize);
    }
}

#[test]
fn all_excluded_has_no_rerank_candidates_and_honors_independent_caps() {
    let graph = (0..20).map(|n| vec![(n + 1) % 20]).collect::<Vec<_>>();
    let excluded = (0..20).collect::<Vec<_>>();
    let out = run(&graph, &[0], &excluded, 2, 7, 20);
    assert!(out.candidates.is_empty());
    assert_eq!(out.stats.visited, 7);
    assert!(out.stats.visit_limit_reached);
    assert!(out.stats.expanded <= 7);
    let out = run(&graph, &[0], &excluded, 2, 20, 3);
    assert_eq!(out.stats.expanded, 3);
    assert!(out.stats.expansion_limit_reached);
    assert!(out.stats.visited <= 4);
}

#[test]
fn high_indegree_excluded_bridge_is_scored_and_expanded_only_once() {
    let mut graph = vec![vec![]; 12];
    graph[0] = (1..10).collect();
    for row in graph.iter_mut().take(10).skip(1) {
        row.push(10);
    }
    graph[10].push(11);
    let out = run(&graph, &[0], &[0, 10], 12, 12, 12);
    assert_eq!(out.stats.visited, 12);
    assert_eq!(out.stats.expanded, 12);
    assert_eq!(out.stats.excluded_expanded, 2);
    assert!(out.candidates.contains(&11));
    assert!(!out.candidates.contains(&10));
}