use super::run_build;
use crate::memo_geometry::{GeometryTask, GeometryResult};
use crate::storage;
use napi::Task;
use rusqlite::params;
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

struct Fixture {
    root: std::path::PathBuf,
    store: storage::SqliteStorageEngine,
    task: GeometryTask,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("local-reuse-{}-{}", std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&root).unwrap();
        let db = root.join("facts.sqlite").to_string_lossy().into_owned();
        let (store, _) = storage::SqliteStorageEngine::open_and_init(&db, Default::default()).unwrap();
        let index = crate::VexusIndex::new(4, 16).unwrap();
        let task = GeometryTask { index: index.index.clone(), content_revision: index.content_revision.clone(),
            dimensions: 4, db_path: db, model_sig: "test".into(), config_json: "{}".into() };
        let f = Self { root, store, task };
        f.store.submit_write(|tx| {
            tx.execute("INSERT INTO files(id,path,diary_name,checksum,mtime,size) VALUES(4,'4','0','0',0,0)", [])
                .map_err(|e| e.to_string())?;
            for id in 1..=102 {
                let x = id as f32;
                let v: Vec<u8> = [x.cos(), x.sin(), (x*0.17).cos(), 0.1].iter()
                    .flat_map(|x| x.to_le_bytes()).collect();
                tx.execute("INSERT INTO tags(id,name,vector) VALUES(?1,CAST(?1 AS TEXT),?2)",
                    params![id, v]).map_err(|e| e.to_string())?;
                if id <= 100 {
                    tx.execute("INSERT INTO file_tags VALUES(4,?1,?1)",[id]).map_err(|e| e.to_string())?;
                }
            }
            Ok(receipt())
        }).unwrap();
        f
    }

    fn sql(&self, sql: &str) {
        let sql = sql.to_owned();
        self.store.submit_write(move |tx| {
            tx.execute_batch(&sql).map_err(|e|e.to_string())?;
            Ok(receipt())
        }).unwrap();
    }

    fn train(&mut self, force: bool) -> GeometryResult {
        self.task.config_json = if force { r#"{"forceRecompute":true}"# }
            else { r#"{"reuseAppendOnly":true}"# }.into();
        self.task.compute().unwrap()
    }

    fn publish_memo(&self) {
        let index = crate::VexusIndex::new(4, 16).unwrap();
        run_build(4, &index.memo_runtime, &self.task.db_path,
                  r#"{"modelSig":"test","effectiveConfig":{}}"#).unwrap();
    }

    fn append(&self) {
        self.sql("INSERT INTO files(id,path,diary_name,checksum,mtime,size) VALUES(2,'2','0','0',0,0);
                  INSERT INTO tags(id,name,vector) VALUES(103,'103',NULL);
                  INSERT INTO file_tags VALUES(2,1,7),(2,101,1),(2,103,1)");
    }

    fn snapshot(&self) -> (Vec<(i64,u64,u64,u64,i64)>,String,String) {
        storage::with_registered_read(&self.task.db_path, |c| {
            let mut q = c.prepare("SELECT tag_id,residual_energy,v9_anchor_gain,raw_residual_ratio,neighbor_count
                                   FROM tag_intrinsic_residuals ORDER BY tag_id").unwrap();
            let rows = q.query_map([], |r| Ok((r.get(0)?,r.get::<_,f64>(1)?.to_bits(),
                r.get::<_,f64>(2)?.to_bits(),r.get::<_,f64>(3)?.to_bits(),r.get(4)?))).unwrap()
                .collect::<rusqlite::Result<Vec<_>>>().unwrap();
            let diag = c.query_row("SELECT value FROM kv_store WHERE key='memo_local_cone_diagnostics'",
                                    [],|r| r.get(0)).unwrap();
            let mut epa: Value = serde_json::from_str(&c.query_row::<String,_,_>(
                "SELECT value FROM kv_store WHERE key='epa_basis_cache'",[],|r| r.get(0)).unwrap()).unwrap();
            epa.as_object_mut().unwrap().remove("timestamp");
            Ok((rows,diag,epa.to_string()))
        }).unwrap()
    }
}

fn receipt() -> storage::WriteReceipt {
    storage::WriteReceipt { operation:"fixture".into(),database_generation:0,facts_changed:true }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.store.shutdown().unwrap();
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}

fn reused(result: GeometryResult) -> usize {
    result.phase_summary.split(';').find_map(|v| v.strip_prefix("localReused=")).unwrap().parse().unwrap()
}

#[test]
fn append_only_matches_independent_full_publication() {
    let mut f = Fixture::new();
    assert_eq!(reused(f.train(false)), 0);
    f.publish_memo();
    f.append();
    assert_eq!(reused(f.train(false)), 100);
    let stitched = f.snapshot();
    assert_eq!(reused(f.train(true)), 0);
    assert_eq!(stitched, f.snapshot());
}

#[test]
fn unproven_append_uses_full_solver() {
    for edit in [
        "UPDATE file_tags SET position=9 WHERE file_id=4 AND tag_id=1",
        "DELETE FROM file_tags WHERE file_id=4 AND tag_id=1",
        "DELETE FROM files WHERE id=4",
        "INSERT INTO files(id,path,diary_name,checksum,mtime,size) VALUES(9,'9','0','0',0,0);
         DELETE FROM files WHERE id=9",
        "UPDATE tags SET vector_version=vector_version+1 WHERE id=100",
        "UPDATE tags SET vector=NULL WHERE id=100",
        "INSERT INTO file_tags VALUES(4,102,101)",
        "DELETE FROM tag_intrinsic_residual_status WHERE tag_id=102",
        "DELETE FROM tag_intrinsic_residuals WHERE tag_id=20",
        "UPDATE tagmemo_artifacts SET status='building'",
        "DELETE FROM rivermemo_artifacts",
        "DELETE FROM kv_store WHERE key='memo_local_inputs_v1'",
        "INSERT INTO tags(id,name,vector) VALUES(104,'104',NULL)",
    ] {
        let mut f = Fixture::new();
        f.train(true);
        f.publish_memo();
        f.append();
        f.sql(edit);
        assert_eq!(reused(f.train(false)), 0, "{edit}");
    }
    let mut f = Fixture::new();
    f.train(true);
    f.publish_memo();
    f.append();
    f.task.config_json = r#"{"reuseAppendOnly":true,"local":{"maxBasis":7}}"#.into();
    assert_eq!(reused(f.task.compute().unwrap()), 0);
}

#[test]
fn aborted_publish_preserves_previous_inputs_for_retry() {
    let mut f = Fixture::new();
    f.train(true);
    let old = f.snapshot();
    f.publish_memo();
    f.append();
    f.sql("CREATE TRIGGER abort_local BEFORE INSERT ON kv_store WHEN NEW.key='memo_local_inputs_v1'
           BEGIN SELECT raise(ABORT,'injected publication failure'); END");
    f.task.config_json = r#"{"reuseAppendOnly":true}"#.into();
    assert!(f.task.compute().err().unwrap().to_string().contains("injected publication failure"));
    assert_eq!(old, f.snapshot());
    f.sql("DROP TRIGGER abort_local;
           INSERT INTO files(id,path,diary_name,checksum,mtime,size) VALUES(8,'8','0','0',0,0);
           INSERT INTO file_tags VALUES(8,2,1),(8,102,2)");
    assert_eq!(reused(f.train(false)), 98);
    let retried = f.snapshot();
    f.train(true);
    assert_eq!(retried, f.snapshot());
}


#[test]
fn manual_forced_and_incompatible_training_solve_every_row() {
    for change in ["manual", "force", "model", "dimension", "algorithm"] {
        let mut f = Fixture::new();
        f.train(true);
        f.publish_memo();
        f.append();
        f.task.config_json = r#"{"reuseAppendOnly":true}"#.into();
        match change {
            "manual" => f.task.config_json = "{}".into(),
            "force" => f.task.config_json = r#"{"forceRecompute":true,"reuseAppendOnly":true}"#.into(),
            "model" => f.task.model_sig = "other".into(),
            "dimension" => f.task.dimensions = 3,
            _ => f.sql("UPDATE tagmemo_artifacts SET algorithm_version='older'"),
        }
        assert_eq!(reused(f.task.compute().unwrap()), 0, "{change}");
        if change == "manual" {
            assert!(f.task.compute().unwrap().phase_summary.starts_with("cache_hit;"));
        }
    }
}
