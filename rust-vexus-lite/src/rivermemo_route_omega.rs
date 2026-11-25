use super::*;

pub(super) struct Transport {
    pub vector: Option<Vec<f32>>,
    pub routes: Vec<Value>,
    pub selected: Option<(i64,i64,f64,f64)>,
}

fn row(a:&NativeArtifact,i:usize)->std::ops::Range<usize> {
    a.row_offsets[i]..a.row_offsets[i+1]
}

// Bound work on large rows; preserve substochastic raw conductances, never
// redistribute screened edges' mass. Remove observed dynamic shortcuts too.
fn ordinary<'a>(a:&'a NativeArtifact,i:usize,blocked:&'a HashSet<(i64,i64)>)
    -> impl Iterator<Item=(usize,f64)>+'a {
    row(a,i).take(32).filter_map(move |k| {
        let j=a.targets[k]; let w=positive(a.weights[k]);
        (w>0. && i!=j && !a.edge_is_wormhole[k] &&
            !blocked.contains(&(a.node_ids[i],a.node_ids[j]))).then_some((j,w))
    })
}

pub(super) fn prepare(input:&NativeInput,v:&TagVectorPool,a:&NativeArtifact)->Transport {
    let mut out=Transport{vector:None,routes:Vec::new(),selected:None};
    if !input.query_state.complete_observation {return out;}
    let mut focus:Vec<_>=input.query_state.field_provenance.iter()
        .filter(|p|p.hop==0 && matches!(p.source_type.as_str(),"core"|"lexical_seed"))
        .map(|p|p.id).collect();
    focus.sort_unstable();focus.dedup();
    let first:HashSet<_>=input.query_state.river_nodes.iter().filter(|n|n.hop==1).map(|n|n.id).collect();
    let blocked:HashSet<_>=input.query_state.river_edges.iter().filter(|e|e.wormhole)
        .map(|e|(e.source_id,e.target_id)).collect();
    let mut flows=BTreeMap::<(i64,i64),f64>::new();
    for e in &input.query_state.river_edges {
        if e.immediate_return || !first.contains(&e.target_id) || focus.binary_search(&e.source_id).is_err() {continue;}
        let f=flows.entry((e.source_id,e.target_id)).or_default(); *f=f.max(positive(e.flow));
    }
    let mut best=0.;
    for (&(sid,tid),&f) in &flows {
        if !blocked.contains(&(sid,tid)) || f<=0. {continue;}
        let (Some(&s),Some(&t))=(a.node_index.get(&sid),a.node_index.get(&tid)) else {continue};
        let direct=a.edge_weight(sid,tid);
        if direct<=0. {continue;}
        let mut two=BTreeMap::<usize,f64>::new();
        for (u,x) in ordinary(a,s,&blocked).filter(|(u,_)|*u!=t) {
            for (j,y) in ordinary(a,u,&blocked).filter(|(j,_)|*j!=s) {
                *two.entry(j).or_default()+=x*y;
            }
        }
        let alt=two.get(&t).copied().unwrap_or(0.);
        let jump=direct/(direct+alt);
        // Dot of the endpoint-excluded two-hop source response with target's
        // outgoing ordinary neighbourhood. Neither bridge endpoint is a witness.
        let support=|i| ordinary(a,i,&blocked).filter(|(j,_)|*j!=s && *j!=t && *j!=i)
            .map(|(j,w)|w*two.get(&j).copied().unwrap_or(0.)).sum::<f64>();
        let signal=support(t);
        let feat=|i| ((row(a,i).len() as f64).ln_1p(),
            positive(a.inbound.get(&a.node_ids[i]).copied().unwrap_or(0.)).ln_1p());
        let (d,h)=feat(t); let n=a.node_ids.len();
        let count=n.min(256);
        let mut controls=Vec::new();
        for k in 0..count {
            let i=(t+k*n/count)%n;
            if i==s || i==t {continue;}
            let (di,hi)=feat(i);
            controls.push(((di-d).abs()+(hi-h).abs(),i));
        }
        controls.sort_unstable_by(|x,y|x.0.total_cmp(&y.0).then(x.1.cmp(&y.1)));
        controls.truncate(8);
        let background=controls.iter().map(|&(_,i)|support(i)).sum::<f64>()/controls.len().max(1) as f64;
        let rigidity=if controls.is_empty() || signal<=background {0.} else {(signal-background)/(signal+background)};
        let total=flows.range((sid,i64::MIN)..=(sid,i64::MAX)).map(|(_,x)|*x).sum::<f64>();
        let share=clamp01(f/total);
        let w=clamp01(jump*rigidity*share);
        out.routes.push(serde_json::json!({"sourceId":sid,"targetId":tid,"ordinaryTwoHop":alt,
            "jump":jump,"support":signal,"matchedBackground":background,"controls":controls.len(),
            "rigidity":rigidity,"firstHopShare":share,"routeOmega":w}));
        if w<=best {continue;}
        let (Some(source),Some(target))=(v.get(&sid),v.get(&tid)) else {continue;};
        let Some(pins)=focus.iter().filter(|&&i|i!=sid).map(|i|v.get(i).map(|x|x.as_ref()))
            .collect::<Option<Vec<&[f32]>>>() else {continue;};
        if let Some((vector,angle))=super::chart_rotation::rotate(&input.query.vector,source,target,&pins,w) {
            best=w;out.vector=Some(vector);out.selected=Some((sid,tid,w,angle));
        }
    }
    out
}