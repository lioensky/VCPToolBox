//! SQL-authoritative, graph-free global Chunk retrieval asset.
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Instant;
use vcp_tdb_index::index::quiver::corrected_sm::CorrectedSmIndex;

const MAGIC: &[u8; 8] = b"VCPGCH01";

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct ChunkHeader {
    pub id: i64,
    pub file_id: i64,
    pub diary: String,
    pub first_line: String,
    pub date: u32,
    vector_version: i64,
    metadata_version: i64,
    file_version: i64,
    slot: usize,
}

#[derive(Serialize, Deserialize)]
struct Snapshot {
    dimension: usize,
    model: String,
    facts: String,
    rows: Vec<ChunkHeader>,
    routing: Vec<u8>,
}

pub(crate) struct GlobalChunks {
    pub rows: HashMap<i64, ChunkHeader>,
    routing: CorrectedSmIndex,
    dimension: usize,
    model: String,
    facts: String,
    pub last_used: Instant,
    dirty: usize,
    baseline_count: usize,
    checkpointed: bool,
}

fn facts(connection: &Connection) -> Result<String, String> {
    connection.query_row(
        "SELECT value FROM kbm_runtime_meta WHERE key='global_chunk_facts'",
        [], |row| row.get(0),
    ).map_err(|e| e.to_string())
}

fn chunk_date(content: &str) -> u32 {
    static DATE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let expression = DATE.get_or_init(|| regex::Regex::new(
        r"(20[0-9]{2})[-./]([0-9]{1,2})(?:[-./]([0-9]{1,2}))?"
    ).unwrap());
    // Match JavaScript substring(0,100), which counts UTF-16 code units.
    let prefix = String::from_utf16_lossy(&content.encode_utf16().take(100).collect::<Vec<_>>());
    let Some(captures) = expression.captures(&prefix) else { return 0; };
    let number = |position| captures.get(position)
        .and_then(|m| m.as_str().parse::<u32>().ok()).unwrap_or(1);
    number(1) * 10000 + number(2) * 100 + number(3)
}

impl GlobalChunks {
    pub fn empty(dimension: usize, model: &str) -> Result<Self, String> {
        Ok(Self {
            rows: HashMap::new(),
            routing: CorrectedSmIndex::empty_flat(dimension).map_err(|e| e.to_string())?,
            dimension, model: model.into(), facts: String::new(),
            last_used: Instant::now(), dirty: 0, baseline_count: 0, checkpointed: false,
        })
    }

    pub fn matches_model(&self, dimension: usize, model: &str) -> bool {
        self.dimension == dimension && self.model == model
    }

    pub fn compact_if_needed(&mut self, connection: &Connection) -> Result<(), String> {
        if self.routing.len() > self.rows.len().saturating_add(64)
            && self.routing.len() > self.rows.len().saturating_mul(5) / 4 {
            let mut replacement = Self::empty(self.dimension, &self.model)?;
            replacement.synchronize(connection)?;
            replacement.dirty = replacement.rows.len().max(1);
            *self = replacement;
        }
        Ok(())
    }

    /// Caller supplies one frozen SQL read transaction. No full FP32 matrix is collected.
    pub fn synchronize(&mut self, connection: &Connection) -> Result<usize, String> {
        self.last_used = Instant::now();
        let current = facts(connection)?;
        if current == self.facts { return Ok(0); }
        let mut statement = connection.prepare(
            "SELECT c.id,c.vector_version,c.metadata_version,f.metadata_version
             FROM chunks c JOIN files f ON f.id=c.file_id WHERE c.vector IS NOT NULL"
        ).map_err(|e| e.to_string())?;
        let versions = statement.query_map([], |row| Ok((
            row.get::<_, i64>(0)?, row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?, row.get::<_, i64>(3)?,
        ))).map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?;
        let live = versions.iter().map(|v| v.0).collect::<HashSet<_>>();
        let before = self.rows.len();
        self.rows.retain(|id, _| live.contains(id));
        let mut changed = before - self.rows.len();
        let mut metadata = connection.prepare(
            "SELECT c.file_id,c.content,f.diary_name FROM chunks c
             JOIN files f ON f.id=c.file_id WHERE c.id=?1"
        ).map_err(|e| e.to_string())?;
        let mut vector = connection.prepare("SELECT vector FROM chunks WHERE id=?1")
            .map_err(|e| e.to_string())?;
        for (id, vv, mv, fv) in versions {
            let old = self.rows.get(&id);
            if old.is_some_and(|old| old.vector_version == vv
                && old.metadata_version == mv && old.file_version == fv) { continue; }
            let vector_changed = old.is_none_or(|old| old.vector_version != vv);
            let previous_slot = old.map(|old| old.slot);
            let slot = if vector_changed {
                let bytes: Vec<u8> = vector.query_row([id], |row| row.get(0))
                    .map_err(|e| e.to_string())?;
                if bytes.len() != self.dimension * 4 {
                    self.rows.remove(&id);
                    changed += 1;
                    continue;
                }
                let values = bytes.chunks_exact(4)
                    .map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect::<Vec<_>>();
                if values.iter().any(|v| !v.is_finite()) {
                    self.rows.remove(&id);
                    changed += 1;
                    continue;
                }
                let slot = self.routing.len();
                self.routing.push_flat_vector(&values, id as u64).map_err(|e| e.to_string())?;
                slot
            } else { previous_slot.unwrap() };
            let (file_id, content, diary): (i64, String, String) =
                metadata.query_row([id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                    .map_err(|e| e.to_string())?;
            self.rows.insert(id, ChunkHeader {
                id, file_id, diary,
                first_line: content.split('\n').next().unwrap_or_default().trim().into(),
                date: chunk_date(&content),
                vector_version: vv, metadata_version: mv, file_version: fv, slot,
            });
            changed += 1;
        }
        self.dirty += changed;
        self.facts = current;
        Ok(changed)
    }

    pub fn search(&self, query: &[f32], limit: usize, allowed: &HashSet<i64>)
        -> Result<Vec<i64>, String> {
        self.routing.search_flat_filtered(query, limit, |slot, id| {
            allowed.contains(&(id as i64))
                && self.rows.get(&(id as i64)).is_some_and(|row| row.slot == slot)
        }).map(|hits| hits.into_iter().map(|hit| hit.0 as i64).collect())
            .map_err(|e| e.to_string())
    }

    pub fn needs_checkpoint(&self) -> bool {
        !self.checkpointed || self.dirty as f64
            / self.baseline_count.max(self.rows.len()).max(1) as f64 >= 0.05
    }

    pub fn load(connection: &Connection, directory: &Path, dimension: usize, model: &str)
        -> Result<Self, String> {
        let manifest: Option<(String, i64, String)> = connection.query_row(
            "SELECT slot,file_size,file_digest FROM global_chunk_index_baselines
             WHERE dimension=?1 AND model_sig=?2 AND format_version=1
             ORDER BY generation DESC LIMIT 1",
            rusqlite::params![dimension as i64, model],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional().map_err(|e| e.to_string())?;
        let Some((slot, size, digest)) = manifest else { return Self::empty(dimension, model); };
        let loaded: Result<Self, String> = (|| {
            if !matches!(slot.as_str(), "a" | "b") { return Err("invalid Chunk slot".into()); }
            let bytes = std::fs::read(slot_path(directory, &slot)).map_err(|e| e.to_string())?;
            if bytes.len() as i64 != size || bytes.len() < 8 || &bytes[..8] != MAGIC
                || format!("{:x}", Sha256::digest(&bytes)) != digest {
                return Err("global Chunk asset stamp mismatch".into());
            }
            use bincode::Options;
            let snapshot: Snapshot = bincode::DefaultOptions::new().with_fixint_encoding()
                .with_limit(bytes.len() as u64).reject_trailing_bytes()
                .deserialize(&bytes[8..]).map_err(|e| e.to_string())?;
            if snapshot.dimension != dimension || snapshot.model != model {
                return Err("global Chunk asset identity mismatch".into());
            }
            let routing = CorrectedSmIndex::from_routing_snapshot_bytes(&snapshot.routing)
                .map_err(|e| e.to_string())?;
            if routing.dimension() != dimension
                || snapshot.rows.iter().any(|row| row.id <= 0 || row.slot >= routing.len())
                || snapshot.rows.iter().map(|row| row.id).collect::<HashSet<_>>().len()
                    != snapshot.rows.len() {
                return Err("global Chunk metadata shape mismatch".into());
            }
            let count = snapshot.rows.len();
            Ok(Self {
                rows: snapshot.rows.into_iter().map(|row| (row.id, row)).collect(),
                routing, dimension, model: model.into(), facts: snapshot.facts,
                last_used: Instant::now(), dirty: 0, baseline_count: count, checkpointed: true,
            })
        })();
        match loaded {
            Ok(table) => Ok(table),
            Err(error) => {
                eprintln!("[LightMemo] Global Chunk asset rejected; rebuilding from SQL: {error}");
                Self::empty(dimension, model)
            }
        }
    }

    /// No read connection is held here. File publication precedes Write Actor endorsement.
    pub fn checkpoint(&mut self, db_path: &str, directory: &Path, database_generation: u64)
        -> Result<(), String> {
        let (generation, active): (i64, String) =
            crate::storage::with_registered_read(db_path, |connection| {
                connection.query_row(
                    "SELECT generation,slot FROM global_chunk_index_baselines
                     ORDER BY generation DESC LIMIT 1", [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                ).optional().map(|row| row.unwrap_or((0, String::new())))
                    .map_err(|e| e.to_string())
            })?;
        let slot = if active == "a" { "b" } else { "a" };
        let mut rows = self.rows.values().cloned().collect::<Vec<_>>();
        rows.sort_by_key(|row| row.id);
        let snapshot = Snapshot {
            dimension: self.dimension, model: self.model.clone(), facts: self.facts.clone(),
            rows, routing: self.routing.routing_snapshot_bytes().map_err(|e| e.to_string())?,
        };
        let mut bytes = MAGIC.to_vec();
        bytes.extend(bincode::serialize(&snapshot).map_err(|e| e.to_string())?);
        let size = bytes.len() as i64;
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let target = slot_path(directory, slot);
        let temp = crate::unique_index_sidecar_path(&target, "tmp");
        let published = (|| {
            std::fs::write(&temp, bytes).map_err(|e| e.to_string())?;
            crate::sync_index_file(&temp).map_err(|e| e.to_string())?;
            crate::publish_index_file(&temp, &target).map_err(|e| e.to_string())
        })();
        if published.is_err() { let _ = std::fs::remove_file(&temp); }
        published?;
        let dimension = self.dimension as i64;
        let model = self.model.clone();
        let captured_facts = self.facts.clone();
        crate::storage::with_registered_write(db_path, move |tx| {
            if facts(tx)? != captured_facts {
                return Err("LIGHTMEMO_CHECKPOINT_GENERATION_CONFLICT".into());
            }
            tx.execute(
                "INSERT INTO global_chunk_index_baselines
                 (generation,slot,dimension,model_sig,database_generation,format_version,
                  file_size,file_digest,created_at) VALUES (?1,?2,?3,?4,?5,1,?6,?7,?8)",
                rusqlite::params![generation + 1, slot, dimension, model,
                    database_generation.to_string(), size, digest,
                    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default().as_millis() as i64],
            ).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM global_chunk_index_baselines WHERE generation<?1",
                [generation + 1]).map_err(|e| e.to_string())?;
            Ok(crate::storage::WriteReceipt {
                operation: "checkpoint_global_chunks".into(), database_generation: 0, facts_changed: false,
            })
        })?;
        self.dirty = 0;
        self.baseline_count = self.rows.len();
        self.checkpointed = true;
        Ok(())
    }
}

fn slot_path(directory: &Path, slot: &str) -> PathBuf {
    directory.join(format!("index_global_chunks_{slot}.vec"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generations_checkpoint_reload_and_corruption_recover_without_embeddings() {
        let root = std::env::temp_dir().join(format!("lightmemo-global-{}-{}",
            std::process::id(), std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&root).unwrap();
        let db = root.join("test.sqlite").to_string_lossy().into_owned();
        let (storage, _) = crate::storage::SqliteStorageEngine::open_and_init(
            &db, crate::storage::StorageOptions::default()).unwrap();
        storage.submit_write(|tx| {
            tx.execute_batch("INSERT INTO files(id,path,diary_name,checksum,mtime,size)
                VALUES (1,'test.txt','Diary','hash',0,0);").map_err(|e| e.to_string())?;
            let bytes = [1_f32,0.].iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<_>>();
            tx.execute("INSERT INTO chunks(id,file_id,chunk_index,content,vector)
                VALUES (1,1,0,'[2026-10-19] Alice',?1)", [bytes]).map_err(|e| e.to_string())?;
            Ok(crate::storage::WriteReceipt {
                operation:"fixture".into(),database_generation:0,facts_changed:true,
            })
        }).unwrap();
        let mut table = GlobalChunks::empty(2,"model").unwrap();
        crate::storage::with_registered_read_transaction(&db, |connection| {
            assert_eq!(table.synchronize(connection)?,1);
            assert_eq!(table.synchronize(connection)?,0);
            assert_eq!(table.rows[&1].date,20261019);
            Ok(())
        }).unwrap();
        table.checkpoint(&db,&root,1).unwrap();
        let mut restored = crate::storage::with_registered_read_transaction(&db,
            |c| GlobalChunks::load(c,&root,2,"model")).unwrap();
        assert_eq!(restored.search(&[1.,0.],5,&HashSet::from([1])).unwrap(),vec![1]);
        storage.submit_write(|tx| {
            let bytes = [0_f32,1.].iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<_>>();
            tx.execute("UPDATE chunks SET vector=?1,content='[2026/11] Bob' WHERE id=1",
                [bytes]).map_err(|e|e.to_string())?;
            Ok(crate::storage::WriteReceipt {
                operation:"change".into(),database_generation:0,facts_changed:true,
            })
        }).unwrap();
        crate::storage::with_registered_read_transaction(&db, |c| {
            assert_eq!(restored.synchronize(c)?,1);
            assert_eq!(restored.rows[&1].date,20261101);
            assert!(restored.rows[&1].first_line.contains("Bob"));
            Ok(())
        }).unwrap();
        restored.checkpoint(&db,&root,2).unwrap();
        std::fs::write(root.join("index_global_chunks_b.vec"),b"broken").unwrap();
        let mut rebuilt = crate::storage::with_registered_read_transaction(&db,
            |c| GlobalChunks::load(c,&root,2,"model")).unwrap();
        crate::storage::with_registered_read_transaction(&db, |c| {
            assert_eq!(rebuilt.synchronize(c)?,1); Ok(())
        }).unwrap();
        storage.submit_write(|tx| {
            tx.execute("DELETE FROM chunks",[]).map_err(|e|e.to_string())?;
            Ok(crate::storage::WriteReceipt {
                operation:"delete".into(),database_generation:0,facts_changed:true,
            })
        }).unwrap();
        crate::storage::with_registered_read_transaction(&db, |c| {
            rebuilt.synchronize(c)?;
            assert!(rebuilt.rows.is_empty()); Ok(())
        }).unwrap();
        storage.shutdown().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}