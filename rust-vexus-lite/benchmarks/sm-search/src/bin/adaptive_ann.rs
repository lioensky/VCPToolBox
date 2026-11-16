//! Frozen adaptive-v1 ANN validation. Holdout never selects/tunes parameters.
#[allow(dead_code)]
#[path = "../../../../src/memo_nnls.rs"]
mod memo_nnls;
use std::{collections::{HashMap,HashSet},fs::OpenOptions,io::Write,time::Instant};
use rusqlite::{Connection,OpenFlags};
use serde_json::{json,Value};
use vcp_tdb_index::{QuIVer,QuIVerConfig,QuIVerSearchConfig};
use vcp_tdb_index::index::quiver::hyperbolic::*;

struct Tag {id:u64,name:String,inbound:f64,residual:f64,quantile:f64}
fn decode(blob:&[u8])->Vec<f32> {
    assert_eq!(blob.len()%4,0);
    blob.chunks_exact(4).map(|b|f32::from_le_bytes(b.try_into().unwrap())).collect()
}
fn read(c:&Connection,s:usize,out:&mut Vec<f32>)->bool {
    let blob:Vec<u8>=c.prepare_cached("SELECT vector FROM tags WHERE slot=?1").unwrap()
        .query_row([s as i64],|r|r.get(0)).unwrap();
    out.clear();
    out.extend(blob.chunks_exact(4).map(|b|f32::from_le_bytes(b.try_into().unwrap())));
    true
}
fn norm(v:&[f32])->f64 {v.iter().map(|&x|(x as f64).powi(2)).sum::<f64>().sqrt()}
fn cosine(a:&[f32],b:&[f32])->f64 {
    (a.iter().zip(b).map(|(&x,&y)|x as f64*y as f64).sum::<f64>()/norm(a)/norm(b)).clamp(-1.,1.)
}
fn raw_proxy(q:&[f32],qd:f32,v:&[f32],vd:f32)->f64 {
    let (qn,vn)=(norm(q),norm(v));
    let delta:f64=q.iter().zip(v).map(|(&a,&b)|(a as f64/qn-b as f64/vn).powi(2)).sum();
    polar_proxy(qd,vd,delta)
}
fn polar_proxy(qd:f32,vd:f32,delta:f64)->f64 {
    let (qd,vd)=(qd as f64,vd as f64);
    let (rq,rv)=((qd/2.).tanh(),(vd/2.).tanh());
    ((rq-rv).powi(2)+rq*rv*delta)*(qd/2.).cosh().powi(2)*(vd/2.).cosh().powi(2)
}
fn top(mut rows:Vec<(usize,f64)>,tags:&[Tag])->Vec<(usize,f64)> {
    rows.sort_by(|a,b|a.1.total_cmp(&b.1).then(tags[a.0].id.cmp(&tags[b.0].id)));
    rows.truncate(10); rows
}
fn recall(found:&[usize],truth:&[(usize,f64)])->Option<f64> {
    if truth.is_empty() {return None;}
    Some(found.iter().filter(|s|truth.iter().any(|t|t.0==**s)).count() as f64/truth.len() as f64)
}
fn fit(q:&[f32],rows:&[(usize,f64)],tags:&[Tag],cache:&HashMap<usize,Vec<f32>>)
    ->Result<memo_nnls::Solution,String> {
    let refs:Vec<_>=rows.iter().map(|p|(tags[p.0].id as i64,cache[&p.0].as_slice())).collect();
    memo_nnls::solve(q,&refs)
}
fn main()->Result<(),Box<dyn std::error::Error>> {
    assert_eq!(std::env::var("TRIVIUM_NO_AVX512").as_deref(),Ok("1"));
    let source=std::env::var("REAL_TAGS_DB")?;
    let destination=std::env::var("ADAPTIVE_OUT")?;
    assert_ne!(source,destination);
    let config=SemanticConeConfig::default();
    // Fixed BEFORE holdout evaluation, no env-based knob search.
    let upper=1.8_f32;
    let width=128;
    let cold_cap=64;
    let max_visits=256;
    let max_expansions=128;
    let minimum_explained=0.03;
    let c=Connection::open_with_flags(source,OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    c.execute_batch("PRAGMA query_only=ON; BEGIN")?;
    let metadata:String=c.query_row("SELECT value FROM metadata",[],|r|r.get(0))?;
    let metadata:Value=serde_json::from_str(&metadata)?;
    assert_eq!(metadata["inbound_quantile_schema"],"log1p-midrank-v1");
    let dim=metadata["dimension"].as_u64().unwrap() as usize;
    let maximum=metadata["max_inbound"].as_f64().unwrap();
    let tags:Vec<Tag>=c.prepare("SELECT slot,id,name,inbound,raw_residual_ratio,inbound_log_quantile FROM tags ORDER BY slot")?
        .query_map([],|r|Ok((r.get::<_,usize>(0)?,Tag {
            id:r.get(1)?,name:r.get(2)?,inbound:r.get(3)?,residual:r.get(4)?,quantile:r.get(5)?
        })))?.enumerate().map(|(i,r)| {let (s,t)=r.unwrap();assert_eq!(i,s);t}).collect();
    let queries:Vec<(i64,String,Vec<f32>)>=c.prepare(
        "SELECT q.source_chunk_id,s.split,q.vector FROM queries q JOIN query_sets s ON q.id=s.query_id ORDER BY q.id")?
        .query_map([],|r|Ok((r.get(0)?,r.get(1)?,decode(&r.get::<_,Vec<u8>>(2)?))))?
        .collect::<Result<_,_>>()?;
    assert_eq!(queries.iter().filter(|q|q.1=="holdout").count(),32);
    let dev:HashSet<_>=queries.iter().filter(|q|q.1=="development").map(|q|q.0).collect();
    assert!(queries.iter().filter(|q|q.1=="holdout").all(|q|!dev.contains(&q.0)));
    let n=tags.len();
    let ids:Vec<_>=tags.iter().map(|t|t.id).collect();
    let slots:Vec<_>=(0..n).collect();
    let raw_depths:Vec<f32>=tags.iter().map(|t| {
        let h=0.65*(1.-(t.inbound/maximum).sqrt())+0.35*t.residual;
        (0.35+(upper as f64-0.35)*h.clamp(0.,1.).powf(1.15)) as f32
    }).collect();
    let rank_depths:Vec<f32>=tags.iter().map(|t| {
        let h=0.65*(1.-t.quantile)+0.35*t.residual;
        (0.35+(upper as f64-0.35)*h.clamp(0.,1.).powf(1.15)) as f32
    }).collect();
    let mut output=OpenOptions::new().write(true).create_new(true).open(destination)?;
    let mut legacy=QuIVer::new(dim,&QuIVerConfig::default());
    let start=Instant::now();
    legacy.rebuild_from_cold_slots(&ids,&slots,&QuIVerConfig::default(),|s,o|read(&c,s,o))?;
    let legacy_build_ms=start.elapsed().as_secs_f64()*1000.;
    let start=Instant::now();
    let raw=HyperbolicIndex::build(dim,&ids,&slots,&raw_depths,
        HyperbolicConfig {landmarks:Some(512),..Default::default()},|s,o|read(&c,s,o))?;
    let raw_build_ms=start.elapsed().as_secs_f64()*1000.;
    let start=Instant::now();
    let calibrated=HyperbolicIndex::build(dim,&ids,&slots,&rank_depths,
        HyperbolicConfig {landmarks:Some(512),..Default::default()},|s,o|read(&c,s,o))?;
    let calibrated_build_ms=start.elapsed().as_secs_f64()*1000.;
    assert_eq!(raw.connectivity(),(n,0));
    assert_eq!(calibrated.connectivity(),(n,0));
    let mut reports=Vec::new();
    for route in ["legacy_cosine","raw_poincare","calibrated_mean","calibrated_landmark"] {
        let is_semantic=route.starts_with("calibrated");
        let cone_config=SemanticConeConfig {background:if route=="calibrated_landmark" {
            SemanticBackground::LandmarkMedian
        } else {SemanticBackground::Mean},..config};
        let index=if is_semantic {&calibrated} else {&raw};
        let depths=if is_semantic {&rank_depths} else {&raw_depths};
        let mut samples=Vec::new();
        let mut terminals=Vec::new();
        for (qi,(chunk,split,query)) in queries.iter().enumerate() {
            let initial=norm(query).powi(2);
            let mut residual=query.clone();
            let mut excluded:HashSet<u64>=HashSet::new();
            let mut accepted_layers=0;
            let mut stop="layer_cap";
            let mut total_retrieval_reads=0;
            let mut total_oracle_reads=0;
            let mut total_nnls_us=0.;
            let mut total_search_us=0.;
            for layer in 0..3usize {
                let energy=norm(&residual).powi(2);
                if energy/initial<0.02 {stop="remaining_energy_floor";break;}
                let qdepth=0.35+(upper-0.35)*(0.25+0.25*layer as f32);
                let cone=if is_semantic {Some(index.semantic_cone(&residual,cone_config)?)} else {None};
                let diagnostic_cone=calibrated.semantic_cone(&residual,config)?;
                let mut cache=HashMap::new();
                let mut fill=|s:usize,o:&mut Vec<f32>| {
                    assert!(!excluded.contains(&ids[s]));
                    assert!(!cache.contains_key(&s),"duplicate retrieval BLOB read");
                    read(&c,s,o); cache.insert(s,o.clone()); true
                };
                let start=Instant::now();
                let (found,stats)=if route=="legacy_cosine" {
                    let found=legacy.search_with_options(&residual,&mut fill,
                        &QuIVerSearchConfig {top_k:10,ef_search:width,rerank_limit:Some(cold_cap)},
                        &|id|excluded.contains(&id));
                    (found.into_iter().map(|(id,score)|(id,score as f64)).collect::<Vec<_>>(),json!(null))
                } else {
                    let result=index.search_with_semantic(&residual,qdepth,HyperbolicSearchConfig {
                        top_k:10,width,rerank_limit:cold_cap,max_visits,max_expansions,radial_bound:false
                    },if is_semantic {Some(cone_config)} else {None},|id|excluded.contains(&id),&mut fill)?;
                    let stats=json!({
                        "visited":result.stats.visited,"expanded":result.stats.expanded,
                        "excluded_expanded":result.stats.excluded_expanded,"seeds":result.stats.seeds,
                        "asymmetric_evals":result.stats.asymmetric_evals,
                        "direction_rejections":result.stats.direction_rejections,
                        "visit_limit_reached":result.stats.visit_limit_reached,
                        "expansion_limit_reached":result.stats.expansion_limit_reached,
                        "converged":result.stats.converged
                    });
                    assert_eq!(cache.len(),result.stats.cold_reads);
                    (result.neighbors,stats)
                };
                let search_us=start.elapsed().as_secs_f64()*1e6;
                total_search_us+=search_us;
                assert!(cache.len()<=64);
                total_retrieval_reads+=cache.len();
                let rows:Vec<_>=found.iter().map(|&(id,score)|(ids.binary_search(&id).unwrap(),score)).collect();
                let found_slots:Vec<_>=rows.iter().map(|p|p.0).collect();
                // Evaluation only, AFTER timed ANN. No oracle feeds back into retrieval.
                let mut exact_scores=Vec::new();
                let mut cosine_scores=Vec::new();
                let mut exact_cosines=HashMap::new();
                let mut row=Vec::with_capacity(dim);
                let mut oracle_reads=0;
                for slot in 0..n {
                    if excluded.contains(&ids[slot]) {continue;}
                    read(&c,slot,&mut row);oracle_reads+=1;
                    let cosine=cosine(&residual,&row);
                    exact_cosines.insert(slot,cosine);
                    cosine_scores.push((slot,-cosine));
                    let score=if route=="legacy_cosine" {-cosine}
                        else if let Some(cone)=cone {
                            if !cone.admits(cosine) {continue;}
                            polar_proxy(qdepth,depths[slot],2.*(1.-cone.effective(cosine)))
                        } else {raw_proxy(&residual,qdepth,&row,depths[slot])};
                    exact_scores.push((slot,score));
                }
                let exact_truth=top(exact_scores,&tags);
                let cosine_truth=top(cosine_scores,&tags);
                total_oracle_reads+=oracle_reads;
                let mut oracle_cache=HashMap::new();
                for &(s,_) in &exact_truth {
                    let mut v=Vec::new();read(&c,s,&mut v);oracle_cache.insert(s,v);
                }
                let exact_solution=fit(&residual,&exact_truth,&tags,&oracle_cache)?;
                let exact_explained=energy/initial*(1.-exact_solution.diagnostics.residual_ratio).max(0.);
                let start=Instant::now();
                let solution=fit(&residual,&rows,&tags,&cache)?;
                let nnls_us=start.elapsed().as_secs_f64()*1e6;
                total_nnls_us+=nnls_us;
                let next=norm(&solution.residual).powi(2);
                let explained=(energy-next).max(0.)/initial;
                let accepted=!rows.is_empty() && explained>=minimum_explained;
                let words:Vec<_>=rows.iter().map(|&(s,score)|json!({
                    "id":ids[s],"word":tags[s].name,"score":score,"cosine":exact_cosines[&s],
                    "depth":depths[s],"inbound":tags[s].inbound,"inbound_quantile":tags[s].quantile,
                    "below_query_background":exact_cosines[&s]<=diagnostic_cone.background
                })).collect();
                if let Some(cone)=cone {
                    assert!(rows.iter().all(|p|cone.admits(exact_cosines[&p.0])));
                }
                let cone_json=|cone:SemanticCone|json!({
                    "alignment":cone.mean_alignment,"baseline":cone.baseline,"sigma_reference":cone.sigma_reference,
                    "background":cone.background,"top":cone.top,"landmark_evals":cone.landmark_evals
                });
                let exact_words:Vec<_>=exact_truth.iter().map(|&(s,score)|json!({
                    "id":ids[s],"word":tags[s].name,"proxy_or_negative_cosine":score,
                    "cosine":exact_cosines[&s],"depth":depths[s]
                })).collect();
                let watched_names=["物理确权","兔娘小芸","燕云十六声","Nova认知升级","逻辑熵减","Nova运维记录"];
                let watched:Vec<_>=watched_names.iter().map(|name| {
                    let slot=tags.iter().position(|t|t.name==*name);
                    match slot {
                        None=>json!({"word":name,"in_sample":false}),
                        Some(s)=>json!({
                            "word":name,"in_sample":true,"excluded":excluded.contains(&ids[s]),
                            "cosine":exact_cosines.get(&s),
                            "passes_direction_gate":exact_cosines.get(&s).map(|&c|cone.map_or(true,|gate|gate.admits(c))),
                            "own_exact_top10":exact_truth.iter().any(|p|p.0==s),
                            "cosine_exact_top10":cosine_truth.iter().any(|p|p.0==s),
                            "ann_top10":found_slots.contains(&s),
                            "accepted_ann":accepted && found_slots.contains(&s)
                        })
                    }
                }).collect();
                samples.push(json!({
                    "query":qi,"split":split,"chunk_id":chunk,"layer":layer,"accepted":accepted,
                    "query_energy_ratio":energy/initial,"explained_energy":explained,
                    "candidate_next_energy_ratio":next/initial,
                    "own_exact_recall":recall(&found_slots,&exact_truth),
                    "own_exact_truth_size":exact_truth.len(),
                    "cosine_top10_overlap":recall(&found_slots,&cosine_truth),
                    "exact_explainable_energy":exact_explained,
                    "premature_stop_vs_exact":!accepted && exact_explained>=minimum_explained,
                    "clean_stop_vs_exact":!accepted && exact_explained<minimum_explained,
                    "valid_returns":rows.len(),"retrieval_blob_reads":cache.len(),
                    "nnls_additional_blob_reads":0,"oracle_blob_reads":oracle_reads,
                    "oracle_nnls_blob_reads":oracle_cache.len(),"search_us":search_us,"nnls_us":nnls_us,
                    "cone":cone.map(cone_json),"diagnostic_mean_cone":cone_json(diagnostic_cone),
                    "mean_alignment":diagnostic_cone.mean_alignment,
                    "max_exact_cosine":exact_cosines.values().copied().fold(-1.0,f64::max),
                    "background_return_count":rows.iter().filter(|p|exact_cosines[&p.0]<=diagnostic_cone.background).count(),
                    "high_inbound_background_return_count":rows.iter().filter(|p|
                        tags[p.0].quantile>=0.95 && exact_cosines[&p.0]<=diagnostic_cone.background).count(),
                    "nnls":solution.diagnostics,"contributions":solution.contributions,"words":words,"stats":stats,
                    "own_exact_words":exact_words,"watched_word_audit":watched
                }));
                if rows.is_empty() {stop="empty_result_cone";break;}
                if !accepted {stop="insufficient_explained_energy";break;}
                accepted_layers+=1;
                excluded.extend(rows.iter().map(|p|ids[p.0]));
                residual=solution.residual;
            }
            terminals.push(json!({
                "query":qi,"split":split,"accepted_layers":accepted_layers,"stop":stop,
                "final_accepted_energy_ratio":norm(&residual).powi(2)/initial,
                "total_retrieval_blob_reads":total_retrieval_reads,"total_oracle_blob_reads":total_oracle_reads,
                "total_search_us":total_search_us,"total_nnls_us":total_nnls_us
            }));
        }
        eprintln!("adaptive n={n} route={route} samples={} queries={}",samples.len(),terminals.len());
        reports.push(json!({"route":route,"samples":samples,"terminals":terminals}));
    }
    serde_json::to_writer_pretty(&mut output,&json!({
        "schema":"adaptive-ann-v1","source_metadata":metadata,"n":n,"dim":dim,
        "frozen_rule":{"noise_z":config.noise_z,"residual_width":config.residual_width,
            "anisotropic_width_gain":config.anisotropic_width_gain,"alignment_reference":config.alignment_reference,
            "formula":"b=max(mean unit-direction alignment,0) or hot-landmark median; bg=min(b+z/sqrt(D),.98); top=min(max(b+.25+.05*clamp(b/.45),bg+.001),.999)"},
        "frozen_controls":{"dmax":upper,"width":width,"cold_cap":cold_cap,"max_visits":max_visits,
            "max_expansions":max_expansions,"min_layer_explained_energy":minimum_explained},
        "legacy_build_ms":legacy_build_ms,"raw_build_ms":raw_build_ms,"calibrated_build_ms":calibrated_build_ms,
        "legacy_hot_bytes":legacy.stats().hot_bytes,"raw_hot_bytes":raw.hot_bytes(),
        "calibrated_hot_bytes":calibrated.hot_bytes(),"mean_bytes":dim*8,
        "raw_reverse_prunes":raw.reverse_prune_stats().0,"raw_reverse_prune_ns":raw.reverse_prune_stats().1,
        "calibrated_reverse_prunes":calibrated.reverse_prune_stats().0,
        "calibrated_reverse_prune_ns":calibrated.reverse_prune_stats().1,
        "warning":"semantic score is nonmetric; geometric graph/seeds unchanged; no hot hard reject; exact gate after bounded cold reads",
        "timing_scope":"ANN before oracle; warm frozen SQLite, bounded <=64 vector cache reused by NNLS; oracle excluded from reported runtime; fixed route order",
        "truth_scope":"sampled Tag population; conditional per-route residuals, no semantic relevance labels or EPA replay",
        "noise_warning":"1/sqrt(D) is a reference scale, NOT fitted isotropic variance or a guaranteed null distribution",
        "reports":reports
    }))?;
    output.write_all(b"\n")?;
    Ok(())
}