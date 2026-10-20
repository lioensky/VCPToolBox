//! SQL-derived in-memory compaction; never publishes or creates vector files.
//! Invoke only after releasing the caller's exclusive publication gate.
//! Runs within an existing tracked task; no detached workers are created.
use crate::index_handle::IndexHandle;
use crate::retrieval_index::RetrievalIndex;
use std::sync::{Arc, atomic::{AtomicU64, Ordering}};

pub(crate) fn maintain(
    db_path: &str,
    diary: Option<&str>,
    index: &Arc<IndexHandle>,
    revision: &Arc<AtomicU64>,
) -> Result<bool, String> {
    let _single_flight = match index.maintenance.try_lock() {
        Ok(guard) => guard,
        Err(std::sync::TryLockError::WouldBlock) => return Ok(false),
        Err(_) => return Err("Index maintenance lock poisoned".into()),
    };
    let scope = diary.map(|name| format!("diary:{}", name))
        .unwrap_or_else(|| "global_tags".into());
    // Shared gate permits queries while excluding SQL fact writers. Acquire
    // before any index lock, matching the runtime publication lock order.
    let _gate = crate::publication_gate::acquire_read(db_path, &[scope.clone()])?;
    crate::knowledge_runtime::ensure_index_scopes_ready(db_path, &[scope])?;
    let (dimension, revision_before) = {
        let active = index.read().map_err(|error| error.to_string())?;
        if !active.maintenance_required() {
            return Ok(false);
        }
        (active.dimensions(), revision.load(Ordering::Acquire))
    };
    let (generation, build) = crate::storage::with_registered_read_transaction(
        db_path, |connection| {
            let generation = crate::storage::read_generation(connection)?;
            let build = crate::index_source::build_memory_from_connection(
                connection, diary, dimension, "unendorsed-runtime-maintenance",
            )?;
            Ok((generation, build))
        },
    )?;
    // No file or SQL endorsement is changed. A stale memory build is discarded,
    // leaving the live instance untouched.
    crate::storage::with_registered_read_transaction(db_path, |connection| {
        crate::storage::ensure_generation(connection, generation)
    })?;
    let mut active = index.write().map_err(|error| error.to_string())?;
    if revision.load(Ordering::Acquire) != revision_before {
        return Ok(false);
    }
    *active = RetrievalIndex::from_sql(build);
    // Pure compaction changes neither facts nor content revision.
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_compaction_is_single_flight_and_preserves_generations() {
        let root = std::env::temp_dir().join(format!(
            "kbm-maintenance-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db = root.join("test.sqlite").to_string_lossy().into_owned();
        let (store, _) = crate::storage::SqliteStorageEngine::open_and_init(
            &db, crate::storage::StorageOptions::default(),
        ).unwrap();
        store.submit_write(|tx| {
            let mut insert = tx.prepare("INSERT INTO tags(id,name,vector) VALUES (?1,?2,?3)")
                .map_err(|error| error.to_string())?;
            for id in 1..=2048 {
                let angle = id as f32 * 0.013;
                let bytes: Vec<u8> = [angle.cos(), angle.sin(), 0.25_f32].iter()
                    .flat_map(|value| value.to_le_bytes()).collect();
                insert.execute(rusqlite::params![id, format!("tag-{}", id), bytes])
                    .map_err(|error| error.to_string())?;
            }
            tx.execute(
                "INSERT INTO kbm_index_states(scope,state,facts_generation,applied_generation,updated_at)
                 VALUES ('global_tags','ready',0,0,0)", [],
            ).map_err(|error| error.to_string())?;
            Ok(crate::storage::WriteReceipt {
                operation: "fixture".into(), database_generation: 0, facts_changed: true,
            })
        }).unwrap();
        // Publish matching scope state after the fixture advances SQL generation.
        store.submit_write(|tx| {
            tx.execute(
                "UPDATE kbm_index_states SET
                 facts_generation=(SELECT CAST(value AS INTEGER) FROM kbm_runtime_meta WHERE key='database_generation'),
                 applied_generation=(SELECT CAST(value AS INTEGER) FROM kbm_runtime_meta WHERE key='database_generation')",
                [],
            ).map_err(|error| error.to_string())?;
            Ok(crate::storage::WriteReceipt {
                operation: "ready".into(), database_generation: 0, facts_changed: false,
            })
        }).unwrap();
        let owner = crate::VexusIndex::new(3, 2048).unwrap();
        {
            let mut active = owner.index.write().unwrap();
            let ids: Vec<u64> = (1..=2048).collect();
            active.apply_delta(&[], &ids, &vec![1.0; 2048 * 3]).unwrap();
        }
        let generation = crate::storage::with_registered_read_transaction(
            &db, crate::storage::read_generation,
        ).unwrap();
        let flight = owner.index.maintenance.lock().unwrap();
        assert!(!maintain(&db, None, &owner.index, &owner.content_revision).unwrap());
        drop(flight);
        let files_before = std::fs::read_dir(&root).unwrap().count();
        assert!(maintain(&db, None, &owner.index, &owner.content_revision).unwrap());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), files_before);
        assert_eq!(owner.content_revision.load(Ordering::Acquire), 0);
        assert_eq!(crate::storage::with_registered_read_transaction(
            &db, crate::storage::read_generation,
        ).unwrap(), generation);
        {
            let active = owner.index.read().unwrap();
            assert_eq!(active.size(), 2048);
            assert_eq!(active.mmap_bytes(), 0);
            assert!(!active.maintenance_required());
            let angle = 17_f32 * 0.013;
            let query = [angle.cos(), angle.sin(), 0.25];
            let (hits, wider, exhaustive) = crate::storage::with_registered_read_transaction(
                &db, |connection| {
                    Ok((
                        active.search_sql(connection, None, &query, 1).map_err(|e| e.to_string())?,
                        active.search_sql(connection, None, &query, 64).map_err(|e| e.to_string())?,
                        active.search_sql(connection, None, &query, 2048).map_err(|e| e.to_string())?,
                    ))
                },
            ).unwrap();
            eprintln!("maintenance self-query top1={:?}, top64_self={:?}, full_self={:?}, full_count={}",
                hits, wider.iter().find(|hit| hit.0 == 17),
                exhaustive.iter().find(|hit| hit.0 == 17), exhaustive.len());
            assert_eq!(hits[0].0, 17);
            assert!((hits[0].1 - 1.0).abs() < 1e-6);
        }
        assert!(!maintain(&db, None, &owner.index, &owner.content_revision).unwrap());
        drop(owner);
        store.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}