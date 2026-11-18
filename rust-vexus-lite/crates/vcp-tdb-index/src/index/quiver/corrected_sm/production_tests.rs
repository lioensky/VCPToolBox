//! 默认路由、预算边界、并发、墓碑与旧索引恢复的生产回归。
use super::super::QuIVerConfig;
use super::*;

fn vectors(n: usize, dim: usize) -> Vec<f32> {
    let mut seed = 20261018u64;
    let mut base = (0..n * dim)
        .map(|_| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            ((seed >> 32) as i32) as f32 / i32::MAX as f32
        })
        .collect::<Vec<_>>();
    for row in base.chunks_exact_mut(dim) {
        let norm = row.iter().map(|&x| (x as f64).powi(2)).sum::<f64>().sqrt();
        for x in row {
            *x = (*x as f64 / norm) as f32;
        }
    }
    base
}

fn built(base: &[f32], dim: usize) -> QuIVer {
    let n = base.len() / dim;
    let mut index = QuIVer::new(
        dim,
        &QuIVerConfig {
            m: 8,
            ef_construction: 32,
            alpha: 1.2,
        },
    );
    index.batch_build_experimental_v2(
        base,
        &(1..=n as u64).collect::<Vec<_>>(),
        &(0..n).collect::<Vec<_>>(),
    );
    index
}

#[test]
fn default_matches_explicit_reference_for_dimensions_and_budget_boundaries() {
    for dim in [1, 65, 768, 960, 1536, 3072] {
        let base = vectors(96, dim);
        let index = built(&base, dim);
        assert!(index.default_sm_l2_enabled());
        assert!(index.sm_l2_enabled());
        assert!(!index.corrected_sm_enabled());
        let mut reference = index.corrected_sm_snapshot(&base, &[]).unwrap();
        reference.use_reconstructed_l2();
        for (ef, top_k, limit) in [
            (32, 10, Some(64)),
            (48, 10, None),
            (80, 10, Some(16)),
            (32, 70, Some(16)),
            (128, 10, None),
        ] {
            let cfg = QuIVerSearchConfig {
                top_k,
                ef_search: ef,
                rerank_limit: limit,
            };
            let ef = ef.max(top_k).min(96);
            let budget = limit.unwrap_or(64).max(top_k).min(ef);
            let reference_cfg = QuIVerSearchConfig {
                top_k,
                ef_search: ef,
                rerank_limit: Some(budget),
            };
            let query = &base[19 * dim..20 * dim];
            let expected = reference
                .search(query, &base, &reference_cfg, SmSearchMode::Reference)
                .unwrap();
            let mut reads = Vec::new();
            let actual = index.search(
                query,
                |slot, buffer| {
                    reads.push(slot);
                    buffer.extend_from_slice(&base[slot * dim..(slot + 1) * dim]);
                    true
                },
                &cfg,
            );
            assert_eq!(actual, expected.neighbors, "维度{dim}、宽度{ef}");
            assert!(reads.len() <= budget, "不能在导航阶段读冷向量或超出预算");
        }
    }
}

#[test]
fn mutation_keeps_default_and_never_reads_deleted_reused_slot_as_old_id() {
    for dim in [65, 768] {
        let mut base = vectors(96, dim);
        let mut index = built(&base, dim);
        index.enable_corrected_sm(&base, &vec![0.; 96]).unwrap();
        assert!(index.soft_delete(8));
        assert!(index.default_sm_l2_enabled());
        let replacement = base[20 * dim..21 * dim].to_vec();
        base[7 * dim..8 * dim].copy_from_slice(&replacement);
        let mut seed = 42;
        index.insert(&replacement, 1000, 7, &mut seed);
        assert!(index.default_sm_l2_enabled());
        assert_eq!(index.default_sm.as_ref().unwrap().len(), 97);
        let cfg = QuIVerSearchConfig {
            top_k: 96,
            ef_search: 97,
            rerank_limit: Some(97),
        };
        let hits = index.search_flat(&replacement, &base, &cfg);
        assert!(
            !hits.iter().any(|hit| hit.0 == 8),
            "墓碑ID不得读取复用slot后复活"
        );
        assert!(
            hits.iter().any(|hit| hit.0 == 1000),
            "增量节点必须进入SM路由"
        );
        assert!(hits.iter().all(|hit| hit.1.is_finite()));
    }
}

#[test]
fn high_degree_zero_vectors_and_filters_preserve_exact_budget_and_cosine() {
    for dim in [65, 768] {
        let n = 96;
        let mut base = vectors(n, dim);
        base[..dim].fill(0.);
        let mut index = built(&base, dim);
        // 显式覆盖超过64条邻边，验证固定大小SIMD批次不会越界。
        index.layer0 = FlatAdj::new(n);
        index.layer0.reset_full(n);
        for u in 0..n {
            index.layer0.set_neighbors(
                u as u32,
                &(0..n as u32).filter(|&v| v != u as u32).collect::<Vec<_>>(),
            );
        }
        let cfg = QuIVerSearchConfig {
            top_k: 10,
            ef_search: n,
            rerank_limit: Some(16),
        };
        let query = &base[19 * dim..20 * dim];
        let mut successful = 0;
        let hits = index.search(
            query,
            |slot, buffer| {
                if slot % 3 != 0 {
                    return false;
                }
                successful += 1;
                buffer.extend_from_slice(&base[slot * dim..(slot + 1) * dim]);
                true
            },
            &cfg,
        );
        assert_eq!(hits.len(), 10);
        assert_eq!(successful, 16, "过滤拒绝不占成功精排名额");
        for &(id, score) in &hits {
            let slot = id as usize - 1;
            assert_eq!(slot % 3, 0);
            let exact = super::super::cosine_sim(query, &base[slot * dim..(slot + 1) * dim]);
            assert!((score - exact).abs() < 1e-5, "最终仍是余弦分数");
        }
        let zeros = index.search_flat(&vec![0.; dim], &base, &cfg);
        assert_eq!(zeros.len(), 10);
        assert!(zeros.iter().all(|hit| hit.1 == 0.));
    }
}

#[test]
fn graph_reload_restores_default_from_cold_slice_callback() {
    // VCP-PATCH: upstream Database is intentionally not part of this crate.
    for dim in [65, 768, 3072] {
        let directory = std::env::temp_dir().join(format!(
            "vcp-default-sm-{}-{dim}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("graph.quiv");
        let base = vectors(96, dim).iter().map(|v| v * 3.).collect::<Vec<_>>();
        let index = built(&base, dim);
        let cfg = QuIVerSearchConfig {
            top_k: 10, ef_search: 96, rerank_limit: Some(96),
        };
        let query = &base[23 * dim..24 * dim];
        let expected = index.search_flat(query, &base, &cfg);
        assert_eq!(expected[0].0, 24);
        assert!((expected[0].1 - 1.).abs() < 1e-5);
        index.save_to_file(&path).unwrap();
        for _ in 0..2 {
            let mut loaded = QuIVer::load_from_file(&path).unwrap();
            assert!(!loaded.default_sm_ready());
            loaded.prepare_default_sm(|slot, out| {
                out.clear();
                out.extend_from_slice(&base[slot * dim..(slot + 1) * dim]);
                true
            }).unwrap();
            assert!(loaded.default_sm_l2_enabled());
            let actual = loaded.search_flat(query, &base, &cfg);
            assert_eq!(
                actual.iter().map(|v| (v.0, v.1.to_bits())).collect::<Vec<_>>(),
                expected.iter().map(|v| (v.0, v.1.to_bits())).collect::<Vec<_>>()
            );
        }
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn default_is_thread_deterministic_and_reports_owned_memory() {
    use rayon::prelude::*;
    for dim in [65, 768] {
        let base = vectors(128, dim);
        let index = built(&base, dim);
        let cfg = QuIVerSearchConfig {
            top_k: 10,
            ef_search: 80,
            rerank_limit: None,
        };
        let expected = base
            .chunks_exact(dim)
            .take(16)
            .map(|q| index.search_flat(q, &base, &cfg))
            .collect::<Vec<_>>();
        for threads in [1, 4, 8] {
            let actual = rayon::ThreadPoolBuilder::new()
                .num_threads(threads)
                .build()
                .unwrap()
                .install(|| {
                    base.par_chunks_exact(dim)
                        .take(16)
                        .map(|q| index.search_flat(q, &base, &cfg))
                        .collect::<Vec<_>>()
                });
            assert_eq!(actual, expected);
        }
        let memory = index.corrected_sm_memory_components().unwrap();
        assert!(memory["default_sm_owned_bytes"].as_u64().unwrap() > 0);
        assert_eq!(memory["explicit_sm_owned_bytes"], 0);
        assert!(index.stats().hot_bytes >= memory["sm_owned_bytes"].as_u64().unwrap() as usize);
        assert_eq!(
            index.default_sm.as_ref().unwrap().graph.data.capacity(),
            0,
            "默认SM不复制图"
        );
    }
}

#[test]
fn finite_extreme_magnitudes_and_redundant_enable_keep_cosine_and_single_sm_copy() {
    for dim in [65, 768] {
        let mut base = vectors(48, dim);
        for (i, row) in base.chunks_exact_mut(dim).enumerate() {
            let scale = if i % 2 == 0 { 1e-40 } else { 1e37 };
            for value in row {
                *value *= scale;
            }
        }
        let mut index = built(&base, dim);
        let bytes = index.default_sm.as_ref().unwrap().routing_owned_bytes();
        index
            .enable_sm_l2_with_vectors(|_, _| panic!("默认已就绪时不应重新读取整库"))
            .unwrap();
        assert!(index.corrected_sm.is_none());
        assert_eq!(
            index.default_sm.as_ref().unwrap().routing_owned_bytes(),
            bytes
        );
        let cfg = QuIVerSearchConfig {
            top_k: 1,
            ef_search: 48,
            rerank_limit: Some(48),
        };
        for i in [4, 5] {
            let hits = index.search_flat(&base[i * dim..(i + 1) * dim], &base, &cfg);
            assert_eq!(hits[0].0, i as u64 + 1);
            assert!((hits[0].1 - 1.).abs() < 1e-5, "极端合法幅值仍须按余弦精排");
        }
    }
}
