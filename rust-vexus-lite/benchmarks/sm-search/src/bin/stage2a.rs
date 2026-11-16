//! Deterministic single-thread kernel + flat-recall experiment; no production I/O.
use serde_json::json;
use std::hint::black_box;
use std::time::Instant;
use vcp_tdb_index::index::bq::Bq2Signature;
use vcp_tdb_index::index::quiver::corrected_sm::{CorrectedSmIndex, FlatSearchConfig, kernel_probe};

fn samples(mut run: impl FnMut(), operations: usize) -> Vec<f64> {
    for _ in 0..2 { run(); }
    (0..7).map(|_| {
        let start = Instant::now();
        for _ in 0..8 { run(); }
        start.elapsed().as_secs_f64() * 1e9 / (operations * 8) as f64
    }).collect()
}

fn summary(mut ns: Vec<f64>) -> serde_json::Value {
    ns.sort_by(f64::total_cmp);
    json!({"min_ns":ns[0],"median_ns":ns[ns.len()/2],"max_ns":ns[ns.len()-1],"sorted_samples_ns":ns})
}

fn main() {
    assert!(
        ["TRIVIUM_NO_AVX512", "QUIVER_DISABLE_AVX512"].iter()
            .any(|name| std::env::var(name).as_deref() == Ok("1")),
        "explicitly disable AVX-512 for this experiment"
    );
    let (bits, dot) = kernel_probe::selected();
    let mut reports = Vec::new();
    for dim in [768usize, 3072] {
        let n = 2048;
        let mut seed = 0x91ac_3f17_1234_5678u64 ^ dim as u64;
        let base = (0..n).map(|_| {
            let mut row = (0..dim).map(|_| {
                seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17;
                (seed as i32) as f32 / i32::MAX as f32
            }).collect::<Vec<_>>();
            let norm = row.iter().map(|&v| (v as f64).powi(2)).sum::<f64>().sqrt();
            for v in &mut row { *v = (*v as f64 / norm) as f32; }
            row
        }).collect::<Vec<_>>();
        let codes = base.iter().map(|v| Bq2Signature::from_vector(v)).collect::<Vec<_>>();
        let q = &base[17];
        let qs = &codes[17];
        let mut reference_scores = Vec::new();
        let mut optimized_scores = Vec::new();
        for (i, row) in base.iter().enumerate() {
            let c = &codes[i];
            assert_eq!(
                kernel_probe::counts(&qs.pos, &qs.strong, &c.pos, &c.strong, dim, false),
                kernel_probe::counts(&qs.pos, &qs.strong, &c.pos, &c.strong, dim, true)
            );
            let a = kernel_probe::dot(q, row, false);
            let b = kernel_probe::dot(q, row, true);
            assert_eq!(a.to_bits(), b.to_bits());
            reference_scores.push((i, a));
            optimized_scores.push((i, b));
        }
        for rows in [&mut reference_scores, &mut optimized_scores] {
            rows.sort_unstable_by(|a,b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
            rows.truncate(10);
        }
        assert_eq!(reference_scores, optimized_scores);
        let mut kernels = Vec::new();
        for optimized in [false, true] {
            let count_ns = samples(|| {
                for c in &codes {
                    black_box(kernel_probe::counts(black_box(&qs.pos), &qs.strong,
                        black_box(&c.pos), &c.strong, dim, optimized));
                }
            }, n);
            let dot_ns = samples(|| {
                for row in &base { black_box(kernel_probe::dot(black_box(q), black_box(row), optimized)); }
            }, n);
            kernels.push(json!({"optimized":optimized,"counts":summary(count_ns),"dot":summary(dot_ns)}));
        }
        let mut index = CorrectedSmIndex::empty_flat(dim).unwrap();
        for (i, row) in base.iter().enumerate() { index.push_flat_vector(row, i as u64 + 1).unwrap(); }
        index.prepare_flat_headers().unwrap();
        // Held-out perturbations, not exact self queries; same normalized source
        // and exact FP32 oracle for all configurations. No SQLite claim is made.
        let queries = (0..16).map(|i| {
            let mut row = base[i * 37].clone();
            for (j, v) in row.iter_mut().enumerate() {
                *v += ((j * 17 + i * 31) as f32).sin() * 0.01;
            }
            row
        }).collect::<Vec<_>>();
        let truth = queries.iter().map(|query| {
            let mut ranked = base.iter().enumerate().map(|(i,row)| {
                (i as u64 + 1, kernel_probe::dot(query, row, false))
            }).collect::<Vec<_>>();
            ranked.sort_unstable_by(|a,b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
            ranked.into_iter().take(10).map(|v| v.0).collect::<Vec<_>>()
        }).collect::<Vec<_>>();
        let mut flat = Vec::new();
        for (name, config) in [
            ("legacy", FlatSearchConfig::default()),
            ("route2_no_sketch", FlatSearchConfig { enabled:true, ..Default::default() }),
            ("route2_sketch_0.2", FlatSearchConfig { enabled:true, sketch_margin:Some(0.2), ..Default::default() }),
        ] {
            let mut hits = 0;
            let mut rejected = 0;
            let mut sym = 0;
            let mut asym = 0;
            for (qi, query) in queries.iter().enumerate() {
                let (found, stats) = index.search_flat_filtered_with_config(query, 64, &config, |_,_|true).unwrap();
                // Exact rerank within the SAME 64-candidate budget.
                let mut reranked = found.iter().map(|&(id,_)|
                    (id, kernel_probe::dot(query, &base[id as usize - 1], false))).collect::<Vec<_>>();
                reranked.sort_unstable_by(|a,b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
                hits += reranked.iter().take(10).filter(|v| truth[qi].contains(&v.0)).count();
                rejected += stats.sketch_rejected; sym += stats.symmetric_scored; asym += stats.asymmetric_scored;
            }
            let ns = samples(|| {
                for query in &queries {
                    black_box(index.search_flat_filtered_with_config(black_box(query),64,&config,|_,_|true).unwrap());
                }
            }, queries.len());
            flat.push(json!({"mode":name,"routing_time":summary(ns),"recall_at_10":hits as f64 / 160.,
                "mean_sketch_rejected":rejected as f64/16.,"mean_symmetric":sym as f64/16.,
                "mean_asymmetric":asym as f64/16.,"exact_candidate_budget":64}));
        }
        let report = json!({"dim":dim,"rows":n,"bit_kernel":bits,"dot_kernel":dot,
            "counts_integer_equal":true,"exact_dot_bits_equal":true,"exact_top10_equal":true,
            "kernels":kernels,"flat":flat,"memory":index.memory_components()});
        eprintln!("{}", serde_json::to_string(&report).unwrap());
        reports.push(report);
    }
    let result = json!({"scope":"single-thread deterministic synthetic kernels and flat recall; no SQLite, graph, real-data or end-to-end claims",
        "samples":7,"iterations_per_sample":8,"reports":reports});
    if let Ok(path) = std::env::var("STAGE2A_OUT") {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(path).unwrap();
        use std::io::Write;
        file.write_all(&serde_json::to_vec_pretty(&result).unwrap()).unwrap();
    }
    println!("{}", serde_json::to_string_pretty(&result).unwrap());
}