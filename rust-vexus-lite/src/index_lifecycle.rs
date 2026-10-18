use crate::save_index_snapshot;
use crate::storage::{
    with_registered_read_transaction, with_registered_write, WriteReceipt,
};
use napi::bindgen_prelude::*;
use rusqlite::OptionalExtension;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use usearch::Index;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum IndexScope {
    Diary,
    GlobalTags,
}

pub struct IndexCheckpointTask {
    pub(crate) db_path: String,
    pub(crate) index_path: String,
    pub(crate) index: Arc<RwLock<Index>>,
    pub(crate) content_revision: Arc<AtomicU64>,
    pub(crate) scope: IndexScope,
    pub(crate) diary_name: Option<String>,
    pub(crate) dimension: u32,
    pub(crate) model_sig: String,
    pub(crate) threshold: f64,
    pub(crate) force: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckpointResult {
    published: bool,
    skipped: bool,
    scope: String,
    diary_name: Option<String>,
    generation: u64,
    slot: String,
    delta: u64,
    ratio: f64,
    current_count: u64,
    baseline_count: u64,
    database_generation: u64,
    facts_committed: bool,
    index_ready: bool,
}

enum FrozenIndexEntry {
    Chunk {
        id: i64,
        signature: String,
    },
    Tag {
        id: i64,
        vector_version: i64,
    },
}

fn slot_flip(active: Option<&str>) -> &'static str {
    if active == Some("a") {
        "b"
    } else {
        "a"
    }
}

fn index_slot_path(base_path: &str, slot: &str) -> String {
    let path = std::path::Path::new(base_path);
    let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
        return base_path.to_string();
    };
    let replacement = if file_name.ends_with("_a.usearch") {
        Some(("_a.usearch", "_".to_string() + slot + ".usearch"))
    } else if file_name.ends_with("_b.usearch") {
        Some(("_b.usearch", "_".to_string() + slot + ".usearch"))
    } else {
        None
    };
    let Some((suffix, replacement)) = replacement else {
        return base_path.to_string();
    };
    let file_name = file_name
        .strip_suffix(suffix)
        .unwrap_or(file_name)
        .to_string()
        + &replacement;
    path.with_file_name(file_name)
        .to_string_lossy()
        .into_owned()
}

fn ratio(delta: u64, current: u64, baseline: u64) -> f64 {
    delta as f64 / current.max(baseline).max(1) as f64
}

pub(crate) fn checkpoint_gate() -> &'static Mutex<()> {
    static CHECKPOINT_GATE: OnceLock<Mutex<()>> = OnceLock::new();
    CHECKPOINT_GATE.get_or_init(|| Mutex::new(()))
}

fn vector_signature(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

impl Task for IndexCheckpointTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let _checkpoint_guard = checkpoint_gate()
            .lock()
            .map_err(|_| Error::from_reason("Index checkpoint gate poisoned".to_string()))?;

        if self.db_path.trim().is_empty() || self.index_path.trim().is_empty() {
            return Err(Error::from_reason(
                "Index checkpoint requires dbPath and indexPath".to_string(),
            ));
        }
        if self.dimension == 0 {
            return Err(Error::from_reason(
                "Index checkpoint dimension must be positive".to_string(),
            ));
        }
        if self.model_sig.trim().is_empty() {
            return Err(Error::from_reason(
                "Index checkpoint model signature must be non-empty".to_string(),
            ));
        }
        if !self.threshold.is_finite() || !(0.0..=1.0).contains(&self.threshold) {
            return Err(Error::from_reason(
                "Index checkpoint threshold must be finite and within [0,1]".to_string(),
            ));
        }

        let db_path = self.db_path.clone();
        let model_sig = self.model_sig.clone();
        let diary_name = self.diary_name.clone();
        let dimension = self.dimension as i64;
        let scope = self.scope;

        let (snapshot_database_generation, manifest) =
            with_registered_read_transaction(&db_path, move |connection| {
                let database_generation: i64 = connection
                    .query_row(
                        "SELECT value FROM kbm_runtime_meta \
                         WHERE key = 'database_generation'",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(|error| {
                        format!(
                            "Read checkpoint database generation failed: {}",
                            error
                        )
                    })?
                    .parse::<i64>()
                    .map_err(|error| {
                        format!(
                            "Decode checkpoint database generation failed: {}",
                            error
                        )
                    })?;

                let manifest: (
                    i64,
                    String,
                    i64,
                    i64,
                    i64,
                    i64,
                    i64,
                    Vec<FrozenIndexEntry>,
                ) = match scope {
                IndexScope::Diary => {
                    let diary = diary_name.as_deref().ok_or_else(|| {
                        "Diary checkpoint requires diaryName".to_string()
                    })?;
                    let active = connection
                        .query_row(
                            "SELECT generation, slot, dimension, model_sig, chunk_count \
                             FROM chunk_index_baselines \
                             WHERE diary_name = ?1 AND status = 'ready' \
                             ORDER BY generation DESC LIMIT 1",
                            rusqlite::params![diary],
                            |row| {
                                Ok((
                                    row.get::<_, i64>(0)?,
                                    row.get::<_, String>(1)?,
                                    row.get::<_, i64>(2)?,
                                    row.get::<_, String>(3)?,
                                    row.get::<_, i64>(4)?,
                                ))
                            },
                        )
                        .optional()
                        .map_err(|error| format!("Read diary baseline failed: {}", error))?;

                    let (
                        generation,
                        slot,
                        stored_dimension,
                        stored_model,
                        baseline_count,
                    ) = active.unwrap_or((
                        0_i64,
                        String::new(),
                        dimension,
                        model_sig.clone(),
                        0_i64,
                    ));

                    if generation > 0
                        && (stored_dimension != dimension || stored_model != model_sig)
                    {
                        return Err(format!(
                            "Diary baseline metadata mismatch: stored=({},{}), requested=({}, {})",
                            stored_dimension, stored_model, dimension, model_sig
                        ));
                    }

                    let deletes: i64 = connection
                        .query_row(
                            "SELECT COUNT(*) \
                             FROM chunk_index_baseline_entries e \
                             LEFT JOIN chunks c ON c.id = e.chunk_id \
                             LEFT JOIN files f ON f.id = c.file_id AND f.diary_name = ?1 \
                             WHERE e.diary_name = ?1 AND e.generation = ?2 \
                               AND (c.id IS NULL OR f.id IS NULL OR c.vector IS NULL)",
                            rusqlite::params![diary, generation],
                            |row| row.get(0),
                        )
                        .map_err(|error| format!("Count diary baseline deletes failed: {}", error))?;

                    let mut upsert_statement = connection
                        .prepare(
                            "SELECT c.id, c.vector, e.chunk_vector_sig
                             FROM chunks c
                             JOIN files f ON f.id = c.file_id
                             LEFT JOIN chunk_index_baseline_entries e
                               ON e.diary_name = ?1 AND e.generation = ?2 AND e.chunk_id = c.id
                             WHERE f.diary_name = ?1 AND c.vector IS NOT NULL
                             ORDER BY c.id",
                        )
                        .map_err(|error| {
                            format!("Prepare diary baseline upsert scan failed: {}", error)
                        })?;
                    let upsert_rows = upsert_statement
                        .query_map(rusqlite::params![diary, generation], |row| {
                            Ok((
                                row.get::<_, i64>(0)?,
                                row.get::<_, Vec<u8>>(1)?,
                                row.get::<_, Option<String>>(2)?,
                            ))
                        })
                        .map_err(|error| {
                            format!("Query diary baseline upsert scan failed: {}", error)
                        })?;
                    let mut upserts = 0_i64;
                    let mut frozen_entries = Vec::new();
                    for row in upsert_rows {
                        let (chunk_id, vector, baseline_signature) = row.map_err(|error| {
                            format!("Decode diary baseline upsert scan failed: {}", error)
                        })?;
                        let current_signature = vector_signature(&vector);
                        if baseline_signature.as_deref() != Some(current_signature.as_str()) {
                            upserts += 1;
                        }
                        frozen_entries.push(FrozenIndexEntry::Chunk {
                            id: chunk_id,
                            signature: current_signature,
                        });
                    }

                    let current_count: i64 = connection
                        .query_row(
                            "SELECT COUNT(*) FROM chunks c \
                             JOIN files f ON f.id = c.file_id \
                             WHERE f.diary_name = ?1 AND c.vector IS NOT NULL",
                            rusqlite::params![diary],
                            |row| row.get(0),
                        )
                        .map_err(|error| format!("Count diary current vectors failed: {}", error))?;

                    let max_generation: i64 = connection
                        .query_row(
                            "SELECT COALESCE(MAX(generation), 0) \
                             FROM chunk_index_baselines WHERE diary_name = ?1",
                            rusqlite::params![diary],
                            |row| row.get(0),
                        )
                        .map_err(|error| format!("Read diary next generation failed: {}", error))?;

                    Ok::<_, String>((
                        generation,
                        slot,
                        deletes,
                        upserts,
                        current_count,
                        baseline_count,
                        max_generation + 1,
                        frozen_entries,
                    ))
                }
                IndexScope::GlobalTags => {
                    let active_raw: Option<String> = connection
                        .query_row(
                            "SELECT value FROM kv_store WHERE key = 'tag_index_active_baseline'",
                            [],
                            |row| row.get(0),
                        )
                        .optional()
                        .map_err(|error| format!("Read Tag active baseline failed: {}", error))?;

                    let (generation, slot, baseline_count) = match active_raw {
                        None => (0_i64, String::new(), 0_i64),
                        Some(raw) => {
                            let active: serde_json::Value = serde_json::from_str(&raw)
                                .map_err(|error| {
                                    format!("Decode Tag active baseline failed: {}", error)
                                })?;
                            let generation = active
                                .get("generation")
                                .and_then(serde_json::Value::as_i64)
                                .unwrap_or(0);
                            let slot = active
                                .get("slot")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                            if generation <= 0 || !matches!(slot.as_str(), "a" | "b") {
                                (0_i64, String::new(), 0_i64)
                            } else {
                                let manifest = connection
                                    .query_row(
                                        "SELECT dimension, model_sig, tag_count \
                                         FROM tag_index_baselines \
                                         WHERE generation = ?1 AND slot = ?2 AND status = 'ready'",
                                        rusqlite::params![generation, &slot],
                                        |row| {
                                            Ok((
                                                row.get::<_, i64>(0)?,
                                                row.get::<_, String>(1)?,
                                                row.get::<_, i64>(2)?,
                                            ))
                                        },
                                    )
                                    .optional()
                                    .map_err(|error| {
                                        format!("Read Tag baseline manifest failed: {}", error)
                                    })?;
                                match manifest {
                                    Some((stored_dimension, stored_model, baseline_count)) => {
                                        if stored_dimension != dimension
                                            || stored_model != model_sig
                                        {
                                            return Err(format!(
                                                "Tag baseline metadata mismatch: stored=({},{}), requested=({}, {})",
                                                stored_dimension, stored_model, dimension, model_sig
                                            ));
                                        }
                                        (generation, slot, baseline_count)
                                    }
                                    None => (0_i64, String::new(), 0_i64),
                                }
                            }
                        }
                    };
                    let mut tag_snapshot = connection
                        .prepare(
                            "SELECT t.id, t.vector_version
                             FROM tags t
                             WHERE t.vector IS NOT NULL
                             ORDER BY t.id",
                        )
                        .map_err(|error| {
                            format!("Prepare Tag baseline snapshot failed: {}", error)
                        })?;
                    let tag_rows = tag_snapshot
                        .query_map([], |row| {
                            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
                        })
                        .map_err(|error| {
                            format!("Query Tag baseline snapshot failed: {}", error)
                        })?;
                    let mut frozen_entries = Vec::new();
                    for row in tag_rows {
                        let (tag_id, vector_version) = row.map_err(|error| {
                            format!("Decode Tag baseline snapshot failed: {}", error)
                        })?;
                        frozen_entries.push(FrozenIndexEntry::Tag {
                            id: tag_id,
                            vector_version,
                        });
                    }
                    let upserts: i64 = connection
                        .query_row(
                            "SELECT COUNT(*) FROM tags t \
                             LEFT JOIN tag_index_baseline_entries e \
                               ON e.generation = ?1 AND e.tag_id = t.id \
                             WHERE t.vector IS NOT NULL \
                               AND (e.tag_id IS NULL OR e.vector_version != t.vector_version)",
                            rusqlite::params![generation],
                            |row| row.get(0),
                        )
                        .map_err(|error| format!("Count Tag baseline upserts failed: {}", error))?;

                    let deletes: i64 = connection
                        .query_row(
                            "SELECT COUNT(*) \
                             FROM tag_index_baseline_entries e \
                             LEFT JOIN tags t ON t.id = e.tag_id AND t.vector IS NOT NULL \
                             WHERE e.generation = ?1 AND t.id IS NULL",
                            rusqlite::params![generation],
                            |row| row.get(0),
                        )
                        .map_err(|error| format!("Count Tag baseline deletes failed: {}", error))?;

                    let current_count: i64 = connection
                        .query_row(
                            "SELECT COUNT(*) FROM tags WHERE vector IS NOT NULL",
                            [],
                            |row| row.get(0),
                        )
                        .map_err(|error| format!("Count current Tag vectors failed: {}", error))?;

                    let max_generation: i64 = connection
                        .query_row(
                            "SELECT COALESCE(MAX(generation), 0) FROM tag_index_baselines",
                            [],
                            |row| row.get(0),
                        )
                        .map_err(|error| format!("Read Tag next generation failed: {}", error))?;

                    Ok::<_, String>((
                        generation,
                        slot,
                        deletes,
                        upserts,
                        current_count,
                        baseline_count,
                        max_generation + 1,
                        frozen_entries,
                    ))
                }
                }?;

                Ok((database_generation, manifest))
            })
            .map_err(Error::from_reason)?;

        let (
            active_generation,
            active_slot,
            deletes,
            upserts,
            current_count,
            baseline_count,
            next_generation,
            frozen_entries,
        ) = manifest;

        let snapshot_database_generation = snapshot_database_generation.max(0) as u64;
        let delta = (deletes.max(0) + upserts.max(0)) as u64;
        let current_count = current_count.max(0) as u64;
        let baseline_count = baseline_count.max(0) as u64;
        let delta_ratio = ratio(delta, current_count, baseline_count);

        if active_generation > 0 && !self.force && delta_ratio < self.threshold {
            return serde_json::to_string(&CheckpointResult {
                published: false,
                skipped: true,
                scope: match scope {
                    IndexScope::Diary => "diary".to_string(),
                    IndexScope::GlobalTags => "global_tags".to_string(),
                },
                diary_name: self.diary_name.clone(),
                generation: active_generation as u64,
                slot: active_slot,
                delta,
                ratio: delta_ratio,
                current_count,
                baseline_count,
                database_generation: 0,
                facts_committed: false,
                index_ready: false,
            })
            .map_err(|error| Error::from_reason(format!("Encode checkpoint result failed: {}", error)));
        }

        let next_slot = slot_flip((active_slot.is_empty()).then_some("").or(Some(active_slot.as_str())));
        let target_index_path = index_slot_path(&self.index_path, next_slot);
        let revision_before_save = self.content_revision.load(Ordering::Acquire);
        save_index_snapshot(&self.index, &target_index_path).map_err(Error::from_reason)?;
        let revision_after_save = self.content_revision.load(Ordering::Acquire);
        if revision_after_save != revision_before_save {
            let _ = std::fs::remove_file(&target_index_path);
            return Err(Error::from_reason(format!(
                "Index checkpoint revision changed during save: before={}, after={}",
                revision_before_save, revision_after_save
            )));
        }

        let db_path = self.db_path.clone();
        let diary_name = self.diary_name.clone();
        let model_sig = self.model_sig.clone();
        let scope_for_write = scope;
        let frozen_entries_for_write = frozen_entries;
        let snapshot_database_generation_for_write = snapshot_database_generation;
        let generation = next_generation.max(1) as u64;
        let slot = next_slot.to_string();
        let slot_for_write = slot.clone();
        let dimension = self.dimension as i64;
        let receipt = with_registered_write(&db_path, move |transaction| {
            let current_database_generation: u64 = transaction
                .query_row(
                    "SELECT value FROM kbm_runtime_meta \
                     WHERE key = 'database_generation'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|error| {
                    format!(
                        "Read checkpoint publish database generation failed: {}",
                        error
                    )
                })?
                .parse::<u64>()
                .map_err(|error| {
                    format!(
                        "Decode checkpoint publish database generation failed: {}",
                        error
                    )
                })?;
            if current_database_generation != snapshot_database_generation_for_write {
                return Err(format!(
                    "KNOWLEDGE_STORE_CHECKPOINT_GENERATION_CONFLICT: snapshot={}, current={}",
                    snapshot_database_generation_for_write,
                    current_database_generation
                ));
            }

            match scope_for_write {
                IndexScope::Diary => {
                    let diary = diary_name
                        .as_deref()
                        .ok_or_else(|| "Diary checkpoint requires diaryName".to_string())?;
                    transaction
                        .execute(
                            "INSERT INTO chunk_index_baselines \
                             (diary_name, generation, slot, dimension, model_sig, chunk_count, status, created_at) \
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ready', ?7)",
                            rusqlite::params![
                                diary,
                                generation as i64,
                                &slot_for_write,
                                dimension,
                                &model_sig,
                                frozen_entries_for_write.len() as i64,
                                now_ms()
                            ],
                        )
                        .map_err(|error| format!("Publish diary baseline failed: {}", error))?;
                    let mut insert_entry = transaction
                        .prepare(
                            "INSERT INTO chunk_index_baseline_entries
                             (diary_name, generation, chunk_id, chunk_vector_sig)
                             VALUES (?1, ?2, ?3, ?4)",
                        )
                        .map_err(|error| {
                            format!("Prepare diary baseline entry insert failed: {}", error)
                        })?;
                    for entry in &frozen_entries_for_write {
                        let FrozenIndexEntry::Chunk { id, signature } = entry else {
                            return Err(
                                "Diary checkpoint received a non-Chunk frozen entry".to_string()
                            );
                        };
                        insert_entry
                            .execute(rusqlite::params![
                                diary,
                                generation as i64,
                                id,
                                signature,
                            ])
                            .map_err(|error| {
                                format!("Insert diary baseline entry failed: {}", error)
                            })?;
                    }
                    transaction
                        .execute(
                            "DELETE FROM chunk_index_baselines WHERE diary_name = ?1 AND generation != ?2",
                            rusqlite::params![diary, generation as i64],
                        )
                        .map_err(|error| format!("Prune diary baselines failed: {}", error))?;
                }
                IndexScope::GlobalTags => {
                    transaction
                        .execute(
                            "INSERT INTO tag_index_baselines \
                             (generation, slot, dimension, model_sig, tag_count, status, created_at) \
                             VALUES (?1, ?2, ?3, ?4, ?5, 'ready', ?6)",
                            rusqlite::params![
                                generation as i64,
                                &slot_for_write,
                                dimension,
                                &model_sig,
                                frozen_entries_for_write.len() as i64,
                                now_ms()
                            ],
                        )
                        .map_err(|error| format!("Publish Tag baseline failed: {}", error))?;
                    let mut insert_tag_entry = transaction
                        .prepare(
                            "INSERT INTO tag_index_baseline_entries \
                             (generation, tag_id, vector_version) VALUES (?1, ?2, ?3)",
                        )
                        .map_err(|error| {
                            format!("Prepare Tag baseline entry insert failed: {}", error)
                        })?;
                    for entry in &frozen_entries_for_write {
                        let FrozenIndexEntry::Tag {
                            id,
                            vector_version,
                        } = entry
                        else {
                            return Err(
                                "Tag checkpoint received a non-Tag frozen entry".to_string()
                            );
                        };
                        insert_tag_entry
                            .execute(rusqlite::params![
                                generation as i64,
                                id,
                                vector_version,
                            ])
                            .map_err(|error| {
                                format!("Insert Tag baseline entry failed: {}", error)
                            })?;
                    }
                    transaction
                        .execute(
                            "INSERT INTO kv_store(key, value) VALUES ('tag_index_active_baseline', ?1) \
                             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                            rusqlite::params![serde_json::json!({
                                "generation": generation,
                                "slot": &slot_for_write
                            }).to_string()],
                        )
                        .map_err(|error| format!("Publish Tag active baseline failed: {}", error))?;
                    transaction
                        .execute(
                            "DELETE FROM tag_index_baselines WHERE generation != ?1",
                            rusqlite::params![generation as i64],
                        )
                        .map_err(|error| format!("Prune Tag baselines failed: {}", error))?;
                }
            }

            Ok(WriteReceipt {
                operation: "publish_index_baseline".to_string(),
                database_generation: 0,
                facts_changed: false,
            })
        })
        .map_err(Error::from_reason)?;

        serde_json::to_string(&CheckpointResult {
            published: true,
            skipped: false,
            scope: match scope {
                IndexScope::Diary => "diary".to_string(),
                IndexScope::GlobalTags => "global_tags".to_string(),
            },
            diary_name: self.diary_name.clone(),
            generation,
            slot,
            delta,
            ratio: delta_ratio,
            current_count,
            baseline_count,
            database_generation: receipt.database_generation,
            facts_committed: false,
            index_ready: true,
        })
        .map_err(|error| Error::from_reason(format!("Encode checkpoint result failed: {}", error)))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct IndexRestoreTask {
    pub(crate) content_revision: Arc<AtomicU64>,
    pub(crate) memo_runtime: Option<Arc<crate::rivermemo_topology_v3::MemoRuntime>>,
    pub(crate) db_path: String,
    pub(crate) index_path: String,
    pub(crate) index: Arc<RwLock<Index>>,
    pub(crate) scope: IndexScope,
    pub(crate) diary_name: Option<String>,
    pub(crate) dimension: u32,
    pub(crate) model_sig: String,
    pub(crate) capacity: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RestoreResult {
    restored: bool,
    vector_count: u64,
    generation: u64,
    slot: String,
    replayed: bool,
    rebuilt: bool,
}

fn new_restore_index(dimension: usize, capacity: usize) -> Result<Index> {
    let index = Index::new(&usearch::IndexOptions {
        dimensions: dimension,
        metric: usearch::MetricKind::L2sq,
        quantization: usearch::ScalarKind::F32,
        connectivity: 16,
        expansion_add: 128,
        expansion_search: 64,
        multi: false,
    })
    .map_err(|error| Error::from_reason(format!("Create restore index failed: {:?}", error)))?;
    index
        .reserve(capacity.max(1))
        .map_err(|error| Error::from_reason(format!("Reserve restore index failed: {:?}", error)))?;
    Ok(index)
}

fn decode_restore_vector(bytes: &[u8], dimension: usize) -> Result<Vec<f32>> {
    if bytes.len() != dimension * std::mem::size_of::<f32>() {
        return Err(Error::from_reason(format!(
            "Restore vector byte length mismatch: expected {}, got {}",
            dimension * std::mem::size_of::<f32>(),
            bytes.len()
        )));
    }
    let vector = bytes
        .chunks_exact(std::mem::size_of::<f32>())
        .map(|chunk| f32::from_ne_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect::<Vec<_>>();
    if vector.iter().any(|value| !value.is_finite()) {
        return Err(Error::from_reason(
            "Restore encountered a non-finite vector".to_string(),
        ));
    }
    Ok(vector)
}

impl Task for IndexRestoreTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        use std::collections::{HashMap, HashSet};
        use std::path::Path;

        let _publication_guard = checkpoint_gate().lock()
            .map_err(|_| Error::from_reason("Index publication gate poisoned"))?;
        let dimension = self.dimension as usize;
        if dimension == 0 || self.model_sig.trim().is_empty() {
            return Err(Error::from_reason(
                "Restore requires a positive dimension and model signature".to_string(),
            ));
        }

        let db_path = self.db_path.clone();
        let diary_name = self.diary_name.clone();
        let model_sig = self.model_sig.clone();
        let scope = self.scope;
        let snapshot: (
            i64,
            String,
            bool,
            std::collections::HashMap<i64, Option<String>>,
            Vec<(i64, Vec<u8>, Option<String>)>,
        ) = with_registered_read_transaction(&db_path, move |connection| {
            match scope {
                IndexScope::Diary => {
                    let diary = diary_name
                        .as_deref()
                        .ok_or_else(|| "Diary restore requires diaryName".to_string())?;
                    let active = connection
                        .query_row(
                            "SELECT generation, slot, dimension, model_sig
                             FROM chunk_index_baselines
                             WHERE diary_name = ?1 AND status = 'ready'
                             ORDER BY generation DESC LIMIT 1",
                            rusqlite::params![diary],
                            |row| {
                                Ok((
                                    row.get::<_, i64>(0)?,
                                    row.get::<_, String>(1)?,
                                    row.get::<_, i64>(2)?,
                                    row.get::<_, String>(3)?,
                                ))
                            },
                        )
                        .optional()
                        .map_err(|error| format!("Read diary restore baseline failed: {}", error))?;

                    let mut baseline_ids = HashMap::new();
                    let mut generation = 0_i64;
                    let mut slot = String::new();
                    let mut baseline_compatible = false;
                    if let Some((candidate_generation, candidate_slot, stored_dimension, stored_model)) =
                        active
                    {
                        generation = candidate_generation;
                        slot = candidate_slot;
                        baseline_compatible =
                            stored_dimension == dimension as i64 && stored_model == model_sig;
                        if baseline_compatible {
                            let mut statement = connection
                                .prepare(
                                    "SELECT chunk_id, chunk_vector_sig FROM chunk_index_baseline_entries
                                     WHERE diary_name = ?1 AND generation = ?2",
                                )
                                .map_err(|error| {
                                    format!("Prepare diary restore baseline entries failed: {}", error)
                                })?;
                            let rows = statement
                                .query_map(rusqlite::params![diary, generation], |row| {
                                    Ok((
                                        row.get::<_, i64>(0)?,
                                        row.get::<_, Option<String>>(1)?,
                                    ))
                                })
                                .map_err(|error| {
                                    format!("Query diary restore baseline entries failed: {}", error)
                                })?;
                            for row in rows {
                                let (id, signature) = row.map_err(|error| {
                                    format!("Decode diary restore baseline entry failed: {}", error)
                                })?;
                                baseline_ids.insert(id, signature);
                            }
                        }
                    }

                    let mut statement = connection
                        .prepare(
                            "SELECT c.id, c.vector FROM chunks c
                             JOIN files f ON f.id = c.file_id
                             WHERE f.diary_name = ?1 AND c.vector IS NOT NULL
                             ORDER BY c.id",
                        )
                        .map_err(|error| format!("Prepare diary restore vectors failed: {}", error))?;
                    let rows = statement
                        .query_map(rusqlite::params![diary], |row| {
                            Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?, None))
                        })
                        .map_err(|error| format!("Query diary restore vectors failed: {}", error))?;
                    let current = rows
                        .collect::<rusqlite::Result<Vec<_>>>()
                        .map_err(|error| format!("Decode diary restore vectors failed: {}", error))?;
                    Ok((generation, slot, baseline_compatible, baseline_ids, current))
                }
                IndexScope::GlobalTags => {
                    let active_raw: Option<String> = connection
                        .query_row(
                            "SELECT value FROM kv_store WHERE key = 'tag_index_active_baseline'",
                            [],
                            |row| row.get(0),
                        )
                        .optional()
                        .map_err(|error| format!("Read Tag restore pointer failed: {}", error))?;
                    let mut generation = 0_i64;
                    let mut slot = String::new();
                    let mut baseline_ids = HashMap::new();
                    let mut baseline_compatible = false;
                    if let Some(raw) = active_raw {
                        if let Ok(active) = serde_json::from_str::<serde_json::Value>(&raw) {
                            generation = active
                                .get("generation")
                                .and_then(serde_json::Value::as_i64)
                                .unwrap_or(0);
                            slot = active
                                .get("slot")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                            let manifest = connection
                                .query_row(
                                    "SELECT dimension, model_sig FROM tag_index_baselines
                                     WHERE generation = ?1 AND slot = ?2 AND status = 'ready'",
                                    rusqlite::params![generation, slot],
                                    |row| {
                                        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                                    },
                                )
                                .optional()
                                .map_err(|error| {
                                    format!("Read Tag restore manifest failed: {}", error)
                                })?;
                            if let Some((stored_dimension, stored_model)) = manifest {
                                baseline_compatible =
                                    stored_dimension == dimension as i64 && stored_model == model_sig;
                            }
                            if baseline_compatible && generation > 0 {
                                let mut statement = connection
                                    .prepare(
                                        "SELECT tag_id, vector_version FROM tag_index_baseline_entries
                                         WHERE generation = ?1",
                                    )
                                    .map_err(|error| {
                                        format!("Prepare Tag restore baseline entries failed: {}", error)
                                    })?;
                                let rows = statement
                                    .query_map(rusqlite::params![generation], |row| {
                                        Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
                                    })
                                    .map_err(|error| {
                                        format!("Query Tag restore baseline entries failed: {}", error)
                                    })?;
                                for row in rows {
                                    let (tag_id, version) = row.map_err(|error| {
                                        format!("Decode Tag restore baseline entry failed: {}", error)
                                    })?;
                                    baseline_ids.insert(tag_id, Some(version.to_string()));
                                }
                            }
                        }
                    }

                    let mut statement = connection
                        .prepare("SELECT id, vector, vector_version FROM tags WHERE vector IS NOT NULL ORDER BY id")
                        .map_err(|error| format!("Prepare Tag restore vectors failed: {}", error))?;
                    let rows = statement
                        .query_map([], |row| {
                            Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?,
                                Some(row.get::<_, i64>(2)?.to_string())))
                        })
                        .map_err(|error| format!("Query Tag restore vectors failed: {}", error))?;
                    let current = rows
                        .collect::<rusqlite::Result<Vec<_>>>()
                        .map_err(|error| format!("Decode Tag restore vectors failed: {}", error))?;
                    Ok((generation, slot, baseline_compatible, baseline_ids, current))
                }
            }
        })
        .map_err(Error::from_reason)?;

        let (generation, slot, baseline_compatible, baseline_ids, current_rows) = snapshot;
        let mut rebuilt = false;
        let mut replayed = false;
        let mut restored_index = None;

        if baseline_compatible && matches!(slot.as_str(), "a" | "b") {
            let persisted_path = index_slot_path(&self.index_path, &slot);
            if Path::new(&persisted_path).exists() {
                let loaded = new_restore_index(dimension, self.capacity as usize)?;
                loaded
                    .load(&persisted_path)
                    .map_err(|error| Error::from_reason(format!(
                        "Load persisted restore index failed: {:?}",
                        error
                    )))?;
                restored_index = Some(loaded);
            }
        }

        let loaded_persisted_index = restored_index.is_some();
        let target = match restored_index {
            Some(index) => index,
            None => {
                rebuilt = true;
                new_restore_index(dimension, self.capacity as usize)?
            }
        };

        let current_ids: HashSet<i64> = current_rows.iter().map(|(id, _, _)| *id).collect();
        if baseline_compatible && loaded_persisted_index {
            for id in baseline_ids.keys().filter(|id| !current_ids.contains(id)) {
                let _ = target.remove(*id as u64);
                replayed = true;
            }
        }

        let mut vector_map = HashMap::with_capacity(current_rows.len());
        for (id, bytes, version) in current_rows {
            // Tag 使用单调向量版本，不对高维 BLOB 重算哈希；Chunk 保持内容签名。
            let signature = version.unwrap_or_else(|| vector_signature(&bytes));
            let changed = baseline_ids
                .get(&id)
                .and_then(Option::as_deref)
                .map(|value| value != signature)
                .unwrap_or(true);
            if rebuilt || !baseline_compatible || changed {
                vector_map.insert(id, (decode_restore_vector(&bytes, dimension)?, changed));
            }
        }

        for (id, (vector, changed)) in vector_map {
            if !baseline_compatible || rebuilt || changed {
                if target.size() + 1 >= target.capacity() {
                    target
                        .reserve((target.size() + 1).saturating_mul(3) / 2)
                        .map_err(|error| {
                            Error::from_reason(format!("Grow restore index failed: {:?}", error))
                        })?;
                }
                let _ = target.remove(id as u64);
                target.add(id as u64, &vector).map_err(|error| {
                    Error::from_reason(format!("Apply restore vector {} failed: {:?}", id, error))
                })?;
                replayed = replayed || (baseline_compatible && loaded_persisted_index);
            }
        }

        let vector_count = target.size() as u64;
        let mut active = self
            .index
            .write()
            .map_err(|error| Error::from_reason(format!("Publish restored index failed: {}", error)))?;
        *active = target;
        self.content_revision.fetch_add(1, Ordering::AcqRel);
        drop(active);
        if let Some(runtime) = &self.memo_runtime {
            runtime.clear().map_err(Error::from_reason)?;
        }

        let state_scope = match self.scope {
            IndexScope::GlobalTags => "global_tags".to_string(),
            IndexScope::Diary => format!("diary:{}", self.diary_name.as_deref().unwrap_or_default()),
        };
        with_registered_write(&self.db_path, move |tx| {
            tx.execute(
                "INSERT INTO kbm_index_states(
                    scope, state, facts_generation, applied_generation, updated_at
                 ) SELECT ?1, 'ready', CAST(value AS INTEGER), CAST(value AS INTEGER), ?2
                   FROM kbm_runtime_meta WHERE key='database_generation'
                 ON CONFLICT(scope) DO UPDATE SET
                    state='ready', facts_generation=excluded.facts_generation,
                    applied_generation=excluded.applied_generation,
                    error_message=NULL, updated_at=excluded.updated_at",
                rusqlite::params![state_scope, now_ms()],
            ).map_err(|error| format!("Publish restored index state failed: {}", error))?;
            Ok(WriteReceipt {
                operation: "publish_restored_index_state".to_string(),
                database_generation: 0,
                facts_changed: false,
            })
        }).map_err(Error::from_reason)?;

        serde_json::to_string(&RestoreResult {
            restored: true,
            vector_count,
            generation: generation.max(0) as u64,
            slot,
            replayed,
            rebuilt,
        })
        .map_err(|error| Error::from_reason(format!("Encode restore result failed: {}", error)))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod audit_tests {
    use super::*;

    #[test]
    fn tag_restore_replays_versions_and_reports_missing_baseline_as_rebuild() {
        let root = std::env::temp_dir().join(format!(
            "kbm-baseline-audit-{}-{}", std::process::id(), now_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db = root.join("test.sqlite").to_string_lossy().into_owned();
        let (storage, _) = crate::storage::SqliteStorageEngine::open_and_init(
            &db, crate::storage::StorageOptions::default(),
        ).unwrap();
        storage.submit_write(|tx| {
            let bytes: Vec<u8> = [1.0_f32, 0.0].iter()
                .flat_map(|value| value.to_ne_bytes()).collect();
            tx.execute("INSERT INTO tags(name,vector) VALUES ('tag',?1)", [bytes])
                .map_err(|error| error.to_string())?;
            Ok(WriteReceipt { operation: "fixture".into(), database_generation: 0, facts_changed: true })
        }).unwrap();
        let index = crate::VexusIndex::new(2, 16).unwrap();
        let baseline = root.join("tags_a.usearch").to_string_lossy().into_owned();
        let mut restore = IndexRestoreTask {
            db_path: db.clone(), index_path: baseline.clone(), index: index.index.clone(),
            content_revision: index.content_revision.clone(), memo_runtime: Some(index.memo_runtime.clone()),
            scope: IndexScope::GlobalTags, diary_name: None, dimension: 2,
            model_sig: "test".into(), capacity: 16,
        };
        restore.compute().unwrap();
        IndexCheckpointTask {
            db_path: db.clone(), index_path: baseline.clone(), index: index.index.clone(),
            content_revision: index.content_revision.clone(), scope: IndexScope::GlobalTags,
            diary_name: None, dimension: 2, model_sig: "test".into(), threshold: 0.05, force: true,
        }.compute().unwrap();
        let same: serde_json::Value = serde_json::from_str(&restore.compute().unwrap()).unwrap();
        assert_eq!(same["replayed"], false);
        assert_eq!(same["rebuilt"], false);
        storage.submit_write(|tx| {
            let bytes: Vec<u8> = [0.0_f32, 1.0].iter()
                .flat_map(|value| value.to_ne_bytes()).collect();
            tx.execute("UPDATE tags SET vector=?1 WHERE id=1", [bytes])
                .map_err(|error| error.to_string())?;
            Ok(WriteReceipt { operation: "update".into(), database_generation: 0, facts_changed: true })
        }).unwrap();
        let changed: serde_json::Value = serde_json::from_str(&restore.compute().unwrap()).unwrap();
        assert_eq!(changed["replayed"], true);
        let mut vector = [0.0_f32; 2];
        index.index.read().unwrap().get(1, &mut vector).unwrap();
        assert_eq!(vector, [0.0, 1.0]);
        std::fs::remove_file(baseline).unwrap();
        let rebuilt: serde_json::Value = serde_json::from_str(&restore.compute().unwrap()).unwrap();
        assert_eq!(rebuilt["rebuilt"], true);
        assert_eq!(rebuilt["replayed"], false);
        storage.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}