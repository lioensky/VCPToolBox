//! The geometry signature already covers ordered Tag identities and file memberships.
//! Keep only the file IDs (including empty files) and checks on the published rows.
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
pub(super) struct Publication {
    pub(super) signature: String,
    pub(super) files: Vec<i64>,
    file_events: Option<i64>,
    diagnostics_hash: String,
    derived_revision: String,
}

pub(super) fn files(conn: &Connection) -> rusqlite::Result<Vec<i64>> {
    let mut stmt = conn.prepare("SELECT id FROM files ORDER BY id")?;
    let ids = stmt.query_map([], |row| row.get(0))?.collect();
    ids
}

pub(super) fn file_events(conn: &Connection) -> Option<i64> {
    conn.query_row("SELECT value FROM kbm_runtime_meta WHERE key='memo_file_events'",
                   [], |row| row.get::<_,String>(0)).ok()?.parse().ok()
}

fn revision(conn: &Connection) -> rusqlite::Result<String> {
    conn.query_row("SELECT value FROM kbm_runtime_meta WHERE key='derived_geometry'",
                   [], |row| row.get(0))
}

pub(super) fn publish(conn: &Connection, signature: &str, files: Vec<i64>, file_events: Option<i64>,
                      diagnostics_hash: String) -> rusqlite::Result<()> {
    let baseline = Publication {
        signature: signature.to_owned(), files, file_events, diagnostics_hash,
        derived_revision: revision(conn)?,
    };
    conn.execute("INSERT OR REPLACE INTO kv_store(key,value) VALUES ('memo_local_inputs_v1',?1)",
                 params![serde_json::to_string(&baseline).expect("serializable local inputs")])?;
    Ok(())
}
