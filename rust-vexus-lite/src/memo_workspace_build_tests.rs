use super::*;
use crate::storage::{SqliteStorageEngine, StorageOptions, WriteReceipt};

fn fixture() -> (std::path::PathBuf, String, SqliteStorageEngine, crate::VexusIndex) {
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!("memo-handoff-{}-{nonce}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let db = root.join("test.sqlite").to_string_lossy().into_owned();
    let (storage, _) = SqliteStorageEngine::open_and_init(&db, StorageOptions::default()).unwrap();
    storage.submit_write(|tx| {
        tx.execute_batch("INSERT INTO files(id,path,diary_name,checksum,mtime,size) VALUES (1,'synthetic.txt','test','h',1,1);")
            .map_err(|error| error.to_string())?;
        for (id, name, vector) in [(1,"a",[1.0f32,0.0]),(2,"b",[0.0,1.0]),(3,"c",[0.6,0.8])] {
            tx.execute("INSERT INTO tags(id,name,vector) VALUES (?1,?2,?3)",
                params![id,name,bytemuck::cast_slice::<f32,u8>(&vector)]).map_err(|e|e.to_string())?;
        }
        tx.execute_batch("INSERT INTO file_tags VALUES (1,1,1),(1,2,2),(1,3,3);").map_err(|e|e.to_string())?;
        Ok(WriteReceipt { operation:"fixture".into(), database_generation:0, facts_changed:true })
    }).unwrap();
    (root, db, storage, crate::VexusIndex::new(2,16).unwrap())
}

fn geometry(vexus: &crate::VexusIndex, db: &str, config: &str) -> Result<crate::memo_geometry::GeometryResult> {
    crate::memo_geometry::GeometryTask {
        index:vexus.index.clone(), content_revision:vexus.content_revision.clone(), dimensions:2,
        db_path:db.into(), model_sig:"handoff-test".into(), config_json:config.into(),
    }.compute()
}

const CONFIG: &str = r#"{"forceRecompute":true,"local":{"minNeighbors":1}}"#;
const INPUT: &str = r#"{"modelSig":"handoff-test","effectiveConfig":{"orderedCooccurrence":{"semanticGainEnabled":true}}}"#;

#[test]
fn graph_handoff_tag_write_error_and_generation_fallback_match_fresh_sql() {
    let (root, db, storage, vexus) = fixture();
    geometry(&vexus, &db, CONFIG).unwrap();
    let old = run_build(2,&vexus.memo_runtime,&db,INPUT).unwrap();
    geometry(&vexus, &db, CONFIG).unwrap();
    let slot = crate::storage::memo_workspace_slot(&db).unwrap();
    let stale_path = slot.pending_path().unwrap();
    storage.submit_write(|tx| {
        tx.execute("UPDATE tags SET vector=?1 WHERE id=1", [bytemuck::cast_slice::<f32,u8>(&[0.0,1.0])])
            .map_err(|e|e.to_string())?;
        Ok(WriteReceipt { operation:"change-vector".into(), database_generation:0, facts_changed:true })
    }).unwrap();
    let error = run_build(2,&vexus.memo_runtime,&db,INPUT).err().unwrap();
    assert_eq!(error,"KNOWLEDGE_STORE_DERIVED_DEPENDENCY_CONFLICT: geometry facts are stale");
    assert_eq!(error,run_build(2,&vexus.memo_runtime,&db,INPUT).err().unwrap());
    assert!(!stale_path.exists());
    assert!(slot.take().is_none());
    // A Tag write requires fresh geometry under the existing upstream contract.
    geometry(&vexus, &db, CONFIG).unwrap();
    let stale_path = slot.pending_path().unwrap();
    // An unrelated file write changes the database generation but not Tag facts.
    storage.submit_write(|tx| {
        tx.execute_batch("INSERT INTO files(path,diary_name,checksum,mtime,size) VALUES ('plain.txt','test','plain',1,1);")
            .map_err(|e|e.to_string())?;
        Ok(WriteReceipt { operation:"ordinary-file".into(), database_generation:0, facts_changed:true })
    }).unwrap();
    let fallback = run_build(2,&vexus.memo_runtime,&db,INPUT).unwrap();
    assert!(!stale_path.exists());
    assert!(slot.take().is_none());
    assert_ne!(old.graph_generation, fallback.graph_generation, "fixture must detect stale vectors");
    let payload = |sig: &str| crate::storage::with_registered_read(&db, |conn| {
        conn.query_row("SELECT payload FROM rivermemo_artifacts WHERE artifact_sig=?1", [sig],
            |row| row.get::<_,Vec<u8>>(0)).map_err(|e|e.to_string())
    }).unwrap();
    let expected_bytes = payload(&fallback.artifact_sig);
    let fresh = run_build(2,&vexus.memo_runtime,&db,INPUT).unwrap();
    assert_eq!(fallback.artifact_sig, fresh.artifact_sig);
    assert_eq!(expected_bytes, payload(&fresh.artifact_sig));
    storage.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn graph_and_geometry_errors_and_storage_close_delete_pending_file() {
    let (root, db, storage, vexus) = fixture();
    let slot = crate::storage::memo_workspace_slot(&db).unwrap();
    geometry(&vexus, &db, CONFIG).unwrap();
    let path = slot.pending_path().unwrap();
    assert!(run_build(2,&vexus.memo_runtime,&db,"invalid JSON").is_err());
    assert!(!path.exists());
    geometry(&vexus, &db, CONFIG).unwrap();
    let path = slot.pending_path().unwrap();
    assert!(geometry(&vexus, &db,"invalid JSON").is_err());
    assert!(!path.exists());
    geometry(&vexus, &db, CONFIG).unwrap();
    let path = slot.pending_path().unwrap();
    storage.shutdown().unwrap();
    assert!(!path.exists());
    assert!(slot.take().is_none());
    let (reopened, _) = SqliteStorageEngine::open_and_init(&db,StorageOptions::default()).unwrap();
    let new_slot = crate::storage::memo_workspace_slot(&db).unwrap();
    assert!(!Arc::ptr_eq(&slot,&new_slot));
    assert!(new_slot.take().is_none());
    reopened.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
