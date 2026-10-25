//! Host ownership for the single TDB retrieval backend.
//! SQL facts and mathematical vector reads never depend on this object.
use crate::index_source::SqlIndexBuild;
use sha2::{Digest, Sha256};
use std::io;
use std::path::{Path, PathBuf};
use vcp_tdb_index::asset::AssetIdentity;
use vcp_tdb_index::engine::TdbIndex;

/// Query-local exclusion and navigation controls.
#[derive(Clone, serde::Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RetrievalSearchOptions {
    pub exclude_ids: std::collections::HashSet<u64>,
    pub ef_search: Option<usize>,
}

impl Default for RetrievalSearchOptions {
    fn default() -> Self { Self { exclude_ids: std::collections::HashSet::new(), ef_search: None } }
}
impl RetrievalSearchOptions {
    pub(crate) fn validate(&self) -> io::Result<()> {
        if self.exclude_ids.len() > 100_000 || self.exclude_ids.iter().any(|id| *id == 0 || *id > i64::MAX as u64)
            || self.ef_search.is_some_and(|v| v == 0 || v > 65_536)
        { return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid retrieval search options")); }
        Ok(())
    }
    pub(crate) fn kernel(&self) -> vcp_tdb_index::engine::SearchOptions {
        vcp_tdb_index::engine::SearchOptions { ef_search: self.ef_search }
    }
}

pub(crate) struct RetrievalIndex {
    // Explicit Option permits releasing the mmap before private-file cleanup.
    inner: Option<TdbIndex>,
    identity: AssetIdentity,
    private_path: Option<PathBuf>,
    reserved: usize,
    sql_owned: bool,
}

impl RetrievalIndex {
    pub(crate) fn empty(dimension: usize) -> io::Result<Self> {
        Ok(Self {
            inner: Some(TdbIndex::empty(dimension)?),
            identity: AssetIdentity {
                dimension, scope: 0, model_hash: [0; 32], content_digest: [0; 32],
            },
            private_path: None,
            reserved: 0,
            sql_owned: false,
        })
    }

    pub(crate) fn from_sql(build: SqlIndexBuild) -> Self {
        let (index, path, identity, _) = build.into_parts();
        let reserved = index.len();
        let private_path = (!path.as_os_str().is_empty()).then_some(path);
        let sql_owned = private_path.is_none();
        Self { inner: Some(index), identity, private_path, reserved, sql_owned }
    }

    /// Explicit standalone API only. Runtime restores must supply SQL endorsement.
    pub(crate) fn load_standalone(path: &Path, dimension: usize) -> io::Result<Self> {
        use std::io::Read;
        let mut header = [0_u8; 96];
        std::fs::File::open(path)?.read_exact(&mut header)?;
        let identity = AssetIdentity {
            dimension,
            scope: header[24],
            model_hash: header[32..64].try_into().unwrap(),
            content_digest: header[64..96].try_into().unwrap(),
        };
        Self::load(path, identity)
    }

    pub(crate) fn load(path: &Path, expected: AssetIdentity) -> io::Result<Self> {
        let index = TdbIndex::load_snapshot(path, &expected)?;
        let reserved = index.len();
        Ok(Self { inner: Some(index), identity: expected, private_path: None, reserved, sql_owned: false })
    }

    pub(crate) fn from_validated_asset(
        asset: vcp_tdb_index::asset::VectorAsset,
    ) -> io::Result<Self> {
        let identity = asset.identity().clone();
        let index = TdbIndex::from_validated_asset(asset)?;
        let reserved = index.len();
        Ok(Self { inner: Some(index), identity, private_path: None, reserved, sql_owned: true })
    }

    fn core(&self) -> &TdbIndex {
        self.inner.as_ref().expect("retrieval index is live until Drop")
    }

    fn core_mut(&mut self) -> &mut TdbIndex {
        self.inner.as_mut().expect("retrieval index is live until Drop")
    }

    pub(crate) fn identity(&self) -> &AssetIdentity { &self.identity }
    pub(crate) fn size(&self) -> usize { self.core().len() }
    pub(crate) fn dimensions(&self) -> usize { self.identity.dimension }
    pub(crate) fn capacity(&self) -> usize { self.reserved.max(self.size()) }
    pub(crate) fn memory_usage(&self) -> usize { self.core().hot_bytes() }
    pub(crate) fn mmap_bytes(&self) -> usize { self.core().mapped_bytes() }
    pub(crate) fn tombstones(&self) -> usize { self.core().tombstones() }
    #[cfg(test)]
    pub(crate) fn contains(&self, id: u64) -> bool { self.core().contains(id) }

    pub(crate) fn maintenance_required(&self) -> bool {
        // A publication threshold measures SQL drift, not routing health or
        // heap residency. Repeated updates of one ID may leave little SQL drift.
        const MAX_DELTA_BYTES: usize = 16 * 1024 * 1024;
        self.core().needs_graph_rebuild() || self.core().delta_bytes() >= MAX_DELTA_BYTES
    }

    /// Existing host capacity arguments are absolute, unlike Vec::reserve.
    pub(crate) fn reserve(&mut self, capacity: usize) -> io::Result<()> {
        if capacity > self.reserved {
            let additional = capacity.saturating_sub(self.size());
            self.core_mut().reserve(additional)?;
            self.reserved = capacity;
        }
        Ok(())
    }

    pub(crate) fn apply_delta(
        &mut self, removes: &[u64], upserts: &[u64], vectors: &[f32],
    ) -> io::Result<usize> {
        let removed = self.core_mut().apply_delta(removes, upserts, vectors)?;
        // A mutation invalidates the previous snapshot digest; a checkpoint must
        // provide a fresh SQL-derived identity, not reuse the old endorsement.
        if removed > 0 || !upserts.is_empty() {
            self.identity.content_digest = [0; 32];
        }
        Ok(removed)
    }

    pub(crate) fn add(&mut self, id: u64, vector: &[f32]) -> io::Result<()> {
        self.apply_delta(&[], &[id], vector).map(|_| ())
    }

    pub(crate) fn remove(&mut self, id: u64) -> io::Result<usize> {
        self.apply_delta(&[id], &[], &[])
    }

    /// Runtime routing no longer retains startup snapshot originals.
    pub(crate) fn release_originals(&mut self) {
        self.sql_owned = true;
        self.core_mut().release_originals();
    }

    pub(crate) fn search(&self, query: &[f32], k: usize) -> io::Result<Vec<(u64, f32)>> {
        if self.sql_owned {
            return Err(io::Error::other("SQL-owned routing requires a Runtime SQL query"));
        }
        self.core().search(query, k, None)
    }

    pub(crate) fn search_options(&self, query: &[f32], k: usize, options: &RetrievalSearchOptions)
        -> io::Result<Vec<(u64, f32)>> {
        options.validate()?;
        if self.sql_owned { return Err(io::Error::other("SQL-owned routing requires a Runtime SQL query")); }
        self.core().search_with_options(query, k, &options.kernel(), &|id| options.exclude_ids.contains(&id))
    }

    /// The caller owns the read transaction and scope gate. No new connection,
    /// snapshot file read, or retained original-vector cache is introduced.
    pub(crate) fn search_sql(
        &self,
        connection: &rusqlite::Connection,
        diary: Option<&str>,
        query: &[f32],
        k: usize,
    ) -> io::Result<Vec<(u64, f32)>> {
        self.search_sql_options(connection, diary, query, k, &RetrievalSearchOptions::default())
    }

    pub(crate) fn search_sql_options(
        &self,
        connection: &rusqlite::Connection,
        diary: Option<&str>,
        query: &[f32],
        k: usize,
        options: &RetrievalSearchOptions,
    ) -> io::Result<Vec<(u64, f32)>> {
        options.validate()?;
        if connection.is_autocommit() {
            return Err(io::Error::other("SQL retrieval requires an active read transaction"));
        }
        let sql = if diary.is_some() {
            "SELECT c.vector FROM chunks c JOIN files f ON f.id=c.file_id
             WHERE c.id=?1 AND f.diary_name=?2"
        } else {
            "SELECT vector FROM tags WHERE id=?1 AND ?2 IS NULL"
        };
        let mut statement = connection.prepare_cached(sql).map_err(io::Error::other)?;
        let dimension = self.dimensions();
        let mut source_error = None;
        let result = self.core().search_with_source_options(query, k, &options.kernel(),
            &|id| options.exclude_ids.contains(&id), |id, output| {
            use rusqlite::OptionalExtension;
            output.clear();
            let bytes = statement.query_row(
                rusqlite::params![id as i64, diary],
                |row| row.get::<_, Option<Vec<u8>>>(0),
            ).optional();
            match bytes {
                Ok(Some(Some(bytes))) if bytes.len() == dimension * 4 => {
                    output.extend(bytes.chunks_exact(4)
                        .map(|part| f32::from_le_bytes(part.try_into().unwrap())));
                    output.iter().all(|value| value.is_finite())
                }
                Ok(_) => false,
                Err(error) => {
                    source_error = Some(error);
                    false
                }
            }
        });
        if let Some(error) = source_error {
            return Err(io::Error::other(error));
        }
        result
    }

    pub(crate) fn write_staging(
        &self, path: &Path, identity: &AssetIdentity,
    ) -> io::Result<()> {
        if self.sql_owned {
            return Err(io::Error::other("SQL-owned routing requires generational publication"));
        }
        if identity.dimension != self.identity.dimension {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "snapshot dimension mismatch"));
        }
        self.core().write_staging(path, identity)
    }

    pub(crate) fn model_hash(model: &str) -> [u8; 32] {
        Sha256::digest(model.as_bytes()).into()
    }
}

impl Drop for RetrievalIndex {
    fn drop(&mut self) {
        drop(self.inner.take());
        if let Some(path) = self.private_path.take() {
            if let Err(error) = std::fs::remove_file(&path) {
                if error.kind() != io::ErrorKind::NotFound {
                    eprintln!("[KBM] Private retrieval asset cleanup deferred '{}': {}",
                        path.display(), error);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_options_exclude_ids_in_flat_and_graph_routes_and_require_a_transaction() {
        for (dimension, count) in [(2, 8), (768, 2048), (1536, 2048)] {
            let connection = rusqlite::Connection::open_in_memory().unwrap();
            connection.execute_batch("CREATE TABLE tags(id INTEGER PRIMARY KEY,vector BLOB); BEGIN;").unwrap();
            let mut row = vec![0f32; dimension];
            row[0] = 1.;
            let bytes:Vec<u8> = row.iter().flat_map(|x| x.to_le_bytes()).collect();
            for id in 1..=count {
                connection.execute("INSERT INTO tags VALUES (?1,?2)", rusqlite::params![id, &bytes]).unwrap();
            }
            let build = crate::index_source::build_memory_from_connection(&connection, None, dimension, "model").unwrap();
            let index = RetrievalIndex::from_sql(build);
            let wanted = (count as usize).min(10);
            let options = RetrievalSearchOptions { exclude_ids:(1..=count as u64-wanted as u64).collect(), ..Default::default() };
            let found = index.search_sql_options(&connection,None,&row,10,&options).unwrap();
            assert_eq!(found.len(),wanted);
            assert!(found.iter().all(|(id,score)| !options.exclude_ids.contains(id) && (*score-1.).abs()<1e-5));
            let all = RetrievalSearchOptions { exclude_ids:(1..=count as u64).collect(), ..Default::default() };
            assert!(index.search_sql_options(&connection,None,&row,10,&all).unwrap().is_empty());
            connection.execute_batch("ROLLBACK").unwrap();
            assert!(index.search_sql_options(&connection,None,&row,10,&options).is_err());
        }
    }

    #[test]
    fn search_options_parse_defaults_and_reject_bad_ids_and_limits() {
        let defaults:RetrievalSearchOptions=serde_json::from_str("{}").unwrap();
        assert!(defaults.kernel().ef_search.is_none());
        for json in [r#"{"excludeIds":[-1]}"#, r#"{"unknown":true}"#] {
            assert!(serde_json::from_str::<RetrievalSearchOptions>(json).is_err());
        }
        for json in [r#"{"excludeIds":[0]}"#, r#"{"efSearch":0}"#, r#"{"efSearch":65537}"#] {
            assert!(serde_json::from_str::<RetrievalSearchOptions>(json).unwrap().validate().is_err());
        }
    }

    #[test]
    fn maintenance_tracks_graph_transition_and_bounded_delta_residency() {
        let mut small = RetrievalIndex::empty(2).unwrap();
        small.add(1, &[1.0, 0.0]).unwrap();
        assert!(!small.maintenance_required());

        let mut crossing = RetrievalIndex::empty(2).unwrap();
        let ids: Vec<u64> = (1..=2048).collect();
        crossing.apply_delta(&[], &ids, &vec![1.0; ids.len() * 2]).unwrap();
        assert!(crossing.maintenance_required());

        // Below the graph threshold, high-dimensional mutable originals must
        // still have a bounded residency trigger.
        let mut delta = RetrievalIndex::empty(3072).unwrap();
        let ids: Vec<u64> = (1..=1400).collect();
        delta.apply_delta(&[], &ids, &vec![0.5; ids.len() * 3072]).unwrap();
        assert!(delta.maintenance_required());
    }

    #[test]
    fn host_capacity_and_cosine_contract_do_not_expose_originals() {
        let mut index = RetrievalIndex::empty(2).unwrap();
        index.reserve(16).unwrap();
        assert_eq!(index.capacity(), 16);
        index.add(7, &[3.0, 0.0]).unwrap();
        index.add(9, &[0.0, 4.0]).unwrap();
        assert_eq!(index.search(&[2.0, 0.0], 2).unwrap(), vec![(7, 1.0), (9, 0.0)]);
        assert!(index.apply_delta(&[7], &[9], &[f32::NAN, 0.0]).is_err());
        assert!(index.contains(7));
        assert_eq!(index.remove(7).unwrap(), 1);
        assert_eq!(index.remove(7).unwrap(), 0);
        assert_eq!(index.size(), 1);
        assert_eq!(index.mmap_bytes(), 0);
        assert_eq!(index.dimensions(), 2);
    }

    #[test]
    fn sql_memory_routing_uses_authoritative_rows_without_a_private_asset() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE tags(id INTEGER PRIMARY KEY,vector BLOB);
             INSERT INTO tags VALUES (7,X'0000404000000000');
             BEGIN;"
        ).unwrap();
        let build = crate::index_source::build_memory_from_connection(
            &connection, None, 2, "model",
        ).unwrap();
        let mut index = RetrievalIndex::from_sql(build);
        assert_eq!(index.mmap_bytes(), 0);
        assert_eq!(index.core().delta_bytes(), 0);
        index.add(7, &[-9.0, 0.0]).unwrap();
        assert_eq!(index.search_sql(&connection, None, &[1.0, 0.0], 1).unwrap(),
            vec![(7, 1.0)]);
        connection.execute_batch("ROLLBACK").unwrap();
        assert!(index.search_sql(&connection, None, &[1.0, 0.0], 1).is_err());
    }

    #[test]
    fn sql_owned_asset_is_removed_after_host_mapping_is_released() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE tags(id INTEGER PRIMARY KEY,vector BLOB);
             INSERT INTO tags VALUES (7,X'0000404000000000');
             BEGIN;"
        ).unwrap();
        let path = std::env::temp_dir().join(format!(
            "vcp-host-owner-{}-{}.vec", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .unwrap().as_nanos()
        ));
        let build = crate::index_source::build_from_connection(
            &connection, None, 2, "model", &path,
        ).unwrap();
        let index = RetrievalIndex::from_sql(build);
        assert!(path.exists());
        assert!(index.mmap_bytes() > 0);
        assert_eq!(index.identity().model_hash, RetrievalIndex::model_hash("model"));
        assert_eq!(index.search(&[1.0, 0.0], 1).unwrap(), vec![(7, 1.0)]);
        drop(index);
        assert!(!path.exists());
        connection.execute_batch("ROLLBACK").unwrap();
    }
}
