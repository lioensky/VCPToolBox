'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { endianness } = require('node:os');
const { trueTiles, shuffledTiles } = require('./tiles.cjs');
const sha = x => createHash('sha256').update(x).digest('hex');

function build(dir, expected) {
    if (endianness() !== 'LE') throw new Error('little-endian host required');
    const raw = fs.readFileSync(path.join(dir, 'plate.json'));
    if (sha(raw) !== expected) throw new Error('plate manifest digest mismatch');
    const m = JSON.parse(raw);
    if (m.format !== 'lain-plate-v2' || !Number.isSafeInteger(m.rows) || m.rows < 1)
        throw new Error('unsupported plate');
    function load(key, dtype, Type) {
        const desc = m.arrays[key], name = `${key}.${dtype}`;
        if (desc.file !== name || desc.dtype !== dtype || desc.shape.length !== 1 || desc.shape[0] !== m.rows)
            throw new Error(`invalid descriptor: ${key}`);
        const buf = fs.readFileSync(path.join(dir, name));
        if (buf.length !== m.rows * Type.BYTES_PER_ELEMENT || sha(buf) !== desc.sha256)
            throw new Error(`invalid bytes: ${key}`);
        return new Type(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    }
    const ids = load('ids', 'u64le', BigUint64Array);
    const a = load('angle', 'f32le', Float32Array), r = load('radius', 'f32le', Float32Array);
    const base = trueTiles(ids, a, r);
    const capacities = base.map(t => t.length);
    function describe(tiles, seed) {
        const seen = new Uint8Array(m.rows);
        const hash = createHash('sha256');
        const spans = [];
        let total = 0;
        for (const [i, tile] of tiles.entries()) {
            if (!tile.length || tile.length !== capacities[i]) throw new Error('capacity mismatch');
            const bytes = Buffer.alloc(tile.length * 8);
            let lo = Infinity, hi = -Infinity;
            for (const [j, slot] of tile.entries()) {
                if (!Number.isInteger(slot) || slot < 0 || slot >= m.rows || seen[slot])
                    throw new Error('invalid slot or duplicate membership');
                seen[slot] = 1; total++;
                bytes.writeBigUInt64LE(ids[slot], j * 8);
                lo = Math.min(lo, a[slot]); hi = Math.max(hi, a[slot]);
            }
            hash.update(bytes); spans.push(hi - lo);
        }
        if (total !== m.rows || tiles.length !== capacities.length) throw new Error('incomplete partition');
        return { seed, orderedIdsSha256: hash.digest('hex'), angleSpansRadians: spans };
    }
    return { format: 'lain-tiles-v1', plateSha256: expected, rows: m.rows, capacities,
        membershipEncoding: 'stable ids as concatenated u64le, tile boundaries given by capacities',
        shuffle: 'Mulberry32 uint32; rejection-sampled Fisher-Yates over snapshot slots',
        plates: [describe(base, null), ...[1,2,3,4,5].map(s => describe(shuffledTiles(base,s),s))] };
}

if (require.main === module) {
    const [dir, expected, file] = process.argv.slice(2);
    const manifest = build(dir, expected);
    const out = path.join(fs.realpathSync(path.dirname(path.resolve(file))), path.basename(file));
    for (let p = path.dirname(out); ; p = path.dirname(p)) {
        if (fs.existsSync(path.join(p,'.git'))) throw new Error('output inside Git worktree');
        if (p === path.dirname(p)) break;
    }
    const bytes = Buffer.from(JSON.stringify(manifest) + '\n');
    fs.writeFileSync(out, bytes, { flag:'wx', mode:0o600 });
    console.log(JSON.stringify({rows:manifest.rows, tiles:manifest.capacities.length,
        tail:manifest.capacities.at(-1), manifestSha256:sha(bytes),
        distinctOrders:new Set(manifest.plates.map(p=>p.orderedIdsSha256)).size}));
}
module.exports = { build };