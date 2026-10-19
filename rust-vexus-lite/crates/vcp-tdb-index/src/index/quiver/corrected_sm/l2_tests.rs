//! 无训练L2的精算时序、完整预算、线程一致性和实际数据库入口验证。
use super::*;

fn fixture(n: usize) -> Vec<f32> {
    let mut x = (0..n * DIM)
        .map(|j| ((j.wrapping_mul(7919) % 997) as f32 - 498.) / 16000.)
        .collect::<Vec<_>>();
    for row in x.as_chunks_mut::<DIM>().0.iter_mut() {
        let norm = row.iter().map(|&v| (v as f64).powi(2)).sum::<f64>().sqrt();
        for v in row {
            *v = (*v as f64 / norm) as f32;
        }
    }
    x
}
fn index(base: &[f32]) -> CorrectedSmIndex {
    let mut model = index_with_coefficients(base, &[]);
    model.use_reconstructed_l2();
    model
}
fn index_with_coefficients(base: &[f32], coefficients: &[f32]) -> CorrectedSmIndex {
    let n = base.len() / DIM;
    let graph = (0..n)
        .map(|u| (1..=16).map(|d| ((u + d) % n) as u32).collect())
        .collect();
    CorrectedSmIndex::from_parts(base, coefficients, graph, (0..n as u64).collect(), 0, 0).unwrap()
}
#[test]
fn l2_exact_access_is_only_final_rerank_and_budget_is_complete() {
    let base = fixture(128);
    let model = index(&base);
    for budget in [16, 32, 64, 96] {
        let cfg = QuIVerSearchConfig {
            top_k: 10,
            ef_search: 112,
            rerank_limit: Some(budget),
        };
        let expected = model
            .search_traced(
                &base[19 * DIM..20 * DIM],
                &base,
                &cfg,
                SmSearchMode::Combined,
            )
            .unwrap();
        assert_eq!(expected.trace.exact.len(), budget);
        let mut accesses = Vec::new();
        let actual = model
            .search_with_vectors(
                &base[19 * DIM..20 * DIM],
                &cfg,
                SmSearchMode::Combined,
                |id, buffer| {
                    accesses.push(id as u32);
                    buffer.extend_from_slice(&base[id * DIM..(id + 1) * DIM]);
                    true
                },
            )
            .unwrap();
        assert_eq!(
            accesses, expected.trace.exact,
            "无锚点模式不得在精排集合之外访问FP32"
        );
        assert_eq!(actual.neighbors, expected.neighbors);
        assert_eq!(
            accesses
                .iter()
                .copied()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            budget
        );
        let reference = model
            .search_traced(
                &base[19 * DIM..20 * DIM],
                &base,
                &cfg,
                SmSearchMode::Reference,
            )
            .unwrap();
        assert_eq!(reference.neighbors, expected.neighbors);
        assert_eq!(reference.trace, expected.trace);
    }
}
#[test]
fn l2_threads_reproduce_single_thread_outputs() {
    use rayon::prelude::*;
    let base = fixture(128);
    let model = index(&base);
    let cfg = QuIVerSearchConfig {
        top_k: 10,
        ef_search: 64,
        rerank_limit: Some(32),
    };
    let expected = base
        .as_chunks::<DIM>()
        .0
        .iter()
        .take(32)
        .map(|q| {
            model
                .search(q, &base, &cfg, SmSearchMode::Combined)
                .unwrap()
                .neighbors
        })
        .collect::<Vec<_>>();
    for threads in [1, 8, 16, 32] {
        let actual = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build()
            .unwrap()
            .install(|| {
                base.par_chunks_exact(DIM)
                    .take(32)
                    .map(|q| {
                        model
                            .search(q, &base, &cfg, SmSearchMode::Combined)
                            .unwrap()
                            .neighbors
                    })
                    .collect::<Vec<_>>()
            });
        assert_eq!(actual, expected);
    }
}
#[test]
fn l2_slice_slot_mapping_normalization_and_invalidation() {
    // VCP-PATCH: cold vectors belong to the caller, not upstream MemTable.
    let base = fixture(128).iter().map(|v| v * 3.).collect::<Vec<_>>();
    let mut index = QuIVer::new(DIM, &super::super::QuIVerConfig {
        m: 8,
        ef_construction: 32,
        alpha: 1.2,
    });
    let slots = (0..128).map(|i| 7 + i * 2).collect::<Vec<_>>();
    index.batch_build_experimental_v2(
        &base, &(1..=128).collect::<Vec<_>>(), &slots,
    );
    assert!(index.default_sm_l2_enabled());
    assert!(!index.corrected_sm_enabled());
    let cfg = QuIVerSearchConfig {
        top_k: 10,
        ef_search: 64,
        rerank_limit: Some(64),
    };
    let q = base[47 * DIM..48 * DIM]
        .iter()
        .map(|v| v * 7.)
        .collect::<Vec<_>>();
    let hits = index.search(
        &q,
        |slot, buffer| {
            let row = (slot - 7) / 2;
            buffer.clear();
            buffer.extend_from_slice(&base[row * DIM..(row + 1) * DIM]);
            true
        },
        &cfg,
    );
    assert_eq!(hits[0].0, 48);
    assert!((hits[0].1 - 1.).abs() < 1e-5);
    let mut seed = 42;
    index.insert(&base[..DIM], 129, 263, &mut seed);
    assert!(index.default_sm_l2_enabled(), "写入后继续使用默认SM-L2");
}
#[test]
fn l2_database_public_api_is_runtime_only_and_reload_does_not_guess_mode() {
    let directory = std::env::temp_dir().join(format!(
        "tdb-l2-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&directory).unwrap();
    let base = fixture(128);
    // VCP-PATCH: validate the public kernel route without upstream Database.
    let mut raw = QuIVer::new(DIM, &super::super::QuIVerConfig {
        m: 8, ef_construction: 32, alpha: 1.2,
    });
    raw.batch_build_experimental_v2(
        &base, &(1..=128).collect::<Vec<_>>(), &(0..128).collect::<Vec<_>>(),
    );
    assert!(raw.default_sm_l2_enabled());
    let hits = raw.search_flat(&base[23 * DIM..24 * DIM], &base,
        &QuIVerSearchConfig { top_k: 10, ef_search: 64, rerank_limit: Some(64) });
    assert!(!hits.is_empty());
    let model = index(&base);
    let path = directory.join("l2-sm.bin");
    model.save(&path).unwrap();
    let loaded = CorrectedSmIndex::load(&path, &base).unwrap();
    assert_eq!(loaded.scoring, SmScoring::CorrectedInnerProduct);
    assert!(loaded.rows.iter().all(|row| row.reconstructed_norm == 0.));
    drop(raw);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn l2_inline_norm_preserves_legacy_scores_and_owned_memory() {
    let base = fixture(128);
    let coefficients = (0..128).map(|i| (i % 7) as f32 / 100.).collect::<Vec<_>>();
    let mut model = index_with_coefficients(&base, &coefficients);
    let owned_before = model.routing_owned_bytes();
    // 保留旧独立数组的计算次序，检查迁移后的逐位评分兼容性。
    let legacy_norms = model
        .rows
        .iter()
        .map(|row| {
            let high = row.weak + row.delta;
            (DIM - row.strong_count as usize) as f32 * row.weak * row.weak
                + row.strong_count as f32 * high * high
        })
        .collect::<Vec<_>>();
    model.use_reconstructed_l2();
    assert_eq!(owned_before, model.routing_owned_bytes());
    assert_eq!(std::mem::size_of::<SmRow>(), 256);
    assert_eq!(std::mem::offset_of!(SmRow, reconstructed_norm), 204);
    let memory = model.memory_components();
    assert_eq!(memory["reconstructed_norms_bytes"], 0);
    assert_eq!(memory["inline_reconstructed_norms_bytes"], 128 * 4);
    assert_eq!(
        memory["inline_reconstructed_norms_included_in_sm_rows"],
        true
    );
    for (i, row) in model.rows.iter().enumerate() {
        assert_eq!(row.reconstructed_norm.to_bits(), legacy_norms[i].to_bits());
        assert_eq!(row.coefficient.to_bits(), coefficients[i].to_bits());
    }
    for query in base.as_chunks::<DIM>().0.iter().step_by(13) {
        let q = query_scalar(query);
        let high = q.weak + q.delta;
        let norm = (DIM as f32 - q.count) * q.weak * q.weak + q.count * high * high;
        for (id, row) in model.rows.iter().enumerate() {
            let expected = 1. - (norm + legacy_norms[id] - 2. * scalar_score(row, &q));
            assert_eq!(
                model.navigation_score(&q, id, 0., norm, false).to_bits(),
                expected.to_bits()
            );
        }
    }
}

#[test]
fn l2_inline_norm_keeps_snapshot_bytes_and_reload_behavior() {
    let directory = std::env::temp_dir().join(format!(
        "tdb-inline-norm-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&directory).unwrap();
    let base = fixture(128);
    let coefficients = vec![0.125; 128];
    let mut model = index_with_coefficients(&base, &coefficients);
    let before = directory.join("before.bin");
    let after = directory.join("after.bin");
    model.save(&before).unwrap();
    model.use_reconstructed_l2();
    model.save(&after).unwrap();
    assert_eq!(
        std::fs::read(&before).unwrap(),
        std::fs::read(&after).unwrap()
    );
    let cfg = QuIVerSearchConfig {
        top_k: 10,
        ef_search: 64,
        rerank_limit: Some(32),
    };
    let expected = model
        .search_traced(
            &base[19 * DIM..20 * DIM],
            &base,
            &cfg,
            SmSearchMode::Combined,
        )
        .unwrap();
    let mut loaded = CorrectedSmIndex::load(&after, &base).unwrap();
    assert_eq!(loaded.scoring, SmScoring::CorrectedInnerProduct);
    assert!(loaded.rows.iter().all(|row| row.reconstructed_norm == 0.));
    loaded.use_reconstructed_l2();
    let actual = loaded
        .search_traced(
            &base[19 * DIM..20 * DIM],
            &base,
            &cfg,
            SmSearchMode::Combined,
        )
        .unwrap();
    assert_eq!(actual.neighbors, expected.neighbors);
    assert_eq!(actual.trace, expected.trace);
    assert_eq!(actual.counts, expected.counts);
    std::fs::remove_dir_all(directory).unwrap();
}
