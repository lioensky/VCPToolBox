use super::*;
use crate::rivermemo_topology_v3::{NativeArtifact,run_native_with_connection};
use sha2::{Digest,Sha256};
use std::{fs,path::Path};

fn json_file(p:&Path)->serde_json::Value {
    serde_json::from_slice(&fs::read(p).unwrap()).unwrap()
}
fn words(dir:&Path,m:&serde_json::Value,name:&str)->Vec<u64> {
    let b=fs::read(dir.join(name)).unwrap();
    assert_eq!(format!("{:x}",Sha256::digest(&b)),m["files"][name]["sha256"].as_str().unwrap());
    assert_eq!(b.len()%8,0);
    b.chunks_exact(8).map(|x|u64::from_le_bytes(x.try_into().unwrap())).collect()
}

#[test]
#[ignore = "requires the private gen1051 experiment fixture and scratch copy"]
fn frozen_transport_four_arms() {
    let spec=json_file(Path::new(&std::env::var("V6_SPEC").unwrap()));
    let run=Path::new(spec["run"].as_str().unwrap()).canonicalize().unwrap();
    assert!(run.file_name().unwrap().to_string_lossy().starts_with("native-baseline-"));
    let db=run.join("knowledge_base.sqlite");
    let dir=Path::new(spec["bundle"].as_str().unwrap());
    let m=json_file(&dir.join("manifest.json"));
    let sig=m["sourceArtifact"].as_str().unwrap();
    assert_eq!(sig,"51fc6a77ed9d4d6bca63c8c96c7c412a3f13f16919aa1fe3");
    let c=Connection::open_with_flags(db,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    c.execute_batch("PRAGMA query_only=ON; BEGIN").unwrap();
    assert_eq!(crate::storage::read_generation(&c).unwrap(),1051);
    let v=crate::VexusIndex::new(3072,65536).unwrap();
    {
        let mut ix=v.index.write().unwrap();
        let mut st=c.prepare("SELECT id,vector FROM tags WHERE vector IS NOT NULL ORDER BY id").unwrap();
        let mut rs=st.query([]).unwrap();
        while let Some(r)=rs.next().unwrap() {
            let id:i64=r.get(0).unwrap();let bytes:Vec<u8>=r.get(1).unwrap();
            assert_eq!(bytes.len(),3072*4);
            let vec:Vec<f32>=bytes.chunks_exact(4).map(|x|f32::from_le_bytes(x.try_into().unwrap())).collect();
            ix.add(id as u64,&vec).unwrap();
        }
    }
    let q:Vec<f32>=serde_json::from_value(json_file(Path::new(spec["vector"].as_str().unwrap()))["embedding"].clone()).unwrap();
    let qb:Vec<u8>=q.iter().flat_map(|x|x.to_le_bytes()).collect();
    assert_eq!(format!("{:x}",Sha256::digest(&qb)),"c1c1ef1f4ca83f0dd2fadf138f6ba343656f14a314ba4c7b98acd59a4767fe4f");
    let ids:Vec<i64>=words(dir,&m,"ids.i64").into_iter().map(|x|x as i64).collect();
    let off:Vec<usize>=words(dir,&m,"offsets.u64").into_iter().map(|x|x as usize).collect();
    let targets:Vec<usize>=words(dir,&m,"target-indices.u64").into_iter().map(|x|x as usize).collect();
    let mut report=serde_json::json!({});
    for arm in ["current","noReserve","noGain","ordinary"] {
        eprintln!("[four-arms] {arm}: loading historical geometry");
        let runtime=MemoRuntime::new();
        let original=load_artifact_with_connection(&runtime,&c,sig).unwrap();
        let (_field,field_source)=crate::warped_tag_field::load_or_build(&runtime,&c,sig,&original,3072,crate::warped_tag_field::Preset::Locked2).unwrap();
        assert_eq!(field_source,"snapshot","must restore historical routing geometry");
        assert_eq!(ids,original.node_ids);assert_eq!(off,original.row_offsets);assert_eq!(targets,original.targets);
        let weights:Vec<f64>=words(dir,&m,&format!("{arm}.weights.f64")).into_iter().map(f64::from_bits).collect();
        assert_eq!(weights.len(),targets.len()); assert!(weights.iter().all(|w|w.is_finite()&&*w>0.));
        let mut inbound=std::collections::HashMap::new();
        for (&t,&w) in targets.iter().zip(&weights){*inbound.entry(ids[t]).or_insert(0.0_f64)+=w;}
        let max_inbound=inbound.values().copied().fold(0.,f64::max);
        let a=Arc::new(NativeArtifact{node_ids:ids.clone(),node_index:original.node_index.clone(),row_offsets:off.clone(),
            targets:targets.clone(),weights,inbound,max_inbound,anchor_gain:original.anchor_gain.clone(),
            wormhole_edges:original.wormhole_edges.clone(),provenance:original.provenance.clone(),..Default::default()}.prepared());
        for (name,route) in [("tdb","cosine"),("warped","warped_ags")] {
            eprintln!("[four-arms] {arm}/{name}: pipeline start");
            let mut cfg=spec["cfg"].clone();
            cfg["tagRoutingMode"]=route.into();cfg["baseTagBoost"]=0.6.into();
            let req=serde_json::json!({"queryText":"华为汽车的幽默操作","config":cfg,"coreTags":[],"ghostTags":[]});
            let p=run_pipeline_with_connection(&v.index,&runtime,sig,3072,&req.to_string(),&q,&[],&a,&c).unwrap();
            let meta:serde_json::Value=serde_json::from_str(&p.metadata_json).unwrap();
            let handle=meta["observationHandle"].as_str().unwrap();
            let candidates:Vec<_>=spec["pools"][name].as_array().unwrap().iter().map(|id|serde_json::json!({"id":id})).collect();
            let input=serde_json::json!({"dimension":3072,"topK":30,"includeTrace":true,"observationHandle":handle,
                "query":{"text":"华为汽车的幽默操作","vector":[]},"queryState":{"queryId":null},
                "candidates":candidates,"config":spec["configs"][name]});
            let out:serde_json::Value=serde_json::from_str(&run_native_with_connection(&runtime,&c,sig,&input.to_string()).unwrap()).unwrap();
            let rows:Vec<_>=out["results"].as_array().unwrap().iter().map(|r|serde_json::json!({
                "id":r.get("chunkId").or_else(||r.get("id")).unwrap(),
                "score":r.get("finalScore").or_else(||r.get("score")).unwrap()})).collect();
            assert_eq!(rows.len(),30);
            if arm=="current" {
                for (r,expected) in rows.iter().zip(spec["reference"][name].as_array().unwrap()){
                    assert_eq!(r["id"],expected["id"],"{name} baseline order");
                    assert!((r["score"].as_f64().unwrap()-expected["score"].as_f64().unwrap()).abs()<=0.00005001,"{name} baseline score");
                }
            }
            report[arm][name]=serde_json::json!({"rows":rows,"sensing":meta["diagnostics"]["sensing"],"diagnostics":out["diagnostics"]});
            runtime.release_query_observation(handle).unwrap();
            eprintln!("[four-arms] {arm}/{name}: 30 rows complete");
        }
    }
    let out=run.join(spec["outputName"].as_str().unwrap());
    let mut f=fs::OpenOptions::new().create_new(true).write(true).open(&out).unwrap();
    serde_json::to_writer(&mut f,&report).unwrap();println!("four-arm report: {}",out.display());
}
#[test]
#[ignore = "requires private gen1051 scratch and frozen per-query pools"]
fn explicit_first_hop_pair() {
    use serde_json::{json, Value};
    let base = std::path::PathBuf::from(std::env::var("LOCALAPPDATA").unwrap())
        .join("VCP-Experiments/RiverMemoV6");
    let run = base.join("native-baseline-111e6fce649b455795eba9097af84276");
    let spec = json_file(&run.join("construction-spec-0c8270238d1b49caa88918c509cecdd7.json"));
    let sig = "51fc6a77ed9d4d6bca63c8c96c7c412a3f13f16919aa1fe3";
    let out = base.join(format!("first-hop-pair-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    fs::create_dir(&out).unwrap();
    println!("first-hop output: {}",out.display());
    let c = Connection::open_with_flags(run.join("knowledge_base.sqlite"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    c.execute_batch("PRAGMA query_only=ON; BEGIN").unwrap();
    assert_eq!(crate::storage::read_generation(&c).unwrap(),1051);
    
    let rt = MemoRuntime::new();
    let a = load_artifact_with_connection(&rt,&c,sig).unwrap();
    let (_field,source) = crate::warped_tag_field::load_or_build(&rt,&c,sig,&a,3072,crate::warped_tag_field::Preset::Locked2).unwrap();
    assert_eq!(source,"snapshot");
    for (key,hash) in [
        ("auto","c1c1ef1f4ca83f0dd2fadf138f6ba343656f14a314ba4c7b98acd59a4767fe4f"),
        ("phone","2a8a67325540bbe20422268f6b6e1a1638bb954546c5ab29f0c978565722d9a0"),
        ("general","de6440ea4c38ac92b66165d48ffdfd6f751b812fe4475eb264b9cbe2632786b5")] {
        let frozen = json_file(&base.join(format!("context-pools-oRifL4/{key}.json")));
        let q:Vec<f32> = serde_json::from_value(json_file(&base.join(format!("gen1051-gemini2-q3-v1/{key}.json")))["embedding"].clone()).unwrap();
        assert_eq!(format!("{:x}",Sha256::digest(q.iter().flat_map(|x|x.to_le_bytes()).collect::<Vec<_>>())),hash);
        for (arm,qid) in [("current",Value::Null),("relaxed",json!("v6-probe:explicit-first-hop"))] {
            let v = crate::VexusIndex::new(3072,65536).unwrap();
let mut doc = json!({"sig":sig,"text":frozen["text"],"pools":frozen["pools"],"tracks":{}});
            for (track,route) in [("tdb","cosine"),("warped","warped_ags")] {
                eprintln!("[first-hop] {key}/{arm}/{track}");
                if track=="tdb" {
                    let mut ix=v.index.write().unwrap();
                    let mut st=c.prepare("SELECT id,vector FROM tags WHERE vector IS NOT NULL ORDER BY id").unwrap();
                    let mut rs=st.query([]).unwrap();
                    while let Some(r)=rs.next().unwrap() {
                        let id:i64=r.get(0).unwrap(); let b:Vec<u8>=r.get(1).unwrap();
                        let vec:Vec<f32>=b.chunks_exact(4).map(|x|f32::from_le_bytes(x.try_into().unwrap())).collect();
                        assert_eq!(vec.len(),3072);
                        ix.add(id as u64,&vec).unwrap();
                    }
                }
                let mut cfg=spec["cfg"].clone();
                cfg["tagRoutingMode"]=route.into();cfg["baseTagBoost"]=0.6.into();
                let req=json!({"queryText":frozen["text"],"queryId":qid,"config":cfg,"coreTags":[],"ghostTags":[]});
                let p=run_pipeline_with_connection(&v.index,&rt,sig,3072,&req.to_string(),&q,&[],&a,&c).unwrap();
                let meta:Value=serde_json::from_str(&p.metadata_json).unwrap();
                let h=meta["observationHandle"].as_str().unwrap();
                let cached=rt.get_query_observation(h,sig).unwrap();
                let obs=&cached.observation;
                let pool=frozen["pools"][track].as_array().unwrap();
                let req=json!({"dimension":3072,"topK":30,"includeTrace":true,"observationHandle":h,
                    "query":{"text":frozen["text"],"vector":[]},"queryState":{"queryId":qid},
                    "candidates":pool.iter().map(|id|json!({"id":id})).collect::<Vec<_>>(),"config":spec["configs"][track]});
                let mut result:Value=serde_json::from_str(&run_native_with_connection(&rt,&c,sig,&req.to_string()).unwrap()).unwrap();
                let rows=result["results"].as_array().unwrap();
                assert_eq!(rows.len(),30);
                if arm=="current" {
                    for (x,y) in rows.iter().zip(frozen["tracks"][track]["results"].as_array().unwrap()) {
                        assert_eq!(x["chunkId"],y["chunkId"]);
                        assert!((x["score"].as_f64().unwrap()-y["score"].as_f64().unwrap()).abs()<1e-7);
                    }
                }
                result["queryRiverGraph"]=json!({"nodes":obs.nodes,"edges":obs.edges,"totalNodes":obs.nodes.len(),
                    "totalEdges":obs.edges.len(),"truncated":false,"diagnostics":obs.diagnostics});
                doc["tracks"][track]=result;
                rt.release_query_observation(h).unwrap();
            }
            let dir=out.join(arm); fs::create_dir_all(&dir).unwrap();
            serde_json::to_writer(fs::OpenOptions::new().write(true).create_new(true)
                .open(dir.join(format!("{key}.json"))).unwrap(),&doc).unwrap();
        }
    }
}