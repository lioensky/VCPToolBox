//! Request-local seed-basin projection. Never modifies Sense, scalar fields or Omega.
use crate::memo_sensing::SenseOutput;
use crate::rivermemo_topology_v3::NativeArtifact;
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::{BTreeMap, BinaryHeap, HashMap, HashSet, VecDeque};

const RESERVED: usize = 2;
const STATE_LIMIT: usize = 8192;
const EDGE_LIMIT: usize = 65536;
const BATCH: usize = 4;

fn positive(x: f64) -> f64 {
    if x.is_finite() { x.max(0.0) } else { 0.0 }
}

#[derive(Clone, Debug)]
pub(crate) struct Basin {
    pub(crate) id: i64,
    pub(crate) inner: Vec<i64>,
    pub(crate) importance: f64,
}

/// A deterministic, disjoint observation-edge forest rooted at the recorded seeds.
/// seed_id is representative provenance, not exact multi-source lineage. Forest
/// assignment validates paths instead of trusting a potentially disconnected label group.
pub(crate) fn seed_basins(observation: &SenseOutput, graph: &NativeArtifact) -> Vec<Basin> {
    let nodes: BTreeMap<_, _> = observation.nodes.iter()
        .filter(|n| graph.node_index.contains_key(&n.id)).map(|n| (n.id, n)).collect();
    let mut roots: Vec<i64> = nodes.values().filter(|n| n.hop == 0)
        .map(|n| n.id).chain(nodes.values().filter_map(|n| n.seed_id)
            .filter(|id| nodes.contains_key(id))).collect();
    roots.sort_unstable();
    roots.dedup();
    let mut edges = HashMap::<i64, Vec<i64>>::new();
    for edge in &observation.edges {
        if positive(edge.flow) > 0.0 && nodes.contains_key(&edge.source_id)
            && nodes.contains_key(&edge.target_id)
            && graph.edge_weight(edge.source_id, edge.target_id) > 0.0 {
            edges.entry(edge.source_id).or_default().push(edge.target_id);
        }
    }
    for row in edges.values_mut() { row.sort_unstable(); row.dedup(); }
    let mut owner = HashMap::new();
    let mut basins = Vec::new();
    let mut queue = VecDeque::new();
    for root in roots {
        owner.insert(root, basins.len());
        queue.push_back(root);
        basins.push(Basin { id: root, inner: vec![root], importance: 0.0 });
    }
    // Multiple roots are reserved before traversal, so a strong source cannot
    // consume another seed's root. Each assigned node has a same-basin predecessor.
    while let Some(source) = queue.pop_front() {
        let basin = owner[&source];
        if let Some(row) = edges.get(&source) {
            for &target in row {
                if let std::collections::hash_map::Entry::Vacant(entry) = owner.entry(target) {
                    entry.insert(basin);
                    basins[basin].inner.push(target);
                    queue.push_back(target);
                }
            }
        }
    }
    // Truncated/unknown provenance must not silently drop core nodes or invent paths.
    for &id in nodes.keys() {
        if !owner.contains_key(&id) {
            owner.insert(id, basins.len());
            basins.push(Basin { id, inner: vec![id], importance: 0.0 });
        }
    }
    for basin in &mut basins {
        basin.inner.sort_unstable();
        basin.importance = basin.inner.iter().map(|id| positive(nodes[id].energy)).sum();
    }
    basins.sort_by_key(|b| b.id);
    basins
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LaneDiagnostics {
    basin_id: i64,
    field: usize,
    inner_nodes: usize,
    outer_nodes: usize,
    reserved_nodes: usize,
    new_union_nodes: usize,
    settled_nodes: usize,
    scanned_edges: usize,
    radius: f64,
    truncated: bool,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GrowthDiagnostics {
    pub(crate) budget: usize,
    pub(crate) core_nodes: usize,
    pub(crate) union_nodes: usize,
    pub(crate) overlap_nodes: usize,
    pub(crate) settled_states: usize,
    pub(crate) scanned_edges: usize,
    pub(crate) stop_reason: String,
    pub(crate) lanes: Vec<LaneDiagnostics>,
}
pub(crate) struct Supports {
    pub(crate) ids: [Vec<i64>; 2],
    pub(crate) diagnostics: GrowthDiagnostics,
}

#[derive(Clone, Copy)]
struct Arrival { distance: f64, id: i64, index: usize }
impl PartialEq for Arrival {
    fn eq(&self, rhs: &Self) -> bool {
        self.distance.total_cmp(&rhs.distance) == Ordering::Equal && self.id == rhs.id
    }
}
impl Eq for Arrival {}
impl PartialOrd for Arrival {
    fn partial_cmp(&self, rhs: &Self) -> Option<Ordering> { Some(self.cmp(rhs)) }
}
impl Ord for Arrival {
    fn cmp(&self, rhs: &Self) -> Ordering {
        rhs.distance.total_cmp(&self.distance).then_with(|| rhs.id.cmp(&self.id))
    }
}
struct Lane {
    field: usize,
    importance: f64,
    frontier: BinaryHeap<Arrival>,
    distance: HashMap<usize, f64>,
    settled: HashSet<usize>,
    inner: HashSet<i64>,
    gain: f64,
    diagnostics: LaneDiagnostics,
}
impl Lane {
    fn new(field: usize, basin: &Basin, graph: &NativeArtifact) -> Self {
        let inner: HashSet<_> = basin.inner.iter().copied().collect();
        let distance: HashMap<_, _> = basin.inner.iter()
            .map(|id| (graph.node_index[id], 0.0)).collect();
        let frontier = basin.inner.iter().map(|&id| Arrival {
            distance: 0.0, id, index: graph.node_index[&id],
        }).collect();
        Self {
            field, importance: positive(basin.importance), frontier, distance,
            settled: HashSet::new(), inner, gain: 0.0,
            diagnostics: LaneDiagnostics {
                basin_id: basin.id, field, inner_nodes: basin.inner.len(),
                ..LaneDiagnostics::default()
            },
        }
    }
    fn next(&mut self) -> Option<Arrival> {
        while let Some(a) = self.frontier.pop() {
            if !self.settled.contains(&a.index)
                && self.distance.get(&a.index).copied() == Some(a.distance) {
                return Some(a);
            }
        }
        None
    }
}

/// One shared union cap, independently admitted field supports, finite work.
/// Distances are from each connected inner boundary, NOT from a single centroid.
pub(crate) fn grow(
    graph: &NativeArtifact, fields: [&[f64]; 2], domains: [&[i64]; 2],
    core: &[i64], basins: &[Basin], limit: usize,
) -> Result<Supports, String> {
    let mut core: Vec<i64> = core.iter().copied()
        .filter(|id| graph.node_index.contains_key(id)).collect();
    core.sort_unstable();
    core.dedup();
    if limit > 0 && core.len() > limit {
        return Err(format!("MEMO_PROJECTION_CORE_EXCEEDS_BUDGET: core has {} nodes, shared budget is {}; increase maxFieldProjectionNodes or use 0", core.len(), limit));
    }
    let mut selected: [HashSet<i64>; 2] = std::array::from_fn(|_| core.iter().copied().collect());
    let mut ids = [core.clone(), core.clone()];
    let mut union: HashSet<i64> = core.iter().copied().collect();
    let totals: [f64; 2] = fields.map(|f| f.iter().copied().map(positive).sum());
    let targets: [f64; 2] = std::array::from_fn(|f| domains[f].iter()
        .filter_map(|id| graph.node_index.get(id)).map(|&i| positive(fields[f][i])).sum());
    let mut mass: [f64; 2] = std::array::from_fn(|f| core.iter()
        .map(|id| positive(fields[f][graph.node_index[id]])).sum());
    let cutoffs = fields.map(|f| f.iter().copied().map(positive).fold(0.0_f64, f64::max)*1e-12);
    // Test/legacy callers without an observation use explicit singleton basins.
    let fallback;
    let basins = if basins.is_empty() {
        fallback = core.iter().map(|&id| Basin {
            id, inner: vec![id], importance: 1.0,
        }).collect::<Vec<_>>();
        &fallback[..]
    } else { basins };
    let mut lanes = Vec::new();
    for basin in basins {
        if basin.inner.is_empty() || !basin.inner.iter().all(|id| union.contains(id)) {
            return Err("MEMO_PROJECTION_INVALID_BASIN: inner nodes must belong to core".into());
        }
        for f in 0..2 { lanes.push(Lane::new(f, basin, graph)); }
    }
    let mut coverage = HashMap::<i64, HashSet<i64>>::new();
    let mut states = 0usize;
    let mut scanned = 0usize;
    let mut discovered = lanes.iter().map(|l| l.distance.len()).sum::<usize>();
    let mut reason = "frontier_exhausted";
    let mut cursor = 0usize;
    loop {
        if mass.iter().zip(targets).all(|(&m,t)| m >= t) {
            reason = "mass_target"; break;
        }
        if states >= STATE_LIMIT || scanned >= EDGE_LIMIT {
            reason = "work_limit"; break;
        }
        let active = |l: &Lane| mass[l.field] < targets[l.field] && !l.frontier.is_empty();
        // Guaranteed exploration is round robin and ignores gain entirely.
        let reserved = (0..lanes.len()).map(|offset| (cursor + offset) % lanes.len())
            .find(|&i| active(&lanes[i]) && lanes[i].diagnostics.outer_nodes < RESERVED);
        let choice = reserved.or_else(|| lanes.iter().enumerate().filter(|(_,l)| active(l))
            .max_by(|(ia,a),(ib,b)| {
                let priority = |l: &Lane| l.importance.sqrt() * l.gain.max(1e-12)
                    / (1.0 + l.diagnostics.outer_nodes as f64 / RESERVED as f64);
                priority(a).total_cmp(&priority(b)).then_with(|| ib.cmp(ia))
            }).map(|(i,_)| i));
        let Some(index) = choice else { break };
        cursor = (index + 1) % lanes.len();
        let lane = &mut lanes[index];
        let mut batch_gain = 0.0;
        let mut outer = 0usize;
        // Inner traversal never spends an outer reserved opportunity.
        while outer < if reserved.is_some() { 1 } else { BATCH }
            && states < STATE_LIMIT && scanned < EDGE_LIMIT {
            let Some(a) = lane.next() else { break };
            states += 1;
            lane.diagnostics.settled_nodes += 1;
            lane.settled.insert(a.index);
            if !union.contains(&a.id) && limit > 0 && union.len() >= limit {
                reason = "budget";
                continue; // Never expose successors through an unadmitted node.
            }
            let f = lane.field;
            if union.insert(a.id) { lane.diagnostics.new_union_nodes += 1; }
            let is_outer = !lane.inner.contains(&a.id);
            if is_outer {
                outer += 1;
                lane.diagnostics.outer_nodes += 1;
                if reserved.is_some() { lane.diagnostics.reserved_nodes += 1; }
            }
            if selected[f].insert(a.id) {
                ids[f].push(a.id);
                let value = positive(fields[f][a.index]);
                mass[f] += value;
                batch_gain += value / totals[f].max(1e-30);
            }
            coverage.entry(a.id).or_default().insert(lane.diagnostics.basin_id);
            lane.diagnostics.radius = a.distance;
            for edge in graph.row_offsets[a.index]..graph.row_offsets[a.index + 1] {
                if scanned >= EDGE_LIMIT { break; }
                scanned += 1;
                lane.diagnostics.scanned_edges += 1;
                let weight = graph.weights[edge];
                if !weight.is_finite() || weight <= 0.0 || weight > 1.0 { continue; }
                let target = graph.targets[edge];
                let value = positive(fields[f][target]);
                if value <= 0.0 || value < cutoffs[f] || lane.settled.contains(&target) { continue; }
                let distance = a.distance - weight.ln();
                let previous = lane.distance.get(&target).copied();
                if previous.is_none() && discovered >= STATE_LIMIT {
                    lane.diagnostics.truncated = true;
                    continue;
                }
                if previous.map_or(true, |old| distance < old) {
                    if previous.is_none() { discovered += 1; }
                    lane.distance.insert(target, distance);
                    lane.frontier.push(Arrival { distance, id: graph.node_ids[target], index: target });
                }
            }
            if mass[f] >= targets[f] { break; }
        }
        if outer > 0 { lane.gain = 0.5*lane.gain + 0.5*batch_gain / outer as f64; }
    }
    if lanes.iter().any(|l| l.diagnostics.truncated) && reason == "frontier_exhausted" {
        reason = "work_limit";
    }
    for lane in &mut lanes {
        lane.diagnostics.truncated |= !lane.frontier.is_empty() && reason != "mass_target";
    }
    Ok(Supports {
        ids,
        diagnostics: GrowthDiagnostics {
            budget: limit, core_nodes: core.len(), union_nodes: union.len(),
            overlap_nodes: coverage.values().filter(|set| set.len() > 1).count(),
            settled_states: states, scanned_edges: scanned,
            stop_reason: if core.is_empty() { "empty_core".into() } else { reason.into() },
            lanes: lanes.into_iter().map(|l| l.diagnostics).collect(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memo_sensing::{sense_typed, SenseConfig, SenseInput, SenseSeed};

    fn graph(count: usize, edges: &[(usize, usize, f64)]) -> NativeArtifact {
        let mut g = NativeArtifact {
            node_ids: (1..=count as i64).collect(),
            node_index: (1..=count as i64).enumerate().map(|(i,id)| (id,i)).collect(),
            ..NativeArtifact::default()
        };
        g.row_offsets.push(0);
        for source in 0..count {
            for &(s,t,w) in edges {
                if s == source { g.targets.push(t); g.weights.push(w); }
            }
            g.row_offsets.push(g.targets.len());
        }
        g.prepared()
    }
    fn basin(id: i64, importance: f64) -> Basin {
        Basin { id, importance, inner: vec![id] }
    }
    fn assert_paths(g: &NativeArtifact, support: &[i64], core: &[i64]) {
        for (position, id) in support.iter().enumerate() {
            if core.contains(id) { continue; }
            assert!(support[..position].iter().any(|p| g.edge_weight(*p,*id) > 0.0),
                "node {} lacks an admitted predecessor", id);
        }
    }

    #[test]
    fn shared_256_cap_and_weak_basin_reserved_exploration() {
        let mut edges = Vec::new();
        for i in 2..602 { edges.push((if i % 2 == 0 { 0 } else { 1 }, i, 0.001)); }
        let g = graph(602, &edges);
        let mut local = vec![0.001; 602];
        let mut transfer = local.clone();
        for i in 2..602 {
            if i % 2 == 0 { local[i] = 0.1; } else { transfer[i] = 0.1; }
        }
        let domain = g.node_ids.clone();
        let basins = [basin(1, 100.0), basin(2, 0.0001)];
        let result = grow(&g, [&local,&transfer], [&domain,&domain], &[1,2], &basins, 256).unwrap();
        assert_eq!(result.diagnostics.union_nodes, 256);
        assert!(result.diagnostics.lanes.iter().all(|l| l.reserved_nodes == RESERVED));
        assert!(result.diagnostics.lanes.iter().any(|l| l.outer_nodes > RESERVED));
        for support in &result.ids { assert_paths(&g, support, &[1,2]); }
        let again = grow(&g, [&local,&transfer], [&domain,&domain], &[2,1], &basins, 256).unwrap();
        assert_eq!(result.ids, again.ids);
        assert_eq!(serde_json::to_value(result.diagnostics).unwrap(),
            serde_json::to_value(again.diagnostics).unwrap());
    }

    #[test]
    fn overlap_deduplicates_without_inflating_field_mass() {
        let g = graph(5, &[(0,2,0.5),(1,2,0.5),(2,3,0.5)]);
        let field = [0.1,0.1,0.1,0.1,0.6]; // Unreachable node keeps the target open.
        let domain = g.node_ids.clone();
        let result = grow(&g, [&field,&field], [&domain,&domain], &[1,2],
            &[basin(1,1.0),basin(2,1.0)], 4).unwrap();
        assert_eq!(result.diagnostics.union_nodes, 4);
        assert_eq!(result.diagnostics.overlap_nodes, 2);
        for ids in &result.ids {
            assert_eq!(ids.len(), 4);
            assert_eq!(ids.iter().copied().collect::<HashSet<_>>().len(), 4);
            assert!(!ids.contains(&5));
            assert_paths(&g, ids, &[1,2]);
        }
    }

    #[test]
    fn independent_field_target_does_not_borrow_other_field_nodes() {
        let g = graph(3, &[(0,1,0.5),(1,2,0.5)]);
        let local = [0.9,0.05,0.05];
        let transfer = [0.1,0.2,0.7];
        let result = grow(&g, [&local,&transfer], [&[1],&[3,2]], &[1],
            &[basin(1,1.0)], 3).unwrap();
        assert_eq!(result.ids[0], vec![1]);
        assert_eq!(result.ids[1], vec![1,2,3]);
        assert_eq!(result.diagnostics.union_nodes, 3);
    }

    #[test]
    fn guaranteed_exploration_crosses_low_mass_bridge_in_distance_order() {
        let g = graph(5, &[(0,1,0.5),(1,2,0.5),(0,3,0.01)]);
        let field = [0.1,0.001,0.5,0.1,0.299];
        let domain = g.node_ids.clone();
        let result = grow(&g, [&field,&field], [&domain,&domain], &[1],
            &[basin(1,1.0)], 3).unwrap();
        for ids in &result.ids {
            assert_eq!(ids, &[1,2,3]);
            assert_paths(&g, ids, &[1]);
        }
        assert!(result.diagnostics.lanes.iter().all(|l| l.reserved_nodes == 2));
    }

    #[test]
    fn exhausted_basin_returns_budget_to_other_lanes() {
        let g = graph(6, &[(1,2,0.5),(2,3,0.5),(3,4,0.5),(4,5,0.5)]);
        let field = [1.0; 6];
        let domain = g.node_ids.clone();
        let result = grow(&g, [&field,&field], [&domain,&domain], &[1,2],
            &[basin(1,100.0),basin(2,0.001)], 6).unwrap();
        assert_eq!(result.diagnostics.union_nodes, 6);
        assert!(result.diagnostics.lanes.iter().filter(|l| l.basin_id == 1)
            .all(|l| l.outer_nodes == 0));
    }

    #[test]
    fn inner_traversal_does_not_consume_reserved_outer_slots() {
        let edges: Vec<_> = (0..29).map(|i| (i,i+1,0.5)).collect();
        let g = graph(30, &edges);
        let field = [1.0; 30];
        let domain = g.node_ids.clone();
        let core: Vec<_> = (1..=20).collect();
        let b = Basin { id: 1, inner: core.clone(), importance: 1.0 };
        let result = grow(&g, [&field,&field], [&domain,&domain], &core, &[b], 30).unwrap();
        assert!(result.diagnostics.lanes.iter().all(|l| l.reserved_nodes == RESERVED));
        assert_eq!(result.diagnostics.union_nodes, 30);
    }

    #[test]
    fn work_is_bounded_even_without_node_cap() {
        let edges: Vec<_> = (1..70000).map(|i| (0,i,0.00001)).collect();
        let g = graph(70000, &edges);
        let field = vec![1.0; 70000];
        let domain = g.node_ids.clone();
        let result = grow(&g, [&field,&field], [&domain,&domain], &[1],
            &[basin(1,1.0)], 0).unwrap();
        assert!(result.diagnostics.scanned_edges <= EDGE_LIMIT);
        assert!(result.diagnostics.settled_states <= STATE_LIMIT);
        assert_eq!(result.diagnostics.stop_reason, "work_limit");
    }

    #[test]
    fn observation_forest_preserves_all_nodes_despite_misleading_lineage() {
        let g = graph(5, &[(0,2,0.5),(1,2,0.5),(2,3,0.5)]);
        let mut observation = sense_typed(&g, "test", SenseInput {
            query_id: None,
            seeds: vec![
                SenseSeed { id:1, energy:1.0, source_type:"seed".into() },
                SenseSeed { id:2, energy:1.0, source_type:"seed".into() },
                SenseSeed { id:5, energy:1.0, source_type:"seed".into() },
            ],
            config: SenseConfig { max_safe_hops:3, minimum_injected_current:0.001,
                firing_threshold:0.001, ..SenseConfig::default() },
        }).unwrap();
        // Reassign descendant labels to a root with no path. Never trust this as a partition.
        for node in &mut observation.nodes {
            if node.hop > 0 { node.seed_id = Some(5); }
        }
        let basins = seed_basins(&observation, &g);
        let assigned: Vec<_> = basins.iter().flat_map(|b| b.inner.iter().copied()).collect();
        assert_eq!(assigned.len(), observation.nodes.len());
        assert_eq!(assigned.iter().copied().collect::<HashSet<_>>().len(), assigned.len());
        assert_eq!(basins.iter().find(|b| b.id == 5).unwrap().inner, vec![5]);
        assert_eq!(basins.iter().find(|b| b.id == 1).unwrap().inner, vec![1,3,4]);
        observation.edges.clear();
        let isolated = seed_basins(&observation, &g);
        assert!(isolated.iter().all(|b| b.inner.len() == 1));
    }
}