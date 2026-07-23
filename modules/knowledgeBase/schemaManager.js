'use strict';

const CORE_SCHEMA_SQL = `
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
        vector BLOB
    );
    CREATE TABLE IF NOT EXISTS file_tags (
        file_id INTEGER NOT NULL,
        tag_id INTEGER NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (file_id, tag_id),
        FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE,
        FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS tag_intrinsic_residuals (
        tag_id INTEGER PRIMARY KEY,
        residual_energy REAL NOT NULL,
        neighbor_count INTEGER NOT NULL,
        computed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- TagMemo V9.1 派生资产注册表。
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
    CREATE INDEX IF NOT EXISTS idx_tagmemo_artifacts_lookup
        ON tagmemo_artifacts(asset_type, model_sig, status);

    -- RiverMemo Topology V3 独立持久化资产。
    -- payload 保存 gzip 压缩的规范 JSON；checksum 验证解压后的原始字节。
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
    CREATE INDEX IF NOT EXISTS idx_rivermemo_artifacts_compatible
        ON rivermemo_artifacts(
            source_v9_artifact_sig,
            model_sig,
            config_hash,
            database_generation,
            status,
            updated_at
        );
    CREATE INDEX IF NOT EXISTS idx_rivermemo_artifacts_status
        ON rivermemo_artifacts(status, updated_at);

    CREATE TABLE IF NOT EXISTS tag_intrinsic_residual_status (
        tag_id INTEGER NOT NULL,
        artifact_sig TEXT NOT NULL,
        status TEXT NOT NULL,
        neighbor_count INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        computed_at INTEGER NOT NULL,
        PRIMARY KEY (tag_id, artifact_sig),
        FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_intrinsic_residual_status_artifact
        ON tag_intrinsic_residual_status(artifact_sig, status);

    CREATE TABLE IF NOT EXISTS tag_pair_similarity (
        tag_a INTEGER NOT NULL,
        tag_b INTEGER NOT NULL,
        similarity REAL NOT NULL,
        model_sig TEXT NOT NULL,
        computed_at INTEGER NOT NULL,
        PRIMARY KEY (tag_a, tag_b),
        FOREIGN KEY (tag_a) REFERENCES tags(id) ON DELETE CASCADE,
        FOREIGN KEY (tag_b) REFERENCES tags(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pair_sim_model
        ON tag_pair_similarity(model_sig);

    CREATE TABLE IF NOT EXISTS tag_pair_similarity_status (
        tag_a INTEGER NOT NULL,
        tag_b INTEGER NOT NULL,
        model_sig TEXT NOT NULL,
        artifact_sig TEXT NOT NULL,
        status TEXT NOT NULL,
        similarity REAL,
        min_similarity REAL NOT NULL,
        computed_at INTEGER NOT NULL,
        PRIMARY KEY (tag_a, tag_b, artifact_sig),
        FOREIGN KEY (tag_a) REFERENCES tags(id) ON DELETE CASCADE,
        FOREIGN KEY (tag_b) REFERENCES tags(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pair_sim_status_artifact
        ON tag_pair_similarity_status(artifact_sig, status);
    CREATE INDEX IF NOT EXISTS idx_pair_sim_status_model
        ON tag_pair_similarity_status(model_sig);

    CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT,
        vector BLOB
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
        PRIMARY KEY (cache_file_id, chunk_index),
        FOREIGN KEY(cache_file_id) REFERENCES migration_deleted_files(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_files_diary ON files(diary_name);
    CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
    CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_file_tags_composite ON file_tags(tag_id, file_id);
    CREATE INDEX IF NOT EXISTS idx_migration_deleted_lookup
        ON migration_deleted_files(checksum, size, expires_at);
    CREATE INDEX IF NOT EXISTS idx_migration_deleted_expiry
        ON migration_deleted_files(expires_at);
`;

const POST_MIGRATION_INDEX_SQL = `
    CREATE INDEX IF NOT EXISTS idx_intrinsic_residual_artifact
        ON tag_intrinsic_residuals(artifact_sig);
    CREATE INDEX IF NOT EXISTS idx_intrinsic_residual_model
        ON tag_intrinsic_residuals(model_sig);
`;

const ADDITIVE_MIGRATIONS = Object.freeze([
    ['file_tags', 'position', 'INTEGER NOT NULL DEFAULT 0'],
    ['tag_intrinsic_residuals', 'raw_residual_ratio', 'REAL'],
    // 退休物理列仅用于兼容已有 SQLite 文件与旧原生二进制。
    ['tag_intrinsic_residuals', 'v8_3_compat_gain', 'REAL'],
    ['tag_intrinsic_residuals', 'v9_anchor_gain', 'REAL'],
    ['tag_intrinsic_residuals', 'model_sig', 'TEXT'],
    ['tag_intrinsic_residuals', 'artifact_sig', 'TEXT'],
    ['tag_intrinsic_residuals', 'algorithm_version', 'TEXT'],
    ['tag_intrinsic_residuals', 'config_hash', 'TEXT'],
    ['tag_intrinsic_residuals', 'status', "TEXT NOT NULL DEFAULT 'computed'"]
]);

function assertDatabase(db) {
    if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
        throw new TypeError('initializeKnowledgeBaseSchema requires a valid database connection');
    }
}

function addColumnIfMissing(db, table, column, definition, logPrefix) {
    try {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all();
        if (columns.some(item => item.name === column)) return false;

        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        console.log(`[${logPrefix}] 🧱 Schema migration: added ${table}.${column}`);
        return true;
    } catch (error) {
        console.error(
            `[${logPrefix}] ❌ Schema migration failed for ${table}.${column}:`,
            error.message
        );
        throw error;
    }
}

/**
 * 初始化 KnowledgeBase 的事实表、派生表及附加式迁移。
 * 本模块不保存连接，也不执行运行数据清理。
 *
 * @param {object} db better-sqlite3 连接
 * @param {object} [options]
 * @param {string} [options.logPrefix='KnowledgeBase']
 */
function initializeKnowledgeBaseSchema(db, options = {}) {
    assertDatabase(db);
    const logPrefix = options.logPrefix || 'KnowledgeBase';

    db.exec(CORE_SCHEMA_SQL);
    for (const [table, column, definition] of ADDITIVE_MIGRATIONS) {
        addColumnIfMissing(db, table, column, definition, logPrefix);
    }
    db.exec(POST_MIGRATION_INDEX_SQL);
}

module.exports = {
    initializeKnowledgeBaseSchema
};