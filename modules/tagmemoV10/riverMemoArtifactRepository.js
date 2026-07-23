'use strict';

const crypto = require('crypto');
const zlib = require('zlib');

const PAYLOAD_CODEC = 'gzip-json-v1';
const PAYLOAD_SCHEMA = 'rivermemo-persisted-artifact-v1';

class RiverMemoArtifactRepository {
    constructor(options = {}) {
        this.getDb = typeof options.getDb === 'function'
            ? options.getDb
            : () => options.db || null;
        this.retainedReadyArtifacts = Math.max(
            1,
            Math.floor(Number(options.retainedReadyArtifacts) || 2)
        );
    }

    _db() {
        const db = this.getDb();
        if (!db?.prepare || !db?.transaction) {
            throw new Error('RiverMemo artifact repository database is unavailable');
        }
        return db;
    }

    _checksum(buffer) {
        return crypto.createHash('sha256').update(buffer).digest('hex');
    }

    encodePayload(payload) {
        if (!payload || payload.schema !== PAYLOAD_SCHEMA) {
            throw new TypeError(`RiverMemo payload schema must be ${PAYLOAD_SCHEMA}`);
        }
        const raw = Buffer.from(JSON.stringify(payload), 'utf8');
        return Object.freeze({
            codec: PAYLOAD_CODEC,
            checksum: this._checksum(raw),
            compressed: zlib.gzipSync(raw, { level: 6 }),
            rawBytes: raw.length
        });
    }

    decodePayload(row) {
        if (!row?.payload) {
            throw new Error('RiverMemo persisted artifact has no payload');
        }
        if (row.payload_codec !== PAYLOAD_CODEC) {
            throw new Error(
                `Unsupported RiverMemo payload codec: ${row.payload_codec}`
            );
        }
        const compressed = Buffer.isBuffer(row.payload)
            ? row.payload
            : Buffer.from(row.payload);
        const raw = zlib.gunzipSync(compressed);
        const checksum = this._checksum(raw);
        if (!row.payload_checksum || checksum !== row.payload_checksum) {
            throw new Error('RiverMemo persisted payload checksum mismatch');
        }
        const payload = JSON.parse(raw.toString('utf8'));
        if (payload?.schema !== PAYLOAD_SCHEMA) {
            throw new Error(`Invalid RiverMemo payload schema: ${payload?.schema}`);
        }
        return payload;
    }

    persistReady(manifest, payload) {
        const db = this._db();
        const encoded = this.encodePayload(payload);
        const now = Date.now();
        const publishedAt = Number(manifest.publishedAt) || now;
        const write = db.transaction(() => {
            db.prepare(`
                INSERT INTO rivermemo_artifacts (
                    artifact_sig,
                    schema_version,
                    algorithm_version,
                    source_v9_artifact_sig,
                    source_graph_generation,
                    model_sig,
                    config_hash,
                    database_generation,
                    provenance_generation,
                    payload_codec,
                    payload_checksum,
                    payload,
                    status,
                    error_message,
                    node_count,
                    edge_count,
                    created_at,
                    updated_at,
                    published_at
                ) VALUES (
                    @artifactSig,
                    @schemaVersion,
                    @algorithmVersion,
                    @sourceV9ArtifactSig,
                    @sourceGraphGeneration,
                    @modelSig,
                    @configHash,
                    @databaseGeneration,
                    @provenanceGeneration,
                    @payloadCodec,
                    @payloadChecksum,
                    @payload,
                    'ready',
                    NULL,
                    @nodeCount,
                    @edgeCount,
                    @createdAt,
                    @updatedAt,
                    @publishedAt
                )
                ON CONFLICT(artifact_sig) DO UPDATE SET
                    schema_version = excluded.schema_version,
                    algorithm_version = excluded.algorithm_version,
                    source_v9_artifact_sig = excluded.source_v9_artifact_sig,
                    source_graph_generation = excluded.source_graph_generation,
                    model_sig = excluded.model_sig,
                    config_hash = excluded.config_hash,
                    database_generation = excluded.database_generation,
                    provenance_generation = excluded.provenance_generation,
                    payload_codec = excluded.payload_codec,
                    payload_checksum = excluded.payload_checksum,
                    payload = excluded.payload,
                    status = 'ready',
                    error_message = NULL,
                    node_count = excluded.node_count,
                    edge_count = excluded.edge_count,
                    updated_at = excluded.updated_at,
                    published_at = excluded.published_at
            `).run({
                artifactSig: manifest.artifactSig,
                schemaVersion: manifest.schemaVersion,
                algorithmVersion: manifest.algorithmVersion,
                sourceV9ArtifactSig: manifest.sourceV9ArtifactSig,
                sourceGraphGeneration: manifest.sourceGraphGeneration,
                modelSig: manifest.modelSig,
                configHash: manifest.configHash,
                databaseGeneration: manifest.databaseGeneration,
                provenanceGeneration: manifest.provenanceGeneration,
                payloadCodec: encoded.codec,
                payloadChecksum: encoded.checksum,
                payload: encoded.compressed,
                nodeCount: Math.max(0, Number(manifest.nodeCount) || 0),
                edgeCount: Math.max(0, Number(manifest.edgeCount) || 0),
                createdAt: Number(manifest.createdAt) || now,
                updatedAt: now,
                publishedAt
            });
        });
        write();
        return Object.freeze({
            artifactSig: manifest.artifactSig,
            payloadChecksum: encoded.checksum,
            compressedBytes: encoded.compressed.length,
            rawBytes: encoded.rawBytes,
            publishedAt
        });
    }

    recordFailure(manifest, error) {
        const db = this._db();
        const now = Date.now();
        const message = String(error?.message || error || 'unknown failure')
            .slice(0, 4000);
        db.prepare(`
            INSERT INTO rivermemo_artifacts (
                artifact_sig,
                schema_version,
                algorithm_version,
                source_v9_artifact_sig,
                source_graph_generation,
                model_sig,
                config_hash,
                database_generation,
                provenance_generation,
                payload_codec,
                payload_checksum,
                payload,
                status,
                error_message,
                node_count,
                edge_count,
                created_at,
                updated_at,
                published_at
            ) VALUES (
                @artifactSig,
                @schemaVersion,
                @algorithmVersion,
                @sourceV9ArtifactSig,
                @sourceGraphGeneration,
                @modelSig,
                @configHash,
                @databaseGeneration,
                @provenanceGeneration,
                @payloadCodec,
                NULL,
                NULL,
                'failed',
                @errorMessage,
                0,
                0,
                @createdAt,
                @updatedAt,
                NULL
            )
            ON CONFLICT(artifact_sig) DO UPDATE SET
                status = 'failed',
                error_message = excluded.error_message,
                payload_checksum = NULL,
                payload = NULL,
                updated_at = excluded.updated_at,
                published_at = NULL
        `).run({
            artifactSig: manifest.artifactSig,
            schemaVersion: manifest.schemaVersion,
            algorithmVersion: manifest.algorithmVersion,
            sourceV9ArtifactSig: manifest.sourceV9ArtifactSig,
            sourceGraphGeneration: manifest.sourceGraphGeneration,
            modelSig: manifest.modelSig,
            configHash: manifest.configHash,
            databaseGeneration: manifest.databaseGeneration,
            provenanceGeneration: manifest.provenanceGeneration || 'unavailable',
            payloadCodec: PAYLOAD_CODEC,
            errorMessage: message,
            createdAt: Number(manifest.createdAt) || now,
            updatedAt: now
        });
    }

    loadCompatible(criteria) {
        const row = this._db().prepare(`
            SELECT *
            FROM rivermemo_artifacts
            WHERE source_v9_artifact_sig = ?
              AND model_sig = ?
              AND config_hash = ?
              AND database_generation = ?
              AND algorithm_version = ?
              AND status = 'ready'
            ORDER BY published_at DESC, updated_at DESC
            LIMIT 1
        `).get(
            criteria.sourceV9ArtifactSig,
            criteria.modelSig,
            criteria.configHash,
            criteria.databaseGeneration,
            criteria.algorithmVersion
        );
        if (!row) return null;
        return Object.freeze({
            row: Object.freeze({ ...row, payload: undefined }),
            payload: this.decodePayload(row)
        });
    }

    prune(options = {}) {
        const db = this._db();
        const retain = Math.max(
            1,
            Math.floor(
                Number(options.retainReadyArtifacts)
                || this.retainedReadyArtifacts
            )
        );
        const readyRows = db.prepare(`
            SELECT artifact_sig
            FROM rivermemo_artifacts
            WHERE status = 'ready'
            ORDER BY published_at DESC, updated_at DESC
        `).all();
        const retained = new Set(
            readyRows.slice(0, retain).map(row => row.artifact_sig)
        );
        const now = Date.now();
        const failedBefore = now - Math.max(
            60 * 60 * 1000,
            Number(options.failedRetentionMs) || 7 * 24 * 60 * 60 * 1000
        );
        const cleanup = db.transaction(() => {
            let retired = 0;
            for (const row of readyRows.slice(retain)) {
                if (retained.has(row.artifact_sig)) continue;
                retired += db.prepare(`
                    UPDATE rivermemo_artifacts
                    SET status = 'retired',
                        payload = NULL,
                        payload_checksum = NULL,
                        updated_at = ?
                    WHERE artifact_sig = ?
                      AND status = 'ready'
                `).run(now, row.artifact_sig).changes;
            }
            const failed = db.prepare(`
                DELETE FROM rivermemo_artifacts
                WHERE status IN ('failed', 'retired')
                  AND updated_at < ?
            `).run(failedBefore).changes;
            return { retired, deleted: failed };
        });
        return cleanup();
    }
}

RiverMemoArtifactRepository.PAYLOAD_CODEC = PAYLOAD_CODEC;
RiverMemoArtifactRepository.PAYLOAD_SCHEMA = PAYLOAD_SCHEMA;

module.exports = RiverMemoArtifactRepository;