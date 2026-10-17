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
CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT,
    vector BLOB
);
CREATE TABLE IF NOT EXISTS tag_pair_similarity (
    tag_a INTEGER NOT NULL,
    tag_b INTEGER NOT NULL,
    similarity REAL NOT NULL,
    model_sig TEXT NOT NULL,
    computed_at INTEGER NOT NULL,
    PRIMARY KEY(tag_a, tag_b)
);
CREATE TABLE IF NOT EXISTS tag_pair_similarity_status (
    tag_a INTEGER NOT NULL,
    tag_b INTEGER NOT NULL,
    model_sig TEXT NOT NULL,
    artifact_sig TEXT NOT NULL,
    status TEXT NOT NULL,
    similarity REAL,
    min_similarity REAL NOT NULL,
    computed_at INTEGER NOT NULL,
    PRIMARY KEY(tag_a, tag_b, artifact_sig)
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
CREATE INDEX IF NOT EXISTS idx_pair_sim_model ON tag_pair_similarity(model_sig);
CREATE INDEX IF NOT EXISTS idx_pair_sim_tag_b ON tag_pair_similarity(tag_b);
CREATE INDEX IF NOT EXISTS idx_pair_status_artifact
    ON tag_pair_similarity_status(artifact_sig,status);
CREATE INDEX IF NOT EXISTS idx_intrinsic_residual_artifact
    ON tag_intrinsic_residuals(artifact_sig);
CREATE INDEX IF NOT EXISTS idx_intrinsic_residual_model
    ON tag_intrinsic_residuals(model_sig);
CREATE INDEX IF NOT EXISTS idx_intrinsic_status_artifact
    ON tag_intrinsic_residual_status(artifact_sig,status);
CREATE INDEX IF NOT EXISTS idx_rivermemo_compatible
    ON rivermemo_artifacts(source_v9_artifact_sig,model_sig,config_hash,
                            database_generation,status,updated_at);
CREATE TRIGGER IF NOT EXISTS trg_tags_vector_version
AFTER UPDATE OF vector ON tags
WHEN OLD.vector IS NOT NEW.vector
BEGIN
    UPDATE tags SET vector_version = OLD.vector_version + 1 WHERE id = NEW.id;
END;
"#;

const GENERATION_SQL: &str = r#"
INSERT OR IGNORE INTO kv_store(key,value)
VALUES ('tagmemo_pairwise_fact_generation','1');
CREATE TRIGGER IF NOT EXISTS trg_pairwise_tags_insert_generation
AFTER INSERT ON tags BEGIN
    UPDATE kv_store SET value=CAST(COALESCE(CAST(value AS INTEGER),0)+1 AS TEXT)
    WHERE key='tagmemo_pairwise_fact_generation';
END;
CREATE TRIGGER IF NOT EXISTS trg_pairwise_tags_vector_generation
AFTER UPDATE OF vector ON tags
WHEN OLD.vector IS NOT NEW.vector BEGIN
    UPDATE kv_store SET value=CAST(COALESCE(CAST(value AS INTEGER),0)+1 AS TEXT)
    WHERE key='tagmemo_pairwise_fact_generation';
END;
CREATE TRIGGER IF NOT EXISTS trg_pairwise_tags_delete_generation
AFTER DELETE ON tags BEGIN
    UPDATE kv_store SET value=CAST(COALESCE(CAST(value AS INTEGER),0)+1 AS TEXT)
    WHERE key='tagmemo_pairwise_fact_generation';
END;
CREATE TRIGGER IF NOT EXISTS trg_pairwise_file_tags_insert_generation
AFTER INSERT ON file_tags BEGIN
    UPDATE kv_store SET value=CAST(COALESCE(CAST(value AS INTEGER),0)+1 AS TEXT)
    WHERE key='tagmemo_pairwise_fact_generation';
END;
CREATE TRIGGER IF NOT EXISTS trg_pairwise_file_tags_delete_generation
AFTER DELETE ON file_tags BEGIN
    UPDATE kv_store SET value=CAST(COALESCE(CAST(value AS INTEGER),0)+1 AS TEXT)
    WHERE key='tagmemo_pairwise_fact_generation';
END;
"#;

pub(crate) fn initialize_schema(
    connection: &Connection,
    requested_version: i64,
) -> Result<i64, String> {
    connection
        .execute_batch(SCHEMA_SQL)
        .map_err(|error| format!("initialize KBM schema failed: {}", error))?;
    ensure_additive_columns(connection)?;
    connection
        .execute_batch(GENERATION_SQL)
        .map_err(|error| format!("initialize KBM generation triggers failed: {}", error))?;
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
    if version < requested_version {
        connection
            .execute(
                "UPDATE kbm_runtime_meta SET value=?1 WHERE key='schema_version'",
                [requested_version.to_string()],
            )
            .map_err(|error| format!("publish KBM schema version failed: {}", error))?;
    }
    Ok(requested_version.max(version))
}

fn ensure_additive_columns(connection: &Connection) -> Result<(), String> {
    let migrations = [
        (
            "chunk_index_baseline_entries",
            "chunk_vector_sig",
            "TEXT",
        ),
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
            .filter_map(Result::ok)
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
