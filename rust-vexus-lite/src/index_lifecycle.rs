use vcp_tdb_index::asset::{AssetIdentity, VectorAsset, FORMAT_VERSION};
use crate::storage::{
    with_registered_read_transaction, with_registered_write, WriteReceipt,
};
use napi::bindgen_prelude::*;
use rusqlite::OptionalExtension;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use crate::retrieval_index::RetrievalIndex as Index;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum IndexScope {
    Diary,
    GlobalTags,
}

pub struct IndexCheckpointTask {
    pub(crate) db_path: String,
    pub(crate) index_path: String,
    pub(crate) index: Arc<crate::index_handle::IndexHandle>,
    pub(crate) content_revision: Arc<AtomicU64>,
    pub(crate) scope: IndexScope,
    pub(crate) diary_name: Option<String>,
    pub(crate) dimension: u32,
    pub(crate) model_sig: String,
    pub(crate) threshold: f64,
    pub(crate) force: bool,
    pub(crate) allow_initial: bool,
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
    let replacement = if file_name.ends_with("_a.vec") {
        Some(("_a.vec", "_".to_string() + slot + ".vec"))
    } else if file_name.ends_with("_b.vec") {
        Some(("_b.vec", "_".to_string() + slot + ".vec"))
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

#[cfg(test)]
fn retire_legacy_assets(base_path: &str) -> std::result::Result<(), String> {
    let base = std::path::Path::new(base_path);
    if base.extension().and_then(|value| value.to_str()) != Some("vec") {
        return Err("Runtime index paths must use the .vec format".into());
    }
    let mut paths = Vec::new();
    for slot in ["a", "b"] {
        let path = std::path::PathBuf::from(index_slot_path(base_path, slot))
            .with_extension("usearch");
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    if let Some(name) = base.file_name().and_then(|value| value.to_str()) {
        for suffix in ["_a.vec", "_b.vec"] {
            if let Some(stem) = name.strip_suffix(suffix) {
                paths.push(base.with_file_name(format!("{}.usearch", stem)));
            }
        }
    }
    for path in paths {
        if !path.exists() {
            continue;
        }
        let mut retired = path.as_os_str().to_os_string();
        retired.push(".retired");
        let retired = std::path::PathBuf::from(retired);
        // Never overwrite evidence retained from an earlier migration attempt.
        let retired = if retired.exists() {
            crate::unique_index_sidecar_path(&retired, "retired")
        } else {
            retired
        };
        std::fs::rename(&path, &retired).map_err(|error| format!(
            "Retire legacy retrieval asset '{}' failed: {}", path.display(), error
        ))?;
    }
    Ok(())
}

fn ratio(delta: u64, current: u64, baseline: u64) -> f64 {
    delta as f64 / current.max(baseline).max(1) as f64
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
        let state_scope = match self.scope {
            IndexScope::Diary => format!("diary:{}", self.diary_name.as_deref().unwrap_or_default()),
            IndexScope::GlobalTags => String::from("global_tags"),
        };
        // 独立协调库只串行化双槽写入；不可在持共享事实门禁后再升级。
        let _checkpoint_guard = crate::publication_gate::acquire(
            &format!("{}#index-checkpoints", self.db_path),
            &[state_scope.clone()],
        ).map_err(Error::from_reason)?;
        let _snapshot_guard = crate::publication_gate::acquire_read(
            &self.db_path, std::slice::from_ref(&state_scope),
        ).map_err(Error::from_reason)?;
        crate::knowledge_runtime::ensure_index_scopes_ready(
            &self.db_path, std::slice::from_ref(&state_scope),
        ).map_err(Error::from_reason)?;

        if std::path::Path::new(&self.index_path).extension()
            .and_then(|value| value.to_str()) != Some("vec")
        {
            return Err(Error::from_reason("Runtime checkpoint requires a .vec asset path"));
        }
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
            mut frozen_entries,
        ) = manifest;

        let snapshot_database_generation = snapshot_database_generation.max(0) as u64;
        let delta = (deletes.max(0) + upserts.max(0)) as u64;
        let current_count = current_count.max(0) as u64;
        let baseline_count = baseline_count.max(0) as u64;
        let delta_ratio = ratio(delta, current_count, baseline_count);

        let initial_blocked = if active_generation == 0 {
            let has_signature = with_registered_read_transaction(&self.db_path, |connection| {
                let count: i64 = match self.scope {
                    IndexScope::Diary => connection.query_row(
                        "SELECT COUNT(*) FROM chunk_index_baselines WHERE diary_name=?1",
                        [self.diary_name.as_deref()], |row| row.get(0),
                    ),
                    IndexScope::GlobalTags => connection.query_row(
                        "SELECT (SELECT COUNT(*) FROM tag_index_baselines)
                         + (SELECT COUNT(*) FROM kv_store WHERE key='tag_index_active_baseline')",
                        [], |row| row.get(0),
                    ),
                }.map_err(|error| error.to_string())?;
                Ok(count > 0)
            }).map_err(Error::from_reason)?;
            let mut has_file = false;
            for slot in ["a", "b"] {
                match std::fs::metadata(index_slot_path(&self.index_path, slot)) {
                    Ok(_) => has_file = true,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(Error::from_reason(error.to_string())),
                }
            }
            !self.allow_initial || has_signature || has_file
        } else {
            false
        };

        // SQL owns the baseline. Threshold checks never open the snapshot.
        // Legacy force requests cannot bypass cumulative drift policy.
        let _legacy_force = self.force;
        if initial_blocked || (active_generation > 0 && (delta == 0 || delta_ratio < self.threshold)) {
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
        let build = with_registered_read_transaction(&self.db_path, |connection| {
            crate::storage::ensure_generation(connection, snapshot_database_generation)?;
            crate::index_source::build_memory_from_connection(
                connection, self.diary_name.as_deref(), self.dimension as usize,
                &self.model_sig,
            )
        }).map_err(Error::from_reason)?;
        // Endorse exactly the valid SQL rows represented in the asset. Invalid
        // BLOBs remain SQL facts, but must never appear as indexed baseline rows.
        frozen_entries.retain(|entry| {
            let id = match entry {
                FrozenIndexEntry::Chunk { id, .. } | FrozenIndexEntry::Tag { id, .. } => *id,
            };
            id > 0 && build.index().contains(id as u64)
        });
        let asset_identity = build.identity.clone();
        let target = std::path::Path::new(&target_index_path);
        // The checkpoint guard serializes this scope through SQL endorsement.
        // Reuse one staging path per slot; no PID-based generation identities.
        let staging = crate::CheckpointStaging::new(target)
            .map_err(|error| Error::from_reason(format!("Prepare checkpoint staging failed: {}", error)))?;
        let temp = staging.path();
        with_registered_read_transaction(&self.db_path, |connection| {
            crate::storage::ensure_generation(connection, snapshot_database_generation)?;
            build.write_snapshot(connection, self.diary_name.as_deref(), temp)
        }).map_err(|error| Error::from_reason(format!("Write checkpoint asset failed: {}", error)))?;
        let checked = vcp_tdb_index::asset::VectorAsset::open(temp, &asset_identity)
            .map_err(|error| Error::from_reason(format!("Validate checkpoint asset failed: {}", error)))?;
        let (file_size, file_crc) = checked.file_stamp();
        drop(checked);
        crate::sync_index_file(temp).map_err(|error| Error::from_reason(error.to_string()))?;
        if let Err(error) = crate::publish_index_file(temp, target) {
            return Err(Error::from_reason(format!("Publish checkpoint asset failed: {}", error)));
        }
        let content_digest = asset_identity.content_digest.iter()
            .map(|byte| format!("{:02x}", byte)).collect::<String>();
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

            let current_baseline: i64 = match scope_for_write {
                IndexScope::Diary => transaction.query_row(
                    "SELECT COALESCE(MAX(generation),0) FROM chunk_index_baselines
                     WHERE diary_name=?1 AND status='ready'",
                    [diary_name.as_deref()], |row| row.get(0),
                ),
                IndexScope::GlobalTags => transaction.query_row(
                    "SELECT COALESCE(MAX(generation),0) FROM tag_index_baselines
                     WHERE status='ready'", [], |row| row.get(0),
                ),
            }.map_err(|error| format!("Read expected checkpoint baseline failed: {error}"))?;
            if current_baseline != active_generation {
                return Err(format!(
                    "KNOWLEDGE_STORE_CHECKPOINT_BASELINE_CONFLICT: expected={}, current={}",
                    active_generation, current_baseline
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

            // File publication precedes SQL endorsement. Legacy rows remain version 0.
            let updated = match scope_for_write {
                IndexScope::Diary => transaction.execute(
                    "UPDATE chunk_index_baselines SET format_version=1,file_size=?1,
                     file_crc=?2,content_digest=?3 WHERE diary_name=?4 AND generation=?5",
                    rusqlite::params![file_size as i64, file_crc as i64, content_digest,
                        diary_name.as_deref(), generation as i64],
                ),
                IndexScope::GlobalTags => transaction.execute(
                    "UPDATE tag_index_baselines SET format_version=1,file_size=?1,
                     file_crc=?2,content_digest=?3 WHERE generation=?4",
                    rusqlite::params![file_size as i64, file_crc as i64, content_digest,
                        generation as i64],
                ),
            }.map_err(|error| format!("Endorse vector asset failed: {}", error))?;
            if updated != 1 {
                return Err("Checkpoint asset endorsement row missing".into());
            }
            Ok(WriteReceipt {
                operation: "publish_index_baseline".to_string(),
                database_generation: 0,
                facts_changed: false,
            })
        })
        .map_err(Error::from_reason)?;

        // The published facts have not changed. Adopt SQL-built memory routing;
        // neither private assets nor public-slot mappings remain live.
        let mut active = self.index.write().map_err(|error| {
            Error::from_reason(format!("Rebase checkpoint index failed: {}", error))
        })?;
        if self.content_revision.load(Ordering::Acquire) == revision_before_save {
            *active = Index::from_sql(build);
        }
        drop(active);

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
    pub(crate) index: Arc<crate::index_handle::IndexHandle>,
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
    skipped_invalid_vectors: u64,
}

fn load_endorsed_index(
    db_path: &str,
    path: &std::path::Path,
    scope: IndexScope,
    diary: Option<&str>,
    generation: i64,
    slot: &str,
    dimension: usize,
    model_sig: &str,
) -> std::result::Result<Index, String> {
    with_registered_read_transaction(db_path, |connection| {
        let sql = match scope {
            IndexScope::Diary =>
                "SELECT format_version,file_size,file_crc,content_digest
                 FROM chunk_index_baselines WHERE generation=?1 AND slot=?2
                 AND diary_name=?3 AND status='ready'",
            IndexScope::GlobalTags =>
                "SELECT format_version,file_size,file_crc,content_digest
                 FROM tag_index_baselines WHERE generation=?1 AND slot=?2
                 AND ?3 IS NULL AND status='ready'",
        };
        let (format, size, crc, digest): (i64, Option<i64>, Option<i64>, Option<String>) =
            connection.query_row(sql, rusqlite::params![generation, slot, diary], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            }).map_err(|error| format!("Read vector asset endorsement failed: {}", error))?;
        if format != FORMAT_VERSION as i64 {
            return Err("Incompatible legacy index format; rebuild from SQL required".into());
        }
        let digest = digest.ok_or("Missing vector asset digest")?;
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Invalid vector asset digest endorsement".into());
        }
        let mut content_digest = [0_u8; 32];
        for (position, value) in content_digest.iter_mut().enumerate() {
            *value = u8::from_str_radix(&digest[position * 2..position * 2 + 2], 16)
                .map_err(|error| error.to_string())?;
        }
        let expected = AssetIdentity {
            dimension,
            scope: u8::from(scope == IndexScope::GlobalTags),
            model_hash: Index::model_hash(model_sig),
            content_digest,
        };
        let checked = VectorAsset::open_endorsed(path, &expected)
            .map_err(|error| format!("Validate endorsed vector asset failed: {}", error))?;
        let (actual_size, actual_crc) = checked.file_stamp();
        if size != i64::try_from(actual_size).ok() || crc != Some(actual_crc as i64) {
            return Err("Vector asset file stamp does not match SQL endorsement".into());
        }
        Index::from_validated_asset(checked).map_err(|error| error.to_string())
    })
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
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
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

        let _publication_guard = crate::publication_gate::acquire(&self.db_path, &[match self.scope { IndexScope::Diary => format!("diary:{}", self.diary_name.as_deref().unwrap_or_default()), IndexScope::GlobalTags => String::from("global_tags") }]).map_err(Error::from_reason)?;
        let revision_before_restore = self.content_revision.load(Ordering::Acquire);
        let dimension = self.dimension as usize;
        if dimension == 0 || self.model_sig.trim().is_empty() {
            return Err(Error::from_reason(
                "Restore requires a positive dimension and model signature".to_string(),
            ));
        }

        if Path::new(&self.index_path).extension().and_then(|value| value.to_str()) != Some("vec") {
            return Err(Error::from_reason("Runtime index paths must use the .vec format"));
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
            Vec<(i64, Option<String>)>,
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
                    let mut rows = statement.query(rusqlite::params![diary])
                        .map_err(|error| format!("Query diary restore vectors failed: {}", error))?;
                    let mut current = Vec::new();
                    while let Some(row) = rows.next().map_err(|error| error.to_string())? {
                        let id: i64 = row.get(0).map_err(|error| error.to_string())?;
                        let signature = match row.get_ref(1).map_err(|error| error.to_string())? {
                            rusqlite::types::ValueRef::Blob(bytes)
                                if id > 0 && decode_restore_vector(bytes, dimension).is_ok() =>
                                    Some(vector_signature(bytes)),
                            _ => None,
                        };
                        current.push((id, signature));
                    }
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
                    let mut rows = statement.query([])
                        .map_err(|error| format!("Query Tag restore vectors failed: {}", error))?;
                    let mut current = Vec::new();
                    while let Some(row) = rows.next().map_err(|error| error.to_string())? {
                        let id: i64 = row.get(0).map_err(|error| error.to_string())?;
                        let signature = match row.get_ref(1).map_err(|error| error.to_string())? {
                            rusqlite::types::ValueRef::Blob(bytes)
                                if id > 0 && decode_restore_vector(bytes, dimension).is_ok() =>
                                    Some(row.get::<_, i64>(2).map_err(|error| error.to_string())?.to_string()),
                            _ => None,
                        };
                        current.push((id, signature));
                    }
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
                match load_endorsed_index(
                    &self.db_path, Path::new(&persisted_path), self.scope,
                    self.diary_name.as_deref(), generation, &slot, dimension, &self.model_sig,
                ) {
                    Ok(loaded) => restored_index = Some(loaded),
                    Err(error) => {
                        eprintln!("[KBM] Baseline load failed for '{}': {}; preserving asset and rebuilding memory routing from SQL",
                            persisted_path, error);
                    }
                }
            }
        }

        let loaded_persisted_index = restored_index.is_some();
        let mut target = match restored_index {
            Some(index) => index,
            None => {
                rebuilt = true;
                let build = with_registered_read_transaction(&self.db_path, |connection| {
                    crate::index_source::build_memory_from_connection(
                        connection, self.diary_name.as_deref(), dimension, &self.model_sig,
                    )
                }).map_err(Error::from_reason)?;
                Index::from_sql(build)
            }
        };

        let current_ids: HashSet<i64> = current_rows.iter().map(|(id, _)| *id).collect();
        if baseline_compatible && loaded_persisted_index {
            for id in baseline_ids.keys().filter(|id| !current_ids.contains(id)) {
                target.remove(*id as u64).map_err(|error| {
                    Error::from_reason(format!("Replay baseline deletion failed: {}", error))
                })?;
                replayed = true;
            }
        }

        let mut skipped_invalid_vectors = 0_u64;
        let mut changed_ids = Vec::new();
        for (id, signature) in current_rows {
            let Some(signature) = signature else {
                skipped_invalid_vectors += 1;
                if loaded_persisted_index && id > 0 {
                    target.remove(id as u64).map_err(|error| {
                        Error::from_reason(format!("Remove invalid restore row failed: {}", error))
                    })?;
                    replayed = true;
                }
                continue;
            };
            if loaded_persisted_index && baseline_ids.get(&id)
                .and_then(Option::as_deref) != Some(signature.as_str())
            {
                changed_ids.push(id);
            }
        }
        // Do not materialize a near-full recovery delta only to compact it
        // afterwards. Large replays go directly through the bounded SQL stream.
        let large_replay = changed_ids.len().saturating_mul(dimension)
            .saturating_mul(std::mem::size_of::<f32>()) >= 16 * 1024 * 1024;
        if large_replay {
            let build = with_registered_read_transaction(&self.db_path, |connection| {
                crate::index_source::build_memory_from_connection(
                    connection, self.diary_name.as_deref(), dimension,
                    &self.model_sig,
                )
            }).map_err(Error::from_reason)?;
            target = Index::from_sql(build);
            rebuilt = true;
            replayed = true;
        }
        // Keep only metadata across the scan. Point-read bounded changes while
        // the scope's exclusive publication gate freezes facts.
        if !changed_ids.is_empty() && !large_replay {
            with_registered_read_transaction(&self.db_path, |connection| {
                let sql = match self.scope {
                    IndexScope::Diary =>
                        "SELECT c.vector FROM chunks c JOIN files f ON f.id=c.file_id
                         WHERE c.id=?1 AND f.diary_name=?2",
                    IndexScope::GlobalTags =>
                        "SELECT vector FROM tags WHERE id=?1 AND ?2 IS NULL",
                };
                let mut statement = connection.prepare(sql).map_err(|error| error.to_string())?;
                for id in &changed_ids {
                    let bytes: Vec<u8> = statement.query_row(
                        rusqlite::params![id, self.diary_name.as_deref()], |row| row.get(0),
                    ).map_err(|error| error.to_string())?;
                    let vector = decode_restore_vector(&bytes, dimension)
                        .map_err(|error| error.to_string())?;
                    target.add(*id as u64, &vector).map_err(|error| error.to_string())?;
                }
                Ok(())
            }).map_err(Error::from_reason)?;
            replayed = true;
        }

        if loaded_persisted_index && target.maintenance_required() {
            let build = with_registered_read_transaction(&self.db_path, |connection| {
                crate::index_source::build_memory_from_connection(
                    connection, self.diary_name.as_deref(), dimension,
                    &self.model_sig,
                )
            }).map_err(Error::from_reason)?;
            target = Index::from_sql(build);
            rebuilt = true;
        }
        if skipped_invalid_vectors > 0 {
            eprintln!("[KBM] Restore skipped {} invalid vectors", skipped_invalid_vectors);
        }
        target.release_originals();
        target.reserve(self.capacity as usize).map_err(|error| {
            Error::from_reason(format!("Reserve restored index capacity failed: {}", error))
        })?;
        let vector_count = target.size() as u64;
        let mut active = self
            .index
            .write()
            .map_err(|error| Error::from_reason(format!("Publish restored index failed: {}", error)))?;
        if self.content_revision.load(Ordering::Acquire) != revision_before_restore {
            return Err(Error::from_reason(
                "Restore content revision changed; retry required",
            ));
        }
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
            skipped_invalid_vectors,
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
    fn large_high_dimensional_restore_streams_directly_to_mapping() {
        let root = std::env::temp_dir().join(format!(
            "kbm-large-restore-{}-{}", std::process::id(), now_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db = root.join("test.sqlite").to_string_lossy().into_owned();
        let baseline = root.join("tags_a.vec").to_string_lossy().into_owned();
        let (storage, _) = crate::storage::SqliteStorageEngine::open_and_init(
            &db, crate::storage::StorageOptions::default(),
        ).unwrap();
        storage.submit_write(|tx| {
            let bytes: Vec<u8> = vec![0.5_f32; 3072].iter()
                .flat_map(|value| value.to_le_bytes()).collect();
            tx.execute("INSERT INTO tags(id,name,vector) VALUES (1,'first',?1)", [bytes])
                .map_err(|error| error.to_string())?;
            Ok(WriteReceipt {
                operation: "fixture".into(), database_generation: 0, facts_changed: true,
            })
        }).unwrap();
        let index = crate::VexusIndex::new(3072, 16).unwrap();
        let mut restore = IndexRestoreTask {
            db_path: db.clone(), index_path: baseline.clone(), index: index.index.clone(),
            content_revision: index.content_revision.clone(), memo_runtime: None,
            scope: IndexScope::GlobalTags, diary_name: None, dimension: 3072,
            model_sig: "test".into(), capacity: 1400,
        };
        restore.compute().unwrap();
        IndexCheckpointTask {
            db_path: db.clone(), index_path: baseline, index: index.index.clone(),
            content_revision: index.content_revision.clone(), scope: IndexScope::GlobalTags,
            diary_name: None, dimension: 3072, model_sig: "test".into(),
            threshold: 0.05, force: true, allow_initial: true,
        }.compute().unwrap();
        storage.submit_write(|tx| {
            let bytes: Vec<u8> = vec![-0.5_f32; 3072].iter()
                .flat_map(|value| value.to_le_bytes()).collect();
            let mut statement = tx.prepare(
                "INSERT INTO tags(id,name,vector) VALUES (?1,?2,?3)",
            ).map_err(|error| error.to_string())?;
            for id in 2..=1400 {
                statement.execute(rusqlite::params![id, format!("tag-{}", id), &bytes])
                    .map_err(|error| error.to_string())?;
            }
            Ok(WriteReceipt {
                operation: "growth".into(), database_generation: 0, facts_changed: true,
            })
        }).unwrap();
        let result: serde_json::Value =
            serde_json::from_str(&restore.compute().unwrap()).unwrap();
        assert_eq!(result["replayed"], true);
        assert_eq!(result["rebuilt"], true);
        {
            let active = index.index.read().unwrap();
            assert_eq!(active.size(), 1400);
            assert_eq!(active.mmap_bytes(), 0);
            assert!(!active.maintenance_required());
            let hits = with_registered_read_transaction(&db, |connection| {
                active.search_sql(connection, None, &vec![0.5; 3072], 1)
                    .map_err(|error| error.to_string())
            }).unwrap();
            assert_eq!(hits, vec![(1, 1.0)]);
        }
        drop(restore);
        drop(index);
        storage.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

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
        let baseline = root.join("tags_a.vec").to_string_lossy().into_owned();
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
            allow_initial: true,
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
        let guard = index.index.read().unwrap();
        with_registered_read_transaction(&db, |connection| {
            assert_eq!(guard.search_sql(connection, None, &[0.0, 1.0], 1).unwrap(), vec![(1, 1.0)]);
            assert_eq!(guard.search_sql(connection, None, &[1.0, 0.0], 1).unwrap(), vec![(1, 0.0)]);
            Ok(())
        }).unwrap();
        drop(guard);
        storage.submit_write(|tx| {
            let mut statement = tx.prepare(
                "INSERT INTO tags(id,name,vector) VALUES (?1,?2,?3)",
            ).map_err(|error| error.to_string())?;
            for id in 2..=2048 {
                let angle = id as f32 * 0.013;
                let bytes: Vec<u8> = [angle.cos(), angle.sin()].iter()
                    .flat_map(|value| value.to_le_bytes()).collect();
                statement.execute(rusqlite::params![id, format!("growth-{}", id), bytes])
                    .map_err(|error| error.to_string())?;
            }
            Ok(WriteReceipt {
                operation: "restore-growth".into(), database_generation: 0, facts_changed: true,
            })
        }).unwrap();
        let compacted: serde_json::Value =
            serde_json::from_str(&restore.compute().unwrap()).unwrap();
        assert_eq!(compacted["replayed"], true);
        assert_eq!(compacted["rebuilt"], true);
        {
            let active = index.index.read().unwrap();
            assert_eq!(active.size(), 2048);
            assert_eq!(active.mmap_bytes(), 0);
            assert!(!active.maintenance_required());
        }
        std::fs::remove_file(baseline).unwrap();
        let rebuilt: serde_json::Value = serde_json::from_str(&restore.compute().unwrap()).unwrap();
        assert_eq!(rebuilt["rebuilt"], true);
        assert_eq!(rebuilt["replayed"], false);
        drop(restore);
        drop(index);
        storage.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod checkpoint_safety_tests {
    use super::*;

    #[test]
    fn legacy_assets_are_retired_without_decoding_or_overwriting_evidence() {
        let root = std::env::temp_dir().join(format!(
            "kbm-retire-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        for name in ["tags_a.usearch", "tags_b.usearch", "tags.usearch"] {
            std::fs::write(root.join(name), name.as_bytes()).unwrap();
        }
        let base = root.join("tags_a.vec");
        retire_legacy_assets(base.to_str().unwrap()).unwrap();
        retire_legacy_assets(base.to_str().unwrap()).unwrap();
        for name in ["tags_a.usearch", "tags_b.usearch", "tags.usearch"] {
            assert!(!root.join(name).exists());
            assert_eq!(std::fs::read(root.join(format!("{}.retired", name))).unwrap(),
                name.as_bytes());
        }
        std::fs::write(root.join("tags_a.usearch"), b"second attempt").unwrap();
        retire_legacy_assets(base.to_str().unwrap()).unwrap();
        assert_eq!(std::fs::read(root.join("tags_a.usearch.retired")).unwrap(),
            b"tags_a.usearch");
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 4);
        assert!(retire_legacy_assets(root.join("tags_a.usearch").to_str().unwrap()).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_baseline_is_quarantined_and_rebuilt_from_sql() {
        let root = std::env::temp_dir().join(format!(
            "kbm-checkpoint-safety-{}-{}", std::process::id(), now_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db = root.join("test.sqlite").to_string_lossy().into_owned();
        let baseline = root.join("tags_a.vec").to_string_lossy().into_owned();
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
        let mut checkpoint = IndexCheckpointTask {
            db_path: db.clone(), index_path: baseline.clone(), index: index.index.clone(),
            content_revision: index.content_revision.clone(), scope: IndexScope::GlobalTags,
            diary_name: None, dimension: 2, model_sig: "test".into(), threshold: 0.05, force: false,
            allow_initial: true,
        };
        let mut restore = IndexRestoreTask {
            db_path: db.clone(), index_path: baseline.clone(), index: index.index.clone(),
            content_revision: index.content_revision.clone(), memo_runtime: None,
            scope: IndexScope::GlobalTags, diary_name: None, dimension: 2,
            model_sig: "test".into(), capacity: 16,
        };
        restore.compute().unwrap();
        for state in ["invalid", "recovering", "ready"] {
            let state = state.to_string();
            storage.submit_write(move |tx| {
                tx.execute(
                    "UPDATE kbm_index_states SET state=?1, applied_generation=-1 WHERE scope='global_tags'",
                    [state],
                ).map_err(|error| error.to_string())?;
                Ok(WriteReceipt {
                    operation: "invalidate-test".into(), database_generation: 0, facts_changed: false,
                })
            }).unwrap();
            assert!(checkpoint.compute().unwrap_err().reason.contains("KBM_INDEX_NOT_READY"));
            assert!(!std::path::Path::new(&baseline).exists());
        }
        restore.compute().unwrap();
        let staging_path = std::path::PathBuf::from(format!("{}.tmp", baseline));
        std::fs::write(&staging_path, b"interrupted staging").unwrap();
        checkpoint.allow_initial = false;
        let denied: serde_json::Value = serde_json::from_str(&checkpoint.compute().unwrap()).unwrap();
        assert_eq!(denied["published"], false);
        assert!(!std::path::Path::new(&baseline).exists());
        assert_eq!(std::fs::read(&staging_path).unwrap(), b"interrupted staging");
        checkpoint.allow_initial = true;
        std::fs::write(&baseline, b"unendorsed interrupted publication").unwrap();
        let orphan: serde_json::Value = serde_json::from_str(&checkpoint.compute().unwrap()).unwrap();
        assert_eq!(orphan["published"], false);
        assert_eq!(std::fs::read(&baseline).unwrap(), b"unendorsed interrupted publication");
        std::fs::remove_file(&baseline).unwrap();
        let first: serde_json::Value = serde_json::from_str(&checkpoint.compute().unwrap()).unwrap();
        assert_eq!(first["published"], true);
        assert_eq!(first["slot"], "a");
        assert!(!staging_path.exists());
        assert_eq!(index.index.read().unwrap().mmap_bytes(), 0);
        assert!(load_endorsed_index(
            &db, std::path::Path::new(&baseline), IndexScope::GlobalTags,
            None, 1, "a", 2, "test",
        ).is_ok());
        storage.submit_write(|tx| {
            tx.execute("UPDATE tag_index_baselines SET file_crc=file_crc+1", [])
                .map_err(|error| error.to_string())?;
            Ok(WriteReceipt {
                operation: "stamp-tamper".into(), database_generation: 0, facts_changed: false,
            })
        }).unwrap();
        assert!(load_endorsed_index(
            &db, std::path::Path::new(&baseline), IndexScope::GlobalTags,
            None, 1, "a", 2, "test",
        ).err().unwrap().contains("file stamp"));
        checkpoint.force = true;
        let repaired: serde_json::Value =
            serde_json::from_str(&checkpoint.compute().unwrap()).unwrap();
        assert_eq!(repaired["published"], false);
        assert_eq!(repaired["generation"], 1);
        std::fs::remove_file(&baseline).unwrap();
        let missing_repaired: serde_json::Value =
            serde_json::from_str(&checkpoint.compute().unwrap()).unwrap();
        assert_eq!(missing_repaired["published"], false);
        assert!(!std::path::Path::new(&baseline).exists());
        // Legacy format does not authorize a zero-drift rewrite either.
        storage.submit_write(|tx| {
            tx.execute("UPDATE tag_index_baselines SET format_version=0", [])
                .map_err(|error| error.to_string())?;
            Ok(WriteReceipt {
                operation: "legacy-fixture".into(), database_generation: 0, facts_changed: false,
            })
        }).unwrap();
        let migrated: serde_json::Value =
            serde_json::from_str(&checkpoint.compute().unwrap()).unwrap();
        assert_eq!(migrated["published"], false);
        assert_eq!(migrated["generation"], 1);
        let active_path = baseline.clone();
        std::fs::write(&active_path, b"truncated vector asset").unwrap();
        let restored: serde_json::Value = serde_json::from_str(&restore.compute().unwrap()).unwrap();
        assert_eq!(restored["rebuilt"], true);
        assert_eq!(restored["vectorCount"], 1);
        assert_eq!(std::fs::read(&active_path).unwrap(), b"truncated vector asset");
        assert!(!std::fs::read_dir(&root).unwrap().any(|entry| {
            entry.unwrap().path().extension().and_then(|value| value.to_str()) == Some("corrupt")
        }));
        storage.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod dirty_vector_tests {
    use super::*;

    #[test]
    fn dirty_rows_are_reported_and_removed_from_baseline_and_live_recovery() {
        let root = std::env::temp_dir().join(format!(
            "kbm-dirty-{}-{}", std::process::id(), now_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db = root.join("test.sqlite").to_string_lossy().into_owned();
        let (storage, _) = crate::storage::SqliteStorageEngine::open_and_init(
            &db, crate::storage::StorageOptions::default(),
        ).unwrap();
        storage.submit_write(|tx| {
            let bytes: Vec<u8> = [1.0_f32,0.0].iter().flat_map(|value| value.to_ne_bytes()).collect();
            for name in ["healthy", "dimension", "nonfinite"] {
                tx.execute("INSERT INTO tags(name,vector) VALUES (?1,?2)",
                    rusqlite::params![name, bytes]).map_err(|error| error.to_string())?;
            }
            Ok(WriteReceipt { operation:"fixture".into(), database_generation:0, facts_changed:true })
        }).unwrap();
        let index = crate::VexusIndex::new(2,16).unwrap();
        let baseline = root.join("tags_a.vec").to_string_lossy().into_owned();
        let mut restore = IndexRestoreTask {
            db_path:db.clone(), index_path:baseline.clone(), index:index.index.clone(),
            content_revision:index.content_revision.clone(), memo_runtime:None,
            scope:IndexScope::GlobalTags, diary_name:None, dimension:2,
            model_sig:"test".into(), capacity:16,
        };
        restore.compute().unwrap();
        IndexCheckpointTask {
            db_path:db.clone(), index_path:baseline, index:index.index.clone(),
            content_revision:index.content_revision.clone(), scope:IndexScope::GlobalTags,
            diary_name:None, dimension:2, model_sig:"test".into(), threshold:0.05, force:true,
            allow_initial: true,
        }.compute().unwrap();
        storage.submit_write(|tx| {
            tx.execute("UPDATE tags SET vector=?1 WHERE id=2", [vec![0_u8;4]])
                .map_err(|error| error.to_string())?;
            let bytes: Vec<u8> = [f32::NAN,0.0].iter().flat_map(|value| value.to_ne_bytes()).collect();
            tx.execute("UPDATE tags SET vector=?1 WHERE id=3", [bytes])
                .map_err(|error| error.to_string())?;
            Ok(WriteReceipt { operation:"dirty".into(), database_generation:0, facts_changed:true })
        }).unwrap();
        let output: serde_json::Value = serde_json::from_str(&restore.compute().unwrap()).unwrap();
        assert_eq!(output["skippedInvalidVectors"], 2);
        assert_eq!(output["vectorCount"], 1);
        assert!(!index.index.read().unwrap().contains(2));
        assert!(!index.index.read().unwrap().contains(3));
        {
            let _gate = crate::publication_gate::acquire(&db, &["global_tags".into()]).unwrap();
            crate::knowledge_runtime::recover_index_snapshot(
                &db, "global_tags".into(), None, &index.index, &index.content_revision, 2,
            ).unwrap();
        }
        assert_eq!(index.index.read().unwrap().size(), 1);
        let warning: String = storage.read(|connection| {
            connection.query_row(
                "SELECT error_message FROM kbm_index_states WHERE scope='global_tags'",
                [], |row| row.get(0),
            ).map_err(|error| error.to_string())
        }).unwrap();
        assert!(warning.contains("\"skippedInvalidVectors\":2"));
        storage.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod failed_endorsement_tests {
    use super::*;

    #[test]
    fn failed_sql_endorsement_preserves_old_baseline_and_pending_drift() {
        let root = std::env::temp_dir().join(format!(
            "kbm-endorsement-failure-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let db = root.join("test.sqlite").to_string_lossy().into_owned();
        let baseline = root.join("tags_a.vec").to_string_lossy().into_owned();
        let (storage, _) = crate::storage::SqliteStorageEngine::open_and_init(
            &db, crate::storage::StorageOptions::default(),
        ).unwrap();
        storage.submit_write(|tx| {
            let bytes = [1_f32, 0.].iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<_>>();
            tx.execute("INSERT INTO tags(name,vector) VALUES ('tag',?1)", [bytes])
                .map_err(|e| e.to_string())?;
            Ok(WriteReceipt { operation:"fixture".into(),database_generation:0,facts_changed:true })
        }).unwrap();
        let index = crate::VexusIndex::new(2, 16).unwrap();
        let mut restore = IndexRestoreTask {
            db_path:db.clone(),index_path:baseline.clone(),index:index.index.clone(),
            content_revision:index.content_revision.clone(),memo_runtime:None,
            scope:IndexScope::GlobalTags,diary_name:None,dimension:2,
            model_sig:"test".into(),capacity:16,
        };
        restore.compute().unwrap();
        let mut checkpoint = IndexCheckpointTask {
            db_path:db.clone(),index_path:baseline.clone(),index:index.index.clone(),
            content_revision:index.content_revision.clone(),scope:IndexScope::GlobalTags,
            diary_name:None,dimension:2,model_sig:"test".into(),threshold:0.05,
            force:false,allow_initial:true,
        };
        checkpoint.compute().unwrap();
        let original = std::fs::read(&baseline).unwrap();
        storage.submit_write(|tx| {
            let bytes = [0_f32, 1.].iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<_>>();
            tx.execute("UPDATE tags SET vector=?1", [bytes]).map_err(|e| e.to_string())?;
            tx.execute_batch(
                "CREATE TRIGGER reject_checkpoint BEFORE INSERT ON tag_index_baselines
                 BEGIN SELECT RAISE(ABORT,'injected endorsement failure'); END;"
            ).map_err(|e| e.to_string())?;
            Ok(WriteReceipt { operation:"change".into(),database_generation:0,facts_changed:true })
        }).unwrap();
        restore.compute().unwrap();
        assert!(checkpoint.compute().unwrap_err().reason.contains("injected endorsement failure"));
        assert!(root.join("tags_b.vec").exists());
        assert_eq!(std::fs::read(&baseline).unwrap(), original);
        let restored: serde_json::Value = serde_json::from_str(&restore.compute().unwrap()).unwrap();
        assert_eq!(restored["generation"], 1);
        assert_eq!(restored["slot"], "a");
        assert_eq!(restored["replayed"], true);
        with_registered_read_transaction(&db, |c| {
            assert_eq!(index.index.read().unwrap().search_sql(c, None, &[0.,1.], 1)
                .map_err(|e| e.to_string())?, vec![(1,1.)]);
            Ok(())
        }).unwrap();
        storage.submit_write(|tx| {
            tx.execute_batch("DROP TRIGGER reject_checkpoint;").map_err(|e| e.to_string())?;
            Ok(WriteReceipt { operation:"end-injection".into(),database_generation:0,facts_changed:false })
        }).unwrap();
        let retried: serde_json::Value = serde_json::from_str(&checkpoint.compute().unwrap()).unwrap();
        assert_eq!(retried["published"], true);
        assert_eq!(retried["generation"], 2);
        assert_eq!(retried["delta"], 1);
        assert_eq!(retried["slot"], "b");
        drop(checkpoint);
        drop(restore);
        drop(index);
        storage.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}