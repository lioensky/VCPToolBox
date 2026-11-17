//! Experimental global Chunk geometry. Scope views never recompute coordinates.
use super::*;
use std::io::Read;
use std::sync::Mutex;
use vcp_tdb_index::index::quiver::hyperbolic::{
    HyperbolicSearchConfig, WarpedFieldConfig, WarpedFieldIndex, warped_size_budget,
};
use vcp_tdb_index::index::quiver::hyperbolic::warped_geometry::WarpedProfile;

const RULE: &str = "chunk-axis-residual-v1";
const MAGIC: &[u8; 8] = b"VCPWC001";
const MAX_BYTES: usize = 512 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 64 * 1024 * 1024;
static SNAPSHOT_IO: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, PartialEq)]
struct Identity {
    database: String,
    model: String,
    facts: String,
    dimension: usize,
    rule: String,
}

#[derive(Serialize, Deserialize)]
struct Header {
    identity: Identity,
    mean: Vec<f64>,
    // Legacy snapshots have no baseline: conservatively score all live rows
    // as deltas until the next training, without silently rebuilding geometry.
    #[serde(default)]
    versions: std::collections::BTreeMap<i64, (i64, i64)>,
}

pub(super) struct WarpedChunks {
    identity: Identity,
    mean: Vec<f64>,
    versions: std::collections::BTreeMap<i64, (i64, i64)>,
    index: WarpedFieldIndex,
}

fn configuration() -> WarpedFieldConfig {
    WarpedFieldConfig {
        profile: WarpedProfile::Softening { alpha: 0.15 },
        radius_max: 0.65, mean_subtract_beta: 0.7,
        throat_phi0: 1.5, angular_scale_kappa: 2.0, adaptive_compass: true,
        ..Default::default()
    }
}

fn norm(row: &[f32]) -> Result<f64, String> {
    let n = row.iter().map(|&v| (v as f64).powi(2)).sum::<f64>().sqrt();
    if row.iter().any(|v| !v.is_finite()) || !n.is_finite() || n <= 1e-12 {
        return Err("WARPED_CHUNK_INVALID_VECTOR".into());
    }
    Ok(n)
}

/// Residual from the global mean axis; experimental centrality, not Tag inbound mass.
fn radius(row: &[f32], mean: &[f64]) -> Result<f32, String> {
    let n = norm(row)?;
    let mn = mean.iter().map(|v| v * v).sum::<f64>().sqrt();
    let alignment = if mn > 1e-12 {
        row.iter().zip(mean).map(|(&v, &m)| v as f64 / n * m / mn).sum::<f64>()
    } else { 0.0 };
    Ok((0.35 + 0.30 * (1.0 - alignment.clamp(-1.0, 1.0).powi(2)).max(0.0).sqrt()) as f32)
}

fn read_vector(connection: &Connection, id: u64, dimension: usize) -> Result<Vec<f32>, String> {
    let mut vector = Vec::with_capacity(dimension);
    let valid = connection.prepare_cached("SELECT vector FROM chunks WHERE id=?1")
        .map_err(|e| e.to_string())?
        .query_row([id as i64], |row|
            crate::index_source::decode_column_into(row, 0, dimension, &mut vector))
        .map_err(|e| e.to_string())?;
    if !valid { return Err(format!("WARPED_CHUNK_INVALID_VECTOR: {id}")); }
    norm(&vector)?;
    Ok(vector)
}

impl WarpedChunks {
    // Managed payload only; excludes BTree allocator/node bookkeeping and RSS.
    fn hot_bytes(&self) -> usize {
        self.index.hot_bytes() + self.mean.capacity() * std::mem::size_of::<f64>()
            + self.versions.len() * std::mem::size_of::<(i64, (i64, i64))>()
    }

    fn path(identity: &Identity) -> Option<PathBuf> {
        if identity.database.is_empty() { return None; }
        let db = Path::new(&identity.database);
        let name = db.file_name()?.to_str()?;
        let digest = format!("{:x}", Sha256::digest(identity.model.as_bytes()));
        Some(db.with_file_name(format!("{name}.chunks-warped-{digest}.vcpwc")))
    }

    fn encode(&self) -> Result<Vec<u8>, String> {
        let header = serde_json::to_vec(&Header {
            identity: Identity {
                database: self.identity.database.clone(), model: self.identity.model.clone(),
                facts: self.identity.facts.clone(), dimension: self.identity.dimension,
                rule: self.identity.rule.clone(),
            },
            mean: self.mean.clone(),
            versions: self.versions.clone(),
        }).map_err(|e| e.to_string())?;
        if header.len() > MAX_HEADER_BYTES {
            return Err("warped Chunk snapshot header exceeds size limit".into());
        }
        let payload = self.index.snapshot_bytes();
        let mut bytes = MAGIC.to_vec();
        bytes.extend_from_slice(&(header.len() as u64).to_le_bytes());
        bytes.extend_from_slice(&header);
        bytes.extend_from_slice(&payload);
        let digest = Sha256::digest(&bytes);
        bytes.extend_from_slice(&digest);
        if bytes.len() > MAX_BYTES { return Err("warped Chunk snapshot exceeds size limit".into()); }
        Ok(bytes)
    }

    fn decode(bytes: &[u8], expected: &Identity) -> Result<Option<Self>, String> {
        if bytes.len() < 48 || bytes.len() > MAX_BYTES || &bytes[..8] != MAGIC {
            return Err("warped Chunk snapshot magic/length".into());
        }
        let end = bytes.len() - 32;
        if Sha256::digest(&bytes[..end])[..] != bytes[end..] {
            return Err("warped Chunk snapshot digest mismatch".into());
        }
        let h = usize::try_from(u64::from_le_bytes(bytes[8..16].try_into().unwrap()))
            .map_err(|_| "warped Chunk header overflow")?;
        if h > MAX_HEADER_BYTES || h > end - 16 {
            return Err("warped Chunk snapshot header length".into());
        }
        let header: Header = serde_json::from_slice(&bytes[16..16+h]).map_err(|e| e.to_string())?;
        // Facts identify the TRAINING baseline, not the current live membership.
        // Daily writes must not turn a valid trained generation into a cache miss.
        if header.identity.database != expected.database || header.identity.model != expected.model
            || header.identity.dimension != expected.dimension || header.identity.rule != expected.rule {
            return Ok(None);
        }
        let index = WarpedFieldIndex::from_snapshot_bytes(&bytes[16+h..end])
            .map_err(|e| e.to_string())?;
        if header.mean.len() != expected.dimension || header.mean.iter().any(|v| !v.is_finite())
            || index.dimension() != expected.dimension
            || index.ids().iter().any(|&id| id == 0 || id > i64::MAX as u64)
            || index.ids().windows(2).any(|w| w[0] >= w[1])
            || (!header.versions.is_empty() && (header.versions.len() != index.ids().len()
                || index.ids().iter().any(|&id| !header.versions.contains_key(&(id as i64)))))
            || index.configuration() != configuration() || index.shell_landmark_count() == 0 {
            return Err("warped Chunk snapshot identity/configuration mismatch".into());
        }
        Ok(Some(Self { identity: header.identity, mean: header.mean, versions: header.versions, index }))
    }

    fn load_or_build(connection: &Connection, identity: Identity, ids: &[u64], force: bool)
        -> Result<(Self, &'static str), String> {
        // Per-table lock is held by LightMemo. This also serializes sidecar publication
        // across independent runtime instances in this process (not across processes).
        let _io = SNAPSHOT_IO.lock().map_err(|e| e.to_string())?;
        let path = Self::path(&identity);
        if let Some(path) = path.as_ref().filter(|_| !force) {
            match std::fs::File::open(path) {
                Ok(file) => {
                    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_BYTES as u64 {
                        return Err("warped Chunk snapshot exceeds size limit".into());
                    }
                    let mut bytes = Vec::new();
                    file.take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
                    if let Some(field) = Self::decode(&bytes, &identity)? {
                        return Ok((field, "snapshot"));
                    }
                },
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
                Err(e) => return Err(e.to_string()),
            }
        }
        let mut mean = vec![0.0; identity.dimension];
        for &id in ids {
            let row = read_vector(connection, id, identity.dimension)?;
            let n = norm(&row)?;
            for (m, &v) in mean.iter_mut().zip(&row) { *m += v as f64 / n; }
        }
        for m in &mut mean { *m /= ids.len().max(1) as f64; }
        let radii = ids.iter().map(|&id|
            radius(&read_vector(connection, id, identity.dimension)?, &mean))
            .collect::<Result<Vec<_>, _>>()?;
        let slots: Vec<_> = (0..ids.len()).collect();
        let mut error = None;
        let mut index = WarpedFieldIndex::build(identity.dimension, ids, &slots, &radii,
            &mean, configuration(), |slot, output| {
                match read_vector(connection, ids[slot], identity.dimension) {
                    Ok(row) => { output.extend(row); true },
                    Err(e) => { error = Some(e); false },
                }
            }).map_err(|e| error.unwrap_or_else(|| e.to_string()))?;
        index.build_shell_landmarks();
        let mut versions = std::collections::BTreeMap::new();
        let mut statement = connection.prepare_cached(
            "SELECT vector_version,file_id FROM chunks WHERE id=?1").map_err(|e|e.to_string())?;
        for &id in ids {
            let version = statement.query_row([id as i64], |r| Ok((r.get(0)?,r.get(1)?)))
                .map_err(|e|e.to_string())?;
            versions.insert(id as i64, version);
        }
        let field = Self { identity, mean, versions, index };
        if let Some(path) = path {
            let bytes = field.encode()?;
            let staging = crate::CheckpointStaging::new(&path).map_err(|e| e.to_string())?;
            std::fs::write(staging.path(), bytes).map_err(|e| e.to_string())?;
            crate::sync_index_file(staging.path()).map_err(|e| e.to_string())?;
            crate::publish_index_file(staging.path(), &path).map_err(|e| e.to_string())?;
        }
        Ok((field, "built"))
    }
}

impl GlobalChunks {
    pub(crate) fn search_warped<P>(&mut self, connection: &Connection, query: &[f32],
        limit: usize, mut admits: P) -> Result<(Vec<(i64, f64)>, serde_json::Value), String>
    where P: FnMut(&ChunkHeader) -> bool {
        if connection.is_autocommit() || query.len() != self.dimension || limit == 0 || limit > 2000 {
            return Err("Invalid warped Chunk query contract".into());
        }
        norm(query)?;
        let started = Instant::now();
        let mut ids: Vec<_> = self.rows.keys().map(|&id| id as u64).collect();
        ids.sort_unstable();
        let allowed: HashSet<_> = self.rows.values().filter(|row| admits(row))
            .map(|row| row.id as u64).collect();
        if ids.is_empty() || allowed.is_empty() {
            return Ok((Vec::new(), serde_json::json!({
                "used":"warped_chunks","source":"empty","scopeChunks":allowed.len(),"rule":RULE,
                "nodes":ids.len(),"executed":false,
                "reason":if ids.is_empty() {"no_valid_global_chunks"} else {"scope_filter_empty"}
            })));
        }
        let prepared = self.prepare_warped(connection, false)?;
        let source = prepared["source"].as_str().unwrap_or("memory");
        let field = self.warped.as_ref().unwrap();
        let load_ms = started.elapsed().as_secs_f64() * 1000.0;
        let qr = radius(query, &field.mean)?;
        let delta: HashSet<_> = allowed.iter().copied().filter(|&id| {
            let row = &self.rows[&(id as i64)];
            field.versions.get(&row.id) != Some(&(row.vector_version, row.file_id))
        }).collect();
        let (max_visits, max_expansions) = warped_size_budget(field.index.ids().len());
        let mut diagnostics = serde_json::json!({
            "used":"warped_chunks","source":source,"rule":RULE,"nodes":field.index.ids().len(),
            "liveNodes":ids.len(),"deltaChunks":delta.len(),"geometryFacts":field.identity.facts,
            "scopeChunks":allowed.len(),"queryRadius":qr,"geometryCheckMs":load_ms,
            "candidateBudget":limit,"hotBytes":field.hot_bytes(),
            "facts":self.facts,"fallback":false
        });
        // A tiny scope is cheaper and more reliable than walking a mostly excluded graph.
        let hits = if allowed.len() <= 128 {
            let mut hits = Vec::with_capacity(allowed.len());
            for &id in &allowed {
                let row = read_vector(connection, id, self.dimension)?;
                let distance = field.index.exact_distance_at_radius(query, qr, &row,
                    radius(&row, &field.mean)?).map_err(|e| e.to_string())?;
                hits.push((id, distance));
            }
            hits.sort_by(|a,b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
            hits.truncate(limit);
            diagnostics["path"] = serde_json::json!("scope-exact-warped");
            diagnostics["coldReads"] = serde_json::json!(allowed.len());
            hits
        } else {
            let mut error = None;
            let output = field.index.search_chunks(query, qr, HyperbolicSearchConfig {
                top_k: limit, width: 128.max(limit * 2), rerank_limit: limit,
                max_visits: max_visits.max(limit * 4),
                max_expansions: max_expansions.max(limit * 2), radial_bound: true,
            }, None, |id| !allowed.contains(&id) || delta.contains(&id), |slot, output| {
                match read_vector(connection, field.index.ids()[slot], self.dimension) {
                    Ok(row) => { output.extend(row); true },
                    Err(e) => { error = Some(e); false },
                }
            }).map_err(|e| e.to_string())?;
            if let Some(error) = error { return Err(error); }
            diagnostics["path"] = serde_json::json!("global-warped-ann");
            diagnostics["visited"] = serde_json::json!(output.stats.visited);
            diagnostics["expanded"] = serde_json::json!(output.stats.expanded);
            diagnostics["coldReads"] = serde_json::json!(output.stats.cold_reads + delta.len());
            // Only live vector deltas read originals here. Memory stays bounded
            // by the candidate budget; no FP32 corpus and no per-write graph build.
            let mut hits = output.neighbors;
            for &id in &delta {
                let row = read_vector(connection, id, self.dimension)?;
                let distance = field.index.exact_distance_at_radius(query, qr, &row,
                    radius(&row, &field.mean)?).map_err(|e|e.to_string())?;
                let hit = (id, distance);
                let position = hits.binary_search_by(|other|
                    other.1.total_cmp(&distance).then(other.0.cmp(&id))).unwrap_or_else(|p|p);
                if position < limit {
                    hits.insert(position, hit);
                    hits.truncate(limit);
                }
            }
            hits
        };
        diagnostics["totalMs"] = serde_json::json!(started.elapsed().as_secs_f64() * 1000.0);
        diagnostics["returned"] = serde_json::json!(hits.len());
        Ok((hits.into_iter().map(|(id,d)| (id as i64,d)).collect(), diagnostics))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(count: usize) -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE kbm_runtime_meta(key TEXT PRIMARY KEY,value TEXT);
             INSERT INTO kbm_runtime_meta VALUES('global_chunk_facts','1');
             CREATE TABLE files(id INTEGER PRIMARY KEY,diary_name TEXT,metadata_version INTEGER);
             INSERT INTO files VALUES(1,'A',1),(2,'B',1);
             CREATE TABLE chunks(id INTEGER PRIMARY KEY,file_id INTEGER,content TEXT,vector BLOB,
                 vector_version INTEGER,metadata_version INTEGER);"
        ).unwrap();
        for id in 1..=count {
            let row = vector(id);
            let bytes: Vec<_> = row.iter().flat_map(|v|v.to_le_bytes()).collect();
            db.execute("INSERT INTO chunks VALUES(?1,?2,'[2026-11-17] Alice',?3,1,1)",
                rusqlite::params![id as i64, if id % 2 == 0 {1} else {2}, bytes]).unwrap();
        }
        db.execute_batch("BEGIN").unwrap();
        db
    }

    fn vector(id: usize) -> Vec<f32> {
        (0..8).map(|j| ((id * 71 + j * 17 + 1) as f64 * 0.37).sin() as f32).collect()
    }

    #[test]
    fn global_geometry_scope_ann_large_budget_snapshot_and_mutations() {
        let db = fixture(160);
        let mut table = GlobalChunks::empty(8,"test").unwrap();
        table.synchronize(&db).unwrap();
        let query = vector(137);
        let (all, stats) = table.search_warped(&db,&query,100,|_|true).unwrap();
        assert_eq!(stats["path"],"global-warped-ann");
        assert_eq!(stats["source"],"built");
        assert_eq!(all.len(),100);
        assert!(all.windows(2).all(|w|w[0].1 <= w[1].1));
        let (scoped, stats) = table.search_warped(&db,&query,100,|r|r.diary=="A").unwrap();
        assert_eq!(stats["path"],"scope-exact-warped");
        assert_eq!(stats["source"],"memory");
        assert_eq!(scoped.len(),80);
        assert!(scoped.iter().all(|h|h.0 % 2 == 0));
        let field = table.warped.as_ref().unwrap();
        let bytes = field.encode().unwrap();
        let restored = WarpedChunks::decode(&bytes,&field.identity).unwrap().unwrap();
        assert_eq!(bytes,restored.encode().unwrap());
        let mut damaged = bytes.clone();
        damaged[32] ^= 1;
        assert!(WarpedChunks::decode(&damaged,&field.identity).is_err());
        table.warped = Some(restored);
        assert_eq!(scoped, table.search_warped(&db,&query,100,|r|r.diary=="A").unwrap().0);
        db.execute_batch(
            "DELETE FROM chunks WHERE id=2;
             UPDATE kbm_runtime_meta SET value='2' WHERE key='global_chunk_facts';"
        ).unwrap();
        assert_eq!(table.synchronize(&db).unwrap(),1);
        assert!(table.warped.is_some());
        let (updated,stats) = table.search_warped(&db,&query,100,|r|r.diary=="A").unwrap();
        assert_eq!(stats["source"],"memory");
        assert_eq!(stats["geometryFacts"],"1");
        assert_eq!(updated.len(),79);
        assert!(updated.iter().all(|h|h.0!=2));
        assert!(table.search_warped(&db,&[f32::NAN;8],10,|_|true).is_err());
        assert!(table.search_warped(&db,&query,2001,|_|true).is_err());
    }

    #[test]
    fn daily_deltas_restart_and_compaction_preserve_trained_geometry_until_training() {
        let root = std::env::temp_dir().join(format!("warped-generation-{}-{}",
            std::process::id(), std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&root).unwrap();
        let source = fixture(160);
        source.execute_batch("COMMIT").unwrap();
        let path = root.join("test.sqlite");
        source.execute("VACUUM INTO ?1", [path.to_str().unwrap()]).unwrap();
        let db = Connection::open(&path).unwrap();
        db.execute_batch("BEGIN").unwrap();
        let mut table = GlobalChunks::empty(8, "test").unwrap();
        table.synchronize(&db).unwrap();
        table.prepare_warped(&db, false).unwrap();
        let field = table.warped.as_ref().unwrap();
        let sidecar = WarpedChunks::path(&field.identity).unwrap();
        let original = std::fs::read(&sidecar).unwrap();
        let modified = std::fs::metadata(&sidecar).unwrap().modified().unwrap();
        let frozen = field.encode().unwrap();
        let query = vector(997);
        let bytes: Vec<_> = query.iter().flat_map(|v|v.to_le_bytes()).collect();
        db.execute_batch("DELETE FROM chunks WHERE id=2").unwrap();
        db.execute("UPDATE chunks SET vector=?1,vector_version=2 WHERE id=3", [&bytes]).unwrap();
        db.execute("INSERT INTO chunks VALUES(161,2,'[2026-11-17] new',?1,1,1)", [&bytes]).unwrap();
        db.execute_batch(
            "UPDATE chunks SET content='metadata only',metadata_version=2 WHERE id=4;
             UPDATE kbm_runtime_meta SET value='2' WHERE key='global_chunk_facts';"
        ).unwrap();
        table.synchronize(&db).unwrap();
        let (expected, stats) = table.search_warped(&db, &query, 100, |_|true).unwrap();
        assert_eq!(stats["source"], "memory");
        assert_eq!(stats["path"], "global-warped-ann");
        assert_eq!(stats["deltaChunks"], 2);
        assert_eq!(stats["geometryFacts"], "1");
        assert_eq!(stats["facts"], "2");
        assert!(expected.iter().any(|h|h.0==3));
        assert!(expected.iter().any(|h|h.0==161));
        assert!(!expected.iter().any(|h|h.0==2));
        assert_eq!(expected[0].0, 3);
        assert_eq!(expected[1].0, 161);
        assert_eq!(table.warped.as_ref().unwrap().encode().unwrap(), frozen);
        let (scoped, stats) = table.search_warped(&db, &query, 100, |r|r.diary=="B").unwrap();
        assert_eq!(stats["path"], "scope-exact-warped");
        assert!(scoped.iter().any(|h|h.0==161));
        assert_eq!(std::fs::read(&sidecar).unwrap(), original);
        assert_eq!(std::fs::metadata(&sidecar).unwrap().modified().unwrap(), modified);

        db.execute_batch("COMMIT").unwrap();
        drop(table);
        drop(db);
        let db = Connection::open(&path).unwrap();
        db.execute_batch("BEGIN").unwrap();
        let mut restored = GlobalChunks::empty(8, "test").unwrap();
        restored.synchronize(&db).unwrap();
        let (actual, stats) = restored.search_warped(&db, &query, 100, |_|true).unwrap();
        assert_eq!(stats["source"], "snapshot");
        assert_eq!(expected, actual);
        assert_eq!(restored.warped.as_ref().unwrap().encode().unwrap(), frozen);
        assert_eq!(std::fs::read(&sidecar).unwrap(), original);
        assert_eq!(std::fs::metadata(&sidecar).unwrap().modified().unwrap(), modified);

        // Routing compaction must not reset the field or its baseline.
        db.execute_batch(
            "UPDATE chunks SET vector_version=vector_version+1 WHERE id<=100;
             UPDATE kbm_runtime_meta SET value='3' WHERE key='global_chunk_facts';"
        ).unwrap();
        restored.synchronize(&db).unwrap();
        let before = restored.routing.len();
        restored.compact_if_needed(&db).unwrap();
        assert!(restored.routing.len() < before);
        assert_eq!(restored.warped.as_ref().unwrap().encode().unwrap(), frozen);
        let (_, stats) = restored.search_warped(&db, &query, 100, |_|true).unwrap();
        assert_eq!(stats["source"], "memory");
        assert_eq!(stats["geometryFacts"], "1");
        assert_eq!(std::fs::read(&sidecar).unwrap(), original);

        let trained = restored.prepare_warped(&db, true).unwrap();
        assert_eq!(trained["source"], "built");
        assert_eq!(trained["geometryFacts"], "3");
        assert_ne!(std::fs::read(&sidecar).unwrap(), original);
        let (_, stats) = restored.search_warped(&db, &query, 100, |_|true).unwrap();
        assert_eq!(stats["source"], "memory");
        assert_eq!(stats["deltaChunks"], 0);
        drop(restored);
        drop(db);
        drop(source);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_baseline_is_conservative_and_invalid_version_coverage_is_rejected() {
        let db = fixture(160);
        let mut table = GlobalChunks::empty(8, "test").unwrap();
        table.synchronize(&db).unwrap();
        table.prepare_warped(&db, false).unwrap();
        let field = table.warped.as_ref().unwrap();
        let original = field.encode().unwrap();
        let h = u64::from_le_bytes(original[8..16].try_into().unwrap()) as usize;
        let mut header: serde_json::Value = serde_json::from_slice(&original[16..16+h]).unwrap();
        header.as_object_mut().unwrap().remove("versions");
        let header = serde_json::to_vec(&header).unwrap();
        let mut legacy = MAGIC.to_vec();
        legacy.extend_from_slice(&(header.len() as u64).to_le_bytes());
        legacy.extend_from_slice(&header);
        legacy.extend_from_slice(&original[16+h..original.len()-32]);
        let digest = Sha256::digest(&legacy);
        legacy.extend_from_slice(&digest);
        let restored = WarpedChunks::decode(&legacy, &field.identity).unwrap().unwrap();
        assert!(restored.versions.is_empty());
        assert_eq!(restored.mean, field.mean);
        table.warped = Some(restored);
        let query = vector(997);
        let bytes: Vec<_> = query.iter().flat_map(|v|v.to_le_bytes()).collect();
        db.execute("UPDATE chunks SET vector=?1,vector_version=2 WHERE id=3", [&bytes]).unwrap();
        db.execute_batch(
            "DELETE FROM chunks WHERE id=2;
             UPDATE kbm_runtime_meta SET value='2' WHERE key='global_chunk_facts';"
        ).unwrap();
        table.synchronize(&db).unwrap();
        let (hits, stats) = table.search_warped(&db, &query, 100, |_|true).unwrap();
        assert_eq!(stats["source"], "memory");
        assert_eq!(stats["deltaChunks"], 159);
        assert_eq!(hits[0].0, 3);
        assert!(!hits.iter().any(|h|h.0==2));
        table.prepare_warped(&db, true).unwrap();
        let field = table.warped.as_mut().unwrap();
        field.versions.pop_first();
        assert!(WarpedChunks::decode(&field.encode().unwrap(), &field.identity).is_err());
    }

    #[test]
    fn empty_singleton_and_file_snapshot_restore() {
        for count in [0,1] {
            let db=fixture(count);
            let mut table=GlobalChunks::empty(8,"test").unwrap();
            table.synchronize(&db).unwrap();
            assert_eq!(table.search_warped(&db,&vector(1),5,|_|true).unwrap().0.len(),count);
        }
        let root=std::env::temp_dir().join(format!("warped-chunks-{}-{}",
            std::process::id(),std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&root).unwrap();
        let source=fixture(24);
        source.execute_batch("COMMIT").unwrap();
        let path=root.join("test.sqlite");
        source.execute("VACUUM INTO ?1",[path.to_str().unwrap()]).unwrap();
        let db=Connection::open(&path).unwrap();
        db.execute_batch("BEGIN").unwrap();
        let run=|table:&mut GlobalChunks| {
            table.synchronize(&db).unwrap();
            table.search_warped(&db,&vector(3),10,|_|true).unwrap()
        };
        let mut first=GlobalChunks::empty(8,"test").unwrap();
        let (expected,stats)=run(&mut first);
        assert_eq!(stats["source"],"built");
        let mut second=GlobalChunks::empty(8,"test").unwrap();
        let (actual,stats)=run(&mut second);
        assert_eq!(stats["source"],"snapshot");
        assert_eq!(expected,actual);
        assert_eq!(second.prepare_warped(&db,false).unwrap()["source"],"memory");
        assert_eq!(second.prepare_warped(&db,true).unwrap()["source"],"built");
        let sidecar = WarpedChunks::path(&second.warped.as_ref().unwrap().identity).unwrap();
        std::fs::write(&sidecar,b"damaged-derived-file").unwrap();
        let mut repair = GlobalChunks::empty(8,"test").unwrap();
        repair.synchronize(&db).unwrap();
        assert!(repair.prepare_warped(&db,false).is_err());
        assert_eq!(repair.prepare_warped(&db,true).unwrap()["source"],"built");
        assert_eq!(repair.search_warped(&db,&vector(3),10,|_|true).unwrap().0,expected);
        db.execute_batch(
            "UPDATE chunks SET metadata_version=2 WHERE id=3;
             UPDATE kbm_runtime_meta SET value='2' WHERE key='global_chunk_facts';"
        ).unwrap();
        assert_eq!(run(&mut second).1["source"],"memory");
        drop(first);drop(second);drop(db);drop(source);
        std::fs::remove_dir_all(root).unwrap();
    }
}

impl GlobalChunks {
    pub(crate) fn prepare_warped(&mut self, connection: &Connection, force: bool)
        -> Result<serde_json::Value, String> {
        if connection.is_autocommit() { return Err("warped preparation requires a read transaction".into()); }
        let started = Instant::now();
        let mut ids: Vec<_> = self.rows.keys().map(|&id|id as u64).collect();
        ids.sort_unstable();
        if ids.is_empty() {
            // An empty live scope does not retire the mathematical generation.
            return Ok(serde_json::json!({
                "ready":false,"source":"empty","nodes":0,"reason":"no_valid_global_chunks","forced":force
            }));
        }
        let source = if self.warped.is_some() && !force { "memory" } else {
            let database = connection.query_row("PRAGMA database_list", [], |r|r.get(2))
                .map_err(|e|e.to_string())?;
            let identity = Identity { database, model:self.model.clone(),facts:self.facts.clone(),
                dimension:self.dimension,rule:RULE.into() };
            let (field,source) = WarpedChunks::load_or_build(connection,identity,&ids,force)?;
            self.warped = Some(field);
            source
        };
        Ok(serde_json::json!({
            "ready":true,"source":source,"nodes":self.warped.as_ref().unwrap().index.ids().len(),
            "liveNodes":ids.len(),"rule":RULE,"forced":force,
            "facts":self.facts,"geometryFacts":self.warped.as_ref().unwrap().identity.facts,
            "elapsedMs":started.elapsed().as_secs_f64()*1000.,
            "hotBytes":self.warped.as_ref().unwrap().hot_bytes()
        }))
    }

    pub(crate) fn warped_stats(&self) -> serde_json::Value {
        match self.warped.as_ref() {
            Some(field) => serde_json::json!({
                "resident":true,"nodes":field.index.ids().len(),"rule":RULE,
                "hotBytes":field.hot_bytes(),
                "facts":field.identity.facts
            }),
            None => serde_json::json!({"resident":false,"nodes":0,"hotBytes":0,"rule":RULE}),
        }
    }
}