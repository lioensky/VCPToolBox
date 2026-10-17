use crate::rivermemo_topology_v3::MemoRuntime;
use crate::storage::{with_registered_write, WriteReceipt};
use napi::bindgen_prelude::*;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use usearch::Index;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConsistencyPlan {
    digest: String,
    dimension: usize,
    files: Vec<ConsistencyFile>,
    vectorize_names: Vec<String>,
    orphan_tags: Vec<OrphanTag>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConsistencyFile {
    file_id: i64,
    expected_tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
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
    pub(crate) global_tag_index: Arc<RwLock<Index>>,
    pub(crate) global_tag_content_revision: Arc<AtomicU64>,
    pub(crate) memo_runtime: Arc<MemoRuntime>,
}

impl Task for TagConsistencyCommitTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let plan: ConsistencyPlan = serde_json::from_str(&self.plan_json)
            .map_err(|error| Error::from_reason(format!("Invalid Tag consistency plan JSON: {}", error)))?;

        if plan.digest.trim().is_empty() {
            return Err(Error::from_reason(
                "Tag consistency plan requires a digest".to_string(),
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

        let digest = plan.digest.clone();
        let dimension = plan.dimension;
        let vectors = self.tag_vectors.clone();
        let details = Arc::new(Mutex::new(None));
        let details_for_write = Arc::clone(&details);

        with_registered_write(&self.db_path, move |tx| {
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
                    if old_vector.is_none() {
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
                "DELETE FROM tag_pair_similarity;
                 DELETE FROM tag_pair_similarity_status;
                 DELETE FROM tag_intrinsic_residuals;
                 DELETE FROM tag_intrinsic_residual_status;
                 DELETE FROM tagmemo_artifacts;
                 DELETE FROM rivermemo_artifacts;",
            )
            .map_err(|error| format!("Invalidate Tag derived assets failed: {}", error))?;

            details_for_write
                .lock()
                .map_err(|_| "Tag consistency details lock poisoned".to_string())?
                .replace((
                    affected_file_ids.len(),
                    removed_ids,
                    upserted_ids,
                    upserted_vectors,
                ));

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

        let total_vectors = upserted_tag_ids.len();
        let index_ready = apply_tag_index_delta(
            &self.global_tag_index,
            &self.global_tag_content_revision,
            &self.memo_runtime,
            &removed_tag_ids,
            &upserted_tag_ids,
            &upserted_vectors,
            dimension,
        );

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
    index: &Arc<RwLock<Index>>,
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

    let Ok(guard) = index.write() else {
        return false;
    };
    let required_capacity = guard
        .size()
        .saturating_add(upsert_ids.len())
        .saturating_add(1);
    if required_capacity >= guard.capacity()
        && guard.reserve(required_capacity.saturating_add(required_capacity / 2)).is_err()
    {
        return false;
    }

    for id in remove_ids {
        let _ = guard.remove(*id as u64);
    }
    for (position, id) in upsert_ids.iter().enumerate() {
        let start = position.saturating_mul(dimension);
        let end = start.saturating_add(dimension);
        let vector = &upsert_vectors[start..end];
        let _ = guard.remove(*id as u64);
        if guard.add(*id as u64, vector).is_err() {
            return false;
        }
    }
    drop(guard);

    content_revision.fetch_add(1, Ordering::AcqRel);
    memo_runtime.clear().is_ok()
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