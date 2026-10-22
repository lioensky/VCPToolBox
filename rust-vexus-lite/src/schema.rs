use rusqlite::Connection;

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    diary_name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    mtime INTEGER NOT NULL,
    size INTEGER NOT NULL,
    updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    vector BLOB,
    FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    vector BLOB,
    vector_version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS kbm_file_versions (
    path TEXT PRIMARY KEY NOT NULL,
    version INTEGER NOT NULL DEFAULT 0,
    exists_flag INTEGER NOT NULL DEFAULT 0,
    checksum TEXT,
    mtime INTEGER,
    size INTEGER,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS file_tags (
    file_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(file_id, tag_id),
    FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE,
    FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS migration_deleted_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    old_path TEXT NOT NULL,
    old_diary_name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    size INTEGER NOT NULL,
    chunk_count INTEGER NOT NULL,
    deleted_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS migration_deleted_chunks (
    cache_file_id INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL,
    vector BLOB NOT NULL,
    PRIMARY KEY(cache_file_id, chunk_index),
    FOREIGN KEY(cache_file_id) REFERENCES migration_deleted_files(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS chunk_index_baselines (
    diary_name TEXT NOT NULL,
    generation INTEGER NOT NULL,
    slot TEXT NOT NULL CHECK(slot IN ('a','b')),
    dimension INTEGER NOT NULL,
    model_sig TEXT NOT NULL,
    chunk_count INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('building','ready')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY(diary_name, generation)
);
CREATE TABLE IF NOT EXISTS chunk_index_baseline_entries (
    diary_name TEXT NOT NULL,
    generation INTEGER NOT NULL,
    chunk_id INTEGER NOT NULL,
    chunk_vector_sig TEXT,
    PRIMARY KEY(diary_name, generation, chunk_id),
    FOREIGN KEY(diary_name, generation)
      REFERENCES chunk_index_baselines(diary_name, generation) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS tag_index_baselines (
    generation INTEGER PRIMARY KEY,
    slot TEXT NOT NULL CHECK(slot IN ('a','b')),
    dimension INTEGER NOT NULL,
    model_sig TEXT NOT NULL,
    tag_count INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('building','ready')),
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tag_index_baseline_entries (
    generation INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    vector_version INTEGER NOT NULL,
    PRIMARY KEY(generation, tag_id),
    FOREIGN KEY(generation) REFERENCES tag_index_baselines(generation) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS global_chunk_index_baselines (
    generation INTEGER PRIMARY KEY,
    slot TEXT NOT NULL CHECK(slot IN ('a','b')),
    dimension INTEGER NOT NULL,
    model_sig TEXT NOT NULL,
    database_generation TEXT NOT NULL,
    format_version INTEGER NOT NULL,
    file_size INTEGER NOT NULL,
    file_digest TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS global_chunk_index_baseline_entries (
    generation INTEGER NOT NULL,
    chunk_id INTEGER NOT NULL,
    vector_version INTEGER NOT NULL,
    metadata_version INTEGER NOT NULL,
    file_version INTEGER NOT NULL,
    PRIMARY KEY(generation, chunk_id),
    FOREIGN KEY(generation)
      REFERENCES global_chunk_index_baselines(generation) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT,
    vector BLOB
);
CREATE TABLE IF NOT EXISTS tag_intrinsic_residuals (
    tag_id INTEGER PRIMARY KEY,
    residual_energy REAL NOT NULL,
    neighbor_count INTEGER NOT NULL,
    computed_at TEXT NOT NULL DEFAULT(datetime('now')),
    raw_residual_ratio REAL,
    v8_3_compat_gain REAL,
    v9_anchor_gain REAL,
    model_sig TEXT,
    artifact_sig TEXT,
    algorithm_version TEXT,
    config_hash TEXT,
    status TEXT NOT NULL DEFAULT 'computed'
);
CREATE TABLE IF NOT EXISTS tag_intrinsic_residual_status (
    tag_id INTEGER NOT NULL,
    artifact_sig TEXT NOT NULL,
    status TEXT NOT NULL,
    neighbor_count INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    computed_at INTEGER NOT NULL,
    PRIMARY KEY(tag_id, artifact_sig)
);
CREATE TABLE IF NOT EXISTS tagmemo_artifacts (
    artifact_sig TEXT PRIMARY KEY,
    asset_type TEXT NOT NULL,
    model_sig TEXT NOT NULL,
    graph_generation TEXT NOT NULL,
    algorithm_version TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    effective_config TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rivermemo_artifacts (
    artifact_sig TEXT PRIMARY KEY,
    schema_version TEXT NOT NULL,
    algorithm_version TEXT NOT NULL,
    source_v9_artifact_sig TEXT NOT NULL,
    source_graph_generation TEXT NOT NULL,
    model_sig TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    database_generation TEXT NOT NULL,
    provenance_generation TEXT NOT NULL,
    payload_codec TEXT NOT NULL DEFAULT 'gzip-json-v1',
    payload_checksum TEXT,
    payload BLOB,
    status TEXT NOT NULL,
    error_message TEXT,
    node_count INTEGER NOT NULL DEFAULT 0,
    edge_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    published_at INTEGER
);
CREATE TABLE IF NOT EXISTS kbm_artifact_dependencies (
    artifact_sig TEXT NOT NULL,
    dependency_key TEXT NOT NULL,
    dependency_version TEXT NOT NULL,
    PRIMARY KEY(artifact_sig, dependency_key),
    FOREIGN KEY(artifact_sig) REFERENCES rivermemo_artifacts(artifact_sig) ON DELETE CASCADE
);
-- No FK: deleted Tag IDs must remain counted until a successful graph publication.
CREATE TABLE IF NOT EXISTS kbm_memo_changed_tags (
    tag_id INTEGER PRIMARY KEY NOT NULL,
    fact_version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS v10_vector_metrics (
    entity_type TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    model_sig TEXT NOT NULL,
    dimension INTEGER NOT NULL,
    vector_sig TEXT NOT NULL,
    l2_norm REAL NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(entity_type, entity_id, model_sig, dimension)
);
CREATE TABLE IF NOT EXISTS v10_chunk_tag_geometry (
    chunk_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    model_sig TEXT NOT NULL,
    dimension INTEGER NOT NULL,
    chunk_vector_sig TEXT NOT NULL,
    tag_vector_sig TEXT NOT NULL,
    cosine REAL NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(chunk_id, tag_id, model_sig, dimension),
    FOREIGN KEY(chunk_id) REFERENCES chunks(id) ON DELETE CASCADE,
    FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS v10_derived_asset_status (
    asset_type TEXT NOT NULL,
    model_sig TEXT NOT NULL,
    dimension INTEGER NOT NULL,
    source_generation TEXT NOT NULL,
    row_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    error_message TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(asset_type, model_sig, dimension)
);
CREATE TABLE IF NOT EXISTS kbm_prepared_plans (
    token TEXT PRIMARY KEY NOT NULL,
    operation_type TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    database_generation INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('prepared','committed','cancelled','expired')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kbm_operation_receipts (
    operation_id TEXT PRIMARY KEY NOT NULL,
    operation_type TEXT NOT NULL,
    batch_id TEXT,
    plan_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('committed','expired','cancelled','failed')),
    database_generation INTEGER NOT NULL DEFAULT 0,
    receipt_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kbm_index_states (
    scope TEXT PRIMARY KEY NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('ready','invalid','recovering')),
    facts_generation INTEGER NOT NULL DEFAULT 0,
    applied_generation INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_diary ON files(diary_name);
CREATE INDEX IF NOT EXISTS idx_file_versions_exists ON kbm_file_versions(exists_flag, updated_at);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_file_tags_composite ON file_tags(tag_id,file_id);
CREATE INDEX IF NOT EXISTS idx_migration_deleted_lookup
    ON migration_deleted_files(checksum,size,expires_at);
CREATE INDEX IF NOT EXISTS idx_chunk_baseline_diary
    ON chunk_index_baselines(diary_name,status);
CREATE INDEX IF NOT EXISTS idx_chunk_baseline_entries
    ON chunk_index_baseline_entries(diary_name,generation);
CREATE INDEX IF NOT EXISTS idx_tag_baseline_entries
    ON tag_index_baseline_entries(generation);
CREATE INDEX IF NOT EXISTS idx_intrinsic_residual_model
    ON tag_intrinsic_residuals(model_sig);
CREATE INDEX IF NOT EXISTS idx_intrinsic_status_artifact
    ON tag_intrinsic_residual_status(artifact_sig,status);
CREATE INDEX IF NOT EXISTS idx_operation_receipts_expiry
    ON kbm_operation_receipts(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_index_states_state
    ON kbm_index_states(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_rivermemo_validation
    ON rivermemo_artifacts(artifact_sig,status,algorithm_version,schema_version);
CREATE INDEX IF NOT EXISTS idx_rivermemo_compatible
    ON rivermemo_artifacts(source_v9_artifact_sig,model_sig,config_hash,
                            database_generation,status,updated_at);
DROP TRIGGER IF EXISTS trg_tags_vector_version;
CREATE TRIGGER trg_tags_vector_version
AFTER UPDATE OF vector ON tags
WHEN OLD.vector IS NOT NEW.vector
BEGIN
    UPDATE tags SET vector_version = OLD.vector_version + 1 WHERE id = NEW.id;
END;
"#;

fn migrate_geometry(connection: &Connection) -> Result<(), String> {
    let switched: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM kbm_runtime_meta WHERE key='geometry_schema_v1')",
        [], |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    for name in [
        "trg_tags_delete_pair_cache", "trg_pairwise_tags_insert_generation",
        "trg_pairwise_tags_vector_generation", "trg_pairwise_tags_delete_generation",
        "trg_pairwise_file_tags_insert_generation", "trg_pairwise_file_tags_delete_generation",
    ] {
        connection.execute_batch(&format!("DROP TRIGGER IF EXISTS {name};"))
            .map_err(|e| e.to_string())?;
    }
    for table in ["tag_pair_similarity", "tag_intrinsic_residuals", "kv_store"] {
        for event in ["INSERT", "UPDATE", "DELETE"] {
            connection.execute_batch(&format!("DROP TRIGGER IF EXISTS trg_{table}_{event}_derived;"))
                .map_err(|e| e.to_string())?;
        }
    }
    connection.execute_batch(
        "DROP INDEX IF EXISTS idx_intrinsic_residual_artifact;
         DROP TABLE IF EXISTS tag_pair_similarity_status;
         DROP TABLE IF EXISTS tag_pair_similarity;
         DELETE FROM kv_store WHERE key='tagmemo_pairwise_fact_generation';
         DELETE FROM kbm_runtime_meta WHERE key IN ('derived_pairwise','derived_intrinsic','derived_epa');
         DELETE FROM tagmemo_artifacts WHERE asset_type IN ('pairwise_similarity','intrinsic_residual');"
    ).map_err(|e| e.to_string())?;
    if !switched {
        connection.execute_batch(
            "DELETE FROM kv_store WHERE key='epa_basis_cache';
             DELETE FROM tag_intrinsic_residuals;
             DELETE FROM tag_intrinsic_residual_status;
             INSERT INTO kbm_runtime_meta(key,value) VALUES ('geometry_schema_v1','1');"
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Upgrade legacy Windows keys without changing file/chunk/tag identities.
/// Called inside the schema transaction, before any startup cleanup or watcher.
fn migrate_legacy_file_metadata(connection: &Connection) -> Result<(), String> {
    for (table, column) in [("files", "path"), ("kbm_file_versions", "path")] {
        let collision: bool = connection.query_row(
            &format!(
                "SELECT EXISTS(SELECT 1 FROM {table}
                 GROUP BY replace({column}, char(92), '/') HAVING COUNT(*) > 1)"
            ),
            [], |row| row.get(0),
        ).map_err(|error| format!("inspect legacy {table} paths failed: {error}"))?;
        if collision {
            return Err(format!(
                "KNOWLEDGE_STORE_LEGACY_PATH_COLLISION: {table} contains multiple rows \
                 for the same normalized path; refusing destructive merge"
            ));
        }
    }
    connection.execute_batch(
        "UPDATE files SET path=replace(path, char(92), '/')
         WHERE instr(path, char(92)) > 0;
         UPDATE files SET mtime=CAST(mtime AS INTEGER) WHERE typeof(mtime)='real';
         UPDATE kbm_file_versions SET path=replace(path, char(92), '/')
         WHERE instr(path, char(92)) > 0;
         UPDATE kbm_file_versions SET mtime=CAST(mtime AS INTEGER)
         WHERE typeof(mtime)='real';
         UPDATE migration_deleted_files SET old_path=replace(old_path, char(92), '/')
         WHERE instr(old_path, char(92)) > 0;
         INSERT INTO kbm_file_versions(path,version,exists_flag,checksum,mtime,size,updated_at)
         SELECT path,1,1,checksum,mtime,size,COALESCE(updated_at,0) FROM files WHERE true
         ON CONFLICT(path) DO NOTHING;"
    ).map_err(|error| format!("migrate legacy file metadata failed: {error}"))?;
    Ok(())
}

pub(crate) fn initialize_schema(
    connection: &Connection,
    requested_version: i64,
) -> Result<i64, String> {
    let version = connection
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM kbm_runtime_meta WHERE key='schema_version'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("read KBM schema version failed: {}", error))?;
    if version > requested_version {
        return Err(format!(
            "KBM schema version {} is newer than requested {}",
            version, requested_version
        ));
    }
    let transaction = connection.unchecked_transaction()
        .map_err(|error| format!("begin KBM schema migration failed: {}", error))?;
    let (tables, indices) = SCHEMA_SQL.split_once(
        "CREATE INDEX IF NOT EXISTS idx_files_diary"
    ).ok_or_else(|| "KBM schema boundary missing".to_string())?;
    transaction.execute_batch(tables)
        .map_err(|error| format!("initialize KBM tables failed: {}", error))?;
    ensure_additive_columns(&transaction)?;
    migrate_geometry(&transaction)?;
    transaction.execute_batch(
        "INSERT OR IGNORE INTO kbm_runtime_meta(key,value) VALUES ('global_chunk_facts','0');
         CREATE TRIGGER IF NOT EXISTS trg_global_chunks_insert AFTER INSERT ON chunks BEGIN
           UPDATE kbm_runtime_meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='global_chunk_facts';
         END;
         CREATE TRIGGER IF NOT EXISTS trg_global_chunks_delete AFTER DELETE ON chunks BEGIN
           UPDATE kbm_runtime_meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='global_chunk_facts';
         END;
         CREATE TRIGGER IF NOT EXISTS trg_global_chunks_vector AFTER UPDATE OF vector ON chunks
         WHEN OLD.vector IS NOT NEW.vector BEGIN
           UPDATE chunks SET vector_version=OLD.vector_version+1 WHERE id=NEW.id;
           UPDATE kbm_runtime_meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='global_chunk_facts';
         END;
         CREATE TRIGGER IF NOT EXISTS trg_global_chunks_metadata AFTER UPDATE OF content,file_id ON chunks
         WHEN OLD.content IS NOT NEW.content OR OLD.file_id IS NOT NEW.file_id BEGIN
           UPDATE chunks SET metadata_version=OLD.metadata_version+1 WHERE id=NEW.id;
           UPDATE kbm_runtime_meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='global_chunk_facts';
         END;
         CREATE TRIGGER IF NOT EXISTS trg_global_files_metadata AFTER UPDATE OF path,diary_name ON files
         WHEN OLD.path IS NOT NEW.path OR OLD.diary_name IS NOT NEW.diary_name BEGIN
           UPDATE files SET metadata_version=OLD.metadata_version+1 WHERE id=NEW.id;
           UPDATE kbm_runtime_meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='global_chunk_facts';
         END;"
    ).map_err(|error| format!("initialize global Chunk versions failed: {}", error))?;
    transaction.execute_batch(&format!(
        "CREATE INDEX IF NOT EXISTS idx_files_diary{}", indices
    )).map_err(|error| format!("initialize KBM indices failed: {}", error))?;
    // 派生版本独立于事实代际；触发器覆盖发布、维护和删除等所有写入口。
    transaction.execute_batch(
        "INSERT OR IGNORE INTO kbm_runtime_meta(key,value) VALUES
         ('derived_geometry','0'),
         ('memo_tag_facts','0');
         CREATE TRIGGER IF NOT EXISTS trg_memo_tags_insert AFTER INSERT ON tags BEGIN
           UPDATE kbm_runtime_meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='memo_tag_facts';
         END;
         CREATE TRIGGER IF NOT EXISTS trg_memo_tags_delete AFTER DELETE ON tags BEGIN
           UPDATE kbm_runtime_meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='memo_tag_facts';
         END;
         CREATE TRIGGER IF NOT EXISTS trg_memo_tags_update AFTER UPDATE OF id,name,vector ON tags
         WHEN OLD.id IS NOT NEW.id OR OLD.name IS NOT NEW.name OR OLD.vector IS NOT NEW.vector BEGIN
           UPDATE kbm_runtime_meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='memo_tag_facts';
         END;
         CREATE TRIGGER IF NOT EXISTS trg_memo_relations_insert AFTER INSERT ON file_tags BEGIN
           UPDATE kbm_runtime_meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='memo_tag_facts';
         END;
         CREATE TRIGGER IF NOT EXISTS trg_memo_relations_delete AFTER DELETE ON file_tags BEGIN
           UPDATE kbm_runtime_meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='memo_tag_facts';
         END;
         CREATE TRIGGER IF NOT EXISTS trg_memo_relations_update AFTER UPDATE ON file_tags
         WHEN OLD.file_id IS NOT NEW.file_id OR OLD.tag_id IS NOT NEW.tag_id OR OLD.position IS NOT NEW.position BEGIN
           UPDATE kbm_runtime_meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='memo_tag_facts';
         END;
         CREATE TRIGGER IF NOT EXISTS trg_memo_provenance_update AFTER UPDATE OF path,diary_name ON files
         WHEN (OLD.path IS NOT NEW.path OR OLD.diary_name IS NOT NEW.diary_name)
           AND EXISTS(SELECT 1 FROM file_tags WHERE file_id=NEW.id) BEGIN
           UPDATE kbm_runtime_meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='memo_tag_facts';
         END;"
    ).map_err(|error| format!("initialize derived generations failed: {}", error))?;
    // Durable unique-Tag refresh accounting, separate from strict build dependencies.
    // Recreating only these small triggers also upgrades existing databases safely.
    for (name, event, table, condition, ids) in [
        ("insert", "INSERT", "tags", "", vec!["NEW.id"]),
        ("delete", "DELETE", "tags", "", vec!["OLD.id"]),
        ("update", "UPDATE OF id,name,vector", "tags",
         "WHEN OLD.id IS NOT NEW.id OR OLD.name IS NOT NEW.name OR OLD.vector IS NOT NEW.vector",
         vec!["OLD.id", "NEW.id"]),
        ("relation_insert", "INSERT", "file_tags", "", vec!["NEW.tag_id"]),
        ("relation_delete", "DELETE", "file_tags", "", vec!["OLD.tag_id"]),
        ("relation_update", "UPDATE", "file_tags",
         "WHEN OLD.file_id IS NOT NEW.file_id OR OLD.tag_id IS NOT NEW.tag_id OR OLD.position IS NOT NEW.position",
         vec!["OLD.tag_id", "NEW.tag_id"]),
    ] {
        let statements = ids.iter().map(|id| format!(
            "INSERT INTO kbm_memo_changed_tags(tag_id,fact_version)
             VALUES ({id},(SELECT CAST(value AS INTEGER) FROM kbm_runtime_meta WHERE key='memo_tag_facts')+1)
             ON CONFLICT(tag_id) DO UPDATE SET fact_version=excluded.fact_version;"
        )).collect::<Vec<_>>().join("\n");
        transaction.execute_batch(&format!(
            "DROP TRIGGER IF EXISTS trg_memo_dirty_{name};
             CREATE TRIGGER trg_memo_dirty_{name} AFTER {event} ON {table} {condition}
             BEGIN {statements} END;"
        )).map_err(|e| format!("initialize Memo refresh accounting failed: {e}"))?;
    }
    transaction.execute_batch(
        "CREATE TRIGGER IF NOT EXISTS trg_memo_dirty_provenance
         AFTER UPDATE OF path,diary_name ON files
         WHEN OLD.path IS NOT NEW.path OR OLD.diary_name IS NOT NEW.diary_name BEGIN
           INSERT INTO kbm_memo_changed_tags(tag_id,fact_version)
           SELECT tag_id,(SELECT CAST(value AS INTEGER) FROM kbm_runtime_meta WHERE key='memo_tag_facts')+1
           FROM file_tags WHERE file_id=NEW.id
           ON CONFLICT(tag_id) DO UPDATE SET fact_version=excluded.fact_version;
         END;"
    ).map_err(|e| format!("initialize Memo provenance accounting failed: {e}"))?;
    for (table, key) in [
        ("tag_intrinsic_residuals", "derived_geometry"),
        ("kv_store", "derived_geometry"),
    ] {
        for event in ["INSERT", "UPDATE", "DELETE"] {
            let condition = if table == "kv_store" {
                if event == "DELETE" {
                    "WHEN OLD.key='epa_basis_cache'"
                } else {
                    "WHEN NEW.key='epa_basis_cache'"
                }
            } else { "" };
            transaction.execute_batch(&format!(
                "CREATE TRIGGER IF NOT EXISTS trg_{table}_{event}_derived
                 AFTER {event} ON {table} {condition} BEGIN
                   UPDATE kbm_runtime_meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)
                   WHERE key='{key}';
                 END;"
            )).map_err(|error| format!("initialize derived version trigger failed: {}", error))?;
        }
    }
    if version < requested_version {
        transaction
            .execute(
                "UPDATE kbm_runtime_meta SET value=?1 WHERE key='schema_version'",
                [requested_version.to_string()],
            )
            .map_err(|error| format!("publish KBM schema version failed: {}", error))?;
    }
    migrate_legacy_file_metadata(&transaction)?;
    transaction.commit()
        .map_err(|error| format!("commit KBM schema migration failed: {}", error))?;
    Ok(requested_version.max(version))
}

fn ensure_additive_columns(connection: &Connection) -> Result<(), String> {
    let migrations = [
        // Old manifests have no member-version endorsement. Preserve them for
        // recovery, but do not silently invent a publication baseline.
        ("global_chunk_index_baselines", "member_versions", "INTEGER NOT NULL DEFAULT 0"),
        ("chunks", "vector_version", "INTEGER NOT NULL DEFAULT 1"),
        ("chunks", "metadata_version", "INTEGER NOT NULL DEFAULT 1"),
        ("files", "metadata_version", "INTEGER NOT NULL DEFAULT 1"),
        (
            "chunk_index_baseline_entries",
            "chunk_vector_sig",
            "TEXT",
        ),
        // VCP-PATCH: legacy endorsements remain format 0 until a new checkpoint.
        ("chunk_index_baselines", "format_version", "INTEGER NOT NULL DEFAULT 0"),
        ("chunk_index_baselines", "file_size", "INTEGER"),
        ("chunk_index_baselines", "file_crc", "INTEGER"),
        ("chunk_index_baselines", "content_digest", "TEXT"),
        ("tag_index_baselines", "format_version", "INTEGER NOT NULL DEFAULT 0"),
        ("tag_index_baselines", "file_size", "INTEGER"),
        ("tag_index_baselines", "file_crc", "INTEGER"),
        ("tag_index_baselines", "content_digest", "TEXT"),
        ("tags", "vector_version", "INTEGER NOT NULL DEFAULT 1"),
        ("file_tags", "position", "INTEGER NOT NULL DEFAULT 0"),
        ("tag_intrinsic_residuals", "raw_residual_ratio", "REAL"),
        ("tag_intrinsic_residuals", "v8_3_compat_gain", "REAL"),
        ("tag_intrinsic_residuals", "v9_anchor_gain", "REAL"),
        ("tag_intrinsic_residuals", "model_sig", "TEXT"),
        ("tag_intrinsic_residuals", "artifact_sig", "TEXT"),
        ("tag_intrinsic_residuals", "algorithm_version", "TEXT"),
        ("tag_intrinsic_residuals", "config_hash", "TEXT"),
        (
            "tag_intrinsic_residuals",
            "status",
            "TEXT NOT NULL DEFAULT 'computed'",
        ),
    ];
    for (table, column, definition) in migrations {
        let exists: bool = connection
            .prepare(&format!("PRAGMA table_info({})", table))
            .map_err(|error| format!("inspect {} schema failed: {}", table, error))?
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| format!("read {} schema failed: {}", table, error))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("decode {} schema failed: {}", table, error))?
            .iter()
            .any(|name| name == column);
        if !exists {
            connection
                .execute(
                    &format!("ALTER TABLE {} ADD COLUMN {} {}", table, column, definition),
                    [],
                )
                .map_err(|error| format!("migrate {}.{} failed: {}", table, column, error))?;
        }
    }
    Ok(())
}



#[cfg(test)]
mod migration_tests {
    use super::*;

    #[test]
    fn legacy_index_endorsements_keep_format_zero_and_preserve_entries() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE kbm_runtime_meta(key TEXT PRIMARY KEY,value TEXT);
             INSERT INTO kbm_runtime_meta VALUES ('schema_version','1');
             CREATE TABLE chunk_index_baselines(
                 diary_name TEXT NOT NULL,generation INTEGER NOT NULL,slot TEXT NOT NULL,
                 dimension INTEGER NOT NULL,model_sig TEXT NOT NULL,chunk_count INTEGER NOT NULL,
                 status TEXT NOT NULL,created_at INTEGER NOT NULL,
                 PRIMARY KEY(diary_name,generation));
             CREATE TABLE tag_index_baselines(
                 generation INTEGER PRIMARY KEY,slot TEXT NOT NULL,dimension INTEGER NOT NULL,
                 model_sig TEXT NOT NULL,tag_count INTEGER NOT NULL,status TEXT NOT NULL,
                 created_at INTEGER NOT NULL);
             INSERT INTO chunk_index_baselines VALUES ('Diary',7,'a',3072,'model',1,'ready',123);
             INSERT INTO tag_index_baselines VALUES (9,'b',3072,'model',1,'ready',456);"
        ).unwrap();
        initialize_schema(&connection, 2).unwrap();
        connection.execute_batch(
            "INSERT INTO chunk_index_baseline_entries VALUES ('Diary',7,42,'original-signature');
             INSERT INTO tag_index_baseline_entries VALUES (9,51,8);"
        ).unwrap();
        for _ in 0..2 {
            initialize_schema(&connection, 2).unwrap();
            for table in ["chunk_index_baselines", "tag_index_baselines"] {
                let metadata: (i64, Option<i64>, Option<i64>, Option<String>) = connection
                    .query_row(
                        &format!("SELECT format_version,file_size,file_crc,content_digest FROM {table}"),
                        [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
                    ).unwrap();
                assert_eq!(metadata, (0, None, None, None));
            }
            let signature: String = connection.query_row(
                "SELECT chunk_vector_sig FROM chunk_index_baseline_entries
                 WHERE diary_name='Diary' AND generation=7 AND chunk_id=42",
                [], |row| row.get(0),
            ).unwrap();
            assert_eq!(signature, "original-signature");
            let version: i64 = connection.query_row(
                "SELECT vector_version FROM tag_index_baseline_entries
                 WHERE generation=9 AND tag_id=51", [], |row| row.get(0),
            ).unwrap();
            assert_eq!(version, 8);
        }
    }

    #[test]
    fn legacy_columns_are_added_before_dependent_indices() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE kbm_runtime_meta(key TEXT PRIMARY KEY, value TEXT);
             INSERT INTO kbm_runtime_meta VALUES ('schema_version', '1');
             CREATE TABLE tags(id INTEGER PRIMARY KEY, name TEXT UNIQUE, vector BLOB);
             CREATE TABLE tag_intrinsic_residuals(
                 tag_id INTEGER PRIMARY KEY, residual_energy REAL,
                 neighbor_count INTEGER, computed_at TEXT
             );"
        ).unwrap();
        initialize_schema(&connection, 1).unwrap();
        let version: i64 = connection.query_row(
            "SELECT vector_version FROM tags LIMIT 1", [], |row| row.get(0)
        ).optional().unwrap().unwrap_or(1);
        assert_eq!(version, 1);
        initialize_schema(&connection, 1).unwrap();
    }

    #[test]
    fn newer_schema_is_rejected_without_creating_tables() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE kbm_runtime_meta(key TEXT PRIMARY KEY, value TEXT);
             INSERT INTO kbm_runtime_meta VALUES ('schema_version', '99');"
        ).unwrap();
        assert!(initialize_schema(&connection, 1).is_err());
        let count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='files'",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn legacy_windows_paths_and_real_mtime_preserve_facts_and_versions() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE kbm_runtime_meta(key TEXT PRIMARY KEY,value TEXT);
             INSERT INTO kbm_runtime_meta VALUES ('schema_version','1');"
        ).unwrap();
        initialize_schema(&connection, 2).unwrap();
        connection.execute_batch(
            "INSERT INTO files(id,path,diary_name,checksum,mtime,size,updated_at)
             VALUES (7,'Diary\\note.txt','Diary','hash',1234.75,4,100);
             INSERT INTO chunks(id,file_id,chunk_index,content,vector)
             VALUES (9,7,0,'body',X'0000803f');
             INSERT INTO tags(id,name,vector) VALUES (11,'tag',X'0000803f');
             INSERT INTO file_tags(file_id,tag_id,position) VALUES (7,11,1);"
        ).unwrap();
        initialize_schema(&connection, 2).unwrap();
        let metadata: (i64, String, i64) = connection.query_row(
            "SELECT id,path,mtime FROM files", [],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        ).unwrap();
        assert_eq!(metadata, (7, "Diary/note.txt".into(), 1234));
        let facts: (i64, i64, String, String, i64) = connection.query_row(
            "SELECT c.id,c.file_id,c.content,hex(c.vector),ft.tag_id
             FROM chunks c JOIN file_tags ft ON ft.file_id=c.file_id", [],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
        ).unwrap();
        assert_eq!(facts, (9,7,"body".into(),"0000803F".into(),11));
        connection.execute(
            "UPDATE kbm_file_versions SET version=8 WHERE path='Diary/note.txt'", [],
        ).unwrap();
        initialize_schema(&connection, 2).unwrap();
        assert_eq!(connection.query_row(
            "SELECT version FROM kbm_file_versions WHERE path='Diary/note.txt'
             AND exists_flag=1 AND mtime=1234", [], |r|r.get::<_,i64>(0),
        ).unwrap(),8);
    }

    #[test]
    fn normalized_path_collision_rolls_back_without_losing_vectors() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE kbm_runtime_meta(key TEXT PRIMARY KEY,value TEXT);
             INSERT INTO kbm_runtime_meta VALUES ('schema_version','1');"
        ).unwrap();
        initialize_schema(&connection, 2).unwrap();
        connection.execute_batch(
            "INSERT INTO files(path,diary_name,checksum,mtime,size)
             VALUES ('Diary\\note.txt','Diary','a',1,1),('Diary/note.txt','Diary','b',2,2);"
        ).unwrap();
        assert!(initialize_schema(&connection, 2).unwrap_err().contains("LEGACY_PATH_COLLISION"));
        assert_eq!(connection.query_row(
            "SELECT COUNT(*) FROM files", [], |r|r.get::<_,i64>(0),
        ).unwrap(),2);
        assert_eq!(connection.query_row(
            "SELECT COUNT(*) FROM files WHERE instr(path,char(92))>0", [], |r|r.get::<_,i64>(0),
        ).unwrap(),1);
    }

    use rusqlite::OptionalExtension;
}



#[cfg(test)]
mod geometry_migration_tests {
    use super::*;

    #[test]
    fn old_objects_retire_and_restart_preserves_geometry_generation() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE kbm_runtime_meta(key TEXT PRIMARY KEY,value TEXT);
             INSERT INTO kbm_runtime_meta VALUES ('schema_version','1'),('derived_pairwise','7');
             CREATE TABLE tag_pair_similarity(tag_a INTEGER);
             CREATE TABLE tag_pair_similarity_status(tag_a INTEGER);
             CREATE TABLE kv_store(key TEXT PRIMARY KEY,value TEXT,vector BLOB);
             INSERT INTO kv_store(key,value) VALUES ('epa_basis_cache','old');
             CREATE TRIGGER trg_tags_delete_pair_cache AFTER DELETE ON tag_pair_similarity BEGIN SELECT 1; END;"
        ).unwrap();
        initialize_schema(&conn, 2).unwrap();
        let retired: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'tag_pair_similarity%'
             OR name LIKE 'trg_pairwise_%' OR name='trg_tags_delete_pair_cache'",
            [], |r| r.get(0),
        ).unwrap();
        assert_eq!(retired, 0);
        conn.execute("INSERT INTO kv_store(key,value) VALUES ('epa_basis_cache','new')", []).unwrap();
        let before: String = conn.query_row(
            "SELECT value FROM kbm_runtime_meta WHERE key='derived_geometry'", [], |r| r.get(0),
        ).unwrap();
        conn.execute_batch("CREATE INDEX idx_intrinsic_residual_artifact ON tag_intrinsic_residuals(artifact_sig);").unwrap();
        initialize_schema(&conn, 2).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name='idx_intrinsic_residual_artifact'", [], |r|r.get::<_,i64>(0)).unwrap(),0);
        let after: String = conn.query_row(
            "SELECT value FROM kbm_runtime_meta WHERE key='derived_geometry'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(before, after);
        let cache: String = conn.query_row(
            "SELECT value FROM kv_store WHERE key='epa_basis_cache'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(cache, "new");
        conn.execute_batch("INSERT INTO tags(name) VALUES ('a'); UPDATE tags SET vector=X'0000803f';").unwrap();
        assert_eq!(conn.query_row("SELECT vector_version FROM tags", [], |r| r.get::<_,i64>(0)).unwrap(), 2);
    }
}
