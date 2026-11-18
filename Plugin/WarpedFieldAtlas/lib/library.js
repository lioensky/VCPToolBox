'use strict';

// 只读打开一个知识库目录（含 knowledge_base.sqlite 和双曲场快照）。这里不写任何东西。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const DATABASE = 'knowledge_base.sqlite';

/** node:sqlite（Node 22.5 起自带）优先；没有时退到后端已有的 better-sqlite3。两者都以只读方式打开。 */
function openReadOnly(file) {
    try {
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(file, { readOnly: true });
        return {
            all: (sql, ...args) => db.prepare(sql).all(...args),
            get: (sql, ...args) => db.prepare(sql).get(...args),
            prepare: sql => { const s = db.prepare(sql); return { get: (...a) => s.get(...a), all: (...a) => s.all(...a) }; },
            close: () => db.close(),
        };
    } catch (error) {
        if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE' && error.code !== 'MODULE_NOT_FOUND') throw error;
        const Database = require('better-sqlite3');
        const db = new Database(file, { readonly: true, fileMustExist: true });
        return {
            all: (sql, ...args) => db.prepare(sql).all(...args),
            get: (sql, ...args) => db.prepare(sql).get(...args),
            prepare: sql => db.prepare(sql),
            close: () => db.close(),
        };
    }
}

const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
const hasTable = (db, name) => !!db.get("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?", name);

function openLibrary(directory) {
    const databaseFile = path.join(directory, DATABASE);
    if (!fs.existsSync(databaseFile)) throw new Error(`这个目录里没有 ${DATABASE}。`);
    const db = openReadOnly(databaseFile);
    const files = fs.readdirSync(directory);

    /** 当前生效的 River 资产：Tag 场快照的文件名里是它签名的 SHA-256。 */
    function readyArtifacts() {
        if (!hasTable(db, 'rivermemo_artifacts')) return [];
        return db.all("SELECT artifact_sig AS sig, model_sig AS model, node_count AS nodes, edge_count AS edges, updated_at AS updated " +
            "FROM rivermemo_artifacts WHERE status='ready' ORDER BY updated_at DESC, artifact_sig");
    }

    /** 目录里可能同时有新旧两代 .vcpwf：按当前生效的资产签名选，都对不上才退到最新的一份并标明。 */
    function tagSnapshot() {
        const candidates = files.filter(name => name.startsWith(`${DATABASE}.warped-`) && name.endsWith('.vcpwf'));
        if (!candidates.length) return null;
        for (const artifact of readyArtifacts()) {
            const match = candidates.find(name => name.startsWith(`${DATABASE}.warped-${sha256(artifact.sig)}-`));
            if (match) return { file: path.join(directory, match), artifact, current: true };
        }
        const newest = candidates.map(name => ({ name, time: fs.statSync(path.join(directory, name)).mtimeMs }))
            .sort((a, b) => b.time - a.time)[0];
        return { file: path.join(directory, newest.name), artifact: null, current: false };
    }

    function chunkSnapshot() {
        const candidates = files.filter(name => name.startsWith(`${DATABASE}.chunks-warped-`) && name.endsWith('.vcpwc'))
            .map(name => ({ name, time: fs.statSync(path.join(directory, name)).mtimeMs }))
            .sort((a, b) => b.time - a.time);
        return candidates.length ? { file: path.join(directory, candidates[0].name) } : null;
    }

    function tags() {
        return db.all('SELECT id, name FROM tags ORDER BY id');
    }

    /** 残差比按 Tag 编号；另给出没算出残差的原因（没进场的 Tag 用）。 */
    function residuals(geometry) {
        const ratio = new Map();
        if (hasTable(db, 'tag_intrinsic_residuals')) {
            const rows = geometry
                ? db.all("SELECT tag_id AS id, raw_residual_ratio AS ratio FROM tag_intrinsic_residuals WHERE status='computed' AND artifact_sig=?", geometry)
                : db.all("SELECT tag_id AS id, raw_residual_ratio AS ratio FROM tag_intrinsic_residuals WHERE status='computed'");
            for (const row of rows) ratio.set(row.id, row.ratio);
        }
        const reason = new Map();
        if (hasTable(db, 'tag_intrinsic_residual_status')) {
            for (const row of db.all('SELECT tag_id AS id, status FROM tag_intrinsic_residual_status')) reason.set(row.id, row.status);
        }
        return { ratio, reason };
    }

    /** River 网络（Tag 共现网络）：gzip 压缩的 JSON，CSR 存边。 */
    function riverNetwork(signature) {
        if (!signature) return null;
        const row = db.get("SELECT payload_codec AS codec, payload FROM rivermemo_artifacts WHERE artifact_sig=? AND status='ready'", signature);
        if (!row || row.codec !== 'gzip-json-v1' || !row.payload) return null;
        const payload = JSON.parse(zlib.gunzipSync(Buffer.from(row.payload)).toString('utf8'));
        const transport = payload.sharedTransport;
        if (!transport || !Array.isArray(transport.nodeIds) || !Array.isArray(transport.rowOffsets)) return null;
        const wormholes = new Set(Array.isArray(payload.wormholeView) ? payload.wormholeView : []);
        return {
            ids: transport.nodeIds,
            offsets: transport.rowOffsets,
            targets: transport.targetIndices,
            weights: transport.weights,
            inbound: new Map(payload.inboundMassView || []),
            isWormhole: (from, to) => wormholes.has(`${from}:${to}`),
        };
    }

    function vectorReader(table) {
        const statement = db.prepare(`SELECT vector FROM ${table === 'chunks' ? 'chunks' : 'tags'} WHERE id=?`);
        return id => {
            const row = statement.get(id);
            const blob = row && row.vector;
            if (!blob || blob.byteLength % 4) return null;
            return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
        };
    }

    function chunks() {
        return db.all('SELECT c.id, c.file_id AS file, c.chunk_index AS position, f.diary_name AS diary, f.path ' +
            'FROM chunks c JOIN files f ON f.id = c.file_id ORDER BY c.id');
    }

    const excerptOf = text => String(text || '').replace(/\s+/g, ' ').trim();

    /** 带这个 Tag 的日记片段。 */
    function chunksOfTag(tagId, limit = 40) {
        const total = db.get('SELECT COUNT(*) AS n FROM chunks c JOIN file_tags t ON t.file_id = c.file_id WHERE t.tag_id=?', tagId).n;
        const rows = db.all('SELECT c.id, f.diary_name AS diary, f.path, c.chunk_index AS position, substr(c.content, 1, 240) AS text ' +
            'FROM file_tags t JOIN chunks c ON c.file_id = t.file_id JOIN files f ON f.id = c.file_id ' +
            'WHERE t.tag_id=? ORDER BY f.mtime DESC, c.id LIMIT ?', tagId, limit);
        return { total, rows: rows.map(row => ({ ...row, text: excerptOf(row.text) })) };
    }

    function chunkDetail(chunkId) {
        const row = db.get('SELECT c.id, c.file_id AS file, c.chunk_index AS position, f.diary_name AS diary, f.path, substr(c.content, 1, 1200) AS text ' +
            'FROM chunks c JOIN files f ON f.id = c.file_id WHERE c.id=?', chunkId);
        if (!row) return null;
        const tagRows = db.all('SELECT t.id, t.name FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id=? ORDER BY ft.position', row.file);
        return { ...row, text: excerptOf(row.text), tags: tagRows };
    }

    return {
        directory, readyArtifacts, tagSnapshot, chunkSnapshot, tags, residuals, riverNetwork, vectorReader,
        chunks, chunksOfTag, chunkDetail, close: () => db.close(),
    };
}

module.exports = { openLibrary, openReadOnly };
