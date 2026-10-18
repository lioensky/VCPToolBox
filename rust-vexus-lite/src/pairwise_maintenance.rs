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

            let should_skip = current_rows <= 0 || stale_rows <= 0;
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