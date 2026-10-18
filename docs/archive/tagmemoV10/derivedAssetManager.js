'use strict';

const crypto = require('crypto');

const ASSET_VERSION = 'v10-exact-vector-assets-v1';

function vectorSignature(blob) {
    return crypto.createHash('sha256').update(blob).digest('hex');
}

function decodeVector(blob, dimension) {
    if (!blob || blob.length !== dimension * Float32Array.BYTES_PER_ELEMENT) {
        return null;
    }
    const aligned = blob.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0
        ? blob
        : Buffer.from(blob);
    return new Float32Array(aligned.buffer, aligned.byteOffset, dimension);
}

function vectorNorm(vector) {
    let sum = 0;
    for (let index = 0; index < vector.length; index++) {
        const value = Number(vector[index]) || 0;
        sum += value * value;
    }
    return Math.sqrt(sum);
}

function cosineWithNorms(left, right, leftNorm, rightNorm) {
    if (
        !left
        || !right
        || left.length !== right.length
        || leftNorm <= 1e-12
        || rightNorm <= 1e-12
    ) {
        return 0;
    }
    let dot = 0;
    for (let index = 0; index < left.length; index++) {
        dot += (Number(left[index]) || 0) * (Number(right[index]) || 0);
    }
    return dot / (leftNorm * rightNorm);
}

class V10DerivedAssetManager {
    constructor(options = {}) {
        this.getDb = typeof options.getDb === 'function'
            ? options.getDb
            : () => options.db || null;
        this.modelSig = String(options.modelSig || 'unknown-model');
        this.dimension = Math.max(1, Math.floor(Number(options.dimension) || 0));
        this._metrics = new Map();
        this._geometry = new Map();
        this.lastDiagnostics = null;
    }

    rebindDatabase(db) {
        this.getDb = () => db;
        this._metrics.clear();
        this._geometry.clear();
    }

    _db() {
        const db = this.getDb();
        if (!db?.prepare || !db?.transaction) {
            throw new Error('V10 derived asset database is unavailable');
        }
        return db;
    }

    _metricKey(type, id) {
        return `${type}:${Number(id)}`;
    }

    _geometryKey(chunkId, tagId) {
        return `${Number(chunkId)}:${Number(tagId)}`;
    }

    _sourceFacts() {
        const db = this._db();
        const tag = db.prepare(`
            SELECT COUNT(*) AS count,
                   COALESCE(MAX(id), 0) AS max_id,
                   COALESCE(SUM(id), 0) AS id_mass,
                   COALESCE(SUM(LENGTH(vector)), 0) AS byte_mass
            FROM tags
            WHERE vector IS NOT NULL
        `).get();
        const chunk = db.prepare(`
            SELECT COUNT(*) AS count,
                   COALESCE(MAX(id), 0) AS max_id,
                   COALESCE(SUM(id), 0) AS id_mass,
                   COALESCE(SUM(LENGTH(vector)), 0) AS byte_mass
            FROM chunks
            WHERE vector IS NOT NULL
        `).get();
        const relation = db.prepare(`
            SELECT COUNT(*) AS count,
                   COALESCE(SUM(c.id), 0) AS chunk_mass,
                   COALESCE(SUM(ft.tag_id), 0) AS tag_mass
            FROM chunks c
            JOIN file_tags ft ON ft.file_id = c.file_id
            JOIN tags t ON t.id = ft.tag_id
            WHERE c.vector IS NOT NULL AND t.vector IS NOT NULL
        `).get();
        const payload = JSON.stringify({
            version: ASSET_VERSION,
            modelSig: this.modelSig,
            dimension: this.dimension,
            tag,
            chunk,
            relation
        });
        return {
            tag,
            chunk,
            relation,
            generation: crypto.createHash('sha256').update(payload).digest('hex')
        };
    }

    _status(assetType) {
        return this._db().prepare(`
            SELECT source_generation, row_count, status
            FROM v10_derived_asset_status
            WHERE asset_type = ? AND model_sig = ? AND dimension = ?
        `).get(assetType, this.modelSig, this.dimension);
    }

    _writeStatus(assetType, generation, rowCount, status = 'ready', errorMessage = null) {
        this._db().prepare(`
            INSERT INTO v10_derived_asset_status (
                asset_type, model_sig, dimension, source_generation,
                row_count, status, error_message, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(asset_type, model_sig, dimension) DO UPDATE SET
                source_generation = excluded.source_generation,
                row_count = excluded.row_count,
                status = excluded.status,
                error_message = excluded.error_message,
                updated_at = excluded.updated_at
        `).run(
            assetType,
            this.modelSig,
            this.dimension,
            generation,
            rowCount,
            status,
            errorMessage,
            Date.now()
        );
    }

    invalidate(reason = 'source-mutated') {
        const db = this._db();
        db.prepare(`
            UPDATE v10_derived_asset_status
            SET status = 'stale', error_message = ?, updated_at = ?
            WHERE model_sig = ? AND dimension = ?
        `).run(String(reason).slice(0, 1000), Date.now(), this.modelSig, this.dimension);
        this._metrics.clear();
        this._geometry.clear();
    }

    _hydrateMemoryCaches() {
        const db = this._db();
        this._metrics.clear();
        for (const row of db.prepare(`
            SELECT entity_type, entity_id, vector_sig, l2_norm
            FROM v10_vector_metrics
            WHERE model_sig = ? AND dimension = ?
        `).iterate(this.modelSig, this.dimension)) {
            this._metrics.set(this._metricKey(row.entity_type, row.entity_id), Object.freeze({
                vectorSig: row.vector_sig,
                norm: Number(row.l2_norm) || 0
            }));
        }

        this._geometry.clear();
        for (const row of db.prepare(`
            SELECT chunk_id, tag_id, chunk_vector_sig, tag_vector_sig, cosine
            FROM v10_chunk_tag_geometry
            WHERE model_sig = ? AND dimension = ?
        `).iterate(this.modelSig, this.dimension)) {
            this._geometry.set(this._geometryKey(row.chunk_id, row.tag_id), Object.freeze({
                chunkVectorSig: row.chunk_vector_sig,
                tagVectorSig: row.tag_vector_sig,
                cosine: Number(row.cosine) || 0
            }));
        }
    }

    isReady() {
        const metricsStatus = this._status('vector_metrics');
        const geometryStatus = this._status('chunk_tag_geometry');
        return metricsStatus?.status === 'ready'
            && geometryStatus?.status === 'ready';
    }

    getMetric(type, id) {
        return this._metrics.get(this._metricKey(type, id)) || null;
    }

    getNorm(type, id) {
        return this.getMetric(type, id)?.norm || 0;
    }

    getChunkTagCosine(chunkId, tagId) {
        const value = this._geometry.get(this._geometryKey(chunkId, tagId));
        return value ? value.cosine : null;
    }

    ensureExactAssets(options = {}) {
        const startedAt = Date.now();
        const db = this._db();
        const facts = this._sourceFacts();
        const metricsStatus = this._status('vector_metrics');
        const geometryStatus = this._status('chunk_tag_geometry');
        const metricsExpected = Number(facts.tag.count) + Number(facts.chunk.count);
        const geometryExpected = Number(facts.relation.count);
        const quickReady = options.force !== true
            && metricsStatus?.status === 'ready'
            && geometryStatus?.status === 'ready'
            && metricsStatus.source_generation === facts.generation
            && geometryStatus.source_generation === facts.generation
            && Number(metricsStatus.row_count) === metricsExpected
            && Number(geometryStatus.row_count) === geometryExpected;

        if (quickReady) {
            this._hydrateMemoryCaches();
            this.lastDiagnostics = Object.freeze({
                version: ASSET_VERSION,
                mode: 'warm',
                generation: facts.generation,
                metrics: this._metrics.size,
                geometry: this._geometry.size,
                elapsedMs: Date.now() - startedAt
            });
            console.log(
                `[TagMemo-V10] ✅ Exact derived assets warm: ` +
                `metrics=${this._metrics.size}, geometry=${this._geometry.size}, ` +
                `elapsed=${this.lastDiagnostics.elapsedMs}ms`
            );
            return this.lastDiagnostics;
        }

        console.log(
            `[TagMemo-V10] 🧮 Exact derived asset audit started: ` +
            `expectedMetrics=${metricsExpected}, expectedGeometry=${geometryExpected}`
        );

        try {
            const existingMetrics = new Map();
            for (const row of db.prepare(`
                SELECT entity_type, entity_id, vector_sig, l2_norm
                FROM v10_vector_metrics
                WHERE model_sig = ? AND dimension = ?
            `).iterate(this.modelSig, this.dimension)) {
                existingMetrics.set(this._metricKey(row.entity_type, row.entity_id), row);
            }

            const upsertMetric = db.prepare(`
                INSERT INTO v10_vector_metrics (
                    entity_type, entity_id, model_sig, dimension,
                    vector_sig, l2_norm, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(entity_type, entity_id, model_sig, dimension) DO UPDATE SET
                    vector_sig = excluded.vector_sig,
                    l2_norm = excluded.l2_norm,
                    updated_at = excluded.updated_at
            `);
            const currentMetricKeys = new Set();
            let computedMetrics = 0;
            const metricWrite = db.transaction(rows => {
                for (const row of rows) upsertMetric.run(...row);
            });
            const metricRows = [];

            const scanVectors = (type, table) => {
                for (const row of db.prepare(
                    `SELECT id, vector FROM ${table} WHERE vector IS NOT NULL`
                ).iterate()) {
                    const id = Number(row.id);
                    const vector = decodeVector(row.vector, this.dimension);
                    if (!vector) continue;
                    const key = this._metricKey(type, id);
                    const sig = vectorSignature(row.vector);
                    currentMetricKeys.add(key);
                    const previous = existingMetrics.get(key);
                    if (previous?.vector_sig === sig) continue;
                    metricRows.push([
                        type,
                        id,
                        this.modelSig,
                        this.dimension,
                        sig,
                        vectorNorm(vector),
                        Date.now()
                    ]);
                    computedMetrics++;
                    if (metricRows.length >= 500) {
                        metricWrite(metricRows.splice(0));
                    }
                }
            };
            scanVectors('tag', 'tags');
            scanVectors('chunk', 'chunks');
            if (metricRows.length > 0) metricWrite(metricRows);

            const staleMetrics = [];
            for (const [key, row] of existingMetrics.entries()) {
                if (!currentMetricKeys.has(key)) {
                    staleMetrics.push([row.entity_type, Number(row.entity_id)]);
                }
            }
            const deleteMetric = db.prepare(`
                DELETE FROM v10_vector_metrics
                WHERE entity_type = ? AND entity_id = ?
                  AND model_sig = ? AND dimension = ?
            `);
            db.transaction(rows => {
                for (const [type, id] of rows) {
                    deleteMetric.run(type, id, this.modelSig, this.dimension);
                }
            })(staleMetrics);

            const metricLookup = new Map();
            for (const row of db.prepare(`
                SELECT entity_type, entity_id, vector_sig, l2_norm
                FROM v10_vector_metrics
                WHERE model_sig = ? AND dimension = ?
            `).iterate(this.modelSig, this.dimension)) {
                metricLookup.set(this._metricKey(row.entity_type, row.entity_id), row);
            }

            const existingGeometry = new Map();
            for (const row of db.prepare(`
                SELECT chunk_id, tag_id, chunk_vector_sig, tag_vector_sig
                FROM v10_chunk_tag_geometry
                WHERE model_sig = ? AND dimension = ?
            `).iterate(this.modelSig, this.dimension)) {
                existingGeometry.set(this._geometryKey(row.chunk_id, row.tag_id), row);
            }

            const upsertGeometry = db.prepare(`
                INSERT INTO v10_chunk_tag_geometry (
                    chunk_id, tag_id, model_sig, dimension,
                    chunk_vector_sig, tag_vector_sig, cosine, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(chunk_id, tag_id, model_sig, dimension) DO UPDATE SET
                    chunk_vector_sig = excluded.chunk_vector_sig,
                    tag_vector_sig = excluded.tag_vector_sig,
                    cosine = excluded.cosine,
                    updated_at = excluded.updated_at
            `);
            const geometryWrite = db.transaction(rows => {
                for (const row of rows) upsertGeometry.run(...row);
            });
            const geometryRows = [];
            const currentGeometryKeys = new Set();
            let computedGeometry = 0;

            for (const row of db.prepare(`
                SELECT c.id AS chunk_id, c.vector AS chunk_vector,
                       t.id AS tag_id, t.vector AS tag_vector
                FROM chunks c
                JOIN file_tags ft ON ft.file_id = c.file_id
                JOIN tags t ON t.id = ft.tag_id
                WHERE c.vector IS NOT NULL AND t.vector IS NOT NULL
                ORDER BY c.id, t.id
            `).iterate()) {
                const chunkId = Number(row.chunk_id);
                const tagId = Number(row.tag_id);
                const key = this._geometryKey(chunkId, tagId);
                currentGeometryKeys.add(key);
                const chunkMetric = metricLookup.get(this._metricKey('chunk', chunkId));
                const tagMetric = metricLookup.get(this._metricKey('tag', tagId));
                if (!chunkMetric || !tagMetric) continue;
                const previous = existingGeometry.get(key);
                if (
                    previous?.chunk_vector_sig === chunkMetric.vector_sig
                    && previous?.tag_vector_sig === tagMetric.vector_sig
                ) {
                    continue;
                }
                const chunkVector = decodeVector(row.chunk_vector, this.dimension);
                const tagVector = decodeVector(row.tag_vector, this.dimension);
                if (!chunkVector || !tagVector) continue;
                geometryRows.push([
                    chunkId,
                    tagId,
                    this.modelSig,
                    this.dimension,
                    chunkMetric.vector_sig,
                    tagMetric.vector_sig,
                    cosineWithNorms(
                        chunkVector,
                        tagVector,
                        Number(chunkMetric.l2_norm) || 0,
                        Number(tagMetric.l2_norm) || 0
                    ),
                    Date.now()
                ]);
                computedGeometry++;
                if (geometryRows.length >= 250) {
                    geometryWrite(geometryRows.splice(0));
                }
            }
            if (geometryRows.length > 0) geometryWrite(geometryRows);

            const staleGeometry = [];
            for (const [key, row] of existingGeometry.entries()) {
                if (!currentGeometryKeys.has(key)) {
                    staleGeometry.push([Number(row.chunk_id), Number(row.tag_id)]);
                }
            }
            const deleteGeometry = db.prepare(`
                DELETE FROM v10_chunk_tag_geometry
                WHERE chunk_id = ? AND tag_id = ?
                  AND model_sig = ? AND dimension = ?
            `);
            db.transaction(rows => {
                for (const [chunkId, tagId] of rows) {
                    deleteGeometry.run(
                        chunkId,
                        tagId,
                        this.modelSig,
                        this.dimension
                    );
                }
            })(staleGeometry);

            const metricCount = db.prepare(`
                SELECT COUNT(*) AS count
                FROM v10_vector_metrics
                WHERE model_sig = ? AND dimension = ?
            `).get(this.modelSig, this.dimension)?.count || 0;
            const geometryCount = db.prepare(`
                SELECT COUNT(*) AS count
                FROM v10_chunk_tag_geometry
                WHERE model_sig = ? AND dimension = ?
            `).get(this.modelSig, this.dimension)?.count || 0;

            this._writeStatus(
                'vector_metrics',
                facts.generation,
                metricCount
            );
            this._writeStatus(
                'chunk_tag_geometry',
                facts.generation,
                geometryCount
            );
            this._hydrateMemoryCaches();
            this.lastDiagnostics = Object.freeze({
                version: ASSET_VERSION,
                mode: 'reconciled',
                generation: facts.generation,
                metrics: metricCount,
                geometry: geometryCount,
                computedMetrics,
                computedGeometry,
                removedMetrics: staleMetrics.length,
                removedGeometry: staleGeometry.length,
                elapsedMs: Date.now() - startedAt
            });
            console.log(
                `[TagMemo-V10] ✅ Exact derived asset audit complete: ` +
                `metrics=${metricCount} (+${computedMetrics}/-${staleMetrics.length}), ` +
                `geometry=${geometryCount} (+${computedGeometry}/-${staleGeometry.length}), ` +
                `elapsed=${this.lastDiagnostics.elapsedMs}ms`
            );
            return this.lastDiagnostics;
        } catch (error) {
            const message = String(error?.message || error).slice(0, 4000);
            this._writeStatus(
                'vector_metrics',
                facts.generation,
                0,
                'failed',
                message
            );
            this._writeStatus(
                'chunk_tag_geometry',
                facts.generation,
                0,
                'failed',
                message
            );
            throw error;
        }
    }
}

V10DerivedAssetManager.ASSET_VERSION = ASSET_VERSION;
V10DerivedAssetManager.decodeVector = decodeVector;
V10DerivedAssetManager.vectorNorm = vectorNorm;
V10DerivedAssetManager.cosineWithNorms = cosineWithNorms;

module.exports = V10DerivedAssetManager;