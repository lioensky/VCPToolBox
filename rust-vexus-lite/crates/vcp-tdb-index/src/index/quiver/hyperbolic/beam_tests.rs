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

#[test]
fn both_stale_heads_stop_before_expansion_cap() {
    let graph = vec![vec![1, 2], vec![], vec![]];
    let out = bounded_beam(3, &[0],
        BeamBudget { width: 1, max_visits: 100, max_expansions: 100 },
        |n| &graph[n as usize],
        |n| if n == 0 { (10.0, 10.0) } else if n == 1 { (5.0, 5.0) } else { (1.0, 1.0) },
        |_| true);
    assert_eq!(out.candidates, vec![2]);
    assert_eq!(out.stats.expanded, 2);
    assert!(out.stats.converged);
    assert!(!out.stats.expansion_limit_reached);
}

#[test]
fn horizontal_frontier_survives_apex_threshold() {
    let graph = vec![vec![1, 2], vec![], vec![3], vec![]];
    let out = bounded_beam(4, &[0],
        BeamBudget { width: 1, max_visits: 100, max_expansions: 100 },
        |n| &graph[n as usize],
        |n| match n { 0 => (10.,10.), 1 => (0.,9.), 2 => (9.,0.), _ => (-1.,-1.) },
        |_| true);
    assert_eq!(out.candidates, vec![3]);
    assert_eq!(out.stats.visited, 4);
    assert!(out.stats.converged);
}

#[test]
fn discovery_cap_records_first_rejection_and_later_expansions() {
    // The first expansion attempts seven fresh neighbors with only three slots.
    let graph = vec![vec![1,2,3,4,5,6,7],vec![],vec![],vec![],
        vec![],vec![],vec![],vec![]];
    let small = run(&graph, &[0], &[], 8, 4, 8);
    assert_eq!(small.stats.visited,4);
    assert_eq!(small.stats.first_visit_rejection_expansion,Some(1));
    assert_eq!(small.stats.rejected_discoveries,4);
    assert_eq!(small.stats.expansions_after_visit_limit,3);
    let wide = run(&graph, &[0], &[], 8, 8, 8);
    assert_eq!(wide.stats.visited,8);
    assert_eq!(wide.stats.first_visit_rejection_expansion,None);
    assert_eq!(wide.stats.rejected_discoveries,0);
    assert_eq!(wide.stats.expansions_after_visit_limit,0);
}

#[test]
fn reusable_marks_match_dense_across_sizes_exclusions_and_wrap() {
    for nodes in [0,1,17,4096,40602] {
        let graph:Vec<Vec<u32>>=(0..nodes).map(|n|vec![
            ((n+1)%nodes) as u32,((n+7)%nodes) as u32,n as u32,u32::MAX]).collect();
        for excluded in [0,3,nodes+1] {
            for visits in [0,1,32,2048] {
                let budget=BeamBudget {width:16,max_visits:visits,max_expansions:128};
                let seeds=[0,0,u32::MAX];
                let score=|n:u32| ((n%13) as f64, -(n as f64));
                let admits=|n:u32|(n as usize)>=excluded;
                let old=bounded_beam(nodes,&seeds,budget,|n|graph[n as usize].as_slice(),score,admits);
                let fast=reusable_beam(nodes,&seeds,budget,|n|graph[n as usize].as_slice(),score,admits,true);
                assert_eq!(old.candidates,fast.candidates);
                assert_eq!(old.visited_nodes,fast.visited_nodes);
                assert_eq!(format!("{:?}",old.stats),format!("{:?}",fast.stats));
                assert_eq!(fast.candidate_scores,
                    fast.candidates.iter().map(|&n|score(n).0).collect::<Vec<_>>());
                let no_trace=reusable_beam(nodes,&seeds,budget,|n|graph[n as usize].as_slice(),score,admits,false);
                assert_eq!(fast.candidates,no_trace.candidates);
                assert!(no_trace.visited_nodes.is_empty());
            }
        }
    }
    WORKSPACE.with(|slot|slot.borrow_mut().as_mut().unwrap().epoch=u32::MAX);
    let graph=vec![vec![1],vec![]];
    let fast=reusable_beam(2,&[0],BeamBudget {width:2,max_visits:2,max_expansions:2},
        |n|graph[n as usize].as_slice(),|n|(n as f64,n as f64),|_|true,true);
    assert_eq!(fast.visited_nodes,vec![0,1]);
    WORKSPACE.with(|slot|assert_eq!(slot.borrow().as_ref().unwrap().epoch,1));
}

#[test]
fn reusable_workspace_is_reentrant_thread_local_and_unwind_safe() {
    let run=|| {
        let graph=vec![vec![1],vec![2],vec![]];
        let budget=BeamBudget {width:3,max_visits:3,max_expansions:3};
        let mut nested=false;
        let outer=reusable_beam(3,&[0],budget,|n|graph[n as usize].as_slice(),|n| {
            if !nested {
                nested=true;
                let inner=reusable_beam(1,&[0],budget,|_|&[],|_|(1.,1.),|_|true,false);
                assert_eq!(inner.candidates,vec![0]);
            }
            (n as f64,n as f64)
        },|_|true,true);
        assert_eq!(outer.candidates,vec![0,1,2]);
        assert_eq!(outer.visited_nodes,vec![0,1,2]);
        let failed=std::panic::catch_unwind(||reusable_beam(3,&[0],budget,|_|&[],
            |_|panic!("injected score panic"),|_|true,false));
        assert!(failed.is_err());
        let after=reusable_beam(3,&[0],budget,|n|graph[n as usize].as_slice(),
            |n|(n as f64,n as f64),|_|true,true);
        assert_eq!(outer.candidates,after.candidates);
    };
    std::thread::scope(|s| {
        let threads:Vec<_>=(0..4).map(|_|s.spawn(&run)).collect();
        for thread in threads {thread.join().unwrap();}
    });
}