fn current_time_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

use crate::rivermemo_topology_v3::MemoRuntime;
use crate::storage::{with_registered_write, WriteReceipt};
use crate::text::{extract_tags, TagRules};
use napi::bindgen_prelude::*;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

fn valid_tag_vector(bytes: Option<&[u8]>, dimension: usize) -> bool {
    let Some(bytes) = bytes else { return false; };
    bytes.len() == dimension * 4 && bytes.chunks_exact(4).all(|part| {
        f32::from_ne_bytes([part[0], part[1], part[2], part[3]]).is_finite()
    })
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConsistencyPlan {
    token: String,
    digest: String,
    created_at: i64,
    expires_at: i64,
    model_sig: String,
    dimension: usize,
    files: Vec<ConsistencyFile>,
    vectorize_names: Vec<String>,
    orphan_tags: Vec<OrphanTag>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConsistencyFile {
    file_id: i64,
    expected_tags: Vec<String>,
    #[serde(default)]
    source_path: Option<String>,
    #[serde(default)]
    source_hash: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct OrphanTag {
    id: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TagConsistencyCommitResult {
    digest: String,
    affected_files: usize,
    removed_tag_ids: Vec<i64>,
    upserted_tag_ids: Vec<i64>,
    dimension: usize,
    total_vectors: usize,
    facts_committed: bool,
    index_ready: bool,
}

pub struct TagConsistencyCommitTask {
    pub(crate) db_path: String,
    pub(crate) plan_json: String,
    pub(crate) tag_vectors: Vec<f32>,
    pub(crate) global_tag_index: Arc<crate::index_handle::IndexHandle>,
    pub(crate) global_tag_content_revision: Arc<AtomicU64>,
    pub(crate) memo_runtime: Arc<MemoRuntime>,
}

impl Task for TagConsistencyCommitTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let _publication_guard = crate::publication_gate::acquire(&self.db_path, &[String::from("*")]).map_err(Error::from_reason)?;
        let plan: ConsistencyPlan = serde_json::from_str(&self.plan_json)
            .map_err(|error| Error::from_reason(format!("Invalid Tag consistency plan JSON: {}", error)))?;

        if plan.token.trim().is_empty() || plan.digest.trim().is_empty() {
            return Err(Error::from_reason(
                "Tag consistency plan requires token and digest".to_string(),
            ));
        }
        if plan.created_at <= 0 || plan.expires_at <= plan.created_at {
            return Err(Error::from_reason(
                "Tag consistency plan token is expired or has invalid timestamps".to_string(),
            ));
        }
        if plan.model_sig.trim().is_empty() {
            return Err(Error::from_reason(
                "Tag consistency plan requires modelSig".to_string(),
            ));
        }
        if plan.dimension == 0 || plan.dimension > 32_768 {
            return Err(Error::from_reason(
                "Tag consistency dimension is outside native limits".to_string(),
            ));
        }
        let expected_values = plan
            .vectorize_names
            .len()
            .checked_mul(plan.dimension)
            .ok_or_else(|| Error::from_reason("Tag consistency vector payload size overflow"))?;
        if self.tag_vectors.len() != expected_values {
            return Err(Error::from_reason(format!(
                "Tag consistency vector payload mismatch: names={}, expected={}, got={}",
                plan.vectorize_names.len(),
                expected_values,
                self.tag_vectors.len()
            )));
        }
        let mut seen_names = HashSet::with_capacity(plan.vectorize_names.len());
        if plan.vectorize_names.iter().any(|name| {
            let trimmed = name.trim();
            trimmed.is_empty() || !seen_names.insert(trimmed.to_string())
        }) {
            return Err(Error::from_reason(
                "Tag consistency vectorizeNames must be unique and non-empty".to_string(),
            ));
        }
        if self.tag_vectors.iter().any(|value| !value.is_finite()) {
            return Err(Error::from_reason(
                "Tag consistency vector payload contains a non-finite value".to_string(),
            ));
        }

        let canonical_plan = serde_json::to_string(&plan)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let operation_digest = {
            use sha2::{Digest, Sha256};
            let mut hash = Sha256::new();
            hash.update(canonical_plan.as_bytes());
            hash.update((self.tag_vectors.len() as u64).to_le_bytes());
            for value in &self.tag_vectors {
                hash.update(value.to_le_bytes());
            }
            format!("{:x}", hash.finalize())
        };
        let digest = plan.digest.clone();
        let dimension = plan.dimension;
        let vectors = self.tag_vectors.clone();
        let details = Arc::new(Mutex::new(None));
        let details_for_write = Arc::clone(&details);

        let receipt = with_registered_write(&self.db_path, move |tx| {
            type Details = (usize, Vec<i64>, Vec<i64>, Vec<f32>);
            let existing: Option<(String, String, i64)> = tx.query_row(
                "SELECT plan_digest, receipt_json, database_generation
                 FROM kbm_operation_receipts
                 WHERE operation_id=?1 AND operation_type='tag_consistency' AND status='committed'",
                [&plan.token], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            ).optional().map_err(|error| error.to_string())?;
            if let Some((stored_digest, raw, generation)) = existing {
                if stored_digest != operation_digest {
                    return Err("KNOWLEDGE_STORE_OPERATION_DIGEST_CONFLICT".to_string());
                }
                let stored: Details = serde_json::from_str(&raw)
                    .map_err(|error| error.to_string())?;
                details_for_write.lock()
                    .map_err(|_| "Tag details poisoned".to_string())?.replace(stored);
                return Ok(WriteReceipt {
                    operation: "commit_tag_consistency/idempotent".to_string(),
                    database_generation: generation.max(0) as u64,
                    facts_changed: false,
                });
            }
            let stored: Option<(String, i64, String, i64)> = tx.query_row(
                "SELECT plan_json, database_generation, status, expires_at
                 FROM kbm_prepared_plans WHERE token=?1 AND operation_type='tag_consistency'",
                [&plan.token],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            ).optional().map_err(|error| error.to_string())?;
            let (stored_json, prepared_generation, status, expires) = stored
                .ok_or_else(|| "KNOWLEDGE_STORE_PLAN_NOT_FOUND".to_string())?;
            if status != "prepared" || expires <= current_time_ms() {
                return Err("KNOWLEDGE_STORE_PLAN_EXPIRED_OR_CANCELLED".to_string());
            }
            if stored_json != canonical_plan {
                return Err("KNOWLEDGE_STORE_PLAN_DIGEST_CONFLICT".to_string());
            }
            let current: i64 = tx.query_row(
                "SELECT CAST(value AS INTEGER) FROM kbm_runtime_meta WHERE key='database_generation'",
                [], |row| row.get(0),
            ).map_err(|error| error.to_string())?;
            if current != prepared_generation {
                return Err("KNOWLEDGE_STORE_PLAN_STALE".to_string());
            }
            for file in &plan.files {
                if let (Some(path), Some(expected)) = (&file.source_path, &file.source_hash) {
                    use sha2::{Digest, Sha256};
                    let content = std::fs::read(path)
                        .map_err(|error| format!("KNOWLEDGE_STORE_SOURCE_CHANGED: {}", error))?;
                    if format!("{:x}", Sha256::digest(&content)) != *expected {
                        return Err("KNOWLEDGE_STORE_SOURCE_CHANGED".to_string());
                    }
                } else if let Some(path) = &file.source_path {
                    match std::fs::metadata(path) {
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        _ => return Err("KNOWLEDGE_STORE_SOURCE_CHANGED: missing source reappeared or cannot be inspected".to_string()),
                    }
                }
            }
            // EmbeddingUtils 返回值按 vectorizeNames 的原始顺序排列；
            // 这里绝不能排序，否则会把向量写到错误的 Tag 上。
            let names: Vec<String> = plan.vectorize_names
                .iter()
                .map(|name| name.trim().to_string())
                .collect();

            let mut tag_ids = HashMap::<String, i64>::new();
            let mut upserted_ids = Vec::new();
            let mut upserted_vectors = Vec::new();

            for (slot, name) in names.iter().enumerate() {
                let existing: Option<(i64, Option<Vec<u8>>)> = tx
                    .query_row(
                        "SELECT id, vector FROM tags WHERE name = ?1",
                        [name],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()
                    .map_err(|error| format!("Lookup Tag '{}' failed: {}", name, error))?;

                let start = slot
                    .checked_mul(dimension)
                    .ok_or_else(|| "Tag consistency vector slot overflow".to_string())?;
                let end = start
                    .checked_add(dimension)
                    .ok_or_else(|| "Tag consistency vector slot end overflow".to_string())?;
                let vector = &vectors[start..end];
                let mut bytes = Vec::with_capacity(dimension * 4);
                for value in vector {
                    bytes.extend_from_slice(&value.to_ne_bytes());
                }

                let tag_id = if let Some((id, old_vector)) = existing {
                    if !valid_tag_vector(old_vector.as_deref(), dimension) {
                        tx.execute(
                            "UPDATE tags SET vector = ?1 WHERE id = ?2",
                            rusqlite::params![&bytes, id],
                        )
                        .map_err(|error| format!("Update Tag '{}' vector failed: {}", name, error))?;
                        upserted_ids.push(id);
                        upserted_vectors.extend_from_slice(vector);
                    }
                    id
                } else {
                    tx.execute(
                        "INSERT INTO tags(name, vector) VALUES (?1, ?2)",
                        rusqlite::params![name, &bytes],
                    )
                    .map_err(|error| format!("Insert Tag '{}' failed: {}", name, error))?;
                    let id = tx.last_insert_rowid();
                    upserted_ids.push(id);
                    upserted_vectors.extend_from_slice(vector);
                    id
                };
                tag_ids.insert(name.clone(), tag_id);
            }

            let mut affected_file_ids = HashSet::new();
            for file in &plan.files {
                if file.file_id <= 0 {
                    return Err("Tag consistency plan contains an invalid file ID".to_string());
                }

                let file_exists: bool = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM files WHERE id = ?1)",
                        [file.file_id],
                        |row| row.get(0),
                    )
                    .map_err(|error| {
                        format!("Validate Tag consistency file {} failed: {}", file.file_id, error)
                    })?;
                if !file_exists {
                    return Err(format!(
                        "Tag consistency plan references missing file {}",
                        file.file_id
                    ));
                }

                let mut current_relations = Vec::new();
                {
                    let mut statement = tx
                        .prepare(
                            "SELECT tag_id, position FROM file_tags \
                             WHERE file_id = ?1 ORDER BY position, tag_id",
                        )
                        .map_err(|error| {
                            format!(
                                "Read current Tag relations for file {} failed: {}",
                                file.file_id, error
                            )
                        })?;
                    let rows = statement
                        .query_map([file.file_id], |row| {
                            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
                        })
                        .map_err(|error| {
                            format!(
                                "Query current Tag relations for file {} failed: {}",
                                file.file_id, error
                            )
                        })?;
                    for row in rows {
                        current_relations.push(row.map_err(|error| {
                            format!(
                                "Decode current Tag relation for file {} failed: {}",
                                file.file_id, error
                            )
                        })?);
                    }
                }

                let mut expected_relations = Vec::with_capacity(file.expected_tags.len());
                for name in &file.expected_tags {
                    let tag_id = if let Some(tag_id) = tag_ids.get(name).copied() {
                        tag_id
                    } else {
                        tx.query_row(
                            "SELECT id FROM tags WHERE name = ?1",
                            [name],
                            |row| row.get(0),
                        )
                        .optional()
                        .map_err(|error| {
                            format!("Lookup expected Tag '{}' failed: {}", name, error)
                        })?
                        .ok_or_else(|| format!("Expected Tag '{}' has no database ID", name))?
                    };
                    expected_relations.push(tag_id);
                }

                let expected_pairs: Vec<(i64, i64)> = expected_relations
                    .iter()
                    .enumerate()
                    .map(|(position, tag_id)| (*tag_id, (position + 1) as i64))
                    .collect();

                if current_relations != expected_pairs {
                    tx.execute("DELETE FROM file_tags WHERE file_id = ?1", [file.file_id])
                        .map_err(|error| {
                            format!(
                                "Reset file_tags for {} failed: {}",
                                file.file_id, error
                            )
                        })?;
                    for (tag_id, position) in expected_pairs {
                        tx.execute(
                            "INSERT INTO file_tags(file_id, tag_id, position) VALUES (?1, ?2, ?3)",
                            rusqlite::params![file.file_id, tag_id, position],
                        )
                        .map_err(|error| {
                            format!("Insert file Tag relation failed: {}", error)
                        })?;
                    }
                    affected_file_ids.insert(file.file_id);
                }
            }

            let mut removed_ids = Vec::new();
            for orphan in &plan.orphan_tags {
                if orphan.id <= 0 {
                    continue;
                }
                let relation_count: i64 = tx
                    .query_row(
                        "SELECT COUNT(*) FROM file_tags WHERE tag_id = ?1",
                        [orphan.id],
                        |row| row.get(0),
                    )
                    .map_err(|error| format!("Check orphan Tag {} failed: {}", orphan.id, error))?;
                if relation_count == 0 {
                    tx.execute("DELETE FROM tags WHERE id = ?1", [orphan.id])
                        .map_err(|error| format!("Delete orphan Tag {} failed: {}", orphan.id, error))?;
                    removed_ids.push(orphan.id);
                }
            }

            tx.execute_batch(
                "DELETE FROM kv_store WHERE key='epa_basis_cache';
                 DELETE FROM tag_intrinsic_residuals;
                 DELETE FROM tag_intrinsic_residual_status;
                 DELETE FROM tagmemo_artifacts;
                 DELETE FROM rivermemo_artifacts;",
            )
            .map_err(|error| format!("Invalidate Tag derived assets failed: {}", error))?;

            tx.execute(
                "INSERT INTO kbm_index_states(
                    scope, state, facts_generation, applied_generation,
                    error_message, updated_at
                 ) VALUES ('global_tags', 'invalid', 0, 0, ?1, ?2)
                 ON CONFLICT(scope) DO UPDATE SET
                    state = 'invalid',
                    facts_generation = 0,
                    error_message = excluded.error_message,
                    updated_at = excluded.updated_at",
                rusqlite::params![
                    "Tag facts committed; global Tag index delta pending",
                    current_time_ms()
                ],
            )
            .map_err(|error| format!("Persist pending global Tag index state failed: {}", error))?;

            let committed = (
                affected_file_ids.len(), removed_ids, upserted_ids, upserted_vectors
            );
            tx.execute(
                "INSERT INTO kbm_operation_receipts(
                    operation_id, operation_type, batch_id, plan_digest, status,
                    database_generation, receipt_json, created_at, expires_at
                 ) VALUES (?1, 'tag_consistency', ?1, ?2, 'committed', 0, ?3, ?4, ?5)",
                rusqlite::params![
                    plan.token, operation_digest,
                    serde_json::to_string(&committed).map_err(|error| error.to_string())?,
                    current_time_ms(), plan.expires_at
                ],
            ).map_err(|error| error.to_string())?;
            tx.execute(
                "UPDATE kbm_prepared_plans SET status='committed' WHERE token=?1",
                [&plan.token],
            ).map_err(|error| error.to_string())?;
            details_for_write
                .lock()
                .map_err(|_| "Tag consistency details lock poisoned".to_string())?
                .replace(committed);

            Ok(WriteReceipt {
                operation: "commit_tag_consistency".to_string(),
                database_generation: 0,
                facts_changed: true,
            })
        })
        .map_err(Error::from_reason)?;

        let (affected_files, removed_tag_ids, upserted_tag_ids, upserted_vectors) = details
            .lock()
            .map_err(|_| Error::from_reason("Tag consistency details lock poisoned"))?
            .take()
            .ok_or_else(|| Error::from_reason("Tag consistency commit completed without details"))?;

        let mut index_ready = if !receipt.facts_changed {
            crate::storage::with_registered_read(&self.db_path, |connection| {
                connection.query_row(
                    "SELECT state='ready' AND facts_generation=applied_generation
                     FROM kbm_index_states WHERE scope='global_tags'",
                    [], |row| row.get::<_, bool>(0),
                ).map_err(|error| error.to_string())
            }).unwrap_or(false)
        } else { apply_tag_index_delta(
            &self.global_tag_index,
            &self.global_tag_content_revision,
            &self.memo_runtime,
            &removed_tag_ids,
            &upserted_tag_ids,
            &upserted_vectors,
            dimension,
        ) };

        if receipt.facts_changed {
        if let Err(error) = set_global_tag_index_state(
            &self.db_path,
            if index_ready { "ready" } else { "invalid" },
            receipt.database_generation,
            if index_ready { None } else { Some("global Tag index delta application failed") },
        ) {
            index_ready = false;
            eprintln!("[KBM] Tag facts committed; index state publication failed: {}", error);
        }
        }

        // The fact/index publication is complete. Compaction must acquire its
        // own shared publication gate, never while holding this exclusive gate.
        drop(_publication_guard);
        if index_ready {
            if let Err(error) = crate::index_maintenance::maintain(
                &self.db_path, None, &self.global_tag_index,
                &self.global_tag_content_revision,
            ) {
                eprintln!("[KBM] Tag consistency index maintenance deferred: {}", error);
            }
        }

        let total_vectors = self.global_tag_index.read()
            .map(|index| index.size()).unwrap_or(0);
        serde_json::to_string(&TagConsistencyCommitResult {
            digest,
            affected_files,
            removed_tag_ids,
            upserted_tag_ids,
            dimension,
            total_vectors,
            facts_committed: true,
            index_ready,
        })
        .map_err(|error| Error::from_reason(format!("Encode Tag consistency result failed: {}", error)))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

fn apply_tag_index_delta(
    index: &Arc<crate::index_handle::IndexHandle>,
    content_revision: &Arc<AtomicU64>,
    memo_runtime: &Arc<MemoRuntime>,
    remove_ids: &[i64],
    upsert_ids: &[i64],
    upsert_vectors: &[f32],
    dimension: usize,
) -> bool {
    if upsert_vectors.len() != upsert_ids.len().saturating_mul(dimension)
        || remove_ids.iter().chain(upsert_ids.iter()).any(|id| *id <= 0)
    {
        return false;
    }

    let mut seen = HashSet::with_capacity(upsert_ids.len());
    if upsert_ids.iter().any(|id| !seen.insert(*id)) {
        return false;
    }

    let removes: Vec<u64> = remove_ids.iter().map(|id| *id as u64).collect();
    let upserts: Vec<u64> = upsert_ids.iter().map(|id| *id as u64).collect();
    let Ok(mut guard) = index.write() else {
        return false;
    };
    if guard.dimensions() != dimension
        || guard.apply_delta(&removes, &upserts, upsert_vectors).is_err()
    {
        return false;
    }
    content_revision.fetch_add(1, Ordering::AcqRel);
    drop(guard);
    memo_runtime.clear().is_ok()
}

fn set_global_tag_index_state(
    db_path: &str,
    state: &str,
    applied_generation: u64,
    error_message: Option<&str>,
) -> Result<()> {
    if !matches!(state, "ready" | "invalid" | "recovering") {
        return Err(Error::from_reason(format!(
            "Invalid global Tag index state '{}'",
            state
        )));
    }

    let db_path = db_path.to_string();
    let state = state.to_string();
    let error_message = error_message.map(str::to_string);
    with_registered_write(&db_path, move |tx| {
        tx.execute(
            "UPDATE kbm_index_states
             SET state = ?1,
                 applied_generation = CASE WHEN ?1 = 'ready' THEN ?2 ELSE applied_generation END,
                 error_message = ?3,
                 updated_at = ?4
             WHERE scope = 'global_tags' AND facts_generation = ?2",
            rusqlite::params![
                state,
                applied_generation as i64,
                error_message,
                current_time_ms()
            ],
        )
        .map_err(|error| format!("Persist global Tag index state failed: {}", error))?;

        Ok(WriteReceipt {
            operation: "update_global_tag_index_state".to_string(),
            database_generation: 0,
            facts_changed: false,
        })
    })
    .map(|_| ())
    .map_err(Error::from_reason)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TagConsistencyPrepareRequest {
    pub(crate) db_path: String,
    pub(crate) root_path: String,
    #[serde(default)]
    pub(crate) ignore_folders: Vec<String>,
    #[serde(default)]
    pub(crate) ignore_prefixes: Vec<String>,
    #[serde(default)]
    pub(crate) ignore_suffixes: Vec<String>,
    #[serde(default)]
    pub(crate) tag_blacklist: Vec<String>,
    #[serde(default)]
    pub(crate) tag_blacklist_super: Vec<String>,
    pub(crate) max_tags: Option<usize>,
    pub(crate) dimension: usize,
    pub(crate) model_sig: String,
    pub(crate) ttl_ms: Option<i64>,
}

pub struct TagConsistencyPrepareTask {
    pub(crate) request_json: String,
}

impl Task for TagConsistencyPrepareTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let request: TagConsistencyPrepareRequest =
            serde_json::from_str(&self.request_json).map_err(|error| {
                Error::from_reason(format!("Invalid Tag consistency prepare request: {}", error))
            })?;
        if request.db_path.trim().is_empty() || request.root_path.trim().is_empty() {
            return Err(Error::from_reason(
                "Tag consistency prepare requires dbPath and rootPath".to_string(),
            ));
        }
        if request.dimension == 0
            || request.dimension > 32_768
            || request.model_sig.trim().is_empty()
        {
            return Err(Error::from_reason(
                "Tag consistency prepare requires dimension and modelSig".to_string(),
            ));
        }

        let snapshot = crate::storage::with_registered_read_transaction_napi(&request.db_path, |connection| {
            let generation = crate::storage::read_generation(connection).map_err(Error::from_reason)?;
            let mut files = Vec::new();
            let mut statement = connection
                .prepare("SELECT id, path FROM files ORDER BY id")
                .map_err(|error| Error::from_reason(format!("Prepare Tag files failed: {}", error)))?;
            let rows = statement
                .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
                .map_err(|error| Error::from_reason(format!("Query Tag files failed: {}", error)))?;
            for row in rows {
                files.push(row.map_err(|error| {
                    Error::from_reason(format!("Decode Tag file failed: {}", error))
                })?);
            }

            let mut tags = Vec::new();
            let mut tag_statement = connection
                .prepare("SELECT id, name, vector FROM tags ORDER BY id")
                .map_err(|error| Error::from_reason(format!("Prepare Tag rows failed: {}", error)))?;
            let tag_rows = tag_statement
                .query_map([], |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, i64>(0)?,
                        "name": row.get::<_, String>(1)?,
                        "hasVector": valid_tag_vector(
                            row.get::<_, Option<Vec<u8>>>(2)?.as_deref(), request.dimension
                        )
                    }))
                })
                .map_err(|error| Error::from_reason(format!("Query Tag rows failed: {}", error)))?;
            for row in tag_rows {
                tags.push(row.map_err(|error| {
                    Error::from_reason(format!("Decode Tag row failed: {}", error))
                })?);
            }

            let mut relations = Vec::new();
            let mut relation_statement = connection
                .prepare(
                    "SELECT ft.file_id, ft.tag_id, ft.position, t.name
                     FROM file_tags ft JOIN tags t ON t.id = ft.tag_id
                     ORDER BY ft.file_id, ft.position, ft.tag_id",
                )
                .map_err(|error| Error::from_reason(format!("Prepare Tag relations failed: {}", error)))?;
            let relation_rows = relation_statement
                .query_map([], |row| {
                    Ok(serde_json::json!({
                        "fileId": row.get::<_, i64>(0)?,
                        "tagId": row.get::<_, i64>(1)?,
                        "position": row.get::<_, i64>(2)?,
                        "name": row.get::<_, String>(3)?
                    }))
                })
                .map_err(|error| Error::from_reason(format!("Query Tag relations failed: {}", error)))?;
            for row in relation_rows {
                relations.push(row.map_err(|error| {
                    Error::from_reason(format!("Decode Tag relation failed: {}", error))
                })?);
            }
            Ok((files, tags, relations, generation))
        })?;

        let tag_rows = snapshot.1;
        let relation_values = snapshot.2;
        let existing_by_name: HashMap<String, (i64, bool)> = tag_rows
            .iter()
            .filter_map(|row| {
                Some((
                    row.get("name")?.as_str()?.to_string(),
                    (
                        row.get("id")?.as_i64()?,
                        row.get("hasVector")?.as_bool()?,
                    ),
                ))
            })
            .collect();

        let extensions = HashSet::from(["md".to_string(), "txt".to_string()]);
        let folders = request.ignore_folders.iter().cloned().collect();
        let ignored = |relative: &str| !crate::knowledge_path_allowed(
            std::path::Path::new(relative), &extensions, &folders,
            &request.ignore_prefixes, &request.ignore_suffixes,
        );

        let rules = TagRules {
            tag_blacklist_super: request.tag_blacklist_super.clone(),
            tag_blacklist: request.tag_blacklist.clone(),
            max_tags: request.max_tags,
        };
        let root = std::fs::canonicalize(&request.root_path).map_err(|error| {
            Error::from_reason(format!(
                "Canonicalize Tag consistency root '{}' failed: {}",
                request.root_path, error
            ))
        })?;
        let mut files_plan = Vec::new();
        let mut expected_names = HashSet::new();
        let mut scanned = 0usize;
        let mut ignored_count = 0usize;
        let mut missing = 0usize;
        let mut add_count = 0usize;
        let mut remove_count = 0usize;
        let mut position_count = 0usize;
        let mut relation_map: HashMap<i64, Vec<(String, i64)>> = HashMap::new();
        for row in &relation_values {
            if let (Some(file_id), Some(name), Some(position)) = (
                row.get("fileId").and_then(serde_json::Value::as_i64),
                row.get("name").and_then(serde_json::Value::as_str),
                row.get("position").and_then(serde_json::Value::as_i64),
            ) {
                relation_map.entry(file_id).or_default().push((name.to_string(), position));
            }
        }

        for (file_id, relative) in snapshot.0 {
            if relative.is_empty() || std::path::Path::new(&relative).components()
                .any(|component| !matches!(component, std::path::Component::Normal(_))) {
                return Err(Error::from_reason("KNOWLEDGE_STORE_INVALID_SOURCE_PATH"));
            }
            let mut source_path = None;
            let mut source_hash = None;
            let status;
            let expected = if ignored(&relative) {
                status = "ignored";
                ignored_count += 1;
                Vec::new()
            } else {
                let path = root.join(&relative);
                if let Ok(candidate) = std::fs::canonicalize(&path) {
                    if !candidate.starts_with(&root) {
                        return Err(Error::from_reason(format!(
                            "Tag consistency file '{}' resolves outside root",
                            relative
                        )));
                    }
                }
                match std::fs::read_to_string(&path) {
                    Ok(content) => {
                        use sha2::{Digest, Sha256};
                        source_path = Some(path.to_string_lossy().into_owned());
                        source_hash = Some(format!("{:x}", Sha256::digest(content.as_bytes())));
                        status = "scanned";
                        scanned += 1;
                        extract_tags(&content, &rules)
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        source_path = Some(path.to_string_lossy().into_owned());
                        status = "missing";
                        missing += 1;
                        Vec::new()
                    }
                    Err(error) => {
                        return Err(Error::from_reason(format!(
                            "Read Tag consistency file '{}' failed: {}",
                            relative, error
                        )));
                    }
                }
            };
            let current = relation_map.get(&file_id).cloned().unwrap_or_default();
            let current_names: HashSet<String> = current.iter().map(|entry| entry.0.clone()).collect();
            let expected_set: HashSet<String> = expected.iter().cloned().collect();
            let added = expected.iter().filter(|name| !current_names.contains(*name)).count();
            let removed = current.iter().filter(|entry| !expected_set.contains(&entry.0)).count();
            let positions = expected.iter().enumerate().filter(|(index, name)| {
                current.iter().any(|entry| entry.0 == **name && entry.1 != (*index + 1) as i64)
            }).count();
            add_count += added;
            remove_count += removed;
            position_count += positions;
            for name in &expected {
                expected_names.insert(name.clone());
            }
            files_plan.push(serde_json::json!({
                "fileId": file_id,
                "path": relative,
                "status": status,
                "sourcePath": source_path,
                "sourceHash": source_hash,
                "expectedTags": expected,
                "currentTags": current.iter().map(|(name, position)| serde_json::json!({"name": name, "position": position})).collect::<Vec<_>>()
            }));
        }

        let vectorize_names: Vec<String> = {
            let mut names: Vec<String> = expected_names
                .iter()
                .filter(|name| !existing_by_name.get(*name).map(|entry| entry.1).unwrap_or(false))
                .cloned()
                .collect();
            names.sort();
            names
        };
        let orphan_tags: Vec<serde_json::Value> = tag_rows
            .iter()
            .filter_map(|row| {
                let name = row.get("name")?.as_str()?;
                (!expected_names.contains(name)).then(|| {
                    serde_json::json!({
                        "id": row.get("id").and_then(serde_json::Value::as_i64).unwrap_or(0),
                        "name": name,
                        "hasVector": row.get("hasVector").and_then(serde_json::Value::as_bool).unwrap_or(false)
                    })
                })
            })
            .collect();

        let affected_files = files_plan.iter().filter(|file| {
            let expected = file
                .get("expectedTags")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default();
            let current = file
                .get("currentTags")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default();
            let current_names: Vec<_> = current.iter()
                .map(|tag| tag.get("name").cloned().unwrap_or(serde_json::Value::Null))
                .collect();
            let positions_changed = current.iter().enumerate().any(|(index, tag)| {
                tag.get("position").and_then(serde_json::Value::as_i64)
                    != Some((index + 1) as i64)
            });
            expected != current_names || positions_changed
        }).count();
        let summary = serde_json::json!({
            "totalDatabaseFiles": files_plan.len(),
            "scannedFiles": scanned,
            "ignoredFiles": ignored_count,
            "missingFiles": missing,
            "affectedFiles": affected_files,
            "relationsToAdd": add_count,
            "relationsToRemove": remove_count,
            "positionsToUpdate": position_count,
            "vectorsToCreate": vectorize_names.len(),
            "vectorsToRemove": orphan_tags.iter().filter(|tag| tag.get("hasVector").and_then(serde_json::Value::as_bool).unwrap_or(false)).count(),
            "orphanTagsToRemove": orphan_tags.len(),
            "finalTagCount": expected_names.len()
        });
        let canonical = serde_json::json!({
            "modelSig": request.model_sig,
            "dimension": request.dimension,
            "files": files_plan,
            "vectorizeNames": vectorize_names,
            "orphanTags": orphan_tags.iter().map(|tag| tag.get("id").cloned().unwrap_or(serde_json::Value::Null)).collect::<Vec<_>>()
        });
        use sha2::{Digest, Sha256};
        let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&canonical).unwrap_or_default()));
        let now = current_time_ms();
        let expires_at = now.saturating_add(request.ttl_ms.unwrap_or(30 * 60 * 1000).clamp(1_000, 24 * 60 * 60 * 1000));
        static PLAN_SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let sequence = PLAN_SEQUENCE.fetch_add(1, Ordering::AcqRel);
        let token = format!("{:x}", Sha256::digest(format!(
            "{}:{}:{}:{}", digest, now, std::process::id(), sequence
        ).as_bytes()));
        let prepared = serde_json::json!({
            "schema": "vcp-native-tag-consistency-plan-v1",
            "token": token,
            "digest": digest,
            "createdAt": now,
            "expiresAt": expires_at,
            "dimension": request.dimension,
            "modelSig": request.model_sig,
            "files": files_plan,
            "vectorizeNames": vectorize_names,
            "orphanTags": orphan_tags,
            "summary": summary
        });
        let authoritative: ConsistencyPlan = serde_json::from_value(prepared.clone())
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let plan_json = serde_json::to_string(&authoritative)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let source_generation = snapshot.3;
        with_registered_write(&request.db_path, move |tx| {
            crate::storage::ensure_generation(tx, source_generation)?;
            tx.execute(
                "DELETE FROM kbm_prepared_plans WHERE expires_at < ?1 AND status != 'committed'",
                [now],
            ).map_err(|error| error.to_string())?;
            let count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM kbm_prepared_plans WHERE status='prepared'",
                [], |row| row.get(0),
            ).map_err(|error| error.to_string())?;
            if count >= 128 {
                return Err("KNOWLEDGE_STORE_PLAN_BUDGET_EXCEEDED".to_string());
            }
            tx.execute(
                "INSERT INTO kbm_prepared_plans(
                    token, operation_type, plan_json, database_generation,
                    status, created_at, expires_at
                 ) SELECT ?1, 'tag_consistency', ?2, CAST(value AS INTEGER),
                          'prepared', ?3, ?4
                   FROM kbm_runtime_meta WHERE key='database_generation'",
                rusqlite::params![token, plan_json, now, expires_at],
            ).map_err(|error| error.to_string())?;
            Ok(WriteReceipt {
                operation: "prepare_tag_consistency".to_string(),
                database_generation: 0, facts_changed: false,
            })
        }).map_err(Error::from_reason)?;
        serde_json::to_string(&prepared)
            .map_err(|error| Error::from_reason(format!("Encode Tag consistency plan failed: {}", error)))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[derive(Debug)]
pub struct TagConsistencySnapshotTask {
    pub(crate) db_path: String,
}

impl Task for TagConsistencySnapshotTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        crate::storage::with_registered_read_napi(&self.db_path, |connection| {
            let mut files = Vec::new();
            let mut statement = connection
                .prepare(
                    "SELECT id, path, diary_name, checksum, mtime, size \
                     FROM files ORDER BY id",
                )
                .map_err(|error| {
                    Error::from_reason(format!(
                        "Prepare Tag consistency files snapshot failed: {}",
                        error
                    ))
                })?;
            let rows = statement
                .query_map([], |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, i64>(0)?,
                        "path": row.get::<_, String>(1)?,
                        "diary_name": row.get::<_, String>(2)?,
                        "checksum": row.get::<_, String>(3)?,
                        "mtime": row.get::<_, i64>(4)?,
                        "size": row.get::<_, i64>(5)?
                    }))
                })
                .map_err(|error| {
                    Error::from_reason(format!(
                        "Query Tag consistency files snapshot failed: {}",
                        error
                    ))
                })?;
            for row in rows {
                files.push(row.map_err(|error| {
                    Error::from_reason(format!(
                        "Decode Tag consistency file snapshot failed: {}",
                        error
                    ))
                })?);
            }

            let mut tags = Vec::new();
            let mut statement = connection
                .prepare("SELECT id, name, vector IS NOT NULL FROM tags ORDER BY id")
                .map_err(|error| {
                    Error::from_reason(format!(
                        "Prepare Tag consistency tags snapshot failed: {}",
                        error
                    ))
                })?;
            let rows = statement
                .query_map([], |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, i64>(0)?,
                        "name": row.get::<_, String>(1)?,
                        "hasVector": row.get::<_, bool>(2)?
                    }))
                })
                .map_err(|error| {
                    Error::from_reason(format!(
                        "Query Tag consistency tags snapshot failed: {}",
                        error
                    ))
                })?;
            for row in rows {
                tags.push(row.map_err(|error| {
                    Error::from_reason(format!(
                        "Decode Tag consistency tag snapshot failed: {}",
                        error
                    ))
                })?);
            }

            let mut relations = Vec::new();
            let mut statement = connection
                .prepare(
                    "SELECT ft.file_id, ft.tag_id, ft.position, t.name \
                     FROM file_tags ft JOIN tags t ON t.id = ft.tag_id \
                     ORDER BY ft.file_id, ft.position, ft.tag_id",
                )
                .map_err(|error| {
                    Error::from_reason(format!(
                        "Prepare Tag consistency relation snapshot failed: {}",
                        error
                    ))
                })?;
            let rows = statement
                .query_map([], |row| {
                    Ok(serde_json::json!({
                        "fileId": row.get::<_, i64>(0)?,
                        "tagId": row.get::<_, i64>(1)?,
                        "position": row.get::<_, i64>(2)?,
                        "name": row.get::<_, String>(3)?
                    }))
                })
                .map_err(|error| {
                    Error::from_reason(format!(
                        "Query Tag consistency relation snapshot failed: {}",
                        error
                    ))
                })?;
            for row in rows {
                relations.push(row.map_err(|error| {
                    Error::from_reason(format!(
                        "Decode Tag consistency relation snapshot failed: {}",
                        error
                    ))
                })?);
            }

            serde_json::to_string(&serde_json::json!({
                "files": files,
                "tags": tags,
                "relations": relations
            }))
            .map_err(|error| {
                Error::from_reason(format!(
                    "Encode Tag consistency snapshot failed: {}",
                    error
                ))
            })
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[cfg(test)]
mod plan_protocol_tests {
    use super::*;

    #[test]
    fn damaged_existing_tag_vectors_are_prepared_and_replaced() {
        let root = std::env::temp_dir().join(format!(
            "kbm-tag-vector-review-{}-{}", std::process::id(), current_time_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("note.txt"), "Tag: Dimension, Nonfinite").unwrap();
        let db = root.join("test.sqlite").to_string_lossy().into_owned();
        let (storage, _) = crate::storage::SqliteStorageEngine::open_and_init(
            &db, crate::storage::StorageOptions::default(),
        ).unwrap();
        storage.submit_write(|tx| {
            tx.execute_batch(
                "INSERT INTO files(path,diary_name,checksum,mtime,size)
                 VALUES ('note.txt','Root','old',0,0);"
            ).map_err(|error| error.to_string())?;
            let nonfinite: Vec<u8> = [f32::NAN,0.0].iter()
                .flat_map(|value| value.to_ne_bytes()).collect();
            for (name, bytes) in [("Dimension", vec![0_u8;4]), ("Nonfinite", nonfinite)] {
                tx.execute("INSERT INTO tags(name,vector) VALUES (?1,?2)",
                    rusqlite::params![name,bytes]).map_err(|error| error.to_string())?;
            }
            Ok(WriteReceipt { operation: "fixture".into(), database_generation: 0, facts_changed: true })
        }).unwrap();
        let raw = TagConsistencyPrepareTask {
            request_json: serde_json::json!({
                "dbPath":db, "rootPath":root, "dimension":2, "modelSig":"test"
            }).to_string(),
        }.compute().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["vectorizeNames"], serde_json::json!(["Dimension","Nonfinite"]));
        let index = crate::VexusIndex::new(2,16).unwrap();
        let result: serde_json::Value = serde_json::from_str(&TagConsistencyCommitTask {
            db_path:db.clone(), plan_json:raw, tag_vectors:vec![1.0,0.0,0.0,1.0],
            global_tag_index:index.index.clone(),
            global_tag_content_revision:index.content_revision.clone(),
            memo_runtime:index.memo_runtime.clone(),
        }.compute().unwrap()).unwrap();
        assert_eq!(result["upsertedTagIds"].as_array().unwrap().len(), 2);
        assert_eq!(index.index.read().unwrap().size(), 2);
        storage.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn prepared_missing_source_cannot_delete_relations_after_reappearance() {
        let root = std::env::temp_dir().join(format!(
            "kbm-tag-reappeared-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db = root.join("test.sqlite").to_string_lossy().into_owned();
        let (storage, _) = crate::storage::SqliteStorageEngine::open_and_init(
            &db, crate::storage::StorageOptions::default(),
        ).unwrap();
        storage.submit_write(|tx| {
            tx.execute(
                "INSERT INTO files(path,diary_name,checksum,mtime,size)
                 VALUES ('reappeared.txt','test','old',0,0)", [],
            ).map_err(|error| error.to_string())?;
            tx.execute("INSERT INTO tags(name) VALUES ('Keep')", [])
                .map_err(|error| error.to_string())?;
            tx.execute(
                "INSERT INTO file_tags(file_id,tag_id,position) VALUES (1,1,0)", [],
            ).map_err(|error| error.to_string())?;
            Ok(WriteReceipt {
                operation: "fixture".to_string(), database_generation: 0, facts_changed: true,
            })
        }).unwrap();
        let raw = TagConsistencyPrepareTask {
            request_json: serde_json::json!({
                "dbPath": db, "rootPath": root, "dimension": 2, "modelSig": "test"
            }).to_string(),
        }.compute().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["files"][0]["status"], "missing");
        std::fs::write(root.join("reappeared.txt"), "Tag: Keep").unwrap();
        let generation = storage.database_generation();
        let index = crate::VexusIndex::new(2, 16).unwrap();
        let mut commit = TagConsistencyCommitTask {
            db_path: db.clone(), plan_json: raw, tag_vectors: vec![],
            global_tag_index: index.index.clone(),
            global_tag_content_revision: index.content_revision.clone(),
            memo_runtime: index.memo_runtime.clone(),
        };
        assert!(commit.compute().unwrap_err().reason.contains("SOURCE_CHANGED"));
        assert_eq!(storage.database_generation(), generation);
        let count: i64 = crate::storage::with_registered_read(&db, |connection| {
            connection.query_row("SELECT COUNT(*) FROM file_tags", [], |row| row.get(0))
                .map_err(|error| error.to_string())
        }).unwrap();
        assert_eq!(count, 1);
        storage.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn prepared_plan_is_authoritative_and_commit_is_idempotent() {
        let root = std::env::temp_dir().join(format!(
            "kbm-tag-plan-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db = root.join("test.sqlite").to_string_lossy().into_owned();
        let (storage, _) = crate::storage::SqliteStorageEngine::open_and_init(
            &db, crate::storage::StorageOptions::default(),
        ).unwrap();
        let raw = TagConsistencyPrepareTask {
            request_json: serde_json::json!({
                "dbPath": db, "rootPath": root, "dimension": 2, "modelSig": "test"
            }).to_string(),
        }.compute().unwrap();
        let index = crate::VexusIndex::new(2, 16).unwrap();
        let mut commit = TagConsistencyCommitTask {
            db_path: db.clone(), plan_json: raw.clone(), tag_vectors: vec![],
            global_tag_index: index.index.clone(),
            global_tag_content_revision: index.content_revision.clone(),
            memo_runtime: index.memo_runtime.clone(),
        };
        let first: serde_json::Value = serde_json::from_str(&commit.compute().unwrap()).unwrap();
        assert_eq!(first["factsCommitted"], true);
        let generation = storage.database_generation();
        commit.compute().unwrap();
        assert_eq!(storage.database_generation(), generation);
        let mut forged: serde_json::Value = serde_json::from_str(&raw).unwrap();
        forged["token"] = serde_json::json!("forged");
        commit.plan_json = forged.to_string();
        assert!(commit.compute().unwrap_err().reason.contains("PLAN_NOT_FOUND"));
        for terminal in ["cancelled", "expired"] {
            let raw = TagConsistencyPrepareTask {
                request_json: serde_json::json!({
                    "dbPath": db, "rootPath": root, "dimension": 2, "modelSig": "test"
                }).to_string(),
            }.compute().unwrap();
            let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
            let token = parsed["token"].as_str().unwrap().to_string();
            let status = terminal.to_string();
            storage.submit_write(move |tx| {
                tx.execute(
                    "UPDATE kbm_prepared_plans SET status=?1 WHERE token=?2",
                    rusqlite::params![status, token],
                ).map_err(|error| error.to_string())?;
                Ok(WriteReceipt {
                    operation: "test_cancel".to_string(),
                    database_generation: 0, facts_changed: false,
                })
            }).unwrap();
            commit.plan_json = raw;
            assert!(commit.compute().unwrap_err().reason.contains("EXPIRED_OR_CANCELLED"));
        }
        storage.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}