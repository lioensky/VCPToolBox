//! Private frozen-export experiment; never opens production lifecycle code.
#[allow(dead_code)]
#[path = "../../../../src/memo_nnls.rs"]
mod memo_nnls;
use std::{collections::HashSet, fs::OpenOptions, io::Write, time::Instant};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use vcp_tdb_index::{QuIVer, QuIVerConfig, QuIVerSearchConfig};
use vcp_tdb_index::index::quiver::hyperbolic::*;

struct Tag {
    id: u64,
    name: String,
    inbound: f64,
    residual: f64,
}
fn decode(blob: &[u8]) -> Vec<f32> {
    assert_eq!(blob.len() % 4, 0);
    blob.chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect()
}
fn read(conn: &Connection, slot: usize, out: &mut Vec<f32>) -> bool {
    let mut statement = conn.prepare_cached("SELECT vector FROM tags WHERE slot=?1").unwrap();
    let blob: Vec<u8> = statement.query_row([slot as i64], |r| r.get(0)).unwrap();
    out.clear();
    out.extend(blob.chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())));
    true
}
fn norm(a: &[f32]) -> f64 {
    a.iter().map(|&v| (v as f64).powi(2)).sum::<f64>().sqrt()
}
fn cosine(a: &[f32], b: &[f32]) -> f64 {
    assert_eq!(a.len(), b.len());
    (a.iter().zip(b).map(|(&x,&y)| x as f64*y as f64).sum::<f64>()
        / (norm(a)*norm(b))).clamp(-1.,1.)
}
// Independent exact normalized-coordinate difference oracle; curvature fixed at 1.
fn proxy(a: &[f32], da: f32, b: &[f32], db: f32) -> f64 {
    let (na,nb) = (norm(a),norm(b));
    let (da,db) = (da as f64,db as f64);
    let (ra,rb) = ((da/2.).tanh(),(db/2.).tanh());
    let delta: f64 = a.iter().zip(b)
        .map(|(&x,&y)| (x as f64/na-y as f64/nb).powi(2)).sum();
    ((ra-rb).powi(2)+ra*rb*delta)*(da/2.).cosh().powi(2)*(db/2.).cosh().powi(2)
}
fn best(mut rows: Vec<(usize,f64)>, descending: bool, tags: &[Tag]) -> Vec<(usize,f64)> {
    rows.sort_unstable_by(|a,b| {
        let cmp = a.1.total_cmp(&b.1);
        (if descending {cmp.reverse()} else {cmp}).then(tags[a.0].id.cmp(&tags[b.0].id))
    });
    rows.truncate(10);
    rows
}
fn overlap(found: &[usize], truth: &[(usize,f64)]) -> f64 {
    found.iter().filter(|s| truth.iter().any(|t| t.0==**s)).count() as f64
        / truth.len().max(1) as f64
}
fn words(rows: &[(usize,f64)], tags: &[Tag], depths: &[f32]) -> Value {
    json!(rows.iter().map(|&(s,score)| json!({
        "id":tags[s].id,"word":tags[s].name,"score":score,"depth":depths[s],
        "inbound":tags[s].inbound,"raw_residual_ratio":tags[s].residual
    })).collect::<Vec<_>>())
}
fn main() -> Result<(),Box<dyn std::error::Error>> {
    assert_eq!(std::env::var("TRIVIUM_NO_AVX512").as_deref(),Ok("1"));
    let source = std::env::var("REAL_TAGS_DB")?;
    let destination = std::env::var("REAL_HYPER_OUT")?;
    let policy = std::env::var("REAL_PYRAMID_POLICY").unwrap_or_else(|_| "shared_reference".into());
    assert!(matches!(policy.as_str(), "shared_reference" | "hyper_ann_closed_loop"));
    let closed_loop = policy == "hyper_ann_closed_loop";
    assert_ne!(std::path::Path::new(&source),std::path::Path::new(&destination));
    let conn = Connection::open_with_flags(&source,OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    conn.execute_batch("PRAGMA query_only=ON; BEGIN")?;
    let metadata: String = conn.query_row("SELECT value FROM metadata",[],|r|r.get(0))?;
    let metadata: Value = serde_json::from_str(&metadata)?;
    assert_eq!(metadata["schema"],"pelorus-real-tags-v2");
    let dim = metadata["dimension"].as_u64().unwrap() as usize;
    let max_inbound = metadata["max_inbound"].as_f64().unwrap();
    let mut statement = conn.prepare("SELECT slot,id,name,inbound,raw_residual_ratio FROM tags ORDER BY slot")?;
    let tags: Vec<Tag> = statement.query_map([],|r| {
        Ok((r.get::<_,usize>(0)?,Tag {id:r.get(1)?,name:r.get(2)?,inbound:r.get(3)?,residual:r.get(4)?}))
    })?.enumerate().map(|(expected,row)| {
        let (slot,tag) = row.unwrap();
        assert_eq!(slot,expected);
        tag
    }).collect();
    drop(statement);
    let n = tags.len();
    let ids: Vec<u64> = tags.iter().map(|t|t.id).collect();
    let slots: Vec<usize> = (0..n).collect();
    let mut queries_statement = conn.prepare("SELECT source_chunk_id,vector FROM queries ORDER BY id")?;
    // Bounded query batch only, NOT full Tag originals.
    let queries: Vec<(i64,Vec<f32>)> = queries_statement.query_map([],|r| {
        Ok((r.get(0)?,decode(&r.get::<_,Vec<u8>>(1)?)))
    })?.collect::<Result<_,_>>()?;
    drop(queries_statement);
    let mut output = OpenOptions::new().write(true).create_new(true).open(destination)?;
    let mut legacy = QuIVer::new(dim,&QuIVerConfig::default());
    let start = Instant::now();
    legacy.rebuild_from_cold_slots(&ids,&slots,&QuIVerConfig::default(),|s,o|read(&conn,s,o))?;
    let cosine_build_ms = start.elapsed().as_secs_f64()*1000.;
    let mut reports = Vec::new();
    for upper in [1.4_f32,1.8,2.4] {
        let depths: Vec<f32> = tags.iter().map(|t| {
            let specificity = 1.-(t.inbound/max_inbound).clamp(0.,1.).sqrt();
            let h = (0.65*specificity+0.35*t.residual).clamp(0.,1.);
            (0.35+(upper as f64-0.35)*h.powf(1.15)) as f32
        }).collect();
        let start = Instant::now();
        let index = HyperbolicIndex::build(dim,&ids,&slots,&depths,
            HyperbolicConfig {landmarks:Some(512),..Default::default()},|s,o|read(&conn,s,o))?;
        let build_ms = start.elapsed().as_secs_f64()*1000.;
        assert_eq!(index.connectivity(),(n,0));
        assert!(index.directory_sizes().0>256);
        let mut samples = Vec::new();
        for (qi,(chunk_id,query)) in queries.iter().enumerate() {
            let initial_norm = norm(query);
            let mut residual = query.clone();
            let mut excluded: HashSet<u64> = HashSet::new();
            for layer in 0..3usize {
                if norm(&residual)/initial_norm <= 0.02 { break; }
                // Explicit experimental depth control, not a fabricated EPA result.
                let qdepth = 0.35+(upper-0.35)*(0.25+0.25*layer as f32);
                let mut cos_rows = Vec::new();
                let mut hyp_rows = Vec::new();
                let mut oracle_reads = 0;
                let mut row = Vec::with_capacity(dim);
                for slot in 0..n {
                    if excluded.contains(&ids[slot]) {continue;}
                    read(&conn,slot,&mut row);
                    oracle_reads+=1;
                    cos_rows.push((slot,cosine(&residual,&row)));
                    hyp_rows.push((slot,proxy(&residual,qdepth,&row,depths[slot])));
                }
                let cos_truth = best(cos_rows,true,&tags);
                let hyp_truth = best(hyp_rows,false,&tags);
                let mut cold = HashSet::new();
                let controls = HyperbolicSearchConfig {
                    top_k:10,width:128,rerank_limit:64,max_visits:256,max_expansions:128,radial_bound:false
                };
                let start = Instant::now();
                let found = index.search(&residual,qdepth,controls,|id|excluded.contains(&id),|s,o| {
                    assert!(!excluded.contains(&ids[s]));
                    assert!(cold.insert(s));
                    read(&conn,s,o)
                })?;
                let hyper_us = start.elapsed().as_secs_f64()*1e6;
                let mut radial_cold = HashSet::new();
                let radial = index.search(&residual,qdepth,HyperbolicSearchConfig {radial_bound:true,..controls},
                    |id|excluded.contains(&id),|s,o| {
                        assert!(!excluded.contains(&ids[s]));
                        assert!(radial_cold.insert(s));
                        read(&conn,s,o)
                    })?;
                assert_eq!(found.neighbors,radial.neighbors);
                assert!(radial_cold.is_subset(&cold));
                assert_eq!(cold.len(),found.stats.cold_reads);
                assert!(cold.len()<=64);
                assert!(found.stats.seeds<=64);
                let mut cosine_cold = HashSet::new();
                let start = Instant::now();
                let baseline = legacy.search_with_options(&residual,|s,o| {
                    assert!(!excluded.contains(&ids[s]));
                    assert!(cosine_cold.insert(s));
                    read(&conn,s,o)
                },&QuIVerSearchConfig {top_k:10,ef_search:128,rerank_limit:Some(64)},&|id|excluded.contains(&id));
                let cosine_us = start.elapsed().as_secs_f64()*1e6;
                assert!(cosine_cold.len()<=64);
                let slot_of = |id:u64| ids.binary_search(&id).unwrap();
                let found_rows: Vec<_> = found.neighbors.iter().map(|&(id,d)|(slot_of(id),d)).collect();
                let found_slots: Vec<_> = found_rows.iter().map(|p|p.0).collect();
                let cosine_slots: Vec<_> = baseline.iter().map(|&(id,_)|slot_of(id)).collect();
                // Reuse the production NNLS solver, with a bounded ten-vector buffer.
                // These reads are outside the retrieval budget and reported separately.
                let peeling_rows = if closed_loop { &found_rows } else { &cos_truth };
                let vectors: Vec<_> = peeling_rows.iter().map(|&(s,_)| {
                    let mut v = Vec::new(); read(&conn,s,&mut v); v
                }).collect();
                let refs: Vec<_> = peeling_rows.iter().zip(&vectors)
                    .map(|(&(s,_),v)|(ids[s] as i64,v.as_slice())).collect();
                let start = Instant::now();
                let solution = memo_nnls::solve(&residual,&refs)?;
                let nnls_us = start.elapsed().as_secs_f64()*1e6;
                samples.push(json!({
                    "query":qi,"source_chunk_id":chunk_id,"layer":layer,"query_depth":qdepth,
                    "query_energy_ratio":(norm(&residual)/initial_norm).powi(2),
                    "cosine_ann_vs_cosine_truth":overlap(&cosine_slots,&cos_truth),
                    "hyper_exact_vs_cosine_truth":overlap(&hyp_truth.iter().map(|p|p.0).collect::<Vec<_>>(),&cos_truth),
                    "hyper_ann_vs_hyper_truth":overlap(&found_slots,&hyp_truth),
                    "hyper_ann_vs_cosine_truth":overlap(&found_slots,&cos_truth),
                    "cosine_exact_words":words(&cos_truth,&tags,&depths),
                    "hyper_exact_words":words(&hyp_truth,&tags,&depths),
                    "hyper_ann_words":words(&found_rows,&tags,&depths),
                    "nnls_tag_ids":peeling_rows.iter().map(|p|ids[p.0]).collect::<Vec<_>>(),
                    "nnls_contributions":solution.contributions,"nnls":solution.diagnostics,"nnls_us":nnls_us,
                    "oracle_blob_reads":oracle_reads,"reference_nnls_blob_reads":vectors.len(),
                    "cold_unique":cold.len(),"cosine_cold_unique":cosine_cold.len(),
                    "radial_cold_unique":radial_cold.len(),"radial_rejections":radial.stats.radial_rejections,
                    "hyper_us":hyper_us,"cosine_us":cosine_us,
                    "seeds":found.stats.seeds,"visited":found.stats.visited,"expanded":found.stats.expanded,
                    "excluded_expanded":found.stats.excluded_expanded,"converged":found.stats.converged,
                    "visit_limit_reached":found.stats.visit_limit_reached,
                    "expansion_limit_reached":found.stats.expansion_limit_reached
                }));
                residual = solution.residual;
                excluded.extend(peeling_rows.iter().map(|p|ids[p.0]));
            }
        }
        eprintln!("real n={n} dim={dim} upper={upper} samples={} build_ms={build_ms:.1}",samples.len());
        reports.push(json!({
            "dmax":upper,"build_ms":build_ms,"hot_bytes":index.hot_bytes(),
            "directory":index.directory_sizes(),"depth_min":depths.iter().copied().fold(f32::INFINITY,f32::min),
            "depth_max":depths.iter().copied().fold(f32::NEG_INFINITY,f32::max),"samples":samples
        }));
    }
    serde_json::to_writer_pretty(&mut output,&json!({
        "schema":"pelorus-real-hyperbolic-v1","source_metadata":metadata,"n":n,"dim":dim,
        "cosine_build_ms":cosine_build_ms,"cosine_hot_bytes":legacy.stats().hot_bytes,
        "pyramid_policy":policy,
        "query_policy":if closed_loop {
            "real Chunk vectors; hyperbolic ANN top10 production-NNLS residual; exclude all prior hyperbolic ANN top10"
        } else {
            "real Chunk vectors; shared exact-cosine top10 production-NNLS residual; exclude all prior reference top10"
        },
        "depth_policy":"controlled d_q=.35+(dmax-.35)*(.25+.25*layer); NOT EPA replay",
        "energy_stop":"residual norm / initial norm <= .02",
        "scope":"sampled Tag truth only; no relevance labels, no production pipeline latency",
        "budget_warning":"router representative scoring is outside beam visits; dual retention up to 2*width",
        "io_warning":"retrieval cold reads, full-scan oracle reads, reference NNLS reads are separate; warm frozen SQLite copy",
        "reports":reports
    }))?;
    output.write_all(b"\n")?;
    Ok(())
}