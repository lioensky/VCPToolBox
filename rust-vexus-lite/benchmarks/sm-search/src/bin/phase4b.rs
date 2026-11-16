//! Phase 4B: development-only scan or locked holdout_v3 validation.
#[allow(dead_code)]
#[path = "../../../../src/memo_nnls.rs"]
mod memo_nnls;
use std::{collections::{HashMap,HashSet},fs::{self,OpenOptions},io::Write,time::Instant};
use rusqlite::{Connection,OpenFlags};
use serde::{Serialize,Deserialize};
use serde_json::{json,Value};
use vcp_tdb_index::{QuIVer,QuIVerConfig,QuIVerSearchConfig};
use vcp_tdb_index::index::quiver::hyperbolic::*;
use vcp_tdb_index::index::quiver::hyperbolic::warped_geometry::WarpedProfile;
use sha2::{Digest,Sha256};

#[derive(Clone,Debug,Serialize,Deserialize)]
struct Params { upper:f64, phi0:f64, alpha:f64, beta:f64, kappa:f64 }
impl Params {
    fn config(&self)->WarpedFieldConfig {
        WarpedFieldConfig {profile:WarpedProfile::Softening {alpha:self.alpha},
            radius_max:self.upper,throat_phi0:self.phi0,angular_scale_kappa:self.kappa,
            mean_subtract_beta:self.beta,..Default::default()}
    }
}
fn decode(b:&[u8])->Vec<f32> {
    assert_eq!(b.len()%4,0);
    b.chunks_exact(4).map(|p|f32::from_le_bytes(p.try_into().unwrap())).collect()
}
fn read(c:&Connection,s:usize,o:&mut Vec<f32>)->bool {
    let b:Vec<u8>=c.prepare_cached("SELECT vector FROM tags WHERE slot=?").unwrap()
        .query_row([s],|r|r.get(0)).unwrap();
    *o=decode(&b);true
}
fn energy(v:&[f32])->f64 {v.iter().map(|&x|(x as f64).powi(2)).sum()}
fn cosine(a:&[f32],b:&[f32])->f64 {
    a.iter().zip(b).map(|(&x,&y)|x as f64*y as f64).sum::<f64>()/(energy(a)*energy(b)).sqrt()
}
fn fit(q:&[f32],rows:&[(usize,f64)],ids:&[u64],cache:&HashMap<usize,Vec<f32>>)
    ->Result<memo_nnls::Solution,String> {
    memo_nnls::solve(q,&rows.iter().map(|p|(ids[p.0] as i64,cache[&p.0].as_slice())).collect::<Vec<_>>())
}
fn stages(trace:&WarpedSearchTrace,truth:&[(usize,f64)],ids:&[u64])->Value {
    let hit=|set:&[u64]|truth.iter().filter(|p|set.contains(&ids[p.0])).count() as f64/truth.len().max(1) as f64;
    assert!(trace.retained.iter().all(|id|trace.visited.contains(id)));
    assert!(trace.stage05_top64.iter().all(|id|trace.retained.contains(id)));
    json!({"seed_hit_rate":hit(&trace.seeds),"visited_hit_rate":hit(&trace.visited),
        "beam_retained_hit_rate":hit(&trace.retained),"stage05_top64_hit_rate":hit(&trace.stage05_top64),
        "seed_ids":trace.seeds,"visited_ids":trace.visited,"retained_ids":trace.retained,
        "stage05_ids":trace.stage05_top64})
}
fn main()->Result<(),Box<dyn std::error::Error>> {
    assert_eq!(std::env::var("TRIVIUM_NO_AVX512").as_deref(),Ok("1"));
    let mode=std::env::var("PHASE4B_MODE")?;
    assert!(["development","smoke","validation"].contains(&mode.as_str()));
    let c=Connection::open_with_flags(std::env::var("REAL_TAGS_DB")?,OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    c.execute_batch("PRAGMA query_only=ON;BEGIN")?;
    let metadata:String=c.query_row("SELECT value FROM metadata",[],|r|r.get(0))?;
    let metadata:Value=serde_json::from_str(&metadata)?;
    assert_eq!(metadata["inbound_quantile_schema"],"log1p-midrank-v1");
    let dim=metadata["dimension"].as_u64().unwrap() as usize;
    let mean:Vec<f64>=serde_json::from_value(metadata["mean_direction"].clone())?;
    let tags:Vec<(u64,f64,f64)>=c.prepare(
        "SELECT id,inbound_log_quantile,raw_residual_ratio FROM tags ORDER BY slot")?
        .query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?.collect::<Result<_,_>>()?;
    let ids:Vec<_>=tags.iter().map(|t|t.0).collect();
    let slots:Vec<_>=(0..ids.len()).collect();
    // Split restriction is applied BEFORE reading any query BLOB.
    let sql=if mode=="validation" {
        assert_eq!(metadata["validation_seed"],20261118);
        "SELECT q.source_chunk_id,s.split,q.vector FROM queries q JOIN query_sets s ON q.id=s.query_id WHERE s.split='holdout_v3' ORDER BY q.id"
    } else {
        "SELECT q.source_chunk_id,s.split,q.vector FROM queries q JOIN query_sets s ON q.id=s.query_id WHERE s.split IN ('development','holdout') ORDER BY q.id"
    };
    let mut queries:Vec<(i64,String,Vec<f32>)>=c.prepare(sql)?
        .query_map([],|r|Ok((r.get(0)?,r.get(1)?,decode(&r.get::<_,Vec<u8>>(2)?))))?
        .collect::<Result<_,_>>()?;
    if mode=="validation" {assert_eq!(queries.len(),32);}
    else {assert_eq!(queries.len(),44);}
    if mode=="smoke" {queries.truncate(2);}
    let mut matrix=vec![("cosine".to_owned(),None)];
    let mut lock_hash=None;
    if mode=="validation" {
        let bytes=fs::read(std::env::var("PHASE4B_LOCK")?)?;
        let lock:Value=serde_json::from_slice(&bytes)?;
        assert_eq!(lock["schema"],"phase4b-lock-v1");
        let configs:Vec<Params>=serde_json::from_value(lock["configs"].clone())?;
        assert!((2..=3).contains(&configs.len()));
        lock_hash=Some(format!("{:x}",Sha256::digest(&bytes)));
        for (i,p) in configs.into_iter().enumerate() {matrix.push((format!("locked_{i}"),Some(p)));}
    } else {
        matrix.push(("phase4a_reference".to_owned(),Some(Params {upper:1.8,phi0:0.0,alpha:0.35,beta:0.7,kappa:1.0})));
        for upper in if mode=="smoke" {vec![0.9]} else {vec![0.65,0.9,1.2]} {
            for phi0 in if mode=="smoke" {vec![0.8]} else {vec![0.0,0.8,1.5]} {
                for alpha in if mode=="smoke" {vec![0.15]} else {vec![0.15,0.35]} {
                    for beta in if mode=="smoke" {vec![0.7]} else {vec![0.5,0.7,1.0]} {
                        for kappa in if mode=="smoke" {vec![1.0]} else {vec![0.5,1.0,2.0]} {
                            matrix.push((format!("u{upper}_p{phi0}_a{alpha}_b{beta}_k{kappa}"),
                                Some(Params {upper,phi0,alpha,beta,kappa})));
                        }
                    }
                }
            }
        }
    }
    let mut output=OpenOptions::new().write(true).create_new(true).open(std::env::var("PHASE4B_OUT")?)?;
    serde_json::to_writer(&mut output,&json!({"schema":"phase4b-header-v1","mode":mode,
        "metadata":metadata,"n":ids.len(),"dimension":dim,"config_count":matrix.len(),"lock_sha256":lock_hash,
        "query_ids":queries.iter().map(|q|q.0).collect::<Vec<_>>(),
        "geometry":"half-line with boundary arcs; kappa absorbed in phi; identity angular calibration",
        "protocol":"64 unique reranks; 256 visits; 128 expansions; NNLS .03 accept-before-update; conditional per-route trajectories"}))?;
    output.write_all(b"\n")?;output.flush()?;
    let run_start=Instant::now();
    let count=matrix.len();
    for (ri,(route,params)) in matrix.into_iter().enumerate() {
        let upper=params.as_ref().map_or(0.9,|p|p.upper);
        let radii:Vec<f32>=tags.iter().map(|t| {
            (0.35+(upper-0.35)*(0.65*(1.0-t.1)+0.35*t.2).clamp(0.0,1.0).powf(1.15)) as f32
        }).collect();
        let start=Instant::now();
        let mut legacy=QuIVer::new(dim,&QuIVerConfig::default());
        let field=if let Some(p)=&params {
            Some(WarpedFieldIndex::build(dim,&ids,&slots,&radii,&mean,p.config(),|s,o|read(&c,s,o))?)
        } else {
            legacy.rebuild_from_cold_slots(&ids,&slots,&QuIVerConfig::default(),|s,o|read(&c,s,o))?;None
        };
        let build_ms=start.elapsed().as_secs_f64()*1000.0;
        if let Some(f)=&field {assert_eq!(f.connectivity(),(ids.len(),0));}
        let controls=HyperbolicSearchConfig {top_k:10,width:128,rerank_limit:64,
            max_visits:256,max_expansions:128,radial_bound:true};
        let mut samples=Vec::new();
        let mut terminals=Vec::new();
        for (qi,(_,split,query)) in queries.iter().enumerate() {
            let initial=energy(query);
            let mut residual=query.clone();
            let mut excluded=HashSet::new();
            let mut total_reads=0;let mut total_us=0.0;let mut accepted_layers=0;
            for layer in 0..3 {
                let before=energy(&residual);
                if before/initial<0.02 {break;}
                let radius=(0.35+(upper-0.35)*(0.25+0.25*layer as f64)) as f32;
                let mut cache=HashMap::new();
                let mut fill=|s:usize,o:&mut Vec<f32>| {
                    assert!(!excluded.contains(&ids[s]));assert!(!cache.contains_key(&s));
                    read(&c,s,o);cache.insert(s,o.clone());true
                };
                let mut trace=WarpedSearchTrace::default();
                let start=Instant::now();
                let (neighbors,stats)=if let Some(f)=&field {
                    let out=f.search_diagnosed(&residual,radius,controls,WarpedSeedMode::DirectionLandmarks,
                        Some(&mut trace),|id|excluded.contains(&id),&mut fill)?;
                    assert_eq!(cache.len(),out.stats.cold_reads);
                    (out.neighbors,json!({"visited":out.stats.visited,"expanded":out.stats.expanded,
                        "excluded_expanded":out.stats.excluded_expanded,"radial_rejections":out.stats.radial_rejections}))
                } else {
                    (legacy.search_with_options(&residual,&mut fill,&QuIVerSearchConfig {
                        top_k:10,ef_search:128,rerank_limit:Some(64)},&|id|excluded.contains(&id))
                        .into_iter().map(|(id,s)|(id,s as f64)).collect(),Value::Null)
                };
                let search_us=start.elapsed().as_secs_f64()*1e6;
                assert!(cache.len()<=64);
                let rows:Vec<_>=neighbors.iter().map(|&(id,d)|(ids.binary_search(&id).unwrap(),d)).collect();
                let start=Instant::now();
                let solution=fit(&residual,&rows,&ids,&cache)?;
                let nnls_us=start.elapsed().as_secs_f64()*1e6;
                total_us+=search_us+nnls_us;total_reads+=cache.len();
                let explained=(before-energy(&solution.residual)).max(0.0)/initial;
                let accepted=!rows.is_empty() && explained>=0.03;
                let mut truth=Vec::new();let mut cos_truth=Vec::new();
                let mut raw_cosines=HashMap::new();let mut row=Vec::new();let mut oracle_reads=0;
                for s in 0..ids.len() {
                    if excluded.contains(&ids[s]) {continue;}
                    read(&c,s,&mut row);oracle_reads+=1;
                    let cos=cosine(&residual,&row);raw_cosines.insert(s,cos);cos_truth.push((s,-cos));
                    let d=if let Some(f)=&field {f.exact_distance(&residual,radius,&row,s)?} else {-cos};
                    truth.push((s,d));
                }
                let top=|v:&mut Vec<(usize,f64)>| {
                    v.sort_unstable_by(|a,b|a.1.total_cmp(&b.1).then(ids[a.0].cmp(&ids[b.0])));v.truncate(10);
                };
                top(&mut truth);top(&mut cos_truth);
                let mut oracle_cache=HashMap::new();
                for &(s,_) in truth.iter().chain(&cos_truth) {
                    if oracle_cache.contains_key(&s) {continue;}
                    read(&c,s,&mut row);oracle_cache.insert(s,row.clone());
                }
                let exact=fit(&residual,&truth,&ids,&oracle_cache)?;
                let cos_exact=fit(&residual,&cos_truth,&ids,&oracle_cache)?;
                let oracle_energy=|s:&memo_nnls::Solution|before/initial*(1.0-s.diagnostics.residual_ratio).max(0.0);
                let hit=rows.iter().filter(|p|truth.iter().any(|t|t.0==p.0)).count() as f64/truth.len().max(1) as f64;
                let stage=field.as_ref().map(|_|stages(&trace,&truth,&ids));
                if let Some(stage)=&stage {
                    assert!((stage["stage05_top64_hit_rate"].as_f64().unwrap()-hit).abs()<1e-12,
                        "prefix/final recall mismatch");
                }
                // Same graph/query/exclusions control; never feeds the actual trajectory.
                let mut control_trace=WarpedSearchTrace::default();let mut control_reads=0;
                let control=if let Some(f)=&field {
                    let out=f.search_diagnosed(&residual,radius,controls,WarpedSeedMode::InnerOnly,
                        Some(&mut control_trace),|id|excluded.contains(&id),|s,o| {
                            control_reads+=1;read(&c,s,o)
                        })?;
                    assert_eq!(control_reads,out.stats.cold_reads);
                    Some(stages(&control_trace,&truth,&ids))
                } else {None};
                let mean_attr=|r:&[(usize,f64)],key:usize|r.iter().map(|p|match key {
                    0=>tags[p.0].1,1=>radii[p.0] as f64,_=>raw_cosines[&p.0]
                }).sum::<f64>()/r.len().max(1) as f64;
                samples.push(json!({"query":qi,"split":split,"layer":layer,"accepted":accepted,
                    "query_energy":before/initial,"ann_explained":explained,"exact_explained":oracle_energy(&exact),
                    "same_query_cosine_exact_explained":oracle_energy(&cos_exact),"own_recall":hit,
                    "avg_inbQ":mean_attr(&rows,0),"avg_R":mean_attr(&rows,1),"avg_cos":mean_attr(&rows,2),
                    "exact_avg_inbQ":mean_attr(&truth,0),"exact_avg_R":mean_attr(&truth,1),
                    "cold_reads":cache.len(),"nnls_additional_reads":0,"oracle_reads":oracle_reads,
                    "oracle_fit_reads":oracle_cache.len(),"control_reads":control_reads,
                    "search_us":search_us,"nnls_us":nnls_us,"stages":stage,"inner_control":control,
                    "stats":stats,"result_ids":rows.iter().map(|p|ids[p.0]).collect::<Vec<_>>(),
                    "truth_ids":truth.iter().map(|p|ids[p.0]).collect::<Vec<_>>()}));
                if !accepted {break;}
                accepted_layers+=1;excluded.extend(rows.iter().map(|p|ids[p.0]));residual=solution.residual;
            }
            terminals.push(json!({"query":qi,"split":split,"accepted_layers":accepted_layers,
                "explained":1.0-energy(&residual)/initial,"total_reads":total_reads,"total_us":total_us}));
        }
        serde_json::to_writer(&mut output,&json!({"route_completed":{"route":route,"params":params,
            "build_ms":build_ms,"hot_bytes":field.as_ref().map_or_else(||legacy.stats().hot_bytes,|f|f.hot_bytes()),
            "samples":samples,"terminals":terminals}}))?;
        output.write_all(b"\n")?;output.flush()?;
        eprintln!("phase4b {}/{count} {route} build_ms={build_ms:.1} elapsed_s={:.1}",ri+1,run_start.elapsed().as_secs_f64());
    }
    serde_json::to_writer(&mut output,&json!({"complete":true,"routes":count,
        "elapsed_s":run_start.elapsed().as_secs_f64()}))?;
    output.write_all(b"\n")?;
    Ok(())
}