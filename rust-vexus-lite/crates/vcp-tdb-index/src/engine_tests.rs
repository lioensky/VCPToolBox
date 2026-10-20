use super::*;

struct Root(std::path::PathBuf);
impl Root {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "vcp-engine-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Root {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}
fn identity(dim: usize) -> AssetIdentity {
    AssetIdentity { dimension: dim, scope: 0, model_hash: [3; 32], content_digest: [4; 32] }
}

#[test]
fn flat_cosine_and_invalid_batches_preserve_state() {
    let mut index = TdbIndex::empty(3).unwrap();
    index.upsert_batch(&[1, 2, 3, 4],
        &[3.0, 0.0, 0.0, 0.0, 5.0, 0.0, -7.0, 0.0, 0.0, 0.0, 0.0, 0.0]).unwrap();
    let before = index.search(&[2.0, 0.0, 0.0], 10, None).unwrap();
    assert_eq!(before, vec![(1, 1.0), (2, 0.0), (4, 0.0), (3, -1.0)]);
    for (ids, rows) in [
        (vec![1, 1], vec![1.0; 6]),
        (vec![0], vec![1.0; 3]),
        (vec![1], vec![1.0; 2]),
        (vec![1], vec![f32::NAN; 3]),
    ] {
        assert!(index.upsert_batch(&ids, &rows).is_err());
        assert_eq!(index.search(&[2.0, 0.0, 0.0], 10, None).unwrap(), before);
    }
    assert!(index.remove_batch(&[1, 0]).is_err());
    assert!(index.apply_delta(&[1], &[2], &[f32::NAN; 3]).is_err());
    assert!(index.apply_delta(&[1], &[2, 2], &[1.0; 6]).is_err());
    assert_eq!(index.search(&[2.0, 0.0, 0.0], 10, None).unwrap(), before);
    assert_eq!(index.len(), 4);
    assert_eq!(index.apply_delta(&[1, 1], &[2], &[6.0, 0.0, 0.0]).unwrap(), 1);
    assert!(!index.contains(1));
    assert_eq!(index.search(&[1.0, 0.0, 0.0], 1, None).unwrap(), vec![(2, 1.0)]);
    assert!(index.search(&[f32::INFINITY; 3], 10, None).is_err());
    assert!(index.search(&[1.0], 10, None).is_err());
    assert!(index.search(&[1.0; 3], 0, None).unwrap().is_empty());
}

#[test]
fn mmap_updates_deletion_slot_reuse_and_compaction_roundtrip() {
    let root = Root::new();
    let expected = identity(3);
    let first = root.0.join("a.vec");
    let second = root.0.join("b.vec");
    let originals = [[1.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 3.0]];
    let streamed = TdbIndex::rebuild_from_source(
        &first, &expected, &[1, 2, 3], |slot, row| {
            row.extend_from_slice(&originals[slot]);
            true
        },
    ).unwrap();
    assert_eq!(streamed.delta_bytes(), 0);
    assert!(streamed.mapped_bytes() > 0);
    drop(streamed);
    let mut loaded = TdbIndex::load_snapshot(&first, &expected).unwrap();
    assert_eq!(loaded.delta_bytes(), 0);
    assert!(loaded.mapped_bytes() > 0);
    loaded.upsert_batch(&[1], &[0.0, -4.0, 0.0]).unwrap();
    assert_eq!(loaded.remove_batch(&[2, 2, 999]).unwrap(), 1);
    loaded.upsert_batch(&[7], &[5.0, 0.0, 0.0]).unwrap();
    assert!(!loaded.contains(2));
    let before = loaded.search(&[1.0, 0.0, 0.0], 10, None).unwrap();
    assert_eq!(before[0], (7, 1.0));
    loaded.write_staging(&second, &expected).unwrap();
    let restored = TdbIndex::load_snapshot(&second, &expected).unwrap();
    assert_eq!(restored.delta_bytes(), 0);
    assert_eq!(restored.len(), 3);
    assert_eq!(restored.search(&[1.0, 0.0, 0.0], 10, None).unwrap(), before);
    assert_eq!(restored.tombstones(), 0);
}

#[test]
fn compact_graph_identity_rejects_wrong_ids_dimensions_and_slots() {
    let config = QuIVerConfig::default();
    let mut graph = QuIVer::new(3, &config);
    graph.rebuild_from_cold_slots(&[7, 9], &[0, 1], &config, |slot, row| {
        row.extend_from_slice(if slot == 0 { &[1.0, 0.0, 0.0] } else { &[0.0, 1.0, 0.0] });
        true
    }).unwrap();
    graph.validate_compact_slots(3, &[7, 9]).unwrap();
    assert!(graph.validate_compact_slots(2, &[7, 9]).is_err());
    assert!(graph.validate_compact_slots(3, &[9, 7]).is_err());
    graph.soft_delete(7);
    assert!(graph.validate_compact_slots(3, &[7, 9]).is_err());
}

#[test]
#[ignore = "diagnostic: compare upstream reachability across dimensions and intrinsic structure"]
fn upstream_connectivity_dimension_matrix() {
    let count = 2048;
    let ids: Vec<u64> = (1..=count as u64).collect();
    let slots: Vec<usize> = (0..count).collect();
    for dimension in [3, 65, 768, 3072] {
        for degenerate in [false, true] {
            for attempt in 0..3 {
                let mut seed = 918273_u64;
                let mut store = crate::index::bq::Bq2Store::new(dimension);
                let mut signatures = std::collections::HashSet::new();
                for id in 1..=count {
                    let angle = id as f32 * 0.013;
                    let pattern = [angle.cos(), angle.sin(), 0.25];
                    let row: Vec<f32> = (0..dimension).map(|column| {
                        if degenerate {
                            pattern[column % 3]
                        } else {
                            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                            ((seed >> 32) as u32 as f64 / u32::MAX as f64 * 2.0 - 1.0) as f32
                        }
                    }).collect();
                    let signature = crate::index::bq::Bq2Signature::from_vector(&row);
                    signatures.insert((signature.pos, signature.strong));
                    store.push_from_vector(&row);
                }
                let mut graph = QuIVer::new(dimension, &QuIVerConfig::default());
                graph.batch_build_from_store(&ids, &slots, store);
                eprintln!(
                    "dimension={dimension} degenerate={degenerate} attempt={attempt} unique_signatures={} reachable={}/{count}",
                    signatures.len(), graph.reachable_node_count(),
                );
            }
        }
    }
}

#[test]
#[ignore = "diagnostic: reproduces upstream builder connectivity gap without host wrappers"]
fn upstream_builder_dense_connectivity_diagnostic() {
    let count = 2048;
    let ids: Vec<u64> = (1..=count as u64).collect();
    let slots: Vec<usize> = (0..count).collect();
    let mut disconnected = 0;
    for attempt in 0..10 {
        let mut store = crate::index::bq::Bq2Store::new(3);
        for id in 1..=count {
            let angle = id as f32 * 0.013;
            store.push_from_vector(&[angle.cos(), angle.sin(), 0.25]);
        }
        let mut graph = QuIVer::new(3, &QuIVerConfig::default());
        // Invoke the unchanged upstream builder directly: no SQL, mmap,
        // cold-slot wrapper, default SM preparation, or connectivity repair.
        graph.batch_build_from_store(&ids, &slots, store);
        let reachable = graph.reachable_node_count();
        eprintln!("upstream-builder attempt={attempt} reachable={reachable}/{count}");
        disconnected += usize::from(reachable != count);
    }
    assert!(disconnected > 0, "connectivity gap did not reproduce in this run");
}

#[test]
fn dense_low_dimensional_graph_reaches_every_node() {
    let count = QUIVER_MIN_NODES;
    let ids: Vec<u64> = (1..=count as u64).collect();
    let slots: Vec<usize> = (0..count).collect();
    for attempt in 0..10 {
        let mut graph = QuIVer::new(3, &QuIVerConfig::default());
        graph.rebuild_from_cold_slots(
            &ids, &slots, &QuIVerConfig::default(), |slot, row| {
                let angle = (slot + 1) as f32 * 0.013;
                row.extend_from_slice(&[angle.cos(), angle.sin(), 0.25]);
                true
            },
        ).unwrap();
        assert_eq!(graph.reachable_node_count(), count,
            "cold-slot graph is disconnected on build {}", attempt);
    }
}

#[test]
fn quiver_mmap_roundtrip_and_incremental_reused_slots() {
    let root = Root::new();
    let dim = 65;
    let count = QUIVER_MIN_NODES;
    let expected = identity(dim);
    let path = root.0.join("graph.vec");
    let ids: Vec<u64> = (1..=count as u64).collect();
    let mut seed = 918273_u64;
    let vectors: Vec<f32> = (0..count * dim).map(|_| {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        ((seed >> 32) as u32 as f64 / u32::MAX as f64 * 2.0 - 1.0) as f32
    }).collect();
    let mut index = TdbIndex::empty(dim).unwrap();
    index.upsert_batch(&ids, &vectors).unwrap();
    assert!(index.needs_graph_rebuild());
    index.rebuild_graph().unwrap();
    assert!(!index.needs_graph_rebuild());
    let query = &vectors[17 * dim..18 * dim];
    let before = index.search(query, 10, Some(256)).unwrap();
    assert_eq!(before[0].0, 18);
    assert!((before[0].1 - 1.0).abs() < 1e-5);
    index.write_staging(&path, &expected).unwrap();
    let mut loaded = TdbIndex::load_snapshot(&path, &expected).unwrap();
    assert!(loaded.graph.is_some());
    assert_eq!(loaded.delta_bytes(), 0);
    let after = loaded.search(query, 10, Some(256)).unwrap();
    assert_eq!(before.iter().map(|v| v.0).collect::<Vec<_>>(),
        after.iter().map(|v| v.0).collect::<Vec<_>>());
    assert_eq!(loaded.remove_batch(&[18]).unwrap(), 1);
    loaded.upsert_batch(&[9000], query).unwrap();
    let changed = loaded.search(query, 10, Some(256)).unwrap();
    assert_eq!(changed[0].0, 9000);
    assert!(changed.iter().all(|v| v.0 != 18));
    let replacement: Vec<f32> = query.iter().map(|v| -*v).collect();
    loaded.upsert_batch(&[9000], &replacement).unwrap();
    let updated = loaded.search(&replacement, 10, Some(256)).unwrap();
    assert_eq!(updated[0].0, 9000);
    assert_eq!(loaded.len(), count);
    assert!(loaded.tombstones() >= 2);
    assert_eq!(loaded.graph.as_ref().unwrap().stats().dirty_count, 4);
    let removed: Vec<u64> = (100..=1000).collect();
    loaded.remove_batch(&removed).unwrap();
    assert!(loaded.len() < QUIVER_MIN_NODES);
    assert!(loaded.needs_graph_rebuild(),
        "mass deletion must not strand an oversized dirty graph below threshold");
    loaded.rebuild_graph().unwrap();
    assert!(loaded.graph.is_none());
    assert!(!loaded.needs_graph_rebuild());
    assert_eq!(loaded.search(&replacement, 1, None).unwrap()[0].0, 9000);
}

#[test]
fn external_source_controls_scores_without_retained_originals() {
    let mut index = TdbIndex::routing_from_source(3, &[7, 9], |_, _| {
        panic!("small flat routing needs identities only")
    }).unwrap();
    assert_eq!(index.mapped_bytes(), 0);
    assert_eq!(index.delta_bytes(), 0);
    index.upsert_batch(&[7], &[-9.0, 0.0, 0.0]).unwrap();
    let search = |index: &TdbIndex| index.search_with_source(
        &[1.0, 0.0, 0.0], 2, None, |id, row| {
            row.clear();
            row.extend_from_slice(if id == 7 { &[3.0, 0.0, 0.0] } else { &[0.0, 4.0, 0.0] });
            true
        },
    ).unwrap();
    assert_eq!(search(&index), vec![(7, 1.0), (9, 0.0)]);
    index.release_originals();
    assert_eq!(index.delta_bytes(), 0);
    assert_eq!(search(&index), vec![(7, 1.0), (9, 0.0)]);
    assert!(TdbIndex::routing_from_source(3, &[7, 7], |_, _| false).is_err());
}

#[test]
fn graph_routing_build_retains_no_original_matrix_or_mapping() {
    let ids: Vec<u64> = (1..=QUIVER_MIN_NODES as u64).collect();
    let mut reads = 0;
    let index = TdbIndex::routing_from_source(65, &ids, |slot, row| {
        reads += 1;
        row.extend((0..65).map(|column| ((slot * 37 + column * 13 + 1) as f32).sin()));
        true
    }).unwrap();
    assert_eq!(reads, ids.len() * 2);
    assert_eq!(index.mapped_bytes(), 0);
    assert_eq!(index.delta_bytes(), 0);
    assert!(!index.needs_graph_rebuild());
    let query: Vec<f32> = (0..65).map(|column| ((17 * 37 + column * 13 + 1) as f32).sin()).collect();
    let hits = index.search_with_source(&query, 10, Some(256), |id, row| {
        row.clear();
        row.extend((0..65).map(|column| (((id as usize - 1) * 37 + column * 13 + 1) as f32).sin()));
        true
    }).unwrap();
    assert!(hits.iter().any(|(id, score)| *id == 18 && (*score - 1.0).abs() < 1e-5));
}