//! Incremental conversion into a frozen warped generation.
use super::*;

fn row(node: usize, dim: usize) -> Vec<f32> {
    (0..dim).map(|j| ((node * 71 + j * 17 + 1) as f64 * 0.37).sin() as f32).collect()
}
fn radius(node: usize) -> f32 { 0.35 + 0.29 * (node * 37 % 101) as f32 / 101.0 }
fn config() -> WarpedFieldConfig {
    WarpedFieldConfig { radius_max: 0.65, throat_phi0: 1.5, angular_scale_kappa: 2.0,
        adaptive_compass: true, degree: 12, ..Default::default() }
}
/// Cold slot of a node: the identity layout, or sparse external slots `10 + 3 * node`.
fn slot(node: usize, sparse: bool) -> usize { if sparse { 10 + 3 * node } else { node } }
fn node(slot: usize, sparse: bool) -> usize { if sparse { (slot - 10) / 3 } else { slot } }
/// Nodes 0..count carry ids 1..=count.
fn trained(dim: usize, count: usize, sparse: bool) -> WarpedFieldIndex {
    let ids: Vec<_> = (1..=count as u64).collect();
    let slots: Vec<_> = (0..count).map(|i| slot(i, sparse)).collect();
    let radii: Vec<_> = (0..count).map(radius).collect();
    let mut index = WarpedFieldIndex::build(dim, &ids, &slots, &radii, &vec![0.01; dim], config(),
        |s, out| { *out = row(node(s, sparse), dim); true }).unwrap();
    index.build_shell_landmarks();
    index
}
fn convert(index: &mut WarpedFieldIndex, dim: usize, nodes: std::ops::Range<usize>, sparse: bool)
    -> io::Result<()> {
    let ids: Vec<_> = nodes.clone().map(|i| i as u64 + 1).collect();
    let slots: Vec<_> = nodes.map(|i| slot(i, sparse)).collect();
    index.convert_batch(&ids, &slots, |s, out| {
        *out = row(node(s, sparse), dim);
        Some(radius(node(s, sparse)))
    })
}
fn budget(count: usize, visits: usize) -> HyperbolicSearchConfig {
    HyperbolicSearchConfig { top_k: 10, width: 4 * count, rerank_limit: count,
        max_visits: visits, max_expansions: visits, radial_bound: false }
}

#[test]
fn converted_tail_is_scored_with_exact_frozen_distances_and_leaves_the_graph_alone() {
    for (dim, sparse) in [(65, false), (768, true), (3072, false)] {
        let (base, total) = (80, 120);
        let mut index = trained(dim, base, sparse);
        let snapshot = index.snapshot_bytes();
        let hot = index.hot_bytes();
        convert(&mut index, dim, base..100, sparse).unwrap();
        convert(&mut index, dim, 100..total, sparse).unwrap();
        assert_eq!(index.ids(), (1..=total as u64).collect::<Vec<_>>().as_slice());
        assert_eq!((index.trained_len(), index.retired_count(), index.connectivity()), (base, 0, (base, 0)));
        assert_eq!(index.slots.is_empty(), !sparse);
        // The trained generation is immutable: graph, directories and its snapshot bytes.
        assert_eq!(index.snapshot_bytes(), snapshot);
        assert_eq!(index.shell_landmark_count(), base);
        let chunks = dim.div_ceil(64);
        assert_eq!(index.hot_bytes() - hot, (total - base) * (32 + 8 + 16 * chunks)
            + if sparse { (total - base) * std::mem::size_of::<usize>() } else { 0 });
        let frozen = WarpedFieldIndex::from_snapshot_bytes(&snapshot).unwrap();
        let cold = |s: usize, out: &mut Vec<f32>| { *out = row(node(s, sparse), dim); true };
        for target in [3, 85, 104, 119] {
            let (query, qr) = (row(target, dim), radius(target));
            let out = index.search_chunks(&query, qr, budget(total, total), None, |_| false, cold).unwrap();
            // The exact endpoint score that an unconverted live delta receives today.
            let mut truth: Vec<_> = (0..total).map(|i| (i as u64 + 1,
                frozen.exact_distance_at_radius(&query, qr, &row(i, dim), radius(i)).unwrap())).collect();
            truth.sort_unstable_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
            truth.truncate(10);
            assert_eq!(out.neighbors.iter().map(|&(id, d)| (id, d.to_bits())).collect::<Vec<_>>(),
                truth.iter().map(|&(id, d)| (id, d.to_bits())).collect::<Vec<_>>());
            assert_eq!(out.stats.converted_scored, total - base);
            // Tail nodes need no navigation: they are found with the smallest hot budget,
            // and the graph walk never visits them.
            let tight = index.search_chunks(&query, qr, budget(total, 4), None, |_| false, cold).unwrap();
            assert!(tight.stats.visited <= 4);
            if target >= base { assert_eq!(tight.neighbors[0].0, target as u64 + 1); }
            // The default entry (symmetric navigation, 64-row cold cap) scores the tail too.
            let mut trace = WarpedSearchTrace::default();
            let plain = index.search_diagnosed(&query, qr, HyperbolicSearchConfig { rerank_limit: 64,
                ..budget(total, total) }, WarpedSeedMode::LegacySample, Some(&mut trace), |_| false, cold).unwrap();
            assert_eq!((plain.stats.converted_scored, plain.stats.cold_reads <= 64), (total - base, true));
            assert_eq!(plain.neighbors[0].0, target as u64 + 1);
            assert!(trace.visited.iter().chain(&trace.seeds).all(|&id| id <= base as u64));
            assert_eq!(trace.stage05_evaluations, plain.stats.valid_candidates);
            // Exclusion applies to the tail before any proxy or cold work.
            let scoped = index.search_chunks(&query, qr, budget(total, total), None,
                |id| id > 100, |s, out| { assert!(node(s, sparse) < 100); cold(s, out) }).unwrap();
            assert_eq!(scoped.stats.converted_scored, 20);
            assert!(scoped.neighbors.iter().all(|hit| hit.0 <= 100));
        }
    }
}

#[test]
fn conversion_is_atomic_and_validates_its_contract() {
    let dim = 384;
    let mut index = trained(dim, 60, true);
    let (snapshot, hot) = (index.snapshot_bytes(), index.hot_bytes());
    let good = |s: usize, out: &mut Vec<f32>| { *out = row(node(s, true), dim); Some(0.4) };
    for (ids, slots) in [
        (vec![0, 62], vec![190, 193]),
        (vec![61, 61], vec![190, 193]),
        (vec![61, 62], vec![190, 190]),
        (vec![61, 62], vec![190, 13]),
        (vec![61, 62], vec![190]),
    ] {
        assert!(index.convert_batch(&ids, &slots, good).is_err());
    }
    // A failed cold read, an invalid radius or an invalid original in the middle of a batch.
    for bad in 0..4 {
        assert!(index.convert_batch(&[61, 62], &[190, 193], |s, out| {
            *out = if s == 193 && bad == 0 { vec![0.0; dim] } else { row(node(s, true), dim) };
            match (s, bad) { (193, 1) => None, (193, 2) => Some(f32::NAN), (193, 3) => Some(0.66), _ => Some(0.4) }
        }).is_err());
    }
    assert_eq!((index.ids().len(), index.hot_bytes(), index.retired_count()), (60, hot, 0));
    assert_eq!(index.converted_bytes(), 0u64.to_le_bytes());
    assert_eq!(index.snapshot_bytes(), snapshot);
    index.convert_batch(&[], &[], good).unwrap();
    assert_eq!(index.ids().len(), 60);
}

#[test]
fn reconverted_identity_retires_the_older_node_and_the_tail_replays_onto_the_snapshot() {
    let (dim, base) = (768, 60);
    let mut index = trained(dim, base, false);
    let snapshot = index.snapshot_bytes();
    // Chunk 5 (node 4) receives a new vector and radius; chunk 61 is new.
    let cold = |s: usize, out: &mut Vec<f32>| {
        assert_ne!(s, 4, "a retired node is never read as a result endpoint");
        *out = if s == base { row(977, dim) } else { row(s, dim) };
        true
    };
    index.convert_batch(&[5, 61], &[base, base + 1], |s, out| {
        cold(s, out);
        Some(if s == base { 0.41 } else { radius(s) })
    }).unwrap();
    assert_eq!((index.retired_count(), index.ids().len(), index.trained_len()), (1, base + 2, base));
    let search = |index: &WarpedFieldIndex, query: &[f32]| index.search_chunks(query, 0.41,
        budget(base + 2, base), None, |_| false, cold).unwrap().neighbors;
    let replacement = row(977, dim);
    for query in [row(4, dim), replacement.clone()] {
        let fives: Vec<_> = search(&index, &query).into_iter().filter(|hit| hit.0 == 5).collect();
        let exact = index.exact_distance_at_radius(&query, 0.41, &replacement, 0.41).unwrap();
        assert!(fives.len() <= 1 && fives.iter().all(|hit| hit.1.to_bits() == exact.to_bits()));
    }
    assert_eq!(search(&index, &replacement)[0].0, 5);
    assert!(index.identity_slots());
    // The retired trained node keeps its edges: every live node is still returned.
    let all = index.search_chunks(&replacement, 0.41, HyperbolicSearchConfig { top_k: base + 1,
        rerank_limit: base + 2, ..budget(base + 2, base) }, None, |_| false, cold).unwrap();
    assert_eq!(all.neighbors.len(), base + 1);
    assert_eq!(index.snapshot_bytes(), snapshot);
    // The tail alone, replayed onto the trained snapshot, restores the same state.
    let tail = index.converted_bytes();
    let mut restored = WarpedFieldIndex::from_snapshot_bytes(&snapshot).unwrap();
    restored.restore_converted(&tail).unwrap();
    assert_eq!((restored.converted_bytes(), restored.retired_count()), (tail.clone(), 1));
    assert_eq!(search(&restored, &replacement), search(&index, &replacement));
    assert!(restored.restore_converted(&tail).is_err());
    // Converting the same chunk again retires its previous tail node too, in either path.
    index.convert_batch(&[5], &[base + 2], |_, out| { *out = row(978, dim); Some(0.5) }).unwrap();
    assert_eq!(index.retired_count(), 2);
    let twice = index.converted_bytes();
    let mut replayed = WarpedFieldIndex::from_snapshot_bytes(&snapshot).unwrap();
    replayed.restore_converted(&twice).unwrap();
    assert_eq!((replayed.converted_bytes(), replayed.retired_count()), (twice, 2));
    // Structural damage is rejected: length, trailing bytes, identity, slot, radius, code.
    let fresh = || WarpedFieldIndex::from_snapshot_bytes(&snapshot).unwrap();
    assert!(fresh().restore_converted(&tail[..tail.len() - 1]).is_err());
    assert!(fresh().restore_converted(&[tail.clone(), vec![0]].concat()).is_err());
    assert!(fresh().restore_converted(&[]).is_err());
    fresh().restore_converted(&0u64.to_le_bytes()).unwrap();
    // A rejected tail leaves the index unchanged, whatever part of it was already read.
    let mut kept = fresh();
    assert!(kept.restore_converted(&[tail.clone(), vec![0]].concat()).is_err());
    assert_eq!((kept.ids().len(), kept.retired_count(), kept.snapshot_bytes()), (base, 0, snapshot.clone()));
    for (offset, value) in [(0, 3u64.to_le_bytes().to_vec()), (8, 0u64.to_le_bytes().to_vec()),
        (16, (base as u64 - 1).to_le_bytes().to_vec()), (24 + 8, 0.66f32.to_le_bytes().to_vec()),
        (24 + 8, f32::NAN.to_le_bytes().to_vec()), (24 + 24, u32::MAX.to_le_bytes().to_vec()),
        (24 + 32 + 8 * dim.div_ceil(64), u64::MAX.to_le_bytes().to_vec())] {
        let mut damaged = tail.clone();
        damaged[offset..offset + value.len()].copy_from_slice(&value);
        assert!(fresh().restore_converted(&damaged).is_err(), "offset {offset}");
    }
}
