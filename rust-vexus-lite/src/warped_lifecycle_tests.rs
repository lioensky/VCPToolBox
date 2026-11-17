use super::*;
use crate::storage::{SqliteStorageEngine,StorageOptions,WriteReceipt};

fn receipt()->WriteReceipt {
    WriteReceipt {operation:"warped-production-fixture".into(),database_generation:0,facts_changed:true}
}
fn geometry(v:&crate::VexusIndex,db:&str) {
    crate::memo_geometry::GeometryTask {
        index:v.index.clone(),content_revision:v.content_revision.clone(),dimensions:2,
        db_path:db.into(),model_sig:"warped-lifecycle".into(),
        config_json:r#"{"forceRecompute":true,"local":{"minNeighbors":1}}"#.into(),
    }.compute().unwrap();
}
fn query(v:&crate::VexusIndex,db:&str,sig:&str)->Value {
    let result=crate::memo_pipeline::compute_owned(v.index.clone(),v.content_revision.clone(),
        v.memo_runtime.clone(),db.into(),sig.into(),2,
        r#"{"config":{"tagRoutingMode":"warped_ags","spikeRouting":{"dynamicWormholes":false}}}"#.into(),
        vec![0.3,0.8],vec![]).unwrap();
    let metadata:Value=serde_json::from_str(&result.metadata_json).unwrap();
    assert_eq!(metadata["diagnostics"]["tagRouting"]["used"],"warped_ags");
    assert_eq!(metadata["diagnostics"]["tagRouting"]["fallback"],false);
    v.memo_runtime.release_query_observation(metadata["observationHandle"].as_str().unwrap()).unwrap();
    metadata
}

#[test]
fn production_incremental_window_restart_concurrency_and_generation_rollover() {
    let root=std::env::temp_dir().join(format!("warped-lifecycle-{}-{}",
        std::process::id(),std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    std::fs::create_dir_all(&root).unwrap();
    let db=root.join("test.sqlite").to_string_lossy().into_owned();
    let (storage,_)=SqliteStorageEngine::open_and_init(&db,StorageOptions::default()).unwrap();
    storage.submit_write(|tx| {
        for id in 1..=512_i64 {
            let t=id as f32*0.17;
            let vector=[t.cos(),t.sin()];
            tx.execute("INSERT INTO tags(id,name,vector) VALUES (?1,?2,?3)",
                params![id,format!("tag{id}"),bytemuck::cast_slice::<f32,u8>(&vector)])
                .map_err(|e|e.to_string())?;
        }
        for file in 1..=64_i64 {
            tx.execute("INSERT INTO files(id,path,diary_name,checksum,mtime,size) VALUES (?1,?2,'test','h',1,1)",
                params![file,format!("f{file}.txt")]).map_err(|e|e.to_string())?;
            tx.execute("INSERT INTO file_tags VALUES (?1,1,1)",[file]).map_err(|e|e.to_string())?;
            for offset in 0..8_i64 {
                tx.execute("INSERT INTO file_tags VALUES (?1,?2,?3)",
                    params![file,2+((file-1)*8+offset)%511,offset+2]).map_err(|e|e.to_string())?;
            }
        }
        Ok(receipt())
    }).unwrap();
    let v=crate::VexusIndex::new(2,1024).unwrap();
    geometry(&v,&db);
    let input=r#"{"modelSig":"warped-lifecycle","warpedPresets":["locked_2"],"effectiveConfig":{}}"#;
    let first=run_build(2,&v.memo_runtime,&db,input).unwrap();
    query(&v,&db,&first.artifact_sig);
    let before=crate::storage::with_registered_read_transaction(&db,|c|crate::storage::read_generation(c)).unwrap();
    // Three changed Tags out of 512: strictly below the existing 1% trigger.
    storage.submit_write(|tx| {
        tx.execute_batch(
            "INSERT INTO files(id,path,diary_name,checksum,mtime,size) VALUES (65,'new.txt','test','n',1,1);
             INSERT INTO tags(id,name,vector) VALUES (513,'new-tag',X'0000803f00000000');
             INSERT INTO file_tags VALUES (65,1,1),(65,513,2);
             DELETE FROM file_tags WHERE tag_id=512;
             DELETE FROM tags WHERE id=512;"
        ).map_err(|e|e.to_string())?;
        Ok(receipt())
    }).unwrap();
    crate::TagIndexDeltaTask {
        index:v.index.clone(),content_revision:v.content_revision.clone(),memo_runtime:v.memo_runtime.clone(),
        dimensions:2,remove_ids:vec![512],upsert_ids:vec![513],upsert_vectors:vec![1.,0.],
    }.compute().unwrap();
    crate::storage::with_registered_read_transaction(&db,|c| {
        assert!(crate::storage::read_generation(c)?>before);
        let (changed,trained):(i64,i64)=c.query_row(
            "SELECT (SELECT COUNT(*) FROM kbm_memo_changed_tags),
             CAST((SELECT value FROM kbm_runtime_meta WHERE key='memo_training_tag_count') AS INTEGER)",
            [],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
        assert!(changed>0 && (changed as f64)/(trained as f64)<0.01);
        Ok(())
    }).unwrap();
    let restored=query(&v,&db,&first.artifact_sig);
    assert_eq!(restored["diagnostics"]["tagRouting"]["source"],"snapshot");
    std::thread::scope(|scope| {
        let workers:Vec<_>=(0..8).map(|_|scope.spawn(|| {
            for _ in 0..8 {query(&v,&db,&first.artifact_sig);}
        })).collect();
        for w in workers {w.join().unwrap();}
    });
    let mut hot_checks:Vec<f64>=(0..128).map(|_|query(&v,&db,&first.artifact_sig)
        ["diagnostics"]["tagRoutingCheckMs"].as_f64().unwrap()).collect();
    hot_checks.sort_by(f64::total_cmp);
    eprintln!("warped_incremental_hot_check samples=128 median_ms={:.6} p95_ms={:.6}",
        hot_checks[64],hot_checks[121]);
    // Actual engine shutdown/reopen, not merely clearing one cache.
    v.memo_runtime.clear().unwrap();
    storage.shutdown().unwrap();
    let (storage,_)=SqliteStorageEngine::open_and_init(&db,StorageOptions::default()).unwrap();
    let restarted=crate::VexusIndex::new(2,1024).unwrap();
    let restored=query(&restarted,&db,&first.artifact_sig);
    assert_eq!(restored["diagnostics"]["tagRouting"]["source"],"snapshot");
    // Cross the existing threshold; user/server scheduling owns triggering training.
    storage.submit_write(|tx| {
        tx.execute("UPDATE tags SET name=name||'-changed' WHERE id IN (2,3,4)",[])
            .map_err(|e|e.to_string())?;
        Ok(receipt())
    }).unwrap();
    crate::storage::with_registered_read_transaction(&db,|c| {
        let count:i64=c.query_row("SELECT COUNT(*) FROM kbm_memo_changed_tags",[],|r|r.get(0))
            .map_err(|e|e.to_string())?;
        assert!(count as f64/512.>=0.01);
        Ok(())
    }).unwrap();
    geometry(&restarted,&db);
    let second=run_build(2,&restarted.memo_runtime,&db,input).unwrap();
    assert_ne!(first.artifact_sig,second.artifact_sig);
    query(&restarted,&db,&second.artifact_sig);
    let mut prune=crate::knowledge_runtime::NativeMemoArtifactPruneTask {
        db_path:db.clone(),retain_ready_artifacts:1,failed_retention_ms:3600000,
    };
    let summary:Value=serde_json::from_str(&prune.compute().unwrap()).unwrap();
    assert_eq!(summary["warpedSnapshotsDeleted"],1);
    assert_eq!(std::fs::read_dir(&root).unwrap().filter_map(|e|e.ok())
        .filter(|e|e.path().extension().is_some_and(|s|s=="vcpwf")).count(),1);
    storage.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}