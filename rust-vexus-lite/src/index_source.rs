//! SQL-authoritative retrieval asset construction.
//! The caller owns the read transaction and publication gate.
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use vcp_tdb_index::asset::AssetIdentity;
use vcp_tdb_index::engine::TdbIndex;

/// Private recovery files are never baseline endorsements.
/// Drop the mapping before removing the private file (required on Windows).
pub(crate) struct SqlIndexBuild {
    index: Option<TdbIndex>,
    path: PathBuf,
    pub(crate) identity: AssetIdentity,
    pub(crate) skipped_invalid: u64,
}

impl SqlIndexBuild {
    pub(crate) fn index(&self) -> &TdbIndex {
        self.index.as_ref().expect("SQL index build retains its index")
    }

    pub(crate) fn write_snapshot(
        &self, connection: &Connection, diary: Option<&str>, path: &Path,
    ) -> Result<(), String> {
        if connection.is_autocommit() {
            return Err("Snapshot publication requires an active read transaction".into());
        }
        let sql = if diary.is_some() {
            "SELECT c.vector FROM chunks c JOIN files f ON f.id=c.file_id
             WHERE c.id=?1 AND f.diary_name=?2"
        } else {
            "SELECT vector FROM tags WHERE id=?1 AND ?2 IS NULL"
        };
        let mut statement = connection.prepare_cached(sql).map_err(|e| e.to_string())?;
        let mut source_error = None;
        let result = self.index().write_staging_with_source(
            path, &self.identity, |id, output| {
                match statement.query_row(rusqlite::params![id as i64, diary],
                    |row| row.get::<_, Vec<u8>>(0)) {
                    Ok(bytes) => decode_into(&bytes, self.identity.dimension, output),
                    Err(error) => {
                        source_error = Some(error.to_string());
                        false
                    }
                }
            },
        );
        result.map_err(|error| source_error.unwrap_or_else(|| error.to_string()))
    }

    pub(crate) fn into_parts(mut self) -> (TdbIndex, PathBuf, AssetIdentity, u64) {
        let index = self.index.take().expect("SQL index build retains its index");
        // Transfer private-file cleanup responsibility together with the mapping.
        let path = std::mem::take(&mut self.path);
        (index, path, self.identity.clone(), self.skipped_invalid)
    }
}

impl Drop for SqlIndexBuild {
    fn drop(&mut self) {
        drop(self.index.take());
        if !self.path.as_os_str().is_empty() {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn decode_into(bytes: &[u8], dimension: usize, output: &mut Vec<f32>) -> bool {
    output.clear();
    if dimension.checked_mul(4) != Some(bytes.len()) {
        return false;
    }
    output.extend(bytes.chunks_exact(4)
        .map(|part| f32::from_le_bytes(part.try_into().unwrap())));
    output.iter().all(|value| value.is_finite())
}

/// Build runtime routing without creating a private vector file.
pub(crate) fn build_memory_from_connection(
    connection: &Connection,
    diary: Option<&str>,
    dimension: usize,
    model_sig: &str,
) -> Result<SqlIndexBuild, String> {
    build_with_source(connection, diary, dimension, model_sig, None)
}

/// Test-only disk-backed fixture for legacy asset ownership regression.
/// Production recovery builds memory routing and never creates this asset.
#[cfg(test)]
pub(crate) fn build_from_connection(
    connection: &Connection,
    diary: Option<&str>,
    dimension: usize,
    model_sig: &str,
    staging: &Path,
) -> Result<SqlIndexBuild, String> {
    build_with_source(connection, diary, dimension, model_sig, Some(staging))
}

fn build_with_source(
    connection: &Connection,
    diary: Option<&str>,
    dimension: usize,
    model_sig: &str,
    staging: Option<&Path>,
) -> Result<SqlIndexBuild, String> {
    if dimension == 0 || dimension > vcp_tdb_index::index::bq::MAX_BQ_DIM
        || model_sig.trim().is_empty() {
        return Err("Invalid SQL retrieval source dimension or model signature".into());
    }
    // Enforce the two-pass snapshot requirement rather than trusting all callers.
    if connection.is_autocommit() {
        return Err("SQL retrieval construction requires an active read transaction".into());
    }
    let sql = if diary.is_some() {
        "SELECT c.id,c.vector FROM chunks c JOIN files f ON f.id=c.file_id
         WHERE f.diary_name=?1 AND c.vector IS NOT NULL ORDER BY c.id"
    } else {
        "SELECT id,vector FROM tags WHERE vector IS NOT NULL AND ?1 IS NULL ORDER BY id"
    };
    let mut statement = connection.prepare(sql).map_err(|error| error.to_string())?;
    let mut rows = statement.query([diary]).map_err(|error| error.to_string())?;
    let mut ids = Vec::new();
    let mut vector = Vec::with_capacity(dimension);
    let mut skipped_invalid = 0_u64;
    let mut digest = Sha256::new();
    digest.update(b"vcp-sql-vector-content-v1");
    digest.update((dimension as u64).to_le_bytes());
    while let Some(row) = rows.next().map_err(|error| error.to_string())? {
        let id: i64 = row.get(0).map_err(|error| error.to_string())?;
        let bytes = match row.get_ref(1).map_err(|error| error.to_string())? {
            rusqlite::types::ValueRef::Blob(bytes) => bytes,
            _ => {
                skipped_invalid += 1;
                continue;
            }
        };
        if id <= 0 || !decode_into(bytes, dimension, &mut vector) {
            skipped_invalid += 1;
            continue;
        }
        ids.push(id as u64);
        digest.update(id.to_le_bytes());
        digest.update(bytes);
    }
    drop(rows);
    drop(statement);
    let identity = AssetIdentity {
        dimension,
        scope: u8::from(diary.is_none()),
        model_hash: Sha256::digest(model_sig.as_bytes()).into(),
        content_digest: digest.finalize().into(),
    };
    let lookup = if diary.is_some() {
        "SELECT c.vector FROM chunks c JOIN files f ON f.id=c.file_id
         WHERE c.id=?1 AND f.diary_name=?2"
    } else {
        "SELECT vector FROM tags WHERE id=?1 AND ?2 IS NULL"
    };
    let mut lookup = connection.prepare(lookup).map_err(|error| error.to_string())?;
    let mut source_error = None;
    let mut fill = |slot: usize, output: &mut Vec<f32>| {
            let result = lookup.query_row(
                rusqlite::params![ids[slot] as i64, diary],
                |row| row.get::<_, Vec<u8>>(0),
            );
            match result {
                Ok(bytes) => decode_into(&bytes, dimension, output),
                Err(error) => {
                    source_error = Some(error.to_string());
                    false
                }
            }
        };
    let index = match staging {
        Some(path) => TdbIndex::rebuild_from_source(path, &identity, &ids, &mut fill),
        None => TdbIndex::routing_from_source(dimension, &ids, &mut fill),
    }.map_err(|error| format!(
        "SQL retrieval construction failed: {}",
        source_error.unwrap_or_else(|| error.to_string())
    ))?;
    Ok(SqlIndexBuild {
        index: Some(index), path: staging.map(Path::to_path_buf).unwrap_or_default(),
        identity, skipped_invalid,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_streaming_preserves_scope_and_cleans_up_owned_mapping() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE tags(id INTEGER PRIMARY KEY,vector BLOB);
             CREATE TABLE files(id INTEGER PRIMARY KEY,diary_name TEXT);
             CREATE TABLE chunks(id INTEGER PRIMARY KEY,file_id INTEGER,vector BLOB);
             INSERT INTO files VALUES (1,'allowed'),(2,'outside');"
        ).unwrap();
        let encode = |values: &[f32]| values.iter()
            .flat_map(|value| value.to_le_bytes()).collect::<Vec<_>>();
        for (id, file, values) in [
            (1, 1, [3.0, 0.0]), (2, 2, [0.0, 4.0]), (3, 1, [f32::NAN, 0.0])
        ] {
            connection.execute("INSERT INTO chunks VALUES (?1,?2,?3)",
                rusqlite::params![id, file, encode(&values)]).unwrap();
        }
        connection.execute("INSERT INTO tags VALUES (7,?1)", [encode(&[-5.0, 0.0])]).unwrap();
        let root = std::env::temp_dir().join(format!(
            "vcp-sql-source-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("private.vec");
        assert!(build_from_connection(&connection, Some("allowed"), 2, "model", &path)
            .unwrap_err_message().contains("active read transaction"));
        connection.execute_batch("BEGIN").unwrap();
        let built = build_from_connection(&connection, Some("allowed"), 2, "model", &path).unwrap();
        assert_eq!(built.skipped_invalid, 1);
        assert_eq!(built.index().len(), 1);
        assert_eq!(built.index().delta_bytes(), 0);
        assert_eq!(built.index().search(&[1.0, 0.0], 10, None).unwrap(), vec![(1, 1.0)]);
        assert_eq!(built.identity.scope, 0);
        drop(built);
        assert!(!path.exists());
        let tags = build_from_connection(&connection, None, 2, "model", &path).unwrap();
        assert_eq!(tags.identity.scope, 1);
        assert_eq!(tags.index().search(&[1.0, 0.0], 10, None).unwrap(), vec![(7, -1.0)]);
        drop(tags);
        connection.execute_batch("ROLLBACK").unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    trait ErrorMessage {
        fn unwrap_err_message(self) -> String;
    }
    impl ErrorMessage for Result<SqlIndexBuild, String> {
        fn unwrap_err_message(self) -> String {
            match self {
                Err(error) => error,
                Ok(_) => panic!("expected construction error"),
            }
        }
    }
}