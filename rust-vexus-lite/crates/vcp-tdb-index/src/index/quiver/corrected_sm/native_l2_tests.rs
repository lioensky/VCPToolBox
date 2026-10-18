//! 原生欧氏语义：非单位幅值、零向量、精排预算、线程一致性与重载后显式安装。
use super::*;
use rayon::prelude::*;

fn vectors(dim: usize, n: usize) -> Vec<f32> {
    (0..n * dim)
        .map(|j| {
            if j < dim {
                0.
            } else {
                (((j * 7919) % 997) as f32 - 498.) * (1. + (j / dim % 7) as f32) / 111.
            }
        })
        .collect()
}

fn exact(q: &[f32], base: &[f32]) -> Vec<(u64, f64)> {
    let mut values = base
        .chunks_exact(q.len())
        .enumerate()
        .map(|(i, x)| {
            (
                i as u64 + 1,
                q.iter()
                    .zip(x)
                    .map(|(&a, &b)| (a as f64 - b as f64).powi(2))
                    .sum::<f64>(),
            )
        })
        .collect::<Vec<_>>();
    values.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
    values.truncate(10);
    values
}

#[test]
fn native_l2_raw_amplitudes_zero_tail_simd_and_threads_match_bruteforce() {
    for dim in [1, 65, 128, 768, 960, 3072] {
        let n = 48;
        let base = vectors(dim, n);
        let graph = (0..n)
            .map(|u| (1..=16).map(|d| ((u + d) % n) as u32).collect())
            .collect();
        let model = CorrectedSmIndex::from_native_l2_vectors_and_graph(
            dim,
            &base,
            graph,
            (1..=n as u64).collect(),
            0,
        )
        .unwrap();
        let cfg = QuIVerSearchConfig {
            top_k: 10,
            ef_search: n,
            rerank_limit: Some(n),
        };
        let queries = [
            vec![0.; dim],
            base[dim * 19..dim * 20]
                .iter()
                .map(|&v| v * 1.3 + 0.25)
                .collect(),
        ];
        let expected = queries
            .iter()
            .map(|q| {
                let output = model
                    .search_traced(q, &base, &cfg, SmSearchMode::Combined)
                    .unwrap();
                let reference = model
                    .search_traced(q, &base, &cfg, SmSearchMode::Reference)
                    .unwrap();
                assert_eq!(output.neighbors, reference.neighbors);
                assert_eq!(output.trace, reference.trace);
                let truth = exact(q, &base);
                assert_eq!(
                    output.neighbors.iter().map(|v| v.0).collect::<Vec<_>>(),
                    truth.iter().map(|v| v.0).collect::<Vec<_>>(),
                    "原始幅值的L2排序不符，维度{dim}"
                );
                for (actual, expected) in output.neighbors.iter().zip(truth) {
                    assert!(
                        (actual.1 as f64 + expected.1).abs() <= 2e-5 * expected.1.max(1.),
                        "原生欧氏返回负平方距离"
                    );
                }
                let mut accessed = Vec::new();
                let callback = model
                    .search_with_vectors(q, &cfg, SmSearchMode::Combined, |id, buffer| {
                        accessed.push(id);
                        buffer.extend_from_slice(&base[id * dim..(id + 1) * dim]);
                        true
                    })
                    .unwrap();
                assert_eq!(callback.neighbors, output.neighbors);
                assert_eq!(
                    accessed,
                    output
                        .trace
                        .exact
                        .iter()
                        .map(|&id| id as usize)
                        .collect::<Vec<_>>()
                );
                assert_eq!(accessed.len(), n, "FP32只在末尾预算内访问，无精算锚点");
                output.neighbors
            })
            .collect::<Vec<_>>();
        for threads in [1, 8, 16, 32] {
            let actual = rayon::ThreadPoolBuilder::new()
                .num_threads(threads)
                .build()
                .unwrap()
                .install(|| {
                    queries
                        .par_iter()
                        .map(|q| {
                            model
                                .search(q, &base, &cfg, SmSearchMode::Combined)
                                .unwrap()
                                .neighbors
                        })
                        .collect::<Vec<_>>()
                });
            assert_eq!(actual, expected, "同图多线程标签与分数必须相同");
        }
    }
}

#[test]
fn native_l2_slice_slot_mapping_reload_and_atomic_install() {
    for dim in [128, 960] {
        let n = 48;
        let base = vectors(dim, n);
        // VCP-PATCH: exercise the retrieval kernel without upstream MemTable.
        let mut index = QuIVer::new(dim, &super::super::QuIVerConfig {
            m: 8,
            ef_construction: 32,
            alpha: 1.2,
        });
        index.batch_build_experimental_v2(
            &base,
            &(1..=n as u64).collect::<Vec<_>>(),
            &(0..n).collect::<Vec<_>>(),
        );
        index.enable_sm_native_l2(&base).unwrap();
        assert!(index.sm_native_l2_enabled());
        let cfg = QuIVerSearchConfig {
            top_k: 10,
            ef_search: n,
            rerank_limit: Some(n),
        };
        let q = vec![0.; dim];
        let search = |index: &QuIVer| {
            index.search(
                &q,
                |slot, buffer| {
                    buffer.clear();
                    buffer.extend_from_slice(&base[slot * dim..(slot + 1) * dim]);
                    true
                },
                &cfg,
            )
        };
        let hits = search(&index);
        assert_eq!(hits[0].0, 1);
        assert_eq!(hits[0].1, 0.);
        assert_eq!(
            hits.iter().map(|v| v.0).collect::<Vec<_>>(),
            exact(&q, &base).iter().map(|v| v.0).collect::<Vec<_>>()
        );
        let path =
            std::env::temp_dir().join(format!("tdb-native-l2-{}-{dim}.bin", std::process::id()));
        index.save_to_file(&path).unwrap();
        let mut loaded = QuIVer::load_from_file(&path).unwrap();
        assert!(!loaded.sm_native_l2_enabled());
        loaded
            .enable_sm_native_l2_with_vectors(|slot, buffer| {
                buffer.clear();
                buffer.extend_from_slice(&base[slot * dim..(slot + 1) * dim]);
                true
            })
            .unwrap();
        assert_eq!(search(&loaded), hits);
        let mut invalid = base.clone();
        invalid[0] = f32::NAN;
        assert!(loaded.enable_sm_native_l2(&invalid).is_err());
        assert!(loaded.sm_native_l2_enabled(), "失败安装不得破坏已有模式");
        assert_eq!(search(&loaded), hits);
        assert!(
            loaded.search(&[f32::NAN], |_, _| true, &cfg).is_empty(),
            "错误原生查询不能退回余弦"
        );
        std::fs::remove_file(path).unwrap();
        let mut seed = 42;
        index.insert(&vec![0.; dim], n as u64 + 1, n, &mut seed);
        assert!(!index.sm_native_l2_enabled(), "插入后运行期状态须失效");
    }
}
