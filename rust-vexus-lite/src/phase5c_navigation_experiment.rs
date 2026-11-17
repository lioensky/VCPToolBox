//! Phase 5C diagnostic replay, NOT fresh validation.
use super::*;
use vcp_tdb_index::index::quiver::hyperbolic::{
    HyperbolicSearchConfig, WarpedNavigationOptions, WarpedRerankOptions,
    WarpedSearchTrace, WarpedSeedMode,
};

const ROUTES: [(&str,bool,bool);4]=[
    ("reference",false,false),("directory512",true,false),
    ("reuse",false,true),("combined",true,true),
];

fn input(shell:bool,reuse:bool)->String {
    json!({"config":{"tagRoutingMode":"warped_ags","warpedPreset":"locked_2",
        "warpedRadiusStrategy":"EpaGuided","warpedLegacyBudget":false,
        "warpedShellDirectory":shell,"warpedReuseBeam":reuse}}).to_string()
}

fn kernel(c:&Connection,field:&crate::warped_tag_field::WarpedTagField,
    residual:&[f32],radius:f32,excluded:&HashSet<i64>,shell:bool,reuse:bool,
    trace:Option<&mut WarpedSearchTrace>)
    -> (vcp_tdb_index::index::quiver::hyperbolic::HyperbolicOutput,Vec<i64>) {
    let mut reads=Vec::new();
    let mut statement=c.prepare_cached("SELECT vector FROM tags WHERE id=?1").unwrap();
    let out=field.index.search_experiment(residual,radius,HyperbolicSearchConfig {
        top_k:10,width:128,rerank_limit:64,max_visits:2048,max_expansions:512,radial_bound:true,
    },WarpedSeedMode::DirectionLandmarks,
    WarpedNavigationOptions {asymmetric:true,compact_seeds:true},
    WarpedRerankOptions {reuse_transform:true,envelope_bound:true},shell,reuse,trace,
    |id|excluded.contains(&(id as i64)),|slot,row| {
        let id=field.ids()[slot] as i64;
        reads.push(id);
        statement.query_row([id],|r|
            crate::index_source::decode_column_into(r,0,3072,row)).unwrap()
    }).unwrap();
    (out,reads)
}

fn bits(out:&vcp_tdb_index::index::quiver::hyperbolic::HyperbolicOutput)->Vec<(u64,u64)> {
    out.neighbors.iter().map(|&(id,d)|(id,d.to_bits())).collect()
}

#[test]
#[ignore = "explicit Phase5C observed-file diagnostic; no fresh validation"]
fn observed_file_navigation_ablation() {
    let root=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/pelorus-experiment");
    let manifest_path=root.join("phase5-files-v1.json");
    let manifest:Value=serde_json::from_reader(std::fs::File::open(&manifest_path).unwrap()).unwrap();
    let snapshot:Value=serde_json::from_reader(std::fs::File::open(
        root.join("phase5-eval-snapshot-v2.json")).unwrap()).unwrap();
    let work=root.join("phase5-eval-v2.sqlite");
    let before=snapshot_hash(&work);
    assert_eq!(snapshot["snapshot_sha256"],before);
    assert_eq!(snapshot["partition_sha256"],snapshot_hash(&manifest_path));
    let path=std::path::PathBuf::from(std::env::var("PHASE5C_OUTPUT").unwrap());
    let mut out=private_output(&path,&root).unwrap();
    write_row(&mut out,json!({"type":"header","schema":"phase5c-navigation-v1",
        "mode":"observed_diagnostic","queries":64,"snapshotSha256":before,
        "partitionSha256":snapshot["partition_sha256"],"repeats":3,
        "routes":ROUTES.iter().map(|r|r.0).collect::<Vec<_>>(),
        "protocol":"same graph; fixed geometry; alternating route order; no fresh holdout",
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
    let directory_ms=started.elapsed().as_secs_f64()*1000.0;
    assert_eq!(field.index.shell_landmark_count(),512);
    write_row(&mut out,json!({"type":"build","nodes":field.ids().len(),
        "connectivity":field.index.connectivity(),"referenceHotBytes":old_bytes,
        "hotBytes":field.hot_bytes(),"directoryMs":directory_ms,
        "extraDirectoryBytes":field.hot_bytes()-old_bytes,
        "landmarks":field.index.shell_landmark_count()}));
    let field=Arc::new(field);
    runtime.publish_warped_field(runtime.warped_build_ticket(),&signature,field.clone()).unwrap();
    let historical:HashSet<_>=manifest["historical_files"].as_array().unwrap().iter()
        .map(|v|v.as_i64().unwrap()).collect();
    let mut files=HashSet::new();
    let mut completed=0;
    for group in ["development","file_holdout_v1"] {
        let entries=manifest[group].as_array().unwrap();
        assert_eq!(entries.len(),32);
        for entry in entries {
            let chunk=entry["chunk_id"].as_i64().unwrap();
            let file=entry["file_id"].as_i64().unwrap();
            assert!(files.insert(file) && !historical.contains(&file));
            assert_eq!(c.query_row("SELECT file_id FROM chunks WHERE id=?1",[chunk],
                |r|r.get::<_,i64>(0)).unwrap(),file);
            let query=read_vector(&c,chunk);
            assert!(query.iter().all(|v|v.is_finite()) && magnitude(&query)>1e-12);
            // Warmup then three measured runs, alternating order. Each run owns
            // a fresh observation/pool; the same immutable field is shared.
            let mut final_runs=HashMap::new();
            for repeat in 0..4 {
                let order:Vec<_>=if (repeat+completed)%2==0 {(0..4).collect()}
                    else {(0..4).rev().collect()};
                for route in order {
                    let (name,shell,reuse)=ROUTES[route];
                    let ledger=crate::storage::tag_read_audit::Session::begin();
                    let result=run_pipeline_with_connection(&index,&runtime,&signature,3072,
                        &input(shell,reuse),&query,&[],&artifact,&c).unwrap();
                    let metadata:Value=serde_json::from_str(&result.metadata_json).unwrap();
                    let events=ledger.events();
                    drop(ledger);
                    let handle=metadata["observationHandle"].as_str().unwrap().to_owned();
                    let observation=runtime.get_query_observation(&handle,&signature).unwrap();
                    if repeat>0 {
                        write_row(&mut out,json!({"type":"pipeline_timing","group":group,"chunk":chunk,
                            "route":name,"repeat":repeat,"totalMs":metadata["diagnostics"]["totalMs"],
                            "pyramidMs":metadata["diagnostics"]["pyramidMs"],
                            "checkMs":metadata["diagnostics"]["tagRoutingCheckMs"]}));
                    }
                    if repeat==3 {
                        let unique:HashSet<_>=events.iter().map(|e|e.1).collect();
                        assert_eq!(unique.len(),events.len(),"duplicate Tag SQL submission");
                        write_row(&mut out,json!({"type":"pipeline","group":group,"chunk":chunk,
                            "file":file,"route":name,"explained":metadata["pyramid"]["totalExplainedEnergy"],
                            "pyramid":metadata["pyramid"],"enhancedBits":result.enhanced_vector.iter()
                                .map(|v|v.to_bits()).collect::<Vec<_>>(),
                            "attempts":metadata["diagnostics"]["pyramidAttempts"],
                            "routing":metadata["diagnostics"]["tagRouting"],
                            "uniqueSqlReads":unique.len(),"sqlReadEvents":events}));
                        final_runs.insert(route,(metadata,observation.tag_vectors.clone()));
                    }
                    assert!(runtime.release_query_observation(&handle).unwrap());
                }
            }
            // Reuse is an implementation-only change: prove exact actual pipeline
            // equality before sharing a directory's offline quality evaluation.
            for (reference,fast) in [(0,2),(1,3)] {
                let a=&final_runs[&reference].0;
                let b=&final_runs[&fast].0;
                assert_eq!(a["pyramid"],b["pyramid"]);
                assert_eq!(a["diagnostics"]["pyramidAttempts"],b["diagnostics"]["pyramidAttempts"]
                    .as_array().map(|v|Value::Array(v.iter().map(|r|{
                        let mut r=r.clone();
                        // Only counter differs: no repeated Stage-0.5 evaluations.
                        r["stage05Evaluations"]=a["diagnostics"]["pyramidAttempts"]
                            [r["level"].as_u64().unwrap() as usize]["stage05Evaluations"].clone();
                        r
                    }).collect())).unwrap());
                let (shell,reference_name,fast_name)=if reference==0 {
                    (false,"reference","reuse")} else {(true,"directory512","combined")};
                let (metadata,pool)=&final_runs[&reference];
                let accepted=metadata["pyramid"]["levels"].as_array().unwrap();
                let mut residual=query.clone();
                let mut excluded=HashSet::new();
                for attempt in metadata["diagnostics"]["pyramidAttempts"].as_array().unwrap() {
                    let level=attempt["level"].as_u64().unwrap() as usize;
                    let radius=attempt["radius"].as_f64().unwrap() as f32;
                    let found:Vec<_>=attempt["ids"].as_array().unwrap().iter()
                        .map(|v|v.as_i64().unwrap()).collect();
                    let mut traces=[WarpedSearchTrace::default(),WarpedSearchTrace::default()];
                    let old=kernel(&c,&field,&residual,radius,&excluded,shell,false,Some(&mut traces[0]));
                    let fast=kernel(&c,&field,&residual,radius,&excluded,shell,true,Some(&mut traces[1]));
                    assert_eq!(bits(&old.0),bits(&fast.0));
                    assert_eq!(old.1,fast.1);
                    assert_eq!(found,old.0.neighbors.iter().map(|p|p.0 as i64).collect::<Vec<_>>());
                    assert_eq!(traces[0].seeds,traces[1].seeds);
                    assert_eq!(traces[0].visited,traces[1].visited);
                    assert_eq!(traces[0].retained,traces[1].retained);
                    assert_eq!(traces[0].stage05_top64,traces[1].stage05_top64);
                    assert_eq!(format!("{:?}",old.0.stats).replace(
                        &format!("asymmetric_evals: {}",old.0.stats.asymmetric_evals),"asymmetric_evals: 0"),
                        format!("{:?}",fast.0.stats));
                    let (truth,exact,scanned)=layer_truth(&c,&residual,dot(&query,&query),
                        Some(&field),radius,&excluded,&artifact.node_index);
                    let vectors:Vec<_>=found.iter().filter_map(|id|pool.get(id)
                        .filter(|_|artifact.node_index.contains_key(id)).map(|v|(*id,v.as_ref()))).collect();
                    let solution=crate::memo_nnls::solve(&residual,&vectors).unwrap();
                    let ann=positive(dot(&residual,&residual)-dot(&solution.residual,&solution.residual))
                        /dot(&query,&query);
                    for (i,name) in [reference_name,fast_name].into_iter().enumerate() {
                        let trace=&traces[i];
                        write_row(&mut out,json!({"type":"layer","group":group,"chunk":chunk,
                            "route":name,"level":level,"radius":radius,"foundIds":found,"truthIds":truth,
                            "accepted":level<accepted.len(),"annExplained":ann,"exactExplained":exact,
                            "truthRows":scanned,"visited":old.0.stats.visited,"expanded":old.0.stats.expanded,
                            "converged":old.0.stats.converged,"coldIds":old.1,
                            "distanceBits":bits(&old.0),"seeds":trace.seeds,"visitedIds":trace.visited,
                            "retainedIds":trace.retained,"stage05Ids":trace.stage05_top64,
                            "seedEvaluations":trace.seed_evaluations,
                            "navigationEvaluations":trace.navigation_evaluations,
                            "stage05Evaluations":trace.stage05_evaluations,
                            "workspaceBytes":trace.workspace_bytes,
                            "seedMs":trace.seed_ms,"beamMs":trace.beam_ms,"stage05Ms":trace.stage05_ms}));
                    }
                    // Independent search timing excludes traces, truth and NNLS.
                    // Cold callback does real SQL on every call, no request pool.
                    for repeat in 0..6 {
                        let order=if repeat%2==0 {[false,true]} else {[true,false]};
                        for reuse in order {
                            let start=Instant::now();
                            let measured=kernel(&c,&field,&residual,radius,&excluded,shell,reuse,None);
                            let ms=start.elapsed().as_secs_f64()*1000.0;
                            assert_eq!(bits(&measured.0),bits(&old.0));
                            assert_eq!(measured.1,old.1);
                            if repeat>0 {
                                write_row(&mut out,json!({"type":"search_timing","group":group,"chunk":chunk,
                                    "route":if reuse {fast_name} else {reference_name},
                                    "level":level,"repeat":repeat,"ms":ms}));
                            }
                        }
                    }
                    if level<accepted.len() {
                        residual=solution.residual;
                        excluded.extend(found);
                    }
                }
            }
            completed+=1;
            eprintln!("Phase5C observed diagnostic complete {completed}/64");
        }
    }
    c.execute_batch("ROLLBACK").unwrap();
    drop(c);
    assert_eq!(before,snapshot_hash(&work));
    write_row(&mut out,json!({"type":"complete","queries":completed,"snapshotSha256":before}));
}