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
        vector BLOB,
        vector_version INTEGER NOT NULL DEFAULT 1
    );

    -- 全局 Tag usearch 双槽基线。
    -- tags 是唯一权威真相；本页只描述某个磁盘 usearch 槽内包含的 Tag 版本，
    -- 启动时据此回放新增、更新和删除，而不是从 SQLite 全量重建 HNSW。
    CREATE TABLE IF NOT EXISTS tag_index_baselines (
        generation INTEGER PRIMARY KEY,
        slot TEXT NOT NULL CHECK(slot IN ('a', 'b')),
        dimension INTEGER NOT NULL,
        model_sig TEXT NOT NULL,
        tag_count INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('building', 'ready')),
        created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tag_index_baseline_entries (
        generation INTEGER NOT NULL,
        tag_id INTEGER NOT NULL,
        vector_version INTEGER NOT NULL,
        PRIMARY KEY (generation, tag_id),
        FOREIGN KEY(generation) REFERENCES tag_index_baselines(generation) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_tag_index_baseline_entries_generation
        ON tag_index_baseline_entries(generation);
    -- 单 Agent / 日记本 Chunk usearch 双槽基线。
    -- chunks 表是唯一权威真相；本页记录某个 usearch 槽内包含的 Chunk ID 集合快照。
    -- 启动或搜索懒加载时据此做集合对称差分回放，避免全量重建。
    CREATE TABLE IF NOT EXISTS chunk_index_baselines (
        diary_name TEXT NOT NULL,
        generation INTEGER NOT NULL,
        slot TEXT NOT NULL CHECK(slot IN ('a', 'b')),
        dimension INTEGER NOT NULL,
        model_sig TEXT NOT NULL,
        chunk_count INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('building', 'ready')),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (diary_name, generation)
    );
    CREATE TABLE IF NOT EXISTS chunk_index_baseline_entries (
        diary_name TEXT NOT NULL,
        generation INTEGER NOT NULL,
        chunk_id INTEGER NOT NULL,
        PRIMARY KEY (diary_name, generation, chunk_id),
        FOREIGN KEY(diary_name, generation)
            REFERENCES chunk_index_baselines(diary_name, generation) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chunk_index_baseline_entries_lookup
        ON chunk_index_baseline_entries(diary_name, generation);
    CREATE INDEX IF NOT EXISTS idx_chunk_index_baselines_diary
        ON chunk_index_baselines(diary_name, status);

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
    -- 主键只覆盖 tag_a 左前缀；反向端点索引保证按任一 Tag
    -- 枚举或失效无向 Pair 时不会退化为全表扫描。
    CREATE INDEX IF NOT EXISTS idx_pair_sim_tag_b
        ON tag_pair_similarity(tag_b);

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
    CREATE INDEX IF NOT EXISTS idx_pair_sim_status_tag_b
        ON tag_pair_similarity_status(tag_b);

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


const GEN_USEARCH_SCHEMA_SQL = `
    -- Gen-USearch G1 durable metadata core.
    -- Existing files/chunks remain the canonical content source during G1. These tables
    -- add stable logical identity and lifecycle authority without changing read traffic.
    CREATE TABLE IF NOT EXISTS gen_usearch_documents (
        doc_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK(state IN ('ACTIVE', 'DELETED')),
        index_state TEXT NOT NULL CHECK(index_state IN ('CURRENT', 'INDEX_LAGGING', 'INDEX_ERROR')),
        current_uri TEXT,
        observed_source_digest TEXT,
        observed_source_revision TEXT,
        reconcile_target_revision TEXT,
        reconciliation_state TEXT NOT NULL CHECK(reconciliation_state IN ('PENDING', 'ADMITTED', 'COMPLETE', 'ERROR')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gen_usearch_active_document_uri
        ON gen_usearch_documents(current_uri)
        WHERE state = 'ACTIVE' AND current_uri IS NOT NULL;

    CREATE TABLE IF NOT EXISTS gen_usearch_document_uri_history (
        doc_id TEXT NOT NULL,
        uri TEXT NOT NULL,
        valid_from_visibility_seq INTEGER NOT NULL CHECK(valid_from_visibility_seq >= 0),
        valid_to_visibility_seq INTEGER CHECK(
            valid_to_visibility_seq IS NULL
            OR valid_to_visibility_seq >= valid_from_visibility_seq
        ),
        PRIMARY KEY (doc_id, uri, valid_from_visibility_seq),
        FOREIGN KEY(doc_id) REFERENCES gen_usearch_documents(doc_id) ON DELETE CASCADE
    );

    -- Durable identity-only reconciliation intent. G1 persists the exact plan
    -- in the same crash-durable transaction as the source observation; lifecycle
    -- publication remains a separate G2 authority.
    CREATE TABLE IF NOT EXISTS gen_usearch_reconciliation_plans (
        plan_id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        base_document_uri TEXT,
        base_identity_digest TEXT NOT NULL CHECK(length(base_identity_digest) = 64),
        observed_source_digest TEXT NOT NULL,
        observed_source_revision TEXT NOT NULL,
        target_revision TEXT NOT NULL,
        plan_digest TEXT NOT NULL CHECK(length(plan_digest) = 64),
        state TEXT NOT NULL CHECK(state IN ('PENDING', 'ADMITTED', 'COMPLETE', 'ERROR', 'SUPERSEDED')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(doc_id, target_revision),
        FOREIGN KEY(doc_id) REFERENCES gen_usearch_documents(doc_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_gen_usearch_reconciliation_doc_state
        ON gen_usearch_reconciliation_plans(doc_id, state, target_revision);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gen_usearch_one_open_reconciliation_per_doc
        ON gen_usearch_reconciliation_plans(doc_id)
        WHERE state IN ('PENDING', 'ADMITTED', 'ERROR');

    CREATE TABLE IF NOT EXISTS gen_usearch_reconciliation_items (
        plan_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        kind TEXT NOT NULL CHECK(kind IN (
            'SAME', 'MODIFY', 'MOVE', 'INSERT',
            'DELETE', 'SPLIT', 'MERGE', 'AMBIGUOUS'
        )),
        payload_json TEXT NOT NULL,
        PRIMARY KEY (plan_id, ordinal),
        FOREIGN KEY(plan_id) REFERENCES gen_usearch_reconciliation_plans(plan_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS gen_usearch_chunk_heads (
        chunk_id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        current_version_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(doc_id) REFERENCES gen_usearch_documents(doc_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS gen_usearch_chunk_versions (
        chunk_version_id INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_id TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        slot_index INTEGER,
        content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
        state TEXT NOT NULL CHECK(state IN (
            'PREPARED', 'EMBEDDING', 'VECTOR_STAGED', 'ACTIVE',
            'RETIRED', 'ABORTED', 'GC_ELIGIBLE'
        )),
        vector_id INTEGER UNIQUE,
        visibility_seq INTEGER CHECK(visibility_seq IS NULL OR visibility_seq >= 0),
        retired_visibility_seq INTEGER CHECK(
            retired_visibility_seq IS NULL OR retired_visibility_seq >= 0
        ),
        embedding_fingerprint TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(chunk_id) REFERENCES gen_usearch_chunk_heads(chunk_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_gen_usearch_chunk_versions_chunk
        ON gen_usearch_chunk_versions(chunk_id, chunk_version_id);
    CREATE INDEX IF NOT EXISTS idx_gen_usearch_chunk_versions_state
        ON gen_usearch_chunk_versions(state);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gen_usearch_one_active_version_per_chunk
        ON gen_usearch_chunk_versions(chunk_id)
        WHERE state = 'ACTIVE';

    CREATE TABLE IF NOT EXISTS gen_usearch_segments (
        segment_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK(state IN (
            'BUILDING', 'FINALIZED_DURABLE', 'PUBLISHED',
            'RETIRED', 'RECLAIMABLE'
        )),
        artifact_path TEXT,
        artifact_digest TEXT,
        embedding_fingerprint TEXT NOT NULL,
        dimension INTEGER NOT NULL CHECK(dimension > 0),
        vector_count INTEGER NOT NULL DEFAULT 0 CHECK(vector_count >= 0),
        created_at INTEGER NOT NULL,
        finalized_at INTEGER,
        published_at INTEGER,
        retired_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS gen_usearch_manifest_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        manifest_epoch INTEGER NOT NULL CHECK(manifest_epoch >= 0),
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gen_usearch_manifest_segments (
        manifest_epoch INTEGER NOT NULL CHECK(manifest_epoch >= 0),
        segment_id TEXT NOT NULL,
        PRIMARY KEY (manifest_epoch, segment_id),
        FOREIGN KEY(segment_id) REFERENCES gen_usearch_segments(segment_id)
    );

    CREATE TABLE IF NOT EXISTS gen_usearch_vector_recovery (
        vector_id INTEGER PRIMARY KEY,
        chunk_version_id INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN (
            'RECOVERY_REQUIRED', 'SEGMENT_COVERED',
            'RECOVERY_RECLAIMABLE', 'RECOVERY_RELEASED'
        )),
        embedding_fingerprint TEXT NOT NULL,
        vector_blob BLOB,
        covered_segment_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(chunk_version_id) REFERENCES gen_usearch_chunk_versions(chunk_version_id) ON DELETE CASCADE,
        FOREIGN KEY(covered_segment_id) REFERENCES gen_usearch_segments(segment_id)
    );

    -- Physical query coverage is written only after a concrete source has accepted
    -- the vector. MVCC publication refuses to make a vector current without at
    -- least one QUERY_VISIBLE coverage row.
    CREATE TABLE IF NOT EXISTS gen_usearch_vector_coverage (
        vector_id INTEGER NOT NULL,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('MEMTABLE', 'SEGMENT')),
        source_id TEXT NOT NULL,
        coverage_state TEXT NOT NULL CHECK(coverage_state IN (
            'STAGED', 'QUERY_VISIBLE', 'RETIRED'
        )),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (vector_id, source_kind, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_gen_usearch_vector_coverage_query
        ON gen_usearch_vector_coverage(vector_id, coverage_state);

    CREATE TABLE IF NOT EXISTS gen_usearch_sequences (
        name TEXT PRIMARY KEY CHECK(name IN ('visibility_seq', 'manifest_epoch')),
        value INTEGER NOT NULL CHECK(value >= 0),
        updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gen_usearch_vector_allocator (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        high_water INTEGER NOT NULL CHECK(high_water >= 0),
        updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gen_usearch_runtime_ownership (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        owner_id TEXT,
        serving_state TEXT NOT NULL CHECK(serving_state IN ('IDLE', 'SERVING', 'DRAINING')),
        runtime_fence INTEGER NOT NULL CHECK(runtime_fence >= 0),
        acquired_at INTEGER,
        updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gen_usearch_engine_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        mode TEXT NOT NULL CHECK(mode IN ('LEGACY', 'GENERATIONAL_SHADOW', 'GENERATIONAL_ACTIVE')),
        updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gen_usearch_runtime_process_lease (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        owner_id TEXT NOT NULL,
        runtime_fence INTEGER NOT NULL CHECK(runtime_fence >= 0),
        process_token TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gen_usearch_read_view_leases (
        read_view_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        runtime_fence INTEGER NOT NULL CHECK(runtime_fence >= 0),
        visibility_seq INTEGER NOT NULL CHECK(visibility_seq >= 0),
        state TEXT NOT NULL CHECK(state IN (
            'ACTIVE', 'CANCEL_REQUESTED', 'QUIESCING', 'RELEASED'
        )),
        cancellation_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancellation_requested IN (0, 1)),
        worker_quiescent INTEGER NOT NULL DEFAULT 0 CHECK(worker_quiescent IN (0, 1)),
        pins_released INTEGER NOT NULL DEFAULT 0 CHECK(pins_released IN (0, 1)),
        created_at INTEGER NOT NULL,
        deadline INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gen_usearch_read_view_leases_gc
        ON gen_usearch_read_view_leases(runtime_fence, state, visibility_seq);

    INSERT OR IGNORE INTO gen_usearch_sequences(name, value, updated_at)
    VALUES
        ('visibility_seq', 0, 0),
        ('manifest_epoch', 0, 0);
    INSERT OR IGNORE INTO gen_usearch_vector_allocator(singleton, high_water, updated_at)
    VALUES (1, 0, 0);
    INSERT OR IGNORE INTO gen_usearch_manifest_state(singleton, manifest_epoch, updated_at)
    VALUES (1, 0, 0);
    INSERT OR IGNORE INTO gen_usearch_runtime_ownership(
        singleton, owner_id, serving_state, runtime_fence, acquired_at, updated_at
    ) VALUES (1, NULL, 'IDLE', 0, NULL, 0);
    INSERT OR IGNORE INTO gen_usearch_engine_state(singleton, mode, updated_at)
    VALUES (1, 'LEGACY', 0);
`;

const POST_MIGRATION_INDEX_SQL = `
    -- Pairwise 扫描前事实代际。该值与 tags/file_tags 的权威变更处于同一
    -- SQLite 事务，使 Rust 可以在读取全库高维 BLOB 前安全短路。
    INSERT OR IGNORE INTO kv_store(key, value)
    VALUES ('tagmemo_pairwise_fact_generation', '1');

    CREATE TRIGGER IF NOT EXISTS trg_pairwise_tags_insert_generation
    AFTER INSERT ON tags
    BEGIN
        UPDATE kv_store
        SET value = CAST(COALESCE(CAST(value AS INTEGER), 0) + 1 AS TEXT)
        WHERE key = 'tagmemo_pairwise_fact_generation';
    END;

    CREATE TRIGGER IF NOT EXISTS trg_pairwise_tags_vector_generation
    AFTER UPDATE OF vector ON tags
    WHEN OLD.vector IS NOT NEW.vector
    BEGIN
        UPDATE kv_store
        SET value = CAST(COALESCE(CAST(value AS INTEGER), 0) + 1 AS TEXT)
        WHERE key = 'tagmemo_pairwise_fact_generation';
    END;

    CREATE TRIGGER IF NOT EXISTS trg_pairwise_tags_delete_generation
    AFTER DELETE ON tags
    BEGIN
        UPDATE kv_store
        SET value = CAST(COALESCE(CAST(value AS INTEGER), 0) + 1 AS TEXT)
        WHERE key = 'tagmemo_pairwise_fact_generation';
    END;

    CREATE TRIGGER IF NOT EXISTS trg_pairwise_file_tags_insert_generation
    AFTER INSERT ON file_tags
    BEGIN
        UPDATE kv_store
        SET value = CAST(COALESCE(CAST(value AS INTEGER), 0) + 1 AS TEXT)
        WHERE key = 'tagmemo_pairwise_fact_generation';
    END;

    CREATE TRIGGER IF NOT EXISTS trg_pairwise_file_tags_update_generation
    AFTER UPDATE OF file_id, tag_id ON file_tags
    WHEN OLD.file_id IS NOT NEW.file_id OR OLD.tag_id IS NOT NEW.tag_id
    BEGIN
        UPDATE kv_store
        SET value = CAST(COALESCE(CAST(value AS INTEGER), 0) + 1 AS TEXT)
        WHERE key = 'tagmemo_pairwise_fact_generation';
    END;

    CREATE TRIGGER IF NOT EXISTS trg_pairwise_file_tags_delete_generation
    AFTER DELETE ON file_tags
    BEGIN
        UPDATE kv_store
        SET value = CAST(COALESCE(CAST(value AS INTEGER), 0) + 1 AS TEXT)
        WHERE key = 'tagmemo_pairwise_fact_generation';
    END;

    -- 必须在旧数据库完成 tags.vector_version 附加迁移后创建。
    -- Tag 向量版本由 SQLite 在事实事务内单调推进，启动差分只比较整数版本，
    -- 不需要读取并哈希全库高维 BLOB。WHEN 条件避免无关字段更新误增版本。
    CREATE TRIGGER IF NOT EXISTS trg_tags_vector_version
    AFTER UPDATE OF vector ON tags
    WHEN OLD.vector IS NOT NEW.vector
    BEGIN
        UPDATE tags
        SET vector_version = OLD.vector_version + 1
        WHERE id = NEW.id;
    END;

    CREATE INDEX IF NOT EXISTS idx_intrinsic_residual_artifact
        ON tag_intrinsic_residuals(artifact_sig);
    CREATE INDEX IF NOT EXISTS idx_intrinsic_residual_model
        ON tag_intrinsic_residuals(model_sig);
`;

const GEN_USEARCH_ADDITIVE_MIGRATIONS = Object.freeze([
    ['gen_usearch_reconciliation_plans', 'base_document_uri', 'TEXT'],
    ['gen_usearch_reconciliation_plans', 'base_identity_digest', 'TEXT'],
    ['gen_usearch_segments', 'dimension', 'INTEGER CHECK(dimension IS NULL OR dimension > 0)']
]);

const ADDITIVE_MIGRATIONS = Object.freeze([
    ['tags', 'vector_version', 'INTEGER NOT NULL DEFAULT 1'],
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
    const reversePairIndexes = [
        'idx_pair_sim_tag_b',
        'idx_pair_sim_status_tag_b'
    ];
    const existingReversePairIndexes = new Set(
        db.prepare(`
            SELECT name
            FROM sqlite_master
            WHERE type = 'index'
              AND name IN (?, ?)
        `).all(...reversePairIndexes).map(row => row.name)
    );
    const missingReversePairIndexes = reversePairIndexes.filter(
        name => !existingReversePairIndexes.has(name)
    );
    const reverseIndexMigrationStartedAt = Date.now();

    if (missingReversePairIndexes.length > 0) {
        console.warn(
            `[${logPrefix}] 🧱 Building missing Pairwise reverse endpoint ` +
            `index(es): ${missingReversePairIndexes.join(', ')}. ` +
            'Large databases may take time; startup will continue after SQLite finishes.'
        );
    }

    db.exec(CORE_SCHEMA_SQL);

    if (missingReversePairIndexes.length > 0) {
        console.log(
            `[${logPrefix}] ✅ Pairwise reverse endpoint index migration complete: ` +
            `${missingReversePairIndexes.join(', ')}, ` +
            `elapsed=${Date.now() - reverseIndexMigrationStartedAt}ms.`
        );
    }

    for (const [table, column, definition] of ADDITIVE_MIGRATIONS) {
        addColumnIfMissing(db, table, column, definition, logPrefix);
    }
    db.exec(POST_MIGRATION_INDEX_SQL);
    db.exec(GEN_USEARCH_SCHEMA_SQL);
    for (const [table, column, definition] of GEN_USEARCH_ADDITIVE_MIGRATIONS) {
        addColumnIfMissing(db, table, column, definition, logPrefix);
    }
}

module.exports = {
    initializeKnowledgeBaseSchema
};