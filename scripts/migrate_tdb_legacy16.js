'use strict';

// Offline, narrow-format migration. Never opens or modifies source databases.
// Legacy size-only markers cannot prove historical integrity: structural and
// round-trip validation here is not a replacement for an original trusted hash.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { TextDecoder } = require('node:util');
const { TriviumDB } = require('triviumdb');
const utf8 = new TextDecoder('utf-8', { fatal: true });
const hash = b => crypto.createHash('sha256').update(b).digest('hex');

function parseLegacy(file) {
    const data = fs.readFileSync(file);
    const vec = fs.readFileSync(`${file}.vec`);
    const marker = fs.readFileSync(`${file}.flush_ok`);
    const wal = fs.readFileSync(`${file}.wal`);
    assert.equal(marker.length, 16, 'Only legacy 16-byte markers are supported');
    assert.equal(wal.length, 0, 'Nonempty WAL requires a separate recovery procedure');
    assert.equal(marker.readBigUInt64LE(0), BigInt(data.length), 'Legacy main size mismatch');
    assert.equal(marker.readBigUInt64LE(8), BigInt(vec.length), 'Legacy vector size mismatch');
    assert(data.length >= 58 && data.subarray(0, 4).toString() === 'TVDB', 'Invalid header');
    assert.equal(data.readUInt16LE(4), 5, 'Only main format v5 is supported');
    const num = value => {
        assert(value <= BigInt(Number.MAX_SAFE_INTEGER), 'Unsafe integer');
        return Number(value);
    };
    const dim = data.readUInt32LE(6);
    const nextId = num(data.readBigUInt64LE(10));
    const slots = num(data.readBigUInt64LE(18));
    const payloadOffset = num(data.readBigUInt64LE(26));
    const vectorOffset = num(data.readBigUInt64LE(34));
    const edgeOffset = num(data.readBigUInt64LE(42));
    const bqOffset = num(data.readBigUInt64LE(50));
    assert(dim > 0 && dim <= 3072);
    assert.equal(payloadOffset, 58);
    assert.equal(vectorOffset, 0, 'Only separated f32 vectors are supported');
    assert(payloadOffset <= edgeOffset && edgeOffset <= bqOffset && bqOffset + 8 <= data.length);
    assert.equal(BigInt(vec.length), BigInt(slots) * BigInt(dim) * 4n, 'Vector geometry mismatch');
    const bqCount = num(data.readBigUInt64LE(bqOffset));
    const bqBytes = data.length - bqOffset - 8;
    assert((bqCount === 0 && bqBytes === 0)
        || (bqCount === slots && [256, 384].includes(bqBytes / bqCount)), 'Unknown v5 BQ layout');

    const nodes = [];
    const ids = new Set();
    let cursor = payloadOffset;
    for (let slot = 0; slot < slots; slot++) {
        assert(cursor + 12 <= edgeOffset, 'Truncated payload header');
        const id = num(data.readBigUInt64LE(cursor));
        const length = data.readUInt32LE(cursor + 8);
        cursor += 12;
        assert(cursor + length <= edgeOffset, 'Truncated payload');
        if (id === 0) {
            assert.equal(length, 0, 'Invalid tombstone');
        } else {
            assert(!ids.has(id) && id < nextId, 'Duplicate or invalid node ID');
            ids.add(id);
            const payload = length ? JSON.parse(utf8.decode(data.subarray(cursor, cursor + length))) : null;
            const vector = [];
            let norm = 0;
            for (let j = 0; j < dim; j++) {
                const value = vec.readFloatLE((slot * dim + j) * 4);
                assert(Number.isFinite(value), `Nonfinite vector: node ${id}`);
                norm += value * value;
                vector.push(value);
            }
            assert(norm > 0, `Zero vector: node ${id}`);
            nodes.push({ id, payload, vector });
        }
        cursor += length;
    }
    assert.equal(cursor, edgeOffset, 'Payload tail mismatch');
    const edges = [];
    const keys = new Set();
    while (cursor < bqOffset) {
        assert(cursor + 18 <= bqOffset, 'Truncated edge');
        const source = num(data.readBigUInt64LE(cursor));
        const target = num(data.readBigUInt64LE(cursor + 8));
        const length = data.readUInt16LE(cursor + 16);
        cursor += 18;
        assert(cursor + length + 4 <= bqOffset, 'Truncated edge label/weight');
        const label = utf8.decode(data.subarray(cursor, cursor + length));
        cursor += length;
        const weight = data.readFloatLE(cursor);
        cursor += 4;
        assert(ids.has(source) && ids.has(target) && Number.isFinite(weight), 'Invalid edge');
        const key = JSON.stringify([source, target, label]);
        assert(!keys.has(key), 'Duplicate edge');
        keys.add(key);
        edges.push({ source, target, label, weight });
    }
    assert.equal(cursor, bqOffset);
    return {
        dim, slots, nodes, edges,
        sourceHashes: { main: hash(data), vector: hash(vec), marker: hash(marker), wal: hash(wal) }
    };
}

function verify(db, legacy) {
    assert.equal(db.nodeCount(), legacy.nodes.length);
    let edgeCount = 0;
    for (const node of legacy.nodes) {
        const actual = db.get(node.id);
        assert(actual, `Missing node ${node.id}`);
        assert.deepEqual(actual.payload, node.payload);
        assert.equal(actual.vector.length, legacy.dim);
        for (let j = 0; j < legacy.dim; j++) {
            assert.equal(actual.vector[j], node.vector[j], `Vector differs: ${node.id}/${j}`);
        }
        const actualEdges = db.getEdges(node.id);
        const expected = legacy.edges.filter(edge => edge.source === node.id);
        assert.equal(actualEdges.length, expected.length);
        edgeCount += actualEdges.length;
        for (const edge of expected) {
            const found = actualEdges.find(e => e.targetId === edge.target && e.label === edge.label);
            assert(found, 'Missing edge');
            assert(Math.abs(found.weight - edge.weight) <= 1e-6, 'Edge weight differs');
        }
    }
    assert.equal(edgeCount, legacy.edges.length);
    const query = legacy.nodes[0]?.vector;
    if (query) {
        const hits = db.searchHybrid(query, '', 5, 1, -1, 1, null);
        assert(hits.length > 0, 'Hybrid query returned no hits');
        assert(hits.every(hit => Number.isFinite(hit.score)), 'Nonfinite search score');
    }
}

function main() {
    const source = path.resolve(process.argv[2] || 'VectorStoreTDB');
    const output = path.resolve(process.argv[3] || 'VectorStoreTDB-migrated');
    assert(output !== source && !output.startsWith(source + path.sep), 'Output must be outside source');
    assert(!fs.existsSync(output), 'Output already exists; refusing overwrite');
    const names = fs.readdirSync(source).filter(name => name.endsWith('.tdb'));
    assert(names.length > 0, 'No databases found');
    // Validate every source before creating any output.
    const inputs = names.map(name => ({ name, legacy: parseLegacy(path.join(source, name)) }));
    const staging = process.env.VCP_TDB_MIGRATION_STAGING;
    assert(staging, 'Migration must run through the parent publisher');
    fs.mkdirSync(staging, { recursive: true });
    const report = {
        engineVersion: JSON.parse(fs.readFileSync(require.resolve('triviumdb/package.json'), 'utf8')).version,
        source, output, createdAt: new Date().toISOString(),
        warning: 'Legacy size-only markers have no historical CRC. Structural validation is not historical authenticity proof.',
        libraries: []
    };
    for (const { name, legacy } of inputs) {
        const destination = path.join(staging, name);
        const options = {
            dim: legacy.dim, dtype: 'f32', storageMode: 'mmap',
            syncMode: 'normal', autoBuildQuiver: false, loadTextIndex: true
        };
        let db;
        try {
            db = new TriviumDB(destination, options);
            for (let i = 0; i < legacy.nodes.length; i += 16) {
                const batch = legacy.nodes.slice(i, i + 16);
                db.batchInsertWithIds(batch.map(n => n.id), batch.map(n => n.vector), batch.map(n => n.payload));
            }
            for (const edge of legacy.edges) db.link(edge.source, edge.target, edge.label, edge.weight);
            for (const node of legacy.nodes) {
                const text = node.payload?.text_preview || node.payload?.title;
                if (text) db.indexText(node.id, text);
                const title = path.basename(node.payload?.source_path || '', path.extname(node.payload?.source_path || ''));
                if (title.length >= 2) db.indexKeyword(node.id, title);
            }
            db.buildTextIndex();
            db.flush();
            verify(db, legacy);
            db.close();
            db = null;
            db = new TriviumDB(destination, options);
            verify(db, legacy);
            db.close();
            db = null;
        } finally {
            if (db) db.close();
        }
        // Source must remain byte-identical throughout conversion.
        assert.deepEqual(parseLegacy(path.join(source, name)).sourceHashes, legacy.sourceHashes);
        const entry = {
            name, dimension: legacy.dim, sourceSlots: legacy.slots,
            nodes: legacy.nodes.length, edges: legacy.edges.length,
            sourceHashes: legacy.sourceHashes,
            verified: 'all node IDs, payloads, f32 values, edges, close/reopen and hybrid query',
            files: fs.readdirSync(staging).filter(n => n === name || n.startsWith(name + '.'))
                .map(n => ({ name: n, sha256: hash(fs.readFileSync(path.join(staging, n))) }))
        };
        report.libraries.push(entry);
        console.log(`PASS ${name}: ${entry.nodes} nodes, ${entry.edges} edges, ${legacy.dim}D`);
    }
    fs.writeFileSync(path.join(staging, 'migration-report.json'), JSON.stringify(report, null, 2));
    console.log('Validation complete; exiting worker to release native file handles.');
}
try {
    if (process.env.VCP_TDB_MIGRATION_STAGING) {
        main();
    } else {
        const { spawnSync } = require('node:child_process');
        const output = path.resolve(process.argv[3] || 'VectorStoreTDB-migrated');
        assert(!fs.existsSync(output), 'Output already exists; refusing overwrite');
        const staging = `${output}.staging-${Date.now()}`;
        const child = spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], {
            stdio: 'inherit',
            env: { ...process.env, VCP_TDB_MIGRATION_STAGING: staging }
        });
        if (child.error) throw child.error;
        assert.equal(child.status, 0, 'Migration worker failed; staging is not deployable');
        fs.renameSync(staging, output);
        console.log(`SUCCESS: ${output}`);
        console.log('Original databases untouched. Copy complete library file groups only while server is stopped.');
    }
} catch (error) {
    console.error('MIGRATION FAILED (source untouched; staging is not deployable):', error);
    process.exitCode = 1;
}