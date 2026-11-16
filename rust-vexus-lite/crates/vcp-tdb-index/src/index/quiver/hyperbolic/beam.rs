//! Budgeted dual-retention navigation, independent of vector storage.
//! Inspired by Pelorus (Apache-2.0, Copyright 2024 TriviumDB Authors).
//! Excluded bridges never consume either valid retention heap.
use std::cmp::{Ordering, Reverse};
use std::collections::{BinaryHeap, VecDeque};

#[derive(Clone, Copy, Debug)]
pub(crate) struct BeamBudget {
    pub width: usize,
    pub max_visits: usize,
    pub max_expansions: usize,
}

#[derive(Default, Debug)]
pub(crate) struct BeamStats {
    pub visited: usize,
    pub expanded: usize,
    pub excluded_expanded: usize,
    pub visit_limit_reached: bool,
    pub expansion_limit_reached: bool,
}

#[derive(Debug)]
pub(crate) struct BeamOutput {
    pub candidates: Vec<u32>,
    pub stats: BeamStats,
}

#[derive(Clone, Copy, Debug)]
struct Score(f64, u32);
impl PartialEq for Score {
    fn eq(&self, other: &Self) -> bool { self.cmp(other) == Ordering::Equal }
}
impl Eq for Score {}
impl PartialOrd for Score {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> { Some(self.cmp(other)) }
}
impl Ord for Score {
    fn cmp(&self, other: &Self) -> Ordering {
        self.0.total_cmp(&other.0).then(self.1.cmp(&other.1))
    }
}

struct State {
    seen: Vec<bool>,
    expanded: Vec<bool>,
    eligible: Vec<bool>,
    queues: [BinaryHeap<Reverse<Score>>; 2],
    retained: [BinaryHeap<Score>; 2],
    bridges: VecDeque<u32>,
    stats: BeamStats,
}

impl State {
    fn discover<S, A>(&mut self, node: u32, budget: BeamBudget, score: &mut S, admits: &mut A)
    where S: FnMut(u32) -> (f64, f64), A: FnMut(u32) -> bool {
        let idx = node as usize;
        if idx >= self.seen.len() || self.seen[idx] { return; }
        if self.stats.visited >= budget.max_visits {
            self.stats.visit_limit_reached = true;
            return;
        }
        self.seen[idx] = true;
        self.stats.visited += 1;
        self.eligible[idx] = admits(node);
        // Bridges need no result score; they still count as visited work.
        if !self.eligible[idx] {
            self.bridges.push_back(node);
            return;
        }
        let (apex, horizontal) = score(node);
        for (channel, value) in [apex, horizontal].into_iter().enumerate() {
            if !value.is_finite() { continue; }
            let item = Score(value, node);
            let heap = &mut self.retained[channel];
            if heap.len() < budget.width || item < *heap.peek().unwrap() {
                heap.push(item);
                self.queues[channel].push(Reverse(item));
                if heap.len() > budget.width { heap.pop(); }
            }
        }
    }

    fn pop_valid(&mut self, channel: usize, budget: BeamBudget) -> Option<u32> {
        while let Some(Reverse(item)) = self.queues[channel].pop() {
            if self.expanded[item.1 as usize] { continue; }
            if self.retained[channel].len() >= budget.width
                && self.retained[channel].peek().is_some_and(|worst| item > *worst)
            { continue; }
            return Some(item.1);
        }
        None
    }
}

/// No cold-source callback is accepted: every score comes from hot metadata.
/// Result eligibility is sampled once per discovered node. Independent hard caps
/// also bound fully excluded components; exclusions cannot erase actual work.
pub(crate) fn bounded_beam<'a, N, S, A>(
    nodes: usize,
    seeds: &[u32],
    budget: BeamBudget,
    neighbors: N,
    mut score: S,
    mut admits: A,
) -> BeamOutput
where
    N: Fn(u32) -> &'a [u32],
    S: FnMut(u32) -> (f64, f64),
    A: FnMut(u32) -> bool,
{
    let mut state = State {
        seen: vec![false; nodes],
        expanded: vec![false; nodes],
        eligible: vec![false; nodes],
        queues: std::array::from_fn(|_| BinaryHeap::new()),
        retained: std::array::from_fn(|_| BinaryHeap::new()),
        bridges: VecDeque::new(),
        stats: BeamStats::default(),
    };
    if budget.width == 0 {
        return BeamOutput { candidates: Vec::new(), stats: state.stats };
    }
    for &seed in seeds {
        state.discover(seed, budget, &mut score, &mut admits);
    }
    let mut turn = 0usize;
    loop {
        // Alternate bridge and scored work to avoid starvation on either side.
        let bridge_turn = turn % 3 == 0;
        let current = if bridge_turn { state.bridges.pop_front() } else { None }
            .or_else(|| state.pop_valid(turn % 2, budget))
            .or_else(|| state.pop_valid((turn + 1) % 2, budget))
            .or_else(|| state.bridges.pop_front());
        let Some(node) = current else { break; };
        if state.stats.expanded >= budget.max_expansions {
            state.stats.expansion_limit_reached = true;
            break;
        }
        if state.expanded[node as usize] { continue; }
        state.expanded[node as usize] = true;
        state.stats.expanded += 1;
        if !state.eligible[node as usize] { state.stats.excluded_expanded += 1; }
        for &neighbor in neighbors(node) {
            state.discover(neighbor, budget, &mut score, &mut admits);
        }
        turn += 1;
    }
    let mut pool = state.retained[0].iter().chain(state.retained[1].iter())
        .map(|item| item.1).collect::<Vec<_>>();
    pool.sort_unstable();
    pool.dedup();
    BeamOutput { candidates: pool, stats: state.stats }
}

#[cfg(test)]
#[path = "beam_tests.rs"]
mod tests;