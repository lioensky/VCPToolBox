use crate::storage::{with_registered_read, with_registered_write, WriteReceipt};
use napi::bindgen_prelude::*;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, RwLock};
use usearch::Index;

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiaryIndexDelta {
    pub(crate) removed_chunk_ids: Vec<i64>,
    pub(crate) upserted_chunk_ids: Vec<i64>,
}

#[derive(Debug, Serialize)]
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
    pub(crate) facts_committed: bool,
    pub(crate) index_ready: bool,
}

pub struct IngestionCommitTask {
    pub(crate) db_path: String,
    pub(crate) plan_json: String,
    pub(crate) chunk_vectors: Vec<f32>,
    pub(crate) tag_vectors: Vec<f32>,
    pub(crate) diary_indices: HashMap<String, (Arc<RwLock<Index>>, u32)>,
    pub(crate) global_tag_index: Arc<RwLock<Index>>,
}

impl Task for IngestionCommitTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let plan: IngestionPlan = serde_json::from_str(&self.plan_json).map_err(|error| {
            Error::from_reason(format!("Invalid ingestion plan JSON: {}", error))
        })?;

        validate_plan(&plan, &self.chunk_vectors, &self.tag_vectors)?;

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

        let index_ready = apply_committed_index_deltas(
            &plan,
            &self.chunk_vectors,
            &self.tag_vectors,
            &details,
            &self.diary_indices,
            &self.global_tag_index,
        )
        .map_err(Error::from_reason)?;

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
    plan: &IngestionPlan,
    chunk_vectors: &[f32],
    tag_vectors: &[f32],
    details: &CommitDetails,
    diary_indices: &HashMap<String, (Arc<RwLock<Index>>, u32)>,
    global_tag_index: &Arc<RwLock<Index>>,
) -> std::result::Result<bool, String> {
    let mut ready = true;

    for (diary_name, delta) in &details.diary_index_deltas {
        let Some((index, dimension)) = diary_indices.get(diary_name) else {
            ready = false;
            continue;
        };
        let dimension = *dimension as usize;
        let guard = index
            .write()
            .map_err(|_| format!("Diary index '{}' write lock poisoned", diary_name))?;

        for id in &delta.removed_chunk_ids {
            let _ = guard.remove(*id as u64);
        }

        for receipt in details
            .upserted_chunks
            .iter()
            .filter(|entry| entry.diary_name == *diary_name)
        {
            let Some(slot) = receipt.vector_slot else {
                ready = false;
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
            let vector = &chunk_vectors[start..end];
            if guard.size() + 1 >= guard.capacity() {
                guard
                    .reserve((guard.size() + 1).saturating_mul(3) / 2)
                    .map_err(|error| {
                        format!("Grow diary index '{}' failed: {:?}", diary_name, error)
                    })?;
            }
            let _ = guard.remove(receipt.chunk_id as u64);
            guard.add(receipt.chunk_id as u64, vector).map_err(|error| {
                format!(
                    "Apply diary index '{}' chunk {} failed: {:?}",
                    diary_name, receipt.chunk_id, error
                )
            })?;
        }
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
        let guard = global_tag_index
            .write()
            .map_err(|_| "Global Tag index write lock poisoned".to_string())?;
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
            if guard.size() + 1 >= guard.capacity() {
                guard
                    .reserve((guard.size() + 1).saturating_mul(3) / 2)
                    .map_err(|error| format!("Grow global Tag index failed: {:?}", error))?;
            }
            let _ = guard.remove(id as u64);
            guard
                .add(id as u64, &tag_vectors[start..end])
                .map_err(|error| format!("Apply global Tag index {} failed: {:?}", id, error))?;
        }
    }

    Ok(ready)
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

struct CommitDetails {
    affected_files: Vec<i64>,
    removed_chunk_ids: Vec<i64>,
    upserted_chunk_ids: Vec<i64>,
    upserted_chunks: Vec<IngestionChunkReceipt>,
    affected_diaries: Vec<String>,
    diary_index_deltas: HashMap<String, DiaryIndexDelta>,
    new_tag_ids: Vec<i64>,
    new_tag_names: Vec<String>,
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

fn commit_plan(
    tx: &rusqlite::Transaction<'_>,
    plan: &IngestionPlan,
    chunk_vectors: &[f32],
    tag_vectors: &[f32],
    committed_details: Arc<Mutex<Option<CommitDetails>>>,
) -> std::result::Result<WriteReceipt, String> {
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
                .prepare("SELECT id FROM chunks WHERE file_id = ?1 ORDER BY id")
                .map_err(|error| format!("prepare old chunk lookup failed: {}", error))?;
            let rows = old_chunks
                .query_map([id], |row| row.get::<_, i64>(0))
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
            tx.execute("DELETE FROM chunks WHERE file_id = ?1", [id])
                .map_err(|error| format!("delete old chunks failed: {}", error))?;
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

        let reused_vectors = if let Some(source_file_id) = file.migration_source_file_id {
            let mut statement = tx.prepare(
                "SELECT chunk_index, vector
                 FROM chunks
                 WHERE file_id = ?1
                   AND vector IS NOT NULL
                   AND length(vector) = ?2
                 ORDER BY chunk_index"
            ).map_err(|error| format!("Prepare live migration vector read failed: {}", error))?;
            let rows = statement.query_map(
                params![source_file_id, (plan.dimension * 4) as i64],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
            ).map_err(|error| format!("Query live migration vectors failed: {}", error))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|error| format!("Decode live migration vectors failed: {}", error))?
        } else if let Some(cache_id) = file.migration_cache_id {
            let mut statement = tx.prepare(
                "SELECT chunk_index, vector
                 FROM migration_deleted_chunks
                 WHERE cache_file_id = ?1
                   AND length(vector) = ?2
                 ORDER BY chunk_index"
            ).map_err(|error| format!("Prepare tombstone vector read failed: {}", error))?;
            let rows = statement.query_map(
                params![cache_id, (plan.dimension * 4) as i64],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
            ).map_err(|error| format!("Query tombstone vectors failed: {}", error))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|error| format!("Decode tombstone vectors failed: {}", error))?
        } else {
            Vec::new()
        };
        let reuse_requested =
            file.migration_source_file_id.is_some() || file.migration_cache_id.is_some();
        if reuse_requested && reused_vectors.len() != file.chunk_count {
            return Err(format!(
                "Migration reuse vector count mismatch for '{}': expected {}, got {}",
                file.path, file.chunk_count, reused_vectors.len()
            ));
        }

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
    committed_details
        .lock()
        .map_err(|_| "Ingestion commit details lock poisoned".to_string())?
        .replace(CommitDetails {
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
        });

    Ok(WriteReceipt {
        operation: "commit_ingestion_batch".to_string(),
        database_generation: 0,
        facts_changed: true,
    })
}

fn apply_deleted_index_deltas(
    diary_index_deltas: &HashMap<String, DiaryIndexDelta>,
    diary_indices: &HashMap<String, Arc<RwLock<Index>>>,
) -> bool {
    let mut ready = true;

    for (diary_name, delta) in diary_index_deltas {
        let Some(index) = diary_indices.get(diary_name) else {
            ready = false;
            continue;
        };

        let Ok(guard) = index.write() else {
            ready = false;
            continue;
        };

        for chunk_id in &delta.removed_chunk_ids {
            if guard.remove(*chunk_id as u64).is_err() {
                ready = false;
            }
        }
    }

    ready
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
    pub(crate) db_path: String,
    pub(crate) file_paths: Vec<String>,
    pub(crate) ttl_ms: i64,
    pub(crate) diary_indices: HashMap<String, Arc<RwLock<Index>>>,
}

impl Task for DeleteCommitTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let paths = self.file_paths.clone();
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

        let index_ready =
            apply_deleted_index_deltas(&diary_index_deltas, &self.diary_indices);

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
        let mut affected_diaries = HashSet::new();
        for (file_id, relative_path, diary_name) in file_rows {
            let candidate = root_path.join(&relative_path);
            let exists = std::fs::metadata(&candidate)
                .map(|metadata| metadata.is_file())
                .unwrap_or(false);
            if !exists {
                missing_files.push(file_id);
                affected_diaries.insert(diary_name);
            }
        }

        let missing_files_for_write = missing_files.clone();
        let affected_diaries_for_write = Arc::new(Mutex::new(None));
        let affected_diaries_for_write_ref = Arc::clone(&affected_diaries_for_write);
        let _receipt = with_registered_write(&self.db_path, move |tx| {
            let orphan_chunks;
            let orphan_file_tags;

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

            affected_diaries_for_write_ref
                .lock()
                .map_err(|_| "Orphan cleanup details lock poisoned".to_string())?
                .replace((orphan_chunks, orphan_file_tags));
            Ok(WriteReceipt {
                operation: "cleanup_database_orphans".to_string(),
                database_generation: 0,
                facts_changed: !missing_files_for_write.is_empty()
                    || orphan_chunks > 0
                    || orphan_file_tags > 0,
            })
        })
        .map_err(Error::from_reason)?;

        let (orphan_chunks, orphan_file_tags) = affected_diaries_for_write
            .lock()
            .map_err(|_| Error::from_reason("Orphan cleanup details lock poisoned"))?
            .take()
            .ok_or_else(|| Error::from_reason("Orphan cleanup completed without details"))?;

        let mut affected_diaries: Vec<String> = affected_diaries.into_iter().collect();
        affected_diaries.sort();
        serde_json::to_string(&OrphanCleanupResult {
            missing_files: missing_files.len(),
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
