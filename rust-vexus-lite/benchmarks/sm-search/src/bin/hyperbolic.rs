//! Isolated synthetic hierarchy + private in-memory SQLite, never production data.
use std::{collections::HashSet, fs::OpenOptions, io::Write, time::Instant};
use rusqlite::{params, Connection};
use serde_json::json;
use vcp_tdb_index::{QuIVer, QuIVerConfig, QuIVerSearchConfig};
use vcp_tdb_index::index::quiver::hyperbolic::*;

fn noise(seed: u64, dim: usize) -> Vec<f32> {
    let mut s = seed + 1;
    (0..dim).map(|_| { s ^= s << 13; s ^= s >> 7; s ^= s << 17; (s as i32) as f32 / i32::MAX as f32 }).collect()
}
fn row(node: usize, dim: usize) -> Vec<f32> {
    let topic = noise((node / 64) as u64 * 17 + 991, dim);
    let branch = noise((node / 8) as u64 * 29 + 717, dim);
    let detail = noise(node as u64 * 37 + 313, dim);
    let local = node % 64;
    let (a, b, c) = if local == 0 { (1., 0., 0.) }
        else if local < 8 { (0.85, 0.35, 0.10) } else { (0.55, 0.70, 0.35) };
    topic.iter().zip(branch).zip(detail).map(|((&x, y), z)| a * x + b * y + c * z).collect()
}
fn specificity(node: usize) -> f32 {
    if node % 64 == 0 { 0.0 } else if node % 64 < 8 { 0.30 }
    else { 0.65 + 0.35 * (node % 8) as f32 / 7.0 }
}
fn encode(row: &[f32]) -> Vec<u8> { row.iter().flat_map(|v| v.to_le_bytes()).collect() }
fn read(conn: &Connection, slot: usize, out: &mut Vec<f32>) -> bool {
    let blob: Vec<u8> = conn.query_row("SELECT vector FROM vectors WHERE slot=?1", [slot as i64], |r| r.get(0)).unwrap();
    out.clear();
    out.extend(blob.chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())));
    true
}
fn cosine(a: &[f32], b: &[f32]) -> f64 {
    let (mut dot, mut aa, mut bb) = (0., 0., 0.);
    for (&x, &y) in a.iter().zip(b) { let (x, y) = (x as f64, y as f64); dot += x*y; aa += x*x; bb += y*y; }
    (dot / (aa*bb).sqrt()).clamp(-1., 1.)
}
// Independent direct FP64 difference oracle, not the implementation's exact_proxy.
fn proxy(a: &[f32], da: f32, b: &[f32], db: f32) -> f64 {
    let na = a.iter().map(|&x| (x as f64).powi(2)).sum::<f64>().sqrt();
    let nb = b.iter().map(|&x| (x as f64).powi(2)).sum::<f64>().sqrt();
    let ra = (da as f64 / 2.).tanh();
    let rb = (db as f64 / 2.).tanh();
    let dd: f64 = a.iter().zip(b).map(|(&x, &y)| (x as f64 / na - y as f64 / nb).powi(2)).sum();
    ((ra-rb).powi(2) + ra*rb*dd) * (da as f64 / 2.).cosh().powi(2) * (db as f64 / 2.).cosh().powi(2)
}
fn top(mut rows: Vec<(u64, f64)>, descending: bool) -> Vec<u64> {
    rows.sort_unstable_by(|a,b| {
        let cmp = a.1.total_cmp(&b.1);
        (if descending { cmp.reverse() } else { cmp }).then(a.0.cmp(&b.0))
    });
    rows.into_iter().take(10).map(|p| p.0).collect()
}
fn recall(found: &[u64], truth: &[u64]) -> f64 {
    found.iter().filter(|id| truth.contains(id)).count() as f64 / truth.len().max(1) as f64
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    assert_eq!(std::env::var("TRIVIUM_NO_AVX512").as_deref(), Ok("1"));
    let n = std::env::var("HYPER_N").ok().map(|v| v.parse()).transpose()?.unwrap_or(4096usize);
    assert!(n >= 128 && n % 64 == 0);
    let max_visits = std::env::var("HYPER_VISITS").ok().map(|v| v.parse()).transpose()?.unwrap_or(n);
    let max_expansions = std::env::var("HYPER_EXPANSIONS").ok().map(|v| v.parse()).transpose()?.unwrap_or(512usize);
    let path = std::env::var("HYPER_OUT")?;
    let mut output_file = OpenOptions::new().write(true).create_new(true).open(path)?;
    let mut reports = Vec::new();
    for dim in [384usize, 768, 3072] {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch("CREATE TABLE vectors(slot INTEGER PRIMARY KEY, vector BLOB NOT NULL);BEGIN")?;
        for node in 0..n { conn.execute("INSERT INTO vectors VALUES(?1,?2)", params![node as i64, encode(&row(node,dim))])?; }
        conn.execute_batch("COMMIT")?;
        let ids: Vec<u64> = (1..=n as u64).collect();
        let slots: Vec<usize> = (0..n).collect();
        let mut legacy = QuIVer::new(dim, &QuIVerConfig::default());
        let start = Instant::now();
        legacy.rebuild_from_cold_slots(&ids, &slots, &QuIVerConfig::default(), |s,o| read(&conn,s,o))?;
        let cosine_build_ms = start.elapsed().as_secs_f64()*1000.;
        for upper in [1.80f32, 2.50, 3.20] {
            let depths: Vec<f32> = (0..n).map(|node| 0.35 + (upper-0.35)*specificity(node)).collect();
            let start = Instant::now();
            let index = HyperbolicIndex::build(dim,&ids,&slots,&depths,
                HyperbolicConfig { landmarks: Some(512), ..Default::default() },
                |s,o| read(&conn,s,o))?;
            let build_ms = start.elapsed().as_secs_f64()*1000.;
            assert_eq!(index.connectivity(), (n,0));
            assert!(index.directory_sizes().0 > 256, "must actually cover two-level routing");
            assert_eq!(index.directory_sizes().1, 64);
            let mut layers = vec![Vec::new(),Vec::new(),Vec::new()];
            let mut angular_errors = Vec::new();
            for qi in 0..16 {
                let source = (qi*61+29)%n;
                let query: Vec<f32> = row(source,dim).into_iter().zip(noise(30091+qi as u64,dim))
                    .map(|(a,b)| a+0.02*b).collect();
                let qdepth = depths[source];
                for (id, estimate) in index.approximate_cosines(&query)? {
                    let node = id as usize-1;
                    if specificity(node) >= 0.65 { angular_errors.push((estimate-cosine(&query,&row(node,dim))).abs()); }
                }
                let mut excluded = HashSet::new();
                for (layer, samples) in layers.iter_mut().enumerate() {
                    let mut cosine_scores = Vec::new();
                    let mut hyper_scores = Vec::new();
                    for node in 0..n {
                        if excluded.contains(&ids[node]) { continue; }
                        let v = row(node,dim);
                        cosine_scores.push((ids[node],cosine(&query,&v)));
                        hyper_scores.push((ids[node],proxy(&query,qdepth,&v,depths[node])));
                    }
                    let cosine_truth = top(cosine_scores,true);
                    let hyper_truth = top(hyper_scores,false);
                    let mut cold = HashSet::new();
                    let start = Instant::now();
                    let found = index.search(&query,qdepth,HyperbolicSearchConfig {
                        top_k:10,width:128,rerank_limit:64,max_visits,max_expansions,radial_bound:false,
                    }, |id| excluded.contains(&id), |s,o| {
                        assert!(!excluded.contains(&ids[s]));
                        assert!(cold.insert(s), "duplicate hyperbolic cold read");
                        read(&conn,s,o)
                    })?;
                    let hyper_us = start.elapsed().as_secs_f64()*1e6;
                    assert!(cold.len()<=64);
                    assert_eq!(cold.len(),found.stats.cold_reads);
                    assert!(found.stats.seeds <= (128 / 2).min(max_visits / 4));
                    let mut radial_cold = HashSet::new();
                    let radial_start = Instant::now();
                    let radial = index.search(&query,qdepth,HyperbolicSearchConfig {
                        top_k:10,width:128,rerank_limit:64,max_visits,max_expansions,radial_bound:true,
                    }, |id| excluded.contains(&id), |s,o| {
                        assert!(!excluded.contains(&ids[s]));
                        assert!(radial_cold.insert(s));
                        read(&conn,s,o)
                    })?;
                    let radial_us = radial_start.elapsed().as_secs_f64()*1e6;
                    assert_eq!(found.neighbors,radial.neighbors,"radial filter must preserve exact result bits");
                    assert!(radial_cold.is_subset(&cold));
                    let mut cosine_cold = HashSet::new();
                    let start = Instant::now();
                    let baseline = legacy.search_with_options(&query,|s,o| {
                        assert!(!excluded.contains(&ids[s]));
                        assert!(cosine_cold.insert(s),"duplicate cosine cold read");
                        read(&conn,s,o)
                    },&QuIVerSearchConfig {top_k:10,ef_search:128,rerank_limit:Some(64)},&|id|excluded.contains(&id));
                    let cosine_us = start.elapsed().as_secs_f64()*1e6;
                    assert!(cosine_cold.len()<=64);
                    let found_ids:Vec<_> = found.neighbors.iter().map(|p|p.0).collect();
                    let baseline_ids:Vec<_> = baseline.iter().map(|p|p.0).collect();
                    samples.push(json!({
                        "query":qi,"layer":layer,
                        "cosine_ann_vs_cosine_truth":recall(&baseline_ids,&cosine_truth),
                        "hyper_exact_vs_cosine_truth":recall(&hyper_truth,&cosine_truth),
                        "hyper_ann_vs_hyper_truth":recall(&found_ids,&hyper_truth),
                        "hyper_ann_vs_cosine_truth":recall(&found_ids,&cosine_truth),
                        "inner_fraction":found_ids.iter().filter(|&&id|specificity(id as usize-1)<=0.30).count() as f64/10.,
                        "cold_unique":cold.len(),"cosine_cold_unique":cosine_cold.len(),
                        "hyper_us":hyper_us,"cosine_us":cosine_us,
                        "visited":found.stats.visited,"expanded":found.stats.expanded,
                        "excluded_expanded":found.stats.excluded_expanded,
                        "seeds":found.stats.seeds,"converged":found.stats.converged,
                        "visit_limit_reached":found.stats.visit_limit_reached,
                        "radial_cold_unique":radial_cold.len(),"radial_us":radial_us,
                        "radial_rejections":radial.stats.radial_rejections,
                        "expansion_limit_reached":found.stats.expansion_limit_reached
                    }));
                    excluded.extend(found_ids);
                }
            }
            angular_errors.sort_unstable_by(f64::total_cmp);
            let quantile = |q:f64|angular_errors[((angular_errors.len()-1) as f64*q) as usize];
            eprintln!("dim={dim} upper={upper} build_ms={build_ms:.1}");
            reports.push(json!({"dim":dim,"n":n,"depth":[0.35,upper],"curvature":1.,
                "build_ms":build_ms,"hot_bytes":index.hot_bytes(),"cosine_build_ms":cosine_build_ms,
                "directory":index.directory_sizes(),
                "cosine_hot_bytes":legacy.stats().hot_bytes,
                "reachable":n,"zero_indegree":0,"outer_abs_cosine_error_p50":quantile(0.5),
                "outer_abs_cosine_error_p90":quantile(0.9),"outer_abs_cosine_error_p99":quantile(0.99),
                "layers":layers}));
        }
    }
    serde_json::to_writer_pretty(&mut output_file,&json!({
        "dataset":"deterministic synthetic topic/branch/detail hierarchy",
        "sqlite":"private in-memory; not disk/production latency",
        "width":128,"unique_cold_cap":64,"queries":16,"cumulative_layers":3,
        "max_visits":max_visits,"max_expansions":max_expansions,
        "warning":"dual retention uses up to 2*width valid candidates; same width is not equal hot compute",
        "reports":reports
    }))?;
    output_file.write_all(b"\n")?;
    Ok(())
}