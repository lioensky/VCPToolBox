//! Private integration experiment. Explicit invocation only; no production writes.
//! Validation requires an immutable audited development lock and an exclusive start marker.
use super::*;
use serde_json::{json, Value};
use std::io::Write;

fn write_row(out: &mut std::fs::File, value: Value) {
    serde_json::to_writer(&mut *out, &value).unwrap();
    out.write_all(b"\n").unwrap();
    out.flush().unwrap();
}

fn read_vector(c: &Connection, id: i64) -> Vec<f32> {
    let mut v=Vec::new();
    assert!(c.query_row("SELECT vector FROM chunks WHERE id=?1",[id],
        |r|crate::index_source::decode_column_into(r,0,3072,&mut v)).unwrap());
    v
}

fn stable_results(raw: &str) -> Value {
    let v:Value=serde_json::from_str(raw).unwrap();
    v["results"].clone()
}
#[test]
fn default_and_unready_experiment_keep_cosine_pipeline_outputs() {
    let c=Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE tags(id INTEGER PRIMARY KEY,name TEXT,vector BLOB);
        CREATE TABLE kv_store(key TEXT,value TEXT);
        CREATE TABLE kbm_runtime_meta(key TEXT PRIMARY KEY,value TEXT);
        INSERT INTO kbm_runtime_meta VALUES ('database_generation','1');").unwrap();
    let vexus=crate::VexusIndex::new(3,16).unwrap();
    for (id,v) in [(1,[1.0_f32,0.0,0.0]),(2,[0.0,1.0,0.0])] {
        let bytes:Vec<_>=v.iter().flat_map(|x|x.to_le_bytes()).collect();
        c.execute("INSERT INTO tags VALUES (?1,?2,?3)",
            rusqlite::params![id,format!("t{id}"),bytes]).unwrap();
        vexus.index.write().unwrap().add(id as u64,&v).unwrap();
    }
    c.execute_batch("BEGIN").unwrap();
    let artifact=Arc::new(crate::rivermemo_topology_v3::NativeArtifact {
        node_ids:vec![1,2],node_index:HashMap::from([(1,0),(2,1)]),
        row_offsets:vec![0,1,2],targets:vec![1,0],weights:vec![0.2,0.2],
        ..Default::default()
    }.prepared());
    let runtime=MemoRuntime::new();
    let run=|input:&str|run_pipeline_with_connection(&vexus.index,&runtime,"synthetic",3,
        input,&[0.6,0.8,0.2],&[],&artifact,&c).unwrap();
    let default=run("{}");
    let explicit=run(r#"{"config":{"tagRoutingMode":"cosine"}}"#);
    let fallback=run(r#"{"config":{"tagRoutingMode":"warped_ags"}}"#);
    let default_meta:Value=serde_json::from_str(&default.metadata_json).unwrap();
    for output in [&explicit,&fallback] {
        assert_eq!(default.enhanced_vector,output.enhanced_vector);
        let metadata:Value=serde_json::from_str(&output.metadata_json).unwrap();
        assert_eq!(default_meta["pyramid"],metadata["pyramid"]);
        runtime.release_query_observation(metadata["observationHandle"].as_str().unwrap()).unwrap();
    }
    let fallback_meta:Value=serde_json::from_str(&fallback.metadata_json).unwrap();
    assert_eq!(fallback_meta["diagnostics"]["tagRouting"]["used"],"cosine");
    assert_eq!(fallback_meta["diagnostics"]["tagRouting"]["fallback"],true);
    assert!(default_meta["diagnostics"].get("tagRouting").is_none());
    runtime.release_query_observation(default_meta["observationHandle"].as_str().unwrap()).unwrap();
}


fn snapshot_hash(path: &std::path::Path) -> String {
    use sha2::{Digest, Sha256};
    let wal=std::path::PathBuf::from(format!("{}-wal",path.display()));
    assert!(std::fs::metadata(wal).map_or(true,|m|m.len()==0),
        "nonempty WAL requires a separately frozen snapshot");
    let mut file=std::fs::File::open(path).unwrap();
    let mut hasher=Sha256::new();
    std::io::copy(&mut file,&mut hasher).unwrap();
    format!("{:x}",hasher.finalize())
}

fn private_output(path: &std::path::Path, root: &std::path::Path) -> std::io::Result<std::fs::File> {
    if path.extension().and_then(|s|s.to_str())!=Some("jsonl")
        || path.parent().ok_or_else(||std::io::Error::other("missing parent"))?.canonicalize()?
            != root.canonicalize()? {
        return Err(std::io::Error::other("output must be a new private JSONL file"));
    }
    std::fs::OpenOptions::new().write(true).create_new(true).open(path)
}

#[test]
fn output_is_exclusive_and_rejects_database_extensions() {
    let root=std::env::temp_dir().join(format!("phase5-output-{}-{}",std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    std::fs::create_dir(&root).unwrap();
    assert!(private_output(&root.join("work.sqlite"),&root).is_err());
    let path=root.join("audit.jsonl");
    drop(private_output(&path,&root).unwrap());
    assert!(private_output(&path,&root).is_err());
    assert!(private_output(&root.join("../outside.jsonl"),&root).is_err());
    std::fs::remove_dir_all(root).unwrap();
}

fn full_library_candidates(c:&Connection, query:&[f32], source:i64) -> Vec<Value> {
    let mut statement=c.prepare("SELECT id,vector FROM chunks WHERE vector IS NOT NULL ORDER BY id").unwrap();
    let mut rows=statement.query([]).unwrap();
    let mut row=Vec::new();
    let mut best=Vec::new();
    while let Some(r)=rows.next().unwrap() {
        let id:i64=r.get(0).unwrap();
        if id==source || !crate::index_source::decode_column_into(r,1,3072,&mut row).unwrap()
            || magnitude(&row)<=1e-12 {continue;}
        best.push((id,cosine(query,&row)));
        best.sort_unstable_by(|a,b|b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        best.truncate(100);
    }
    best.into_iter().map(|(id,score)|json!({"id":id,"score":score})).collect()
}

/// Single-row scan with only ten originals retained. Runs after real measurements.
fn layer_truth(c:&Connection, residual:&[f32], original_energy:f64,
    field:Option<&crate::warped_tag_field::WarpedTagField>, radius:f32,
    excluded:&HashSet<i64>, eligible:&HashMap<i64,usize>) -> (Vec<i64>,f64,usize) {
    let mut statement=c.prepare("SELECT id,vector FROM tags WHERE vector IS NOT NULL ORDER BY id").unwrap();
    let mut rows=statement.query([]).unwrap();
    let mut row=Vec::new();
    let mut best:Vec<(i64,f64,Vec<f32>)>=Vec::new();
    let mut scanned=0;
    while let Some(r)=rows.next().unwrap() {
        let id:i64=r.get(0).unwrap();
        if excluded.contains(&id) {continue;}
        let node=if let Some(f)=field {
            match f.ids().binary_search(&(id as u64)) {Ok(n)=>Some(n),Err(_)=>continue}
        } else {None};
        if !crate::index_source::decode_column_into(r,1,3072,&mut row).unwrap()
            || magnitude(&row)<=1e-12 {continue;}
        scanned+=1;
        let distance=if let Some(f)=field {
            f.index.exact_distance(residual,radius,&row,node.unwrap()).unwrap()
        } else {-cosine(residual,&row)};
        let competitive=best.len()<10 || best.last().is_some_and(|last|
            distance.total_cmp(&last.1).then(id.cmp(&last.0)).is_lt());
        if competitive {
            best.push((id,distance,row.clone()));
            best.sort_unstable_by(|a,b|a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
            best.truncate(10);
        }
    }
    let vectors:Vec<_>=best.iter().filter(|(id,_,_)|eligible.contains_key(id))
        .map(|(id,_,v)|(*id,v.as_slice())).collect();
    let solved=crate::memo_nnls::solve(residual,&vectors).unwrap();
    let explained=positive(dot(residual,residual)-dot(&solved.residual,&solved.residual))/original_energy;
    (best.iter().map(|v|v.0).collect(),explained,scanned)
}

fn coverage_exceptions(c:&Connection,field:&crate::warped_tag_field::WarpedTagField,
    artifact:&crate::rivermemo_topology_v3::NativeArtifact) -> Value {
    let mut statement=c.prepare(
        "SELECT t.id,t.vector IS NOT NULL,r.model_sig,r.artifact_sig,r.status,s.status
         FROM tags t LEFT JOIN tag_intrinsic_residuals r ON r.tag_id=t.id
         LEFT JOIN tag_intrinsic_residual_status s ON s.tag_id=t.id
         AND s.artifact_sig=(SELECT artifact_sig FROM tagmemo_artifacts
         WHERE asset_type='unified_geometry' AND status='ready' ORDER BY updated_at DESC LIMIT 1)
         ORDER BY t.id").unwrap();
    let rows=statement.query_map([],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,bool>(1)?,
        r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?,
        r.get::<_,Option<String>>(4)?,r.get::<_,Option<String>>(5)?))).unwrap();
    let exceptions:Vec<_>=rows.map(|r|r.unwrap()).filter(|r|
        field.ids().binary_search(&(r.0 as u64)).is_err()).map(|r|json!({
            "id":r.0,"hasVector":r.1,"hasInbound":artifact.inbound.contains_key(&r.0),
            "artifactNode":artifact.node_index.contains_key(&r.0),
            "residualModel":r.2,"residualSignature":r.3,"residualStatus":r.4,"status":r.5
        })).collect();
    json!({"type":"coverage","active":field.active_tags,"indexed":field.ids().len(),"exceptions":exceptions})
}

#[test]
#[ignore = "explicit private full-library Phase 5 experiment"]
fn real_pipeline_file_disjoint() {
    let root=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/pelorus-experiment");
    let manifest:Value=serde_json::from_reader(std::fs::File::open(root.join("phase5-files-v1.json")).unwrap()).unwrap();
    let mode=std::env::var("PHASE5_MODE").unwrap_or_else(|_|"development".into());
    assert!(mode=="development" || mode=="validation", "unknown experiment mode");
    let output=std::env::var("PHASE5_OUTPUT").unwrap();
    let path=std::path::PathBuf::from(output);
    assert_eq!(path.parent().unwrap().canonicalize().unwrap(),root.canonicalize().unwrap());
    let work=root.join("phase5-eval-v2.sqlite");
    let audit:Value=serde_json::from_reader(
        std::fs::File::open(root.join("phase5-eval-snapshot-v2.json")).unwrap()).unwrap();
    assert_eq!(audit["schema"],"phase5-eval-snapshot-v2");
    let before=snapshot_hash(&work);
    assert_eq!(audit["snapshot_sha256"].as_str(),Some(before.as_str()));
    assert_eq!(audit["partition_sha256"].as_str(),
        Some(snapshot_hash(&root.join("phase5-files-v1.json")).as_str()));
    assert_eq!(manifest["source_sha256"],audit["source_files"]["main"]);
    let validation:HashSet<i64>=manifest["file_holdout_v1"].as_array().unwrap().iter()
        .map(|v|v["file_id"].as_i64().unwrap()).collect();
    assert_eq!(validation.len(),32);
    assert!(manifest["development"].as_array().unwrap().iter()
        .all(|v|!validation.contains(&v["file_id"].as_i64().unwrap())));
    let lock_path=root.join("phase5b-lock-v1.json");
    let lock=if mode=="validation" {
        let locked:Value=serde_json::from_reader(std::fs::File::open(&lock_path).unwrap()).unwrap();
        assert_eq!(locked["schema"],"phase5b-lock-v1");
        assert_eq!(locked["snapshotSha256"],audit["snapshot_sha256"]);
        assert_eq!(locked["partitionSha256"],audit["partition_sha256"]);
        let selected=locked["selectedRoutes"].as_array().unwrap();
        assert!(!selected.is_empty() && selected.len()<=2);
        let allowed=["locked_0/LayerSchedule/1536","locked_0/EpaGuided/1536",
            "locked_2/LayerSchedule/1536","locked_2/EpaGuided/1536",
            "locked_0/LayerSchedule/2048","locked_0/EpaGuided/2048",
            "locked_2/LayerSchedule/2048","locked_2/EpaGuided/2048"];
        let mut unique=HashSet::new();
        for route in selected {
            let name=route.as_str().unwrap();
            assert!(allowed.contains(&name) && unique.insert(name));
        }
        for item in locked["boundFiles"].as_array().unwrap() {
            let relative=std::path::Path::new(item["path"].as_str().unwrap());
            assert!(relative.components().all(|p|matches!(p,std::path::Component::Normal(_))));
            assert_eq!(snapshot_hash(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(relative)),
                item["sha256"].as_str().unwrap());
        }
        Some(locked)
    } else {None};
    let mut out=private_output(&path,&root).unwrap();
    if let Some(locked)=&lock {
        let marker=root.join("phase5b-validation-start-v1.json");
        let mut start=std::fs::OpenOptions::new().write(true).create_new(true).open(marker).unwrap();
        serde_json::to_writer(&mut start,&json!({"schema":"phase5b-validation-start-v1",
            "lockSha256":snapshot_hash(&lock_path),"output":path.file_name().unwrap().to_str().unwrap(),
            "selectedRoutes":locked["selectedRoutes"]})).unwrap();
        start.sync_all().unwrap();
    }
    write_row(&mut out,json!({"type":"header","schema":"phase5b-pipeline-v1",
        "mode":mode,"snapshotSha256":before,"partitionSha256":audit["partition_sha256"],
        "queries":32,"lockSha256":lock.as_ref().map(|_|snapshot_hash(&lock_path)),
        "candidateScope":"full-library exact query-cosine top100 excluding query chunk",
        "truthProtocol":"same actual residual; independent offline scan after both readouts",
        "coldReadProtocol":"submitted Tag SQL IDs, including unsuccessful attempts; no truth reads"}));
    let c=Connection::open_with_flags(&work,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    c.execute_batch("PRAGMA query_only=ON; BEGIN").unwrap();
    let artifact_sig:String=c.query_row(
        "SELECT artifact_sig FROM rivermemo_artifacts WHERE status='ready' ORDER BY updated_at DESC LIMIT 1",
        [],|r|r.get(0)).unwrap();
    let runtime=MemoRuntime::new();
    let artifact=load_artifact_with_connection(&runtime,&c,&artifact_sig).unwrap();
    let model:String=c.query_row("SELECT model_sig FROM rivermemo_artifacts WHERE artifact_sig=?1",
        [&artifact_sig],|r|r.get(0)).unwrap();
    let started=Instant::now();
    let build=crate::index_source::build_memory_from_connection(&c,None,3072,&model).unwrap();
    let cosine_index=crate::retrieval_index::RetrievalIndex::from_sql(build);
    write_row(&mut out,json!({"type":"cosine_build","buildMs":started.elapsed().as_secs_f64()*1000.0,
        "nodes":cosine_index.size(),"hotBytes":cosine_index.memory_usage()}));
    let index=Arc::new(crate::index_handle::IndexHandle::new(cosine_index));
    for preset in [crate::warped_tag_field::Preset::Locked0,crate::warped_tag_field::Preset::Locked2] {
        let field=crate::warped_tag_field::WarpedTagField::build(&c,&artifact_sig,&artifact,3072,preset).unwrap();
        write_row(&mut out,json!({"type":"warped_build","preset":format!("{preset:?}"),
            "buildMs":field.build_ms,"hotBytes":field.hot_bytes(),"kernelHotBytes":field.index.hot_bytes(),
            "nodes":field.ids().len(),"activeTags":field.active_tags,"rankedTags":field.ranked_tags,
            "connectivity":field.index.connectivity()}));
        if preset==crate::warped_tag_field::Preset::Locked0 {
            write_row(&mut out,coverage_exceptions(&c,&field,&artifact));
        }
        runtime.publish_warped_field(runtime.warped_build_ticket(),&artifact_sig,Arc::new(field)).unwrap();
    }
    let queries=manifest[if mode=="development" {"development"} else {"file_holdout_v1"}].as_array().unwrap();
    assert_eq!(queries.len(),32);
    let historical:HashSet<i64>=manifest["historical_files"].as_array().unwrap().iter()
        .map(|v|v.as_i64().unwrap()).collect();
    let mut files=HashSet::new();
    for entry in queries {
        let file=entry["file_id"].as_i64().unwrap();
        let chunk=entry["chunk_id"].as_i64().unwrap();
        assert!(files.insert(file) && !historical.contains(&file));
        let actual:i64=c.query_row("SELECT file_id FROM chunks WHERE id=?1",[chunk],|r|r.get(0)).unwrap();
        assert_eq!(file,actual);
        let query=read_vector(&c,chunk);
        assert!(query.iter().all(|v|v.is_finite()) && magnitude(&query)>1e-12);
        let candidate_started=Instant::now();
        let candidates=full_library_candidates(&c,&query,chunk);
        let candidate_ms=candidate_started.elapsed().as_secs_f64()*1000.0;
        for (route,preset,strategy,legacy) in [
            ("cosine","locked_0","LayerSchedule",false),
            ("warped_ags","locked_0","LayerSchedule",true),
            ("warped_ags","locked_0","EpaGuided",true),
            ("warped_ags","locked_2","LayerSchedule",true),
            ("warped_ags","locked_2","EpaGuided",true),
            ("warped_ags","locked_0","LayerSchedule",false),
            ("warped_ags","locked_0","EpaGuided",false),
            ("warped_ags","locked_2","LayerSchedule",false),
            ("warped_ags","locked_2","EpaGuided",false),
        ] {
            let route_key=if route=="cosine" {"cosine".into()} else {
                format!("{preset}/{strategy}/{}",if legacy {"1536"} else {"2048"})
            };
            if let Some(locked)=&lock {
                if route!="cosine" && !locked["selectedRoutes"].as_array().unwrap()
                    .iter().any(|v|v.as_str()==Some(route_key.as_str())) {continue;}
            }
            let ledger=crate::storage::tag_read_audit::Session::begin();
            let input=json!({"config":{"tagRoutingMode":route,"warpedPreset":preset,
                "warpedRadiusStrategy":strategy,"warpedLegacyBudget":legacy}});
            let result=run_pipeline_with_connection(&index,&runtime,&artifact_sig,3072,
                &input.to_string(),&query,&[],&artifact,&c).unwrap();
            let metadata:Value=serde_json::from_str(&result.metadata_json).unwrap();
            let handle=metadata["observationHandle"].as_str().unwrap();
            let observation=runtime.get_query_observation(handle,&artifact_sig).unwrap();
            let downstream=json!({"dimension":3072,"observationHandle":handle,"query":{},
                "queryState":{},"candidates":candidates,"topK":10});
            let readout_stage=crate::storage::tag_read_audit::Stage::enter("readout_first");
            let first=crate::rivermemo_topology_v3::run_native_with_connection(
                &runtime,&c,&artifact_sig,&downstream.to_string()).unwrap();
            drop(readout_stage);
            let first_events=ledger.events().len();
            let readout_stage=crate::storage::tag_read_audit::Stage::enter("readout_replay");
            let second=crate::rivermemo_topology_v3::run_native_with_connection(
                &runtime,&c,&artifact_sig,&downstream.to_string()).unwrap();
            drop(readout_stage);
            let events=ledger.events();
            let replay_reads=events.len()-first_events;
            let unique:HashSet<_>=events.iter().map(|e|e.1).collect();
            let unique_reads=unique.len();
            let duplicate_reads=events.len()-unique_reads;
            drop(ledger);
            assert_eq!(stable_results(&first),stable_results(&second));
            let downstream_value:Value=serde_json::from_str(&first).unwrap();
            write_row(&mut out,json!({"type":"pipeline","chunk":chunk,"file":file,"route":route,
                "routeKey":route_key,"legacyBudget":legacy,
                "preset":preset,"strategy":strategy,"explained":metadata["pyramid"]["totalExplainedEnergy"],
                "acceptedLevels":metadata["pyramid"]["levels"],
                "candidateMs":candidate_ms,"candidateIds":candidates.iter().map(|v|v["id"].clone()).collect::<Vec<_>>(),
                "sqlReadEvents":events,"uniqueSqlReads":unique_reads,"duplicateSqlReads":duplicate_reads,
                "replaySqlReads":replay_reads,
                "epa":{"gate":metadata["epa"]["inDomainGate"],"logic":metadata["epa"]["logicDepth"],
                    "entropy":metadata["epa"]["entropy"]},
                "diagnostics":metadata["diagnostics"],"spikeNodes":observation.observation.nodes.len(),
                "poolNodes":observation.tag_vectors.len(),"downstreamStable":true,
                "candidateScope":"full-library exact query-cosine top100 excluding query chunk; no relevance labels",
                "downstreamDiagnostics":downstream_value["diagnostics"]}));
            // Evaluation happens AFTER the timed real pipeline and readout. It owns
            // separate single-row scratch and never populates the request vector pool.
            let key=if preset=="locked_0" {crate::warped_tag_field::Preset::Locked0}
                else {crate::warped_tag_field::Preset::Locked2};
            let field=runtime.warped_fields.read().unwrap().get(&key).cloned().unwrap();
            let mut residual=query.clone();
            let mut excluded=HashSet::new();
            let accepted=metadata["pyramid"]["levels"].as_array().unwrap();
            for attempt in metadata["diagnostics"]["pyramidAttempts"].as_array().unwrap() {
                let level=attempt["level"].as_u64().unwrap() as usize;
                let radius=attempt["radius"].as_f64().unwrap_or(0.0) as f32;
                let found:Vec<i64>=attempt["ids"].as_array().unwrap().iter()
                    .map(|id|id.as_i64().unwrap()).collect();
                let (truth,exact_explained,scanned)=layer_truth(&c,&residual,dot(&query,&query),
                    (route=="warped_ags").then_some(field.as_ref()),radius,&excluded,&artifact.node_index);
                let hits=truth.iter().filter(|id|found.contains(id)).count();
                let vectors:Vec<(i64,&[f32])>=found.iter().filter_map(|id|
                    observation.tag_vectors.get(id).filter(|_|artifact.node_index.contains_key(id))
                        .map(|v|(*id,v.as_ref()))).collect();
                let solution=crate::memo_nnls::solve(&residual,&vectors).unwrap();
                let ann_explained=positive(dot(&residual,&residual)-dot(&solution.residual,&solution.residual))
                    /dot(&query,&query);
                write_row(&mut out,json!({"type":"layer_truth","chunk":chunk,"routeKey":route_key,
                    "preset":preset,"strategy":strategy,"legacyBudget":legacy,"level":level,
                    "recall":hits as f64/truth.len().max(1) as f64,"foundIds":found,"truthIds":truth,
                    "exactExplained":exact_explained,"annExplained":ann_explained,
                    "meanInboundQuantile":attempt["meanInboundQuantile"],
                    "accepted":level<accepted.len(),"truthRows":scanned}));
                if level<accepted.len() {
                    residual=solution.residual;
                    if route=="warped_ags" { excluded.extend(found); }
                }
            }
            assert!(runtime.release_query_observation(handle).unwrap());
        }
        eprintln!("Phase5 {mode} file complete {}/{}",files.len(),queries.len());
    }
    c.execute_batch("ROLLBACK").unwrap();
    drop(c);
    assert_eq!(before,snapshot_hash(&work));
    write_row(&mut out,json!({"type":"complete","queries":queries.len(),"snapshotSha256":before}));
}
