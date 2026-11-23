'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readPlate, rawRows, DIM } = require('./freeze-core.cjs');
const { openLibrary } = require('../../Plugin/WarpedFieldAtlas/lib/library.js');
const { LAYOUT_VERSION } = require('../../Plugin/WarpedFieldAtlas/lib/layout.js');

async function fileHash(file) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

function newPrivateDirectory(request) {
    const absolute = path.resolve(request);
    const parent = fs.realpathSync(path.dirname(absolute));
    for (let p = parent; ; p = path.dirname(p)) {
        if (fs.existsSync(path.join(p, '.git'))) throw new Error('output inside Git worktree');
        if (p === path.dirname(p)) break;
    }
    const out = path.join(parent, path.basename(absolute));
    fs.mkdirSync(out, { mode: 0o700 });
    return out;
}

function writeArray(out, name, dtype, shape, parts) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(path.join(out, name), 'wx', 0o600);
    let bytes = 0;
    try {
        for (const part of parts) {
            const buffer = Buffer.from(part.buffer, part.byteOffset, part.byteLength);
            fs.writeFileSync(fd, buffer);
            hash.update(buffer);
            bytes += buffer.length;
        }
    } finally {
        fs.closeSync(fd);
    }
    const width = { u64le: 8, u32le: 4, f32le: 4 }[dtype];
    if (shape.reduce((a, b) => a * b, width) !== bytes) throw new Error(`wrong byte count: ${name}`);
    return { file: name, dtype, shape, bytes, sha256: hash.digest('hex') };
}

async function freezePlate(snapshot, backupDirectory, output) {
    if (path.extname(snapshot).toLowerCase() !== '.vcpwc') throw new Error('explicit .vcpwc required');
    const backup = fs.realpathSync(backupDirectory);
    const db = path.join(backup, 'knowledge_base.sqlite');
    const receipt = JSON.parse(fs.readFileSync(path.join(backup, 'backup.json'), 'utf8'));
    async function checkBackup() {
        if (receipt.format !== 'lain-sqlite-backup-v1' || receipt.file !== path.basename(db) ||
            ['-wal', '-journal', '-shm'].some(s => fs.existsSync(db + s)) ||
            fs.statSync(db).size !== receipt.bytes || await fileHash(db) !== receipt.sha256) {
            throw new Error('expected an unchanged standalone knowledge_base.sqlite backup');
        }
    }
    await checkBackup();
    const plate = readPlate(fs.readFileSync(snapshot));
    const n = plate.ids.length;
    const out = newPrivateDirectory(output);
    try {
        const arrays = {};
        function add(key, dtype, data) {
            arrays[key] = writeArray(out, `${key}.${dtype}`, dtype, [data.length], [data]);
        }
        add('ids', 'u64le', BigUint64Array.from(plate.ids, BigInt));
        for (const key of ['angle', 'radius']) add(key, 'f32le', plate[key]);
        for (const key of ['offsets', 'graph', 'entries', 'directionLandmarks', 'shellLandmarks']) {
            add(key, 'u32le', plate[key]);
        }
        const lib = openLibrary(backup);
        try {
            function* payload() {
                for (const { values } of rawRows(plate.ids, lib.vectorReader('chunks'))) yield values;
            }
            arrays.vectors = writeArray(out, 'vectors.f32le', 'f32le', [n, DIM], payload());
        } finally {
            lib.close();
        }
        await checkBackup();
        const manifest = {
            format: 'lain-plate-v1', layoutVersion: LAYOUT_VERSION, rows: n, dimensions: DIM,
            snapshotSha256: plate.snapshotSha256, databaseSha256: receipt.sha256,
            snapshotIdentity: { model: plate.model, rule: plate.rule, facts: plate.facts },
            rowOrder: 'snapshot slot -> ids[slot] -> chunks.id', arrays,
        };
        fs.writeFileSync(path.join(out, 'plate.json.tmp'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        fs.renameSync(path.join(out, 'plate.json.tmp'), path.join(out, 'plate.json'));
        return manifest;
    } catch (error) {
        fs.rmSync(out, { recursive: true, force: true });
        throw error;
    }
}

if (require.main === module) {
    if (process.argv.length !== 5) {
        console.error('usage: node freeze-plate.cjs FIELD.vcpwc KB_BACKUP_DIR NEW_OUTPUT_DIR');
        process.exitCode = 2;
    } else {
        freezePlate(...process.argv.slice(2)).then(m => {
            console.log(JSON.stringify({ rows: m.rows, dimensions: m.dimensions, snapshotSha256: m.snapshotSha256 }));
        }).catch(error => { console.error(error.message); process.exitCode = 1; });
    }
}

module.exports = { freezePlate };