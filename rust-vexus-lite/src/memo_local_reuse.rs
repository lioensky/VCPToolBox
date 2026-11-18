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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    tag_id: i64,
    status: String,
    neighbor_count: usize,
    selected_tag_ids: Vec<i64>,
    nnls: Option<crate::memo_nnls::Diagnostics>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Diagnostics {
    artifact_sig: String,
    rows: Vec<Row>,
}

pub(super) struct Previous {
    pub(super) baseline: Publication,
    pub(super) rows: std::collections::HashMap<i64, super::LocalResult>,
    pub(super) facts: i64,
}

impl Previous {
    // Reuse is checked against the last successful publication. A failed publication
    // leaves that baseline in place, so a retry can still qualify as append-only.
    // A missing, partial or incompatible publication always selects the full solver.
    pub(super) fn load(conn: &Connection, model: &str, config: &str, files: &[i64],
                       events: Option<i64>) -> Option<Self> {
        let (manifest, signature, generation, diagnostics): (String, String, String, String) =
            conn.query_row(
                "SELECT m.value,a.artifact_sig,a.graph_generation,d.value
                 FROM tagmemo_artifacts a, kv_store m, kv_store d
                 WHERE a.asset_type='unified_geometry' AND a.status='ready'
                 AND a.model_sig=?1 AND a.algorithm_version=?2 AND a.config_hash=?3
                 AND m.key='memo_local_inputs_v1' AND d.key='memo_local_cone_diagnostics'
                 AND EXISTS (SELECT 1 FROM kbm_artifact_dependencies g
                             JOIN rivermemo_artifacts v USING(artifact_sig)
                             WHERE v.status='ready' AND v.payload IS NOT NULL AND v.model_sig=a.model_sig
                             AND g.dependency_key='derived_geometry'
                             AND g.dependency_version=(SELECT value FROM kbm_runtime_meta
                                                       WHERE key='derived_geometry'))
                 AND a.artifact_sig=(SELECT json_extract(value,'$.artifactSig')
                                      FROM kv_store WHERE key='epa_basis_cache')",
                params![model, super::ALGORITHM, config],
                |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).ok()?;
        let baseline: Publication = serde_json::from_str(&manifest).ok()?;
        if baseline.signature != signature
            || baseline.derived_revision != revision(conn).ok()?
            || baseline.files.len() >= files.len()
            || events?.checked_sub(baseline.file_events?)? != (files.len() - baseline.files.len()) as i64
            || !baseline.files.windows(2).all(|w| w[0] < w[1])
            || !baseline.files.iter().all(|id| files.binary_search(id).is_ok())
            || super::hash(diagnostics.as_bytes()) != baseline.diagnostics_hash {
            return None;
        }
        let doc: Diagnostics = serde_json::from_str(&diagnostics).ok()?;
        if doc.artifact_sig != signature { return None; }
        let facts = generation.strip_prefix("facts:")?.parse().ok()?;
        let mut stmt = conn.prepare(
            "SELECT tag_id,status,neighbor_count,raw_residual_ratio,v9_anchor_gain
             FROM tag_intrinsic_residuals WHERE artifact_sig=?1
             UNION ALL
             SELECT tag_id,status,neighbor_count,1.0,NULL FROM tag_intrinsic_residual_status
             WHERE artifact_sig=?1 AND error_message IS NULL ORDER BY tag_id").ok()?;
        let mut values = stmt.query([signature]).ok()?;
        let mut rows = std::collections::HashMap::with_capacity(doc.rows.len());
        for diagnostic in doc.rows {
            let r = values.next().ok()??;
            let id: i64 = r.get(0).ok()?;
            let status = match r.get_ref(1).ok()?.as_str().ok()? {
                "computed" => "computed",
                "insufficient_neighbors" => "insufficient_neighbors",
                "failed" => "failed",
                _ => return None,
            };
            let count: usize = r.get(2).ok()?;
            if diagnostic.tag_id != id || diagnostic.status != status || diagnostic.neighbor_count != count {
                return None;
            }
            rows.insert(id, super::LocalResult { id, status, count, residual:r.get(3).ok()?,
                gain:r.get(4).ok()?, selected_ids:diagnostic.selected_tag_ids, diagnostics:diagnostic.nnls });
        }
        if values.next().ok()?.is_some() { return None; }
        Some(Self { baseline, rows, facts })
    }
}
