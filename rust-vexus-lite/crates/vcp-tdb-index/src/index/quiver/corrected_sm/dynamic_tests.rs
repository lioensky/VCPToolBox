//! 通用维度的数值、尾位、实际数据库路由和持久化门禁。
use super::*;

fn vectors(n: usize, dim: usize) -> Vec<f32> {
    let mut state = 0x91ac_3f17u64 ^ dim as u64;
    let mut base = (0..n * dim)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            ((state % 2001) as f32 - 1000.) / 1001.
        })
        .collect::<Vec<_>>();
    for row in base.chunks_mut(dim) {
        let norm = row.iter().map(|&x| (x as f64).powi(2)).sum::<f64>().sqrt();
        if norm == 0. {
            row[0] = 1.;
        } else {
            for x in row {
                *x = (*x as f64 / norm) as f32;
            }
        }
    }
    base
}
fn model(dim: usize, base: &[f32]) -> CorrectedSmIndex {
    let n = base.len() / dim;
    let graph = (0..n)
        .map(|u| (1..=16.min(n - 1)).map(|d| ((u + d) % n) as u32).collect())
        .collect();
    CorrectedSmIndex::from_vectors_and_graph(dim, base, graph, (1..=n as u64).collect(), 0).unwrap()
}
fn same(a: &SmSearchOutput, b: &SmSearchOutput) {
    assert_eq!(a.counts, b.counts);
    assert_eq!(a.trace, b.trace);
    assert_eq!(
        a.neighbors
            .iter()
            .map(|&(id, s)| (id, s.to_bits()))
            .collect::<Vec<_>>(),
        b.neighbors
            .iter()
            .map(|&(id, s)| (id, s.to_bits()))
            .collect::<Vec<_>>()
    );
}
fn directory() -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "tdb-dynamic-sm-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&path).unwrap();
    path
}

#[test]
fn every_tail_shape_scalar_simd_and_independent_reconstruction_agree() {
    let dims = [
        1, 2, 7, 8, 15, 16, 17, 31, 32, 63, 64, 65, 127, 128, 129, 255, 384, 511, 512, 767, 769,
        1023, 1024, 1025, 1535, 1536, 1537, 2049, 3071, 3072,
    ];
    for dim in dims {
        let base = vectors(12, dim);
        let m = model(dim, &base);
        let dynamic = m.dynamic.as_ref().unwrap();
        assert_eq!(dynamic.row_bytes() % 64, 0);
        assert_eq!(dynamic.row(0).as_ptr() as usize % 64, 0);
        for q in base.chunks_exact(dim).take(3) {
            let mut scalar = DynamicQuery::default();
            scalar.encode(q, false);
            let mut optimized = DynamicQuery::default();
            optimized.encode(q, true);
            assert_eq!(scalar.pos, optimized.pos);
            assert_eq!(scalar.strong, optimized.strong);
            assert_eq!(scalar.weak.to_bits(), optimized.weak.to_bits());
            assert_eq!(scalar.delta.to_bits(), optimized.delta.to_bits());
            for id in 0..12 {
                let a = dynamic.score(&scalar, id, false);
                let b = dynamic.score(&optimized, id, true);
                assert_eq!(a.to_bits(), b.to_bits(), "维度{dim}节点{id}位计数不一致");
                let row = dynamic.row(id);
                let (weak, delta, _, _, _) = dynamic.metadata(id);
                let mut expected = 0f64;
                for j in 0..dim {
                    let x = (weak
                        + if row[dynamic.words + j / 64] >> (j % 64) & 1 != 0 {
                            delta
                        } else {
                            0.
                        }) as f64;
                    let y = (scalar.weak
                        + if scalar.strong[j / 64] >> (j % 64) & 1 != 0 {
                            scalar.delta
                        } else {
                            0.
                        }) as f64;
                    let sign = if (row[j / 64] ^ scalar.pos[j / 64]) >> (j % 64) & 1 == 0 {
                        1.
                    } else {
                        -1.
                    };
                    expected += sign * x * y;
                }
                assert!(
                    (a as f64 - expected).abs() < 2e-5,
                    "维度{dim}独立重建内积不一致"
                );
            }
        }
    }
}

#[test]
fn extreme_bits_and_dimension_above_ten_bit_count_have_no_carry() {
    for dim in [65usize, 1025, 1536, 1537, 3072] {
        let mut base = vec![1. / (dim as f32).sqrt(); dim * 8];
        for row in base.chunks_mut(dim).skip(4) {
            for x in row {
                *x = -*x;
            }
        }
        let m = model(dim, &base);
        let dynamic = m.dynamic.as_ref().unwrap();
        for all in [false, true] {
            let mut q = DynamicQuery::default();
            q.encode(&base[..dim], false);
            let mask = if dim % 64 == 0 {
                u64::MAX
            } else {
                (1u64 << (dim % 64)) - 1
            };
            for j in 0..dynamic.words {
                q.pos[j] = if j + 1 == dynamic.words {
                    mask
                } else {
                    u64::MAX
                };
                q.strong[j] = if all { q.pos[j] } else { 0 };
            }
            for id in 0..8 {
                assert_eq!(
                    dynamic.score(&q, id, false).to_bits(),
                    dynamic.score(&q, id, true).to_bits()
                );
            }
        }
        let q = &base[..dim];
        let cfg = QuIVerSearchConfig {
            top_k: 4,
            ef_search: 8,
            rerank_limit: Some(8),
        };
        same(
            &m.search_traced(q, &base, &cfg, SmSearchMode::Reference)
                .unwrap(),
            &m.search_traced(q, &base, &cfg, SmSearchMode::Combined)
                .unwrap(),
        );
    }
}

#[test]
fn dynamic_trace_budget_callback_and_workspace_reuse_are_exact() {
    for dim in [65usize, 1536, 767, 3072, 17, 769] {
        let base = vectors(96, dim);
        let m = model(dim, &base);
        for budget in [16, 32, 64] {
            let cfg = QuIVerSearchConfig {
                top_k: 10,
                ef_search: 80,
                rerank_limit: Some(budget),
            };
            let q = &base[19 * dim..20 * dim];
            let a = m
                .search_traced(q, &base, &cfg, SmSearchMode::Reference)
                .unwrap();
            let b = m
                .search_traced(q, &base, &cfg, SmSearchMode::Combined)
                .unwrap();
            same(&a, &b);
            let mut read = Vec::new();
            let c = m
                .search_with_vectors(q, &cfg, SmSearchMode::Combined, |id, out| {
                    read.push(id as u32);
                    out.extend_from_slice(&base[id * dim..(id + 1) * dim]);
                    true
                })
                .unwrap();
            assert_eq!(c.neighbors, b.neighbors);
            assert_eq!(read, b.trace.exact);
            assert_eq!(read.len(), budget);
            assert_eq!(
                read.iter().collect::<std::collections::HashSet<_>>().len(),
                budget
            );
            let missing = m
                .search_with_vectors(q, &cfg, SmSearchMode::Combined, |id, out| {
                    if id == read[0] as usize {
                        return false;
                    }
                    out.extend_from_slice(&base[id * dim..(id + 1) * dim]);
                    true
                })
                .unwrap();
            assert_eq!(missing.counts[4], budget.min(cfg.ef_search - 1));
            assert!(
                m.search_with_vectors(q, &cfg, SmSearchMode::Combined, |_, out| {
                    out.push(1.);
                    true
                })
                .is_err()
            );
        }
    }
}

#[test]
fn portable_modes_and_legacy_768_roundtrip_and_corruption_rejection() {
    let directory = directory();
    for dim in [17usize, 65, 768, 1536, 3072] {
        let base = vectors(32, dim);
        let m = model(dim, &base);
        let path = directory.join(format!("{dim}.sm"));
        m.save_portable(&path).unwrap();
        assert!(m.save_portable(&path).is_err());
        let loaded = CorrectedSmIndex::load(&path, &base).unwrap();
        assert_eq!(loaded.dimension(), dim);
        assert_eq!(loaded.scoring, SmScoring::ReconstructedL2);
        if dim == 768 {
            assert!(loaded.dynamic.is_none());
            assert_eq!(std::mem::size_of::<SmRow>(), 256);
        }
        let cfg = QuIVerSearchConfig {
            top_k: 10,
            ef_search: 32,
            rerank_limit: Some(16),
        };
        same(
            &m.search_traced(&base[..dim], &base, &cfg, SmSearchMode::Combined)
                .unwrap(),
            &loaded
                .search_traced(&base[..dim], &base, &cfg, SmSearchMode::Combined)
                .unwrap(),
        );
        let mut wrong = base.clone();
        wrong[0] += 0.01;
        assert!(CorrectedSmIndex::load(&path, &wrong).is_err());
        let mut bytes = std::fs::read(&path).unwrap();
        bytes[45] ^= 1;
        let bad = directory.join(format!("{dim}-bad.sm"));
        std::fs::write(&bad, &bytes).unwrap();
        assert!(CorrectedSmIndex::load(&bad, &base).is_err());
        if dim == 768 {
            let legacy = directory.join("legacy.sm");
            m.save(&legacy).unwrap();
            let old = CorrectedSmIndex::load(&legacy, &base).unwrap();
            assert_eq!(old.scoring, SmScoring::CorrectedInnerProduct);
        }
        if dim % 64 != 0 {
            let mut bytes = std::fs::read(&path).unwrap();
            let last = 40 + 8 + (dim.div_ceil(64) - 1) * 8;
            let word = u64::from_le_bytes(bytes[last..last + 8].try_into().unwrap()) | (1u64 << 63);
            bytes[last..last + 8].copy_from_slice(&word.to_le_bytes());
            let tail = bytes.len() - 4;
            let crc = crc32fast::hash(&bytes[..tail]);
            bytes[tail..].copy_from_slice(&crc.to_le_bytes());
            let bad = directory.join(format!("{dim}-tail.sm"));
            std::fs::write(&bad, &bytes).unwrap();
            assert!(CorrectedSmIndex::load(&bad, &base).is_err());
        }
    }
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn slice_callback_routes_generic_dimensions_and_preserves_default_after_mutation() {
    // VCP-PATCH: cover upstream database routing using the kernel's cold callback.
    for dim in [65usize, 1536, 3072] {
        let base = vectors(96, dim).iter().map(|x| x * 3.).collect::<Vec<_>>();
        let mut index = QuIVer::new(dim, &super::super::super::QuIVerConfig {
            m: 8,
            ef_construction: 32,
            alpha: 1.2,
        });
        index.batch_build_experimental_v2(
            &base,
            &(1..=96).collect::<Vec<_>>(),
            &(0..96).collect::<Vec<_>>(),
        );
        index.enable_sm_l2_with_vectors(|_, _| panic!("default SM already ready")).unwrap();
        assert!(index.default_sm_l2_enabled());
        let q = base[23 * dim..24 * dim]
            .iter()
            .map(|x| x * 7.)
            .collect::<Vec<_>>();
        let cfg = QuIVerSearchConfig {
            top_k: 10,
            ef_search: 96,
            rerank_limit: Some(96),
        };
        let hits = index.search(&q, |slot, out| {
            out.clear();
            out.extend_from_slice(&base[slot * dim..(slot + 1) * dim]);
            true
        }, &cfg);
        assert_eq!(hits[0].0, 24);
        assert!((hits[0].1 - 1.).abs() < 1e-5);
        let mut seed = 42;
        index.insert(&base[..dim], 97, 96, &mut seed);
        assert!(index.default_sm_l2_enabled(), "写入后继续使用默认SM-L2");
    }
}

#[test]
fn dynamic_threads_and_fast_build_use_the_same_public_route() {
    use rayon::prelude::*;
    for dim in [65usize, 1536] {
        let base = vectors(96, dim);
        let mut m = CorrectedSmIndex::build_fast_with_dimension(
            dim,
            &base,
            &[],
            &super::super::super::QuIVerConfig {
                m: 8,
                ef_construction: 32,
                alpha: 1.2,
            },
            2,
        )
        .unwrap();
        m.use_reconstructed_l2();
        let cfg = QuIVerSearchConfig {
            top_k: 10,
            ef_search: 64,
            rerank_limit: Some(32),
        };
        let expected = base
            .chunks_exact(dim)
            .take(16)
            .map(|q| {
                m.search(q, &base, &cfg, SmSearchMode::Combined)
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
                    base.par_chunks_exact(dim)
                        .take(16)
                        .map(|q| {
                            m.search(q, &base, &cfg, SmSearchMode::Combined)
                                .unwrap()
                                .neighbors
                        })
                        .collect::<Vec<_>>()
                });
            assert_eq!(actual, expected);
        }
    }
}

#[test]
fn invalid_dimensions_and_peak_estimates_do_not_retain_768_assumptions() {
    for dim in [0usize, 3073] {
        assert!(CorrectedSmIndex::from_vectors_and_graph(dim, &[], vec![], vec![], 0).is_err());
    }
    let config = super::super::super::QuIVerConfig {
        m: 8,
        ef_construction: 32,
        alpha: 1.2,
    };
    let mut peaks = Vec::new();
    for dim in [768usize, 1536, 3072] {
        let base = vectors(32, dim);
        let mut index = QuIVer::new(dim, &config);
        index.batch_build(
            &base,
            &(1..=32).collect::<Vec<_>>(),
            &(0..32).collect::<Vec<_>>(),
        );
        peaks.push(index.sm_install_peak_extra_bytes());
    }
    assert!(peaks[0] < peaks[1] && peaks[1] < peaks[2]);
}

#[test]
fn generic_corrected_mode_preserves_anchor_and_unique_exact_budget() {
    for dim in [65usize, 1536] {
        let base = vectors(96, dim);
        let graph = (0..96)
            .map(|u| (1..=16).map(|d| ((u + d) % 96) as u32).collect())
            .collect();
        let coefficients = (0..96).map(|i| (i % 7) as f32 / 100.).collect::<Vec<_>>();
        let m = CorrectedSmIndex::from_parts_with_dimension(
            dim,
            &base,
            &coefficients,
            graph,
            (1..=96).collect(),
            0,
            7,
        )
        .unwrap();
        let cfg = QuIVerSearchConfig {
            top_k: 10,
            ef_search: 80,
            rerank_limit: Some(32),
        };
        let q = &base[19 * dim..20 * dim];
        let reference = m
            .search_traced(q, &base, &cfg, SmSearchMode::Reference)
            .unwrap();
        let combined = m
            .search_traced(q, &base, &cfg, SmSearchMode::Combined)
            .unwrap();
        same(&reference, &combined);
        assert_eq!(combined.trace.exact.len(), 32);
        assert_eq!(combined.trace.exact[0], 7);
        assert_eq!(
            combined
                .trace
                .exact
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            32
        );
    }
}
