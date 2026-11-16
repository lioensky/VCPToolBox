//! Exact score ablation only. No production/index lifecycle or ANN changes.
#[allow(dead_code)]
#[path = "../../../../src/memo_nnls.rs"]
mod memo_nnls;
use std::{collections::HashSet, fs::OpenOptions, io::Write, time::Instant};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug)]
struct Cone {
    background: f64,
    top: f64,
}
impl Cone {
    fn new(background: f64, top: f64) -> Result<Self, &'static str> {
        if !background.is_finite() || !top.is_finite()
            || background < -1.0 || top > 1.0 || background >= top {
            return Err("invalid local cosine calibration");
        }
        Ok(Self {background, top})
    }
    fn effective(self, cosine: f64) -> f64 {
        ((cosine-self.background)/(self.top-self.background)).clamp(0.,1.)
    }
    fn admits(self, cosine: f64) -> bool { cosine > self.background }
}
#[derive(Clone)]
struct Tag {
    id: i64,
    word: String,
    inbound: f64,
    residual: f64,
    quantile: f64,
}
#[derive(Clone, Copy)]
struct Observation {
    slot: usize,
    cosine: f64,
    delta: f64,
}
struct Layer {
    query: Vec<f32>,
    observations: Vec<Observation>,
    oracle_reads: usize,
}
fn norm(v: &[f32]) -> f64 {
    v.iter().map(|&x|(x as f64).powi(2)).sum::<f64>().sqrt()
}
fn read(conn: &Connection, slot: usize) -> Vec<f32> {
    let blob: Vec<u8> = conn.prepare_cached("SELECT vector FROM tags WHERE slot=?1").unwrap()
        .query_row([slot as i64],|r|r.get(0)).unwrap();
    decode(&blob)
}
fn decode(blob: &[u8]) -> Vec<f32> {
    assert_eq!(blob.len()%4,0);
    blob.chunks_exact(4).map(|b|f32::from_le_bytes(b.try_into().unwrap())).collect()
}
fn scan(conn: &Connection, tags: &[Tag], query: Vec<f32>, excluded: &HashSet<usize>) -> Layer {
    let nq = norm(&query);
    assert!(nq > 0. && nq.is_finite());
    let mut observations = Vec::new();
    for slot in 0..tags.len() {
        if excluded.contains(&slot) {continue;}
        let vector = read(conn,slot);
        assert_eq!(query.len(),vector.len());
        let nv = norm(&vector);
        assert!(nv > 0. && nv.is_finite());
        let mut dot = 0.;
        let mut delta = 0.;
        for (&q,&v) in query.iter().zip(&vector) {
            dot += q as f64*v as f64;
            let difference = q as f64/nq-v as f64/nv;
            delta += difference*difference;
        }
        observations.push(Observation {slot,cosine:(dot/nq/nv).clamp(-1.,1.),delta});
    }
    Layer {oracle_reads:observations.len(),query,observations}
}
fn proxy(qdepth: f32, depth: f32, angular_delta: f64) -> f64 {
    let (qdepth,depth) = (qdepth as f64,depth as f64);
    let (rq,rv) = ((qdepth/2.).tanh(),(depth/2.).tanh());
    ((rq-rv).powi(2)+rq*rv*angular_delta)
        *(qdepth/2.).cosh().powi(2)*(depth/2.).cosh().powi(2)
}
fn rank(mut rows: Vec<(Observation,f64)>, tags: &[Tag]) -> Vec<(Observation,f64)> {
    rows.sort_unstable_by(|a,b| a.1.total_cmp(&b.1)
        .then(tags[a.0.slot].id.cmp(&tags[b.0.slot].id)));
    rows.truncate(10);
    rows
}
fn cosine_truth(layer: &Layer, tags: &[Tag], gate: bool, cone: Cone) -> Vec<(Observation,f64)> {
    rank(layer.observations.iter().filter(|o|!gate || cone.admits(o.cosine))
        .map(|&o|(o,-o.cosine)).collect(),tags)
}
fn overlap(rows: &[(Observation,f64)], truth: &[(Observation,f64)]) -> f64 {
    if truth.is_empty() {return 0.;}
    rows.iter().filter(|p|truth.iter().any(|t|t.0.slot==p.0.slot)).count() as f64/truth.len() as f64
}
fn solve(conn: &Connection, tags: &[Tag], query: &[f32], rows: &[(Observation,f64)])
    -> Result<memo_nnls::Solution,String> {
    let vectors: Vec<_> = rows.iter().map(|p|read(conn,p.0.slot)).collect();
    let refs: Vec<_> = rows.iter().zip(&vectors).map(|(p,v)|(tags[p.0.slot].id,v.as_slice())).collect();
    memo_nnls::solve(query,&refs)
}
fn main() -> Result<(),Box<dyn std::error::Error>> {
    let source = std::env::var("REAL_TAGS_DB")?;
    let destination = std::env::var("SEMANTIC_OUT")?;
    assert_ne!(source,destination);
    let policy = std::env::var("SEMANTIC_POLICY").unwrap_or_else(|_|"shared_reference".into());
    assert!(matches!(policy.as_str(),"shared_reference"|"score_closed_loop"));
    let closed = policy=="score_closed_loop";
    let background = std::env::var("CONE_BACKGROUND").unwrap_or_else(|_|"0.25".into()).parse()?;
    let top = std::env::var("CONE_TOP").unwrap_or_else(|_|"0.75".into()).parse()?;
    let cone = Cone::new(background,top)?;
    let conn = Connection::open_with_flags(source,OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    conn.execute_batch("PRAGMA query_only=ON; BEGIN")?;
    let metadata: String = conn.query_row("SELECT value FROM metadata",[],|r|r.get(0))?;
    let metadata: Value = serde_json::from_str(&metadata)?;
    assert_eq!(metadata["inbound_quantile_schema"],"log1p-midrank-v1");
    let max_inbound = metadata["max_inbound"].as_f64().unwrap();
    let tags: Vec<Tag> = conn.prepare("SELECT slot,id,name,inbound,raw_residual_ratio,inbound_log_quantile FROM tags ORDER BY slot")?
        .query_map([],|r|Ok((r.get::<_,usize>(0)?,Tag {
            id:r.get(1)?,word:r.get(2)?,inbound:r.get(3)?,residual:r.get(4)?,quantile:r.get(5)?
        })))?.enumerate().map(|(i,row)| {
            let (slot,tag)=row.unwrap(); assert_eq!(i,slot);
            assert!(tag.quantile.is_finite() && (0.0..=1.0).contains(&tag.quantile));
            tag
        }).collect();
    let queries: Vec<(i64,Vec<f32>)> = conn.prepare("SELECT source_chunk_id,vector FROM queries ORDER BY id")?
        .query_map([],|r|Ok((r.get(0)?,decode(&r.get::<_,Vec<u8>>(1)?))))?
        .collect::<Result<_,_>>()?;
    // Shared reference directions computed once; only O(N) scalar observations per layer.
    // No retained N*D FP32 matrix; the bounded query batch is explicitly recorded.
    let mut reference = Vec::new();
    let mut reference_reads = 0;
    let mut reference_nnls_reads = 0;
    if !closed {
        for (_,query) in &queries {
            let initial = norm(query);
            let mut residual = query.clone();
            let mut excluded = HashSet::new();
            let mut layers = Vec::new();
            for _ in 0..3 {
                if norm(&residual)/initial <= 0.02 {break;}
                let layer = scan(&conn,&tags,residual,&excluded);
                reference_reads+=layer.oracle_reads;
                let truth = cosine_truth(&layer,&tags,false,cone);
                reference_nnls_reads+=truth.len();
                let solution = solve(&conn,&tags,&layer.query,&truth)?;
                excluded.extend(truth.iter().map(|p|p.0.slot));
                residual = solution.residual;
                layers.push(layer);
            }
            reference.push(layers);
        }
    }
    let mut output = OpenOptions::new().write(true).create_new(true).open(destination)?;
    let mut reports = Vec::new();
    for upper in [1.4_f32,1.8,2.4] {
        for rank_depth in [false,true] {
            let depths: Vec<f32> = tags.iter().map(|tag| {
                let specificity = if rank_depth {1.-tag.quantile}
                    else {1.-(tag.inbound/max_inbound).clamp(0.,1.).sqrt()};
                let h = (0.65*specificity+0.35*tag.residual).clamp(0.,1.);
                (0.35+(upper as f64-0.35)*h.powf(1.15)) as f32
            }).collect();
            let mut sorted_depths = depths.clone();
            sorted_depths.sort_by(f32::total_cmp);
            let quantile = |q:f64|sorted_depths[((sorted_depths.len()-1) as f64*q) as usize];
            for calibrated in [false,true] {
                for gate in [false,true] {
                    let mut samples = Vec::new();
                    for (qi,(chunk_id,query)) in queries.iter().enumerate() {
                        let initial = norm(query);
                        let mut residual = query.clone();
                        let mut excluded = HashSet::new();
                        for layer_number in 0..3usize {
                            if closed && norm(&residual)/initial<=0.02 {break;}
                            if !closed && layer_number>=reference[qi].len() {break;}
                            let owned;
                            let layer = if closed {
                                owned=scan(&conn,&tags,std::mem::take(&mut residual),&excluded); &owned
                            } else {&reference[qi][layer_number]};
                            let qdepth = 0.35+(upper-0.35)*(0.25+0.25*layer_number as f32);
                            let truth = cosine_truth(layer,&tags,false,cone);
                            let eligible_truth = cosine_truth(layer,&tags,true,cone);
                            let started = Instant::now();
                            let rows = rank(layer.observations.iter()
                                .filter(|o|!gate || cone.admits(o.cosine))
                                .map(|&o| {
                                    let delta = if calibrated {2.*(1.-cone.effective(o.cosine))} else {o.delta};
                                    (o,proxy(qdepth,depths[o.slot],delta))
                                }).collect(),&tags);
                            let score_us=started.elapsed().as_secs_f64()*1e6;
                            let solution=solve(&conn,&tags,&layer.query,&rows)?;
                            let energy=(norm(&layer.query)/initial).powi(2);
                            let background_count=rows.iter().filter(|p|!cone.admits(p.0.cosine)).count();
                            if gate {assert_eq!(background_count,0);}
                            if closed {assert!(rows.iter().all(|p|!excluded.contains(&p.0.slot)));}
                            let words: Vec<_> = rows.iter().map(|&(o,score)|json!({
                                "id":tags[o.slot].id,"word":tags[o.slot].word,"score_proxy":score,
                                "cosine":o.cosine,"effective_cosine":cone.effective(o.cosine),
                                "depth":depths[o.slot],"inbound":tags[o.slot].inbound,
                                "inbound_quantile":tags[o.slot].quantile,"raw_residual_ratio":tags[o.slot].residual
                            })).collect();
                            samples.push(json!({
                                "query":qi,"chunk_id":chunk_id,"layer":layer_number,"query_depth":qdepth,
                                "cosine_top10_overlap":overlap(&rows,&truth),
                                "eligible_cosine_top10_overlap":overlap(&rows,&eligible_truth),
                                "eligible_cosine_truth_size":eligible_truth.len(),
                                "valid_returns":rows.len(),"background_count":background_count,
                                "eligible_population":layer.observations.iter().filter(|o|cone.admits(o.cosine)).count(),
                                "query_energy_ratio":energy,
                                "next_energy_ratio":energy*solution.diagnostics.residual_ratio,
                                "nnls":solution.diagnostics,"nnls_contributions":solution.contributions,
                                "oracle_reads_this_sample":if closed {layer.oracle_reads} else {0},
                                "nnls_blob_reads":rows.len(),"score_only_us":score_us,"words":words
                            }));
                            if closed {
                                excluded.extend(rows.iter().map(|p|p.0.slot));
                                if rows.is_empty() {break;}
                                residual=solution.residual;
                            }
                        }
                    }
                    eprintln!("dmax={upper} rank={rank_depth} calibrated={calibrated} gate={gate} samples={}",samples.len());
                    let terminal: Vec<_> = (0..queries.len()).map(|qi| {
                        let last = samples.iter().rev().find(|x|x["query"].as_u64()==Some(qi as u64)).unwrap();
                        json!({
                            "query":qi,"last_layer":last["layer"],
                            "final_energy_ratio":last["next_energy_ratio"],
                            "stop_reason":if !closed {"reference_layer_cap"}
                                else if last["valid_returns"].as_u64()==Some(0) {"empty_direction_cone"}
                                else if last["layer"].as_u64()==Some(2) {"layer_cap"}
                                else {"energy_floor"}
                        })
                    }).collect();
                    reports.push(json!({
                        "dmax":upper,"rank_depth":rank_depth,"calibrated":calibrated,"direction_gate":gate,
                        "terminal_all_queries":terminal,
                        "depth_quantiles":[quantile(0.),quantile(0.1),quantile(0.5),quantile(0.9),quantile(1.)],
                        "outer_fraction":depths.iter().filter(|&&d|d>0.35+0.8*(upper-0.35)).count() as f64/tags.len() as f64,
                        "samples":samples
                    }));
                }
            }
        }
    }
    serde_json::to_writer_pretty(&mut output,&json!({
        "schema":"semantic-score-ablation-v1","source_metadata":metadata,"n":tags.len(),
        "policy":policy,"background":background,"top":top,"reports":reports,
        "reference_oracle_blob_reads":reference_reads,"reference_nnls_blob_reads":reference_nnls_reads,
        "warning":"exact full-scan score ablation, NOT ANN/64-read performance; local clipped scores are NOT the original Poincare metric",
        "query_depth":"controlled 25/50/75% of [.35,dmax]; NOT EPA replay",
        "gate":"exact original cosine > background; navigation eligibility not changed",
        "empty_truth":"eligible overlap defined as zero if eligible truth is empty; inspect truth size and valid returns",
        "closed_loop":"each score variant uses and excludes its own previous exact top10; later directions differ"
    }))?;
    output.write_all(b"\n")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn calibration_clamps_and_gate_is_strict() {
        let cone=Cone::new(0.25,0.75).unwrap();
        for (raw,want) in [(-1.,0.),(0.25,0.),(0.5,0.5),(0.75,1.),(1.,1.)] {
            assert_eq!(cone.effective(raw),want);
        }
        assert!(!cone.admits(0.25));
        assert!(cone.admits(0.25000001));
        for (a,b) in [(0.5,0.5),(0.8,0.2),(-1.1,0.75),(0.,1.1),(f64::NAN,1.)] {
            assert!(Cone::new(a,b).is_err());
        }
    }
    #[test]
    fn background_clamp_alone_does_not_remove_small_radius_advantage() {
        let cone=Cone::new(0.25,0.75).unwrap();
        let delta=2.*(1.-cone.effective(0.1));
        assert!(proxy(1.5,0.35,delta)<proxy(1.5,1.5,delta));
        assert!(!cone.admits(0.1));
    }
    #[test]
    fn clipped_similarity_is_not_original_geodesic_metric() {
        let cone=Cone::new(0.25,0.75).unwrap();
        let thirty=std::f64::consts::PI/6.;
        assert_eq!(proxy(1.,1.,2.*(1.-cone.effective(thirty.cos()))),0.);
        assert!(proxy(1.,1.,2.*(1.-cone.effective((2.*thirty).cos())))>0.);
        // Distinct 30-degree directions have zero score, unlike a metric.
    }
    #[test]
    fn tied_score_sort_is_stable_by_tag_id_and_gate_can_return_empty() {
        let tags=vec![
            Tag {id:8,word:String::new(),inbound:1.,residual:0.,quantile:0.5},
            Tag {id:2,word:String::new(),inbound:1.,residual:0.,quantile:0.5}
        ];
        let observations=vec![
            Observation {slot:0,cosine:0.1,delta:1.8},
            Observation {slot:1,cosine:0.1,delta:1.8}
        ];
        let layer=Layer {query:vec![1.],observations,oracle_reads:2};
        let cone=Cone::new(0.25,0.75).unwrap();
        assert_eq!(cosine_truth(&layer,&tags,false,cone)[0].0.slot,1);
        assert!(cosine_truth(&layer,&tags,true,cone).is_empty());
    }
}