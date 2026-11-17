//! Phase5D observed development; fresh validation remains separately gated.
use super::*;
use vcp_tdb_index::index::quiver::hyperbolic::{
    HyperbolicSearchConfig, WarpedNavigationOptions, WarpedRerankOptions,
    WarpedSearchTrace, WarpedSeedMode,
};

const ROUTES:[(&str,bool,u8);4]=[
    ("reference",false,0),("shell512",true,0),("union",true,1),("nms",true,2),
];

fn config(shell:bool,policy:u8)->Value {
    json!({"tagRoutingMode":"warped_ags","warpedPreset":"locked_2",
        "warpedRadiusStrategy":"EpaGuided","warpedLegacyBudget":false,
        "warpedShellDirectory":shell,"warpedReuseBeam":true,"warpedSeedPolicy":policy})
}

fn search(c:&Connection,field:&crate::warped_tag_field::WarpedTagField,
    q:&[f32],radius:f32,excluded:&HashSet<i64>,shell:bool,policy:u8,reuse:bool,
    trace:Option<&mut WarpedSearchTrace>)
    -> (vcp_tdb_index::index::quiver::hyperbolic::HyperbolicOutput,Vec<i64>) {
    let mut reads=Vec::new();
    let mut statement=c.prepare_cached("SELECT vector FROM tags WHERE id=?1").unwrap();
    let result=field.index.search_seed_policy(q,radius,HyperbolicSearchConfig {
        top_k:10,width:128,rerank_limit:64,max_visits:2048,max_expansions:512,radial_bound:true,
    },WarpedSeedMode::DirectionLandmarks,
    WarpedNavigationOptions {asymmetric:true,compact_seeds:true},
    WarpedRerankOptions {reuse_transform:true,envelope_bound:true},
    shell,reuse,policy,trace,|id|excluded.contains(&(id as i64)),|slot,row| {
        let id=field.ids()[slot] as i64;
        reads.push(id);
        statement.query_row([id],|r|crate::index_source::decode_column_into(r,0,3072,row)).unwrap()
    }).unwrap();
    (result,reads)
}

fn distance_bits(o:&vcp_tdb_index::index::quiver::hyperbolic::HyperbolicOutput)->Vec<(u64,u64)> {
    o.neighbors.iter().map(|&(id,d)|(id,d.to_bits())).collect()
}

#[test]
#[ignore = "explicit Phase5D full observed-file development"]
fn observed_seed_development() {
    let root=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/pelorus-experiment");
    let manifest_path=root.join("phase5-files-v1.json");
    let manifest:Value=serde_json::from_reader(std::fs::File::open(&manifest_path).unwrap()).unwrap();
    let snapshot:Value=serde_json::from_reader(std::fs::File::open(
        root.join("phase5-eval-snapshot-v2.json")).unwrap()).unwrap();
    let work=root.join("phase5-eval-v2.sqlite");
    let before=snapshot_hash(&work);
    assert_eq!(snapshot["snapshot_sha256"],before);
    assert_eq!(snapshot["partition_sha256"],snapshot_hash(&manifest_path));
    let output=std::path::PathBuf::from(std::env::var("PHASE5D_OUTPUT").unwrap());
    let mut out=private_output(&output,&root).unwrap();
    write_row(&mut out,json!({"type":"header","schema":"phase5d-seeds-v1","mode":"development",
        "snapshotSha256":before,"partitionSha256":snapshot["partition_sha256"],
        "queries":64,"repeats":3,"candidate":"nms","threshold":0.60,"inner":4,"seedCap":16,
        "routes":ROUTES.iter().map(|r|r.0).collect::<Vec<_>>(),
        "budget":{"width":128,"maxVisits":2048,"maxExpansions":512,"rerank":64}}));
    let c=Connection::open_with_flags(&work,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    c.execute_batch("PRAGMA query_only=ON; BEGIN").unwrap();
    let signature:String=c.query_row(
        "SELECT artifact_sig FROM rivermemo_artifacts WHERE status='ready' ORDER BY updated_at DESC LIMIT 1",
        [],|r|r.get(0)).unwrap();
    let runtime=MemoRuntime::new();
    let artifact=load_artifact_with_connection(&runtime,&c,&signature).unwrap();
    let model:String=c.query_row("SELECT model_sig FROM rivermemo_artifacts WHERE artifact_sig=?1",
        [&signature],|r|r.get(0)).unwrap();
    let build=crate::index_source::build_memory_from_connection(&c,None,3072,&model).unwrap();
    let index=Arc::new(crate::index_handle::IndexHandle::new(
        crate::retrieval_index::RetrievalIndex::from_sql(build)));
    let mut field=crate::warped_tag_field::WarpedTagField::build(&c,&signature,&artifact,
        3072,crate::warped_tag_field::Preset::Locked2).unwrap();
    let old_bytes=field.hot_bytes();
    let started=Instant::now();
    field.index.build_shell_landmarks();
    write_row(&mut out,json!({"type":"build","nodes":field.ids().len(),
        "connectivity":field.index.connectivity(),"referenceHotBytes":old_bytes,
        "hotBytes":field.hot_bytes(),"directoryMs":started.elapsed().as_secs_f64()*1000.0,
        "landmarks":field.index.shell_landmark_count()}));
    let field=Arc::new(field);
    runtime.publish_warped_field(runtime.warped_build_ticket(),&signature,field.clone()).unwrap();
    let mut files:HashSet<i64>=manifest["historical_files"].as_array().unwrap().iter()
        .map(|v|v.as_i64().unwrap()).collect();
    assert_eq!(files.len(),108);
    let mut completed=0;
    for group in ["development","file_holdout_v1"] {
        let entries=manifest[group].as_array().unwrap();
        assert_eq!(entries.len(),32);
        for entry in entries {
            let chunk=entry["chunk_id"].as_i64().unwrap();
            let file=entry["file_id"].as_i64().unwrap();
            assert!(files.insert(file));
            assert_eq!(c.query_row("SELECT file_id FROM chunks WHERE id=?1",[chunk],
                |r|r.get::<_,i64>(0)).unwrap(),file);
            let query=read_vector(&c,chunk);
            assert!(query.iter().all(|v|v.is_finite()) && magnitude(&query)>1e-12);
            let mut runs=HashMap::new();
            for repeat in 0..4 {
                let order:Vec<_>=if (repeat+completed)%2==0 {(0..4).collect()}
                    else {(0..4).rev().collect()};
                for route in order {
                    let (name,shell,policy)=ROUTES[route];
                    let ledger=crate::storage::tag_read_audit::Session::begin();
                    let result=run_pipeline_with_connection(&index,&runtime,&signature,3072,
                        &json!({"config":config(shell,policy)}).to_string(),&query,&[],&artifact,&c).unwrap();
                    let metadata:Value=serde_json::from_str(&result.metadata_json).unwrap();
                    let events=ledger.events();drop(ledger);
                    let handle=metadata["observationHandle"].as_str().unwrap().to_owned();
                    let observation=runtime.get_query_observation(&handle,&signature).unwrap();
                    if repeat>0 {
                        write_row(&mut out,json!({"type":"timing","group":group,"chunk":chunk,"route":name,
                            "repeat":repeat,"diagnostics":metadata["diagnostics"]}));
                    }
                    if repeat==3 {
                        let unique:HashSet<_>=events.iter().map(|v|v.1).collect();
                        assert_eq!(unique.len(),events.len());
                        write_row(&mut out,json!({"type":"pipeline","group":group,"chunk":chunk,"file":file,
                            "route":name,"config":config(shell,policy),"pyramid":metadata["pyramid"],
                            "explained":metadata["pyramid"]["totalExplainedEnergy"],
                            "enhancedBits":result.enhanced_vector.iter().map(|v|v.to_bits()).collect::<Vec<_>>(),
                            "attempts":metadata["diagnostics"]["pyramidAttempts"],
                            "routing":metadata["diagnostics"]["tagRouting"],
                            "sqlReadEvents":events,"uniqueSqlReads":unique.len()}));
                        runs.insert(route,(metadata,observation.tag_vectors.clone()));
                    }
                    runtime.release_query_observation(&handle).unwrap();
                }
            }
            for (route,(name,shell,policy)) in ROUTES.into_iter().enumerate() {
                let (metadata,pool)=&runs[&route];
                let accepted=metadata["pyramid"]["levels"].as_array().unwrap();
                let mut residual=query.clone();
                let mut excluded=HashSet::new();
                for attempt in metadata["diagnostics"]["pyramidAttempts"].as_array().unwrap() {
                    let level=attempt["level"].as_u64().unwrap() as usize;
                    let radius=attempt["radius"].as_f64().unwrap() as f32;
                    let found:Vec<_>=attempt["ids"].as_array().unwrap().iter()
                        .map(|v|v.as_i64().unwrap()).collect();
                    let mut trace=WarpedSearchTrace::default();
                    let actual=search(&c,&field,&residual,radius,&excluded,shell,policy,true,Some(&mut trace));
                    let reference=search(&c,&field,&residual,radius,&excluded,shell,policy,false,None);
                    assert_eq!(distance_bits(&actual.0),distance_bits(&reference.0));
                    assert_eq!(actual.1,reference.1);
                    assert_eq!(found,actual.0.neighbors.iter().map(|p|p.0 as i64).collect::<Vec<_>>());
                    let (truth,exact,scanned)=layer_truth(&c,&residual,dot(&query,&query),
                        Some(&field),radius,&excluded,&artifact.node_index);
                    let vectors:Vec<_>=found.iter().filter_map(|id|pool.get(id)
                        .filter(|_|artifact.node_index.contains_key(id)).map(|v|(*id,v.as_ref()))).collect();
                    let solution=crate::memo_nnls::solve(&residual,&vectors).unwrap();
                    let ann=positive(dot(&residual,&residual)-dot(&solution.residual,&solution.residual))
                        /dot(&query,&query);
                    write_row(&mut out,json!({"type":"layer","group":group,"chunk":chunk,"route":name,
                        "level":level,"radius":radius,"foundIds":found,"truthIds":truth,
                        "accepted":level<accepted.len(),"annExplained":ann,"exactExplained":exact,
                        "truthRows":scanned,"visited":actual.0.stats.visited,"expanded":actual.0.stats.expanded,
                        "converged":actual.0.stats.converged,"coldIds":actual.1,
                        "distanceBits":distance_bits(&actual.0),"referenceDistanceBits":distance_bits(&reference.0),
                        "referenceColdIds":reference.1,"seeds":trace.seeds,
                        "directionSeeds":trace.direction_seeds,"directionPairs":trace.direction_pairs,
                        "directoryCandidates":trace.directory_candidates,
                        "nmsComparisons":trace.nms_comparisons,"nmsRejections":trace.nms_rejections,
                        "nmsFills":trace.nms_fills,"visitedIds":trace.visited,"retainedIds":trace.retained,
                        "stage05Ids":trace.stage05_top64,"seedMs":trace.seed_ms,
                        "beamMs":trace.beam_ms,"stage05Ms":trace.stage05_ms,
                        "workspaceBytes":trace.workspace_bytes}));
                    if level<accepted.len() {
                        residual=solution.residual;
                        excluded.extend(found);
                    }
                }
            }
            completed+=1;
            eprintln!("Phase5D observed development {completed}/64");
        }
    }
    assert_eq!(files.len(),172);
    c.execute_batch("ROLLBACK").unwrap();drop(c);
    assert_eq!(before,snapshot_hash(&work));
    write_row(&mut out,json!({"type":"complete","queries":completed,"snapshotSha256":before}));
}