//! Predeclared Tier-3 matrix; private outputs exclusively created under target.
#[allow(dead_code)]
#[path = "../../../../src/memo_nnls.rs"]
mod memo_nnls;
use std::{collections::{HashMap,HashSet},fs::OpenOptions,io::Write,time::Instant};
use rusqlite::{Connection,OpenFlags};
use serde_json::{json,Value};
use vcp_tdb_index::{QuIVer,QuIVerConfig,QuIVerSearchConfig};
use vcp_tdb_index::index::quiver::hyperbolic::*;
use vcp_tdb_index::index::quiver::hyperbolic::warped_geometry::WarpedProfile;

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
fn main()->Result<(),Box<dyn std::error::Error>> {
    assert_eq!(std::env::var("TRIVIUM_NO_AVX512").as_deref(),Ok("1"));
    let source=std::env::var("REAL_TAGS_DB")?;
    let destination=std::env::var("WARPED_OUT")?;
    let smoke=std::env::var("WARPED_SMOKE").as_deref()==Ok("1");
    let c=Connection::open_with_flags(source,OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    c.execute_batch("PRAGMA query_only=ON;BEGIN")?;
    let metadata:String=c.query_row("SELECT value FROM metadata",[],|r|r.get(0))?;
    let metadata:Value=serde_json::from_str(&metadata)?;
    assert_eq!(metadata["inbound_quantile_schema"],"log1p-midrank-v1");
    assert_eq!(metadata["fresh_seed"],20261117);
    let dim=metadata["dimension"].as_u64().unwrap() as usize;
    let mean:Vec<f64>=serde_json::from_value(metadata["mean_direction"].clone())?;
    let tags:Vec<(u64,f64,f64)>=c.prepare(
        "SELECT id,inbound_log_quantile,raw_residual_ratio FROM tags ORDER BY slot")?
        .query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?.collect::<Result<_,_>>()?;
    let ids:Vec<_>=tags.iter().map(|t|t.0).collect();
    let slots:Vec<_>=(0..ids.len()).collect();
    let queries:Vec<(i64,String,Vec<f32>)>=c.prepare(
        "SELECT q.source_chunk_id,s.split,q.vector FROM queries q JOIN query_sets s ON q.id=s.query_id ORDER BY q.id")?
        .query_map([],|r|Ok((r.get(0)?,r.get(1)?,decode(&r.get::<_,Vec<u8>>(2)?))))?
        .collect::<Result<_,_>>()?;
    assert_eq!(queries.iter().filter(|q|q.1=="fresh_holdout").count(),32);
    assert_eq!(queries.iter().map(|q|q.0).collect::<HashSet<_>>().len(),queries.len());
    let mut output=OpenOptions::new().write(true).create_new(true).open(destination)?;
    let mut matrix=vec![("cosine".to_owned(),None)];
    let uppers=if smoke {vec![1.8]} else {vec![1.6,1.8,2.2]};
    for upper in uppers {
        matrix.push((format!("constant_rank_{upper}"),Some(WarpedFieldConfig {
            profile:WarpedProfile::ConstantHyperbolic {curvature:1.0},radius_max:upper,
            mean_subtract_beta:0.0,..Default::default()})));
        matrix.push((format!("steepening_{upper}"),Some(WarpedFieldConfig {
            profile:WarpedProfile::Steepening {alpha:0.20},radius_max:upper,
            mean_subtract_beta:0.70,..Default::default()})));
        for alpha in if smoke {vec![0.35]} else {vec![0.15,0.35,0.60]} {
            for beta in if smoke {vec![0.70]} else {vec![0.0,0.70,1.0]} {
                matrix.push((format!("soft_{upper}_{alpha}_{beta}"),Some(WarpedFieldConfig {
                    profile:WarpedProfile::Softening {alpha},radius_max:upper,
                    mean_subtract_beta:beta,..Default::default()})));
            }
        }
    }
    let mut reports=Vec::new();
    for (route,cfg) in matrix {
        let upper=cfg.map_or(1.8,|c|c.radius_max);
        let radii:Vec<f32>=tags.iter().map(|t| {
            let h=(0.65*(1.0-t.1)+0.35*t.2).clamp(0.0,1.0);
            (0.35+(upper-0.35)*h.powf(1.15)) as f32
        }).collect();
        let start=Instant::now();
        let mut legacy=QuIVer::new(dim,&QuIVerConfig::default());
        let field=if let Some(cfg)=cfg {
            Some(WarpedFieldIndex::build(dim,&ids,&slots,&radii,&mean,cfg,|s,o|read(&c,s,o))?)
        } else {
            legacy.rebuild_from_cold_slots(&ids,&slots,&QuIVerConfig::default(),|s,o|read(&c,s,o))?;None
        };
        let build_ms=start.elapsed().as_secs_f64()*1000.0;
        if let Some(f)=&field {assert_eq!(f.connectivity(),(ids.len(),0));}
        eprintln!("warped n={} route={route} build_ms={build_ms:.2}",ids.len());
        let mut samples=Vec::new();
        let mut terminals=Vec::new();
        for (qi,(_,split,query)) in queries.iter().enumerate() {
            if smoke && (split!="development" || qi>=2) {continue;}
            let initial=energy(query);
            let mut residual=query.clone();
            let mut excluded=HashSet::new();
            let mut accepted_layers=0;
            let mut total_reads=0;
            let mut total_us=0.0;
            let mut stop="layer_cap";
            for layer in 0..3 {
                let before=energy(&residual);
                if before/initial<0.02 {stop="energy_floor";break;}
                let radius=(0.35+(upper-0.35)*(0.25+0.25*layer as f64)) as f32;
                let mut cache=HashMap::new();
                let mut fill=|s:usize,o:&mut Vec<f32>| {
                    assert!(!excluded.contains(&ids[s]));assert!(!cache.contains_key(&s));
                    read(&c,s,o);cache.insert(s,o.clone());true
                };
                let start=Instant::now();
                let (neighbors,stats)=if let Some(f)=&field {
                    let result=f.search(&residual,radius,HyperbolicSearchConfig {
                        top_k:10,width:128,rerank_limit:64,max_visits:256,max_expansions:128,radial_bound:true
                    },|id|excluded.contains(&id),&mut fill)?;
                    assert_eq!(result.stats.cold_reads,cache.len());
                    (result.neighbors,json!({"visits":result.stats.visited,"expanded":result.stats.expanded,
                        "excluded_expanded":result.stats.excluded_expanded,"seeds":result.stats.seeds,
                        "radial_rejections":result.stats.radial_rejections,
                        "asymmetric_evals":result.stats.asymmetric_evals}))
                } else {
                    (legacy.search_with_options(&residual,&mut fill,&QuIVerSearchConfig {
                        top_k:10,ef_search:128,rerank_limit:Some(64)},&|id|excluded.contains(&id))
                        .into_iter().map(|(id,s)|(id,s as f64)).collect(),json!(null))
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
                // Evaluation AFTER timed search and NNLS, never fed into routing.
                let mut truth=Vec::new();
                let mut raw_cosines=HashMap::new();
                let mut row=Vec::new();
                let mut oracle_reads=0;
                for s in 0..ids.len() {
                    if excluded.contains(&ids[s]) {continue;}
                    read(&c,s,&mut row);oracle_reads+=1;
                    let cos=cosine(&residual,&row);
                    raw_cosines.insert(s,cos);
                    let d=if let Some(f)=&field {f.exact_distance(&residual,radius,&row,s)?} else {-cos};
                    truth.push((s,d));
                }
                truth.sort_unstable_by(|a,b|a.1.total_cmp(&b.1).then(ids[a.0].cmp(&ids[b.0])));
                truth.truncate(10);
                let hits=rows.iter().filter(|p|truth.iter().any(|t|t.0==p.0)).count();
                let mut oracle_cache=HashMap::new();
                for &(s,_) in &truth {read(&c,s,&mut row);oracle_cache.insert(s,row.clone());}
                let exact_solution=fit(&residual,&truth,&ids,&oracle_cache)?;
                let exact_explained=before/initial*(1.0-exact_solution.diagnostics.residual_ratio).max(0.0);
                let words:Vec<_>=rows.iter().map(|p|json!({"id":ids[p.0],"distance_or_cosine":p.1,
                    "original_cosine":raw_cosines[&p.0],"radius":radii[p.0],"inbound_quantile":tags[p.0].1})).collect();
                samples.push(json!({"query":qi,"split":split,"layer":layer,"accepted":accepted,
                    "own_recall":hits as f64/truth.len().max(1) as f64,"truth_size":truth.len(),
                    "explained":explained,"exact_explained":exact_explained,
                    "premature_stop":!accepted && exact_explained>=0.03,
                    "cold_reads":cache.len(),"oracle_reads":oracle_reads,
                    "oracle_nnls_reads":oracle_cache.len(),"nnls_additional_reads":0,
                    "search_us":search_us,"nnls_us":nnls_us,"words":words,"stats":stats}));
                if !accepted {stop="insufficient_explained_energy";break;}
                accepted_layers+=1;excluded.extend(rows.iter().map(|p|ids[p.0]));residual=solution.residual;
            }
            terminals.push(json!({"query":qi,"split":split,"accepted_layers":accepted_layers,"stop":stop,
                "explained":1.0-energy(&residual)/initial,"total_reads":total_reads,"total_us":total_us}));
        }
        reports.push(json!({"route":route,"config":format!("{cfg:?}"),"build_ms":build_ms,
            "hot_bytes":field.as_ref().map_or_else(||legacy.stats().hot_bytes,|f|f.hot_bytes()),
            "samples":samples,"terminals":terminals}));
        // Preserve completed routes if interrupted, without overwriting an old output.
        serde_json::to_writer(&mut output,&json!({"route_completed":reports.last()}))?;
        output.write_all(b"\n")?;output.flush()?;
    }
    serde_json::to_writer(&mut output,&json!({"schema":"warped-field-v1","smoke":smoke,
        "metadata":metadata,"n":ids.len(),"dimension":dim,"reports":reports,
        "protocol":"identity angular map; actual original-space NNLS; .03 accept-before-update; per-layer 64 reads; 256 visits/128 expansions; no EPA replay; ID-disjoint not document-disjoint",
        "bounds":"radial only; no unproven quantized angular bound; Dipping-Horizon pending",
        "timing":"warm frozen SQLite; fixed route order; oracle excluded; build includes table"}))?;
    output.write_all(b"\n")?;
    Ok(())
}