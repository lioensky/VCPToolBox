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

    -- RiverMemo/V10 精确向量派生资产。
    -- vector_sig 是原始 Float32 BLOB 的 SHA-256；模型、维度或向量内容变化时
    -- 对应范数及 Chunk-Tag closure 自动失效。所有值均由 Float64 累加产生，
    -- 仅消除查询热路径的重复计算，不做量化或近似。
    CREATE TABLE IF NOT EXISTS v10_vector_metrics (
        entity_type TEXT NOT NULL CHECK(entity_type IN ('tag', 'chunk')),
        entity_id INTEGER NOT NULL,
        model_sig TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        vector_sig TEXT NOT NULL,
        l2_norm REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (entity_type, entity_id, model_sig, dimension)
    );
    CREATE INDEX IF NOT EXISTS idx_v10_vector_metrics_generation
        ON v10_vector_metrics(model_sig, dimension, entity_type);

    CREATE TABLE IF NOT EXISTS v10_chunk_tag_geometry (
        chunk_id INTEGER NOT NULL,
        tag_id INTEGER NOT NULL,
        model_sig TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        chunk_vector_sig TEXT NOT NULL,
        tag_vector_sig TEXT NOT NULL,
        cosine REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (chunk_id, tag_id, model_sig, dimension),
        FOREIGN KEY(chunk_id) REFERENCES chunks(id) ON DELETE CASCADE,
        FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_v10_chunk_tag_geometry_tag
        ON v10_chunk_tag_geometry(tag_id, model_sig, dimension);

    CREATE TABLE IF NOT EXISTS v10_derived_asset_status (
        asset_type TEXT NOT NULL,
        model_sig TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        source_generation TEXT NOT NULL,
        row_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        error_message TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (asset_type, model_sig, dimension)
    );

    -- 事实变化与派生失效必须处于同一 SQLite 事务。即使进程在写入后、
    -- JS 通知前崩溃，下一次启动也会看到 stale 并执行精确增量核验。
    CREATE TRIGGER IF NOT EXISTS trg_v10_tags_insert_stale
    AFTER INSERT ON tags BEGIN
        UPDATE v10_derived_asset_status
        SET status = 'stale', error_message = 'tags-inserted',
            updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_v10_tags_vector_stale
    AFTER UPDATE OF vector ON tags BEGIN
        UPDATE v10_derived_asset_status
        SET status = 'stale', error_message = 'tag-vector-updated',
            updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_v10_tags_delete_stale
    AFTER DELETE ON tags BEGIN
        UPDATE v10_derived_asset_status
        SET status = 'stale', error_message = 'tags-deleted',
            updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_v10_chunks_insert_stale
    AFTER INSERT ON chunks BEGIN
        UPDATE v10_derived_asset_status
        SET status = 'stale', error_message = 'chunks-inserted',
            updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_v10_chunks_vector_stale
    AFTER UPDATE OF vector ON chunks BEGIN
        UPDATE v10_derived_asset_status
        SET status = 'stale', error_message = 'chunk-vector-updated',
            updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_v10_chunks_delete_stale
    AFTER DELETE ON chunks BEGIN
        UPDATE v10_derived_asset_status
        SET status = 'stale', error_message = 'chunks-deleted',
            updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_v10_file_tags_insert_stale
    AFTER INSERT ON file_tags BEGIN
        UPDATE v10_derived_asset_status
        SET status = 'stale', error_message = 'file-tags-inserted',
            updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_v10_file_tags_delete_stale
    AFTER DELETE ON file_tags BEGIN
        UPDATE v10_derived_asset_status
        SET status = 'stale', error_message = 'file-tags-deleted',
            updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000;
    END;

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