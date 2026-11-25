use super::*;
use std::io::{BufWriter, Write};

fn checked_file(p: &Path, sha: &str) -> Vec<u8> {
    let b = std::fs::read(p).unwrap();
    assert_eq!(format!("{:x}", Sha256::digest(&b)), sha, "{}",p.display());
    b
}
fn floats(b: Vec<u8>) -> Vec<f32> {
    assert_eq!(b.len()%4,0);
    b.chunks_exact(4).map(|v| f32::from_le_bytes(v.try_into().unwrap())).collect()
}

#[test]
#[ignore = "explicit offline experiment on pinned private dev fixture"]
fn replay_frozen_b0_dev() {
    let root = std::env::temp_dir().join("lain-p0-qo_bvspm");
    let bytes=checked_file(&root.join("path-b-inputs/knowledge_base.sqlite.chunks-warped-ef69682d1cbfd97b649211756ee1e4a3a79e2c2b5d18669ce220f17cccad8f58.vcpwc"),
        "1c2a145e212dd220f9380ef876bcff331e8412dc05472a66c7feed9cb7fa84a5");
    let h=u64::from_le_bytes(bytes[8..16].try_into().unwrap()) as usize;
    let hdr:Header=serde_json::from_slice(&bytes[16..16+h]).unwrap();
    assert_eq!(hdr.identity.rule,RULE);
    assert_eq!(hdr.identity.facts,"4676");
    assert_eq!(hdr.identity.model,"gemini-embedding-2-preview");
    let field=WarpedChunks::decode(&bytes,&hdr.identity).unwrap().unwrap();
    let idx=&field.index;
    let ids=idx.ids();
    let wire=checked_file(&root.join("plate-a/ids.u64le"),"ae84b534d08b28887cfbf40dd5a2cfb1a13192c45b5c4a4b6198f5026fc122a9");
    assert_eq!(wire.len(),6849*8);
    assert_eq!((ids.len(),idx.trained_len(),idx.retired_count()),(6849,6849,0));
    assert_eq!(field.versions.len(),6849);
    assert!(ids.iter().zip(wire.chunks_exact(8)).all(|(&id,b)|id==u64::from_le_bytes(b.try_into().unwrap())));
    let x=floats(checked_file(&root.join("plate-a/vectors.f32le"),"1332370ce7088a29b71a0f09cf60d0aa7679dcde9ba4fbbee0504e449b8fed9a"));
    let dev=floats(checked_file(&root.join("queries-a/dev.f32le"),"c6eda7714a6335a3ab4fd192c1aa979ce0b93ed0290232ed35ce85898f8acacf"));
    let d=3072;
    assert_eq!((x.len(),dev.len()),(6849*d,253*d));
    let row=|i:usize| &x[i*d..(i+1)*d];
    let dest=root.join("path-b0-dev-v1");
    assert!(!dest.exists());
    let stage=root.join(format!("b0-build-{}",std::process::id()));
    std::fs::create_dir(&stage).unwrap();
    let mut w=BufWriter::new(std::fs::File::create(stage.join("candidates.jsonl")).unwrap());
    let (vis,exp)=warped_size_budget(ids.len());
    for (slot,q) in dev.chunks_exact(d).enumerate() {
        let qr=field.radius(q).unwrap();
        let ds:Vec<_>=(0..ids.len()).map(|i|idx.exact_distance(q,qr,row(i),i).unwrap()).collect();
        assert!(ds.iter().all(|v|v.is_finite()));
        let mut order:Vec<_>=(0..ids.len()).collect();
        order.sort_unstable_by(|&i,&j|ds[i].total_cmp(&ds[j]).then(ids[i].cmp(&ids[j])));
        let exact:Vec<_>=order[..128].iter().map(|&i|(ids[i],ds[i])).collect();
        let mut nav=Vec::new();
        for k in [64usize,128] {
            let width=128.max(2*k);
            let cold=rerank_budget(k);
            let mv=vis.max(4*k);
            let me=exp.max(2*k);
            let out=idx.search_chunks(q,qr,HyperbolicSearchConfig{top_k:k,width,rerank_limit:cold,max_visits:mv,max_expansions:me,radial_bound:true},None,|_|false,|i,v|{v.extend_from_slice(row(i));true}).unwrap();
            assert_eq!(out.neighbors.len(),k);
            let mut seen=std::collections::HashSet::new();
            let mut bit_mismatches=0;
            let mut max_abs=0f64;
            for &(id,dist) in &out.neighbors {
                assert!(seen.insert(id) && dist.is_finite());
                let reference=ds[ids.binary_search(&id).unwrap()];
                bit_mismatches+=usize::from(dist.to_bits()!=reference.to_bits());
                max_abs=max_abs.max((dist-reference).abs());
            }
            let ordered_by_exact=out.neighbors.windows(2).all(|v|{
                let a=v[0].0;let b=v[1].0;
                ds[ids.binary_search(&a).unwrap()].total_cmp(&ds[ids.binary_search(&b).unwrap()]).then(a.cmp(&b)).is_le()
            });
            nav.push(serde_json::json!({"k":k,"width":width,"rerankLimit":cold,"maxVisits":mv,"maxExpansions":me,
                "visited":out.stats.visited,"expanded":out.stats.expanded,"coldReads":out.stats.cold_reads,
                "distanceBitMismatches":bit_mismatches,"maxAbsDistanceDiff":max_abs,"orderedByExact":ordered_by_exact,"hits":out.neighbors}));
        }
        writeln!(w,"{}",serde_json::json!({"slot":slot,"queryRadius":qr,"exact128":exact,"nav":nav})).unwrap();
        if (slot+1)%16==0 {w.flush().unwrap();eprintln!("B0 {}/253",slot+1);}
    }
    w.flush().unwrap();drop(w);
    std::fs::rename(stage,dest).unwrap();
}