use crate::storage::{with_registered_read, with_registered_write, WriteReceipt};
use napi::bindgen_prelude::*;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IngestionFileProbe {
    path: String,
    exists: bool,
    checksum: Option<String>,
    mtime: Option<i64>,
    size: Option<i64>,
    version: u64,
    chunk_count: i64,
    valid_vector_count: i64,
    complete_vectors: bool,
    tag_count: i64,
    valid_tag_vector_count: i64,
    complete_tags: bool,
}

pub struct FileMetadataRefreshTask {
    pub(crate) db_path: String,
    pub(crate) request_json: String,
}

impl Task for FileMetadataRefreshTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<String> {
        #[derive(Deserialize)]
        struct Request { path: String, checksum: String, version: u64, mtime: i64, size: i64 }
        let request: Request = serde_json::from_str(&self.request_json)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let receipt = with_registered_write(&self.db_path, move |tx| {
            let changed = tx.execute(
                "UPDATE files SET mtime=?1,size=?2
                 WHERE path=?3 AND checksum=?4 AND EXISTS(
                     SELECT 1 FROM kbm_file_versions WHERE path=?3 AND version=?5 AND exists_flag=1)",
                params![request.mtime, request.size, request.path, request.checksum, request.version as i64],
            ).map_err(|error| error.to_string())?;
            if changed != 1 {
                return Err("KNOWLEDGE_STORE_FILE_VERSION_CONFLICT".to_string());
            }
            tx.execute(
                "UPDATE kbm_file_versions SET mtime=?1,size=?2 WHERE path=?3 AND version=?4",
                params![request.mtime, request.size, request.path, request.version as i64],
            ).map_err(|error| error.to_string())?;
            Ok(WriteReceipt {
                operation: "refresh_file_metadata".to_string(),
                database_generation: 0, facts_changed: false,
            })
        }).map_err(Error::from_reason)?;
        Ok(serde_json::json!({"updated": true, "databaseGeneration": receipt.database_generation}).to_string())
    }

    fn resolve(&mut self, _env: Env, output: String) -> Result<String> { Ok(output) }
}

pub struct IngestionFileProbeTask {
    pub(crate) db_path: String,
    pub(crate) paths: Vec<String>,
    pub(crate) dimension: usize,
}

impl Task for IngestionFileProbeTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        if self.dimension == 0 || self.dimension > 32_768 {
            return Err(Error::from_reason(
                "Ingestion probe dimension is outside native limits",
            ));
        }
        let expected_bytes = self
            .dimension
            .checked_mul(std::mem::size_of::<f32>())
            .ok_or_else(|| Error::from_reason("Ingestion probe vector size overflow"))?;
        let paths = self.paths.clone();
        let rows = with_registered_read(&self.db_path, move |connection| {
            let mut output = Vec::with_capacity(paths.len());
            for path in paths {
                let row = connection
                    .query_row(
                        "SELECT f.checksum, f.mtime, f.size,
                                COALESCE(v.version, 0),
                                (SELECT COUNT(*) FROM chunks c
                                 WHERE c.file_id = f.id),
                                (SELECT COUNT(*) FROM chunks c
                                 WHERE c.file_id = f.id
                                   AND c.vector IS NOT NULL
                                   AND length(c.vector) = ?2),
                                (SELECT COUNT(*) FROM chunks c
                                 WHERE c.file_id = f.id
                                   AND c.vector IS NOT NULL),
                                (SELECT COUNT(DISTINCT ft.tag_id)
                                 FROM file_tags ft
                                 WHERE ft.file_id = f.id),
                                (SELECT COUNT(DISTINCT ft.tag_id)
                                 FROM file_tags ft
                                 JOIN tags t ON t.id = ft.tag_id
                                 WHERE ft.file_id = f.id
                                   AND t.vector IS NOT NULL
                                   AND length(t.vector) = ?2)
                         FROM files f
                         LEFT JOIN kbm_file_versions v ON v.path = f.path
                         WHERE f.path = ?1",
                        rusqlite::params![&path, expected_bytes as i64],
                        |row| {
                            let chunk_count: i64 = row.get(4)?;
                            let valid_vector_count: i64 = row.get(5)?;
                            let vector_count: i64 = row.get(6)?;
                            let tag_count: i64 = row.get(7)?;
                            let valid_tag_vector_count: i64 = row.get(8)?;
                            Ok(IngestionFileProbe {
                                path: path.clone(),
                                exists: true,
                                checksum: row.get(0)?,
                                mtime: row.get(1)?,
                                size: row.get(2)?,
                                version: row.get::<_, i64>(3)?.max(0) as u64,
                                chunk_count,
                                valid_vector_count,
                                complete_vectors: chunk_count > 0
                                    && chunk_count == vector_count
                                    && chunk_count == valid_vector_count,
                                tag_count,
                                valid_tag_vector_count,
                                complete_tags: tag_count == valid_tag_vector_count,
                            })
                        },
                    )
                    .optional()
                    .map_err(|error| format!("Probe file '{}' failed: {}", path, error))?;

                output.push(row.unwrap_or(IngestionFileProbe {
                    path: path.clone(),
                    exists: false,
                    checksum: None,
                    mtime: None,
                    size: None,
                    version: connection
                        .query_row(
                            "SELECT version FROM kbm_file_versions WHERE path = ?1",
                            [&path],
                            |row| row.get::<_, i64>(0),
                        )
                        .optional()
                        .map_err(|error| {
                            format!("Read missing file version for '{}' failed: {}", path, error)
                        })?
                        .unwrap_or(0)
                        .max(0) as u64,
                    chunk_count: 0,
                    valid_vector_count: 0,
                    complete_vectors: false,
                    tag_count: 0,
                    valid_tag_vector_count: 0,
                    complete_tags: false,
                }));
            }
            Ok(output)
        })
        .map_err(Error::from_reason)?;

        serde_json::to_string(&rows)
            .map_err(|error| Error::from_reason(format!("Encode ingestion probe failed: {}", error)))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IngestionTagProbe {
    name: String,
    id: Option<i64>,
    has_vector: bool,
}

pub struct IngestionTagProbeTask {
    pub(crate) db_path: String,
    pub(crate) names: Vec<String>,
    pub(crate) dimension: usize,
}

impl Task for IngestionTagProbeTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        if self.dimension == 0 || self.dimension > 32_768 {
            return Err(Error::from_reason(
                "Ingestion Tag probe dimension is outside native limits",
            ));
        }
        let expected_bytes = self
            .dimension
            .checked_mul(std::mem::size_of::<f32>())
            .ok_or_else(|| Error::from_reason("Ingestion Tag probe vector size overflow"))?;
        let names = self.names.clone();
        let rows = with_registered_read(&self.db_path, move |connection| {
            let mut output = Vec::with_capacity(names.len());
            let mut statement = connection
                .prepare(
                    "SELECT id, vector FROM tags WHERE name = ?1",
                )
                .map_err(|error| format!("Prepare Tag probe failed: {}", error))?;

            for name in names {
                let row = statement
                    .query_row([&name], |row| {
                        let vector: Option<Vec<u8>> = row.get(1)?;
                        Ok(IngestionTagProbe {
                            name: name.clone(),
                            id: Some(row.get(0)?),
                            has_vector: vector
                                .as_ref()
                                .map(|value| value.len() == expected_bytes)
                                .unwrap_or(false),
                        })
                    })
                    .optional()
                    .map_err(|error| format!("Probe Tag '{}' failed: {}", name, error))?;

                output.push(row.unwrap_or(IngestionTagProbe {
                    name,
                    id: None,
                    has_vector: false,
                }));
            }
            Ok(output)
        })
        .map_err(Error::from_reason)?;

        serde_json::to_string(&rows).map_err(|error| {
            Error::from_reason(format!("Encode Tag probe failed: {}", error))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MigrationReuseCandidate {
    path: String,
    live_file_id: Option<i64>,
    migration_cache_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MigrationReuseRequest {
    path: String,
    checksum: String,
    size: i64,
    chunk_count: usize,
}

pub struct MigrationReuseProbeTask {
    pub(crate) db_path: String,
    pub(crate) requests_json: String,
    pub(crate) dimension: usize,
}

impl Task for MigrationReuseProbeTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let requests: Vec<MigrationReuseRequest> =
            serde_json::from_str(&self.requests_json)
                .map_err(|error| Error::from_reason(format!(
                    "Invalid migration reuse request JSON: {}",
                    error
                )))?;
        let expected_bytes = self.dimension.checked_mul(4).ok_or_else(|| {
            Error::from_reason("Migration reuse vector size overflow")
        })?;
        let rows = with_registered_read(&self.db_path, move |connection| {
            let mut output = Vec::with_capacity(requests.len());
            for request in requests {
                let live_file_id: Option<i64> = {
                    let mut statement = connection.prepare(
                        "SELECT f.id
                         FROM files f
                         WHERE f.checksum = ?1
                           AND f.size = ?2
                           AND f.path <> ?3
                         ORDER BY f.updated_at DESC, f.id DESC
                         LIMIT 5"
                    ).map_err(|error| format!("Prepare live migration lookup failed: {}", error))?;
                    let candidates = statement.query_map(
                        params![&request.checksum, request.size, &request.path],
                        |row| row.get::<_, i64>(0)
                    ).map_err(|error| format!("Query live migration candidates failed: {}", error))?;
                    let mut found = None;
                    for candidate in candidates {
                        let file_id = candidate.map_err(|error| format!(
                            "Decode live migration candidate failed: {}",
                            error
                        ))?;
                        let mut vector_statement = connection.prepare(
                            "SELECT chunk_index
                             FROM chunks
                             WHERE file_id = ?1
                               AND vector IS NOT NULL
                               AND length(vector) = ?2
                             ORDER BY chunk_index ASC"
                        ).map_err(|error| {
                            format!("Prepare live migration vector validation failed: {}", error)
                        })?;
                        let indices = vector_statement.query_map(
                            params![file_id, expected_bytes as i64],
                            |row| row.get::<_, i64>(0)
                        ).map_err(|error| {
                            format!("Query live migration vector indices failed: {}", error)
                        })?;
                        let mut valid = true;
                        let mut count = 0usize;
                        for (expected_index, index) in indices.enumerate() {
                            let index = index.map_err(|error| {
                                format!("Decode live migration vector index failed: {}", error)
                            })?;
                            if index != expected_index as i64 {
                                valid = false;
                                break;
                            }
                            count += 1;
                        }
                        if valid && count == request.chunk_count {
                            found = Some(file_id);
                            break;
                        }
                    }
                    found
                };

                if let Some(file_id) = live_file_id {
                    output.push(MigrationReuseCandidate {
                        path: request.path,
                        live_file_id: Some(file_id),
                        migration_cache_id: None,
                    });
                    continue;
                }

                let migration_cache_id: Option<i64> = {
                    let mut statement = connection.prepare(
                        "SELECT id
                         FROM migration_deleted_files
                         WHERE checksum = ?1
                           AND size = ?2
                           AND old_path <> ?3
                           AND chunk_count = ?4
                           AND expires_at >= ?5
                         ORDER BY deleted_at DESC, id DESC
                         LIMIT 5"
                    ).map_err(|error| {
                        format!("Prepare migration tombstone candidates failed: {}", error)
                    })?;
                    let candidates = statement.query_map(
                        params![
                            &request.checksum,
                            request.size,
                            &request.path,
                            request.chunk_count as i64,
                            current_time_ms()
                        ],
                        |row| row.get::<_, i64>(0)
                    ).map_err(|error| {
                        format!("Query migration tombstone candidates failed: {}", error)
                    })?;
                    let mut found = None;
                    for candidate in candidates {
                        let cache_id = candidate.map_err(|error| {
                            format!("Decode migration tombstone candidate failed: {}", error)
                        })?;
                        let mut vector_statement = connection.prepare(
                            "SELECT chunk_index
                             FROM migration_deleted_chunks
                             WHERE cache_file_id = ?1
                               AND length(vector) = ?2
                             ORDER BY chunk_index ASC"
                        ).map_err(|error| {
                            format!("Prepare tombstone vector validation failed: {}", error)
                        })?;
                        let indices = vector_statement.query_map(
                            params![cache_id, expected_bytes as i64],
                            |row| row.get::<_, i64>(0)
                        ).map_err(|error| {
                            format!("Query tombstone vector indices failed: {}", error)
                        })?;
                        let mut valid = true;
                        let mut count = 0usize;
                        for (expected_index, index) in indices.enumerate() {
                            let index = index.map_err(|error| {
                                format!("Decode tombstone vector index failed: {}", error)
                            })?;
                            if index != expected_index as i64 {
                                valid = false;
                                break;
                            }
                            count += 1;
                        }
                        if valid && count == request.chunk_count {
                            found = Some(cache_id);
                            break;
                        }
                    }
                    found
                };

                output.push(MigrationReuseCandidate {
                    path: request.path,
                    live_file_id: None,
                    migration_cache_id,
                });
            }
            Ok(output)
        }).map_err(Error::from_reason)?;

        serde_json::to_string(&rows).map_err(|error| Error::from_reason(format!(
            "Encode migration reuse candidates failed: {}",
            error
        )))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IngestionPlan {
    pub(crate) operation_id: String,
    pub(crate) batch_id: String,
    pub(crate) dimension: usize,
    pub(crate) model_sig: String,
    #[serde(default)]
    pub(crate) created_at: Option<i64>,
    #[serde(default)]
    pub(crate) expires_at: Option<i64>,
    pub(crate) files: Vec<PlannedFile>,
    pub(crate) chunks: Vec<PlannedChunk>,
    pub(crate) tags: Vec<PlannedTag>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlannedFile {
    pub(crate) path: String,
    pub(crate) diary_name: String,
    pub(crate) checksum: String,
    pub(crate) mtime: i64,
    pub(crate) expected_version: u64,
    pub(crate) size: i64,
    pub(crate) chunk_start: usize,
    pub(crate) chunk_count: usize,
    pub(crate) tag_start: usize,
    pub(crate) tag_count: usize,
    #[serde(default)]
    pub(crate) tags_only: bool,
    pub(crate) migration_cache_id: Option<i64>,
    pub(crate) migration_source_file_id: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlannedChunk {
    pub(crate) content: String,
    pub(crate) chunk_index: i64,
    pub(crate) vector_slot: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlannedTag {
    pub(crate) name: String,
    pub(crate) position: i64,
    pub(crate) vector_slot: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiaryIndexDelta {
    pub(crate) removed_chunk_ids: Vec<i64>,
    pub(crate) upserted_chunk_ids: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IngestionChunkReceipt {
    pub(crate) chunk_id: i64,
    pub(crate) diary_name: String,
    pub(crate) vector_slot: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IngestionCommitResult {
    pub(crate) operation_id: String,
    pub(crate) batch_id: String,
    pub(crate) database_generation: u64,
    pub(crate) affected_files: Vec<i64>,
    pub(crate) removed_chunk_ids: Vec<i64>,
    pub(crate) upserted_chunk_ids: Vec<i64>,
    pub(crate) upserted_chunks: Vec<IngestionChunkReceipt>,
    pub(crate) affected_diaries: Vec<String>,
    pub(crate) diary_index_deltas: HashMap<String, DiaryIndexDelta>,
    pub(crate) new_tag_ids: Vec<i64>,
    pub(crate) new_tag_names: Vec<String>,
    pub(crate) retryable_files: Vec<RetryableIngestionFile>,
    pub(crate) facts_committed: bool,
    pub(crate) index_ready: bool,
}

pub struct IngestionCommitTask {
    pub(crate) db_path: String,
    pub(crate) plan_json: String,
    pub(crate) chunk_vectors: Vec<f32>,
    pub(crate) tag_vectors: Vec<f32>,
    pub(crate) diary_indices: HashMap<String, (Arc<crate::index_handle::IndexHandle>, u32)>,
    pub(crate) global_tag_index: Arc<crate::index_handle::IndexHandle>,
    pub(crate) global_tag_content_revision: Arc<std::sync::atomic::AtomicU64>,
    pub(crate) diary_revisions: HashMap<String, Arc<std::sync::atomic::AtomicU64>>,
}

impl Task for IngestionCommitTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let _publication_guard = crate::publication_gate::acquire(&self.db_path, &[String::from("*")]).map_err(Error::from_reason)?;
        let plan: IngestionPlan = serde_json::from_str(&self.plan_json).map_err(|error| {
            Error::from_reason(format!("Invalid ingestion plan JSON: {}", error))
        })?;

        validate_plan(&plan, &self.chunk_vectors, &self.tag_vectors)?;
        let plan_digest = ingestion_plan_digest(
            &self.plan_json,
            &self.chunk_vectors,
            &self.tag_vectors,
        );

        let operation_id = plan.operation_id.clone();
        let batch_id = plan.batch_id.clone();
        let plan_for_write = plan.clone();
        let db_path = self.db_path.clone();
        let chunk_vectors = self.chunk_vectors.clone();
        let tag_vectors = self.tag_vectors.clone();
        let committed_details = Arc::new(Mutex::new(None));
        let committed_details_for_write = Arc::clone(&committed_details);

        let receipt = with_registered_write(&db_path, move |tx| {
            commit_plan(
                tx,
                &plan_for_write,
                &plan_digest,
                &chunk_vectors,
                &tag_vectors,
                committed_details_for_write,
            )
        })
        .map_err(Error::from_reason)?;

        let details = committed_details
            .lock()
            .map_err(|_| Error::from_reason("Ingestion commit details lock poisoned"))?
            .take()
            .ok_or_else(|| Error::from_reason("Ingestion commit completed without details"))?;

        let affected_scopes = details
            .diary_index_deltas
            .keys()
            .map(|diary| format!("diary:{}", diary))
            .chain(
                (!details.new_tag_ids.is_empty())
                    .then(|| "global_tags".to_string())
                    .into_iter(),
            )
            .collect::<Vec<_>>();

        let scope_results = if receipt.facts_changed {
            apply_committed_index_deltas(
                &db_path, &plan, &self.chunk_vectors, &self.tag_vectors,
                &details, &self.diary_indices, &self.global_tag_index,
            )
        } else {
            HashMap::new()
        };
        let mut index_ready = if !receipt.facts_changed {
            // 历史回执不得重放差分，否则可能复活之后已删除的 chunk。
            with_registered_read(&db_path, |connection| {
                for scope in &affected_scopes {
                    let ready: bool = connection.query_row(
                        "SELECT state = 'ready' AND facts_generation = applied_generation
                         FROM kbm_index_states WHERE scope = ?1",
                        [scope],
                        |row| row.get(0),
                    ).optional().map_err(|error| error.to_string())?.unwrap_or(false);
                    if !ready {
                        return Ok(false);
                    }
                }
                Ok(true)
            }).unwrap_or(false)
        } else {
            scope_results.values().all(|result| matches!(result, Ok(true)))
        };

        if receipt.facts_changed {
            for diary in &details.affected_diaries {
                if let Some(revision) = self.diary_revisions.get(diary) {
                    revision.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                }
            }
            if !details.new_tag_ids.is_empty() {
                self.global_tag_content_revision.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                // Artifact compatibility is checked against Tag facts and derived dependencies.
                // Do not destroy unrelated in-flight observation handles on every new Tag.
            }
        }
        for scope in affected_scopes.iter().filter(|_| receipt.facts_changed) {
            let result = scope_results.get(scope);
            let applied = matches!(result, Some(Ok(true)));
            let state = if applied { "ready" } else if result.is_none() { "recovering" } else { "invalid" };
            let error = match result {
                Some(Err(error)) => Some(error.as_str()),
                Some(Ok(false)) => Some("index delta application incomplete"),
                _ => None,
            };
            if let Err(error) = set_index_state(
                &db_path, scope, state, receipt.database_generation,
                if applied { receipt.database_generation } else { 0 }, error,
            ) {
                index_ready = false;
                eprintln!("[KBM] Facts committed; index state publication failed: {}", error);
            }
        }

        drop(_publication_guard);
        if index_ready && receipt.facts_changed {
            for diary in &details.affected_diaries {
                if let (Some((index, _)), Some(revision)) =
                    (self.diary_indices.get(diary), self.diary_revisions.get(diary))
                {
                    if let Err(error) = crate::index_maintenance::maintain(
                        &db_path, Some(diary), index, revision,
                    ) {
                        eprintln!("[KBM] Diary retrieval maintenance deferred: {}", error);
                    }
                }
            }
            if !details.new_tag_ids.is_empty() {
                if let Err(error) = crate::index_maintenance::maintain(
                    &db_path, None, &self.global_tag_index, &self.global_tag_content_revision,
                ) {
                    eprintln!("[KBM] Tag retrieval maintenance deferred: {}", error);
                }
            }
        }

        let output = IngestionCommitResult {
            operation_id,
            batch_id,
            database_generation: receipt.database_generation,
            affected_files: details.affected_files,
            removed_chunk_ids: details.removed_chunk_ids,
            upserted_chunk_ids: details.upserted_chunk_ids,
            upserted_chunks: details.upserted_chunks,
            affected_diaries: details.affected_diaries,
            diary_index_deltas: details.diary_index_deltas,
            new_tag_ids: details.new_tag_ids,
            new_tag_names: details.new_tag_names,
            retryable_files: details.retryable_files,
            facts_committed: true,
            index_ready,
        };

        serde_json::to_string(&output).map_err(|error| {
            Error::from_reason(format!("Encode ingestion result failed: {}", error))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

fn validate_plan(plan: &IngestionPlan, chunk_vectors: &[f32], tag_vectors: &[f32]) -> Result<()> {
    if plan.files.len() > 2000 || plan.chunks.len() > 100_000 || plan.tags.len() > 100_000
        || plan.operation_id.len() > 256 || plan.batch_id.len() > 256
        || chunk_vectors.len().saturating_add(tag_vectors.len()) > 64 * 1024 * 1024
        || plan.chunks.iter().map(|chunk| chunk.content.len()).sum::<usize>() > 64 * 1024 * 1024
    {
        return Err(Error::from_reason("KNOWLEDGE_STORE_BATCH_BUDGET_EXCEEDED"));
    }
    if plan.operation_id.trim().is_empty() || plan.batch_id.trim().is_empty() {
        return Err(Error::from_reason(
            "Ingestion plan requires operationId and batchId".to_string(),
        ));
    }
    if plan.dimension == 0 || plan.dimension > 32_768 {
        return Err(Error::from_reason(
            "Ingestion plan dimension is outside native limits".to_string(),
        ));
    }
    if plan.model_sig.trim().is_empty() {
        return Err(Error::from_reason(
            "Ingestion plan requires modelSig".to_string(),
        ));
    }
    let expected_chunk_values = match plan
        .chunks
        .iter()
        .filter_map(|chunk| chunk.vector_slot)
        .max()
    {
        Some(slot) => slot
            .checked_add(1)
            .and_then(|count| count.checked_mul(plan.dimension))
            .ok_or_else(|| Error::from_reason("Chunk vector slot payload size overflow"))?,
        None => 0,
    };
    let expected_tag_values = match plan
        .tags
        .iter()
        .filter_map(|tag| tag.vector_slot)
        .max()
    {
        Some(slot) => slot
            .checked_add(1)
            .and_then(|count| count.checked_mul(plan.dimension))
            .ok_or_else(|| Error::from_reason("Tag vector slot payload size overflow"))?,
        None => 0,
    };
    if chunk_vectors.len() != expected_chunk_values {
        return Err(Error::from_reason(format!(
            "Chunk vector payload mismatch: expected {}, got {}",
            expected_chunk_values,
            chunk_vectors.len()
        )));
    }
    if tag_vectors.len() != expected_tag_values {
        return Err(Error::from_reason(format!(
            "Tag vector payload mismatch: expected {}, got {}",
            expected_tag_values,
            tag_vectors.len()
        )));
    }
    if chunk_vectors.iter().any(|value| !value.is_finite())
        || tag_vectors.iter().any(|value| !value.is_finite())
    {
        return Err(Error::from_reason(
            "Ingestion vector payload contains a non-finite value",
        ));
    }

    for (index, chunk) in plan.chunks.iter().enumerate() {
        if chunk.chunk_index < 0 {
            return Err(Error::from_reason(format!(
                "Ingestion Chunk {} has a negative chunk index",
                index
            )));
        }
        if let Some(slot) = chunk.vector_slot {
            let end = slot
                .checked_add(1)
                .and_then(|count| count.checked_mul(plan.dimension))
                .ok_or_else(|| Error::from_reason("Chunk vector slot is outside native limits"))?;
            if end > chunk_vectors.len() {
                return Err(Error::from_reason(format!(
                    "Ingestion Chunk {} vector slot is outside payload",
                    index
                )));
            }
        }
    }
    for (index, tag) in plan.tags.iter().enumerate() {
        if tag.name.trim().is_empty() || tag.position < 0 {
            return Err(Error::from_reason(format!(
                "Ingestion Tag {} has an invalid identity",
                index
            )));
        }
        if let Some(slot) = tag.vector_slot {
            let end = slot
                .checked_add(1)
                .and_then(|count| count.checked_mul(plan.dimension))
                .ok_or_else(|| Error::from_reason("Tag vector slot is outside native limits"))?;
            if end > tag_vectors.len() {
                return Err(Error::from_reason(format!(
                    "Ingestion Tag {} vector slot is outside payload",
                    index
                )));
            }
        }
    }

    for file in &plan.files {
        if std::path::Path::new(&file.path).components().any(|component| {
            !matches!(component, std::path::Component::Normal(_))
        }) || file.size < 0 || file.expected_version >= i64::MAX as u64 {
            return Err(Error::from_reason("KNOWLEDGE_STORE_INVALID_FILE_IDENTITY"));
        }
        if file.path.trim().is_empty()
            || file.diary_name.trim().is_empty()
            || file.checksum.trim().is_empty()
        {
            return Err(Error::from_reason(
                "Ingestion plan contains an incomplete file identity".to_string(),
            ));
        }
        if file.chunk_start.saturating_add(file.chunk_count) > plan.chunks.len()
            || file.tag_start.saturating_add(file.tag_count) > plan.tags.len()
        {
            return Err(Error::from_reason(
                "Ingestion plan file descriptor range is invalid".to_string(),
            ));
        }
    }
    Ok(())
}

fn apply_committed_index_deltas(
    db_path: &str,
    plan: &IngestionPlan,
    chunk_vectors: &[f32],
    tag_vectors: &[f32],
    details: &CommitDetails,
    diary_indices: &HashMap<String, (Arc<crate::index_handle::IndexHandle>, u32)>,
    global_tag_index: &Arc<crate::index_handle::IndexHandle>,
) -> HashMap<String, std::result::Result<bool, String>> {
    let mut results = HashMap::new();
    // A failed or nonresident diary must not prevent independent scopes from publishing.
    for (diary, delta) in &details.diary_index_deltas {
        if !diary_indices.contains_key(diary) {
            continue;
        }
        let scoped = CommitDetails {
            retryable_files: Vec::new(),
            affected_files: Vec::new(), removed_chunk_ids: Vec::new(),
            upserted_chunk_ids: Vec::new(),
            upserted_chunks: details.upserted_chunks.iter()
                .filter(|entry| entry.diary_name == *diary).cloned().collect(),
            affected_diaries: vec![diary.clone()],
            diary_index_deltas: HashMap::from([(diary.clone(), delta.clone())]),
            new_tag_ids: Vec::new(), new_tag_names: Vec::new(),
        };
        results.insert(format!("diary:{}", diary), apply_scope_index_deltas(
            db_path, plan, chunk_vectors, tag_vectors, &scoped, diary_indices, global_tag_index,
        ));
    }
    if !details.new_tag_ids.is_empty() {
        let scoped = CommitDetails {
            retryable_files: Vec::new(),
            affected_files: Vec::new(), removed_chunk_ids: Vec::new(),
            upserted_chunk_ids: Vec::new(), upserted_chunks: Vec::new(),
            affected_diaries: Vec::new(), diary_index_deltas: HashMap::new(),
            new_tag_ids: details.new_tag_ids.clone(), new_tag_names: details.new_tag_names.clone(),
        };
        results.insert("global_tags".to_string(), apply_scope_index_deltas(
            db_path, plan, chunk_vectors, tag_vectors, &scoped, diary_indices, global_tag_index,
        ));
    }
    results
}

fn apply_scope_index_deltas(
    db_path: &str,
    plan: &IngestionPlan,
    chunk_vectors: &[f32],
    tag_vectors: &[f32],
    details: &CommitDetails,
    diary_indices: &HashMap<String, (Arc<crate::index_handle::IndexHandle>, u32)>,
    global_tag_index: &Arc<crate::index_handle::IndexHandle>,
) -> std::result::Result<bool, String> {
    let mut ready = true;
    // 先完成数据库 I/O，再取得任何索引写锁，避免锁顺序倒置。
    let reused_vectors = with_registered_read(db_path, |connection| {
        let mut vectors = HashMap::new();
        let mut statement = connection.prepare("SELECT vector FROM chunks WHERE id=?1")
            .map_err(|error| error.to_string())?;
        for receipt in details.upserted_chunks.iter().filter(|entry| entry.vector_slot.is_none()) {
            let bytes = statement.query_row([receipt.chunk_id], |row| row.get::<_, Option<Vec<u8>>>(0))
                .optional().map_err(|error| error.to_string())?.flatten();
            if let Some(bytes) = bytes {
                vectors.insert(receipt.chunk_id, bytes);
            }
        }
        Ok(vectors)
    })?;

    for (diary_name, delta) in &details.diary_index_deltas {
        let Some((index, dimension)) = diary_indices.get(diary_name) else {
            ready = false;
            continue;
        };
        let dimension = *dimension as usize;
        let mut upsert_ids = Vec::new();
        let mut upsert_vectors = Vec::new();
        for receipt in details
            .upserted_chunks
            .iter()
            .filter(|entry| entry.diary_name == *diary_name)
        {
            let Some(slot) = receipt.vector_slot else {
                // NULL 是部分 Embedding 失败，不是索引中应存在的向量。
                let Some(bytes) = reused_vectors.get(&receipt.chunk_id) else { continue; };
                if bytes.len() != dimension * 4 {
                    return Err("Reused Chunk vector dimension mismatch".to_string());
                }
                let vector: Vec<f32> = bytes.chunks_exact(4)
                    .map(|value| f32::from_ne_bytes([value[0], value[1], value[2], value[3]]))
                    .collect();
                if vector.iter().any(|value| !value.is_finite()) {
                    return Err("Reused Chunk vector contains non-finite value".to_string());
                }
                upsert_ids.push(receipt.chunk_id as u64);
                upsert_vectors.extend_from_slice(&vector);
                continue;
            };
            let start = slot
                .checked_mul(dimension)
                .ok_or_else(|| "Chunk index vector slot overflow".to_string())?;
            let end = start
                .checked_add(dimension)
                .ok_or_else(|| "Chunk index vector range overflow".to_string())?;
            if end > chunk_vectors.len() {
                return Err(format!(
                    "Chunk index vector slot out of bounds for diary '{}'",
                    diary_name
                ));
            }
            upsert_ids.push(receipt.chunk_id as u64);
            upsert_vectors.extend_from_slice(&chunk_vectors[start..end]);
        }
        let removes: Vec<u64> = delta.removed_chunk_ids.iter().map(|id| *id as u64).collect();
        let mut guard = index.write()
            .map_err(|_| format!("Diary index '{}' write lock poisoned", diary_name))?;
        if guard.dimensions() != dimension {
            return Err("Diary retrieval dimension mismatch".into());
        }
        guard.apply_delta(&removes, &upsert_ids, &upsert_vectors)
            .map_err(|error| format!("Apply diary index '{}' delta failed: {}", diary_name, error))?;
    }

    let mut tag_updates = Vec::new();
    let mut tag_slots = HashMap::new();
    for tag in &plan.tags {
        if let Some(slot) = tag.vector_slot {
            tag_slots.entry(tag.name.clone()).or_insert(slot);
        }
    }
    for (id, name) in details.new_tag_ids.iter().zip(details.new_tag_names.iter()) {
        let Some(slot) = tag_slots.get(name).copied() else {
            ready = false;
            continue;
        };
        tag_updates.push((*id, slot));
    }

    if !tag_updates.is_empty() {
        let mut ids = Vec::new();
        let mut vectors = Vec::new();
        for (id, slot) in tag_updates {
            let start = slot
                .checked_mul(plan.dimension)
                .ok_or_else(|| "Tag index vector slot overflow".to_string())?;
            let end = start
                .checked_add(plan.dimension)
                .ok_or_else(|| "Tag index vector range overflow".to_string())?;
            if end > tag_vectors.len() {
                return Err("Tag index vector slot out of bounds".to_string());
            }
            ids.push(id as u64);
            vectors.extend_from_slice(&tag_vectors[start..end]);
        }
        let mut guard = global_tag_index.write()
            .map_err(|_| "Global Tag index write lock poisoned".to_string())?;
        if guard.dimensions() != plan.dimension {
            return Err("Global Tag retrieval dimension mismatch".into());
        }
        guard.apply_delta(&[], &ids, &vectors)
            .map_err(|error| format!("Apply global Tag delta failed: {}", error))?;
    }

    Ok(ready)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RetryableIngestionFile {
    path: String,
    code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitDetails {
    #[serde(default)]
    retryable_files: Vec<RetryableIngestionFile>,
    affected_files: Vec<i64>,
    removed_chunk_ids: Vec<i64>,
    upserted_chunk_ids: Vec<i64>,
    upserted_chunks: Vec<IngestionChunkReceipt>,
    affected_diaries: Vec<String>,
    diary_index_deltas: HashMap<String, DiaryIndexDelta>,
    new_tag_ids: Vec<i64>,
    new_tag_names: Vec<String>,
}

struct CommitAccumulator {
    affected_files: Vec<i64>,
    removed_chunk_ids: Vec<i64>,
    upserted_chunk_ids: Vec<i64>,
    upserted_chunks: Vec<IngestionChunkReceipt>,
    affected_diaries: HashSet<String>,
    new_tag_ids: Vec<i64>,
    new_tag_names: Vec<String>,
    diary_index_deltas: HashMap<String, DiaryIndexDelta>,
}

fn set_index_state(
    db_path: &str,
    scope: &str,
    state: &str,
    facts_generation: u64,
    applied_generation: u64,
    error_message: Option<&str>,
) -> Result<()> {
    if !matches!(state, "ready" | "invalid" | "recovering") {
        return Err(Error::from_reason(format!(
            "Invalid KBM index state '{}'",
            state
        )));
    }
    let db_path = db_path.to_string();
    let scope = scope.to_string();
    let state = state.to_string();
    let error_message = error_message.map(str::to_string);
    with_registered_write(&db_path, move |tx| {
        tx.execute(
            "INSERT INTO kbm_index_states(
                scope, state, facts_generation, applied_generation,
                error_message, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(scope) DO UPDATE SET
                state = excluded.state,
                facts_generation = excluded.facts_generation,
                applied_generation = excluded.applied_generation,
                error_message = excluded.error_message,
                updated_at = excluded.updated_at
             WHERE kbm_index_states.facts_generation = excluded.facts_generation",
            params![
                scope,
                state,
                facts_generation as i64,
                applied_generation as i64,
                error_message,
                current_time_ms()
            ],
        )
        .map_err(|error| format!("persist KBM index state failed: {}", error))?;
        Ok(WriteReceipt {
            operation: "update_index_state".to_string(),
            database_generation: 0,
            facts_changed: false,
        })
    })
    .map(|_| ())
    .map_err(Error::from_reason)
}

fn ingestion_plan_digest(
    plan_json: &str,
    chunk_vectors: &[f32],
    tag_vectors: &[f32],
) -> String {
    let canonical = serde_json::from_str::<serde_json::Value>(plan_json)
        .and_then(|value| serde_json::to_vec(&value))
        .unwrap_or_else(|_| plan_json.as_bytes().to_vec());
    let mut hasher = Sha256::new();
    hasher.update(b"kbm-ingestion-receipt-v2");
    hasher.update((canonical.len() as u64).to_le_bytes());
    hasher.update(&canonical);
    for values in [chunk_vectors, tag_vectors] {
        hasher.update((values.len() as u64).to_le_bytes());
        for value in values {
            hasher.update(value.to_le_bytes());
        }
    }
    format!("{:x}", hasher.finalize())
}

fn vector_bytes(values: &[f32], slot: usize, dimension: usize) -> Vec<u8> {
    let start = slot
        .checked_mul(dimension)
        .expect("validated vector slot multiplication must not overflow");
    let end = start
        .checked_add(dimension)
        .expect("validated vector slot range must not overflow");
    let mut bytes = Vec::with_capacity(dimension * 4);
    for value in &values[start..end] {
        bytes.extend_from_slice(&value.to_ne_bytes());
    }
    bytes
}

fn add_removed_delta(
    deltas: &mut HashMap<String, DiaryIndexDelta>,
    diary_name: String,
    chunk_ids: impl IntoIterator<Item = i64>,
) {
    let delta = deltas.entry(diary_name).or_insert_with(|| DiaryIndexDelta {
        removed_chunk_ids: Vec::new(),
        upserted_chunk_ids: Vec::new(),
    });
    delta.removed_chunk_ids.extend(chunk_ids);
}

fn add_upsert_delta(
    deltas: &mut HashMap<String, DiaryIndexDelta>,
    diary_name: String,
    chunk_id: i64,
) {
    deltas
        .entry(diary_name)
        .or_insert_with(|| DiaryIndexDelta {
            removed_chunk_ids: Vec::new(),
            upserted_chunk_ids: Vec::new(),
        })
        .upserted_chunk_ids
        .push(chunk_id);
}

fn prefetch_migration_vectors(
    connection: &rusqlite::Connection,
    file: &PlannedFile,
    dimension: usize,
) -> std::result::Result<Option<Vec<(i64, Vec<u8>)>>, String> {
    let (sql, source) = if let Some(id) = file.migration_source_file_id {
        ("SELECT c.chunk_index,c.vector FROM chunks c JOIN files f ON f.id=c.file_id
          WHERE f.id=?1 AND f.checksum=?2 AND f.size=?3 AND ?4>=0 ORDER BY c.chunk_index", id)
    } else if let Some(id) = file.migration_cache_id {
        ("SELECT c.chunk_index,c.vector FROM migration_deleted_chunks c
          JOIN migration_deleted_files f ON f.id=c.cache_file_id
          WHERE f.id=?1 AND f.checksum=?2 AND f.size=?3 AND f.expires_at>=?4
          ORDER BY c.chunk_index", id)
    } else {
        return Ok(None);
    };
    let mut statement = connection.prepare(sql).map_err(|error| error.to_string())?;
    let rows = statement.query_map(
        params![source, &file.checksum, file.size, current_time_ms()],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<Vec<u8>>>(1)?)),
    ).map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>().map_err(|error| error.to_string())?;
    if rows.len() != file.chunk_count { return Ok(None); }
    let mut vectors = Vec::with_capacity(rows.len());
    for (offset, (index, bytes)) in rows.into_iter().enumerate() {
        let Some(bytes) = bytes else { return Ok(None); };
        if index != offset as i64 || bytes.len() != dimension * 4
            || bytes.chunks_exact(4).any(|part| {
                !f32::from_ne_bytes([part[0],part[1],part[2],part[3]]).is_finite()
            })
        {
            return Ok(None);
        }
        vectors.push((index, bytes));
    }
    Ok(Some(vectors))
}

fn commit_plan(
    tx: &rusqlite::Transaction<'_>,
    plan: &IngestionPlan,
    plan_digest: &str,
    chunk_vectors: &[f32],
    tag_vectors: &[f32],
    committed_details: Arc<Mutex<Option<CommitDetails>>>,
) -> std::result::Result<WriteReceipt, String> {
    let now = current_time_ms();
    let existing_receipt: Option<(String, String, i64, String, String)> = tx
        .query_row(
            "SELECT plan_digest, status, database_generation, receipt_json, operation_type
             FROM kbm_operation_receipts
             WHERE operation_id = ?1",
            [&plan.operation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()
        .map_err(|error| format!("lookup ingestion operation receipt failed: {}", error))?;

    if let Some((stored_digest, status, database_generation, receipt_json, operation_type)) = existing_receipt {
        if operation_type != "ingestion" || stored_digest != plan_digest {
            return Err(format!(
                "KNOWLEDGE_STORE_OPERATION_DIGEST_CONFLICT: operationId '{}'",
                plan.operation_id
            ));
        }
        if status == "committed" {
            let details: CommitDetails = serde_json::from_str(&receipt_json)
                .map_err(|error| format!("decode ingestion operation receipt failed: {}", error))?;
            committed_details
                .lock()
                .map_err(|_| "Ingestion commit details lock poisoned".to_string())?
                .replace(details);
            return Ok(WriteReceipt {
                operation: "commit_ingestion_batch/idempotent".to_string(),
                database_generation: database_generation.max(0) as u64,
                facts_changed: false,
            });
        }
        return Err(format!(
            "KNOWLEDGE_STORE_OPERATION_NOT_REUSABLE: operationId '{}', status '{}'",
            plan.operation_id, status
        ));
    }

    if let (Some(created), Some(expires)) = (plan.created_at, plan.expires_at) {
        if created <= 0 || created > now || expires <= created
            || expires.saturating_sub(created) > 24 * 60 * 60 * 1000 || now >= expires
        {
            return Err("KNOWLEDGE_STORE_BATCH_EXPIRED".to_string());
        }
    } else if plan.created_at.is_some() || plan.expires_at.is_some() {
        return Err("KNOWLEDGE_STORE_INVALID_BATCH_TTL".to_string());
    }
    if plan.files.is_empty() {
        return Err("Ingestion plan requires at least one file".to_string());
    }

    let mut seen_paths = HashSet::new();
    for file in &plan.files {
        if !seen_paths.insert(file.path.clone()) {
            return Err(format!(
                "Ingestion plan contains duplicate file path '{}'",
                file.path
            ));
        }
        let current_version: i64 = tx
            .query_row(
                "SELECT version FROM kbm_file_versions WHERE path = ?1",
                [&file.path],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| {
                format!("read file version for '{}' failed: {}", file.path, error)
            })?
            .unwrap_or(0);
        if current_version.max(0) as u64 != file.expected_version {
            return Err(format!(
                "KNOWLEDGE_STORE_FILE_VERSION_CONFLICT: path '{}', expected {}, current {}",
                file.path,
                file.expected_version,
                current_version.max(0)
            ));
        }
    }

    // Freeze every reuse source before any file in this batch can delete its old chunks.
    let mut reuse_by_path = HashMap::new();
    let mut retryable_files = Vec::new();
    for file in &plan.files {
        if file.tags_only {
            let valid: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM files f WHERE f.path=?1 AND f.checksum=?2 AND f.size=?3
                   AND f.diary_name=?4
                   AND EXISTS(SELECT 1 FROM chunks c WHERE c.file_id=f.id)
                   AND NOT EXISTS(SELECT 1 FROM chunks c WHERE c.file_id=f.id
                       AND (c.vector IS NULL OR length(c.vector)!=?5)))",
                params![file.path, file.checksum, file.size, file.diary_name, (plan.dimension*4) as i64],
                |row| row.get(0),
            ).map_err(|error| error.to_string())?;
            if !valid || file.chunk_count != 0
                || file.migration_cache_id.is_some() || file.migration_source_file_id.is_some() {
                return Err("KNOWLEDGE_STORE_FILE_VERSION_CONFLICT: Tag-only source changed".to_string());
            }
        }
        if file.migration_source_file_id.is_none() && file.migration_cache_id.is_none() {
            continue;
        }
        let vectors = prefetch_migration_vectors(tx, file, plan.dimension)?;
        if let Some(vectors) = vectors {
            reuse_by_path.insert(file.path.clone(), vectors);
        } else {
            retryable_files.push(RetryableIngestionFile {
                path: file.path.clone(),
                code: "KNOWLEDGE_STORE_MIGRATION_SOURCE_CHANGED".to_string(),
            });
        }
    }
    let skipped_paths: HashSet<&str> = retryable_files.iter().map(|file| file.path.as_str()).collect();
    let retained_tag_names: HashSet<&str> = plan.files.iter()
        .filter(|file| !skipped_paths.contains(file.path.as_str()))
        .flat_map(|file| plan.tags[file.tag_start..file.tag_start + file.tag_count].iter())
        .map(|tag| tag.name.as_str()).collect();

    let mut accumulator = CommitAccumulator {
        affected_files: Vec::new(),
        removed_chunk_ids: Vec::new(),
        upserted_chunk_ids: Vec::new(),
        upserted_chunks: Vec::new(),
        affected_diaries: HashSet::new(),
        diary_index_deltas: HashMap::new(),
        new_tag_ids: Vec::new(),
        new_tag_names: Vec::new(),
    };

    let mut tag_ids: HashMap<String, i64> = HashMap::new();
    {
        let mut statement = tx
            .prepare("SELECT id FROM tags WHERE name = ?1")
            .map_err(|error| format!("prepare existing Tag lookup failed: {}", error))?;
        for tag in &plan.tags {
            if !retained_tag_names.contains(tag.name.as_str()) { continue; }
            if tag_ids.contains_key(&tag.name) {
                continue;
            }
            let existing: Option<i64> = statement
                .query_row([&tag.name], |row| row.get(0))
                .optional()
                .map_err(|error| format!("lookup Tag failed: {}", error))?;
            if let Some(id) = existing {
                tag_ids.insert(tag.name.clone(), id);
            }
        }
    }

    for tag in &plan.tags {
        if !retained_tag_names.contains(tag.name.as_str()) { continue; }
        if tag_ids.contains_key(&tag.name) {
            continue;
        }

        tx.execute(
            "INSERT INTO tags(name, vector) VALUES (?1, NULL)",
            params![&tag.name],
        )
        .map_err(|error| format!("insert Tag '{}' placeholder failed: {}", tag.name, error))?;
        let id = tx.last_insert_rowid();
        tag_ids.insert(tag.name.clone(), id);
    }

    for tag in &plan.tags {
        if !retained_tag_names.contains(tag.name.as_str()) { continue; }
        let Some(slot) = tag.vector_slot else {
            continue;
        };
        let vector = vector_bytes(tag_vectors, slot, plan.dimension);
        let id = *tag_ids
            .get(&tag.name)
            .ok_or_else(|| format!("Tag '{}' identity was not materialized", tag.name))?;
        tx.execute(
            "UPDATE tags SET vector = ?1 WHERE id = ?2",
            params![vector, id],
        )
        .map_err(|error| format!("repair Tag '{}' vector failed: {}", tag.name, error))?;
        if !accumulator.new_tag_ids.contains(&id) {
            accumulator.new_tag_ids.push(id);
            accumulator.new_tag_names.push(tag.name.clone());
        }
    }

    for file in &plan.files {
        if skipped_paths.contains(file.path.as_str()) { continue; }
        let existing: Option<(i64, String)> = tx
            .query_row(
                "SELECT id, diary_name FROM files WHERE path = ?1",
                [&file.path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("lookup file '{}' failed: {}", file.path, error))?;

        let file_id = if let Some((id, old_diary)) = existing {
            let mut old_chunks = tx
                .prepare("SELECT id FROM chunks WHERE file_id = ?1 AND ?2=0 ORDER BY id")
                .map_err(|error| format!("prepare old chunk lookup failed: {}", error))?;
            let rows = old_chunks
                .query_map(params![id, file.tags_only as i64], |row| row.get::<_, i64>(0))
                .map_err(|error| format!("query old chunks failed: {}", error))?;
            for row in rows {
                let old_chunk_id =
                    row.map_err(|error| format!("decode old chunk ID failed: {}", error))?;
                accumulator.removed_chunk_ids.push(old_chunk_id);
                add_removed_delta(
                    &mut accumulator.diary_index_deltas,
                    old_diary.clone(),
                    [old_chunk_id],
                );
            }

            tx.execute("DELETE FROM file_tags WHERE file_id = ?1", [id])
                .map_err(|error| format!("delete old file tags failed: {}", error))?;
            if !file.tags_only {
                tx.execute("DELETE FROM chunks WHERE file_id = ?1", [id])
                    .map_err(|error| format!("delete old chunks failed: {}", error))?;
            }
            tx.execute(
                "UPDATE files SET diary_name=?1, checksum=?2, mtime=?3, size=?4, updated_at=?5 WHERE id=?6",
                params![
                    &file.diary_name,
                    &file.checksum,
                    file.mtime,
                    file.size,
                    current_time_ms(),
                    id
                ],
            )
            .map_err(|error| format!("update file '{}' failed: {}", file.path, error))?;
            accumulator.affected_diaries.insert(old_diary);
            id
        } else {
            tx.execute(
                "INSERT INTO files(path, diary_name, checksum, mtime, size, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    &file.path,
                    &file.diary_name,
                    &file.checksum,
                    file.mtime,
                    file.size,
                    current_time_ms()
                ],
            )
            .map_err(|error| format!("insert file '{}' failed: {}", file.path, error))?;
            tx.last_insert_rowid()
        };

        accumulator.affected_files.push(file_id);
        accumulator.affected_diaries.insert(file.diary_name.clone());

        tx.execute(
            "INSERT INTO kbm_file_versions(
                path, version, exists_flag, checksum, mtime, size, updated_at
             ) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6)
             ON CONFLICT(path) DO UPDATE SET
                version = excluded.version,
                exists_flag = 1,
                checksum = excluded.checksum,
                mtime = excluded.mtime,
                size = excluded.size,
                updated_at = excluded.updated_at",
            params![
                &file.path,
                file.expected_version.saturating_add(1) as i64,
                &file.checksum,
                file.mtime,
                file.size,
                current_time_ms()
            ],
        )
        .map_err(|error| format!("update file version for '{}' failed: {}", file.path, error))?;

        let reused_vectors = reuse_by_path.remove(&file.path).unwrap_or_default();

        for offset in 0..file.chunk_count {
            let chunk = &plan.chunks[file.chunk_start + offset];
            let vector = if let Some(slot) = chunk.vector_slot {
                Some(vector_bytes(chunk_vectors, slot, plan.dimension))
            } else if !reused_vectors.is_empty() {
                let (chunk_index, vector) = &reused_vectors[offset];
                if *chunk_index != chunk.chunk_index {
                    return Err(format!(
                        "Migration reuse chunk index mismatch for '{}': expected {}, got {}",
                        file.path, chunk.chunk_index, chunk_index
                    ));
                }
                Some(vector.clone())
            } else {
                None
            };
            tx.execute(
                "INSERT INTO chunks(file_id, chunk_index, content, vector)
                 VALUES (?1, ?2, ?3, ?4)",
                params![file_id, chunk.chunk_index, &chunk.content, vector],
            )
            .map_err(|error| format!("insert Chunk for '{}' failed: {}", file.path, error))?;
            let upserted_chunk_id = tx.last_insert_rowid();
            accumulator.upserted_chunk_ids.push(upserted_chunk_id);
            accumulator.upserted_chunks.push(IngestionChunkReceipt {
                chunk_id: upserted_chunk_id,
                diary_name: file.diary_name.clone(),
                vector_slot: chunk.vector_slot,
            });
            add_upsert_delta(
                &mut accumulator.diary_index_deltas,
                file.diary_name.clone(),
                upserted_chunk_id,
            );
        }

        for offset in 0..file.tag_count {
            let tag = &plan.tags[file.tag_start + offset];
            let Some(tag_id) = tag_ids.get(&tag.name).copied() else {
                continue;
            };
            tx.execute(
                "INSERT OR IGNORE INTO file_tags(file_id, tag_id, position)
                 VALUES (?1, ?2, ?3)",
                params![file_id, tag_id, tag.position],
            )
            .map_err(|error| format!("insert file Tag relation failed: {}", error))?;
        }

        if let Some(cache_id) = file.migration_cache_id {
            tx.execute(
                "DELETE FROM migration_deleted_files WHERE id = ?1",
                [cache_id],
            )
            .map_err(|error| format!("consume migration cache failed: {}", error))?;
        }
    }

    let affected_diaries = {
        let mut diaries = accumulator.affected_diaries.into_iter().collect::<Vec<_>>();
        diaries.sort();
        diaries
    };
    let details = CommitDetails {
        retryable_files,
        affected_files: accumulator.affected_files,
        removed_chunk_ids: accumulator.removed_chunk_ids,
        upserted_chunk_ids: accumulator.upserted_chunk_ids,
        upserted_chunks: accumulator.upserted_chunks,
        affected_diaries,
        diary_index_deltas: accumulator
            .diary_index_deltas
            .into_iter()
            .map(|(diary, mut delta)| {
                delta.removed_chunk_ids.sort_unstable();
                delta.removed_chunk_ids.dedup();
                delta.upserted_chunk_ids.sort_unstable();
                delta.upserted_chunk_ids.dedup();
                (diary, delta)
            })
            .collect(),
        new_tag_ids: accumulator.new_tag_ids,
        new_tag_names: accumulator.new_tag_names,
    };

    for scope in details
        .diary_index_deltas
        .keys()
        .map(|diary| format!("diary:{}", diary))
        .chain(
            (!details.new_tag_ids.is_empty())
                .then(|| "global_tags".to_string())
                .into_iter(),
        )
    {
        tx.execute(
            "INSERT INTO kbm_index_states(
                scope, state, facts_generation, applied_generation,
                error_message, updated_at
             ) VALUES (?1, 'invalid', 0, 0, ?2, ?3)
             ON CONFLICT(scope) DO UPDATE SET
                state = 'invalid',
                facts_generation = 0,
                error_message = excluded.error_message,
                updated_at = excluded.updated_at",
            params![
                scope,
                "facts committed; index delta pending",
                now
            ],
        )
        .map_err(|error| format!("persist pending KBM index state failed: {}", error))?;
    }

    let receipt_json = serde_json::to_string(&details)
        .map_err(|error| format!("encode ingestion operation receipt failed: {}", error))?;
    tx.execute(
        "INSERT INTO kbm_operation_receipts(
            operation_id, operation_type, batch_id, plan_digest, status,
            database_generation, receipt_json, created_at, expires_at
         ) VALUES (?1, 'ingestion', ?2, ?3, 'committed', 0, ?4, ?5, ?6)",
        params![
            &plan.operation_id,
            &plan.batch_id,
            plan_digest,
            receipt_json,
            now,
            now.saturating_add(30 * 60 * 1000)
        ],
    )
    .map_err(|error| format!("persist ingestion operation receipt failed: {}", error))?;
    let facts_changed = !details.affected_files.is_empty();
    committed_details
        .lock()
        .map_err(|_| "Ingestion commit details lock poisoned".to_string())?
        .replace(details);

    Ok(WriteReceipt {
        operation: "commit_ingestion_batch".to_string(),
        database_generation: 0,
        facts_changed,
    })
}

fn apply_deleted_index_deltas(
    diary_index_deltas: &HashMap<String, DiaryIndexDelta>,
    diary_indices: &HashMap<String, Arc<crate::index_handle::IndexHandle>>,
) -> HashMap<String, bool> {
    let mut results = HashMap::new();
    for (diary_name, delta) in diary_index_deltas {
        let Some(index) = diary_indices.get(diary_name) else {
            continue;
        };
        let applied = match index.write() {
            Ok(mut guard) => {
                let ids: Vec<u64> = delta.removed_chunk_ids.iter().map(|id| *id as u64).collect();
                guard.apply_delta(&ids, &[], &[]).is_ok()
            },
            Err(_) => false,
        };
        results.insert(diary_name.clone(), applied);
    }
    results
}

fn current_time_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteCommitResult {
    pub(crate) affected_files: Vec<i64>,
    pub(crate) removed_chunk_ids: Vec<i64>,
    pub(crate) diary_index_deltas: HashMap<String, DiaryIndexDelta>,
    pub(crate) database_generation: u64,
    pub(crate) facts_committed: bool,
    pub(crate) index_ready: bool,
}

pub struct DeleteCommitTask {
    pub(crate) root_path: Option<String>,
    pub(crate) db_path: String,
    pub(crate) file_paths: Vec<String>,
    pub(crate) ttl_ms: i64,
    pub(crate) diary_indices: HashMap<String, Arc<crate::index_handle::IndexHandle>>,
    pub(crate) diary_revisions: HashMap<String, Arc<std::sync::atomic::AtomicU64>>,
}

impl Task for DeleteCommitTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let _publication_guard = crate::publication_gate::acquire(&self.db_path, &[String::from("*")]).map_err(Error::from_reason)?;
        let paths = self.file_paths.clone();
        let root_path = self.root_path.clone();
        let ttl_ms = self.ttl_ms.max(0);
        let details = Arc::new(Mutex::new(None));
        let details_for_write = Arc::clone(&details);
        let receipt = with_registered_write(&self.db_path, move |tx| {
            let now = current_time_ms();
            let expires_at = now.saturating_add(ttl_ms);
            let mut affected_files = Vec::new();
            let mut removed_chunk_ids = Vec::new();
            let mut deltas: HashMap<String, DiaryIndexDelta> = HashMap::new();

            for file_path in paths {
                let relative = std::path::Path::new(&file_path);
                if relative.as_os_str().is_empty() || relative.components().any(|component| {
                    !matches!(component, std::path::Component::Normal(_))
                }) {
                    return Err("KNOWLEDGE_STORE_INVALID_FILE_PATH".to_string());
                }
                if let Some(root) = &root_path {
                    match std::fs::metadata(std::path::Path::new(root).join(relative)) {
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Ok(_) => continue, // 文件已重建，旧 unlink 不能删除新事实。
                        Err(error) => return Err(format!(
                            "KNOWLEDGE_STORE_FILE_VERIFICATION_DEFERRED: {}", error
                        )),
                    }
                }
                let file = tx
                    .query_row(
                        "SELECT id, path, diary_name, checksum, size FROM files WHERE path = ?1",
                        [&file_path],
                        |row| {
                            Ok((
                                row.get::<_, i64>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, String>(3)?,
                                row.get::<_, i64>(4)?,
                            ))
                        },
                    )
                    .optional()
                    .map_err(|error| format!("lookup deleted file failed: {}", error))?;
                let Some((file_id, old_path, diary_name, checksum, size)) = file else {
                    tx.execute(
                        "INSERT INTO kbm_file_versions(
                            path, version, exists_flag, updated_at
                         ) VALUES (?1, 1, 0, ?2)
                         ON CONFLICT(path) DO UPDATE SET
                            version=kbm_file_versions.version+1,
                            exists_flag=0, checksum=NULL, mtime=NULL, size=NULL,
                            updated_at=excluded.updated_at",
                        params![file_path, now],
                    ).map_err(|error| format!("Persist absent-path tombstone failed: {}", error))?;
                    continue;
                };

                let chunks = {
                    let mut statement = tx
                        .prepare(
                            "SELECT id, chunk_index, vector FROM chunks
                             WHERE file_id = ?1 ORDER BY chunk_index",
                        )
                        .map_err(|error| format!("prepare deleted chunk lookup failed: {}", error))?;
                    let rows = statement
                        .query_map([file_id], |row| {
                            Ok((
                                row.get::<_, i64>(0)?,
                                row.get::<_, i64>(1)?,
                                row.get::<_, Option<Vec<u8>>>(2)?,
                            ))
                        })
                        .map_err(|error| format!("query deleted chunks failed: {}", error))?;
                    rows.collect::<rusqlite::Result<Vec<_>>>()
                        .map_err(|error| format!("decode deleted chunks failed: {}", error))?
                };

                let cached_chunks: Vec<_> = chunks
                    .iter()
                    .filter_map(|(id, chunk_index, vector)| {
                        vector.as_ref().map(|value| (*id, *chunk_index, value.clone()))
                    })
                    .collect();

                if !cached_chunks.is_empty() {
                    tx.execute(
                        "INSERT INTO migration_deleted_files
                         (old_path, old_diary_name, checksum, size, chunk_count, deleted_at, expires_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                        params![
                            old_path,
                            diary_name,
                            checksum,
                            size,
                            cached_chunks.len() as i64,
                            now,
                            expires_at
                        ],
                    )
                    .map_err(|error| format!("insert deletion tombstone failed: {}", error))?;
                    let cache_id = tx.last_insert_rowid();
                    for (_, chunk_index, vector) in cached_chunks {
                        tx.execute(
                            "INSERT INTO migration_deleted_chunks
                             (cache_file_id, chunk_index, vector) VALUES (?1, ?2, ?3)",
                            params![cache_id, chunk_index, vector],
                        )
                        .map_err(|error| format!("insert deletion vector cache failed: {}", error))?;
                    }
                }

                let delta = deltas.entry(diary_name).or_insert_with(|| DiaryIndexDelta {
                    removed_chunk_ids: Vec::new(),
                    upserted_chunk_ids: Vec::new(),
                });
                for (chunk_id, _, _) in chunks {
                    removed_chunk_ids.push(chunk_id);
                    delta.removed_chunk_ids.push(chunk_id);
                }

                tx.execute("DELETE FROM file_tags WHERE file_id = ?1", [file_id])
                    .map_err(|error| format!("delete file tags failed: {}", error))?;
                tx.execute("DELETE FROM chunks WHERE file_id = ?1", [file_id])
                    .map_err(|error| format!("delete chunks failed: {}", error))?;
                tx.execute("DELETE FROM files WHERE id = ?1", [file_id])
                    .map_err(|error| format!("delete file failed: {}", error))?;

                let current_version: i64 = tx
                    .query_row(
                        "SELECT version FROM kbm_file_versions WHERE path = ?1",
                        [&old_path],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|error| {
                        format!("read deleted file version for '{}' failed: {}", old_path, error)
                    })?
                    .unwrap_or(0)
                    .max(0);
                tx.execute(
                    "INSERT INTO kbm_file_versions(
                        path, version, exists_flag, checksum, mtime, size, updated_at
                     ) VALUES (?1, ?2, 0, NULL, NULL, NULL, ?3)
                     ON CONFLICT(path) DO UPDATE SET
                        version = excluded.version,
                        exists_flag = 0,
                        checksum = NULL,
                        mtime = NULL,
                        size = NULL,
                        updated_at = excluded.updated_at",
                    params![
                        &old_path,
                        current_version.saturating_add(1),
                        now
                    ],
                )
                .map_err(|error| {
                    format!("update deleted file version for '{}' failed: {}", old_path, error)
                })?;

                affected_files.push(file_id);
            }

            for delta in deltas.values_mut() {
                delta.removed_chunk_ids.sort_unstable();
                delta.removed_chunk_ids.dedup();
            }

            for diary_name in deltas.keys() {
                tx.execute(
                    "INSERT INTO kbm_index_states(
                        scope, state, facts_generation, applied_generation,
                        error_message, updated_at
                     ) VALUES (?1, 'invalid', 0, 0, ?2, ?3)
                     ON CONFLICT(scope) DO UPDATE SET
                        state = 'invalid',
                        facts_generation = 0,
                        error_message = excluded.error_message,
                        updated_at = excluded.updated_at",
                    params![
                        format!("diary:{}", diary_name),
                        "delete facts committed; index delta pending",
                        now
                    ],
                )
                .map_err(|error| {
                    format!("persist pending deleted index state failed: {}", error)
                })?;
            }

            details_for_write
                .lock()
                .map_err(|_| "delete commit details lock poisoned".to_string())?
                .replace((affected_files, removed_chunk_ids, deltas));
            Ok(WriteReceipt {
                operation: "commit_delete_batch".to_string(),
                database_generation: 0,
                facts_changed: true,
            })
        })
        .map_err(Error::from_reason)?;

        let (affected_files, removed_chunk_ids, diary_index_deltas) = details
            .lock()
            .map_err(|_| Error::from_reason("delete commit details lock poisoned"))?
            .take()
            .ok_or_else(|| Error::from_reason("delete commit completed without details"))?;

        let index_applied =
            apply_deleted_index_deltas(&diary_index_deltas, &self.diary_indices);
        for diary in diary_index_deltas.keys() {
            if let Some(revision) = self.diary_revisions.get(diary) {
                revision.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            }
        }
        let mut index_ready = index_applied.values().all(|applied| *applied);

        for diary_name in diary_index_deltas.keys() {
            let result = index_applied.get(diary_name);
            let applied = result == Some(&true);
            let state = if applied { "ready" } else if result.is_none() { "recovering" } else { "invalid" };
            if let Err(error) = set_index_state(
                &self.db_path,
                &format!("diary:{}", diary_name),
                state,
                receipt.database_generation,
                if applied { receipt.database_generation } else { 0 },
                (result == Some(&false)).then_some("deleted index delta application failed"),
            ) {
                index_ready = false;
                eprintln!("[KBM] Delete facts committed; index state publication failed: {}", error);
            }
        }

        drop(_publication_guard);
        if index_ready {
            for diary in diary_index_deltas.keys() {
                if let (Some(index), Some(revision)) =
                    (self.diary_indices.get(diary), self.diary_revisions.get(diary))
                {
                    if let Err(error) = crate::index_maintenance::maintain(
                        &self.db_path, Some(diary), index, revision,
                    ) {
                        eprintln!("[KBM] Deleted-index maintenance deferred: {}", error);
                    }
                }
            }
        }
        serde_json::to_string(&DeleteCommitResult {
            affected_files,
            removed_chunk_ids,
            diary_index_deltas,
            database_generation: receipt.database_generation,
            facts_committed: true,
            index_ready,
        })
        .map_err(|error| Error::from_reason(format!("encode delete result failed: {}", error)))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OrphanCleanupResult {
    pub(crate) missing_files: usize,
    pub(crate) orphan_chunks: usize,
    pub(crate) orphan_file_tags: usize,
    pub(crate) affected_diaries: Vec<String>,
}

pub struct OrphanCleanupTask {
    pub(crate) db_path: String,
    pub(crate) root_path: String,
}

impl Task for OrphanCleanupTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let root_path = std::path::PathBuf::from(&self.root_path);
        let file_rows: Vec<(i64, String, String)> = with_registered_read(
            &self.db_path,
            |connection| {
                let mut statement = connection
                    .prepare("SELECT id, path, diary_name FROM files")
                    .map_err(|error| {
                        format!("Prepare orphan cleanup file scan failed: {}", error)
                    })?;
                let rows = statement
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })
                    .map_err(|error| {
                        format!("Query orphan cleanup file scan failed: {}", error)
                    })?;
                rows.collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(|error| {
                        format!("Decode orphan cleanup file scan failed: {}", error)
                    })
            },
        )
        .map_err(Error::from_reason)?;

        let mut missing_files = Vec::new();
        for (file_id, relative_path, _diary_name) in file_rows {
            let relative = std::path::Path::new(&relative_path);
            if relative.components().any(|component| {
                !matches!(component, std::path::Component::Normal(_))
            }) {
                return Err(Error::from_reason("KNOWLEDGE_STORE_INVALID_FILE_PATH"));
            }
            let candidate = root_path.join(&relative_path);
            match std::fs::metadata(&candidate) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    missing_files.push(file_id);
                }
                Ok(_) => {}
                Err(error) => return Err(Error::from_reason(format!(
                    "Orphan cleanup file verification deferred: {}", error
                ))),
            }
        }

        let _publication_guard = crate::publication_gate::acquire(&self.db_path, &[String::from("*")]).map_err(Error::from_reason)?;
        let missing_files_for_write = missing_files.clone();
        let mut invalid_diaries = HashSet::new();
        let affected_diaries_for_write = Arc::new(Mutex::new(None));
        let affected_diaries_for_write_ref = Arc::clone(&affected_diaries_for_write);
        let _receipt = with_registered_write(&self.db_path, move |tx| {
            let orphan_chunks;
            let orphan_file_tags;
            let mut deleted_files = 0usize;

            for file_id in &missing_files_for_write {
                let relative_path: String = tx
                    .query_row(
                        "SELECT path FROM files WHERE id = ?1",
                        [file_id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|error| {
                        format!("Read missing file path failed: {}", error)
                    })?
                    .unwrap_or_default();

                if relative_path.is_empty() {
                    continue;
                }
                match std::fs::metadata(root_path.join(&relative_path)) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Ok(_) => continue,
                    Err(error) => return Err(format!(
                        "Orphan cleanup final file verification deferred: {}", error
                    )),
                }
                let diary: String = tx.query_row(
                    "SELECT diary_name FROM files WHERE id=?1", [file_id], |row| row.get(0),
                ).map_err(|error| format!("Read current orphan diary failed: {}", error))?;
                invalid_diaries.insert(diary);
                tx.execute("DELETE FROM file_tags WHERE file_id = ?1", [file_id])
                    .map_err(|error| {
                        format!("Delete missing file tags failed: {}", error)
                    })?;
                tx.execute("DELETE FROM chunks WHERE file_id = ?1", [file_id])
                    .map_err(|error| {
                        format!("Delete missing file chunks failed: {}", error)
                    })?;
                tx.execute("DELETE FROM files WHERE id = ?1", [file_id])
                    .map_err(|error| {
                        format!("Delete missing file failed: {}", error)
                    })?;

                deleted_files += 1;

                if !relative_path.is_empty() {
                    let current_version: i64 = tx
                        .query_row(
                            "SELECT version FROM kbm_file_versions WHERE path = ?1",
                            [&relative_path],
                            |row| row.get(0),
                        )
                        .optional()
                        .map_err(|error| {
                            format!(
                                "Read orphan file version for '{}' failed: {}",
                                relative_path, error
                            )
                        })?
                        .unwrap_or(0)
                        .max(0);

                    tx.execute(
                        "INSERT INTO kbm_file_versions(
                            path, version, exists_flag, checksum, mtime, size, updated_at
                         ) VALUES (?1, ?2, 0, NULL, NULL, NULL, ?3)
                         ON CONFLICT(path) DO UPDATE SET
                            version = excluded.version,
                            exists_flag = 0,
                            checksum = NULL,
                            mtime = NULL,
                            size = NULL,
                            updated_at = excluded.updated_at",
                        params![
                            &relative_path,
                            current_version.saturating_add(1),
                            current_time_ms()
                        ],
                    )
                    .map_err(|error| {
                        format!(
                            "Update orphan file version for '{}' failed: {}",
                            relative_path, error
                        )
                    })?;
                }
            }

            orphan_file_tags = tx
                .query_row(
                    "SELECT COUNT(*) FROM file_tags ft
                     LEFT JOIN files f ON f.id = ft.file_id
                     LEFT JOIN tags t ON t.id = ft.tag_id
                     WHERE f.id IS NULL OR t.id IS NULL",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|error| {
                    format!("Count orphan file tags failed: {}", error)
                })?
                .max(0) as usize;
            tx.execute(
                "DELETE FROM file_tags
                 WHERE file_id NOT IN (SELECT id FROM files)
                    OR tag_id NOT IN (SELECT id FROM tags)",
                [],
            )
            .map_err(|error| format!("Delete orphan file tags failed: {}", error))?;

            orphan_chunks = tx
                .query_row(
                    "SELECT COUNT(*)
                     FROM chunks c
                     LEFT JOIN files f ON f.id = c.file_id
                     WHERE f.id IS NULL",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|error| format!("Count orphan chunks failed: {}", error))?
                .max(0) as usize;
            tx.execute(
                "DELETE FROM chunks
                 WHERE file_id NOT IN (SELECT id FROM files)",
                [],
            )
            .map_err(|error| format!("Delete orphan chunks failed: {}", error))?;

            // 事实删除和作用域失效必须属于同一事务。无归属 Chunk 无法确定
            // 曾进入哪个常驻索引，因此保守失效所有已登记日记作用域。
            for diary in &invalid_diaries {
                tx.execute(
                    "INSERT INTO kbm_index_states(scope,state,facts_generation,applied_generation,updated_at)
                     VALUES (?1,'invalid',0,0,?2)
                     ON CONFLICT(scope) DO UPDATE SET state='invalid',
                     facts_generation=0, updated_at=excluded.updated_at",
                    params![format!("diary:{}", diary), current_time_ms()],
                ).map_err(|error| format!("Invalidate orphan diary index failed: {}", error))?;
            }
            if orphan_chunks > 0 {
                tx.execute(
                    "UPDATE kbm_index_states SET state='invalid', facts_generation=0,
                     updated_at=?1 WHERE scope LIKE 'diary:%'",
                    [current_time_ms()],
                ).map_err(|error| format!("Invalidate orphan chunk indices failed: {}", error))?;
            }

            affected_diaries_for_write_ref
                .lock()
                .map_err(|_| "Orphan cleanup details lock poisoned".to_string())?
                .replace((orphan_chunks, orphan_file_tags, deleted_files, invalid_diaries));
            Ok(WriteReceipt {
                operation: "cleanup_database_orphans".to_string(),
                database_generation: 0,
                facts_changed: deleted_files > 0
                    || orphan_chunks > 0
                    || orphan_file_tags > 0,
            })
        })
        .map_err(Error::from_reason)?;

        let (orphan_chunks, orphan_file_tags, deleted_files, affected_diaries) = affected_diaries_for_write
            .lock()
            .map_err(|_| Error::from_reason("Orphan cleanup details lock poisoned"))?
            .take()
            .ok_or_else(|| Error::from_reason("Orphan cleanup completed without details"))?;

        let mut affected_diaries: Vec<String> = affected_diaries.into_iter().collect();
        affected_diaries.sort();
        serde_json::to_string(&OrphanCleanupResult {
            missing_files: deleted_files,
            orphan_chunks,
            orphan_file_tags,
            affected_diaries,
        })
        .map_err(|error| Error::from_reason(format!(
            "Encode orphan cleanup result failed: {}",
            error
        )))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}


#[cfg(test)]
mod receipt_protocol_tests {
    use super::*;

    fn empty_plan() -> IngestionPlan {
        IngestionPlan {
            operation_id: "operation".to_string(),
            batch_id: "batch".to_string(),
            dimension: 2,
            model_sig: "test".to_string(),
            created_at: None,
            expires_at: None,
            files: vec![],
            chunks: vec![],
            tags: vec![],
        }
    }

    #[test]
    fn digest_is_canonical_and_separates_vector_partitions() {
        assert_eq!(
            ingestion_plan_digest(r#"{"a":1,"b":2}"#, &[1.0], &[2.0]),
            ingestion_plan_digest(r#"{"b":2,"a":1}"#, &[1.0], &[2.0]),
        );
        assert_ne!(
            ingestion_plan_digest("{}", &[1.0], &[2.0]),
            ingestion_plan_digest("{}", &[1.0, 2.0], &[]),
        );
    }

    #[test]
    fn absent_path_tombstone_blocks_stale_ingestion_and_preserves_recreated_file() {
        let root = std::env::temp_dir().join(format!(
            "kbm-delete-protocol-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db_path = root.join("test.sqlite");
        let (storage, _) = crate::storage::SqliteStorageEngine::open_and_init(
            &db_path, crate::storage::StorageOptions::default(),
        ).unwrap();
        let mut task = DeleteCommitTask {
            root_path: Some(root.to_string_lossy().into_owned()),
            db_path: db_path.to_string_lossy().into_owned(),
            file_paths: vec!["never-indexed.txt".to_string()],
            ttl_ms: 1000,
            diary_indices: HashMap::new(),
            diary_revisions: HashMap::new(),
        };
        task.compute().unwrap();
        let version: i64 = storage.read(|connection| {
            connection.query_row(
                "SELECT version FROM kbm_file_versions WHERE path='never-indexed.txt'",
                [], |row| row.get(0),
            ).map_err(|error| error.to_string())
        }).unwrap();
        assert_eq!(version, 1);
        let mut plan = empty_plan();
        plan.files.push(PlannedFile {
            path: "never-indexed.txt".to_string(), diary_name: "Root".to_string(),
            checksum: "old".to_string(), mtime: 0, expected_version: 0, size: 1,
            chunk_start: 0, chunk_count: 0, tag_start: 0, tag_count: 0,
            tags_only: false,
            migration_cache_id: None, migration_source_file_id: None,
        });
        let error = storage.submit_write(move |tx| {
            commit_plan(tx, &plan, "digest", &[], &[], Arc::new(Mutex::new(None)))
        }).unwrap_err();
        assert!(error.contains("FILE_VERSION_CONFLICT"), "{}", error);
        std::fs::write(root.join("never-indexed.txt"), "recreated").unwrap();
        task.compute().unwrap();
        let version_after: i64 = storage.read(|connection| {
            connection.query_row(
                "SELECT version FROM kbm_file_versions WHERE path='never-indexed.txt'",
                [], |row| row.get(0),
            ).map_err(|error| error.to_string())
        }).unwrap();
        assert_eq!(version_after, 1);
        storage.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn terminal_operations_are_never_reused() {
        for status in ["cancelled", "expired", "failed"] {
            let mut connection = rusqlite::Connection::open_in_memory().unwrap();
            connection.execute_batch(
                "CREATE TABLE kbm_operation_receipts(
                    operation_id TEXT PRIMARY KEY, operation_type TEXT,
                    plan_digest TEXT, status TEXT, database_generation INTEGER,
                    receipt_json TEXT
                );"
            ).unwrap();
            connection.execute(
                "INSERT INTO kbm_operation_receipts VALUES (
                    'operation', 'ingestion', 'digest', ?1, 0, '{}'
                )",
                [status],
            ).unwrap();
            let transaction = connection.transaction().unwrap();
            let error = commit_plan(
                &transaction, &empty_plan(), "digest", &[], &[],
                Arc::new(Mutex::new(None)),
            ).unwrap_err();
            assert!(error.contains("OPERATION_NOT_REUSABLE"), "{}", error);
            let count: i64 = transaction.query_row(
                "SELECT COUNT(*) FROM kbm_operation_receipts WHERE status=?1",
                [status], |row| row.get(0),
            ).unwrap();
            assert_eq!(count, 1);
        }
    }
}


#[cfg(test)]
mod audit_orphan_tests {
    use super::*;

    #[test]
    fn cleanup_invalidates_ready_diary_and_advances_pending_generation() {
        let root = std::env::temp_dir().join(format!(
            "kbm-orphan-audit-{}-{}", std::process::id(), current_time_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db = root.join("test.sqlite").to_string_lossy().into_owned();
        let (storage, _) = crate::storage::SqliteStorageEngine::open_and_init(
            &db, crate::storage::StorageOptions::default(),
        ).unwrap();
        storage.submit_write(|tx| {
            tx.execute_batch(
                "INSERT INTO files(path,diary_name,checksum,mtime,size)
                 VALUES ('missing.txt','test','hash',0,0);
                 INSERT INTO chunks(file_id,chunk_index,content) VALUES (1,0,'gone');
                 INSERT INTO kbm_index_states VALUES ('diary:test','ready',1,1,NULL,0);"
            ).map_err(|error| error.to_string())?;
            Ok(WriteReceipt { operation: "fixture".into(), database_generation: 0, facts_changed: true })
        }).unwrap();
        OrphanCleanupTask { db_path: db.clone(), root_path: root.to_string_lossy().into_owned() }
            .compute().unwrap();
        let state: (String, i64, i64) = storage.read(|connection| {
            connection.query_row(
                "SELECT state,facts_generation,applied_generation FROM kbm_index_states WHERE scope='diary:test'",
                [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            ).map_err(|error| error.to_string())
        }).unwrap();
        assert_eq!(state, ("invalid".into(), 2, 1));
        storage.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}


#[cfg(test)]
mod scope_publication_tests {
    use super::*;

    #[test]
    fn mixed_residency_ingestion_and_delete_publish_scopes_independently() {
        let root = std::env::temp_dir().join(format!(
            "kbm-scope-publication-{}-{}", std::process::id(), current_time_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db = root.join("test.sqlite").to_string_lossy().into_owned();
        let (storage, _) = crate::storage::SqliteStorageEngine::open_and_init(
            &db, crate::storage::StorageOptions::default(),
        ).unwrap();
        let diary = crate::VexusIndex::new(2, 16).unwrap();
        let tags = crate::VexusIndex::new(2, 16).unwrap();
        let plan = serde_json::json!({
            "operationId":"mixed", "batchId":"mixed", "dimension":2, "modelSig":"test",
            "files": (["hot", "cold"].iter().enumerate().map(|(slot, name)| {
                serde_json::json!({
                    "path":format!("{}.txt", name), "diaryName":name,
                    "checksum":"hash", "mtime":1, "size":1, "expectedVersion":0,
                    "chunkStart":slot, "chunkCount":1, "tagStart":0, "tagCount":1
                })
            }).collect::<Vec<_>>()),
            "chunks":[
                {"content":"hot", "chunkIndex":0, "vectorSlot":0},
                {"content":"cold", "chunkIndex":0, "vectorSlot":1}
            ],
            "tags":[{"name":"new", "position":1, "vectorSlot":0}]
        });
        let mut task = IngestionCommitTask {
            db_path: db.clone(), plan_json: plan.to_string(),
            chunk_vectors: vec![1.0,0.0,0.0,1.0], tag_vectors: vec![1.0,0.0],
            diary_indices: HashMap::from([("hot".into(), (diary.index.clone(), 2))]),
            global_tag_index: tags.index.clone(),
            global_tag_content_revision: tags.content_revision.clone(),
            diary_revisions: HashMap::from([("hot".into(), diary.content_revision.clone())]),
        };
        let receipt: serde_json::Value = serde_json::from_str(&task.compute().unwrap()).unwrap();
        assert_eq!(receipt["indexReady"], true);
        let states = || storage.read(|connection| {
            let mut statement = connection.prepare(
                "SELECT scope,state FROM kbm_index_states ORDER BY scope"
            ).map_err(|error| error.to_string())?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            }).map_err(|error| error.to_string())?;
            rows.collect::<rusqlite::Result<HashMap<_,_>>>()
                .map_err(|error| error.to_string())
        }).unwrap();
        assert_eq!(states()["diary:hot"], "ready");
        assert_eq!(states()["diary:cold"], "recovering");
        assert_eq!(states()["global_tags"], "ready");
        assert_eq!(diary.index.read().unwrap().size(), 1);
        assert_eq!(tags.index.read().unwrap().size(), 1);
        let mut delete = DeleteCommitTask {
            root_path: None, db_path: db.clone(),
            file_paths: vec!["hot.txt".into(), "cold.txt".into()], ttl_ms: 1000,
            diary_indices: HashMap::from([("hot".into(), diary.index.clone())]),
            diary_revisions: HashMap::from([("hot".into(), diary.content_revision.clone())]),
        };
        let receipt: serde_json::Value = serde_json::from_str(&delete.compute().unwrap()).unwrap();
        assert_eq!(receipt["indexReady"], true);
        assert_eq!(states()["diary:hot"], "ready");
        assert_eq!(states()["diary:cold"], "recovering");
        assert_eq!(states()["global_tags"], "ready");
        assert_eq!(diary.index.read().unwrap().size(), 0);
        storage.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}


#[cfg(test)]
mod cold_scope_baseline_tests {
    use super::*;

    #[test]
    fn recovering_cold_diary_keeps_baseline_and_replays_delta() {
        use crate::index_lifecycle::{IndexCheckpointTask, IndexRestoreTask, IndexScope};
        let root = std::env::temp_dir().join(format!(
            "kbm-cold-baseline-{}-{}", std::process::id(), current_time_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db = root.join("test.sqlite").to_string_lossy().into_owned();
        let baseline = root.join("cold_a.vec").to_string_lossy().into_owned();
        let (storage, _) = crate::storage::SqliteStorageEngine::open_and_init(
            &db, crate::storage::StorageOptions::default(),
        ).unwrap();
        let index = crate::VexusIndex::new(2, 16).unwrap();
        storage.submit_write(|tx| {
            let vector = vector_bytes(&[1.0, 0.0], 0, 2);
            tx.execute_batch(
                "INSERT INTO files(id,path,diary_name,checksum,mtime,size)
                 VALUES (1,'cold.txt','cold','hash',1,1);"
            ).map_err(|error| error.to_string())?;
            tx.execute(
                "INSERT INTO chunks(id,file_id,chunk_index,content,vector)
                 VALUES (1,1,0,'old',?1)", [vector],
            ).map_err(|error| error.to_string())?;
            Ok(WriteReceipt { operation: "fixture".into(), database_generation: 0, facts_changed: true })
        }).unwrap();
        let mut restore = IndexRestoreTask {
            db_path: db.clone(), index_path: baseline.clone(), index: index.index.clone(),
            content_revision: index.content_revision.clone(), memo_runtime: None,
            scope: IndexScope::Diary, diary_name: Some("cold".into()),
            dimension: 2, model_sig: "test".into(), capacity: 16,
        };
        restore.compute().unwrap();
        IndexCheckpointTask {
            db_path: db.clone(), index_path: baseline, index: index.index.clone(),
            content_revision: index.content_revision.clone(), scope: IndexScope::Diary,
            diary_name: Some("cold".into()), dimension: 2, model_sig: "test".into(),
            threshold: 0.05, force: true, allow_initial: true,
        }.compute().unwrap();
        storage.submit_write(|tx| {
            tx.execute("UPDATE chunks SET vector=?1 WHERE id=1",
                [vector_bytes(&[0.0, 1.0], 0, 2)]).map_err(|error| error.to_string())?;
            tx.execute(
                "UPDATE kbm_index_states SET state='recovering',facts_generation=0
                 WHERE scope='diary:cold'", [],
            ).map_err(|error| error.to_string())?;
            Ok(WriteReceipt { operation: "cold-update".into(), database_generation: 0, facts_changed: true })
        }).unwrap();
        let receipt: serde_json::Value = serde_json::from_str(&restore.compute().unwrap()).unwrap();
        assert_eq!(receipt["rebuilt"], false);
        assert_eq!(receipt["replayed"], true);
        let guard = index.index.read().unwrap();
        crate::storage::with_registered_read_transaction(&db, |connection| {
            assert_eq!(guard.search_sql(connection, Some("cold"), &[0.0, 1.0], 1).unwrap(), vec![(1, 1.0)]);
            assert_eq!(guard.search_sql(connection, Some("cold"), &[1.0, 0.0], 1).unwrap(), vec![(1, 0.0)]);
            Ok(())
        }).unwrap();
        drop(guard);
        storage.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}


#[cfg(test)]
mod migration_source_tests {
    use super::*;

    #[test]
    fn reuse_is_frozen_before_batch_deletes_and_changed_sources_are_isolated() {
        let root = std::env::temp_dir().join(format!(
            "kbm-migration-source-{}-{}", std::process::id(), current_time_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db = root.join("test.sqlite").to_string_lossy().into_owned();
        let (storage, _) = crate::storage::SqliteStorageEngine::open_and_init(
            &db, crate::storage::StorageOptions::default(),
        ).unwrap();
        storage.submit_write(|tx| {
            tx.execute_batch(
                "INSERT INTO files(id,path,diary_name,checksum,mtime,size)
                 VALUES (1,'source.txt','test','original',1,10);"
            ).map_err(|error| error.to_string())?;
            tx.execute(
                "INSERT INTO chunks(file_id,chunk_index,content,vector) VALUES (1,0,'old',?1)",
                [vector_bytes(&[1.0,0.0], 0, 2)],
            ).map_err(|error| error.to_string())?;
            Ok(WriteReceipt { operation: "fixture".into(), database_generation: 0, facts_changed: true })
        }).unwrap();
        let plan: IngestionPlan = serde_json::from_value(serde_json::json!({
            "operationId":"freeze", "batchId":"freeze", "dimension":2, "modelSig":"test",
            "files":[
                {"path":"source.txt","diaryName":"test","checksum":"changed","mtime":2,"size":20,
                 "expectedVersion":0,"chunkStart":0,"chunkCount":1,"tagStart":0,"tagCount":0},
                {"path":"copy.txt","diaryName":"test","checksum":"original","mtime":1,"size":10,
                 "expectedVersion":0,"chunkStart":1,"chunkCount":1,"tagStart":0,"tagCount":0,
                 "migrationSourceFileId":1},
                {"path":"bad.txt","diaryName":"test","checksum":"wrong","mtime":1,"size":10,
                 "expectedVersion":0,"chunkStart":2,"chunkCount":1,"tagStart":0,"tagCount":1,
                 "migrationSourceFileId":1}
            ],
            "chunks":[
                {"content":"new","chunkIndex":0,"vectorSlot":0},
                {"content":"old","chunkIndex":0,"vectorSlot":null},
                {"content":"bad","chunkIndex":0,"vectorSlot":null}
            ],
            "tags":[{"name":"must-not-leak","position":1,"vectorSlot":null}]
        })).unwrap();
        let details = Arc::new(Mutex::new(None));
        let output = details.clone();
        storage.submit_write(move |tx| commit_plan(
            tx, &plan, "digest", &[0.0,1.0], &[], output,
        )).unwrap();
        let result = details.lock().unwrap().take().unwrap();
        assert_eq!(result.affected_files.len(), 2);
        assert_eq!(result.retryable_files.len(), 1);
        assert_eq!(result.retryable_files[0].path, "bad.txt");
        assert_eq!(result.retryable_files[0].code, "KNOWLEDGE_STORE_MIGRATION_SOURCE_CHANGED");
        storage.read(|connection| {
            let vector: Vec<u8> = connection.query_row(
                "SELECT c.vector FROM chunks c JOIN files f ON f.id=c.file_id WHERE f.path='copy.txt'",
                [], |row| row.get(0),
            ).map_err(|error| error.to_string())?;
            assert_eq!(vector, vector_bytes(&[1.0,0.0], 0, 2));
            let count: i64 = connection.query_row(
                "SELECT (SELECT COUNT(*) FROM files WHERE path='bad.txt')+(SELECT COUNT(*) FROM tags)",
                [], |row| row.get(0),
            ).map_err(|error| error.to_string())?;
            assert_eq!(count, 0);
            Ok(())
        }).unwrap();
        storage.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}


#[cfg(test)]
mod tag_only_tests {
    use super::*;

    #[test]
    fn tag_repair_preserves_chunks_and_diary_readiness_and_rejects_stale_source() {
        let root = std::env::temp_dir().join(format!(
            "kbm-tag-only-{}-{}", std::process::id(), current_time_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db = root.join("test.sqlite").to_string_lossy().into_owned();
        let (storage, _) = crate::storage::SqliteStorageEngine::open_and_init(
            &db, crate::storage::StorageOptions::default(),
        ).unwrap();
        storage.submit_write(|tx| {
            tx.execute_batch(
                "INSERT INTO files(id,path,diary_name,checksum,mtime,size)
                 VALUES (1,'repair.txt','Root','same',1,10);
                 INSERT INTO tags(id,name) VALUES (1,'missing');
                 INSERT INTO file_tags VALUES (1,1,1);
                 INSERT INTO kbm_index_states VALUES ('diary:Root','ready',1,1,NULL,0);"
            ).map_err(|error| error.to_string())?;
            tx.execute(
                "INSERT INTO chunks(id,file_id,chunk_index,content,vector) VALUES (42,1,0,'body',?1)",
                [vector_bytes(&[1.0,0.0], 0, 2)],
            ).map_err(|error| error.to_string())?;
            Ok(WriteReceipt { operation: "fixture".into(), database_generation: 0, facts_changed: true })
        }).unwrap();
        let tags = crate::VexusIndex::new(2, 16).unwrap();
        let mut plan = serde_json::json!({
            "operationId":"tag-only", "batchId":"tag-only", "dimension":2, "modelSig":"test",
            "files":[{"path":"repair.txt","diaryName":"Root","checksum":"same","mtime":1,"size":10,
                "expectedVersion":0,"chunkStart":0,"chunkCount":0,"tagStart":0,"tagCount":1,
                "tagsOnly":true}],
            "chunks":[], "tags":[{"name":"missing","position":1,"vectorSlot":0}]
        });
        let mut task = IngestionCommitTask {
            db_path: db.clone(), plan_json: plan.to_string(),
            chunk_vectors: vec![], tag_vectors: vec![0.0,1.0],
            diary_indices: HashMap::new(), global_tag_index: tags.index.clone(),
            global_tag_content_revision: tags.content_revision.clone(),
            diary_revisions: HashMap::new(),
        };
        let receipt: serde_json::Value = serde_json::from_str(&task.compute().unwrap()).unwrap();
        assert_eq!(receipt["indexReady"], true);
        assert_eq!(receipt["removedChunkIds"], serde_json::json!([]));
        assert_eq!(receipt["upsertedChunkIds"], serde_json::json!([]));
        storage.read(|connection| {
            let chunk: (i64,String,Vec<u8>) = connection.query_row(
                "SELECT id,content,vector FROM chunks WHERE file_id=1", [],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
            ).map_err(|error| error.to_string())?;
            assert_eq!(chunk, (42,"body".into(),vector_bytes(&[1.0,0.0],0,2)));
            let state: (String,i64,i64) = connection.query_row(
                "SELECT state,facts_generation,applied_generation FROM kbm_index_states WHERE scope='diary:Root'",
                [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
            ).map_err(|error| error.to_string())?;
            assert_eq!(state, ("ready".into(),1,1));
            Ok(())
        }).unwrap();
        plan["operationId"] = serde_json::json!("stale");
        plan["files"][0]["expectedVersion"] = serde_json::json!(1);
        plan["files"][0]["checksum"] = serde_json::json!("changed");
        task.plan_json = plan.to_string();
        assert!(task.compute().unwrap_err().reason.contains("FILE_VERSION_CONFLICT"));
        storage.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
