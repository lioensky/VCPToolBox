//! Private integration experiment. Explicit invocation only; no production writes.
//! Development harness only. Validation is gated until a reviewed configuration lock exists.
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

#[test]
#[ignore = "explicit private full-library Phase 5 experiment"]
fn real_pipeline_file_disjoint() {
    let root=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/pelorus-experiment");
    let manifest:Value=serde_json::from_reader(std::fs::File::open(root.join("phase5-files-v1.json")).unwrap()).unwrap();
    let mode=std::env::var("PHASE5_MODE").unwrap_or_else(|_|"development".into());
    assert_eq!(mode, "development", "validation requires a reviewed development lock");
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
    let mut out=private_output(&path,&root).unwrap();
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
            "nodes":field.ids.len(),"activeTags":field.active_tags,"rankedTags":field.ranked_tags,
            "connectivity":field.index.connectivity()}));
        runtime.warped_fields.write().unwrap().insert(preset,Arc::new(field));
    }
    let queries=manifest["development"].as_array().unwrap();
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
        // Fixed candidate set is shared across routes; this is a readout comparison,
        // not a claim to reproduce the production Chunk candidate generator.
        let candidates:Vec<Value>={
            let mut statement=c.prepare(
                "SELECT id FROM chunks WHERE file_id=?1 ORDER BY id LIMIT 32").unwrap();
            statement.query_map([file],|r|r.get::<_,i64>(0)).unwrap()
                .map(|r|json!({"id":r.unwrap()})).collect()
        };
        for (route,preset,strategy) in [
            ("cosine","locked_0","LayerSchedule"),
            ("warped_ags","locked_0","LayerSchedule"),
            ("warped_ags","locked_0","EpaGuided"),
            ("warped_ags","locked_2","LayerSchedule"),
            ("warped_ags","locked_2","EpaGuided"),
        ] {
            let input=json!({"config":{"tagRoutingMode":route,"warpedPreset":preset,
                "warpedRadiusStrategy":strategy}});
            let result=run_pipeline_with_connection(&index,&runtime,&artifact_sig,3072,
                &input.to_string(),&query,&[],&artifact,&c).unwrap();
            let metadata:Value=serde_json::from_str(&result.metadata_json).unwrap();
            let handle=metadata["observationHandle"].as_str().unwrap();
            let observation=runtime.get_query_observation(handle,&artifact_sig).unwrap();
            let downstream=json!({"dimension":3072,"observationHandle":handle,"query":{},
                "queryState":{},"candidates":candidates,"topK":10});
            let first=crate::rivermemo_topology_v3::run_native_with_connection(
                &runtime,&c,&artifact_sig,&downstream.to_string()).unwrap();
            let second=crate::rivermemo_topology_v3::run_native_with_connection(
                &runtime,&c,&artifact_sig,&downstream.to_string()).unwrap();
            assert_eq!(stable_results(&first),stable_results(&second));
            let downstream_value:Value=serde_json::from_str(&first).unwrap();
            write_row(&mut out,json!({"type":"pipeline","chunk":chunk,"route":route,
                "preset":preset,"strategy":strategy,"explained":metadata["pyramid"]["totalExplainedEnergy"],
                "epa":{"gate":metadata["epa"]["inDomainGate"],"logic":metadata["epa"]["logicDepth"],
                    "entropy":metadata["epa"]["entropy"]},
                "diagnostics":metadata["diagnostics"],"spikeNodes":observation.observation.nodes.len(),
                "poolNodes":observation.tag_vectors.len(),"downstreamStable":true,
                "candidateScope":"source-file chunks only; no relevance labels",
                "downstreamDiagnostics":downstream_value["diagnostics"]}));
            // Evaluation happens AFTER the timed real pipeline and readout. It owns
            // separate single-row scratch and never populates the request vector pool.
            if route=="warped_ags" {
                let key=if preset=="locked_0" {crate::warped_tag_field::Preset::Locked0}
                    else {crate::warped_tag_field::Preset::Locked2};
                let fields=runtime.warped_fields.read().unwrap();
                let field=&fields[&key];
                let mut residual=query.clone();
                let mut excluded=HashSet::new();
                let accepted=metadata["pyramid"]["levels"].as_array().unwrap();
                for attempt in metadata["diagnostics"]["tagRouting"]["attempts"].as_array().unwrap() {
                    let level=attempt["level"].as_u64().unwrap() as usize;
                    let radius=attempt["radius"].as_f64().unwrap() as f32;
                    let found:Vec<i64>=attempt["ids"].as_array().unwrap().iter()
                        .map(|id|id.as_i64().unwrap()).collect();
                    let mut truth=Vec::new();
                    let mut statement=c.prepare_cached("SELECT vector FROM tags WHERE id=?1").unwrap();
                    let mut row=Vec::new();
                    for (node,&id) in field.ids.iter().enumerate() {
                        if excluded.contains(&id) {continue;}
                        row.clear();
                        assert!(statement.query_row([id],|r|
                            crate::index_source::decode_column_into(r,0,3072,&mut row)).unwrap());
                        let distance=field.index.exact_distance(&residual,radius,&row,node).unwrap();
                        truth.push((id,distance));
                    }
                    truth.sort_unstable_by(|a,b|a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
                    truth.truncate(10);
                    let hits=truth.iter().filter(|t|found.contains(&t.0)).count();
                    write_row(&mut out,json!({"type":"layer_truth","chunk":chunk,"preset":preset,
                        "strategy":strategy,"level":level,"recall":hits as f64/truth.len().max(1) as f64,
                        "accepted":level<accepted.len(),"truthRows":field.ids.len()-excluded.len()}));
                    if level<accepted.len() {
                        let vectors:Vec<(i64,&[f32])>=found.iter().map(|id|
                            (*id,observation.tag_vectors[id].as_ref())).collect();
                        residual=crate::memo_nnls::solve(&residual,&vectors).unwrap().residual;
                        excluded.extend(found);
                    }
                }
            }
            assert!(runtime.release_query_observation(handle).unwrap());
        }
        eprintln!("Phase5 development file complete {}/{}",files.len(),queries.len());
    }
    c.execute_batch("ROLLBACK").unwrap();
    drop(c);
    assert_eq!(before,snapshot_hash(&work));
    write_row(&mut out,json!({"type":"complete","queries":queries.len(),"snapshotSha256":before}));
}
