use crate::storage::with_registered_write;
use napi::bindgen_prelude::*;
use serde::Serialize;
use std::sync::{Arc, Mutex};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairwiseModelCleanupResult {
    current_model_sig: String,
    current_rows: i64,
    stale_rows: i64,
    removed_rows: i64,
    skipped: bool,
    facts_committed: bool,
}

pub struct PairwiseModelCleanupTask {
    pub(crate) db_path: String,
    pub(crate) model_sig: String,
}

impl Task for PairwiseModelCleanupTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let model_sig = self.model_sig.trim().to_string();
        if model_sig.is_empty() {
            return Err(Error::from_reason(
                "cleanupStalePairwiseSimilarityModels requires modelSig",
            ));
        }

        let _publication_guard = crate::publication_gate::acquire(
            &self.db_path, &[String::from("*")],
        ).map_err(Error::from_reason)?;
        let db_path = self.db_path.clone();
        let model_sig_for_write = model_sig.clone();
        let details = Arc::new(Mutex::new(None));
        let details_for_write = Arc::clone(&details);

        with_registered_write(&db_path, move |transaction| {
            let current_rows = transaction
                .query_row(
                    "SELECT COUNT(*) FROM tag_pair_similarity WHERE model_sig = ?1",
                    rusqlite::params![&model_sig_for_write],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|error| {
                    format!("Count current pairwise model rows failed: {}", error)
                })?;

            let stale_rows = transaction
                .query_row(
                    "SELECT COUNT(*) FROM tag_pair_similarity WHERE model_sig != ?1",
                    rusqlite::params![&model_sig_for_write],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|error| format!("Count stale pairwise model rows failed: {}", error))?;

            // Even when stale numeric rows are already gone, statuses/artifacts can remain.
            let should_skip = current_rows <= 0;
            let removed_rows = if should_skip {
                0
            } else {
                transaction
                    .execute(
                        "DELETE FROM tag_pair_similarity WHERE model_sig != ?1",
                        rusqlite::params![&model_sig_for_write],
                    )
                    .map_err(|error| {
                        format!("Delete stale pairwise model rows failed: {}", error)
                    })? as i64
            };

            if !should_skip {
                transaction.execute(
                    "DELETE FROM tag_pair_similarity_status WHERE model_sig != ?1",
                    [&model_sig_for_write],
                ).map_err(|error| format!("Delete stale pairwise statuses failed: {}", error))?;
                transaction.execute(
                    "DELETE FROM tagmemo_artifacts WHERE asset_type='pairwise_similarity' AND model_sig != ?1",
                    [&model_sig_for_write],
                ).map_err(|error| format!("Delete stale pairwise artifacts failed: {}", error))?;
            }
            transaction.execute(
                "DELETE FROM kbm_operation_receipts
                 WHERE expires_at < CAST(strftime('%s','now') AS INTEGER)*1000",
                [],
            ).map_err(|error| format!("Delete expired operation receipts failed: {}", error))?;

            details_for_write
                .lock()
                .map_err(|_| "Pairwise model cleanup details lock poisoned".to_string())?
                .replace((current_rows, stale_rows, removed_rows, should_skip));

            Ok(crate::storage::WriteReceipt {
                operation: "cleanup_stale_pairwise_similarity_models".to_string(),
                database_generation: 0,
                facts_changed: false,
            })
        })
        .map_err(|error| {
            Error::from_reason(format!(
                "Pairwise model cleanup Write Actor commit failed: {}",
                error
            ))
        })?;

        let (current_rows, stale_rows, removed_rows, skipped) = details
            .lock()
            .map_err(|_| Error::from_reason("Pairwise model cleanup details lock poisoned"))?
            .take()
            .ok_or_else(|| {
                Error::from_reason("Pairwise model cleanup completed without details")
            })?;

        serde_json::to_string(&PairwiseModelCleanupResult {
            current_model_sig: model_sig,
            current_rows,
            stale_rows,
            removed_rows,
            skipped,
            facts_committed: false,
        })
        .map_err(|error| {
            Error::from_reason(format!(
                "Encode pairwise model cleanup result failed: {}",
                error
            ))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_removes_stale_metadata_and_only_expired_receipts() {
        let root = std::env::temp_dir().join(format!(
            "kbm-pair-cleanup-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db = root.join("test.sqlite").to_string_lossy().into_owned();
        let (storage, _) = crate::storage::SqliteStorageEngine::open_and_init(
            &db, crate::storage::StorageOptions::default(),
        ).unwrap();
        storage.submit_write(|tx| {
            tx.execute_batch(
                "INSERT INTO tag_pair_similarity VALUES (1,2,0.9,'current',0);
                 INSERT INTO tag_pair_similarity_status VALUES (1,2,'old','old-asset','computed',0.8,0.05,0);
                 INSERT INTO tagmemo_artifacts VALUES
                   ('old-asset','pairwise_similarity','old','g','v','c','{}','ready',0,0),
                   ('current-asset','pairwise_similarity','current','g','v','c','{}','ready',0,0);
                 INSERT INTO kbm_operation_receipts VALUES
                   ('expired','ingestion','b','d','committed',1,'{}',0,1),
                   ('active','ingestion','b','d','committed',1,'{}',0,9223372036854775807);"
            ).map_err(|error| error.to_string())?;
            Ok(crate::storage::WriteReceipt {
                operation: "fixture".into(), database_generation: 0, facts_changed: false,
            })
        }).unwrap();
        PairwiseModelCleanupTask { db_path: db.clone(), model_sig: "current".into() }
            .compute().unwrap();
        storage.read(|connection| {
            for (sql, expected) in [
                ("SELECT COUNT(*) FROM tag_pair_similarity_status", 0),
                ("SELECT COUNT(*) FROM tagmemo_artifacts WHERE model_sig='old'", 0),
                ("SELECT COUNT(*) FROM tagmemo_artifacts WHERE model_sig='current'", 1),
                ("SELECT COUNT(*) FROM kbm_operation_receipts WHERE operation_id='expired'", 0),
                ("SELECT COUNT(*) FROM kbm_operation_receipts WHERE operation_id='active'", 1),
            ] {
                let count: i64 = connection.query_row(sql, [], |row| row.get(0))
                    .map_err(|error| error.to_string())?;
                assert_eq!(count, expected, "{}", sql);
            }
            Ok(())
        }).unwrap();
        storage.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}