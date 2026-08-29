'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const {
    CORE_CURSOR_ROLES,
    DEFAULT_CURSOR_SIZES,
    parseHotspot,
    scaleHotspot,
    validateCursorRoles,
    encodeCur,
    encodeAni,
    encodeZip,
    buildThemeZip
} = require('../Plugin/MediaRenderer/CursorThemePackager.js');

function pngChunk(type, data) {
    const typeBuffer = Buffer.from(type, 'ascii');
    const payload = Buffer.concat([typeBuffer, data]);
    const table = (() => {
        const values = new Uint32Array(256);
        for (let index = 0; index < 256; index++) {
            let value = index;
            for (let bit = 0; bit < 8; bit++) {
                value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
            }
            values[index] = value >>> 0;
        }
        return values;
    })();
    let crc = 0xffffffff;
    for (const byte of payload) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length, 0);
    header.write(type, 4, 4, 'ascii');
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([header, data, checksum]);
}

function createPng(width, height, rgba = [103, 232, 249, 255]) {
    const signature = Buffer.from('89504e470d0a1a0a', 'hex');
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr.writeUInt8(8, 8);
    ihdr.writeUInt8(6, 9);
    ihdr.writeUInt8(0, 10);
    ihdr.writeUInt8(0, 11);
    ihdr.writeUInt8(0, 12);

    const scanlines = [];
    for (let y = 0; y < height; y++) {
        const row = Buffer.alloc(1 + width * 4);
        row[0] = 0;
        for (let x = 0; x < width; x++) {
            const offset = 1 + x * 4;
            row[offset] = rgba[0];
            row[offset + 1] = rgba[1];
            row[offset + 2] = rgba[2];
            row[offset + 3] = rgba[3];
        }
        scanlines.push(row);
    }

    return Buffer.concat([
        signature,
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(Buffer.concat(scanlines))),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}

function findAscii(buffer, value) {
    return buffer.indexOf(Buffer.from(value, 'ascii'));
}

function listZipCentralDirectoryNames(buffer) {
    const names = [];
    let offset = 0;
    while (offset <= buffer.length - 46) {
        if (buffer.readUInt32LE(offset) === 0x02014b50) {
            const nameLength = buffer.readUInt16LE(offset + 28);
            const extraLength = buffer.readUInt16LE(offset + 30);
            const commentLength = buffer.readUInt16LE(offset + 32);
            names.push(buffer.toString('utf8', offset + 46, offset + 46 + nameLength));
            offset += 46 + nameLength + extraLength + commentLength;
        } else {
            offset++;
        }
    }
    return names;
}

test('strict role validation accepts exactly all core roles and reports optional fallback', () => {
    const result = validateCursorRoles([...CORE_CURSOR_ROLES]);

    assert.deepEqual(result.roles, [...CORE_CURSOR_ROLES]);
    assert.deepEqual(result.missingOptionalRoles, ['pin', 'person']);
});

test('strict role validation accumulates missing, duplicate and unknown role errors', () => {
    assert.throws(
        () => validateCursorRoles(['arrow', 'arrow', 'unknown']),
        error => {
            assert.match(error.message, /核心角色重复/);
            assert.match(error.message, /未知角色/);
            assert.match(error.message, /缺少核心角色: help/);
            assert.ok(Array.isArray(error.validationErrors));
            return true;
        }
    );
});

test('hotspot parsing defaults center roles and scales 64-unit coordinates', () => {
    const centered = parseHotspot('', 'wait', '0 0 64 64');
    assert.equal(centered.x, 32);
    assert.equal(centered.y, 32);
    assert.deepEqual(scaleHotspot(centered, 32, 32), { x: 16, y: 16 });

    const arrow = parseHotspot('3,2', 'arrow', '0 0 64 64');
    assert.deepEqual(scaleHotspot(arrow, 64, 64), { x: 3, y: 2 });
    assert.throws(() => parseHotspot('65,2', 'arrow', '0 0 64 64'), /不在 viewBox/);
});

test('CUR encoder writes a multi-image cursor directory with PNG payloads', () => {
    const png32 = createPng(32, 32);
    const png64 = createPng(64, 64);
    const cur = encodeCur([
        { png: png32, width: 32, height: 32, hotspotX: 2, hotspotY: 1 },
        { png: png64, width: 64, height: 64, hotspotX: 3, hotspotY: 2 }
    ]);

    assert.equal(cur.readUInt16LE(0), 0);
    assert.equal(cur.readUInt16LE(2), 2);
    assert.equal(cur.readUInt16LE(4), 2);
    assert.equal(cur.readUInt8(6), 32);
    assert.equal(cur.readUInt16LE(10), 2);
    assert.equal(cur.readUInt16LE(12), 1);
    assert.equal(cur.readUInt8(22), 64);

    const firstOffset = cur.readUInt32LE(18);
    const secondOffset = cur.readUInt32LE(34);
    assert.equal(cur.subarray(firstOffset, firstOffset + 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(cur.subarray(secondOffset, secondOffset + 8).toString('hex'), '89504e470d0a1a0a');
});

test('ANI encoder writes RIFF ACON metadata and embedded CUR icon chunks', () => {
    const png = createPng(32, 32);
    const frame = encodeCur([
        { png, width: 32, height: 32, hotspotX: 3, hotspotY: 2 }
    ]);
    const ani = encodeAni([frame, frame], {
        jiffies: 3,
        name: 'Test Wait',
        author: 'VCP'
    });

    assert.equal(ani.toString('ascii', 0, 4), 'RIFF');
    assert.equal(ani.toString('ascii', 8, 12), 'ACON');
    assert.notEqual(findAscii(ani, 'anih'), -1);
    assert.notEqual(findAscii(ani, 'rate'), -1);
    assert.notEqual(findAscii(ani, 'fram'), -1);
    assert.notEqual(findAscii(ani, 'icon'), -1);
    assert.notEqual(findAscii(ani, 'INAM'), -1);
});

test('ZIP encoder rejects traversal and duplicate entry paths', () => {
    assert.throws(
        () => encodeZip([{ path: '../evil.txt', data: 'x' }]),
        /ZIP 条目路径无效/
    );
    assert.throws(
        () => encodeZip([
            { path: 'safe/file.txt', data: 'a' },
            { path: 'safe/file.txt', data: 'b' }
        ]),
        /ZIP 条目路径重复/
    );
});

test('theme ZIP contains cursor files, source, manifest and installers', () => {
    const png = createPng(32, 32);
    const cur = encodeCur([
        { png, width: 32, height: 32, hotspotX: 3, hotspotY: 2 }
    ]);
    const hotspot = parseHotspot('3,2', 'arrow', '0 0 64 64');
    const roles = CORE_CURSOR_ROLES.map(role => ({
        role,
        buffer: cur,
        animated: false,
        durationMs: 0,
        fps: null,
        frameCount: 1,
        viewBox: '0 0 64 64',
        hotspot: { x: hotspot.x, y: hotspot.y },
        scaledHotspots: { 32: { x: 2, y: 1 } }
    }));
    const result = buildThemeZip({
        name: 'Aurora Test',
        author: 'VCP',
        sizes: [32],
        roles,
        previewPng: png,
        sourceHtml: '<!doctype html><title>Aurora Test</title>',
        generatedAt: '2026-01-01T00:00:00.000Z'
    });
    const names = listZipCentralDirectoryNames(result.buffer);

    assert.equal(result.buffer.readUInt32LE(0), 0x04034b50);
    assert.deepEqual(DEFAULT_CURSOR_SIZES, [32, 48, 64]);
    assert.ok(names.includes('Aurora-Test/cursors/arrow.cur'));
    assert.ok(names.includes('Aurora-Test/cursors/link.cur'));
    assert.ok(names.includes('Aurora-Test/preview.png'));
    assert.ok(names.includes('Aurora-Test/source.html'));
    assert.ok(names.includes('Aurora-Test/theme.json'));
    assert.ok(names.includes('Aurora-Test/install.inf'));
    assert.ok(names.includes('Aurora-Test/install.cmd'));
    assert.ok(names.includes('Aurora-Test/uninstall.cmd'));
    assert.ok(names.includes('Aurora-Test/README.txt'));
    assert.equal(result.manifest.roleFiles.pin, 'arrow.cur');
    assert.equal(result.manifest.roleFiles.person, 'arrow.cur');
});