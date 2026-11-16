use super::*;
fn vector(node: usize, dim: usize) -> Vec<f32> {
    (0..dim).map(|j| (((node * 79 + j * 17 + 1) as f64 * 0.173).sin()
        + if j % 3 == 0 {0.7} else {0.0}) as f32).collect()
}
#[test]
fn semantic_streaming_mean_exact_gate_unique_budget_and_threads() {
    for dim in [65, 384, 768, 1536, 3072] {
        let n = 48;
        let ids: Vec<_> = (1..=n as u64).collect();
        let slots: Vec<_> = (0..n).collect();
        let depths: Vec<_> = (0..n).map(|i|0.35+1.45*i as f32/n as f32).collect();
        let mut reads=0;
        let index=HyperbolicIndex::build(dim,&ids,&slots,&depths,
            HyperbolicConfig {degree:12,construction_width:64,..Default::default()},|s,o| {
                reads+=1; *o=vector(s,dim); true
            }).unwrap();
        assert_eq!(reads,n);
        let mut mean=vec![0.0;dim];
        for s in 0..n {
            let v=vector(s,dim);
            let norm=v.iter().map(|&x|(x as f64).powi(2)).sum::<f64>().sqrt();
            for (m,x) in mean.iter_mut().zip(v) {*m+=x as f64/norm/n as f64;}
        }
        for (&a,&b) in mean.iter().zip(index.mean_direction()) {assert!((a-b).abs()<1e-14);}
        let query=vector(35,dim);
        let controls=HyperbolicSearchConfig {top_k:10,width:n,rerank_limit:64,
            max_visits:n,max_expansions:n,radial_bound:false};
        let evaluate=|background| {
            let cfg=SemanticConeConfig {background,..Default::default()};
            let mut cold=std::collections::HashSet::new();
            let found=index.search_with_semantic(&query,1.2,controls,Some(cfg),|id|id<=16,|s,o| {
                assert!(s>=16); assert!(cold.insert(s)); *o=vector(s,dim); true
            }).unwrap();
            assert_eq!(cold.len(),found.stats.cold_reads);
            assert!(cold.len()<=64);
            let cone=index.semantic_cone(&query,cfg).unwrap();
            let qn=query.iter().map(|&v|(v as f64).powi(2)).sum::<f64>().sqrt();
            let mut truth=Vec::new();
            for s in 16..n {
                let v=vector(s,dim);
                let vn=v.iter().map(|&x|(x as f64).powi(2)).sum::<f64>().sqrt();
                let c=query.iter().zip(&v).map(|(&a,&b)|a as f64*b as f64).sum::<f64>()/qn/vn;
                if !cone.admits(c) {continue;}
                let (qd,vd)=(1.2_f32 as f64,depths[s] as f64);
                let (rq,rv)=((qd/2.0).tanh(),(vd/2.0).tanh());
                let p=((rq-rv).powi(2)+2.0*rq*rv*(1.0-cone.effective(c)))
                    *(qd/2.0).cosh().powi(2)*(vd/2.0).cosh().powi(2);
                truth.push((ids[s],2.0*p.sqrt().asinh()));
            }
            truth.sort_by(|a,b|a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
            truth.truncate(10);
            assert_eq!(found.neighbors,truth);
            found.neighbors
        };
        let mean_result=evaluate(SemanticBackground::Mean);
        let landmark_result=evaluate(SemanticBackground::LandmarkMedian);
        std::thread::scope(|scope| {
            let a=scope.spawn(||evaluate(SemanticBackground::Mean));
            let b=scope.spawn(||evaluate(SemanticBackground::LandmarkMedian));
            assert_eq!(a.join().unwrap(),mean_result);
            assert_eq!(b.join().unwrap(),landmark_result);
        });
        let cfg=SemanticConeConfig::default();
        assert!(index.search_with_semantic(&query,1.2,
            HyperbolicSearchConfig {rerank_limit:65,..controls},Some(cfg),|_|false,
            |_,_|panic!("invalid budget must fail before cold I/O")).is_err());
        assert!(index.search_with_semantic(&query,1.2,controls,
            Some(SemanticConeConfig {noise_z:f64::NAN,..cfg}),|_|false,
            |_,_|panic!("invalid cone must fail before cold I/O")).is_err());
        let bounded=index.search_with_semantic(&query,1.2,
            HyperbolicSearchConfig {radial_bound:true,..controls},Some(cfg),|id|id<=16,
            |s,o| {*o=vector(s,dim);true}).unwrap();
        assert_eq!(bounded.neighbors,mean_result);
        let none=index.search_with_semantic(&query,1.2,controls,Some(cfg),|_|true,
            |_,_|panic!("excluded cold read")).unwrap();
        assert_eq!(none.stats.cold_reads,0);
        let capped=index.search_with_semantic(&query,1.2,
            HyperbolicSearchConfig {top_k:1,rerank_limit:3,..controls},Some(cfg),|_|false,
            |s,o| {*o=vector(s,dim); true}).unwrap();
        assert!(capped.stats.cold_reads<=3);
        let opposite:Vec<_>=index.mean_direction().iter().map(|m|-*m as f32).collect();
        let rejected=index.search_with_semantic(&opposite,1.2,controls,Some(cfg),|_|false,
            |s,o| {*o=vector(s,dim); true}).unwrap();
        assert!(rejected.neighbors.is_empty());
        assert_eq!(rejected.stats.cold_reads,n);
        assert_eq!(rejected.stats.direction_rejections,n);
    }
}