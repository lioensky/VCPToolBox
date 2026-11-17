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
    pub converged: bool,
    pub first_visit_rejection_expansion: Option<usize>,
    pub rejected_discoveries: usize,
    pub expansions_after_visit_limit: usize,
}

#[derive(Debug)]
pub(crate) struct BeamOutput {
    pub candidates: Vec<u32>,
    pub stats: BeamStats,
    pub visited_nodes: Vec<u32>,
    pub candidate_scores: Vec<f64>,
    pub workspace_bytes: usize,
}

#[derive(Default)]
struct Workspace {
    versions: Vec<u32>,
    flags: Vec<u8>,
    apex: Vec<f64>,
    touched: Vec<u32>,
    epoch: u32,
}
impl Workspace {
    fn begin(&mut self, nodes: usize) {
        if self.versions.len()<nodes {
            self.versions.resize(nodes,0);
            self.flags.resize(nodes,0);
            self.apex.resize(nodes,0.0);
        }
        self.epoch=self.epoch.wrapping_add(1);
        if self.epoch==0 {
            self.versions.fill(0);
            self.epoch=1;
        }
        self.touched.clear();
    }
    fn bytes(&self)->usize {
        self.versions.capacity()*4+self.flags.capacity()
            +self.apex.capacity()*8+self.touched.capacity()*4
    }
}
std::thread_local! {
    static WORKSPACE: std::cell::RefCell<Option<Workspace>> =
        const {std::cell::RefCell::new(None)};
}
struct Lease(Option<Workspace>);
impl Lease {
    fn acquire(nodes:usize)->Self {
        // Do not hold a RefCell borrow across user callbacks: nested searches
        // obtain another workspace and cannot corrupt the outer search.
        let mut work=WORKSPACE.with(|slot|slot.borrow_mut().take()).unwrap_or_default();
        work.begin(nodes);
        Self(Some(work))
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        let work=self.0.take();
        let _=WORKSPACE.try_with(|slot| {
            let mut cached=slot.borrow_mut();
            if cached.is_none() { *cached=work; }
        });
    }
}
enum Marks {
    Dense {seen:Vec<bool>, expanded:Vec<bool>, eligible:Vec<bool>},
    Epoch(Lease),
}
impl Marks {
    fn seen(&self,i:usize)->bool { match self {
        Self::Dense {seen,..}=>seen[i],
        Self::Epoch(w)=>{let w=w.0.as_ref().unwrap();w.versions[i]==w.epoch}
    }}
    fn expanded(&self,i:usize)->bool { match self {
        Self::Dense {expanded,..}=>expanded[i],
        Self::Epoch(w)=>w.0.as_ref().unwrap().flags[i]&2!=0,
    }}
    fn eligible(&self,i:usize)->bool { match self {
        Self::Dense {eligible,..}=>eligible[i],
        Self::Epoch(w)=>w.0.as_ref().unwrap().flags[i]&1!=0,
    }}
    fn discover(&mut self,i:usize,eligible:bool) { match self {
        Self::Dense {seen,eligible:e,..}=>{seen[i]=true;e[i]=eligible;},
        Self::Epoch(w)=>{
            let w=w.0.as_mut().unwrap();
            w.versions[i]=w.epoch;w.flags[i]=u8::from(eligible);
            w.touched.push(i as u32);
        }
    }}
    fn expand(&mut self,i:usize) { match self {
        Self::Dense {expanded,..}=>expanded[i]=true,
        Self::Epoch(w)=>w.0.as_mut().unwrap().flags[i]|=2,
    }}
    fn cache_score(&mut self,i:usize,score:f64) {
        if let Self::Epoch(w)=self {w.0.as_mut().unwrap().apex[i]=score;}
    }
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
    nodes: usize,
    marks: Marks,
    queues: [BinaryHeap<Reverse<Score>>; 2],
    retained: [BinaryHeap<Score>; 2],
    bridges: VecDeque<u32>,
    stats: BeamStats,
}

impl State {
    fn discover<S, A>(&mut self, node: u32, budget: BeamBudget, score: &mut S, admits: &mut A)
    where S: FnMut(u32) -> (f64, f64), A: FnMut(u32) -> bool {
        let idx = node as usize;
        if idx >= self.nodes || self.marks.seen(idx) { return; }
        if self.stats.visited >= budget.max_visits {
            self.stats.visit_limit_reached = true;
            self.stats.first_visit_rejection_expansion.get_or_insert(self.stats.expanded);
            self.stats.rejected_discoveries += 1;
            return;
        }
        let eligible=admits(node);
        self.marks.discover(idx,eligible);
        self.stats.visited += 1;
        // Bridges need no result score; they still count as visited work.
        if !eligible {
            self.bridges.push_back(node);
            return;
        }
        let (apex, horizontal) = score(node);
        self.marks.cache_score(idx,apex);
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

    // Remove only already-expanded heads. A head worse than the retained
    // threshold is an ANN proxy stopping condition, not an exact metric bound.
    fn can_improve(&mut self, channel: usize, budget: BeamBudget) -> bool {
        while self.queues[channel].peek().is_some_and(|Reverse(item)| self.marks.expanded(item.1 as usize)) {
            self.queues[channel].pop();
        }
        self.queues[channel].peek().is_some_and(|Reverse(item)| {
            self.retained[channel].len() < budget.width
                || self.retained[channel].peek().is_some_and(|worst| item <= worst)
        })
    }

    fn pop_valid(&mut self, channel: usize, budget: BeamBudget) -> Option<u32> {
        while let Some(Reverse(item)) = self.queues[channel].pop() {
            if self.marks.expanded(item.1 as usize) { continue; }
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
    score: S,
    admits: A,
) -> BeamOutput
where
    N: Fn(u32) -> &'a [u32],
    S: FnMut(u32) -> (f64, f64),
    A: FnMut(u32) -> bool,
{
    run_beam(nodes,seeds,budget,neighbors,score,admits,false,true)
}

/// Explicit experimental fast path. Only requested traces materialize visited IDs.
pub(crate) fn reusable_beam<'a,N,S,A>(
    nodes:usize,seeds:&[u32],budget:BeamBudget,neighbors:N,score:S,admits:A,
    collect_visited:bool,
)->BeamOutput
where N:Fn(u32)->&'a [u32],S:FnMut(u32)->(f64,f64),A:FnMut(u32)->bool {
    run_beam(nodes,seeds,budget,neighbors,score,admits,true,collect_visited)
}

fn run_beam<'a,N,S,A>(
    nodes:usize,seeds:&[u32],budget:BeamBudget,neighbors:N,
    mut score:S,mut admits:A,reuse:bool,collect_visited:bool,
)->BeamOutput
where N:Fn(u32)->&'a [u32],S:FnMut(u32)->(f64,f64),A:FnMut(u32)->bool {
    let mut state = State {
        nodes,
        marks:if reuse {Marks::Epoch(Lease::acquire(nodes))}
            else {Marks::Dense {seen:vec![false;nodes],expanded:vec![false;nodes],
                eligible:vec![false;nodes]}},
        queues: std::array::from_fn(|_| BinaryHeap::new()),
        retained: std::array::from_fn(|_| BinaryHeap::new()),
        bridges: VecDeque::new(),
        stats: BeamStats::default(),
    };
    if budget.width == 0 {
        return BeamOutput { candidates: Vec::new(), stats: state.stats, visited_nodes: Vec::new(),
            candidate_scores:Vec::new(),workspace_bytes:0 };
    }
    for &seed in seeds {
        state.discover(seed, budget, &mut score, &mut admits);
    }
    let mut turn = 0usize;
    loop {
        let apex_ready = state.can_improve(0, budget);
        let horizontal_ready = state.can_improve(1, budget);
        // Conservatively keep ALL discovered excluded bridges, including ones
        // with poor proxy scores: they may be the only route to a valid tail.
        if !apex_ready && !horizontal_ready && state.bridges.is_empty() {
            state.stats.converged = true;
            break;
        }
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
        if state.marks.expanded(node as usize) { continue; }
        state.marks.expand(node as usize);
        if state.stats.visit_limit_reached {
            state.stats.expansions_after_visit_limit += 1;
        }
        state.stats.expanded += 1;
        if !state.marks.eligible(node as usize) { state.stats.excluded_expanded += 1; }
        for &neighbor in neighbors(node) {
            state.discover(neighbor, budget, &mut score, &mut admits);
        }
        turn += 1;
    }
    let mut pool = state.retained[0].iter().chain(state.retained[1].iter())
        .map(|item| item.1).collect::<Vec<_>>();
    pool.sort_unstable();
    pool.dedup();
    let (visited_nodes,candidate_scores,workspace_bytes)=match &state.marks {
        Marks::Dense {seen,..}=>(seen.iter().enumerate()
            .filter_map(|(node,&seen)|seen.then_some(node as u32)).collect(),Vec::new(),0),
        Marks::Epoch(lease)=>{
            let w=lease.0.as_ref().unwrap();
            let mut visited=if collect_visited {w.touched.clone()} else {Vec::new()};
            visited.sort_unstable(); // Trace compatibility: sorted IDs, not discovery order.
            let scores=pool.iter().map(|&n|w.apex[n as usize]).collect();
            (visited,scores,w.bytes())
        }
    };
    BeamOutput { candidates: pool, stats: state.stats, visited_nodes,
        candidate_scores,workspace_bytes }
}

#[cfg(test)]
#[path = "beam_tests.rs"]
mod tests;