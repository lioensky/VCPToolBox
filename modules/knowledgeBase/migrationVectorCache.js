'use strict';

const { decodeVectorBlob } = require('./vectorCodec');

class MigrationVectorCache {
    constructor(options = {}) {
        this.getDb = options.getDb;
        this.dimension = options.dimension;
        this.ttlMs = options.ttlMs;
        this.logPrefix = options.logPrefix || 'KnowledgeBase';
    }

    _db() {
        const db = this.getDb?.();
        if (!db) throw new Error('MigrationVectorCache database is unavailable');
        return db;
    }

    decodeReusableRows(rows, expectedChunkCount, labelPrefix) {
        if (!rows || rows.length !== expectedChunkCount) return null;
        const vectors = [];
        for (let index = 0; index < rows.length; index++) {
            if (rows[index].chunk_index !== index || !rows[index].vector) return null;
            const decoded = decodeVectorBlob(
                rows[index].vector,
                this.dimension,
                `${labelPrefix}:${index}`
            );
            if (!decoded) return null;
            vectors.push(new Float32Array(decoded));
        }
        return vectors;
    }

    cleanupExpired(now = Date.now()) {
        try {
            const result = this._db()
                .prepare('DELETE FROM migration_deleted_files WHERE expires_at < ?')
                .run(now);
            if (result.changes > 0) {
                console.log(
                    `[${this.logPrefix}] 🧹 Cleaned ${result.changes} expired ` +
                    'migration cache file tombstone(s).'
                );
            }
            return result.changes;
        } catch (error) {
            console.warn(
                `[${this.logPrefix}] ⚠️ Failed to cleanup migration cache: ${error.message}`
            );
            return 0;
        }
    }

    findReusableVectors(doc) {
        try {
            if (
                !doc?.checksum
                || !Array.isArray(doc.chunks)
                || doc.chunks.length === 0
            ) return null;

            const db = this._db();
            const candidates = db.prepare(`
                SELECT id, path, diary_name
                FROM files
                WHERE checksum = ?
                  AND size = ?
                  AND path != ?
                ORDER BY updated_at DESC, id DESC
                LIMIT 5
            `).all(doc.checksum, doc.size, doc.relPath);
            const getChunks = db.prepare(`
                SELECT chunk_index, vector
                FROM chunks
                WHERE file_id = ?
                ORDER BY chunk_index ASC
            `);

            for (const candidate of candidates) {
                const vectors = this.decodeReusableRows(
                    getChunks.all(candidate.id),
                    doc.chunks.length,
                    `reuse:${candidate.path}`
                );
                if (vectors) {
                    console.log(
                        `[${this.logPrefix}] ♻️ Reusing ${vectors.length} cached chunk ` +
                        `vector(s) for moved/copied file "${doc.relPath}" from live ` +
                        `record "${candidate.path}".`
                    );
                    return vectors;
                }
            }

            const now = Date.now();
            this.cleanupExpired(now);
            const tombstones = db.prepare(`
                SELECT id, old_path, old_diary_name
                FROM migration_deleted_files
                WHERE checksum = ?
                  AND size = ?
                  AND old_path != ?
                  AND chunk_count = ?
                  AND expires_at >= ?
                ORDER BY deleted_at DESC, id DESC
                LIMIT 5
            `).all(
                doc.checksum,
                doc.size,
                doc.relPath,
                doc.chunks.length,
                now
            );
            const getCachedChunks = db.prepare(`
                SELECT chunk_index, vector
                FROM migration_deleted_chunks
                WHERE cache_file_id = ?
                ORDER BY chunk_index ASC
            `);

            for (const tombstone of tombstones) {
                const vectors = this.decodeReusableRows(
                    getCachedChunks.all(tombstone.id),
                    doc.chunks.length,
                    `migration:${tombstone.old_path}`
                );
                if (vectors) {
                    vectors._migrationCacheId = tombstone.id;
                    console.log(
                        `[${this.logPrefix}] ♻️ Reusing ${vectors.length} cached chunk ` +
                        `vector(s) for moved file "${doc.relPath}" from recently deleted ` +
                        `"${tombstone.old_path}".`
                    );
                    return vectors;
                }
            }
        } catch (error) {
            console.warn(
                `[${this.logPrefix}] ⚠️ Failed to lookup reusable vectors for ` +
                `"${doc?.relPath || 'unknown'}": ${error.message}`
            );
        }
        return null;
    }

    cacheDeletedFiles(fileRows, chunkRows, now = Date.now()) {
        const db = this._db();
        const expiresAt = now + this.ttlMs;
        const insertFile = db.prepare(`
            INSERT INTO migration_deleted_files
            (old_path, old_diary_name, checksum, size, chunk_count, deleted_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const insertChunk = db.prepare(`
            INSERT INTO migration_deleted_chunks (cache_file_id, chunk_index, vector)
            VALUES (?, ?, ?)
        `);

        for (const file of fileRows) {
            const chunks = chunkRows
                .filter(chunk => chunk.file_id === file.id && chunk.vector)
                .sort((left, right) => left.chunk_index - right.chunk_index);
            if (chunks.length === 0) continue;

            const result = insertFile.run(
                file.path,
                file.diary_name,
                file.checksum,
                file.size,
                chunks.length,
                now,
                expiresAt
            );
            for (const chunk of chunks) {
                insertChunk.run(
                    result.lastInsertRowid,
                    chunk.chunk_index,
                    chunk.vector
                );
            }
        }
    }
}

module.exports = MigrationVectorCache;